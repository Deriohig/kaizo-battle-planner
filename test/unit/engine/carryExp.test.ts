// What a gauntlet carries from one fight to the next, EXP and moves included, and how the next fight starts from it
// (`CarryState`): the carried EXP sets the level and its stats, the carried move list sets the moves (`pp` indexed by
// it), and HP or PP above the max means full. Monferno is medium slow (29 at 19411 ... 33 at 29949; max HP 85 at 29, 87,
// 90, 92, 95 at 33); Zigzagoon medium fast (max HP 12 at 1, 217 at 100). A knock-out pays floor(base x level / 7) x1.5.

import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { CarryState, Choice, EngineState, Outcome, Phase } from '../../../src/contracts/engine.js';
import { carryIn, createBattle, legalChoices, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { EXP_KEY } from '../../../src/engine/exp.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { carryOut } from '../../../src/engine/facts.js';
import { applyLevel, levelUp } from '../../../src/engine/levelUp.js';
import { computeStats } from '../../../src/rom/stats.js';
import { BAG, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';
import { cacheMismatches } from './walk.js';

const fixture = fixtureDex();
const species = fixture.data.rom.species;
species[ID.magikarp]!.baseExp = 152; // 684 at level 21
species[ID.zigzagoon]!.baseExp = 100; // 450 at level 21
species[ID.deoxys]!.baseExp = 255; // 2731 at level 50
fixture.data.rom.learnsets[ID.monferno] = [{ move: ID.slash, level: 31 }, { move: ID.bite, level: 32 }]; // invented
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
type Choices = { p1?: Choice; p2?: Choice };
type CarriedMon = CarryState['mons'][number];
const NONE = { kind: 'none' } as const;
const MEDIUM_SLOW = { 29: 19411, 30: 21760, 31: 24294, 32: 27021, 33: 29949 } as const;
/** The ROM move IDs of the fixture moves these tests use, by Showdown ID. */
const ROM_MOVE: Record<string, number> = { plainhit: ID.plainHit, slash: ID.slash, bite: ID.bite, growl: ID.growl, leer: ID.leer, ember: ID.ember, tackle: ID.tackle };

const fight = (player: PlayerMon[], trainer: ResolvedMon[], carry?: CarryState): EngineState =>
  createBattle({ player, trainer: resolvedTrainer(BAG.none, trainer), field: {}, ...(carry === undefined ? {} : { carry }) });
/** One carried Pokémon against Magikarp 21. */
const carriedFight = (saved: PlayerMon, mon: Partial<CarriedMon>) => fight([saved], [magikarp21()], { mons: [{ hp: 999, pp: [99], status: NONE, ...mon }] });
const logOf = (state: EngineState): string[] => (JSON.parse(state.json) as { log: string[] }).log;
const kaizo = (state: EngineState): string[] => logOf(state).filter((line) => line.startsWith('|-kaizo'));
/** One step down each chance's first outcome, which must stop at `phase`. */
function step(state: EngineState, choices: Choices, phase: Phase['kind']): EngineState {
  const next = runFirstOutcome(state, choices);
  expect(next.phase.kind).toBe(phase);
  return next;
}
function edited(state: EngineState, edit: (battle: Battle) => void): EngineState {
  const live = restore(state);
  edit(live);
  return snapshot(live);
}
const enemyHp = (state: EngineState, hp: number): EngineState => edited(state, (live) => { live.p2.active[0]!.hp = hp; });
const myHp = (state: EngineState, hp: number): EngineState => edited(state, (live) => { live.p1.active[0]!.hp = hp; });
function mine(state: EngineState, index = 0): Pokemon {
  const live = restore(state);
  return live.p1.pokemon.find((pokemon) => live.p1.team.indexOf(pokemon.set) === index)!;
}
const expOf = (state: EngineState, index = 0): unknown => (mine(state, index).m as Record<string, unknown>)[EXP_KEY];
/** Party member `index`'s level, HP, max HP and EXP. */
const levelOf = (state: EngineState, index = 0) => [mine(state, index).level, mine(state, index).hp, mine(state, index).maxhp, expOf(state, index)];
/** Party member `index`'s move slots as [Showdown ID, PP, max PP]. */
const slotsOf = (state: EngineState, index = 0) => mine(state, index).moveSlots.map((slot) => [slot.id, slot.pp, slot.maxpp]);

/** Monferno at level 30, 1 EXP short of 31, with Plain Hit alone: free slots for Slash (31) and Bite (32). */
const monferno = (fields: Partial<PlayerMon> = {}) => playerMon(ID.monferno, 30, [ID.plainHit], { exp: MEDIUM_SLOW[31] - 1, ...fields });
const magikarp21 = () => resolvedMon(ID.magikarp, 21, [ID.growl]);

const FIGHT_ONE: readonly [Choices, Phase['kind']][] = [[{ p1: move(0), p2: move(0) }, 'enemyReplacement'], [{ p2: { kind: 'switch', index: 1 } }, 'turnChoice'], [{ p1: move(1), p2: move(0) }, 'terminal']];
const fightOneStart = (): EngineState => myHp(fight([monferno()], [magikarp21(), resolvedMon(ID.zigzagoon, 21, [ID.growl])]), 50);

/**
 * Fight 1, first outcomes: Plain Hit knocks Magikarp out (684: 24977, level 31, HP 50 + 3 = 53, Slash learned), then
 * Slash knocks out Zigzagoon put at 1 HP (450: 25427). Plain Hit and Slash have used 1 PP each.
 */
function fightOne(): EngineState {
  let state = fightOneStart();
  for (const [index, [choices, phase]] of FIGHT_ONE.entries()) {
    state = step(index === 2 ? enemyHp(state, 1) : state, choices, phase);
    if (index === 0) expect(kaizo(state)).toEqual(['|-kaizoexp|p1a: Monferno|684', '|-kaizolevel|p1a: Monferno|31', '|-kaizolearn|p1a: Monferno|Slash']);
    if (index === 2) expect(kaizo(state)).toEqual(['|-kaizoexp|p1a: Monferno|450']);
  }
  return state;
}

describe('a two-fight gauntlet carries a level gained mid-fight', () => {
  it('fight 2 starts it at the new level, with that level\'s stats, max HP, EXP, moves and PP, and its HP carried', () => {
    const carry = carryOut(fightOne());
    expect(carry).toEqual({ mons: [{ hp: 53, pp: [19, 19], status: NONE, item: 0, exp: 25427, moves: [ID.plainHit, ID.slash] }] });
    const saved = monferno();
    const next = fight([saved], [resolvedMon(ID.deoxys, 50, [ID.growl])], carry);
    const { atk, def, spa, spd, spe } = computeStats(saved.baseStats, saved.ivs, saved.evs, 31, saved.nature.value ?? 0);
    expect([levelOf(next), mine(next).storedStats, slotsOf(next), legalChoices(next, 'p1')])
      .toEqual([[31, 53, 90, 25427], { atk, def, spa, spd, spe }, [['plainhit', 19, 20], ['slash', 19, 20]], [move(0), move(1)]]);
    expect(spe).toBe(64);
    expect(logOf(next)).toContain('|switch|p1a: Monferno|Monferno, L31, M|53/90');
    // Deoxys 50 at 1 HP pays 2731: 28158, level 32, Bite into slot 3, HP 53 + 2 = 55.
    const after = step(enemyHp(next, 1), { p1: move(0), p2: move(0) }, 'terminal');
    expect(kaizo(after)).toEqual(['|-kaizoexp|p1a: Monferno|2731', '|-kaizolevel|p1a: Monferno|32', '|-kaizolearn|p1a: Monferno|Bite']);
    expect(levelOf(after)).toEqual([32, 55, 92, 28158]);
    expect(carryOut(after).mons[0]).toMatchObject({ exp: 28158, moves: [ID.plainHit, ID.slash, ID.bite] });
  });

  it('a heal between the fights written as "above max" starts it full at the new level', () => {
    const carry = carryOut(fightOne());
    const next = fight([monferno()], [magikarp21()], { mons: carry.mons.map((mon) => ({ ...mon, hp: 9999, pp: mon.pp.map(() => 99), status: NONE })) });
    expect([levelOf(next), slotsOf(next)]).toEqual([[31, 90, 90, 25427], [['plainhit', 20, 20], ['slash', 20, 20]]]);
  });

  it('the line builder\'s levelUp carries too: its EXP is the new level\'s total, and its moves the ones it learned', () => {
    const up = levelUp(fight([monferno()], [magikarp21()]), 0, 33);
    expect(carryOut(up).mons[0]).toMatchObject({ exp: MEDIUM_SLOW[33], moves: [ID.plainHit, ID.slash, ID.bite] });
    const next = fight([monferno()], [magikarp21()], carryOut(up));
    expect([levelOf(next), slotsOf(next)]).toEqual([[33, 95, 95, MEDIUM_SLOW[33]], [['plainhit', 20, 20], ['slash', 20, 20], ['bite', 25, 25]]]);
  });
});

describe('createBattle from a carry', () => {
  it('the carry\'s EXP sets the level whichever way it moves: a lower level, level 1, and level 100 for any EXP from its total', () => {
    const zigzagoon = playerMon(ID.zigzagoon, 20, [ID.tackle]);
    expect([levelOf(carriedFight(monferno(), { exp: MEDIUM_SLOW[29] })), ...[0, 7, 2_000_000].map((exp) => levelOf(carriedFight(zigzagoon, { exp })))]).toEqual([
      [29, 85, 85, MEDIUM_SLOW[29]], [1, 12, 12, 0], [1, 12, 12, 7], [100, 217, 217, 2_000_000], // level 2 at 8
    ]);
  });

  it('a move taught into a free slot is in the next fight\'s list with its PP; pp is indexed by `moves`, also in another order', () => {
    // Ember 25 PP with the save's 3 PP Ups: 40. A carried move the save lacks has no PP Ups: Slash 20.
    const saved = playerMon(ID.monferno, 30, [ID.ember], { ppUps: [3] });
    const grew = carriedFight(saved, { hp: 50, pp: [31, 7], moves: [ID.ember, ID.slash] });
    expect([slotsOf(grew), levelOf(grew), legalChoices(grew, 'p1')]).toEqual([[['ember', 31, 40], ['slash', 7, 20]], [30, 50, 87, MEDIUM_SLOW[30]], [move(0), move(1)]]);
    expect(slotsOf(carriedFight(saved, { hp: 50, pp: [5, 39], moves: [ID.slash, ID.ember] }))).toEqual([['slash', 5, 20], ['ember', 39, 40]]);
    expect(slotsOf(carriedFight(saved, { hp: 50, pp: [31], moves: [ID.ember, ID.slash] }))).toEqual([['ember', 31, 40], ['slash', 20, 20]]); // a pp left out is full
  });

  it('PP Ups go by move when the carried list has the save\'s length too: reordered, and a move replaced in place', () => {
    const saved = playerMon(ID.monferno, 30, [ID.ember, ID.tackle], { ppUps: [3, 1] }); // Ember 40, Tackle 42
    expect(slotsOf(carriedFight(saved, { hp: 50, pp: [99, 99], moves: [ID.tackle, ID.ember] }))).toEqual([['tackle', 42, 42], ['ember', 40, 40]]);
    expect(slotsOf(carriedFight(saved, { hp: 50, pp: [99, 99], moves: [ID.bite, ID.tackle] }))).toEqual([['bite', 25, 25], ['tackle', 42, 42]]);
  });

  it('HP and PP above the max mean full, at the save\'s level and at a carried one', () => {
    const saved = playerMon(ID.monferno, 30, [ID.ember, ID.plainHit], { currentHp: 10, pp: [1, 2], ppUps: [3, 0] });
    const big = { hp: Number.MAX_SAFE_INTEGER, pp: [1000, 1000] };
    expect([levelOf(carriedFight(saved, big)), slotsOf(carriedFight(saved, big))]).toEqual([[30, 87, 87, MEDIUM_SLOW[30]], [['ember', 40, 40], ['plainhit', 20, 20]]]);
    const levelled = carriedFight(saved, { ...big, exp: MEDIUM_SLOW[32] });
    expect([levelOf(levelled), slotsOf(levelled)]).toEqual([[32, 92, 92, MEDIUM_SLOW[32]], [['ember', 40, 40], ['plainhit', 20, 20]]]); // no `moves`: the save's
  });

  it('a carry without `exp` or `moves` starts from the save\'s EXP, level and moves, with the what-if rule', () => {
    const saved = playerMon(ID.monferno, 30, [ID.ember, ID.plainHit], { exp: 22000 });
    const old = carriedFight(saved, { hp: 40, pp: [10, 11] });
    expect([levelOf(old), slotsOf(old)]).toEqual([[30, 40, 87, 22000], [['ember', 10, 25], ['plainhit', 11, 20]]]);
    expect(carriedFight(saved, { hp: 40, pp: [10, 11], exp: 22000, moves: [ID.ember, ID.plainHit] }).key).toBe(old.key);
    // A what-if level 33 over the save's level 30 EXP starts at 33's own total.
    expect(levelOf(carriedFight(playerMon(ID.monferno, 33, [ID.ember], { exp: 22000 }), { hp: 40, pp: [10] }))).toEqual([33, 40, 95, MEDIUM_SLOW[33]]);
  });

  it.each<[string, Partial<CarriedMon>, RegExp | typeof RangeError]>([
    ['an empty move list', { moves: [] }, RangeError],
    ['more than four moves', { moves: [ID.plainHit, ID.slash, ID.bite, ID.growl, ID.leer] }, RangeError],
    ['a repeated move', { moves: [ID.slash, ID.slash] }, RangeError],
    ['a move the dex lacks', { moves: [12345] }, /12345/],
    ['negative EXP', { exp: -1 }, RangeError],
    ['EXP that is no whole number', { exp: 24294.5 }, RangeError],
  ])('refuses %s', (_, fields, error) => expect(() => carriedFight(monferno(), { hp: 50, pp: [], ...fields })).toThrow(error));
});

describe('carryOut always gives item, exp and moves, as the battle holds them, and the cache keeps them', () => {
  /** Every outcome of fight 1's three decisions, from the state each followed. */
  function fightOneOutcomes(): Outcome[] {
    const outcomes: Outcome[] = [];
    let state = fightOneStart();
    for (const [index, [choices]] of FIGHT_ONE.entries()) {
      const from = index === 2 ? enemyHp(state, 1) : state;
      outcomes.push(...expandTurn(from, choices));
      state = runFirstOutcome(from, choices);
    }
    return outcomes;
  }

  it('in every outcome of fight 1: the EXP, own moves as ROM IDs and item; one key carries one thing; the cache equals a restore', () => {
    const outcomes = fightOneOutcomes();
    expect(outcomes.some((outcome) => carryOut(outcome.state).mons[0]!.moves?.length === 2)).toBe(true); // a level-up's Slash
    const byKey = new Map<string, CarryState>();
    for (const { state } of outcomes) {
      const carry = carryOut(state);
      const pokemon = mine(state);
      expect(carry.mons).toHaveLength(1);
      expect([carry.mons[0]!.item, carry.mons[0]!.exp, carry.mons[0]!.moves])
        .toEqual([0, (pokemon.m as Record<string, unknown>)[EXP_KEY], pokemon.baseMoveSlots.map((slot) => ROM_MOVE[slot.id])]);
      if (byKey.has(state.key)) expect(carry).toEqual(byKey.get(state.key));
      byKey.set(state.key, carry);
      expect(carry).toEqual(carryIn(restore(state)));
    }
    expect(cacheMismatches(outcomes.map((outcome) => outcome.state))).toEqual([]);
  });

  it('createBattle\'s and levelUp\'s states carry as a copy does, and hand out copies', () => {
    const start = fight([monferno()], [magikarp21()]);
    expect(carryOut(start)).toEqual({ mons: [{ hp: 87, pp: [20], status: NONE, item: 0, exp: MEDIUM_SLOW[31] - 1, moves: [ID.plainHit] }] });
    expect(carryOut(start)).toEqual(carryOut({ ...start }));
    const up = levelUp(start, 0, 33);
    expect(carryOut(up)).toEqual(carryOut({ ...up }));
    const first = carryOut(up);
    first.mons[0]!.exp = 0;
    first.mons[0]!.moves!.push(ID.growl);
    expect(carryOut(up).mons[0]).toMatchObject({ exp: MEDIUM_SLOW[33], moves: [ID.plainHit, ID.slash, ID.bite] });
  });

  it('a fainted Pokémon still carries its EXP and moves', () => {
    // Deoxys moves first: Monferno faints before its Plain Hit, so its PP stays 20.
    const fainted = step(myHp(fight([monferno(), playerMon(ID.zigzagoon, 20, [ID.growl])], [resolvedMon(ID.deoxys, 50, [ID.plainHit])]), 1), { p1: move(0), p2: move(0) }, 'playerReplacement');
    expect(carryOut(fainted).mons[0]).toEqual({ hp: 0, pp: [20], status: NONE, item: 0, exp: MEDIUM_SLOW[31] - 1, moves: [ID.plainHit] });
    expect(carryOut(fainted).mons[1]).toMatchObject({ exp: 8000, moves: [ID.growl] }); // Zigzagoon 20: the level's total
  });

  it('a Transformed Pokémon carries its own moves, one learned while Transformed included, never the copy\'s', () => {
    const live = restore(fight([playerMon(ID.monferno, 31, [ID.ember, ID.tackle]), playerMon(ID.bidoof, 25, [ID.tackle])], [resolvedMon(ID.zigzagoon, 60, [ID.growl, ID.leer])]));
    const pokemon = live.p1.active[0]!;
    expect(pokemon.transformInto(live.p2.active[0]!)).toBe(true);
    expect(applyLevel(live, pokemon, 32).learned).toEqual([ID.bite]);
    const own = [ID.ember, ID.tackle, ID.bite];
    const state = snapshot(live);
    expect([carryIn(live).mons[0]!.moves, carryOut(state).mons[0]!.moves]).toEqual([own, own]);
    const leaves = expandTurn(state, { p1: move(0), p2: move(0) });
    expect(leaves.length).toBeGreaterThan(0);
    for (const leaf of leaves) {
      expect(carryOut(leaf.state).mons[0]!.moves).toEqual(own);
      expect(carryOut(leaf.state)).toEqual(carryOut({ ...leaf.state }));
    }
  });
});
