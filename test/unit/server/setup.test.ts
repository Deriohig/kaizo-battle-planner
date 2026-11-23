import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeAiData } from '../../../src/ai/rom/aiData.js';
import { MissingDataError } from '../../../src/data/load.js';
import { DocsError } from '../../../src/docs/fetchDocs.js';
import type { RomData } from '../../../src/rom/extract.js';
import type { SetupJson } from '../../../src/server/apiTypes.js';
import { checkRom, createExtractor, defaultRoots, describeSave, type Extractor, findSaveCandidates, SAVE_FILE_NAME } from '../../../src/server/setup.js';
import type { ServerDeps } from '../../../src/server/state.js';
import { readSse } from '../../../web/src/sse.js';
import { buildNds } from '../../fixtures/buildNds.js';
import { SERVER_SAVE, saveFile, serverData, starly } from './fixtures.js';
import { closeServers, type Harness, removeLater, start } from './harness.js';

// The extract's AI step keeps its default wiring; the mock writes a small trainer-ai.json in place of decoding a ROM.
vi.mock('../../../src/ai/rom/aiData.js', async (importOriginal) => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  return {
    ...await importOriginal<typeof import('../../../src/ai/rom/aiData.js')>(),
    writeAiData: vi.fn((_rom: Uint8Array, dir: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'trainer-ai.json'), '{}\n');
    }),
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeServers();
});

const WRONG_ROM = (code: string) => `Not Platinum Kaizo (Nightmare Update): game code ${code}; expected JAK7 (plat-kaizo-nightmare-update-final.nds)`;
const HACK_SAVE = 'plat-kaizo-nightmare-update-final.dsv';
const DOCS = 'Downloading the docs (18 tabs, about 2 minutes)…';
const PROGRESS = ['Decoding the ROM…', '2 species, 4 moves, 3 trainers', DOCS, 'Loading the data…'];
const READY = { state: 'ready', message: null, trainers: 3 };
const SUMMARY = 'Party: Mon (Monferno) Lv 15, Starly Lv 14 · 1 badge · 2 in the boxes';
const docsFailed = () => new DocsError('HTTP', 'Personal', '"Personal" tab could not be fetched: fetch failed');
const DOCS_FAILED = 'Cannot download the docs: "Personal" tab could not be fetched: fetch failed (HTTP)';

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-setup-test-'));
  removeLater(dir);
  return dir;
}

/** Writes `bytes` to `<dir>/<rel>`, creating the folders, and gives the full path. */
function put(dir: string, rel: string, bytes: Uint8Array = new Uint8Array(4)): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

const sorted = (paths: string[]) => [...paths].sort();

it('checkRom reads only the header: JAK7 passes, another game code is named, a missing file or a folder is no file', async () => {
  const dir = tempDir();
  expect(await checkRom(put(dir, 'x.nds', buildNds({}, 'JAK7')))).toBeNull();
  expect(await checkRom(put(dir, 'header.nds', buildNds({}, 'JAK7').subarray(0, 0x200)))).toBeNull();
  expect(await checkRom(put(dir, 'vanilla.nds', buildNds({}, 'CPUE')))).toBe(WRONG_ROM('CPUE'));
  for (const file of [path.join(dir, 'absent.nds'), dir]) expect(await checkRom(file)).toBe(`No file at ${file}`);
});

