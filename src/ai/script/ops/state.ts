// The AI script commands that read battle state with no damage, speed, ability, party or knowledge helper: HP, status,
// side and field conditions, stat stages, stored stats, types, levels, move data, turn counters and the switching mask.
// Literal ports of the AICmd_* handlers in trainer_ai.c over AiView; each cites its lines. Every handler starts as the C
// does, with AIScript_Iter(1) past its opcode, and reads its arguments in the C's order. The GF_ASSERTs in these
// handlers are compiled out.

import {
  AI_WEATHER_CLEAR, AI_WEATHER_DEEP_FOG, AI_WEATHER_HAILING, AI_WEATHER_RAINING, AI_WEATHER_SANDSTORM, AI_WEATHER_SUNNY,
  BATTLE_STAT, BATTLE_STAT_MAX, CHECK_DISABLE, CHECK_ENCORE, CHECK_EQUAL_TO_TARGET, CHECK_HIGHER_THAN_TARGET,
  CHECK_LOWER_THAN_TARGET, LEARNED_MOVES_MAX, LOAD_ATTACKER_PARTNER_TYPE_1, LOAD_ATTACKER_PARTNER_TYPE_2,
  LOAD_ATTACKER_TYPE_1, LOAD_ATTACKER_TYPE_2, LOAD_DEFENDER_PARTNER_TYPE_1, LOAD_DEFENDER_PARTNER_TYPE_2,
  LOAD_DEFENDER_TYPE_1, LOAD_DEFENDER_TYPE_2, LOAD_MOVE_TYPE, MOVE_DETECT, MOVE_EFFECT_IMPRISONED, MOVE_ENDURE, MOVE_NONE,
  MOVE_PROTECT, moveClass, SIDE_CONDITION_SPIKES, SIDE_CONDITION_TOXIC_SPIKES,
} from '../../constants.js';
import { AiError } from '../../errors.js';
import { u32, udivCartridge } from '../../int.js';
import {
  anyFieldBit, battleMon, battlerSide, battlerType, countMoves, moveData, partner, weatherIs,
} from '../../lib/battler.js';
import { PATHS, requireKnown } from '../../lib/known.js';
import type { AiBattleMon } from '../../view.js';
import type { OpHandler, OpTable, RunCtx } from '../run.js';

/** `values[i]`; AiError('BAD_VIEW') when the view has no such entry. */
export function entry<T>(values: readonly T[], i: number, what: string): T {
  const value = values[i];
  if (value === undefined) throw new AiError('BAD_VIEW', `the view has no ${what}[${i}]`);
  return value;
}

/**
 * `battleMons[b].statBoosts[stat]` with `stat` from the script. Outside 0–7 the C reads past the array into the
 * BattleMon fields after it, which the view doesn't hold: AiError('UNDEFINED').
 */
function statStage(mon: AiBattleMon, stat: number): number {
  if (stat < 0 || stat >= BATTLE_STAT_MAX) throw new AiError('UNDEFINED', `stat ${stat} reads past BattleMon.statBoosts`);
  return entry(mon.statBoosts, stat, 'statBoosts');
}

/**
 * `u32 hpPercent = curHP * 100 / maxHP` (trainer_ai.c:596): the s32 product is converted to u32 against the u32 maxHP,
 * so the division is unsigned. The cartridge divides with `_u32_div_f` at ARM9 0x020E2178, where x / 0 = x (udivCartridge), so HP 0/0 (an empty partner slot in singles) is 0%. Each of the four AICmd_IfHPPercent* handlers in
 * the hack's overlay 14 makes that call, found by following sAICommandTable (overlay 14 offset 0xF28C) to the handler
 * and decoding its Thumb BLX:
 * - IfHPPercentLessThan (opcode 5, handler 0x022202B8): BLX 0x020E2178 at 0x022202F8;
 * - IfHPPercentGreaterThan (opcode 6, handler 0x02220310): BLX 0x020E2178 at 0x02220350;
 * - IfHPPercentEqualTo (opcode 7, handler 0x02220368): BLX 0x020E2178 at 0x022203A8;
 * - IfHPPercentNotEqualTo (opcode 8, handler 0x022203C0): BLX 0x020E2178 at 0x02220400.
 */
