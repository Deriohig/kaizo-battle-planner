import { describe, expect, it } from 'vitest';
import { type Diff, diffLearnsets, diffMoves, diffsByKey, diffsFromKeyed, diffSpecies, diffTrainers } from '../../../src/check/diff.js';
import type { DocTrainer } from '../../../src/docs/teams.js';
import type { DocMove, DocSpecies } from '../../../src/docs/types.js';
import { buildNameIndex } from '../../../src/names/nameIndex.js';
import type { RomTrainer, TrainerMon } from '../../../src/rom/trainers.js';
import type { LevelUpMove, MoveRecord, SpeciesRecord } from '../../../src/rom/types.js';
import { docSpecies, romSpecies, romTrainer, stats, trainerMon } from '../../fixtures/loadedData.js';

// Gen 4 IDs, as @pkmn/dex has them: abilities Compound Eyes 14, Levitate 26, Pressure 46, Run Away 50, Keen Eye 51,
// Gluttony 82, Sniper 97; items Sharp Beak 244, Silk Scarf 251. Natures: 5 Bold, 6 Docile, 11 Hasty, 18 Bashful, 23 Careful.
const [COMPOUND_EYES, LEVITATE, PRESSURE, RUN_AWAY, KEEN_EYE, GLUTTONY, SNIPER, SHARP_BEAK, SILK_SCARF] = [14, 26, 46, 50, 51, 82, 97, 244, 251];

const docMove = (id: number, name: string, fields: Partial<DocMove> = {}): DocMove =>
  ({ id, name, effectText: 'None', category: 'physical', power: 40, type: 'Normal', accuracy: 100, pp: 35, effectChance: 0, targets: 'One opponent', priority: 0, contact: true, ...fields });
const romMove = (id: number, fields: Partial<MoveRecord> = {}): MoveRecord =>
  ({ id, effect: 0, category: 'physical', power: 40, type: 0, accuracy: 100, pp: 35, effectChance: 0, target: 0, priority: 0, flags: 0, ...fields });
/** Records in an array indexed by ID, as `RomData` holds them. */
function byId<T extends { id: number }>(records: T[]): T[] {
  const list: T[] = [];
  for (const record of records) list[record.id] = record;
  return list;
}

const names = buildNameIndex({
  species: [docSpecies(16, 'PIDGEY'), docSpecies(22, 'FEAROW'), docSpecies(161, 'SENTRET'), docSpecies(263, 'ZIGZAGOON'), docSpecies(479, 'ROTOM'),
    docSpecies(487, 'GIRATINA'), docSpecies(501, 'Giratina (O)'), docSpecies(504, 'Rotom (Wash)')],
  moves: [docMove(1, 'Pound'), docMove(16, 'Gust'), docMove(28, 'Sand-Attack'), docMove(33, 'Tackle'), docMove(45, 'Growl'), docMove(76, 'SolarBeam'),
    docMove(98, 'Quick Attack'), docMove(130, 'Solar-Beam'), docMove(189, 'Mud-Slap')],
});

describe('diffSpecies', () => {
  const FEAROW_STATS = stats(65, 110, 75, 61, 61, 100);
  const docs: DocSpecies = { ...docSpecies(22, 'FEAROW'), baseStats: FEAROW_STATS, types: ['Normal', 'Flying'], abilities: ['Sniper', '-'] };
  const rom = romSpecies(22, { baseStats: FEAROW_STATS, types: [0, 2], abilities: [SNIPER, 0] });
  const fearow = (field: string, romValue: unknown, docsValue: unknown): Diff => ({ area: 'species', key: 'Fearow', field, rom: romValue, docs: docsValue });

  it.each<[string, SpeciesRecord[], DocSpecies, Diff[]]>([
    ['nothing for a species matching its Personal row, reading "-" as no ability', [rom], docs, []],
    ['each stat that differs, keyed by the docs name', [rom], { ...docs, baseStats: { ...FEAROW_STATS, spa: 31 } }, [fearow('spa', 61, 31)]],
    ['types, abilities and growth rate, by name', [{ ...rom, types: [0, 0], growthRate: 3, abilities: [KEEN_EYE, SNIPER] }], docs, [
      fearow('type2', 'Normal', 'Flying'), fearow('ability1', 'Keen Eye', 'Sniper'), fearow('ability2', 'Sniper', '-'), fearow('growthRate', 'Medium Slow', 'Medium Fast')]],
    ['nothing for an ability spelt another way ("Compoundeyes")', [{ ...rom, abilities: [COMPOUND_EYES, 0] }], { ...docs, abilities: ['Compoundeyes', '-'] }, []],
    ['a Personal row the ROM lacks', [], docs, [fearow('record', null, 'FEAROW')]],
  ])('reports %s', (_, records, row, expected) => expect(diffSpecies({ species: byId(records) }, { species: [row] }, names)).toEqual(expected));
});

