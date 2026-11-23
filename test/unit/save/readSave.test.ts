import { describe, expect, it } from 'vitest';
import { computeStats } from '../../../src/rom/stats.js';
import { crc16Ccitt } from '../../../src/save/crc16.js';
import { DEFAULT_GRAVEYARD_BOXES, ineligibleReasons, isEligible, readSave, SaveError, type SaveMon } from '../../../src/save/readSave.js';
import { decodeStatus } from '../../../src/save/status.js';
import { decodeText } from '../../../src/save/text.js';
import { readTrainerFlags } from '../../../src/save/trainerFlags.js';
import { buildSave, flipByte, GENERAL_SIZE, PARTITION_SIZE, SAVE_SIZE, STORAGE_OFFSET, type TestMon, type TestTrainer } from '../../fixtures/buildSave.js';
import { romSpecies } from '../../fixtures/loadedData.js';

// A mid-game Monferno: PID 0x2939ae6a gives nature 8 (Impish) and block order CADB; its stored stats are the Gen 4 formula's.
const MONFERNO: TestMon = {
  pid: 0x2939ae6a, species: 391, nickname: 'Mon', exp: 2449, level: 15, friendship: 143, ability: 66, item: 217, moves: [10, 52, 2, 290],
  pp: [35, 24, 25, 20], ppUps: [0, 1, 2, 3],
  ivs: { hp: 0, atk: 26, def: 12, spe: 24, spa: 10, spd: 7 }, evs: { hp: 4, atk: 252, def: 1, spe: 250, spa: 2, spd: 3 },
  currentHp: 30, storedStats: { hp: 44, atk: 41, def: 24, spe: 42, spa: 26, spd: 21 },
};
const CHINGLING: TestMon = { pid: 0x8f31c2d4, species: 433, nickname: 'Ching', exp: 100, level: 4, ability: 26, moves: [35, 45] };
const NO_STATS = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

// Growth rate 3 (medium slow) for Monferno, as in the ROM; every other species uses rate 0 (n³).
const mediumSlow = (n: number) => Math.max(0, Math.floor((6 * n ** 3) / 5) - 15 * n ** 2 + 100 * n - 140);
const rom = {
  growth: Array.from({ length: 8 }, (_, rate) => Array.from({ length: 101 }, (_, n) => (rate === 3 ? mediumSlow(n) : n ** 3))),
  species: Array.from({ length: 494 }, (_, id) => romSpecies(id, { growthRate: id === 391 ? 3 : 0 })),
};
const read = (opts: Parameters<typeof buildSave>[0]) => readSave(buildSave(opts), rom);
/** Partition, save counter, and the party's and boxes' species. */
const summary = (save: ReturnType<typeof readSave>) => [save.partition, save.saveCounter, save.party.map((m) => m.species), save.boxes.map((m) => m.species)];
/** Partition `newer` (counter 8) has Monferno in the party and Chingling in a box; the other (counter 7) the reverse. */
const twoSaves = (newer: 0 | 1) => buildSave({
  partition: newer, counter: 8, party: [MONFERNO], boxes: [{ ...CHINGLING, box: 1, slot: 1 }],
  other: { counter: 7, party: [CHINGLING], boxes: [{ ...MONFERNO, box: 2, slot: 2 }] },
});
const ALIVE = { graveyardBoxes: DEFAULT_GRAVEYARD_BOXES, levelCap: 100 };

