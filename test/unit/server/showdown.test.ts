import { expect, it } from 'vitest';
import type { BattleMon } from '../../../src/battle/types.js';
import { showdownSet } from '../../../src/server/showdown.js';
import { stats } from '../../fixtures/loadedData.js';
import { serverData } from './fixtures.js';

const { names } = serverData();
type Named = BattleMon & { nickname?: string };

/** Monferno "Mon": male, level 15, Impish (8), IVs 0/26/12/10/7/24, no EVs, Blaze, Quick Claw, Scratch and Ember. */
const monferno = (fields: Partial<Named> = {}): Named => ({
  species: 391, form: 0, name: 'Monferno', nickname: 'Mon', level: 15, gender: 'M', ivs: stats(0, 26, 12, 10, 7, 24), evs: stats(0, 0, 0, 0, 0, 0),
  nature: { value: 8, source: 'rom', disputed: false, alternatives: [] }, ability: { value: 66, source: 'rom', disputed: false, alternatives: [] },
  item: 217, moves: [10, 52], baseStats: stats(64, 78, 52, 78, 52, 81), types: [10, 1], friendship: 70, ...fields,
});
const { nickname: _, ...trainerMon } = monferno({ nature: { value: null, source: 'docs', disputed: true, alternatives: [] }, item: 0, ivs: stats(31, 31, 31, 31, 31, 31) });

it.each<[string, Named, string[]]>([
  ['a nicknamed Pokémon, in Showdown\'s export order', monferno(),
    ['Mon (Monferno) (M) @ Quick Claw', 'Level: 15', 'Ability: Blaze', 'Impish Nature', 'IVs: 0 HP / 26 Atk / 12 Def / 10 SpA / 7 SpD / 24 Spe', '- Scratch', '- Ember']],
  ['a trainer Pokémon with a null nature, no item and 31 IVs: no Nature, @ or IVs line', trainerMon,
    ['Monferno (M)', 'Level: 15', 'Ability: Blaze', '- Scratch', '- Ember']],
  ['only the non-zero EVs, after the ability; no wrapper for a nickname equal to the species, no gender',
    monferno({ nickname: 'Monferno', gender: null, evs: stats(0, 252, 0, 0, 4, 252), ivs: stats(31, 31, 31, 31, 31, 30) }),
    ['Monferno @ Quick Claw', 'Level: 15', 'Ability: Blaze', 'EVs: 252 Atk / 4 SpD / 252 Spe', 'Impish Nature', 'IVs: 30 Spe', '- Scratch', '- Ember']],
])('showdownSet: %s', (_name, mon, lines) => {
  expect(showdownSet(mon, names)).toBe(lines.join('\n'));
});

it("treats the game's default nickname, the species in capitals, as no nickname", () => {
  expect(['MONFERNO', 'Monfern'].map((nickname) => showdownSet(monferno({ nickname }), names).split('\n')[0]))
    .toEqual(['Monferno (M) @ Quick Claw', 'Monfern (Monferno) (M) @ Quick Claw']);
});
