// A worker thread of the solver's pool (pool.ts). It imports the deps module (workerData.depsModule) once and builds its
// deps with the module's createDeps() (a promise is awaited): the real deps module builds the engine, the AI and the
// resolver here (and installs the Kaizo dex in this thread; docs/solver-integration.md).
// Contexts: a job may carry a context { key, value } (its solve's, pool.ts). The worker calls createDeps(value) once
// per distinct key and keeps the deps of the CONTEXTS_KEPT most recently used keys (depsCache.ts), so two overlapping
// solves can share it; the module may keep its own heavy cache across contexts. A build that fails fails the jobs
// waiting on it and is then forgotten, so the next job with that key builds again (a transient read error never
// sticks to a worker). A job without a context runs on the
// deps of createDeps() with no argument, made once. At start the worker builds the deps of workerData.context (its
// warm-up: pool.ts), or createDeps()'s when it has none, as before contexts existed.
// Then it answers each { id, job, context? } with { id, result } (runJob, jobs.ts) or { id, error } (the message, the
// `code` when it is a string or a number, and the stack), sending { id, progress } on the way at most every
// progressIntervalMs of the job's config. The job's deadlines arrive as the time left; they become absolute on the deps'
// clock (deps.now, default performance.now) when the job starts. A deps module that fails to load, or deps that fail to
// build, are reported with every job that needs them (createDeps() without a context is made once, its failure kept).

import { type MessagePort, parentPort, workerData } from 'node:worker_threads';
import { DEFAULT_CONFIG } from '../config.js';
import type { ProgressSink } from '../solve.js';
import type { SolverDeps } from '../types.js';
import { CONTEXTS_KEPT, RecentCache } from './depsCache.js';
import { runJob, type Job } from './jobs.js';
import type { WorkerContext, WorkerInit, WorkerReply, WorkerRequest } from './pool.js';

function ownPort(): MessagePort {
  if (parentPort === null) throw new Error('worker: runs only as a worker thread of the solver pool');
  return parentPort;
}

const port = ownPort();
const { depsModule, context: warmContext } = workerData as WorkerInit;

type CreateDeps = (context?: unknown) => SolverDeps | Promise<SolverDeps>;

const createDeps: Promise<CreateDeps> = import(depsModule).then((m: { createDeps?: CreateDeps }) => {
  const create = m.createDeps;
  if (typeof create !== 'function') throw new Error(`worker: ${depsModule} exports no createDeps()`);
  return create;
});

/** `p`, its rejection left for the jobs to report. */
function reported<T>(p: Promise<T>): Promise<T> {
  p.catch(() => undefined);
  return p;
}

let plain: Promise<SolverDeps> | null = null;
const byKey = new RecentCache<Promise<SolverDeps>>(CONTEXTS_KEPT);

/** The deps for `context` (see the top of the file). */
function depsFor(context: WorkerContext | undefined): Promise<SolverDeps> {
  if (context === undefined) return plain ??= reported(createDeps.then((create) => create()));
  const { key } = context;
  return byKey.get(key, () => {
    const built = reported(createDeps.then((create) => create(context.value)));
    built.catch(() => byKey.forget(key, built));   // a failed build is not kept: the next job with this key tries again
    return built;
  });
}

void depsFor(warmContext);   // the warm-up (see the top of the file)

/** Progress for job `id`: the nodes since the last report and the latest message, at most every `intervalMs`. */
function reporter(id: number, intervalMs: number): ProgressSink {
  let nodes = 0;
  let last = Number.NEGATIVE_INFINITY;
  return {
    node() {
      nodes += 1;
    },
    message(text) {
      const t = performance.now();
      if (t - last < intervalMs) return;
      last = t;
      port.postMessage({ id, progress: { nodes, message: text } } satisfies WorkerReply);
      nodes = 0;
    },
    teams() {},
  };
}

function failure(id: number, e: unknown): WorkerReply {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return {
    id, error: {
      message: e instanceof Error ? e.message : String(e), ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
      ...(e instanceof Error && e.stack !== undefined ? { stack: e.stack } : {}),
    },
  };
}

async function answer({ id, job, context }: WorkerRequest): Promise<void> {
  let reply: WorkerReply;
  try {
    const d = await depsFor(context);
    const t = (d.now ?? (() => performance.now()))();
    const own: Job = { ...job, deadline: t + job.deadline, checkerDeadline: t + job.checkerDeadline };
    reply = { id, result: runJob(d, own, reporter(id, job.config?.progressIntervalMs ?? DEFAULT_CONFIG.progressIntervalMs)) };
  } catch (e) {
    reply = failure(id, e);
  }
  try {
    port.postMessage(reply);
  } catch (e) {   // a result that cannot be cloned
    port.postMessage(failure(id, new Error(`worker: the result could not be sent: ${e instanceof Error ? e.message : String(e)}`)));
  }
}

port.on('message', (m: WorkerRequest) => {
  void answer(m);
});
