import { describe, expect, it } from 'vitest';
import type { MonRef, Progress, SolveRequest, Verdict } from '../../../src/contracts/solver.js';
import { resolveConfig } from '../../../src/solver/config.js';
import { createSolver } from '../../../src/solver/index.js';
import { rat } from '../../../src/solver/rational.js';
import { solveFights, type Tier1Control } from '../../../src/solver/solve.js';
import { completeDisproof, NoGoods, teamCandidates, teamCount } from '../../../src/solver/team.js';
import type { BattleResolver, DamageOracle, SolverDeps } from '../../../src/solver/types.js';
import { toyDeps, toyResolver } from './toy/deps.js';
import { readToyState } from './toy/engine.js';
import { scenarioFights, tableFights } from './toy/fixtures.js';
import type { ToyMon } from './toy/game.js';
import { toyOracles } from './toy/oracles.js';
import { safe1v1, TABLES, teamPool, type Scenario } from './toy/scenarios.js';
import { tableGame, type TableSpec } from './toy/table.js';

interface Steer { mustBring?: MonRef[]; preferred?: MonRef[] }
interface SolveOpts { deps?: Partial<SolverDeps>; onProgress?: (p: Progress) => void }

/** A team search over `pool` with teams of up to `maxSize`, against the scenario's trainer at its horizon. */
function request(s: Scenario, pool: MonRef[], maxSize: number, steer: Steer = {}, over: Partial<SolveRequest> = {}): SolveRequest {
  return {
    fights: [{ trainerId: s.trainerId }], team: { kind: 'search', pool, maxSize, ...steer }, preStatus: 'given',
    budgetMs: 600_000, horizonTurns: s.horizon, attemptAnyLegalBadge: false, ranking: [], ...over,
  };
}

/** The player's `mons` against one `foe`, full information. */
function pool(name: string, mons: ToyMon[], foe: ToyMon, horizon: number): Scenario {
  return { name, p1: mons.map((m) => m.name), trainerId: name, horizon, expect: {}, registry: { observeAll: true, mons: Object.fromEntries(mons.map((m) => [m.name, m])), trainers: { [name]: { id: name, party: [foe] } } } };
}

/** The toy resolver for `s`, with the mons `refs` at 0 HP in the save. */
function faintedAt(s: Scenario, refs: MonRef[]): BattleResolver {
  const base = toyResolver(s);
  return { ...base, mon: (ref) => (refs.includes(ref) ? { ...base.mon(ref), mon: { ...base.mon(ref).mon, currentHp: 0 } } : base.mon(ref)) };
}

/** A fake clock that jumps to `to` at the first progress message starting with `at`. */
function jumpAt(at: string, to: number): SolveOpts & { jumped: () => boolean } {
  let clock = 0;
  return {
    deps: { now: () => clock, config: { progressIntervalMs: 0 } },
    onProgress: (p) => {
      if (clock === 0 && p.message.startsWith(at)) clock = to;
    },
    jumped: () => clock === to,
  };
}

const has = (ref: MonRef) => (team: MonRef[]): number => (team.includes(ref) ? 1 : 0);
/** 'ab ac' is [['a', 'b'], ['a', 'c']]. */
const teams = (s: string): MonRef[][] => (s === '' ? [] : s.split(' ').map((team) => [...team]));

function solve(s: Scenario, req: SolveRequest, opts: SolveOpts = {}): Promise<Verdict> {
  return createSolver(toyDeps(s, opts.deps)).solve(req, opts.onProgress);
}

function tierOf<T extends Verdict['tier']>(v: Verdict, tier: T): Extract<Verdict, { tier: T }> {
  if (v.tier !== tier) throw new Error(`expected tier ${String(tier)}, got ${JSON.stringify({ tier: v.tier, ...(v.tier === 'unproven' ? { reason: v.reason, detail: v.detail } : {}) })}`);
  return v as Extract<Verdict, { tier: T }>;
}

// teamPool's mons ('party:<i>' = p1[i]); only {A, C} is tier 1.
const [A, B, C] = ['party:0', 'party:1', 'party:2'];
const abc = ['a', 'b', 'c'];
const abcd = ['a', 'b', 'c', 'd'];
const strike = (name: string, maxHp: number, damage = 4): ToyMon => ({ name, maxHp, speed: 5, moves: [{ name: 'Strike', damage: [damage] }] });

