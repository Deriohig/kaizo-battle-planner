// Solver defaults: the ranking order, search budgets per fight kind, the horizon and the runtime configuration.

import { availableParallelism } from 'node:os';
import type { RankKey } from '../contracts/solver.js';
import type { SolverConfig } from './types.js';

/** The contract's default order (src/contracts/solver.ts RankKey). */
export const DEFAULT_RANKING: readonly RankKey[] = Object.freeze([
  'critBudget', 'critDeathProbability', 'worstMinHp', 'totalHp', 'pp', 'chanceDependencies', 'turns',
] as const);

export const DEFAULT_BUDGETS_MS = Object.freeze({ route: 30_000, gym: 300_000, deep: 3_600_000, gauntlet: 900_000 } as const);

export const DEFAULT_HORIZON_TURNS = 25;

export const DEFAULT_CONFIG: SolverConfig = Object.freeze<SolverConfig>({
  observationMode: 'display',
  checkerBudgetFactor: 1,
  planNodeLimit: 20_000,
  killerLimit: 20,
  edgeCacheEntries: 50_000,
  progressIntervalMs: 250,
  threads: availableParallelism(),
  depsModule: null,
  workerExecArgv: ['--import', 'tsx'],
  probeHiddenInformation: true,
  maxLeaves: undefined,
  maxWorlds: 64,
  maxTeamCandidates: 20_000,
  modelVerifiedInGame: false,
  checkerBareEngine: false,
  checkerCompare: false,
});

/**
 * Fills every missing (or undefined) field from DEFAULT_CONFIG. Throws RangeError for threads that is not an integer of
 * at least 1, planNodeLimit < 1, checkerBudgetFactor < 0, maxWorlds < 1, or a maxTeamCandidates that is not a
 * non-negative integer.
 */
export function resolveConfig(partial: Partial<SolverConfig> = {}): SolverConfig {
  const given = Object.fromEntries(Object.entries(partial).filter(([, value]) => value !== undefined)) as Partial<SolverConfig>;
  const config: SolverConfig = { ...DEFAULT_CONFIG, workerExecArgv: [...DEFAULT_CONFIG.workerExecArgv], ...given };
  if (!(Number.isInteger(config.threads) && config.threads >= 1)) throw new RangeError(`solver threads must be an integer of at least 1, got ${config.threads}`);
  if (!(config.planNodeLimit >= 1)) throw new RangeError(`solver planNodeLimit must be at least 1, got ${config.planNodeLimit}`);
  if (!(config.checkerBudgetFactor >= 0)) throw new RangeError(`solver checkerBudgetFactor must be at least 0, got ${config.checkerBudgetFactor}`);
  if (!(config.maxWorlds >= 1)) throw new RangeError(`solver maxWorlds must be at least 1, got ${config.maxWorlds}`);
  if (!(Number.isInteger(config.maxTeamCandidates) && config.maxTeamCandidates >= 0)) {
    throw new RangeError(`solver maxTeamCandidates must be a non-negative integer, got ${config.maxTeamCandidates}`);
  }
  return config;
}
