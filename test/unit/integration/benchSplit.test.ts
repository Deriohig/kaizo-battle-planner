import { describe, expect, it } from 'vitest';
import type { ResolvedTrainer, TrainerCatalog } from '../../../src/battle/types.js';
import type { Progress, SolveRequest, Verdict } from '../../../src/contracts/solver.js';
import {
  benchRow, BenchRunError, formatTable, oversubscription, parseBenchArgs, partyRefs, rowLine, runAll, runOne, splitTrainers, summarize, verdictHoldsCheckedLine, warmUp,
  type BenchArgs, type BenchContext, type BenchRow, type BenchSolver,
} from '../../../src/integration/benchSplit.js';
import { DEFAULT_PLAN_SETTINGS } from '../../../src/integration/planRequest.js';
import { resolvedTrainer } from '../engine/fixtures.js';

const trainer = (id: string, name: string, split: string, battleType: 'single' | 'double' = 'single'): ResolvedTrainer =>
  resolvedTrainer(1, [], { id, name, split, battleType });
const t = trainer('gardenia-split/a/1', 'A', 'Gardenia Split');
const other = trainer('other/x/1', 'X', 'Other');
const report = {} as never;
const verdict = (fields: Record<string, unknown>) => ({ team: [], lead: 'party:1', preStatus: {}, report, tree: {}, ...fields }) as unknown as Verdict;
const tier1 = verdict({ tier: 1, anyLegalBadge: 'notAttempted', rank: {} });
const tier3 = verdict({ tier: 3, deathProbability: { num: 1n, den: 4n }, killers: [], optimality: 'bestFoundWithinBudget' });
const unprovenWithBest = verdict({
  tier: 'unproven', reason: 'timeout', detail: 'x'.repeat(100),
  best: { tier: 2, team: [], lead: 'party:1', preStatus: {}, report, tree: {}, critBudget: 0, deathProbability: { num: 1n, den: 64n }, killers: [] },
});
const mismatch = (detail: string) => verdict({ tier: 'unproven', reason: 'verificationMismatch', detail });
const row = (name: string): BenchRow => ({ id: `s/${name}/1`, name, verdict: 'v', firstLine: '—', checked: '—', total: '—' });

const args: BenchArgs = { split: 'gardenia-split', save: 'x', budget: 'route', threads: null, refine: 'best', jobs: 1, checkerCompare: false };
const ctx: BenchContext = {
  party: ['party:1', 'party:2'],
  plan: { catalog: { trainers: [t] } as unknown as TrainerCatalog, eligible: new Set(['party:1', 'party:2']), settings: DEFAULT_PLAN_SETTINGS, horizonTurns: 50 },
};
const solving = (v: Verdict | Error): BenchSolver => ({ solve: () => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v)) });

