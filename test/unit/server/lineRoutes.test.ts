// The line builder's routes (/api/line/start, node, expand, next) and POST /api/plan/step over the fixture server: request
// checks, errors, the draft, the cache and the deps. The plan service's state setter is a toy (`vi.mock`) recording its edits.

import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { AiOddsLevel, LineExpandJson, LineNodeJson, PlanFieldJson, PlanStepJson } from '../../../src/contracts/api.js';
import type { EngineState } from '../../../src/contracts/engine.js';
import type { BoxState } from '../../../src/server/box.js';
import type { LineDeps } from '../../../src/server/lines.js';
import type { PlanEdits } from '../../../src/server/plan.js';
import type { ServerData } from '../../../src/server/state.js';
import { toyResolver } from '../solver/toy/deps.js';
import type { Scenario } from '../solver/toy/scenarios.js';
import { GARDENIA_ID, TRISTAN_ID, TWINS_ID } from './fixtures.js';
import { closeServers, type Harness, start } from './harness.js';
import { mon, mv, scenario, toyLineDeps } from './lineFixtures.js';

const planned = vi.hoisted(() => ({ edits: [] as PlanEdits[] }));

vi.mock('../../../src/server/plan.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/server/plan.js')>();
  return {
    ...original,
    createPlanService: (opts: Parameters<typeof original.createPlanService>[0]) => original.createPlanService({
      ...opts,
      states: {
        set: (state: EngineState, edits) => (planned.edits.push(edits), state),
        faintEnemyActive: () => null, weather: () => 'none', trickRoom: () => false, startStages: () => ({ player: {}, enemy: {} }),
      },
    }),
  };
});

afterEach(async () => { await closeServers(); planned.edits.length = 0; });

/** Tristan as a toy fight: toy mon 1 is `party:1` (the save's Monferno), toy mon 2 `party:2` (its Starly). */
const tristan = scenario(TRISTAN_ID,
  [mon('Zero', 5, 1, [mv('Strike', [1])]), mon('Hero', 10, 10, [mv('Strike', [5]), mv('Weak', [1])]), mon('Wing', 9, 3, [mv('Peck', [1])])],
  [mon('Imp', 8, 5, [mv('Scratch', [3]), mv('Poke', [3])])]);
const foe = (id: string, extra = {}) => scenario(id, [mon('Zero', 5, 1, [mv('Strike', [1])]), mon('Hero', 10, 10, [mv('Strike', [5])])], [mon('Imp', 8, 5, [mv('Scratch', [3])])], extra);
/** `tristan` with Brute under `GARDENIA_ID` in the same registry, for a next fight. */
const two = { ...tristan, registry: { ...tristan.registry, trainers: { ...tristan.registry.trainers, ...scenario(GARDENIA_ID, [], [mon('Brute', 8, 1, [mv('Bash', [1])])]).registry.trainers } } };

/** The Pokémon the last start resolved its battle over; null until a start reaches the line service. */
let seen: ReadonlyMap<string, PlayerMon> | null = null;
/** The toy deps over `s`, recording what each start resolves, with the fight's trainer party named (the toy resolver gives none). */
const recorded = (s: Scenario = tristan): LineDeps => toyLineDeps(s, { resolver: (mons) => {
  seen = mons;
  const toy = toyResolver(s);
  const party = (s.registry.trainers[s.trainerId]?.party ?? []).map((m) => ({ name: m.name }) as ResolvedMon);
  return { ...toy, fight: (spec) => { const fight = toy.fight(spec); return { ...fight, trainer: { ...fight.trainer, party } }; } };
} });

/** A server with the fixture save chosen (and `settings` on top), `lines` as its line deps (none when null). */
async function withLines(lines: LineDeps | ((data: ServerData) => LineDeps) | null = recorded(), opts: { settings?: object; aiOdds?: AiOddsLevel } = {}): Promise<Harness> {
  seen = null;
  const h = await start({ deps: { ...(lines === null ? {} : { lines }), ...(opts.aiOdds === undefined ? {} : { aiOdds: opts.aiOdds }) } });
  expect((await call(h, 'PUT', '/api/settings', { ...h.state.settings(), savePath: h.savePath, ...opts.settings })).status).toBe(200);
  return h;
}

