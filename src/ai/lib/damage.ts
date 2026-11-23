// The trainer AI's damage estimate: TrainerAI_CalcAllDamage and TrainerAI_CalcDamage (trainer_ai.c:2799, 2868), over a
// literal port of BattleSystem_CalcMoveDamage (battle_lib.c:6601), the base damage before STAB, type and the roll,
// read from the defender's real stats, ability and item. Each rule cites its C line. Nothing here writes to the view;
// readRoll fixes entries of the run's own Latents, and the random estimates (Psywave, Magnitude) draw through `pick`.

import type { Stats } from '../../rom/types.js';
import {
  ABILITY_BLAZE, ABILITY_DRY_SKIN, ABILITY_FLOWER_GIFT, ABILITY_GUTS, ABILITY_HEATPROOF, ABILITY_HUGE_POWER,
  ABILITY_HUSTLE, ABILITY_IRON_FIST, ABILITY_KLUTZ, ABILITY_MARVEL_SCALE, ABILITY_MINUS, ABILITY_MOLD_BREAKER,
  ABILITY_NORMALIZE, ABILITY_OVERGROW, ABILITY_PLUS, ABILITY_PURE_POWER, ABILITY_RIVALRY, ABILITY_SIMPLE,
  ABILITY_SLOW_START, ABILITY_SOLAR_POWER, ABILITY_SWARM, ABILITY_TECHNICIAN, ABILITY_THICK_FAT, ABILITY_TORRENT,
  ABILITY_UNAWARE, BATTLE_EFFECT_20_DAMAGE_FLAT, BATTLE_EFFECT_40_DAMAGE_FLAT, BATTLE_EFFECT_CHARGE_TURN_DEF_UP,
  BATTLE_EFFECT_CHARGE_TURN_HIGH_CRIT, BATTLE_EFFECT_CHARGE_TURN_HIGH_CRIT_FLINCH,
  BATTLE_EFFECT_DECREASE_POWER_WITH_LESS_USER_HP, BATTLE_EFFECT_HALVE_DEFENSE, BATTLE_EFFECT_HIT_FIRST_IF_TARGET_ATTACKING,
  BATTLE_EFFECT_HIT_LAST_WHIFF_IF_HIT, BATTLE_EFFECT_INCREASE_POWER_WITH_WEIGHT, BATTLE_EFFECT_JUDGEMENT,
  BATTLE_EFFECT_LEVEL_DAMAGE_FLAT, BATTLE_EFFECT_LOWER_OWN_ATK_AND_DEF, BATTLE_EFFECT_NATURAL_GIFT,
  BATTLE_EFFECT_POWER_BASED_ON_FRIENDSHIP, BATTLE_EFFECT_POWER_BASED_ON_LOW_FRIENDSHIP,
  BATTLE_EFFECT_POWER_BASED_ON_LOW_SPEED, BATTLE_EFFECT_RANDOM_DAMAGE_1_TO_150_LEVEL,
  BATTLE_EFFECT_RANDOM_POWER_BASED_ON_IVS, BATTLE_EFFECT_RECHARGE_AFTER, BATTLE_EFFECT_RECOIL_HALF,
  BATTLE_EFFECT_RECOVER_DAMAGE_SLEEP, BATTLE_EFFECT_REMOVE_SCREENS, BATTLE_EFFECT_SKIP_CHARGE_TURN_IN_SUN,
  BATTLE_EFFECT_SPIT_UP, BATTLE_STAT, BATTLE_TYPE_FRONTIER, COUNT_ALIVE_BATTLERS_OUR_SIDE, DEFAULT_STAT_STAGE,
  FIELD_CONDITION_RAINING, FIELD_CONDITION_SANDSTORM, FIELD_CONDITION_SOLAR_DOWN, FIELD_CONDITION_SUNNY, GENDER_NONE,
  HOLD_EFFECT_ARCEUS_BUG, HOLD_EFFECT_ARCEUS_DARK, HOLD_EFFECT_ARCEUS_DRAGON, HOLD_EFFECT_ARCEUS_ELECTRIC,
  HOLD_EFFECT_ARCEUS_FIGHTING, HOLD_EFFECT_ARCEUS_FIRE, HOLD_EFFECT_ARCEUS_FLYING, HOLD_EFFECT_ARCEUS_GHOST,
  HOLD_EFFECT_ARCEUS_GRASS, HOLD_EFFECT_ARCEUS_GROUND, HOLD_EFFECT_ARCEUS_ICE, HOLD_EFFECT_ARCEUS_POISON,
  HOLD_EFFECT_ARCEUS_PSYCHIC, HOLD_EFFECT_ARCEUS_ROCK, HOLD_EFFECT_ARCEUS_STEEL, HOLD_EFFECT_ARCEUS_WATER,
  HOLD_EFFECT_CHOICE_ATK, HOLD_EFFECT_CHOICE_SPATK, HOLD_EFFECT_CLAMPERL_SPATK, HOLD_EFFECT_CLAMPERL_SPDEF,
  HOLD_EFFECT_CUBONE_ATK_UP, HOLD_EFFECT_DIALGA_BOOST, HOLD_EFFECT_DITTO_DEF_UP, HOLD_EFFECT_GIRATINA_BOOST,
  HOLD_EFFECT_LATI_SPECIAL, HOLD_EFFECT_PALKIA_BOOST, HOLD_EFFECT_PIKA_SPATK_UP, HOLD_EFFECT_POWER_UP_PHYS,
  HOLD_EFFECT_POWER_UP_SPEC, HOLD_EFFECT_STRENGTHEN_BUG, HOLD_EFFECT_STRENGTHEN_DARK, HOLD_EFFECT_STRENGTHEN_DRAGON,
  HOLD_EFFECT_STRENGTHEN_ELECTRIC, HOLD_EFFECT_STRENGTHEN_FIGHT, HOLD_EFFECT_STRENGTHEN_FIRE,
  HOLD_EFFECT_STRENGTHEN_FLYING, HOLD_EFFECT_STRENGTHEN_GHOST, HOLD_EFFECT_STRENGTHEN_GRASS,
  HOLD_EFFECT_STRENGTHEN_GROUND, HOLD_EFFECT_STRENGTHEN_ICE, HOLD_EFFECT_STRENGTHEN_NORMAL,
  HOLD_EFFECT_STRENGTHEN_POISON, HOLD_EFFECT_STRENGTHEN_PSYCHIC, HOLD_EFFECT_STRENGTHEN_ROCK,
  HOLD_EFFECT_STRENGTHEN_STEEL, HOLD_EFFECT_STRENGTHEN_WATER, LEARNED_MOVES_MAX, MAX_STAT_STAGE, MIN_STAT_STAGE,
  MON_CONDITION_BURN, MOVE_BULLET_PUNCH, MOVE_CLASS, MOVE_COMET_PUNCH, MOVE_DIZZY_PUNCH, MOVE_DRAGON_RAGE,
  MOVE_DRAIN_PUNCH, MOVE_DYNAMIC_PUNCH, MOVE_EFFECT_CHARGE, MOVE_EFFECT_MUD_SPORT, MOVE_EFFECT_WATER_SPORT,
  MOVE_FIRE_PUNCH, MOVE_FOCUS_PUNCH, MOVE_FRUSTRATION, MOVE_GRASS_KNOT, MOVE_GYRO_BALL, MOVE_HAMMER_ARM,
  MOVE_HIDDEN_POWER, MOVE_ICE_PUNCH, MOVE_JUDGMENT, MOVE_LOW_KICK, MOVE_MACH_PUNCH, MOVE_MAGNITUDE, MOVE_MEGA_PUNCH,
  MOVE_METEOR_MASH, MOVE_NATURAL_GIFT, MOVE_NIGHT_SHADE, MOVE_NONE, MOVE_PSYWAVE, MOVE_RETURN, MOVE_SEISMIC_TOSS,
  MOVE_SHADOW_PUNCH, MOVE_SKY_UPPERCUT, MOVE_SOLAR_BEAM, MOVE_SONIC_BOOM, MOVE_STATUS_IMMUNE, MOVE_STRUGGLE,
  MOVE_THUNDER_PUNCH, SIDE_CONDITION_LIGHT_SCREEN, SIDE_CONDITION_REFLECT, SPECIES_CLAMPERL, SPECIES_CUBONE,
  SPECIES_DIALGA, SPECIES_DITTO, SPECIES_GIRATINA, SPECIES_LATIAS, SPECIES_LATIOS, SPECIES_MAROWAK, SPECIES_PALKIA,
  SPECIES_PIKACHU, SYSCTL_IGNORE_TYPE_CHECKS, TYPE_BUG, TYPE_DARK, TYPE_DRAGON, TYPE_ELECTRIC, TYPE_FIGHTING, TYPE_FIRE,
  TYPE_FLYING, TYPE_GHOST, TYPE_GRASS, TYPE_GROUND, TYPE_ICE, TYPE_MYSTERY, TYPE_NORMAL, TYPE_POISON, TYPE_PSYCHIC,
  TYPE_ROCK, TYPE_STEEL, TYPE_WATER, VOLATILE_CONDITION_TRANSFORM, moveClass as classOf,
} from '../constants.js';
import type { Pick } from '../enumerate.js';
import { AiError } from '../errors.js';
import { cdiv, s8, u16, u32, u8 } from '../int.js';
import { residueWeights } from '../odds.js';
import type { AiDeps, AiTurnFlags, AiView } from '../view.js';
import {
  anyFieldBit, battleMon, battlerAbility, battlerSide, battlerType, countAbility, heldItem, ignorableAbility, itemData,
  maxBattlers, moveData, noCloudNine,
} from './battler.js';
import { PATHS, requireKnown } from './known.js';
import { type Latents, statStageBoost } from './speed.js';
import { applyTypeChart, battleDivide } from './typeChart.js';

