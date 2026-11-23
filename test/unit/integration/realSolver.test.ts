import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { SolveRequest, Verdict } from '../../../src/contracts/solver.js';
import type { EngineSteps } from '../../../src/engines/counters.js';
import { type EngineMode, NATIVE_MISSING_NOTE } from '../../../src/engines/select.js';
import { DATA_CHANGED, DATA_CHANGED_MESSAGE, fingerprintData } from '../../../src/integration/fingerprint.js';
import { createRealSolver, NO_BOX_MESSAGE, NO_DATA_MESSAGE, type RealSolver, type RealSolverOptions } from '../../../src/integration/realSolver.js';
import { liveWorkers } from '../../../src/solver/parallel/pool.js';
import type { BoxState } from '../../../src/server/box.js';
import type { ServerData } from '../../../src/server/state.js';
import { critOnlyBudget1, safe1v1, slowStall, type Scenario } from '../solver/toy/scenarios.js';
import { enginesIn, FAKE_WORKER_DEPS, loadsIn, toyDepsFor } from './fakeWorkerDeps.js';

const REQUEST: SolveRequest = {
  fights: [{ trainerId: 'roark-split/youngster-tristan/1' }], team: { kind: 'fixed', party: ['party:1'] }, preStatus: 'given',
  budgetMs: 1_000, horizonTurns: 50, attemptAnyLegalBadge: false, ranking: [],
};
const DATA = {} as ServerData;   // never read: the fake deps build the toy's
const SLOW = 60_000;
const WAIT = { timeout: 20_000, interval: 20 };

// Every solver is closed after its test, so no worker thread outlives it; the data folders are removed.
const solvers: RealSolver[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const solver of solvers.splice(0)) await solver.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.FAKE_WORKER_MONS_LOG;
  expect(liveWorkers()).toBe(0);
});

const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
/** A box whose first Pokémon names the toy scenario `s` (fakeWorkerDeps.ts builds its deps). */
const boxOf = (s: Scenario) => ({ byRef: new Map([['party:0', { nickname: s.name } as PlayerMon]]) }) as unknown as BoxState;
const request = (s: Scenario, over: Partial<SolveRequest> = {}): SolveRequest => ({
  fights: [{ trainerId: s.trainerId }], team: { kind: 'fixed', party: ['party:0'] }, preStatus: 'given',
  budgetMs: 600_000, horizonTurns: s.horizon, attemptAnyLegalBadge: false, ranking: [], ...over,
});
const tierOf = async (solver: RealSolver, s: Scenario = safe1v1) => (await solver.solve(request(s))).tier;

/** A real solver over the fake worker deps and a server state the test changes; its data folder holds the workers' logs. */
function realSolver(start: Scenario = safe1v1, threads: number | (() => number) = 2, more: Partial<RealSolverOptions> = {}) {
  const dataDir = tempDir('real-solver-');
  const server = { version: 1, box: boxOf(start), data: DATA as ServerData | null };
  const solver = createRealSolver({
    state: () => ({ data: () => server.data, box: () => server.box, dataVersion: () => server.version }),
    dataDir, threads, depsModule: FAKE_WORKER_DEPS, threadDeps: (_data, _dir, mons) => toyDepsFor(mons), config: { progressIntervalMs: 0 }, ...more,
  });
  solvers.push(solver);
  return { solver, server, dataDir, loads: () => loadsIn(dataDir), engines: () => enginesIn(dataDir) };
}

/** Starts slowStall's solve, which runs until cancelled, and waits until it is under way. */
async function slowSolve(solver: RealSolver, loads: () => unknown[]) {
  const cancel = new AbortController();
  let nodes = 0;
  const verdict = solver.solve(request(slowStall), (p) => {
    nodes = p.nodes;
  }, cancel.signal);
  await vi.waitFor(() => expect([liveWorkers(), nodes > 0, loads().length]).toEqual([2, true, 2]), WAIT);
  return {
    abort: () => cancel.abort(),
    done: async () => {
      const v = await verdict;
      if (v.tier !== 'unproven') throw new Error(`expected unproven, got tier ${v.tier}`);
      expect([v.reason, v.detail]).toEqual(['timeout', 'cancelled']);   // its own cancel, not a closed pool's error
    },
  };
}

