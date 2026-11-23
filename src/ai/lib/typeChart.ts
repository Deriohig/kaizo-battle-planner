// Type effectiveness as the trainer AI computes it: BattleSystem_ApplyTypeChart, BattleSystem_CalcEffectiveness,
// BattleSystem_TypeMatchupMultiplier and their helpers in battle_lib.c, over the ROM's type chart (AiDeps.typeChart,
// in the cartridge's order, with the 0xFE separator kept). Literal ports; each rule cites its C line. All are pure.

import {
  ABILITY_ADAPTABILITY, ABILITY_FILTER, ABILITY_LEVITATE, ABILITY_MOLD_BREAKER, ABILITY_NORMALIZE, ABILITY_SCRAPPY,
  ABILITY_SOLID_ROCK, ABILITY_TINTED_LENS, ABILITY_WONDER_GUARD, BATTLE_EFFECT_BIDE, BATTLE_EFFECT_BOUNCE,
  BATTLE_EFFECT_CHARGE_TURN_DEF_UP, BATTLE_EFFECT_CHARGE_TURN_HIGH_CRIT, BATTLE_EFFECT_CHARGE_TURN_HIGH_CRIT_FLINCH,
  BATTLE_EFFECT_DIG, BATTLE_EFFECT_DIVE, BATTLE_EFFECT_FLINCH_BURN_HIT, BATTLE_EFFECT_FLY,
  BATTLE_EFFECT_SKIP_CHARGE_TURN_IN_SUN, FIELD_CONDITION_GRAVITY, HOLD_EFFECT_POWER_UP_SE,
  HOLD_EFFECT_SPEED_DOWN_GROUNDED, ITEM_POWER_CHECK_ALL, MOVE_EFFECT_INGRAIN, MOVE_EFFECT_MIRACLE_EYE,
  MOVE_STATUS_BASIC_EFFECTIVENESS, MOVE_STATUS_INEFFECTIVE, MOVE_STATUS_LEVITATED, MOVE_STATUS_MAGNET_RISE,
  MOVE_STATUS_NOT_VERY_EFFECTIVE, MOVE_STATUS_SUPER_EFFECTIVE, MOVE_STATUS_WONDER_GUARD, MOVE_STRUGGLE,
  SYSCTL_IGNORE_IMMUNITIES, SYSCTL_IGNORE_TYPE_CHECKS, SYSCTL_LAST_OF_MULTI_TURN, TYPE_DARK, TYPE_FLYING, TYPE_GROUND,
  TYPE_MULTI_IMMUNE, TYPE_MULTI_NOT_VERY_EFF, TYPE_MULTI_SUPER_EFF, TYPE_NORMAL, VOLATILE_CONDITION_FORESIGHT,
} from '../constants.js';
import { AiError } from '../errors.js';
import { cdiv, u32, u8 } from '../int.js';
import type { TypeChart } from '../rom/typeChart.js';
import type { AiDeps, AiView } from '../view.js';
import {
  battleMon, battlerAbility, battlerType, heldItemEffect, heldItemPower, ignorableAbility, moveData,
} from './battler.js';

type ChartRow = TypeChart[number];

/** The chart row before the Ghost immunities that Foresight and Scrappy skip (battle_lib.c:2509–2514). */
const SEPARATOR = 0xfe;

/** BattleSystem_Divide, battle_lib.c:3599: C division, except that a non-zero dividend never gives 0 (±1 instead). */
export function battleDivide(dividend: number, divisor: number): number {
  if (dividend === 0) return dividend; // :3601–3603
  const signedFloor = dividend < 0 ? -1 : 1; // :3606–3610
  const quotient = cdiv(dividend, divisor); // :3612
  return quotient === 0 ? signedFloor : quotient; // :3614–3618
}

/** MON_HAS_TYPE (include/battle/common.h:53): either of the battler's types, as BattleMon_Get reads them, is `type`. */
export function monHasType(v: AiView, d: AiDeps, battler: number, type: number): boolean {
  return battlerType(v, d, battler, 1) === type || battlerType(v, d, battler, 2) === type;
}

