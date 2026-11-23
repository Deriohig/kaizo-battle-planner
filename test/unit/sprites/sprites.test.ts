// The sprites: the form sprites' table, the DS graphics readers and sprite decryption, the PNG encoder, and the cache.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RomError } from '../../../src/errors.js';
import { ICON_PALETTE_SIGNATURE, iconPaletteTable, NOT_EXTRACTED, readyManifest, SPRITES_VERSION, type SpriteSource, writeSpritesFrom } from '../../../src/sprites/extract.js';
import { FORM_SPRITES, isShiny, saveSpriteForm, spriteFileName, spriteFormOf, spriteIds } from '../../../src/sprites/forms.js';
import { decryptPlatinum, readNcgr, readNclr, scannedWindow, tiledImage } from '../../../src/sprites/nitro.js';
import { crc32, encodeIndexedPng, type Rgb } from '../../../src/sprites/png.js';
import { pngChunks, readIndexedPng } from './pngRead.js';

describe('the form sprites', () => {
  it("lie in pl_otherpoke.narc's sprites 0–153 and palettes 154–247, each form's own; their icons after species 493", () => {
    const [characters, icons] = [new Set<number>(), new Set<number>()];
    for (const [species, sprites] of Object.entries(FORM_SPRITES)) {
      for (let form = 0; form < sprites.forms; form++) {
        for (const character of [sprites.front(form), sprites.back(form)]) {
          expect([species, form, character >= 0 && character < 154 && !characters.has(character)]).toEqual([species, form, true]);
          characters.add(character);
        }
        const [plain, shiny] = [sprites.palette(form, false), sprites.palette(form, true)];
        expect([species, form, plain !== shiny && [plain, shiny].every((p) => p >= 154 && p < 248)]).toEqual([species, form, true]);
        const icon = sprites.icon(form);
        expect([species, form, form === 0 ? icon === null : icon === null || (icon > 502 && icon < 547 && !icons.has(icon))]).toEqual([species, form, true]);
        if (icon !== null) icons.add(icon);
      }
    }
    // The eggs (132, 133) are the only sprites below 154 no form uses.
    expect([...Array(154).keys()].filter((i) => !characters.has(i))).toEqual([132, 133]);
    // 503–546 but 506 (Unown A, form 0's): Deoxys 3, Unown 27, Burmy 2, Wormadam 2, Shellos, Gastrodon, Giratina, Shaymin, Rotom 5.
    expect([...icons].sort((a, b) => a - b)).toEqual([...Array(44).keys()].map((i) => 503 + i).filter((i) => i !== 506));
  });

  // Base or unknown formes, and Mothim's cloak (no look of its own), are none.
  it.each([
    [479, 'Wash', 2], [479, 'Mow', 5], [487, 'Origin', 1], [492, 'Sky', 1], [386, 'Speed', 3], [201, 'B', 1], [201, 'Question', 27],
    [351, 'Snowy', 3], [421, 'Sunshine', 1], [412, 'Trash', 2], [423, 'East', 1], [493, 'Fighting', 1], [493, 'Fire', 10], [493, 'Dark', 17],
    [479, '', undefined], [487, '', undefined], [25, '', undefined], [25, 'Cosplay', undefined], [479, 'Toaster', undefined], [414, 'Sandy', undefined],
  ])("reads species %i's battle forme %j as sprite form %s, by the forms table's names (Arceus by type)", (num, forme, form) => expect(spriteFormOf(num, forme)).toBe(form));

  // A save's form counts when it has a sprite and is not 0; Mothim keeps its cloak in the form bits, with no look of its own.
  it.each([[479, 5, 5], [201, 27, 27], [479, 0, undefined], [479, 6, undefined], [25, 1, undefined], [414, 1, undefined]])(
    "reads species %i's save form %i as sprite form %s", (species, form, sprite) => {
      expect(saveSpriteForm(species, form)).toBe(sprite);
      expect(spriteIds(species, form)).toEqual(sprite === undefined ? { speciesId: species } : { speciesId: species, formId: sprite });
    });

  it('is shiny when trainer ID, secret ID and the two PID halves XOR below 8', () => {
    const [tid, sid, low] = [12345, 54321, 0x1234];
    const pid = (high: number) => ((high << 16) | low) >>> 0;
    expect([0, 7, 8].map((xor) => isShiny(pid(tid ^ sid ^ low ^ xor), (sid << 16) | tid))).toEqual([true, true, false]);
    expect([isShiny(0xffffffff, 0), isShiny(0x12345678, 0)]).toEqual([true, false]);
  });

  it('names the cache files', () =>
    expect([spriteFileName(394), spriteFileName(394, 0, true), spriteFileName(479, 2), spriteFileName(479, 2, true)])
      .toEqual(['394.png', '394-shiny.png', '479-2.png', '479-2-shiny.png']));
});

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** An NCLR file of `colours` (BGR555 words). */
function nclr(colours: number[]): Uint8Array {
  const out = new Uint8Array(0x28 + colours.length * 2);
  const view = new DataView(out.buffer);
  out.set(ascii('RLCN'), 0);
  out.set(ascii('TTLP'), 0x10);
  [[0x14, 0x18 + colours.length * 2], [0x18, 3], [0x20, colours.length * 2], [0x24, 0x10]].forEach(([at, word]) => view.setUint32(at!, word!, true));
  colours.forEach((c, i) => view.setUint16(0x28 + i * 2, c, true));
  return out;
}

