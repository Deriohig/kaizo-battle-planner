// Solves on worker threads. Per-solve workers load toy/deps.ts (createDeps reads SOLVER_TOY_SCENARIO); shared-pool
// workers load toy/contextDeps.ts, which counts loads and builds in the context's shared memory.

import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineState } from '../../../src/contracts/engine.js';
import type { MonRef, Progress, SolveRequest, Verdict } from '../../../src/contracts/solver.js';
import { createSolver, createSolverPool, type SolverPool, type WorkerContext } from '../../../src/solver/index.js';
import { RecentCache } from '../../../src/solver/parallel/depsCache.js';
import { runJob, type Job } from '../../../src/solver/parallel/jobs.js';
import { liveWorkers, WorkerPool } from '../../../src/solver/parallel/pool.js';
import { rat } from '../../../src/solver/rational.js';
import type { SolverConfig } from '../../../src/solver/types.js';
import { toyCounters, type ToyContext } from './toy/contextDeps.js';
import { ledBy, skewedOracles, toyDeps, withStatus } from './toy/deps.js';
import { toyOracles } from './toy/oracles.js';
import {
  critOnlyBudget1, deadlyRolls, hiddenCounterSafe, preBurn, rankingStopsOnRaw, rawOrRisk, safe1v1, slowPair, slowSecondLead, slowStall, slowTrio, teamPool,
  twoSafeLines, uturnLine, type Scenario,
} from './toy/scenarios.js';

const DEPS_MODULE = new URL('./toy/deps.ts', import.meta.url).href;
const CONTEXT_DEPS = new URL('./toy/contextDeps.ts', import.meta.url).href;
const PARALLEL: Partial<SolverConfig> = { threads: 2, depsModule: DEPS_MODULE };
const SLOW = 60_000;
const WAIT = { timeout: 20_000, interval: 20 };
const CANCELLED = { tier: 'unproven', reason: 'timeout', detail: 'cancelled' };
const DISAGREES = "this thread's re-check of the worker's line disagrees: passed false, the worker's true; ";
const MISMATCHES = `${DISAGREES}reason verificationMismatch, the worker's none; mismatches differ `;
const DISPUTED = "this thread's re-check of this line disagrees with the worker's check (see the verdict detail)";

// Every pool a test opens is closed after it, so no worker thread outlives its test.
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const pool of open.splice(0)) await pool.close();
  expect(liveWorkers()).toBe(0);
});
const opened = <T extends { close(): Promise<void> }>(pool: T): T => (open.push(pool), pool);
const sharedPool = (threads: number): SolverPool => opened(createSolverPool({ threads, depsModule: CONTEXT_DEPS }));
const workerPool = (threads: number, depsModule = CONTEXT_DEPS): WorkerPool => opened(new WorkerPool({ threads, depsModule, execArgv: ['--import', 'tsx'] }));

let counts: ReturnType<typeof toyCounters>;
beforeEach(() => {
  counts = toyCounters();
});

/** A worker context for the toy scenario `s`, counting into this test's counters. */
const context = (key: string, s: Scenario, more: Partial<ToyContext> = {}): WorkerContext => ({ key, value: { scenario: s.name, counts: counts.buffer, ...more } satisfies ToyContext });

function fixed(s: Scenario, over: Partial<SolveRequest> = {}): SolveRequest {
  return {
    fights: [{ trainerId: s.trainerId }], team: { kind: 'fixed', party: s.p1.map((_, i) => `party:${i}`) }, preStatus: 'given',
    budgetMs: 600_000, horizonTurns: s.horizon, attemptAnyLegalBadge: false, ranking: [], ...over,
  };
}

const search = (s: Scenario, pool: MonRef[], maxSize: number): SolveRequest => ({ ...fixed(s), team: { kind: 'search', pool, maxSize } });

/** A job for the scenario's first lead, with no deadline. */
const rootJob = (s: Scenario): Job => ({
  kind: 'root', req: fixed(s), team: s.p1.map((_, i) => `party:${i}`), restrictRoot: [{ kind: 'switch', index: 0 }],
  deadline: Number.POSITIVE_INFINITY, checkerDeadline: Number.POSITIVE_INFINITY,
});

interface SolveOpts {
  req?: SolveRequest; config?: Partial<SolverConfig>; pool?: SolverPool; workerContext?: WorkerContext; skip?: string[];
  plant?: (state: EngineState) => boolean; onProgress?: (p: Progress) => void; signal?: AbortSignal;
}

