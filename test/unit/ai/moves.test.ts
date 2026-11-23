// The move choice: moveDistribution and slotScores, the ports of TrainerAI_Main and TrainerAI_MainSingles over
// TrainerAI_EvalMoves (trainer_ai.c:258–343, 483–526), on the fixture's Garchomp against Luxray (HP 155).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rational } from '../../../src/contracts/engine.js';
import { fastMoveDistribution, moveDistribution, type SlotDist, slotScores, slowMoveDistribution } from '../../../src/ai/choose/moves.js';
import {
  AI_BATTLER_ATTACKER, AI_BATTLER_DEFENDER, AI_FLAG_BASIC, AI_MOVE_IS_HIGHEST_DAMAGE, BATTLE_TYPE_DOUBLES,
  BATTLE_TYPE_ROAMER, BATTLE_TYPE_TRAINER, COMPARE_SPEED_FASTER, COMPARE_SPEED_SLOWER, MOVE_GYRO_BALL, ROLL_FOR_DAMAGE,
  USE_MAX_DAMAGE,
} from '../../../src/ai/constants.js';
import { PATHS } from '../../../src/ai/lib/known.js';
import { add, mul, ONE, rat, residueWeights, sum } from '../../../src/ai/odds.js';
import type { AiScript } from '../../../src/ai/rom/script.js';
import { runScript } from '../../../src/ai/script/run.js';
import type { AiDeps, AiView } from '../../../src/ai/view.js';
import { assemble } from './asm.js';
import { emptyKnowledge, FX, fixtureDeps, fixtureView } from './fixtures.js';
import { AI, aiKnows, codeOf, gyroDeps, mon, PLAYER, playerAt } from './opsHarness.js';

// runScript as it is, watched: the startSpeeds tests read the inputs moves.ts hands it.
vi.mock('../../../src/ai/script/run.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/ai/script/run.js')>();
  return { ...real, runScript: vi.fn(real.runScript) };
});

beforeEach(() => {
  vi.mocked(runScript).mockClear();
});

const M = FX.move;
const ROLL = ROLL_FOR_DAMAGE;
const MAX = USE_MAX_DAMAGE;

const of65536 = (n: bigint | number): Rational => rat(n, 65536);
/** `v` with the view-gap list naming its monSpeedValues as unknown. */
const speedsUnknown = (v: AiView): AiView => Object.assign(v, { unknown: [PATHS.monSpeedValues] });
/** Each runScript call since the last clear: the flag entry, the slot and the startSpeeds it was handed. */
const runCalls = () => vi.mocked(runScript).mock.calls.map(([entry, input]) => ({ entry, slot: input.slot, startSpeeds: input.startSpeeds }));

/**
 * The fixture deps (or `base`) running `src` with `Terminate: PopOrEnd` appended. `entries` maps a flag bit to the label
 * it starts at; every other bit starts at Terminate, as script.s points the unused bits (script.s:30–47). `aiFlags`
 * defaults to the bits `entries` names.
 */
function depsFor(src: string, entries: Record<number, string>, aiFlags?: number, base: AiDeps = fixtureDeps()): AiDeps {
  const { words, labels } = assemble(`${src}\nTerminate: PopOrEnd`);
  const flagEntries = Array<number>(32).fill(labels.Terminate!);
  let flags = 0;
  for (const [bit, label] of Object.entries(entries)) {
    if (labels[label] === undefined) throw new Error(`no label ${label}`);
    flagEntries[Number(bit)] = labels[label];
    flags |= 1 << Number(bit);
  }
  const script: AiScript = { words, flagEntries, sha256: '' };
  return { ...base, script, aiFlags: aiFlags ?? flags };
}

/** `dist` as key → probability, after checking its shape: ascending keys, each above 0, summing to ONE. */
function byKey<T extends { probability: Rational }>(dist: T[], key: (entry: T) => number): Record<number, Rational> {
  expect(sum(dist.map((entry) => entry.probability))).toEqual(ONE);
  const keys = dist.map(key);
  expect(keys).toEqual([...new Set(keys)].sort((a, b) => a - b));
  expect(dist.every((entry) => entry.probability.num > 0n)).toBe(true);
  return Object.fromEntries(dist.map((entry) => [key(entry), entry.probability]));
}
const shape = (dist: SlotDist[]) => byKey(dist, (entry) => entry.slot);
const scoresOf = (v: AiView, d: AiDeps, slot: number) => byKey(slotScores(v, d, emptyKnowledge(), slot), (entry) => entry.score);

