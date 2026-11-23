import { describe, expect, it } from 'vitest';
import type { BattleInput, Choice, Engine } from '../../../src/contracts/engine.js';
import type { GauntletEntry, MonRef, PlanLeaf, PlanNode, SolveRequest, Verdict } from '../../../src/contracts/solver.js';
import { resolveConfig } from '../../../src/solver/config.js';
import { createSolver } from '../../../src/solver/index.js';
import { rat } from '../../../src/solver/rational.js';
import { solveFights, type FightControl } from '../../../src/solver/solve.js';
import type { MonInfo, SolverDeps } from '../../../src/solver/types.js';
import { createToyAi } from './toy/ai.js';
import { toyDeps } from './toy/deps.js';
import { createToyEngine } from './toy/engine.js';
import { gauntletFights, makeArena } from './toy/fixtures.js';
import {
  critSpanGauntlet, deathGauntlet, doubleGauntlet, entryRangeGauntlet, highHpGauntlet, undrawnSleepGauntlet, type Scenario,
} from './toy/scenarios.js';

const lead = (index: number): Choice => ({ kind: 'switch', index });
const move = (slot: number): Choice => ({ kind: 'move', slot });
const NONE = { kind: 'none' } as const;
const INF = Number.POSITIVE_INFINITY;
const CTL: FightControl = { deadline: INF, checkerDeadline: INF, progress: { node() {}, message() {}, teams() {} } };
const CARRY_RULE = 'HP, PP and status carry over between fights';
const REST = 'the lead may change before each fight; experience is ignored between fights too, which can only underrate the team; '
  + 'the crit budget and the death odds count across the whole gauntlet';
const mon = (ref: string, hpMin: number, hpMax: number, statuses: string[]): GauntletEntry['mons'][number] => ({ ref, hpMin, hpMax, statuses });

/** The scenario's gauntlet (each fight once, in order, no heals) with its whole p1 list as a fixed team, at its horizon. */
function request(s: Scenario, over: Partial<SolveRequest> = {}): SolveRequest {
  return {
    fights: (s.fights ?? [s.trainerId]).map((trainerId) => ({ trainerId })), team: { kind: 'fixed', party: s.p1.map((_, i) => `party:${i}`) },
    preStatus: 'given', budgetMs: 600_000, horizonTurns: s.horizon, attemptAnyLegalBadge: false, ranking: [], ...over,
  };
}

function solve(s: Scenario, opts: { req?: Partial<SolveRequest>; deps?: Partial<SolverDeps> } = {}): Promise<Verdict> {
  return createSolver(toyDeps(s, opts.deps)).solve(request(s, opts.req));
}

/** The toy deps of `s` with each save mon rewritten by `edit`. */
function editedSave(s: Scenario, edit: (ref: MonRef, info: MonInfo) => MonInfo): SolverDeps {
  const deps = toyDeps(s);
  return { ...deps, resolver: { ...deps.resolver, mon: (ref) => edit(ref, deps.resolver.mon(ref)) } };
}

function tierOf<T extends Verdict['tier']>(v: Verdict, tier: T): Extract<Verdict, { tier: T }> {
  if (v.tier !== tier) throw new Error(`expected tier ${String(tier)}, got ${JSON.stringify({ tier: v.tier, ...(v.tier === 'unproven' ? { reason: v.reason, detail: v.detail } : {}) })}`);
  return v as Extract<Verdict, { tier: T }>;
}

/** The player actions along the main path (branches[0] at every node), and its leaf. */
function mainPath(tree: PlanNode): { actions: (Choice | undefined)[]; leaf: PlanLeaf } {
  const actions: (Choice | undefined)[] = [];
  let at: PlanNode | PlanLeaf = tree;
  while (!('result' in at)) {
    if (at.kind === 'player') actions.push(at.action);
    at = at.branches[0]!.next;
  }
  return { actions, leaf: at };
}

/** The tree followed by branch labels, one per depth. */
function follow(tree: PlanNode, path: string[]): PlanNode | PlanLeaf {
  let at: PlanNode | PlanLeaf = tree;
  for (const label of path) {
    if ('result' in at) throw new Error(`path ${JSON.stringify(path)} ends early at a ${at.result} leaf`);
    const next: PlanNode | PlanLeaf | undefined = at.branches.find((b) => b.label === label)?.next;
    if (next === undefined) throw new Error(`no branch ${JSON.stringify(label)} on path ${JSON.stringify(path)}`);
    at = next;
  }
  return at;
}

