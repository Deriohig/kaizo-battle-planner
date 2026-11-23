// The Pokémon sprites over HTTP, from the cache src/sprites/extract.ts writes into `<dataDir>/sprites/`:
// - `GET /api/sprites/{front|back|icon}/{species}[-{form}][-shiny].png` answers the PNG with a week's cache header and
//   an ETag, and 404 (JSON, as every API failure) for a path outside that shape, a species or form without a sprite, or
//   no cache yet, so the page falls back. `-0` is the species' own sprite; a shiny icon is the normal one.
// - `ensureSprites` makes the cache when it is missing: `main.ts` calls it once the server is up, and the first-run
//   setup once its extract is done. It costs one small file read when the cache is there, and while it extracts (a few
//   seconds) it yields after each species, so the server answers meanwhile.

import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { oneLineMessage as oneLine } from '../docs/fetchDocs.js';
import { readyManifest, writeSprites } from '../sprites/extract.js';
import { spriteFileName } from '../sprites/forms.js';
import { HttpError } from './http.js';
import { ROM_FILE_NAME } from './setup.js';

export const SPRITE_PREFIX = '/api/sprites/';
/**
 * A week, and not immutable: the URL has no version, and a re-extract (a new cache version, forms added) must show. The
 * ETag (the file's size and time) lets the browser check a stale one with a 304.
 */
export const SPRITE_CACHE_CONTROL = 'public, max-age=604800';
/** `{kind}/{species}[-{form}][-shiny].png`: no leading zeros; form 0 is the species' own. */
const SPRITE_PATH = /^\/api\/sprites\/(front|back|icon)\/([1-9]\d{0,3})(?:-(0|[1-9]\d?))?(-shiny)?\.png$/;

/** The sprite cache of the data folder `dataDir`. */
export const spritesDir = (dataDir: string): string => path.join(dataDir, 'sprites');

/**
 * Answers `GET <pathname>` (under `SPRITE_PREFIX`) from the cache in `dataDir`, or 304 when `If-None-Match` names its
 * ETag; `HttpError` 404 when there is no such sprite.
 */
export async function sendSprite(req: IncomingMessage, res: ServerResponse, dataDir: string, pathname: string, cacheControl = SPRITE_CACHE_CONTROL): Promise<void> {
  const match = SPRITE_PATH.exec(pathname);
  if (match === null) throw new HttpError(404, `No sprite at ${pathname}: sprites are at /api/sprites/{front|back|icon}/{species}[-{form}][-shiny].png`);
  const [, kind, species, form, shiny] = match;
  // Icons have no shiny colours: a shiny icon is the normal one.
  const name = spriteFileName(Number(species), Number(form ?? 0), shiny !== undefined && kind !== 'icon');
  const file = path.join(spritesDir(dataDir), kind!, name);
  let png: Buffer;
  let etag: string;
  try {
    const stat = await fs.promises.stat(file);
    etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
      res.end();
      return;
    }
    png = await fs.promises.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, `No ${kind} sprite ${name}`);
    throw error;
  }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': cacheControl, ETag: etag });
  res.end(png);
}

/**
 * Makes the sprite cache of the data folder `dataDir` from the ROM at `romPath` (null: `<dataDir>/roms/` and the hack's
 * file name) when it is missing or of another version. Resolves once done or skipped, never rejects: no ROM, or one it
 * cannot extract, is one log line. One extract runs at a time for a data folder; a call while one runs waits for it.
 */
export type SpriteEnsurer = (dataDir: string, romPath: string | null) => Promise<void>;

/** The extract running for each data folder. */
const running = new Map<string, Promise<void>>();

export const ensureSprites: SpriteEnsurer = (dataDir, romPath) => {
  const key = path.resolve(dataDir);
  const already = running.get(key);
  if (already !== undefined) return already;
  const run = (async () => {
    const dir = spritesDir(dataDir);
    if (readyManifest(dir) !== null) return;
    const rom = romPath ?? path.join(dataDir, 'roms', ROM_FILE_NAME);
    let bytes: Uint8Array;
    try {
      bytes = await fs.promises.readFile(rom);
    } catch {
      console.log(`Sprites: none in ${dir}/ and no ROM at ${rom} to extract them from (npm run sprites -- --rom <path>)`);
      return;
    }
    const started = Date.now();
    try {
      const manifest = await writeSprites(bytes, dir);
      console.log(`Sprites: ${manifest.species} species extracted into ${dir}/ in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    } catch (error) {
      console.error(`Sprites: cannot extract them from ${rom}: ${oneLine(error)}`);
    }
  })().finally(() => {
    running.delete(key);
  });
  running.set(key, run);
  return run;
};
