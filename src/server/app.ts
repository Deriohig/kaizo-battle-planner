// The HTTP app, on plain `node:http`: the `/api/*` routes over the server state (contract in `src/contracts/api.ts`),
// and the built page for every other path. `POST /api/sheet` gives the matchup sheet and `POST /api/sheet/ai/stream` the
// trainer AI's odds for it, both for the team as drafted (`SheetRequestJson`), which they read through the line start's
// own path (`draftedFight`). The odds are worked out in a batch that yields between pairs (sheetAi.ts), so the other
// routes answer meanwhile, and the stream sends the batch's pairs one by one as they are worked out. An API answer is
// JSON, `{ error }` with a 4xx/5xx status when it fails, except the server-sent event streams of `GET /api/events`,
// `POST /api/sheet/ai/stream` and `POST /api/setup/extract` (`setup.ts`), which answer JSON only for a failure before the
// stream opens, and the sprites under `/api/sprites/` (sprites.ts), which answer PNGs. Every `/api` request passes the
// local-only guard (`checkLocalRequest`); the page does not need it.
// Only a 500, and a stream's own failure, is logged. `startServer` binds 127.0.0.1 only. This is local mode's route table;
// hosted mode has its own (hostedRoutes.ts), and the fight routes' reading both share is in
// fight.ts, over a `FightSource`. `GET /api/config` and `GET /api/health` answer in both modes.

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AiOddsLevel, ConfigJson, DraftOptionsJson } from '../contracts/api.js';
import type { Choice } from '../contracts/engine.js';
import { oneLineMessage as oneLine } from '../docs/fetchDocs.js';
import { AI_ODDS_OFF } from './aiOdds.js';
import { draftItems } from './draft.js';
import {
  answerPlanStep, draftedFight, isRecord, lineDepsFor, localFightSource, oddsQuery, PlanAnswers, planStepQuery, sheetAiDeps,
  sheetBody, sheetJson, streamOdds, trainerParam, worldParam,
} from './fight.js';
import { checkLocalRequest, HttpError, readJsonBody, requireBox, requireData, sendError, sendJson } from './http.js';
import { createLineService, type LineNextQuery, type LineStartQuery } from './lines.js';
import { healthJson } from './mode.js';
import { createPlanService } from './plan.js';
import { parseSettings } from './settings.js';
import { createSetupRoutes } from './setup.js';
import { sendSprite, SPRITE_PREFIX } from './sprites.js';
import { createSheetAi } from './sheetAi.js';
import { openSse } from './sse.js';
import { createState, SavePathError, type ServerDeps, type ServerState } from './state.js';
import { serveStatic } from './static.js';
import { searchTrainers } from './trainers.js';

/**
 * `version` is `GET /api/health`'s (`PKP_VERSION`, else "dev"); `aiOdds` the AI odds level (`PKP_AI_ODDS`, aiOdds.ts),
 * `full` when left out.
 */
export type AppDeps = ServerDeps & { state: ServerState; version?: string; aiOdds?: AiOddsLevel };


const HOST = '127.0.0.1';

type Route = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;

/** The request listener: `/api/*` to its route, anything else to the built page (404 without one). */
export function createApp(deps: AppDeps): http.RequestListener {
  const routes = apiRoutes(deps);

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { pathname } = url;
    const method = req.method ?? 'GET';
    if (pathname.startsWith(SPRITE_PREFIX)) {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        throw new HttpError(405, `${method} is not allowed on ${pathname}; use GET`);
      }
      return sendSprite(req, res, deps.dataDir, pathname);
    }
    const methods = routes.get(pathname);
    if (methods === undefined) throw new HttpError(404, `No API route ${method} ${pathname}`);
    const route = methods[method];
    if (route === undefined) {
      const allowed = Object.keys(methods).join(', ');
      res.setHeader('Allow', allowed);
      throw new HttpError(405, `${method} is not allowed on ${pathname}; use ${allowed}`);
    }
    await route(req, res, url);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = requestUrl(req);
    const { pathname } = url;
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      checkLocalRequest(req);
      return api(req, res, url);
    }
    if (deps.staticDir !== null && (await serveStatic(req, res, deps.staticDir))) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendError(res, error.status, error.message, error.code);
        return;
      }
      console.error(`${req.method} ${req.url} failed:`, error);
      sendError(res, 500, oneLine(error));
    });
  };
}

/** The request target as a URL; 400 for one that does not parse (such as `//`). */
function requestUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', `http://${HOST}`);
  } catch {
    throw new HttpError(400, `The request target ${JSON.stringify(req.url)} is not a valid path`);
  }
}

