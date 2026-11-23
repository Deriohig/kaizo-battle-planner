import { describe, expect, it } from 'vitest';
import type { Choice, Rational } from '../../../src/contracts/engine.js';
import type { Arena, Member, Successor } from '../../../src/solver/arena.js';
import { beliefChoices, expandBelief, restrict, rootBelief, weightsKey, type Belief, type BeliefExpansion } from '../../../src/solver/belief.js';
import { edgeLabel } from '../../../src/solver/edge.js';
import { digest } from '../../../src/solver/keys.js';
import { mul, ONE, rat, sum } from '../../../src/solver/rational.js';
import type { ObservationMode } from '../../../src/solver/types.js';
import { readToyState } from './toy/engine.js';
import { scenarioArena } from './toy/fixtures.js';
import type { ToyMon } from './toy/game.js';
import { critOnlyBudget0, hiddenCounterSafe, uturnLine, worldsSplit, type Scenario } from './toy/scenarios.js';

const L1 = { level: 1, critCap: null } as const;
const DISPLAY = { ...L1, mode: 'display' } as const;
const RAM = { ...L1, mode: 'ram' } as const;
const move = (slot: number): Choice => ({ kind: 'move', slot });
const pick = (index: number): Choice => ({ kind: 'switch', index });
const totalOf = (b: Belief): Rational => sum(b.members.map((m) => m.weight));
const keysOf = (b: Belief): string[] => b.members.map((m) => m.member.key);
const p1Hp = (m: Member): number => readToyState(m.state!).p1[0]!.hp;
const p2Hp = (m: Member): number => readToyState(m.state!).p2[0]!.hp;
const firstMember = (b: Belief): Member => b.members[0]!.member;

/** A hidden (display-mode) toy fight, one mon for the player: he sees the enemy's HP bar, not its HP. */
function duel(name: string, hero: ToyMon, party: ToyMon[], segments?: number): Scenario {
  return {
    name, p1: [hero.name], trainerId: name, horizon: 2, expect: {},
    registry: { mons: { [hero.name]: hero }, trainers: { [name]: { id: name, party, ...(segments === undefined ? {} : { hpBarSegments: segments }) } } },
  };
}

const tap = { name: 'Tap', damage: [1] };

// Hero (faster) Chops 4 (1/3) or 5 (2/3): Foe 8 → 4 or 3, bar 1 of 2 either way. Nick 3 or 4 leaves 5 (bar 2) or 4
// (bar 1). A second Chop KOs Foe from 3 or 4 alike and Pup comes in.
const barStep = duel('barStep',
  { name: 'Hero', maxHp: 10, speed: 10, moves: [{ name: 'Chop', damage: [4, 5, 5] }, { name: 'Nick', damage: [3, 4] }] },
  [{ name: 'Foe', maxHp: 8, speed: 5, moves: [tap] }, { name: 'Pup', maxHp: 5, speed: 5, moves: [tap] }], 2);

// Foe (faster) Bashes 2 or 4, doubled on a crit (1/4): crit 2 and normal 4 leave the same state; only the message differs.
const critSame = duel('critSame',
  { name: 'Hero', maxHp: 10, speed: 5, moves: [{ name: 'Strike', damage: [1] }] },
  [{ name: 'Foe', maxHp: 10, speed: 10, moves: [{ name: 'Bash', damage: [2, 4], critChance: rat(1, 4) }] }]);

// Spark has 1 PP: after it, only Tackle is legal.
const ppOut = duel('ppOut',
  { name: 'Hero', maxHp: 10, speed: 10, moves: [{ name: 'Spark', damage: [1], pp: 1 }, { name: 'Tackle', damage: [1] }] },
  [{ name: 'Foe', maxHp: 10, speed: 5, moves: [tap] }]);

/** The only child of an expansion without leaves. */
function onlyChild(x: BeliefExpansion): Belief {
  expect([x.leaves, x.children.length]).toEqual([[], 1]);
  return x.children[0]!.belief;
}

