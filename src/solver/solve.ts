// Solving fights for a fixed team.
// Nothing is claimed until the independent checker has replayed the line.
//
// solveFights. Tier 1: a level-1 Prover deepened to the request's horizon. A win is extracted, ranked (rankProven within
// the request's horizon, so longer, healthier lines can be found) and checked: tier 1. A failure goes to solveRisk and
// its line is checked: tier 2 (a G_j proof, j >= 0) or tier 3. Every figure in a verdict comes from the checker
// (failureAi, failureWorst, critBudget, killers); the tree and each killer's path from renderPlan.
// Time (a verified result stands; refinements cut short never erase it). The tier-1 search gets TIER1_SHARE
// (60%) of the search time: still unresolved then, it stops and solveRisk gets the rest, its checked line the `best` of
// an unproven timeout (tier 1 neither proven nor refuted). A ranking cut short (deadline, LIMIT or unmodelled
// refutation: RankResult.stopped) still gives the checked line as tier 1, its rank as far as it got, and the assumption
// line 'ranking stopped early (<why>): the line is proven safe and checked, but a better-ranked safe line may exist'. A
// risk search cut short (RiskResult.complete false) still gives its checked line: tier 3 says 'bestFoundWithinBudget';
// tier 2 (its budget proven) adds 'tier-2 search stopped early (<why>): …'. Both lines say the line is checked, so they
// are added only when the verdict is that tier (no unproven reason: never with a failed check, a timeout, something
// unmodelled…), and a verdict made unproven later (a root split, a re-check, the pre-status steps: overridden and
// mismatched) drops them, from its `best` too. The badge and the probe keep their own budgets and outcomes.
// Unproven, in this order when several apply:
// - timeout: the deadline or an abort before a line was found and checked (the tier-1 search outside its share, the
//   extraction, a risk search with no line yet, any check cut short), or the tier-1 search out of its share ('not
//   proven within the time limit', or 'cancelled'). The deadline and the signal reach inside an engine
//   step too (expandTurn's shouldStop): each search hands its own deadline and the signal to the arena with
//   every expansion (prove.ts, risk.ts; rank, the badge and the probe through their provers), the checker to its own
//   steps, and a stopped step takes that search's timeout path (never an engine limit). The worker's job does the same
//   with its own deadlines (parallel/jobs.ts). Replays after a search (the plan tree, a risk line's certificate) take
//   no stop.
// - verificationMismatch: a checker mismatch (detail: the first), a checker exception (detail: its message), or a tier-2
//   line whose checked crit budget is below the search's (with worker threads also a worker line this thread's re-check
//   disagrees with, which wins over every reason but an engine refusal; see Parallel below); with config checkerCompare
//   also any check in the run whose store and bare replays differ (checkerDeps.ts; detail 'store and bare checks
//   differ: …'), which wins the same way, and a root split shows such a lead's ('… (lead <label>)') over every other.
//   Such a difference is never hidden by the choice of a run: it travels on the run as
//   FightRun.storeDiffers (the way recheckMismatch does), and the pre-status steps ('… (pre-status <proposal>)', the
//   baseline's as it is), the team search ('… (team <labels>)', team.ts) and this thread's re-check of a worker's line
//   each show the first one met over the run they would otherwise show, whichever run betterRun picks.
// The checker replays on the engine, AI and oracles config picks (checkerDeps.ts runChecker): by default the deps'
//   own, which over the real engine are the worker's store of answers; deps.bare with checkerBareEngine.
// - unmodelled: unmodelledIn() non-empty at a root battle state, the checker's unmodelled list, or a tier-1 failure that
//   is not refuted (prove.ts `refuted`: some choice was only not shown safe) and met an unmodelled outcome;
// - engineLimit: the checker's, or a tier-1 failure that is not refuted and met an engine LIMIT;
// - horizon: a risk line whose failing mass is all cut-off, or any other tier-1 failure that is not refuted
//   (a choice cut off by the horizon);
// - needsHiddenInformation: only instead of a tier-3 verdict, when the probe below finds a RAM-mode proof.
// Each keeps the would-be verdict as `best` when one exists; a risk line's only when the checker finished (its figures
// are the checker's). Engine UNSUPPORTED_DOUBLE anywhere is unsupportedBattle; other search exceptions propagate.
// The level-2 badge (badge.ts), only with req.attemptAnyLegalBadge, display mode and a verified tier-1 line (no unproven
// reason): it gets half the search time left when it starts. RAM mode never attempts it (RAM edge keys hold the AI
// memory, which level 2 does not keep, so no certificate passes at both levels): 'notAttempted' and the line
// 'badge not attempted in RAM mode: …'. Proven on the same line (its level-2 re-check passed): the verdict is that line,
// anyLegalBadge 'proven'. Proven on another line: that line is checked at level 2 and, on a copy, at level 1
// (under the checker's deadline); when both pass it becomes the shown line (its level-2 rank and vector; its tree drawn
// from a level-1 copy, so the branches carry the AI's odds) with 'proven', called the best-ranked level-2 line, or the
// best level-2 line found within the badge budget when the level-2 ranking did not complete; else the level-1 line
// stays with 'failed'. 'failed' also when the badge is refuted or not proven in its time. A proven badge's verification merges the line's level-1 and level-2 checks (counts added, the hits not cross-checked too,
// mismatches concatenated, passed only when both passed; the figures are the level-1 check's). Every report's
// assumptions say whether the badge was attempted and how it ended. A badge or probe cut short leaves `complete` alone.
// The probe (badge.ts), only in display mode with config probeHiddenInformation and a would-be tier-2 or tier-3 verdict:
// a quarter of the search time left. A RAM-mode proof turns tier 3 into unproven needsHiddenInformation (the tier-3
// verdict as `best`) and gives a tier 2 only the enumerated line 'figure: a tier-1 line exists in RAM mode'.
// Tier-1 mode (ctl.mode 'tier1', for the team search's Phase A): the deadline check, the root's unmodelledIn() and the
// tier-1 search only. Nothing is extracted, ranked or checked, so nothing is claimed (its progress messages carry no
// tier): the result is a Tier1Run, not a verdict: 'proven' with the root's unmodelled list (team.ts passes over a team
// whose list is not empty); 'failed' with the refutation, the failure reasons, whether it is refuted and the root's
// unmodelled list (team.ts decides from them whether the failure is a complete disproof); or 'unproven' (timeout or cancel, or the engine
// refusing the battle). It throws for a restrictRoot: a restricted failure is no disproof of the team. A known failure (ctl.knownFailure, full mode, the team search's Phase B): tier 1 already failed this way for
// these fights and this team, so the tier-1 search is skipped and tiers 2 and 3 run at once with it, as after a fresh
// failure (the tier-1 search is deterministic: a repeat would fail the same way).
// createSolver.solve: resolves the fights (and a fixed team), refuses a double battle and more worlds than maxWorlds
// (decision solver-018). Fixed team: refuses an empty team and a team member at 0 HP in the save unless fight 0 starts
// healed (noEligibleTeam: the engine refuses a battle with a fainted mon carried in), then runs solveWithPreStatus with
// deadline = start + budgetMs and the checker's deadline budgetMs × checkerBudgetFactor after it.
// Team search (team.ts; contracts TeamSearch): a malformed request is a
// RangeError (team.ts invalidTeamSearch: a maxSize that is not an integer, a pool that lists a ref twice, a mustBring or
// preferred list that lists a ref twice or one not in the pool, a ref in both lists). More mustBring mons than maxSize
// is noEligibleTeam, naming them; so is a mustBring mon at 0 HP in the save, unless fight 0 starts healed. Other pool
// members at 0 HP are left out the same way, a preferred one from the preferred list too; an empty pool after that is
// noEligibleTeam, and so is a maxSize below 1; maxSize is clamped to the pool. monotone = every fight's benchMonotone.
// teamCandidates (mustBring and preferred as steering; scored by deps.teamScore over the fights; lazy above config
// maxTeamCandidates) feeds searchTeams, with its exact count as the total, under the same deadlines;
// each team's request is the request with that fixed team and the manual pre-status of its members only. The verdict
// is the shown run's, its report's rejectedTeams searchTeams's list and its assumptions ending with the team-search
// line (team.ts teamSearchNote); when no run finished: unproven timeout ('cancelled' or 'not proven within the time
// limit'), or unsupportedBattle when the engine refused the battle.
// Pre-status (prestatus.ts): solveWithPreStatus wraps solveFights. 'given' is
// solveFights as it is: the manual pre-status on fight 0, and the verdict's preStatus is req.startStatus. 'propose': the
// baseline (the request as it is) runs under ctl unchanged, unless the caller passes it (the team search's Phase B
// passes its best run: the same fights and request, already solved); when it is tier 1 nothing is tried. Otherwise each variant
// (preStatusVariants over fight 0's team and req.startStatus) runs with the variant as fight 0's startStatus and as the
// request's startStatus (so its verdict's preStatus is the variant), the search deadline start + (deadline − start) /
// (variants not yet run), start = when it begins (an equal share of the time left: time a variant does not use goes to
// the rest), ctl's checker deadline, and progress messages prefixed with the variant. No variant starts once the
// deadline has passed or the signal is aborted. The best run by betterRun is shown, the baseline counting first, so a
// variant must be strictly better; a shown variant's verdict carries preStatusBaseline (the baseline's tier and, for
// tier 2 or 3, its deathProbability). The shown report's assumptions end with one pre-status line:
// 'pre-status proposals: none tried (tier 1 without one)', 'pre-status proposals: none possible (no candidate pre-status
// for this team)', 'pre-status proposals: <k> of <n> tried[ (cut short)], none better than the result without one',
// or 'pre-status proposed: <label> (<ref>) <status> (<k> of <n> tried[ (cut short)]); without it: tier <t>[, death
// <p> (<percent>)]' ('without it: unproven (<reason>)' for an unproven baseline). '(cut short)' and `complete` false:
// a variant was cut short or never started (`complete` is false too when the baseline was cut short).
// Gauntlets (more than one FightSpec): one ArenaFight per fight, healBefore from its spec,
// the manual pre-status on fight 0 only (later fights get {}: statuses come from the carry, or a heal cures them). It
// is one proof across the fights: the arena turns a final win of fight k into fight k+1's entry (a p1 faint is a dead
// leaf, so no fight starts from a dead carry), equal carries share one entry belief and its proof, the lead is chosen
// again at each entry, the horizon is per fight, and crit steps and death odds count across the whole gauntlet. A
// double in any fight is refused (unsupportedBattle). A gauntlet's verdicts (and `best`) carry `entries`, built from
// the check of the line shown (report.ts gauntletEntries over its endStates); none when that check was cut short.
// Progress: the sink reports at most every progressIntervalMs (message and teams report, node only counts) and once
// more at the end; each search node refreshes the message (stage and node count).
// Parallel: with config
// threads > 1 and either deps.pool (a SolverPool, parallel/solverPool.ts, that outlives the solve) or a depsModule,
// createSolver runs the solve's jobs on worker threads; otherwise everything runs in-process as above. With deps.pool
// the jobs run in a lane of that pool (parallel/pool.ts): at most min(threads, pool.size) at once (the solve's width),
// the solve's clock for their deadlines; the lane is closed when the solve ends (anything of it left is rejected) and
// the pool never is (config.depsModule is not used: the pool has its own). Without one, the solve opens a WorkerPool of
// `threads` workers for itself (its width) and closes it at the end. Either way every job carries deps.workerContext
// when given (the worker builds that context's deps once per key; parallel/worker.ts), and a cancel terminates only
// the workers running this solve's jobs. Jobs run solveFights itself in a worker (parallel/jobs.ts runJob).
// - Fixed team, the root split (splitFights): one 'root' job per lead (beliefChoices at the root, in that order) with
//   restrictRoot [that lead], every job under the solve's deadlines. A lead plus a first move is not split: restrictRoot
//   applies only at the entry, so a first-move split would need the restriction below it. The first lead job that
//   fails (rejects other than by a cancel: a worker crash, a deps module that throws) stops every other lead at once and
//   the solve rejects with its error. Only the lines that can be shown are re-checked on this thread (recheck, below),
//   in preference order: the leads' would-be lines, best first by the comparison below, until one passes (it
//   finishes and agrees), which is the chosen line; so no line is compared or shown unless this thread checked it. A
//   lead whose re-check was cut short or disagrees becomes unproven (timeout, verificationMismatch) and is never
//   compared as a claim; a line ranked below the chosen one, or a lead with no line to show, is not re-checked. A
//   disagreement ends the re-checks and is never silent (the worker's deps differ
//   from this thread's, a configuration bug that loses lines): the split's verdict is then unproven
//   verificationMismatch, detail 'lead <label>: <disagreement>' plus '; <k> of <n> leads ran out of time' when other
//   leads timed out (in their search or their re-check), its `best` the disagreeing lead's would-be line (its claim, or
//   its unproven verdict's `best`, with the worker's report and the line 'this thread's re-check of this line disagrees
//   with the worker's check (see the verdict detail)'), its report that lead's with this thread's re-check as the
//   verification (never another lead's empty report), and the split's FightRun carries that detail as `recheckMismatch`
//   (the pre-status steps read it); only an engine refusal stays. With no line passing and no disagreement (every line's
//   check was cut short), the verdict shown is the lead with the best line (the first re-checked), never a lead with no
//   line while another has one. The lead runs are compared by their would-be verdicts (the claim, or an unproven verdict's
//   `best`, as in-process ranks a line before its check decides): if any is tier 1, the best tier-1 line, where a proven
//   level-2 badge beats no badge, then a level-1 certificate (a lead whose best-ranked line passed level 2 itself) beats
//   a level-2 one, then compareRank on the rank vectors (only lines of one certificate level meet there: level-2 figures
//   are worst cases over every legal action); else the best tier-2 or tier-3 line by betterRun (the lower failure; a
//   tier-3 line, shown or as `best`, keeps 'proven' only when every lead's own would-be verdict is a proven tier-3
//   line, else 'bestFoundWithinBudget': each lead's least failure is its own); else
//   the most severe unproven reason (the order below). Ties keep the lower lead index, so the choice never depends on
//   timing. The verdict is that lead's (after its re-check), made unproven, its would-be verdict kept as `best`, for the
//   most severe of these reasons (a reason of the lead's own at least as severe staying): any lead timed out, in its
//   search or its re-check (timeout: the split did not finish), unless the chosen line is a verified tier-1 line, which
//   stands with 'ranking stopped early (unfinished leads: <labels>): …' (added last, and only when the split's
//   verdict is still tier 1); with no tier-1 line,
//   the first lead whose own tier-1 failure is not refuted (its unproven reason, detail 'lead <label>: ' and its own:
//   tier 1 is refuted for the fights only when every lead's failure is, as the root's OR in-process); unmodelledIn() at
//   any lead's first battle states (this thread, every lead, as in-process) non-empty (unmodelled; detail: those
//   entries and the chosen line's re-check's, as in-process). An engine refusal (unsupportedBattle) in any lead is the
//   verdict. A cancel is unproven timeout 'cancelled'. The report is the chosen lead's, with the counts of every lead's
//   search (splitCounts: nodes and turn executions summed; the enumerated chance kinds and AI supports over every lead)
//   and the split's own elapsed time (its table counts stay the chosen lead's); `complete` is every lead's and the
//   re-check's; `refuted` is true when every lead's failure is, false when any lead's is not. Each lead is judged alone,
//   so the split may be more cautious than in-process, never less.
// - The re-check (recheck): before a worker's line is compared or becomes a verdict, this thread checks its certificate
//   again with the checker (and, for a proven badge, at the other level too, merged as above) and compares it with the
//   worker's own check, which the job sends (FightRun.check: the whole CheckResult, whether it finished, its time). They
//   disagree in what decides a verdict (passed, the reason, the set of mismatch texts, the set of unmodelled entries, or a
//   figure the claim stands on: tier 1 the worst end; tier 2 both death odds and the crit budget; tier 3 both death odds)
//   and in the counts (damage and order checks, states visited, the hits not cross-checked per move). The
//   counts are deterministic (the engine's state carries no wall-clock text and the checker's keys ignore it), so two
//   finished checks of one line that differ only in them mean
//   the worker's deps or data differ: a mismatch like any other, the detail naming the counts that differ.
//   A check cut short is a timeout, never a mismatch: when the worker's own check did not finish (FightRun.check
//   `finished` false, or no check sent) nothing is compared and this thread does not re-check; when this thread's
//   re-check stops at its deadline nothing is compared either. Either way the lead (or team) is unproven timeout, its
//   would-be verdict kept as `best` with a line saying how far it was checked: 'the worker's check of this line did not
//   finish; this thread did not re-check it' (WORKER_CUT) when the worker's own check was cut short, else 'this line
//   was checked by a worker thread only; this thread's re-check did not finish' (WORKER_ONLY). Each re-check has its own deadline, max(the checker's deadline, now +
//   max(2 s, 2 × the worker's own check time)): the re-checks run on this thread after every lead job, so under the
//   checker's deadline alone a worker check that ended near it would leave its re-check no time. In a root split a
//   re-check cut short past the checker's deadline also ends the re-checks: the lines left count as not
//   re-checked and the verdict follows the timeout rule. A re-check that finishes ends them too (it passes or
//   disagrees), and a cut-short one is past the checker's deadline (its own is never earlier), so at most one re-check
//   runs out its allowance: a split's re-checks end by max(the checker's deadline, that re-check's start + its
//   allowance). A team search re-checks each Phase B run in its runner, each with that bound of its own.
// - Pre-status proposals: the baseline and each variant are root splits (solveWithPreStatusAsync; same steps). A step's
//   re-check disagreement is never silent: a variant's unproven run is never shown and a variant's claim would
//   hide the baseline's, so the steps note the first one (the baseline's `recheckMismatch`, then each variant's in
//   order, prefixed 'pre-status <proposal>: '). With one, the run the steps would show becomes unproven
//   verificationMismatch with that detail, its would-be verdict as `best`, and carries it as `recheckMismatch`; only an
//   engine refusal stays.
// - Team search: searchTeams with window = the solve's width (team.ts, Window): Phase A's tier-1 searches and Phase B's full runs
//   are 'team' jobs (phases 'tier1' and 'risk', the candidate's own request, unrestricted); a proven team's full solve
//   runs on this thread, as in-process, and the shown run's pre-status variants are root splits. Each Phase B run from a
//   worker with a line to show is re-checked in its runner, before searchTeams compares it: one that fails is that
//   team's unproven run (verificationMismatch, with this thread's re-check as the verification, or timeout; its line as
//   `best`), which betterRun never prefers to a claim; a disagreement also
//   makes the search's verdict unproven verificationMismatch (team.ts `mismatch`: 'team <labels>: ' and the first Phase B
//   run settled with one), the shown verdict as `best`. A failing job fails the search at once (team.ts).

