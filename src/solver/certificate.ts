// The certificate: a line as a finite controller. Each node holds one
// action of the player's; its edges are labelled by what he sees next (edge.ts: the observations since his decision plus the
// next decision's phase kind) and lead to the next node. The next node depends only on the edge label, so the policy is
// a function of the observation history by construction. The checker (check/checker.ts) replays it on the engine in
// every world without trusting the search.
//
// Proof certificates (extractProof): one node per belief key. A node's action is the prover's table win entry for that
// belief when the prover would reuse it (within the turns left; in an earlier fight, proven with a per-fight horizon of
// at most the certificate's); otherwise the belief is re-proved with prover.prove at the turns left. A belief reached
// again with fewer turns left than its action's depth is re-proved there and its children redone: the new win holds
// with more turns too, so it serves every visit. Children come from expandBelief with the prover's own options (level,
// critCap, mode and the G_j crit filter), so the certificate covers exactly the successors the proof did.
// Risk certificates (certificateFromPolicy): one node per (belief key, weightsKey, turns left), holding the policy's
// answer. A null answer is a cut-off (no node, no edge), and so is a turnChoice with no turn left, which is never asked.
// A G_j risk line expands with critCap j + 1 and no filter: past j crits it still has nodes. An action the arena cannot
// expand (an engine LIMIT: the risk search keeps one when every choice there is limited) gets a node without edges; the
// checker meets the same LIMIT there and fails that path with reason engineLimit.
// Turns left: a turnChoice node consumes one turn for its children; entry and playerMidTurnSwitch nodes don't; a later
// fight's entry starts again with `horizon`.
// Nodes are numbered breadth-first from the root (node 0, the fight-0 entry), children in edge order, so the same input
// gives the same certificate and the same text. Two edges may lead to one node (one belief behind two screens).

import type { Choice, Rational } from '../contracts/engine.js';
import { ArenaLimitError, type Arena, type Member, type Successor } from './arena.js';
import {
  beliefChoices, expandBelief, rootBelief, weightsKey, type Belief, type BeliefChild, type BeliefExpansion, type BeliefOpts,
} from './belief.js';
import { edgeLabel } from './edge.js';
import { engineOrder } from './inputs.js';
import { choiceText } from './keys.js';
import { gameExpandOptions, type ProofResult, type Prover } from './prove.js';
import { fromJson, minR, mul, ONE, toJson } from './rational.js';
import type { TTEntry } from './tt.js';
import type { Bound, DecisionPhase, Level, ObservationMode, Thresholds } from './types.js';

export interface CertNode {
  id: number;                          // index in Certificate.nodes; 0 = the root (fight 0 entry)
  phase: DecisionPhase; fight: number; observation: string;
  action: Choice;
  edges: Record<string, number>;       // edge label → child node id, for every child decision belief of (this belief, action)
}
export interface Certificate {
  kind: 'proof' | 'risk';              // proof: tier 1 or a G_j proof; risk: tier 2/3 lines
  level: Level; mode: ObservationMode; horizon: number;   // horizon per fight
  critBudget: number | null;           // proof: null (tier 1) or j; risk: the G_j constraint used (null for tier 3)
  thresholds: Thresholds | null;
  engineId: string; aiId: string; fights: number;
  nodes: CertNode[];
}
export interface CertificateStats {
  minHpFrac: Rational; totalHp: number; pp: number;   // worst case over the win leaves the certificate reaches
  turns: number;                                      // most turns used in any fight
  chanceDependencies: number;                         // decision nodes' chance branch points (edges beyond the first per enemy action) plus switch actions
  participants: number[];                             // canonical team indices that ever enter battle (lead and switch targets)
}

type Win = Extract<TTEntry, { kind: 'win' }>;

/** A proof node in the making: its action, the depth its win holds within, the turn it takes, and its children. */
interface Won { action: Choice; depth: number; step: number; children: BeliefChild[] }

/** Turns left at `belief` when its parent leaves `h`: a later fight's entry starts again with `horizon`. */
export function turnsLeft(belief: Belief, h: number, horizon: number): number {
  return belief.phase === 'entry' && belief.fight > 0 ? horizon : h;
}

