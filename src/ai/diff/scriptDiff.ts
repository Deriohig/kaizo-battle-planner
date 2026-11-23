// Diffs the hack's trainer AI script against vanilla's. The instructions both scripts can reach are lined up with a
// shortest-edit diff on what each instruction does (opcode, values and table contents, not where its jumps land);
// jumps are then compared through that alignment. Each difference is reported once, under the first flag (in bit
// order) whose routine reaches it.

import { AI_FLAG_NAMES } from '../../rom/trainers.js';
import type { AiScript } from '../rom/script.js';
import { type Instr, reachable } from '../script/disasm.js';
import type { OpName } from '../script/opcodes.js';
import type { SourceLabel } from './labels.js';

/** One difference. `vanilla` and `hack` are rendered instructions with constants named; one side may be empty. */
export interface ScriptChange { flag: string; vanillaLabel: string | null; vanilla: string[]; hack: string[] }

/** The kinds of constant an argument is named by. */
export type ConstantKind = 'move' | 'effect' | 'ability' | 'item' | 'type';
/** Constant names by kind, indexed by value (the decompilation's enum order). A missing name renders as the number. */
export type ConstantNames = Partial<Record<ConstantKind, readonly string[]>>;

const FLAG_COUNT = 32;
const ALL_BITS = Array.from({ length: FLAG_COUNT }, (_, bit) => bit);
/** A flag table entry, rendered like script.s's FlagTable lines (script.s:19). */
const ENTRY = 'LabelDistance';

/** The name of each flag bit: AI_FLAG_* order (script.s:19–50). Bits 11–28 are unused. */
export const FLAG_NAMES: readonly string[] = ALL_BITS.map((bit) => {
  if (bit < AI_FLAG_NAMES.length) return AI_FLAG_NAMES[bit]!;
  return ({ 29: 'RoamingPokemon', 30: 'Safari', 31: 'CatchTutorial' } as Record<number, string>)[bit] ?? `Unused${bit}`;
});

/** Arguments that always hold one kind of constant: opcode → argument index → kind (aicmd.inc's argument names). */
const FIXED_KINDS: Partial<Record<OpName, Record<number, ConstantKind>>> = {
  IfMoveEqualTo: { 0: 'move' },
  IfMoveNotEqualTo: { 0: 'move' },
  IfMoveKnown: { 1: 'move' },
  IfMoveNotKnown: { 1: 'move' },
  IfCurrentMoveEffectEqualTo: { 0: 'effect' },
  IfCurrentMoveEffectNotEqualTo: { 0: 'effect' },
  IfMoveEffectKnown: { 1: 'effect' },
  IfMoveEffectNotKnown: { 1: 'effect' },
  CheckBattlerAbility: { 1: 'ability' },
  FlagBattlerIsType: { 1: 'type' },
  IfHeldItemEqualTo: { 1: 'item' },
};

/** Commands that compare the loaded value (calcTemp) with an argument or table: named by what was loaded. */
const LOADED_READERS = new Set<string>([
  'IfLoadedLessThan', 'IfLoadedGreaterThan', 'IfLoadedEqualTo', 'IfLoadedNotEqualTo', 'IfTempEqualTo', 'IfTempNotEqualTo',
  'IfLoadedInTable', 'IfLoadedNotInTable',
]);

/** What the commands that write calcTemp load, where it is a named constant (trainer_ai.c's handlers). */
const LOADED_KINDS: Partial<Record<OpName, ConstantKind>> = {
  LoadBattlerAbility: 'ability',
  LoadAbility: 'ability',
  LoadTypeFrom: 'type',
  LoadTypeOfLoadedMove: 'type',
  LoadCurrentMove: 'move',
  LoadBattlerPreviousMove: 'move',
  LoadCurrentMoveEffect: 'effect',
  LoadEffectOfLoadedMove: 'effect',
  LoadHeldItem: 'item',
  LoadRecycleItem: 'item',
};

