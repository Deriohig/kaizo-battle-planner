// A plan request for the solver, as the split bench builds it (`npm run bench:split`, benchSplit.ts and
// scripts/benchSplit.ts); no route takes one since 7c. The body (the shape the plan route took before 7c) is checked against
// the catalog, the eligible Pokémon and the plan settings, and turned into the solver's `SolveRequest`
// (`src/contracts/solver.ts`). Each error is one sentence naming the field.

import type { TrainerCatalog } from '../battle/types.js';
import type { FightSpec, MonRef, RankKey, SolveRequest } from '../contracts/solver.js';
import type { StartStatus } from '../save/status.js';
import { statusFromJson } from '../server/json.js';
import { levelsFromBody, levelsProblem, levelsRecord } from '../server/levels.js';
import { isRecord, isWhole } from '../server/settings.js';
import { pickVariant } from '../server/trainers.js';

/** The search horizon a plan request gets (`PlanContext.horizonTurns`); the body has no field for it. */
export const DEFAULT_HORIZON_TURNS = 50;

/** The start statuses a plan accepts: pre-sleep (`sleep:1`, the last turn of sleep) and the four that last. */
export const START_STATUSES = ['sleep:1', 'burn', 'poison', 'toxic', 'paralysis'] as const;

/** The bounds of a solver budget in milliseconds: a plan request's `{ ms }`. */
export const MIN_BUDGET_MS = 1_000;
export const MAX_BUDGET_MS = 86_400_000;

/** The solver's budgets by name (a request's `budget: 'route'`, say) and its ranking, which a plan request takes from here. */
export interface PlanSettings { budgetsMs: { route: number; gym: number; deep: number; gauntlet: number }; ranking: RankKey[] }

/** The budgets and the ranking the settings held before 7c took them off the server. */
export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  budgetsMs: { route: 30_000, gym: 300_000, deep: 3_600_000, gauntlet: 900_000 },
  ranking: ['critBudget', 'critDeathProbability', 'worstMinHp', 'totalHp', 'pp', 'chanceDependencies', 'turns'],
};

/**
 * What a plan request is checked against. `eligible` holds the MonRefs a team may use (the box's eligible Pokémon);
 * `saveLevels` their levels in the save, which a what-if level may not go below (left out, the floor is 1).
 */
export interface PlanContext {
  catalog: TrainerCatalog; eligible: ReadonlySet<MonRef>; settings: PlanSettings; horizonTurns: number;
  saveLevels?: ReadonlyMap<MonRef, number>;
}

const MAX_FIGHTS = 20;
const MAX_PARTY = 6;

/**
 * A plan request body as the solver's `SolveRequest`:
 * - `fights`: 1 to 20 trainers of `catalog.trainers`, singles only, each with `variant` (default 0, below its number of
 *   copies) and `healBefore` (default false) filled in;
 * - `team`: a fixed party of 1 to 6 eligible refs (lead first), or a search pool of 1 or more (every eligible mon of the
 *   box may be a candidate) with `maxSize` 1 to 6; no ref twice. A search may add `mustBring` and
 *   `preferred`: refs of the pool, none twice and none in both, copied in the order given and left out when
 *   empty or absent. Only the shape is checked: more `mustBring` than `maxSize` passes, and the solver
 *   answers it with an unproven `noEligibleTeam`. A fixed team ignores both;
 * - `startStatus` (optional): refs of the team to one of `START_STATUSES`, as `StartStatus`;
 * - `levels` (optional): what-if levels, an object from ref to level for refs of the team (the fixed party, or
 *   the search pool), each from its level in the save to 100, none twice; carried through as given, and left out when
 *   empty or absent;
 * - `budgetMs`: `settings.budgetsMs[budget]`, or `budget.ms` (1000 to 86400000);
 * - `ranking` from the settings and `horizonTurns` from `ctx`;
 * - `refine` (optional): 'first' or 'best', carried through as given and left out when absent (the solver
 *   reads absent as 'best').
 */
export function toSolveRequest(body: unknown, ctx: PlanContext): { ok: true; request: SolveRequest } | { ok: false; error: string } {
  try {
    return { ok: true, request: readRequest(body, ctx) };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    throw e;
  }
}