function checkStart(root: Belief, horizon: number): void {
  if (!Number.isInteger(horizon) || horizon < 1) throw new RangeError(`certificate: horizon must be a positive integer, got ${horizon}`);
  if (root.phase !== 'entry' || root.fight !== 0) throw new Error(`certificate: the root must be the fight-0 entry, got fight ${root.fight} at ${root.phase}`);
}

function nodeOf(id: number, belief: Belief, action: Choice, edges: Record<string, number>): CertNode {
  return { id, phase: belief.phase, fight: belief.fight, observation: belief.observation, action, edges };
}

function why(r: Exclude<ProofResult, { kind: 'win' }>): string {
  return r.kind === 'fail' ? r.refutation.join(' → ') : r.cause;
}

/**
 * The action at `belief` with `h` turns left (prover.H is the certificate's horizon): the table's win entry when the
 * prover would reuse it, else the entry prover.prove(belief, h) leaves.
 */
function winAt(prover: Prover, arena: Arena, belief: Belief, h: number): { action: Choice; depth: number } {
  const last = arena.fights.length - 1;
  const usable = (e: TTEntry | undefined): e is Win => e?.kind === 'win' && e.depth <= h && (belief.fight === last || e.H <= prover.H);
  const before = prover.tt.get(belief.key);
  if (usable(before)) return { action: before.action, depth: before.depth };
  const r = prover.prove(belief, h);
  if (r.kind !== 'win') throw new Error(`certificate: fight ${belief.fight} ${belief.phase} belief ${belief.key} is not won within ${h} turns: ${why(r)}`);
  const after = prover.tt.get(belief.key);
  if (usable(after)) return { action: after.action, depth: after.depth };
  // The table kept an older win with a smaller depth that was proven with a larger per-fight horizon (prover.H has been
  // lowered since), so the win just found is not stored: find its action here, over every legal choice (a stale entry
  // at a restricted root would ignore restrictRoot, which is the prover's own business).
  for (const a of beliefChoices(arena, belief)) {
    const ra = prover.proveAction(belief, a, h);
    if (ra.kind === 'win') return { action: a, depth: ra.depth };
    if (ra.kind === 'unknown') throw new Error(`certificate: belief ${belief.key} could not be re-proved: ${ra.cause}`);
  }
  throw new Error(`certificate: belief ${belief.key} is won within ${h} turns, yet no choice proves again`);
}

/** Proof nodes breadth-first from the root, one per belief key. */
function numberProof(root: Belief, won: Map<string, Won>): CertNode[] {
  const ids = new Map<string, number>([[root.key, 0]]);
  const order: Belief[] = [root];
  const nodes: CertNode[] = [];
  for (let id = 0; id < order.length; id++) {
    const belief = order[id]!;
    const w = won.get(belief.key);
    if (w === undefined) throw new Error(`certificate: belief ${belief.key} was never extracted`);
    const edges: Record<string, number> = {};
    for (const child of w.children) {
      let next = ids.get(child.belief.key);
      if (next === undefined) {
        next = order.length;
        ids.set(child.belief.key, next);
        order.push(child.belief);
      }
      edges[child.edge] = next;
    }
    nodes.push(nodeOf(id, belief, w.action, edges));
  }
  return nodes;
}

/**
 * The proven strategy from `root` (the fight-0 entry) at per-fight horizon `horizon`, read from `prover`'s table and
 * re-proved where an entry is missing, too deep or proven with a larger horizon. Throws when a belief is not won.
 * prover.H is `horizon` while extracting and restored afterwards.
 */