describe('bench:split arguments and output', () => {
  it('parses a split with defaults, and every flag', () => {
    expect(parseBenchArgs(['gardenia-split'])).toEqual({
      ok: true, args: { split: 'gardenia-split', save: 'data/saves/pk-run-2026-11-11.dsv', budget: 'route', threads: null, refine: 'first', jobs: 1, checkerCompare: false },
    });
    expect(parseBenchArgs(['Gardenia Split', '--save', 'x.dsv', '--budget', 'gym', '--threads', '3', '--refine', 'best', '--jobs', '2', '--checker-compare']))
      .toMatchObject({ ok: true, args: { split: 'Gardenia Split', save: 'x.dsv', budget: 'gym', threads: 3, refine: 'best', jobs: 2, checkerCompare: true } });
  });

  it.each([
    ['g', '--budget', 'deep'], [], ['g', '--fast'], ['g', '--threads', 'x'], ['g', '--refine'], ['g', 'h'],
    ['g', '--threads', '1'], ['g', '--save', '--budget', 'gym'], ['g', '--jobs', '0'], ['g', '--jobs', 'x'],
  ])('refuses %j', (...argv) => {
    expect(parseBenchArgs(argv).ok).toBe(false);
  });

  it("lists a split's single battles in catalog order, by slug or name", () => {
    const catalog = {
      trainers: [t, trainer('gardenia-split/b/1', 'B', 'Gardenia Split', 'double'), trainer('roark-split/x/1', 'X', 'Roark Split'), trainer('gardenia-split/c/1', 'C', 'Gardenia Split')],
    } as unknown as TrainerCatalog;
    for (const split of ['gardenia-split', 'Gardenia Split']) expect(splitTrainers(catalog, split).map((x) => x.id)).toEqual(['gardenia-split/a/1', 'gardenia-split/c/1']);
  });

  it.each<[string, Verdict, string]>([
    ['tier 1', tier1, 'tier 1'],
    ['tier 3', tier3, 'tier 3, death 1/4 (25.00%)'],
    ['provisional', verdict({ ...tier3, unplannedProbability: { num: 1n, den: 8n }, provisional: true }), 'tier 3, death 1/4 (25.00%), unplanned 1/8 (12.50%), provisional'],
    ['unproven with a best', unprovenWithBest, `unproven (timeout: ${'x'.repeat(80)}); best tier 2, death 1/64 (1.56%), crit budget 0`],
  ])('words a %s verdict', (_, v, words) => {
    expect(benchRow(t, v, { firstLineMs: 5, checkedMs: 5, totalMs: 5 }).verdict).toBe(words);
  });

  it('builds a row with its times, dashes for none, and formats a Markdown table', () => {
    expect(benchRow(t, tier3, { firstLineMs: 1200, checkedMs: 4100, totalMs: 30050 }))
      .toEqual({ id: t.id, name: t.name, verdict: 'tier 3, death 1/4 (25.00%)', firstLine: '1.2 s', checked: '4.1 s', total: '30.1 s' });
    expect(benchRow(t, unprovenWithBest, { firstLineMs: null, checkedMs: null, totalMs: 61000 })).toMatchObject({ firstLine: '—', checked: '—' });
    expect(formatTable([benchRow(t, tier3, { firstLineMs: 1200, checkedMs: null, totalMs: 30050 })]).split('\n')).toEqual([
      '| Trainer | Verdict | First line | Checked | Total |',
      '| --- | --- | --- | --- | --- |',
      '| A (`gardenia-split/a/1`) | tier 3, death 1/4 (25.00%) | 1.2 s | — | 30.1 s |',
    ]);
  });

  it.each<[string, Verdict, boolean]>([
    ['a tier', tier3, true],
    ['a provisional tier', verdict({ ...tier3, provisional: true }), false],
    ['unproven with a best', unprovenWithBest, true],
    ['unproven alone', verdict({ tier: 'unproven', reason: 'timeout', detail: '' }), false],
  ])('knows whether %s holds a checked line', (_, v, holds) => {
    expect(verdictHoldsCheckedLine(v)).toBe(holds);
  });
});

