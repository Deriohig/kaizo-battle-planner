// Showdown IDs → ROM IDs, without a Battle. The Showdown source (read/showdown.ts) and the native engine's wrapper
// both read through these, so neither needs a Battle here: a move's ROM ID comes through an IdLookup.
//
// The engine's ID encoding (abilityId, itemId, speciesId) comes from engine/index.js. The narrowest module that has it,
// engine/ids.ts, imports pokemon-showdown itself (for toID and the species names), as every other candidate does, so
// loading this file loads Showdown either way.

import { abilityId, itemId, speciesId } from '../../engine/index.js';
import { FORMS } from '../../rom/forms.js';
import { TYPE_NAMES } from '../../rom/tables.js';
import { ABILITY_NONE, ITEM_NONE, MOVE_NONE } from '../constants.js';
import { AiError } from '../errors.js';

/** NUM_ITEMS, constants/items.h:84. */
export const NUM_ITEMS = 467;
/** ABILITY_BAD_DREAMS, the last Gen 4 ability (generated/abilities.txt). */
export const LAST_ABILITY = 123;

// ROM IDs of Showdown IDs. Species and moves carry theirs as `num`; abilities and items are the inverse of the
// engine's own encoding (engine/ids.ts), built once.

/** Where a Showdown move ID's ROM ID comes from: a dex's `num`, or the native engine's own table. */
export interface IdLookup { moveNum(id: string): number | undefined }

/**
 * The ROM ID of Showdown move `id`: its mod entry's `num`. The engine's mod gives every hack move its ROM ID there
 * (showdownMoveData, engine/dex.ts); Showdown's own Gen 4 moves, such as Struggle, keep their number, which is the
 * vanilla ID. '' is MOVE_NONE. A lookup that answers 0, NaN or a negative number is refused as one that has no answer,
 * so no lookup (a native table's included) can pass one through as a move.
 */
export function romMove(lookup: IdLookup, id: string): number {
  if (id === '') return MOVE_NONE;
  const num = lookup.moveNum(id);
  if (num === undefined || !(num > 0)) throw new AiError('BAD_VIEW', `Showdown move "${id}" has no ROM ID`);
  return num;
}

/** An IdLookup over a Showdown dex: `num` when the move exists and has a positive one, else undefined. */
export function dexLookup(dex: { moves: { get(id: string): { exists: boolean; num: number } } }): IdLookup {
  return {
    moveNum(id) {
      const move = dex.moves.get(id);
      return move.exists && move.num > 0 ? move.num : undefined;
    },
  };
}

let reverseIds: { abilities: ReadonlyMap<string, number>; items: ReadonlyMap<string, number> } | null = null;

/** Showdown ability and item IDs → ROM IDs: the inverse of abilityId and itemId over every ROM ID (the lowest wins). */
export function romIds(): { abilities: ReadonlyMap<string, number>; items: ReadonlyMap<string, number> } {
  if (reverseIds === null) {
    const abilities = new Map<string, number>([['noability', ABILITY_NONE]]); // Showdown's "No Ability"
    for (let id = LAST_ABILITY; id >= 1; id--) abilities.set(abilityId(id), id);
    const items = new Map<string, number>();
    for (let id = NUM_ITEMS; id >= 1; id--) items.set(itemId(id), id);
    reverseIds = { abilities, items };
  }
  return reverseIds;
}

/** The ROM ID of Showdown ability `id`; '' is ABILITY_NONE. */
export function romAbility(id: string): number {
  if (id === '') return ABILITY_NONE;
  const ability = romIds().abilities.get(id);
  if (ability === undefined) throw new AiError('BAD_VIEW', `Showdown ability "${id}" has no ROM ID`);
  return ability;
}

/** The ROM ID of Showdown item `id`; '' is ITEM_NONE. */
export function romItem(id: string): number {
  if (id === '') return ITEM_NONE;
  const item = romIds().items.get(id);
  if (item === undefined) throw new AiError('BAD_VIEW', `Showdown item "${id}" has no ROM ID`);
  return item;
}

/** The ROM ID of Showdown type `name` (rom/tables.ts's TYPE_NAMES; "???" is TYPE_MYSTERY). */
export function romType(name: string): number {
  const type = TYPE_NAMES.indexOf(name);
  if (type < 0) throw new AiError('BAD_VIEW', `Showdown type "${name}" has no ROM ID`);
  return type;
}

/** type1 and type2 of Showdown `types`: a single type fills both, as the Personal data does. */
export function romTypes(types: readonly string[]): [number, number] {
  const [first, second] = types;
  if (first === undefined) throw new AiError('BAD_VIEW', 'a Pokémon with no type');
  return [romType(first), romType(second ?? first)];
}

/**
 * The form number of `species` whose Showdown ID is `id` (the inverse of engine/ids.ts's speciesId over `FORMS`), or
 * `fallback`. A species `FORMS` doesn't list has form 0 (Arceus's plates are not Personal forms).
 */
export function formOf(species: number, id: string, fallback: number): number {
  const forms = FORMS[species];
  if (forms === undefined) return 0;
  const form = forms.findIndex((_, f) => speciesId(species, f) === id);
  return form >= 0 ? form : fallback;
}

/** GENDER_MALE 0, GENDER_FEMALE 1, GENDER_NONE 2 (generated/genders.txt) from Showdown's 'M', 'F' or 'N'. */
export function genderOf(gender: string): number {
  if (gender === 'M') return 0;
  return gender === 'F' ? 1 : 2;
}