/** A failed check inside `readRequest`; `toSolveRequest` turns it into `{ ok: false }`. */
class Invalid extends Error {}

function readRequest(body: unknown, ctx: PlanContext): SolveRequest {
  if (!isRecord(body)) throw new Invalid('The plan request must be a JSON object');
  const fights = fightsField(body.fights, ctx.catalog);
  const team = teamField(body.team, ctx.eligible);
  const members = new Set(team.kind === 'fixed' ? team.party : team.pool);
  const startStatus = body.startStatus === undefined ? undefined : startStatusField(body.startStatus, members);
  const { preStatus, attemptAnyLegalBadge } = body;
  if (preStatus !== 'given' && preStatus !== 'propose') throw new Invalid('preStatus must be given or propose');
  const budgetMs = budgetField(body.budget, ctx.settings);
  if (typeof attemptAnyLegalBadge !== 'boolean') throw new Invalid('attemptAnyLegalBadge must be true or false');
  const levels = levelsField(body.levels, team, members, ctx.saveLevels);
  const refine = body.refine === undefined ? undefined : refineField(body.refine);
  return {
    fights, team, ...(startStatus === undefined ? {} : { startStatus }), preStatus, budgetMs, horizonTurns: ctx.horizonTurns,
    attemptAnyLegalBadge, ranking: [...ctx.settings.ranking], ...(levels === undefined ? {} : { levels }),
    ...(refine === undefined ? {} : { refine }),
  };
}

/** `refine`: 'first' or 'best', as given. */
function refineField(value: unknown): NonNullable<SolveRequest['refine']> {
  if (value !== 'first' && value !== 'best') throw new Invalid('refine must be first or best');
  return value;
}

function fightsField(value: unknown, catalog: TrainerCatalog): FightSpec[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FIGHTS) {
    throw new Invalid(`fights must be a list of 1 to ${MAX_FIGHTS} fights`);
  }
  return value.map((fight: unknown, i) => fightField(fight, `fights[${i}]`, catalog));
}

function fightField(fight: unknown, at: string, catalog: TrainerCatalog): FightSpec {
  if (!isRecord(fight)) throw new Invalid(`${at} must be an object`);
  const id = fight.trainerId;
  if (typeof id !== 'string') throw new Invalid(`${at}.trainerId must be a trainer ID (a string)`);
  const trainer = catalog.trainers.find((candidate) => candidate.id === id);
  if (trainer === undefined) throw new Invalid(`${at}.trainerId ${JSON.stringify(id)} is not a trainer in the catalog`);

  const variant = fight.variant === undefined ? 0 : fight.variant;
  const copy = typeof variant === 'number' ? pickVariant(trainer, variant) : null;
  if (copy === null) {
    const copies = 1 + trainer.variants.length;
    throw new Invalid(copies === 1
      ? `${at}.variant must be 0: ${trainer.name} has one copy`
      : `${at}.variant must be a whole number from 0 to ${copies - 1}: ${trainer.name} has ${copies} copies`);
  }
  // The copy the solver would fight, so a variant cannot slip a double past the check.
  if (copy.battleType !== 'single') throw new Invalid(`${trainer.name} is a double battle: the solver is not available yet`);

  const healBefore = fight.healBefore === undefined ? false : fight.healBefore;
  if (typeof healBefore !== 'boolean') throw new Invalid(`${at}.healBefore must be true or false`);
  return { trainerId: id, variant: variant as number, healBefore };
}

function teamField(value: unknown, eligible: ReadonlySet<MonRef>): SolveRequest['team'] {
  if (!isRecord(value) || (value.kind !== 'fixed' && value.kind !== 'search')) {
    throw new Invalid('team must be an object with kind fixed or search');
  }
  if (value.kind === 'fixed') return { kind: 'fixed', party: refsField(value.party, 'team.party', MAX_PARTY, eligible) };
  const pool = refsField(value.pool, 'team.pool', null, eligible);
  const { maxSize } = value;
  if (!isWhole(maxSize, 1, MAX_PARTY)) throw new Invalid(`team.maxSize must be a whole number from 1 to ${MAX_PARTY}`);
  const inPool = new Set(pool);
  const mustBring = poolRefsField(value.mustBring, 'team.mustBring', inPool, new Set());
  const preferred = poolRefsField(value.preferred, 'team.preferred', inPool, new Set(mustBring));
  return {
    kind: 'search', pool, maxSize,
    ...(mustBring.length === 0 ? {} : { mustBring }),
    ...(preferred.length === 0 ? {} : { preferred }),
  };
}

