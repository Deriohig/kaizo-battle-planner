// The real solver (a preview while the engine is unfinished): the solver over the real engine and
// trainer AI on worker threads, so the calling thread stays free to take a cancel. The server once ran it; the
// split bench (`npm run bench:split`) runs it now.
//
// One pool at a time, for the current data version and thread count: a worker loads the data once (2–8 s and about
// 140–250 MB per thread), so the solver keeps a SolverPool of `threads` workers and runs every solve on it. `threads` may
// be a getter, read whenever a pool may be needed: a changed count gets a fresh
// pool of the new size, as a data change does (below). The pool is
// made on the first solve, or at warm(), and warmed at once: every worker
// starts and loads the data before the first plan (its warm-up context has no Pokémon). Each solve reads the state's
// data and box as they are when it starts, builds this thread's deps over them, and sends its workers the context
// { dataDir, dataVersion, fingerprint, mons, engine, counters } (key: the data version, the engine mode and a hash of the
// box's Pokémon, as the request's what-if levels raise them; fingerprint: the data's, so a worker refuses a folder an
// extract has rewritten since, with code DATA_CHANGED). The engine: `engine` may be a getter,
// read once at each solve's start and resolved here (`resolveMode`: without a native engine, auto and native
// run as showdown), so every thread of a solve steps the same mode; `counters` is one SharedArrayBuffer for the
// solver's whole life, which every thread's engine adds its steps to (and its store's front the steps the store
// remembered), and a solve's run (`engineRun`) is what the cells moved while it ran. An engine change needs no new pool. So the workers build their deps
// from exactly the Pokémon this thread used, over the data they already hold (workerDeps.ts), and a box change changes
// only the context. A data change (state.dataVersion(), bumped when an extract replaces the data object) gets a fresh
// pool, which also covers what a worker caches beside its base (the dex install, the AI's ROM tables, the engine's static
// caches); the old pool closes as soon as no solve runs on it, so a solve still running on the old data ends there.
// A new thread count retires the old pool the same way: a solve running on it ends there, on the threads it started with.
// Meanwhile it drains (SolverPool.drain): its idle workers go at once and nothing refills it, so no worker loads the
// folder under the old version again (a queued job that needs a worker may still start one).
// A cancel terminates only the workers busy with that solve's jobs; on the current pool their replacements start at
// once and warm themselves. close() closes every pool and resolves once every worker has exited (the bench awaits it);
// a solve after it is refused.

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { PlayerMon } from '../battle/playerMon.js';
import type { MonRef, Solver, Verdict } from '../contracts/solver.js';
import { type EngineSteps, newCounters, stepCounters, stepsSince } from '../engines/counters.js';
import { nativeAvailable } from '../engines/native.js';
import { DEFAULT_ENGINE_MODE, type EngineMode, resolveMode } from '../engines/select.js';
import { levelledMons } from '../server/levels.js';
import type { ServerData, ServerState } from '../server/state.js';
import { createSolver, createSolverPool, type SolverConfig, type SolverDeps, type SolverPool, type WorkerContext } from '../solver/index.js';
import type { WorkerDepsContext } from './contextDeps.js';
import { baseDeps, type EngineChoice, solverDeps } from './deps.js';

export interface RealSolverOptions {
  /** The state (in `ServerState`'s shape; the split bench makes one), read when each solve starts, or null when there is none. */
  state: () => Pick<ServerState, 'data' | 'box' | 'dataVersion'> | null;
  /** The data folder the state's data was loaded from: the workers load theirs from it too. */
  dataDir: string;
  /**
   * Worker threads, a whole number of at least 2: the pool's size. A getter is read whenever a pool may be needed (each
   * solve and each warm()), and a new count gets a fresh pool. The split bench passes its `--threads`, else
   * `defaultThreads()`.
   */
  threads: number | (() => number);
  /** Each solve's width (its `threads` config), at most the pool's size; default the pool's size. The bench's `--jobs` lowers it so solves can share the pool. */
  solveThreads?: number;
  /** More solver configuration; `threads` and `depsModule` are always this solver's own (`workerExecArgv` is the pool's). */
  config?: Partial<SolverConfig>;
  /** The workers' deps module (default workerDeps.ts beside this file). The tests' seam. */
  depsModule?: string;
  /**
   * The engine mode asked for; a getter is read once at each solve's start and each warm(). Default
   * `DEFAULT_ENGINE_MODE` ('showdown').
   */
  engine?: EngineMode | (() => EngineMode);
  /** Whether the native engine is available (default `nativeAvailable`, src/engines/native.ts). The tests' seam. */
  nativeAvailable?: () => boolean;
  /**
   * This thread's deps for a solve, stepping `engine` (the resolved mode and the solver's counters; default
   * `solverDeps(baseDeps(data, dataDir), mons, engine)`). The tests' seam.
   */
  threadDeps?: (data: ServerData, dataDir: string, mons: ReadonlyMap<MonRef, PlayerMon>, engine: EngineChoice) => SolverDeps;
}

