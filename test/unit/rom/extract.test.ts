import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractAiData } from '../../../src/ai/rom/aiData.js';
import { DOC_TABS } from '../../../src/docs/fetchDocs.js';
import { RomError } from '../../../src/errors.js';
import { extractRomData } from '../../../src/rom/extract.js';
import { buildNarc } from '../../fixtures/buildNarc.js';
import { buildNds } from '../../fixtures/buildNds.js';
import { hex, moveBytes, personalBytes } from '../../fixtures/romRecords.js';
import { withAiData } from '../ai/aiRomFixture.js';

const PERSONAL = 'poketool/personal/pl_personal.narc';
const MOVES = 'poketool/waza/pl_waza_tbl.narc';
const GROWTH = 'poketool/personal/pl_growtbl.narc';
const TRDATA = 'poketool/trainer/trdata.narc';
const TRPOKE = 'poketool/trainer/trpoke.narc';
const ITEM_DATA = 'itemtool/itemdata/pl_item_data.narc';

/** An item-data entry (`ItemData`, pokeplatinum include/item.h:56-77) with fling power at byte 6: 36 bytes, or 34 as some are. */
function itemEntry(flingPower: number, size = 36): Uint8Array {
  const entry = new Uint8Array(size);
  entry[6] = flingPower;
  return entry;
}

/** 446 item-data entries of fling power 30 but entry 0 (none, 0), 92 (Nugget, 250), 113 (Adamant Orb, item 135, 60) and 428 (Bicycle, item 450, 150). Entry 1 is 34 bytes. */
const itemEntries = (count = 446) => Array.from({ length: count }, (_, entry) => itemEntry(new Map([[0, 0], [92, 250], [113, 60], [428, 150]]).get(entry) ?? 30, entry === 1 ? 34 : 36));

// Youngster Tristan (trainer 1), read from the real ROM: the same bytes as trainers.test.ts.
const tristanHeader = hex('03 02 00 03 00 00 00 00 00 00 00 00 07 00 00 00 00 00 00 00');
const tristanParty = hex(`
  ff 00 05 00 07 01 fb 00 62 00 1c 00 00 00 00 00 00 00
  ff 00 05 00 a1 00 fb 00 62 00 1c 00 00 00 00 00 00 00
  ff 00 05 00 10 00 f4 00 bd 00 10 00 62 00 1c 00 00 00`);

/** A 404-byte growth record whose level `l` needs `rate * 1000 + l` experience, so every row is distinct (little-endian, as Node runs). */
const growthRecord = (rate: number) => new Uint8Array(Uint32Array.from({ length: 101 }, (_, level) => rate * 1000 + level).buffer);

// A JAK7 ROM of Monferno, its learnset, Water Ball, 8 growth rates and the items; an empty trainer 0 keeps Tristan at
// his real index 1, which his PIDs depend on. `replace` swaps in other bytes for any path.
function minimalRom(replace: Record<string, Uint8Array> = {}): Uint8Array {
  return buildNds({
    [PERSONAL]: buildNarc([personalBytes({ stats: [64, 78, 52, 81, 78, 52], types: [10, 1], genderRatio: 31, friendship: 70, growth: 3, abilities: [66, 66] })]),
    'poketool/personal/wotbl.narc': buildNarc([hex('a5 03 53 02 02 02 42 0e 34 12 ff ff')]),
    [MOVES]: buildNarc([moveBytes({ cat: 1, power: 100, type: 11, acc: 100, pp: 15, flags: 0x72 })]),
    [GROWTH]: buildNarc(Array.from({ length: 8 }, (_, rate) => growthRecord(rate))),
    [TRDATA]: buildNarc([new Uint8Array(20), tristanHeader]),
    [TRPOKE]: buildNarc([new Uint8Array(0), tristanParty]),
    [ITEM_DATA]: buildNarc(itemEntries()),
    ...replace,
  });
}

