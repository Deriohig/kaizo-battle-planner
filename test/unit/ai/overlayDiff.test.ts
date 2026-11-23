// The overlay diff tools: byte regions, halfword alignment, and the command handlers' layout and comparison.

import { describe, expect, it } from 'vitest';
import {
  comparePair, diffFunctions, findEntryPoints, layoutOverlay, readTable, type SourceFunction, sourceFunctions,
} from '../../../src/ai/diff/handlerDiff.js';
import { alignHalfwords, type CodeImage, diffOverlay, explainRegion, SCRIPT_SYMBOL } from '../../../src/ai/diff/overlayDiff.js';

const BASE = 0x02200000;
const PUSH = 0xb510; // push {r4, lr}
const POP = 0xbd10; // pop {r4, pc}
const NOP = 0x46c0;

/** A little-endian image of `length` bytes, filled with halfwords and words at their offsets. */
function image(length: number, halfwords: [number, number][], words: [number, number][] = []): CodeImage {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  for (const [at, value] of halfwords) view.setUint16(at, value, true);
  for (const [at, value] of words) view.setUint32(at, value >>> 0, true);
  return { bytes, base: BASE };
}
/** Little-endian bytes of `halfwords`. */
const bytes = (halfwords: number[]) => image(halfwords.length * 2, halfwords.map((value, i) => [i * 2, value])).bytes;

/** The two halfwords of a Thumb BL at `from` to `to`. */
function bl(from: number, to: number): [number, number] {
  const offset = to - (from + 4);
  return [0xf000 | ((offset >> 12) & 0x7ff), 0xf800 | ((offset >> 1) & 0x7ff)];
}
const blBytes = (from: number, to: number) => bl(from, to).flatMap((half) => [half & 0xff, half >> 8]);
/** `code` with `bytes` written at `at`. */
function patched(code: CodeImage, at: number, bytes: number[]): CodeImage {
  code.bytes.set(bytes, at);
  return code;
}

it('diffOverlay names each region by its function and flags the script', () => {
  const vanilla = new Uint8Array(64);
  const hack = vanilla.slice();
  for (const at of [5, 7, 20, 40]) hack[at] = 1; // 7 is less than 4 bytes after 5: the same region
  expect(diffOverlay(vanilla, hack, new Map([[0, 'A'], [16, 'B'], [32, SCRIPT_SYMBOL]]))).toEqual([
    { start: 5, end: 8, inScript: false, fn: 'A' },
    { start: 20, end: 21, inScript: false, fn: 'B' },
    { start: 40, end: 41, inScript: true, fn: SCRIPT_SYMBOL },
  ]);
});

it('alignHalfwords reports an insertion and a change, and maps the code after the insertion', () => {
  const vanilla = Array.from({ length: 40 }, (_, i) => 0x1000 + i);
  const hack = [...vanilla.slice(0, 10), 0xaaaa, 0xbbbb, ...vanilla.slice(10)];
  hack[30] = 0x2222; // vanilla's halfword 28, changed in place
  const alignment = alignHalfwords(bytes(vanilla), bytes(hack));
  expect(alignment.regions).toEqual([
    { vanillaStart: 20, vanillaEnd: 20, hackStart: 20, hackEnd: 24 },
    { vanillaStart: 56, vanillaEnd: 58, hackStart: 60, hackEnd: 62 },
  ]);
  expect([18, 20, 56].map((offset) => alignment.toHack(offset))).toEqual([18, 24, 60]);
});