/**
 * The toy solve of `s` (its fixed team unless `req`), threads 2 on a given pool. `skip`: moves the damage oracle does
 * not cross-check. `plant`: this thread's damage oracle finds a mismatch on every step whose state before matches it.
 */
function solve(s: Scenario, o: SolveOpts = {}): Promise<Verdict> {
  process.env.SOLVER_TOY_SCENARIO = s.name;
  const own = toyDeps(s, {
    config: { progressIntervalMs: 0, ...(o.pool === undefined ? {} : { threads: 2 }), ...o.config },
    ...(o.skip === undefined ? {} : { oracles: toyOracles(s.registry, { skip: o.skip }) }),
    ...(o.pool === undefined ? {} : { pool: o.pool }), ...(o.workerContext === undefined ? {} : { workerContext: o.workerContext }),
  });
  const deps = o.plant === undefined ? own : { ...own, oracles: skewedOracles(own.oracles, o.plant, 'mismatch') };
  return createSolver(deps).solve(o.req ?? fixed(s), o.onProgress, o.signal);
}

/** A solve that runs until `ctl` aborts it, with its latest progress node count. */
function cancellable(s: Scenario, o: SolveOpts) {
  const ctl = new AbortController();
  const state = { nodes: 0 };
  const verdict = solve(s, { ...o, signal: ctl.signal, onProgress: (p) => {
    state.nodes = p.nodes;
    o.onProgress?.(p);
  } });
  return { ctl, state, verdict };
}

const RUN_COUNTS = new Set(['elapsedMs', 'nodes', 'turnExecutions', 'ttEntries', 'ttHits']);

/** The verdict without its run's own counts (a split runs one search per lead), in `best` too. */
function comparable(v: Verdict): unknown {
  const report = Object.fromEntries(Object.entries(v.report).filter(([k]) => !RUN_COUNTS.has(k)));
  return { ...v, report, ...(v.tier === 'unproven' && v.best !== undefined ? { best: comparable(v.best) } : {}) };
}

/** A tier-1 verdict's line (two leads' report sums both searches, so the rest differs). */
const line = (v: Verdict): unknown => (v.tier === 1 ? { lead: v.lead, tree: v.tree, rank: v.rank, verification: v.report.verification } : v.tier);

/** Every assumption of `v` and its `best` that claims a line is proven safe and checked. */
const checkedClaims = (v: Verdict): string[] => [v.report, ...(v.tier === 'unproven' && v.best !== undefined ? [v.best.report] : [])]
  .flatMap((r) => r.assumptions.filter((a) => a.includes('proven safe and checked')));

