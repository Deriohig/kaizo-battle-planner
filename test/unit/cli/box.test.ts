import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PKCALC_FILES, type PkcalcGlobal, pkcalcFile } from '../../../src/check/pkcalc.js';
import { loadLocalData, MissingDataError, natureAlternatives } from '../../../src/data/load.js';
import { RomError } from '../../../src/errors.js';
import { ROM_SCHEMA_VERSION, type RomData } from '../../../src/rom/extract.js';
import type { SpeciesRecord } from '../../../src/rom/types.js';
import { buildSave, type TestMon } from '../../fixtures/buildSave.js';

// Docs rows as the official docs' CSV export has them (the same headers as tables.test.ts).
const PERSONAL_HEADER = `ID Number,Name,HP,Attack,Defense,Sp. Atk,Sp. Def,Speed,BST,Type 1,Type 2,Catch Rate,Exp Drop,Uncommon Held Item,Rare Held Item,Gender Ratio,Hatch Multiplier,Base Happiness,Growth Rate,Egg Group 1,Egg Group 2,Ability 1,Ability 2,Safari Zone Run Chance,DO NOT TOUCH`;
const MOVES_HEADER = `ID Number,Name,Additional Effect,Category,Power,Type,Accuracy,PP,Additional Effect Chance (%),Target(s),Priority,Contact Move,Blocked by Protect,Reflected by Magic Coat,Affected by Snatch,Affected by Mirror Move,Triggers Kings Rock,Hide HP Bars,Remove Target's Shadow,Contest Effect,Contest Type`;
const LEARNSET_HEADER = `ID Number,Name,${Array(21).fill('Move,Level').join(',')}`;

/** The export ends lines with CRLF. */
const csv = (...lines: string[]) => `${lines.join('\r\n')}\r\n`;

const PERSONAL_TAB = csv(
  PERSONAL_HEADER,
  `0,-----,0,0,0,0,0,0,0,Normal,Normal,0,0,None,None,0,0,0,Medium Fast,~,~,-,-,0,0`,
  `175,TOGEPI,35,20,65,40,65,20,245,Normal,Normal,91,74,None,None,31,10,70,Fast,Undiscovered,Undiscovered,Serene Grace,Serene Grace,0,8`,
  `391,MONFERNO,64,78,52,78,52,81,405,Fire,Fighting,59,142,None,None,31,20,70,Medium Slow,Field,Human-Like,Blaze,Blaze,0,133`,
  `433,CHINGLING,45,30,50,65,50,45,285,Psychic,Psychic,156,74,None,None,127,25,70,Fast,Undiscovered,Undiscovered,Levitate,-,0,2`,
);
const MOVES_TAB = csv(
  MOVES_HEADER,
  `0,-,None,Physical,0,Normal,0,0,0,One opponent,0,FALSE,FALSE,FALSE,FALSE,FALSE,FALSE,FALSE,FALSE,0,0`,
  `2,Karate Chop,High crit ratio,Physical,50,Fighting,100,25,0,One opponent,0,TRUE,TRUE,FALSE,FALSE,TRUE,TRUE,TRUE,FALSE,5,4`,
  `10,Scratch,None,Physical,40,Normal,100,35,0,One opponent,0,TRUE,TRUE,FALSE,FALSE,TRUE,TRUE,TRUE,FALSE,5,4`,
  `35,Wrap,Whirlpool effect,Physical,15,Normal,100,20,0,One opponent,0,TRUE,TRUE,FALSE,FALSE,TRUE,TRUE,FALSE,FALSE,21,4`,
  `45,Growl,Lowers Atk (Status),Status,0,Normal,100,40,0,Both opponents,0,FALSE,TRUE,TRUE,FALSE,TRUE,FALSE,TRUE,FALSE,19,2`,
  `52,Ember,Chance to Burn,Special,40,Fire,100,25,10,One opponent,0,FALSE,TRUE,FALSE,FALSE,TRUE,FALSE,TRUE,FALSE,5,1`,
  `290,Secret Power,Secret Power effect,Physical,85,Normal,100,20,30,One opponent,0,FALSE,TRUE,FALSE,FALSE,TRUE,FALSE,FALSE,FALSE,14,3`,
);
const LEARNSETS_TAB = csv(
  LEARNSET_HEADER,
  `0,-----${','.repeat(42)}`,
  `433,CHINGLING,Confusion,1,Wrap,6,Uproar,9,Heal Bell,14,Psybeam,17,Recover,22${','.repeat(30)}`,
);
// The AI Changes tab is one quoted cell (cut short here), with its quotes doubled as CSV does.
const AI_CHANGES_TAB = '"PLATINUM KAIZO AI CHANGES:\n\n-Dry Skin AI Bug fixed\n-""Triple Axel"" and ""Fury Cutter"" both use the Vanilla Triple Kick effect."\r\n';
const AI_CHANGES_TEXT = 'PLATINUM KAIZO AI CHANGES:\n\n-Dry Skin AI Bug fixed\n-"Triple Axel" and "Fury Cutter" both use the Vanilla Triple Kick effect.';
const ROARK_TAB = readFileSync(new URL('../../fixtures/roarkSplitExcerpt.csv', import.meta.url), 'utf8');

