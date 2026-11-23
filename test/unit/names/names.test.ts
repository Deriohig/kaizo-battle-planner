import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type DocTrainer, parseTeamTab } from '../../../src/docs/teams.js';
import type { DocMove } from '../../../src/docs/types.js';
import { matchTrainers } from '../../../src/names/matchTrainers.js';
import { buildNameIndex } from '../../../src/names/nameIndex.js';
import { normaliseName } from '../../../src/names/normalise.js';
import type { RomTrainer } from '../../../src/rom/trainers.js';
import { docSpecies as species } from '../../fixtures/loadedData.js';

/** A Moves tab row; only the ID and name matter here. */
const move = (id: number, name: string): DocMove =>
  ({ id, name, effectText: 'None', category: 'physical', power: 40, type: 'Normal', accuracy: 100, pp: 35, effectChance: 0, targets: 'One opponent', priority: 0, contact: true });

// Docs names as written, with some of the Personal tab's form rows past 493. Move 130 is the hack's Skull Bash, renamed
// "Solar-Beam", which normalises the same as move 76, "SolarBeam".
const names = buildNameIndex({
  species: [
    species(29, 'NIDORAN♀'), species(32, 'NIDORAN♂'), species(83, 'FARFETCH’D'), species(122, 'MR. MIME'), species(250, 'HO-OH'),
    species(474, 'PORYGON-Z'), species(479, 'ROTOM'), species(487, 'GIRATINA'), species(413, 'WORMADAM'), species(494, 'Egg'),
    species(499, 'Wormadam (S)'), species(500, 'Wormadam (T)'), species(501, 'Giratina (O)'), species(503, 'Rotom (Heat)'), species(504, 'Rotom (Wash)'),
    species(10, 'CATERPIE'), species(13, 'WEEDLE'), species(16, 'PIDGEY'), species(19, 'RATTATA'), species(161, 'SENTRET'),
    species(191, 'SUNKERN'), species(261, 'POOCHYENA'), species(263, 'ZIGZAGOON'), species(265, 'WURMPLE'), species(396, 'STARLY'),
    species(399, 'BIDOOF'), species(401, 'KRICKETOT'), species(412, 'BURMY'), species(334, 'ALTARIA'), species(349, 'FEEBAS'),
    species(388, 'GROTLE'), species(391, 'MONFERNO'), species(395, 'EMPOLEON'), species(422, 'SHELLOS'), species(428, 'LOPUNNY'), species(446, 'MUNCHLAX'),
  ],
  moves: [move(9, 'ThunderPunch'), move(76, 'SolarBeam'), move(130, 'Solar-Beam'), move(189, 'Mud-Slap')],
});

it('normaliseName drops case, accents and punctuation, keeps digits, and spells ♀ and ♂ as f and m', () =>
  expect(['Poké Ball', 'PORYGON2', 'FARFETCH’D', 'Mud-Slap', 'Nidoran♀', 'NIDORAN♂'].map(normaliseName)).toEqual(['pokeball', 'porygon2', 'farfetchd', 'mudslap', 'nidoranf', 'nidoranm']));

