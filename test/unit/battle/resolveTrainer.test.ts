import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanDocsNature, docsNature, resolveNature } from '../../../src/battle/natures.js';
import { resolveTrainer, slug, trainerId } from '../../../src/battle/resolveTrainer.js';
import type { PkcalcNatures } from '../../../src/battle/types.js';
import { parseTeamTab } from '../../../src/docs/teams.js';
import { abilityOf } from '../../../src/rom/abilities.js';
import { genderFromPid, trainerMonGender } from '../../../src/rom/gender.js';
import { NATURES } from '../../../src/rom/natures.js';
import { decodeTrainer } from '../../../src/rom/trainers.js';
import type { SpeciesRecord } from '../../../src/rom/types.js';
import { docMon, docSpecies, docTrainer, loadedData, romSpecies, romTrainer, stats, trainerMon } from '../../fixtures/loadedData.js';
import { hex } from '../../fixtures/romRecords.js';

// Ability IDs are Gen 4 nums, as @pkmn/dex has them.
const [SYNCHRONIZE, INNER_FOCUS, PICKUP, BLAZE, PURE_POWER, TANGLED_FEET, GLUTTONY, IRON_FIST, ADAPTABILITY, QUICK_FEET, SCRAPPY] = [28, 39, 53, 66, 74, 77, 82, 89, 91, 95, 113];
// Natures: Jolly is 13, Modest 15; an unknown nature may be any of the 25.
const [JOLLY, MODEST] = [13, 15];
const ALL_NATURES = Array.from({ length: 25 }, (_, id) => id);
/** Every nature but `own`: what a docs nature lists when PKCalc gives none to compare. */
const OTHER_NATURES = (own: number) => ALL_NATURES.filter((id) => id !== own);
const natureName = (value: number | null) => (value === null ? null : NATURES[value]);
const rom = (value: number, disputed = false, alternatives: number[] = []) => ({ value, source: 'rom', disputed, alternatives });
const docs = (value: number | null, alternatives: number[]) => ({ value, source: 'docs', disputed: true, alternatives });

// Route 202's Youngster Tristan (trainer 1, class 2): his real ROM bytes and his real Roark Split rows, with ROM species
// records as the real ROM has them (a one-ability species repeats it).
const tristanHeader = hex('03 02 00 03 00 00 00 00 00 00 00 00 07 00 00 00 00 00 00 00');
const tristanParty = hex(`
  ff 00 05 00 07 01 fb 00 62 00 1c 00 00 00 00 00 00 00
  ff 00 05 00 a1 00 fb 00 62 00 1c 00 00 00 00 00 00 00
  ff 00 05 00 10 00 f4 00 bd 00 10 00 62 00 1c 00 00 00`);
const roark = parseTeamTab(readFileSync(new URL('../../fixtures/roarkSplitExcerpt.csv', import.meta.url), 'utf8'), 'Roark Split');
const tristanDoc = roark[0]!;
const ZIGZAGOON = romSpecies(263, { baseStats: stats(38, 30, 41, 30, 41, 60), genderRatio: 127, baseFriendship: 90, abilities: [GLUTTONY, GLUTTONY] });
const SENTRET = romSpecies(161, { baseStats: stats(35, 46, 34, 35, 45, 20), genderRatio: 127, abilities: [ADAPTABILITY, ADAPTABILITY] });
const PIDGEY = romSpecies(16, { baseStats: stats(40, 45, 40, 35, 35, 56), types: [0, 2], genderRatio: 127, abilities: [TANGLED_FEET, TANGLED_FEET] });
const ROARK_SPECIES = [docSpecies(16, 'PIDGEY'), docSpecies(161, 'SENTRET'), docSpecies(263, 'ZIGZAGOON')];
const tristanData = loadedData({ species: [ZIGZAGOON, SENTRET, PIDGEY], trainers: [decodeTrainer(1, tristanHeader, tristanParty)], docSpecies: ROARK_SPECIES, docTrainers: roark });
/** Tristan resolved with his first docs Pokémon changed by `first`. */
const tristanWith = (first: Partial<(typeof tristanDoc.party)[number]> = {}, levelMismatch = false) => {
  const doc = { ...tristanDoc, party: tristanDoc.party.map((mon, i) => (i === 0 ? { ...mon, ...first } : mon)) };
  return resolveTrainer({ romIndex: 1, doc, ...(levelMismatch && { levelMismatch: true }) }, [], tristanData);
};

