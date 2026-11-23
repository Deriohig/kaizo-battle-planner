// What the plan page keeps in the browser, and the plain text it shows and copies. A plan is kept per trainer copy in
// `localStorage` under its own keys (never the tree's): the one being written (always) and the ones the player named. Every read
// and write is wrapped: the storage can be missing or refuse (a private window), and the page then works without it.

import type { BoxJson, BoxMonJson, DraftMonJson, MonRef } from '../../src/server/apiTypes';
import { canJoin, tidy, type Options } from './draft';
import { monName } from './labels';
import type { SaveId } from './line';
import { ending, MAX_TURNS, resolve, type Plan, type PlanFieldPatch, type PlanMon, type PlanPick, type PlanTrial, type PlanTurn } from './plan';
import type { PlanStages, PlanStartStages, PlanWeather } from './planTypes';

export interface PlanRecord { v: 1; save: SaveId | null; plan: Plan }
export interface SavedPlan extends PlanRecord { name: string }

export const planCurrentKey = (trainerId: string, variant: number): string => `pkp.plan.current.${trainerId}.${variant}`;
export const planSavedKey = (trainerId: string, variant: number): string => `pkp.plan.saved.${trainerId}.${variant}`;

const WEATHERS: readonly string[] = ['none', 'sun', 'rain', 'sand', 'hail'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isString = (value: unknown): value is string => typeof value === 'string';

/** A pick, null for none, or undefined when it is not one. */
function toPick(value: unknown): PlanPick | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isString(value.by)) return undefined;
  if (value.kind === 'move' && whole(value.slot) && isString(value.name)) return { kind: 'move', by: value.by, slot: value.slot, name: value.name };
  if (value.kind === 'switch' && isString(value.to)) return { kind: 'switch', by: value.by, to: value.to };
  return undefined;
}

/** What a try not yet kept holds of its turn (`PlanTrial`), or undefined when it is not one: every field checked. */
function toTrial(value: unknown): PlanTrial | undefined {
  if (!isRecord(value)) return undefined;
  const pick = toPick(value.pick);
  if (pick === undefined) return undefined;
  const trial: PlanTrial = { pick };
  for (const k of ['mine', 'fainted', 'sendIn'] as const) {
    const v = value[k];
    if (v === undefined) continue;
    if (!isString(v)) return undefined;
    trial[k] = v;
  }
  if (value.added !== undefined) {
    if (!Array.isArray(value.added) || !value.added.every(isString)) return undefined;
    trial.added = [...value.added];
  }
  return trial;
}

/**
 * One turn, or null when it is not one. A try not yet kept (`before`) is read whole or the turn is not read at all:
 * dropping it would make the try kept. A try is always on a Pokémon, so `before` needs the turn's own `mine`.
 */
function toTurn(value: unknown): PlanTurn | null {
  if (!isRecord(value)) return null;
  const pick = toPick(value.pick);
  if (pick === undefined) return null;
  const { fainted, sendIn, field } = value;
  if (!isRecord(fainted) || !isRecord(sendIn) || !isRecord(field) || !isString(value.note)) return null;
  if (value.mine !== undefined && !isString(value.mine)) return null;
  const turn: PlanTurn = { pick, fainted: {}, sendIn: {}, field: field as PlanFieldPatch, note: value.note };
  if (value.mine !== undefined) turn.mine = value.mine;
  if (value.before !== undefined) {
    const before = toTrial(value.before);
    if (before === undefined || turn.mine === undefined) return null;
    turn.before = before;
  }
  if (isString(fainted.mine)) turn.fainted.mine = fainted.mine;
  if (whole(fainted.theirs)) turn.fainted.theirs = fainted.theirs;
  if (isString(sendIn.mine)) turn.sendIn.mine = sendIn.mine;
  if (whole(sendIn.theirs)) turn.sendIn.theirs = sendIn.theirs;
  if (sendIn.theirsPicked === true) turn.sendIn.theirsPicked = true;
  return turn;
}

function toMons(value: unknown): PlanMon[] | null {
  if (!Array.isArray(value)) return null;
  const mons: PlanMon[] = [];
  for (const m of value) {
    if (!isRecord(m) || !isString(m.key) || !isString(m.ref) || !isString(m.name) || !isRecord(m.entry) || m.entry.ref !== m.ref) return null;
    const key = m.key;
    if (mons.some((x) => x.key === key)) return null;
    mons.push({ key, ref: m.ref as MonRef, name: m.name, entry: m.entry as unknown as DraftMonJson });
  }
  return mons;
}