describe('createRealSolver', () => {
  it('refuses fewer than 2 threads', () => {
    expect(() => createRealSolver({ state: () => null, dataDir: 'data', threads: 1 })).toThrow(RangeError);
  });

  const error = 'Cannot read /saves/game.dsv: bad checksum in both partitions';
  it.each<[string, string, RealSolverOptions['state']]>([
    ['no data', NO_DATA_MESSAGE, () => null],
    ['no box', NO_BOX_MESSAGE, () => ({ data: () => DATA, box: () => null, dataVersion: () => 1 })],
    ['why the save did not read', error, () => ({ data: () => DATA, box: () => ({ error }), dataVersion: () => 1 })],
  ])('says %s before it starts a solve', async (_, message, state) => {
    await expect(createRealSolver({ state, dataDir: 'data', threads: 2 }).solve(REQUEST)).rejects.toThrow(message);
  });
});

it('builds the solve Pokémon at the request levels here and in every worker, the box untouched; a solve without levels uses the box ones', async () => {
  const monAt15 = (nickname: string, slot: number) => ({
    nickname, level: 15, baseStats: { hp: 64, atk: 78, def: 52, spa: 78, spd: 52, spe: 81 },
    ivs: { hp: 0, atk: 26, def: 12, spa: 10, spd: 7, spe: 24 }, evs: { hp: 4, atk: 252, def: 1, spa: 2, spd: 3, spe: 250 },
    nature: { value: 8, source: 'rom', disputed: false, alternatives: [] }, ability: { value: 66, source: 'rom', disputed: false, alternatives: [] }, currentHp: 30, moves: [], pp: [], ppUps: [], notes: [],
    status: { kind: 'none' }, location: { kind: 'party', slot }, types: [10, 1],
  }) as unknown as PlayerMon;
  const log = path.join(tempDir('real-solver-levels-'), 'mons.log');
  process.env.FAKE_WORKER_MONS_LOG = log;
  const second = monAt15('Second', 1);
  const box = { byRef: new Map([['party:0', monAt15(safe1v1.name, 0)], ['party:1', second]]) } as unknown as BoxState;
  const seen: ReadonlyMap<string, PlayerMon>[] = [];
  const { solver } = realSolver(safe1v1, 2, {
    state: () => ({ data: () => DATA, box: () => box, dataVersion: () => 1 }),
    threadDeps: (_data, _dir, mons) => { seen.push(mons); return toyDepsFor(mons); },
  });
  const workerLevels = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as [string, number][]) : []);
  const levels = (mons: ReadonlyMap<string, PlayerMon>) => [...mons].map(([ref, mon]) => [ref, mon.level]);

  await solver.solve(request(safe1v1, { levels: { 'party:1': 18 } }));
  expect(levels(seen[0]!)).toEqual([['party:0', 15], ['party:1', 18]]);
  expect(seen[0]!.get('party:1')!.currentHp).toBeGreaterThan(30);
  await vi.waitFor(() => expect(workerLevels()).toContainEqual([['party:0', 15], ['party:1', 18]]), WAIT);
  expect(box.byRef.get('party:1')).toBe(second);
  expect(second.level).toBe(15);
  await solver.solve(request(safe1v1));   // the workers do not keep the levelled ones
  expect(levels(seen[1]!)).toEqual([['party:0', 15], ['party:1', 15]]);
  await vi.waitFor(() => expect(workerLevels()).toContainEqual([['party:0', 15], ['party:1', 15]]), WAIT);
}, SLOW);