describe('findSaveCandidates', () => {
  /** The ROM with its saves in Emulators/Battery, DeSmuME's Battery in Downloads, other files, and Battery folders at and past the depth limit. */
  function layout() {
    const t = tempDir();
    const [desktop, downloads] = [path.join(t, 'Desktop'), path.join(t, 'Downloads')];
    const rom = put(desktop, 'Games/Emulators/Roms/x.nds');
    const emulators = put(desktop, 'Games/Emulators/Battery/x.dsv');
    put(desktop, 'Games/Emulators/Battery/y.dsv');
    const desmume = put(downloads, 'desmume-0.9.13-win64/Battery/x.dsv');
    put(downloads, 'desmume-0.9.13-win64/Battery/y.dsv');
    put(downloads, 'desmume-0.9.13-win64/Battery/notes.txt');
    const atLimit = put(downloads, 'a/b/c/Battery/x.dsv');        // the file 5 levels below the root
    put(downloads, 'a/b/c/d/Battery/x.dsv');                      // 6 levels: past maxDepth 4
    return { t, desktop, downloads, rom, emulators, desmume, atLimit };
  }

  it('finds the ROM\'s Battery saves and Battery folders under the roots, only for the ROM\'s name, up to maxDepth, each once', async () => {
    const l = layout();
    const want = sorted([l.emulators, l.desmume, l.atLimit]);
    expect(sorted(await findSaveCandidates({ romPath: l.rom, savePath: null, roots: [l.downloads], maxDepth: 4 }))).toEqual(want);
    expect(sorted(await findSaveCandidates({ romPath: l.rom, savePath: l.desmume, roots: [l.desktop, l.downloads], maxDepth: 4 }))).toEqual(want);
  });

  it('without a ROM path takes only the hack\'s save name, in any case: another game\'s save is never offered', async () => {
    const l = layout();
    const hack = put(l.downloads, `desmume-0.9.13-win64/Battery/${HACK_SAVE}`);
    const shouted = put(l.desktop, `Games/Emulators/Battery/${HACK_SAVE.toUpperCase()}`);
    expect(sorted(await findSaveCandidates({ romPath: null, savePath: null, roots: [l.desktop, l.downloads], maxDepth: 4 }))).toEqual(sorted([hack, shouted]));
    expect(SAVE_FILE_NAME).toBe(HACK_SAVE);
  });

  it('always lists the current savePath first, whatever it is called', async () => {
    const l = layout();
    const custom = put(l.t, 'elsewhere/my-run.sav');
    expect(await findSaveCandidates({ romPath: l.rom, savePath: custom, roots: [], maxDepth: 4 })).toEqual([custom, l.emulators]);
  });

  it('looks in <romDir>/Battery and <romDir>/../Battery in any case, and skips a root it cannot read', async () => {
    const t = tempDir();
    const rom = put(t, 'emu/roms/Game.nds');
    const inside = put(t, 'emu/roms/battery/game.DSV');
    const beside = put(t, 'emu/BATTERY/Game.dsv');
    put(t, 'emu/BATTERY/Other.dsv');
    expect(sorted(await findSaveCandidates({ romPath: rom, savePath: null, roots: [path.join(t, 'nope')], maxDepth: 4 }))).toEqual(sorted([inside, beside]));
    expect(await findSaveCandidates({ romPath: path.join(t, 'gone', 'x.nds'), savePath: null, roots: [], maxDepth: 4 })).toEqual([]);
  });

  it('never follows a symlink, to a folder or to a file', async () => {
    const t = tempDir();
    const root = path.join(t, 'Downloads');
    put(t, `outside/Battery/${HACK_SAVE}`);
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(path.join(t, 'outside'), path.join(root, 'link'));
    fs.symlinkSync(path.join(t, 'outside', 'Battery'), path.join(root, 'Battery'));
    const real = put(root, `emu/Battery/${HACK_SAVE}`);
    fs.symlinkSync(real, path.join(root, 'emu', 'Battery', HACK_SAVE.toUpperCase()));
    expect(await findSaveCandidates({ romPath: null, savePath: null, roots: [root], maxDepth: 4 })).toEqual([real]);
  });
});

it('defaultRoots gives each user\'s Desktop, Downloads and Documents that exist, skipping the system profiles; none without the folder', () => {
  const users = tempDir();
  for (const rel of ['User/Desktop', 'User/Downloads', 'User/Documents', 'Sam/Desktop', 'Public/Desktop', 'Default/Desktop', 'Default User/Desktop', 'All Users/Desktop']) {
    fs.mkdirSync(path.join(users, rel), { recursive: true });
  }
  fs.writeFileSync(path.join(users, 'desktop.ini'), '');
  fs.writeFileSync(path.join(users, 'Sam', 'Downloads'), 'a file, not a folder');
  expect(defaultRoots(users)).toEqual(['Sam/Desktop', 'User/Desktop', 'User/Downloads', 'User/Documents'].map((rel) => path.join(users, rel)));
  expect(defaultRoots(path.join(users, 'Users'))).toEqual([]);
});

