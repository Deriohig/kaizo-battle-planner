// The solver's own types: game parameters, failure reasons, the battle resolver, oracles, labels, configuration and
// dependencies. The binding cross-stream types live in src/contracts.

import type { EnemyModel } from '../contracts/ai.js';
import type { Choice, Engine, EngineState, Outcome, Rational } from '../contracts/engine.js';
import type { MonRef } from '../contracts/solver.js';
import type { BattleResolver, FightInfo, PlanLabeler } from '../integration/fight.js';
import type { WorkerContext } from './parallel/pool.js';
import type { SolverPool } from './parallel/solverPool.js';

export type { BattleResolver, FightInfo, MonInfo, PlanLabeler } from '../integration/fight.js';
export type { WorkerContext } from './parallel/pool.js';
export type { SolverPool, SolverPoolOptions } from './parallel/solverPool.js';

/** 1 = AND over the AI's support; 2 = AND over every legal enemy action. */
export type Level = 1 | 2;

export type ObservationMode = 'display' | 'ram';

/** `entry` = before a fight, the player picks the lead. */
export type DecisionPhase = 'entry' | 'turnChoice' | 'playerMidTurnSwitch';

/** The metric must be > value when strict, >= value otherwise. */
export interface Bound<T> { value: T; strict: boolean }

export interface Thresholds { minHpFrac?: Bound<Rational>; totalHp?: Bound<number>; pp?: Bound<number> }

/** `critBudget` null = the tier-1 game; j = game G_j. */
export interface GameParams { level: Level; critBudget: number | null; thresholds: Thresholds | null }

export interface FailReasons { death: boolean; unmodelled: boolean; engineLimit: boolean; horizon: boolean; repetition: boolean; threshold: boolean }

/**
 * `shouldStop`: the checker's deadline and signal as one poll. An oracle that runs an engine step of its own
 * hands it to expandTurn and lets an engine STOPPED through (never caching that step); the checker then cuts the check
 * short. Never part of any key.
 */
export interface StepContext { before: EngineState; choices: { p1?: Choice; p2?: Choice }; outcome: Outcome; shouldStop?: () => boolean }

/**
 * `skipped` (the damage oracle only): move display name → this step's damaging hits of that move the oracle
 * did not compare, whatever the reason (the calc gives no result, is unbounded or an OHKO move; a multi-hit move; False
 * Swipe; a hit a Substitute takes; any other hit it passes over). Absent when none; a skipped hit is never counted in
 * `checks`.
 */
export interface OracleResult { checks: number; mismatches: string[]; skipped?: Record<string, number> }

/** Later: damage() / gen4Damage over the step's damage lines. */
export interface DamageOracle { readonly id: string; check(step: StepContext): OracleResult }

/** Later: the speed code over the step's move order. */
export interface SpeedOracle { readonly id: string; check(step: StepContext): OracleResult }

/** Likely-safe first; must return a permutation of `choices`. */
export type OrderHint = (state: EngineState, choices: Choice[]) => Choice[];

export interface SolverConfig {
  observationMode: ObservationMode;   // default 'display'
  checkerBudgetFactor: number;        // default 1: the checker may use up to budgetMs × factor after the search
  planNodeLimit: number;              // default 20_000
  killerLimit: number;                // default 20
  edgeCacheEntries: number;           // default 50_000
  progressIntervalMs: number;         // default 250
  threads: number;                    // default os.availableParallelism(); 1 = in-process
  depsModule: string | null;          // module whose `createDeps(context?): SolverDeps | Promise<SolverDeps>` builds deps inside a worker (context: the solve's workerContext value); null = in-process only
  workerExecArgv: string[];           // default ['--import', 'tsx']
  probeHiddenInformation: boolean;    // default true
  maxLeaves: number | undefined;      // passed to Engine.expandTurn; default undefined (the engine's own limit)
  maxWorlds: number;                  // default 64: a fight with more candidate worlds is unsupportedBattle (decision solver-018)
  maxTeamCandidates: number;          // default 20_000: up to this many candidate teams are listed and sorted by teamScore; more are enumerated lazily (team.ts)
  modelVerifiedInGame: boolean;       // default false → modelNote "model not yet verified in game"
  checkerBareEngine: boolean;         // default false: the checker replays on deps.bare (the engine, AI and oracles without the result store), when the deps have it; on in the checker's own tests and one bench run per milestone
  checkerCompare: boolean;            // default false, tests and the bench only: the checker replays each line on the deps' own and on deps.bare, and any difference is a verificationMismatch ('store and bare checks differ: …')
  // The result store's byte bound is no field here: deps (and their store) are built before a solve's config reaches them,
  // so it is solverDeps' own option (integration/deps.ts; default store.ts DEFAULT_RESULT_STORE_BYTES).
}

export interface SolverDeps {
  engine: Engine; enemyModel: EnemyModel; resolver: BattleResolver;
  oracles: { damage: DamageOracle; speed: SpeedOracle };
  labeler?: PlanLabeler; orderHint?: OrderHint;
  teamScore?: (team: MonRef[], fights: FightInfo[]) => number;   // higher = more promising
  now?: () => number;                                            // default performance.now
  config?: Partial<SolverConfig>;
  // A pool that outlives the solve (createSolverPool): with threads > 1 the solve's jobs run on it, at most
  // min(threads, pool.size) at once, and the solver never closes it; config.depsModule is then not used (the pool has
  // its own). Absent: a pool per solve when threads > 1 and a depsModule, closed when the solve ends.
  pool?: SolverPool;
  // The solve's payload for its workers' deps module, sent with every job: a worker calls createDeps(value) once per
  // distinct key (structured-cloneable; docs/solver-integration.md section 8). Absent: createDeps() with no argument.
  workerContext?: WorkerContext;
  // The unwrapped deps when `engine` and `enemyModel` are a result store over them (store.ts; integration/deps.ts
  // solverDeps), with `oracles` over the unwrapped engine: what config checkerBareEngine and checkerCompare hand the checker.
  bare?: { engine: Engine; enemyModel: EnemyModel; oracles: SolverDeps['oracles'] };
}

export const NO_REASONS: FailReasons = Object.freeze({
  death: false, unmodelled: false, engineLimit: false, horizon: false, repetition: false, threshold: false,
});

export function mergeReasons(a: FailReasons, b: FailReasons): FailReasons {
  return {
    death: a.death || b.death,
    unmodelled: a.unmodelled || b.unmodelled,
    engineLimit: a.engineLimit || b.engineLimit,
    horizon: a.horizon || b.horizon,
    repetition: a.repetition || b.repetition,
    threshold: a.threshold || b.threshold,
  };
}
