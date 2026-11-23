// Shared runner for the opcode tests: assembles a script and runs it from word 0 on the fixture's turn-1 view, the AI's
// Garchomp (battler 1) scoring a slot (default 0, Dragon Claw) against the player's Luxray (battler 0).

import { expect, it } from 'vitest';
import type { Rational } from '../../../src/contracts/engine.js';
import {
  AI_BATTLER_ATTACKER, AI_BATTLER_ATTACKER_PARTNER, AI_BATTLER_DEFENDER, AI_BATTLER_DEFENDER_PARTNER,
  BATTLE_EFFECT_POWER_BASED_ON_LOW_SPEED, MOVE_GYRO_BALL, TYPE_STEEL,
} from '../../../src/ai/constants.js';
import { enumerate, type Pick } from '../../../src/ai/enumerate.js';
import { AiError, type AiErrorCode } from '../../../src/ai/errors.js';
import type { Latents } from '../../../src/ai/lib/speed.js';
import { type RunResult, runScript } from '../../../src/ai/script/run.js';
import {
  AI_BATTLER, type AiBattleMon, type AiDeps, type AiKnowledge, type AiMoveEffectsData, type AiPartyMon, type AiView,
  PLAYER_BATTLER,
} from '../../../src/ai/view.js';
import { assemble } from './asm.js';
import { emptyKnowledge, fixtureDeps, fixtureView } from './fixtures.js';

export const AI = AI_BATTLER;
export const PLAYER = PLAYER_BATTLER;
/** The script's battler codes (AIScript_Battler, trainer_ai.c:2765). */
export const ATK = AI_BATTLER_ATTACKER;
export const DEF = AI_BATTLER_DEFENDER;
export const ATK_PARTNER = AI_BATTLER_ATTACKER_PARTNER;
export const DEF_PARTNER = AI_BATTLER_DEFENDER_PARTNER;
export const TAKEN = 101;
export const NOT_TAKEN = 100;

/** For runs with no random draw: any pick fails the test. */
const noPick: Pick = () => {
  throw new Error('unexpected pick');
};

export const latents = (): Latents => ({ rolls: [null, null, null, null], quickClaw: [null, null, null, null] });

export function codeOf(fn: () => unknown): AiErrorCode | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof AiError) return error.code;
    throw error;
  }
  return undefined;
}

export interface Opts {
  v?: AiView; d?: AiDeps; k?: AiKnowledge; slot?: number; move?: number; score?: number; calcTemp?: number;
  defender?: number; pick?: Pick; lat?: Latents; monSpeedValues?: number[];
}

/** Runs `src` for slot `slot`, score 100 and calcTemp 0 unless given; given monSpeedValues are not the start values. */
export function run(src: string, opts: Opts = {}): RunResult {
  const v = opts.v ?? fixtureView();
  const slot = opts.slot ?? 0;
  const script = { words: assemble(src).words, flagEntries: Array<number>(32).fill(0), sha256: '' };
  return runScript(0, {
    v, d: { ...(opts.d ?? fixtureDeps()), script }, k: opts.k ?? emptyKnowledge(), lat: opts.lat ?? latents(),
    attacker: AI, defender: opts.defender ?? PLAYER, slot, move: opts.move ?? v.mons[AI].moves[slot]!,
    score: opts.score ?? 100, calcTemp: opts.calcTemp ?? 0, pick: opts.pick ?? noPick,
    monSpeedValues: opts.monSpeedValues ?? [...v.monSpeedValues], startSpeeds: opts.monSpeedValues === undefined,
  });
}

/** Appended to an instruction that jumps to `Taken`: the score ends TAKEN (101) if it jumps, NOT_TAKEN (100) if not. */
export const BRANCH = '\nPopOrEnd\nTaken: AddToMoveScore 1\nPopOrEnd';
export const branch = (instr: string, opts?: Opts): number => run(`${instr}${BRANCH}`, opts).score;
/** The value `instr` leaves in calcTemp. */
export const load = (instr: string, opts?: Opts): number => run(`${instr}\nPopOrEnd`, opts).calcTemp;

