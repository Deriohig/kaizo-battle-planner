// BattleSystem_CompareBattlerSpeed as the trainer AI calls it (ignoreQuickClaw = TRUE: trainer_ai.c:1109, 1121, 2081),
// and the hidden draws the AI reads that the view can't hold. Literal ports over AiView; each rule cites its C line.
// Nothing here writes to the view. readQuickClaw fixes entries of the run's own Latents, so a run reads one draw once.

import {
  ABILITY_CHLOROPHYLL, ABILITY_GLUTTONY, ABILITY_QUICK_FEET, ABILITY_SIMPLE, ABILITY_SLOW_START, ABILITY_STALL,
  ABILITY_SWIFT_SWIM, ABILITY_UNBURDEN, BATTLE_STAT, COMPARE_SPEED_FASTER, COMPARE_SPEED_SLOWER, COMPARE_SPEED_TIE,
  DEFAULT_STAT_STAGE, FIELD_CONDITION_TRICK_ROOM, HOLD_EFFECT_CHOICE_SPEED, HOLD_EFFECT_DITTO_SPEED_UP,
  HOLD_EFFECT_EVS_UP_SPEED_DOWN, HOLD_EFFECT_LVLUP_ATK_EV_UP, HOLD_EFFECT_LVLUP_DEF_EV_UP, HOLD_EFFECT_LVLUP_HP_EV_UP,
  HOLD_EFFECT_LVLUP_SPATK_EV_UP, HOLD_EFFECT_LVLUP_SPDEF_EV_UP, HOLD_EFFECT_LVLUP_SPEED_EV_UP, HOLD_EFFECT_PINCH_PRIORITY,
  HOLD_EFFECT_PRIORITY_DOWN, HOLD_EFFECT_SOMETIMES_PRIORITY, HOLD_EFFECT_SPEED_DOWN_GROUNDED, ITEM_NONE,
  ITEM_POWER_CHECK_ALL, MAX_STAT_STAGE, MIN_STAT_STAGE, MON_CONDITION_ANY, MON_CONDITION_PARALYSIS, SIDE_CONDITION_TAILWIND,
  SPECIES_DITTO,
} from '../constants.js';
import type { Pick } from '../enumerate.js';
import { AiError } from '../errors.js';
import { cdiv, u32, u8 } from '../int.js';
import { residueWeights, U16 } from '../odds.js';
import type { AiDeps, AiView } from '../view.js';
import {
  battleMon, battlerAbility, battlerSide, heldItemEffect, heldItemPower, itemData, noCloudNine, weatherIs,
} from './battler.js';
import { PATHS, requireKnown } from './known.js';

/**
 * The hidden draws a run has fixed, by index; null = not fixed yet on this path. `rolls` (by move slot) are
 * AI_CONTEXT.moveDamageRolls (trainer_ai.c:240); `quickClaw` (by battler) is whether that battler's Quick Claw fires
 * this turn (speedRand, battle_lib.c:1279). The helpers that read a latent fix it here in place, so give each run of
 * `enumerate` its own Latents.
 */
export interface Latents { rolls: (number | null)[]; quickClaw: (boolean | null)[] } // 4 each; null = not fixed yet on this path

/** sStatStageBoosts, battle_lib.c:6550–6564: [numerator, denominator] by stage 0–12 (6 = neutral). */
export const STAT_STAGE_BOOSTS: readonly (readonly [number, number])[] = Object.freeze([
  [10, 40], [10, 35], [10, 30], [10, 25], [10, 20], [10, 15], [10, 10], [15, 10], [20, 10], [25, 10], [30, 10], [35, 10],
  [40, 10],
] as const);

/** sStatStageBoosts[stage]; AiError('BAD_VIEW') outside 0–12, where the C would read past the table. */
export function statStageBoost(stage: number): readonly [number, number] {
  const boost = STAT_STAGE_BOOSTS[stage];
  if (boost === undefined) throw new AiError('BAD_VIEW', `stat stage ${stage} is outside 0–12`);
  return boost;
}

