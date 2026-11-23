// The solver's deps over the real engine, AI and data (docs/solver-integration.md sections 1–8), built the same way on
// the server's thread and in every worker thread. This file holds the solver's side; the fingerprint-checked reads of
// the data folder (the base deps) live in baseDeps.ts, which this file re-exports.
//
// Each solve sends what it fights with, the data folder, the data version, the data's content fingerprint and the box's
// eligible Pokémon, with the engine to step (the mode and the step counters, `EngineChoice` below), to
// its workers as the solve's worker context (realSolver.ts; workerDeps.ts builds from it). So every
// worker builds its resolver from exactly the Pokémon the server's thread used, even when the save changes mid-solve,
// and nothing is shared through process-wide state such as the environment. An extract can rewrite the folder at any
// time, so every read of it here is checked against the fingerprint of the data the server loaded (fingerprint.ts):
// a thread never builds on other bytes than the server's.

import { availableParallelism } from 'node:os';
import type { PlayerMon } from '../battle/playerMon.js';
import type { ResolvedTrainer, TrainerCatalog } from '../battle/types.js';
import type { Engine } from '../contracts/engine.js';
import type { MonRef } from '../contracts/solver.js';
import type { LocalData } from '../data/load.js';
import { showdownEngine } from '../engine/index.js';
import { REMEMBERED, type StepCounters, stepCounters } from '../engines/counters.js';
import { nativeFor } from '../engines/native.js';
import { DEFAULT_ENGINE_MODE, type EngineKit, type EngineMode, type NativeProvider, referenceModel, selectEngine } from '../engines/select.js';
import type { SolverDeps } from '../solver/index.js';
import { createResultStore, DEFAULT_RESULT_STORE_BYTES, type StoreStats } from '../solver/store.js';
import type { BaseDeps } from './baseDeps.js';
import { createOrderHint, createTeamScore } from './hints.js';
import { createLabeler } from './labeler.js';
import { createOracles } from './oracles.js';
import { createResolver } from './resolver.js';

export { type BaseDeps, baseDeps, loadBaseDeps, readBaseDeps } from './baseDeps.js';

/** The most worker threads a solve starts by default: the player plays DeSmuME on the same 6-core machine, and each worker loads the whole data set (about 250 MB). */
const MAX_DEFAULT_THREADS = 4;

/**
 * The worker threads a solve may use by default: all cores but two, which DeSmuME keeps, at most 4, and never fewer
 * than 2, so the calling thread stays free for a cancel (the split bench's `--threads <n>` overrides it).
 */
export function defaultThreads(cores: number = availableParallelism()): number {
  return Math.max(2, Math.min(MAX_DEFAULT_THREADS, cores - 2));
}

/** `--threads`'s value as a thread count: a whole number from 2 up to the core count (2 on a one-core machine), else null. */
export function threadsArg(raw: string, cores: number = availableParallelism()): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const threads = Number(raw);
  return threads >= 2 && threads <= Math.max(2, cores) ? threads : null;
}

/** Every resolved trainer copy by ROM index (the catalog's opponents and their variants, and partners found by ID). */
function trainersByRom(catalog: TrainerCatalog): (romIndex: number) => ResolvedTrainer | undefined {
  let byRom: Map<number, ResolvedTrainer> | null = null;
  return (romIndex) => {
    if (byRom === null) {
      byRom = new Map();
      for (const trainer of catalog.trainers) {
        for (const copy of [trainer, ...trainer.variants]) if (!byRom.has(copy.romIndex)) byRom.set(copy.romIndex, copy);
      }
    }
    return byRom.get(romIndex);
  };
}

/**
 * The battle engine a solve's deps step (src/engines/select.ts): `mode`, already resolved on the
 * server's thread (`resolveMode`); `counters`, the real solver's step counters (absent: nothing is counted); and
 * `native`, the native engine itself, for the tests (absent: this thread's, `nativeFor`, for mode auto or native).
 */
export interface EngineChoice { mode: EngineMode; counters?: SharedArrayBuffer; native?: NativeProvider | null }

/**
 * This thread's kits, by data and then mode: the one that counts nothing, and one per counters buffer (kept as long as
 * the buffer object is: a worker gets its own copy of the real solver's buffer with each context it builds).
 */
const kits = new WeakMap<LocalData, Map<EngineMode, { plain?: EngineKit; counted: WeakMap<SharedArrayBuffer, EngineKit> }>>();

/**
 * This thread's engine kit for `base` and `choice` (default: `DEFAULT_ENGINE_MODE`, nothing counted): the selector over
 * `showdownEngine` and, for mode auto or native, this thread's native engine (`nativeFor`; mode showdown never asks for
 * one). Kept per (base.data, mode, counters buffer), since `baseDeps` returns a new object each call, so a thread makes
 * one native engine and one forecast cache per data and mode; a `choice.native` (the tests') is used as given and not
 * kept. Throws NativeUnavailableError for mode auto or native without a native engine (a mode not resolved with
 * resolveMode), and keeps nothing.
 */