/**
 * The decision from what the AI knows at battle start, as slot → probability, and whether the fast path ran (it is null
 * when a run read incoming state). Checks the slow, flag-major path, the fast one when it ran, and moveDistribution agree.
 */
function decide(v: AiView, d: AiDeps, message?: string): { picks: Record<number, Rational>; fast: boolean } {
  const k = emptyKnowledge();
  const slow = slowMoveDistribution(v, d, k);
  const fast = fastMoveDistribution(v, d, k);
  if (fast !== null) expect(fast, message).toEqual(slow);
  expect(moveDistribution(v, d, k), message).toEqual(slow);
  return { picks: shape(slow), fast: fast !== null };
}

/** Adds `n` to the score of the slot whose move is `move`. */
const bonusFor = (move: number, n: number) => `Main: IfMoveEqualTo ${move}, Bonus\nPopOrEnd\nBonus: AddToMoveScore ${n}\nPopOrEnd`;

describe('the tie-break and the flags', () => {
  const two = () => aiKnows([M.DRAGON_CLAW, M.EARTHQUAKE, 0, 0]);
  const main = (src: string) => depsFor(src, { 0: 'Main' });
  const minus100 = main('Main: AddToMoveScore -100\nPopOrEnd');
  const randomBonus = main(`Main: IfMoveNotEqualTo ${M.DRAGON_CLAW}, Done\nIfRandomLessThan 80, Bonus\nDone: PopOrEnd\nBonus: AddToMoveScore 1\nPopOrEnd`);
  const roam = `${bonusFor(M.DRAGON_CLAW, 5)}\nRoam: IfMoveEqualTo ${M.EARTHQUAKE}, RoamBonus\nPopOrEnd\nRoamBonus: AddToMoveScore 5\nPopOrEnd`;
  const roamer = depsFor(roam, { 0: 'Main', 29: 'Roam' }, AI_FLAG_BASIC);
  // Each row: the decision's picks, and optionally one slot's scores.
  it.each<[string, AiView, AiDeps, Record<number, Rational>, [number, Record<number, Rational>]?]>([
    // Plain 100s (trainer_ai.c:225) tie, the pick is RandNext() % n over the candidates (:338), and a slot with no move
    // is no candidate (:322) unless it is slot 0, which starts the list (:317–319) and scores 0 (:236–237, 503).
    ['plain 100s split three ways', aiKnows([M.DRAGON_CLAW, M.EARTHQUAKE, M.CRUNCH, 0]), fixtureDeps(),
      { 0: of65536(21846), 1: of65536(21845), 2: of65536(21845) }],
    ['one move is the only candidate', aiKnows([M.DRAGON_CLAW, 0, 0, 0]), fixtureDeps(), { 0: ONE }],
    ['a larger score resets the list', two(), main(bonusFor(M.DRAGON_CLAW, -100)), { 1: ONE }], // :330–334
    ['an empty slot 0 ties a slot at 0', aiKnows([0, M.EARTHQUAKE, 0, 0]), minus100, { 0: of65536(32768), 1: of65536(32768) }],
    ['an empty slot 0 loses to a slot above 0', aiKnows([0, M.EARTHQUAKE, 0, 0]), fixtureDeps(), { 1: ONE }],
    // +1 on RandNext() % 256 < 80 (:535) wins alone; otherwise slots 0 and 1 tie.
    ['random bonus', two(), randomBonus, { 0: rat(168, 256), 1: rat(88, 256) }, [0, { 100: rat(176, 256), 101: rat(80, 256) }]],
    // 100 + 28 stores -128 in the s8 moveScore, clamped to 0 (:581–585).
    ['wrap loses', two(), main(bonusFor(M.DRAGON_CLAW, 28)), { 1: ONE }, [0, { 0: ONE }]],
    // A slot with no PP starts at 0 and never runs (:234–238, 490–504), but the tie-break ignores PP (:322).
    ['a zero-PP slot can win a tie', aiKnows([M.DRAGON_CLAW, M.EARTHQUAKE, M.CRUNCH, M.FIRE_FANG], [15, 10, 0, 15]), minus100,
      Object.fromEntries(residueWeights(4).map((weight, slot) => [slot, of65536(weight)])), [2, { 0: ONE }]],
    // A Disabled slot is invalid (battle_lib.c:2270–2273), so it starts at 0 (trainer_ai.c:236–237).
    ['a Disabled slot starts at 0', mon(AI, { effects: { disabledMove: M.EARTHQUAKE, disabledTurns: 3 } }, two()),
      main(bonusFor(M.EARTHQUAKE, 5)), { 0: ONE }, [1, { 5: ONE }]],
    // With aiMask 0 the flag loop never runs (:297): the rest stay at 100.
    ['no flags leave the starting scores', mon(AI, { effects: { disabledMove: M.EARTHQUAKE } }), { ...fixtureDeps(), aiFlags: 0 },
      { 0: of65536(21846), 2: of65536(21845), 3: of65536(21845) }],
    // thinkingMask shifts right per flag (trainer_ai.c:297–309): bit 0 leaves slot 3's Fire Fang in calcTemp, and bit
    // 31's slot 0 reads it.
    ['flags run in ascending bit order, up to bit 31', fixtureView(), depsFor(
      `Load: LoadCurrentMove\nPopOrEnd\nRead: IfLoadedEqualTo ${M.FIRE_FANG}, Bonus\nPopOrEnd\nBonus: AddToMoveScore 5\nLoadTurnCount\nPopOrEnd`,
      { 0: 'Load', 31: 'Read' },
    ), { 0: ONE }],
    // A roamer battle thinks with AI_FLAG_ROAMING_POKEMON (bit 29) alone, whatever the aiMask (:246–247).
    ['a trainer ignores the roamer flag', fixtureView(), roamer, { 0: ONE }],
    ['a roamer thinks with the roamer flag alone', fixtureView({ battleType: BATTLE_TYPE_ROAMER }), roamer, { 1: ONE }],
    // The player's last move is recorded before any flag runs (:295), so IfMoveKnown sees Spark with empty knowledge.
    ["the player's last move is recorded first", fixtureView({ movePrevByBattler: [M.SPARK, 0, 0, 0] }), depsFor(
      `Main: IfMoveNotEqualTo ${M.DRAGON_CLAW}, Done\nIfMoveKnown ${AI_BATTLER_DEFENDER}, ${M.SPARK}, Bonus\nDone: PopOrEnd\nBonus: AddToMoveScore 1\nPopOrEnd`,
      { 0: 'Main' },
    ), { 0: ONE }],
  ])('%s', (_, v, d, picks, scores) => {
    expect(decide(v, d).picks).toEqual(picks);
    if (scores) expect(scoresOf(v, d, scores[0])).toEqual(scores[1]);
  });

  it('two flags add', () => {
    // Bits 0 and 1 each add 1 on half the draws (trainer_ai.c:535), into the same moveScore.
    const d = depsFor('Coin: IfRandomLessThan 128, Plus\nPopOrEnd\nPlus: AddToMoveScore 1\nPopOrEnd', { 0: 'Coin', 1: 'Coin' });
    expect(scoresOf(fixtureView(), d, 0)).toEqual({ 100: rat(1, 4), 101: rat(1, 2), 102: rat(1, 4) });
    expect(decide(fixtureView(), d).fast).toBe(true);
  });
});

