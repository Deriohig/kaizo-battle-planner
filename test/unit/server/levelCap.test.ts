import { expect, it } from 'vitest';
import { SaveError } from '../../../src/save/readSave.js';
import { LEVEL_CAPS_BY_BADGES, levelCapFor } from '../../../src/server/levelCap.js';
import { readTrainerInfo } from '../../../src/server/saveInfo.js';
import { type SaveFileOptions, saveFile } from './fixtures.js';

it('levelCapFor gives the cap for the badge count, unless an override wins', () => {
  expect(LEVEL_CAPS_BY_BADGES).toEqual([16, 28, 38, 42, 54, 63, 74, 84, 100]);
  expect([0, 3, 5, 8].map((badges) => levelCapFor(badges, null))).toEqual([16, 42, 63, 100]);
  expect([levelCapFor(3, 47), levelCapFor(8, 47)]).toEqual([47, 47]);
});

it.each<[SaveFileOptions, object]>([
  [{ badgeMask: 0b111 }, { badgeMask: 0b111, badges: 3 }],
  [{ badgeMask: 0b10000001 }, { badges: 2 }],   // the bits set, whichever they are
  [{ badgeMask: 0xff }, { badges: 8 }],
  [{}, { badges: 0 }],
  [{ trainerName: 'Lucas', badgeMask: 0b11 }, { name: 'Lucas', badgeMask: 0b11, badges: 2 }],   // name at general 0x68, mask at 0x82
  [{ trainerName: 'Dawn', partition: 1, counter: 9, other: { counter: 8 } }, { name: 'Dawn' }],   // in either partition
])('readTrainerInfo reads %j', (save, info) => {
  expect(readTrainerInfo(saveFile(save))).toMatchObject(info);
});

it('readTrainerInfo throws SaveError for a file that is not a save', () => {
  expect(() => readTrainerInfo(new Uint8Array(10))).toThrow(SaveError);
});
