import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildMoves } from '../../../src/battle/moves.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { EnemyModel } from '../../../src/contracts/ai.js';
import type { DraftOptionsJson } from '../../../src/contracts/api.js';
import { MissingDataError } from '../../../src/data/load.js';
import { DocsError } from '../../../src/docs/fetchDocs.js';
import { installKaizoDex } from '../../../src/engine/index.js';
import type { AiOddsLevel, BoxJson, SettingsJson, SheetAiPairJson, SheetJson, TrainerSummaryJson } from '../../../src/server/apiTypes.js';
import { startServer } from '../../../src/server/app.js';
import type { BoxState } from '../../../src/server/box.js';
import { draftItems } from '../../../src/server/draft.js';
import { DEFAULT_SETTINGS } from '../../../src/server/settings.js';
import { sheetToJson } from '../../../src/server/sheet.js';
import { SHOWDOWN_SHEET_ENGINE } from '../../../src/server/sheetAi.js';
import { buildSheet } from '../../../src/sheet/sheet.js';
import { readSse, type SseEvent } from '../../../web/src/sse.js';
import { fixtureAi, NOTHING, withAiRecords } from './aiFixture.js';
import { GARDENIA_ID, monferno, SERVER_SAVE, saveFile, serverData, starly, TRISTAN_ID, TWINS_ID } from './fixtures.js';
import { closeServers, type Harness, removeLater, start } from './harness.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await closeServers();
});

type Answer<T> = { status: number; body: T };

/** A JSON request: `body` goes out as JSON, or as written when it is a string. */
async function req<T>(h: Harness, route: string, method = 'GET', body?: unknown): Promise<Answer<T>> {
  const res = await fetch(`${h.url}${route}`, method === 'GET' ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}
const get = <T>(h: Harness, route: string) => req<T>(h, route);
const post = <T>(h: Harness, route: string, body: unknown) => req<T>(h, route, 'POST', body);
/** `PUT /api/settings` with the current settings and `patch` on top (or `raw` as the whole body). */
const putSettings = (h: Harness, patch: Partial<SettingsJson> | string) =>
  req<SettingsJson & { error?: string }>(h, '/api/settings', 'PUT', typeof patch === 'string' ? patch : { ...h.state.settings(), ...patch });

/** A server with `save` (default the fixture save) chosen. */
async function withSave(save?: Uint8Array): Promise<Harness> {
  const h = await start(save === undefined ? {} : { save });
  await putSettings(h, { savePath: h.savePath });
  return h;
}

/** One request through `node:http`, which sends the target and the headers as given (`Host` included). */
function rawRequest(h: Harness, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{
  status: number; contentType: string | undefined; cacheControl: string | undefined; body: string;
}> {
  const { hostname, port } = new URL(h.url);
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname, port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0, contentType: res.headers['content-type'], cacheControl: res.headers['cache-control'],
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    r.on('error', reject);
    r.end(opts.body);
  });
}

/** `GET /api/events` read with the page's SSE reader; `next(name)` waits for the next event of that name. */
async function subscribe(h: Harness) {
  const controller = new AbortController();
  const res = await fetch(`${h.url}/api/events`, { signal: controller.signal });
  const events: SseEvent[] = [];
  const reading = readSse(res.body!, (e) => events.push(e)).catch(() => undefined);
  let seen = 0;
  return {
    next: (name: string) => vi.waitFor(() => {
      const at = events.findIndex((e, k) => k >= seen && e.event === name);
      if (at < 0) throw new Error(`No ${name} event yet`);
      seen = at + 1;
      return JSON.parse(events[at]!.data) as unknown;
    }),
    async close() {
      controller.abort();
      await reading;
    },
  };
}

const saveWithMonAt = (level: number) => saveFile({ ...SERVER_SAVE, party: [monferno({ level }), starly()] });
const missing = () => {
  throw new MissingDataError('Missing data/rom/romdata.json');
};
const cannotRead = (file: string, rest: string) => new RegExp(`^Cannot read ${file.replaceAll('.', '\\.')}: ${rest}`);
const staticDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-app-test-static-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><h1>Plat Kaizo Planner</h1>');
  removeLater(dir);
  return dir;
};

describe('routes that do not exist or take another method', () => {
  it.each([
    ['GET', '/api/nope'], ['PUT', '/api/settings/priorities'], ['POST', '/api/plan'], ['POST', '/api/plan/stop'],
    ['GET', '/api/gauntlets'], ['GET', '/api/sheet/ai'],
  ])('%s %s is 404', async (method, route) => {
    expect(await req(await start(), route, method, '{}')).toEqual({ status: 404, body: { error: `No API route ${method} ${route}` } });
  });

  it.each([['DELETE', '/api/box', 'GET'], ['GET', '/api/sheet', 'POST'], ['GET', '/api/sheet/ai/stream', 'POST']])(
    '%s %s is 405 naming %s', async (method, route, allow) => {
      const res = await fetch(`${(await start()).url}${route}`, { method });
      expect([res.status, res.headers.get('allow'), await res.json()]).toEqual([405, allow, { error: `${method} is not allowed on ${route}; use ${allow}` }]);
    },
  );
});

