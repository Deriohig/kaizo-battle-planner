import { describe, expect, it } from 'vitest';
import { enumerate, type Pick } from '../../../src/ai/enumerate.js';
import { eq, ONE, rat, residueWeights, sum } from '../../../src/ai/odds.js';
import { codeOf } from './opsHarness.js';

const COIN = [32768n, 32768n];

describe('enumerate', () => {
  it('merges equal values: two coins', () => {
    const leaves = enumerate((pick) => pick(COIN) + pick(COIN), String);
    expect(leaves).toHaveLength(3);
    expect(Object.fromEntries(leaves.map((leaf) => [leaf.value, leaf.probability]))).toEqual({ 0: rat(1, 4), 1: rat(1, 2), 2: rat(1, 4) });
  });

  it('skips a zero weight', () => {
    expect(enumerate((pick) => pick([0n, 65536n]), String)).toEqual([{ value: 1, probability: ONE }]);
  });

  it('throws LIMIT past the limit', () => {
    const flips = (pick: Pick) => {
      let heads = 0;
      for (let i = 0; i < 20; i++) heads += pick(COIN);
      return heads;
    };
    expect(codeOf(() => enumerate(flips, String, { limit: 1000 }))).toBe('LIMIT');
  });

  it('sums to one over branches of different depths and weights', () => {
    // RandNext() % 3, then % 16 on residue 0, nothing on 1, and an uneven four-way pick with a zero weight on 2.
    const run = (pick: Pick): string => {
      const first = pick(residueWeights(3));
      if (first === 0) return `0.${pick(residueWeights(16))}`;
      if (first === 1) return '1';
      return `2.${pick([1n, 2n, 0n, 7n])}`;
    };
    const leaves = enumerate(run, (value) => value);
    expect(leaves).toHaveLength(16 + 1 + 3);
    expect(eq(sum(leaves.map((leaf) => leaf.probability)), ONE)).toBe(true);
    expect(leaves.find((leaf) => leaf.value === '2.3')?.probability).toEqual(rat(21845n * 7n, 65536n * 10n));
  });
});