/** Whether a command writes calcTemp: every Load*, Flag*, Count*, Calc*, Sum*, Diff* and Check* command does. */
const writesLoaded = (name: string) => /^(Load|Flag|Count|Calc|Sum|Diff|Check)/.test(name);

/** The commands after which the cursor never reaches the next instruction (as disasm.ts's walk). */
const NO_FALL_THROUGH = new Set(['GoTo', 'PopOrEnd', 'Escape']);

/** A run of instructions the diff could not pair: vanilla's side and the hack's, in address order. */
interface Hunk { vanilla: Instr[]; hack: Instr[] }

/** A change before it is given a flag: the instructions it covers on each side, and where it sorts. */
interface Pending { change: Omit<ScriptChange, 'flag'>; vanillaAts: number[]; hackAts: number[]; entryBit?: number; order: number }

/**
 * Every difference between the scripts, in flag order and then script order: changed instructions, jumps that land
 * somewhere else, flag entries that moved, code only one script reaches. `labels` names vanilla's words.
 */
export function diffScripts(vanilla: AiScript, hack: AiScript, labels: SourceLabel[], names: ConstantNames = {}): ScriptChange[] {
  const vanillaCode = [...reachable(vanilla, ALL_BITS).values()];
  const hackCode = [...reachable(hack, ALL_BITS).values()];
  const pairs = shortestEditPairs(vanillaCode.map((instr) => shape(vanilla, instr)), hackCode.map((instr) => shape(hack, instr)));

  // Pair each instruction with its counterpart: matched ones exactly, and those in a hunk of equal size by position.
  const vToH = new Map<number, number>();
  const hToV = new Map<number, number>();
  const hunkOf = { vanilla: new Map<number, number>(), hack: new Map<number, number>() };
  const hunks: Hunk[] = [];
  const matched: [Instr, Instr][] = [];
  let vi = 0;
  let hi = 0;
  for (const [vNext, hNext] of [...pairs, [vanillaCode.length, hackCode.length] as const]) {
    if (vNext > vi || hNext > hi) {
      const hunk = { vanilla: vanillaCode.slice(vi, vNext), hack: hackCode.slice(hi, hNext) };
      hunk.vanilla.forEach((instr) => hunkOf.vanilla.set(instr.at, hunks.length));
      hunk.hack.forEach((instr) => hunkOf.hack.set(instr.at, hunks.length));
      if (hunk.vanilla.length === hunk.hack.length) hunk.vanilla.forEach((instr, k) => pair(instr.at, hunk.hack[k]!.at));
      hunks.push(hunk);
    }
    if (vNext < vanillaCode.length) {
      matched.push([vanillaCode[vNext]!, hackCode[hNext]!]);
      pair(vanillaCode[vNext]!.at, hackCode[hNext]!.at);
    }
    vi = vNext + 1;
    hi = hNext + 1;
  }
  function pair(v: number, h: number) {
    vToH.set(v, h);
    hToV.set(h, v);
  }
  /** Whether vanilla word `v` and hack word `h` are the same place: paired, or in the same hunk. */
  const samePlace = (v: number, h: number) => vToH.get(v) === h || (hunkOf.vanilla.has(v) && hunkOf.vanilla.get(v) === hunkOf.hack.get(h));

  const sortedLabels = [...labels].sort((a, b) => a.at - b.at);
  const nearestLabel = (at: number): SourceLabel | null => {
    let found: SourceLabel | null = null;
    for (const label of sortedLabels) {
      if (label.at > at) break;
      if (found === null || label.at > found.at) found = label;
    }
    return found;
  };
  const vanillaTarget = (at: number) => {
    const label = nearestLabel(at);
    if (label === null) return `@${at}`;
    return label.at === at ? label.name : `${label.name}+${at - label.at}`;
  };
  const hackTarget = (at: number) => {
    const v = hToV.get(at);
    return v === undefined ? `@${at}` : vanillaTarget(v);
  };
  const hackJumpTargets = new Set(hackCode.flatMap(jumpTargets));
  const renderVanilla = (instrs: Instr[]) => instrs.map((instr) => render(vanilla, vanillaCode, instr, vanillaTarget, names));
  const renderHack = (instrs: Instr[]) => instrs.map((instr) => render(hack, hackCode, instr, hackTarget, names));

  const pending: Pending[] = [];
  // Flag entries that lead somewhere else.
  ALL_BITS.forEach((bit) => {
    const v = vanilla.flagEntries[bit]!;
    const h = hack.flagEntries[bit]!;
    if (samePlace(v, h)) return;
    pending.push({
      change: { vanillaLabel: nearestLabel(v)?.name ?? null, vanilla: [`${ENTRY} ${vanillaTarget(v)}`], hack: [`${ENTRY} ${hackTarget(h)}`] },
      vanillaAts: [],
      hackAts: [],
      entryBit: bit,
      order: v,
    });
  });
  // Paired instructions whose jumps land somewhere else. (Their tables already match: the diff compared contents.)
  for (const [v, h] of matched) {
    const hackJumps = jumpTargets(h);
    if (jumpTargets(v).every((target, k) => samePlace(target, hackJumps[k]!))) continue;
    pending.push({
      change: { vanillaLabel: nearestLabel(v.at)?.name ?? null, vanilla: renderVanilla([v]), hack: renderHack([h]) },
      vanillaAts: [v.at],
      hackAts: [h.at],
      order: v.at,
    });
  }
  // Instructions the diff could not pair.
  hunks.forEach((hunk, index) => {
    const vanillaAts = hunk.vanilla.map((instr) => instr.at);
    const hackAts = hunk.hack.map((instr) => instr.at);
    if (hunk.vanilla.length > 0) {
      pending.push({
        change: { vanillaLabel: nearestLabel(vanillaAts[0]!)?.name ?? null, vanilla: renderVanilla(hunk.vanilla), hack: renderHack(hunk.hack) },
        vanillaAts,
        hackAts,
        order: vanillaAts[0]!,
      });
      return;
    }
    // Code only the hack reaches: listed in full, with a label wherever it is entered other than by falling through,
    // and placed by the vanilla code that first leads into it (or, failing that, the vanilla code before it).
    const anchor = entryInto(hackCode, index, hunkOf.hack, hToV) ?? previousVanilla(vanillaCode, pairs, hackCode, hunk.hack[0]!.at);
    const listing: string[] = [];
    hunk.hack.forEach((instr, k) => {
      const previous = hunk.hack[k - 1];
      const fallsInto = previous !== undefined && previous.at + previous.args.length + 1 === instr.at && !NO_FALL_THROUGH.has(previous.op.name);
      if (!fallsInto || hackJumpTargets.has(instr.at)) listing.push(`@${instr.at}:`);
      listing.push(...renderHack([instr]));
    });
    pending.push({
      change: { vanillaLabel: anchor === null ? null : (nearestLabel(anchor)?.name ?? null), vanilla: [], hack: listing },
      vanillaAts: [],
      hackAts,
      order: (anchor ?? -1) + 0.5,
    });
  });

  // Each change goes under the first flag, in bit order, whose routine reaches it in either script.
  const changes: { change: ScriptChange; bit: number; order: number }[] = [];
  let unassigned = pending;
  for (const bit of ALL_BITS) {
    if (unassigned.length === 0) break;
    const vanillaReach = reachable(vanilla, [bit]);
    const hackReach = reachable(hack, [bit]);
    unassigned = unassigned.filter((item) => {
      const reached = item.entryBit === bit || item.vanillaAts.some((at) => vanillaReach.has(at)) || item.hackAts.some((at) => hackReach.has(at));
      if (reached) changes.push({ change: { flag: FLAG_NAMES[bit]!, ...item.change }, bit, order: item.order });
      return !reached;
    });
  }
  return changes.sort((a, b) => a.bit - b.bit || a.order - b.order).map((item) => item.change);
}

