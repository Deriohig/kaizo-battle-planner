// The fight routes' shared reading, for both route tables (local `app.ts`, hosted `hostedRoutes.ts`): a sheet request
// (`sheetBody`), a plan step (`planStepQuery`) and the fight both read (`draftedFight`), the sheet's answer
// (`sheetJson`) and the AI odds' stream (`streamOdds`). None of them takes the server state: each reads the data and the
// box through a `FightSource`, so the hosted table never holds the local state. Local mode's
// source answers as `requireData` and `requireBox` always have.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PlayerMon } from '../battle/playerMon.js';
import type { ResolvedTrainer } from '../battle/types.js';
import type { AiOddsLevel, PlanStepJson, PlanStepStateJson } from '../contracts/api.js';
import { oneLineMessage as oneLine } from '../docs/fetchDocs.js';
import { sheetPairAt } from './aiOdds.js';
import type { MonRef, SheetJson } from './apiTypes.js';
import { type BoxState, LAST_SPECIES, monRef, NO_MOVES } from './box.js';
import { applyDraft, DraftError, parseDraft } from './draft.js';
import { HttpError, requireBox, requireData } from './http.js';
import type { LineDeps } from './lines.js';
import type { PlanService, PlanStepQuery } from './plan.js';
import { type SheetBuilder, sheetToJson } from './sheet.js';
import type { SheetAi, SheetAiDeps, SheetAiQuery } from './sheetAi.js';
import { openSse } from './sse.js';
import type { ServerData, ServerDeps, ServerState } from './state.js';
import { pickVariant } from './trainers.js';

/** Where a route gets the data and the box. Local: over ServerState, unchanged. Hosted: the bundle and the session. */
export interface FightSource { data(): ServerData; box(): BoxState }

