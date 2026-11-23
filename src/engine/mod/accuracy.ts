// The cartridge's accuracy check (pokeplatinum src/battle/battle_controller_player.c), which the mod's
// `hitStepAccuracy` (scripts.ts) runs in place of Showdown's, and which the verification pass reads.
//
// The cartridge checks a move in two steps. `BattleControllerPlayer_CheckMoveHitAccuracy` (:2865-2981) computes a hit
// rate from the move's accuracy, the stat stages, abilities, weather, items and Gravity, and misses iff
// `(RandNext() % 100) + 1 > hitRate`, so a hit iff `r % 100 < hitRate`. `BattleControllerPlayer_CheckMoveHitOverrides`
// (:3001-3046) then lets Protect, Lock-On, No Guard and the weather moves decide whatever the draw was. A one-hit KO
// move skips both and has its own rule (`BtlCmd_TryOHKOMove`, battle_script.c:4334-4384).
//
// Everything here reads the battle and changes nothing: the one side effect of the cartridge's formula, eating a
// Micle Berry's boost, is the mod's (`usesAccuracyFormula`).

import { installedMoves } from '../dex.js';
import { fogCounts } from './field.js';
import { romHeldEffect } from '../speedValues.js';

/** `HitRateByStage` (include/data/hit_rate_stages.h:4-18): the combined stage −6 … +6 as numerator and denominator. */
const HIT_RATE_BY_STAGE: readonly (readonly [number, number])[] = [
  [33, 100], [36, 100], [43, 100], [50, 100], [60, 100], [75, 100], [1, 1],
  [133, 100], [166, 100], [2, 1], [233, 100], [133, 50], [3, 1],
];

/** Move effects, each its line in generated/move_battle_effects.txt less one. */
const EFFECT_THUNDER = 152; // BATTLE_EFFECT_THUNDER, line 153
const EFFECT_BLIZZARD = 260; // BATTLE_EFFECT_BLIZZARD, line 261

/**
 * Hurricane, the hack's move 140 (Barrage's slot, Move Changes tab). The hack's overlay 16 gives it Thunder's weather
 * rule in the battle code: it always hits in rain and has 50 accuracy in sun (from the overlay-16
 * diff; the docs' "does not use the Thunder routine" is about the trainer AI).
 */
const HURRICANE = 140;

/**
 * The hit rate's item terms read the hack ROM's hold effect and parameter of the held item (speedValues.ts
 * `romHeldEffect`, over calc/battler.ts's table from the ROM's item data), as the cartridge reads them:
 * `Battler_HeldItemEffect` and `Battler_HeldItemPower(…, ITEM_POWER_CHECK_ALL)` (bl:5444-5462), both through
 * `Battler_HeldItem` (none under Klutz or Embargo). The defender's `HOLD_EFFECT_ACC_REDUCE` takes `× (100 − itemPower)
 * / 100` (bcp:2949-2954): BrightPowder and Lax Incense have 11 in the hack, 10 in vanilla. The
 * attacker's `HOLD_EFFECT_ACCURACY_UP` and, once the defender has moved, `HOLD_EFFECT_ACCURACY_UP_SLOWER` give
 * `× (100 + itemPower) / 100` (:2956-2965): Wide Lens 10, Zoom Lens 20, as in vanilla.
 */
const heldEffectOf = (pokemon: Pokemon) => romHeldEffect(heldItem(pokemon));

/** The move's ROM effect, as `MOVE_DATA(move).effect` reads it, or null for a move that isn't the hack's. */
function romEffect(move: ActiveMove): number | null {
  return installedMoves().get(move.num)?.romEffect ?? null;
}

/** Whether `move` has Thunder's weather rule (:2915, :3025): Thunder's effect, or Hurricane (the hack's overlay 16). */
function thunderRule(move: ActiveMove): boolean {
  return romEffect(move) === EFFECT_THUNDER || move.num === HURRICANE;
}

/** The move's accuracy as the cartridge's move data has it (`MOVE_DATA(move).accuracy`): the dex's, before Showdown's move callbacks change it. */
function dataAccuracy(move: ActiveMove, battle: Battle): number | true {
  return battle.dex.moves.get(move.id).accuracy;
}

/** `Battler_IgnorableAbility` (battle_lib.c:3108-3123): the defender's ability counts unless the attacker has Mold Breaker. */
function ignorable(attacker: Pokemon, defender: Pokemon, ability: string): boolean {
  return defender.hasAbility(ability) && !attacker.hasAbility('moldbreaker');
}

