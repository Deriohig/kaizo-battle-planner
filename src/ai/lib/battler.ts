// The battle_lib.c helpers the trainer AI calls about one battler: its ability, held item and item data, its types,
// the variable-type moves, the ability and move counts, and the weather macros of include/battle/common.h. Literal
// ports over AiView; each rule cites its C line. All are pure: nothing here writes to the view.

import type { MoveRecord, Stats } from '../../rom/types.js';
import {
  ABILITY_AIR_LOCK, ABILITY_CLOUD_NINE, ABILITY_KLUTZ, ABILITY_LEVITATE, ABILITY_MOLD_BREAKER, ABILITY_MULTITYPE,
  ABILITY_NONE, BATTLE_TYPE_DOUBLES, COUNT_ALIVE_BATTLERS, COUNT_ALIVE_BATTLERS_EXCEPT_ME, COUNT_ALIVE_BATTLERS_OUR_SIDE,
  COUNT_ALIVE_BATTLERS_THEIR_SIDE, COUNT_ALIVE_BATTLERS_THEIR_SIDE_FLAG, COUNT_ALL_BATTLERS, COUNT_ALL_BATTLERS_EXCEPT_ME,
  COUNT_ALL_BATTLERS_EXCEPT_ME_RETURN_BATTLER, COUNT_ALL_BATTLERS_OUR_SIDE, COUNT_ALL_BATTLERS_THEIR_SIDE,
  FIELD_CONDITION_DEEP_FOG, FIELD_CONDITION_GRAVITY, FIELD_CONDITION_HAILING, FIELD_CONDITION_RAINING,
  FIELD_CONDITION_SANDSTORM, FIELD_CONDITION_SUNNY, FIELD_CONDITION_WEATHER, HOLD_EFFECT_ARCEUS_BUG,
  HOLD_EFFECT_ARCEUS_DARK, HOLD_EFFECT_ARCEUS_DRAGON, HOLD_EFFECT_ARCEUS_ELECTRIC, HOLD_EFFECT_ARCEUS_FIGHTING,
  HOLD_EFFECT_ARCEUS_FIRE, HOLD_EFFECT_ARCEUS_FLYING, HOLD_EFFECT_ARCEUS_GHOST, HOLD_EFFECT_ARCEUS_GRASS,
  HOLD_EFFECT_ARCEUS_GROUND, HOLD_EFFECT_ARCEUS_ICE, HOLD_EFFECT_ARCEUS_POISON, HOLD_EFFECT_ARCEUS_PSYCHIC,
  HOLD_EFFECT_ARCEUS_ROCK, HOLD_EFFECT_ARCEUS_STEEL, HOLD_EFFECT_ARCEUS_WATER, ITEM_NONE, ITEM_POWER_CHECK_ALL,
  ITEM_POWER_CHECK_EMBARGO, ITEM_POWER_CHECK_NONE, LEARNED_MOVES_MAX, MAX_BATTLERS, MOVE_EFFECT_ABILITY_SUPPRESSED,
  MOVE_EFFECT_INGRAIN, MOVE_HIDDEN_POWER, MOVE_JUDGMENT, MOVE_NATURAL_GIFT, MOVE_NONE, MOVE_WEATHER_BALL,
  SPECIES_ARCEUS, TYPE_BUG, TYPE_DARK, TYPE_DRAGON, TYPE_ELECTRIC, TYPE_FIGHTING, TYPE_FIRE, TYPE_FLYING, TYPE_GHOST,
  TYPE_GRASS, TYPE_GROUND, TYPE_ICE, TYPE_MYSTERY, TYPE_NORMAL, TYPE_POISON, TYPE_PSYCHIC, TYPE_ROCK, TYPE_STEEL,
  TYPE_WATER,
} from '../constants.js';
import { AiError } from '../errors.js';
import { cdiv, u16, u8 } from '../int.js';
import type { AiBattleMon, AiDeps, AiPartyMon, AiView } from '../view.js';
import { PATHS, requireKnown } from './known.js';

/** `battleCtx->battleMons[battler]`. AiError('BAD_VIEW') outside 0–3. */
export function battleMon(v: AiView, battler: number): AiBattleMon {
  const mon = v.mons[battler];
  if (mon === undefined) throw new AiError('BAD_VIEW', `battler ${battler} is not a battler slot`);
  return mon;
}

/** MOVE_DATA(move) (include/battle/common.h:25). AiError('BAD_VIEW') when the deps have no record for it. */
export function moveData(d: AiDeps, move: number): MoveRecord {
  const record = d.moves[move];
  if (record === undefined) throw new AiError('BAD_VIEW', `move ${move} has no record`);
  return record;
}

