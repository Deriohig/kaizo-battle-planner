// Assembler for trainer AI scripts: one `[Label:] Name arg, arg` per line, plus `TableEntry n` and `TableEnd`. A bare
// identifier arg is a label: a jump word at j holds `target - (j + 1)`, a table word at t `target - (t + 2)` (aicmd.inc:9, 169).

import { type ArgKind, type OpcodeInfo, OPCODES } from '../../../src/ai/script/opcodes.js';

/** aicmd.inc:632. */
const TABLE_END = 0xffffffff;
const LABEL = /^([A-Za-z_]\w*):(.*)$/;
const IDENTIFIER = /^[A-Za-z_]\w*$/;
const NUMBER = /^-?(0x[0-9a-f]+|\d+)$/i;

interface Line { lineNo: number; at: number; name: string; args: string[] }

export function assemble(src: string): { words: Int32Array; labels: Record<string, number> } {
  const labels: Record<string, number> = {};
  const lines: Line[] = [];
  let at = 0;
  src.split('\n').forEach((raw, i) => {
    let text = raw.trim();
    const label = LABEL.exec(text);
    if (label) {
      const name = label[1]!;
      if (Object.hasOwn(labels, name)) throw new Error(`line ${i + 1}: label ${name} is defined twice`);
      labels[name] = at;
      text = label[2]!.trim();
    }
    if (text === '') return;
    const space = text.search(/\s/);
    const name = space < 0 ? text : text.slice(0, space);
    const argText = space < 0 ? '' : text.slice(space).trim();
    const args = argText === '' ? [] : argText.split(',').map((arg) => arg.trim());
    const size = wordCount(name, args.length, i + 1);
    lines.push({ lineNo: i + 1, at, name, args });
    at += size;
  });

  const words = new Int32Array(at);
  for (const line of lines) {
    if (line.name === 'TableEntry') {
      words[line.at] = number(line.args[0]!, line.lineNo);
    } else if (line.name === 'TableEnd') {
      words[line.at] = TABLE_END;
    } else {
      const op = opcode(line.name, line.lineNo);
      words[line.at] = op.code;
      op.args.forEach((kind, k) => {
        const index = line.at + 1 + k;
        words[index] = encode(kind, line.args[k]!, index, labels, line.lineNo);
      });
    }
  }
  return { words, labels };
}

/** How many words the line takes, after checking its argument count. */
function wordCount(name: string, argCount: number, lineNo: number): number {
  const expected = name === 'TableEntry' ? 1 : name === 'TableEnd' ? 0 : opcode(name, lineNo).args.length;
  if (argCount !== expected) throw new Error(`line ${lineNo}: ${name} takes ${expected} arguments, not ${argCount}`);
  return name === 'TableEntry' || name === 'TableEnd' ? 1 : expected + 1;
}

function opcode(name: string, lineNo: number): OpcodeInfo {
  const op = OPCODES.find((info) => info.name === name);
  if (!op) throw new Error(`line ${lineNo}: unknown opcode ${name}`);
  return op;
}

function encode(kind: ArgKind, arg: string, index: number, labels: Record<string, number>, lineNo: number): number {
  if (NUMBER.test(arg)) return number(arg, lineNo);
  if (!IDENTIFIER.test(arg)) throw new Error(`line ${lineNo}: bad argument ${arg}`);
  if (kind === 'int') throw new Error(`line ${lineNo}: label ${arg} given for an int argument`);
  if (!Object.hasOwn(labels, arg)) throw new Error(`line ${lineNo}: undefined label ${arg}`);
  return labels[arg]! - (index + (kind === 'jump' ? 1 : 2));
}

function number(text: string, lineNo: number): number {
  if (!NUMBER.test(text)) throw new Error(`line ${lineNo}: ${text} is not a number`);
  const negative = text.startsWith('-');
  const magnitude = Number(negative ? text.slice(1) : text);
  return negative ? -magnitude : magnitude;
}
