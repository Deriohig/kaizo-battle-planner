import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPkcalcDex, type DexTables, diffBox, diffPkcalc, docsTrainerBase, downloadPkcalc, joinPkcalc, loadPkcalcGlobal,
  parsePkcalcKey, PKCALC_FILES, pkcalcAiFlags, type PkcalcAiFlags, type PkcalcCustomSet, type PkcalcData, pkcalcNatures, type PkcalcSet,
} from '../../../src/check/pkcalc.js';
import type { DocTrainer } from '../../../src/docs/teams.js';
import type { DocMove } from '../../../src/docs/types.js';
import type { TrainerMatch } from '../../../src/names/matchTrainers.js';
import { buildNameIndex } from '../../../src/names/nameIndex.js';
import type { TrainerMon } from '../../../src/rom/trainers.js';
import type { SpeciesRecord } from '../../../src/rom/types.js';
import type { SaveMon } from '../../../src/save/readSave.js';
import { docSpecies, romSpecies, romTrainer, trainerMon } from '../../fixtures/loadedData.js';

// Gen 4 IDs: species Pidgey 16, Primeape 57, Arcanine 59, Sentret 161, Zigzagoon 263, Turtwig 387, Chimchar 390, Piplup
// 393, Burmy 412, Rotom 479; moves Gust 16, Sand-Attack 28, Tackle 33, Quick Attack 98, Faint Attack 185; items Sharp
// Beak 244, Silk Scarf 251; abilities Levitate 26, Run Away 50, Keen Eye 51, Gluttony 82.
const docMove = (id: number, name: string): DocMove =>
  ({ id, name, effectText: 'None', category: 'physical', power: 40, type: 'Normal', accuracy: 100, pp: 35, effectChance: 0, targets: 'One opponent', priority: 0, contact: true });
const names = buildNameIndex({
  species: ([[16, 'PIDGEY'], [57, 'PRIMEAPE'], [59, 'ARCANINE'], [161, 'SENTRET'], [263, 'ZIGZAGOON'], [387, 'TURTWIG'], [390, 'CHIMCHAR'], [393, 'PIPLUP'],
    [412, 'BURMY'], [479, 'ROTOM']] as const).map(([id, name]) => docSpecies(id, name)),
  moves: [docMove(16, 'Gust'), docMove(28, 'Sand-Attack'), docMove(33, 'Tackle'), docMove(98, 'Quick Attack'), docMove(185, 'Faint Attack')],
});

const species = (num: number, name: string, formes: string[] = [], baseSpecies = '') => ({ num, id: name.toLowerCase().replace(/[^a-z0-9]/g, ''), name, baseSpecies, formes });
const named = (entries: [number, string][]) => Object.fromEntries(entries.map(([num, calcName]) => [calcName.toLowerCase().replace(/[^a-z0-9]/g, ''), { num, calcName }]));
const TABLES: DexTables = {
  SPECIES: Object.fromEntries([
    species(16, 'Pidgey'), species(57, 'Primeape'), species(59, 'Arcanine'), species(161, 'Sentret'), species(263, 'Zigzagoon'), species(387, 'Turtwig'),
    species(390, 'Chimchar'), species(393, 'Piplup'), species(412, 'Burmy'), species(479, 'Rotom', ['rotom', 'rotomheat', 'rotomwash']),
    species(479, 'Rotom-Heat', [], 'rotom'), species(479, 'Rotom-Wash', [], 'rotom'),
  ].map((entry) => [entry.id, entry])),
  MOVES: named([[16, 'Gust'], [28, 'Sand Attack'], [33, 'Tackle'], [98, 'Quick Attack'], [185, 'Feint Attack']]),
  ITEMS: named([[244, 'Sharp Beak'], [251, 'Silk Scarf']]),
  ABILITIES: named([[26, 'Levitate'], [50, 'Run Away'], [51, 'Keen Eye'], [82, 'Gluttony']]),
};
const dex = buildPkcalcDex(TABLES);

