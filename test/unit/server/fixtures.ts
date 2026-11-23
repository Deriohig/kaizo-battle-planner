// Shared server fixtures: a small `LocalData` (two species, four moves, three trainers) and a save file encoder that
// also writes the trainer name and badges.

import type { LocalData } from '../../../src/data/load.js';
import type { DocMove } from '../../../src/docs/types.js';
import { buildNameIndex } from '../../../src/names/nameIndex.js';
import type { MoveRecord } from '../../../src/rom/types.js';
import { crc16Ccitt } from '../../../src/save/crc16.js';
import { buildSave, type BuildSaveOptions, GENERAL_SIZE, PARTITION_SIZE, type TestBoxMon, type TestMon } from '../../fixtures/buildSave.js';
import { docMon, docSpecies, docTrainer, loadedData, romSpecies, romTrainer, stats, trainerMon } from '../../fixtures/loadedData.js';

const BLAZE = 66;
const KEEN_EYE = 51;
const MEDIUM_SLOW = 3;

// Monferno and Starly, Scratch, Tackle, Growl (status) and Ember as the real ROM and docs have them.
const MONFERNO = romSpecies(391, { baseStats: stats(64, 78, 52, 78, 52, 81), types: [10, 1], genderRatio: 31, growthRate: MEDIUM_SLOW, abilities: [BLAZE, BLAZE] });
const STARLY = romSpecies(396, { baseStats: stats(40, 55, 30, 30, 30, 60), types: [0, 2], genderRatio: 127, growthRate: MEDIUM_SLOW, abilities: [KEEN_EYE, 0] });
const ROM_MOVES: MoveRecord[] = [
  { id: 10, effect: 0, category: 'physical', power: 40, type: 0, accuracy: 100, pp: 35, effectChance: 0, target: 0, priority: 0, flags: 115 },
  { id: 33, effect: 0, category: 'physical', power: 35, type: 0, accuracy: 100, pp: 35, effectChance: 0, target: 0, priority: 0, flags: 115 },
  { id: 45, effect: 18, category: 'status', power: 0, type: 0, accuracy: 100, pp: 40, effectChance: 0, target: 4, priority: 0, flags: 86 },
  { id: 52, effect: 4, category: 'special', power: 40, type: 10, accuracy: 100, pp: 25, effectChance: 10, target: 0, priority: 0, flags: 82 },
];
const DOC_MOVES: DocMove[] = [
  { id: 10, name: 'Scratch', effectText: 'None', category: 'physical', power: 40, type: 'Normal', accuracy: 100, pp: 35, effectChance: 0, targets: 'One opponent', priority: 0, contact: true },
  { id: 33, name: 'Tackle', effectText: 'None', category: 'physical', power: 35, type: 'Normal', accuracy: 100, pp: 35, effectChance: 0, targets: 'One opponent', priority: 0, contact: true },
  { id: 45, name: 'Growl', effectText: 'Lowers Atk (Status)', category: 'status', power: 0, type: 'Normal', accuracy: 100, pp: 40, effectChance: 0, targets: 'Both opponents', priority: 0, contact: false },
  { id: 52, name: 'Ember', effectText: 'Chance to Burn', category: 'special', power: 40, type: 'Fire', accuracy: 100, pp: 25, effectChance: 10, targets: 'One opponent', priority: 0, contact: false },
];

/** Gen 4's medium slow experience curve (growth rate 3); the other rates are n³ here. */
const mediumSlow = (n: number) => Math.max(0, Math.floor((6 * n ** 3) / 5) - 15 * n ** 2 + 100 * n - 140);
const GROWTH = Array.from({ length: 6 }, (_, rate) => Array.from({ length: 101 }, (_, n) => (rate === MEDIUM_SLOW ? mediumSlow(n) : n ** 3)));

/** The fixture trainers' IDs, in catalog order. */
export const TRISTAN_ID = 'roark-split/youngster-tristan/1';
export const TWINS_ID = 'roark-split/twins-ally-and-ann/1';
export const GARDENIA_ID = 'gardenia-split/leader-gardenia/1';

const DOC_TRAINERS = [
  docTrainer('Roark Split', 'Youngster Tristan', 0, [docMon('Starly', 5, { moves: ['Tackle', 'Growl'] }), docMon('Starly', 6, { nature: 'Adamant' })]),
  docTrainer('Roark Split', 'Twins Ally and Ann', 1, [docMon('Starly', 7), docMon('Monferno', 7, { moves: ['Tackle', 'Ember'] })], {
    location: 'Route 203', tags: { battle: 'double', starred: false, raw: ['DOUBLE'] },
  }),
  docTrainer('Gardenia Split', 'Leader Gardenia', 0, [docMon('Starly', 12), docMon('Monferno', 13, { moves: ['Tackle', 'Ember'] })], {
    location: 'Eterna Gym', field: { raw: 'PERMANENT RAIN', weather: 'rain' },
  }),
];
const ROM_TRAINERS = [
  romTrainer(1, [trainerMon(396, 5, { moves: [33, 45] }), trainerMon(396, 6)]),
  romTrainer(2, [trainerMon(396, 7), trainerMon(391, 7, { moves: [33, 52] })], { battleType: 2 }),
  romTrainer(3, [trainerMon(396, 12, { iv: 0 }), trainerMon(391, 13, { iv: 0, moves: [33, 52] })]),
  romTrainer(4, [trainerMon(396, 12), trainerMon(391, 13, { moves: [33, 52] })]),
];