/** BattleSystem_GetMaxBattlers (battle_system.c:119): 2 in singles (battle_main.c:1326–1333). Doubles: AiError('UNSUPPORTED'). */
export function maxBattlers(v: AiView): number {
  if ((v.battleType & BATTLE_TYPE_DOUBLES) !== 0) throw new AiError('UNSUPPORTED', 'double battles are not supported');
  return MAX_BATTLERS / 2;
}

/**
 * BattleSystem_GetBattlerSide (battle_system.c:360): the battler type & 1. A singles battler's type is its slot
 * (sSingleBattleBattlerTypes, battle_main.c:948), so the side is the slot.
 */
export function battlerSide(battler: number): number {
  return battler & 1;
}

/** The item data parameters the helpers read, as AiItemRecord names them. */
type ItemParam = 'holdEffect' | 'holdParam' | 'flingPower' | 'naturalGiftPower' | 'naturalGiftType';

/**
 * BattleSystem_GetItemData (battle_lib.c:7254): one parameter of `item`'s data. AiError('BAD_VIEW') when the item has
 * no record: the cartridge would read past its item table.
 */
export function itemData(d: AiDeps, item: number, param: ItemParam): number {
  const record = d.items[u16(item)];
  if (record === undefined || record === null) {
    throw new AiError('BAD_VIEW', `item ${item} has no record; the cartridge would read past its item table`);
  }
  return record[param];
}

/** Battler_Ability, battle_lib.c:3088: the ability as the battle reads it (u8). */
export function battlerAbility(v: AiView, battler: number): number {
  const mon = battleMon(v, battler);
  // battle_lib.c:3090: Gastro Acid suppresses every ability but Multitype.
  if ((mon.moveEffectsMask & MOVE_EFFECT_ABILITY_SUPPRESSED) !== 0 && mon.ability !== ABILITY_MULTITYPE) return ABILITY_NONE;
  // battle_lib.c:3095: Gravity grounds a Levitate holder.
  if ((v.fieldConditionsMask & FIELD_CONDITION_GRAVITY) !== 0 && mon.ability === ABILITY_LEVITATE) return ABILITY_NONE;
  // battle_lib.c:3100: so does Ingrain.
  if ((mon.moveEffectsMask & MOVE_EFFECT_INGRAIN) !== 0 && mon.ability === ABILITY_LEVITATE) return ABILITY_NONE;
  return u8(mon.ability); // battle_lib.c:3105
}

/**
 * Battler_IgnorableAbility, battle_lib.c:3108: whether `defender`'s ability is `ability` and `attacker`'s isn't Mold
 * Breaker. With Mold Breaker the C also sets selfTurnFlags[attacker].moldBreakerActivated and
 * SYSCTL_APPLY_MOLD_BREAKER (battle_lib.c:3116–3119); nothing else reads either, and the result is FALSE whether or
 * not they were set, so the port leaves them out.
 */
export function ignorableAbility(v: AiView, attacker: number, defender: number, ability: number): boolean {
  if (battlerAbility(v, attacker) !== ABILITY_MOLD_BREAKER) return battlerAbility(v, defender) === ability; // :3112–3115
  return false; // :3116–3122
}

/** Battler_HeldItem, battle_lib.c:5352: the held item (u16), none under Klutz or Embargo. */
export function heldItem(v: AiView, battler: number): number {
  if (battlerAbility(v, battler) === ABILITY_KLUTZ) return ITEM_NONE; // :5354
  const mon = battleMon(v, battler);
  if (mon.effects.embargoTurns !== 0) return ITEM_NONE; // :5358
  return u16(mon.heldItem); // :5362
}

/** Battler_HeldItemEffect, battle_lib.c:5438. */
export function heldItemEffect(v: AiView, d: AiDeps, battler: number): number {
  return itemData(d, heldItem(v, battler), 'holdEffect');
}

/** Battler_HeldItemPower, battle_lib.c:5444: the item's effect parameter, the item read as `mode` says (ITEM_POWER_CHECK_*). */
export function heldItemPower(v: AiView, d: AiDeps, battler: number, mode: number): number {
  let item: number;
  switch (mode) {
    case ITEM_POWER_CHECK_ALL:
      item = heldItem(v, battler); // :5448–5450
      break;
    case ITEM_POWER_CHECK_EMBARGO:
      if (battleMon(v, battler).effects.embargoTurns !== 0) return 0; // :5452–5455
    // falls through, as the C does (no break at :5455)
    case ITEM_POWER_CHECK_NONE:
      item = u16(battleMon(v, battler).heldItem); // :5457–5459
      break;
    default:
      throw new AiError('UNDEFINED', `Battler_HeldItemPower with mode ${mode} reads an uninitialised item (battle_lib.c:5446)`);
  }
  return itemData(d, item, 'holdParam'); // :5462
}