const mon = (speciesId: number, fields: Partial<TrainerMon> = {}) => trainerMon(speciesId, 5, { pid: 0, ...fields });
type DocMon = DocTrainer['party'][number];
const docMon = (speciesName: string, fields: Partial<DocMon> = {}): DocMon =>
  ({ level: 5, species: speciesName, gender: null, nature: 'Hardy', ability: 'Keen Eye', item: null, moves: ['Tackle'], ...fields });
const docTrainer = (name: string, party: DocMon[] = []): DocTrainer =>
  ({ split: 'Roark Split', location: 'Route 202', locationGauntlet: false, field: null, name, tags: { starred: false, raw: [] }, order: 0, party });
const NO_FLAGS: PkcalcAiFlags = { Basic: 0, EvaluateAttack: 0, Expert: 0, Setup: 0, Risky: 0, DamagePriority: 0, BatonPass: 0, TagStrategy: 0, CheckHP: 0, Weather: 0, Harassment: 0 };
/** PKCalc data with these party orders, no sets and no AI flags unless given. */
const pkcalc = (partyOrder: Record<string, string[]>, fields: Partial<PkcalcData> = {}): PkcalcData =>
  ({ sets: {}, aiFlags: Object.fromEntries(Object.keys(partyOrder).map((key) => [key, NO_FLAGS])), partyOrder, dex, ...fields });

describe('PKCalc names and flags', () => {
  it.each([
    ['Pokémon Trainer Barry #2 [Chimchar]', { base: 'barry', number: 2, place: null, tag: 'Chimchar' }],
    ['Pokémon Trainer Dawn @ Jubilife City [Prinplup]', { base: 'dawn', number: null, place: 'Jubilife City', tag: 'Prinplup' }],
    ['Galactic Mercury #1', { base: 'galacticmercury', number: 1, place: null, tag: null }],
  ])('parsePkcalcKey splits %s', (key, parsed) => expect(parsePkcalcKey(key)).toEqual({ key, ...parsed }));

  it.each([
    // The female-class "f" drops out.
    ['GalacticfVenus', true, 'galacticvenus'], ['GalacticF Luna', true, 'galacticluna'], ['CyclistFMegan', true, 'cyclistmegan'],
    ['GalacticfSquad Phobos', true, 'galacticsquadphobos'], ['Galactic Francisco', true, 'galacticfrancisco'],
    // PKCalc's own spellings.
    ['Pkmn BreederF Jennifer', false, 'pokemonbreederjennifer'], ['PKMN Breeder Frank', false, 'pokemonbreederfrank'], ['Pkmn Trainer Riley', false, 'riley'],
    ['Trainer Cheryl', false, 'cheryl'], ['TAG PARTNER MIRA', false, 'mira'], ['Double Team Stevie and Lindsey', false, 'doubleteamstevielindsey'],
    ['Idol Zoe, the best trainer in the game.', false, 'idolzoe'], ['Leader Fantina ?', false, 'leaderfantina'], ['Picknicker Tori', false, 'picnickertori'],
    ['Leader Cyrus', false, 'galacticbosscyrus'], ['CYRUS', false, 'galacticbosscyrus'], ['Cyrus', false, 'galacticbosscyrus'],
    ['Trainer Dawn/Lucas', true, 'dawn'], ['Trainer Dawn/Lucas', false, 'lucas'],
  ])('docsTrainerBase reads %s (female class: %s) as %s', (name, female, base) => expect(docsTrainerBase(name, female).base).toBe(base));

  it('docsTrainerBase takes the fight number from the name', () => expect(docsTrainerBase('Barry #2', false)).toEqual({ base: 'barry', number: 2 }));

  it('pkcalcAiFlags gives the AI_FLAG_NAMES names of the flags set, in bit order, and throws for a flag it does not know', () => {
    expect(pkcalcAiFlags(Object.fromEntries(Object.keys(NO_FLAGS).map((flag) => [flag, 1])) as PkcalcAiFlags))
      .toEqual(['Basic', 'EvalAttack', 'Expert', 'SetupFirstTurn', 'Risky', 'PrioritizeExtremes', 'BatonPass', 'TagStrategy', 'CheckHP', 'Weather', 'Harassment']);
    expect(pkcalcAiFlags({ ...NO_FLAGS, Basic: 1, Expert: 1 })).toEqual(['Basic', 'Expert']);
    expect(() => pkcalcAiFlags({ ...NO_FLAGS, Psychic: 1 } as PkcalcAiFlags)).toThrow('Psychic');
  });

  it('buildPkcalcDex finds species (with a form only where PKCalc keeps forms), moves, items and abilities by PKCalc\'s name', () => {
    expect([dex.species('Rotom-Wash'), dex.species('Rotom'), dex.species('Burmy')]).toEqual([{ id: 479, form: 2 }, { id: 479, form: 0 }, { id: 412, form: null }]);
    expect([dex.move('Feint Attack'), dex.item('Silk Scarf'), dex.ability('Levitate')]).toEqual([185, 251, 26]);
    expect([dex.species('Missingno'), dex.move('Faint Attack'), dex.item('Leek'), dex.ability('Syncronize')]).toEqual([null, null, null, null]);
  });
});