describe('diffLearnsets and diffMoves', () => {
  const docs = new Map([[16, [{ move: 'Tackle', level: 1 }, { move: 'Mud Slap', level: 9 }]]]);
  const pidgeyLearns = (moves: [number, number][]) => {
    const learnsets: LevelUpMove[][] = [];
    learnsets[16] = moves.map(([move, level]) => ({ move, level }));
    return learnsets;
  };

  it.each<[string, [number, number][], string[] | null]>([
    ['nothing for the same moves at the same levels, whatever their spelling', [[33, 1], [189, 9]], null],
    ['a level difference as one diff holding both lists', [[33, 1], [189, 7]], ['L1 Tackle', 'L7 Mud-Slap']],
    ['a different move', [[33, 1], [16, 9]], ['L1 Tackle', 'L9 Gust']],
    ['a longer list', [[33, 1], [189, 9], [16, 13]], ['L1 Tackle', 'L9 Mud-Slap', 'L13 Gust']],
  ])('diffLearnsets reports %s', (_, moves, rom) => expect(diffLearnsets({ learnsets: pidgeyLearns(moves) }, { learnsets: docs }, names))
    .toEqual(rom ? [{ area: 'learnset', key: 'Pidgey', field: 'moves', rom, docs: ['L1 Tackle', 'L9 Mud Slap'] }] : []));

  it('diffMoves reports nothing for a matching row whatever its effect, and each differing field keyed by the docs name', () => {
    expect(diffMoves({ moves: byId([romMove(98, { effect: 103, priority: 1 })]) }, { moves: [docMove(98, 'Quick Attack', { priority: 1 })] }, names)).toEqual([]);
    const rom = romMove(189, { category: 'physical', power: 25, type: 0, accuracy: 90, pp: 15, effectChance: 50, priority: -1 });
    const docsRow = docMove(189, 'Mud-Slap', { category: 'special', power: 20, type: 'Ground', accuracy: 100, pp: 10, effectChance: 100, priority: 0 });
    expect(diffMoves({ moves: byId([rom]) }, { moves: [docsRow] }, names)).toEqual([
      ['power', 25, 20], ['type', 'Normal', 'Ground'], ['accuracy', 90, 100], ['pp', 15, 10], ['priority', -1, 0], ['category', 'physical', 'special'], ['effectChance', 50, 100],
    ].map(([field, romValue, docsValue]) => ({ area: 'move', key: 'Mud-Slap', field, rom: romValue, docs: docsValue })));
  });
});

