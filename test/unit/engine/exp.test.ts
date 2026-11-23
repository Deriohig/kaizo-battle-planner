// The EXP a knock-out pays as the cartridge computes it (`expGain`, src/engine/exp.ts), the EXP each of the player's
// Pokémon starts a battle with (`m.exp`, `m.expRate`: sets.ts), and the dex access both read (dex.ts).
// Sources: pret/pokeplatinum; bs = src/battle/battle_script.c.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { atLevel, type PlayerMon } from '../../../src/battle/playerMon.js';
import type { BattleInput, Choice, EngineState } from '../../../src/contracts/engine.js';
import { createBattle, restore, snapshot } from '../../../src/engine/battle.js';
import { baseExpOf, growthTable, growthTableOf, installedDataDigest, installKaizoDex, learnsetOf } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { EXP_KEY, EXP_RATE_KEY, expEnemyOf, expGain, expItemOf, expSlotOf, type ExpEnemy, type ExpSlot } from '../../../src/engine/exp.js';
import { itemId } from '../../../src/engine/ids.js';
import { romSpecies } from '../../fixtures/loadedData.js';
import { BAG, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const PRINPLUP = 394;
const SLUGMA = 218;
const DEOXYS_ATTACK_ROW = 496;
const EXP_SHARE = 216; // hold effect 51
const LUCKY_EGG = 231; // hold effect 66

const fixture = fixtureDex();
// Base EXP and growth rates, the hack ROM's unless marked invented; the vanilla growth tables stand in (dex.ts).
fixture.data.rom.species[ID.zigzagoon]!.baseExp = 60;
fixture.data.rom.species[ID.monferno]!.baseExp = 142;
fixture.data.rom.species[ID.bidoof]!.baseExp = 58;
fixture.data.rom.species[ID.deoxys]!.baseExp = 255;
fixture.data.rom.species[DEOXYS_ATTACK_ROW]!.baseExp = 7; // invented, to tell the rows apart
fixture.data.rom.species[PRINPLUP] = romSpecies(PRINPLUP, { baseExp: 143, growthRate: 3 });
fixture.data.rom.species[SLUGMA] = romSpecies(SLUGMA, { baseExp: 78, growthRate: 0 });
// Invented learnsets, to tell the rows apart.
fixture.data.rom.learnsets[ID.deoxys] = [{ move: ID.leer, level: 51 }];
fixture.data.rom.learnsets[DEOXYS_ATTACK_ROW] = [{ move: ID.slash, level: 51 }];
fixture.data.rom.learnsets[ID.castform] = [{ move: ID.ember, level: 20 }];
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

/** Base EXP for the formula's own tests, the hack ROM's: ROM trainer 16's four, Chansey and Ditto. */
const SEEDOT = 273, SEEL = 86, PONYTA = 77, NIDORINO = 33, CHANSEY = 113, DITTO = 132;
const BASE: Readonly<Record<number, number>> = { [SEEDOT]: 74, [SEEL]: 100, [PONYTA]: 152, [NIDORINO]: 118, [CHANSEY]: 1, [DITTO]: 61 };
const base = (species: number): number => {
  const value = BASE[species];
  if (value === undefined) throw new Error(`No base EXP for species ${species} in this test`);
  return value;
};

/** A party slot as `expGain` reads it: by default a living level 30 participant of the player's own, holding nothing. */
const slot = (fields: Partial<ExpSlot> = {}): ExpSlot => ({ hp: 50, level: 30, holdEffect: 0, expRate: 100, participant: true, ...fields });
const SHARE = 51; // HOLD_EFFECT_EXP_SHARE
const EGG = 66; // HOLD_EFFECT_EXP_UP
const gain = (enemy: ExpEnemy, party: ExpSlot[], trainerBattle = true): number[] => expGain({ enemy, party, trainerBattle }, base);
const seel21: ExpEnemy = { species: SEEL, level: 21 }; // 300
const holder = (fields: Partial<ExpSlot> = {}) => slot({ participant: false, holdEffect: SHARE, ...fields });
const TRAINER_16: ExpEnemy[] = [{ species: SEEDOT, level: 21 }, { species: SEEL, level: 21 }, { species: PONYTA, level: 21 }, { species: NIDORINO, level: 22 }];

describe('expGain: the formula (bs:2187-2245, bs:9685-9775)', () => {
  // Each literal is the cartridge's integer arithmetic: floor(base x level / 7), shares, then each multiplier floored.
  it.each<[string, ExpEnemy, ExpSlot[], boolean, number[]]>([
    ['an own Pokémon alone: 456 x150/100', { species: PONYTA, level: 21 }, [slot()], true, [684]],
    ['a traded one: x150/100 again', { species: PONYTA, level: 21 }, [slot({ expRate: 150 })], true, [1026]],
    ['another language: x170/100 (floor of 1162.8)', { species: PONYTA, level: 21 }, [slot({ expRate: 170 })], true, [1162]],
    ['a wild battle gives no x150/100 (bs:9753-9755)', { species: PONYTA, level: 21 }, [slot()], false, [456]],
    ['the Lucky Egg first, then the trainer battle: 370 -> 555 -> floor(832.5)', { species: NIDORINO, level: 22 }, [slot({ holdEffect: EGG })], true, [832]],
    ['then the trade, each floored: 222 -> 333 -> 499 -> 748 (one x3.375 gives 749)', { species: SEEDOT, level: 21 }, [slot({ holdEffect: EGG, expRate: 150 })], true, [748]],
    ['the other-language x170/100 comes last: 333 -> 499 -> 848', { species: SEEDOT, level: 21 }, [slot({ holdEffect: EGG, expRate: 170 })], true, [848]],
    ['the same in a wild battle: 333 -> 566', { species: SEEDOT, level: 21 }, [slot({ holdEffect: EGG, expRate: 170 })], false, [566]],
    ['participants share exp: 150 each', seel21, [slot(), slot()], true, [225, 225]],
    ['a fainted participant gets nothing and is not counted (bs:2204-2207)', seel21, [slot(), slot({ hp: 0 })], true, [450, 0]],
    ['a bench Exp. Share holder gets half; the fighter the other half (bs:2219-2230)', seel21, [slot(), holder()], true, [225, 225]],
    ['a holder that took part alone gets both halves', seel21, [slot({ holdEffect: SHARE })], true, [450]],
    ['two holders, one the only participant: 150 + 75, and 75', seel21, [slot({ holdEffect: SHARE }), holder()], true, [337, 112]],
    ['a fainted holder is not counted', seel21, [slot(), holder({ hp: 0 })], true, [450, 0]],
    ['each share is at least 1 (bs:2222-2236)', { species: CHANSEY, level: 5 }, [slot(), slot()], true, [1, 1]],
    ['each share is at least 1, with a holder', { species: CHANSEY, level: 5 }, [slot(), holder()], true, [1, 1]],
    ['a level 100 participant gets nothing but counts (bs:9740)', seel21, [slot({ level: 100 }), slot()], true, [0, 225]],
    ['a level 100 holder gets nothing but counts', seel21, [slot(), holder({ level: 100 })], true, [225, 0]],
    ['every participant fainted: the holders still get their share (bs:2220, :2232)', seel21, [slot({ hp: 0 }), slot({ hp: 0 }), holder()], true, [0, 0, 225]],
    ['every participant and holder fainted: nothing divides by 0', seel21, [slot({ hp: 0 }), holder({ hp: 0 })], true, [0, 0]],
    ['one that neither took part nor holds an Exp. Share gets nothing (bs:9703-9712)', seel21, [slot(), slot({ participant: false }), slot({ participant: false, holdEffect: EGG })], true, [450, 0, 0]],
    ['a Transformed enemy pays the copied species\' base EXP at its own level: 651, not 261', { species: DITTO, level: 30, transformedInto: PONYTA }, [slot()], true, [976]],
    ['a Ditto as itself', { species: DITTO, level: 30 }, [slot()], true, [391]],
    ['gained is floored when the participants do not divide exp: 55.5 -> 55 -> 82', { species: SEEDOT, level: 21 }, [slot(), slot(), slot(), slot()], true, [82, 82, 82, 82]],
    ['370 / 3 -> 123 -> 184', { species: NIDORINO, level: 22 }, [slot(), slot(), slot()], true, [184, 184, 184]],
    ['370 / 6 -> 61 -> 91', { species: NIDORINO, level: 22 }, Array.from({ length: 6 }, () => slot()), true, Array(6).fill(91)],
    ['with a bench holder: 150 / 4 -> 37 -> 55', seel21, [slot(), slot(), slot(), slot(), holder()], true, [55, 55, 55, 55, 225]],
    ['shared is floored when the holders do not divide the half (bs:2226): 150 / 4 -> 55', seel21, [slot(), holder(), holder(), holder(), holder()], true, [225, 55, 55, 55, 55]],
    ['370 / 2 = 185 -> 277; 185 / 3 -> 61 -> 91', { species: NIDORINO, level: 22 }, [slot(), holder(), holder(), holder()], true, [277, 91, 91, 91]],
  ])('%s', (_, enemy, party, trainerBattle, expected) => expect(gain(enemy, party, trainerBattle)).toEqual(expected));

  it('the Lucky Egg step is floored before the trainer step: 101 -> 151 -> 226 (bs:9749-9755)', () => {
    const at = (trainerBattle: boolean) => expGain({ enemy: { species: 1, level: 12 }, party: [slot({ holdEffect: EGG })], trainerBattle }, () => 59);
    expect([at(true), at(false)]).toEqual([[226], [151]]);
  });

  it('reads the installed dex\'s base EXP by default: Zigzagoon 20 -> 171 -> 256', () => {
    expect(expGain({ enemy: { species: ID.zigzagoon, level: 20 }, party: [slot()], trainerBattle: true })).toEqual([256]);
  });

  it('the worked example: ROM trainer 16 against the save\'s Prinplup alone, then the traded Chestnut alone', () => {
    expect(TRAINER_16.map((enemy) => gain(enemy, [slot({ level: 21 })])[0])).toEqual([333, 450, 684, 555]);
    expect(TRAINER_16.map((enemy) => gain(enemy, [slot({ level: 19, expRate: 150 })])[0])).toEqual([499, 675, 1026, 832]);
    const walk = (start: number, level: number, expRate: number, table: readonly number[]) => {
      let exp = start;
      return TRAINER_16.map((enemy) => {
        exp += gain(enemy, [slot({ level, expRate })])[0]!;
        while (level < 100 && exp >= table[level + 1]!) level++;
        return [exp, level];
      });
    };
    const [prinplup, slugma] = [growthTableOf(PRINPLUP), growthTableOf(SLUGMA)]; // medium slow; cubic
    expect([prinplup.slice(21, 24), slugma.slice(19, 21)]).toEqual([[6458, 7577, 8825], [6859, 8000]]);
    expect(walk(6458, 21, 100, prinplup)).toEqual([[6791, 21], [7241, 21], [7925, 22], [8480, 22]]);
    expect(walk(6859, 19, 150, slugma).slice(0, 2)).toEqual([[7358, 19], [8033, 20]]);
  });

  it.skipIf(!existsSync('data/rom/romdata.json'))('the worked example\'s numbers are the hack ROM\'s: trainer 16, base EXP, growth (data/rom)', () => {
    const rom = JSON.parse(readFileSync('data/rom/romdata.json', 'utf8')) as {
      trainers: { index: number; party: { species: number; level: number }[] }[];
      species: { baseExp: number; growthRate: number }[]; growth: number[][];
    };
    const trainer = rom.trainers.find((candidate) => candidate.index === 16)!;
    expect(trainer.party.map(({ species, level }) => ({ species, level }))).toEqual(TRAINER_16);
    for (const [species, value] of Object.entries(BASE)) expect(rom.species[Number(species)]!.baseExp).toBe(value);
    expect(rom.growth[rom.species[PRINPLUP]!.growthRate]!.slice(21, 24)).toEqual([6458, 7577, 8825]);
    expect(rom.growth[rom.species[SLUGMA]!.growthRate]!.slice(19, 21)).toEqual([6859, 8000]);
    expect(trainer.party.map((enemy) => expGain({ enemy, party: [slot({ level: 21 })], trainerBattle: true }, (s) => rom.species[s]!.baseExp)[0])).toEqual([333, 450, 684, 555]);
  });
});

const move = (slotIndex: number): Choice => ({ kind: 'move', slot: slotIndex });
const duel = (mine: PlayerMon, theirs: ReturnType<typeof resolvedMon>): BattleInput => ({ player: [mine], trainer: resolvedTrainer(BAG.none, [theirs]), field: {} });
/** The player's `player` (lead first) against a level 20 Zigzagoon. */
const team = (...player: PlayerMon[]): BattleInput => ({ player, trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.growl])]), field: {} });

