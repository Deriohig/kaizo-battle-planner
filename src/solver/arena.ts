// The arena: one settled step for one member. A member is one
// exact battle state plus the AI's memory, or a fight's entry before the player picks the lead. The player's choice gives every
// successor at his next decision: the AND over the AI's support (level 1) or every legal enemy action at weight 1/n
// (level 2), the AND over the engine's outcomes, enemy replacements and mid-turn switches folded in, deaths and wins
// classified, and gauntlet fight transitions built in.
//
// Settling an engine outcome, in this order: fainted.p1 non-empty → dead; unlabelled → unlabelled; then by the next
// phase: playerReplacement or terminal p2 → dead; terminal p1 → win in the last fight, else the next fight's entry
// (fightMarker appended; carry null after healBefore, whose battle battleInput builds from the healed carry);
// turnChoice / playerMidTurnSwitch → continue; enemyReplacement / enemyMidTurnSwitch → one more
// engine step per enemy choice (AND), settled the same way. Level 1 folds every outcome into the AI memory with
// `remember`; level 2 keeps { key: '', data: null }.
// Successor order: the AI support's, then the engine's outcomes', then the replacement support's.
// Stopping: an expansion asked with `stop` (the searching caller's own deadline and signal) polls
// it before each engine step it makes, the turn's, a replacement's or a mid-turn switch's, and hands it to the step as
// expandTurn's `shouldStop`, so the engine stops inside a long step too. Either way the expansion throws
// ArenaStopError, which the caller maps to its own timeout path. An expansion asked without `stop` (a replay after the
// search: renderPlan, a risk line's certificate, certificateStats) never stops. `stop` is not part of the edge cache's
// key, and a stopped expansion is never cached (nor is any expansion that throws).
// Engine errors are recognised by `code` only: LIMIT → ArenaLimitError; STOPPED → ArenaStopError (never an engine
// limit: it says nothing about the step); UNMODELLED_ITEM at battle start → an
// unlabelled successor; everything else (UNSUPPORTED_DOUBLE, BAD_CHOICE…) is rethrown unchanged. An EnemyModel error
// with a string `code` (any AiError: UNDEFINED, DIV_ZERO, and more may follow; the cartridge's behaviour is undefined
// there) makes that AI node one unlabelled successor at the path probability so far, with `note`
// 'undefined AI behaviour: <code>: <message>'; an AI error without a string code is a bug and is rethrown.
// Stats: `expansions`, `leaves`, `chanceKinds` and `supports` (support lists enumerated) count computed expansions;
// `edgeHits` counts cache hits; `nodes` belongs to the prover.

import type { ActionSupport, AiMemory, EnemyModel } from '../contracts/ai.js';
import type { CarryState, ChanceKind, ChanceLabel, Choice, Engine, EngineState, Outcome, Rational } from '../contracts/engine.js';
import { fightMarker, ramEdgeKey } from './edge.js';
import { battleInput, startCarry, toCanonicalCarry, type ArenaFight } from './inputs.js';
import { canonicalJson, choiceText } from './keys.js';
import { eq, minR, mul, ONE, rat, sum } from './rational.js';
import type { DecisionPhase, Level } from './types.js';

export interface Member {
  key: string;                       // ramEdgeKey(fight, kind, state?.key ?? carryKey, memory.key, crits) (edge.ts)
  fight: number; kind: 'entry' | 'battle';
  state: EngineState | null;         // null for entry
  carry: CarryState | null;          // entry: canonical carry from the previous fight, or null for the fight's own start (key 'fresh': healed after healBefore, else the save; inputs.ts startCarry); battle: null
  memory: AiMemory;                  // { key: '', data: null } at entry and at level 2
  crits: number;                     // enemy-crit steps so far, capped at critCap; always 0 when critCap is null
  danger: number;                    // float in [0, 1]: lowest p1 HP fraction (ordering only)
  turnsInFight: number;              // engine turns played in this fight
  lead: number | null;               // canonical team index of this fight's lead; null at entry
}