it('explainRegion recognises a BL re-pointed at a function that moved, and nothing else', () => {
  // A BL at offset 4 calls 0x40, which moves to 0x48 in the hack.
  const nops = () => image(0x60, Array.from({ length: 0x30 }, (_, i) => [i * 2, NOP]));
  const vanilla = patched(nops(), 4, blBytes(4, 0x40));
  const hack = patched(nops(), 4, blBytes(4, 0x48));
  const moved = (address: number) => (address >= BASE + 0x40 ? address + 8 : address);
  const region = { vanillaStart: 6, vanillaEnd: 8, hackStart: 6, hackEnd: 8 };
  expect(explainRegion(vanilla, hack, region, moved)).toEqual([{ kind: 'bl', at: 4, vanillaTarget: BASE + 0x40, hackTarget: BASE + 0x48 }]);
  expect(explainRegion(vanilla, hack, region, (address) => address)).toBeNull();
  // A changed instruction that neither branches nor loads.
  const other = patched({ bytes: vanilla.bytes.slice(), base: BASE }, 20, [0x00, 0x28]);
  expect(explainRegion(vanilla, other, { vanillaStart: 20, vanillaEnd: 22, hackStart: 20, hackEnd: 22 }, moved)).toBeNull();
});

/** `ldr r0, [pc, #…]` at `at` that loads the word at `literal`. */
const ldr = (at: number, literal: number) => 0x4800 | ((literal - ((at + 4) & ~3)) / 4);

/**
 * A tiny overlay: HandlerA (0x00) calls Helper and loads a pointer to it; HandlerB (0x10) holds `mov r0, #imm` and
 * `extra` more halfwords; Helper follows with its own literal pool; then a spacer word and the two-entry command table.
 */
function overlay(imm: number, extra: number[] = []): CodeImage {
  const helper = 0x18 + 2 * extra.length;
  const helperPool = helper + 8;
  const spacer = helperPool + 4;
  const table = spacer + 4;
  const [blHigh, blLow] = bl(0x02, helper);
  return image(table + 8, [
    [0x00, PUSH], [0x02, blHigh], [0x04, blLow], [0x06, ldr(0x06, 0x0c)], [0x08, POP], [0x0a, NOP],
    [0x10, PUSH], [0x12, 0x2000 | imm], ...extra.map((value, k): [number, number] => [0x14 + 2 * k, value]),
    [0x14 + 2 * extra.length, POP], [0x16 + 2 * extra.length, NOP],
    [helper, PUSH], [helper + 2, ldr(helper + 2, helperPool)], [helper + 4, POP], [helper + 6, NOP],
  ], [[0x0c, BASE + helper + 1], [helperPool, 0x1234], [spacer, 0x12345678], [table, BASE + 1], [table + 4, BASE + 0x11]]);
}
/** The overlay with HandlerB 4 bytes longer, so Helper moves from 0x18 to 0x1C. */
const grown = () => overlay(8, [0x2101, 0x2202]);

const SOURCES: SourceFunction[] = [
  { name: 'HandlerA', file: 'x.c', line: 1, inline: false, calls: ['Helper'] },
  { name: 'HandlerB', file: 'x.c', line: 2, inline: false, calls: [] },
  { name: 'Helper', file: 'x.c', line: 3, inline: false, calls: [] },
];
const TABLE = { symbol: 'sCommands', source: 'x.c', names: ['HandlerA', 'HandlerB'] };
const layout = (code: CodeImage) => layoutOverlay(code, SOURCES, [TABLE], 'ov16');

