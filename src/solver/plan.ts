// The plan tree (the contract's PlanNode and its label conventions in src/contracts/solver.ts): a
// certificate rendered as the decision tree the page shows, main path first.
//
// Walk. From the root belief (node 0, the fight-0 entry) with the certificate's horizon, expanding each node's action
// with the certificate's own options (certificateOptions: a proof's G_j filter, none for a risk line). Turns left are
// the certificate's: a turnChoice consumes one, a later fight's entry starts again at the horizon.
// Shape. Each certificate node visited is a `player` node (the player's action, labelled by actionLabel: 'Lead with <team
// label>' at an entry). Its one branch ('', ONE) goes to an `enemy` node whose branches are the AI's first choice on each
// settled path (enemyBranchLabel; a replacement when the node is not a turnChoice, so the choice came after a mid-turn
// step); without any AI choice the enemy node is left out. When only some successors have one, those without are one
// more enemy branch labelled ''. Each enemy branch goes to a `chance` node: one branch per edge label (to the next
// player node) and one per leaf, keyed by result and chance label, plus the kill cause for a death and the end HP and
// statuses for a win, so a different victim or end state is never merged away (win: a `win` leaf; dead: a `death` leaf;
// unlabelled: a `death` leaf labelled 'unmodelled' when the label is empty).
// Chance labels. The labeler's words for every chance label on the settled path (labeler.outcome of the last outcome
// with the path's labels), so an enemy replacement at the end of the turn does not hide the turn's crits and rolls. Each
// enemy replacement after the branch's first AI choice (a turn choice's aiChoices[1…]; on a mid-turn step the first
// replacement is the enemy branch itself) appends ', then the AI sends in <name>' ('The AI sends in <name>' after an
// empty label), so each edge names the mon that came in and a kill path keeps one entry per depth.
// Probabilities are conditional at each node, under the AI distribution with the walk's member weights: an enemy branch
// is its successors' weight over the node's (kept) total, a chance branch its successors' weight over its AI choice's.
// A branch's representative (its label, end HP, kill cause, and the state the AI's choice is labelled at) is its most
// probable successor, the first on a tie (member order, then successor order).
// Leaves. A turnChoice child with no turn left is a `cutoff` (the certificate has no node there); so is a risk line's
// missing edge (a null policy answer), while a proof's missing edge is a malformed certificate and throws. A node whose
// expansion meets an engine LIMIT (risk lines keep such nodes without edges) keeps its player node, with one branch
// 'engine limit' (ONE) to a `truncated` leaf. A node whose every successor the G_j filter drops (nothing left to show)
// leads to a `truncated` leaf the same way, labelled ''.
// Order. Every branch list is sorted by probability, largest first, ties by label (plain string order), then render
// order. Then sibling labels are made unique: a later branch whose label an earlier sibling already has gets ' (2)',
// ' (3)', … ('' becomes ' (2)'), so the page can follow a kill path by position. Nodes are made depth first in that
// order, so the main path is made first; `nodeLimit` counts PlanNodes made
// (the root always is), and once it is reached every further branch target, leaf or node, is a `truncated` leaf.
// Death paths: per kill cause (labeler.killCause of the representative's last outcome, the turn being the fight's turns
// used before the step + 1 at a turnChoice, as the prover and the checker count it), the branch labels from the root to
// the most probable rendered death leaf with that cause (by path probability, the first in render order on a tie), with
// the final (unique) labels. Only real deaths have a cause: an unlabelled outcome is not a kill.

import type { Choice, Rational, UndrawnSleep } from '../contracts/engine.js';
import type { PlanBranch, PlanLeaf, PlanNode } from '../contracts/solver.js';
import type { StartStatus } from '../save/status.js';
import { ArenaLimitError, type Arena } from './arena.js';
import { expandBelief, rootBelief, type Belief, type BeliefExpansion, type BeliefOpts } from './belief.js';
import {
  aiGroupKey, certificateOptions, settledSuccessors, turnsLeft, type CertNode, type Certificate, type Settled,
} from './certificate.js';
import { canonicalJson } from './keys.js';
import { actionLabel } from './prove.js';
import { add, cmp, div, isZero, mul, ONE, sum } from './rational.js';
import type { PlanLabeler } from './types.js';

