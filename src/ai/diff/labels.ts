// Names for vanilla's AI script words, from the decompilation's src/battle/trainer_ai/script.s. Each macro line is
// lined up with the vanilla words in order, by macro name and argument count; constants are not evaluated.

import type { AiScript } from '../rom/script.js';
import { decodeAt } from '../script/disasm.js';
import { type OpcodeInfo, OPCODES } from '../script/opcodes.js';

/** A label in script.s. `at` is its word index in the vanilla script. */
export interface SourceLabel { name: string; at: number }

/** Directives that emit nothing (script.s:1–15, 8108). Any other directive could move the words, so it throws. */
const SILENT_DIRECTIVES = new Set(['.ifndef', '.set', '.text', '.global', '.endif']);
/** The table terminator, as the script's `int` words read it (aicmd.inc:632). */
const TABLE_END = -1;
const LABEL = /^([A-Za-z_]\w*):(.*)$/;
const IDENTIFIER = /^[A-Za-z_]\w*$/;
const INTEGER = /^-?(0x[0-9a-f]+|\d+)$/i;

/** A label argument to check once every label is known. */
interface LabelRef { lineNo: number; label: string; expected: () => number; actual: number }

/**
 * Lines script.s up with `vanilla`'s words and returns its labels in source order. Each macro must sit where its
 * opcode is, with the opcode's argument count. Integer literals, `TABLE_END`, jump and table labels, and
 * `LabelDistance` values are checked too. Throws an Error naming the script.s line at the first mismatch.
 */
export function labelsFromSource(scriptS: string, vanilla: AiScript): SourceLabel[] {
  const opcodes = new Map(OPCODES.map((op) => [op.name, op]));
  const labels: SourceLabel[] = [];
  const labelAt = new Map<string, number>();
  const refs: LabelRef[] = [];
  const word = (at: number, lineNo: number) => {
    const value = vanilla.words[at];
    if (value === undefined) throw new Error(`script.s line ${lineNo}: word ${at} is past the end of the vanilla script`);
    return value;
  };
  const resolve = (label: string, lineNo: number) => {
    const at = labelAt.get(label);
    if (at === undefined) throw new Error(`script.s line ${lineNo}: undefined label ${label}`);
    return at;
  };

  let at = 0;
  scriptS.split('\n').forEach((raw, i) => {
    const lineNo = i + 1;
    let text = raw.replace(/\/\/.*$/, '').trim();
    const label = LABEL.exec(text);
    if (label) {
      const name = label[1]!;
      if (labelAt.has(name)) throw new Error(`script.s line ${lineNo}: label ${name} is defined twice`);
      labelAt.set(name, at);
      labels.push({ name, at });
      text = label[2]!.trim();
    }
    if (text === '' || text.startsWith('#')) return;
    const space = text.search(/\s/);
    const name = space < 0 ? text : text.slice(0, space);
    const args = space < 0 ? [] : splitArgs(text.slice(space));
    if (name.startsWith('.')) {
      if (!SILENT_DIRECTIVES.has(name)) throw new Error(`script.s line ${lineNo}: directive ${name} is not handled`);
      return;
    }

    if (name === 'TableEntry') {
      expectArgs(name, args, 1, lineNo);
      const value = word(at, lineNo);
      const arg = args[0]!;
      if ((arg === 'TABLE_END' && value !== TABLE_END) || (INTEGER.test(arg) && value !== integer(arg))) {
        throw new Error(`script.s line ${lineNo}: TableEntry ${arg} is ${value} at word ${at}`);
      }
      at += 1;
      return;
    }
    if (name === 'LabelDistance') {
      // `.long (dst - src) / 4` (aicmd.inc:638–640).
      expectArgs(name, args, 2, lineNo);
      const [dst, src] = args as [string, string];
      refs.push({ lineNo, label: `${dst} - ${src}`, expected: () => resolve(dst, lineNo) - resolve(src, lineNo), actual: word(at, lineNo) });
      at += 1;
      return;
    }

    const op = opcodes.get(name);
    if (!op) throw new Error(`script.s line ${lineNo}: unknown macro ${name}`);
    expectArgs(name, args, op.args.length, lineNo);
    const code = word(at, lineNo);
    if (code !== op.code) {
      throw new Error(`script.s line ${lineNo}: ${name} (opcode ${op.code}) expected at word ${at}, found ${OPCODES[code]?.name ?? code}`);
    }
    checkArgs(op, args, at, lineNo, vanilla, refs, resolve);
    at += 1 + op.args.length;
  });

  for (const ref of refs) {
    const expected = ref.expected();
    if (expected !== ref.actual) {
      throw new Error(`script.s line ${ref.lineNo}: ${ref.label} is word ${expected}, but the vanilla script has ${ref.actual}`);
    }
  }
  return labels;
}

/** Checks an instruction's literal arguments now, and queues its jump and table labels for after the last label. */
function checkArgs(
  op: OpcodeInfo, args: string[], at: number, lineNo: number, vanilla: AiScript, refs: LabelRef[],
  resolve: (label: string, lineNo: number) => number,
): void {
  const instr = decodeAt(vanilla.words, at);
  let target = 0;
  op.args.forEach((kind, k) => {
    const arg = args[k]!;
    if (kind === 'int') {
      if (INTEGER.test(arg) && instr.args[k] !== integer(arg)) {
        throw new Error(`script.s line ${lineNo}: ${op.name} argument ${k + 1} is ${arg}, but the vanilla word is ${instr.args[k]}`);
      }
      return;
    }
    if (!IDENTIFIER.test(arg)) throw new Error(`script.s line ${lineNo}: ${op.name} argument ${k + 1} (${arg}) is not a label`);
    refs.push({ lineNo, label: arg, expected: () => resolve(arg, lineNo), actual: instr.targets[target++]! });
  });
}

function expectArgs(name: string, args: string[], count: number, lineNo: number): void {
  if (args.length !== count) throw new Error(`script.s line ${lineNo}: ${name} takes ${count} arguments, not ${args.length}`);
}

/** Splits macro arguments at the commas outside parentheses. */
function splitArgs(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim() !== '') args.push(current.trim());
  return args;
}

function integer(text: string): number {
  const negative = text.startsWith('-');
  const magnitude = Number(negative ? text.slice(1) : text);
  return negative ? -magnitude : magnitude;
}
