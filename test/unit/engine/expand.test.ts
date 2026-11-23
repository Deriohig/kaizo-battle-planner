import PS from 'pokemon-showdown';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import { createBattle, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { add, ONE, rat, ZERO } from '../../../src/engine/rational.js';
import { EngineError } from '../../../src/engine/types.js';
import { emberRolls, emberTurn, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer, BAG } from './fixtures.js';

const fixture = fixtureDex();
const move = (slot: number): Choice => ({ kind: 'move', slot });
const swap = (index: number): Choice => ({ kind: 'switch', index });
const EMBER = { p1: move(0), p2: move(0) };
/** The code of the `EngineError` `run` throws. */
function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    throw error;
  }
  throw new Error('Expected an EngineError');
}
const foe = (outcome: Outcome) => restore(outcome.state).p2.pokemon[0]!;
const sum = (outcomes: Outcome[], test: (outcome: Outcome) => boolean = () => true) => outcomes.filter(test).reduce((total, outcome) => add(total, outcome.probability), ZERO);

let state: EngineState;
let outcomes: Outcome[];
let stockDraws = -1;

beforeAll(() => {
  installKaizoDex(fixture.data, fixture.moves);
  const stock = vi.spyOn(PS.PRNG.prototype, 'random');
  try {
    state = createBattle(emberTurn());
    outcomes = expandTurn(state, EMBER);
    stockDraws = stock.mock.calls.length;
  } finally {
    stock.mockRestore();
  }
}, 120_000);