export interface RenderedPlan { tree: PlanNode; deathPaths: Record<string, string[]> } // kill cause → branch labels from the root to its most probable rendered death leaf

/**
 * The AI's choice as a condition. name = `choiceLabel` without a leading 'Use ' or 'Switch to '. A replacement
 * (enemyReplacement / enemyMidTurnSwitch) → 'If the AI sends in <name>'; else a move → 'If the AI uses <name>', an item
 * → 'If the AI uses a <name>', a switch → 'If the AI switches to <name>'.
 */
export function enemyBranchLabel(choice: Choice, choiceLabel: string, replacement: boolean): string {
  const name = choiceLabel.replace(/^(Use |Switch to )/, '');
  if (replacement) return `If the AI sends in ${name}`;
  switch (choice.kind) {
    case 'move': return `If the AI uses ${name}`;
    case 'item': return `If the AI uses a ${name}`;
    case 'switch': return `If the AI switches to ${name}`;
  }
}

interface Render {
  arena: Arena; cert: Certificate; opts: BeliefOpts; labeler: PlanLabeler; nodeLimit: number;
  made: number;                        // PlanNodes made so far
  causes: Map<PlanLeaf, string>;       // death leaf → its kill cause
}

/** A player node's expansion, shared by its enemy and chance nodes. */
interface At {
  node: CertNode; belief: Belief; observation: string;
  left: number;                        // turns left for the children (before a later fight's entry resets them)
  children: Map<string, Belief>;       // edge → child belief
}

/** A branch whose target is made only when its turn comes (after sorting), while the node limit allows. */
interface Pending { label: string; probability: Rational; make: () => PlanNode | PlanLeaf }

interface Group { items: Settled[]; weight: Rational }

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Groups in order of first appearance, each with its total weight. */
function groupBy(items: Settled[], key: (s: Settled) => string): Group[] {
  const groups = new Map<string, Group>();
  for (const s of items) {
    const k = key(s);
    const g = groups.get(k);
    if (g === undefined) groups.set(k, { items: [s], weight: s.weight });
    else {
      g.items.push(s);
      g.weight = add(g.weight, s.weight);
    }
  }
  return [...groups.values()];
}

/** The most probable successor, the first on a tie. */
function representative(items: Settled[]): Settled {
  let best = items[0]!;
  for (const s of items) if (cmp(s.weight, best.weight) > 0) best = s;
  return best;
}

const truncated = (): PlanLeaf => ({ result: 'truncated' });

/** `make()` while the node limit allows, else a truncated leaf. */
function target(r: Render, make: () => PlanNode | PlanLeaf): PlanNode | PlanLeaf {
  return r.made >= r.nodeLimit ? truncated() : make();
}

/** Each label unique among `labels`: a repeat gets ' (2)', ' (3)', … (the first free one), in order. */
function uniqueLabels(labels: string[]): string[] {
  const used = new Set<string>();
  return labels.map((label) => {
    let out = label;
    for (let n = 2; used.has(out); n++) out = `${label} (${n})`;
    used.add(out);
    return out;
  });
}

/** Sorted (probability, largest first; then label), labels made unique, then each target made in that order. */
function branchesOf(r: Render, pending: Pending[]): PlanBranch[] {
  const sorted = [...pending].sort((a, b) => cmp(b.probability, a.probability) || byText(a.label, b.label));
  const labels = uniqueLabels(sorted.map((p) => p.label));
  return sorted.map((p, i) => ({ label: labels[i]!, probability: p.probability, next: target(r, p.make) }));
}

