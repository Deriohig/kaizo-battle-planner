import { describe, expect, it } from 'vitest';
import type { BattleInput, Engine, Rational } from '../../../src/contracts/engine.js';
import type { Progress, RankKey, SolveRequest, Verdict } from '../../../src/contracts/solver.js';
import type { StartStatus } from '../../../src/save/status.js';
import { DEFAULT_RANKING, resolveConfig } from '../../../src/solver/config.js';
import { createSolver } from '../../../src/solver/index.js';
import { betterRun, preStatusVariants } from '../../../src/solver/prestatus.js';
import type { RankVector } from '../../../src/solver/rank.js';
import { percent, rat, toJson } from '../../../src/solver/rational.js';
import { solveFights, type FightRun } from '../../../src/solver/solve.js';
import type { MonInfo, SolverDeps } from '../../../src/solver/types.js';
import { toyDeps } from './toy/deps.js';
import { createToyEngine } from './toy/engine.js';
import { scenarioFights, toyTeam } from './toy/fixtures.js';
import { refFightOf, refMinFailure, refTier1 } from './toy/referee.js';
import { preBurn, safe1v1, type Scenario } from './toy/scenarios.js';

const NONE: StartStatus = { kind: 'none' };
const BURN: StartStatus = { kind: 'burn' };
const POISON: StartStatus = { kind: 'poison' };
const PARALYSIS: StartStatus = { kind: 'paralysis' };
const PRE_SLEEP: StartStatus = { kind: 'sleep', turns: 1 };

/** One fight against the scenario's trainer with its whole p1 list as a fixed team, at its horizon, proposing pre-statuses. */
function request(s: Scenario, over: Partial<SolveRequest> = {}): SolveRequest {
  return {
    fights: [{ trainerId: s.trainerId }], team: { kind: 'fixed', party: s.p1.map((_, i) => `party:${i}`) }, preStatus: 'propose',
    budgetMs: 600_000, horizonTurns: s.horizon, attemptAnyLegalBadge: false, ranking: [], ...over,
  };
}

/** Solves `s` on an engine that records every battle's startStatus. */
async function solve(s: Scenario, opts: { req?: Partial<SolveRequest>; deps?: Partial<SolverDeps>; onProgress?: (p: Progress) => void } = {}) {
  const inner = createToyEngine(s.registry);
  const starts: BattleInput['startStatus'][] = [];
  const engine: Engine = { ...inner, createBattle: (input) => {
    starts.push(input.startStatus);
    return inner.createBattle(input);
  } };
  const v = await createSolver(toyDeps(s, { engine, ...opts.deps })).solve(request(s, opts.req), opts.onProgress);
  return { v, statusedStarts: starts.filter((st) => st !== undefined).length };
}

function tierOf<T extends Verdict['tier']>(v: Verdict, tier: T): Extract<Verdict, { tier: T }> {
  if (v.tier !== tier) throw new Error(`expected tier ${String(tier)}, got ${JSON.stringify({ tier: v.tier, ...(v.tier === 'unproven' ? { reason: v.reason, detail: v.detail } : {}) })}`);
  return v as Extract<Verdict, { tier: T }>;
}

/** The unstatused preBurn fight's least failure, from the referee. */
const preBurnFailure = (): Rational => refMinFailure(refFightOf(preBurn));

// Hero (faster, guts) Strikes 3: tier 1 in 2 turns. Burned, Strike 5 KOs Imp at once: a better line, never tried,
// because the baseline is already tier 1.
const gutsQuick: Scenario = {
  name: 'gutsQuick', p1: ['Hero'], trainerId: 'gutsQuick', horizon: 3, expect: {}, preStatusCandidates: { Hero: [BURN] },
  registry: {
    mons: { Hero: { name: 'Hero', maxHp: 10, speed: 10, guts: true, moves: [{ name: 'Strike', damage: [3] }] } },
    trainers: { gutsQuick: { id: 'gutsQuick', party: [{ name: 'Imp', maxHp: 5, speed: 5, moves: [{ name: 'Scratch', damage: [1] }] }] } },
    observeAll: true,
  },
};

