import { describe, expect, it } from 'vitest';
import { buildNameIndex } from '../../../src/names/nameIndex.js';
import { FORMS, personalRowFor } from '../../../src/rom/forms.js';
import { docSpecies as species } from '../../fixtures/loadedData.js';

/** `pl_personal.narc` holds 508 records: species 0–493, the two eggs (494, 495), then rows of their own for forms. */
const PERSONAL_ROWS = 508;
const FIRST_FORM_ROW = 496;

// The Personal tab's names for each species with forms, and for every row past the last species.
const PERSONAL_TAB = [
  species(201, 'UNOWN'), species(351, 'CASTFORM'), species(386, 'DEOXYS'), species(412, 'BURMY'), species(413, 'WORMADAM'),
  species(421, 'CHERRIM'), species(422, 'SHELLOS'), species(423, 'GASTRODON'), species(479, 'ROTOM'), species(487, 'GIRATINA'),
  species(492, 'SHAYMIN'), species(414, 'MOTHIM'), species(493, 'ARCEUS'),
  species(494, 'Egg'), species(495, 'Bad Egg'), species(496, 'Deoxys (A)'), species(497, 'Deoxys (D)'), species(498, 'Deoxys (S)'),
  species(499, 'Wormadam (S)'), species(500, 'Wormadam (T)'), species(501, 'Giratina (O)'), species(502, 'Shaymin (S)'),
  species(503, 'Rotom (Heat)'), species(504, 'Rotom (Wash)'), species(505, 'Rotom (Frost)'), species(506, 'Rotom (Fan)'),
  species(507, 'Rotom (Mow)'),
];
const names = buildNameIndex({ species: PERSONAL_TAB, moves: [] });

/** Every FORMS entry as [species, form, entry]. */
const entries = Object.entries(FORMS).flatMap(([id, forms]) => forms.map((entry, form) => [Number(id), form, entry] as const));

describe('FORMS', () => {
  it("gives every form its species' own Personal row or one past the eggs, each of those used by exactly one non-base form", () => {
    for (const [id, form, { personalRow }] of entries) {
      expect([id, form, Number.isInteger(personalRow) && (personalRow === id || (personalRow >= FIRST_FORM_ROW && personalRow < PERSONAL_ROWS))]).toEqual([id, form, true]);
    }
    const formRows = entries.filter(([id, , { personalRow }]) => personalRow !== id);
    expect(formRows.map(([, , { personalRow }]) => personalRow).sort((a, b) => a - b))
      .toEqual(Array.from({ length: PERSONAL_ROWS - FIRST_FORM_ROW }, (_, i) => FIRST_FORM_ROW + i));
    expect(formRows.filter(([, form]) => form === 0)).toEqual([]);
  });

  it("round-trips each named form's name through the name index, and names each row past the eggs as the form whose row it is", () => {
    for (const [id, form] of entries.filter(([, form, entry]) => form === 0 || entry.name !== '')) {
      expect(names.speciesId(names.species(id, form))).toEqual({ id, form });
    }
    for (const { id, name } of PERSONAL_TAB.filter((row) => row.id >= FIRST_FORM_ROW)) {
      const form = names.speciesId(name)!;
      expect([name, personalRowFor(form.id, form.form)]).toEqual([name, id]);
    }
  });

  // A form that changes only looks, or only in battle, has the species' own row and name unless the docs spell one out.
  it.each([
    [414, 1, 414, 'Mothim'], [414, 2, 414, 'Mothim'], [493, 10, 493, 'Arceus'], [201, 5, 201, 'Unown-F'], [422, 1, 422, 'Shellos-East'],
    [412, 1, 412, 'Burmy-Sandy'], [386, 3, 498, 'Deoxys-Speed'], [413, 1, 499, 'Wormadam-Sandy'], [487, 1, 501, 'Giratina-Origin'],
    [492, 1, 502, 'Shaymin-Sky'], [479, 5, 507, 'Rotom-Mow'], [479, 0, 479, 'Rotom'],
  ])('gives species %i form %i Personal row %i and the name %s', (id, form, row, name) => {
    expect(personalRowFor(id, form)).toBe(row);
    expect(names.species(id, form)).toBe(name);
  });

  it("gives every cosmetic or battle-only form, and a species without forms, the species' own row", () => {
    const cosmetic: [number, number][] = [[414, 2], [201, 27], [422, 1], [423, 1], [421, 1], [351, 3], [493, 17], [391, 2]];
    for (const [id, last] of cosmetic) {
      for (let form = 0; form <= last; form++) expect([id, form, personalRowFor(id, form)]).toEqual([id, form, id]);
    }
  });

  it.each([[386, 9], [386, 4], [413, 3], [487, 2], [492, 2], [479, 6]])(
    'throws for species %i form %i, an unknown form of a species whose forms change its stats', (id, form) =>
      expect(() => personalRowFor(id, form)).toThrow(`Species ${id} has no form ${form}`));
});
