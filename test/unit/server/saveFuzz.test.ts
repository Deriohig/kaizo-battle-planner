// A deterministic fuzz of `buildBox` over crafted save files (a hosted server parses saves strangers upload). Every input
// either gives a box (JSON-safe, finite numbers, `pool` exactly the Pokémon with draft facts, levels the engine takes)
// or throws a `SaveError`, and fast. A CRC is no defence against a crafted file, so most cases recompute the CRC-16
// footers and many craft PK4 records whose own checksum is right. The seed is fixed (SAVE_FUZZ_SEED overrides it) and
// every failure names the seed and the case.

import { expect, it } from 'vitest';
import { lcrngNext } from '../../../src/rom/lcrng.js';
import { crc16Ccitt } from '../../../src/save/crc16.js';
import { decryptPk4 } from '../../../src/save/pk4.js';
import { SaveError } from '../../../src/save/readSave.js';
import { buildBox } from '../../../src/server/box.js';
import { DEFAULT_SETTINGS } from '../../../src/server/settings.js';
import { encodePk4, GENERAL_SIZE, PARTITION_SIZE, SAVE_SIZE, STORAGE_OFFSET, STORAGE_SIZE, type TestMon } from '../../fixtures/buildSave.js';
import { monferno, saveFile, serverData, starly } from './fixtures.js';

const SEED = Number(process.env.SAVE_FUZZ_SEED || 0x5eed2026) >>> 0;
const data = serverData();
/** The most one case may take before it counts as a hang. */
const CASE_BUDGET_MS = 1500;
const [FOOTER_SIZE, PARTY_COUNT, PARTY_START, PARTY_RECORD, BOX_START, BOX_RECORD, TRAINER_INFO] = [0x14, 0x9c, 0xa0, 0xec, 4, 0x88, 0x68];
const TRAINER_FLAGS = 0xfec + (0x550 >> 3);
const COOKIE = Uint8Array.from('|-DESMUME SAVE-|', (char) => char.charCodeAt(0));

interface Rng { int(n: number): number; u32(): number; pick<T>(list: readonly T[]): T; bytes(n: number): Uint8Array }

/** mulberry32, a tiny seeded PRNG. */
function rngOf(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    int: (n) => Math.floor(next() * n),
    u32: () => Math.floor(next() * 4294967296) >>> 0,
    pick: (list) => list[rng.int(list.length)]!,
    bytes(n) {
      const out = new Uint8Array(n);
      let i = 0;
      for (; i + 4 <= n; i += 4) viewOf(out).setUint32(i, rng.u32(), true);
      for (; i < n; i++) out[i] = rng.int(256);
      return out;
    },
  };
  return rng;
}

/** 'box', 'save error', or a finding: what went wrong. */
function runCase(file: Uint8Array): string {
  const started = performance.now();
  let outcome: string;
  try {
    const box = buildBox({ file, savePath: 'fuzz.dsv', savedAt: new Date(0), data, settings: DEFAULT_SETTINGS });
    const bad: string[] = [];
    JSON.stringify(box.json, (key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) bad.push(`${key} is ${value}`);
      return value;
    });
    const drafted = JSON.stringify(box.json.mons.filter((m) => m.draft !== null).map((m) => m.ref).sort());
    const pooled = JSON.stringify([...box.pool.keys()].sort());
    // The engine throws RangeError for a player Pokémon whose level is not a whole number from 1 to 100.
    const offLevel = [...box.team, ...box.pool.values()].find((mon) => !Number.isInteger(mon.level) || mon.level < 1 || mon.level > 100);
    if (bad.length > 0) outcome = `box holds a non-finite number: ${bad.join(', ')}`;
    else if (drafted !== pooled) outcome = `pool ${pooled} is not the Pokémon with draft facts ${drafted}`;
    else if (offLevel !== undefined) outcome = `team or pool holds a Pokémon at level ${offLevel.level}, which the engine rejects`;
    else outcome = 'box';
  } catch (error) {
    outcome = error instanceof SaveError ? 'save error' : error instanceof Error ? `${error.name}: ${error.message}` : `threw ${String(error)}`;
  }
  const ms = performance.now() - started;
  return ms > CASE_BUDGET_MS && (outcome === 'box' || outcome === 'save error') ? `took ${Math.round(ms)} ms` : outcome;
}

