// The server's live state: the local data and its trainer catalog, the settings, and the box read from the chosen save,
// kept fresh by the save watcher. The box changes one step at a time: a re-read, or a settings change, waits for the
// one before it, and the changes that arrive during a re-read queue a single rerun. DeSmuME can be caught mid-write, so a
// re-read that fails keeps the last good box and pushes `boxError`; the next change recovers.

import fs from 'node:fs';
import { buildCatalog } from '../battle/catalog.js';
import { buildMoves, type KaizoMove } from '../battle/moves.js';
import type { TrainerCatalog } from '../battle/types.js';
import { type LocalData, loadLocalData, MissingDataError } from '../data/load.js';
import { DocsError, oneLineMessage as oneLine } from '../docs/fetchDocs.js';
import { RomError } from '../errors.js';
import { DATA_UNSTABLE_MESSAGE, type DataStamp, stampData } from '../integration/fingerprint.js';
import type { ServerEvent, SettingsJson, SetupJson } from './apiTypes.js';
import { type BoxState, buildBox } from './box.js';
import { loadSettings, saveSettings } from './settings.js';
import type { Extractor } from './setup.js';
import type { SpriteEnsurer } from './sprites.js';
import type { SheetBuilder } from './sheet.js';
import type { LineDeps } from './lines.js';
import type { SheetAiDeps } from './sheetAi.js';
import { watchSave } from './watchSave.js';

export interface ServerDeps {
  dataDir: string; settingsFile: string;
  /** The built page (`dist/web`); null serves no page (404 outside `/api`). */
  staticDir: string | null;
  buildSheet: SheetBuilder;
  watch?: typeof watchSave; readFile?: (path: string) => Promise<Uint8Array>; statFile?: (path: string) => Promise<{ mtime: Date }>;
  /** Loads what `npm run extract` saved in `dir`. Default `loadLocalData`; the tests inject their fixture data. */
  loadData?: (dir: string) => LocalData;
  /**
   * The stamp of the data folder `dir` (default `stampData`, src/integration/fingerprint.ts), taken before and after each
   * `loadData`: a load counts only when both are equal, and the data's fingerprint is the stamp's content.
   */
  fingerprint?: (dir: string) => DataStamp;
  /**
   * Runs the first-run extract (`POST /api/setup/extract`). There is no default, so a test never reaches the network:
   * `main.ts` passes `defaultExtractor`, and without one the route answers 501.
   */
  extract?: Extractor;
  /** The folders searched for save copies (`GET /api/setup`). Default `defaultRoots()`. */
  saveRoots?: string[];
  /**
   * Makes the sprite cache when it is missing (sprites.ts `ensureSprites`), after a first-run extract. No default, so a
   * test never decodes a ROM: `main.ts` passes `ensureSprites`, and calls it once the server is up.
   */
  sprites?: SpriteEnsurer;
  /**
   * The trainer AI and the engine calls behind `POST /api/sheet/ai/stream` (sheetAi.ts), or how to build them for a data
   * load, which the app does on first use, once per load. There is no default, so the app never loads the real data's
   * deps itself: `main.ts` passes `baseDeps` (src/integration/baseDeps.ts), which installs the dex in this thread, and
   * without any the route answers 501. The tests inject a fixture model, over a dex they install.
   */
  sheetAi?: SheetAiDeps | ((data: ServerData) => SheetAiDeps);
  /**
   * The engine, trainer AI, resolver, labeler and view behind the line builder's routes (`/api/line/*`, lines.ts), or how to
   * build them for a data load, which the app does on first use, once per load, as for `sheetAi`. No default: `main.ts`
   * passes `realLineDeps` (lineDeps.ts), and without any the routes answer 501. The tests inject fakes.
   */
  lines?: LineDeps | ((data: ServerData) => LineDeps);
}

/**
 * The loaded data, its trainer catalog and the hack's move table (`buildMoves`, which the sheet builder takes), made once
 * per load, and `fingerprint`, the content fingerprint of the folder's bytes it was loaded from (src/integration/
 * fingerprint.ts). Every later read of the folder for this data, such as the AI's file on this thread (`baseDeps`), is
 * checked against it. The server always sets it; it is optional so fixtures need none, and without one nothing is checked.
 */
export interface ServerData { local: LocalData; catalog: TrainerCatalog; moves: ReadonlyMap<number, KaizoMove>; fingerprint?: string }

/** How many times a load reads a data folder that changes while it is read before it gives up (DATA_UNSTABLE_MESSAGE). */
const LOAD_TRIES = 3;

