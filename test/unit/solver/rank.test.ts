import { describe, expect, it, vi } from 'vitest';
import type { Choice } from '../../../src/contracts/engine.js';
import type { RankKey } from '../../../src/contracts/solver.js';
import type { Arena } from '../../../src/solver/arena.js';
import { rootBelief, type Belief } from '../../../src/solver/belief.js';
import { extractProof, type Certificate } from '../../../src/solver/certificate.js';
import { checkCertificate, type CheckResult } from '../../../src/solver/check/checker.js';
import { DEFAULT_RANKING } from '../../../src/solver/config.js';
import { defaultLabeler } from '../../../src/solver/labeler.js';
import { Prover, type ProofResult } from '../../../src/solver/prove.js';
import { rat } from '../../../src/solver/rational.js';
import { compareRank, rankProven, type RankOptions, type RankResult, type RankVector } from '../../../src/solver/rank.js';
import { NO_REASONS } from '../../../src/solver/types.js';
import { createToyAi } from './toy/ai.js';
import { createToyEngine } from './toy/engine.js';
import { makeArena, scenarioFights } from './toy/fixtures.js';
import type { ToyMon } from './toy/game.js';
import { toyOracles } from './toy/oracles.js';
import { twoSafeLines, type Scenario } from './toy/scenarios.js';

// extractProof with a hook that runs just before the ranking extracts a certificate.
const hooks = vi.hoisted(() => ({ beforeExtract: null as ((prover: Prover) => void) | null }));
vi.mock('../../../src/solver/certificate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/solver/certificate.js')>();
  return {
    ...real,
    extractProof: (...args: Parameters<typeof real.extractProof>) => {
      hooks.beforeExtract?.(args[0]);
      return real.extractProof(...args);
    },
  };
});

const lead = (index: number): Choice => ({ kind: 'switch', index });
const move = (slot: number): Choice => ({ kind: 'move', slot });
const TURNS_FIRST: readonly RankKey[] = ['turns', 'worstMinHp', 'totalHp', 'pp', 'chanceDependencies'];
const vec = (minHpFrac: [number, number], totalHp: number, pp: number, turns: number, chanceDependencies = 0): RankVector => ({ minHpFrac: rat(...minHpFrac), totalHp, pp, turns, chanceDependencies });

// twoSafeLines: deepening stops at Strike, Strike (2 turns, 6/10); the best end within 4 turns is Strike, Mend, Mend, Strike (8/10).
const BASE = vec([3, 5], 6, 18, 2);
const BEST = vec([4, 5], 8, 16, 4);
// A one-turn KO line in `oneHitKo`: Hero ends 8/10 with 19 PP.
const ONE_HIT = vec([4, 5], 8, 19, 1);

/** Hero (10 HP, slower) Strikes 3 or uses `second`; Tapper (6 HP) Taps 2 first every turn. Strike, Strike is BASE. */
function oneHitKo(name: string, second: ToyMon['moves'][number], p1: ToyMon[] = [{ name: 'Hero', maxHp: 10, speed: 5, moves: [{ name: 'Strike', damage: [3] }, second] }]): Scenario {
  return {
    name, p1: p1.map((m) => m.name), trainerId: name, horizon: 3, expect: {},
    registry: {
      mons: Object.fromEntries(p1.map((m) => [m.name, m])), observeAll: true,
      trainers: { [name]: { id: name, party: [{ name: 'Tapper', maxHp: 6, speed: 10, moves: [{ name: 'Tap', damage: [2] }] }] } },
    },
  };
}
// Smash rolls 6 or 7: two engine leaves. Wild's raw draw makes its outcome unlabelled.
const smash = oneHitKo('smash', { name: 'Smash', damage: [6, 7] });
const wild = oneHitKo('wild', { name: 'Wild', damage: [6], effect: 'raw3' });
const plainWild = oneHitKo('plainWild', { name: 'Wild', damage: [6] });
// Calm (Strike 3) and Wild (Swipe 3 or 4: a chance branch point) both end 6/10 with the partner at 10/10 in 2 turns.
const twoLeads = oneHitKo('twoLeads', { name: 'unused', damage: [] }, [
  { name: 'Calm', maxHp: 10, speed: 5, moves: [{ name: 'Strike', damage: [3] }] },
  { name: 'Wild', maxHp: 10, speed: 5, moves: [{ name: 'Swipe', damage: [3, 4] }] },
]);

