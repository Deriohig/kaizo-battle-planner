// The page's client for the planner's HTTP API (contract in `src/contracts/api.ts`). Each call resolves with the route's
// JSON or rejects with `ApiError`, which carries the server's `{ error }` message and the HTTP status. A PUT or POST
// sends `Content-Type: application/json`: the server's local-only guard answers 415 without it. The event streams
// (`streamExtract`, `streamSheetAi`) are read with `fetch` and `readSse`: EventSource is GET-only, and it
// cannot read the `{ error }` of a failure answered before the stream opens. An aborted request rejects with the
// browser's AbortError, never an ApiError, so a cancel is not shown as a failure. The tree's calls (`startLine`, `nextLine`,
// `getLineNode`, `expandLine`) take the step's `signal` last, so Stop aborts them. So does `postPlanStep`, the plan's one call.
// A hosted server with a password answers a signed-out call 401 `SIGN_IN`: `failure` tells the page once (`onSignInRequired`),
// which draws the sign-in page, and the re-send of a stored save never takes that answer for `NO_SAVE`. `login` and `logout`
// are the two calls that never tell it: a wrong password is the sign-in page's own line.

import type {
  BoxJson, ConfigJson, DraftOptionsJson, HostedSettingsJson, LineExpandJson, LineExpandRequestJson, LineNextRequestJson, LineNodeJson, LineStartRequestJson, SettingsJson, SetupJson,
  SheetAiEvent, SheetAiPairJson, SheetJson, SheetRequestJson, TrainerSummaryJson,
} from '../../src/server/apiTypes';
import {
  GRAVEYARD_HEADER, LEVEL_CAP_HEADER, SAVE_MODIFIED_HEADER, SAVE_NAME_HEADER, SAVE_SOURCE_HEADER, type SaveSource, SESSION_HEADER,
} from '../../src/contracts/hosted';
import type { PlanStepJson, PlanStepRequestJson } from './planTypes';
import { readSse } from './sse';