describe('a solve split over its own workers', () => {
  it('agrees with the in-process verdict, for fixed teams and team searches', async () => {
    const cases: [Scenario, SolveRequest, number, object, ((v: Verdict) => unknown)?][] = [
      [safe1v1, fixed(safe1v1), 1, {}], [critOnlyBudget1, fixed(critOnlyBudget1), 1, {}], [deadlyRolls, fixed(deadlyRolls), 1, {}],
      [twoSafeLines, fixed(twoSafeLines), 1, {}],
      [preBurn, fixed(preBurn, { preStatus: 'propose' }), 1, {}],   // the baseline and each pre-status variant are split
      [uturnLine, fixed(uturnLine), 2, { tier: 1, lead: 'party:0' }, line],   // two leads, two jobs: Scout's lead is tier 1, Tank's not
      [teamPool, search(teamPool, ['party:0', 'party:1', 'party:2'], 2), 1, { tier: 1, team: ['party:0', 'party:2'], report: { rejectedTeams: [{ team: ['party:0', 'party:1'] }] } }],
      [deadlyRolls, search(deadlyRolls, ['party:0'], 1), 1, { tier: 3 }],   // tier 1 fails in a worker; tier 3, re-checked here
    ];
    for (const [s, req, peak, more, same = comparable] of cases) {
      let seen = 0;
      const onProgress = (): void => {
        seen = Math.max(seen, liveWorkers());
      };
      const alone = await solve(s, { req, onProgress });
      expect(seen, s.name).toBe(0);
      const split = await solve(s, { req, config: PARALLEL, onProgress });
      expect(same(split), s.name).toEqual(same(alone));
      expect(split, s.name).toMatchObject(more);
      expect(seen, s.name).toBeGreaterThanOrEqual(peak);
    }
  }, SLOW);

  it('abort stops the workers of a root split and of a team search', async () => {
    // Searches that run for many seconds, cancelled at the first progress report with a worker's nodes. A team search
    // starts slowPair's {Hero} and {Spare} at once.
    const cases: [Scenario, SolveRequest, number][] = [[slowStall, fixed(slowStall), 1], [slowPair, search(slowPair, ['party:0', 'party:1'], 1), 2]];
    for (const [s, req, workers] of cases) {
      const signal = new AbortController();
      let atAbort = -1;
      const began = performance.now();
      const verdict = await solve(s, {
        req, config: PARALLEL, signal: signal.signal, onProgress: (p) => {
          if (atAbort >= 0 || p.nodes === 0) return;
          atAbort = liveWorkers();
          signal.abort();
        },
      });
      expect(atAbort, s.name).toBe(workers);
      expect(verdict, s.name).toMatchObject({ ...CANCELLED, report: { rejectedTeams: [] } });   // a cancelled candidate was not tried
      expect([liveWorkers(), performance.now() - began < 30_000], s.name).toEqual([0, true]);
    }
  }, SLOW);

  it('a failing worker stops the other jobs at once', async () => {
    // Battles Spare leads are broken in the workers; Hero's job would search until the budget.
    process.env.SOLVER_TOY_BREAK_LEAD = 'Spare';
    try {
      for (const req of [fixed(slowPair, { budgetMs: 20_000 }), { ...search(slowPair, ['party:0', 'party:1'], 1), budgetMs: 20_000 }]) {
        const began = performance.now();
        await expect(solve(slowPair, { req, config: PARALLEL })).rejects.toThrow('toy deps: battles led by Spare are broken (SOLVER_TOY_BREAK_LEAD)');
        expect([performance.now() - began < 5_000, liveWorkers()], req.team.kind).toEqual([true, 0]);
      }
    } finally {
      delete process.env.SOLVER_TOY_BREAK_LEAD;
    }
  }, SLOW);

  it.each([
    { what: 'a team search', s: deadlyRolls, req: search(deadlyRolls, ['party:0'], 1), plant: ledBy('Hero'), prefix: `team Hero: ${MISMATCHES}`, best: { tier: 3 } },
    {
      what: 'the best of two leads', s: uturnLine, req: fixed(uturnLine), plant: ledBy('Scout'), prefix: `lead Scout: ${MISMATCHES}`,
      best: { tier: 1, lead: 'party:0', report: { verification: { passed: true }, assumptions: expect.arrayContaining([DISPUTED]) } },
      report: { verification: { passed: false, mismatches: expect.arrayContaining([expect.any(String)]) } },
    },
    {
      what: "a pre-status variant's split", s: preBurn, req: fixed(preBurn, { preStatus: 'propose' }), plant: withStatus('burn'),
      prefix: `pre-status Hero (party:0) burn: lead Hero: ${DISAGREES}`, best: { tier: 3, preStatus: {}, report: { verification: { passed: true } } },
    },
    { what: 'a stopped-early line', s: rankingStopsOnRaw, req: fixed(rankingStopsOnRaw), plant: ledBy('Hero'), prefix: `lead Hero: ${DISAGREES}`, best: { tier: 1 } },
  ])('a worker line that fails the re-check is never compared or claimed: $what', async ({ what: _what, s, req, plant, prefix, best, ...more }) => {
    // This thread's oracle finds a mismatch the workers' does not: unproven, with what would be shown as `best`.
    const verdict = await solve(s, { req, config: PARALLEL, plant });
    expect(verdict).toMatchObject({ tier: 'unproven', reason: 'verificationMismatch', best, ...more });
    expect(verdict.tier === 'unproven' && verdict.detail.startsWith(prefix), JSON.stringify(verdict.tier === 'unproven' && verdict.detail)).toBe(true);
    expect(checkedClaims(verdict)).toEqual([]);
  }, SLOW);

  it('a stopped-early line claims to be proven safe and checked only when it is', async () => {
    const verdict = await solve(rankingStopsOnRaw);
    expect([verdict.tier, checkedClaims(verdict)]).toEqual([1, [
      'ranking stopped early (a refutation met an unmodelled outcome): the line is proven safe and checked, but a better-ranked safe line may exist',
    ]]);
  });

  it('a lead that is not refuted keeps the split unproven, as in-process', async () => {
    // rawOrRisk: Hero's lead refutes tier 1 (a miss kills), Wilder's only meets an unlabelled outcome, so Wilder's result
    // is not proven least and neither is the line.
    const alone = await solve(rawOrRisk);
    const split = await solve(rawOrRisk, { config: PARALLEL });
    for (const v of [alone, split]) {
      expect(v).toMatchObject({ tier: 'unproven', reason: 'unmodelled', best: { tier: 3, lead: 'party:0', deathProbability: rat(1, 4), optimality: 'bestFoundWithinBudget' } });
    }
    expect(split).toMatchObject({ detail: expect.stringMatching(/^lead Wilder: unmodelled: /) });
  }, SLOW);

  it('a lead out of time does not hide a verified tier-1 line', async () => {
    // slowSecondLead: Hero's lead is tier 1 at once; Slug's is a search far longer than the budget.
    const verdict = await solve(slowSecondLead, { req: fixed(slowSecondLead, { budgetMs: 3_000 }), config: PARALLEL });
    expect(verdict).toMatchObject({ tier: 1, lead: 'party:0', report: { verification: { passed: true } } });
    expect(verdict.report.assumptions).toContain('ranking stopped early (unfinished leads: Slug): the line is proven safe and checked, but a better-ranked safe line may exist');
  }, SLOW);

  it('closing the pool with queued jobs leaves no workers', async () => {
    process.env.SOLVER_TOY_SCENARIO = slowStall.name;
    const pool = workerPool(1, DEPS_MODULE);
    const runs = Promise.allSettled([1, 2, 3].map(() => pool.run(rootJob(slowStall))));
    expect(liveWorkers()).toBe(1);   // one worker for the first job; the other two wait
    await pool.close();
    expect((await runs).map((r) => (r.status === 'rejected' ? (r.reason as Error).message : 'fulfilled'))).toEqual([
      'pool: closed while the job ran', 'pool: closed before the job ran', 'pool: closed before the job ran',
    ]);
    await expect(pool.run(rootJob(slowStall))).rejects.toThrow('pool: closed');
  }, SLOW);
});