/** `Battler_HeldItem` (battle_lib.c:5352-5363): no item under Klutz or Embargo. */
function heldItem(pokemon: Pokemon): string {
  return pokemon.ignoringItem() ? '' : pokemon.item;
}

/** `MON_IS_LOCKED_ONTO(attacker, defender)` (include/battle/common.h:51): Showdown keeps Lock-On on its user, aimed at its source. */
function lockedOnto(attacker: Pokemon, defender: Pokemon): boolean {
  return attacker.volatiles['lockon']?.source === defender;
}

/** No Guard on either side (:3016-3022, battle_script.c:4343-4345 and :4356-4359). */
function noGuard(attacker: Pokemon, defender: Pokemon): boolean {
  return attacker.hasAbility('noguard') || defender.hasAbility('noguard');
}

/** `x * numerator / denominator` in the cartridge's integer arithmetic. */
const scale = (x: number, numerator: number, denominator: number) => Math.floor((x * numerator) / denominator);

/**
 * Whether the cartridge runs its hit-rate formula for `move`: it returns before it for a move with no accuracy
 * (`hitRate == 0`, :2900-2903) and for a one-hit KO move (`SYSCTL_NONSTANDARD_ACC_CHECK`, :2911-2913, set by
 * `BtlCmd_TryOHKOMove`). A move's charging turn (:2906-2908) never reaches Showdown's accuracy step. The formula eats a
 * pending Micle Berry boost (:2967-2970), so the mod removes it exactly when this is true.
 */
export function usesAccuracyFormula(move: ActiveMove, battle: Battle): boolean {
  return !move.ohko && dataAccuracy(move, battle) !== true;
}

/** A move that spent its user's Micle Berry boost at the formula's step (mod/scripts.ts `micleTryMove`), before the hit. */
export type MicleMove = ActiveMove & { kaizoMicleBoost?: boolean };

/** The hit rate from `BattleControllerPlayer_CheckMoveHitAccuracy` (:2865-2981), for a move that `usesAccuracyFormula`. */
function formulaHitRate(attacker: Pokemon, defender: Pokemon, move: ActiveMove, battle: Battle, accuracy: number): number {
  // The stages (:2873-2898): Simple doubles, Unaware ignores, Foresight and Miracle Eye drop the defender's evasion.
  let accStages = attacker.boosts.accuracy;
  let evaStages = -defender.boosts.evasion;
  if (attacker.hasAbility('simple')) accStages *= 2;
  if (ignorable(attacker, defender, 'simple')) evaStages *= 2;
  if (ignorable(attacker, defender, 'unaware')) accStages = 0;
  if (attacker.hasAbility('unaware')) evaStages = 0;
  if ((defender.volatiles['foresight'] || defender.volatiles['miracleeye']) && evaStages < 0) evaStages = 0;
  const stage = Math.min(12, Math.max(0, 6 + evaStages + accStages));
  // `NO_CLOUD_NINE && WEATHER_IS_…`: Showdown's effective weather is none under Cloud Nine or Air Lock.
  const weather = battle.field.effectiveWeather();
  let hitRate = weather === 'sunnyday' && thunderRule(move) ? 50 : accuracy; // :2915-2917
  const [numerator, denominator] = HIT_RATE_BY_STAGE[stage]!;
  hitRate = scale(hitRate, numerator, denominator); // :2919-2920
  if (attacker.hasAbility('compoundeyes')) hitRate = scale(hitRate, 130, 100); // :2922-2924
  if (weather === 'sandstorm' && ignorable(attacker, defender, 'sandveil')) hitRate = scale(hitRate, 80, 100); // :2927-2929
  if (weather === 'hail' && ignorable(attacker, defender, 'snowcloak')) hitRate = scale(hitRate, 80, 100); // :2931-2933
  // Deep Fog (the trainer's field note until a weather or Defog clears it, mod/field.ts), unless Cloud Nine or Air Lock
  // is out (`NO_CLOUD_NINE`, :2923).
  if (fogCounts(battle)) hitRate = scale(hitRate, 6, 10); // :2935-2937
  if (attacker.hasAbility('hustle') && move.category === 'Physical') hitRate = scale(hitRate, 80, 100); // :2940-2942
  if (ignorable(attacker, defender, 'tangledfeet') && defender.volatiles['confusion']) hitRate = scale(hitRate, 50, 100); // :2944-2947
  const down = heldEffectOf(defender);
  if (down?.effect === 'ACC_REDUCE') hitRate = scale(hitRate, 100 - down.param, 100); // :2949-2954
  const up = heldEffectOf(attacker);
  if (up?.effect === 'ACCURACY_UP') hitRate = scale(hitRate, 100 + up.param, 100); // :2956-2961
  // `Battler_MovedThisTurn` (battle_lib.c:5365-5368): the defender's action this turn is done, as Showdown's Gen 4 Zoom
  // Lens reads it (the defender has no move left in the queue).
  if (up?.effect === 'ACCURACY_UP_SLOWER' && !battle.queue.willMove(defender)) hitRate = scale(hitRate, 100 + up.param, 100); // :2963-2965
  // :2967-2970. The move that spent the boost at the cartridge's formula step (mod/scripts.ts `micleTryMove`) carries it
  // here, as Showdown's accuracy step comes after the immunity steps the cartridge runs later.
  if (attacker.volatiles['micleberry'] || (move as MicleMove).kaizoMicleBoost) hitRate = scale(hitRate, 120, 100);
  if (battle.field.getPseudoWeather('gravity')) hitRate = scale(hitRate, 10, 6); // :2972-2974
  return hitRate;
}

