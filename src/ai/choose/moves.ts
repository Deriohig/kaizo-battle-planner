// TrainerAI_Main and TrainerAI_MainSingles (trainer_ai.c:258–343) for the AI's battler in a single battle: the move slot
// it picks, as an exact distribution. Every set AI flag runs its script over every move slot (TrainerAI_EvalMoves,
// trainer_ai.c:483–526); the outcomes merge into exact score distributions, and the tie-break draws over the
// top-scoring slots with the cartridge's u16 weights (trainer_ai.c:317–338). Literal ports; each rule cites its C line.
//
// Two paths give one answer:
// - The slow path runs in the cartridge's order: flag by flag in ascending bit order, slots 0 to 3 inside each flag
//   (trainer_ai.c:297–309, 507–515). calcTemp and monSpeedValues carry from run to run, as the C resets neither between
//   runs. A world is the whole AI state { scores, calcTemp, monSpeedValues, startSpeeds, latents }; equal
//   worlds merge after each run.
// - The fast path scores each slot on its own, every run starting from calcTemp 0 and the view's monSpeedValues. That
//   is exact while the state a run is handed doesn't matter: no run reads the calcTemp it was handed, and either no
//   run reads the speeds it was handed or no run changes them (the proof is at the fast path below).
//   Otherwise the whole decision takes the slow path. So it does on any AiError, which a run may have hit on the stale
//   state it read before it could report the read; the slow path throws it again if the cartridge would hit it. The
//   slots then share only the latents (the damage rolls and the Quick Claw draws). A latent that one slot alone fixes is
//   summed out inside that slot; the fast path conditions every slot on the values of the latents several slots fix,
//   and combines the slots as independent given them.
//
// Quick Claw is a latent with its cartridge prior, summed out: no result carries it. Escape, double battles
// and the interpreter's other failures throw AiError, so AI_STATUS_FLAG_BREAK and AI_ENEMY_ESCAPE never arise here.

import type { Rational } from '../../contracts/engine.js';
import { AI_FLAG_ROAMING_POKEMON, BATTLE_TYPE_ROAMER, ITEM_POWER_CHECK_ALL, LEARNED_MOVES_MAX, MOVE_NONE } from '../constants.js';
import { enumerate, type Leaf, type Pick } from '../enumerate.js';
import { AiError } from '../errors.js';
import { u16, u32, u8 } from '../int.js';
import { battleMon, heldItemPower } from '../lib/battler.js';
import { readRoll } from '../lib/damage.js';
import { invalidMoves } from '../lib/invalidMoves.js';
import { assertGuarded, PATHS } from '../lib/known.js';
import { requireSingles } from '../lib/party.js';
import { type Latents, readQuickClaw } from '../lib/speed.js';
import { recordLastMove } from '../memory.js';
import { add, eq, ONE, rat, residueWeights, U16, ZERO } from '../odds.js';
import { type RunResult, runScript } from '../script/run.js';
import { AI_BATTLER, type AiDeps, type AiKnowledge, type AiView, PLAYER_BATTLER } from '../view.js';

/** A move slot the AI picks, with its exact probability. */
export interface SlotDist { slot: number; probability: Rational }

/** moveScore after TrainerAI_Init for a slot BattleSystem_CheckInvalidMoves passes (trainer_ai.c:224–225). */
const START_SCORE = 100;

/**
 * calcTemp as a decision starts. TrainerAI_Init zeroes AIContext's bytes up to battlerMoves (trainer_ai.c:217–221), and
 * calcTemp lies before it (ai_context.h:16, 27). monSpeedValues lives in BattleContext (battle_context.h:259), which the
 * decision doesn't reset: it starts from the view's.
 */
const START_CALC_TEMP = 0;

/** The most latent assignments a decision may have; more throws AiError('LIMIT'). */
const MAX_LATENT_ASSIGNMENTS = 4096;

/**
 * The latents, numbered: 0–3 are the damage rolls of move slots 0–3 (AI_CONTEXT.moveDamageRolls, trainer_ai.c:240),
 * 4–7 the Quick Claw draws of battlers 0–3 (speedRand, battle_lib.c:1279, 1345).
 */
const QUICK_CLAW_LATENTS = LEARNED_MOVES_MAX;
const LATENT_COUNT = 8;
/** How many values each kind of latent takes: a roll is 85–100, a Quick Claw draw fires or not. */
const ROLL_VALUES = 16;
const QUICK_CLAW_VALUES = 2;

