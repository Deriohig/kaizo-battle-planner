// Every searching caller hands the engine a shouldStop, maps STOPPED to its own timeout path and keeps a stopped step
// nowhere. The stub engine spins inside expandTurn until shouldStop says stop or SPIN_MS pass (an engine that never polls).

import { describe, expect, it } from 'vitest';
import type { Choice, Engine } from '../../../src/contracts/engine.js';
import type { Verdict } from '../../../src/contracts/solver.js';
import { ArenaLimitError, type Arena } from '../../../src/solver/arena.js';
import { attemptBadge, probeHiddenInformation } from '../../../src/solver/badge.js';
import { beliefChoices, rootBelief } from '../../../src/solver/belief.js';
import { certificateFromPolicy, certificateStats, extractProof, type Certificate } from '../../../src/solver/certificate.js';
import type { CheckResult } from '../../../src/solver/check/checker.js';
import { DEFAULT_CONFIG, DEFAULT_RANKING, resolveConfig } from '../../../src/solver/config.js';
import { createSolver } from '../../../src/solver/index.js';
import { defaultLabeler } from '../../../src/solver/labeler.js';
import { renderPlan } from '../../../src/solver/plan.js';
import { Prover } from '../../../src/solver/prove.js';
import { rankProven } from '../../../src/solver/rank.js';
import { ONE, ZERO } from '../../../src/solver/rational.js';
import { solveRisk } from '../../../src/solver/risk.js';
import { checkLine, rootUnmodelled } from '../../../src/solver/solve.js';
import { createResultStore } from '../../../src/solver/store.js';
import type { SolverDeps } from '../../../src/solver/types.js';
import { createToyAi } from './toy/ai.js';
import { toyDeps } from './toy/deps.js';
import { createToyEngine } from './toy/engine.js';
import { makeArena, scenarioFights } from './toy/fixtures.js';
import { toyOracles } from './toy/oracles.js';
import { critOnlyBudget1, deadlyRolls, hiddenCounterSafe, safe1v1, twoSafeLines, type Scenario } from './toy/scenarios.js';

const SPIN_MS = 2_000;
/** A run the stop ends must end well within this, against SPIN_MS without it. */
const ON_TIME_MS = 400;
const L1 = { level: 1, critCap: null } as const;
const move = (slot: number) => ({ kind: 'move', slot }) as const;
const lead = (index: number) => ({ kind: 'switch', index }) as const;
const stoppedError = (): Error => Object.assign(new Error('engine: the step was stopped (shouldStop)'), { code: 'STOPPED' as const });
const now = (): number => performance.now();

/**
 * A toy engine for `s` whose expandTurn polls shouldStop on entry and, on its `from`-th to `to`-th calls (1-based, read at
 * each call), spins until shouldStop is true (STOPPED) or SPIN_MS pass. Counts calls and spins.
 */
function spinning(s: Scenario, opts: { from?: number; to?: number; onSpin?: (ms: number) => void } = {}) {
  const engine = createToyEngine(s.registry);
  let [calls, spun] = [0, 0];
  const wrapped: Engine = {
    ...engine,
    expandTurn(state, choices, o) {
      calls += 1;
      const stop = o?.shouldStop;
      if (stop?.() === true) throw stoppedError();
      if (calls >= (opts.from ?? 1) && calls <= (opts.to ?? Number.POSITIVE_INFINITY)) {
        spun += 1;
        for (let ms = 0, began = now(); ms < SPIN_MS; ms = now() - began) {
          opts.onSpin?.(ms);
          if (stop?.() === true) throw stoppedError();
        }
      }
      return engine.expandTurn(state, choices, o?.maxLeaves === undefined ? undefined : { maxLeaves: o.maxLeaves });
    },
  };
  return { engine: wrapped, calls: () => calls, spun: () => spun };
}

/** A toy engine for `s` that throws STOPPED when `stopsOn(shouldStop)` is true; counts the steps asked and stopped. */
function stopping(s: Scenario, stopsOn: (stop: (() => boolean) | undefined) => boolean) {
  const toy = createToyEngine(s.registry);
  const n = { asked: 0, stopped: 0 };
  const engine: Engine = {
    ...toy,
    expandTurn(state, choices, o) {
      n.asked += 1;
      if (stopsOn(o?.shouldStop)) {
        n.stopped += 1;
        throw stoppedError();
      }
      return toy.expandTurn(state, choices, o?.maxLeaves === undefined ? undefined : { maxLeaves: o.maxLeaves });
    },
  };
  return { engine, n };
}

