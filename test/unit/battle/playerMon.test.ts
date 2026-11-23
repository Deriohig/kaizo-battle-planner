import { describe, expect, it } from 'vitest';
import { atLevel, eligibleTeam, toPlayerMon } from '../../../src/battle/playerMon.js';
import { computeStats } from '../../../src/rom/stats.js';
import { DEFAULT_GRAVEYARD_BOXES, GAME_LANGUAGE, type SaveMon } from '../../../src/save/readSave.js';
import { docSpecies, loadedData, romSpecies, stats } from '../../fixtures/loadedData.js';

// Monferno as the real ROM has it: base stats 64/78/52/78/52/81, Fire (10) / Fighting (1), Blaze. Wormadam's Sandy form
// has a Personal row of its own, 499; Burmy's forms share row 412; Mothim keeps its Burmy cloak in the form byte.
const BLAZE = 66;
const MONFERNO = romSpecies(391, { baseStats: stats(64, 78, 52, 78, 52, 81), types: [10, 1], genderRatio: 31, growthRate: 3, abilities: [BLAZE, BLAZE] });
const data = loadedData({
  species: [MONFERNO, romSpecies(413, { baseStats: stats(60, 59, 85, 79, 105, 36), types: [6, 12] }), romSpecies(499, { baseStats: stats(60, 79, 105, 59, 85, 36), types: [6, 4] }),
    romSpecies(412, { baseStats: stats(40, 29, 45, 29, 45, 36), types: [6, 6] }), romSpecies(414, { baseStats: stats(70, 94, 50, 94, 50, 66), types: [6, 2] })],
  trainers: [],
  docSpecies: [docSpecies(391, 'MONFERNO'), docSpecies(412, 'BURMY'), docSpecies(413, 'WORMADAM'), docSpecies(414, 'MOTHIM')],
  docTrainers: [],
});

/** The save's trainer (ID 180441969, gender 0, "DERI" as name codes), so `monferno()` reads as "own". */
const OWN_TRAINER = { id: 180441969, gender: 0, name: 'DERI', nameCodes: [0x12e, 0x12f, 0x13c, 0x133, 0xffff, 0xffff, 0xffff, 0xffff], badges: 1 };
const party = (slot: number) => ({ kind: 'party', slot }) as const;
const box = (boxNumber: number, slot: number) => ({ kind: 'box', box: boxNumber, slot }) as const;
const OPTS = { graveyardBoxes: DEFAULT_GRAVEYARD_BOXES, levelCap: 16 };

/**
 * Monferno in party slot 1: level 15, Impish (8), burned, 30 HP left. Its stored stats are the Gen 4 formula's: HP
 * floor(129 × 15 / 100) + 25 = 44; Atk floor(245 × 0.15) + 5 = 41; Def 22 × 1.1 → 24; SpA 29 × 0.9 → 26; SpD 21; Spe 42.
 */
const monferno = (fields: Partial<SaveMon> = {}): SaveMon => ({
  location: party(1), pid: 0x2939ae6a, species: 391, form: 0, gender: 'M', nickname: 'Fernando', level: 15, exp: 2449,
  nature: 8, friendship: 143, ability: BLAZE, item: 217, moves: [10, 52, 2, 290], moveSlots: [10, 52, 2, 290], pp: [35, 24, 25, 20], ppUps: [0, 1, 2, 3],
  ivs: stats(0, 26, 12, 10, 7, 24), evs: stats(4, 252, 1, 2, 3, 250), status: { kind: 'burn' }, currentHp: 30,
  storedStats: stats(44, 41, 24, 26, 21, 42), isEgg: false, badChecksum: false, otId: OWN_TRAINER.id, otGender: 0, otName: [...OWN_TRAINER.nameCodes], language: 2, ...fields,
});
/** A box Pokémon: no stored stats or current HP, as `readSave` gives them. */
const boxMon = (location: SaveMon['location'], fields: Partial<SaveMon> = {}): SaveMon => {
  const { currentHp: _hp, storedStats: _stats, ...rest } = monferno({ location, status: { kind: 'none' }, ...fields });
  return rest;
};
const player = (save: SaveMon) => toPlayerMon(save, data, OWN_TRAINER);
const NOTED = stats(44, 40, 24, 26, 21, 43); // stored Atk and Spe that differ from the formula's

