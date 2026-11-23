import { describe, expect, it, vi } from 'vitest';
import type { PlanLeaf, PlanNode, Progress, RankKey, SolveRequest, Verdict } from '../../../src/contracts/solver.js';
import { resolveConfig } from '../../../src/solver/config.js';
import { createSolver } from '../../../src/solver/index.js';
import { defaultLabeler } from '../../../src/solver/labeler.js';
import { ONE, rat, ZERO } from '../../../src/solver/rational.js';
import { verificationOf } from '../../../src/solver/report.js';
import type { RiskResult } from '../../../src/solver/risk.js';
import { solveFights, type FightRun } from '../../../src/solver/solve.js';
import type { OracleResult, SolverDeps } from '../../../src/solver/types.js';
import { toyDeps } from './toy/deps.js';
import { createToyEngine } from './toy/engine.js';
import { tableFights } from './toy/fixtures.js';
import { toyOracles } from './toy/oracles.js';
import {
  aiUndefined, critOnlyBudget0, critOnlyBudget1, deadlyRolls, hiddenCounterSafe, mystery, safe1v1, stall, TABLES, twoSafeLines, unlabelledOnly,
  worldsSplit, type Scenario,
} from './toy/scenarios.js';
import { tableGame, type TableSpec } from './toy/table.js';

// solveRisk, wrapped so that a test can replace its result (a stubbed search answer the checker then contradicts).
const hooks = vi.hoisted(() => ({ risk: null as ((r: RiskResult) => RiskResult) | null }));
vi.mock('../../../src/solver/risk.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/solver/risk.js')>();
  return {
    ...real,
    solveRisk: (...args: Parameters<typeof real.solveRisk>) => {
      const r = real.solveRisk(...args);
      return hooks.risk === null ? r : hooks.risk(r);
    },
  };
});

async function withRisk<T>(hook: (r: RiskResult) => RiskResult, run: () => Promise<T>): Promise<T> {
  hooks.risk = hook;
  try {
    return await run();
  } finally {
    hooks.risk = null;
  }
}

/** A hook that marks the risk search's own line cut short, after `first` runs (a clock passing the deadline). */
const cutShort = (first: () => void) => (r: RiskResult): RiskResult => {
  first();
  return r.kind === 'line' ? { ...r, optimality: 'bestFoundWithinBudget', complete: false } : r;
};

const planted = { id: 'planted@1', check: (): OracleResult => ({ checks: 1, mismatches: ['planted'] }) };

/** One fight against `trainerId` with `party` as a fixed team, within `horizonTurns`. */
const request = (trainerId: string, party: string[], horizonTurns: number, over: Partial<SolveRequest> = {}): SolveRequest => ({
  fights: [{ trainerId }], team: { kind: 'fixed', party }, preStatus: 'given', budgetMs: 600_000, horizonTurns, attemptAnyLegalBadge: false, ranking: [], ...over,
});

interface SolveOpts { req?: Partial<SolveRequest>; deps?: Partial<SolverDeps>; onProgress?: (p: Progress) => void; signal?: AbortSignal }

function solve(s: Scenario, opts: SolveOpts = {}): Promise<Verdict> {
  return createSolver(toyDeps(s, opts.deps)).solve(request(s.trainerId, s.p1.map((_, i) => `party:${i}`), s.horizon, opts.req), opts.onProgress, opts.signal);
}

/** A solve whose fake clock jumps to 1,500 (past a 1,000 budget) once a tier-1 line is first reported. */
function solveLate(s: Scenario, deps: Partial<SolverDeps> = {}): { run: Promise<Verdict>; clock: () => number } {
  let clock = 0;
  const run = solve(s, {
    req: { budgetMs: 1_000 }, deps: { now: () => clock, config: { progressIntervalMs: 0 }, ...deps },
    onProgress: (p) => {
      if (p.bestTier === 1 && clock === 0) clock = 1_500;
    },
  });
  return { run, clock: () => clock };
}

function tierOf<T extends Verdict['tier']>(v: Verdict, tier: T): Extract<Verdict, { tier: T }> {
  if (v.tier !== tier) throw new Error(`expected tier ${String(tier)}, got ${JSON.stringify({ tier: v.tier, ...(v.tier === 'unproven' ? { reason: v.reason, detail: v.detail } : {}) })}`);
  return v as Extract<Verdict, { tier: T }>;
}

