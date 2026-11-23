// Decodes experience tables from `poketool/personal/pl_growtbl.narc` (one record per growth rate)
// and turns experience into a level.

import { RomError } from '../errors.js';

const MAX_LEVEL = 100;

/** Decodes one growth rate: the total experience needed at each level, indexed by level 0–100. */
export function decodeGrowth(rec: Uint8Array): number[] {
  const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  return Array.from({ length: MAX_LEVEL + 1 }, (_, level) => view.getUint32(level * 4, true));
}

/** The highest level whose required experience is at most `exp`, using the table for growth rate `rate`. */
export function levelFromExp(growth: number[][], rate: number, exp: number): number {
  const table = growth[rate];
  if (table === undefined) {
    throw new RomError('BAD_FORMAT', `Unknown growth rate ${rate}`);
  }
  return table.findLastIndex((required) => required <= exp);
}
