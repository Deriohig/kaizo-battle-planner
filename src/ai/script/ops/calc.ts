// The AI script commands over the damage estimate, type effectiveness and the speed comparison. Literal ports of the
// AICmd_* handlers in trainer_ai.c; each cites its lines. Every handler starts as the C does, with AIScript_Iter(1) past
// its opcode, and reads its arguments in the C's order.
//
// The damage estimate reads ctx.calcView, the view with the run's own monSpeedValues (Gyro Ball, trainer_ai.c:2996),
// and every speed comparison stores the speeds it writes there (battle_lib.c:1372–1373).

import {
  AI_MOVE_IS_HIGHEST_DAMAGE, AI_NO_COMPARISON_MADE, AI_NOT_HIGHEST_DAMAGE, COMPARE_SPEED_FASTER, LEARNED_MOVES_MAX,
  MAX_BATTLERS_PER_SIDE, MOVE_NONE, MOVE_STATUS_IMMUNE, MOVE_STATUS_SUPER_EFFECTIVE, TYPE_MULTI_BASE_DAMAGE,
  TYPE_MULTI_DOUBLE_DAMAGE, TYPE_MULTI_HALF_DAMAGE, TYPE_MULTI_IMMUNE, TYPE_MULTI_QUADRUPLE_DAMAGE,
  TYPE_MULTI_QUARTER_DAMAGE, TYPE_MULTI_STAB_DAMAGE,
} from '../../constants.js';
import { AiError } from '../../errors.js';
import { u16, u32 } from '../../int.js';
import { aiMoveType, battleMon, battlerAbility, maxBattlers, moveData, partner } from '../../lib/battler.js';
import { aiCalcAllDamage, aiCalcDamage, isDamageEstimated, readRoll } from '../../lib/damage.js';
import { compareSpeed } from '../../lib/speed.js';
import { applyTypeChart } from '../../lib/typeChart.js';
import type { AiView } from '../../view.js';
import type { OpHandler, OpTable, RunCtx } from '../run.js';
import { activePartySlot, battlerParty, isLiveMember } from './party.js';
import { entry } from './state.js';

/** BOOL TRUE. The roll argument reads moveDamageRolls only when it is exactly TRUE (trainer_ai.c:1533, 2222, 2829). */
const TRUE = 1;

/**
 * The test FlagMoveDamageScore, IfCurrentMoveKills, IfCurrentMoveDoesNotKill and CheckIfHighestDamageWithPartner make
 * before estimating (trainer_ai.c:1035–1036, 1553–1554, 1604–1605, 2393–2394): the current move's effect is in
 * sAltPowerMoveEffects, or its power is over 1 and its effect isn't in sNoDamageCalcMoveEffects.
 */
function currentMoveIsEstimated(ctx: RunCtx): boolean {
  return isDamageEstimated(moveData(ctx.d, ctx.move));
}

/**
 * TrainerAI_CalcAllDamage (trainer_ai.c:2799) for `battler`'s own moves, held item, IVs (BattleMon_Get BATTLEMON_HP_IV
 * + i), ability (Battler_Ability) and Embargo turns, into AI_CONTEXT.defender: what FlagMoveDamageScore (:1037–1050),
 * IfPartyMemberDealsMoreDamage (:2126–2139), IfBattlerDealsMoreDamage (:2206–2219) and CheckIfHighestDamageWithPartner
 * (:2398–2411) pass. `varyDamage` is the script word; only TRUE reads the rolls (:2829).
 */
function calcAllDamageOf(ctx: RunCtx, battler: number, varyDamage: number): { max: number; values: number[] } {
  const mon = battleMon(ctx.v, battler);
  return aiCalcAllDamage(
    ctx.calcView, ctx.d, ctx.lat, battler, ctx.defender, mon.moves, mon.heldItem, mon.ivs, battler,
    battlerAbility(ctx.v, battler), mon.effects.embargoTurns, varyDamage === TRUE, ctx.pick,
  );
}

