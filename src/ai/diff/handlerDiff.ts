// Function-level diff of overlay 16, the battle code. The overlay diff (overlayDiff.ts) aligns the two overlays as halfwords
// and names nothing; this one finds each function's entry point, names it from the decompilation, and compares every
// function's body with the hack's, normalising the references that only point at code or data that moved.
//
// Overlay 16 is `Overlay battle` in platinum.us/main.lsf.in:682, linked from battle_main.c, battle_system.c,
// battle_script.c, battle_controller_player.c, battle_lib.c, battle_io_command.c, battle_display.c, idle_bounce_anim.c,
// battle_controller.c, healthbox.c, terrain.c, battle_subscreen.c, party_gauge.c, cursor_renderer.c, indicator.c and
// stop_recording_task_data.c, in that order. Its code comes first and its data after it.
//
// Entry points. Three command tables hold function pointers in a known order: sBattleCommands (battle_script.c:346, the
// BTLCMD_* order of include/data/scripts/btlcmd.h), sBattleControlCommands (battle_controller_player.c:130) and the
// battle IO commands' sBattleCommands (battle_io_command.c:159). Their entries are exact. Every other function start is a
// 4-aligned BL target or a function pointer into the code. MWCC also uses BL as a long branch inside a big function; such
// a target is dropped when no table or pointer names it, it doesn't open with `push {…, lr}`, and every BL to it sits
// between the sure entries around it.
//
// Names. The compiler keeps source order, so the functions between two named entry points are the source's functions
// between those two names. A table entry is named exactly. A function a named function calls is named from the call:
// when the named function's body makes as many BLs into the code as its C body makes calls to the code's functions, the
// two lists pair up in order. A pairing is kept only if no other pairing contradicts it and it keeps source order.
// Between two named entries, if the counts agree, each entry takes the next source name ("count"); otherwise each keeps
// a pret-style address name (`ov16_0223B384`).
//
// Comparison. The two layouts pair up function by function. Bodies of the same size are compared halfword by halfword;
// a difference is a relocation when it is a BL whose target is the same offset of the paired function (or the same
// address outside the overlay), or a 4-aligned word that points at the paired function, or at data the alignment carries
// over. Anything else, or a different size, makes the function changed. A BL and a literal-pool pointer must reach the
// paired place even when their bytes are the same in both ROMs: a caller and its callee can move by different amounts.

import { type AlignedRegion, type CodeImage, blTarget, explainRegion, halfwordAt, type Relocation, wordAt } from './overlayDiff.js';

/** A function of the decompilation: its name, file, the line its signature starts on, and the names its body calls, in order. */
export interface SourceFunction { name: string; file: string; line: number; inline: boolean; calls: string[] }

/** Words that look like calls but aren't. */
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'case', 'do', 'else']);

/**
 * The functions `text` defines, in source order. A definition is a `{` alone at column 0 after its signature, which
 * starts at column 0 and may continue on indented lines. `calls` lists every identifier followed by `(` in the body.
 */
export function sourceFunctions(text: string, file: string): SourceFunction[] {
  const lines = blankCommentsAndStrings(text).split('\n');
  const functions: SourceFunction[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '{') continue;
    let j = i - 1;
    while (j > 0 && /^\s/.test(lines[j]!)) j--;
    const signature = lines.slice(j, i).join(' ');
    // An initialiser's `{` follows `=`; a definition's return type may start with `enum` or `struct`.
    if (signature.includes('=')) continue;
    const name = /(\w+)\s*\(/.exec(signature)?.[1];
    if (name === undefined) continue;
    let depth = 0;
    let end = i;
    for (; end < lines.length; end++) {
      for (const char of lines[end]!) depth += char === '{' ? 1 : char === '}' ? -1 : 0;
      if (depth === 0) break;
    }
    const body = lines.slice(i, end + 1).join('\n');
    const calls = [...body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((match) => match[1]!).filter((word) => !KEYWORDS.has(word));
    functions.push({ name, file, line: j + 1, inline: /\binline\b/.test(signature), calls });
    i = end;
  }
  return functions;
}

/** `text` with comments and string and character literals blanked out, newlines kept. */
function blankCommentsAndStrings(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (match) => match.replace(/[^\n]/g, ' '));
}

/** A function-pointer table: its symbol, where the decompilation defines it, and the function each entry names. */
export interface TableSpec { symbol: string; source: string; names: string[] }
/** A table found in an overlay: its offset and each entry's target (an offset into the overlay's code). */
export interface TableRead { spec: TableSpec; offset: number; targets: number[] }

