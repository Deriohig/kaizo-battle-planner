// The line builder's service (src/server/lines.ts) over the solver's toy engine and toy AI (lineFixtures.ts): the root,
// a step's outcomes and their exact odds, the store, the errors, EXP and rolls, and the next fight a won node leads to.

import { describe, expect, it, vi } from 'vitest';
import type { LineExpandJson, LineNodeJson, LineRationalJson } from '../../../src/contracts/api.js';
import type { BattleInput, ChanceLabel, Choice, Engine } from '../../../src/contracts/engine.js';
import { HttpError } from '../../../src/server/http.js';
import { createLineService, FULL_CARRY, type LineDeps, type LineNextQuery, type LineStartQuery } from '../../../src/server/lines.js';
import { add, eq, mul, ONE, rat, ZERO } from '../../../src/solver/rational.js';
import type { Scenario } from '../solver/toy/scenarios.js';
import { disputed, doubles, duel, frail, gauntlet, mon, mv, refsOf, replacement, scenario, spareDuel, toyData, toyLineDeps, undefinedAi, uturn } from './lineFixtures.js';

const move = (slot: number): Choice => ({ kind: 'move', slot });
const swap = (index: number): Choice => ({ kind: 'switch', index });
const frac = (r: LineRationalJson) => `${r.num}/${r.den}`;
const ratOf = (r: LineRationalJson) => rat(BigInt(r.num), BigInt(r.den));
const sumsToOne = (parts: LineRationalJson[]) => eq(parts.reduce((s, p) => add(s, ratOf(p)), ZERO), ONE);

function setup(s: Scenario, opts: { deps?: Partial<LineDeps>; maxNodes?: number; team?: string[] } = {}) {
  const data = toyData();
  const service = createLineService({ deps: () => toyLineDeps(s, opts.deps), ...(opts.maxNodes === undefined ? {} : { maxNodes: opts.maxNodes }) });
  const node = (line: string, id: string) => service.node(data, line, id);
  const expand = (from: LineNodeJson | LineExpandJson, choice?: Choice) => service.expand(data, from.line, from.node, choice);
  return {
    data, service, node, expand,
    start: (over: Partial<LineStartQuery> = {}) => service.start({ data, mons: new Map(), trainerId: s.trainerId, variant: 0, team: opts.team ?? refsOf(s), world: 0, ...over }),
    /** The node outcome `k` of `choice` from `from` leads to. */
    step: async (from: LineNodeJson, choice?: Choice, k = 0) => node(from.line, (await expand(from, choice)).outcomes[k]!.node),
    next: (from: LineNodeJson, over: Partial<LineNextQuery> = {}) => service.next({ data, line: from.line, node: from.node, trainerId: 'second', variant: 0, world: 0, heal: false, ...over }),
  };
}
type T = ReturnType<typeof setup>;

/** The first legal choice and the first outcome of each step, to the end of the fight. */
async function toEnd(t: T, from: LineNodeJson): Promise<LineNodeJson> {
  let node = from;
  for (let i = 0; i < 20 && node.phase !== 'terminal'; i += 1) node = await t.step(node, node.choices?.[0]?.choice);
  return node;
}
const party = (n: LineNodeJson) => n.view.player.party.map((m) => [m.name, m.hp, m.maxHp]);
/** One scenario holding several fights' trainers, starting at the first. */
const joined = (...fights: Scenario[]): Scenario =>
  ({ ...fights[0]!, registry: { ...fights[0]!.registry, trainers: Object.assign({}, ...fights.map((f) => f.registry.trainers)) } });

/** Zed and Amy (2 HP, slower than Imp: one Scratch fells either) and Hero against `first` (Imp), `second` (Brute), `third` (Ogre). */
const zah = [mon('Zed', 2, 1, [mv('Tap', [1])]), mon('Amy', 2, 1, [mv('Tap', [1])]), mon('Hero', 10, 5, [mv('Strike', [5])])];
const chain = joined(scenario('first', zah, [mon('Imp', 5, 20, [mv('Scratch', [3])])]),
  scenario('second', zah, [mon('Brute', 8, 1, [mv('Bash', [1])])]), scenario('third', zah, [mon('Ogre', 30, 20, [mv('Smash', [20])])]));

