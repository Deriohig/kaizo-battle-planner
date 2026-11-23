import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Generations, toID } from '@smogon/calc';
import { describe, expect, it } from 'vitest';
import { EFFECT_MAP, normaliseEffectText, UNMODELLED_EFFECTS } from '../../../src/battle/effectMap.js';
import { buildMoves, hiddenPower, type KaizoMove } from '../../../src/battle/moves.js';
import { parseMovesTab } from '../../../src/docs/tables.js';
import type { DocMove } from '../../../src/docs/types.js';
import type { MoveRecord } from '../../../src/rom/types.js';
import { EFFECT_LISTS, expectEveryEffectClassified } from '../../fixtures/effectClassification.js';
import { loadedData, stats } from '../../fixtures/loadedData.js';

/** A ROM move: physical, 0 power, Normal, 100% accurate, unless `fields` say otherwise. */
const romMove = (id: number, fields: Partial<MoveRecord> = {}): MoveRecord =>
  ({ id, effect: 0, category: 'physical', power: 0, type: 0, accuracy: 100, pp: 10, effectChance: 0, target: 0, priority: 0, flags: 0, ...fields });
/** A Moves tab row. Its numbers are deliberately not the ROM's, so a test sees any number taken from the docs. */
const docMove = (id: number, name: string, effectText: string): DocMove =>
  ({ id, name, effectText, category: 'status', power: 999, type: 'Fairy', accuracy: 1, pp: 99, effectChance: 99, targets: '', priority: 9, contact: false });

/** `buildMoves` over these ROM moves and docs rows, and ROM items with these fling powers. */
function movesOf(rom: MoveRecord[], docs: DocMove[], flingPowers: number[] = []): Map<number, KaizoMove> {
  const data = loadedData({ species: [], trainers: [], docSpecies: [], docTrainers: [] });
  for (const move of rom) data.rom.moves[move.id] = move;
  data.rom.items = flingPowers.map((flingPower, id) => ({ id, flingPower }));
  data.docs.moves.push(...docs);
  return buildMoves(data);
}
const moveOf = (rom: MoveRecord, name: string, effectText: string) => movesOf([rom], [docMove(rom.id, name, effectText)]).get(rom.id)!;