describe('buildNameIndex', () => {
  it.each<[string, { id: number; form: number } | null]>([
    // Forms, as the team tabs and the Personal rows past 493 write them.
    ['Burmy-Sandy', { id: 412, form: 1 }], ['Burmy', { id: 412, form: 0 }], ['Burmy-Plant', { id: 412, form: 0 }], ['Wormadam-Trash', { id: 413, form: 2 }],
    ['Shellos -West', { id: 422, form: 0 }], ['GIRATINA-ORIGIN', { id: 487, form: 1 }], ['Rotom-Wash', { id: 479, form: 2 }], ['Rotom (Wash)', { id: 479, form: 2 }],
    ['Wormadam (S)', { id: 413, form: 1 }], ['Wormadam (T)', { id: 413, form: 2 }], ['Giratina (O)', { id: 487, form: 1 }], ['Rotom (Heat)', { id: 479, form: 1 }],
    // The team tabs' species spellings.
    ['Monferno', { id: 391, form: 0 }], ['MrMime', { id: 122, form: 0 }], ['HoOh', { id: 250, form: 0 }], ['PorygonZ', { id: 474, form: 0 }],
    ['Farfetchd', { id: 83, form: 0 }], ['NidoranF', { id: 29, form: 0 }], ['Nidoran♂', { id: 32, form: 0 }], ['Missingno', null],
  ])('resolves the species name %s', (name, id) => expect(names.speciesId(name)).toEqual(id));

  it.each([[391, 0, 'Monferno'], [122, 0, 'Mr. Mime'], [250, 0, 'Ho-Oh'], [474, 0, 'Porygon-Z'], [83, 0, 'Farfetch’d'], [29, 0, 'Nidoran♀'],
    [499, 0, 'Wormadam (S)'], [412, 1, 'Burmy-Sandy'], [479, 2, 'Rotom-Wash'], [412, 0, 'Burmy']])(
    'names species %i form %i from the docs, in mixed case: %s', (id, form, name) => expect(names.species(id, form)).toBe(name));

  it('names moves from the docs, resolving a spelling that normalises to two names only when it is exact', () => {
    expect(names.move(189)).toBe('Mud-Slap');
    expect(['Mud Slap', 'Thunderpunch', 'Tackle', 'SolarBeam', 'Solar-Beam', 'Solar Beam'].map(names.moveId)).toEqual([189, 9, null, 76, 130, null]);
  });

  it('names items and abilities by Gen 4 number, and those @pkmn/dex lacks by their number', () => {
    // @pkmn/dex marks Cherish and Safari Balls "Unobtainable" in Gen 4, though trainers hold them, and keeps only battle items.
    expect([251, 244, 16, 5, 23, 0].map(names.item)).toEqual(['Silk Scarf', 'Sharp Beak', 'Cherish Ball', 'Safari Ball', '(item 23)', '(item 0)']);
    expect([82, 0].map(names.ability)).toEqual(['Gluttony', '(ability 0)']);
  });

  it('throws for a species, form or move the docs lack, and for a Personal form row that names no form it knows', () => {
    expect(() => names.species(999)).toThrow('species 999');
    expect(() => names.species(391, 1)).toThrow('species 391 form 1');
    expect(() => names.move(999)).toThrow('move 999');
    expect(() => buildNameIndex({ species: [species(479, 'ROTOM'), species(503, 'Rotom (Spin)')], moves: [] }))
      .toThrow('The Personal tab\'s "Rotom (Spin)" (ID 503) names no known form');
  });
});