/** sNoDamageCalcMoveEffects, trainer_ai.c:31–46, without its 0xFFFF terminator. */
export const NO_DAMAGE_CALC_EFFECTS: readonly number[] = Object.freeze([
  BATTLE_EFFECT_HALVE_DEFENSE, BATTLE_EFFECT_RECOVER_DAMAGE_SLEEP, BATTLE_EFFECT_CHARGE_TURN_HIGH_CRIT,
  BATTLE_EFFECT_CHARGE_TURN_HIGH_CRIT_FLINCH, BATTLE_EFFECT_RECHARGE_AFTER, BATTLE_EFFECT_CHARGE_TURN_DEF_UP,
  BATTLE_EFFECT_SKIP_CHARGE_TURN_IN_SUN, BATTLE_EFFECT_SPIT_UP, BATTLE_EFFECT_HIT_LAST_WHIFF_IF_HIT,
  BATTLE_EFFECT_LOWER_OWN_ATK_AND_DEF, BATTLE_EFFECT_DECREASE_POWER_WITH_LESS_USER_HP,
  BATTLE_EFFECT_HIT_FIRST_IF_TARGET_ATTACKING, BATTLE_EFFECT_RECOIL_HALF,
]);

/** sAltPowerMoveEffects, trainer_ai.c:48–61, without its 0xFFFF terminator. */
export const ALT_POWER_EFFECTS: readonly number[] = Object.freeze([
  BATTLE_EFFECT_RANDOM_POWER_BASED_ON_IVS, BATTLE_EFFECT_POWER_BASED_ON_LOW_SPEED, BATTLE_EFFECT_NATURAL_GIFT,
  BATTLE_EFFECT_JUDGEMENT, BATTLE_EFFECT_40_DAMAGE_FLAT, BATTLE_EFFECT_LEVEL_DAMAGE_FLAT,
  BATTLE_EFFECT_RANDOM_DAMAGE_1_TO_150_LEVEL, BATTLE_EFFECT_POWER_BASED_ON_FRIENDSHIP,
  BATTLE_EFFECT_POWER_BASED_ON_LOW_FRIENDSHIP, BATTLE_EFFECT_20_DAMAGE_FLAT, BATTLE_EFFECT_INCREASE_POWER_WITH_WEIGHT,
]);

/**
 * The test every damage estimate makes first (trainer_ai.c:1035–1036, 1553–1554, 1604–1605, 2393–2394, 2827–2828): the
 * move's effect is in ALT_POWER_EFFECTS, or its power is over 1 and its effect isn't in NO_DAMAGE_CALC_EFFECTS.
 * TrainerAI_CalcAllDamage also skips an empty slot on the second branch (:2828; aiCalcAllDamage).
 */
export function isDamageEstimated(data: { effect: number; power: number }): boolean {
  return ALT_POWER_EFFECTS.includes(data.effect) || (data.power > 1 && !NO_DAMAGE_CALC_EFFECTS.includes(data.effect));
}

