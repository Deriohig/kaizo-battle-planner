// A fake planner server for the page's tests: `fetch` answers from a route table ("GET /api/setup"), and `EventSource`
// (jsdom has none) is a class the test drives: `open()`, `emit('box', …)`, `fail()`. `liveStream` is an event stream
// the test feeds frame by frame.

import { vi } from 'vitest';
import type {
  BoxDraftJson, BoxJson, BoxMonJson, DraftOptionsJson, SettingsJson, SetupJson, SheetJson, SheetMonJson, SheetMoveJson, TrainerSummaryJson,
} from '../../../src/server/apiTypes';
import { sseFrame } from '../../../src/server/sse';

export interface FetchCall { method: string; url: string; headers: Headers; body: unknown; signal: AbortSignal | undefined }

/** A JSON answer, an event stream of `[event, data]` frames, or a stream the test feeds itself (`liveStream`). */
export type Answer =
  | { status?: number; json: unknown }
  | { status?: number; events: [string, unknown][] }
  | { status?: number; stream: ReadableStream<Uint8Array> };
type Route = Answer | ((call: FetchCall) => Answer | Promise<Answer>);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function eventStream(events: [string, unknown][]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(events.map(([name, data]) => sseFrame(name, data)).join(''));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Stubs `fetch` with `routes` keyed "<METHOD> <path>" (no query), each an answer or a function of the call, else 404; records every call. */
export function stubFetch(routes: Record<string, Route>): { calls: FetchCall[]; fetch: ReturnType<typeof vi.fn> } {
  const calls: FetchCall[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const call: FetchCall = { method, url, headers: new Headers(init?.headers), body, signal: init?.signal ?? undefined };
    calls.push(call);
    const route = routes[`${method} ${url.split('?')[0]}`];
    if (route === undefined) return jsonResponse(404, { error: `No stub for ${method} ${url}` });
    const answer = typeof route === 'function' ? await route(call) : route;
    if ('events' in answer || 'stream' in answer) {
      const stream = 'events' in answer ? eventStream(answer.events) : answer.stream;
      return new Response(stream, { status: answer.status ?? 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (answer.status === 204) return new Response(null, { status: 204 });
    return jsonResponse(answer.status ?? 200, answer.json);
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, fetch };
}

type Listener = (e: Event) => void;

/** A stand-in for the browser's EventSource. The test opens, fails and feeds it; `instances` holds every one made. */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  /** The newest one. */
  static last(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    if (last === undefined) throw new Error('No EventSource was made');
    return last;
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (set === undefined) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  get closed(): boolean {
    return this.readyState === FakeEventSource.CLOSED;
  }

  private dispatch(e: Event): void {
    for (const listener of [...(this.listeners.get(e.type) ?? [])]) listener(e);
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.dispatch(new Event('open'));
  }

  emit(name: string, data: unknown): void {
    this.dispatch(new MessageEvent(name, { data: JSON.stringify(data) }));
  }

  /** A dropped stream: the browser retries (CONNECTING), or with `closed` gives up (CLOSED, as for a non-200 answer). */
  fail(closed = false): void {
    this.readyState = closed ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    this.dispatch(new Event('error'));
  }
}

export function stubEventSource(): typeof FakeEventSource {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  return FakeEventSource;
}

/** An event stream the test feeds: `send` a frame, `close` it. It fails with an AbortError when `signal` aborts, as a fetch body does. */
export function liveStream(signal?: AbortSignal): { stream: ReadableStream<Uint8Array>; send(event: string, data: unknown): void; close(): void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const encoder = new TextEncoder();
  signal?.addEventListener('abort', () => {
    try {
      controller?.error(new DOMException('The operation was aborted.', 'AbortError'));
    } catch {
      // already closed
    }
  });
  return {
    stream,
    send: (event, data) => controller?.enqueue(encoder.encode(sseFrame(event, data))),
    close: () => controller?.close(),
  };
}

// Fixtures: the player's two save copies, the settings and a box.

export const ROM = '/mnt/c/Users/User/Desktop/Games/Emulators/Roms/plat-kaizo-nightmare-update-final.nds';
export const SAVE_12_JUNE = '/mnt/c/Users/User/Downloads/desmume-0.9.13-win64/Battery/plat-kaizo-nightmare-update-final.dsv';
export const SAVE_23_MAY = '/mnt/c/Users/User/Desktop/Games/Emulators/Battery/plat-kaizo-nightmare-update-final.dsv';

export function settings(over: Partial<SettingsJson> = {}): SettingsJson {
  return { romPath: ROM, savePath: null, graveyardBox: null, levelCapOverride: null, ...over };
}

export function setup(over: Partial<SetupJson> = {}): SetupJson {
  return {
    data: { state: 'ready', message: null, trainers: 456 },
    romPath: ROM, savePath: null,
    saveCandidates: [
      { path: SAVE_12_JUNE, modifiedAt: '2026-06-12T12:00:00.000Z', sizeBytes: 524_410, summary: 'Party: Blaze (Monferno) Lv 15, Starly Lv 14 · 0 badges · 20 in the boxes', error: null },
      { path: SAVE_23_MAY, modifiedAt: '2026-05-23T12:00:00.000Z', sizeBytes: 524_410, summary: 'Party: Chimchar Lv 9 · 0 badges · 15 in the boxes', error: null },
    ],
    ...over,
  };
}

// A box Pokémon's draft facts, by default the Starly's, agreeing with `mon()` and the level³ tables: EXP 2800 is Lv 14,
// max HP 38 at Lv 14 (50 at 20), and it learns Quick Attack at 5 and Wing Attack at 17.
export function draftFacts(over: Partial<BoxDraftJson> = {}): BoxDraftJson {
  return {
    exp: 2800, growthRate: 3, baseStats: { hp: 36, atk: 40, def: 40, spa: 40, spd: 40, spe: 40 }, nature: 13, item: 0,
    moves: [{ id: 33, ppUps: 0 }, { id: 45, ppUps: 0 }],
    learnset: [{ level: 5, id: 98, name: 'Quick Attack', pp: 30 }, { level: 17, id: 17, name: 'Wing Attack', pp: 35 }],
    ...over,
  };
}

/** `GET /api/draft/options`: four items, sorted by name, and six EXP tables of level³ (levels 0–100), unless `over` says otherwise. */
export function draftOptions(over: Partial<DraftOptionsJson> = {}): DraftOptionsJson {
  return {
    items: [{ id: 149, name: 'Cheri Berry' }, { id: 234, name: 'Leftovers' }, { id: 231, name: 'Lucky Egg' }, { id: 155, name: 'Oran Berry' }],
    growth: Array.from({ length: 6 }, () => Array.from({ length: 101 }, (_, level) => level ** 3)),
    ...over,
  };
}

// A box Pokémon, by default Starly "STARLY" Lv 14 with Tackle and Growl; its Showdown set is built from its fields, its
// draft is `draftFacts()` when it can join one (no reasons, or only 'over cap'), else null.
export function mon(ref: BoxMonJson['ref'], over: Partial<BoxMonJson> = {}): BoxMonJson {
  const [kind, a, b] = ref.split(':');
  const inParty = kind === 'party';
  const defaults: Omit<BoxMonJson, 'showdown'> = {
    ref, key: `key-${ref}`, nickname: 'STARLY', species: 'Starly', level: 14, nature: 'Jolly', ability: 'Keen Eye', item: null,
    moves: [{ name: 'Tackle', pp: 35, maxPp: 35 }, { name: 'Growl', pp: 40, maxPp: 40 }], hp: 38, maxHp: 38, status: null,
    location: inParty ? 'party' : 'box', box: inParty ? null : Number(a), slot: Number(inParty ? a : b),
    eligible: true, ineligibleReasons: [], notes: [],
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    hiddenPower: { type: 'Dark', power: 70 }, natureEffect: { up: 'spe', down: 'spa' }, types: ['Normal'], draft: null,
  };
  const fields = { ...defaults, ...over };
  const reasons = fields.ineligibleReasons;
  const joins = reasons.length === 0 || (reasons.length === 1 && reasons[0] === 'over cap');
  return {
    ...fields,
    draft: over.draft !== undefined ? over.draft : joins ? draftFacts() : null,
    showdown: over.showdown !== undefined ? over.showdown : shortSet(fields),
  };
}

/** "Blaze (Monferno) @ Oran Berry", "Level: 15", "Ability: Iron Fist", then "- Mach Punch" for each move. */
function shortSet(m: Pick<BoxMonJson, 'nickname' | 'species' | 'item' | 'level' | 'ability' | 'moves'>): string {
  const name = m.nickname === '' || m.nickname === m.species ? m.species : `${m.nickname} (${m.species})`;
  const head = m.item === null ? name : `${name} @ ${m.item}`;
  return [head, `Level: ${m.level}`, `Ability: ${m.ability}`, ...m.moves.map((move) => `- ${move.name}`)].join('\n');
}

// Blaze the Monferno asleep in the party, Starly, a dead Bidoof in box 15 and three that cannot fight (box 2's unnamed one has no
// Showdown set). Blaze has 44 HP at Lv 15 (46 at 16, 12 at 1), EXP 3500, and learns Scratch at 1, Flame Wheel at 16, Torment at 19.
export function box(over: Partial<BoxJson> = {}): BoxJson {
  return {
    savePath: SAVE_12_JUNE, savedAt: '2026-06-12T12:00:00.000Z', badges: 0, levelCap: 16, graveyardBoxes: [15, 16, 17, 18],
    mons: [
      mon('party:1', {
        nickname: 'Blaze', species: 'Monferno', level: 15, ability: 'Iron Fist', item: 'Oran Berry', hp: 30, maxHp: 44, status: 'sleep:2',
        moves: [{ name: 'Mach Punch', pp: 28, maxPp: 30 }, { name: 'Ember', pp: 25, maxPp: 25 }],
        notes: ['Iron Fist boosts punching moves by 20%'],
        draft: draftFacts({
          exp: 3500, baseStats: { hp: 50, atk: 40, def: 40, spa: 40, spd: 40, spe: 40 }, item: 155, moves: [{ id: 183, ppUps: 0 }, { id: 52, ppUps: 0 }],
          learnset: [{ level: 1, id: 10, name: 'Scratch', pp: 35 }, { level: 16, id: 172, name: 'Flame Wheel', pp: 25 }, { level: 19, id: 259, name: 'Torment', pp: 15 }],
        }),
      }),
      mon('party:2'),
      mon('box:1:4', { nickname: 'Big', species: 'Bibarel', level: 20, hp: 50, maxHp: 50, eligible: false, ineligibleReasons: ['over cap'], draft: draftFacts({ exp: 8000 }) }),
      mon('box:2:1', {
        nickname: '', species: '(species 414 form 1)', eligible: false, ineligibleReasons: ['unknown species 414 form 1'], showdown: null,
      }),
      mon('box:15:1', { nickname: 'BIDOOF', species: 'Bidoof', level: 8, eligible: false, ineligibleReasons: ['dead'] }),
    ],
    run: { split: 'Roark Split', splitIndex: 0, splits: ['Roark Split', 'Gardenia Split'], alsoPossible: [], fights: [], next: null },
    ...over,
  };
}

// Fixtures: trainers in game order (two splits, a double, two with two copies) and a small sheet for any of them.

export const TRISTAN = 'roark-split/youngster-tristan/1';
export const TWINS = 'roark-split/twins-ally-and-ann/1';
export const ROARK = 'roark-split/leader-roark/1';
export const TAYLOR = 'gardenia-split/aroma-lady-taylor/1';
export const GARDENIA = 'gardenia-split/leader-gardenia/1';

function trainer(id: string, name: string, split: string, location: string, order: number, over: Partial<TrainerSummaryJson> = {}): TrainerSummaryJson {
  return { id, name, split, location, order, battleType: 'single', tags: [], variants: 1, ...over };
}

const EVERY_TRAINER: TrainerSummaryJson[] = [
  trainer(TRISTAN, 'Youngster Tristan', 'Roark Split', 'Route 202', 0),
  trainer(TWINS, 'Twins Ally and Ann', 'Roark Split', 'Route 202', 1, { battleType: 'double', tags: ['DOUBLE BATTLE'] }),
  trainer(ROARK, 'Leader Roark', 'Roark Split', 'Oreburgh Gym', 2, { tags: ['SUPERBOSS'], variants: 2 }),
  trainer(TAYLOR, 'Aroma Lady Taylor', 'Gardenia Split', 'Eterna Gym', 3, { tags: ['PERMANENT RAIN', 'GYM TRAINERS ARE A GAUNTLET'] }),
  trainer(GARDENIA, 'Leader Gardenia', 'Gardenia Split', 'Eterna Gym', 4, { tags: ['PERMANENT RAIN', 'GYM TRAINERS ARE A GAUNTLET'], variants: 2 }),
];

/** Every fixture trainer, in game order (a fresh copy). */
export const trainers = (): TrainerSummaryJson[] => EVERY_TRAINER.map((t) => ({ ...t, tags: [...t.tags] }));

export function trainerById(id: string): TrainerSummaryJson {
  const found = EVERY_TRAINER.find((t) => t.id === id);
  if (found === undefined) throw new Error(`No fixture trainer ${id}`);
  return { ...found };
}

function sheetMon(key: string, name: string, nickname: string | null, level: number): SheetMonJson {
  return {
    key, name, nickname, level, nature: 'Hardy', ability: 'Keen Eye', item: null, moves: ['Tackle'],
    stats: { hp: 40, atk: 20, def: 20, spa: 20, spd: 20, spe: 20 }, hp: 40, status: null, disputed: [], showdown: `${name}\nLevel: ${level}\n- Tackle`,
  };
}

const TACKLE: SheetMoveJson = {
  name: 'Tackle', type: 'Normal', category: 'Physical', power: 35, hitChance: 1, inaccurate: false, unmodelled: null, weatherDepends: false,
  damage: {
    rolls: Array.from({ length: 16 }, (_, k) => 5 + Math.floor(k / 8)), critRolls: Array.from({ length: 16 }, () => 10), min: 5, max: 6,
    percent: [12.5, 15], koChance: [1, 2, 3, 4].map((hits) => ({ hits, chance: 0 })),
    koExact: [1, 2, 3, 4].map((hits) => ({ hits, num: '0', den: '1' })), bounded: true, ohko: false, desc: 'Tackle: 5-6',
  },
};

/** The sheet of copy `variant` of trainer `id`: one Starly Lv 5 against Blaze and Starly, from `box()`'s save unless `savedAt` says another. */
export function sheetOf(id: string, over: { variant?: number; savedAt?: string } = {}): SheetJson {
  const t = trainerById(id);
  const enemies = [sheetMon('enemy:0', 'Starly', null, 5)];
  const players = [sheetMon('party:1', 'Monferno', 'Blaze', 15), sheetMon('party:2', 'Starly', null, 14)];
  const save = box();
  return {
    trainer: { id: t.id, name: t.name, location: t.location, battleType: t.battleType, variant: over.variant ?? 0, variants: t.variants, field: null },
    savedAt: over.savedAt ?? save.savedAt, savePath: save.savePath,
    notes: [], enemies, players,
    pairs: players.flatMap((p) => enemies.map((e) => ({
      player: p.key, enemy: e.key, field: 'No weather', order: 'player' as const, playerSpeed: 20, enemySpeed: 12, notes: [],
      playerMoves: [TACKLE], enemyMoves: [TACKLE], weatherMayPersist: false,
    }))),
  };
}
