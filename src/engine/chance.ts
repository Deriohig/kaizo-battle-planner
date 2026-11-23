// The chance driver: every random draw of a battle becomes a chance point with weighted options, and the driver picks
// which option happens. `expandTurn` replays a step with a forced script of picks to enumerate every outcome.
//
// A battle draws through its `prng` only (Showdown's `Battle.random`, `randomChance`, `sample` and `speedSort`'s
// `shuffle`, which the mod replaces, all call it, sim/battle.ts), so `attachDriver` swaps in `EnumeratingPRNG`, whose
// draws are driver picks.
// The mod's chance sites (mod/scripts.ts: rolls, crits, accuracy and so on) pick through `pickLabelled` with their
// kinds and the cartridge's weights; any draw left reaches the driver as a `raw` pick, which marks the outcome
// unlabelled.

import PS from 'pokemon-showdown';
import type { ChanceKind, ChanceLabel, Side } from '../contracts/engine.js';

export type { ChanceKind, ChanceLabel } from '../contracts/engine.js';

const { PRNG } = PS;

/**
 * One option of a chance point: its weight (a share of the point's total) and the outcome it names. A damage roll's
 * option may say what its number is (`ChanceLabel.rollValue`): the collapse marks its options 'final'
 * (mod/scripts.ts `finalRolls`); a roll option that says nothing is the roll's own value, 'base' (`labelOf`).
 */
export interface ChanceOption { weight: bigint; outcome: string; rollValue?: ChanceLabel['rollValue'] }

/** A chance point on a run, and the option the driver picked there. */
export interface ChancePoint {
  readonly kind: ChanceKind;
  readonly side: Side | null;
  readonly source: string;
  readonly options: readonly ChanceOption[];
  readonly chosen: number;
}

/**
 * Picks options at chance points. While its script lasts, the k-th pick takes the script's k-th option; past it, a
 * pick takes the point's first option with a positive weight (an option of weight 0 can't happen, so no run follows
 * one). Every pick, forced or not, is recorded in `points`.
 *
 * `collapse` (default off) lets the mod's chance sites offer options that group outcomes with one future, such as
 * every damage roll that knocks the target out (mod/scripts.ts `finalRolls`): `expandTurn` turns it on (expand.ts).
 * Off, every site picks as the cartridge draws.
 */
export class ChanceDriver {
  readonly points: ChancePoint[] = [];
  readonly collapse: boolean;
  private readonly script: readonly number[];

  constructor(script: number[], options: { collapse?: boolean } = {}) {
    this.script = [...script];
    this.collapse = options.collapse ?? false;
  }

  /** The index of the option that happens at this point. Throws if the script forces an option that can't happen. */
  pick(kind: ChanceKind, side: Side | null, source: string, options: readonly ChanceOption[]): number {
    if (options.length === 0 || options.some((option) => option.weight < 0n)) {
      throw new RangeError(`Chance point ${source} needs options with weights of 0 or more`);
    }
    const index = this.points.length;
    const chosen = index < this.script.length ? this.script[index]! : options.findIndex((option) => option.weight > 0n);
    if (!(Number.isInteger(chosen) && chosen >= 0 && chosen < options.length && options[chosen]!.weight > 0n)) {
      throw new Error(`Chance point ${index} (${source}) has no possible option ${chosen}`);
    }
    this.points.push({ kind, side, source, options: options.map((option) => ({ ...option })), chosen });
    return chosen;
  }
}

/**
 * The next script after a run whose picks were `points`, or null when every path is done: the picks up to the deepest
 * point that has a later possible option, with that point advanced to it. Successive scripts walk the tree of chance
 * points depth-first (expand.ts).
 */
export function nextScript(points: readonly ChancePoint[]): number[] | null {
  for (let depth = points.length - 1; depth >= 0; depth--) {
    const { options, chosen } = points[depth]!;
    for (let next = chosen + 1; next < options.length; next++) {
      if (options[next]!.weight > 0n) return [...points.slice(0, depth).map((point) => point.chosen), next];
    }
  }
  return null;
}

/** Whether `point` is a real chance: more than one of its options can happen. */
export function isChance(point: ChancePoint): boolean {
  let possible = 0;
  for (const option of point.options) if (option.weight > 0n && ++possible > 1) return true;
  return false;
}

/**
 * The label of the option `point` picked. A damage roll's (kind `roll`) says what its number is, `rollValue`:
 * 'final' when its option says so (a pick the collapse grouped by final damage), else 'base' (every other
 * roll pick has one option per value at the roll's own stage of the formula, mod/scripts.ts). No other kind has one.
 */