const STATS: readonly string[] = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'];

/** One side's stages when every key is a stat with a whole stage from -6 to 6, else undefined. */
function toStages(value: unknown): PlanStages | undefined {
  if (!isRecord(value)) return undefined;
  const out: PlanStages = {};
  for (const [stat, v] of Object.entries(value)) {
    if (!STATS.includes(stat) || typeof v !== 'number' || !Number.isInteger(v) || v < -6 || v > 6) return undefined;
    out[stat as keyof PlanStages] = v;
  }
  return out;
}

/** The battle start's stages as kept, or undefined when they are not readable (they are learned again from the next answer). */
function toStartStages(value: unknown): PlanStartStages | undefined {
  if (!isRecord(value)) return undefined;
  const player = toStages(value.player);
  const enemy = toStages(value.enemy);
  return player === undefined || enemy === undefined ? undefined : { player, enemy };
}

/** A kept plan as the page reads it, or null when it is not one. Unknown keys are dropped, and an unreadable start Trick Room or start stages. */
export function toPlanRecord(value: unknown): PlanRecord | null {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.plan)) return null;
  const p = value.plan;
  const s = p.start;
  if (!isRecord(s) || !isString(s.trainerId) || !whole(s.variant) || !whole(s.world) || !isString(s.lead)) return null;
  const mons = toMons(s.mons);
  if (mons === null) return null;
  if (!Array.isArray(s.enemies) || !s.enemies.every(isString)) return null;
  if (!Array.isArray(p.turns) || p.turns.length === 0 || p.turns.length > MAX_TURNS) return null;
  const turns: PlanTurn[] = [];
  for (const t of p.turns) {
    const turn = toTurn(t);
    if (turn === null) return null;
    turns.push(turn);
  }
  if (!isString(p.note)) return null;
  if (p.weather0 !== null && !(isString(p.weather0) && WEATHERS.includes(p.weather0))) return null;
  const cursor = whole(p.cursor) && p.cursor < turns.length ? p.cursor : turns.length - 1;
  const { save } = value;
  const plan: Plan = {
    start: { trainerId: s.trainerId, variant: s.variant, world: s.world, mons, lead: s.lead, enemies: [...(s.enemies as string[])] },
    turns, cursor, note: p.note, weather0: p.weather0 as PlanWeather | null,
  };
  // The start's Trick Room: one that is not true or false is left out, learned again from the next turn-1 answer.
  if (typeof p.trickRoom0 === 'boolean') plan.trickRoom0 = p.trickRoom0;
  const stages0 = toStartStages(p.stages0);
  if (stages0 !== undefined) plan.stages0 = stages0;
  return {
    v: 1,
    save: isRecord(save) && isString(save.savePath) && isString(save.savedAt) ? { savePath: save.savePath, savedAt: save.savedAt } : null,
    plan,
  };
}

function read(key: string): unknown {
  try {
    const text = localStorage.getItem(key);
    return text === null ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The storage is unavailable: the plan just is not kept.
  }
}

export function readCurrentPlan(trainerId: string, variant: number): PlanRecord | null {
  return toPlanRecord(read(planCurrentKey(trainerId, variant)));
}

export function writeCurrentPlan(trainerId: string, variant: number, record: PlanRecord | null): void {
  write(planCurrentKey(trainerId, variant), record);
}

/** The stored bytes of the current plan, so Clear can hold them and Undo put the same bytes back. */
export function readCurrentPlanText(trainerId: string, variant: number): string | null {
  try {
    return localStorage.getItem(planCurrentKey(trainerId, variant));
  } catch {
    return null;
  }
}

export function writeCurrentPlanText(trainerId: string, variant: number, text: string | null): void {
  try {
    if (text === null) localStorage.removeItem(planCurrentKey(trainerId, variant));
    else localStorage.setItem(planCurrentKey(trainerId, variant), text);
  } catch {
    // The storage is unavailable: the plan just is not kept.
  }
}

/** The plans the player named for a trainer copy, oldest first. */
export function readSavedPlans(trainerId: string, variant: number): SavedPlan[] {
  const value = read(planSavedKey(trainerId, variant));
  if (!Array.isArray(value)) return [];
  return value.flatMap((v): SavedPlan[] => {
    const record = toPlanRecord(v);
    const name = isRecord(v) ? v.name : undefined;
    return record === null || typeof name !== 'string' ? [] : [{ name, ...record }];
  });
}