describe('readSave', () => {
  it('round-trips a party mon', () => {
    const save = read({ party: [MONFERNO] });
    expect([save.party, save.boxes]).toEqual([[{
      location: { kind: 'party', slot: 1 }, pid: 0x2939ae6a, species: 391, form: 0, gender: 'M', nickname: 'Mon', level: 15, exp: 2449,
      nature: 8, friendship: 143, ability: 66, item: 217, moves: [10, 52, 2, 290], moveSlots: [10, 52, 2, 290], pp: [35, 24, 25, 20], ppUps: [0, 1, 2, 3],
      ivs: { hp: 0, atk: 26, def: 12, spa: 10, spd: 7, spe: 24 }, evs: { hp: 4, atk: 252, def: 1, spa: 2, spd: 3, spe: 250 },
      currentHp: 30, storedStats: { hp: 44, atk: 41, def: 24, spa: 26, spd: 21, spe: 42 },
      status: { kind: 'none' }, isEgg: false, badChecksum: false, otId: 0, otGender: 0, otName: Array(8).fill(0), language: 0,
    }], []]);
  });

  it('round-trips a box mon with a form and fewer than four moves, without HP or stored stats', () => {
    const burmy = { pid: 0x00017e4b, species: 412, form: 1, gender: 'F' as const, nickname: 'Burmy', exp: 125, friendship: 255, ability: 61, moves: [182], pp: [20], ppUps: [2], box: 2, slot: 5 };
    expect(read({ boxes: [burmy] }).boxes).toEqual([{
      location: { kind: 'box', box: 2, slot: 5 }, pid: 0x00017e4b, species: 412, form: 1, gender: 'F', nickname: 'Burmy', level: 5, exp: 125,
      nature: 0x00017e4b % 25, friendship: 255, ability: 61, item: 0, moves: [182], moveSlots: [182, 0, 0, 0], pp: [20], ppUps: [2],
      ivs: NO_STATS, evs: NO_STATS, status: { kind: 'none' }, isEgg: false, badChecksum: false, otId: 0, otGender: 0, otName: Array(8).fill(0), language: 0,
    }]);
  });

  it('reads gender from the gender bits, whatever the form and fateful-encounter bits hold', () => {
    const genders: [TestMon['gender'], number, boolean][] = [['M', 0, false], ['F', 0, false], [null, 0, false], ['M', 2, true], ['F', 2, true], [null, 1, true]];
    const boxes = genders.map(([gender, form, fatefulEncounter], i) => ({ pid: 0x00017e4b + i, species: 412, form, gender, fatefulEncounter, exp: 125, box: 1, slot: i + 1 }));
    const save = read({ party: [{ ...CHINGLING, gender: 'F' }], boxes });
    expect(save.party.map((m) => m.gender)).toEqual(['F']);
    expect(save.boxes.map((m) => [m.gender, m.form])).toEqual(genders.map(([gender, form]) => [gender, form]));
  });

  it('keeps PP and PP Ups aligned with the moves, and the empty move slots in moveSlots', () => {
    const gappy = { moves: [10, 0, 52], pp: [35, 0, 25], ppUps: [3, 0, 1] };
    const save = read({ party: [{ ...MONFERNO, ...gappy }], boxes: [{ ...CHINGLING, ...gappy, box: 1, slot: 1 }] });
    for (const m of [...save.party, ...save.boxes]) expect([m.moves, m.pp, m.ppUps, m.moveSlots]).toEqual([[10, 52], [35, 25], [3, 1], [10, 0, 52, 0]]);
  });

  it('reads party HP and stored stats, which match the stat formula; party levels from the extra data, box levels from experience', () => {
    const save = read({
      party: [MONFERNO, { ...CHINGLING, level: 20, currentHp: 0, storedStats: { hp: 17, atk: 9, def: 8, spe: 7, spa: 10, spd: 11 } }],
      boxes: [{ ...MONFERNO, box: 3, slot: 7 }, { ...CHINGLING, box: 18, slot: 30 }],
    });
    expect(save.party.map((m) => [m.level, m.currentHp, m.storedStats])).toEqual([[15, 30, MONFERNO.storedStats], [20, 0, { hp: 17, atk: 9, def: 8, spa: 10, spd: 11, spe: 7 }]]);
    const [monferno] = save.party;
    expect(monferno!.storedStats).toEqual(computeStats({ hp: 64, atk: 78, def: 52, spa: 78, spd: 52, spe: 81 }, monferno!.ivs, monferno!.evs, 15, monferno!.nature));
    expect(save.boxes.map((m) => [m.location, m.level])).toEqual([[{ kind: 'box', box: 3, slot: 7 }, 15], [{ kind: 'box', box: 18, slot: 30 }, 4]]);
  });

  it('uses partition 1 when partition 0 is blank', () => expect(summary(read({ party: [MONFERNO], partition: 1, counter: 3 }))).toEqual([1, 3, [391], []]));

  it.each([0, 1] as const)('uses the higher save counter when both are valid (newer in partition %i)', (newer) =>
    expect(summary(readSave(twoSaves(newer), rom))).toEqual([newer, 8, [391], [433]]));

  it.each([['general', 0x100], ['storage', STORAGE_OFFSET + 0x100]])('falls back when the newer partition has a bad CRC (%s block)', (_, offset) => {
    const file = twoSaves(1);
    flipByte(file, PARTITION_SIZE + offset);
    expect(summary(readSave(file, rom))).toEqual([0, 7, [433], [391]]);
  });

  it('reads a Node Buffer without changing it, and a raw .sav without the DeSmuME footer', () => {
    const file = Buffer.from(buildSave({ party: [MONFERNO], boxes: [{ ...CHINGLING, box: 1, slot: 1 }] }));
    const before = Buffer.from(file);
    expect(summary(readSave(file, rom)).slice(2)).toEqual([[391], [433]]);
    expect(file.equals(before)).toBe(true);
    expect(summary(readSave(file.subarray(0, SAVE_SIZE), rom)).slice(2)).toEqual([[391], [433]]);
  });

  const dsv = () => buildSave({ party: [MONFERNO] });
  it.each<[string, () => Uint8Array, string, RegExp?]>([
    ['NO_VALID_SAVE when neither partition is valid', () => { const f = dsv(); flipByte(f, 0x100); return f; }, 'NO_VALID_SAVE'],
    ['EMPTY_SAVE, saying to save in-game, for a wiped raw save (every byte 0xFF, as after a reset)', () => new Uint8Array(SAVE_SIZE).fill(0xff), 'EMPTY_SAVE', /empty.*save once in-game/i],
    ['EMPTY_SAVE for a wiped save that keeps its DeSmuME footer', () => dsv().fill(0xff, 0, SAVE_SIZE), 'EMPTY_SAVE', /empty.*save once in-game/i],
    ['BAD_SIZE for a raw save a byte short', () => dsv().subarray(0, SAVE_SIZE - 1), 'BAD_SIZE'],
    ['BAD_SIZE for a .dsv a byte short', () => dsv().subarray(0, dsv().length - 1), 'BAD_SIZE'],
    ['BAD_SIZE for a .dsv-sized file with no DeSmuME footer', () => new Uint8Array(dsv().length), 'BAD_SIZE'],
  ])('throws %s', (_, file, code, message = /./) => {
    expect(() => readSave(file(), rom)).toThrow(SaveError);
    expect(() => readSave(file(), rom)).toThrow(expect.objectContaining({ code, message: expect.stringMatching(message) }));
  });

  it('skips empty slots, flags eggs and bad checksums, and reads party status', () => {
    const egg = { pid: 0x5e9a0c11, species: 175, exp: 125, isEgg: true, box: 1, slot: 3 };
    const save = read({
      party: [{ ...MONFERNO, status: 0x10 }, { ...CHINGLING, status: 2, currentHp: 17 }, { ...MONFERNO, corrupt: true }],
      boxes: [{ ...CHINGLING, box: 1, slot: 1 }, egg, { ...CHINGLING, box: 1, slot: 4, corrupt: true }, { ...MONFERNO, status: 0x10, box: 1, slot: 5 }],
    });
    const slot = (m: SaveMon) => (m.location.kind === 'box' ? m.location.box * 100 : 0) + m.location.slot;
    expect(save.party.map((m) => [slot(m), m.badChecksum, isEligible(m, ALIVE)])).toEqual([[1, false, true], [2, false, true], [3, true, false]]);
    expect(save.boxes.map((m) => [slot(m), m.isEgg, m.badChecksum, isEligible(m, ALIVE)])).toEqual([
      [101, false, false, true], [103, true, false, false], [104, false, true, false], [105, false, false, true]]);
    expect([...save.party.slice(0, 2), save.boxes[3]!].map((m) => m.status)).toEqual([{ kind: 'burn' }, { kind: 'sleep', turns: 2 }, { kind: 'none' }]);
  });
});

