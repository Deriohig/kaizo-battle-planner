// Every outcome of a run that draws random numbers, with its exact probability. The run asks `pick` at each draw; the
// odometer replays the run once per path, so the run must be deterministic given its picks.

import type { Rational } from '../contracts/engine.js';
import { AiError } from './errors.js';
import { add, eq, mul, ONE, rat, sum } from './odds.js';

/** Chooses an index of `weights`, with probability weight / total. Zero weights are never chosen. */
export type Pick = (weights: readonly bigint[]) => number;

export interface Leaf<T> { value: T; probability: Rational }

const DEFAULT_LIMIT = 100_000;

/**
 * Runs `run` down every path of its picks: the first run takes each pick's first non-zero weight; each next run replays
 * the path up to the deepest pick that has a non-zero weight left, takes that, and goes on fresh from there. A leaf's
 * probability is the product of weight / total over its picks. Leaves with equal `keyOf` are merged, keeping the first
 * value, in first-seen order. Throws AiError('LIMIT') past `limit` paths (default 100,000), and a plain Error if the run
 * is not deterministic or the leaves don't sum to exactly ONE (a bug, not a cartridge case).
 */
export function enumerate<T>(run: (pick: Pick) => T, keyOf: (t: T) => string, opts?: { limit?: number }): Leaf<T>[] {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const leaves = new Map<string, Leaf<T>>();
  // The current path: the index chosen at each pick, and the weights that pick was offered.
  const path: number[] = [];
  const offered: (readonly bigint[])[] = [];
  let paths = 0;
  // The current path's pick count and probability so far, which `pick` reads and the loop resets for each path. One
  // `pick` serves every path (a closure made per path costs an Object.defineProperty under tsx's keepNames).
  let depth = 0;
  let probability = ONE;
  const pick: Pick = (weights) => {
    const total = checkedTotal(weights);
    let choice: number;
    if (depth < path.length) {
      if (!sameWeights(offered[depth]!, weights)) throw new Error(`the run is not deterministic: pick ${depth} changed its weights`);
      choice = path[depth]!;
    } else {
      choice = nextNonZero(weights, -1);
      path.push(choice);
      offered.push([...weights]);
    }
    depth++;
    probability = mul(probability, rat(weights[choice]!, total));
    return choice;
  };

  for (;;) {
    if (paths === limit) throw new AiError('LIMIT', `more than ${limit} random paths`);
    paths++;
    depth = 0;
    probability = ONE;
    const value = run(pick);
    if (depth !== path.length) throw new Error(`the run is not deterministic: it made ${depth} picks, not ${path.length}`);

    const key = keyOf(value);
    const seen = leaves.get(key);
    if (seen) seen.probability = add(seen.probability, probability);
    else leaves.set(key, { value, probability });

    // Advance the odometer: the deepest pick with a non-zero weight after its current choice moves on.
    while (path.length > 0) {
      const at = path.length - 1;
      const next = nextNonZero(offered[at]!, path[at]!);
      if (next >= 0) {
        path[at] = next;
        break;
      }
      path.pop();
      offered.pop();
    }
    if (path.length === 0) break;
  }

  const result = [...leaves.values()];
  const total = sum(result.map((leaf) => leaf.probability));
  if (!eq(total, ONE)) throw new Error(`the leaves sum to ${total.num}/${total.den}, not 1`);
  return result;
}

/** The sum of `weights`. Throws if there are none, one is negative, or all are zero. */
function checkedTotal(weights: readonly bigint[]): bigint {
  let total = 0n;
  for (const weight of weights) {
    if (weight < 0n) throw new Error(`pick weight ${weight} is negative`);
    total += weight;
  }
  if (total === 0n) throw new Error('pick has no non-zero weight');
  return total;
}

/** The first index after `from` with a non-zero weight, or -1. */
function nextNonZero(weights: readonly bigint[], from: number): number {
  for (let i = from + 1; i < weights.length; i++) if (weights[i]! > 0n) return i;
  return -1;
}

function sameWeights(a: readonly bigint[], b: readonly bigint[]): boolean {
  return a.length === b.length && a.every((weight, i) => weight === b[i]);
}
