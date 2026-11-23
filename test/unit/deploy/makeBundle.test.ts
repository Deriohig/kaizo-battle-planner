// The hosted data bundle (scripts/makeBundle.ts) over a fixture data folder: dummy files at every path the loaders read,
// and a small sprite cache. The data check is a stand-in, so the real loaders are not run.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUNDLE_DIR, BUNDLE_MANIFEST, BundleError, bundleFiles, makeBundle, packBundle } from '../../../scripts/makeBundle.js';
import type { BundleManifest } from '../../../src/contracts/hosted.js';
import { dataFiles, stampData } from '../../../src/integration/fingerprint.js';
import { ROM_SCHEMA_VERSION } from '../../../src/rom/extract.js';

type Options = Parameters<typeof makeBundle>[0];
const SPRITES = ['sprites/manifest.json', 'sprites/front/1.png', 'sprites/back/1.png', 'sprites/icon/1.png', 'sprites/front/479-1-shiny.png'];

let root = '', data = '', out = '';
let checked: string[] = [];
const check = (dir: string) => (checked.push(dir), { spriteVersion: 2 });
const bundled = () => path.join(out, BUNDLE_DIR);

function put(dir: string, file: string, text = `${file} bytes`): void {
  const full = path.join(dir, ...file.split('/'));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, text);
}

/** Every file below `dir`, relative with `/` separators, sorted ([] when there is no `dir`). */
const listed = (dir: string): string[] => (!existsSync(dir) ? [] : readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
  .sort());

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pkp-bundle-'));
  data = path.join(root, 'data');
  out = path.join(root, 'dist', 'bundle');
  checked = [];
  for (const file of [...dataFiles().map((entry) => entry.file), ...SPRITES]) put(data, file);
  // What the loaders never read stays out: the ROM folder, saves, the docs tabs no loader reads.
  put(data, 'roms/Platinum Kaizo.nds', 'a ROM');
  put(data, 'saves/game.dsv', 'a save');
  put(data, 'docs/Locations.csv');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('makeBundle', () => {
  it('copies exactly the loaded files and the sprite cache, checked before and after, with a bundle.json of their hashes', () => {
    put(data, 'sprites/icon/999.png');
    makeBundle({ dataDir: data, outDir: out, check });
    rmSync(path.join(data, 'sprites', 'icon', '999.png'));
    checked = [];
    const when = new Date('2026-11-21T12:00:00.000Z');
    const returned = makeBundle({ dataDir: data, outDir: out, check, now: () => when });
    // A file gone from the data is gone from the bundle that replaces the earlier one.
    expect(listed(bundled())).toEqual([...dataFiles().map((entry) => entry.file), ...SPRITES, BUNDLE_MANIFEST].sort());
    expect(checked[0]).toBe(data);
    expect(path.relative(out, checked[1]!)).toMatch(/^pkp-data\.tmp-/);
    expect(readdirSync(out)).toEqual([BUNDLE_DIR]);

    const manifest = JSON.parse(readFileSync(path.join(bundled(), BUNDLE_MANIFEST), 'utf8')) as BundleManifest;
    expect(manifest).toEqual(returned);
    expect(manifest).toMatchObject({ bundleVersion: 1, createdAt: when.toISOString(), gameCode: 'JAK7', romSchemaVersion: ROM_SCHEMA_VERSION, spriteVersion: 2 });
    expect(manifest.files.map((file) => file.path)).toEqual(listed(bundled()).filter((file) => file !== BUNDLE_MANIFEST));
    for (const file of manifest.files) {
      const bytes = readFileSync(path.join(data, ...file.path.split('/')));
      expect(file).toEqual({ path: file.path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    expect([manifest.fingerprint, stampData(bundled()).content]).toEqual([stampData(data).content, stampData(data).content]);
  });

  it('leaves out, and names, a file below sprites/ that is not the cache', () => {
    put(data, 'sprites/Thumbs.db');
    put(data, 'sprites/front/notes.txt');
    const warned: string[] = [];
    makeBundle({ dataDir: data, outDir: out, check, warn: (message) => warned.push(message) });
    expect(listed(bundled())).not.toContain('sprites/front/notes.txt');
    expect(warned).toEqual(['Left out of the bundle, not part of the sprite cache: sprites/Thumbs.db, sprites/front/notes.txt']);
    expect(bundleFiles(data).skipped).toEqual(['sprites/Thumbs.db', 'sprites/front/notes.txt']);
  });

  it.each<[string, () => Partial<Options>, RegExp]>([
    ['a pkp-data folder that is not a bundle', () => (put(out, `${BUNDLE_DIR}/live-server-file`), {}), /is there and is not a bundle/],
    ...['sprites/front/game.NDS', 'sprites/icon/backup.sav', 'sprites/x.dsv'].map((file): [string, () => Partial<Options>, RegExp] =>
      [`a ROM or save in the sprite cache (${file})`, () => (put(data, file), {}), new RegExp(`Refusing to bundle a ROM or a save: ${file.replace('.', '\\.')}`)]),
    ["missing PKCalc files", () => (rmSync(path.join(data, 'pkcalc'), { recursive: true }), {}), /PKCalc's files are missing .*npm run record:diffs/],
    ['a failing data check', () => ({ check: () => { throw new BundleError('No complete sprite cache; run npm run sprites'); } }), /run npm run sprites/],
    ['an --out that is the data folder', () => ({ outDir: data }), /must not hold one another/],
    ['a data folder inside --out', () => ({ dataDir: bundled() }), /must not hold one another/],
  ])('refuses %s and writes nothing', (_, arrange, error) => {
    const options = { dataDir: data, outDir: out, check, ...arrange() };
    const before = listed(out);
    expect(() => makeBundle(options)).toThrow(error);
    expect(listed(out)).toEqual(before);
    expect(existsSync(path.join(data, BUNDLE_DIR))).toBe(false);
  });

  it("bundles without PKCalc's files with --allow-no-pkcalc, and into the data folder's parent", () => {
    rmSync(path.join(data, 'pkcalc'), { recursive: true });
    const manifest = makeBundle({ dataDir: data, outDir: root, check, allowNoPkcalc: true });
    expect(manifest.files.some((file) => file.path.startsWith('pkcalc/'))).toBe(false);
    expect(manifest.fingerprint).toBe(stampData(data).content);
  });

  it('packs pkp-data.tar.gz holding the bundle, and leaves no bundle, temp folder or older tarball behind a failed run', () => {
    makeBundle({ dataDir: data, outDir: out, check });
    const names = spawnSync('tar', ['-tzf', packBundle(out)], { encoding: 'utf8' }).stdout.split('\n');
    expect(names).toEqual(expect.arrayContaining([`${BUNDLE_DIR}/${BUNDLE_MANIFEST}`, `${BUNDLE_DIR}/rom/romdata.json`]));
    expect(names.some((name) => /\.(nds|dsv|sav)$/i.test(name))).toBe(false);
    let calls = 0;
    const failsOnTheCopy = (dir: string) => {
      calls += 1;
      if (calls === 2) throw new BundleError(`the copy in ${dir} does not load`);
      return { spriteVersion: 2 };
    };
    expect(() => makeBundle({ dataDir: data, outDir: out, check: failsOnTheCopy })).toThrow('does not load');
    // The earlier bundle stays; the tarball, which might not match it, is gone; no temp folder.
    expect(readdirSync(out)).toEqual([BUNDLE_DIR]);
  });
});
