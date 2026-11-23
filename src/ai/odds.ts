// Exact probabilities for the trainer AI. The names match the engine's src/engine/rational.ts and odds.ts, so the AI can
// switch to those.

import type { Rational } from '../contracts/engine.js';

/** The number of values `BattleSystem_RandNext` returns: a u16, 0..65535. */
export const U16 = 65536n;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** `num / den`, reduced, with `den > 0n`. Throws on a zero denominator. */
export function rat(num: bigint | number, den: bigint | number): Rational {
  let n = BigInt(num);
  let d = BigInt(den);
  if (d === 0n) throw new Error(`rational ${n}/0 has a zero denominator`);
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { num: n / g, den: d / g };
}

export const ZERO: Rational = rat(0, 1);
export const ONE: Rational = rat(1, 1);

export function add(a: Rational, b: Rational): Rational {
  return rat(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function mul(a: Rational, b: Rational): Rational {
  return rat(a.num * b.num, a.den * b.den);
}

/** Both are reduced with a positive denominator, so equal values have equal parts. */
export function eq(a: Rational, b: Rational): boolean {
  return a.num === b.num && a.den === b.den;
}

export function sum(rs: Rational[]): Rational {
  return rs.reduce(add, ZERO);
}

/**
 * The weight of each residue of `RandNext() % n`: element `i` counts the r in 0..65535 with `r % n == i`. The low
 * residues get one more when `n` doesn't divide 65536.
 */
export function residueWeights(n: number): bigint[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`residueWeights needs a positive integer modulus, not ${n}`);
  const modulus = BigInt(n);
  const base = U16 / modulus;
  const extra = U16 % modulus;
  return Array.from({ length: n }, (_, i) => base + (BigInt(i) < extra ? 1n : 0n));
}

/** How many of the 65536 values of `RandNext()` satisfy `pred`. */
export function countU16(pred: (r: number) => boolean): bigint {
  let count = 0;
  for (let r = 0; r < 65536; r++) if (pred(r)) count++;
  return BigInt(count);
}