/** An NCGR file holding `data`, with the RAHC fields given. */
function ncgr(data: Uint8Array, opts: { height?: number; width?: number; depth?: number; scanned?: boolean } = {}): Uint8Array {
  const out = new Uint8Array(0x30 + data.length);
  const view = new DataView(out.buffer);
  out.set(ascii('RGCN'), 0);
  out.set(ascii('RAHC'), 0x10);
  view.setUint16(0x18, opts.height ?? 0xffff, true);
  view.setUint16(0x1a, opts.width ?? 0xffff, true);
  [[0x1c, opts.depth ?? 3], [0x24, opts.scanned ? 1 : 0], [0x28, data.length], [0x2c, 0x18]].forEach(([at, word]) => view.setUint32(at!, word!, true));
  out.set(data, 0x30);
  return out;
}

/** Plain words encrypted as Platinum's sprites are, from `seed`: word 0 is the seed (it decrypts to 0), each next one XORed. */
function encrypt(plain: number[], seed: number): Uint8Array {
  const out = new Uint8Array(plain.length * 2);
  let s = BigInt(seed);
  plain.forEach((word, i) => {
    const cipher = i === 0 ? seed : word ^ Number(s & 0xffffn);
    [out[i * 2], out[i * 2 + 1]] = [cipher & 0xff, cipher >> 8];
    s = (s * 0x41c64e6dn + 0x6073n) & 0xffffffffn;
  });
  return out;
}

