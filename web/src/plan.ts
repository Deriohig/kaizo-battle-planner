/**
 * The plan: one step per turn that the player writes, and what carries forward from one turn to the next.
 * Pure logic. `resolve` is one pass over the turns; it returns new objects and changes nothing it was given.
 */
import type { DraftMonJson, MonRef } from '../../src/server/apiTypes.js';
import type {
  PlanFieldJson, PlanSendOutJson, PlanStages, PlanStartStages, PlanStat, PlanStatus, PlanStepRequestJson, PlanWeather,
} from './planTypes.js';

export interface PlanMon { key: string; ref: MonRef; name: string; entry: DraftMonJson }
export interface PlanStart { trainerId: string; variant: number; world: number; mons: PlanMon[]; lead: string; enemies: string[] }
export type PlanPick = { kind: 'move'; by: string; slot: number; name: string } | { kind: 'switch'; by: string; to: string };
export type PlanFieldPatch = {
  weather?: PlanWeather; trickRoom?: boolean; enemyStatus?: PlanStatus;
  rocks?: { player?: boolean; enemy?: boolean };
  screens?: { player?: { reflect?: boolean; lightScreen?: boolean }; enemy?: { reflect?: boolean; lightScreen?: boolean } };
  stages?: { player?: PlanStages; enemy?: PlanStages };
};
/**
 * A try not yet kept: what the turn had for his side before it (its own `mine`, pick, fainted mark and replacement), for
 * Back to put back exactly, and the pool Pokémon the try brought in (`added`, Back takes them out again).
 */
export interface PlanTrial { mine?: string; pick: PlanPick | null; fainted?: string; sendIn?: string; added?: string[] }
/**
 * `mine`: his Pokémon on this turn, set by him; it carries on like a switch-in. While `before` is there it is a try not yet
 * kept: his on this turn only, the turns after carrying on from the turn as it was (`untriedTurn`). Keep drops `before`.
 */
export interface PlanTurn {
  mine?: string;
  pick: PlanPick | null;
  fainted: { mine?: string; theirs?: number };
  sendIn: { mine?: string; theirs?: number; theirsPicked?: true };
  field: PlanFieldPatch;
  note: string;
  before?: PlanTrial;
}
/**
 * `weather0`: the weather the battle starts in, once an answer said it. `trickRoom0`: whether the battle starts in Trick
 * Room (the trainer's field: a permanent Trick Room), once an answer said it; left out while not known.
 * `stages0`: the stat stages the battle start gives the two actives (an Intimidate), once an answer said any: turn 1
 * carries them in under its own stages, so a stage he set stays his and a seeded one is his to change. Left out while none
 * are known. A weather or Trick Room he set on a turn is his: what the start has only seeds the field under it.
 */
export interface Plan {
  start: PlanStart; turns: PlanTurn[]; cursor: number; note: string; weather0: PlanWeather | null; trickRoom0?: boolean; stages0?: PlanStartStages;
}
export interface ResolvedTurn {
  turn: number;
  mine: string | null; theirs: number | null;
  faintedBefore: { mine: string[]; theirs: number[] };
  pick: PlanPick | null;
  fainted: { mine: boolean; theirs: boolean };
  sendIn: { mine: string | null; theirs: number | null };
  /** `ownWeather`, `ownTrickRoom`: he set the weather, or Trick Room, on this turn or one before it. */
  field: PlanFieldJson; ownWeather: boolean; ownTrickRoom: boolean;
}

export const EMPTY_TURN: PlanTurn = { pick: null, fainted: {}, sendIn: {}, field: {}, note: '' };

/** The most turns a plan has: the page writes no more than it reads back (planStore.ts). */
export const MAX_TURNS = 200;

export function newPlan(start: PlanStart): Plan {
  return { start, turns: [{ ...EMPTY_TURN, fainted: {}, sendIn: {}, field: {} }], cursor: 0, note: '', weather0: null };
}

const STATS: PlanStat[] = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'];

