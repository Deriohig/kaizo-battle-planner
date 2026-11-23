import PS from 'pokemon-showdown';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Choice, EngineState } from '../../../src/contracts/engine.js';
import { applyChoices, BATTLE_START_CHANCE_NOTE, createBattle, restore, snapshot } from '../../../src/engine/battle.js';
import { ChanceDriver, type ChancePoint } from '../../../src/engine/chance.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { unmodelledIn } from '../../../src/engine/index.js';
import { ONE, rat } from '../../../src/engine/rational.js';
import { unmodelledNotes } from '../../../src/engine/unmodelled.js';
import { ABILITY, BAG, emberTurn, fixtureDex, ID, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH_FIRST = { p1: move(0), p2: move(0) };
/** Runs `choices` from `state` with `script` forced: the end state and every chance point on the way. */
function run(state: EngineState, choices: { p1?: Choice; p2?: Choice }, script: number[]) {
  const driver = new ChanceDriver(script);
  const battle = restore(state, driver);
  applyChoices(battle, choices);
  return { state: snapshot(battle), points: driver.points };
}
const weights = (point: ChancePoint) => point.options.map((option) => option.weight);

describe('the chance driver', () => {
  it('a forced script replays deterministically; past it each point takes its first possible option; an impossible option throws', () => {
    const state = createBattle(emberTurn());
    const first = run(state, BOTH_FIRST, []);
    expect(first.points.length).toBeGreaterThan(0);
    expect(first.points.every((point) => point.chosen === point.options.findIndex((option) => option.weight > 0n))).toBe(true);
    const script = [first.points[0]!.options.findLastIndex((option) => option.weight > 0n)];
    const [a, b] = [run(state, BOTH_FIRST, script), run(state, BOTH_FIRST, script)];
    expect([a.points[0]!.chosen, a.state.key]).toEqual([script[0], b.state.key]);
    expect(a.points.map((point) => [point.chosen, ...weights(point)])).toEqual(b.points.map((point) => [point.chosen, ...weights(point)]));
    expect(a.state.key).not.toBe(first.state.key);
    expect(() => run(state, BOTH_FIRST, [999])).toThrow(/option/);
  });

  it('a chance at battle start is recorded as unmodelled only when its outcomes differ', () => {
    // Equal Speed: the tied leads come in either order; with no switch-in effects both orders reach one state.
    const mirror = (p1Ability?: number, p2Ability?: number) => createBattle({
      player: [playerMon(ID.monferno, 30, [ID.tackle], p1Ability === undefined ? {} : { ability: knownAbility(p1Ability) })],
      trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.monferno, 30, [ID.tackle], p2Ability === undefined ? {} : { ability: knownAbility(p2Ability) })]), field: {},
    });
    expect([unmodelledNotes(restore(mirror())), unmodelledNotes(restore(createBattle(emberTurn())))]).toEqual([[], []]); // the second: different Speeds
    // Drought against Drizzle: the weather is the second lead's. The start takes its first outcome (rain) and is noted.
    const war = mirror(ABILITY.drought, ABILITY.drizzle);
    expect([unmodelledNotes(restore(war)), unmodelledIn(war).includes(BATTLE_START_CHANCE_NOTE), restore(war).field.weather]).toEqual([[BATTLE_START_CHANCE_NOTE], true, 'raindance']);
  });

  it('raw calls are enumerated and flagged: random, randomChance, sample and shuffle draw through the driver; a sure draw records nothing', () => {
    const state = createBattle(emberTurn());
    const driver = new ChanceDriver([]);
    expect(restore(state, driver).random(3)).toBe(0);
    expect(driver.points).toHaveLength(1);
    expect(driver.points[0]).toMatchObject({ kind: 'raw', side: null, chosen: 0 });
    expect(weights(driver.points[0]!)).toEqual([1n, 1n, 1n]);
    expect([restore(state, new ChanceDriver([2])).random(3), restore(state, new ChanceDriver([1])).random(5, 8)]).toEqual([2, 6]);
    // randomChance(a, b) weighs true against false a : b - a.
    const other = new ChanceDriver([]);
    const more = restore(state, other);
    expect([more.randomChance(1, 4), more.randomChance(100, 100), more.randomChance(0, 100), more.random(1), more.sample(['x', 'y'])]).toEqual([true, true, false, 0, 'x']);
    more.prng.shuffle([1, 2, 3]);
    expect(other.points.map(weights)).toEqual([[1n, 3n], [1n, 1n], [1n, 1n, 1n], [1n, 1n]]);
    expect(() => more.random()).toThrow(/real/);
  });

  it('a turn without chance has one outcome; a random(3) drawn at its end gives three, each a third, each flagged raw', () => {
    const calm = createBattle({ ...emberTurn(), player: [playerMon(ID.monferno, 30, [ID.meanLook])] });
    const plain = expandTurn(calm, BOTH_FIRST);
    expect(plain).toHaveLength(1);
    expect(plain[0]).toMatchObject({ probability: ONE, labels: [], unlabelled: false, merged: 1 });
    const endTurn = PS.Battle.prototype.endTurn;
    const spy = vi.spyOn(PS.Battle.prototype, 'endTurn').mockImplementation(function (this: Battle) {
      this.add('-message', `Drew ${this.random(3)}`);
      endTurn.call(this);
    });
    try {
      const outcomes = expandTurn(calm, BOTH_FIRST);
      expect(outcomes).toHaveLength(3);
      outcomes.forEach((outcome, value) => {
        expect([outcome.probability, outcome.unlabelled, outcome.labels]).toEqual([rat(1, 3), true, [{ kind: 'raw', side: null, source: 'random(0, 3)', outcome: `${value}` }]]);
        expect(outcome.log).toContain(`|-message|Drew ${value}`);
      });
    } finally {
      spy.mockRestore();
    }
  });
});
