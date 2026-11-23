// Gen 4 gender from a PID and a species' gender ratio (the Personal record's byte 16).

import type { TrainerMon } from './trainers.js';

/** Ratios with a fixed outcome: always male, always female, genderless. */
const MALE_ONLY = 0;
const FEMALE_ONLY = 254;
const GENDERLESS = 255;

/** The gender of a ratio with a fixed outcome, or undefined for a ratio the PID decides. */
function fixedGender(ratio: number): 'M' | 'F' | null | undefined {
  if (ratio === GENDERLESS) return null;
  if (ratio === FEMALE_ONLY) return 'F';
  if (ratio === MALE_ONLY) return 'M';
  return undefined;
}

/** Gen 4's rule: female when the PID's low byte is below the ratio; ratios 0, 254 and 255 are fixed. */
export function genderFromPid(pid: number, ratio: number): 'M' | 'F' | null {
  const fixed = fixedGender(ratio);
  if (fixed !== undefined) return fixed;
  return (pid & 0xff) < ratio ? 'F' : 'M';
}

/**
 * A trainer Pokémon's gender: the gender override (the low nibble of its entry's byte 1: 1 male, 2 female) where it is
 * set, otherwise `genderFromPid`. A fixed ratio wins over the override, as no PID can give a male-only species a female.
 */
export function trainerMonGender(mon: Pick<TrainerMon, 'pid' | 'genderOverride'>, ratio: number): 'M' | 'F' | null {
  const fixed = fixedGender(ratio);
  if (fixed !== undefined) return fixed;
  if (mon.genderOverride === 1) return 'M';
  if (mon.genderOverride === 2) return 'F';
  return genderFromPid(mon.pid, ratio);
}