// Codes of "DERI" and "Hilary" in the game's text table (the one `decodeText` reads), padded with 0xFFFF.
const DERI = [0x12e, 0x12f, 0x13c, 0x133, 0xffff, 0xffff, 0xffff, 0xffff];
const HILARY = [0x12b + 7, 0x145 + 8, 0x145 + 11, 0x145, 0x145 + 17, 0x145 + 24, 0xffff, 0xffff];

describe("readSave: the original trainer and the save's trainer", () => {
  it("reads each Pokémon's OT ID (unsigned 32-bit), gender, name codes (all 8, raw) and language, for party and box Pokémon", () => {
    const own = { ...CHINGLING, otId: 180441969, otName: 'DERI', otGender: 0 as const, language: 2 };
    const codes = [0x12e, 0xffff, 0x12f, 1, 2, 3, 4, 0x1de]; // whatever follows the terminator
    const traded = { pid: 0x00017e4b, species: 412, exp: 125, otId: 25643, otName: 'Hilary', otGender: 1 as const, language: 5, box: 3, slot: 7 };
    const save = read({ party: [own, { ...CHINGLING, pid: 1, otId: 0xfffffffe, otName: codes }], boxes: [traded] });
    expect(save.party).toMatchObject([{ otId: 180441969, otGender: 0, otName: DERI, language: 2 }, { otId: 0xfffffffe, otName: codes }]);
    expect(save.boxes[0]).toMatchObject({ otId: 25643, otGender: 1, otName: HILARY, language: 5 });
  });

  it('reads otGender from bit 7 alone: the met level in bits 0-6 beside it never makes a male OT female', () => {
    const mons = [[0, 0x25], [1, 0x25], [0, 0x7f], [1, 0x7f], [0, 0], [1, 0]] as const;
    const save = read({ party: mons.map(([otGender, metLevel], i) => ({ ...CHINGLING, pid: CHINGLING.pid + i, otGender, metLevel })) });
    expect(save.party.map((m) => m.otGender)).toEqual(mons.map(([otGender]) => otGender));
  });

  const trainer: TestTrainer = { name: 'DERI', id: 180441969, gender: 0, badgeMask: 0b00000001 };
  it.each<[TestTrainer, object]>([
    [trainer, { id: 180441969, gender: 0, name: 'DERI', nameCodes: DERI, badges: 1 }],
    [{ ...trainer, name: 'Hilary ', gender: 1, badgeMask: 0 }, { gender: 1, name: 'Hilary ', badges: 0 }],
    [{ ...trainer, badgeMask: 0b10110101 }, { badges: 5 }],
    [{ ...trainer, badgeMask: 0xff }, { badges: 8 }],
    [{ ...trainer, badgeMask: 0b01000000 }, { badges: 1 }],
  ])("reads the save's trainer %j: ID, gender, name codes and name, and the set bits of the badge byte", (input, expected) =>
    expect(read({ party: [CHINGLING], trainer: input }).trainer).toMatchObject(expected));

  it("reads the newest valid general block's trainer, as it does the party", () => {
    const older: TestTrainer = { name: 'OLD', id: 1, gender: 1, badgeMask: 0xff };
    expect(read({ partition: 1, party: [CHINGLING], trainer, counter: 5, other: { party: [], trainer: older, counter: 2 } }).trainer)
      .toMatchObject({ id: 180441969, badges: 1 });
  });
});