describe('diffTrainers', () => {
  const ROM_SPECIES = byId([
    romSpecies(16, { abilities: [KEEN_EYE, 0] }), romSpecies(161, { abilities: [RUN_AWAY, KEEN_EYE] }), romSpecies(263, { abilities: [GLUTTONY, 0] }),
    romSpecies(479, { abilities: [LEVITATE, 0] }), romSpecies(487, { abilities: [PRESSURE, 0] }), romSpecies(501, { abilities: [LEVITATE, 0] }), romSpecies(504, { abilities: [LEVITATE, 0] }),
  ]);
  const mon = (species: number, level: number, fields: Partial<TrainerMon> = {}) => trainerMon(species, level, { pid: 0, ...fields });
  type DocMon = DocTrainer['party'][number];
  const docMon = (species: string, level: number, fields: Partial<DocMon> = {}): DocMon =>
    ({ level, species, gender: null, nature: 'Hardy', ability: 'Keen Eye', item: null, moves: ['Tackle'], ...fields });
  const docTrainer = (name: string, party: DocMon[]): DocTrainer =>
    ({ split: 'Roark Split', location: 'Route 202', locationGauntlet: false, field: null, name, tags: { starred: false, raw: [] }, order: 0, party });
  const diff = (rom: RomTrainer[], docs: DocTrainer[]) => diffTrainers({ species: ROM_SPECIES, trainers: rom }, { trainers: docs }, names);
  /** The diffs of `name`'s ROM trainer `index`, as [slot, species, field, rom, docs]. */
  const diffs = (name: string, index: number, rows: [number, string, string, unknown, unknown][]): Diff[] =>
    rows.map(([slot, species, field, rom, docs]) => ({ area: 'trainer', key: `Roark Split: ${name} [ROM ${index}] mon ${slot} (${species})`, field, rom, docs }));

  // Route 202's Youngster Tristan (ROM trainer 1, class 2), as the docs and the ROM give him.
  const tristanDocs = docTrainer('Youngster Tristan', [
    docMon('Zigzagoon', 5, { nature: 'Hasty', ability: 'Gluttony', item: 'Silk Scarf', moves: ['Quick Attack', 'Sand Attack'] }),
    docMon('Sentret', 5, { nature: 'Docile', ability: 'Run Away', item: 'Silk Scarf', moves: ['Mud Slap', 'Tackle'] }),
    docMon('Pidgey', 5, { nature: 'Bashful', ability: 'Keen Eye', item: 'Sharp Beak', moves: ['Gust', 'Sand-Attack', 'Quick Attack', 'Growl'] }),
  ]);
  const tristanRom = romTrainer(1, [
    mon(263, 5, { nature: 11, item: SILK_SCARF, moves: [98, 28] }), mon(161, 5, { nature: 6, item: SILK_SCARF, moves: [189, 33] }),
    mon(16, 5, { nature: 18, item: SHARP_BEAK, moves: [16, 28, 98, 45] }),
  ]);

  it('reports nothing for a matched trainer that agrees with the docs, and leaves out unmatched trainers on both sides', () => {
    expect(diff([tristanRom], [tristanDocs])).toEqual([]);
    expect(diff([romTrainer(2, [mon(161, 5)])], [tristanDocs])).toEqual([]);
  });

  it('reports level, species and form, item and moves per Pokémon, keyed by split, name, ROM index and slot', () => {
    // Matched on species alone: the docs' levels differ, and its Rotom names no form.
    const docs = docTrainer('Worker Conrad', [docMon('Pidgey', 9, { item: 'Silk Scarf' }), docMon('Rotom', 30, { ability: 'Levitate', moves: ['Pound', 'Growl'] })]);
    const rom = romTrainer(7, [mon(16, 8), mon(479, 30, { form: 2, item: SILK_SCARF, moves: [1, 45, 33] })]);
    expect(diff([rom], [docs])).toEqual(diffs('Worker Conrad', 7, [
      [1, 'Pidgey', 'level', 8, 9], [1, 'Pidgey', 'item', null, 'Silk Scarf'], [2, 'Rotom', 'species', 'Rotom-Wash', 'Rotom'],
      [2, 'Rotom', 'item', 'Silk Scarf', null], [2, 'Rotom', 'moves', ['Pound', 'Growl', 'Tackle'], ['Pound', 'Growl']],
    ]));
  });

  it('reports the same moves in another order as move-order, and moves told apart by ID as moves', () => {
    // SolarBeam (76, with a charging turn) and Solar-Beam (130) normalise alike.
    const docs = docTrainer('Youngster A', [docMon('Pidgey', 5, { moves: ['Sand-Attack', 'Gust', 'Quick Attack', 'Growl'] }), docMon('Pidgey', 5, { moves: ['Solar-Beam', 'Tackle'] })]);
    expect(diff([romTrainer(9, [mon(16, 5, { moves: [16, 28, 98, 45] }), mon(16, 5, { moves: [33, 76] })])], [docs])).toEqual(diffs('Youngster A', 9, [
      [1, 'Pidgey', 'move-order', ['Gust', 'Sand-Attack', 'Quick Attack', 'Growl'], ['Sand-Attack', 'Gust', 'Quick Attack', 'Growl']],
      [2, 'Pidgey', 'moves', ['Tackle', 'SolarBeam'], ['Solar-Beam', 'Tackle']],
    ]));
  });

  it('takes a form\'s ability from its own Personal row, and the first ability where a species has no second, as the game does', () => {
    const giratina = docTrainer('Cyrus', [docMon('GIRATINA-ORIGIN', 70, { ability: '' })]);
    expect(diff([romTrainer(9, [mon(487, 70, { form: 1 })])], [giratina])).toEqual(diffs('Cyrus', 9, [[1, 'GIRATINA-ORIGIN', 'ability', 'Levitate', '']]));
    expect(diff([romTrainer(9, [mon(263, 5, { abilitySlot: 1, abilityOverride: 2 })])], [docTrainer('Youngster A', [docMon('Zigzagoon', 5, { ability: 'Gluttony' })])])).toEqual([]);
  });

  it('files an ability that rests on an untrusted PID under ability-cross-check, and any other under ability', () => {
    // Sentret has two abilities, so with no override the PID's lowest bit picks one; that PID is untrusted where the
    // nature is unknown. An override, or a species with one ability, makes the ROM ability certain.
    const docs = docTrainer('Youngster A', [...Array(3).fill(docMon('Sentret', 5, { ability: 'Keen Eye' })), docMon('Zigzagoon', 5, { ability: 'Pickup' })]);
    const rom = romTrainer(9, [mon(161, 5, { natureKnown: false }), mon(161, 5), mon(161, 5, { natureKnown: false, abilityOverride: 1 }), mon(263, 5, { natureKnown: false })]);
    expect(diff([rom], [docs])).toEqual(diffs('Youngster A', 9, [
      [1, 'Sentret', 'ability-cross-check', 'Run Away', 'Keen Eye'], [2, 'Sentret', 'ability', 'Run Away', 'Keen Eye'],
      [3, 'Sentret', 'ability', 'Run Away', 'Keen Eye'], [4, 'Zigzagoon', 'ability', 'Gluttony', 'Pickup'],
    ]));
  });

  it('compares a nature only where the ROM\'s is known, reading a rival\'s "X/Y" as X for the female (Dawn) copy and Y for the male', () => {
    const docs = docTrainer('Youngster A', [docMon('Pidgey', 5, { nature: 'Jolly' }), docMon('Pidgey', 5, { nature: 'Jolly' })]);
    expect(diff([romTrainer(9, [mon(16, 5, { natureKnown: false }), mon(16, 5)])], [docs])).toEqual(diffs('Youngster A', 9, [[2, 'Pidgey', 'nature-cross-check', 'Hardy', 'Jolly']]));
    // Class 96 is the female Diamond/Pearl player, class 95 the male one.
    const rival = docTrainer('Trainer Dawn/Lucas', [docMon('Pidgey', 40, { nature: 'Careful/Bold' })]);
    const copies = ([[613, 95, 5], [614, 96, 23], [615, 96, 5]] as const).map(([index, trainerClass, nature]) => romTrainer(index, [mon(16, 40, { nature })], { trainerClass }));
    expect(diff(copies, [rival])).toEqual(diffs('Trainer Dawn/Lucas', 615, [[1, 'Pidgey', 'nature-cross-check', 'Bold', 'Careful/Bold']]));
  });
});