describe('expandTurn: Monferno\'s Ember against Zigzagoon', () => {
  it('probabilities sum to one, each above 0; restored battles keep the driver (no stock PRNG draw); maxLeaves limits', () => {
    expect(outcomes.length).toBeGreaterThan(1);
    expect(sum(outcomes)).toEqual(ONE);
    expect(outcomes.every((outcome) => outcome.probability.num > 0n)).toBe(true);
    expect(stockDraws).toBe(0);
    expect(errorCode(() => expandTurn(state, EMBER, { maxLeaves: 1 }))).toBe('LIMIT');
    expect(() => expandTurn(state, EMBER, { maxLeaves: 0 })).toThrow(RangeError);
  });

  it('every damage value appears, crit and not', () => {
    const maxhp = restore(state).p2.pokemon[0]!.maxhp;
    for (const isCrit of [false, true]) {
      const expected = new Set(emberRolls(isCrit).map((damage) => Math.max(0, maxhp - damage)));
      const seen = new Set(outcomes.filter((outcome) => outcome.critBy.p1 === isCrit && foe(outcome).status !== 'brn').map((outcome) => foe(outcome).hp));
      expect([...seen].sort((a, b) => a - b), isCrit ? 'crit' : 'no crit').toEqual([...expected].sort((a, b) => a - b));
    }
  });

  it('merges identical end states: every crit roll knocks out, one outcome with the leaves\' summed probability and one leaf\'s labels', () => {
    // With `collapse: false` each crit damage value is its own leaf, all with one state, crit flag and observation.
    const crits = expandTurn(state, EMBER, { collapse: false }).filter((outcome) => outcome.critBy.p1);
    expect(crits).toHaveLength(1);
    expect(new Set(emberRolls(true)).size).toBeGreaterThan(1);
    expect([foe(crits[0]!).hp, crits[0]!.merged, crits[0]!.probability, crits[0]!.labels.map((label) => label.kind)])
      .toEqual([0, new Set(emberRolls(true)).size, rat(1, 16), ['crit', 'roll']]);
    // Outcomes that differ stay apart.
    expect(new Set(outcomes.map((outcome) => `${outcome.state.key}|${outcome.critBy.p1}|${outcome.observation}`)).size).toBe(outcomes.length);
  });

  it('outcomes carry crits, faints, labels and the omniscient log', () => {
    for (const outcome of outcomes) {
      expect(outcome.unlabelled).toBe(false);
      // The crit, the roll, then the burn (a knocked-out Zigzagoon draws none; every crit knocks out, so its roll is one option).
      expect(outcome.labels.map((label) => label.kind)).toEqual(outcome.critBy.p1 ? ['crit'] : ['crit', 'roll', 'effect']);
      expect(outcome.labels.every((label) => label.side === 'p1' && label.source === 'ember')).toBe(true);
      expect(outcome.critBy.p2).toBe(false);
      expect(outcome.log).toContain('|move|p1a: Monferno|Ember|p2a: Zigzagoon');
      expect(outcome.log.some((line) => line.startsWith('|split|') || line.startsWith('|t:|'))).toBe(false);
      expect(outcome.log.includes('|-crit|p2a: Zigzagoon')).toBe(outcome.critBy.p1);
      const hp = foe(outcome).hp;
      expect(outcome.log.some((line) => line.startsWith(`|-damage|p2a: Zigzagoon|${hp === 0 ? '0 fnt' : `${hp}/`}`))).toBe(true);
      expect([outcome.fainted, outcome.state.phase, ...(hp === 0 ? [] : [outcome.state.turn])])
        .toEqual(hp === 0 ? [{ p1: [], p2: [0] }, { kind: 'terminal', winner: 'p1' }] : [{ p1: [], p2: [] }, { kind: 'turnChoice' }, 2]);
    }
    expect([outcomes.some((outcome) => outcome.critBy.p1), outcomes.some((outcome) => foe(outcome).status === 'brn')]).toEqual([true, true]);
  });

  it('the phase decides which choices a step takes', () => {
    const mid = runFirstOutcome(createBattle({
      player: [playerMon(ID.monferno, 30, [ID.uTurn]), playerMon(ID.zigzagoon, 30, [ID.tackle])], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.bidoof, 30, [ID.tackle])]), field: {},
    }), EMBER);
    expect(mid.phase).toEqual({ kind: 'playerMidTurnSwitch' });
    const won = outcomes.find((outcome) => outcome.state.phase.kind === 'terminal')!.state;
    expect([[state, { p1: move(0) }], [state, { p2: move(0) }], [mid, { p1: swap(1), p2: move(0) }], [mid, { p2: move(0) }], [won, { p1: move(0) }], [won, {}]]
      .map(([from, choices]) => errorCode(() => expandTurn(from as EngineState, choices as { p1?: Choice; p2?: Choice })))).toEqual(Array(6).fill('BAD_CHOICE'));
    expect(expandTurn(mid, { p1: swap(1) }).every((outcome) => outcome.state.phase.kind === 'turnChoice')).toBe(true);
  });

  it('at a player replacement: p1 alone, or both sides when both fainted (as Showdown waits on both)', () => {
    const alone = runFirstOutcome(createBattle({
      player: [playerMon(ID.zigzagoon, 5, [ID.tackle]), playerMon(ID.monferno, 5, [ID.tackle])], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.deoxys, 50, [ID.waterBall])]), field: {},
    }), EMBER);
    expect(alone.phase).toEqual({ kind: 'playerReplacement' });
    expect([{ p1: swap(1), p2: move(0) }, { p1: swap(1), p2: swap(0) }, { p2: move(0) }].map((choices) => errorCode(() => expandTurn(alone, choices)))).toEqual(Array(3).fill('BAD_CHOICE'));
    expect(expandTurn(alone, { p1: swap(1) }).map((outcome) => outcome.state.phase)).toEqual([{ kind: 'turnChoice' }]);
    // Monferno's Tackle knocks the foe out, then poison knocks Monferno out: still playerReplacement, both replace.
    const low = restore(createBattle({
      player: [playerMon(ID.monferno, 30, [ID.tackle], { currentHp: 1, status: { kind: 'poison' } }), playerMon(ID.zigzagoon, 30, [ID.tackle])],
      trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.tackle]), resolvedMon(ID.zigzagoon, 20, [ID.tackle])]), field: {},
    }));
    low.p2.active[0]!.hp = 1;
    const both = runFirstOutcome(snapshot(low), EMBER);
    expect(both.phase).toEqual({ kind: 'playerReplacement' });
    expect([{ p1: swap(1) }, { p2: swap(1) }].map((choices) => errorCode(() => expandTurn(both, choices)))).toEqual(['BAD_CHOICE', 'BAD_CHOICE']);
    const next = expandTurn(both, { p1: swap(1), p2: swap(1) });
    expect(next).toHaveLength(1);
    const battle = restore(next[0]!.state);
    expect([next[0]!.state.phase, battle.turn, battle.p1.active[0]!.species.id, battle.p2.active[0]!.name]).toEqual([{ kind: 'turnChoice' }, 2, 'zigzagoon', 'Zigzagoon 2']);
  });

  it('a step where both sides draw: crits 1/16 each and jointly 1/256, and every pair of HP each side can be left on', () => {
    const results = expandTurn(createBattle(emberTurn([ID.tackle])), { p1: move(1), p2: move(0) }); // Tackle against Tackle: no knock-out
    expect([sum(results), sum(results, (o) => o.critBy.p1), sum(results, (o) => o.critBy.p2), sum(results, (o) => o.critBy.p1 && o.critBy.p2)])
      .toEqual([ONE, rat(1, 16), rat(1, 16), rat(1, 256)]);
    const pairs = new Set<string>();
    for (const outcome of results) {
      const battle = restore(outcome.state);
      const [mine, theirs] = [battle.p1.active[0]!, battle.p2.active[0]!];
      expect([mine.hp < mine.maxhp, theirs.hp < theirs.maxhp, outcome.log.includes('|-crit|p1a: Monferno'), outcome.log.includes('|-crit|p2a: Zigzagoon')])
        .toEqual([true, true, outcome.critBy.p2, outcome.critBy.p1]);
      pairs.add(`${mine.hp}/${theirs.hp}`);
    }
    const sides = [0, 1].map((i) => new Set([...pairs].map((pair) => pair.split('/')[i])));
    expect(sides.every((values) => values.size > 1)).toBe(true);
    expect(pairs.size).toBe(sides[0]!.size * sides[1]!.size);
  });

  it('a replay that meets different chance points throws: a draw that changes size, or one the replay no longer makes', () => {
    const calm = createBattle({ ...emberTurn(), player: [playerMon(ID.monferno, 30, [ID.meanLook])] }); // no chance of its own
    const endTurn = PS.Battle.prototype.endTurn;
    for (const draw of [(runs: number, battle: Battle) => battle.random(2 + runs), (runs: number, battle: Battle) => { if (runs === 0) battle.random(2); }]) {
      let runs = 0;
      const spy = vi.spyOn(PS.Battle.prototype, 'endTurn').mockImplementation(function (this: Battle) {
        draw(runs++, this);
        endTurn.call(this);
      });
      try {
        expect(() => expandTurn(calm, EMBER)).toThrow(/replayed differently at chance point 0/);
      } finally {
        spy.mockRestore();
      }
    }
  });
});