describe('joinPkcalc', () => {
  const keyOf = (join: ReturnType<typeof joinPkcalc>, romIndex: number) => join.joined.find((j) => j.match.romIndex === romIndex)?.key;

  it('joins same-name trainers to the numbered keys in docs order, a shared ROM copy to its docs trainer\'s key', () => {
    const [first, second] = [docTrainer('Galactic Mercury'), docTrainer('GalacticfMercury')];
    const matched: TrainerMatch[] = [{ romIndex: 10, doc: first }, { romIndex: 11, doc: first, shared: true }, { romIndex: 12, doc: second }];
    const join = joinPkcalc(matched, [10, 11, 12].map((i) => romTrainer(i, [mon(16)])), pkcalc({ 'Galactic Mercury #1': ['Pidgey'], 'Galactic Mercury #2': ['Pidgey'] }));
    expect([10, 11, 12].map((i) => keyOf(join, i))).toEqual(['Galactic Mercury #1', 'Galactic Mercury #1', 'Galactic Mercury #2']);
  });

  it('joins each rival starter team to the key naming its starter, keeping the docs\' fight number', () => {
    const barry = (fight: number, starter: string) => `Pokémon Trainer Barry #${fight} [${starter}]`;
    const order = Object.fromEntries([
      ...['Chimchar', 'Piplup', 'Turtwig'].flatMap((starter) => [[barry(1, starter), [starter]], [barry(2, starter), ['Pidgey', starter]]]), [barry(1, '{RIVAL_STARTER_1}'), []],
    ]);
    // The docs leave out the first fight and list the second's teams in another order than PKCalc.
    const matched: TrainerMatch[] = [0, 1, 2].map((i) => ({ romIndex: 20 + i, doc: docTrainer('Barry #2') }));
    const join = joinPkcalc(matched, [393, 387, 390].map((starter, i) => romTrainer(20 + i, [mon(16), mon(starter)])), pkcalc(order));
    expect(join.joined.map((j) => j.key)).toEqual([barry(2, 'Piplup'), barry(2, 'Turtwig'), barry(2, 'Chimchar')]);
    expect(join.unusedKeys).toEqual([barry(1, 'Chimchar'), barry(1, 'Piplup'), barry(1, 'Turtwig')]);
  });

  it('joins "Trainer Dawn/Lucas" to Dawn\'s key for a female class and Lucas\'s otherwise', () => {
    const doc = docTrainer('Trainer Dawn/Lucas');
    const trainers = [romTrainer(30, [mon(16)], { trainerClass: 96 }), romTrainer(31, [mon(16)], { trainerClass: 95 })];
    const join = joinPkcalc([{ romIndex: 30, doc }, { romIndex: 31, doc, shared: true }], trainers,
      pkcalc({ 'Pokémon Trainer Dawn @ Lake Verity': ['Pidgey'], 'Pokémon Trainer Lucas @ Lake Verity': ['Pidgey'] }));
    expect([keyOf(join, 30), keyOf(join, 31)]).toEqual(['Pokémon Trainer Dawn @ Lake Verity', 'Pokémon Trainer Lucas @ Lake Verity']);
  });

  it('gives a key to the trainer whose party fits it before order decides', () => {
    // The docs call both Rangers Jeffrey; PKCalc names the Primeape one Allison.
    const matched: TrainerMatch[] = [{ romIndex: 96, doc: docTrainer('Pkmn Ranger Jeffrey') }, { romIndex: 95, doc: docTrainer('Pkmn Ranger Jeffrey') }];
    const join = joinPkcalc(matched, [romTrainer(96, [mon(57)]), romTrainer(95, [mon(59)])], pkcalc({ 'Pokémon Ranger Allison': ['Primeape'], 'Pokémon Ranger Jeffrey': ['Arcanine'] }));
    expect([join.joined.map((j) => [j.match.romIndex, j.key]), join.unjoined.map((match) => match.romIndex), join.unusedKeys])
      .toEqual([[[95, 'Pokémon Ranger Jeffrey']], [96], ['Pokémon Ranger Allison']]);
  });

  it('still joins by name a trainer whose party fits no key, so the party check can report it', () => {
    const join = joinPkcalc([{ romIndex: 1, doc: docTrainer('Youngster Tristan') }], [romTrainer(1, [mon(263), mon(161)])], pkcalc({ 'Youngster Tristan': ['Zigzagoon', 'Pidgey'] }));
    expect(join.joined.map((j) => j.key)).toEqual(['Youngster Tristan']);
  });
});

