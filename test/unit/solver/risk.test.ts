import { describe, expect, it, vi } from 'vitest';
import type { Choice, Engine, Rational } from '../../../src/contracts/engine.js';
import type { RankKey } from '../../../src/contracts/solver.js';
import type { Arena } from '../../../src/solver/arena.js';
import { rootBelief } from '../../../src/solver/belief.js';
import type { Certificate } from '../../../src/solver/certificate.js';
import { checkCertificate, type CheckResult } from '../../../src/solver/check/checker.js';
import { DEFAULT_RANKING } from '../../../src/solver/config.js';
import type { ArenaFight } from '../../../src/solver/inputs.js';
import { defaultLabeler } from '../../../src/solver/labeler.js';
import { Prover } from '../../../src/solver/prove.js';
import { cmp, ONE, rat } from '../../../src/solver/rational.js';
import { solveRisk, type RiskOptions, type RiskResult } from '../../../src/solver/risk.js';
import { createToyAi } from './toy/ai.js';
import { createToyEngine } from './toy/engine.js';
import { makeArena, scenarioFights, tableFights } from './toy/fixtures.js';
import type { ToyMon, ToyRegistry } from './toy/game.js';
import { toyOracles } from './toy/oracles.js';
import { randomToyFight } from './toy/random.js';
import { refCritBudget, refFightOf, refMinFailure, refTier1 } from './toy/referee.js';
import {
  critOnlyBudget0, critOnlyBudget1, deadlyRolls, playerMissKills, stall, unlabelledOnly, worldsSplit, type Scenario,
} from './toy/scenarios.js';
import { tableGame } from './toy/table.js';

type Line = Extract<RiskResult, { kind: 'line' }>;

const lead = (index: number): Choice => ({ kind: 'switch', index });
const move = (slot: number): Choice => ({ kind: 'move', slot });
const PROBABILITY_FIRST: readonly RankKey[] = ['critDeathProbability', 'critBudget', 'worstMinHp', 'totalHp', 'pp', 'chanceDependencies', 'turns'];
const bash = { name: 'Bash', damage: [3], critChance: rat(1, 4) };

/** One trainer `name` with one mon, the player's mons in team order, full information. */
function duel(name: string, p1: ToyMon[], foe: ToyMon, horizon: number): Scenario {
  const registry: ToyRegistry = { mons: Object.fromEntries(p1.map((m) => [m.name, m])), trainers: { [name]: { id: name, party: [foe] } }, observeAll: true };
  return { name, registry, p1: p1.map((m) => m.name), trainerId: name, horizon, expect: {} };
}

// Brute (faster) Bashes 3, or 6 on a crit. Glass (5 HP) leads with Big 8: safe only without crits, failure 1/4. Tank
// (16 HP) Taps four times and survives one crit (budget 1), failure P(at least 2 crits in 4) = 67/256. Budget first
// picks Tank; probability first picks Glass.
const twoLeads = duel('twoLeads', [
  { name: 'Glass', maxHp: 5, speed: 5, moves: [{ name: 'Big', damage: [8] }] },
  { name: 'Tank', maxHp: 16, speed: 5, moves: [{ name: 'Tap', damage: [2] }] },
], { name: 'Brute', maxHp: 8, speed: 10, moves: [bash] }, 4);

// Brute Bashes twice a turn, 2 a hit or 4 on a crit. One crit step, even both hits critting, is survived; two kill:
// budget 1 (counting crits per hit would give 2), failure 13/256.
const doubleHit = duel('doubleHit', [{ name: 'Hero', maxHp: 13, speed: 5, moves: [{ name: 'Strike', damage: [4] }] }],
  { name: 'Brute', maxHp: 8, speed: 10, moves: [{ name: 'Bash', damage: [2], hits: 2, critChance: rat(1, 4) }] }, 3);

