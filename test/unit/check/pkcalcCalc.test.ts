import { describe, expect, it } from 'vitest';
import type { KaizoMove } from '../../../src/battle/moves.js';
import { damage } from '../../../src/calc/calc.js';
import { type CalcCase, diffCalcWith, type PkcalcCalcInput, type PkcalcNames } from '../../../src/check/pkcalcCalc.js';
import { move, zigzagoon } from '../../fixtures/battleMons.js';

const NAMES: PkcalcNames = { species: () => 'Zigzagoon', move: (id) => `Move ${id}`, item: () => 'Silk Scarf', ability: () => 'Gluttony' };

// Revenge as the hack has it: its doubling is unmodelled, so it runs on Payback, the nearest mechanics. Tackle is modelled.
const REVENGE_TEXT = '2x Power if user moves after target';
const REVENGE = move(279, { name: 'Revenge', type: 1, power: 60, effectText: REVENGE_TEXT, calc: { baseMove: 'Payback' }, unmodelled: REVENGE_TEXT });
const TACKLE = move(33, { name: 'Tackle', calc: { baseMove: 'Tackle' } });
// The ROM's Guillotine and Seismic Toss, as `buildMoves` makes them. PKCalc runs Guillotine on its power-1 numbers.
const GUILLOTINE = move(12, { name: 'Guillotine', power: 1, accuracy: 30, flags: 19, romEffect: 38, effectText: 'OHKO', calc: { baseMove: 'Guillotine' }, unmodelled: 'OHKO' });
const SEISMIC_TOSS = move(69, { name: 'Seismic Toss', type: 1, power: 1, flags: 179, romEffect: 87, calc: { baseMove: 'Seismic Toss', fixedDamage: 'level' } });
// The attacking Zigzagoon holds a Silk Scarf (251), whose fling power is 250 in this made-up table.
const FLING = move(374, { name: 'Fling', type: 17, power: 1, flags: 18, romEffect: 233, calc: { baseMove: 'Fling', flingPower: Array.from({ length: 468 }, (_, item) => (item === 251 ? 250 : 30)) } });

/** Zigzagoon against an itemless level 5 Zigzagoon (20 HP), unless `fields` say otherwise. */
const caseOf = (m: KaizoMove, fields: Partial<CalcCase> = {}): CalcCase =>
  ({ key: `Zigzagoon ${m.name} vs. Zigzagoon`, attacker: { mon: zigzagoon() }, defender: { mon: zigzagoon({ item: 0 }) }, move: m, field: {}, ...fields });

/** A stand-in for PKCalc's calc: our rolls for an input `explains` accepts, one more on every roll otherwise. */
const pkcalcLike = (c: CalcCase, explains: (input: PkcalcCalcInput) => boolean) => async (inputs: PkcalcCalcInput[]) => inputs.map((input) => {
  const result = damage(c.attacker, c.defender, c.move, c.field)!;
  return (input.move.isCrit ? result.critRolls : result.rolls).map((roll) => (explains(input) ? roll : roll + 1));
});

describe('diffCalc: the cause of a difference', () => {
  it.each<[string, CalcCase, (input: PkcalcCalcInput) => boolean, string | null]>([
    ['an unmodelled move -unmodelled only when PKCalc gives our rolls on our base move', caseOf(REVENGE), (input) => input.move.name === 'Payback', '-unmodelled'],
    ['an unmodelled move -unexplained when nothing gives our rolls, so no accepted group takes it', caseOf(REVENGE), () => false, '-unexplained'],
    ['an unmodelled move by another cause that gives our rolls, such as the ROM\'s target', caseOf(REVENGE), (input) => input.move.target !== undefined, '-target'],
    ['an OHKO move -ohko when our rolls are exactly the target\'s HP', caseOf(GUILLOTINE), () => false, '-ohko'],
    ['an OHKO move -unexplained when Sturdy stops it, so its rolls are not the target\'s HP',
      caseOf(GUILLOTINE, { defender: { mon: zigzagoon({ item: 0, ability: { value: 5, source: 'rom', disputed: false, alternatives: [] } }) } }), () => false, '-unexplained'],
    ['a move that is not an OHKO move with no label, even when it deals exactly the target\'s HP (level 20 Seismic Toss)',
      caseOf(SEISMIC_TOSS, { attacker: { mon: zigzagoon({ level: 20 }) } }), () => false, ''],
    ['a Fling -fling-power when PKCalc gives our rolls once its Fling is a plain hit of the ROM\'s power', caseOf(FLING),
      (input) => input.move.name === 'Tackle' && input.move.basePower === 250, '-fling-power'],
    ['a modelled move by the cause shown', caseOf(TACKLE), (input) => input.move.flags !== undefined, '-punch-sound'],
    ['a modelled move with no cause shown', caseOf(TACKLE), () => false, ''],
    ['nothing where PKCalc gives our rolls', caseOf(TACKLE), () => true, null],
  ])('labels %s', async (_, c, explains, suffix) => {
    const fields = (await diffCalcWith(pkcalcLike(c, explains), [c], NAMES)).diffs.map((diff) => diff.field);
    expect(fields).toEqual(suffix === null ? [] : [`rolls${suffix}`, `crit-rolls${suffix}`]);
  });
});