describe('handler layout', () => {
  it('readTable finds the one run of exactly its length of Thumb pointers', () => {
    expect(readTable(overlay(8), TABLE)).toMatchObject({ offset: 0x28, targets: [0x00, 0x10] });
    expect(() => readTable(overlay(8), { ...TABLE, names: ['HandlerA', 'HandlerB', 'HandlerC'] })).toThrow(/one run of 3/);
  });

  it('layoutOverlay bounds each function by the next entry point and names it from the table, a call or the count', () => {
    const { codeEnd, functions } = layout(overlay(8));
    expect(codeEnd).toBe(0x24);
    expect(functions.map(({ start, end, name, evidence }) => ({ start, end, name, evidence }))).toEqual([
      { start: 0x00, end: 0x10, name: 'HandlerA', evidence: 'table' },
      { start: 0x10, end: 0x18, name: 'HandlerB', evidence: 'table' },
      { start: 0x18, end: 0x24, name: 'Helper', evidence: 'call' },
    ]);
  });

  it('findEntryPoints drops a BL used as a long branch inside a function, but keeps a near call to a leaf', () => {
    // A BL at 0x900 back to 0x10, inside the same function; a BL at 0x1002 to a leaf without push at 0x1008.
    const [farHigh, farLow] = bl(0x900, 0x10);
    const [nearHigh, nearLow] = bl(0x1002, 0x1008);
    const code = image(0x1010, [[0x0, PUSH], [0x10, 0x2001], [0x900, farHigh], [0x902, farLow], [0x904, POP],
      [0x1000, PUSH], [0x1002, nearHigh], [0x1004, nearLow], [0x1006, POP], [0x1008, 0x2001], [0x100a, 0x4770]]);
    expect(findEntryPoints(code, 0x1010, [0x0, 0x1000])).toMatchObject({ entries: [0x0, 0x1000, 0x1008], longBranches: [0x10] });
  });

  it('sourceFunctions reads definitions with multi-line signatures and enum return types, and marks inline ones', () => {
    const text = [
      'static int sTable[] = {', '    1,', '};', '', 'enum Kind GetKind(int x,', '    int y)', '{', '    return Helper(x) + Other(y);',
      '}', '', 'static inline int Twice(int x)', '{', '    if (x) { return x * 2; }', '    return 0;', '}',
    ].join('\n');
    expect(sourceFunctions(text, 'x.c')).toEqual([
      { name: 'GetKind', file: 'x.c', line: 5, inline: false, calls: ['Helper', 'Other'] },
      { name: 'Twice', file: 'x.c', line: 11, inline: true, calls: [] },
    ]);
  });
});

describe('diffFunctions and comparePair', () => {
  const run = (hack: CodeImage) => {
    const vanilla = layout(overlay(8));
    const other = layout(hack);
    return diffFunctions(vanilla, other, alignHalfwords(vanilla.image.bytes, other.image.bytes).toHack).pairs;
  };

  it('a handler whose BL and pointer only follow a moved function is relocated, not changed', () => {
    const pairs = run(grown());
    expect(Object.fromEntries(pairs.map((pair) => [pair.vanilla.name, pair.status]))).toEqual({
      HandlerA: 'relocated', HandlerB: 'changed', Helper: 'identical',
    });
    expect(pairs[0]!.relocations).toEqual({ bl: 1, pointer: 1 });
  });

  it('a changed immediate is a change, at its halfword', () => {
    const changed = run(overlay(0)).filter((pair) => pair.status === 'changed');
    expect(changed.map((pair) => [pair.vanilla.name, pair.spots])).toEqual([
      ['HandlerB', [{ vanillaStart: 0x12, vanillaEnd: 0x14, hackStart: 0x12, hackEnd: 0x14 }]],
    ]);
  });

  const HANDLER_A = { start: 0x00, end: 0x10, name: 'HandlerA', evidence: 'table' as const, file: null };
  const carry = (offset: number) => (offset < 0x10 ? offset : offset + 4);
  it.each<[string, CodeImage, (offset: number) => number, number, number]>([
    // In the grown overlay, HandlerA's BL keeps vanilla's encoding, so it lands at 0x18, inside HandlerB.
    ['a BL with the same encoding that lands on a different function', patched(grown(), 0x02, blBytes(0x02, 0x18)), carry, 0x02, 0x06],
    // In the grown overlay, HandlerA's literal still holds vanilla's Helper + 1.
    ['a loaded pointer with the same value whose function moved', patched(grown(), 0x0c, [0x19, 0x00, 0x20, 0x02]), carry, 0x0c, 0x10],
    ['a BL that now calls a different function', patched(overlay(8), 0x02, blBytes(0x02, 0x10)), (offset) => offset, 0x02, 0x06],
  ])('%s is a change, not a relocation', (_, hack, toHack, start, end) => {
    const pair = comparePair(overlay(8), hack, HANDLER_A, HANDLER_A, toHack);
    expect(pair).toMatchObject({ status: 'changed', spots: [{ vanillaStart: start, vanillaEnd: end, hackStart: start, hackEnd: end }] });
  });
});