/** Battler_NaturalGiftType, battle_lib.c:5471. */
export function naturalGiftType(v: AiView, d: AiDeps, battler: number): number {
  return itemData(d, heldItem(v, battler), 'naturalGiftType');
}

/** Battler_ItemFlingPower, battle_lib.c:5491: 0 under Embargo, else the held item's, with no Klutz check. */
export function itemFlingPower(v: AiView, d: AiDeps, battler: number): number {
  const mon = battleMon(v, battler);
  if (mon.effects.embargoTurns !== 0) return 0; // :5493
  return itemData(d, mon.heldItem, 'flingPower'); // :5497
}

/**
 * The Arceus plate types, by hold effect; any other hold effect gives Normal. The three switches that map them agree:
 * Battler_MonType (battle_lib.c:7631–7699), TrainerAI_MoveType (trainer_ai.c:3137–3205) and Move_CalcVariableType
 * (battle_lib.c:8107–8159).
 */
const PLATE_TYPES: ReadonlyMap<number, number> = new Map([
  [HOLD_EFFECT_ARCEUS_FIRE, TYPE_FIRE], [HOLD_EFFECT_ARCEUS_WATER, TYPE_WATER], [HOLD_EFFECT_ARCEUS_ELECTRIC, TYPE_ELECTRIC],
  [HOLD_EFFECT_ARCEUS_GRASS, TYPE_GRASS], [HOLD_EFFECT_ARCEUS_ICE, TYPE_ICE], [HOLD_EFFECT_ARCEUS_FIGHTING, TYPE_FIGHTING],
  [HOLD_EFFECT_ARCEUS_POISON, TYPE_POISON], [HOLD_EFFECT_ARCEUS_GROUND, TYPE_GROUND], [HOLD_EFFECT_ARCEUS_FLYING, TYPE_FLYING],
  [HOLD_EFFECT_ARCEUS_PSYCHIC, TYPE_PSYCHIC], [HOLD_EFFECT_ARCEUS_BUG, TYPE_BUG], [HOLD_EFFECT_ARCEUS_ROCK, TYPE_ROCK],
  [HOLD_EFFECT_ARCEUS_GHOST, TYPE_GHOST], [HOLD_EFFECT_ARCEUS_DRAGON, TYPE_DRAGON], [HOLD_EFFECT_ARCEUS_DARK, TYPE_DARK],
  [HOLD_EFFECT_ARCEUS_STEEL, TYPE_STEEL],
]);

function plateType(holdEffect: number): number {
  return PLATE_TYPES.get(holdEffect) ?? TYPE_NORMAL;
}

/**
 * BattleMon_Get(…, BATTLEMON_TYPE_1 or _2) (battle_lib.c:367), that is Battler_MonType (battle_lib.c:7618): the
 * stored type (u8), or the plate's type for an Arceus with Multitype. `which` is 1 or 2.
 */
export function battlerType(v: AiView, d: AiDeps, battler: number, which: 1 | 2): number {
  const mon = battleMon(v, battler);
  const type = u8(which === 1 ? mon.types[0] : mon.types[1]); // :7621–7625
  // :7629–7700: the raw held item, with no Klutz or Embargo check.
  if (mon.species === SPECIES_ARCEUS && mon.ability === ABILITY_MULTITYPE) return plateType(itemData(d, mon.heldItem, 'holdEffect'));
  return type;
}

/** The Hidden Power type of `ivs` (trainer_ai.c:3208–3220, battle_lib.c:8162–8174). Speed is bit 3. */
function hiddenPowerType(ivs: Stats): number {
  const bits = ((ivs.hp & 1) >> 0)
    | ((ivs.atk & 1) << 1)
    | ((ivs.def & 1) << 2)
    | ((ivs.spe & 1) << 3)
    | ((ivs.spa & 1) << 4)
    | ((ivs.spd & 1) << 5);
  let type = cdiv(bits * 15, 63) + 1;
  if (type >= TYPE_MYSTERY) type++;
  return type;
}

