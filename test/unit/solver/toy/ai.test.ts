import { describe, expect, it } from 'vitest';
import type { ActionSupport } from '../../../../src/contracts/ai.js';
import type { Choice, EngineState, Rational } from '../../../../src/contracts/engine.js';
import { ONE, rat } from '../../../../src/solver/rational.js';
import { createToyAi } from './ai.js';
import { canonical, createToyEngine, readToyState, type ToyMonState } from './engine.js';
import type { ToyMon, ToyRegistry, ToyTrainer } from './game.js';
import { choiceKey, mon, mv, toyInput } from './helpers.js';
import { aiMemory, replacementTie } from './scenarios.js';

/** Hero alone on p1; trainer 'foe'. */
function registry(foe: ToyMon, trainer: Partial<ToyTrainer> = {}): ToyRegistry {
  return { mons: { Hero: mon('Hero', 10, 5, [mv('Tap', [1])]) }, trainers: { foe: { id: 'foe', party: [foe], ...trainer } } };
}

function start(reg: ToyRegistry, p1 = Object.keys(reg.mons), trainerId = 'foe') {
  const engine = createToyEngine(reg);
  const ai = createToyAi(reg);
  const state = engine.createBattle(toyInput(reg, p1, trainerId));
  return { engine, ai, state, memory: ai.initialMemory(state) };
}

/** The state with patches on each side's first mon (the toy AI reads only `state.json`). */
function edited(state: EngineState, edit: { p1?: Partial<ToyMonState>; p2?: Partial<ToyMonState> }): EngineState {
  const s = readToyState(state);
  Object.assign(s.p1[0]!, edit.p1);
  Object.assign(s.p2[0]!, edit.p2);
  return { json: canonical(s), turn: s.turn, phase: s.phase, key: canonical(s) };
}

const shown = (support: ActionSupport[]) => Object.fromEntries(support.map((a) => [choiceKey(a.choice), a.probability]));
const move = (slot: number): Choice => ({ kind: 'move', slot });
const M00 = { p1: move(0), p2: move(0) };
const HALF = rat(1, 2);

const twin = mon('Twin', 10, 5, [mv('Claw', [3]), mv('Bite', [1, 3]), mv('Peck', [2])]);
const healer = mon('Healer', 8, 5, [mv('Mend', [], { effect: 'heal3', tags: ['desperation'] }), mv('Bite', [2])], { ai: { desperationAtOrBelow: 3 } });
const sandman = mon('Sandman', 4, 10, [mv('Doze', [], { effect: 'doze' }), mv('Bonk', [2])]);
const potion: Partial<ToyTrainer> = { bag: ['potion'] };