/**
 * What ran for a verdict: `mode` is the mode that ran for the `requested` one, with `note` saying why
 * they differ (else null); `id` this thread's engine id; `steps` the solve's `expandTurn` calls of the search, the
 * checker and the oracles on every thread: as `native`, `fallback` and `showdown` the engine runs (the calls that
 * reached the engine kit), and as `remembered` the calls the result store answered without running an engine. The cells
 * are shared by every solve of this solver: a solve that ended while a worker was still stepping (a stopped or
 * replaced one: the pool terminates its busy workers without waiting for them) may add those last steps to the next
 * solve's run.
 */
export interface EngineRun { requested: EngineMode; mode: EngineMode; id: string; steps: EngineSteps; note: string | null }

/** The real solver (see the top of the file). */
export interface RealSolver extends Solver {
  /**
   * Brings the pool up to the state's data and the thread count now: with data, the pool for its version and the count
   * (a new one warmed at once, every worker loading the data before the first plan; the old one closed when idle, else
   * drained and closed once its last solve ends);
   * without data, only the old pool goes. The split bench calls it before it times anything (`warmUp`, benchSplit.ts).
   * Throws RangeError when the `threads` getter gives a bad count.
   */
  warm(): void;
  /** Closes every pool and resolves once every worker has exited; a solve after it is refused. */
  close(): Promise<void>;
  /** What ran for a verdict this solver returned (kept weakly by the verdict object), else undefined. */
  engineRun(verdict: Verdict): EngineRun | undefined;
}

export const NO_DATA_MESSAGE = 'There is no game data to plan with yet: set it up first';
export const NO_BOX_MESSAGE = 'The save has not been read yet, so there is no team to plan with';
export const CLOSED_MESSAGE = 'The planner has shut down';

/** The worker deps module beside this file (workerDeps.js once built). */
const WORKER_DEPS = new URL(new URL(import.meta.url).pathname.endsWith('.ts') ? './workerDeps.ts' : './workerDeps.js', import.meta.url).href;

/** A pool, the data version its workers load and its size, with the solves running on it now. */
interface Pooled { dataVersion: number; threads: number; pool: SolverPool; solves: number }

/** `threads` itself; RangeError unless it is a whole number of at least 2. */
function checkedThreads(threads: number): number {
  if (!(Number.isInteger(threads) && threads >= 2)) {
    throw new RangeError(`The real solver runs on worker threads: threads must be a whole number of at least 2, not ${threads}`);
  }
  return threads;
}

/**
 * The real solver (see the top of the file). Throws RangeError for fewer than 2 threads; a `threads` getter's count is
 * checked when it is read, so a solve rejects, and a warm() throws, with that RangeError.
 */