/** sWeightToPower, include/data/battle/weight_to_power.h: [weight limit in hectograms, power], without its 0xFFFF row. */
export const WEIGHT_TO_POWER: readonly (readonly [number, number])[] = Object.freeze([
  [100, 20], [250, 40], [500, 60], [1000, 80], [2000, 100],
] as const);

/** sTypeBoostingItems, battle_lib.c:6514–6548: [hold effect, move type]. */
const TYPE_BOOSTING_ITEMS: readonly (readonly [number, number])[] = Object.freeze([
  [HOLD_EFFECT_STRENGTHEN_BUG, TYPE_BUG], [HOLD_EFFECT_STRENGTHEN_STEEL, TYPE_STEEL],
  [HOLD_EFFECT_STRENGTHEN_GROUND, TYPE_GROUND], [HOLD_EFFECT_STRENGTHEN_ROCK, TYPE_ROCK],
  [HOLD_EFFECT_STRENGTHEN_GRASS, TYPE_GRASS], [HOLD_EFFECT_STRENGTHEN_DARK, TYPE_DARK],
  [HOLD_EFFECT_STRENGTHEN_FIGHT, TYPE_FIGHTING], [HOLD_EFFECT_STRENGTHEN_ELECTRIC, TYPE_ELECTRIC],
  [HOLD_EFFECT_STRENGTHEN_WATER, TYPE_WATER], [HOLD_EFFECT_STRENGTHEN_FLYING, TYPE_FLYING],
  [HOLD_EFFECT_STRENGTHEN_POISON, TYPE_POISON], [HOLD_EFFECT_STRENGTHEN_ICE, TYPE_ICE],
  [HOLD_EFFECT_STRENGTHEN_GHOST, TYPE_GHOST], [HOLD_EFFECT_STRENGTHEN_PSYCHIC, TYPE_PSYCHIC],
  [HOLD_EFFECT_STRENGTHEN_FIRE, TYPE_FIRE], [HOLD_EFFECT_STRENGTHEN_DRAGON, TYPE_DRAGON],
  [HOLD_EFFECT_STRENGTHEN_NORMAL, TYPE_NORMAL], [HOLD_EFFECT_ARCEUS_FIRE, TYPE_FIRE], [HOLD_EFFECT_ARCEUS_WATER, TYPE_WATER],
  [HOLD_EFFECT_ARCEUS_ELECTRIC, TYPE_ELECTRIC], [HOLD_EFFECT_ARCEUS_GRASS, TYPE_GRASS], [HOLD_EFFECT_ARCEUS_ICE, TYPE_ICE],
  [HOLD_EFFECT_ARCEUS_FIGHTING, TYPE_FIGHTING], [HOLD_EFFECT_ARCEUS_POISON, TYPE_POISON],
  [HOLD_EFFECT_ARCEUS_GROUND, TYPE_GROUND], [HOLD_EFFECT_ARCEUS_FLYING, TYPE_FLYING],
  [HOLD_EFFECT_ARCEUS_PSYCHIC, TYPE_PSYCHIC], [HOLD_EFFECT_ARCEUS_BUG, TYPE_BUG], [HOLD_EFFECT_ARCEUS_ROCK, TYPE_ROCK],
  [HOLD_EFFECT_ARCEUS_GHOST, TYPE_GHOST], [HOLD_EFFECT_ARCEUS_DRAGON, TYPE_DRAGON], [HOLD_EFFECT_ARCEUS_DARK, TYPE_DARK],
  [HOLD_EFFECT_ARCEUS_STEEL, TYPE_STEEL],
] as const);

/** sPunchingMoves, battle_lib.c:6566–6582. */
const PUNCHING_MOVES: readonly number[] = Object.freeze([
  MOVE_ICE_PUNCH, MOVE_FIRE_PUNCH, MOVE_THUNDER_PUNCH, MOVE_MACH_PUNCH, MOVE_FOCUS_PUNCH, MOVE_DIZZY_PUNCH,
  MOVE_DYNAMIC_PUNCH, MOVE_HAMMER_ARM, MOVE_MEGA_PUNCH, MOVE_COMET_PUNCH, MOVE_METEOR_MASH, MOVE_SHADOW_PUNCH,
  MOVE_DRAIN_PUNCH, MOVE_BULLET_PUNCH, MOVE_SKY_UPPERCUT,
]);

/** Judgment's type by the held item's hold effect, TrainerAI_CalcDamage's own switch (trainer_ai.c:2901–2969). */
const JUDGMENT_TYPES: ReadonlyMap<number, number> = new Map([
  [HOLD_EFFECT_ARCEUS_FIGHTING, TYPE_FIGHTING], [HOLD_EFFECT_ARCEUS_FLYING, TYPE_FLYING],
  [HOLD_EFFECT_ARCEUS_POISON, TYPE_POISON], [HOLD_EFFECT_ARCEUS_GROUND, TYPE_GROUND], [HOLD_EFFECT_ARCEUS_ROCK, TYPE_ROCK],
  [HOLD_EFFECT_ARCEUS_BUG, TYPE_BUG], [HOLD_EFFECT_ARCEUS_GHOST, TYPE_GHOST], [HOLD_EFFECT_ARCEUS_STEEL, TYPE_STEEL],
  [HOLD_EFFECT_ARCEUS_FIRE, TYPE_FIRE], [HOLD_EFFECT_ARCEUS_WATER, TYPE_WATER], [HOLD_EFFECT_ARCEUS_GRASS, TYPE_GRASS],
  [HOLD_EFFECT_ARCEUS_ELECTRIC, TYPE_ELECTRIC], [HOLD_EFFECT_ARCEUS_PSYCHIC, TYPE_PSYCHIC],
  [HOLD_EFFECT_ARCEUS_ICE, TYPE_ICE], [HOLD_EFFECT_ARCEUS_DRAGON, TYPE_DRAGON], [HOLD_EFFECT_ARCEUS_DARK, TYPE_DARK],
]);

/** `100 - RandNext() % 16` (trainer_ai.c:240): 4096 of the 65536 values for each index 0–15. */
const ROLL_WEIGHTS: readonly bigint[] = Object.freeze(residueWeights(16));

/**
 * Magnitude's simulated roll (trainer_ai.c:3030–3046): `RandNext() % 100` bucketed by the thresholds 5, 15, 35, 65, 85
 * and 95. One pick over the seven buckets, each weighted by the count of its residues, has the odds of a pick over all
 * 100 residues: 3280, 6560, 13120, 19651, 13100, 6550 and 3275 of 65536.
 */
