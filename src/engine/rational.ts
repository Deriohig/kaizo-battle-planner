// Exact probabilities: the contract's `Rational`, a bigint fraction kept reduced with a positive denominator, so equal
// values have equal fields.

import type { Rational } from '../contracts/engine.js';

export type { Rational } from '../contracts/engine.js';

function bigintOf(value: bigint | number): bigint {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) throw new RangeError(`A rational takes whole numbers, not ${value}`);
  return BigInt(value);
}

function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** `num / den`, reduced. Throws `RangeError` for a zero denominator or a number that is not a safe integer. */
export function rat(num: bigint | number, den: bigint | number): Rational {
  let [n, d] = [bigintOf(num), bigintOf(den)];
  if (d === 0n) throw new RangeError('A rational needs a non-zero denominator');
  if (d < 0n) [n, d] = [-n, -d];
  const divisor = gcd(n, d); // d > 0, so never 0
  return { num: n / divisor, den: d / divisor };
}

export const ZERO: Rational = rat(0n, 1n);
export const ONE: Rational = rat(1n, 1n);

export function add(a: Rational, b: Rational): Rational {
  return a.den === b.den ? rat(a.num + b.num, a.den) : rat(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function mul(a: Rational, b: Rational): Rational {
  return rat(a.num * b.num, a.den * b.den);
}

/** Whether `a` and `b` are equal: both are reduced, so their fields are. */
export function eq(a: Rational, b: Rational): boolean {
  return a.num === b.num && a.den === b.den;
}

/** -1, 0 or 1 as `a` is below, equal to or above `b`. */
export function cmp(a: Rational, b: Rational): -1 | 0 | 1 {
  const difference = a.num * b.den - b.num * a.den;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

const bitLength = (value: bigint) => (value < 0n ? -value : value).toString(2).length;

/** The nearest double, also when the numerator or denominator is past the double range. */
export function toNumber(r: Rational): number {
  const excess = Math.max(bitLength(r.num), bitLength(r.den)) - 1000;
  if (excess <= 0) return Number(r.num) / Number(r.den);
  const shift = BigInt(excess);
  return Number(r.num >> shift) / Number(r.den >> shift);
}