describe('expSlotOf, expItemOf, expEnemyOf: what the routine reads of a battle', () => {
  it('a Lucky Egg or Exp. Share knocked off still pays: the item is the party\'s (bs:6624-6628, :9705-9707)', () => {
    // Zigzagoon 20: 171. Lucky Egg 171 -> 256 -> 384; Exp. Share on the only participant 85 + 85 = 170 -> 255.
    for (const [item, effect, paid] of [[LUCKY_EGG, EGG, 384], [EXP_SHARE, SHARE, 255]] as const) {
      const start = createBattle(duel(playerMon(ID.monferno, 30, [ID.growl], { item }), resolvedMon(ID.deoxys, 50, [ID.knockOff])));
      const before = restore(start).p1.active[0]!;
      expect([expItemOf(before), expSlotOf(before, true).holdEffect]).toEqual([itemId(item), effect]);
      const knocked = expandTurn(start, { p1: move(0), p2: move(0) }).map((outcome) => restore(outcome.state).p1.active[0]!).filter((mon) => mon.hp > 0);
      expect(knocked.length).toBeGreaterThan(0);
      for (const mon of knocked) {
        expect([mon.item, expItemOf(mon), expSlotOf(mon, true).holdEffect]).toEqual(['', itemId(item), effect]);
        expect(expGain({ enemy: { species: ID.zigzagoon, level: 20 }, party: [expSlotOf(mon, true)], trainerBattle: true })).toEqual([paid]);
      }
    }
  });

  it('an item held now is read when none was knocked off (none is 0); with no item records, the two items\' vanilla hold effects stand in', () => {
    const party = () => team(playerMon(ID.monferno, 30, [ID.growl], { item: LUCKY_EGG }), playerMon(ID.bidoof, 25, [ID.tackle]));
    const [monferno, bidoof] = restore(createBattle(party())).p1.pokemon;
    expect([expItemOf(monferno!), expSlotOf(monferno!, true).holdEffect, expItemOf(bidoof!), expSlotOf(bidoof!, false).holdEffect]).toEqual([itemId(LUCKY_EGG), EGG, '', 0]);
    try {
      installKaizoDex({ ...fixture.data, rom: { ...fixture.data.rom, items: [] } }, fixture.moves);
      const [egg, share] = restore(createBattle(team(playerMon(ID.monferno, 30, [ID.growl], { item: LUCKY_EGG }), playerMon(ID.bidoof, 25, [ID.tackle], { item: EXP_SHARE })))).p1.pokemon;
      expect([expSlotOf(egg!, true).holdEffect, expSlotOf(share!, false).holdEffect]).toEqual([EGG, SHARE]);
    } finally {
      installKaizoDex(fixture.data, fixture.moves);
    }
  });

  it('a slot carries the Pokémon\'s HP, level, EXP rate and whether it took part', () => {
    const mine = restore(createBattle(team(playerMon(ID.monferno, 30, [ID.growl], { origin: 'traded' })))).p1.active[0]!;
    expect(expSlotOf(mine, true)).toEqual({ hp: mine.hp, level: 30, holdEffect: 0, expRate: 150, participant: true });
    expect(expSlotOf(mine, false).participant).toBe(false);
  });

  it('a Transformed enemy is its copied species at its own level (bs:5345-5348): Monferno\'s 142 at 60 -> 1825', () => {
    const battle = restore(createBattle(duel(playerMon(ID.monferno, 30, [ID.growl]), resolvedMon(ID.zigzagoon, 60, [ID.growl]))));
    const enemy = battle.p2.active[0]!;
    expect(expEnemyOf(enemy)).toEqual({ species: ID.zigzagoon, level: 60 });
    expect(enemy.transformInto(battle.p1.active[0]!)).toBe(true);
    expect(expEnemyOf(enemy)).toEqual({ species: ID.zigzagoon, level: 60, transformedInto: ID.monferno });
    expect(expGain({ enemy: expEnemyOf(enemy), party: [slot()], trainerBattle: true })).toEqual([1825]);
  });

  it('an enemy in a form pays its species\' base EXP, never the form\'s row: 255 -> 2731, not 7 -> 75', () => {
    const enemy = restore(createBattle(duel(playerMon(ID.monferno, 30, [ID.growl]), resolvedMon(ID.deoxys, 50, [ID.growl], { form: 1 })))).p2.active[0]!;
    expect([enemy.species.id, expEnemyOf(enemy)]).toEqual(['deoxysattack', { species: ID.deoxys, level: 50 }]);
    expect(expGain({ enemy: expEnemyOf(enemy), party: [slot()], trainerBattle: true })).toEqual([2731]);
  });
});