function playerNode(r: Render, belief: Belief, id: number, h: number): PlanNode {
  const node = r.cert.nodes[id];
  if (node === undefined) throw new Error(`plan: no certificate node ${id}`);
  if (node.phase !== belief.phase || node.fight !== belief.fight) {
    throw new Error(`plan: node ${id} is fight ${node.fight} at ${node.phase}, but the walk is at fight ${belief.fight} ${belief.phase}`);
  }
  r.made += 1;
  const plan: PlanNode = {
    observation: belief.observation, kind: 'player', action: node.action, actionLabel: actionLabel(r.arena, r.labeler, belief, node.action), branches: [],
  };
  let x: BeliefExpansion;
  let settled: Settled[];
  try {
    x = expandBelief(r.arena, belief, node.action, r.opts);
    settled = settledSuccessors(r.arena, belief, node.action, r.opts, x.children);
  } catch (e) {
    if (!(e instanceof ArenaLimitError)) throw e;
    plan.branches.push({ label: 'engine limit', probability: ONE, next: truncated() });
    return plan;
  }
  const total = sum(settled.map((s) => s.weight));
  if (isZero(total)) {
    plan.branches.push({ label: '', probability: ONE, next: target(r, truncated) });
    return plan;
  }
  const at: At = {
    node, belief, observation: belief.observation, left: h - (x.turnConsumed ? 1 : 0),
    children: new Map(x.children.map((c) => [c.edge, c.belief])),
  };
  const make = settled.some((s) => s.successor.aiChoices.length > 0)
    ? () => enemyNode(r, at, groupBy(settled, (s) => aiGroupKey(s.successor)), total)
    : () => chanceNode(r, at, settled, total);
  plan.branches.push({ label: '', probability: ONE, next: target(r, make) });
  return plan;
}

function enemyNode(r: Render, at: At, groups: Group[], total: Rational): PlanNode {
  r.made += 1;
  const replacement = at.belief.phase !== 'turnChoice';
  const pending = groups.map((g): Pending => {
    const rep = representative(g.items);
    const first = rep.successor.aiChoices[0];
    let label = '';
    if (first !== undefined) {
      if (rep.from.state === null) throw new Error('plan: an AI choice at a member without a state');
      label = enemyBranchLabel(first, r.labeler.choice(rep.from.state, 'p2', first), replacement);
    }
    return { label, probability: div(g.weight, total), make: () => chanceNode(r, at, g.items, g.weight) };
  });
  return { observation: at.observation, kind: 'enemy', branches: branchesOf(r, pending) };
}

/**
 * A successor's chance label: the labeler's words for every chance label on its settled path, then each enemy
 * replacement after its first AI choice (see the top of the file).
 */
function chanceLabel(r: Render, s: Settled): string {
  let label = r.labeler.outcome({ ...s.successor.last, labels: s.successor.labels });
  for (const choice of s.successor.aiChoices.slice(1)) {
    // Named at the decision state: the arena keeps no state at the replacement phase. This assumes p2's party order
    // does not change within a turn, so the replacement's party index names the same mon at both states.
    if (s.from.state === null) throw new Error('plan: an AI choice at a member without a state');
    const name = r.labeler.choice(s.from.state, 'p2', choice).replace(/^Switch to /, '');
    label = label === '' ? `The AI sends in ${name}` : `${label}, then the AI sends in ${name}`;
  }
  return label;
}

/** A win's end state: canonical team order; a carried undrawn sleep stays one (PlanLeaf.endStatus takes it). */
function endOf(s: Settled): { endHp: number[]; endStatus: (StartStatus | UndrawnSleep)[] } {
  const carry = s.successor.endCarry;
  if (carry === null) throw new Error('plan: a win leaf without an end carry');
  return { endHp: carry.mons.map((m) => m.hp), endStatus: carry.mons.map((m) => ({ ...m.status })) };
}

/** A death's kill cause, the turn being the fight's turns used before the step + 1 at a turnChoice. */
function killCauseOf(r: Render, at: At, s: Settled): string {
  return r.labeler.killCause(s.successor.last, s.from.turnsInFight + (at.belief.phase === 'turnChoice' ? 1 : 0));
}