/** The offset a 4-aligned word at `offset` points at as 4-aligned Thumb code below `limit`, or null. */
function codePointerAt(image: CodeImage, offset: number, limit: number): number | null {
  const value = wordAt(image, offset);
  if (value === null || (value & 3) !== 1) return null;
  const target = value - 1 - image.base;
  return target >= 0 && target < limit ? target : null;
}

/** The maximal runs of 4-aligned words that point at Thumb code below `limit`. */
export function codePointerRuns(image: CodeImage, limit: number): { offset: number; count: number }[] {
  const runs: { offset: number; count: number }[] = [];
  for (let offset = (4 - (image.base % 4)) % 4; offset + 4 <= image.bytes.length; offset += 4) {
    if (codePointerAt(image, offset, limit) === null) continue;
    let count = 0;
    while (codePointerAt(image, offset + count * 4, limit) !== null) count++;
    runs.push({ offset, count });
    offset += (count - 1) * 4;
  }
  return runs;
}

/**
 * Reads `spec` from `image`: the one maximal run of exactly as many code pointers as the table has entries. Entries
 * that name the same function must point at the same code, and entries that name different functions at different code.
 */
export function readTable(image: CodeImage, spec: TableSpec, limit = image.bytes.length): TableRead {
  const hits = codePointerRuns(image, limit).filter((run) => run.count === spec.names.length);
  if (hits.length !== 1) throw new Error(`expected one run of ${spec.names.length} code pointers for ${spec.symbol}, found ${hits.length}`);
  const offset = hits[0]!.offset;
  const targets = spec.names.map((_, k) => codePointerAt(image, offset + k * 4, limit)!);
  const byName = new Map<string, number>();
  const byTarget = new Map<number, string>();
  spec.names.forEach((name, k) => {
    const target = targets[k]!;
    if ((byName.get(name) ?? target) !== target || (byTarget.get(target) ?? name) !== name) {
      throw new Error(`${spec.symbol} entry ${k} (${name}) disagrees with another entry`);
    }
    byName.set(name, target);
    byTarget.set(target, name);
  });
  return { spec, offset, targets };
}

/** `ldr rd, [pc, #imm]`: the offset of the word it loads, or null. */
function literalOffset(image: CodeImage, offset: number): number | null {
  const value = halfwordAt(image, offset);
  if (value === null || (value & 0xf800) !== 0x4800) return null;
  return ((image.base + offset + 4) & ~3) + (value & 0xff) * 4 - image.base;
}

/** `pop {…, pc}`, `bx lr` or an unconditional `b`: the halfword ends a run of code. */
function endsCode(value: number): boolean {
  return (value & 0xff00) === 0xbd00 || value === 0x4770 || (value & 0xf800) === 0xe000;
}

/**
 * Where the run of code from `start` ends: at the first return or unconditional branch (after an optional `nop` or
 * zero pad) that is followed by a word its `ldr rd, [pc, #imm]`s load, once every word they load lies before the end of
 * that literal pool. The code ends after the pool. Throws if no such end comes before `limit`.
 */
export function findCodeEnd(image: CodeImage, start: number, limit: number): number {
  const literals = new Set<number>();
  for (let offset = start; offset + 2 <= limit; offset += 2) {
    const literal = literalOffset(image, offset);
    if (literal !== null) literals.add(literal);
    if (!endsCode(halfwordAt(image, offset)!)) continue;
    let next = offset + 2;
    if (next % 4 !== 0 && (halfwordAt(image, next) === 0x46c0 || halfwordAt(image, next) === 0)) next += 2;
    if (!literals.has(next)) continue;
    let end = next;
    while (literals.has(end)) end += 4;
    if ([...literals].every((at) => at < end)) return end;
  }
  throw new Error(`no end of code found after offset 0x${start.toString(16)}`);
}

/**
 * Where the code ends, given that `from` is code and data starts by `limit`: read from `from` to the end of its run of
 * code (findCodeEnd), then move to the greatest 4-aligned BL target that the code read so far calls beyond it, until
 * none is left. Pointers don't extend the code: a pointer into data can look like a Thumb pointer.
 */
export function findCodeExtent(image: CodeImage, from: number, limit: number): number {
  let start = from;
  for (;;) {
    const end = findCodeEnd(image, start, limit);
    const beyond = blCalls(image, 0, end).map(([, target]) => target).filter((target) => target % 4 === 0 && target >= end && target < limit);
    if (beyond.length === 0) return end;
    start = Math.max(...beyond);
  }
}