const MAGNITUDE_POWERS: readonly number[] = Object.freeze([10, 30, 50, 70, 90, 110, 150]);
const MAGNITUDE_WEIGHTS: readonly bigint[] = Object.freeze(magnitudeWeights());

function magnitudeWeights(): bigint[] {
  const residues = residueWeights(100);
  const bounds = [0, 5, 15, 35, 65, 85, 95, 100];
  return MAGNITUDE_POWERS.map((_, i) => residues.slice(bounds[i], bounds[i + 1]).reduce((a, b) => a + b, 0n));
}

/** `(s16)x`: the low 16 bits, read as two's complement. */
function s16(x: number): number {
  return (x << 16) >> 16;
}

/** `battleCtx->turnFlags[battler]`. AiError('BAD_VIEW') when the view has none. */
function turnFlags(v: AiView, battler: number): AiTurnFlags {
  const flags = v.turnFlags[battler];
  if (flags === undefined) throw new AiError('BAD_VIEW', `no turnFlags for battler ${battler}`);
  return flags;
}

/** BattleSystem_AnyBattlersWithMoveEffect, battle_lib.c:3342: whether any battler in play has a bit of `effectMask`. */
function anyBattlersWithMoveEffect(v: AiView, effectMask: number): boolean {
  const n = maxBattlers(v); // :3345
  for (let i = 0; i < n; i++) if ((battleMon(v, i).moveEffectsMask & effectMask) !== 0) return true; // :3347–3352
  return false;
}

/** DamageCalcParams, battle_lib.c:6584–6599: one side's fields, in the C's widths. */
interface DamageCalcParams {
  species: number; curHP: number; maxHP: number; heldItemEffect: number; heldItemPower: number; statusMask: number;
  ability: number; gender: number; type1: number; type2: number;
}

/** The DamageCalcParams of `battler`, as battle_lib.c:6645–6668 fills them. */
function damageCalcParams(v: AiView, d: AiDeps, battler: number): DamageCalcParams {
  const mon = battleMon(v, battler);
  const item = heldItem(v, battler); // Battler_HeldItem: none under Klutz or Embargo (:6662, 6666)
  return {
    species: u16(mon.species), // :6645–6646
    curHP: s16(mon.curHP), // :6647–6648
    maxHP: u16(mon.maxHP), // :6649–6650
    statusMask: u32(mon.status), // :6651–6652
    ability: u8(battlerAbility(v, battler)), // :6653–6654
    gender: u8(mon.gender), // :6655–6656
    type1: u8(battlerType(v, d, battler, 1)), // :6657–6658
    type2: u8(battlerType(v, d, battler, 2)), // :6659–6660
    heldItemEffect: itemData(d, item, 'holdEffect'), // :6663, 6667
    heldItemPower: itemData(d, item, 'holdParam'), // :6664, 6668
  };
}

/** The stage clamp of battle_lib.c:6852–6857 and its copies: −6 to +6 around neutral. */
function clampStage(stage: number): number {
  if (stage < MIN_STAT_STAGE - DEFAULT_STAT_STAGE) stage = MIN_STAT_STAGE - DEFAULT_STAT_STAGE;
  if (stage > MAX_STAT_STAGE - DEFAULT_STAT_STAGE) stage = MAX_STAT_STAGE - DEFAULT_STAT_STAGE;
  return stage;
}

/** `stat * sStatStageBoosts[stage].numerator / sStatStageBoosts[stage].denominator`, in int arithmetic. */
function staged(stat: number, stage: number): number {
  const [numerator, denominator] = statStageBoost(stage);
  return cdiv(Math.imul(stat, numerator), denominator);
}

/** `(x * mul) / div` in int arithmetic, the C's percentage and tenth multipliers. */
function scale(x: number, mul: number, div: number): number {
  return cdiv(Math.imul(x, mul), div);
}

/**
 * BattleSystem_CalcMoveDamage, battle_lib.c:6601: the base damage of `move` from `attacker` into `defender`, before
 * STAB, the type chart and the random roll. `power` 0 means the move's own power; `type` TYPE_NORMAL means the move's
 * own type. `critMul` is the critical multiplier, 1 for none.
 *
 * Singles only: NO_CLOUD_NINE (:6921) counts abilities over BattleSystem_GetMaxBattlers, which throws
 * AiError('UNSUPPORTED') for a doubles view, so the doubles-only branches (:6985–6987, :7026–7028, :7035–7044) can't be
 * reached and are left out. AiError('DIV_ZERO') when the defending stat rounds to 0 (:6975, :7020).
 */
