import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PKCALC_FILES, type PkcalcGlobal, pkcalcFile } from '../../../src/check/pkcalc.js';
import { DOC_TABS } from '../../../src/docs/fetchDocs.js';
import { type RomData, ROM_SCHEMA_VERSION } from '../../../src/rom/extract.js';
import type { MoveRecord, Stats } from '../../../src/rom/types.js';
import { buildSave, type TestMon } from '../../fixtures/buildSave.js';
import { fakeTabCsv } from '../../fixtures/fakeDocsTabs.js';
import { romSpecies, romTrainer, stats, trainerMon } from '../../fixtures/loadedData.js';

// A small `data/` and save for `npm run sheet`: Youngster Tristan, Lass Natalie (made a double battle), Monferno and Chingling.

/** Species: ID, docs name, base stats, ROM types, ROM abilities. */
const SPECIES: [number, string, Stats, [number, number], [number, number]][] = [
  [16, 'PIDGEY', stats(40, 45, 40, 35, 35, 56), [0, 2], [77, 77]],
  [161, 'SENTRET', stats(35, 46, 34, 35, 45, 20), [0, 0], [91, 91]],
  [191, 'SUNKERN', stats(30, 30, 30, 30, 30, 30), [12, 12], [94, 94]],
  [261, 'POOCHYENA', stats(35, 55, 35, 30, 30, 35), [17, 17], [95, 95]],
  [263, 'ZIGZAGOON', stats(38, 30, 41, 30, 41, 60), [0, 0], [82, 82]],
  [391, 'MONFERNO', stats(64, 78, 52, 78, 52, 81), [10, 1], [66, 66]],
  [396, 'STARLY', stats(40, 55, 30, 30, 30, 60), [0, 2], [51, 51]],
  [433, 'CHINGLING', stats(45, 30, 50, 65, 50, 45), [14, 14], [26, 26]],
];
const personalRow = ([id, name, s]: (typeof SPECIES)[number]) =>
  `${id},${name},${s.hp},${s.atk},${s.def},${s.spa},${s.spd},${s.spe},0,Normal,Normal,45,50,None,None,127,20,70,Medium Fast,Field,Field,-,-,0,0`;