const unproven = (v: Verdict): Extract<Verdict, { tier: 'unproven' }> => tierOf(v, 'unproven');

/** The tree followed by branch labels, one per depth. */
function follow(tree: PlanNode, path: string[]): PlanNode | PlanLeaf {
  return path.reduce<PlanNode | PlanLeaf>((at, label) => {
    const next = 'result' in at ? undefined : at.branches.find((b) => b.label === label)?.next;
    if (next === undefined) throw new Error(`no branch ${JSON.stringify(label)} on path ${JSON.stringify(path)}`);
    return next;
  }, tree);
}

/** solveFights over a table game (one mon, one fight, oracles that check nothing) at horizon `h`; no probe. */
function solveTable(spec: TableSpec, h: number): FightRun {
  const t = tableGame(spec);
  const none = { id: 'none', check: (): OracleResult => ({ checks: 0, mismatches: [] }) };
  const unused = (): never => {
    throw new Error('a table game has no resolver');
  };
  const deps: SolverDeps = { engine: t.engine, enemyModel: t.ai, oracles: { damage: none, speed: none }, labeler: defaultLabeler, resolver: { mon: unused, fight: unused } };
  return solveFights(deps, resolveConfig({ probeHiddenInformation: false }), tableFights(t), request(t.input.trainer.id, ['party:0'], h), {
    deadline: Number.POSITIVE_INFINITY, checkerDeadline: Number.POSITIVE_INFINITY, progress: { node() {}, message() {}, teams() {} },
  });
}

// Hero against a double trainer: the resolver's battleType says so, or else the toy engine refuses it.
const doubles: Scenario = {
  ...safe1v1, name: 'doubles', trainerId: 'doubles',
  registry: { ...safe1v1.registry, trainers: { doubles: { ...safe1v1.registry.trainers.safe1v1!, id: 'doubles', double: true } } },
};
const singleListed: Scenario = { ...doubles, registry: { ...doubles.registry, trainers: { doubles: { ...doubles.registry.trainers.doubles!, double: false } } } };