describe('GET and PUT /api/settings', () => {
  it('GET gives the defaults; PUT then GET round-trips and persists to the settings file', async () => {
    const h = await start();
    expect(await get(h, '/api/settings')).toEqual({ status: 200, body: DEFAULT_SETTINGS });
    const next: SettingsJson = { ...DEFAULT_SETTINGS, savePath: h.savePath, graveyardBox: 16, levelCapOverride: 30 };
    expect(await putSettings(h, JSON.stringify(next))).toEqual({ status: 200, body: next });
    expect(await get(h, '/api/settings')).toEqual({ status: 200, body: next });
    expect(JSON.parse(fs.readFileSync(h.settingsFile, 'utf8'))).toEqual(next);
  });

  it('a bad body, or a savePath that is not a save, gives 400 { error } and changes nothing', async () => {
    const h = await start();
    const tenBytes = path.join(h.dir, 'ten-bytes.dsv');
    fs.writeFileSync(tenBytes, new Uint8Array(10));
    const absent = path.join(h.dir, 'absent.dsv');
    for (const [patch, error] of [
      ['{ not json', /JSON/], [{ graveyardBox: 40 }, /graveyardBox/],
      [{ savePath: tenBytes }, cannotRead(tenBytes, 'A save is \\d+ bytes')], [{ savePath: absent }, cannotRead(absent, 'ENOENT')],
    ] as const) {
      const put = await putSettings(h, patch);
      expect([put.status, put.body.error]).toEqual([400, expect.stringMatching(error)]);
    }
    expect((await get(h, '/api/settings')).body).toEqual(DEFAULT_SETTINGS);
    expect([fs.existsSync(h.settingsFile), h.watchers]).toEqual([false, []]);
  });

  it('without the extract any savePath is kept (it cannot be read as a save yet)', async () => {
    const h = await start({ deps: { loadData: missing } });
    const bad = path.join(h.dir, 'ten-bytes.dsv');
    fs.writeFileSync(bad, new Uint8Array(10));
    expect(await putSettings(h, { savePath: bad })).toMatchObject({ status: 200, body: { savePath: bad } });
  });
});

describe('GET /api/box', () => {
  it('gives 409 with no save or no data, and 422 with the read error for a save it cannot read', async () => {
    expect(await get(await start(), '/api/box')).toEqual({ status: 409, body: { error: 'Choose a save first' } });
    const noData = await start({ deps: { loadData: missing } });
    await putSettings(noData, { savePath: noData.savePath });
    expect(await get(noData, '/api/box')).toEqual({ status: 409, body: { error: expect.stringMatching(/setup/) } });
    const bad = await start({ save: new Uint8Array(10), settings: (savePath) => ({ savePath }) });
    expect(await get(bad, '/api/box')).toEqual({ status: 422, body: { error: expect.stringMatching(/^Cannot read .*: A save is \d+ bytes/) } });
  });

  it('reads and watches the save named in the settings file at startup: the fixture\'s mons and level cap', async () => {
    const h = await start({ settings: (savePath) => ({ savePath }) });
    const { status, body } = await get<BoxJson>(h, '/api/box');
    expect(status).toBe(200);
    expect(body).toMatchObject({ savePath: h.savePath, savedAt: fs.statSync(h.savePath).mtime.toISOString(), badges: 1, levelCap: 28 });
    expect(body.mons.map((m) => [m.ref, m.nickname, m.level, m.eligible])).toEqual([
      ['party:1', 'Mon', 15, true], ['party:2', 'Starly', 14, true], ['box:1:1', 'Starly', 14, true], ['box:15:1', 'Ghost', 14, false],
    ]);
    expect(h.watchers.map((w) => [w.path, w.closed])).toEqual([[h.savePath, false]]);
  });

  it('a cap or graveyard change rebuilds the box from the last bytes, without reading the save again, and pushes a box event', async () => {
    let reads = 0;
    const h = await start({ deps: { readFile: async (file: string) => { reads++; return new Uint8Array(await fs.promises.readFile(file)); } } });
    await putSettings(h, { savePath: h.savePath });
    const before = reads;
    const events = await subscribe(h);
    await putSettings(h, { levelCapOverride: 14 });
    const capped = (await events.next('box')) as BoxJson;
    expect([capped.levelCap, capped.mons[0]!.ineligibleReasons]).toEqual([14, ['over cap']]);
    await putSettings(h, { levelCapOverride: null, graveyardBox: 1 });
    for (const box of [(await events.next('box')) as BoxJson, (await get<BoxJson>(h, '/api/box')).body]) {
      expect([box.levelCap, box.mons.find((m) => m.ref === 'box:1:1')!.ineligibleReasons]).toEqual([28, ['dead']]);
    }
    expect(reads).toBe(before);
    await events.close();
  });

  it('a new savePath re-reads the box at once and moves the watcher; null closes it', async () => {
    const h = await withSave();
    const other = path.join(h.dir, 'other.dsv');
    fs.writeFileSync(other, saveFile({ ...SERVER_SAVE, badgeMask: 0b11 }));
    await putSettings(h, { savePath: other });
    expect(h.watchers.map((w) => [w.path, w.closed])).toEqual([[h.savePath, true], [other, false]]);
    expect((await get<BoxJson>(h, '/api/box')).body).toMatchObject({ savePath: other, badges: 2, levelCap: 38 });
    await putSettings(h, { savePath: null });
    expect(h.watchers.every((w) => w.closed)).toBe(true);
    expect((await get(h, '/api/box')).status).toBe(409);
  });
});

