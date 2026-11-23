// Names for ROM IDs, and IDs for docs names. Species and move names come from the docs, because the hack renames
// moves; item and ability names come from @pkmn/dex's Gen 4 data, whose `num` is the ROM's ID.

import { Dex } from '@pkmn/dex';
import type { DocMove, DocSpecies } from '../docs/types.js';
import { FORMS } from '../rom/forms.js';
import { normaliseName } from './normalise.js';

/** A species and form, as trainer and save Pokémon store them. */
export interface SpeciesForm { id: number; form: number }

export interface NameIndex {
  /**
   * The docs name of Personal row `id`, in mixed case ("Monferno", "Mr. Mime"), with the form's name appended for a
   * form above 0 that has one ("Burmy-Sandy"; Mothim's and Arceus's forms are named as the species). Throws for an ID
   * the docs lack or a form not in `FORMS`.
   */
  species(id: number, form?: number): string;
  /**
   * The species and form a docs name means: a Personal name ("MONFERNO", or "Rotom (Heat)" for a row past 493), a team
   * tab spelling ("MrMime", "Burmy-Sandy"), or null for an unknown name. See `nameLookup` for how spellings match.
   */
  speciesId(name: string): SpeciesForm | null;
  /** The Moves tab name of move `id`. Throws for an ID the docs lack. */
  move(id: number): string;
  /** The move a docs name means, or null. See `nameLookup` for how spellings match. */
  moveId(name: string): number | null;
  /** The @pkmn/dex name of Gen 4 item `id`, or "(item <id>)" for one it lacks: it keeps battle items only, not Full Restore. */
  item(id: number): string;
  /** The @pkmn/dex name of Gen 4 ability `id`, or "(ability <id>)" for one it lacks. */
  ability(id: number): string;
  /** The Gen 4 ability a name means ("Compound Eyes", "CompoundEyes"), or null. See `nameLookup` for how spellings match. */
  abilityId(name: string): number | null;
}

/** Personal rows past the last species are the eggs, then alternate forms named "Deoxys (A)" or "Rotom (Heat)". */
const LAST_SPECIES = 493;
const FORM_ROW = /^(.+?) \((.+)\)$/;

/**
 * Gen 4's entries by `num`. Later gens' entries and those Gen 4 marks as past are left out, as their nums are reused
 * (Gen 2's Pink Bow is 251, like Silk Scarf); entries marked otherwise, such as the "Unobtainable" Cherish Ball, stay.
 */
function gen4Names(entries: readonly { num: number; name: string; gen: number; isNonstandard: string | null }[]): Map<number, string> {
  return new Map(entries.filter((entry) => entry.gen <= 4 && entry.isNonstandard !== 'Past').map((entry) => [entry.num, entry.name]));
}

const GEN4 = Dex.forGen(4);
const ITEM_NAMES = gen4Names(GEN4.items.all());
const ABILITY_NAMES = gen4Names(GEN4.abilities.all());
const findAbility = nameLookup([...ABILITY_NAMES].map(([id, name]): [string, number] => [name, id]), (id) => id);

/** "MR. MIME" → "Mr. Mime", "HO-OH" → "Ho-Oh"; a name already in mixed case ("Rotom (Heat)") is kept. */
function mixedCase(name: string): string {
  if (name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, start: string, letter: string) => start + letter.toUpperCase());
}

/**
 * Looks a name up by its exact spelling first, then by its normalised spelling (`normaliseName`). A spelling that
 * stands for two different values is ambiguous and finds nothing, so "SolarBeam" (76) and "Solar-Beam" (130) each find
 * their own move but "Solar Beam" finds neither. `key` says when two values are the same.
 */
function nameLookup<T>(entries: [string, T][], key: (value: T) => string | number): (name: string) => T | null {
  const exact = new Map<string, T | null>();
  const normalised = new Map<string, T | null>();
  const add = (map: Map<string, T | null>, name: string, value: T) => {
    const seen = map.get(name);
    map.set(name, seen === undefined || (seen !== null && key(seen) === key(value)) ? value : null);
  };
  for (const [name, value] of entries) {
    add(exact, name, value);
    add(normalised, normaliseName(name), value);
  }
  return (name) => exact.get(name) ?? normalised.get(normaliseName(name)) ?? null;
}

/**
 * The species names a docs reader can meet, with what each means: every Personal name, each species' form names in
 * the team tabs' style ("Burmy-Sandy", plus "Burmy-Plant" for the base form), and each Personal form row past 493
 * ("Wormadam (S)"), placed on the form of its species whose name starts with its abbreviation. A form row that fits no
 * single form throws, so `FORMS` cannot drift from the docs' own form numbering.
 */
function speciesEntries(species: DocSpecies[]): [string, SpeciesForm][] {
  const entries: [string, SpeciesForm][] = [];
  const baseId = new Map<string, number>();
  for (const { id, name } of species.filter((row) => row.id <= LAST_SPECIES)) {
    baseId.set(normaliseName(name), id);
    entries.push([name, { id, form: 0 }]);
    (FORMS[id] ?? []).forEach((form, i) => {
      if (form.name) entries.push([`${name}-${form.name}`, { id, form: i }]);
    });
  }
  for (const { id, name } of species.filter((row) => row.id > LAST_SPECIES)) {
    const match = name.match(FORM_ROW);
    if (!match) {
      entries.push([name, { id, form: 0 }]);
      continue;
    }
    const base = baseId.get(normaliseName(match[1]!));
    const abbreviation = normaliseName(match[2]!);
    const forms = (base === undefined ? [] : FORMS[base] ?? [])
      .flatMap((form, i) => (i > 0 && normaliseName(form.name).startsWith(abbreviation) ? [i] : []));
    if (base === undefined || forms.length !== 1) throw new Error(`The Personal tab's "${name}" (ID ${id}) names no known form`);
    entries.push([name, { id: base, form: forms[0]! }]);
  }
  return entries;
}

/** Builds the name index from the docs' Personal and Moves tabs, plus @pkmn/dex for items and abilities. */
export function buildNameIndex(docs: { species: DocSpecies[]; moves: DocMove[] }): NameIndex {
  const speciesNames = new Map(docs.species.map((row) => [row.id, mixedCase(row.name)]));
  const moveNames = new Map(docs.moves.map((row) => [row.id, row.name]));
  const findSpecies = nameLookup(speciesEntries(docs.species), (value) => `${value.id}:${value.form}`);
  const findMove = nameLookup(docs.moves.map((row): [string, number] => [row.name, row.id]), (id) => id);

  return {
    species(id, form = 0) {
      const name = speciesNames.get(id);
      const formName = form === 0 ? '' : FORMS[id]?.[form]?.name;
      if (name === undefined || formName === undefined) throw new Error(`The docs have no species ${id} form ${form}`);
      return formName ? `${name}-${formName}` : name;
    },
    speciesId(name) {
      const found = findSpecies(name);
      return found && { ...found };
    },
    move(id) {
      const name = moveNames.get(id);
      if (name === undefined) throw new Error(`The docs have no move ${id}`);
      return name;
    },
    moveId: findMove,
    item: (id) => ITEM_NAMES.get(id) ?? `(item ${id})`,
    ability: (id) => ABILITY_NAMES.get(id) ?? `(ability ${id})`,
    abilityId: findAbility,
  };
}
