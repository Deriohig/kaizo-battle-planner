// Team selection: with a team search, the solver picks a team of up to maxSize from the pool.
//
// teamCandidates. Every team of the allowed sizes, each listed in pool order, as a re-iterable sequence with its exact
// `count`. The player steers it (contracts TeamSearch; both default to empty, which changes nothing):
// - `mustBring` (m refs) is in every team: a team of size k is mustBring plus a (k − m)-subset of the rest of the pool.
// - `preferred` orders: teams holding more preferred refs come first; the order below breaks ties.
// Sizes: monotone (every fight benchMonotone: no Roar/Whirlwind and no AI read of the player's bench): only
// min(maxSize, |pool|), since the player decides who enters, so a proof that uses some members holds for every team that
// contains them. Otherwise every size from max(1, m) to min(maxSize, |pool|), larger first. teamCount: the sum over the
// sizes k of C(|pool| − m, k − m), exactly (bigint binomials), nothing enumerated; none when m > min(maxSize, |pool|).
// Up to `maxSorted` (SolverConfig.maxTeamCandidates) teams are built and ordered: preferred refs held, descending; then
// score descending (no score: all equal; NaN counts as -Infinity); then larger first; then lexicographic by pool index.
// Above it nothing is built, and the teams are enumerated lazily. The refs outside mustBring split into the preferred
// refs P and the others O, each ordered by single-mon score (score([ref]), descending, pool order on ties; pool order
// without a score). For p from min(|P|, top size − m) down to 0, then for each size k, larger first: every p-subset of
// P times every (k − m − p)-subset of O, lexicographic within each p over P's order and then O's (outer loop over the
// P-subsets, inner over the O-subsets), each team being mustBring plus both. So the teams holding the most preferred
// refs always come first, and without preferences (P empty: p = 0 only) this is the pool by single-mon score,
// lexicographic per size, as before. Every team comes exactly once (Vandermonde: the sum over p of
// C(|P|, p) C(|O|, k − m − p) is C(|pool| − m, k − m)).
// A RangeError (invalidTeamSearch): a maxSize that is not an integer, a pool that lists a ref twice, a mustBring or
// preferred list that lists a ref twice or one not in the pool, or a ref in both lists.
//
// NoGoods. Complete tier-1 disproofs: a team refuted for good rules out every subset of it. Sound only when monotone,
// so searchTeams never records or consults one otherwise. completeDisproof: a refuted tier-1 failure (prove.ts: every
// choice refuted, by deaths, repetitions or thresholds, never through a horizon cut-off, an engine LIMIT or an
// unmodelled outcome; the merged failure reasons cannot tell, since they OR every choice's), and never in a battle with
// unmodelledIn() non-empty at the root (its deaths come from an engine that does not model the battle). A
// timeout is no failure at all (tier 1 returns unknown), so it never gives a no-good. With today's candidates a no-good
// prunes nothing: a monotone search tries full-size teams only, and no full-size team is a subset of another. It is
// kept for a later participant-set search (smaller proven sets, per fight).
//
// searchTeams. Phase A (up to 60% of the budget): each candidate in order (those NoGoods rules out are listed and
// skipped) runs the tier-1 search alone (solveFights in tier-1 mode: nothing extracted, ranked or checked) until its
// share, (Phase A end − now) / min(candidates left, 32); no candidate starts once Phase A's time is up, and those not
// reached are simply not tried. A proven team with unmodelledIn() non-empty at the root is not proven for this search:
// it is listed ('unmodelled: <items>') and Phase A goes on. Otherwise that team is solved in full (solveFights) under
// the request's deadline and the checker's. Tier 1, or unproven timeout (no time left): that run, with the pre-status
// proposals when asked (solveWithPreStatus from it), is shown. Any other result (verificationMismatch, unmodelled…) is
// listed with its reason ('<reason>: <detail>'), kept for Phase B, and Phase A goes on with the next candidates.
// Phase B (no team shown yet): each candidate in the same order, while time is left, runs solveFights in full until its
// share, (deadline − now) / (min(candidates left, 32), plus one when pre-status is proposed: that share is the shown
// team's proposals). A team Phase A already solved in full reuses that run. A candidate whose tier-1 search failed in
// Phase A goes straight to tiers 2 and 3 with that failure (the tier-1 search is deterministic, so repeating it would
// only find the same failure); one that timed out there, was ruled out, or was never reached runs tier 1 again first.
// The best run by betterRun is kept, the earlier on a tie; a tier-1 run ends Phase B at once. The best run then gets the
// pre-status proposals when asked (solveWithPreStatus with it as the baseline) and is shown. A run settled here with a
// re-check disagreement (FightRun.recheckMismatch: a worker's line this thread's checker disagrees with) is recorded,
// the first in candidate order ('team <labels>: <disagreement>', `mismatch`); createSolver then shows the verdict as
// unproven verificationMismatch (solve.ts). So is a store difference (FightRun.storeDiffers, config checkerCompare)
// in any run that settles, Phase A's full solves, Phase B's runs and the shown run, in that order, whether or not
// betterRun picks it ('<its detail> (team <labels>)', `storeDiffers`): createSolver shows that one over all else but
// an engine refusal.
// rejectedTeams: every candidate not proven tier 1, in the order tried (Phase A, then candidates Phase B reached
// first), with firstFailure 'Team <labels joined by ', '>: <refutation joined by ' / '>', or '…: not proven within its
// share of the budget' after a timeout, '…: ruled out: inside a team refuted for good' for a no-good, '…: unmodelled:
// <items>' or '…: <reason>: <detail>' as above, or the verdict's detail when a full run had no refutation for another
// reason. When Phase B's retry of tier 1 refutes a team listed after a timeout or a no-good, its refutation replaces the
// entry (same place in the list). A team shown at tier 1 is never listed. Phase B's shown team is listed when it failed
// tier 1, since that is why it is not tier 1. Only the first 200 entries are kept; more add one last entry
// { team: [], firstFailure: '… and <n> more teams not proven' }. A cancel stops both phases; the best run so far, if
// any, is shown.
// Progress: teams(settled, total) after each candidate settles, total = the exact count; every message is prefixed
// 'team <labels> (<i>/<n>)' (Phase B: 'tiers 2 and 3, team …'; a proven team's full solve: 'team <labels>'). Its best
// tier is the best tier of a finished run's verdict so far (a tier is only ever claimed after the checker passed), never
// a run's own unverified stage: when a finished run raises it, the last message is reported again with it.
//
// Window. The runners may answer with a promise. With `window` w > 1 (the worker
// threads), up to w candidates are taken ahead in order and their tier-1 searches (Phase A) or full runs (Phase B,
// runners.risk) started at once, each with w shares of the time (at most the phase's time left); the results are still
// handled one candidate at a time in candidate order, exactly as above, so the shown team is the lowest-index one the
// rules pick and the rejected list is the same: a candidate is settled only after every lower-index one. No-goods are
// recorded in that order too (they are order-independent facts, but the listing must not depend on timing): a candidate
// ruled out by then is listed as ruled out and its run, if started, is cancelled (the `stop` signal). A candidate is
// started only while its phase has time left; on the way out (a team shown, Phase B's tier 1, a cancel, a refused
// battle) every run still going is cancelled. A run that fails (rejects, other than by its own cancel: a worker crash,
// a deps module that throws) fails the search at once, whatever its index: every other run is cancelled and searchTeams
// rejects with that error. A proven team's full solve (runners.full) and the shown run are awaited in place; once a
// team is to be shown, the runs ahead are cancelled. With w = 1 (in-process) nothing is started ahead and every step,
// deadline and message is as above.

