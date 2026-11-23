// `npm run bundle -- [--data <dir>] [--out <dir>] [--allow-no-pkcalc]`: the hosted server's data bundle. It copies exactly the files the loaders read
// (`dataFiles()`, so the list cannot drift from them) and the sprite cache into `<out>/pkp-data/`, writes `bundle.json`
// (`BundleManifest`) beside them, loads the copy again, and packs `<out>/pkp-data.tar.gz`. Defaults: `data` and
// `dist/bundle`. The bundle holds data and art taken from the game: `dist/` is git-ignored, and it must never be
// committed or pushed to a public image registry. A ROM or a save (`.nds`, `.dsv`, `.sav`) is never written into it.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadAiData } from '../src/ai/rom/aiData.js';
import type { BundleManifest } from '../src/contracts/hosted.js';
import { loadLocalData } from '../src/data/load.js';
import { dataFiles, stampData } from '../src/integration/fingerprint.js';
import { ROM_SCHEMA_VERSION } from '../src/rom/extract.js';
import { spritesDir } from '../src/server/sprites.js';
import { readyManifest } from '../src/sprites/extract.js';

/** The folder inside `--out` that holds the bundle, and the tarball's name beside it. */
export const BUNDLE_DIR = 'pkp-data';
export const BUNDLE_TARBALL = 'pkp-data.tar.gz';
export const BUNDLE_MANIFEST = 'bundle.json';
/** A ROM or a save: never written into a bundle. */
const FORBIDDEN = /\.(nds|dsv|sav)$/i;
const GAME_CODE = 'JAK7';

/** A bundle that cannot be made: the message says why and what to run. */
export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

const oneLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0];

/**
 * The default check of a data folder, as the server loads it: `loadLocalData`, `loadAiData` and a complete sprite cache
 * (`readyManifest`). Returns the sprite cache's version. Throws BundleError with the fix.
 */
export function checkData(dir: string): { spriteVersion: number } {
  let gameCode: unknown;
  try {
    gameCode = (loadLocalData(dir).rom as { gameCode?: unknown }).gameCode;
    loadAiData(path.join(dir, 'rom'));
  } catch (error) {
    throw new BundleError(`The data in ${dir}/ does not load (${oneLine(error)}); run npm run extract -- --rom <path>, and npm run record:diffs for PKCalc's files`);
  }
  if (gameCode !== GAME_CODE) throw new BundleError(`The data in ${dir}/ is not from Platinum Kaizo (game code ${JSON.stringify(gameCode)}); run npm run extract -- --rom <path>`);
  const manifest = readyManifest(spritesDir(dir));
  if (manifest === null) throw new BundleError(`No complete sprite cache in ${spritesDir(dir)}/; run npm run sprites`);
  return { spriteVersion: manifest.version };
}

/** Every regular file below `dir`, relative to `base` with `/` separators. */
function filesBelow(dir: string, base: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesBelow(full, base);
    return entry.isFile() ? [path.relative(base, full).split(path.sep).join('/')] : [];
  });
}

/** The sprite cache's own files: its manifest and each kind's PNGs (src/sprites/extract.ts). */
const SPRITE_FILE = /^sprites\/(manifest\.json|(front|back|icon)\/[^/]+\.png)$/;

/**
 * The files a bundle of `dataDir` holds, relative with `/` separators, sorted: each file of `dataFiles()` that exists,
 * then the sprite cache (`sprites/manifest.json` and `sprites/{front,back,icon}/*.png`); `skipped` lists any other file
 * found below `sprites/`. PKCalc's files missing are a BundleError unless `allowNoPkcalc`; any other missing file is left
 * to the data check, which names it. A ROM or a save anywhere among them, or below `sprites/`, is a BundleError.
 */