const VALID = saveFile();
const valid = () => new Uint8Array(VALID);
const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Partition `p`'s general or storage block of `file`, as a view into it. */
function blockOf(file: Uint8Array, p: 0 | 1, block: 'general' | 'storage'): Uint8Array {
  const start = p * PARTITION_SIZE + (block === 'general' ? 0 : STORAGE_OFFSET);
  return file.subarray(start, start + (block === 'general' ? GENERAL_SIZE : STORAGE_SIZE));
}
const BLOCKS = [[0, 'general'], [0, 'storage'], [1, 'general'], [1, 'storage']] as const;

/** Recomputes every block's CRC-16 footer, as a crafted file would. */
function resealAll(file: Uint8Array): Uint8Array {
  for (const block of BLOCKS.map(([p, kind]) => blockOf(file, p, kind))) {
    viewOf(block).setUint16(block.length - 2, crc16Ccitt(block.subarray(0, block.length - FOOTER_SIZE)), true);
  }
  return file;
}

/** The 24 orders of the blocks A–D, in the game's order (lexicographic). */
const perms = (s: string): string[] => (s.length <= 1 ? [s] : [...s].flatMap((c, i) => perms(s.slice(0, i) + s.slice(i + 1)).map((p) => c + p)));
const BLOCK_ORDERS = perms('ABCD');

/** The inverse of `decryptPk4`: the stored record, shuffled, with a checksum that matches whatever the blocks hold. */
function sealPk4(plain: Uint8Array): Uint8Array {
  const record = new Uint8Array(plain);
  const view = viewOf(record);
  const pid = view.getUint32(0, true);
  [...BLOCK_ORDERS[((pid & 0x3e000) >>> 13) % 24]!].forEach((letter, position) => {
    const block = 'ABCD'.indexOf(letter);
    record.set(plain.subarray(8 + block * 0x20, 8 + (block + 1) * 0x20), 8 + position * 0x20);
  });
  let sum = 0;
  for (let offset = 8; offset < BOX_RECORD; offset += 2) sum += view.getUint16(offset, true);
  view.setUint16(6, sum & 0xffff, true);
  const xorStream = (start: number, end: number, seed: number) => {
    for (let offset = start, state = seed; offset < end; offset += 2) {
      const step = lcrngNext(state);
      state = step.seed;
      view.setUint16(offset, view.getUint16(offset, true) ^ step.rand, true);
    }
  };
  xorStream(8, BOX_RECORD, sum & 0xffff);
  if (record.length >= PARTY_RECORD) xorStream(BOX_RECORD, PARTY_RECORD, pid);
  return record;
}

/** A valid save with `record` in party slot `slot` (1–6, the party count at least that), or in box `slot` (1–18) slot `boxSlot`. */
function withRecord(record: Uint8Array, slot: number, boxSlot?: number): Uint8Array {
  const file = valid();
  if (boxSlot !== undefined) blockOf(file, 0, 'storage').set(record.subarray(0, BOX_RECORD), BOX_START + ((slot - 1) * 30 + boxSlot - 1) * BOX_RECORD);
  else {
    const general = blockOf(file, 0, 'general');
    general.set(record, PARTY_START + (slot - 1) * PARTY_RECORD);
    viewOf(general).setUint32(PARTY_COUNT, Math.max(viewOf(general).getUint32(PARTY_COUNT, true), slot), true);
  }
  return resealAll(file);
}

