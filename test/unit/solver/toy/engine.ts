// The toy engine: the Engine contract (src/contracts/engine.ts) over the toy game in game.ts, with known answers.
//
// RULES
//
// State: `state.json` is the canonical JSON (keys sorted at every level) of a ToyState; `state.key` is the same text,
// without `turn` when `registry.keyOmitsTurn`. Fields: trainer; p1Keys (p1's registry keys, input order); turn (from 1,
// +1 each time play returns to turnChoice); phase; active { p1, p2 }; bag (p2's potions); queue (moves still to run in a
// turn paused by U-turn); p1, p2 (per party mon: name, hp, maxHp and speed after the world, pp per slot (null =
// unlimited), status 'none' | 'sleep' | 'burn', sleep (the hidden counter, 0 awake), fainted, revealed (p2's used moves,
// slot order), slept (p1 with undrawnSleepCarry only: attempts spent asleep, carried-in attempts included)).
//
// createBattle: a double trainer throws UNSUPPORTED_DOUBLE. Mons start at full HP and PP (`pp ?? 10`), no status, index
// 0 active, turn 1, turnChoice. Then carry (p1 hp, limited-PP pp in move order, status; 0 HP throws RangeError), then
// startStatus, then world (enemy[i].nature = n applies party[i].worlds[n]: maxHp, starting at it, and speed).
// Statuses: none; { sleep, turns ≥ 1 } (the counter); burn; a carried { sleepUndrawn, attempts ≥ 0 } restores as sleep
// with counter max(1, 2 − attempts) and slept = attempts; any other kind throws.
//
// legalChoices: at turnChoice, moves with PP (Struggle as { move, slot 0 } when none has), switches to the living bench,
// then p2's { item: 'potion' } while the bag holds one. At a side's mid-turn switch or replacement: its switches only.
// Terminal: none. expandTurn throws BAD_CHOICE unless each side with choices passes a legal one and the other none.
//
// A turn: 1. p2's potion heals 5 (capped). 2. Switches, p1 then p2. 3. Moves by priority, then speed; equal → a
// speedTie point. 4. Each move, skipped when its user fainted or left:
//   a. Asleep: counter > 1 → decrement, slept + 1, |cant|; counter 1 → wakes (|-curestatus|, slept 0) and acts.
//   b. PP − 1 (not Struggle); a p2 move is revealed; |move|. heal3 heals the user 3 and ends. A fainted target: ends.
//   c. Accuracy < 1 → a hit point; a miss ends the move.
//   d. Per hit while the target lives: a crit point, a roll point over the distinct damages (weight count/len), raw3's
//      raw point (+0, +1 or +2). Damage = base + raw, +2 with guts while statused, ×2 on a crit, +1 with
//      bugDamagePlusOne, capped at the target's HP. Struggle: 1 damage, never misses, no crit.
//   e. doze: a living unstatused target sleeps, counter from a pick point (2 or 3). A target at 0 HP faints.
//   f. uturn past accuracy with a living bench mon: pause at player/enemyMidTurnSwitch, the rest in `queue`.
// 5. End of turn: a burned active mon loses 1 HP (p1, then p2). Settle: all p1 fainted → p2 wins; all p2 fainted → p1
// wins; p1's active fainted → playerReplacement; p2's → enemyReplacement; else turnChoice, turn + 1.
// A mid-turn switch step runs the switch, the paused queue, then 5. A replacement step runs the switch and settles.
//
// Chance points count only with two or more options of non-zero weight. Labels: side = the acting side, source = the
// move's id. speedTie (option 0 = p1 first, outcome 'first'), hit 'hit'/'miss', crit 'crit'/'normal', roll 'dmg=<n>'
// ascending, raw 'raw=<k>' (marks the outcome unlabelled), pick (source 'doze') 'counter=2'/'counter=3'.
//
// expandTurn replays forced prefixes of option indices (option 0 after the prefix) until no unexplored sibling is left;
// a leaf's probability is the product of its weights. Leaves with equal (key, critBy, observation) merge: probabilities
// add, labels/log/fainted come from the most probable (first on a tie), unlabelled is OR, `merged` counts. More than
// `maxLeaves` (default 20,000) leaves throws LIMIT.
//
// Log: omniscient Showdown protocol lines ('p1a: Name'; HP '<hp>/<max>' or '0 fnt'): |move| |-miss| |-crit| |-damage|
// (burn: '[from] brn') |-heal| (potion: '[from] item: Potion') |switch| |-status| |cant| |-curestatus| |faint|.
// Observation: canonical JSON of p1 { name, hp, maxHp, status, pp }, p2 { name, fainted, status, revealed, bar while
// alive }, active, the phase kind and the step's log with p2 HP as '<bar>/<segments>'; bar = min(segments,
// ceil(hp × segments / the registry's maxHp)), segments = hpBarSegments ?? 4. observeAll: { state: key, log }.
// observe() gives the same without log lines. carryOut: per p1 mon { hp, limited pp, status } (sleep as
// { sleep, turns }, or { sleepUndrawn, attempts: slept } with undrawnSleepCarry). unmodelledIn: 'item mystery (<name>)'
// per holder, p1 then p2. Engine errors carry a `code`; bad inputs throw plain Errors.

