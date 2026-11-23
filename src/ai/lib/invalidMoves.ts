// BattleSystem_CheckInvalidMoves (battle_lib.c:2255) with invalidMoves 0: as the trainer AI calls it, opMask
// CHECK_INVALID_ALL (trainer_ai.c:234), so every check applies, or with the checks BattleSystem_CanUseMove makes when a
// picked move is played (battle_lib.c:2321). Literal port; each rule cites its C line. Pure: the C's write to the Choice
// lock goes to a local copy.

import {
  CHECK_INVALID_ALL, CHECK_INVALID_CHOICE_ITEM, CHECK_INVALID_DISABLED, CHECK_INVALID_GRAVITY, CHECK_INVALID_HEAL_BLOCK,
  CHECK_INVALID_IMPRISONED, CHECK_INVALID_NO_MOVE, CHECK_INVALID_NO_PP, CHECK_INVALID_TAUNTED, CHECK_INVALID_TORMENTED,
  FIELD_CONDITION_GRAVITY, HOLD_EFFECT_CHOICE_ATK, HOLD_EFFECT_CHOICE_SPATK, HOLD_EFFECT_CHOICE_SPEED, LEARNED_MOVES_MAX,
  MOVE_BOUNCE, MOVE_EFFECT_IMPRISON, MOVE_FLY, MOVE_HEAL_ORDER, MOVE_HEALING_WISH, MOVE_HI_JUMP_KICK, MOVE_JUMP_KICK,
  MOVE_LUNAR_DANCE, MOVE_MAGNET_RISE, MOVE_MILK_DRINK, MOVE_MOONLIGHT, MOVE_MORNING_SUN, MOVE_NONE, MOVE_RECOVER,
  MOVE_REST, MOVE_ROOST, MOVE_SLACK_OFF, MOVE_SOFTBOILED, MOVE_SPLASH, MOVE_SWALLOW, MOVE_SYNTHESIS, MOVE_WISH,
  VOLATILE_CONDITION_TORMENT,
} from '../constants.js';
import { AiError } from '../errors.js';
import type { AiBattleMon, AiDeps, AiView } from '../view.js';
import { battleMon, battlerSide, heldItemEffect, maxBattlers, moveData } from './battler.js';

/** sMovesAffectedByGravity, battle_lib.c:3385. */
const GRAVITY_MOVES: readonly number[] = [MOVE_FLY, MOVE_BOUNCE, MOVE_JUMP_KICK, MOVE_HI_JUMP_KICK, MOVE_SPLASH, MOVE_MAGNET_RISE];

/** sMovesAffectedByHealBlock, battle_lib.c:3410. */
const HEAL_BLOCK_MOVES: readonly number[] = [
  MOVE_RECOVER, MOVE_SOFTBOILED, MOVE_REST, MOVE_MILK_DRINK, MOVE_MORNING_SUN, MOVE_SYNTHESIS, MOVE_MOONLIGHT, MOVE_SWALLOW,
  MOVE_HEAL_ORDER, MOVE_SLACK_OFF, MOVE_ROOST, MOVE_LUNAR_DANCE, MOVE_HEALING_WISH, MOVE_WISH,
];

/**
 * Move_Imprisoned, battle_lib.c:3316: whether a battler on the other side has used Imprison and knows `move`. It reads
 * the imprisoner's own MOVE_EFFECT_IMPRISON and moves, which the adapter derives exactly, never MOVE_EFFECT_IMPRISONED
 * (the bit the view may list as unknown), so it needs no requireKnown.
 */
function moveImprisoned(v: AiView, battler: number, move: number): boolean {
  let result = false;
  const side = battlerSide(battler);
  for (let i = 0; i < maxBattlers(v); i++) { // :3324
    const other = battleMon(v, i);
    if (side !== battlerSide(i) && (other.moveEffectsMask & MOVE_EFFECT_IMPRISON) !== 0) { // :3325–3326
      let j: number;
      for (j = 0; j < LEARNED_MOVES_MAX; j++) if (move === other.moves[j]) break; // :3327–3331
      if (j !== LEARNED_MOVES_MAX) result = true; // :3333–3335
    }
  }
  return result;
}

/** Move_FailsInHighGravity, battle_lib.c:3394. */
function moveFailsInHighGravity(v: AiView, move: number): boolean {
  return (v.fieldConditionsMask & FIELD_CONDITION_GRAVITY) !== 0 && GRAVITY_MOVES.includes(move);
}