/** The odds of each value `get` (default: the score) takes from the run of `src`, over its random draws. */
export function oddsOf(src: string, opts?: Opts, get: (r: RunResult) => number = (r) => r.score): Record<string, Rational> {
  const leaves = enumerate((pick) => get(run(src, { ...opts, pick })), String);
  return Object.fromEntries(leaves.map((leaf) => [leaf.value, leaf.probability]));
}

/** One `it` per row: `instr` (jumping to `Taken`) jumps exactly when `taken`. */
export function branches(rows: [instr: string, taken: boolean, opts?: Opts][]): void {
  it.each(rows)('%s → %s', (instr, taken, opts) => expect(branch(instr, opts)).toBe(taken ? TAKEN : NOT_TAKEN));
}

/** One `it` per row: `instr` leaves `value` in calcTemp. */
export function loads(rows: [instr: string, value: number, opts?: Opts][]): void {
  it.each(rows)('%s → %s', (instr, value, opts) => expect(load(instr, opts)).toBe(value));
}

/** One `it` per row: running `instr` (with the branch tail) throws `code`, or nothing when undefined. */
export function throws(rows: [instr: string, code: AiErrorCode | undefined, opts?: Opts][]): void {
  it.each(rows)('%s throws %s', (instr, code, opts) => expect(codeOf(() => run(`${instr}${BRANCH}`, opts))).toBe(code));
}

/** `v` (default a fresh fixture) with battler `b`'s fields set; `effects` merges into its effects. */
export function mon(b: number, patch: Partial<Omit<AiBattleMon, 'effects'>> & { effects?: Partial<AiMoveEffectsData> }, v = fixtureView()): AiView {
  const { effects, ...fields } = patch;
  Object.assign(v.mons[b]!, fields);
  Object.assign(v.mons[b]!.effects, effects);
  return v;
}

/** `v` with the player's Luxray at `curHP` of its 155. */
export const playerAt = (curHP: number, v = fixtureView()): AiView => mon(PLAYER, { curHP }, v);

/** `v` with the AI's Garchomp knowing `moves`, `pp` PP each (default 10 for a move, 0 for an empty slot). */
export const aiKnows = (moves: number[], pp?: number[], v = fixtureView()): AiView =>
  mon(AI, { moves, ppCur: pp ?? moves.map((move) => (move === 0 ? 0 : 10)) }, v);

/** `v` with the AI's party members, by party slot, given `fields`. */
export function aiParty(patch: Record<number, Partial<AiPartyMon>>, v = fixtureView()): AiView {
  for (const [slot, fields] of Object.entries(patch)) Object.assign(v.parties[AI][Number(slot)]!, fields);
  return v;
}

/** `v` (default a fresh fixture) changed in place by `patch`. */
export const viewWith = (patch: (v: AiView) => void, v = fixtureView()): AiView => {
  patch(v);
  return v;
};

/** Empty knowledge with entries set by battler, e.g. `{ battlerAbilities: { [PLAYER]: ability } }`. */
export function knows(patch: { [K in keyof AiKnowledge]?: Record<number, AiKnowledge[K][number]> }): AiKnowledge {
  const k = emptyKnowledge();
  for (const [key, entries] of Object.entries(patch)) Object.assign(k[key as keyof AiKnowledge], entries);
  return k;
}

/** The fixture deps with Gyro Ball's vanilla record (res/moves/gyro_ball/data.json): physical Steel, power 1. */
export function gyroDeps(): AiDeps {
  const d = fixtureDeps();
  d.moves[MOVE_GYRO_BALL] = {
    id: MOVE_GYRO_BALL, effect: BATTLE_EFFECT_POWER_BASED_ON_LOW_SPEED, category: 'physical', power: 1, type: TYPE_STEEL,
    accuracy: 100, pp: 5, effectChance: 0, target: 0, priority: 0, flags: 0,
  };
  return d;
}