export function defaultField(weather: PlanWeather = 'none', trickRoom = false): PlanFieldJson {
  return {
    weather, trickRoom,
    rocks: { player: false, enemy: false },
    screens: { player: { reflect: false, lightScreen: false }, enemy: { reflect: false, lightScreen: false } },
    stages: { player: {}, enemy: {} },
    enemyStatus: 'none',
  };
}

function copyField(f: PlanFieldJson): PlanFieldJson {
  return {
    weather: f.weather, trickRoom: f.trickRoom,
    rocks: { ...f.rocks },
    screens: { player: { ...f.screens.player }, enemy: { ...f.screens.enemy } },
    stages: { player: { ...f.stages.player }, enemy: { ...f.stages.enemy } },
    enemyStatus: f.enemyStatus,
  };
}

/** A switch or a faint takes that side's boosts away; their status goes with their Pokémon. Everything else stays. */
export function carryField(prev: PlanFieldJson, switched: { player: boolean; enemy: boolean }): PlanFieldJson {
  const next = copyField(prev);
  if (switched.player) next.stages.player = {};
  if (switched.enemy) { next.stages.enemy = {}; next.enemyStatus = 'none'; }
  return next;
}

const clampStage = (n: number): number => Math.max(-6, Math.min(6, Math.trunc(n)));

/** The nonzero stages of `s`, in stat order, clamped. */
function nonzero(s: PlanStages | undefined): PlanStages {
  const out: PlanStages = {};
  for (const stat of STATS) {
    const v = s?.[stat];
    if (v !== undefined && clampStage(v) !== 0) out[stat] = clampStage(v);
  }
  return out;
}

/** The start's stages as the plan keeps them: the nonzero ones of each side. */
export const startStagesOf = (s: PlanStartStages | undefined): PlanStartStages => ({ player: nonzero(s?.player), enemy: nonzero(s?.enemy) });

/** Whether two start-stage sets give the same stages (a missing one is none). */
export function sameStartStages(a: PlanStartStages | undefined, b: PlanStartStages | undefined): boolean {
  const x = startStagesOf(a);
  const y = startStagesOf(b);
  return STATS.every((stat) => x.player[stat] === y.player[stat] && x.enemy[stat] === y.enemy[stat]);
}

function stagesPatched(base: PlanStages, patch: PlanStages | undefined): PlanStages {
  const out: PlanStages = {};
  for (const stat of STATS) {
    const v = clampStage(patch && patch[stat] !== undefined ? patch[stat]! : base[stat] ?? 0);
    if (v !== 0) out[stat] = v;
  }
  return out;
}

export function patched(carried: PlanFieldJson, patch: PlanFieldPatch): PlanFieldJson {
  const f = copyField(carried);
  if (patch.weather !== undefined) f.weather = patch.weather;
  if (patch.trickRoom !== undefined) f.trickRoom = patch.trickRoom;
  if (patch.enemyStatus !== undefined) f.enemyStatus = patch.enemyStatus;
  for (const side of ['player', 'enemy'] as const) {
    const rocks = patch.rocks?.[side];
    if (rocks !== undefined) f.rocks[side] = rocks;
    const s = patch.screens?.[side];
    if (s?.reflect !== undefined) f.screens[side].reflect = s.reflect;
    if (s?.lightScreen !== undefined) f.screens[side].lightScreen = s.lightScreen;
  }
  f.stages = { player: stagesPatched(f.stages.player, patch.stages?.player), enemy: stagesPatched(f.stages.enemy, patch.stages?.enemy) };
  return f;
}

/** What has to be written on top of `carried` to reach `next`; a stage that went to 0 is written as 0. */
export function patchOf(carried: PlanFieldJson, next: PlanFieldJson): PlanFieldPatch {
  const p: PlanFieldPatch = {};
  if (next.weather !== carried.weather) p.weather = next.weather;
  if (next.trickRoom !== carried.trickRoom) p.trickRoom = next.trickRoom;
  if (next.enemyStatus !== carried.enemyStatus) p.enemyStatus = next.enemyStatus;
  for (const side of ['player', 'enemy'] as const) {
    if (next.rocks[side] !== carried.rocks[side]) (p.rocks ??= {})[side] = next.rocks[side];
    for (const key of ['reflect', 'lightScreen'] as const) {
      if (next.screens[side][key] !== carried.screens[side][key]) ((p.screens ??= {})[side] ??= {})[key] = next.screens[side][key];
    }
    for (const stat of STATS) {
      const a = carried.stages[side][stat] ?? 0;
      const b = next.stages[side][stat] ?? 0;
      if (a !== b) ((p.stages ??= {})[side] ??= {})[stat] = b;
    }
  }
  return p;
}