/** What an instruction does, without where its jumps land: its opcode, its values, and the contents of its tables. */
function shape(script: AiScript, instr: Instr): string {
  let target = 0;
  const parts = instr.op.args.map((kind, k) => {
    if (kind === 'int') return String(instr.args[k]);
    const at = instr.targets[target++]!;
    return kind === 'table' ? `[${tableAt(script, at).join(',')}]` : 'jump';
  });
  return `${instr.op.code}:${parts.join(',')}`;
}

/** The entries of the table at word `start`, up to its TABLE_END (trainer_ai.c:866). */
export function tableAt(script: AiScript, start: number): number[] {
  const entries: number[] = [];
  for (let at = start; at < script.words.length && script.words[at] !== -1; at++) entries.push(script.words[at]!);
  return entries;
}

/** `instr` as script.s would write it, with jump targets from `target` and constants named where the kind is known. */
function render(script: AiScript, code: Instr[], instr: Instr, target: (at: number) => string, names: ConstantNames): string {
  const loaded = LOADED_READERS.has(instr.op.name) ? loadedKind(code, instr) : null;
  const fixed = FIXED_KINDS[instr.op.name as OpName] ?? {};
  const name = (kind: ConstantKind | null | undefined, value: number) => (kind ? names[kind]?.[value] : undefined) ?? String(value);
  let next = 0;
  const args = instr.op.args.map((kind, k) => {
    if (kind === 'int') return name(fixed[k] ?? loaded, instr.args[k]!);
    const at = instr.targets[next++]!;
    return kind === 'table' ? `[${tableAt(script, at).map((value) => name(loaded, value)).join(', ')}]` : target(at);
  });
  return args.length === 0 ? instr.op.name : `${instr.op.name} ${args.join(', ')}`;
}