import type {
  BattleInput, CarryState, ChanceLabel, Choice, Engine, EngineErrorCode, EngineState, Outcome, Phase, Rational, Side, UndrawnSleep,
} from '../../../../src/contracts/engine.js';
import type { StartStatus } from '../../../../src/save/status.js';
import { add, cmp, eq, isZero, mul, ONE, rat, sub, ZERO } from '../../../../src/solver/rational.js';
import type { ToyMon, ToyMove, ToyRegistry, ToyTrainer } from './game.js';

export type ToyStatus = 'none' | 'sleep' | 'burn';

export interface ToyMonState {
  name: string; hp: number; maxHp: number; speed: number; pp: (number | null)[]; status: ToyStatus; sleep: number;
  fainted: boolean; revealed: string[];
  slept?: number;               // p1 only, with registry.undrawnSleepCarry (see the RULES)
}

/** A move still to run in a turn paused by U-turn. */
export interface ToyPending { side: Side; user: number; slot: number; struggle: boolean }

export interface ToyState {
  trainer: string; p1Keys: string[]; turn: number; phase: Phase;
  p1: ToyMonState[]; p2: ToyMonState[]; active: { p1: number; p2: number }; bag: 'potion'[]; queue: ToyPending[];
}

export function readToyState(state: EngineState): ToyState {
  return JSON.parse(state.json) as ToyState;
}

/** The registry data of the mon at `index` of `side`'s party. */
export function toyMonOf(registry: ToyRegistry, state: ToyState, side: Side, index: number): ToyMon {
  const mon = side === 'p1' ? registry.mons[state.p1Keys[index] ?? ''] : trainerOf(registry, state).party[index];
  if (mon === undefined) throw new Error(`toy engine: no ${side} mon at party index ${index}`);
  return mon;
}

export const STRUGGLE: ToyMove = { name: 'Struggle', damage: [1], pp: null };

/** JSON with object keys sorted at every level. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((k) => [k, sortKeys(record[k])]));
}

const DEFAULT_MAX_LEAVES = 20_000;
const DEFAULT_SEGMENTS = 4;
const SIDES: readonly Side[] = ['p1', 'p2'];
const HALF = rat(1, 2);
const THIRD = rat(1, 3);

function engineError(code: EngineErrorCode, message: string): Error & { code: EngineErrorCode } {
  return Object.assign(new Error(`toy engine: ${message}`), { code });
}

const other = (side: Side): Side => (side === 'p1' ? 'p2' : 'p1');
const toId = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const hpBar = (hp: number, segments: number, baseMaxHp: number): number => Math.min(segments, Math.ceil((hp * segments) / baseMaxHp));

function trainerOf(registry: ToyRegistry, state: ToyState): ToyTrainer {
  const trainer = registry.trainers[state.trainer];
  if (trainer === undefined) throw new Error(`toy engine: unknown trainer ${state.trainer}`);
  return trainer;
}

interface ChanceOption { label: ChanceLabel; weight: Rational }

/** Replays `prefix` (option indices among the non-zero options), then takes option 0 and records each new point. */
class ChanceDriver {
  readonly taken: number[] = [];
  readonly sizes: number[] = [];
  readonly labels: ChanceLabel[] = [];
  probability: Rational = ONE;
  unlabelled = false;

