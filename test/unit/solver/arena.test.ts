import { describe, expect, it } from 'vitest';
import type { EnemyModel } from '../../../src/contracts/ai.js';
import type { BattleInput, CarryState, Choice, Engine } from '../../../src/contracts/engine.js';
import { ArenaLimitError, type Arena, type Member, type Successor } from '../../../src/solver/arena.js';
import { edgeLabel, fightMarker } from '../../../src/solver/edge.js';
import { battleInput, toCanonicalCarry } from '../../../src/solver/inputs.js';
import { choiceText } from '../../../src/solver/keys.js';
import { ONE, rat } from '../../../src/solver/rational.js';
import type { Level } from '../../../src/solver/types.js';
import { createToyAi } from './toy/ai.js';
import { createToyEngine, readToyState } from './toy/engine.js';
import { makeArena, scenarioArena, scenarioFights, tableFights } from './toy/fixtures.js';
import type { ToyMon } from './toy/game.js';
import {
  aiDivZero, aiMemory, aiUndefined, critOnlyBudget0, level2Gap, loopEscape, replacementTie, safe1v1, TABLES, unlabelledOnly, uturnLine, worldsSplit,
  type Scenario,
} from './toy/scenarios.js';
import { tableGame, type TableSpec } from './toy/table.js';

interface Opts { level: Level; critCap: number | null }
const L1: Opts = { level: 1, critCap: null };
const L2: Opts = { level: 2, critCap: null };
const NO_MEMORY = { key: '', data: null };
const NONE = { kind: 'none' } as const;
const move = (slot: number): Choice => ({ kind: 'move', slot });
const pick = (index: number): Choice => ({ kind: 'switch', index });
const results = (ss: Successor[]) => ss.map((s) => [s.result, s.aiChoices.map(choiceText)]);

function memberOf(s: Successor | undefined): Member {
  if (s?.result !== 'continue' || s.member === null) throw new Error(`expected a continue successor, got ${s?.result}`);
  return s.member;
}

/** The battle member after leading with canonical team index `lead` (the first world). */
function started(arena: Arena, lead = 0, opts: Opts = L1): Member {
  return memberOf(arena.expand(arena.root(), pick(lead), opts).successors[0]);
}

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

/** The engine with every outcome's fainted.p1 emptied: deaths must then come from the phase alone. */
function hideFaints(engine: Engine): Engine {
  return {
    ...engine,
    expandTurn: (state, choices, opts) => engine.expandTurn(state, choices, opts).map((o) => ({ ...o, fainted: { p1: [], p2: o.fainted.p2 } })),
  };
}

function tableArena(spec: TableSpec): Arena {
  const t = tableGame(spec);
  return makeArena(tableFights(t), t.engine, t.ai);
}

function toyArena(s: Scenario, engine: Engine = createToyEngine(s.registry), fights = scenarioFights(s)): Arena {
  return makeArena(fights, engine, createToyAi(s.registry));
}

/** One trainer `name` with one foe, the player's mons in team order, full information. */
function duel(name: string, p1: ToyMon[], foe: ToyMon, horizon: number): Scenario {
  return { name, p1: p1.map((m) => m.name), trainerId: name, horizon, expect: {}, registry: { observeAll: true, mons: Object.fromEntries(p1.map((m) => [m.name, m])), trainers: { [name]: { id: name, party: [foe] } } } };
}