describe('the real solver keeps one pool', () => {
  it('two solves reuse the pool, the base deps loaded once per worker; close() leaves no worker and refuses a solve after it', async () => {
    const { solver, loads } = realSolver();
    for (const run of [1, 2]) expect([await tierOf(solver), liveWorkers()], `solve ${run}`).toEqual([1, 2]);
    await vi.waitFor(() => expect(loads()).toHaveLength(2), WAIT);
    const [a, b] = loads();
    expect([a!.dataVersion, b!.dataVersion, a!.thread === b!.thread]).toEqual([1, 1, false]);
    await solver.close();
    expect(liveWorkers()).toBe(0);
    await expect(solver.solve(request(safe1v1))).rejects.toThrow('The planner has shut down');
  }, SLOW);

  it('warm() starts the workers only with data, loading it before the first plan; after a data change it swaps the idle pool, or only closes it with no data', async () => {
    const { solver, server, loads } = realSolver();
    server.data = null;
    solver.warm();
    expect(liveWorkers()).toBe(0);
    server.data = DATA;
    solver.warm();
    expect(liveWorkers()).toBe(2);
    await vi.waitFor(() => expect(loads()).toHaveLength(2), WAIT);
    expect(await tierOf(solver)).toBe(1);
    expect([loads().length, liveWorkers()]).toEqual([2, 2]);
    server.version = 2;
    solver.warm();
    await vi.waitFor(() => expect(loads().filter((l) => l.dataVersion === 2)).toHaveLength(2), WAIT);
    await vi.waitFor(() => expect(liveWorkers()).toBe(2), WAIT);
    server.version = 3;   // a reload that left no data (a failed re-extract)
    server.data = null;
    solver.warm();
    await vi.waitFor(() => expect(liveWorkers()).toBe(0), WAIT);
    expect(loads()).toHaveLength(4);
  }, SLOW);

  it('a data change loads fresh base deps on a new pool, and closes the old one; a box change reuses the pool', async () => {
    const { solver, server, loads } = realSolver();
    expect(await tierOf(solver)).toBe(1);
    server.box = boxOf(critOnlyBudget1);   // workers that kept safe1v1's deps would not know this trainer
    expect(await tierOf(solver, critOnlyBudget1)).toBe(2);
    await vi.waitFor(() => expect(loads()).toHaveLength(2), WAIT);
    expect(liveWorkers()).toBe(2);
    const before = new Set(loads().map((l) => l.thread));
    server.version = 2;
    server.box = boxOf(safe1v1);
    expect(await tierOf(solver)).toBe(1);
    await vi.waitFor(() => expect(loads().filter((l) => l.dataVersion === 2)).toHaveLength(2), WAIT);
    expect(loads().filter((l) => l.dataVersion === 2 && before.has(l.thread))).toEqual([]);   // new workers
    await vi.waitFor(() => expect(liveWorkers()).toBe(2), WAIT);                                // the old pool's two have exited
    expect(loads()).toHaveLength(4);                                                            // the box change loaded nothing
  }, SLOW);

  it.each([['data', 2], ['threads', 3]] as const)(
    'a solve still running when the %s change ends on its own pool, whose idle worker goes at once and which refills nothing',
    async (change, newSize) => {
      let threads = 2;
      const { solver, server, loads } = realSolver(slowStall, () => threads);
      const slow = await slowSolve(solver, loads);
      if (change === 'data') server.version = 2;
      else threads = 3;
      server.box = boxOf(safe1v1);
      solver.warm();
      await vi.waitFor(() => expect(liveWorkers()).toBe(newSize + 1), WAIT);   // the new pool, and the old pool's busy worker
      expect(await tierOf(solver)).toBe(1);
      await vi.waitFor(() => expect(loads()).toHaveLength(2 + newSize), WAIT);
      expect(liveWorkers()).toBe(newSize + 1);                                 // the old pool's busy worker still runs
      slow.abort();
      expect(liveWorkers()).toBe(newSize + 1);                                 // no replacement (the busy one exits later)
      await slow.done();
      await vi.waitFor(() => expect(liveWorkers()).toBe(newSize), WAIT);
      expect(loads()).toHaveLength(2 + newSize);                               // only the old pool's two warm-up loads
    },
    SLOW,
  );

});

it("sends the data's fingerprint to the workers; one whose folder changed fails with the data-changed code, and the new data plans again", async () => {
  const { solver, server, dataDir, loads } = realSolver();
  const write = (text: string) => {
    fs.mkdirSync(path.join(dataDir, 'rom'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'rom/romdata.json'), text);
  };
  write('{"extract":1}');
  const fingerprint = fingerprintData(dataDir);
  server.data = { fingerprint } as ServerData;
  expect(await tierOf(solver)).toBe(1);
  await vi.waitFor(() => expect(loads()).toHaveLength(2), WAIT);
  expect(loads().map((l) => [l.dataVersion, l.fingerprint])).toEqual([[1, fingerprint], [1, fingerprint]]);
  write('{"extract":2}');   // an extract rewrote a file
  server.version = 2;       // a new pool loads the folder; the server's data is still the old
  const failed = await solver.solve(request(safe1v1)).then(() => null, (e: unknown) => e as { message?: string; code?: unknown });
  expect([failed?.message, failed?.code]).toEqual([DATA_CHANGED_MESSAGE, DATA_CHANGED]);   // the code crosses the thread boundary
  server.version = 3;
  server.data = { fingerprint: fingerprintData(dataDir) } as ServerData;
  expect(await tierOf(solver)).toBe(1);
}, SLOW);

