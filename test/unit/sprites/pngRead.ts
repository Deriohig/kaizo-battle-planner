// A PNG reader for the sprite tests: the chunks in order, and an indexed 8-bit image's size, palette, transparency and
// pixels (filter 0 rows only, as src/sprites/png.ts writes them).

import { inflateSync } from 'node:zlib';

export interface PngChunk { type: string; data: Uint8Array }
export interface IndexedPng { width: number; height: number; bitDepth: number; colourType: number; palette: number[][]; trns: number[]; pixels: Uint8Array; chunks: string[] }

export function pngChunks(png: Uint8Array): PngChunk[] {
  if (![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => png[i] === b)) throw new Error('not a PNG: bad signature');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: PngChunk[] = [];
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at);
    chunks.push({ type: String.fromCharCode(...png.subarray(at + 4, at + 8)), data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
}

export function readIndexedPng(png: Uint8Array): IndexedPng {
  const chunks = pngChunks(png);
  const get = (type: string) => chunks.find((c) => c.type === type)?.data ?? new Uint8Array(0);
  const header = new DataView(get('IHDR').buffer, get('IHDR').byteOffset, 13);
  const width = header.getUint32(0);
  const height = header.getUint32(4);
  const plte = get('PLTE');
  const rows = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    if (rows[y * (width + 1)] !== 0) throw new Error(`row ${y} has filter ${rows[y * (width + 1)]}, not 0`);
    pixels.set(rows.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return {
    width, height, bitDepth: header.getUint8(8), colourType: header.getUint8(9),
    palette: Array.from({ length: plte.length / 3 }, (_, i) => [...plte.subarray(i * 3, i * 3 + 3)]),
    trns: [...get('tRNS')], pixels, chunks: chunks.map((c) => c.type),
  };
}