export function writeSavedPlans(trainerId: string, variant: number, plans: SavedPlan[]): void {
  write(planSavedKey(trainerId, variant), plans.length === 0 ? null : plans);
}

/**
 * `record` moved onto the save `box` is, by each pool Pokémon's key: it becomes the box Pokémon with that key that can
 * join and no earlier one took (the one still at its ref first), with that ref, its name and its entry moved and tidied. One
 * with no such Pokémon leaves the pool and its old name goes in `missing`. Turns, lead and keys stay as they are.
 */
export function refoundPlan(box: BoxJson, options: Options, record: PlanRecord): { record: PlanRecord; missing: string[] } {
  const joins = box.mons.filter(canJoin);
  const taken: MonRef[] = [];
  const mons: PlanMon[] = [];
  const missing: string[] = [];
  for (const pm of record.plan.start.mons) {
    const free = (m: BoxMonJson) => m.key === pm.key && !taken.includes(m.ref);
    const mon = joins.find((m) => free(m) && m.ref === pm.ref) ?? joins.find(free);
    if (mon === undefined) { missing.push(pm.name); continue; }
    taken.push(mon.ref);
    mons.push({ key: pm.key, ref: mon.ref, name: monName(mon), entry: tidy(mon, options, { ...pm.entry, ref: mon.ref }) });
  }
  return { record: { ...record, plan: { ...record.plan, start: { ...record.plan.start, mons } } }, missing };
}

// ---- Rows and text -------------------------------------------------------------------------------------------------

export interface TurnRow {
  turn: number; mine: string | null; theirs: string | null; pick: string | null; fainted: string[];
  note: string; excerpt: string; current: boolean;
}

export const NOTE_EXCERPT = 40;

/** The note's first non-empty line, trimmed, cut to `NOTE_EXCERPT` with a `…` when cut or when more lines follow. */
function excerptOf(note: string): string {
  const lines = note.split('\n');
  const at = lines.findIndex((l) => l.trim() !== '');
  if (at < 0) return '';
  const first = lines[at]!.trim();
  const more = lines.slice(at + 1).some((l) => l.trim() !== '');
  return first.length > NOTE_EXCERPT || more ? `${first.slice(0, NOTE_EXCERPT)}…` : first;
}

export function turnRows(plan: Plan): TurnRow[] {
  const { mons, enemies } = plan.start;
  const nameOf = (key: string): string => mons.find((m) => m.key === key)?.name ?? '';
  return resolve(plan).map((r, i) => {
    const mine = r.mine === null ? null : nameOf(r.mine);
    const theirs = r.theirs === null ? null : enemies[r.theirs] ?? null;
    let pick: string | null = null;
    if (r.pick) pick = r.pick.kind === 'move' ? r.pick.name : `switch to ${nameOf(r.pick.to)}`;
    const fainted: string[] = []; // his first
    if (r.fainted.mine && mine !== null) fainted.push(`${mine} fainted`);
    if (r.fainted.theirs && theirs !== null) fainted.push(`${theirs} fainted`);
    const note = plan.turns[i]!.note;
    return { turn: r.turn, mine, theirs, pick, fainted, note, excerpt: excerptOf(note), current: i === plan.cursor };
  });
}

export function turnText(row: TurnRow, excerpt = true): string {
  const parts = [`T${row.turn}`];
  if (row.mine !== null) parts.push(row.pick !== null ? `${row.mine}: ${row.pick}` : row.mine);
  parts.push(...row.fainted);
  if (excerpt && row.excerpt !== '') parts.push(row.excerpt);
  return parts.join(' · ');
}

export const planComplete = (trainer: string): string => `Plan complete: all of ${trainer}'s Pokémon marked fainted.`;
export const ALL_YOURS_FAINTED = 'All of your Pokémon are marked fainted.';

export function planText(heading: { trainer: string; copies: number }, plan: Plan): string {
  const copy = heading.copies > 1 ? ` (copy ${plan.start.variant + 1})` : '';
  const lines = [`${heading.trainer}${copy} — ${plan.start.mons.map((m) => m.name).join(', ')}`];
  if (plan.note !== '') lines.push(plan.note);
  for (const row of turnRows(plan)) {
    lines.push(turnText(row, false));
    for (const l of row.note.split('\n')) if (l !== '') lines.push(`  ${l}`);
  }
  const end = ending(plan);
  if (end === 'complete') lines.push(planComplete(heading.trainer));
  else if (end === 'allFainted') lines.push(ALL_YOURS_FAINTED);
  return lines.join('\n');
}
