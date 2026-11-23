// This thread's re-check of worker lines and the root split's verdict (solve.ts combineLeads), without threads: each
// lead's run is runJob through a structured clone, as a pool worker answers. Faults: skewed oracles and fake clocks.

import { describe, expect, it } from 'vitest';
import type { Outcome } from '../../../src/contracts/engine.js';
import type { SolveRequest, Verdict } from '../../../src/contracts/solver.js';
import { Arena, emptyStats } from '../../../src/solver/arena.js';
import { beliefChoices, rootBelief } from '../../../src/solver/belief.js';
import { resolveConfig } from '../../../src/solver/config.js';
import { fromJobResult, runJob, type Job } from '../../../src/solver/parallel/jobs.js';
import { combineLeads, teamFights, type FightRun, type LeadRun, type ProgressSink } from '../../../src/solver/solve.js';
import type { StoreOptions } from '../../../src/solver/store.js';
import type { SolverDeps } from '../../../src/solver/types.js';
import { ledBy, skewedOracles, toyDeps } from './toy/deps.js';
import { readToyState } from './toy/engine.js';
import { safe1v1, uturnLine, type Scenario } from './toy/scenarios.js';

const INF = Number.POSITIVE_INFINITY;
const CFG = resolveConfig({ threads: 2, progressIntervalMs: 0 });
const SILENT: ProgressSink = { node() {}, message() {}, teams() {} };
const DISAGREES = "this thread's re-check of the worker's line disagrees: ";
const WORKER_ONLY = "this line was checked by a worker thread only; this thread's re-check did not finish";
const WORKER_CUT = "the worker's check of this line did not finish; this thread did not re-check it";
const DISPUTED = "this thread's re-check of this line disagrees with the worker's check (see the verdict detail)";
const TIMEOUT = { tier: 'unproven', reason: 'timeout', detail: 'not proven within the time limit' };
const has = (text: string) => ({ report: { assumptions: expect.arrayContaining([text]) } });

/** A root split of the scenario's fixed team: its fights, arena, root and leads, as splitFights builds them. */
function split(s: Scenario, over: Partial<SolveRequest> = {}, cfg = CFG) {
  const req: SolveRequest = {
    fights: [{ trainerId: s.trainerId }], team: { kind: 'fixed', party: s.p1.map((_, i) => `party:${i}`) }, preStatus: 'given',
    budgetMs: 600_000, horizonTurns: s.horizon, attemptAnyLegalBadge: false, ranking: [], ...over,
  };
  const deps = toyDeps(s);
  const fights = teamFights(req, req.fights.map((spec) => deps.resolver.fight(spec)), s.p1.map((_, i) => deps.resolver.mon(`party:${i}`)));
  const arena = new Arena({ engine: deps.engine, enemyModel: deps.enemyModel, fights, edgeCacheEntries: cfg.edgeCacheEntries, maxLeaves: cfg.maxLeaves, stats: emptyStats() });
  const root = rootBelief(arena);
  return { s, req, cfg, fights, arena, root, leads: beliefChoices(arena, root) };
}
type Split = ReturnType<typeof split>;

/** What a worker answers for lead `i`; deadlines on the worker deps' clock. */
function workerRun(sp: Split, i: number, opts: { deps?: SolverDeps; deadline?: number; checkerDeadline?: number; progress?: ProgressSink } = {}): LeadRun {
  const job: Job = {
    kind: 'root', req: sp.req, team: sp.fights[0]!.team.map((m) => m.ref), restrictRoot: [sp.leads[i]!], config: sp.cfg,
    deadline: opts.deadline ?? INF, checkerDeadline: opts.checkerDeadline ?? INF,
  };
  const result = structuredClone(runJob(opts.deps ?? toyDeps(sp.s), job, opts.progress));
  return { run: fromJobResult(result), nodes: result.nodes, label: sp.fights[0]!.team[i]!.label };
}

/** The split's verdict on this thread from the lead runs, with this thread's deps and clock. */
function combine(sp: Split, runs: LeadRun[], opts: { deps?: SolverDeps; now?: () => number; checkerDeadline?: number } = {}): FightRun {
  const now = opts.now ?? (() => 0);
  const ctl = { deadline: INF, checkerDeadline: opts.checkerDeadline ?? INF, progress: SILENT };
  return combineLeads({ deps: { ...(opts.deps ?? toyDeps(sp.s)), now }, cfg: sp.cfg, now }, { arena: sp.arena, root: sp.root, fights: sp.fights, req: sp.req, ctl, started: now() }, runs);
}

/** The toy deps of `s` with a skewed damage oracle on battles `who` leads. */
function skew(s: Scenario, who: string, kind: 'count' | 'skipped' | 'mismatch'): SolverDeps {
  const deps = toyDeps(s);
  return { ...deps, oracles: skewedOracles(deps.oracles, ledBy(who), kind) };
}

/** A clock that jumps 10 s per reading: a re-check on it is cut short at once. */
function jumping(): () => number {
  let t = 0;
  return () => (t += 10_000);
}

