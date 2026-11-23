import { describe, expect, it, vi } from 'vitest';
import type { EnemyModel } from '../../../src/contracts/ai.js';
import type { PlanLeaf, PlanNode, Progress, SolveRequest, Verdict } from '../../../src/contracts/solver.js';
import { probeHiddenInformation } from '../../../src/solver/badge.js';
import { createSolver } from '../../../src/solver/index.js';
import { defaultLabeler } from '../../../src/solver/labeler.js';
import { rat } from '../../../src/solver/rational.js';
import type { SolverDeps } from '../../../src/solver/types.js';
import { toyDeps } from './toy/deps.js';
import { makeArena, scenarioFights } from './toy/fixtures.js';
import type { ToyMon } from './toy/game.js';
import { toyOracles } from './toy/oracles.js';
import { deadlyRolls, level2Gap, safe1v1, twoSafeLines, worldsSplit, type Scenario } from './toy/scenarios.js';

// rankProven with a hook that runs just before a ranking starts, given its level.
const hooks = vi.hoisted(() => ({ beforeRank: null as ((level: number) => void) | null }));
vi.mock('../../../src/solver/rank.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/solver/rank.js')>();
  return {
    ...real,
    rankProven: (...args: Parameters<typeof real.rankProven>) => {
      hooks.beforeRank?.(args[3].level);
      return real.rankProven(...args);
    },
  };
});

const BADGE = 'level-2 badge (safe against every legal enemy action)';
const RAM_FIGURE = 'figure: a tier-1 line exists in RAM mode';
const MENDS = 'Use move 2';

interface Opts { req?: Partial<SolveRequest>; deps?: Partial<SolverDeps>; onProgress?: (p: Progress) => void }
const badge = (more: Opts = {}): Opts => ({ ...more, req: { attemptAnyLegalBadge: true, ...more.req } });

/** One fight against the scenario's trainer with its whole p1 list as a fixed team, at its horizon. */
function solve(s: Scenario, opts: Opts = {}): Promise<Verdict> {
  return createSolver(toyDeps(s, opts.deps)).solve({
    fights: [{ trainerId: s.trainerId }], team: { kind: 'fixed', party: s.p1.map((_, i) => `party:${i}`) }, preStatus: 'given',
    budgetMs: 600_000, horizonTurns: s.horizon, attemptAnyLegalBadge: false, ranking: [], ...opts.req,
  }, opts.onProgress);
}

function tierOf<T extends Verdict['tier']>(v: Verdict, tier: T): Extract<Verdict, { tier: T }> {
  if (v.tier !== tier) throw new Error(`expected tier ${String(tier)}, got ${JSON.stringify({ tier: v.tier, ...(v.tier === 'unproven' ? { reason: v.reason, detail: v.detail } : {}) })}`);
  return v as Extract<Verdict, { tier: T }>;
}

/** Every label of `kind` nodes in the tree, depth first: player action labels, or enemy branch labels. */
function labels(node: PlanNode | PlanLeaf, kind: 'player' | 'enemy'): string[] {
  if ('result' in node) return [];
  const own = node.kind !== kind ? [] : kind === 'player' ? (node.actionLabel === undefined ? [] : [node.actionLabel]) : node.branches.map((b) => b.label);
  return [...own, ...node.branches.flatMap((b) => labels(b.next, kind))];
}

/** The badge's report line (without its prefix), and whether the shown line passed the checker. */
const badgeLine = (v: Verdict) => [v.report.assumptions.find((a) => a.startsWith(BADGE))?.slice(BADGE.length + 2), v.report.verification.passed];

/** `s` with its trainer replaced by `name`'s, whose one mon is `foe`. */
function withFoe(s: Scenario, name: string, foe: ToyMon): Scenario {
  return { ...s, name, trainerId: name, expect: {}, registry: { ...s.registry, trainers: { [name]: { id: name, party: [foe] } } } };
}

// twoSafeLines with Blast 4 that the toy AI never picks. Level 1's best line Mends (4 turns, 8/10) and dies to Blast
// every turn; at level 2 Strike, Strike survives two Blasts (2/10, 2 turns).
const badgeLineFight = withFoe(twoSafeLines, 'badgeLine', { name: 'Tapper', maxHp: 6, speed: 10, moves: [{ name: 'Tap', damage: [2] }, { name: 'Blast', damage: [4], aiScore: 1 }] });
// level2Gap with a Blast that only bruises: Hero ends 9/10 at level 1 and 5/10 against Blast; the one line is safe at both.
const bruised = withFoe(level2Gap, 'bruised', { name: 'Bully', maxHp: 5, speed: 20, moves: [{ name: 'Poke', damage: [1], aiScore: 10 }, { name: 'Blast', damage: [5], aiScore: 1 }] });

