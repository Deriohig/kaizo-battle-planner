// `expandTurn`'s stop poll: `shouldStop` is polled on entry (before any work), before every leaf, and every
// `STOP_POLL_OUTCOMES` (16) outcomes in the sum after the last leaf; true throws `STOPPED`. The stops count polls, never
// time, and the expected poll counts are literals, so a change to where or how often the engine polls fails here.

import { beforeAll, describe, expect, it } from 'vitest';
import type { BattleInput, Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import { createBattle } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn, STOP_POLL_OUTCOMES } from '../../../src/engine/expand.js';
import { carryOut, hpOf, legalChoices } from '../../../src/engine/facts.js';
import { LEAF_PHASES, startLeafProfile, stopLeafProfile } from '../../../src/engine/profile.js';
import { EngineError } from '../../../src/engine/types.js';
import { ABILITY, BAG, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
const move = (slot: number): Choice => ({ kind: 'move', slot });
const FIRST = { p1: move(0), p2: move(0) };
const TACKLE = { p1: move(1), p2: move(0) };

/** Fury Attack on a Battle Armor Deoxys: 60 leaves, 28 outcomes (one poll in the sum, before the 17th). */
const furyAttack = (): BattleInput => ({
  player: [playerMon(ID.zigzagoon, 5, [ID.furyAttack])], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.deoxys, 50, [ID.meanLook])]), field: {},
  world: { enemy: [{ ability: ABILITY.battleArmor }] },
});
/** A L100 Monferno's Ember on a L100 Zigzagoon: 52 leaves and 52 outcomes (3 polls in the sum); Tackle: 25 and 25. */
const emberWide = (): BattleInput => ({
  player: [playerMon(ID.monferno, 100, [ID.ember, ID.tackle])], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 100, [ID.meanLook])]), field: {},
});

/** What `run` throws (anything), or a failure if it returns. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected a throw');
}
const code = (run: () => unknown): string => {
  const error = thrownBy(run);
  if (error instanceof EngineError) return error.code;
  throw error;
};
/** A `shouldStop` that says no to its first `k` polls and stop from then on, and counts every poll. */
function stopAfter(k: number): { shouldStop: () => boolean; polls: () => number } {
  let count = 0;
  return { shouldStop: () => ++count > k, polls: () => count };
}
/** `run`'s error code and how many leaves ran before it (the opt-in leaf profile). */
function stoppedAfter(run: () => unknown): { code: string; leaves: number } {
  startLeafProfile();
  try {
    return { code: code(run), leaves: stopLeafProfile().leaves };
  } finally {
    stopLeafProfile();
  }
}
const leavesOf = (outcomes: readonly Outcome[]) => outcomes.reduce((total, outcome) => total + outcome.merged, 0);

let state: EngineState;
let full: Outcome[];
let wide: EngineState;
let wideFull: Outcome[];
let tackleFull: Outcome[];

beforeAll(() => {
  installKaizoDex(fixture.data, fixture.moves);
  state = createBattle(furyAttack());
  full = expandTurn(state, FIRST);
  wide = createBattle(emberWide());
  wideFull = expandTurn(wide, FIRST);
  tackleFull = expandTurn(wide, TACKLE);
}, 120_000);