describe('extractRomData', () => {
  it("assembles RomData from minimal NARCs, each item's fling power from the entry the cartridge reads", () => {
    const data = extractRomData(minimalRom());
    expect(data).toMatchObject({ schemaVersion: 5, gameCode: 'JAK7' });
    expect(data.species).toEqual([
      { id: 0, baseStats: { hp: 64, atk: 78, def: 52, spa: 78, spd: 52, spe: 81 }, types: [10, 1], genderRatio: 31, baseFriendship: 70, baseExp: 0, evYield: 0, growthRate: 3, abilities: [66, 66] }]);
    expect(data.learnsets).toEqual([[{ move: 421, level: 1 }, { move: 83, level: 1 }, { move: 2, level: 1 }, { move: 66, level: 7 }, { move: 52, level: 9 }]]);
    expect(data.moves).toEqual([{ id: 0, effect: 0, category: 'special', power: 100, type: 11, accuracy: 100, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 0x72 }]);
    expect(data.growth.map((row) => row.length)).toEqual(Array(8).fill(101));
    expect([data.growth[0]![0], data.growth[3]![15], data.growth[7]![100]]).toEqual([0, 3015, 7100]);
    expect(data.trainers.map((t) => [t.index, t.party.length])).toEqual([[0, 0], [1, 3]]);
    expect(data.trainers[1]).toMatchObject({ trainerClass: 2, aiFlags: ['Basic', 'EvalAttack', 'Expert'], items: [] });
    // Natures 11, 6, 18 (Hasty, Docile, Bashful) are the docs' values, which need Tristan's real index.
    expect(data.trainers[1]!.party.map((m) => [m.species, m.level, m.nature, m.item, m.moves])).toEqual([
      [263, 5, 11, 251, [98, 28]], [161, 5, 6, 251, [98, 28]], [16, 5, 18, 244, [189, 16, 98, 28]]]);
    // `Item_FileID` (pokeplatinum src/item.c:49-57): items 0-112 read their own entry, 113-134 entry 0, 135-467 their number less 22.
    const { items } = data;
    expect([items.length, items.every((item, id) => item.id === id)]).toEqual([468, true]);
    expect([0, 1, 92, 112, 113, 134, 135, 450, 467].map((id) => [id, items[id]!.flingPower])).toEqual([
      [0, 0], [1, 30], [92, 250], [112, 30], [113, 0], [134, 0], [135, 60], [450, 150], [467, 30]]);
  });

  type Case = [string, () => Uint8Array, string, string];
  const oddEntry = () => Object.assign(itemEntries(), { 5: itemEntry(30, 40) });
  // Record sizes are checked before decoding, in both directions.
  const badSize = (path: string, size: number, expected: number): Case =>
    [`a ${path} record of ${size} bytes`, () => minimalRom({ [path]: buildNarc([new Uint8Array(size), new Uint8Array(expected)]) }), 'BAD_FORMAT', `${path} record 0 is ${size} bytes, not ${expected}`];
  it.each<Case>([
    ['a CPUE ROM', () => buildNds({}, 'CPUE'), 'WRONG_ROM', 'CPUE'],
    ['a missing file, naming the path', () => buildNds({}), 'MISSING_FILE', PERSONAL],
    ['item data without the 446 entries the item ID map reads', () => minimalRom({ [ITEM_DATA]: buildNarc(itemEntries(445)) }), 'BAD_FORMAT', `${ITEM_DATA} has 445 entries, not 446`],
    ["an item-data entry the battle's 36-byte stride would misread", () => minimalRom({ [ITEM_DATA]: buildNarc(oddEntry()) }), 'BAD_FORMAT', `${ITEM_DATA} entry 5 is 40 bytes, not 34 or 36`],
    badSize(PERSONAL, 43, 44), badSize(MOVES, 20, 16), badSize(GROWTH, 400, 404), badSize(TRDATA, 24, 20),
    ['trpoke and trdata of different counts', () => minimalRom({ [TRPOKE]: buildNarc([new Uint8Array(0)]) }), 'BAD_FORMAT', `${TRPOKE} and ${TRDATA} differ in record count (1 and 2)`],
    ['a decoder failure, naming the file and record', () => minimalRom({ [TRPOKE]: buildNarc([new Uint8Array(0), tristanParty.subarray(0, 36)]) }), 'BAD_FORMAT',
      `${TRPOKE} record 1: Trainer 1 has 36 party bytes`],
    ['a cut-short NARC (a RangeError below), naming the file', () => minimalRom({ [MOVES]: buildNarc([moveBytes({})]).subarray(0, 20) }), 'BAD_FORMAT', MOVES],
    ['a cut-short file system', () => minimalRom().subarray(0, 0x200), 'BAD_FORMAT', 'file system'],
  ])('throws a RomError for %s', (_, rom, code, message) => {
    const extract = () => extractRomData(rom());
    expect(extract).toThrow(RomError);
    expect(extract).toThrow(expect.objectContaining({ code, message: expect.stringContaining(message) }));
  });
});