/** A random plain record; `tame` keeps species and moves to ones the data names, and mostly form 0, no egg, edge levels. */
function randomPlain(rng: Rng, tame: boolean): Uint8Array {
  const plain = rng.bytes(PARTY_RECORD);
  const view = viewOf(plain);
  if (tame) {
    view.setUint16(8, rng.pick([391, 396]), true);
    for (let i = 0; i < 4; i++) view.setUint16(0x28 + i * 2, rng.pick([0, 10, 33, 45, 52]), true);
    if (rng.int(3) !== 0) view.setUint8(0x40, view.getUint8(0x40) & 0x07);
    if (rng.int(3) !== 0) view.setUint32(0x38, view.getUint32(0x38, true) & ~(1 << 30), true);
    if (rng.int(2) === 0) view.setUint8(0x8c, rng.pick([0, 1, 5, 28, 100, 101, 255]));
    if (rng.int(2) === 0) view.setUint32(0x10, rng.pick([0, 1, 2449, 1_059_860, 0x7fffffff, 0xffffffff]), true);
  }
  return plain;
}

/** Wild PK4 fields, each on the fixtures' Monferno and Starly. */
const forms = (species: number | undefined, list: number[]) => list.map((form) => (species === undefined ? { form } : { species, form }));
const WILD: TestMon[] = ([
  ...[0, 1, 493, 494, 495, 496, 507, 508, 1000, 0xffff].map((species) => ({ species })),
  ...forms(386, Array.from({ length: 32 }, (_, form) => form)), ...forms(413, [3, 4, 31]), ...forms(479, [6, 7, 31]),
  ...forms(487, [2, 31]), ...forms(492, [2, 31]), ...forms(493, [18, 31]), ...forms(undefined, [1, 5, 31]),
  { moves: [0, 0, 0, 0], pp: [], ppUps: [] }, { moves: [0xffff, 0xffff, 0xffff, 0xffff] }, { moves: [468, 467] }, { moves: [1000, 33] },
  { moves: [33, 33, 33, 33], pp: [255, 255, 255, 255], ppUps: [255, 255, 255, 255] },
  { item: 0xffff }, { item: 1000 }, { item: 1 }, { ability: 0 }, { ability: 255 }, { ability: 124 },
  ...[0, 1, 100, 101, 255].map((level) => ({ level })), ...[0, 0xffffffff, 0x80000000, 1_059_861].map((exp) => ({ exp })),
  ...[0, 0xffff, 45].map((currentHp) => ({ currentHp })), { storedStats: { hp: 0xffff, atk: 0xffff, def: 0, spa: 0xffff, spd: 0, spe: 0xffff } },
  ...[0xffffffff, 7, 0x100].map((status) => ({ status })),
  { ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, evs: { hp: 255, atk: 255, def: 255, spa: 255, spd: 255, spe: 255 } },
  { isEgg: true }, { isEgg: true, species: 0 }, { gender: null }, { gender: 'F' }, { fatefulEncounter: true },
  { otName: [0, 0, 0, 0, 0, 0, 0, 0] }, { otName: Array(8).fill(0x1234) }, { otId: 0xffffffff, language: 255 },
  ...[0, 0xffffffff, 0x3e000].map((pid) => ({ pid })), { friendship: 255 }, { metLevel: 127, otGender: 1 },
] as Partial<TestMon>[]).flatMap((fields) => [monferno(fields), starly(fields)]);
const CODES = [0x0000, 0x0121, 0x01de, 0x1234, 0xfffe];

/** `mon`'s plain record with its nickname filled with `code` and no 0xFFFF terminator. */
function unterminatedNickname(mon: TestMon, code: number): Uint8Array {
  const plain = decryptPk4(encodePk4(mon, true));
  for (let i = 0; i < 16; i++) viewOf(plain).setUint16(0x48 + i * 2, code, true);
  return plain;
}