describe('toPlayerMon', () => {
  it('builds a Monferno from the save, with base stats and types from the ROM, copying what a later step may change', () => {
    const save = monferno();
    const mon = player(save);
    expect(mon).toEqual({
      species: 391, form: 0, name: 'Monferno', nickname: 'Fernando', level: 15, gender: 'M', ivs: stats(0, 26, 12, 10, 7, 24), evs: stats(4, 252, 1, 2, 3, 250),
      nature: { value: 8, source: 'rom', disputed: false, alternatives: [] }, ability: { value: BLAZE, source: 'rom', disputed: false, alternatives: [] },
      item: 217, moves: [10, 52, 2, 290], pp: [35, 24, 25, 20], ppUps: [0, 1, 2, 3], baseStats: stats(64, 78, 52, 78, 52, 81), types: [10, 1], friendship: 143,
      status: { kind: 'burn' }, currentHp: 30, location: { kind: 'party', slot: 1 }, notes: [], exp: save.exp, origin: 'own',
    });
    const shared = [mon.baseStats === MONFERNO.baseStats, mon.types === MONFERNO.types, ...(['ivs', 'evs', 'moves', 'pp', 'ppUps', 'status', 'location'] as const).map((key) => mon[key] === save[key])];
    expect(shared).not.toContain(true);
  });

  it.each<[string, Partial<SaveMon>, object]>([
    ['Wormadam-Sandy', { species: 413, form: 1 }, { species: 413, form: 1, baseStats: stats(60, 79, 105, 59, 85, 36), types: [6, 4] }],
    ['Burmy-Sandy', { species: 412, form: 1 }, { baseStats: stats(40, 29, 45, 29, 45, 36), types: [6, 6] }],
    ['Mothim', { species: 414, form: 1 }, { species: 414, form: 1, baseStats: stats(70, 94, 50, 94, 50, 66), types: [6, 2] }], // the player's save has one
  ])('takes base stats and types from the form\'s Personal row: %s', (name, fields, expected) =>
    expect(player(boxMon(box(1, 1), fields))).toMatchObject({ name, ...expected }));

  it('gives a box Pokémon full HP from the stat formula and no status, as the PC heals it, and so a party one with no current HP', () => {
    // Level 16, HP IV 20, HP EV 4: floor((128 + 20 + 1) × 16 / 100) + 16 + 10 = 49.
    expect(player(boxMon(box(3, 7), { level: 16, ivs: stats(20, 0, 0, 0, 0, 0), status: { kind: 'paralysis' } })))
      .toMatchObject({ currentHp: 49, status: { kind: 'none' }, location: { kind: 'box', box: 3, slot: 7 }, notes: [] });
    const { currentHp: _hp, ...noHp } = monferno();
    expect(player(noHp)).toMatchObject({ currentHp: 44, status: { kind: 'burn' } });
  });

  it('notes stored stats that differ from the formula\'s, and keeps the formula\'s', () => {
    expect(player(monferno({ storedStats: NOTED }))).toMatchObject({ currentHp: 30, baseStats: MONFERNO.baseStats,
      notes: ['Stored stats differ from the formula\'s: Atk 40 stored, 41 computed; Spe 43 stored, 42 computed. The planner uses the computed stats.'] });
  });

  it('throws for a species the ROM lacks', () => expect(() => player(monferno({ species: 1 }))).toThrow('The ROM has no species record 1'));
});

