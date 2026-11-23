// Ranking proven lines: the lexicographic ranking uses threshold proofs. Every improvement is proven
// ("guarantee at least k"), never estimated. Thresholds change the game, so each threshold game gets a fresh Prover (no
// table is shared between games; the history map is, for ordering only), and so does each restricted root choice.
//
// Keys, in the ranking's order: the tier-2 keys (critBudget, critDeathProbability) are skipped, a repeated key counts
// once, and chanceDependencies is applied last wherever it sits.
// - worstMinHp, totalHp, pp: strict improvement. With v the current line's figure (certificateStats), prove the game
//   "the fixed thresholds, and this figure > v" at the current horizon. A win's certificate is the new line (its figure
//   is above v) and the key is tried again; a failure fixes the key at >= v.
// - turns: the shortest per-fight horizon at which the fixed thresholds still hold, deepening from 1 up to the current
//   horizon on one prover (Prover.deepen's loop, kept here to see each failure's reasons); its win is the new line and
//   its horizon the current one.
// - chanceDependencies: each root choice (restrictRoot's only) proven alone under the final thresholds at the current
//   horizon; the line with the fewest chance dependencies is kept, the current line first, so a tie keeps the earlier.
// A fixed key's figure cannot change afterwards: every later line meets its threshold, and a better figure was refuted
// within a horizon at least as long.
//
// Result. The certificate carries the fixed thresholds (relabelled when it was proven under others: its figures meet
// them), so the checker verifies them; whether a better line exists is the solver's claim, which the checker does not
// verify. `complete` is false when the deadline or an abort stopped the ranking: an unknown in a proof, or an
// extraction stopped while it re-proves a belief (the deadline or the signal) or expands one (the signal only: the
// extraction of a line already found never stops at the deadline). The provers hand their deadline and the signal to
// every engine step of their own proving. The best line so far is returned, still a proof, with only the keys
// fixed so far. It is also false when a refutation met an engine LIMIT or an unmodelled outcome (an unlabelled
// outcome, an AI error; prove.ts: such a failure is unproven, never refuted): the key is fixed as usual, but a better
// line may exist that just was not shown safe. And a held proof is never thrown away: when the turns step cannot
// reproduce the current line within the current horizon (a refutation without a horizon cut-off below it, or no horizon
// up to it wins: a prover or caller bug), the line is kept and the ranking stops there, incomplete. `stopped` says why,
// each reason once in the order met: 'the time limit', 'a cancel', 'a refutation met an engine limit', 'a refutation
// met an unmodelled outcome', 'the turns step could not reproduce the line' (solve.ts names them in the report).

import type { Choice, Rational } from '../contracts/engine.js';
import type { RankKey } from '../contracts/solver.js';
import type { Arena } from './arena.js';
import { beliefChoices, type Belief } from './belief.js';
import { certificateStats, extractProof, type Certificate, type CertificateStats } from './certificate.js';
import { choiceText } from './keys.js';
import { Prover, type ProofResult } from './prove.js';
import { cmp, percent, rat, toJson } from './rational.js';
import type { Level, ObservationMode, OrderHint, PlanLabeler, Thresholds } from './types.js';

export interface RankVector { minHpFrac: Rational; totalHp: number; pp: number; turns: number; chanceDependencies: number }
export interface RankResult {
  certificate: Certificate; vector: RankVector; thresholds: Thresholds; horizon: number;
  rank: Partial<Record<RankKey, string>>;   // worstMinHp "37/120 (30.83%)", totalHp "412", pp "57", turns "4", chanceDependencies "3"
  complete: boolean;                         // false when the deadline (or an abort) stopped the ranking early, a refutation met an engine LIMIT or an unmodelled outcome, or the turns step could not reproduce the current line (the result is still a valid proof)
  stopped: string[];                         // why it is not complete (see the top of the file); [] when complete
}
export interface RankOptions {
  ranking: readonly RankKey[]; level: Level; mode: ObservationMode; deadline: number; now: () => number;
  signal?: AbortSignal; labeler: PlanLabeler; history: Map<string, Choice>; orderHint?: OrderHint; onNode?: () => void; restrictRoot?: Choice[];
}

/** The keys a tier-1 ranking applies (the others are tier 2's). */
type AppliedKey = Exclude<RankKey, 'critBudget' | 'critDeathProbability'>;
type ThresholdKey = Exclude<AppliedKey, 'turns' | 'chanceDependencies'>;
type Fail = Extract<ProofResult, { kind: 'fail' }>;

/** A proven line: its certificate and that certificate's figures. */
interface Line { certificate: Certificate; stats: CertificateStats }

const isApplied = (k: RankKey): k is AppliedKey => k !== 'critBudget' && k !== 'critDeathProbability';

const CANNOT_REPRODUCE = 'the turns step could not reproduce the line';

/** The keys applied, in order: tier-2 keys dropped, each key once, chanceDependencies last. */
function appliedKeys(ranking: readonly RankKey[]): AppliedKey[] {
  const keys = [...new Set(ranking)].filter(isApplied);
  return [...keys.filter((k) => k !== 'chanceDependencies'), ...keys.filter((k) => k === 'chanceDependencies')];
}