// critOnlyBudget0's Hero with a second move, Wild (accuracy 1/2), whose turn has 3 or 4 engine leaves.
const critOrWild = duel('critOrWild', [{ name: 'Hero', maxHp: 7, speed: 5, moves: [{ name: 'Strike', damage: [4] }, { name: 'Wild', damage: [4], accuracy: rat(1, 2) }] }],
  { name: 'Brute', maxHp: 8, speed: 10, moves: [bash] }, 3);

/** `s` twice, the second fight after a heal. */
const twice = (s: Scenario): ArenaFight[] => [...scenarioFights(s), ...scenarioFights(s, { healBefore: true })];

function solveOn(arena: Arena, horizon: number, over: Partial<RiskOptions> = {}): RiskResult {
  return solveRisk(arena, rootBelief(arena), {
    horizon, ranking: DEFAULT_RANKING, mode: 'display', deadline: Number.POSITIVE_INFINITY, now: () => 0,
    labeler: defaultLabeler, history: new Map(), ...over,
  });
}

function arenaOf(s: Scenario, opts: { fights?: ArenaFight[]; maxLeaves?: number; engine?: Engine } = {}): Arena {
  return makeArena(opts.fights ?? scenarioFights(s), opts.engine ?? createToyEngine(s.registry), createToyAi(s.registry), { maxLeaves: opts.maxLeaves });
}

function risk(s: Scenario, over: Partial<RiskOptions> = {}, fights?: ArenaFight[]): RiskResult {
  return solveOn(arenaOf(s, { fights }), s.horizon, over);
}

function lineOf(r: RiskResult, what: string): Line {
  if (r.kind !== 'line') throw new Error(`${what}: expected a line, got ${r.kind}`);
  return r;
}

function check(s: Scenario, line: Line, opts: { fights?: ArenaFight[]; maxLeaves?: number; engine?: Engine } = {}): CheckResult {
  return checkCertificate({
    certificate: line.certificate, fights: opts.fights ?? scenarioFights(s), engine: opts.engine ?? createToyEngine(s.registry), enemyModel: createToyAi(s.registry),
    oracles: toyOracles(s.registry), labeler: defaultLabeler, killerLimit: 20, deadline: Number.POSITIVE_INFINITY, now: () => 0, maxLeaves: opts.maxLeaves,
  });
}

/** The checker passes the line's own walk; returns its figures. */
function checked(s: Scenario, line: Line, what: string, fights?: ArenaFight[]): CheckResult {
  const c = check(s, line, { fights });
  expect([c.passed, c.reason, c.mismatches, c.unmodelled], what).toEqual([true, undefined, [], []]);
  return c;
}

/** The action of the decision after the fight-0 lead (one world, so one edge). */
function afterLead(cert: Certificate): Choice {
  const next = Object.values(cert.nodes[0]!.edges);
  expect(next).toHaveLength(1);
  return cert.nodes[next[0]!]!.action;
}

interface Want { tier: 2 | 3; critBudget: number | null; failure: Rational; optimality?: string; first?: Choice; next?: Choice; certBudget?: number | null }

