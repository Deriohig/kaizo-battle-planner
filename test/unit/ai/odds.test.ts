import { describe, expect, it } from 'vitest';
import { cdiv, s8, u8, u16, u32, udivCartridge } from '../../../src/ai/int.js';
import { countU16, rat, residueWeights } from '../../../src/ai/odds.js';
import { codeOf } from './opsHarness.js';

describe('odds', () => {
  it('residueWeights weighs each residue of RandNext() % n by its count in 0..65535', () => {
    expect(residueWeights(3)).toEqual([21846n, 21845n, 21845n]);
    expect(residueWeights(16)).toEqual(Array<bigint>(16).fill(4096n));
  });

  it('countU16 counts the u16 draws a predicate accepts', () => {
    expect(countU16((r) => r % 3 < 2)).toBe(43691n);
    expect(countU16((r) => r % 5 === 0)).toBe(13108n);
  });

  it('rat reduces and keeps the denominator positive', () => {
    expect(rat(2, -4)).toEqual({ num: -1n, den: 2n });
    expect(rat(0n, 7n)).toEqual({ num: 0n, den: 1n });
  });
});

describe('C integers', () => {
  it('truncate to s8, u8, u16 and u32, and cdiv divides toward zero', () => {
    expect([s8(128), u8(256 + 7), u16(-1), u32(-1)]).toEqual([-128, 7, 0xffff, 0xffffffff]);
    expect([cdiv(-7, 2), cdiv(7, -2)]).toEqual([-3, -3]);
    expect(codeOf(() => cdiv(1, 0))).toBe('DIV_ZERO');
  });

  it("udivCartridge divides as the cartridge's _u32_div_f: u32 operands, truncated, and x / 0 = x", () => {
    expect([udivCartridge(7, 2), udivCartridge(7700, 155), udivCartridge(-1, 2), udivCartridge(10, -1)]).toEqual([3, 49, 0x7fffffff, 0]);
    // `cmp r1,#0; bxeq lr` returns the dividend, as a u32, for a zero divisor.
    expect([udivCartridge(0, 0), udivCartridge(5, 0), udivCartridge(-5, 0)]).toEqual([0, 5, 0xfffffffb]);
  });
});