/** The engine of `s` with its `expandTurn` outcomes changed by `edit`. */
const editOutcomes = (s: Scenario, edit: (o: ReturnType<Engine['expandTurn']>[number]) => ReturnType<Engine['expandTurn']>[number]): Engine => {
  const real = toyLineDeps(s).engine;
  return { ...real, expandTurn: (...args: Parameters<Engine['expandTurn']>) => real.expandTurn(...args).map(edit) };
};

describe('start', () => {
  it("the root: his Pokémon on their own HP, the AI's exact odds, his choices; the team's first leads; disputed values' worlds", async () => {
    const root = await setup(duel).start();
    expect(root).toMatchObject({
      node: 'root', turn: 1, phase: 'turnChoice', dead: false, unmodelled: [], world: 0, pathPercent: 100,
      pathProbability: { num: '1', den: '1' }, aiOdds: { kind: 'turn' },
    });
    expect([root.worlds, root.terminal, root.view.player.active, root.view.enemy.active])
      .toMatchObject([undefined, undefined, { name: 'Hero', hp: 10, maxHp: 10 }, { name: 'Imp', hp: 8 }]);
    expect(root.aiOdds?.choices.map((c) => [c.label, frac(c.probability!), c.percent])).toEqual([['move 1', '1/2', 50], ['move 2', '1/2', 50]]);
    expect(root.choices).toEqual([{ choice: move(0), label: 'Use move 1' }, { choice: move(1), label: 'Use move 2' }]);
    const led = await setup(frail, { team: ['party:1', 'party:0'] }).start();
    const real = toyLineDeps(duel);
    const seen: BattleInput[] = [];
    const base = real.resolver(new Map());
    await setup(duel, { deps: {
      engine: { ...real.engine, createBattle: (input) => { seen.push(input); return real.engine.createBattle(input); } },
      resolver: () => ({ ...base, mon: (ref) => { const info = base.mon(ref); return { ...info, maxHp: 10, mon: { ...info.mon, currentHp: 3 } }; } }),
    } }).start();
    const t = setup(disputed);
    const first = await t.start();
    expect([first.worlds, first.view.enemy.active?.maxHp])
      .toEqual([[{ index: 0, label: 'Pokémon 1: Hardy' }, { index: 1, label: 'Pokémon 1: Lonely' }], 3]);
    const second = await t.start({ world: 1 });
    expect([second.world, second.view.enemy.active?.maxHp]).toEqual([1, 6]);
    await expect(t.start({ world: 2 })).rejects.toMatchObject({ status: 400 });
  });
});

