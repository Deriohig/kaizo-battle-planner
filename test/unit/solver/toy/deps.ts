// SolverDeps over the toy game, for the solver's tests and its workers. The resolver uses fixtures.ts's mapping:
// MonRef 'party:<i>' = scenario.p1[i]; any trainer of the registry is a fight (see toyFightInfo).

import type { BattleInput, EngineState } from '../../../../src/contracts/engine.js';
import type { FightSpec, MonRef } from '../../../../src/contracts/solver.js';
import { defaultLabeler } from '../../../../src/solver/labeler.js';
import { createResultStore, DEFAULT_RESULT_STORE_BYTES, type StoreOptions } from '../../../../src/solver/store.js';
import type { BattleResolver, FightInfo, MonInfo, SolverDeps } from '../../../../src/solver/types.js';
import { createToyAi } from './ai.js';
import { createToyEngine, readToyState } from './engine.js';
import { toyFightInfo, toyTeam } from './fixtures.js';
import { toyOracles } from './oracles.js';
import * as scenarios from './scenarios.js';
import { ALL_SCENARIOS, type Scenario } from './scenarios.js';

/** The scenario's mons and every trainer in its registry; both methods throw for an unknown id. */
export function toyResolver(s: Scenario): BattleResolver {
  const team = toyTeam(s);
  return {
    mon(ref: MonRef): MonInfo {
      const info = team.find((m) => m.ref === ref);
      if (info === undefined) throw new Error(`toy deps: scenario ${s.name} has no mon ${ref}`);
      return info;
    },
    fight(spec: FightSpec): FightInfo {
      if (s.registry.trainers[spec.trainerId] === undefined) throw new Error(`toy deps: scenario ${s.name} has no trainer ${spec.trainerId}`);
      return { ...toyFightInfo(s, spec.trainerId, spec.healBefore ?? false), spec: { ...spec } };
    },
  };
}

/**
 * `store`: put the engine and AI behind one result store (src/solver/store.ts), as solverDeps does, with the unwrapped
 * ones as `bare`; true = the default byte bound with frozen answers, or store options over those.
 */
export interface ToyDepsOptions { store?: boolean | Partial<StoreOptions> }

/** The toy engine, AI, resolver and oracles for `s`, with defaultLabeler; `overrides` are spread last. */
export function toyDeps(scenario: Scenario, overrides: Partial<SolverDeps> = {}, opts: ToyDepsOptions = {}): SolverDeps {
  const engine = overrides.engine ?? createToyEngine(scenario.registry);
  const enemyModel = overrides.enemyModel ?? createToyAi(scenario.registry);
  const oracles = overrides.oracles ?? toyOracles(scenario.registry);
  const deps: SolverDeps = { engine, enemyModel, resolver: toyResolver(scenario), oracles, labeler: defaultLabeler, ...overrides };
  if (opts.store === undefined || opts.store === false) return deps;
  const store = createResultStore(engine, enemyModel, { maxBytes: DEFAULT_RESULT_STORE_BYTES, freeze: true, ...(opts.store === true ? {} : opts.store) });
  // The toy oracles never call the engine, so the store's deps and the bare ones can share them.
  return { ...deps, engine: store.engine, enemyModel: store.ai, bare: { engine, enemyModel, oracles } };
}

/**
 * `oracles` with a fault on every step whose state before matches `applies`: 'count' adds one damage check, 'skipped'
 * one not-cross-checked Counter hit (each a disagreement in counts only), 'mismatch' one damage-oracle mismatch.
 */
export function skewedOracles(oracles: SolverDeps['oracles'], applies: (state: EngineState) => boolean, kind: 'count' | 'skipped' | 'mismatch'): SolverDeps['oracles'] {
  return {
    ...oracles,
    damage: {
      id: oracles.damage.id,
      check: (step) => {
        const result = oracles.damage.check(step);
        if (!applies(step.before)) return result;
        switch (kind) {
          case 'count': return { ...result, checks: result.checks + 1 };
          case 'skipped': return { ...result, skipped: { ...result.skipped, Counter: (result.skipped?.['Counter'] ?? 0) + 1 } };
          case 'mismatch': return { ...result, mismatches: [...result.mismatches, 'skewed (a planted mismatch)'] };
        }
      },
    },
  };
}

/** Whether the battle of `state` was led by the toy mon `name` (its first p1 mon). */
export const ledBy = (name: string) => (state: EngineState): boolean => readToyState(state).p1Keys[0] === name;

/** Whether a p1 mon of `state` has the toy status `status`. */
export const withStatus = (status: string) => (state: EngineState): boolean => readToyState(state).p1.some((m) => m.status === status);

function isScenario(v: unknown): v is Scenario {
  return typeof v === 'object' && v !== null && 'registry' in v && 'p1' in v && 'trainerId' in v;
}

/** The toy scenario named `name` (in ALL_SCENARIOS or a named export of scenarios.ts); throws for an unknown name. */
export function scenarioNamed(name: string): Scenario {
  const named: unknown = (scenarios as Record<string, unknown>)[name];
  const scenario = ALL_SCENARIOS.find((s) => s.name === name) ?? (isScenario(named) ? named : undefined);
  if (scenario === undefined) throw new Error(`toy deps: no toy scenario named ${name}`);
  return scenario;
}

/**
 * For workers: the deps of the scenario named by SOLVER_TOY_SCENARIO. SOLVER_TOY_BREAK_LEAD=<mon> makes createBattle
 * throw (no code) for battles that mon leads.
 */
export function createDeps(): SolverDeps {
  const name = process.env.SOLVER_TOY_SCENARIO;
  if (name === undefined || name === '') throw new Error('toy deps: SOLVER_TOY_SCENARIO is not set');
  const deps = toyDeps(scenarioNamed(name));
  const broken = process.env.SOLVER_TOY_BREAK_LEAD;
  if (broken === undefined || broken === '') return deps;
  const { engine } = deps;
  return {
    ...deps,
    engine: {
      ...engine,
      createBattle: (input: BattleInput): EngineState => {
        if (input.player[0]?.nickname === broken) throw new Error(`toy deps: battles led by ${broken} are broken (SOLVER_TOY_BREAK_LEAD)`);
        return engine.createBattle(input);
      },
    },
  };
}