describe('state carried between runs', () => {
  // Gyro Ball's power is 1 + 25 * monSpeedValues[defender] / monSpeedValues[attacker] (trainer_ai.c:2996), which
  // BattleSystem_CompareBattlerSpeed writes (battle_lib.c:1372–1373): [90, 122] estimate 7, [244, 122] 18 (opsCalc).
  const COMPARE = `Compare: IfSpeedCompareEqualTo ${COMPARE_SPEED_FASTER}, Done\nDone: PopOrEnd`;
  const GYRO = `${COMPARE}\nGyro: IfCurrentMoveKills ${MAX}, Bonus\nPopOrEnd\nBonus: AddToMoveScore 5\nPopOrEnd`;
  const gyroFlags = (entries: Record<number, string>, src = GYRO) => depsFor(src, entries, undefined, gyroDeps());
  /** Gyro Ball (5 PP) and Protect against the player at `curHP`, from `v`'s monSpeedValues. */
  const gyroView = (curHP: number, v = fixtureView()) => playerAt(curHP, aiKnows([MOVE_GYRO_BALL, M.PROTECT, 0, 0], [5, 10, 0, 0], v));

  it('calcTemp starts the decision at 0', () => {
    // TrainerAI_Init zeroes AIContext up to battlerMoves, calcTemp included (trainer_ai.c:217–221, ai_context.h:16):
    // slot 0 reads 0 and gets +5, then loads Dragon Claw, which slots 1–3 read.
    const d = depsFor('Main: IfLoadedEqualTo 0, Bonus\nPopOrEnd\nBonus: AddToMoveScore 5\nLoadCurrentMove\nPopOrEnd', { 0: 'Main' });
    expect(decide(fixtureView(), d)).toEqual({ picks: { 0: ONE }, fast: false });
  });

  it('stale temp forces flag-major', () => {
    // calcTemp is not reset between runs (trainer_ai.c:297–309, 483–526). Bit 0 loads the turn count (0) or the slot's
    // move on a coin, so bit 1 meets slot 3's Fire Fang half the time: then slot 0 gets +5 and wins alone, else it loads
    // 0 and the four tie at 100.
    const src = [
      'Load: IfRandomLessThan 128, Turn', 'LoadCurrentMove', 'PopOrEnd', 'Turn: LoadTurnCount', 'PopOrEnd',
      `Stale: IfLoadedEqualTo ${M.FIRE_FANG}, Bonus`, 'PopOrEnd', 'Bonus: AddToMoveScore 5', 'LoadTurnCount', 'PopOrEnd',
    ].join('\n');
    const d = depsFor(src, { 0: 'Load', 1: 'Stale' });
    expect(decide(fixtureView(), d)).toEqual({ picks: { 0: rat(5, 8), 1: rat(1, 8), 2: rat(1, 8), 3: rat(1, 8) }, fast: false });
    expect(scoresOf(fixtureView(), d, 0)).toEqual({ 100: rat(1, 2), 105: rat(1, 2) });
  });

  it('Gyro Ball after a speed compare in an earlier flag reads the carried speeds', () => {
    // The view's stale [244, 122] kill 18 HP; bit 0's compare writes [90, 122] first, so slot 0 ties Protect, on the
    // slow path. Without the compare the view's values stand (battleCtx is not reset per decision), and the fast path
    // keeps the read.
    const v = gyroView(18, fixtureView({ monSpeedValues: [244, 122, 0, 0] }));
    expect(decide(v, gyroFlags({ 0: 'Compare', 1: 'Gyro' }))).toEqual({ picks: { 0: of65536(32768), 1: of65536(32768) }, fast: false });
    expect(decide(v, gyroFlags({ 1: 'Gyro' }))).toEqual({ picks: { 0: ONE }, fast: true });
  });

  it('Gyro Ball after compares that write the view speeds stays on the fast path', () => {
    // The fixture's monSpeedValues are what the compare (bit 0) and LoadBattlerSpeedRank (bit 1) write, so Gyro Ball
    // (bit 2) kills 7 HP: slot 0 always gets +5, Protect on half the draws.
    const src = [
      COMPARE, `Rank: LoadBattlerSpeedRank ${AI_BATTLER_ATTACKER}`, 'PopOrEnd',
      `Gyro: IfCurrentMoveKills ${MAX}, Bonus`, 'IfRandomLessThan 128, Bonus', 'PopOrEnd', 'Bonus: AddToMoveScore 5', 'PopOrEnd',
    ].join('\n');
    const v = gyroView(7);
    const d = gyroFlags({ 0: 'Compare', 1: 'Rank', 2: 'Gyro' }, src);
    expect(decide(v, d)).toEqual({ picks: { 0: rat(3, 4), 1: rat(1, 4) }, fast: true });
    // The fast path hands every run the decision-start values.
    vi.mocked(runScript).mockClear();
    fastMoveDistribution(v, d, emptyKnowledge());
    expect(runCalls().length).toBeGreaterThan(0);
    expect(runCalls().every((call) => call.startSpeeds)).toBe(true);
  });

  it('startSpeeds turns false on the slow path once a compare has written', () => {
    // With the view's speeds unknown, the read takes the slow path. Bit 0's slot 0 runs first, from the view's values;
    // its compare writes, so every later run is handed written values.
    const v = speedsUnknown(gyroView(7));
    const d = gyroFlags({ 0: 'Compare', 1: 'Gyro' });
    expect(fastMoveDistribution(v, d, emptyKnowledge())).toBeNull();
    vi.mocked(runScript).mockClear();
    expect(shape(slowMoveDistribution(v, d, emptyKnowledge()))).toEqual({ 0: ONE });
    const [compare, gyro] = [d.script.flagEntries[0]!, d.script.flagEntries[1]!];
    const calls = runCalls();
    expect(calls.filter((call) => call.entry === compare && call.slot === 0).every((call) => call.startSpeeds)).toBe(true);
    const later = calls.filter((call) => call.slot === 1 || call.entry === gyro);
    expect(later.length).toBeGreaterThanOrEqual(3);
    expect(later.every((call) => !call.startSpeeds)).toBe(true);
    // Without the compare every run gets the start values: known, Gyro Ball reads them; unknown, its read stops the
    // decision (run.ts's view-gap check).
    const noCompare = gyroFlags({ 1: 'Gyro' });
    vi.mocked(runScript).mockClear();
    shape(slowMoveDistribution(gyroView(7), noCompare, emptyKnowledge()));
    expect(runCalls().length).toBeGreaterThanOrEqual(2);
    expect(runCalls().every((call) => call.startSpeeds)).toBe(true);
    vi.mocked(runScript).mockClear();
    expect(codeOf(() => slowMoveDistribution(v, noCompare, emptyKnowledge()))).toBe('UNDEFINED');
    expect(runCalls().every((call) => call.startSpeeds)).toBe(true);
  });

  it('unknown speeds that no run reads keep the fast path', () => {
    expect(decide(speedsUnknown(fixtureView()), depsFor(COMPARE, { 0: 'Compare' })).fast).toBe(true);
  });

  it('a run that fails on stale state takes the slow path', () => {
    // With monSpeedValues[1] at 0, Gyro Ball's estimate from the view divides by zero (trainer_ai.c:2996), which the
    // fast path meets before it can report its read; in cartridge order the compare writes [90, 122] first, so slot 0
    // ties. Without the compare the division by zero is real.
    const v = gyroView(18, fixtureView({ monSpeedValues: [90, 0, 0, 0] }));
    const d = gyroFlags({ 0: 'Compare', 1: 'Gyro' });
    expect(decide(v, d)).toEqual({ picks: { 0: of65536(32768), 1: of65536(32768) }, fast: false });
    expect(scoresOf(v, d, 0)).toEqual({ 100: ONE });
    const gyroOnly = gyroFlags({ 1: 'Gyro' });
    expect(codeOf(() => moveDistribution(v, gyroOnly, emptyKnowledge()))).toBe('DIV_ZERO');
    expect(codeOf(() => slotScores(v, gyroOnly, emptyKnowledge(), 0))).toBe('DIV_ZERO');
  });
});

