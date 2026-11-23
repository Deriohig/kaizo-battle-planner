import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { BattleInput, Choice, EngineState, ItemEffect } from '../../../src/contracts/engine.js';
import { applyChoices, carryOut, createBattle, legalChoices, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { add, type Rational, ZERO } from '../../../src/engine/rational.js';
import { bagItemId, trainerBag, UNDEFINED_CATEGORY_NOTE } from '../../../src/engine/trainerItems.js';
import { EngineError } from '../../../src/engine/types.js';
import { unmodelledNotes } from '../../../src/engine/unmodelled.js';
import { NATURES } from '../../../src/rom/natures.js';
import { computeStats } from '../../../src/rom/stats.js';
import { BAG, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const { zigzagoon: ZIGZAGOON, castform: CASTFORM, deoxys: DEOXYS, monferno: MONFERNO, bidoof: BIDOOF } = ID;
const { waterBall: WATER_BALL, tackle: TACKLE, ember: EMBER, meanLook: MEAN_LOOK, uTurn: U_TURN } = ID;
const SOLARBEAM = 76;
const CHOICE_BAND = 220;

const move = (slot: number): Choice => ({ kind: 'move', slot });
const swap = (index: number): Choice => ({ kind: 'switch', index });
const item = (id: string, consumeSlots?: number[], effect?: ItemEffect): Choice => ({
  kind: 'item', item: id, ...(consumeSlots ? { consumeSlots } : {}), ...(effect ? { effect } : {}),
});
const BOTH = { p1: move(0), p2: move(0) };

function battleInput(player: PlayerMon[], party: ResolvedMon[], fields: Partial<BattleInput> = {}, bag: number = BAG.none): BattleInput {
  return { player, trainer: resolvedTrainer(bag, party), field: {}, ...fields };
}
const fight = (player: PlayerMon[], party: ResolvedMon[], fields: Partial<BattleInput> = {}, bag: number = BAG.none) =>
  createBattle(battleInput(player, party, fields, bag));
const monferno = (moves: number[], fields: Partial<PlayerMon> = {}, level = 30) => playerMon(MONFERNO, level, moves, fields);
const bidoof = (moves: number[] = [TACKLE]) => resolvedMon(BIDOOF, 30, moves);

/** The protocol lines of the step that made `after`: a snapshot keeps only those. */
const stepLog = (after: EngineState): string[] => JSON.parse(after.json).log;
const lineIndex = (log: string[], prefix: string) => log.findIndex((line) => line.startsWith(prefix));

/** The code of the `EngineError` `run` throws. */
function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    throw error;
  }
  throw new Error('Expected an EngineError');
}
const refused = (state: EngineState, choices: { p1?: Choice; p2?: Choice }) => errorCode(() => runFirstOutcome(state, choices));

/** `state` with the p2 active's HP, status and a volatile changed. */
function hurtEnemy(state: EngineState, hp: number, status?: string, volatile?: string): EngineState {
  const battle = restore(state);
  const foe = battle.p2.active[0]!;
  foe.hp = hp;
  if (status) foe.setStatus(status);
  if (volatile) foe.addVolatile(volatile);
  return snapshot(battle);
}
const foeOf = (state: EngineState) => restore(state).p2.active[0]!;

