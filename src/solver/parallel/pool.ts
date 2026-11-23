// The worker pool: up to `threads`
// node:worker_threads, each running worker.ts on its own copy of the deps (built by the deps module's createDeps(),
// once per worker for each context key; worker.ts), one job at a time.
//
// Workers start lazily, when a job needs one and fewer than `threads` are alive, with `execArgv` (the solver's default
// ['--import', 'tsx'], so a worker can load .ts) on worker.ts beside this file (worker.js once built). Jobs wait in
// order and go to the first idle worker. A job's deadlines are sent as the time left on its lane's clock (`now`,
// default the pool's, default performance.now) when it is dispatched; the worker adds its own now (each thread has its
// own performance.now origin).
// Lanes: lane({ limit, context, now }) is one solve's handle on the pool. At most `limit` of its jobs run at once (the
// others wait in the queue, which skips them while their lane is full, so jobs of different lanes queue, never
// collide); every one of its jobs carries `context` (a structured-cloneable { key, value }) to the worker, which builds
// that context's deps once per key (worker.ts); its deadlines are on its `now`. lane.close() rejects the lane's jobs
// still queued or running (a running one's worker is terminated, as by an abort) and every later run; it leaves the
// pool and the other lanes alone. run() is a lane of the whole pool with no context.
// Progress: a worker reports { nodes since its last report, the latest message } at most every progressIntervalMs of
// the job's config; run's `onProgress` sees them.
// Abort: aborting a job's signal rejects its promise with an AbortError. A queued job just leaves the queue; a running
// one has its worker terminated (a synchronous search cannot be interrupted any other way), and only that worker: the
// jobs of other lanes run on. A worker that crashes or exits rejects its job with the error; a job that throws in the
// worker rejects with its message and `code`. Either way the worker is gone, and a fresh one starts when the next job
// needs one, or at once on a warmed pool.
// Warm-up: warm(context) starts every missing worker now, each building its deps for `context` before any job (the
// context travels in workerData); from then on a worker terminated by an abort or lost to a crash mid-job is replaced
// at once, and the replacement warms itself with the last good context: warm's, or that of the most recent job that
// succeeded (a context none of whose jobs has succeeded, such as one whose deps build kills the worker, never warms a
// replacement). A worker that dies idle (at start, or while warming) is replaced only when a job needs one, so a worker
// that cannot start (a bad execArgv) is never restarted in a loop; nor does aborting a job that only waited in the queue
// restart one. A queued job whose signal has aborted is never dispatched (its abort listener, in the same dispatch,
// removes it). A worker started for a job warms itself with that job's context. Without any context a worker calls
// createDeps() at start, as before contexts existed.
// Drain: drain() ends the warm-up's promise (an owner calls it on a pool it is letting go, such as one of old data that
// a solve still runs on): nothing refills the pool from then on, its idle workers are terminated at once, and its busy
// ones finish their jobs and stay for the jobs still to come. A queued job that needs a worker may still start one, as
// on a pool never warmed. A later warm() keeps the pool full again.
// close() rejects every queued and running job, terminates every worker and resolves once all of them have exited.
// liveWorkers() counts the worker threads of every pool that have started and not yet exited.

import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { Job, JobResult } from './jobs.js';

/** A solve's per-solve payload for its workers' deps module: `value` is structured-cloned to createDeps(value), once per `key`. */
export interface WorkerContext { key: string; value: unknown }

/** What a worker starts with (workerData): the deps module and the context to warm itself with, if any. */
export interface WorkerInit { depsModule: string; context?: WorkerContext }

/** What the pool sends a worker: the job, its deadlines as the time left (see the top of the file), and its context. */
export interface WorkerRequest { id: number; job: Job; context?: WorkerContext }

/** What a worker answers: progress on the way, then the result or the error. */
export type WorkerReply =
  | { id: number; progress: { nodes: number; message: string } }
  | { id: number; result: JobResult }
  | { id: number; error: { message: string; code?: string | number; stack?: string } };