describe('GET /api/events', () => {
  it('opens with a comment line and no event', async () => {
    const res = await fetch(`${(await start()).url}/api/events`);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toMatch(/^:[^\n]*\n\n$/);
    await reader.cancel();
  });

  it('pushes box after the watched save changes; a failed re-read keeps the last box and pushes boxError; the next change recovers', async () => {
    const h = await withSave();
    const events = await subscribe(h);
    fs.writeFileSync(h.savePath, saveWithMonAt(16));
    await h.fire();
    expect(((await events.next('box')) as BoxJson).mons[0]!.level).toBe(16);
    fs.writeFileSync(h.savePath, new Uint8Array(1234));                  // DeSmuME caught mid-write
    await h.fire();
    expect(((await events.next('boxError')) as { error: string }).error).toMatch(cannotRead(h.savePath, 'A save is \\d+ bytes[^\\n]*$'));
    expect((await get<BoxJson>(h, '/api/box')).body.mons[0]!.level).toBe(16);
    fs.writeFileSync(h.savePath, saveWithMonAt(17));
    await h.fire();
    expect(((await events.next('box')) as BoxJson).mons[0]!.level).toBe(17);
    await events.close();
  });

  it('runs one re-read at a time, with one rerun for the changes that arrived during it', async () => {
    let active = 0;
    let maxActive = 0;
    let reads = 0;
    let gate: Promise<void> | null = null;
    let release = () => {};
    const readFile = async (file: string): Promise<Uint8Array> => {
      reads++;
      maxActive = Math.max(maxActive, ++active);
      try {
        await gate;
        return new Uint8Array(await fs.promises.readFile(file));
      } finally {
        active--;
      }
    };
    const h = await start({ deps: { readFile } });
    await putSettings(h, { savePath: h.savePath });
    const before = reads;
    gate = new Promise<void>((resolve) => { release = resolve; });
    const first = h.fire();
    await vi.waitFor(() => expect(active).toBe(1));
    fs.writeFileSync(h.savePath, saveWithMonAt(17));
    const rest = [h.fire(), h.fire()];
    release();
    await Promise.all([first, ...rest]);
    expect([reads - before, maxActive]).toEqual([2, 1]);
    expect((await get<BoxJson>(h, '/api/box')).body.mons[0]!.level).toBe(17);
  });

  it('drops the subscription when the client disconnects', async () => {
    const h = await start();
    const subscribeOriginal = h.state.subscribe.bind(h.state);
    let live = 0;
    vi.spyOn(h.state, 'subscribe').mockImplementation((listener) => {
      live++;
      const off = subscribeOriginal(listener);
      let done = false;
      return () => { if (!done) live--; done = true; off(); };
    });
    const events = await subscribe(h);
    await vi.waitFor(() => expect(live).toBe(1));
    await events.close();
    await vi.waitFor(() => expect(live).toBe(0));
  });
});

