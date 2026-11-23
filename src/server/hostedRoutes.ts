// Hosted mode's app: many players on one server, each with the box of the save their
// browser uploaded, held under the session id their page made. Its route table is built here, over `HostedDeps`, which
// has no settings file, extractor, save roots, watcher, file reader or server state: no route of it can read, list or
// write a path it was given. The routes local mode has and hosted mode lacks (setup, extract, settings, events, the line
// builder) are simply not in the table, so they answer the same 404 as any unknown path.
//
// Every request runs this guard, in this order: the security headers; `GET /api/health` (no password, never limited);
// the `Origin` check; for an API path other than health, config, login and logout, the sign-in (401 `SIGN_IN`, no
// popup: the page shell and its assets are public, so the page can show its sign-in screen); the route lookup (404,
// 405); the rate limit; the session header (400) and, for a
// route that reads the box, the session itself (409 `NO_SAVE`); the content type (415); then the route. The fight
// routes run through the work gate. A 500 answers a ref and logs the stack under it.

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AiOddsLevel, ConfigJson, DraftOptionsJson } from '../contracts/api.js';
import { MAX_SAVE_BYTES, POLL_MS, SAVE_SOURCE_HEADER } from '../contracts/hosted.js';
import { AI_ODDS_OFF } from './aiOdds.js';
import { draftItems } from './draft.js';
import {
  answerPlanStep, type FightSource, isRecord, lineDepsFor, oddsQuery, PlanAnswers, planStepQuery, sheetAiDeps, sheetBody, sheetJson, streamOdds,
} from './fight.js';
import {
  accessGuard, type BodyType, checkContentType, checkOrigin, clientIp, sessionIdOf, sessionIdOrNull, setSecurityHeaders,
} from './hostedGuard.js';
import { HOSTED_JSON_BYTES, hostedInternalError, HttpError, type JsonBodyCap, readJsonBody, sendError, sendJson } from './http.js';
import { createRateLimiter, createWorkGate, type RateClass, type RateLimiter, rateKey, rateLimited, type WorkGate } from './limits.js';
import type { LineDeps } from './lines.js';
import {
  createLog, deviceSummary, errorRef, firstLanguage, type HostedLog, logIp, type RequestLine, saveFormat, saveSource, sessionTag,
} from './log.js';
import { type HostedConfig, healthJson } from './mode.js';
import { createPlanService } from './plan.js';
import { readUploadBody, uploadedBox, uploadMeta } from './saveUpload.js';
import { createSessionStore, type SessionStore } from './sessions.js';
import { cameOverHttps, cleanName, makeToken, signInCookie, signOutCookie } from './signIn.js';
import type { SheetBuilder } from './sheet.js';
import { createSheetAi, type SheetAiDeps } from './sheetAi.js';
import { sendSprite, SPRITE_CACHE_CONTROL, SPRITE_PREFIX } from './sprites.js';
import type { ServerData } from './state.js';
import { ASSET_CACHE_CONTROL, serveStatic } from './static.js';
import { searchTrainers } from './trainers.js';

/** The limits and switches hosted mode takes from `HostedConfig` (mode.ts). */
export type HostedLimits = Pick<HostedConfig,
  'password' | 'trustProxy' | 'allowOrigins' | 'maxSessions' | 'sessionsPerIp' | 'sessionIdleMs' | 'sessionMemoryBytes'
  | 'heavyConcurrency' | 'heavyQueue' | 'version'>;

/**
 * What the hosted app is built from. Deliberately small (section 4.2's structure rule): the data loaded once at start,
 * the bundle folder (read only for the sprites and, through `sheetAi` and `lines`, the trainer AI's file), the built page
 * and the engine's deps. No settings file, extractor, save roots, watcher, file reader, sprite extractor or server state.
 */
export interface HostedDeps {
  data: ServerData;
  /** The bundle folder; the sprites are served from its `sprites/`. */
  dataDir: string;
  /** The built page; null serves none (the tests). */
  staticDir: string | null;
  buildSheet: SheetBuilder;
  sheetAi?: SheetAiDeps | ((data: ServerData) => SheetAiDeps);
  lines?: LineDeps | ((data: ServerData) => LineDeps);
  limits: HostedLimits;
  log: HostedLog;
  /** The clock (sessions, rate limits, the upload's modified-time check); the tests pass a fake one. */
  now?: () => number;
  /** The AI odds level (`PKP_AI_ODDS`, aiOdds.ts), `full` when left out. */
  aiOdds?: AiOddsLevel;
}