describe('battles', () => {
  it('round trip: a snapshot restores to the same key, before and after a step', () => {
    const state = fight([monferno([EMBER, TACKLE])], [resolvedMon(ZIGZAGOON, 20, [TACKLE])]);
    expect([state.phase, state.turn, snapshot(restore(state)).key]).toEqual([{ kind: 'turnChoice' }, 1, state.key]);
    const next = runFirstOutcome(state, { p1: move(1), p2: move(0) });
    expect(next.key).not.toBe(state.key);
    expect(snapshot(restore(next)).key).toBe(next.key);
  });

  it('a snapshot keeps only its own step\'s log, and restores from it', () => {
    let state = fight([monferno([MEAN_LOOK])], [resolvedMon(ZIGZAGOON, 20, [TACKLE])]);
    expect(stepLog(state)).toContain('|switch|p1a: Monferno|Monferno, L30, M|87/87'); // the battle's start
    for (let turn = 1; turn <= 4; turn++) state = runFirstOutcome(state, BOTH);
    const json = JSON.parse(state.json);
    expect((json.log as string[]).filter((line) => line.startsWith('|turn|') || line.startsWith('|switch|'))).toEqual(['|turn|5']);
    expect(json.inputLog).toEqual(['>p1 move meanlook', '>p2 move tackle']);
    const battle = restore(state);
    expect([battle.log, battle.inputLog, battle.turn, snapshot(battle).key]).toEqual([[], [], 5, state.key]);
    expect(runFirstOutcome(state, BOTH).turn).toBe(6);
  });

  it('a snapshot\'s JSON holds no wall-clock time: `|t:|` lines are blanked, as Showdown\'s State.normalizeLog does', () => {
    const input = battleInput([monferno([EMBER, TACKLE])], [resolvedMon(ZIGZAGOON, 20, [TACKLE])]);
    const at = (ms: number): EngineState[] => {
      vi.spyOn(Date, 'now').mockReturnValue(ms);
      try {
        const start = createBattle(input);
        return [start, runFirstOutcome(start, { p1: move(1), p2: move(0) })];
      } finally {
        vi.restoreAllMocks();
      }
    };
    const [early, late] = [at(1_762_650_000_000), at(1_762_650_007_000)];
    expect(late.map((state) => [state.json, state.key])).toEqual(early.map((state) => [state.json, state.key]));
    for (const state of early) {
      const timed = stepLog(state).filter((line) => line.startsWith('|t:|'));
      expect(timed.length).toBeGreaterThan(0);
      expect(timed.every((line) => line === '|t:|')).toBe(true);
    }
  });

  it('sets: species, level, nature, ability, item, moves, gender, IVs, EVs and happiness from friendship', () => {
    const ivs = { hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6 };
    const evs = { hp: 4, atk: 8, def: 12, spa: 16, spd: 20, spe: 24 };
    const mine = monferno([EMBER, TACKLE], { ivs, evs, nature: { value: 15, source: 'rom', disputed: false, alternatives: [] }, item: CHOICE_BAND, friendship: 143 });
    // No source gives a nature, so any of the 25 is an alternative: Hardy is used.
    const theirs = resolvedMon(BIDOOF, 25, [TACKLE], { nature: { value: null, source: 'docs', disputed: true, alternatives: NATURES.map((_, id) => id) }, gender: null, friendship: 0 });
    const battle = restore(fight([mine], [theirs]));
    const [p1, p2] = [battle.p1.pokemon[0]!, battle.p2.pokemon[0]!];
    expect(p1.set).toMatchObject({ species: 'monferno', level: 30, nature: 'Modest', ability: 'blaze', item: 'choiceband', ivs, evs, gender: 'M' });
    expect([p1.moveSlots.map((slot) => slot.id), p1.set.happiness, p1.happiness]).toEqual([['ember', 'tackle'], 143, 143]);
    expect(p1.storedStats).toEqual((({ hp: _, ...rest }) => rest)(computeStats(mine.baseStats, ivs, evs, 30, 15)));
    expect(p2.set).toMatchObject({ species: 'bidoof', nature: 'Hardy', ability: 'swiftswim' });
    expect([p2.set.happiness, p2.happiness, p2.gender]).toEqual([0, 0, '']);
    expect(p2.moveSlots.map((slot) => [slot.pp, slot.maxpp])).toEqual([[35, 35]]); // no PP Ups on the trainer's side
  });

  it('Return and Frustration are plain 121-power hits, whatever the friendship (ROM effect 0)', () => {
    const damage = (moveId: number, friendship: number) => {
      const byDamage = new Map<number, Rational>();
      for (const outcome of expandTurn(fight([monferno([moveId], { friendship })], [resolvedMon(ZIGZAGOON, 40, [MEAN_LOOK])]), BOTH)) {
        const foe = restore(outcome.state).p2.active[0]!;
        byDamage.set(foe.maxhp - foe.hp, add(byDamage.get(foe.maxhp - foe.hp) ?? ZERO, outcome.probability));
      }
      return [...byDamage].sort(([a], [b]) => a - b);
    };
    const plain = damage(ID.plainHit, 70);
    expect(plain.length).toBeGreaterThan(2); // crits and rolls, none a KO
    for (const id of [ID.return, ID.frustration]) {
      for (const friendship of [0, 70, 255]) expect([id, friendship, damage(id, friendship)]).toEqual([id, friendship, plain]);
    }
  });

  it('save HP, PP and status apply, then carry, then startStatus', () => {
    const lead = monferno([EMBER, TACKLE], { currentHp: 20, pp: [7, 30], ppUps: [2, 0], status: { kind: 'burn' } });
    const state = fight([lead, playerMon(ZIGZAGOON, 30, [TACKLE], { status: { kind: 'paralysis' } })], [resolvedMon(BIDOOF, 25, [TACKLE])], {
      carry: { mons: [{ hp: 15, pp: [6, 29], status: { kind: 'toxic' } }] }, startStatus: { 1: { kind: 'freeze' } },
    });
    const [first, other] = restore(state).p1.pokemon;
    expect([first!.hp, first!.status, other!.status]).toEqual([15, 'tox', 'frz']);
    expect(first!.moveSlots.map((slot) => [slot.pp, slot.maxpp])).toEqual([[6, 35], [29, 35]]); // Ember 25 PP with 2 PP Ups: 35
    expect(carryOut(state).mons.map((mon) => mon.status)).toEqual([{ kind: 'toxic' }, { kind: 'freeze' }]);
  });

  it('carry state applies, and carryOut gives it back with the EXP (16^3, medium fast) and the moves', () => {
    const zigzagoon = playerMon(ZIGZAGOON, 16, [TACKLE, EMBER], { evs: { hp: 24, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 } });
    const carry = { mons: [{ hp: 10, pp: [3, 25], status: { kind: 'poison' } as const, item: 0 }] };
    const state = fight([zigzagoon], [resolvedMon(BIDOOF, 10, [TACKLE])], { carry });
    const mon = restore(state).p1.pokemon[0]!;
    expect([mon.hp, mon.maxhp, mon.moveSlots.map((slot) => slot.pp), mon.status]).toEqual([10, 44, [3, 25], 'psn']);
    expect(stepLog(state)).toContain('|switch|p1a: Zigzagoon|Zigzagoon, L16, M|10/44 psn');
    expect(carryOut(state)).toEqual({ mons: [{ ...carry.mons[0], exp: 4096, moves: [TACKLE, EMBER] }] });
  });

  it('a pre-sleep wakes on the first move; a save sleep counter is kept', () => {
    const wokeThenTackled = (log: string[]) => {
      const woke = lineIndex(log, '|-curestatus|p1a: Monferno|slp');
      expect(woke).toBeGreaterThanOrEqual(0);
      expect(lineIndex(log, '|move|p1a: Monferno|Tackle')).toBeGreaterThan(woke);
    };
    const pre = fight([monferno([TACKLE], {}, 50)], [resolvedMon(ZIGZAGOON, 10, [TACKLE])], { startStatus: { 0: { kind: 'sleep', turns: 1 } } });
    expect(restore(pre).p1.pokemon[0]!.status).toBe('slp');
    const preLog = stepLog(runFirstOutcome(pre, BOTH));
    wokeThenTackled(preLog);
    expect(lineIndex(preLog, '|cant|p1a: Monferno')).toBe(-1);
    let state = fight([monferno([TACKLE], { status: { kind: 'sleep', turns: 3 } }, 50)], [resolvedMon(ZIGZAGOON, 10, [TACKLE])]);
    for (let attempt = 1; attempt <= 2; attempt++) {
      state = runFirstOutcome(state, BOTH);
      expect(stepLog(state)).toContain('|cant|p1a: Monferno|slp');
      expect(lineIndex(stepLog(state), '|move|p1a: Monferno')).toBe(-1);
    }
    expect(carryOut(state).mons[0]!.status).toEqual({ kind: 'sleep', turns: 1 });
    wokeThenTackled(stepLog(runFirstOutcome(state, BOTH)));
  });

  describe('legal choices', () => {
    it('all PP at 0 gives Struggle only', () => {
      const state = fight([monferno([TACKLE, EMBER], { pp: [0, 0] }), playerMon(ZIGZAGOON, 30, [TACKLE])], [bidoof()]);
      expect(legalChoices(state, 'p1')).toEqual([move(0), swap(1)]);
      expect((restore(state).p1.activeRequest as { active: { moves: { id: string }[] }[] }).active[0]!.moves.map((entry) => entry.id)).toEqual(['struggle']);
      expect(stepLog(runFirstOutcome(state, BOTH))).toContain('|move|p1a: Monferno|Struggle|p2a: Bidoof');
    });

    it('after a Choice Band move, only that move; trapped by Mean Look, no switches', () => {
      const banded = fight([monferno([TACKLE, EMBER], { item: CHOICE_BAND })], [bidoof()]);
      expect(legalChoices(banded, 'p1')).toEqual([move(0), move(1)]);
      const locked = runFirstOutcome(banded, { p1: move(1), p2: move(0) });
      expect([legalChoices(locked, 'p1'), refused(locked, BOTH)]).toEqual([[move(1)], 'BAD_CHOICE']);
      const free = fight([monferno([TACKLE]), playerMon(ZIGZAGOON, 30, [TACKLE])], [bidoof([MEAN_LOOK])]);
      expect(legalChoices(free, 'p1')).toEqual([move(0), swap(1)]);
      const trapped = runFirstOutcome(free, BOTH);
      expect([legalChoices(trapped, 'p1'), refused(trapped, { p1: swap(1), p2: move(0) })]).toEqual([[move(0)], 'BAD_CHOICE']);
    });

    it('p2 lists its bag items; the lead is party index 0 on both sides, and the enemy party keeps ROM order', () => {
      const bagged = fight([monferno([TACKLE])], [bidoof([TACKLE, EMBER])], {}, BAG.potions);
      expect(legalChoices(bagged, 'p2')).toEqual([move(0), move(1), item('potion'), item('xattack'), item('superpotion')]);
      expect(legalChoices(bagged, 'p1')).toEqual([move(0)]);
      const state = fight([monferno([TACKLE]), playerMon(ZIGZAGOON, 30, [TACKLE])], [bidoof(), resolvedMon(CASTFORM, 30, [TACKLE]), resolvedMon(ZIGZAGOON, 30, [TACKLE])]);
      const battle = restore(state);
      expect([battle.p1.active[0]!.species.id, battle.p2.pokemon.map((mon) => mon.species.id)]).toEqual(['monferno', ['bidoof', 'castform', 'zigzagoon']]);
      expect(legalChoices(state, 'p2')).toEqual([move(0), swap(1), swap(2)]);
    });

    it('switch indices are party positions, also after an earlier switch', () => {
      const party = [monferno([EMBER, TACKLE]), playerMon(ZIGZAGOON, 30, [TACKLE]), playerMon(CASTFORM, 30, [WATER_BALL, TACKLE, EMBER])];
      let state = fight(party, [resolvedMon(BIDOOF, 20, [TACKLE])]);
      for (const [to, species, choices] of [
        [2, 'castform', [move(0), move(1), move(2), swap(0), swap(1)]], [0, 'monferno', [move(0), move(1), swap(1), swap(2)]], [1, 'zigzagoon', null],
      ] as const) {
        state = runFirstOutcome(state, { p1: swap(to), p2: move(0) });
        expect(restore(state).p1.active[0]!.species.id).toBe(species);
        if (choices) expect(legalChoices(state, 'p1')).toEqual(choices);
      }
      expect(carryOut(state).mons.map((mon) => mon.pp.length)).toEqual([2, 1, 3]);
    });

    it('a choice the phase does not take is BAD_CHOICE; a double battle is refused', () => {
      const state = fight([monferno([TACKLE])], [bidoof()], {}, BAG.potions);
      expect([{ p1: move(0) }, { p1: move(1), p2: move(0) }, { p1: swap(0), p2: move(0) }, { p1: item('potion'), p2: move(0) }]
        .map((choices) => refused(state, choices))).toEqual(Array(4).fill('BAD_CHOICE'));
      const input = battleInput([monferno([TACKLE])], [bidoof()]);
      expect(errorCode(() => createBattle({ ...input, trainer: { ...input.trainer, battleType: 'double' } }))).toBe('UNSUPPORTED_DOUBLE');
    });

    it('applyChoices changes nothing when Showdown refuses a choice', () => {
      const state = fight([monferno([TACKLE])], [bidoof()], {}, BAG.potions);
      const battle = restore(state);
      battle.p1.choice.cantUndo = true; // Side.choose refuses any choice now
      expect(errorCode(() => applyChoices(battle, { p1: move(0), p2: item('potion') }))).toBe('BAD_CHOICE');
      expect([trainerBag(battle).items, battle.p2.choice.actions, snapshot(battle).key]).toEqual([[17, 57, 17, 26], [], state.key]);
      applyChoices(battle, { p1: move(0), p2: item('potion') });
      expect(snapshot(battle).key).toBe(runFirstOutcome(state, { p1: move(0), p2: item('potion') }).key);
    });
  });

  describe('trainer bag', () => {
    const against = (bag: number) => {
      const state = fight([monferno([MEAN_LOOK])], [bidoof()], {}, bag);
      return { state, maxhp: foeOf(state).maxhp };
    };
    const used = (log: string[]) => log.filter((line) => line.endsWith('|[trainer]'));

    it('bag item ids', () => {
      expect([17, 23, 26, 27, 55, 56, 57, 58, 61, 62, 4, 0].map(bagItemId)).toEqual([
        'potion', 'fullrestore', 'superpotion', 'fullheal', 'guardspec', 'direhit', 'xattack', 'xdefend', 'xspecial', 'xspdef', 'pokeball', '',
      ]);
    });

    it('Full Restore heals and cures status and confusion before the moves, and empties its slot', () => {
      const fresh = fight([monferno([TACKLE])], [bidoof()], {}, BAG.fullRestore);
      const maxhp = foeOf(fresh).maxhp;
      const next = runFirstOutcome(hurtEnemy(fresh, 5, 'psn', 'confusion'), { p1: move(0), p2: item('fullrestore') });
      const log = stepLog(next);
      const steps = ['|-activate|p2a: Bidoof|item: Full Restore|[trainer]', '|-curestatus|p2a: Bidoof|psn|[msg]', `|-heal|p2a: Bidoof|${maxhp}/${maxhp}|[from] item: Full Restore`]
        .map((line) => log.indexOf(line));
      expect(steps.every((index) => index >= 0)).toBe(true);
      expect(log).toContain('|-end|p2a: Bidoof|confusion');
      expect(Math.max(...steps)).toBeLessThan(lineIndex(log, '|move|p1a: Monferno|Tackle|p2a: Bidoof'));
      expect(foeOf(next).status).toBe('');
      expect(foeOf(next).hp).toBeGreaterThan(5);
      expect([trainerBag(restore(next)).items, legalChoices(next, 'p2')]).toEqual([[0], [move(0)]]);
    });

    it('consumeSlots [0, 2] empties both slots and applies the item once', () => {
      const { state, maxhp } = against(BAG.potions);
      const next = runFirstOutcome(hurtEnemy(state, maxhp - 60), { p1: move(0), p2: item('potion', [0, 2]) });
      expect([foeOf(next).hp, trainerBag(restore(next)).items]).toEqual([maxhp - 40, [0, 57, 0, 26]]);
      expect(used(stepLog(next))).toEqual(['|-activate|p2a: Bidoof|item: Potion|[trainer]']);
      expect(legalChoices(next, 'p2')).toEqual([move(0), item('xattack'), item('superpotion')]);
    });

    it('slots keep their positions: a later use by index hits its slot, and an empty slot cannot be used again', () => {
      const { state, maxhp } = against(BAG.potions);
      const first = runFirstOutcome(hurtEnemy(state, maxhp - 60), { p1: move(0), p2: item('potion') }); // the first slot holding it
      expect(trainerBag(restore(first)).items).toEqual([0, 57, 17, 26]);
      const second = runFirstOutcome(first, { p1: move(0), p2: item('superpotion', [3]) });
      expect([trainerBag(restore(second)).items, foeOf(second).hp]).toEqual([[0, 57, 17, 0], maxhp]); // 40 missing, Super Potion heals 50
      // Slot 0 is empty, Super Potion is gone, slot 2 holds a Potion.
      expect([item('potion', [0]), item('superpotion'), item('xattack', [1, 2])].map((p2) => refused(second, { p1: move(0), p2 }))).toEqual(Array(3).fill('BAD_CHOICE'));
      const third = runFirstOutcome(second, { p1: move(0), p2: item('potion', [1, 2]) }); // empties X Attack's slot too, applies the Potion
      expect([trainerBag(restore(third)).items, foeOf(third).boosts.atk, legalChoices(third, 'p2')]).toEqual([[0, 0, 0, 0], 0, [move(0)]]);
    });

    it('X items give +1, Dire Hit sets Focus Energy, Guard Spec. sets Mist, Full Heal cures status and confusion', () => {
      let state = against(BAG.battleItems).state;
      const use = (id: string): string[] => {
        state = runFirstOutcome(state, { p1: move(0), p2: item(id) });
        return stepLog(state);
      };
      expect(use('xspecial')).toContain('|-boost|p2a: Bidoof|spa|1|[from] item: X Special');
      expect(use('direhit')).toContain('|-start|p2a: Bidoof|move: Focus Energy');
      expect(use('guardspec')).toContain('|-sidestart|p2: Youngster Tristan|Mist');
      const battle = restore(state);
      expect([battle.p2.active[0]!.boosts.spa, !!battle.p2.active[0]!.volatiles['focusenergy'], !!battle.p2.sideConditions['mist']]).toEqual([1, true, true]);
      state = hurtEnemy(state, battle.p2.active[0]!.hp, 'brn', 'confusion');
      const log = use('fullheal');
      expect(log).toEqual(expect.arrayContaining(['|-curestatus|p2a: Bidoof|brn|[msg]', '|-end|p2a: Bidoof|confusion']));
      expect([foeOf(state).status, trainerBag(restore(state)).items]).toEqual(['', [0, 0, 0, 0]]);
    });

    it('an item the engine does not model throws UNMODELLED_ITEM and is not listed', () => {
      const state = fight([monferno([TACKLE])], [bidoof()], {}, BAG.pokeBall);
      expect(legalChoices(state, 'p2')).toEqual([move(0)]);
      expect([refused(state, { p1: move(0), p2: item('pokeball') }), refused(state, { p1: move(0), p2: item('potion') })]).toEqual(['UNMODELLED_ITEM', 'BAD_CHOICE']);
    });

    it('item use runs after the player\'s switch and before moves', () => {
      const state = fight([monferno([TACKLE]), playerMon(ZIGZAGOON, 30, [TACKLE])], [bidoof()], {}, BAG.potions);
      const log = stepLog(runFirstOutcome(state, { p1: swap(1), p2: item('xattack') }));
      expect(lineIndex(log, '|switch|p1a: Zigzagoon')).toBeLessThan(lineIndex(log, '|-activate|p2a: Bidoof|item: X Attack'));
      const later = runFirstOutcome(state, { p1: move(0), p2: item('xattack') });
      const moved = stepLog(later);
      expect(lineIndex(moved, '|-activate|p2a: Bidoof|item: X Attack')).toBeLessThan(lineIndex(moved, '|move|p1a: Monferno'));
      expect(moved).toContain('|-boost|p2a: Bidoof|atk|1|[from] item: X Attack');
      expect(foeOf(later).boosts.atk).toBe(1);
    });

    it('no items while the trainer\'s Pokémon is locked into its move or under Embargo', () => {
      const state = fight([monferno([TACKLE])], [bidoof([SOLARBEAM, TACKLE])], {}, BAG.potions);
      const charging = runFirstOutcome(state, BOTH);
      expect([legalChoices(charging, 'p2'), refused(charging, { p1: move(0), p2: item('potion') })]).toEqual([[move(0)], 'BAD_CHOICE']);
      const embargoed = hurtEnemy(state, foeOf(state).hp, undefined, 'embargo');
      expect([legalChoices(embargoed, 'p2'), refused(embargoed, { p1: move(0), p2: item('potion') })]).toEqual([[move(0), move(1)], 'BAD_CHOICE']);
    });
  });

  describe('trainer item effect categories (multi-slot uses)', () => {
    const against = (bag: number) => {
      const state = fight([monferno([MEAN_LOOK])], [bidoof()], {}, bag);
      return { state, maxhp: foeOf(state).maxhp };
    };
    const used = (log: string[]) => log.filter((line) => line.endsWith('|[trainer]'));
    const STORED = (name: string) => `trainer item: ${name}'s HP recovery left stored outside the potion routine (itemHPRecovery)`;

    it('Potion fires, Antidote after: uses one Antidote, heals nothing, and its status routine does not run', () => {
      const { state, maxhp } = against(BAG.mixedHp);
      const next = runFirstOutcome(hurtEnemy(state, Math.floor(maxhp / 5), 'brn'), { p1: move(0), p2: item('antidote', [0, 1], { category: 'recoverHp' }) });
      const log = stepLog(next);
      expect([used(log), lineIndex(log, '|-heal|p2a: Bidoof'), lineIndex(log, '|-curestatus|')]).toEqual([['|-activate|p2a: Bidoof|item: Antidote|[trainer]'], -1, -1]);
      const battle = restore(next);
      expect([battle.p2.active[0]!.hp, battle.p2.active[0]!.status]).toEqual([Math.floor(maxhp / 5) - Math.floor(maxhp / 8), 'brn']);
      expect([trainerBag(battle).items, unmodelledNotes(battle)]).toEqual([[0, 0, 27, 25], []]);
    });

    it('Full Restore fires, Antidote after: the Full Restore routine clears status and confusion, and nothing heals', () => {
      const { state, maxhp } = against(BAG.mixedHp);
      const next = runFirstOutcome(hurtEnemy(state, Math.floor(maxhp / 5), 'brn', 'confusion'), { p1: move(0), p2: item('antidote', [0, 1], { category: 'fullRestore' }) });
      const log = stepLog(next);
      expect(log).toEqual(expect.arrayContaining(['|-curestatus|p2a: Bidoof|brn|[msg]', '|-end|p2a: Bidoof|confusion']));
      expect([lineIndex(log, '|-heal|p2a: Bidoof'), foeOf(next).hp]).toEqual([-1, Math.floor(maxhp / 5)]);
    });

    it('Full Heal fires, Hyper Potion after: heals nothing, the status routine still wakes it; stored HP recovery is noted', () => {
      const { state, maxhp } = against(BAG.mixedHp);
      const recoverStatus = (slots: number[]) => item('hyperpotion', slots, { category: 'recoverStatus', statusMask: 1 << 5 });
      const next = runFirstOutcome(hurtEnemy(state, maxhp, 'slp'), { p1: move(0), p2: recoverStatus([2, 3]) }); // full HP: nothing stored
      const log = stepLog(next);
      expect(used(log)).toEqual(['|-activate|p2a: Bidoof|item: Hyper Potion|[trainer]']);
      expect(log).toContain('|-curestatus|p2a: Bidoof|slp|[msg]'); // subscript_use_status_recovery.s:17, 53-54
      expect([lineIndex(log, '|-heal|p2a: Bidoof'), trainerBag(restore(next)).items, unmodelledNotes(restore(next))]).toEqual([-1, [17, 18, 0, 0], []]);
      // HP missing: the Hyper Potion stores 200 HP of recovery that no potion routine reads.
      const stored = restore(runFirstOutcome(hurtEnemy(state, maxhp - 30, 'slp'), { p1: move(0), p2: recoverStatus([3]) }));
      expect([stored.p2.active[0]!.hp, stored.p2.active[0]!.status, unmodelledNotes(stored)]).toEqual([maxhp - 30, '', [STORED('Hyper Potion')]]);
    });

    it('recoverStatus reads the AI\'s flags: confusion alone snaps it out, confusion with a status clears the status', () => {
      const { state, maxhp } = against(BAG.mixedHp);
      const both = hurtEnemy(state, maxhp, 'slp', 'confusion');
      const after = (statusMask: number) => {
        const foe = foeOf(runFirstOutcome(both, { p1: move(0), p2: item('hyperpotion', [3], { category: 'recoverStatus', statusMask }) }));
        return [foe.status, !!foe.volatiles['confusion']];
      };
      expect([after(1), after(0x21)]).toEqual([['slp', false], ['', true]]);
    });

    it('X Attack fires, Dire Hit after: Dire Hit\'s own Focus Energy, no boost; X Special fires, Max Potion after: nothing', () => {
      const { state, maxhp } = against(BAG.mixedStat);
      const first = runFirstOutcome(state, { p1: move(0), p2: item('direhit', [0, 1], { category: 'statBooster', stat: 'atk' }) });
      const log = stepLog(first);
      expect([used(log), log.includes('|-start|p2a: Bidoof|move: Focus Energy'), lineIndex(log, '|-boost|'), foeOf(first).boosts.atk])
        .toEqual([['|-activate|p2a: Bidoof|item: Dire Hit|[trainer]'], true, -1, 0]);
      const second = runFirstOutcome(hurtEnemy(first, maxhp - 30), { p1: move(0), p2: item('maxpotion', [2, 3], { category: 'statBooster', stat: 'spa' }) });
      const battle = restore(second);
      expect([lineIndex(stepLog(second), '|-heal|p2a: Bidoof'), battle.p2.active[0]!.hp, battle.p2.active[0]!.boosts.spa, unmodelledNotes(battle)])
        .toEqual([-1, maxhp - 30, 0, [STORED('Max Potion')]]);
    });

    it('an \'undefined\' category empties the slots, applies nothing and is recorded as unmodelled, with any item', () => {
      const { state, maxhp } = against(BAG.potions);
      const next = runFirstOutcome(hurtEnemy(state, maxhp - 60), { p1: move(0), p2: item('potion', [0], { category: 'undefined' }) });
      const battle = restore(next);
      expect([used(stepLog(next)), battle.p2.active[0]!.hp, trainerBag(battle).items, unmodelledNotes(battle)]).toEqual([[], maxhp - 60, [0, 57, 17, 26], [UNDEFINED_CATEGORY_NOTE]]);
      expect(unmodelledNotes(restore(runFirstOutcome(next, BOTH)))).toEqual([UNDEFINED_CATEGORY_NOTE]); // it stays in the state
      const balls = against(BAG.pokeBall).state;
      expect(unmodelledNotes(restore(runFirstOutcome(balls, { p1: move(0), p2: item('pokeball', [0], { category: 'undefined' }) })))).toEqual([UNDEFINED_CATEGORY_NOTE]);
    });

    it('an effect equal to the item\'s own changes nothing; a malformed one is BAD_CHOICE', () => {
      const { state: fresh, maxhp } = against(BAG.fullRestore);
      const state = hurtEnemy(fresh, 5, 'psn');
      const plain = runFirstOutcome(state, { p1: move(0), p2: item('fullrestore') });
      expect(runFirstOutcome(state, { p1: move(0), p2: item('fullrestore', undefined, { category: 'fullRestore' }) }).key).toBe(plain.key);
      expect(foeOf(plain).hp).toBe(maxhp);
      const mixed = against(BAG.mixedHp).state;
      const bad = (effect: ItemEffect) => refused(mixed, { p1: move(0), p2: item('hyperpotion', [3], effect) });
      expect([
        { category: 'recoverEverything' as ItemEffect['category'] }, { category: 'recoverStatus', statusMask: 0 },
        { category: 'recoverStatus' }, // no statusMask, and a Hyper Potion has no flag of its own
        { category: 'statBooster', stat: 'hp' as ItemEffect['stat'] },
      ].map((effect) => bad(effect as ItemEffect))).toEqual(Array(4).fill('BAD_CHOICE'));
    });
  });

  it('PP spent in a fight shows in carryOut', () => {
    const state = fight([monferno([EMBER, TACKLE])], [bidoof()]);
    const twice = runFirstOutcome(runFirstOutcome(state, { p1: move(1), p2: move(0) }), { p1: move(1), p2: move(0) });
    expect([carryOut(state).mons[0]!.pp, carryOut(twice).mons[0]!.pp]).toEqual([[25, 35], [25, 33]]);
  });

  describe('pauses', () => {
    it('U-turn pauses for a player switch, within the turn', () => {
      const mid = runFirstOutcome(fight([monferno([U_TURN]), playerMon(ZIGZAGOON, 30, [TACKLE])], [bidoof()]), BOTH);
      expect([mid.phase, mid.turn, legalChoices(mid, 'p1'), legalChoices(mid, 'p2')]).toEqual([{ kind: 'playerMidTurnSwitch' }, 1, [swap(1)], []]);
      expect(stepLog(mid)).not.toContain('|turn|2');
      expect(refused(mid, { p1: swap(1), p2: move(0) })).toBe('BAD_CHOICE');
      const after = runFirstOutcome(mid, { p1: swap(1) });
      expect([after.phase, after.turn, restore(after).p1.active[0]!.species.id]).toEqual([{ kind: 'turnChoice' }, 2, 'zigzagoon']);
    });

    it('an enemy U-turn pauses for an enemy switch', () => {
      const mid = runFirstOutcome(fight([monferno([TACKLE])], [bidoof([U_TURN]), resolvedMon(ZIGZAGOON, 30, [TACKLE])]), BOTH);
      expect([mid.phase, legalChoices(mid, 'p2'), legalChoices(mid, 'p1')]).toEqual([{ kind: 'enemyMidTurnSwitch' }, [swap(1)], []]);
      expect(runFirstOutcome(mid, { p2: swap(1) }).phase).toEqual({ kind: 'turnChoice' });
    });

    it('a KO pauses for an enemy replacement; the last KO ends the battle', () => {
      const ko = runFirstOutcome(fight([playerMon(DEOXYS, 50, [WATER_BALL])], [resolvedMon(ZIGZAGOON, 5, [TACKLE]), resolvedMon(ZIGZAGOON, 5, [TACKLE])]), BOTH);
      expect([ko.phase, legalChoices(ko, 'p2'), legalChoices(ko, 'p1')]).toEqual([{ kind: 'enemyReplacement' }, [swap(1)], []]);
      const replaced = runFirstOutcome(ko, { p2: swap(1) });
      expect([replaced.phase, replaced.turn]).toEqual([{ kind: 'turnChoice' }, 2]);
      const won = runFirstOutcome(replaced, BOTH);
      expect([won.phase, legalChoices(won, 'p1'), refused(won, { p1: move(0) })]).toEqual([{ kind: 'terminal', winner: 'p1' }, [], 'BAD_CHOICE']);
    });

    it('a player faint pauses for a player replacement', () => {
      const fainted = runFirstOutcome(fight([playerMon(ZIGZAGOON, 5, [TACKLE]), monferno([TACKLE], {}, 5)], [resolvedMon(DEOXYS, 50, [WATER_BALL])]), BOTH);
      expect([fainted.phase, legalChoices(fainted, 'p1')]).toEqual([{ kind: 'playerReplacement' }, [swap(1)]]);
      expect(carryOut(fainted).mons[0]).toMatchObject({ hp: 0, status: { kind: 'none' } });
    });
  });

  it('enemy overrides apply: nature and ability', () => {
    const party = [resolvedMon(MONFERNO, 50, [TACKLE])];
    const foe = (fields: Partial<BattleInput> = {}) => foeOf(fight([playerMon(BIDOOF, 30, [TACKLE])], party, fields));
    const [plain, overridden] = [foe(), foe({ world: { enemy: [{ nature: 3, ability: 82 }] } })]; // Adamant, Gluttony
    const { hp: _, ...adamant } = computeStats(party[0]!.baseStats, party[0]!.ivs, party[0]!.evs, 50, 3);
    expect(overridden.storedStats).toEqual(adamant);
    expect(overridden.storedStats.atk).toBeGreaterThan(plain.storedStats.atk);
    expect([overridden.baseAbility, plain.baseAbility]).toEqual(['gluttony', 'blaze']);
  });
});