describe('the data routes', () => {
  it('GET /api/trainers lists every trainer in game order or those a search finds; /api/draft/options the items and growth tables', async () => {
    const h = await start();
    expect((await get<TrainerSummaryJson[]>(h, '/api/trainers')).body.map((t) => t.id)).toEqual([TRISTAN_ID, TWINS_ID, GARDENIA_ID]);
    expect((await get<TrainerSummaryJson[]>(h, '/api/trainers?search=tristan')).body.map((t) => [t.id, t.order])).toEqual([[TRISTAN_ID, 0]]);
    const { status, body } = await get<DraftOptionsJson>(h, '/api/draft/options');
    expect([status, body]).toEqual([200, { growth: serverData().rom.growth, items: draftItems(serverData()) }]);
    expect(body.items).toContainEqual({ id: 42, name: 'Lava Cookie' });
  });

  it.each(['/api/trainers', '/api/draft/options'])('GET %s is 409 without the data', async (route) => {
    expect((await get(await start({ deps: { loadData: missing } }), route)).status).toBe(409);
  });
});

describe('POST /api/sheet', () => {
  const TEAM = ['party:1', 'party:2', 'box:1:1'];
  const body = (over: Record<string, unknown> = {}) => ({ trainer: TRISTAN_ID, team: TEAM, draft: [], ...over });
  const sheet = (h: Harness, b: unknown = body()) => post<SheetJson & { error?: string }>(h, '/api/sheet', b);
  const emberMax = (s: SheetJson) => s.pairs[0]!.playerMoves[1]!.damage!.max;
  /** Mon at 10 of 44 HP: from that HP, Blaze powers up its Ember. */
  const HURT = () => saveFile({ ...SERVER_SAVE, party: [monferno({ currentHp: 10 }), starly()] });

  /** `buildSheet` over the pool's Pokémon (each as `edit` leaves it) with `hp: 'save'`: what the route must give. */
  function built(h: Harness, edit: (mon: PlayerMon, ref: string) => PlayerMon = (mon) => mon): SheetJson {
    const data = h.state.data()!;
    const box = h.state.box() as BoxState;
    const s = buildSheet(TEAM.map((ref) => edit(box.pool.get(ref)!, ref)), data.catalog.byId(TRISTAN_ID)!, { moves: data.moves, hp: 'save' });
    return { ...sheetToJson(s, { names: data.local.names, variant: 0, variants: 1 }), savedAt: box.json.savedAt, savePath: box.json.savePath };
  }

  it('gives the sheet of the team asked for in its order, over the level cap too; an empty team gives the enemies and no pairs', async () => {
    const h = await start();
    await putSettings(h, { savePath: h.savePath, levelCapOverride: 14 });   // Mon (party:1, Lv 15) is over it
    const { status, body: s } = await sheet(h, body({ team: ['box:1:1', 'party:1'] }));
    expect([status, s.players.map((p) => [p.key, p.level]), s.enemies.map((e) => e.key), s.pairs.length])
      .toEqual([200, [['box:1:1', 14], ['party:1', 15]], ['enemy:0', 'enemy:1'], 4]);
    const empty = (await sheet(h, body({ team: [] }))).body;
    expect([empty.players, empty.pairs, empty.enemies.length]).toEqual([[], [], 2]);
  });

  it('gives each player the Showdown set GET /api/box gives the same Pokémon', async () => {
    const h = await withSave();
    const eligible = (await get<BoxJson>(h, '/api/box')).body.mons.filter((m) => m.eligible);
    expect(eligible.map((m) => m.ref)).toEqual(TEAM);
    expect((await sheet(h)).body.players.map((p) => [p.key, p.showdown])).toEqual(eligible.map((m) => [m.ref, m.showdown]));
  });

  it('picks a variant, and gives 400 for one the trainer lacks', async () => {
    const h = await withSave();
    const copy = await sheet(h, body({ trainer: GARDENIA_ID, variant: 1 }));
    expect([copy.status, copy.body.trainer.variant, copy.body.trainer.variants, copy.body.trainer.field]).toEqual([200, 1, 2, 'PERMANENT RAIN']);
    for (const variant of [2, -1, 1.5]) {
      expect(await sheet(h, body({ trainer: GARDENIA_ID, variant }))).toEqual({ status: 400, body: { error: 'variant must be a whole number from 0 to 1: Leader Gardenia has 2 copies' } });
    }
  });

  it('with no draft the numbers are buildSheet\'s on the save\'s HP; a draft changes the level and stats, HP, status and item', async () => {
    const h = await withSave(HURT());
    const plain = (await sheet(h)).body;
    expect(plain).toEqual(built(h));
    expect(plain.pairs[0]!.enemyMoves[0]!.damage).toMatchObject({ bounded: true, ohko: false, desc: expect.stringMatching(/^Starly Tackle vs\. Monferno: /) });
    expect(plain.players.map((p) => [p.key, p.hp, p.status])).toEqual([['party:1', 10, null], ['party:2', 35, null], ['box:1:1', 35, null]]);
    const max = plain.players[0]!.stats.hp;
    const drafted = async (edit: object) => (await sheet(h, body({ draft: [{ ref: 'party:1', ...edit }] }))).body;
    const raised = await drafted({ level: 18 });
    expect(raised.players[0]).toMatchObject({ key: 'party:1', level: 18 });
    expect(raised.players[0]!.stats.hp).toBeGreaterThan(max);
    expect(raised.players.slice(1)).toEqual(plain.players.slice(1));
    const healed = await drafted({ hp: max });
    expect(healed).toEqual(built(h, (mon, ref) => (ref === 'party:1' ? { ...mon, currentHp: max } : mon)));
    expect(emberMax(healed)).not.toBe(emberMax(plain));
    expect((await drafted({ hp: 7, status: 'burn' })).players[0]).toMatchObject({ hp: 7, status: 'burn' });
    const bare = (await drafted({ item: 0 })).players[0]!;
    expect([plain.players[0]!.item === null, bare.item, bare.showdown.includes(' @ ')]).toEqual([false, null, false]);
  });

  it('refuses what it cannot use: 400, 404 and 409, each with the reason', async () => {
    const h = await withSave();
    for (const [b, status, error] of [
      [[], 400, 'The body must be a JSON object'],
      [body({ hp: 'full' }), 400, 'hp is not part of a sheet request'],
      [body({ levels: {} }), 400, 'levels is not part of a sheet request'],
      [{ team: TEAM, draft: [] }, 400, 'trainer is required: a trainer ID'],
      [body({ trainer: 'nobody' }), 404, 'No trainer nobody'],
      [body({ variant: 5 }), 400, expect.stringMatching(/^variant must be/)],
      [body({ team: 'party:1' }), 400, 'team must be an array of MonRefs'],
      [body({ team: ['box:15:1'] }), 400, 'team: box:15:1 cannot fight (in the graveyard)'],
      [body({ team: ['box:2:1'] }), 400, 'team: there is no Pokémon at box:2:1'],
      [body({ team: [' party:1'] }), 400, 'team: there is no Pokémon at  party:1'],
      [body({ team: ['party:1', 'party:1'] }), 400, 'team lists party:1 twice'],
      [{ trainer: TRISTAN_ID, team: TEAM }, 400, 'draft is required: an array of draft entries (an empty array starts the team as the save has it)'],
      [body({ team: ['party:1'], draft: [{ ref: 'party:2' }] }), 400, 'draft: party:2 is not in the team'],
      [body({ draft: [{ ref: 'party:1', hp: 0 }] }), 400, expect.stringMatching(/^draft: party:1 hp must be a whole number from 1 to \d+, not 0$/)],
    ] as const) {
      expect(await sheet(h, b), JSON.stringify(b)).toEqual({ status, body: { error } });
    }
    expect((await sheet(await start())).status).toBe(409);
  });

  it('a thrown handler gives 500 { error } and is logged', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = await start({ deps: { buildSheet: () => { throw new Error('sheet exploded'); } } });
    await putSettings(h, { savePath: h.savePath });
    expect(await sheet(h, body({ team: ['party:1'] }))).toEqual({ status: 500, body: { error: 'sheet exploded' } });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]![0])).toMatch(/POST \/api\/sheet/);
  });
});