/** Moves: the ROM record and the docs row's name and effect text. Tackle's ROM accuracy is 95 here, to show a miss chance. */
const MOVE_ROWS: [MoveRecord, string, string][] = [
  [{ id: 2, effect: 43, category: 'physical', power: 50, type: 1, accuracy: 100, pp: 25, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Karate Chop', 'High crit ratio'],
  [{ id: 10, effect: 0, category: 'physical', power: 40, type: 0, accuracy: 100, pp: 35, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Scratch', 'None'],
  [{ id: 28, effect: 23, category: 'status', power: 0, type: 4, accuracy: 100, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 18 }, 'Sand Attack', 'Lowers Accuracy (Status)'],
  [{ id: 33, effect: 0, category: 'physical', power: 35, type: 0, accuracy: 95, pp: 35, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Tackle', 'None'],
  [{ id: 35, effect: 42, category: 'physical', power: 15, type: 0, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 115 }, 'Wrap', 'Whirlpool effect'],
  [{ id: 45, effect: 18, category: 'status', power: 0, type: 0, accuracy: 100, pp: 40, effectChance: 0, target: 4, priority: 0, flags: 86 }, 'Growl', 'Lowers Atk (Status)'],
  [{ id: 52, effect: 4, category: 'special', power: 40, type: 10, accuracy: 100, pp: 25, effectChance: 10, target: 0, priority: 0, flags: 82 }, 'Ember', 'Chance to Burn'],
  [{ id: 98, effect: 103, category: 'physical', power: 40, type: 0, accuracy: 100, pp: 30, effectChance: 0, target: 0, priority: 1, flags: 115 }, 'Quick Attack', 'Priority +1'],
  [{ id: 290, effect: 197, category: 'physical', power: 70, type: 0, accuracy: 100, pp: 20, effectChance: 30, target: 0, priority: 0, flags: 114 }, 'Secret Power', 'Secret Power effect'],
];
const CATEGORY = { physical: 'Physical', special: 'Special', status: 'Status' } as const;
const moveRow = ([m, name, effect]: (typeof MOVE_ROWS)[number]) =>
  `${m.id},${name},${effect},${CATEGORY[m.category]},${m.power},Normal,${m.accuracy},${m.pp},${m.effectChance},One opponent,${m.priority},FALSE,TRUE,FALSE,FALSE,TRUE,FALSE,FALSE,FALSE,0,0`;

// Every docs tab as the fake fetch serves it (a header and a skipped row 0), with the species, moves and Roark Split here.
const DOCS: Record<string, string> = {
  ...Object.fromEntries(DOC_TABS.map((tab) => [`docs/${tab}.csv`, fakeTabCsv(tab)])),
  'docs/Personal.csv': `${fakeTabCsv('Personal')}${SPECIES.map(personalRow).join('\r\n')}\r\n`,
  'docs/Moves.csv': `${fakeTabCsv('Moves')}${MOVE_ROWS.map(moveRow).join('\r\n')}\r\n`,
  'docs/Roark Split.csv': readFileSync(new URL('../../fixtures/roarkSplitExcerpt.csv', import.meta.url), 'utf8'),
};

// Growth rate 3 (medium slow) for Monferno, as in the ROM; every other species uses rate 0 (n³). Tristan's Zigzagoon
// is Hasty in the ROM, as in the docs; his Sentret is Hardy against the docs' Docile, so disputed.
const mediumSlow = (n: number) => Math.max(0, Math.floor((6 * n ** 3) / 5) - 15 * n ** 2 + 100 * n - 140);
const TRISTAN_PARTY = [trainerMon(263, 5, { nature: 11, item: 251, moves: [33, 28] }), trainerMon(161, 5, { moves: [33] }), trainerMon(16, 5, { moves: [33] })];
const NATALIE = romTrainer(2, [trainerMon(191, 6), trainerMon(396, 6), trainerMon(261, 6)], { battleType: 2 });
const ROM: RomData = {
  schemaVersion: ROM_SCHEMA_VERSION, gameCode: 'JAK7', learnsets: [], items: [],
  species: Array.from({ length: 494 }, (_, id) => {
    const known = SPECIES.find(([sid]) => sid === id);
    return romSpecies(id, known ? { baseStats: known[2], types: known[3], abilities: known[4], growthRate: id === 391 ? 3 : 0 } : {});
  }),
  moves: MOVE_ROWS.map(([record]) => record),
  growth: Array.from({ length: 8 }, (_, rate) => Array.from({ length: 101 }, (_, n) => (rate === 3 ? mediumSlow(n) : n ** 3))),
  trainers: [romTrainer(1, TRISTAN_PARTY), NATALIE],
};

// The Monferno of readSave.test.ts (Impish) on 10 of its 44 HP, where Blaze would be on, holding a Quick Claw.
const MONFERNO: TestMon = {
  pid: 0x2939ae6a, species: 391, nickname: 'Mon', exp: 2449, level: 15, ability: 66, item: 217, moves: [10, 52, 2, 290],
  ivs: { hp: 0, atk: 26, def: 12, spe: 24, spa: 10, spd: 7 },
};
const CHINGLING: TestMon = { pid: 0x8f31c2d4, species: 433, nickname: 'Ching', exp: 100, level: 4, ability: 26, moves: [35, 45] };
const SAVE = buildSave({ party: [{ ...MONFERNO, currentHp: 10 }, { ...CHINGLING, currentHp: 17 }], boxes: [] });

const tsx = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../../../src/cli/sheet.ts', import.meta.url));
const USAGE = 'Usage: npm run sheet -- --save <path> --trainer <id or search text> [--cap N] [--variant N] [--hp full|save]';
const TRISTAN = ['--save', 'save.dsv', '--trainer', 'Youngster Tristan'];

/** Runs the CLI in a fresh directory holding `data/` (`rom` as its ROM data, `extra` files by path) and `save.dsv`. */
function runSheet(args: string[], rom: RomData = ROM, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pk-sheet-'));
  try {
    for (const [path, text] of Object.entries({ 'rom/romdata.json': JSON.stringify(rom), ...DOCS, ...extra })) {
      mkdirSync(dirname(join(dir, 'data', path)), { recursive: true });
      writeFileSync(join(dir, 'data', path), text);
    }
    writeFileSync(join(dir, 'save.dsv'), SAVE);
    const run = spawnSync(process.execPath, [tsx, cli, ...args], { cwd: dir, encoding: 'utf8' });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('npm run sheet', { timeout: 60_000 }, () => {
  it('prints the trainer, a line per pair, move lines both ways and the notes, at full HP by default', () => {
    const run = runSheet(TRISTAN);
    expect(run).toMatchObject({ status: 0, stderr: '' });
    expect(run.stdout).toMatch(/^Youngster Tristan \(roark-split\/youngster-tristan\/1\): Roark Split, Route 202, single battle/);
    // Zigzagoon: level 5, IVs 31, Hasty, so Speed 13; Monferno's is 32. Ember is the calc's 22-27, Blaze off at full HP.
    for (const line of ['  Mon (Monferno) Lv 15 vs Zigzagoon Lv 5: Mon moves first (Spe 32 vs 13)\n', 'Mon (Monferno) Lv 15 HP 44/44 (save 10/44)',
      '      Ember  22-27 (110-135%)  OHKO 100%  crit 45-54  hit 100%\n', '  Ching (Chingling) Lv 4 vs Pidgey Lv 5: ']) expect(run.stdout).toContain(line);
    for (const line of [/^ {6}Tackle {2}\d+-\d+ \([\d.]+-[\d.]+%\) {2}.* {2}hit 95% \(inaccurate\)$/m, /^ {6}Sand Attack {2}status {2}hit 100%$/m,
      /Quick Claw \(Mon\)/, /Sentret's nature \(Hardy, from the ROM\) is disputed/, /^Nature alternatives: all \(no PKCalc data\)$/m,
      /^Starting HP: full, as planning assumes \(--hp save for the save's\)$/m]) expect(run.stdout).toMatch(line);
  });

  it("--hp save uses the save's HP", () => {
    const run = runSheet([...TRISTAN, '--hp', 'save']);
    expect(run).toMatchObject({ status: 0, stderr: '' });
    expect(run.stdout).toMatch(/^Starting HP: the save's \(--hp save\)$/m);
    expect(run.stdout).toContain('Mon (Monferno) Lv 15 HP 10/44');
    expect(Number(run.stdout.match(/^ {6}Ember {2}\d+-(\d+) /m)?.[1])).toBeGreaterThan(27); // Blaze on at 10 of 44 HP
  });

  it('prints a double battle with the note "can\'t be built yet", taking nature alternatives from saved PKCalc data', () => {
    // PKCalc's files as the real checks save them, each an empty literal (read, never run).
    const pkcalc = Object.fromEntries([
      ...(Object.keys(PKCALC_FILES) as PkcalcGlobal[]).map((name) => [pkcalcFile('pkcalc', name), `const ${name} = {};\n`]),
      ['pkcalc/meta.json', JSON.stringify({ fetchedAt: '2026-11-08T00:00:00.000Z' })],
    ]);
    const run = runSheet(['--save', 'save.dsv', '--trainer', 'natalie'], ROM, pkcalc);
    expect(run).toMatchObject({ status: 0, stderr: '' });
    expect(run.stdout).toMatch(/^Lass Natalie \(roark-split\/lass-natalie\/1\): Roark Split, Route 202, double battle/);
    for (const line of [/can't be built yet/, /^Nature alternatives: PKCalc$/m, /^ {2}Mon \(Monferno\) Lv 15 vs Sunkern Lv 6: /m]) expect(run.stdout).toMatch(line);
  });

  // Errors the user can fix print one line, with no stack trace.
  const unknownMove = { ...ROM, trainers: [romTrainer(1, [trainerMon(263, 5, { nature: 11, item: 251, moves: [33, 500] }), ...TRISTAN_PARTY.slice(1)]), NATALIE] };
  it.each<[string, string[], RomData, Record<string, string>, unknown]>([
    ['no --trainer', ['--save', 'save.dsv'], ROM, {}, `${USAGE}\n`],
    ['--hp other than full or save', ['--save', 'save.dsv', '--trainer', 'tristan', '--hp', 'half'], ROM, {}, `--hp must be full or save. ${USAGE}\n`],
    ['a variant the trainer lacks', ['--save', 'save.dsv', '--trainer', 'tristan', '--variant', '1'], ROM, {},
      `--variant must be from 0 to 0: Youngster Tristan has 1 ROM copy. ${USAGE}\n`],
    ['unknown trainer text, listing the closest matches', ['--save', 'save.dsv', '--trainer', 'Youngster Tristen'], ROM, {},
      'No trainer matches "Youngster Tristen". Closest: Youngster Tristan (roark-split/youngster-tristan/1), Lass Natalie (roark-split/lass-natalie/1)\n'],
    ['a trainer move the move table lacks', TRISTAN, unknownMove, {}, 'Cannot build the sheet: Zigzagoon has move 500, which the move table lacks\n'],
    ['saved PKCalc data that cannot be read (meta.json, no files)', TRISTAN, ROM, { 'pkcalc/meta.json': '{"fetchedAt":"2026-11-08T00:00:00.000Z"}' },
      expect.stringMatching(/^PKCalc data unreadable: [^\n]*; delete [^\n]*pkcalc or save it again with npm run record:diffs\n$/)],
  ])('%s prints one line and exits 1', (_, args, rom, extra, stderr) =>
    expect(runSheet(args, rom, extra)).toEqual({ status: 1, stdout: '', stderr }));
});