function apiRoutes(deps: AppDeps): Map<string, Record<string, Route>> {
  const { state } = deps;
  const source = localFightSource(state);
  const version = deps.version ?? 'dev';
  const aiOdds = deps.aiOdds ?? 'full';
  const setup = createSetupRoutes({ state, dataDir: deps.dataDir, extract: deps.extract, saveRoots: deps.saveRoots, sprites: deps.sprites });
  const aiDeps = sheetAiDeps(deps.sheetAi);
  const sheetAi = aiDeps === null ? null : createSheetAi({ deps: aiDeps, buildSheet: deps.buildSheet });
  const lineDeps = lineDepsFor(deps.lines);
  const lines = lineDeps === null ? null : createLineService({ deps: lineDeps });
  // The plan step shares the line service's deps factory, so the heavy deps are built once per data load.
  const plans = lineDeps === null ? null : createPlanService({ deps: lineDeps, aiOdds });
  /** The plan steps answered (`PlanAnswers`, keyed by `planStepQuery`). */
  const planAnswers = new PlanAnswers();

  return new Map<string, Record<string, Route>>([
    ['/api/config', { GET: (_req, res) => sendJson(res, 200, { mode: 'local', aiOdds } satisfies ConfigJson) }],
    ['/api/health', { GET: (_req, res) => sendJson(res, 200, healthJson('local', version)) }],
    ['/api/setup', { GET: (req, res) => setup.setup(req, res) }],
    ['/api/setup/extract', { POST: (req, res) => setup.extract(req, res) }],
    ['/api/settings', {
      GET: (_req, res) => sendJson(res, 200, state.settings()),
      PUT: async (req, res) => {
        const parsed = parseSettings(await readJsonBody(req));
        if (!parsed.ok) throw new HttpError(400, parsed.error);
        try {
          await state.updateSettings(parsed.settings);
        } catch (error) {
          if (error instanceof SavePathError) throw new HttpError(400, error.message);
          throw error;
        }
        sendJson(res, 200, state.settings());
      },
    }],
    ['/api/box', { GET: (_req, res) => sendJson(res, 200, requireBox(state).json) }],
    ['/api/draft/options', {
      GET: (_req, res) => {
        const data = requireData(state);
        const body: DraftOptionsJson = { items: draftItems(data.local), growth: data.local.rom.growth };
        sendJson(res, 200, body);
      },
    }],
    ['/api/events', {
      GET: (_req, res) => {
        const stream = openSse(res);
        res.write(': connected\n\n');
        const unsubscribe = state.subscribe((e) => {
          if (!stream.send(e.name, e.data)) unsubscribe();
        });
        stream.onClose(unsubscribe);
      },
    }],
    ['/api/trainers', { GET: (_req, res, url) => sendJson(res, 200, searchTrainers(requireData(state).catalog, url.searchParams.get('search'))) }],
    ['/api/sheet', { POST: async (req, res) => sendJson(res, 200, sheetJson(sheetBody(source, await readJsonBody(req)), deps.buildSheet)) }],
    // The line builder (lines.ts): a hand-driven walk over the engine and the trainer AI. 501 without its deps.
    ['/api/line/start', {
      POST: async (req, res) => {
        if (lines === null) throw new HttpError(501, 'The tree builder is not available');
        sendJson(res, 200, await lines.start(lineStartQuery(state, await readJsonBody(req))));
      },
    }],
    ['/api/line/node', {
      GET: async (_req, res, url) => {
        if (lines === null) throw new HttpError(501, 'The tree builder is not available');
        const data = requireData(state);
        const line = url.searchParams.get('line');
        const node = url.searchParams.get('node');
        if (line === null || line === '' || node === null || node === '') throw new HttpError(400, 'The tree and the step are required');
        sendJson(res, 200, await lines.node(data, line, node));
      },
    }],
    ['/api/line/expand', {
      POST: async (req, res) => {
        if (lines === null) throw new HttpError(501, 'The tree builder is not available');
        const data = requireData(state);
        const body = await readJsonBody(req);
        if (!isRecord(body)) throw new HttpError(400, 'The body must be a JSON object');
        const { line, node, choice } = body;
        if (typeof line !== 'string' || line === '' || typeof node !== 'string' || node === '') throw new HttpError(400, 'The tree and the step are required');
        sendJson(res, 200, await lines.expand(data, line, node, choice === undefined ? undefined : choiceParam(choice)));
      },
    }],
    // The next fight from a won node, the team as that battle left it (`LineService.next`).
    ['/api/line/next', {
      POST: async (req, res) => {
        if (lines === null) throw new HttpError(501, 'The tree builder is not available');
        sendJson(res, 200, await lines.next(lineNextQuery(state, await readJsonBody(req))));
      },
    }],
    // One planned state answered with the line node's pieces (plan.ts). 501 without the line deps. The page asks on every
    // edit, so a step answered before is answered from `planAnswers` (keyed by `planStepQuery`); a request closed while
    // its step is worked out stops it at the step's next yield.
    ['/api/plan/step', {
      POST: async (req, res) => {
        if (plans === null) throw new HttpError(501, 'The tree builder is not available');
        sendJson(res, 200, await answerPlanStep(res, planAnswers, plans, planStepQuery(source, await readJsonBody(req))));
      },
    }],
    // `SheetAiEvent` (`streamOdds`): the body is the sheet's (`sheetBody`), each Pokémon as drafted; its failures (and
    // 501) are JSON before the stream opens. Each pair is cut to the AI odds level; at `off` the route is a 501.
    ['/api/sheet/ai/stream', {
      POST: async (req, res) => {
        if (aiOdds === 'off') throw new HttpError(501, AI_ODDS_OFF);
        if (sheetAi === null) throw new HttpError(501, 'The AI odds are not available');
        await streamOdds(req, res, sheetAi, oddsQuery(sheetBody(source, await readJsonBody(req))), { aiOdds });
      },
    }],
  ]);
}

