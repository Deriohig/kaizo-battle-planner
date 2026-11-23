// The tier-1 prover: a sure-win reach-avoid game over beliefs.
//
// Quantifiers: ∃a ∀b ∀ω per decision. The player's choice at a belief is the OR (one choice for every member, so a strategy
// depends only on what he sees); expandBelief already ANDs the AI's support (or every legal enemy action at level 2),
// every engine outcome, every world and every member, so proveAction ANDs its leaves and child beliefs.
// Horizon: h counts the turns left in the current fight; a turnChoice belief with none left is a cut-off; entry and
// playerMidTurnSwitch beliefs take no turn; a later fight's entry starts again at H. Iterative deepening raises H.
// Sure termination: a belief already on the stack fails (an adversary could repeat the loop), with lowlink = its index.
// Caching rule: a win within d turns is stored with the current H and reused with at least d turns left, and, outside
// the last fight, only while its stored H is at most the current H (its later fights were proven within that per-fight
// horizon, and a longer one only helps). Wins never depend on the stack. A failure is stored only when its lowlink is at
// least its own stack index: as failAbs without a horizon cut-off below it, else as failHorizon(h, H), reused only with
// at most h turns left and a per-fight horizon of at most H. Timeouts and aborts return unknown and are never stored.
// The deadline (the live `deadline`, which a caller may move) and the signal also reach inside an expansion:
// every belief this prover expands carries them as the arena's `stop`, and an engine step they stop (ArenaStopError)
// makes that choice unknown, a timeout or an abort like the node check's, never an engine LIMIT. The extraction of a
// line already found (certificate.ts extractProof, through expansion()) is post-search work: its own expansions stop
// on the signal only, never on the deadline, so a proof won just before the deadline is still
// extracted. A re-proof inside the extraction is this prover's own proving and keeps the deadline.
// An engine LIMIT is stored as failAbs (see the put below).
// Refuted: whether a failure shows that Win is not forced, rather than only not shown (callers decide "tier 1 refuted"
// from it, never from the merged reasons, which OR every choice's). A dead leaf and a win leaf below a threshold are
// refuted, and so is a repetition (sure termination makes it exact); an unlabelled leaf (AI errors included), an engine
// LIMIT, a horizon cut-off and 'no legal choice' are not. proveAction (AND) is refuted iff the failing leaf or child it
// returns is; prove (OR) iff every choice it tried returned refuted. The table stores it with each failure.
// G_j (critBudget j): member crits are counted up to j + 1 and every successor past j crits is dropped (`keep`).
// restrictRoot: the root is explicit, set by deepen or setRoot; wherever the root belief occurs it tries only the
// listed (legal) choices. The table then holds values of that restricted game, which only removes options from the player,
// so its wins are real wins. Calls on other beliefs (certificate re-proofs) are not restricted, and without a root
// nothing is.

import type { Choice } from '../contracts/engine.js';
import { ArenaLimitError, ArenaStopError, type Arena, type Member, type Successor } from './arena.js';
import { beliefChoices, expandBelief, type Belief, type BeliefExpansion, type BeliefLeaf, type BeliefOpts } from './belief.js';
import { choiceText } from './keys.js';
import { orderChildren, orderChoices } from './order.js';
import { cmp, toJson } from './rational.js';
import { TranspositionTable } from './tt.js';
import { mergeReasons, NO_REASONS, type FailReasons, type GameParams, type ObservationMode, type OrderHint, type PlanLabeler } from './types.js';

export type ProofResult =
  | { kind: 'win'; depth: number }
  | { kind: 'fail'; horizon: boolean; low: number; reasons: FailReasons; refutation: string[]; refuted: boolean }   // refuted: see the top of the file
  | { kind: 'unknown'; cause: 'timeout' | 'aborted' };

export interface ProverOptions {
  params: GameParams; mode: ObservationMode; deadline: number; now: () => number; signal?: AbortSignal;
  labeler: PlanLabeler; history: Map<string, Choice>; orderHint?: OrderHint; onNode?: () => void;
  restrictRoot?: Choice[];           // when set, the root belief tries only these choices (parallel root split)
}

type Fail = Extract<ProofResult, { kind: 'fail' }>;

const INF = Number.POSITIVE_INFINITY;

function only(reason: keyof FailReasons): FailReasons {
  return { ...NO_REASONS, [reason]: true };
}

function fail(horizon: boolean, low: number, reasons: FailReasons, refutation: string[], refuted: boolean): Fail {
  return { kind: 'fail', horizon, low, reasons, refutation, refuted };
}

