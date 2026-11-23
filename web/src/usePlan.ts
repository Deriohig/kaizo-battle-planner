// The plan on the page: the turns the player writes, one step each, kept in the browser as he goes (planStore.ts), with the
// numbers for the turn under the cursor. No outcome is ever stored or worked out: HP never changes, and the one request
// is one state's calc (`POST /api/plan/step`).
//
// Every action works on the cursor's turn and does nothing without a plan. Each one but the two note setters writes the
// plan at once, then calls `ensure`, the one place a request is made. `ensure` reuses useLine's proven parts: the state in
// a ref beside React state, an epoch every request holds and checks after its await (an overtaken result is dropped,
// whatever it is), one AbortController per request, Stop offered after `SLOW_MS`, and `idle()` clearing busy, working and
// slow. Answers are held by their exact request, so a state seen before shows its numbers again without asking.
//
// A field edit is kept and shown at once, but asked about only `FIELD_DEBOUNCE_MS` after his last one (`pending`
// meanwhile): a request already out is for a state that is gone, so it is aborted at the edit. Any other action asks at
// once, the waiting edit in its state.
//
// What an answer teaches the plan (`learn`): the weather the battle starts in (`weather0`), whether it starts in Trick Room
// (`trickRoom0`: a trainer's permanent Trick Room; turn 1 asks with neither, so the server says), the stat stages the battle start
// gives the two actives (`stages0`, such as an Intimidate's Atk -1, carried into turn 1 under his own stages), and their
// likeliest send-out. A turn-1 answer whose start stages change turn 1's state is asked again, its numbers kept as `stale`.
//
// What arrived (`arrival`) is said once per cursor move, at once, for the page to focus and announce in its one polite
// status region. A kept plan opens through `open` too: `restore` (said only when he clicked to open it), and `undo`.
//
// A kept plan opened (`restore`) is not written until his next action, so looking at one on another save never rewrites it
// (`quiet`): even what its first answer teaches stays on the page only. Nothing he wrote is replaced without words
// (`keepAside`): a new plan (`begin`) never writes over a kept one that is not on the page (one on another save that did not
// open, or one the page cannot read) or a cleared one held for Undo, and a saved copy opened (`openCopy`) never drops the
// plan on the page, a cleared one or a kept one that did not open: each goes into the named copies first, unless it is
// already a copy unchanged, and the notice says where. Save a copy never replaces one: a name in use takes a free one.
//
// The plan follows the team (`setMons`). When the save changed, a Pokémon a turn names that is not on the team is found
// again by key over the whole box, as `refoundPlan` moves a kept plan, never kept at its old ref (another save's); one not
// found leaves the pool and is named in the notice. Following is not his edit, so a removed turn's Undo stays on offer. Clear plan (`clear`) removes what is kept at once
// and holds the plan with the stored bytes, as useLine's Clear tree does; `undo` writes the same bytes back. The hold is
// dropped by any plan reaching the page (`begin`, a `restore` that opens, `undo`) and by `reset`, so a late Undo does nothing.
// Remove this turn (`removeLastTurn`) is held the same way, for the same `undo`, and its hold is also dropped by his next
// edit (`keep`), so an Undo never takes back more than the removed turn. A jump to another turn is not an edit.
//
// A try (`tryMon`) is his on its own turn only, until Keep (`keepTry`): the turn keeps what it had in `before`, and the
// turns after carry on from that (plan.ts `resolve`), so no later pick, mark or note is touched. Back (`setMine(null)`)
// puts the turn back from `before` and takes out a Pokémon only the try brought in.
//
// While a turn's numbers are worked out, the answer last shown on that turn stays on offer (`stale`), remembered per turn
// index and forgotten with the plan, and for a removed turn's index.
//
// Named copies are written entry by entry over what is stored: an entry the page cannot read is counted and said
// (`savedSkipped`, `savedProblem`), and kept as it was, never dropped by a later write: only `removeUnreadable` drops them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Choice } from '../../src/contracts/engine';
import type { BoxJson } from '../../src/server/apiTypes';
import { ApiError, errorMessage, isAbort, NO_ANSWER, postPlanStep, type PlanStepFn } from './api';
import type { Options } from './draft';
import { sameSave, saveOf, type SaveId } from './line';
import {
  canNext as planCanNext, EMPTY_TURN, ending, likeliest, MAX_TURNS, namedKeys, newPlan, patchOf, requestKey, resolve, sameStartStages, startStagesOf,
  stepRequest, trialOnly, untriedTurn, withoutLastTurn, withoutUnnamed, type Plan, type PlanMon, type PlanStart, type PlanTrial, type PlanTurn,
  type ResolvedTurn,
} from './plan';
import {
  planSavedKey, readCurrentPlanText, readSavedPlans, refoundPlan, toPlanRecord, turnRows, writeCurrentPlan, writeCurrentPlanText,
  type PlanRecord, type SavedPlan, type TurnRow,
} from './planStore';
import type { PlanFieldJson, PlanStepJson, PlanStepRequestJson } from './planTypes';

const DEFAULT_STEP: PlanStepFn = postPlanStep;

/** How long a turn's numbers are worked out before the page offers Stop. */
export const SLOW_MS = 8000;

/** How long after his last field edit the turn is asked about: a burst of edits (a stage stepped three times) asks once. */
export const FIELD_DEBOUNCE_MS = 150;

/** How many times one `ensure` asks: a turn-1 answer that teaches the start's stages changes turn 1's state, asked again. */
const MAX_ROUNDS = 3;

/** A failed request in the page's words. `retry`: Try again may help. `detail`: the server's words, shown behind "Details". */
export interface PlanFailure { text: string; retry: boolean; detail?: string }

const NAMED = new Set(['UNSUPPORTED_DOUBLE', 'UNMODELLED_ITEM', 'LIMIT']);

export function planFailureOf(e: unknown): PlanFailure {
  if (!(e instanceof ApiError)) return { text: errorMessage(e), retry: false };
  if (e.code === NO_ANSWER) return { text: 'No answer from the planner. Your plan is kept; this turn has no numbers yet.', retry: true };
  if (e.code === 'BAD_START') return { text: 'This fight cannot be set up with the team as it is.', retry: false, detail: e.message };
  if (e.code !== undefined && NAMED.has(e.code)) return { text: `The planner could not work this turn out (${e.code}).`, retry: false, detail: e.message };
  return { text: 'This turn could not be worked out.', retry: true, detail: e.message };
}

const isDraftRefusal = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 400 && e.message.startsWith('draft');

