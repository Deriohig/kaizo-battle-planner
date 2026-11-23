// Hosted mode over HTTP on port 0 with the fixture data: absent local-only routes, per-session boxes, the upload's checks,
// sign-in, the guard and its headers, rate limits, the hosted 500, the request log, and crafted saves the engine cannot take.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCatalog } from '../../../src/battle/catalog.js';
import { buildMoves } from '../../../src/battle/moves.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { AiOddsLevel, BoxJson, PlanFieldJson, PlanStepJson, SheetJson } from '../../../src/contracts/api.js';
import { MAX_SAVE_BYTES } from '../../../src/contracts/hosted.js';
import type { LocalData } from '../../../src/data/load.js';
import { buildNameIndex } from '../../../src/names/nameIndex.js';
import { buildBox } from '../../../src/server/box.js';
import { draftedFight, type FightSource } from '../../../src/server/fight.js';
import { SECURITY_HEADERS } from '../../../src/server/hostedGuard.js';
import { type HostedDeps, type HostedLimits, startHostedServer } from '../../../src/server/hostedRoutes.js';
import { HttpError } from '../../../src/server/http.js';
import type { LineDeps } from '../../../src/server/lines.js';
import { createLog } from '../../../src/server/log.js';
import type { SheetBuilder } from '../../../src/server/sheet.js';
import { AUTH_COOKIE, makeToken } from '../../../src/server/signIn.js';
import { buildSheet } from '../../../src/sheet/sheet.js';
import { docSpecies } from '../../fixtures/loadedData.js';
import { toyResolver } from '../solver/toy/deps.js';
import type { Scenario } from '../solver/toy/scenarios.js';
import { GARDENIA_ID, SERVER_SAVE, saveFile, serverData, starly, TRISTAN_ID } from './fixtures.js';
import { mon, mv, scenario, toyLineDeps } from './lineFixtures.js';

vi.mock('../../../src/server/plan.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/server/plan.js')>();
  return {
    ...original,
    createPlanService: (opts: Parameters<typeof original.createPlanService>[0]) => original.createPlanService({
      ...opts,
      states: { set: (state) => state, faintEnemyActive: () => null, weather: () => 'none', trickRoom: () => false, startStages: () => ({ player: {}, enemy: {} }) },
    }),
  };
});

const tristan = scenario(TRISTAN_ID,
  [mon('Zero', 5, 1, [mv('Strike', [1])]), mon('Hero', 10, 10, [mv('Strike', [5]), mv('Weak', [1])])],
  [mon('Imp', 8, 5, [mv('Scratch', [3]), mv('Poke', [3])])]);

/** The toy deps with the fight's trainer party named, which the plan step needs. */
function partied(s: Scenario): LineDeps {
  const party = (s.registry.trainers[s.trainerId]?.party ?? []).map((m) => ({ name: m.name }) as ResolvedMon);
  return {
    ...toyLineDeps(s),
    resolver: () => {
      const toy = toyResolver(s);
      return { mon: toy.mon, fight: (spec) => { const fight = toy.fight(spec); return { ...fight, trainer: { ...fight.trainer, party } }; } };
    },
  };
}

const LIMITS: HostedLimits = {
  password: null, trustProxy: 0, allowOrigins: [], maxSessions: 200, sessionsPerIp: 8, sessionIdleMs: 120 * 60_000,
  sessionMemoryBytes: 256 * 1024 * 1024, heavyConcurrency: 2, heavyQueue: 32, version: 'test-1',
};

interface Hosted { url: string; host: string; out: string[]; err: string[] }
const running: { close(): Promise<void>; dir: string }[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) {
    await server.close();
    fs.rmSync(server.dir, { recursive: true, force: true });
  }
});

/** A hosted server on 127.0.0.1:0 over the fixture data (or `data`), a built page with a hashed asset and icons, and one sprite. */
async function hosted(opts: {
  data?: LocalData; limits?: Partial<HostedLimits>; buildSheet?: SheetBuilder; now?: () => number; sheetAi?: HostedDeps['sheetAi']; aiOdds?: AiOddsLevel;
} = {}): Promise<Hosted> {
  const { data: local = serverData(), limits, buildSheet: build = buildSheet, ...deps } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-test-'));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  for (const [file, content] of Object.entries({
    'web/index.html': '<!doctype html><title>planner</title>', 'web/assets/app-1a2b3c.js': 'console.log(1)',
    'web/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'web/apple-touch-icon.png': png, 'data/sprites/icon/1.png': png,
  })) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  const out: string[] = [];
  const err: string[] = [];
  const server = await startHostedServer({
    data: { local, catalog: buildCatalog(local), moves: buildMoves(local) }, dataDir: path.join(dir, 'data'), staticDir: path.join(dir, 'web'),
    buildSheet: build, lines: partied(tristan), limits: { ...LIMITS, ...limits }, host: '127.0.0.1', port: 0, ...deps,
    log: createLog({ requests: true, out: (line) => out.push(line), err: (line) => err.push(line) }),
  });
  running.push({ close: server.close, dir });
  return { url: server.url, host: new URL(server.url).host, out, err };
}

