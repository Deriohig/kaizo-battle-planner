// Battle-ready trainers: each trainer Pokémon with the nature, ability and gender the planner uses, and the catalog of
// every docs trainer that matched the ROM.

import type { LocalData } from '../data/load.js';
import type { FieldNote, TrainerTags } from '../docs/teams.js';
import type { AiFlagName } from '../rom/trainers.js';
import type { Stats } from '../rom/types.js';

/** What `loadLocalData` returns: the decoded ROM, the parsed docs, the name index, and PKCalc's data where it was saved. */
export type LoadedData = LocalData;

/**
 * A value, where it came from, and what else it may be.
 * - `disputed` marks a value an in-game spot check should settle: the ROM and the docs both give one and they differ,
 *   no source gives one at all, or it is a nature the docs alone give, unchecked until spot check 1.
 * - `alternatives` holds the other candidate values, never `value` itself, so that a proof can cover
 *   every candidate world: the docs' value against a disputed ROM one, all 25 natures where no source gives one
 *   (`value` null), and PKCalc's nature against a docs one where it differs. It is empty for a value that is not
 *   disputed, and for a docs nature no other source contradicts.
 */
export interface Sourced<T> { value: T; source: 'rom' | 'docs'; disputed: boolean; alternatives: T[] }

/**
 * PKCalc's nature ID for the Pokémon in party slot `slot` (from 0) of ROM trainer `romIndex`, or null where PKCalc
 * gives none: what `pkcalcNatures` reads from PKCalc's saved sets.
 */
export type PkcalcNatures = (romIndex: number, slot: number) => number | null;

/**
 * What every Pokémon in a battle has, the trainer's (`ResolvedMon`) and the player's (`PlayerMon`) alike. The base
 * stats and types come from the ROM, from the form's Personal row. `name` is the docs' species name with the form's
 * name appended ("Rotom-Wash"). `nature.value` null means no source gives one: the calc then uses a neutral nature.
 * Types and the ability are ROM IDs.
 */
export interface BattleMon {
  species: number; form: number; name: string; level: number; gender: 'M' | 'F' | null; ivs: Stats; evs: Stats;
  nature: Sourced<number | null>; ability: Sourced<number>; item: number; moves: number[]; baseStats: Stats; types: [number, number];
  /** 0–255, what Return and Frustration read in the AI's damage estimate. A trainer's Pokémon has its species' base friendship (as `Pokemon_InitWith` sets it); a player's is the save's. */
  friendship: number;
}

/** One trainer Pokémon as the planner uses it. Level, item, moves and ability come from the ROM. IVs are the ROM's for all six stats, EVs are 0. */
export interface ResolvedMon extends BattleMon {}

/**
 * One docs trainer, resolved against one of its ROM copies.
 * - `id` is the docs trainer's slug, "roark-split/youngster-tristan/1": split, name, and its place (from 1) among the
 *   split's trainers of the same name. Every copy of the trainer shares it; `romIndex` tells copies apart.
 * - `order` is the trainer's 0-based place in its split tab (`DocTrainer.order`).
 * - `battleType`, `trainerClass` and `aiFlags` come from the ROM; `name`, `split`, `location`, `field` and `tags` from
 *   the docs.
 * - `variants` holds the docs trainer's other ROM copies, in ROM index order, each with no variants of its
 *   own; it is empty when the trainer has one copy.
 */
export interface ResolvedTrainer {
  id: string; name: string; split: string; location: string; order: number; romIndex: number; trainerClass: number;
  battleType: 'single' | 'double'; aiFlags: AiFlagName[]; field: FieldNote | null; tags: TrainerTags; levelMismatch: boolean;
  party: ResolvedMon[]; variants: ResolvedTrainer[];
}

/** A preset gauntlet: its trainers' IDs in docs order. */
export interface CatalogGauntlet { id: string; name: string; trainerIds: string[] }

/**
 * Every docs trainer that matched the ROM.
 * - `trainers` holds the opponents in docs order; player partners (`tags.playerPartner`) are left out, but `byId`
 *   finds them too. A docs trainer with no ROM match is in neither.
 * - `search` finds the opponents whose name, split or location hold every word of `text` (compared as
 *   `normaliseName` does), in docs order; an exact ID finds its trainer.
 */
export interface TrainerCatalog {
  trainers: ResolvedTrainer[];
  gauntlets: CatalogGauntlet[];
  byId(id: string): ResolvedTrainer | undefined;
  search(text: string): ResolvedTrainer[];
}
