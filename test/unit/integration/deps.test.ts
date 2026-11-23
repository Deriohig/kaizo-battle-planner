import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { TrainerCatalog } from '../../../src/battle/types.js';
import type { EnemyModel } from '../../../src/contracts/ai.js';
import type { Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import type { MonRef } from '../../../src/contracts/solver.js';
import { MissingDataError } from '../../../src/data/load.js';
import { newCounters, stepCounters } from '../../../src/engines/counters.js';
import { NativeUnavailableError, type NativeProvider } from '../../../src/engines/select.js';
import { createBattle, installKaizoDex, showdownEngine } from '../../../src/engine/index.js';
import { contextDeps, type WorkerDepsContext } from '../../../src/integration/contextDeps.js';
import { baseDeps, type BaseDeps, defaultThreads, engineKit, solverDeps, threadsArg } from '../../../src/integration/deps.js';
import { DATA_CHANGED, DataChangedError, dataFiles, fingerprintData, readStable } from '../../../src/integration/fingerprint.js';
import { createDeps as workerCreateDeps } from '../../../src/integration/workerDeps.js';
import type { SolverDeps } from '../../../src/solver/index.js';
import { resultStoreStats } from '../../../src/solver/store.js';
import { emberTurn, fixtureDex, ID, playerMon } from '../engine/fixtures.js';
import { isStubNative, stubNative } from '../engines/stubNative.js';

// This build's native engine as a test sets it: null, or a stub provider; `asked` counts nativeFor's calls.
const nativeBuild = vi.hoisted(() => ({ provider: null as NativeProvider | null, asked: 0 }));
vi.mock('../../../src/engines/native.js', () => ({
  nativeAvailable: () => nativeBuild.provider !== null,
  nativeFor: () => {
    nativeBuild.asked += 1;
    return nativeBuild.provider;
  },
}));

// workerDeps.ts's loader gives `workerBase.base` while a test sets it, else it is the real loader.
const workerBase = vi.hoisted(() => ({ base: null as BaseDeps | null }));
vi.mock('../../../src/integration/deps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/integration/deps.js')>();
  return { ...actual, readBaseDeps: (dataDir: string, expected?: string | null) => workerBase.base ?? actual.readBaseDeps(dataDir, expected) };
});

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const MOVE_0: Choice = { kind: 'move', slot: 0 };
const BOTH_FIRST = { p1: MOVE_0, p2: MOVE_0 };
const input = emberTurn();
const catalogOf = (trainers: unknown[]) => ({ trainers }) as unknown as TrainerCatalog;
const base = (over: Partial<BaseDeps> = {}): BaseDeps => ({ data: fixture.data, catalog: catalogOf([]), moves: fixture.moves, enemyModel: {} as EnemyModel, ...over });
const fightBase = (over: Partial<BaseDeps> = {}) => base({ catalog: catalogOf([input.trainer]), ...over });
const mons = new Map<MonRef, PlayerMon>([['party:0', input.player[0]!]]);
const steps = (native: number, showdown: number, remembered: number) => ({ native, fallback: 0, showdown, remembered });
const context = (over: Partial<WorkerDepsContext> = {}): WorkerDepsContext => ({ dataDir: '/data', dataVersion: 1, fingerprint: null, mons: [], ...over });
const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  nativeBuild.provider = null;
  nativeBuild.asked = 0;
  workerBase.base = null;
});

function write(dir: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}
/** The AI's data as `loadAiData` reads it, its script hash `sha` (the model's id shows its first 12). */
const aiJson = (sha: string) => JSON.stringify({ scriptWords: [], flagEntries: [], scriptSha256: sha, items: [], typeChart: [], weights: [], formWeights: [] });
/** A temp data folder with a small file at each of `dataFiles()`'s paths, and AI data whose script hash is all `a`s. */
function dataFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-fingerprint-'));
  dirs.push(dir);
  for (const { file } of dataFiles()) write(dir, file, `${file}\n`);
  write(dir, 'rom/trainer-ai.json', aiJson('a'.repeat(64)));
  return dir;
}