export function calcMoveDamage(
  v: AiView, d: AiDeps, move: number, sideMask: number, fieldMask: number, power: number, type: number,
  attacker: number, defender: number, critMul: number,
): number {
  const sideConditions = u32(sideMask);
  const fieldConditions = u32(fieldMask);
  const inPower = u16(power);
  const inType = u8(type);
  const criticalMul = u8(critMul);
  const atk = battleMon(v, attacker);
  const def = battleMon(v, defender);
  const data = moveData(d, move);
  // :6633 GF_ASSERT(criticalMul >= 1) is compiled out.

  let attackStat = u16(atk.attack); // :6635
  let defenseStat = u16(def.defense); // :6636
  let spAttackStat = u16(atk.spAttack); // :6637
  let spDefenseStat = u16(def.spDefense); // :6638
  let attackStage = s8(atk.statBoosts[BATTLE_STAT.ATTACK]! - DEFAULT_STAT_STAGE); // :6639
  let defenseStage = s8(def.statBoosts[BATTLE_STAT.DEFENSE]! - DEFAULT_STAT_STAGE); // :6640
  let spAttackStage = s8(atk.statBoosts[BATTLE_STAT.SP_ATTACK]! - DEFAULT_STAT_STAGE); // :6641
  let spDefenseStage = s8(def.statBoosts[BATTLE_STAT.SP_DEFENSE]! - DEFAULT_STAT_STAGE); // :6642
  const attackerLevel = u8(atk.level); // :6643
  const attackerParams = damageCalcParams(v, d, attacker); // :6645–6664
  const defenderParams = damageCalcParams(v, d, defender); // :6645–6668
  const battleType = u32(v.battleType); // :6670

  let movePower = u16(inPower === 0 ? data.power : inPower); // :6673–6677

  let moveType: number; // :6679–6685
  if (attackerParams.ability === ABILITY_NORMALIZE) moveType = TYPE_NORMAL;
  else if (inType === TYPE_NORMAL) moveType = u8(data.type);
  else moveType = inType & 0x3f;

  // :6687 GF_ASSERT(powerMul >= 10) is compiled out.
  movePower = u16(scale(movePower, v.powerMul, 10)); // :6688
  if ((atk.moveEffectsMask & MOVE_EFFECT_CHARGE) !== 0 && moveType === TYPE_ELECTRIC) movePower = u16(movePower * 2); // :6690–6692
  if (turnFlags(v, attacker).helpingHand) movePower = u16(scale(movePower, 15, 10)); // :6694–6696
  if (attackerParams.ability === ABILITY_TECHNICIAN && move !== MOVE_STRUGGLE && movePower <= 60) {
    movePower = u16(scale(movePower, 15, 10)); // :6698–6702
  }

  const moveClass = classOf(data.category); // :6704

  if (attackerParams.ability === ABILITY_HUGE_POWER || attackerParams.ability === ABILITY_PURE_POWER) {
    attackStat = u16(attackStat * 2); // :6706–6708
  }
  // :6709–6714: int arithmetic, so a switch-in this turn (slowStartTurnNumber = totalTurns + 1) gives -1 < 5. The turn
  // number is unknown after a Transform, which resets it (battle_script.c:5360) when the state doesn't say.
  if (attackerParams.ability === ABILITY_SLOW_START) {
    requireKnown(v, PATHS.slowStartTurnNumber(attacker));
    if (v.totalTurns - atk.effects.slowStartTurnNumber < 5) attackStat = cdiv(attackStat, 2);
  }

  for (const [itemEffect, boostedType] of TYPE_BOOSTING_ITEMS) { // :6716–6722
    if (attackerParams.heldItemEffect === itemEffect && moveType === boostedType) {
      movePower = u16(scale(movePower, 100 + attackerParams.heldItemPower, 100));
      break;
    }
  }

  if (attackerParams.heldItemEffect === HOLD_EFFECT_CHOICE_ATK) attackStat = u16(scale(attackStat, 150, 100)); // :6724–6726
  if (attackerParams.heldItemEffect === HOLD_EFFECT_CHOICE_SPATK) spAttackStat = u16(scale(spAttackStat, 150, 100)); // :6727–6729
  if (attackerParams.heldItemEffect === HOLD_EFFECT_LATI_SPECIAL && (battleType & BATTLE_TYPE_FRONTIER) === 0
    && (attackerParams.species === SPECIES_LATIOS || attackerParams.species === SPECIES_LATIAS)) {
    spAttackStat = u16(scale(spAttackStat, 150, 100)); // :6730–6734
  }
  if (defenderParams.heldItemEffect === HOLD_EFFECT_LATI_SPECIAL && (battleType & BATTLE_TYPE_FRONTIER) === 0
    && (defenderParams.species === SPECIES_LATIOS || defenderParams.species === SPECIES_LATIAS)) {
    spDefenseStat = u16(scale(spDefenseStat, 150, 100)); // :6735–6739
  }
  if (attackerParams.heldItemEffect === HOLD_EFFECT_CLAMPERL_SPATK && attackerParams.species === SPECIES_CLAMPERL) {
    spAttackStat = u16(spAttackStat * 2); // :6740–6743
  }
  if (defenderParams.heldItemEffect === HOLD_EFFECT_CLAMPERL_SPDEF && defenderParams.species === SPECIES_CLAMPERL) {
    spDefenseStat = u16(spDefenseStat * 2); // :6744–6747
  }
  if (attackerParams.heldItemEffect === HOLD_EFFECT_PIKA_SPATK_UP && attackerParams.species === SPECIES_PIKACHU) {
    movePower = u16(movePower * 2); // :6748–6751
  }
  if (defenderParams.heldItemEffect === HOLD_EFFECT_DITTO_DEF_UP && defenderParams.species === SPECIES_DITTO) {
    defenseStat = u16(defenseStat * 2); // :6752–6755
  }
  if (attackerParams.heldItemEffect === HOLD_EFFECT_CUBONE_ATK_UP
    && (attackerParams.species === SPECIES_CUBONE || attackerParams.species === SPECIES_MAROWAK)) {
    attackStat = u16(attackStat * 2); // :6756–6759
  }
  if (attackerParams.heldItemEffect === HOLD_EFFECT_DIALGA_BOOST && (moveType === TYPE_DRAGON || moveType === TYPE_STEEL)
    && attackerParams.species === SPECIES_DIALGA) {
    movePower = u16(scale(movePower, 100 + attackerParams.heldItemPower, 100)); // :6760–6764
  }
  if (attackerParams.heldItemEffect === HOLD_EFFECT_PALKIA_BOOST && (moveType === TYPE_DRAGON || moveType === TYPE_WATER)
    && attackerParams.species === SPECIES_PALKIA) {
    movePower = u16(scale(movePower, 100 + attackerParams.heldItemPower, 100)); // :6765–6769
  }
  if (attackerParams.heldItemEffect === HOLD_EFFECT_GIRATINA_BOOST && (moveType === TYPE_DRAGON || moveType === TYPE_GHOST)
    && (atk.statusVolatile & VOLATILE_CONDITION_TRANSFORM) === 0 && attackerParams.species === SPECIES_GIRATINA) {
    movePower = u16(scale(movePower, 100 + attackerParams.heldItemPower, 100)); // :6770–6775
  }
  if (attackerParams.heldItemEffect === HOLD_EFFECT_POWER_UP_PHYS && moveClass === MOVE_CLASS.PHYSICAL) {
    movePower = u16(scale(movePower, 100 + attackerParams.heldItemPower, 100)); // :6776–6779
  }
  if (attackerParams.heldItemEffect === HOLD_EFFECT_POWER_UP_SPEC && moveClass === MOVE_CLASS.SPECIAL) {
    movePower = u16(scale(movePower, 100 + attackerParams.heldItemPower, 100)); // :6780–6783
  }

  if (ignorableAbility(v, attacker, defender, ABILITY_THICK_FAT) && (moveType === TYPE_FIRE || moveType === TYPE_ICE)) {
    movePower = cdiv(movePower, 2); // :6785–6788
  }

  if (attackerParams.ability === ABILITY_HUSTLE) attackStat = u16(scale(attackStat, 150, 100)); // :6790–6792
  if (attackerParams.ability === ABILITY_GUTS && attackerParams.statusMask !== 0) attackStat = u16(scale(attackStat, 150, 100)); // :6793–6795

  if (ignorableAbility(v, attacker, defender, ABILITY_MARVEL_SCALE) && defenderParams.statusMask !== 0) {
    defenseStat = u16(scale(defenseStat, 150, 100)); // :6797–6800
  }

  if (attackerParams.ability === ABILITY_PLUS && countAbility(v, COUNT_ALIVE_BATTLERS_OUR_SIDE, attacker, ABILITY_MINUS) !== 0) {
    spAttackStat = u16(scale(spAttackStat, 150, 100)); // :6802–6805
  }
  if (attackerParams.ability === ABILITY_MINUS && countAbility(v, COUNT_ALIVE_BATTLERS_OUR_SIDE, attacker, ABILITY_PLUS) !== 0) {
    spAttackStat = u16(scale(spAttackStat, 150, 100)); // :6806–6809
  }

  if (moveType === TYPE_ELECTRIC && anyBattlersWithMoveEffect(v, MOVE_EFFECT_MUD_SPORT)) movePower = cdiv(movePower, 2); // :6811–6814
  if (moveType === TYPE_FIRE && anyBattlersWithMoveEffect(v, MOVE_EFFECT_WATER_SPORT)) movePower = cdiv(movePower, 2); // :6815–6818

  // :6820–6839: the pinch abilities, on the s16 curHP and u16 maxHP.
  const pinch = attackerParams.curHP <= cdiv(attackerParams.maxHP, 3);
  if (moveType === TYPE_GRASS && attackerParams.ability === ABILITY_OVERGROW && pinch) movePower = u16(scale(movePower, 150, 100));
  if (moveType === TYPE_FIRE && attackerParams.ability === ABILITY_BLAZE && pinch) movePower = u16(scale(movePower, 150, 100));
  if (moveType === TYPE_WATER && attackerParams.ability === ABILITY_TORRENT && pinch) movePower = u16(scale(movePower, 150, 100));
  if (moveType === TYPE_BUG && attackerParams.ability === ABILITY_SWARM && pinch) movePower = u16(scale(movePower, 150, 100));

  if (moveType === TYPE_FIRE && ignorableAbility(v, attacker, defender, ABILITY_HEATPROOF)) movePower = cdiv(movePower, 2); // :6841–6844
  if (moveType === TYPE_FIRE && ignorableAbility(v, attacker, defender, ABILITY_DRY_SKIN)) {
    movePower = u16(scale(movePower, 125, 100)); // :6845–6848
  }

  if (attackerParams.ability === ABILITY_SIMPLE) { // :6850–6866
    attackStage = clampStage(s8(attackStage * 2));
    spAttackStage = clampStage(s8(spAttackStage * 2));
  }
  if (ignorableAbility(v, attacker, defender, ABILITY_SIMPLE)) { // :6868–6884
    defenseStage = clampStage(s8(defenseStage * 2));
    spDefenseStage = clampStage(s8(spDefenseStage * 2));
  }
  if (ignorableAbility(v, attacker, defender, ABILITY_UNAWARE)) { // :6886–6889
    attackStage = 0;
    spAttackStage = 0;
  }
  if (attackerParams.ability === ABILITY_UNAWARE) { // :6891–6894
    defenseStage = 0;
    spDefenseStage = 0;
  }
  attackStage = s8(attackStage + DEFAULT_STAT_STAGE); // :6896
  defenseStage = s8(defenseStage + DEFAULT_STAT_STAGE); // :6897
  spAttackStage = s8(spAttackStage + DEFAULT_STAT_STAGE); // :6898
  spDefenseStage = s8(spDefenseStage + DEFAULT_STAT_STAGE); // :6899

  if (attackerParams.ability === ABILITY_RIVALRY && attackerParams.gender === defenderParams.gender
    && attackerParams.gender !== GENDER_NONE && defenderParams.gender !== GENDER_NONE) {
    movePower = u16(scale(movePower, 125, 100)); // :6901–6906
  }
  if (attackerParams.ability === ABILITY_RIVALRY && attackerParams.gender !== defenderParams.gender
    && attackerParams.gender !== GENDER_NONE && defenderParams.gender !== GENDER_NONE) {
    movePower = u16(scale(movePower, 75, 100)); // :6907–6912
  }

  if (PUNCHING_MOVES.includes(move) && attackerParams.ability === ABILITY_IRON_FIST) movePower = u16(scale(movePower, 12, 10)); // :6914–6919

  if (noCloudNine(v)) { // :6921–6941
    if ((fieldConditions & FIELD_CONDITION_SUNNY) !== 0 && attackerParams.ability === ABILITY_SOLAR_POWER) {
      spAttackStat = u16(scale(spAttackStat, 15, 10)); // :6922–6924
    }
    if ((fieldConditions & FIELD_CONDITION_SANDSTORM) !== 0
      && (defenderParams.type1 === TYPE_ROCK || defenderParams.type2 === TYPE_ROCK)) {
      spDefenseStat = u16(scale(spDefenseStat, 15, 10)); // :6926–6929
    }
    if ((fieldConditions & FIELD_CONDITION_SUNNY) !== 0
      && countAbility(v, COUNT_ALIVE_BATTLERS_OUR_SIDE, attacker, ABILITY_FLOWER_GIFT) !== 0) {
      attackStat = u16(scale(attackStat, 15, 10)); // :6931–6934
    }
    if ((fieldConditions & FIELD_CONDITION_SUNNY) !== 0 && battlerAbility(v, attacker) !== ABILITY_MOLD_BREAKER
      && countAbility(v, COUNT_ALIVE_BATTLERS_OUR_SIDE, defender, ABILITY_FLOWER_GIFT) !== 0) {
      spDefenseStat = u16(scale(spDefenseStat, 15, 10)); // :6936–6940
    }
  }

  if (data.effect === BATTLE_EFFECT_HALVE_DEFENSE) defenseStat = cdiv(defenseStat, 2); // :6943–6945

  let damage = 0; // :6614
  let stageDivisor = 0; // :6615
  if (moveClass === MOVE_CLASS.PHYSICAL) { // :6947–6991
    if (criticalMul > 1) damage = attackStage > DEFAULT_STAT_STAGE ? staged(attackStat, attackStage) : attackStat; // :6948–6954
    else damage = staged(attackStat, attackStage); // :6955–6958
    damage = Math.imul(damage, movePower); // :6960
    damage = Math.imul(damage, cdiv(attackerLevel * 2, 5) + 2); // :6961
    if (criticalMul > 1) stageDivisor = defenseStage < DEFAULT_STAT_STAGE ? staged(defenseStat, defenseStage) : defenseStat; // :6963–6969
    else stageDivisor = staged(defenseStat, defenseStage); // :6970–6973
    damage = cdiv(damage, stageDivisor); // :6975
    damage = cdiv(damage, 50); // :6976
    if ((attackerParams.statusMask & MON_CONDITION_BURN) !== 0 && attackerParams.ability !== ABILITY_GUTS) {
      damage = cdiv(damage, 2); // :6978–6980
    }
    if ((sideConditions & SIDE_CONDITION_REFLECT) !== 0 && criticalMul === 1 && data.effect !== BATTLE_EFFECT_REMOVE_SCREENS) {
      damage = cdiv(damage, 2); // :6982–6990, singles
    }
  } else if (moveClass === MOVE_CLASS.SPECIAL) { // :6992–7033
    if (criticalMul > 1) damage = spAttackStage > DEFAULT_STAT_STAGE ? staged(spAttackStat, spAttackStage) : spAttackStat; // :6993–6999
    else damage = staged(spAttackStat, spAttackStage); // :7000–7003
    damage = Math.imul(damage, movePower); // :7005
    damage = Math.imul(damage, cdiv(attackerLevel * 2, 5) + 2); // :7006
    if (criticalMul > 1) stageDivisor = spDefenseStage < DEFAULT_STAT_STAGE ? staged(spDefenseStat, spDefenseStage) : spDefenseStat; // :7008–7014
    else stageDivisor = staged(spDefenseStat, spDefenseStage); // :7015–7018
    damage = cdiv(damage, stageDivisor); // :7020
    damage = cdiv(damage, 50); // :7021
    if ((sideConditions & SIDE_CONDITION_LIGHT_SCREEN) !== 0 && criticalMul === 1 && data.effect !== BATTLE_EFFECT_REMOVE_SCREENS) {
      damage = cdiv(damage, 2); // :7023–7031, singles
    }
  }

  if (noCloudNine(v)) { // :7046–7072
    if ((fieldConditions & FIELD_CONDITION_RAINING) !== 0) { // :7047–7056
      if (moveType === TYPE_FIRE) damage = cdiv(damage, 2);
      else if (moveType === TYPE_WATER) damage = scale(damage, 15, 10);
    }
    // :7058–7060. The C tests the mask first; testing the move first reads deep fog (one of the SOLAR_DOWN bits) only
    // for Solar Beam, with the same result.
    if (move === MOVE_SOLAR_BEAM && anyFieldBit(v, fieldConditions, FIELD_CONDITION_SOLAR_DOWN)) damage = cdiv(damage, 2);
    if ((fieldConditions & FIELD_CONDITION_SUNNY) !== 0) { // :7062–7071
      if (moveType === TYPE_FIRE) damage = scale(damage, 15, 10);
      else if (moveType === TYPE_WATER) damage = cdiv(damage, 2);
    }
  }

  if (atk.effects.flashFire && moveType === TYPE_FIRE) damage = scale(damage, 15, 10); // :7074–7076

  return damage + 2; // :7078
}