/** Garbage written inside the general (`g`) or storage (`s`) block of partition 0, the CRCs recomputed after. */
const g = (file: Uint8Array) => blockOf(file, 0, 'general');
const s = (file: Uint8Array) => blockOf(file, 0, 'storage');
const GARBAGE: [string, (file: Uint8Array, rng: Rng) => void][] = [
  ['party count', (file, rng) => viewOf(g(file)).setUint32(PARTY_COUNT, rng.pick([0, 1, 2, 6, 7, 255, 0x80000000, 0xffffffff, rng.u32()]), true)],
  ['party records', (file, rng) => { viewOf(g(file)).setUint32(PARTY_COUNT, 1 + rng.int(6), true); g(file).set(rng.bytes(PARTY_RECORD * (1 + rng.int(6))), PARTY_START); }],
  ['one party record byte', (file, rng) => { g(file)[PARTY_START + rng.int(PARTY_RECORD * 2)] = rng.int(256); }],
  ['trainer info', (file, rng) => g(file).set(rng.bytes(0x1c), TRAINER_INFO)],
  ['trainer name, no terminator', (file, rng) => { for (let i = 0; i < 8; i++) viewOf(g(file)).setUint16(TRAINER_INFO + i * 2, rng.int(0x10000) & 0xfffe, true); }],
  ['badges', (file, rng) => { g(file)[0x82] = rng.int(256); }],
  ['trainer flags', (file, rng) => g(file).set(rng.bytes(928 / 8 + 2), TRAINER_FLAGS)],
  ['whole general block', (file, rng) => g(file).set(rng.bytes(GENERAL_SIZE - FOOTER_SIZE))],
  ['box records', (file, rng) => {
    const start = BOX_START + rng.int(540) * BOX_RECORD;
    s(file).set(rng.bytes(Math.min(BOX_RECORD * (1 + rng.int(30)), STORAGE_SIZE - FOOTER_SIZE - start)), start);
  }],
  ['one box record byte', (file, rng) => { s(file)[BOX_START + rng.int(BOX_RECORD)] = rng.int(256); }],
  ['whole storage block', (file, rng) => s(file).set(rng.bytes(STORAGE_SIZE - FOOTER_SIZE))],
  // Partition 0 copied into partition 1, then random link IDs and counters (outside the CRC) in every block.
  ['footers', (file, rng) => {
    file.copyWithin(PARTITION_SIZE, 0, PARTITION_SIZE);
    for (const block of BLOCKS.map(([p, kind]) => blockOf(file, p, kind))) {
      viewOf(block).setUint32(block.length - FOOTER_SIZE, rng.pick([0, 1, rng.u32()]), true);
      viewOf(block).setUint32(block.length - FOOTER_SIZE + 4, rng.pick([0, 1, 0xffffffff, rng.u32()]), true);
    }
  }],
];

const LENGTHS = [0, 1, 2, SAVE_SIZE - 1, SAVE_SIZE, SAVE_SIZE + 1, SAVE_SIZE * 2];
const CUTS = [0, 1, GENERAL_SIZE, PARTITION_SIZE, SAVE_SIZE - 1, SAVE_SIZE, SAVE_SIZE + 1, SAVE_SIZE + 16, VALID.length - 1];