describe('ineligibleReasons and isEligible', () => {
  const mon = (location: SaveMon['location'], level: number, extra: Partial<SaveMon> = {}): SaveMon => ({
    location, pid: 1, species: 391, form: 0, gender: 'M', nickname: 'Mon', level, exp: 0, nature: 1, friendship: 70, ability: 66, item: 0,
    moves: [10], moveSlots: [10, 0, 0, 0], pp: [35], ppUps: [0], ivs: NO_STATS, evs: NO_STATS,
    status: { kind: 'none' }, isEgg: false, badChecksum: false, otId: 0, otGender: 0, otName: Array(8).fill(0xffff), language: 2, ...extra,
  });
  const party = { kind: 'party', slot: 1 } as const;
  const box = (n: number, slot = 1) => ({ kind: 'box', box: n, slot }) as const;
  const cap16 = { graveyardBoxes: DEFAULT_GRAVEYARD_BOXES, levelCap: 16 };
  const noCap = { graveyardBoxes: DEFAULT_GRAVEYARD_BOXES };

  // A fainted party Pokémon is dead in a nuzlocke; box Pokémon have no stored HP (the PC heals them), so 0 never counts.
  it.each<[string, SaveMon, { graveyardBoxes: number[]; levelCap?: number }, string[]]>([
    ['in the first graveyard box', mon(box(15), 10), cap16, ['dead']],
    ['in a graveyard box the options give', mon(box(1), 10), { graveyardBoxes: [1], levelCap: 100 }, ['dead']],
    ['in the party at exactly 0 HP', mon(party, 10, { currentHp: 0 }), cap16, ['fainted']],
    ['an egg', mon(party, 10, { isEgg: true }), cap16, ['egg']],
    ['over the cap', mon(party, 17), cap16, ['over cap']],
    ['with a bad checksum', mon(party, 10, { badChecksum: true }), cap16, ['bad checksum']],
    ['at the cap', mon(party, 16), cap16, []],
    ['in the party at 1 HP', mon(party, 10, { currentHp: 1 }), cap16, []],
    ['in a box outside the graveyard', mon(box(14, 30), 16), cap16, []],
    ['in a box at a made-up 0 HP', mon(box(1), 10, { currentHp: 0 }), cap16, []],
    ['dead, an egg, over the cap and corrupt, in the order the box prints them', mon(box(18, 30), 17, { isEgg: true, badChecksum: true }), cap16, ['dead', 'egg', 'over cap', 'bad checksum']],
    ['fainted, an egg, over the cap and corrupt', mon(party, 17, { currentHp: 0, isEgg: true, badChecksum: true }), cap16, ['fainted', 'egg', 'over cap', 'bad checksum']],
    ['dead and over the cap', mon(box(16, 2), 50), cap16, ['dead', 'over cap']],
    ['dead and an egg, never over a cap it lacks', mon(box(17), 100, { isEgg: true }), noCap, ['dead', 'egg']],
  ])('gives a Pokémon %s the reasons %j', (_, m, opts, reasons) => {
    expect(ineligibleReasons(m, opts)).toEqual(reasons);
    expect(isEligible(m, { levelCap: 100, ...opts })).toBe(reasons.length === 0);
  });
});

