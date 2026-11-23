// The plan step service (src/server/plan.ts) over the line tests' toy deps, with a toy stand-in for the Showdown state
// setter (checked on real data in test/real): the inputs on the built state, the phase, send-outs, counters, errors, odds levels.

import { describe, expect, it } from 'vitest';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { AiOddsLevel, LineDamageJson, LineNodeJson, PlanFieldJson, PlanStepJson, PlanStepStateJson } from '../../../src/contracts/api.js';
import type { BattleInput, EngineState, FieldSpec, Rational } from '../../../src/contracts/engine.js';
import type { LineDeps } from '../../../src/server/lines.js';
import { createPlanService, type PlanEdits, type PlanStates, type PlanStepQuery } from '../../../src/server/plan.js';
import { add, eq, ONE, rat, ZERO } from '../../../src/solver/rational.js';
import { toyResolver } from '../solver/toy/deps.js';
import { readToyState, type ToyState } from '../solver/toy/engine.js';
import type { Scenario } from '../solver/toy/scenarios.js';
import { doubles, duel, frail, mon, mv, replacement, scenario, spareDuel, toyData, toyLineDeps } from './lineFixtures.js';

const FIELD: PlanFieldJson = {
  weather: 'none', trickRoom: false, rocks: { player: false, enemy: false },
  screens: { player: { reflect: false, lightScreen: false }, enemy: { reflect: false, lightScreen: false } },
  stages: { player: {}, enemy: {} }, enemyStatus: 'none',
};
const frac = (r: { num: string; den: string }) => `${r.num}/${r.den}`;
const toyEngineState = (s: ToyState): EngineState => ({ json: JSON.stringify(s), turn: s.turn, phase: { ...s.phase }, key: JSON.stringify(s) });

/** The toy setter: records every edit, puts their active in place, marks the fainted and sets their active's sleep counter. */
function toyStates(log: PlanEdits[], opts: Partial<Pick<PlanStates, 'weather' | 'trickRoom' | 'startStages'>>): PlanStates {
  return {
    set(state, edits) {
      log.push(edits);
      const s = readToyState(state);
      s.active.p2 = edits.enemyActive;
      for (const i of edits.fainted.p1) Object.assign(s.p1[i]!, { hp: 0, fainted: true });
      for (const i of edits.fainted.p2) Object.assign(s.p2[i]!, { hp: 0, fainted: true });
      s.p2[s.active.p2]!.sleep = edits.enemyStatus.kind === 'sleep' ? edits.enemyStatus.turns : 0;
      return toyEngineState(s);
    },
    faintEnemyActive(state) {
      const s = readToyState(state);
      if (!s.p2.some((m, i) => i !== s.active.p2 && !m.fainted)) return null;
      Object.assign(s.p2[s.active.p2]!, { hp: 0, fainted: true });
      s.phase = { kind: 'enemyReplacement' };
      return toyEngineState(s);
    },
    weather: opts.weather ?? (() => 'none'), trickRoom: opts.trickRoom ?? (() => false), startStages: opts.startStages ?? (() => ({ player: {}, enemy: {} })),
  };
}

type Over = Partial<Pick<PlanStepQuery, 'team' | 'world' | 'trainerId' | 'signal'>> & {
  player?: Partial<PlanStepStateJson['player']>; enemy?: Partial<PlanStepStateJson['enemy']>; field?: Partial<PlanStepStateJson['field']>;
};