export function engineKit(base: BaseDeps, choice: EngineChoice = { mode: DEFAULT_ENGINE_MODE }): EngineKit {
  const { mode, counters } = choice;
  const make = (native: NativeProvider | null): EngineKit =>
    selectEngine({ mode, reference: showdownEngine, native, ...(counters === undefined ? {} : { counters: stepCounters(counters) }) });
  if (choice.native !== undefined) return make(choice.native);
  let byMode = kits.get(base.data);
  if (byMode === undefined) {
    byMode = new Map();
    kits.set(base.data, byMode);
  }
  let kept = byMode.get(mode);
  if (kept === undefined) {
    kept = { counted: new WeakMap() };
    byMode.set(mode, kept);
  }
  const known = counters === undefined ? kept.plain : kept.counted.get(counters);
  if (known !== undefined) return known;
  const kit = make(mode === 'showdown' ? null : nativeFor({ reference: showdownEngine, data: base.data, moves: base.moves }));
  if (counters === undefined) kept.plain = kit;
  else kept.counted.set(counters, kit);
  return kit;
}

/**
 * `store`'s engine with each expandTurn the store answered without running the kit's engine (a store hit) added to the
 * `remembered` cell. A call that reaches the kit's engine is counted there, as an engine run, and never here, even when
 * it throws. Every other call passes straight through. The hit is read off the store's own stats around the call: an
 * expandTurn on the store makes no other store call, so its hits move by one exactly when it answered from the store.
 */
function countRemembered(store: { engine: Engine; stats(): StoreStats }, cells: StepCounters): Engine {
  const { engine } = store;
  const { hpOf } = engine;
  return {
    get id(): string {
      return engine.id;
    },
    createBattle: (...args) => engine.createBattle(...args),
    legalChoices: (...args) => engine.legalChoices(...args),
    expandTurn: (...args) => {
      const hits = store.stats().hits;
      const outcomes = engine.expandTurn(...args);
      if (store.stats().hits > hits) cells.add(REMEMBERED, 1);
      return outcomes;
    },
    observe: (...args) => engine.observe(...args),
    carryOut: (...args) => engine.carryOut(...args),
    unmodelledIn: (...args) => engine.unmodelledIn(...args),
    ...(hpOf === undefined ? {} : { hpOf: (...args: Parameters<typeof hpOf>) => hpOf.apply(engine, args) }),
  };
}

/**
 * The solver's deps for one solve over `base` and the box's eligible Pokémon `mons` (docs/solver-integration.md): the
 * engine (this thread's engine kit's for `choice`; with no choice, `showdownEngine`) and the trainer AI
 * (read through the kit's `reference` when the kit can hold native states; else the base's own model) behind one result
 * store of their answers (src/solver/store.ts, bounded at `storeBytes`), the resolver, the damage and speed oracles
 * over the store's engine, the labeler, the order hint and the team score, and as `bare` the kit's engine, the same AI
 * and oracles over the kit's engine without the store (config checkerBareEngine and checkerCompare hand them to the
 * checker). Every thread builds the same from the same data, Pokémon and choice. The oracles, the order hint and the
 * labeler read states through the kit's `reference`, so a native state reaches them as a reference state.
 * With `choice.counters`, two kinds of expandTurn call are counted, apart: the kit counts engine runs (the steps that
 * reach the kit: the search's and checker's store misses, the oracles' expansions that miss, and every step of the
 * bare checker's replays), and the store's front counts as `remembered` each call the store answered without running
 * an engine (`countRemembered`; the search, the checker and the oracles all step through that front). The front is a
 * thin wrapper over the store's engine, so `resultStoreStats(deps.engine)` is null for counted deps (the solver never
 * asks; scripts/profileSolve.ts builds its deps without counters). Without counters the engine is the store's own.
 * The store lives as long as the deps: a worker keeps the deps of its most recent contexts (data version, engine mode
 * and box hash), the server's thread one per solve, so a repeat plan of the same fight finds much of its work
 * remembered.
 * `storeBytes` is the store's byte bound (default DEFAULT_RESULT_STORE_BYTES, 256 MiB). Only this option sets it: a
 * solve's config cannot, since the deps and their store are built before any solve's config reaches them.
 */
export function solverDeps(
  base: BaseDeps, mons: ReadonlyMap<MonRef, PlayerMon>, choice?: EngineChoice, storeBytes: number = DEFAULT_RESULT_STORE_BYTES,
): SolverDeps {
  const kit = engineKit(base, choice ?? { mode: DEFAULT_ENGINE_MODE });
  const enemyModel = kit.usesNative ? referenceModel(base.enemyModel, kit.reference) : base.enemyModel;
  const player = [...mons.values()];
  const context = { data: base.data, moves: base.moves, player, trainer: trainersByRom(base.catalog), reference: kit.reference };
  const store = createResultStore(kit.engine, enemyModel, { maxBytes: storeBytes });
  const engine = choice?.counters === undefined ? store.engine : countRemembered(store, stepCounters(choice.counters));
  return {
    engine,
    enemyModel: store.ai,
    resolver: createResolver({ data: base.data, catalog: base.catalog, moves: base.moves, mons }),
    oracles: createOracles({ ...context, engine }),
    labeler: createLabeler({ moves: base.moves, mons, reference: kit.reference }),
    orderHint: createOrderHint(context),
    teamScore: createTeamScore(mons, base.moves),
    bare: { engine: kit.engine, enemyModel, oracles: createOracles({ ...context, engine: kit.engine }) },
  };
}