/** Monferno is medium slow: level 29 at 19411 EXP, 30 at 21760, 31 at 24294, 33 at 29949. Bidoof is medium fast: 25 at 15625. */
const MONFERNO_AT = { 29: 19411, 30: 21760, 31: 24294, 33: 29949 } as const;
const mine = (state: EngineState, index: number) => {
  const side = restore(state).p1;
  return side.pokemon.find((pokemon) => side.team.indexOf(pokemon.set) === index)!;
};
const expOf = (state: EngineState, index = 0): unknown => (mine(state, index).m as Record<string, unknown>)[EXP_KEY];
const rateOf = (state: EngineState, index: number): unknown => (mine(state, index).m as Record<string, unknown>)[EXP_RATE_KEY];
const monferno = (exp?: number) => playerMon(ID.monferno, 30, [ID.ember], exp === undefined ? {} : { exp });

describe('createBattle: each of the player\'s Pokémon\'s EXP (m.exp) and EXP rate (m.expRate)', () => {
  it('starts from the save\'s EXP when it fits the level; the trainer\'s Pokémon have none', () => {
    const state = createBattle(team(monferno(22000), playerMon(ID.bidoof, 25, [ID.tackle], { exp: 15625 })));
    expect([expOf(state, 0), expOf(state, 1)]).toEqual([22000, 15625]);
    for (const pokemon of restore(state).p2.pokemon) expect((pokemon.m as Record<string, unknown>)[EXP_KEY]).toBeUndefined();
  });

  it('EXP that does not fit the level starts at the level\'s own total, as a Rare Candy leaves it', () => {
    const at = (mon: PlayerMon) => expOf(createBattle(team(mon)));
    expect([at(atLevel(monferno(22000), 33)), at(atLevel(monferno(22000), 29)), at(monferno(MONFERNO_AT[31])), at(monferno(MONFERNO_AT[31] - 1))])
      .toEqual([MONFERNO_AT[33], MONFERNO_AT[29], MONFERNO_AT[30], MONFERNO_AT[31] - 1]);
    // No save EXP: the level's own total; level 100 holds its total or more (pk:3509-3512 clamps only when EXP is added).
    expect([at(playerMon(ID.bidoof, 25, [ID.tackle])), at(playerMon(ID.bidoof, 100, [ID.tackle], { exp: 1_000_000 }))]).toEqual([15625, 1_000_000]);
  });

  it('a carry\'s EXP overrides the save\'s, starting it at that level; a carry without one keeps the save\'s; a bad one throws', () => {
    const carried = (exp?: number) => createBattle({ ...team(monferno(22000)), carry: { mons: [{ hp: 999, pp: [99], status: { kind: 'none' }, ...(exp === undefined ? {} : { exp }) }] } });
    expect([23000, undefined, MONFERNO_AT[30], MONFERNO_AT[31] - 1].map((exp) => expOf(carried(exp)))).toEqual([23000, 22000, MONFERNO_AT[30], MONFERNO_AT[31] - 1]);
    expect(() => carried(-1)).toThrow(RangeError);
    expect(() => carried(22000.5)).toThrow(RangeError);
    for (const [exp, level] of [[MONFERNO_AT[31], 31], [MONFERNO_AT[30] - 1, 29]] as const) expect([mine(carried(exp), 0).level, expOf(carried(exp))]).toEqual([level, exp]);
  });

  it('m.expRate is the origin\'s multiplier: own 100, traded 150, another language 170 (bs:9757-9765)', () => {
    const mon = (origin?: PlayerMon['origin']) => playerMon(ID.bidoof, 25, [ID.tackle], origin === undefined ? {} : { origin });
    const state = createBattle(team(mon(), mon('own'), mon('traded'), mon('tradedOtherLanguage')));
    expect([0, 1, 2, 3].map((index) => rateOf(state, index))).toEqual([100, 100, 150, 170]);
    expect(() => createBattle(team(mon('stolen' as PlayerMon['origin'])))).toThrow(RangeError);
  });

  it('m.exp is in the state key; m.exp and m.expRate survive a step and a restore, and a knock-out pays', () => {
    const at = (exp: number) => createBattle(team(monferno(exp)));
    expect(at(22000).key).toBe(at(22000).key);
    expect(at(22000).key).not.toBe(at(22001).key);
    const state = createBattle(team(playerMon(ID.monferno, 30, [ID.ember], { exp: 22000, origin: 'traded' })));
    for (const outcome of expandTurn(state, { p1: move(0), p2: move(0) })) {
      const paid = outcome.fainted.p2.length > 0 ? 384 : 0; // 171 -> 256 -> 384 (traded)
      expect([expOf(outcome.state, 0), rateOf(outcome.state, 0), snapshot(restore(outcome.state)).key]).toEqual([22000 + paid, 150, outcome.state.key]);
    }
  });
});