describe('solverDeps', () => {
  it("is the engine itself behind its store, modelling a fight's field note (Roark's sand), with the base's own AI", () => {
    const enemyModel = {} as EnemyModel;
    const { engine, bare } = solverDeps(base({ enemyModel }), new Map());
    expect(bare?.engine).toBe(showdownEngine);
    expect(bare?.enemyModel).toBe(enemyModel);
    expect(engine.id).toBe(showdownEngine.id);
    expect(engine.unmodelledIn(createBattle({ ...input, field: { weather: 'sand' } }))).toEqual([]);
    expect(engine.unmodelledIn(createBattle(input))).toEqual([]);
  });

  it('keeps one store of answers per deps object, which the oracles read too, and the engine without it as bare', () => {
    const d = solverDeps(fightBase(), mons);
    expect(d.engine).not.toBe(showdownEngine);
    expect(d.bare?.enemyModel).toBeDefined();
    expect(d.bare?.oracles).not.toBe(d.oracles);
    const state = d.engine.createBattle(input);
    const choices = { p1: d.engine.legalChoices(state, 'p1')[0]!, p2: d.engine.legalChoices(state, 'p2')[0]! };
    const outcomes = d.engine.expandTurn(state, choices);
    expect(d.engine.expandTurn(state, choices)).toBe(outcomes);   // the store's answer
    const asked = resultStoreStats(d.engine)!;
    expect(asked.hits).toBe(1);
    const after = { hits: asked.hits + 1, misses: asked.misses };
    d.oracles.damage.check({ before: state, choices, outcome: outcomes[0]! });        // through the store: a hit
    expect(resultStoreStats(d.engine)).toMatchObject(after);
    d.bare!.oracles.damage.check({ before: state, choices, outcome: outcomes[0]! });  // the bare oracles run the engine themselves
    expect(resultStoreStats(d.engine)).toMatchObject(after);
    expect(resultStoreStats(solverDeps(base(), new Map()).engine)).toEqual({ hits: 0, misses: 0, bytes: 0, evictions: 0 });
  });

  it("with counters, counts the engine's steps and the ones the store remembered, and gives the engine's results", () => {
    const counters = newCounters();
    const made = () => solverDeps(fightBase(), mons, { mode: 'showdown', counters });
    const deps = made();
    const start = createBattle(input);
    const read = () => stepCounters(counters).read();
    const reference = showdownEngine.expandTurn(start, BOTH_FIRST);   // not through the deps: nothing counted
    const check = (d: SolverDeps) => reference.reduce((sum, outcome) => sum + d.oracles.damage.check({ before: start, choices: BOTH_FIRST, outcome }).checks, 0);
    expect(check(deps)).toBeGreaterThan(0);                             // the oracle's own expansion: an engine run
    expect(read()).toEqual(steps(0, 1, 0));
    expect(deps.engine.expandTurn(start, BOTH_FIRST)).toEqual(reference);   // the store's answer: remembered
    expect(read()).toEqual(steps(0, 1, 1));
    const other = made();                                                // another deps object has its own store
    other.engine.expandTurn(start, BOTH_FIRST);
    expect(read()).toEqual(steps(0, 2, 1));
    expect(check(other)).toBeGreaterThan(0);
    expect(read()).toEqual(steps(0, 2, 2));
    // A step that reaches the engine is never remembered, even one that throws; other stored calls are not steps.
    expect(() => deps.engine.expandTurn(start, { p1: { kind: 'move', slot: 9 }, p2: MOVE_0 })).toThrow();
    deps.engine.legalChoices(start, 'p1');
    deps.engine.legalChoices(start, 'p1');
    expect(read()).toEqual(steps(0, 3, 2));
    expect(deps.bare!.engine.expandTurn(start, BOTH_FIRST)).toEqual(reference);   // bare: counted, never remembered
    expect(read()).toEqual(steps(0, 4, 2));
    expect([deps.engine.id, deps.bare!.engine.id]).toEqual([showdownEngine.id, showdownEngine.id]);
  });

  it('with a native provider, the oracles, the order hint, the labeler and the AI read reference states', () => {
    const model = {} as EnemyModel;
    const deps = solverDeps(fightBase({ enemyModel: model }), mons, { mode: 'native', native: stubNative(showdownEngine).provider });
    const start = deps.engine.createBattle(input);
    expect([isStubNative(start), start.phase.kind]).toEqual([true, 'turnChoice']);
    const reference = createBattle(input);
    const choices = showdownEngine.legalChoices(reference, 'p1');
    expect(deps.orderHint!(start, choices)).toEqual(deps.orderHint!(reference, choices));
    // Asked twice of the native state: the second answer comes from the labeler's cache.
    expect([start, start, reference].map((s) => deps.labeler!.choice(s, 'p1', MOVE_0))).toEqual(['Use Ember', 'Use Ember', 'Use Ember']);
    const checked = (before: EngineState, outcomes: Outcome[]) => outcomes.map((outcome) => ({
      damage: deps.oracles.damage.check({ before, choices: BOTH_FIRST, outcome }),
      speed: deps.oracles.speed.check({ before, choices: BOTH_FIRST, outcome }),
    }));
    const onNative = checked(start, deps.engine.expandTurn(start, BOTH_FIRST));
    expect(onNative).toEqual(checked(reference, showdownEngine.expandTurn(reference, BOTH_FIRST)));
    expect(onNative.reduce((sum, r) => sum + r.damage.checks, 0)).toBeGreaterThan(0);
    expect(deps.bare!.enemyModel).not.toBe(model);   // the AI reads through the kit too
  });
});