type Answer = LineNodeJson & LineExpandJson & { error?: string; code?: string };
async function call<T = Answer>(h: Harness, method: 'GET' | 'POST' | 'PUT', route: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${h.url}${route}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as T };
}
const START = { trainerId: TRISTAN_ID, team: ['party:1'], draft: [] };
const startLine = (h: Harness, body: unknown = START) => call(h, 'POST', '/api/line/start', body);
const expand = (h: Harness, body: unknown) => call(h, 'POST', '/api/line/expand', body);
const nodeAt = (h: Harness, line: string, node: string) => call(h, 'GET', `/api/line/node?line=${encodeURIComponent(line)}&node=${node}`);
/** Runs `[body, status, error]` rows through `send`, each answer's status and error against the row's. */
async function refusals(send: (body: unknown) => Promise<{ status: number; body: { error?: string } }>, rows: [unknown, number, unknown][]) {
  for (const [body, status, error] of rows) {
    const res = await send(body);
    expect([res.status, res.body.error], typeof body === 'string' ? body : JSON.stringify(body)).toEqual([status, error]);
  }
}

const FIELD: PlanFieldJson = {
  weather: 'none', trickRoom: false, rocks: { player: false, enemy: false },
  screens: { player: { reflect: false, lightScreen: false }, enemy: { reflect: false, lightScreen: false } },
  stages: { player: {}, enemy: {} }, enemyStatus: 'none',
};
const STATE = { player: { active: 'party:1', fainted: [] as string[] }, enemy: { active: 0, fainted: [] as number[] }, field: FIELD };
const BODY = { trainerId: TRISTAN_ID, team: ['party:1'], draft: [], state: STATE };
const plan = (h: Harness, body: unknown, method: 'GET' | 'POST' = 'POST') =>
  call<PlanStepJson & { error?: string }>(h, method, '/api/plan/step', method === 'GET' ? undefined : body);

