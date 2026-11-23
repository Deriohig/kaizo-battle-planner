// Battle-ready Pokémon and hack moves for the sheet, speed and accuracy tests: the Monferno and Zigzagoon of the calc
// tests, and a move builder.

import type { KaizoMove } from '../../src/battle/moves.js';
import type { PlayerMon } from '../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../src/battle/types.js';
import { stats } from './loadedData.js';

// Ability IDs (Gen 4 nums, as the ROM stores them), checked against @pkmn/dex.
export const ABILITY = {
  STURDY: 5, SAND_VEIL: 8, CLOUD_NINE: 13, COMPOUND_EYES: 14, SWIFT_SWIM: 33, CHLOROPHYLL: 34, HUSTLE: 55, BLAZE: 66,
  AIR_LOCK: 76, TANGLED_FEET: 77, SNOW_CLOAK: 81, GLUTTONY: 82, UNBURDEN: 84, SIMPLE: 86, QUICK_FEET: 95, NO_GUARD: 99,
  STALL: 100, KLUTZ: 103, MOLD_BREAKER: 104, UNAWARE: 109,
} as const;

// Item IDs (Gen 4 nums), checked against @pkmn/dex.
export const ITEM = {
  BRIGHT_POWDER: 213, QUICK_CLAW: 217, SILK_SCARF: 251, LAX_INCENSE: 255, WIDE_LENS: 265, ZOOM_LENS: 276, IRON_BALL: 278,
  LAGGING_TAIL: 279, CHOICE_SCARF: 287, FULL_INCENSE: 316,
} as const;

/**
 * The player's Monferno: level 15, Impish (8), IVs 0/26/12/10/7/24, 0 EVs, vanilla base stats
 * 64/78/52/78/52/81, Fire (10) / Fighting (1), Blaze, at full HP. Its stats are 44/32/24/26/21/32.
 */
export function monferno(fields: Partial<PlayerMon> = {}): PlayerMon {
  return {
    species: 391, form: 0, name: 'Monferno', level: 15, gender: 'M', ivs: stats(0, 26, 12, 10, 7, 24), evs: stats(0, 0, 0, 0, 0, 0),
    nature: { value: 8, source: 'rom', disputed: false, alternatives: [] }, ability: { value: ABILITY.BLAZE, source: 'rom', disputed: false, alternatives: [] }, item: 0,
    moves: [52], baseStats: stats(64, 78, 52, 78, 52, 81), types: [10, 1], nickname: 'Fernando', friendship: 70, status: { kind: 'none' },
    currentHp: 44, pp: [25], ppUps: [0], location: { kind: 'party', slot: 1 }, notes: [], ...fields,
  };
}

/** A trainer's Zigzagoon: level 5, Hasty (11), 31 IVs, 0 EVs, Silk Scarf, Gluttony, Normal. Its HP is 20, its Speed 13. */
export function zigzagoon(fields: Partial<ResolvedMon> = {}): ResolvedMon {
  return {
    species: 263, form: 0, name: 'Zigzagoon', level: 5, gender: 'M', ivs: stats(31, 31, 31, 31, 31, 31), evs: stats(0, 0, 0, 0, 0, 0),
    nature: { value: 11, source: 'rom', disputed: false, alternatives: [] }, ability: { value: ABILITY.GLUTTONY, source: 'rom', disputed: false, alternatives: [] },
    item: ITEM.SILK_SCARF, moves: [33], baseStats: stats(38, 30, 41, 30, 41, 60), types: [0, 0], friendship: 70, ...fields,
  };
}

/** A hack move: a single-target physical Normal hit with 100% accuracy and no effect, unless `fields` say otherwise. */
export function move(id: number, fields: Partial<KaizoMove> = {}): KaizoMove {
  return {
    id, name: `move ${id}`, type: 0, category: 'physical', power: 40, accuracy: 100, pp: 10, priority: 0, effectChance: 0,
    target: 0, flags: 0, romEffect: 0, effectText: 'None', calc: { baseMove: 'Tackle' }, unmodelled: null, ...fields,
  };
}

// The ROM's moves (2026-11-08 extract), as `buildMoves` makes them.
export const TACKLE = move(33, { name: 'Tackle', pp: 35, flags: 115, calc: { baseMove: 'Tackle' } });
export const EMBER = move(52, { name: 'Ember', type: 10, category: 'special', power: 40, pp: 25, effectChance: 10, flags: 82, romEffect: 4, effectText: 'Chance of causing Burn', calc: { baseMove: 'Ember' } });
export const QUICK_ATTACK = move(98, { name: 'Quick Attack', priority: 1, pp: 30, flags: 115, romEffect: 103, effectText: 'Priority +1', calc: { baseMove: 'Quick Attack' } });
export const GROWL = move(45, { name: 'Growl', category: 'status', power: 0, target: 4, flags: 86, romEffect: 18, calc: { baseMove: 'Growl' } });
export const SWIFT = move(129, { name: 'Swift', category: 'special', power: 60, accuracy: 0, target: 4, romEffect: 17, effectText: 'Always hits', calc: { baseMove: 'Swift', ignoresAccuracy: true } });
export const THUNDER = move(87, { name: 'Thunder', type: 13, category: 'special', power: 120, accuracy: 70, romEffect: 152, effectText: 'Always hits in rain; chance to Paralyze', calc: { baseMove: 'Thunder' } });
export const BLIZZARD = move(59, { name: 'Blizzard', type: 15, category: 'special', power: 120, accuracy: 70, romEffect: 260, effectText: 'Always hits in Hail', calc: { baseMove: 'Blizzard' } });
export const HURRICANE = move(140, { name: 'Hurricane', type: 2, category: 'special', power: 120, accuracy: 70, romEffect: 141, effectText: 'Always hits in rain; chance to Confuse', calc: { baseMove: 'Swift' } });
export const FISSURE = move(90, { name: 'Fissure', type: 4, power: 1, accuracy: 30, romEffect: 38, effectText: 'OHKO', calc: { baseMove: 'Fissure' }, unmodelled: 'OHKO' });
export const PSYWAVE = move(149, { name: 'Psywave', type: 14, category: 'special', power: 1, romEffect: 88, calc: { baseMove: 'Psywave', fixedDamage: 'psywave' } });
