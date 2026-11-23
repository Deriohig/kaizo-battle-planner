// First-run setup (contract in `src/contracts/api.ts`): the ROM check, the save copies to choose from, and the extract.
// - `GET /api/setup` gives the data status, the ROM and save paths, and every save copy found, described, newest first.
// - `POST /api/setup/extract` checks the ROM's game code, then streams the extract as server-sent events: `progress`
//   ({ message }) lines, then `done` (SetupJson) or `error` ({ error }). One extract runs at a time.
//
// The save copies are searched for on disk (`findSaveCandidates`): DeSmuME writes `<rom name>.dsv` into a `Battery`
// folder, beside the ROM's folder or under DeSmuME's own folder. The search walks Windows folders over drvfs, so it
// never follows a symlink (a Windows junction shows as one) and stops at a set depth.

import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { writeAiData } from '../ai/rom/aiData.js';
import type { LocalData } from '../data/load.js';
import { DOC_TABS, DocsError, downloadDocs, oneLineMessage as oneLine, writeWhole } from '../docs/fetchDocs.js';
import { RomError } from '../errors.js';
import { readGameCode } from '../nds/ndsFs.js';
import { extractRomData, type RomData } from '../rom/extract.js';
import { readSave, SaveError, type SaveMon } from '../save/readSave.js';
import type { SaveCandidateJson, SetupJson } from './apiTypes.js';
import { HttpError, readJsonBody, sendJson } from './http.js';
import { readTrainerInfo } from './saveInfo.js';
import { isRecord, toLinuxPath } from './settings.js';
import { openSse } from './sse.js';
import type { SpriteEnsurer } from './sprites.js';
import type { ServerState } from './state.js';

export const ROM_GAME_CODE = 'JAK7';
export const ROM_FILE_NAME = 'plat-kaizo-nightmare-update-final.nds';
/** The name DeSmuME gives the hack's save (the ROM's base name with `.dsv`): what counts as a save copy without a ROM path. */
export const SAVE_FILE_NAME = 'plat-kaizo-nightmare-update-final.dsv';
/** How far below a save root `findSaveCandidates` looks for a `Battery` folder. */
export const DEFAULT_MAX_DEPTH = 4;
export const USERS_DIR = '/mnt/c/Users';

const HEADER_SIZE = 0x200;
const GAME_CODE_END = 0x10;
const SAVE_EXT = '.dsv';
const BATTERY = 'battery';
const ROOT_FOLDERS = ['Desktop', 'Downloads', 'Documents'];
/** The profiles in `C:\Users` that are not a person's. */
const SYSTEM_PROFILES = new Set(['public', 'default', 'default user', 'all users']);

/** Decodes the ROM at `romPath` and downloads the docs into `dataDir`, saying what it is doing through `onProgress`. */
export type Extractor = (romPath: string, dataDir: string, onProgress: (message: string) => void) => Promise<void>;

/** A Node.js system error, such as ENOENT or EACCES. */
function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).syscall === 'string';
}

/** ENOENT, ENOTDIR or EISDIR: nothing at the path, or a folder where a file should be. */
function isNoFile(error: unknown): boolean {
  return isSystemError(error) && ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code ?? '');
}

/**
 * Null when the file at `romPath` is the hack (game code `JAK7`); else why not. It reads the header (the first 0x200
 * bytes) only. The reasons are "No file at <path>", "Not Platinum Kaizo (Nightmare Update): game code <code>; expected
 * JAK7 (plat-kaizo-nightmare-update-final.nds)" (a code too short or not printable shows `?` for each such character)
 * and "Cannot read <path>: <message>" for any other read failure.
 */
export async function checkRom(romPath: string): Promise<string | null> {
  const header = new Uint8Array(HEADER_SIZE);
  let bytesRead: number;
  try {
    const handle = await fs.promises.open(romPath, 'r');
    try {
      ({ bytesRead } = await handle.read(header, 0, HEADER_SIZE, 0));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isNoFile(error)) return `No file at ${romPath}`;
    if (isSystemError(error)) return `Cannot read ${romPath}: ${error.message}`;
    throw error;
  }
  const code = readGameCode(header.subarray(0, Math.min(bytesRead, GAME_CODE_END))).padEnd(4, '?').replace(/[^\x20-\x7e]/g, '?');
  if (code === ROM_GAME_CODE) return null;
  return `Not Platinum Kaizo (Nightmare Update): game code ${code}; expected ${ROM_GAME_CODE} (${ROM_FILE_NAME})`;
}