describe('the line routes', () => {
  it('a start checks the trainer, variant, world, team and draft as the sheet does, and takes no hp, levels or startStatus', async () => {
    const h = await withLines();
    const gone = (key: string) => `${key} is no longer part of a tree start: reload the page`;
    await refusals((body) => startLine(h, body), [
      [{ ...START, trainerId: 'roark-split/nobody/1' }, 404, 'No trainer roark-split/nobody/1'], [{ ...START, variant: 1 }, 400, 'variant must be 0: Youngster Tristan has one copy'],
      [{ ...START, world: -1 }, 400, 'world must be a whole number from 0'], [{ ...START, team: ['party:1', 'party:1'] }, 400, 'team lists party:1 twice'],
      [{ ...START, team: [] }, 400, 'team is empty: list one or more MonRefs'],                      // a line needs a lead
      [{ ...START, team: ['party:1', 'box:2:1'] }, 400, 'team: there is no Pokémon at box:2:1'], [{ ...START, team: [' party:1'] }, 400, 'team: there is no Pokémon at  party:1'],
      ...[{ trainerId: undefined }, { variant: 'x' }, { world: 3 }, { team: 'party:1' }, { team: ['party:1,party:2'] }]
        .map((over): [unknown, number, unknown] => [{ ...START, ...over }, 400, expect.any(String)]),
      ['{ not json', 400, expect.any(String)],
      [{ trainerId: TRISTAN_ID, team: ['party:1'] }, 400, 'draft is required: an array of draft entries (an empty array starts the team as the save has it)'],
      ...[['hp', 'full'], ['hp', 'save'], ['levels', {}], ['startStatus', {}]].map(([key, value]): [unknown, number, unknown] => [{ ...START, [key as string]: value }, 400, gone(key as string)]),
    ]);
    // The graveyard, a ref outside the team and a bad value: refused before the line service builds anything.
    seen = null;
    await refusals((body) => startLine(h, body), [
      [{ ...START, team: ['party:1', 'box:15:1'] }, 400, 'team: box:15:1 cannot fight (in the graveyard)'],
      [{ ...START, draft: [{ ref: 'party:2' }] }, 400, 'draft: party:2 is not in the team'],
      [{ ...START, draft: [{ ref: 'party:1', hp: 0 }] }, 400, expect.stringMatching(/^draft: party:1 hp must be a whole number from 1 to \d+, not 0$/)],
      [{ ...START, draft: 'x' }, 400, 'draft must be an array'],
    ]);
    expect(seen).toBeNull();
    expect((await startLine(h)).status).toBe(200);
    // The sheet refuses a draft with the line start's own words.
    for (const draft of [[{ ref: 'party:1', hp: 0 }], [{ ref: 'party:2' }], 'x', [{ ref: 'party:1', level: 101 }]]) {
      const line = await startLine(h, { ...START, draft });
      const sheet = await call(h, 'POST', '/api/sheet', { trainer: TRISTAN_ID, team: ['party:1'], draft });
      expect([sheet.status, sheet.body.error]).toEqual([400, line.body.error]);
    }
  });

  it("a draft's values reach the line for the team's Pokémon, the others and the save untouched; one over the cap may start", async () => {
    const h = await withLines();
    expect((await startLine(h, { ...START, team: ['party:1', 'party:2'], draft: [{ ref: 'party:1', hp: 7, status: 'burn', level: 16 }] })).status).toBe(200);
    expect([seen?.get('party:1'), seen?.get('party:2')])                                        // the save's Starly as it is
      .toMatchObject([{ currentHp: 7, status: { kind: 'burn' }, level: 16, exp: 2535 }, { level: 14, status: { kind: 'none' } }]);
    await startLine(h);
    expect(seen?.get('party:1')).toMatchObject({ level: 15 });                                  // the next start sees the save again
    const capped = await withLines(recorded(), { settings: { levelCapOverride: 14 } });         // the save's Monferno is Lv 15
    const res = await startLine(capped);
    expect([(capped.state.box() as BoxState).byRef.has('party:1'), res.status, res.body.error, seen?.get('party:1')?.level]).toEqual([false, 200, undefined, 15]);
  });

  it('an expand needs the tree, the step and a choice of the right shape; an unknown line or node is LINE_LOST', async () => {
    const h = await withLines();
    const { line } = (await startLine(h)).body;
    const unnamed = 'The tree and the step are required';
    await refusals((body) => expand(h, body), [
      [{ node: 'root' }, 400, unnamed], [{ line }, 400, unnamed], [{ line, node: 'root' }, 400, expect.any(String)],
      ...[{ kind: 'move' }, { kind: 'move', slot: -1 }, { kind: 'switch', index: 'a' }, { kind: 'item', item: 'potion' }, 'move', { kind: 'dance' }]
        .map((choice): [unknown, number, unknown] => [{ line, node: 'root', choice }, 400, expect.any(String)]),
    ]);
    expect(await expand(h, { line, node: 'root', choice: { kind: 'move', slot: 9 } })).toEqual({ status: 422, body: { error: 'That choice is not legal here', code: 'BAD_CHOICE' } });
    expect(await call(h, 'GET', '/api/line/node')).toEqual({ status: 400, body: { error: unnamed } });
    const lost = { status: 404, body: { error: 'The server no longer holds this tree', code: 'LINE_LOST' } };
    expect([await nodeAt(h, 'nope', 'root'), await nodeAt(h, line, 'nope'), await expand(h, { line: 'nope', node: 'root', choice: { kind: 'move', slot: 0 } })])
      .toEqual([lost, lost, lost]);
  });

  it('every line route and the plan step: 409 before a save is chosen, 501 without the line deps, 422 for a double battle', async () => {
    const nosave = await start({ deps: { lines: toyLineDeps(tristan) } });
    const unsaved = { status: 409, body: { error: 'Choose a save first' } };
    expect([await startLine(nosave), await plan(nosave, BODY)]).toMatchObject([unsaved, unsaved]);
    const none = await withLines(null);
    const unavailable = { status: 501, body: { error: 'The tree builder is not available' } };
    expect([await startLine(none), await nodeAt(none, 'a', 'b'), await expand(none, { line: 'a', node: 'b' }), await plan(none, BODY),
      await call(none, 'POST', '/api/line/next', { line: 'a', node: 'b', trainerId: TRISTAN_ID })]).toEqual(Array(5).fill(unavailable));
    expect(await call(none, 'POST', '/api/line/levelup', { line: 'x', node: 'root' })).toEqual({ status: 404, body: { error: 'No API route POST /api/line/levelup' } });
    const twins = await withLines(recorded(foe(TWINS_ID, { trainer: { double: true } })));
    const double = { status: 422, body: { error: "Double battles can't be built yet" } };
    expect([await startLine(twins, { ...START, trainerId: TWINS_ID }), await plan(twins, { ...BODY, trainerId: TWINS_ID })]).toMatchObject([double, double]);
  });

  it('builds the deps once per data load, on first use; the other copies of a trainer are lines too', async () => {
    const loads: ServerData[] = [];
    const h = await withLines((data) => { loads.push(data); return toyLineDeps(tristan); });
    expect(loads).toHaveLength(0);
    for (let i = 0; i < 2; i += 1) await startLine(h);
    expect(loads).toEqual([h.state.data()]);
    const gardenia = await withLines(toyLineDeps(foe(GARDENIA_ID)));
    const variant = async (n: number) => (await startLine(gardenia, { ...START, trainerId: GARDENIA_ID, variant: n })).status;
    expect([await variant(1), await variant(2)]).toEqual([200, 400]);
  });

  /** A line on Tristan walked through the routes to its end, the first choice and outcome of each step: the player wins. */
  async function won(h: Harness): Promise<LineNodeJson> {
    const root = await startLine(h);
    expect(root).toMatchObject({ status: 200, body: { node: 'root', phase: 'turnChoice', turn: 1, aiOdds: { choices: [{ probability: { num: '1', den: '2' } }, {}] } } });
    let node: LineNodeJson = root.body;
    for (let i = 0; i < 20 && node.phase !== 'terminal'; i += 1) {
      const step = await expand(h, { line: node.line, node: node.node, choice: node.choices?.[0]?.choice });
      const next = await nodeAt(h, node.line, step.body.outcomes[0]!.node);
      expect([step.status, next.status, next.body.node]).toEqual([200, 200, step.body.outcomes[0]!.node]);
      node = next.body;
    }
    expect(node.terminal).toEqual({ winner: 'p1' });
    return node;
  }

  it("next answers the next trainer's root with where the team came from; it checks its body and passes the service's refusals on", async () => {
    const h = await withLines(toyLineDeps(two));
    const end = await won(h);
    const ok = { line: end.line, node: end.node, trainerId: GARDENIA_ID };
    const next = (body: unknown) => call(h, 'POST', '/api/line/next', body);
    expect(await next(ok)).toMatchObject({ status: 200, body: { node: 'root', turn: 1, carried: { fromLine: end.line, fromNode: end.node, dropped: [] }, view: { enemy: { active: { name: 'Brute' } } } } });
    await refusals(next, [
      ['"x"', 400, 'The body must be a JSON object'], [{ ...ok, heel: true }, 400, 'heel is not part of a next-fight request'],
      [{ ...ok, node: '' }, 400, 'The tree and the step are required'], [{ ...ok, trainerId: undefined }, 400, 'trainerId is required: a trainer ID'],
      [{ ...ok, trainerId: 'roark-split/nobody/1' }, 404, 'No trainer roark-split/nobody/1'],
      [{ ...ok, line: 'nope', trainerId: 'roark-split/nobody/1' }, 404, 'No trainer roark-split/nobody/1'],   // before LINE_LOST
      [{ ...ok, variant: 'x' }, 400, 'variant must be a whole number'], [{ ...ok, world: -1 }, 400, 'world must be a whole number from 0'],
      [{ ...ok, lead: 5 }, 400, 'lead must be a MonRef'], [{ ...ok, heal: 'yes' }, 400, 'heal must be true or false'],
      [{ ...ok, node: 'root' }, 422, 'Next fight starts from a fight you won: this step is not the end of one'],
    ]);
    expect((await next({ ...ok, line: 'nope' })).body).toMatchObject({ code: 'LINE_LOST' });
  });
});

