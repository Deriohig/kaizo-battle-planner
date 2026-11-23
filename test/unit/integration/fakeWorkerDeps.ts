// The real solver's worker deps module in its unit tests. It keeps contextDeps's caching over a stand-in base that checks
// the context's fingerprint as readBaseDeps does, records each load that passed as "<threadId> <dataVersion> <fingerprint
// or ->" in <dataDir>/loads.log, and builds the toy deps of the scenario the box's first Pokémon names (safe1v1 for an empty
// box). With the solver's step counters in the context, the toy runs through the engine selector over a stub native engine
// that covers every step, and the build is recorded as "<threadId> <mode>" in <dataDir>/engines.log.

import fs from 'node:fs';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { EngineState } from '../../../src/contracts/engine.js';
import type { MonRef } from '../../../src/contracts/solver.js';
import { stepCounters } from '../../../src/engines/counters.js';
import { type EngineMode, referenceModel, selectEngine } from '../../../src/engines/select.js';
import { contextDeps } from '../../../src/integration/contextDeps.js';
import { readStable } from '../../../src/integration/fingerprint.js';
import type { SolverDeps } from '../../../src/solver/index.js';
import type { DamageOracle, SpeedOracle, StepContext } from '../../../src/solver/types.js';
import { stubNative } from '../engines/stubNative.js';
import { scenarioNamed, toyDeps } from '../solver/toy/deps.js';

/** This module's URL: createRealSolver's `depsModule` in the tests. */
export const FAKE_WORKER_DEPS = import.meta.url;

const LOG = 'loads.log';
const ENGINES = 'engines.log';

/** `oracles` reading every state through `reference`, as the integration's do. */
function readingOracles(oracles: SolverDeps['oracles'], reference: (state: EngineState) => EngineState): SolverDeps['oracles'] {
  const through = (oracle: DamageOracle | SpeedOracle): DamageOracle & SpeedOracle => ({
    id: oracle.id,
    check: (step: StepContext) => oracle.check({ ...step, before: reference(step.before), outcome: { ...step.outcome, state: reference(step.outcome.state) } }),
  });
  return { damage: through(oracles.damage), speed: through(oracles.speed) };
}

/** The toy deps of the scenario the first of `mons` names; with `engine`, run through the selector over the stub native engine. */
export function toyDepsFor(mons: ReadonlyMap<MonRef, PlayerMon>, engine?: { mode: EngineMode; counters?: SharedArrayBuffer }): SolverDeps {
  const deps = toyDeps(scenarioNamed(mons.values().next().value?.nickname ?? 'safe1v1'));
  if (engine === undefined) return deps;
  const kit = selectEngine({
    mode: engine.mode, reference: deps.engine, native: stubNative(deps.engine).provider,
    ...(engine.counters === undefined ? {} : { counters: stepCounters(engine.counters) }),
  });
  return { ...deps, engine: kit.engine, enemyModel: referenceModel(deps.enemyModel, kit.reference), oracles: readingOracles(deps.oracles, kit.reference) };
}

function linesOf(dataDir: string, file: string): string[][] {
  try {
    return fs.readFileSync(path.join(dataDir, file), 'utf8').split('\n').filter((line) => line !== '').map((line) => line.split(' '));
  } catch {
    return [];
  }
}

/** The base loads the workers recorded in `dataDir`, in order, with the fingerprint each context carried (null: none). */
export const loadsIn = (dataDir: string): { thread: number; dataVersion: number; fingerprint: string | null }[] =>
  linesOf(dataDir, LOG).map(([thread, dataVersion, fingerprint]) => ({
    thread: Number(thread), dataVersion: Number(dataVersion), fingerprint: fingerprint === undefined || fingerprint === '-' ? null : fingerprint,
  }));

/** The deps the workers built through the engine selector, as recorded in `dataDir`: the thread and the context's mode. */
export const enginesIn = (dataDir: string): { thread: number; engine: string }[] =>
  linesOf(dataDir, ENGINES).map(([thread, engine]) => ({ thread: Number(thread), engine: engine ?? '' }));

export const createDeps = contextDeps(
  (dataDir, dataVersion, fingerprint) => {
    if (typeof fingerprint === 'string') readStable(dataDir, fingerprint, () => null);   // a refused load logs nothing
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, LOG), `${threadId} ${dataVersion} ${fingerprint ?? '-'}\n`);
    return { dataVersion };
  },
  (_base, mons, context) => {
    const log = process.env.FAKE_WORKER_MONS_LOG;   // the what-if levels test reads which Pokémon each worker was handed
    if (log !== undefined) fs.appendFileSync(log, `${JSON.stringify([...mons].map(([ref, mon]) => [ref, mon.level]))}\n`);
    if (context?.counters === undefined) return toyDepsFor(mons);
    fs.appendFileSync(path.join(context.dataDir, ENGINES), `${threadId} ${context.engine ?? '-'}\n`);
    return toyDepsFor(mons, { mode: context.engine ?? 'showdown', counters: context.counters });
  },
);