describe('the engine kit', () => {
  it("the production workers' createDeps hands the context's engine mode and counters to the kit", () => {
    workerBase.base = fightBase();
    const start = createBattle(input);
    const counters = newCounters();
    workerCreateDeps(context({ engine: 'showdown', counters })).engine.expandTurn(start, BOTH_FIRST);
    expect(stepCounters(counters).read()).toEqual(steps(0, 1, 0));

    const { provider } = stubNative(showdownEngine);
    nativeBuild.provider = provider;
    const nativeCounters = newCounters();
    const native = workerCreateDeps(context({ engine: 'native', counters: nativeCounters }));
    expect(native.engine.id).toBe(provider.engine.id);
    const nativeStart = native.engine.createBattle(input);
    expect(isStubNative(nativeStart)).toBe(true);
    native.engine.expandTurn(nativeStart, BOTH_FIRST);
    native.engine.expandTurn(nativeStart, BOTH_FIRST);   // the store's answer: remembered, into the same cells
    expect(stepCounters(nativeCounters).read()).toEqual(steps(1, 0, 1));

    // A context without them builds the default: showdown, nothing counted.
    const plain = workerCreateDeps(context());
    expect(plain.bare!.engine).toBe(showdownEngine);
    plain.engine.expandTurn(start, BOTH_FIRST);
    expect([stepCounters(counters).read(), stepCounters(nativeCounters).read()]).toEqual([steps(0, 1, 0), steps(1, 0, 1)]);
  });

  it('is one per data and mode in a thread, and a given provider is not kept', () => {
    const counters = newCounters();
    const kit = engineKit(base(), { mode: 'showdown', counters });
    expect(engineKit(base(), { mode: 'showdown', counters })).toBe(kit);   // another BaseDeps over the same data
    expect(engineKit(base(), { mode: 'showdown', counters: newCounters() })).not.toBe(kit);
    expect(engineKit(base(), { mode: 'showdown' })).not.toBe(kit);
    expect(nativeBuild.asked).toBe(0);                                     // showdown never asks for the native engine
    nativeBuild.provider = stubNative(showdownEngine).provider;
    const native = engineKit(base(), { mode: 'native', counters });
    expect(engineKit(base(), { mode: 'native', counters })).toBe(native);
    const auto = engineKit(base(), { mode: 'auto', counters });
    expect(new Set([kit, native, auto]).size).toBe(3);
    expect([kit.mode, native.mode, auto.mode, nativeBuild.asked]).toEqual(['showdown', 'native', 'auto', 2]);
    const given = stubNative(showdownEngine).provider;
    expect(engineKit(base(), { mode: 'native', counters, native: given })).not.toBe(engineKit(base(), { mode: 'native', counters, native: given }));
  });

  it('without a native engine in this build, mode auto or native throws NativeUnavailableError, and nothing is kept', () => {
    const counters = newCounters();
    for (const mode of ['auto', 'native'] as const) {
      const thrown = thrownBy(() => engineKit(base(), { mode, counters }));
      expect(thrown, mode).toBeInstanceOf(NativeUnavailableError);
      expect((thrown as NativeUnavailableError).code).toBe('NATIVE_UNAVAILABLE');
    }
    nativeBuild.provider = stubNative(showdownEngine).provider;
    expect(engineKit(base(), { mode: 'native', counters }).usesNative).toBe(true);
  });
});