describe('describeSave', () => {
  const MTIME = '2026-06-12T18:30:00.000Z';
  const writeSave = (bytes: Uint8Array) => {
    const file = put(tempDir(), 'Battery/x.dsv', bytes);
    fs.utimesSync(file, new Date(MTIME), new Date(MTIME));
    return file;
  };
  const NOT_A_SAVE = /^A save is \d+ bytes, optionally followed by a DeSmuME footer; this file is 10 bytes$/;

  it('summarises the party, badges (singular or plural) and box count, with the ISO mtime and size', async () => {
    const bytes = saveFile();
    const file = writeSave(bytes);
    expect(await describeSave(file, serverData())).toEqual({ path: file, modifiedAt: MTIME, sizeBytes: bytes.length, summary: SUMMARY, error: null });
    const more = writeSave(saveFile({ ...SERVER_SAVE, badgeMask: 0b1011, boxes: [SERVER_SAVE.boxes![0]!] }));
    expect((await describeSave(more, serverData())).summary).toBe('Party: Mon (Monferno) Lv 15, Starly Lv 14 · 3 badges · 1 in the boxes');
    const unnamed = writeSave(saveFile({ ...SERVER_SAVE, party: [starly({ species: 25, nickname: 'Pika' })] }));   // a species the data cannot name
    expect((await describeSave(unnamed, serverData())).summary).toMatch(/^Party: Pika \(species 25\) Lv 14 · /);
  });

  it('gives the SaveError for a file that is not a save; without the data, no summary; a missing file is no file', async () => {
    const bad = writeSave(new Uint8Array(10));
    expect(await describeSave(bad, serverData())).toEqual({ path: bad, modifiedAt: MTIME, sizeBytes: 10, summary: null, error: expect.stringMatching(NOT_A_SAVE) });
    expect(await describeSave(bad, null)).toMatchObject({ summary: null, error: expect.stringMatching(NOT_A_SAVE) });
    expect(await describeSave(writeSave(saveFile()), null)).toMatchObject({ summary: null, error: null });
    const gone = path.join(tempDir(), 'gone.dsv');
    expect(await describeSave(gone, serverData())).toEqual({ path: gone, modifiedAt: new Date(0).toISOString(), sizeBytes: 0, summary: null, error: `No file at ${gone}` });
  });
});

it('createExtractor writes nothing until the docs are downloaded, then romdata.json and trainer-ai.json; a failed download leaves no rom/', async () => {
  const ROM = new Uint8Array([1, 2, 3, 4]);
  const DECODED = { species: [{}, {}], moves: [{}, {}, {}, {}], trainers: [{}, {}, {}] } as unknown as RomData;
  const folder = () => {
    const dataDir = path.join(tempDir(), 'data');
    const romDir = path.join(dataDir, 'rom');
    const files = () => ['romdata.json', 'trainer-ai.json'].filter((f) => fs.existsSync(path.join(romDir, f)));
    return { dataDir, romDir, files };
  };
  const extract = (dataDir: string, downloadDocs: (docsDir: string) => Promise<void>, progress: string[]) =>
    createExtractor({ readRom: async () => ROM, decodeRom: () => DECODED, downloadDocs })('/roms/x.nds', dataDir, (m) => { progress.push(m); });
  vi.mocked(writeAiData).mockClear();

  const ok = folder();
  const docsDirs: string[] = [];
  const during: string[][] = [];
  const progress: string[] = [];
  await extract(ok.dataDir, async (docsDir) => { docsDirs.push(docsDir); during.push(ok.files()); }, progress);
  expect([docsDirs, during, ok.files(), progress]).toEqual([[path.join(ok.dataDir, 'docs')], [[]], ['romdata.json', 'trainer-ai.json'], PROGRESS]);
  expect(vi.mocked(writeAiData).mock.calls).toEqual([[ROM, ok.romDir]]);

  const failed = folder();
  const error = docsFailed();
  const failedProgress: string[] = [];
  await expect(extract(failed.dataDir, async () => { throw error; }, failedProgress)).rejects.toBe(error);
  expect([fs.existsSync(failed.romDir), failedProgress]).toEqual([false, PROGRESS.slice(0, 3)]);
});