export function extractProof(prover: Prover, root: Belief, horizon: number): Certificate {
  checkStart(root, horizon);
  const { arena, opts } = prover.expansion();
  const saved = prover.H;
  prover.H = horizon;
  try {
    const won = new Map<string, Won>();
    const fewest = new Map<string, number>();   // belief key → the fewest turns left it was processed with
    const queue: { belief: Belief; h: number }[] = [{ belief: root, h: horizon }];
    for (let i = 0; i < queue.length; i++) {
      const { belief } = queue[i]!;
      const h = turnsLeft(belief, queue[i]!.h, horizon);
      const seen = fewest.get(belief.key);
      if (seen !== undefined && seen <= h) continue;   // its action and children already hold with these turns
      fewest.set(belief.key, h);
      let w = won.get(belief.key);
      if (w === undefined || w.depth > h) {
        const { action, depth } = winAt(prover, arena, belief, h);
        const x = expandBelief(arena, belief, action, opts);
        w = { action, depth, step: x.turnConsumed ? 1 : 0, children: x.children };
        won.set(belief.key, w);
      }
      for (const child of w.children) queue.push({ belief: child.belief, h: h - w.step });
    }
    return {
      kind: 'proof', level: prover.params.level, mode: opts.mode, horizon, critBudget: prover.params.critBudget,
      thresholds: prover.params.thresholds, engineId: arena.engineId, aiId: arena.aiId, fights: arena.fights.length,
      nodes: numberProof(root, won),
    };
  } finally {
    prover.H = saved;
  }
}

/** A risk line's expansion: G_j caps crits at j + 1 but keeps every successor (the line goes on past j crits). */
function riskExpandOptions(level: Level, critBudget: number | null, mode: ObservationMode): BeliefOpts {
  return { level, critCap: critBudget === null ? null : critBudget + 1, mode };
}

/**
 * A risk line's controller: `policy(belief, hLeft)` at every reachable decision, one node per (belief key, weightsKey,
 * hLeft); a null answer, or a turnChoice with no turn left (never asked), is a cut-off. Throws when the root has none.
 */
export function certificateFromPolicy(arena: Arena, root: Belief,
  policy: (belief: Belief, hLeft: number) => Choice | null,
  opts: { level: Level; mode: ObservationMode; horizon: number; critBudget: number | null }): Certificate {
  checkStart(root, opts.horizon);
  const j = opts.critBudget;
  if (j !== null && (!Number.isInteger(j) || j < 0)) throw new RangeError(`certificate: critBudget must be null or a non-negative integer, got ${j}`);
  const expandOpts = riskExpandOptions(opts.level, j, opts.mode);
  const ids = new Map<string, number | null>();
  const order: { belief: Belief; h: number; action: Choice }[] = [];
  const nodeFor = (belief: Belief, h: number): number | null => {
    if (belief.phase === 'turnChoice' && h <= 0) return null;
    const identity = `${belief.key}|${weightsKey(belief)}|${h}`;
    const known = ids.get(identity);
    if (known !== undefined) return known;
    const action = policy(belief, h);
    const id = action === null ? null : order.length;
    ids.set(identity, id);
    if (action !== null) order.push({ belief, h, action });
    return id;
  };
  if (nodeFor(root, opts.horizon) === null) throw new Error('certificate: the policy has no action at the root');
  const nodes: CertNode[] = [];
  for (let id = 0; id < order.length; id++) {
    const { belief, h, action } = order[id]!;
    let x: BeliefExpansion;
    try {
      x = expandBelief(arena, belief, action, expandOpts);
    } catch (e) {
      if (!(e instanceof ArenaLimitError)) throw e;
      nodes.push(nodeOf(id, belief, action, {}));
      continue;
    }
    const left = h - (x.turnConsumed ? 1 : 0);
    const edges: Record<string, number> = {};
    for (const child of x.children) {
      const next = nodeFor(child.belief, turnsLeft(child.belief, left, opts.horizon));
      if (next !== null) edges[child.edge] = next;
    }
    nodes.push(nodeOf(id, belief, action, edges));
  }
  return {
    kind: 'risk', level: opts.level, mode: opts.mode, horizon: opts.horizon, critBudget: j, thresholds: null,
    engineId: arena.engineId, aiId: arena.aiId, fights: arena.fights.length, nodes,
  };
}

/** How `cert` was expanded: a proof as its game (gameExpandOptions, with the G_j filter), a risk line without a filter. */
export function certificateOptions(cert: Certificate): BeliefOpts {
  return cert.kind === 'proof'
    ? gameExpandOptions({ level: cert.level, critBudget: cert.critBudget, thresholds: cert.thresholds }, cert.mode)
    : riskExpandOptions(cert.level, cert.critBudget, cert.mode);
}