// Leader Maylene (trainer 317, class 76, female): her real ROM bytes. Only Lucario, the last, has byte 1 set (0x20:
// ability override 2), so its nature is unknown. Her docs natures: Lax, Bashful, Naive, Modest, Naive, then Modest.
const mayleneHeader = hex('03 4c 00 06 00 00 00 00 00 00 00 00 07 00 00 00 00 00 00 00');
const mayleneParty = hex(`
  fd 00 2c 00 73 00 9d 00 fc 00 19 00 72 01 be 01 00 00
  ff 00 2d 00 88 01 9d 00 2b 01 08 00 09 00 b7 00 10 00
  ff 00 2c 00 55 00 10 01 b6 00 9d 01 e4 00 88 00 00 00
  ff 00 2d 00 6a 00 10 01 fc 00 88 00 bc 01 e4 00 00 00
  ff 00 2c 00 34 01 c0 00 60 00 88 00 ab 01 08 00 00 00
  ff 20 2f 00 c0 01 13 01 0e 00 72 01 a2 01 b7 00 0e 00`);
const MAYLENE_SPECIES = [
  romSpecies(115, { baseStats: stats(105, 95, 80, 40, 80, 90), genderRatio: 254, abilities: [SCRAPPY, SCRAPPY] }),
  romSpecies(392, { baseStats: stats(77, 104, 71, 104, 71, 108), types: [10, 1], genderRatio: 31, abilities: [IRON_FIST, BLAZE] }),
  romSpecies(85, { baseStats: stats(70, 120, 70, 60, 60, 110), types: [0, 2], genderRatio: 127, abilities: [QUICK_FEET, TANGLED_FEET] }),
  romSpecies(106, { baseStats: stats(50, 120, 53, 35, 110, 87), types: [1, 1], genderRatio: 0, abilities: [QUICK_FEET, QUICK_FEET] }),
  romSpecies(308, { baseStats: stats(60, 75, 75, 60, 75, 80), types: [1, 14], genderRatio: 127, abilities: [PURE_POWER, 0] }),
  romSpecies(448, { baseStats: stats(70, 110, 70, 115, 70, 90), types: [1, 8], genderRatio: 31, abilities: [IRON_FIST, ADAPTABILITY] }),
];
const MAYLENE_DOC_SPECIES = [
  docSpecies(85, 'DODRIO'), docSpecies(106, 'HITMONLEE'), docSpecies(115, 'KANGASKHAN'), docSpecies(308, 'MEDICHAM'), docSpecies(392, 'INFERNAPE'), docSpecies(448, 'LUCARIO'),
];
/** Maylene resolved from her real bytes, Lucario's nature cell set to `lucarioNature` and its byte 1 to `lucarioOverrides`. */
function resolveMaylene(lucarioNature = 'Modest', lucarioOverrides = 0x20, pkcalcNatures?: PkcalcNatures) {
  const party = mayleneParty.slice();
  party[5 * 18 + 1] = lucarioOverrides;
  const doc = docTrainer('Maylene Split', 'Leader Maylene', 30, [
    docMon('Kangaskhan', 44, { nature: 'Lax', ability: 'Scrappy' }), docMon('Infernape', 45, { nature: 'Bashful', ability: 'Iron Fist' }),
    docMon('Dodrio', 44, { nature: 'Naive', ability: 'Quick Feet' }), docMon('Hitmonlee', 45, { nature: 'Modest', ability: 'Quick Feet' }),
    docMon('Medicham', 44, { nature: 'Naive', ability: 'Pure Power' }), docMon('Lucario', 47, { nature: lucarioNature, ability: 'Adaptability' }),
  ], { location: 'Veilstone Gym' });
  const data = loadedData({ species: MAYLENE_SPECIES, trainers: [decodeTrainer(317, mayleneHeader, party)], docSpecies: MAYLENE_DOC_SPECIES, docTrainers: [doc] });
  return resolveTrainer({ romIndex: 317, doc }, [], data, pkcalcNatures);
}
const lucario = (...args: Parameters<typeof resolveMaylene>) => resolveMaylene(...args).party[5]!;

