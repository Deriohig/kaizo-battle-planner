import { expect, it } from 'vitest';
import type { KaizoMove } from '../../../src/battle/moves.js';
import { type CalcSide, damage } from '../../../src/calc/calc.js';
import { koText, moveLine, percent } from '../../../src/cli/sheetText.js';
import { monferno, move, zigzagoon } from '../../fixtures/battleMons.js';

// The ROM's Counter, Guillotine and Metronome, as `buildMoves` makes them.
const COUNTER = move(68, { name: 'Counter', type: 1, power: 1, priority: -5, target: 1, flags: 1, romEffect: 89, effectText: '2x last amount of damage received', calc: { baseMove: 'Counter' }, unmodelled: '2x last amount of damage received' });
const GUILLOTINE = move(12, { name: 'Guillotine', power: 1, accuracy: 30, flags: 19, romEffect: 38, effectText: 'OHKO', calc: { baseMove: 'Guillotine' }, unmodelled: 'OHKO' });
const METRONOME = move(118, { name: 'Metronome', category: 'status', power: 0, accuracy: 0, target: 16, romEffect: 83, effectText: 'Metronome effect', calc: { baseMove: 'Metronome' }, unmodelled: 'Metronome effect' });
const sturdy = zigzagoon({ ability: { value: 5, source: 'rom', disputed: false, alternatives: [] } });

it('the sheet prints 100% only for a certain KO, as the KO odds are exact; an OHKO move prints its hit chance', () => {
  expect([percent(1), percent(1 - 1e-12), percent(1e-12)]).toEqual(['100%', '99.9%', '0.1%']);
  expect(koText([{ hits: 1, chance: 1 - 1e-12 }, { hits: 2, chance: 1 }, { hits: 3, chance: 1 }, { hits: 4, chance: 1 }], false)).toBe('OHKO 99.9%, 2HKO 100%');
  expect(koText([1, 2, 3, 4].map((hits) => ({ hits, chance: 1 })), true, 0.3)).toBe('KO if it hits (30%)');
  expect(koText([1, 2, 3, 4].map((hits) => ({ hits, chance: 0 })), true, 0)).toBe('no KO (the OHKO cannot land)');
});

// Counter's range and KO chance are unknown, never power-1 numbers or "no KO"; Guillotine's KO chance assumes it hits.
it.each<[string, CalcSide['mon'], CalcSide['mon'], KaizoMove, number, string | RegExp]>([
  ['Counter', zigzagoon(), monferno(), COUNTER, 1, 'Counter -5  ?  KO ?  [unmodelled: 2x last amount of damage received]  hit 100%'],
  ['Guillotine', monferno(), zigzagoon(), GUILLOTINE, 0.4, /^Guillotine {2}20-20 \(100-100%\) {2}KO if it hits \(40%\) {2}/],
  ["Guillotine at the cell's hit chance", monferno(), zigzagoon({ level: 15 }), GUILLOTINE, 0.3, / {2}KO if it hits \(30%\) {2}/],
  ['Guillotine against Sturdy', monferno(), sturdy, GUILLOTINE, 0, / {2}no KO \(the OHKO cannot land\) {2}/],
  ['an unmodelled status move with its flag', zigzagoon(), monferno(), METRONOME, 1, 'Metronome  status  [unmodelled: Metronome effect]  hit 100%'],
])('the sheet prints the move line of %s', (_, attacker, defender, used, hitChance, line) => {
  const result = damage({ mon: attacker }, { mon: defender }, used, {});
  const printed = moveLine({ move: used, result, hitChance, inaccurate: hitChance < 1, unmodelled: result?.unmodelled ?? used.unmodelled });
  expect(printed).toEqual(typeof line === 'string' ? line : expect.stringMatching(line));
});