interface Answer { status: number; headers: Headers; text: string; json: () => any }
/** A header set to undefined is left out. */
type CallOpts = { session?: string; headers?: Record<string, string | undefined>; body?: string | Uint8Array };

async function call(h: Hosted, method: string, route: string, opts: CallOpts = {}): Promise<Answer> {
  const headers = Object.entries({ 'x-pkp-session': opts.session, ...opts.headers }).filter((e): e is [string, string] => e[1] !== undefined);
  const res = await fetch(`${h.url}${route}`, { method, headers, body: opts.body as BodyInit | undefined });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
}

const JSON_TYPE = { 'Content-Type': 'application/json' };
const json = (h: Hosted, method: string, route: string, session: string | undefined, body: unknown, headers: Record<string, string> = {}) =>
  call(h, method, route, { session, headers: { ...JSON_TYPE, ...headers }, body: JSON.stringify(body) });
const basic = (password: string, user = 'x') => ({ Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` });

/** The request lines logged so far, parsed, once the last answer's line is in. */
async function logged(h: Hosted): Promise<any[]> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return h.out.map((l) => JSON.parse(l));
}

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const MODIFIED = Date.UTC(2026, 10, 20, 12, 0, 0);
const SAVE_HEADERS = {
  'Content-Type': 'application/octet-stream', 'x-pkp-save-name': encodeURIComponent('Platinum Kaizo.dsv'), 'x-pkp-save-modified': String(MODIFIED),
};
const upload = (h: Hosted, session: string, file: Uint8Array, headers: Record<string, string | undefined> = {}) =>
  call(h, 'PUT', '/api/save', { session, body: file, headers: { ...SAVE_HEADERS, ...headers } });

const FIELD: PlanFieldJson = {
  weather: 'none', trickRoom: false, rocks: { player: false, enemy: false },
  screens: { player: { reflect: false, lightScreen: false }, enemy: { reflect: false, lightScreen: false } },
  stages: { player: {}, enemy: {} }, enemyStatus: 'none',
};
const STEP = { trainerId: TRISTAN_ID, team: ['party:1'], draft: [], state: { player: { active: 'party:1', fainted: [] }, enemy: { active: 0, fainted: [] }, field: FIELD } };
const SHEET = { trainer: TRISTAN_ID, team: ['party:1', 'party:2'], draft: [] };
const NO_SAVE = { error: 'Load your save again', code: 'NO_SAVE' };
const BAD_FILE = new Uint8Array(1000).map((_, i) => (i * 37) & 0xff);
const WIPED = new Uint8Array(524_288).fill(0xff);
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.59 Safari/537.36';
const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const CHROME = 'Chrome 142 · Windows · desktop';

/** The routes local mode has and hosted mode does not register. */
const GONE = ['/api/setup', '/api/setup/extract', '/api/settings', '/api/events', '/api/line/start', '/api/line/node', '/api/line/expand', '/api/line/next'];

describe('hosted routes that do not exist', () => {
  it('answers every local-only route as /api/nope, byte for byte apart from the path, whatever the method, headers or body', async () => {
    const h = await hosted();
    const bodies = [undefined, JSON.stringify({ savePath: '/etc/passwd', romPath: 'C:\\Windows\\system32' }), JSON.stringify({ rom: '../../etc/shadow' })];
    const shape = (a: Answer) => [...a.headers.entries()].filter(([name]) => !['date', 'content-length'].includes(name));
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const body of method === 'GET' ? [undefined] : bodies) {
        const nope = await call(h, method, '/api/nope', { session: A, headers: JSON_TYPE, body });
        expect(nope.status).toBe(404);
        for (const route of GONE) {
          const res = await call(h, method, route, { session: A, headers: JSON_TYPE, body });
          expect([method, route, res.status, res.text.replace(route, '/api/nope'), shape(res)]).toEqual([method, route, 404, nope.text, shape(nope)]);
        }
      }
    }
    expect((await call(h, 'GET', '/api/nope')).json()).toEqual({ error: 'No API route /api/nope' });
  });
});

describe('config, health and the AI odds level', () => {
  it('config and health say hosted; a plan step sends only what the level allows; at off the sheet AI stream is a 501 as JSON', async () => {
    const at = async (aiOdds: AiOddsLevel) => {
      const h = await hosted({ aiOdds });
      const config = (await call(h, 'GET', '/api/config')).json();
      expect((await upload(h, A, saveFile())).status).toBe(200);
      const res = await json(h, 'POST', '/api/plan/step', A, STEP);
      expect(res.status).toBe(200);
      return { h, config, step: res.json() as PlanStepJson };
    };
    const full = await at('full');
    expect(full.config).toEqual({
      mode: 'hosted', version: 'test-1', maxSaveBytes: MAX_SAVE_BYTES, pollMs: 2000, passwordRequired: false, signedIn: true, aiOdds: 'full',
    });
    const health = (await call(full.h, 'GET', '/api/health')).json();
    expect([health, Number.isInteger(health.uptimeSeconds)]).toEqual([expect.objectContaining({ ok: true, mode: 'hosted', version: 'test-1' }), true]);
    // With no password, any login is a 204.
    expect((await json(full.h, 'POST', '/api/login', undefined, { password: 'anything' })).status).toBe(204);
    expect(full.step).toMatchObject({ phase: 'turnChoice', world: 0, field: FIELD });
    expect(full.step.aiOdds?.choices[0]).toEqual({ label: 'move 1', probability: { num: '1', den: '2' }, percent: 50 });
    for (const level of ['likeliest', 'ranked'] as const) {
      const { config, step } = await at(level);
      expect([config.aiOdds, step.aiOdds]).toEqual([level, { kind: 'turn', choices: [{ label: 'move 1', rank: 1 }, { label: 'move 2', rank: 1 }] }]);
    }
    const off = await at('off');
    expect([off.config.aiOdds, 'aiOdds' in off.step, off.step.view.enemy.active?.name]).toEqual(['off', false, 'Imp']);
    const stream = await json(off.h, 'POST', '/api/sheet/ai/stream', A, SHEET);
    expect([stream.status, stream.headers.get('content-type'), stream.json()])
      .toEqual([501, 'application/json; charset=utf-8', { error: 'The AI odds are off on this server' }]);
  });
});

describe('the session', () => {
  it('needs a well-formed header, answers NO_SAVE for an id holding nothing, gives each player only their own box, checks the Origin', async () => {
    const h = await hosted();
    for (const session of [undefined, 'A'.repeat(32), 'a'.repeat(31), 'g'.repeat(32)]) {
      const box = await call(h, 'GET', '/api/box', { session });
      expect([session, box.status, box.json()]).toEqual([session, 400, { error: 'The session header is missing', code: 'SESSION_REQUIRED' }]);
    }
    expect((await call(h, 'GET', '/api/box', { session: A })).json()).toEqual(NO_SAVE);
    for (const route of ['/api/sheet', '/api/sheet/ai/stream', '/api/plan/step']) {
      const res = await json(h, 'POST', route, A, route === '/api/plan/step' ? STEP : SHEET);
      expect([route, res.status, res.json(), res.headers.get('content-type')]).toEqual([route, 409, NO_SAVE, 'application/json; charset=utf-8']);
    }

    const a = await upload(h, A, saveFile());
    const dawn = saveFile({ ...SERVER_SAVE, trainerName: 'Dawn', party: [starly({ nickname: 'Birdy' })], boxes: [] });
    const b = await upload(h, B, dawn, { 'x-pkp-save-name': 'dawn.sav' });
    const boxA = (await call(h, 'GET', '/api/box', { session: A })).json() as BoxJson;
    const boxB = (await call(h, 'GET', '/api/box', { session: B })).json() as BoxJson;
    expect([a.status, b.status, boxA, boxB, boxA.savePath, boxB.savePath]).toEqual([200, 200, a.json(), b.json(), 'Platinum Kaizo.dsv', 'dawn.sav']);
    expect([boxA.mons.map((m) => m.nickname).includes('Ghost'), boxB.mons.map((m) => m.nickname), JSON.stringify(boxB).includes('Ghost')])
      .toEqual([true, ['Birdy'], false]);
    expect(((await json(h, 'POST', '/api/sheet', A, SHEET)).json() as SheetJson).savePath).toBe('Platinum Kaizo.dsv');
    const sheetB = await json(h, 'POST', '/api/sheet', B, SHEET);
    expect([sheetB.status, sheetB.json().error]).toEqual([400, 'team: there is no Pokémon at party:2']);
    const ownB = (await json(h, 'POST', '/api/sheet', B, { ...SHEET, team: ['party:1'] })).json() as SheetJson;
    expect([ownB.savePath, ownB.players.map((p) => p.nickname)]).toEqual(['dawn.sav', ['Birdy']]);

    // A sheet for more than six Pokémon, or a JSON body over 256 KiB, is refused before any work.
    const team = ['party:1', 'party:2', 'party:3', 'party:4', 'party:5', 'party:6', 'box:1:1'];
    const seven = await json(h, 'POST', '/api/sheet', A, { ...SHEET, team });
    const big = await json(h, 'POST', '/api/sheet', A, { trainer: 'x'.repeat(300 * 1024) });
    expect([seven.status, seven.json(), big.status, big.json()])
      .toEqual([400, { error: 'team must hold at most 6 Pokémon' }, 413, { error: 'The request body is over 256 KiB', code: 'TOO_LARGE' }]);
    // A foreign Origin is a 403; the page's own gets through.
    for (const [origin, status] of [['https://evil.example', 403], ['null', 403], [`http://${h.host}`, 200]] as const) {
      expect([origin, (await json(h, 'POST', '/api/sheet', A, SHEET, { Origin: origin })).status]).toEqual([origin, status]);
    }
    expect((await upload(h, A, saveFile(), { Origin: 'https://evil.example' })).status).toBe(403);

    expect((await call(h, 'DELETE', '/api/save', { session: A })).status).toBe(204);
    expect((await call(h, 'GET', '/api/box', { session: A })).status).toBe(409);
    expect((await call(h, 'GET', '/api/box', { session: B })).json()).toEqual(boxB);
    expect((await call(h, 'DELETE', '/api/save', { session: A })).status).toBe(204);
  });
});