// The save's small decoders: the CRC, the status word, text codes and the trainer-defeated flags.

it('crc16Ccitt gives the CRC-16-CCITT (initial value 0xFFFF) check value, and the initial value for no bytes', () => {
  expect(crc16Ccitt(new TextEncoder().encode('123456789'))).toBe(0x29b1);
  expect(crc16Ccitt(new Uint8Array(0))).toBe(0xffff);
});

it.each([
  [0, { kind: 'none' }], [2, { kind: 'sleep', turns: 2 }], [7, { kind: 'sleep', turns: 7 }], [0x08, { kind: 'poison' }],
  [0x10, { kind: 'burn' }], [0x20, { kind: 'freeze' }], [0x40, { kind: 'paralysis' }], [0x80, { kind: 'toxic' }], [0x88, { kind: 'toxic' }],
])('decodeStatus decodes status word %i', (word, status) => expect(decodeStatus(word)).toEqual(status));

it.each([
  ['a nickname', [0x0137, 0x0153, 0x0152, 0xffff], 'Mon'],
  ['digits, letters, punctuation, gender signs and space', [0x0121, 0x012a, 0x012b, 0x0144, 0x0145, 0x015e, 0x01ab, 0x01ac, 0x01ad,
    0x01ae, 0x01b1, 0x01b3, 0x01b9, 0x01ba, 0x01bb, 0x01bc, 0x01bd, 0x01be, 0x01de, 0xffff], "09AZaz!?,./'()♂♀+- "],
  ['any other code as ?', [0x0000, 0x0120, 0x015f, 0x01df, 0xffff], '????'],
  ['up to the terminator', [0x0137, 0xffff, 0x0153], 'M'],
  ['to the end with no terminator', [0x0137, 0x0153], 'Mo'],
])('decodeText decodes %s', (_, codes, text) => expect(decodeText(codes)).toBe(text));

describe('readTrainerFlags', () => {
  // Trainer t's flag is 0x550 + t, in byte 0xFEC + flag / 8, bit flag % 8: trainer 0 is byte 0x1096 bit 0, trainer 246
  // (Leader Roark in vanilla) byte 0x10B4 bit 6, and trainer 927, the last, byte 0x1109 bit 7.
  const block = (bits: [byte: number, bit: number][]) => {
    const general = new Uint8Array(GENERAL_SIZE);
    for (const [byte, bit] of bits) general[byte]! |= 1 << bit;
    return general;
  };
  /** Every byte `outside`, and the trainer flags' bytes the inverse. */
  const trainerBytes = (outside: number) => new Uint8Array(GENERAL_SIZE).fill(outside).fill(outside ^ 0xff, 0x1096, 0x110a);

  it.each<[string, Uint8Array, number[]]>([
    ['no flags set', block([]), []],
    ['trainer 0', block([[0x1096, 0]]), [0]],
    ['each trainer from its own byte and bit', block([[0x1096, 1], [0x10b4, 6], [0x1109, 7]]), [1, 246, 927]],
    ['nothing from the flags either side, 0x54F (byte 0x1095 bit 7) and 0x8F0 (byte 0x110A bit 0)', block([[0x1095, 7], [0x110a, 0]]), []],
    ['nothing from every other event flag and var set', trainerBytes(0xff), []],
    ['every trainer, 0 to 927, when all their flags are set', trainerBytes(0), Array.from({ length: 928 }, (_, t) => t)],
  ])('reads %s', (_, general, trainers) => expect(readTrainerFlags(general)).toEqual(new Set(trainers)));

  it('is read by readSave from the general block it picks, the newer one', () => {
    expect(read({ defeatedTrainers: [1, 246, 927] }).defeatedTrainers).toEqual(new Set([1, 246, 927]));
    expect(read({}).defeatedTrainers).toEqual(new Set());
    expect(read({ partition: 1, counter: 5, defeatedTrainers: [12], other: { counter: 4, defeatedTrainers: [1, 2] } }).defeatedTrainers).toEqual(new Set([12]));
  });
});