export interface UsePlan {
  plan: Plan | null; save: SaveId | null;
  /** resolve(plan); [] without a plan. */
  turns: ResolvedTurn[];
  /** turnRows(plan): one per turn, with its note and the note's excerpt; [] without a plan. */
  rows: TurnRow[];
  /** plan.note; '' without a plan. */
  fightNote: string;
  /** The cursor's turn. */
  current: ResolvedTurn | null;
  /** The cursor's numbers, only when held for its state exactly as it is now: the panels' `node` as it is. */
  answer: PlanStepJson | null;
  /** The turn's pick as the panels' `selected`: at turnChoice the applied pick, at playerReplacement the replacement; null when none, or no answer. */
  selected: { choice: Choice | null } | null;
  /** What a panel hands back: a move or a switch at turnChoice is the pick; a switch at playerReplacement is sendIn('mine'). */
  choose(choice: Choice): void;
  ended: 'complete' | 'allFainted' | null; canNext: boolean;
  busy: boolean; working: { turn: number } | null; slow: boolean;
  stop(): void;
  /** A field edit waits to be asked about (`FIELD_DEBOUNCE_MS`); Stop, `reset`, `begin` and any other action drop the wait. */
  pending: boolean;
  /** A request could be made for the cursor's turn, none is running or waiting on a field edit, and no answer is held. */
  unsettled: boolean;
  workOut(): Promise<void>;
  /** retry is workOut. */
  failure: PlanFailure | null; retry(): void;
  notice: string | null; draftProblem: string | null;
  arrival: { seq: number; kind: 'turn' | 'open' } | null;
  /**
   * A new plan, kept at once. A kept plan for this fight that is not the one on the page, and a cleared one held for Undo,
   * go into the named copies first (`keepAside`), said in `notice`; when that copy cannot be written nothing starts, and
   * that is said.
   */
  begin(start: PlanStart, save: SaveId): Promise<void>;
  /** The hook adds `by`. */
  pick(pick: { kind: 'move'; slot: number; name: string } | { kind: 'switch'; to: string } | null): void;
  toggleFainted(side: 'mine' | 'theirs'): Promise<void>;
  sendIn(side: 'mine', key: string): void;
  sendIn(side: 'theirs', index: number): void;
  /**
   * Any pool Pokémon as his active on this turn, set outright: it carries on at once. null is Back: a try not yet kept puts
   * the turn back exactly as it was (its Pokémon, pick, fainted mark and replacement) and takes out a Pokémon only the try
   * brought in; else the turn's own Pokémon goes back to the carried one.
   */
  setMine(key: string | null): Promise<void>;
  /**
   * Tries it on this turn: his on this turn only, the later turns as they were, until `keepTry`. Added to the pool when its
   * key is new. Does nothing for the Pokémon on the field, or one fainted before this turn.
   */
  tryMon(mon: PlanMon): Promise<void>;
  /** Keep: the try on this turn becomes his for good, carried into the turns after (kept in the plan). */
  keepTry(): Promise<void>;
  /** Kept at once; asked about `FIELD_DEBOUNCE_MS` after the last edit. */
  setField(next: PlanFieldJson): Promise<void>;
  setWorld(world: number): Promise<void>;
  setNote(text: string): void; setFightNote(text: string): void;
  /** At the last turn: appends one when canNext, up to `MAX_TURNS` (past it `notice` says `TURN_LIMIT`); before it: goTo(cursor + 1). */
  nextTurn(): Promise<void>;
  /** 1-based; "Back" is goTo(current.turn - 1). */
  goTo(turn: number): Promise<void>;
  /** The plan leaves the page; what is kept stays. */
  reset(): void;
  /**
   * Opens a kept plan on the save `box` is: as it was on its own save, else moved onto this one (`refoundPlan`), with who is
   * gone said in `notice`; with none of its Pokémon left it is not opened. Writes nothing until his next action.
   * `arrives: 'open'`: he clicked to open it, so `arrival` says `open`.
   */
  restore(record: PlanRecord, box: BoxJson, options?: Options, arrives?: 'open'): Promise<void>;
  /**
   * The team as it is now: the pool becomes `mons`, plus any old pool Pokémon a turn still names; `save` when given. On a
   * save other than the plan's, each of those is found again by key over `box` (its ref, name and entry moved, tidied by
   * `options`); one not in it, or every one when no box is given, leaves the pool and is named in `notice`. Not his edit:
   * a removed turn's Undo stays on offer.
   */
  setMons(mons: PlanMon[], save?: SaveId, box?: BoxJson, options?: Options): Promise<void>;
  /** Clear plan: what is kept goes at once and the plan leaves the page, both held for `undo`. */
  clear(): void;
  /** How many turns the cleared plan has, while Undo is on offer; null when none is. */
  cleared: number | null;
  /** Remove this turn: on the last turn of several only, drops it and keeps the plan, says arrival 'turn', then works it out. */
  removeLastTurn(): Promise<void>;
  /** The turn number `removeLastTurn` removed, while its Undo is on offer; null when none is. */
  removed: number | null;
  /**
   * Undo for both Clear plan and Remove this turn (only one is ever on offer): puts the plan back as it was (cursor, notes,
   * notice) and the same bytes back in storage; late, it does nothing.
   */
  undo(): Promise<void>;
  /** The answer last shown on the cursor's turn, while `answer` is null; null on a turn never answered here, or when `answer` is shown. */
  stale: PlanStepJson | null;
  /** The cursor's turn has a try not yet kept that applies: who, and who Back puts back; else null. */
  tried: { key: string; previous: string | null } | null;
  /** This fight's named copies, oldest first; [] without a plan. */
  saved: SavedPlan[];
  /** How many stored copies for this fight could not be read (not in `saved`, kept in storage as they are); 0 without a plan. */
  savedSkipped: number;
  /** `savedSkipped` in the page's words; null when it is 0. */
  savedProblem: string | null;
  /**
   * The name trimmed; an empty one does nothing (null). Never replaces a saved plan: a name in use takes the next free one,
   * "X (2)". Returns the name it took, or null when nothing was saved (`savedCopyText` says either).
   */
  saveCopy(name: string): string | null;
  /**
   * Opens a saved copy as `restore` does, said as an arrival 'open'. The plan it replaces never goes without words: the one on
   * the page (with a removed turn's Undo, as it was before the removal), a cleared one held for Undo, or a kept one that did
   * not open goes into the named copies first, said in `notice`, unless it is already a copy unchanged. When that copy
   * cannot be written nothing opens, and that is said. The copy then becomes the kept plan, its bytes as saved.
   */
  openCopy(copy: SavedPlan, box: BoxJson, options?: Options): Promise<void>;
  removeSaved(name: string): void;
  /** Drops the stored copies that cannot be read (`savedSkipped`), the readable ones left as they are. The screen confirms first. */
  removeUnreadable(): void;
}

