// Decodes level-up learnsets from `poketool/personal/wotbl.narc`.

import type { LevelUpMove } from './types.js';

const TERMINATOR = 0xffff;
const MOVE_MASK = 0x1ff;
const LEVEL_SHIFT = 9;

/** Decodes one learnset: u16 entries of `level << 9 | move`, ending at `0xFFFF` or the end of the record. */
export function decodeLearnset(rec: Uint8Array): LevelUpMove[] {
  const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const moves: LevelUpMove[] = [];
  for (let offset = 0; offset + 2 <= rec.length; offset += 2) {
    const entry = view.getUint16(offset, true);
    if (entry === TERMINATOR) break;
    moves.push({ move: entry & MOVE_MASK, level: entry >> LEVEL_SHIFT });
  }
  return moves;
}
