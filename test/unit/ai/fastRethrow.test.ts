// moveDistribution's fast path rethrows the first run's AiError rather than rerun it on the slow path. runScript counts runs.

import { describe, expect, it, vi } from 'vitest';
import { fastMoveDistribution, moveDistribution, slowMoveDistribution } from '../../../src/ai/choose/moves.js';
import { AiError } from '../../../src/ai/errors.js';
import { runScript } from '../../../src/ai/script/run.js';
import { assemble } from './asm.js';
import { emptyKnowledge, fixtureDeps, fixtureView } from './fixtures.js';

vi.mock('../../../src/ai/script/run.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/ai/script/run.js')>();
  return { ...original, runScript: vi.fn(original.runScript) };
});
const counted = vi.mocked(runScript);

/** `src` as AI flag bit 0, with the word at label `Bad` no command: AiError('UNKNOWN_OPCODE') when a run reaches it. */
function depsWith(src: string) {
  const { words, labels } = assemble(`${src}\nTerminate: PopOrEnd`);
  const patched = Int32Array.from(words);
  patched[labels.Bad!] = 0x7fff;
  const flagEntries = Array<number>(32).fill(labels.Terminate!);
  flagEntries[0] = 0;
  return { ...fixtureDeps(), script: { words: patched, flagEntries, sha256: '' } };
}

/** The AiError `fn` throws, as [code, message], and the runScript calls it made. */
function failure(fn: () => unknown): { error: [string, string]; runs: number } {
  counted.mockClear();
  try {
    fn();
  } catch (error) {
    if (error instanceof AiError) return { error: [error.code, error.message], runs: counted.mock.calls.length };
    throw error;
  }
  throw new Error('expected an AiError');
}

describe("the fast path's rethrow of the first run's AiError", () => {
  it('the first run throws: the same error as the slow path, from that one run (the slow path is never entered)', () => {
    const d = depsWith('Bad: PopOrEnd');
    const v = fixtureView();
    const slow = failure(() => slowMoveDistribution(v, d, emptyKnowledge()));
    expect(slow.error[0]).toBe('UNKNOWN_OPCODE');
    expect(failure(() => moveDistribution(v, d, emptyKnowledge()))).toEqual({ error: slow.error, runs: 1 });
    expect(() => fastMoveDistribution(v, d, emptyKnowledge())).toThrow(AiError);
  });

  it("a later run throws: the slow path decides, as the fast path can't prove it would throw that error first", () => {
    // Only the AI's slot-1 move (Earthquake) reaches the bad word, after slot 0's runs end.
    const v = fixtureView();
    const d = depsWith(`IfMoveEqualTo ${v.mons[1].moves[1]}, Bad\nPopOrEnd\nBad: PopOrEnd`);
    const slow = failure(() => slowMoveDistribution(v, d, emptyKnowledge()));
    counted.mockClear();
    expect(fastMoveDistribution(v, d, emptyKnowledge())).toBeNull();
    const fastRuns = counted.mock.calls.length;
    expect(failure(() => moveDistribution(v, d, emptyKnowledge()))).toEqual({ error: slow.error, runs: fastRuns + slow.runs });
  });
});