/** The canonical team index `action` sends into battle for `member`: the lead at an entry, a switch's target in battle. */
function entering(arena: Arena, member: Member, action: Choice): number | null {
  if (action.kind !== 'switch') return null;
  if (member.kind === 'entry') return action.index;
  if (member.lead === null) throw new Error(`certificate: battle member ${member.key} has no lead`);
  const team = arena.fights[member.fight]!.team.length;
  const canonical = engineOrder(team, member.lead)[action.index];
  if (canonical === undefined) throw new RangeError(`certificate: a switch to engine position ${action.index} in a team of ${team}`);
  return canonical;
}

/** A successor `opts` keeps: its member, its weight (the member's × its probability) and its edge label (continue only). */
export interface Settled { from: Member; weight: Rational; successor: Successor; edge: string | null }

/**
 * The successors of `action` at `belief` that `opts.keep` accepts (all without one), in member order then successor
 * order, with expandBelief's edge labels; each edge is checked against `children` (the same expansion's).
 */
export function settledSuccessors(arena: Arena, belief: Belief, action: Choice, opts: BeliefOpts, children: BeliefChild[]): Settled[] {
  const known = new Set(children.map((c) => c.edge));
  const out: Settled[] = [];
  for (const { member, weight } of belief.members) {
    for (const s of arena.expand(member, action, { level: opts.level, critCap: opts.critCap }).successors) {
      if (opts.keep !== undefined && !opts.keep(s, member)) continue;
      let edge: string | null = null;
      if (s.result === 'continue') {
        if (s.member === null || s.phase === null) throw new Error('certificate: a continue successor without a member or a phase');
        edge = opts.mode === 'ram' ? edgeLabel(s.observations, s.phase, s.member.key) : edgeLabel(s.observations, s.phase);
        if (!known.has(edge)) throw new Error(`certificate: edge ${JSON.stringify(edge)} is not one of the expansion's`);
      }
      out.push({ from: member, weight: mul(weight, s.probability), successor: s, edge });
    }
  }
  return out;
}

/** The AI's first choice on a successor's settled path as a group key: '' when it has none. */
export function aiGroupKey(s: Successor): string {
  const first = s.aiChoices[0];
  return first === undefined ? '' : choiceText(first);
}

/**
 * A node's chance branch points: its successors (after the crit filter) grouped by the AI's first choice (one group
 * when there is none), each group counting its distinct edges beyond the first. Edges are expandBelief's labels; each
 * one is checked against the expansion's children.
 */
function branchPoints(arena: Arena, belief: Belief, action: Choice, opts: BeliefOpts, children: BeliefChild[]): number {
  const groups = new Map<string, Set<string>>();
  for (const { successor, edge } of settledSuccessors(arena, belief, action, opts, children)) {
    if (edge === null) continue;
    const group = aiGroupKey(successor);
    const edges = groups.get(group);
    if (edges === undefined) groups.set(group, new Set([edge]));
    else edges.add(edge);
  }
  let points = 0;
  for (const edges of groups.values()) points += edges.size - 1;
  return points;
}

/**
 * Figures of `cert` walked on `arena` from its root entry with the certificate's own level, crit cap and (proofs only)
 * crit filter. Win-leaf figures are each the minimum over the win leaves reached (ONE, +∞, +∞ when none is reached).
 * A proof missing an edge for a reachable observation throws; a risk line's missing edge is a cut-off.
 */
