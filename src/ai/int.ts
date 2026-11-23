// C integer semantics for the port: the truncating casts the cartridge's u8, s8, u16 and u32 variables apply, and C
// division, which truncates toward zero. Callers apply the cast the C applies, where the C applies it.

import { AiError } from './errors.js';

/** `(u8)x`: the low 8 bits. */
export function u8(x: number): number {
  return x & 0xff;
}

/** `(s8)x`: the low 8 bits, read as two's complement. */
export function s8(x: number): number {
  return (x << 24) >> 24;
}

/** `(u16)x`: the low 16 bits. */
export function u16(x: number): number {
  return x & 0xffff;
}

/** `(u32)x`: the low 32 bits, unsigned. */
export function u32(x: number): number {
  return x >>> 0;
}

/**
 * C `a / b` on u32 operands as the cartridge computes it: `_u32_div_f`, the ARM9 routine at 0x020E2178 in the hack's
 * ROM (read from the ROM's ARM9; not checked in vanilla). Its first two instructions are `cmp r1, #0` (e3510000) and
 * `bxeq lr` (012fff1e): a zero divisor returns at once with r0, the dividend, unchanged, so x / 0 = x. Otherwise the
 * quotient truncates. Use it only at a call site proven to BL into that routine; cdiv throws everywhere
 * else.
 */
export function udivCartridge(a: number, b: number): number {
  const dividend = u32(a);
  const divisor = u32(b);
  if (divisor === 0) return dividend; // 0x020E2178: cmp r1, #0; 0x020E217C: bxeq lr
  return Math.floor(dividend / divisor);
}

/** C `a / b` on integers: truncates toward zero. Throws AiError('DIV_ZERO') when `b` is 0, where the C has no defined result. */
export function cdiv(a: number, b: number): number {
  if (b === 0) throw new AiError('DIV_ZERO', `division by zero: ${a} / 0`);
  const quotient = Math.trunc(a / b);
  return quotient === 0 ? 0 : quotient; // no -0
}
