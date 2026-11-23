// Pre-status proposals: the variants the solver tries
// when the request lets it propose starting statuses, and the order that picks the best run (reused by the team search).
//
// preStatusVariants. One variant per (team mon, candidate) from MonInfo.preStatusCandidates, in team order then
// candidate order, at most MAX_PRE_STATUS_VARIANTS. A mon is skipped when the save has it statused (MonInfo.status) or
// `given` (the manual pre-status) has any entry for it: a manual 'none' is the player's call too. Each variant is `given` plus
// that one status. Pre-sleep is always the last turn of sleep, so a sleep candidate becomes { kind: 'sleep', turns: 1 };
// a 'none' candidate (no pre-status: the baseline) and a candidate that repeats an earlier one for the same mon give
// no variant.
//
// betterRun(a, b): true when `a` is strictly better. Tier 1 < 2 < 3 < unproven. Same tier 1: compareRank on the rank
// vectors (false when either is missing). Same tier 2: the higher crit budget, then the lower death probability, budget
// first unless the ranking puts critDeathProbability before critBudget (risk.ts budgetFirst, as the tier-2 search
// does). Same tier 3: the lower death probability. Two unproven runs: never. An empty ranking is DEFAULT_RANKING, as
// in solveFights. A tie is never better, so the earlier run is kept.

import type { Rational } from '../contracts/engine.js';
import type { MonRef, RankKey, Verdict } from '../contracts/solver.js';
import type { StartStatus } from '../save/status.js';
import { DEFAULT_RANKING } from './config.js';
import { compareRank } from './rank.js';
import { cmp } from './rational.js';
import { statusText } from './report.js';
import { budgetFirst } from './risk.js';
import type { FightRun } from './solve.js';
import type { MonInfo } from './types.js';

export const MAX_PRE_STATUS_VARIANTS = 12;

/** Pre-sleep: the last turn of sleep, sleep counter 1. */
export const PRE_SLEEP: StartStatus = Object.freeze({ kind: 'sleep', turns: 1 });

/** The variants to try (see the top of the file). `team` and `given` are not changed. */
export function preStatusVariants(team: MonInfo[], given: Record<MonRef, StartStatus>): Record<MonRef, StartStatus>[] {
  const variants: Record<MonRef, StartStatus>[] = [];
  for (const info of team) {
    if (info.status.kind !== 'none' || given[info.ref] !== undefined) continue;
    const seen = new Set<string>();
    for (const candidate of info.preStatusCandidates) {
      if (candidate.kind === 'none') continue;
      const status: StartStatus = candidate.kind === 'sleep' ? { ...PRE_SLEEP } : { ...candidate };
      const key = statusText(status);
      if (seen.has(key)) continue;
      seen.add(key);
      variants.push({ ...given, [info.ref]: status });
      if (variants.length === MAX_PRE_STATUS_VARIANTS) return variants;
    }
  }
  return variants;
}

/** 0 for tier 1 up to 3 for unproven. */
function tierRank(v: Verdict): number {
  return v.tier === 'unproven' ? 3 : v.tier - 1;
}

/** < 0 when `x` is better: the lower exact death probability. */
function byOdds(x: { deathProbability: Rational }, y: { deathProbability: Rational }): number {
  return cmp(x.deathProbability, y.deathProbability);
}

/** True when run `a` is strictly better than run `b` (see the top of the file). */
export function betterRun(a: FightRun, b: FightRun, ranking: readonly RankKey[]): boolean {
  const keys = ranking.length === 0 ? DEFAULT_RANKING : ranking;
  const va = a.verdict;
  const vb = b.verdict;
  const ta = tierRank(va);
  const tb = tierRank(vb);
  if (ta !== tb) return ta < tb;
  if (va.tier === 1) return a.vector !== null && b.vector !== null && compareRank(a.vector, b.vector, keys) < 0;
  if (va.tier === 2 && vb.tier === 2) {
    const budget = vb.critBudget - va.critBudget;   // < 0 when `a` survives more crit steps
    const odds = byOdds(va, vb);
    const [first, second] = budgetFirst(keys) ? [budget, odds] : [odds, budget];
    return (first !== 0 ? first : second) < 0;
  }
  if (va.tier === 3 && vb.tier === 3) return byOdds(va, vb) < 0;
  return false;
}
