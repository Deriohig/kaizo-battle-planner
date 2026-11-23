// `expandTurn`: every outcome of one step, with its exact probability.
//
// The odometer. A step runs from `state.json` with a chance driver (chance.ts) whose script forces the first picks;
// past the script each pick takes its point's first possible option. After a run (a leaf), the next script keeps the
// leaf's picks up to its deepest point that has a later possible option, and advances that point to it; the leaves end
// when no point has one. That is a depth-first walk of the tree of chance points, so each leaf is one path, and its
// probability is the product of weight / total weight of the option taken at each point on it. Every leaf restores the
// same state, so its JSON is parsed once per step (battle.ts `sharedState`, `restoreShared`), and each leaf's snapshot
// serialises the battle once for its JSON and its key (key.ts `serializedState`).
//
// The merge. Leaves with equal state key, equal `critBy` and equal observation are one outcome: its probability is
// their sum, `merged` counts them, `unlabelled` is set if any of them is, and the labels, state and log are the most
// probable leaf's (the first of those on a tie). Outcomes come in the order their first leaf was reached. Whenever a
// leaf becomes its class's kept leaf, the engine keeps its state's readers beside the state, from the leaf's own battle
// (facts.ts `rememberLive`), so the outcome's state answers `carryOut`, `hpOf` and `legalChoices` without a
// restore; then it hands that battle to `peek` as the state's battle (facts.ts `keepLive`), so the trainer
// AI's first read of the outcome restores nothing. A leaf that loses its place to a more probable one of its class has its
// battle dropped.
// So `unlabelled` and `labels` can disagree: `unlabelled` is ORed over every merged leaf (a raw draw anywhere in the
// class leaves it unproven), while `labels` are one leaf's, so an outcome can be `unlabelled: true` with no `raw` label
// when only a less probable leaf drew raw.
//
// What `Outcome.log` may not be relied on for. The observation is coarser than the screen
// (observe.ts: per-hit damage amounts and the order of identical events dropped), so leaves merged into one outcome
// share a state, `critBy` and observation but not always a log, and the outcome keeps the most probable leaf's log. A
// consumer of `Outcome.log` (the trainer AI's memory) must not depend on:
// - the HP field of `|-damage|`, `|-heal|` and `|-sethp|` lines (per-hit damage, and what drain, recoil or a berry did
//   with it on the way): the end state has the HP;
// - which, or how many, of the lines that follow a `|move|` line up to the next one are `|-crit|`, `|-miss|`,
//   `|-supereffective|`, `|-resisted|`, bare `|-immune|IDENT` or bare `|-damage|IDENT|HP` lines, nor where they sit
//   among the others: one log may have a multi-hit move's crit on its first hit where another has it on its second.
//   The observation keeps, for each move, whether any crit, miss or hit came and its effectiveness, and `critBy` keeps
//   whether each side crit;
// - the order of identical events.
// Every other line the player's screen shows (the moves used and their order, switches, faints, status, stat stages, items
// and abilities shown) is in the observation as it is, so it is the same in every merged leaf. Lines his screen never
// shows (hints, `[silent]` lines, the trainer's secret `|split|` copies) were never in the observation either.
//
// The collapses. With `collapse` (the default; `collapse: false` for tests and the benchmark), the mod's chance sites
// may offer one option for outcomes with one future (mod/scripts.ts: rolls with one final damage, and every roll that
// knocks the target out): fewer leaves, the same outcomes (test/unit/engine/collapse.test.ts).

import type { Choice, EngineState, Outcome, Phase, Side } from '../contracts/engine.js';
import { applyChoices, restoreShared, sharedState, snapshot } from './battle.js';
import { ChanceDriver, type ChancePoint, isChance, labelOf, nextScript } from './chance.js';
import { dropKept, keepLive, rememberLive } from './facts.js';
import { observe, omniscientLog } from './observe.js';
import { countLeaf, lap, mark } from './profile.js';
import { add, cmp, eq, ONE, rat, type Rational, ZERO } from './rational.js';
import { EngineError } from './types.js';