function hpPercent(ctx: RunCtx, battler: number): number {
  const mon = battleMon(ctx.v, battler);
  return udivCartridge(Math.imul(mon.curHP, 100), mon.maxHP);
}

/** AICmd_IfHPPercent*: `int targetPercent` is compared as a u32 with the u32 hpPercent (trainer_ai.c:588–646). */
function ifHpPercent(test: (hpPercent: number, targetPercent: number) => boolean): OpHandler {
  return (ctx) => {
    ctx.iter(1);
    const inBattler = ctx.read();
    const targetPercent = ctx.read();
    const jump = ctx.read();
    const battler = ctx.battler(inBattler);
    if (test(hpPercent(ctx, battler), u32(targetPercent))) ctx.iter(jump);
  };
}

/**
 * AICmd_If[Not]Status, If[Not]VolatileStatus, If[Not]MoveEffect, If[Not]SideCondition: `field & mask`, jumping when it
 * is non-zero (`set`) or zero (trainer_ai.c:648–760). The masks are u32 in the C; a script word with bit 31 is negative
 * here, and `&` reads the same bits. `field` gets the mask too, to guard a bit that may be unknown.
 */
function ifMask(field: (ctx: RunCtx, battler: number, mask: number) => number, set: boolean): OpHandler {
  return (ctx) => {
    ctx.iter(1);
    const inBattler = ctx.read();
    const mask = ctx.read();
    const jump = ctx.read();
    const battler = ctx.battler(inBattler);
    if (((field(ctx, battler, mask) & mask) !== 0) === set) ctx.iter(jump);
  };
}

const status = (ctx: RunCtx, battler: number) => battleMon(ctx.v, battler).status;
const statusVolatile = (ctx: RunCtx, battler: number) => battleMon(ctx.v, battler).statusVolatile;
/** MOVE_EFFECT_IMPRISONED may be unknown (PATHS.imprisoned), so a mask that tests it is guarded. */
const moveEffectsMask = (ctx: RunCtx, battler: number, mask: number) => {
  if ((mask & MOVE_EFFECT_IMPRISONED) !== 0) requireKnown(ctx.v, PATHS.imprisoned(battler));
  return battleMon(ctx.v, battler).moveEffectsMask;
};
/** sideConditionsMask[BattleSystem_GetBattlerSide(battler)] (trainer_ai.c:740, 742). */
const sideConditionsMask = (ctx: RunCtx, battler: number) => entry(ctx.v.sideConditionsMask, battlerSide(battler), 'sideConditionsMask');

/** The search of AICmd_IfAttackerHasDamagingMoves and IfAttackerHasNoDamagingMoves: a move with power, PP ignored. */
function attackerHasDamagingMove(ctx: RunCtx): boolean {
  const moves = battleMon(ctx.v, ctx.attacker).moves;
  let i: number;
  for (i = 0; i < LEARNED_MOVES_MAX; i++) {
    const move = entry(moves, i, 'moves');
    if (move !== MOVE_NONE && moveData(ctx.d, move).power !== 0) break; // trainer_ai.c:902–905, 920–923
  }
  return i < LEARNED_MOVES_MAX;
}

/** AICmd_IfStatStage*: `statBoosts[stat]` against `int val` (trainer_ai.c:1465–1523). */
function ifStatStage(test: (stage: number, val: number) => boolean): OpHandler {
  return (ctx) => {
    ctx.iter(1);
    const inBattler = ctx.read();
    const stat = ctx.read();
    const val = ctx.read();
    const jump = ctx.read();
    const battler = ctx.battler(inBattler);
    if (test(statStage(battleMon(ctx.v, battler), stat), val)) ctx.iter(jump);
  };
}

