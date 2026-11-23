// Exact odds for the page. A probability arrives as "num/den" (RationalJson) with numerators up to 30 digits or more,
// so the percent is worked out in BigInt: 4 significant digits, rounded half up, trailing zeros stripped. A non-zero
// value never shows as 0%, and a value below 1 never shows as 100% (it caps at 99.99%). Below 0.001% (after rounding)
// the percent is "< 0.001%": there is never exponent notation. A float chance (a hit chance) goes through the same
// formatter. Damage is HP first, then the percent of max HP to one decimal: "22–27 HP (44–54%)". Also counts and
// durations for the plan view, and dates for the header and the save copies.

import type { RationalJson } from '../../src/server/apiTypes';

const SIGNIFICANT = 4;

/** As today, but a non-zero value below 0.001% (after rounding) is "< 0.001%". Never exponent notation. */
export function formatOdds(r: RationalJson): { exact: string; percent: string } {
  const m = /^(-?\d+)\/(\d+)$/.exec(r);
  const num = m ? BigInt(m[1]!) : 0n;
  const den = m ? BigInt(m[2]!) : 0n;
  if (den === 0n) throw new TypeError(`Not a rational "num/den": ${JSON.stringify(r)}`);
  return { exact: `${num}/${den}`, percent: percentOf(num, den) };
}

function percentOf(num: bigint, den: bigint): string {
  if (num === 0n) return '0%';
  const sign = num < 0n ? '-' : '';
  const n = (num < 0n ? -num : num) * 100n;               // the percent is n / den

  // e = floor(log10(n / den)): the digit counts give it to within one.
  let e = n.toString().length - den.toString().length;
  if (!atLeastPow10(n, den, e)) e -= 1;

  // The 4-digit mantissa: round(n / den × 10^(3 − e)), half up, from 1000 to 9999.
  const shift = SIGNIFICANT - 1 - e;
  const top = shift >= 0 ? n * 10n ** BigInt(shift) : n;
  const bottom = shift >= 0 ? den : den * 10n ** BigInt(-shift);
  let mantissa = top / bottom;
  if ((top % bottom) * 2n >= bottom) mantissa += 1n;
  if (mantissa === 10n ** BigInt(SIGNIFICANT)) {          // 9999.5 rounds up to the next power of ten
    mantissa = 10n ** BigInt(SIGNIFICANT - 1);
    e += 1;
  }
  // A value below 1 never shows as 100%: from 99.995% up it would round to 100, so it stays at 99.99%.
  if (e === 2 && mantissa === 10n ** BigInt(SIGNIFICANT - 1) && n < 100n * den) {
    mantissa = 10n ** BigInt(SIGNIFICANT) - 1n;
    e = 1;
  }
  // Below 0.001%, judged after the rounding carry. A negative value, which no odds are, is "> -0.001%".
  if (e < -3) return sign ? '> -0.001%' : '< 0.001%';

  const digits = mantissa.toString();                      // exactly 4 digits
  const decimals = SIGNIFICANT - 1 - e;                    // the value is mantissa × 10^-decimals
  if (decimals <= 0) return `${sign}${digits}${'0'.repeat(-decimals)}%`;
  const padded = digits.padStart(decimals + 1, '0');
  const point = padded.length - decimals;
  return `${sign}${stripZeros(`${padded.slice(0, point)}.${padded.slice(point)}`)}%`;
}

/** A chance from 0 to 1 that is a float (a hit chance), through the same formatter: 0.85 → "85%", 0.7225 → "72.25%". */
export function formatChance(chance: number): string {
  return formatOdds(`${Math.round(chance * 1e12)}/1000000000000`).percent;
}

/** A number to one decimal without a trailing .0. */
export const oneDecimal = (x: number): string => String(Math.round(x * 10) / 10);

/** "44–54%"; equal ends, after rounding, are one figure: "40%". */
export function percentRange(percent: readonly [number, number]): string {
  return `${span(oneDecimal(percent[0]), oneDecimal(percent[1]))}%`;
}

/** "22–27 HP (44–54%)", "40 HP (40%)", "1–2 HP (0.1%)", and "0 HP" when the most is 0. */
export function damageRange(hp: readonly [number, number], percent: readonly [number, number]): string {
  if (hp[1] === 0) return '0 HP';
  return `${span(String(hp[0]), String(hp[1]))} HP (${percentRange(percent)})`;
}

/** "a–b", or one figure when the ends read the same. */
function span(low: string, high: string): string {
  return low === high ? low : `${low}–${high}`;
}

/** A count with thousands separators, a number or a bigint (exact however large): 1234567 → "1,234,567", 593775n → "593,775". */
export function formatCount(n: number | bigint): string {
  return n.toLocaleString('en-GB');
}

/** A duration: "1.2 s" under 10 s, "12 s" under a minute, then "4 min 5 s". */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) return `${Math.floor(ms / 100) / 10} s`;
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

/** An ISO time in the browser's time zone: "12 June 2026, 14:03". Anything that is not a date comes back as it was. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

/** Whether n / den ≥ 10^e. */
function atLeastPow10(n: bigint, den: bigint, e: number): boolean {
  return e >= 0 ? n >= den * 10n ** BigInt(e) : n * 10n ** BigInt(-e) >= den;
}

/** "6.250" → "6.25", "100.0" → "100". */
function stripZeros(s: string): string {
  return s.replace(/\.?0+$/, '');
}