/** sSpeedHalvingItemEffects, battle_lib.c:1160–1169. */
const SPEED_HALVING_ITEM_EFFECTS: readonly number[] = Object.freeze([
  HOLD_EFFECT_EVS_UP_SPEED_DOWN, HOLD_EFFECT_SPEED_DOWN_GROUNDED, HOLD_EFFECT_LVLUP_HP_EV_UP, HOLD_EFFECT_LVLUP_ATK_EV_UP,
  HOLD_EFFECT_LVLUP_DEF_EV_UP, HOLD_EFFECT_LVLUP_SPEED_EV_UP, HOLD_EFFECT_LVLUP_SPATK_EV_UP, HOLD_EFFECT_LVLUP_SPDEF_EV_UP,
]);

/** `RandNext() & 1`: 32768 of the 65536 values each way. Index 1 is a set low bit. */
const COIN: readonly bigint[] = Object.freeze([32768n, 32768n]);

/**
 * Whether `battler`'s Quick Claw fires this turn: `speedRand[battler] % (100 / param) == 0` (battle_lib.c:1279, 1345),
 * `param` being the item's u8 effect parameter. The view's quickClawThisTurn when it is known. Otherwise the latent in
 * lat.quickClaw[battler], fixed on its first read with weights [#r%(100/param)==0, rest] over r in 0..65535 (speedRand
 * is one RandNext() per battler, battle_lib.c:2024 and battle_controller_player.c:853). AiError('DIV_ZERO') when
 * `100 / param` divides by zero or is zero, as the C's `%` then would.
 */
export function readQuickClaw(v: AiView, lat: Latents, battler: number, param: number, pick: Pick): boolean {
  const modulus = cdiv(100, u8(param)); // `100 / battlerItemParam`
  if (modulus === 0) throw new AiError('DIV_ZERO', `speedRand % (100 / ${param}): the divisor is 0`);
  const known = v.quickClawThisTurn[battler];
  if (known === undefined) throw new AiError('BAD_VIEW', `no quickClawThisTurn for battler ${battler}`);
  if (known !== null) return known;
  const fixed = lat.quickClaw[battler];
  if (fixed !== null && fixed !== undefined) return fixed;
  const fires = residueWeights(modulus)[0]!; // #{r in 0..65535 : r % modulus == 0}
  const fired = pick([fires, U16 - fires]) === 0;
  lat.quickClaw[battler] = fired;
  return fired;
}

/** CompareSpeed_ApplySimple, battle_lib.c:1171: Simple doubles the stage's distance from neutral, clamped to 0–12. */
function applySimple(v: AiView, battler: number, stage: number): number {
  if (battlerAbility(v, battler) === ABILITY_SIMPLE) {
    stage = DEFAULT_STAT_STAGE + (stage - DEFAULT_STAT_STAGE) * 2; // :1174
    if (stage > MAX_STAT_STAGE) stage = MAX_STAT_STAGE; // :1176–1178
    if (stage < MIN_STAT_STAGE) stage = MIN_STAT_STAGE; // :1180–1182
  }
  return stage;
}

/** One battler's speed after its item, status, ability and side modifiers, and its move-order flags. */
interface OrderInputs { speed: number; quickClaw: boolean; laggingTail: boolean }

/**
 * The per-battler block of BattleSystem_CompareBattlerSpeed: battle_lib.c:1240–1304 for battler 1, and the same at
 * :1306–1370 for battler 2. `speed` is the u32 speed after the stage and weather steps.
 */