/** Local mode's source: the state's data and box, with `requireData`'s and `requireBox`'s 409 and 422. */
export function localFightSource(state: ServerState): FightSource {
  return { data: () => requireData(state), box: () => requireBox(state) };
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `fight`'s sheet as `SheetJson`, with the box read it was built from. Each Pokémon is on the HP its drafted self
 * carries (`hp: 'save'`): the draft's, else the save's lost HP kept.
 */
export function sheetJson(fight: DraftedFight, buildSheet: SheetBuilder): SheetJson {
  const { data, trainer, copy, variant, team, box } = fight;
  const sheet = buildSheet(team, copy, { moves: data.moves, hp: 'save' });
  return {
    ...sheetToJson(sheet, { names: data.local.names, variant, variants: 1 + trainer.variants.length }),
    savedAt: box.json.savedAt, savePath: box.json.savePath,
  };
}

/** The box read a sheet's team comes from, as the sheet and its AI odds name it (`BoxJson`'s `savedAt` and `savePath`). */
export const saveOf = (box: BoxState) => ({ savedAt: box.json.savedAt, savePath: box.json.savePath });

/**
 * How `streamOdds` ends on a batch failure. `signal` stops the batch as the stream closing does (the hosted work gate's
 * time limit); `failure` gives the `error` event's words for a batch that failed or was stopped by `signal`, and logs
 * as it sees fit. Without it the error is logged with the request line and sent as its one-line message (local mode).
 * `aiOdds` is the AI odds level each pair is cut to as it goes out (aiOdds.ts `sheetPairAt`), `full` when left out.
 */
export interface StreamOddsOptions { signal?: AbortSignal; failure?: (error: unknown) => string; aiOdds?: AiOddsLevel }

/**
 * `SheetAiEvent` for `query`, checked, on `res`, for `POST /api/sheet/ai/stream`: the stream opens, then `start`, each
 * `pair` as the batch tells it (`ai.stream`), and `done`, or `error` (logged) for a batch that fails as a whole. The
 * stream closing before the batch ends (the page moved on) is its signal's abort: a batch no open stream waits on stops
 * (sheetAi.ts), and the stream says nothing more. `opts.signal` aborting is a failure: `error`, then the stream closes.
 */
export async function streamOdds(req: IncomingMessage, res: ServerResponse, ai: SheetAi, query: SheetAiQuery, opts: StreamOddsOptions = {}): Promise<void> {
  const stream = openSse(res);
  const closed = new AbortController();
  stream.onClose(() => closed.abort());
  if (res.destroyed) closed.abort();
  const signal = opts.signal === undefined ? closed.signal : AbortSignal.any([closed.signal, opts.signal]);
  try {
    const batch = ai.stream(query, {
      start: (total) => stream.send('start', { ...query.save, total }),
      pair: (pair) => stream.send('pair', sheetPairAt(opts.aiOdds ?? 'full', pair)),
    }, signal);
    // The batch may be shared with another stream that keeps it going: this one stops waiting when its own signal aborts.
    batch.catch(() => undefined);
    await Promise.race([batch, aborted(signal)]);
    if (opts.signal?.aborted === true && !closed.signal.aborted) throw opts.signal.reason;
    stream.send('done', {});
  } catch (error) {
    if (closed.signal.aborted) return;
    if (opts.failure !== undefined) {
      stream.send('error', { error: opts.failure(error) });
    } else {
      console.error(`${req.method} ${req.url} failed:`, error);
      stream.send('error', { error: oneLine(error) });
    }
  } finally {
    stream.close();
  }
}

/** A promise that rejects with `signal`'s reason once it aborts, and never settles otherwise. */
function aborted(signal: AbortSignal): Promise<never> {
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  promise.catch(() => undefined);
  return promise;
}

/**
 * The AI odds deps for a data load, from `ServerDeps.sheetAi`: the same deps for every load, or built on first use, once
 * per load (a build that throws is tried again next time). Null without any: the route answers 501.
 */
export function sheetAiDeps(given: ServerDeps['sheetAi']): ((data: ServerData) => SheetAiDeps) | null {
  if (given === undefined) return null;
  if (typeof given !== 'function') return () => given;
  let built: { data: ServerData; deps: SheetAiDeps } | null = null;
  return (data) => {
    if (built?.data !== data) built = { data, deps: given(data) };
    return built.deps;
  };
}

/**
 * The line builder's deps for a data load, from `ServerDeps.lines`: the same deps for every load, or built on first use,
 * once per load (a build that throws is tried again next time). Null without any: the routes answer 501.
 */
export function lineDepsFor(given: ServerDeps['lines']): ((data: ServerData) => LineDeps) | null {
  if (given === undefined) return null;
  if (typeof given !== 'function') return () => given;
  let built: { data: ServerData; deps: LineDeps } | null = null;
  return (data) => {
    if (built?.data !== data) built = { data, deps: given(data) };
    return built.deps;
  };
}

/** How many plan step answers a route table keeps. */
export const PLAN_ANSWERS = 64;

/**
 * The plan steps a route table answered, least recently used first, by `planStepQuery`'s key, which holds the box
 * read's identity: an answer is never served to another box read, so never to another session.
 */
export class PlanAnswers {
  private readonly answers = new Map<string, PlanStepJson>();

  get(key: string): PlanStepJson | undefined {
    const cached = this.answers.get(key);
    if (cached !== undefined) {
      this.answers.delete(key);
      this.answers.set(key, cached);
    }
    return cached;
  }

  set(key: string, answer: PlanStepJson): void {
    this.answers.set(key, answer);
    if (this.answers.size > PLAN_ANSWERS) this.answers.delete(this.answers.keys().next().value!);
  }
}

/**
 * The plan step `query` answers, from `answers` when it was answered before, else worked out by `run` (which hands the
 * plan service its signal) and kept. `res` closing before the answer stops it at the step's next yield.
 */
export async function answerPlanStep(
  res: ServerResponse, answers: PlanAnswers, plans: PlanService, step: { query: PlanStepQuery; key: string },
  run: (work: (signal: AbortSignal) => Promise<PlanStepJson>, closed: AbortSignal) => Promise<PlanStepJson> = (work, closed) => work(closed),
): Promise<PlanStepJson> {
  const cached = answers.get(step.key);
  if (cached !== undefined) return cached;
  const closed = new AbortController();
  res.once('close', () => { if (!res.writableFinished) closed.abort(); });
  if (res.destroyed) closed.abort();
  const answer = await run((signal) => plans.step({ ...step.query, signal }), closed.signal);
  answers.set(step.key, answer);
  return answer;
}

const PLAN_STEP_KEYS: ReadonlySet<string> = new Set(['trainerId', 'variant', 'world', 'team', 'draft', 'state']);
const PLAN_STATE_KEYS: ReadonlySet<string> = new Set(['player', 'enemy', 'field']);
const PLAN_FIELD_KEYS: ReadonlySet<string> = new Set(['weather', 'trickRoom', 'rocks', 'screens', 'stages', 'enemyStatus']);
const PLAN_SIDE_KEYS: ReadonlySet<string> = new Set(['active', 'fainted']);
const PLAN_SIDES: ReadonlySet<string> = new Set(['player', 'enemy']);
const PLAN_SCREEN_KEYS: ReadonlySet<string> = new Set(['reflect', 'lightScreen']);
/** `PlanStat`'s names. */
const PLAN_STATS: ReadonlySet<string> = new Set(['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva']);

/**
 * `POST /api/plan/step`'s body (`PlanStepRequestJson`) as a step to answer. Checked in this order: the body is an object;
 * the first stray key (in the body's own order) is a 400, "<key> is not part of a plan step"; the fight as a line start
 * reads it (`draftedFight`: 409, 404, 400); `world` (default 0); then the state's structure (`planStepState`). What the
 * service checks (plan.ts: the team's size, the active, the indices, the weather, the status, each stat and its being a
 * whole number) is not checked here.
 *
 * `key` names the step for the route's answer cache: the request as read (the trainer's ID, the copy, the world, the
 * team, the draft, the state with its stages clamped; objects with their keys sorted) with the data load and the box read
 * it was answered over (each by identity, and the box's `savedAt` and `savePath`), so an answer is never served across a
 * new read of the save, a settings rebuild of the box, or a data reload.
 */
export function planStepQuery(source: FightSource, body: unknown): { query: PlanStepQuery; key: string } {
  if (!isRecord(body)) throw new HttpError(400, 'The body must be a JSON object');
  const stray = Object.keys(body).find((key) => !PLAN_STEP_KEYS.has(key));
  if (stray !== undefined) throw new HttpError(400, `${stray} is not part of a plan step`);
  const { data, box, trainer, variant, refs, pool } = draftedFight(source, body, { trainerKey: 'trainerId', emptyTeam: false });
  const query: PlanStepQuery = { data, mons: pool, trainerId: trainer.id, variant, team: refs, world: worldParam(body.world), state: planStepState(body.state) };
  const key = sortedJson([
    identityOf(data), identityOf(box), box.json.savedAt, box.json.savePath,
    query.trainerId, query.variant, query.world, query.team, body.draft, query.state,
  ]);
  return { query, key };
}

const identities = new WeakMap<object, number>();
let lastIdentity = 0;
/** A number for `value` itself, the same while it lives, never another's. */
function identityOf(value: object): number {
  let id = identities.get(value);
  if (id === undefined) identities.set(value, (id = ++lastIdentity));
  return id;
}

/** `value` as JSON with each object's keys sorted, so two requests that differ only in key order are the same text. */
const sortedJson = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (
  isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

/**
 * A step's `state` with its structure checked, so the service reads it without a TypeError: objects where the contract has
 * them (`state`, `player`, `enemy`, `field`, `rocks`, `screens` and each side's, `stages` and each side's), arrays for both
 * `fainted`, and booleans for Trick Room (which may be left out, as the weather may), the rocks and the screens, each a
 * 400 naming the field. In each of those objects
 * a key the contract lacks is a 400, "<key> is not part of a plan step" (the first, in the object's own order), and in a
 * side's stages a name that is not a `PlanStat` is a 400 naming the side. A stat stage that is a whole number outside
 * -6..6 is clamped to it, here and only here (the service reads what it is given, and the answer echoes it).
 */
function planStepState(raw: unknown): PlanStepStateJson {
  const object = (value: unknown, what: string): Record<string, unknown> => {
    if (!isRecord(value)) throw new HttpError(400, `${what} must be an object`);
    return value;
  };
  const stray = (value: Record<string, unknown>, keys: ReadonlySet<string>) => {
    const key = Object.keys(value).find((k) => !keys.has(k));
    if (key !== undefined) throw new HttpError(400, `${key} is not part of a plan step`);
  };
  const flag = (value: unknown, what: string): void => {
    if (typeof value !== 'boolean') throw new HttpError(400, `${what} must be true or false`);
  };
  const list = (value: unknown, what: string): void => {
    if (!Array.isArray(value)) throw new HttpError(400, `${what} must be an array`);
  };
  const state = object(raw, 'state');
  stray(state, PLAN_STATE_KEYS);
  const player = object(state.player, 'state.player');
  stray(player, PLAN_SIDE_KEYS);
  const enemy = object(state.enemy, 'state.enemy');
  stray(enemy, PLAN_SIDE_KEYS);
  list(player.fainted, 'state.player.fainted');
  list(enemy.fainted, 'state.enemy.fainted');
  const field = object(state.field, 'state.field');
  stray(field, PLAN_FIELD_KEYS);
  if (field.trickRoom !== undefined) flag(field.trickRoom, 'state.field.trickRoom');
  const rocks = object(field.rocks, 'state.field.rocks');
  stray(rocks, PLAN_SIDES);
  const screens = object(field.screens, 'state.field.screens');
  stray(screens, PLAN_SIDES);
  const stages = object(field.stages, 'state.field.stages');
  stray(stages, PLAN_SIDES);
  const clamped: Record<string, Record<string, unknown>> = {};
  for (const side of ['player', 'enemy'] as const) {
    flag(rocks[side], `state.field.rocks.${side}`);
    const own = object(screens[side], `state.field.screens.${side}`);
    stray(own, PLAN_SCREEN_KEYS);
    flag(own.reflect, `state.field.screens.${side}.reflect`);
    flag(own.lightScreen, `state.field.screens.${side}.lightScreen`);
    const staged = object(stages[side], `state.field.stages.${side}`);
    const stat = Object.keys(staged).find((key) => !PLAN_STATS.has(key));
    if (stat !== undefined) throw new HttpError(400, `state.field.stages.${side}: ${stat} is not a stat with a stage (${[...PLAN_STATS].join(', ')})`);
    clamped[side] = Object.fromEntries(Object.entries(staged).map(([key, stage]) => [key, typeof stage === 'number' && Number.isInteger(stage) ? Math.max(-6, Math.min(6, stage)) : stage]));
  }
  return { ...state, field: { ...field, stages: clamped } } as unknown as PlanStepStateJson;
}

/** A line's `world`: a whole number from 0, default 0 (the service checks it is one of the fight's); 400 for anything else. */
export function worldParam(world: unknown): number {
  if (world === undefined) return 0;
  if (typeof world === 'number' && Number.isInteger(world) && world >= 0) return world;
  throw new HttpError(400, 'world must be a whole number from 0');
}

/** What a sheet request may hold (`SheetRequestJson`). */
const SHEET_REQUEST_KEYS: ReadonlySet<string> = new Set(['trainer', 'variant', 'team', 'draft']);

/**
 * `POST /api/sheet`'s and `POST /api/sheet/ai/stream`'s body as the fight to show: the body is an object (400); then
 * the first of its keys, in its own order, that `SheetRequestJson` lacks is a 400, "<key> is not part of a sheet
 * request" (a caller that still sends `hp` or `levels` would otherwise get numbers it misreads); then `draftedFight`,
 * the trainer by `trainer`, an empty team allowed.
 */
export function sheetBody(source: FightSource, raw: unknown): DraftedFight {
  if (!isRecord(raw)) throw new HttpError(400, 'The body must be a JSON object');
  const stray = Object.keys(raw).find((key) => !SHEET_REQUEST_KEYS.has(key));
  if (stray !== undefined) throw new HttpError(400, `${stray} is not part of a sheet request`);
  return draftedFight(source, raw, { trainerKey: 'trainer', emptyTeam: true });
}

/** A fight to plan with the team as drafted: what a line start and a sheet request both read (`draftedFight`). */
export interface DraftedFight {
  data: ServerData; box: BoxState;
  /** The catalog's trainer. */
  trainer: ResolvedTrainer;
  /** The copy asked for (`variant`, default 0), and its index. */
  copy: ResolvedTrainer; variant: number;
  /** The team as asked, lead first. */
  refs: MonRef[];
  /** `box.pool` with the team drafted (`draftedPool`). */
  pool: Map<MonRef, PlayerMon>;
  /** The team's Pokémon in order, from `pool`: each as drafted. */
  team: PlayerMon[];
}

/** The AI odds' query for a sheet request's fight. */
export const oddsQuery = (fight: DraftedFight): SheetAiQuery => (
  { data: fight.data, trainer: fight.copy, variant: fight.variant, team: fight.team, save: saveOf(fight.box) });

/**
 * The fight a body asks for, read the one way a line start and a sheet request share: the trainer (`body[trainerKey]`)
 * and its copy (`variant`), the team (`team`, MonRefs of the box's pool, over the level cap included, lead first) and the
 * draft (`draft`, required; `draftedPool`). Checked in this order, the first failure answering: the data (409);
 * `body[trainerKey]` a non-empty string (400) and a trainer (404); `variant` (400); the box (409); `team` an array of
 * strings with no comma (400), each a Pokémon of the pool, once (`teamParam`'s 400s; an empty array is no team when
 * `opts.emptyTeam`, else its 400); `draft` present (400); then the draft's own checks (400 with the `DraftError`'s
 * message).
 */
export function draftedFight(source: FightSource, body: Record<string, unknown>, opts: { trainerKey: 'trainerId' | 'trainer'; emptyTeam: boolean }): DraftedFight {
  const data = source.data();
  const { trainer, copy, variant } = trainerParam(data, body, opts.trainerKey);
  const { team, draft } = body;
  const box = source.box();
  if (!Array.isArray(team) || team.some((ref) => typeof ref !== 'string' || ref.includes(','))) throw new HttpError(400, 'team must be an array of MonRefs');
  const refs = team as MonRef[];
  const members = teamParam(refs, box, box.pool, opts.emptyTeam);
  if (draft === undefined) throw new HttpError(400, 'draft is required: an array of draft entries (an empty array starts the team as the save has it)');
  const pool = draftedPool(draft, refs, members, box, data);
  return { data, box, trainer, copy, variant, refs, pool, team: members.map((mon) => pool.get(monRef(mon.location))!) };
}

/**
 * The box's pool with the team drafted (`draftedFight`'s): a copy of `box.pool` where each of `members` (the team's
 * Pokémon, from the pool) is itself with its entry of `raw` applied (`parseDraft` over `team`, then `applyDraft`), or an
 * empty entry for one the draft leaves out, so it starts as the save has it. The save and the box are not changed. 400
 * with the `DraftError`'s message for a bad draft.
 */
function draftedPool(raw: unknown, team: readonly MonRef[], members: readonly PlayerMon[], box: BoxState, data: ServerData): Map<MonRef, PlayerMon> {
  try {
    const entries = new Map(parseDraft(raw, team).map((entry) => [entry.ref, entry]));
    const mons = new Map(box.pool);
    for (const mon of members) {
      const ref = monRef(mon.location);
      mons.set(ref, applyDraft(mon, entries.get(ref) ?? { ref }, data.local));
    }
    return mons;
  } catch (error) {
    if (error instanceof DraftError) throw new HttpError(400, error.message);
    throw error;
  }
}

/**
 * The trainer a body names and its copy, as a line start, a sheet request and a next fight read them: `body[trainerKey]`
 * a non-empty string (400) and a trainer of the catalog (404); then `variant` a number (400) and one of its copies
 * (`variantParam`).
 */
export function trainerParam(data: ServerData, body: Record<string, unknown>, trainerKey: 'trainerId' | 'trainer'): { trainer: ResolvedTrainer; copy: ResolvedTrainer; variant: number } {
  const id = body[trainerKey];
  if (typeof id !== 'string' || id === '') throw new HttpError(400, `${trainerKey} is required: a trainer ID`);
  const trainer = data.catalog.byId(id);
  if (trainer === undefined) throw new HttpError(404, `No trainer ${id}`);
  const raw = body.variant;
  if (raw !== undefined && typeof raw !== 'number') throw new HttpError(400, 'variant must be a whole number');
  return { trainer, ...variantParam(raw === undefined ? null : String(raw), trainer) };
}

/** `variant` (default 0) as a copy of `trainer`; 400 for anything but a whole number below its number of copies. */
function variantParam(raw: string | null, trainer: ResolvedTrainer): { copy: ResolvedTrainer; variant: number } {
  const variant = raw === null ? 0 : /^\d+$/.test(raw) ? Number(raw) : -1;
  const copy = pickVariant(trainer, variant);
  if (copy !== null) return { copy, variant };
  const copies = 1 + trainer.variants.length;
  throw new HttpError(400, copies === 1
    ? `variant must be 0: ${trainer.name} has one copy`
    : `variant must be a whole number from 0 to ${copies - 1}: ${trainer.name} has ${copies} copies`);
}

/**
 * Why a Pokémon cannot fight (`BoxMonJson.ineligibleReasons`), in the page's words (never
 * "dead"). An unknown-ID reason ("unknown move 999") is as the box has it.
 */
/** Why the fight engine cannot take `mon` (a species past 493, no moves), or null. */
function unfit(mon: PlayerMon): string | null {
  if (!Number.isInteger(mon.species) || mon.species < 1 || mon.species > LAST_SPECIES) return mon.form === 0 ? `unknown species ${mon.species}` : `unknown species ${mon.species} form ${mon.form}`;
  if (mon.moves.length === 0) return NO_MOVES;
  return null;
}

const REASON_WORDS: Readonly<Record<string, string>> = {
  dead: 'in the graveyard', fainted: 'fainted', egg: 'an egg', 'over cap': 'over the level cap', 'bad checksum': 'bad checksum',
};

/**
 * `refs`, MonRefs in the order to show them, as Pokémon of `mons` (`draftedFight` passes the box's pool, over the level cap
 * included). No refs is no team when `emptyTeam`, else a 400; a 400 too for a ref listed twice, or a ref not in `mons`
 * (with why it cannot fight, `REASON_WORDS`), or one the fight engine cannot take (`unfit`), which the box keeps out of
 * the pool already: this guard turns any that gets past it into a 400 before the draft or the engine reads it.
 */
function teamParam(refs: readonly string[], box: BoxState, mons: ReadonlyMap<MonRef, PlayerMon>, emptyTeam: boolean): PlayerMon[] {
  if (refs.length === 0) {
    if (emptyTeam) return [];
    throw new HttpError(400, 'team is empty: list one or more MonRefs');
  }
  const team: PlayerMon[] = [];
  for (const ref of refs) {
    const mon = mons.get(ref);
    if (mon === undefined) {
      const listed = box.json.mons.find((m) => m.ref === ref);
      throw new HttpError(400, listed === undefined
        ? `team: there is no Pokémon at ${ref}`
        : `team: ${ref} cannot fight (${listed.ineligibleReasons.map((reason) => REASON_WORDS[reason] ?? reason).join(', ') || 'not eligible'})`);
    }
    if (team.includes(mon)) throw new HttpError(400, `team lists ${ref} twice`);
    const why = unfit(mon);
    if (why !== null) throw new HttpError(400, `team: ${ref} cannot fight (${why})`);
    team.push(mon);
  }
  return team;
}
