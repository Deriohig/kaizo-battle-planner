import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureSprites, SPRITE_CACHE_CONTROL } from '../../../src/server/sprites.js';
import { closeServers, type Harness, removeLater, start } from './harness.js';

afterEach(async () => { await closeServers(); vi.restoreAllMocks(); });

const BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 1, 2, 3);

/** A server whose sprite cache holds `files` (path under data/sprites, contents). */
async function withSprites(files: [string, string | Uint8Array][]): Promise<Harness> {
  const h = await start();
  for (const [rel, contents] of files) {
    const file = path.join(h.dir, 'data', 'sprites', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return h;
}

describe('GET /api/sprites/{kind}/{species}.png', () => {
  it('answers a cached sprite as image/png with a cache header and an ETag; that ETag in If-None-Match is a 304', async () => {
    const h = await withSprites([['front/394.png', BYTES]]);
    const url = `${h.url}/api/sprites/front/394.png`;
    const res = await fetch(url);
    expect([res.status, res.headers.get('content-type'), res.headers.get('cache-control')]).toEqual([200, 'image/png', SPRITE_CACHE_CONTROL]);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-z]+-[0-9a-z]+"$/);
    expect((await fetch(url, { headers: { 'If-None-Match': etag } })).status).toBe(304);
    expect((await fetch(url, { headers: { 'If-None-Match': '"other"' } })).status).toBe(200);
  });

  it('answers forms and shiny sprites by name: -0 is the species\' own, a shiny icon is the normal icon', async () => {
    const h = await withSprites([
      ['front/479-2.png', 'wash'], ['front/479-2-shiny.png', 'wash shiny'], ['back/394-shiny.png', 'prinplup shiny'], ['front/479.png', 'rotom'],
      ['icon/479-2.png', 'wash icon'],
    ]);
    for (const [p, want] of [
      ['front/479-2.png', 'wash'], ['front/479-2-shiny.png', 'wash shiny'], ['back/394-shiny.png', 'prinplup shiny'], ['front/479-0.png', 'rotom'],
      ['icon/479-2-shiny.png', 'wash icon'], ['front/479-3.png', 404],
    ] as const) {
      const res = await fetch(`${h.url}/api/sprites/${p}`);
      expect(res.status === 200 ? await res.text() : res.status, p).toBe(want);
    }
  });

  it('is 404 with words for a sprite not in the cache, another kind or a species that is not a number from 1; 405 for another method', async () => {
    const h = await start();
    for (const p of [
      'front/1.png', 'icon/493.png', 'shiny/1.png', 'front/0.png', 'front/01.png', 'front/x.png', 'front/1.gif', 'front/../box.png', 'front',
      'front/479-02.png', 'front/479-shiny-2.png', 'front/479-100.png', 'front/479-.png', 'front/479-shiny.png.png',
    ]) {
      const res = await fetch(`${h.url}/api/sprites/${p}`);
      expect([res.status, (await res.json() as { error: string }).error], p).toEqual([404, expect.stringMatching(/sprite/)]);
    }
    const res = await fetch(`${h.url}/api/sprites/front/1.png`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect([res.status, res.headers.get('allow')]).toEqual([405, 'GET']);
  });
});

it('ensureSprites without a ROM, or with a file that is not one, makes no cache and logs one line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprites-'));
  removeLater(dir);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await expect(ensureSprites(dir, null)).resolves.toBeUndefined();
  expect(log.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/no ROM at .*roms\/plat-kaizo-nightmare-update-final\.nds/)]);
  const rom = path.join(dir, 'bad.nds');
  fs.writeFileSync(rom, new Uint8Array(0x200));
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await ensureSprites(dir, rom);
  expect(error.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/^Sprites: cannot extract them from /)]);
  expect(fs.readdirSync(dir)).toEqual(['bad.nds']);
});