describe('toy AI', () => {
  it.each<[string, ToyMon, Partial<ToyTrainer>, Parameters<typeof edited>[1], Record<string, Rational>]>([
    ['moves tied at the best max damage share it uniformly', twin, {}, {}, { m0: HALF, m1: HALF }],
    ['the score is max damage × hits', mon('Kicker', 10, 5, [mv('Double', [2], { hits: 2 }), mv('Claw', [4]), mv('Peck', [3])]), {}, {}, { m0: HALF, m1: HALF }],
    ['aiScore replaces the score', mon('Bully', 10, 5, [mv('Poke', [1], { aiScore: 9 }), mv('Blast', [6]), mv('Jab', [2], { aiScore: 9 })]), {}, {}, { m0: HALF, m2: HALF }],
    ['only moves with PP count', twin, {}, { p2: { pp: [0, 0, 5] } }, { m2: ONE }],
    ['no PP left: Struggle (slot 0)', twin, {}, { p2: { pp: [0, 0, 0] } }, { m0: ONE }],
    ['healthy: Bite (2) beats Mend (0)', healer, potion, {}, { m1: ONE }],
    ['hp 5 of 8: no potion yet', healer, potion, { p2: { hp: 5 } }, { m1: ONE }],
    ['hp 4 of 8: potion', healer, potion, { p2: { hp: 4 } }, { 'i:potion': ONE }],
    ['hp 4 of 8 with an empty bag', healer, {}, { p2: { hp: 4 } }, { m1: ONE }],
    ['hp at the desperation threshold: desperation before the potion', healer, potion, { p2: { hp: 3 } }, { m0: ONE }],
    ['a desperation move without PP does not count', healer, potion, { p2: { hp: 3, pp: [0, 10] } }, { 'i:potion': ONE }],
    ['doze scores 100 against an awake target', sandman, {}, {}, { m0: ONE }],
    ['doze never targets a sleeper', sandman, {}, { p1: { status: 'sleep', sleep: 2 } }, { m1: ONE }],
    ['doze never targets a burned mon', sandman, {}, { p1: { status: 'burn' } }, { m1: ONE }],
    ['a lone doze is still chosen against a statused target', mon('Dozer', 4, 10, [mv('Doze', [], { effect: 'doze' })]), {}, { p1: { status: 'burn' } }, { m0: ONE }],
  ])('support: %s', (_, foe, trainer, edit, expected) => {
    const { ai, state, memory } = start(registry(foe, trainer));
    expect(shown(ai.support(edited(state, edit), memory))).toEqual(expected);
  });

  it('memory records revealed p1 moves, sorted and unique, and changes the choice', () => {
    const { engine, ai, state, memory } = start(aiMemory.registry, aiMemory.p1, aiMemory.trainerId);
    expect([ai.id, memory, shown(ai.support(state, memory))]).toEqual(['toy-ai@1', { key: '[]', data: { revealed: [] } }, { m0: ONE }]);   // Jab
    const [struck] = engine.expandTurn(state, { p1: move(1), p2: move(0) });   // Strike; Watcher's own Jab line is not a p1 reveal
    const afterStrike = ai.remember(memory, struck!);
    expect([afterStrike.key, shown(ai.support(struck!.state, afterStrike))]).toEqual(['["Strike"]', { m0: ONE }]);
    const [roared] = engine.expandTurn(state, M00);   // Roar is tagged scary: Brace from now on
    const afterRoar = ai.remember(memory, roared!);
    expect([afterRoar, shown(ai.support(roared!.state, afterRoar))]).toEqual([{ key: '["Roar"]', data: { revealed: ['Roar'] } }, { m1: ONE }]);
    const [again] = engine.expandTurn(roared!.state, { p1: move(1), p2: move(1) });
    expect([ai.remember(ai.remember(afterRoar, again!), again!).key, memory.key, afterRoar.key]).toEqual(['["Roar","Strike"]', '[]', '["Roar"]']);
  });

  it('replacement support is uniform over the living bench', () => {
    const { engine, ai, state, memory } = start(replacementTie.registry, replacementTie.p1, replacementTie.trainerId);
    const [ko] = engine.expandTurn(state, M00);
    expect([ko!.state.phase.kind, shown(ai.replacementSupport(ko!.state, ai.remember(memory, ko!)))]).toEqual(['enemyReplacement', { s1: HALF, s2: HALF }]);
    // Mouse first; once Mouse faints, Tiger is the only living bench mon.
    const [mouseIn] = engine.expandTurn(ko!.state, { p2: { kind: 'switch', index: 1 } });
    const [mouseKo] = engine.expandTurn(mouseIn!.state, M00);
    expect([mouseKo!.state.phase.kind, shown(ai.replacementSupport(mouseKo!.state, memory))]).toEqual(['enemyReplacement', { s2: ONE }]);
    // An enemy U-turn: the living bench without the (living) active mon.
    const pivot = registry(mon('Pivot', 10, 10, [mv('Volt', [1], { effect: 'uturn' })]));
    pivot.trainers.foe!.party.push(mon('Mouse', 5, 5, [mv('Nibble', [1])]), mon('Rat', 5, 5, [mv('Gnaw', [1])]));
    const u = start(pivot);
    const [paused] = u.engine.expandTurn(u.state, M00);
    expect([paused!.state.phase.kind, shown(u.ai.replacementSupport(paused!.state, u.memory))]).toEqual(['enemyMidTurnSwitch', { s1: HALF, s2: HALF }]);
  });
});