import type { MonRef, ProofReport, RankKey, Tier, Verdict } from '../contracts/solver.js';
import { DEFAULT_CONFIG } from './config.js';
import { betterRun } from './prestatus.js';
import type { FightRun, KnownFailure, ProgressSink, Tier1Run } from './solve.js';

export type RejectedTeam = ProofReport['rejectedTeams'][number];

/** Phase A's share of the search budget. */
export const PHASE_A_SHARE = 0.6;

/** A candidate's share is the time left over at most this many candidates. */
export const MAX_SHARES = 32;

/** rejectedTeams keeps this many entries, then one line counting the rest. */
export const MAX_REJECTED_TEAMS = 200;

export const NOT_IN_SHARE = 'not proven within its share of the budget';

/** The candidate teams in search order (re-iterable: each iteration starts again) and their exact number. */
export interface TeamCandidates extends Iterable<MonRef[]> { readonly count: number }

/** The player's steering of a team search (contracts TeamSearch): absent or empty lists change nothing. */
export interface TeamSteer { mustBring?: readonly MonRef[]; preferred?: readonly MonRef[] }

/** C(n, k), exactly. */
function binomial(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  let r = 1n;
  for (let i = 0; i < k; i++) r = (r * BigInt(n - i)) / BigInt(i + 1);   // r = C(n, i + 1): always a whole number
  return r;
}