/** Each suite: its case count, the least number of cases that must reach a box (the parser past the footers), and case `i`. */
const SUITES: [string, number, number, (rng: Rng, i: number) => [string, Uint8Array]][] = [
  ['random bytes at the save sizes and around them, with and without the DeSmuME cookie', 30, 0, (rng, i) => {
    if (i >= 27) {   // all 0x00, all 0xFF, 0xFF but the last byte
      const file = new Uint8Array(SAVE_SIZE).fill(i === 27 ? 0 : 0xff);
      if (i === 29) file[SAVE_SIZE - 1] = 0;
      return [`filled ${i}`, file];
    }
    if (i % 9 < 7) return [`random ${LENGTHS[i % 9]} bytes`, rng.bytes(LENGTHS[i % 9]!)];
    if (i % 9 === 8) return ['cookie only', COOKIE];
    const dsv = rng.bytes(SAVE_SIZE + 16);
    dsv.set(COOKIE, SAVE_SIZE);
    return ['random save + cookie', dsv];
  }],
  ['a valid save cut short or padded', 35, 0, (rng, i) => {
    if (i === 34) return ['padded after the cookie', Uint8Array.from([...VALID, ...new Uint8Array(1000)])];
    const length = i < CUTS.length ? CUTS[i]! : rng.int(VALID.length);
    return [`cut at ${length}`, VALID.slice(0, length)];
  }],
  ['a valid save with random bytes flipped (CRCs left as they are)', 40, 0, (rng, i) => {
    const file = valid();
    const flips = 1 + rng.int(i < 20 ? 3 : 200);
    for (let k = 0; k < flips; k++) {
      // Half the flips land in the footers, where they can break the size, magic, counter or link ID.
      const offset = rng.int(2) === 0 ? rng.int(SAVE_SIZE) : rng.pick([GENERAL_SIZE, GENERAL_SIZE + STORAGE_SIZE]) - 1 - rng.int(FOOTER_SIZE);
      file[offset] = file[offset]! ^ (1 + rng.int(255));
    }
    return [`${flips} flips`, file];
  }],
  ['garbage inside the general and storage blocks with the CRCs recomputed', 160, 101, (rng) => {
    const file = valid();
    const picked = [rng.pick(GARBAGE), ...(rng.int(3) === 0 ? [rng.pick(GARBAGE)] : [])];
    for (const [, write] of picked) write(file, rng);
    return [picked.map(([name]) => name).join(' + '), resealAll(file)];
  }],
  ['records of random decrypted bytes with a checksum that matches: every one a box', 120, 120, (rng, i) => {
    const plain = randomPlain(rng, i % 2 === 0);
    return rng.int(3) === 0
      ? [`${i} box record`, withRecord(sealPk4(plain).subarray(0, BOX_RECORD), 1 + rng.int(18), 1 + rng.int(30))]
      : [`${i} party record`, withRecord(sealPk4(plain), 1 + rng.int(6))];
  }],
  ['records with wild decrypted fields and a checksum that matches, in the party and in a box', (WILD.length + CODES.length) * 2, 201, (_rng, i) => {
    const inBox = i % 2 === 1;   // box 1 slot 2, else party slot 1
    if (i >= WILD.length * 2) {
      const code = CODES[(i - WILD.length * 2) >> 1]!;
      return [`nickname of 0x${code.toString(16)}, no terminator`, withRecord(sealPk4(unterminatedNickname(inBox ? starly() : monferno(), code)), 1, inBox ? 2 : undefined)];
    }
    const mon = WILD[i >> 1]!;
    const fields = JSON.stringify({ ...mon, nickname: undefined, ivs: undefined, evs: undefined, storedStats: undefined });
    return [`${inBox ? 'box' : 'party'} ${fields}`, withRecord(encodePk4(mon, !inBox), 1, inBox ? 2 : undefined)];
  }],
];

it('sealPk4 inverts decryptPk4, so crafted records carry a checksum that matches', () => {
  const record = encodePk4(monferno(), true);
  expect(sealPk4(decryptPk4(record))).toEqual(record);
});

it.each(SUITES.map(([name, count, minBoxes, make], k) => [name, count, minBoxes, make, k + 1] as const))(
  `save fuzz (seed 0x${SEED.toString(16)}): %s give a box or a SaveError`, (name, count, minBoxes, make, salt) => {
    const rng = rngOf(SEED ^ salt);
    const findings: string[] = [];
    let boxes = 0;
    for (let i = 0; i < count; i++) {
      const [label, file] = make(rng, i);
      const outcome = runCase(file);
      if (outcome === 'box') boxes++;
      else if (outcome !== 'save error') findings.push(`seed 0x${SEED.toString(16)} ${name} case ${i} (${label}): ${outcome}`);
    }
    expect(findings, findings.slice(0, 25).join('\n')).toEqual([]);
    expect(boxes).toBeGreaterThanOrEqual(minBoxes);
  },
);