/**
 * A move-damage roll: AI_CONTEXT.moveDamageRolls[slot] = `100 - RandNext() % 16` (trainer_ai.c:240), 85–100. The
 * cartridge draws all four at TrainerAI_Init; the port fixes lat.rolls[slot] on its first read with 16 × 4096n
 * (index i gives 100 − i) and reads it from there after, so a run that never reads a roll never splits on it.
 */
export function readRoll(lat: Latents, slot: number, pick: Pick): number {
  const fixed = lat.rolls[slot];
  if (fixed !== null && fixed !== undefined) return fixed;
  const roll = 100 - pick(ROLL_WEIGHTS);
  lat.rolls[slot] = roll;
  return roll;
}

/**
 * TrainerAI_CalcDamage, trainer_ai.c:2868: the AI's estimate of `move`'s damage from `attacker` into `defender`
 * (AI_CONTEXT.defender, which the C reads instead of taking it as an argument), with the attacker's `heldItem`,
 * `ivs`, `ability` and `embargoTurns` as the caller passes them, at `variance` percent. `ivsOf` is the battler slot
 * whose BattleMon IVs `ivs` are, which Hidden Power checks with requireKnown first (a transformed battler's are its
 * target's), or null for a party Pokémon's, which are always known. The switch picks special cases
 * by move ID, so a hack's move at a special-cased ID takes that case's formula (Triple Axel at 149 is estimated as
 * Psywave, Bulldoze at 222 as Magnitude). Psywave's `RandNext() % 11` and Magnitude's
 * `RandNext() % 100` draw through `pick`.
 *
 * The C sets SYSCTL_IGNORE_TYPE_CHECKS around its ApplyTypeChart call for fixed damage (:3093) and then clears it
 * (:3104). The port passes its own mask to applyTypeChart instead. The clear can only matter if the bit was set on
 * entry; BattleContext_Init clears it at every turn end (battle_lib.c:2009), so the AI never sees it set, and a view
 * that has it set throws AiError('UNSUPPORTED'): later reads would see the C's clear, which a pure port can't carry.
 */
