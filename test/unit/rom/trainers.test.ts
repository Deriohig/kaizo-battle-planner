import { describe, expect, it } from 'vitest';
import { RomError } from '../../../src/errors.js';
import { lcrngNext } from '../../../src/rom/lcrng.js';
import { FEMALE_TRAINER_CLASSES } from '../../../src/rom/trainerClassGender.js';
import { AI_FLAG_NAMES, decodeTrainer, trainerPid } from '../../../src/rom/trainers.js';
import { hex } from '../../fixtures/romRecords.js';

// Trainers 1 (Youngster Tristan, class 2) and 3 (Lass Natalie, class 3), read from the real ROM.
const tristanHeader = hex('03 02 00 03 00 00 00 00 00 00 00 00 07 00 00 00 00 00 00 00');
const tristanParty = hex(`
  ff 00 05 00 07 01 fb 00 62 00 1c 00 00 00 00 00 00 00
  ff 00 05 00 a1 00 fb 00 62 00 1c 00 00 00 00 00 00 00
  ff 00 05 00 10 00 f4 00 bd 00 10 00 62 00 1c 00 00 00`);
const natalieHeader = hex('03 03 00 03 00 00 00 00 00 00 00 00 05 00 00 00 00 00 00 00');
const natalieParty = hex(`
  ff 00 06 00 bf 00 9b 00 5c 00 49 00 b6 00 48 00 00 00
  ff 00 06 00 8c 01 9b 00 62 00 40 00 63 01 d6 00 00 00
  ff 00 06 00 05 01 9b 00 bd 00 62 00 d6 00 2c 00 00 00`);

// Trainers whose party byte 1 sets gender/ability overrides. Leader Maylene (317, class 76): only Lucario (last) has
// byte 1 = 0x20; the docs give it Adaptability, its second ability.
const maylene = {
  header: hex('03 4c 00 06 00 00 00 00 00 00 00 00 07 00 00 00 00 00 00 00'),
  party: hex(`
    fd 00 2c 00 73 00 9d 00 fc 00 19 00 72 01 be 01 00 00
    ff 00 2d 00 88 01 9d 00 2b 01 08 00 09 00 b7 00 10 00
    ff 00 2c 00 55 00 10 01 b6 00 9d 01 e4 00 88 00 00 00
    ff 00 2d 00 6a 00 10 01 fc 00 88 00 bc 01 e4 00 00 00
    ff 00 2c 00 34 01 c0 00 60 00 88 00 ab 01 08 00 00 00
    ff 20 2f 00 c0 01 13 01 0e 00 72 01 a2 01 b7 00 0e 00`),
};
// Idol Skylar (338, class 85): byte 1 is 0x12, 0x02, 0x02, 0x00, 0x02, 0x02. Docs: Flygon has Sand Stream (its first ability).
const skylar = {
  header: hex('03 55 00 06 00 00 00 00 00 00 00 00 0f 00 00 00 00 00 00 00'),
  party: hex(`
    ff 12 3b 00 4a 01 bc 00 b2 01 be 01 59 00 35 00 00 00
    fc 02 3d 00 32 01 ea 00 c9 01 a0 01 14 01 a3 01 00 00
    fc 02 3a 00 e3 00 f4 00 8f 00 94 01 90 01 9d 00 00 00
    ff 00 3e 00 0c 00 f4 00 6e 01 8c 00 71 01 4f 00 00 00
    ff 02 37 00 d8 01 d5 00 0e 00 59 00 4c 01 90 01 00 00
    ff 02 3c 00 cd 00 d2 00 68 01 99 00 59 00 9d 00 00 00`),
};

/** A 20-byte header with format, class and party size set and everything else 0. */
const header = (format: number, trainerClass: number, partySize: number) =>
  hex(`0${format} ${trainerClass.toString(16).padStart(2, '0')} 00 0${partySize} 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00`);

it('lcrngNext matches a BigInt reference: from 0, from 0xffffffff at full precision, and over 1000 steps', () => {
  expect([lcrngNext(0), lcrngNext(0xffffffff)]).toEqual([{ seed: 0x6073, rand: 0 }, { seed: 0xbe3a1206, rand: 0xbe3a }]);
  let [seed, big] = [0x12345678, 0x12345678n];
  for (let i = 0; i < 1000; i++) {
    big = (big * 0x41c64e6dn + 0x6073n) & 0xffffffffn;
    const step = lcrngNext(seed);
    expect(step).toEqual({ seed: Number(big), rand: Number(big >> 16n) });
    seed = step.seed;
  }
});

it('trainerPid gives the docs natures, adds 136 for a male class and 120 for a female one, and takes no LCRNG steps for class 0', () => {
  expect([263, 161, 16].map((species) => trainerPid(255, 5, species, 1, 2, false) % 25)).toEqual([11, 6, 18]); // Tristan
  expect([191, 396, 261].map((species) => trainerPid(255, 6, species, 3, 3, true) % 25)).toEqual([2, 0, 14]); // Natalie: Brave, Hardy, Naive
  expect(trainerPid(255, 5, 263, 1, 2, false) - trainerPid(255, 5, 263, 1, 2, true)).toBe(16);
  expect(trainerPid(10, 20, 30, 40, 0, false)).toBe((100 << 8) + 136);
});

