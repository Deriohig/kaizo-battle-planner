// Decodes PK4 records: 0x88 bytes in a box, 0xEC in the party. Bytes 0x08–0x87 hold four 0x20-byte blocks (A–D),
// shuffled by the PID and XORed with an LCRNG stream seeded by the checksum. Party records add 0x88–0xEB, XORed with a
// stream seeded by the PID: the status word at 0x88, the level at 0x8C, current HP at 0x8E and the six stats from 0x90.

import { lcrngNext } from '../rom/lcrng.js';
import type { Stats } from '../rom/types.js';
import { decodeStatus, type StartStatus } from './status.js';
import { decodeText } from './text.js';

export const BOX_RECORD_SIZE = 0x88;
export const PARTY_RECORD_SIZE = 0xec;

const BLOCKS_START = 0x08;
const BLOCK_SIZE = 0x20;
const BLOCK_A = BLOCKS_START;
const BLOCK_B = BLOCK_A + BLOCK_SIZE;
const BLOCK_C = BLOCK_B + BLOCK_SIZE;
const BLOCK_D = BLOCK_C + BLOCK_SIZE;
const NICKNAME_LENGTH = 11;
const MOVE_SLOTS = 4;
const EGG_BIT = 1 << 30;
/** Block B +0x18 holds bit 0 the fateful-encounter flag, bit 1 female, bit 2 genderless and bits 3–7 the form. */
const GENDER_FORM = BLOCK_B + 0x18;
const FEMALE_BIT = 1 << 1;
// The original trainer (pokeplatinum include/struct_defs/pokemon.h): block A +0x04 `u32 otID` (trainer ID in the low half,
// secret ID in the high) and +0x0F `u8 originLanguage`; block D +0x00 `u16 otName[TRAINER_NAME_LEN + 1]` (TRAINER_NAME_LEN
// is 7, include/constants/string.h:5, so 8 codes) and +0x1C the byte whose bit 7 is `otGender` (bits 0-6 are metLevel).
const OT_ID = BLOCK_A + 0x04;
const ORIGIN_LANGUAGE = BLOCK_A + 0x0f;
const OT_NAME = BLOCK_D;
/** The OT name is 7 characters and a terminator: TRAINER_NAME_LEN + 1 (include/constants/string.h:5). */
export const OT_NAME_CODES = 8;
const OT_GENDER = BLOCK_D + 0x1c;
const GENDERLESS_BIT = 1 << 2;

/** The stored order of the blocks, indexed by `((pid & 0x3E000) >> 13) % 24`. */
const BLOCK_ORDERS = ['ABCD', 'ABDC', 'ACBD', 'ACDB', 'ADBC', 'ADCB', 'BACD', 'BADC', 'BCAD', 'BCDA', 'BDAC', 'BDCA',
  'CABD', 'CADB', 'CBAD', 'CBDA', 'CDAB', 'CDBA', 'DABC', 'DACB', 'DBAC', 'DBCA', 'DCAB', 'DCBA'];

/**
 * The fields stored in a PK4 record. `moveSlots` holds all four move slots, 0 for an empty one; `moves`, `pp` and
 * `ppUps` leave the empty slots out, so entry k of each belongs to the same move. Fields of a bad checksum record are
 * garbage.
 */
export interface Pk4 {
  pid: number;
  species: number;
  form: number;
  gender: 'M' | 'F' | null;
  nickname: string;
  exp: number;
  /** Friendship, 0–255 (block A +0x0C). */
  friendship: number;
  nature: number;
  ability: number;
  item: number;
  moves: number[];
  moveSlots: number[];
  /** Current PP of each move. */
  pp: number[];
  /** PP Ups used on each move, 0–3. */
  ppUps: number[];
  ivs: Stats;
  evs: Stats;
  isEgg: boolean;
  badChecksum: boolean;
  /** Original trainer ID: the trainer ID in the low 16 bits, the secret ID in the high (block A +0x04). */
  otId: number;
  /** Original trainer gender, 0 male or 1 female (block D +0x1C, bit 7). */
  otGender: number;
  /** The original trainer's name as the 8 raw u16 character codes stored (block D +0x00), 0xFFFF ending the name. Compare as codes: decoded text turns unknown codes into `?`. */
  otName: number[];
  /** The language the Pokémon came from (block A +0x0F): 2 is English, the game's own (`GAME_LANGUAGE`). */
  language: number;
}

/** The party extra fields of a 0xEC-byte record. `storedStats.hp` is the max HP. */
export interface Pk4Party { level: number; status: StartStatus; currentHp: number; storedStats: Stats }

/** An empty slot: PID 0 and checksum 0. */
export function isEmptyRecord(record: Uint8Array): boolean {
  const view = viewOf(record);
  return view.getUint32(0, true) === 0 && view.getUint16(6, true) === 0;
}

