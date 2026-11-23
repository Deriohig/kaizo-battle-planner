// EXP paid mid-fight at the cartridge's points, and the level-ups it brings (src/engine/mod/exp.ts cites the rules).
// Numbers are the cartridge's: floor(base x level / 7), split among living participants and Exp. Share holders, then
// x150/100 for a Lucky Egg, a trainer battle (always), and x150/100 or x170/100 when traded, each floored. Growth:
// medium fast n^3 (Zigzagoon), medium slow (Monferno, Machop), slow 5n^3/4 (Deoxys, Magikarp). Hardy, 31 IVs, 0 EVs.

import { beforeAll, describe, expect, it } from 'vitest';
import { buildMoves } from '../../../src/battle/moves.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { Choice, EngineState, FieldSpec, Outcome, Phase, Side } from '../../../src/contracts/engine.js';
import { applyChoices, choicesIn, createBattle, legalChoices, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { ChanceDriver, nextScript } from '../../../src/engine/chance.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { EXP_KEY } from '../../../src/engine/exp.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { unmodelledIn } from '../../../src/engine/facts.js';
import { levelUp } from '../../../src/engine/levelUp.js';
import { EXP_MASK_KEY, EXP_PENDING_KEY, expMask, livingOnly, noteSendOut } from '../../../src/engine/mod/exp.js';
import { fieldConditionsUp, PURSUIT_FIELD_NOTE } from '../../../src/engine/mod/moves.js';
import { add, cmp, ONE, rat, ZERO } from '../../../src/engine/rational.js';
import { buildNameIndex } from '../../../src/names/nameIndex.js';
import { ABILITY, BAG, fixtureDex, ID, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const DOOM_DESIRE = 353;
const LUCKY_EGG = 231; // HOLD_EFFECT_EXP_UP (the hack ROM's item data)
const EXP_SHARE = 216; // HOLD_EFFECT_EXP_SHARE
const LEFTOVERS = 234;
const LIFE_ORB = 270;
const MICLE_BERRY = 209; // HOLD_EFFECT_PINCH_ACC_UP, parameter 4 in the hack ROM
const SPEED_BOOST = 3; // a handler in each holder's end-of-turn list

const fixture = fixtureDex();
const species = fixture.data.rom.species;
species[ID.magikarp]!.baseExp = 152; // 456 at level 21
species[ID.zigzagoon]!.baseExp = 100; // 300 at level 21
species[ID.machop]!.baseExp = 118; // 370 at level 22, 505 at level 30
species[ID.deoxys]!.baseExp = 255; // 1821 at level 50, 3642 at level 100, 765 at level 21
// Invented learnsets: Monferno learns Slash at 31 and Bite at 32; Charmander two moves at 31.
fixture.data.rom.learnsets[ID.monferno] = [{ move: ID.slash, level: 31 }, { move: ID.bite, level: 32 }];
fixture.data.rom.learnsets[ID.charmander] = [{ move: ID.leer, level: 31 }, { move: ID.bite, level: 31 }];
// Doom Desire, the hack's numbers (Future Sight's ROM effect), with its docs row.
fixture.data.rom.moves[DOOM_DESIRE] = {
  id: DOOM_DESIRE, effect: 148, category: 'special', power: 120, type: 8, accuracy: 85, pp: 5, effectChance: 0, target: 0, priority: 0, flags: 0,
};
fixture.data.docs.moves.push({
  id: DOOM_DESIRE, name: 'Doom Desire', effectText: 'Future Sight effect', category: 'special', power: 120, type: '', accuracy: 85, pp: 5,
  effectChance: 0, targets: '', priority: 0, contact: false,
});
fixture.data.names = buildNameIndex(fixture.data.docs);
const moves = buildMoves(fixture.data);
beforeAll(() => installKaizoDex(fixture.data, moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const to = (index: number): Choice => ({ kind: 'switch', index });
type Choices = { p1?: Choice; p2?: Choice };
type Json = { log: string[]; formatData: Record<string, unknown> };
const BOTH: Choices = { p1: move(0), p2: move(0) };
const SECOND: Choices = { p1: move(1), p2: move(0) };

const json = (state: EngineState): Json => JSON.parse(state.json) as Json;
const logOf = (state: EngineState): string[] => json(state).log;
/** The step's EXP lines, in order. */
const kaizo = (state: EngineState): string[] => logOf(state).filter((line) => line.startsWith('|-kaizo'));
/** The index of the step's first line that starts with `prefix`, or -1. */
const at = (state: EngineState, prefix: string): number => logOf(state).findIndex((line) => line.startsWith(prefix));
const before = (state: EngineState, ...prefixes: string[]) => {
  for (let i = 1; i < prefixes.length; i++) expect(at(state, prefixes[i - 1]!), `${prefixes[i - 1]} before ${prefixes[i]}`).toBeLessThan(at(state, prefixes[i]!));
};
const sumOf = (outcomes: readonly Outcome[]) => outcomes.reduce((sum, outcome) => add(sum, outcome.probability), ZERO);
const exp = (who: string, amount: number) => `|-kaizoexp|${who}|${amount}`;
const lvl = (who: string, level: number) => `|-kaizolevel|${who}|${level}`;
const learn = (who: string, name: string) => `|-kaizolearn|${who}|${name}`;
const offer = (who: string, name: string) => `|-kaizooffer|${who}|${name}`;

function battle(player: PlayerMon[], trainer: ResolvedMon[], field: FieldSpec = {}): EngineState {
  return createBattle({ player, trainer: resolvedTrainer(BAG.none, trainer), field });
}

/** One step down each chance's first outcome (a crit, the highest roll, a hit), which must stop at `phase`. */
function step(state: EngineState, choices: Choices, phase?: Phase['kind']): EngineState {
  const next = runFirstOutcome(state, choices);
  if (phase !== undefined) expect(next.phase.kind).toBe(phase);
  return next;
}

/** `state` changed by `edit` on a restore of it. */
function edited(state: EngineState, edit: (battle: ReturnType<typeof restore>) => void): EngineState {
  const live = restore(state);
  edit(live);
  return snapshot(live);
}
const enemyHp = (hp: number) => (state: EngineState): EngineState => edited(state, (live) => { live.p2.active[0]!.hp = hp; });
const myHp = (hp: number) => (state: EngineState): EngineState => edited(state, (live) => { live.p1.active[0]!.hp = hp; });

/** The player's party member `index` (by `side.team`) in `state`. */
function mine(state: EngineState, index: number): Pokemon {
  const live = restore(state);
  return live.p1.pokemon.find((pokemon) => live.p1.team.indexOf(pokemon.set) === index)!;
}
const expOf = (state: EngineState, index: number): unknown => (mine(state, index).m as Record<string, unknown>)[EXP_KEY];

/** The party indices whose bits the state's stored mask holds. */
function participants(state: EngineState): number[] {
  const mask = json(state).formatData[EXP_MASK_KEY] as number;
  return [0, 1, 2, 3, 4, 5].filter((index) => (mask & (1 << index)) !== 0);
}

/** Steps with `choices` (first outcomes) until a step's log holds `line`. */
const until = (choices: Choices, line: string, turns = 6) => (state: EngineState): EngineState => {
  let next = state;
  for (let turn = 0; turn < turns; turn++) {
    next = step(next, choices);
    if (logOf(next).some((entry) => entry.startsWith(line))) return next;
  }
  throw new Error(`no ${line} in ${turns} steps`);
};
/** The engine's battle-level notes (`engine:` ones). */
const engineNotes = (state: EngineState): string[] => unmodelledIn(state).filter((note) => note.startsWith('engine:'));
/** Whether the step's EXP lines come last. */
const paidLast = (state: EngineState): boolean => {
  const log = logOf(state);
  const first = at(state, '|-kaizo');
  return first > -1 && log.slice(first).every((line) => line.startsWith('|-kaizo'));
};

// Growth totals (vanilla tables).
const MEDIUM_SLOW = { 25: 11735, 26: 13411, 27: 15244, 30: 21760, 31: 24294, 32: 27021, 33: 29949 } as const;
const MEDIUM_FAST = { 20: 8000, 21: 9261, 99: 970299, 100: 1_000_000 } as const;
const SLOW = { 50: 156250, 51: 165813, 52: 175760 } as const;

const deoxys = (fields: Partial<PlayerMon> = {}) => playerMon(ID.deoxys, 50, [ID.plainHit, ID.growl], fields);
const monferno = (moveIds: number[], fields: Partial<PlayerMon> = {}) => playerMon(ID.monferno, 30, moveIds, fields);
const zig20 = (fields: Partial<PlayerMon> = {}) => playerMon(ID.zigzagoon, 20, [ID.growl], fields);
const magikarp21 = () => resolvedMon(ID.magikarp, 21, [ID.growl]);
const zigzagoon21 = () => resolvedMon(ID.zigzagoon, 21, [ID.growl]);
const deoxys50 = () => resolvedMon(ID.deoxys, 50, [ID.growl]);
const nearly31 = (moveIds: number[]) => monferno(moveIds, { exp: MEDIUM_SLOW[31] - 1 });
const D = 'p1a: Deoxys';
const M = 'p1a: Monferno';

type Step = [Choices, Phase['kind']?] | ((state: EngineState) => EngineState);
// Out to the bench and back: both party members take part.
const OUT: Step = [{ p1: to(1), p2: move(0) }, 'turnChoice'];
const BACK: Step = [{ p1: to(0), p2: move(0) }, 'turnChoice'];
const untilMagikarpFaints: Step = until(SECOND, '|faint|p2a: Magikarp');
const paidAtTurnEnd = (end: EngineState) => {
  before(end, '|upkeep', '|-kaizoexp|');
  expect(paidLast(end)).toBe(true);
};
const paidBeforeUpkeep = (faint: string) => (end: EngineState) => before(end, faint, '|-kaizoexp|', '|upkeep');

interface Case {
  name: string; party: () => PlayerMon[]; enemies: () => ResolvedMon[]; field?: FieldSpec; steps: Step[]; lines: string[];
  check?: (end: EngineState, states: EngineState[]) => void;
}

/** Each case builds its battle, runs its steps (first outcomes), and checks the last step's EXP lines. */
const scenarios = (cases: Case[]) => it.each(cases)('$name', ({ party, enemies, field, steps, lines, check }) => {
  const states = [battle(party(), enemies(), field)];
  for (const each of steps) states.push(typeof each === 'function' ? each(states.at(-1)!) : step(states.at(-1)!, each[0], each[1]));
  const end = states.at(-1)!;
  expect(kaizo(end)).toEqual(lines);
  check?.(end, states);
});

describe('the payout at the end of a move (bcp:3962-3972)', () => {
  scenarios([
    { name: 'an own Pokémon alone: 456 -> 684, after the faint and the win, in the terminal state', party: () => [deoxys()], enemies: () => [magikarp21()],
      steps: [[BOTH, 'terminal']], lines: [exp(D, 684)], check: (end) => {
        before(end, '|faint|p2a: Magikarp', '|win|', '|-kaizoexp|');
        expect(expOf(end, 0)).toBe(SLOW[50] + 684);
      } },
    { name: 'traded, "[boosted]": 684 -> 1026 (bs:9757-9765)', party: () => [deoxys({ origin: 'traded' })], enemies: () => [magikarp21()],
      steps: [[BOTH, 'terminal']], lines: [`${exp(D, 1026)}|[boosted]`] },
    { name: 'a Lucky Egg: Machop 22, 370 -> 555 -> 832 (bs:9749-9755)', party: () => [deoxys({ item: LUCKY_EGG })], enemies: () => [resolvedMon(ID.machop, 22, [ID.growl])],
      steps: [[BOTH, 'terminal']], lines: [exp(D, 832)] },
    { name: 'two living participants share: 300 -> 150 each -> 225, the benched one named "p1:"', party: () => [monferno([ID.growl]), deoxys()],
      enemies: () => [zigzagoon21()], steps: [OUT, [BOTH, 'terminal']], lines: [exp('p1: Monferno', 225), exp(D, 225)] },
    { name: 'an Exp. Share on a benched non-participant: 225 each (bs:2219-2230)', party: () => [deoxys(), zig20({ item: EXP_SHARE })], enemies: () => [zigzagoon21()],
      steps: [[BOTH, 'terminal']], lines: [exp(D, 225), exp('p1: Zigzagoon', 225)] },
    { name: 'a level 100 participant counts but is not paid (bs:2204-2206, :9740)', party: () => [playerMon(ID.zigzagoon, 100, [ID.growl]), deoxys()],
      enemies: () => [zigzagoon21()], steps: [OUT, [BOTH, 'terminal']], lines: [exp(D, 225)] },
    { name: 'the enemy switches itself: the new enemy\'s mask is the player\'s active alone, 684', party: () => [monferno([ID.growl]), deoxys()],
      enemies: () => [zigzagoon21(), magikarp21()], steps: [OUT, [{ p1: move(0), p2: to(1) }, 'enemyReplacement']], lines: [exp(D, 684)],
      check: (_, states) => expect(participants(states[1]!)).toEqual([0, 1]) },
    // Deoxys's 255 at Magikarp's level 21: 765 -> 1147; Magikarp's own 152 would give 684.
    { name: 'a Transformed enemy pays its copied species\' base EXP at its own level, read before the faint', party: () => [deoxys()],
      enemies: () => [magikarp21(), zigzagoon21()],
      steps: [(state) => edited(state, (live) => { expect(live.p2.active[0]!.transformInto(live.p1.active[0]!)).toBe(true); }), [BOTH, 'enemyReplacement']],
      lines: [exp(D, 1147)] },
    { name: 'a Leech Seed faint is paid at once in the end of turn (bcp:1295-1296)', party: () => [deoxys({ moves: [ID.leechSeed, ID.growl], pp: [10, 40] })],
      enemies: () => [magikarp21(), zigzagoon21()], steps: [enemyHp(1), [BOTH, 'enemyReplacement']], lines: [exp(D, 684)],
      check: paidBeforeUpkeep('|faint|p2a: Magikarp') },
    { name: 'a weather faint is paid in the end of turn, before its end', party: () => [deoxys()], enemies: () => [magikarp21(), zigzagoon21()], field: { weather: 'sand' },
      steps: [enemyHp(1), [SECOND, 'enemyReplacement']], lines: [exp(D, 684)], check: paidBeforeUpkeep('|faint|p2a: Magikarp') },
    // Shedinja's base EXP is 0: the share's floor of 1, x150/100.
    { name: 'an enemy knocked out by Spikes on its way in mid-turn is paid when its switch-in ends, before the next action',
      party: () => [monferno([ID.spikes, ID.growl]), zig20()], enemies: () => [deoxys50(), resolvedMon(ID.shedinja, 20, [ID.growl]), zigzagoon21()],
      steps: [[BOTH, 'turnChoice'], [{ p1: move(1), p2: to(1) }, 'enemyReplacement']], lines: [exp(M, 1)],
      check: (end) => before(end, '|faint|p2a: Shedinja', '|-kaizoexp|', '|move|p1a: Monferno|Growl') },
    { name: 'Whirlwind drags the player\'s Pokémon in: it is added, and paid with the other', party: () => [monferno([ID.growl]), deoxys()],
      enemies: () => [resolvedMon(ID.zigzagoon, 21, [ID.whirlwind, ID.growl])], steps: [[BOTH, 'turnChoice'], [{ p1: move(0), p2: move(1) }, 'terminal']],
      lines: [exp('p1: Monferno', 225), exp(D, 225)], check: (_, states) => expect(participants(states[1]!)).toEqual([0, 1]) },
    // The Magikarp's mask {Monferno, Zigzagoon}: 228 -> 342 each; the newcomer's mask would pay 684 to Monferno alone.
    { name: 'the player\'s Pursuit knocks out the switching enemy: its own participants are paid before the new enemy is out',
      party: () => [monferno([ID.pursuit]), zig20()], enemies: () => [magikarp21(), deoxys50()], steps: [OUT, BACK, [{ p1: move(0), p2: to(1) }, 'turnChoice']],
      lines: [exp(M, 342), exp('p1: Zigzagoon', 342)], check: (end, states) => {
        expect([participants(states[2]!), participants(end)]).toEqual([[0, 1], [0]]);
        before(end, '|-kaizoexp|', '|switch|p2a: Deoxys');
      } },
  ]);

  it('the observation keeps the lines and shows the new level, HP and max HP; nothing of the trainer\'s', () => {
    const [outcome] = expandTurn(battle([nearly31([ID.plainHit])], [magikarp21(), zigzagoon21()]), BOTH).filter((each) => each.state.phase.kind === 'enemyReplacement');
    const view = JSON.parse(outcome!.observation) as { events: unknown[]; player: { level: number; hp: number; maxhp: number }[] };
    expect(view.events.filter((event) => typeof event === 'string' && event.startsWith('|-kaizo'))).toEqual([exp(M, 684), lvl(M, 31), learn(M, 'Slash')]);
    expect(view.player[0]).toMatchObject({ level: 31, hp: 90, maxhp: 90 });
    expect(Object.keys(view.player[0]!)).not.toContain(EXP_KEY); // the EXP total is state, not shown
    expect(outcome!.observation).not.toMatch(/\|-kaizo[a-z]+\|p2/);
  });

  it('a faint outside any action (sheetAi\'s `faint` then `faintMessages`) is paid at once', () => {
    const live = restore(battle([deoxys()], [magikarp21(), zigzagoon21()]));
    live.p2.active[0]!.faint();
    live.faintMessages();
    expect(live.log.filter((line) => line.startsWith('|-kaizo'))).toEqual([exp(D, 684)]);
    expect([(live.p1.active[0]!.m as Record<string, unknown>)[EXP_KEY], live.formatData[EXP_MASK_KEY]]).toEqual([SLOW[50] + 684, 0]);
  });
});

describe('a knock-out that faints one of the player\'s too: only the living are counted and paid (bs:2204-2206, :9740)', () => {
  const exploder = (fields: Partial<PlayerMon> = {}) => [monferno([ID.explosion]), zig20(fields)];
  scenarios([
    // Had the fainted Monferno been counted, the divisor would be 2: 228 -> 342.
    { name: 'Explosion faints both; the benched participant alone is paid, 684, and levels on the bench',
      party: () => exploder({ exp: 9000 }), enemies: () => [magikarp21(), deoxys50()], steps: [OUT, BACK, [BOTH, 'playerReplacement']],
      lines: [exp('p1: Zigzagoon', 684), lvl('p1: Zigzagoon', 21)], check: (end, states) => {
        expect(participants(states[2]!)).toEqual([0, 1]);
        const zigzagoon = mine(end, 1);
        expect([expOf(end, 1), zigzagoon.level, zigzagoon.hp, zigzagoon.maxhp, participants(end)]).toEqual([9684, 21, 53, 53, []]);
      } },
    { name: 'every participant fainted, an Exp. Share holder alive: it gets `shared`, 228 -> 342, with no division by 0 (bs:2219-2230)',
      party: () => exploder({ item: EXP_SHARE }), enemies: () => [magikarp21(), deoxys50()], steps: [[BOTH, 'playerReplacement']], lines: [exp('p1: Zigzagoon', 342)] },
    // The recoil is floor(87 / 10) = 8.
    { name: 'Life Orb\'s recoil faints the user on the knock-out: the other participant gets the whole share, 684',
      party: () => [monferno([ID.plainHit], { item: LIFE_ORB }), zig20()], enemies: () => [magikarp21(), deoxys50()],
      steps: [OUT, BACK, myHp(5), [BOTH, 'playerReplacement']], lines: [exp('p1: Zigzagoon', 684)],
      check: (end) => expect(at(end, '|faint|p1a: Monferno')).toBeGreaterThan(-1) },
    { name: 'Destiny Bond takes the attacker down; the benched participant gets the whole share, 505 -> 757',
      party: () => [monferno([ID.destinyBond]), zig20()], enemies: () => [resolvedMon(ID.machop, 30, [ID.plainHit, ID.growl]), zigzagoon21()],
      steps: [[{ p1: to(1), p2: move(1) }, 'turnChoice'], [{ p1: to(0), p2: move(1) }, 'turnChoice'], myHp(10), [BOTH, 'playerReplacement']],
      lines: [exp('p1: Zigzagoon', 757)], check: (end) => expect(at(end, '|faint|p2a: Machop')).toBeGreaterThan(-1) },
    { name: 'a fainted participant\'s bit goes at its faint, so the payout after a replacement counts the living alone: 757',
      party: () => [playerMon(ID.zigzagoon, 5, [ID.growl]), deoxys()], enemies: () => [resolvedMon(ID.machop, 30, [ID.plainHit])],
      steps: [[BOTH, 'playerReplacement'], [{ p1: to(1) }, 'turnChoice'], [BOTH, 'terminal']], lines: [exp(D, 757)],
      check: (_, states) => expect(participants(states[1]!)).toEqual([]) },
  ]);
});

describe('level-ups and their timing', () => {
  const MACHOP = 'p1a: Machop';
  const machop = (moveIds: number[], item: number) => playerMon(ID.machop, 25, moveIds, { exp: MEDIUM_SLOW[26] - 1, item });
  const meanMagikarp = () => [resolvedMon(ID.magikarp, 21, [ID.meanLook]), zigzagoon21()];
  scenarios([
    // 77 - floor(77 / 10) = 70, then the level-up's +3: 73 of 80.
    { name: 'Life Orb takes a tenth of the old max HP, then the level-up adds its gain', party: () => [machop([ID.plainHit], LIFE_ORB)], enemies: meanMagikarp,
      steps: [[BOTH, 'enemyReplacement']], lines: [exp(MACHOP, 684), lvl(MACHOP, 26)], check: (end) => {
        before(end, '|-damage|p1a: Machop|70/77|[from] item: Life Orb', '|-kaizoexp|');
        expect([mine(end, 0).level, mine(end, 0).hp, mine(end, 0).maxhp]).toEqual([26, 73, 80]);
      } },
    // The faster Magikarp's list runs first; 40 + 3 = 43, then Leftovers floor(80 / 16) = 5 of the new max: 48.
    { name: 'a poison faint is paid at once (bcp:1295-1296); the player\'s Leftovers later heals a sixteenth of the new max HP',
      party: () => [machop([ID.poisonPowder], LEFTOVERS)], enemies: meanMagikarp, steps: [enemyHp(1), myHp(40), [BOTH, 'enemyReplacement']],
      lines: [exp(MACHOP, 684), lvl(MACHOP, 26)], check: (end) => {
        before(end, '|-kaizoexp|', '|-heal|p1a: Machop|48/80|[from] item: Leftovers');
        before(end, '|-kaizoexp|', '|upkeep');
        expect(mine(end, 0).hp).toBe(48);
      } },
    // 87 -> 90 HP; Speed floor(193 x 31 / 100) + 5. Slash goes into the second slot.
    { name: 'at the enemyReplacement state the level, stats, HP, Speed and moves are the new ones', party: () => [nearly31([ID.plainHit])],
      enemies: () => [magikarp21(), zigzagoon21()], steps: [[BOTH, 'enemyReplacement']], lines: [exp(M, 684), lvl(M, 31), learn(M, 'Slash')],
      check: (end) => {
        const after = mine(end, 0);
        expect([after.level, after.maxhp, after.hp, after.storedStats.spe, after.moveSlots.map((slot) => slot.id)]).toEqual([31, 90, 90, 64, ['plainhit', 'slash']]);
      } },
    // 3642 -> 5463; 21760 + 5463 = 27223, past 32's 27021 and below 33's.
    { name: 'two levels from one knock-out, one at a time, each with its move', party: () => [monferno([ID.plainHit, ID.growl])],
      enemies: () => [resolvedMon(ID.deoxys, 100, [ID.growl])], steps: [enemyHp(1), [BOTH, 'terminal']],
      lines: [exp(M, 5463), lvl(M, 31), learn(M, 'Slash'), lvl(M, 32), learn(M, 'Bite')],
      check: (end) => expect([mine(end, 0).level, mine(end, 0).hp, mine(end, 0).maxhp, expOf(end, 0)]).toEqual([32, 92, 92, 27223]) },
    { name: 'level 99 to 100 with EXP to spare: the EXP is the level 100 total (pk:3509-3512)',
      party: () => [playerMon(ID.zigzagoon, 99, [ID.plainHit], { exp: MEDIUM_FAST[100] - 1 })], enemies: () => [magikarp21()], steps: [[BOTH, 'terminal']],
      lines: [exp('p1a: Zigzagoon', 684), lvl('p1a: Zigzagoon', 100)], check: (end) => expect([mine(end, 0).level, expOf(end, 0)]).toEqual([100, MEDIUM_FAST[100]]) },
    { name: 'four moves known: the move is offered and declined', party: () => [nearly31([ID.plainHit, ID.growl, ID.leer, ID.tackle])],
      enemies: () => [magikarp21(), zigzagoon21()], steps: [[BOTH, 'enemyReplacement']], lines: [exp(M, 684), lvl(M, 31), offer(M, 'Slash')],
      check: (end) => expect(mine(end, 0).moveSlots.map((slot) => slot.id)).toEqual(['plainhit', 'growl', 'leer', 'tackle']) },
    { name: 'a move it knows is skipped, with no line', party: () => [nearly31([ID.plainHit, ID.slash])], enemies: () => [magikarp21(), zigzagoon21()],
      steps: [[BOTH, 'enemyReplacement']], lines: [exp(M, 684), lvl(M, 31)] },
    { name: 'two new moves at one level with three known: the first is learned, then the second offered',
      party: () => [playerMon(ID.charmander, 30, [ID.plainHit, ID.growl, ID.tackle], { exp: MEDIUM_SLOW[31] - 1 })], enemies: () => [magikarp21(), zigzagoon21()],
      steps: [[BOTH, 'enemyReplacement']], lines: [exp('p1a: Charmander', 684), lvl('p1a: Charmander', 31), learn('p1a: Charmander', 'Leer'), offer('p1a: Charmander', 'Bite')] },
  ]);

  it('three moves known: the new move goes into slot 4 at full PP and is in the next request\'s choices', () => {
    const after = step(battle([nearly31([ID.plainHit, ID.growl, ID.leer])], [magikarp21(), zigzagoon21()]), BOTH, 'enemyReplacement');
    expect(kaizo(after)).toContain(learn(M, 'Slash'));
    const next = step(after, { p2: to(1) }, 'turnChoice');
    expect(legalChoices(next, 'p1')).toContainEqual(move(3));
    const slot = mine(next, 0).moveSlots[3]!;
    expect([slot.id, slot.pp, slot.maxpp]).toEqual(['slash', 20, 20]);
    expect(at(step(next, { p1: move(3), p2: move(0) }), '|move|p1a: Monferno|Slash')).toBeGreaterThan(-1);
  });

  it('a level-up changes the next turn\'s Speed order (and under Trick Room) and its damage', () => {
    // Deoxys 50 (Speed 170) 1 short of 51 (173), against a Deoxys 51 with a Speed IV of 26 (171).
    const enemy = () => resolvedMon(ID.deoxys, 51, [ID.growl], { ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 26 } });
    const second = (expTotal: number, field: FieldSpec = {}) =>
      step(step(battle([deoxys({ exp: expTotal })], [resolvedMon(ID.magikarp, 21, [ID.meanLook]), enemy()], field), BOTH, 'enemyReplacement'), { p2: to(1) }, 'turnChoice');
    const firstMover = (state: EngineState): Side => {
      const next = step(state, SECOND);
      return at(next, '|move|p1a: Deoxys|Growl') < at(next, '|move|p2a: Deoxys|Growl') ? 'p1' : 'p2';
    };
    const levelled = second(SLOW[51] - 1);
    expect(mine(levelled, 0).level).toBe(51);
    expect([levelled, second(SLOW[50]), second(SLOW[51] - 1, { trickRoom: true }), second(SLOW[50], { trickRoom: true })].map(firstMover)).toEqual(['p1', 'p2', 'p2', 'p1']);
    // Its next hit's damage is level 51's.
    const hpLeft = (state: EngineState) => [...new Set(expandTurn(state, BOTH).map((outcome) => restore(outcome.state).p2.active[0]!.hp))].sort((a, b) => a - b);
    const fresh = (level: number) => battle([playerMon(ID.deoxys, level, [ID.plainHit, ID.growl])], [enemy()]);
    expect(hpLeft(levelled)).toEqual(hpLeft(fresh(51)));
    expect(hpLeft(levelled)).not.toEqual(hpLeft(fresh(50)));
  });

  it('levelUp (the line builder\'s) sets the EXP to the new level\'s total, so the next knock-out levels where the cartridge does', () => {
    const up = levelUp(battle([monferno([ID.plainHit, ID.growl])], [deoxys50()]), 0, 31);
    expect(expOf(up, 0)).toBe(MEDIUM_SLOW[31]);
    // 1821 -> 2731; 24294 + 2731 = 27025, level 32; from the stale 21760 it would still be 31.
    const end = step(enemyHp(1)(up), BOTH, 'terminal');
    expect(kaizo(end)).toEqual([exp(M, 2731), lvl(M, 32), learn(M, 'Bite')]);
    expect(expOf(end, 0)).toBe(27025);
  });
});

describe('a U-turn that knocks the enemy out: the switch, then MoveEnd (subscript_attack_then_switch_out.s:71)', () => {
  const uTurnBattle = () => battle([monferno([ID.uTurn, ID.growl]), zig20()], [magikarp21(), deoxys50()]);

  it('nobody is paid at the playerMidTurnSwitch state, which keys the pending faint; then the U-turn user is paid on the bench', () => {
    const mid = step(uTurnBattle(), BOTH, 'playerMidTurnSwitch');
    expect(kaizo(mid)).toEqual([]);
    expect(json(mid).formatData[EXP_PENDING_KEY]).toEqual([{ species: ID.magikarp, level: 21 }]);
    const pending = restore(mid);
    delete pending.formatData[EXP_PENDING_KEY];
    expect(snapshot(pending).key).not.toBe(mid.key);
    const after = step(mid, { p1: to(1) }, 'enemyReplacement');
    expect([kaizo(after), json(after).formatData[EXP_PENDING_KEY], participants(after)]).toEqual([[exp('p1: Monferno', 684)], undefined, []]);
    before(after, '|switch|p1a: Zigzagoon', '|-kaizoexp|', '|upkeep');
  });

  scenarios([
    // Machop (Speed 30) moves after the Magikarp (45): no action is left before the end of turn.
    { name: 'as the turn\'s last action: paid after the newcomer\'s switch-in, before the end of turn', party: () => [playerMon(ID.machop, 25, [ID.uTurn, ID.growl]), zig20()],
      enemies: () => [magikarp21(), deoxys50()], steps: [[BOTH, 'playerMidTurnSwitch'], [{ p1: to(1) }, 'enemyReplacement']], lines: [exp('p1: Machop', 684)],
      check: (end, states) => {
        before(states[1]!, '|move|p2a: Magikarp', '|move|p1a: Machop');
        before(end, '|switch|p1a: Zigzagoon', '|-kaizoexp|', '|upkeep');
      } },
    { name: 'on the trainer\'s last Pokémon: the battle ends with no switch, and the user is paid at once', party: () => [monferno([ID.uTurn, ID.growl]), zig20()],
      enemies: () => [magikarp21()], steps: [[BOTH, 'terminal']], lines: [exp(M, 684)], check: (end) => expect(json(end).formatData[EXP_PENDING_KEY]).toBeUndefined() },
    // Shedinja (1 HP, Exp. Share) faints to Spikes coming in: paid after, Monferno alone counts (684); before, 342 each.
    { name: 'paid after the newcomer\'s hazards: an Exp. Share holder the Spikes knock out is not counted',
      party: () => [monferno([ID.uTurn, ID.growl]), playerMon(ID.shedinja, 20, [ID.growl], { item: EXP_SHARE })],
      enemies: () => [resolvedMon(ID.magikarp, 21, [ID.spikes, ID.growl]), deoxys50()],
      steps: [[SECOND, 'turnChoice'], [{ p1: move(0), p2: move(1) }, 'playerMidTurnSwitch'], [{ p1: to(1) }]], lines: [exp('p1: Monferno', 684)],
      check: (end) => before(end, '|faint|p1a: Shedinja', '|-kaizoexp|') },
  ]);

  it('a restore of the mid-turn state continues as the live battle does, on every chance path', () => {
    for (const { keys, logs } of liveAndRestored(uTurnBattle(), BOTH)) {
      expect(keys[1]).toBe(keys[0]);
      expect(logs[1]).toEqual(logs[0]);
    }
  });
});

describe('Future Sight, Doom Desire and Perish Song knock-outs: paid when the end of turn is over (bcp:1737-1846)', () => {
  const seer = (fields: Partial<PlayerMon> = {}) => playerMon(ID.deoxys, 50, [ID.futureSight, ID.growl], fields);
  const singer = () => playerMon(ID.zigzagoon, 20, [ID.perishSong, ID.growl], { ability: knownAbility(ABILITY.soundproof) }); // no count of its own
  const Z = 'p1a: Zigzagoon';
  const noNotes = (end: EngineState) => {
    paidAtTurnEnd(end);
    expect(engineNotes(end)).toEqual([]);
  };
  scenarios([
    { name: 'Future Sight, with no note', party: () => [seer()], enemies: () => [magikarp21(), zigzagoon21()],
      steps: [enemyHp(1), [BOTH, 'turnChoice'], untilMagikarpFaints], lines: [exp(D, 684)],
      check: (end) => { expect(end.phase.kind).toBe('enemyReplacement'); noNotes(end); } },
    // playerMon reads the PP of the fixture's own moves, so Doom Desire's list is given whole.
    { name: 'Doom Desire', party: () => [seer({ moves: [DOOM_DESIRE, ID.growl], pp: [5, 40] })], enemies: () => [magikarp21(), zigzagoon21()],
      steps: [enemyHp(1), [BOTH, 'turnChoice'], untilMagikarpFaints], lines: [exp(D, 684)], check: paidAtTurnEnd },
    { name: 'Perish Song', party: () => [singer()], enemies: () => [magikarp21(), zigzagoon21()], steps: [[BOTH, 'turnChoice'], untilMagikarpFaints],
      lines: [exp(Z, 684)], check: paidAtTurnEnd },
    // A handler Showdown runs after the knock-out runs before the payout on both: it cannot change the EXP, so no note.
    { name: 'Perish Song with a handler after it (the enemy\'s Slow Start): still last, nothing noted', party: () => [singer()],
      enemies: () => [resolvedMon(ID.magikarp, 21, [ID.growl], { ability: knownAbility(ABILITY.slowStart) }), zigzagoon21()],
      steps: [[BOTH, 'turnChoice'], untilMagikarpFaints], lines: [exp(Z, 684)], check: noNotes },
    { name: 'Future Sight with a handler after it (the player\'s Slow Start): still last, nothing noted',
      party: () => [seer({ ability: knownAbility(ABILITY.slowStart) })], enemies: () => [magikarp21(), zigzagoon21()],
      steps: [enemyHp(1), [BOTH, 'turnChoice'], untilMagikarpFaints], lines: [exp(D, 684)], check: noNotes },
    { name: 'Perish Song double knock-out: the singer faints unpaid and uncounted; the benched participant gets 684',
      party: () => [monferno([ID.perishSong, ID.growl]), zig20()], enemies: () => [magikarp21()], steps: [OUT, BACK, [BOTH, 'turnChoice'], untilMagikarpFaints],
      lines: [exp('p1: Zigzagoon', 684)], check: (end) => expect(at(end, '|faint|p1a: Monferno')).toBeGreaterThan(-1) },
    { name: 'the same with a trainer\'s Pokémon to come: paid in that step, not held into the player\'s replacement',
      party: () => [monferno([ID.perishSong, ID.growl]), zig20()], enemies: () => [magikarp21(), zigzagoon21()], steps: [OUT, BACK, [BOTH, 'turnChoice'], untilMagikarpFaints],
      lines: [exp('p1: Zigzagoon', 684)], check: (end) => expect([end.phase.kind, json(end).formatData[EXP_PENDING_KEY]]).toEqual(['playerReplacement', undefined]) },
  ]);
});

describe('Micle Berry\'s end-of-turn check against a level-up in the end of turn', () => {
  // The cartridge checks the berry in its holder's own end-of-turn list (bcp:1362-1368, :1699-1709) and pays a poison
  // faint at the next loop's top (bcp:1295-1296): before the level-up when the holder's list runs first, after otherwise.
  // The sandstorm takes the holder to its line: Deoxys 50 at 51 HP to 41 <= 165 / 4 (at 51: 44 > 168 / 4); Machop 25 at
  // 23 to 19 <= 77 / 4 (at 26: 22 > 80 / 4). The poisoned Magikarp at 6 HP faints in its own list: 684 EXP.
  const sandy = (holder: PlayerMon, hp: number, enemy: ResolvedMon = resolvedMon(ID.magikarp, 21, [ID.growl]), enemyHpLeft = 6) =>
    edited(battle([holder], [enemy, zigzagoon21()], { weather: 'sand' }), (live) => {
      live.p1.active[0]!.hp = hp;
      live.p2.active[0]!.hp = enemyHpLeft;
      live.p2.active[0]!.setStatus('psn');
    });
  const holder = (id: number, level: number, expTotal: number) => playerMon(id, level, [ID.growl], { exp: expTotal, item: MICLE_BERRY, ability: knownAbility(SPEED_BOOST) });
  const fastHolder = () => holder(ID.deoxys, 50, SLOW[51] - 1);

  it('the holder\'s list runs first: the berry is eaten before the enemy\'s poison faint and the level-up', () => {
    const after = step(sandy(fastHolder(), 51), BOTH, 'enemyReplacement');
    expect(kaizo(after)).toEqual([exp(D, 684), lvl(D, 51)]);
    expect(at(after, '|-damage|p1a: Deoxys|41/165|[from] Sandstorm')).toBeGreaterThan(-1);
    before(after, '|-damage|p1a: Deoxys|41/165|[from] Sandstorm', '|-enditem|p1a: Deoxys|Micle Berry|[eat]', '|faint|p2a: Magikarp', '|-kaizoexp|');
    const live = restore(after).p1.active[0]!;
    expect([live.level, live.hp, live.maxhp, live.item, live.volatiles['micleberry'] !== undefined, unmodelledIn(after)]).toEqual([51, 44, 168, '', true, []]);
  });

  it('the enemy\'s list runs first: the level-up lifts the holder over its line, so the berry stays', () => {
    const after = step(sandy(holder(ID.machop, 25, MEDIUM_SLOW[26] - 1), 23), BOTH, 'enemyReplacement');
    expect(kaizo(after)).toContain(lvl('p1a: Machop', 26));
    expect(at(after, '|-damage|p1a: Machop|19/77|[from] Sandstorm')).toBeGreaterThan(-1);
    before(after, '|-damage|p1a: Machop|19/77|[from] Sandstorm', '|faint|p2a: Magikarp');
    expect(at(after, '|-enditem|p1a: Machop|')).toBe(-1);
    const live = restore(after).p1.active[0]!;
    expect([live.level, live.hp, live.maxhp, live.item, unmodelledIn(after)]).toEqual([26, 22, 80, 'micleberry', []]);
  });

  it('equal Speed: monSpeedOrder\'s draw decides it, 1/2 each way, each as on the cartridge', () => {
    // The trainer's poisoned Deoxys 50 (Oblivious) at 25 faints to sand and poison: 2731 EXP, level 51.
    const enemy = resolvedMon(ID.deoxys, 50, [ID.growl], { ability: knownAbility(ABILITY.oblivious) });
    const outcomes = expandTurn(sandy(fastHolder(), 51, enemy, 25), BOTH);
    const ate = outcomes.filter(({ log }) => log.includes('|-enditem|p1a: Deoxys|Micle Berry|[eat]'));
    const kept = outcomes.filter(({ log }) => !log.some((line) => line.startsWith('|-enditem|p1a: Deoxys|')));
    expect(ate.length + kept.length).toBe(outcomes.length);
    expect([cmp(sumOf(ate), rat(1, 2)), cmp(sumOf(kept), rat(1, 2))]).toEqual([0, 0]);
    for (const { log, state } of ate) {
      expect(log.indexOf('|-enditem|p1a: Deoxys|Micle Berry|[eat]')).toBeLessThan(log.findIndex((line) => line.startsWith('|-kaizoexp|')));
      expect(restore(state).p1.active[0]!.item).toBe('');
    }
    for (const { log, state } of kept) {
      expect(log).toContain(lvl(D, 51));
      expect(restore(state).p1.active[0]!.item).toBe('micleberry');
    }
  });
});

describe('Pursuit\'s field-condition subtraction ("Acid Rain", subscript_pursuit.s:115)', () => {
  // After the payout the script subtracts the fainted battler (the enemy's is 1) from the field-condition mask (weathers,
  // Uproar, Gravity, the deep fog, Trick Room): the engine notes it whenever that mask is not 0.
  const PURSUE: Choices = { p1: move(0), p2: to(1) };
  const pursuitBattle = (field: FieldSpec = {}, enemies = () => [magikarp21(), deoxys50()]) => battle([monferno([ID.pursuit]), zig20()], enemies(), field);
  const faints = (line: string) => (state: EngineState) => expect(at(state, line)).toBeGreaterThan(-1);

  it.each<[string, () => EngineState, Choices, (state: EngineState) => void, boolean]>([
    ['the player\'s Pursuit KOs a switching enemy in the permanent sandstorm', () => pursuitBattle({ weather: 'sand' }), PURSUE, faints('|faint|p2a: Magikarp'), true],
    ['the same under Trick Room', () => pursuitBattle({ trickRoom: true }), PURSUE, faints('|faint|p2a: Magikarp'), true],
    ['the same under Gravity', () => pursuitBattle({ gravity: true }), PURSUE, faints('|faint|p2a: Magikarp'), true],
    ['the same under the deep fog', () => pursuitBattle({ fog: true }), PURSUE, faints('|faint|p2a: Magikarp'), true],
    ['the same on the enemy\'s U-turn, as it leaves (subscript_attack_then_switch_out.s:54)',
      () => enemyHp(1)(pursuitBattle({ weather: 'sand' }, () => [resolvedMon(ID.deoxys, 50, [ID.uTurn]), magikarp21()])), BOTH, faints('|faint|p2a: Deoxys'), true],
    ['with no field condition (0 - 1 stays 0)', () => pursuitBattle(), PURSUE, faints('|faint|p2a: Magikarp'), false],
    ['the trainer\'s Pursuit KOs the player\'s switching Pokémon (battler 0)',
      () => battle([playerMon(ID.zigzagoon, 5, [ID.growl]), monferno([ID.growl])], [resolvedMon(ID.deoxys, 50, [ID.pursuit])], { weather: 'sand' }), { p1: to(1), p2: move(0) },
      faints('|faint|p1a: Zigzagoon'), false],
    ['the switching enemy survives the Pursuit (subscript_pursuit.s:39)', () => pursuitBattle({ weather: 'sand' }, () => [deoxys50(), magikarp21()]), PURSUE,
      (state) => expect(at(state, '|faint|')).toBe(-1), false],
  ])('%s', (_, start, choices, check, noted) => {
    const state = start();
    expect(unmodelledIn(state)).not.toContain(PURSUIT_FIELD_NOTE);
    const after = step(state, choices);
    check(after);
    expect(unmodelledIn(after).includes(PURSUIT_FIELD_NOTE)).toBe(noted);
  });

  it('an Uproar going counts as a field condition (no single battle can reach that knock-out, so the check is tested alone)', () => {
    const live = restore(pursuitBattle());
    expect(fieldConditionsUp(live)).toBe(false);
    live.p2.active[0]!.addVolatile('uproar');
    expect(fieldConditionsUp(live)).toBe(true);
  });
});

describe('the participant mask', () => {
  const switched = () => restore(step(battle([deoxys(), zig20()], [zigzagoon21(), magikarp21()]), { p1: to(1), p2: move(0) }, 'turnChoice'));

  it('a switch-in that fails sets no bit and resets no mask', () => {
    const live = switched();
    expect(livingOnly(live, live.formatData[EXP_MASK_KEY] as number)).toBe(0b11);
    expect([live.actions.switchIn(live.p2.active[0]!, 0), live.actions.switchIn(live.p1.active[0]!, 0)]).toEqual([false, false]); // already in
    expect(live.formatData[EXP_MASK_KEY]).toBe(0b11);
  });

  it('expMask never counts a Pokémon at 0 HP, fainted or not yet; a send-out adds nothing while the enemy is at 0 HP (bl:1469)', () => {
    const live = switched();
    expect(expMask(live)).toBe(0b11);
    const bench = live.p1.pokemon.find((pokemon) => !pokemon.isActive)!;
    bench.hp = 0;
    expect(expMask(live)).toBe(0b10);
    live.formatData[EXP_MASK_KEY] = 0b10;
    bench.hp = 10;
    live.p2.active[0]!.hp = 0;
    noteSendOut(live, bench);
    expect(live.formatData[EXP_MASK_KEY]).toBe(0b10);
  });

  it('both sides switch in one turn: a faster enemy sends out first, mask {old, new}; a faster player, {new} (bcp:772-784)', () => {
    const slow = battle([monferno([ID.growl]), zig20()], [deoxys50(), zigzagoon21()]);
    const fast = battle([deoxys(), zig20()], [magikarp21(), zigzagoon21()]);
    expect([slow, fast].map((state) => participants(step(state, { p1: to(1), p2: to(1) }, 'turnChoice')))).toEqual([[0, 1], [1]]);
  });
});

/**
 * Every pair of steps from `state`: `first`, then each side's first legal choice from each leaf that stops for one. The
 * second step runs on a restore of the leaf's snapshot and on the live battle that made it: each pair's keys and logs.
 */
function liveAndRestored(state: EngineState, first: Choices): { keys: [string, string]; logs: [string[], string[]] }[] {
  const pairs: { keys: [string, string]; logs: [string[], string[]] }[] = [];
  const clean = (log: readonly string[]) => log.filter((line) => !line.startsWith('|t:|'));
  for (let script: number[] | null = []; script !== null;) {
    const driver = new ChanceDriver(script);
    const live = restore(state, driver);
    applyChoices(live, first);
    const mid = snapshot(live);
    script = nextScript(driver.points);
    if (mid.phase.kind === 'terminal') continue;
    const choices: Choices = {};
    for (const side of ['p1', 'p2'] as const) {
      const choice = choicesIn(live, side)[0];
      if (choice !== undefined) choices[side] = choice;
    }
    for (let second: number[] | null = []; second !== null;) {
      const restoredDriver = new ChanceDriver(second);
      const restored = restore(mid, restoredDriver);
      applyChoices(restored, choices);
      const again = restore(state, new ChanceDriver([...driver.points, ...restoredDriver.points].map((point) => point.chosen)));
      applyChoices(again, first);
      const cut = again.log.length;
      applyChoices(again, choices);
      const logs: [string[], string[]] = [clean(again.log.slice(cut)), clean(restored.log)];
      pairs.push({ keys: [snapshot(again).key, snapshot(restored).key], logs });
      second = nextScript(restoredDriver.points);
    }
  }
  expect(pairs.length).toBeGreaterThan(0);
  return pairs;
}

describe('properties', () => {
  // Monferno 1 EXP short of 31 and Zigzagoon 1 short of 21, against three.
  const shortOfALevel = () => battle(
    [nearly31([ID.plainHit, ID.uTurn, ID.growl]), playerMon(ID.zigzagoon, 20, [ID.plainHit], { exp: MEDIUM_FAST[21] - 1 })],
    [magikarp21(), zigzagoon21(), resolvedMon(ID.machop, 22, [ID.plainHit])],
  );

  it('probabilities sum to exactly one at every step of a walk with payouts, level-ups and a U-turn', () => {
    let state = shortOfALevel();
    for (const choices of [BOTH, { p2: to(1) }, { p1: move(1), p2: move(0) }]) {
      const outcomes = expandTurn(state, choices);
      expect(sumOf(outcomes)).toEqual(ONE);
      state = outcomes.reduce((best, outcome) => (cmp(outcome.probability, best.probability) > 0 ? outcome : best)).state;
    }
  });

  it('a snapshot restore continues as the live battle does across a payout and a level-up, on every chance path', () => {
    for (const { keys, logs } of liveAndRestored(shortOfALevel(), BOTH)) {
      expect(keys[1]).toBe(keys[0]);
      expect(logs[1]).toEqual(logs[0]);
    }
  });

  it('the knock-out roll merge stays exact: the same outcomes as one leaf per roll (key, critBy, observation)', () => {
    const view = (outcomes: readonly Outcome[]) => new Map(outcomes.map((outcome) => [`${outcome.state.key}|${JSON.stringify(outcome.critBy)}|${outcome.observation}`, outcome.probability]));
    const state = shortOfALevel();
    expect(view(expandTurn(state, BOTH))).toEqual(view(expandTurn(state, BOTH, { collapse: false })));
  });

  it('EXP adds no chance: a knock-out step\'s probabilities are the same whether or not it levels the Pokémon', () => {
    const probabilities = (expTotal: number) => expandTurn(battle([monferno([ID.plainHit], { exp: expTotal })], [magikarp21(), zigzagoon21()]), BOTH)
      .map((outcome) => `${outcome.probability.num}/${outcome.probability.den}`).sort();
    expect(probabilities(MEDIUM_SLOW[31] - 1)).toEqual(probabilities(MEDIUM_SLOW[30]));
  });
});