/** The team sizes tried, larger first, with `must` mustBring refs (see the top of the file). */
function sizesOf(poolSize: number, maxSize: number, monotone: boolean, must: number): number[] {
  const top = Math.min(maxSize, poolSize);
  const low = Math.max(1, must);
  if (top < low) return [];
  return monotone ? [top] : Array.from({ length: top - low + 1 }, (_, i) => top - i);
}

/** The number of candidate teams with `must` mustBring refs, by binomial sums (nothing enumerated). */
export function teamCount(poolSize: number, maxSize: number, monotone: boolean, must = 0): number {
  return Number(sizesOf(poolSize, maxSize, monotone, must).reduce((sum, k) => sum + binomial(poolSize - must, k - must), 0n));
}

/**
 * Why a team search's request is malformed, or null (see the top of the file); the caller throws a RangeError with
 * its own prefix.
 */
export function invalidTeamSearch(pool: readonly MonRef[], maxSize: number, steer: TeamSteer = {}): string | null {
  if (!Number.isInteger(maxSize)) return `maxSize must be an integer, got ${maxSize}`;
  const twice = (list: readonly MonRef[]): MonRef | undefined => list.find((ref, i) => list.indexOf(ref) !== i);
  const doubled = twice(pool);
  if (doubled !== undefined) return `the pool lists ${doubled} twice`;
  const inPool = new Set(pool);
  const lists = { mustBring: steer.mustBring ?? [], preferred: steer.preferred ?? [] };
  for (const [name, list] of Object.entries(lists)) {
    const again = twice(list);
    if (again !== undefined) return `${name} lists ${again} twice`;
    const outside = list.find((ref) => !inPool.has(ref));
    if (outside !== undefined) return `${name} lists ${outside}, which is not in the pool`;
  }
  const both = lists.mustBring.find((ref) => lists.preferred.includes(ref));
  return both === undefined ? null : `${both} is in both mustBring and preferred`;
}

/** Every k-subset of `items`, lexicographic over their order, lazily (k = 0: the empty subset once; k > n: none). */
function* subsets<T>(items: readonly T[], k: number): Generator<T[]> {
  const n = items.length;
  if (k < 0 || k > n) return;
  const at = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield at.map((j) => items[j]!);
    let t = k - 1;
    while (t >= 0 && at[t] === n - k + t) t--;
    if (t < 0) return;
    at[t] = at[t]! + 1;
    for (let u = t + 1; u < k; u++) at[u] = at[u - 1]! + 1;
  }
}

/**
 * The teams (pool indices `must` plus subsets of `preferred` and `others`, index lists in their enumeration order),
 * by preferred count descending, then each size in `sizes`, then lexicographic (see the top of the file); each team
 * listed in pool order. Lazy: one team at a time.
 */
