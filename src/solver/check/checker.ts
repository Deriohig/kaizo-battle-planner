// The independent checker. Nothing is called safe until a certificate replays here. The checker
// trusts no search code: it imports only the contracts, exact arithmetic, the shared formats (edge labels, how a fight's
// battle is built) and the certificate's type, and it re-implements the step itself, small and plain. arena.ts is the
// reference semantics it must agree with.
//
// Walk. From node 0 (fight 0's entry) in every world of fight 0, one exact member at a time. At a node, its action must
// be legal (a living lead at an entry, else one of legalChoices(p1)). The player's turn choice meets the AI's support (level 1)
// or every legal enemy action at 1/n (level 2); supports must have every probability > 0 and sum to exactly 1. Each
// engine step's outcomes must sum to exactly 1, and each outcome goes through the damage and order oracles (the hits the
// damage oracle names as not cross-checked, its `skipped`, are summed per move like its checks). Settling an
// outcome, as the arena does: fainted.p1 non-empty → death; unlabelled → unproven; then by the next phase:
// playerReplacement or terminal p2 → death; terminal p1 → a win in the last fight, else the next fight's entry (the
// fight marker appended; after healBefore no carry is passed on and inputs.ts builds that battle from the healed carry,
// never from no carry); enemyReplacement / enemyMidTurnSwitch → the AI's replacement
// support (or every legal enemy action), one more step each; turnChoice / playerMidTurnSwitch → the player's next decision,
// whose edge label (edge.ts) leads to the next node. A turnChoice reached with the fight's horizon used up is a cut-off
// and needs no node. Level 1 folds every outcome into the AI memory with `remember`; level 2 keeps an empty memory.
// unmodelledIn() at every state reached, unlabelled outcomes, an engine UNMODELLED_ITEM at battle start and an AI error
// with a string code (any AiError: UNDEFINED, DIV_ZERO, …; 'undefined AI behaviour: <code>: <message>') are
// unmodelled. An engine BAD_CHOICE from a step is a mismatch ('engine rejected choice …'); an engine LIMIT fails that
// path with reason engineLimit; an AI error without a string code and any other engine error propagate.
// Stopping: every engine step gets expandTurn's shouldStop, true once the checker's deadline has
// passed or its signal is aborted, and so does the oracles' step context (an oracle that runs its own engine step hands
// it on). An engine STOPPED, from a step or from an oracle, ends the walk as the deadline at a decision does: the
// check is cut short (a timeout), never a mismatch and never an engine limit.
// Proof certificates: a death, an unlabelled outcome or a cut-off on a path with at most critBudget enemy-crit steps
// (every path when critBudget is null), and a win leaf below the thresholds, are mismatches. With a budget j the walk
// drops every successor past j crit steps, as the prover did (no node, no check, no figure). Risk certificates are
// walked in full.
// Crit steps: one per settled step (the player's decision to the next) with critBy.p2 in any of its engine steps; members
// carry them capped at critBudget + 1 when the certificate has a budget, else 0 (RAM edges and the memo include them).
//
// Memo: sha256 of the state's bytes, the AI memory key, the node, the capped crits, the fight, the lead and the turns
// used (figures depend on all of them), never state.key. An on-path revisit (the same key without the turns) is a cycle.
// The bytes are hashed with every wall-clock `|t:|<digits>` (Showdown's protocol time line) blanked to `|t:|`: the engine
// already blanks them (docs/solver-integration.md), and a state met in two different seconds is still the same state, so
// the walk, its counts and its cycle check never depend on the clock.
//
// Figures, exact and computed in the same walk: failure (a death, an unlabelled outcome, a cut-off, and conservatively
// any mismatch, missing node or engine limit that stops a path) by expectation over chance and the AI's distribution
// (failureAi) or with the AI's worst supported action at every AI node (failureWorst); the cut-off part of failureAi;
// the fewest crit steps on a failing path (by minimisation); the worst win leaf; the most turns played in a fight; and
// death causes (labeler.killCause, the turn being the fight's turns used before the step + 1 at a turnChoice) summed per
// cause under the AI's distribution, each with the label path where it was first met. At every fight's entry the worst
// world is taken (the adversary may pick per branch): the one with the most failureAi (on a tie the least of it cut off,
// then the first) gives failureAi, cutoffAi and the killers; failureWorst, the crit steps, the worst end and the turns
// are the worst over every world.

