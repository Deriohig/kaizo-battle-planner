// Tiers 2 and 3: crit-budget games and exact death probabilities. Called once tier 1 has failed.
//
// Order of work. G_0 (every enemy-crit step dropped) is proven first: a Prover with critBudget 0, deepened to the
// horizon. A win means only enemy crits can kill (tier 2); a failure means a non-crit outcome can kill on every line
// (tier 3); unknown is returned as it is. Misses and bad rolls are never accepted the way crits are: G_j drops only
// crit steps, everything else stays adversarial.
// - Tier 2, budget first (critBudget before critDeathProbability in the ranking, or the latter absent): the largest j
//   with a G_j proof, trying j = 1, 2, … until a failure. A fight has at most two of the player's decisions per turn (a turn
//   choice and a U-turn switch), each at most one crit step, so past 2 × horizon × fights G_j is the whole game: the
//   loop stops there. The loop gets a sub-deadline, half of the time left when it starts: on it (or an unknown) the last
//   proven j stands, so a proven G_j is never lost to G_{j+1} running out of time, and the line is only the best found
//   ('bestFoundWithinBudget', `complete` false). Then the least failure among G_j-safe lines, the kept prover back on the
//   search deadline; the result's critBudget is j.
// - Tier 2, probability first: the least failure among G_0-safe lines; the result's critBudget is null (the checker
//   reports the line's budget).
// - Tier 3: the least failure over every line.
//
// Exact value. value(B, h, j) is the least P(failure | B) (normalised by B's weight) over observation-keyed strategies,
// with h turns left in B's fight (a later fight's entry starts again at the horizon) and constraint j (null: none).
// Failure is a death, an unlabelled outcome, a horizon cut-off (a turnChoice with no turn left is ONE) or an
// engine LIMIT: a limited choice is skipped, and when every choice is limited the belief is worth ONE and keeps the
// first one (its certificate node has no edges; the checker meets the same LIMIT, a failure with reason engineLimit).
// One choice per belief, never per member. Under G_j, at a belief with members within the budget (crits <= j), the
// allowed choices are those the G_j prover proves for those members: prover_j.proveAction(restrict(B, crits <= j), a,
// h), with prover_j.H the horizon; members past the budget are unconstrained. A choice proven there keeps every child's
// within-budget members provable (they are the G_j game's child beliefs), so a constrained belief the line reaches
// always has an allowed choice.
// Expansion: level 1, critCap j + 1 (null in tier 3), no crit filter: the line goes on past j crits, exactly as
// certificateFromPolicy expands it. For each choice, the accumulated failure starts at the dead and unlabelled leaf mass
// and adds child × value(child); once it reaches the best complete choice's value the choice is abandoned (it cannot be
// strictly better: values are exact and non-negative). Values are never passed down as bounds, so every memoised value
// is exact, but for one case. Memo key: belief key | weightsKey | h | j. The search terminates: h falls with every turn
// and resets only at a later fight, and a loop that takes no turn (a mid-turn switch back to the same belief) meets a
// node still being evaluated (same memo key, on the recursion's stack), which counts as failure ONE (sure termination,
// as the prover's repetition) instead of recursing. Values found through such a cut are upper bounds (the case above),
// so the line is then 'bestFoundWithinBudget'. Ties keep the earlier choice (history, hint, default order), so the
// result is deterministic, but for one case: a best choice whose evaluation met that loop guard gives way to a later
// choice that ties it without meeting the guard (a choice is abandoned on a tie only when it cannot take the best's
// place). Taking the loop instead would write a certificate that cycles back to a node on its own path, which the
// checker reports as a cycle (a false-alarm verificationMismatch). Only ties are steered: a looping choice that is
// strictly better is still taken.
//
// Policy: (belief key, weightsKey, h) → the choice whose value is the belief's, recorded when that choice is fully
// evaluated, which certificateFromPolicy reads. The chosen choice's children were all evaluated, so every decision the
// line reaches has a policy, except turn choices with no turn left (cut-offs, never asked).
//
// Worlds: the search weights a fight's worlds uniformly, while the checker maximises over them. `optimality`
// is 'proven' only when the search finished, no choice was left out for an engine LIMIT anywhere it looked (a skipped
// expansion, or a G_j safety proof failing with reason engineLimit: that choice might have done better), no evaluated
// choice counted unlabelled mass as failure and no G_j safety proof failed with reason unmodelled (an unlabelled
// outcome, AI errors included, might be a win, so that choice too might have done better), no turnless loop was cut
// (above), the root's
// chosen lead reaches exactly one distinct member at the first decision (one world after merging identical states), and
// no later fight has more than one world; otherwise 'bestFoundWithinBudget'. `failure` is the search's exact value of the line (equal to the checker's failureAi with one
// distinct world). On the deadline or an abort: the best fully evaluated root choice's line, 'bestFoundWithinBudget';
// with none, unknown. `complete` is false when the deadline, an abort or the crit-budget loop's sub-deadline cut the
// search short (the line still stands; a better one may exist).
// The deadline and the signal reach inside an expansion too: the value search's beliefs carry them as the
// arena's `stop`, and an engine step they stop (ArenaStopError) is the value search's Stop, as at a node, never an
// engine LIMIT (the G_j provers do the same through their own deadlines, prove.ts). The line's certificate is then
// built from the policy without a stop (it replays expansions the search made), and so does the one-world check after
// a finished search (post-search work: it never stops).