/** The entries of `dir`, as `lstat` sees them (a symlink is never a directory or a file here); none when it cannot be read. */
async function entries(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const isBattery = (name: string) => name.toLowerCase() === BATTERY;

/** The `Battery` folders directly in `dir`, in any case. */
async function batteryDirsIn(dir: string): Promise<string[]> {
  return (await entries(dir)).filter((e) => e.isDirectory() && isBattery(e.name)).map((e) => path.join(dir, e.name));
}

/** Every `Battery` folder up to `maxDepth` levels below `root` (its own folders are level 1), in path order. */
async function batteryDirsBelow(root: string, maxDepth: number): Promise<string[]> {
  const found: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const dirs = (await entries(dir)).filter((e) => e.isDirectory());
    await Promise.all(dirs.map((e) => {
      const child = path.join(dir, e.name);
      if (isBattery(e.name)) found.push(child);
      return visit(child, depth + 1);
    }));
  }
  await visit(root, 1);
  return found.sort();
}

/**
 * The save copies to offer, in this order: `savePath` (whatever it is called), then the `.dsv` files in a `Battery`
 * folder (in any case) in the ROM's folder, beside it (`<romDir>/../Battery`) and up to `maxDepth` levels below each
 * root. Only `<rom base name>.dsv` counts (in any case), or `SAVE_FILE_NAME` without a `romPath`, so another game's save
 * is never offered. Symlinks are never followed, a folder that cannot be read is skipped, and each path is listed once.
 */
export async function findSaveCandidates(opts: { romPath: string | null; savePath: string | null; roots: string[]; maxDepth: number }): Promise<string[]> {
  const { romPath, savePath, roots, maxDepth } = opts;
  const wanted = (romPath === null ? SAVE_FILE_NAME : `${path.basename(romPath, path.extname(romPath))}${SAVE_EXT}`).toLowerCase();
  const counts = (name: string) => name.toLowerCase() === wanted;

  const dirs: string[] = [];
  if (romPath !== null) {
    const romDir = path.dirname(path.resolve(romPath));
    dirs.push(...await batteryDirsIn(romDir), ...await batteryDirsIn(path.dirname(romDir)));
  }
  for (const dirsBelow of await Promise.all(roots.map((root) => batteryDirsBelow(root, maxDepth)))) dirs.push(...dirsBelow);

  const found = savePath === null ? [] : [savePath];
  const seen = new Set(found.map((p) => path.resolve(p)));
  const saves = await Promise.all(dirs.map(async (dir) => (await entries(dir))
    .filter((e) => e.isFile() && counts(e.name))
    .map((e) => path.join(dir, e.name))
    .sort()));
  for (const file of saves.flat()) {
    const key = path.resolve(file);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(file);
  }
  return found;
}

/**
 * The folders to search for save copies: each person's `Desktop`, `Downloads` and `Documents` under `usersDir` (default
 * `/mnt/c/Users`, the C: drive in WSL) that is a folder, people by name. The system profiles (Public, Default, Default
 * User, All Users) are skipped. None when `usersDir` cannot be read.
 */