/** Entry points, sorted, and the BL targets dropped as long branches inside a function. */
export interface EntryPoints { entries: number[]; longBranches: number[] }

/** How far an unconditional Thumb B reaches from its PC: an 11-bit halfword offset, so −2048 to +2046 bytes. */
const B_REACH = 2048;

/**
 * Every function start below `codeEnd`: `fixed` (entries known in advance), each 4-aligned BL target from the code,
 * and each function pointer; less the long branches (see the file comment). A function pointer is a 4-aligned word
 * anywhere in the image that holds a 4-aligned Thumb address in the code, and that a PC-relative load in the code reads,
 * or that sits next to another such word, or whose target opens with `push {…, lr}`. A lone word of other data can hold
 * such a value by chance: in overlay 16's data, the u16s 0x0229 and 0x0226 read as a pointer into a function's middle.
 */
export function findEntryPoints(image: CodeImage, codeEnd: number, fixed: Iterable<number>): EntryPoints {
  const fixedSet = new Set(fixed);
  const pushes = (offset: number) => ((halfwordAt(image, offset) ?? 0) & 0xff00) === 0xb500;
  const loaded = new Set<number>();
  for (let offset = 0; offset + 2 <= codeEnd; offset += 2) {
    const literal = literalOffset(image, offset);
    if (literal !== null) loaded.add(literal);
  }
  const pointers = new Set<number>();
  for (let offset = (4 - (image.base % 4)) % 4; offset + 4 <= image.bytes.length; offset += 4) {
    const target = codePointerAt(image, offset, codeEnd);
    if (target === null) continue;
    const inRun = codePointerAt(image, offset - 4, codeEnd) !== null || codePointerAt(image, offset + 4, codeEnd) !== null;
    if (loaded.has(offset) || inRun || pushes(target)) pointers.add(target);
  }
  const callers = new Map<number, number[]>();
  for (const [at, target] of blCalls(image, 0, codeEnd)) {
    if (target % 4 !== 0 || target < 0 || target >= codeEnd) continue;
    callers.set(target, [...(callers.get(target) ?? []), at]);
  }
  // A sure entry is a fixed entry, a function pointer, or a BL target that opens with `push {…, lr}`, which MWCC emits
  // only at a function's start. Any other BL target is a long branch when every BL to it sits between the sure entries
  // around it and out of an unconditional B's reach (±2 KB): within that reach MWCC branches with B, so a BL there is a
  // call (of a leaf function right after its caller, say).
  const sure = [...new Set([...fixedSet, ...pointers, ...[...callers.keys()].filter(pushes)])].sort((a, b) => a - b);
  const sureSet = new Set(sure);
  const longBranches = [...callers.keys()].filter((target) => {
    if (sureSet.has(target)) return false;
    const before = sure.filter((entry) => entry < target).pop();
    const after = sure.find((entry) => entry > target) ?? codeEnd;
    return before !== undefined && callers.get(target)!.every((at) => at >= before && at < after && Math.abs(target - (at + 4)) > B_REACH);
  });
  const dropped = new Set(longBranches);
  const entries = [...new Set([...sure, ...callers.keys()])].filter((offset) => !dropped.has(offset)).sort((a, b) => a - b);
  return { entries, longBranches: longBranches.sort((a, b) => a - b) };
}

/** Each Thumb BL (not BLX) in [from, to): its offset and its target as an offset (which may lie outside the image). */
function blCalls(image: CodeImage, from: number, to: number): [number, number][] {
  const calls: [number, number][] = [];
  for (let offset = from; offset + 4 <= to; offset += 2) {
    const bl = blTarget(image, offset);
    if (bl === null || bl.exchange) continue;
    calls.push([offset, bl.target - image.base]);
    offset += 2;
  }
  return calls;
}

/**
 * How a function's name was found: from a command table; from its address in the name of its file (pret names a file
 * `unk_0207A6DC.c` after its first function); from a named caller's calls; by counting between two named functions; or
 * not at all (a pret-style address name).
 */
export type Evidence = 'table' | 'file' | 'call' | 'count' | 'address';
/** A function of the overlay: [start, end) and its name. */
export interface OverlayFunction { start: number; end: number; name: string; evidence: Evidence; file: string | null }

/** An overlay's functions, the command tables read from it, and where its code ends. */
export interface FunctionLayout {
  image: CodeImage;
  codeEnd: number;
  functions: OverlayFunction[];
  tables: TableRead[];
  longBranches: number[];
}

