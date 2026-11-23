// Exact probabilities for the solver. Every function returns a reduced Rational with `den > 0n`. Floats appear only in
// `toNumber` (display and ordering heuristics), never in a verdict, a bound or a cut-off.

import type { Rational } from '../contracts/engine.js';

function toBigInt(x: bigint | number, what: string): bigint {
  if (typeof x === 'bigint') return x;
  if (!Number.isInteger(x)) throw new RangeError(`rational ${what} must be an integer, got ${x}`);
  return BigInt(x);
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** Reduces num/den and moves the sign onto the numerator. */
function reduce(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new RangeError('rational denominator is zero');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

/** `den` defaults to 1. Throws RangeError on a zero denominator or a non-integer number. */
export function rat(num: bigint | number, den: bigint | number = 1n): Rational {
  return reduce(toBigInt(num, 'numerator'), toBigInt(den, 'denominator'));
}

export const ZERO: Rational = Object.freeze({ num: 0n, den: 1n });
export const ONE: Rational = Object.freeze({ num: 1n, den: 1n });

export function add(a: Rational, b: Rational): Rational {
  return reduce(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function sub(a: Rational, b: Rational): Rational {
  return reduce(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function mul(a: Rational, b: Rational): Rational {
  return reduce(a.num * b.num, a.den * b.den);
}

/** Throws RangeError when `b` is zero. */
export function div(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new RangeError('rational division by zero');
  return reduce(a.num * b.den, a.den * b.num);
}

export function cmp(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function eq(a: Rational, b: Rational): boolean {
  return cmp(a, b) === 0;
}

export function isZero(r: Rational): boolean {
  return r.num === 0n;
}

export function sum(rs: Iterable<Rational>): Rational {
  let total = ZERO;
  for (const r of rs) total = add(total, r);
  return total;
}

export function minR(a: Rational, b: Rational): Rational {
  return cmp(a, b) <= 0 ? a : b;
}

export function maxR(a: Rational, b: Rational): Rational {
  return cmp(a, b) >= 0 ? a : b;
}

function bitLength(x: bigint): number {
  return abs(x).toString(2).length;
}

/** For display and ordering only. Stays finite when the numerator or denominator is past 2^1024. */
export function toNumber(r: Rational): number {
  const num = Number(r.num);
  const den = Number(r.den);
  if (Number.isFinite(num) && Number.isFinite(den)) return num / den;
  // Drop the same low bits from both so each fits a double; the quotient keeps double precision.
  const shift = BigInt(Math.max(bitLength(r.num), bitLength(r.den)) - 1000);
  return Number(r.num >> shift) / Number(r.den >> shift);
}

/** "num/den", the api.ts RationalJson form. */
export function toJson(r: Rational): string {
  return `${r.num}/${r.den}`;
}

const JSON_FORM = /^(-?\d+)\/(\d+)$/;

/** Inverse of `toJson`. Throws SyntaxError on malformed text and RangeError on a zero denominator. */
export function fromJson(s: string): Rational {
  const match = JSON_FORM.exec(s);
  if (!match) throw new SyntaxError(`not a rational "num/den": ${JSON.stringify(s)}`);
  return reduce(BigInt(match[1]!), BigInt(match[2]!));
}

/** "6.25%", rounded half up to `digits` decimals (default 2), computed exactly. */
export function percent(r: Rational, digits = 2): string {
  if (!Number.isInteger(digits) || digits < 0) throw new RangeError(`percent digits must be a non-negative integer, got ${digits}`);
  const scale = 10n ** BigInt(digits);
  const scaled = (abs(r.num) * 100n * scale * 2n + r.den) / (2n * r.den);
  const whole = scaled / scale;
  const body = digits === 0 ? `${whole}` : `${whole}.${(scaled % scale).toString().padStart(digits, '0')}`;
  return `${r.num < 0n && scaled !== 0n ? '-' : ''}${body}%`;
}
