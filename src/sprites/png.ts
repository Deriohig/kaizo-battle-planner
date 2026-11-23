// A minimal PNG encoder for indexed images (colour type 3, bit depth 8) on node's zlib: the IHDR, PLTE and tRNS chunks,
// one IDAT of filter-0 rows, and IEND. Palette index 0 is fully transparent, as on the DS; every other index is opaque.

import { deflateSync } from 'node:zlib';

/** An opaque colour, 0–255 a channel. */
export type Rgb = readonly [number, number, number];

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const COLOUR_TYPE_INDEXED = 3;
const MAX_COLOURS = 256;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The PNG CRC-32 of `bytes` (ISO 3309, as zlib's). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A PNG of a `width` × `height` image whose pixels (row by row, one byte each) index `palette`; index 0 is transparent.
 * Throws a RangeError for a size or palette the format cannot hold, or a pixel past the palette's end.
 */
export function encodeIndexedPng(width: number, height: number, pixels: Uint8Array, palette: readonly Rgb[]): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError(`a PNG must be at least 1×1, not ${width}×${height}`);
  if (pixels.length !== width * height) throw new RangeError(`${width}×${height} pixels need ${width * height} bytes, not ${pixels.length}`);
  if (palette.length < 1 || palette.length > MAX_COLOURS) throw new RangeError(`a palette holds 1 to ${MAX_COLOURS} colours, not ${palette.length}`);
  for (const index of pixels) if (index >= palette.length) throw new RangeError(`pixel index ${index} is past the ${palette.length}-colour palette`);

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;                     // bit depth
  header[9] = COLOUR_TYPE_INDEXED;   // compression, filter and interlace stay 0

  const plte = new Uint8Array(palette.length * 3);
  palette.forEach(([r, g, b], i) => plte.set([r, g, b], i * 3));

  const rows = new Uint8Array(height * (width + 1));   // each row: filter type 0, then its pixels
  for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);

  const parts = [SIGNATURE, chunk('IHDR', header), chunk('PLTE', plte), chunk('tRNS', Uint8Array.of(0)), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