/**
 * Weather Ball's type in the two variable-type helpers (trainer_ai.c:3222–3240, battle_lib.c:8176–8196). The type is
 * assigned only when NO_CLOUD_NINE holds and a weather other than fog is up; otherwise the C returns an uninitialised
 * value (in the cartridge, the caller's r5: a battleSys or battleCtx pointer), so this throws AiError('UNDEFINED')
 * With several weathers up, the last test that passes wins. The FIELD_CONDITION_WEATHER test also reads
 * deep fog, but reads it raw: when fog is unknown (PATHS.fog), fog alone and no weather both leave the type unassigned,
 * so the outcome is the same either way.
 */
function weatherBallType(v: AiView, helper: string): number {
  let type: number | undefined;
  if (noCloudNine(v) && (v.fieldConditionsMask & FIELD_CONDITION_WEATHER) !== 0) {
    if (weatherIs(v, 'rain')) type = TYPE_WATER;
    if (weatherIs(v, 'sand')) type = TYPE_ROCK;
    if (weatherIs(v, 'sun')) type = TYPE_FIRE;
    if (weatherIs(v, 'hail')) type = TYPE_ICE;
  }
  if (type === undefined) {
    throw new AiError('UNDEFINED', `${helper}: Weather Ball's type is never assigned without usable weather `
      + '(no weather, Cloud Nine or Air Lock on the field, or fog only); the cartridge returns an uninitialised value');
  }
  return type;
}

/**
 * TrainerAI_MoveType, trainer_ai.c:3127: the type of `move` used by `battler` when it varies (Natural Gift, Judgment,
 * Hidden Power, Weather Ball), else Normal. Weather Ball without usable weather throws AiError('UNDEFINED').
 */
export function aiMoveType(v: AiView, d: AiDeps, battler: number, move: number): number {
  switch (move) {
    case MOVE_NATURAL_GIFT:
      return naturalGiftType(v, d, battler); // :3132–3133
    case MOVE_JUDGMENT:
      return plateType(heldItemEffect(v, d, battler)); // :3136–3206
    case MOVE_HIDDEN_POWER:
      requireKnown(v, PATHS.ivs(battler)); // a transformed battler's are its target's (read/compose.ts unknownOf)
      return hiddenPowerType(battleMon(v, battler).ivs); // :3208–3220
    case MOVE_WEATHER_BALL:
      return weatherBallType(v, 'TrainerAI_MoveType'); // :3221–3240
    default:
      return TYPE_NORMAL; // :3242–3244
  }
}

/**
 * Move_CalcVariableType, battle_lib.c:8097: the same for a party Pokémon, reading its own held item (no Klutz or
 * Embargo check) and IVs. Weather Ball without usable weather throws AiError('UNDEFINED'). The party data's IVs are
 * always known: Transform changes the BattleMon only (battle_script.c:5346–5348), and the party update it sends back
 * carries no IVs (BattleController_EmitUpdatePartyMon, battle_controller.c:1462–1487).
 */
export function partyMoveType(v: AiView, d: AiDeps, mon: AiPartyMon, move: number): number {
  switch (move) {
    case MOVE_NATURAL_GIFT:
      return itemData(d, mon.heldItem, 'naturalGiftType'); // :8102–8104
    case MOVE_JUDGMENT:
      return plateType(itemData(d, mon.heldItem, 'holdEffect')); // :8106–8160
    case MOVE_HIDDEN_POWER:
      return hiddenPowerType(mon.ivs); // :8162–8174
    case MOVE_WEATHER_BALL:
      return weatherBallType(v, 'Move_CalcVariableType'); // :8176–8196
    default:
      return TYPE_NORMAL; // :8198–8200
  }
}