/**
 * A failed API call: the server's message and the HTTP status (0 when the server could not be reached), and the server's
 * `code` when it sent one (the line builder's `LineErrorCode`), or `NO_ANSWER` when the planner itself did not answer.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** The answer's `Retry-After` in seconds, when it gave one (a 429 or 503). */
  readonly retryAfter: number | undefined;

  constructor(status: number, message: string, code?: string, retryAfter?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** The code of a call the planner did not answer: a fetch that failed, a gateway status without `{ error }`, a stream that dropped. */
export const NO_ANSWER = 'NO_ANSWER';

/** Whether `error` is an aborted request (an `AbortController` fired). */
export function isAbort(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === 'AbortError';
}

/** The words to show for a failure. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** What hosted mode gives the client: this tab's session id, and the one-shot re-send of the stored save. */
export interface HostedHooks { session(): string; resend(): Promise<void> }

let hosted: HostedHooks | null = null;
/** The re-send now running, which every call failing `NO_SAVE` meanwhile waits on. */
let resending: Promise<void> | undefined;
/** How many re-sends have finished, failed ones too, so a call that began before one does not start another. */
let resent = 0;
/** Whether the last finished re-send failed. */
let resendFailed = false;

/** Turns hosted mode on (every request then carries the session header, and `NO_SAVE` re-sends the save once) or off with null. */
export function setHosted(hooks: HostedHooks | null): void {
  hosted = hooks;
  resending = undefined;
  resendFailed = false;
}

/** The code of a call made signed out (401), and of a wrong password. */
export const SIGN_IN = 'SIGN_IN';

/** The one function told when a call is refused `SIGN_IN`: the page's, which draws the sign-in page. */
let signInListener: (() => void) | null = null;

/** Registers who hears of a 401 `SIGN_IN` (null: nobody); returns the way to stop. */
export function onSignInRequired(listener: (() => void) | null): () => void {
  signInListener = listener;
  return () => { if (signInListener === listener) signInListener = null; };
}

const isNoSave = (error: unknown): boolean => error instanceof ApiError && error.status === 409 && error.code === 'NO_SAVE';

/**
 * Runs `call`; while hosted, a 409 `NO_SAVE` awaits one shared re-send and runs the call once more, and a second failure is
 * thrown as it is. A failed re-send rejects with the original `NO_SAVE` error. A call that began before a re-send finished
 * (so its 409 is stale) is run again when that re-send worked, and rejects with its `NO_SAVE` when it failed: it never
 * starts another.
 */
async function withResend<T>(call: () => Promise<T>): Promise<T> {
  const began = resent;
  try {
    return await call();
  } catch (error) {
    const hooks = hosted;
    if (hooks === null || !isNoSave(error)) throw error;
    if (resending === undefined) {
      if (resent !== began) {
        if (resendFailed) throw error;
        return call();
      }
      const run: Promise<void> = hooks.resend()
        .then(() => { resendFailed = false; }, (e: unknown) => { resendFailed = true; throw e; })
        .finally(() => {
          resent += 1;
          if (resending === run) resending = undefined;
        });
      resending = run;
    }
    try {
      await resending;
    } catch {
      throw error;
    }
    return call();
  }
}

/** `fetch`, with a network failure as ApiError status 0, `NO_ANSWER`. While hosted it adds the session header. */
async function send(path: string, init?: RequestInit): Promise<Response> {
  try {
    if (hosted !== null) init = { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), [SESSION_HEADER]: hosted.session() } };
    return await fetch(path, init);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError(0, `Cannot reach the planner server: ${errorMessage(error)}`, NO_ANSWER);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const httpStatus = (res: Response) => `HTTP ${`${res.status} ${res.statusText}`.trim()}`;

function unexpected(res: Response, what: string): ApiError {
  return new ApiError(res.status, `Unexpected answer from the planner server (${httpStatus(res)}): ${what}`);
}

/** A gateway's own failure, such as the Vite dev proxy's 502 while the planner server is down. */
const GATEWAY = new Set([502, 503, 504]);

/**
 * The ApiError for a response that failed: its `{ error }` message, or else the status. A gateway status without one
 * means the planner server itself did not answer (`NO_ANSWER`).
 */
async function failure(res: Response, tell = true): Promise<ApiError> {
  const error = await readFailure(res);
  if (tell && error.status === 401 && error.code === SIGN_IN) signInListener?.();
  return error;
}

async function readFailure(res: Response): Promise<ApiError> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    // the body went away; the status still says what happened
  }
  const wait = Number(res.headers.get('Retry-After') ?? '');
  const retryAfter = res.headers.has('Retry-After') && Number.isFinite(wait) && wait >= 0 ? wait : undefined;
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body) && typeof body.error === 'string') {
      return new ApiError(res.status, body.error, typeof body.code === 'string' ? body.code : undefined, retryAfter);
    }
  } catch {
    // not JSON: a proxy's answer, not the planner's
  }
  if (GATEWAY.has(res.status)) return new ApiError(res.status, `Cannot reach the planner server (${httpStatus(res)})`, NO_ANSWER);
  return unexpected(res, text.trim() === '' ? 'no error message' : 'not an error message');
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await failure(res);
  try {
    return (await res.json()) as T;
  } catch (error) {
    if (isAbort(error)) throw error;
    throw unexpected(res, 'not JSON');
  }
}

const get = async <T>(path: string, signal?: AbortSignal): Promise<T> => json<T>(await send(path, signal === undefined ? undefined : { signal }));

export const getSetup = () => get<SetupJson>('/api/setup');
export const getSettings = () => get<SettingsJson>('/api/settings');
export const getBox = () => withResend(() => get<BoxJson>('/api/box'));

/**
 * What `GET /api/config` says, with the two sign-in fields of a hosted server that has a password (the server lane adds
 * them to `ConfigJson`; a server without them is read as not asking for a password).
 */
export type PageConfig = ConfigJson & { passwordRequired?: boolean; signedIn?: boolean };

/** Which mode the server runs in (`GET /api/config`). A server without the route (404) is an older, local one. */
export async function getConfig(): Promise<PageConfig> {
  const res = await send('/api/config');
  if (res.status === 404) return { mode: 'local' };
  return json<PageConfig>(res);
}

/**
 * Hosted with a password: signs in (`POST /api/login`, 204 sets the cookie). A wrong password is `ApiError` 401, a flood 429
 * with `retryAfter`. The sign-in page sends no name; the server still takes an optional one for the log.
 */
export async function login(password: string, name = ''): Promise<void> {
  const body: { password: string; name?: string } = { password };
  if (name.trim() !== '') body.name = name.trim();
  const res = await send('/api/login', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res, false);
}