/**
 * `LocalData` for the server tests, a fresh copy each call:
 * - Monferno 391 and Starly 396 on the medium slow curve; moves Scratch 10, Tackle 33, Growl 45 (status), Ember 52;
 * - `TRISTAN_ID` (ROM 1), a single: Starly Lv 5 (Tackle, Growl), then Starly Lv 6 whose docs nature (Adamant) disputes
 *   the ROM's (Hardy);
 * - `TWINS_ID` (ROM 2, Route 203), a double: Starly Lv 7 and Monferno Lv 7;
 * - `GARDENIA_ID` (Eterna Gym, "PERMANENT RAIN"), a single with two ROM copies: Starly Lv 12 and Monferno Lv 13. The
 *   catalog resolves ROM 4 (31 IVs) and keeps ROM 3 (0 IVs) as its one variant.
 */
export function serverData(): LocalData {
  const base = loadedData({
    species: structuredClone([MONFERNO, STARLY]),
    trainers: structuredClone(ROM_TRAINERS),
    docSpecies: [docSpecies(391, 'MONFERNO'), docSpecies(396, 'STARLY')],
    docTrainers: structuredClone(DOC_TRAINERS),
  });
  // loadedData has no moves or growth curves; add them, and rebuild the name index over the docs moves.
  const docs = { ...base.docs, moves: structuredClone(DOC_MOVES) };
  const moves: MoveRecord[] = [];
  for (const move of ROM_MOVES) moves[move.id] = { ...move };
  return { rom: { ...base.rom, moves, growth: structuredClone(GROWTH) }, names: buildNameIndex(docs), docs };
}

/**
 * Monferno "Mon" for a party slot: Lv 15 (exp 2449), Impish, Blaze, Quick Claw (217), Tackle (35/35 PP) and Ember (30/30,
 * 1 PP Up); IVs 0/26/12/10/7/24, EVs 4/252/1/2/3/250; stats 44/41/24/26/21/42, full HP, no status. `fields` replace any.
 */
export function monferno(fields: Partial<TestMon> = {}): TestMon {
  return {
    pid: 0x2939ae6a, species: 391, nickname: 'Mon', exp: 2449, level: 15, ability: BLAZE, item: 217, moves: [33, 52],
    pp: [35, 30], ppUps: [0, 1], ivs: { hp: 0, atk: 26, def: 12, spa: 10, spd: 7, spe: 24 }, evs: { hp: 4, atk: 252, def: 1, spa: 2, spd: 3, spe: 250 },
    currentHp: 44, storedStats: stats(44, 41, 24, 26, 21, 42), ...fields,
  };
}

/** Starly "Starly" for a party slot: Lv 14 (exp 1612), Quiet, Keen Eye, no item, Tackle, 0 IVs and EVs, stats 35/20/13/14/13/18. */
export function starly(fields: Partial<TestMon> = {}): TestMon {
  return {
    pid: 0x00017e4b, species: 396, nickname: 'Starly', exp: 1612, level: 14, ability: KEEN_EYE, moves: [33], pp: [35], ppUps: [0],
    currentHp: 35, storedStats: stats(35, 20, 13, 14, 13, 18), ...fields,
  };
}

/** `mon` in box `box` (1–18), slot `slot` (1–30). */
export function inBox(mon: TestMon, box: number, slot: number): TestBoxMon {
  return { ...mon, box, slot };
}

/** `buildSave`'s options plus the badge mask (general 0x82) and a trainer name of at most 7 letters, digits or spaces (0x68). */
export type SaveFileOptions = BuildSaveOptions & { badgeMask?: number; trainerName?: string };

/** Trainer "Lucas" with one badge (cap 28); party Mon and Starly; a Starly in box 1 slot 1 and a dead Starly "Ghost" in box 15. */
export const SERVER_SAVE: SaveFileOptions = {
  trainerName: 'Lucas',
  badgeMask: 0b1,
  party: [monferno(), starly()],
  boxes: [inBox(starly(), 1, 1), inBox(starly({ nickname: 'Ghost' }), 15, 1)],
};

const FOOTER_SIZE = 0x14;
const MAGIC = 0x20060623;
const TRAINER_NAME = 0x68;
const BADGES = 0x82;

/** `buildSave(opts)` whose general block, in each written partition, also carries the trainer name and badges, CRC recomputed. */
export function saveFile(opts: SaveFileOptions = SERVER_SAVE): Uint8Array {
  const { badgeMask, trainerName, ...save } = opts;
  const file = buildSave(save);
  for (const partition of [0, 1]) {
    const general = file.subarray(partition * PARTITION_SIZE, partition * PARTITION_SIZE + GENERAL_SIZE);
    const view = new DataView(general.buffer, general.byteOffset, general.byteLength);
    if (view.getUint32(GENERAL_SIZE - FOOTER_SIZE + 12, true) !== MAGIC) continue;   // never written: all 0xFF
    if (trainerName !== undefined) encodeTrainerName(trainerName).forEach((code, i) => view.setUint16(TRAINER_NAME + i * 2, code, true));
    if (badgeMask !== undefined) view.setUint8(BADGES, badgeMask);
    view.setUint16(GENERAL_SIZE - 2, crc16Ccitt(general.subarray(0, GENERAL_SIZE - FOOTER_SIZE)), true);
  }
  return file;
}

/** Gen 4 character codes for a name of letters, digits and spaces, then the 0xFFFF terminator. */
function encodeTrainerName(name: string): number[] {
  if (name.length > 7) throw new Error(`A trainer name holds at most 7 characters: ${name}`);
  return [...[...name].map((char) => {
    if (char >= '0' && char <= '9') return 0x0121 + char.charCodeAt(0) - 0x30;
    if (char >= 'A' && char <= 'Z') return 0x012b + char.charCodeAt(0) - 0x41;
    if (char >= 'a' && char <= 'z') return 0x0145 + char.charCodeAt(0) - 0x61;
    if (char === ' ') return 0x01de;
    throw new Error(`The test encoder cannot write ${JSON.stringify(char)}`);
  }), 0xffff];
}