type LatentValue = number | boolean;

/** residueWeights(n) / 65536 for n = 1–4: candidate i of n is the one `RandNext() % n == i` picks (trainer_ai.c:338). */
const TIE_WEIGHTS: readonly (readonly Rational[])[] = [
  [], ...[1, 2, 3, 4].map((n) => residueWeights(n).map((weight) => rat(weight, U16))),
];

/** What one decision runs: the inputs TrainerAI_Main and TrainerAI_Init set up. */
interface Decision {
  readonly v: AiView;
  readonly d: AiDeps;
  /** The knowledge after TrainerAI_RecordLastMove (trainer_ai.c:295). */
  readonly k: AiKnowledge;
  /** battleMons[attacker].moves, which the tie-break reads (trainer_ai.c:322). */
  readonly moves: readonly number[];
  /** AI_CONTEXT.move for each slot: MOVE_NONE when the slot has no PP (trainer_ai.c:490–494). */
  readonly runMoves: readonly number[];
  /** moveScore after TrainerAI_Init (trainer_ai.c:223–238). */
  readonly init: readonly number[];
  /** aiScriptTemp[thinkingBitShift] for each flag that runs, in the order they run. */
  readonly entries: readonly number[];
  /** Whether the view lists its monSpeedValues as unknown: their numbers are then placeholders. */
  readonly speedsUnknown: boolean;
}

/** TrainerAI_Main (trainer_ai.c:258–277) and TrainerAI_Init (trainer_ai.c:211–256) for the AI's battler in singles. */
function setup(v: AiView, d: AiDeps, k: AiKnowledge): Decision {
  requireSingles(v); // a double battle would also OR in AI_FLAG_TAG_STRATEGY (trainer_ai.c:253–255)
  // :264–265: the AI's battler attacks the one BattleSystem_RandomOpponent names, in singles battler ^ 1 with no draw
  // (battle_lib.c:4194): AI_BATTLER against PLAYER_BATTLER.
  const mon = battleMon(v, AI_BATTLER);
  const invalid = invalidMoves(v, d, AI_BATTLER); // :234
  const moves: number[] = [];
  const runMoves: number[] = [];
  const init: number[] = [];
  for (let i = 0; i < LEARNED_MOVES_MAX; i++) {
    const move = u16(mon.moves[i]!); // u16 moves[] (battle_mon.h:64)
    moves.push(move);
    runMoves.push(mon.ppCur[i] === 0 ? MOVE_NONE : move); // :490–494
    // :223–231: AI_INIT_SCORE_ALL_MOVES (:267) starts every slot at 100; :235–238: an invalid slot at 0. The damage
    // rolls drawn at :240 are latents, fixed when a run first reads one.
    init.push((invalid & (1 << i)) !== 0 ? 0 : START_SCORE);
  }

  // :246–250: a roamer thinks with AI_FLAG_ROAMING_POKEMON alone, anyone else with its trainer's aiMask.
  const thinkingMask = (v.battleType & BATTLE_TYPE_ROAMER) !== 0 ? AI_FLAG_ROAMING_POKEMON : d.aiFlags;
  // :297–309: while the u32 mask is non-zero, its bit 0 runs the flag at thinkingBitShift; then the mask shifts right
  // and thinkingBitShift counts up. So the set bits run in ascending order, each from its own entry (:488), including
  // a bit with no routine, whose entry is Terminate (script.s:30–47).
  const entries: number[] = [];
  for (let mask = u32(thinkingMask), bit = 0; mask !== 0; mask >>>= 1, bit++) {
    if ((mask & 1) === 0) continue;
    const entry = d.script.flagEntries[bit];
    if (entry === undefined) throw new AiError('UNKNOWN_OPCODE', `the script has no entry for AI flag bit ${bit}`);
    entries.push(entry);
  }

  return {
    v, d, k: recordLastMove(k, v, PLAYER_BATTLER), moves, runMoves, init, entries,
    speedsUnknown: v.unknown.includes(PATHS.monSpeedValues),
  };
}

/** Whether the tie-break can pick `slot`: slot 0 always, slots 1–3 when they hold a move (trainer_ai.c:317–322). */
function isCandidate(dec: Decision, slot: number): boolean {
  return slot === 0 || dec.moves[slot] !== MOVE_NONE;
}

