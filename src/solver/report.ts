// The proof report: what was searched and enumerated, the assumptions every verdict
// rests on (global constraint "Assumptions shown"), and what the independent checker verified. Also a gauntlet's entry
// ranges (the HP and statuses the team can enter each later fight with), read
// from the checker's end states.

import type { ChanceKind, UndrawnSleep } from '../contracts/engine.js';
import type { GauntletEntry, ProofReport, SolveRequest } from '../contracts/solver.js';
import type { StartStatus } from '../save/status.js';
import type { SearchStats } from './arena.js';
import type { CheckResult } from './check/checker.js';
import { healedCarry, type ArenaFight } from './inputs.js';
import type { SolverConfig, SolverDeps } from './types.js';

export const MODEL_NOTE = 'model not yet verified in game';

/** Each chance kind in words, in the contract's order (the order `enumerated` lists them in). */
const CHANCE_WORDS: Record<ChanceKind, string> = {
  roll: 'damage rolls', crit: 'critical hits', hit: 'hits and misses', effect: 'secondary effects', speedTie: 'speed ties',
  quickClaw: 'Quick Claw', multiHit: 'multi-hit counts', sleepWake: 'sleep turns', confusionSnap: 'confusion ending',
  selfHit: 'confusion self-hits', fullPara: 'full paralysis', thaw: 'thawing', infatuation: 'infatuation',
  durationEnd: 'effect durations', protect: 'Protect success', pick: 'random picks', abilityProc: 'ability activations',
  itemProc: 'item activations', switchTarget: 'forced switch targets', raw: 'unlabelled random draws',
};

/** What the search enumerated: the chance kinds it met (contract order), the AI supports, the worlds. */
export function enumeratedOf(stats: SearchStats, worlds: number): string[] {
  const kinds = (Object.keys(CHANCE_WORDS) as ChanceKind[]).filter((k) => stats.chanceKinds.has(k));
  return [...kinds.map((k) => `chance: ${CHANCE_WORDS[k]}`), `AI support at level 1 (${stats.supports} supports)`, `${worlds} world(s)`];
}

/**
 * A gauntlet's rules in words, or null for a single fight. Heals are named by 1-based
 * fight number, as the page counts fights.
 */
function gauntletAssumption(req: SolveRequest): string | null {
  const n = req.fights.length;
  if (n < 2) return null;
  const heals = req.fights.flatMap((f, i) => (f.healBefore === true ? [i + 1] : []));
  const healed = heals.length === 0 ? '' : `, except a full heal before ${heals.length === 1 ? 'fight' : 'fights'} ${heals.join(', ')}`;
  return `gauntlet of ${n} fights with one team: HP, PP and status carry over between fights${healed}; the lead may change before each fight; `
    + 'experience is ignored between fights too, which can only underrate the team; the crit budget and the death odds count across the whole gauntlet';
}

/** The assumptions behind every verdict for `req` (at least the global constraints' list; a gauntlet's rules too). */
export function baseAssumptions(deps: SolverDeps, cfg: SolverConfig, req: SolveRequest, worlds: number): string[] {
  const mode = cfg.observationMode === 'display'
    ? 'observation mode display: each decision depends only on what the screen shows'
    : 'observation mode RAM: each decision may depend on the exact battle state';
  const gauntlet = gauntletAssumption(req);
  return [
    'chance: every random draw is enumerated exactly with the engine\'s probabilities and is independent of every other draw',
    `certification level 1: safe against every action the ported trainer AI can pick, at its exact odds (${deps.enemyModel.id})`,
    mode,
    'no mid-fight level-ups: experience is ignored, which can only underrate the team',
    `engine ${deps.engine.id}; AI ${deps.enemyModel.id}`,
    `horizon: ${req.horizonTurns} turns per fight; a line not won by then counts as failing`,
    'crit budget counted in steps: a step with several enemy crits counts as one',
    `worlds treated adversarially: ${worlds} candidate world(s) for disputed natures and abilities, each taken at its worst`,
    ...(gauntlet === null ? [] : [gauntlet]),
  ];
}