/** A metric against a bound, given the sign of (metric − bound): `>` when strict, else `>=`. */
function passes(sign: number, strict: boolean): boolean {
  return strict ? sign > 0 : sign >= 0;
}

const relation = (strict: boolean): string => (strict ? '>' : '>=');

/**
 * How the game `params` expands beliefs in `mode` (the prover, certificate extraction and certificate stats all use it).
 * G_j caps member crits at j + 1 and drops every successor past j crits: a continue successor carries its member's
 * (capped) crits; a leaf has no member, so its crits are counted here.
 */
export function gameExpandOptions(params: GameParams, mode: ObservationMode): BeliefOpts {
  const j = params.critBudget;
  const base = { level: params.level, mode };
  return j === null
    ? { ...base, critCap: null }
    : { ...base, critCap: j + 1, keep: (s: Successor, from: Member) => (s.member !== null ? s.member.crits : from.crits + s.critsAdded) <= j };
}

/**
 * The player's choice at `belief` in words: 'Lead with <team label>' at an entry (no state to label from), else the labeler's
 * text for p1 at the first member's state. Refutations and the plan tree both use it.
 */
export function actionLabel(arena: Arena, labeler: PlanLabeler, belief: Belief, choice: Choice): string {
  const first = belief.members[0]?.member;
  if (first === undefined) throw new Error('prove: a belief without members');
  if (first.state === null) {
    const label = choice.kind === 'switch' ? arena.fights[belief.fight]?.team[choice.index]?.label : undefined;
    return `Lead with ${label ?? choiceText(choice)}`;
  }
  return labeler.choice(first.state, 'p1', choice);
}

export class Prover {
  readonly tt = new TranspositionTable();
  readonly params: GameParams;
  /** The current per-fight horizon. deepen sets it; set it before calling prove or proveAction directly. */
  H = 0;
  /**
   * The search deadline, opts.deadline at first. A caller may move it (risk.ts gives the crit-budget loop a shorter one,
   * then lengthens the kept prover's): a timeout is never stored, so the table stays valid either way.
   */
  deadline: number;
  private readonly arena: Arena;
  private readonly opts: ProverOptions;
  private readonly expandOpts: BeliefOpts;
  /** Belief key → stack index; insertion order is stack order (only the top is ever removed). */
  private readonly stack = new Map<string, number>();
  /** The root belief's key (see restrictRoot above); null until deepen or setRoot sets it. */
  private rootKey: string | null = null;
  /** The arena's last fight: its wins do not depend on H. */
  private readonly lastFight: number;
  /** Why the arena's `stop` last returned true (stopped()): an expansion it ended is unknown for this cause. */
  private stopCause: 'timeout' | 'aborted' = 'timeout';

  constructor(arena: Arena, opts: ProverOptions) {
    const j = opts.params.critBudget;
    if (j !== null && (!Number.isInteger(j) || j < 0)) throw new RangeError(`prove: critBudget must be null or a non-negative integer, got ${j}`);
    this.arena = arena;
    this.opts = opts;
    this.params = opts.params;
    this.deadline = opts.deadline;
    this.lastFight = arena.fights.length - 1;
    this.expandOpts = { ...gameExpandOptions(opts.params, opts.mode), stop: () => this.stopped() };
  }

  /**
   * Read-only: the arena and the belief expansion options this prover searches with (certificates expand the same way),
   * for the extraction of a line already found: their `stop` is the signal only, never the deadline (see the top of the
   * file).
   */
  expansion(): { arena: Arena; opts: BeliefOpts } {
    return { arena: this.arena, opts: { ...this.expandOpts, stop: () => this.aborted() } };
  }

  /** Is Win forced from `belief` with `h` turns left in its fight (fresh horizons of H in later fights)? */
  prove(belief: Belief, h: number): ProofResult {
    return this.proveNode(belief, h);
  }

  /** Is Win forced from `belief` when the player plays `choice` now, with `h` turns left? */
  proveAction(belief: Belief, choice: Choice, h: number): ProofResult {
    return this.proveChoice(belief, choice, h);
  }

  /**
   * The belief restrictRoot applies to (deepen sets it too). With restrictRoot set, the table describes the game
   * restricted at this root, so the root cannot move once set or once the table holds entries.
   */
  setRoot(belief: Belief): void {
    if (this.opts.restrictRoot !== undefined && this.rootKey !== belief.key && (this.rootKey !== null || this.tt.size > 0)) {
      throw new Error('prove: the table holds a game restricted at another root (or unrestricted); use a new Prover for this root');
    }
    this.rootKey = belief.key;
  }