describe('resolveTrainer', () => {
  it('fills a trainer and its Pokémon from the ROM, natures undisputed, with the docs\' name, place and tags', () => {
    const tristan = resolveTrainer({ romIndex: 1, doc: tristanDoc }, [], tristanData);
    expect(tristan).toMatchObject({
      id: 'roark-split/youngster-tristan/1', name: 'Youngster Tristan', split: 'Roark Split', location: 'Route 202', order: 0, romIndex: 1, trainerClass: 2,
      battleType: 'single', aiFlags: ['Basic', 'EvalAttack', 'Expert'], field: null, tags: { starred: false, raw: [] }, levelMismatch: false, variants: [],
    });
    expect(tristan.party[0]).toEqual({
      species: 263, form: 0, name: 'Zigzagoon', level: 5, gender: 'M', ivs: stats(31, 31, 31, 31, 31, 31), evs: stats(0, 0, 0, 0, 0, 0), nature: rom(11), ability: rom(GLUTTONY),
      item: 251, moves: [98, 28], baseStats: stats(38, 30, 41, 30, 41, 60), types: [0, 0], friendship: 90,
    });
    // A male class's PID ends in 136, at or above ratio 127, so all three are male, as the docs say.
    expect(tristan.party.map((mon) => [mon.name, mon.gender, natureName(mon.nature.value), mon.nature, mon.ability.value, mon.item, mon.moves, mon.types])).toEqual([
      ['Zigzagoon', 'M', 'Hasty', rom(11), GLUTTONY, 251, [98, 28], [0, 0]], ['Sentret', 'M', 'Docile', rom(6), ADAPTABILITY, 251, [98, 28], [0, 0]],
      ['Pidgey', 'M', 'Bashful', rom(18), TANGLED_FEET, 244, [189, 16, 98, 28], [0, 2]]]);
  });

  it('disputes a known ROM nature or ability where the docs give another, and reads a level-mismatch match', () => {
    expect(tristanWith({ nature: 'Jolly' }).party[0]!.nature).toEqual(rom(11, true, [JOLLY]));
    const tristan = tristanWith({ ability: 'Pickup' }, true);
    expect([tristan.party[0]!.ability, tristan.levelMismatch]).toEqual([rom(GLUTTONY, true, [PICKUP]), true]);
  });

  it('reads the docs\' known slip "Syncronize" as Synchronize, and throws for an ability cell that names no ability', () => {
    const doc = docTrainer('Elite Four Split', 'Dragon Tamer Clinton', 0, [docMon('Espeon', 60, { ability: 'Syncronize' })]);
    const data = loadedData({
      species: [romSpecies(196, { types: [14, 14], abilities: [SYNCHRONIZE, SYNCHRONIZE] })], trainers: [romTrainer(231, [trainerMon(196, 60)])], docSpecies: [docSpecies(196, 'ESPEON')], docTrainers: [doc],
    });
    expect(resolveTrainer({ romIndex: 231, doc }, [], data).party[0]!.ability).toEqual(rom(SYNCHRONIZE));
    // A new docs slip must not hide a candidate.
    expect(() => tristanWith({ ability: 'Glutony' })).toThrow('"Glutony"');
  });

  it('gives an overridden Pokémon the docs nature, disputed, and each Pokémon its gender from the PID and its species\' ratio', () => {
    const maylene = resolveMaylene();
    expect(maylene.party.map((mon) => [natureName(mon.nature.value), mon.nature.source, mon.nature.disputed])).toEqual([
      ['Lax', 'rom', false], ['Bashful', 'rom', false], ['Naive', 'rom', false], ['Modest', 'rom', false], ['Naive', 'rom', false], ['Modest', 'docs', true]]);
    // A female class's PID ends in 120: female under ratio 127 (Dodrio, Medicham), male under 31 (Infernape, Lucario);
    // Kangaskhan (254) is always female and Hitmonlee (0) always male.
    expect(maylene.party.map((mon) => mon.gender)).toEqual(['F', 'M', 'F', 'M', 'F', 'M']);
  });

  it('lists PKCalc\'s nature as the alternative to a docs nature where it differs, never for a ROM nature, and every other nature without one', () => {
    const asked: [number, number][] = [];
    const maylene = resolveMaylene('Modest', 0x20, (romIndex, slot) => {
      asked.push([romIndex, slot]);
      return JOLLY;
    });
    expect([maylene.party[5]!.nature, ...maylene.party.slice(0, 5).map((mon) => mon.nature.alternatives)]).toEqual([docs(MODEST, [JOLLY]), [], [], [], [], []]);
    expect(asked).toContainEqual([317, 5]);
    expect([lucario('Modest', 0x20, () => MODEST).nature, lucario('Modest', 0x20, () => null).nature, lucario().nature])
      .toEqual([docs(MODEST, []), docs(MODEST, OTHER_NATURES(MODEST)), docs(MODEST, OTHER_NATURES(MODEST))]);
    // "X/Y" and words that are not natures give no docs nature; with the ROM's unknown, there is none.
    for (const cell of ['X/Y', 'Careful/Bold', 'Mantine', '']) expect(lucario(cell).nature).toEqual(docs(null, ALL_NATURES));
  });

  it('takes the ability slot from an ability override, and disputes an ability an untrusted PID picked', () => {
    // Lucario's plain-rule PID is even, which alone would give its first ability (Iron Fist).
    expect([lucario('Modest', 0x20).ability, lucario('Modest', 0x10).ability]).toEqual([rom(ADAPTABILITY), rom(IRON_FIST, true, [ADAPTABILITY])]);
    // From the first ability override on, the hack's PIDs follow a rule we do not know, so `pid & 1` may pick either
    // ability. An override, a one-ability species or a trusted PID settles it.
    const doc = docTrainer('Maylene Split', 'Black Belt Test', 0, [
      docMon('Lucario', 47), docMon('Lucario', 47), docMon('Medicham', 44), docMon('Lucario', 47), docMon('Lucario', 47, { ability: 'Inner Focus' })]);
    const party = [
      trainerMon(448, 47, { natureKnown: false, abilitySlot: 1 }), trainerMon(448, 47, { natureKnown: false, abilitySlot: 1, abilityOverride: 2 }),
      trainerMon(308, 44, { natureKnown: false, abilitySlot: 1 }), trainerMon(448, 47, { abilitySlot: 1 }), trainerMon(448, 47, { natureKnown: false, abilitySlot: 0 }),
    ];
    const data = loadedData({ species: MAYLENE_SPECIES, trainers: [romTrainer(900, party)], docSpecies: MAYLENE_DOC_SPECIES, docTrainers: [doc] });
    expect(resolveTrainer({ romIndex: 900, doc }, [], data).party.map((mon) => mon.ability)).toEqual([
      rom(ADAPTABILITY, true, [IRON_FIST]), rom(ADAPTABILITY), rom(PURE_POWER), rom(ADAPTABILITY),
      rom(IRON_FIST, true, [INNER_FOCUS, ADAPTABILITY]), // the docs' ability and the species' other one are both candidates
    ]);
  });

  it('makes shared copies variants, the default the copy of higher base-stat total, then of higher ROM index', () => {
    // Worker Conrad's bare "Rotom" fits both copies: ROM 30 has Rotom-Wash (row 504, BST 360), ROM 31 plain Rotom (BST 300).
    const conrad = docTrainer('Byron Split', 'Worker Conrad', 4, [docMon('Rotom', 30)]);
    const ronald = docTrainer('Roark Split', 'Clown Ronald', 9, [docMon('Pidgey', 8)]);
    const data = loadedData({
      species: [romSpecies(479, { baseStats: stats(50, 50, 50, 50, 50, 50) }), romSpecies(504, { baseStats: stats(60, 60, 60, 60, 60, 60) }), PIDGEY],
      trainers: [romTrainer(30, [trainerMon(479, 30, { form: 2 })]), romTrainer(31, [trainerMon(479, 30)]), romTrainer(252, [trainerMon(16, 8)]), romTrainer(255, [trainerMon(16, 8, { item: 244 })])],
      docSpecies: [docSpecies(479, 'ROTOM'), docSpecies(504, 'Rotom (Wash)'), ...ROARK_SPECIES], docTrainers: [conrad, ronald],
    });
    for (const [first, second] of [[30, 31], [31, 30]] as const) {
      const resolved = resolveTrainer({ romIndex: first, doc: conrad }, [{ romIndex: second, doc: conrad, shared: true }], data);
      expect([resolved.romIndex, resolved.party[0]!.name, resolved.variants.map((variant) => [variant.romIndex, variant.id, variant.party[0]!.name, variant.variants])])
        .toEqual([30, 'Rotom-Wash', [[31, 'byron-split/worker-conrad/1', 'Rotom', []]]]);
    }
    const resolved = resolveTrainer({ romIndex: 252, doc: ronald }, [{ romIndex: 255, doc: ronald, shared: true }], data);
    expect([resolved.romIndex, resolved.party[0]!.item, resolved.variants.map((variant) => variant.romIndex)]).toEqual([255, 244, [252]]);
  });

  it('reads the ROM\'s battle type: 2 is a double battle', () => {
    const doc = docTrainer('Roark Split', 'Twins Liv & Liz', 3, [docMon('Pidgey', 8)]);
    const data = loadedData({ species: [PIDGEY], trainers: [romTrainer(40, [trainerMon(16, 8)], { battleType: 2 })], docSpecies: ROARK_SPECIES, docTrainers: [doc] });
    expect(resolveTrainer({ romIndex: 40, doc }, [], data)).toMatchObject({ id: 'roark-split/twins-liv-liz/1', battleType: 'double' });
  });
});