/**
 * A named function's body, seen from code other than the code being named: the names its C body calls, in order, and
 * the absolute targets of its BLs, in order.
 */
export interface CallerBody { calls: string[]; targets: number[] }

/**
 * The functions of `image`, an overlay linked from `sources` (every file's functions, in link order). `tables` give the
 * exact entries; `prefix` makes the address names (`ov16`).
 */
export function layoutOverlay(image: CodeImage, sources: SourceFunction[], tables: TableSpec[], prefix: string): FunctionLayout {
  const read = tables.map((spec) => readTable(image, spec));
  const firstData = Math.min(...read.map((table) => table.offset));
  const named = new Map<number, { name: string; evidence: Evidence }>();
  for (const table of read) table.targets.forEach((target, k) => named.set(target, { name: table.spec.names[k]!, evidence: 'table' }));
  const codeEnd = findCodeExtent(image, Math.max(...named.keys()), firstData);
  const { functions, longBranches } = layoutCode(image, { start: 0, end: codeEnd }, sources, named, [], prefix);
  return { image, codeEnd, functions, tables: read, longBranches };
}

/**
 * The functions of `image` in `span` (offsets), which holds exactly the functions of `sources` (in link order). `named`
 * gives the entries known in advance; `external` adds named callers from other code, and `calledFrom` the absolute BL
 * targets of any other code. `prefix` makes the address names. Names found by count name more callers, so finding
 * names from calls and by count repeats until neither finds a new one.
 */
export function layoutCode(
  image: CodeImage, span: { start: number; end: number }, sources: SourceFunction[],
  named: Map<number, { name: string; evidence: Evidence }>, external: CallerBody[], prefix: string, calledFrom: number[] = [],
): { functions: OverlayFunction[]; longBranches: number[] } {
  const externalTargets = [...external.flatMap((body) => body.targets), ...calledFrom].map((address) => address - image.base)
    .filter((offset) => offset >= span.start && offset < span.end && offset % 4 === 0);
  const found = findEntryPoints(image, span.end, [...named.keys(), ...externalTargets]);
  const entries = found.entries.filter((offset) => offset >= span.start);
  const longBranches = found.longBranches.filter((offset) => offset >= span.start);

  const defined = sources.filter((fn) => !fn.inline);
  const sourceIndex = new Map(defined.map((fn, index) => [fn.name, index]));
  const order = [...named].sort((a, b) => a[0] - b[0]);
  order.forEach(([, { name }], k) => {
    if (!sourceIndex.has(name)) throw new Error(`the decompilation defines no ${name}`);
    if (k > 0 && sourceIndex.get(name)! <= sourceIndex.get(order[k - 1]![1].name)!) {
      throw new Error(`${name} comes before ${order[k - 1]![1].name} in the source but after it in the code`);
    }
  });
  const anchors = new Map(named);
  const at = new Map(entries.map((offset, k) => [offset, k]));
  for (;;) {
    const before = anchors.size;
    for (const [offset, name] of nameFromCalls(image, entries, span.end, sources, anchors, sourceIndex, external)) {
      anchors.set(offset, { name, evidence: 'call' });
    }
    const sorted = [...anchors].sort((a, b) => a[0] - b[0]);
    const bounds = [{ k: -1, index: -1 }, ...sorted.map(([offset, anchor]) => ({ k: at.get(offset)!, index: sourceIndex.get(anchor.name)! })),
      { k: entries.length, index: defined.length }];
    for (let b = 0; b + 1 < bounds.length; b++) {
      const names = defined.slice(bounds[b]!.index + 1, bounds[b + 1]!.index);
      const between = entries.slice(bounds[b]!.k + 1, bounds[b + 1]!.k);
      if (names.length !== between.length) continue;
      between.forEach((offset, i) => anchors.set(offset, { name: names[i]!.name, evidence: 'count' }));
    }
    if (anchors.size === before) break;
  }

  const fileOf = new Map(defined.map((fn) => [fn.name, fn.file]));
  const functions: OverlayFunction[] = entries.map((start, k) => {
    const anchor = anchors.get(start);
    return {
      start,
      end: k + 1 < entries.length ? entries[k + 1]! : span.end,
      name: anchor?.name ?? `${prefix}_${hex(image.base + start, 8)}`,
      evidence: anchor?.evidence ?? 'address',
      file: anchor === undefined ? null : fileOf.get(anchor.name) ?? null,
    };
  });
  return { functions, longBranches };
}