describe('the thread count from a getter', () => {
  it("a solve's pool has the getter's count, read when the pool is made: the same count keeps it, another makes a fresh one", async () => {
    let threads = 3;
    const { solver, loads } = realSolver(safe1v1, () => threads);
    expect([await tierOf(solver), liveWorkers()]).toEqual([1, 3]);
    await vi.waitFor(() => expect(loads()).toHaveLength(3), WAIT);   // every worker warmed, each once
    solver.warm();
    expect(await tierOf(solver)).toBe(1);
    expect([loads().length, liveWorkers()]).toEqual([3, 3]);        // no new pool
    threads = 2;                                                     // the next solve makes a fresh pool
    expect(await tierOf(solver)).toBe(1);
    await vi.waitFor(() => expect(loads()).toHaveLength(5), WAIT);
    await vi.waitFor(() => expect(liveWorkers()).toBe(2), WAIT);
    const before = new Set(loads().map((l) => l.thread));
    threads = 3;                                                     // so does the next warm(), closing the idle old pool
    solver.warm();
    await vi.waitFor(() => expect(loads()).toHaveLength(8), WAIT);
    expect(loads().slice(5).filter((l) => before.has(l.thread))).toEqual([]);
    await vi.waitFor(() => expect(liveWorkers()).toBe(3), WAIT);
    expect(await tierOf(solver)).toBe(1);
    expect([loads().length, liveWorkers()]).toEqual([8, 3]);        // the solve ran on the new pool
  }, SLOW);

  it.each([1, 2.5])('a getter that gives %s threads is a RangeError when it is read', async (bad) => {
    const { solver } = realSolver(safe1v1, () => bad);
    await expect(solver.solve(request(safe1v1))).rejects.toThrow(RangeError);
    expect(() => solver.warm()).toThrow(RangeError);
  });
});