/** The effects MoveIsOnDamagingTurn (battle_lib.c:7590–7600) treats as two-turn moves, Fire Fang's included (the bug at :7600). */
const TWO_TURN_EFFECTS: ReadonlySet<number> = new Set([
  BATTLE_EFFECT_BIDE, BATTLE_EFFECT_CHARGE_TURN_HIGH_CRIT, BATTLE_EFFECT_CHARGE_TURN_HIGH_CRIT_FLINCH,
  BATTLE_EFFECT_CHARGE_TURN_DEF_UP, BATTLE_EFFECT_SKIP_CHARGE_TURN_IN_SUN, BATTLE_EFFECT_FLY, BATTLE_EFFECT_DIVE,
  BATTLE_EFFECT_DIG, BATTLE_EFFECT_BOUNCE, BATTLE_EFFECT_FLINCH_BURN_HIT,
]);

/** MoveIsOnDamagingTurn, battle_lib.c:7588: a two-turn move hits only on its last turn; every other move hits. */
function moveIsOnDamagingTurn(d: AiDeps, move: number, statusMask: number): boolean {
  if (TWO_TURN_EFFECTS.has(moveData(d, move).effect)) return (statusMask & SYSCTL_LAST_OF_MULTI_TURN) !== 0; // :7601
  return true; // :7605
}

/** BasicTypeMulApplies, battle_lib.c:2529: whether no effect on `defender` overrides chart row `row`. */
function basicTypeMulApplies(v: AiView, d: AiDeps, defender: number, row: ChartRow): boolean {
  const itemEffect = heldItemEffect(v, d, defender); // :2531
  const mon = battleMon(v, defender);
  const [, defending, mul] = row;
  let result = true;
  // :2534–2538: Iron Ball or Ingrain grounds a Flying-type.
  if ((itemEffect === HOLD_EFFECT_SPEED_DOWN_GROUNDED || (mon.moveEffectsMask & MOVE_EFFECT_INGRAIN) !== 0)
    && defending === TYPE_FLYING && mul === TYPE_MULTI_IMMUNE) result = false;
  // :2540–2543: Roost drops every Flying-type row.
  const turnFlags = v.turnFlags[defender];
  if (turnFlags === undefined) throw new AiError('BAD_VIEW', `no turnFlags for battler ${defender}`);
  if (turnFlags.roosting && defending === TYPE_FLYING) result = false;
  // :2545–2549: Gravity grounds a Flying-type.
  if ((v.fieldConditionsMask & FIELD_CONDITION_GRAVITY) !== 0 && defending === TYPE_FLYING && mul === TYPE_MULTI_IMMUNE) result = false;
  // :2551–2555: Miracle Eye drops the Dark-type immunity.
  if ((mon.moveEffectsMask & MOVE_EFFECT_MIRACLE_EYE) !== 0 && defending === TYPE_DARK && mul === TYPE_MULTI_IMMUNE) result = false;
  return result;
}

/** ApplyTypeMultiplier, battle_lib.c:7542: scales `damage` by `mul` / 10 and updates the effectiveness flags. */
function applyTypeMultiplier(statusMask: number, mul: number, damage: number, update: boolean, flags: number): [number, number] {
  if ((statusMask & SYSCTL_IGNORE_TYPE_CHECKS) === 0 && (statusMask & SYSCTL_IGNORE_IMMUNITIES) === 0 && damage !== 0) {
    damage = battleDivide(Math.imul(damage, mul), 10); // :7544–7548
  }
  switch (mul) {
    case TYPE_MULTI_IMMUNE: // :7551–7555
      flags |= MOVE_STATUS_INEFFECTIVE;
      flags &= ~MOVE_STATUS_NOT_VERY_EFFECTIVE;
      flags &= ~MOVE_STATUS_SUPER_EFFECTIVE;
      break;
    case TYPE_MULTI_NOT_VERY_EFF: // :7557–7565
      if (update) {
        if ((flags & MOVE_STATUS_SUPER_EFFECTIVE) !== 0) flags &= ~MOVE_STATUS_SUPER_EFFECTIVE;
        else flags |= MOVE_STATUS_NOT_VERY_EFFECTIVE;
      }
      break;
    case TYPE_MULTI_SUPER_EFF: // :7567–7575
      if (update) {
        if ((flags & MOVE_STATUS_NOT_VERY_EFFECTIVE) !== 0) flags &= ~MOVE_STATUS_NOT_VERY_EFFECTIVE;
        else flags |= MOVE_STATUS_SUPER_EFFECTIVE;
      }
      break;
    default:
  }
  return [damage, flags];
}