describe('PUT /api/save', () => {
  type Upload = { why: string; file?: Uint8Array; session?: string; headers?: Record<string, string | undefined>; status: number; answer?: object };
  it.each<Upload>([
    {
      why: 'a save with the graveyard and cap headers', headers: { 'x-pkp-graveyard-box': '17', 'x-pkp-level-cap': '9' }, status: 200,
      answer: { savePath: 'Platinum Kaizo.dsv', savedAt: new Date(MODIFIED).toISOString(), graveyardBoxes: [17, 18], levelCap: 9 },
    },
    { why: 'a name with a path and a control character', status: 200, answer: { savePath: 'game.dsv' },
      headers: { 'x-pkp-save-name': encodeURIComponent('C:\\Users\\player\\..\\game\u0007.dsv') } },
    { why: 'a file that is not a save', file: BAD_FILE, status: 422, answer: { code: 'BAD_SAVE' } },
    { why: 'a wiped save', file: WIPED, status: 422, answer: { code: 'BAD_SAVE', error: expect.stringContaining('The save is empty') } },
    { why: 'a file over the cap', file: new Uint8Array(MAX_SAVE_BYTES + 1), status: 413,
      answer: { error: `A save is at most ${MAX_SAVE_BYTES} bytes; this file is larger`, code: 'TOO_LARGE' } },
    { why: 'a JSON Content-Type', headers: { 'Content-Type': 'application/json' }, status: 415 },
    { why: 'a malformed session', session: 'nope', status: 400, answer: { code: 'SESSION_REQUIRED' } },
    { why: 'no name', headers: { 'x-pkp-save-name': undefined }, status: 400, answer: { error: 'x-pkp-save-name is required: the file\'s name' } },
    { why: 'a modified time before 2004', headers: { 'x-pkp-save-modified': '999' }, status: 400 },
    { why: 'box 19', headers: { 'x-pkp-graveyard-box': '19' }, status: 400, answer: { error: 'x-pkp-graveyard-box must be a whole number from 1 to 18' } },
    { why: 'cap 0', headers: { 'x-pkp-level-cap': '0' }, status: 400, answer: { error: 'x-pkp-level-cap must be a whole number from 1 to 100' } },
  ])('answers $why with $status; a refused upload keeps the last good box', async ({ file, session, headers, status, answer }) => {
    const h = await hosted();
    const good = (await upload(h, A, saveFile())).json();
    const res = await upload(h, session ?? A, file ?? saveFile(), headers);
    expect(res.status).toBe(status);
    if (answer) expect(res.json()).toMatchObject(answer);
    if (status !== 200) expect((await call(h, 'GET', '/api/box', { session: A })).json()).toEqual(good);
  });

  it('is 413 for a body streamed past the cap without a Content-Length', async () => {
    const h = await hosted();
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const headers = { 'Content-Type': 'application/octet-stream', 'x-pkp-session': A, 'Transfer-Encoding': 'chunked' };
      const req = http.request(`${h.url}/api/save`, { method: 'PUT', headers }, resolve).on('error', reject);
      const chunk = Buffer.alloc(64 * 1024);
      let sent = 0;
      const pump = (): void => {
        while (sent < 4 * MAX_SAVE_BYTES) {
          sent += chunk.length;
          if (!req.write(chunk)) return void req.once('drain', pump);
        }
        req.end();
      };
      pump();
    });
    let text = '';
    for await (const part of res) text += part;
    expect([res.statusCode, JSON.parse(text).code]).toEqual([413, 'TOO_LARGE']);
  });
});