export interface Successor {
  result: 'continue' | 'win' | 'dead' | 'unlabelled';
  member: Member | null;             // continue: the member at the player's next decision (battle or the next fight's entry)
  phase: DecisionPhase | null;       // continue only
  probability: Rational;             // product of AI-support and outcome probabilities on the settled path
  observations: string[];            // the engine observations on the path, in order (plus fightMarker on a transition)
  aiChoices: Choice[];               // the AI's choices on the path (turn choice, then replacements)
  critsAdded: number;                // 1 when any step on the path had critBy.p2, else 0
  last: Outcome;                     // the last engine outcome on the path (labels, kill cause)
  labels: ChanceLabel[];             // all labels on the path
  endCarry: CarryState | null;       // win: canonical carry at the end of the final fight
  note?: string;                     // unlabelled from an AI error: 'undefined AI behaviour: <code>: <message>'
}

export interface Expansion { successors: Successor[]; turnConsumed: boolean }

export interface SearchStats { nodes: number; expansions: number; leaves: number; edgeHits: number; chanceKinds: Set<ChanceKind>; supports: number }

export function emptyStats(): SearchStats {
  return { nodes: 0, expansions: 0, leaves: 0, edgeHits: 0, chanceKinds: new Set(), supports: 0 };
}

export class ArenaLimitError extends Error {
  constructor(detail: string) {
    super(`engine limit: ${detail}`);
    this.name = 'ArenaLimitError';
  }
}

/** An expansion its `stop` ended (see the top of the file): a timeout or an abort of the caller's, never a limit. */
export class ArenaStopError extends Error {
  constructor(detail: string) {
    super(`engine step stopped: ${detail}`);
    this.name = 'ArenaStopError';
  }
}

/** `stop`: the caller's deadline and signal as one poll (see the top of the file); never part of a cache key. */
type ExpandOpts = { level: Level; critCap: number | null; stop?: () => boolean };

const NO_MEMORY: AiMemory = Object.freeze({ key: '', data: null });

/**
 * The `last` of an unlabelled successor reached before any engine step: a battle that could not be built
 * (UNMODELLED_ITEM, `state` null: an empty placeholder state stands in) or an undefined AI support at the player's turn
 * choice (`state` = that turn's state). Nothing should read a placeholder's state.
 */
function standInOutcome(state: EngineState | null): Outcome {
  return {
    probability: ONE, labels: [], critBy: { p1: false, p2: false }, unlabelled: true,
    state: state ?? { json: '', turn: 0, phase: { kind: 'turnChoice' }, key: '' }, observation: '', log: [], fainted: { p1: [], p2: [] }, merged: 1,
  };
}

/** What a battle start looks like as an outcome: the `last` of an entry's successors. */
function startOutcome(state: EngineState, observation: string): Outcome {
  return {
    probability: ONE, labels: [], critBy: { p1: false, p2: false }, unlabelled: false, state, observation, log: [],
    fainted: { p1: [], p2: [] }, merged: 1,
  };
}

/** A settled path so far. `last` is null only before the first engine step of a battle member's expansion. */
interface Path { probability: Rational; observations: string[]; aiChoices: Choice[]; labels: ChanceLabel[]; crit: boolean; last: Outcome | null }

/** One expansion in progress. */
interface Run { member: Member; lead: number; level: Level; critCap: number | null; stop: (() => boolean) | undefined; turnConsumed: boolean; out: Successor[] }

interface CacheEntry { expansion: Expansion; turnsInFight: number }

function codeOf(e: unknown): unknown {
  return typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
}

function badChoice(message: string): Error {
  return Object.assign(new Error(`arena: ${message}`), { code: 'BAD_CHOICE' as const });
}

function uniform(choices: Choice[]): ActionSupport[] {
  return choices.map((choice) => ({ choice, probability: rat(1, choices.length) }));
}

/** An AND over an empty or short list would be vacuous or miss branches: refuse it. */
function checkTotal(what: string, probabilities: Rational[]): void {
  if (probabilities.length === 0) throw new Error(`arena: ${what} is empty`);
  const total = sum(probabilities);
  if (!eq(total, ONE)) throw new Error(`arena: ${what} sums to ${total.num}/${total.den}, not 1`);
}

/**
 * A cached expansion for a member whose key matched but whose turn count differs (keys need not hold the turn): the
 * same-fight battle successors move by the difference. Every other member field is fixed by the key.
 */
function rebase(entry: CacheEntry, member: Member): Expansion {
  const delta = member.turnsInFight - entry.turnsInFight;
  if (delta === 0) return entry.expansion;
  return {
    turnConsumed: entry.expansion.turnConsumed,
    successors: entry.expansion.successors.map((s) => (s.member !== null && s.member.kind === 'battle' && s.member.fight === member.fight
      ? { ...s, member: { ...s.member, turnsInFight: s.member.turnsInFight + delta } }
      : s)),
  };
}