export interface ServerState {
  settings(): SettingsJson;
  /** null until the data folder holds an extract. */
  data(): ServerData | null;
  /**
   * The data object's identity: a counter that goes up each time `data` is replaced (the first load, and each
   * `reloadData` after an extract), and never otherwise (a box re-read keeps it). The server itself does not read it:
   * it is the state the real solver (src/integration/realSolver.ts, the split bench's) keeps its workers' data by.
   */
  dataVersion(): number;
  /**
   * The setup's data status. `trainers` is the trainer count of the data loaded now, whatever the state: while a
   * re-extract runs, or after one failed, the data from before still serves, and the page keeps its workspace open.
   */
  dataStatus(): SetupJson['data'];
  /**
   * The box of the chosen save; `{ error }` when it has never read as a save. null while no save is chosen or there is
   * no data to read it with.
   */
  box(): BoxState | { error: string } | null;
  /**
   * Persists `next` and brings the box up to date: a new `savePath` is read at once (with the data present it must read
   * as a save, else this rejects with `SavePathError` and nothing changes) and the watcher moves to it; a new graveyard
   * or cap override rebuilds the box.
   */
  updateSettings(next: SettingsJson): Promise<void>;
  /** Loads the data again (after an extract), then re-reads the box. */
  reloadData(): void;
  setDataStatus(status: SetupJson['data']): void;
  /** Calls `listener` with every `box` and `boxError` event; returns the unsubscribe. */
  subscribe(listener: (e: ServerEvent) => void): () => void;
  close(): void;
}

/** A new `savePath` that does not read as a save. The message is "Cannot read <path>: <message>". */
export class SavePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SavePathError';
  }
}

type BoxRead = { ok: true; box: BoxState; file: Uint8Array; savedAt: Date } | { ok: false; error: string };

/**
 * Reads the settings and the data, then the chosen save, and starts watching it. Rejects with `SettingsError` for a
 * settings file that cannot be read. A missing extract gives `dataStatus` missing; a `DocsError` or `RomError`
 * BAD_FORMAT gives error, with its message; a data folder that keeps changing while it is read gives error with
 * DATA_UNSTABLE_MESSAGE, and one whose stamp cannot be taken, while the load succeeds, error with the stamp's message.
 * Any other load failure is a bug, and throws.
 */