/** The turn as it was before its try not yet kept (`before` put back); the turn itself when it has none. */
export function untriedTurn(t: PlanTurn): PlanTurn {
  const b = t.before;
  if (b === undefined) return t;
  const u: PlanTurn = { ...t, pick: b.pick, fainted: { ...t.fainted }, sendIn: { ...t.sendIn } };
  delete u.before;
  if (b.mine === undefined) delete u.mine; else u.mine = b.mine;
  if (b.fainted === undefined) delete u.fainted.mine; else u.fainted.mine = b.fainted;
  if (b.sendIn === undefined) delete u.sendIn.mine; else u.sendIn.mine = b.sendIn;
  return u;
}

/** The plan with every try not yet kept put back as its turn was. */
const untried = (plan: Plan): Plan => ({ ...plan, turns: plan.turns.map(untriedTurn) });

/** The pool keys the lead or a turn names. */
export function namedKeys(plan: Plan): Set<string> {
  const keys = new Set<string>([plan.start.lead]);
  for (const t of plan.turns) {
    for (const k of [t.mine, t.pick?.by, t.pick?.kind === 'switch' ? t.pick.to : undefined, t.fainted.mine, t.sendIn.mine]) {
      if (k !== undefined) keys.add(k);
    }
  }
  return keys;
}

/**
 * The pool Pokémon only a try not yet kept brought in: in no turn's team but that try's own, and no ending waits on them.
 * One the plan names anywhere else (a kept turn, the lead) is his for good.
 */
export function trialOnly(plan: Plan): Set<string> {
  const named = namedKeys(untried(plan));
  const out = new Set<string>();
  for (const t of plan.turns) for (const k of t.before?.added ?? []) if (!named.has(k)) out.add(k);
  return out;
}

/** What one turn hands the next. */
interface Carry {
  mine: string | null; theirs: number | null;
  faintedMine: string[]; faintedTheirs: number[];
  field: PlanFieldJson; prevMine: string | null; prevTheirs: number | null; ownWeather: boolean; ownTrickRoom: boolean;
}

/** One turn from what the turns before handed over: its row, and what it hands the next. `was` is left as it was. */
function stepTurn(t: PlanTurn, i: number, was: Carry, inPool: (k: string | null | undefined) => k is string, enemyCount: number): { row: ResolvedTurn; next: Carry } {
  const faintedMine = [...was.faintedMine];
  const faintedTheirs = [...was.faintedTheirs];
  const mine = inPool(t.mine) && !faintedMine.includes(t.mine) ? t.mine : inPool(was.mine) ? was.mine : null;
  const theirs = was.theirs;
  const markMine = mine !== null && t.fainted.mine === mine;
  const markTheirs = theirs !== null && t.fainted.theirs === theirs;
  const pick = t.pick && mine !== null && t.pick.by === mine
    && (t.pick.kind === 'move' || (inPool(t.pick.to) && t.pick.to !== mine && !faintedMine.includes(t.pick.to)))
    ? t.pick : null;

  let sendTheirs: number | null = null;
  if (markTheirs) {
    const standing = (n: number | undefined): n is number =>
      n !== undefined && Number.isInteger(n) && n >= 0 && n < enemyCount && n !== theirs && !faintedTheirs.includes(n);
    if (standing(t.sendIn.theirs)) sendTheirs = t.sendIn.theirs;
    else for (let n = 0; n < enemyCount; n++) if (standing(n)) { sendTheirs = n; break; }
  }
  let sendMine: string | null = null;
  if (markMine && inPool(t.sendIn.mine) && t.sendIn.mine !== mine && !faintedMine.includes(t.sendIn.mine)) sendMine = t.sendIn.mine;

  const ownWeather = was.ownWeather || t.field.weather !== undefined;
  const ownTrickRoom = was.ownTrickRoom || t.field.trickRoom !== undefined;
  const base = i === 0 ? was.field : carryField(was.field, { player: mine !== was.prevMine, enemy: theirs !== was.prevTheirs });
  const field = patched(base, t.field);

  const row: ResolvedTurn = {
    turn: i + 1, mine, theirs,
    faintedBefore: { mine: [...faintedMine], theirs: [...faintedTheirs] },
    pick: pick ? { ...pick } : null,
    fainted: { mine: markMine, theirs: markTheirs },
    sendIn: { mine: sendMine, theirs: sendTheirs },
    field: copyField(field), ownWeather, ownTrickRoom,
  };

  let carriedTheirs = was.theirs;
  let carriedMine: string | null;
  if (markTheirs) { faintedTheirs.push(theirs!); carriedTheirs = sendTheirs; }
  if (markMine) { faintedMine.push(mine!); carriedMine = sendMine; }
  else if (pick && pick.kind === 'switch') carriedMine = pick.to;
  else carriedMine = mine;
  return { row, next: { mine: carriedMine, theirs: carriedTheirs, faintedMine, faintedTheirs, field, prevMine: mine, prevTheirs: theirs, ownWeather, ownTrickRoom } };
}