export function bundleFiles(dataDir: string, allowNoPkcalc = false): { files: string[]; skipped: string[] } {
  const listed = dataFiles().map((entry) => entry.file);
  const missingPkcalc = listed.filter((file) => file.startsWith('pkcalc/') && !existsSync(path.join(dataDir, file)));
  if (missingPkcalc.length > 0 && !allowNoPkcalc) {
    throw new BundleError(`PKCalc's files are missing from ${dataDir}/ (${missingPkcalc.join(', ')}); run npm run record:diffs, or pass --allow-no-pkcalc to bundle without them (the hosted site would then answer differently from the local one)`);
  }
  const sprites = spritesDir(dataDir);
  const below = existsSync(sprites) ? filesBelow(sprites, dataDir) : [];
  const present = listed.filter((file) => existsSync(path.join(dataDir, file)));
  const forbidden = [...present, ...below].filter((file) => FORBIDDEN.test(file));
  if (forbidden.length > 0) throw new BundleError(`Refusing to bundle a ROM or a save: ${forbidden.join(', ')}; move it out of ${dataDir}/`);
  return {
    files: [...new Set([...present, ...below.filter((file) => SPRITE_FILE.test(file))])].sort(),
    skipped: below.filter((file) => !SPRITE_FILE.test(file)).sort(),
  };
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Whether `inner` is `outer` or inside it. */
const within = (outer: string, inner: string) => {
  const rel = path.relative(path.resolve(outer), path.resolve(inner));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export interface BundleOptions {
  dataDir: string;
  outDir: string;
  allowNoPkcalc?: boolean;
  /** The data check, run on the source and again on the copy (default `checkData`). */
  check?: (dir: string) => { spriteVersion: number };
  now?: () => Date;
  /** Told about files below `sprites/` that are not the cache's and so are left out (default `console.warn`). */
  warn?: (message: string) => void;
}

/**
 * Writes the bundle of `opts.dataDir` into `<outDir>/pkp-data/` and returns its manifest. Checks the data first, copies
 * `bundleFiles` into a temp folder beside it, writes `bundle.json`, checks the copy (each file's SHA-256 against the
 * source's, the data check, and the fingerprint, which must be the source's before and after the copy, so an extract
 * running meanwhile is caught), and only then puts it in place of an earlier bundle. A failed run leaves no bundle and
 * no tarball behind it. A `pkp-data/` there that is not a bundle (no `bundle.json`, not empty) is never replaced.
 * Throws BundleError.
 */
export function makeBundle(opts: BundleOptions): BundleManifest {
  const { dataDir, outDir, allowNoPkcalc = false, check = checkData, now = () => new Date(), warn = (message) => console.warn(message) } = opts;
  const dest = path.join(outDir, BUNDLE_DIR);
  if (within(dataDir, dest) || within(dest, dataDir)) throw new BundleError(`The bundle (${dest}/) and the data folder (${dataDir}/) must not hold one another; pick another --out`);
  if (existsSync(dest) && !existsSync(path.join(dest, BUNDLE_MANIFEST)) && readdirSync(dest).length > 0) {
    throw new BundleError(`${dest}/ is there and is not a bundle (no ${BUNDLE_MANIFEST}); move it, or pick another --out`);
  }
  const { files, skipped } = bundleFiles(dataDir, allowNoPkcalc);
  if (skipped.length > 0) warn(`Left out of the bundle, not part of the sprite cache: ${skipped.join(', ')}`);
  const { spriteVersion } = check(dataDir);
  const before = stampData(dataDir).content;

  rmSync(path.join(outDir, BUNDLE_TARBALL), { force: true });   // an older tarball must not pass for this run's
  const temp = path.join(outDir, `${BUNDLE_DIR}.tmp-${process.pid}-${Date.now()}`);
  try {
    for (const file of files) {
      const target = path.join(temp, ...file.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(dataDir, ...file.split('/')), target);
    }
    const manifest: BundleManifest = {
      bundleVersion: 1,
      createdAt: now().toISOString(),
      gameCode: GAME_CODE,
      romSchemaVersion: ROM_SCHEMA_VERSION,
      spriteVersion,
      fingerprint: before,
      files: files.map((file) => {
        const copied = path.join(temp, ...file.split('/'));
        const hash = sha256(copied);
        if (hash !== sha256(path.join(dataDir, ...file.split('/')))) throw new BundleError(`${file} did not copy whole (its SHA-256 differs from the data's); run npm run bundle again`);
        return { path: file, bytes: statSync(copied).size, sha256: hash };
      }),
    };
    writeFileSync(path.join(temp, BUNDLE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

    if (stampData(dataDir).content !== before) throw new BundleError(`The data in ${dataDir}/ changed while it was bundled; run npm run bundle again once the extract is done`);
    check(temp);
    const copied = stampData(temp).content;
    if (copied !== before) throw new BundleError(`The bundle's fingerprint (${copied}) is not the data's (${before}); run npm run bundle again`);

    rmSync(dest, { recursive: true, force: true });
    renameSync(temp, dest);
    return manifest;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Packs `<outDir>/pkp-data/` into `<outDir>/pkp-data.tar.gz` with the system's `tar`, and returns the tarball's path. */
export function packBundle(outDir: string): string {
  const tarball = path.join(outDir, BUNDLE_TARBALL);
  rmSync(tarball, { force: true });
  const run = spawnSync('tar', ['-czf', tarball, '-C', outDir, BUNDLE_DIR], { encoding: 'utf8' });
  if (run.error !== undefined || run.status !== 0) throw new BundleError(`tar could not pack ${tarball}: ${run.error?.message ?? run.stderr.trim()}`);
  return tarball;
}

const USAGE = 'Usage: npm run bundle -- [--data <dir>] [--out <dir>] [--allow-no-pkcalc]';

function main(): void {
  let values: { data?: string; out?: string; 'allow-no-pkcalc'?: boolean };
  try {
    values = parseArgs({ options: { data: { type: 'string' }, out: { type: 'string' }, 'allow-no-pkcalc': { type: 'boolean' } } }).values;
  } catch (error) {
    console.error(`${oneLine(error)}. ${USAGE}`);
    process.exit(2);
  }
  const dataDir = values.data ?? 'data';
  const outDir = values.out ?? path.join('dist', 'bundle');
  try {
    const manifest = makeBundle({ dataDir, outDir, allowNoPkcalc: values['allow-no-pkcalc'] === true });
    const tarball = packBundle(outDir);
    const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    console.log(`Bundle: ${manifest.files.length} files, ${(total / 1e6).toFixed(1)} MB, in ${path.join(outDir, BUNDLE_DIR)}/`);
    console.log(`Packed: ${tarball}, ${(statSync(tarball).size / 1e6).toFixed(1)} MB`);
    console.log(`Fingerprint: ${manifest.fingerprint}`);
    console.log('It holds the game\'s data and sprites: copy it to your own server only, never commit it or push an image holding it to a public registry.');
  } catch (error) {
    if (error instanceof BundleError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