/** Move_HealBlocked, battle_lib.c:3427. */
function moveHealBlocked(mon: AiBattleMon, move: number): boolean {
  return mon.effects.healBlockTurns !== 0 && HEAL_BLOCK_MOVES.includes(move);
}

/** Battler_SlotForMove, battle_lib.c:2376: the first slot holding `move`, or LEARNED_MOVES_MAX. */
function slotForMove(mon: AiBattleMon, move: number): number {
  let i: number;
  for (i = 0; i < LEARNED_MOVES_MAX; i++) if (mon.moves[i] === move) break;
  return i;
}

/**
 * BattleSystem_CheckInvalidMoves(battleSys, battleCtx, battler, 0, opMask), battle_lib.c:2255: bit i set when slot i
 * fails a check `opMask` selects. The AI's own call passes CHECK_INVALID_ALL (trainer_ai.c:234), the default; the
 * command selection's BattleSystem_CanUseMove passes one check at a time (battle_lib.c:2321–2373). Encore's check has
 * no op-mask bit, so it always applies. Its write to choiceLockedMove (:2310) goes to a local copy; nothing in the AI
 * reads the field, and a second call gives the same result.
 */
export function invalidMoves(v: AiView, d: AiDeps, battler: number, opMask: number = CHECK_INVALID_ALL): number {
  const mon = battleMon(v, battler);
  if (mon.moves.length < LEARNED_MOVES_MAX || mon.ppCur.length < LEARNED_MOVES_MAX) {
    throw new AiError('BAD_VIEW', `battler ${battler} has fewer than ${LEARNED_MOVES_MAX} move or PP slots`);
  }
  const itemEffect = heldItemEffect(v, d, battler); // :2257
  let choiceLockedMove = mon.effects.choiceLockedMove;
  let invalid = 0;

  for (let i = 0; i < LEARNED_MOVES_MAX; i++) {
    const move = mon.moves[i]!;
    const flag = 1 << i; // FlagIndex(i)
    if (move === MOVE_NONE && (opMask & CHECK_INVALID_NO_MOVE) !== 0) invalid |= flag; // :2260–2263
    if (mon.ppCur[i] === 0 && (opMask & CHECK_INVALID_NO_PP) !== 0) invalid |= flag; // :2265–2268
    if (move === mon.effects.disabledMove && (opMask & CHECK_INVALID_DISABLED) !== 0) invalid |= flag; // :2270–2273
    if (move === v.movePrevByBattler[battler] && (opMask & CHECK_INVALID_TORMENTED) !== 0
      && (mon.statusVolatile & VOLATILE_CONDITION_TORMENT) !== 0) invalid |= flag; // :2275–2279
    // An empty slot skips the MOVE_DATA(0) lookup: CHECK_INVALID_NO_MOVE has flagged it already, so the result is the same.
    if (mon.effects.tauntedTurns !== 0 && (opMask & CHECK_INVALID_TAUNTED) !== 0
      && move !== MOVE_NONE && moveData(d, move).power === 0) invalid |= flag; // :2281–2285
    if (moveImprisoned(v, battler, move) && (opMask & CHECK_INVALID_IMPRISONED) !== 0) invalid |= flag; // :2287–2290
    if (moveFailsInHighGravity(v, move) && (opMask & CHECK_INVALID_GRAVITY) !== 0) invalid |= flag; // :2292–2295
    if (moveHealBlocked(mon, move) && (opMask & CHECK_INVALID_HEAL_BLOCK) !== 0) invalid |= flag; // :2297–2300
    // :2302–2305: Encore has no op-mask bit.
    if (mon.effects.encoredMove !== 0 && mon.effects.encoredMove !== move) invalid |= flag;
    // :2307–2315: a Choice item locks every slot but the locked move's; a lock on a move no slot holds is cleared.
    if ((itemEffect === HOLD_EFFECT_CHOICE_ATK || itemEffect === HOLD_EFFECT_CHOICE_SPEED || itemEffect === HOLD_EFFECT_CHOICE_SPATK)
      && (opMask & CHECK_INVALID_CHOICE_ITEM) !== 0) {
      if (slotForMove(mon, choiceLockedMove) === LEARNED_MOVES_MAX) {
        choiceLockedMove = MOVE_NONE; // :2309–2310
      } else if (choiceLockedMove !== 0 && choiceLockedMove !== move) {
        invalid |= flag; // :2311–2313
      }
    }
  }

  return invalid; // :2318
}