/** A decrypted copy of `record`, with blocks A–D in order and the party extra data (if any) decrypted too. */
export function decryptPk4(record: Uint8Array): Uint8Array {
  // A plain Uint8Array copy: a Node Buffer's `slice` is a view, so decrypting it would change the caller's file.
  const data = new Uint8Array(record);
  const view = viewOf(data);
  const pid = view.getUint32(0, true);
  xorStream(view, BLOCKS_START, BOX_RECORD_SIZE, view.getUint16(6, true));
  if (data.length >= PARTY_RECORD_SIZE) xorStream(view, BOX_RECORD_SIZE, PARTY_RECORD_SIZE, pid);

  const stored = data.slice(BLOCKS_START, BOX_RECORD_SIZE);
  const order = BLOCK_ORDERS[((pid & 0x3e000) >>> 13) % 24]!;
  [...'ABCD'].forEach((letter, block) => {
    const position = order.indexOf(letter);
    data.set(stored.subarray(position * BLOCK_SIZE, (position + 1) * BLOCK_SIZE), BLOCKS_START + block * BLOCK_SIZE);
  });
  return data;
}

/** Decodes the stored fields. A checksum mismatch sets `badChecksum` instead of throwing. */
export function decodePk4(record: Uint8Array): Pk4 {
  const data = decryptPk4(record);
  const view = viewOf(data);
  const pid = view.getUint32(0, true);
  const ivWord = view.getUint32(BLOCK_B + 16, true);
  const genderForm = view.getUint8(GENDER_FORM);
  const moveSlots = bySlot((i) => view.getUint16(BLOCK_B + i * 2, true));
  const usedSlot = (_: number, i: number) => moveSlots[i] !== 0;
  return {
    pid,
    species: view.getUint16(BLOCK_A, true),
    form: genderForm >> 3,
    gender: genderForm & GENDERLESS_BIT ? null : genderForm & FEMALE_BIT ? 'F' : 'M',
    nickname: decodeText(Array.from({ length: NICKNAME_LENGTH }, (_, i) => view.getUint16(BLOCK_C + i * 2, true))),
    exp: view.getUint32(BLOCK_A + 8, true),
    friendship: view.getUint8(BLOCK_A + 12),
    nature: pid % 25,
    ability: view.getUint8(BLOCK_A + 13),
    item: view.getUint16(BLOCK_A + 2, true),
    moves: moveSlots.filter(usedSlot),
    moveSlots,
    pp: bySlot((i) => view.getUint8(BLOCK_B + 0x08 + i)).filter(usedSlot),
    ppUps: bySlot((i) => view.getUint8(BLOCK_B + 0x0c + i)).filter(usedSlot),
    ivs: inStoredOrder((i) => (ivWord >>> (5 * i)) & 0x1f),
    evs: inStoredOrder((i) => view.getUint8(BLOCK_A + 16 + i)),
    isEgg: (ivWord & EGG_BIT) !== 0,
    badChecksum: checksum(view) !== view.getUint16(6, true),
    otId: view.getUint32(OT_ID, true),
    otGender: view.getUint8(OT_GENDER) >> 7,
    otName: Array.from({ length: OT_NAME_CODES }, (_, i) => view.getUint16(OT_NAME + i * 2, true)),
    language: view.getUint8(ORIGIN_LANGUAGE),
  };
}

/** Decodes the party extra data of a 0xEC-byte record: level, status, current HP and the six stats (max HP first). */
export function decodePartyExtra(record: Uint8Array): Pk4Party {
  const view = viewOf(decryptPk4(record));
  return {
    level: view.getUint8(0x8c),
    status: decodeStatus(view.getUint32(0x88, true)),
    currentHp: view.getUint16(0x8e, true),
    storedStats: inStoredOrder((i) => view.getUint16(0x90 + i * 2, true)),
  };
}

/** The four values `read(slot)` gives, one per move slot. */
function bySlot(read: (slot: number) => number): number[] {
  return Array.from({ length: MOVE_SLOTS }, (_, slot) => read(slot));
}

/** Stats from a PK4 field stored HP, Atk, Def, Spe, SpA, SpD, where `read(i)` gives the i-th stored value. */
function inStoredOrder(read: (i: number) => number): Stats {
  return { hp: read(0), atk: read(1), def: read(2), spe: read(3), spa: read(4), spd: read(5) };
}

/** The sum of the 64 decrypted u16 values in 0x08–0x87, & 0xFFFF. */
function checksum(view: DataView): number {
  let sum = 0;
  for (let offset = BLOCKS_START; offset < BOX_RECORD_SIZE; offset += 2) sum += view.getUint16(offset, true);
  return sum & 0xffff;
}

/** XORs the u16 values in [start, end) with the LCRNG stream seeded by `seed`. */
function xorStream(view: DataView, start: number, end: number, seed: number): void {
  let state = seed;
  for (let offset = start; offset < end; offset += 2) {
    const step = lcrngNext(state);
    state = step.seed;
    view.setUint16(offset, view.getUint16(offset, true) ^ step.rand, true);
  }
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