interface Proven { arena: Arena; root: Belief; base: { certificate: Certificate; horizon: number } }

/** A fresh arena for `s` and its tier-1 proof at the shortest winning horizon; `history` orders the proof's search. */
function proven(s: Scenario, opts: { maxLeaves?: number; history?: (root: Belief) => Map<string, Choice> } = {}): Proven {
  const arena = makeArena(scenarioFights(s), createToyEngine(s.registry), createToyAi(s.registry), { maxLeaves: opts.maxLeaves });
  const root = rootBelief(arena);
  const prover = new Prover(arena, {
    params: { level: 1, critBudget: null, thresholds: null }, mode: 'display', deadline: Number.POSITIVE_INFINITY, now: () => 0,
    labeler: defaultLabeler, history: opts.history?.(root) ?? new Map(),
  });
  const { result, horizon } = prover.deepen(root, s.horizon);
  expect(result.kind, s.name).toBe('win');
  return { arena, root, base: { certificate: extractProof(prover, root, horizon), horizon: s.horizon } };
}

function rank(p: Proven, over: Partial<RankOptions> = {}): RankResult {
  return rankProven(p.arena, p.root, p.base, {
    ranking: DEFAULT_RANKING, level: 1, mode: 'display', deadline: Number.POSITIVE_INFINITY, now: () => 0,
    labeler: defaultLabeler, history: new Map(), ...over,
  });
}

function check(s: Scenario, certificate: Certificate): CheckResult {
  return checkCertificate({
    certificate, fights: scenarioFights(s), engine: createToyEngine(s.registry), enemyModel: createToyAi(s.registry),
    oracles: toyOracles(s.registry), labeler: defaultLabeler, killerLimit: 20, deadline: Number.POSITIVE_INFINITY, now: () => 0,
  });
}

/** The ranked certificate carries the result's thresholds (none: null) and replays clean, its figures the vector's. */
function expectVerified(s: Scenario, r: RankResult, what: string): void {
  const none = Object.keys(r.thresholds).length === 0;
  expect([r.certificate.thresholds, r.certificate.horizon], what).toEqual([none ? null : r.thresholds, r.horizon]);
  const c = check(s, r.certificate);
  expect([c.passed, c.reason, c.mismatches, c.worstEnd, c.maxTurns], what).toEqual([
    true, undefined, [], { minHpFrac: r.vector.minHpFrac, totalHp: r.vector.totalHp, pp: r.vector.pp }, r.vector.turns,
  ]);
}

function withExtractHook<T>(hook: (prover: Prover) => void, run: () => T): T {
  hooks.beforeExtract = hook;
  try {
    return run();
  } finally {
    hooks.beforeExtract = null;
  }
}