/**
 * TrainerAI_GetStats (trainer_ai.c:2330): [the AI's, the battler's] stored value of `stat`, curHP for HP. Any other
 * stat only asserts (:2363–2365, compiled out) and leaves both values uninitialised: AiError('UNDEFINED').
 */
function storedStats(ctx: RunCtx, battler: number, stat: number): [number, number] {
  const ai = battleMon(ctx.v, ctx.attacker);
  const other = battleMon(ctx.v, battler);
  switch (stat) {
    case BATTLE_STAT.HP:
      return [ai.curHP, other.curHP]; // :2333–2336
    case BATTLE_STAT.ATTACK:
      return [ai.attack, other.attack]; // :2338–2341
    case BATTLE_STAT.DEFENSE:
      return [ai.defense, other.defense]; // :2343–2346
    case BATTLE_STAT.SP_ATTACK:
      return [ai.spAttack, other.spAttack]; // :2348–2351
    case BATTLE_STAT.SP_DEFENSE:
      return [ai.spDefense, other.spDefense]; // :2353–2356
    case BATTLE_STAT.SPEED:
      return [ai.speed, other.speed]; // :2358–2361
    default:
      throw new AiError('UNDEFINED', `TrainerAI_GetStats has no case for stat ${stat}: both stats are uninitialised (trainer_ai.c:2363–2365)`);
  }
}

/** AICmd_IfBattlerHas{Higher,Lower,Equal}Stat (trainer_ai.c:2270–2319). */
function ifStoredStat(test: (aiStat: number, battlerStat: number) => boolean): OpHandler {
  return (ctx) => {
    ctx.iter(1);
    const inBattler = ctx.read();
    const stat = ctx.read();
    const jump = ctx.read();
    const battler = ctx.battler(inBattler);
    const [aiStat, battlerStat] = storedStats(ctx, battler, stat);
    if (test(aiStat, battlerStat)) ctx.iter(jump);
  };
}

/** AICmd_IfBattlerFainted and IfBattlerNotFainted: `battlersSwitchingMask & FlagIndex(battler)` (trainer_ai.c:2438–2468). */
function ifSwitching(set: boolean): OpHandler {
  return (ctx) => {
    ctx.iter(1);
    const inBattler = ctx.read();
    const jump = ctx.read();
    // :2445–2446 and :2461–2462: GF_ASSERT(inBattler != AI_BATTLER_ATTACKER / _DEFENDER), compiled out.
    const battler = ctx.battler(inBattler);
    if (((ctx.v.battlersSwitchingMask & (1 << battler)) !== 0) === set) ctx.iter(jump);
  };
}