  constructor(private readonly prefix: readonly number[]) {}

  /** The index into `options` of the option on this path. */
  draw(options: ChanceOption[]): number {
    const live = options.flatMap((o, i) => (isZero(o.weight) ? [] : [i]));
    if (live.length === 0) throw new Error('toy engine: a chance point with no option of non-zero weight');
    if (live.length === 1) return live[0]!;
    const call = this.taken.length;
    const pick = call < this.prefix.length ? this.prefix[call]! : 0;
    if (pick >= live.length) throw new Error('toy engine: a replay left its forced prefix');
    this.taken.push(pick);
    this.sizes.push(live.length);
    const index = live[pick]!;
    const option = options[index]!;
    this.probability = mul(this.probability, option.weight);
    this.labels.push(option.label);
    if (option.label.kind === 'raw') this.unlabelled = true;
    return index;
  }
}

/** One log line: the omniscient text and what the player sees (p2 HP as an HP bar). */
interface LogLine { text: string; obs: string }
type Part = string | LogLine;

function legalOf(state: ToyState, side: Side): Choice[] {
  const kind = state.phase.kind;
  const mine = kind === 'turnChoice'
    || (side === 'p1' ? kind === 'playerMidTurnSwitch' || kind === 'playerReplacement' : kind === 'enemyMidTurnSwitch' || kind === 'enemyReplacement');
  if (!mine) return [];
  const party = state[side];
  const switches: Choice[] = party.flatMap((m, index) => (m.fainted || index === state.active[side] ? [] : [{ kind: 'switch', index } as const]));
  if (kind !== 'turnChoice') return switches;
  const moves: Choice[] = party[state.active[side]]!.pp.flatMap((pp, slot) => (pp === null || pp > 0 ? [{ kind: 'move', slot } as const] : []));
  const choices: Choice[] = [...(moves.length > 0 ? moves : [{ kind: 'move', slot: 0 } as const]), ...switches];
  if (side === 'p2' && state.bag.includes('potion')) choices.push({ kind: 'item', item: 'potion' });
  return choices;
}

function sameChoice(a: Choice, b: Choice): boolean {
  if (a.kind === 'move' && b.kind === 'move') return a.slot === b.slot;
  if (a.kind === 'switch' && b.kind === 'switch') return a.index === b.index;
  if (a.kind === 'item' && b.kind === 'item') return a.item === b.item;
  return false;
}

function switchIndex(c: Choice | undefined): number {
  if (c?.kind !== 'switch') throw engineError('BAD_CHOICE', `expected a switch, got ${JSON.stringify(c)}`);
  return c.index;
}

/** One run of a step on a private copy of the state, drawing chance from `drv`. */
class Step {
  readonly log: LogLine[] = [];
  readonly fainted: { p1: number[]; p2: number[] } = { p1: [], p2: [] };
  readonly critBy = { p1: false, p2: false };

  constructor(private readonly reg: ToyRegistry, readonly s: ToyState, private readonly drv: ChanceDriver) {}

  run(choices: { p1?: Choice; p2?: Choice }): void {
    const kind = this.s.phase.kind;
    switch (kind) {
      case 'turnChoice':
        this.turn(choices.p1!, choices.p2!);
        return;
      case 'playerMidTurnSwitch':
      case 'enemyMidTurnSwitch': {
        const side: Side = kind === 'playerMidTurnSwitch' ? 'p1' : 'p2';
        this.switchIn(side, switchIndex(choices[side]));
        const queue = this.s.queue;
        this.s.queue = [];
        this.runQueue(queue);
        return;
      }
      case 'playerReplacement':
      case 'enemyReplacement': {
        const side: Side = kind === 'playerReplacement' ? 'p1' : 'p2';
        this.switchIn(side, switchIndex(choices[side]));
        this.settle();
        return;
      }
      case 'terminal':
        throw engineError('BAD_CHOICE', 'a terminal state has no step');
    }
  }