function orderInputs(
  v: AiView, d: AiDeps, lat: Latents, battler: number, ability: number, itemEffect: number, itemParam: number,
  speed: number, pick: Pick,
): OrderInputs {
  const mon = battleMon(v, battler);
  // :1240–1246: the raw held item, with no Klutz or Embargo check.
  if (SPEED_HALVING_ITEM_EFFECTS.includes(itemData(d, mon.heldItem, 'holdEffect'))) speed = cdiv(speed, 2);
  if (itemEffect === HOLD_EFFECT_CHOICE_SPEED) speed = cdiv(u32(Math.imul(speed, 15)), 10); // :1248–1250
  if (itemEffect === HOLD_EFFECT_DITTO_SPEED_UP && mon.species === SPECIES_DITTO) speed = u32(Math.imul(speed, 2)); // :1252–1255
  if (ability === ABILITY_QUICK_FEET && (mon.status & MON_CONDITION_ANY) !== 0) {
    speed = cdiv(u32(Math.imul(speed, 15)), 10); // :1257–1258
  } else if ((mon.status & MON_CONDITION_PARALYSIS) !== 0) {
    speed = cdiv(speed, 4); // :1259–1261
  }
  // :1263–1266: int arithmetic, so a switch-in this turn (slowStartTurnNumber = totalTurns + 1) gives -1 < 5. The turn
  // number is unknown after a Transform, which resets it (battle_script.c:5360) when the state doesn't say.
  if (ability === ABILITY_SLOW_START) {
    requireKnown(v, PATHS.slowStartTurnNumber(battler));
    if (v.totalTurns - mon.effects.slowStartTurnNumber < 5) speed = cdiv(speed, 2);
  }
  if (ability === ABILITY_UNBURDEN && mon.effects.canUnburden && mon.heldItem === ITEM_NONE) speed = u32(Math.imul(speed, 2)); // :1268–1272
  const sideMask = v.sideConditionsMask[battlerSide(battler)];
  if (sideMask === undefined) throw new AiError('BAD_VIEW', `no sideConditionsMask for battler ${battler}`);
  if ((sideMask & SIDE_CONDITION_TAILWIND) !== 0) speed = u32(Math.imul(speed, 2)); // :1274–1276

  let quickClaw = false;
  // :1278–1286: this turn's draw; with ignoreQuickClaw TRUE nothing is written to moveEffectsData.
  if (itemEffect === HOLD_EFFECT_SOMETIMES_PRIORITY && readQuickClaw(v, lat, battler, itemParam, pick)) quickClaw = true;
  if (itemEffect === HOLD_EFFECT_PINCH_PRIORITY) { // :1288–1300
    if (battlerAbility(v, battler) === ABILITY_GLUTTONY) itemParam = u8(cdiv(itemParam, 2)); // :1289–1291
    // :1293: s32 curHP against the u32 maxHP / param, an unsigned comparison.
    if (u32(mon.curHP) <= cdiv(u32(mon.maxHP), itemParam)) quickClaw = true;
  }
  const laggingTail = itemEffect === HOLD_EFFECT_PRIORITY_DOWN; // :1302–1304
  return { speed, quickClaw, laggingTail };
}

/**
 * BattleSystem_CompareBattlerSpeed(battleSys, battleCtx, b1, b2, ignoreQuickClaw = TRUE), battle_lib.c:1188:
 * COMPARE_SPEED_FASTER, _SLOWER or _TIE for b1 against b2. An exact tie in a branch that draws asks
 * `pick([32768n, 32768n])` where the C calls `RandNext() & 1`; a Quick Claw holder reads `readQuickClaw`.
 *
 * `speeds` is what the C writes to monSpeedValues[b1] and [b2] (:1372–1373); the caller stores it in its run-local
 * copy. It is null when the C returns before writing them, as it does when exactly one battler has fainted
 * (:1205–1211).
 */