describe('solve', () => {
  it('tier 1 verdict', async () => {
    const v = tierOf(await solve(safe1v1), 1);
    expect(v).toMatchObject({
      lead: 'party:0', team: ['party:0'], preStatus: {}, tree: { kind: 'player', actionLabel: 'Lead with Hero' }, anyLegalBadge: 'notAttempted', rank: { turns: '1' },
      report: {
        verification: { passed: true, mismatches: [] }, modelNote: 'model not yet verified in game', rejectedTeams: [],
        assumptions: expect.arrayContaining([expect.stringContaining('no mid-fight level-ups')]),
        enumerated: expect.arrayContaining(['1 world(s)', expect.stringMatching(/^AI support at level 1 \(\d+ supports\)$/)]),
      },
    });
    expect(Math.min(v.report.verification.damageChecks, v.report.nodes, v.report.turnExecutions)).toBeGreaterThan(0);
    expect(v).not.toHaveProperty('entries');   // a single fight is no gauntlet
    expect(tierOf(await solve(safe1v1, { deps: { config: { modelVerifiedInGame: true } } }), 1).report.modelNote).toBeNull();
  });

  it('tier 2 and tier 3 verdicts, with killers on the plan tree', async () => {
    const t2 = tierOf(await solve(critOnlyBudget1), 2);
    // One AI action: the worst case is the AI's own odds.
    expect(t2).toMatchObject({ critBudget: 1, deathProbability: rat(1, 16), guaranteeDeathProbability: rat(1, 16), report: { verification: { passed: true } } });
    expect(t2.killers.map((k) => [k.cause, k.probability])).toEqual([['enemy crit bash on turn 2 kills party 0', rat(1, 16)]]);
    const t3 = tierOf(await solve(deadlyRolls), 3);
    expect(t3).toMatchObject({ deathProbability: rat(7, 16), optimality: 'proven' });
    expect(t3).not.toHaveProperty('entries');
    expect(t3.killers.length).toBeGreaterThan(0);
    for (const v of [t2, t3]) for (const k of v.killers) expect(follow(v.tree, k.path)).toEqual({ result: 'death' });
  });

  it('a tier-2 line below its crit budget is a mismatch', async () => {
    // A search that claims budget 2 for critOnlyBudget1's line is contradicted by the checker's failing branch after 2 crit steps.
    const v = unproven(await withRisk((r) => (r.kind === 'line' && r.tier === 2 ? { ...r, critBudget: 2 } : r), () => solve(critOnlyBudget1)));
    expect([v.reason, v.detail, v.best, v.report.verification.passed]).toEqual([
      'verificationMismatch', 'tier 2 needs every failing branch to take more than 2 enemy crit step(s); the checker found one after 2', undefined, true,
    ]);
    expect(tierOf(await solve(critOnlyBudget1), 2).critBudget).toBe(1);
  });

  it.each<[string, Scenario, SolveOpts, object, Verdict['tier']?]>([
    ['an unmodelled item', mystery, {}, { reason: 'unmodelled', detail: expect.stringContaining('item mystery (Hero)') }, 1],
    ['an unlabelled outcome', unlabelledOnly, {}, { reason: 'unmodelled' }, 3],
    ['undefined AI behaviour', aiUndefined, {}, { reason: 'unmodelled', detail: expect.stringMatching(/undefined AI behaviour.*toy: undefined behaviour/) }],
    ['the horizon', stall, {}, { reason: 'horizon', best: { tier: 3, deathProbability: ONE, killers: [] } }, 3],   // all of it cut off
    ['an engine limit', critOnlyBudget0, { deps: { config: { maxLeaves: 1 } } }, { reason: 'engineLimit' }],
    ['a zero budget', safe1v1, { req: { budgetMs: 0 } }, { reason: 'timeout', detail: 'not proven within the time limit' }, undefined],
    ['a cancel', safe1v1, { signal: AbortSignal.abort() }, { reason: 'timeout', detail: 'cancelled' }],
    ['a double battle', doubles, {}, { reason: 'unsupportedBattle' }],
    ['a double battle only the engine refuses', singleListed, { deps: { engine: createToyEngine(doubles.registry) } }, { reason: 'unsupportedBattle' }],
    ['an empty team', safe1v1, { req: { team: { kind: 'fixed', party: [] } } }, { reason: 'noEligibleTeam' }],
    ['too many worlds', worldsSplit, { deps: { config: { maxWorlds: 1 } } }, {
      reason: 'unsupportedBattle', detail: '2 candidate worlds for disputed natures/abilities exceed the limit of 1; an in-game spot check settles them',
      report: { verification: { notCrossChecked: [] } },   // refused before any search: nothing checked
    }],
  ])('unproven: %s', async (_name, s, opts, want, ...best) => {
    const v = unproven(await solve(s, opts));
    expect(v).toMatchObject(want);
    if (best.length > 0) expect(v.best?.tier).toBe(best[0]);
  });

  it('a verification mismatch keeps the would-be verdict as best', async () => {
    // The engine adds 1 to every hit; the line is still a tier-1 proof on it, and the toy damage oracle refuses it.
    const v = unproven(await solve(twoSafeLines, { deps: { engine: createToyEngine({ ...twoSafeLines.registry, bugDamagePlusOne: true }) } }));
    expect(v).toMatchObject({ reason: 'verificationMismatch', detail: expect.stringMatching(/^damage oracle toy-damage@1: /), best: { tier: 1 }, report: { verification: { passed: false } } });
    expect(v.report.verification.mismatches[0]).toBe(v.detail);
  });

  it('tier 1 met an unmodelled outcome: the verdict is unmodelled, not horizon or a risk claim', async () => {
    // Wild wins only through an unlabelled outcome, Poke only on the horizon: the risk line passes, tier 1 is not refuted.
    const wildOrPoke: Scenario = {
      name: 'wildOrPoke', p1: ['Hero'], trainerId: 'wildOrPoke', horizon: 2, expect: {},
      registry: {
        mons: { Hero: { name: 'Hero', maxHp: 10, speed: 10, moves: [{ name: 'Wild', damage: [4], effect: 'raw3' }, { name: 'Poke', damage: [4], accuracy: rat(1, 2) }] } },
        trainers: { wildOrPoke: { id: 'wildOrPoke', party: [{ name: 'Imp', maxHp: 4, speed: 5, moves: [{ name: 'Scratch', damage: [1] }] }] } },
        observeAll: true,
      },
    };
    const w = unproven(await solve(wildOrPoke));
    expect(w).toMatchObject({ reason: 'unmodelled', detail: expect.stringMatching(/^tier 1 met an unmodelled outcome: .*unlabelled outcome on turn 1$/) });
    expect(tierOf(w.best!, 3)).toMatchObject({ deathProbability: rat(1, 4), report: { verification: { passed: true } } });
    // deadOrRaw: A dies half the time, B wins only through an unlabelled outcome, so A is only the best found.
    const mixed = unproven(solveTable(TABLES.deadOrRaw, 3).verdict);
    expect(mixed).toMatchObject({ reason: 'unmodelled', detail: expect.stringMatching(/^tier 1 met an unmodelled outcome: /) });
    expect(tierOf(mixed.best!, 3)).toMatchObject({ deathProbability: rat(1, 2), optimality: 'bestFoundWithinBudget', report: { verification: { passed: true } } });
    // bothDie: every choice dies, tier 1 is refuted, and the least death (B, 1/4) is proven.
    expect(tierOf(solveTable(TABLES.bothDie, 3).verdict, 3)).toMatchObject({ deathProbability: rat(1, 4), optimality: 'proven' });
  });

  it('tier 1 unresolved at 60% of the budget leaves the rest to tiers 2 and 3, and the verdict stays unproven', async () => {
    let clock = 0;
    const v = unproven(await solve(critOnlyBudget1, {
      req: { budgetMs: 1_000 }, deps: { now: () => clock, config: { progressIntervalMs: 0 } },
      onProgress: (p) => {
        if (clock === 0 && p.message.startsWith('tier 1, horizon')) clock = 700;
      },
    }));
    expect([clock, v.reason, v.detail]).toEqual([700, 'timeout', 'not proven within the time limit']);
    expect(tierOf(v.best!, 2)).toMatchObject({ critBudget: 1, deathProbability: rat(1, 16), report: { verification: { passed: true } } });
  });

  it('a verified line stands when a refinement is cut short', async () => {
    // No edge cache: every step of the extraction, the stats and the plan reaches the engine past the deadline.
    const late = solveLate(twoSafeLines, { config: { progressIntervalMs: 0, edgeCacheEntries: 0 } });
    const v = tierOf(await late.run, 1);
    expect([late.clock(), v.rank.turns, v.report.verification.passed]).toEqual([1_500, '2', true]);   // the ranking never improved the line
    expect(v.report.assumptions).toContain('ranking stopped early (the time limit): the line is proven safe and checked, but a better-ranked safe line may exist');
    expect(tierOf(await solve(twoSafeLines), 1).report.assumptions.filter((a) => a.startsWith('ranking stopped early'))).toEqual([]);

    // Tiers 2 and 3 cut short: a checked line is still a claim. Tier 3 is only the best found; tier 2 says so in the report.
    let clock = 0;
    const atDeadline = cutShort(() => (clock = 1_500));
    const opts = { req: { budgetMs: 1_000 }, deps: { now: () => clock } };
    const t3 = tierOf(await withRisk(atDeadline, () => solve(deadlyRolls, opts)), 3);
    expect(t3).toMatchObject({ deathProbability: rat(7, 16), optimality: 'bestFoundWithinBudget', report: { verification: { passed: true } } });
    clock = 0;
    const t2 = tierOf(await withRisk(atDeadline, () => solve(critOnlyBudget1, opts)), 2);
    expect(t2).toMatchObject({ critBudget: 1, deathProbability: rat(1, 16), report: { verification: { passed: true } } });
    expect(t2.report.assumptions)
      .toContain('tier-2 search stopped early (the time limit): the line is checked and its crit budget proven, but a larger budget or a lower death chance may exist');
  });

  it('a stopped-early note only on a claim', async () => {
    // A cut-short ranking or tier-2 search plus a checker mismatch: neither the verdict nor its best may say "checked".
    const checkedClaims = (v: Verdict): string[] => [v.report, ...(v.tier === 'unproven' && v.best !== undefined ? [v.best.report] : [])]
      .flatMap((r) => r.assumptions.filter((a) => / stopped early \(.*: the line is (proven safe and )?checked/.test(a)));
    const late = solveLate(twoSafeLines, { oracles: { ...toyDeps(twoSafeLines).oracles, damage: planted } });
    const v = unproven(await late.run);
    expect([late.clock(), v.reason, v.best?.tier, checkedClaims(v)]).toEqual([1_500, 'verificationMismatch', 1, []]);
    expect(v.detail).toMatch(/^damage oracle planted@1: planted /);
    let clock = 0;
    const w = unproven(await withRisk(cutShort(() => (clock = 1_500)), () => solve(critOnlyBudget1, {
      req: { budgetMs: 1_000 }, deps: { now: () => clock, oracles: { ...toyDeps(critOnlyBudget1).oracles, damage: planted } },
    })));
    expect([w.reason, w.best?.tier, checkedClaims(w)]).toEqual(['verificationMismatch', 2, []]);
  });

  it('a turnless loop tie takes the way out', () => {
    // M's 'back' returns to M (no turn taken), 'on' dies: both fail with 1, and the loop's certificate would cycle.
    const run = solveTable({
      start: 'T',
      nodes: {
        T: { phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to: 'M', p: ONE }] } },
        M: { phase: 'playerMidTurnSwitch', p1: ['back', 'on'], next: { 'back|': [{ to: 'M', p: ONE }], 'on|': [{ to: 'dead', p: ONE, faintP1: true }] } },
        dead: { phase: 'lose', next: {} },
      },
    }, 3);
    expect(tierOf(run.verdict, 3)).toMatchObject({ deathProbability: ONE, report: { verification: { passed: true, mismatches: [] } } });
    expect(run.certificate?.nodes.map((n) => n.action)).toEqual([{ kind: 'switch', index: 0 }, { kind: 'move', slot: 0 }, { kind: 'move', slot: 1 }]);
  });

  it('progress is reported', async () => {
    const seen: Progress[] = [];
    const v = tierOf(await solve(twoSafeLines, { onProgress: (p) => seen.push(p) }), 1);
    expect(seen.at(-1)).toMatchObject({ nodes: v.report.nodes, teamsTried: 0, teamsTotal: 1, bestTier: 1 });
    expect(seen.some((p) => /tier 1/.test(p.message) && /\d nodes/.test(p.message))).toBe(true);
    for (const [i, p] of seen.entries()) if (i > 0) expect(p.elapsedMs).toBeGreaterThanOrEqual(seen[i - 1]!.elapsedMs);
  });

  it('ranking from the request', async () => {
    const turnsFirst: RankKey[] = ['turns', 'worstMinHp', 'totalHp', 'pp', 'chanceDependencies'];
    expect(tierOf(await solve(twoSafeLines, { req: { ranking: turnsFirst } }), 1).rank.turns).toBe('2');   // Strike, Strike
    expect(tierOf(await solve(twoSafeLines), 1).rank).toMatchObject({ turns: '4', worstMinHp: '4/5 (80.00%)' });   // the default: healthiest end first
  });

  it('the verdict lists the hits the damage calc did not cross-check, most hits first, then by move name', async () => {
    // Bonk hits 3 times over the checker's walk, Strike twice; an oracle skipping both still passes.
    const v = tierOf(await solve(hiddenCounterSafe, { deps: { oracles: toyOracles(hiddenCounterSafe.registry, { skip: ['Strike', 'Bonk'] }) } }), 1);
    expect(v.report.verification).toMatchObject({ notCrossChecked: [{ move: 'Bonk', hits: 3 }, { move: 'Strike', hits: 2 }], passed: true, damageChecks: 0 });
    expect(tierOf(await solve(hiddenCounterSafe), 1).report.verification.notCrossChecked).toEqual([]);
    const check = {
      passed: true, mismatches: [], unmodelled: [], damageChecks: 0, orderChecks: 0, statesVisited: 1, worlds: 1, notCrossChecked: { Stomp: 1, Counter: 2, Bide: 1 },
      failureAi: ZERO, failureWorst: ZERO, cutoffAi: ZERO, critBudget: null, worstEnd: null, maxTurns: 1, killers: [], endStates: [],
    };
    expect(verificationOf(check).notCrossChecked).toEqual([{ move: 'Counter', hits: 2 }, { move: 'Bide', hits: 1 }, { move: 'Stomp', hits: 1 }]);
    expect(verificationOf(null).notCrossChecked).toEqual([]);
  });
});
