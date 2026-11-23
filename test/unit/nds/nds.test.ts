// The DS file readers: NARC archives, the NDS file system and game code, and ARM9 overlays with their BLZ compression.

import { describe, expect, it } from 'vitest';
import { RomError } from '../../../src/errors.js';
import { readNarc } from '../../../src/nds/narc.js';
import { readGameCode, readNdsFiles } from '../../../src/nds/ndsFs.js';
import { blzDecompress, readOverlay, readOverlayTable } from '../../../src/nds/overlay.js';
import { buildNarc } from '../../fixtures/buildNarc.js';
import { buildNds } from '../../fixtures/buildNds.js';

/** `prefix` (stored plain), then `region` (the compressed bytes, which the decoder reads backwards), then the 8-byte footer. */
function blz(prefix: number[], region: number[], incLen: number): Uint8Array {
  const footer = new DataView(new ArrayBuffer(8));
  footer.setUint32(0, (region.length + 8) | (8 << 24), true); // encoded length | header length << 24
  footer.setUint32(4, incLen, true);
  return Uint8Array.from([...prefix, ...region, ...new Uint8Array(footer.buffer)]);
}

// `rom` with an ARM9 overlay table appended, the header (0x50 offset, 0x54 size) pointing at it. Each entry is eight
// words: id, RAM address, RAM size, BSS size, static-init start and end, file ID, compressed size | flags << 24.
function withOverlayTable(rom: Uint8Array, entries: number[][]): Uint8Array {
  const out = new Uint8Array(rom.length + entries.length * 32);
  out.set(rom);
  const view = new DataView(out.buffer);
  entries.forEach((words, i) => words.forEach((word, w) => view.setUint32(rom.length + i * 32 + w * 4, word, true)));
  view.setUint32(0x50, rom.length, true);
  view.setUint32(0x54, entries.length * 32, true);
  return out;
}

/** Three literals (1, 2, 3 at the top), then a reference word 0x0000: displacement 0 + 3, length 0 + 3. Flag 0x10. */
const BACK_REFERENCE = blz([], [0x00, 0x00, 1, 2, 3, 0x10], 1);
const overlayRom = (file: Uint8Array, entry: number[]) => withOverlayTable(buildNds({ 'ov.bin': file }), [entry]);

it('readNarc round-trips three files', () => {
  const files = [new Uint8Array([]), new Uint8Array([1, 2, 3]), Uint8Array.from({ length: 44 }, (_, i) => i + 10)];
  expect(readNarc(buildNarc(files)).map((bytes) => [...bytes])).toEqual(files.map((bytes) => [...bytes]));
});

it('readNdsFiles lists nested files with their own bytes, files and subdirectories mixed; readGameCode reads the game code', () => {
  const files = { 'a/b/c.bin': [1, 2], 'top.bin': [9], 'd/one.bin': [1], 'd/sub/deep.bin': [4], 'd/two.bin': [2, 2], 'd/empty.bin': [], 'e/three.bin': [3, 3, 3] };
  const rom = buildNds(Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, Uint8Array.from(bytes)])), 'CPUE');
  expect(Object.fromEntries([...readNdsFiles(rom)].map(([path, bytes]) => [path, [...bytes]]))).toEqual(files);
  expect(readGameCode(rom)).toBe('CPUE');
});

describe('blzDecompress', () => {
  // Decoding runs down from the footer into a buffer incLen (1) bytes longer; the bytes below the run keep their stored values.
  it.each([
    // Flag byte 0: eight literals, taking nine bytes; encLen 17 = 0x11.
    ['a literal-only block', blz([0xaa, 0xbb], [1, 2, 3, 4, 5, 6, 7, 8, 0x00], 1), [0xaa, 0xbb, 1, 2, 3, 4, 5, 6, 7, 8, 0x00, 0x11, 1, 2, 3, 4, 5, 6, 7, 8]],
    // The reference copies the three bytes just written above it, so 1, 2, 3 repeats; encLen 14 = 0x0e.
    ['a back-reference', BACK_REFERENCE, [0x00, 0x00, 1, 2, 3, 0x10, 0x0e, 0x00, 0x00, 1, 2, 3, 1, 2, 3]],
  ])('decodes %s', (_, data, bytes) => expect([...blzDecompress(data)]).toEqual(bytes));
});

it.each([
  // File 0 is a decoy, so the overlay must be found by its entry's file ID (1).
  ['passes an uncompressed overlay through', withOverlayTable(buildNds({ 'a.bin': new Uint8Array([9]), 'ov.bin': Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) }),
    [[3, 0x021d0000, 8, 0x20, 0, 0, 1, 8]]), { id: 3, ramAddress: 0x021d0000, ramSize: 8, bssSize: 0x20, fileId: 1, compressed: false }, [1, 2, 3, 4, 5, 6, 7, 8]],
  ['decompresses a compressed overlay', overlayRom(BACK_REFERENCE, [0, 0x021d0000, 15, 0, 0, 0, 0, BACK_REFERENCE.length | (1 << 24)]),
    { id: 0, ramAddress: 0x021d0000, ramSize: 15, bssSize: 0, fileId: 0, compressed: true }, [...blzDecompress(BACK_REFERENCE)]],
])('readOverlay %s, found by its table entry', (_, rom, entry, bytes) => {
  expect(readOverlayTable(rom)).toEqual([entry]);
  expect([...readOverlay(rom, entry.id)]).toEqual(bytes);
});

it.each([
  ['readNarc on bad magic', () => readNarc(new Uint8Array(16))],
  ['readOverlay for a missing overlay', () => readOverlay(overlayRom(new Uint8Array([1]), [0, 0x021d0000, 1, 0, 0, 0, 0, 1]), 14)],
])('%s throws RomError BAD_FORMAT', (_, read) => {
  expect(read).toThrow(RomError);
  expect(read).toThrow(expect.objectContaining({ code: 'BAD_FORMAT' }));
});