describe('diffPkcalc', () => {
  const tristanDoc = docTrainer('Youngster Tristan', [docMon('Zigzagoon', { nature: 'Hasty' }), docMon('Sentret', { nature: 'Docile' })]);
  const tristan = romTrainer(1, [mon(263, { nature: 11, item: 251, moves: [98, 28] }), mon(161, { nature: 6, item: 251, moves: [185, 33] })],
    { aiMask: 0x7, aiFlags: ['Basic', 'EvalAttack', 'Expert'] });
  /** Tristan's ROM party with the Sentret's nature unknown and its ability overridden. */
  const unknown = romTrainer(1, [tristan.party[0]!, { ...tristan.party[1]!, natureKnown: false, abilityOverride: 1 }], { aiMask: 0x7 });
  const ROM_SPECIES: SpeciesRecord[] = [];
  for (const [id, first, second] of [[263, 82, 0], [161, 50, 51], [16, 51, 0], [479, 26, 0]] as const) ROM_SPECIES[id] = romSpecies(id, { abilities: [first, second] });
  const set = (fields: Partial<PkcalcSet> = {}): PkcalcSet => ({
    ability: 'Gluttony', gender: 'Male', item: 'Silk Scarf', ivs: { hp: 31, at: 31, df: 31, sa: 31, sd: 31, sp: 31 }, level: 5, moves: ['Quick Attack', 'Sand Attack'], nature: 'Hasty', ...fields,
  });
  const sentret = (fields: Partial<PkcalcSet> = {}) => set({ ability: 'Run Away', moves: ['Feint Attack', 'Tackle'], nature: 'Docile', ...fields });
  const KEY = 'Youngster Tristan';
  const TRISTAN = 'Roark Split: Youngster Tristan';
  const at = (rom: number, slot: number) => `${TRISTAN} [ROM ${rom}] mon ${slot} (${slot === 1 ? 'Zigzagoon' : 'Sentret'})`;
  const agreeing = (): PkcalcData => pkcalc({ [KEY]: ['Zigzagoon', 'Sentret'] }, {
    aiFlags: { [KEY]: { ...NO_FLAGS, Basic: 1, EvaluateAttack: 1, Expert: 1 } }, sets: { Zigzagoon: { [KEY]: set() }, Sentret: { [KEY]: sentret() } },
  });
  const diffsOf = (data: PkcalcData, trainer = tristan, doc = tristanDoc, matched: TrainerMatch[] = [{ romIndex: trainer.index, doc }], trainers = [trainer]) => {
    const rom = { species: ROM_SPECIES, trainers };
    return diffPkcalc(joinPkcalc(matched, trainers, data), rom, data, names);
  };

  it('finds nothing where PKCalc agrees with the ROM, comparing moves by ID across spellings', () => expect(diffsOf(agreeing())).toEqual([]));

  it('reports a matched trainer that joins no PKCalc key, with its party', () =>
    expect(diffsOf(pkcalc({ 'Youngster Tyler': ['Zigzagoon', 'Sentret'] }))).toEqual([{ area: 'pkcalc-join', key: `${TRISTAN} [ROM 1]`, field: 'key', rom: ['Zigzagoon', 'Sentret'], docs: null }]));

  it('reports AI flags that differ from the ROM\'s mask', () => {
    const data = agreeing();
    data.aiFlags[KEY] = { ...NO_FLAGS, Basic: 1 };
    expect(diffsOf(data)).toEqual([{ area: 'pkcalc-ai', key: `${TRISTAN} [ROM 1]`, field: 'flags', rom: ['Basic', 'EvalAttack', 'Expert'], docs: ['Basic'] }]);
  });

  it('reports a party in another order, and accepts a bare species name for any form', () => {
    const data = agreeing();
    data.partyOrder[KEY] = ['Sentret', 'Zigzagoon'];
    expect(diffsOf(data)).toEqual([{ area: 'pkcalc-party-order', key: `${TRISTAN} [ROM 1]`, field: 'order', rom: ['Zigzagoon', 'Sentret'], docs: ['Sentret', 'Zigzagoon'] }]);
    const burmy = diffsOf(pkcalc({ [KEY]: ['Burmy'] }), romTrainer(1, [mon(412, { form: 1 })]), docTrainer(KEY));
    expect(burmy.filter((d) => d.area === 'pkcalc-party-order')).toEqual([]);
  });

  it('reports a set\'s level, moves, item and ability against the ROM, and a ROM Pokémon PKCalc has no set for', () => {
    const data = agreeing();
    data.sets.Zigzagoon![KEY] = set({ level: 6, moves: ['Sand Attack', 'Quick Attack'], item: undefined, ability: 'Levitate' });
    data.sets.Sentret![KEY] = sentret({ moves: ['Tackle', 'Gust'] });
    expect(diffsOf(data)).toEqual([
      { area: 'pkcalc-sets', key: at(1, 1), field: 'level', rom: 5, docs: 6 },
      { area: 'pkcalc-sets', key: at(1, 1), field: 'ability', rom: 'Gluttony', docs: 'Levitate' },
      { area: 'pkcalc-sets', key: at(1, 1), field: 'item', rom: 'Silk Scarf', docs: null },
      { area: 'pkcalc-sets', key: at(1, 1), field: 'move-order', rom: ['Quick Attack', 'Sand-Attack'], docs: ['Sand Attack', 'Quick Attack'] },
      { area: 'pkcalc-sets', key: at(1, 2), field: 'moves', rom: ['Faint Attack', 'Tackle'], docs: ['Tackle', 'Gust'] },
    ]);
    delete data.sets.Sentret;
    expect(diffsOf(data).at(-1)).toEqual({ area: 'pkcalc-sets', key: at(1, 2), field: 'set', rom: 'Sentret', docs: null });
  });

  it('compares the ROM\'s nature where it is known, else the docs\' cleaned as the planner cleans it', () => {
    const data = agreeing();
    data.sets.Zigzagoon![KEY] = set({ nature: 'Bold' });
    data.sets.Sentret![KEY] = sentret({ nature: 'Hardy' });
    const natures = (cell = 'Docile') => diffsOf(data, unknown, docTrainer(KEY, [docMon('Zigzagoon', { nature: 'Hasty' }), docMon('Sentret', { nature: cell })]))
      .filter((d) => d.field.startsWith('nature'));
    expect(natures()).toEqual([
      { area: 'pkcalc-sets', key: at(1, 1), field: 'nature', rom: 'Hasty', docs: 'Bold' },
      { area: 'pkcalc-sets', key: at(1, 2), field: 'nature-from-docs', rom: 'Docile', docs: 'Hardy' },
    ]);
    // "Lonely0" is Lonely; "X/Y" gives no nature, even where Y is PKCalc's.
    data.sets.Sentret![KEY] = sentret({ nature: 'Lonely' });
    expect(natures('Lonely0').slice(1)).toEqual([]);
    expect(natures('Careful/Lonely').slice(1)).toEqual([{ area: 'pkcalc-sets', key: at(1, 2), field: 'nature-from-docs', rom: null, docs: 'Lonely' }]);
  });

  it('tags a set difference "-other-copy" only where another ROM copy joined to the key has PKCalc\'s value', () => {
    const data = agreeing();
    // A shared copy of Tristan's team with another nature on the Zigzagoon and another item on the Sentret.
    const copy = romTrainer(2, [{ ...tristan.party[0]!, nature: 0 }, { ...tristan.party[1]!, item: 244 }], { aiMask: 0x7 });
    const diffs = () => diffsOf(data, tristan, tristanDoc, [{ romIndex: 1, doc: tristanDoc }, { romIndex: 2, doc: tristanDoc, shared: true }], [tristan, copy]);
    expect(diffs()).toEqual([
      { area: 'pkcalc-sets', key: at(2, 1), field: 'nature-other-copy', rom: 'Hardy', docs: 'Hasty' },
      { area: 'pkcalc-sets', key: at(2, 2), field: 'item-other-copy', rom: 'Sharp Beak', docs: 'Silk Scarf' },
    ]);
    // Where neither copy has PKCalc's value, each difference keeps its own field.
    data.sets.Zigzagoon![KEY] = set({ nature: 'Bold' });
    expect(diffs().filter((d) => d.key.endsWith('(Zigzagoon)')).map((d) => [d.key, d.field])).toEqual([[at(1, 1), 'nature'], [at(2, 1), 'nature']]);
  });

  it('pkcalcNatures gives each joined Pokémon its set\'s nature ID, a shared copy the same, and null where PKCalc has none', () => {
    const data = agreeing();
    data.sets.Sentret![KEY] = set({ nature: 'Jolly' });
    const copy = romTrainer(2, tristan.party, { aiMask: 0x7 });
    const natures = pkcalcNatures(joinPkcalc([{ romIndex: 1, doc: tristanDoc }, { romIndex: 2, doc: tristanDoc, shared: true }], [tristan, copy], data), [tristan, copy], data);
    expect([natures(1, 0), natures(1, 1), natures(2, 1), natures(1, 2), natures(9, 0)]).toEqual([11, 13, 13, null, null]);
    delete data.sets.Sentret;
    data.sets.Zigzagoon![KEY] = set({ nature: 'Mantine' });
    const missing = pkcalcNatures(joinPkcalc([{ romIndex: 1, doc: tristanDoc }], [tristan], data), [tristan], data);
    expect([missing(1, 0), missing(1, 1)]).toEqual([null, null]);
    const unjoined = pkcalc({ 'Youngster Tyler': ['Zigzagoon', 'Sentret'] });
    expect(pkcalcNatures(joinPkcalc([{ romIndex: 1, doc: tristanDoc }], [tristan], unjoined), [tristan], unjoined)(1, 0)).toBeNull();
  });
});