describe('expand', () => {
  it("every outcome over every AI action, its odds the action's times its own (1 in all), with stable ids, each leading to its node", async () => {
    const [t, u] = [setup(duel), setup(duel)];
    const root = await t.start();
    const step = await t.expand(root, move(0));
    expect(step.choice).toEqual(move(0));
    expect(step.outcomes.map((o) => [o.aiAction, frac(o.probability), o.percent, o.enemyCrit])).toEqual([
      ['move 1', '3/8', 37.5, false], ['move 1', '1/8', 12.5, true], ['move 2', '1/2', 50, false],
    ]);
    expect(step.groups.map((g) => [g.aiAction, frac(g.probability), g.percent])).toEqual([['move 1', '1/2', 50], ['move 2', '1/2', 50]]);
    expect(sumsToOne(step.outcomes.map((o) => o.probability))).toBe(true);
    expect([step.totals.enemyCrit, step.totals.death, step.totals.enemyFaints].map(frac)).toEqual(['1/8', '0/1', '0/1']);
    const [normal, crit] = step.outcomes;
    expect(normal).toMatchObject({
      death: false, faints: { p1: [], p2: [] }, unlabelled: false,
      summary: expect.arrayContaining(['Hero moves first (Strike)', 'Imp loses 62.5% (37.5% left)']),
      endHp: { p1: { name: 'Hero', hp: 7, maxHp: 10, percent: 70 }, p2: { name: 'Imp', hp: 3, maxHp: 8, percent: 37.5 } },
    });
    expect(crit!.endHp.p1).toEqual({ name: 'Hero', hp: 4, maxHp: 10, percent: 40 });
    expect(step.outcomes.map((o) => [o.id, o.node])).toEqual((await u.expand(await u.start(), move(0))).outcomes.map((o) => [o.id, o.node]));
    expect([new Set(step.outcomes.map((o) => o.id)).size, normal!.id]).toEqual([3, expect.stringMatching(/^[0-9a-f]{12}$/)]);
    expect([root, ...step.outcomes].flatMap((x) => ['seen', 'levelUp', 'upStep'].filter((key) => key in x))).toEqual([]);   // nothing for a plan
    expect(await Promise.all(step.outcomes.map(async (o) => (await t.node(root.line, o.node)).phase))).toEqual(step.outcomes.map((o) => o.next));
    expect(await t.node(root.line, normal!.node)).toMatchObject({ node: normal!.node, turn: 2, phase: 'turnChoice', dead: false, pathProbability: { num: '3', den: '8' } });
    const two = await t.expand(await t.node(root.line, crit!.node), move(0));       // the path's odds multiply down the line
    const [deeper, p] = [await t.node(root.line, two.outcomes[0]!.node), two.outcomes[0]!.probability];
    expect([eq(ratOf(deeper.pathProbability), mul(ratOf(p), rat(1n, 8n))), deeper.pathPercent])
      .toEqual([true, expect.closeTo((Number(p.num) / Number(p.den)) * 12.5, 6)]);
  });

  it('a fight that ends is terminal with its winner, on the node and the outcome; a faint of his is a death, and he may go on', async () => {
    const t = setup(duel);
    let node: LineNodeJson = await t.start();
    let last: LineExpandJson['outcomes'][number] | undefined;
    while (node.phase !== 'terminal') {
      last = (await t.expand(node, move(0))).outcomes[0]!;
      node = await t.node(node.line, last.node);
    }
    expect([node.terminal, node.choices, last]).toMatchObject([{ winner: 'p1' }, undefined, { next: 'terminal', winner: 'p1' }]);
    await expect(t.expand(node)).rejects.toMatchObject({ status: 422 });
    const lone = setup(frail, { team: ['party:0'] });
    expect((await lone.expand(await lone.start(), move(0))).outcomes[0]).toMatchObject({ death: true, next: 'terminal', winner: 'p2' });
    // With a bench: playerReplacement, dead from there on.
    const f = setup(frail);
    const step = await f.expand(await f.start(), move(0));
    expect([step.outcomes, frac(step.totals.death)]).toMatchObject([[{ death: true, faints: { p1: ['Hero'], p2: [] } }], '1/1']);
    const replaced = await f.node(step.line, step.outcomes[0]!.node);
    expect([replaced.phase, replaced.dead, replaced.choices, replaced.aiOdds])
      .toEqual(['playerReplacement', true, [{ choice: swap(1), label: 'Switch to party 2' }], undefined]);
    expect(await f.step(replaced, swap(1))).toMatchObject({ phase: 'turnChoice', dead: true, turn: 2, view: { player: { active: { name: 'Backup' } } } });
  });

  it("after an enemy KO the AI's send-out takes no choice, an outcome each; his own mid-turn switch takes his choice alone", async () => {
    const t = setup(replacement);
    const ko = await t.expand(await t.start(), move(0));
    expect([ko.outcomes.map((o) => o.faints.p2), frac(ko.totals.enemyFaints)]).toEqual([[['Imp']], '1/1']);
    const waiting = await t.node(ko.line, ko.outcomes[0]!.node);
    expect([waiting.phase, waiting.choices, waiting.aiOdds?.kind, waiting.aiOdds?.choices.map((c) => [c.label, frac(c.probability!)])])
      .toEqual(['enemyReplacement', undefined, 'replacement', [['party 2', '1/2'], ['party 3', '1/2']]]);
    const sent = await t.expand(waiting);
    expect(sent.outcomes.map((o) => [o.aiAction, frac(o.probability)])).toEqual([['party 2', '1/2'], ['party 3', '1/2']]);
    expect(await t.node(ko.line, sent.outcomes[0]!.node)).toMatchObject({ phase: 'turnChoice', turn: 2, view: { enemy: { active: { name: 'Mouse' } } } });
    const v = setup(uturn);
    const paused = await v.step(await v.start(), move(0));
    expect([paused.phase, paused.choices, paused.aiOdds])
      .toEqual(['playerMidTurnSwitch', [{ choice: swap(1), label: 'Switch to party 2' }], undefined]);
    const after = await v.expand(paused, swap(1));
    expect(after.outcomes.map((o) => o.aiAction)).toEqual([null]);
    expect(await v.node(paused.line, after.outcomes[0]!.node)).toMatchObject({ phase: 'turnChoice', turn: 2, view: { player: { active: { name: 'Tank', hp: 13 } } } });
  });
});