/**
 * BattleSystem_ApplyTypeChart, battle_lib.c:2560: `damage` after STAB, the type chart and the abilities and items that
 * act on effectiveness, with the MOVE_STATUS_* flags it sets (the C ORs them into a caller's mask; every AI caller
 * starts it at 0). `inType` 0 means the move's own type.
 *
 * `statusMask` is BattleContext.battleStatusMask, the view's by default. TrainerAI_CalcDamage sets
 * SYSCTL_IGNORE_TYPE_CHECKS around one call (trainer_ai.c:3081–3112), so it passes its own run-local mask here and the
 * helper stays pure.
 */
export function applyTypeChart(
  v: AiView, d: AiDeps, move: number, inType: number, attacker: number, defender: number, damage: number,
  statusMask: number = v.battleStatusMask,
): { damage: number; flags: number } {
  let flags = 0;
  // totalMul (:2563, :2571, :2629–2631, :2639–2641) is computed and never read: left out.
  if (move === MOVE_STRUGGLE) return { damage, flags }; // :2573–2575

  const attackerItemEffect = u8(heldItemEffect(v, d, attacker)); // :2577
  const attackerItemPower = u8(heldItemPower(v, d, attacker, ITEM_POWER_CHECK_ALL)); // :2578
  const defenderItemEffect = u8(heldItemEffect(v, d, defender)); // :2579
  // :2580 also reads the defender's item power, which nothing uses (the same item as :2579).

  let moveType: number; // :2582–2588
  if (battlerAbility(v, attacker) === ABILITY_NORMALIZE) moveType = TYPE_NORMAL;
  else if (inType !== 0) moveType = u8(inType);
  else moveType = u8(moveData(d, move).type);
  const movePower = u32(moveData(d, move).power); // :2590

  // :2592–2598: STAB.
  if ((statusMask & SYSCTL_IGNORE_TYPE_CHECKS) === 0 && monHasType(v, d, attacker, moveType)) {
    if (battlerAbility(v, attacker) === ABILITY_ADAPTABILITY) damage = Math.imul(damage, 2);
    else damage = cdiv(Math.imul(damage, 15), 10);
  }

  const def = battleMon(v, defender);
  if (ignorableAbility(v, attacker, defender, ABILITY_LEVITATE) && moveType === TYPE_GROUND
    && defenderItemEffect !== HOLD_EFFECT_SPEED_DOWN_GROUNDED) {
    flags |= MOVE_STATUS_LEVITATED; // :2600–2603
  } else if (def.effects.magnetRiseTurns !== 0 && (def.moveEffectsMask & MOVE_EFFECT_INGRAIN) === 0
    && moveType === TYPE_GROUND && defenderItemEffect !== HOLD_EFFECT_SPEED_DOWN_GROUNDED) {
    flags |= MOVE_STATUS_MAGNET_RISE; // :2604–2608
  } else {
    // :2610–2646. The chart ends where the C's loop stops, at the 0xFF terminator.
    for (const row of d.typeChart) {
      const [attacking, defending, mul] = row;
      if (attacking === SEPARATOR) { // :2613–2622: the Ghost immunities are skipped as a batch
        if ((def.statusVolatile & VOLATILE_CONDITION_FORESIGHT) !== 0 || battlerAbility(v, attacker) === ABILITY_SCRAPPY) break;
        continue;
      }
      if (attacking !== moveType) continue; // :2624
      if (defending === battlerType(v, d, defender, 1) && basicTypeMulApplies(v, d, defender, row)) { // :2625–2632
        [damage, flags] = applyTypeMultiplier(statusMask, mul, damage, movePower !== 0, flags);
      }
      if (defending === battlerType(v, d, defender, 2) // :2634–2642
        && battlerType(v, d, defender, 1) !== battlerType(v, d, defender, 2)
        && basicTypeMulApplies(v, d, defender, row)) {
        [damage, flags] = applyTypeMultiplier(statusMask, mul, damage, movePower !== 0, flags);
      }
    }
  }

  if (ignorableAbility(v, attacker, defender, ABILITY_WONDER_GUARD) && moveIsOnDamagingTurn(d, move, statusMask)
    && ((flags & MOVE_STATUS_SUPER_EFFECTIVE) === 0
      || (flags & MOVE_STATUS_BASIC_EFFECTIVENESS) === MOVE_STATUS_BASIC_EFFECTIVENESS)
    && movePower !== 0) {
    flags |= MOVE_STATUS_WONDER_GUARD; // :2649–2654
  } else if ((statusMask & SYSCTL_IGNORE_TYPE_CHECKS) === 0 && (statusMask & SYSCTL_IGNORE_IMMUNITIES) === 0) { // :2655–2656
    if ((flags & MOVE_STATUS_SUPER_EFFECTIVE) !== 0 && movePower !== 0) { // :2657
      if (ignorableAbility(v, attacker, defender, ABILITY_FILTER) || ignorableAbility(v, attacker, defender, ABILITY_SOLID_ROCK)) {
        damage = battleDivide(Math.imul(damage, 3), 4); // :2658–2661
      }
      if (attackerItemEffect === HOLD_EFFECT_POWER_UP_SE) {
        damage = cdiv(Math.imul(damage, 100 + attackerItemPower), 100); // :2663–2665
      }
    }
    if ((flags & MOVE_STATUS_NOT_VERY_EFFECTIVE) !== 0 && movePower !== 0) { // :2668
      if (battlerAbility(v, attacker) === ABILITY_TINTED_LENS) damage = Math.imul(damage, 2); // :2669–2671
    }
  } else {
    flags &= ~MOVE_STATUS_SUPER_EFFECTIVE; // :2674
    flags &= ~MOVE_STATUS_NOT_VERY_EFFECTIVE; // :2675
  }

  return { damage, flags: u32(flags) };
}