describe('sign-in, with the password on', () => {
  const PW = { limits: { password: 'hunter2' } };
  const login = (h: Hosted, body: unknown, headers: Record<string, string> = {}) => json(h, 'POST', '/api/login', undefined, body, headers);
  /** The `pkp_auth=<token>` pair of a login's `Set-Cookie`. */
  const cookieOf = (res: Answer) => (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  const sheet = JSON.stringify(SHEET);
  /** Every protected route, as a request that would otherwise be well formed. */
  const PROTECTED: [string, string, CallOpts][] = [
    ['GET', '/api/box', { session: A }], ['GET', '/api/trainers', {}], ['GET', '/api/draft/options', {}], ['GET', '/api/sprites/icon/1.png', {}],
    ['PUT', '/api/save', { session: A, headers: SAVE_HEADERS, body: saveFile() }], ['DELETE', '/api/save', { session: A }],
    ['POST', '/api/plan/step', { session: A, headers: JSON_TYPE, body: '{}' }], ['POST', '/api/sheet', { session: A, headers: JSON_TYPE, body: sheet }],
    ['POST', '/api/sheet/ai/stream', { session: A, headers: JSON_TYPE, body: sheet }], ['GET', '/api/nope', {}], ['GET', '/api/setup', {}],
  ];

  it('signed out: protected routes are 401 SIGN_IN with no WWW-Authenticate (no popup); the page, icons, health and config answer', async () => {
    const h = await hosted(PW);
    for (const [method, route, opts] of PROTECTED) {
      const res = await call(h, method, route, opts);
      expect([method, route, res.status, res.json(), res.headers.get('www-authenticate')])
        .toEqual([method, route, 401, { error: 'Sign in first', code: 'SIGN_IN' }, null]);
    }
    for (const route of ['/', '/plan/somewhere', '/assets/app-1a2b3c.js', '/favicon.svg', '/apple-touch-icon.png', '/api/health', '/api/config']) {
      expect([route, (await call(h, 'GET', route)).status]).toEqual([route, 200]);
    }
    expect((await call(h, 'GET', '/api/config')).json()).toMatchObject({ mode: 'hosted', passwordRequired: true, signedIn: false });
    // POST /api/login takes JSON only, checks the body, and keeps the Origin check.
    for (const [method, headers, body, status] of [
      ['GET', {}, undefined, 405], ['POST', { 'Content-Type': 'text/plain' }, { password: 'hunter2' }, 415], ['POST', JSON_TYPE, { name: 'Sam' }, 400],
      ['POST', JSON_TYPE, { password: 'hunter2', name: 5 }, 400], ['POST', JSON_TYPE, { password: 'hunter2', admin: true }, 400],
      ['POST', { ...JSON_TYPE, Origin: 'https://evil.example' }, { password: 'hunter2' }, 403],
    ] as const) {
      const res = await call(h, method, '/api/login', { headers, body: body && JSON.stringify(body) });
      expect([method, body, res.status]).toEqual([method, body, status]);
    }
    // Signed in, the local-only routes are the same 404 as on a public site.
    for (const route of GONE) {
      const res = await call(h, 'GET', route, { headers: basic('hunter2', 'anyone') });
      expect([route, res.status, res.json()]).toEqual([route, 404, { error: `No API route ${route}` }]);
    }
  });

  it('the right password: 204 and an HttpOnly, SameSite=Strict 30-day cookie that opens the API; the log names the user', async () => {
    const h = await hosted(PW);
    const res = await login(h, { password: 'hunter2', name: '  Sam\u0007 ' });
    const set = res.headers.get('set-cookie')!;
    expect([res.status, set]).toEqual([204, expect.stringMatching(new RegExp(`^${AUTH_COOKIE}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+; `))]);
    for (const part of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) expect(set).toContain(part);
    expect(set).not.toMatch(/Secure|hunter2/);
    const cookie = { Cookie: cookieOf(res) };
    expect((await call(h, 'GET', '/api/trainers', { headers: cookie })).status).toBe(200);
    expect((await call(h, 'GET', '/api/sprites/icon/1.png', { headers: cookie })).status).toBe(200);
    expect((await call(h, 'GET', '/api/config', { headers: cookie })).json()).toMatchObject({ passwordRequired: true, signedIn: true });
    // The log's user: the cookie's name, else the Basic user; never the token or the password.
    await call(h, 'GET', '/api/trainers', { headers: basic('hunter2', 'smoke') });
    await call(h, 'GET', '/api/trainers');
    expect((await logged(h)).filter((l) => ['/api/login', '/api/trainers'].includes(l.p)).map((l) => [l.p, l.s, l.user])).toEqual([
      ['/api/login', 204, 'Sam'], ['/api/trainers', 200, 'Sam'], ['/api/trainers', 200, 'smoke'], ['/api/trainers', 401, null],
    ]);
    for (const secret of ['hunter2', cookie.Cookie.split('=')[1]!]) expect(h.out.join('\n')).not.toContain(secret);
    // Secure only for HTTPS through a trusted proxy.
    const proxied = await hosted({ limits: { password: 'hunter2', trustProxy: 1 } });
    const https = { 'X-Forwarded-For': '198.51.100.4', 'X-Forwarded-Proto': 'https' };
    expect((await login(proxied, { password: 'hunter2' }, https)).headers.get('set-cookie')).toContain('; Secure');
    expect((await login(h, { password: 'hunter2' }, { 'X-Forwarded-Proto': 'https' })).headers.get('set-cookie')).not.toContain('Secure');
  });

  it('counts wrong logins and Basic tries (401, no popup) together: the 11th is 429 even when right; a cookie and health still pass', async () => {
    const h = await hosted(PW);
    const signed = { Cookie: cookieOf(await login(h, { password: 'hunter2' })) };
    for (let i = 0; i < 10; i++) {
      const wrong = i % 2 === 0 ? await login(h, { password: 'guess' }) : await call(h, 'GET', '/api/trainers', { headers: basic('guess') });
      expect([i, wrong.status, wrong.json(), wrong.headers.get('www-authenticate')]).toEqual([i, 401, { error: 'Wrong password', code: 'SIGN_IN' }, null]);
    }
    for (const locked of [await login(h, { password: 'hunter2' }), await call(h, 'GET', '/api/trainers', { headers: basic('hunter2') })]) {
      expect([locked.status, locked.json().code, Number(locked.headers.get('retry-after')) > 0]).toEqual([429, 'RATE_LIMITED', true]);
    }
    expect((await call(h, 'GET', '/api/trainers', { headers: signed })).status).toBe(200);
    expect((await call(h, 'GET', '/api/health')).status).toBe(200);
  });

  it('refuses a forged or edited cookie, or one made under another password; POST /api/logout clears it', async () => {
    const h = await hosted(PW);
    const pair = cookieOf(await login(h, { password: 'hunter2', name: 'Sam' }));
    const [payload, mac] = pair.split('=')[1]!.split('.') as [string, string];
    const edited = Buffer.from(JSON.stringify({ n: 'Admin', iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const flipped = `${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
    for (const bad of [`${edited}.${mac}`, `${payload}.${flipped}`, 'garbage', makeToken('other-password', 'Sam', Date.now())]) {
      expect([bad, (await call(h, 'GET', '/api/trainers', { headers: { Cookie: `${AUTH_COOKIE}=${bad}` } })).status]).toEqual([bad, 401]);
    }
    expect((await call(await hosted({ limits: { password: 'new-password' } }), 'GET', '/api/trainers', { headers: { Cookie: pair } })).status).toBe(401);
    const out = await call(h, 'POST', '/api/logout');
    expect([out.status, out.headers.get('set-cookie')]).toEqual([204, expect.stringMatching(new RegExp(`^${AUTH_COOKIE}=; `))]);
    for (const part of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0']) expect(out.headers.get('set-cookie')).toContain(part);
  });
});

describe('the guard', () => {
  it('puts the security headers, never a CORS header, on every answer; caches assets a year, the page never, privately behind a password', async () => {
    const open = await hosted();
    const locked = await hosted({ limits: { password: 'pw' } });
    const auth = { headers: basic('pw') };
    // [server, method, route, options, Cache-Control (left out: not checked)].
    const cases: [Hosted, string, string, CallOpts, string?][] = [
      [locked, 'GET', '/', auth], [locked, 'GET', '/api/health', {}], [locked, 'GET', '/api/config', {}], [locked, 'GET', '/api/nope', auth],
      [locked, 'GET', '/api/box', auth], [locked, 'OPTIONS', '/api/sheet', { headers: { ...auth.headers, Origin: 'https://evil.example' } }],
      [locked, 'GET', '/assets/app-1a2b3c.js', auth, 'private, max-age=31536000, immutable'],
      [locked, 'GET', '/api/sprites/icon/1.png', auth, 'private, max-age=604800'],
      [open, 'GET', '/assets/app-1a2b3c.js', {}, 'public, max-age=31536000, immutable'], [open, 'GET', '/', {}, 'no-cache'],
      [open, 'GET', '/api/sprites/icon/1.png', {}, 'public, max-age=604800'],
    ];
    for (const [h, method, route, opts, cache] of cases) {
      const res = await call(h, method, route, opts);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect([route, name, res.headers.get(name)]).toEqual([route, name, value]);
      expect([...res.headers.keys()].filter((name) => name.startsWith('access-control-'))).toEqual([]);
      if (cache) expect([route, res.headers.get('cache-control')]).toEqual([route, cache]);
    }
    expect((await call(open, 'GET', '/some/route')).text).toContain('<title>planner</title>');
  });

  it('limits the light API to 240 requests a minute per IP, with Retry-After', async () => {
    const h = await hosted({ now: () => MODIFIED });
    for (let i = 0; i < 240; i++) expect((await call(h, 'GET', '/api/config')).status).toBe(200);
    const res = await call(h, 'GET', '/api/config');
    expect([res.status, res.json().code, Number(res.headers.get('retry-after')) >= 1]).toEqual([429, 'RATE_LIMITED', true]);
    expect((await call(h, 'GET', '/api/health')).status).toBe(200);
  });
});

describe('failures and the request log', () => {
  it('answers a 500 with a ref only, and logs the class and stack under it without the message', async () => {
    const h = await hosted({ buildSheet: () => { throw new TypeError('secret Lucas detail'); } });
    await upload(h, A, saveFile());
    const res = await json(h, 'POST', '/api/sheet', A, SHEET);
    const error = expect.stringMatching(/^Something went wrong on the server \(ref [0-9a-f]{8}\)$/);
    expect([res.status, res.json()]).toEqual([500, { error, code: 'INTERNAL' }]);
    const line = h.err.map((l) => JSON.parse(l)).find((l) => l.ref === /ref ([0-9a-f]{8})/.exec(res.json().error)![1]);
    expect(line).toMatchObject({ level: 'error', class: 'TypeError', what: 'POST /api/sheet', frames: expect.arrayContaining([expect.anything()]) });
    expect(h.err.join('\n')).not.toContain('secret');
  });

  it('logs one line per API request at the path it routed, only the allowed fields: never the session, names, notes, the full UA or the save', async () => {
    const h = await hosted();
    const browser = { 'User-Agent': CHROME_UA, 'Accept-Language': 'en-IE,en;q=0.9' };
    await upload(h, A, saveFile(), { ...browser, 'x-pkp-save-name': encodeURIComponent('Lucas run 3.dsv'), 'x-pkp-save-source': 'drop' });
    await json(h, 'POST', '/api/sheet', A, { ...SHEET, notes: 'Ghost dies to a Rock Smash crit' }, browser);
    await json(h, 'POST', '/api/plan/step', A, STEP, browser);
    // A raw target, sent as written (fetch would resolve the `..`).
    expect(await new Promise<number>((resolve, reject) => {
      http.request({ host: '127.0.0.1', port: Number(new URL(h.url).port), path: '/x/../api/box', headers: { 'x-pkp-session': A } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }).on('error', reject).end();
    })).toBe(200);
    for (const route of ['/api/trainers?search=lucas', '/', '/api/sprites/icon/2.png', '/api/health']) await call(h, 'GET', route);
    const lines = await logged(h);
    expect(lines.map((l) => [l.m, l.p, l.s])).toEqual([
      ['PUT', '/api/save', 200], ['POST', '/api/sheet', 400], ['POST', '/api/plan/step', 200], ['GET', '/api/box', 200], ['GET', '/api/trainers', 200],
      ['GET', '/api/sprites/icon/2.png', 404],
    ]);
    const KEYS = ['code', 'fight', 'fmt', 'in', 'ip', 'lang', 'm', 'ms', 'p', 'run', 's', 'sess', 'src', 't', 'turns', 'ua', 'user'];
    for (const line of lines) expect([Object.keys(line).sort(), line.ip]).toEqual([KEYS, '127.0.0.0/24']);
    expect(lines[0]).toMatchObject({ sess: expect.stringMatching(/^[0-9a-f]{6}$/), in: saveFile().length, code: null, ua: CHROME, lang: 'en-IE' });
    expect([lines[0].src, lines[0].fmt, lines[1].fight]).toEqual(['drop', 'DeSmuME .dsv', TRISTAN_ID]);
    const all = h.out.join('\n') + h.err.join('\n');
    const secrets = [A, 'Lucas', 'lucas', 'run 3', 'Ghost', 'Starly', 'Monferno', 'Rock Smash', 'crit', 'notes', 'Mozilla', 'AppleWebKit', 'KHTML'];
    expect([...secrets, 'Win64', '7444', 'q=0.9', 'en;'].filter((secret) => all.includes(secret))).toEqual([]);
  });

  it('logs the device, language, source and format, and the run of an upload; a refused one has no run; a bad source is null, not echoed', async () => {
    const h = await hosted();
    const browser = { 'User-Agent': CHROME_UA, 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' };
    const uploads: [Uint8Array, Record<string, string>][] = [
      [saveFile(), { ...browser, 'x-pkp-save-source': 'upload' }],
      [saveFile({ ...SERVER_SAVE, dsvFooter: false }), { ...browser, 'x-pkp-save-source': 'connected', 'x-pkp-level-cap': '30' }],
      [BAD_FILE, { 'x-pkp-save-source': 'drop' }], [WIPED, { 'x-pkp-save-source': 'Platinum<b>' }],
      [new Uint8Array(MAX_SAVE_BYTES + 1), { 'x-pkp-save-source': 'settings' }], [saveFile(), { 'x-pkp-save-source': 'UPLOAD' }],
      [saveFile(), { 'x-pkp-save-source': 'resend' }], [saveFile(), {}],
    ];
    for (const [file, headers] of uploads) await upload(h, A, file, headers);
    await call(h, 'GET', '/api/box', { session: A, headers: { 'User-Agent': SAFARI_UA, 'x-pkp-save-source': 'upload' } });
    const run = (cap: number) => ({ badges: 1, split: 'Gardenia Split', cap });
    // fetch sends `Accept-Language: *`, which is no language.
    expect((await logged(h)).map((l) => [l.s, l.ua, l.lang, l.src, l.fmt, l.run, l.fight, l.turns])).toEqual([
      [200, CHROME, 'es-ES', 'upload', 'DeSmuME .dsv', run(28), null, null], [200, CHROME, 'es-ES', 'connected', 'raw .sav', run(30), null, null],
      [422, 'script', null, 'drop', 'other', null, null, null], [422, 'script', null, null, 'raw .sav', null, null, null],
      [413, 'script', null, 'settings', null, null, null, null], [200, 'script', null, null, 'DeSmuME .dsv', run(28), null, null],
      [200, 'script', null, 'resend', 'DeSmuME .dsv', run(28), null, null], [200, 'script', null, null, 'DeSmuME .dsv', run(28), null, null],
      [200, 'Safari 18 · iPhone · phone', null, null, null, null, null, null],
    ]);
    expect(h.out.join('\n')).not.toMatch(/<b>|Platinum|UPLOAD/);
  });

  it('logs the trainer asked for on a plan step, a sheet and an AI stream only when the catalog has it, and the code of a refusal', async () => {
    const h = await hosted({ sheetAi: () => { throw new Error('no AI data'); } });
    await upload(h, A, saveFile());
    for (const [route, session, body] of [
      ['/api/plan/step', A, STEP], ['/api/sheet', A, SHEET], ['/api/sheet/ai/stream', A, SHEET],
      ['/api/sheet', A, { ...SHEET, trainer: GARDENIA_ID, team: ['party:9'] }], ['/api/plan/step', A, { ...STEP, trainerId: 'roark-split/lucas/1' }],
      ['/api/sheet', A, { ...SHEET, trainer: { id: TRISTAN_ID } }], ['/api/sheet', B, SHEET],
    ] as const) await json(h, 'POST', route, session, body);
    const lines = (await logged(h)).slice(1);
    expect(lines.map((l) => [l.p, l.s, l.fight, l.turns, l.src, l.fmt, l.run])).toEqual([
      ['/api/plan/step', 200, TRISTAN_ID], ['/api/sheet', 200, TRISTAN_ID], ['/api/sheet/ai/stream', 200, TRISTAN_ID],
      // Refused after the trainer was read: still the fight asked for.
      ['/api/sheet', 400, GARDENIA_ID],
      // No such trainer, a trainer that is not a string, and a session holding no save (its body is never read): none.
      ['/api/plan/step', 404, null], ['/api/sheet', 400, null], ['/api/sheet', 409, null],
    ].map((row) => [...row, null, null, null, null]));
    expect([lines.at(-1).code, h.out.join('\n').includes('lucas')]).toEqual(['NO_SAVE', false]);
  });
});

describe('crafted saves the fight engine cannot take', () => {
  /** The fixture data with a Personal row 494 (in the real ROM, a form row: Rotom's Heat form), named by the docs. */
  function withRow494(): LocalData {
    const data = serverData();
    data.rom.species[494] = { ...structuredClone(data.rom.species[396]!), id: 494 };
    const docs = { ...data.docs, species: [...data.docs.species, docSpecies(479, 'ROTOM'), docSpecies(494, 'ROTOM (HEAT)')] };
    return { ...data, docs, names: buildNameIndex(docs) };
  }
  const SETTINGS = { romPath: null, savePath: 'crafted.dsv', graveyardBox: null, levelCapOverride: null };
  const boxOf = (file: Uint8Array, data: LocalData) => buildBox({ file, savePath: 'crafted.dsv', savedAt: new Date(0), data, settings: SETTINGS });
  const oneMon = (m: ReturnType<typeof starly>) => saveFile({ party: [m], boxes: [] });

  it.each([
    ['a species past 493', withRow494, oneMon(starly({ species: 494 })), 'unknown species 494'],
    ['a Pokémon with no moves', serverData, oneMon(starly({ moves: [], pp: [], ppUps: [] })), 'no moves'],
  ] as const)('the box lists %s as unable to fight, never in a team; a hosted sheet for it is a 400 saying why', async (_, data, file, why) => {
    const box = boxOf(file, data());
    expect(box.json.mons).toEqual([expect.objectContaining({ ref: 'party:1', draft: null, ineligibleReasons: expect.arrayContaining([why]) })]);
    expect([[...box.pool.keys()], box.team]).toEqual([[], []]);
    const h = await hosted({ data: data() });
    expect((await upload(h, A, file)).status).toBe(200);
    const res = await json(h, 'POST', '/api/sheet', A, { ...SHEET, team: ['party:1'] });
    expect([res.status, res.json()]).toEqual([400, { error: `team: party:1 cannot fight (${why})` }]);
  });

  it('a fight over a pool holding such a Pokémon is a 400 naming it, never a throw from the engine; a normal one fights', () => {
    expect([...boxOf(oneMon(starly()), withRow494()).pool.keys()]).toEqual(['party:1']);
    const local = serverData();
    const data = { local, catalog: buildCatalog(local), moves: buildMoves(local) };
    const box = boxOf(oneMon(starly()), local);
    const base = box.pool.get('party:1')!;
    const fight = (m: PlayerMon) => {
      const source: FightSource = { data: () => data, box: () => ({ ...box, pool: new Map([['party:1', m]]) }) };
      return draftedFight(source, { trainer: TRISTAN_ID, team: ['party:1'], draft: [] }, { trainerKey: 'trainer', emptyTeam: true });
    };
    const cases: [PlayerMon, string][] = [[{ ...base, species: 494 }, 'unknown species 494'], [{ ...base, moves: [] }, 'no moves']];
    for (const [m, why] of cases) {
      expect(() => fight(m)).toThrow(HttpError);
      expect(() => fight(m)).toThrow(expect.objectContaining({ status: 400, message: `team: party:1 cannot fight (${why})` }));
    }
    expect(fight(base).team).toHaveLength(1);
  });
});