/**
 * What calcTemp holds when `instr` runs, judged from the straight-line code before it: the kind of the nearest
 * earlier command that writes it, or null when that command loads a plain number or the code before is not straight.
 * `code` is the reachable instructions in address order, as `reachable` gives them.
 */
export function loadedKind(code: Instr[], instr: Instr): ConstantKind | null {
  for (let k = code.indexOf(instr) - 1; k >= 0; k--) {
    const previous = code[k]!;
    const next = code[k + 1]!;
    if (previous.at + previous.args.length + 1 !== next.at || NO_FALL_THROUGH.has(previous.op.name)) return null;
    if (writesLoaded(previous.op.name)) return LOADED_KINDS[previous.op.name as OpName] ?? null;
  }
  return null;
}

/** `instr`'s jump targets, without its table targets. */
function jumpTargets(instr: Instr): number[] {
  const kinds = instr.op.args.filter((kind) => kind !== 'int');
  return instr.targets.filter((_, k) => kinds[k] === 'jump');
}

/** The vanilla word of the first paired hack instruction that jumps into hunk `index` from outside it, if any. */
function entryInto(hackCode: Instr[], index: number, hunkOf: Map<number, number>, hToV: Map<number, number>): number | null {
  for (const instr of hackCode) {
    if (hunkOf.get(instr.at) === index) continue;
    if (jumpTargets(instr).some((target) => hunkOf.get(target) === index) && hToV.has(instr.at)) return hToV.get(instr.at)!;
  }
  return null;
}

/** The vanilla word of the last matched hack instruction before hack word `at`, if any. */
function previousVanilla(vanillaCode: Instr[], pairs: [number, number][], hackCode: Instr[], at: number): number | null {
  let found: number | null = null;
  for (const [v, h] of pairs) {
    if (hackCode[h]!.at >= at) break;
    found = vanillaCode[v]!.at;
  }
  return found;
}

/**
 * The index pairs `[i, j]` with `a[i] === b[j]` that a shortest edit script (Myers 1986, greedy forward) keeps, in
 * order. Matches are taken as early as possible, so code appended to the hack shows as appended.
 */
function shortestEditPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        done = true;
        break;
      }
    }
  }

  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const previousK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1;
    const previousX = vd[offset + previousK]!;
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      pairs.push([x - 1, y - 1]);
      x--;
      y--;
    }
    x = previousX;
    y = previousY;
  }
  return pairs.reverse();
}