describe('the setup routes', () => {
  /** The fixture data once an extract has written `<dir>/rom/romdata.json`; missing before. */
  const extractedData = (dir: string) => {
    if (!fs.existsSync(path.join(dir, 'rom', 'romdata.json'))) throw new MissingDataError('Missing data/rom/romdata.json');
    return serverData();
  };
  /** An extractor that writes the files `extractedData` looks for, reporting as the real one does. */
  const writeData: Extractor = async (_romPath, dataDir, onProgress) => {
    onProgress('Decoding the ROM…');
    put(dataDir, 'rom/romdata.json', new TextEncoder().encode(JSON.stringify(serverData().rom)));
    onProgress('2 species, 4 moves, 4 trainers');
    onProgress(DOCS);
    put(dataDir, 'docs/meta.json', new TextEncoder().encode('{}'));
    onProgress('Loading the data…');
  };

  /** `POST /api/setup/extract`; for an event stream, `events` fills as they arrive and `done` settles at its end. */
  async function postExtract(h: Harness, body: unknown, signal?: AbortSignal) {
    const res = await fetch(`${h.url}/api/setup/extract`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const events: { event: string; data: unknown }[] = [];
    const done = res.headers.get('content-type')?.startsWith('text/event-stream')
      ? readSse(res.body!, (e) => events.push({ event: e.event, data: JSON.parse(e.data) as unknown }))
      : Promise.resolve();
    return { res, events, done };
  }
  const get = async (h: Harness, route: string) => {
    const res = await fetch(`${h.url}${route}`);
    return { status: res.status, body: (await res.json()) as SetupJson };
  };
  const startEmpty = (deps: Partial<ServerDeps> = {}) => start({ deps: { loadData: extractedData, saveRoots: [], ...deps } });
  const romIn = (h: Harness) => put(h.dir, 'Roms/x.nds', buildNds({}, 'JAK7'));
  /** An extract that reports `first`, then waits for `open()` before going on as `then` does. */
  function gated(first: string, then: Extractor) {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => { open = resolve; });
    const extract: Extractor = async (romPath, dataDir, onProgress) => {
      onProgress(first);
      await wait;
      await then(romPath, dataDir, onProgress);
    };
    return { extract, open: () => open() };
  }

  it('GET /api/setup describes the candidates from the save roots and the current save, newest first', async () => {
    const root = path.join(tempDir(), 'Downloads');
    const newer = put(root, `desmume-0.9.13-win64/Battery/${HACK_SAVE}`, saveFile());
    fs.utimesSync(newer, new Date('2026-06-12T12:00:00Z'), new Date('2026-06-12T12:00:00Z'));
    const h = await start({ settings: (savePath) => ({ savePath }), deps: { saveRoots: [root] } });
    fs.utimesSync(h.savePath, new Date('2026-05-23T12:00:00Z'), new Date('2026-05-23T12:00:00Z'));
    const { status, body } = await get(h, '/api/setup');
    expect([status, body.data, body.savePath]).toEqual([200, READY, h.savePath]);
    expect(body.saveCandidates.map((c) => [c.path, c.modifiedAt, c.summary, c.error])).toEqual([
      [newer, '2026-06-12T12:00:00.000Z', SUMMARY, null], [h.savePath, '2026-05-23T12:00:00.000Z', SUMMARY, null],
    ]);
  });

  it('from no data, streams the progress then done with the data ready; the pasted ROM path is cleaned and saved', async () => {
    const calls: [string, string][] = [];
    const h = await startEmpty({ extract: async (romPath, dataDir, onProgress) => { calls.push([romPath, dataDir]); await writeData(romPath, dataDir, onProgress); } });
    const rom = romIn(h);
    expect(await get(h, '/api/setup')).toEqual({
      status: 200, body: { data: { state: 'missing', message: null, trainers: null }, romPath: null, savePath: null, saveCandidates: [] },
    });
    expect((await get(h, '/api/trainers')).status).toBe(409);
    const { res, events, done } = await postExtract(h, { romPath: `  "${rom}"  ` });
    expect([res.status, res.headers.get('content-type')]).toEqual([200, 'text/event-stream; charset=utf-8']);
    await done;
    expect(calls).toEqual([[rom, path.join(h.dir, 'data')]]);
    expect(events).toEqual([
      ...['Decoding the ROM…', '2 species, 4 moves, 4 trainers', DOCS, 'Loading the data…'].map((message) => ({ event: 'progress', data: { message } })),
      { event: 'done', data: { data: READY, romPath: rom, savePath: null, saveCandidates: [] } },
    ]);
    expect([h.state.settings().romPath, JSON.parse(fs.readFileSync(h.settingsFile, 'utf8')).romPath]).toEqual([rom, rom]);
    expect((await get(h, '/api/trainers')).body).toHaveLength(3);
  });

  it('shows the extract as running; a second one gives 409; it keeps running when the page goes away and loads the data', async () => {
    const gate = gated('Decoding the ROM…', writeData);
    const h = await startEmpty({ extract: gate.extract });
    const rom = romIn(h);
    const controller = new AbortController();
    const first = await postExtract(h, { romPath: rom }, controller.signal);
    await vi.waitFor(() => expect(first.events).toHaveLength(1));
    expect((await get(h, '/api/setup')).body.data).toEqual({ state: 'extracting', message: 'Decoding the ROM…', trainers: null });
    const second = await postExtract(h, { romPath: rom });
    expect([second.res.status, await second.res.json()]).toEqual([409, { error: 'An extract is already running; wait for it to finish' }]);
    controller.abort();
    await first.done.catch(() => undefined);
    gate.open();
    await vi.waitFor(() => expect(h.state.dataStatus()).toEqual(READY));
    expect(h.state.settings().romPath).toBe(rom);
  });

  it('a bad ROM, or a body without a ROM path, gives 400 and starts nothing', async () => {
    const extract = vi.fn<Extractor>(async () => undefined);
    const h = await startEmpty({ extract });
    const vanilla = put(h.dir, 'Roms/vanilla.nds', buildNds({}, 'CPUE'));
    const absent = path.join(h.dir, 'Roms', 'absent.nds');
    const required = 'romPath is required: the path to the ROM';
    for (const [body, error] of [
      [{ romPath: vanilla }, WRONG_ROM('CPUE')], [{ romPath: absent }, `No file at ${absent}`],
      [{}, required], [{ romPath: 3 }, required], [{ romPath: '  ' }, required], [[], required],
    ] as const) {
      const { res } = await postExtract(h, body);
      expect([body, res.status, await res.json()]).toEqual([body, 400, { error }]);
    }
    expect([extract.mock.calls.length, h.state.dataStatus().state, h.state.settings().romPath]).toEqual([0, 'missing', null]);
  });

  it('a failed extract (a docs error, or no data at the end) sends error, sets dataStatus error, saves no ROM path; a retry can run', async () => {
    let attempt = 0;
    const h = await startEmpty({ extract: async (romPath, dataDir, onProgress) => {
      onProgress(DOCS);
      if (++attempt === 1) throw docsFailed();
      if (attempt === 3) await writeData(romPath, dataDir, () => undefined);
    } });
    const rom = romIn(h);
    for (const message of [DOCS_FAILED, 'The extract finished, but the data is still missing']) {
      const failed = await postExtract(h, { romPath: rom });
      await failed.done;
      expect(failed.events).toEqual([{ event: 'progress', data: { message: DOCS } }, { event: 'error', data: { error: message } }]);
      const error = { state: 'error', message, trainers: null };
      expect([h.state.dataStatus(), (await get(h, '/api/setup')).body.data, h.state.settings().romPath]).toEqual([error, error, null]);
    }
    const retry = await postExtract(h, { romPath: rom });
    await retry.done;
    expect([retry.res.status, retry.events.at(-1)?.event, h.state.dataStatus()]).toEqual([200, 'done', READY]);
  });

  it('a re-extract that fails with the old data loaded keeps the trainer count, while it runs and after', async () => {
    const gate = gated(DOCS, async () => { throw docsFailed(); });
    const h = await start({ settings: (savePath) => ({ savePath }), deps: { saveRoots: [], extract: gate.extract } });
    const failed = await postExtract(h, { romPath: romIn(h) });
    await vi.waitFor(() => expect(failed.events).toHaveLength(1));
    expect((await get(h, '/api/setup')).body.data).toEqual({ state: 'extracting', message: DOCS, trainers: 3 });
    gate.open();
    await failed.done;
    expect(failed.events.at(-1)).toEqual({ event: 'error', data: { error: DOCS_FAILED } });
    const { status, body } = await get(h, '/api/setup');
    expect([status, body.data, body.savePath]).toEqual([200, { state: 'error', message: DOCS_FAILED, trainers: 3 }, h.savePath]);
    expect((await get(h, '/api/trainers')).status).toBe(200);              // the data from before still serves
  });
});