describe('errors and the store', () => {
  const AI_UNDEFINED = "The AI's behaviour is undefined here (DIV_ZERO: toy: undefined behaviour)";
  const LOST = { status: 404, code: 'LINE_LOST', message: 'The server no longer holds this tree' };

  it("refuses what it cannot build or walk, with its status, code and words; an AI error is a node's aiError, its choices listed", async () => {
    const aiRoot = await setup(undefinedAi).start();
    expect([aiRoot.aiOdds, aiRoot.aiError, aiRoot.choices?.length]).toEqual([undefined, AI_UNDEFINED, 1]);
    const toy = toyLineDeps(duel);
    const with_ = (deps: Partial<LineDeps>) => setup(duel, { deps });
    const throwing = (error: Error) => with_({ engine: { ...toy.engine, expandTurn: () => { throw error; } } });
    const coded = (message: string, code: string) => Object.assign(new Error(message), { code });
    const t = setup(duel);
    const root = await t.start();
    const expandRoot = async (u: T, choice: Choice | undefined = move(0)) => u.expand(await u.start(), choice);
    const cases: [string, () => Promise<unknown>, object][] = [
      ['a double battle', () => setup(doubles).start(), { status: 422, message: "Double battles can't be built yet" }],
      ['an empty team', () => t.start({ team: [] }), { status: 400 }],
      ['a team listing one twice', () => t.start({ team: ['party:0', 'party:0'] }), { status: 400 }],
      ['a ref the scenario lacks', () => t.start({ team: ['party:7'] }), { status: 400 }],
      ['an unknown trainer', () => t.start({ trainerId: 'nobody' }), { status: 404 }],
      ['no choice where he decides', () => t.expand(root), { status: 400 }],
      ['an illegal move', () => t.expand(root, move(9)), { status: 422, code: 'BAD_CHOICE', message: 'That choice is not legal here' }],
      ['an illegal switch', () => t.expand(root, swap(1)), { status: 422 }],
      ['an AI error at a step', () => expandRoot(setup(undefinedAi)), { status: 422, code: 'AI_UNDEFINED', message: AI_UNDEFINED }],
      ['an AI error at the start', () => with_({ model: { ...toy.model, initialMemory: () => { throw coded('no memory', 'DIV_ZERO'); } } }).start(),
        { status: 422, code: 'AI_UNDEFINED', message: "The AI's behaviour is undefined here (DIV_ZERO: no memory)" }],
      ['a battle the engine will not build', () => with_({ engine: { ...toy.engine, createBattle: () => { throw new RangeError('Both sides need at least one Pokémon'); } } }).start(),
        { status: 422, code: 'BAD_START', message: 'Both sides need at least one Pokémon' }],
      ...['LIMIT', 'BAD_CHOICE', 'UNMODELLED_ITEM', 'UNSUPPORTED_DOUBLE'].map((code): [string, () => Promise<unknown>, object] =>
        [`an engine ${code}`, () => expandRoot(throwing(coded(`engine says ${code}`, code))), { status: 422, code, message: `engine says ${code}` }]),
      ['an unknown line', () => t.node('nope', 'root'), LOST],
      ['an unknown node', () => t.node(root.line, 'nope'), LOST],
      ['an expand of an unknown line', () => t.service.expand(t.data, 'nope', 'root', move(0)), LOST],
      ['an expand of an unknown node', () => t.service.expand(t.data, root.line, 'nope', move(0)), LOST],
      ['any line after a data reload', () => t.service.node(toyData(), root.line, 'root'), LOST],
    ];
    for (const [name, run, expected] of cases) {
      const error = await run().catch((e: unknown) => e);
      expect(error, name).toBeInstanceOf(HttpError);
      expect(error, name).toMatchObject(expected);
    }
    await expect(expandRoot(throwing(new TypeError('a bug')))).rejects.toBeInstanceOf(TypeError);   // any other error is not hidden
    const u = setup(duel);
    const starting = u.start();                                                        // a data reload during a start
    await u.service.node(toyData(), 'nope', 'root').catch(() => undefined);
    await expect(starting).rejects.toMatchObject(LOST);
  });

  it('the store answers an expand again without the engine; past the node cap the line used least lately goes; one line over it is TOO_BIG', async () => {
    const real = toyLineDeps(duel);
    const expandTurn = vi.fn(real.engine.expandTurn.bind(real.engine));
    const spied = setup(duel, { deps: { engine: { ...real.engine, expandTurn } } });
    const spiedRoot = await spied.start();
    const first = await spied.expand(spiedRoot, move(0));
    const calls = expandTurn.mock.calls.length;
    expect([await spied.expand(spiedRoot, move(0)), expandTurn.mock.calls.length]).toEqual([first, calls]);
    await spied.expand(spiedRoot, move(1));
    expect(expandTurn.mock.calls.length).toBeGreaterThan(calls);
    const t = setup(duel, { maxNodes: 2 });
    const held = async (line: string) => (await t.node(line, 'root').catch(() => null))?.node ?? 'lost';
    const a = await t.start();
    const b = await t.start();
    await t.node(b.line, 'root');
    const c = await t.start();
    expect([await held(a.line), await held(b.line), await held(c.line)]).toEqual(['lost', 'root', 'root']);
    await t.node(b.line, 'root');
    await t.start();
    expect([await held(b.line), await held(c.line)]).toEqual(['root', 'lost']);
    const small = setup(duel, { maxNodes: 3 });
    const root = await small.start();
    await expect(small.expand(root, move(0))).rejects.toMatchObject({
      status: 422, code: 'TOO_BIG', message: 'This tree is too big for the server to keep (over 3 steps): clear it and start again',
    });
    expect((await small.node(root.line, 'root')).node).toBe('root');
  });
});