export type { Outcome } from '../contracts/engine.js';

/** The most leaves `expandTurn` runs before it throws `LIMIT`. */
export const DEFAULT_MAX_LEAVES = 20_000;

/**
 * `expandTurn`'s options: the contract's `maxLeaves`, and `collapse` (default true) for tests and the benchmark only.
 * With `collapse: false` the chance sites pick as the cartridge draws, one leaf per option (`ChanceDriver.collapse`);
 * the outcomes are the same either way (test/unit/engine/collapse.test.ts), only the leaves differ.
 *
 * `shouldStop` (the solver's deadline): polled on entry, before any work;
 * before every leaf, after the `maxLeaves` check; and after the last leaf, before every `STOP_POLL_OUTCOMES` outcomes
 * past the first that go into the result and its exact sum (a few microseconds each, so a turn near the leaf limit
 * spends a hundred milliseconds or more there). Every poll falls between two units of work, never inside a leaf.
 * - It must return a boolean, synchronously. Only `=== true` stops: any other value, truthy or not (a promise from an
 *   `async` closure among them), is no stop, and the call runs on.
 * - When it returns true, the call throws `STOPPED` and returns nothing. When it throws, its own error comes out as it
 *   is (not an `EngineError`), and it leaves behind no more than a stop does.
 * - The entry poll comes before the arguments are checked, so a stop there masks a deterministic error the call would
 *   have thrown: `BAD_CHOICE` (a missing or extra choice, a finished battle) and the `RangeError` of a bad
 *   `maxLeaves`. `STOPPED` never means the call was valid; a rerun without the stop gets the real error.
 * - Nothing a stopped call leaves changes any later call's result. Its outcome states, with their kept readers
 *   (facts.ts keeps those in a `WeakMap` by state object), are unreachable once it throws, and the battles it handed to
 *   `peek` (facts.ts `keepLive`) are dropped before the throw leaves the call (`dropKept`; so for `LIMIT` and any other
 *   throw too). What it may leave partly filled is content-addressed and is filled the same way by a full call: key.ts
 *   `canonicalByText` (a Pokémon's JSON text to its canonical text), and the dex's lazy lookups.
 * - It is no part of any key or cache, and without it the outcomes and the work are as before.
 * - `LIMIT` and `STOPPED` never stand in for each other: `LIMIT` depends only on the step and `maxLeaves` (a stop asked
 *   at the leaf past the limit still gives `LIMIT`), `STOPPED` only on `shouldStop`.
 */
export interface ExpandOptions { maxLeaves?: number; collapse?: boolean; shouldStop?: () => boolean }

/** After the last leaf, the outcomes summed between two `shouldStop` polls: well under a millisecond of sums. */
export const STOP_POLL_OUTCOMES = 16;

/** The sides whose choice each phase takes. */
const PHASE_SIDES: Record<Phase['kind'], readonly Side[]> = {
  turnChoice: ['p1', 'p2'], playerMidTurnSwitch: ['p1'], playerReplacement: ['p1'], enemyMidTurnSwitch: ['p2'],
  enemyReplacement: ['p2'], terminal: [],
};

/**
 * Throws `BAD_CHOICE` unless `choices` has exactly the sides `phase` takes. One exception: at `playerReplacement` a p2
 * choice goes through to `applyChoices`, which takes it only when the trainer replaces at the same time (both sides
 * fainted) and then requires it.
 */
function checkPhase(phase: Phase, choices: { p1?: Choice; p2?: Choice }): void {
  if (phase.kind === 'terminal') throw new EngineError('BAD_CHOICE', `The battle is over (won by ${phase.winner})`);
  const needed = PHASE_SIDES[phase.kind];
  for (const side of ['p1', 'p2'] as const) {
    const has = choices[side] !== undefined;
    if (needed.includes(side) && !has) throw new EngineError('BAD_CHOICE', `${phase.kind} needs a choice for ${side}`);
    if (!needed.includes(side) && has && !(phase.kind === 'playerReplacement' && side === 'p2')) {
      throw new EngineError('BAD_CHOICE', `${phase.kind} takes no choice for ${side}`);
    }
  }
}