describe('the DS graphics readers', () => {
  it('reads NCLR colours as BGR555 widened to 8 bits a channel', () =>
    expect(readNclr(nclr([0x7fff, 0x001f, 0x03e0, 0x7c00, 0x0000, 0x4210])))
      .toEqual([[255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 0, 0], [132, 132, 132]]));

  it('reads NCGR data and layout; refuses a wrong magic, 8 bits a pixel and data past the end', () => {
    const data = Uint8Array.of(0x21, 0x43);
    const file = ncgr(data, { height: 10, width: 20, scanned: true });
    expect(readNcgr(file)).toEqual({ data, heightTiles: 10, widthTiles: 20, scanned: true });
    expect(readNcgr(ncgr(data)).widthTiles).toBeNull();
    expect(() => readNcgr(ncgr(data, { depth: 4 }))).toThrow(/bit depth 4/);
    for (const bad of [() => readNcgr(nclr([0])), () => readNcgr(file.subarray(0, file.length - 1)), () => readNclr(ncgr(data))]) expect(bad).toThrow(RomError);
  });

  it("decrypts Platinum's sprite data forwards from the first word's seed; the first word comes out 0", () => {
    const plain = [0, 0x1234, 0xffff, 0x0000, 0xbeef];
    const out = decryptPlatinum(encrypt(plain, 0x9706));
    expect(Array.from({ length: plain.length }, (_, i) => out[i * 2]! | (out[i * 2 + 1]! << 8))).toEqual(plain);
    expect(() => decryptPlatinum(new Uint8Array(3))).toThrow(RomError);
  });

  it('takes a window of scanned rows, the low nibble first', () => {
    // A 4×2 image, 4 pixels a row: row 0 is 1 2 3 4, row 1 is 5 6 7 8.
    const data = Uint8Array.of(0x21, 0x43, 0x65, 0x87);
    expect([...scannedWindow(data, 4, 0, 0, 4, 2)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...scannedWindow(data, 4, 1, 1, 2, 1)]).toEqual([6, 7]);
    expect(() => scannedWindow(data, 4, 0, 0, 4, 3)).toThrow(RomError);
  });

  it('lays 8×8 tiles out in order, row by row of tiles', () => {
    // Two tiles, every pixel of the first 1 and of the second 2, laid two across.
    const data = new Uint8Array(64).fill(0x11, 0, 32).fill(0x22, 32, 64);
    const image = tiledImage(data, 0, 2, 1);
    expect([image.length, ...image.subarray(0, 16)]).toEqual([128, ...Array(8).fill(1), ...Array(8).fill(2)]);
    expect([...tiledImage(data, 1, 1, 1)]).toEqual(Array(64).fill(2));
    expect(() => tiledImage(data, 1, 2, 1)).toThrow(RomError);
  });

  it('finds the icon palette table by its signature, read from species 0; nowhere or twice is a RomError', () => {
    const table = [...ICON_PALETTE_SIGNATURE, 2, 1, 0];
    const arm9 = Uint8Array.from([9, 9, 9, ...table, 7]);
    expect([...iconPaletteTable(arm9, table.length)]).toEqual(table);
    expect(() => iconPaletteTable(Uint8Array.of(1, 2, 3), 3)).toThrow(/nowhere/);
    expect(() => iconPaletteTable(Uint8Array.from([...table, ...table]), 3)).toThrow(/more than once/);
    expect(() => iconPaletteTable(arm9, arm9.length)).toThrow(/runs past/);
  });
});