// Brute Bashes 3, or 6 on a crit. Frail dies to the first Bash (tier 3); Sturdy is tier 2, budget 1, death 1/16.
const riskPool = pool('riskPool', [strike('Frail', 3), strike('Sturdy', 10)], { name: 'Brute', maxHp: 8, speed: 10, moves: [{ name: 'Bash', damage: [3], critChance: rat(1, 4) }] }, 3);

type Opts = Steer & { score?: (team: MonRef[]) => number; maxSorted?: number };

// Order: preferred count, then score, then size (larger first), then pool order; maxSorted 0 takes the lazy path.
const CANDIDATES: [name: string, pool: MonRef[], maxSize: number, monotone: boolean, want: string, opts?: Opts][] = [
  ['monotone: full-size teams only', abc, 2, true, 'ab ac bc'],
  ['not monotone, scored', abc, 2, false, 'ac bc c ab a b', { score: has('c') }],
  ['lazy: pool by single score, larger first', abc, 2, false, 'ac bc ab c a b', { score: has('c'), maxSorted: 0 }],
  ['empty pool', [], 6, true, ''],
  ['maxSize clamped to the pool', ['a', 'b'], 6, true, 'ab'],
  ['mustBring, scored', abcd, 3, false, 'abd bcd bd abc ab bc b', { mustBring: ['b'], score: has('d') }],
  ['mustBring, monotone, lazy', abcd, 3, true, 'abc abd bcd', { mustBring: ['b'], maxSorted: 0 }],
  ['mustBring fills the team', abcd, 2, false, 'bd', { mustBring: ['d', 'b'] }],
  ['preferred before score', abcd, 2, true, 'cd bc bd ac ad ab', { preferred: ['c', 'd'], score: has('b') }],
  ['preferred before size', abc, 2, false, 'ac bc c ab a b', { preferred: ['c'] }],
  ['preferred, lazy', abcd, 2, true, 'cd ac bc ad bd ab', { preferred: ['c', 'd'], maxSorted: 0 }],
];