describe('diffBox', () => {
  const saveMon = (fields: Partial<SaveMon> = {}): SaveMon => ({
    location: { kind: 'box', box: 1, slot: 3 }, level: 12, status: { kind: 'none' }, pid: 0xaa3c919f, species: 412, form: 1, gender: 'M', nickname: 'BALLZ', exp: 0,
    friendship: 70, nature: 9, ability: 50, item: 0, moves: [33, 16], moveSlots: [33, 16, 0, 0], pp: [35, 35], ppUps: [0, 0], ivs: { hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6 },
    evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, isEgg: false, badChecksum: false, otId: 0, otGender: 0, otName: Array(8).fill(0xffff), language: 2, ...fields,
  });
  // PKCalc's import of saveMon(): its data.id holds the PID, then the IVs in the order hp, at, df, sa, sd, sp.
  const entry = (fields: Partial<PkcalcCustomSet> = {}): PkcalcCustomSet => ({
    ability: 'Run Away', level: 12, gender: 'Male', ivs: { hp: 1, at: 2, df: 3, sa: 4, sd: 5, sp: 6 }, moves: ['Tackle', 'Gust'], nature: 'Lax',
    data: { id: 'aa3c919f-010203040506-05', abilityIndex: 1, location: 'Route 202', dead: false }, ...fields,
  });

  it.each<[string, SaveMon[], Parameters<typeof diffBox>[1], string[]]>([
    ['nothing when PKCalc read the Pokémon the same way, a bare species name standing for any form', [saveMon()], { Burmy: { BALLZ: entry() } }, []],
    ['each field PKCalc read differently', [saveMon()], { Rotom: { BALLZ: entry({ level: 13, nature: 'Bold', ability: 'Keen Eye', item: 'Silk Scarf', moves: ['Tackle'] }) } }, [
      'box 1/3 BALLZ: species 412 form 1, PKCalc Rotom', 'box 1/3 BALLZ: level 12, PKCalc 13', 'box 1/3 BALLZ: nature Lax, PKCalc Bold',
      'box 1/3 BALLZ: ability 50, PKCalc Keen Eye', 'box 1/3 BALLZ: item 0, PKCalc Silk Scarf', 'box 1/3 BALLZ: moves 33,16, PKCalc Tackle']],
    ['the graveyard boxes against PKCalc\'s dead flag', [saveMon({ location: { kind: 'box', box: 15, slot: 3 } })], { Burmy: { BALLZ: entry() } }, ['box 15/3 BALLZ: dead false in PKCalc']],
    ['EVs only where PKCalc has them', [saveMon()], { Burmy: { BALLZ: entry({ evs: { hp: 4, at: 0, df: 0, sa: 0, sd: 0, sp: 0 } }) } },
      ['box 1/3 BALLZ: EVs {"hp":0,"atk":0,"def":0,"spa":0,"spd":0,"spe":0}, PKCalc {"hp":4,"at":0,"df":0,"sa":0,"sd":0,"sp":0}']],
    ['a Pokémon PKCalc lacks and an entry with no Pokémon, skipping eggs', [saveMon(), saveMon({ pid: 1, isEgg: true })],
      { Burmy: { Other: entry({ data: { id: '00000002-010203040506-05', abilityIndex: 0, dead: false } }) } }, [
        'box 1/3 BALLZ: no PKCalc entry with PID aa3c919f and these IVs', 'PKCalc entry Burmy "Other" (00000002-010203040506-05) matches no Pokémon in the save']],
  ])('lists %s', (_, mons, customsets, expected) => expect(diffBox(mons, customsets, dex)).toEqual(expected));
});

