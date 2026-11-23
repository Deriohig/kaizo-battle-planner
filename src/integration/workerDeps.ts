// The solver's deps module for the real solver's worker threads (its SolverPool's depsModule; docs/solver-integration.md
// section 8). Each worker imports it once and calls createDeps(context) once per solve context key (the solver's
// worker.ts keeps the 2 most recent), with context = { dataDir, dataVersion, fingerprint, mons, engine, counters }
// (realSolver.ts). The base, the data loaded from `dataDir` with the Kaizo dex installed in this thread and the trainer
// AI, loads once per `dataDir|dataVersion` and only the current one is kept (contextDeps.ts); it loads only from a
// folder whose bytes have the context's fingerprint, the server's (readBaseDeps; else DataChangedError, which fails the
// solve's jobs with code DATA_CHANGED). The deps are built over it from the context's Pokémon, as the server's thread
// builds them, stepping the engine the context names: its mode, resolved on the server's thread, counted
// into the real solver's shared counters.

import { DEFAULT_ENGINE_MODE } from '../engines/select.js';
import { contextDeps } from './contextDeps.js';
import { readBaseDeps, solverDeps } from './deps.js';

export const createDeps = contextDeps((dir, _version, fingerprint) => readBaseDeps(dir, fingerprint), (base, mons, context) =>
  solverDeps(base, mons, { mode: context.engine ?? DEFAULT_ENGINE_MODE, ...(context.counters === undefined ? {} : { counters: context.counters }) }));
