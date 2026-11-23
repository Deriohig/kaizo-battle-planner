import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BundleManifest } from '../../../src/contracts/hosted.js';
import { MissingDataError } from '../../../src/data/load.js';
import { DATA_UNSTABLE_MESSAGE, type DataStamp } from '../../../src/integration/fingerprint.js';
import { ROM_SCHEMA_VERSION } from '../../../src/rom/extract.js';
import { checkStaticDir, HostedDataError, loadHostedData } from '../../../src/server/hostedData.js';
import { SPRITE_KINDS, SPRITE_SIZE, type SpriteManifest, SPRITES_VERSION } from '../../../src/sprites/extract.js';
import { serverData } from './fixtures.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const FINGERPRINT = 'f'.repeat(64);
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MANIFEST: SpriteManifest = {
  version: SPRITES_VERSION, gameCode: 'JAK7', species: 3, forms: 0, shiny: true, kinds: SPRITE_KINDS, sizes: SPRITE_SIZE, notExtracted: [],
};

function write(dir: string, file: string, content: string | Uint8Array): void {
  const full = path.join(dir, ...file.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-data-test-'));
  dirs.push(dir);
  return dir;
}

/** A temp data folder: a data file and a sprite cache the loader takes. */
function dataDir(): string {
  const dir = tempDir();
  write(dir, 'rom/romdata.json', '{"stand-in":true}');
  write(dir, 'sprites/manifest.json', JSON.stringify(MANIFEST));
  for (const kind of SPRITE_KINDS) for (const species of [1, 2, 3]) write(dir, `sprites/${kind}/${species}.png`, `png ${kind} ${species}`);
  return dir;
}

/** Every file under `dir` but bundle.json, as `bundle.json` lists them: `/` separators, sorted by path. */
function listFiles(dir: string): BundleManifest['files'] {
  const files = (fs.readdirSync(dir, { recursive: true }) as string[]).map((rel) => rel.split(path.sep).join('/'));
  return files.filter((rel) => rel !== 'bundle.json' && fs.statSync(path.join(dir, rel)).isFile()).sort().map((rel) => {
    const bytes = fs.readFileSync(path.join(dir, rel));
    return { path: rel, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}

/** Writes a bundle.json over `dir` files, with `patch` on top; returns what it wrote. */
function writeBundle(dir: string, patch: Record<string, unknown> = {}): BundleManifest {
  const bundle = {
    bundleVersion: 1, createdAt: '2026-11-21T10:00:00.000Z', gameCode: 'JAK7', romSchemaVersion: ROM_SCHEMA_VERSION, spriteVersion: SPRITES_VERSION,
    fingerprint: FINGERPRINT, files: listFiles(dir), ...patch,
  } as BundleManifest;
  write(dir, 'bundle.json', JSON.stringify(bundle));
  return bundle;
}

/** A stamp that answers each of `contents` in turn (the last one from then on). */
function stamps(...contents: string[]): (dir: string) => DataStamp {
  let call = 0;
  return () => ({ content: contents[Math.min(call++, contents.length - 1)]!, identity: 'x' });
}

type LoadOpts = Partial<Parameters<typeof loadHostedData>[1]>;

/** `loadHostedData` with the fixture data, the stamp `FINGERPRINT` (unless `opts` gives others) and a warn spy. */
function load(dir: string, opts: LoadOpts = {}) {
  return loadHostedData(dir, { warn: vi.fn(), loadData: () => serverData(), stamp: stamps(FINGERPRINT), ...opts });
}

/** The `HostedDataError` message `run` throws, checked to be one line. */
function failure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HostedDataError);
    expect((error as HostedDataError).message).not.toContain('\n');
    return (error as HostedDataError).message;
  }
  throw new Error('Expected a HostedDataError');
}

describe('loadHostedData', () => {
  it('without bundle.json, warns once and loads the data and the sprites, stamping the folder before and after', () => {
    const dir = dataDir();
    const warn = vi.fn();
    const local = serverData();
    const loadData = vi.fn(() => local);
    const stamp = vi.fn(stamps('abc'));
    const loaded = loadHostedData(dir, { warn, loadData, stamp });
    expect([warn.mock.calls, loadData.mock.calls, stamp.mock.calls]).toEqual([[[expect.stringContaining('bundle.json')]], [[dir]], [[dir], [dir]]]);
    const { bundle, sprites, data } = loaded;
    expect([bundle, sprites, data.fingerprint, data.local === local, data.catalog !== undefined, data.moves.size > 0])
      .toEqual([null, MANIFEST, 'abc', true, true, true]);
  });

  it('loads a bundle whose files and fingerprint check out, without a warning, and writes nothing to the folder', () => {
    const dir = dataDir();
    const bundle = writeBundle(dir);
    const before = listFiles(dir);
    const warn = vi.fn();
    const loaded = load(dir, { warn });
    expect([warn.mock.calls, loaded.bundle, loaded.data.fingerprint, listFiles(dir)]).toEqual([[], bundle, FINGERPRINT, before]);
  });

  type Setup = (dir: string) => LoadOpts | void;
  /** A bundle.json with `patch` on top, then `change` to the folder. */
  const bundled = (change: (dir: string) => void = () => undefined, patch?: (dir: string) => Record<string, unknown>): Setup => (dir) => {
    writeBundle(dir, patch?.(dir));
    change(dir);
  };
  const patched = (patch: Record<string, unknown>) => bundled(undefined, () => patch);
  const romdata = (text: string) => bundled((dir) => write(dir, 'rom/romdata.json', text));
  const badPaths = [
    '../outside.json', '/etc/passwd', 'rom/../../outside.json', 'rom/./romdata.json', 'rom\\romdata.json', '', 'rom//romdata.json', 'nul\0.json',
  ];

  // [what, setup (may give load options), words the message holds ($dir: the folder), refused before the data loads].
  it.each<[string, Setup, string[], boolean?]>([
    ['a listed file that is missing', bundled((dir) => fs.rmSync(path.join(dir, 'sprites', 'back', '2.png'))), ['sprites/back/2.png is missing'], true],
    ['a listed file of the wrong size', romdata('{"stand-in":false}'), ['rom/romdata.json is 18 bytes, not 17']],
    ['a listed file whose SHA-256 differs', romdata('{"stand-in":tru3}'), ['rom/romdata.json does not match its SHA-256']],
    ...badPaths.map((bad): [string, Setup, string[]] => [
      `the listed path ${JSON.stringify(bad)}`, bundled(undefined, (dir) => ({ files: [...listFiles(dir), { path: bad, bytes: 0, sha256: EMPTY_SHA }] })),
      ['which is not a path inside the bundle'],
    ]),
    ['a file entry of the wrong shape', patched({ files: [{ path: 'rom/romdata.json', bytes: '17', sha256: 'x' }] }), ['not { path, bytes, sha256 }']],
    ['a bundle without a file list', patched({ files: undefined }), ['lacks its file list']],
    ['another bundle version', patched({ bundleVersion: 2 }), ['bundle version 2', 'npm run bundle']],
    ['another game', patched({ gameCode: 'CPUE' }), ['game "CPUE"', 'npm run bundle']],
    ['another ROM schema', patched({ romSchemaVersion: ROM_SCHEMA_VERSION + 1 }), [`ROM schema ${ROM_SCHEMA_VERSION + 1}`, 'npm run bundle']],
    ['another sprite version', patched({ spriteVersion: SPRITES_VERSION + 1 }), [`sprite version ${SPRITES_VERSION + 1}`, 'npm run bundle']],
    ['a fingerprint that is not a string', patched({ fingerprint: 7 }), ['fingerprint', 'npm run bundle']],
    ['a bundle.json that is not JSON', (dir) => write(dir, 'bundle.json', '{ not json'), ['bundle.json is not JSON']],
    ['a bundle.json that is not an object', (dir) => write(dir, 'bundle.json', '[]'), ['is not an object']],
    ['data whose fingerprint is not the bundle\'s', (dir) => { writeBundle(dir); return { stamp: stamps('0'.repeat(64)) }; },
      ['does not match bundle.json\'s fingerprint']],
    ['data that changed while it loaded', () => ({ stamp: stamps('before', 'after') }), [DATA_UNSTABLE_MESSAGE]],
    ['a MissingDataError from the loader', () => ({ loadData: () => { throw new MissingDataError('No ROM data:\nrun npm run extract'); } }),
      ['No game data in $dir/', 'PKP_DATA']],
    ['any other loader failure', () => ({ loadData: () => { throw new SyntaxError('Unexpected token'); } }), ['cannot be loaded: ']],
    ['a folder without sprites', (dir) => fs.rmSync(path.join(dir, 'sprites'), { recursive: true }), ['No sprites in']],
    ['sprites of another version', (dir) => write(dir, 'sprites/manifest.json', JSON.stringify({ ...MANIFEST, version: SPRITES_VERSION + 1 })),
      ['No sprites in']],
    ['a sprite cache missing a file', (dir) => fs.rmSync(path.join(dir, 'sprites', 'icon', '3.png')), ['No sprites in']],
  ])('refuses %s, in one line', (_, setup, words, beforeLoad) => {
    const dir = dataDir();
    const loadData = vi.fn(() => serverData());
    const message = failure(() => load(dir, { loadData, ...(setup(dir) as LoadOpts | undefined) }));
    for (const word of words) expect(message).toContain(word.replace('$dir', dir));
    if (beforeLoad) expect(loadData).not.toHaveBeenCalled();
  });
});

describe('checkStaticDir', () => {
  it('passes a folder with index.html; refuses one without it, one where it is a folder, and a missing folder', () => {
    const good = tempDir();
    write(good, 'index.html', '<!doctype html>');
    expect(() => checkStaticDir(good)).not.toThrow();
    const dir = tempDir();
    expect(failure(() => checkStaticDir(dir))).toContain('No built page in');
    fs.mkdirSync(path.join(dir, 'index.html'));
    expect(failure(() => checkStaticDir(dir))).toContain('PKP_STATIC');
    expect(failure(() => checkStaticDir(path.join(dir, 'nope')))).toContain('No built page in');
  });
});