export async function createState(deps: ServerDeps): Promise<ServerState> {
  const loadData = deps.loadData ?? loadLocalData;
  const stamp = deps.fingerprint ?? stampData;
  const watch = deps.watch ?? watchSave;
  const readFile = deps.readFile ?? ((path: string) => fs.promises.readFile(path));
  const statFile = deps.statFile ?? ((path: string) => fs.promises.stat(path));

  let settings = loadSettings(deps.settingsFile);
  let data: ServerData | null = null;
  let dataVersion = 0;
  let status: SetupJson['data'] = { state: 'missing', message: null, trainers: null };
  let box: BoxState | { error: string } | null = null;
  /** The bytes behind the current good box, so a graveyard or cap change rebuilds it without a read. */
  let last: { path: string; file: Uint8Array; savedAt: Date } | null = null;
  let watcher: { close(): void } | null = null;
  let closed = false;
  const listeners = new Set<(e: ServerEvent) => void>();

  function emit(e: ServerEvent): void {
    if (closed) return;
    for (const listener of [...listeners]) {
      try {
        listener(e);
      } catch (error) {
        console.error('A server event listener failed:', error);
      }
    }
  }

  /** A stamp of the data folder, or the error that stopped it (a listed file that cannot be read, a folder in its place). */
  type Stamped = DataStamp | { error: unknown };
  function tryStamp(): Stamped {
    try {
      return stamp(deps.dataDir);
    } catch (error) {
      return { error };
    }
  }

  /** Whether two stamps of the data folder saw the same bytes in the same files. */
  const same = (a: DataStamp, b: DataStamp) => a.content === b.content && a.identity === b.identity;

  /** Whether the folder changed since `before`: both stamps taken, and unequal. A stamp that fails proves no change. */
  function changedSince(before: Stamped): boolean {
    if ('error' in before) return false;
    const now = tryStamp();
    return !('error' in now) && !same(before, now);
  }

  /**
   * Loads the data, replacing `data` (null when there is none or it cannot load), and so bumps `dataVersion`, once. An
   * extract can rewrite the folder meanwhile, file by file, so each try stamps the folder, loads it and stamps it again,
   * and counts only when both stamps are equal: the data's `fingerprint` is then the stamp's content. A load that throws
   * while the folder changes (say on a file the CLI's extract is writing in place) is tried again too, as `readStable`
   * treats it: its error is about a folder in mid-write, not the data. Only a load that throws over a folder that held
   * still is classified. After LOAD_TRIES tries that each saw the folder change, `data` is null and the status error,
   * with DATA_UNSTABLE_MESSAGE. A stamp that throws (a listed file unreadable) never throws out of here: the load
   * still runs, so its own error classifies, and a load that succeeds without a stamp has no fingerprint, so `data` is
   * null and the status error, with the stamp's message.
   */
  function load(): void {
    dataVersion += 1;
    let loaded: { local: LocalData; fingerprint: string } | null = null;
    for (let attempt = 0; attempt < LOAD_TRIES && loaded === null; attempt += 1) {
      const before = tryStamp();
      let local: LocalData;
      try {
        local = loadData(deps.dataDir);
      } catch (error) {
        if (changedSince(before)) continue;                        // the folder changed under the load: read it again
        if (error instanceof MissingDataError) {
          data = null;
          status = { state: 'missing', message: null, trainers: null };
          return;
        }
        if ((error instanceof DocsError || error instanceof RomError) && error.code === 'BAD_FORMAT') {
          data = null;
          status = { state: 'error', message: oneLine(error), trainers: null };
          return;
        }
        throw error;
      }
      const after = 'error' in before ? before : tryStamp();
      if ('error' in after) {
        data = null;
        status = { state: 'error', message: oneLine(after.error), trainers: null };
        return;
      }
      if (!('error' in before) && same(before, after)) loaded = { local, fingerprint: before.content };
    }
    if (loaded === null) {
      data = null;
      status = { state: 'error', message: DATA_UNSTABLE_MESSAGE, trainers: null };
      return;
    }
    const catalog = buildCatalog(loaded.local);
    data = { local: loaded.local, catalog, moves: buildMoves(loaded.local), fingerprint: loaded.fingerprint };
    status = { state: 'ready', message: null, trainers: catalog.trainers.length };
  }

  function build(path: string, file: Uint8Array, savedAt: Date, s: SettingsJson, d: ServerData): BoxRead {
    try {
      return { ok: true, box: buildBox({ file, savePath: path, savedAt, data: d.local, settings: s }), file, savedAt };
    } catch (error) {
      return { ok: false, error: `Cannot read ${path}: ${oneLine(error)}` };
    }
  }

  /** Stats, then reads, the save at `path` and builds its box. The mtime is `savedAt`. */
  async function read(path: string, s: SettingsJson, d: ServerData): Promise<BoxRead> {
    let file: Uint8Array;
    let mtime: Date;
    try {
      ({ mtime } = await statFile(path));
      file = await readFile(path);
    } catch (error) {
      return { ok: false, error: `Cannot read ${path}: ${oneLine(error)}` };
    }
    return build(path, file, mtime, s, d);
  }

  /** A good read replaces the box; a failed one keeps the last good box of that path (or records the error) and says so. */
  function apply(path: string, result: BoxRead): void {
    if (closed) return;
    if (result.ok) {
      box = result.box;
      last = { path, file: result.file, savedAt: result.savedAt };
      emit({ name: 'box', data: result.box.json });
    } else {
      if (last?.path !== path) box = { error: result.error };
      emit({ name: 'boxError', data: { error: result.error } });
    }
  }

  // One box step at a time: each runs after the one before it settles.
  let chain: Promise<void> = Promise.resolve();
  function exclusive(step: () => Promise<void>): Promise<void> {
    const run = chain.then(step);
    chain = run.catch(() => undefined);
    return run;
  }

  async function reread(): Promise<void> {
    const path = settings.savePath;
    if (path === null || data === null) {
      box = null;
      last = null;
      return;
    }
    apply(path, await read(path, settings, data));
  }

  /** A re-read queued and not yet started; every change until it starts shares it. */
  let queued: Promise<void> | null = null;
  function refresh(): Promise<void> {
    queued ??= exclusive(async () => {
      queued = null;
      await reread();
    });
    return queued;
  }

  function startWatcher(): void {
    watcher?.close();
    watcher = null;
    if (settings.savePath !== null && !closed) watcher = watch(settings.savePath, () => refresh());
  }

  async function changeSettings(next: SettingsJson): Promise<void> {
    const prev = settings;
    const moved = next.savePath !== prev.savePath;
    let fresh: BoxRead | null = null;
    if (moved && next.savePath !== null && data !== null) {
      fresh = await read(next.savePath, next, data);
      if (!fresh.ok) throw new SavePathError(fresh.error);
    }
    saveSettings(deps.settingsFile, next);
    settings = structuredClone(next);
    if (moved) {
      box = null;
      last = null;
      startWatcher();
      if (fresh !== null && next.savePath !== null) apply(next.savePath, fresh);
    } else if (next.graveyardBox !== prev.graveyardBox || next.levelCapOverride !== prev.levelCapOverride) {
      if (data !== null && last !== null && last.path === settings.savePath) {
        apply(last.path, build(last.path, last.file, last.savedAt, settings, data));
      } else {
        await reread();
      }
    }
  }

  load();
  startWatcher();
  await refresh();

  return {
    settings: () => structuredClone(settings),
    data: () => data,
    dataVersion: () => dataVersion,
    dataStatus: () => ({ ...status, trainers: data?.catalog.trainers.length ?? null }),
    box: () => box,
    updateSettings: (next) => exclusive(() => changeSettings(next)),
    reloadData() {
      load();
      void refresh();
    },
    setDataStatus(next) {
      status = { ...next };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      watcher?.close();
      watcher = null;
      listeners.clear();
    },
  };
}