function* enumerate(pool: readonly MonRef[], must: readonly number[], preferred: readonly number[], others: readonly number[],
  sizes: readonly number[]): Generator<MonRef[]> {
  const m = must.length;
  for (let p = Math.min(preferred.length, (sizes[0] ?? m) - m); p >= 0; p--) {
    for (const k of sizes) {
      const rest = k - m - p;
      if (rest < 0 || rest > others.length) continue;
      for (const fromPreferred of subsets(preferred, p)) {
        for (const fromOthers of subsets(others, rest)) {
          yield [...must, ...fromPreferred, ...fromOthers].sort((a, b) => a - b).map((i) => pool[i]!);
        }
      }
    }
  }
}

const keyOf = (s: number): number => (Number.isNaN(s) ? Number.NEGATIVE_INFINITY : s);

/** The candidate teams, in search order (see the top of the file). */
export function teamCandidates(pool: MonRef[], maxSize: number, monotone: boolean, score?: (team: MonRef[]) => number,
  maxSorted: number = DEFAULT_CONFIG.maxTeamCandidates, steer: TeamSteer = {}): TeamCandidates {
  const invalid = invalidTeamSearch(pool, maxSize, steer);
  if (invalid !== null) throw new RangeError(`team: ${invalid}`);
  const refs = [...pool];
  const mustSet = new Set(steer.mustBring ?? []);
  const preferredSet = new Set(steer.preferred ?? []);
  const must = refs.flatMap((ref, i) => (mustSet.has(ref) ? [i] : []));
  const sizes = sizesOf(refs.length, maxSize, monotone, must.length);
  const count = teamCount(refs.length, maxSize, monotone, must.length);
  const free = refs.flatMap((ref, i) => (mustSet.has(ref) ? [] : [i]));   // pool order
  if (count <= maxSorted) {
    let teams = [...enumerate(refs, must, [], free, sizes)];   // larger first, then lexicographic by pool index
    if (score !== undefined || preferredSet.size > 0) {
      const keyed = teams.map((team, order) => ({
        team, order, p: team.filter((ref) => preferredSet.has(ref)).length, s: score === undefined ? 0 : keyOf(score([...team])),
      }));
      keyed.sort((a, b) => (a.p !== b.p ? b.p - a.p : a.s === b.s ? a.order - b.order : b.s > a.s ? 1 : -1));
      teams = keyed.map((k) => k.team);
    }
    return { count, [Symbol.iterator]: () => teams.map((t) => [...t])[Symbol.iterator]() };
  }
  const single = score === undefined ? null : new Map(free.map((i) => [i, keyOf(score([refs[i]!]))]));
  const bySingle = (list: number[]): number[] => (single === null ? list : [...list].sort((a, b) => {
    const [sa, sb] = [single.get(a)!, single.get(b)!];
    return sa === sb ? a - b : sb > sa ? 1 : -1;
  }));
  const preferred = bySingle(free.filter((i) => preferredSet.has(refs[i]!)));
  const others = bySingle(free.filter((i) => !preferredSet.has(refs[i]!)));
  return { count, [Symbol.iterator]: () => enumerate(refs, must, preferred, others, sizes) };
}

/** Recorded complete disproofs; a team is ruled out when it is a subset of one (see the top of the file). */
export class NoGoods {
  private sets: Set<MonRef>[] = [];

  /** Records a complete disproof of `team` (completeDisproof); recorded teams it contains are dropped as redundant. */
  add(team: MonRef[]): void {
    if (this.rulesOut(team)) return;
    this.sets = this.sets.filter((s) => ![...s].every((m) => team.includes(m)));
    this.sets.push(new Set(team));
  }

  /** True when `team` ⊆ some recorded team. */
  rulesOut(team: MonRef[]): boolean {
    return this.sets.some((s) => team.every((m) => s.has(m)));
  }
}

/** A tier-1 failure (`refuted`: prove.ts) that refutes the team for good (see the top of the file). */
export function completeDisproof(refuted: boolean, rootUnmodelled: readonly string[]): boolean {
  return refuted && rootUnmodelled.length === 0;
}

/**
 * How searchTeams runs one team (createSolver supplies them over solveFights, in-process or on the worker pool). A
 * run started ahead (see Window above) gets a `stop` signal; once it is aborted nobody reads that run's answer.
 */