const order = (x: number, y: number): number => (x < y ? -1 : x > y ? 1 : 0);

/** < 0 when `a` ranks better on the key: higher HP fraction, total HP and PP; fewer turns and chance dependencies. */
const COMPARE: Record<AppliedKey, (a: RankVector, b: RankVector) => number> = {
  worstMinHp: (a, b) => cmp(b.minHpFrac, a.minHpFrac),
  totalHp: (a, b) => order(b.totalHp, a.totalHp),
  pp: (a, b) => order(b.pp, a.pp),
  turns: (a, b) => order(a.turns, b.turns),
  chanceDependencies: (a, b) => order(a.chanceDependencies, b.chanceDependencies),
};

const TEXT: Record<AppliedKey, (v: RankVector) => string> = {
  worstMinHp: (v) => {
    const f = rat(v.minHpFrac.num, v.minHpFrac.den);
    return `${toJson(f)} (${percent(f)})`;
  },
  totalHp: (v) => String(v.totalHp),
  pp: (v) => String(v.pp),
  turns: (v) => String(v.turns),
  chanceDependencies: (v) => String(v.chanceDependencies),
};

/** < 0 when `a` ranks better: the applied keys of `ranking` in order (chanceDependencies last); others are ignored. */
export function compareRank(a: RankVector, b: RankVector, ranking: readonly RankKey[]): number {
  for (const key of appliedKeys(ranking)) {
    const c = COMPARE[key](a, b);
    if (c !== 0) return c;
  }
  return 0;
}

/** The key's threshold at the line's figure. */
function bound(key: ThresholdKey, s: CertificateStats, strict: boolean): Thresholds {
  switch (key) {
    case 'worstMinHp': return { minHpFrac: { value: s.minHpFrac, strict } };
    case 'totalHp': return { totalHp: { value: s.totalHp, strict } };
    case 'pp': return { pp: { value: s.pp, strict } };
  }
}

/** One ranking in progress (see the top of the file). */
class Ranking {
  private line: Line;
  /** The current per-fight horizon: every proof is made within it. */
  private horizon: number;
  /** The fixed keys. Replaced, never mutated: provers and certificates hold the objects they were given. */
  private fixed: Thresholds = {};
  /** Why the ranking is not complete, each reason once, in the order met (empty: complete). */
  private readonly stopped = new Set<string>();

  constructor(private readonly arena: Arena, private readonly root: Belief, base: { certificate: Certificate; horizon: number },
    private readonly opts: RankOptions) {
    this.line = { certificate: base.certificate, stats: certificateStats(arena, base.certificate) };
    this.horizon = base.horizon;
  }

  /** Applies the keys in order, stopping incomplete at the first one cut short (see `apply`; it records why). */
  run(keys: readonly AppliedKey[]): void {
    for (const key of keys) {
      if (!this.apply(key)) return;
    }
  }

  result(ranking: readonly RankKey[]): RankResult {
    const thresholds: Thresholds = { ...this.fixed };
    const wanted = Object.keys(thresholds).length === 0 ? null : thresholds;
    const own = this.line.certificate;
    const certificate = wanted === null && own.thresholds === null ? own : { ...own, thresholds: wanted };
    const s = this.line.stats;
    const vector: RankVector = { minHpFrac: s.minHpFrac, totalHp: s.totalHp, pp: s.pp, turns: s.turns, chanceDependencies: s.chanceDependencies };
    const rank: Partial<Record<RankKey, string>> = {};
    for (const key of appliedKeys(ranking)) rank[key] = TEXT[key](vector);
    return { certificate, vector, thresholds, horizon: certificate.horizon, rank, complete: this.stopped.size === 0, stopped: [...this.stopped] };
  }

  /** Records why the ranking stops; always false (the callers' "stop here"). */
  private stop(why: string): false {
    this.stopped.add(why);
    return false;
  }

  /** A deadline or an abort stopped a proof or an extraction. */
  private timeUp(cause: 'timeout' | 'aborted'): false {
    return this.stop(cause === 'aborted' ? 'a cancel' : 'the time limit');
  }

  /** false when the deadline or an abort stopped it, or the turns step could not reproduce the current line. */
  private apply(key: AppliedKey): boolean {
    switch (key) {
      case 'worstMinHp': case 'totalHp': case 'pp': return this.improve(key);
      case 'turns': return this.shortest();
      case 'chanceDependencies': return this.fewestDependencies();
    }
  }

  private improve(key: ThresholdKey): boolean {
    for (;;) {
      const prover = this.prover({ ...this.fixed, ...bound(key, this.line.stats, true) });
      const r = this.proveAt(prover);
      if (r.kind === 'unknown') return this.timeUp(r.cause);
      if (r.kind === 'fail') {
        this.fixed = { ...this.fixed, ...bound(key, this.line.stats, false) };
        this.noteUnproven(r);
        return true;
      }
      const line = this.extract(prover, this.horizon);
      if (line === null) return false;
      this.line = line;
    }
  }