/**
 * The bodies of `layout`'s named functions as other code's callers: each one's C calls (from `sources`, with its file's
 * inline functions spliced in) and its BL targets as absolute addresses.
 */
export function callerBodies(layout: { image: CodeImage; functions: OverlayFunction[] }, sources: SourceFunction[]): CallerBody[] {
  const { image } = layout;
  const bySourceName = new Map(sources.filter((fn) => !fn.inline).map((fn) => [fn.name, fn]));
  const inline = new Map(sources.filter((fn) => fn.inline).map((fn) => [`${fn.file}:${fn.name}`, fn]));
  return layout.functions.flatMap((fn) => {
    const source = fn.evidence === 'address' ? undefined : bySourceName.get(fn.name);
    if (source === undefined) return [];
    return [{
      calls: splicedCalls(source, inline, () => true),
      targets: blCalls(image, fn.start, fn.end).map(([, target]) => target + image.base),
    }];
  });
}

/** The names `fn`'s body calls that `keep` accepts, in order, with the calls of its file's inline functions spliced in. */
function splicedCalls(fn: SourceFunction, inline: Map<string, SourceFunction>, keep: (name: string) => boolean, depth = 0): string[] {
  return fn.calls.flatMap((call) => {
    const spliced = inline.get(`${fn.file}:${call}`);
    if (spliced !== undefined && depth < 4) return splicedCalls(spliced, inline, keep, depth + 1);
    return keep(call) ? [call] : [];
  });
}

/**
 * Names found from calls (see the file comment), starting from `anchors` and repeating until no new name is found.
 * The callers are the named functions of the code being named and `external`. A name is kept only when every pairing
 * of it agrees, no other name pairs with its entry, and it keeps source order with the names already known.
 */
function nameFromCalls(
  image: CodeImage, entries: number[], codeEnd: number, sources: SourceFunction[],
  anchors: Map<number, { name: string }>, sourceIndex: Map<string, number>, external: CallerBody[],
): Map<number, string> {
  const inline = new Map(sources.filter((fn) => fn.inline).map((fn) => [`${fn.file}:${fn.name}`, fn]));
  const bySourceName = new Map(sources.filter((fn) => !fn.inline).map((fn) => [fn.name, fn]));
  const entrySet = new Set(entries);
  const index = new Map(entries.map((offset, k) => [offset, k]));
  const endOf = (start: number) => {
    const k = index.get(start)!;
    return k + 1 < entries.length ? entries[k + 1]! : codeEnd;
  };
  const inCode = (name: string) => sourceIndex.has(name);
  const outside = external.map((body) => ({
    calls: body.calls.filter(inCode),
    targets: body.targets.map((address) => address - image.base).filter((offset) => entrySet.has(offset)),
  }));

  const found = new Map<number, string>();
  for (;;) {
    const names = new Map([...[...anchors].map(([offset, anchor]) => [offset, anchor.name] as const), ...found]);
    const bodies = [...outside];
    for (const [start, name] of names) {
      const source = bySourceName.get(name);
      if (source === undefined) continue;
      const end = endOf(start);
      const targets = blCalls(image, start, end).map(([, target]) => target).filter((target) => entrySet.has(target) && (target < start || target >= end));
      bodies.push({ calls: splicedCalls(source, inline, inCode), targets });
    }
    const pairs = new Map<string, Set<number>>();
    const owners = new Map<number, Set<string>>();
    for (const { calls, targets } of bodies) {
      if (targets.length !== calls.length) continue;
      calls.forEach((call, i) => {
        pairs.set(call, new Set([...(pairs.get(call) ?? []), targets[i]!]));
        owners.set(targets[i]!, new Set([...(owners.get(targets[i]!) ?? []), call]));
      });
    }
    const known = new Set(names.values());
    const fresh: [number, string][] = [];
    for (const [call, targets] of pairs) {
      if (targets.size !== 1) continue;
      const target = [...targets][0]!;
      if (owners.get(target)!.size !== 1 || known.has(call) || names.has(target)) continue;
      fresh.push([target, call]);
    }
    const kept = keepSourceOrder(names, fresh, sourceIndex);
    if (kept.length === 0) return found;
    for (const [offset, name] of kept) found.set(offset, name);
  }
}

/**
 * The `fresh` names that keep source order with `names` (whose order is trusted) and with each other: a fresh name must
 * fall between the trusted names around it, and of the fresh names left, a longest run in source order is kept.
 */
