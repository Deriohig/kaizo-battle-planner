// Showdown IDs for the hack's species, abilities and items, and Showdown names for its moves. Species, abilities and
// items keep their Gen 4 Showdown IDs. A move is named by the docs, and two docs names can share an ID.

import PS from 'pokemon-showdown';
import type { KaizoMove } from '../battle/moves.js';
import { buildNameIndex } from '../names/nameIndex.js';
import { FORMS } from '../rom/forms.js';

const { Dex, toID } = PS;

/** The last species; Personal rows past it are the eggs and the alternate forms. */
export const LAST_SPECIES = 493;

/** Showdown's Gen 4 base species names, by National Dex number. */
const SPECIES_NAMES = new Map(Dex.mod('gen4').species.all()
  .filter((species) => !species.forme && species.num >= 1 && species.num <= LAST_SPECIES)
  .map((species) => [species.num, species.name]));

/** Item and ability names by ROM ID. The name index takes them from @pkmn/dex, not from the docs, so it needs none. */
const NAMES = buildNameIndex({ species: [], moves: [] });

/**
 * The Showdown ID of `species` in `form`: the species' own for form 0, otherwise the species' name and the form's
 * name from `FORMS` ("rotomheat", "unownb"). Throws for a species past 493 or a form `FORMS` doesn't list.
 */
export function speciesId(species: number, form: number): string {
  const name = SPECIES_NAMES.get(species);
  const formName = form === 0 ? '' : FORMS[species]?.[form]?.name;
  if (name === undefined || formName === undefined) throw new Error(`No Showdown species for species ${species} form ${form}`);
  return toID(formName ? `${name}-${formName}` : name);
}

/**
 * The Showdown ID of ROM ability `ability`, or '' for 0 (no ability). An ability the name index lacks gets an ID that
 * no Showdown ability has.
 */
export function abilityId(ability: number): string {
  return ability === 0 ? '' : toID(NAMES.ability(ability));
}

/**
 * The hack's items that act in battle but that @pkmn/dex has no battle item for (the name index keeps battle items only):
 * the Lava Cookie and Old Gateau (items 42 and 54), which the hack gives Lum Berry's hold effect, and item 70, Shoal Salt,
 * and item 71, which the docs' Items tab calls RageCandyBar and the decompilation Shoal Shell. The mod models them
 * (mod/items.ts) under these names.
 */
const HACK_ITEM_NAMES: ReadonlyMap<number, string> = new Map([[42, 'Lava Cookie'], [54, 'Old Gateau'], [70, 'Shoal Salt'], [71, 'Shoal Shell']]);

/**
 * The Showdown ID of ROM item `item`, or '' for 0 (no item). The name index keeps battle items only, so an item such
 * as Potion gets an ID that no Showdown item has, except the hack's held items (`HACK_ITEM_NAMES`).
 */
export function itemId(item: number): string {
  if (item === 0) return '';
  const hack = HACK_ITEM_NAMES.get(item);
  return toID(hack ?? NAMES.item(item));
}

/**
 * The Showdown name of each move, by move ID: its docs name, with " (<move ID>)" added when `toID` can't tell it
 * from a lower-numbered move's name ("Solar-Beam (130)" after "SolarBeam", 76). A move's Showdown ID is `toID` of
 * this name.
 */
export function showdownMoveNames(moves: Map<number, KaizoMove>): Map<number, string> {
  const names = new Map<number, string>();
  const taken = new Set<string>();
  for (const move of [...moves.values()].sort((a, b) => a.id - b.id)) {
    const name = taken.has(toID(move.name)) ? `${move.name} (${move.id})` : move.name;
    const id = toID(name);
    if (id === '' || taken.has(id)) throw new Error(`Move ${move.id} (${move.name}) has no Showdown ID of its own`);
    taken.add(id);
    names.set(move.id, name);
  }
  return names;
}