// worldsSplit's hidden worlds with a crit-only threat: in display mode either first move meets one Bite that only a crit
// makes deadly (tier 2, budget 0); in RAM mode each world gets its own first move (tier 1).
const critSplit: Scenario = {
  name: 'critSplit', p1: ['Hero'], trainerId: 'critSplit', horizon: 2, expect: {},
  worlds: [{ enemy: [{ nature: 0 }] }, { enemy: [{ nature: 1 }] }],
  registry: {
    mons: { Hero: { name: 'Hero', maxHp: 10, speed: 5, moves: [{ name: 'Quick', damage: [3], priority: 1 }, { name: 'Strike', damage: [6] }] } },
    trainers: {
      critSplit: {
        id: 'critSplit', hpBarSegments: 1,
        party: [{ name: 'Gremlin', maxHp: 3, speed: 10, moves: [{ name: 'Bite', damage: [5], critChance: rat(1, 4) }], worlds: [{}, { maxHp: 6, speed: 4 }] }],
      },
    },
  },
};

describe('badge', () => {
  it('proves the badge on the shown line when it is safe at level 2', async () => {
    const plain = tierOf(await solve(safe1v1), 1);
    const v = tierOf(await solve(safe1v1, badge()), 1);
    expect([v.anyLegalBadge, v.rank.turns, v.report.verification.mismatches, badgeLine(v)]).toEqual(['proven', '1', [], ['attempted, proven on the shown line', true]]);
    // The verification adds the level-2 check's cross-checks to the level-1 check's.
    expect(v.report.verification.damageChecks).toBeGreaterThan(plain.report.verification.damageChecks);

    // The re-check asks only whether the line is safe at level 2: the level-1 thresholds (9/10) do not apply to Blast's
    // branch (5/10), so the same line is proven and keeps its level-1 rank.
    const b = tierOf(await solve(bruised, badge()), 1);
    expect([b.anyLegalBadge, badgeLine(b)[0], b.rank.worstMinHp]).toEqual(['proven', 'attempted, proven on the shown line', '9/10 (90.00%)']);
  });

  it('fails the badge when a legal move kills, or no time is left', async () => {
    const v = tierOf(await solve(level2Gap, badge()), 1);
    expect([v.anyLegalBadge, v.rank.turns, v.report.verification.mismatches, badgeLine(v)]).toEqual(['failed', '1', [], [expect.stringMatching(/^attempted, failed: refuted at level 2: /), true]]);

    // A fake clock passes the deadline while the level-1 line is verified: the badge fails and the line stays tier 1.
    let clock = 0;
    const late = tierOf(await solve(safe1v1, badge({
      req: { budgetMs: 1_000 }, deps: { now: () => clock, config: { progressIntervalMs: 0 } },
      onProgress: (p) => {
        if (p.message.startsWith('verifying the tier 1 line')) clock = 1_500;
      },
    })), 1);
    expect([late.anyLegalBadge, badgeLine(late)]).toEqual(['failed', ['attempted, failed: no search time left', true]]);
  });

  it('prefers the best level-2 line when the level-1 line fails at level 2', async () => {
    const plain = tierOf(await solve(badgeLineFight), 1);
    expect([plain.rank.turns, plain.rank.worstMinHp, labels(plain.tree, 'player')]).toEqual(['4', '4/5 (80.00%)', expect.arrayContaining([MENDS])]);

    const v = tierOf(await solve(badgeLineFight, badge()), 1);
    expect([v.anyLegalBadge, v.rank.turns, v.rank.worstMinHp, v.report.verification.mismatches]).toEqual(['proven', '2', '1/5 (20.00%)', []]);
    // Strike, Strike and never Mend, drawn at level 1: only the AI's support (Tap) branches, never Blast.
    const actions = labels(v.tree, 'player');
    expect([actions[0], new Set(actions.slice(1)), new Set(labels(v.tree, 'enemy'))]).toEqual(['Lead with Hero', new Set(['Use move 1']), new Set(['If the AI uses move 1'])]);
    expect(badgeLine(v)).toEqual(['attempted, proven; the shown line is the best-ranked level-2 line (the best-ranked level-1 line fails at level 2)', true]);

    // The badge budget runs out as the level-2 ranking starts: the line so far is still a checked level-2 proof.
    let clock = 0;
    hooks.beforeRank = (level) => {
      if (level === 2) clock = 600;   // the badge's deadline is 500; the checker's is 2,000
    };
    try {
      const cut = tierOf(await solve(badgeLineFight, badge({ req: { budgetMs: 1_000 }, deps: { now: () => clock } })), 1);
      expect([cut.anyLegalBadge, badgeLine(cut)]).toEqual(['proven', ['attempted, proven; the shown line is the best level-2 line found within the badge budget (the best-ranked level-1 line fails at level 2)', true]]);
    } finally {
      hooks.beforeRank = null;
    }
  });

  it('never shows a level-2 line that fails the checker at either level', async () => {
    // An oracle that rejects every Blast step (only level 2 meets one).
    const oracles = toyOracles(badgeLineFight.registry);
    const strict: SolverDeps['oracles'] = {
      ...oracles,
      damage: {
        id: 'strict-damage',
        check: (step) => (step.choices.p2?.kind === 'move' && step.choices.p2.slot === 1 ? { checks: 1, mismatches: ['no Blast expected'] } : oracles.damage.check(step)),
      },
    };
    // An AI undefined once it has seen Strike alone: level 2 never asks it, but the level-1 check of the level-2 line
    // does; the level-1 line Mends on turn 1 and never meets it.
    const toyAi = toyDeps(badgeLineFight).enemyModel;
    const poisoned: EnemyModel = {
      ...toyAi,
      support: (state, memory) => {
        if (memory.key === '["Strike"]') throw Object.assign(new Error('poisoned'), { code: 'POISON' });
        return toyAi.support(state, memory);
      },
    };
    for (const [deps, why] of [[{ oracles: strict }, 'damage oracle strict-damage: no Blast expected'], [{ enemyModel: poisoned }, 'unproven: undefined AI behaviour: POISON: poisoned']] as const) {
      const v = tierOf(await solve(badgeLineFight, badge({ deps })), 1);
      expect([v.anyLegalBadge, v.rank.turns, labels(v.tree, 'player'), v.report.verification.mismatches, badgeLine(v)], why).toEqual([
        'failed', '4', expect.arrayContaining([MENDS]), [], [expect.stringContaining(`attempted, failed: the level-2 line did not pass the checker: ${why}`), true],
      ]);
    }
  });

  it('is not attempted unless asked, in RAM mode, or without a tier-1 line', async () => {
    expect(badgeLine(tierOf(await solve(safe1v1), 1))[0]).toBe('not attempted (not requested)');
    expect(tierOf(await solve(level2Gap), 1).anyLegalBadge).toBe('notAttempted');
    // RAM mode: level-1 and level-2 observation keys differ, so the badge is not tried.
    const ram = tierOf(await solve(safe1v1, badge({ deps: { config: { observationMode: 'ram' } } })), 1);
    expect([ram.anyLegalBadge, badgeLine(ram)[0]]).toEqual(['notAttempted', undefined]);
    expect(ram.report.assumptions).toContain('badge not attempted in RAM mode: level-1 and level-2 observation keys differ');
    expect(badgeLine(tierOf(await solve(deadlyRolls, badge()), 3))[0]).toBe('not attempted (no verified tier-1 line)');
  });

  it('reports needsHiddenInformation when only RAM mode proves a line', async () => {
    const v = tierOf(await solve(worldsSplit), 'unproven');
    expect([v.reason, v.detail, v.best?.tier, v.report.verification.passed]).toEqual(['needsHiddenInformation', 'a safe line exists only if the exact enemy state is read from RAM', 3, true]);
    // The probe is configurable, and RAM mode needs none: it proves the line itself.
    expect((await solve(worldsSplit, { deps: { config: { probeHiddenInformation: false } } })).tier).toBe(3);
    expect((await solve(worldsSplit, { deps: { config: { observationMode: 'ram' } } })).tier).toBe(1);
    // Tier 2 stays tier 2: the RAM-mode finding is only a report line.
    const t2 = tierOf(await solve(critSplit), 2);
    expect([t2.critBudget, t2.report.enumerated.includes(RAM_FIGURE)]).toEqual([0, true]);
    expect(tierOf(await solve(critSplit, { deps: { config: { probeHiddenInformation: false } } }), 2).report.enumerated).not.toContain(RAM_FIGURE);

    const probe = (s: Scenario): boolean => {
      const deps = toyDeps(s);
      return probeHiddenInformation(makeArena(scenarioFights(s), deps.engine, deps.enemyModel), s.horizon, { deadline: Number.POSITIVE_INFINITY, now: () => 0, labeler: defaultLabeler });
    };
    expect([probe(worldsSplit), probe(deadlyRolls)]).toEqual([true, false]);
  });
});
