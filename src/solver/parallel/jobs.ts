// Jobs for the worker pool. A job is plain data, and so is its result: both cross the thread boundary
// by structured clone, which keeps bigints, so every Rational arrives exact; a certificate travels as its text
// (serializeCertificate). runJob runs a job on the same code path as in-process solving (solveFights), so a worker's
// answer is the one this thread would have found with the same inputs.
//
// Kinds. 'root': one root alternative of a fixed team's fights (a lead), solveFights in full with that restrictRoot.
// 'team': one team-search candidate (the request already that candidate's, solve.ts teamRequest): phase 'tier1' is
// solveFights in tier-1 mode (Phase A; the result is the Tier1Run), phase 'risk' is solveFights in full (Phase B), with
// `known` (its Phase A tier-1 failure) when there is one.
// Inputs. The fights are rebuilt from `req` and `team` with the deps' resolver, as createSolver builds them
// (solve.ts teamFights: the request's manual pre-status on fight 0, healBefore from each spec). `config` is the
// requesting thread's resolved SolverConfig (absent: the deps' own config); a worker's deps module may configure
// nothing. Deadlines are absolute on the clock of the thread that runs the job (`deps.now`, default performance.now):
// the pool sends the time left and the worker adds its own now (pool.ts).
// Result. `nodes` counts the search nodes the job's searches visited (the progress sink's node calls); `verdict` and the
// rest are the FightRun's (certificate as text, `stats` its search counts, `check` the worker's own check of the line:
// the checker's whole result, whether the walk finished before its deadline, and how long it took), null for a tier-1
// job, whose answer is `tier1`. The requesting thread re-checks the line against that check (solve.ts recheck).

import type { Choice, Rational } from '../../contracts/engine.js';
import type { MonRef, SolveRequest, Verdict } from '../../contracts/solver.js';
import type { SearchStats } from '../arena.js';
import { parseCertificate, serializeCertificate } from '../certificate.js';
import { resolveConfig } from '../config.js';
import type { RankVector } from '../rank.js';
import {
  solveFights, teamFights, type FightControl, type FightRun, type KnownFailure, type LineCheck, type ProgressSink, type Tier1Run,
} from '../solve.js';
import type { SolverConfig, SolverDeps } from '../types.js';

interface JobBase {
  req: SolveRequest; team: MonRef[];          // the fights' request and the team (canonical order)
  deadline: number; checkerDeadline: number;  // on the running thread's clock (see the top of the file)
  config?: SolverConfig;                      // the requesting thread's resolved config (absent: the deps' own)
}

export type Job =
  | (JobBase & { kind: 'root'; restrictRoot: Choice[] })                                        // one lead
  | (JobBase & { kind: 'team'; phase: 'tier1' | 'risk'; known?: KnownFailure | null });     // one team-search candidate

export interface JobResult {
  verdict: Verdict | null;                    // null for a tier-1 job
  certificate: string | null; vector: RankVector | null; failure: Rational | null; refutation: string[] | null; complete: boolean;
  refuted: boolean | null;                    // FightRun.refuted (null: absent)
  nodes: number;                              // search nodes visited
  tier1: Tier1Run | null;                     // a tier-1 job's answer
  stats: SearchStats | null;                  // the run's search counts (FightRun.stats; structured clone keeps the Set)
  check: LineCheck | null;                    // the worker's check of the run's line (FightRun.check): statesVisited, elapsedMs, finished…
  storeDiffers?: string;                      // FightRun.storeDiffers (absent: none)
}

const SILENT: ProgressSink = { node() {}, message() {}, teams() {} };

/** A FightRun as plain data. */
export function toJobResult(run: FightRun, nodes: number): JobResult {
  return {
    verdict: run.verdict, certificate: run.certificate === null ? null : serializeCertificate(run.certificate), vector: run.vector,
    failure: run.failure, refutation: run.refutation, refuted: run.refuted ?? null, complete: run.complete, nodes, tier1: null, stats: run.stats ?? null,
    check: run.check ?? null, ...(run.storeDiffers === undefined ? {} : { storeDiffers: run.storeDiffers }),
  };
}

/** The FightRun a full job (root, or team phase 'risk') answered. */
export function fromJobResult(r: JobResult): FightRun {
  if (r.verdict === null) throw new Error('jobs: a tier-1 job has no run');
  return {
    verdict: r.verdict, certificate: r.certificate === null ? null : parseCertificate(r.certificate), vector: r.vector,
    failure: r.failure, refutation: r.refutation, ...(r.refuted === null ? {} : { refuted: r.refuted }), complete: r.complete,
    ...(r.stats === null ? {} : { stats: r.stats }), ...(r.check === null ? {} : { check: r.check }),
    ...(r.storeDiffers === undefined ? {} : { storeDiffers: r.storeDiffers }),
  };
}

/** Runs `job` with `deps` (see the top of the file); `progress` sees every message and node. */
export function runJob(deps: SolverDeps, job: Job, progress: ProgressSink = SILENT): JobResult {
  const cfg = job.config ?? resolveConfig(deps.config);
  let nodes = 0;
  const sink: ProgressSink = {
    node() {
      nodes += 1;
      progress.node();
    },
    message: (text, bestTier) => progress.message(text, bestTier),
    teams() {},
  };
  const infos = job.req.fights.map((spec) => deps.resolver.fight(spec));
  const fights = teamFights(job.req, infos, job.team.map((ref) => deps.resolver.mon(ref)));
  const base = { deadline: job.deadline, checkerDeadline: job.checkerDeadline, progress: sink };
  if (job.kind === 'team' && job.phase === 'tier1') {
    const tier1 = solveFights(deps, cfg, fights, job.req, { ...base, mode: 'tier1' });
    return { verdict: null, certificate: null, vector: null, failure: null, refutation: null, refuted: null, complete: tier1.kind !== 'unproven', nodes, tier1, stats: null, check: null };
  }
  const known = job.kind === 'team' ? job.known ?? null : null;
  const ctl: FightControl = job.kind === 'root' ? { ...base, restrictRoot: job.restrictRoot } : { ...base, ...(known === null ? {} : { knownFailure: known }) };
  const run = solveFights(deps, cfg, fights, job.req, ctl);
  return toJobResult(run, nodes);
}