/** The service over `s`'s toy deps, the trainer's party named in the resolver's fight, `field` its field, every input recorded. */
function setup(s: Scenario, opts: Partial<Pick<PlanStates, 'weather' | 'trickRoom' | 'startStages'>> & { deps?: Partial<LineDeps>; field?: FieldSpec; aiOdds?: AiOddsLevel } = {}) {
  const edits: PlanEdits[] = [];
  const inputs: BattleInput[] = [];
  const base = toyLineDeps(s, opts.deps);
  const party = (s.registry.trainers[s.trainerId]?.party ?? []).map((m) => ({ name: m.name }) as ResolvedMon);
  const deps: LineDeps = {
    ...base,
    engine: { ...base.engine, createBattle: (input) => (inputs.push(input), base.engine.createBattle(input)) },
    resolver: () => {
      const toy = toyResolver(s);
      return { mon: toy.mon, fight: (spec) => { const fight = toy.fight(spec); return { ...fight, trainer: { ...fight.trainer, party }, field: opts.field ?? fight.field }; } };
    },
  };
  const service = createPlanService({ deps: () => deps, states: toyStates(edits, opts), ...(opts.aiOdds === undefined ? {} : { aiOdds: opts.aiOdds }) });
  const data = toyData();
  const step = (over: Over = {}): Promise<PlanStepJson> => {
    const team = over.team ?? s.p1.map((_, i) => `party:${i}`);
    return service.step({
      data, mons: new Map(), team, trainerId: over.trainerId ?? s.trainerId, variant: 0, world: over.world ?? 0, ...(over.signal === undefined ? {} : { signal: over.signal }),
      state: { player: { active: team[0]!, fainted: [], ...over.player }, enemy: { active: 0, fainted: [], ...over.enemy }, field: { ...FIELD, ...over.field } },
    });
  };
  return { edits, inputs, step };
}

/** Seven Pokémon of his against Imp. */
const six = scenario('six', ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name, i) => mon(name, 10, 10 - i, [mv('Tap', [1])])), [mon('Imp', 8, 5, [mv('Scratch', [3])])]);
const kinds = (step: PlanStepJson) => step.choices.map((c) => c.choice);
const sleepy = (s: Scenario): Partial<LineDeps> => {
  const base = toyLineDeps(s).model;
  // Imp's reply is its first move for sure on sleep counter 3 only.
  return { model: { ...base, support: (state, memory) => {
    const t = readToyState(state);
    return t.p2[t.active.p2]!.sleep === 3 ? [{ choice: { kind: 'move', slot: 0 }, probability: { num: 1n, den: 1n } }] : base.support(state, memory);
  } } };
};

