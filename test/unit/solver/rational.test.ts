import { expect, it } from 'vitest';
import { add, cmp, div, fromJson, mul, ONE, percent, rat, sub, sum, toJson, toNumber, ZERO } from '../../../src/solver/rational.js';

it('rational arithmetic is exact and normalised', () => {
  expect([rat(6, -8), rat(0, 5)]).toEqual([{ num: -3n, den: 4n }, { num: 0n, den: 1n }]);
  expect(add(rat(1, 3), rat(1, 6))).toEqual(rat(1, 2));
  expect(mul(rat(62261, 65536), rat(1, 16))).toEqual(rat(62261, 1048576));
  expect(sub(ONE, mul(rat(3, 4), rat(3, 4)))).toEqual(rat(7, 16));
  expect(sum(Array(16).fill(rat(1, 16)))).toEqual(ONE);
  expect(cmp(rat(21846, 65536), rat(1, 3))).toBe(1);
  expect([toJson(rat(7, 16)), fromJson(toJson(rat(-7, 16)))]).toEqual(['7/16', rat(-7, 16)]);
  expect([percent(rat(1, 16)), percent(rat(2, 3)), percent(rat(1, 3), 0), percent(rat(-1, 8), 1)]).toEqual(['6.25%', '66.67%', '33%', '-12.5%']);
});

it('rational rejects bad input', () => {
  expect(() => fromJson('1/0')).toThrow();
  expect(() => rat(1, 0)).toThrow(RangeError);
  expect(() => rat(1.5)).toThrow(RangeError);
  expect(() => div(ONE, ZERO)).toThrow();
});

it('toNumber stays finite past 2^1024', () => {
  // Long proof paths multiply many small chances; Number() alone would give Infinity / Infinity = NaN.
  expect(toNumber(rat(1, 4))).toBe(0.25);
  expect(toNumber(add(rat(1, 2), rat(3n, 2n ** 1100n)))).toBe(0.5);
  expect(toNumber(div(rat(2n ** 1200n + 1n, 3n), rat(2n ** 1200n, 1n)))).toBeCloseTo(1 / 3, 15);
});