export function resolve(plan: Plan): ResolvedTurn[] {
  const { start } = plan;
  const pool = new Set(start.mons.map((m) => m.key));
  const inPool = (k: string | null | undefined): k is string => k !== null && k !== undefined && pool.has(k);
  const enemyCount = start.enemies.length;
  const out: ResolvedTurn[] = [];

  const field = defaultField(plan.weather0 ?? 'none', plan.trickRoom0 ?? false);
  if (plan.stages0 !== undefined) field.stages = startStagesOf(plan.stages0);
  let carry: Carry = {
    mine: inPool(start.lead) ? start.lead : null, theirs: enemyCount > 0 ? 0 : null,
    faintedMine: [], faintedTheirs: [], field, prevMine: null, prevTheirs: null, ownWeather: false, ownTrickRoom: false,
  };

  plan.turns.forEach((t, i) => {
    // A try not yet kept is shown on its own turn (when it applies), and the turns after carry on from the turn as it was.
    const as = stepTurn(untriedTurn(t), i, carry, inPool, enemyCount);
    let row = as.row;
    if (t.before !== undefined && t.mine !== undefined) {
      const trying = stepTurn(t, i, carry, inPool, enemyCount);
      if (trying.row.mine === t.mine) row = trying.row;
    }
    out.push(row);
    carry = as.next;
  });
  return out;
}

/**
 * His active on turn `turn` (an index) if that turn's own `mine` were not set: who the turns before carry in; null when
 * none (his faint with no replacement), or no such turn.
 */
export function carriedMine(plan: Plan, turn: number): string | null {
  const t = plan.turns[turn];
  if (t === undefined) return null;
  if (t.mine === undefined && t.before === undefined) return resolve(plan)[turn]!.mine;
  const without: PlanTurn = { ...t };
  delete without.mine;
  delete without.before;
  const turns = plan.turns.slice();
  turns[turn] = without;
  return resolve({ ...plan, turns })[turn]!.mine;
}

/** `plan` without the pool Pokémon in `keys` that no turn and not the lead names any more. */
export function withoutUnnamed(plan: Plan, keys: readonly string[]): Plan {
  if (keys.length === 0) return plan;
  const named = namedKeys(plan);
  const mons = plan.start.mons.filter((m) => named.has(m.key) || !keys.includes(m.key));
  return mons.length === plan.start.mons.length ? plan : { ...plan, start: { ...plan.start, mons } };
}

/**
 * The plan without its last turn, the cursor clamped onto what is left, and without a Pokémon only that turn's try brought
 * in; with one turn, the plan as given.
 */