import type { Choice, Rational } from '../contracts/engine.js';
import type { RankKey } from '../contracts/solver.js';
import { ArenaLimitError, ArenaStopError, type Arena } from './arena.js';
import { beliefChoices, expandBelief, restrict, weightsKey, type Belief, type BeliefExpansion, type BeliefOpts } from './belief.js';
import { certificateFromPolicy, type Certificate } from './certificate.js';
import { choiceText } from './keys.js';
import { orderChildren, orderChoices } from './order.js';
import { Prover } from './prove.js';
import { add, cmp, div, mul, ONE, sum } from './rational.js';
import type { ObservationMode, OrderHint, PlanLabeler } from './types.js';

export interface RiskOptions {
  horizon: number; ranking: readonly RankKey[]; mode: ObservationMode;
  deadline: number; now: () => number; signal?: AbortSignal; labeler: PlanLabeler;
  history: Map<string, Choice>; orderHint?: OrderHint; onNode?: () => void; restrictRoot?: Choice[];
}
export type RiskResult =
  | {
    kind: 'line'; tier: 2 | 3; critBudget: number | null; certificate: Certificate; failure: Rational; optimality: 'proven' | 'bestFoundWithinBudget';
    complete: boolean;   // false: a deadline or an abort cut the search short (see the top of the file)
  }
  | { kind: 'unknown'; cause: 'timeout' | 'aborted' };

type Cause = 'timeout' | 'aborted';

/** The deadline passed or the signal aborted, in the value search or in a safety proof inside it. */
class Stop extends Error {
  constructor(readonly cause: Cause) {
    super(`risk: ${cause}`);
    this.name = 'Stop';
  }
}

/** Budget first unless critDeathProbability is ranked and critBudget is not ranked before it (prestatus.ts betterRun too). */
export function budgetFirst(ranking: readonly RankKey[]): boolean {
  const budget = ranking.indexOf('critBudget');
  const probability = ranking.indexOf('critDeathProbability');
  return probability < 0 || (budget >= 0 && budget < probability);
}

/** A level-1 Prover for G_j with the caller's clock, ordering and root restriction. */
function gameProver(arena: Arena, opts: RiskOptions, critBudget: number): Prover {
  return new Prover(arena, {
    params: { level: 1, critBudget, thresholds: null }, mode: opts.mode, deadline: opts.deadline, now: opts.now, signal: opts.signal,
    labeler: opts.labeler, history: opts.history, orderHint: opts.orderHint, onNode: opts.onNode, restrictRoot: opts.restrictRoot,
  });
}

/** The policy's node identity: certificateFromPolicy's (belief key, weightsKey, turns left). */
function nodeId(belief: Belief, h: number): string {
  return `${belief.key}|${weightsKey(belief)}|${h}`;
}

/** The exact value search under one constraint (see the top of the file). */
class ValueSearch {
  /** nodeId → the choice the belief's value is reached with. */
  readonly policy = new Map<string, Choice>();
  /** The best fully evaluated root choice so far, with its exact value. */
  rootBest: { action: Choice; value: Rational } | null = null;
  /**
   * Some choice was left out for an engine LIMIT: its expansion hit one (skipped, or kept with every choice limited), or
   * its G_j safety proof failed with reason engineLimit. Such a choice might have done better, so no value is optimal.
   */
  limitHit = false;
  /**
   * Some evaluated choice's value counted unlabelled mass as failure (an unlabelled leaf below it), or a G_j safety proof
   * failed with reason unmodelled. The outcome might be a win, so that choice might have done better: no value is optimal.
   */
  unlabelledHit = false;
  /** A turnless loop met a node still being evaluated (counted as failure ONE): values through it are upper bounds. */
  loopHit = false;
  /** How many times the loop guard has fired: a choice whose evaluation leaves it unchanged never met it. */
  private loopCuts = 0;
  /** Why the arena's `stop` last returned true: an expansion it ended is a Stop for this cause (no second clock reading). */
  private stopCause: Cause = 'timeout';
  readonly expandOpts: BeliefOpts;
  private readonly memo = new Map<string, Rational>();
  /** The memo keys of the nodes being evaluated (the recursion's stack). */
  private readonly onStack = new Set<string>();