export const NONE_LEFT = "None of this plan's Pokémon are in this save, so it was not opened.";
export const saveChanged = (missing: string[]): string => `Your save changed since this plan was written. Not in this save: ${missing.join(', ')}.`;
/** `saveChanged` when the plan follows a team on another save with no box to look in: they may be in the box. */
export const notOnTeam = (missing: string[]): string => `Your save changed since this plan was written. Not on your team now: ${missing.join(', ')}.`;
export const TURN_LIMIT = `A plan holds at most ${MAX_TURNS} turns.`;
/** The names a plan about to be replaced is given in the named copies (`keepAside`). */
export const BEFORE_SAVE_CHANGE = 'Before save change';
export const EARLIER_PLAN = 'Earlier plan';
export const CLEARED_PLAN = 'Cleared plan';
export const UNREADABLE_PLAN = 'Plan that could not be read';
export const keptMoved = (name: string): string => `The plan kept for this fight was not opened, so it is in Saved plans as "${name}".`;
export const pageMoved = (name: string): string => `The plan that was on the page is in Saved plans as "${name}".`;
export const clearedMoved = (name: string): string => `The plan you cleared is in Saved plans as "${name}".`;
/** Kept with its bytes, but Saved plans lists only the copies it can read, so it is said as not listed. */
export const KEPT_UNREADABLE = 'The plan kept for this fight could not be read. It is kept as it was, but Saved plans cannot list it.';
/** Which plan was about to be replaced (`keepAside`): one kept but not on the page, the one on the page, or one cleared and held for Undo. */
type Aside = 'kept' | 'page' | 'cleared';
const ASIDE_WHO: Record<Aside, string> = { kept: 'The plan kept for this fight', page: 'The plan on the page', cleared: 'The plan you cleared' };
/** Its copy could not be written, so what was asked for did not happen. */
export const notMoved = (who: Aside, then: 'begin' | 'open'): string =>
  `${ASIDE_WHO[who]} could not be moved to Saved plans, so ${then === 'begin' ? 'no new plan was started' : 'the saved plan was not opened'}.`;
export const KEPT_NOT_MOVED = notMoved('kept', 'begin');
/** Save a copy, in words: the name it took (a free one beside a name in use), or that it could not be written. */
export const savedCopyText = (wanted: string, as: string | null): string => {
  if (as === null) return 'The copy could not be saved.';
  return as === wanted ? `Saved a copy of the plan as ${as}.` : `Saved a copy of the plan as ${as}. A saved plan is already named ${wanted}.`;
};
export const savedProblemText = (n: number): string | null => {
  if (n === 0) return null;
  return n === 1
    ? '1 saved plan for this fight could not be read, so it is not listed.'
    : `${n} saved plans for this fight could not be read, so they are not listed.`;
};

/** A stored copy's name when the page can read it (as `readSavedPlans` does), else null. */
function copyName(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || toPlanRecord(value) === null) return null;
  const { name } = value as { name?: unknown };
  return typeof name === 'string' ? name : null;
}

/**
 * Every stored copy for a trainer copy as stored, readable or not; [] when nothing is stored (or no storage). A stored value
 * that is not a list is one unreadable copy holding its bytes (`readCopies` counts it as one), so a write keeps it.
 */
function storedCopies(trainerId: string, variant: number): unknown[] {
  let text: string | null = null;
  try {
    text = localStorage.getItem(planSavedKey(trainerId, variant));
  } catch {
    return [];
  }
  if (text === null) return [];
  try {
    const value = JSON.parse(text) as unknown;
    if (Array.isArray(value)) return value;
  } catch { /* not JSON */ }
  return [{ kept: text }];
}

/**
 * The readable copies, and how many stored ones are not, by the same rule the writes keep them by (`copyName`), so the
 * count is exactly what `removeUnreadable` drops. A stored value that is not a list counts as one.
 */
export function readCopies(trainerId: string, variant: number): { list: SavedPlan[]; skipped: number } {
  const list = readSavedPlans(trainerId, variant);
  let text: string | null = null;
  try { text = localStorage.getItem(planSavedKey(trainerId, variant)); } catch { /* no storage: nothing is kept */ }
  if (text === null) return { list, skipped: 0 };
  let value: unknown = null;
  try { value = JSON.parse(text); } catch { /* not JSON */ }
  return { list, skipped: Array.isArray(value) ? value.filter((e) => copyName(e) === null).length : 1 };
}

function writeCopies(trainerId: string, variant: number, entries: unknown[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(planSavedKey(trainerId, variant));
    else localStorage.setItem(planSavedKey(trainerId, variant), JSON.stringify(entries));
  } catch {
    // The storage is unavailable: the copy just is not kept.
  }
}

/** Drops the stored copies named `name`; the others, readable or not, stay as they are. With no plan on the page too. */
export function deleteCopy(trainerId: string, variant: number, name: string): void {
  const entries = storedCopies(trainerId, variant);
  const next = entries.filter((e) => copyName(e) !== name);
  if (next.length !== entries.length) writeCopies(trainerId, variant, next);
}

/** Drops the stored copies that cannot be read (`readCopies`' `skipped`); the readable ones stay. With no plan on the page too. */
export function dropUnreadable(trainerId: string, variant: number): void {
  writeCopies(trainerId, variant, storedCopies(trainerId, variant).filter((e) => copyName(e) !== null));
}

