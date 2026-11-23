// Decodes the trainer AI script's words into instructions, and walks the instructions each flag can reach.

import { createHash } from 'node:crypto';
import { AiError } from '../errors.js';
import type { AiScript } from '../rom/script.js';
import { type OpcodeInfo, OPCODES } from './opcodes.js';

/** The word that ends a table (aicmd.inc:632, trainer_ai.c:866), as the script's `int` words read it. */
const TABLE_END = -1;
/** The flags scriptId covers. Bits 11–28 are unused: script.s:30–47 points them all at Terminate. */
const SCRIPT_ID_BITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 29, 30, 31];
/**
 * The commands after which the cursor never reaches the next instruction: GoTo always jumps (trainer_ai.c:2561–2566),
 * PopOrEnd returns to a pushed cursor or ends the run (trainer_ai.c:2568–2577), and Escape ends it
 * (trainer_ai.c:1875–1879). PushAndGoTo pushes the cursor after itself (trainer_ai.c:2554–2559, 2673), so it falls through.
 */
const NO_FALL_THROUGH = new Set(['GoTo', 'PopOrEnd', 'Escape']);

/** One decoded instruction. `targets` are absolute word indices, one per `jump` or `table` argument, in argument order. */
export interface Instr { at: number; op: OpcodeInfo; args: number[]; targets: number[] }

/** The instruction at word `at`. Throws AiError('UNKNOWN_OPCODE') naming the word index when there is none. */
export function decodeAt(words: Int32Array, at: number): Instr {
  const code = words[at];
  if (code === undefined) throw new AiError('UNKNOWN_OPCODE', `no script word at word ${at} (the script has ${words.length})`);
  const op = OPCODES[code];
  if (op === undefined) throw new AiError('UNKNOWN_OPCODE', `unknown AI opcode ${code} at word ${at}`);
  if (at + op.args.length >= words.length) {
    throw new AiError('UNKNOWN_OPCODE', `${op.name} at word ${at} runs past the end of the script (${words.length} words)`);
  }
  const args = Array.from(words.subarray(at + 1, at + 1 + op.args.length));
  const targets = op.args.flatMap((kind, i) => {
    const index = at + 1 + i;
    // A jump word is read, then added to the cursor, which is past it: target = index + 1 + value (aicmd.inc:9,
    // trainer_ai.c:530–536). A table word is read before the jump word, and the table is read at the cursor past both:
    // target = index + 2 + value (aicmd.inc:169, trainer_ai.c:860–866).
    if (kind === 'jump') return [index + 1 + args[i]!];
    if (kind === 'table') return [index + 2 + args[i]!];
    return [];
  });
  return { at, op, args, targets };
}

/** Every instruction reachable from the entries of flag `bits`, by word index in address order. */
export function reachable(script: AiScript, bits: number[]): Map<number, Instr> {
  return walk(script, bits).instrs;
}

/**
 * The script's identity: SHA-256 (hex) over little-endian u32s. First come the 32 flag entries, so scripts that differ
 * only in which flag starts where differ. Then come, in address order, the words of every instruction reachable from
 * flags 0–10 and 29–31 and of every table they read (through TABLE_END).
 */
export function scriptId(script: AiScript): string {
  const { instrs, tables } = walk(script, SCRIPT_ID_BITS);
  const indices = new Set<number>();
  for (const instr of instrs.values()) {
    for (let at = instr.at; at <= instr.at + instr.args.length; at++) indices.add(at);
  }
  for (const [start, end] of tables) {
    for (let at = start; at <= end; at++) indices.add(at);
  }
  const sorted = [...indices].sort((a, b) => a - b);
  const entries = script.flagEntries.length;
  const bytes = new DataView(new ArrayBuffer((entries + sorted.length) * 4));
  script.flagEntries.forEach((entry, i) => bytes.setUint32(i * 4, entry, true));
  sorted.forEach((at, i) => bytes.setInt32((entries + i) * 4, script.words[at]!, true));
  return createHash('sha256').update(new Uint8Array(bytes.buffer)).digest('hex');
}

/**
 * The instructions reachable from `bits`' entries, and the tables they read (start → index of TABLE_END). Every
 * instruction falls through except those in NO_FALL_THROUGH; every jump target is followed. A table's words are data.
 */
function walk(script: AiScript, bits: number[]): { instrs: Map<number, Instr>; tables: Map<number, number> } {
  const instrs = new Map<number, Instr>();
  const tables = new Map<number, number>();
  const pending = bits.map((bit) => {
    const entry = script.flagEntries[bit];
    if (entry === undefined) throw new RangeError(`the script has no entry for flag bit ${bit}`);
    return entry;
  });
  while (pending.length > 0) {
    const at = pending.pop()!;
    if (instrs.has(at)) continue;
    const instr = decodeAt(script.words, at);
    instrs.set(at, instr);
    let target = 0;
    for (const kind of instr.op.args) {
      if (kind === 'jump') pending.push(instr.targets[target++]!);
      if (kind === 'table') {
        const start = instr.targets[target++]!;
        if (!tables.has(start)) tables.set(start, tableEnd(script.words, start));
      }
    }
    if (!NO_FALL_THROUGH.has(instr.op.name)) pending.push(at + 1 + instr.args.length);
  }
  return { instrs: new Map([...instrs].sort(([a], [b]) => a - b)), tables };
}

/** The index of the TABLE_END that ends the table at `start` (trainer_ai.c:866). */
function tableEnd(words: Int32Array, start: number): number {
  for (let at = start; at >= 0 && at < words.length; at++) {
    if (words[at] === TABLE_END) return at;
  }
  throw new AiError('UNKNOWN_OPCODE', `the table at word ${start} has no TABLE_END before the script ends`);
}
