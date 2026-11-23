// A test-only Platinum save encoder: the save reader's steps in reverse. It writes the layout in the plan's verified
// facts with its own literals and its own copy of the block order table, so a wrong constant in the reader fails the
// round trip instead of cancelling out.

import { lcrngNext } from '../../src/rom/lcrng.js';
import type { Stats } from '../../src/rom/types.js';
import { crc16Ccitt } from '../../src/save/crc16.js';

export const SAVE_SIZE = 0x80000;
export const PARTITION_SIZE = 0x40000;
export const GENERAL_SIZE = 0xcf2c;
/** The storage block's offset within a partition: right after the general block. */
export const STORAGE_OFFSET = GENERAL_SIZE;
export const STORAGE_SIZE = 0x121e4;

const FOOTER_SIZE = 0x14;
const MAGIC = 0x20060623;
const PARTY_COUNT_OFFSET = 0x9c;
const PARTY_OFFSET = 0xa0;
const PARTY_RECORD_SIZE = 0xec;
const BOX_OFFSET = 4;
const BOX_RECORD_SIZE = 0x88;
const BOXES = 18;
const BOX_SLOTS = 30;
const BLOCK_SIZE = 0x20;

const BLOCK_ORDERS = ['ABCD', 'ABDC', 'ACBD', 'ACDB', 'ADBC', 'ADCB', 'BACD', 'BADC', 'BCAD', 'BCDA', 'BDAC', 'BDCA',
  'CABD', 'CADB', 'CBAD', 'CBDA', 'CDAB', 'CDBA', 'DABC', 'DACB', 'DBAC', 'DBCA', 'DCAB', 'DCBA'];

/** The PK4 order of stats in the EV bytes and the IV word. */
const STORED_STATS = ['hp', 'atk', 'def', 'spe', 'spa', 'spd'] as const;

const DSV_TEXT = '|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:';
const DSV_COOKIE = '|-DESMUME SAVE-|';

/** One Pokémon to encode. Fields left out are 0; moves and nickname default to empty. */
export interface TestMon {
  pid: number;
  species: number;
  form?: number;
  /** Letters, digits and spaces only, at most 10 characters. */
  nickname?: string;
  exp?: number;
  ability?: number;
  /** Friendship, block A +0x0C. */
  friendship?: number;
  item?: number;
  /** Move IDs by slot; a 0 leaves that slot empty. */
  moves?: number[];
  /** Current PP by move slot. */
  pp?: number[];
  /** PP Ups used by move slot. */
  ppUps?: number[];
  /** Default 'M' (neither gender bit set); null sets the genderless bit. */
  gender?: 'M' | 'F' | null;
  /** Sets the fateful-encounter bit, which shares a byte with the gender bits and the form. */
  fatefulEncounter?: boolean;
  ivs?: Partial<Stats>;
  evs?: Partial<Stats>;
  isEgg?: boolean;
  /** Party only: the level stored in the party extra data. */
  level?: number;
  /** Party only: the status word stored in the party extra data. */
  status?: number;
  /** Party only: the current HP stored in the party extra data. */
  currentHp?: number;
  /** Party only: the stats stored in the party extra data, max HP first. */
  storedStats?: Partial<Stats>;
  /** Flips one encrypted byte after encoding, so the stored checksum no longer matches. */
  corrupt?: boolean;
  /** Original trainer ID, trainer ID low and secret ID high (block A +4). Default 0. */
  otId?: number;
  /** Original trainer name: a string of at most 7 letters, digits and spaces (the terminator and 0xFFFF padding are added), or the raw codes of all 8 slots (block D +0). Default all 0. */
  otName?: string | number[];
  /** Original trainer gender, bit 7 of block D +0x1C. Default 0. */
  otGender?: 0 | 1;
  /** Bits 0-6 of the byte that holds `otGender` in bit 7 (block D +0x1C): the met level. Default 0. */
  metLevel?: number;
  /** Origin language byte (block A +0x0F). Default 0. */
  language?: number;
}

/** A Pokémon in a box. `box` (1–18) and `slot` (1–30) count from 1. */
export interface TestBoxMon extends TestMon { box: number; slot: number }

/**
 * One partition's contents. The link ID defaults to the save counter, which defaults to 1. `defeatedTrainers` are the ROM
 * trainer indexes whose trainer-defeated flag to set (flag 0x550 + index: bit flag % 8 of general byte 0xFEC + flag / 8).
 */
export interface TestPartition { party?: TestMon[]; boxes?: TestBoxMon[]; counter?: number; linkId?: number; trainer?: TestTrainer; defeatedTrainers?: number[] }

