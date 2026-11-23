// Search ordering: history ordering only reorders, so it is sound. An OR node stops at the first proven action, an AND
// node at the first failing child. The player's choices go likely-safe first; children go most-dangerous first (fail-first). Neither
// changes a verdict, only how soon it is found. Both orders are total, so the same input always searches the same way.

import type { Choice } from '../contracts/engine.js';
import type { Belief, BeliefChild } from './belief.js';
import { choiceText } from './keys.js';
import type { OrderHint } from './types.js';

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const KIND_RANK: Record<Choice['kind'], number> = { move: 0, switch: 1, item: 2 };

/** Moves by slot, then switches by index, then items by choiceText. */
function byDefault(a: Choice, b: Choice): number {
  if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (a.kind === 'move' && b.kind === 'move') return a.slot - b.slot;
  if (a.kind === 'switch' && b.kind === 'switch') return a.index - b.index;
  return byText(choiceText(a), choiceText(b));
}

function checkPermutation(given: Choice[], hinted: Choice[]): void {
  const want = given.map(choiceText).sort(byText);
  const got = hinted.map(choiceText).sort(byText);
  if (want.length !== got.length || want.some((t, i) => t !== got[i])) {
    throw new Error(`order: the hint did not return a permutation of [${want.join(', ')}]: [${got.join(', ')}]`);
  }
}

/**
 * History's choice for belief.key first; then hint(first member's state) at battle phases; then moves before switches,
 * by slot/index (items last). The hint receives the default order and must return a permutation of it.
 */
export function orderChoices(belief: Belief, choices: Choice[], history: Map<string, Choice>, hint?: OrderHint): Choice[] {
  let ordered = [...choices].sort(byDefault);
  const state = belief.members[0]?.member.state ?? null;
  if (hint !== undefined && belief.phase !== 'entry' && state !== null) {
    const hinted = hint(state, [...ordered]);   // a copy: a hint that edits its argument cannot fool the check
    checkPermutation(ordered, hinted);
    ordered = [...hinted];
  }
  const remembered = history.get(belief.key);
  if (remembered !== undefined) {
    const text = choiceText(remembered);
    const at = ordered.findIndex((c) => choiceText(c) === text);
    if (at > 0) ordered = [ordered[at]!, ...ordered.slice(0, at), ...ordered.slice(at + 1)];
  }
  return ordered;
}

/**
 * Most dangerous first: children containing a successor with critsAdded > 0 first, then by the lowest danger of any
 * member, then by edge (children of one expansion have distinct edges, so the order is total).
 */
export function orderChildren(children: BeliefChild[]): BeliefChild[] {
  return children
    .map((child) => ({ child, danger: Math.min(...child.belief.members.map((m) => m.member.danger)) }))
    .sort((a, b) => Number(b.child.crit) - Number(a.child.crit) || a.danger - b.danger || byText(a.child.edge, b.child.edge))
    .map((x) => x.child);
}