  private mon(side: Side, index: number): ToyMonState {
    return this.s[side][index]!;
  }

  private pos(side: Side, index: number): string {
    return `${side}a: ${this.mon(side, index).name}`;
  }

  private hp(side: Side, index: number): LogLine {
    const m = this.mon(side, index);
    const text = m.hp === 0 ? '0 fnt' : `${m.hp}/${m.maxHp}`;
    if (side === 'p1' || m.hp === 0) return { text, obs: text };
    const segments = trainerOf(this.reg, this.s).hpBarSegments ?? DEFAULT_SEGMENTS;
    return { text, obs: `${hpBar(m.hp, segments, toyMonOf(this.reg, this.s, side, index).maxHp)}/${segments}` };
  }

  private emit(...parts: Part[]): void {
    const join = (pick: (l: LogLine) => string) => `|${parts.map((p) => (typeof p === 'string' ? p : pick(p))).join('|')}`;
    this.log.push({ text: join((l) => l.text), obs: join((l) => l.obs) });
  }

  private turn(p1: Choice, p2: Choice): void {
    if (p2.kind === 'item') this.usePotion();
    if (p1.kind === 'switch') this.switchIn('p1', p1.index);
    if (p2.kind === 'switch') this.switchIn('p2', p2.index);
    const moves: ToyPending[] = [];
    for (const [side, c] of [['p1', p1], ['p2', p2]] as const) {
      if (c.kind !== 'move') continue;
      const user = this.s.active[side];
      const struggle = !this.mon(side, user).pp.some((pp) => pp === null || pp > 0);
      moves.push({ side, user, slot: c.slot, struggle });
    }
    this.runQueue(this.order(moves));
  }

  private usePotion(): void {
    this.s.bag.splice(this.s.bag.indexOf('potion'), 1);
    const i = this.s.active.p2;
    const m = this.mon('p2', i);
    m.hp = Math.min(m.maxHp, m.hp + 5);
    this.emit('-heal', this.pos('p2', i), this.hp('p2', i), '[from] item: Potion');
  }

  private switchIn(side: Side, index: number): void {
    this.s.active[side] = index;
    this.emit('switch', this.pos(side, index), this.mon(side, index).name, this.hp(side, index));
  }

  private moveOf(a: ToyPending): ToyMove {
    return a.struggle ? STRUGGLE : toyMonOf(this.reg, this.s, a.side, a.user).moves[a.slot]!;
  }

  private order(moves: ToyPending[]): ToyPending[] {
    const [a, b] = moves;
    if (a === undefined || b === undefined) return moves;
    const [ma, mb] = [this.moveOf(a), this.moveOf(b)];
    const [pa, pb] = [ma.priority ?? 0, mb.priority ?? 0];
    if (pa !== pb) return pa > pb ? [a, b] : [b, a];
    const [sa, sb] = [this.mon(a.side, a.user).speed, this.mon(b.side, b.user).speed];
    if (sa !== sb) return sa > sb ? [a, b] : [b, a];
    const first = this.drv.draw([
      { label: { kind: 'speedTie', side: a.side, source: toId(ma.name), outcome: 'first' }, weight: HALF },
      { label: { kind: 'speedTie', side: b.side, source: toId(mb.name), outcome: 'first' }, weight: HALF },
    ]);
    return first === 0 ? [a, b] : [b, a];
  }

  private runQueue(queue: ToyPending[]): void {
    for (let i = 0; i < queue.length; i++) {
      const a = queue[i]!;
      if (!this.useMove(a)) continue;
      this.s.queue = queue.slice(i + 1);
      this.s.phase = a.side === 'p1' ? { kind: 'playerMidTurnSwitch' } : { kind: 'enemyMidTurnSwitch' };
      return;
    }
    this.endOfTurn();
  }

