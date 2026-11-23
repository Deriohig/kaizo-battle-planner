// Beliefs: the exact states the player cannot tell apart. A belief is the set of members that share
// one observation history: hidden worlds, hidden counters and enemy HP within one bar step land in the same belief.
// Every member of a belief shares the history so far, so grouping its successors by the edge label (the observations
// since the player's last decision plus the next decision's phase kind) groups them by the whole history. The player's choice is
// made per belief, never per member: expandBelief applies one choice to every member. Grouping finer than the screen
// would let a proof branch on what the player cannot see (unsound); coarser is sound but loses proofs. `ram` mode (the player reads
// RAM) adds the member key to the label, so every belief is one exact state.
//
// Weights are unnormalised path probabilities (risk only; safety never reads them). Members are distinct by key (the
// weights of duplicates add) and sorted by key (plain string order); children are sorted by edge; leaves keep member
// order, then successor order.

import type { Choice, Rational } from '../contracts/engine.js';
import type { Arena, Member, Successor } from './arena.js';
import { edgeLabel } from './edge.js';
import { choiceText, digest } from './keys.js';
import { add, div, mul, ONE, sum, toJson } from './rational.js';
import type { DecisionPhase, Level, ObservationMode } from './types.js';

export interface WeightedMember { member: Member; weight: Rational }   // weight: unnormalised path probability (used by risk only)
export interface Belief {
  key: string;                       // digest of the sorted, distinct member keys (weights excluded)
  members: WeightedMember[];         // distinct by member.key (weights of duplicates add), sorted by key
  fight: number; phase: DecisionPhase;
  observation: string;               // the edge label that led here ('' for the root)
}
export interface BeliefLeaf { result: 'win' | 'dead' | 'unlabelled'; weight: Rational; successor: Successor; from: Member }
export interface BeliefChild {
  edge: string; belief: Belief; weight: Rational;   // weight = the sum of its members' weights
  crit: boolean;                                     // some successor grouped here has critsAdded > 0 (fail-first ordering)
  representative: Successor;                         // the first successor grouped here (member order, then successor order): its `last` labels the edge
}
export interface BeliefExpansion { turnConsumed: boolean; leaves: BeliefLeaf[]; children: BeliefChild[] } // children sorted by edge

/**
 * `stop`: the searching caller's deadline and signal as one poll, handed to every member's expansion (arena.ts: an
 * expansion it ends throws ArenaStopError); absent, nothing stops it (a replay after the search).
 */
export interface BeliefOpts { level: Level; critCap: number | null; mode: ObservationMode; keep?: (s: Successor, from: Member) => boolean; stop?: () => boolean }

/** A continue successor waiting for its group: the member, its scaled weight, the phase it decides at and the successor. */
interface Arrival { member: Member; weight: Rational; phase: DecisionPhase; successor: Successor }

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `members` must already be distinct and sorted by key. Member keys are base64url, so '\n' cannot occur in one. */
function beliefOf(members: WeightedMember[], fight: number, phase: DecisionPhase, observation: string): Belief {
  return { key: digest(members.map((m) => m.member.key).join('\n')), members, fight, phase, observation };
}

/** The root: the arena's root entry member alone, weight ONE. */
export function rootBelief(arena: Arena): Belief {
  const root = arena.root();
  return beliefOf([{ member: root, weight: ONE }], root.fight, 'entry', '');
}

/** The choices legal for every member (compared by choiceText), in the first member's order. */
export function beliefChoices(arena: Arena, belief: Belief): Choice[] {
  const [first, ...rest] = belief.members;
  if (first === undefined) throw new Error('belief: no members');
  let choices = arena.choices(first.member);
  for (const { member } of rest) {
    const legal = new Set(arena.choices(member).map(choiceText));
    choices = choices.filter((c) => legal.has(choiceText(c)));
  }
  return choices;
}

/**
 * One choice for the whole belief. Each member's successors are scaled by its weight; `keep` sees every successor first
 * and the rejected ones are dropped. Win, dead and unlabelled successors become leaves; continue successors are grouped
 * by edge label (plus the member key in `ram` mode) into child beliefs.
 */
export function expandBelief(arena: Arena, belief: Belief, choice: Choice, opts: BeliefOpts): BeliefExpansion {
  const leaves: BeliefLeaf[] = [];
  const groups = new Map<string, Arrival[]>();
  let turnConsumed: boolean | null = null;
  const expandOpts = { level: opts.level, critCap: opts.critCap, ...(opts.stop === undefined ? {} : { stop: opts.stop }) };
  for (const { member: from, weight } of belief.members) {
    const expansion = arena.expand(from, choice, expandOpts);
    if (turnConsumed === null) turnConsumed = expansion.turnConsumed;
    else if (turnConsumed !== expansion.turnConsumed) throw new Error(`belief: members disagree on whether ${choiceText(choice)} consumes a turn`);
    for (const s of expansion.successors) {
      if (opts.keep !== undefined && !opts.keep(s, from)) continue;
      const scaled = mul(weight, s.probability);
      if (s.result !== 'continue') {
        leaves.push({ result: s.result, weight: scaled, successor: s, from });
        continue;
      }
      if (s.member === null || s.phase === null) throw new Error('belief: a continue successor without a member or a phase');
      const edge = opts.mode === 'ram' ? edgeLabel(s.observations, s.phase, s.member.key) : edgeLabel(s.observations, s.phase);
      const arrival: Arrival = { member: s.member, weight: scaled, phase: s.phase, successor: s };
      const group = groups.get(edge);
      if (group === undefined) groups.set(edge, [arrival]);
      else group.push(arrival);
    }
  }
  if (turnConsumed === null) throw new Error('belief: no members');
  const children = [...groups.keys()].sort(byText).map((edge) => childOf(edge, groups.get(edge)!));
  return { turnConsumed, leaves, children };
}

/** One group's child belief. Members that disagree on the fight or the phase mean the observation hid it: an engine bug. */
function childOf(edge: string, arrivals: Arrival[]): BeliefChild {
  const { member: { fight }, phase } = arrivals[0]!;
  if (arrivals.some((a) => a.member.fight !== fight)) throw new Error(`belief: members at edge ${JSON.stringify(edge)} disagree on the fight`);
  if (arrivals.some((a) => a.phase !== phase)) throw new Error(`belief: members at edge ${JSON.stringify(edge)} disagree on the phase`);
  const byKey = new Map<string, WeightedMember>();
  for (const { member, weight } of arrivals) {
    const seen = byKey.get(member.key);
    byKey.set(member.key, seen === undefined ? { member, weight } : { member: seen.member, weight: add(seen.weight, weight) });
  }
  const members = [...byKey.values()].sort((a, b) => byText(a.member.key, b.member.key));
  return {
    edge, belief: beliefOf(members, fight, phase, edge), weight: sum(members.map((m) => m.weight)),
    crit: arrivals.some((a) => a.successor.critsAdded > 0), representative: arrivals[0]!.successor,
  };
}

/** Each weight over the belief's total, as toJson strings joined by ',', in member order. */
export function weightsKey(belief: Belief): string {
  const total = sum(belief.members.map((m) => m.weight));
  return belief.members.map((m) => toJson(div(m.weight, total))).join(',');
}

/** The members `pred` accepts, weights unchanged, with the key recomputed; null when none is left. */
export function restrict(belief: Belief, pred: (m: Member) => boolean): Belief | null {
  const members = belief.members.filter((m) => pred(m.member));
  return members.length === 0 ? null : beliefOf(members, belief.fight, belief.phase, belief.observation);
}