function unproven(v: Verdict): Extract<Verdict, { tier: 'unproven' }> {
  if (v.tier !== 'unproven') throw new Error(`expected unproven, got tier ${v.tier}`);
  return v;
}

describe('the re-check of worker lines', () => {
  it.each([
    { kind: 'count', head: /^damage checks (\d+) here, the worker's (\d+)$/, more: {} },
    {
      kind: 'skipped', head: /^hits not cross-checked none here, the worker's Counter ×1$/,
      more: { report: { verification: { notCrossChecked: [] } }, best: { report: { verification: { notCrossChecked: [{ move: 'Counter', hits: 1 }] } } } },
    },
  ] as const)('worker $kind that alone differ: a mismatch when both checks finish, a timeout when the re-check is cut short', ({ kind, head, more }) => {
    // Counts are deterministic, so two finished checks that differ in them mean the worker's set-up differs.
    const sp = split(safe1v1);
    const worker = workerRun(sp, 0, { deps: skew(safe1v1, 'Hero', kind) });
    const v = unproven(combine(sp, [worker]).verdict);
    expect(v).toMatchObject({ reason: 'verificationMismatch', best: { tier: 1, ...has(DISPUTED) }, ...more });
    const lead = `lead Hero: ${DISAGREES}`;
    const text = v.detail.split(' (this thread')[0]!;
    const m = text.startsWith(lead) ? head.exec(text.slice(lead.length)) : null;
    expect(m, v.detail).not.toBeNull();
    if (m?.[1] !== undefined) expect(Number(m[2])).toBeGreaterThan(Number(m[1]));   // here and the worker's in order
    expect(combine(sp, [worker], { now: jumping(), checkerDeadline: 0 }).verdict).toMatchObject({ ...TIMEOUT, best: has(WORKER_ONLY) });
  });

  it("a genuine disagreement is a mismatch; the disputed line keeps the worker's passed report", () => {
    const sp = split(safe1v1);
    const v = unproven(combine(sp, [workerRun(sp, 0)], { deps: skew(safe1v1, 'Hero', 'mismatch') }).verdict);
    expect(v.detail.startsWith(`lead Hero: ${DISAGREES}passed false, the worker's true; reason verificationMismatch, the worker's none; mismatches differ`)).toBe(true);
    expect(v).toMatchObject({ reason: 'verificationMismatch', best: { tier: 1, report: { verification: { passed: true }, assumptions: expect.arrayContaining([DISPUTED]) } } });
    expect(v.report.assumptions).not.toContain(DISPUTED);
  });

  it('a check cut short on either thread is a timeout, never a mismatch, and the line says which', () => {
    const sp = split(safe1v1);
    const mine = unproven(combine(sp, [workerRun(sp, 0)], { now: jumping(), checkerDeadline: 0 }).verdict);
    // The worker's clock passes its checker deadline as its check starts: 0 states, not passed.
    let t = 0;
    const progress: ProgressSink = { node() {}, teams() {}, message: (text) => { if (text.startsWith('verifying')) t = 1_000_000; } };
    const worker = workerRun(sp, 0, { deps: { ...toyDeps(safe1v1), now: () => t }, deadline: 1_000, checkerDeadline: 2_000, progress });
    expect([worker.run.check?.finished, worker.run.check?.result.statesVisited]).toEqual([false, 0]);
    const theirs = unproven(combine(sp, [worker]).verdict);
    for (const [v, says, not] of [[mine, WORKER_ONLY, WORKER_CUT], [theirs, WORKER_CUT, WORKER_ONLY]] as const) {
      expect(v).toMatchObject({ ...TIMEOUT, best: { tier: 1, ...has(says) } });
      expect(v.best?.report.assumptions).not.toContain(not);
    }
  });

  it('a re-check started near the checker deadline gets its own allowance and finishes', () => {
    const sp = split(safe1v1);
    let t = 999;
    expect(combine(sp, [workerRun(sp, 0)], { now: () => t++, checkerDeadline: 1_000 }).verdict).toMatchObject({ tier: 1, lead: 'party:0', report: { verification: { passed: true } } });
  });

  it("a badge line's worker check time covers both levels, as its re-check redoes both", () => {
    const sp = split(safe1v1, { attemptAnyLegalBadge: true });
    let t = 0;
    let inBadge = false;
    const progress: ProgressSink = { node() {}, teams() {}, message: (text) => { inBadge = text.startsWith('level-2 badge'); } };
    const worker = workerRun(sp, 0, { deps: { ...toyDeps(safe1v1), now: () => (inBadge ? (t += 1_000) : t) }, progress });
    expect(worker.run.verdict).toMatchObject({ tier: 1, anyLegalBadge: 'proven' });
    expect(worker.run.check?.elapsedMs).toBeGreaterThanOrEqual(1_000);
    expect(combine(sp, [worker]).verdict).toMatchObject({ tier: 1, anyLegalBadge: 'proven' });
  });

  it('re-checks only the lines that can be shown, best first, and stops past the checker deadline after the first cut short', () => {
    // uturnLine: Scout's lead is tier 1, Tank's tier 2 or 3. This thread's oracle records each step's lead.
    const sp = split(uturnLine);
    const runs = [workerRun(sp, 0), workerRun(sp, 1)];
    const spying = (onStep: () => void) => {
      const seen = new Set<string>();
      const main = toyDeps(uturnLine);
      const check: typeof main.oracles.damage.check = (step) => {
        seen.add(readToyState(step.before).p1Keys[0]!);
        onStep();
        return main.oracles.damage.check(step);
      };
      return { seen, deps: { ...main, oracles: { ...main.oracles, damage: { id: main.oracles.damage.id, check } } } };
    };
    const all = spying(() => {});
    expect(combine(sp, runs, { deps: all.deps }).verdict).toMatchObject({ tier: 1, lead: 'party:0' });
    let t = 0;
    const slow = spying(() => { t += 10_000; });
    const run = combine(sp, runs, { deps: slow.deps, now: () => t++, checkerDeadline: 0 });
    expect([[...all.seen], [...slow.seen], run.complete]).toEqual([['Scout'], ['Scout'], false]);
    expect(run.verdict).toMatchObject({ ...TIMEOUT, best: { tier: 1, lead: 'party:0', ...has(WORKER_ONLY) } });
  });
});

describe("the split's verdict after a disagreement, or with no claim", () => {
  /** uturnLine: Scout's lead out of time with no line, Tank's line as found. */
  const scoutLateTankLine = (sp: Split): LeadRun[] => [workerRun(sp, 0, { deadline: 0 }), workerRun(sp, 1)];

  it("a disagreement shows the disagreeing lead's line with this thread's numbers, and says who ran out of time", () => {
    const sp = split(uturnLine);
    const v = unproven(combine(sp, scoutLateTankLine(sp), { deps: skew(uturnLine, 'Tank', 'mismatch') }).verdict);
    expect(v.detail).toMatch(/^lead Tank: this thread's re-check of the worker's line disagrees: passed false, the worker's true; [^]*; 1 of 2 leads ran out of time$/);
    expect(v).toMatchObject({
      reason: 'verificationMismatch', report: { verification: { passed: false } },
      best: { lead: 'party:1', report: { verification: { passed: true }, assumptions: expect.arrayContaining([DISPUTED]) } },
    });
    expect([2, 3]).toContain(v.best?.tier);
    const { mismatches, damageChecks, orderChecks } = v.report.verification;
    expect([mismatches.length, damageChecks, orderChecks].every((n) => n > 0)).toBe(true);
  });

  it('with no claim, the shown verdict carries the best line any lead has', () => {
    const sp = split(uturnLine);
    const v = unproven(combine(sp, scoutLateTankLine(sp), { now: jumping(), checkerDeadline: 0 }).verdict);
    expect(v).toMatchObject({ ...TIMEOUT, report: { verification: { passed: true } }, best: { lead: 'party:1', ...has(WORKER_ONLY) } });
    expect([v.report.verification.damageChecks, v.report.verification.orderChecks].every((n) => n > 0)).toBe(true);   // the worker's check of Tank's line
  });

  it("checkerCompare: a store difference in a lead's worker or in this thread's re-check makes the split unproven", () => {
    const sp = split(uturnLine, {}, resolveConfig({ threads: 2, progressIntervalMs: 0, checkerCompare: true }));
    const stored = (tamper?: StoreOptions['tamper']): SolverDeps => toyDeps(uturnLine, {}, { store: { tamper } });
    const differs = { tier: 'unproven', reason: 'verificationMismatch', detail: expect.stringMatching(/^store and bare checks differ:/) };
    const scout = workerRun(sp, 0, { deps: stored() });
    expect(combine(sp, [scout, workerRun(sp, 1, { deps: stored() })]).verdict.tier).toBe(1);
    // Tank's worker store changes the first step it keeps: the split must not show Scout's line as if nothing happened.
    let done = false;
    const tank = workerRun(sp, 1, { deps: stored((method, answer) => {
      if (method !== 'expandTurn' || done) return answer;
      done = true;
      return (answer as Outcome[]).map((o) => ({ ...o, observation: `${o.observation}~` }));
    }) });
    expect(tank.run.verdict).toMatchObject(differs);
    expect(combine(sp, [scout, tank]).verdict).toMatchObject({ ...differs, detail: expect.stringMatching(/^store and bare checks differ:[^]*\(lead Tank\)$/) });
    // Every worker store right, but this thread's bare checks count one extra damage check per step.
    const mine = stored();
    const run = combine(sp, [scout, workerRun(sp, 1, { deps: stored() })], { deps: { ...mine, bare: { ...mine.bare!, oracles: skewedOracles(mine.bare!.oracles, () => true, 'count') } } });
    expect(run.verdict).toMatchObject(differs);
    expect(run.storeDiffers).toBe(unproven(run.verdict).detail);   // carried on the run, as recheckMismatch is
  });
});
