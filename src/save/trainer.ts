// The save's trainer, from the `TrainerInfo` in the general block (pokeplatinum include/trainer_info.h:9-21), the one
// place the planner reads it from. `src/server/saveInfo.ts` reads the same bytes for the setup page; it can delegate here.

import { OT_NAME_CODES } from './pk4.js';
import { decodeText } from './text.js';

/**
 * The save's trainer. `nameCodes` are the 8 raw u16 codes (compare those; `name` is the decoded text for display).
 * `badges` is the number of set bits of the badge mask, as `TrainerInfo_BadgeCount` counts them (trainer_info.c:121-131).
 */
export interface SaveTrainer { id: number; gender: number; name: string; nameCodes: number[]; badges: number }

// TrainerInfo starts at 0x68 of the general block: name u16[8] at +0x00, id u32 at +0x10, money u32 at +0x14, gender u8 at
// +0x18, language u8 at +0x19, badgeMask u8 at +0x1A.
const TRAINER_NAME = 0x68;
const TRAINER_ID = 0x78;
const TRAINER_GENDER = 0x80;
const TRAINER_BADGES = 0x82;

/** The number of set bits of `mask` (a byte). */
export function bitCount(mask: number): number {
  let count = 0;
  for (let bits = mask; bits !== 0; bits >>>= 1) count += bits & 1;
  return count;
}

/** The trainer in a general block. */
export function readTrainer(general: Uint8Array): SaveTrainer {
  const view = new DataView(general.buffer, general.byteOffset, general.byteLength);
  const nameCodes = Array.from({ length: OT_NAME_CODES }, (_, i) => view.getUint16(TRAINER_NAME + i * 2, true));
  return { id: view.getUint32(TRAINER_ID, true), gender: view.getUint8(TRAINER_GENDER), name: decodeText(nameCodes), nameCodes, badges: bitCount(view.getUint8(TRAINER_BADGES)) };
}
