import { describe, expect, it } from 'vitest';
import type { Choice } from '../../../../src/contracts/engine.js';
import { ONE, rat } from '../../../../src/solver/rational.js';
import { choiceKey } from './helpers.js';
import { TABLES } from './scenarios.js';
import { tableGame, type TableSpec } from './table.js';

const move = (slot: number): Choice => ({ kind: 'move', slot });
const HALF = rat(1, 2);

describe('table games', () => {
  it('choices, AI support, pick labels and flags; turns count turn choices only', () => {
    // The AI's support comes in `ai` order; without `ai` the AI has one dummy choice.
    const coin = tableGame(TABLES.coinFlip);
    const r = coin.engine.createBattle(coin.input);
    expect([coin.engine.id, coin.ai.id, r.turn, coin.engine.unmodelledIn(r), coin.engine.legalChoices(r, 'p1').map(choiceKey)]).toEqual(['table-engine@1', 'table-ai@1', 1, [], ['m0', 'm1']]);
    expect(coin.ai.support(r, coin.ai.initialMemory(r))).toEqual([{ choice: move(0), probability: HALF }, { choice: move(1), probability: HALF }]);
    const chain = tableGame(TABLES.chain3);
    const c = chain.engine.createBattle(chain.input);
    expect(chain.ai.support(c, chain.ai.initialMemory(c))).toEqual([{ choice: move(0), probability: ONE }]);

    const flags = tableGame({
      start: 'S',
      nodes: {
        S: { phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to: 'M', p: HALF, critP2: true }, { to: 'E', p: HALF, unlabelled: true }] } },
        M: { phase: 'playerMidTurnSwitch', p1: ['swap'], next: { 'swap|': [{ to: 'win', p: ONE }] } },
        E: { phase: 'enemyReplacement', ai: [{ name: 'a', p: rat(1, 3) }, { name: 'b', p: rat(2, 3) }], next: { '|a': [{ to: 'win', p: ONE }], '|b': [{ to: 'win', p: ONE }] } },
        win: { phase: 'win', next: {} },
      },
    });
    const s = flags.engine.createBattle(flags.input);
    const [toM, toE] = flags.engine.expandTurn(s, { p1: move(0), p2: move(0) });
    const pick = (to: string) => [{ kind: 'pick', side: null, source: 'S', outcome: `to=${to}` }];
    expect([toM, toE].map((o) => [o!.critBy, o!.unlabelled, o!.labels, o!.state.phase, o!.state.turn])).toEqual([
      [{ p1: false, p2: true }, false, pick('M'), { kind: 'playerMidTurnSwitch' }, 2],
      [{ p1: false, p2: false }, true, pick('E'), { kind: 'enemyReplacement' }, 2],
    ]);
    expect([flags.engine.legalChoices(toE!.state, 'p1'), flags.engine.legalChoices(toM!.state, 'p2')]).toEqual([[], []]);
    expect(flags.ai.replacementSupport(toE!.state, flags.ai.initialMemory(toE!.state)).map((a) => a.probability)).toEqual([rat(1, 3), rat(2, 3)]);
    const [won] = flags.engine.expandTurn(toM!.state, { p1: move(0) });
    expect([won!.state.phase, won!.state.turn, won!.labels, flags.engine.legalChoices(won!.state, 'p1')]).toEqual([{ kind: 'terminal', winner: 'p1' }, 2, [], []]);
    expect(() => flags.engine.expandTurn(won!.state, {})).toThrow();
    expect(() => flags.engine.expandTurn(s, { p1: move(1), p2: move(0) })).toThrow();
  });

  it('faintP1 marks a death in the outcome and the carry', () => {
    const { engine, input } = tableGame(TABLES.coinFlip);
    const root = engine.createBattle(input);
    const carry = (hp: number) => ({ mons: [{ hp, pp: [], status: { kind: 'none' } }] });
    const [dead] = engine.expandTurn(root, { p1: move(0), p2: move(1) });   // A|Y
    const [won] = engine.expandTurn(root, { p1: move(0), p2: move(0) });    // A|X
    expect([root, dead!.state, won!.state].map((st) => engine.carryOut(st))).toEqual([carry(1), carry(0), carry(1)]);
    expect([dead, won].map((o) => [o!.fainted, o!.state.phase])).toEqual([
      [{ p1: [0], p2: [] }, { kind: 'terminal', winner: 'p2' }],
      [{ p1: [], p2: [] }, { kind: 'terminal', winner: 'p1' }],
    ]);
  });

  it('keyOf merges states; observations are the state names unless `obs` says otherwise', () => {
    const nodes: TableSpec['nodes'] = {
      A1: { phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to: 'A2', p: ONE }] } },
      A2: { phase: 'turnChoice', p1: ['go'], obs: 'seen A2', next: { 'go|': [{ to: 'win', p: ONE }] } },
      win: { phase: 'win', next: {} },
    };
    const run = (keyOf?: TableSpec['keyOf']) => {
      const { engine, input } = tableGame({ start: 'A1', nodes, ...(keyOf ? { keyOf } : {}) });
      const first = engine.createBattle(input);
      const [next] = engine.expandTurn(first, { p1: move(0), p2: move(0) });
      return { engine, first, next: next! };
    };
    const plain = run();
    const merged = run((name) => (name.startsWith('A') ? 'A' : name));
    expect([plain.first.key, plain.next.state.key, merged.first.key, merged.next.state.key, merged.first.json === merged.next.state.json]).toEqual(['A1', 'A2', 'A', 'A', false]);
    expect([merged.engine.observe(merged.first), merged.next.observation, merged.engine.observe(merged.next.state)]).toEqual(['A1', 'seen A2', 'seen A2']);
  });
});