/** NoImmunityOverrides, battle_lib.c:2756: whether neither Iron Ball nor Gravity drops chart row `row`'s Flying immunity. */
function noImmunityOverrides(v: AiView, itemEffect: number, row: ChartRow): boolean {
  const [, defending, mul] = row;
  let result = true;
  if (itemEffect === HOLD_EFFECT_SPEED_DOWN_GROUNDED && defending === TYPE_FLYING && mul === TYPE_MULTI_IMMUNE) result = false; // :2760–2764
  if ((v.fieldConditionsMask & FIELD_CONDITION_GRAVITY) !== 0 && defending === TYPE_FLYING && mul === TYPE_MULTI_IMMUNE) result = false; // :2766–2770
  return result;
}

/** UpateMoveStatusForTypeMul (sic), battle_lib.c:2781: the flags ApplyTypeMultiplier sets, without the damage. */
function updateMoveStatusForTypeMul(mul: number, flags: number): number {
  switch (mul) {
    case TYPE_MULTI_IMMUNE: // :2784–2788
      flags |= MOVE_STATUS_INEFFECTIVE;
      flags &= ~MOVE_STATUS_NOT_VERY_EFFECTIVE;
      flags &= ~MOVE_STATUS_SUPER_EFFECTIVE;
      break;
    case TYPE_MULTI_NOT_VERY_EFF: // :2790–2796
      if ((flags & MOVE_STATUS_SUPER_EFFECTIVE) !== 0) flags &= ~MOVE_STATUS_SUPER_EFFECTIVE;
      else flags |= MOVE_STATUS_NOT_VERY_EFFECTIVE;
      break;
    case TYPE_MULTI_SUPER_EFF: // :2798–2804
      if ((flags & MOVE_STATUS_NOT_VERY_EFFECTIVE) !== 0) flags &= ~MOVE_STATUS_NOT_VERY_EFFECTIVE;
      else flags |= MOVE_STATUS_SUPER_EFFECTIVE;
      break;
    default:
  }
  return flags;
}

