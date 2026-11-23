// Diffs an ARM9 overlay of the hack against vanilla's. Overlay 14 (trainer_ai.c, then the AI script) is the same size in
// both, so its bytes are compared in place and each changed region is named by the function it falls in. Overlay 16
// (the battle code) is longer in the hack, so its halfwords are aligned first. A changed region that only re-points a
// call, branch, PC-relative load or pointer at code that moved is told apart as a relocation.

import { OPCODES } from '../script/opcodes.js';

/** A run of changed bytes, `start` to `end` (exclusive), in the function or symbol `fn` it starts in. */
export interface ByteRegion { start: number; end: number; inScript: boolean; fn: string | null }

/** The AI script's symbol (script.s:15). A region in it is `inScript`. */
export const SCRIPT_SYMBOL = 'gTrainerAITable';
/** The command table's symbol (trainer_ai.c:207). */
export const COMMAND_TABLE_SYMBOL = 'sAICommandTable';
/** Changed bytes fewer than this many bytes apart belong to one region. */
const MERGE_GAP = 4;

/**
 * The changed regions of two overlays of the same size, compared byte by byte. Each is named by `names` (symbol start
 * offset → name): `fn` is the symbol with the greatest start at or before the region's start, or null if none.
 */
export function diffOverlay(vanilla: Uint8Array, hack: Uint8Array, names: Map<number, string>): ByteRegion[] {
  if (vanilla.length !== hack.length) {
    throw new RangeError(`the overlays differ in size (${vanilla.length} and ${hack.length} bytes): align them with alignHalfwords`);
  }
  const starts = [...names.keys()].sort((a, b) => a - b);
  const symbolAt = (offset: number) => {
    let found: number | undefined;
    for (const start of starts) {
      if (start > offset) break;
      found = start;
    }
    return found === undefined ? null : names.get(found)!;
  };

  const regions: ByteRegion[] = [];
  let open: { start: number; end: number } | null = null;
  const close = () => {
    if (open === null) return;
    const fn = symbolAt(open.start);
    regions.push({ start: open.start, end: open.end, inScript: fn === SCRIPT_SYMBOL, fn });
    open = null;
  };
  for (let offset = 0; offset < vanilla.length; offset++) {
    if (vanilla[offset] === hack[offset]) continue;
    if (open !== null && offset - open.end < MERGE_GAP) {
      open.end = offset + 1;
    } else {
      close();
      open = { start: offset, end: offset + 1 };
    }
  }
  close();
  return regions;
}

/** The offset of sAICommandTable in overlay 14 loaded at `base`: the one run of 109 Thumb pointers into the overlay. */
export function findCommandTable(overlay: Uint8Array, base: number): number {
  const view = new DataView(overlay.buffer, overlay.byteOffset, overlay.byteLength);
  const isHandler = (offset: number) => {
    const pointer = view.getUint32(offset, true);
    return (pointer & 1) === 1 && pointer - 1 >= base && pointer - 1 < base + overlay.length;
  };
  const hits: number[] = [];
  for (let offset = 0; offset + OPCODES.length * 4 <= overlay.length; offset += 4) {
    let run = 0;
    while (run < OPCODES.length && isHandler(offset + run * 4)) run++;
    if (run === OPCODES.length) hits.push(offset);
  }
  if (hits.length !== 1) throw new Error(`expected one run of ${OPCODES.length} Thumb pointers in overlay 14, found ${hits.length}`);
  return hits[0]!;
}

/**
 * Names for overlay 14 (loaded at `base`), by start offset. Each AICmd_* handler comes from sAICommandTable, whose
 * entries follow the AICMD_* order of OPCODES (trainer_ai.c:207–209). The other trainer_ai.c functions are inferred by
 * counting `push {…, lr}` prologues (0xB5xx) between two handlers, in source order; a name found that way ends in
 * " (inferred)". Where the counts differ, each prologue gets an address name like pret's (`ov14_0221FD20`). The command
 * table and the script (at `scriptOffset`) are named too.
 */