function keepSourceOrder(names: Map<number, string>, fresh: [number, string][], sourceIndex: Map<string, number>): [number, string][] {
  const trusted = [...names].map(([offset, name]) => ({ offset, index: sourceIndex.get(name)! })).sort((a, b) => a.offset - b.offset);
  const fits = fresh.filter(([offset, name]) => {
    const index = sourceIndex.get(name)!;
    const before = trusted.filter((anchor) => anchor.offset < offset).pop();
    const after = trusted.find((anchor) => anchor.offset > offset);
    return (before === undefined || before.index < index) && (after === undefined || after.index > index);
  }).sort((a, b) => a[0] - b[0]);
  // Longest strictly increasing subsequence of source indices, by address.
  const indices = fits.map(([, name]) => sourceIndex.get(name)!);
  const best = indices.map(() => 1);
  const from = indices.map(() => -1);
  for (let i = 0; i < indices.length; i++) {
    for (let j = 0; j < i; j++) {
      if (indices[j]! < indices[i]! && best[j]! + 1 > best[i]!) {
        best[i] = best[j]! + 1;
        from[i] = j;
      }
    }
  }
  let at = best.indexOf(Math.max(0, ...best));
  const kept: [number, string][] = [];
  while (at >= 0) {
    kept.push(fits[at]!);
    at = from[at]!;
  }
  return kept.reverse();
}

/** A changed span of a function: vanilla's [vanillaStart, vanillaEnd) and the hack's [hackStart, hackEnd), as offsets. */
export interface Spot { vanillaStart: number; vanillaEnd: number; hackStart: number; hackEnd: number }
/** How a function pair compares. */
export interface FunctionPair {
  vanilla: OverlayFunction;
  hack: OverlayFunction;
  /** Byte for byte the same, the same up to relocations, or changed (a different size, or a difference that isn't one). */
  status: 'identical' | 'relocated' | 'changed';
  relocations: { bl: number; pointer: number };
  /** For a changed function of the same size, the halfwords that differ after normalising. */
  spots: Spot[];
}
/** Every function pair, the functions that have none, and where a vanilla offset lands in the hack. */
export interface FunctionDiff {
  pairs: FunctionPair[];
  vanillaOnly: OverlayFunction[];
  hackOnly: OverlayFunction[];
  /** In code: the same offset into the paired function; in data, the alignment's answer; null when there is none. */
  carry(offset: number): number | null;
}

/**
 * Pairs the two layouts' functions and compares each pair. The functions pair up by position when both layouts have the
 * same number and agree on every name not an address name; otherwise a vanilla function pairs with the hack function
 * that starts where `toHack` carries its start. `toHack` maps a vanilla offset to the hack's (null when it has none);
 * it also carries data pointers.
 */
export function diffFunctions(vanilla: FunctionLayout, hack: FunctionLayout, toHack: (offset: number) => number | null): FunctionDiff {
  const v = vanilla.functions;
  const h = hack.functions;
  const sameNames = v.length === h.length && v.every((fn, k) => fn.evidence === 'address' || h[k]!.evidence === 'address' || fn.name === h[k]!.name);
  const hackStarts = new Map(h.map((fn, k) => [fn.start, k]));
  const partner = v.map((fn, k) => (sameNames ? k : hackStarts.get(toHack(fn.start) ?? -1) ?? -1));
  const used = new Set(partner.filter((k) => k >= 0));
  const carry = (offset: number): number | null => {
    if (offset >= vanilla.codeEnd) return toHack(offset);
    const k = functionIndex(v, offset);
    if (k < 0 || partner[k]! < 0) return null;
    return h[partner[k]!]!.start + (offset - v[k]!.start);
  };
  const pairs: FunctionPair[] = [];
  v.forEach((fn, k) => {
    if (partner[k]! >= 0) pairs.push(comparePair(vanilla.image, hack.image, fn, h[partner[k]!]!, carry));
  });
  return { pairs, vanillaOnly: v.filter((_, k) => partner[k]! < 0), hackOnly: h.filter((_, k) => !used.has(k)), carry };
}