import { createHash } from 'node:crypto';
import type { ActionSupport, AiMemory, EnemyModel } from '../../contracts/ai.js';
import type { CarryState, Choice, Engine, EngineState, Outcome, Rational } from '../../contracts/engine.js';
import type { KillBranch } from '../../contracts/solver.js';
import type { Certificate, CertNode } from '../certificate.js';
import { edgeLabel, fightMarker, ramEdgeKey } from '../edge.js';
import { battleInput, startCarry, toCanonicalCarry, type ArenaFight } from '../inputs.js';
import { add, cmp, eq, maxR, minR, mul, ONE, rat, sum, toJson, ZERO } from '../rational.js';
import type { DamageOracle, DecisionPhase, OracleResult, PlanLabeler, SpeedOracle, StepContext } from '../types.js';

export interface CheckInput {
  certificate: Certificate; fights: ArenaFight[];
  engine: Engine; enemyModel: EnemyModel;
  oracles: { damage: DamageOracle; speed: SpeedOracle };
  labeler: PlanLabeler; killerLimit: number;
  deadline: number; now: () => number; signal?: AbortSignal; maxLeaves?: number;
}

export interface CheckResult {
  passed: boolean;
  reason?: 'verificationMismatch' | 'unmodelled' | 'timeout' | 'engineLimit';
  mismatches: string[];                    // at most 50, each with the path that led there
  unmodelled: string[];                    // unmodelledIn() entries seen, unlabelled outcomes, undefined AI behaviour
  damageChecks: number; orderChecks: number; statesVisited: number; worlds: number;
  notCrossChecked: Record<string, number>; // move display name → hits the damage oracle skipped (its `skipped`), keys sorted
  // exact figures of the fixed strategy, each maximised over worlds (failure = death, unlabelled, or a horizon cut-off)
  failureAi: Rational;                     // under the AI's distribution
  failureWorst: Rational;                  // the AI picking its worst supported action at every AI node
  cutoffAi: Rational;                      // the cut-off part of failureAi
  critBudget: number | null;               // null: no failing path; else (fewest enemy-crit steps on any failing path) − 1 (−1: fails without crits)
  worstEnd: { minHpFrac: Rational; totalHp: number; pp: number } | null;  // worst case over win leaves; null when none
  maxTurns: number;
  killers: KillBranch[];                   // death causes in the worst world, probabilities summed per cause under the AI distribution, largest first, at most killerLimit
  endStates: { fight: number; carry: CarryState }[];   // distinct canonical carries entering each later fight (gauntlets)
}

const MAX_MISMATCHES = 50;
const NO_MEMORY: AiMemory = Object.freeze({ key: '', data: null });

interface EndFigures { minHpFrac: Rational; totalHp: number; pp: number }
interface Killer { probability: Rational; path: string[] }

/** A subtree's figures, conditional on reaching its root. Never mutated once built. */
interface Figures {
  failAi: Rational; failWorst: Rational; cutAi: Rational;
  crits: number;                     // fewest crit steps on a failing path below; +∞ without one
  end: EndFigures | null;            // the worst win leaf below; null without one
  turns: number;                     // the most turns played in one fight below
  killers: ReadonlyMap<string, Killer>;
}

/** No failure, no win leaf: a dropped subtree, or the identity of `weigh`. */
const NOTHING: Figures = { failAi: ZERO, failWorst: ZERO, cutAi: ZERO, crits: Number.POSITIVE_INFINITY, end: null, turns: 0, killers: new Map() };

function failure(cut: boolean): Figures {
  return { failAi: ONE, failWorst: ONE, cutAi: cut ? ONE : ZERO, crits: 0, end: null, turns: 0, killers: new Map() };
}

function worseEnd(a: EndFigures | null, b: EndFigures | null): EndFigures | null {
  if (a === null) return b;
  if (b === null) return a;
  return { minHpFrac: minR(a.minHpFrac, b.minHpFrac), totalHp: Math.min(a.totalHp, b.totalHp), pp: Math.min(a.pp, b.pp) };
}