/** Hosted with a password: signs out (`POST /api/logout`, 204 clears the cookie). */
export async function logout(): Promise<void> {
  const res = await send('/api/logout', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
  if (!res.ok) throw await failure(res, false);
}

/**
 * Hosted: uploads the save (`PUT /api/save`) with its name, its file time, the two settings that live in the browser and
 * how it came to be sent (`source`, for the server's usage log); the server answers with the box. Never re-sends: it is
 * the re-send.
 */
export async function putSave(
  save: { bytes: Blob | ArrayBuffer; name: string; modified: number }, settings: HostedSettingsJson, source: SaveSource, signal?: AbortSignal,
): Promise<BoxJson> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    [SAVE_NAME_HEADER]: encodeURIComponent(save.name),
    [SAVE_MODIFIED_HEADER]: String(Math.trunc(save.modified)),
    [SAVE_SOURCE_HEADER]: source,
  };
  if (settings.graveyardBox !== null) headers[GRAVEYARD_HEADER] = String(settings.graveyardBox);
  if (settings.levelCapOverride !== null) headers[LEVEL_CAP_HEADER] = String(settings.levelCapOverride);
  return json<BoxJson>(await send('/api/save', { method: 'PUT', headers, body: save.bytes, signal }));
}

/** Hosted: forgets this session's save on the server (`DELETE /api/save`, 204). */
export async function deleteSave(): Promise<void> {
  const res = await send('/api/save', { method: 'DELETE' });
  if (!res.ok) throw await failure(res);
}
/** What the draft editor offers every Pokémon: the items it may hold and the EXP tables (409 without the data). */
export const getDraftOptions = () => get<DraftOptionsJson>('/api/draft/options');

/** Saves the whole settings (the server refuses a partial body) and resolves with them as stored, paths in WSL form. */
export async function putSettings(s: SettingsJson): Promise<SettingsJson> {
  return json<SettingsJson>(await send('/api/settings', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(s) }));
}

/** The trainers in game order; with `search`, those whose name, location or tags match it. */
export function getTrainers(search?: string): Promise<TrainerSummaryJson[]> {
  const query = search === undefined || search === '' ? '' : `?${new URLSearchParams({ search })}`;
  return get<TrainerSummaryJson[]>(`/api/trainers${query}`);
}

/** Which sheet: a trainer copy against the team as drafted, in order, each Pokémon with its edits (every key given). */
export type SheetQuery = Required<SheetRequestJson>;

/**
 * A trainer copy's sheet against the team as drafted (`POST /api/sheet`). A draft the server refuses rejects with its
 * own words ("draft: party:1 …").
 */
export function postSheet(q: SheetQuery, signal?: AbortSignal): Promise<SheetJson> {
  return withResend(async () => json<SheetJson>(await send('/api/sheet', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(q), signal })));
}

/** Starts a line (`POST /api/line/start`): the root node. */
export async function startLine(req: LineStartRequestJson, signal?: AbortSignal): Promise<LineNodeJson> {
  return json<LineNodeJson>(await send('/api/line/start', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(req), signal }));
}

/**
 * Starts the next trainer's line from a won node, the team as that node's battle left it (`POST /api/line/next`): the new
 * line's root, whose `carried` says where its team came from. Rejects as `startLine` does, with `code` LINE_LOST when the
 * server no longer holds the won line.
 */
export async function nextLine(req: LineNextRequestJson, signal?: AbortSignal): Promise<LineNodeJson> {
  return json<LineNodeJson>(await send('/api/line/next', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(req), signal }));
}

/** A node of a line (`GET /api/line/node`). Rejects with an ApiError whose `code` is LINE_LOST when the server no longer holds it. */
export const getLineNode = (line: string, node: string, signal?: AbortSignal) =>
  get<LineNodeJson>(`/api/line/node?${new URLSearchParams({ line, node })}`, signal);

/** The outcomes of the step from a node, with the player's `choice` where he decides (`POST /api/line/expand`). */
export async function expandLine(req: LineExpandRequestJson, signal?: AbortSignal): Promise<LineExpandJson> {
  return json<LineExpandJson>(await send('/api/line/expand', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(req), signal }));
}

/** The plan's one call: what the page asks of the server for one state of a fight. Tests may pass another of this shape to `usePlan`. */
export type PlanStepFn = (req: PlanStepRequestJson, signal?: AbortSignal) => Promise<PlanStepJson>;