/**
 * BattleSystem_CalcEffectiveness, battle_lib.c:2681: the MOVE_STATUS_* mask for `move` against the given ability, item
 * effect and types (the C ORs into a caller's mask; every AI caller starts it at 0). `inType` 0 means the move's own
 * type. The C also reads battleCtx's fieldConditionsMask (Gravity) and battleStatusMask (MoveIsOnDamagingTurn), so
 * this takes the view, and `statusMask` as applyTypeChart does.
 */
export function calcEffectiveness(
  v: AiView, d: AiDeps, move: number, inType: number, attackerAbility: number, defenderAbility: number,
  defenderItemEffect: number, defType1: number, defType2: number, statusMask: number = v.battleStatusMask,
): number {
  let flags = 0;
  if (move === MOVE_STRUGGLE) return flags; // :2686–2688

  let moveType: number; // :2690–2696
  if (attackerAbility === ABILITY_NORMALIZE) moveType = TYPE_NORMAL;
  else if (inType !== 0) moveType = u8(inType);
  else moveType = u8(moveData(d, move).type);

  if (attackerAbility !== ABILITY_MOLD_BREAKER && defenderAbility === ABILITY_LEVITATE && moveType === TYPE_GROUND
    && (v.fieldConditionsMask & FIELD_CONDITION_GRAVITY) === 0 && defenderItemEffect !== HOLD_EFFECT_SPEED_DOWN_GROUNDED) {
    flags |= MOVE_STATUS_INEFFECTIVE; // :2698–2703
  } else {
    for (const row of d.typeChart) { // :2705–2731
      const [attacking, defending, mul] = row;
      if (attacking === SEPARATOR) { // :2708–2715: only Scrappy skips the Ghost immunities here
        if (attackerAbility === ABILITY_SCRAPPY) break;
        continue;
      }
      if (attacking !== moveType) continue; // :2717
      if (defending === defType1 && noImmunityOverrides(v, defenderItemEffect, row)) { // :2718–2721
        flags = updateMoveStatusForTypeMul(mul, flags);
      }
      if (defending === defType2 && defType1 !== defType2 && noImmunityOverrides(v, defenderItemEffect, row)) { // :2723–2727
        flags = updateMoveStatusForTypeMul(mul, flags);
      }
    }
  }

  // :2734–2740: Wonder Guard, with no move-power check here.
  if (attackerAbility !== ABILITY_MOLD_BREAKER && defenderAbility === ABILITY_WONDER_GUARD
    && moveIsOnDamagingTurn(d, move, statusMask)
    && ((flags & MOVE_STATUS_SUPER_EFFECTIVE) === 0
      || (flags & MOVE_STATUS_BASIC_EFFECTIVENESS) === MOVE_STATUS_BASIC_EFFECTIVENESS)) {
    flags |= MOVE_STATUS_INEFFECTIVE;
  }

  return u32(flags);
}

/**
 * BattleSystem_TypeMatchupMultiplier, battle_lib.c:3009: 40 times each matching row's multiplier / 10. Every row to the
 * terminator counts, the Ghost immunities after the separator included (there is no Foresight check here).
 */
export function typeMatchupMultiplier(d: AiDeps, attacking: number, def1: number, def2: number): number {
  const attackingType = u8(attacking);
  const defendingType1 = u8(def1);
  const defendingType2 = u8(def2);
  let mul = 40; // :3012
  for (const [rowAttacking, rowDefending, rowMul] of d.typeChart) { // :3014–3027
    if (rowAttacking === attackingType) {
      if (rowDefending === defendingType1) mul = cdiv(mul * rowMul, 10); // :3016–3018
      if (rowDefending === defendingType2 && defendingType1 !== defendingType2) mul = cdiv(mul * rowMul, 10); // :3020–3023
    }
  }
  return mul;
}