/** `base`, or the first of `base (2)`, `base (3)`, … that no readable stored copy is named. */
function freeName(base: string, entries: unknown[]): string {
  const used = new Set(entries.map(copyName));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} (${n})`)) return `${base} (${n})`;
}

const parsed = (text: string): unknown => {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
};

/** A stored plan as the page reads it, its name and unknown keys left out, as text to compare; null when it cannot be read. */
const recordText = (value: unknown): string | null => {
  const record = toPlanRecord(value);
  return record === null ? null : JSON.stringify(record);
};

/** The stored bytes `text` are already one of `entries`: the same plan as a readable copy, or the exact bytes of an unreadable one. */
function alreadyCopied(text: string, entries: unknown[]): boolean {
  const same = recordText(parsed(text));
  return entries.some((e) => (same === null
    ? typeof e === 'object' && e !== null && (e as { kept?: unknown }).kept === text
    : recordText(e) === same));
}

/**
 * Before a plan is replaced for a trainer copy (a new plan begun, a saved copy opened), each of `items`' stored bytes goes
 * into the named copies under a free name, so nothing he wrote is lost: one that is `skip` (the plan on the page that `begin`
 * starts over) or already a copy, unchanged, stays as it is and is not said. A cleared plan is "Cleared plan"; else one on
 * another save is "Before save change", one on this save "Earlier plan"; one the page cannot read is kept with its exact
 * bytes, an unreadable copy counted and kept like any other. `notice`: what to say (null when nothing moved). `ok` false:
 * the copies could not be written, so nothing may be written over; `who` names the first one.
 */
function keepAside(
  trainerId: string, variant: number, s: SaveId, items: ReadonlyArray<{ text: string | null; who: Aside }>, skip: string | null,
): { ok: true; notice: string | null } | { ok: false; who: Aside } {
  const entries = storedCopies(trainerId, variant);
  const added: unknown[] = [];
  const said: string[] = [];
  let first: Aside | null = null;
  const skipped = skip === null ? null : recordText(parsed(skip));
  for (const { text, who } of items) {
    if (text === null || text === skip) continue;
    const value = parsed(text);
    const record = toPlanRecord(value);
    if (record !== null && skipped !== null && JSON.stringify(record) === skipped) continue;
    const all = [...entries, ...added];
    if (alreadyCopied(text, all)) continue;
    if (record === null) {
      added.push({ name: freeName(UNREADABLE_PLAN, all), kept: text });
      said.push(KEPT_UNREADABLE);
    } else {
      const name = freeName(who === 'cleared' ? CLEARED_PLAN : sameSave(record.save, s) ? EARLIER_PLAN : BEFORE_SAVE_CHANGE, all);
      added.push({ ...(value as object), name });
      said.push(who === 'kept' ? keptMoved(name) : who === 'page' ? pageMoved(name) : clearedMoved(name));
    }
    first ??= who;
  }
  if (first === null) return { ok: true, notice: null };
  writeCopies(trainerId, variant, [...entries, ...added]);
  if (storedCopies(trainerId, variant).length !== entries.length + added.length) return { ok: false, who: first };
  return { ok: true, notice: said.join(' ') };
}

/** `record` as it opens on the save `box` is: as it was on its own save, else moved onto this one; null when none of its Pokémon are left. */
function landing(record: PlanRecord, box: BoxJson, options: Options): { next: Plan; said: string | null } | null {
  if (sameSave(record.save, saveOf(box))) return { next: record.plan, said: null };
  const moved = refoundPlan(box, options, record);
  if (moved.record.plan.start.mons.length === 0) return null;
  return { next: moved.record.plan, said: moved.missing.length > 0 ? saveChanged(moved.missing) : null };
}

/**
 * What Clear plan (`kind: 'clear'`) or Remove this turn (`'remove'`) took away, held for Undo: the plan as it was, its save,
 * the stored bytes exactly as they were (null when nothing was, `readCurrentPlanText`), the notice said of it, and whether it
 * was still unwritten since it was opened (`quiet`). A clear is held only while no plan is on the page; a removal only while
 * the cut plan is, untouched by him since.
 */
interface Hold { kind: 'clear' | 'remove'; plan: Plan; save: SaveId | null; kept: string | null; notice: string | null; quiet: boolean }

/** An answer and the request that produced it (a switch's index is a position in that request's `team`). */
interface Held { req: PlanStepRequestJson; answer: PlanStepJson }
const MAX_HELD = 64;

const copyTurn = (t: PlanTurn): PlanTurn => ({ ...t, fainted: { ...t.fainted }, sendIn: { ...t.sendIn } });
const blankTurn = (): PlanTurn => ({ ...EMPTY_TURN, fainted: {}, sendIn: {}, field: {} });

/** `plan` with turn `at` (the cursor's by default) replaced by `edit` of a copy of it. */
function withTurn(plan: Plan, edit: (t: PlanTurn) => PlanTurn, at = plan.cursor): Plan {
  const turns = plan.turns.slice();
  turns[at] = edit(copyTurn(plan.turns[at]!));
  return { ...plan, turns };
}

const cursorTurn = (p: Plan): ResolvedTurn => resolve(p)[p.cursor]!;

/** Whether `key` is a pool Pokémon that has not fainted before turn `r`. */
const standing = (plan: Plan, r: ResolvedTurn, key: string): boolean =>
  plan.start.mons.some((m) => m.key === key) && !r.faintedBefore.mine.includes(key);

/** `standing`, and not a Pokémon only a try not yet kept brought in: one he may switch to or send in. */
const switchable = (plan: Plan, r: ResolvedTurn, key: string): boolean => standing(plan, r, key) && !trialOnly(plan).has(key);

/** His Pokémon on turn `at` were its try not yet kept put back. */
const untriedMine = (plan: Plan, at = plan.cursor): string | null => resolve(withTurn(plan, untriedTurn, at))[at]!.mine;

/** What turn `t` has for his side, for Back to put back. */
function trialOf(t: PlanTurn): PlanTrial {
  const before: PlanTrial = { pick: t.pick };
  if (t.mine !== undefined) before.mine = t.mine;
  if (t.fainted.mine !== undefined) before.fainted = t.fainted.mine;
  if (t.sendIn.mine !== undefined) before.sendIn = t.sendIn.mine;
  return before;
}

/**
 * Back on the cursor's turn: a try not yet kept puts the turn back exactly as it was before it, and takes out a Pokémon only
 * that try brought in; a turn's own Pokémon set outright goes back to the carried one. Null when there is nothing to undo.
 */
function backOf(p: Plan): Plan | null {
  const t = p.turns[p.cursor]!;
  if (t.before === undefined) return t.mine === undefined ? null : withTurn(p, (u) => { delete u.mine; return u; });
  return withoutUnnamed(withTurn(p, untriedTurn), t.before.added ?? []);
}

/** The switch to pool Pokémon `key` among `held`'s choices: its index is its ref's position in the request's team. */
function switchChoice(plan: Plan, held: Held, key: string): Choice | null {
  const ref = plan.start.mons.find((m) => m.key === key)?.ref;
  const index = ref === undefined ? -1 : held.req.team.indexOf(ref);
  if (index < 0) return null;
  return held.answer.choices.find((c) => c.choice.kind === 'switch' && c.choice.index === index)?.choice ?? null;
}

function selectedOf(plan: Plan, r: ResolvedTurn, held: Held): { choice: Choice | null } | null {
  let choice: Choice | null = null;
  if (held.answer.phase === 'playerReplacement') {
    if (r.sendIn.mine !== null) choice = switchChoice(plan, held, r.sendIn.mine);
  } else if (r.pick?.kind === 'move') {
    const { slot } = r.pick;
    choice = held.answer.choices.find((c) => c.choice.kind === 'move' && c.choice.slot === slot)?.choice ?? null;
  } else if (r.pick?.kind === 'switch') {
    choice = switchChoice(plan, held, r.pick.to);
  }
  return choice === null ? null : { choice };
}

const sameChoice = (a: Choice, b: Choice): boolean =>
  (a.kind === 'move' && b.kind === 'move' && a.slot === b.slot) || (a.kind === 'switch' && b.kind === 'switch' && a.index === b.index);

export function usePlan(opts: { step?: PlanStepFn } = {}): UsePlan {
  const stepFn = useRef<PlanStepFn>(opts.step ?? DEFAULT_STEP);
  stepFn.current = opts.step ?? DEFAULT_STEP;

  const [plan, setPlan] = useState<Plan | null>(null);
  const planRef = useRef<Plan | null>(null);
  const [save, setSave] = useState<SaveId | null>(null);
  const saveRef = useRef<SaveId | null>(null);
  /** The held answers by `requestKey`, oldest first; a new Map each time one is held, so the render sees it. */
  const [heldMap, setHeldMap] = useState<ReadonlyMap<string, Held>>(() => new Map());
  const held = useRef<ReadonlyMap<string, Held>>(heldMap);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<{ turn: number } | null>(null);
  const [slow, setSlow] = useState(false);
  const [failure, setFailure] = useState<PlanFailure | null>(null);
  const [draftProblem, setDraftProblem] = useState<string | null>(null);
  const [notice, setNoticeState] = useState<string | null>(null);
  /** `notice` as it is now, for Clear plan to hold. */
  const noticeRef = useRef<string | null>(null);
  const setNotice = useCallback((next: string | null) => {
    noticeRef.current = next;
    setNoticeState(next);
  }, []);
  const [arrival, setArrival] = useState<UsePlan['arrival']>(null);
  const arrivals = useRef(0);
  /** Bumped whenever a request is aborted or overtaken: a request whose epoch moved on drops its result. */
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The field edit waiting to be asked about, and the `setField` calls waiting on it. */
  const fieldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fieldWaiting = useRef<Array<() => void>>([]);
  const [pending, setPending] = useState(false);
  /** The plan on the page was opened by `restore` and he has not acted since: what its answers teach is not written. */
  const quiet = useRef(false);
  /** The cleared plan held for Undo (`Hold`); null when none is. Only ever held while no plan is on the page. */
  const holding = useRef<Hold | null>(null);
  const [cleared, setCleared] = useState<number | null>(null);
  const [removed, setRemoved] = useState<number | null>(null);
  const [copies, setCopies] = useState<{ list: SavedPlan[]; skipped: number }>({ list: [], skipped: 0 });
  /** The answer last shown on each turn (by index) of the plan on the page, for `stale`; written after a render shows one. */
  const shownAt = useRef<Map<number, PlanStepJson>>(new Map());

  const arrive = useCallback((kind: 'turn' | 'open') => {
    arrivals.current += 1;
    setArrival({ seq: arrivals.current, kind });
  }, []);

  const put = useCallback((next: Plan | null) => {
    planRef.current = next;
    setPlan(next);
  }, []);

  /** Holds `next` for Undo (none for null), and says how many turns its plan has (`cleared` or `removed`, by its kind). */
  const hold = useCallback((next: Hold | null) => {
    holding.current = next;
    setCleared(next?.kind === 'clear' ? next.plan.turns.length : null);
    setRemoved(next?.kind === 'remove' ? next.plan.turns.length : null);
  }, []);

  /** Puts `next` on the page and keeps it, in the same call. What an answer teaches comes through here (`learn`). */
  const store = useCallback((next: Plan) => {
    put(next);
    quiet.current = false;
    writeCurrentPlan(next.start.trainerId, next.start.variant, { v: 1, save: saveRef.current, plan: next });
  }, [put]);

  /** `store` for his own edits: any of them closes a removed turn's Undo. */
  const keep = useCallback((next: Plan) => {
    if (holding.current?.kind === 'remove') hold(null);
    store(next);
  }, [hold, store]);

  /** Reads the named copies of `p`'s trainer copy. */
  const readSaved = useCallback((p: Plan) => setCopies(readCopies(p.start.trainerId, p.start.variant)), []);

  const setSaveId = useCallback((s: SaveId | null) => {
    saveRef.current = s;
    setSave(s);
  }, []);

  const setHeld = useCallback((next: ReadonlyMap<string, Held>) => {
    held.current = next;
    setHeldMap(next);
  }, []);

  const idle = useCallback(() => {
    controller.current = null;
    if (slowTimer.current !== null) clearTimeout(slowTimer.current);
    slowTimer.current = null;
    setBusy(false);
    setWorking(null);
    setSlow(false);
  }, []);

  /** Drops a field edit waiting to be asked about (whoever asks next asks for its state); its callers' promises settle. */
  const unwait = useCallback(() => {
    if (fieldTimer.current !== null) clearTimeout(fieldTimer.current);
    fieldTimer.current = null;
    const waiting = fieldWaiting.current;
    fieldWaiting.current = [];
    for (const done of waiting) done();
    setPending(false);
  }, []);

  /** Aborts the running request, if any, and moves the epoch on so nothing it answers is used; drops a waiting field edit. */
  const halt = useCallback(() => {
    unwait();
    controller.current?.abort();
    controller.current = null;
    epoch.current += 1;
  }, [unwait]);

  /**
   * What an answer for turn `at` teaches the plan: the weather, Trick Room and the stat stages the battle starts with, and
   * their likeliest send-out. The weather and Trick Room only from a request that left them out (the start's), so one he set
   * is never taken for the start's.
   */
  const learn = useCallback((at: number, req: PlanStepRequestJson, answer: PlanStepJson) => {
    const p = planRef.current;
    if (p === null || p.turns[at] === undefined) return;
    let next = p;
    if (at === 0 && req.state.field.weather === undefined && p.weather0 !== answer.field.weather) next = { ...next, weather0: answer.field.weather };
    if (at === 0 && req.state.field.trickRoom === undefined && p.trickRoom0 !== answer.field.trickRoom) next = { ...next, trickRoom0: answer.field.trickRoom };
    if (at === 0 && !sameStartStages(p.stages0, answer.startStages)) next = { ...next, stages0: startStagesOf(answer.startStages) };
    const t = next.turns[at]!;
    if (answer.sendOut !== undefined && t.sendIn.theirsPicked !== true) {
      const top = likeliest(answer.sendOut);
      if (top !== null && t.sendIn.theirs !== top) next = withTurn(next, (u) => ({ ...u, sendIn: { ...u.sendIn, theirs: top } }), at);
    }
    if (next === p) return;
    if (quiet.current) put(next);
    else store(next);   // not his edit, so a removed turn's Undo stays on offer
  }, [put, store]);

  /** The one place a request is made: for the cursor's turn, unless it cannot be made or its answer is held. */
  const ensure = useCallback(async (): Promise<void> => {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const p = planRef.current;
      const req = p === null ? null : stepRequest(p, p.cursor);
      // A failure belongs to the request it came from: an early return clears it, so it never sits on another turn.
      if (p === null || req === null) {
        halt();
        idle();
        setFailure(null);
        return;
      }
      const key = requestKey(req);
      const at = p.cursor;
      let answer: PlanStepJson;
      const have = held.current.get(key);
      if (have !== undefined) {
        halt();
        idle();
        setFailure(null);
        setDraftProblem(null);
        learn(at, have.req, have.answer);
        answer = have.answer;
      } else {
        halt();
        const mine = epoch.current;
        const c = new AbortController();
        controller.current = c;
        setBusy(true);
        setWorking({ turn: at + 1 });
        setSlow(false);
        if (slowTimer.current !== null) clearTimeout(slowTimer.current);
        slowTimer.current = setTimeout(() => setSlow(true), SLOW_MS);
        setFailure(null);
        setDraftProblem(null);
        try {
          answer = await stepFn.current(req, c.signal);
          if (epoch.current !== mine) return;
          const next = new Map(held.current);
          next.delete(key);
          next.set(key, { req, answer });
          while (next.size > MAX_HELD) next.delete(next.keys().next().value!);
          setHeld(next);
          learn(at, req, answer);
          idle();
        } catch (e) {
          if (epoch.current !== mine) return;
          if (!isAbort(e)) {
            if (isDraftRefusal(e)) setDraftProblem(e.message);
            else setFailure(planFailureOf(e));
          }
          idle();
          return;
        }
      }
      // What the answer taught (the start's stages) changed the cursor's state: ask again, these numbers on offer meanwhile.
      // Nothing is awaited between here and the next round's `setBusy`, so the page never sees the turn settle in between.
      const now = planRef.current;
      const again = now === null || now.cursor !== at ? null : stepRequest(now, at);
      if (again === null || requestKey(again) === key) return;
      shownAt.current.set(at, answer);
    }
  }, [halt, idle, learn, setHeld]);

  /**
   * An action on the plan: `edit` returns the next plan, or null to do nothing. It is kept, then `ensure` runs. `own`: it is
   * his edit (`keep`, which closes a removed turn's Undo); false for a jump that only looks at another turn (`store`).
   */
  const change = useCallback((edit: (p: Plan) => Plan | null, arrives = false, own = true): Promise<void> => {
    const p = planRef.current;
    if (p === null) return Promise.resolve();
    const next = edit(p);
    if (next === null) return Promise.resolve();
    if (own) keep(next);
    else store(next);
    if (arrives) arrive('turn');
    return ensure();
  }, [arrive, ensure, keep, store]);

  /**
   * Puts `next` on the page on `s`, held answers and a cleared plan held for Undo dropped, reads its named copies, and works
   * out its cursor's turn. `kind` is what arrives (null: nothing is said). `write`: it is kept at once (a plan begun here);
   * without it nothing is written until his next action (a kept plan opened).
   */
  const open = useCallback(async (next: Plan, s: SaveId | null, how: { kind: 'turn' | 'open' | null; write: boolean; notice: string | null }): Promise<void> => {
    halt();
    idle();
    setHeld(new Map());
    shownAt.current = new Map();
    hold(null);
    setSaveId(s);
    setFailure(null);
    setDraftProblem(null);
    setNotice(how.notice);
    if (how.write) keep(next);
    else {
      put(next);
      quiet.current = true;
    }
    readSaved(next);
    if (how.kind !== null) arrive(how.kind);
    await ensure();
  }, [arrive, ensure, halt, hold, idle, keep, put, readSaved, setHeld, setNotice, setSaveId]);

  // Notes are never lost: a kept plan not on the page, and a cleared plan held for Undo, go into the named copies before the
  // new one is written over them.
  const begin = useCallback((start: PlanStart, s: SaveId): Promise<void> => {
    const p = planRef.current;
    const shown = p === null ? null : JSON.stringify({ v: 1, save: saveRef.current, plan: p });
    const was = holding.current;
    const kept = keepAside(start.trainerId, start.variant, s, [
      { text: was?.kind === 'clear' ? was.kept : null, who: 'cleared' },
      { text: readCurrentPlanText(start.trainerId, start.variant), who: 'kept' },
    ], shown);
    if (!kept.ok) {
      setNotice(notMoved(kept.who, 'begin'));
      return Promise.resolve();
    }
    return open(newPlan(start), s, { kind: 'turn', write: true, notice: kept.notice });
  }, [open, setNotice]);

  const restore = useCallback(async (record: PlanRecord, box: BoxJson, options: Options = null, arrives?: 'open'): Promise<void> => {
    const landed = landing(record, box, options);
    if (landed === null) {
      setNotice(NONE_LEFT);
      return;
    }
    await open(landed.next, saveOf(box), { kind: arrives ?? null, write: false, notice: landed.said });
  }, [open, setNotice]);

  // The same rule as `begin`: the plan it replaces (the one on the page with a removed turn's Undo still on offer, a cleared
  // one held for Undo, or the kept one, on the page or not) goes into the named copies first, and the notice says where. The
  // copy is then the kept plan, its own bytes as saved, so a reload opens it; it is not rewritten until his next action.
  const openCopy = useCallback(async (copy: SavedPlan, box: BoxJson, options: Options = null): Promise<void> => {
    const landed = landing(copy, box, options);
    if (landed === null) {
      setNotice(NONE_LEFT);
      return;
    }
    const { trainerId, variant } = copy.plan.start;
    const s = saveOf(box);
    const was = holding.current;
    const current = readCurrentPlanText(trainerId, variant);
    const items: Array<{ text: string | null; who: Aside }> = was?.kind === 'remove'
      ? [{ text: was.kept ?? current, who: 'page' }]
      : [{ text: was?.kind === 'clear' ? was.kept : null, who: 'cleared' }, { text: current, who: planRef.current === null ? 'kept' : 'page' }];
    const kept = keepAside(trainerId, variant, s, items, null);
    if (!kept.ok) {
      setNotice(notMoved(kept.who, 'open'));
      return;
    }
    writeCurrentPlanText(trainerId, variant, JSON.stringify({ v: 1, save: copy.save, plan: copy.plan }));
    const notice = [kept.notice, landed.said].filter((words) => words !== null).join(' ') || null;
    await open(landed.next, s, { kind: 'open', write: false, notice });
  }, [open, setNotice]);

  const stop = useCallback(() => {
    halt();
    idle();
  }, [halt, idle]);

  const workOut = useCallback(() => ensure(), [ensure]);
  const retry = useCallback(() => { void ensure(); }, [ensure]);

  /** The plan leaves the page, and its save and what was said of it with it. Held answers stay unless `forget`. */
  const leave = useCallback((forget: boolean) => {
    halt();
    idle();
    if (forget) setHeld(new Map());
    shownAt.current = new Map();
    put(null);
    quiet.current = false;
    setSaveId(null);
    setFailure(null);
    setDraftProblem(null);
    setNotice(null);
    setCopies({ list: [], skipped: 0 });
  }, [halt, idle, put, setHeld, setNotice, setSaveId]);

  const reset = useCallback(() => {
    leave(true);
    hold(null);
  }, [hold, leave]);

  // As useLine's Clear tree: what is kept goes at once, and the plan with it, both held for `undo`. The
  // held answers stay, so Undo shows the turn's numbers again without asking.
  const clear = useCallback(() => {
    const p = planRef.current;
    if (p === null) return;
    const { trainerId, variant } = p.start;
    const was: Hold = { kind: 'clear', plan: p, save: saveRef.current, kept: readCurrentPlanText(trainerId, variant), notice: noticeRef.current, quiet: quiet.current };
    writeCurrentPlanText(trainerId, variant, null);
    leave(false);
    hold(was);
  }, [hold, leave]);

  // Remove this turn, held for Undo as Clear plan is: the plan and the stored bytes from just before. The window closes as
  // Clear's does (a plan reaching the page, `reset`), and also on his next edit (`keep`), so Undo never undoes an edit too.
  const removeLastTurn = useCallback((): Promise<void> => {
    const p = planRef.current;
    if (p === null || p.turns.length < 2 || p.cursor !== p.turns.length - 1) return Promise.resolve();
    const { trainerId, variant } = p.start;
    const was: Hold = { kind: 'remove', plan: p, save: saveRef.current, kept: readCurrentPlanText(trainerId, variant), notice: noticeRef.current, quiet: quiet.current };
    shownAt.current.delete(p.cursor);
    keep(withoutLastTurn(p));
    hold(was);
    arrive('turn');
    return ensure();
  }, [arrive, ensure, hold, keep]);

  // The same steps for both kinds: a clear comes back only while no plan is on the page, a removal only while the cut plan
  // is. Every other way out drops the hold first, so a late Undo does nothing.
  const undo = useCallback(async (): Promise<void> => {
    const was = holding.current;
    if (was === null || (was.kind === 'clear') !== (planRef.current === null)) return;
    hold(null);
    writeCurrentPlanText(was.plan.start.trainerId, was.plan.start.variant, was.kept);
    setSaveId(was.save);
    put(was.plan);
    quiet.current = was.quiet;
    setNotice(was.notice);   // a failure or a refused draft went with the plan at `clear`, and nothing can set one while it is held
    readSaved(was.plan);
    arrive('turn');
    await ensure();
  }, [arrive, ensure, hold, put, readSaved, setNotice, setSaveId]);

  // The state is unchanged, so `ensure` asks nothing when the answer is held, and sends again when none is.
  const pick = useCallback<UsePlan['pick']>((next) => {
    void change((p) => {
      if (next === null) return withTurn(p, (t) => ({ ...t, pick: null }));
      const r = cursorTurn(p);
      const by = r.mine;
      if (by === null) return null;
      if (next.kind === 'move') return withTurn(p, (t) => ({ ...t, pick: { kind: 'move', by, slot: next.slot, name: next.name } }));
      if (next.to === by || !switchable(p, r, next.to)) return null;
      return withTurn(p, (t) => ({ ...t, pick: { kind: 'switch', by, to: next.to } }));
    });
  }, [change]);

  // A new state: `ensure` asks for it unless its answer is already held.
  const toggleFainted = useCallback((side: 'mine' | 'theirs') => change((p) => {
    const r = cursorTurn(p);
    if (side === 'mine') {
      const mine = r.mine;
      if (mine === null) return null;
      return withTurn(p, (t) => {
        if (r.fainted.mine) { delete t.fainted.mine; delete t.sendIn.mine; } else t.fainted.mine = mine;
        return t;
      });
    }
    const theirs = r.theirs;
    if (theirs === null) return null;
    return withTurn(p, (t) => {
      if (r.fainted.theirs) { delete t.fainted.theirs; delete t.sendIn.theirs; delete t.sendIn.theirsPicked; } else t.fainted.theirs = theirs;
      return t;
    });
  }), [change]);

  // The state is unchanged, so `ensure` asks nothing when the answer is held, and sends again when none is.
  const sendIn = useCallback(((side: 'mine' | 'theirs', who: string | number) => {
    void change((p) => {
      const r = cursorTurn(p);
      if (side === 'mine') {
        if (typeof who !== 'string' || !r.fainted.mine || who === r.mine || !switchable(p, r, who)) return null;
        return withTurn(p, (t) => ({ ...t, sendIn: { ...t.sendIn, mine: who } }));
      }
      const ok = typeof who === 'number' && Number.isInteger(who) && who >= 0 && who < p.start.enemies.length
        && r.fainted.theirs && who !== r.theirs && !r.faintedBefore.theirs.includes(who);
      if (!ok) return null;
      return withTurn(p, (t) => ({ ...t, sendIn: { ...t.sendIn, theirs: who, theirsPicked: true } }));
    });
  }) as UsePlan['sendIn'], [change]);

  // Set outright, the Pokémon carries on at once; any try on the turn goes with what it brought in.
  const setMine = useCallback((key: string | null) => change((p) => {
    if (key === null) return backOf(p);
    if (!standing(p, cursorTurn(p), key)) return null;
    const added = p.turns[p.cursor]!.before?.added ?? [];
    return withoutUnnamed(withTurn(p, (t) => { const u = { ...t, mine: key }; delete u.before; return u; }), added);
  }), [change]);

  // A try is his on this turn only (`before` holds the turn as it was) until Keep. Trying the one on the field does
  // nothing; trying the one the turn had before the try is Back. A Pokémon new to the pool, or there only by another
  // try, is the try's own (`added`): Back takes it out, Add to team keeps it.
  const tryMon = useCallback((mon: PlanMon) => change((p) => {
    const has = p.start.mons.some((m) => m.key === mon.key);
    const pool = has ? p : { ...p, start: { ...p.start, mons: [...p.start.mons, mon] } };
    const r = cursorTurn(pool);
    if (mon.key === r.mine || !standing(pool, r, mon.key)) return null;
    if (pool.turns[pool.cursor]!.before !== undefined && untriedMine(pool) === mon.key) return backOf(p);
    const added = !has || trialOnly(p).has(mon.key);
    return withTurn(pool, (t) => {
      const before = t.before ?? trialOf(t);
      const list = before.added ?? [];
      return { ...t, mine: mon.key, before: added && !list.includes(mon.key) ? { ...before, added: [...list, mon.key] } : before };
    });
  }), [change]);

  // Keep: the try becomes his for good from this turn on; nothing is asked, as the turn's state is the same.
  const keepTry = useCallback(() => change((p) => {
    const before = p.turns[p.cursor]?.before;
    if (before === undefined) return null;
    return withoutUnnamed(withTurn(p, (t) => { delete t.before; return t; }), before.added ?? []);
  }), [change]);

  // Kept and shown at once; asked about FIELD_DEBOUNCE_MS after his last edit. A request still out is for a state that is
  // gone, so it is aborted now (`halt`, which also drops an earlier edit's wait: its promise settles). The promise settles
  // once this edit's turn is worked out, or when a later action takes the wait over.
  const setField = useCallback((next: PlanFieldJson): Promise<void> => {
    const p = planRef.current;
    if (p === null) return Promise.resolve();
    const carried = resolve(withTurn(p, (t) => ({ ...t, field: {} })))[p.cursor]!.field;
    keep(withTurn(p, (t) => ({ ...t, field: patchOf(carried, next) })));
    halt();
    idle();
    setFailure(null);
    setDraftProblem(null);
    setPending(true);
    return new Promise<void>((done) => {
      fieldWaiting.current.push(done);
      fieldTimer.current = setTimeout(() => {
        fieldTimer.current = null;
        const waiting = fieldWaiting.current;
        fieldWaiting.current = [];
        setPending(false);
        void ensure().then(() => { for (const settle of waiting) settle(); });
      }, FIELD_DEBOUNCE_MS);
    });
  }, [ensure, halt, idle, keep]);

  const setWorld = useCallback((world: number) => change((p) => (
    p.start.world === world ? null : { ...p, start: { ...p.start, world } }
  )), [change]);

  // The team as it is now, keeping any Pokémon a turn still names so no turn loses who it was written for. On
  // another save their refs are that save's: each is found again by key over the box, or leaves the pool and is named.
  const setMons = useCallback((mons: PlanMon[], s?: SaveId, box?: BoxJson, options: Options = null): Promise<void> => {
    if (planRef.current === null) return Promise.resolve();
    const moved = s !== undefined && !sameSave(saveRef.current, s);
    if (s !== undefined) setSaveId(s);
    let gone: string[] = [];
    const done = change((p) => {
      const named = namedKeys(p);
      const team = new Set(mons.map((m) => m.key));
      let kept = p.start.mons.filter((m) => named.has(m.key) && !team.has(m.key));
      if (moved && kept.length > 0) {
        if (box === undefined) {
          gone = kept.map((m) => m.name);
          kept = [];
        } else {
          const found = refoundPlan(box, options, { v: 1, save: null, plan: { ...p, start: { ...p.start, mons: kept } } }).record.plan.start.mons;
          const refs = new Set(mons.map((m) => m.ref));
          const ok = found.filter((m) => !refs.has(m.ref));   // a ref the team holds is another Pokémon's now
          gone = kept.filter((m) => !ok.some((f) => f.key === m.key)).map((m) => m.name);
          kept = ok;
        }
      }
      // A tried Pokémon now on the team is his for good: Back no longer takes it out.
      const turns = p.turns.map((t) => {
        const added = t.before?.added;
        if (added === undefined || !added.some((k) => team.has(k))) return t;
        const before: PlanTrial = { ...t.before!, added: added.filter((k) => !team.has(k)) };
        if (before.added!.length === 0) delete before.added;
        return { ...t, before };
      });
      return { ...p, turns, start: { ...p.start, mons: [...mons, ...kept] } };
    }, false, false);
    if (gone.length > 0) setNotice(box === undefined ? notOnTeam(gone) : saveChanged(gone));
    return done;
  }, [change, setNotice, setSaveId]);

  // Never replaces a saved plan: a name in use takes the next free one, "X (2)".
  const saveCopy = useCallback((name: string): string | null => {
    const p = planRef.current;
    const n = name.trim();
    if (p === null || n === '') return null;
    const { trainerId, variant } = p.start;
    const entries = storedCopies(trainerId, variant);
    const as = freeName(n, entries);
    const copy: SavedPlan = { name: as, v: 1, save: saveRef.current, plan: p };
    writeCopies(trainerId, variant, [...entries, copy]);
    readSaved(p);
    return storedCopies(trainerId, variant).length === entries.length + 1 ? as : null;
  }, [readSaved]);

  const removeSaved = useCallback((name: string) => {
    const p = planRef.current;
    if (p === null) return;
    deleteCopy(p.start.trainerId, p.start.variant, name);
    readSaved(p);
  }, [readSaved]);

  const removeUnreadable = useCallback(() => {
    const p = planRef.current;
    if (p === null) return;
    dropUnreadable(p.start.trainerId, p.start.variant);
    readSaved(p);
  }, [readSaved]);

  // The two note setters write at once and never ask, abort or touch busy.
  const setNote = useCallback((text: string) => {
    const p = planRef.current;
    if (p !== null) keep(withTurn(p, (t) => ({ ...t, note: text })));
  }, [keep]);

  const setFightNote = useCallback((text: string) => {
    const p = planRef.current;
    if (p !== null) keep({ ...p, note: text });
  }, [keep]);

  // A jump only looks at another turn, so a removed turn's Undo stays on offer.
  const goTo = useCallback((turn: number) => change((p) => (
    !Number.isInteger(turn) || turn < 1 || turn > p.turns.length || turn - 1 === p.cursor ? null : { ...p, cursor: turn - 1 }
  ), true, false), [change]);

  const nextTurn = useCallback((): Promise<void> => {
    const p = planRef.current;
    if (p === null) return Promise.resolve();
    if (p.cursor < p.turns.length - 1) return goTo(p.cursor + 2);
    if (!planCanNext(p)) return Promise.resolve();
    // No more turns than the page reads back: a longer plan would be lost on the next reload.
    if (p.turns.length >= MAX_TURNS) {
      setNotice(TURN_LIMIT);
      return Promise.resolve();
    }
    return change((q) => ({ ...q, turns: [...q.turns, blankTurn()], cursor: q.turns.length }), true);
  }, [change, goTo, setNotice]);

  const choose = useCallback((choice: Choice) => {
    const p = planRef.current;
    if (p === null) return;
    const req = stepRequest(p, p.cursor);
    const h = req === null ? undefined : held.current.get(requestKey(req));
    if (h === undefined) return;
    const offered = h.answer.choices.find((c) => sameChoice(c.choice, choice))?.choice;
    if (offered === undefined) return;
    const keyAt = (index: number): string | undefined => {
      const ref = h.req.team[index];
      return p.start.mons.find((m) => m.ref === ref)?.key;
    };
    if (h.answer.phase === 'playerReplacement') {
      if (offered.kind !== 'switch') return;
      const key = keyAt(offered.index);
      if (key !== undefined) sendIn('mine', key);
      return;
    }
    if (offered.kind === 'move') {
      const name = h.answer.view.player.active?.moves?.[offered.slot]?.name
        ?? h.answer.choices.find((c) => c.choice === offered)!.label.replace(/^Use /, '');
      pick({ kind: 'move', slot: offered.slot, name });
    } else if (offered.kind === 'switch') {
      const key = keyAt(offered.index);
      if (key !== undefined) pick({ kind: 'switch', to: key });
    }
  }, [pick, sendIn]);

  useEffect(() => () => {
    controller.current?.abort();
    epoch.current += 1;
    if (slowTimer.current !== null) clearTimeout(slowTimer.current);
    if (fieldTimer.current !== null) clearTimeout(fieldTimer.current);
  }, []);

  const derived = useMemo(() => {
    if (plan === null) {
      return { turns: [], rows: [], fightNote: '', current: null, answer: null, selected: null, ended: null, canNext: false, requestable: false, tried: null };
    }
    const turns = resolve(plan);
    const current = turns[plan.cursor] ?? null;
    const req = stepRequest(plan, plan.cursor);
    const h = req === null ? undefined : heldMap.get(requestKey(req));
    // A try not yet kept is named only while it applies (not fainted before, still in the pool); `previous` is who Back
    // puts back.
    const own = plan.turns[plan.cursor];
    const tried = own?.before === undefined || own.mine === undefined || current?.mine !== own.mine
      ? null : { key: own.mine, previous: untriedMine(plan) };
    return {
      turns, rows: turnRows(plan), fightNote: plan.note, current,
      answer: h?.answer ?? null,
      selected: h === undefined || current === null ? null : selectedOf(plan, current, h),
      ended: ending(plan),
      canNext: plan.cursor < plan.turns.length - 1 || planCanNext(plan),
      requestable: req !== null,
      tried,
    };
  }, [plan, heldMap]);

  // `stale`: each answer shown is remembered for its turn, after the render that shows it.
  const cursor = plan?.cursor ?? null;
  useEffect(() => {
    if (cursor !== null && derived.answer !== null) shownAt.current.set(cursor, derived.answer);
  }, [cursor, derived.answer]);
  const stale = cursor === null || derived.answer !== null ? null : shownAt.current.get(cursor) ?? null;

  return {
    plan, save,
    turns: derived.turns, rows: derived.rows, fightNote: derived.fightNote, current: derived.current,
    answer: derived.answer, selected: derived.selected, choose,
    ended: derived.ended, canNext: derived.canNext,
    busy, working, slow, stop,
    pending,
    unsettled: derived.requestable && !busy && !pending && derived.answer === null,
    workOut, failure, retry, notice, draftProblem, arrival,
    begin, pick, toggleFainted, sendIn, setMine, tryMon, keepTry, setField, setWorld, setNote, setFightNote, nextTurn, goTo, reset,
    restore, setMons, clear, cleared, undo, removeLastTurn, removed, stale, tried: derived.tried,
    saved: plan === null ? [] : copies.list,
    savedSkipped: plan === null ? 0 : copies.skipped,
    savedProblem: plan === null ? null : savedProblemText(copies.skipped),
    saveCopy, openCopy, removeSaved, removeUnreadable,
  };
}
