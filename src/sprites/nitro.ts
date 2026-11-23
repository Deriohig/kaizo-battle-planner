// The DS graphics files the sprites come from: NCLR palettes and NCGR character data (Nitro "RLCN" and "RGCN"), and
// Platinum's encryption of the battle sprites' character data.
//
// - NCLR: a 16-byte file header, then the TTLP chunk at 0x10: magic, size, bit depth, a word, the data's size and its
//   offset from the chunk's eighth byte. Colours are BGR555 (bits 0–4 red, 5–9 green, 10–14 blue), widened to 8 bits.
// - NCGR: a 16-byte file header, then the RAHC chunk at 0x10: magic, size, height and width in tiles (u16 each, 0xFFFF
//   for "not given"), bit depth (3: 4 bits a pixel), the mapping, the layout (1: scanned rows, 0: 8×8 tiles), the data's
//   size and its offset from the chunk's eighth byte. Two pixels a byte, the low nibble first.
// - Platinum encrypts a battle sprite's character data as u16 words: the seed is the first word, and each word is XORed
//   with the low 16 bits of the seed, which then steps as the game's LCG (× 0x41C64E6D + 0x6073). Diamond and Pearl seed
//   from the last word and run backwards; Platinum runs forwards. Checked on the hack's ROM: only this way round leaves
//   a front sprite mostly index 0 (86% for Bulbasaur, against 4–7% for the other three ways).

import { RomError } from '../errors.js';
import type { Rgb } from './png.js';

const CHUNK_AT = 0x10;
const LCG_MULTIPLIER = 0x41c64e6d;
const LCG_INCREMENT = 0x6073;
const BPP4 = 3;
const SCANNED = 1;

function magicAt(file: Uint8Array, at: number, magic: string, what: string): void {
  const found = String.fromCharCode(...file.subarray(at, at + 4));
  if (found !== magic) throw new RomError('BAD_FORMAT', `${what}: expected ${magic} at 0x${at.toString(16)}, found ${JSON.stringify(found)}`);
}

const viewOf = (file: Uint8Array) => new DataView(file.buffer, file.byteOffset, file.byteLength);

/** The colours of an NCLR file, in order (every palette of it, 16 colours each for a 4-bit one). */
export function readNclr(file: Uint8Array, what = 'NCLR'): Rgb[] {
  magicAt(file, 0, 'RLCN', what);
  magicAt(file, CHUNK_AT, 'TTLP', what);
  const view = viewOf(file);
  const size = view.getUint32(CHUNK_AT + 0x10, true);
  const start = CHUNK_AT + 8 + view.getUint32(CHUNK_AT + 0x14, true);
  if (start + size > file.length) throw new RomError('BAD_FORMAT', `${what}: ${size} bytes of colours at 0x${start.toString(16)} run past its ${file.length}`);
  return Array.from({ length: size >> 1 }, (_, i) => {
    const c = view.getUint16(start + i * 2, true);
    const widen = (v: number) => (v << 3) | (v >> 2);
    return [widen(c & 31), widen((c >> 5) & 31), widen((c >> 10) & 31)] as const;
  });
}

/** An NCGR file's character data and layout. */
export interface Ncgr { data: Uint8Array; widthTiles: number | null; heightTiles: number | null; scanned: boolean }

/** An NCGR file's 4-bit character data (a view into `file`) with its layout; anything but 4 bits a pixel is a RomError. */
export function readNcgr(file: Uint8Array, what = 'NCGR'): Ncgr {
  magicAt(file, 0, 'RGCN', what);
  magicAt(file, CHUNK_AT, 'RAHC', what);
  const view = viewOf(file);
  const tiles = (at: number) => { const n = view.getUint16(CHUNK_AT + at, true); return n === 0xffff ? null : n; };
  const depth = view.getUint32(CHUNK_AT + 0x0c, true);
  if (depth !== BPP4) throw new RomError('BAD_FORMAT', `${what}: bit depth ${depth}, not 4 bits a pixel (3)`);
  const size = view.getUint32(CHUNK_AT + 0x18, true);
  const start = CHUNK_AT + 8 + view.getUint32(CHUNK_AT + 0x1c, true);
  if (start + size > file.length) throw new RomError('BAD_FORMAT', `${what}: ${size} bytes of pixels at 0x${start.toString(16)} run past its ${file.length}`);
  return { data: file.subarray(start, start + size), heightTiles: tiles(0x08), widthTiles: tiles(0x0a), scanned: view.getUint32(CHUNK_AT + 0x14, true) === SCANNED };
}

/** `data` (u16 words, little-endian) decrypted as Platinum decrypts a battle sprite, into a new array. */
export function decryptPlatinum(data: Uint8Array): Uint8Array {
  if (data.length % 2 !== 0) throw new RomError('BAD_FORMAT', `encrypted sprite data of ${data.length} bytes is not whole u16 words`);
  const out = new Uint8Array(data.length);
  if (data.length === 0) return out;
  let seed = data[0]! | (data[1]! << 8);
  for (let i = 0; i < data.length; i += 2) {
    const word = (data[i]! | (data[i + 1]! << 8)) ^ (seed & 0xffff);
    out[i] = word & 0xff;
    out[i + 1] = word >> 8;
    seed = (Math.imul(seed, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
  }
  return out;
}

/** The low-nibble-first pixel `i` of 4-bit `data`. */
const nibble = (data: Uint8Array, i: number) => (data[i >> 1]! >> ((i & 1) * 4)) & 15;

/**
 * The `width` × `height` window at (`left`, `top`) of scanned 4-bit `data` whose rows are `stride` pixels wide, one
 * palette index a byte.
 */
export function scannedWindow(data: Uint8Array, stride: number, left: number, top: number, width: number, height: number): Uint8Array {
  if (stride * (top + height) > data.length * 2 || left + width > stride) throw new RomError('BAD_FORMAT', `a ${width}×${height} window at (${left}, ${top}) does not fit ${data.length * 2} pixels ${stride} wide`);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[y * width + x] = nibble(data, (top + y) * stride + left + x);
  return out;
}

/**
 * The image of 4-bit 8×8 tiles in `data`, taken in order from `firstTile` and laid `widthTiles` across and
 * `heightTiles` down (the DS's one-dimensional object mapping), one palette index a byte.
 */
export function tiledImage(data: Uint8Array, firstTile: number, widthTiles: number, heightTiles: number): Uint8Array {
  const tileBytes = 32;
  if ((firstTile + widthTiles * heightTiles) * tileBytes > data.length) throw new RomError('BAD_FORMAT', `${widthTiles * heightTiles} tiles from tile ${firstTile} run past ${data.length} bytes`);
  const width = widthTiles * 8;
  const out = new Uint8Array(width * heightTiles * 8);
  for (let t = 0; t < widthTiles * heightTiles; t++) {
    const base = (firstTile + t) * tileBytes * 2;   // in pixels
    const tx = (t % widthTiles) * 8;
    const ty = Math.floor(t / widthTiles) * 8;
    for (let p = 0; p < 64; p++) out[(ty + (p >> 3)) * width + tx + (p & 7)] = nibble(data, base + p);
  }
  return out;
}