import { setMaxListeners } from 'node:events';
import type { Choice, Rational } from '../contracts/engine.js';
import type {
  GauntletEntry, KillBranch, MonRef, Progress, ProofReport, RankKey, Solver, SolveRequest, TeamSearch as TeamSearchRequest, Tier, UnprovenReason, Verdict,
} from '../contracts/solver.js';
import type { StartStatus } from '../save/status.js';
import { Arena, ArenaLimitError, emptyStats, type SearchStats } from './arena.js';
import { attemptBadge, probeHiddenInformation } from './badge.js';
import { beliefChoices, expandBelief, rootBelief, type Belief, type BeliefChild } from './belief.js';
import { extractProof, type Certificate } from './certificate.js';
import type { CheckResult } from './check/checker.js';
import { runChecker, STORE_DIFFERS } from './checkerDeps.js';
import { DEFAULT_RANKING, resolveConfig } from './config.js';
import type { ArenaFight } from './inputs.js';
import { choiceText } from './keys.js';
import { defaultLabeler } from './labeler.js';
import { fromJobResult, type Job, type JobResult } from './parallel/jobs.js';
import { isAbortError, WorkerPool, type JobProgress, type JobRunner, type PoolLane } from './parallel/pool.js';
import { renderPlan, type RenderedPlan } from './plan.js';
import { betterRun, preStatusVariants } from './prestatus.js';
import { gameExpandOptions, Prover, type ProofResult } from './prove.js';
import { compareRank, rankProven, type RankResult, type RankVector } from './rank.js';
import { eq, isZero, ONE, percent, toJson, ZERO } from './rational.js';
import { baseAssumptions, buildReport, enumeratedOf, gauntletEntries, notCrossCheckedList, statusText, verificationOf } from './report.js';
import { solveRisk } from './risk.js';
import {
  invalidTeamSearch, searchTeams, teamCandidates, teamSearchNote, type RejectedTeam, type TeamRunners, type TeamSearchResult,
} from './team.js';
import type { FailReasons, FightInfo, MonInfo, PlanLabeler, SolverConfig, SolverDeps } from './types.js';

export interface FightRun {                      // one solve of fixed fights and a fixed team (reused by Tasks 13–17)
  verdict: Verdict; certificate: Certificate | null; vector: RankVector | null; failure: Rational | null;
  refutation: string[] | null;                   // the first failing branch when tier 1 failed
  refuted?: boolean;                             // when tier 1 failed: whether that failure is refuted (prove.ts)
  recheckMismatch?: string;                      // a worker's run whose line this thread's re-check disagrees with: the disagreement
  storeDiffers?: string;                         // config checkerCompare: a check of this run (or of a run it was chosen over) whose store and bare replays differ: the verdict's detail ('store and bare checks differ: …'), carried as recheckMismatch is
  complete: boolean;                             // false: a budget cut something short
  stats?: SearchStats;                           // the search's counts behind the report (a root split adds its leads'); absent: nothing searched
  check?: LineCheck;                             // the check of the run's line (`certificate`); absent without a line
}

/**
 * A check of a line as a run carries it to the thread that re-checks it: the checker's result (merged as the verdict's
 * when the badge is proven), whether the walk finished (false: cut short by its deadline or a cancel; a checker
 * exception is a finished check whose result names it) and how long it took on its own thread's clock.
 */
export interface LineCheck { result: CheckResult; finished: boolean; elapsedMs: number }

/** A tier-1 failure already found for the same fights and team (see the top of the file). */
export interface KnownFailure { refutation: string[]; reasons: FailReasons; refuted: boolean }

/** solveFights in tier-1 mode (see the top of the file): nothing is claimed. */
export type Tier1Run =
  | { kind: 'proven'; rootUnmodelled: string[] }
  | { kind: 'failed'; refutation: string[]; reasons: FailReasons; refuted: boolean; rootUnmodelled: string[] }
  | { kind: 'unproven'; reason: 'timeout' | 'unsupportedBattle'; detail: string };

export interface ProgressSink { node(): void; message(text: string, bestTier?: Tier | null): void; teams(tried: number, total: number): void }

export interface FightControl {
  deadline: number; checkerDeadline: number; signal?: AbortSignal; progress: ProgressSink; restrictRoot?: Choice[];
  mode?: 'full';                                 // the default: the whole pipeline (Tier1Control is the other mode)
  knownFailure?: KnownFailure;                   // tier 1 already failed this way: tiers 2 and 3 at once
}

/** Tier-1 mode: the tier-1 search only, never restricted at the root (see the top of the file). */
export interface Tier1Control extends Omit<FightControl, 'mode' | 'knownFailure' | 'restrictRoot'> { mode: 'tier1' }

type Unproven = Extract<Verdict, { tier: 'unproven' }>;
type Claim = Exclude<Verdict, Unproven>;
type Fail = Extract<ProofResult, { kind: 'fail' }>;
interface Why { reason: UnprovenReason; detail: string }

/**
 * A checked line. `finished`: the checker ran to the end without an exception, so its figures stand; `stopped`: its
 * deadline or a cancel cut it short; `elapsedMs`: how long the check took (the badge's own level-2 check of the line:
 * the whole attemptBadge call that made it).
 */
export interface Checked { result: CheckResult; finished: boolean; stopped: boolean; elapsedMs: number }

/** A line found and checked; `claim` builds its would-be verdict (null when its figures cannot be trusted). */
interface Line { certificate: Certificate; checked: Checked; vector: RankVector | null; claim: ((report: ProofReport) => Claim) | null }

/**
 * The tier-1 line a verdict shows: its certificate, its check (merged when the badge is proven), its rank and why that
 * ranking is not complete (RankResult.stopped; [] when it is).
 */
interface Shown { certificate: Certificate; checked: Checked; vector: RankVector; rank: RankResult['rank']; stopped: string[] }

/** The share of the search time the tier-1 search gets in full mode before the rest goes to a best line. */
const TIER1_SHARE = 0.6;

/** The report line for a checked tier-1 line whose ranking stopped early. */
function rankingStopped(why: string): string {
  return `ranking stopped early (${why}): the line is proven safe and checked, but a better-ranked safe line may exist`;
}

/** The report line for a tier-2 line whose search stopped early: its budget is proven, not the largest. */
function tier2Stopped(why: string): string {
  return `tier-2 search stopped early (${why}): the line is checked and its crit budget proven, but a larger budget or a lower death chance may exist`;
}

type Badge = Extract<Verdict, { tier: 1 }>['anyLegalBadge'];

const BADGE = 'level-2 badge (safe against every legal enemy action)';
const NEEDS_RAM = 'a safe line exists only if the exact enemy state is read from RAM';
const RAM_FIGURE = 'figure: a tier-1 line exists in RAM mode';
const LEVEL2_ENUMERATED = 'every legal enemy action at level 2 (the level-2 badge)';
const RAM_BADGE = 'badge not attempted in RAM mode: level-1 and level-2 observation keys differ';

/**
 * The badge's assumption line before (or without) an attempt. RAM mode never attempts it: RAM edge keys hold the AI
 * memory, which level 1 keeps and level 2 does not, so no certificate could pass the checker at both levels.
 */
function badgeNotAttempted(req: SolveRequest, cfg: SolverConfig): string {
  if (!req.attemptAnyLegalBadge) return `${BADGE}: not attempted (not requested)`;
  return cfg.observationMode === 'ram' ? RAM_BADGE : `${BADGE}: not attempted (no verified tier-1 line)`;
}

const defaultNow = (): number => performance.now();