describe('the engine mode', () => {
  /** A real solver whose engine mode is `engine`, every thread running the toy through the selector over the stub native engine. */
  const engineSolver = (engine: () => EngineMode, nativeAvailable: () => boolean = () => true) =>
    realSolver(safe1v1, 2, { engine, nativeAvailable, threadDeps: (_data, _dir, mons, choice) => toyDepsFor(mons, choice) });
  const total = (s: EngineSteps): number => s.native + s.fallback + s.showdown;
  const runOf = (solver: RealSolver, verdict: Verdict) => {
    const run = solver.engineRun(verdict);
    if (run === undefined) throw new Error('the solver has no engine run for this verdict');
    return run;
  };
  const threadsIn = (lines: { thread: number }[]): number => new Set(lines.map((l) => l.thread)).size;
  const modes = (lines: { engine: string }[]) => lines.map((e) => e.engine);

  it('every thread of a solve runs the mode read at its start; each verdict has its own run, another verdict none', async () => {
    const { solver, engines } = engineSolver(() => 'native');
    const first = await solver.solve(request(safe1v1));
    expect(first.tier).toBe(1);
    await vi.waitFor(() => expect(threadsIn(engines())).toBe(2), WAIT);
    expect(new Set(modes(engines()))).toEqual(new Set(['native']));
    const a = runOf(solver, first);
    expect(a).toMatchObject({ requested: 'native', mode: 'native', note: null, id: expect.stringMatching(/^native-stub@1\+/) });
    expect([a.steps.native > 0, a.steps.fallback, a.steps.showdown]).toEqual([true, 0, 0]);
    const b = runOf(solver, await solver.solve(request(safe1v1)));
    expect(b).not.toBe(a);
    expect(b.steps).toEqual(a.steps);   // the same search: the second run counts its own steps only
    expect(solver.engineRun({} as Verdict)).toBeUndefined();
  }, SLOW);

  it("the workers' steps land in the solver's cells: the buffer crosses the thread boundary", async () => {
    // This thread's deps count nothing here, so every step counted is a worker's.
    const { solver } = realSolver(safe1v1, 2, {
      engine: () => 'native', nativeAvailable: () => true, threadDeps: (_data, _dir, mons, choice) => toyDepsFor(mons, { mode: choice.mode }),
    });
    const verdict = await solver.solve(request(safe1v1));
    expect([verdict.tier, runOf(solver, verdict).steps.native > 0]).toEqual([1, true]);
  }, SLOW);

  it("a mode change mid-solve leaves that solve alone and reaches the next solve's workers on the same pool", async () => {
    let mode: EngineMode = 'showdown';
    const { solver, loads, engines } = engineSolver(() => mode);
    const first = await solver.solve(request(safe1v1), () => {
      mode = 'auto';
    });
    expect(mode).toBe('auto');
    await vi.waitFor(() => expect([loads().length, engines().length]).toEqual([2, 3]), WAIT);   // two warm-ups, the job's build
    expect(modes(engines())).toEqual(['showdown', 'showdown', 'showdown']);
    const a = runOf(solver, first);
    expect(a).toMatchObject({ requested: 'showdown', mode: 'showdown', note: null });
    expect(a.steps).toEqual({ native: 0, fallback: 0, showdown: total(a.steps), remembered: 0 });   // the toy deps have no store
    expect(a.steps.showdown).toBeGreaterThan(0);
    const second = await solver.solve(request(safe1v1));
    expect([first.tier, second.tier, loads().length, liveWorkers()]).toEqual([1, 1, 2, 2]);       // the same workers
    const later = engines().slice(3);
    expect([later.length > 0, later.every((e) => e.engine === 'auto')]).toEqual([true, true]);
    expect(runOf(solver, second)).toMatchObject({ requested: 'auto', mode: 'auto', note: null });
    expect(runOf(solver, second).steps.native).toBeGreaterThan(0);
  }, SLOW);

  it('without a native engine, auto and native run as showdown and say so', async () => {
    let mode: EngineMode = 'auto';
    const { solver, engines } = engineSolver(() => mode, () => false);
    const auto = await solver.solve(request(safe1v1));
    mode = 'native';
    const native = await solver.solve(request(safe1v1));
    for (const [requested, verdict] of [['auto', auto], ['native', native]] as const) {
      const run = runOf(solver, verdict);
      expect(run).toMatchObject({ requested, mode: 'showdown', note: NATIVE_MISSING_NOTE });
      expect([verdict.tier, run.steps.native, run.steps.fallback, run.steps.showdown > 0]).toEqual([1, 0, 0, true]);
    }
    await vi.waitFor(() => expect(threadsIn(engines())).toBe(2), WAIT);
    expect(new Set(modes(engines()))).toEqual(new Set(['showdown']));
  }, SLOW);

  it('the verdict is the same in every mode', async () => {
    let mode: EngineMode = 'showdown';
    const { solver, server } = engineSolver(() => mode);
    for (const [scenario, tier] of [[safe1v1, 1], [critOnlyBudget1, 2]] as const) {
      server.box = boxOf(scenario);
      for (const each of ['showdown', 'auto', 'native'] as const) {
        mode = each;
        const verdict = await solver.solve(request(scenario));
        expect([verdict.tier, runOf(solver, verdict).mode], `${scenario.name} under ${each}`).toEqual([tier, each]);
      }
    }
  }, SLOW);

  it('a context key names the mode', async () => {
    let mode: EngineMode = 'showdown';
    const { solver, server, engines } = engineSolver(() => mode);
    // An empty box: a solve's key then differs from the warm-up's only by the mode, and every worker holds the warm-up's deps.
    server.box = { byRef: new Map() } as unknown as BoxState;
    solver.warm();
    await vi.waitFor(() => expect(engines()).toHaveLength(2), WAIT);
    expect([await tierOf(solver), await tierOf(solver)]).toEqual([1, 1]);
    expect(engines()).toHaveLength(2);   // the same mode: the warm-up's key, built by no worker again
    mode = 'auto';
    expect(await tierOf(solver)).toBe(1);
    const builds = engines();
    expect(modes(builds)).toEqual(['showdown', 'showdown', 'auto']);
    expect(modes(builds.filter((e) => e.thread === builds[2]!.thread))).toEqual(['showdown', 'auto']);   // two builds in one worker
  }, SLOW);
});