export const STATE_OPS: OpTable = {
  IfHPPercentLessThan: ifHpPercent((hp, target) => hp < target), // trainer_ai.c:588–601
  IfHPPercentGreaterThan: ifHpPercent((hp, target) => hp > target), // trainer_ai.c:603–616
  IfHPPercentEqualTo: ifHpPercent((hp, target) => hp === target), // trainer_ai.c:618–631
  IfHPPercentNotEqualTo: ifHpPercent((hp, target) => hp !== target), // trainer_ai.c:633–646

  IfStatus: ifMask(status, true), // trainer_ai.c:648–660
  IfNotStatus: ifMask(status, false), // trainer_ai.c:662–674
  IfVolatileStatus: ifMask(statusVolatile, true), // trainer_ai.c:676–688
  IfNotVolatileStatus: ifMask(statusVolatile, false), // trainer_ai.c:690–702
  IfMoveEffect: ifMask(moveEffectsMask, true), // trainer_ai.c:704–716
  IfNotMoveEffect: ifMask(moveEffectsMask, false), // trainer_ai.c:718–730
  IfSideCondition: ifMask(sideConditionsMask, true), // trainer_ai.c:732–745
  IfNotSideCondition: ifMask(sideConditionsMask, false), // trainer_ai.c:747–760

  IfAttackerHasDamagingMoves: (ctx) => { // trainer_ai.c:895–911
    ctx.iter(1);
    const jump = ctx.read();
    if (attackerHasDamagingMove(ctx)) ctx.iter(jump); // :908–910
  },

  IfAttackerHasNoDamagingMoves: (ctx) => { // trainer_ai.c:913–929
    ctx.iter(1);
    const jump = ctx.read();
    if (!attackerHasDamagingMove(ctx)) ctx.iter(jump); // :926–928
  },

  LoadTurnCount: (ctx) => { // trainer_ai.c:931–935
    ctx.iter(1);
    ctx.calcTemp = ctx.v.totalTurns;
  },

  LoadTypeFrom: (ctx) => { // trainer_ai.c:937–989
    ctx.iter(1);
    const param = ctx.read();
    const { v, d } = ctx;
    switch (param) {
      case LOAD_ATTACKER_TYPE_1:
        ctx.calcTemp = battlerType(v, d, ctx.attacker, 1); // :945–947
        break;
      case LOAD_DEFENDER_TYPE_1:
        ctx.calcTemp = battlerType(v, d, ctx.defender, 1); // :949–951
        break;
      case LOAD_ATTACKER_TYPE_2:
        ctx.calcTemp = battlerType(v, d, ctx.attacker, 2); // :953–955
        break;
      case LOAD_DEFENDER_TYPE_2:
        ctx.calcTemp = battlerType(v, d, ctx.defender, 2); // :957–959
        break;
      case LOAD_MOVE_TYPE:
        ctx.calcTemp = moveData(d, ctx.move).type; // :961–963
        break;
      // The partners come from BattleSystem_GetPartner, not AIScript_Battler: the battler itself in singles.
      case LOAD_ATTACKER_PARTNER_TYPE_1:
        ctx.calcTemp = battlerType(v, d, partner(v, ctx.attacker), 1); // :965–968
        break;
      case LOAD_DEFENDER_PARTNER_TYPE_1:
        ctx.calcTemp = battlerType(v, d, partner(v, ctx.defender), 1); // :970–973
        break;
      case LOAD_ATTACKER_PARTNER_TYPE_2:
        ctx.calcTemp = battlerType(v, d, partner(v, ctx.attacker), 2); // :975–978
        break;
      case LOAD_DEFENDER_PARTNER_TYPE_2:
        ctx.calcTemp = battlerType(v, d, partner(v, ctx.defender), 1); // :980–983: the C's bug, BATTLEMON_TYPE_1
        break;
      default: // :985–987: GF_ASSERT(FALSE), compiled out; calcTemp keeps its value
        break;
    }
  },

  FlagBattlerIsType: (ctx) => { // trainer_ai.c:991–1004
    ctx.iter(1);
    const inBattler = ctx.read();
    const type = ctx.read();
    const battler = ctx.battler(inBattler);
    // MON_HAS_TYPE (include/battle/common.h:53): either current type.
    const hasType = battlerType(ctx.v, ctx.d, battler, 1) === type || battlerType(ctx.v, ctx.d, battler, 2) === type;
    ctx.calcTemp = hasType ? 1 : 0; // :999–1003
  },

  LoadMovePower: (ctx) => { // trainer_ai.c:1006–1010
    ctx.iter(1);
    ctx.calcTemp = moveData(ctx.d, ctx.move).power;
  },

  LoadBattlerPreviousMove: (ctx) => { // trainer_ai.c:1068–1076
    ctx.iter(1);
    const inBattler = ctx.read();
    const battler = ctx.battler(inBattler);
    ctx.calcTemp = entry(ctx.v.movePrevByBattler, battler, 'movePrevByBattler');
  },

  LoadCurrentMoveEffect: (ctx) => { // trainer_ai.c:1164–1168
    ctx.iter(1);
    ctx.calcTemp = moveData(ctx.d, ctx.move).effect;
  },

  // trainer_ai.c:1414–1439: the field mask only, in this order, with no Cloud Nine check. The fog test comes last and
  // decides the result whatever came before, so weatherIs guards it (PATHS.fog) on every run.
  LoadCurrentWeather: (ctx) => {
    ctx.iter(1);
    ctx.calcTemp = AI_WEATHER_CLEAR;
    if (weatherIs(ctx.v, 'rain')) ctx.calcTemp = AI_WEATHER_RAINING; // :1420–1422
    if (weatherIs(ctx.v, 'sand')) ctx.calcTemp = AI_WEATHER_SANDSTORM; // :1424–1426
    if (weatherIs(ctx.v, 'sun')) ctx.calcTemp = AI_WEATHER_SUNNY; // :1428–1430
    if (weatherIs(ctx.v, 'hail')) ctx.calcTemp = AI_WEATHER_HAILING; // :1432–1434
    if (weatherIs(ctx.v, 'fog')) ctx.calcTemp = AI_WEATHER_DEEP_FOG; // :1436–1438
  },

  IfCurrentMoveEffectEqualTo: (ctx) => { // trainer_ai.c:1441–1451
    ctx.iter(1);
    const expected = ctx.read();
    const jump = ctx.read();
    if (moveData(ctx.d, ctx.move).effect === expected) ctx.iter(jump);
  },

  IfCurrentMoveEffectNotEqualTo: (ctx) => { // trainer_ai.c:1453–1463
    ctx.iter(1);
    const expected = ctx.read();
    const jump = ctx.read();
    if (moveData(ctx.d, ctx.move).effect !== expected) ctx.iter(jump);
  },

  IfStatStageLessThan: ifStatStage((stage, val) => stage < val), // trainer_ai.c:1465–1478
  IfStatStageGreaterThan: ifStatStage((stage, val) => stage > val), // trainer_ai.c:1480–1493
  IfStatStageEqualTo: ifStatStage((stage, val) => stage === val), // trainer_ai.c:1495–1508
  IfStatStageNotEqualTo: ifStatStage((stage, val) => stage !== val), // trainer_ai.c:1510–1523

  IfBattlerUnderEffect: (ctx) => { // trainer_ai.c:1823–1848
    ctx.iter(1);
    const inBattler = ctx.read();
    const check = ctx.read();
    const jump = ctx.read();
    const battler = ctx.battler(inBattler);
    const effects = battleMon(ctx.v, battler).effects;
    switch (check) {
      case CHECK_DISABLE:
        if (effects.disabledTurns !== 0) ctx.iter(jump); // :1833–1837
        break;
      case CHECK_ENCORE:
        if (effects.encoredTurns !== 0) ctx.iter(jump); // :1839–1843
        break;
      default: // :1845–1846
        break;
    }
  },

  IfCurrentMoveMatchesEffect: (ctx) => { // trainer_ai.c:1850–1873
    ctx.iter(1);
    const check = ctx.read();
    const jump = ctx.read();
    const effects = battleMon(ctx.v, ctx.attacker).effects;
    switch (check) {
      case CHECK_DISABLE:
        if (effects.disabledMove === ctx.move) ctx.iter(jump); // :1858–1862
        break;
      case CHECK_ENCORE:
        if (effects.encoredMove === ctx.move) ctx.iter(jump); // :1864–1868
        break;
      default: // :1870–1871
        break;
    }
  },

  IfFieldConditionsMask: (ctx) => { // trainer_ai.c:1936–1946
    ctx.iter(1);
    const mask = ctx.read();
    const jump = ctx.read();
    if (anyFieldBit(ctx.v, ctx.v.fieldConditionsMask, mask)) ctx.iter(jump); // deep fog may be unknown
  },

  LoadSpikesLayers: (ctx) => { // trainer_ai.c:1948–1966
    ctx.iter(1);
    const inBattler = ctx.read();
    const sideCondition = u32(ctx.read());
    const battler = ctx.battler(inBattler);
    const side = battlerSide(battler);
    switch (sideCondition) {
      case SIDE_CONDITION_SPIKES:
        ctx.calcTemp = entry(ctx.v.sideConditions, side, 'sideConditions').spikesLayers; // :1958–1960
        break;
      case SIDE_CONDITION_TOXIC_SPIKES:
        ctx.calcTemp = entry(ctx.v.sideConditions, side, 'sideConditions').toxicSpikesLayers; // :1962–1964
        break;
      default: // no case: calcTemp keeps its value
        break;
    }
  },

  LoadCurrentMovePP: (ctx) => { // trainer_ai.c:2024–2028
    ctx.iter(1);
    ctx.calcTemp = entry(battleMon(ctx.v, ctx.attacker).ppCur, ctx.slot, 'ppCur');
  },

  IfCanUseLastResort: (ctx) => { // trainer_ai.c:2030–2042
    ctx.iter(1);
    const inBattler = ctx.read();
    const jump = ctx.read();
    const battler = ctx.battler(inBattler);
    const numKnownMoves = countMoves(ctx.v, battler); // Battler_CountMoves (:2037)
    if (battleMon(ctx.v, battler).effects.lastResortCount >= numKnownMoves - 1 && numKnownMoves > 1) ctx.iter(jump); // :2039–2041
  },

  LoadCurrentMoveClass: (ctx) => { // trainer_ai.c:2044–2048
    ctx.iter(1);
    ctx.calcTemp = moveClass(moveData(ctx.d, ctx.move).category);
  },

  LoadDefenderLastUsedMoveClass: (ctx) => { // trainer_ai.c:2050–2054
    ctx.iter(1);
    const move = entry(ctx.v.movePrevByBattler, ctx.defender, 'movePrevByBattler');
    ctx.calcTemp = moveClass(moveData(ctx.d, move).category);
  },

  LoadBattlerTurnCount: (ctx) => { // trainer_ai.c:2096–2104
    ctx.iter(1);
    const inBattler = ctx.read();
    const battler = ctx.battler(inBattler);
    ctx.calcTemp = ctx.v.totalTurns - battleMon(ctx.v, battler).effects.fakeOutTurnNumber; // :2103
  },

  SumPositiveStatStages: (ctx) => { // trainer_ai.c:2243–2257
    ctx.iter(1);
    const inBattler = ctx.read();
    const battler = ctx.battler(inBattler);
    const mon = battleMon(ctx.v, battler);
    ctx.calcTemp = 0; // :2250
    for (let stat: number = BATTLE_STAT.HP; stat < BATTLE_STAT_MAX; stat++) { // :2252–2256
      const stage = statStage(mon, stat);
      if (stage > 6) ctx.calcTemp += stage - 6;
    }
  },

  DiffStatStages: (ctx) => { // trainer_ai.c:2259–2268
    ctx.iter(1);
    const inBattler = ctx.read();
    const stat = ctx.read();
    const battler = ctx.battler(inBattler);
    ctx.calcTemp = statStage(battleMon(ctx.v, battler), stat) - statStage(battleMon(ctx.v, ctx.attacker), stat); // :2267
  },

  IfBattlerHasHigherStat: ifStoredStat((aiStat, battlerStat) => aiStat < battlerStat), // trainer_ai.c:2270–2285
  IfBattlerHasLowerStat: ifStoredStat((aiStat, battlerStat) => aiStat > battlerStat), // trainer_ai.c:2287–2302
  IfBattlerHasEqualStat: ifStoredStat((aiStat, battlerStat) => aiStat === battlerStat), // trainer_ai.c:2304–2319

  IfBattlerFainted: ifSwitching(true), // trainer_ai.c:2438–2452
  IfBattlerNotFainted: ifSwitching(false), // trainer_ai.c:2454–2468

  LoadGender: (ctx) => { // trainer_ai.c:2470–2478
    ctx.iter(1);
    const inBattler = ctx.read();
    const battler = ctx.battler(inBattler);
    ctx.calcTemp = battleMon(ctx.v, battler).gender;
  },

  LoadIsFirstTurnInBattle: (ctx) => { // trainer_ai.c:2480–2492
    ctx.iter(1);
    const inBattler = ctx.read();
    const battler = ctx.battler(inBattler);
    ctx.calcTemp = battleMon(ctx.v, battler).effects.fakeOutTurnNumber < ctx.v.totalTurns ? 0 : 1; // :2487–2491
  },

  LoadStockpileCount: (ctx) => { // trainer_ai.c:2494–2502
    ctx.iter(1);
    const inBattler = ctx.read();
    const battler = ctx.battler(inBattler);
    ctx.calcTemp = battleMon(ctx.v, battler).effects.stockpileCount;
  },

  LoadBattleType: (ctx) => { // trainer_ai.c:2504–2508
    ctx.iter(1);
    ctx.calcTemp = ctx.v.battleType;
  },

  LoadRecycleItem: (ctx) => { // trainer_ai.c:2510–2518
    ctx.iter(1);
    const inBattler = ctx.read();
    const battler = ctx.battler(inBattler);
    requireKnown(ctx.v, PATHS.recycleItem(battler));
    ctx.calcTemp = entry(ctx.v.recycleItem, battler, 'recycleItem');
  },

  LoadTypeOfLoadedMove: (ctx) => { // trainer_ai.c:2520–2524
    ctx.iter(1);
    ctx.calcTemp = moveData(ctx.d, ctx.calcTemp).type;
  },

  LoadPowerOfLoadedMove: (ctx) => { // trainer_ai.c:2526–2530
    ctx.iter(1);
    ctx.calcTemp = moveData(ctx.d, ctx.calcTemp).power;
  },

  LoadEffectOfLoadedMove: (ctx) => { // trainer_ai.c:2532–2536
    ctx.iter(1);
    ctx.calcTemp = moveData(ctx.d, ctx.calcTemp).effect;
  },

  LoadProtectChain: (ctx) => { // trainer_ai.c:2538–2552
    ctx.iter(1);
    const inBattler = ctx.read();
    const battler = ctx.battler(inBattler);
    requireKnown(ctx.v, PATHS.moveProtect(battler));
    const moveProtect = entry(ctx.v.moveProtect, battler, 'moveProtect');
    if (moveProtect !== MOVE_PROTECT && moveProtect !== MOVE_DETECT && moveProtect !== MOVE_ENDURE) {
      ctx.calcTemp = 0; // :2545–2548
    } else {
      requireKnown(ctx.v, PATHS.protectSuccessTurns(battler));
      ctx.calcTemp = battleMon(ctx.v, battler).effects.protectSuccessTurns; // :2549–2550
    }
  },

  IfLevel: (ctx) => { // trainer_ai.c:2579–2608
    ctx.iter(1);
    const op = ctx.read();
    const jump = ctx.read();
    const aiLevel = battleMon(ctx.v, ctx.attacker).level;
    const defenderLevel = battleMon(ctx.v, ctx.defender).level;
    switch (op) {
      case CHECK_HIGHER_THAN_TARGET:
        if (aiLevel > defenderLevel) ctx.iter(jump); // :2587–2591
        break;
      case CHECK_LOWER_THAN_TARGET:
        if (aiLevel < defenderLevel) ctx.iter(jump); // :2593–2597
        break;
      case CHECK_EQUAL_TO_TARGET:
        if (aiLevel === defenderLevel) ctx.iter(jump); // :2599–2603
        break;
      default: // :2605–2606
        break;
    }
  },

  IfTargetIsTaunted: (ctx) => { // trainer_ai.c:2610–2618
    ctx.iter(1);
    const jump = ctx.read();
    if (battleMon(ctx.v, ctx.defender).effects.tauntedTurns !== 0) ctx.iter(jump);
  },

  IfTargetIsNotTaunted: (ctx) => { // trainer_ai.c:2620–2628
    ctx.iter(1);
    const jump = ctx.read();
    if (battleMon(ctx.v, ctx.defender).effects.tauntedTurns === 0) ctx.iter(jump);
  },

  IfActivatedFlashFire: (ctx) => { // trainer_ai.c:2641–2652
    ctx.iter(1);
    const inBattler = ctx.read();
    const jump = ctx.read();
    const battler = ctx.battler(inBattler);
    if (battleMon(ctx.v, battler).effects.flashFire) ctx.iter(jump);
  },
};