  /** H = 1..maxH; stops at the first win, an unknown, or a fail without horizon involvement. */
  deepen(root: Belief, maxH: number): { result: ProofResult; horizon: number } {
    if (!Number.isInteger(maxH) || maxH < 1) throw new RangeError(`prove: maxH must be a positive integer, got ${maxH}`);
    this.setRoot(root);
    let last: ProofResult | null = null;
    for (let H = 1; H <= maxH; H++) {
      this.H = H;
      const result = this.prove(root, H);
      if (result.kind !== 'fail' || !result.horizon) return { result, horizon: H };
      last = result;
    }
    return { result: last!, horizon: maxH };
  }

  private proveNode(belief: Belief, h: number): ProofResult {
    if (belief.phase === 'entry' && belief.fight > 0) h = this.H;   // a new fight starts with a fresh horizon
    const { key } = belief;
    const e = this.tt.get(key);
    if (e !== undefined) {
      if (e.kind === 'win' && e.depth <= h && (belief.fight === this.lastFight || e.H <= this.H)) {
        this.tt.hits += 1;
        return { kind: 'win', depth: e.depth };
      }
      if (e.kind === 'failAbs') {
        this.tt.hits += 1;
        return fail(false, INF, e.reasons, e.refutation, e.refuted);
      }
      if (e.kind === 'failHorizon' && h <= e.h && this.H <= e.H) {
        this.tt.hits += 1;
        return fail(true, INF, e.reasons, e.refutation, e.refuted);
      }
    }
    if (belief.phase === 'turnChoice' && h <= 0) return this.cutOff();
    const at = this.stack.get(key);
    if (at !== undefined) return fail(false, at, only('repetition'), ['repeats an earlier position'], true);
    if (this.opts.now() > this.deadline) return { kind: 'unknown', cause: 'timeout' };
    if (this.opts.signal?.aborted === true) return { kind: 'unknown', cause: 'aborted' };
    this.opts.onNode?.();
    this.arena.stats.nodes += 1;

    const my = this.stack.size;
    this.stack.set(key, my);
    let low = INF;
    let horizonHit = false;
    let reasons = NO_REASONS;
    let refutation: string[] | null = null;
    let refuted = true;   // every choice tried so far returned refuted
    try {
      for (const a of this.choicesAt(belief)) {
        const r = this.proveAction(belief, a, h);
        if (r.kind === 'unknown') return r;
        if (r.kind === 'win') {
          this.tt.put(key, { kind: 'win', depth: r.depth, H: this.H, action: a });
          this.opts.history.set(key, a);
          return r;
        }
        low = Math.min(low, r.low);
        horizonHit ||= r.horizon;
        reasons = mergeReasons(reasons, r.reasons);
        refuted &&= r.refuted;
        refutation ??= [this.choiceLabel(belief, a), ...r.refutation];
      }
    } finally {
      this.stack.delete(key);
    }
    if (refutation === null) {   // no choice was tried: unproven, never a failure without a reason
      reasons = only('unmodelled');
      refutation = ['no legal choice'];
      refuted = false;
    }
    // The lowlink rule: nothing above this belief on the stack was needed for the failure.
    // An engine LIMIT below (reasons.engineLimit) is stored like any other failure, as failAbs: it is a deterministic
    // property of (state, choice) under the arena's fixed maxLeaves, not of the time left, so a retry gives the same
    // LIMIT. It is never refuted, so callers classify such a failure as unproven.
    if (low >= my) {
      this.tt.put(key, horizonHit ? { kind: 'failHorizon', h, H: this.H, reasons, refutation, refuted } : { kind: 'failAbs', reasons, refutation, refuted });
    }
    return fail(horizonHit, low, reasons, refutation, refuted);
  }