describe('matchTrainers', () => {
  /** A ROM trainer whose party is `[species, level, form?, item?]` per slot. The other fields take no part in matching. */
  const rom = (index: number, ...party: [number, number, number?, number?][]): RomTrainer => ({
    index, trainerClass: 0, battleType: 0, aiMask: 0, aiFlags: [], items: [],
    party: party.map(([species, level, form = 0, item = 0]) => ({
      species, form, level, iv: 0, pid: 0, nature: 0, natureKnown: true, abilitySlot: 0, genderOverride: 0, abilityOverride: 0, item, moves: [],
    })),
  });
  /** A docs trainer whose party is `[species name, level, item?]` per slot. */
  const doc = (...party: [string, number, string?][]): DocTrainer => ({
    split: 'Test Split', location: 'Route 1', locationGauntlet: false, field: null, name: 'Youngster', tags: { starred: false, raw: [] },
    order: 0, party: party.map(([species, level, item = null]) => ({ level, species, gender: null, nature: 'Hardy', ability: '-', item, moves: [] })),
  });
  // Route 202's trainers from the real Roark Split excerpt, and Tristan's ROM trainer as decoded from the real ROM.
  const [tristan, natalie, logan] = parseTeamTab(readFileSync(new URL('../../fixtures/roarkSplitExcerpt.csv', import.meta.url), 'utf8'), 'Roark Split') as DocTrainer[];
  const TRISTAN = rom(1, [263, 5], [161, 5], [16, 5]);
  // Maylene Split's partner "Trainer Dawn/Lucas" is ROM trainers 621 and 624, one for each player gender.
  const rival: [number, number][] = [[446, 40], [334, 40], [428, 40], [388, 41], [391, 41], [395, 44]];

  // Each match's docs trainer is given as its index in the docs list.
  it.each<[string, RomTrainer[], DocTrainer[], { matched: object[]; romOnly: number[]; docsOnly: number[] }]>([
    ["by party species and levels in order (trainer 0 is the ROM's unused placeholder)", [rom(0, [1, 1]), TRISTAN, rom(2, [13, 6], [10, 6], [265, 7], [401, 7]),
      rom(3, [191, 6], [396, 6], [261, 6])], [tristan!, natalie!, logan!], { matched: [{ romIndex: 1, doc: 0 }, { romIndex: 3, doc: 1 }, { romIndex: 2, doc: 2 }], romOnly: [0], docsOnly: [] }],
    ['identical parties in ROM index order, a leftover shared by the last of them', [rom(6, [19, 5]), rom(5, [19, 5]), rom(7, [19, 5])], [doc(['Rattata', 5]), doc(['Rattata', 5])],
      { matched: [{ romIndex: 5, doc: 0 }, { romIndex: 6, doc: 1 }, { romIndex: 7, doc: 1, shared: true }], romOnly: [], docsOnly: [] }],
    ["each leftover ROM trainer with a docs trainer's exact party, as shared", [rom(624, ...rival), rom(621, ...rival)],
      [doc(['Munchlax', 40], ['Altaria', 40], ['Lopunny', 40], ['Grotle', 41], ['Monferno', 41], ['Empoleon', 44])],
      { matched: [{ romIndex: 621, doc: 0 }, { romIndex: 624, doc: 0, shared: true }], romOnly: [], docsOnly: [] }],
    ['a name with a form suffix to that form only', [rom(7, [412, 10]), rom(8, [412, 10, 1]), rom(9, [422, 20, 1])], [doc(['Burmy-Sandy', 10]), doc(['Shellos -West', 20])],
      { matched: [{ romIndex: 8, doc: 0 }], romOnly: [7, 9], docsOnly: [1] }],
    // Wake Split's Tuber Jared writes "Shellos"; his ROM trainer, 107, has an East Shellos (form 1).
    ['a bare species name to any form', [rom(107, [349, 100], [422, 100, 1])], [doc(['Feebas', 100], ['Shellos', 100])], { matched: [{ romIndex: 107, doc: 0 }], romOnly: [], docsOnly: [] }],
    ['a named form before a bare name', [rom(5, [422, 10, 1]), rom(6, [422, 10])], [doc(['Shellos', 10]), doc(['Shellos-East', 10])],
      { matched: [{ romIndex: 6, doc: 0 }, { romIndex: 5, doc: 1 }], romOnly: [], docsOnly: [] }],
    // The exact pass runs first, so the second docs trainer keeps ROM trainer 10 though the first fits it on species.
    ['what is left on species and forms alone, flagged levelMismatch', [rom(10, [19, 7]), rom(11, [19, 9]), TRISTAN], [doc(['Rattata', 5]), doc(['Rattata', 7]), tristan!],
      { matched: [{ romIndex: 11, doc: 0, levelMismatch: true }, { romIndex: 10, doc: 1 }, { romIndex: 1, doc: 2 }], romOnly: [], docsOnly: [] }],
    ['shared matches, which are exact, before level ones', [rom(5, [19, 5]), rom(6, [19, 5])], [doc(['Rattata', 5]), doc(['Rattata', 9])],
      { matched: [{ romIndex: 5, doc: 0 }, { romIndex: 6, doc: 0, shared: true }], romOnly: [], docsOnly: [1] }],
    // Galactic Split's three SwimmerF Wang fights share one party, in another order than the docs'. Silk Scarf is 251, Sharp Beak 244.
    ['among ROM trainers with its party, the one whose items agree most', [rom(5, [19, 5, 0, 244]), rom(6, [19, 5, 0, 251])],
      [doc(['Rattata', 5, 'Silk Scarf']), doc(['Rattata', 5, 'Sharp Beak'])], { matched: [{ romIndex: 6, doc: 0 }, { romIndex: 5, doc: 1 }], romOnly: [], docsOnly: [] }],
    // Tristan's party a level up: its only ROM trainer goes to Tristan himself.
    ['nothing for unmatched trainers either way', [TRISTAN, rom(9, [399, 3])], [doc(['Zigzagoon', 6], ['Sentret', 6], ['Pidgey', 6]), tristan!, doc(['Zigzagoon', 5], ['Missingno', 5], ['Pidgey', 5])],
      { matched: [{ romIndex: 1, doc: 1 }], romOnly: [9], docsOnly: [0, 2] }],
  ])('matches %s', (_, romTrainers, docs, expected) => {
    const report = matchTrainers(romTrainers, docs, names);
    expect({ ...report, matched: report.matched.map((m) => ({ ...m, doc: docs.indexOf(m.doc) })), docsOnly: report.docsOnly.map((d) => docs.indexOf(d)) }).toEqual(expected);
  });
});
