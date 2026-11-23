// The level-2 badge and the hidden-information probe.
//
// attemptBadge. Level 2 is the AND over every legal enemy action (Engine.legalChoices(p2), the trainer's item uses
// included) instead of the AI's support, so a level-2 proof stays safe whatever the AI port gets wrong. The cheapest
// route first (report E): the independent checker replays the ranked level-1 certificate as a level-2 proof (a copy with
// level 2 and no thresholds: the badge is about safety, and the level-1 check already verified the ranking's
// thresholds). Passing → proven on that line (rank null; `check` is that passing level-2 check, for the verdict's
// verification). Otherwise a level-2 proof from scratch: a fresh Prover (its own table: level 2 is another game; the
// history map is shared, for ordering only) deepened up to the horizon; a win is extracted and ranked at level 2 within
// the horizon (rankProven, level 2), and the ranking's line is proven: the best-ranked level-2 line when
// rank.complete, else the best level-2 line found within the budget (still a level-2 proof; the ranking was cut short
// or could not rule out a better line, and the caller says so). Its certificate is not checked here: the caller checks it at level 2 and, on a copy, at level 1 (a level-2 proof covers level 1 only while the
// AI's support stays within the legal actions, which the level-1 check confirms). 'failed' covers a refuted level-2
// game, one not proven (a horizon cut-off, an unmodelled outcome, an engine limit, a repetition) and one not finished by
// the deadline (a timeout or an abort, in the re-check, the proof, the extraction or the ranking). A checker exception in
// the re-check is not a pass (the search decides); an engine UNSUPPORTED_DOUBLE propagates. The arena is shared with the
// level-1 search: its edge cache keys hold the level.
//
// probeHiddenInformation. Is there a tier-1 proof when the player may read the exact state (RAM mode)? A fresh level-1 Prover
// in mode 'ram' without thresholds, deepened up to the horizon; true only on a win (a failure, a timeout or an abort is
// false). It claims nothing itself: the caller only uses it to say that a safe line needs hidden information.

import type { EnemyModel } from '../contracts/ai.js';
import type { Choice, Engine } from '../contracts/engine.js';
import type { RankKey } from '../contracts/solver.js';
import type { Arena } from './arena.js';
import { rootBelief, type Belief } from './belief.js';
import { extractProof, type Certificate } from './certificate.js';
import { checkCertificate, type CheckInput, type CheckResult } from './check/checker.js';
import type { ArenaFight } from './inputs.js';
import { Prover } from './prove.js';
import { rankProven, type RankResult } from './rank.js';
import type { ObservationMode, OrderHint, PlanLabeler, SolverDeps } from './types.js';

export type BadgeResult =
  | { status: 'proven'; certificate: Certificate; rank: null; check: CheckResult }   // the level-1 line itself passed; check: that passing level-2 check
  | { status: 'proven'; certificate: Certificate; rank: RankResult }                  // the level-2 ranking's line (rank.complete false: the best found within the budget)
  | { status: 'failed'; detail: string };                                             // refuted, or not proven within its budget

export interface BadgeOptions {
  ranking: readonly RankKey[]; mode: ObservationMode; horizon: number; deadline: number; now: () => number; signal?: AbortSignal;
  labeler: PlanLabeler; history: Map<string, Choice>; engine: Engine; enemyModel: EnemyModel; fights: ArenaFight[];
  oracles: SolverDeps['oracles']; orderHint?: OrderHint;
  onNode?: () => void;               // progress, once per search node
  restrictRoot?: Choice[];           // the parallel root split (prove.ts)
  maxLeaves?: number;                // the checker's engine limit, as the arena's
  killerLimit?: number;              // the checker's killer count (default 0: a passing proof check has no killers)
  // The checker on the engine, AI and oracles the solve's config picks (checkerDeps.ts runChecker: the store's, the bare
  // ones, or both compared); absent: checkCertificate on `engine`, `enemyModel` and `oracles`.
  check?: (call: Omit<CheckInput, 'engine' | 'enemyModel' | 'oracles'>) => CheckResult;
}