/** The belief at the first battle decision after leading with team index 0. */
function started(arena: Arena, mode: ObservationMode = 'display'): Belief {
  return onlyChild(expandBelief(arena, rootBelief(arena), pick(0), { ...L1, mode }));
}

function scaled(b: Belief, k: Rational): Belief {
  return { ...b, members: b.members.map((m) => ({ ...m, weight: mul(m.weight, k) })) };
}

/** An arena whose every expansion is `successors`. */
function stubArena(successors: Successor[]): Arena {
  return { expand: () => ({ successors, turnConsumed: true }) } as unknown as Arena;
}

/** `real` moved to fight 1 under another key, with the same observations. */
function inFightOne(real: Successor): Successor {
  return { ...real, member: { ...real.member!, key: 'elsewhere', fight: 1 } };
}

/** Child weights plus leaf weights are the parent's total; each child's weight is its members' total. */
function expectExact(parent: Belief, x: BeliefExpansion): void {
  expect(sum([...x.children.map((c) => c.weight), ...x.leaves.map((l) => l.weight)])).toEqual(totalOf(parent));
  for (const c of x.children) expect(c.weight).toEqual(totalOf(c.belief));
}

describe('belief', () => {
  it('root holds every world, and worlds that look alike share one belief', () => {
    const arena = scenarioArena(worldsSplit);
    const root = rootBelief(arena);
    expect(root).toEqual({ key: digest(arena.root().key), members: [{ member: arena.root(), weight: ONE }], fight: 0, phase: 'entry', observation: '' });
    expect(beliefChoices(arena, root)).toEqual([pick(0)]);
    const x = expandBelief(arena, root, pick(0), DISPLAY);
    const b = onlyChild(x);
    const worlds = arena.expand(arena.root(), pick(0), L1).successors;
    expect([x.turnConsumed, x.children[0]!.edge, x.children[0]!.weight]).toEqual([false, edgeLabel(worlds[0]!.observations, 'turnChoice'), ONE]);
    expect(b).toMatchObject({ fight: 0, phase: 'turnChoice', observation: x.children[0]!.edge });
    expect(b.members.map((m) => [readToyState(m.member.state!).p2[0]!.maxHp, m.weight]).sort()).toEqual([[3, rat(1, 2)], [6, rat(1, 2)]]);
    expect(keysOf(b)).toEqual(worlds.map((s) => s.member!.key).sort());   // sorted by key
    expect(b.key).not.toBe(root.key);
    // RAM mode: each world gets its own belief from the first decision.
    expect(expandBelief(arena, root, pick(0), RAM).children.map((c) => c.belief.members.length)).toEqual([1, 1]);
  });

  it('groups members by what the player sees', () => {
    // A hidden sleep counter (2 or 3) makes one two-member belief.
    const counter = scenarioArena(hiddenCounterSafe);
    const x = expandBelief(counter, started(counter), move(0), DISPLAY);
    const asleep = onlyChild(x);
    expect([x.turnConsumed, asleep.phase, beliefChoices(counter, asleep)]).toEqual([true, 'turnChoice', [move(0)]]);
    expect(asleep.members.map((m) => [readToyState(m.member.state!).p1[0]!.sleep, m.weight]).sort()).toEqual([[1, rat(1, 2)], [2, rat(1, 2)]]);

    // Enemy HP within one bar step shares a belief; across a step it splits.
    const bar = scenarioArena(barStep);
    const chop = onlyChild(expandBelief(bar, started(bar), move(0), DISPLAY));
    expect(chop.members.map((m) => [p2Hp(m.member), m.weight]).sort()).toEqual([[3, rat(2, 3)], [4, rat(1, 3)]]);
    expect(expandBelief(bar, started(bar), move(1), DISPLAY).children.map((c) => c.belief.members.map((m) => p2Hp(m.member))).sort()).toEqual([[4], [5]]);

    // One exact state, two screens: the crit message alone tells them apart.
    const crit = scenarioArena(critSame);
    const start = started(crit);
    const split = expandBelief(crit, start, move(0), DISPLAY);
    const edges = split.children.map((c) => c.edge);
    expect([split.leaves, split.children.map((c) => c.belief.members.length), edges]).toEqual([[], [1, 1, 1, 1], [...edges].sort()]);
    const six = split.children.filter((c) => p1Hp(firstMember(c.belief)) === 6);
    const [critHit, normal] = [six.find((c) => c.edge.includes('|-crit|'))!, six.find((c) => !c.edge.includes('|-crit|'))!];
    expect([critHit.belief.key === normal.belief.key, critHit.edge === normal.edge, critHit.weight, normal.weight]).toEqual([true, false, rat(1, 8), rat(3, 8)]);

    // An observation that hides the fight is an engine bug: the group throws, naming the edge.
    const real = crit.expand(firstMember(start), move(0), L1).successors[0]!;
    expect(() => expandBelief(stubArena([real, inFightOne(real)]), start, move(0), DISPLAY)).toThrow(JSON.stringify(edgeLabel(real.observations, real.phase!)));
  });

  it('ram mode gives singletons keyed by the member', () => {
    const arena = scenarioArena(hiddenCounterSafe);
    const start = started(arena, 'ram');
    const ram = expandBelief(arena, start, move(0), RAM);
    const observations = arena.expand(firstMember(start), move(0), L1).successors[0]!.observations;
    const want = (key: string) => [1, edgeLabel(observations, 'turnChoice', key), edgeLabel(observations, 'turnChoice', key), digest(key), rat(1, 2)];
    expect(ram.children.map((c) => [c.belief.members.length, c.edge, c.belief.observation, c.belief.key, c.weight])).toEqual(ram.children.map((c) => want(firstMember(c.belief).key)));
    expect(ram.children.map((c) => firstMember(c.belief).key).sort()).toEqual(keysOf(onlyChild(expandBelief(arena, start, move(0), DISPLAY))));
  });

  it('keeps weights exact and unnormalised, merging equal members', () => {
    // critOnlyBudget0: Bash crits (1/4, Hero 1) or not (Hero 4); from Hero at 4 a crit kills, else Strike wins.
    const arena = scenarioArena(critOnlyBudget0);
    const start = started(arena);
    const first = expandBelief(arena, start, move(0), DISPLAY);
    expectExact(start, first);
    expect(first.children.map((c) => [p1Hp(firstMember(c.belief)), c.weight]).sort()).toEqual([[1, rat(1, 4)], [4, rat(3, 4)]]);
    const calm = first.children.find((c) => p1Hp(firstMember(c.belief)) === 4)!.belief;
    const second = expandBelief(arena, calm, move(0), DISPLAY);
    expectExact(calm, second);
    // Each leaf: the member's weight times the successor's probability, in successor order.
    expect([second.children, second.leaves.map((l) => [l.result, l.weight, l.successor.probability, l.from])]).toEqual([[], [
      ['dead', rat(3, 16), rat(1, 4), firstMember(calm)], ['win', rat(9, 16), rat(3, 4), firstMember(calm)],
    ]]);

    // Two members, one leaf each, in member order.
    const worlds = scenarioArena(worldsSplit);
    const both = onlyChild(expandBelief(worlds, rootBelief(worlds), pick(0), DISPLAY));
    const quick = expandBelief(worlds, both, move(0), DISPLAY);
    expectExact(both, quick);
    expect(quick.leaves.map((l) => [l.from.key, readToyState(l.from.state!).p2[0]!.maxHp === 3 ? 'win' : 'dead', l.weight])).toEqual(both.members.map((m, i) => [m.member.key, quick.leaves[i]!.result, rat(1, 2)]));

    // Scaling the parent scales every child; keys and weightsKey (each weight over the total) do not change.
    const bar = scenarioArena(barStep);
    const begin = started(bar);
    const chop = onlyChild(expandBelief(bar, begin, move(0), DISPLAY));
    const small = expandBelief(bar, scaled(begin, rat(3, 7)), move(0), DISPLAY);
    expectExact(scaled(begin, rat(3, 7)), small);
    expect([small.children.map((c) => c.weight), small.children[0]!.belief.key, weightsKey(small.children[0]!.belief)]).toEqual([[rat(3, 7)], chop.key, weightsKey(chop)]);
    expect(weightsKey(chop)).toBe(chop.members.map((m) => (p2Hp(m.member) === 4 ? '1/3' : '2/3')).join(','));

    // Equal member keys merge: the second Chop KOs Foe from 4 and from 3 alike.
    const ko = expandBelief(bar, chop, move(0), DISPLAY);
    expectExact(chop, ko);
    const pup = onlyChild(ko);
    expect([pup.members.map((m) => m.weight), readToyState(firstMember(pup).state!).active.p2, pup.key]).toEqual([[ONE], 1, digest(firstMember(pup).key)]);
  });

  it('beliefChoices intersects the members\' choices, in the first member\'s order', () => {
    const lead = scenarioArena(uturnLine);
    expect(beliefChoices(lead, rootBelief(lead))).toEqual([pick(0), pick(1)]);
    const arena = scenarioArena(ppOut);
    const fresh = started(arena);
    const spent = onlyChild(expandBelief(arena, fresh, move(0), DISPLAY));   // Spark's only PP
    const members = [...fresh.members, ...spent.members].sort((a, b) => (a.member.key < b.member.key ? -1 : 1));
    const mixed: Belief = { ...fresh, key: 'mixed', members };
    expect([beliefChoices(arena, fresh), beliefChoices(arena, spent), beliefChoices(arena, mixed)]).toEqual([[move(0), move(1)], [move(1)], [move(1)]]);
    const [one, two] = members.map((m) => m.member);
    const orders: Record<string, Choice[]> = { [one!.key]: [move(1), move(0), pick(1)], [two!.key]: [pick(1), move(0)] };
    expect(beliefChoices({ choices: (m: Member) => orders[m.key]! } as unknown as Arena, mixed)).toEqual([move(0), pick(1)]);
  });

  it('keep drops successors before grouping', () => {
    const arena = scenarioArena(critOnlyBudget0);
    const start = started(arena);
    const asked: Member[] = [];
    const noCrits = (s: Successor, from: Member): boolean => {
      asked.push(from);
      return s.critsAdded === 0;
    };
    const first = expandBelief(arena, start, move(0), { ...DISPLAY, keep: noCrits });
    expect(asked).toEqual([firstMember(start), firstMember(start)]);   // asked about every successor
    const calm = onlyChild(first);
    expect([first.children[0]!.weight, p1Hp(firstMember(calm))]).toEqual([rat(3, 4), 4]);
    const second = expandBelief(arena, calm, move(0), { ...DISPLAY, keep: noCrits });
    expect([second.children, second.leaves.map((l) => [l.result, l.weight])]).toEqual([[], [['win', rat(9, 16)]]]);
    // A rejected successor never reaches a group, so it cannot make one throw.
    const real = arena.expand(firstMember(start), move(0), L1).successors[0]!;
    const kept = expandBelief(stubArena([real, inFightOne(real)]), start, move(0), { ...DISPLAY, keep: (s) => s.member?.fight === 0 });
    expect(kept.children.map((c) => keysOf(c.belief))).toEqual([[real.member!.key]]);
  });

  it('restrict keeps the matching members under the member set\'s key', () => {
    const arena = scenarioArena(barStep);
    const start = started(arena);
    const chop = onlyChild(expandBelief(arena, start, move(0), DISPLAY));
    const four = restrict(chop, (m) => p2Hp(m) === 4)!;
    expect(four).toMatchObject({ fight: chop.fight, phase: chop.phase, observation: chop.observation, members: [{ weight: rat(1, 3) }] });   // unnormalised
    expect(weightsKey(four)).toBe('1/1');
    const ram = expandBelief(arena, start, move(0), RAM).children.find((c) => p2Hp(firstMember(c.belief)) === 4)!;
    expect([four.key === ram.belief.key, four.key === chop.key]).toEqual([true, false]);
    expect([restrict(chop, () => true), restrict(chop, () => false)]).toEqual([chop, null]);
  });
});