export interface PoolOptions {
  threads: number; depsModule: string; execArgv: string[];
  now?: () => number;                   // the clock the jobs' deadlines are on (default performance.now)
}

export interface LaneOptions {
  limit?: number;                       // the most jobs of this lane running at once (default: the pool's threads)
  context?: WorkerContext;              // sent with every job of this lane
  now?: () => number;                   // the clock this lane's deadlines are on (default: the pool's)
}

/** A job's progress: the search nodes since the last report and the worker's latest message. */
export type JobProgress = (nodes: number, message: string) => void;

/** Runs jobs: a pool, or one lane of it. */
export interface JobRunner {
  run(job: Job, signal?: AbortSignal, onProgress?: JobProgress): Promise<JobResult>;
}

/** One solve's handle on a pool (see the top of the file). */
export interface PoolLane extends JobRunner {
  /** Rejects the lane's jobs still queued or running (terminating the workers running them) and every later run. */
  close(): void;
}

let live = 0;

/** Worker threads of every pool that have started and not yet exited. */
export function liveWorkers(): number {
  return live;
}

const WORKER_URL = new URL(new URL(import.meta.url).pathname.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url);

/** The error an aborted job rejects with. */
export function abortError(): Error {
  return Object.assign(new Error('the job was cancelled'), { name: 'AbortError' });
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/** The deps module as an import() specifier: a path (absolute, or relative to the working directory) becomes a file URL. */
export function moduleSpecifier(spec: string): string {
  return isAbsolute(spec) || spec.startsWith('./') || spec.startsWith('../') ? pathToFileURL(resolve(spec)).href : spec;
}

function remoteError(e: { message: string; code?: string | number; stack?: string }): Error {
  const error = new Error(e.message);
  if (e.stack !== undefined) error.stack = e.stack;
  return e.code === undefined ? error : Object.assign(error, { code: e.code });
}

interface Lane {
  limit: number; context: WorkerContext | undefined; now: () => number;
  running: number;                      // its jobs on a worker now
  jobs: Set<Pending>;                   // its jobs not yet settled
  closed: boolean;
}

interface Pending {
  id: number; job: Job; lane: Lane; resolve: (r: JobResult) => void; reject: (e: unknown) => void;
  signal?: AbortSignal; onAbort?: () => void; onProgress?: JobProgress;
  slot: Slot | null; done: boolean;
}

interface Slot { worker: Worker; busy: Pending | null }

export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private readonly exits = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly depsModule: string;
  private readonly whole: Lane;
  private latest: WorkerContext | undefined;   // the last good context: warm's, or that of the latest job that succeeded
  private warmed = false;
  private nextId = 0;
  private closed = false;

  constructor(private readonly opts: PoolOptions) {
    if (!(Number.isInteger(opts.threads) && opts.threads >= 1)) throw new RangeError(`pool: threads must be a positive integer, got ${opts.threads}`);
    this.now = opts.now ?? (() => performance.now());
    this.depsModule = moduleSpecifier(opts.depsModule);
    this.whole = this.newLane({});
  }

  /** The most workers this pool runs at once. */
  get size(): number {
    return this.opts.threads;
  }

  /** The workers running a job now. */
  get busy(): number {
    return this.slots.filter((s) => s.busy !== null).length;
  }

  /** Runs `job` on a worker (see the top of the file). */
  run(job: Job, signal?: AbortSignal, onProgress?: JobProgress): Promise<JobResult> {
    return this.enqueue(this.whole, job, signal, onProgress);
  }

  /** A lane of this pool: one solve's limit, context and clock (see the top of the file). */
  lane(opts: LaneOptions): PoolLane {
    const lane = this.newLane(opts);
    return {
      run: (job, signal, onProgress) => this.enqueue(lane, job, signal, onProgress),
      close: () => this.closeLane(lane),
    };
  }

  /**
   * Starts every missing worker now, each building its deps for `context`; from now on a worker lost to an abort or a
   * crash mid-job is replaced at once (see the top of the file). Throws for a context that cannot be cloned.
   */
  warm(context: WorkerContext): void {
    if (this.closed) return;
    structuredClone(context);
    this.latest = context;
    this.warmed = true;
    this.fill();
  }

  /**
   * Stops keeping the pool full (see the top of the file): nothing refills it from now on, and its idle workers are
   * terminated now. Busy workers finish their jobs and stay for the jobs still to come.
   */
  drain(): void {
    this.warmed = false;
    for (const slot of this.slots.filter((s) => s.busy === null)) this.retire(slot);
  }

  /** Rejects every job left, terminates every worker and resolves once all have exited. */
  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.queue.splice(0)) this.settle(p, { error: new Error('pool: closed before the job ran') });
    for (const slot of [...this.slots]) {
      if (slot.busy !== null) this.settle(slot.busy, { error: new Error('pool: closed while the job ran') });
      this.retire(slot);
    }
    await Promise.all([...this.exits]);
  }

  private newLane(opts: LaneOptions): Lane {
    const limit = opts.limit ?? this.opts.threads;
    if (!(Number.isInteger(limit) && limit >= 1)) throw new RangeError(`pool: a lane's limit must be a positive integer, got ${limit}`);
    return { limit, context: opts.context, now: opts.now ?? this.now, running: 0, jobs: new Set(), closed: false };
  }

  private enqueue(lane: Lane, job: Job, signal: AbortSignal | undefined, onProgress: JobProgress | undefined): Promise<JobResult> {
    if (this.closed || lane.closed) return Promise.reject(new Error('pool: closed'));
    if (signal?.aborted === true) return Promise.reject(abortError());
    return new Promise<JobResult>((resolve, reject) => {
      const p: Pending = { id: this.nextId++, job, lane, resolve, reject, signal, onProgress, slot: null, done: false };
      if (signal !== undefined) {
        p.onAbort = () => this.abort(p);
        signal.addEventListener('abort', p.onAbort, { once: true });
      }
      lane.jobs.add(p);
      this.queue.push(p);
      this.pump();
    });
  }

  private closeLane(lane: Lane): void {
    if (lane.closed) return;
    lane.closed = true;
    for (const p of [...lane.jobs]) {
      const at = this.queue.indexOf(p);
      if (at >= 0) {
        this.queue.splice(at, 1);
        this.settle(p, { error: new Error('pool: the lane closed before the job ran') });
      } else {
        if (p.slot !== null && p.slot.busy === p) this.retire(p.slot);
        this.settle(p, { error: new Error('pool: the lane closed while the job ran') });
      }
    }
    this.fill();
    this.pump();
  }

  private pump(): void {
    while (!this.closed) {
      // A job whose signal has aborted waits for its own abort listener (which runs in this same dispatch): sent now, it
      // would only cost a warm worker its life.
      const at = this.queue.findIndex((p) => p.lane.running < p.lane.limit && p.signal?.aborted !== true);
      if (at < 0) return;
      const p = this.queue[at]!;
      let slot = this.slots.find((s) => s.busy === null) ?? null;
      if (slot === null) {
        if (this.slots.length >= this.opts.threads) return;
        try {
          slot = this.spawn(p.lane.context ?? this.latest);
        } catch (e) {   // a worker that cannot even start (a bad execArgv, a context that cannot be cloned): the job fails, not the pool
          this.queue.splice(at, 1);
          this.settle(p, { error: e });
          continue;
        }
      }
      this.queue.splice(at, 1);
      this.dispatch(slot, p);
    }
  }

  /** On a warmed pool, starts workers until there are `threads`, each warming itself with the last good context. */
  private fill(): void {
    while (this.warmed && !this.closed && this.slots.length < this.opts.threads) {
      try {
        this.spawn(this.latest);
      } catch {   // a worker that cannot start: the next job that needs one reports why
        return;
      }
    }
  }

  private spawn(context: WorkerContext | undefined): Slot {
    const init: WorkerInit = { depsModule: this.depsModule, ...(context === undefined ? {} : { context }) };
    const worker = new Worker(WORKER_URL, { execArgv: [...this.opts.execArgv], workerData: init });
    live += 1;
    const slot: Slot = { worker, busy: null };
    const exit = new Promise<void>((done) => {
      worker.once('exit', () => {
        live -= 1;
        this.exits.delete(exit);
        done();
      });
    });
    this.exits.add(exit);
    worker.on('message', (m: WorkerReply) => this.onReply(slot, m));
    worker.on('error', (e) => this.onCrash(slot, e));
    worker.on('exit', (code) => this.onCrash(slot, new Error(`pool: a worker exited with code ${code}`)));
    this.slots.push(slot);
    return slot;
  }

  private dispatch(slot: Slot, p: Pending): void {
    slot.busy = p;
    p.slot = slot;
    p.lane.running += 1;
    const t = p.lane.now();
    const { context } = p.lane;
    const request: WorkerRequest = {
      id: p.id, job: { ...p.job, deadline: p.job.deadline - t, checkerDeadline: p.job.checkerDeadline - t }, ...(context === undefined ? {} : { context }),
    };
    try {
      slot.worker.postMessage(request);
    } catch (e) {   // a job (or context) that cannot be cloned
      slot.busy = null;
      this.settle(p, { error: e });
    }
  }

  private onReply(slot: Slot, m: WorkerReply): void {
    const p = slot.busy;
    if (p === null || p.id !== m.id || p.done) return;
    if ('progress' in m) {
      p.onProgress?.(m.progress.nodes, m.progress.message);
      return;
    }
    slot.busy = null;
    // A job that succeeded makes its context the one replacements warm with: a context whose deps never built (one
    // that kills the worker, say) never is.
    if ('result' in m && p.lane.context !== undefined) this.latest = p.lane.context;
    this.settle(p, 'result' in m ? { result: m.result } : { error: remoteError(m.error) });
    this.pump();
  }

  /** A worker's error or exit; nothing when it was retired on purpose. */
  private onCrash(slot: Slot, error: unknown): void {
    const at = this.slots.indexOf(slot);
    if (at < 0) return;
    this.slots.splice(at, 1);
    const p = slot.busy;
    slot.busy = null;
    if (p !== null) this.settle(p, { error });
    void slot.worker.terminate();
    // Lost mid-job: replaced at once on a warmed pool. Died idle (at start, or while warming): replaced only when a job
    // needs one, so a worker that cannot start is never restarted in a loop.
    if (p !== null) this.fill();
    this.pump();
  }

  private abort(p: Pending): void {
    if (p.done) return;
    const at = this.queue.indexOf(p);
    let retired = false;
    if (at >= 0) this.queue.splice(at, 1);
    else if (p.slot !== null && p.slot.busy === p) {
      this.retire(p.slot);
      retired = true;
    }
    this.settle(p, { error: abortError() });
    // Only the worker this abort terminated is replaced: a job that only waited in the queue restarts none that died idle.
    if (retired) this.fill();
    this.pump();
  }

  /** Terminates a worker on purpose (its exit is then no crash). */
  private retire(slot: Slot): void {
    const at = this.slots.indexOf(slot);
    if (at >= 0) this.slots.splice(at, 1);
    slot.busy = null;
    void slot.worker.terminate();
  }

  private settle(p: Pending, outcome: { result: JobResult } | { error: unknown }): void {
    if (p.done) return;
    p.done = true;
    p.lane.jobs.delete(p);
    if (p.slot !== null) p.lane.running -= 1;
    if (p.onAbort !== undefined) p.signal?.removeEventListener('abort', p.onAbort);
    if ('result' in outcome) p.resolve(outcome.result);
    else p.reject(outcome.error);
  }
}
