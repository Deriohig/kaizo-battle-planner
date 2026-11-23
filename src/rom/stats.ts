// The Gen 4 stat formulas, computed in integers as the game computes them.

import type { Stats } from './types.js';

/** The stats natures raise and lower, in nature order: nature = 5 × raised + lowered. A nature that names one stat twice is neutral. */
const NATURE_STATS = ['atk', 'def', 'spe', 'spa', 'spd'] as const;

/** floor((2 × base + IV + floor(EV / 4)) × level / 100), the part every stat shares. */
function scaled(base: number, iv: number, ev: number, level: number): number {
  return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100);
}

/**
 * Max HP: the shared part + level + 10. A base HP of 1 always gives 1 HP, as @smogon/calc rules: that is Shedinja, the
 * only species with base HP 1 in the ROM (checked 2026-11-08), whose HP the game fixes at 1.
 */
export function calcHp(base: number, iv: number, ev: number, level: number): number {
  return base === 1 ? 1 : scaled(base, iv, ev, level) + level + 10;
}

/**
 * Any stat but HP: (the shared part + 5) × `natureMultiplier` (1.1, 1 or 0.9), rounded down. The game multiplies by
 * 110 or 90 and divides by 100 in integers, and so does this.
 */
export function calcStat(base: number, iv: number, ev: number, level: number, natureMultiplier: number): number {
  return Math.floor(((scaled(base, iv, ev, level) + 5) * Math.round(natureMultiplier * 100)) / 100);
}

/** The multiplier `nature` (0–24, `pid % 25`) gives each stat: 1.1 for the stat it raises, 0.9 for the one it lowers, else 1. */
export function natureMultipliers(nature: number): Stats {
  if (!Number.isInteger(nature) || nature < 0 || nature >= 25) throw new RangeError(`No nature ${nature}`);
  const multipliers: Stats = { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
  const raised = NATURE_STATS[Math.floor(nature / 5)]!;
  const lowered = NATURE_STATS[nature % 5]!;
  if (raised !== lowered) {
    multipliers[raised] = 1.1;
    multipliers[lowered] = 0.9;
  }
  return multipliers;
}

/** A Pokémon's six stats from its base stats, IVs, EVs, level and nature (0–24). */
export function computeStats(baseStats: Stats, ivs: Stats, evs: Stats, level: number, nature: number): Stats {
  const n = natureMultipliers(nature);
  const stat = (key: Exclude<keyof Stats, 'hp'>) => calcStat(baseStats[key], ivs[key], evs[key], level, n[key]);
  return { hp: calcHp(baseStats.hp, ivs.hp, evs.hp, level), atk: stat('atk'), def: stat('def'), spa: stat('spa'), spd: stat('spd'), spe: stat('spe') };
}