describe('arena', () => {
  it('entry builds one member per world', () => {
    const arena = scenarioArena(worldsSplit);
    const root = arena.root();
    expect(root).toMatchObject({ kind: 'entry', fight: 0, state: null, carry: null, memory: NO_MEMORY, crits: 0, turnsInFight: 0 });
    expect(root.key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(arena.choices(root)).toEqual([pick(0)]);
    const x = arena.expand(root, pick(0), L1);
    expect(x.turnConsumed).toBe(false);
    for (const s of x.successors) {
      expect(s).toMatchObject({ result: 'continue', probability: rat(1, 2), phase: 'turnChoice', aiChoices: [], critsAdded: 0, member: { kind: 'battle', fight: 0, carry: null, turnsInFight: 0, crits: 0 } });
    }
    // Worlds in order, with distinct keys but one screen, so a belief will hold both.
    const [w0, w1] = x.successors;
    expect(x.successors.map((s) => readToyState(memberOf(s).state!).p2[0]!.maxHp)).toEqual([3, 6]);
    expect(memberOf(w0).key).not.toBe(memberOf(w1).key);
    expect(edgeLabel(w0!.observations, 'turnChoice')).toBe(edgeLabel(w1!.observations, 'turnChoice'));
    expect(edgeLabel(['a', 'b'], 'turnChoice', 'k')).toBe('a\nb\u001fturnChoice\u001fk');
  });

  it('ANDs over the AI support, at level 2 over every legal choice', () => {
    const arena = tableArena(TABLES.coinFlip);
    const x = arena.expand(started(arena), move(0), L1);
    expect(x.turnConsumed).toBe(true);
    expect(x.successors.map((s) => [s.result, s.aiChoices.map(choiceText), s.probability, s.member, s.endCarry])).toEqual([
      ['win', ['m0'], rat(1, 2), null, { mons: [{ hp: 1, pp: [], status: NONE }] }],
      ['dead', ['m1'], rat(1, 2), null, null],
    ]);

    const gap = scenarioArena(level2Gap);
    expect(results(gap.expand(started(gap), move(0), L1).successors)).toEqual([['win', ['m0']]]);   // the AI only Pokes
    const two = gap.expand(started(gap, 0, L2), move(0), L2).successors;
    expect(two.map((s) => [s.result, s.aiChoices.map(choiceText), s.probability])).toEqual([['win', ['m0'], rat(1, 2)], ['dead', ['m1'], rat(1, 2)]]);
  });

  it('classifies deaths by faint or by phase', () => {
    const arena = scenarioArena(critOnlyBudget0);
    const calm = memberOf(arena.expand(started(arena), move(0), L1).successors.find((s) => s.critsAdded === 0));   // Hero at 4
    const turn2 = arena.expand(calm, move(0), L1).successors;
    expect(turn2.map((s) => [s.result, s.critsAdded, s.member, s.phase])).toEqual([['dead', 1, null, null], ['win', 0, null, null]]);
    expect(turn2[0]!.last.fainted.p1).toEqual([0]);
    expect(turn2[0]!.labels).toContainEqual(expect.objectContaining({ kind: 'crit', outcome: 'crit' }));

    // Without fainted.p1, the phase decides: terminal p2 and playerReplacement are deaths.
    const hidden = toyArena(critOnlyBudget0, hideFaints(createToyEngine(critOnlyBudget0.registry)));
    const calmHidden = memberOf(hidden.expand(started(hidden), move(0), L1).successors.find((s) => s.critsAdded === 0));
    const crit = hidden.expand(calmHidden, move(0), L1).successors.find((s) => s.critsAdded === 1)!;
    expect([crit.result, crit.last.state.phase]).toEqual(['dead', { kind: 'terminal', winner: 'p2' }]);
    const benched = toyArena(uturnLine, hideFaints(createToyEngine(uturnLine.registry)));
    const [swap] = benched.expand(started(benched, 1), pick(1), L1).successors;   // Scout switches in and takes Bash 7 > 6
    expect([swap!.result, swap!.last.state.phase.kind]).toEqual(['dead', 'playerReplacement']);

    // A table 'lose', and a faint even when play would go on.
    const lose = tableArena({ start: 'R', nodes: { R: { phase: 'turnChoice', p1: ['a'], next: { 'a|': [{ to: 'L', p: ONE }] } }, L: { phase: 'lose', next: {} } } });
    const goesOn = tableArena({ start: 'R', nodes: { R: { phase: 'turnChoice', p1: ['a'], next: { 'a|': [{ to: 'N', p: ONE, faintP1: true }] } }, N: { phase: 'turnChoice', p1: ['b'], next: { 'b|': [{ to: 'R', p: ONE }] } } } });
    for (const a of [lose, goesOn]) expect(a.expand(started(a), move(0), L1).successors.map((s) => s.result)).toEqual(['dead']);
  });

  it('folds the enemy replacement into the turn', () => {
    const arena = scenarioArena(replacementTie);
    const x = arena.expand(started(arena), move(0), L1);   // Strike KOs Imp
    expect(x.successors.map((s) => [s.result, s.phase, s.aiChoices.map(choiceText), s.probability, s.observations.length, memberOf(s).turnsInFight])).toEqual([
      ['continue', 'turnChoice', ['m0', 's1'], rat(1, 2), 2, 1],
      ['continue', 'turnChoice', ['m0', 's2'], rat(1, 2), 2, 1],
    ]);
    expect(x.successors.map((s) => readToyState(memberOf(s).state!).active.p2)).toEqual([1, 2]);
  });

  it('makes a mid-turn switch a decision', () => {
    const arena = scenarioArena(uturnLine);
    const x = arena.expand(started(arena, 0), move(0), L1);   // Scout's Volt
    expect([x.turnConsumed, x.successors.length]).toEqual([true, 1]);
    expect(x.successors[0]).toMatchObject({ result: 'continue', phase: 'playerMidTurnSwitch', aiChoices: [move(0)], member: { turnsInFight: 1 } });
    const mid = memberOf(x.successors[0]);
    expect(arena.choices(mid)).toEqual([pick(1)]);
    const y = arena.expand(mid, pick(1), L1);   // Tank comes in, Bash hits it
    expect([y.turnConsumed, results(y.successors), y.successors[0]!.phase]).toEqual([false, [['continue', []]], 'turnChoice']);
    const next = memberOf(y.successors[0]);
    expect(next.turnsInFight).toBe(1);
    expect(next.danger).toBeCloseTo(13 / 20);
  });

  it('counts crit steps only under a crit cap', () => {
    const go = (to: string, critP2?: boolean) => ({ phase: 'turnChoice' as const, p1: ['go'], next: { 'go|': [{ to, p: ONE, critP2 }] } });
    const chain: TableSpec = { start: 'A', nodes: { A: go('B', true), B: go('C', true), C: go('W'), W: { phase: 'win', next: {} } } };
    const twoSteps = (critCap: number | null): Successor[] => {
      const arena = tableArena(chain);
      const opts = { level: 1, critCap } as const;
      const first = arena.expand(started(arena, 0, opts), move(0), opts).successors[0]!;
      return [first, arena.expand(memberOf(first), move(0), opts).successors[0]!];
    };
    const capped = twoSteps(1);
    const free = twoSteps(null);
    expect([capped, free].map((ss) => ss.map((s) => [s.critsAdded, memberOf(s).crits]))).toEqual([[[1, 1], [1, 1]], [[1, 0], [1, 0]]]);
    expect(memberOf(capped[0]).key).not.toBe(memberOf(free[0]).key);
  });

  it('folds AI memory at level 1 only', () => {
    const arena = scenarioArena(aiMemory);
    const m = started(arena);
    const after = memberOf(arena.expand(m, move(0), L1).successors[0]);   // the player reveals Roar (scary)
    expect([after.memory.key === m.memory.key, after.key === m.key]).toEqual([false, false]);
    // The folded memory drives the next support: Watcher Braces now.
    expect(arena.expand(after, move(1), L1).successors.map((s) => s.aiChoices.map(choiceText))).toEqual([['m1']]);
    for (const s of arena.expand(started(arena, 0, L2), move(0), L2).successors) expect(memberOf(s).memory).toEqual(NO_MEMORY);
  });

  it('turns an engine limit into ArenaLimitError, never cached, and passes other errors on', () => {
    const arena = scenarioArena(critOnlyBudget0, { maxLeaves: 1 });
    const m = started(arena);
    for (let i = 0; i < 2; i++) expect(() => arena.expand(m, move(0), L1)).toThrow(ArenaLimitError);
    expect(arena.stats.edgeHits).toBe(0);
    const bad = caught(() => scenarioArena(critOnlyBudget0).expand(m, move(5), L1));
    expect([bad instanceof ArenaLimitError, bad]).toEqual([false, expect.objectContaining({ code: 'BAD_CHOICE' })]);
    const trainer = safe1v1.registry.trainers.safe1v1!;
    const doubled = scenarioArena({ ...safe1v1, registry: { ...safe1v1.registry, trainers: { safe1v1: { ...trainer, double: true } } } });
    expect(caught(() => doubled.expand(doubled.root(), pick(0), L1))).toMatchObject({ code: 'UNSUPPORTED_DOUBLE' });
  });

  it('caches edges, least recently used first', () => {
    const arena = scenarioArena(critOnlyBudget0);
    const m = started(arena);
    const hits = arena.stats.edgeHits;
    const first = arena.expand(m, move(0), L1);
    const before = { leaves: arena.stats.leaves, expansions: arena.stats.expansions };
    expect([before.leaves, arena.stats.chanceKinds.has('crit')]).toEqual([2, true]);
    expect(arena.expand(m, move(0), L1)).toEqual(first);
    expect([arena.stats.edgeHits, arena.stats.leaves, arena.stats.expansions]).toEqual([hits + 1, before.leaves, before.expansions]);
    arena.expand(m, move(0), { level: 1, critCap: 1 });   // another critCap is another edge
    expect(arena.stats.edgeHits).toBe(hits + 1);

    const small = makeArena(scenarioFights(critOnlyBudget0), createToyEngine(critOnlyBudget0.registry), createToyAi(critOnlyBudget0.registry), { edgeCacheEntries: 1 });
    small.expand(started(small), move(0), L1);   // evicts the root's edge
    small.expand(small.root(), pick(0), L1);
    expect(small.stats.edgeHits).toBe(0);
    small.expand(small.root(), pick(0), L1);
    expect(small.stats.edgeHits).toBe(1);

    // A hit from an equal key at another turn count keeps this member's turn count (positions repeat).
    const loop = scenarioArena(loopEscape);
    const a1 = memberOf(loop.expand(started(loop), move(0), L1).successors.find((s) => readToyState(s.member!.state!).p2[0]!.hp === 6));
    const a2 = memberOf(loop.expand(a1, move(0), L1).successors.find((s) => s.member?.key === a1.key));
    const loopHits = loop.stats.edgeHits;
    const third = loop.expand(a2, move(0), L1);
    expect([a2.turnsInFight, loop.stats.edgeHits - loopHits, new Set(third.successors.map((s) => memberOf(s).turnsInFight))]).toEqual([2, 1, new Set([3])]);
    // Cache keys tell every field of a choice apart.
    expect(choiceText({ kind: 'item', item: 'potion', consumeSlots: [0] })).not.toBe(choiceText({ kind: 'item', item: 'potion', consumeSlots: [1] }));
  });

  it('battleInput re-indexes the team and builds the start carry', () => {
    const hit = { name: 'Hit', damage: [1] };
    const trio = duel('trio', [
      { name: 'A', maxHp: 10, speed: 1, moves: [hit] }, { name: 'B', maxHp: 12, speed: 1, moves: [hit, { name: 'Rest', damage: [], pp: null }] },
      { name: 'C', maxHp: 14, speed: 1, moves: [{ ...hit, pp: 5 }] },
    ], { name: 'Foe', maxHp: 5, speed: 1, moves: [hit] }, 1);
    const sleep = { 'party:2': { kind: 'sleep', turns: 1 } } as const;
    const [fight] = scenarioFights(trio, { startStatus: sleep });
    const carry: CarryState = { mons: [{ hp: 1, pp: [1], status: NONE }, { hp: 2, pp: [2], status: { kind: 'burn' } }, { hp: 3, pp: [3], status: NONE }] };
    const world = { enemy: [] };
    const input = battleInput(fight!, 2, carry, world);
    expect(input).toMatchObject({ carry: { mons: [carry.mons[2], carry.mons[0], carry.mons[1]] }, startStatus: { 0: { kind: 'sleep', turns: 1 } }, trainer: { id: 'trio' }, world });
    expect(input.player.map((p) => p.nickname)).toEqual(['C', 'A', 'B']);
    expect(toCanonicalCarry(input.carry!, 2)).toEqual(carry);

    // No carry: each mon starts from the save (B burned at 5/12 with 3 PP, C with 1 PP). A heal is an explicit healed
    // carry (max HP, full PP, no status), never "no carry"; the manual pre-status still applies.
    const [heal] = scenarioFights(trio, { healBefore: true, startStatus: sleep });
    const worn = { ...heal!, team: heal!.team.map((m, i) => {
      if (i === 1) return { ...m, status: { kind: 'burn' } as const, mon: { ...m.mon, currentHp: 5, pp: [3], status: { kind: 'burn' } as const } };
      return i === 2 ? { ...m, mon: { ...m.mon, pp: [1] } } : m;
    }) };
    expect(battleInput({ ...worn, healBefore: false }, 1, null, world).carry).toEqual({
      mons: [{ hp: 5, pp: [3], status: { kind: 'burn' } }, { hp: 10, pp: [10], status: NONE }, { hp: 14, pp: [1], status: NONE }],
    });
    const healed = battleInput(worn, 1, null, world);
    expect([healed.carry, healed.startStatus]).toEqual([{ mons: [{ hp: 12, pp: [10], status: NONE }, { hp: 10, pp: [10], status: NONE }, { hp: 14, pp: [5], status: NONE }] }, { 2: { kind: 'sleep', turns: 1 } }]);
  });

  it('a gauntlet win enters the next fight with the carry, or healed', () => {
    const engine = createToyEngine(safe1v1.registry);
    const arena = toyArena(safe1v1, engine, [...scenarioFights(safe1v1), ...scenarioFights(safe1v1)]);
    const [t] = arena.expand(started(arena), move(0), L1).successors;   // Strike KOs Imp: fight 0 won
    expect(t).toMatchObject({ result: 'continue', phase: 'entry', endCarry: null, observations: [expect.anything(), fightMarker(1)] });
    expect(fightMarker(1)).toBe('#fight 1');
    const entry = memberOf(t);
    expect(entry).toMatchObject({ kind: 'entry', fight: 1, state: null, memory: NO_MEMORY, turnsInFight: 0, carry: { mons: [{ hp: 10, pp: [9], status: NONE }] } });
    expect(arena.choices(entry)).toEqual([pick(0)]);
    const second = memberOf(arena.expand(entry, pick(0), L1).successors[0]);
    const [won] = arena.expand(second, move(0), L1).successors;
    expect(won).toMatchObject({ result: 'win', member: null, endCarry: { mons: [{ hp: 10, pp: [8], status: NONE }] } });
    expect(arena.metrics(won!.endCarry!)).toEqual({ minHpFrac: ONE, totalHp: 10, pp: 8 });

    // After a heal the entry's carry is null, and the battle is built from the healed carry, never from no carry.
    const built: BattleInput[] = [];
    const spy: Engine = { ...engine, createBattle: (input) => {
      built.push(input);
      return engine.createBattle(input);
    } };
    const healed = toyArena(safe1v1, spy, [...scenarioFights(safe1v1), ...scenarioFights(safe1v1, { healBefore: true })]);
    const healedEntry = memberOf(healed.expand(started(healed), move(0), L1).successors[0]);
    healed.expand(healedEntry, pick(0), L1);
    expect([healedEntry.carry, built.map((input) => input.carry)]).toEqual([null, [{ mons: [{ hp: 10, pp: [10], status: NONE }] }, { mons: [{ hp: 10, pp: [10], status: NONE }] }]]);
  });

  it('keeps the carry canonical through switches', () => {
    const mon = (name: string, maxHp: number, damage: number, pp: number): ToyMon => ({ name, maxHp, speed: 10, moves: [{ name: `${name} move`, damage: [damage], pp }] });
    const swaps = duel('swaps', [mon('Ace', 10, 5, 10), mon('Bolt', 12, 1, 7), mon('Cora', 14, 1, 3)], { name: 'Foe', maxHp: 6, speed: 5, moves: [{ name: 'Tap', damage: [2] }] }, 3);
    const only = (arena: Arena, m: Member, c: Choice): Successor => {
      const ss = arena.expand(m, c, L1).successors;
      expect(ss).toHaveLength(1);
      return ss[0]!;
    };
    // Cora (canonical 2) leads, engine order [Cora, Ace, Bolt]: Poke, switch to Ace (engine index 1), Strike KOs Foe.
    const play = (arena: Arena): Successor => only(arena, memberOf(only(arena, memberOf(only(arena, started(arena, 2), move(0))), pick(1))), move(0));
    const canonical = { mons: [{ hp: 8, pp: [9], status: NONE }, { hp: 12, pp: [7], status: NONE }, { hp: 12, pp: [2], status: NONE }] };
    const single = scenarioArena(swaps);
    const won = play(single);
    expect([won.result, won.endCarry, single.metrics(won.endCarry!)]).toEqual(['win', canonical, { minHpFrac: rat(4, 5), totalHp: 32, pp: 18 }]);

    const gauntlet = toyArena(swaps, undefined, [...scenarioFights(swaps), ...scenarioFights(swaps)]);
    const entry = memberOf(play(gauntlet));
    expect([entry.fight, entry.carry, gauntlet.choices(entry)]).toEqual([1, canonical, [pick(0), pick(1), pick(2)]]);
    // Bolt leads fight 1: engine order [Bolt, Ace, Cora], each with its own carry.
    const next = memberOf(gauntlet.expand(entry, pick(1), L1).successors[0]);
    expect(readToyState(next.state!).p1.map((m) => [m.name, m.hp, m.pp])).toEqual([['Bolt', 12, [7]], ['Ace', 8, [9]], ['Cora', 12, [2]]]);
  });

  it('makes unlabelled draws, an unmodelled start and AI errors with a string code unlabelled leaves', () => {
    const draws = scenarioArena(unlabelledOnly);
    const [raw] = draws.expand(started(draws), move(0), L1).successors;
    expect([raw!.result, raw!.member, raw!.last.unlabelled]).toEqual(['unlabelled', null, true]);
    const engine = createToyEngine(safe1v1.registry);
    const blocked = toyArena(safe1v1, { ...engine, createBattle: () => { throw Object.assign(new Error('item'), { code: 'UNMODELLED_ITEM' }); } });
    expect(blocked.expand(blocked.root(), pick(0), L1).successors.map((s) => [s.result, s.probability])).toEqual([['unlabelled', ONE]]);

    const unlabelled = { result: 'unlabelled', member: null, phase: null, probability: ONE, observations: [], aiChoices: [] };
    for (const [s, code] of [[aiUndefined, 'UNDEFINED'], [aiDivZero, 'DIV_ZERO']] as const) {
      const arena = scenarioArena(s);
      const x = arena.expand(started(arena), move(0), L1);
      expect([x.turnConsumed, x.successors]).toEqual([true, [expect.objectContaining({ ...unlabelled, note: `undefined AI behaviour: ${code}: toy: undefined behaviour` })]]);
    }
    const level2 = scenarioArena(aiUndefined);
    expect(level2.expand(started(level2, 0, L2), move(0), L2).successors.map((t) => t.result)).toEqual(['win']);   // level 2 never asks the AI

    // An undefined replacement support: the leaf keeps the path probability so far.
    const half = rat(1, 2);
    const t = tableGame({
      start: 'R',
      nodes: {
        R: { phase: 'turnChoice', p1: ['a'], next: { 'a|': [{ to: 'E', p: half }, { to: 'W', p: half }] } },
        E: { phase: 'enemyReplacement', ai: [{ name: 'x', p: ONE }], next: { '|x': [{ to: 'W', p: ONE }] } },
        W: { phase: 'win', next: {} },
      },
    });
    const throwing = (error: unknown): Arena => {
      const ai: EnemyModel = { ...t.ai, replacementSupport: () => { throw error; } };
      return makeArena(tableFights(t), t.engine, ai);
    };
    const other = throwing(Object.assign(new Error('no weather'), { code: 'OTHER' }));
    expect(other.expand(started(other), move(0), L1).successors.map((l) => [l.result, l.probability, l.note, l.observations])).toEqual([
      ['unlabelled', half, 'undefined AI behaviour: OTHER: no weather', ['E']], ['win', half, undefined, expect.anything()],
    ]);
    // An error without a string code is a bug, passed on unchanged.
    for (const error of [Object.assign(new Error('numbered'), { code: 7 }), 'bare']) {
      const buggy = throwing(error);
      expect(caught(() => buggy.expand(started(buggy), move(0), L1))).toBe(error);
    }
  });
});