/** A successor's chance branch: its edge, or for a leaf its result and label, plus a death's cause or a win's end state. */
function branchKey(r: Render, at: At, s: Settled): string {
  const { result } = s.successor;
  if (result === 'continue') return `edge\u0000${s.edge!}`;
  const base = `${result}\u0000${chanceLabel(r, s)}`;
  if (result === 'win') return `${base}\u0000${canonicalJson(endOf(s))}`;
  if (result === 'dead') return `${base}\u0000${killCauseOf(r, at, s)}`;
  return base;
}

function chanceNode(r: Render, at: At, items: Settled[], weight: Rational): PlanNode {
  r.made += 1;
  const groups = groupBy(items, (s) => branchKey(r, at, s));
  const pending = groups.map((g): Pending => {
    const rep = representative(g.items);
    const label = chanceLabel(r, rep);
    const probability = div(g.weight, weight);
    switch (rep.successor.result) {
      case 'continue': return { label, probability, make: () => decision(r, at, rep.edge!) };
      case 'win': return { label, probability, make: () => ({ result: 'win', ...endOf(rep) }) };
      case 'dead': return { label, probability, make: () => deathLeaf(r, at, rep) };
      case 'unlabelled': return { label: label === '' ? 'unmodelled' : label, probability, make: () => ({ result: 'death' }) };
    }
  });
  return { observation: at.observation, kind: 'chance', branches: branchesOf(r, pending) };
}

/** The next decision behind `edge`: a cut-off with no turn left (or a risk line's missing edge), else its player node. */
function decision(r: Render, at: At, edge: string): PlanNode | PlanLeaf {
  const belief = at.children.get(edge);
  if (belief === undefined) throw new Error(`plan: edge ${JSON.stringify(edge)} is not one of the expansion's`);
  const h = turnsLeft(belief, at.left, r.cert.horizon);
  if (belief.phase === 'turnChoice' && h <= 0) return { result: 'cutoff' };
  const id = at.node.edges[edge];
  if (id !== undefined) return playerNode(r, belief, id, h);
  if (r.cert.kind === 'risk') return { result: 'cutoff' };
  throw new Error(`plan: proof node ${at.node.id} has no edge for ${JSON.stringify(edge)}`);
}

function deathLeaf(r: Render, at: At, rep: Settled): PlanLeaf {
  const leaf: PlanLeaf = { result: 'death' };
  r.causes.set(leaf, killCauseOf(r, at, rep));
  return leaf;
}

/** Per cause, the labels from the root to its most probable death leaf (the first in render order on a tie). */
function deathPathsOf(tree: PlanNode, causes: Map<PlanLeaf, string>): Record<string, string[]> {
  const best = new Map<string, { probability: Rational; path: string[] }>();
  const walk = (x: PlanNode | PlanLeaf, path: string[], probability: Rational): void => {
    if ('result' in x) {
      const cause = causes.get(x);
      if (cause === undefined) return;
      const seen = best.get(cause);
      if (seen === undefined || cmp(probability, seen.probability) > 0) best.set(cause, { probability, path });
      return;
    }
    for (const b of x.branches) walk(b.next, [...path, b.label], mul(probability, b.probability));
  };
  walk(tree, [], ONE);
  return Object.fromEntries([...best].map(([cause, { path }]) => [cause, path]));
}

/**
 * `cert` walked on `arena` from its root entry as the page's decision tree, at most `nodeLimit` PlanNodes (a positive
 * integer), with the death path per kill cause (see the top of the file). Throws on a malformed certificate (a node
 * that does not match the walk, a proof missing an edge), never on an engine LIMIT.
 */
export function renderPlan(arena: Arena, cert: Certificate, opts: { labeler: PlanLabeler; nodeLimit: number }): RenderedPlan {
  if (!Number.isInteger(opts.nodeLimit) || opts.nodeLimit < 1) throw new RangeError(`plan: nodeLimit must be a positive integer, got ${opts.nodeLimit}`);
  const r: Render = {
    arena, cert, opts: certificateOptions(cert), labeler: opts.labeler, nodeLimit: opts.nodeLimit, made: 0, causes: new Map(),
  };
  const tree = playerNode(r, rootBelief(arena), 0, cert.horizon);
  return { tree, deathPaths: deathPathsOf(tree, r.causes) };
}
