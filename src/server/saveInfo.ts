// The trainer info in a Platinum save's general block, which starts at offset 0x68 of that block (PKHeX `SAV4Pt`): the
// trainer name, eight u16 character codes at 0x68, and the badge mask, one byte at 0x82 (0x68 + 0x1A), one bit per badge.

import { selectBlocks } from '../save/blocks.js';
import { rawSave } from '../save/dsv.js';
import { decodeText } from '../save/text.js';

const TRAINER_NAME = 0x68;
const TRAINER_NAME_LENGTH = 8;
const BADGES = 0x82;

/** `badges` is the number of bits set in `badgeMask`. */
export interface TrainerInfo { name: string; badgeMask: number; badges: number }

/**
 * The trainer name and badges from the general block `readSave` reads (the newest valid one). Throws `SaveError` for a
 * file that is not a save, as `readSave` does.
 */
export function readTrainerInfo(file: Uint8Array): TrainerInfo {
  const { general } = selectBlocks(rawSave(file));
  const view = new DataView(general.buffer, general.byteOffset, general.byteLength);
  const name = decodeText(Array.from({ length: TRAINER_NAME_LENGTH }, (_, i) => view.getUint16(TRAINER_NAME + i * 2, true)));
  const badgeMask = view.getUint8(BADGES);
  return { name, badgeMask, badges: bitCount(badgeMask) };
}

function bitCount(n: number): number {
  let count = 0;
  for (let bits = n; bits !== 0; bits >>>= 1) count += bits & 1;
  return count;
}
