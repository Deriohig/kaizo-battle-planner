// Contract between the solver (`src/solver`) and the server (`src/server`). Types only.

import type { StartStatus } from '../save/status.js';
import type { Choice, Rational, UndrawnSleep } from './engine.js';

/** A stable reference to one of the player's Pokémon: 'party:<slot>' or 'box:<box>:<slot>' (from `SaveLocation`). */
export type MonRef = string;

export type Tier = 1 | 2 | 3;

export type UnprovenReason =
  | 'timeout' | 'unmodelled' | 'verificationMismatch' | 'horizon' | 'needsHiddenInformation' | 'unsupportedBattle'
  | 'engineLimit' | 'noEligibleTeam';

/**
 * Ranking keys, applied lexicographically. Default order (with a crit budget for
 * tier 2, pending the player's confirmation): critBudget, critDeathProbability (tier 2 only), worstMinHp, totalHp, pp,
 * chanceDependencies, turns.
 */
export type RankKey = 'critBudget' | 'critDeathProbability' | 'worstMinHp' | 'totalHp' | 'pp' | 'chanceDependencies' | 'turns';

/** `variant`: 0 (default) is the trainer as the catalog resolves it (the harder copy); k ≥ 1 is `trainer.variants[k-1]`. */
export interface FightSpec { trainerId: string; variant?: number; healBefore?: boolean }

/**
 * A team search (the player's priorities). `pool`: who may fight; the page leaves out Pokémon set to Never.
 * `mustBring` (subset of the pool): in every team tried; more of them than `maxSize` is unproven `noEligibleTeam`.
 * `preferred` (subset of the pool, disjoint from `mustBring`): teams with more preferred members are tried first, and
 * the solver's own order breaks ties. Both default to empty, which is today's behaviour. A ref listed in `mustBring` or
 * `preferred` but not in the pool, or in both lists, is a RangeError.
 */
export interface TeamSearch { kind: 'search'; pool: MonRef[]; maxSize: number; mustBring?: MonRef[]; preferred?: MonRef[] }

export interface SolveRequest {
  fights: FightSpec[];                                               // 1 = a single fight; more = a gauntlet
  team: { kind: 'fixed'; party: MonRef[] } | TeamSearch;
  startStatus?: Record<MonRef, StartStatus>;                         // manual pre-status
  preStatus: 'given' | 'propose';                                    // 'propose' lets the solver suggest pre-statuses
  budgetMs: number;
  horizonTurns: number;                                              // the server sends 50; the solver may deepen iteratively up to it
  attemptAnyLegalBadge: boolean;                                     // level 2: safe against every legal enemy action
  ranking: RankKey[];
  /**
   * What-if levels: each named Pokémon of the team or pool fights at this level instead of the save's, from
   * the save's level to 100. The server has checked them, and the real solver builds the Pokémon with `atLevel`
   * (src/integration/realSolver.ts); the search itself never reads this.
   */
  levels?: Record<MonRef, number>;
  /**
   * How far a clean line is refined. 'first': the first tier-1 line found is
   * extracted, checked and shown: no ranking search, no pre-status proposals, and the level-2 badge only when asked.
   * 'best' (and absent): the best-ranked line the budget finds, as before.
   */
  refine?: 'first' | 'best';
}

/**
 * A node in the plan's decision tree. Player nodes carry the action to take; others branch on the AI or chance.
 * Label conventions (the page shows them as written):
 * - `branches[0]` is the main path: the AI's most likely action, or the most likely chance outcome. The page shows it inline.
 * - A player node has exactly one branch: the chosen action. `actionLabel` reads "Use <Move>" or "Switch to <Pokémon>";
 *   at the start of each fight (each gauntlet fight too) it reads "Lead with <Pokémon>".
 * - Enemy branches read "If the AI uses <Move>", "If the AI switches to <Pokémon>", "If the AI uses a <Item>", or
 *   "If the AI sends in <Pokémon>" (replacement).
 * - Chance branches name the event in words: "If <Move> crits", "If <Move> misses", "If <Move> burns <Pokémon>",
 *   "If <Pokémon> wakes up", "If <Pokémon> is fully paralysed", "If <Move> rolls 22–24", "If <Pokémon> moves first (speed tie)".
 *   Merged outcomes may list the decisive event only.
 * - A single branch with probability 1 may have an empty label.
 * - An enemy send-in after a KO is named inside the branch label that leads to it, not as a separate enemy node:
 *   "If Bash crits, then the AI sends in Tiger", or "The AI sends in Tiger" when nothing else happened.
 * - Sibling labels are unique: later duplicates (empty ones included) get " (2)", " (3)", ….
 * - `KillBranch.path` is the list of branch labels from the root, exactly one entry per depth, including the empty labels
 *   of probability-1 branches (e.g. ["", "", "If the AI uses Headbutt", "If Headbutt crits"]); the page matches it by
 *   position. `cause` reads "enemy crit <Move> on turn <n> kills <Pokémon>",
 *   or "<Move> misses on turn <n>, then …" for tier 3.
 */
export interface PlanNode {
  observation: string;                                               // what is on screen here
  kind: 'player' | 'enemy' | 'chance';
  action?: Choice;                                                   // player nodes
  actionLabel?: string;                                              // "Use Close Combat", "Switch to Staraptor"
  branches: PlanBranch[];                                            // main path first
}
export interface PlanBranch { label: string; probability: Rational; next: PlanNode | PlanLeaf }
/**
 * `cutoff` = the search horizon ended the line; `truncated` = the tree was cut for display (the proof goes deeper);
 * `unplanned` = the line finder has not planned this branch yet: its probability counts as a death in
 * every figure, so a figure can only be too cautious.
 */