/**
 * `team.mustBring` or `team.preferred`: refs of the pool, none twice and none in `mustBring`, in the order given; absent
 * is empty. Only the shape is checked.
 */
function poolRefsField(value: unknown, field: string, pool: ReadonlySet<MonRef>, mustBring: ReadonlySet<MonRef>): MonRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((ref) => typeof ref === 'string')) throw new Invalid(`${field} must be a list of MonRefs`);
  const seen = new Set<MonRef>();
  for (const ref of value as string[]) {
    if (seen.has(ref)) throw new Invalid(`${field} lists ${ref} twice`);
    if (!pool.has(ref)) throw new Invalid(`${field} lists ${ref}, which is not in team.pool`);
    if (mustBring.has(ref)) throw new Invalid(`${field} lists ${ref}, which is also in team.mustBring`);
    seen.add(ref);
  }
  return [...seen];
}

/** 1 to `max` refs (1 or more when `max` is null), each eligible and none twice, in the order given. */
function refsField(value: unknown, field: string, max: number | null, eligible: ReadonlySet<MonRef>): MonRef[] {
  const fits = Array.isArray(value) && value.length >= 1 && (max === null || value.length <= max);
  if (!fits || !value.every((ref) => typeof ref === 'string')) {
    throw new Invalid(`${field} must be a list of ${max === null ? '1 or more' : `1 to ${max}`} MonRefs`);
  }
  const seen = new Set<MonRef>();
  for (const ref of value as string[]) {
    if (seen.has(ref)) throw new Invalid(`${field} lists ${ref} twice`);
    if (!eligible.has(ref)) throw new Invalid(`${ref} is not eligible`);
    seen.add(ref);
  }
  return [...seen];
}

function startStatusField(value: unknown, team: ReadonlySet<MonRef>): Record<MonRef, StartStatus> {
  if (!isRecord(value)) throw new Invalid('startStatus must be an object from MonRef to status');
  const statuses: Record<MonRef, StartStatus> = {};
  for (const [ref, text] of Object.entries(value)) {
    // Only team refs get through, so `ref` is never "__proto__" or another key that would reach the prototype.
    if (!team.has(ref)) throw new Invalid(`startStatus names ${ref}, which is not in the team`);
    const status = typeof text === 'string' && (START_STATUSES as readonly string[]).includes(text) ? statusFromJson(text) : null;
    if (status === null) throw new Invalid(`startStatus for ${ref} must be ${orList(START_STATUSES)}, not ${JSON.stringify(text)}`);
    statuses[ref] = status;
  }
  return statuses;
}

/** `levels`: what-if levels for refs of `members` (levels.ts's checks); undefined when there are none. */
function levelsField(
  value: unknown, team: SolveRequest['team'], members: ReadonlySet<MonRef>, saveLevels: ReadonlyMap<MonRef, number> | undefined,
): SolveRequest['levels'] {
  const parsed = levelsFromBody(value);
  if (!parsed.ok) throw new Invalid(parsed.error);
  if (parsed.entries.length === 0) return undefined;
  const scope = new Map([...members].map((ref) => [ref, saveLevels?.get(ref) ?? 1]));
  const problem = levelsProblem(parsed.entries, scope, team.kind === 'fixed' ? 'team' : 'pool');
  if (problem !== null) throw new Invalid(problem);
  return levelsRecord(new Map(parsed.entries));
}

function budgetField(value: unknown, settings: PlanSettings): number {
  const budgets = settings.budgetsMs;
  if (typeof value === 'string' && Object.hasOwn(budgets, value)) return budgets[value as keyof typeof budgets];
  if (isRecord(value) && isWhole(value.ms, MIN_BUDGET_MS, MAX_BUDGET_MS)) return value.ms;
  throw new Invalid(
    `budget must be ${orList(Object.keys(budgets))}, or { ms } with a whole number of milliseconds from ${MIN_BUDGET_MS} to ${MAX_BUDGET_MS}`,
  );
}

/** "a, b or c". */
function orList(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}