describe("the workers' createDeps(context)", () => {
  const mon = playerMon(ID.monferno, 30, [ID.ember], { nickname: 'Fernando' });

  /** contextDeps over a loader and a builder that record their calls. */
  function recorded() {
    const loads: string[] = [];
    const builds: { base: string; mons: [MonRef, PlayerMon][]; context: WorkerDepsContext }[] = [];
    const createDeps = contextDeps(
      (dataDir, dataVersion, fingerprint) => {
        loads.push(`${dataDir}|${dataVersion}|${fingerprint}`);
        return `base ${loads.length}`;
      },
      (b, ms, c) => {
        builds.push({ base: b, mons: [...ms], context: c });
        return {} as SolverDeps;
      },
    );
    return { loads, builds, createDeps };
  }

  it('loads the base once per data folder, version and fingerprint, keeping only the current one, and builds per context', () => {
    const { loads, builds, createDeps } = recorded();
    const withEngine = context({ engine: 'auto', counters: newCounters() });
    createDeps(withEngine);
    createDeps(context({ mons: [['party:1', mon]] }));
    expect(loads).toEqual(['/data|1|null']);
    expect(builds.map((b) => [b.base, b.mons])).toEqual([['base 1', []], ['base 1', [['party:1', mon]]]]);
    expect(builds[0]!.context).toBe(withEngine);                       // the builder gets the context itself
    createDeps(context({ dataVersion: 2 }));                           // a data change: loaded again, once
    createDeps(context({ dataVersion: 2 }));
    createDeps(context({ dataVersion: 1 }));                           // only the current version is kept
    createDeps(context({ dataVersion: 1, fingerprint: 'f1' }));        // a base is never reused over unchecked bytes
    createDeps(context({ dataVersion: 1, fingerprint: 'f1' }));
    expect(loads).toEqual(['/data|1|null', '/data|2|null', '/data|1|null', '/data|1|f1']);
    expect(builds.map((b) => b.base)).toEqual(['base 1', 'base 1', 'base 2', 'base 2', 'base 3', 'base 4', 'base 4']);
  });

  it('refuses a call without a context, and loads again after a load that failed', () => {
    let fail = true;
    const createDeps = contextDeps(() => {
      if (fail) throw new Error('romdata.json is missing');
      return 'base';
    }, () => ({}) as SolverDeps);
    expect(() => (createDeps as (context?: unknown) => SolverDeps)()).toThrow(/needs the solve's context/);
    expect(() => createDeps(context())).toThrow('romdata.json is missing');
    fail = false;
    expect(createDeps(context())).toEqual({});
  });

  it("refuses a context whose fingerprint is not its folder's, keeping nothing, and loads again for the right one", () => {
    const dir = dataFolder();
    const right = fingerprintData(dir);
    const wrong = '0'.repeat(64);
    const loads: (string | null)[] = [];
    let builds = 0;
    const createDeps = contextDeps((dataDir, _version, fingerprint) => {
      loads.push(fingerprint);
      return readStable(dataDir, fingerprint, () => 'base').value;
    }, () => {
      builds += 1;
      return {} as SolverDeps;
    });
    const refused = thrownBy(() => createDeps(context({ dataDir: dir, fingerprint: wrong })));
    expect(refused).toBeInstanceOf(DataChangedError);
    expect([(refused as DataChangedError).code, builds]).toEqual([DATA_CHANGED, 0]);
    expect(createDeps(context({ dataDir: dir, fingerprint: right }))).toEqual({});
    expect([loads, builds]).toEqual([[wrong, right], 1]);
  });

  it("the production module checks the context's fingerprint before it loads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-worker-'));   // empty: the loader says what is missing
    dirs.push(dir);
    expect(() => workerCreateDeps(context({ dataDir: dir, fingerprint: '0'.repeat(64) }))).toThrow(DataChangedError);
    expect(() => workerCreateDeps(context({ dataDir: dir, fingerprint: fingerprintData(dir) }))).toThrow(MissingDataError);
  });
});

it("baseDeps checks the AI file against the data's fingerprint: a changed folder throws DataChangedError and keeps nothing", () => {
  const dir = dataFolder();
  const data = { local: fixture.data, catalog: catalogOf([]), moves: fixture.moves, fingerprint: fingerprintData(dir) };
  write(dir, 'rom/trainer-ai.json', aiJson('b'.repeat(64)));
  expect(() => baseDeps(data, dir)).toThrow(DataChangedError);
  write(dir, 'rom/trainer-ai.json', aiJson('a'.repeat(64)));   // the bytes the server loaded, back
  expect(baseDeps(data, dir).enemyModel.id).toBe(`pokeplatinum-ai@${'a'.repeat(12)}`);
});

describe('threads', () => {
  it.each([[12, 4], [6, 4], [5, 3], [4, 2], [1, 2]])('defaults to all cores but two, from 2 to 4: %i cores give %i', (cores, threads) => {
    expect(defaultThreads(cores)).toBe(threads);
  });

  it.each<[string, number, number | null]>([
    ['3', 12, 3], ['12', 12, 12], ['2', 1, 2], ['1', 12, null], ['13', 12, null], ['256', 12, null], ['four', 12, null], ['2.5', 12, null],
  ])('takes --threads %s on %i cores as %s', (arg, cores, threads) => {
    expect(threadsArg(arg, cores)).toBe(threads);
  });
});