describe('buildMoves', () => {
  it('takes the ROM\'s numbers and the docs\' name: Water Ball (4) on Swift, its type overridden', () => {
    expect(moveOf(romMove(4, { category: 'special', power: 100, type: 11, flags: 18 }), 'Water Ball', 'None')).toEqual({
      id: 4, name: 'Water Ball', type: 11, category: 'special', power: 100, accuracy: 100, pp: 10, priority: 0,
      effectChance: 0, target: 0, flags: 18, romEffect: 0, effectText: 'None', calc: { baseMove: 'Swift' }, unmodelled: null,
    });
  });

  it.each<[name: string, rom: MoveRecord, effectText: string, calc: KaizoMove['calc'], unmodelled: string | null]>([
    ['DoubleSlap', romMove(3, { power: 30, effect: 44 }), 'Hits twice', { baseMove: 'Tackle', hits: 2 }, null], // Smogon's hits 2-5 times
    ['Thrash', romMove(37, { power: 120, effect: 262 }), 'Chance of causing Paralysis; 1/3 damage dealt recoil', { baseMove: 'Tackle', recoil: [1, 3] }, null],
    ['Hyper Beam', romMove(63, { category: 'special', power: 180, effect: 48 }), '1/2 damage dealt recoil, fixed AI', { baseMove: 'Swift', recoil: [1, 2] }, null],
    ['Drill Peck', romMove(65, { power: 80, type: 2, effect: 43 }), 'High crit ratio', { baseMove: 'Tackle', critStage: 1 }, null],
    ['Drill Peck', romMove(65, { power: 80, type: 2 }), '  high CRIT   ratio ', { baseMove: 'Tackle', critStage: 1 }, null], // whatever the case and spacing
    ['Super Fang', romMove(162, { power: 1, type: 17, effect: 40 }), 'Deals damage equal to 1/2 target\'s current hp', { baseMove: 'Super Fang', fixedDamage: 'half-hp' }, null],
    ['470', romMove(470, { category: 'special', power: 100 }), 'Power doubles under the full moon', { baseMove: 'Swift' }, 'Power doubles under the full moon'], // unmapped
    ['Revenge', romMove(279, { power: 60, type: 1 }), '2x Power if user moves after target', { baseMove: 'Payback' }, '2x Power if user moves after target'], // known unmodelled
    ['Hidden Power', romMove(237, { category: 'special', power: 1, effect: 135 }), 'Hidden Power effect', { baseMove: 'Hidden Power' }, null],
    ['Ice Punch', romMove(8, { power: 75 }), ' ', { baseMove: 'Ice Punch' }, 'No effect text in the docs for move 8'],
    // The move's own Smogon base only where its mechanics match the docs, under old spellings too.
    ['Double-Edge', romMove(38, { power: 140 }), '1/3 damage dealt recoil', { baseMove: 'Double-Edge', recoil: [1, 3] }, null],
    ['Brave Bird', romMove(413, { power: 120, type: 2 }), '1/4 damage dealt recoil', { baseMove: 'Tackle', recoil: [1, 4] }, null], // Smogon's has 1/3
    ['Karate Chop', romMove(2, { power: 50, type: 1 }), 'High crit ratio', { baseMove: 'Karate Chop', critStage: 1 }, null],
    ['Swift', romMove(129, { category: 'special', power: 60, accuracy: 0 }), 'Always hits', { baseMove: 'Swift', ignoresAccuracy: true }, null],
    ['Aurora Beam', romMove(62, { category: 'special', power: 60, type: 15, accuracy: 0 }), 'Always hits', { baseMove: 'Swift', ignoresAccuracy: true }, null], // Smogon's can miss
    ['Hi Jump Kick', romMove(136, { power: 150, type: 1, effect: 45 }), 'Deals 1/2 user\'s max HP to user if it misses', { baseMove: 'High Jump Kick' }, null],
    ['Faint Attack', romMove(185, { power: 60, type: 17, accuracy: 0, effect: 17 }), 'Always hits', { baseMove: 'Feint Attack', ignoresAccuracy: true }, null],
    ['SmellingSalt', romMove(265, { power: 90 }), '2x power if target is Paralyzed; cures target of Paralysis', { baseMove: 'Smelling Salts' }, '2x power if target is Paralyzed; cures target of Paralysis'],
    // A name the calc gives other mechanics is not the base: it scales Eruption by HP, Wring Out by the target's HP, and
    // halves Solar Beam outside sun.
    ['Eruption', romMove(284, { category: 'special', power: 150, type: 10 }), 'Chance of causing Burn; 1/3 damage dealt recoil', { baseMove: 'Swift', recoil: [1, 3] }, null],
    ['Wring Out', romMove(378, { category: 'special', power: 75 }), '2x power if target is at or below 1/2 HP', { baseMove: 'Brine' }, null],
    ['Solar-Beam', romMove(130, { category: 'special', power: 120, type: 12 }), 'None', { baseMove: 'Swift' }, null],
    // Facade's doubling skips the burn halving, which only a physical move has, so a special Facade-alike is unmodelled.
    ['Hex', romMove(363, { category: 'special', power: 70 }), '2x power if user is Poisoned; Paralyzed; or Burned.', { baseMove: 'Facade' }, '2x power if user is Poisoned; Paralyzed; or Burned.'],
    // The calc halves physical Defense only for the Explosion effect, as the cartridge does, so both classes are modelled.
    ['Memento', romMove(262, { category: 'special', power: 255, type: 17, effect: 7 }), 'Selfdestruct/ Explosion effect', { baseMove: 'Explosion' }, null],
    ['Selfdestruct', romMove(120, { power: 200, effect: 7 }), 'Selfdestruct/ Explosion effect', { baseMove: 'Self-Destruct' }, null],
    // A status move keeps its own Smogon name, else Splash; a damaging move with a status namesake does not.
    ['Swords Dance', romMove(14, { category: 'status' }), 'Sharply raises Atk (Status)', { baseMove: 'Swords Dance' }, null],
    ['Not A Move', romMove(150, { category: 'status' }), 'Raises Atk', { baseMove: 'Splash' }, null],
    ['Heart Swap', romMove(391, { category: 'special', power: 95, type: 11, accuracy: 0 }), 'Damages target; heals user up to 50% of damage dealt', { baseMove: 'Swift', drain: [1, 2] }, null],
  ])('%s: the base move and whether it is modelled', (name, rom, effectText, calc, unmodelled) => {
    const move = moveOf(rom, name, effectText);
    expect([move.calc, move.unmodelled, move.effectText, move.power, move.type, move.romEffect]).toEqual([calc, unmodelled, effectText, rom.power, rom.type, rom.effect]);
  });

  it('skips move 0, and names a ROM move the docs lack and reports it', () => {
    const moves = movesOf([romMove(0), romMove(7, { power: 75 })], []);
    expect([...moves.keys()]).toEqual([7]);
    expect(moves.get(7)).toMatchObject({ name: '(move 7)', effectText: '', calc: { baseMove: 'Tackle' }, unmodelled: 'No docs row for move 7' });
  });

  it('gives Fling the ROM\'s fling power of every item, by item ID, and models it', () => {
    const moves = movesOf([romMove(374, { power: 1, type: 17, effect: 233 }), romMove(33, { power: 40 })],
      [docMove(374, 'Fling', 'Power and effect determined by held item'), docMove(33, 'Tackle', 'None')], Array.from({ length: 468 }, (_, id) => (id === 92 ? 250 : id === 450 ? 150 : 30)));
    const fling = moves.get(374)!;
    expect([fling.calc.baseMove, fling.unmodelled, fling.calc.flingPower?.length, fling.calc.flingPower?.[92], fling.calc.flingPower?.[450], fling.calc.flingPower?.[1]])
      .toEqual(['Fling', null, 468, 250, 150, 30]);
    expect(moves.get(33)!.calc.flingPower).toBeUndefined();
  });
});