export function withoutLastTurn(plan: Plan): Plan {
  if (plan.turns.length <= 1) return plan;
  const turns = plan.turns.slice(0, -1);
  const cut = { ...plan, turns, cursor: Math.min(plan.cursor, turns.length - 1) };
  return withoutUnnamed(cut, plan.turns[plan.turns.length - 1]!.before?.added ?? []);
}

export function ending(plan: Plan): 'complete' | 'allFainted' | null {
  const rs = resolve(plan);
  const last = rs[rs.length - 1];
  if (!last) return null;
  const theirs = new Set(last.faintedBefore.theirs);
  if (last.fainted.theirs && last.theirs !== null) theirs.add(last.theirs);
  const mine = new Set(last.faintedBefore.mine);
  if (last.fainted.mine && last.mine !== null) mine.add(last.mine);
  const enemies = plan.start.enemies;
  if (enemies.length > 0 && enemies.every((_, n) => theirs.has(n))) return 'complete';
  const tried = trialOnly(plan);
  const his = plan.start.mons.filter((m) => !tried.has(m.key));
  if (his.length > 0 && his.every((m) => mine.has(m.key))) return 'allFainted';
  return null;
}

export function canNext(plan: Plan): boolean {
  if (ending(plan) !== null) return false;
  const rs = resolve(plan);
  const last = rs[rs.length - 1];
  if (!last || last.mine === null || last.theirs === null) return false;
  return !(last.fainted.mine && last.sendIn.mine === null);
}

/**
 * His team on a request: the active first, then up to five others still standing, in the pool's order, leaving out a
 * Pokémon only a try not yet kept on another turn brought in. The weather is left out (the battle start's) while no turn
 * up to this one set one, on turn 1 always and on a later turn while the start's is not known yet (`weather0`). Trick Room
 * the same (`trickRoom0`), so a fight that starts in a permanent Trick Room is planned in it.
 */
export function stepRequest(plan: Plan, turn: number): PlanStepRequestJson | null {
  const r = resolve(plan)[turn];
  if (!r || r.mine === null || r.theirs === null) return null;
  const active = plan.start.mons.find((m) => m.key === r.mine)!;
  const tried = trialOnly(plan);
  const others = plan.start.mons.filter((m) => m.key !== r.mine && !r.faintedBefore.mine.includes(m.key) && !tried.has(m.key)).slice(0, 5);
  const team = [active, ...others];
  const field: PlanStepRequestJson['state']['field'] = copyField(r.field);
  if (!r.ownWeather && (turn === 0 || plan.weather0 === null)) delete field.weather;
  if (!r.ownTrickRoom && (turn === 0 || plan.trickRoom0 === undefined)) delete field.trickRoom;
  return {
    trainerId: plan.start.trainerId, variant: plan.start.variant, world: plan.start.world,
    team: team.map((m) => m.ref),
    draft: team.map((m) => m.entry),
    state: {
      player: { active: active.ref, fainted: r.fainted.mine ? [active.ref] : [] },
      enemy: { active: r.theirs, fainted: r.fainted.theirs ? [...r.faintedBefore.theirs, r.theirs] : [...r.faintedBefore.theirs] },
      field,
    },
  };
}

export const requestKey = (req: PlanStepRequestJson): string => JSON.stringify(req);

/**
 * The send-out with the highest probability, compared exactly; a tie goes to the lower index. Below the full AI odds
 * (aiOdds.ts), with no probabilities, the one marked likeliest or ranked first, a tie to the lower index; none unmarked.
 */
export function likeliest(sendOut: PlanSendOutJson): number | null {
  if (sendOut.choices.some((c) => c.probability === undefined)) {
    const top = sendOut.choices.filter((c) => c.likeliest === true || c.rank === 1).map((c) => c.index);
    return top.length === 0 ? null : Math.min(...top);
  }
  let best: PlanSendOutJson['choices'][number] | null = null;
  for (const c of sendOut.choices) {
    if (!best) { best = c; continue; }
    const lhs = BigInt(c.probability!.num) * BigInt(best.probability!.den);
    const rhs = BigInt(best.probability!.num) * BigInt(c.probability!.den);
    if (lhs > rhs || (lhs === rhs && c.index < best.index)) best = c;
  }
  return best ? best.index : null;
}