describe('latents', () => {
  const KILL_ROLL = `Kill: IfCurrentMoveKills ${ROLL}, Plus\nPopOrEnd\nPlus: AddToMoveScore 1\nPopOrEnd`;

  it('correlated roll across flags', () => {
    // moveDamageRolls[moveSlot] is drawn once per decision (trainer_ai.c:240, 1534): both flags add 1 together on the 5
    // of 16 rolls that kill 78 HP (opsCalc). Protect is not estimated (:1553–1554), so it stays at 100.
    const v = playerAt(78, aiKnows([M.DRAGON_CLAW, M.PROTECT, 0, 0], [15, 10, 0, 0]));
    const d = depsFor(KILL_ROLL, { 0: 'Kill', 1: 'Kill' });
    expect(scoresOf(v, d, 0)).toEqual({ 100: rat(11, 16), 102: rat(5, 16) });
    expect(decide(v, d)).toEqual({ picks: { 0: add(rat(5, 16), rat(11, 32)), 1: rat(11, 32) }, fast: true });
  });

  it('a Quick Claw draw is shared by every slot that reads it', () => {
    // The player's Quick Claw fires on 13108 of 65536 (battle_lib.c:1345), and then the AI is slower (:1408–1409): slots
    // 0 and 1 both get +1 and tie; otherwise slots 0–2 tie at 100. Crunch never reads it.
    const v = mon(PLAYER, { heldItem: FX.item.QUICK_CLAW }, aiKnows([M.DRAGON_CLAW, M.EARTHQUAKE, M.CRUNCH, 0]));
    const src = `Main: IfMoveEqualTo ${M.CRUNCH}, Done\nIfSpeedCompareEqualTo ${COMPARE_SPEED_SLOWER}, Bonus\nDone: PopOrEnd\nBonus: AddToMoveScore 1\nPopOrEnd`;
    const d = depsFor(src, { 0: 'Main' });
    const [fires, misses] = [of65536(13108), of65536(65536 - 13108)];
    expect(decide(v, d)).toEqual({
      picks: {
        0: add(mul(fires, rat(1, 2)), mul(misses, of65536(21846))),
        1: add(mul(fires, rat(1, 2)), mul(misses, of65536(21845))),
        2: mul(misses, of65536(21845)),
      },
      fast: true,
    });
    expect(scoresOf(v, d, 0)).toEqual({ 100: misses, 101: fires });
  });

  it('a roll two slots share keeps the fast path equal to the slow one', () => {
    // FlagMoveDamageScore with ROLL_FOR_DAMAGE estimates every slot with that slot's roll (trainer_ai.c:1037–1050,
    // 2829–2833), so both slots read rolls 0 and 1. Dragon Claw (82 at the top roll) against Crunch made 115 power (79):
    // bit 0 adds 1 to the highest (a tie counts, :1052–1056), bit 1 adds 1 to Dragon Claw. Slot 1 wins half of "Crunch
    // strictly higher", which is slot 0's chance of 101, not the product of the two slots' chances.
    const base = fixtureDeps();
    base.moves[M.CRUNCH] = { ...base.moves[M.CRUNCH]!, power: 115 };
    const src = [
      `Dmg: FlagMoveDamageScore ${ROLL}`, `IfLoadedEqualTo ${AI_MOVE_IS_HIGHEST_DAMAGE}, Hi`, 'PopOrEnd',
      'Hi: AddToMoveScore 1', 'PopOrEnd',
      `Bonus: IfMoveEqualTo ${M.DRAGON_CLAW}, Plus`, 'PopOrEnd', 'Plus: AddToMoveScore 1', 'PopOrEnd',
    ].join('\n');
    const d = depsFor(src, { 0: 'Dmg', 1: 'Bonus' }, undefined, base);
    const v = aiKnows([M.DRAGON_CLAW, M.CRUNCH, 0, 0]);
    const { picks, fast } = decide(v, d);
    expect(fast).toBe(true);
    const s0 = scoresOf(v, d, 0);
    const s1 = scoresOf(v, d, 1);
    expect([Object.keys(s0), Object.keys(s1)]).toEqual([['101', '102'], ['100', '101']]);
    expect(picks[1]).toEqual(mul(s0[101]!, rat(1, 2)));
    expect(picks[1]).not.toEqual(mul(mul(s0[101]!, s1[101]!), rat(1, 2)));
  });

  it('more than 4096 latent assignments throw LIMIT', () => {
    // Each slot's kill check fixes its own roll: four rolls are 16^4 assignments, three are 4096 (allowed).
    const d = depsFor(KILL_ROLL, { 0: 'Kill' });
    expect(codeOf(() => moveDistribution(playerAt(78), d, emptyKnowledge()))).toBe('LIMIT');
    shape(moveDistribution(playerAt(78, aiKnows([M.DRAGON_CLAW, M.EARTHQUAKE, M.CRUNCH, M.PROTECT])), d, emptyKnowledge()));
  });
});

