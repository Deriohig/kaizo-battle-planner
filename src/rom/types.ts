// Records decoded from the ROM's data files.

/** Six stats, always in this order, whatever order the source stores them in. */
export interface Stats { hp: number; atk: number; def: number; spa: number; spd: number; spe: number }

/** One species from `pl_personal.narc`. Types, abilities and growth rate are ROM IDs; `baseFriendship` is byte 0x12 (what a new Pokémon of the species starts with); `baseExp` is the base EXP yield (byte 0x09), `evYield` the EV yield (u16 at 0x0A, 2 bits per stat; 0 for every species in this hack). */
export interface SpeciesRecord { id: number; baseStats: Stats; types: [number, number]; genderRatio: number; baseFriendship: number; baseExp: number; evYield: number; growthRate: number; abilities: [number, number] }

/** One level-up move from `wotbl.narc`. */
export interface LevelUpMove { move: number; level: number }

export type MoveCategory = 'physical' | 'special' | 'status';

/** One move from `pl_waza_tbl.narc`. */
export interface MoveRecord { id: number; effect: number; category: MoveCategory; power: number; type: number; accuracy: number; pp: number; effectChance: number; target: number; priority: number; flags: number }
