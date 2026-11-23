// Records parsed from the official docs' tabs. Names, types and text are the docs' own strings.

import type { MoveCategory, Stats } from '../rom/types.js';

/** One row of the Moves tab. A number cell that is not a number is NaN. */
export interface DocMove { id: number; name: string; effectText: string; category: MoveCategory; power: number; type: string; accuracy: number; pp: number; effectChance: number; targets: string; priority: number; contact: boolean }

/**
 * One row of the Personal tab. Names are as the docs write them ("MONFERNO", or "Rotom (Heat)" for forms past 493),
 * a single-type species repeats its type, and a missing ability is "-". A changed stat, written `92 (+10)` in the
 * docs, is the new value (92); a stat cell that is not a number is NaN.
 */
export interface DocSpecies { id: number; name: string; baseStats: Stats; types: [string, string]; growthRate: string; abilities: [string, string] }