export interface PlanLeaf { result: 'win' | 'death' | 'cutoff' | 'truncated' | 'unplanned'; endHp?: number[]; endStatus?: (StartStatus | UndrawnSleep)[] }

/** A path that kills one of the player's Pokémon, e.g. cause "enemy crit Rock Slide on turn 3 kills Staravia". */
export interface KillBranch { path: string[]; probability: Rational; cause: string }

/**
 * `verification` is the independent checker's pass over the line shown (both levels added together for a proven badge).
 * `verification.notCrossChecked`: every damaging hit of that pass the damage oracle did not compare with the
 * damage calc (the calc gives no result, is unbounded or an OHKO move, such as Counter, Mirror Coat or Stomp; a
 * multi-hit move; False Swipe; a hit a Substitute takes; any other hit it passes over), per move display name, one per
 * damage line or Substitute hit (damage no move dealt, such as a burn or recoil, is never a hit), counted per outcome
 * the checker walks (every world and branch); for a proven two-level badge the hits of both levels' checks are added,
 * not de-duplicated, so one hit in the plan can count many times.
 * Sorted by hits descending, then move name; empty when none, and when nothing was checked.
 */
export interface ProofReport {
  nodes: number; turnExecutions: number; ttEntries: number; ttHits: number; elapsedMs: number;
  enumerated: string[];                                              // what was enumerated (rolls, crits, AI supports, worlds…)
  assumptions: string[];                                             // independence model, no mid-fight level-ups, observation mode…
  rejectedTeams: { team: MonRef[]; firstFailure: string }[];
  verification: { passed: boolean; damageChecks: number; orderChecks: number; mismatches: string[]; notCrossChecked: { move: string; hits: number }[] };
  modelNote: string | null;                                          // "model not yet verified in game" until the spot checks pass
}

/** Gauntlets: the range of HP and statuses each team member can enter fight `fight` (0-based) with. */
export interface GauntletEntry { fight: number; mons: { ref: MonRef; hpMin: number; hpMax: number; statuses: string[] }[] }

interface VerdictBase {
  team: MonRef[]; lead: MonRef; preStatus: Record<MonRef, StartStatus>; report: ProofReport;
  /** When pre-statuses were proposed: the result without them (spec: "odds with and without the pre-status"). */
  preStatusBaseline?: { tier: Tier | 'unproven'; deathProbability?: Rational };
  entries?: GauntletEntry[];
  /**
   * The line was shown before the checker finished replaying it (a found line is always shown): its figures
   * are the search's own. Absent on a checked line.
   */
  provisional?: true;
}

/**
 * Tier 2/3 odds: `deathProbability` is under the AI's own action distribution (what the plan says);
 * `guaranteeDeathProbability` is the worst case over every action in the AI's support (the bound that holds even if the
 * AI's odds are off). Both are maxed over disputed-data worlds.
 * `unplannedProbability`: the part of `deathProbability` that is branches the line does not plan yet,
 * counted as deaths. Absent or zero: every branch is planned and the figure is exact.
 */
export type Verdict =
  | (VerdictBase & { tier: 1; tree: PlanNode; anyLegalBadge: 'proven' | 'failed' | 'notAttempted'; rank: Partial<Record<RankKey, string>> })
  | (VerdictBase & { tier: 2; tree: PlanNode; critBudget: number; deathProbability: Rational; guaranteeDeathProbability?: Rational; unplannedProbability?: Rational; killers: KillBranch[] })
  | (VerdictBase & { tier: 3; tree: PlanNode; deathProbability: Rational; guaranteeDeathProbability?: Rational; unplannedProbability?: Rational; killers: KillBranch[]; optimality: 'proven' | 'bestFoundWithinBudget' })
  | { tier: 'unproven'; reason: UnprovenReason; detail: string; best?: Verdict; report: ProofReport };

/**
 * The best line found so far, sent while the search goes on: the line
 * finder works from the most likely branches to the least likely, and every line it holds is shown at once, before the
 * checker has replayed it. `deathProbability` is an upper bound: the deaths found on what is planned
 * (`foundDeathProbability`) plus everything not planned yet (`unplannedProbability`). `leads` lists every lead looked
 * at so far with its own bound, best first. `seq` rises with each snapshot of a solve.
 */
export interface LineSnapshot {
  seq: number;
  team: MonRef[]; lead: MonRef;
  tree: PlanNode;                                                    // 'unplanned' leaves where nothing is planned yet
  deathProbability: Rational; foundDeathProbability: Rational; unplannedProbability: Rational;
  killers: KillBranch[];                                             // what kills on the planned part, most likely first
  leads: { lead: MonRef; deathProbability: Rational; unplannedProbability: Rational }[];
  verified: boolean;                                                 // the checker has replayed exactly this line
}

/** `line`: present when the best line changed since the last progress (or its check finished). */
export interface Progress { elapsedMs: number; nodes: number; teamsTried: number; teamsTotal: number; bestTier: Tier | null; message: string; line?: LineSnapshot }

/**
 * The `signal.reason` of the player's own stop: the solve ends and returns the line found so far, checked within
 * a short grace time, else `provisional`. An abort with any other reason (a plan that replaces this one, a closed
 * connection) drops the solve at once.
 */
export type StopReason = 'stop';

export interface Solver {
  solve(req: SolveRequest, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<Verdict>;
}