export function defaultRoots(usersDir = USERS_DIR): string[] {
  let people: string[];
  try {
    people = fs.readdirSync(usersDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SYSTEM_PROFILES.has(e.name.toLowerCase()))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const person of people) {
    for (const folder of ROOT_FOLDERS) {
      const root = path.join(usersDir, person, folder);
      try {
        if (fs.statSync(root).isDirectory()) roots.push(root);
      } catch {
        // missing, or not ours to read
      }
    }
  }
  return roots;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Mon (Monferno) Lv 15", or "Starly Lv 14" when the nickname is the species name in any case; "Egg"; "?" for a bad record. */
function partyName(m: SaveMon, data: LocalData): string {
  if (m.badChecksum) return '?';
  if (m.isEgg) return 'Egg';
  let species: string;
  try {
    species = data.names.species(m.species, m.form);
  } catch {
    species = m.form === 0 ? `species ${m.species}` : `species ${m.species} form ${m.form}`;
  }
  const plain = m.nickname === '' || m.nickname.toLowerCase() === species.toLowerCase();
  return `${plain ? species : `${m.nickname} (${species})`} Lv ${m.level}`;
}

/** "Party: Mon (Monferno) Lv 15, Starly Lv 14 · 1 badge · 23 in the boxes". Throws `SaveError` for a file that is not a save. */
function saveSummary(file: Uint8Array, data: LocalData): string {
  const save = readSave(file, data.rom);
  const { badges } = readTrainerInfo(file);
  const party = save.party.length === 0 ? 'none' : save.party.map((m) => partyName(m, data)).join(', ');
  return `Party: ${party} · ${plural(badges, 'badge', 'badges')} · ${save.boxes.length} in the boxes`;
}

/**
 * The save at `savePath` for the setup page: its mtime as ISO, its size, and with `data` a summary of the party, badges
 * and box count. A file that is not a save gives `error` with the `SaveError` message (and no summary); a missing file
 * gives "No file at <path>", with the mtime 1970-01-01T00:00:00.000Z and size 0, and a file that cannot be read
 * "Cannot read <path>: <message>". Without data the file is still checked, but there is no summary.
 */
export async function describeSave(savePath: string, data: LocalData | null): Promise<SaveCandidateJson> {
  const described: SaveCandidateJson = { path: savePath, modifiedAt: new Date(0).toISOString(), sizeBytes: 0, summary: null, error: null };
  let file: Uint8Array;
  try {
    const stat = await fs.promises.stat(savePath);
    described.modifiedAt = stat.mtime.toISOString();
    described.sizeBytes = stat.size;
    file = await fs.promises.readFile(savePath);
  } catch (error) {
    if (isNoFile(error)) return { ...described, error: `No file at ${savePath}` };
    if (isSystemError(error)) return { ...described, error: `Cannot read ${savePath}: ${error.message}` };
    throw error;
  }
  try {
    if (data === null) readTrainerInfo(file);
    else described.summary = saveSummary(file, data);
  } catch (error) {
    if (error instanceof SaveError) return { ...described, summary: null, error: error.message };
    throw error;
  }
  return described;
}

/** The steps an extractor is made of; `createExtractor` takes the real ones for any not given. */
export interface ExtractSteps {
  /** Reads the ROM file (default `fs.promises.readFile`). */
  readRom(romPath: string): Promise<Uint8Array>;
  /** Decodes the ROM (default `extractRomData`). */
  decodeRom(rom: Uint8Array): RomData;
  /** Downloads the docs tabs into `docsDir` (default `downloadDocs`). */
  downloadDocs(docsDir: string): Promise<void>;
  /** Decodes the AI's data from the ROM into `<romDir>/trainer-ai.json` (default `writeAiData`). */
  writeAi(rom: Uint8Array, romDir: string): void;
}

const DEFAULT_STEPS: ExtractSteps = {
  readRom: (romPath) => fs.promises.readFile(romPath),
  decodeRom: (rom) => extractRomData(rom),
  downloadDocs: (docsDir) => downloadDocs(docsDir),
  writeAi: (rom, romDir) => writeAiData(rom, romDir),
};

/**
 * What `npm run extract -- --rom <path>` does, into `dataDir`: decodes the ROM, downloads the docs tabs into
 * `<dataDir>/docs/`, and only then writes `<dataDir>/rom/romdata.json` and the AI's `<dataDir>/rom/trainer-ai.json`, so a
 * failed download (about 2 minutes) leaves the ROM files as they were (on a first setup, no `rom/` at all). It reports
 * "Decoding the ROM…", the counts line, "Downloading the docs (18 tabs, about 2 minutes)…" and, last, "Loading the
 * data…" (the caller loads it). It throws what the steps throw: `RomError`, `DocsError` or a system error. `steps`
 * replaces any of the real steps; the unit tests stub the ROM read, the decode and the download, and keep the AI step's
 * `writeAiData` (mocked).
 */
export function createExtractor(steps: Partial<ExtractSteps> = {}): Extractor {
  const { readRom, decodeRom, downloadDocs: download, writeAi } = { ...DEFAULT_STEPS, ...steps };
  return async (romPath, dataDir, onProgress) => {
    onProgress('Decoding the ROM…');
    const rom = await readRom(romPath);
    const data = decodeRom(rom);
    const romDir = path.join(dataDir, 'rom');
    onProgress(`${data.species.length} species, ${data.moves.length} moves, ${data.trainers.length} trainers`);
    onProgress(`Downloading the docs (${DOC_TABS.length} tabs, about 2 minutes)…`);
    await download(path.join(dataDir, 'docs'));
    await fs.promises.mkdir(romDir, { recursive: true });       // only now, so a failed first download leaves no empty rom/
    await writeWhole(path.join(romDir, 'romdata.json'), `${JSON.stringify(data, null, 2)}\n`);
    writeAi(rom, romDir);
    onProgress('Loading the data…');
  };
}

/** The extractor the server uses: `createExtractor` with the real steps. */
export const defaultExtractor: Extractor = createExtractor();

export interface SetupRouteDeps {
  state: ServerState; dataDir: string;
  /** The extractor; without one, `POST /api/setup/extract` answers 501. */
  extract?: Extractor;
  /** The folders searched for save copies (default `defaultRoots()`, worked out on the first `GET /api/setup`). */
  saveRoots?: string[];
  /** Makes the sprite cache from the ROM once an extract succeeds, in the background (sprites.ts); none without it. */
  sprites?: SpriteEnsurer;
}

const ROM_PATH_REQUIRED = 'romPath is required: the path to the ROM';
export const EXTRACT_RUNNING = 'An extract is already running; wait for it to finish';
const DATA_STILL_MISSING = 'The extract finished, but the data is still missing';

/** One line for an extract failure, worded as `npm run extract` words it; anything else is a bug, logged, with its message. */
function extractFailure(error: unknown, romPath: string): string {
  if (error instanceof RomError) return `Cannot extract ${romPath}: ${error.message} (${error.code})`;
  if (error instanceof DocsError) return `Cannot download the docs: ${error.message} (${error.code})`;
  if (isSystemError(error)) return `Cannot extract ${romPath}: ${oneLine(error)}`;
  console.error('POST /api/setup/extract failed:', error);
  return oneLine(error);
}

/**
 * The `GET /api/setup` and `POST /api/setup/extract` handlers. The extract route rejects with `HttpError` before its
 * stream opens: 400 for a body without a `romPath` string (a pasted Windows path is turned into its WSL form with
 * `toLinuxPath`) or for a ROM `checkRom` refuses, 409 while an extract runs, 501 without an extractor. While it runs,
 * `dataStatus` is `extracting` with the latest progress line. On success the ROM path is saved to the settings, the data
 * is loaded again and `done` carries the new SetupJson; on failure (or when the data still does not load) `error` carries
 * the message and `dataStatus` becomes `error` with it. A page that goes away does not stop the extract.
 */
export function createSetupRoutes(deps: SetupRouteDeps): {
  setup: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  extract: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} {
  const { state } = deps;
  let roots = deps.saveRoots;
  let running = false;

  async function setupJson(): Promise<SetupJson> {
    roots ??= defaultRoots();
    const settings = state.settings();
    const local = state.data()?.local ?? null;
    const paths = await findSaveCandidates({ romPath: settings.romPath, savePath: settings.savePath, roots, maxDepth: DEFAULT_MAX_DEPTH });
    const candidates = await Promise.all(paths.map((p) => describeSave(p, local)));
    candidates.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
    return { data: state.dataStatus(), romPath: settings.romPath, savePath: settings.savePath, saveCandidates: candidates };
  }

  async function runExtract(extract: Extractor, romPath: string, send: (event: string, data: unknown) => void): Promise<void> {
    const fail = (message: string) => {
      state.setDataStatus({ state: 'error', message, trainers: null });
      send('error', { error: message });
    };
    try {
      await extract(romPath, deps.dataDir, (message) => {
        state.setDataStatus({ state: 'extracting', message, trainers: null });
        send('progress', { message });
      });
    } catch (error) {
      fail(extractFailure(error, romPath));
      return;
    }
    try {
      state.reloadData();
      const status = state.dataStatus();
      if (status.state !== 'ready') {
        fail(status.state === 'error' && status.message !== null ? status.message : DATA_STILL_MISSING);
        return;
      }
      await state.updateSettings({ ...state.settings(), romPath });
      void deps.sprites?.(deps.dataDir, romPath);   // in the background: the page falls back until they are there
      send('done', await setupJson());
    } catch (error) {
      console.error('POST /api/setup/extract failed after the extract:', error);
      fail(oneLine(error));
    }
  }

  return {
    async setup(_req, res) {
      sendJson(res, 200, await setupJson());
    },
    async extract(req, res) {
      const body = await readJsonBody(req);
      const raw = isRecord(body) ? body.romPath : undefined;
      const romPath = typeof raw === 'string' ? toLinuxPath(raw) : '';
      if (romPath === '') throw new HttpError(400, ROM_PATH_REQUIRED);
      if (deps.extract === undefined) throw new HttpError(501, 'This server cannot extract the ROM');
      const problem = await checkRom(romPath);
      if (problem !== null) throw new HttpError(400, problem);
      // No await between this check and setting the flag, so two requests can never both start.
      if (running) throw new HttpError(409, EXTRACT_RUNNING);
      running = true;
      try {
        state.setDataStatus({ state: 'extracting', message: null, trainers: null });
        const stream = openSse(res);
        await runExtract(deps.extract, romPath, (event, data) => stream.send(event, data));
        stream.close();
      } finally {
        running = false;
      }
    },
  };
}