describe('team selection', () => {
  it('finds the only working pair, within each team\'s share of the budget', async () => {
    const seen: Progress[] = [];
    const v = tierOf(await solve(teamPool, request(teamPool, [A, B, C], 2), { deps: { config: { progressIntervalMs: 0 } }, onProgress: (p) => seen.push(p) }), 1);
    expect([v.team, v.lead, v.rank.turns, v.report.verification.passed]).toEqual([[A, C], A, '3', true]);
    // Pairs come first, so {A, B} is the only team tried before {A, C}.
    expect(v.report.rejectedTeams).toEqual([{ team: [A, B], firstFailure: 'Team A, B: Lead with A / Use move 1 / Use move 1 / damage on turn 2 kills party 0' }]);
    expect([new Set(seen.map((p) => p.teamsTotal)), seen.map((p) => p.teamsTried).at(-1)]).toEqual([new Set([6]), 2]);
    // Tier 1 is reported only once the shown team's full run has passed the checker.
    expect(seen.findIndex((p) => p.bestTier === 1)).toBe(seen.length - 1);

    // {A, B} overruns its share (1,000 / 6) at its first node: listed as not proven, and {A, C} is still shown.
    const share = jumpAt('team A, B (1/6): tier 1, horizon 1', 250);
    const late = tierOf(await solve(teamPool, request(teamPool, [A, B, C], 2, {}, { budgetMs: 1_000 }), share), 1);
    expect([share.jumped(), late.team, late.report.rejectedTeams]).toEqual([true, [A, C], [{ team: [A, B], firstFailure: 'Team A, B: not proven within its share of the budget' }]]);
    // {A, C}'s full solve passes the whole deadline: that result is shown and no later team is tried.
    const out = await solve(teamPool, request(teamPool, [A, B, C], 2, {}, { budgetMs: 1_000 }), jumpAt('team A, C: ', 1_500));
    expect(out).toMatchObject({ tier: 'unproven', reason: 'timeout', report: { rejectedTeams: [{ team: [A, B] }] } });
    expect(out.report.assumptions.at(-1)).toMatch(/the first team proven tier 1 ran out of time in its full solve, which is shown$/);
  });

  it.each(CANDIDATES)('candidates: %s', (_, pool, maxSize, monotone, want, { score, maxSorted, ...steer } = {}) => {
    const c = teamCandidates(pool, maxSize, monotone, score, maxSorted, steer);
    expect([[...c], c.count]).toEqual([teams(want), teams(want).length]);
    // Empty steering lists change nothing.
    if (steer.mustBring === undefined && steer.preferred === undefined) expect([...teamCandidates(pool, maxSize, monotone, score, maxSorted, { mustBring: [], preferred: [] })]).toEqual(teams(want));
  });

  it('candidates stay lazy on a large pool', () => {
    const pool = Array.from({ length: 40 }, (_, i) => `m${i}`);
    expect([teamCount(40, 6, true), teamCount(40, 6, false), teamCount(40, 6, false, 0)]).toEqual([3_838_380, 4_598_478, 4_598_478]);
    let calls = 0;
    const scored = teamCandidates(pool, 6, true, (team) => (calls += 1, has('m39')(team)));
    const first = scored[Symbol.iterator]().next().value;
    // One single-mon score per pool member and no team scores: m39 first, then pool order.
    expect([scored.count, calls, first]).toEqual([3_838_380, 40, ['m0', 'm1', 'm2', 'm3', 'm4', 'm39']]);
    const pref = teamCandidates(pool, 6, true, has('m39'), undefined, { preferred: ['m30', 'm10', 'm20'] });
    expect(pref[Symbol.iterator]().next().value).toEqual(['m0', 'm1', 'm10', 'm20', 'm30', 'm39']);
    // mustBring: every team holds both, and each comes once.
    const must = teamCandidates(pool, 6, true, undefined, undefined, { mustBring: ['m17', 'm5'] });
    const all = [...must];
    const unique = new Set(all.map((team) => team.join(','))).size;
    expect([must.count, teamCount(40, 6, true, 2), all.length, unique, all.every((team) => team.includes('m17') && team.includes('m5'))]).toEqual([73_815, 73_815, 73_815, 73_815, true]);
  });

  it.each([
    ['team', { mustBring: ['d'] }, 'team: mustBring lists d, which is not in the pool'],
    ['team', { preferred: ['d'] }, 'team: preferred lists d, which is not in the pool'],
    ['team', { mustBring: ['a'], preferred: ['b', 'a'] }, 'team: a is in both mustBring and preferred'],
    ['team', { preferred: ['b', 'b'] }, 'team: preferred lists b twice'],
    ['team', { mustBring: ['c', 'c'] }, 'team: mustBring lists c twice'],
    ['solve', { mustBring: [C] }, 'solve: mustBring lists party:2, which is not in the pool'],
    ['solve', { mustBring: [A], preferred: [A] }, 'solve: party:0 is in both mustBring and preferred'],
    ['solve', { preferred: [B, B] }, 'solve: preferred lists party:1 twice'],
  ] as [string, Steer, string][])('%s refuses %j', async (where, steer, message) => {
    const run = async (): Promise<unknown> => (where === 'team' ? teamCandidates(abc, 2, true, undefined, undefined, steer) : solve(teamPool, request(teamPool, [A, B], 2, steer)));
    await expect(run()).rejects.toEqual(new RangeError(message));
  });

  it('only a complete disproof makes a no-good', () => {
    const noGoods = new NoGoods();
    expect(noGoods.rulesOut(['a'])).toBe(false);
    noGoods.add(['a', 'b', 'c']);
    expect([['a', 'c'], ['a', 'b', 'c'], ['a', 'd']].map((team) => noGoods.rulesOut(team))).toEqual([true, true, false]);
    expect([completeDisproof(true, []), completeDisproof(false, []), completeDisproof(true, ['item mystery (Hero)'])]).toEqual([true, false, false]);

    // In tier-1 mode a failure says whether it was refuted: one choice dying and another meeting an unlabelled outcome is not.
    const req: SolveRequest = { ...request(safe1v1, ['party:0'], 1), team: { kind: 'fixed', party: ['party:0'] } };
    const ctl: Tier1Control = { deadline: Number.POSITIVE_INFINITY, checkerDeadline: Number.POSITIVE_INFINITY, progress: { node() {}, message() {}, teams() {} }, mode: 'tier1' };
    const none = { id: 'none', check: () => ({ checks: 0, mismatches: [] }) };
    const tier1 = (spec: TableSpec) => {
      const t = tableGame(spec);
      return solveFights({ ...toyDeps(safe1v1), engine: t.engine, enemyModel: t.ai, oracles: { damage: none, speed: none } }, resolveConfig(), tableFights(t), req, ctl);
    };
    expect(tier1(TABLES.deadOrRaw)).toMatchObject({ kind: 'failed', refuted: false, reasons: { death: true, unmodelled: true } });
    expect(tier1(TABLES.bothDie)).toMatchObject({ kind: 'failed', refuted: true });
    // Tier-1 mode refuses a root restriction.
    const restricted = { ...ctl, restrictRoot: [{ kind: 'switch', index: 0 }] } as unknown as Tier1Control;
    expect(() => solveFights(toyDeps(safe1v1), resolveConfig(), scenarioFights(safe1v1), req, restricted)).toThrow(/restrictRoot/);
  });

  it('keeps the best tier when no team is tier 1', async () => {
    const both = ['party:0', 'party:1'];
    const v = tierOf(await solve(riskPool, request(riskPool, both, 1)), 2);
    expect([v.team, v.critBudget, v.deathProbability]).toEqual([['party:1'], 1, rat(1, 16)]);
    // Both teams failed tier 1 (the shown one too), in the order tried.
    expect(v.report.rejectedTeams).toEqual([
      { team: ['party:0'], firstFailure: expect.stringMatching(/^Team Frail: Lead with Frail \/ .*bash on turn 1 kills party 0$/) },
      { team: ['party:1'], firstFailure: expect.stringMatching(/^Team Sturdy: Lead with Sturdy \/ .*enemy crit bash on turn 2 kills party 0$/) },
    ]);
    expect(v.report.assumptions.at(-1)).toMatch(/no team was proven tier 1; the best of 2 of 2 teams evaluated for tiers 2 and 3 is shown$/);
    // Phase A (60% of the budget) ends once Frail fails tier 1, so Phase B runs Sturdy in full; or Frail overruns its
    // Phase A share, and Phase B's retry replaces the timeout entry in place. The same result either way.
    for (const [at, to] of [['team Frail (1/2): tier 1 failed', 700], ['team Frail (1/2): tier 1, horizon 1', 400]] as const) {
      const clock = jumpAt(at, to);
      const late = tierOf(await solve(riskPool, request(riskPool, both, 1, {}, { budgetMs: 1_000 }), clock), 2);
      expect([clock.jumped(), late.team, late.critBudget, late.report.rejectedTeams], at).toEqual([true, ['party:1'], 1, v.report.rejectedTeams]);
    }
  });

  it.each([
    ['the pool is empty', safe1v1, request(safe1v1, [], 6), null, 'the pool is empty', null],
    ['every member fainted', safe1v1, request(safe1v1, ['party:0'], 6), ['party:0'], 'every Pokémon in the pool has fainted (0 HP in the save): Hero (party:0)', ['party:0']],
    ['too many mustBring', teamPool, request(teamPool, [A, B, C], 2, { mustBring: [A, B, C] }), null, 'teams of at most 2 Pokémon cannot hold the 3 that must come: A (party:0), B (party:1), C (party:2)', null],
    ['a fainted mustBring', teamPool, request(teamPool, [A, B, C], 2, { mustBring: [A] }), [A], 'A (party:0) must come but has fainted (0 HP in the save); a fight cannot start with a fainted Pokémon', [A, C]],
  ] as [string, Scenario, SolveRequest, MonRef[] | null, string, MonRef[] | null][])('no eligible team: %s', async (_, s, req, fainted, detail, healedTeam) => {
    const deps = fainted === null ? {} : { resolver: faintedAt(s, fainted) };
    expect(await solve(s, req, { deps })).toMatchObject({ tier: 'unproven', reason: 'noEligibleTeam', detail });
    // Unless fight 0 starts healed.
    if (healedTeam !== null) expect(tierOf(await solve(s, { ...req, fights: [{ trainerId: s.trainerId, healBefore: true }] }, { deps }), 1).team).toEqual(healedTeam);
  });

  it('steers the search end to end', async () => {
    const run = (steer: Steer, deps?: Partial<SolverDeps>): Promise<Verdict> => solve(teamPool, request(teamPool, [A, B, C], 2, steer), { deps });
    const tried = async (steer: Steer, deps?: Partial<SolverDeps>) => {
      const v = await run(steer, deps);
      return [v.tier === 'unproven' ? null : v.team, v.report.rejectedTeams.map((r) => r.team), v.report.assumptions.at(-1)!.split('; ')[0]];
    };
    expect(await tried({ preferred: [C] })).toEqual([[A, C], [], 'team search: 1 of 6 candidate teams tried, teams of 1 to 2 from 3 eligible Pokémon, those with more of C first']);
    // A preferred mon at 0 HP is left out of the pool and of the preferred list.
    expect((await tried({ preferred: [A, C] }, { resolver: faintedAt(teamPool, [A]) })).slice(1)).toEqual([[[B, C], [C], [B]], 'team search: 3 of 3 candidate teams tried, teams of 1 to 2 from 2 eligible Pokémon (1 at 0 HP left out), those with more of C first']);
    expect(await tried({ mustBring: [A] })).toEqual([[A, C], [[A, B]], 'team search: 2 of 3 candidate teams tried, teams of 1 to 2 from 3 eligible Pokémon, each with A']);
    expect((await tried({ mustBring: [B] }))[1]).toEqual([[A, B], [B, C], [B]]);   // no team is tier 1; only teams with B are tried
    expect(await tried({ mustBring: [C, A] })).toEqual([[A, C], [], 'team search: 1 of 1 candidate team tried, teams of 2 from 3 eligible Pokémon, each with C, A']);
    // Empty steering lists change nothing, down to the verdict (the clock stopped).
    const frozen = { now: () => 0 };
    const plain = await solve(teamPool, request(teamPool, [A, B, C], 2), { deps: frozen });
    expect(await run({ mustBring: [], preferred: [] }, frozen)).toEqual(plain);
  });

  it('passes over a proven team with unmodelled content or a failed check', async () => {
    // Each alone is safe1v1's game; Odd holds the unmodelled item and Bad's battles fail a planted damage oracle.
    const hero = (name: string): ToyMon => ({ ...strike(name, 10, 5), speed: 10 });
    const oddPool = pool('oddPool', [{ ...hero('Odd'), item: 'mystery' }, hero('Bad'), hero('Hero')], { name: 'Imp', maxHp: 5, speed: 5, moves: [{ name: 'Scratch', damage: [3] }] }, 2);
    const base = toyOracles(oddPool.registry);
    const planted: DamageOracle = {
      id: 'planted@1',
      check: (step) => (readToyState(step.before).p1Keys.includes('Bad') ? { checks: 1, mismatches: ['planted'] } : base.damage.check(step)),
    };
    const v = tierOf(await solve(oddPool, request(oddPool, ['party:0', 'party:1', 'party:2'], 1), { deps: { oracles: { ...base, damage: planted } } }), 1);
    expect([v.team, v.report.verification.passed]).toEqual([['party:2'], true]);
    expect(v.report.rejectedTeams).toEqual([
      { team: ['party:0'], firstFailure: 'Team Odd: unmodelled: item mystery (Odd)' },
      { team: ['party:1'], firstFailure: expect.stringMatching(/^Team Bad: verificationMismatch: damage oracle planted@1: planted/) },
    ]);
    expect(v.report.assumptions.at(-1)).toMatch(/the first team with a tier-1 proof is shown$/);
  });

  it('caps rejected teams at 200', async () => {
    // 210 mons that each die to the first Bash: every team of 1 is tier 3 at death 1, so the earliest is kept.
    const names = Array.from({ length: 210 }, (_, i) => `W${String(i).padStart(3, '0')}`);
    const weakPool = pool('weakPool', names.map((name) => ({ name, maxHp: 1, speed: 1, moves: [{ name: 'Poke', damage: [1] }] })), { name: 'Brute', maxHp: 8, speed: 10, moves: [{ name: 'Bash', damage: [3] }] }, 1);
    const refs = names.map((_, i) => `party:${i}`);
    const v = tierOf(await solve(weakPool, request(weakPool, refs, 1), { deps: { config: { probeHiddenInformation: false } } }), 3);
    expect([v.team, v.report.rejectedTeams.map((r) => r.team), v.report.rejectedTeams[200]!.firstFailure]).toEqual([['party:0'], [...refs.slice(0, 200).map((ref) => [ref]), []], '… and 10 more teams not proven']);
  });
});