describe('downloadPkcalc and loadPkcalcGlobal', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pk-pkcalc-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const flags = (source: string) => {
    writeFileSync(join(dir, 'flags.js'), source);
    return () => loadPkcalcGlobal(join(dir, 'flags.js'), 'FLAGS_PK');
  };
  /** A fake fetch answering each data file with a script defining its global as `{ file: <path> }`, or `bad` for the global named `badName`. */
  const siteFetch = (badName = '', bad = ''): typeof fetch => async (input) => {
    const path = new URL(String(input)).pathname.slice(1);
    const name = Object.entries(PKCALC_FILES).find(([, file]) => file === path)?.[0];
    if (!name) throw new Error(`Not a PKCalc data file: ${String(input)}`);
    return new Response(name === badName ? bad : `const ${name} = { file: ${JSON.stringify(path)} };\n`);
  };

  it('saves each data file below the directory, then meta.json, and each file\'s global loads back', async () => {
    await downloadPkcalc(join(dir, 'pkcalc'), siteFetch());
    expect(JSON.parse(readFileSync(join(dir, 'pkcalc', 'meta.json'), 'utf8'))).toHaveProperty('fetchedAt');
    expect(loadPkcalcGlobal(join(dir, 'pkcalc', 'party_order.js'), 'PARTY_ORDER_PK')).toEqual({ file: 'js/data/party_order.js' });
    expect(loadPkcalcGlobal(join(dir, 'pkcalc', 'dex', 'moves.js'), 'MOVES')).toEqual({ file: 'js/data/dex/moves.js' });
  });

  it.each([
    ['does not define its global, such as a bot-wall page', 'SETDEX_PK', '<!doctype html><title>Checking your browser</title>', 'js/data/sets.js does not define SETDEX_PK'],
    ['defines its global with more than literal data', 'MOVES', 'const MOVES = { pound: fetch("https://example.com") };', 'js/data/dex/moves.js line 1: a CallExpression'],
  ])('downloadPkcalc writes nothing when a file %s', async (_, badName, bad, error) => {
    await expect(downloadPkcalc(join(dir, 'pkcalc'), siteFetch(badName, bad))).rejects.toThrow(error);
    expect(existsSync(join(dir, 'pkcalc')) ? readdirSync(join(dir, 'pkcalc')) : []).toEqual([]);
  });

  it('loadPkcalcGlobal reads the named global\'s literal, with quoted, unquoted and number keys, skipping the functions after it', () => {
    expect(flags([
      'const FLAGS_PK = {',
      '  // a comment',
      '  battleType: { double: [{ enemy1: "Cyclist Axel", enemy2: `Cyclist John` }] },',
      '  "Youngster Tristan": { Basic: 1 },',
      '  odd: [-1, 2.5, true, false, null, \'quoted\'],',
      '  7: "a number key",',
      '};',
      'function getDoubleBattle(trainerName) {',
      '  return Object.values(FLAGS_PK.battleType.double).find((battle) => battle.enemy1 == trainerName);',
      '}',
    ].join('\n'))()).toEqual({
      battleType: { double: [{ enemy1: 'Cyclist Axel', enemy2: 'Cyclist John' }] }, 'Youngster Tristan': { Basic: 1 }, odd: [-1, 2.5, true, false, null, 'quoted'], 7: 'a number key',
    });
  });

  // The files come from a third-party site, so they are never run: `this.constructor.constructor('return process')()`
  // reaches Node's own `process` from inside a `node:vm` context.
  it.each([
    ['a function call', 'const FLAGS_PK = { battleType: (() => ({ double: [] }))() };', 'line 1: a CallExpression'],
    ['this.constructor', 'const FLAGS_PK = {\n  host: this.constructor.constructor("return process")(),\n};', 'line 2: a CallExpression'],
    ['a variable', 'const OTHER = 1;\nconst FLAGS_PK = { other: OTHER };', 'line 2: an Identifier'],
    ['a template with a placeholder', 'const FLAGS_PK = { name: `${"x"}` };', 'line 1: a TemplateLiteral with placeholders'],
    ['a getter', 'const FLAGS_PK = { get name() { return 1; } };', 'line 1: a getter, setter, method, shorthand or computed key'],
    ['a spread', 'const FLAGS_PK = { ...{} };', 'line 1: a SpreadElement'],
    ['a __proto__ key', 'const FLAGS_PK = { __proto__: { polluted: true } };', 'line 1: a __proto__ key'],
    ['no top-level const of that name', 'var FLAGS_PK = {};\nfunction f() { const FLAGS_PK = {}; }', 'has no top-level const FLAGS_PK'],
  ])('loadPkcalcGlobal refuses %s, running nothing', (_, source, where) => expect(flags(source)).toThrow(`${join(dir, 'flags.js')} ${where}`));
});
