// Effective accuracy: the chance a move hits, by the cartridge's own formula, from pret/pokeplatinum at
// 62bdaacdc (the clone at ~/src/pokeplatinum).

import type { KaizoMove } from '../battle/moves.js';
import { abilityName, heldEffect, weatherSuppressed } from './battler.js';
import type { CalcSide } from './calc.js';
import type { CalcField } from './field.js';

/**
 * `HitRateByStage` (include/data/hit_rate_stages.h:4-18): the accuracy multiplier for stage sums 0 to 12, where 6 is
 * neutral. These are the Gen 3/4 cartridge's fractions, not Showdown's thirds: 33/100 at −6, not 1/3, and 133/100 at
 * +1, not 4/3.
 */
export const HIT_RATE_BY_STAGE: readonly (readonly [number, number])[] = [
  [33, 100], [36, 100], [43, 100], [50, 100], [60, 100], [75, 100], [1, 1],
  [133, 100], [166, 100], [2, 1], [233, 100], [133, 50], [3, 1],
];

/**
 * ROM move effects the cartridge checks by number (generated/move_battle_effects.txt, a metang enum from 0): line 39
 * `BATTLE_EFFECT_ONE_HIT_KO`, line 153 `BATTLE_EFFECT_THUNDER`, line 261 `BATTLE_EFFECT_BLIZZARD`. The hack's Thunder
 * has 152, and its Blizzard, Ice Ball and Sheer Cold 260.
 */
const EFFECT_ONE_HIT_KO = 38;
const EFFECT_THUNDER = 152;
const EFFECT_BLIZZARD = 260;

/**
 * The hack's Hurricane effect: line 142, `BATTLE_EFFECT_UNUSED_141` in vanilla, which only Hurricane (move 140) has in
 * the hack's ROM. The ROM diff of overlay 16 found that the hack's battle code gives it exactly
 * Thunder's weather checks, in rain and in sun, so it is matched by its effect as the cartridge matches Thunder's.
 */
const EFFECT_HURRICANE = 141;

/** The effects under Thunder's weather rule: always hits in rain, accuracy 50 in sun. */
const THUNDER_RULE: ReadonlySet<number> = new Set([EFFECT_THUNDER, EFFECT_HURRICANE]);

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** `hitRate * num / den` in the cartridge's integers: the product, then a truncating division. */
const scale = (hitRate: number, num: number, den: number) => Math.floor((hitRate * num) / den);

/** Whether `move` is an OHKO move: the ROM's OHKO effect, or the docs' "OHKO" text. */
export const isOhko = (move: KaizoMove) => move.romEffect === EFFECT_ONE_HIT_KO || /^ohko$/i.test(move.effectText.trim());

/**
 * An OHKO move's chance (`BtlCmd_TryOHKOMove`, src/battle/battle_script.c:4334-4383). It skips the usual formula, so
 * stages, items, fog and Gravity don't count. Sturdy blocks it; it always fails against a higher level; No Guard on
 * either side makes it hit; otherwise it hits when `rand % 100 < accuracy + (attacker level − defender level)`.
 */
function ohkoChance(attacker: CalcSide, defender: CalcSide, move: KaizoMove): number {
  const moldBreaker = abilityName(attacker.mon) === 'Mold Breaker';
  if (!moldBreaker && abilityName(defender.mon) === 'Sturdy') return 0;
  const levels = attacker.mon.level - defender.mon.level;
  if (levels < 0) return 0;
  if ([abilityName(attacker.mon), abilityName(defender.mon)].includes('No Guard')) return 1;
  return Math.min(move.accuracy + levels, 100) / 100;
}