const SPLIT_TABS = ['Roark Split', 'Gardenia Split', 'Fantina Split', 'Maylene Split', 'Wake Split', 'Byron Split',
  'Candice Split', 'Volkner Split', 'Galactic Split', 'Elite Four Split'];

/** The docs files the box reads. Split tabs hold only their title row, except Roark's and the Elite Four's (the excerpt). */
const DOCS: Record<string, string> = {
  'docs/Personal.csv': PERSONAL_TAB,
  'docs/Moves.csv': MOVES_TAB,
  'docs/Level-Up Learnsets.csv': LEARNSETS_TAB,
  'docs/AI Changes.csv': AI_CHANGES_TAB,
  ...Object.fromEntries(SPLIT_TABS.map((tab) => [`docs/${tab}.csv`, csv(`,,,,  PLATINUM KAIZO - ${tab.toUpperCase()}${','.repeat(12)}`)])),
  'docs/Roark Split.csv': ROARK_TAB,
  'docs/Elite Four Split.csv': ROARK_TAB,
};

// Growth rate 3 (medium slow) for Monferno, as in the ROM; every other species uses rate 0 (n³), so 100 experience
// is level 4, 125 is level 5 and 8 is level 2.
const mediumSlow = (n: number) => Math.max(0, Math.floor((6 * n ** 3) / 5) - 15 * n ** 2 + 100 * n - 140);
const ROM: RomData = {
  schemaVersion: ROM_SCHEMA_VERSION,
  gameCode: 'JAK7',
  species: Array.from({ length: 494 }, (_, id): SpeciesRecord => ({
    id, baseStats: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, types: [0, 0], genderRatio: 0, baseFriendship: 70, baseExp: 0, evYield: 0, growthRate: id === 391 ? 3 : 0, abilities: [0, 0],
  })),
  learnsets: [],
  moves: [],
  growth: Array.from({ length: 8 }, (_, rate) => Array.from({ length: 101 }, (_, n) => (rate === 3 ? mediumSlow(n) : n ** 3))),
  trainers: [],
  items: [],
};