describe('the plan step', () => {
  it("answers the turn: the phase, the view, the AI's reply, his choices, no send-out, the field echoed; it fits the line's step panel", async () => {
    const step = await setup(duel).step();
    expect(step).toMatchObject({ phase: 'turnChoice', field: FIELD, world: 0, unmodelled: [], aiOdds: { kind: 'turn' } });
    expect([step.view.player.active?.name, step.view.enemy.active?.name, step.sendOut]).toEqual(['Hero', 'Imp', undefined]);
    expect(step.aiOdds?.choices.map((c) => [c.label, frac(c.probability!)])).toEqual([['move 1', '1/2'], ['move 2', '1/2']]);
    expect(kinds(step)).toEqual([{ kind: 'move', slot: 0 }, { kind: 'move', slot: 1 }]);
    const panel: Pick<LineNodeJson, 'phase' | 'view' | 'choices' | 'damage' | 'aiOdds' | 'aiError'> = step;   // drift fails the typecheck
    expect(panel.phase).toBe('turnChoice');
  });

  it('maps the field onto the edits: stat stages (acc and eva as accuracy and evasion), status, weather, Stealth Rock, screens, Trick Room', async () => {
    const t = setup(duel);
    const field: PlanFieldJson = {
      weather: 'rain', trickRoom: true, rocks: { player: true, enemy: false },
      screens: { player: { reflect: true, lightScreen: false }, enemy: { reflect: false, lightScreen: true } },
      stages: { player: { atk: 2, acc: -1 }, enemy: { eva: 6, spe: -6, def: 0 } }, enemyStatus: 'brn',
    };
    expect((await t.step({ field })).field).toEqual(field);
    expect(t.edits).toEqual([{
      enemyActive: 0, fainted: { p1: [], p2: [] }, weather: 'rain', trickRoom: true, rocks: { p1: true, p2: false },
      screens: { p1: { reflect: true, lightScreen: false }, p2: { reflect: false, lightScreen: true } },
      stages: { p1: { atk: 2, accuracy: -1 }, p2: { evasion: 6, spe: -6, def: 0 } }, enemyStatus: { kind: 'burn' },
    }]);
    const u = setup(duel);
    for (const enemyStatus of ['par', 'psn', 'frz', 'none'] as const) await u.step({ field: { enemyStatus } });
    expect(u.edits.map((e) => e.enemyStatus.kind)).toEqual(['paralysis', 'poison', 'freeze', 'none']);
    // startStages: the stages the battle start gives the two actives, read before the step's are set.
    const v = setup(duel, { startStages: () => ({ player: { atk: -1 }, enemy: {} }) });
    expect((await v.step({ field: { stages: { player: { spe: 2 }, enemy: {} } } })).startStages).toEqual({ player: { atk: -1 }, enemy: {} });
    expect(v.edits[0]!.stages).toEqual({ p1: { spe: 2 }, p2: {} });
  });

  it("marks the fainted by party index (his by team position), never an active; his active marked: playerReplacement, the turn's reply standing", async () => {
    const r = setup(replacement);
    await r.step({ player: { fainted: ['party:0'] }, enemy: { fainted: [0, 2] } });
    const u = setup(spareDuel);
    await u.step({ team: ['party:1', 'party:0'], player: { fainted: ['party:0', 'party:1'] } });
    expect([r.edits[0]!.fainted, u.edits[0]!.fainted]).toEqual([{ p1: [], p2: [2] }, { p1: [1], p2: [] }]);
    const t = setup(frail);
    const turn = await t.step();
    expect(kinds(turn)).toEqual([{ kind: 'move', slot: 0 }, { kind: 'switch', index: 1 }]);
    const marked = await t.step({ player: { fainted: ['party:0'] } });
    expect([marked.phase, marked.aiOdds, kinds(marked)]).toEqual(['playerReplacement', turn.aiOdds, [{ kind: 'switch', index: 1 }]]);
    const [both, bench] = [await t.step({ player: { fainted: ['party:0', 'party:1'] } }), await t.step({ player: { fainted: ['party:1'] } })];
    expect([both.phase, both.choices, bench.phase, kinds(bench)]).toEqual(['playerReplacement', [], 'turnChoice', [{ kind: 'move', slot: 0 }]]);
    // His replacements are labelled as the line labels a switch, even when the turn's choices hold none (a trapping ability).
    const team = ['party:0', 'party:1', 'party:2', 'party:3', 'party:4', 'party:5'];
    const base = toyLineDeps(six);
    const engine: LineDeps['engine'] = { ...base.engine, legalChoices: (state, side) => base.engine.legalChoices(state, side).filter((c) => c.kind !== 'switch') };
    const trapped = setup(six, { deps: { engine } });
    expect(new Set((await trapped.step({ team })).choices.map((c) => c.choice.kind))).toEqual(new Set(['move']));
    const replaced = await trapped.step({ team, player: { fainted: ['party:0', 'party:2'] } });
    expect([replaced.phase, kinds(replaced)]).toEqual(['playerReplacement', [1, 3, 4, 5].map((index) => ({ kind: 'switch', index }))]);
    const free = await setup(six).step({ team });
    expect(replaced.choices.map((c) => c.label)).toEqual(free.choices.filter((c) => c.choice.kind === 'switch' && c.choice.index !== 2).map((c) => c.label));
  });

  it("their send-out only when their active is marked fainted, over those not marked, by party index; their active first in the battle's party", async () => {
    const t = setup(replacement);
    expect([(await t.step()).sendOut, (await t.step({ enemy: { fainted: [1] } })).sendOut]).toEqual([undefined, undefined]);
    const one = await t.step({ enemy: { fainted: [0] } });
    expect([one.aiOdds?.kind, one.sendOut?.kind, one.sendOut?.choices.map((c) => [c.label, c.index, frac(c.probability!)])])
      .toEqual(['turn', 'replacement', [['party 2', 1, '1/2'], ['party 3', 2, '1/2']]]);
    const two = (await t.step({ enemy: { fainted: [0, 1] } })).sendOut!.choices;
    const sum = two.reduce((s, c) => add(s, rat(BigInt(c.probability!.num), BigInt(c.probability!.den))), ZERO);
    expect([two.map((c) => [c.label, c.index]), eq(sum, ONE)]).toEqual([[['party 3', 2]], true]);
    const all = await t.step({ enemy: { fainted: [0, 1, 2] } });
    expect([all.sendOut, all.sendOutError, all.aiOdds?.kind]).toEqual([undefined, undefined, 'turn']);
    // Two of one name stay apart, each with its own party index.
    const own = toyLineDeps(replacement).labeler;
    const labeler: LineDeps['labeler'] = (mons, team) => {
      const l = own(mons, team);
      return { ...l, choice: (state, side, choice) => (side === 'p2' && choice.kind === 'switch' ? 'Switch to Twin' : l.choice(state, side, choice)) };
    };
    const twins = await setup(replacement, { deps: { labeler } }).step({ enemy: { fainted: [0] } });
    expect([twins.sendOutError, twins.sendOut?.choices.map((c) => [c.label, c.index])]).toEqual([undefined, [['Twin', 1], ['Twin', 2]]]);
    // Their active goes first in the battle's party (slots 0 and k swapped); his team is the battle's party as given.
    const v = setup(replacement);
    const step = await v.step({ enemy: { active: 2 } });
    expect([v.inputs[0]!.trainer.party.map((m) => m.name), v.edits[0]!.enemyActive, step.view.enemy.active?.name]).toEqual([['Tiger', 'Mouse', 'Imp'], 2, 'Tiger']);
    expect(step.aiOdds?.choices.map((c) => c.label)).toEqual(['move 1']);
    expect((await v.step({ enemy: { active: 2, fainted: [2] } })).sendOut?.choices.map((c) => [c.label, c.index])).toEqual([['party 1', 0], ['party 2', 1]]);
    const u = setup(six);
    const mine = await u.step({ team: ['party:6', 'party:0', 'party:1', 'party:2', 'party:3', 'party:4'] });
    expect([u.inputs[0]!.player.map((m) => m.nickname), mine.view.player.active?.name]).toEqual([['G', 'A', 'B', 'C', 'D', 'E'], 'G']);
    expect(kinds(mine).filter((c) => c.kind === 'switch')).toEqual([1, 2, 3, 4, 5].map((index) => ({ kind: 'switch', index })));
    expect((await u.step({ team: ['party:2'] })).view.player.party.map((m) => m.name)).toEqual(['C']);
  });

  // Weather and Trick Room: left out, the trainer's whole field and what the start gives; given, the field without its own
  // unless they agree; echoed resolved. [trainer's field and start, the step's field, the battle's field, the edit, the echo]
  const sand: Parameters<typeof setup>[1] = { field: { weather: 'sand', fog: true }, weather: () => 'sand' };
  const room: Parameters<typeof setup>[1] = { field: { trickRoom: true }, trickRoom: () => true };
  it.each<[string, Parameters<typeof setup>[1], Over['field'], FieldSpec, Partial<PlanEdits>]>([
    ['sand left out', sand, { weather: undefined }, { weather: 'sand', fog: true }, { weather: 'sand' }],
    ['sand given', sand, { weather: 'sand' }, { weather: 'sand', fog: true }, { weather: 'sand' }],
    ['none against sand', sand, { weather: 'none' }, { fog: true }, { weather: 'none' }],
    ["a start's sun against the field's rain, left out: the battle keeps the rain", { field: { weather: 'rain' }, weather: () => 'sun' }, { weather: undefined }, { weather: 'rain' }, { weather: 'sun' }],
    ['Trick Room left out', room, { trickRoom: undefined }, { trickRoom: true }, { trickRoom: true }],
    ['Trick Room off', room, { trickRoom: false }, {}, { trickRoom: false }],
    ['Trick Room on', room, { trickRoom: true }, { trickRoom: true }, { trickRoom: true }],
    ['no Trick Room left out', {}, { trickRoom: undefined }, {}, { trickRoom: false }],
  ])('weather and Trick Room: %s', async (_name, opts, field, built, edit) => {
    const t = setup(duel, opts);
    const step = await t.step({ field });
    expect(t.inputs.map((i) => i.field)).toEqual([built]);                              // one battle build a step
    expect(t.edits[0]).toMatchObject(edit);
    expect(step.field).toMatchObject(edit.weather === undefined ? { trickRoom: edit.trickRoom } : { weather: edit.weather });
  });

  it('sleep and toxic: every counter is tried, the status used when they agree, said when they do not; a closed request stops with 499', async () => {
    for (const [enemyStatus, tried] of [
      ['slp', [1, 2, 3, 4, 5, 6, 7].map((turns) => ({ kind: 'sleep', turns }))], ['tox', Array.from({ length: 16 }, (_, stage) => ({ kind: 'toxic', stage }))],
    ] as const) {
      const t = setup(replacement);
      expect([(await t.step({ field: { enemyStatus } })).unmodelled, t.edits.map((e) => e.enemyStatus)], enemyStatus).toEqual([[], tried]);
    }
    const closed = new AbortController();
    const base = toyLineDeps(replacement).model;
    let calls = 0;
    const v = setup(replacement, { deps: { model: { ...base, support: (state, memory) => { if (++calls === 3) closed.abort(); return base.support(state, memory); } } } });
    await expect(v.step({ field: { enemyStatus: 'tox' }, signal: closed.signal })).rejects.toMatchObject({ status: 499 });
    expect(v.edits.length > 0 && v.edits.length < 16).toBe(true);
    await expect(setup(replacement).step({ signal: AbortSignal.abort() })).rejects.toMatchObject({ status: 499 });
    // A sleep whose counter changes the AI's reply is left out of the state and said in unmodelled, at every AI odds level.
    const s = setup(duel, { deps: sleepy(duel) });
    const step = await s.step({ field: { enemyStatus: 'slp' } });
    expect(step.unmodelled).toEqual(["Their sleep is not modelled in this turn: the AI's odds depend on its sleep counter, which the plan does not set"]);
    expect([s.edits.at(-1)!.enemyStatus, step.field.enemyStatus]).toEqual([{ kind: 'none' }, 'slp']);
    for (const aiOdds of ['likeliest', 'ranked', 'off'] as const) {
      expect((await setup(duel, { deps: sleepy(duel), aiOdds }).step({ field: { enemyStatus: 'slp' } })).unmodelled, aiOdds)
        .toEqual(['Their sleep is not modelled in this turn: it depends on its sleep counter, which the plan does not set']);
    }
  });

  it.each<[string, Over, object?, Scenario?]>([
    ['an unknown trainer', { trainerId: 'nobody' }, { status: 404 }],
    ['a double battle', {}, { status: 422, message: "Double battles can't be built yet" }, doubles],
    ['their active past the party', { enemy: { active: 3 } }], ['a negative active', { enemy: { active: -1 } }], ['a fractional active', { enemy: { active: 1.5 } }],
    ['their fainted past the party', { enemy: { fainted: [7] } }], ['his fainted outside the team', { player: { fainted: ['party:5'] } }],
    ['his active outside the team', { player: { active: 'party:5' } }], ['a stage past 6', { field: { stages: { player: { atk: 7 }, enemy: {} } } }],
    ['a fractional stage', { field: { stages: { player: {}, enemy: { spe: 1.5 } } } }], ['a stage for HP', { field: { stages: { player: { hp: 1 } as never, enemy: {} } } }],
    ['an unknown status', { field: { enemyStatus: 'sleep' as never } }], ['a status that is not a string', { field: { enemyStatus: ['slp'] as never } }],
    ['an unknown weather', { field: { weather: 'fog' as never } }], ['an empty team', { team: [] }], ['a ref the box lacks', { team: ['party:9'] }],
    ['a ref twice', { team: ['party:0', 'party:0'] }], ['seven in the team', { team: ['party:0', 'party:1', 'party:2', 'party:3', 'party:4', 'party:5', 'party:6'] }],
    ['a world the trainer lacks', { world: 3 }],
  ])('refuses %s with its status and words', async (_name, over, expected = { status: 400, message: expect.any(String) }, s = replacement) => {
    await expect(setup(s).step(over)).rejects.toMatchObject(expected);
  });
});

