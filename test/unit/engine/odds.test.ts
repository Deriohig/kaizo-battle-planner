import { describe, expect, it } from 'vitest';
import { belowWeight, residueWeights, U16 } from '../../../src/engine/odds.js';
import { add, cmp, eq, mul, ONE, rat, toNumber, ZERO } from '../../../src/engine/rational.js';

describe('cartridge odds', () => {
  it('residue weights count the 16-bit draws by remainder; below weights those under a threshold', () => {
    expect([residueWeights(3), residueWeights(16), residueWeights(1)]).toEqual([[21846n, 21845n, 21845n], Array<bigint>(16).fill(4096n), [U16]]);
    expect(residueWeights(100).reduce((sum, weight) => sum + weight, 0n)).toBe(U16);
    expect([10, 90, 75, 0, 100].map((threshold) => belowWeight(100, threshold))).toEqual([6560n, 58986n, 49161n, 0n, U16]); // 10: 10.0098%, not 10%
  });

  it.each<[string, () => unknown]>([
    ['a size of 0', () => residueWeights(0)], ['a fractional size', () => residueWeights(1.5)], ['a size past 16 bits', () => residueWeights(65537)],
    ['a threshold over the size', () => belowWeight(100, 101)], ['a negative threshold', () => belowWeight(100, -1)],
  ])('%s throws', (_, run) => expect(run).toThrow(RangeError));
});

describe('rationals', () => {
  it('are reduced, with a positive denominator; a zero denominator or a fraction throws', () => {
    expect([rat(2, 4), rat(3n, -6n), rat(0, 7), ONE]).toEqual([{ num: 1n, den: 2n }, { num: -1n, den: 2n }, ZERO, { num: 1n, den: 1n }]);
    expect(() => rat(1, 0)).toThrow(RangeError);
    expect(() => rat(0.5, 1)).toThrow(RangeError);
  });

  it('add, multiply and compare exactly, and convert to numbers, also past the double range', () => {
    expect([eq(add(rat(1, 3), rat(2, 3)), ONE), eq(add(rat(1, 10), rat(2, 10)), rat(3, 10)), eq(rat(1, 2), rat(2, 4)), eq(rat(1, 2), rat(1, 3))]).toEqual([true, true, true, false]);
    expect(mul(rat(2, 3), rat(3, 4))).toEqual(rat(1, 2));
    expect([cmp(rat(1, 3), rat(1, 2)), cmp(rat(1, 2), rat(2, 4)), cmp(rat(2, 3), rat(1, 2))]).toEqual([-1, 0, 1]);
    expect([toNumber(rat(1, 4)), toNumber(rat(-3, 2))]).toEqual([0.25, -1.5]);
    expect(toNumber(rat(2n ** 3000n + 1n, 2n ** 3001n))).toBeCloseTo(0.5, 12);
  });
});
