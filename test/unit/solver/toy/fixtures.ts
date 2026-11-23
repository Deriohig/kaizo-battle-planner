// Arena builders shared by the solver tests: ArenaFights from a toy scenario or a table game, and arenas over them.
// Toy MonInfo: ref 'party:<i>' = s.p1[i], at full HP and PP (fullPp = the limited-PP moves' `pp ?? 10`), so a fight
// from MonInfo starts like a fresh toy battle; preStatusCandidates from the scenario (default []).
// Toy FightInfo: any trainer of the registry; the scenario's own is labelled with its name and has its worlds, the
// others are labelled with their id, in one world. benchMonotone is the scenario's (default true).

import type { EnemyModel } from '../../../../src/contracts/ai.js';
import type { Engine } from '../../../../src/contracts/engine.js';
import type { MonRef } from '../../../../src/contracts/solver.js';
import type { StartStatus } from '../../../../src/save/status.js';
import { Arena, emptyStats } from '../../../../src/solver/arena.js';
import { DEFAULT_CONFIG } from '../../../../src/solver/config.js';
import type { ArenaFight } from '../../../../src/solver/inputs.js';
import type { FightInfo, MonInfo } from '../../../../src/solver/types.js';
import { createToyAi } from './ai.js';
import { createToyEngine } from './engine.js';
import type { ToyRegistry } from './game.js';
import { toyPlayerMon, toyTrainer } from './helpers.js';
import type { Scenario } from './scenarios.js';
import type { tableGame } from './table.js';

function toyMonInfo(registry: ToyRegistry, name: string, index: number, candidates: readonly StartStatus[] = []): MonInfo {
  const data = registry.mons[name];
  if (data === undefined) throw new Error(`fixtures: unknown toy mon ${name}`);
  const pp = data.moves.flatMap((m) => (m.pp === null ? [] : [m.pp ?? 10]));
  return {
    ref: `party:${index}`,
    mon: { ...toyPlayerMon(name), currentHp: data.maxHp, pp, location: { kind: 'party', slot: index } },
    maxHp: data.maxHp, fullPp: [...pp], status: { kind: 'none' }, label: name, preStatusCandidates: candidates.map((c) => ({ ...c })),
  };
}

/** The FightInfo for the registry's trainer `trainerId` (see the top of the file). Throws for a trainer it lacks. */
export function toyFightInfo(s: Scenario, trainerId: string, healBefore = false): FightInfo {
  if (s.registry.trainers[trainerId] === undefined) throw new Error(`fixtures: scenario ${s.name} has no trainer ${trainerId}`);
  const own = trainerId === s.trainerId;
  return {
    spec: { trainerId, healBefore }, trainer: toyTrainer(trainerId, s.registry), field: {},
    worlds: (own ? s.worlds : undefined) ?? [{ enemy: [] }], label: own ? s.name : trainerId, benchMonotone: s.benchMonotone ?? true,
  };
}

/** The scenario's whole p1 list as a team, in canonical order. */
export function toyTeam(s: Scenario): MonInfo[] {
  return s.p1.map((name, i) => toyMonInfo(s.registry, name, i, s.preStatusCandidates?.[name]));
}

/** One ArenaFight for the scenario: its whole p1 list as the team, its worlds (default [{ enemy: [] }]). */
export function scenarioFights(s: Scenario, opts: { healBefore?: boolean; startStatus?: Record<MonRef, StartStatus> } = {}): ArenaFight[] {
  const healBefore = opts.healBefore ?? false;
  return [{ info: toyFightInfo(s, s.trainerId, healBefore), team: toyTeam(s), startStatus: { ...opts.startStatus }, healBefore }];
}

/**
 * One ArenaFight per trainer of `s.fights` (default [s.trainerId]), as the solve layer builds a gauntlet: the whole p1
 * list as the team, `healBefore[i]` for fight i (default false), `startStatus` at fight 0 only.
 */
export function gauntletFights(s: Scenario, opts: { healBefore?: boolean[]; startStatus?: Record<MonRef, StartStatus> } = {}): ArenaFight[] {
  const team = toyTeam(s);
  return (s.fights ?? [s.trainerId]).map((trainerId, i) => {
    const healBefore = opts.healBefore?.[i] ?? false;
    return { info: toyFightInfo(s, trainerId, healBefore), team, startStatus: i === 0 ? { ...opts.startStatus } : {}, healBefore };
  });
}

/** One ArenaFight for a table game: one mon 'party:0' with maxHp 1 (the table's carryOut has hp 1, pp []). */
export function tableFights(t: ReturnType<typeof tableGame>): ArenaFight[] {
  const player = t.input.player[0];
  if (player === undefined) throw new Error('fixtures: a table game input has no player mon');
  const info: FightInfo = {
    spec: { trainerId: t.input.trainer.id }, trainer: t.input.trainer, field: t.input.field, worlds: [{ enemy: [] }],
    label: t.input.trainer.id, benchMonotone: true,
  };
  const mon: MonInfo = {
    ref: 'party:0', mon: { ...player, currentHp: 1, pp: [] }, maxHp: 1, fullPp: [], status: { kind: 'none' }, label: player.nickname,
    preStatusCandidates: [],
  };
  return [{ info, team: [mon], startStatus: {}, healBefore: false }];
}

/** An arena with fresh stats; `edgeCacheEntries` defaults to the solver's default. */
export function makeArena(fights: ArenaFight[], engine: Engine, ai: EnemyModel, opts: { edgeCacheEntries?: number; maxLeaves?: number } = {}): Arena {
  return new Arena({
    engine, enemyModel: ai, fights, edgeCacheEntries: opts.edgeCacheEntries ?? DEFAULT_CONFIG.edgeCacheEntries,
    maxLeaves: opts.maxLeaves, stats: emptyStats(),
  });
}

/** The toy engine and the toy AI over scenarioFights(s). */
export function scenarioArena(s: Scenario, opts: { maxLeaves?: number } = {}): Arena {
  return makeArena(scenarioFights(s), createToyEngine(s.registry), createToyAi(s.registry), opts);
}