export function aiFunctionNames(overlay: Uint8Array, base: number, trainerAiC: string, scriptOffset: number): Map<number, string> {
  const view = new DataView(overlay.buffer, overlay.byteOffset, overlay.byteLength);
  const table = findCommandTable(overlay, base);
  const source = sourceFunctions(trainerAiC);
  const sourceIndex = new Map(source.map((name, index) => [name, index]));
  const handlers = OPCODES.map((op, k) => {
    const name = `AICmd_${op.name}`;
    const index = sourceIndex.get(name);
    if (index === undefined) throw new Error(`trainer_ai.c defines no ${name}`);
    return { offset: view.getUint32(table + k * 4, true) - 1 - base, name, index };
  }).sort((a, b) => a.offset - b.offset);
  handlers.forEach((handler, k) => {
    if (k > 0 && handler.index <= handlers[k - 1]!.index) {
      throw new Error(`${handler.name} comes before ${handlers[k - 1]!.name} in trainer_ai.c but after it in overlay 14`);
    }
  });

  const prologues: number[] = [];
  for (let offset = 0; offset + 2 <= scriptOffset; offset += 2) {
    if ((view.getUint16(offset, true) & 0xff00) === 0xb500) prologues.push(offset);
  }
  const names = new Map<number, string>();
  const bounds = [{ offset: -1, index: -1 }, ...handlers, { offset: scriptOffset, index: source.length }];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const from = bounds[k]!;
    const to = bounds[k + 1]!;
    const functions = source.slice(from.index + 1, to.index);
    const between = prologues.filter((offset) => offset > from.offset && offset < to.offset);
    between.forEach((offset, i) => {
      const name = functions.length === between.length ? `${functions[i]} (inferred)` : `ov14_${hex(base + offset, 8)}`;
      names.set(offset, name);
    });
  }
  for (const handler of handlers) names.set(handler.offset, handler.name);
  names.set(table, COMMAND_TABLE_SYMBOL);
  names.set(scriptOffset, SCRIPT_SYMBOL);
  return names;
}

/** The functions trainer_ai.c defines, in source order: each body opens with `{` alone on a line after its signature. */
function sourceFunctions(trainerAiC: string): string[] {
  const lines = trainerAiC.split('\n');
  return lines.flatMap((line, i) => {
    if (line.trimEnd() !== '{' || i === 0) return [];
    const name = /(\w+)\s*\(/.exec(lines[i - 1]!)?.[1];
    return name === undefined ? [] : [name];
  });
}

/** Two changed byte ranges, vanilla's and the hack's, each `start` to `end` (exclusive). */
export interface AlignedRegion { vanillaStart: number; vanillaEnd: number; hackStart: number; hackEnd: number }
/** The changed regions of an alignment, and where a vanilla byte offset lands in the hack (null when it has no counterpart). */
export interface Alignment { regions: AlignedRegion[]; toHack(vanillaOffset: number): number | null }

/** How far, in halfwords, the alignment may stray from the diagonal beyond the size difference. */
const BAND = 64;
/** Matched runs shorter than this (in halfwords) are not trusted as anchors: the changes around them merge. */
const MIN_ANCHOR = 8;

/**
 * Aligns two overlays as little-endian halfwords: a longest common subsequence within a band around the diagonal, then
 * only matched runs of MIN_ANCHOR or more are kept. Between two kept runs, equal-length stretches are compared in place
 * (a region per run of changed halfwords) and other stretches are one region each.
 */
export function alignHalfwords(vanilla: Uint8Array, hack: Uint8Array): Alignment {
  if (vanilla.length % 2 !== 0 || hack.length % 2 !== 0) throw new RangeError('overlays to align must have an even length');
  const a = halfwords(vanilla);
  const b = halfwords(hack);
  const runs = matchedRuns(longestCommonSubsequence(a, b)).filter((run) => run.length >= MIN_ANCHOR);

  const vToH = new Int32Array(a.length).fill(-1);
  const regions: AlignedRegion[] = [];
  let v = 0;
  let h = 0;
  for (const run of [...runs, { v: a.length, h: b.length, length: 0 }]) {
    if (run.v - v === run.h - h) {
      let open = -1;
      for (let k = 0; k <= run.v - v; k++) {
        const changed = k < run.v - v && a[v + k] !== b[h + k];
        if (k < run.v - v) vToH[v + k] = h + k;
        if (changed && open < 0) open = k;
        if (!changed && open >= 0) {
          regions.push({ vanillaStart: (v + open) * 2, vanillaEnd: (v + k) * 2, hackStart: (h + open) * 2, hackEnd: (h + k) * 2 });
          open = -1;
        }
      }
    } else {
      regions.push({ vanillaStart: v * 2, vanillaEnd: run.v * 2, hackStart: h * 2, hackEnd: run.h * 2 });
    }
    for (let k = 0; k < run.length; k++) vToH[run.v + k] = run.h + k;
    v = run.v + run.length;
    h = run.h + run.length;
  }
  return {
    regions,
    toHack: (offset) => {
      if (offset % 2 !== 0 || offset < 0 || offset >= vanilla.length) return null;
      const mapped = vToH[offset / 2]!;
      return mapped < 0 ? null : mapped * 2;
    },
  };
}

function halfwords(bytes: Uint8Array): Uint16Array {
  const out = new Uint16Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8);
  return out;
}