  private proveChoice(belief: Belief, choice: Choice, h: number): ProofResult {
    if (belief.phase === 'turnChoice' && h <= 0) return this.cutOff();
    let x: BeliefExpansion;
    try {
      x = expandBelief(this.arena, belief, choice, this.expandOpts);
    } catch (e) {
      // Absolute (low +inf, no horizon): the LIMIT does not depend on the stack or the turns left. Unproven, not refuted.
      if (e instanceof ArenaLimitError) return fail(false, INF, only('engineLimit'), [e.message], false);
      // The deadline or the signal stopped an engine step: as the node check, never stored (see the top of the file).
      if (e instanceof ArenaStopError) return { kind: 'unknown', cause: this.stopCause };
      throw e;
    }
    // Leaves first: a refuting leaf costs no recursion.
    const dead = x.leaves.find((l) => l.result === 'dead');
    if (dead !== undefined) return fail(false, INF, only('death'), [this.opts.labeler.killCause(dead.successor.last, this.turnOf(belief, dead.from))], true);
    const raw = x.leaves.find((l) => l.result === 'unlabelled');
    if (raw !== undefined) return fail(false, INF, only('unmodelled'), [this.unmodelledText(belief, raw)], false);
    for (const leaf of x.leaves) {
      const missed = leaf.result === 'win' ? this.missedThreshold(leaf.successor) : null;
      if (missed !== null) return fail(false, INF, only('threshold'), [missed], true);
    }
    // At least `step` even with no leaf and no child (every successor dropped by `keep`): the turn is still played, so
    // the entry is never reused at a turnChoice belief with no turns left, which is a cut-off.
    const step = x.turnConsumed ? 1 : 0;
    let depth = step;
    for (const child of orderChildren(x.children)) {
      const r = this.prove(child.belief, h - step);
      if (r.kind === 'unknown') return r;
      if (r.kind === 'fail') {
        // The whole settled path's labels (as plan.ts labels its branches): an enemy replacement at the end of the turn
        // must not hide the turn's crit or roll.
        const { representative: s } = child;
        const label = this.opts.labeler.outcome({ ...s.last, labels: s.labels });
        return label === '' ? r : { ...r, refutation: [label, ...r.refutation] };
      }
      depth = Math.max(depth, step + (child.belief.fight === belief.fight ? r.depth : 0));
    }
    return { kind: 'win', depth };
  }

  private cutOff(): Fail {
    return fail(true, INF, only('horizon'), [`horizon: not won within ${this.H} turns`], false);
  }

  /**
   * The node check's condition, as the arena's `stop`: the live deadline has passed (first, as at a node) or the signal
   * is aborted. It records which in stopCause, so a stopped expansion needs no second clock reading.
   */
  private stopped(): boolean {
    if (this.opts.now() > this.deadline) this.stopCause = 'timeout';
    else if (this.opts.signal?.aborted === true) this.stopCause = 'aborted';
    else return false;
    return true;
  }

  /** The extraction's `stop` (expansion()): the signal only, never the deadline; recorded as stopped() records. */
  private aborted(): boolean {
    if (this.opts.signal?.aborted !== true) return false;
    this.stopCause = 'aborted';
    return true;
  }

  /** Every choice legal for the whole belief (only restrictRoot's at the root), ordered. */
  private choicesAt(belief: Belief): Choice[] {
    let choices = beliefChoices(this.arena, belief);
    const restrict = this.opts.restrictRoot;
    if (restrict !== undefined && belief.key === this.rootKey) {
      const allowed = new Set(restrict.map(choiceText));
      choices = choices.filter((c) => allowed.has(choiceText(c)));
    }
    return orderChoices(belief, choices, this.opts.history, this.opts.orderHint);
  }

  /** The turn an outcome of `belief`'s choice happens on, for kill-cause text. */
  private turnOf(belief: Belief, from: Member): number {
    return from.turnsInFight + (belief.phase === 'turnChoice' ? 1 : 0);
  }

  private choiceLabel(belief: Belief, choice: Choice): string {
    return actionLabel(this.arena, this.opts.labeler, belief, choice);
  }

  private unmodelledText(belief: Belief, leaf: BeliefLeaf): string {
    if (leaf.successor.note !== undefined) return `unmodelled: ${leaf.successor.note}`;
    if (belief.phase === 'entry') return `unmodelled: unlabelled outcome at the start of fight ${belief.fight + 1}`;
    return `unmodelled: unlabelled outcome on turn ${this.turnOf(belief, leaf.from)}`;
  }

  /** null when the win leaf meets every threshold, else why not. */
  private missedThreshold(s: Successor): string | null {
    const t = this.params.thresholds;
    if (t === null) return null;
    if (s.endCarry === null) throw new Error('prove: a win leaf without an end carry');
    const m = this.arena.metrics(s.endCarry);
    if (t.minHpFrac !== undefined && !passes(cmp(m.minHpFrac, t.minHpFrac.value), t.minHpFrac.strict)) {
      return `threshold: lowest HP fraction ${toJson(m.minHpFrac)}, needs ${relation(t.minHpFrac.strict)} ${toJson(t.minHpFrac.value)}`;
    }
    if (t.totalHp !== undefined && !passes(m.totalHp - t.totalHp.value, t.totalHp.strict)) {
      return `threshold: total HP ${m.totalHp}, needs ${relation(t.totalHp.strict)} ${t.totalHp.value}`;
    }
    if (t.pp !== undefined && !passes(m.pp - t.pp.value, t.pp.strict)) {
      return `threshold: PP ${m.pp}, needs ${relation(t.pp.strict)} ${t.pp.value}`;
    }
    return null;
  }
}