/** Growth table values from the decompilation's exp_tables.csv, which equal the hack ROM's. */
const VANILLA_POINTS: readonly (readonly [rate: number, level: number, exp: number])[] = [
  [0, 0, 0], [0, 1, 0], [0, 2, 8], [0, 25, 15625], [0, 26, 17576], [0, 100, 1000000],
  [1, 2, 15], [1, 50, 125000], [1, 51, 131324], [1, 68, 257834], [1, 69, 267406], [1, 98, 583539], [1, 99, 591882], [1, 100, 600000],
  [2, 2, 4], [2, 15, 1957], [2, 16, 2457], [2, 36, 46656], [2, 37, 50653], [2, 100, 1640000],
  [3, 1, 0], [3, 2, 9], [3, 29, 19411], [3, 30, 21760], [3, 33, 29949], [3, 100, 1059860],
  [4, 2, 6], [4, 37, 40522], [4, 100, 800000],
  [5, 2, 10], [5, 37, 63316], [5, 50, 156250], [5, 51, 165813], [5, 100, 1250000],
  [6, 10, 1000], [7, 100, 1000000],
];

describe('dex access: base EXP, growth tables, learnsets', () => {
  it('baseExpOf reads the species\' own Personal row', () => {
    expect([baseExpOf(ID.zigzagoon), baseExpOf(ID.deoxys), baseExpOf(PRINPLUP)]).toEqual([60, 255, 143]);
    expect(() => baseExpOf(5)).toThrow(/species/);
  });

  it('with no growth tables in the data, the vanilla tables stand in: all 808 values of exp_tables.csv', () => {
    expect(VANILLA_POINTS.map(([rate, level]) => [rate, level, growthTable(rate)[level]])).toEqual(VANILLA_POINTS);
    const tables = Array.from({ length: 8 }, (_, rate) => growthTable(rate));
    expect(tables.map((table) => table.length)).toEqual(Array(8).fill(101));
    // SHA-256 of JSON.stringify of the CSV's eight columns (levels 0 to 100); the hack ROM's tables hash the same.
    expect(createHash('sha256').update(JSON.stringify(tables)).digest('hex')).toBe('9b13db5c128a034d98b6eb045fb31cfc031eda9ebd9916320be2eeb198ef1838');
    expect(growthTableOf(ID.monferno)).toBe(growthTable(3));
    expect(() => growthTable(8)).toThrow(/growth rate 8/);
  });

  it.skipIf(!existsSync('data/rom/romdata.json'))('the vanilla stand-in is the hack ROM\'s eight tables (data/rom)', () => {
    const rom = JSON.parse(readFileSync('data/rom/romdata.json', 'utf8')) as { growth: number[][] };
    expect(rom.growth).toHaveLength(8);
    for (let rate = 0; rate < 8; rate++) expect(growthTable(rate)).toEqual(rom.growth[rate]);
  });

  it('data with any growth tables never gets the vanilla ones: its own are read, and a rate they lack is an error', () => {
    const tables = Array.from({ length: 8 }, (_, rate) => Array.from({ length: 101 }, (_, level) => level * 10 + rate));
    const install = (growth: number[][]) => installKaizoDex({ ...fixture.data, rom: { ...fixture.data.rom, growth } }, fixture.moves);
    try {
      install(tables);
      for (let rate = 0; rate < 8; rate++) expect(growthTable(rate)).toEqual(tables[rate]);
      expect(growthTableOf(ID.monferno)).toEqual(tables[3]);
      install(tables.slice(0, 6)); // as the server's fixture has
      expect(growthTable(5)).toEqual(tables[5]);
      expect(() => growthTable(6)).toThrow(/growth rate 6/);
      install(tables.slice(0, 2));
      expect(() => growthTable(3)).toThrow(/growth rate 3/);
    } finally {
      installKaizoDex(fixture.data, fixture.moves);
    }
  });

  it('learnsetOf: the learnset of a species\' own form row; a battle forme uses its species\' (pk:4585-4589)', () => {
    expect([{ num: ID.deoxys, id: 'deoxys' }, { num: ID.deoxys, id: 'deoxysattack' }, { num: ID.castform, id: 'castformsunny' }, { num: ID.zigzagoon, id: 'zigzagoon' }]
      .map((species) => learnsetOf(species))).toEqual([
      { row: ID.deoxys, moves: [{ move: ID.leer, level: 51 }] }, { row: DEOXYS_ATTACK_ROW, moves: [{ move: ID.slash, level: 51 }] },
      { row: ID.castform, moves: [{ move: ID.ember, level: 20 }] }, { row: ID.zigzagoon, moves: [] },
    ]);
  });

  describe('the data digest covers what EXP and level-ups read', () => {
    type Rom = typeof fixture.data.rom;
    const digestOf = (rom: Partial<Rom>): string => {
      try {
        installKaizoDex({ ...fixture.data, rom: { ...fixture.data.rom, ...rom } }, fixture.moves);
        return installedDataDigest();
      } finally {
        installKaizoDex(fixture.data, fixture.moves);
      }
    };
    const withRecord = (fields: object): Partial<Rom> => {
      const species = [...fixture.data.rom.species];
      species[ID.zigzagoon] = { ...species[ID.zigzagoon]!, ...fields };
      return { species };
    };
    it.each<[string, () => Partial<Rom>]>([
      ['a learnset', () => {
        const rows = [...fixture.data.rom.learnsets];
        rows[ID.zigzagoon] = [{ move: ID.tackle, level: 7 }];
        return { learnsets: rows };
      }],
      ['a base EXP', () => withRecord({ baseExp: 61 })],
      ['a growth rate', () => withRecord({ growthRate: 4 })],
      ['the growth tables', () => ({ growth: Array.from({ length: 8 }, (_, rate) => Array.from({ length: 101 }, (_, level) => level ** 3 + rate)) })],
    ])('%s', (_, change) => {
      const plain = digestOf({});
      expect(digestOf(change())).not.toBe(plain);
      expect(digestOf({})).toBe(plain);
    });
  });
});