export interface ProbeOptions {
  deadline: number; now: () => number; signal?: AbortSignal; labeler: PlanLabeler;
  onNode?: () => void; restrictRoot?: Choice[];
}

const NOT_FINISHED = 'not proven at level 2 within its budget';

function codeOf(e: unknown): unknown {
  return typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
}

function stopped(o: { deadline: number; now: () => number; signal?: AbortSignal }): boolean {
  return o.signal?.aborted === true || o.now() > o.deadline;
}

/**
 * The level-1 certificate replayed as a level-2 proof; null when the checker threw (not a pass). Safety only: the
 * level-1 ranking's thresholds are dropped, since they bound level-1 win leaves (the level-1 check verified them) and
 * a legal action the AI never picks may end lower while still safe.
 */
function recheckAtLevel2(certificate: Certificate, opts: BadgeOptions): CheckResult | null {
  const call = {
    certificate: { ...certificate, level: 2 as const, thresholds: null }, fights: opts.fights, labeler: opts.labeler, killerLimit: opts.killerLimit ?? 0,
    deadline: opts.deadline, now: opts.now, signal: opts.signal, maxLeaves: opts.maxLeaves,
  };
  try {
    return opts.check !== undefined ? opts.check(call) : checkCertificate({ ...call, engine: opts.engine, enemyModel: opts.enemyModel, oracles: opts.oracles });
  } catch (e) {
    if (codeOf(e) === 'UNSUPPORTED_DOUBLE') throw e;
    return null;
  }
}

/** The badge for the ranked level-1 line `level1` from `root` (the fight-0 entry), within `opts.deadline` (see the top of the file). */
export function attemptBadge(arena: Arena, root: Belief, level1: RankResult, opts: BadgeOptions): BadgeResult {
  if (stopped(opts)) return { status: 'failed', detail: NOT_FINISHED };
  const recheck = recheckAtLevel2(level1.certificate, opts);
  if (recheck !== null && recheck.passed) return { status: 'proven', certificate: level1.certificate, rank: null, check: recheck };

  const search = {
    mode: opts.mode, deadline: opts.deadline, now: opts.now, signal: opts.signal, labeler: opts.labeler, history: opts.history,
    orderHint: opts.orderHint, onNode: opts.onNode, restrictRoot: opts.restrictRoot,
  };
  const prover = new Prover(arena, { params: { level: 2, critBudget: null, thresholds: null }, ...search });
  const { result, horizon } = prover.deepen(root, opts.horizon);
  if (result.kind === 'unknown') return { status: 'failed', detail: NOT_FINISHED };
  if (result.kind === 'fail') {
    return { status: 'failed', detail: `${result.refuted ? 'refuted' : 'not proven'} at level 2: ${result.refutation.join(' → ')}` };
  }
  let base: Certificate;
  try {
    base = extractProof(prover, root, horizon);
  } catch (e) {
    if (stopped(opts)) return { status: 'failed', detail: NOT_FINISHED };   // the deadline stopped a re-proof inside the extraction
    throw e;
  }
  const rank = rankProven(arena, root, { certificate: base, horizon: opts.horizon }, { ranking: opts.ranking, level: 2, ...search });
  return { status: 'proven', certificate: rank.certificate, rank };
}

/** true when a tier-1 proof exists in RAM mode within `horizon` turns per fight (see the top of the file). */
export function probeHiddenInformation(arena: Arena, horizon: number, opts: ProbeOptions): boolean {
  if (stopped(opts)) return false;
  const prover = new Prover(arena, {
    params: { level: 1, critBudget: null, thresholds: null }, mode: 'ram', deadline: opts.deadline, now: opts.now, signal: opts.signal,
    labeler: opts.labeler, history: new Map(), onNode: opts.onNode, restrictRoot: opts.restrictRoot,
  });
  return prover.deepen(rootBelief(arena), horizon).result.kind === 'win';
}
