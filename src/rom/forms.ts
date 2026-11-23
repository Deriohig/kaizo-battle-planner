// Alternate forms: each form's name, and the Personal row (index into `RomData.species`) holding its base stats, types
// and abilities.

/**
 * One form of a species. `name` is '' for a form with no name of its own, which is named as the species: Castform's
 * and Rotom's base forms, and every form of Mothim and Arceus.
 */
export interface FormEntry { readonly name: string; readonly personalRow: number }

/**
 * The forms of `species`, named in form order. Form 0 uses the species' own row. With `firstRow`, every other form has
 * a row of its own, form 1 at `firstRow` and the rest after it; without it, every form uses the species' row.
 */
function forms(species: number, names: string[], firstRow?: number): FormEntry[] {
  return names.map((name, form) => ({ name, personalRow: form > 0 && firstRow !== undefined ? firstRow + form - 1 : species }));
}

/** Arceus's forms: one per type, in type ID order (Normal 0 to Dark 17, with "???" at 9), set by its held Plate. */
const ARCEUS_TYPES = 18;

/**
 * Gen 4 forms by species ID, indexed by form number (the ROM's form order: the top 6 bits of a trainer Pokémon's
 * species field). Form 0 is the base form, which the docs write as the bare species name.
 * - The other forms of Deoxys, Wormadam, Giratina, Shaymin and Rotom change stats, types or abilities, and have
 *   Personal rows of their own past the two eggs (494 and 495): rows 496–507, as the docs' Personal tab numbers them.
 * - Every other form changes only looks, or changes only in battle, and uses the species' own row:
 *   Unown's letters, Castform's weather and Cherrim's sunshine (battle forms), Burmy's cloaks, Shellos's and
 *   Gastrodon's east sea, Mothim's cloaks (a Mothim keeps its Burmy's cloak in the form byte, as the player's save of 23 May
 *   shows) and Arceus's type forms, set by its held Plate (in battle its type comes from the Plate, by Multitype).
 *   Mothim's and Arceus's forms have no names of their own.
 */
export const FORMS: Readonly<Record<number, readonly FormEntry[]>> = {
  201: forms(201, [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'Exclamation', 'Question']),
  351: forms(351, ['', 'Sunny', 'Rainy', 'Snowy']),
  386: forms(386, ['Normal', 'Attack', 'Defense', 'Speed'], 496),
  412: forms(412, ['Plant', 'Sandy', 'Trash']),
  413: forms(413, ['Plant', 'Sandy', 'Trash'], 499),
  414: forms(414, ['', '', '']),
  421: forms(421, ['Overcast', 'Sunshine']),
  422: forms(422, ['West', 'East']),
  423: forms(423, ['West', 'East']),
  479: forms(479, ['', 'Heat', 'Wash', 'Frost', 'Fan', 'Mow'], 503),
  487: forms(487, ['Altered', 'Origin'], 501),
  492: forms(492, ['Land', 'Sky'], 502),
  493: forms(493, Array.from({ length: ARCEUS_TYPES }, () => '')),
};

/**
 * The Personal row of `species` in `form`: the form's own row where it has one, otherwise the species' own row, which
 * a species without forms has whatever its form byte says. Throws for a form `FORMS` lacks of a species whose forms
 * have rows of their own (Deoxys, Wormadam, Giratina, Shaymin, Rotom), as that form's stats are unknown.
 */
export function personalRowFor(species: number, form: number): number {
  const known = FORMS[species];
  const entry = known?.[form];
  if (entry !== undefined) return entry.personalRow;
  if (known?.some((other) => other.personalRow !== species)) {
    throw new Error(`Species ${species} has no form ${form}: its forms have Personal rows of their own, so this form's stats are unknown`);
  }
  return species;
}
