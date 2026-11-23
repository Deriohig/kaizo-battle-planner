// The workers' createDeps(context) over a base loader and a deps builder (workerDeps.ts uses readBaseDeps and
// solverDeps; the tests a stand-in). Each solve's jobs carry a context { dataDir, dataVersion, fingerprint, mons }
// (realSolver.ts), and the worker calls createDeps once per distinct context key (src/solver/parallel/worker.ts). The
// base, the loaded data with its dex install and the trainer AI, is the heavy part (2–8 s and about 140–250 MB per
// thread): it is loaded once per `dataDir|dataVersion` and only the current one is kept here, so a data change loads
// exactly once. The load gets the context's fingerprint, the content fingerprint of the data the server loaded
// (src/integration/fingerprint.ts; null: no check), so it can refuse a folder that holds other bytes (readBaseDeps
// throws DataChangedError). The base is kept beside the fingerprint it was loaded with, and a context with another
// one loads again, even at the same key: one data version has one fingerprint today, but a base loaded unchecked
// (null) is never reused for a context that asks for a check. The old base can be collected only once the worker's own cache of the 2 most recent
// contexts' deps (which hold it) has moved on too. The deps themselves are built per context over that base from the
// context's Pokémon, and the builder gets the whole context too, so it builds the engine the context names (its `engine` mode and `counters`). A load that throws keeps nothing, so the next context tries again. This module
// imports nothing heavy, so a test's deps module can use it in a worker.

import type { PlayerMon } from '../battle/playerMon.js';
import type { MonRef } from '../contracts/solver.js';
import type { EngineMode } from '../engines/select.js';
import type { SolverDeps } from '../solver/index.js';

/**
 * What a solve sends its workers (SolverDeps.workerContext's value): the data folder, the data version, the content
 * fingerprint of the data the server loaded (ServerData.fingerprint; null when it has none) and the box's eligible
 * Pokémon, with the engine to step.
 */
export interface WorkerDepsContext {
  dataDir: string; dataVersion: number; fingerprint: string | null; mons: [MonRef, PlayerMon][];
  /** The engine mode, resolved on the server's thread (src/engines/select.ts `resolveMode`); absent means 'showdown'. */
  engine?: EngineMode;
  /** The real solver's step counters (src/engines/counters.ts), shared by every thread; absent means nothing is counted. */
  counters?: SharedArrayBuffer;
}

/** createDeps(context) over `load` and `build` (see the top of the file). */
export function contextDeps<B>(
  load: (dataDir: string, dataVersion: number, fingerprint: string | null) => B,
  build: (base: B, mons: ReadonlyMap<MonRef, PlayerMon>, context: WorkerDepsContext) => SolverDeps,
): (context: WorkerDepsContext) => SolverDeps {
  let current: { key: string; fingerprint: string | null; base: B } | null = null;
  return (context) => {
    if (context === undefined) {
      throw new Error("The planner's worker deps module needs the solve's context { dataDir, dataVersion, fingerprint, mons } (src/integration/realSolver.ts)");
    }
    const key = `${context.dataDir}|${context.dataVersion}`;
    const fingerprint = context.fingerprint ?? null;
    if (current?.key !== key || current.fingerprint !== fingerprint) {
      current = null;                            // the old base goes before the new one loads
      current = { key, fingerprint, base: load(context.dataDir, context.dataVersion, fingerprint) };
    }
    return build(current.base, new Map(context.mons), context);
  };
}