/**
 * Children weighted by `p`: failAi, cutAi and the killers add up; failWorst adds up at chance and is the maximum at an AI
 * node (its worst supported action); crit steps take the minimum, the end the worst, turns the maximum.
 */
function weigh(parts: { p: Rational; f: Figures }[], aiNode: boolean): Figures {
  let failAi = ZERO;
  let failWorst = ZERO;
  let cutAi = ZERO;
  let crits = Number.POSITIVE_INFINITY;
  let end: EndFigures | null = null;
  let turns = 0;
  const killers = new Map<string, Killer>();
  for (const { p, f } of parts) {
    failAi = add(failAi, mul(p, f.failAi));
    cutAi = add(cutAi, mul(p, f.cutAi));
    failWorst = aiNode ? maxR(failWorst, f.failWorst) : add(failWorst, mul(p, f.failWorst));
    crits = Math.min(crits, f.crits);
    end = worseEnd(end, f.end);
    turns = Math.max(turns, f.turns);
    for (const [cause, k] of f.killers) {
      const q = mul(p, k.probability);
      const seen = killers.get(cause);
      killers.set(cause, seen === undefined ? { probability: q, path: k.path } : { probability: add(seen.probability, q), path: seen.path });
    }
  }
  return { failAi, failWorst, cutAi, crits, end, turns, killers };
}

/** Worlds are adversarial (see the top of the file). `worlds` is non-empty. */
function worstWorld(worlds: Figures[]): Figures {
  let worst = worlds[0]!;
  for (const f of worlds.slice(1)) {
    const c = cmp(f.failAi, worst.failAi);
    if (c > 0 || (c === 0 && cmp(f.cutAi, worst.cutAi) < 0)) worst = f;
  }
  return {
    failAi: worst.failAi, cutAi: worst.cutAi, killers: worst.killers,
    failWorst: worlds.reduce((m, f) => maxR(m, f.failWorst), ZERO),
    crits: Math.min(...worlds.map((f) => f.crits)),
    end: worlds.reduce<EndFigures | null>((e, f) => worseEnd(e, f.end), null),
    turns: Math.max(...worlds.map((f) => f.turns)),
  };
}

/** JSON with object keys sorted at every level (the carry part of a RAM entry key, and choice comparison). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((k) => [k, sortKeys(record[k])]));
}

/** 'm<slot>', 's<index>', or 'i:' + the canonical JSON of an item choice without `kind`. */
function choiceText(c: Choice): string {
  switch (c.kind) {
    case 'move': return `m${c.slot}`;
    case 'switch': return `s${c.index}`;
    case 'item': {
      const { kind: _kind, ...fields } = c;
      return `i:${canonicalJson(fields)}`;
    }
  }
}

/** 'p1 m0, p2 s1': the choices of one engine step. */
function choicesText(choices: { p1?: Choice; p2?: Choice }): string {
  return (['p1', 'p2'] as const).flatMap((side) => {
    const c = choices[side];
    return c === undefined ? [] : [`${side} ${choiceText(c)}`];
  }).join(', ');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64url');
}

/** Showdown's protocol time line, `|t:|<seconds>`: wall clock, never part of a state (see the top of the file). */
const CLOCK_LINE = /\|t:\|\d+/g;

/** A state's bytes as the memo and the cycle check hash them: every `|t:|<digits>` blanked to `|t:|`. */
function untimed(json: string): string {
  return json.replace(CLOCK_LINE, '|t:|');
}

