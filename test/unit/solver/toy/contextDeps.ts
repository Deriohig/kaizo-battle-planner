// A deps module for sharedPool.test.ts: createDeps(context) builds the toy deps of the scenario the context names and
// counts in the context's shared Int32Array: LOADS (the "heavy part", once per worker per `base`, like a module-level
// cache), BUILDS (createDeps calls past the faults), DOOMED (builds `exitOnBuild` ended), LAST_TAG (the last context's
// `tag`, stored before LOADS counts). `skip` is toyOracles' skip, so workers report those moves as not cross-checked.
// Faults: `exitOnBuild` exits the worker (code 4) before loading, like an out-of-memory load; `failBuilds: n` throws
// while BUILDS ≤ n; `exitOnLead` exits the worker (code 3) when a battle led by that mon starts.

import type { BattleInput, EngineState } from '../../../../src/contracts/engine.js';
import type { SolverDeps } from '../../../../src/solver/types.js';
import { scenarioNamed, toyDeps } from './deps.js';
import { toyOracles } from './oracles.js';

export interface ToyContext {
  scenario: string; counts: SharedArrayBuffer; base?: string; tag?: number; skip?: string[];
  exitOnLead?: string; exitOnBuild?: boolean; failBuilds?: number;
}

export const LOADS = 0;
export const BUILDS = 1;
export const DOOMED = 2;
export const LAST_TAG = 3;

/** Fresh counters for a test: the buffer for its contexts, and the counts as they stand. */
export function toyCounters(): { buffer: SharedArrayBuffer; loads(): number; builds(): number; doomed(): number; lastTag(): number } {
  const buffer = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
  const view = new Int32Array(buffer);
  return {
    buffer, loads: () => Atomics.load(view, LOADS), builds: () => Atomics.load(view, BUILDS), doomed: () => Atomics.load(view, DOOMED),
    lastTag: () => Atomics.load(view, LAST_TAG),
  };
}

/** The heavy part this worker has loaded: the `base` it was loaded for. */
let heavy: string | null = null;

export function createDeps(context?: ToyContext): SolverDeps {
  if (context === undefined) throw new Error('toy context deps: createDeps needs a context');
  const counts = new Int32Array(context.counts);
  if (context.exitOnBuild === true) {
    Atomics.add(counts, DOOMED, 1);
    process.exit(4);
  }
  Atomics.store(counts, LAST_TAG, context.tag ?? 0);
  const base = context.base ?? 'base';
  if (heavy !== base) {
    heavy = base;
    Atomics.add(counts, LOADS, 1);
  }
  const builds = Atomics.add(counts, BUILDS, 1) + 1;
  if (context.failBuilds !== undefined && builds <= context.failBuilds) throw new Error('toy context deps: a planted build failure');
  const scenario = scenarioNamed(context.scenario);
  const { skip } = context;
  const deps = toyDeps(scenario, skip === undefined ? {} : { oracles: toyOracles(scenario.registry, { skip }) });
  const crash = context.exitOnLead;
  if (crash === undefined) return deps;
  const { engine } = deps;
  return {
    ...deps,
    engine: {
      ...engine,
      createBattle: (input: BattleInput): EngineState => {
        if (input.player[0]?.nickname === crash) process.exit(3);
        return engine.createBattle(input);
      },
    },
  };
}