describe('gauntlet', () => {
  it('fight 2 forces the high-HP line in fight 1', async () => {
    // Only Mend, Mend, Smash enters fight 2 at 9/10, the one entry fight 2 survives.
    const v = tierOf(await solve(highHpGauntlet), 1);
    expect(mainPath(v.tree).actions).toEqual([lead(0), move(1), move(1), move(0), lead(0), move(0)]);
    expect(v).toMatchObject({
      entries: [{ fight: 1, mons: [mon('party:0', 9, 9, ['none'])] }], rank: { worstMinHp: '1/10 (10.00%)', pp: '16', turns: '3' },
      report: { verification: { passed: true } },
    });
  });

  it.each([
    { heals: [false, true], burnedSave: false, which: 'fight 2' },
    { heals: [true, true], burnedSave: true, which: 'fights 1, 2' },
  ])('a heal before $which relaxes it to the 1-turn line, and a healed entry is full HP with no status', async ({ heals, burnedSave, which }) => {
    // Healed, the lines tie on HP and PP, so the ranking's turns key keeps Smash at once. The save has Hero burned at 4/10.
    const burn = { kind: 'burn' } as const;
    const deps = editedSave(highHpGauntlet, (_ref, info) => (burnedSave ? { ...info, status: burn, mon: { ...info.mon, currentHp: 4, pp: [3, 2], status: burn } } : info));
    const fights = ['ogre', 'brute'].map((trainerId, i) => ({ trainerId, healBefore: heals[i] }));
    const v = tierOf(await createSolver(deps).solve(request(highHpGauntlet, { fights })), 1);
    expect(mainPath(v.tree).actions).toEqual([lead(0), move(0), lead(0), move(0)]);
    expect(v).toMatchObject({
      rank: { worstMinHp: '1/5 (20.00%)', totalHp: '2', pp: '19', turns: '1' }, entries: [{ fight: 1, mons: [mon('party:0', 10, 10, ['none'])] }],
      report: { verification: { passed: true } },
    });
    expect(v.report.assumptions).toContain(`gauntlet of 2 fights with one team: ${CARRY_RULE}, except a full heal before ${which}; ${REST}`);
  });

  it('entry ranges are reported, and pre-statuses apply to fight 1 only', async () => {
    // Bite rolls 1 or 2 before Strike KOs Biter. Hero's pre-sleep is gone by fight 2; benched Tank still sleeps.
    const startStatus = { 'party:0': { kind: 'sleep', turns: 1 }, 'party:1': { kind: 'sleep', turns: 2 } } as const;
    const tank = mon('party:1', 2, 2, ['sleep:2']);
    const v = tierOf(await solve(entryRangeGauntlet, { req: { startStatus } }), 1);
    expect(v).toMatchObject({ entries: [{ fight: 1, mons: [mon('party:0', 8, 9, ['none']), tank] }], preStatus: startStatus });
    expect(v.report.assumptions).toEqual(expect.arrayContaining([
      `gauntlet of 2 fights with one team: ${CARRY_RULE}; ${REST}`, 'horizon: 1 turns per fight; a line not won by then counts as failing',
    ]));
    // Biter twice, then Imp: the ranges widen.
    const fights = [{ trainerId: 'biter' }, { trainerId: 'biter' }, { trainerId: 'imp' }];
    const t = tierOf(await solve(entryRangeGauntlet, { req: { fights, startStatus } }), 1);
    expect(t.entries).toEqual([{ fight: 1, mons: [mon('party:0', 8, 9, ['none']), tank] }, { fight: 2, mons: [mon('party:0', 6, 8, ['none']), tank] }]);
  });

  it('an undrawn sleep carries over, keyed in RAM mode by canonical JSON', async () => {
    // Hero (pre-slept, counter 3) takes Crush and sleeps through one attempt; Tank wins fight 1 and leads fight 2.
    const s = undrawnSleepGauntlet;
    const startStatus = { 'party:0': { kind: 'sleep', turns: 3 } } as const;
    const undrawn = { kind: 'sleepUndrawn', attempts: 1 } as const;
    const deps = toyDeps(s);
    const built: BattleInput[] = [];
    const spy: Engine = { ...deps.engine, createBattle: (input) => (built.push(input), deps.engine.createBattle(input)) };
    const v = tierOf(await createSolver({ ...deps, engine: spy }).solve(request(s, { startStatus })), 1);
    expect(mainPath(v.tree)).toEqual({ actions: [lead(0), move(0), lead(1), move(0), lead(1), move(0)], leaf: { result: 'win', endHp: [5, 1], endStatus: [undrawn, NONE] } });
    expect(v).toMatchObject({ entries: [{ fight: 1, mons: [mon('party:0', 5, 5, ['sleepUndrawn:1']), mon('party:1', 1, 1, ['none'])] }], report: { verification: { passed: true } } });
    // Fight 2 starts from the carry, lead first; the tying Tank-lead line's entry has Hero through no attempt.
    const second = built.filter((input) => input.trainer.id === 'gnat').map((input) => input.carry?.mons);
    for (const attempts of [1, 0]) expect(second).toContainEqual([{ hp: 1, pp: [9], status: NONE }, { hp: 5, pp: [10], status: { ...undrawn, attempts } }]);
    // An engine that writes the undrawn sleep's keys in another order gives the same certificate.
    const cfg = resolveConfig({ observationMode: 'ram' });
    const toy = createToyEngine(s.registry);
    const unsorted: Engine = { ...toy, carryOut: (state) => ({
      mons: toy.carryOut(state).mons.map((m) => ({ status: m.status.kind === 'sleepUndrawn' ? { attempts: m.status.attempts, kind: m.status.kind } : m.status, pp: m.pp, hp: m.hp })),
    }) };
    const fights = gauntletFights(s, { startStatus });
    const [sorted, other] = [deps, { ...deps, engine: unsorted }].map((d) => solveFights(d, cfg, fights, request(s, { startStatus }), CTL));
    for (const run of [sorted!, other!]) expect(tierOf(run.verdict, 1)).toMatchObject({ entries: v.entries, report: { verification: { passed: true, mismatches: [] } } });
    expect(other!.certificate).toEqual(sorted!.certificate);
  });

  it('the crit budget spans fights', async () => {
    // A crit in fight 1 and another in fight 2 kill: 1/4 × 1/4, two crit steps, budget 1.
    const v = tierOf(await solve(critSpanGauntlet), 2);
    expect(v).toMatchObject({
      critBudget: 1, deathProbability: rat(1, 16), guaranteeDeathProbability: rat(1, 16),
      killers: [{ cause: 'enemy crit bash on turn 1 kills party 0', probability: rat(1, 16) }],
      entries: [{ fight: 1, mons: [mon('party:0', 4, 7, ['none'])] }], report: { verification: { passed: true } },
    });
    for (const k of v.killers) expect(follow(v.tree, k.path)).toEqual({ result: 'death' });
  });

  it('a double in the gauntlet is unsupported, from the resolver or from the engine at fight 2', async () => {
    expect(await solve(doubleGauntlet)).toMatchObject({ tier: 'unproven', reason: 'unsupportedBattle', detail: 'pair is a double battle; doubles are not supported yet' });
    const pair = doubleGauntlet.registry.trainers.pair!;
    const quiet: Scenario = { ...doubleGauntlet, registry: { ...doubleGauntlet.registry, trainers: { ...doubleGauntlet.registry.trainers, pair: { ...pair, double: false } } } };
    expect(await solve(quiet, { deps: { engine: createToyEngine(doubleGauntlet.registry) } })).toMatchObject({
      tier: 'unproven', reason: 'unsupportedBattle', detail: 'the engine refuses the battle: toy engine: trainer pair fights a double battle',
    });
  });

  it('a death ends a gauntlet line, and a fainted save mon is refused unless fight 1 starts healed', async () => {
    // Hero leads and Jabs; a miss (1/4) lets Crush kill him in fight 1. Only the hit enters fight 2.
    const s = deathGauntlet;
    const v = tierOf(await solve(s), 3);
    expect(v).toMatchObject({
      deathProbability: rat(1, 4), optimality: 'proven', entries: [{ fight: 1, mons: [mon('party:0', 5, 5, ['none']), mon('party:1', 3, 3, ['none'])] }],
    });
    for (const k of v.killers) expect(follow(v.tree, k.path)).toEqual({ result: 'death' });
    // In the arena the miss is a dead leaf, though Tank could still win fight 1: no fight-2 entry from it.
    const arena = makeArena(gauntletFights(s), createToyEngine(s.registry), createToyAi(s.registry));
    const battle = arena.expand(arena.root(), lead(0), { level: 1, critCap: null }).successors[0]!.member!;
    const jab = arena.expand(battle, move(0), { level: 1, critCap: null }).successors;
    expect(jab.map((t) => [t.result, t.probability, t.member?.kind ?? null, t.member?.fight ?? null])).toEqual([['continue', rat(3, 4), 'entry', 1], ['dead', rat(1, 4), null, null]]);
    expect(jab[0]!.member!.carry).toEqual({ mons: [{ hp: 5, pp: [9, 10], status: NONE }, { hp: 3, pp: [10], status: NONE }] });
    const fainted = editedSave(s, (ref, info) => (ref === 'party:1' ? { ...info, mon: { ...info.mon, currentHp: 0 } } : info));
    expect(await createSolver(fainted).solve(request(s))).toMatchObject({
      tier: 'unproven', reason: 'noEligibleTeam', detail: 'Tank (party:1) has fainted (0 HP in the save); a fight cannot start with a fainted Pokémon',
    });
    const healedFirst = await createSolver(fainted).solve(request(s, { fights: [{ trainerId: 'imp', healBefore: true }, { trainerId: 'gnat' }] }));
    expect(tierOf(healedFirst, 3).deathProbability).toEqual(rat(1, 4));
  });
});