function codeOf(e: unknown): unknown {
  return typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A battle start as an outcome: the `last` of a path before its first engine step. */
function startOutcome(state: EngineState, observation: string): Outcome {
  return {
    probability: ONE, labels: [], critBy: { p1: false, p2: false }, unlabelled: false, state, observation, log: [],
    fainted: { p1: [], p2: [] }, merged: 1,
  };
}

/** One settled step in progress: the observations since the player's decision, an enemy crit so far, the last engine outcome, and the labels from the root. */
interface Path { observations: string[]; crit: boolean; last: Outcome | null; trail: string[] }

/** One of the player's decisions being played. `turns`: the fight's turns used once this step is played (kill causes name it). */
interface Play { node: CertNode; fight: number; lead: number; crits: number; turns: number }

/** Arriving at a battle decision: the node, the member (state, memory, capped crits) and the turns used so far. */
interface Arrival { id: number; fight: number; lead: number; state: EngineState; memory: AiMemory; crits: number; turns: number; trail: string[] }

/** The deadline passed or the signal aborted. */
class Stop extends Error {}

class Walk {
  readonly mismatches: string[] = [];
  readonly unmodelled = new Set<string>();
  readonly notCrossChecked = new Map<string, number>();
  damageChecks = 0;
  orderChecks = 0;
  statesVisited = 0;
  engineLimit = false;
  private readonly entered = new Map<string, { fight: number; carry: CarryState }>();
  private readonly memo = new Map<string, Figures>();
  private readonly onPath = new Set<string>();
  private readonly cert: Certificate;
  private readonly proof: boolean;
  private readonly critCap: number | null;    // members' crit steps are capped here (critBudget + 1); null: always 0
  private readonly dropPast: number | null;   // a proof with a crit budget: successors past it are not walked

  constructor(private readonly input: CheckInput) {
    this.cert = input.certificate;
    this.proof = this.cert.kind === 'proof';
    const j = this.cert.critBudget;
    this.critCap = j === null ? null : j + 1;
    this.dropPast = this.proof ? j : null;
  }

  run(): Figures {
    const { fights } = this.input;
    if (fights.length === 0) throw new Error('checker: no fights');
    if (this.cert.fights !== fights.length) this.mismatch(`the certificate covers ${this.cert.fights} fight(s), the input has ${fights.length}`, []);
    return this.entry(0, null, 0, 0, []);
  }

  /** The carries entering later fights, distinct, by fight then canonical JSON. */
  endStates(): { fight: number; carry: CarryState }[] {
    return [...this.entered.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e);
  }

  private mismatch(text: string, trail: string[]): void {
    if (this.mismatches.length < MAX_MISMATCHES) this.mismatches.push(`${text} (path: ${trail.length === 0 ? 'the root' : trail.join(' → ')})`);
  }

  /** Counts a visit; throws Stop past the deadline or on abort. */
  private tick(): void {
    if (this.shouldStop()) throw new Stop('checker: stopped');
    this.statesVisited += 1;
  }

  /** The deadline has passed or the signal is aborted: tick's test, and every engine step's shouldStop (see the top of the file). */
  private readonly shouldStop = (): boolean => this.input.now() > this.input.deadline || this.input.signal?.aborted === true;

  private nodeAt(id: number, trail: string[]): CertNode | null {
    const node = this.cert.nodes[id];
    if (node === undefined) this.mismatch(`no node ${id}`, trail);
    return node ?? null;
  }

  /** The node `label` leads to from `node`; null (a mismatch) when the certificate has no edge for it. */
  private edge(node: CertNode, label: string, trail: string[]): number | null {
    if (Object.hasOwn(node.edges, label)) return node.edges[label]!;
    this.mismatch(`no policy for observation ${JSON.stringify(label)} at node ${node.id}`, trail);
    return null;
  }

  private critsAfter(crits: number, crit: boolean): number {
    return this.critCap === null ? 0 : Math.min(crits + (crit ? 1 : 0), this.critCap);
  }

  /** Fight `fight`'s entry at node `id`, from `carry` (canonical; null = fresh): the lead, then every world. */
  private entry(fight: number, carry: CarryState | null, crits: number, id: number, trail: string[]): Figures {
    const node = this.nodeAt(id, trail);
    if (node === null) return failure(false);
    if (node.phase !== 'entry' || node.fight !== fight) {
      this.mismatch(`node ${id} is fight ${node.fight} at ${node.phase}, but the walk is at fight ${fight}'s entry`, trail);
      return failure(false);
    }
    const key = `E|${fight}|${crits}|${id}|${sha256(canonicalJson(carry))}`;
    const known = this.memo.get(key);
    if (known !== undefined) return known;
    this.tick();
    const figures = this.startFight(node, fight, carry, crits, trail);
    this.memo.set(key, figures);
    return figures;
  }

  private startFight(node: CertNode, fight: number, carry: CarryState | null, crits: number, trail: string[]): Figures {
    const { engine, enemyModel } = this.input;
    const f = this.input.fights[fight]!;
    const hps = startCarry(f, carry).mons.map((m) => m.hp);
    const action = node.action;
    const lead = action.kind === 'switch' ? action.index : -1;
    if (!((hps[lead] ?? 0) > 0)) {
      this.mismatch(`illegal action ${canonicalJson(action)} at node ${node.id}: not a living lead`, trail);
      return failure(false);
    }
    if (f.info.worlds.length === 0) {
      this.mismatch(`fight ${fight} has no worlds`, trail);
      return failure(false);
    }
    const play: Play = { node, fight, lead, crits, turns: 0 };
    const start: Path = { observations: [], crit: false, last: null, trail: [...trail, `Lead with ${f.team[lead]!.label}`] };
    return worstWorld(f.info.worlds.map((world) => {
      let state: EngineState;
      try {
        state = engine.createBattle(battleInput(f, lead, carry, world));
      } catch (e) {
        if (codeOf(e) === 'UNMODELLED_ITEM') return this.unlabelled(play, start, `unmodelled item at the start of fight ${fight + 1}: ${messageOf(e)}`);
        if (codeOf(e) === 'LIMIT') return this.limit(play, start);
        throw e;
      }
      if (fight > 0) {
        const entering = toCanonicalCarry(engine.carryOut(state), lead);
        this.entered.set(`${String(fight).padStart(6, '0')}|${canonicalJson(entering)}`, { fight, carry: entering });
      }
      const memory = this.cert.level === 1 ? enemyModel.initialMemory(state) : NO_MEMORY;
      const observation = engine.observe(state);
      return this.settle(play, state, memory, { ...start, observations: [observation], last: startOutcome(state, observation) });
    }));
  }

  /** A battle decision at node `at.id`, memoised (see the top of the file). */
  private decision(at: Arrival): Figures {
    const node = this.nodeAt(at.id, at.trail);
    if (node === null) return failure(false);
    const onPath = `${at.fight}|${at.lead}|${at.crits}|${at.id}|${sha256(untimed(at.state.json))}|${at.memory.key}`;
    const key = `${at.turns}|${onPath}`;
    const known = this.memo.get(key);
    if (known !== undefined) return known;
    if (this.onPath.has(onPath)) {
      this.mismatch(`cycle: node ${at.id} meets an exact state again on its own path`, at.trail);
      return failure(false);
    }
    this.tick();
    this.onPath.add(onPath);
    let figures: Figures;
    try {
      figures = this.play(node, at);
    } finally {
      this.onPath.delete(onPath);
    }
    this.memo.set(key, figures);
    return figures;
  }

  private play(node: CertNode, at: Arrival): Figures {
    const kind = at.state.phase.kind;
    if (node.phase !== kind || node.fight !== at.fight) {
      this.mismatch(`node ${node.id} is fight ${node.fight} at ${node.phase}, but the walk is at fight ${at.fight} ${kind}`, at.trail);
      return failure(false);
    }
    const action = node.action;
    const text = canonicalJson(action);
    if (!this.input.engine.legalChoices(at.state, 'p1').some((c) => canonicalJson(c) === text)) {
      this.mismatch(`illegal action ${text} at node ${node.id}`, at.trail);
      return failure(false);
    }
    const turnChoice = kind === 'turnChoice';
    const play: Play = { node, fight: at.fight, lead: at.lead, crits: at.crits, turns: at.turns + (turnChoice ? 1 : 0) };
    const path: Path = { observations: [], crit: false, last: null, trail: [...at.trail, this.input.labeler.choice(at.state, 'p1', action)] };
    const figures = turnChoice
      ? this.enemy(play, at.state, at.memory, 'turn', path, (choice, p) => this.step(play, at.state, { p1: action, p2: choice }, at.memory, p))
      : this.step(play, at.state, { p1: action }, at.memory, path);
    return { ...figures, turns: Math.max(figures.turns, play.turns) };
  }

  /** An AI node: its support (level 1) or every legal enemy action at 1/n (level 2), checked; `then` continues each action. */
  private enemy(play: Play, state: EngineState, memory: AiMemory, when: 'turn' | 'replacement', path: Path,
    then: (choice: Choice, path: Path) => Figures): Figures {
    let support: ActionSupport[];
    if (this.cert.level === 2) {
      const legal = this.input.engine.legalChoices(state, 'p2');
      support = legal.map((choice) => ({ choice, probability: rat(1, legal.length) }));
    } else {
      try {
        support = when === 'turn' ? this.input.enemyModel.support(state, memory) : this.input.enemyModel.replacementSupport(state, memory);
      } catch (e) {
        const code = codeOf(e);
        if (typeof code !== 'string') throw e;
        return this.unlabelled(play, path, `undefined AI behaviour: ${code}: ${messageOf(e)}`);
      }
    }
    const what = `enemy ${when} support`;
    if (support.length === 0) {
      this.mismatch(`${what} is empty`, path.trail);
      return this.settled(play, path, () => failure(false));
    }
    for (const a of support) {
      if (cmp(a.probability, ZERO) <= 0) this.mismatch(`${what}: probability ${toJson(a.probability)} for ${canonicalJson(a.choice)}`, path.trail);
    }
    const total = sum(support.map((a) => a.probability));
    if (!eq(total, ONE)) this.mismatch(`${what} sums to ${toJson(total)}, not 1`, path.trail);
    return weigh(support.map((a) => ({
      p: a.probability,
      f: then(a.choice, { ...path, trail: [...path.trail, this.input.labeler.choice(state, 'p2', a.choice)] }),
    })), true);
  }

  /** One engine step from `state`: the outcomes checked (sum, oracles) and each one settled. */
  private step(play: Play, state: EngineState, choices: { p1?: Choice; p2?: Choice }, memory: AiMemory, path: Path): Figures {
    const { engine, enemyModel, labeler, maxLeaves } = this.input;
    let outcomes: Outcome[];
    try {
      outcomes = engine.expandTurn(state, choices, { ...(maxLeaves === undefined ? {} : { maxLeaves }), shouldStop: this.shouldStop });
    } catch (e) {
      if (codeOf(e) === 'STOPPED') throw new Stop('checker: stopped in an engine step');
      if (codeOf(e) === 'LIMIT') return this.limit(play, path);
      if (codeOf(e) === 'BAD_CHOICE') {
        this.mismatch(`engine rejected choice ${choicesText(choices)}: ${messageOf(e)}`, path.trail);
        return this.settled(play, path, () => failure(false));
      }
      throw e;
    }
    const total = sum(outcomes.map((o) => o.probability));
    if (!eq(total, ONE)) this.mismatch(`outcomes sum to ${toJson(total)}, not 1`, path.trail);
    if (outcomes.length === 0) return this.settled(play, path, () => failure(false));
    return weigh(outcomes.map((o) => {
      if (cmp(o.probability, ZERO) <= 0) this.mismatch(`an outcome has probability ${toJson(o.probability)}`, path.trail);
      const trail = [...path.trail, labeler.outcome(o)];
      this.oracles({ before: state, choices, outcome: o }, trail);
      const next: Path = { observations: [...path.observations, o.observation], crit: path.crit || o.critBy.p2, last: o, trail };
      let f: Figures;
      if (o.fainted.p1.length > 0) f = this.dead(play, next);
      else if (o.unlabelled) f = this.unlabelled(play, next, `unlabelled outcome in fight ${play.fight + 1} on turn ${play.turns}`);
      else f = this.settle(play, o.state, this.cert.level === 1 ? enemyModel.remember(memory, o) : memory, next);
      return { p: o.probability, f };
    }), false);
  }

  private oracles(at: Omit<StepContext, 'shouldStop'>, trail: string[]): void {
    const { damage, speed } = this.input.oracles;
    const step: StepContext = { ...at, shouldStop: this.shouldStop };
    let d: OracleResult;
    try {
      d = damage.check(step);
    } catch (e) {
      if (codeOf(e) === 'STOPPED') throw new Stop('checker: stopped in the damage oracle');   // its own engine step (see the top of the file)
      throw e;
    }
    this.damageChecks += d.checks;
    for (const [move, hits] of Object.entries(d.skipped ?? {})) this.notCrossChecked.set(move, (this.notCrossChecked.get(move) ?? 0) + hits);
    for (const m of d.mismatches) this.mismatch(`damage oracle ${damage.id}: ${m}`, trail);
    const s = speed.check(step);
    this.orderChecks += s.checks;
    for (const m of s.mismatches) this.mismatch(`order oracle ${speed.id}: ${m}`, trail);
  }

  /** Classifies `state` (reached on `path`), or runs the enemy's replacement / mid-turn switch first. */
  private settle(play: Play, state: EngineState, memory: AiMemory, path: Path): Figures {
    for (const u of this.input.engine.unmodelledIn(state)) this.unmodelled.add(u);
    const phase = state.phase;
    switch (phase.kind) {
      case 'turnChoice':
      case 'playerMidTurnSwitch':
        return this.arrive(play, state, memory, path, phase.kind);
      case 'playerReplacement':
        return this.dead(play, path);
      case 'terminal':
        return phase.winner === 'p2' ? this.dead(play, path) : this.won(play, state, path);
      case 'enemyReplacement':
      case 'enemyMidTurnSwitch':
        return this.enemy(play, state, memory, 'replacement', path, (choice, p) => this.step(play, state, { p2: choice }, memory, p));
    }
  }

  /** The player's next decision: a cut-off when a turn choice has no turn left, else the node the edge leads to. */
  private arrive(play: Play, state: EngineState, memory: AiMemory, path: Path, phase: DecisionPhase): Figures {
    return this.settled(play, path, () => {
      if (phase === 'turnChoice' && play.turns >= this.cert.horizon) return this.cutoff(path);
      const crits = this.critsAfter(play.crits, path.crit);
      const ram = this.cert.mode === 'ram' ? ramEdgeKey(play.fight, 'battle', state.key, memory.key, crits) : undefined;
      const id = this.edge(play.node, edgeLabel(path.observations, phase, ram), path.trail);
      if (id === null) return failure(false);
      return this.decision({ id, fight: play.fight, lead: play.lead, state, memory, crits, turns: play.turns, trail: path.trail });
    });
  }

  /** A fight won: a win leaf in the last fight (a proof's thresholds checked), else the next fight's entry. */
  private won(play: Play, state: EngineState, path: Path): Figures {
    return this.settled(play, path, () => {
      const { fights, engine } = this.input;
      const carry = toCanonicalCarry(engine.carryOut(state), play.lead);
      const next = play.fight + 1;
      if (next >= fights.length) {
        const end = this.metrics(carry);
        const missed = this.proof ? this.missedThreshold(end) : null;
        if (missed !== null) this.mismatch(missed, path.trail);
        return { ...NOTHING, end };
      }
      const start = fights[next]!.healBefore ? null : carry;
      const crits = this.critsAfter(play.crits, path.crit);
      const observations = [...path.observations, fightMarker(next)];
      const ram = this.cert.mode === 'ram' ? ramEdgeKey(next, 'entry', start === null ? 'fresh' : canonicalJson(start), NO_MEMORY.key, crits) : undefined;
      const id = this.edge(play.node, edgeLabel(observations, 'entry', ram), path.trail);
      return id === null ? failure(false) : this.entry(next, start, crits, id, path.trail);
    });
  }

  /**
   * A settled successor of `play`'s step: past a proof's crit budget it is dropped (not walked, no figures); else
   * `make()`, with this step's enemy crit added to its crit steps.
   */
  private settled(play: Play, path: Path, make: () => Figures): Figures {
    const added = path.crit ? 1 : 0;
    if (this.dropPast !== null && play.crits + added > this.dropPast) return NOTHING;
    const f = make();
    return added === 0 ? f : { ...f, crits: f.crits + added };
  }

  private dead(play: Play, path: Path): Figures {
    return this.settled(play, path, () => {
      if (path.last === null) throw new Error('checker: a death before any engine step');
      const cause = this.input.labeler.killCause(path.last, play.turns);
      if (this.proof) this.mismatch(`death: ${cause}`, path.trail);
      return { ...failure(false), killers: new Map([[cause, { probability: ONE, path: path.trail }]]) };
    });
  }

  private unlabelled(play: Play, path: Path, what: string): Figures {
    return this.settled(play, path, () => {
      this.unmodelled.add(what);
      if (this.proof) this.mismatch(`unproven: ${what}`, path.trail);
      return failure(false);
    });
  }

  private cutoff(path: Path): Figures {
    if (this.proof) this.mismatch(`horizon: not won within ${this.cert.horizon} turns`, path.trail);
    return failure(true);
  }

  /** An engine LIMIT: this path cannot be checked, so it counts as failing and the check does not pass. */
  private limit(play: Play, path: Path): Figures {
    return this.settled(play, path, () => {
      this.engineLimit = true;
      return failure(false);
    });
  }

  /** Of a canonical carry at the end of the last fight: the lowest HP fraction, the HP total and the PP total. */
  private metrics(carry: CarryState): EndFigures {
    const { fights } = this.input;
    const team = fights[fights.length - 1]!.team;
    if (carry.mons.length !== team.length) throw new RangeError(`checker: carry has ${carry.mons.length} mons for a team of ${team.length}`);
    let minHpFrac: Rational | null = null;
    let totalHp = 0;
    let pp = 0;
    for (const [i, m] of carry.mons.entries()) {
      const frac = rat(m.hp, team[i]!.maxHp);
      minHpFrac = minHpFrac === null ? frac : minR(minHpFrac, frac);
      totalHp += m.hp;
      pp += m.pp.reduce((a, b) => a + b, 0);
    }
    return { minHpFrac: minHpFrac ?? ONE, totalHp, pp };
  }

  /** null when a win leaf meets every threshold of the certificate, else why not. */
  private missedThreshold(end: EndFigures): string | null {
    const t = this.cert.thresholds;
    if (t === null) return null;
    const passes = (sign: number, strict: boolean): boolean => (strict ? sign > 0 : sign >= 0);
    const needs = (strict: boolean): string => (strict ? '>' : '>=');
    if (t.minHpFrac !== undefined && !passes(cmp(end.minHpFrac, t.minHpFrac.value), t.minHpFrac.strict)) {
      return `threshold: lowest HP fraction ${toJson(end.minHpFrac)}, needs ${needs(t.minHpFrac.strict)} ${toJson(t.minHpFrac.value)}`;
    }
    if (t.totalHp !== undefined && !passes(end.totalHp - t.totalHp.value, t.totalHp.strict)) {
      return `threshold: total HP ${end.totalHp}, needs ${needs(t.totalHp.strict)} ${t.totalHp.value}`;
    }
    if (t.pp !== undefined && !passes(end.pp - t.pp.value, t.pp.strict)) {
      return `threshold: PP ${end.pp}, needs ${needs(t.pp.strict)} ${t.pp.value}`;
    }
    return null;
  }
}

/** Replays `input.certificate` on the engine in every world and computes its figures (see the top of the file). */
export function checkCertificate(input: CheckInput): CheckResult {
  const walk = new Walk(input);
  let figures: Figures | null = null;
  try {
    figures = walk.run();
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
  }
  const mismatches = [...walk.mismatches];
  const unmodelled = [...walk.unmodelled];
  let reason: CheckResult['reason'];
  if (mismatches.length > 0) reason = 'verificationMismatch';
  else if (unmodelled.length > 0) reason = 'unmodelled';
  else if (walk.engineLimit) reason = 'engineLimit';
  else if (figures === null) reason = 'timeout';
  const f = figures ?? failure(false);   // a walk cut short claims nothing: failure, budget −1, no end
  const killers: KillBranch[] = [...f.killers]
    .map(([cause, k]) => ({ path: k.path, probability: k.probability, cause }))
    .sort((a, b) => cmp(b.probability, a.probability) || (a.cause < b.cause ? -1 : a.cause > b.cause ? 1 : 0))
    .slice(0, Math.max(0, input.killerLimit));
  return {
    passed: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    mismatches, unmodelled,
    damageChecks: walk.damageChecks, orderChecks: walk.orderChecks, statesVisited: walk.statesVisited,
    worlds: input.fights[0]?.info.worlds.length ?? 0,
    notCrossChecked: Object.fromEntries([...walk.notCrossChecked].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    failureAi: f.failAi, failureWorst: f.failWorst, cutoffAi: f.cutAi,
    critBudget: f.crits === Number.POSITIVE_INFINITY ? null : f.crits - 1,
    worstEnd: f.end, maxTurns: f.turns, killers, endStates: walk.endStates(),
  };
}