export interface TeamRunners {
  /** Phase A: the tier-1 search alone for `team` until `deadline` (solveFights in tier-1 mode). */
  tier1(team: MonRef[], deadline: number, progress: ProgressSink, stop?: AbortSignal): Tier1Run | Promise<Tier1Run>;
  /** Phase A: a proven team's solveFights in full until `deadline` (awaited in place; never started ahead). */
  full(team: MonRef[], deadline: number, progress: ProgressSink, known: KnownFailure | null): FightRun | Promise<FightRun>;
  /** Phase B: solveFights in full for `team` until `deadline`; with `known` (its Phase A tier-1 failure), tiers 2 and 3 only. */
  risk(team: MonRef[], deadline: number, progress: ProgressSink, known: KnownFailure | null, stop?: AbortSignal): FightRun | Promise<FightRun>;
  /** The shown team's run under the request's deadline: solveWithPreStatus from `baseline` (that team's full run). */
  shown(team: MonRef[], baseline: FightRun, progress: ProgressSink): FightRun | Promise<FightRun>;
}

export interface TeamSearch {
  candidates: Iterable<MonRef[]>; total: number; monotone: boolean; labels: ReadonlyMap<MonRef, string>; ranking: readonly RankKey[];
  now: () => number; start: number; deadline: number; signal?: AbortSignal; progress: ProgressSink; proposePreStatus: boolean;
  runners: TeamRunners;
  window?: number;                            // candidates in flight at once (default 1; see Window above)
}

/**
 * A candidate taken ahead: its run (null: ruled out when taken, or `late`: no time was left to start it), the stop for a
 * run started here, Phase B's known failure, and whether the run is a Phase A full solve reused.
 */
interface Slot<T> { index: number; team: MonRef[]; run: Promise<T> | null; late: boolean; stop: AbortController | null; known: KnownFailure | null; reused: boolean }

/** A share of `left` over `parts` candidates, times the window, never more than `left`. */
function share(left: number, parts: number, window: number): number {
  return Math.min(left, (left * window) / parts);
}

export interface TeamSearchResult {
  run: FightRun | null;                       // the shown run; null when none finished (cancelled, no time, refused)
  refused: { reason: 'unsupportedBattle'; detail: string } | null;
  rejected: RejectedTeam[];                   // capped (see the top of the file)
  tried: number;                              // candidates settled: run in Phase A, ruled out, or first run in Phase B
  provenInPhaseA: boolean;                    // the shown run is Phase A's full solve of a proven team
  evaluated: number;                          // Phase B evaluations (a Phase A full solve reused counts)
  mismatch: string | null;                    // the first Phase B run settled with a re-check disagreement: 'team <labels>: <disagreement>'
  storeDiffers: string | null;                // the first run (Phase A's full solves, Phase B's runs, the shown one, in that order) with a store difference: '<its storeDiffers> (team <labels>)'
}

function bestOf(a: Tier | null, b: Tier | null): Tier | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/** '<reason>: <detail>', without repeating a detail that already starts with its reason. */
function unprovenText(reason: string, detail: string): string {
  return detail.startsWith(`${reason}: `) ? detail : `${reason}: ${detail}`;
}

/** The rejected teams by candidate index, in the order first listed; the first MAX_REJECTED_TEAMS are kept. */
class RejectedList {
  private readonly kept = new Map<number, RejectedTeam>();
  private readonly listed = new Set<number>();

  has(index: number): boolean {
    return this.listed.has(index);
  }

  set(index: number, entry: RejectedTeam): void {
    this.listed.add(index);
    if (this.kept.has(index) || this.kept.size < MAX_REJECTED_TEAMS) this.kept.set(index, entry);
  }

  delete(index: number): void {
    this.listed.delete(index);
    this.kept.delete(index);
  }

  list(): RejectedTeam[] {
    const out = [...this.kept.values()];
    const more = this.listed.size - this.kept.size;
    if (more > 0) out.push({ team: [], firstFailure: `… and ${more} more team${more === 1 ? '' : 's'} not proven` });
    return out;
  }
}