/**
 * A status as a gauntlet entry names it: 'sleep:<turns>', a carried undrawn sleep 'sleepUndrawn:<attempts>' (the
 * server's string; the page shows "Asleep (k turns so far)"), else its kind ('poison', 'toxic', 'burn', 'freeze',
 * 'paralysis', 'none').
 */
export function statusText(status: StartStatus | UndrawnSleep): string {
  if (status.kind === 'sleep') return `sleep:${status.turns}`;
  return status.kind === 'sleepUndrawn' ? `sleepUndrawn:${status.attempts}` : status.kind;
}

/**
 * A gauntlet's entries (contract GauntletEntry): one per later fight that `endStates` (the checker's distinct canonical
 * carries entering each later fight) reaches, in fight order; a fight no line enters (every path died before it) has
 * none. Per team mon, in canonical order: its ref, the lowest and highest HP and the sorted distinct statuses over those
 * carries; after a heal (`healBefore`), the healed carry's instead (inputs.ts healedCarry: full max HP, 'none', since a
 * heal cures status).
 */
export function gauntletEntries(fights: readonly ArenaFight[], endStates: CheckResult['endStates']): GauntletEntry[] {
  const entries: GauntletEntry[] = [];
  for (let fight = 1; fight < fights.length; fight++) {
    const carries = endStates.filter((e) => e.fight === fight).map((e) => e.carry);
    if (carries.length === 0) continue;
    const f = fights[fight]!;
    const healed = f.healBefore ? healedCarry(f.team) : null;
    const mons = f.team.map((info, i) => {
      const h = healed?.mons[i];
      if (h !== undefined) return { ref: info.ref, hpMin: h.hp, hpMax: h.hp, statuses: [statusText(h.status)] };
      const carried = carries.map((c) => {
        const m = c.mons[i];
        if (c.mons.length !== f.team.length || m === undefined) throw new RangeError(`report: an entry carry has ${c.mons.length} mons for a team of ${f.team.length}`);
        return m;
      });
      const hps = carried.map((m) => m.hp);
      return { ref: info.ref, hpMin: Math.min(...hps), hpMax: Math.max(...hps), statuses: [...new Set(carried.map((m) => statusText(m.status)))].sort() };
    });
    entries.push({ fight, mons });
  }
  return entries;
}

/**
 * The hits a check's damage oracle did not cross-check (CheckResult.notCrossChecked) as the report lists them:
 * by hits, most first, then by move name; [] when none.
 */
export function notCrossCheckedList(counts: Readonly<Record<string, number>>): { move: string; hits: number }[] {
  return Object.entries(counts)
    .filter(([, hits]) => hits > 0)
    .map(([move, hits]) => ({ move, hits }))
    .sort((a, b) => b.hits - a.hits || (a.move < b.move ? -1 : a.move > b.move ? 1 : 0));
}

/** The report's verification from a check; null means nothing was verified (not passed, no checks, nothing listed). */
export function verificationOf(check: CheckResult | null): ProofReport['verification'] {
  if (check === null) return { passed: false, damageChecks: 0, orderChecks: 0, mismatches: [], notCrossChecked: [] };
  return {
    passed: check.passed, damageChecks: check.damageChecks, orderChecks: check.orderChecks, mismatches: [...check.mismatches],
    notCrossChecked: notCrossCheckedList(check.notCrossChecked),
  };
}

/** The ProofReport from the run's parts; `check` null means nothing was verified. */
export function buildReport(parts: {
  stats: SearchStats; tt: { entries: number; hits: number }; elapsedMs: number; check: CheckResult | null;
  assumptions: string[]; enumerated: string[]; rejectedTeams: ProofReport['rejectedTeams']; modelVerifiedInGame: boolean;
}): ProofReport {
  const { stats, check } = parts;
  return {
    nodes: stats.nodes, turnExecutions: stats.leaves, ttEntries: parts.tt.entries, ttHits: parts.tt.hits, elapsedMs: parts.elapsedMs,
    enumerated: [...parts.enumerated], assumptions: [...parts.assumptions], rejectedTeams: [...parts.rejectedTeams],
    verification: verificationOf(check),
    modelNote: parts.modelVerifiedInGame ? null : MODEL_NOTE,
  };
}
