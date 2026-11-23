// Effective Speed and turn order at equal priority, by the cartridge's speed comparison: pret/pokeplatinum at 62bdaacdc,
// src/battle/battle_lib.c:1188-1454 (`BattleSystem_CompareBattlerSpeed`).

import { abilityName, heldEffect, itemEffect, sideStatus } from '../calc/battler.js';
import type { CalcSide } from '../calc/calc.js';
import type { CalcField } from '../calc/field.js';
import { computeStats } from '../rom/stats.js';

/** Ditto, whose Quick Powder doubles its Speed. */
const DITTO = 132;

/** `sStatStageBoosts` (battle_lib.c:6550-6564): the stat multiplier for stages −6 to +6. */
function stageFraction(stage: number): [number, number] {
  return stage >= 0 ? [10 + 5 * stage, 10] : [10, 10 - 5 * stage];
}

/**
 * The side's Speed as the cartridge compares it (battle_lib.c:1218-1302), in its integers:
 * - the Speed stat (from the base stats, IVs, EVs, level and nature; a null nature is neutral, as in the calc) times its
 *   stage fraction, with Simple doubling the stage within −6..+6;
 * - ×2 for Swift Swim in rain or Chlorophyll in sun. `field.weather` is the weather in effect: leave it out when Cloud
 *   Nine or Air Lock is out (the sheet does);
 * - ÷2 for Macho Brace, Iron Ball or a Power item, even under Klutz;
 * - ×15/10 for Choice Scarf; ×2 for a Ditto with Quick Powder;
 * - ×15/10 for Quick Feet with any status, otherwise ÷4 when paralysed;
 * - ÷2 for Slow Start while it is on (`abilityOn`).
 *
 * Unburden is ignored (the sheet starts with items held), and so is Tailwind, which `CalcField` does not hold.
 */
export function effectiveSpeed(side: CalcSide, field: CalcField): number {
  const { mon } = side;
  const ability = abilityName(mon);
  let stage = side.boosts?.spe ?? 0;
  if (ability === 'Simple') stage = Math.min(6, Math.max(-6, stage * 2));
  const [num, den] = stageFraction(stage);
  let speed = Math.floor((computeStats(mon.baseStats, mon.ivs, mon.evs, mon.level, mon.nature.value ?? 0).spe * num) / den);

  if ((ability === 'Swift Swim' && field.weather === 'rain') || (ability === 'Chlorophyll' && field.weather === 'sun')) speed *= 2;
  if (itemEffect(mon.item)?.effect === 'SPEED_HALVING') speed = Math.floor(speed / 2);
  const held = heldEffect(mon);
  if (held?.effect === 'CHOICE_SPEED') speed = Math.floor((speed * 15) / 10);
  if (held?.effect === 'DITTO_SPEED_UP' && mon.species === DITTO) speed *= 2;
  const status = sideStatus(side);
  if (ability === 'Quick Feet' && status.kind !== 'none') speed = Math.floor((speed * 15) / 10);
  else if (status.kind === 'paralysis') speed = Math.floor(speed / 4);
  if (ability === 'Slow Start' && side.abilityOn) speed = Math.floor(speed / 2);
  return speed;
}

/** Whether the side moves last within its priority bracket: Lagging Tail or Full Incense. */
export const laggingTail = (side: CalcSide): boolean => heldEffect(side.mon)?.effect === 'PRIORITY_DOWN';

/** Whether the side moves last within its priority bracket by Stall. */
export const stall = (side: CalcSide): boolean => abilityName(side.mon) === 'Stall';

/**
 * Which side moves first when both use moves of the same priority, by the cartridge's order of checks
 * (battle_lib.c:1400-1448), with no Quick Claw or Custap Berry activation: a side with Lagging Tail or Full Incense
 * moves last (both: the slower first), then a side with Stall (both: the slower first), then under Trick Room the
 * slower side, otherwise the faster. Equal Speeds in the deciding step are a 50/50 tie.
 */
export function speedOrder(a: CalcSide, b: CalcSide, field: CalcField): 'a' | 'b' | 'tie' {
  const [speedA, speedB] = [effectiveSpeed(a, field), effectiveSpeed(b, field)];
  const slowerFirst = (): 'a' | 'b' | 'tie' => (speedA === speedB ? 'tie' : speedA < speedB ? 'a' : 'b');
  const fasterFirst = (): 'a' | 'b' | 'tie' => (speedA === speedB ? 'tie' : speedA > speedB ? 'a' : 'b');
  const lastBy = (has: (side: CalcSide) => boolean): 'a' | 'b' | 'tie' | null => {
    const [hasA, hasB] = [has(a), has(b)];
    if (hasA && hasB) return slowerFirst();
    if (hasA) return 'b';
    if (hasB) return 'a';
    return null;
  };
  return lastBy(laggingTail) ?? lastBy(stall) ?? (field.trickRoom ? slowerFirst() : fasterFirst());
}