export function certificateStats(arena: Arena, cert: Certificate): CertificateStats {
  const opts = certificateOptions(cert);
  let minHpFrac: Rational | null = null;
  let totalHp = Number.POSITIVE_INFINITY;
  let pp = Number.POSITIVE_INFINITY;
  let turns = 0;
  let chanceDependencies = 0;
  const participants = new Set<number>();
  const counted = new Set<number>();   // nodes whose branch points are counted (once per node)
  const visited = new Set<string>();   // node | belief | turns played: the same subtree gives the same figures
  const stack: { belief: Belief; id: number }[] = [{ belief: rootBelief(arena), id: 0 }];
  while (stack.length > 0) {
    const { belief, id } = stack.pop()!;
    const node = cert.nodes[id];
    if (node === undefined) throw new Error(`certificate: no node ${id}`);
    if (node.phase !== belief.phase || node.fight !== belief.fight) {
      throw new Error(`certificate: node ${id} is fight ${node.fight} at ${node.phase}, but the walk is at fight ${belief.fight} ${belief.phase}`);
    }
    const played = belief.members.reduce((most, m) => Math.max(most, m.member.turnsInFight), 0);
    const memo = `${id}|${belief.key}|${played}`;
    if (visited.has(memo)) continue;
    visited.add(memo);
    for (const { member } of belief.members) {
      const index = entering(arena, member, node.action);
      if (index !== null) participants.add(index);
    }
    const x = expandBelief(arena, belief, node.action, opts);
    turns = Math.max(turns, played + (x.turnConsumed ? 1 : 0));
    if (!counted.has(id)) {
      counted.add(id);
      const switched = belief.phase !== 'entry' && node.action.kind === 'switch' ? 1 : 0;   // a lead is not a switch
      chanceDependencies += branchPoints(arena, belief, node.action, opts, x.children) + switched;
    }
    for (const leaf of x.leaves) {
      if (leaf.result !== 'win') continue;
      if (leaf.successor.endCarry === null) throw new Error('certificate: a win leaf without an end carry');
      const m = arena.metrics(leaf.successor.endCarry);
      minHpFrac = minHpFrac === null ? m.minHpFrac : minR(minHpFrac, m.minHpFrac);
      totalHp = Math.min(totalHp, m.totalHp);
      pp = Math.min(pp, m.pp);
    }
    for (const child of x.children) {
      const next = node.edges[child.edge];
      if (next !== undefined) stack.push({ belief: child.belief, id: next });
      else if (cert.kind === 'proof') throw new Error(`certificate: proof node ${id} has no edge for ${JSON.stringify(child.edge)}`);
    }
  }
  return { minHpFrac: minHpFrac ?? ONE, totalHp, pp, turns, chanceDependencies, participants: [...participants].sort((a, b) => a - b) };
}

interface BoundJson<T> { value: T; strict: boolean }
interface ThresholdsJson { minHpFrac?: BoundJson<string>; totalHp?: BoundJson<number>; pp?: BoundJson<number> }

function thresholdsJson(t: Thresholds | null): ThresholdsJson | null {
  if (t === null) return null;
  const out: ThresholdsJson = {};
  if (t.minHpFrac !== undefined) out.minHpFrac = { value: toJson(t.minHpFrac.value), strict: t.minHpFrac.strict };
  if (t.totalHp !== undefined) out.totalHp = { value: t.totalHp.value, strict: t.totalHp.strict };
  if (t.pp !== undefined) out.pp = { value: t.pp.value, strict: t.pp.strict };
  return out;
}

/** JSON with a fixed key order; Rationals as toJson strings. */
export function serializeCertificate(cert: Certificate): string {
  return JSON.stringify({
    kind: cert.kind, level: cert.level, mode: cert.mode, horizon: cert.horizon, critBudget: cert.critBudget,
    thresholds: thresholdsJson(cert.thresholds), engineId: cert.engineId, aiId: cert.aiId, fights: cert.fights,
    nodes: cert.nodes.map((n) => ({ id: n.id, phase: n.phase, fight: n.fight, observation: n.observation, action: n.action, edges: n.edges })),
  });
}

const PHASES: readonly unknown[] = ['entry', 'turnChoice', 'playerMidTurnSwitch'] satisfies DecisionPhase[];

