import { expect, it } from 'vitest';
import { RomError } from '../../../src/errors.js';
import { decodeGrowth, levelFromExp } from '../../../src/rom/growth.js';
import { decodeLearnset } from '../../../src/rom/learnsets.js';
import { decodeMove } from '../../../src/rom/moves.js';
import { decodePersonal } from '../../../src/rom/personal.js';
import { hex, type MoveFields, moveBytes, type PersonalFields, personalBytes } from '../../fixtures/romRecords.js';

it.each<[string, number, PersonalFields, object]>([
  ['Monferno', 391, { stats: [64, 78, 52, 81, 78, 52], types: [10, 1], growth: 3, abilities: [66, 66], genderRatio: 31 },
    { baseStats: { hp: 64, atk: 78, def: 52, spa: 78, spd: 52, spe: 81 }, types: [10, 1], growthRate: 3, abilities: [66, 66], genderRatio: 31 }],
  ['the base EXP yield (byte 0x09) and the EV yield (u16 at 0x0A)', 1, { baseExp: 64, evYield: 0x0401 }, { baseExp: 64, evYield: 0x0401 }],
  ['a base EXP of 255, and an EV yield of 0 when none is set', 150, { baseExp: 255 }, { baseExp: 255, evYield: 0 }],
  ['the base friendship (byte 0x12), gender ratio and growth rate', 35, { genderRatio: 191, friendship: 140, growth: 4 }, { baseFriendship: 140, genderRatio: 191, growthRate: 4 }],
])('decodePersonal reads %s', (_, id, fields, expected) => expect(decodePersonal(id, personalBytes(fields))).toMatchObject({ id, ...expected }));

it.each([
  ['a packed learnset', 'a5 03 53 02 02 02 42 0e 34 12 ff ff', [[421, 1], [83, 1], [2, 1], [66, 7], [52, 9]]],
  ['up to the terminator, ignoring padding', '42 0e ff ff 00 00', [[66, 7]]],
  ['to the end of a record with no terminator', '42 0e 34 12', [[66, 7], [52, 9]]],
])('decodeLearnset reads %s', (_, bytes, moves) => expect(decodeLearnset(hex(bytes))).toEqual(moves.map(([move, level]) => ({ move, level }))));

it.each<[string, number, MoveFields, object]>([
  ['Water Ball', 4, { effect: 0, cat: 1, power: 100, type: 11, acc: 100, pp: 15, chance: 0, target: 0, prio: 0, flags: 0x72 },
    { effect: 0, category: 'special', power: 100, type: 11, accuracy: 100, pp: 15, effectChance: 0, target: 0, priority: 0, flags: 0x72 }],
  ['Pound', 1, { cat: 0, power: 40, type: 0, acc: 100, pp: 35, flags: 0x73 }, { category: 'physical', power: 40, type: 0, accuracy: 100, pp: 35, flags: 0x73 }],
  ['the u16 fields and a status category', 9, { effect: 0x0123, cat: 2, chance: 30, target: 0x0200 }, { effect: 0x0123, category: 'status', effectChance: 30, target: 0x0200 }],
  ['negative priority', 1, { prio: -6 }, { priority: -6 }],
])('decodeMove reads %s', (_, id, fields, expected) => expect(decodeMove(id, moveBytes(fields))).toMatchObject({ id, ...expected }));

it('decodeGrowth reads 101 little-endian u32 values, and levelFromExp the level an experience total reaches', () => {
  const rec = new Uint8Array(101 * 4);
  for (let level = 0; level <= 100; level++) new DataView(rec.buffer).setUint32(level * 4, level ** 3, true);
  const growth = decodeGrowth(rec);
  expect([growth.length, growth[15], growth[16], growth[100]]).toEqual([101, 3375, 4096, 1000000]);
  expect([3374, 3375, 4095, 1000000].map((exp) => levelFromExp([growth], 0, exp))).toEqual([14, 15, 15, 100]);
});

it.each([
  ['decodeMove on an unknown category', () => decodeMove(7, moveBytes({ cat: 3 }))],
  ['levelFromExp on an unknown growth rate', () => levelFromExp([[0, 0]], 5, 100)],
])('%s throws RomError BAD_FORMAT', (_, decode) => {
  expect(decode).toThrow(RomError);
  expect(decode).toThrow(expect.objectContaining({ code: 'BAD_FORMAT' }));
});
