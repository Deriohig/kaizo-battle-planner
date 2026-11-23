// The least a ROM built with buildNds needs for `extractAiData` to succeed, for tests that run the whole extract.

import { WEIGHT_NARCS } from '../../../src/rom/weights.js';
import { OP } from '../../../src/ai/script/opcodes.js';
import { buildNarc } from '../../fixtures/buildNarc.js';

const ARM9_RAM_ADDRESS = 0x02000000;

/** Little-endian s32s, as the Pokédex data's members hold them. */
function ints(values: number[]): Uint8Array {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, i) => view.setInt32(i * 4, value, true));
  return new Uint8Array(view.buffer);
}

/**
 * The two Pokédex data NARCs the weights come from (src/rom/weights.ts): member 0 the heights, member 1 the weights, for
 * species 0 and 1 (vanilla Bulbasaur's 7 and 69, which species 0 repeats).
 */
function pokedexFiles(): Record<string, Uint8Array> {
  const narc = buildNarc([ints([7, 7]), ints([69, 69])]);
  return { [WEIGHT_NARCS.form0]: narc, [WEIGHT_NARCS.otherForms]: narc };
}

/**
 * Overlay 14: a 32-entry flag table, then PopOrEnd at words 32 and 33. Entry 0 points at word 32, the others at word 33;
 * were they all 32, the table read from word 1 would match too.
 */
function aiOverlay(): Uint8Array {
  const view = new DataView(new ArrayBuffer(34 * 4));
  for (let bit = 0; bit < 32; bit++) view.setUint32(bit * 4, bit === 0 ? 32 : 33, true);
  view.setUint32(32 * 4, OP.PopOrEnd, true);
  view.setUint32(33 * 4, OP.PopOrEnd, true);
  return new Uint8Array(view.buffer);
}

/** Overlay 16: vanilla's first eight type-chart triples (battle_lib.c:2400–2407), the 0xFE separator, the 0xFF terminator. */
function battleOverlay(): Uint8Array {
  return Uint8Array.from([0, 5, 5, 0, 8, 5, 10, 10, 5, 10, 11, 5, 10, 12, 20, 10, 15, 20, 10, 6, 20, 10, 5, 5, 0xfe, 0xfe, 0, 0xff, 0xff, 0]);
}

/**
 * arm9: module params (compressed static end 0, so not compressed; the nitrocode magic at +0x1C), then sItemArchiveIDs
 * for items 0..467: vanilla's first 16 entries (as items.ts searches for them), zeros, and data index 1 for item 467,
 * so the battle's item table holds one record, entry 0.
 */
function arm9(): Uint8Array {
  const vanillaHead = [
    [0, 707, 708, 0], [1, 2, 3, 1], [2, 4, 5, 2], [3, 6, 7, 3], [4, 8, 9, 4], [5, 10, 11, 5], [6, 12, 13, 6], [7, 14, 15, 7],
    [8, 16, 17, 8], [9, 18, 19, 9], [10, 20, 19, 10], [11, 21, 22, 11], [12, 23, 22, 12], [13, 663, 664, 0], [14, 665, 666, 0],
    [15, 667, 668, 0],
  ];
  const paramsSize = 0x24;
  const view = new DataView(new ArrayBuffer(paramsSize + 468 * 8));
  view.setUint32(0x1c, 0xdec00621, true);
  view.setUint32(0x20, 0x2106c0de, true);
  vanillaHead.forEach((ids, item) => ids.forEach((id, i) => view.setUint16(paramsSize + item * 8 + i * 2, id, true)));
  view.setUint16(paramsSize + 467 * 8, 1, true);
  return new Uint8Array(view.buffer);
}

/**
 * Builds a ROM with `build` (which must put `files`, the Pokédex NARCs, in its file system and supply the item data
 * NARC, entry 0 at least 0x1C bytes), then appends a copied FAT, an overlay table with overlays 14 and 16, and arm9.
 */
export function withAiData(build: (files: Record<string, Uint8Array>) => Uint8Array): Uint8Array {
  const base = build(pokedexFiles());
  const baseView = new DataView(base.buffer, base.byteOffset, base.byteLength);
  const fat = base.subarray(baseView.getUint32(0x48, true), baseView.getUint32(0x48, true) + baseView.getUint32(0x4c, true));
  const overlays = [{ id: 14, bytes: aiOverlay() }, { id: 16, bytes: battleOverlay() }];
  const code = arm9();

  // Layout after the base ROM: the FAT with two more entries, the overlay table, the overlays, then arm9.
  const fatAt = base.length;
  const ovtAt = fatAt + fat.length + overlays.length * 8;
  const overlayAt: number[] = [];
  let at = ovtAt + overlays.length * 32;
  for (const { bytes } of overlays) {
    overlayAt.push(at);
    at += bytes.length;
  }
  const arm9At = at;
  const rom = new Uint8Array(arm9At + code.length);
  const view = new DataView(rom.buffer);
  rom.set(base);
  rom.set(fat, fatAt);
  view.setUint32(0x48, fatAt, true);
  view.setUint32(0x4c, fat.length + overlays.length * 8, true);
  view.setUint32(0x50, ovtAt, true);
  view.setUint32(0x54, overlays.length * 32, true);
  overlays.forEach(({ id, bytes }, i) => {
    const fileId = fat.length / 8 + i;
    view.setUint32(fatAt + fileId * 8, overlayAt[i]!, true);
    view.setUint32(fatAt + fileId * 8 + 4, overlayAt[i]! + bytes.length, true);
    // Overlay table entry: id, RAM address, RAM size, BSS size, static-init start and end, file ID, flags (uncompressed).
    view.setUint32(ovtAt + i * 32, id, true);
    view.setUint32(ovtAt + i * 32 + 8, bytes.length, true);
    view.setUint32(ovtAt + i * 32 + 24, fileId, true);
    rom.set(bytes, overlayAt[i]!);
  });
  view.setUint32(0x20, arm9At, true);
  view.setUint32(0x28, ARM9_RAM_ADDRESS, true);
  view.setUint32(0x2c, code.length, true);
  rom.set(code, arm9At);
  return rom;
}
