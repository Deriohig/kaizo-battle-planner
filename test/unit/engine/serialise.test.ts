// One serialisation per leaf: the snapshot's JSON and key are byte for byte what `JSON.stringify` and `serializedKey`
// give, and a restore from a state parsed once is the restore of the state's JSON.

import { beforeAll, describe, expect, it } from 'vitest';
import type { Choice, EngineState } from '../../../src/contracts/engine.js';
import { applyChoices, createBattle, restore, restoreShared, sharedState, snapshot } from '../../../src/engine/battle.js';
import { ChanceDriver, nextScript } from '../../../src/engine/chance.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { serializedKey, serializedState, stateKey } from '../../../src/engine/key.js';
import { emberTurn, fixtureDex } from './fixtures.js';
import { sixes } from './peekSeedCorpus.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH_FIRST = { p1: move(0), p2: move(0) };

/** Up to `limit` leaves of the step from `state`: each leaf's battle after the step, and its driver. */
function leavesOf(state: EngineState, choices: { p1?: Choice; p2?: Choice }, limit: number): Battle[] {
  const battles: Battle[] = [];
  for (let script: number[] | null = []; script !== null && battles.length < limit;) {
    const driver = new ChanceDriver(script);
    const battle = restore(state, driver);
    applyChoices(battle, choices);
    battles.push(battle);
    script = nextScript(driver.points);
  }
  return battles;
}

describe('one serialisation per leaf', () => {
  it('the snapshot\'s JSON and key are JSON.stringify\'s and serializedKey\'s, byte for byte, on every leaf', () => {
    const turns: [EngineState, { p1?: Choice; p2?: Choice }][] = [
      [createBattle(emberTurn()), BOTH_FIRST], [createBattle(sixes()), { p1: move(3), p2: move(1) }],
      [createBattle(sixes()), { p1: { kind: 'switch', index: 2 }, p2: move(0) }],
    ];
    let checked = 0;
    for (const [state, choices] of turns) {
      for (const battle of leavesOf(state, choices, 60)) {
        const after = snapshot(battle);
        expect(after.json).toBe(JSON.stringify(battle.toJSON()));
        expect(after.key).toBe(stateKey(battle));
        expect(after.key).toBe(serializedKey(JSON.parse(after.json)));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(60);
  }, 60_000);

  it('a Pokémon\'s canonical JSON is looked up by its text: two equal texts, two equal keys', () => {
    // The same battle serialised twice: the second key comes from the Pokémon already seen, and is the same.
    const battle = restore(createBattle(sixes()));
    const first = serializedState(battle.toJSON());
    const second = serializedState(battle.toJSON());
    expect(second.json).toBe(first.json);
    expect(second.key()).toBe(first.key());
    battle.p2.pokemon[3]!.hp -= 1; // a benched Pokémon: only its own text changes
    expect(serializedState(battle.toJSON()).key()).toBe(stateKey(battle));
    expect(stateKey(battle)).not.toBe(first.key());
  });

  it('a restore from the state parsed once is the restore of its JSON, and leaves the parsed state as it was', () => {
    const state = createBattle(sixes());
    const shared = sharedState(state);
    expect(Object.isFrozen(shared.parsed)).toBe(true);
    for (let script: number[] | null = [], runs = 0; script !== null && runs < 30; runs++) {
      const [mine, theirs] = [new ChanceDriver(script), new ChanceDriver(script)];
      const fromText = restore(state, mine);
      const fromShared = restoreShared(shared, theirs);
      expect(JSON.stringify(fromShared.toJSON())).toBe(JSON.stringify(fromText.toJSON()));
      applyChoices(fromText, { p1: move(3), p2: move(0) });
      applyChoices(fromShared, { p1: move(3), p2: move(0) });
      // The same snapshot, but for the wall-clock `|t:|` line, which can tick between the two.
      const untimed = (after: EngineState) => ({ ...after, json: after.json.replace(/\|t:\|\d+/g, '|t:|') });
      expect(untimed(snapshot(fromShared))).toEqual(untimed(snapshot(fromText)));
      expect(theirs.points).toEqual(mine.points);
      script = nextScript(mine.points);
    }
    expect(JSON.stringify(shared.parsed)).toBe(state.json);
  }, 60_000);

  it('expandTurn gives the outcomes it gave with a restore per leaf from the JSON', () => {
    // Each leaf restored from the state's JSON, snapshotted with JSON.stringify and serializedKey, gives the engine's
    // outcomes: the same states, keys and JSON.
    const state = createBattle(sixes());
    const choices: { p1: Choice; p2: Choice } = { p1: move(0), p2: move(0) }; // Tackle against Tackle
    const outcomes = expandTurn(state, choices, { collapse: false });
    const reference = new Map<string, string>();
    for (const battle of leavesOf(state, choices, 100_000)) {
      snapshot(battle); // folds the reveals in, as the engine's snapshot does
      const serialized = battle.toJSON();
      const json = JSON.stringify(serialized);
      reference.set(serializedKey(serialized), json);
    }
    expect(new Set(outcomes.map((outcome) => outcome.state.key))).toEqual(new Set(reference.keys()));
    expect(outcomes.reduce((total, outcome) => total + outcome.merged, 0)).toBeGreaterThan(20);
    for (const outcome of outcomes) {
      const json = reference.get(outcome.state.key)!;
      // One leaf's JSON: equal up to the log fields the key leaves out, which can differ between merged leaves.
      const strip = (text: string) => ({ ...JSON.parse(text), log: [], inputLog: [], sentLogPos: 0, lastMoveLine: 0, hints: [] });
      expect(strip(outcome.state.json)).toEqual(strip(json));
    }
  }, 60_000);
});
