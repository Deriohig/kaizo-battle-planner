// Reads the ARM9 overlay table (OVT) and the overlay files, which may be compressed with the NDS backward LZ (BLZ).

import { RomError } from '../errors.js';

const FAT_OFFSET = 0x48;
const OVT_OFFSET = 0x50;
const OVT_SIZE_OFFSET = 0x54;
const OVT_ENTRY_SIZE = 32;
/** An entry's last word holds the compressed size in bits 0–23 and a flag byte above it; flag bit 0 marks BLZ. */
const FLAG_SHIFT = 24;
const FLAG_COMPRESSED = 1;
const BLZ_FOOTER_SIZE = 8;

export interface OverlayEntry { id: number; ramAddress: number; ramSize: number; bssSize: number; fileId: number; compressed: boolean }

/** The ARM9 overlay table: 32 bytes per entry, at the header's offset 0x50 (its size at 0x54). */
export function readOverlayTable(rom: Uint8Array): OverlayEntry[] {
  const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const start = view.getUint32(OVT_OFFSET, true);
  const count = Math.floor(view.getUint32(OVT_SIZE_OFFSET, true) / OVT_ENTRY_SIZE);
  return Array.from({ length: count }, (_, i) => {
    const word = (w: number) => view.getUint32(start + i * OVT_ENTRY_SIZE + w * 4, true);
    // Words 4 and 5 (the static initialiser range) are not needed.
    return {
      id: word(0),
      ramAddress: word(1),
      ramSize: word(2),
      bssSize: word(3),
      fileId: word(6),
      compressed: ((word(7) >>> FLAG_SHIFT) & FLAG_COMPRESSED) !== 0,
    };
  });
}

/** Overlay `id`'s bytes, decompressed when its entry says so. An uncompressed overlay is a view into `rom`. */
export function readOverlay(rom: Uint8Array, id: number): Uint8Array {
  const entry = readOverlayTable(rom).find((candidate) => candidate.id === id);
  if (!entry) throw new RomError('BAD_FORMAT', `the ROM has no ARM9 overlay ${id}`);
  const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  // FAT entry: u32 start, u32 end.
  const fatEntry = view.getUint32(FAT_OFFSET, true) + entry.fileId * 8;
  const bytes = rom.subarray(view.getUint32(fatEntry, true), view.getUint32(fatEntry + 4, true));
  return entry.compressed ? blzDecompress(bytes) : bytes;
}

/**
 * Decompresses NDS backward LZ, as overlays and arm9.bin use it. The last eight bytes are a footer: u32
 * `encLen | hdrLen << 24`, then u32 `incLen`. The bytes before `length - encLen` are stored plain. The rest is read
 * backwards from `length - hdrLen` and written backwards from the end of a buffer `incLen` bytes longer. Each flag byte
 * covers the next eight items, high bit first: a clear bit is one literal byte; a set bit is a u16 reference that
 * copies `(ref >> 12) + 3` bytes from `(ref & 0xfff) + 3` bytes above. An `incLen` of 0 means not compressed.
 */
export function blzDecompress(data: Uint8Array): Uint8Array {
  if (data.length < BLZ_FOOTER_SIZE) throw new RomError('BAD_FORMAT', `BLZ data of ${data.length} bytes has no footer`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lengths = view.getUint32(data.length - 8, true);
  const incLen = view.getUint32(data.length - 4, true);
  if (incLen === 0) return data.slice();
  const hdrLen = lengths >>> 24;
  const encLen = lengths & 0xffffff;
  if (hdrLen < BLZ_FOOTER_SIZE || hdrLen > encLen || encLen > data.length) {
    throw new RomError('BAD_FORMAT', `bad BLZ footer: encLen ${encLen}, hdrLen ${hdrLen}, ${data.length} bytes`);
  }

  const out = new Uint8Array(data.length + incLen);
  out.set(data);
  const end = data.length - encLen;
  let src = data.length - hdrLen;
  let dst = out.length;
  while (src > end) {
    let flags = out[--src]!;
    for (let item = 0; item < 8 && src > end; item++, flags <<= 1) {
      if (flags & 0x80) {
        src -= 2;
        const ref = out[src]! | (out[src + 1]! << 8);
        const disp = (ref & 0x0fff) + 3;
        for (let n = (ref >> 12) + 3; n > 0; n--) {
          dst--;
          out[dst] = out[dst + disp]!;
        }
      } else {
        out[--dst] = out[--src]!;
      }
    }
  }
  return out;
}