describe('the plan step at each AI odds level', () => {
  /** Imp (four moves) leads; Mouse, Tiger and Bear are on their bench. */
  const ranks = scenario('ranks', [mon('Hero', 10, 10, [mv('Strike', [5])])], [
    mon('Imp', 8, 5, [mv('Scratch', [3]), mv('Poke', [3]), mv('Jab', [3]), mv('Tap', [1])]),
    mon('Mouse', 5, 5, [mv('Nibble', [1])]), mon('Tiger', 5, 25, [mv('Maul', [4])]), mon('Bear', 9, 3, [mv('Swipe', [2])]),
  ]);
  const r = (num: bigint, den: bigint): Rational => ({ num, den });
  /** Their moves 2/5, 1/4, 1/4, 1/10 (ranks 1, 2, 2, 4); their send-out Tiger 3/4, Mouse 1/4, Bear never. */
  const ODDS: [number, Rational][] = [[0, r(2n, 5n)], [1, r(1n, 4n)], [2, r(1n, 4n)], [3, r(1n, 10n)]];
  const SEND: [number, Rational][] = [[2, r(3n, 4n)], [1, r(1n, 4n)]];
  /** A damage answer the toy deps lack, so every level can be seen to keep it. */
  const DAMAGE: LineDamageJson = {
    yours: [], against: 'Hero', order: { player: 10, enemy: 5, first: 'player', changers: [] },
    theirs: [{
      name: 'Scratch', hitChance: 1, status: false, percent: [30, 30], critPercent: [60, 60], ko: 0, koCrit: 0, koExact: [{ num: '0', den: '1' }],
      koCritExact: { num: '0', den: '1' }, hp: [3, 3], critHp: [6, 6], note: null, priority: 0, critChance: { num: '1', den: '16' },
    }],
  };
  function deps(turn = ODDS, send = SEND): Partial<LineDeps> {
    const base = toyLineDeps(ranks).model;
    return {
      damage: () => () => DAMAGE,
      model: {
        ...base,
        support: () => turn.map(([slot, probability]) => ({ choice: { kind: 'move', slot }, probability })),
        replacementSupport: () => send.map(([index, probability]) => ({ choice: { kind: 'switch', index }, probability })),
      },
    };
  }
  const at = (aiOdds: AiOddsLevel | undefined, over: Over = {}, d = deps()) => setup(ranks, { deps: d, ...(aiOdds === undefined ? {} : { aiOdds }) }).step(over);
  const fallen: Over = { enemy: { fainted: [0] } };
  /** Everything but the AI's answer. */
  const rest = ({ aiOdds: _a, aiError: _e, sendOut: _s, sendOutError: _se, ...others }: PlanStepJson) => others;
  const aiText = (step: PlanStepJson) => JSON.stringify([step.aiOdds, step.sendOut]);

  it('full is the default: every probability and percent, no rank, no mark; every level keeps the rest of the answer', async () => {
    const full = await at('full', fallen);
    expect(JSON.stringify(full)).toBe(JSON.stringify(await at(undefined, fallen)));
    expect(full.aiOdds?.choices).toEqual([
      { label: 'move 1', probability: { num: '2', den: '5' }, percent: 40 }, { label: 'move 2', probability: { num: '1', den: '4' }, percent: 25 },
      { label: 'move 3', probability: { num: '1', den: '4' }, percent: 25 }, { label: 'move 4', probability: { num: '1', den: '10' }, percent: 10 },
    ]);
    expect(full.sendOut?.choices).toEqual([
      { label: 'party 3', probability: { num: '3', den: '4' }, percent: 75, index: 2 }, { label: 'party 2', probability: { num: '1', den: '4' }, percent: 25, index: 1 },
    ]);
    expect(full.damage?.theirs[0]).toMatchObject({ name: 'Scratch', percent: [30, 30], koExact: [{ num: '0', den: '1' }], critChance: { num: '1', den: '16' } });
    for (const level of ['likeliest', 'ranked', 'off'] as const) expect(rest(await at(level, fallen)), level).toEqual(rest(full));
  });

  it('likeliest names the top moves at rank 1 and marks the likeliest send-ins; ranked ranks them all; neither sends odds, off sends none', async () => {
    const [likeliest, ranked] = [await at('likeliest', fallen), await at('ranked', fallen)];
    expect(likeliest.aiOdds).toEqual({ kind: 'turn', choices: [{ label: 'move 1', rank: 1 }] });
    expect(likeliest.sendOut).toEqual({ kind: 'replacement', choices: [{ label: 'party 2', index: 1 }, { label: 'party 3', index: 2, likeliest: true }, { label: 'party 4', index: 3 }] });
    expect(ranked.aiOdds).toEqual({ kind: 'turn', choices: [{ label: 'move 1', rank: 1 }, { label: 'move 2', rank: 2 }, { label: 'move 3', rank: 2 }, { label: 'move 4', rank: 4 }] });
    expect(ranked.sendOut).toEqual({ kind: 'replacement', choices: [{ label: 'party 3', index: 2, rank: 1 }, { label: 'party 2', index: 1, rank: 2 }] });
    for (const step of [likeliest, ranked]) expect(aiText(step)).not.toMatch(/probability|percent|"num"|"den"/);
    expect(aiText(ranked)).not.toMatch(/likeliest/);
    expect((await at('likeliest', { enemy: { fainted: [0, 3] } })).sendOut?.choices.map((c) => c.index)).toEqual([1, 2]);
    const tied = await at('likeliest', fallen, deps([[0, r(3n, 8n)], [2, r(3n, 8n)], [1, r(1n, 4n)]], [[1, r(1n, 2n)], [3, r(1n, 2n)]]));
    expect(tied.aiOdds?.choices).toEqual([{ label: 'move 1', rank: 1 }, { label: 'move 3', rank: 1 }]);
    expect(tied.sendOut?.choices).toEqual([{ label: 'party 2', index: 1, likeliest: true }, { label: 'party 3', index: 2 }, { label: 'party 4', index: 3, likeliest: true }]);
    // Off sends no odds, no send-out and no AI error; an AI error shows at every other level.
    const off = await at('off', fallen);
    expect(['aiOdds', 'aiError', 'sendOut', 'sendOutError'].filter((key) => key in off)).toEqual([]);
    const broken: Partial<LineDeps> = { ...deps(), model: { ...deps().model!, support: () => { throw Object.assign(new Error('no odds here'), { code: 'DIV_ZERO' }); } } };
    const error = "The AI's behaviour is undefined here (DIV_ZERO: no odds here)";
    const errorAt = async (level: AiOddsLevel) => { const s = await at(level, {}, broken); return 'aiError' in s ? s.aiError : 'none'; };
    expect([await errorAt('likeliest'), await errorAt('ranked'), await errorAt('off')]).toEqual([error, error, 'none']);
  });
});