  /** Runs one move; true when a U-turn pauses the turn. */
  private useMove(a: ToyPending): boolean {
    const { side } = a;
    const foe = other(side);
    const user = this.mon(side, a.user);
    if (user.fainted || this.s.active[side] !== a.user) return false;
    if (user.status === 'sleep') {
      if (user.sleep > 1) {
        user.sleep -= 1;
        if (user.slept !== undefined) user.slept += 1;
        this.emit('cant', this.pos(side, a.user), 'slp');
        return false;
      }
      user.status = 'none';
      user.sleep = 0;
      if (user.slept !== undefined) user.slept = 0;
      this.emit('-curestatus', this.pos(side, a.user), 'slp', '[msg]');
    }
    const move = this.moveOf(a);
    if (!a.struggle) {
      const pp = user.pp[a.slot];
      if (pp !== null && pp !== undefined) user.pp[a.slot] = pp - 1;
      if (side === 'p2') this.reveal(a.user, a.slot);
    }
    const ti = this.s.active[foe];
    const target = this.mon(foe, ti);
    this.emit('move', this.pos(side, a.user), move.name, this.pos(foe, ti));
    if (move.effect === 'heal3') {
      user.hp = Math.min(user.maxHp, user.hp + 3);
      this.emit('-heal', this.pos(side, a.user), this.hp(side, a.user));
      return false;
    }
    if (target.fainted) return false;
    const source = toId(move.name);
    const accuracy = move.accuracy ?? ONE;
    if (cmp(accuracy, ONE) < 0) {
      const hit = this.drv.draw([
        { label: { kind: 'hit', side, source, outcome: 'hit' }, weight: accuracy },
        { label: { kind: 'hit', side, source, outcome: 'miss' }, weight: sub(ONE, accuracy) },
      ]);
      if (hit === 1) {
        this.emit('-miss', this.pos(side, a.user), this.pos(foe, ti));
        return false;
      }
    }
    if (move.damage.length > 0) {
      for (let h = 0; h < (move.hits ?? 1) && target.hp > 0; h++) this.hit(a, move, source, ti);
    }
    if (move.effect === 'doze' && target.hp > 0 && target.status === 'none') {
      const pick = this.drv.draw([2, 3].map((n) => ({ label: { kind: 'pick', side, source: 'doze', outcome: `counter=${n}` }, weight: HALF })));
      target.status = 'sleep';
      target.sleep = pick === 0 ? 2 : 3;
      this.emit('-status', this.pos(foe, ti), 'slp');
    }
    if (target.hp === 0) this.faint(foe, ti);
    return move.effect === 'uturn' && this.s[side].some((m, i) => i !== a.user && !m.fainted);
  }

  private hit(a: ToyPending, move: ToyMove, source: string, ti: number): void {
    const { side } = a;
    const foe = other(side);
    const target = this.mon(foe, ti);
    const critChance = move.critChance ?? ZERO;
    const crit = !isZero(critChance) && this.drv.draw([
      { label: { kind: 'crit', side, source, outcome: 'crit' }, weight: critChance },
      { label: { kind: 'crit', side, source, outcome: 'normal' }, weight: sub(ONE, critChance) },
    ]) === 0;
    const values = [...new Set(move.damage)].sort((x, y) => x - y);
    const base = values[this.drv.draw(values.map((v) => ({
      label: { kind: 'roll', side, source, outcome: `dmg=${v}` },
      weight: rat(move.damage.filter((d) => d === v).length, move.damage.length),
    })))]!;
    const extra = move.effect === 'raw3'
      ? this.drv.draw([0, 1, 2].map((k) => ({ label: { kind: 'raw', side, source, outcome: `raw=${k}` }, weight: THIRD })))
      : 0;
    let damage = base + extra;
    if (toyMonOf(this.reg, this.s, side, a.user).guts && this.mon(side, a.user).status !== 'none') damage += 2;
    if (crit) damage *= 2;
    if (this.reg.bugDamagePlusOne) damage += 1;
    damage = Math.min(damage, target.hp);
    if (crit) {
      this.critBy[side] = true;
      this.emit('-crit', this.pos(foe, ti));
    }
    target.hp -= damage;
    this.emit('-damage', this.pos(foe, ti), this.hp(foe, ti));
  }