/**
 * Whether `BattleControllerPlayer_CheckMoveHitOverrides` (:3001-3032) decides the hit whatever the draw: Protect stops
 * a move it can stop (:3007-3014; Showdown then blocks it in its TryHit step), and Lock-On, No Guard (:3016-3022),
 * Thunder's rule in rain (:3025-3027) and Blizzard in hail (:3029-3031) clear a miss.
 */
function overridden(attacker: Pokemon, defender: Pokemon, move: ActiveMove, battle: Battle): boolean {
  if (defender.volatiles['protect'] && move.flags['protect']) return true;
  if (lockedOnto(attacker, defender) || noGuard(attacker, defender)) return true;
  const weather = battle.field.effectiveWeather();
  return (weather === 'raindance' && thunderRule(move)) || (weather === 'hail' && romEffect(move) === EFFECT_BLIZZARD);
}

/** Whether the defender's Sturdy stops `attacker`'s one-hit KO move, before anything else (battle_script.c:4340-4341). */
export function sturdyStopsOhko(attacker: Pokemon, defender: Pokemon): boolean {
  return ignorable(attacker, defender, 'sturdy');
}

/**
 * A one-hit KO move's hit rate (`BtlCmd_TryOHKOMove`, battle_script.c:4334-4384): Sturdy stops it, it fails against a
 * higher level, Lock-On or No Guard make it hit (none of these draws anything that matters), and otherwise it hits iff
 * `r % 100 < accuracy + attacker's level − defender's level`.
 */
function ohkoHitRate(attacker: Pokemon, defender: Pokemon, move: ActiveMove, battle: Battle): number | true {
  if (sturdyStopsOhko(attacker, defender)) return true; // :4340-4341
  if (attacker.level < defender.level) return true; // :4350, :4382-4383
  if (lockedOnto(attacker, defender) || noGuard(attacker, defender)) return true; // :4343-4345, :4356-4362
  const accuracy = dataAccuracy(move, battle);
  return (accuracy === true ? 0 : accuracy) + attacker.level - defender.level; // :4348-4350
}

/**
 * The cartridge's hit rate for `attacker`'s `move` on `defender` in `battle`: the move hits iff `r % 100 < rate` for
 * the battle's 16-bit draw r, so a rate of 100 or more always hits. `true` means no draw decides it: the move has no
 * accuracy, an override makes it hit (Lock-On, No Guard, Thunder's and Hurricane's rain, Blizzard's hail), or
 * something other than accuracy stops it (Protect, Sturdy, an OHKO move against a higher level).
 */
export function cartridgeHitRate(attacker: Pokemon, defender: Pokemon, move: ActiveMove, battle: Battle): number | true {
  if (move.ohko) return ohkoHitRate(attacker, defender, move, battle);
  const accuracy = dataAccuracy(move, battle);
  if (accuracy === true || overridden(attacker, defender, move, battle)) return true;
  return formulaHitRate(attacker, defender, move, battle, accuracy);
}