/** The index of the function containing `offset`, or -1. */
export function functionIndex(functions: OverlayFunction[], offset: number): number {
  let low = 0;
  let high = functions.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const fn = functions[mid]!;
    if (offset < fn.start) high = mid - 1;
    else if (offset >= fn.end) low = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Compares one function pair (see the file comment). `carry` takes a vanilla offset to the hack's; an address outside
 * vanilla's image must stay the same.
 */
export function comparePair(
  a: CodeImage, b: CodeImage, v: OverlayFunction, h: OverlayFunction, carry: (offset: number) => number | null,
): FunctionPair {
  const size = v.end - v.start;
  const relocations = { bl: 0, pointer: 0 };
  if (size !== h.end - h.start) return { vanilla: v, hack: h, status: 'changed', relocations, spots: [] };
  const inVanilla = (address: number) => address >= a.base && address < a.base + a.bytes.length;
  // Whether vanilla's address `from` and the hack's `to` refer to the same thing.
  const same = (from: number, to: number) => {
    if (!inVanilla(from)) return from === to;
    const thumb = from & 1;
    const carried = carry(from - thumb - a.base);
    return carried !== null && carried + b.base + thumb === to;
  };
  const spots: Spot[] = [];
  const spot = (r: number, length: number) => {
    const last = spots[spots.length - 1];
    if (last !== undefined && last.vanillaEnd >= v.start + r) {
      last.vanillaEnd = v.start + r + length;
      last.hackEnd = h.start + r + length;
    } else {
      spots.push({ vanillaStart: v.start + r, vanillaEnd: v.start + r + length, hackStart: h.start + r, hackEnd: h.start + r + length });
    }
  };
  // The words the body's `ldr rd, [pc, #imm]`s load, as offsets into the body: its literal pool.
  const loaded = new Set<number>();
  for (let r = 0; r + 2 <= size; r += 2) {
    const literal = literalOffset(a, v.start + r);
    if (literal !== null && literal >= v.start && literal + 4 <= v.end) loaded.add(literal - v.start);
  }
  let identical = true;
  for (let r = 0; r < size;) {
    const x = v.start + r;
    const y = h.start + r;
    const vWord = (a.base + x) % 4 === 0 && r + 4 <= size ? wordAt(a, x) : null;
    const hWord = vWord === null ? null : wordAt(b, y);
    if (vWord !== null && hWord !== null && inVanilla(vWord)) {
      if (vWord !== hWord && same(vWord, hWord)) {
        relocations.pointer++;
        identical = false;
        r += 4;
        continue;
      }
      // A loaded pointer that kept its value must still reach the paired place: code may have moved under it.
      if (vWord === hWord && loaded.has(r)) {
        if (!same(vWord, hWord)) spot(r, 4);
        r += 4;
        continue;
      }
    }
    const vBl = r + 4 <= size && !loaded.has(r - 2) && !loaded.has(r) ? blTarget(a, x) : null;
    const hBl = vBl === null ? null : blTarget(b, y);
    if (vBl !== null && hBl !== null && vBl.exchange === hBl.exchange) {
      const sameBytes = halfwordAt(a, x) === halfwordAt(b, y) && halfwordAt(a, x + 2) === halfwordAt(b, y + 2);
      // A BL is PC-relative: one whose bytes kept still must reach the paired place, since its caller and its callee
      // can move by different amounts.
      if (!same(vBl.target, hBl.target)) spot(r, 4);
      else if (!sameBytes) relocations.bl++;
      if (!sameBytes) identical = false;
      r += 4;
      continue;
    }
    if (halfwordAt(a, x) !== halfwordAt(b, y)) {
      identical = false;
      spot(r, 2);
    }
    r += 2;
  }
  const status = spots.length > 0 ? 'changed' : identical ? 'identical' : 'relocated';
  return { vanilla: v, hack: h, status, relocations, spots };
}

/**
 * The offsets of `layout`'s functions that `callers` (absolute BL targets from other code) reach, directly or through
 * the layout's own calls, each with the chain of names from a direct callee to it.
 */
export function reachedFrom(layout: { image: CodeImage; functions: OverlayFunction[] }, callers: number[]): Map<number, string[]> {
  const { image, functions } = layout;
  const reached = new Map<number, string[]>();
  const queue: number[] = [];
  for (const address of callers) {
    const k = functionIndex(functions, address - image.base);
    if (k < 0 || reached.has(k)) continue;
    reached.set(k, [functions[k]!.name]);
    queue.push(k);
  }
  while (queue.length > 0) {
    const k = queue.shift()!;
    const fn = functions[k]!;
    for (const [, target] of blCalls(image, fn.start, fn.end)) {
      const callee = functionIndex(functions, target);
      if (callee < 0 || callee === k || reached.has(callee)) continue;
      reached.set(callee, [...reached.get(k)!, functions[callee]!.name]);
      queue.push(callee);
    }
  }
  return new Map([...reached].map(([k, chain]) => [functions[k]!.start, chain]));
}

/**
 * The changed regions of the data after vanilla's code (`regions` are the alignment's), each with the pointer
 * relocations that explain it, or null when something else changed. A pointer is carried by `diff`: into a paired
 * function's same offset, or the alignment's answer for data.
 */
export function diffData(
  vanilla: FunctionLayout, hack: FunctionLayout, regions: AlignedRegion[], diff: FunctionDiff,
): { region: AlignedRegion; relocations: Relocation[] | null }[] {
  const toHack = (address: number) => {
    const offset = address - vanilla.image.base;
    if (offset < 0 || offset >= vanilla.image.bytes.length) return address;
    const carried = diff.carry(offset);
    return carried === null ? null : carried + hack.image.base;
  };
  return regions.filter((region) => region.vanillaStart >= vanilla.codeEnd)
    .map((region) => ({ region, relocations: explainRegion(vanilla.image, hack.image, region, toHack) }));
}

/** An object file of a static binary, in link order, with the functions its source defines. */
export interface LinkedFile { path: string; functions: SourceFunction[] }

/**
 * The functions of a static binary (ARM9) that pret's address-named files bound. pret names a file `unk_XXXXXXXX.c`
 * after its first function's address, so the files from one such file up to the next fill exactly the code between the
 * two addresses; each such span is laid out on its own (layoutCode), its first function named by its file. Its callers
 * are `calledFrom` (absolute BL targets from other binaries), `external` and the BLs of the binary's own code outside the
 * span. Code outside every span (before the first such file, after the last, and the libraries) is left out.
 */
export function layoutStatic(image: CodeImage, files: LinkedFile[], external: CallerBody[], calledFrom: number[]): OverlayFunction[] {
  const named = files.flatMap((file, k) => {
    const address = /unk_([0-9A-F]{8})\.c$/.exec(file.path)?.[1];
    return address === undefined ? [] : [{ k, offset: Number.parseInt(address, 16) - image.base }];
  });
  // A file named after a data address (unk_020EDBAC.c sits among code at 0x0205…) breaks the order: keep a longest run
  // of names whose addresses rise in link order.
  const anchors = longestRising(named);
  if (anchors.length < 2) return [];
  // The binary's own calls, from its start (main.c and the files before the first span are C too) to the last span's end.
  const own = blCalls(image, 0, anchors[anchors.length - 1]!.offset);
  const functions: OverlayFunction[] = [];
  for (let a = 0; a + 1 < anchors.length; a++) {
    const { k, offset } = anchors[a]!;
    const next = anchors[a + 1]!;
    const sources = files.slice(k, next.k).flatMap((file) => file.functions);
    const first = sources.find((fn) => !fn.inline);
    if (first === undefined) continue;
    const start = new Map([[offset, { name: first.name, evidence: 'file' as Evidence }]]);
    const fromOutside = own.filter(([at]) => at < offset || at >= next.offset).map(([, target]) => target + image.base);
    functions.push(...layoutCode(image, { start: offset, end: next.offset }, sources, start, external, 'sub', [...calledFrom, ...fromOutside]).functions);
  }
  return functions;
}

/** A longest subsequence of `items` (in order) whose offsets strictly rise. */
function longestRising<T extends { offset: number }>(items: T[]): T[] {
  const best = items.map(() => 1);
  const from = items.map(() => -1);
  for (let i = 0; i < items.length; i++) {
    for (let j = 0; j < i; j++) {
      if (items[j]!.offset < items[i]!.offset && best[j]! + 1 > best[i]!) {
        best[i] = best[j]! + 1;
        from[i] = j;
      }
    }
  }
  const kept: T[] = [];
  for (let at = best.indexOf(Math.max(0, ...best)); at >= 0; at = from[at]!) kept.push(items[at]!);
  return kept.reverse();
}

/** Every Thumb BL (not BLX) in `image`: its absolute address and its absolute target. */
export function blSites(image: CodeImage): [number, number][] {
  return blCalls(image, 0, image.bytes.length).map(([at, target]) => [at + image.base, target + image.base]);
}

/** The absolute targets of every Thumb BL in `image` that lands in [base, base + length). */
export function callsInto(image: CodeImage, base: number, length: number): number[] {
  return blCalls(image, 0, image.bytes.length).map(([, target]) => target + image.base).filter((address) => address >= base && address < base + length);
}

function hex(value: number, digits: number): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}
