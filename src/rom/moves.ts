// Decodes move records from `poketool/waza/pl_waza_tbl.narc` (16 bytes each).

import { RomError } from '../errors.js';
import type { MoveCategory, MoveRecord } from './types.js';

const CATEGORIES: readonly MoveCategory[] = ['physical', 'special', 'status'];

/** Decodes one move. Priority is signed. */
export function decodeMove(id: number, rec: Uint8Array): MoveRecord {
  const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const categoryByte = view.getUint8(2);
  const category = CATEGORIES[categoryByte];
  if (category === undefined) {
    throw new RomError('BAD_FORMAT', `Move ${id} has unknown category ${categoryByte}`);
  }
  return {
    id,
    effect: view.getUint16(0, true),
    category,
    power: view.getUint8(3),
    type: view.getUint8(4),
    accuracy: view.getUint8(5),
    pp: view.getUint8(6),
    effectChance: view.getUint8(7),
    target: view.getUint16(8, true),
    priority: view.getInt8(10),
    flags: view.getUint8(11),
  };
}
