// A corpus of engine states for the cached-reader tests (facts.test.ts, test/real/engineFacts.test.ts): battles walked
// through several steps, each side's choice picked from `legalChoices` by a seeded generator, every outcome kept, one followed.

import { isDeepStrictEqual } from 'node:util';
import type { BattleInput, Choice, EngineState, Outcome, Phase } from '../../../src/contracts/engine.js';
import { carryOut, createBattle, EngineError, expandTurn, hpOf, legalChoices, showdownEngine, unmodelledIn } from '../../../src/engine/index.js';

/** A seeded generator of numbers in [0, 1) (mulberry32). */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** States the engine built (roots and every outcome's), the outcomes, and the phase kinds among the states. */
export interface Corpus { states: EngineState[]; outcomes: Outcome[]; phases: Set<Phase['kind']> }

export const emptyCorpus = (): Corpus => ({ states: [], outcomes: [], phases: new Set() });

/**
 * Walks `input`'s battle for up to `steps` steps into `corpus`: at each step a seeded pick of each choosing side's legal
 * choices (another pick on a LIMIT or other engine error, up to six), every outcome kept, then one followed: the first
 * whose phase kind no followed state had, else a seeded one; never a terminal one. `onStep`, if given, sees each step's
 * outcomes right after the `expandTurn` that made them (while `peek` still holds their kept battles unread).
 */
export function walk(
  corpus: Corpus, input: BattleInput, steps: number, seed: number, maxLeaves: number, onStep?: (outcomes: readonly Outcome[]) => void,
): void {
  const random = seeded(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const followed = new Set<Phase['kind']>();
  let state = createBattle(input);
  corpus.states.push(state);
  corpus.phases.add(state.phase.kind);
  for (let step = 0; step < steps && state.phase.kind !== 'terminal'; step++) {
    const [p1, p2] = [legalChoices(state, 'p1'), legalChoices(state, 'p2')];
    let outcomes: Outcome[] | null = null;
    for (let attempt = 0; attempt < 6 && outcomes === null; attempt++) {
      const choices: { p1?: Choice; p2?: Choice } = { ...(p1.length > 0 ? { p1: pick(p1) } : {}), ...(p2.length > 0 ? { p2: pick(p2) } : {}) };
      try {
        outcomes = expandTurn(state, choices, { maxLeaves });
      } catch (error) {
        if (!(error instanceof EngineError)) throw error;
      }
    }
    if (outcomes === null) break;
    onStep?.(outcomes);
    for (const outcome of outcomes) {
      corpus.outcomes.push(outcome);
      corpus.states.push(outcome.state);
      corpus.phases.add(outcome.state.phase.kind);
    }
    const open = outcomes.filter((outcome) => outcome.state.phase.kind !== 'terminal');
    if (open.length === 0) break;
    state = (open.find((outcome) => !followed.has(outcome.state.phase.kind)) ?? pick(open)).state;
    followed.add(state.phase.kind);
  }
}

/** Every reader's answer for `state`. */
export const readAll = (state: EngineState) => ({
  carry: carryOut(state), hp: hpOf(state), p1: legalChoices(state, 'p1'), p2: legalChoices(state, 'p2'),
  observation: showdownEngine.observe(state), unmodelled: unmodelledIn(state),
});

/**
 * The states of `states` whose readers answer differently from the same state rebuilt as a new object (`{ ...state }`,
 * which the engine's cache misses, so the readers restore it), read before and after the copy; at most `limit` of them,
 * each with its key and what differed.
 */
export function cacheMismatches(states: readonly EngineState[], limit = 5): string[] {
  const found: string[] = [];
  for (const state of states) {
    const before = readAll(state);
    const uncached = readAll({ ...state });
    const after = readAll(state);
    if (isDeepStrictEqual(before, uncached) && isDeepStrictEqual(after, uncached)) continue;
    const fields = (Object.keys(uncached) as (keyof typeof uncached)[])
      .filter((field) => !isDeepStrictEqual(before[field], uncached[field]) || !isDeepStrictEqual(after[field], uncached[field]));
    found.push(`${state.key.slice(0, 12)} (${state.phase.kind}, turn ${state.turn}): ${fields.join(', ')}`);
    if (found.length >= limit) break;
  }
  return found;
}