/** A plan step's, and a sheet's, time in the work gate. */
export const STEP_TIMEOUT_MS = 20_000;
/** An AI stream's time in the work gate. */
export const STREAM_TIMEOUT_MS = 120_000;
/** How often the sessions and the rate buckets are swept. */
const SWEEP_MS = 60_000;

const JSON_CAP: JsonBodyCap = { maxBytes: HOSTED_JSON_BYTES, label: '256 KiB', code: 'TOO_LARGE' };

/** The most Pokémon a sheet or an AI stream is worked out for: a party. */
const MAX_SHEET_TEAM = 6;

/**
 * A sheet request's body, refused with 400 before any work when its `team` lists more than a party: the sheet is worked
 * out in one go, so a team of hundreds would hold the thread past any time limit. Everything else is `sheetBody`'s.
 */
function cappedTeam(body: unknown): unknown {
  if (isRecord(body) && Array.isArray(body.team) && body.team.length > MAX_SHEET_TEAM) throw new HttpError(400, `team must hold at most ${MAX_SHEET_TEAM} Pokémon`);
  return body;
}

/** What a route needs of the request: the session, when the route is session-scoped. */
interface Context { req: IncomingMessage; res: ServerResponse; url: URL; ip: string; session: string | null }

/**
 * A hosted route: its rate class; `session` "box" for a route that reads the session's box (409 `NO_SAVE` without
 * one), "id" for one that only needs the header (the upload, the delete), none for a route shared by everyone; and the
 * body type it takes.
 */
interface HostedRoute { rate: RateClass; session?: 'box' | 'id'; body?: BodyType; handle(ctx: Context): void | Promise<void> }

export interface HostedApp {
  listener: http.RequestListener;
  sessions: SessionStore;
  limiter: RateLimiter;
  gate: WorkGate;
  /** Stops the sweeps. */
  close(): void;
}

/** The API paths open without a sign-in: the page asks the config first, and signs in and out through these. */
const PUBLIC_API: ReadonlySet<string> = new Set(['/api/health', '/api/config', '/api/login', '/api/logout']);
/** What a sign-in request may hold. */
const LOGIN_KEYS: ReadonlySet<string> = new Set(['password', 'name']);

/** The answer to a request for a path no hosted route has, whatever its method, headers or body. */
const notFound = (pathname: string) => new HttpError(404, `No API route ${pathname}`);