/** Index pairs of a longest common subsequence of `a` and `b`, found within BAND of the diagonal, in order. */
function longestCommonSubsequence(a: Uint16Array, b: Uint16Array): [number, number][] {
  const n = a.length;
  const m = b.length;
  // Cell (i, j) is stored at row i, column j - i - kLo.
  const kLo = Math.min(0, m - n) - BAND;
  const kHi = Math.max(0, m - n) + BAND;
  const width = kHi - kLo + 1;
  const UP = 1;
  const LEFT = 2;
  const DIAGONAL = 3;
  const step = new Uint8Array((n + 1) * width);
  let previous = new Int32Array(width).fill(-1);
  let current = new Int32Array(width).fill(-1);
  for (let k = Math.max(kLo, 0); k <= Math.min(kHi, m); k++) {
    previous[k - kLo] = 0;
    step[k - kLo] = LEFT;
  }
  for (let i = 1; i <= n; i++) {
    current.fill(-1);
    for (let k = kLo; k <= kHi; k++) {
      const j = i + k;
      if (j < 0 || j > m) continue;
      const c = k - kLo;
      if (j === 0) {
        current[c] = 0;
        step[i * width + c] = UP;
      } else if (a[i - 1] === b[j - 1] && previous[c]! >= 0) {
        current[c] = previous[c]! + 1;
        step[i * width + c] = DIAGONAL;
      } else {
        const up = c + 1 < width ? previous[c + 1]! : -1;
        const left = c > 0 ? current[c - 1]! : -1;
        current[c] = Math.max(up, left);
        step[i * width + c] = up >= left ? UP : LEFT;
      }
    }
    [previous, current] = [current, previous];
  }

  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const move = step[i * width + (j - i - kLo)];
    if (move === DIAGONAL) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (move === UP) {
      i--;
    } else {
      j--;
    }
  }
  return pairs.reverse();
}

/** Consecutive pairs `(i, j), (i + 1, j + 1), …` grouped into runs. */
function matchedRuns(pairs: [number, number][]): { v: number; h: number; length: number }[] {
  const runs: { v: number; h: number; length: number }[] = [];
  for (const [i, j] of pairs) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.v + last.length === i && last.h + last.length === j) last.length++;
    else runs.push({ v: i, h: j, length: 1 });
  }
  return runs;
}

/** An overlay's bytes and the address it is loaded at. */
export interface CodeImage { bytes: Uint8Array; base: number }

/**
 * A changed instruction or word that still refers to the same thing: a BL (or BLX) or branch whose target, a
 * PC-relative load whose loaded value, or a pointer whose value is vanilla's carried over by `toHack`. `at` is the
 * vanilla offset of the instruction or word; the targets are the addresses (or, for a load, the values) it refers to.
 */
export interface Relocation { kind: 'bl' | 'branch' | 'literal' | 'pointer'; at: number; vanillaTarget: number; hackTarget: number }

/**
 * The relocations that account for every changed halfword of an equal-length region, or null if any changed halfword
 * is something else. `toHack` carries a vanilla address to the hack's (null when it has no counterpart).
 */
export function explainRegion(
  vanilla: CodeImage, hack: CodeImage, region: AlignedRegion, toHack: (address: number) => number | null,
): Relocation[] | null {
  const size = region.vanillaEnd - region.vanillaStart;
  if (size === 0 || size !== region.hackEnd - region.hackStart) return null;
  const found = new Map<string, Relocation>();
  for (let x = region.vanillaStart; x < region.vanillaEnd; x += 2) {
    const y = region.hackStart + (x - region.vanillaStart);
    if (halfwordAt(vanilla, x) === halfwordAt(hack, y)) continue;
    const relocation = explainHalfword(vanilla, hack, x, y, toHack);
    if (relocation === null) return null;
    found.set(`${relocation.kind}@${relocation.at}`, relocation);
  }
  return [...found.values()];
}