describe('diffsByKey and diffsFromKeyed', () => {
  const fearow: Diff = { area: 'species', key: 'Fearow', field: 'spa', rom: 61, docs: 31 };

  it('keys each diff as area/key/field holding both values, the other side "pkcalc" in the PKCalc areas, and undoes it, keeping a "/" in a key', () => {
    expect(diffsByKey([fearow])).toEqual({ 'species/Fearow/spa': { rom: 61, docs: 31 } });
    const ai: Diff = { area: 'pkcalc-ai', key: 'Roark Split: Youngster Tristan [ROM 1]', field: 'flags', rom: ['Basic'], docs: [] };
    expect(diffsByKey([ai])).toEqual({ 'pkcalc-ai/Roark Split: Youngster Tristan [ROM 1]/flags': { rom: ['Basic'], pkcalc: [] } });
    const diffs: Diff[] = [fearow, ai, { area: 'trainer', key: 'Maylene Split: Trainer Dawn/Lucas [ROM 621] mon 1 (Munchlax)', field: 'nature-cross-check', rom: 'Timid', docs: 'Relaxed/Timid' }];
    expect(diffsFromKeyed(diffsByKey(diffs))).toEqual(diffs);
  });

  it('throws on two diffs with the same key, and on a key in no known area', () => {
    expect(() => diffsByKey([fearow, { ...fearow, rom: 60 }])).toThrow('species/Fearow/spa');
    expect(() => diffsFromKeyed({ 'pokemon/Fearow/spa': { rom: 1, docs: 2 } })).toThrow('pokemon/Fearow/spa');
  });
});