export function aiCalcDamage(
  v: AiView, d: AiDeps, move: number, heldItem: number, ivs: Stats, ivsOf: number | null, attacker: number,
  defender: number, ability: number, embargoTurns: number, variance: number, pick: Pick,
): number {
  if ((v.battleStatusMask & SYSCTL_IGNORE_TYPE_CHECKS) !== 0) {
    throw new AiError('UNSUPPORTED', 'TrainerAI_CalcDamage clears SYSCTL_IGNORE_TYPE_CHECKS (trainer_ai.c:3104), '
      + 'and this view has it set: later reads would see the clear');
  }
  const moveId = u16(move);
  const item = u16(heldItem);
  const defendingSide = battlerSide(defender); // :2878
  let damage = 0; // :2879
  let power = 0; // :2880
  let type = 0; // :2881

  switch (moveId) { // :2884
    case MOVE_NATURAL_GIFT: // :2885–2895
      if (ability !== ABILITY_KLUTZ && embargoTurns === 0) {
        power = itemData(d, item, 'naturalGiftPower');
        type = power !== 0 ? itemData(d, item, 'naturalGiftType') : TYPE_NORMAL;
      }
      break;
    case MOVE_JUDGMENT: // :2897–2971
      if (ability !== ABILITY_KLUTZ && embargoTurns === 0) {
        power = 0;
        type = JUDGMENT_TYPES.get(itemData(d, item, 'holdEffect')) ?? TYPE_NORMAL;
      }
      break;
    case MOVE_HIDDEN_POWER: { // :2973–2993
      if (ivsOf !== null) requireKnown(v, PATHS.ivs(ivsOf));
      const hp = u8(ivs.hp);
      const atk = u8(ivs.atk);
      const def = u8(ivs.def);
      const spe = u8(ivs.spe);
      const spa = u8(ivs.spa);
      const spd = u8(ivs.spd);
      power = ((hp & 2) >> 1) | ((atk & 2) >> 0) | ((def & 2) << 1) | ((spe & 2) << 2) | ((spa & 2) << 3) | ((spd & 2) << 4);
      type = ((hp & 1) >> 0) | ((atk & 1) << 1) | ((def & 1) << 2) | ((spe & 1) << 3) | ((spa & 1) << 4) | ((spd & 1) << 5);
      power = cdiv(power * 40, 63) + 30; // :2987
      type = cdiv(type * 15, 63) + 1; // :2988
      if (type >= TYPE_MYSTERY) type++; // :2990–2992
      break;
    }
    case MOVE_GYRO_BALL: { // :2995–3003: the speeds the last BattleSystem_CompareBattlerSpeed wrote, in u32 arithmetic
      // A script run passes a view whose monSpeedValues it tracks entry by entry (run.ts), with this path taken off.
      requireKnown(v, PATHS.monSpeedValues);
      const defenderSpeed = v.monSpeedValues[defender];
      const attackerSpeed = v.monSpeedValues[attacker];
      if (defenderSpeed === undefined || attackerSpeed === undefined) throw new AiError('BAD_VIEW', 'no monSpeedValues for a battler');
      power = 1 + cdiv(u32(Math.imul(25, defenderSpeed)), u32(attackerSpeed));
      if (power > 150) power = 150;
      type = TYPE_NORMAL;
      break;
    }
    case MOVE_DRAGON_RAGE: // :3005–3007
      damage = 40;
      break;
    case MOVE_SEISMIC_TOSS: // :3009–3012
    case MOVE_NIGHT_SHADE:
      damage = u8(battleMon(v, attacker).level);
      break;
    case MOVE_PSYWAVE: // :3014–3016: level * (RandNext() % 11 + 5) / 10
      damage = cdiv(u8(battleMon(v, attacker).level) * (pick(residueWeights(11)) + 5), 10);
      break;
    case MOVE_RETURN: // :3018–3021
      requireKnown(v, PATHS.friendship(attacker)); // exact in both views now; the guard stays for a hand-built gap
      power = cdiv(u8(battleMon(v, attacker).friendship) * 10, 25);
      type = TYPE_NORMAL;
      break;
    case MOVE_FRUSTRATION: // :3023–3026
      requireKnown(v, PATHS.friendship(attacker));
      power = cdiv((255 - u8(battleMon(v, attacker).friendship)) * 10, 25);
      type = TYPE_NORMAL;
      break;
    case MOVE_MAGNITUDE: // :3028–3049
      power = MAGNITUDE_POWERS[pick(MAGNITUDE_WEIGHTS)]!;
      type = TYPE_NORMAL;
      break;
    case MOVE_SONIC_BOOM: // :3051–3053
      damage = 20;
      break;
    case MOVE_LOW_KICK: // :3055–3072: the first row whose limit reaches the defender's weight, else 120
    case MOVE_GRASS_KNOT: {
      requireKnown(v, PATHS.weight(defender));
      const weight = battleMon(v, defender).weight;
      const row = WEIGHT_TO_POWER.find(([limit]) => limit >= weight);
      power = row !== undefined ? row[1] : 120;
      break;
    }
    default: // :3074–3078
      power = 0;
      type = TYPE_NORMAL;
      break;
  }

  let statusMask = v.battleStatusMask;
  if (damage === 0) { // :3081–3091
    const sideMask = v.sideConditionsMask[defendingSide];
    if (sideMask === undefined) throw new AiError('BAD_VIEW', `no sideConditionsMask for side ${defendingSide}`);
    damage = calcMoveDamage(v, d, moveId, sideMask, v.fieldConditionsMask, u16(power), u8(type), attacker, defender, 1);
  } else {
    statusMask |= SYSCTL_IGNORE_TYPE_CHECKS; // :3092–3094
  }

  const chart = applyTypeChart(v, d, moveId, type, attacker, defender, damage, statusMask); // :3096–3103
  if ((chart.flags & MOVE_STATUS_IMMUNE) !== 0) return 0; // :3106–3107
  return battleDivide(Math.imul(chart.damage, u8(variance)), 100); // :3108–3110
}