export function labelOf(point: ChancePoint): ChanceLabel {
  const { kind, side, source } = point;
  const { outcome, rollValue } = point.options[point.chosen]!;
  return kind === 'roll' ? { kind, side, source, outcome, rollValue: rollValue ?? 'base' } : { kind, side, source, outcome };
}

/**
 * The seed the enumerating PRNG is made with. Its generator never runs, so the seed Showdown serialises
 * (`getSeed`, read by `State.serializeBattle`) stays this one, and `startingSeed` (the battle's `prngSeed`) too.
 */
const ENUMERATING_SEED = '1,2,3,4';

const uniform = (count: number, outcome: (i: number) => string): ChanceOption[] =>
  Array.from({ length: count }, (_, i) => ({ weight: 1n, outcome: outcome(i) }));

/**
 * A Showdown PRNG whose every draw is a `raw` pick of its driver, with Showdown's own semantics:
 * - `random(n)` and `random(m, n)` (bounds floored, sim/prng.ts `random`): n or n − m values, each weighed 1;
 * - `randomChance(a, b)` (true when `random(b) < a`): true weighs the a values below a, false the b − a others;
 * - `sample(items)`: each item weighs 1 (a duplicate counts each time, as in Showdown);
 * - `shuffle`, the base class's Fisher-Yates, draws through `random`.
 * A draw with one possible result returns it without a pick: it is no chance (a raw pick with one option could not
 * change an outcome, so it doesn't mark one unlabelled). `random()`, a real number in [0, 1), can't be enumerated and
 * throws, as does `clone`, whose stock copy would draw without the driver.
 */
class EnumeratingPRNG extends PRNG {
  readonly driver: ChanceDriver;

  constructor(driver: ChanceDriver) {
    super(ENUMERATING_SEED);
    this.driver = driver;
  }

  override random(from?: number, to?: number): number {
    if (from === undefined) throw new Error('A real-valued random() draw cannot be enumerated');
    if (from) from = Math.floor(from);
    if (to) to = Math.floor(to);
    const [low, high] = to ? [from, to] : [0, from];
    const count = high - low;
    if (!(count >= 0)) throw new RangeError(`random(${from}, ${to}) has no values to draw`);
    if (count <= 1) return low; // Showdown's random(0) gives 0 too
    return low + this.driver.pick('raw', null, `random(${low}, ${high})`, uniform(count, (i) => `${low + i}`));
  }

  override randomChance(numerator: number, denominator: number): boolean {
    const values = Math.floor(denominator);
    if (!(values >= 1)) throw new RangeError(`randomChance(${numerator}, ${denominator}) needs a denominator of 1 or more`);
    const below = Math.min(values, Math.max(0, Math.ceil(numerator))); // the draws r in [0, values) with r < numerator
    if (below === 0 || below === values) return below === values;
    const options = [{ weight: BigInt(below), outcome: 'true' }, { weight: BigInt(values - below), outcome: 'false' }];
    return this.driver.pick('raw', null, `randomChance(${numerator}, ${denominator})`, options) === 0;
  }

  override sample<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('Cannot sample an empty array');
    if (items.length === 1) return items[0]!;
    return items[this.driver.pick('raw', null, `sample(${items.length})`, uniform(items.length, (i) => `${i}`))]!;
  }

  override clone(): never {
    throw new Error('An enumerating PRNG cannot be cloned: the copy would draw without its driver');
  }
}

/** A PRNG for `new Battle({ prng })` that draws through `driver`. */
export function drivenPrng(driver: ChanceDriver): InstanceType<typeof PRNG> {
  return new EnumeratingPRNG(driver);
}

/** Replaces `battle.prng` with one that draws through `driver`. */
export function attachDriver(battle: Battle, driver: ChanceDriver): void {
  battle.prng = new EnumeratingPRNG(driver);
}

/** The driver `battle` draws through. Throws for a battle whose PRNG is Showdown's own. */
export function driverOf(battle: Battle): ChanceDriver {
  const { prng } = battle;
  if (!(prng instanceof EnumeratingPRNG)) throw new Error('The battle draws without a chance driver');
  return prng.driver;
}

/**
 * The index of the option that happens at a labelled chance point of `battle`: one of the cartridge's draws, with its
 * kind, the side it belongs to, its source (a move or item ID, or a name) and the cartridge's weights. When only one
 * option can happen, it is no chance: its index comes back and nothing is recorded, as for a raw draw.
 */
export function pickLabelled(battle: Battle, kind: ChanceKind, side: Side | null, source: string, options: readonly ChanceOption[]): number {
  let only = -1;
  for (let i = 0; i < options.length; i++) {
    if (options[i]!.weight <= 0n) continue;
    if (only >= 0) return driverOf(battle).pick(kind, side, source, options);
    only = i;
  }
  if (only < 0) throw new RangeError(`Chance point ${source} has no option that can happen`);
  return only;
}