/**
 * One run of the flag at `entry` for `slot` (trainer_ai.c:487–520), from the given state. `startSpeeds`: whether
 * `speeds` are still the decision-start values (RunInput.startSpeeds).
 */
function run(
  dec: Decision, entry: number, slot: number, score: number, calcTemp: number, speeds: number[], startSpeeds: boolean,
  lat: Latents, pick: Pick,
): RunResult {
  return runScript(entry, {
    v: dec.v, d: dec.d, k: dec.k, lat, attacker: AI_BATTLER, defender: PLAYER_BATTLER, slot, move: dec.runMoves[slot]!,
    score, calcTemp, monSpeedValues: speeds, startSpeeds, pick,
  });
}

function sameValues(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function noLatents(): Latents {
  return { rolls: [null, null, null, null], quickClaw: [null, null, null, null] };
}

function latentKey(lat: Latents): string {
  return `${lat.rolls.join()}|${lat.quickClaw.join()}`;
}

/** Latent `id`'s value in `lat`, or null when it isn't fixed. */
function latentValue(lat: Latents, id: number): LatentValue | null {
  return (id < QUICK_CLAW_LATENTS ? lat.rolls[id] : lat.quickClaw[id - QUICK_CLAW_LATENTS]) ?? null;
}

/** Adds the latents `lat` fixes to `ids`. */
function addFixed(ids: Set<number>, lat: Latents): void {
  for (let id = 0; id < LATENT_COUNT; id++) if (latentValue(lat, id) !== null) ids.add(id);
}

/** AiError('LIMIT') when the latents `ids` have more than MAX_LATENT_ASSIGNMENTS joint values. */
function checkLatentCount(ids: Iterable<number>): void {
  let count = 1;
  for (const id of ids) count *= id < QUICK_CLAW_LATENTS ? ROLL_VALUES : QUICK_CLAW_VALUES;
  if (count > MAX_LATENT_ASSIGNMENTS) {
    throw new AiError('LIMIT', `the runs fix latents with ${count} joint values, more than ${MAX_LATENT_ASSIGNMENTS}`);
  }
}

/**
 * Latent `id`'s cartridge prior, from the helper that fixes it: readRoll's `100 - RandNext() % 16` (trainer_ai.c:240),
 * or readQuickClaw's `speedRand % (100 / param) == 0` (battle_lib.c:1279, 1345), with the u8 Battler_HeldItemPower that
 * BattleSystem_CompareBattlerSpeed passes it (battle_lib.c:1216, 1218).
 */
function latentPrior(dec: Decision, id: number): Leaf<LatentValue>[] {
  if (id < QUICK_CLAW_LATENTS) return enumerate((pick) => readRoll(noLatents(), id, pick), String);
  const battler = id - QUICK_CLAW_LATENTS;
  const param = u8(heldItemPower(dec.v, dec.d, battler, ITEM_POWER_CHECK_ALL));
  return enumerate((pick) => readQuickClaw(dec.v, noLatents(), battler, param, pick), String);
}

// Exact arithmetic for the merges and the tie-break. Nearly every probability here is dyadic, every draw being out of
// 65536, and their denominators grow long; reducing them with odds.ts's Euclidean gcd took two thirds of the run time.
// A dyadic result is reduced by its trailing zero bits instead; anything else goes through odds.ts.

function isPowerOfTwo(n: bigint): boolean {
  return (n & (n - 1n)) === 0n;
}

/** `num / den` reduced, for num >= 0 and den > 0. */
function reduced(num: bigint, den: bigint): Rational {
  if (!isPowerOfTwo(den)) return rat(num, den);
  if (num === 0n) return ZERO;
  const lowBit = num & -num; // the largest power of two dividing num
  const g = lowBit < den ? lowBit : den;
  return { num: num / g, den: den / g };
}

function qmul(a: Rational, b: Rational): Rational {
  return reduced(a.num * b.num, a.den * b.den);
}

function qadd(a: Rational, b: Rational): Rational {
  if (a.den === b.den) return reduced(a.num + b.num, a.den);
  if (isPowerOfTwo(a.den) && isPowerOfTwo(b.den)) {
    return a.den > b.den ? reduced(a.num + b.num * (a.den / b.den), a.den) : reduced(a.num * (b.den / a.den) + b.num, b.den);
  }
  return add(a, b);
}

function qsum(rs: Iterable<Rational>): Rational {
  let total = ZERO;
  for (const r of rs) total = qadd(total, r);
  return total;
}

function div(a: Rational, b: Rational): Rational {
  return rat(a.num * b.den, a.den * b.num);
}

function addTo(map: Map<number, Rational>, key: number, p: Rational): void {
  const seen = map.get(key);
  map.set(key, seen === undefined ? p : qadd(seen, p));
}

/** `out` (by slot) as the result: the slots above 0, ascending. Throws if it doesn't sum to exactly ONE (a bug). */
function slotDist(out: Rational[]): SlotDist[] {
  const total = qsum(out);
  if (!eq(total, ONE)) throw new Error(`the move choice sums to ${total.num}/${total.den}, not 1`);
  return out.flatMap((probability, slot) => (probability.num === 0n ? [] : [{ slot, probability }]));
}

// The fast path.

/** One slot's state on the fast path: its score and the latents its runs fixed. */
interface SlotWorld { score: number; lat: Latents; p: Rational }

// Why the fast path is exact.
//
// A run's execution, given its draws and the latents' values, depends on the calcTemp and monSpeedValues it is handed
// only from its first read of them: until then it runs the same whatever they hold. The score never steers it, as only
// AddToMoveScore touches moveScore (trainer_ai.c:576–586). The fast path runs every flag for every slot from calcTemp 0
// and the view's speeds V, over every draw and every value of every latent. So every run the cartridge makes executes
// as one the fast path made, up to that run's first read of the state it is handed. Then:
// 1. If no run reads the calcTemp it is handed, the cartridge's carried calcTemp never matters.
// 2. Speeds, by induction over the cartridge's order, when moreover no run leaves the speeds different from V. The
//    decision starts with V, as battleCtx->monSpeedValues (battle_context.h:259) is not reset per decision. A run
//    handed V executes as one the fast path ran, so it leaves V too, and the next run is handed V. So every run is
//    handed V, as on the fast path, and reading the speeds is harmless.
//    Only BattleSystem_CompareBattlerSpeed writes them (battle_lib.c:1372–1373, from IfSpeedCompare* and
//    LoadBattlerSpeedRank). The speeds W it writes for battlers 0 and 1 are a function of the view alone: Quick Claw
//    and a tie's coin decide only its result. So "no run changes the speeds" is "W agrees with V on every entry a
//    compare writes". RunResult reports reads as one flag, not by entry, so the test covers every entry, which is
//    stricter than needed; in singles the compares write entries 0 and 1, and Gyro Ball reads those (trainer_ai.c:2996).
// 3. When the view lists 'monSpeedValues' as unknown, V's numbers are placeholders, so any read of the speeds a run
//    was handed takes the slow path, whatever W is. There RunInput.startSpeeds tells a read of V from a read of a
//    compare's W. A decision that never reads them keeps the fast path: their values never matter.
// A run that throws AiError may have failed on a stale read before it could report it, so that takes the slow path
// too.

/** Thrown out of the fast path when a run's reads make it inexact. */
class ReadIncomingState extends Error {}

/** What the fast path's runs did with the speeds: whether one read those it was handed, and whether one changed them. */
interface SpeedUse { read: boolean; changed: boolean }

function noSpeedUse(): SpeedUse {
  return { read: false, changed: false };
}

/**
 * Every flag's runs for `slot` alone, each from calcTemp 0 and the view's monSpeedValues: the slot's worlds, merged by
 * score and latents. Notes in `speeds` what the runs did with the speeds, and counts in `progress` the runs that
 * finished. Throws ReadIncomingState when a run read the calcTemp it was handed, or once the speed reads so far are
 * stale (points 2 and 3 above).
 */
function fastSlot(dec: Decision, slot: number, speeds: SpeedUse, progress: { runs: number }): SlotWorld[] {
  const move = dec.runMoves[slot];
  let worlds: SlotWorld[] = [{ score: dec.init[slot]!, lat: noLatents(), p: ONE }];
  for (const entry of dec.entries) {
    const next = new Map<string, SlotWorld>();
    for (const w of worlds) {
      if (move === MOVE_NONE) { // trainer_ai.c:500–504: no run, and the score is 0
        putSlotWorld(next, 0, w.lat, w.p);
        continue;
      }
      const leaves = enumerate((pick) => {
        const result = run(dec, entry, slot, w.score, START_CALC_TEMP, dec.v.monSpeedValues, true, w.lat, pick);
        if (result.readIncomingTemp) throw new ReadIncomingState();
        if (result.readIncomingSpeeds) speeds.read = true;
        if (!sameValues(result.monSpeedValues, dec.v.monSpeedValues)) speeds.changed = true;
        if (speeds.read && (speeds.changed || dec.speedsUnknown)) throw new ReadIncomingState();
        return result;
      }, (result) => `${result.score}|${latentKey(result.lat)}`);
      progress.runs++;
      for (const leaf of leaves) putSlotWorld(next, leaf.value.score, leaf.value.lat, qmul(w.p, leaf.probability));
    }
    worlds = [...next.values()];
  }
  return worlds;
}

/**
 * Adds the world (score, lat) at `p` to `next`, merged with an equal one (fastSlot). A module function, not a closure
 * per run of the loop (under tsx's keepNames each closure costs an Object.defineProperty).
 */
function putSlotWorld(next: Map<string, SlotWorld>, score: number, lat: Latents, p: Rational): void {
  const key = `${score}|${latentKey(lat)}`;
  const seen = next.get(key);
  if (seen) seen.p = qadd(seen.p, p);
  else next.set(key, { score, lat, p });
}

/**
 * fastSlot for each of `slots`, sharing `speeds`, or null when the fast path can't decide them: a run's reads make it
 * inexact, or a run threw AiError. A run can fail on the stale state it read before it reports the read (Gyro Ball
 * dividing by a stale speed of 0, say), so an AiError here may not be the cartridge's; the slow path, whose runs see
 * the true state, throws it again if it is.
 *
 * One AiError is the cartridge's for certain, and `rethrowFirst` (set when `slots` are the decision's candidates from
 * slot 0) throws it at once: one from the decision's first run, the first flag's run for the first slot that runs (an
 * empty or 0-PP slot runs nothing, trainer_ai.c:500–504). The slow path's first run is that same run: the same flag and
 * slot, handed the same calcTemp 0, the view's speeds marked as the decision's start, no latent fixed and the same
 * score (slowWorlds' first world), with no run before it to change any of them. A run is a function of those inputs
 * and its draws, and both paths draw through `enumerate` in the same order, so the slow path would reach the same
 * leaf first and throw the same error. Not so for a later run: on the slow path it runs in flag-major order, after other
 * slots' runs that may throw first, and in worlds whose latents other slots fixed, which `enumerate` visits in another
 * order (the proof covers a run's state, not which failure comes first). So any other AiError takes the slow path.
 */
function tryFastSlots(
  dec: Decision, slots: readonly number[], speeds: SpeedUse, rethrowFirst = false,
): Map<number, SlotWorld[]> | null {
  const out = new Map<number, SlotWorld[]>();
  const progress = { runs: 0 };
  try {
    for (const slot of slots) out.set(slot, fastSlot(dec, slot, speeds, progress));
  } catch (error) {
    if (error instanceof AiError && rethrowFirst && progress.runs === 0) throw error;
    if (error instanceof ReadIncomingState || error instanceof AiError) return null;
    throw error;
  }
  return out;
}

/**
 * One slot's score distribution given the values of the `shared` latents: each world consistent with them, its
 * probability divided by the prior of the shared values it fixed itself (its own draw of them is the event conditioned
 * on). Latents only this slot fixed stay summed out. Throws if the result doesn't sum to ONE (a bug, or a wrong prior).
 */
function conditional(worlds: SlotWorld[], shared: number[], values: LatentValue[], priors: Rational[]): Map<number, Rational> {
  const dist = new Map<number, Rational>();
  for (const w of worlds) {
    let p = w.p;
    let consistent = true;
    for (let j = 0; j < shared.length && consistent; j++) {
      const fixed = latentValue(w.lat, shared[j]!);
      if (fixed === null) continue;
      if (fixed === values[j]) p = div(p, priors[j]!);
      else consistent = false;
    }
    if (consistent) addTo(dist, w.score, p);
  }
  const total = qsum(dist.values());
  if (!eq(total, ONE)) throw new Error(`a slot's conditional scores sum to ${total.num}/${total.den}, not 1`);
  return dist;
}

/** One state of the tie-break loop: the running maximum (u8 maxScoreMoves[0]) and the candidates, as a slot mask. */
interface TieState { max: number; mask: number; p: Rational }

/**
 * The tie-break loop (trainer_ai.c:317–338) over independent slot score distributions: adds `weight` × each slot's
 * chance of being picked to `out`. Candidates are appended in slot order (:326), so a mask keeps the list's order.
 * `dists[i]` is read only for the candidates.
 */
function tieBreak(moves: readonly number[], dists: readonly (Map<number, Rational> | null)[], weight: Rational, out: Rational[]): void {
  let states = new Map<number, TieState>();
  for (const [score, p] of dists[0]!) putTieState(states, u8(score), 1, p); // :317–319: slot 0 starts the list
  for (let i = 1; i < LEARNED_MOVES_MAX; i++) {
    if (moves[i] === MOVE_NONE) continue; // :322
    const next = new Map<number, TieState>();
    for (const state of states.values()) {
      for (const [score, p] of dists[i]!) {
        let { max, mask } = state;
        if (max === score) mask |= 1 << i; // :324–327
        if (max < score) { // :330–334
          mask = 1 << i;
          max = u8(score);
        }
        putTieState(next, max, mask, qmul(state.p, p));
      }
    }
    states = next;
  }
  for (const state of states.values()) {
    const slots: number[] = [];
    for (let i = 0; i < LEARNED_MOVES_MAX; i++) if ((state.mask & (1 << i)) !== 0) slots.push(i);
    const weights = TIE_WEIGHTS[slots.length]!; // :338
    const p = qmul(weight, state.p);
    slots.forEach((slot, j) => {
      out[slot] = qadd(out[slot]!, qmul(p, weights[j]!));
    });
  }
}

/** Adds the tie-break state (max, mask) at `p` to `into`, merged with an equal one (tieBreak; a module function). */
function putTieState(into: Map<number, TieState>, max: number, mask: number, p: Rational): void {
  const key = max * 16 + mask;
  const seen = into.get(key);
  if (seen) seen.p = qadd(seen.p, p);
  else into.set(key, { max, mask, p });
}

/** The fast path's distribution, or null when it can't decide: see tryFastSlots. */
function fastDistribution(dec: Decision): SlotDist[] | null {
  // A slot the tie-break never picks has no move, so it runs nothing: no latent, no speeds. Skip it.
  const candidates = [0, 1, 2, 3].filter((slot) => isCandidate(dec, slot));
  const explored = tryFastSlots(dec, candidates, noSpeedUse(), true);
  if (explored === null) return null;
  const perSlot = [0, 1, 2, 3].map((slot) => explored.get(slot) ?? []);

  const fixedBySlot = perSlot.map((worlds) => {
    const ids = new Set<number>();
    for (const w of worlds) addFixed(ids, w.lat);
    return ids;
  });
  const all = new Set(fixedBySlot.flatMap((ids) => [...ids]));
  checkLatentCount(all);
  const shared = [...all].filter((id) => fixedBySlot.filter((ids) => ids.has(id)).length > 1).sort((a, b) => a - b);

  // Every joint value of the shared latents, with its prior.
  let assignments: { values: LatentValue[]; priors: Rational[]; p: Rational }[] = [{ values: [], priors: [], p: ONE }];
  for (const id of shared) {
    const prior = latentPrior(dec, id);
    assignments = assignments.flatMap((a) => prior.map((leaf) => ({
      values: [...a.values, leaf.value], priors: [...a.priors, leaf.probability], p: qmul(a.p, leaf.probability),
    })));
  }

  const out = Array.from({ length: LEARNED_MOVES_MAX }, () => ZERO);
  for (const a of assignments) {
    const dists = perSlot.map((worlds, slot) => (isCandidate(dec, slot) ? conditional(worlds, shared, a.values, a.priors) : null));
    tieBreak(dec.moves, dists, a.p, out);
  }
  return slotDist(out);
}

// The slow path.

/**
 * The AI's state between runs on the slow path. `startSpeeds`: no run so far has written the speeds, so they are
 * still the view's (RunInput.startSpeeds).
 */
interface World { scores: number[]; calcTemp: number; speeds: number[]; startSpeeds: boolean; lat: Latents; p: Rational }

/** A monSpeedValues entry no write leaves: they are u32 (battle_context.h:259). */
const UNWRITTEN = -1;

/**
 * One slow-path run from world `w`, and whether the speeds it leaves are still the decision-start values. A run that
 * changes them wrote them. One that leaves them as they were wrote nothing or wrote the same values, which matters
 * while they are the view's: if their numbers are placeholders, equal ones are still known after a write.
 * A run that read none of the speeds it was handed runs the same from any speeds, so a replay of its draws from
 * UNWRITTEN tells the two apart. A run that did read them is handed the start values, and if those are unknown the
 * view-gap check stops the decision at that read (RunInput.startSpeeds); so it is counted as writing nothing.
 */
function slowRun(dec: Decision, entry: number, slot: number, w: World, pick: Pick): { r: RunResult; startSpeeds: boolean } {
  const score = w.scores[slot]!;
  if (!w.startSpeeds) return { r: run(dec, entry, slot, score, w.calcTemp, w.speeds, false, w.lat, pick), startSpeeds: false };
  const choices: number[] = [];
  const r = run(dec, entry, slot, score, w.calcTemp, w.speeds, true, w.lat, (weights) => {
    const choice = pick(weights);
    choices.push(choice);
    return choice;
  });
  if (!sameValues(r.monSpeedValues, w.speeds)) return { r, startSpeeds: false };
  if (r.readIncomingSpeeds) return { r, startSpeeds: true };
  let at = 0;
  const replay = run(dec, entry, slot, score, w.calcTemp, w.speeds.map(() => UNWRITTEN), true, w.lat, () => {
    const choice = choices[at++];
    if (choice === undefined) throw new Error('a replayed run drew more often than the run it replays');
    return choice;
  });
  if (at !== choices.length) throw new Error('a replayed run drew less often than the run it replays');
  return { r, startSpeeds: replay.monSpeedValues.every((speed) => speed === UNWRITTEN) };
}

/**
 * Every run in the cartridge's order (trainer_ai.c:297–309, 507–515), from the decision's start state, carrying
 * calcTemp, monSpeedValues and startSpeeds from run to run: the final worlds, merged when equal after each run.
 */
function slowWorlds(dec: Decision): World[] {
  let worlds: World[] = [{
    scores: [...dec.init], calcTemp: START_CALC_TEMP, speeds: [...dec.v.monSpeedValues], startSpeeds: true,
    lat: noLatents(), p: ONE,
  }];
  for (const entry of dec.entries) {
    for (let slot = 0; slot < LEARNED_MOVES_MAX; slot++) {
      const next = new Map<string, World>();
      const put = (
        base: number[], score: number, calcTemp: number, speeds: number[], startSpeeds: boolean, lat: Latents, p: Rational,
      ) => {
        const scores = [...base];
        scores[slot] = score;
        const key = `${scores.join()}|${calcTemp}|${speeds.join()}|${startSpeeds}|${latentKey(lat)}`;
        const seen = next.get(key);
        if (seen) seen.p = qadd(seen.p, p);
        else next.set(key, { scores, calcTemp, speeds, startSpeeds, lat, p });
      };
      for (const w of worlds) {
        if (dec.runMoves[slot] === MOVE_NONE) { // trainer_ai.c:500–504
          put(w.scores, 0, w.calcTemp, w.speeds, w.startSpeeds, w.lat, w.p);
          continue;
        }
        const leaves = enumerate(
          (pick) => slowRun(dec, entry, slot, w, pick),
          ({ r, startSpeeds }) => `${r.score}|${r.calcTemp}|${r.monSpeedValues.join()}|${startSpeeds}|${latentKey(r.lat)}`,
        );
        for (const { value: { r, startSpeeds }, probability } of leaves) {
          put(w.scores, r.score, r.calcTemp, r.monSpeedValues, startSpeeds, r.lat, qmul(w.p, probability));
        }
      }
      worlds = [...next.values()];
      const fixed = new Set<number>();
      for (const w of worlds) addFixed(fixed, w.lat);
      checkLatentCount(fixed);
    }
  }
  return worlds;
}

/** TrainerAI_MainSingles' tie-break on one score vector (trainer_ai.c:317–336): the candidates, in list order. */
function candidates(moves: readonly number[], scores: readonly number[]): number[] {
  let numMaxScoreMoves = 1; // :317
  let maxScore = u8(scores[0]!); // :318: maxScoreMoves is a u8 array
  const maxScoreMoveSlots = [0]; // :319
  for (let i = 1; i < LEARNED_MOVES_MAX; i++) { // :321
    if (moves[i] !== MOVE_NONE) { // :322
      const score = scores[i]!;
      if (maxScore === score) maxScoreMoveSlots[numMaxScoreMoves++] = i; // :324–327
      if (maxScore < score) { // :330–334
        numMaxScoreMoves = 1;
        maxScore = u8(score);
        maxScoreMoveSlots[0] = i;
      }
    }
  }
  return maxScoreMoveSlots.slice(0, numMaxScoreMoves);
}

function slowDistribution(dec: Decision): SlotDist[] {
  const out = Array.from({ length: LEARNED_MOVES_MAX }, () => ZERO);
  for (const w of slowWorlds(dec)) {
    const slots = candidates(dec.moves, w.scores);
    const weights = TIE_WEIGHTS[slots.length]!; // `RandNext() % numMaxScoreMoves` (trainer_ai.c:338)
    slots.forEach((slot, j) => {
      out[slot] = qadd(out[slot]!, qmul(w.p, weights[j]!));
    });
  }
  return slotDist(out);
}

// The API.

/**
 * TrainerAI_Main + TrainerAI_MainSingles (trainer_ai.c:258–343) for the AI's battler: every move slot the AI can pick,
 * with its exact probability, ascending, summing to ONE. A slot the cartridge can pick though it can't be used (no PP,
 * Disabled, an empty slot 0) is listed like any other. Throws AiError as the runs do: 'ESCAPE', 'UNSUPPORTED' (double
 * battles), 'DIV_ZERO', 'STACK', 'LIMIT' (also past 4096 latent assignments), 'UNDEFINED', 'UNKNOWN_OPCODE', 'BAD_VIEW'.
 */
export function moveDistribution(v: AiView, d: AiDeps, k: AiKnowledge): SlotDist[] {
  assertGuarded(v); // AiError('UNDEFINED') for an unknown path no reader guards
  const dec = setup(v, d, k);
  return fastDistribution(dec) ?? slowDistribution(dec);
}

/**
 * moveDistribution's fast path alone: null when it can't decide, because a run read the calcTemp or monSpeedValues it
 * was handed or threw AiError. For tests.
 */
export function fastMoveDistribution(v: AiView, d: AiDeps, k: AiKnowledge): SlotDist[] | null {
  assertGuarded(v);
  return fastDistribution(setup(v, d, k));
}

/** moveDistribution's slow, flag-major path alone, which is exact by construction. For tests. */
export function slowMoveDistribution(v: AiView, d: AiDeps, k: AiKnowledge): SlotDist[] {
  assertGuarded(v);
  return slowDistribution(setup(v, d, k));
}

/**
 * One slot's final score distribution, latents summed out, scores ascending: the fast path's worlds for that slot, or
 * the slow path's when the fast path can't decide the slot. The gist tests compare it with each flag's scoring.
 */
export function slotScores(v: AiView, d: AiDeps, k: AiKnowledge, slot: number): { score: number; probability: Rational }[] {
  assertGuarded(v);
  if (!Number.isInteger(slot) || slot < 0 || slot >= LEARNED_MOVES_MAX) throw new Error(`no move slot ${slot}`);
  const dec = setup(v, d, k);
  const speeds = noSpeedUse();
  let fast = tryFastSlots(dec, [slot], speeds)?.get(slot) ?? null;
  // The slot's runs read the speeds they were handed: those are the cartridge's only if no other run changes them
  // either (see the proof above the fast path), so the other slots' runs are checked too.
  if (fast !== null && speeds.read && tryFastSlots(dec, [0, 1, 2, 3].filter((other) => other !== slot), speeds) === null) {
    fast = null;
  }
  const worlds: { score: number; p: Rational }[] = fast ?? slowWorlds(dec).map((w) => ({ score: w.scores[slot]!, p: w.p }));
  const dist = new Map<number, Rational>();
  for (const w of worlds) addTo(dist, w.score, w.p);
  return [...dist].sort(([a], [b]) => a - b).map(([score, probability]) => ({ score, probability }));
}