/**
 * TrainerAI_CalcAllDamage, trainer_ai.c:2799: the estimate for each of `moves`' four slots (0 for a slot the AI doesn't
 * calculate) and the largest. A slot is calculated when its effect is in ALT_POWER_EFFECTS, or when it holds a move
 * whose effect isn't in NO_DAMAGE_CALC_EFFECTS and whose power is over 1 (:2827–2828); MOVE_DATA is read for an empty
 * slot too (:2811, :2820). With `varyDamage` a calculated slot reads its roll through readRoll (:2829–2830), else 100.
 * `ivsOf` is aiCalcDamage's.
 */
export function aiCalcAllDamage(
  v: AiView, d: AiDeps, lat: Latents, attacker: number, defender: number, moves: number[], heldItem: number, ivs: Stats,
  ivsOf: number | null, ability: number, embargoTurns: number, varyDamage: boolean, pick: Pick,
): { max: number; values: number[] } {
  if (moves.length < LEARNED_MOVES_MAX) throw new AiError('BAD_VIEW', `${moves.length} move slots, not ${LEARNED_MOVES_MAX}`);
  const values: number[] = [];
  for (let i = 0; i < LEARNED_MOVES_MAX; i++) { // :2808
    const move = u16(moves[i]!);
    const data = moveData(d, move);
    // An empty slot is skipped on the power branch only: (alt power) || (move && !no-calc && power > 1).
    if (isDamageEstimated(data) && (move !== MOVE_NONE || ALT_POWER_EFFECTS.includes(data.effect))) {
      const damageRoll = varyDamage ? readRoll(lat, i, pick) : 100; // :2829–2833
      values.push(aiCalcDamage(v, d, move, heldItem, ivs, ivsOf, attacker, defender, ability, embargoTurns, damageRoll, pick)); // :2835
    } else {
      values.push(0); // :2837
    }
  }
  let max = 0; // :2805
  for (const value of values) if (max < value) max = value; // :2842–2846
  return { max, values };
}