export class Arena {
  readonly fights: ArenaFight[];
  readonly stats: SearchStats;
  private readonly engine: Engine;
  private readonly enemyModel: EnemyModel;
  private readonly cacheLimit: number;
  private readonly maxLeaves: number | undefined;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: { engine: Engine; enemyModel: EnemyModel; fights: ArenaFight[]; edgeCacheEntries: number; maxLeaves?: number; stats: SearchStats }) {
    if (opts.fights.length === 0) throw new Error('arena: no fights');
    this.engine = opts.engine;
    this.enemyModel = opts.enemyModel;
    this.fights = opts.fights;
    this.cacheLimit = opts.edgeCacheEntries;
    this.maxLeaves = opts.maxLeaves;
    this.stats = opts.stats;
  }

  /** The engine's id (certificates record it). */
  get engineId(): string {
    return this.engine.id;
  }

  /** The enemy model's id (certificates record it). */
  get aiId(): string {
    return this.enemyModel.id;
  }

  /** The entry member for fight 0, carry null. */
  root(): Member {
    return this.entryMember(0, null, 0);
  }

  /** Entry: a lead { switch, index } for each living team mon (canonical index); battle: the engine's legal p1 choices. */
  choices(member: Member): Choice[] {
    if (member.kind === 'battle') return this.engine.legalChoices(this.stateOf(member), 'p1');
    return this.startHps(member.fight, member.carry).flatMap((hp, index) => (hp > 0 ? [{ kind: 'switch', index } as const] : []));
  }

  expand(member: Member, choice: Choice, opts: ExpandOpts): Expansion {
    const cacheKey = `${member.key}\u0000${choiceText(choice)}\u0000${opts.level}\u0000${opts.critCap ?? '-'}`;
    const hit = this.cache.get(cacheKey);
    if (hit !== undefined) {
      this.cache.delete(cacheKey);   // most recently used last
      this.cache.set(cacheKey, hit);
      this.stats.edgeHits += 1;
      return rebase(hit, member);
    }
    const expansion = member.kind === 'entry' ? this.expandEntry(member, choice, opts) : this.expandBattle(member, choice, opts);
    this.stats.expansions += 1;
    if (this.cacheLimit > 0) {
      this.cache.set(cacheKey, { expansion, turnsInFight: member.turnsInFight });
      if (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value!);
    }
    return expansion;
  }

  /** Of a canonical carry at the end of the last fight: the lowest HP fraction, the HP total and the PP total. */
  metrics(carry: CarryState): { minHpFrac: Rational; totalHp: number; pp: number } {
    const team = this.fights[this.fights.length - 1]!.team;
    if (carry.mons.length !== team.length) throw new RangeError(`arena: carry has ${carry.mons.length} mons for a team of ${team.length}`);
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

  private fight(index: number): ArenaFight {
    const fight = this.fights[index];
    if (fight === undefined) throw new Error(`arena: no fight ${index}`);
    return fight;
  }

  private stateOf(member: Member): EngineState {
    if (member.state === null) throw new Error(`arena: battle member ${member.key} has no state`);
    return member.state;
  }

  /** Canonical HP each team mon starts fight `index` with (inputs.ts startCarry: the carry's, else healed, else the save's). */
  private startHps(index: number, carry: CarryState | null): number[] {
    return startCarry(this.fight(index), carry).mons.map((m) => m.hp);
  }

  /** Lowest HP fraction over the team, from canonical HPs (ordering only). */
  private danger(index: number, hps: number[]): number {
    const team = this.fight(index).team;
    if (hps.length !== team.length) throw new Error(`arena: ${hps.length} HP values for a team of ${team.length}`);
    const fracs = hps.map((hp, i) => hp / team[i]!.maxHp);
    return Math.min(1, Math.max(0, Math.min(...fracs)));
  }

  private entryMember(fight: number, carry: CarryState | null, crits: number): Member {
    const carryKey = carry === null ? 'fresh' : canonicalJson(carry);
    return {
      key: ramEdgeKey(fight, 'entry', carryKey, NO_MEMORY.key, crits), fight, kind: 'entry', state: null, carry,
      memory: NO_MEMORY, crits, danger: this.danger(fight, this.startHps(fight, carry)), turnsInFight: 0, lead: null,
    };
  }

  private battleMember(fight: number, state: EngineState, memory: AiMemory, crits: number, turnsInFight: number, lead: number): Member {
    const hps = toCanonicalCarry(this.engine.carryOut(state), lead).mons.map((m) => m.hp);
    return {
      key: ramEdgeKey(fight, 'battle', state.key, memory.key, crits), fight, kind: 'battle', state, carry: null, memory,
      crits, danger: this.danger(fight, hps), turnsInFight, lead,
    };
  }

  private expandEntry(member: Member, choice: Choice, opts: ExpandOpts): Expansion {
    const fight = this.fight(member.fight);
    const lead = choice.kind === 'switch' ? choice.index : -1;
    if (!this.choices(member).some((c) => c.kind === 'switch' && c.index === lead)) {
      throw badChoice(`${choiceText(choice)} is not a lead at fight ${member.fight}'s entry`);
    }
    if (fight.info.worlds.length === 0) throw new Error(`arena: fight ${member.fight} has no worlds`);
    const share = rat(1, fight.info.worlds.length);
    const run: Run = { member, lead, level: opts.level, critCap: opts.critCap, stop: opts.stop, turnConsumed: false, out: [] };
    for (const world of fight.info.worlds) {
      let state: EngineState;
      try {
        state = this.engine.createBattle(battleInput(fight, lead, member.carry, world));
      } catch (e) {
        if (codeOf(e) !== 'UNMODELLED_ITEM') throw this.mapError(e);
        this.push(run, 'unlabelled', { probability: share, observations: [], aiChoices: [], labels: [], crit: false, last: standInOutcome(null) });
        continue;
      }
      const memory = opts.level === 1 ? this.enemyModel.initialMemory(state) : NO_MEMORY;
      const observation = this.engine.observe(state);
      this.settle(run, state, memory, { probability: share, observations: [observation], aiChoices: [], labels: [], crit: false, last: startOutcome(state, observation) });
    }
    return { successors: run.out, turnConsumed: false };
  }

  private expandBattle(member: Member, choice: Choice, opts: ExpandOpts): Expansion {
    const state = this.stateOf(member);
    if (member.lead === null) throw new Error(`arena: battle member ${member.key} has no lead`);
    const kind = state.phase.kind;
    if (kind !== 'turnChoice' && kind !== 'playerMidTurnSwitch') throw new Error(`arena: a battle member at phase ${kind} is not the player's decision`);
    const run: Run = { member, lead: member.lead, level: opts.level, critCap: opts.critCap, stop: opts.stop, turnConsumed: kind === 'turnChoice', out: [] };
    const start: Path = { probability: ONE, observations: [], aiChoices: [], labels: [], crit: false, last: null };
    if (kind === 'playerMidTurnSwitch') {
      this.step(run, state, { p1: choice }, member.memory, start);
    } else {
      for (const a of this.enemySupport(run, state, member.memory, 'turn', start)) {
        this.step(run, state, { p1: choice, p2: a.choice }, member.memory, { ...start, probability: a.probability, aiChoices: [a.choice] });
      }
    }
    return { successors: run.out, turnConsumed: run.turnConsumed };
  }

  /**
   * Level 1: the AI's support (turn) or replacement support; level 2: every legal p2 choice at 1/n. When the AI throws
   * an error with a string code (any AiError), pushes one unlabelled successor for this node (at `path`'s probability,
   * with a note) and returns []; an error without one propagates.
   */
  private enemySupport(run: Run, state: EngineState, memory: AiMemory, when: 'turn' | 'replacement', path: Path): ActionSupport[] {
    let support: ActionSupport[];
    if (run.level === 2) {
      support = uniform(this.engine.legalChoices(state, 'p2'));
    } else {
      try {
        support = when === 'turn' ? this.enemyModel.support(state, memory) : this.enemyModel.replacementSupport(state, memory);
      } catch (e) {
        const code = codeOf(e);
        if (typeof code !== 'string') throw e;
        const note = `undefined AI behaviour: ${code}: ${e instanceof Error ? e.message : String(e)}`;
        this.push(run, 'unlabelled', { ...path, last: path.last ?? standInOutcome(state) }, { note });
        return [];
      }
    }
    this.stats.supports += 1;
    checkTotal(`the enemy ${when} support at turn ${state.turn}`, support.map((a) => a.probability));
    return support;
  }

  /** One engine step from `state`, the run's stop polled first and handed to it (see the top of the file); each outcome is settled. */
  private step(run: Run, state: EngineState, choices: { p1?: Choice; p2?: Choice }, memory: AiMemory, path: Path): void {
    const { stop } = run;
    if (stop?.() === true) throw new ArenaStopError(`before the step at turn ${state.turn}`);
    let outcomes: Outcome[];
    try {
      const opts = { ...(this.maxLeaves === undefined ? {} : { maxLeaves: this.maxLeaves }), ...(stop === undefined ? {} : { shouldStop: stop }) };
      outcomes = this.engine.expandTurn(state, choices, Object.keys(opts).length === 0 ? undefined : opts);
    } catch (e) {
      throw this.mapError(e);
    }
    checkTotal(`the outcomes at turn ${state.turn}`, outcomes.map((o) => o.probability));
    for (const o of outcomes) {
      this.stats.leaves += o.merged;
      for (const label of o.labels) this.stats.chanceKinds.add(label.kind);
      const next: Path = {
        probability: mul(path.probability, o.probability), observations: [...path.observations, o.observation],
        aiChoices: path.aiChoices, labels: [...path.labels, ...o.labels], crit: path.crit || o.critBy.p2, last: o,
      };
      if (o.fainted.p1.length > 0) this.push(run, 'dead', next);
      else if (o.unlabelled) this.push(run, 'unlabelled', next);
      else this.settle(run, o.state, run.level === 1 ? this.enemyModel.remember(memory, o) : memory, next);
    }
  }

  /** Classifies `state` (reached on `path`), or runs the enemy's replacement / mid-turn switch first. */
  private settle(run: Run, state: EngineState, memory: AiMemory, path: Path): void {
    const phase = state.phase;
    switch (phase.kind) {
      case 'turnChoice':
      case 'playerMidTurnSwitch': {
        const fight = run.member.fight;
        const turns = run.member.turnsInFight + (run.turnConsumed ? 1 : 0);
        const member = this.battleMember(fight, state, memory, this.critsAfter(run, path), turns, run.lead);
        this.push(run, 'continue', path, { member, phase: phase.kind });
        return;
      }
      case 'playerReplacement':
        this.push(run, 'dead', path);
        return;
      case 'terminal':
        if (phase.winner === 'p2') this.push(run, 'dead', path);
        else this.won(run, state, path);
        return;
      case 'enemyReplacement':
      case 'enemyMidTurnSwitch':
        for (const a of this.enemySupport(run, state, memory, 'replacement', path)) {
          this.step(run, state, { p2: a.choice }, memory, { ...path, probability: mul(path.probability, a.probability), aiChoices: [...path.aiChoices, a.choice] });
        }
        return;
    }
  }

  /** A fight won: the run's win in the last fight, else the next fight's entry. */
  private won(run: Run, state: EngineState, path: Path): void {
    const carry = toCanonicalCarry(this.engine.carryOut(state), run.lead);
    const next = run.member.fight + 1;
    if (next >= this.fights.length) {
      this.push(run, 'win', path, { endCarry: carry });
      return;
    }
    const member = this.entryMember(next, this.fight(next).healBefore ? null : carry, this.critsAfter(run, path));
    this.push(run, 'continue', { ...path, observations: [...path.observations, fightMarker(next)] }, { member, phase: 'entry' });
  }

  private critsAfter(run: Run, path: Path): number {
    return run.critCap === null ? 0 : Math.min(run.member.crits + (path.crit ? 1 : 0), run.critCap);
  }

  private push(run: Run, result: Successor['result'], path: Path, extra: { member?: Member; phase?: DecisionPhase; endCarry?: CarryState; note?: string } = {}): void {
    if (path.last === null) throw new Error('arena: a successor before any engine step');
    run.out.push({
      result, member: extra.member ?? null, phase: extra.phase ?? null, probability: path.probability, observations: path.observations,
      aiChoices: path.aiChoices, critsAdded: path.crit ? 1 : 0, last: path.last, labels: path.labels, endCarry: extra.endCarry ?? null,
      ...(extra.note === undefined ? {} : { note: extra.note }),
    });
  }

  private mapError(e: unknown): unknown {
    const code = codeOf(e);
    const message = e instanceof Error ? e.message : String(e);
    if (code === 'LIMIT') return new ArenaLimitError(message);
    if (code === 'STOPPED') return new ArenaStopError(message);
    return e;
  }
}