  private reveal(index: number, slot: number): void {
    const m = this.mon('p2', index);
    const names = toyMonOf(this.reg, this.s, 'p2', index).moves.map((mv) => mv.name);
    const used = names[slot]!;
    m.revealed = [...new Set(names.filter((n) => n === used || m.revealed.includes(n)))];
  }

  private faint(side: Side, index: number): void {
    const m = this.mon(side, index);
    m.fainted = true;
    m.status = 'none';
    m.sleep = 0;
    if (m.slept !== undefined) m.slept = 0;
    this.emit('faint', this.pos(side, index));
    this.fainted[side].push(index);
  }

  private endOfTurn(): void {
    for (const side of SIDES) {
      const i = this.s.active[side];
      const m = this.mon(side, i);
      if (m.fainted || m.status !== 'burn') continue;
      m.hp = Math.max(0, m.hp - 1);
      this.emit('-damage', this.pos(side, i), this.hp(side, i), '[from] brn');
      if (m.hp === 0) this.faint(side, i);
    }
    this.settle();
  }

  private settle(): void {
    const s = this.s;
    if (s.p1.every((m) => m.fainted)) s.phase = { kind: 'terminal', winner: 'p2' };
    else if (s.p2.every((m) => m.fainted)) s.phase = { kind: 'terminal', winner: 'p1' };
    else if (this.mon('p1', s.active.p1).fainted) s.phase = { kind: 'playerReplacement' };
    else if (this.mon('p2', s.active.p2).fainted) s.phase = { kind: 'enemyReplacement' };
    else {
      s.phase = { kind: 'turnChoice' };
      s.turn += 1;
    }
  }
}

function keyOf(registry: ToyRegistry, state: ToyState): string {
  if (!registry.keyOmitsTurn) return canonical(state);
  const { turn: _turn, ...rest } = state;
  return canonical(rest);
}

function engineState(registry: ToyRegistry, state: ToyState): EngineState {
  return { json: canonical(state), turn: state.turn, phase: { ...state.phase }, key: keyOf(registry, state) };
}

function observationOf(registry: ToyRegistry, state: ToyState, log: LogLine[]): string {
  if (registry.observeAll) return canonical({ state: keyOf(registry, state), log: log.map((l) => l.text) });
  const trainer = trainerOf(registry, state);
  const segments = trainer.hpBarSegments ?? DEFAULT_SEGMENTS;
  return canonical({
    p1: state.p1.map((m) => ({ name: m.name, hp: m.hp, maxHp: m.maxHp, status: m.status, pp: m.pp })),
    p2: state.p2.map((m, i) => {
      const seen = { name: m.name, fainted: m.fainted, status: m.status, revealed: m.revealed };
      return m.fainted ? seen : { ...seen, bar: hpBar(m.hp, segments, trainer.party[i]!.maxHp) };
    }),
    active: state.active,
    phase: state.phase.kind,
    log: log.map((l) => l.obs),
  });
}

/** A mon at full HP and PP; `slept` (0) when it is a p1 mon of a registry with undrawnSleepCarry. */
function freshMon(mon: ToyMon, slept: boolean): ToyMonState {
  return {
    name: mon.name, hp: mon.maxHp, maxHp: mon.maxHp, speed: mon.speed, pp: mon.moves.map((mv) => (mv.pp === undefined ? 10 : mv.pp)),
    status: 'none', sleep: 0, fainted: false, revealed: [], ...(slept ? { slept: 0 } : {}),
  };
}

