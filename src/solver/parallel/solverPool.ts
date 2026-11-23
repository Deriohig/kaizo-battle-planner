// A pool of worker threads that outlives solves (docs/solver-integration.md section 8): createSolverPool wraps a
// WorkerPool (pool.ts) that its owner keeps for as long as it likes and closes itself. Passed as SolverDeps.pool,
// createSolver runs the solve's jobs on it, in a lane of its own (at most min(config threads, size) jobs at once, the
// solve's worker context on every job, the solve's clock), and never closes it; the lane is closed when the solve ends.
// warm(context) starts every worker now, each building its deps for `context`, and keeps the pool at full size from then
// on (a worker lost to a cancel or a crash mid-job is replaced at once and warms itself with the last good context:
// warm's, or that of the latest job that succeeded; one that dies idle, at start or while warming, is replaced only when
// a job needs one, so it is never restarted in a loop). drain() undoes that for a pool its owner is letting go: nothing
// refills it, its idle workers are terminated at once, and its busy ones finish their jobs (pool.ts).

import { DEFAULT_CONFIG } from '../config.js';
import { type LaneOptions, type PoolLane, type WorkerContext, WorkerPool } from './pool.js';

export interface SolverPoolOptions {
  threads: number;                      // the most workers at once (a positive integer)
  depsModule: string;                   // the module whose createDeps(context?) builds a worker's deps (as config.depsModule)
  execArgv?: string[];                  // the workers' execArgv (default the solver's, ['--import', 'tsx'])
}

export class SolverPool {
  readonly #pool: WorkerPool;

  constructor(opts: SolverPoolOptions) {
    this.#pool = new WorkerPool({ threads: opts.threads, depsModule: opts.depsModule, execArgv: [...(opts.execArgv ?? DEFAULT_CONFIG.workerExecArgv)] });
  }

  /** The most workers this pool runs at once. */
  get size(): number {
    return this.#pool.size;
  }

  /** The workers running a job now. */
  get busy(): number {
    return this.#pool.busy;
  }

  /** Starts every worker now, each building its deps for `context` (see the top of the file). */
  warm(context: WorkerContext): void {
    this.#pool.warm(context);
  }

  /**
   * Stops keeping the pool full: nothing refills it from now on, its idle workers are terminated now, and its busy ones
   * finish their jobs (see the top of the file).
   */
  drain(): void {
    this.#pool.drain();
  }

  /** One solve's lane (createSolver's). */
  lane(opts: LaneOptions): PoolLane {
    return this.#pool.lane(opts);
  }

  /** Rejects every job left, terminates every worker and resolves once all have exited. */
  close(): Promise<void> {
    return this.#pool.close();
  }
}

/** A pool of worker threads that outlives solves (see the top of the file). Throws RangeError for bad threads. */
export function createSolverPool(opts: SolverPoolOptions): SolverPool {
  return new SolverPool(opts);
}