/** The trainer info of the general block (`TrainerInfo`, at 0x68): name 8 u16 at +0, ID u32 at +0x10, gender u8 at +0x18, badge mask u8 at +0x1A. Left out, those bytes are 0. */
export interface TestTrainer { name: string | number[]; id: number; gender: 0 | 1; badgeMask: number }

export interface BuildSaveOptions extends TestPartition {
  /** The partition this save goes in (default 0). */
  partition?: 0 | 1;
  /** The other partition's contents. Left out, it is all 0xFF, like a partition never written. */
  other?: TestPartition;
  /** Append DeSmuME's 122-byte footer (default true). */
  dsvFooter?: boolean;
}

/** A Platinum save file holding the given party and boxes. */
export function buildSave(opts: BuildSaveOptions = {}): Uint8Array {
  const own = opts.partition ?? 0;
  const save = new Uint8Array(SAVE_SIZE).fill(0xff);
  save.set(encodePartition(opts), own * PARTITION_SIZE);
  if (opts.other !== undefined) save.set(encodePartition(opts.other), (1 - own) * PARTITION_SIZE);
  return opts.dsvFooter === false ? save : withDsvFooter(save);
}

/** Flips every bit of the byte at `offset`. */
export function flipByte(file: Uint8Array, offset: number): void {
  file[offset] = (file[offset] ?? 0) ^ 0xff;
}

/** Encodes one PK4 record: 0xEC bytes with the party extra data, 0x88 without. */
export function encodePk4(mon: TestMon, party: boolean): Uint8Array {
  const [a, b, c, d] = Array.from({ length: 4 }, () => new Uint8Array(BLOCK_SIZE)) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  const blockA = viewOf(a);
  blockA.setUint16(0, mon.species, true);
  blockA.setUint16(2, mon.item ?? 0, true);
  blockA.setUint32(4, (mon.otId ?? 0) >>> 0, true);
  blockA.setUint32(8, mon.exp ?? 0, true);
  blockA.setUint8(15, mon.language ?? 0);
  blockA.setUint8(12, mon.friendship ?? 0);
  blockA.setUint8(13, mon.ability ?? 0);
  STORED_STATS.forEach((stat, i) => blockA.setUint8(16 + i, mon.evs?.[stat] ?? 0));

  const blockB = viewOf(b);
  (mon.moves ?? []).forEach((move, i) => blockB.setUint16(i * 2, move, true));
  (mon.pp ?? []).forEach((pp, i) => blockB.setUint8(0x08 + i, pp));
  (mon.ppUps ?? []).forEach((ups, i) => blockB.setUint8(0x0c + i, ups));
  const ivWord = STORED_STATS.reduce((word, stat, i) => word | ((mon.ivs?.[stat] ?? 0) << (5 * i)), 0) | (mon.isEgg ? 1 << 30 : 0);
  blockB.setUint32(16, ivWord >>> 0, true);
  // Bit 0 fateful encounter, bit 1 female, bit 2 genderless, bits 3–7 the form.
  const genderBits = mon.gender === 'F' ? 0b010 : mon.gender === null ? 0b100 : 0;
  blockB.setUint8(0x18, ((mon.form ?? 0) << 3) | genderBits | (mon.fatefulEncounter ? 1 : 0));

  const blockC = viewOf(c);
  encodeName(mon.nickname ?? '').forEach((code, i) => blockC.setUint16(i * 2, code, true));

  const blockD = viewOf(d);
  trainerNameCodes(mon.otName ?? []).forEach((code, i) => blockD.setUint16(i * 2, code, true));
  blockD.setUint8(0x1c, ((mon.otGender ?? 0) << 7) | ((mon.metLevel ?? 0) & 0x7f));

  const record = new Uint8Array(party ? PARTY_RECORD_SIZE : BOX_RECORD_SIZE);
  const view = viewOf(record);
  const blocks = { A: a, B: b, C: c, D: d };
  const order = BLOCK_ORDERS[((mon.pid & 0x3e000) >>> 13) % 24]!;
  [...order].forEach((letter, position) => record.set(blocks[letter as keyof typeof blocks], 8 + position * BLOCK_SIZE));

  let sum = 0;
  for (let offset = 8; offset < BOX_RECORD_SIZE; offset += 2) sum += view.getUint16(offset, true);
  const checksum = sum & 0xffff;
  view.setUint32(0, mon.pid >>> 0, true);
  view.setUint16(6, checksum, true);
  xorStream(view, 8, BOX_RECORD_SIZE, checksum);

  if (party) {
    view.setUint32(0x88, mon.status ?? 0, true);
    view.setUint8(0x8c, mon.level ?? 0);
    view.setUint16(0x8e, mon.currentHp ?? 0, true);
    STORED_STATS.forEach((stat, i) => view.setUint16(0x90 + i * 2, mon.storedStats?.[stat] ?? 0, true));
    xorStream(view, BOX_RECORD_SIZE, PARTY_RECORD_SIZE, mon.pid >>> 0);
  }
  if (mon.corrupt) flipByte(record, 0x86);
  return record;
}