describe('pre-status', () => {
  it('a proposed pre-burn turns tier 3 into tier 1', async () => {
    const ref = refFightOf(preBurn);
    expect([refTier1(ref), refTier1({ ...ref, leads: ref.leads.map((input) => ({ ...input, startStatus: { 0: BURN } })) })]).toEqual([false, true]);
    const { v } = await solve(preBurn);
    const failure = preBurnFailure();
    expect(tierOf(v, 1)).toMatchObject({ preStatus: { 'party:0': BURN }, preStatusBaseline: { tier: 3, deathProbability: failure }, rank: { turns: '2', worstMinHp: '1/5 (20.00%)' } });
    expect(v.report.verification.passed).toBe(true);
    expect(v.report.assumptions).toContain(`pre-status proposed: Hero (party:0) burn (1 of 1 tried); without it: tier 3, death ${toJson(failure)} (${percent(failure)})`);
  });

  it('given statuses are kept and nothing is proposed', async () => {
    const burned = tierOf((await solve(preBurn, { req: { preStatus: 'given', startStatus: { 'party:0': BURN } } })).v, 1);
    expect([burned.preStatus, 'preStatusBaseline' in burned]).toEqual([{ 'party:0': BURN }, false]);
    const plain = tierOf((await solve(preBurn, { req: { preStatus: 'given' } })).v, 3);
    expect([plain.preStatus, 'preStatusBaseline' in plain, plain.deathProbability]).toEqual([{}, false, preBurnFailure()]);
    expect(plain.report.assumptions.some((a) => a.startsWith('pre-status'))).toBe(false);
  });

  it('proposes nothing when the baseline is tier 1, or the deadline has passed', async () => {
    const quick = await solve(gutsQuick);
    const v = tierOf(quick.v, 1);
    expect([v.preStatus, 'preStatusBaseline' in v, quick.statusedStarts]).toEqual([{}, false, 0]);
    expect(v.report.assumptions).toContain('pre-status proposals: none tried (tier 1 without one)');
    // The burned line would have won the comparison: only the tier-1 rule kept it out.
    const deps = toyDeps(gutsQuick);
    const ctl = { deadline: Number.POSITIVE_INFINITY, checkerDeadline: Number.POSITIVE_INFINITY, progress: { node() {}, message() {}, teams() {} } };
    const run = (startStatus: Record<string, StartStatus>) => solveFights(deps, resolveConfig(deps.config), scenarioFights(gutsQuick, { startStatus }), request(gutsQuick, { startStatus }), ctl);
    const [plain, burned] = [run({}), run({ 'party:0': BURN })];
    expect([plain.verdict.tier, burned.verdict.tier, betterRun(burned, plain, DEFAULT_RANKING)]).toEqual([1, 1, true]);

    // A fake clock passes the search deadline (1,000) as the baseline's verdict is reported, before the checker's (2,000).
    let clock = 0;
    const late = await solve(preBurn, {
      req: { budgetMs: 1_000 }, deps: { now: () => clock, config: { progressIntervalMs: 0 } },
      onProgress: (p) => {
        if (p.message.startsWith('tier 3,')) clock = 1_500;
      },
    });
    const t3 = tierOf(late.v, 3);
    expect([t3.preStatus, 'preStatusBaseline' in t3, t3.deathProbability, late.statusedStarts]).toEqual([{}, false, preBurnFailure(), 0]);
    expect(t3.report.assumptions).toContain('pre-status proposals: 0 of 1 tried (cut short), none better than the result without one');
  });

  it('variants skip statused mons and cap at 12', () => {
    const base = toyTeam(safe1v1)[0]!;
    const info = (slot: number, candidates: StartStatus[], status: StartStatus = NONE): MonInfo => ({ ...base, ref: `party:${slot}`, status, preStatusCandidates: candidates });
    const team = [
      info(0, [BURN, { kind: 'sleep', turns: 3 }]),                       // pre-sleep is always counter 1
      info(1, [BURN], BURN),                                             // statused in the save
      info(2, [BURN]),                                                   // statused by `given`
      info(3, [NONE, POISON, PRE_SLEEP, { kind: 'sleep', turns: 2 }]),   // 'none' is no proposal; the second sleep repeats the first
      info(4, [BURN]),                                                   // a manual 'none' in `given` is the player's call too
    ];
    const given: Record<string, StartStatus> = { 'party:2': PARALYSIS, 'party:4': NONE };
    expect(preStatusVariants(team, given)).toEqual([
      { ...given, 'party:0': BURN }, { ...given, 'party:0': PRE_SLEEP }, { ...given, 'party:3': POISON }, { ...given, 'party:3': PRE_SLEEP },
    ]);
    expect(given).toEqual({ 'party:2': PARALYSIS, 'party:4': NONE });   // not mutated
    expect(preStatusVariants([info(0, [])], {})).toEqual([]);
    // Six mons with three candidates each: the first 12, in team order then candidate order.
    const capped = preStatusVariants(Array.from({ length: 6 }, (_, i) => info(i, [BURN, POISON, PARALYSIS])), {});
    expect(capped.map((v) => Object.entries(v).map(([ref, s]) => `${ref} ${s.kind}`).join())).toEqual(
      [0, 1, 2, 3].flatMap((slot) => ['burn', 'poison', 'paralysis'].map((kind) => `party:${slot} ${kind}`)),
    );
  });

  it('betterRun orders tiers, then each tier\'s figures', () => {
    const run = (verdict: object, vector: RankVector | null = null): FightRun => ({
      verdict: verdict as Verdict, certificate: null, vector, failure: null, refutation: null, complete: true,
    });
    const t1 = (pp: number, turns = 2): FightRun => run({ tier: 1 }, { minHpFrac: rat(9, 10), totalHp: 9, pp, turns, chanceDependencies: 0 });
    const t2 = (critBudget: number, p: Rational): FightRun => run({ tier: 2, critBudget, deathProbability: p });
    const t3 = (p: Rational): FightRun => run({ tier: 3, deathProbability: p });
    const unproven = run({ tier: 'unproven', reason: 'timeout', detail: 'not proven within the time limit' });

    // Tier 1 < 2 < 3 < unproven, whatever the figures.
    const ladder = [t1(0), t2(5, rat(1, 100)), t3(rat(1, 100)), unproven];
    for (const [i, a] of ladder.entries()) {
      for (const [j, b] of ladder.entries()) expect(betterRun(a, b, DEFAULT_RANKING), `${i} vs ${j}`).toBe(i < j);
    }
    // Within a tier: the rank vectors (an empty ranking is the default); budget then odds, in the ranking's order; odds.
    const cases: [string, FightRun, FightRun, readonly RankKey[]][] = [
      ['tier 1: more PP', t1(9), t1(8), []],
      ['tier 1: turns only', t1(8, 1), t1(9, 2), ['turns']],
      ['tier 2: higher budget', t2(1, rat(1, 4)), t2(0, rat(1, 16)), DEFAULT_RANKING],
      ['tier 2: then lower odds', t2(1, rat(1, 16)), t2(1, rat(1, 4)), DEFAULT_RANKING],
      ['tier 2: odds first', t2(0, rat(1, 16)), t2(1, rat(1, 4)), ['critDeathProbability', 'critBudget']],
      ['tier 3: lower odds', t3(rat(1, 4)), t3(rat(1, 2)), DEFAULT_RANKING],
    ];
    for (const [what, a, b, ranking] of cases) expect([betterRun(a, b, ranking), betterRun(b, a, ranking), betterRun(a, a, ranking)], what).toEqual([true, false, false]);
    // Two unproven runs, or a tier-1 run without a vector, are never better.
    expect([betterRun(unproven, run({ tier: 'unproven', reason: 'unmodelled', detail: '' }), DEFAULT_RANKING), betterRun(t1(9), run({ tier: 1 }, null), DEFAULT_RANKING)]).toEqual([false, false]);
  });
});