describe('trainer IDs', () => {
  it('slugs a name (lower case, accents dropped, other runs of characters one hyphen) and numbers equal names within a split in docs order', () => {
    expect(['Barry #2', 'Pokéfan Martha', 'Twins Liv & Liz', '  GalacticfTerra '].map(slug)).toEqual(['barry-2', 'pokefan-martha', 'twins-liv-liz', 'galacticfterra']);
    const barry = (split: string, order: number) => docTrainer(split, 'Barry #2', order, []);
    const all = [barry('Roark Split', 0), docTrainer('Roark Split', 'Youngster Tristan', 1, []), barry('Roark Split', 2), barry('Gardenia Split', 0)];
    expect(all.map((doc) => trainerId(doc, all))).toEqual(['roark-split/barry-2/1', 'roark-split/youngster-tristan/1', 'roark-split/barry-2/2', 'gardenia-split/barry-2/1']);
  });
});

describe('docs natures', () => {
  it('cleans a docs nature cell: trailing digits stripped, "X/Y" and non-natures null', () => {
    expect(['Hasty', ' modest ', 'Lonely0', 'Quirky12', 'X/Y', 'Careful/Bold', 'Hardy/Hardy', 'Mantine', ''].map(cleanDocsNature)).toEqual([11, 15, 1, 24, null, null, null, null, null]);
  });

  // The ROM's nature where known, the cleaned docs' otherwise, disputed with PKCalc's nature as the alternative where it
  // differs, and every other nature where PKCalc gives none.
  it.each<[boolean, string | null, number | null | undefined, object]>([
    [true, 'Lonely0', undefined, rom(1)], [true, 'Mantine', undefined, rom(1)], [true, 'Bold', undefined, rom(1, true, [5])], [true, 'Lonely', JOLLY, rom(1)],
    [false, 'Bold', undefined, docs(5, OTHER_NATURES(5))], [false, null, undefined, docs(null, ALL_NATURES)], [false, 'Bold', JOLLY, docs(5, [JOLLY])],
    [false, 'Bold', 5, docs(5, [])], [false, 'Bold', null, docs(5, OTHER_NATURES(5))], [false, 'X/Y', JOLLY, docs(null, ALL_NATURES)],
  ])('resolveNature: ROM nature known %s, docs %s, PKCalc %s', (natureKnown, cell, pkcalc, expected) =>
    expect(resolveNature({ nature: 1, natureKnown }, cell, pkcalc)).toEqual(expected));

  it('reads a rival\'s "X/Y" cell for the cross-checks as X for a female class and Y otherwise', () => {
    expect([docsNature('Careful/Bold', true), docsNature('Careful/Bold', false), docsNature('Lonely0', true)]).toEqual(['Careful', 'Bold', 'Lonely0']);
  });
});