function applyStatus(m: ToyMonState, status: StartStatus | UndrawnSleep, what: string): void {
  if (m.slept !== undefined) m.slept = 0;
  switch (status.kind) {
    case 'none':
    case 'burn':
      m.status = status.kind;
      m.sleep = 0;
      return;
    case 'sleep':
      if (!Number.isInteger(status.turns) || status.turns < 1) throw new Error(`toy engine: ${what}: sleep turns must be ≥ 1, got ${status.turns}`);
      m.status = 'sleep';
      m.sleep = status.turns;
      return;
    case 'sleepUndrawn':
      if (!Number.isInteger(status.attempts) || status.attempts < 0) throw new Error(`toy engine: ${what}: sleep attempts must be ≥ 0, got ${status.attempts}`);
      m.status = 'sleep';
      m.sleep = Math.max(1, 2 - status.attempts);
      if (m.slept !== undefined) m.slept = status.attempts;
      return;
    default:
      throw new Error(`toy engine: ${what}: status ${status.kind} is not supported`);
  }
}

function applyCarry(m: ToyMonState, carry: CarryState['mons'][number], what: string): void {
  if (!Number.isInteger(carry.hp) || carry.hp < 0 || carry.hp > m.maxHp) throw new Error(`toy engine: ${what}: hp ${carry.hp} is outside 0..${m.maxHp}`);
  if (carry.hp === 0) throw new RangeError(`toy engine: ${what}: ${m.name} is carried in at 0 HP (fainted)`);
  const limited = m.pp.filter((pp) => pp !== null).length;
  if (carry.pp.length !== limited) throw new Error(`toy engine: ${what}: ${carry.pp.length} PP values for ${limited} limited-PP moves`);
  let k = 0;
  m.pp = m.pp.map((pp) => (pp === null ? null : carry.pp[k++]!));
  m.hp = carry.hp;
  applyStatus(m, carry.status, what);
}

function carryStatus(registry: ToyRegistry, m: ToyMonState): StartStatus | UndrawnSleep {
  if (m.status === 'sleep') return registry.undrawnSleepCarry ? { kind: 'sleepUndrawn', attempts: m.slept ?? 0 } : { kind: 'sleep', turns: m.sleep };
  return m.status === 'burn' ? { kind: 'burn' } : { kind: 'none' };
}

