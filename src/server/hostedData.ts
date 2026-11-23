// Hosted mode's data, loaded once at start from the bundle folder: the data
// as local mode loads it (`loadLocalData`, the catalog, the move table, the fingerprint), checked against `bundle.json`
// when the folder has one, plus the sprite cache and the built page. Anything missing or not checking out is a
// `HostedDataError`, whose message is the one line `main.ts` prints before it exits with code 1. Nothing here writes.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildCatalog } from '../battle/catalog.js';
import { buildMoves } from '../battle/moves.js';
import type { BundleManifest } from '../contracts/hosted.js';
import { type LocalData, loadLocalData, MissingDataError } from '../data/load.js';
import { oneLineMessage as oneLine } from '../docs/fetchDocs.js';
import { DATA_UNSTABLE_MESSAGE, type DataStamp, stampData } from '../integration/fingerprint.js';
import { ROM_SCHEMA_VERSION } from '../rom/extract.js';
import { readyManifest, SPRITES_VERSION, type SpriteManifest } from '../sprites/extract.js';
import { spritesDir } from './sprites.js';
import type { ServerData } from './state.js';

export const BUNDLE_FILE = 'bundle.json';

/** Why hosted mode cannot start on a data folder; the message is one line. */
export class HostedDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedDataError';
  }
}

export interface HostedData {
  data: ServerData;
  /** The folder's `bundle.json`, checked; null when it has none (hosted mode tried on a plain `data/`). */
  bundle: BundleManifest | null;
  sprites: SpriteManifest;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `bundle.json`'s text as a `BundleManifest`, its shape checked (not its files). */
function parseBundle(text: string): BundleManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new HostedDataError(`${BUNDLE_FILE} is not JSON: ${oneLine(error)}`);
  }
  const bad = (what: string) => new HostedDataError(`${BUNDLE_FILE} ${what}: rebuild the bundle with npm run bundle`);
  if (!isRecord(raw)) throw bad('is not an object');
  if (raw.bundleVersion !== 1) throw bad(`is bundle version ${JSON.stringify(raw.bundleVersion)}, not 1`);
  if (raw.gameCode !== 'JAK7') throw bad(`is for game ${JSON.stringify(raw.gameCode)}, not JAK7 (Platinum)`);
  if (raw.romSchemaVersion !== ROM_SCHEMA_VERSION) throw bad(`has ROM schema ${JSON.stringify(raw.romSchemaVersion)}, and this server reads ${ROM_SCHEMA_VERSION}`);
  if (raw.spriteVersion !== SPRITES_VERSION) throw bad(`has sprite version ${JSON.stringify(raw.spriteVersion)}, and this server reads ${SPRITES_VERSION}`);
  if (typeof raw.fingerprint !== 'string' || typeof raw.createdAt !== 'string') throw bad('lacks its fingerprint or creation time');
  if (!Array.isArray(raw.files)) throw bad('lacks its file list');
  for (const file of raw.files) {
    if (!isRecord(file) || typeof file.path !== 'string' || typeof file.bytes !== 'number' || typeof file.sha256 !== 'string') throw bad('has a file entry that is not { path, bytes, sha256 }');
    const parts = file.path.split('/');
    if (file.path === '' || file.path.includes('\\') || file.path.includes('\0') || path.isAbsolute(file.path) || parts.some((part) => part === '' || part === '.' || part === '..')) {
      throw bad(`lists ${JSON.stringify(file.path)}, which is not a path inside the bundle`);
    }
  }
  return raw as unknown as BundleManifest;
}

/** Throws unless every file `bundle` lists is in `dataDir` with its size and SHA-256. */
function checkFiles(dataDir: string, bundle: BundleManifest): void {
  for (const file of bundle.files) {
    if (file.path === BUNDLE_FILE) continue;
    const full = path.join(dataDir, ...file.path.split('/'));
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(full);
    } catch {
      throw new HostedDataError(`The bundle's ${file.path} is missing from ${dataDir}/: unpack the bundle again`);
    }
    if (bytes.length !== file.bytes) throw new HostedDataError(`The bundle's ${file.path} is ${bytes.length} bytes, not ${file.bytes}: unpack the bundle again`);
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new HostedDataError(`The bundle's ${file.path} does not match its SHA-256: unpack the bundle again`);
  }
}

/**
 * Loads hosted mode's data from `dataDir`, in this order: `bundle.json` when present (its shape, then every listed file's
 * size and SHA-256); the data as local mode loads it, with a stamp of the folder before and after (they must agree, and
 * with a bundle the stamp's content must be its fingerprint); then the sprite cache (`readyManifest`). Without
 * `bundle.json` it calls `warn` once and goes on. Throws `HostedDataError` for anything missing or not checking out.
 * `opts.loadData` and `opts.stamp` are for the tests.
 */
export function loadHostedData(dataDir: string, opts: { warn: (message: string) => void; loadData?: (dir: string) => LocalData; stamp?: (dir: string) => DataStamp }): HostedData {
  const loadData = opts.loadData ?? loadLocalData;
  const stamp = opts.stamp ?? stampData;
  const bundlePath = path.join(dataDir, BUNDLE_FILE);
  let bundle: BundleManifest | null = null;
  if (fs.existsSync(bundlePath)) {
    bundle = parseBundle(fs.readFileSync(bundlePath, 'utf8'));
    checkFiles(dataDir, bundle);
  } else {
    opts.warn(`${dataDir}/ has no ${BUNDLE_FILE}, so its files are not checked: build a bundle with npm run bundle for a real deployment`);
  }

  let before: DataStamp;
  let local: LocalData;
  try {
    before = stamp(dataDir);
    local = loadData(dataDir);
  } catch (error) {
    if (error instanceof MissingDataError) throw new HostedDataError(`No game data in ${dataDir}/: ${oneLine(error)}. Set PKP_DATA to an unpacked bundle (npm run bundle)`);
    throw new HostedDataError(`The game data in ${dataDir}/ cannot be loaded: ${oneLine(error)}`);
  }
  const after = stamp(dataDir);
  if (after.content !== before.content) throw new HostedDataError(DATA_UNSTABLE_MESSAGE);
  if (bundle !== null && bundle.fingerprint !== before.content) {
    throw new HostedDataError(`The data in ${dataDir}/ does not match ${BUNDLE_FILE}'s fingerprint: unpack the bundle again`);
  }
  let data: ServerData;
  try {
    data = { local, catalog: buildCatalog(local), moves: buildMoves(local), fingerprint: before.content };
  } catch (error) {
    throw new HostedDataError(`The game data in ${dataDir}/ cannot be read into trainers and moves: ${oneLine(error)}`);
  }

  const sprites = readyManifest(spritesDir(dataDir));
  if (sprites === null) throw new HostedDataError(`No sprites in ${spritesDir(dataDir)}/ (or of another version): build the bundle again after npm run sprites`);
  return { data, bundle, sprites };
}

/** Throws unless `staticDir` holds the built page (`index.html`). */
export function checkStaticDir(staticDir: string): void {
  let ok = false;
  try {
    ok = fs.statSync(path.join(staticDir, 'index.html')).isFile();
  } catch {
    ok = false;
  }
  if (!ok) throw new HostedDataError(`No built page in ${staticDir}/: run npm run build:web, or set PKP_STATIC`);
}