describe('expandTurn stops when shouldStop says so', () => {
  it('has the turns the tests need: 60 leaves and 28 outcomes; 52 and 52; 25 and 25', () => {
    expect([full, wideFull, tackleFull].map((outcomes) => [leavesOf(outcomes), outcomes.length])).toEqual([[60, 28], [52, 52], [25, 25]]);
    expect(STOP_POLL_OUTCOMES).toBe(16);
  });

  it('throws STOPPED on entry, before any work and any check of its arguments', () => {
    const stop = stopAfter(0);
    startLeafProfile();
    const stopped = code(() => expandTurn(state, FIRST, { shouldStop: stop.shouldStop }));
    const profile = stopLeafProfile();
    expect([stopped, stop.polls(), profile.leaves]).toEqual(['STOPPED', 1, 0]);
    for (const phase of LEAF_PHASES) expect(profile.ms[phase], phase).toBe(0);
    // A battle whose JSON does not parse, a missing choice and a bad maxLeaves: still STOPPED, a stop masks them.
    const broken: EngineState = { ...state, json: 'not JSON', phase: { kind: 'terminal', winner: 'p1' } };
    const always = { shouldStop: () => true };
    expect([code(() => expandTurn(broken, FIRST, always)), code(() => expandTurn(state, { p1: move(0) }, always)), code(() => expandTurn(state, FIRST, { maxLeaves: 0, ...always }))])
      .toEqual(['STOPPED', 'STOPPED', 'STOPPED']);
  });

  // Poll 1 is on entry and poll i + 1 before leaf i: a stop after k polls runs k - 1 leaves; past the last leaf the polls
  // come in the sum (Fury Attack: one before outcome 17; Ember: before 17, 33 and 49).
  it.each<[string, () => EngineState, number, number, number]>([
    ['Fury Attack, k = 1', () => state, 1, 0, 2], ['Fury Attack, k = 2', () => state, 2, 1, 3], ['Fury Attack, k = 25', () => state, 25, 24, 26],
    ['Fury Attack, k = 60', () => state, 60, 59, 61], ['Fury Attack, in the sum', () => state, 61, 60, 62],
    ['Ember, 1st poll in the sum', () => wide, 53, 52, 54], ['Ember, 2nd poll in the sum', () => wide, 54, 52, 55], ['Ember, 3rd poll in the sum', () => wide, 55, 52, 56],
  ])('%s: STOPPED after its leaves, and no more polls', (_, start, k, leaves, polls) => {
    const stop = stopAfter(k);
    expect(stoppedAfter(() => expandTurn(start(), FIRST, { shouldStop: stop.shouldStop }))).toEqual({ code: 'STOPPED', leaves });
    expect(stop.polls()).toBe(polls);
  });

  it('changes nothing when shouldStop never says stop, or says something truthy that is not true', () => {
    for (const [start, reference, polls] of [[state, full, 62], [wide, wideFull, 56]] as const) {
      const never = stopAfter(Infinity);
      expect(expandTurn(start, FIRST, { shouldStop: never.shouldStop })).toStrictEqual(reference);
      expect(never.polls()).toBe(polls);
    }
    for (const value of [1, 'stop', Promise.resolve(true)]) expect(expandTurn(state, FIRST, { shouldStop: () => value as unknown as boolean })).toStrictEqual(full);
  });

  it('lets an error shouldStop throws out as it is, on entry, before a leaf or in the sum', () => {
    for (const k of [0, 10, 61]) {
      const broke = new Error(`the deadline clock broke at poll ${k + 1}`);
      let polls = 0;
      const shouldStop = (): boolean => {
        if (polls++ >= k) throw broke;
        return false;
      };
      expect([thrownBy(() => expandTurn(state, FIRST, { shouldStop })), polls]).toEqual([broke, k + 1]);
    }
  });

  it('leaves nothing behind: after stopped calls the same call gives the full result, and its states read as the first run\'s', () => {
    for (const k of [1, 30, 60, 61]) expect(code(() => expandTurn(state, FIRST, { shouldStop: stopAfter(k).shouldStop }))).toBe('STOPPED');
    const rerun = expandTurn(state, FIRST);
    expect(rerun).toStrictEqual(full);
    rerun.forEach((outcome, i) => {
      const first = full[i]!.state;
      expect([carryOut(outcome.state), hpOf(outcome.state), legalChoices(outcome.state, 'p1'), legalChoices(outcome.state, 'p2')])
        .toStrictEqual([carryOut(first), hpOf(first), legalChoices(first, 'p1'), legalChoices(first, 'p2')]);
    });
  });

  it('caches nothing a later call sees: after a stop, another limit and another choice give their own answers', () => {
    for (const input of [wide, createBattle(emberWide())]) {
      for (const k of [30, 54]) {
        expect([code(() => expandTurn(input, FIRST, { shouldStop: stopAfter(k).shouldStop })), code(() => expandTurn(input, FIRST, { maxLeaves: 10 }))]).toEqual(['STOPPED', 'LIMIT']);
        expect(expandTurn(input, TACKLE)).toStrictEqual(tackleFull);
      }
      expect(expandTurn(input, FIRST)).toStrictEqual(wideFull);
    }
  });

  it('the opt-in leaf profile times every leaf in each phase while on, records nothing when off, and changes no outcome', () => {
    const plain = expandTurn(wide, FIRST);
    startLeafProfile();
    const timed = expandTurn(wide, FIRST);
    const profile = stopLeafProfile();
    expect(profile.leaves).toBe(leavesOf(timed));
    for (const phase of LEAF_PHASES) expect(profile.ms[phase], phase).toBeGreaterThanOrEqual(0);
    for (const phase of ['restore', 'step', 'snapshot', 'key'] as const) expect(profile.ms[phase], phase).toBeGreaterThan(0);
    expect(timed.map((outcome) => [outcome.state.key, outcome.probability, outcome.merged])).toEqual(plain.map((outcome) => [outcome.state.key, outcome.probability, outcome.merged]));
    expandTurn(wide, FIRST);
    const off = stopLeafProfile(); // stopping twice: an empty profile
    expect(off.leaves).toBe(0);
    for (const phase of LEAF_PHASES) expect(off.ms[phase], phase).toBe(0);
  });

  it('keeps LIMIT and STOPPED apart: the limit first, a stop at the leaf past the limit, the stop first, a turn exactly at the limit', () => {
    for (const [k, expected, polls] of [[30, 'LIMIT', 11], [11, 'LIMIT', 11], [5, 'STOPPED', 6]] as const) {
      const stop = stopAfter(k);
      expect([code(() => expandTurn(state, FIRST, { maxLeaves: 10, shouldStop: stop.shouldStop })), stop.polls()]).toEqual([expected, polls]);
    }
    expect(expandTurn(state, FIRST, { maxLeaves: 60, shouldStop: stopAfter(Infinity).shouldStop })).toStrictEqual(full);
  });
});