/** Throws unless a run forced with `scriptLength` picks met the same points as the run its script came from. */
function checkReplay(previous: readonly ChancePoint[], points: readonly ChancePoint[], scriptLength: number): void {
  for (let i = 0; i < scriptLength; i++) {
    const [before, now] = [previous[i], points[i]];
    const same = before !== undefined && now !== undefined && before.source === now.source
      && before.options.length === now.options.length && before.options.every((option, k) => option.weight === now.options[k]!.weight);
    if (!same) throw new Error(`The step replayed differently at chance point ${i} (${before?.source} then ${now?.source}): a draw outside the driver?`);
  }
}

/** The product of weight / total weight of the option each point took. */
function pathProbability(points: readonly ChancePoint[]): Rational {
  let [num, den] = [1n, 1n];
  for (const { options, chosen } of points) {
    num *= options[chosen]!.weight;
    den *= options.reduce((total, option) => total + option.weight, 0n);
  }
  return rat(num, den);
}

/** Who landed a critical hit in `log`: `|-crit|POKEMON` names the target, so a crit on p2's Pokémon is p1's. */
function critsIn(log: readonly string[]): { p1: boolean; p2: boolean } {
  return { p1: log.some((line) => line.startsWith('|-crit|p2')), p2: log.some((line) => line.startsWith('|-crit|p1')) };
}

/** The party indices of each side's Pokémon that fainted in `log`. */
function faintsIn(battle: Battle, log: readonly string[]): { p1: number[]; p2: number[] } {
  const fainted = { p1: [] as number[], p2: [] as number[] };
  for (const line of log) {
    const match = /^\|faint\|(p[12])[a-z]?: (.+)$/.exec(line);
    if (match === null) continue;
    const side = battle[match[1] as Side];
    const pokemon = side.pokemon.find((candidate) => candidate.name === match[2]);
    if (pokemon === undefined) throw new Error(`No ${match[1]} Pokémon named ${match[2]} fainted`);
    const index = side.team.indexOf(pokemon.set);
    if (!fainted[side.id as Side].includes(index)) fainted[side.id as Side].push(index);
  }
  return fainted;
}

interface Leaf { outcome: Omit<Outcome, 'probability' | 'merged' | 'unlabelled'>; probability: Rational; unlabelled: boolean }

function leafOf(battle: Battle, state: EngineState, points: readonly ChancePoint[]): Leaf {
  const log = omniscientLog(battle.log);
  return {
    probability: pathProbability(points),
    // A raw pick with one possible option is no chance (chance.ts records none), so only real chances count here.
    unlabelled: points.some((point) => point.kind === 'raw' && isChance(point)),
    outcome: {
      labels: points.filter(isChance).map(labelOf), critBy: critsIn(log), state,
      observation: observe(battle, battle.log), log, fainted: faintsIn(battle, log),
    },
  };
}

interface Merged { best: Leaf; probability: Rational; merged: number; unlabelled: boolean }

/**
 * Every outcome of running the step from `state` with `choices` (the sides `state.phase` takes: both at
 * `turnChoice`, p1 at a player switch or replacement, p2 at an enemy one), merged as the top of this file says. Their
 * probabilities sum to exactly one. Throws `BAD_CHOICE` for a missing, extra or illegal choice or a finished battle,
 * `UNMODELLED_ITEM` as `applyChoices` does, `LIMIT` past `opts.maxLeaves` leaves (default 20,000), and `STOPPED` when
 * `opts.shouldStop` says stop (`ExpandOptions`).
 */