/** AICmd_IfCurrentMoveKills and IfCurrentMoveDoesNotKill: `test(curHP, damage)` against the current move's estimate. */
function ifKill(test: (curHP: number, damage: number) => boolean): OpHandler {
  return (ctx) => {
    ctx.iter(1);
    const useDamageRoll = ctx.read();
    const jump = ctx.read();
    if (!currentMoveIsEstimated(ctx)) return; // :1553–1554, :1604–1605
    // :1533–1537, :1584–1588. TrainerAI_Init drew the roll (:240) and reading it changes nothing, so the port reads the
    // slot's latent only where the estimate uses it: a move that isn't estimated leaves it unfixed.
    const roll = useDamageRoll === TRUE ? readRoll(ctx.lat, ctx.slot, ctx.pick) : 100;
    const ai = battleMon(ctx.v, ctx.attacker);
    // :1555–1568, :1606–1619: the attacker's own item, IVs, ability and Embargo turns; `u32 damage`.
    const damage = u32(aiCalcDamage(
      ctx.calcView, ctx.d, ctx.move, ai.heldItem, ai.ivs, ctx.attacker, ctx.attacker, ctx.defender,
      battlerAbility(ctx.v, ctx.attacker), ai.effects.embargoTurns, roll, ctx.pick,
    ));
    // :1570, :1621: the defender's real curHP, compared unsigned with the u32 damage.
    if (test(u32(battleMon(ctx.v, ctx.defender).curHP), damage)) ctx.iter(jump);
  };
}

/**
 * The effectiveness of `move` at TYPE_MULTI_BASE_DAMAGE, as CalcMaxEffectiveness (trainer_ai.c:1275–1302) and
 * IfMoveEffectivenessEquals (:1317–1341) map it: BattleSystem_ApplyTypeChart's u32 damage, with the STAB multiples
 * folded onto the plain ones, and TYPE_MULTI_IMMUNE for any MOVE_STATUS_IMMUNE flag.
 */
function effectiveness(ctx: RunCtx, move: number, moveType: number): number {
  const chart = applyTypeChart(ctx.v, ctx.d, move, moveType, ctx.attacker, ctx.defender, TYPE_MULTI_BASE_DAMAGE);
  let damage = u32(chart.damage);
  if (damage === TYPE_MULTI_STAB_DAMAGE * 2) damage = TYPE_MULTI_DOUBLE_DAMAGE; // :1290–1291, :1329–1330
  else if (damage === TYPE_MULTI_STAB_DAMAGE * 4) damage = TYPE_MULTI_QUADRUPLE_DAMAGE; // :1292–1293, :1331–1332
  else if (damage === TYPE_MULTI_STAB_DAMAGE / 2) damage = TYPE_MULTI_HALF_DAMAGE; // :1294–1295, :1333–1334
  else if (damage === TYPE_MULTI_STAB_DAMAGE / 4) damage = TYPE_MULTI_QUARTER_DAMAGE; // :1296–1297, :1335–1336
  if ((chart.flags & MOVE_STATUS_IMMUNE) !== 0) damage = TYPE_MULTI_IMMUNE; // :1300–1302, :1339–1341
  return damage;
}

/**
 * BattleSystem_GetBattlerOfType(BattleSystem_GetBattlerType(battler) ^ 1) (trainer_ai.c:3571–3572; battle_system.c:342,
 * 355). A singles battler's type is its slot (sSingleBattleBattlerTypes, battle_main.c:948–951), so this is the other
 * slot. A battler past GetMaxBattlers has no BattlerData: AiError('BAD_VIEW').
 */
function oppositeBattler(v: AiView, battler: number): number {
  if (battler < 0 || battler >= maxBattlers(v)) throw new AiError('BAD_VIEW', `battler ${battler} has no battler type in singles`);
  return battler ^ 1;
}

/**
 * AI_HasSuperEffectiveMove(battler, flag = TRUE) (trainer_ai.c:3560): whether one of `battler`'s moves is super
 * effective on the battler opposite, unless that battler is switching. With `flag` TRUE there is no draw (:3586–3587).
 */
function hasSuperEffectiveMove(ctx: RunCtx, battler: number): boolean {
  const { v, d } = ctx;
  const defender = oppositeBattler(v, battler); // :3571–3572
  if ((v.battlersSwitchingMask & (1 << defender)) === 0) { // :3574: FlagIndex(defender)
    const moves = battleMon(v, battler).moves;
    for (let i = 0; i < LEARNED_MOVES_MAX; i++) {
      const move = u16(entry(moves, i, 'moves')); // :3577
      const type = aiMoveType(v, d, battler, move); // :3578, before the move check: Weather Ball can throw
      if (move !== MOVE_NONE) { // :3580
        const { flags } = applyTypeChart(v, d, move, type, battler, defender, 0); // :3581–3582
        if ((flags & MOVE_STATUS_SUPER_EFFECTIVE) !== 0) return true; // :3585–3587
      }
    }
  }
  return false; // :3597–3599: no partner to check in singles
}

