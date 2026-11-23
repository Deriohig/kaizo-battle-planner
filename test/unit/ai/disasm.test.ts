import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AiError } from '../../../src/ai/errors.js';
import type { AiScript } from '../../../src/ai/rom/script.js';
import { decodeAt, reachable, scriptId } from '../../../src/ai/script/disasm.js';
import { OP, OPCODES } from '../../../src/ai/script/opcodes.js';
import { assemble } from './asm.js';

/** `words` as a script whose 32 flag bits all start at `entry`. */
const asScript = (words: Int32Array, entry: number): AiScript => ({ words, flagEntries: Array<number>(32).fill(entry), sha256: '' });
const reached = (words: Int32Array, entry = 0) => [...reachable(asScript(words, entry), [0]).keys()];

describe('decodeAt', () => {
  it('decodes a jump: aicmd.inc:9 writes (Done - .) / 4 - 1', () => {
    const { words, labels } = assemble('Start: IfRandomLessThan 128, Done\nAddToMoveScore -1\nDone: PopOrEnd');
    expect([...words]).toEqual([OP.IfRandomLessThan, 128, 2, OP.AddToMoveScore, -1, OP.PopOrEnd]);
    expect(decodeAt(words, labels.Start!)).toEqual({ at: 0, op: OPCODES[OP.IfRandomLessThan], args: [128, 2], targets: [labels.Done] });
  });

  it('decodes a table jump, and hashes the table as data (aicmd.inc:169)', () => {
    const { words, labels } = assemble(`
      Start: IfLoadedInTable Tbl, Done
      AddToMoveScore 1
      Done: PopOrEnd
      AddToMoveScore 99
      Tbl: TableEntry 7
      TableEntry 0x10
      TableEnd
      AddToMoveScore 5
    `);
    expect(words[1]).toBe(5); // (Tbl - .) / 4 - 2
    expect(decodeAt(words, labels.Start!).targets).toEqual([labels.Tbl, labels.Done]);
    // The code after PopOrEnd and after the table is unreachable, so neither is hashed. The 32 flag entries come first.
    const script = asScript(words, labels.Start!);
    expect(reached(words, labels.Start!)).toEqual([labels.Start, 3, labels.Done]);
    const hashed = [...script.flagEntries, ...words.subarray(0, 6), ...words.subarray(labels.Tbl!, labels.Tbl! + 3)];
    expect(scriptId(script)).toBe(createHash('sha256').update(new Uint8Array(Int32Array.from(hashed).buffer)).digest('hex'));
  });

  it('an unknown opcode names its index', () => {
    const words = Int32Array.from([...Array<number>(5).fill(OP.LoadTurnCount), 999]);
    const expected = expect.objectContaining({ code: 'UNKNOWN_OPCODE', message: expect.stringContaining('word 5') });
    expect(() => decodeAt(words, 5)).toThrow(AiError);
    expect(() => decodeAt(words, 5)).toThrow(expected);
    expect(() => reached(words)).toThrow(expected);
  });
});

it.each([
  ['PushAndGoTo returns', 'PushAndGoTo Sub\nAddToMoveScore 1\nPopOrEnd\nSub: PopOrEnd', [0, 2, 4, 5]],
  ['GoTo, PopOrEnd and Escape do not fall through',
    'GoTo Esc\nAddToMoveScore 1\nEsc: IfRandomLessThan 1, End\nEscape\nAddToMoveScore 2\nEnd: PopOrEnd\nAddToMoveScore 3', [0, 4, 7, 10]],
])('reachable: %s', (_, src, expected) => {
  expect(reached(assemble(src).words)).toEqual(expected);
});

it("scriptId changes when two flags' entries swap, though the same words are reached", () => {
  const { words, labels } = assemble('A: AddToMoveScore 1\nPopOrEnd\nB: AddToMoveScore 2\nPopOrEnd');
  const ab = asScript(words, labels.A!);
  ab.flagEntries[1] = labels.B!;
  const ba = asScript(words, labels.A!);
  ba.flagEntries[0] = labels.B!;
  expect(reachable(ab, [0, 1])).toEqual(reachable(ba, [0, 1]));
  expect(scriptId(ab)).not.toBe(scriptId(ba));
});

it('OPCODES has 109 entries, indexed by code, with the numbers aicmd.inc writes by hand', () => {
  expect(OPCODES.length).toBe(109);
  expect(OPCODES.every((op, code) => op.code === code)).toBe(true);
  expect([
    OP.IfRandomLessThan, OP.LoadTurnCount, OP.LoadMovePower, OP.LoadCurrentMove, OP.LoadCurrentMoveEffect,
    OP.CalcMaxEffectiveness, OP.LoadCurrentWeather, OP.Escape, OP.Dummy3F, OP.LoadBattleType, OP.LoadTypeOfLoadedMove,
    OP.LoadPowerOfLoadedMove, OP.LoadEffectOfLoadedMove, OP.PopOrEnd, OP.IfTargetIsPartner, OP.LoadCurrentMovePP,
    OP.LoadCurrentMoveClass, OP.LoadDefenderLastUsedMoveClass, OP.LoadAbility,
  ]).toEqual([0, 29, 31, 39, 40, 42, 46, 61, 63, 69, 71, 72, 73, 77, 81, 91, 93, 94, 108]);
});