describe('rank', () => {
  it('ranks by the configured keys and verifies the thresholds', () => {
    const p = proven(twoSafeLines);
    expect(p.base.certificate.horizon).toBe(2);
    const r = rank(p);
    expect(r).toMatchObject({
      vector: BEST, horizon: 4, complete: true,
      rank: { worstMinHp: '4/5 (80.00%)', totalHp: '8', pp: '16', chanceDependencies: '0', turns: '4' },
      thresholds: { minHpFrac: { value: rat(4, 5), strict: false }, totalHp: { value: 8, strict: false }, pp: { value: 16, strict: false } },
    });
    expect(r.certificate.nodes.map((n) => n.action)).toEqual([lead(0), move(0), move(1), move(1), move(0)]);   // Strike, Mend, Mend, Strike
    expectVerified(twoSafeLines, r, 'default');
    // The checker holds the line to its thresholds: a notch above its worst end is a mismatch.
    const stricter = check(twoSafeLines, { ...r.certificate, thresholds: { ...r.thresholds, minHpFrac: { value: rat(4, 5), strict: true } } });
    expect([stricter.passed, stricter.reason, stricter.mismatches]).toEqual([false, 'verificationMismatch', expect.arrayContaining([expect.stringContaining('threshold: lowest HP fraction 4/5, needs > 4/5')])]);

    // Only the ranked keys are applied and shown.
    const alone = rank(proven(twoSafeLines), { ranking: ['critBudget', 'worstMinHp'] });
    expect([alone.rank, alone.thresholds]).toEqual([{ worstMinHp: '4/5 (80.00%)' }, { minHpFrac: { value: rat(4, 5), strict: false } }]);
    // Turns first comes down to the shorter line, even from the 4-turn line as the base.
    const short = rank({ ...p, base: { certificate: r.certificate, horizon: r.horizon } }, { ranking: TURNS_FIRST });
    expect([short.vector, short.horizon, short.complete, short.certificate.nodes.map((n) => n.action)]).toEqual([BASE, 2, true, [lead(0), move(0), move(0)]]);
    expectVerified(twoSafeLines, short, 'turns first');
  });

  it('refuses a base that is not a tier-1 proof at its level and mode within the horizon', () => {
    const q = proven(twoSafeLines);
    const cert = q.base.certificate;
    const refused: Proven['base'][] = [
      { ...q.base, horizon: 1 }, { ...q.base, certificate: { ...cert, kind: 'risk' } }, { ...q.base, certificate: { ...cert, critBudget: 0 } },
      { ...q.base, certificate: { ...cert, level: 2 } }, { ...q.base, certificate: { ...cert, mode: 'ram' } },
    ];
    for (const [i, base] of refused.entries()) expect(() => rank({ ...q, base }), `base ${i}`).toThrow(/^rank: the base must be/);
    expect(() => rank({ ...q, base: { ...q.base, horizon: 0 } })).toThrow(RangeError);
  });

  it('a deadline or cancel stops ranking but keeps a checked proof', () => {
    const p = proven(twoSafeLines);
    const late = rank(p, { deadline: -1 });
    expect([late.certificate === p.base.certificate, late.complete, late.horizon, late.thresholds, late.vector, late.stopped]).toEqual([true, false, 2, {}, BASE, ['the time limit']]);
    expect(late.rank).toEqual({ worstMinHp: '3/5 (60.00%)', totalHp: '6', pp: '18', chanceDependencies: '0', turns: '2' });
    const aborted = rank(p, { signal: AbortSignal.abort() });
    expect([aborted.certificate === p.base.certificate, aborted.complete, aborted.vector, aborted.stopped]).toEqual([true, false, BASE, ['a cancel']]);

    // A clock that ticks once per reading, against every deadline below the readings a whole ranking takes: each result is
    // a proof the checker accepts, between the base and the best line.
    let readings = 0;
    const whole = rank(proven(twoSafeLines), { now: () => readings++ });
    expect([whole.vector, whole.complete, whole.stopped]).toEqual([BEST, true, []]);
    for (let deadline = 0; deadline < readings; deadline++) {
      let tick = 0;
      const r = rank(proven(twoSafeLines), { now: () => tick++, deadline });
      const what = `deadline ${deadline} of ${readings}`;
      expect(r.complete, what).toBe(deadline === readings - 1);
      expectVerified(twoSafeLines, r, what);
      expect([compareRank(r.vector, BASE, DEFAULT_RANKING) <= 0, compareRank(BEST, r.vector, DEFAULT_RANKING) <= 0], what).toEqual([true, true]);
    }

    // The deadline passing while an extraction re-proves (its table emptied): the line found before is kept.
    const q = proven(twoSafeLines);
    let expired = false;
    const cut = withExtractHook((prover) => {
      prover.tt.clear();
      expired = true;
    }, () => rank(q, { now: () => (expired ? 1 : 0), deadline: 0 }));
    expect([expired, cut.certificate === q.base.certificate, cut.complete, cut.vector, cut.stopped]).toEqual([true, true, false, BASE, ['the time limit']]);
    // Any other extraction failure is a bug, and it propagates.
    expect(() => withExtractHook(() => {
      throw new Error('extraction bug');
    }, () => rank(proven(twoSafeLines)))).toThrow('extraction bug');
  });

  it('compareRank orders by the configured keys', () => {
    const v = (over: Partial<RankVector> = {}): RankVector => ({ minHpFrac: rat(1, 2), totalHp: 10, pp: 20, turns: 3, chanceDependencies: 1, ...over });
    const [sturdy, quick] = [v({ minHpFrac: rat(3, 5), turns: 4 }), v({ turns: 2 })];
    const cases: [readonly RankKey[], RankVector, RankVector, number][] = [
      [DEFAULT_RANKING, v(), v(), 0],
      [['worstMinHp'], v({ minHpFrac: rat(1, 3) }), v({ minHpFrac: rat(333, 1000) }), -1],   // exact fractions
      [['totalHp', 'pp'], v({ pp: 21 }), v(), -1],
      [['chanceDependencies'], v({ chanceDependencies: 0 }), v(), -1],
      [DEFAULT_RANKING, sturdy, quick, -1],   // the order decides
      [TURNS_FIRST, sturdy, quick, 1],
      [['critBudget', 'critDeathProbability', 'pp'], sturdy, quick, 0],   // tier-2 keys and keys outside the ranking are not compared
      [['chanceDependencies', 'turns'], v({ turns: 2, chanceDependencies: 3 }), v({ chanceDependencies: 0 }), -1],   // always the last tie-break
    ];
    const sign = (x: number): number => Math.sign(x) || 0;
    for (const [i, [ranking, a, b, want]] of cases.entries()) {
      expect([sign(compareRank(a, b, ranking)), sign(compareRank(b, a, ranking))], `case ${i}`).toEqual([want, -want || 0]);
    }
  });

  it('breaks the last tie by fewest chance dependencies', () => {
    // History sends every search to Wild first (one branch point); every key ties and the last one picks Calm (none).
    const wildFirst = (root: Belief): Map<string, Choice> => new Map([[root.key, lead(1)]]);
    const p = proven(twoLeads, { history: wildFirst });
    const r = rank(p, { history: wildFirst(p.root) });
    expect([p.base.certificate.nodes[0]!.action, r.certificate.nodes[0]!.action, r.vector]).toEqual([lead(1), lead(0), vec([3, 5], 16, 18, 2)]);
    // Restricted to Wild at the root, the Wild line stays.
    const wildOnly = rank(p, { history: wildFirst(p.root), restrictRoot: [lead(1)] });
    expect([wildOnly.certificate.nodes[0]!.action, wildOnly.vector.chanceDependencies, wildOnly.complete]).toEqual([lead(1), 1, true]);
  });

  it.each([
    ['an engine limit', smash, 1, BASE, ['a refutation met an engine limit']],
    ['an unmodelled outcome', wild, undefined, BASE, ['a refutation met an unmodelled outcome']],
    ['no limit', smash, undefined, ONE_HIT, []],
    ['a labelled draw', plainWild, undefined, ONE_HIT, []],
  ])('a better line through %s', (_, s, maxLeaves, vector, stopped) => {
    // When every better line meets a limit or an unlabelled outcome, Strike, Strike is ranked but kept incomplete.
    const r = rank(proven(s, { maxLeaves }));
    expect([r.vector, r.complete, r.stopped]).toEqual([vector, stopped.length === 0, stopped]);
    expectVerified(s, r, s.name);
  });

  it('a failed turns step keeps the line found and stops incomplete', () => {
    // Turns alone: at horizon 1 the refutation holds Wild's unlabelled outcome; a shorter line than 2 turns may exist.
    const short = rank(proven(wild), { ranking: ['turns'] });
    expect([short.vector, short.horizon, short.complete]).toEqual([BASE, 2, false]);
    expectVerified(wild, short, 'wild, turns');

    // A refutation without a horizon cut-off below the line's horizon contradicts the line (a prover or caller bug), and
    // no horizon winning up to the current one means the same: the ranking keeps the line instead of throwing.
    const fail = (horizon: boolean, reasons: Partial<typeof NO_REASONS>): ProofResult => ({
      kind: 'fail', horizon, low: Number.POSITIVE_INFINITY, reasons: { ...NO_REASONS, ...reasons }, refutation: ['stub'], refuted: false,
    });
    const cases: [ProofResult, boolean, readonly RankKey[], number, string[]][] = [
      [fail(false, { engineLimit: true }), true, TURNS_FIRST, 1, ['a refutation met an engine limit', 'the turns step could not reproduce the line']],
      [fail(true, { horizon: true }), false, ['turns'], twoSafeLines.horizon, ['the turns step could not reproduce the line']],
    ];
    for (const [result, once, ranking, calls, stopped] of cases) {
      const p = proven(twoSafeLines);
      const spy = once ? vi.spyOn(Prover.prototype, 'prove').mockReturnValueOnce(result) : vi.spyOn(Prover.prototype, 'prove').mockReturnValue(result);
      try {
        const r = rank(p, { ranking });
        expect([spy.mock.calls.length, r.certificate === p.base.certificate, r.complete, r.vector, r.horizon, r.stopped]).toEqual([calls, true, false, BASE, 2, stopped]);
      } finally {
        spy.mockRestore();
      }
    }
  });
});