describe('risk', () => {
  it.each([
    ['crit-only, budget 0', critOnlyBudget0, {}, { tier: 2, critBudget: 0, failure: rat(7, 16), optimality: 'proven', certBudget: 0 }],
    ['crit-only, budget 1', critOnlyBudget1, {}, { tier: 2, critBudget: 1, failure: rat(1, 16), optimality: 'proven', certBudget: 1 }],
    ['deadly rolls: Gamble, as Strike first fails 3/4', deadlyRolls, {}, { tier: 3, critBudget: null, failure: rat(7, 16), optimality: 'proven', first: lead(0), next: move(1), certBudget: null }],
    ['a player miss that kills is tier 3, not tier 2', playerMissKills, {}, { tier: 3, critBudget: null, failure: rat(1, 4) }],
    ['budget first', twoLeads, {}, { tier: 2, critBudget: 1, failure: rat(67, 256), first: lead(1) }],
    ['probability first: the checker reports budget 0', twoLeads, { ranking: PROBABILITY_FIRST }, { tier: 2, critBudget: null, failure: rat(1, 4), optimality: 'proven', first: lead(0), certBudget: 0 }],
    ['neither tier-2 key ranked: budget first', twoLeads, { ranking: ['worstMinHp'] }, { tier: 2, critBudget: 1, failure: rat(67, 256) }],
    ['restricted to Tank, probability first', twoLeads, { ranking: PROBABILITY_FIRST, restrictRoot: [lead(1)] }, { tier: 2, critBudget: null, failure: rat(67, 256), first: lead(1) }],
    ['a crit step counts once', doubleHit, {}, { tier: 2, critBudget: 1, failure: rat(13, 256) }],
    ['a cut-off counts as failure', stall, {}, { tier: 3, critBudget: null, failure: ONE, optimality: 'proven' }],
    ['an unlabelled outcome counts as failure', unlabelledOnly, {}, { tier: 3, critBudget: null, failure: ONE }],
    // One first move for both worlds, each weighted 1/2; with two distinct worlds the line is not called optimal.
    ['worlds give bestFoundWithinBudget', worldsSplit, {}, { tier: 3, critBudget: null, failure: rat(1, 2), optimality: 'bestFoundWithinBudget' }],
  ] as [string, Scenario, Partial<RiskOptions>, Want][])('%s', (what, s, over, want) => {
    const r = lineOf(risk(s, over), what);
    expect(r).toMatchObject({ tier: want.tier, critBudget: want.critBudget, failure: want.failure, certificate: { kind: 'risk' }, ...(want.optimality === undefined ? {} : { optimality: want.optimality }) });
    if (want.first !== undefined) expect(r.certificate.nodes[0]!.action).toEqual(want.first);
    if (want.next !== undefined) expect(afterLead(r.certificate)).toEqual(want.next);
    if (want.certBudget !== undefined) expect(r.certificate.critBudget).toBe(want.certBudget);
    if (s === unlabelledOnly) return;
    // The checker agrees, except that it plays the worlds adversarially: the worse world fails for sure.
    const c = checked(s, r, what);
    expect(c.failureAi).toEqual(s === worldsSplit ? ONE : r.failure);
    const budget = want.certBudget ?? want.critBudget;
    if (want.tier === 2 && budget !== null) expect(c.critBudget).toBe(budget);
    if (s === stall) expect(c.cutoffAi).toEqual(ONE);
  });

  it('gauntlets count each fight afresh', () => {
    // deadlyRolls twice: 1 − (9/16)². critOnlyBudget1 twice: one crit per fight is survived, two in one fight kill.
    for (const [s, failure, critBudget] of [[deadlyRolls, rat(175, 256), null], [critOnlyBudget1, rat(31, 256), 1]] as const) {
      const what = `${s.name} twice`;
      const r = lineOf(risk(s, {}, twice(s)), what);
      expect([r.tier, r.critBudget, r.failure, r.optimality, r.certificate.fights], what).toEqual([critBudget === null ? 3 : 2, critBudget, failure, 'proven', 2]);
      const c = checked(s, r, what, twice(s));
      expect([c.failureAi, c.critBudget], what).toEqual([failure, critBudget ?? -1]);
    }
  });

  it('timeout or cancel gives unknown, or the best so far', () => {
    expect(risk(deadlyRolls, { deadline: -1 })).toEqual({ kind: 'unknown', cause: 'timeout' });
    expect(risk(deadlyRolls, { signal: AbortSignal.abort() })).toEqual({ kind: 'unknown', cause: 'aborted' });

    // A clock that passes the deadline after k readings, for every k: unknown until Glass's line is complete, then
    // Glass's line as the best so far, then the finished result.
    const opts = { ranking: PROBABILITY_FIRST };
    const full = lineOf(risk(twoLeads, opts), 'full');
    let readings = 0;
    risk(twoLeads, { ...opts, now: () => {
      readings += 1;
      return 0;
    } });
    const seen = new Set<string>();
    for (let k = 0; k <= readings; k++) {
      let read = 0;
      const r = risk(twoLeads, { ...opts, deadline: 0, now: () => (read++ < k ? 0 : 1) });
      seen.add(r.kind === 'unknown' ? r.cause : r.optimality);
      if (r.kind === 'line' && r.optimality === 'proven') expect(r, `k ${k}`).toEqual(full);
      else if (r.kind === 'line') expect([cmp(r.failure, full.failure) >= 0, checked(twoLeads, r, `k ${k}`).failureAi], `k ${k}`).toEqual([true, r.failure]);
    }
    expect(seen).toEqual(new Set(['timeout', 'bestFoundWithinBudget', 'proven']));
  });

  it('a deadline while deepening G_{j+1} keeps the proven G_j', () => {
    // The crit-budget loop after G_0 gets at most half the time left (500 of 1,000). A clock passing that as G_{j+1}'s
    // deepening starts leaves G_j's least failure, only the best found.
    const real = Prover.prototype.deepen;
    for (const j of [0, 1]) {
      let clock = 0;
      const spy = vi.spyOn(Prover.prototype, 'deepen').mockImplementation(function deepen(this: Prover, root, maxH) {
        if (this.params.critBudget === j + 1) clock = 600;
        return real.call(this, root, maxH);
      });
      try {
        const what = `G_${j + 1} cut`;
        const r = lineOf(risk(critOnlyBudget1, { deadline: 1_000, now: () => clock }), what);
        expect([r.tier, r.critBudget, r.optimality, r.complete, r.certificate.critBudget], what).toEqual([2, j, 'bestFoundWithinBudget', false, j]);
        expect(checked(critOnlyBudget1, r, what).critBudget, what).toBeGreaterThanOrEqual(j);
      } finally {
        spy.mockRestore();
      }
    }
    expect(lineOf(risk(critOnlyBudget1, { deadline: 1_000, now: () => 0 }), 'uncut')).toMatchObject({ critBudget: 1, optimality: 'proven', complete: true });
  });

  it('a turnless loop counts as failure', () => {
    // M is a mid-turn switch: 'back' returns to M with no turn taken, 'on' wins or dies half the time. M met again while
    // being evaluated fails, so the recursion ends; values through such a cut are upper bounds, so only the best found.
    const t = tableGame({
      start: 'T',
      nodes: {
        T: { phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to: 'M', p: ONE }] } },
        M: {
          phase: 'playerMidTurnSwitch', p1: ['back', 'on'],
          next: { 'back|': [{ to: 'M', p: ONE }], 'on|': [{ to: 'win', p: rat(1, 2) }, { to: 'dead', p: rat(1, 2), faintP1: true }] },
        },
        win: { phase: 'win', next: {} }, dead: { phase: 'lose', next: {} },
      },
    });
    const r = lineOf(solveOn(makeArena(tableFights(t), t.engine, t.ai), 3), 'loop');
    expect([r.tier, r.failure, r.optimality, r.certificate.nodes.map((n) => n.action)]).toEqual([3, rat(1, 2), 'bestFoundWithinBudget', [lead(0), move(0), move(1)]]);
  });

  it('engine limits keep optimality open', () => {
    // deadlyRolls with at most 2 leaves a step: Gamble is skipped wherever Hero can still use it, so the Strike line
    // comes out (the checker agrees under the same limit), but a skipped choice might have done better.
    const skipped = lineOf(solveOn(arenaOf(deadlyRolls, { maxLeaves: 2 }), deadlyRolls.horizon), 'deadlyRolls, 2 leaves');
    expect([skipped.tier, skipped.failure, skipped.optimality, afterLead(skipped.certificate)]).toEqual([3, rat(3, 4), 'bestFoundWithinBudget', move(0)]);
    const sc = check(deadlyRolls, skipped, { maxLeaves: 2 });
    expect([sc.passed, sc.mismatches, sc.failureAi]).toEqual([true, [], rat(3, 4)]);

    // Under G_j a limited choice fails its safety proof and is dropped the same way; without the limit it is proven.
    const unsafe = lineOf(solveOn(arenaOf(critOrWild, { maxLeaves: 2 }), critOrWild.horizon), 'critOrWild, 2 leaves');
    expect([unsafe.tier, unsafe.critBudget, unsafe.failure, unsafe.optimality]).toEqual([2, 0, rat(7, 16), 'bestFoundWithinBudget']);
    expect(check(critOrWild, unsafe, { maxLeaves: 2 }).failureAi).toEqual(rat(7, 16));
    expect(lineOf(risk(critOrWild), 'critOrWild')).toMatchObject({ critBudget: 0, failure: rat(7, 16), optimality: 'proven' });

    // A limit on every turn choice (1 leaf), or at battle start: the line keeps the first choice at failure ONE, and the
    // checker meets the same limit and does not pass.
    const toy = createToyEngine(deadlyRolls.registry);
    const noStart: Engine = { ...toy, createBattle: () => { throw Object.assign(new Error('toy: limit at battle start'), { code: 'LIMIT' }); } };
    const limited = lineOf(solveOn(arenaOf(deadlyRolls, { maxLeaves: 1 }), deadlyRolls.horizon), 'every turn limited');
    expect([limited.tier, limited.failure, afterLead(limited.certificate)]).toEqual([3, ONE, move(0)]);
    const rootLimited = lineOf(solveOn(arenaOf(deadlyRolls, { engine: noStart }), deadlyRolls.horizon), 'battle start limited');
    expect([rootLimited.tier, rootLimited.failure, rootLimited.optimality, rootLimited.certificate.nodes]).toEqual([
      3, ONE, 'bestFoundWithinBudget', [{ id: 0, phase: 'entry', fight: 0, observation: '', action: lead(0), edges: {} }],
    ]);
    for (const c of [check(deadlyRolls, limited, { maxLeaves: 1 }), check(deadlyRolls, rootLimited, { maxLeaves: 20_000, engine: noStart })]) {
      expect([c.passed, c.reason, c.mismatches, c.failureAi]).toEqual([false, 'engineLimit', [], ONE]);
    }
  });

  it('agrees with the referee on 60 seeded fights', () => {
    const tiers = { 2: 0, 3: 0 };
    for (let seed = 1; seed <= 60; seed++) {
      const fight = randomToyFight(seed);
      const ref = refFightOf(fight);
      if (refTier1(ref)) continue;
      const budget = refCritBudget(ref)!;
      const least = refMinFailure(ref);
      const s: Scenario = { ...fight, name: fight.trainerId, expect: {} };
      // observeAll: display mode is full information, so it and ram mode must both match the referee.
      for (const mode of ['display', 'ram'] as const) {
        const what = `seed ${seed} ${mode}`;
        const r = lineOf(risk(s, { mode }), what);
        expect([r.tier, r.optimality], what).toEqual([budget >= 0 ? 2 : 3, 'proven']);
        // Tier 2 is a constrained least, never below the free one.
        if (r.tier === 3) expect(r.failure, what).toEqual(least);
        else expect([r.critBudget, cmp(r.failure, least) >= 0], what).toEqual([budget, true]);
        const c = checked(s, r, what);
        expect(c.failureAi, what).toEqual(r.failure);
        if (r.tier === 2) expect(c.critBudget, what).toBe(budget);
        if (mode === 'display') tiers[r.tier] += 1;
      }
    }
    expect(tiers).toEqual({ 2: 7, 3: 29 });   // the generator's counts
  }, 60_000);
});
