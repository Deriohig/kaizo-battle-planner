// The logic of `npm run bench:split` (scripts/benchSplit.ts): every single battle of a game split through the real
// solver, one row each. Speed work is measured with it. Argument
// parsing, the trainer list, one trainer's run (against an injected solver), the scheduling, the rows and the table text
// live here; the CLI builds the real solver and prints.

import { slug } from '../battle/resolveTrainer.js';
import type { ResolvedTrainer, TrainerCatalog } from '../battle/types.js';
import type { MonRef, Progress, SolveRequest, Verdict } from '../contracts/solver.js';
import type { Rational } from '../contracts/engine.js';
import { toSolveRequest, type PlanContext } from './planRequest.js';
import { percent } from '../solver/rational.js';

export interface BenchArgs {
  split: string; save: string; budget: 'route' | 'gym'; threads: number | null; refine: 'first' | 'best';
  /** Trainers solved at once on the same solver (default 1). */
  jobs: number;
  /** Config checkerCompare: every shown line is checked with the store and with the bare engine and AI. */
  checkerCompare: boolean;
}

export const DEFAULT_SAVE = 'data/saves/pk-run-2026-11-11.dsv';

/** `<split> [--save <file>] [--budget route|gym] [--threads <n>] [--refine first|best] [--jobs <n>] [--checker-compare]`. */
export function parseBenchArgs(argv: string[]): { ok: true; args: BenchArgs } | { ok: false; error: string } {
  const args: BenchArgs = { split: '', save: DEFAULT_SAVE, budget: 'route', threads: null, refine: 'first', jobs: 1, checkerCompare: false };
  let split: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      if (split !== null) return { ok: false, error: `Only one split may be named, not ${JSON.stringify(split)} and ${JSON.stringify(arg)}` };
      split = arg;
      continue;
    }
    if (arg === '--checker-compare') {
      args.checkerCompare = true;
      continue;
    }
    if (arg !== '--save' && arg !== '--budget' && arg !== '--threads' && arg !== '--refine' && arg !== '--jobs') return { ok: false, error: `Unknown flag ${arg}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
    i += 1;
    if (arg === '--save') args.save = value;
    else if (arg === '--budget') {
      if (value !== 'route' && value !== 'gym') return { ok: false, error: `--budget must be route or gym, not ${JSON.stringify(value)}` };
      args.budget = value;
    } else if (arg === '--refine') {
      if (value !== 'first' && value !== 'best') return { ok: false, error: `--refine must be first or best, not ${JSON.stringify(value)}` };
      args.refine = value;
    } else if (arg === '--jobs') {
      if (!/^\d+$/.test(value) || Number(value) < 1) return { ok: false, error: `--jobs must be a whole number of at least 1, not ${JSON.stringify(value)}` };
      args.jobs = Number(value);
    } else {
      if (!/^\d+$/.test(value) || Number(value) < 2) return { ok: false, error: `--threads must be a whole number of at least 2, not ${JSON.stringify(value)}` };
      args.threads = Number(value);
    }
  }
  if (split === null || slug(split) === '') return { ok: false, error: 'Name the split to bench, such as gardenia-split' };
  args.split = split;
  return { ok: true, args };
}

/** The split's single battles, the only ones the solver takes (multi battles stay, doubles go), in catalog order. `split` matches by slug. */
export function splitTrainers(catalog: TrainerCatalog, split: string): ResolvedTrainer[] {
  const want = slug(split);
  return catalog.trainers.filter((t) => t.battleType === 'single' && slug(t.split) === want);
}

/** The fixed team: the box's party Pokémon with HP left that the planner may use, in slot order (`mons` is in box order). */
export function partyRefs(mons: readonly { ref: MonRef; location: string; hp: number }[], eligible: (ref: MonRef) => boolean): MonRef[] {
  return mons.filter((m) => m.location === 'party' && m.hp > 0 && eligible(m.ref)).map((m) => m.ref);
}

export interface BenchTimes { firstLineMs: number | null; checkedMs: number | null; totalMs: number }
export interface BenchRow {
  id: string; name: string; verdict: string; firstLine: string; checked: string; total: string;
  /** The solver threw (set by runOne). */
  crashed?: true;
  /** The verdict is a store-and-bare mismatch of config checkerCompare (set by runOne). */
  storeBareDiff?: true;
}

const DASH = '—';
const DETAIL_CHARS = 80;

const seconds = (ms: number): string => `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
const timeCell = (ms: number | null): string => (ms === null ? DASH : seconds(ms));
const ratio = (r: Rational): string => `${r.num}/${r.den} (${percent(r)})`;

/** Whether the verdict holds a line the checker replayed: a tier without `provisional`, or `best` without it. */
export function verdictHoldsCheckedLine(verdict: Verdict): boolean {
  if (verdict.tier === 'unproven') return verdict.best !== undefined && verdict.best.tier !== 'unproven' && verdict.best.provisional !== true;
  return verdict.provisional !== true;
}

function tierText(verdict: Exclude<Verdict, { tier: 'unproven' }>): string {
  if (verdict.tier === 1) return 'tier 1';
  if (verdict.tier === 2) return `tier 2, death ${ratio(verdict.deathProbability)}, crit budget ${verdict.critBudget}`;
  const parts = [`tier 3, death ${ratio(verdict.deathProbability)}`];
  if (verdict.unplannedProbability !== undefined && verdict.unplannedProbability.num !== 0n) parts.push(`unplanned ${ratio(verdict.unplannedProbability)}`);
  if (verdict.provisional === true) parts.push('provisional');
  return parts.join(', ');
}

/** The verdict as one table cell. */
export function verdictText(verdict: Verdict): string {
  if (verdict.tier !== 'unproven') return tierText(verdict);
  const best = verdict.best !== undefined && verdict.best.tier !== 'unproven' ? `; best ${tierText(verdict.best)}` : '';
  return `unproven (${verdict.reason}: ${verdict.detail.slice(0, DETAIL_CHARS)})${best}`;
}

export function benchRow(trainer: ResolvedTrainer, verdict: Verdict, times: BenchTimes): BenchRow {
  return {
    id: trainer.id, name: trainer.name, verdict: verdictText(verdict),
    firstLine: timeCell(times.firstLineMs), checked: timeCell(times.checkedMs), total: seconds(times.totalMs),
  };
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** A Markdown table, one row per trainer. */
export function formatTable(rows: BenchRow[]): string {
  return [
    '| Trainer | Verdict | First line | Checked | Total |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${cell(r.name)} (\`${r.id}\`) | ${cell(r.verdict)} | ${r.firstLine} | ${r.checked} | ${r.total} |`),
  ].join('\n');
}

/** One row as a progress line, `index` from 1. */
export function rowLine(row: BenchRow, index: number, total: number): string {
  return `${index}/${total} ${row.name} (${row.id}): ${row.verdict}; first line ${row.firstLine}, checked ${row.checked}, total ${row.total}`;
}

/** What the CLI needs of a solver: the real one (`createRealSolver`) or a fake. */
export interface BenchSolver {
  solve(req: SolveRequest, onProgress?: (p: Progress) => void): Promise<Verdict>;
  warm?(): void;
}

export interface BenchContext {
  party: MonRef[];
  plan: PlanContext;
  /** The clock, in ms (default `performance.now`); the tests' seam. */
  now?: () => number;
}

function request(trainer: ResolvedTrainer, budget: 'route' | 'gym' | { ms: number }, refine: 'first' | 'best', ctx: BenchContext): { ok: true; request: SolveRequest } | { ok: false; error: string } {
  const made = toSolveRequest({
    fights: [{ trainerId: trainer.id, variant: 0 }], team: { kind: 'fixed', party: ctx.party },
    preStatus: 'given', attemptAnyLegalBadge: false, budget,
  }, ctx.plan);
  if (made.ok) made.request.refine = refine;   // toSolveRequest does not carry `refine`, so the bench sets it here
  return made;
}

/**
 * Brings the solver up before anything is timed: `warm()` (every worker spawns and loads the data), then one untimed
 * one-second solve of `trainer`. That solve runs on only min(solve width, leads) workers and builds the real context
 * (the box's Pokémon: the deps, the store) there; the other workers build it inside their first timed job. Measured
 * (2026-11-12, Gardenia save, whole box): `solverDeps` over the real context takes 2.3 ms cold and about 0.3 ms after, so a
 * first timed job pays under 0.5 s for it and the partial warm-up is kept, not widened to every worker.
 * Throws (`warm-up failed: …`) when the request is refused or the solve throws: a broken warm-up means broken timings.
 */
export async function warmUp(solver: BenchSolver, trainer: ResolvedTrainer, _args: BenchArgs, ctx: BenchContext): Promise<void> {
  solver.warm?.();
  const made = request(trainer, { ms: 1000 }, 'first', ctx);
  if (!made.ok) throw new Error(`warm-up failed: ${made.error}`);
  try {
    await solver.solve(made.request);
  } catch (e) {
    throw new Error(`warm-up failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/** A warning when `jobs` solves of `solveThreads` workers each ask for more threads than the machine has cores, else null. */
export function oversubscription(jobs: number, solveThreads: number, cores: number): string | null {
  const asked = jobs * solveThreads;
  return asked > cores ? `Warning: ${jobs} jobs of ${solveThreads} threads is ${asked} threads on ${cores} cores; timings will be inflated` : null;
}

/** `runAll` failed in a lane (a bug, not a solver crash): `rows` are the rows the other lanes finished, in catalog order. */
export class BenchRunError extends Error {
  constructor(readonly rows: BenchRow[], cause: unknown) {
    super(`a bench lane failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'BenchRunError';
  }
}

/**
 * One trainer through the solver as the page would send it: the fixed party, `args.budget`, `args.refine`. Only the
 * solver call is guarded (a throw is a `crashed` row); a bug in building the row is thrown. The clock starts as the solve is called.
 */
export async function runOne(solver: BenchSolver, trainer: ResolvedTrainer, args: BenchArgs, ctx: BenchContext): Promise<BenchRow> {
  const made = request(trainer, args.budget, args.refine, ctx);
  if (!made.ok) return { id: trainer.id, name: trainer.name, verdict: `not run (${made.error})`, firstLine: DASH, checked: DASH, total: DASH };
  const now = ctx.now ?? (() => performance.now());
  const start = now();
  let lineMs: number | null = null;
  let tierMs: number | null = null;
  let verifiedMs: number | null = null;
  let verdict: Verdict;
  try {
    verdict = await solver.solve(made.request, (p) => {
      const t = now() - start;
      if (p.line !== undefined && lineMs === null) lineMs = t;
      if (p.bestTier !== null && tierMs === null) tierMs = t;
      if (p.line?.verified === true && verifiedMs === null) verifiedMs = t;
    });
  } catch (e) {
    return {
      id: trainer.id, name: trainer.name, verdict: `crashed (${e instanceof Error ? e.message : String(e)})`,
      firstLine: DASH, checked: DASH, total: seconds(now() - start), crashed: true,
    };
  }
  const totalMs = now() - start;
  const checkedMs = verifiedMs ?? (verdictHoldsCheckedLine(verdict) ? totalMs : null);
  const row = benchRow(trainer, verdict, { firstLineMs: lineMs ?? tierMs, checkedMs, totalMs });
  if (verdict.tier === 'unproven' && verdict.reason === 'verificationMismatch' && verdict.detail.includes('store and bare checks differ:')) row.storeBareDiff = true;
  return row;
}

/**
 * Runs `run` over `trainers` with at most `jobs` at once, each trainer once; `onRow` is called as each finishes (with its
 * index in `trainers`); the rows come back in `trainers` order.
 */
export async function runAll(
  trainers: readonly ResolvedTrainer[], jobs: number, run: (trainer: ResolvedTrainer) => Promise<BenchRow>, onRow?: (row: BenchRow, index: number) => void,
): Promise<BenchRow[]> {
  const rows: (BenchRow | undefined)[] = new Array(trainers.length);
  let next = 0;
  let failure: { cause: unknown } | null = null;
  async function lane(): Promise<void> {
    while (next < trainers.length) {
      const i = next;
      next += 1;
      try {
        const row = await run(trainers[i]!);
        rows[i] = row;
        onRow?.(row, i);
      } catch (e) {
        failure ??= { cause: e };   // this lane stops; the others carry on, so their rows are kept
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, jobs), trainers.length) }, lane));
  const done = rows.filter((r): r is BenchRow => r !== undefined);
  if (failure !== null) throw new BenchRunError(done, (failure as { cause: unknown }).cause);
  return done;
}

export interface BenchSummary { rows: number; linesShown: number; crashed: number; storeBareDifferences: number }

export function summarize(rows: readonly BenchRow[]): BenchSummary {
  return {
    rows: rows.length, linesShown: rows.filter((r) => r.firstLine !== DASH).length,
    crashed: rows.filter((r) => r.crashed === true).length, storeBareDifferences: rows.filter((r) => r.storeBareDiff === true).length,
  };
}

export function summaryLine(s: BenchSummary): string {
  return `rows: ${s.rows}, lines shown: ${s.linesShown}, crashed: ${s.crashed}, store/bare differences: ${s.storeBareDifferences}`;
}