describe('the PNG encoder', () => {
  const PALETTE: Rgb[] = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [16, 32, 48]];

  it('computes CRC-32 as PNG and zlib do: IEND, and "123456789"', () =>
    expect(['IEND', '123456789'].map((text) => crc32(new TextEncoder().encode(text)))).toEqual([0xae426082, 0xcbf43926]));

  it('writes the signature, IHDR (8-bit indexed), PLTE, tRNS with index 0 transparent, IDAT and IEND, each chunk CRC checked', () => {
    const png = encodeIndexedPng(3, 2, Uint8Array.of(0, 1, 2, 3, 2, 1), PALETTE);
    const image = readIndexedPng(png);
    expect({ ...image, pixels: [...image.pixels] }).toEqual({
      chunks: ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'], width: 3, height: 2, bitDepth: 8, colourType: 3, palette: PALETTE, trns: [0], pixels: [0, 1, 2, 3, 2, 1] });
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let at = 8;
    for (const chunk of pngChunks(png)) {
      expect(view.getUint32(at + 8 + chunk.data.length), chunk.type).toBe(crc32(png.subarray(at + 4, at + 8 + chunk.data.length)));
      at += 12 + chunk.data.length;
    }
  });

  it.each<[string, number, number, Uint8Array, readonly Rgb[]]>([
    ['a bad size', 0, 1, new Uint8Array(0), PALETTE],
    ['a pixel count that does not match', 2, 2, new Uint8Array(3), PALETTE],
    ['a palette of 0 colours', 1, 1, new Uint8Array(1), []],
    ['a palette of over 256 colours', 1, 1, new Uint8Array(1), Array.from({ length: 257 }, (): Rgb => [0, 0, 0])],
    ['an index past the palette', 1, 1, Uint8Array.of(4), PALETTE],
  ])('refuses %s', (_, width, height, pixels, palette) => expect(() => encodeIndexedPng(width, height, pixels, palette)).toThrow(RangeError));
});

// The sprite cache, written from a fake source (`writeSpritesFrom`), and what counts as ready (`readyManifest`).
const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** A fresh parent folder, and the cache folder in it. */
function cacheDir(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sprites-write-'));
  made.push(parent);
  return path.join(parent, 'sprites');
}
/** The files beside the cache folder: only the cache itself once an extract ends. */
const besides = (dir: string) => fs.readdirSync(path.dirname(dir));

/** A source of `count` species, species 2 with 3 forms; its PNGs say what they are; it throws on species `failAt`. */
const fake = (count: number, failAt?: number): SpriteSource => ({
  gameCode: 'TEST', count,
  forms: (species) => (species === 2 ? 3 : 1),
  png(kind, species, form = 0, shiny = false) {
    if (species === failAt) throw new Error(`no sprite ${species}`);
    return new TextEncoder().encode(`${kind} ${species} ${form} ${shiny}`);
  },
});

describe('the sprite cache', () => {
  it('writes each species and form, front and back also shiny, then the manifest; it then reads as ready', async () => {
    const dir = cacheDir();
    const manifest = await writeSpritesFrom(fake(3), dir);
    expect(manifest).toEqual({
      version: SPRITES_VERSION, gameCode: 'TEST', species: 3, forms: 2, shiny: true,
      kinds: ['front', 'back', 'icon'], sizes: { front: 80, back: 80, icon: 32 }, notExtracted: NOT_EXTRACTED,
    });
    const battle = ['1.png', '1-shiny.png', '2.png', '2-shiny.png', '2-1.png', '2-1-shiny.png', '2-2.png', '2-2-shiny.png', '3.png', '3-shiny.png'];
    for (const kind of ['front', 'back']) expect(fs.readdirSync(path.join(dir, kind)).sort()).toEqual(battle.sort());
    expect(fs.readdirSync(path.join(dir, 'icon')).sort()).toEqual(['1.png', '2-1.png', '2-2.png', '2.png', '3.png']);
    expect(fs.readFileSync(path.join(dir, 'back', '2-1-shiny.png'), 'utf8')).toBe('back 2 1 true');
    expect(fs.readFileSync(path.join(dir, 'icon', '2-2.png'), 'utf8')).toBe('icon 2 2 false');
    expect([readyManifest(dir), besides(dir)]).toEqual([manifest, ['sprites']]);
  });

  it("removes a stopped extract's temp folder before it writes", async () => {
    const dir = cacheDir();
    fs.mkdirSync(`${dir}.tmp-1-2/front`, { recursive: true });
    fs.writeFileSync(`${dir}.tmp-1-2/front/1.png`, 'old');
    await writeSpritesFrom(fake(2), dir);
    expect(besides(dir)).toEqual(['sprites']);
  });

  it('a failed extract keeps the cache there was and leaves no temp folder', async () => {
    const dir = cacheDir();
    const first = await writeSpritesFrom(fake(3), dir);
    await expect(writeSpritesFrom(fake(3, 2), dir)).rejects.toThrow('no sprite 2');
    expect([readyManifest(dir), besides(dir)]).toEqual([first, ['sprites']]);
    const none = cacheDir();
    await expect(writeSpritesFrom(fake(3, 1), none)).rejects.toThrow();
    expect(besides(none)).toEqual([]);
  });

  it('is not ready without a manifest, with another version, or with a kind missing its first or last species', async () => {
    const dir = cacheDir();
    expect(readyManifest(dir)).toBeNull();
    await writeSpritesFrom(fake(3), dir);
    fs.rmSync(path.join(dir, 'back', '3.png'));
    expect(readyManifest(dir)).toBeNull();
    await writeSpritesFrom(fake(3), dir);
    const file = path.join(dir, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), version: SPRITES_VERSION - 1 }));
    expect(readyManifest(dir)).toBeNull();
  });
});