describe('abilityOf and trainer Pokémon gender', () => {
  it('takes the slot\'s ability from the form\'s Personal row, the first where the species has no second', () => {
    const species: SpeciesRecord[] = [];
    species[308] = romSpecies(308, { abilities: [PURE_POWER, 0] });
    species[448] = romSpecies(448, { abilities: [IRON_FIST, ADAPTABILITY] });
    expect([trainerMon(448, 47, { abilitySlot: 1 }), trainerMon(448, 47, { abilitySlot: 1, abilityOverride: 2 }), trainerMon(308, 44, { abilitySlot: 1 })].map((mon) => abilityOf(species, mon)))
      .toEqual([{ id: ADAPTABILITY, byPid: true }, { id: ADAPTABILITY, byPid: false }, { id: PURE_POWER, byPid: false }]);
  });

  it('is female when the PID\'s low byte is below the ratio, follows an override (1 male, 2 female), and keeps a fixed ratio\'s (0, 254, 255)', () => {
    expect([genderFromPid(120, 127), genderFromPid(136, 127), genderFromPid(30, 31), genderFromPid(31, 31), genderFromPid(0, 0), genderFromPid(0xff, 254), genderFromPid(0, 255)])
      .toEqual(['F', 'M', 'F', 'M', 'M', 'F', null]);
    expect(([[136, 2, 31], [120, 1, 127], [120, 0, 127], [136, 2, 0], [120, 1, 254], [120, 2, 255]] as const).map(([pid, genderOverride, ratio]) => trainerMonGender({ pid, genderOverride }, ratio)))
      .toEqual(['F', 'M', 'F', 'M', 'F', null]);
  });
});