describe('eligibleTeam', () => {
  it('keeps the party, then the boxes in box and slot order, and drops the dead, the fainted, eggs, the over-cap and bad checksums', () => {
    const save = {
      party: [
        monferno({ location: party(1), nickname: 'Lead' }), monferno({ location: party(2), nickname: 'Egg', isEgg: true }),
        monferno({ location: party(3), nickname: 'TooHigh', level: 17 }), monferno({ location: party(4), nickname: 'AtCap', level: 16 }),
        monferno({ location: party(5), nickname: 'Fainted', currentHp: 0 }), monferno({ location: party(6), nickname: 'OneHp', currentHp: 1 }),
      ],
      boxes: [
        boxMon(box(2, 1), { nickname: 'Box2' }), boxMon(box(1, 3), { nickname: 'Box1b' }), boxMon(box(1, 1), { nickname: 'Box1a' }),
        boxMon(box(15, 1), { nickname: 'Dead' }), boxMon(box(18, 30), { nickname: 'DeadToo' }), boxMon(box(4, 4), { nickname: 'Over', level: 30 }),
        boxMon(box(5, 5), { nickname: 'BoxEgg', isEgg: true }),
        // A bad checksum record is garbage: a species the ROM lacks would throw if it were built.
        boxMon(box(6, 6), { nickname: 'Garbage', species: 60000, badChecksum: true }),
      ],
      trainer: OWN_TRAINER,
    };
    const team = eligibleTeam(save, data, OPTS);
    expect(team.map((m) => [m.nickname, m.location])).toEqual([
      ['Lead', party(1)], ['AtCap', party(4)], ['OneHp', party(6)], ['Box1a', box(1, 1)], ['Box1b', box(1, 3)], ['Box2', box(2, 1)]]);
    expect(eligibleTeam({ party: [], boxes: [], trainer: OWN_TRAINER }, data, OPTS)).toEqual([]);
  });
});

describe('atLevel', () => {
  const base = () => player(monferno());
  const statsOf = (m: ReturnType<typeof base>) => computeStats(m.baseStats, m.ivs, m.evs, m.level, m.nature.value ?? 0);

  it('at its own level gives back an equal copy, with the save\'s stats and its stored-stats note', () => {
    const mon = player(monferno({ storedStats: NOTED }));
    const same = atLevel(mon, mon.level);
    expect(same).toEqual(mon);
    expect(same).not.toBe(mon);
    expect([statsOf(same), same.notes.length]).toEqual([stats(44, 41, 24, 26, 21, 42), 1]);
  });

  it('sets the level, with the formula\'s stats from its own base stats, IVs, EVs and nature, and raises current HP by the max HP gained', () => {
    const mon = atLevel(player(monferno({ storedStats: NOTED })), 18);
    // HP floor((128 + 0 + 1) × 18 / 100) + 18 + 10 = 51, so current HP 30 + (51 - 44).
    expect(statsOf(mon)).toEqual(computeStats(stats(64, 78, 52, 78, 52, 81), stats(0, 26, 12, 10, 7, 24), stats(4, 252, 1, 2, 3, 250), 18, 8));
    expect(mon).toMatchObject({
      level: 18, currentHp: 30 + (51 - 44), baseStats: stats(64, 78, 52, 78, 52, 81), ivs: stats(0, 26, 12, 10, 7, 24), evs: stats(4, 252, 1, 2, 3, 250),
      nature: { value: 8 }, moves: [10, 52, 2, 290], pp: [35, 24, 25, 20], ppUps: [0, 1, 2, 3], item: 217, ability: { value: BLAZE }, status: { kind: 'burn' },
      friendship: 143, location: { kind: 'party', slot: 1 }, nickname: 'Fernando', species: 391,
      notes: [], // the stored stats were for the save's level
    });
  });

  it('keeps full HP full and fainted fainted, never goes over max HP, and leaves the given Pokémon alone', () => {
    const full = player(monferno({ currentHp: 44 }));
    expect(atLevel(full, 30).currentHp).toBe(statsOf(atLevel(full, 30)).hp);
    const boxed = atLevel(player(boxMon(box(1, 1), { level: 16 })), 20);
    expect(boxed.currentHp).toBe(statsOf(boxed).hp);
    expect(atLevel(player(monferno({ currentHp: 0 })), 20).currentHp).toBe(0);
    const mon = base();
    atLevel(mon, 40);
    expect([mon.level, mon.currentHp]).toEqual([15, 30]);
    const down = atLevel(mon, 10);
    expect(down.currentHp).toBeLessThanOrEqual(statsOf(down).hp);
  });

  it('rejects a level that is not a whole number from 1 to 100', () => {
    for (const bad of [0, 101, 1.5, Number.NaN]) expect(() => atLevel(base(), bad)).toThrow(RangeError);
  });
});