export function expandTurn(state: EngineState, choices: { p1?: Choice; p2?: Choice }, opts: ExpandOptions = {}): Outcome[] {
  const { shouldStop } = opts;
  if (shouldStop?.() === true) throw new EngineError('STOPPED', 'Stopped before the step began: shouldStop said stop');
  const maxLeaves = opts.maxLeaves ?? DEFAULT_MAX_LEAVES;
  const collapse = opts.collapse ?? true;
  if (!(Number.isInteger(maxLeaves) && maxLeaves >= 1)) throw new RangeError(`maxLeaves must be a whole number from 1, not ${maxLeaves}`);
  checkPhase(state.phase, choices);
  const shared = sharedState(state); // parsed once, for every leaf's restore (battle.ts)
  const outcomes = new Map<string, Merged>();
  let script: number[] = [];
  let previous: readonly ChancePoint[] = [];
  const result: Outcome[] = [];
  let total = ZERO;
  try {
    for (let leaves = 1; ; leaves++) {
      if (leaves > maxLeaves) throw new EngineError('LIMIT', `The step has more than ${maxLeaves} leaves`);
      // After the limit check, so whether `LIMIT` comes never depends on `shouldStop` (`ExpandOptions`).
      if (shouldStop?.() === true) throw new EngineError('STOPPED', `Stopped after ${leaves - 1} leaves: shouldStop said stop`);
      let time = mark(); // opt-in leaf timing (profile.ts); 0 and no clock reads when off
      const driver = new ChanceDriver(script, { collapse });
      const battle = restoreShared(shared, driver);
      time = lap('restore', time);
      applyChoices(battle, choices);
      lap('step', time);
      const after = snapshot(battle); // times its own snapshot and key phases
      time = mark();
      checkReplay(previous, driver.points, script.length);
      const leaf = leafOf(battle, after, driver.points);
      time = lap('leaf', time);
      const { critBy, observation } = leaf.outcome;
      const mergeKey = `${after.key}|${critBy.p1}|${critBy.p2}|${observation}`;
      const same = outcomes.get(mergeKey);
      let kept = false; // whether this leaf is now its class's kept leaf, whose state the outcome returns
      let replaced: EngineState | null = null; // the state of the kept leaf this one replaces
      if (same === undefined) {
        outcomes.set(mergeKey, { best: leaf, probability: leaf.probability, merged: 1, unlabelled: leaf.unlabelled });
        kept = true;
      } else {
        same.probability = add(same.probability, leaf.probability);
        same.merged += 1;
        same.unlabelled ||= leaf.unlabelled;
        if (cmp(leaf.probability, same.best.probability) > 0) {
          replaced = same.best.outcome.state;
          same.best = leaf;
          kept = true;
        }
      }
      const next = nextScript(driver.points);
      time = lap('merge', time);
      // The kept leaf's readers, from its own battle (facts.ts `rememberLive`), then the battle itself to `peek` (facts.ts
      // `keepLive`). `rememberLive` swaps the battle's driver and remakes its requests, and `keepLive` resets it to what a
      // restore gives, so both come after everything that reads the battle or the leaf's driver (`snapshot`, `leafOf`,
      // `nextScript`); the step drops the battle afterwards.
      if (kept) keepLive(after, battle, rememberLive(after, battle), replaced);
      lap('facts', time);
      countLeaf();
      if (next === null) break;
      [script, previous] = [next, driver.points];
    }
    // The result and its exact sum, in the outcomes' order (the sum adds them in that order from zero, as before).
    for (const { best, probability, merged, unlabelled } of outcomes.values()) {
      if (result.length > 0 && result.length % STOP_POLL_OUTCOMES === 0 && shouldStop?.() === true) {
        throw new EngineError('STOPPED', `Stopped after the last leaf, with ${result.length} of ${outcomes.size} outcomes summed: shouldStop said stop`);
      }
      result.push({ ...best.outcome, probability, merged, unlabelled });
      total = add(total, probability);
    }
    if (!eq(total, ONE)) throw new Error(`The step's outcomes sum to ${total.num}/${total.den}, not 1`);
  } catch (error) {
    // The call returns nothing, so the battles its kept leaves handed to `peek` are unreachable: drop them.
    for (const { best } of outcomes.values()) dropKept(best.outcome.state);
    throw error;
  }
  return result;
}