export function compareSpeed(
  v: AiView, d: AiDeps, lat: Latents, b1: number, b2: number, pick: Pick,
): { result: number; speeds: [number, number] | null } {
  const mon1 = battleMon(v, b1);
  const mon2 = battleMon(v, b2);
  // :1204–1211: a fainted battler loses to a living one, with nothing written.
  if (mon1.curHP === 0 && mon2.curHP !== 0) return { result: COMPARE_SPEED_SLOWER, speeds: null };
  if (mon1.curHP !== 0 && mon2.curHP === 0) return { result: COMPARE_SPEED_FASTER, speeds: null };

  const ability1 = battlerAbility(v, b1); // :1213
  const ability2 = battlerAbility(v, b2); // :1214
  const itemEffect1 = u8(heldItemEffect(v, d, b1)); // :1215
  const itemParam1 = u8(heldItemPower(v, d, b1, ITEM_POWER_CHECK_ALL)); // :1216
  const itemEffect2 = u8(heldItemEffect(v, d, b2)); // :1217
  const itemParam2 = u8(heldItemPower(v, d, b2, ITEM_POWER_CHECK_ALL)); // :1218
  const stage1 = applySimple(v, b1, mon1.statBoosts[BATTLE_STAT.SPEED]!); // :1219, 1222
  const stage2 = applySimple(v, b2, mon2.statBoosts[BATTLE_STAT.SPEED]!); // :1220, 1223

  const [num1, den1] = statStageBoost(stage1);
  const [num2, den2] = statStageBoost(stage2);
  let speed1 = u32(cdiv(mon1.speed * num1, den1)); // :1225
  let speed2 = u32(cdiv(mon2.speed * num2, den2)); // :1226

  if (noCloudNine(v)) { // :1228–1238
    if ((ability1 === ABILITY_SWIFT_SWIM && weatherIs(v, 'rain')) || (ability1 === ABILITY_CHLOROPHYLL && weatherIs(v, 'sun'))) {
      speed1 = u32(Math.imul(speed1, 2));
    }
    if ((ability2 === ABILITY_SWIFT_SWIM && weatherIs(v, 'rain')) || (ability2 === ABILITY_CHLOROPHYLL && weatherIs(v, 'sun'))) {
      speed2 = u32(Math.imul(speed2, 2));
    }
  }

  const first = orderInputs(v, d, lat, b1, ability1, itemEffect1, itemParam1, speed1, pick); // :1240–1304
  const second = orderInputs(v, d, lat, b2, ability2, itemEffect2, itemParam2, speed2, pick); // :1306–1370
  speed1 = first.speed;
  speed2 = second.speed;
  const speeds: [number, number] = [speed1, speed2]; // :1372–1373

  // ignoreQuickClaw is TRUE, so :1375–1399 is skipped and both priorities stay 0 (:1195): the test at :1401 always
  // holds and :1449–1451 never runs.
  // A tie draws a coin, pick(COIN) === 1, where it is tested (no closure per compare: tsx keepNames).
  const equal = speed1 === speed2;
  let result = COMPARE_SPEED_FASTER; // :1190
  if (first.quickClaw && second.quickClaw) { // :1402–1407
    if (speed1 < speed2) result = COMPARE_SPEED_SLOWER;
    else if (equal && pick(COIN) === 1) result = COMPARE_SPEED_TIE;
  } else if (!first.quickClaw && second.quickClaw) { // :1408–1409
    result = COMPARE_SPEED_SLOWER;
  } else if (first.quickClaw && !second.quickClaw) { // :1410–1411
    result = COMPARE_SPEED_FASTER;
  } else if (first.laggingTail && second.laggingTail) { // :1412–1417
    if (speed1 > speed2) result = COMPARE_SPEED_SLOWER;
    else if (equal && pick(COIN) === 1) result = COMPARE_SPEED_TIE;
  } else if (first.laggingTail && !second.laggingTail) { // :1418–1419
    result = COMPARE_SPEED_SLOWER;
  } else if (!first.laggingTail && second.laggingTail) { // :1420–1421
    result = COMPARE_SPEED_FASTER;
  } else if (ability1 === ABILITY_STALL && ability2 === ABILITY_STALL) { // :1422–1427
    if (speed1 > speed2) result = COMPARE_SPEED_SLOWER;
    else if (equal && pick(COIN) === 1) result = COMPARE_SPEED_TIE;
  } else if (ability1 === ABILITY_STALL && ability2 !== ABILITY_STALL) { // :1428–1429
    result = COMPARE_SPEED_SLOWER;
  } else if (ability1 !== ABILITY_STALL && ability2 === ABILITY_STALL) { // :1430–1431
    result = COMPARE_SPEED_FASTER;
  } else if ((v.fieldConditionsMask & FIELD_CONDITION_TRICK_ROOM) !== 0) { // :1432–1439
    if (speed1 > speed2) result = COMPARE_SPEED_SLOWER;
    if (equal && pick(COIN) === 1) result = COMPARE_SPEED_TIE;
  } else { // :1440–1448
    if (speed1 < speed2) result = COMPARE_SPEED_SLOWER;
    if (equal && pick(COIN) === 1) result = COMPARE_SPEED_TIE;
  }
  return { result, speeds };
}