  constructor(private readonly arena: Arena, private readonly root: Belief, private readonly opts: RiskOptions,
    private readonly j: number | null, private readonly safety: Prover | null) {
    this.expandOpts = {
      level: 1, critCap: j === null ? null : j + 1, mode: opts.mode,
      stop: () => {
        const cause = this.cause();
        if (cause !== null) this.stopCause = cause;
        return cause !== null;
      },
    };
  }

  value(belief: Belief, turnsLeft: number): Rational {
    const h = belief.phase === 'entry' && belief.fight > 0 ? this.opts.horizon : turnsLeft;
    if (belief.phase === 'turnChoice' && h <= 0) return ONE;
    const id = nodeId(belief, h);
    const memoKey = `${id}|${this.j ?? '-'}`;
    const known = this.memo.get(memoKey);
    if (known !== undefined) return known;
    if (this.onStack.has(memoKey)) {   // a turnless loop back to a node still being evaluated (see the top of the file)
      this.loopHit = true;
      this.loopCuts += 1;
      return ONE;
    }
    this.tick();
    const atRoot = belief.key === this.root.key;
    const total = sum(belief.members.map((m) => m.weight));
    let best: Rational | null = null;
    let bestLooped = false;              // the best choice's evaluation met the loop guard
    let limited: Choice | null = null;   // the first choice whose expansion hit an engine LIMIT
    this.onStack.add(memoKey);
    try {
      for (const a of this.allowed(belief, h)) {
        let x: BeliefExpansion;
        try {
          x = expandBelief(this.arena, belief, a, this.expandOpts);
        } catch (e) {
          if (e instanceof ArenaStopError) throw new Stop(this.stopCause);   // never a LIMIT (see the top of the file)
          if (!(e instanceof ArenaLimitError)) throw e;
          limited ??= a;
          this.limitHit = true;
          continue;
        }
        const step = x.turnConsumed ? 1 : 0;
        if (x.leaves.some((l) => l.result === 'unlabelled')) this.unlabelledHit = true;
        const cutsBefore = this.loopCuts;
        // A choice that ties the best replaces it only when the best met the loop guard and this one does not (see the
        // top of the file); otherwise it must be strictly better.
        const beats = (v: Rational): boolean => {
          const c = best === null ? -1 : cmp(v, best);
          return c < 0 || (c === 0 && bestLooped && this.loopCuts === cutsBefore);
        };
        let acc = div(sum(x.leaves.filter((l) => l.result !== 'win').map((l) => l.weight)), total);
        let abandoned = false;
        for (const child of orderChildren(x.children)) {
          if (!beats(acc)) {   // values are exact and non-negative: the rest can only add to it
            abandoned = true;
            break;
          }
          acc = add(acc, mul(div(child.weight, total), this.value(child.belief, h - step)));
        }
        if (!abandoned && beats(acc)) {
          best = acc;
          bestLooped = this.loopCuts !== cutsBefore;
          this.choose(id, a, acc, atRoot);
        }
      }
    } finally {
      this.onStack.delete(memoKey);
    }
    // Every choice limited: the line keeps the first one, which the checker also cannot expand (a failure there).
    if (best === null && limited !== null) this.choose(id, limited, ONE, atRoot);
    const v = best ?? ONE;
    this.memo.set(memoKey, v);
    return v;
  }

  private choose(id: string, action: Choice, value: Rational, atRoot: boolean): void {
    this.policy.set(id, action);
    if (atRoot) this.rootBest = { action, value };
  }

  /** Throws Stop past the deadline or on abort; counts the node. */
  private tick(): void {
    const cause = this.cause();
    if (cause !== null) throw new Stop(cause);
    this.opts.onNode?.();
    this.arena.stats.nodes += 1;
  }

  /** Why the search must stop now (the deadline first, as at a node), or null; the arena's `stop` polls it too. */
  private cause(): Cause | null {
    if (this.opts.now() > this.opts.deadline) return 'timeout';
    return this.opts.signal?.aborted === true ? 'aborted' : null;
  }