/** The relocation that changed vanilla's halfword at `x` into the hack's at `y`, if there is one. */
function explainHalfword(vanilla: CodeImage, hack: CodeImage, x: number, y: number, toHack: (address: number) => number | null): Relocation | null {
  const mapValue = (value: number) => {
    const thumb = value & 1;
    const mapped = toHack(value - thumb);
    return mapped === null ? null : mapped + thumb;
  };
  // A BL is two halfwords; the changed one is either.
  for (const back of [2, 0]) {
    const from = blTarget(vanilla, x - back);
    const to = blTarget(hack, y - back);
    if (from && to && from.exchange === to.exchange && toHack(from.target) === to.target) {
      return { kind: 'bl', at: x - back, vanillaTarget: from.target, hackTarget: to.target };
    }
  }
  const branchFrom = branchTarget(vanilla, x);
  const branchTo = branchTarget(hack, y);
  if (branchFrom && branchTo && branchFrom.condition === branchTo.condition && toHack(branchFrom.target) === branchTo.target) {
    return { kind: 'branch', at: x, vanillaTarget: branchFrom.target, hackTarget: branchTo.target };
  }
  const loadFrom = literalLoad(vanilla, x);
  const loadTo = literalLoad(hack, y);
  if (loadFrom && loadTo && loadFrom.register === loadTo.register && mapValue(loadFrom.value) === loadTo.value) {
    return { kind: 'literal', at: x, vanillaTarget: loadFrom.value, hackTarget: loadTo.value };
  }
  // A pointer is a 4-aligned word; the changed halfword is either half.
  for (const back of [0, 2]) {
    if ((vanilla.base + x - back) % 4 !== 0 || (hack.base + y - back) % 4 !== 0) continue;
    const from = wordAt(vanilla, x - back);
    const to = wordAt(hack, y - back);
    if (from !== null && to !== null && mapValue(from) === to) return { kind: 'pointer', at: x - back, vanillaTarget: from, hackTarget: to };
  }
  return null;
}

/** The target of a Thumb BL or BLX pair at `offset`: `F000+hi11`, then `F800+lo11` (BL) or `E800+lo11` (BLX). */
export function blTarget(image: CodeImage, offset: number): { target: number; exchange: boolean } | null {
  const first = halfwordAt(image, offset);
  const second = halfwordAt(image, offset + 2);
  if (first === null || second === null || (first & 0xf800) !== 0xf000) return null;
  const exchange = (second & 0xf800) === 0xe800;
  if (!exchange && (second & 0xf800) !== 0xf800) return null;
  const displacement = signExtend(((first & 0x7ff) << 12) | ((second & 0x7ff) << 1), 23);
  const target = image.base + offset + 4 + displacement;
  return { target: exchange ? target & ~3 : target, exchange };
}

/** The target of a Thumb B<cond> (`Dcxx`, cond below 14) or B (`E0xx`–`E7xx`) at `offset`; condition 14 means B. */
function branchTarget(image: CodeImage, offset: number): { target: number; condition: number } | null {
  const value = halfwordAt(image, offset);
  if (value === null) return null;
  const pc = image.base + offset + 4;
  if ((value & 0xf000) === 0xd000 && ((value >> 8) & 0xf) < 0xe) {
    return { target: pc + signExtend((value & 0xff) << 1, 9), condition: (value >> 8) & 0xf };
  }
  if ((value & 0xf800) === 0xe000) return { target: pc + signExtend((value & 0x7ff) << 1, 12), condition: 0xe };
  return null;
}

/** The register and loaded word of a Thumb `ldr rd, [pc, #imm]` (`48xx`–`4Fxx`) at `offset`. */
function literalLoad(image: CodeImage, offset: number): { register: number; value: number } | null {
  const value = halfwordAt(image, offset);
  if (value === null || (value & 0xf800) !== 0x4800) return null;
  const address = ((image.base + offset + 4) & ~3) + (value & 0xff) * 4;
  const loaded = wordAt(image, address - image.base);
  return loaded === null ? null : { register: (value >> 8) & 7, value: loaded };
}

export function halfwordAt(image: CodeImage, offset: number): number | null {
  if (offset < 0 || offset + 2 > image.bytes.length) return null;
  return image.bytes[offset]! | (image.bytes[offset + 1]! << 8);
}

export function wordAt(image: CodeImage, offset: number): number | null {
  if (offset < 0 || offset + 4 > image.bytes.length) return null;
  const bytes = image.bytes;
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function signExtend(value: number, bits: number): number {
  const sign = 1 << (bits - 1);
  return (value & (sign - 1)) - (value & sign);
}

function hex(value: number, digits: number): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}