/** BattleSystem_CountAbility, battle_lib.c:2870: counts battlers with `ability` (Battler_Ability), as `mode` (COUNT_*) says. */
export function countAbility(v: AiView, mode: number, battler: number, ability: number): number {
  const n = maxBattlers(v);
  // has, alive and ourSide are module functions, not closures made per call (under tsx's keepNames each closure
  // costs an Object.defineProperty, and the damage estimate counts abilities many times a decision).
  let result = 0;
  switch (mode) {
    case COUNT_ALL_BATTLERS_OUR_SIDE: // :2877
      for (let i = 0; i < n; i++) if (ourSide(battler, i) && has(v, ability, i)) result++;
      break;
    case COUNT_ALIVE_BATTLERS_OUR_SIDE: // :2886
      for (let i = 0; i < n; i++) if (ourSide(battler, i) && alive(v, i) && has(v, ability, i)) result++;
      break;
    case COUNT_ALL_BATTLERS_THEIR_SIDE: // :2896
      for (let i = 0; i < n; i++) if (!ourSide(battler, i) && has(v, ability, i)) result++;
      break;
    case COUNT_ALIVE_BATTLERS_THEIR_SIDE: // :2905
      for (let i = 0; i < n; i++) if (!ourSide(battler, i) && alive(v, i) && has(v, ability, i)) result++;
      break;
    case COUNT_ALIVE_BATTLERS_THEIR_SIDE_FLAG: // :2915: a mask of battlers, not a count
      for (let i = 0; i < n; i++) if (!ourSide(battler, i) && alive(v, i) && has(v, ability, i)) result |= 1 << i;
      break;
    case COUNT_ALL_BATTLERS: // :2925
      for (let i = 0; i < n; i++) if (has(v, ability, i)) result++;
      break;
    case COUNT_ALL_BATTLERS_EXCEPT_ME: // :2933
      for (let i = 0; i < n; i++) if (i !== battler && has(v, ability, i)) result++;
      break;
    case COUNT_ALL_BATTLERS_EXCEPT_ME_RETURN_BATTLER: // :2942: the first such battler + 1
      for (let i = 0; i < n; i++) {
        if (i !== battler && has(v, ability, i)) {
          result = i + 1;
          break;
        }
      }
      break;
    case COUNT_ALIVE_BATTLERS: // :2952
      for (let i = 0; i < n; i++) if (has(v, ability, i) && alive(v, i)) result++;
      break;
    case COUNT_ALIVE_BATTLERS_EXCEPT_ME: // :2961
      for (let i = 0; i < n; i++) if (i !== battler && has(v, ability, i) && alive(v, i)) result++;
      break;
    default: // the C switch has no default: 0
  }
  return result;
}

/** countAbility's test: battler `i` has `ability` (Battler_Ability). */
function has(v: AiView, ability: number, i: number): boolean {
  return battlerAbility(v, i) === ability;
}

/** countAbility's test: battler `i` has HP left. */
function alive(v: AiView, i: number): boolean {
  return battleMon(v, i).curHP !== 0;
}

/** countAbility's test: battler `i` is on `battler`'s side. */
function ourSide(battler: number, i: number): boolean {
  return battlerSide(i) === battlerSide(battler);
}

/** Battler_CountMoves, battle_lib.c:3461: the slots before the first empty one. */
export function countMoves(v: AiView, battler: number): number {
  const moves = battleMon(v, battler).moves;
  let i: number;
  for (i = 0; i < LEARNED_MOVES_MAX; i++) if (moves[i] === MOVE_NONE) break;
  return i;
}

/** BattleSystem_GetPartner (battle_system.c:394): the battler itself in singles (:400–402). Doubles: AiError('UNSUPPORTED'). */
export function partner(v: AiView, battler: number): number {
  if ((v.battleType & BATTLE_TYPE_DOUBLES) === 0) return battler;
  throw new AiError('UNSUPPORTED', 'double battles are not supported');
}

const WEATHER_MASKS = {
  rain: FIELD_CONDITION_RAINING, sand: FIELD_CONDITION_SANDSTORM, sun: FIELD_CONDITION_SUNNY, hail: FIELD_CONDITION_HAILING,
  fog: FIELD_CONDITION_DEEP_FOG,
} as const;

/** WEATHER_IS_RAIN … WEATHER_IS_FOG (include/battle/common.h:68–72): the field mask alone; none checks Cloud Nine. */
export function weatherIs(v: AiView, kind: keyof typeof WEATHER_MASKS): boolean {
  return anyFieldBit(v, v.fieldConditionsMask, WEATHER_MASKS[kind]);
}

/**
 * `(fieldMask & bits) != 0`, the C's field-mask test, for `fieldMask` the view's fieldConditionsMask (or the copy a
 * caller passes). Deep fog's bit may be unknown (PATHS.fog: a Defog after a fog field note, which the log can't settle), so when `bits`
 * holds it and no other bit of `bits` is set, the result hinges on fog and requireKnown guards it.
 */
export function anyFieldBit(v: AiView, fieldMask: number, bits: number): boolean {
  if ((fieldMask & bits & ~FIELD_CONDITION_DEEP_FOG) !== 0) return true;
  if ((bits & FIELD_CONDITION_DEEP_FOG) !== 0) requireKnown(v, PATHS.fog);
  return (fieldMask & bits) !== 0;
}

/** NO_CLOUD_NINE (include/battle/common.h:63): no living battler has Cloud Nine or Air Lock. */
export function noCloudNine(v: AiView): boolean {
  return countAbility(v, COUNT_ALIVE_BATTLERS, 0, ABILITY_CLOUD_NINE) === 0
    && countAbility(v, COUNT_ALIVE_BATTLERS, 0, ABILITY_AIR_LOCK) === 0;
}