export function createRealSolver(opts: RealSolverOptions): RealSolver {
  const { threads } = opts;
  if (typeof threads === 'number') checkedThreads(threads);
  /** The thread count now (the getter's, read now). */
  const threadsNow = (): number => checkedThreads(typeof threads === 'number' ? threads : threads());
  const dataDir = path.resolve(opts.dataDir);
  const depsModule = opts.depsModule ?? WORKER_DEPS;
  const threadDeps = opts.threadDeps ?? ((data, dir, mons, engine) => solverDeps(baseDeps(data, dir), mons, engine));
  const execArgv = opts.config?.workerExecArgv;
  /** The engine mode asked for now (the getter's, read now). */
  const engineNow = (): EngineMode => (typeof opts.engine === 'function' ? opts.engine() : (opts.engine ?? DEFAULT_ENGINE_MODE));
  const nativeOk = opts.nativeAvailable ?? nativeAvailable;
  /** The step counters every thread's engine adds to, for the solver's whole life (sent in every worker context). */
  const buffer = newCounters();
  const cells = stepCounters(buffer);
  const runs = new WeakMap<Verdict, EngineRun>();
  let current: Pooled | null = null;
  const draining = new Set<Pooled>();          // pools of older data with solves still running on them
  const closing = new Set<Promise<void>>();
  let closed = false;

  /**
   * A solve's worker context: its key is the data version, the engine mode and a hash of the box's Pokémon; it carries
   * the data's fingerprint and the solver's step counters.
   */
  function context(dataVersion: number, fingerprint: string | null, mode: EngineMode, mons: [MonRef, PlayerMon][]): WorkerContext {
    const value: WorkerDepsContext = { dataDir, dataVersion, fingerprint, mons, engine: mode, counters: buffer };
    return { key: `${dataVersion}:${mode}:${createHash('sha256').update(JSON.stringify(mons)).digest('hex')}`, value };
  }

  function shut(p: Pooled): void {
    const done: Promise<void> = p.pool.close().then(() => {
      closing.delete(done);
    });
    closing.add(done);
  }

  /**
   * Lets the current pool go: closed now when idle, else drained (nothing refills it, so no worker loads the folder under
   * the old version again, and its idle workers go now) and closed once its last solve ends.
   */
  function retire(): void {
    if (current === null) return;
    if (current.solves === 0) shut(current);
    else {
      current.pool.drain();
      draining.add(current);
    }
    current = null;
  }

  /**
   * The pool for `dataVersion` and the thread count now: the current one, or a new one, warmed (in engine `mode`); the
   * one before closes once no solve runs on it.
   */
  function poolFor(dataVersion: number, fingerprint: string | null, mode: EngineMode): Pooled {
    const size = threadsNow();
    if (current !== null && current.dataVersion === dataVersion && current.threads === size) return current;
    retire();
    const pool = createSolverPool({ threads: size, depsModule, ...(execArgv === undefined ? {} : { execArgv }) });
    pool.warm(context(dataVersion, fingerprint, mode, []));
    current = { dataVersion, threads: size, pool, solves: 0 };
    return current;
  }

  function release(p: Pooled): void {
    p.solves -= 1;
    if (p.solves === 0 && draining.delete(p)) shut(p);
  }

  return {
    warm() {
      if (closed) return;
      const state = opts.state();
      if (state === null) return;
      const dataVersion = state.dataVersion();
      if (state.data() !== null) poolFor(dataVersion, state.data()?.fingerprint ?? null, resolveMode(engineNow(), nativeOk()).mode);
      else if (current !== null && current.dataVersion !== dataVersion) retire();   // its data is gone: nothing to warm
    },
    async solve(req, onProgress, signal) {
      if (closed) throw new Error(CLOSED_MESSAGE);
      const state = opts.state();
      const data = state?.data() ?? null;
      const box = state?.box() ?? null;
      if (state === null || data === null) throw new Error(NO_DATA_MESSAGE);
      if (box === null) throw new Error(NO_BOX_MESSAGE);
      if ('error' in box) throw new Error(box.error);   // why the save did not read
      // What-if levels: the request's Pokémon are the box's raised with `atLevel`, for this thread and, through
      // the context, for every worker. The box's own Pokémon are untouched, and the context key hashes the raised ones.
      const mons: [MonRef, PlayerMon][] = [...levelledMons(box.byRef, new Map(Object.entries(req.levels ?? {})))];
      const dataVersion = state.dataVersion();
      const fingerprint = data.fingerprint ?? null;
      const requested = engineNow();             // read once: a change mid-solve reaches the next solve
      const { mode, note } = resolveMode(requested, nativeOk());
      const deps = threadDeps(data, dataDir, new Map(mons), { mode, counters: buffer });
      const pooled = poolFor(dataVersion, fingerprint, mode);
      pooled.solves += 1;
      try {
        const start = cells.read();
        const solver = createSolver({
          ...deps, pool: pooled.pool, workerContext: context(dataVersion, fingerprint, mode, mons),
          config: { ...opts.config, threads: Math.min(opts.solveThreads ?? pooled.threads, pooled.threads), depsModule: null },
        });
        const verdict = await solver.solve(req, onProgress, signal);
        runs.set(verdict, { requested, mode, id: deps.engine.id, steps: stepsSince(cells.read(), start), note });
        return verdict;
      } finally {
        release(pooled);
      }
    },
    engineRun(verdict) {
      return runs.get(verdict);
    },
    async close() {
      closed = true;
      for (const p of [...draining, ...(current === null ? [] : [current])]) shut(p);
      draining.clear();
      current = null;
      await Promise.all([...closing]);
    },
  };
}