describe('worker contexts', () => {
  it('RecentCache keeps the 2 most recent keys (in-process, where coverage sees it)', () => {
    const built: string[] = [];
    const cache = new RecentCache<string>(2);
    for (const key of ['a', 'a', 'b', 'c', 'b', 'a']) expect(cache.get(key, () => (built.push(key), `deps ${key}`))).toBe(`deps ${key}`);
    expect([built, cache.keys()]).toEqual([['a', 'b', 'c', 'a'], ['b', 'a']]);   // c evicts a; a evicts c
  });

  it("a worker keeps the 2 most recent contexts' deps and runs each job on its own context's deps", async () => {
    const pool = workerPool(1);
    // Each key names another scenario, so a job's tier shows whose deps it ran on; 'a' is built again once evicted.
    const steps: [string, Scenario, number][] = [['a', safe1v1, 1], ['a', safe1v1, 1], ['b', critOnlyBudget1, 2], ['c', deadlyRolls, 3], ['b', critOnlyBudget1, 3], ['a', safe1v1, 4]];
    for (const [key, s, builds] of steps) {
      const remote = await pool.lane({ context: context(key, s) }).run(rootJob(s));
      expect([remote.verdict?.tier, counts.builds()], key).toEqual([runJob(toyDeps(s), rootJob(s)).verdict?.tier, builds]);
    }
    expect(counts.loads()).toBe(1);
  }, SLOW);

  it('a build that fails is not kept: the next job with that key builds again', async () => {
    const lane = workerPool(1).lane({ context: context('flaky', safe1v1, { failBuilds: 1 }) });
    await lane.run(rootJob(safe1v1)).catch(() => null);
    expect((await lane.run(rootJob(safe1v1))).verdict?.tier).toBe(1);
    expect([counts.builds(), liveWorkers()]).toEqual([2, 1]);
  }, SLOW);
});