  private shortest(): boolean {
    const prover = this.prover(this.gameThresholds());
    prover.setRoot(this.root);
    for (let h = 1; h <= this.horizon; h++) {
      prover.H = h;
      const r = prover.prove(this.root, h);
      if (r.kind === 'unknown') return this.timeUp(r.cause);
      if (r.kind === 'fail') {
        this.noteUnproven(r);
        if (r.horizon) continue;
        // Refuted without a cut-off below a horizon the current line wins within: the line stays (never discard a held
        // proof) and the ranking stops, incomplete.
        return this.stop(CANNOT_REPRODUCE);
      }
      const line = this.extract(prover, h);
      if (line === null) return false;
      this.line = line;
      this.horizon = h;
      return true;
    }
    // No win up to the current horizon, yet the current line meets the fixed thresholds within it: likewise kept.
    return this.stop(CANNOT_REPRODUCE);
  }

  private fewestDependencies(): boolean {
    const thresholds = this.gameThresholds();
    for (const a of this.rootChoices()) {
      const prover = this.prover(thresholds, [a]);
      const r = this.proveAt(prover);
      if (r.kind === 'unknown') return this.timeUp(r.cause);
      if (r.kind === 'fail') {
        this.noteUnproven(r);
        continue;
      }
      const line = this.extract(prover, this.horizon);
      if (line === null) return false;
      if (line.stats.chanceDependencies < this.line.stats.chanceDependencies) this.line = line;
    }
    return true;
  }

  /** The root's legal choices, restrictRoot's only. */
  private rootChoices(): Choice[] {
    const choices = beliefChoices(this.arena, this.root);
    const only = this.opts.restrictRoot;
    if (only === undefined) return choices;
    const keep = new Set(only.map(choiceText));
    return choices.filter((c) => keep.has(choiceText(c)));
  }

  /** A fresh prover for the tier-1 game with these thresholds, the caller's clock and ordering. */
  private prover(thresholds: Thresholds | null, restrictRoot: Choice[] | undefined = this.opts.restrictRoot): Prover {
    const o = this.opts;
    return new Prover(this.arena, {
      params: { level: o.level, critBudget: null, thresholds }, mode: o.mode, deadline: o.deadline, now: o.now, signal: o.signal,
      labeler: o.labeler, history: o.history, orderHint: o.orderHint, onNode: o.onNode, restrictRoot,
    });
  }

  private proveAt(prover: Prover): ProofResult {
    prover.setRoot(this.root);
    prover.H = this.horizon;
    return prover.prove(this.root, this.horizon);
  }

  /** The fixed thresholds as a game parameter (a copy; null when none is fixed). */
  private gameThresholds(): Thresholds | null {
    return Object.keys(this.fixed).length === 0 ? null : { ...this.fixed };
  }

  /**
   * The prover's line at `h`; null (the reason recorded) when the deadline or an abort stopped re-proving a belief, or
   * an abort stopped expanding one (extractProof throws then).
   */
  private extract(prover: Prover, h: number): Line | null {
    let certificate: Certificate;
    try {
      certificate = extractProof(prover, this.root, h);
    } catch (e) {
      const cause = this.opts.signal?.aborted === true ? 'aborted' : this.opts.now() > this.opts.deadline ? 'timeout' : null;
      if (cause === null) throw e;
      this.timeUp(cause);
      return null;
    }
    return { certificate, stats: certificateStats(this.arena, certificate) };
  }

  /** A refutation that met an engine LIMIT or an unmodelled outcome is unproven: a better line may exist. */
  private noteUnproven(r: Fail): void {
    if (r.reasons.engineLimit) this.stopped.add('a refutation met an engine limit');
    if (r.reasons.unmodelled) this.stopped.add('a refutation met an unmodelled outcome');
  }
}

/**
 * Ranks the proven line `base` lexicographically by `ranking` (see the top of the file). `base.certificate` is a tier-1
 * proof from `root` (the fight-0 entry) at the ranking's level and mode, in the game restrictRoot describes, within
 * `base.horizon` turns per fight (its own horizon may be shorter); the ranking proves within `base.horizon`. Throws
 * RangeError for a bad horizon and Error for a base that is not such a proof.
 */
export function rankProven(arena: Arena, root: Belief, base: { certificate: Certificate; horizon: number }, opts: RankOptions): RankResult {
  const { certificate, horizon } = base;
  if (!Number.isInteger(horizon) || horizon < 1) throw new RangeError(`rank: horizon must be a positive integer, got ${horizon}`);
  if (certificate.kind !== 'proof' || certificate.critBudget !== null || certificate.level !== opts.level || certificate.mode !== opts.mode
    || certificate.horizon > horizon) {
    throw new Error(`rank: the base must be a tier-1 proof at level ${opts.level} in ${opts.mode} mode within ${horizon} turns`);
  }
  const ranking = new Ranking(arena, root, base, opts);
  ranking.run(appliedKeys(opts.ranking));
  return ranking.result(opts.ranking);
}