describe('POST /api/sheet/ai/stream', () => {
  // The fixture data with the records the AI reads, installed as the engine's dex as the server's deps do.
  const aiData = withAiRecords(serverData());
  beforeAll(() => installKaizoDex(aiData, buildMoves(aiData)));

  async function withAi(model: EnemyModel = fixtureAi(aiData, NOTHING), aiOdds?: AiOddsLevel): Promise<Harness> {
    const h = await start({ deps: { loadData: () => aiData, sheetAi: { model, engine: SHOWDOWN_SHEET_ENGINE }, ...(aiOdds === undefined ? {} : { aiOdds }) } });
    await putSettings(h, { savePath: h.savePath });
    return h;
  }

  type Event = { event: string; data: unknown };
  const B = { trainer: TRISTAN_ID, team: ['party:1', 'party:2', 'box:1:1'], draft: [] };
  const EVENTS = ['start', 'pair', 'pair', 'pair', 'pair', 'pair', 'pair', 'done'];
  const names = (events: Event[]) => events.map((e) => e.event);

  /** The stream for `body`, read with the page's SSE reader; `onEvent` sees each event as it arrives. */
  async function openPost(h: Harness, body: unknown, onEvent: (e: Event) => void = () => undefined) {
    const controller = new AbortController();
    const res = await fetch(`${h.url}/api/sheet/ai/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
    });
    const events: Event[] = [];
    const ended = readSse(res.body!, (e) => {
      const event = { event: e.event, data: JSON.parse(e.data) as unknown };
      events.push(event);
      onEvent(event);
    }).catch((error: unknown) => error);
    return { res, events, ended, close: () => controller.abort() };
  }
  const run = async (h: Harness, b: unknown) => { const s = await openPost(h, b); await s.ended; return s.events; };

  /** The fixture AI with its decisions counted, each holding the thread for `ms` as the real AI does. */
  function slowModel(ms: number) {
    const fast = fixtureAi(aiData, NOTHING);
    const count = { decisions: 0 };
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const model: EnemyModel = {
      ...fast,
      support(state, memory) {
        count.decisions++;
        if (ms > 0) Atomics.wait(pause, 0, 0, ms);
        return fast.support(state, memory);
      },
    };
    return { model, count };
  }

  function firstPair() {
    let seen!: () => void;
    const arrived = new Promise<void>((resolve) => { seen = resolve; });
    return { arrived, onEvent: (e: Event) => e.event === 'pair' && seen() };
  }

  it('streams the odds of the sheet the same body gives: start, each pair in its order, done; an empty team is start then done', async () => {
    const h = await withAi();
    const sheet = (await post<SheetJson>(h, '/api/sheet', B)).body;
    const stream = await openPost(h, B);
    expect([stream.res.status, stream.res.headers.get('content-type'), await stream.ended]).toEqual([200, 'text/event-stream; charset=utf-8', undefined]);
    const { events } = stream;
    expect(names(events)).toEqual(EVENTS);
    expect(events[0]!.data).toEqual({ savedAt: sheet.savedAt, savePath: sheet.savePath, total: 6 });
    expect(events.slice(1, -1).map((e) => { const p = e.data as SheetAiPairJson; return [p.player, p.enemy]; })).toEqual(sheet.pairs.map((p) => [p.player, p.enemy]));
    // Tristan's Starly Lv 5 against Mon: its Tackle and Growl tie, and if it faints the other Starly comes in.
    expect(events[1]!.data).toEqual({
      player: 'party:1', enemy: 'enemy:0',
      next: { status: 'ok', choices: [{ label: 'Growl', kind: 'move', probability: '1/2' }, { label: 'Tackle', kind: 'move', probability: '1/2' }] },
      ifFaints: { status: 'ok', choices: [{ label: 'Starly', kind: 'switch', probability: '1/1' }] },
    });
    expect((await run(h, { ...B, team: [] })).map((e) => [e.event, e.data])).toEqual([['start', expect.objectContaining({ total: 0 })], ['done', {}]]);
  });

  it('below the full AI odds each pair carries only what the level allows: ranks, no probability', async () => {
    const tie = {
      player: 'party:1', enemy: 'enemy:0',
      next: { status: 'ok', choices: [{ label: 'Growl', kind: 'move', rank: 1 }, { label: 'Tackle', kind: 'move', rank: 1 }] },
      ifFaints: { status: 'ok', choices: [{ label: 'Starly', kind: 'switch', rank: 1 }] },
    };
    for (const aiOdds of ['likeliest', 'ranked'] as const) {
      const events = await run(await withAi(undefined, aiOdds), B);
      expect([names(events), events[1]!.data], aiOdds).toEqual([EVENTS, tie]);
      expect(JSON.stringify(events.slice(1, -1)), aiOdds).not.toMatch(/probability|\d+\/\d+/);
    }
  });

  it('is a 501 as JSON before any work at the off level, or without the deps', async () => {
    const { model, count } = slowModel(0);
    expect(await post(await withAi(model, 'off'), '/api/sheet/ai/stream', B)).toEqual({ status: 501, body: { error: 'The AI odds are off on this server' } });
    expect(count.decisions).toBe(0);
    expect(await post(await withSave(), '/api/sheet/ai/stream', B)).toEqual({ status: 501, body: { error: 'The AI odds are not available' } });
  });

  it('follows the draft: a new draft is worked out again; a body seen before replays from the cache', async () => {
    const { model, count } = slowModel(0);
    const h = await withAi(model);
    const first = await run(h, B);
    const seen = count.decisions;
    await run(h, { ...B, draft: [{ ref: 'party:1', hp: 7 }] });
    expect(count.decisions).toBeGreaterThan(seen);
    const drafted = count.decisions;
    expect(await run(h, B)).toEqual(first);
    expect(count.decisions).toBe(drafted);
  });

  it('answers a bad body as POST /api/sheet does, as JSON before the stream opens', async () => {
    const h = await withAi();
    for (const b of [
      { ...B, hp: 'full' }, { ...B, trainer: 'nobody' }, { ...B, draft: [{ ref: 'party:1', hp: 0 }] }, { trainer: TRISTAN_ID, team: [] },
      { ...B, team: ['box:2:1'] }, { ...B, team: [' party:1'] }, { ...B, team: ['party:1', 'party:1'] },
    ]) {
      const res = await fetch(`${h.url}/api/sheet/ai/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      expect(res.headers.get('content-type'), JSON.stringify(b)).toBe('application/json; charset=utf-8');
      expect({ status: res.status, body: await res.json() as unknown }).toEqual(await post(h, '/api/sheet', b));
    }
  });

  it('takes the deps as a function of the data load, called once per load on first use', async () => {
    const model = fixtureAi(aiData, NOTHING);
    const loads: unknown[] = [];
    const h = await start({ deps: { loadData: () => aiData, sheetAi: (data) => { loads.push(data); return { model, engine: SHOWDOWN_SHEET_ENGINE }; } } });
    await putSettings(h, { savePath: h.savePath });
    expect(loads).toHaveLength(0);
    for (const trainer of [TRISTAN_ID, GARDENIA_ID]) expect((await run(h, { ...B, trainer })).at(-1)).toEqual({ event: 'done', data: {} });
    expect(loads).toEqual([h.state.data()]);
  });

  it('each pair reaches the page as it is worked out, before the next one is', async () => {
    const { model, count } = slowModel(40);
    const arrivals: number[] = [];                 // the decisions made when each pair arrived
    await (await openPost(await withAi(model), B, (e) => { if (e.event === 'pair') arrivals.push(count.decisions); })).ended;
    expect(arrivals[0]).toBeLessThan(count.decisions);
    for (let i = 1; i < arrivals.length; i++) expect(arrivals[i]).toBeGreaterThan(arrivals[i - 1]!);
  });

  it('closing every stream stops the batch, and the next request works the odds out again', async () => {
    const { model, count } = slowModel(40);
    const h = await withAi(model);
    const seen = firstPair();
    const a = await openPost(h, B, seen.onEvent);
    const b = await openPost(h, B);
    await seen.arrived;
    a.close();
    b.close();
    await Promise.all([a.ended, b.ended]);
    await new Promise((resolve) => setTimeout(resolve, 600));   // long enough for the whole batch, had it gone on
    const stoppedAt = count.decisions;
    expect(names(await run(h, B))).toEqual(EVENTS);
    expect(stoppedAt).toBeLessThan(count.decisions - stoppedAt);
  });

  it('a batch that fails as a whole (the AI deps do not load) sends error, and ends', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = await start({ deps: { loadData: () => aiData, sheetAi: () => { throw new Error('no AI data'); } } });
    await putSettings(h, { savePath: h.savePath });
    const stream = await openPost(h, B);
    expect([stream.res.status, await stream.ended, stream.events]).toEqual([200, undefined, [{ event: 'error', data: { error: 'no AI data' } }]]);
    expect(logged).toHaveBeenCalled();
  });
});