const arenaOf = (s: Scenario, engine: Engine = createToyEngine(s.registry), opts?: { edgeCacheEntries: number }): Arena =>
  makeArena(scenarioFights(s), engine, createToyAi(s.registry), opts);

/** A solve of `s` with a 1-mon fixed team and the given budget. */
const solveOn = (s: Scenario, engine: Engine, budgetMs: number, signal?: AbortSignal): Promise<Verdict> => createSolver(toyDeps(s, { engine })).solve({
  fights: [{ trainerId: s.trainerId }], team: { kind: 'fixed', party: ['party:0'] }, preStatus: 'given', budgetMs, horizonTurns: s.horizon, attemptAnyLegalBadge: false, ranking: [],
}, undefined, signal);

function caught(run: () => unknown): Error {
  try {
    run();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a throw');
}

/** `run(began)`, which must end within ON_TIME_MS. */
async function onTime<T>(run: (began: number) => T | Promise<T>): Promise<T> {
  const began = now();
  const out = await run(began);
  expect(now() - began).toBeLessThan(ON_TIME_MS);
  return out;
}

/** A level-1 (or G_j) prover that has deepened `s` on `arena` to its horizon with the result `kind`. */
function proverDone(arena: Arena, s: Scenario, opts: { critBudget?: number; signal?: AbortSignal; kind?: 'win' | 'fail' } = {}) {
  const prover = new Prover(arena, {
    params: { level: 1, critBudget: opts.critBudget ?? null, thresholds: null }, mode: 'display', deadline: Number.POSITIVE_INFINITY, now,
    labeler: defaultLabeler, history: new Map(), ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  const { result, horizon } = prover.deepen(rootBelief(arena), s.horizon);
  expect(result.kind, s.name).toBe(opts.kind ?? 'win');
  return { prover, horizon };
}

function proofOn(arena: Arena, s: Scenario): Certificate {
  const { prover, horizon } = proverDone(arena, s);
  return extractProof(prover, rootBelief(arena), horizon);
}

/** The engine steps G_0 makes on `s` (on a fresh arena: the same steps the search makes first). */
function g0Steps(s: Scenario, kind: 'win' | 'fail'): number {
  const count = spinning(s, { from: Number.POSITIVE_INFINITY });
  proverDone(arenaOf(s, count.engine), s, { critBudget: 0, kind });
  return count.calls();
}

describe('a deadline or a stop interrupts an engine step', () => {
  it('in a solve: a 50 ms budget ends on time (timeout), and the player\'s stop ends it at once (cancelled)', async () => {
    const spin = spinning(safe1v1);
    const v = await onTime(() => solveOn(safe1v1, spin.engine, 50));
    expect([spin.spun() > 0, v]).toEqual([true, expect.objectContaining({ tier: 'unproven', reason: 'timeout', detail: 'not proven within the time limit' })]);
    const stop = new AbortController();   // arrives 50 ms into the step
    const late = spinning(safe1v1, { onSpin: (ms) => (ms > 50 ? stop.abort() : undefined) });
    const w = await onTime(() => solveOn(safe1v1, late.engine, 60_000, stop.signal));
    expect([stop.signal.aborted, w]).toEqual([true, expect.objectContaining({ tier: 'unproven', reason: 'timeout', detail: 'cancelled' })]);
  });

  // The first engine step after G_0's own spins: deadlyRolls' G_0 fails, then the value search; critOnlyBudget1's wins, then G_1.
  it.each<[string, Scenario, 'win' | 'fail', object]>([
    ['the risk value search (unknown timeout)', deadlyRolls, 'fail', { kind: 'unknown', cause: 'timeout' }],
    ["a G_j prover (the crit-budget loop keeps G_0's line)", critOnlyBudget1, 'win', { kind: 'line', tier: 2, critBudget: 0, optimality: 'bestFoundWithinBudget', complete: false }],
  ])('in %s', async (_name, s, g0, want) => {
    const first = g0Steps(s, g0) + 1;
    const spin = spinning(s, { from: first, to: first });
    const arena = arenaOf(s, spin.engine);
    const r = await onTime((began) => solveRisk(arena, rootBelief(arena), {
      horizon: s.horizon, ranking: DEFAULT_RANKING, mode: 'display', deadline: began + 200, now, labeler: defaultLabeler, history: new Map(),
    }));
    expect([spin.spun(), r]).toEqual([1, expect.objectContaining(want)]);
  });

  it('in the checker: a cut-short check is a timeout, never a mismatch (alone and compared)', async () => {
    const s = hiddenCounterSafe;
    const plain = toyDeps(s);
    const cert = proofOn(arenaOf(s), s);
    for (const compare of [false, true]) {
      const spin = spinning(s);
      const store = createResultStore(spin.engine, createToyAi(s.registry), { maxBytes: 268_435_456, freeze: true });
      const deps: SolverDeps = compare
        ? { ...plain, engine: store.engine, enemyModel: store.ai, bare: { engine: spinning(s).engine, enemyModel: createToyAi(s.registry), oracles: plain.oracles } }
        : { ...plain, engine: spin.engine };
      const checked = await onTime((began) => checkLine({ deps, cfg: resolveConfig({ checkerCompare: compare }), fights: scenarioFights(s), labeler: defaultLabeler, checkerDeadline: began + 50 }, cert));
      expect([spin.spun() > 0, checked.stopped, checked.finished, checked.result.reason, checked.result.mismatches], `compare ${compare}`).toEqual([true, true, false, 'timeout', []]);
    }
  });

  it('in the ranking, the badge\'s level-2 prover and the hidden-information probe', async () => {
    const opts = { from: Number.POSITIVE_INFINITY };
    const spin = spinning(twoSafeLines, opts);
    const arena = arenaOf(twoSafeLines, spin.engine);
    const root = rootBelief(arena);
    const won = proverDone(arena, twoSafeLines);
    const rankOpts = (deadline: number) => ({ ranking: DEFAULT_RANKING, level: 1 as const, mode: 'display' as const, deadline, now, labeler: defaultLabeler, history: new Map<string, Choice>() });
    const line = { certificate: extractProof(won.prover, root, won.horizon), horizon: twoSafeLines.horizon };
    opts.from = spin.calls() + 1;   // the ranking's first engine step spins
    const r = await onTime((began) => rankProven(arena, root, line, rankOpts(began + 100)));
    expect([spin.spun(), r.complete, r.stopped]).toEqual([1, false, ['the time limit']]);

    // Level 2 is another game: its first expansion reaches the engine, and spins. Its check never passes.
    const notPassed: CheckResult = {
      passed: false, reason: 'verificationMismatch', mismatches: ['not at level 2'], unmodelled: [], damageChecks: 0, orderChecks: 0, statesVisited: 0,
      worlds: 1, notCrossChecked: {}, failureAi: ONE, failureWorst: ONE, cutoffAi: ZERO, critBudget: -1, worstEnd: null, maxTurns: 0, killers: [], endStates: [],
    };
    const badgeOpts = { from: Number.POSITIVE_INFINITY };
    const badgeSpin = spinning(safe1v1, badgeOpts);
    const ai = createToyAi(safe1v1.registry);
    const badgeArena = makeArena(scenarioFights(safe1v1), badgeSpin.engine, ai);
    const badgeRoot = rootBelief(badgeArena);
    const safeWon = proverDone(badgeArena, safe1v1);
    const ranked = rankProven(badgeArena, badgeRoot, { certificate: extractProof(safeWon.prover, badgeRoot, safeWon.horizon), horizon: safe1v1.horizon }, rankOpts(Number.POSITIVE_INFINITY));
    badgeOpts.from = badgeSpin.calls() + 1;
    const badge = await onTime((began) => attemptBadge(badgeArena, badgeRoot, ranked, {
      ranking: DEFAULT_RANKING, mode: 'display', horizon: safe1v1.horizon, deadline: began + 100, now, labeler: defaultLabeler, history: new Map(),
      engine: badgeSpin.engine, enemyModel: ai, fights: scenarioFights(safe1v1), oracles: toyOracles(safe1v1.registry), check: () => notPassed,
    }));
    expect([badgeSpin.spun(), badge]).toEqual([1, { status: 'failed', detail: 'not proven at level 2 within its budget' }]);

    const probeSpin = spinning(safe1v1);
    const found = await onTime((began) => probeHiddenInformation(arenaOf(safe1v1, probeSpin.engine), safe1v1.horizon, { deadline: began + 100, now, labeler: defaultLabeler }));
    expect([probeSpin.spun(), found]).toEqual([1, false]);
  });

  it('a stopped step is kept nowhere (arena, store), and a stop is never an engine limit', () => {
    const { engine, n } = stopping(deadlyRolls, (stop) => stop?.() === true);
    const store = createResultStore(engine, createToyAi(deadlyRolls.registry), { maxBytes: 268_435_456, freeze: true });
    const arena = makeArena(scenarioFights(deadlyRolls), store.engine, store.ai, { edgeCacheEntries: DEFAULT_CONFIG.edgeCacheEntries });
    const member = arena.expand(arena.root(), lead(0), L1).successors[0]!.member!;   // after the lead: no engine step yet
    let polls = 0;   // the arena's own poll says go on; the engine's poll on entry says stop
    const e = caught(() => arena.expand(member, move(0), { ...L1, stop: () => ++polls > 1 }));
    expect([e.name, e instanceof ArenaLimitError, /limit/.test(e.message), n.stopped, arena.stats.expansions]).toEqual(['ArenaStopError', false, false, 1, 1]);
    // Asked again without a stop: the engine is asked again (no store entry) and the arena has no cached edge.
    const before = n.asked;
    const x = arena.expand(member, move(0), L1);
    expect([n.asked > before, n.stopped, arena.stats.edgeHits]).toEqual([true, 1, 0]);
    expect(arena.expand(member, move(0), L1)).toEqual(x);
    expect(arena.stats.edgeHits).toBe(1);
  });
});

describe('extraction and post-search work run past the deadline', () => {
  it('extractProof stops on the signal only, never on the deadline', () => {
    for (const s of [twoSafeLines, hiddenCounterSafe]) {
      const want = proofOn(arenaOf(s), s);
      const late = arenaOf(s, undefined, { edgeCacheEntries: 0 });
      const won = proverDone(late, s);
      won.prover.deadline = Number.NEGATIVE_INFINITY;
      expect(extractProof(won.prover, rootBelief(late), won.horizon), s.name).toEqual(want);
      const stop = new AbortController();
      const cancelled = arenaOf(s, undefined, { edgeCacheEntries: 0 });
      const aborted = proverDone(cancelled, s, { signal: stop.signal });
      stop.abort();
      expect(caught(() => extractProof(aborted.prover, rootBelief(cancelled), aborted.horizon)).name, s.name).toBe('ArenaStopError');
    }
  });

  it('renderPlan, certificateStats, certificateFromPolicy and rootUnmodelled ask with no stop', () => {
    // An engine that throws STOPPED whenever it is handed a shouldStop, under an arena with no edge cache.
    const s = hiddenCounterSafe;
    const cert = proofOn(arenaOf(s), s);
    const { engine, n } = stopping(s, (stop) => stop !== undefined);
    const arena = arenaOf(s, engine, { edgeCacheEntries: 0 });
    const stops: unknown[] = [];
    const expand = arena.expand.bind(arena);
    arena.expand = (member, choice, opts) => {
      stops.push(opts.stop);
      return expand(member, choice, opts);
    };
    const root = rootBelief(arena);
    const first = (b: Parameters<typeof beliefChoices>[1]): Choice | null => beliefChoices(arena, b)[0] ?? null;
    const work: [string, () => unknown][] = [
      ['renderPlan', () => renderPlan(arena, cert, { labeler: defaultLabeler, nodeLimit: DEFAULT_CONFIG.planNodeLimit })],
      ['certificateStats', () => certificateStats(arena, cert)],
      ['certificateFromPolicy', () => certificateFromPolicy(arena, root, first, { level: 1, mode: 'display', horizon: s.horizon, critBudget: null })],
      ['rootUnmodelled', () => rootUnmodelled(toyDeps(s), resolveConfig(), arena, root, undefined)],
    ];
    for (const [what, run] of work) {
      const before = stops.length;
      run();
      expect(stops.length, what).toBeGreaterThan(before);
      expect(stops.slice(before).every((x) => x === undefined), what).toBe(true);
    }
    expect([n.asked > 0, n.stopped]).toEqual([true, 0]);
  });
});