/** Writes `romdata.json` and the docs tabs into the `data` directory at `dir`, leaving out the paths in `omit`. */
function writeDataDir(dir: string, omit: string[] = []): void {
  mkdirSync(join(dir, 'rom'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  for (const [path, text] of Object.entries({ 'rom/romdata.json': JSON.stringify(ROM), ...DOCS })) {
    if (!omit.includes(path)) writeFileSync(join(dir, path), text);
  }
}

// PID 0x2939ae6a gives nature 8 (Impish), 0x8f31c2d4 3 (Adamant), 0x5e9a0c11 12 (Serious), 0x12345678 21 (Gentle).
const MONFERNO: TestMon = {
  pid: 0x2939ae6a, species: 391, nickname: 'Mon', exp: 2449, level: 15, ability: 66, item: 217, moves: [10, 52, 2, 290],
  ivs: { hp: 0, atk: 26, def: 12, spe: 24, spa: 10, spd: 7 },
};
const CHINGLING: TestMon = { pid: 0x8f31c2d4, species: 433, nickname: 'Ching', exp: 100, level: 4, ability: 26, moves: [35, 45] };
const EGG: TestMon = { pid: 0x5e9a0c11, species: 175, nickname: 'Egg', exp: 125, ability: 32, moves: [45], isEgg: true };
// The docs above lack species 1 and move 999.
const UNKNOWN: TestMon = { pid: 0x12345678, species: 1, nickname: 'Odd', exp: 8, ability: 65, moves: [999] };

// Party Pokémon need a current HP: left out, it is 0, which is fainted. 'Down' is the fainted one.
const SAVE = buildSave({
  party: [{ ...MONFERNO, currentHp: 30 }, { ...CHINGLING, status: 2, currentHp: 18 }, { ...MONFERNO, corrupt: true }, { ...CHINGLING, nickname: 'Down', currentHp: 0 }],
  boxes: [
    { ...CHINGLING, box: 1, slot: 1 },
    { ...EGG, box: 2, slot: 3 },
    { ...CHINGLING, box: 3, slot: 4, corrupt: true },
    { ...UNKNOWN, box: 4, slot: 1 },
    { ...MONFERNO, box: 15, slot: 2 },
  ],
});

const HINT = 'run npm run extract -- --rom <path>';

describe('loadLocalData', () => {
  let dir = '';
  let data = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pk-load-'));
    data = join(dir, 'data');
    writeDataDir(data);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const romFile = () => join(data, 'rom', 'romdata.json');

  it('loads the ROM data, the docs tabs and the name index', () => {
    const { rom, names, docs } = loadLocalData(data);
    expect(rom).toEqual(ROM);
    expect(docs.species.map((s) => [s.id, s.name])).toEqual([[175, 'TOGEPI'], [391, 'MONFERNO'], [433, 'CHINGLING']]);
    expect(docs.moves.map((m) => m.name)).toEqual(['Karate Chop', 'Scratch', 'Wrap', 'Growl', 'Ember', 'Secret Power']);
    expect(docs.learnsets.get(433)).toHaveLength(6);
    expect(docs.learnsets.get(433)?.at(-1)).toEqual({ move: 'Recover', level: 22 });
    const roark = ['Youngster Tristan', 'Lass Natalie', 'Bug Catcher Logan'];
    expect(docs.trainers.map((t) => [t.split, t.name])).toEqual(['Roark Split', 'Elite Four Split'].flatMap((split) => roark.map((name) => [split, name])));
    expect(docs.aiChangesText).toBe(AI_CHANGES_TEXT);
    expect([names.species(391), names.move(290), names.item(217), names.ability(66)]).toEqual(['Monferno', 'Secret Power', 'Quick Claw', 'Blaze']);
  });

  // PKCalc's files as `downloadPkcalc` saves them, cut down to one set; each is read, never run.
  const PKCALC_SETS = { Zigzagoon: { 'Youngster Tristan': { ability: 'Gluttony', gender: 'Male', ivs: {}, level: 5, moves: ['Tackle'], nature: 'Jolly' } } };
  function writePkcalcDir(): void {
    for (const name of Object.keys(PKCALC_FILES) as PkcalcGlobal[]) {
      const file = pkcalcFile(join(data, 'pkcalc'), name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `const ${name} = ${name === 'SETDEX_PK' ? JSON.stringify(PKCALC_SETS) : '{}'};\n`);
    }
    writeFileSync(join(data, 'pkcalc', 'meta.json'), JSON.stringify({ fetchedAt: '2026-11-08T00:00:00.000Z' }));
  }

  it("loads PKCalc's saved data where the real checks saved it, and docs natures take their alternatives from it, else all", () => {
    expect([loadLocalData(data).pkcalc, natureAlternatives(loadLocalData(data))]).toEqual([undefined, 'all']);
    writePkcalcDir();
    expect([loadLocalData(data).pkcalc?.sets, natureAlternatives(loadLocalData(data))]).toEqual([PKCALC_SETS, 'pkcalc']);
  });

  it('throws one line naming the file for a saved PKCalc file it cannot read', () => {
    writePkcalcDir();
    const sets = pkcalcFile(join(data, 'pkcalc'), 'SETDEX_PK');
    writeFileSync(sets, 'const SETDEX_PK = fetch("https://example.com");\n');
    expect(() => loadLocalData(data)).toThrow(`PKCalc data unreadable: ${sets} line 1: a CallExpression is not literal data`);
    expect(() => loadLocalData(data)).toThrow(/^[^\n]*$/);
  });

  it('throws MissingDataError naming each missing file', () => {
    for (const file of ['rom/romdata.json', 'docs/Galactic Split.csv']) rmSync(join(data, file));
    expect(() => loadLocalData(data)).toThrow(MissingDataError);
    expect(() => loadLocalData(data)).toThrow(`Missing ${romFile()}, ${join(data, 'docs', 'Galactic Split.csv')}`);
  });

  // A romdata.json from an older extract holds another shape of RomData. The engine stands in vanilla growth tables only
  // for data that has none at all, so the loader refuses ROM data without all eight of pl_growtbl.narc's tables.
  const outOfDate = (found: string) => `out of date: has ${found}, but the planner reads version ${ROM_SCHEMA_VERSION}`;
  const incomplete = 'incomplete: lacks the 8 growth tables of 101 levels (pl_growtbl.narc)';
  it.each<[string, unknown, string]>([
    ['no schema version', { ...ROM, schemaVersion: undefined }, outOfDate('no schema version')],
    ['another schema version', { ...ROM, schemaVersion: 0 }, outOfDate('schema version 0')],
    ['version 1, from before the item data', { ...ROM, schemaVersion: 1 }, outOfDate('schema version 1')],
    ['version 2, from before the base friendship', { ...ROM, schemaVersion: 2 }, outOfDate('schema version 2')],
    ['a JSON value that is not an object', null, outOfDate('no schema version')],
    ['no growth tables', { ...ROM, growth: [] }, incomplete],
    ['no growth field', { ...ROM, growth: undefined }, incomplete],
    ['seven growth tables', { ...ROM, growth: ROM.growth.slice(0, 7) }, incomplete],
    ['a growth table one level short', { ...ROM, growth: ROM.growth.map((table, rate) => (rate === 3 ? table.slice(0, 100) : table)) }, incomplete],
    ['a growth value that is not a whole number', { ...ROM, growth: ROM.growth.map((table, rate) => (rate === 5 ? [...table.slice(0, 100), 1.5] : table)) }, incomplete],
  ])('throws a one-line RomError with the extract hint for ROM data with %s', (_, rom, problem) => {
    writeFileSync(romFile(), JSON.stringify(rom));
    const [what, detail] = problem.split(': ');
    expect(() => loadLocalData(data)).toThrow(RomError);
    expect(() => loadLocalData(data)).toThrow(new RomError('BAD_FORMAT', `ROM data ${what}: ${romFile()} ${detail}; ${HINT} to extract it again`));
  });
});

describe('npm run box', { timeout: 60_000 }, () => {
  const tsx = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
  const cli = fileURLToPath(new URL('../../../src/cli/box.ts', import.meta.url));
  const USAGE = 'Usage: npm run box -- --save <path> [--cap N]';
  const SAVE_ARGS = ['--save', 'save.dsv'];

  /** Runs the CLI in a fresh directory: `data/` (less `omit`, with `replace` over it), the save and a 16-byte `short.dsv`. */
  function runBox(args: string[], { omit = [], replace = {} }: { omit?: string[]; replace?: Record<string, string> } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'pk-box-'));
    try {
      writeDataDir(join(dir, 'data'), omit);
      for (const [path, text] of Object.entries(replace)) writeFileSync(join(dir, 'data', path), text);
      writeFileSync(join(dir, 'save.dsv'), SAVE);
      writeFileSync(join(dir, 'short.dsv'), new Uint8Array(16));
      const run = spawnSync(process.execPath, [tsx, cli, ...args], { cwd: dir, encoding: 'utf8' });
      return { status: run.status, stdout: run.stdout, stderr: run.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("prints each Pokémon's names, status and flags, and only the location for a bad checksum", () =>
    expect(runBox([...SAVE_ARGS, '--cap', '10'])).toEqual({
      status: 0,
      stderr: '',
      stdout: [
        'party 1  Mon (Monferno) Lv 15  Impish  Blaze  @Quick Claw  Scratch/Ember/Karate Chop/Secret Power  IVs 0/26/12/10/7/24  [over cap]',
        'party 2  Ching (Chingling) Lv 4  Adamant  SLP2  Levitate  Wrap/Growl  IVs 0/0/0/0/0/0',
        'party 3  [bad checksum]',
        'party 4  Down (Chingling) Lv 4  Adamant  Levitate  Wrap/Growl  IVs 0/0/0/0/0/0  [fainted]',
        'box 1 slot 1  Ching (Chingling) Lv 4  Adamant  Levitate  Wrap/Growl  IVs 0/0/0/0/0/0',
        'box 2 slot 3  Egg (Togepi) Lv 5  Serious  Serene Grace  Growl  IVs 0/0/0/0/0/0  [egg]',
        'box 3 slot 4  [bad checksum]',
        'box 4 slot 1  Odd (species 1) Lv 2  Gentle  Overgrow  (move 999)  IVs 0/0/0/0/0/0',
        'box 15 slot 2  Mon (Monferno) Lv 15  Impish  Blaze  @Quick Claw  Scratch/Ember/Karate Chop/Secret Power  IVs 0/26/12/10/7/24  [dead] [over cap]',
        '',
      ].join('\n'),
    }));

  // Errors the user can fix print one line, with no stack trace, and exit 1.
  type Case = [string, string[], { omit?: string[]; replace?: Record<string, string> }, string];
  it.each<Case>([
    ...['rom/romdata.json', 'docs/Galactic Split.csv'].map((file): Case => [`${file} missing`, SAVE_ARGS, { omit: [file] }, 'Run npm run extract -- --rom <path> first']),
    ['a table tab it cannot parse', SAVE_ARGS, { replace: { 'docs/Personal.csv': 'ID Number,Name,HP\r\n1,BULBASAUR,45\r\n' } },
      `docs cache unreadable: Personal: The Personal tab has no "Attack" column; ${HINT} to download it again`],
    ['a CSV cut short', SAVE_ARGS, { replace: { 'docs/AI Changes.csv': '"PLATINUM KAIZO AI CHANGES:\n\n-Dry Skin' } },
      `docs cache unreadable: AI Changes: Quote Not Closed: the parsing is finished with an opening quote at line 3; ${HINT} to download it again`],
    ['ROM data it cannot parse', SAVE_ARGS, { replace: { 'rom/romdata.json': '{"gameCode":"JAK7","species":[' } },
      `ROM data unreadable: ${join('data', 'rom', 'romdata.json')}: Unexpected end of JSON input; ${HINT} to extract it again`],
    ['a missing save file', ['--save', 'missing.dsv'], {}, "Cannot read missing.dsv: ENOENT: no such file or directory, open 'missing.dsv'"],
    ['a file that is not a save', ['--save', 'short.dsv'], {},
      'Cannot read short.dsv: A save is 524288 bytes, optionally followed by a DeSmuME footer; this file is 16 bytes (BAD_SIZE)'],
    ['no --save', [], {}, USAGE],
    ...['0', '101', '15.5', 'ten'].map((cap): Case => [`--cap ${cap}`, [...SAVE_ARGS, '--cap', cap], {}, `--cap must be a level from 1 to 100. ${USAGE}`]),
  ])('prints one line and exits 1 for %s', (_, args, data, message) =>
    expect(runBox(args, data)).toEqual({ status: 1, stdout: '', stderr: `${message}\n` }));
});