  /** The legal choices (restrictRoot's only at the root), G_j-safe ones only when members are within the budget; ordered. */
  private allowed(belief: Belief, h: number): Choice[] {
    let choices = beliefChoices(this.arena, belief);
    const only = this.opts.restrictRoot;
    if (only !== undefined && belief.key === this.root.key) {
      const keep = new Set(only.map(choiceText));
      choices = choices.filter((c) => keep.has(choiceText(c)));
    }
    const j = this.j;
    const prover = this.safety;
    if (j !== null && prover !== null) {
      const within = restrict(belief, (m) => m.crits <= j);
      if (within !== null) {
        choices = choices.filter((a) => {
          const r = prover.proveAction(within, a, h);
          if (r.kind === 'unknown') throw new Stop(r.cause);
          if (r.kind === 'fail' && r.reasons.engineLimit) this.limitHit = true;
          if (r.kind === 'fail' && r.reasons.unmodelled) this.unlabelledHit = true;
          return r.kind === 'win';
        });
      }
    }
    return orderChoices(belief, choices, this.opts.history, this.opts.orderHint);
  }
}

/**
 * The least-failure line under constraint j (null: none; `safety` is the G_j prover), as a risk certificate.
 * `reported` is the result's critBudget.
 */
function bestLine(arena: Arena, root: Belief, opts: RiskOptions, tier: 2 | 3, j: number | null, safety: Prover | null,
  reported: number | null): RiskResult {
  if (safety !== null) safety.H = opts.horizon;   // later fights' entries start again at the horizon, as in the search
  const search = new ValueSearch(arena, root, opts, j, safety);
  let finished = true;
  try {
    search.value(root, opts.horizon);
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    if (search.rootBest === null) return { kind: 'unknown', cause: e.cause };
    finished = false;
  }
  const best = search.rootBest;
  if (best === null) throw new Error('risk: the root has no legal choice');
  const certificate = certificateFromPolicy(arena, root, (b, h) => search.policy.get(nodeId(b, h)) ?? null,
    { level: 1, mode: opts.mode, horizon: opts.horizon, critBudget: j });
  // A kept limited root lead implies limitHit, so oneWorld only expands a lead that was expanded in the search.
  // oneWorld is post-search work, like the certificate above: no stop.
  const proven = finished && !search.limitHit && !search.unlabelledHit && !search.loopHit
    && oneWorld(arena, root, best.action, { ...search.expandOpts, stop: undefined });
  return { kind: 'line', tier, critBudget: reported, certificate, failure: best.value, optimality: proven ? 'proven' : 'bestFoundWithinBudget', complete: finished };
}

/**
 * Whether the uniform world weights are exact: the root's lead reaches one distinct member at the first decision (the
 * worlds merge into one state) and no later fight has more than one world. An engine LIMIT on the lead: false. Called
 * after the search with no stop, so nothing stops it.
 */
function oneWorld(arena: Arena, root: Belief, lead: Choice, expandOpts: BeliefOpts): boolean {
  if (arena.fights.some((f, i) => i > 0 && f.info.worlds.length > 1)) return false;
  let x: BeliefExpansion;
  try {
    x = expandBelief(arena, root, lead, expandOpts);
  } catch (e) {
    if (e instanceof ArenaLimitError) return false;
    throw e;
  }
  return x.leaves.length + x.children.reduce((n, c) => n + c.belief.members.length, 0) === 1;
}

/** Tier 2 or 3 for `root` (the fight-0 entry) once tier 1 has failed (see the top of the file). */
export function solveRisk(arena: Arena, root: Belief, opts: RiskOptions): RiskResult {
  if (!Number.isInteger(opts.horizon) || opts.horizon < 1) throw new RangeError(`risk: horizon must be a positive integer, got ${opts.horizon}`);
  const g0 = gameProver(arena, opts, 0);
  const first = g0.deepen(root, opts.horizon).result;
  if (first.kind === 'unknown') return { kind: 'unknown', cause: first.cause };
  if (first.kind === 'fail') return bestLine(arena, root, opts, 3, null, null, null);
  if (!budgetFirst(opts.ranking)) return bestLine(arena, root, opts, 2, 0, g0, null);
  const most = 2 * opts.horizon * arena.fights.length;
  const start = opts.now();
  const loopDeadline = Math.min(opts.deadline, start + (opts.deadline - start) / 2);   // see the top of the file
  let j = 0;
  let prover = g0;
  let cut = false;
  while (j < most) {
    const next = gameProver(arena, opts, j + 1);
    next.deadline = loopDeadline;
    const r = next.deepen(root, opts.horizon).result;
    if (r.kind === 'unknown') {
      cut = true;
      break;
    }
    if (r.kind === 'fail') break;
    j += 1;
    prover = next;
  }
  prover.deadline = opts.deadline;   // bestLine's G_j safety proofs run to the search deadline
  const line = bestLine(arena, root, opts, 2, j, prover, j);
  return cut && line.kind === 'line' ? { ...line, optimality: 'bestFoundWithinBudget', complete: false } : line;
}