describe('what an outcome and a node carry', () => {
  it('damage numbers on a turnChoice node only, from its own state and named by his page name; a signature is all the player sees', async () => {
    const numbers = (against: string) => ({ yours: [], theirs: [], against, order: null });
    const states: string[] = [];
    const damage = () => (state: { key: string }) => { states.push(state.key); return numbers('toy'); };
    const t = setup(replacement, { deps: { damage } as Partial<LineDeps> });
    const root = await t.start();
    const waiting = await t.step(root, move(0));
    expect([root.damage, waiting.phase, waiting.damage, states.length]).toEqual([numbers('Hero'), 'enemyReplacement', undefined, 1]);
    expect((await setup(duel).start()).damage).toBeUndefined();
    // A signature: the same with another bench, different when the action, a crit or a death differ.
    const alone = setup(spareDuel, { team: ['party:0'] });
    const withSpare = setup(spareDuel, { team: ['party:0', 'party:1'] });
    const a = (await alone.expand(await alone.start(), move(0))).outcomes;
    const b = (await withSpare.expand(await withSpare.start(), move(0))).outcomes;
    expect(a.map((o) => o.signature)).toEqual(b.map((o) => o.signature));
    expect(a.map((o) => o.id)).not.toEqual(b.map((o) => o.id));
    expect(new Set(a.map((o) => o.signature)).size).toBe(3);                           // move 1, its crit, move 2
    expect(['Hero moves first (Strike)', 'move 1'].filter((part) => !a[0]!.signature.includes(part))).toEqual([]);
    const f = setup(frail);
    expect((await f.expand(await f.start(), move(0))).outcomes[0]!.signature).toMatch(/death/);
  });

  it('a knockout lists the EXP the engine paid, its signature unchanged; rolls are named through moveName; his party shows EXP to the next level', async () => {
    const paying = editOutcomes(replacement, (o) => (o.fainted.p2.length > 0 ? { ...o, log: [...o.log, '|-kaizoexp|p1a: Hero|7'] } : o));
    const t = setup(replacement, { deps: { engine: paying } });
    const plain = setup(replacement);
    const root = await t.start();
    const [ko] = (await t.expand(root, move(0))).outcomes;
    const [plainKo] = (await plain.expand(await plain.start(), move(0))).outcomes;
    expect(ko).toMatchObject({ exp: [{ index: 0, name: 'Hero', gained: 7, boosted: false, fromLevel: 1, toLevel: 1, learned: [], offered: [] }], rolls: [] });
    expect([ko!.signature, ko!.summary, plainKo!.exp]).toEqual([plainKo!.signature, plainKo!.summary, []]);
    const labels: ChanceLabel[] = [{ kind: 'roll', side: 'p1', source: 'aquacutter', outcome: '23', rollValue: 'base' }, { kind: 'roll', side: 'p2', source: 'tackle', outcome: '≥hp', rollValue: 'final' }];
    const rolls = async (deps: Partial<LineDeps>) => { const r = setup(replacement, { deps }); return (await r.expand(await r.start(), move(0))).outcomes[0]!.rolls; };
    const rolling = editOutcomes(replacement, (o) => ({ ...o, labels }));
    expect(await rolls({ engine: rolling, moveName: (id) => `Move ${id}` })).toEqual([
      { side: 'p1', move: 'Move aquacutter', damage: 23, rollValue: 'base' }, { side: 'p2', move: 'Move tackle', damage: null, rollValue: 'final' },
    ]);
    const real = toyLineDeps(replacement).engine;
    const carryOut = () => ({ mons: [{ hp: 10, pp: [], status: { kind: 'none' as const }, exp: 40 }] });
    const expToNext = (_mon: unknown, level: number, exp: number) => 100 - exp - level;
    const known = (await setup(replacement, { deps: { expToNext, engine: { ...real, carryOut } } }).start()).view;
    const [unknown, none] = [(await setup(replacement, { deps: { expToNext } }).start()).view, (await plain.start()).view];
    expect([known.player.party[0]!.expToNext, 'expToNext' in known.enemy.party[0]!, 'expToNext' in none.player.party[0]!, unknown.player.party[0]!.expToNext])
      .toEqual([59, false, false, null]);
  });
});