/** The player's choice in a line request: a move slot or a party index, whole numbers from 0. 400 for anything else (a bag item is the trainer's). */
function choiceParam(raw: unknown): Choice {
  const whole = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
  if (isRecord(raw) && raw.kind === 'move' && whole(raw.slot)) return { kind: 'move', slot: raw.slot as number };
  if (isRecord(raw) && raw.kind === 'switch' && whole(raw.index)) return { kind: 'switch', index: raw.index as number };
  throw new HttpError(400, 'choice must be { kind: "move", slot } or { kind: "switch", index }, with whole numbers from 0');
}

/** What a line start took in an older page and takes no more: a level, HP or status before the fight is set in the draft. */
const GONE_FROM_LINE_START = ['hp', 'levels', 'startStatus'] as const;

/**
 * `POST /api/line/start`'s body as a line to start: the fight (`draftedFight`, the trainer by `trainerId`, an empty team
 * refused) and `world` (default 0). Checked in this order: the body is an object; `hp`, `levels` and `startStatus` are
 * each a 400 saying to reload the page when present, whatever they hold (an older page would otherwise start
 * the fight on other HP than it shows); then the fight's own checks; then the world. The team starts drafted: each
 * Pokémon on the HP, level and status its entry gives, else the save's. 409 without the data or a save, 404 for an
 * unknown trainer, 400 for anything else wrong.
 */
function lineStartQuery(state: ServerState, body: unknown): LineStartQuery {
  if (!isRecord(body)) throw new HttpError(400, 'The body must be a JSON object');
  const gone = GONE_FROM_LINE_START.find((key) => Object.hasOwn(body, key));
  if (gone !== undefined) throw new HttpError(400, `${gone} is no longer part of a tree start: reload the page`);
  const { data, trainer, variant, refs, pool } = draftedFight(localFightSource(state), body, { trainerKey: 'trainerId', emptyTeam: false });
  return { data, mons: pool, trainerId: trainer.id, variant, team: refs, world: worldParam(body.world) };
}

/** What a next-fight request may hold (`LineNextRequestJson`). */
const LINE_NEXT_KEYS: ReadonlySet<string> = new Set(['line', 'node', 'trainerId', 'variant', 'world', 'lead', 'heal']);

/**
 * `POST /api/line/next`'s body (`LineNextRequestJson`) as the next fight from a won node. Checked in this order: the body
 * is an object; the first of its keys, in its own order, that the request lacks is a 400, "<key> is not part of a
 * next-fight request" (a misspelt `heal` would otherwise start the fight unhealed, as the sheet's `sheetBody` refuses
 * one); `line` and `node` are non-empty strings; the data (409); the trainer by `trainerId` (400, 404) and its
 * copy (`variant`, 400), as a line start checks them; `world` (default 0); `lead`, when present, a non-empty string;
 * `heal`, when present, true or false (default false). The box is not read: the team is the won line's. The rest (the
 * line held, the win, a double, a `lead` still standing, the world in range) is the service's (`LineService.next`).
 */
function lineNextQuery(state: ServerState, body: unknown): LineNextQuery {
  if (!isRecord(body)) throw new HttpError(400, 'The body must be a JSON object');
  const stray = Object.keys(body).find((key) => !LINE_NEXT_KEYS.has(key));
  if (stray !== undefined) throw new HttpError(400, `${stray} is not part of a next-fight request`);
  const { line, node, lead, heal } = body;
  if (typeof line !== 'string' || line === '' || typeof node !== 'string' || node === '') throw new HttpError(400, 'The tree and the step are required');
  const data = requireData(state);
  const { trainer, variant } = trainerParam(data, body, 'trainerId');
  const world = worldParam(body.world);
  if (lead !== undefined && (typeof lead !== 'string' || lead === '')) throw new HttpError(400, 'lead must be a MonRef');
  if (heal !== undefined && typeof heal !== 'boolean') throw new HttpError(400, 'heal must be true or false');
  return { data, line, node, trainerId: trainer.id, variant, world, ...(lead === undefined ? {} : { lead }), heal: heal ?? false };
}

/**
 * Creates the state, then serves the app on 127.0.0.1:`port` (0 picks a free port). Rejects with the listen error
 * (EADDRINUSE for a taken port), closing the state. `close` stops the watcher and ends every open connection, event
 * streams included; it resolves once the server has closed.
 */
export async function startServer(deps: ServerDeps & { port: number; version?: string; aiOdds?: AiOddsLevel }): Promise<{ url: string; state: ServerState; close(): Promise<void> }> {
  const state = await createState(deps);
  const server = http.createServer(createApp({ ...deps, state }));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(deps.port, HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    state.close();
    throw error;
  }
  server.on('error', (error) => console.error('The server failed:', error));
  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${HOST}:${port}`,
    state,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        state.close();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