/** Phase A's and Phase B's team search (see the top of the file). */
export async function searchTeams(s: TeamSearch): Promise<TeamSearchResult> {
  const { total } = s;
  const window = Math.max(1, Math.floor(s.window ?? 1));
  const labelsOf = (team: MonRef[]): string => team.map((ref) => s.labels.get(ref) ?? ref).join(', ');
  const failure = (team: MonRef[], why: string): RejectedTeam => ({ team: [...team], firstFailure: `Team ${labelsOf(team)}: ${why}` });
  const aborted = (): boolean => s.signal?.aborted === true;
  const noGoods = new NoGoods();
  const phaseA = new Map<number, Tier1Run>();
  const fullRuns = new Map<number, FightRun>();   // Phase A's full solves that were not shown
  const rejected = new RejectedList();
  let tried = 0;
  let teamBest: Tier | null = null;               // the best tier of a finished run's verdict so far
  let lastText: string | null = null;
  const sink = (prefix: string): ProgressSink => ({
    node: () => s.progress.node(),
    message: (text) => {
      lastText = `${prefix}: ${text}`;
      s.progress.message(lastText, teamBest);
    },
    teams: (t, n) => s.progress.teams(t, n),
  });
  const finished = (v: Verdict): void => {
    if (v.tier === 'unproven') return;
    const before = teamBest;
    teamBest = bestOf(teamBest, v.tier);
    if (teamBest !== before && lastText !== null) s.progress.message(lastText, teamBest);
  };
  const settle = (): void => {
    tried += 1;
    s.progress.teams(tried, total);
  };
  let mismatch: string | null = null;
  let storeDiffers: string | null = null;
  /** Notes a settled run's store difference (config checkerCompare), the first one kept. */
  const differs = (run: FightRun, team: MonRef[]): void => {
    if (run.storeDiffers !== undefined) storeDiffers ??= `${run.storeDiffers} (team ${labelsOf(team)})`;
  };
  const result = (run: FightRun | null, extra: Partial<TeamSearchResult> = {}): TeamSearchResult => ({
    run, refused: null, rejected: rejected.list(), tried, provenInPhaseA: false, evaluated: 0, mismatch, storeDiffers, ...extra,
  });
  s.progress.teams(0, total);
  const stops: AbortController[] = [];            // every run started here, cancelled on the way out
  const stopper = (): AbortController => {
    const stop = new AbortController();
    stops.push(stop);
    return stop;
  };
  // A run that fails (rejects other than by its own cancel) fails the search at once: every other run is cancelled and
  // `failed` rejects with its error, which the candidate being awaited sees (race), whatever its index.
  let fail: (e: unknown) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  failed.catch(() => undefined);
  const started = <T>(answer: T | Promise<T>, stop: AbortController): Promise<T> => {
    const run = Promise.resolve(answer);
    run.catch((e: unknown) => {
      if (stop.signal.aborted) return;   // cancelled here: nobody reads it
      for (const other of stops) other.abort();
      fail(e);
    });
    return run;
  };
  const answer = <T>(run: Promise<T>): Promise<T> => Promise.race([run, failed]);
  try {
    // Phase A: the tier-1 search alone, per candidate; a proven team is solved in full.
    const phaseAEnd = s.start + (s.deadline - s.start) * PHASE_A_SHARE;
    const ahead: Slot<Tier1Run>[] = [];
    const candidates = s.candidates[Symbol.iterator]();
    let taken = 0;
    let exhausted = false;
    const takeA = (): void => {
      while (!exhausted && ahead.length < window) {
        const next = candidates.next();
        if (next.done === true) {
          exhausted = true;
          return;
        }
        const index = taken++;
        const team = next.value;
        const slot: Slot<Tier1Run> = { index, team, run: null, late: false, stop: null, known: null, reused: false };
        ahead.push(slot);
        if (s.monotone && noGoods.rulesOut(team)) continue;
        const begin = s.now();
        const left = phaseAEnd - begin;
        if (!(left > 0) || aborted()) {
          slot.late = true;
          exhausted = true;
          return;
        }
        const stop = stopper();
        slot.stop = stop;
        const deadline = begin + share(left, Math.min(total - index, MAX_SHARES), window);
        slot.run = started(s.runners.tier1(team, deadline, sink(`team ${labelsOf(team)} (${index + 1}/${total})`), stop.signal), stop);
      }
    };
    for (;;) {
      takeA();
      const slot = ahead.shift();
      if (slot === undefined) break;
      const { index: i, team } = slot;
      if (s.monotone && noGoods.rulesOut(team)) {
        slot.stop?.abort();
        settle();
        rejected.set(i, failure(team, 'ruled out: inside a team refuted for good'));
        continue;
      }
      if (slot.run === null) break;   // Phase A's time was up (or a cancel) when this candidate's turn came
      const run = await answer(slot.run);
      if (run.kind === 'unproven' && run.reason === 'unsupportedBattle') return result(null, { refused: { reason: run.reason, detail: run.detail } });
      if (run.kind === 'unproven' && aborted()) break;   // cancelled: not rejected, only not tried
      settle();
      phaseA.set(i, run);
      if (run.kind === 'proven' && run.rootUnmodelled.length > 0) {
        rejected.set(i, failure(team, `unmodelled: ${run.rootUnmodelled.join('; ')}`));
        continue;
      }
      if (run.kind === 'proven') {
        const progress = sink(`team ${labelsOf(team)}`);
        const full = await s.runners.full(team, s.deadline, progress, null);
        differs(full, team);
        const v = full.verdict;
        if (v.tier === 1 || (v.tier === 'unproven' && v.reason === 'timeout')) {
          for (const rest of ahead) rest.stop?.abort();   // this team is shown: the runs ahead are of no use
          const shown = await s.runners.shown(team, full, progress);
          differs(shown, team);
          finished(shown.verdict);
          return result(shown, { provenInPhaseA: true });
        }
        rejected.set(i, failure(team, v.tier === 'unproven' ? unprovenText(v.reason, v.detail) : `tier ${v.tier}`));
        fullRuns.set(i, full);
        finished(v);
        continue;
      }
      rejected.set(i, failure(team, run.kind === 'failed' ? run.refutation.join(' / ') : NOT_IN_SHARE));
      if (s.monotone && run.kind === 'failed' && completeDisproof(run.refuted, run.rootUnmodelled)) noGoods.add(team);
    }
    for (const slot of ahead) slot.stop?.abort();

    // Phase B: tiers 2 and 3 (tier 1 first where Phase A has no failure), per candidate, while time is left.
    let best: { run: FightRun; index: number; team: MonRef[] } | null = null;
    let evaluated = 0;
    const queued: Slot<FightRun>[] = [];
    const again = s.candidates[Symbol.iterator]();
    taken = 0;
    exhausted = false;
    const takeB = (): void => {
      while (!exhausted && queued.length < window) {
        const next = again.next();
        if (next.done === true) {
          exhausted = true;
          return;
        }
        const index = taken++;
        const team = next.value;
        const reuse = fullRuns.get(index);
        if (reuse !== undefined) {
          queued.push({ index, team, run: Promise.resolve(reuse), late: false, stop: null, known: null, reused: true });
          continue;
        }
        const begin = s.now();
        const left = s.deadline - begin;
        if (!(left > 0) || aborted()) {
          queued.push({ index, team, run: null, late: true, stop: null, known: null, reused: false });
          exhausted = true;
          return;
        }
        const prior = phaseA.get(index);
        const known = prior?.kind === 'failed' ? { refutation: prior.refutation, reasons: prior.reasons, refuted: prior.refuted } : null;
        const shares = Math.min(total - index, MAX_SHARES) + (s.proposePreStatus ? 1 : 0);
        const stop = stopper();
        const progress = sink(`tiers 2 and 3, team ${labelsOf(team)} (${index + 1}/${total})`);
        const run = started(s.runners.risk(team, begin + share(left, shares, window), progress, known, stop.signal), stop);
        queued.push({ index, team, run, late: false, stop, known, reused: false });
      }
    };
    for (;;) {
      takeB();
      const slot = queued.shift();
      if (slot === undefined || slot.run === null) break;
      const { index: i, team } = slot;
      const run = await answer(slot.run);
      if (run.recheckMismatch !== undefined) mismatch ??= `team ${labelsOf(team)}: ${run.recheckMismatch}`;
      differs(run, team);
      if (!slot.reused && slot.known === null) {
        // Tier 1 ran here: a first try (settled now), or a retry after a Phase A timeout, a no-good or an unmodelled
        // root (a refutation replaces its entry).
        const v = run.verdict;
        if (!rejected.has(i) && !phaseA.has(i)) settle();
        if (v.tier !== 1) {
          const why = run.refutation !== null ? run.refutation.join(' / ') : v.tier === 'unproven' && v.reason !== 'timeout' ? v.detail : NOT_IN_SHARE;
          if (run.refutation !== null || !rejected.has(i)) rejected.set(i, failure(team, why));
        }
      }
      evaluated += 1;
      if (best === null || betterRun(run, best.run, s.ranking)) best = { run, index: i, team };
      finished(run.verdict);
      if (run.verdict.tier === 1) break;
    }
    for (const slot of queued) slot.stop?.abort();
    if (best === null) return result(null, { evaluated });
    const shown = await s.runners.shown(best.team, best.run, sink(`team ${labelsOf(best.team)}`));
    differs(shown, best.team);
    finished(shown.verdict);
    if (shown.verdict.tier === 1) rejected.delete(best.index);
    return result(shown, { evaluated });
  } finally {
    for (const stop of stops) stop.abort();
  }
}