/** `BODY` with `over` merged into its state's parts. */
const withState = (over: { player?: object; enemy?: object; field?: object }) => ({
  ...BODY, state: { player: { ...STATE.player, ...over.player }, enemy: { ...STATE.enemy, ...over.enemy }, field: { ...FIELD, ...over.field } },
});
/** `BODY` as JSON with its stages replaced by `stages` as written, so a key such as `__proto__` is an own key. */
const rawStages = (stages: string) => JSON.stringify(BODY).replace('"stages":{"player":{},"enemy":{}}', `"stages":${stages}`);
const stray = (key: string) => `${key} is not part of a plan step`;
const says = (field: string) => expect.stringContaining(field);

/** [body, status, error]: each refused before any work. */
const REFUSED: [unknown, number, unknown][] = [
  // The trainer, variant, world, team and draft, as a line start checks them.
  [{ ...BODY, trainerId: 'roark-split/nobody/1' }, 404, 'No trainer roark-split/nobody/1'], [{ ...BODY, trainerId: undefined }, 400, 'trainerId is required: a trainer ID'],
  [{ ...BODY, variant: 1 }, 400, 'variant must be 0: Youngster Tristan has one copy'], [{ ...BODY, world: -1 }, 400, 'world must be a whole number from 0'],
  [{ ...BODY, world: 3 }, 400, expect.stringMatching(/^world must be a whole number from 0 to 0/)], [{ ...BODY, team: [] }, 400, 'team is empty: list one or more MonRefs'],
  [{ ...BODY, team: ['party:1', 'party:1'] }, 400, 'team lists party:1 twice'], [{ ...BODY, draft: undefined }, 400, expect.stringMatching(/^draft is required/)],
  ['"x"', 400, 'The body must be a JSON object'], ['{ not json', 400, expect.any(String)],
  // A stray key at any depth, named.
  [{ ...BODY, hp: 1 }, 400, stray('hp')], [{ ...BODY, state: { ...STATE, weather: 'rain' } }, 400, stray('weather')],
  ...([
    [{ field: { stealthRock: true } }, 'stealthRock'], [{ player: { boosts: { atk: 1 } } }, 'boosts'], [{ enemy: { status: 'slp' } }, 'status'],
    [{ field: { rocks: { ...FIELD.rocks, spikes: true } } }, 'spikes'], [{ field: { screens: { ...FIELD.screens, both: true } } }, 'both'],
    [{ field: { screens: { ...FIELD.screens, enemy: { ...FIELD.screens.enemy, auroraVeil: true } } } }, 'auroraVeil'], [{ field: { stages: { ...FIELD.stages, both: {} } } }, 'both'],
  ] as [object, string][]).map(([over, key]): [unknown, number, unknown] => [withState(over), 400, stray(key)]),
  [withState({ field: { stages: { player: { hp: 1 }, enemy: {} } } }), 400, says('state.field.stages.player: hp is not a stat with a stage')],
  [withState({ field: { stages: { player: {}, enemy: 'x' } } }), 400, 'state.field.stages.enemy must be an object'],
  // A bad state, in words naming the field, never a 500.
  ...([
    [{ ...BODY, state: undefined }, 'state'], [{ ...BODY, state: 'x' }, 'state'], [{ ...BODY, state: { ...STATE, player: undefined } }, 'state.player'],
    [withState({ player: { fainted: 'party:2' } }), 'state.player.fainted'], [withState({ enemy: { fainted: 3 } }), 'state.enemy.fainted'],
    [withState({ enemy: { fainted: ['a'] } }), 'state.enemy.fainted'], [withState({ field: { rocks: undefined } }), 'state.field.rocks'],
    [withState({ field: { rocks: { player: 'x', enemy: false } } }), 'state.field.rocks.player'],
    [withState({ field: { screens: { player: {} } } }), 'state.field.screens.player.reflect'],
    [withState({ field: { screens: { ...FIELD.screens, enemy: null } } }), 'state.field.screens.enemy'],
    [withState({ field: { stages: undefined } }), 'state.field.stages'], [withState({ field: { stages: {} } }), 'state.field.stages.player'],
    [withState({ field: { trickRoom: 'yes' } }), 'state.field.trickRoom'], [withState({ field: { trickRoom: null } }), 'state.field.trickRoom'],
    [withState({ field: { enemyStatus: ['slp'] } }), 'state.field.enemyStatus'],                       // never read as its text
    // The checks the service makes, through the route.
    [withState({ enemy: { active: 5 } }), 'state.enemy.active'], [withState({ enemy: { active: 0.5 } }), 'state.enemy.active'],
    [withState({ enemy: { fainted: [-1] } }), 'state.enemy.fainted'], [withState({ player: { active: 'party:2' } }), 'state.player.active'],
    [withState({ player: { fainted: ['party:2'] } }), 'state.player.fainted'], [withState({ field: { weather: 'fog' } }), 'state.field.weather'],
    [withState({ field: { enemyStatus: 'zzz' } }), 'state.field.enemyStatus'], [withState({ field: { stages: { player: { foo: 1 }, enemy: {} } } }), 'state.field.stages.player'],
    ...['1.5', '"x"', 'null'].map((v) => [rawStages(`{"player":{"atk":${v}},"enemy":{}}`), 'state.field.stages.player.atk']),
    // A prototype name for a status or a stat: never a wrong answer or a 500.
    ...['constructor', 'toString', '__proto__', 'hasOwnProperty'].map((name) => [withState({ field: { enemyStatus: name } }), 'state.field.enemyStatus']),
    [rawStages('{"player":{"constructor":1},"enemy":{}}'), 'state.field.stages.player'], [rawStages('{"player":{},"enemy":{"__proto__":1}}'), 'state.field.stages.enemy'],
    [rawStages('{"player":{"toString":1},"enemy":{}}'), 'state.field.stages.player'],
  ] as [unknown, string][]).map(([body, field]): [unknown, number, unknown] => [body, 400, says(field)]),
];