describe('the next fight', () => {
  const LEAD_ERROR = (refs: string) => ({ status: 400, message: `lead must be one of the Pokémon that carry over: ${refs}` });
  /** `gauntlet`'s engine recording each battle input; the toy engine has no carry of its own, so it builds without one. */
  function recording(over: Partial<Engine> = {}) {
    const toy = toyLineDeps(gauntlet).engine;
    const seen: BattleInput[] = [];
    const engine: Engine = { ...toy, ...over, createBattle: (input) => { seen.push(input); const { carry: _carry, ...rest } = input; return toy.createBattle(rest); } };
    return { engine, seen };
  }

  it('carries the won team into the next trainer: the HP the fight left, a fresh root, and where it came from', async () => {
    const t = setup(gauntlet);
    const won = await toEnd(t, await t.start());
    const next = await t.next(won);
    expect([won.terminal, next.line === won.line]).toEqual([{ winner: 'p1' }, false]);
    expect(next).toMatchObject({ node: 'root', turn: 1, phase: 'turnChoice', dead: false, pathPercent: 100, carried: { fromLine: won.line, fromNode: won.node, dropped: [] } });
    expect([party(next), next.view.enemy.active?.name]).toEqual([[['Hero', 7, 10], ['Frail', 2, 2]], 'Brute']);
    expect((await t.expand(next, move(0))).outcomes.length).toBeGreaterThan(0);
    // The new root keeps where it came from; the won line is still held, and carries nothing itself.
    expect([(await t.node(next.line, 'root')).carried, (await t.node(won.line, won.node)).terminal, (await t.node(won.line, 'root')).carried])
      .toEqual([next.carried, { winner: 'p1' }, undefined]);
    const led = await t.next(won, { lead: 'party:1' });
    expect([party(led), led.view.player.active?.name]).toEqual([[['Frail', 2, 2], ['Hero', 7, 10]], 'Frail']);
  });

  it("a fainted Pokémon is left behind and named, and cannot lead, healed or not; two are named in the won fight's order, not as they fell", async () => {
    const { engine, seen } = recording();
    const g = setup(gauntlet, { deps: { engine }, team: ['party:1', 'party:0'] });     // Frail leads and falls; Hero wins
    const won = await toEnd(g, await g.start());
    expect([won.terminal, won.dead]).toEqual([{ winner: 'p1' }, true]);
    const next = await g.next(won);
    expect([next.carried!.dropped, next.view.player.party.map((m) => m.name), next.dead]).toEqual([['Frail'], ['Hero'], false]);
    const healed = await g.next(won, { heal: true });
    expect([healed.carried!.dropped, seen.at(-1)!.player.map((p) => p.nickname), seen.at(-1)!.carry!.mons.map((m) => m.hp)]).toEqual([['Frail'], ['Hero'], [FULL_CARRY]]);
    for (const heal of [false, true]) await expect(g.next(won, { heal, lead: 'party:1' })).rejects.toMatchObject(LEAD_ERROR('party:0'));
    const t = setup(chain);
    let node = await t.start();
    // Zed switches Amy in and she falls; Zed comes back and falls; Hero wins.
    for (const choice of [swap(1), swap(0), move(0), swap(2), move(0)]) node = await t.step(node, choice);
    const after = await t.next(node);
    expect([node.terminal, node.dead, after.carried!.dropped, party(after)]).toEqual([{ winner: 'p1' }, true, ['Zed', 'Amy'], [['Hero', 7, 10]]]);
  });

  it("the carry is the engine's, whole; a heal fills HP and PP and clears the status, and keeps item, EXP and moves", async () => {
    const toy = toyLineDeps(gauntlet).engine;
    const { engine, seen } = recording({
      carryOut: (state) => ({ mons: toy.carryOut(state).mons.map((m, i) => ({ ...m, status: { kind: 'burn' as const }, item: 7 + i, exp: 100 + i, moves: [1, 2] })) }),
    });
    const t = setup(gauntlet, { deps: { engine } });
    const won = await toEnd(t, await t.start());
    await t.next(won);
    await t.next(won, { heal: true, lead: 'party:1' });
    const [, plain, healed] = seen.map((input) => input.carry!.mons);
    expect(plain).toEqual([0, 1].map((i) => ({ hp: [7, 2][i], pp: expect.any(Array), status: { kind: 'burn' }, item: 7 + i, exp: 100 + i, moves: [1, 2] })));
    expect(healed!.map((m) => [m.hp, m.status, m.item, m.exp, m.moves])).toEqual([[FULL_CARRY, { kind: 'none' }, 8, 101, [1, 2]], [FULL_CARRY, { kind: 'none' }, 7, 100, [1, 2]]]);
    expect(healed!.every((m, i) => m.pp.length === plain![1 - i]!.pp.length && m.pp.every((pp) => pp === FULL_CARRY))).toBe(true);
    expect(seen[2]!.startStatus).toBeUndefined();
  });

  it('refuses a step that is not a won end, a double, an unknown trainer, a bad world, a lost line and an end the engine cannot carry', async () => {
    const t = setup(gauntlet);
    const root = await t.start();
    const won = await toEnd(t, root);
    const lost = await toEnd(t, await t.start({ trainerId: 'bully' }));
    expect(lost.terminal).toEqual({ winner: 'p2' });
    const NOT_WON = { status: 422, message: 'Next fight starts from a fight you won: this step is not the end of one' };
    const toy = toyLineDeps(gauntlet).engine;
    const uncarried = setup(gauntlet, { deps: { engine: { ...toy, carryOut: () => { throw new Error('no UndrawnSleep carries that'); } } } });
    const uncarriedEnd = await toEnd(uncarried, await uncarried.start());
    const cases: [() => Promise<unknown>, object][] = [
      [() => t.next(root), NOT_WON], [() => t.next(lost), NOT_WON],
      [() => t.next(won, { trainerId: 'pair' }), { status: 422, message: "Double battles can't be built yet" }],
      [() => t.next(won, { trainerId: 'nobody' }), { status: 404 }], [() => t.next(won, { world: 3 }), { status: 400 }],
      [() => t.next({ ...won, node: 'nope' }), { status: 404, code: 'LINE_LOST' }],
      [() => t.service.next({ data: toyData(), line: won.line, node: won.node, trainerId: 'second', variant: 0, world: 0, heal: false }), { status: 404, code: 'LINE_LOST' }],
      [() => uncarried.next(uncarriedEnd), { status: 422, message: "This fight's end cannot be carried over: no UndrawnSleep carries that" }],
    ];
    for (const [run, expected] of cases) await expect(run()).rejects.toMatchObject(expected);
  });

  it("a carried line goes on to a third fight: refs map through the carried line's own team, after a reordered lead and a member left behind", async () => {
    const t = setup(chain, { team: ['party:2', 'party:1', 'party:0'] });                // Hero leads; party:0 is Zed, party:1 Amy
    const won = await toEnd(t, await t.start());
    expect([won.terminal, party(won)]).toEqual([{ winner: 'p1' }, [['Hero', 7, 10], ['Amy', 2, 2], ['Zed', 2, 2]]]);
    const second = await t.next(won, { lead: 'party:1' });                              // Amy first, then the won fight's order
    expect([party(second), second.view.player.active?.name]).toEqual([[['Amy', 2, 2], ['Hero', 7, 10], ['Zed', 2, 2]], 'Amy']);
    const won2 = await toEnd(t, second);                                                 // Amy falls to Brute; Hero comes in and wins
    expect([won2.terminal, won2.dead, party(won2)]).toEqual([{ winner: 'p1' }, true, [['Amy', 0, 2], ['Hero', 6, 10], ['Zed', 2, 2]]]);
    const third = await t.next(won2, { trainerId: 'third' });
    expect(party(third)).toEqual([['Hero', 6, 10], ['Zed', 2, 2]]);
    expect(third).toMatchObject({ node: 'root', dead: false, pathPercent: 100, carried: { fromLine: second.line, fromNode: won2.node, dropped: ['Amy'] } });
    const zedFirst = await t.next(won2, { trainerId: 'third', lead: 'party:0' });
    expect([party(zedFirst), zedFirst.view.player.active?.name]).toEqual([[['Zed', 2, 2], ['Hero', 6, 10]], 'Zed']);
    await expect(t.next(won2, { trainerId: 'third', lead: 'party:1' })).rejects.toMatchObject(LEAD_ERROR('party:2, party:0'));
  });
});