function codeOf(e: unknown): unknown {
  return typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 12345 → '12,345'. */
function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A checker that threw: no figures, one mismatch naming the error. */
function crashed(message: string): CheckResult {
  return {
    passed: false, reason: 'verificationMismatch', mismatches: [`checker error: ${message}`], unmodelled: [], damageChecks: 0, orderChecks: 0,
    statesVisited: 0, worlds: 0, notCrossChecked: {}, failureAi: ONE, failureWorst: ONE, cutoffAi: ZERO, critBudget: -1, worstEnd: null, maxTurns: 0,
    killers: [], endStates: [],
  };
}

/** Two checks' not-cross-checked hits added per move (CheckResult.notCrossChecked), keys sorted. */
function addCounts(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): Record<string, number> {
  const sum = new Map(Object.entries(a));
  for (const [move, hits] of Object.entries(b)) sum.set(move, (sum.get(move) ?? 0) + hits);
  return Object.fromEntries([...sum].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
}

/** A check that finished and passed. */
function passing(c: Checked): boolean {
  return c.finished && c.result.passed;
}

/**
 * What checking a line needs: FightSolve's own checks and this thread's re-check of a worker's line. `onDiffer` hears a
 * store-and-bare difference under config checkerCompare (checkerDeps.ts).
 */
export interface CheckEnv {
  deps: SolverDeps; cfg: SolverConfig; fights: ArenaFight[]; labeler: PlanLabeler; checkerDeadline: number; signal?: AbortSignal;
  onDiffer?: (detail: string) => void;
}

/**
 * The checker over `cert` (at its own level) with the checker's deadline, on the engine, AI and oracles config picks
 * (checkerDeps.ts runChecker: the deps' own, which are the worker's store over the real engine; deps.bare's with
 * checkerBareEngine; both, compared, with checkerCompare); an exception (other than UNSUPPORTED_DOUBLE) is a mismatch,
 * never a crash. Exported for its tests.
 */
export function checkLine(env: CheckEnv, cert: Certificate, killerLimit: number = env.cfg.killerLimit): Checked {
  const clock = env.deps.now ?? defaultNow;
  let late = false;
  const now = (): number => {
    const t = clock();
    if (t > env.checkerDeadline) late = true;
    return t;
  };
  const began = clock();
  let result: CheckResult;
  try {
    result = runChecker(env.deps, env.cfg, {
      certificate: cert, fights: env.fights, labeler: env.labeler, killerLimit, deadline: env.checkerDeadline, now, signal: env.signal,
      maxLeaves: env.cfg.maxLeaves,
    }, env.onDiffer);
  } catch (e) {
    if (codeOf(e) === 'UNSUPPORTED_DOUBLE') throw e;
    return { result: crashed(messageOf(e)), finished: false, stopped: false, elapsedMs: Math.max(0, clock() - began) };
  }
  const stopped = result.reason === 'timeout' || late || (!result.passed && env.signal?.aborted === true);
  return { result, finished: !stopped, stopped, elapsedMs: Math.max(0, clock() - began) };
}

/**
 * unmodelledIn() of every battle state the leads start (the first decision beliefs), `allowed`'s only when given, first
 * seen first. Before or after a search, never part of one: its expansions take no stop. Exported for its tests.
 */
export function rootUnmodelled(deps: SolverDeps, cfg: SolverConfig, arena: Arena, root: Belief, allowed: Choice[] | undefined): string[] {
  const found = new Set<string>();
  const only = allowed === undefined ? null : new Set(allowed.map(choiceText));
  const opts = gameExpandOptions({ level: 1, critBudget: null, thresholds: null }, cfg.observationMode);
  for (const choice of beliefChoices(arena, root)) {
    if (only !== null && !only.has(choiceText(choice))) continue;
    let children: BeliefChild[];
    try {
      children = expandBelief(arena, root, choice, opts).children;
    } catch (e) {
      if (e instanceof ArenaLimitError) continue;   // the search meets it too: engineLimit
      throw e;
    }
    for (const child of children) {
      for (const { member } of child.belief.members) {
        if (member.state !== null) for (const u of deps.engine.unmodelledIn(member.state)) found.add(u);
      }
    }
  }
  return [...found];
}

/** Why a check of the badge's line does not count: its first mismatch, its reason, or that it was cut short. */
function problemOf(c: Checked): string {
  if (c.result.mismatches.length > 0) return c.result.mismatches[0]!;
  if (!c.finished) return 'the check was cut short';
  return c.result.reason ?? 'the check did not pass';
}

/**
 * Two checks of one line as one: counts added (the hits not cross-checked too, per move), mismatches concatenated (and
 * the unmodelled entries), passed only when both passed; every figure is `primary`'s.
 */
function mergeChecks(primary: Checked, other: Checked): Checked {
  const a = primary.result;
  const b = other.result;
  const { reason: _reason, ...figures } = a;
  const reason = a.reason ?? b.reason;
  return {
    result: {
      ...figures, ...(reason === undefined ? {} : { reason }), passed: a.passed && b.passed,
      mismatches: [...a.mismatches, ...b.mismatches], unmodelled: [...new Set([...a.unmodelled, ...b.unmodelled])],
      damageChecks: a.damageChecks + b.damageChecks, orderChecks: a.orderChecks + b.orderChecks, statesVisited: a.statesVisited + b.statesVisited,
      notCrossChecked: addCounts(a.notCrossChecked, b.notCrossChecked),
    },
    finished: primary.finished && other.finished, stopped: primary.stopped || other.stopped, elapsedMs: primary.elapsedMs + other.elapsedMs,
  };
}

/** A ProgressSink over `onProgress` (see the top of the file); `flush` reports the last state if it was not reported. */
export function progressSink(onProgress: ((p: Progress) => void) | undefined, now: () => number, start: number, intervalMs: number): ProgressSink & { flush(): void } {
  let nodes = 0;
  let tried = 0;
  let total = 1;
  let bestTier: Tier | null = null;
  let text = 'starting';
  let last = Number.NEGATIVE_INFINITY;
  let pending = false;
  const report = (force: boolean): void => {
    if (onProgress === undefined) return;
    const t = now();
    if (!force && t - last < intervalMs) {
      pending = true;
      return;
    }
    last = t;
    pending = false;
    onProgress({ elapsedMs: Math.max(0, t - start), nodes, teamsTried: tried, teamsTotal: total, bestTier, message: text });
  };
  return {
    node(): void {
      nodes += 1;
      pending = true;
    },
    message(m: string, tier?: Tier | null): void {
      text = m;
      if (tier !== undefined) bestTier = tier;
      report(false);
    },
    teams(t: number, n: number): void {
      tried = t;
      total = n;
      report(false);
    },
    flush(): void {
      if (pending) report(true);
    },
  };
}

/** One run of solveFights (see the top of the file). */
class FightSolve {
  private readonly stats = emptyStats();
  private readonly arena: Arena;
  private readonly root: Belief;
  private readonly now: () => number;
  private readonly started: number;
  private readonly labeler: PlanLabeler;
  private readonly ranking: readonly RankKey[];
  private readonly history = new Map<string, Choice>();
  private readonly worlds: number;
  private tt = { entries: 0, hits: 0 };
  private rootUnmodelled: string[] = [];
  private bestTier: Tier | null = null;
  private complete = true;
  /** The report's badge assumption line; extra enumerated lines (the badge's level 2, the probe's tier-2 finding). */
  private badgeNote: string;
  private readonly extraEnumerated: string[] = [];
  /** Extra assumption lines after the badge's: a refinement cut short (the ranking, the tier-2 search). */
  private readonly extraAssumptions: string[] = [];
  /** The progress message for the node count given (grouped). */
  private stage: (nodes: string) => string = (n) => `starting, ${n} nodes`;
  /** Full mode's known tier-1 failure and root restriction (see the top of the file). */
  private readonly known: KnownFailure | undefined;
  private readonly restrictRoot: Choice[] | undefined;
  /** The first store-and-bare difference any check of this run met (config checkerCompare): the verdict's reason, then. */
  private storeDiffers: string | null = null;
  private readonly noteDiffer = (detail: string): void => {
    this.storeDiffers ??= detail;
  };

  constructor(private readonly deps: SolverDeps, private readonly cfg: SolverConfig, private readonly fights: ArenaFight[],
    private readonly req: SolveRequest, private readonly ctl: FightControl | Tier1Control) {
    this.known = ctl.mode === 'tier1' ? undefined : ctl.knownFailure;
    this.restrictRoot = ctl.mode === 'tier1' ? undefined : ctl.restrictRoot;
    this.now = deps.now ?? defaultNow;
    this.started = this.now();
    this.labeler = deps.labeler ?? defaultLabeler;
    this.ranking = req.ranking.length === 0 ? DEFAULT_RANKING : req.ranking;
    this.arena = new Arena({
      engine: deps.engine, enemyModel: deps.enemyModel, fights, edgeCacheEntries: cfg.edgeCacheEntries, maxLeaves: cfg.maxLeaves, stats: this.stats,
    });
    this.root = rootBelief(this.arena);
    this.worlds = Math.max(...fights.map((f) => f.info.worlds.length));
    this.badgeNote = badgeNotAttempted(req, cfg);
  }

  run(): FightRun {
    try {
      return this.search();
    } catch (e) {
      if (codeOf(e) !== 'UNSUPPORTED_DOUBLE') throw e;
      return this.finish(null, { reason: 'unsupportedBattle', detail: `the engine refuses the battle: ${messageOf(e)}` }, null);
    }
  }

  /** Tier-1 mode (see the top of the file). */
  tier1(): Tier1Run {
    if ((this.ctl as { restrictRoot?: unknown }).restrictRoot !== undefined) {
      throw new Error('solve: tier-1 mode does not support restrictRoot (a restricted failure is no disproof of the team)');
    }
    try {
      if (this.ctl.signal?.aborted === true || this.now() >= this.ctl.deadline) return this.tier1Timeout();
      this.rootUnmodelled = this.unmodelledAtRoot();
      const { result } = this.proveTier1();
      if (result.kind === 'unknown') return this.tier1Timeout();
      if (result.kind === 'win') {
        // Unchecked, so no tier is reported: the team search reports tier 1 once a full run has passed the checker.
        this.say(null, (n) => `tier 1 proven (not yet ranked or checked), ${n} nodes`);
        return { kind: 'proven', rootUnmodelled: [...this.rootUnmodelled] };
      }
      this.say(null, (n) => `tier 1 failed, ${n} nodes`);
      return { kind: 'failed', refutation: [...result.refutation], reasons: { ...result.reasons }, refuted: result.refuted, rootUnmodelled: [...this.rootUnmodelled] };
    } catch (e) {
      if (codeOf(e) !== 'UNSUPPORTED_DOUBLE') throw e;
      return { kind: 'unproven', reason: 'unsupportedBattle', detail: `the engine refuses the battle: ${messageOf(e)}` };
    }
  }

  private tier1Timeout(): Tier1Run {
    const { detail } = this.timeout();
    this.say(null, (n) => `unproven (timeout), ${n} nodes`);
    return { kind: 'unproven', reason: 'timeout', detail };
  }

  private search(): FightRun {
    if (this.ctl.signal?.aborted === true || this.now() >= this.ctl.deadline) {
      this.complete = false;
      return this.finish(null, this.timeout(), null);
    }
    this.rootUnmodelled = this.unmodelledAtRoot();
    if (this.known !== undefined) {
      const { refutation, reasons, refuted } = this.known;
      return this.risky({ kind: 'fail', horizon: reasons.horizon, low: Number.POSITIVE_INFINITY, reasons: { ...reasons }, refutation: [...refutation], refuted });
    }
    const { prover, result, horizon } = this.proveTier1(TIER1_SHARE);
    if (result.kind === 'unknown') {
      this.complete = false;
      // Still unresolved at its share of the time: the rest goes to a best line (tiers 2 and 3), shown as `best`.
      if (result.cause === 'timeout' && !this.expired()) return this.risky(null);
      return this.finish(null, this.timeout(), null);
    }
    prover.deadline = this.ctl.deadline;   // the extraction and the ranking run to the search deadline
    return result.kind === 'win' ? this.proven(prover, horizon) : this.risky(result);
  }

  /**
   * The tier-1 search: a level-1 Prover deepened to the request's horizon, stopped once `share` of the search time is
   * used (full mode: TIER1_SHARE; tier-1 mode: all of it).
   */
  private proveTier1(share = 1): { prover: Prover; result: ProofResult; horizon: number } {
    const prover = new Prover(this.arena, { params: { level: 1, critBudget: null, thresholds: null }, ...this.searchOpts() });
    if (share < 1) prover.deadline = this.started + share * (this.ctl.deadline - this.started);
    this.stage = (n) => `tier 1, horizon ${prover.H}, ${n} nodes, table hits ${this.hitRate(prover.tt.hits)}%`;
    const { result, horizon } = prover.deepen(this.root, this.req.horizonTurns);
    this.tt = { entries: prover.tt.size, hits: prover.tt.hits };
    return { prover, result, horizon };
  }

  /** Tier 1: extract, rank within the request's horizon, check. */
  private proven(prover: Prover, horizon: number): FightRun {
    this.say(1, (n) => `tier 1 found, ranking, ${n} nodes`);
    let base: Certificate;
    try {
      base = extractProof(prover, this.root, horizon);
    } catch (e) {
      if (!this.expired()) throw e;   // the deadline stopped a re-proof inside the extraction
      this.complete = false;
      return this.finish(null, this.timeout(), null);
    }
    const ranked = rankProven(this.arena, this.root, { certificate: base, horizon: this.req.horizonTurns }, { ranking: this.ranking, level: 1, ...this.searchOpts() });
    // The ranking is a refinement: cut short, the checked line still stands (the report says so, below).
    if (!ranked.complete && this.expired()) this.complete = false;
    const checked = this.check(ranked.certificate, 'the tier 1 line');
    if (checked.stopped) this.complete = false;
    const why = this.whyNot({ checked, failed: null, horizonCut: false });
    let shown: Shown = { certificate: ranked.certificate, checked, vector: ranked.vector, rank: ranked.rank, stopped: ranked.stopped };
    let badge: Badge = 'notAttempted';
    if (why === null && this.req.attemptAnyLegalBadge && this.cfg.observationMode === 'display') ({ shown, badge } = this.badge(ranked, shown));
    // Only a tier-1 verdict (no unproven reason) says its line is proven safe and checked.
    if (why === null && shown.stopped.length > 0) this.extraAssumptions.push(rankingStopped(shown.stopped.join('; ')));
    const cert = shown.certificate;
    // A level-2 line (the badge's) is drawn at level 1: the AI's real odds, its most likely action first. Its level-1
    // check passed, so the copy is a valid level-1 certificate.
    const plan = this.render(cert.level === 2 ? { ...cert, level: 1 } : cert);
    const claim = (report: ProofReport): Claim => ({ ...this.base(cert, shown.checked, report), tier: 1, tree: plan.tree, anyLegalBadge: badge, rank: shown.rank });
    const line: Line = { certificate: cert, checked: shown.checked, vector: shown.vector, claim };
    return this.finish(line, why, null);
  }

  /**
   * The level-2 badge for the verified tier-1 line `level1` (`ranked` is its ranking): the line to show and the badge
   * (see the top of the file). Never 'proven' without a passing level-2 check of the line shown.
   */
  private badge(ranked: RankResult, level1: Shown): { shown: Shown; badge: Badge } {
    const failed = (detail: string): { shown: Shown; badge: Badge } => {
      this.badgeNote = `${BADGE}: attempted, failed: ${detail}`;
      return { shown: level1, badge: 'failed' };
    };
    const start = this.now();
    const budget = (this.ctl.deadline - start) / 2;
    if (!(budget > 0) || this.ctl.signal?.aborted === true) return failed('no search time left');
    this.extraEnumerated.push(LEVEL2_ENUMERATED);
    this.say(1, (n) => `level-2 badge, ${n} nodes`);
    const began = this.now();
    const result = attemptBadge(this.arena, this.root, ranked, {
      ...this.searchOpts(), deadline: start + budget, ranking: this.ranking, horizon: this.req.horizonTurns, engine: this.deps.engine,
      enemyModel: this.deps.enemyModel, fights: this.fights, oracles: this.deps.oracles, maxLeaves: this.cfg.maxLeaves, killerLimit: this.cfg.killerLimit,
      check: (call) => runChecker(this.deps, this.cfg, call, this.noteDiffer),   // the checker's engine as config picks it (checkerDeps.ts)
    });
    if (result.status === 'failed') return failed(result.detail);
    if (result.rank === null) {
      // The level-1 line passed as a level-2 proof: attemptBadge says so only with a passing check (re-asserted here).
      // That call is the line's level-2 check, so its time counts as the check's: a worker sends the merged time as the
      // re-check's allowance (recheck), and the re-check redoes both levels.
      const at2: Checked = { result: result.check, finished: true, stopped: false, elapsedMs: Math.max(0, this.now() - began) };
      if (!passing(at2)) return failed(`the line did not pass the level-2 check: ${problemOf(at2)}`);
      this.badgeNote = `${BADGE}: attempted, proven on the shown line`;
      return { shown: { ...level1, checked: mergeChecks(level1.checked, at2) }, badge: 'proven' };
    }
    const cert = result.certificate;
    const at2 = this.check(cert, 'the level-2 line');
    const at1 = this.check({ ...cert, level: 1 }, 'the level-2 line at level 1');
    const bad = [at2, at1].find((c) => !passing(c));
    if (bad !== undefined) return failed(`the level-2 line did not pass the checker: ${problemOf(bad)}`);
    const which = result.rank.complete ? 'the best-ranked level-2 line' : 'the best level-2 line found within the badge budget';
    this.badgeNote = `${BADGE}: attempted, proven; the shown line is ${which} (the best-ranked level-1 line fails at level 2)`;
    return { shown: { certificate: cert, checked: mergeChecks(at1, at2), vector: result.rank.vector, rank: result.rank.rank, stopped: result.rank.stopped }, badge: 'proven' };
  }

  /**
   * Tiers 2 and 3 once tier 1 failed (`failed`), or once the tier-1 search ran out of its share of the time (null: tier 1
   * neither proven nor refuted, so the verdict is unproven timeout, the checked line its `best`).
   */
  private risky(failed: Fail | null): FightRun {
    this.say(null, (n) => `tiers 2 and 3, ${n} nodes`);
    const risk = solveRisk(this.arena, this.root, { horizon: this.req.horizonTurns, ranking: this.ranking, ...this.searchOpts() });
    if (risk.kind === 'unknown') {
      this.complete = false;
      return this.finish(null, this.timeout(), failed?.refutation ?? null, failed?.refuted);
    }
    // A search cut short still gives a line (a refinement: tier 3 says 'bestFoundWithinBudget', tier 2's budget is
    // proven and the report says a better line may exist).
    if (!risk.complete) this.complete = false;
    this.say(risk.tier, (n) => `tier ${risk.tier} line found, ${n} nodes`);
    const cert = risk.certificate;
    const checked = this.check(cert, `the tier ${risk.tier} line`);
    if (checked.stopped) this.complete = false;
    const c = checked.result;
    const plan = this.render(cert);
    const killers = this.killers(c, plan);
    let budgetGap: string | null = null;
    if (risk.tier === 2 && checked.finished && (c.critBudget === null || c.critBudget < (risk.critBudget ?? 0))) {
      budgetGap = `tier 2 needs every failing branch to take more than ${risk.critBudget ?? 0} enemy crit step(s); the checker found ${c.critBudget === null ? 'no failing branch' : `one after ${c.critBudget + 1}`}`;
    }
    let claim: Line['claim'] = null;
    if (checked.finished && budgetGap === null) {
      claim = (report) => {
        const odds = { tree: plan.tree, deathProbability: c.failureAi, guaranteeDeathProbability: c.failureWorst, killers };
        return risk.tier === 2
          ? { ...this.base(cert, checked, report), tier: 2, critBudget: c.critBudget!, ...odds }
          : { ...this.base(cert, checked, report), tier: 3, ...odds, optimality: risk.optimality };
      };
    }
    const stoppedBy = this.ctl.signal?.aborted === true ? 'a cancel' : 'the time limit';
    const horizonCut = checked.finished && !isZero(c.failureAi) && eq(c.failureAi, c.cutoffAi);
    let why = failed === null ? this.timeout() : this.whyNot({ checked, failed, horizonCut, budgetGap });
    if (why === null && claim !== null) why = this.probe(risk.tier);
    // Only a tier-2 verdict (no unproven reason) says its line is checked and its crit budget proven.
    if (why === null && risk.tier === 2 && !risk.complete) this.extraAssumptions.push(tier2Stopped(stoppedBy));
    return this.finish({ certificate: cert, checked, vector: null, claim }, why, failed?.refutation ?? null, failed?.refuted);
  }

  /**
   * The hidden-information probe for a would-be tier-2 or tier-3 verdict (see the top of the file): the unproven reason
   * for tier 3 when RAM mode proves tier 1, else null (a tier 2 only gains the enumerated line).
   */
  private probe(tier: 2 | 3): Why | null {
    if (this.cfg.observationMode !== 'display' || !this.cfg.probeHiddenInformation) return null;
    const start = this.now();
    const budget = (this.ctl.deadline - start) / 4;
    if (!(budget > 0) || this.ctl.signal?.aborted === true) return null;
    this.say(tier, (n) => `probing RAM mode for a tier-1 line, ${n} nodes`);
    const found = probeHiddenInformation(this.arena, this.req.horizonTurns, {
      deadline: start + budget, now: this.now, signal: this.ctl.signal, labeler: this.labeler, onNode: this.onNode, restrictRoot: this.restrictRoot,
    });
    if (!found) return null;
    if (tier === 2) {
      this.extraEnumerated.push(RAM_FIGURE);
      return null;
    }
    return { reason: 'needsHiddenInformation', detail: NEEDS_RAM };
  }

  /** The unproven reason, if any (the order at the top of the file). A check cut short is a timeout: nothing stands. */
  private whyNot(o: { checked: Checked; failed: Fail | null; horizonCut: boolean; budgetGap?: string | null }): Why | null {
    const c = o.checked.result;
    if (o.checked.stopped) return this.timeout();
    if (c.reason === 'verificationMismatch') return { reason: 'verificationMismatch', detail: c.mismatches[0] ?? 'verification mismatch' };
    if (o.budgetGap !== undefined && o.budgetGap !== null) return { reason: 'verificationMismatch', detail: o.budgetGap };
    const unmodelled = [...new Set([...this.rootUnmodelled, ...c.unmodelled])];
    if (unmodelled.length > 0) return { reason: 'unmodelled', detail: `unmodelled: ${unmodelled.join('; ')}` };
    // Tier 1 not refuted (prove.ts): some choice was only not shown safe, so tiers 2 and 3 do not decide the verdict.
    const t1 = o.failed !== null && !o.failed.refuted ? o.failed : null;
    if (t1?.reasons.unmodelled === true) return { reason: 'unmodelled', detail: `tier 1 met an unmodelled outcome: ${t1.refutation.join(' → ')}` };
    const t1Limit = t1?.reasons.engineLimit === true;
    if (c.reason === 'engineLimit' || t1Limit) {
      return { reason: 'engineLimit', detail: t1Limit ? `tier 1 met an engine limit: ${t1.refutation.join(' → ')}` : 'the checker met an engine limit on the line' };
    }
    if (!c.passed) return { reason: 'verificationMismatch', detail: `the checker did not pass (${c.reason ?? 'no reason'})` };
    if (o.horizonCut) return { reason: 'horizon', detail: `no branch dies, but every failing branch is cut off by the ${this.req.horizonTurns}-turn horizon` };
    if (t1 !== null) return { reason: 'horizon', detail: `tier 1 is not refuted: a line is cut off by the ${this.req.horizonTurns}-turn horizon and might win with more turns` };
    return null;
  }

  /**
   * The verdict from a line (or none) and the unproven reason (or none: the line's claim, which then must exist);
   * `refutation` and `refuted` describe tier 1's failure, when it failed.
   */
  private finish(line: Line | null, why: Why | null, refutation: string[] | null, refuted?: boolean): FightRun {
    // A check whose store and bare runs differed (config checkerCompare) means the store answered wrongly: nothing of
    // this run stands, whichever line that check was of. Only an engine refusal stays.
    if (this.storeDiffers !== null && why?.reason !== 'unsupportedBattle') why = { reason: 'verificationMismatch', detail: this.storeDiffers };
    const report = buildReport({
      stats: this.stats, tt: this.tt, elapsedMs: Math.max(0, this.now() - this.started), check: line?.checked.result ?? null,
      assumptions: [...baseAssumptions(this.deps, this.cfg, this.req, this.worlds), this.badgeNote, ...this.extraAssumptions],
      enumerated: [...enumeratedOf(this.stats, this.worlds), ...this.extraEnumerated],
      rejectedTeams: [], modelVerifiedInGame: this.cfg.modelVerifiedInGame,
    });
    const claim = line?.claim?.(report) ?? null;
    let verdict: Verdict;
    if (why === null) {
      if (claim === null) throw new Error('solve: a verdict without a checked line');
      verdict = claim;
    } else {
      verdict = { tier: 'unproven', reason: why.reason, detail: why.detail, ...(claim === null ? {} : { best: claim }), report };
    }
    const outcome = verdict.tier === 'unproven' ? `unproven (${verdict.reason})` : `tier ${verdict.tier}`;
    this.ctl.progress.message(`${outcome}, ${grouped(this.stats.nodes)} nodes`, this.bestTier);
    const check: LineCheck | null = line === null ? null : { result: line.checked.result, finished: !line.checked.stopped, elapsedMs: line.checked.elapsedMs };
    return {
      verdict, certificate: line?.certificate ?? null, vector: line?.vector ?? null,
      failure: line !== null && line.checked.finished ? line.checked.result.failureAi : null, refutation, ...(refuted === undefined ? {} : { refuted }),
      complete: this.complete, stats: this.stats, ...(check === null ? {} : { check }), ...differsOf(verdict),
    };
  }

  /**
   * The checker over `cert` (at its own level) with the checker's deadline; an exception (other than
   * UNSUPPORTED_DOUBLE) is a mismatch, never a crash. `what` names the line in the progress message.
   */
  private check(cert: Certificate, what: string): Checked {
    this.say(this.bestTier, (n) => `verifying ${what}, ${n} nodes searched`);
    return checkLine({
      deps: this.deps, cfg: this.cfg, fights: this.fights, labeler: this.labeler, checkerDeadline: this.ctl.checkerDeadline, signal: this.ctl.signal,
      onDiffer: this.noteDiffer,
    }, cert);
  }

  private render(cert: Certificate): RenderedPlan {
    return renderPlan(this.arena, cert, { labeler: this.labeler, nodeLimit: this.cfg.planNodeLimit });
  }

  /** The checker's killers, each path replaced by the plan's death path for its cause when there is one. */
  private killers(c: CheckResult, plan: RenderedPlan): KillBranch[] {
    return c.killers.map((k) => ({ ...k, path: [...(plan.deathPaths[k.cause] ?? k.path)] }));
  }

  /**
   * Team, lead (the root's canonical-index lead: fight 0's), pre-status, report and, for a gauntlet, the entry ranges
   * from `checked` (the check of the line shown; none when it was cut short).
   */
  private base(cert: Certificate, checked: Checked, report: ProofReport): {
    team: MonRef[]; lead: MonRef; preStatus: NonNullable<SolveRequest['startStatus']>; report: ProofReport; entries?: GauntletEntry[];
  } {
    const team = this.fights[0]!.team.map((m) => m.ref);
    const action = cert.nodes[0]!.action;
    const lead = action.kind === 'switch' ? team[action.index] : undefined;
    if (lead === undefined) throw new Error(`solve: the certificate's root action ${choiceText(action)} is not a lead`);
    const gauntlet = this.fights.length > 1 && checked.finished;
    return { team, lead, preStatus: { ...this.req.startStatus }, report, ...(gauntlet ? { entries: gauntletEntries(this.fights, checked.result.endStates) } : {}) };
  }

  /** unmodelledIn() of every battle state the allowed leads start (the first decision beliefs), first seen first. */
  private unmodelledAtRoot(): string[] {
    return rootUnmodelled(this.deps, this.cfg, this.arena, this.root, this.restrictRoot);
  }

  private searchOpts(): {
    mode: SolverConfig['observationMode']; deadline: number; now: () => number; signal?: AbortSignal; labeler: PlanLabeler;
    history: Map<string, Choice>; orderHint?: SolverDeps['orderHint']; onNode: () => void; restrictRoot?: Choice[];
  } {
    return {
      mode: this.cfg.observationMode, deadline: this.ctl.deadline, now: this.now, signal: this.ctl.signal, labeler: this.labeler,
      history: this.history, orderHint: this.deps.orderHint, onNode: this.onNode, restrictRoot: this.restrictRoot,
    };
  }

  /** Called once per search node, just before the searcher counts it in stats.nodes. */
  private readonly onNode = (): void => {
    this.ctl.progress.node();
    this.ctl.progress.message(this.stage(grouped(this.stats.nodes + 1)), this.bestTier);
  };

  private say(bestTier: Tier | null, stage: (nodes: string) => string): void {
    this.bestTier = bestTier;
    this.stage = stage;
    this.ctl.progress.message(stage(grouped(this.stats.nodes)), bestTier);
  }

  /** Table hits as a share of table hits plus nodes, rounded (display only). */
  private hitRate(hits: number): number {
    return Math.round((100 * hits) / Math.max(1, hits + this.stats.nodes));
  }

  private expired(): boolean {
    return this.ctl.signal?.aborted === true || this.now() > this.ctl.deadline;
  }

  private timeout(): Why {
    return { reason: 'timeout', detail: this.ctl.signal?.aborted === true ? 'cancelled' : 'not proven within the time limit' };
  }
}

/** One solve of `fights` (each with the same fixed team) under `ctl`; in tier-1 mode, the tier-1 search only (see the top of the file). */
export function solveFights(deps: SolverDeps, cfg: SolverConfig, fights: ArenaFight[], req: SolveRequest, ctl: Tier1Control): Tier1Run;
export function solveFights(deps: SolverDeps, cfg: SolverConfig, fights: ArenaFight[], req: SolveRequest, ctl: FightControl): FightRun;
export function solveFights(deps: SolverDeps, cfg: SolverConfig, fights: ArenaFight[], req: SolveRequest, ctl: FightControl | Tier1Control): FightRun | Tier1Run {
  if (fights.length === 0) throw new RangeError('solve: no fights');
  const solve = new FightSolve(deps, cfg, fights, req, ctl);
  return ctl.mode === 'tier1' ? solve.tier1() : solve.run();
}

/** The run with `note` added at the end of its verdict's assumptions. */
function withNote(run: FightRun, note: string): FightRun {
  const { verdict } = run;
  return { ...run, verdict: { ...verdict, report: { ...verdict.report, assumptions: [...verdict.report.assumptions, note] } } };
}

/** `progress` with every message prefixed. */
function prefixed(progress: ProgressSink, prefix: string): ProgressSink {
  return {
    node: () => progress.node(),
    message: (text, bestTier) => progress.message(`${prefix}: ${text}`, bestTier),
    teams: (tried, total) => progress.teams(tried, total),
  };
}

/** The status `variant` adds to `given`, in words: 'Machamp (party:0) burn'. */
function proposalText(team: readonly MonInfo[], given: Record<MonRef, StartStatus>, variant: Record<MonRef, StartStatus>): string {
  const ref = Object.keys(variant).find((r) => given[r] === undefined);
  const info = team.find((m) => m.ref === ref);
  if (ref === undefined || info === undefined) throw new Error('solve: a pre-status variant adds no team member');
  return `${info.label} (${ref}) ${statusText(variant[ref]!)}`;
}

/** One solveFights call the pre-status steps ask for. */
export interface FightsCall { fights: ArenaFight[]; req: SolveRequest; ctl: FightControl }

/**
 * solveFights under the request's pre-status option (see the top of the file): 'given' is solveFights itself; 'propose'
 * may show a variant with a proposed pre-status, carrying the baseline's tier and odds. `solved`: the baseline, already
 * solved for these fights and this request (null: solve it here).
 */
export function solveWithPreStatus(deps: SolverDeps, cfg: SolverConfig, fights: ArenaFight[], req: SolveRequest, ctl: FightControl, solved: FightRun | null = null): FightRun {
  const steps = preStatusSteps(deps, fights, req, ctl, solved);
  let step = steps.next();
  while (step.done !== true) step = steps.next(solveFights(deps, cfg, step.value.fights, step.value.req, step.value.ctl));
  return step.value;
}

/** solveWithPreStatus with each solveFights call made by `solve` (the root split), the same steps. */
export async function solveWithPreStatusAsync(deps: SolverDeps, fights: ArenaFight[], req: SolveRequest, ctl: FightControl, solved: FightRun | null,
  solve: (call: FightsCall) => Promise<FightRun>): Promise<FightRun> {
  const steps = preStatusSteps(deps, fights, req, ctl, solved);
  let step = steps.next();
  while (step.done !== true) step = steps.next(await solve(step.value));
  return step.value;
}

/** solveWithPreStatus's steps: each solveFights call is yielded and its run sent back. */
function* preStatusSteps(deps: SolverDeps, fights: ArenaFight[], req: SolveRequest, ctl: FightControl, solved: FightRun | null): Generator<FightsCall, FightRun, FightRun> {
  const baseline = solved ?? (yield { fights, req, ctl });
  if (req.preStatus !== 'propose') return baseline;
  if (baseline.verdict.tier === 1) return withNote(baseline, 'pre-status proposals: none tried (tier 1 without one)');
  const first = fights[0]!;
  const given: Record<MonRef, StartStatus> = { ...req.startStatus };
  const variants = preStatusVariants(first.team, given);
  if (variants.length === 0) return withNote(baseline, 'pre-status proposals: none possible (no candidate pre-status for this team)');
  const ranking = req.ranking.length === 0 ? DEFAULT_RANKING : req.ranking;
  const now = deps.now ?? defaultNow;
  let best = baseline;
  let proposal = '';
  let tried = 0;
  let cut = false;
  let mismatch = baseline.recheckMismatch ?? null;   // the first step's re-check disagreement, baseline first
  let differs = baseline.storeDiffers ?? null;       // the first step's store difference (config checkerCompare), baseline first
  for (const [i, variant] of variants.entries()) {
    const start = now();
    const left = ctl.deadline - start;
    if (!(left > 0) || ctl.signal?.aborted === true) {
      cut = true;
      break;
    }
    const text = proposalText(first.team, given, variant);
    const run: FightRun = yield {
      fights: [{ ...first, startStatus: { ...variant } }, ...fights.slice(1)], req: { ...req, startStatus: { ...variant } },
      ctl: { ...ctl, deadline: start + left / (variants.length - i), progress: prefixed(ctl.progress, `pre-status ${text} (${i + 1}/${variants.length})`) },
    };
    tried += 1;
    if (!run.complete) cut = true;
    if (run.recheckMismatch !== undefined) mismatch ??= `pre-status ${text}: ${run.recheckMismatch}`;
    if (run.storeDiffers !== undefined) differs ??= `${run.storeDiffers} (pre-status ${text})`;
    if (betterRun(run, best, ranking)) {
      best = run;
      proposal = text;
    }
  }
  const counted = `${tried} of ${variants.length} tried${cut ? ' (cut short)' : ''}`;
  const complete = baseline.complete && !cut;
  const shown = best.verdict;
  let result: FightRun;
  if (best === baseline || shown.tier === 'unproven') {
    result = { ...withNote(baseline, `pre-status proposals: ${counted}, none better than the result without one`), complete };
  } else {
    const without = baseline.verdict;
    const odds = without.tier === 2 || without.tier === 3 ? without.deathProbability : undefined;
    const withoutText = without.tier === 'unproven'
      ? `unproven (${without.reason})`
      : `tier ${without.tier}${odds === undefined ? '' : `, death ${toJson(odds)} (${percent(odds)})`}`;
    const verdict: Verdict = { ...shown, preStatusBaseline: { tier: without.tier, ...(odds === undefined ? {} : { deathProbability: odds }) } };
    result = { ...withNote({ ...best, verdict }, `pre-status proposed: ${proposal} (${counted}); without it: ${withoutText}`), complete };
  }
  // A step's re-check disagreement (a root split's) is never silent, whichever step it was and whichever run is shown,
  // so the verdict is unproven verificationMismatch, what would otherwise be shown kept as `best`. Only an
  // engine refusal stays. A step's store difference (config checkerCompare: a store answered wrongly) is never silent
  // either, and wins over a disagreement, as in a root split.
  const refusedBattle = result.verdict.tier === 'unproven' && result.verdict.reason === 'unsupportedBattle';
  if (refusedBattle) return result;
  if (mismatch !== null) result = { ...result, verdict: mismatched(result.verdict, mismatch), recheckMismatch: mismatch };
  return differs === null ? result : withStoreDiffers(result, differs);
}

/** An unproven verdict before any search (nothing searched, nothing verified). */
function refused(deps: SolverDeps, cfg: SolverConfig, req: SolveRequest, worlds: number, elapsedMs: number, why: Why): Verdict {
  const report = buildReport({
    stats: emptyStats(), tt: { entries: 0, hits: 0 }, elapsedMs, check: null, assumptions: [...baseAssumptions(deps, cfg, req, worlds), badgeNotAttempted(req, cfg)],
    enumerated: [], rejectedTeams: [], modelVerifiedInGame: cfg.modelVerifiedInGame,
  });
  return { tier: 'unproven', reason: why.reason, detail: why.detail, report };
}

/** The fights for `team` (canonical order): manual pre-status at fight 0 only, healBefore from each spec. */
export function teamFights(req: SolveRequest, infos: FightInfo[], team: MonInfo[]): ArenaFight[] {
  return infos.map((info, i) => ({ info, team, startStatus: i === 0 ? { ...req.startStatus } : {}, healBefore: req.fights[i]!.healBefore ?? false }));
}

/** The request for one candidate team: that team fixed, and the manual pre-status of its members only. */
export function teamRequest(req: SolveRequest, team: MonRef[]): SolveRequest {
  const own = req.startStatus === undefined ? {} : { startStatus: Object.fromEntries(Object.entries(req.startStatus).filter(([ref]) => team.includes(ref))) };
  return { ...req, team: { kind: 'fixed', party: [...team] }, ...own };
}

/** `verdict` with the team search's rejected teams and its report line. */
function withTeamReport(verdict: Verdict, rejected: RejectedTeam[], note: string): Verdict {
  const report = { ...verdict.report, rejectedTeams: rejected.map((r) => ({ team: [...r.team], firstFailure: r.firstFailure })), assumptions: [...verdict.report.assumptions, note] };
  return { ...verdict, report };
}

/** 'Machamp (party:0), Staraptor (party:1)'. */
function named(mons: readonly MonInfo[]): string {
  return mons.map((m) => `${m.label} (${m.ref})`).join(', ');
}

/** A team search over the request's pool (see the top of the file); with `par`, on the worker pool. */
async function searchTeam(deps: SolverDeps, cfg: SolverConfig, req: SolveRequest, search: TeamSearchRequest, infos: FightInfo[],
  ctl: FightControl, o: { now: () => number; start: number; refuse: (why: Why) => Verdict }, par: Parallel | null): Promise<Verdict> {
  const { pool, maxSize } = search;
  const mustBring = search.mustBring ?? [];
  const invalid = invalidTeamSearch(pool, maxSize, { mustBring, preferred: search.preferred ?? [] });
  if (invalid !== null) throw new RangeError(`solve: ${invalid}`);
  const members = pool.map((ref) => deps.resolver.mon(ref));
  const byPoolRef = new Map(pool.map((ref, i) => [ref, members[i]!]));
  const must = mustBring.map((ref) => byPoolRef.get(ref)!);
  if (must.length > maxSize) {
    return o.refuse({ reason: 'noEligibleTeam', detail: `teams of at most ${maxSize} Pokémon cannot hold the ${must.length} that must come: ${named(must)}` });
  }
  const fainted = req.fights[0]!.healBefore === true ? [] : members.filter((m) => m.mon.currentHp <= 0);
  const mustDown = must.filter((m) => fainted.includes(m));
  if (mustDown.length > 0) {
    const have = mustDown.length === 1 ? 'has' : 'have';
    return o.refuse({ reason: 'noEligibleTeam', detail: `${named(mustDown)} must come but ${have} fainted (0 HP in the save); a fight cannot start with a fainted Pokémon` });
  }
  const eligible = members.filter((m) => !fainted.includes(m));
  if (eligible.length === 0) {
    const detail = pool.length === 0
      ? 'the pool is empty'
      : `every Pokémon in the pool has fainted (0 HP in the save): ${fainted.map((m) => `${m.label} (${m.ref})`).join(', ')}`;
    return o.refuse({ reason: 'noEligibleTeam', detail });
  }
  const size = Math.min(maxSize, eligible.length);
  if (size < 1) return o.refuse({ reason: 'noEligibleTeam', detail: `teams of at most ${maxSize} Pokémon: a team needs at least one` });
  const monotone = infos.every((f) => f.benchMonotone);
  const { teamScore } = deps;
  const score = teamScore === undefined ? undefined : (team: MonRef[]): number => teamScore([...team], infos);
  const byRef = new Map(eligible.map((m) => [m.ref, m]));
  const preferred = (search.preferred ?? []).filter((ref) => byRef.has(ref));   // a preferred mon at 0 HP is left out
  const candidates = teamCandidates(eligible.map((m) => m.ref), size, monotone, score, cfg.maxTeamCandidates, { mustBring, preferred });
  const solveFor = <T>(team: MonRef[], f: (fights: ArenaFight[], r: SolveRequest) => T): T => {
    const r = teamRequest(req, team);
    return f(teamFights(r, infos, team.map((ref) => byRef.get(ref)!)), r);
  };
  const { checkerDeadline, signal } = ctl;
  const full: TeamRunners['full'] = (team, deadline, progress, known) => solveFor(team, (fights, r) => solveFights(deps, cfg, fights, r, {
    deadline, checkerDeadline, signal, progress, ...(known === null ? {} : { knownFailure: known }),
  }));
  const local: TeamRunners = {
    tier1: (team, deadline, progress) => solveFor(team, (fights, r) => solveFights(deps, cfg, fights, r, { deadline, checkerDeadline, signal, progress, mode: 'tier1' })),
    full,
    risk: full,
    shown: (team, baseline, progress) => solveFor(team, (fights, r) => solveWithPreStatus(deps, cfg, fights, r, { ...ctl, progress }, baseline)),
  };
  const result: TeamSearchResult = await searchTeams({
    candidates, total: candidates.count, monotone, labels: new Map(eligible.map((m) => [m.ref, m.label])), ranking: req.ranking, now: o.now,
    start: o.start, deadline: ctl.deadline, signal, progress: ctl.progress, proposePreStatus: req.preStatus === 'propose',
    runners: par === null ? local : poolRunners(par, full, ctl, solveFor), window: par === null ? 1 : par.width,
  });
  const note = teamSearchNote({
    result, total: candidates.count, maxSize: size, eligible: eligible.length, fainted: fainted.length, monotone,
    mustBring: must.map((m) => m.label), preferred: preferred.map((ref) => byRef.get(ref)!.label),
  });
  if (result.run !== null) {
    let v = result.run.verdict;
    if (result.mismatch !== null) v = mismatched(v, result.mismatch);
    // A store difference in any team's run (config checkerCompare), shown or not, wins.
    if (result.storeDiffers !== null && !(v.tier === 'unproven' && v.reason === 'unsupportedBattle')) v = mismatched(v, result.storeDiffers);
    return withTeamReport(v, result.rejected, note);
  }
  const why: Why = result.refused
    ?? (result.storeDiffers !== null ? { reason: 'verificationMismatch', detail: result.storeDiffers } : null)
    ?? (result.mismatch !== null ? { reason: 'verificationMismatch', detail: result.mismatch } : null)
    ?? { reason: 'timeout', detail: signal?.aborted === true ? 'cancelled' : 'not proven within the time limit' };
  return withTeamReport(o.refuse(why), result.rejected, note);
}

// ---- Parallel: the root split, the re-check and the team search on the pool (see the top of the file) ----

/** This thread's deps, config and clock: what the re-check and the split's verdict need (no pool). */
export interface ThisThread { deps: SolverDeps; cfg: SolverConfig; now: () => number }

/** What the parallel paths share: this solve's jobs' runner (its lane), its width (the most jobs at once), deps, config and clock. */
interface Parallel extends ThisThread { pool: JobRunner; width: number }

/** One lead's run in a root split, the search nodes its job visited, and the lead's label (the team member's). */
export interface LeadRun { run: FightRun; nodes: number; label: string }

/** Unproven reasons, the most severe first (the order of the unproven list at the top of the file). */
const SEVERITY: readonly UnprovenReason[] = [
  'unsupportedBattle', 'noEligibleTeam', 'timeout', 'verificationMismatch', 'unmodelled', 'engineLimit', 'horizon', 'needsHiddenInformation',
];

/** A verdict's place in SEVERITY; a claim comes after every reason. */
function severity(reason: UnprovenReason | null): number {
  return reason === null ? SEVERITY.length : SEVERITY.indexOf(reason);
}

/** Whether `v` is unproven because a check's store and bare runs differed (config checkerCompare, checkerDeps.ts). */
function storeDiffered(v: Verdict): boolean {
  return v.tier === 'unproven' && v.reason === 'verificationMismatch' && v.detail.startsWith(STORE_DIFFERS);
}

/** FightRun.storeDiffers for a run whose verdict is `v`: the detail when `v` is unproven for a store difference. */
function differsOf(v: Verdict): { storeDiffers?: string } {
  return v.tier === 'unproven' && storeDiffered(v) ? { storeDiffers: v.detail } : {};
}

/**
 * `run` with its verdict made unproven for the store difference `detail` (its would-be verdict kept as `best`) and
 * `detail` as its storeDiffers, unless the verdict is an engine refusal, which stays (FightRun.storeDiffers).
 */
function withStoreDiffers(run: FightRun, detail: string): FightRun {
  const v = run.verdict;
  if (v.tier === 'unproven' && v.reason === 'unsupportedBattle') return run;
  return { ...run, verdict: mismatched(v, detail), storeDiffers: detail };
}

/** The would-be verdict: a claim itself, or an unproven verdict's `best`. */
function wouldBe(v: Verdict): Claim | null {
  if (v.tier !== 'unproven') return v;
  return v.best !== undefined && v.best.tier !== 'unproven' ? v.best : null;
}

/** The report lines a refinement cut short adds to a claim: rankingStopped and tier2Stopped. */
const STOPPED_EARLY = /^(ranking|tier-2 search) stopped early \(/;

/**
 * `v` (and its `best`) without the stopped-early lines: they say the line is checked, which only a claim may say, so a
 * verdict made unproven later (by a split, a re-check or the pre-status steps) drops them.
 */
function withoutStoppedEarly(v: Verdict): Verdict {
  const report = { ...v.report, assumptions: v.report.assumptions.filter((a) => !STOPPED_EARLY.test(a)) };
  if (v.tier !== 'unproven') return { ...v, report };
  return { ...v, report, ...(v.best === undefined ? {} : { best: withoutStoppedEarly(v.best) }) };
}

/**
 * `v` made unproven for `why`, its would-be verdict kept as `best`, unless its own reason is at least as severe (an
 * unmodelled reason takes the new detail: the root's entries for every lead). Made unproven, it loses the
 * stopped-early lines (withoutStoppedEarly).
 */
function overridden(v: Verdict, why: Why | null): Verdict {
  if (why === null) return v;
  const own = v.tier === 'unproven' ? v.reason : null;
  if (severity(why.reason) >= severity(own) && !(own === 'unmodelled' && why.reason === 'unmodelled')) return v;
  const claim = wouldBe(v);
  return withoutStoppedEarly({ tier: 'unproven', reason: why.reason, detail: why.detail, ...(claim === null ? {} : { best: claim }), report: v.report });
}

/**
 * `v` made unproven verificationMismatch for a worker line that failed this thread's re-check (`detail` names the lead
 * or team and the disagreement), the verdict it would otherwise be kept as `best` (its claim, or its own `best`),
 * without the stopped-early lines.
 */
function mismatched(v: Verdict, detail: string): Verdict {
  const claim = wouldBe(v);
  return withoutStoppedEarly({ tier: 'unproven', reason: 'verificationMismatch', detail, ...(claim === null ? {} : { best: claim }), report: v.report });
}

function timeoutWhy(signal: AbortSignal | undefined): Why {
  return { reason: 'timeout', detail: signal?.aborted === true ? 'cancelled' : 'not proven within the time limit' };
}

/** `v` with a tier-3 line (itself or its `best`) marked 'bestFoundWithinBudget'; anything else as it is. */
function bestFoundOnly(v: Verdict): Verdict {
  if (v.tier === 3) return { ...v, optimality: 'bestFoundWithinBudget' };
  return v.tier === 'unproven' && v.best !== undefined ? { ...v, best: bestFoundOnly(v.best) } : v;
}

/** `v` (and its `best`) with `patch` over its report. */
function withReport(v: Verdict, patch: Partial<ProofReport>): Verdict {
  const report = { ...v.report, ...patch };
  if (v.tier !== 'unproven') return { ...v, report };
  return { ...v, report, ...(v.best === undefined ? {} : { best: withReport(v.best, patch) }) };
}

/** SearchStats' number fields: every one is summed by mergedStats. */
type StatCounter = { [K in keyof SearchStats]: SearchStats[K] extends number ? K : never }[keyof SearchStats];
const STAT_COUNTERS = ['nodes', 'expansions', 'leaves', 'edgeHits', 'supports'] as const satisfies readonly StatCounter[];
// Compile-time guards: a counter added to SearchStats and not listed above, or a field that is neither a counter nor
// chanceKinds, fails the typecheck here.
const EVERY_COUNTER_SUMMED: [Exclude<StatCounter, (typeof STAT_COUNTERS)[number]>] extends [never] ? true : never = true;
const NOTHING_ELSE: [Exclude<keyof SearchStats, StatCounter | 'chanceKinds'>] extends [never] ? true : never = true;
void EVERY_COUNTER_SUMMED;
void NOTHING_ELSE;

/** Several searches' counts as one: every counter summed, the chance kinds met as a union. */
function mergedStats(all: readonly SearchStats[]): SearchStats {
  const merged = emptyStats();
  for (const s of all) {
    for (const key of STAT_COUNTERS) merged[key] += s[key];
    for (const kind of s.chanceKinds) merged.chanceKinds.add(kind);
  }
  return merged;
}

/**
 * A split's report counts, over every lead's search: nodes and turn executions summed, and the enumerated list rebuilt
 * from the merged counts (chance kinds met in any lead, supports summed) followed by the chosen lead's own extra lines
 * (the badge's, the probe's). Without every lead's stats: the job node counts only.
 */
function splitCounts(chosen: LeadRun, runs: readonly LeadRun[], fights: readonly ArenaFight[]): { patch: Partial<ProofReport>; stats?: SearchStats } {
  const all = runs.flatMap((r) => (r.run.stats === undefined ? [] : [r.run.stats]));
  const own = chosen.run.stats;
  if (own === undefined || all.length < runs.length) return { patch: { nodes: runs.reduce((n, r) => n + r.nodes, 0) } };
  const stats = mergedStats(all);
  const worlds = Math.max(...fights.map((f) => f.info.worlds.length));
  const extra = chosen.run.verdict.report.enumerated.slice(enumeratedOf(own, worlds).length);
  return { patch: { nodes: stats.nodes, turnExecutions: stats.leaves, enumerated: [...enumeratedOf(stats, worlds), ...extra] }, stats };
}

/** A run cancelled before it finished: unproven timeout 'cancelled', nothing searched here. */
function cancelledRun(par: Parallel, req: SolveRequest, fights: ArenaFight[], started: number): FightRun {
  const worlds = Math.max(...fights.map((f) => f.info.worlds.length));
  const verdict = refused(par.deps, par.cfg, req, worlds, Math.max(0, par.now() - started), { reason: 'timeout', detail: 'cancelled' });
  return { verdict, certificate: null, vector: null, failure: null, refutation: null, complete: false };
}

/** Either signal, or both as one. */
function either(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (a === undefined) return b;
  return b === undefined ? a : AbortSignal.any([a, b]);
}

/** `job` on the pool, its nodes counted and its messages forwarded to `progress` (prefixed). */
async function runOnPool(pool: JobRunner, job: Job, progress: ProgressSink, signal: AbortSignal | undefined, prefix = ''): Promise<JobResult> {
  let forwarded = 0;
  const onProgress: JobProgress = (nodes, text) => {
    forwarded += nodes;
    for (let k = 0; k < nodes; k++) progress.node();
    progress.message(`${prefix}${text}`);
  };
  const result = await pool.run(job, signal, onProgress);
  for (let k = forwarded; k < result.nodes; k++) progress.node();
  return result;
}

/**
 * This thread's re-check of a worker's line: `stopped` when a check was cut short, the worker's or this one (a timeout:
 * nothing is compared), the disagreement (null: none; counts that differ are one), the level-1 check's unmodelled list, and this thread's (merged) result when the
 * re-check finished (a disagreement's verdict shows it as the verification). `workerCut`: the worker's own check was
 * the one cut short (or not sent), so this thread did not re-check (`stopped` is true too). `storeDiffers`: config
 * checkerCompare's first store-and-bare difference in this thread's own re-check (its store answered wrongly), null
 * when none: it is never silent and wins over a disagreement.
 */
interface Recheck {
  stopped: boolean; workerCut: boolean; disagreement: string | null; unmodelled: string[]; result: CheckResult | null; storeDiffers: string | null;
}

const DISAGREES = "this thread's re-check of the worker's line disagrees: ";

/** The line a worker's line kept as `best` carries when the worker's check finished and this thread's re-check was cut short. */
const WORKER_ONLY = "this line was checked by a worker thread only; this thread's re-check did not finish";

/** The line a worker's line kept as `best` carries when the worker's own check was cut short. */
const WORKER_CUT = "the worker's check of this line did not finish; this thread did not re-check it";

/** A re-check's own allowance: at least RECHECK_MIN_MS, else RECHECK_FACTOR × the worker's own check time. */
const RECHECK_MIN_MS = 2_000;
const RECHECK_FACTOR = 2;

/** 'a' and 'b' as sets: null when equal, else what differs (sizes, and the first entry not in both). */
function setDifference(what: string, mine: readonly string[], theirs: readonly string[]): string | null {
  const a = new Set(mine);
  const b = new Set(theirs);
  const only = [...a].find((x) => !b.has(x)) ?? [...b].find((x) => !a.has(x));
  return only === undefined ? null : `${what} differ (this thread ${a.size}, the worker ${b.size}; first not in both: ${only})`;
}

function endText(e: CheckResult['worstEnd']): string {
  return e === null ? 'none' : `${toJson(e.minHpFrac)} HP, ${e.totalHp} total, ${e.pp} PP`;
}

/** A check's hits not cross-checked as the page writes them: 'Counter ×2, Stomp ×1', or 'none'. */
function notCrossCheckedText(counts: Readonly<Record<string, number>>): string {
  const list = notCrossCheckedList(counts);
  return list.length === 0 ? 'none' : list.map((n) => `${n.move} ×${n.hits}`).join(', ');
}

/**
 * What makes two checks of one line disagree: passed, the reason, the set of mismatch
 * texts, the set of unmodelled entries, a figure the claim stands on (tier 1: the worst end; tier 2: the death odds
 * under the AI and in the worst case, and the crit budget; tier 3: both death odds), or a count (damage checks, order
 * checks, states visited, the hits not cross-checked per move). Counts are deterministic since the engine's state lost
 * its wall-clock text, so a difference in them means the worker's set-up differs from this thread's. Only called for two finished checks.
 */
function disagreements(mine: CheckResult, theirs: CheckResult, claim: Claim | null): string[] {
  const out: string[] = [];
  if (mine.passed !== theirs.passed) out.push(`passed ${mine.passed}, the worker's ${theirs.passed}`);
  if (mine.reason !== theirs.reason) out.push(`reason ${mine.reason ?? 'none'}, the worker's ${theirs.reason ?? 'none'}`);
  for (const d of [setDifference('mismatches', mine.mismatches, theirs.mismatches), setDifference('unmodelled entries', mine.unmodelled, theirs.unmodelled)]) {
    if (d !== null) out.push(d);
  }
  if (claim?.tier === 1) {
    const [a, b] = [mine.worstEnd, theirs.worstEnd];
    const same = a === null || b === null ? a === b : eq(a.minHpFrac, b.minHpFrac) && a.totalHp === b.totalHp && a.pp === b.pp;
    if (!same) out.push(`worst end ${endText(a)}, the worker's ${endText(b)}`);
  } else if (claim !== null) {
    if (!eq(mine.failureAi, theirs.failureAi)) out.push(`death ${toJson(mine.failureAi)}, the worker's ${toJson(theirs.failureAi)}`);
    if (!eq(mine.failureWorst, theirs.failureWorst)) out.push(`worst-case death ${toJson(mine.failureWorst)}, the worker's ${toJson(theirs.failureWorst)}`);
    if (claim.tier === 2 && mine.critBudget !== theirs.critBudget) out.push(`crit budget ${mine.critBudget}, the worker's ${theirs.critBudget}`);
  }
  if (mine.damageChecks !== theirs.damageChecks) out.push(`damage checks ${mine.damageChecks} here, the worker's ${theirs.damageChecks}`);
  if (mine.orderChecks !== theirs.orderChecks) out.push(`order checks ${mine.orderChecks} here, the worker's ${theirs.orderChecks}`);
  if (mine.statesVisited !== theirs.statesVisited) out.push(`states ${mine.statesVisited} here, the worker's ${theirs.statesVisited}`);
  const [here, there] = [notCrossCheckedText(mine.notCrossChecked), notCrossCheckedText(theirs.notCrossChecked)];
  if (here !== there) out.push(`hits not cross-checked ${here} here, the worker's ${there}`);
  return out;
}

/**
 * This thread's check of a worker's line (see the top of the file): the certificate at its own level and, for a proven
 * badge, at the other level, merged as FightSolve merges them, then compared with the worker's own check (disagreements).
 * Its deadline is its own: max(the checker's deadline, now + max(RECHECK_MIN_MS, RECHECK_FACTOR × the worker's check
 * time)), so a line whose worker check ended near the checker's deadline is still re-checked. `unmodelled`: the
 * level-1 check's list.
 */
function recheck(par: ThisThread, fights: ArenaFight[], run: FightRun, ctl: FightControl): Recheck {
  const cert = run.certificate;
  if (cert === null) return { stopped: false, workerCut: false, disagreement: null, unmodelled: [], result: null, storeDiffers: null };
  // The worker's own check cut short (or not sent): there is nothing to compare with, so the line is unproven timeout.
  if (run.check?.finished !== true) return { stopped: true, workerCut: true, disagreement: null, unmodelled: [], result: null, storeDiffers: null };
  const allowance = Math.max(RECHECK_MIN_MS, RECHECK_FACTOR * run.check.elapsedMs);
  let storeDiffers: string | null = null;
  const env: CheckEnv = {
    deps: par.deps, cfg: par.cfg, fights, labeler: par.deps.labeler ?? defaultLabeler, checkerDeadline: Math.max(ctl.checkerDeadline, par.now() + allowance),
    signal: ctl.signal,
    onDiffer: (detail) => {
      storeDiffers ??= detail;
    },
  };
  const claim = wouldBe(run.verdict);
  let primary = checkLine(env, cert);
  let merged = primary;
  if (claim?.tier === 1 && claim.anyLegalBadge === 'proven') {
    if (cert.level === 2) {
      primary = checkLine(env, { ...cert, level: 1 });
      merged = mergeChecks(primary, merged);
    } else {
      merged = mergeChecks(primary, checkLine(env, { ...cert, level: 2, thresholds: null }));
    }
  }
  const c = primary.result;
  if (merged.stopped) return { stopped: true, workerCut: false, disagreement: null, unmodelled: c.unmodelled, result: null, storeDiffers };
  const m = merged.result;
  const theirs = run.check.result;
  const differ = disagreements(m, theirs, claim);
  if (differ.length === 0) return { stopped: false, workerCut: false, disagreement: null, unmodelled: c.unmodelled, result: m, storeDiffers };
  const walks = `this thread ${m.damageChecks}/${m.orderChecks} checks, ${m.statesVisited} states; the worker ${theirs.damageChecks}/${theirs.orderChecks}, ${theirs.statesVisited}`;
  return { stopped: false, workerCut: false, disagreement: `${DISAGREES}${differ.join('; ')} (${walks})`, unmodelled: c.unmodelled, result: m, storeDiffers };
}

/** The line a disputed `best` carries: it keeps the worker's report, whose verification passed. */
const DISPUTED = "this thread's re-check of this line disagrees with the worker's check (see the verdict detail)";

/**
 * The verdict for a worker's line this thread's re-check disagrees with: unproven verificationMismatch with
 * `detail`, the line's would-be verdict as `best`, and the line's report with this thread's re-check as the
 * verification (`mine`). The `best` keeps the worker's report and says it is disputed (DISPUTED), so it never reads as
 * verified.
 */
function disagreed(v: Verdict, detail: string, mine: CheckResult | null): Verdict {
  const verification = mine === null ? v.report.verification : verificationOf(mine);
  const claim = wouldBe(v);
  return withoutStoppedEarly({
    tier: 'unproven', reason: 'verificationMismatch', detail, ...(claim === null ? {} : { best: withAssumption(claim, DISPUTED) }),
    report: { ...v.report, verification },
  });
}

/** `v` with `line` added at the end of its assumptions, and of its `best`'s. */
function withAssumption(v: Verdict, line: string): Verdict {
  const report = { ...v.report, assumptions: [...v.report.assumptions, line] };
  if (v.tier !== 'unproven') return { ...v, report };
  return { ...v, report, ...(v.best === undefined ? {} : { best: withAssumption(v.best, line) }) };
}

/** Why a re-checked worker line cannot stand: a check cut short (timeout) or a disagreement (verificationMismatch). */
function recheckWhy(re: Recheck, signal: AbortSignal | undefined): Why | null {
  if (re.stopped) return timeoutWhy(signal);
  return re.disagreement === null ? null : { reason: 'verificationMismatch', detail: re.disagreement };
}

/**
 * A worker's verdict after this thread's re-check `re`: made unproven (its would-be verdict as `best`) when a check was
 * cut short or the re-check disagrees. Cut short, its `best` says how far it was checked: by neither thread when the
 * worker's own check was cut short (WORKER_CUT), else by the worker only (WORKER_ONLY).
 */
function recheckedVerdict(v: Verdict, re: Recheck, signal: AbortSignal | undefined): Verdict {
  const checked = overridden(v, recheckWhy(re, signal));
  if (!re.stopped || checked.tier !== 'unproven' || checked.best === undefined) return checked;
  return { ...checked, best: withAssumption(checked.best, re.workerCut ? WORKER_CUT : WORKER_ONLY) };
}

/**
 * A worker's run after this thread's re-check: unproven (its would-be verdict as `best`) when a check was cut short or
 * the re-check disagrees; a disagreement is also kept as `recheckMismatch`. A store difference in the re-check (config
 * checkerCompare) is the verdict's reason over both, and is kept as `storeDiffers`.
 */
function recheckedRun(par: ThisThread, fights: ArenaFight[], run: FightRun, ctl: FightControl): FightRun {
  if (wouldBe(run.verdict) === null) return run;   // no line to show, so none to re-check
  const re = recheck(par, fights, run, ctl);
  let out = run;
  if (re.disagreement !== null) out = { ...run, verdict: disagreed(run.verdict, re.disagreement, re.result), recheckMismatch: re.disagreement };
  else if (recheckWhy(re, ctl.signal) !== null) out = { ...run, verdict: recheckedVerdict(run.verdict, re, ctl.signal), complete: run.complete && !re.stopped };
  return re.storeDiffers === null ? out : withStoreDiffers(out, re.storeDiffers);
}

/**
 * A lead run and this thread's re-check of its line (null: not re-checked, see combineLeads): its verdict (made unproven
 * when a check was cut short or the re-check disagrees), and its would-be verdict for the comparison, null when the
 * re-check failed (a line that failed its re-check is never compared).
 */
interface CheckedLead { lead: LeadRun; re: Recheck | null; verdict: Verdict; claim: Claim | null }

/** True when `a`'s tier-1 line beats `b`'s (see the top of the file). */
function tier1Better(a: CheckedLead, b: CheckedLead, ranking: readonly RankKey[]): boolean {
  const badge = (x: CheckedLead): number => (x.claim?.tier === 1 && x.claim.anyLegalBadge === 'proven' ? 0 : 1);
  if (badge(a) !== badge(b)) return badge(a) < badge(b);
  const level = (x: CheckedLead): number => x.lead.run.certificate?.level ?? 1;
  if (level(a) !== level(b)) return level(a) < level(b);
  const [va, vb] = [a.lead.run.vector, b.lead.run.vector];
  return va !== null && vb !== null && compareRank(va, vb, ranking) < 0;
}

/** The lead run a split shows (see the top of the file); a tie keeps the lower lead index. */
function chooseLead(leads: CheckedLead[], ranking: readonly RankKey[]): CheckedLead {
  const tier1 = leads.filter((x) => x.claim?.tier === 1);
  if (tier1.length > 0) return tier1.reduce((best, x) => (tier1Better(x, best, ranking) ? x : best));
  const risky = leads.filter((x) => x.claim !== null);
  const asRun = (x: CheckedLead): FightRun => ({ ...x.lead.run, verdict: x.claim! });
  if (risky.length > 0) return risky.reduce((best, x) => (betterRun(asRun(x), asRun(best), ranking) ? x : best));
  const reason = (x: CheckedLead): UnprovenReason | null => (x.verdict.tier === 'unproven' ? x.verdict.reason : null);
  return leads.reduce((best, x) => (severity(reason(x)) < severity(reason(best)) ? x : best));
}

/** The split's verdict from its lead runs, in lead order (see the top of the file); exported for its tests. */
export function combineLeads(par: ThisThread, at: { arena: Arena; root: Belief; fights: ArenaFight[]; req: SolveRequest; ctl: FightControl; started: number },
  runs: LeadRun[]): FightRun {
  const { fights, req, ctl } = at;
  const ranking = req.ranking.length === 0 ? DEFAULT_RANKING : req.ranking;
  const reasonOf = (v: Verdict): UnprovenReason | null => (v.tier === 'unproven' ? v.reason : null);
  const refusal = runs.find((r) => reasonOf(r.run.verdict) === 'unsupportedBattle');
  let chosen: LeadRun;
  let verdict: Verdict;
  let recheckMismatch: string | undefined;
  let complete = runs.every((r) => r.run.complete);
  if (refusal !== undefined) {
    chosen = refusal;
    verdict = refusal.run.verdict;
  } else {
    // Only the lines that can be shown are re-checked, in preference order: the would-be lines, best first by
    // chooseLead's comparison, until one passes (finishes and agrees): that is the chosen line, and every line ranked
    // above it has failed its re-check, so no line is compared unless this thread has checked it. A lead whose re-check
    // fails is never chosen over one whose re-check passed. A disagreement also ends the re-checks: the verdict is then
    // that line's mismatch (below), whatever the others' lines are. So does a re-check of this thread's cut short past
    // the checker's deadline: the lines left count as not re-checked, and the verdict follows the
    // timeout rule. A re-check that finishes ends them anyway (it passes or disagrees), and one cut short has passed the
    // checker's deadline (its own deadline is never earlier), so at most one re-check runs out its allowance.
    const leads: CheckedLead[] = runs.map((lead) => ({ lead, re: null, verdict: lead.run.verdict, claim: wouldBe(lead.run.verdict) }));
    const rechecked: CheckedLead[] = [];
    let passed: CheckedLead | null = null;
    let disagreeing: CheckedLead | null = null;
    let outOfTime = false;
    let pending = leads.filter((x) => x.claim !== null && x.lead.run.certificate !== null);
    while (pending.length > 0 && passed === null && disagreeing === null && !outOfTime) {
      const next = chooseLead(pending, ranking);
      const re = recheck(par, fights, next.lead.run, ctl);
      next.re = re;
      next.verdict = recheckedVerdict(next.lead.run.verdict, re, ctl.signal);
      // A store difference in this thread's re-check (config checkerCompare) fails the line like a disagreement; the
      // store-difference rule below then shows it.
      if (re.storeDiffers !== null) next.verdict = mismatched(next.verdict, re.storeDiffers);
      next.claim = recheckWhy(re, ctl.signal) === null && re.storeDiffers === null ? wouldBe(next.verdict) : null;
      rechecked.push(next);
      if (next.claim !== null) passed = next;
      else if (re.disagreement !== null || re.storeDiffers !== null) disagreeing = next;
      else if (re.stopped && !re.workerCut && par.now() > ctl.checkerDeadline) outOfTime = true;
      pending = pending.filter((x) => x !== next);
    }
    if (outOfTime && pending.length > 0) complete = false;
    if (leads.some((x) => x.re?.stopped === true)) complete = false;
    // The lead shown: the chosen line's; with no line passing, the best line any lead has (the first re-checked,
    // as they were taken best first), never a lead with no line while another has one; with no line at all, the most
    // severe unproven reason.
    const pick = passed ?? rechecked[0] ?? chooseLead(leads, ranking);
    chosen = pick.lead;
    // The candidate reasons, the most severe kept (the first on a tie).
    let why: Why | null = null;
    const consider = (w: Why): void => {
      if (why === null || severity(w.reason) < severity(why.reason)) why = w;
    };
    // A lead out of time (search or re-check) does not override another lead's verified tier-1 line: only a
    // better rank may be missed, which the report says. With no verified tier-1 line the split did not finish: timeout.
    const unfinished = leads.filter((x) => reasonOf(x.verdict) === 'timeout');
    let note: string | null = null;
    if (unfinished.length > 0 && pick.verdict.tier === 1) note = rankingStopped(`unfinished leads: ${unfinished.map((x) => x.lead.label).join(', ')}`);
    const late = unfinished[0]?.verdict;
    if (note === null && late?.tier === 'unproven') consider({ reason: 'timeout', detail: late.detail });
    // No tier-1 line: tier 1 is refuted for the fights only when every lead's own failure is (in-process, the root's OR).
    // A lead whose failure is not refuted is unproven for that reason (its own whyNot), so the split is too.
    const open = pick.claim?.tier === 1 ? undefined : leads.find((x) => x.lead.run.refuted === false);
    if (open?.verdict.tier === 'unproven') consider({ reason: open.verdict.reason, detail: `lead ${open.lead.label}: ${open.verdict.detail}` });
    try {
      const all = rootUnmodelled(par.deps, par.cfg, at.arena, at.root, undefined);
      if (all.length > 0) consider({ reason: 'unmodelled', detail: `unmodelled: ${[...new Set([...all, ...(pick.re?.unmodelled ?? [])])].join('; ')}` });
    } catch (e) {
      if (codeOf(e) !== 'UNSUPPORTED_DOUBLE') throw e;
      consider({ reason: 'unsupportedBattle', detail: `the engine refuses the battle: ${messageOf(e)}` });
    }
    verdict = overridden(pick.verdict, why);
    // Each lead's least failure is its own: the split's tier-3 line is proven least only when every lead's is.
    if (!leads.every((x) => x.claim?.tier === 3 && x.claim.optimality === 'proven')) verdict = bestFoundOnly(verdict);
    // A worker line that fails this thread's re-check is never silent: the worker's deps differ from this thread's, a
    // configuration bug that loses lines. The verdict is that lead's: unproven verificationMismatch naming it,
    // its line as `best`, this thread's re-check as the verification, and how many other leads ran out of time; on the
    // run too (the pre-status steps and the team search read it there). Only an engine refusal stays.
    if (disagreeing?.re?.disagreement != null && reasonOf(verdict) !== 'unsupportedBattle') {
      const timedOut = leads.filter((x) => x !== disagreeing && reasonOf(x.verdict) === 'timeout').length;
      recheckMismatch = `lead ${disagreeing.lead.label}: ${disagreeing.re.disagreement}${timedOut > 0 ? `; ${timedOut} of ${leads.length} leads ran out of time` : ''}`;
      chosen = disagreeing.lead;
      verdict = disagreed(disagreeing.lead.run.verdict, recheckMismatch, disagreeing.re.result);
      if (!leads.every((x) => x.claim?.tier === 3 && x.claim.optimality === 'proven')) verdict = bestFoundOnly(verdict);
    }
    // A lead whose store and bare checks differed (config checkerCompare) is never hidden behind another lead's line:
    // a store answered wrongly. Only an engine refusal stays.
    const differs = leads.find((x) => storeDiffered(x.verdict));
    if (differs !== undefined && !storeDiffered(verdict) && reasonOf(verdict) !== 'unsupportedBattle') {
      chosen = differs.lead;
      verdict = mismatched(differs.verdict, `${(differs.verdict as Unproven).detail} (lead ${differs.lead.label})`);
      if (!leads.every((x) => x.claim?.tier === 3 && x.claim.optimality === 'proven')) verdict = bestFoundOnly(verdict);
    }
    // Only a tier-1 verdict says its ranking stopped early: never one made unproven above.
    if (note !== null && verdict.tier === 1) verdict = withReport(verdict, { assumptions: [...verdict.report.assumptions, note] });
  }
  const { patch, stats } = splitCounts(chosen, runs, fights);
  verdict = withReport(verdict, { ...patch, elapsedMs: Math.max(0, par.now() - at.started) });
  const outcome = verdict.tier === 'unproven' ? `unproven (${verdict.reason})` : `tier ${verdict.tier}`;
  ctl.progress.message(`${outcome}, ${grouped(verdict.report.nodes)} nodes`, wouldBe(verdict)?.tier ?? null);
  const anyTier1 = runs.some((r) => wouldBe(r.run.verdict)?.tier === 1);
  // Refuted only when every lead's failure is; not when any lead's is not; else unknown (absent).
  const refuted = anyTier1 ? undefined : runs.some((r) => r.run.refuted === false) ? false : runs.every((r) => r.run.refuted === true) ? true : undefined;
  return {
    verdict, certificate: chosen.run.certificate, vector: chosen.run.vector, failure: chosen.run.failure, complete,
    refutation: anyTier1 ? null : runs.find((r) => r.run.refutation !== null)?.run.refutation ?? null, ...(refuted === undefined ? {} : { refuted }),
    ...(recheckMismatch === undefined ? {} : { recheckMismatch }), ...(stats === undefined ? {} : { stats }),
    ...(chosen.run.check === undefined ? {} : { check: chosen.run.check }), ...differsOf(verdict),
  };
}

/**
 * solveFights over the pool, split by lead (see the top of the file). With no lead to split, solveFights runs here (it
 * says why nothing can lead).
 */
async function splitFights(par: Parallel, fights: ArenaFight[], req: SolveRequest, ctl: FightControl): Promise<FightRun> {
  const { deps, cfg } = par;
  const started = par.now();
  const arena = new Arena({
    engine: deps.engine, enemyModel: deps.enemyModel, fights, edgeCacheEntries: cfg.edgeCacheEntries, maxLeaves: cfg.maxLeaves, stats: emptyStats(),
  });
  const root = rootBelief(arena);
  const leads = beliefChoices(arena, root);
  if (leads.length === 0) return solveFights(deps, cfg, fights, req, ctl);
  const team = fights[0]!.team;
  const stop = new AbortController();   // the first lead that fails stops the others
  const signal = either(ctl.signal, stop.signal);
  const labels = leads.map((lead) => (lead.kind === 'switch' ? team[lead.index]?.label : undefined) ?? choiceText(lead));
  const jobs = leads.map((lead, i) => {
    const label = labels[i]!;
    const job: Job = {
      kind: 'root', req, team: team.map((m) => m.ref), restrictRoot: [lead], deadline: ctl.deadline, checkerDeadline: ctl.checkerDeadline, config: cfg,
    };
    const run = runOnPool(par.pool, job, ctl.progress, signal, `lead ${label}: `);
    run.catch(() => undefined);   // the others' rejections once one has failed
    return run;
  });
  ctl.progress.message(`root split: ${leads.length} lead${leads.length === 1 ? '' : 's'} in worker threads`, null);
  let results: JobResult[];
  try {
    results = await Promise.all(jobs);
  } catch (e) {
    stop.abort();
    if (ctl.signal?.aborted === true || isAbortError(e)) return cancelledRun(par, req, fights, started);
    throw e;
  }
  const runs = results.map((result, i) => ({ run: fromJobResult(result), nodes: result.nodes, label: labels[i]! }));
  return combineLeads(par, { arena, root, fights, req, ctl, started }, runs);
}

/** The team search's runners on the pool (see the top of the file); `full` is the in-process full solve. */
function poolRunners(par: Parallel, full: TeamRunners['full'], ctl: FightControl,
  candidate: <T>(team: MonRef[], f: (fights: ArenaFight[], r: SolveRequest) => T) => T): TeamRunners {
  const job =(team: MonRef[], r: SolveRequest, phase: 'tier1' | 'risk', deadline: number, known: KnownFailure | null): Job => ({
    kind: 'team', req: r, team: [...team], phase, deadline, checkerDeadline: ctl.checkerDeadline, config: par.cfg, known,
  });
  return {
    tier1: (team, deadline, progress, stop) => candidate(team, async (_fights, r): Promise<Tier1Run> => {
      try {
        const { tier1 } = await runOnPool(par.pool, job(team, r, 'tier1', deadline, null), progress, either(ctl.signal, stop));
        if (tier1 === null) throw new Error('solve: a tier-1 job answered without a tier-1 run');
        return tier1;
      } catch (e) {
        if (isAbortError(e)) return { kind: 'unproven', reason: 'timeout', detail: 'cancelled' };
        throw e;
      }
    }),
    full,
    risk: (team, deadline, progress, known, stop) => candidate(team, async (fights, r): Promise<FightRun> => {
      const started = par.now();
      let run: FightRun;
      try {
        run = fromJobResult(await runOnPool(par.pool, job(team, r, 'risk', deadline, known), progress, either(ctl.signal, stop)));
      } catch (e) {
        if (isAbortError(e)) return cancelledRun(par, r, fights, started);
        throw e;
      }
      // Re-checked here, before searchTeams compares it: a line that fails is that team's unproven run, never better
      // than a claim (betterRun).
      return recheckedRun(par, fights, run, ctl);
    }),
    shown: (team, baseline, progress) => candidate(team, (fights, r) => (
      solveWithPreStatusAsync(par.deps, fights, r, { ...ctl, progress }, baseline, (c) => splitFights(par, c.fights, c.req, c.ctl))
    )),
  };
}

/**
 * The solve's jobs' runner and its own cancel signal, which follows the caller's (one listener there, removed at close;
 * any number on ours): a lane of deps.pool, or a pool of its own (see the top of the file); null to run in-process.
 */
function openParallel(deps: SolverDeps, cfg: SolverConfig, now: () => number, signal: AbortSignal | undefined):
  (Parallel & { signal: AbortSignal; close(): Promise<void> }) | null {
  if (cfg.threads <= 1) return null;
  const context = deps.workerContext === undefined ? {} : { context: deps.workerContext };
  let lane: PoolLane;
  let width: number;
  let finish: () => Promise<void>;
  if (deps.pool !== undefined) {
    width = Math.min(cfg.threads, deps.pool.size);
    lane = deps.pool.lane({ limit: width, now, ...context });
    finish = async () => lane.close();
  } else if (cfg.depsModule !== null) {
    const pool = new WorkerPool({ threads: cfg.threads, depsModule: cfg.depsModule, execArgv: cfg.workerExecArgv, now });
    width = cfg.threads;
    lane = pool.lane(context);
    finish = () => pool.close();
  } else {
    return null;
  }
  const cancel = new AbortController();
  setMaxListeners(0, cancel.signal);
  const follow = (): void => cancel.abort();
  if (signal?.aborted === true) cancel.abort();
  else signal?.addEventListener('abort', follow, { once: true });
  return {
    pool: lane, width, deps, cfg, now, signal: cancel.signal,
    async close() {
      signal?.removeEventListener('abort', follow);
      await finish();
    },
  };
}

export function createSolver(deps: SolverDeps): Solver {
  return {
    async solve(req: SolveRequest, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<Verdict> {
      const cfg = resolveConfig(deps.config);
      const now = deps.now ?? defaultNow;
      const start = now();
      const progress = progressSink(onProgress, now, start, cfg.progressIntervalMs);
      const par = openParallel(deps, cfg, now, signal);
      try {
        if (req.fights.length === 0) throw new RangeError('solve: the request has no fights');
        if (req.team.kind === 'fixed') progress.teams(0, 1);
        const party = req.team.kind === 'fixed' ? req.team.party.map((ref) => deps.resolver.mon(ref)) : [];
        const infos = req.fights.map((spec) => deps.resolver.fight(spec));
        const worlds = Math.max(...infos.map((f) => f.worlds.length));
        const refuse = (why: Why): Verdict => refused(deps, cfg, req, worlds, Math.max(0, now() - start), why);
        const double = infos.find((f) => f.trainer.battleType === 'double');
        if (double !== undefined) return refuse({ reason: 'unsupportedBattle', detail: `${double.label} is a double battle; doubles are not supported yet` });
        const many = infos.find((f) => f.worlds.length > cfg.maxWorlds);
        if (many !== undefined) {
          const n = many.worlds.length;
          return refuse({ reason: 'unsupportedBattle', detail: `${n} candidate worlds for disputed natures/abilities exceed the limit of ${cfg.maxWorlds}; an in-game spot check settles them` });
        }
        const deadline = start + req.budgetMs;
        const ctl: FightControl = { deadline, checkerDeadline: deadline + req.budgetMs * cfg.checkerBudgetFactor, signal: par?.signal ?? signal, progress };
        if (req.team.kind === 'search') return await searchTeam(deps, cfg, req, req.team, infos, ctl, { now, start, refuse }, par);
        if (party.length === 0) return refuse({ reason: 'noEligibleTeam', detail: 'the team is empty' });
        const fights = teamFights(req, infos, party);
        const fainted = fights[0]!.healBefore ? undefined : party.find((m) => m.mon.currentHp <= 0);
        if (fainted !== undefined) {
          return refuse({ reason: 'noEligibleTeam', detail: `${fainted.label} (${fainted.ref}) has fainted (0 HP in the save); a fight cannot start with a fainted Pokémon` });
        }
        if (par === null) return solveWithPreStatus(deps, cfg, fights, req, ctl).verdict;
        return (await solveWithPreStatusAsync(deps, fights, req, ctl, null, (c) => splitFights(par, c.fights, c.req, c.ctl))).verdict;
      } finally {
        progress.flush();
        await par?.close();
      }
    },
  };
}