it('FEMALE_TRAINER_CLASSES holds Lass (3) and Champion Cynthia (69), not Youngster (2) or Rival (63)', () =>
  expect([3, 69, 2, 63].map((c) => FEMALE_TRAINER_CLASSES.has(c))).toEqual([true, true, false, false]));

describe('decodeTrainer', () => {
  it.each([
    ['Tristan', 1, tristanHeader, tristanParty, { trainerClass: 2, battleType: 0, aiMask: 7, aiFlags: ['Basic', 'EvalAttack', 'Expert'] },
      [[263, 5, 11, 251, [98, 28]], [161, 5, 6, 251, [98, 28]], [16, 5, 18, 244, [189, 16, 98, 28]]]],
    ['Natalie, by the female PID rule', 3, natalieHeader, natalieParty, { trainerClass: 3, aiMask: 5, aiFlags: ['Basic', 'Expert'] },
      [[191, 6, 2, 155, [92, 73, 182, 72]], [396, 6, 0, 155, [98, 64, 355, 214]], [261, 6, 14, 155, [189, 98, 214, 44]]]],
  ])('decodes %s, each Pokémon with its PID, nature and ability slot', (_, index, head, party, fields, mons) => {
    const t = decodeTrainer(index, head, party);
    expect(t).toMatchObject({ index, items: [], ...fields });
    expect(t.party.map((m) => [m.species, m.level, m.nature, m.item, m.moves])).toEqual(mons);
    for (const m of t.party) {
      expect(m).toMatchObject({ iv: 31, form: 0, genderOverride: 0, abilityOverride: 0, natureKnown: true, nature: m.pid % 25, abilitySlot: m.pid & 1,
        pid: trainerPid(255, m.level, m.species, index, t.trainerClass, FEMALE_TRAINER_CLASSES.has(t.trainerClass)) });
    }
  });

  it('reads the gender and ability overrides from byte 1, and stops trusting natures from the first override on (Idol Skylar)', () => {
    const t = decodeTrainer(338, skylar.header, skylar.party);
    expect(t.party.map((m) => [m.species, m.genderOverride, m.abilityOverride, m.natureKnown])).toEqual([
      [330, 2, 1, false], [306, 2, 0, false], [227, 2, 0, false], [12, 0, 0, false], [472, 2, 0, false], [205, 2, 0, false]]);
    expect(t.party[0]!.abilitySlot).toBe(0);
  });

  it('takes the ability slot from the override, trusting natures only before it (Leader Maylene)', () => {
    const t = decodeTrainer(317, maylene.header, maylene.party);
    expect(t.party.map((m) => [m.species, m.abilityOverride, m.abilitySlot, m.natureKnown])).toEqual([
      [115, 0, 0, true], [392, 0, 0, true], [85, 0, 0, true], [106, 0, 0, true], [308, 0, 0, true], [448, 2, 1, false]]);
    // Lax, Bashful, Naive, Modest, Naive: the docs natures for the entries before the override.
    expect(t.party.slice(0, 5).map((m) => m.nature)).toEqual([9, 18, 14, 15, 14]);
  });

  it('reads the bag items, every AI flag and the battle type', () =>
    expect(decodeTrainer(5, hex('03 05 00 00 11 00 00 00 1a 00 00 00 ff 07 00 00 02 00 00 00'), new Uint8Array(0)))
      .toEqual({ index: 5, trainerClass: 5, battleType: 2, aiMask: 0x7ff, aiFlags: [...AI_FLAG_NAMES], items: [17, 26], party: [] }));

  it('ignores the alignment padding after the last entry', () => {
    const padded = new Uint8Array(tristanParty.length + 2);
    padded.set(tristanParty);
    expect(decodeTrainer(1, tristanHeader, padded).party).toEqual(decodeTrainer(1, tristanHeader, tristanParty).party);
  });

  it.each([
    ['moves without an item (format 1)', header(1, 2, 1), 'ff 00 05 00 10 00 bd 00 10 00 62 00 1c 00 00 00', [{ species: 16, item: 0, moves: [189, 16, 98, 28] }]],
    ['an item without moves (format 2)', header(2, 2, 1), 'ff 00 05 00 10 00 f4 00 00 00', [{ species: 16, item: 244, moves: [] }]],
    ['the form, level and IVs of a plain entry (format 0)', header(0, 2, 2), '32 00 0a 00 10 04 00 00 00 00 07 00 a1 00 00 00',
      [{ species: 16, form: 1, level: 10, iv: 6, item: 0, moves: [] }, { species: 161, form: 0, level: 7, iv: 0 }]],
  ])('reads %s', (_, head, party, mons) => expect(decodeTrainer(1, head, hex(party)).party).toMatchObject(mons));

  it.each([
    ['an override nibble above 2', header(2, 2, 1), hex('ff 30 05 00 10 00 f4 00 00 00')],
    ['a party shorter than the header says', tristanHeader, tristanParty.subarray(0, 36)],
    ['entries bigger than the format allows', tristanHeader, new Uint8Array(3 * 20)],
  ])('throws RomError BAD_FORMAT on %s', (_, head, party) => {
    expect(() => decodeTrainer(1, head, party)).toThrow(RomError);
    expect(() => decodeTrainer(1, head, party)).toThrow(expect.objectContaining({ code: 'BAD_FORMAT' }));
  });
});