/**
 * The report line on the team search (createSolver adds it after the run's own assumptions). `mustBring` and
 * `preferred` are the labels of the steering refs searched with (a preferred mon at 0 HP left out); empty, they add
 * nothing.
 */
export function teamSearchNote(o: {
  result: TeamSearchResult; total: number; maxSize: number; eligible: number; fainted: number; monotone: boolean;
  mustBring?: readonly string[]; preferred?: readonly string[];
}): string {
  const { result: r } = o;
  const must = o.mustBring ?? [];
  const preferred = o.preferred ?? [];
  let sizes = o.monotone ? `teams of ${o.maxSize}` : `teams of 1 to ${o.maxSize}`;
  if (!o.monotone && must.length > 0) sizes = must.length >= o.maxSize ? `teams of ${o.maxSize}` : `teams of ${must.length} to ${o.maxSize}`;
  const left = o.fainted === 0 ? '' : ` (${o.fainted} at 0 HP left out)`;
  const steering = `${must.length === 0 ? '' : `, each with ${must.join(', ')}`}${preferred.length === 0 ? '' : `, those with more of ${preferred.join(', ')} first`}`;
  const rule = o.monotone
    ? 'no fight reads the player\'s bench, so a proof for a team holds for every larger team and a complete tier-1 disproof rules out its subsets'
    : 'a fight reads the player\'s bench (Roar, Whirlwind or the AI), so every size is tried and no team is ruled out unseen';
  const evaluated = `${r.evaluated} of ${o.total} team${o.total === 1 ? '' : 's'} evaluated for tiers 2 and 3`;
  let outcome: string;
  if (r.run === null) outcome = 'no team finished';
  else if (r.provenInPhaseA) {
    outcome = r.run.verdict.tier === 1 ? 'the first team with a tier-1 proof is shown' : 'the first team proven tier 1 ran out of time in its full solve, which is shown';
  } else if (r.run.verdict.tier === 1) outcome = `the first team with a tier-1 proof is shown (found with ${evaluated})`;
  else outcome = `no team was proven tier 1; the best of ${evaluated} is shown`;
  return `team search: ${r.tried} of ${o.total} candidate team${o.total === 1 ? '' : 's'} tried, ${sizes} from ${o.eligible} eligible Pokémon${left}${steering}; ${rule}; ${outcome}`;
}