describe('toPlayerMon: origin (BattleSystem_PokemonIsOT, battle_lib.c:6286-6302)', () => {
  const NAME = OWN_TRAINER.nameCodes;
  const seven = { ...OWN_TRAINER, nameCodes: [1, 2, 3, 4, 5, 6, 7, 0xffff] }; // a trainer name with no terminator in its 7 letters
  it.each<[string, Partial<SaveMon>, 'own' | 'traded' | 'tradedOtherLanguage', typeof OWN_TRAINER?]>([
    ['the OT ID, gender and name are the trainer\'s', {}, 'own'],
    ['the language differs: the game compares ID, gender and name only', { language: 5 }, 'own'],
    ['only the OT ID differs', { otId: 25643 }, 'traded'],
    ['only the secret ID differs (the low half alone is not the ID)', { otId: OWN_TRAINER.id + 0x10000 }, 'traded'],
    ['only the OT gender differs', { otGender: 1 }, 'traded'],
    ['the name differs in one of its first 7 codes', { otName: [0x12e, 0x12f, 0x13c, 0x134, 0xffff, 0xffff, 0xffff, 0xffff] }, 'traded'],
    ['the name differs in the terminator', { otName: [...NAME.slice(0, 4), 0x12e, 0xffff, 0xffff, 0xffff] }, 'traded'],
    ['the codes after the first terminator both share differ, which is ignored', { otName: [...NAME.slice(0, 5), 1, 2, 3] }, 'own'],
    ['the name has no terminator where the trainer\'s has one', { otName: [...NAME.slice(0, 4), 0, 0, 0, 0] }, 'traded'],
    // CharCode_CompareNumChars with TRAINER_NAME_LEN 7 checks 8 codes.
    ['a 7-letter name ends alike', { otName: [1, 2, 3, 4, 5, 6, 7, 0xffff] }, 'own', seven],
    ['a 7-letter name differs in the 8th code', { otName: [1, 2, 3, 4, 5, 6, 7, 0x12e] }, 'traded', seven],
    ['a 7-letter name differs in the 7th code', { otName: [1, 2, 3, 4, 5, 6, 8, 0xffff] }, 'traded', seven],
    ['a trade from the game\'s own language', { otId: 25643, language: GAME_LANGUAGE }, 'traded'],
    ['a trade from another language', { otId: 25643, language: 1 }, 'tradedOtherLanguage'],
    ['another OT gender in another language', { otGender: 1, language: 7 }, 'tradedOtherLanguage'],
  ])('is right when %s', (_, fields, origin, trainer = OWN_TRAINER) => expect(toPlayerMon(monferno(fields), data, trainer).origin).toBe(origin));

  it('gives box Pokémon the same origin, `eligibleTeam` filling it from the save\'s trainer', () => {
    const save = { party: [monferno(), monferno({ location: party(2), otId: 25643 })], boxes: [boxMon(box(1, 1), { otGender: 1, language: 3 })], trainer: OWN_TRAINER };
    expect(eligibleTeam(save, data, { ...OPTS, levelCap: 100 }).map((m) => m.origin)).toEqual(['own', 'traded', 'tradedOtherLanguage']);
  });
});