it('hiddenPower takes the type from the IVs\' low bits and the power from their second bits, in HP, Atk, Def, Spe, SpA, SpD order', () => {
  // Fire (Atk, SpA and Spe even) would be Bug in HP, Atk, Def, SpA, SpD, Spe order.
  expect([stats(31, 31, 31, 31, 31, 31), stats(0, 0, 0, 0, 0, 0), stats(31, 30, 30, 31, 31, 31), stats(31, 30, 31, 30, 31, 30), stats(1, 1, 1, 1, 1, 1), stats(2, 2, 2, 2, 2, 2)]
    .map((ivs) => hiddenPower(ivs))).toEqual([{ type: 17, power: 70 }, { type: 1, power: 30 }, { type: 15, power: 70 }, { type: 10, power: 70 }, { type: 17, power: 30 }, { type: 1, power: 70 }]);
});

describe('the effect lists', () => {
  it('are keyed by normalised text, no text in two lists, and name only Gen 4 Smogon moves as bases, under their Smogon names', () => {
    expect(normaliseEffectText('  1/2 damage dealt  recoil, VANILLA AI ')).toBe('1/2 damage dealt recoil, vanilla ai');
    const all = Object.values(EFFECT_LISTS).flat();
    expect(all.filter((key) => key !== normaliseEffectText(key))).toEqual([]);
    expect(all.filter((key, i) => all.indexOf(key) !== i)).toEqual([]);
    const gen = Generations.get(4);
    const bases = [...Object.values(EFFECT_MAP), ...Object.values(UNMODELLED_EFFECTS)].flatMap((spec) => (spec.baseMove ? [spec.baseMove] : []));
    expect(bases.filter((name) => gen.moves.get(toID(name))?.name !== name)).toEqual([]);
  });

  // The docs CSVs are local only (gitignored); test/real/effectTexts.test.ts runs the same check on the real docs.
  const movesCsv = join(process.env.DATA_DIR || 'data', 'docs', 'Moves.csv');
  it.skipIf(!existsSync(movesCsv))(`classify every effect text in the docs' Moves tab (${movesCsv})`, () => {
    expectEveryEffectClassified(parseMovesTab(readFileSync(movesCsv, 'utf8')));
  });
});