export function createToyEngine(registry: ToyRegistry): Engine {
  return {
    id: 'toy-engine@1',

    createBattle(input: BattleInput): EngineState {
      const trainerId = input.trainer.id;
      const trainer = registry.trainers[trainerId];
      if (trainer === undefined) throw new Error(`toy engine: unknown trainer ${trainerId}`);
      if (trainer.double || input.trainer.battleType === 'double') throw engineError('UNSUPPORTED_DOUBLE', `trainer ${trainerId} fights a double battle`);
      const p1Keys = input.player.map((p) => p.nickname);
      const p1 = p1Keys.map((key) => {
        const mon = registry.mons[key];
        if (mon === undefined) throw new Error(`toy engine: unknown mon ${key}`);
        return freshMon(mon, registry.undrawnSleepCarry === true);
      });
      const p2 = trainer.party.map((mon) => freshMon(mon, false));
      if (p1.length === 0 || p2.length === 0) throw new Error('toy engine: each side needs at least one mon');
      if (input.carry !== undefined) {
        if (input.carry.mons.length !== p1.length) throw new Error(`toy engine: carry has ${input.carry.mons.length} mons for ${p1.length}`);
        input.carry.mons.forEach((c, i) => applyCarry(p1[i]!, c, `carry ${i}`));
      }
      for (const [index, status] of Object.entries(input.startStatus ?? {})) {
        const m = p1[Number(index)];
        if (m === undefined) throw new Error(`toy engine: startStatus for missing p1 index ${index}`);
        applyStatus(m, status, `startStatus ${index}`);
      }
      (input.world?.enemy ?? []).forEach((w, i) => {
        if (w.nature === undefined) return;
        const world = trainer.party[i]?.worlds?.[w.nature];
        if (world === undefined) throw new Error(`toy engine: p2 mon ${i} has no world ${w.nature}`);
        const m = p2[i]!;
        if (world.maxHp !== undefined) {
          m.maxHp = world.maxHp;
          m.hp = world.maxHp;
        }
        if (world.speed !== undefined) m.speed = world.speed;
      });
      const state: ToyState = {
        trainer: trainerId, p1Keys, turn: 1, phase: { kind: 'turnChoice' }, p1, p2, active: { p1: 0, p2: 0 },
        bag: [...(trainer.bag ?? [])], queue: [],
      };
      return engineState(registry, state);
    },

    legalChoices(state: EngineState, side: Side): Choice[] {
      return legalOf(readToyState(state), side);
    },

    expandTurn(state: EngineState, choices: { p1?: Choice; p2?: Choice }, opts?: { maxLeaves?: number }): Outcome[] {
      const start = readToyState(state);
      if (start.phase.kind === 'terminal') throw engineError('BAD_CHOICE', 'a terminal state has no step');
      for (const side of SIDES) {
        const legal = legalOf(start, side);
        const c = choices[side];
        const ok = legal.length === 0 ? c === undefined : c !== undefined && legal.some((l) => sameChoice(l, c));
        if (!ok) throw engineError('BAD_CHOICE', `${side} choice ${JSON.stringify(c)} is not legal at ${start.phase.kind}`);
      }
      const maxLeaves = opts?.maxLeaves ?? DEFAULT_MAX_LEAVES;
      const merged = new Map<string, { outcome: Outcome; best: Rational }>();
      const pending: number[][] = [[]];
      let leaves = 0;
      while (pending.length > 0) {
        const prefix = pending.pop()!;
        const drv = new ChanceDriver(prefix);
        const step = new Step(registry, readToyState(state), drv);
        step.run(choices);
        leaves += 1;
        if (leaves > maxLeaves) throw engineError('LIMIT', `more than ${maxLeaves} leaves in one step`);
        // Push the unexplored siblings so they pop in lexicographic order of their option indices.
        for (let c = prefix.length; c < drv.sizes.length; c++) {
          for (let j = drv.sizes[c]! - 1; j >= 1; j--) pending.push([...drv.taken.slice(0, c), j]);
        }
        const next = engineState(registry, step.s);
        const observation = observationOf(registry, step.s, step.log);
        const leaf: Outcome = {
          probability: drv.probability, labels: drv.labels, critBy: { ...step.critBy }, unlabelled: drv.unlabelled, state: next,
          observation, log: step.log.map((l) => l.text), fainted: step.fainted, merged: 1,
        };
        const id = `${next.key}\u0000${leaf.critBy.p1 ? 1 : 0}${leaf.critBy.p2 ? 1 : 0}\u0000${observation}`;
        const seen = merged.get(id);
        if (seen === undefined) {
          merged.set(id, { outcome: leaf, best: leaf.probability });
          continue;
        }
        const rep = cmp(leaf.probability, seen.best) > 0 ? leaf : seen.outcome;
        merged.set(id, {
          outcome: {
            ...rep, probability: add(seen.outcome.probability, leaf.probability),
            unlabelled: seen.outcome.unlabelled || leaf.unlabelled, merged: seen.outcome.merged + 1,
          },
          best: rep === leaf ? leaf.probability : seen.best,
        });
      }
      const outcomes = [...merged.values()].map((m) => m.outcome);
      const total = outcomes.reduce((acc, o) => add(acc, o.probability), ZERO);
      if (!eq(total, ONE)) throw new Error(`toy engine: outcome probabilities sum to ${total.num}/${total.den}`);
      return outcomes;
    },

    observe(state: EngineState): string {
      return observationOf(registry, readToyState(state), []);
    },

    carryOut(state: EngineState): CarryState {
      return { mons: readToyState(state).p1.map((m) => ({ hp: m.hp, pp: m.pp.filter((pp): pp is number => pp !== null), status: carryStatus(registry, m) })) };
    },

    unmodelledIn(state: EngineState): string[] {
      const s = readToyState(state);
      const holders = [...s.p1Keys.map((_, i) => toyMonOf(registry, s, 'p1', i)), ...trainerOf(registry, s).party];
      return holders.filter((m) => m.item === 'mystery').map((m) => `item mystery (${m.name})`);
    },
  };
}