/** One state of the plan: his choices, the damage, the trainer AI's odds and, once their active is marked fainted, who comes next (`POST /api/plan/step`). */
export const postPlanStep: PlanStepFn = (req, signal) =>
  withResend(async () => json<PlanStepJson>(await send('/api/plan/step', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(req), signal })));

/** Thrown inside `readSse`'s callback to stop reading once the last event has come. */
const STOP = Symbol('stop');

/**
 * Opens an event-stream route (`init`: its method, body and signal) and reads it: each event's JSON data goes to
 * `onEvent`, which returns true for the stream's last event (`last` names it) and may throw an ApiError to stop. An
 * `error` event rejects with ApiError (status 200: the stream itself opened fine). A non-200 answer rejects with its
 * `{ error }`; a stream that ends or drops before its last event rejects too, as `NO_ANSWER`.
 */
async function readStream(
  path: string, init: RequestInit, last: string, onEvent: (event: string, data: unknown, res: Response) => boolean,
): Promise<void> {
  const res = await send(path, init);
  if (res.status !== 200) throw await failure(res);
  if (res.body === null) throw unexpected(res, 'an empty stream');
  let error: ApiError | undefined;
  let ended = false;
  try {
    await readSse(res.body, (e) => {
      let data: unknown;
      try {
        data = JSON.parse(e.data);
      } catch {
        throw unexpected(res, `a ${e.event} event that is not JSON`);
      }
      if (e.event === 'error') error = new ApiError(res.status, isRecord(data) && typeof data.error === 'string' ? data.error : 'The server sent an error without a message');
      else if (onEvent(e.event, data, res)) ended = true;
      else return;
      throw STOP;
    });
  } catch (err) {
    if (err !== STOP) {
      if (isAbort(err) || err instanceof ApiError) throw err;
      throw new ApiError(0, `The connection to the planner server dropped: ${errorMessage(err)}`, NO_ANSWER);
    }
  }
  if (error !== undefined) throw error;
  if (!ended) throw new ApiError(res.status, `The planner server closed the stream before the ${last} event`, NO_ANSWER);
}

/**
 * POSTs `body` to an event-stream route and reads it: each `progress` event goes to `onProgress`, then `result` resolves.
 * Any other event is one this page does not know, and is skipped; `readStream` says how it fails.
 */
async function stream<T>(path: string, body: unknown, result: string, onProgress: (data: unknown) => void, signal?: AbortSignal): Promise<T> {
  let value: T | undefined;
  await readStream(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body), signal }, result, (event, data) => {
    if (event === 'progress') onProgress(data);
    else if (event === result) value = data as T;
    return event === result;
  });
  return value as T;
}

/** The sheet AI stream's `start`: the save its odds are for, and how many pairs the sheet has. */
export type SheetAiStart = Extract<SheetAiEvent, { name: 'start' }>['data'];

/**
 * The trainer AI's odds for the sheet `q` asks for, pair by pair as each is worked out (`POST /api/sheet/ai/stream`, the
 * same body): `onStart` with the save they are for, then `onPair` for each pair, and it resolves at `done`. A pair, or
 * `done`, before `start` rejects as an unexpected answer, so no pair is handed over before its save is known. Abort
 * `signal` to close the stream.
 */
export function streamSheetAi(
  q: SheetQuery, h: { onStart(start: SheetAiStart): void; onPair(pair: SheetAiPairJson): void }, signal: AbortSignal,
): Promise<void> {
  let started = false;
  const init: RequestInit = { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(q), signal };
  return withResend(() => readStream('/api/sheet/ai/stream', init, 'done', (event, data, res) => {
    if (event === 'start') {
      started = true;
      h.onStart(data as SheetAiStart);
      return false;
    }
    if (event !== 'pair' && event !== 'done') return false;  // an event this page does not know
    if (!started) throw unexpected(res, `a ${event} before the start event`);
    if (event === 'pair') h.onPair(data as SheetAiPairJson);
    return event === 'done';
  }));
}

/** Extracts the ROM's data (`POST /api/setup/extract`): each progress line to `onProgress`, then the new SetupJson. */
export function streamExtract(romPath: string, h: { onProgress(m: string): void }, signal?: AbortSignal): Promise<SetupJson> {
  return stream<SetupJson>('/api/setup/extract', { romPath }, 'done', (data) => {
    if (isRecord(data) && typeof data.message === 'string') h.onProgress(data.message);
  }, signal);
}