describe('runOne and the scheduling', () => {
  it.each<[string, [number, number | null, boolean?][], number, Partial<BenchRow>]>([
    ["the progress's first line and checked line", [[1000, null, false], [2500, 1, true]], 3000, { firstLine: '1.0 s', checked: '2.5 s', total: '3.0 s' }],
    ['the first best tier, and the verdict for the checked time', [[700, 2]], 5000, { firstLine: '0.7 s', checked: '5.0 s', total: '5.0 s' }],
  ])('sends the party, the budget and refine, and times %s', async (_, steps, end, times) => {
    let seen: SolveRequest | undefined;
    let clock = 0;
    const solver: BenchSolver = {
      async solve(req, onProgress) {
        seen = req;
        for (const [at, bestTier, verified] of steps) {
          clock = at;
          onProgress?.({ elapsedMs: at, nodes: 1, teamsTried: 0, teamsTotal: 1, bestTier, message: '', ...(verified === undefined ? {} : { line: { verified } }) } as unknown as Progress);
        }
        clock = end;
        return tier1;
      },
    };
    expect(await runOne(solver, t, args, { ...ctx, now: () => clock })).toEqual({ id: t.id, name: t.name, verdict: 'tier 1', ...times });
    expect(seen).toMatchObject({
      fights: [{ trainerId: t.id, variant: 0 }], team: { kind: 'fixed', party: ['party:1', 'party:2'] }, budgetMs: 30_000, refine: 'best', preStatus: 'given', attemptAnyLegalBadge: false,
    });
  });

  it('reports a solver throw as a crash, a refused request as not run, but not a formatting bug', async () => {
    expect(await runOne(solving(new Error('boom')), t, args, ctx)).toMatchObject({ verdict: 'crashed (boom)', crashed: true });
    const notRun = await runOne(solving(new Error('no')), other, args, ctx);
    expect(notRun.verdict).toMatch(/^not run \(/);
    expect(rowLine(notRun, 3, 37)).toBe(`3/37 X (other/x/1): ${notRun.verdict}; first line —, checked —, total —`);
    await expect(runOne(solving(verdict({ tier: 3 })), t, args, ctx)).rejects.toThrow();
  });

  it('flags a store and bare difference, wrapped or not, and counts them', async () => {
    const flagged: BenchRow[] = [];
    for (const detail of ['store and bare checks differ: x', 'lead party:1: store and bare checks differ: x', 'pre-status party:2 burn: store and bare checks differ: x']) {
      const r = await runOne(solving(mismatch(detail)), t, args, ctx);
      expect(r.storeBareDiff, detail).toBe(true);
      flagged.push(r);
    }
    expect((await runOne(solving(mismatch('something else')), t, args, ctx)).storeBareDiff).toBeUndefined();
    expect(summarize([...flagged, { ...flagged[0]!, storeBareDiff: undefined }]).storeBareDifferences).toBe(3);
  });

  it('selects the party in slot order, with HP left and eligible', () => {
    const mons = [
      { ref: 'party:1', location: 'party', hp: 5 }, { ref: 'party:2', location: 'party', hp: 0 }, { ref: 'party:3', location: 'party', hp: 9 },
      { ref: 'party:4', location: 'party', hp: 9 }, { ref: 'box:1:1', location: 'box', hp: 9 },
    ];
    expect(partyRefs(mons, (r) => r !== 'party:4')).toEqual(['party:1', 'party:3']);
  });

  it('warms the pool, then runs an untimed one-second solve of the first trainer with the party and refine first', async () => {
    const calls: unknown[] = [];
    await warmUp({ warm: () => { calls.push('warm'); }, solve: async (req) => { calls.push(req); return tier1; } }, t, args, ctx);
    expect(calls).toMatchObject(['warm', { fights: [{ trainerId: t.id }], team: { kind: 'fixed', party: ctx.party }, budgetMs: 1000, refine: 'first' }]);
  });

  it('fails the warm-up, naming the cause, when its solve throws or the request is refused', async () => {
    await expect(warmUp(solving(new Error('worker died')), t, args, ctx)).rejects.toThrow(/warm-up failed.*worker died/);
    await expect(warmUp(solving(tier1), other, args, ctx)).rejects.toThrow(/warm-up failed/);
  });

  it('warns when the solves ask for more threads than there are cores', () => {
    expect(oversubscription(4, 2, 12)).toBeNull();
    expect(oversubscription(4, 2, 6)).toMatch(/8 threads.*6 cores/);
  });

  it('runs at most N at once, each trainer once, and returns the rows in catalog order', async () => {
    const ts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => trainer(`s/${n}/1`, n, 'S'));
    let active = 0;
    let peak = 0;
    const seen: string[] = [];
    const finished: number[] = [];
    const rows = await runAll(ts, 3, async (tr) => {
      peak = Math.max(peak, ++active);
      seen.push(tr.id);
      await new Promise((r) => setTimeout(r, tr.name === 'a' ? 30 : 5));
      active -= 1;
      return row(tr.name);
    }, (_row, i) => finished.push(i));
    expect([peak, seen.sort(), rows.map((r) => r.name), finished.length]).toEqual([3, ts.map((x) => x.id).sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 7]);
    expect(finished[0]).not.toBe(0);   // a is the slowest of the first three
  });

  it('keeps the rows the other lanes finished when one lane throws', async () => {
    const ts = ['a', 'b', 'c', 'd'].map((n) => trainer(`s/${n}/1`, n, 'S'));
    const err = await runAll(ts, 2, async (tr) => {
      await new Promise((r) => setTimeout(r, tr.name === 'a' ? 1 : 15));
      if (tr.name === 'a') throw new Error('bug');
      return row(tr.name);
    }).then(() => null, (e: unknown) => e) as BenchRunError;
    expect(err).toBeInstanceOf(BenchRunError);
    expect([err.rows.map((r) => r.name), err.cause]).toMatchObject([['b', 'c', 'd'], { message: 'bug' }]);
  });
});