export function createHostedApp(deps: HostedDeps): HostedApp {
  const { data, limits, log } = deps;
  const now = deps.now ?? Date.now;
  const sessions = createSessionStore({
    maxSessions: limits.maxSessions, perIp: limits.sessionsPerIp, idleMs: limits.sessionIdleMs, memoryBytes: limits.sessionMemoryBytes, now,
  });
  const limiter = createRateLimiter({ now });
  const gate = createWorkGate({ concurrency: limits.heavyConcurrency, queue: limits.heavyQueue });
  const access = accessGuard(limits.password, limiter, now);
  /** Who each answered request was, once the guard or a sign-in has said, for its log line. */
  const users = new WeakMap<ServerResponse, string | null>();
  const noStore = (res: ServerResponse, cookie: string | null) => {
    res.writeHead(204, { 'Cache-Control': 'no-store', ...(cookie === null ? {} : { 'Set-Cookie': cookie }) });
    res.end();
  };
  const aiDeps = sheetAiDeps(deps.sheetAi);
  const sheetAi = aiDeps === null ? null : createSheetAi({ deps: aiDeps, buildSheet: deps.buildSheet });
  const lineDeps = lineDepsFor(deps.lines);
  const aiOdds = deps.aiOdds ?? 'full';
  const plans = lineDeps === null ? null : createPlanService({ deps: lineDeps, aiOdds });
  const planAnswers = new PlanAnswers();
  // Behind the password, nothing may sit in a shared cache that someone without it could be served from.
  const privately = (header: string) => (limits.password === null ? header : header.replace(/^public\b/, 'private'));
  const spriteCache = privately(SPRITE_CACHE_CONTROL);
  const assetCache = privately(ASSET_CACHE_CONTROL);
  /** The error code each answer carried, for its log line. */
  const codes = new WeakMap<ServerResponse, string>();
  /** What a route learned for its log line (section 4.9): an upload's format and run, a fight route's trainer. */
  const details = new WeakMap<ServerResponse, Partial<Pick<RequestLine, 'fmt' | 'run' | 'fight'>>>();
  const note = (res: ServerResponse, detail: Partial<Pick<RequestLine, 'fmt' | 'run' | 'fight'>>) => details.set(res, { ...details.get(res), ...detail });
  /** The trainer ID a fight route's body names at `key`, when the catalog has it: so the log only ever holds the catalog's IDs. */
  const noteFight = (res: ServerResponse, body: unknown, key: 'trainer' | 'trainerId') => {
    const id = isRecord(body) ? body[key] : undefined;
    if (typeof id === 'string' && data.catalog.byId(id) !== undefined) note(res, { fight: id });
  };
  let warnedProxy = false;
  const onProxied = () => {
    if (warnedProxy) return;
    warnedProxy = true;
    log.warn('A request came with X-Forwarded-For while PKP_TRUST_PROXY is 0: every player behind the proxy shares its limits and sessions. Set PKP_TRUST_PROXY to the number of proxies in front');
  };

  /** The session's fight source: the bundle's data, and the box the session holds now (409 `NO_SAVE` without one). */
  const sourceOf = (session: string): FightSource => ({
    data: () => data,
    box: () => {
      const held = sessions.get(session);
      if (held === undefined) throw noSave();
      return held.box;
    },
  });

  const routes = new Map<string, Readonly<Record<string, HostedRoute>>>([
    ['/api/health', { GET: { rate: 'light', handle: ({ res }) => sendJson(res, 200, healthJson('hosted', limits.version)) } }],
    ['/api/config', {
      GET: {
        rate: 'light',
        handle: ({ req, res }) => sendJson(res, 200, {
          mode: 'hosted', version: limits.version, maxSaveBytes: MAX_SAVE_BYTES, pollMs: POLL_MS,
          passwordRequired: limits.password !== null, signedIn: access.peek(req) !== null, aiOdds,
        } satisfies ConfigJson),
      },
    }],
    // The sign-in page's: the right password gives a cookie signed with a key derived from it (signIn.ts), for 30 days;
    // a wrong one is 401 "Wrong password" and counts toward the wrong-password limit. On a public site there is nothing
    // to sign in to: 204 and no cookie.
    ['/api/login', {
      POST: {
        rate: 'light', body: 'json',
        async handle({ req, res, ip }) {
          const body = await readJsonBody(req, JSON_CAP);
          if (!isRecord(body)) throw new HttpError(400, 'The body must be a JSON object');
          const stray = Object.keys(body).find((key) => !LOGIN_KEYS.has(key));
          if (stray !== undefined) throw new HttpError(400, `${stray} is not part of a sign-in`);
          if (typeof body.password !== 'string') throw new HttpError(400, 'password is required');
          if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') throw new HttpError(400, 'name must be text');
          if (limits.password === null) return noStore(res, null);
          access.login(body.password, ip);
          const name = cleanName(body.name);
          users.set(res, name);
          noStore(res, signInCookie(makeToken(limits.password, name, now()), cameOverHttps(req, limits.trustProxy)));
        },
      },
    }],
    ['/api/logout', { POST: { rate: 'light', handle: ({ req, res }) => noStore(res, signOutCookie(cameOverHttps(req, limits.trustProxy))) } }],
    ['/api/save', {
      PUT: {
        rate: 'upload', session: 'id', body: 'octet',
        async handle({ req, res, ip, session }) {
          const file = await readUploadBody(req, { maxBytes: MAX_SAVE_BYTES });
          note(res, { fmt: saveFormat(file) });
          const meta = uploadMeta(req.headers, now());
          const box = uploadedBox(file, meta, data, (error) => log.error(errorRef(), 'PUT /api/save: the save did not read', error));
          sessions.put(session!, box, rateKey(ip));
          note(res, { run: { badges: box.json.badges, split: box.json.run.split === '' ? null : box.json.run.split, cap: box.json.levelCap } });
          sendJson(res, 200, box.json);
        },
      },
      DELETE: {
        rate: 'light', session: 'id',
        handle({ res, session }) {
          sessions.delete(session!);
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
        },
      },
    }],
    ['/api/box', { GET: { rate: 'light', session: 'box', handle: ({ res, session }) => sendJson(res, 200, sourceOf(session!).box().json) } }],
    ['/api/trainers', { GET: { rate: 'light', handle: ({ res, url }) => sendJson(res, 200, searchTrainers(data.catalog, url.searchParams.get('search'))) } }],
    ['/api/draft/options', {
      GET: { rate: 'light', handle: ({ res }) => sendJson(res, 200, { items: draftItems(data.local), growth: data.local.rom.growth } satisfies DraftOptionsJson) },
    }],
    ['/api/sheet', {
      POST: {
        rate: 'work', session: 'box', body: 'json',
        async handle({ req, res, ip, session }) {
          const raw = await readJsonBody(req, JSON_CAP);
          noteFight(res, raw, 'trainer');
          const fight = sheetBody(sourceOf(session!), cappedTeam(raw));
          const body = await gate.run(session!, closedSignal(res), STEP_TIMEOUT_MS, async () => sheetJson(fight, deps.buildSheet), rateKey(ip));
          sendJson(res, 200, body);
        },
      },
    }],
    ['/api/sheet/ai/stream', {
      POST: {
        rate: 'work', session: 'box', body: 'json',
        async handle({ req, res, ip, session }) {
          if (aiOdds === 'off') throw new HttpError(501, AI_ODDS_OFF);
          if (sheetAi === null) throw new HttpError(501, 'The AI odds are not available');
          const raw = await readJsonBody(req, JSON_CAP);
          noteFight(res, raw, 'trainer');
          const query = oddsQuery(sheetBody(sourceOf(session!), cappedTeam(raw)));
          await gate.run(session!, closedSignal(res), STREAM_TIMEOUT_MS, (signal) => streamOdds(req, res, sheetAi, query, {
            signal, aiOdds,
            failure: (error) => {
              if (signal.aborted) return 'The odds took too long to work out; ask again';
              const ref = errorRef();
              log.error(ref, 'POST /api/sheet/ai/stream', error);
              return hostedInternalError(ref).error;
            },
          }), rateKey(ip));
        },
      },
    }],
    ['/api/plan/step', {
      POST: {
        rate: 'work', session: 'box', body: 'json',
        async handle({ req, res, ip, session }) {
          if (plans === null) throw new HttpError(501, 'The tree builder is not available');
          const raw = await readJsonBody(req, JSON_CAP);
          noteFight(res, raw, 'trainerId');
          const step = planStepQuery(sourceOf(session!), raw);
          sendJson(res, 200, await answerPlanStep(res, planAnswers, plans, step, (work, closed) => gate.run(session!, closed, STEP_TIMEOUT_MS, work, rateKey(ip))));
        },
      },
    }],
  ]);

  async function api(ctx: Context): Promise<void> {
    const { req, res, url } = ctx;
    const { pathname } = url;
    const method = req.method ?? 'GET';
    if (!PUBLIC_API.has(pathname)) users.set(res, access.check(req, ctx.ip).user);
    if (pathname.startsWith(SPRITE_PREFIX)) {
      limit('static', ctx.ip);
      if (method !== 'GET' && method !== 'HEAD') {
        res.setHeader('Allow', 'GET');
        throw new HttpError(405, `${method} is not allowed on ${pathname}; use GET`);
      }
      return sendSprite(req, res, deps.dataDir, pathname, spriteCache);
    }
    const methods = routes.get(pathname);
    if (methods === undefined) throw notFound(pathname);
    const route = methods[method];
    if (route === undefined) {
      const allowed = Object.keys(methods).join(', ');
      res.setHeader('Allow', allowed);
      throw new HttpError(405, `${method} is not allowed on ${pathname}; use ${allowed}`);
    }
    limit(route.rate, ctx.ip);
    if (route.session !== undefined) {
      ctx.session = sessionIdOf(req);
      if (route.session === 'box' && !sessions.has(ctx.session)) throw noSave();
    }
    if (route.body !== undefined) checkContentType(req, route.body);
    await route.handle(ctx);
  }

  function limit(cls: RateClass, ip: string): void {
    const retry = limiter.take(cls, rateKey(ip));
    if (retry !== null) throw rateLimited(retry);
  }

  async function handle(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const url = requestUrl(req);
    const { pathname } = url;
    const ctx: Context = { req, res, url, ip, session: null };
    if (pathname === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, healthJson('hosted', limits.version));
      return;
    }
    checkOrigin(req, limits.allowOrigins);
    if (pathname === '/api' || pathname.startsWith('/api/')) return api(ctx);
    limit('static', ip);
    if (deps.staticDir !== null && (await serveStatic(req, res, deps.staticDir, { assetCacheControl: assetCache }))) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  function logLine(req: IncomingMessage, res: ServerResponse, ip: string, started: number, startedAt: Date): void {
    let pathname: string;
    try {
      pathname = requestUrl(req).pathname;
    } catch {
      pathname = (req.url ?? '/').replace(/[?#].*$/s, '');
    }
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    const quiet = !isApi || pathname.startsWith(SPRITE_PREFIX) || pathname === '/api/health';
    if (quiet && res.statusCode < 400) return;
    const id = sessionIdOrNull(req);
    const length = req.headers['content-length'];
    const method = req.method ?? 'GET';
    const detail = details.get(res);
    log.request({
      t: startedAt.toISOString(), ip: logIp(ip), m: method, p: pathname.slice(0, 200), s: res.statusCode, ms: Date.now() - started,
      in: length !== undefined && /^\d+$/.test(length) ? Number(length) : 0, sess: id === null ? null : sessionTag(id), code: codes.get(res) ?? null,
      user: users.has(res) ? users.get(res)! : access.peek(req)?.user ?? null,
      ua: deviceSummary(req.headers['user-agent']), lang: firstLanguage(req.headers['accept-language']),
      src: method === 'PUT' && pathname === '/api/save' ? saveSource(req.headers[SAVE_SOURCE_HEADER]) : null,
      fmt: detail?.fmt ?? null, run: detail?.run ?? null, fight: detail?.fight ?? null,
      // No request carries a turn count yet (PlanStepRequestJson has none, and the step refuses a key it lacks).
      turns: null,
    });
  }

  const listener: http.RequestListener = (req, res) => {
    const started = Date.now();
    const startedAt = new Date();
    setSecurityHeaders(res);
    let ip = '0.0.0.0';
    try {
      ip = clientIp(req, limits.trustProxy, onProxied);
    } catch {
      // the socket's own address stays
    }
    res.once('close', () => logLine(req, res, ip, started, startedAt));
    handle(req, res, ip).catch((error: unknown) => {
      if (error instanceof HttpError) {
        if (error.code !== undefined) codes.set(res, error.code);
        sendError(res, error.status, error.message, error.code, error.headers);
        return;
      }
      const ref = errorRef();
      log.error(ref, `${req.method} ${(req.url ?? '/').replace(/[?#].*$/s, '').slice(0, 200)}`, error);
      codes.set(res, 'INTERNAL');
      const body = hostedInternalError(ref);
      sendError(res, 500, body.error, body.code);
    });
  };

  const sweep = setInterval(() => {
    sessions.sweep();
    limiter.sweep();
  }, SWEEP_MS);
  sweep.unref();

  return { listener, sessions, limiter, gate, close: () => clearInterval(sweep) };
}

/** 409 `NO_SAVE` (section 5.3): one answer for never loaded, expired and restarted. */
const noSave = (): HttpError => new HttpError(409, 'Load your save again', 'NO_SAVE');

/** A signal that aborts when `res` closes before it is finished (the page moved on). */
function closedSignal(res: ServerResponse): AbortSignal {
  const closed = new AbortController();
  res.once('close', () => { if (!res.writableFinished) closed.abort(); });
  if (res.destroyed) closed.abort();
  return closed.signal;
}

/** The request target as a URL; 400 for one that does not parse. */
function requestUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://hosted.invalid');
  } catch {
    throw new HttpError(400, 'The request target is not a valid path');
  }
}

/** Section 4.6's server timeouts and connection cap. */
export const SERVER_LIMITS = { headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 65_000, maxConnections: 1_024 } as const;

/**
 * Serves the hosted app on `host`:`port` (0 picks a free port) with section 4.6's timeouts. Rejects with the listen
 * error (EADDRINUSE). `close` stops the sweeps and ends every connection, streams included.
 */
export async function startHostedServer(deps: Omit<HostedDeps, 'log'> & { log?: HostedLog; host: string; port: number }): Promise<{ url: string; app: HostedApp; close(): Promise<void> }> {
  const log = deps.log ?? createLog({ requests: true });
  const app = createHostedApp({ ...deps, log });
  const server = http.createServer(app.listener);
  server.headersTimeout = SERVER_LIMITS.headersTimeout;
  server.requestTimeout = SERVER_LIMITS.requestTimeout;
  server.keepAliveTimeout = SERVER_LIMITS.keepAliveTimeout;
  server.maxConnections = SERVER_LIMITS.maxConnections;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(deps.port, deps.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    app.close();
    throw error;
  }
  server.on('error', (error) => log.error(errorRef(), 'server', error));
  const { address, port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${address.includes(':') ? `[${address}]` : address}:${port}`,
    app,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        app.close();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