describe('a shared pool (SolverPool)', () => {
  it('warm starts every worker; consecutive solves reuse them, loading the heavy part once per worker', async () => {
    const pool = sharedPool(2);
    const ctx = context('u', uturnLine);
    pool.warm(ctx);
    expect(liveWorkers()).toBe(2);
    await vi.waitFor(() => expect([counts.loads(), counts.builds()]).toEqual([2, 2]), WAIT);
    const alone = line(await solve(uturnLine));
    for (const run of [1, 2]) expect(line(await solve(uturnLine, { pool, workerContext: ctx })), `solve ${run}`).toEqual(alone);
    expect([counts.loads(), counts.builds(), liveWorkers()]).toEqual([2, 2, 2]);
    // A new context: the workers build its deps over the heavy part they already hold.
    await solve(uturnLine, { pool, workerContext: context('u2', uturnLine) });
    expect([counts.loads(), counts.builds(), liveWorkers()]).toEqual([2, 4, 2]);
  }, SLOW);

  it('the hits the damage calc did not cross-check come back from a worker, also on its kept deps', async () => {
    const pool = sharedPool(2);
    const skip = ['Strike', 'Bonk'];   // this thread skips the same moves, or its re-check would disagree
    const ctx = context('skip', hiddenCounterSafe, { skip });
    for (const run of [1, 2]) {
      const v = await solve(hiddenCounterSafe, { pool, workerContext: ctx, skip });
      expect(v, `solve ${run}`).toMatchObject({ tier: 1, report: { verification: { notCrossChecked: [{ move: 'Bonk', hits: 3 }, { move: 'Strike', hits: 2 }] } } });
      expect([counts.builds(), liveWorkers()], `solve ${run}`).toEqual([1, 1]);
    }
  }, SLOW);

  it('a solve leaves an injected pool open and no listener on its signal', async () => {
    const pool = sharedPool(1);
    const signal = new AbortController().signal;
    for (const run of [1, 2]) {
      expect((await solve(safe1v1, { pool, workerContext: context('s', safe1v1), signal })).tier, `solve ${run}`).toBe(1);
      expect([getEventListeners(signal, 'abort').length, pool.busy, liveWorkers()], `solve ${run}`).toEqual([0, 0, 1]);
    }
  }, SLOW);

  it('a solve runs at most min(threads, pool size) jobs at once, and threads 1 stays in-process', async () => {
    const pool = sharedPool(3);
    const ctx = context('t', slowTrio);
    pool.warm(ctx);
    await vi.waitFor(() => expect(counts.builds()).toBe(3), WAIT);
    // Three leads that outlast any budget, three idle workers, threads 2: two jobs at a time, the pool's size unchanged.
    let peak = 0;
    const run = cancellable(slowTrio, { pool, workerContext: ctx, onProgress: () => { peak = Math.max(peak, pool.busy); } });
    await vi.waitFor(() => expect([run.state.nodes > 0, peak]).toEqual([true, 2]), WAIT);
    run.ctl.abort();
    expect((await run.verdict).tier).toBe('unproven');
    expect(peak).toBe(2);
    await vi.waitFor(() => expect([liveWorkers(), counts.builds()]).toEqual([3, 5]), WAIT);   // the two cancelled workers replaced and warmed
    expect((await solve(safe1v1, { pool, workerContext: context('one', safe1v1), config: { threads: 1 } })).tier).toBe(1);
    expect(counts.builds()).toBe(5);
  }, SLOW);

  it("cancelling one solve terminates only its own workers; the other solve's jobs run on", async () => {
    const pool = sharedPool(2);
    pool.warm(context('warm', slowStall));
    let bAfterCancel = 0;
    const a = cancellable(slowStall, { pool, workerContext: context('A', slowStall) });
    const b = cancellable(slowStall, { pool, workerContext: context('B', slowStall), onProgress: () => { if (a.ctl.signal.aborted) bAfterCancel += 1; } });
    let bSettled = false;
    const bDone = b.verdict.finally(() => { bSettled = true; });
    await vi.waitFor(() => expect([a.state.nodes > 0, b.state.nodes > 0, pool.busy]).toEqual([true, true, 2]), WAIT);
    a.ctl.abort();
    expect(await a.verdict).toMatchObject(CANCELLED);
    // A's worker is replaced at once and warms with the warm-up context (no job of either solve succeeded).
    await vi.waitFor(() => expect([liveWorkers(), counts.loads()]).toEqual([2, 3]), WAIT);
    await vi.waitFor(() => expect(bAfterCancel).toBeGreaterThan(2), WAIT);   // B's worker still reports
    expect(bSettled).toBe(false);
    b.ctl.abort();
    expect(await bDone).toMatchObject(CANCELLED);
  }, SLOW);

  it("on a full pool another solve's job waits its turn, and runs on the replacement once the running solve is cancelled", async () => {
    const pool = sharedPool(1);
    pool.warm(context('warm', safe1v1));
    const a = cancellable(slowStall, { pool, workerContext: context('A', slowStall) });
    await vi.waitFor(() => expect(a.state.nodes).toBeGreaterThan(0), WAIT);
    let bSettled = false;
    const b = solve(safe1v1, { pool, workerContext: context('B', safe1v1) }).finally(() => { bSettled = true; });
    const seen = a.state.nodes;
    await vi.waitFor(() => expect(a.state.nodes).toBeGreaterThan(seen), WAIT);   // A still runs with B's job queued
    expect([bSettled, pool.busy, liveWorkers()]).toEqual([false, 1, 1]);
    a.ctl.abort();
    expect(await a.verdict).toMatchObject(CANCELLED);
    expect([(await b).tier, liveWorkers()]).toEqual([1, 1]);
  }, SLOW);

  it('a worker that dies is replaced and warmed with the last context one of whose jobs succeeded, never a doomed or cancelled one', async () => {
    const pool = sharedPool(1);
    pool.warm(context('warm', safe1v1, { tag: 1 }));
    await vi.waitFor(() => expect([counts.loads(), counts.lastTag()]).toEqual([1, 1]), WAIT);
    // Creating a battle Hero leads, or building this context's deps (as an out-of-memory load would), ends the worker.
    await expect(solve(safe1v1, { pool, workerContext: context('crash', safe1v1, { exitOnLead: 'Hero' }) })).rejects.toThrow('pool: a worker exited with code 3');
    await expect(solve(safe1v1, { pool, workerContext: context('doomed', safe1v1, { tag: 9, exitOnBuild: true }) })).rejects.toThrow('pool: a worker exited with code 4');
    await vi.waitFor(() => expect([liveWorkers(), counts.loads()]).toEqual([1, 3]), WAIT);
    expect([counts.doomed(), counts.lastTag()]).toEqual([1, 1]);
    expect((await solve(safe1v1, { pool, workerContext: context('good', safe1v1, { tag: 2 }) })).tier).toBe(1);   // adopted
    const slow = cancellable(slowStall, { pool, workerContext: context('slow', slowStall, { tag: 3 }) });
    await vi.waitFor(() => expect([slow.state.nodes > 0, counts.lastTag()]).toEqual([true, 3]), WAIT);
    slow.ctl.abort();
    expect((await slow.verdict).tier).toBe('unproven');
    await vi.waitFor(() => expect([liveWorkers(), counts.loads()]).toEqual([1, 4]), WAIT);
    expect([counts.lastTag(), counts.doomed()]).toEqual([2, 1]);
  }, SLOW);

  it('a worker that cannot start is not restarted in a loop: the next job that needs one reports why', async () => {
    const pool = opened(createSolverPool({ threads: 1, depsModule: CONTEXT_DEPS, execArgv: ['--import', 'plat-kaizo-no-such-loader'] }));
    const ctx = context('s', safe1v1);
    pool.warm(ctx);
    const gone = { timeout: 5_000, interval: 10 };
    await vi.waitFor(() => expect(liveWorkers()).toBe(0), gone);   // a worker that dies idle is replaced only when a job needs one
    await expect(solve(safe1v1, { pool, workerContext: ctx })).rejects.toThrow(/plat-kaizo-no-such-loader/);
    await vi.waitFor(() => expect(liveWorkers()).toBe(0), gone);
    expect(counts.loads()).toBe(0);
  }, SLOW);

  it('aborting a job that only waited in the queue restarts no worker that died idle', async () => {
    const pool = workerPool(2);
    pool.warm(context('doomed', safe1v1, { exitOnBuild: true }));   // both warm-up workers die idle
    await vi.waitFor(() => expect([liveWorkers(), counts.doomed()]).toEqual([0, 2]), WAIT);
    // One job at a time: the first runs on a worker started for it, the second waits in the queue.
    const lane = pool.lane({ limit: 1, context: context('slow', slowStall) });
    const slow = lane.run(rootJob(slowStall)).catch((e: unknown) => e);
    const stop = new AbortController();
    const queued = lane.run(rootJob(slowStall), stop.signal);
    expect([pool.busy, liveWorkers()]).toEqual([1, 1]);
    stop.abort();
    expect(liveWorkers()).toBe(1);
    await expect(queued).rejects.toThrow('the job was cancelled');
    expect(pool.busy).toBe(1);
    await pool.close();
    expect(await slow).toEqual(new Error('pool: closed while the job ran'));
  }, SLOW);
});
