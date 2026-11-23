import { describe, expect, it } from 'vitest';
import type { Rational } from '../../../../src/contracts/engine.js';
import { ONE, rat, ZERO } from '../../../../src/solver/rational.js';
import { randomToyFight } from './random.js';
import { refCritBudget, refFightOf, refFightOfTable, refMinFailure, refTier1, type RefFight } from './referee.js';
import { aiMemory, ALL_SCENARIOS, deadlyRolls, TABLES, uturnLine } from './scenarios.js';
import type { TableSpec } from './table.js';

type Verdict = [tier1: boolean, failure: Rational, critBudget: number | null];
const verdict = (f: RefFight): Verdict => [refTier1(f), refMinFailure(f), refCritBudget(f)];

/** What the scenario names promise, pinned so an edit to scenarios.ts cannot quietly change them. */
const PINNED: Record<string, Verdict> = {
  safe1v1: [true, ZERO, null], critOnlyBudget0: [false, rat(7, 16), 0], critOnlyBudget1: [false, rat(1, 16), 1],
  deadlyRolls: [false, rat(7, 16), -1], playerMissKills: [false, rat(1, 4), -1],
};

const WIN = { phase: 'win', next: {} } as const;
const DEAD = { phase: 'lose', next: {} } as const;
// The enemy's replacement is AND / expectation; the player's mid-turn switch is OR / min and takes no turn.
const phases: TableSpec = {
  start: 'S',
  nodes: {
    S: { phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to: 'E', p: rat(1, 2) }, { to: 'M', p: rat(1, 2) }] } },
    E: { phase: 'enemyReplacement', ai: [{ name: 'a', p: rat(1, 3) }, { name: 'b', p: rat(2, 3) }], next: { '|a': [{ to: 'dead', p: ONE, faintP1: true }], '|b': [{ to: 'win', p: ONE }] } },
    M: { phase: 'playerMidTurnSwitch', p1: ['bad', 'good'], next: { 'bad|': [{ to: 'dead', p: ONE, faintP1: true }], 'good|': [{ to: 'T', p: ONE }] } },
    T: { phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to: 'win', p: ONE }] } },
    win: WIN, dead: DEAD,
  },
};
// G_j drops critP2 outcomes once j crit steps have happened.
const crits: TableSpec = {
  start: 'A',
  nodes: {
    A: { phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to: 'B', p: rat(3, 4) }, { to: 'B', p: rat(1, 4), critP2: true }] } },
    B: { phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to: 'win', p: rat(3, 4) }, { to: 'dead', p: rat(1, 4), critP2: true, faintP1: true }] } },
    win: WIN, dead: DEAD,
  },
};

describe('referee', () => {
  it.each(ALL_SCENARIOS)("$name: the expected values are the referee's", (s) => {
    const f = refFightOf(s);
    const e = s.expect;
    // Full information: the referee's game is the scenario's. Hidden: the referee sees RAM, so it checks tier1Ram per world.
    if (s.registry.observeAll) expect([...verdict(f), e.tier1Ram]).toEqual([e.tier1, e.failure, e.critBudget, e.tier1]);
    else expect((s.worlds ?? [{ enemy: [] }]).every((w) => refTier1(refFightOf({ ...s, worlds: [w] })))).toBe(e.tier1Ram);
    // `turns` is the shortest tier-1 win: proven at that horizon, not one turn sooner.
    if (e.turns !== undefined) expect([e.turns, e.turns - 1].map((horizon) => refTier1({ ...f, horizon }))).toEqual([true, false]);
    if (PINNED[s.name] !== undefined) expect([e.tier1, e.failure, e.critBudget]).toEqual(PINNED[s.name]);
  });

  it.each<[string, TableSpec, number, Verdict]>([
    ['coinFlip', TABLES.coinFlip, 3, [false, rat(1, 2), -1]],
    ['ghi at 4 turns (T, S, B1, R)', TABLES.ghi, 4, [true, ZERO, null]],
    ['ghi at 3 turns', TABLES.ghi, 3, [false, rat(1, 2), -1]],
    ['deadOrRaw', TABLES.deadOrRaw, 3, [false, rat(1, 2), -1]],
    ['bothDie', TABLES.bothDie, 3, [false, rat(1, 4), -1]],
    ['chain3 at 3 turns', TABLES.chain3, 3, [true, ZERO, null]],
    ['chain3 cut off at 2 turns', TABLES.chain3, 2, [false, ONE, -1]],
    ['phases: 1/2 × 1/3 through E, M picks good', phases, 2, [false, rat(1, 6), -1]],
    ['phases at 1 turn: T is cut off, 1/6 + 1/2', phases, 1, [false, rat(2, 3), -1]],
    ['crits: one crit step is allowed', crits, 2, [false, rat(1, 4), 0]],
  ])('table %s', (_, spec, horizon, expected) => {
    expect(verdict(refFightOfTable(spec, horizon))).toEqual(expected);
  });

  it('horizons, leads and memory folding', () => {
    // deadlyRolls: 7/16 from horizon 2 on; at horizon 1 only Gamble's hit wins in time.
    expect([1, 2, 3, 4].map((horizon) => refMinFailure(refFightOf({ ...deadlyRolls, horizon })))).toEqual([rat(1, 2), rat(7, 16), rat(7, 16), rat(7, 16)]);
    // One input per lead, the lead first and the rest in order; the OR finds Scout even when listed second.
    expect(refFightOf(uturnLine).leads.map((l) => l.player.map((p) => p.nickname))).toEqual([['Scout', 'Tank'], ['Tank', 'Scout']]);
    expect([['Tank', 'Scout'], ['Tank']].map((p1) => refTier1(refFightOf({ ...uturnLine, p1 })))).toEqual([true, false]);
    // With Roar as Hero's only move Watcher Braces from turn 2 and never falls; an unfolded memory would keep Jabbing.
    const roarOnly = { ...aiMemory.registry, mons: { Hero: { name: 'Hero', maxHp: 10, speed: 5, moves: [{ name: 'Roar', damage: [3], tags: ['scary'] }] } } };
    expect(refMinFailure(refFightOf({ ...aiMemory, registry: roarOnly }))).toEqual(ONE);
  });

  it('random fights are deterministic and cover every tier', () => {
    const fights = Array.from({ length: 60 }, (_, i) => randomToyFight(i + 1));
    expect(randomToyFight(7)).toEqual(fights[6]);
    const verdicts = fights.map((f) => verdict(refFightOf(f)));
    // Tier 1 exactly when there is no failure and no crit budget; all three tiers occur, so referee comparisons bite.
    for (const [tier1, failure, budget] of verdicts) expect([budget === null, failure.num === 0n]).toEqual([tier1, tier1]);
    expect(new Set(verdicts.map(([tier1, , budget]) => (tier1 ? 1 : budget === -1 ? 3 : 2)))).toEqual(new Set([1, 2, 3]));
  });
});