it('Escape and double battles throw, the latter even with no flags', () => {
  expect(codeOf(() => moveDistribution(fixtureView(), depsFor('Main: Escape', { 0: 'Main' }), emptyKnowledge()))).toBe('ESCAPE');
  const doubles = fixtureView({ battleType: BATTLE_TYPE_TRAINER | BATTLE_TYPE_DOUBLES });
  expect(codeOf(() => moveDistribution(doubles, { ...fixtureDeps(), aiFlags: 0 }, emptyKnowledge()))).toBe('UNSUPPORTED');
});

/** mulberry32: the seeded generator behind the random scripts. `next(n)` is an integer in 0..n - 1. */
function seeded(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

const POOL = [M.DRAGON_CLAW, M.EARTHQUAKE, M.CRUNCH, M.FIRE_FANG, M.PROTECT, MOVE_GYRO_BALL, M.TACKLE, 0];
const LOADS = ['LoadCurrentMove', 'LoadMovePower', 'LoadTurnCount', 'LoadTypeFrom 0', 'LoadTypeFrom 1', 'LoadTypeFrom 4'];
const LOADED = [0, 1, 4, 16, 80, 100, M.DRAGON_CLAW, M.FIRE_FANG];
const COMPARISONS = ['LessThan', 'GreaterThan', 'EqualTo', 'NotEqualTo'];

/**
 * One flag's random script at label `F<f>`: 2–5 forward-jumping commands, then PopOrEnd. Unless `stale`, it opens with a
 * load, so it never reads the calcTemp it was handed. At most two commands draw, and a draw's jump skips the score
 * change after it.
 */
function randomFlag(next: (n: number) => number, f: number, stale: boolean): string[] {
  const n = 2 + next(4);
  const at = (i: number) => `F${f}_${i}`;
  // Mostly a short jump, past one or two commands, so a branch often skips a score change.
  const later = (i: number) => at(next(4) === 0 ? i + 1 + next(n - i) : Math.min(n, i + 2 + next(2)));
  const lines = [stale ? `F${f}:` : `F${f}: ${LOADS[next(LOADS.length)]}`];
  let draws = 0;
  let afterRandom = false;
  for (let i = 0; i < n; i++) {
    let kind: number = afterRandom ? 3 : next(16);
    const draws1 = kind <= 2 || kind === 13 || kind === 14;
    if (draws1 && draws === 2) kind = 3;
    else if (draws1) draws++;
    afterRandom = kind <= 2;
    const cmp = COMPARISONS[next(COMPARISONS.length)]!;
    let command: string;
    if (kind <= 2) command = `IfRandom${cmp} ${next(256)}, ${at(Math.min(n, i + 2))}`;
    else if (kind <= 6) command = `AddToMoveScore ${next(21) - 10}`;
    else if (kind === 7) command = `IfHPPercent${cmp} ${next(2)}, ${next(101)}, ${later(i)}`;
    else if (kind === 8) command = `IfCurrentMoveKills ${MAX}, ${later(i)}`;
    else if (kind === 9) command = LOADS[next(LOADS.length)]!;
    else if (kind <= 11) command = `IfLoaded${cmp} ${LOADED[next(LOADED.length)]}, ${later(i)}`;
    else if (kind === 12) command = `IfMove${next(2) === 0 ? 'EqualTo' : 'NotEqualTo'} ${POOL[next(POOL.length - 1)]}, ${later(i)}`;
    else if (kind <= 14) command = `IfSpeedCompareEqualTo ${next(3)}, ${later(i)}`;
    else command = `AddToMoveScore ${next(2) === 0 ? 28 : -100}`;
    lines.push(`${at(i)}: ${command}`);
  }
  lines.push(`${at(n)}: PopOrEnd`);
  return lines;
}

/**
 * A random decision: a random moveset (Gyro Ball, empty slots, 0 PP, a Disabled move), HP, Quick Claws, a speed tie,
 * view speeds unlike those a compare writes, and 1–3 flags among bits 0–10. One case in five may read a stale calcTemp.
 */
function randomCase(seed: number): { v: AiView; d: AiDeps; src: string } {
  const next = seeded(seed);
  const moves = [0, 1, 2, 3].map(() => POOL[next(POOL.length)]!);
  const v = aiKnows(moves, moves.map((move) => (move === 0 || next(8) === 0 ? 0 : 10)));
  v.mons[PLAYER].curHP = 1 + next(155);
  v.mons[AI].curHP = 1 + next(183);
  if (next(3) === 0) v.mons[PLAYER].heldItem = FX.item.QUICK_CLAW;
  if (next(4) === 0) v.mons[AI].heldItem = FX.item.QUICK_CLAW;
  if (next(4) === 0) v.mons[PLAYER].speed = v.mons[AI].speed;
  if (next(5) === 0) v.monSpeedValues = [244, 122, 0, 0];
  if (next(5) === 0) Object.assign(v.mons[AI].effects, { disabledMove: moves[next(4)]!, disabledTurns: 2 });
  const bits = new Set<number>();
  const flagCount = 1 + next(3);
  while (bits.size < flagCount) bits.add(next(11));
  const stale = next(5) === 0;
  const entries: Record<number, string> = {};
  const src = [...bits].flatMap((bit, f) => {
    entries[bit] = `F${f}`;
    return randomFlag(next, f, stale);
  }).join('\n');
  return { v, d: depsFor(src, entries, undefined, gyroDeps()), src };
}

/** The smoke bound in ms: the fast path takes 10–20 ms on these scripts and the slow path seconds. */
const SMOKE_BOUND_MS = 2_000;

/** The best of three timed moveDistribution calls after a warm-up, in ms, so one garbage collection doesn't fail a bound. */
function bestOfThree(v: AiView, d: AiDeps): number {
  const time = () => {
    const start = performance.now();
    shape(moveDistribution(v, d, emptyKnowledge()));
    return performance.now() - start;
  };
  time();
  return Math.min(time(), time(), time());
}

describe('the two paths', () => {
  it('fast path equals slow path', () => {
    let fastRan = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const { v, d, src } = randomCase(seed);
      if (decide(v, d, `seed ${seed}:\n${src}`).fast) fastRan++;
    }
    // The stale cases (about one in five) may take the slow path; the rest must not.
    expect(fastRan).toBeGreaterThanOrEqual(150);
  }, 120_000);

  // Four flags of three draws each and a slot-dependent branch; and Gyro Ball kill checks, which read the speeds, after
  // bit 0's compare writes the view's own values (on the slow path that takes seconds).
  const draws = (f: number) => [
    `F${f}: IfRandomLessThan ${64 + 32 * f}, F${f}a`, 'AddToMoveScore -1',
    `F${f}a: IfMoveEqualTo ${M.EARTHQUAKE}, F${f}b`, `IfRandomLessThan 100, F${f}b`, 'AddToMoveScore 2',
    `F${f}b: IfHPPercentLessThan 0, 50, F${f}c`, `IfRandomGreaterThan 200, F${f}c`, 'AddToMoveScore 1',
    `F${f}c: PopOrEnd`,
  ];
  const kill = (f: number) => [
    `F${f}: IfCurrentMoveKills ${MAX}, F${f}a`, 'AddToMoveScore -1',
    `F${f}a: IfRandomLessThan 100, F${f}b`, 'AddToMoveScore 2',
    `F${f}b: IfRandomGreaterThan 200, F${f}c`, 'AddToMoveScore 1',
    `F${f}c: PopOrEnd`,
  ];
  const compare = [`F0: IfSpeedCompareEqualTo ${COMPARE_SPEED_FASTER}, F0a`, 'F0a: IfRandomLessThan 64, F0b', 'AddToMoveScore -1', 'F0b: PopOrEnd'];
  const FLAGS = { 0: 'F0', 1: 'F1', 2: 'F2', 3: 'F3' };
  it.each<[string, AiView, AiDeps]>([
    ['a several-flag decision', fixtureView(), depsFor([0, 1, 2, 3].flatMap(draws).join('\n'), FLAGS)],
    ['a Gyro Ball decision after speed compares', playerAt(100, aiKnows([MOVE_GYRO_BALL, M.DRAGON_CLAW, M.EARTHQUAKE, M.CRUNCH])),
      depsFor([...compare, ...[1, 2, 3].flatMap(kill)].join('\n'), FLAGS, undefined, gyroDeps())],
  ])('%s stays on the fast path, well under the smoke bound', (_, v, d) => {
    expect(fastMoveDistribution(v, d, emptyKnowledge())).not.toBeNull();
    expect(bestOfThree(v, d)).toBeLessThan(SMOKE_BOUND_MS);
  });
});