describe('npm run extract', { timeout: 60_000 }, () => {
  const tsx = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
  const cli = fileURLToPath(new URL('../../../src/cli/extract.ts', import.meta.url));
  const fakeDocsFetch = new URL('../../fixtures/fakeDocsFetch.ts', import.meta.url).href;
  /** minimalRom plus the trainer AI's data, which the extract also decodes. */
  const aiRom = () => withAiData(minimalRom);
  const COUNTS = '1 species, 1 moves, 2 trainers\n';
  const USAGE = 'Usage: npm run extract -- --rom <path>';

  /** Runs the CLI, fetch faked by `fakeDocsFetch.ts`, in a fresh directory of `rom.nds` and `files`; returns its output and what it wrote (null if missing). */
  function runCli(rom: Uint8Array, args: string[], { files = {}, env = {} }: { files?: Record<string, string>; env?: Record<string, string> } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'pk-extract-'));
    const read = (path: string) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : null);
    try {
      writeFileSync(join(dir, 'rom.nds'), rom);
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      const run = spawnSync(process.execPath, [tsx, '--import', fakeDocsFetch, cli, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
      const docs = join(dir, 'data', 'docs');
      return {
        status: run.status, stdout: run.stdout, stderr: run.stderr, json: read('data/rom/romdata.json'), aiJson: read('data/rom/trainer-ai.json'),
        docs: existsSync(docs) ? Object.fromEntries(readdirSync(docs).map((name) => [name, readFileSync(join(docs, name), 'utf8')])) : null,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('writes data/rom/romdata.json, trainer-ai.json and the docs tabs, creating the directories, and prints the counts', () => {
    const run = runCli(aiRom(), ['--rom', 'rom.nds']);
    expect(run).toMatchObject({ status: 0, stdout: `${COUNTS}18 docs tabs saved in data/docs\n`, stderr: '' });
    expect(JSON.parse(run.json!)).toEqual(extractRomData(aiRom()));
    expect(JSON.parse(run.aiJson!)).toEqual(extractAiData(aiRom()));
    expect(Object.keys(run.docs!).sort()).toEqual([...DOC_TABS.map((tab) => `${tab}.csv`), 'meta.json'].sort());
    // The fake answered, not the real sheet.
    expect(run.docs!['Level-Up Learnsets.csv']).toBe('ID Number,Name,Move,Level\r\n0,Level-Up Learnsets,,\r\n');
  });

  // Errors the user can fix print one line, with no stack trace; none saves the docs.
  it.each<[string, () => Uint8Array, string[], Parameters<typeof runCli>[2], object]>([
    ['the wrong ROM, writing nothing', () => buildNds({}, 'CPUE'), ['--rom', 'rom.nds'], {}, { stdout: '', stderr: expect.stringContaining('WRONG_ROM'), json: null }],
    ['no --rom', aiRom, [], {}, { stderr: `${USAGE}\n`, json: null }],
    ['an unknown flag', aiRom, ['--rom', 'rom.nds', '--bogus'], {}, { stdout: '', stderr: `Unknown option '--bogus'. ${USAGE}\n`, json: null }],
    ['a missing ROM file', aiRom, ['--rom', 'missing.nds'], {}, { stdout: '', stderr: "Cannot extract missing.nds: ENOENT: no such file or directory, open 'missing.nds'\n", json: null }],
    ['output that cannot be written', aiRom, ['--rom', 'rom.nds'], { files: { data: 'a file where the data directory should be' } },
      { stdout: '', stderr: "Cannot extract rom.nds: ENOTDIR: not a directory, mkdir 'data/rom'\n" }],
    ['docs that are not CSV', aiRom, ['--rom', 'rom.nds'], { env: { FAKE_DOCS: 'html' } },
      { stdout: COUNTS, stderr: 'Cannot download the docs: "Personal" tab returned an HTML page instead of CSV (NOT_CSV)\n' }],
    ['a docs tab that cannot be parsed', aiRom, ['--rom', 'rom.nds'], { env: { FAKE_DOCS: 'bad-format' } },
      { stdout: COUNTS, stderr: 'Cannot download the docs: "Personal" tab cannot be parsed: The Personal tab has no "Attack" column (BAD_FORMAT)\n' }],
  ])('prints one line and exits 1 for %s', (_, rom, args, opts, expected) => {
    const run = runCli(rom(), args, opts);
    expect(run).toMatchObject({ status: 1, ...expected });
    expect(run.docs ?? {}).toEqual({});
  });
});