describe('POST /api/plan/step', () => {
  it('refuses a bad body with its status and words before any work, and GET with 405', async () => {
    const h = await withLines();
    await refusals((body) => plan(h, body), REFUSED);
    expect([planned.edits.length, (await plan(h, undefined, 'GET')).status]).toEqual([0, 405]);
  });

  it("answers a step (an active in its own side's fainted is a mark; a stage outside -6..6 clamped), from its cache when it has it", async () => {
    const h = await withLines();
    const first = await plan(h, BODY);
    expect(first).toMatchObject({ status: 200, body: { phase: 'turnChoice', world: 0, field: FIELD, view: { player: { active: { name: 'Hero' } } }, aiOdds: { kind: 'turn' } } });
    expect([await plan(h, BODY), planned.edits.length]).toEqual([first, 1]);
    expect(await plan(h, withState({ player: { fainted: ['party:1'] }, enemy: { fainted: [0] } }))).toMatchObject({ status: 200, body: { phase: 'playerReplacement' } });
    const clamped = await plan(h, withState({ field: { stages: { player: { atk: 9, def: -8, spe: 3 }, enemy: { acc: -7, eva: 6 } } } }));
    expect([clamped.status, clamped.body.field.stages]).toEqual([200, { player: { atk: 6, def: -6, spe: 3 }, enemy: { acc: -6, eva: 6 } }]);
    expect(planned.edits.at(-1)!.stages).toEqual({ p1: { atk: 6, def: -6, spe: 3 }, p2: { accuracy: -6, evasion: 6 } });
    expect(await plan(h, withState({ field: { stages: { player: { atk: 6, def: -6, spe: 3 }, enemy: { acc: -6, eva: 6 } } } }))).toEqual(clamped);
    expect((await plan(h, withState({ field: { trickRoom: true } }))).status).toBe(200);
    const { trickRoom: _room, ...noRoom } = FIELD;                                    // left out: the battle start's, not false's answer
    const left = await plan(h, { ...BODY, state: { ...STATE, field: noRoom } });
    expect([left.status, left.body.field.trickRoom, planned.edits.length]).toEqual([200, false, 5]);
    const later = new Date(Date.now() + 60_000);                                     // a new savedAt: a new box
    fs.utimesSync(h.savePath, later, later);
    await h.fire();
    expect([await plan(h, BODY), planned.edits.length]).toEqual([first, 6]);
  });

  it('sends only what the AI odds level allows: full as before, likeliest and ranked the tied top moves by rank, off none', async () => {
    const full = await plan(await withLines(), BODY);
    expect(full.body.aiOdds?.choices.map((c) => [c.label, c.probability, c.percent])).toEqual([['move 1', { num: '1', den: '2' }, 50], ['move 2', { num: '1', den: '2' }, 50]]);
    const { aiOdds: _f, ...fullRest } = full.body;
    const ranked = { kind: 'turn', choices: [{ label: 'move 1', rank: 1 }, { label: 'move 2', rank: 1 }] };
    for (const [aiOdds, expected] of [['likeliest', ranked], ['ranked', ranked], ['off', undefined]] as const) {
      const { status, body: { aiOdds: got, ...others } } = await plan(await withLines(recorded(), { aiOdds }), BODY);
      expect([status, got, others], aiOdds).toEqual([200, expected, fullRest]);
    }
  });
});
