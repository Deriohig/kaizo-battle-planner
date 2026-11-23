// The data content fingerprint. The server's thread and every solver worker load the data
// folder by path, and an extract (the page's or the CLI's) can rewrite it meanwhile, file by file. The fingerprint is a
// SHA-256 over the bytes of exactly the files the loaders read (`dataFiles`), so a thread can tell whether it loaded
// the data the server planned with. It is checked with a sandwich (`readStable`): stamp the files, load, stamp again.
// The stamp adds each file's inode, size and mtime, so equal stamps mean the loader read those bytes (a rename into
// place changes the inode, an in-place write the mtime). A missing file is hashed as missing, never thrown, so a
// fixture folder or one with no PKCalc data has a fingerprint too.

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PKCALC_FILES, type PkcalcGlobal, pkcalcFile } from '../check/pkcalc.js';
import { DOC_TABS, type DocTab } from '../docs/fetchDocs.js';

export const DATA_CHANGED = 'DATA_CHANGED';
export const DATA_CHANGED_MESSAGE = 'The game data changed while the planner was loading it; plan again';
export const DATA_UNSTABLE_MESSAGE = 'The game data kept changing while the planner loaded it: run the extract again, or restart the planner once it is done';

/**
 * The data folder changed while a thread loaded it, or holds other data than the server's (code `DATA_CHANGED`). Its
 * `cause` is the loader's own error when the load failed while the folder changed.
 */
export class DataChangedError extends Error {
  readonly code = DATA_CHANGED;

  constructor(options?: ErrorOptions) {
    super(DATA_CHANGED_MESSAGE, options);
    this.name = 'DataChangedError';
  }
}

/** The docs tabs `loadLocalData` reads (src/data/load.ts, its `NEEDED_TABS`). */
const LOADED_TABS: DocTab[] = ['Personal', 'Moves', 'Level-Up Learnsets', 'AI Changes', ...DOC_TABS.filter((tab) => tab.endsWith(' Split'))];

/** `file` with `/` separators, whatever the platform's. */
const slashed = (file: string) => file.split(path.sep).join('/');

const DATA_FILES: readonly { file: string; presenceOnly: boolean }[] = [
  'rom/romdata.json',
  'rom/trainer-ai.json',
  ...LOADED_TABS.map((tab) => `docs/${tab}.csv`),
  ...(Object.keys(PKCALC_FILES) as PkcalcGlobal[]).map((name) => slashed(pkcalcFile('pkcalc', name))),
].map((file) => ({ file, presenceOnly: false }));

/**
 * The files the loaders read, relative to the data folder with `/` separators, in a fixed order: the ROM data, the
 * trainer AI's data, the docs tabs, PKCalc's files, and `pkcalc/meta.json`, whose presence alone decides whether
 * PKCalc's files are loaded (its bytes are never parsed).
 */
export function dataFiles(): { file: string; presenceOnly: boolean }[] {
  return [...DATA_FILES.map((entry) => ({ ...entry })), { file: 'pkcalc/meta.json', presenceOnly: true }];
}

/** content: SHA-256 hex. identity: per file "ino:size:mtimeNs" or "-", joined by newlines; compared only within one thread. */
export interface DataStamp { content: string; identity: string }

/**
 * `file` opened once: its "ino:size:mtimeNs" and, when `withBytes`, its bytes; null when it does not exist (ENOENT, or
 * ENOTDIR when a folder on its path is a regular file, as `existsSync` has it).
 */
function readOnce(file: string, withBytes: boolean): { identity: string; bytes: Buffer | null } | null {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    return { identity: `${stat.ino}:${stat.size}:${stat.mtimeNs}`, bytes: withBytes ? readFileSync(fd) : null };
  } finally {
    closeSync(fd);
  }
}

/**
 * The stamp of the data in `dataDir`. Each file in `dataFiles()` adds its relative path and a NUL to the hash, then
 * `-` when it is missing, `+` when it is presence-only, else `+<byte length>`, a NUL and its bytes.
 */
export function stampData(dataDir: string): DataStamp {
  const hash = createHash('sha256');
  const identities: string[] = [];
  for (const { file, presenceOnly } of dataFiles()) {
    hash.update(`${file}\0`);
    const read = readOnce(path.join(dataDir, file), !presenceOnly);
    identities.push(read === null ? '-' : read.identity);
    if (read === null) hash.update('-');
    else if (read.bytes === null) hash.update('+');
    else hash.update(`+${read.bytes.length}\0`).update(read.bytes);
  }
  return { content: hash.digest('hex'), identity: identities.join('\n') };
}

/** The content fingerprint of the data in `dataDir` (`stampData`'s content). */
export function fingerprintData(dataDir: string): string {
  return stampData(dataDir).content;
}

/**
 * Stamps `dataDir`, runs `read`, stamps again, and returns `read`'s value with the content fingerprint. Throws
 * DataChangedError without calling `read` when `expected` is a string and the first stamp's content is not it, and
 * after `read` when the two stamps differ (content or identity). When `read` throws, its error passes through as the
 * same object if the folder is unchanged; if the folder changed meanwhile (say a loader failed on a half-written file),
 * a DataChangedError is thrown instead, with that error as its `cause`.
 */
export function readStable<T>(dataDir: string, expected: string | null, read: () => T): { value: T; fingerprint: string } {
  const before = stampData(dataDir);
  if (expected !== null && before.content !== expected) throw new DataChangedError();
  const unchanged = (after: DataStamp) => after.content === before.content && after.identity === before.identity;
  let value: T;
  try {
    value = read();
  } catch (error) {
    let changed: boolean;
    try {
      changed = !unchanged(stampData(dataDir));
    } catch {
      throw error;                               // a failing second stamp never hides the loader's error
    }
    if (changed) throw new DataChangedError({ cause: error });
    throw error;
  }
  if (!unchanged(stampData(dataDir))) throw new DataChangedError();
  return { value, fingerprint: before.content };
}
