// The view fields the engine adapter can't always derive (AiView.unknown), and the guard their readers call. A listed field still holds a value, the adapter's best guess, but a
// reader never uses it: requireKnown throws AiError('UNDEFINED') first. docs/ai-spot-checks.md items 14–23 say when the
// adapter lists each one. PATHS.friendship keeps its guard but is never listed now: the engine sets happiness from
// BattleMon.friendship (spot check 22), and initialView takes it exactly. Nor is PATHS.imprisoned, whose guard stays
// too: the memory derives MOVE_EFFECT_IMPRISONED from the log (memory.ts imprisonedMark, spot check 15).

import { MAX_BATTLERS } from '../constants.js';
import { AiError } from '../errors.js';
import type { AiView } from '../view.js';

/** The path of each field the adapter may list whose reader guards it with requireKnown. */
export const PATHS = {
  /** recycleItem[b]: LoadRecycleItem. */
  recycleItem: (battler: number) => `recycleItem.${battler}`,
  /**
   * MOVE_EFFECT_IMPRISONED in battleMons[b].moveEffectsMask: IfMoveEffect and IfNotMoveEffect on a mask with that bit.
   * Never listed now (see the top of this file).
   */
  imprisoned: (battler: number) => `mons.${battler}.moveEffectsMask.imprisoned`,
  /** moveProtect[b]: LoadProtectChain. */
  moveProtect: (battler: number) => `moveProtect.${battler}`,
  /** battleMons[b].moveEffectsData.protectSuccessTurns: LoadProtectChain. */
  protectSuccessTurns: (battler: number) => `mons.${battler}.effects.protectSuccessTurns`,
  /** battleMons[b].moveEffectsData.slowStartTurnNumber: Slow Start in compareSpeed and calcMoveDamage. */
  slowStartTurnNumber: (battler: number) => `mons.${battler}.effects.slowStartTurnNumber`,
  /** battleMons[b]'s IVs: Hidden Power in aiMoveType and aiCalcDamage. */
  ivs: (battler: number) => `mons.${battler}.ivs`,
  /** battleMons[b].weight: Low Kick and Grass Knot in aiCalcDamage. */
  weight: (battler: number) => `mons.${battler}.weight`,
  /** battleMons[b].friendship: Return and Frustration in aiCalcDamage. Never listed now (see the top of this file). */
  friendship: (battler: number) => `mons.${battler}.friendship`,
  /**
   * FIELD_CONDITION_DEEP_FOG in fieldConditionsMask: a field-mask test whose result hinges on it (anyFieldBit). Listed by
   * the engine adapter only for a fog note after a Defog the log can't settle (memory.ts `fog`, spot check 20).
   */
  fog: 'fieldConditionsMask.fog',
  /** monSpeedValues as a run starts: a run reading an entry its own comparisons haven't written (run.ts). */
  monSpeedValues: 'monSpeedValues',
  /**
   * AI_CONTEXT.battlerMoves[b], the moves the AI has seen: IfMoveKnown, IfMoveNotKnown, IfMoveEffectKnown and
   * IfMoveEffectNotKnown on the defender (trainer_ai.c:1666, 1722, 1763, 1805). Listed for the player's battler only when a
   * turn's "TrainerAI_Main ran" can't be settled (memory.ts playerMovesUnknown).
   */
  knownMoves: (battler: number) => `knowledge.battlerMoves.${battler}`,
} as const;

/**
 * What BattleAI_PostKOSwitchIn reads at a replacement that the engine's state can't give (final fix wave, item 1;
 * read/compose.ts unknownOf). No reader guards them: the post-KO pick reads them in every damage estimate, so a replacement
 * whose view lists one is refused whole (assertGuarded).
 * - `battleStatusMask.turn`: an AI-read battleStatusMask bit the AI's switching action may have set (battleScripts.ts);
 * - `powerMul`: the same for powerMul;
 * - `mons.<b>.<field>`: a field the fainted battler's BattleMon keeps after the faint (BattleSystem_CleanupFaintedMon,
 *   battle_lib.c:2156–2210, leaves it) where Showdown's faint resets it (clearVolatile), or the switching battler's HP
 *   after a Pursuit that hits it before the pick.
 */
export const REPLACEMENT_PATHS = {
  statusMask: 'battleStatusMask.turn',
  powerMul: 'powerMul',
  field: (battler: number, field: string) => `mons.${battler}.${field}`,
} as const;

/** Throws AiError('UNDEFINED') when `v` lists `path` as unknown; a path matches only itself. */
export function requireKnown(v: AiView, path: string): void {
  if (v.unknown.includes(path)) throw new AiError('UNDEFINED', `${path} is unknown`);
}

/**
 * The paths some reader guards with requireKnown: every path PATHS names, its per-battler ones for battlers 0 to
 * MAX_BATTLERS − 1. Built from PATHS, so the two can't drift.
 */
const GUARDED: ReadonlySet<string> = new Set(Object.values(PATHS).flatMap((path) => (
  typeof path === 'string' ? [path] : Array.from({ length: MAX_BATTLERS }, (_, battler) => path(battler))
)));

/** Whether a reader guards `path` with requireKnown: whether it is one of PATHS. */
export function isGuardedPath(path: string): boolean {
  return GUARDED.has(path);
}

/**
 * No silent reads: throws AiError('UNDEFINED', 'unguarded unknown path <path>') for the first path in
 * `v.unknown` that no reader guards (one PATHS doesn't name). Its value is a placeholder that the code would read as
 * if known. The engine adapter lists PATHS and, at a replacement,
 * REPLACEMENT_PATHS, which this refuses. initialView lists nothing since it applies the turn-1 switch-in effects
 * (switchIn.ts), which refuse by name where the engine can't give them.
 * pickCommand (so decide), moveDistribution, slotScores, replacement and the EnemyModel (model.ts) call it first.
 */
export function assertGuarded(v: AiView): void {
  for (const path of v.unknown) {
    if (!isGuardedPath(path)) throw new AiError('UNDEFINED', `unguarded unknown path ${path}`);
  }
}