/** A general block and a storage block, back to back, each with its footer. */
function encodePartition(p: TestPartition): Uint8Array {
  const counter = p.counter ?? 1;
  const linkId = p.linkId ?? counter;
  const party = p.party ?? [];
  if (party.length > 6) throw new Error(`A party holds at most 6 Pokémon, not ${party.length}`);

  const general = new Uint8Array(GENERAL_SIZE);
  viewOf(general).setUint32(PARTY_COUNT_OFFSET, party.length, true);
  party.forEach((mon, i) => general.set(encodePk4(mon, true), PARTY_OFFSET + i * PARTY_RECORD_SIZE));
  if (p.trainer !== undefined) {
    const view = viewOf(general);
    trainerNameCodes(p.trainer.name).forEach((code, i) => view.setUint16(0x68 + i * 2, code, true));
    view.setUint32(0x78, p.trainer.id >>> 0, true);
    view.setUint8(0x80, p.trainer.gender);
    view.setUint8(0x82, p.trainer.badgeMask);
  }
  for (const trainer of p.defeatedTrainers ?? []) {
    const flag = 0x550 + trainer;
    general[0xfec + Math.floor(flag / 8)] = (general[0xfec + Math.floor(flag / 8)] ?? 0) | (1 << (flag % 8));
  }

  const storage = new Uint8Array(STORAGE_SIZE);
  for (const mon of p.boxes ?? []) {
    if (mon.box < 1 || mon.box > BOXES || mon.slot < 1 || mon.slot > BOX_SLOTS) throw new Error(`No box ${mon.box} slot ${mon.slot}`);
    storage.set(encodePk4(mon, false), BOX_OFFSET + ((mon.box - 1) * BOX_SLOTS + mon.slot - 1) * BOX_RECORD_SIZE);
  }

  writeFooter(general, linkId, counter, 0);
  writeFooter(storage, linkId, counter, 1);
  const partition = new Uint8Array(GENERAL_SIZE + STORAGE_SIZE);
  partition.set(general, 0);
  partition.set(storage, STORAGE_OFFSET);
  return partition;
}

/** Footer: link ID, save counter, block size, magic, block ID, then the CRC of everything before the footer. */
function writeFooter(block: Uint8Array, linkId: number, counter: number, blockId: number): void {
  const view = viewOf(block);
  const footer = block.length - FOOTER_SIZE;
  view.setUint32(footer, linkId, true);
  view.setUint32(footer + 4, counter, true);
  view.setUint32(footer + 8, block.length, true);
  view.setUint32(footer + 12, MAGIC, true);
  view.setUint16(footer + 16, blockId, true);
  view.setUint16(footer + 18, crc16Ccitt(block.subarray(0, footer)), true);
}

/** DeSmuME's footer: a text line, six u32 fields (the reader ignores them) and the 16-byte cookie. 122 bytes in all. */
function withDsvFooter(save: Uint8Array): Uint8Array {
  const fields = new Uint8Array(24);
  const view = viewOf(fields);
  view.setUint32(0, SAVE_SIZE, true);
  view.setUint32(4, SAVE_SIZE, true);
  const parts = [save, ascii(DSV_TEXT), fields, ascii(DSV_COOKIE)];
  const file = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  parts.reduce((offset, part) => (file.set(part, offset), offset + part.length), 0);
  return file;
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

/** Gen 4 character codes for letters, digits and spaces, then the 0xFFFF terminator. */
function encodeName(name: string): number[] {
  if (name.length > 10) throw new Error(`Nickname too long: ${name}`);
  return [...[...name].map((char) => {
    if (char >= '0' && char <= '9') return 0x0121 + char.charCodeAt(0) - 0x30;
    if (char >= 'A' && char <= 'Z') return 0x012b + char.charCodeAt(0) - 0x41;
    if (char >= 'a' && char <= 'z') return 0x0145 + char.charCodeAt(0) - 0x61;
    if (char === ' ') return 0x01de;
    throw new Error(`The test encoder cannot write ${JSON.stringify(char)}`);
  }), 0xffff];
}

/** The 8 code slots of a trainer name: raw codes as given, or a string of up to 7 characters, 0xFFFF after it to the end. */
function trainerNameCodes(name: string | number[]): number[] {
  if (typeof name !== 'string') return name;
  if (name.length > 7) throw new Error(`Trainer name too long: ${name}`);
  const codes = encodeName(name);
  return [...codes, ...Array(8 - codes.length).fill(0xffff)];
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