/**
 * The chance, 0 to 1, that `attacker`'s `move` hits `defender` on `field`, by the cartridge's formula
 * (`BattleControllerPlayer_CheckMoveHitAccuracy` then `_CheckMoveHitOverrides`, src/battle/battle_controller_player.c:
 * 2865-2977 and 3001-3032). The hit rate is an integer, truncated after every step:
 * 1. Accuracy 0 always hits (2900-2903). An OHKO move has its own check (`ohkoChance`).
 * 2. No Guard on either side always hits (3016-3022). In rain a Thunder-effect move always hits, and in hail a
 *    Blizzard-effect one (3024-3032). The hack's Hurricane has Thunder's rule (`EFFECT_HURRICANE`). The cartridge
 *    keys these on the ROM effect, not on the docs text.
 * 3. The stage sum: 6 + accuracy stages − evasion stages, clamped to 0..12 (2873-2898). Simple doubles a side's
 *    stages and Unaware zeroes the other side's; the defender's Simple and Unaware are ignored against Mold Breaker.
 *    A defender identified by Foresight (`CalcSide.foresight`) has its raised evasion ignored (2888-2890).
 * 4. In sun a Thunder-rule move's accuracy becomes 50 (2915-2917), then it is scaled by `HIT_RATE_BY_STAGE`
 *    (2919-2920).
 * 5. Then, in order: Compound Eyes ×130/100; Sand Veil in sand and Snow Cloak in hail ×80/100 (ignored against Mold
 *    Breaker), and fog ×6/10; Hustle ×80/100 on physical moves; Tangled Feet against a confused target ×50/100;
 *    the defender's BrightPowder or Lax Incense ×(100 − 11)/100; the attacker's Wide Lens ×110/100, or Zoom Lens
 *    ×120/100 when `opts.defenderMoved` (the target already moved this turn); Gravity ×10/6 (2922-2974).
 * 6. The move hits when `rand % 100 + 1 <= hitRate` (2976), taken here as `min(hitRate, 100) / 100`.
 *
 * Cloud Nine or Air Lock on either side cancels every weather rule and fog (`NO_CLOUD_NINE`). Not modelled: a
 * Micle Berry already eaten, Lock-On and Mind Reader, Miracle Eye's evasion reset, Protect, and semi-invulnerable
 * targets; the cartridge's `rand % 100` over 16-bit randoms makes the true odds of rate r a hair above r/100 (for 50,
 * 32,786/65,536), which the battle engine counts exactly.
 */
export function hitChance(attacker: CalcSide, defender: CalcSide, move: KaizoMove, field: CalcField, opts: { defenderMoved?: boolean } = {}): number {
  if (move.accuracy === 0) return 1;
  if (isOhko(move)) return ohkoChance(attacker, defender, move);

  const atkAbility = abilityName(attacker.mon);
  const defAbility = abilityName(defender.mon);
  const defHas = (name: string) => atkAbility !== 'Mold Breaker' && defAbility === name;
  const weather = weatherSuppressed(attacker.mon, defender.mon) ? undefined : field.weather;
  const fog = !weatherSuppressed(attacker.mon, defender.mon) && !!field.fog;

  if (atkAbility === 'No Guard' || defAbility === 'No Guard') return 1;
  if (weather === 'rain' && THUNDER_RULE.has(move.romEffect)) return 1;
  if (weather === 'hail' && move.romEffect === EFFECT_BLIZZARD) return 1;

  let accStages = attacker.boosts?.accuracy ?? 0;
  let evaStages = -(defender.boosts?.evasion ?? 0);
  if (atkAbility === 'Simple') accStages *= 2;
  if (defHas('Simple')) evaStages *= 2;
  if (defHas('Unaware')) accStages = 0;
  if (atkAbility === 'Unaware') evaStages = 0;
  if (defender.foresight && evaStages < 0) evaStages = 0;
  const [num, den] = HIT_RATE_BY_STAGE[clamp(6 + evaStages + accStages, 0, 12)]!;

  let hitRate = weather === 'sun' && THUNDER_RULE.has(move.romEffect) ? 50 : move.accuracy;
  hitRate = scale(hitRate, num, den);
  if (atkAbility === 'Compound Eyes') hitRate = scale(hitRate, 130, 100);
  if (weather === 'sand' && defHas('Sand Veil')) hitRate = scale(hitRate, 80, 100);
  if (weather === 'hail' && defHas('Snow Cloak')) hitRate = scale(hitRate, 80, 100);
  if (fog) hitRate = scale(hitRate, 6, 10);
  if (atkAbility === 'Hustle' && move.category === 'physical') hitRate = scale(hitRate, 80, 100);
  if (defHas('Tangled Feet') && defender.confused) hitRate = scale(hitRate, 50, 100);
  const defItem = heldEffect(defender.mon);
  if (defItem?.effect === 'ACC_REDUCE') hitRate = scale(hitRate, 100 - defItem.param, 100);
  const atkItem = heldEffect(attacker.mon);
  if (atkItem?.effect === 'ACCURACY_UP') hitRate = scale(hitRate, 100 + atkItem.param, 100);
  if (atkItem?.effect === 'ACCURACY_UP_SLOWER' && opts.defenderMoved) hitRate = scale(hitRate, 100 + atkItem.param, 100);
  if (field.gravity) hitRate = scale(hitRate, 10, 6);
  return Math.min(hitRate, 100) / 100;
}