describe('the local-only guard', () => {
  it('lets only Host 127.0.0.1:<port> or localhost:<port> (any case) reach /api', async () => {
    const h = await start();
    const { port } = new URL(h.url);
    for (const [host, status] of [
      ['evil.example', 403], [`evil.example:${port}`, 403], [`127.0.0.1:${Number(port) + 1}`, 403], ['127.0.0.1', 403], [`0.0.0.0:${port}`, 403],
      [`127.0.0.1:${port}`, 200], [`localhost:${port}`, 200], [`LocalHost:${port}`, 200],
    ] as const) {
      for (const route of ['/api/settings', '/api/config', '/api/health']) {
        const res = await rawRequest(h, { path: route, headers: { Host: host } });
        expect([host, route, res.status], res.body).toEqual([host, route, status]);
        if (status === 403) expect(JSON.parse(res.body)).toEqual({ error: 'Requests must come from the planner page' });
      }
    }
  });

  it('gives 415 to a PUT or POST whose Content-Type is not application/json, and changes nothing; any charset passes', async () => {
    const h = await start();
    const host = `127.0.0.1:${new URL(h.url).port}`;
    const body = JSON.stringify({ ...DEFAULT_SETTINGS, graveyardBox: 16 });
    for (const contentType of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'application/jsonx', null]) {
      const res = await rawRequest(h, { method: 'PUT', path: '/api/settings', body, headers: { Host: host, ...(contentType === null ? {} : { 'Content-Type': contentType }) } });
      expect([contentType, res.status, JSON.parse(res.body)]).toEqual([contentType, 415, { error: expect.stringMatching(/application\/json/) }]);
    }
    expect((await rawRequest(h, { method: 'POST', path: '/api/line/start', body: '{}', headers: { Host: host, 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect([h.state.settings(), fs.existsSync(h.settingsFile)]).toEqual([DEFAULT_SETTINGS, false]);
    const res = await fetch(`${h.url}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'Application/JSON; charset=utf-8' }, body });
    expect([res.status, h.state.settings().graveyardBox]).toEqual([200, 16]);
  });

  it('a malformed request target gives 400 { error }, not 500, and logs nothing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = await start();
    for (const target of ['//', '//[']) {
      const res = await rawRequest(h, { path: target });
      expect([target, res.status, res.contentType, JSON.parse(res.body)]).toEqual([target, 400, 'application/json; charset=utf-8', { error: expect.stringMatching(/request target/) }]);
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it('the built page: 404 without a static dir; with one, served outside /api to any Host', async () => {
    expect((await fetch(`${(await start()).url}/fight`)).status).toBe(404);
    const h = await start({ deps: { staticDir: staticDir() } });
    const res = await fetch(`${h.url}/fight`);
    expect([res.status, res.headers.get('content-type'), await res.text()]).toEqual([200, 'text/html; charset=utf-8', expect.stringContaining('Plat Kaizo Planner')]);
    expect(await rawRequest(h, { path: '/fight', headers: { Host: 'evil.example' } })).toMatchObject({ status: 200, body: expect.stringContaining('Plat Kaizo Planner') });
  });
});

it('GET /api/config and /api/health in local mode: the AI odds level, not cached; the version given (else dev) and whole seconds up', async () => {
  const res = await rawRequest(await start(), { path: '/api/config' });
  expect([res.status, res.cacheControl, JSON.parse(res.body)]).toEqual([200, 'no-store', { mode: 'local', aiOdds: 'full' }]);
  for (const aiOdds of ['likeliest', 'ranked', 'off'] as const) {
    expect((await get((await start({ deps: { aiOdds } })), '/api/config')).body).toEqual({ mode: 'local', aiOdds });
  }
  const { status, body } = await get<{ uptimeSeconds: number }>(await start(), '/api/health');
  expect([status, body]).toEqual([200, { ok: true, mode: 'local', version: 'dev', uptimeSeconds: expect.any(Number) }]);
  expect(Number.isInteger(body.uptimeSeconds) && body.uptimeSeconds >= 0 && body.uptimeSeconds <= Math.ceil(process.uptime())).toBe(true);
  expect((await get(await start({ deps: { version: '1.4.0' } as never }), '/api/health')).body).toMatchObject({ version: '1.4.0' });
});

describe('the server state', () => {
  it('a missing extract gives dataStatus missing; each reload makes a new data object (dataVersion + 1), a box read does not', async () => {
    let extracted = false;
    const h = await start({ deps: { loadData: () => (extracted ? serverData() : missing()) } });
    await putSettings(h, { savePath: h.savePath });
    expect([h.state.dataStatus(), h.state.data(), h.state.box()]).toEqual([{ state: 'missing', message: null, trainers: null }, null, null]);
    extracted = true;
    h.state.reloadData();
    expect([h.state.dataStatus(), h.state.data()?.catalog.trainers.length]).toEqual([{ state: 'ready', message: null, trainers: 3 }, 3]);
    expect((await get(h, '/api/trainers')).status).toBe(200);
    await vi.waitFor(async () => expect((await get(h, '/api/box')).status).toBe(200));
    const [data, version] = [h.state.data(), h.state.dataVersion()];
    await h.fire();                                   // a box read: the same data
    expect([h.state.data(), h.state.dataVersion()]).toEqual([data, version]);
    h.state.reloadData();
    expect([h.state.data() === data, h.state.dataVersion()]).toEqual([false, version + 1]);
  });

  it('a DocsError BAD_FORMAT gives dataStatus error with its message, and the data routes answer 409 with it', async () => {
    const message = 'docs cache unreadable: Moves: bad row; run npm run extract -- --rom <path> to download it again';
    const h = await start({ deps: { loadData: () => { throw new DocsError('BAD_FORMAT', 'Moves', message); } } });
    expect(h.state.dataStatus()).toEqual({ state: 'error', message, trainers: null });
    expect(await get(h, '/api/trainers')).toEqual({ status: 409, body: { error: expect.stringContaining(message) } });
  });
});

describe('startServer', () => {
  it('binds 127.0.0.1, and closing it frees the port', async () => {
    const h = await start();
    expect(h.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await closeServers();
    await expect(fetch(`${h.url}/api/setup`)).rejects.toThrow();
  });

  it('rejects with EADDRINUSE when the port is taken', async () => {
    const taken = http.createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-app-test-'));
      removeLater(dir);
      await expect(startServer({
        dataDir: dir, settingsFile: path.join(dir, 'settings.json'), staticDir: null, buildSheet, loadData: () => serverData(), port: (taken.address() as AddressInfo).port,
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });
});