function malformed(what: string): never {
  throw new SyntaxError(`certificate: ${what}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0;
}

function parseChoice(v: unknown, at: string): Choice {
  if (isObject(v)) {
    if (v.kind === 'move' && isCount(v.slot)) return v as unknown as Choice;
    if (v.kind === 'switch' && isCount(v.index)) return v as unknown as Choice;
    const slots = v.consumeSlots;
    if (v.kind === 'item' && typeof v.item === 'string' && (slots === undefined || (Array.isArray(slots) && slots.every(isCount)))
      && (v.effect === undefined || isObject(v.effect))) return v as unknown as Choice;
  }
  return malformed(`${at}: bad action ${JSON.stringify(v)}`);
}

function parseBound<T>(v: unknown, what: string, value: (x: unknown) => T): Bound<T> {
  if (!isObject(v) || typeof v.strict !== 'boolean') return malformed(`bad thresholds.${what}`);
  return { value: value(v.value), strict: v.strict };
}

function parseThresholds(v: unknown): Thresholds | null {
  if (v === null) return null;
  if (!isObject(v)) return malformed('bad thresholds');
  const count = (what: string) => (x: unknown): number => (Number.isFinite(x) ? x as number : malformed(`bad thresholds.${what}`));
  const out: Thresholds = {};
  if (v.minHpFrac !== undefined) {
    out.minHpFrac = parseBound(v.minHpFrac, 'minHpFrac', (x) => {
      try {
        return typeof x === 'string' ? fromJson(x) : malformed('bad thresholds.minHpFrac');
      } catch {
        return malformed('bad thresholds.minHpFrac');
      }
    });
  }
  if (v.totalHp !== undefined) out.totalHp = parseBound(v.totalHp, 'totalHp', count('totalHp'));
  if (v.pp !== undefined) out.pp = parseBound(v.pp, 'pp', count('pp'));
  return out;
}

function parseNode(v: unknown, index: number, count: number, fights: number): CertNode {
  const at = `node ${index}`;
  if (!isObject(v)) return malformed(`${at} is not an object`);
  const { id, phase, fight, observation, action, edges } = v;
  if (id !== index) malformed(`${at} has id ${JSON.stringify(id)}`);
  if (!PHASES.includes(phase)) malformed(`${at}: bad phase ${JSON.stringify(phase)}`);
  if (!isCount(fight) || fight >= fights) return malformed(`${at}: bad fight ${JSON.stringify(fight)}`);
  if (typeof observation !== 'string') return malformed(`${at}: bad observation`);
  if (!isObject(edges)) return malformed(`${at}: bad edges`);
  for (const [edge, next] of Object.entries(edges)) {
    if (!isCount(next) || next >= count) malformed(`${at}: edge ${JSON.stringify(edge)} leads to ${JSON.stringify(next)}`);
  }
  return { id: index, phase: phase as DecisionPhase, fight, observation, action: parseChoice(action, at), edges: edges as Record<string, number> };
}

/** The inverse of serializeCertificate. Throws SyntaxError on malformed text or a malformed certificate. */
export function parseCertificate(text: string): Certificate {
  const v: unknown = JSON.parse(text);
  if (!isObject(v)) return malformed('not an object');
  const { kind, level, mode, horizon, critBudget, thresholds, engineId, aiId, fights, nodes } = v;
  if (kind !== 'proof' && kind !== 'risk') return malformed(`bad kind ${JSON.stringify(kind)}`);
  if (level !== 1 && level !== 2) return malformed(`bad level ${JSON.stringify(level)}`);
  if (mode !== 'display' && mode !== 'ram') return malformed(`bad mode ${JSON.stringify(mode)}`);
  if (!isCount(horizon) || horizon < 1) return malformed(`bad horizon ${JSON.stringify(horizon)}`);
  if (critBudget !== null && !isCount(critBudget)) return malformed(`bad critBudget ${JSON.stringify(critBudget)}`);
  if (typeof engineId !== 'string' || typeof aiId !== 'string') return malformed('bad engineId or aiId');
  if (!isCount(fights) || fights < 1) return malformed(`bad fights ${JSON.stringify(fights)}`);
  if (!Array.isArray(nodes) || nodes.length === 0) return malformed('no nodes');
  const parsed = nodes.map((n: unknown, i) => parseNode(n, i, nodes.length, fights));
  if (parsed[0]!.phase !== 'entry' || parsed[0]!.fight !== 0) malformed('node 0 is not the fight-0 entry');
  return { kind, level, mode, horizon, critBudget, thresholds: parseThresholds(thresholds), engineId, aiId, fights, nodes: parsed };
}