/**
 * BattleSystem_CompareBattlerSpeed(b1, b2, ignoreQuickClaw = TRUE) (battle_lib.c:1188), storing what it writes to
 * monSpeedValues (:1372–1373) in the run's copy.
 */
function speedCompare(ctx: RunCtx, b1: number, b2: number): number {
  const { result, speeds } = compareSpeed(ctx.v, ctx.d, ctx.lat, b1, b2, ctx.pick);
  ctx.writeSpeeds(b1, b2, speeds);
  return result;
}

/** AICmd_IfSpeedCompareEqualTo and IfSpeedCompareNotEqualTo: the attacker against the defender. */
function ifSpeedCompare(test: (result: number, val: number) => boolean): OpHandler {
  return (ctx) => {
    ctx.iter(1);
    const val = ctx.read();
    const jump = ctx.read();
    if (test(speedCompare(ctx, ctx.attacker, ctx.defender), val)) ctx.iter(jump); // :1109–1111, :1121–1123
  };
}

export const CALC_OPS: OpTable = {
  FlagMoveDamageScore: (ctx) => { // trainer_ai.c:1012–1066
    ctx.iter(1);
    const varyDamage = ctx.read();
    if (currentMoveIsEstimated(ctx)) { // :1023–1036
      const { values } = calcAllDamageOf(ctx, ctx.attacker, varyDamage); // :1037–1050
      const own = entry(values, ctx.slot, 'moveDamage');
      let i: number;
      for (i = 0; i < LEARNED_MOVES_MAX; i++) if (values[i]! > own) break; // :1052–1056: ties don't break
      ctx.calcTemp = i === LEARNED_MOVES_MAX ? AI_MOVE_IS_HIGHEST_DAMAGE : AI_NOT_HIGHEST_DAMAGE; // :1058–1062
    } else {
      ctx.calcTemp = AI_NO_COMPARISON_MADE; // :1063–1065
    }
  },

  IfCurrentMoveKills: ifKill((curHP, damage) => curHP <= damage), // trainer_ai.c:1525–1574
  IfCurrentMoveDoesNotKill: ifKill((curHP, damage) => curHP > damage), // trainer_ai.c:1576–1625

  IfPartyMemberDealsMoreDamage: (ctx) => { // trainer_ai.c:2106–2174
    ctx.iter(1);
    const varyDamage = ctx.read();
    const jump = ctx.read();
    const battler = ctx.attacker; // :2124
    const activeMonDamage = calcAllDamageOf(ctx, battler, varyDamage).max; // :2126–2139
    const slot = activePartySlot(ctx.v, battler);
    const party = battlerParty(ctx.v, battler);
    for (let i = 0; i < party.length; i++) { // :2141
      const partyMon = party[i]!;
      if (i === slot || !isLiveMember(partyMon)) continue; // :2142–2147
      // :2148–2165: the party Pokémon's moves, item, IVs (party data, always known) and ability, Embargo FALSE, but
      // estimated from the active attacker, whose stats, types and ability the damage formula reads.
      const partyMonDamage = aiCalcAllDamage(
        ctx.calcView, ctx.d, ctx.lat, ctx.attacker, ctx.defender, partyMon.moves, partyMon.heldItem, partyMon.ivs, null,
        partyMon.ability, 0, varyDamage === TRUE, ctx.pick,
      ).max;
      if (partyMonDamage > activeMonDamage) { // :2167–2170
        ctx.iter(jump);
        break;
      }
    }
  },

  IfHasSuperEffectiveMove: (ctx) => { // trainer_ai.c:2176–2185
    ctx.iter(1);
    const jump = ctx.read();
    if (hasSuperEffectiveMove(ctx, ctx.attacker)) ctx.iter(jump); // :2182–2184
  },

  IfBattlerDealsMoreDamage: (ctx) => { // trainer_ai.c:2187–2241
    ctx.iter(1);
    const inBattler = ctx.read();
    const varyDamage = ctx.read();
    const jump = ctx.read();
    const ivs = battleMon(ctx.v, ctx.attacker).ivs; // :2206–2208: the AI's IVs
    const aiDamage = calcAllDamageOf(ctx, ctx.attacker, varyDamage).max; // :2210–2219
    const battler = ctx.battler(inBattler); // :2220
    const roll = varyDamage === TRUE ? readRoll(ctx.lat, ctx.slot, ctx.pick) : 100; // :2222–2226
    const mon = battleMon(ctx.v, battler);
    // :2228–2236: the battler's last move from the battler, into AI_CONTEXT.defender (:2878), with its own item, ability
    // and Embargo turns but the AI's IVs (the C's bug, kept).
    const battlerDamage = aiCalcDamage(
      ctx.calcView, ctx.d, entry(ctx.v.movePrevByBattler, battler, 'movePrevByBattler'), mon.heldItem, ivs, ctx.attacker,
      battler, ctx.defender, battlerAbility(ctx.v, battler), mon.effects.embargoTurns, roll, ctx.pick,
    );
    if (battlerDamage > aiDamage) ctx.iter(jump); // :2238–2240
  },

  CheckIfHighestDamageWithPartner: (ctx) => { // trainer_ai.c:2369–2436
    ctx.iter(1);
    const varyDamage = ctx.read();
    if (!currentMoveIsEstimated(ctx)) { // :2381–2394
      ctx.calcTemp = AI_NO_COMPARISON_MADE; // :2433–2435
      return;
    }
    let battler = ctx.attacker; // :2395
    let moveDamage = 0;
    for (let j = 0; j < MAX_BATTLERS_PER_SIDE; j++) { // :2397
      const { values } = calcAllDamageOf(ctx, battler, varyDamage); // :2398–2411
      battler = partner(ctx.v, ctx.attacker); // :2414: the AI itself in singles, so the second pass estimates again
      if (j === 0) moveDamage = entry(values, ctx.slot, 'damageVals'); // :2416–2418
      let i: number;
      for (i = 0; i < LEARNED_MOVES_MAX; i++) if (values[i]! > moveDamage) break; // :2420–2424
      if (i === LEARNED_MOVES_MAX) {
        ctx.calcTemp = AI_MOVE_IS_HIGHEST_DAMAGE; // :2426–2427
      } else {
        ctx.calcTemp = AI_NOT_HIGHEST_DAMAGE; // :2428–2430
        break;
      }
    }
  },

  CalcMaxEffectiveness: (ctx) => { // trainer_ai.c:1268–1309
    ctx.iter(1);
    ctx.calcTemp = TYPE_MULTI_IMMUNE; // :1272
    const moves = battleMon(ctx.v, ctx.attacker).moves;
    for (let i = 0; i < LEARNED_MOVES_MAX; i++) {
      const move = u16(entry(moves, i, 'moves')); // :1277
      const moveType = aiMoveType(ctx.v, ctx.d, ctx.attacker, move); // :1278, before the move check
      if (move !== MOVE_NONE) { // :1280
        const damage = effectiveness(ctx, move, moveType); // :1281–1302
        if (u32(ctx.calcTemp) < damage) ctx.calcTemp = damage; // :1304–1306: int against u32, unsigned
      }
    }
  },

  IfMoveEffectivenessEquals: (ctx) => { // trainer_ai.c:1311–1346
    ctx.iter(1);
    const expected = ctx.read();
    const jump = ctx.read();
    const damage = effectiveness(ctx, ctx.move, aiMoveType(ctx.v, ctx.d, ctx.attacker, ctx.move)); // :1320–1341
    if (damage === u32(expected)) ctx.iter(jump); // :1343–1345: u32 against int, unsigned
  },

  IfSpeedCompareEqualTo: ifSpeedCompare((result, val) => result === val), // trainer_ai.c:1102–1112
  IfSpeedCompareNotEqualTo: ifSpeedCompare((result, val) => result !== val), // trainer_ai.c:1114–1124

  LoadBattlerSpeedRank: (ctx) => { // trainer_ai.c:2056–2094
    ctx.iter(1);
    const inBattler = ctx.read();
    const battler = ctx.battler(inBattler);
    const n = maxBattlers(ctx.v); // :2070
    const speedOrder = Array.from({ length: n }, (_, i) => i); // :2072–2074
    for (let i = 0; i < n - 1; i++) { // :2076–2086
      for (let j = i + 1; j < n; j++) {
        const cmp1 = speedOrder[i]!;
        const cmp2 = speedOrder[j]!;
        if (speedCompare(ctx, cmp1, cmp2) !== COMPARE_SPEED_FASTER) { // :2081: slower or a tie swaps
          speedOrder[i] = cmp2;
          speedOrder[j] = cmp1;
        }
      }
    }
    // :2088–2093: a battler not in the order (an empty partner slot in singles) leaves calcTemp as it was.
    const rank = speedOrder.indexOf(battler);
    if (rank >= 0) ctx.calcTemp = rank;
  },
};
