import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BattleInput, Choice, Engine, EngineState, Rational } from '../../../src/contracts/engine.js';
import { rootBelief } from '../../../src/solver/belief.js';
import { certificateFromPolicy, extractProof, type Certificate } from '../../../src/solver/certificate.js';
import { checkCertificate, type CheckInput, type CheckResult } from '../../../src/solver/check/checker.js';
import { edgeLabel } from '../../../src/solver/edge.js';
import type { ArenaFight } from '../../../src/solver/inputs.js';
import { defaultLabeler } from '../../../src/solver/labeler.js';
import { Prover } from '../../../src/solver/prove.js';
import { ONE, rat, ZERO } from '../../../src/solver/rational.js';
import type { GameParams, ObservationMode, OracleResult } from '../../../src/solver/types.js';
import { createToyAi } from './toy/ai.js';
import { createToyEngine } from './toy/engine.js';
import { makeArena, scenarioFights, tableFights } from './toy/fixtures.js';
import type { ToyMon, ToyRegistry } from './toy/game.js';
import { toyOracles } from './toy/oracles.js';
import {
  aiDivZero, aiUndefined, critOnlyBudget0, critOnlyBudget1, deadlyRolls, hiddenCounterSafe, level2Gap, mystery, safe1v1, stall, unlabelledOnly,
  uturnLine, worldsSplit, type Scenario,
} from './toy/scenarios.js';
import { tableGame } from './toy/table.js';

const lead = (index: number): Choice => ({ kind: 'switch', index });
const move = (slot: number): Choice => ({ kind: 'move', slot });
const oracle = (id: string, result: OracleResult) => ({ id, check: (): OracleResult => result });
const NONE = oracle('none', { checks: 0, mismatches: [] });
type TableGame = ReturnType<typeof tableGame>;

/** The scenario proven by a fresh prover deepened to its horizon (it must win), as a proof certificate. */
function proofOf(s: Scenario, opts: { params?: Partial<GameParams>; mode?: ObservationMode; fights?: ArenaFight[]; engine?: Engine } = {}): Certificate {
  const arena = makeArena(opts.fights ?? scenarioFights(s), opts.engine ?? createToyEngine(s.registry), createToyAi(s.registry));
  const params = { level: 1 as const, critBudget: null, thresholds: null, ...opts.params };
  const prover = new Prover(arena, { params, mode: opts.mode ?? 'display', deadline: Number.POSITIVE_INFINITY, now: () => 0, labeler: defaultLabeler, history: new Map() });
  const root = rootBelief(arena);
  const { result, horizon } = prover.deepen(root, s.horizon);
  expect(result.kind, s.name).toBe('win');
  return extractProof(prover, root, horizon);
}

/** `s`'s proof with node `id` changed. */
function withNode(s: Scenario, id: number, change: Partial<Certificate['nodes'][number]>): Certificate {
  const cert = proofOf(s);
  return { ...cert, nodes: cert.nodes.map((n) => (n.id === id ? { ...n, ...change } : n)) };
}

/** A risk line that leads with party 0, then always uses move `slot`. */
function lineOf(s: Scenario, slot: number, horizon = s.horizon): Certificate {
  const arena = makeArena(scenarioFights(s), createToyEngine(s.registry), createToyAi(s.registry));
  return certificateFromPolicy(arena, rootBelief(arena), (b) => (b.phase === 'entry' ? lead(0) : move(slot)), { level: 1, mode: 'display', horizon, critBudget: null });
}

const BASE = { labeler: defaultLabeler, killerLimit: 20, deadline: Number.POSITIVE_INFINITY, now: () => 0 };
const check = (s: Scenario, certificate: Certificate, over: Partial<CheckInput> = {}): CheckResult => checkCertificate({
  certificate, fights: scenarioFights(s), engine: createToyEngine(s.registry), enemyModel: createToyAi(s.registry), oracles: toyOracles(s.registry), ...BASE, ...over,
});
const checkTable = (t: TableGame, certificate: Certificate, over: Partial<CheckInput> = {}): CheckResult => checkCertificate({
  certificate, fights: tableFights(t), engine: t.engine, enemyModel: t.ai, oracles: { damage: NONE, speed: NONE }, ...BASE, ...over,
});

const handCert = (t: TableGame, nodes: Certificate['nodes']): Certificate => ({
  kind: 'proof', level: 1, mode: 'display', horizon: 3, critBudget: null, thresholds: null, engineId: t.engine.id, aiId: t.ai.id, fights: 1, nodes,
});

/** M is a mid-turn switch (no turn taken) whose 'back' returns to M's exact bytes; the certificate's node 1 loops on it. */
function checkLoop(wrap: (e: Engine) => Engine = (e) => e): CheckResult {
  const t = tableGame({ start: 'M', nodes: { M: { phase: 'playerMidTurnSwitch', p1: ['back'], next: { 'back|': [{ to: 'M', p: ONE }] } } } });
  const atM = edgeLabel(['M'], 'playerMidTurnSwitch');
  const cert = handCert(t, [
    { id: 0, phase: 'entry', fight: 0, observation: '', action: lead(0), edges: { [atM]: 1 } },
    { id: 1, phase: 'playerMidTurnSwitch', fight: 0, observation: atM, action: move(0), edges: { [atM]: 1 } },
  ]);
  let calls = 0;   // without the cycle rule only this deadline would end the walk
  return checkTable(t, cert, { engine: wrap(t.engine), deadline: 100, now: () => calls++ });
}
const CYCLE = { passed: false, reason: 'verificationMismatch', failureAi: ONE, mismatches: [expect.stringMatching(/^cycle: node 1 meets an exact state again on its own path/)] };

function expectPass(r: CheckResult, what: string): void {
  expect({ mismatches: r.mismatches, unmodelled: r.unmodelled, passed: r.passed, reason: r.reason }, what).toEqual({ mismatches: [], unmodelled: [], passed: true, reason: undefined });
  expect(Math.min(r.damageChecks, r.orderChecks), what).toBeGreaterThan(0);
}

/** One p1 mon against a one-mon trainer named `name`, full information. */
function duel(name: string, hero: ToyMon, foe: ToyMon, horizon: number): Scenario {
  const registry: ToyRegistry = { mons: { [hero.name]: hero }, trainers: { [name]: { id: name, party: [foe] } }, observeAll: true };
  return { name, registry, p1: [hero.name], trainerId: name, horizon, expect: {} };
}

// Twin (faster) picks Poke 1 or Blast 10 with 1/2 each; Strike KOs Twin, Blast kills Hero first.
const aiTie = duel('aiTie',
  { name: 'Hero', maxHp: 10, speed: 5, moves: [{ name: 'Strike', damage: [5] }] },
  { name: 'Twin', maxHp: 5, speed: 10, moves: [{ name: 'Poke', damage: [1], aiScore: 1 }, { name: 'Blast', damage: [10], aiScore: 1 }] }, 2);

// Hero (3 HP, faster) KOs Imp with Strike; after Splash, Scratch 3 kills Hero.
const splash = duel('splash',
  { name: 'Hero', maxHp: 3, speed: 10, moves: [{ name: 'Strike', damage: [5] }, { name: 'Splash', damage: [] }] },
  { name: 'Imp', maxHp: 5, speed: 5, moves: [{ name: 'Scratch', damage: [3] }] }, 2);

const CLEAN = { worlds: 1, failureAi: ZERO, failureWorst: ZERO, cutoffAi: ZERO, critBudget: null, killers: [], endStates: [] };
const twice = (): ArenaFight[] => [...scenarioFights(safe1v1), ...scenarioFights(safe1v1)];

describe('checker', () => {
  it.each<[string, () => CheckResult, object]>([
    ['safe1v1', () => check(safe1v1, proofOf(safe1v1)), CLEAN],
    // Hero wakes on turn 2 (8 HP) or 3 (6 HP); Scout ends 6/6 and Tank 6/20.
    ['hiddenCounterSafe', () => check(hiddenCounterSafe, proofOf(hiddenCounterSafe)), { ...CLEAN, worstEnd: { minHpFrac: rat(3, 5), totalHp: 6, pp: 9 }, maxTurns: 3 }],
    ['uturnLine', () => check(uturnLine, proofOf(uturnLine)), { ...CLEAN, worstEnd: { minHpFrac: rat(3, 10), totalHp: 12, pp: 18 }, maxTurns: 2 }],
    ['worldsSplit in RAM mode (one first move per world)', () => check(worldsSplit, proofOf(worldsSplit, { mode: 'ram' })), { worlds: 2 }],
    // G_j proofs have no nodes past j enemy crits; the walk stops there too.
    ['critOnlyBudget0 as G_0', () => check(critOnlyBudget0, proofOf(critOnlyBudget0, { params: { critBudget: 0 } })), { critBudget: null }],
    ['critOnlyBudget1 as G_1', () => check(critOnlyBudget1, proofOf(critOnlyBudget1, { params: { critBudget: 1 } })), { critBudget: null }],
    ['safe1v1 at level 2 (Imp has one move)', () => check(safe1v1, { ...proofOf(safe1v1), level: 2 }), {}],
    ['level2Gap at level 1', () => check(level2Gap, proofOf(level2Gap)), {}],
    ['splash', () => check(splash, proofOf(splash)), {}],
    ['safe1v1 with PP >= 9', () => check(safe1v1, { ...proofOf(safe1v1), thresholds: { pp: { value: 9, strict: false } } }), {}],
    ['a gauntlet, safe1v1 twice', () => check(safe1v1, proofOf(safe1v1, { fights: twice() }), { fights: twice() }), {
      endStates: [{ fight: 1, carry: { mons: [{ hp: 10, pp: [9], status: { kind: 'none' } }] } }], worstEnd: { minHpFrac: ONE, totalHp: 10, pp: 8 }, maxTurns: 1,
    }],
  ])('%s: a proof passes', (name, run, want) => {
    const r = run();
    expectPass(r, name);
    expect(r).toMatchObject(want);
  });

  it.each<[string, () => CheckResult, object, [string, Rational][]?]>([
    // Gamble wins 9/16; Bash kills on turn 2 after a miss (3/8) or on turn 3 (1/16).
    ['deadlyRolls, Gamble', () => check(deadlyRolls, lineOf(deadlyRolls, 1)), {
      passed: true, failureAi: rat(7, 16), failureWorst: rat(7, 16), cutoffAi: ZERO, critBudget: -1, maxTurns: 3, worstEnd: { minHpFrac: rat(1, 7), totalHp: 1, pp: 18 },
      killers: [{ path: expect.arrayContaining(['Lead with Hero', 'Use move 2']) }, {}],
    }, [['bash on turn 2 kills party 0', rat(3, 8)], ['bash on turn 3 kills party 0', rat(1, 16)]]],
    ['deadlyRolls, Gamble, one killer listed', () => check(deadlyRolls, lineOf(deadlyRolls, 1), { killerLimit: 1 }), {}, [['bash on turn 2 kills party 0', rat(3, 8)]]],
    ['deadlyRolls, Gamble within 2 turns (the turn-3 death is cut off)', () => check(deadlyRolls, lineOf(deadlyRolls, 1, 2)),
      { passed: true, failureAi: rat(7, 16), cutoffAi: rat(1, 16), maxTurns: 2 }, [['bash on turn 2 kills party 0', rat(3, 8)]]],
    ['critOnlyBudget1, Strike (two crit steps: budget 1)', () => check(critOnlyBudget1, lineOf(critOnlyBudget1, 0)),
      { passed: true, failureAi: rat(1, 16), failureWorst: rat(1, 16), cutoffAi: ZERO, critBudget: 1 }, [['enemy crit bash on turn 2 kills party 0', rat(1, 16)]]],
    ['critOnlyBudget0, Strike', () => check(critOnlyBudget0, lineOf(critOnlyBudget0, 0)), { failureAi: rat(7, 16), critBudget: 0 }],
    // Quick KOs world 0's Gremlin first; world 1's survives and Blast kills Hero. Worlds are adversarial.
    ['worldsSplit, Quick', () => check(worldsSplit, lineOf(worldsSplit, 0)),
      { passed: true, worlds: 2, failureAi: ONE, failureWorst: ONE, cutoffAi: ZERO, critBudget: -1, worstEnd: { minHpFrac: ONE, totalHp: 10, pp: 19 } },
      [['damage on turn 1 kills party 0', ONE]]],
    ['stall, Glare (every path cut off)', () => check(stall, lineOf(stall, 0)),
      { passed: true, failureAi: ONE, failureWorst: ONE, cutoffAi: ONE, critBudget: -1, worstEnd: null }, []],
    ['aiTie (the worst case differs from the distribution)', () => check(aiTie, lineOf(aiTie, 0)),
      { passed: true, failureAi: rat(1, 2), failureWorst: ONE, cutoffAi: ZERO }, [['damage on turn 1 kills party 0', rat(1, 2)]]],
  ])('%s: exact figures for a fixed line', (_name, run, want, killers) => {
    const r = run();
    expect(r.mismatches).toEqual([]);
    expect(r).toMatchObject(want);
    if (killers !== undefined) expect(r.killers.map((k) => [k.cause, k.probability])).toEqual(killers);
  });

  const engine = createToyEngine(hiddenCounterSafe.registry);
  const dropping: Engine = { ...engine, expandTurn: (state, choices, opts) => {
    const out = engine.expandTurn(state, choices, opts);
    return out.length > 1 ? out.slice(1) : out;
  } };
  const bugged: Scenario = { ...hiddenCounterSafe, registry: { ...hiddenCounterSafe.registry, bugDamagePlusOne: true } };
  const safeAi = createToyAi(safe1v1.registry);
  it.each<[string, () => CheckResult, RegExp, 'some' | 'every', object?]>([
    ['a tampered losing action', () => check(splash, withNode(splash, 1, { action: move(1) })), /death/, 'some', { failureAi: ONE }],
    ['an illegal action', () => check(splash, withNode(splash, 1, { action: move(5) })), /illegal action/, 'some'],
    ['a level-1 proof relabelled level 2 (the AI never picks Blast)', () => check(level2Gap, { ...proofOf(level2Gap), level: 2 }), /death/, 'some'],
    // A proof in the bugged model: only the damage oracle can tell.
    ['a planted engine bug', () => check(bugged, proofOf(bugged)), /^damage oracle toy-damage@1: Bonk by p2 took 3 HP from Hero, expected 2/, 'every'],
    ['outcomes that do not sum to one', () => check(hiddenCounterSafe, proofOf(hiddenCounterSafe), { engine: dropping }), /^outcomes sum to 1\/2/, 'some'],
    ['a zero-probability AI choice', () => check(safe1v1, proofOf(safe1v1), {
      enemyModel: { ...safeAi, support: (state, memory) => [...safeAi.support(state, memory), { choice: move(0), probability: ZERO }] },
    }), /^enemy turn support: probability 0\/1/, 'some'],
    ['an AI support summing to 3/4', () => check(safe1v1, proofOf(safe1v1), {
      enemyModel: { ...safeAi, support: () => [{ choice: move(0), probability: rat(1, 2) }, { choice: move(0), probability: rat(1, 4) }] },
    }), /^enemy turn support sums to 3\/4, not 1 \(path: /, 'every'],
    ['a win leaf below the thresholds', () => check(safe1v1, { ...proofOf(safe1v1), thresholds: { pp: { value: 9, strict: true } } }),
      /^threshold: PP 9, needs > 9 \(path: /, 'every'],
    // Both sleep counters look alike after Doze; the turn-1 node loses its only edge.
    ['a missing edge', () => check(hiddenCounterSafe, withNode(hiddenCounterSafe, 1, { edges: {} })), /^no policy for observation /, 'every', { failureAi: ONE }],
    // The counter-3 path (1/2) needs 3 turns.
    ['a cut-off in a proof', () => check(hiddenCounterSafe, { ...proofOf(hiddenCounterSafe), horizon: 2 }),
      /^horizon: not won within 2 turns \(path: /, 'every', { failureAi: rat(1, 2), cutoffAi: rat(1, 2) }],
    ['a lead beyond the team', () => check(uturnLine, withNode(uturnLine, 0, { action: lead(2) })),
      /^illegal action \{"index":2,"kind":"switch"\} at node 0: not a living lead/, 'every', { failureAi: ONE }],
    ['a lead that fainted before the fight', () => {
      const [fight] = scenarioFights(uturnLine);
      const fainted = [{ ...fight!, team: fight!.team.map((m, i) => (i === 0 ? { ...m, mon: { ...m.mon, currentHp: 0 } } : m)) }];
      return check(uturnLine, proofOf(uturnLine), { fights: fainted });
    }, /^illegal action \{"index":0,"kind":"switch"\} at node 0: not a living lead/, 'every'],
    ['an action the engine rejects', () => check(safe1v1, proofOf(safe1v1), { enemyModel: { ...safeAi, support: () => [{ choice: move(3), probability: ONE }] } }),
      /^engine rejected choice p1 m0, p2 m3: toy engine: p2 choice /, 'every', { failureAi: ONE }],
  ])('%s is a verification mismatch', (_name, run, pattern, how, want = {}) => {
    const r = run();
    expect(r).toMatchObject({ passed: false, reason: 'verificationMismatch', ...want });
    expect(r.mismatches.length).toBeGreaterThan(0);
    expect(how === 'every' ? r.mismatches.every((m) => pattern.test(m)) : r.mismatches.some((m) => pattern.test(m))).toBe(true);
  });

  it.each<[string, () => CheckResult, string[]]>([
    ['an unmodelled item', () => check(mystery, proofOf(mystery)), ['item mystery (Hero)']],
    ['an unlabelled outcome', () => check(unlabelledOnly, lineOf(unlabelledOnly, 0)), ['unlabelled outcome in fight 1 on turn 1']],
    ['undefined AI behaviour', () => check(aiUndefined, lineOf(aiUndefined, 0)), ['undefined AI behaviour: UNDEFINED: toy: undefined behaviour']],
    ['any AI error code', () => check(aiDivZero, lineOf(aiDivZero, 0)), ['undefined AI behaviour: DIV_ZERO: toy: undefined behaviour']],
  ])('%s is reported as unmodelled', (_name, run, unmodelled) => {
    expect(run()).toMatchObject({ passed: false, reason: 'unmodelled', mismatches: [], unmodelled });
  });

  it('an AI error without a string code is a bug and propagates', () => {
    for (const error of [new Error('boom'), Object.assign(new Error('numbered'), { code: 7 })]) {
      expect(() => check(safe1v1, proofOf(safe1v1), { enemyModel: { ...safeAi, support: () => { throw error; } } })).toThrow(error);
    }
  });

  it('sums the hits the damage oracle did not cross-check, once per visited step', () => {
    // Bonk hits 3 times over the walk, Strike twice: an oracle skipping Bonk names its 3 hits and checks only Strike's.
    const cert = proofOf(hiddenCounterSafe);
    const skipBonk = { oracles: toyOracles(hiddenCounterSafe.registry, { skip: ['Bonk'] }) };
    const plain = check(hiddenCounterSafe, cert);
    const skipping = check(hiddenCounterSafe, cert, skipBonk);
    expectPass(skipping, 'skipping Bonk');
    expect([plain.notCrossChecked, skipping.notCrossChecked, plain.damageChecks, skipping.damageChecks]).toEqual([{}, { Bonk: 3 }, 5, 2]);
    expect(check(hiddenCounterSafe, cert, { ...skipBonk, deadline: 0, now: () => 1 }).notCrossChecked).toEqual({});   // a walk cut short claims nothing
  });

  it('memo is by full state bytes', () => {
    const same = (state: EngineState): EngineState => ({ ...state, key: 'same' });
    const colliding: Engine = { ...engine, createBattle: (input) => same(engine.createBattle(input)),
      expandTurn: (state, choices, opts) => engine.expandTurn(state, choices, opts).map((o) => ({ ...o, state: same(o.state) })) };
    const cert = proofOf(hiddenCounterSafe);
    const r = check(hiddenCounterSafe, cert, { engine: colliding });
    expectPass(r, 'colliding keys');
    // The entry, turn 1, both sleep counters after Doze (one node, two states), the counter still asleep on turn 3.
    expect([r.statesVisited, check(hiddenCounterSafe, cert).statesVisited]).toEqual([5, 5]);
  });

  it('timeouts and engine limits never pass', () => {
    const cert = proofOf(hiddenCounterSafe);
    expect(check(hiddenCounterSafe, cert, { deadline: 0, now: () => 1 }))
      .toMatchObject({ passed: false, reason: 'timeout', failureAi: ONE, critBudget: -1, worstEnd: null, statesVisited: 0 });
    expect(check(hiddenCounterSafe, cert, { signal: AbortSignal.abort() }).reason).toBe('timeout');
    // Doze's turn has two leaves: the engine throws LIMIT there and that path counts as failing.
    expect(check(hiddenCounterSafe, cert, { maxLeaves: 1 })).toMatchObject({ passed: false, reason: 'engineLimit', mismatches: [], failureAi: ONE });
  });

  it('a policy that loops back is a cycle, even when a wall-clock |t:| line changes the state bytes', () => {
    // The real engine's state JSON held Showdown's `|t:|<seconds>` line; `clocked` stamps one on every state it returns.
    const clocked = (inner: Engine, stamp: () => number): Engine => {
      const out = (s: EngineState): EngineState => ({ ...s, json: `{"log":["|t:|${stamp()}"],${s.json.slice(1)}` });
      const back = (s: EngineState): EngineState => ({ ...s, json: s.json.replace(/^\{"log":\["\|t:\|\d*"\],/, '{') });
      return {
        ...inner, createBattle: (input) => out(inner.createBattle(input)), legalChoices: (s, side) => inner.legalChoices(back(s), side),
        expandTurn: (s, choices, opts) => inner.expandTurn(back(s), choices, opts).map((o) => ({ ...o, state: out(o.state) })),
        observe: (s) => inner.observe(back(s)), carryOut: (s) => inner.carryOut(back(s)), unmodelledIn: (s) => inner.unmodelledIn(back(s)),
      };
    };
    let tick = 1_762_650_000;
    expect(checkLoop()).toMatchObject(CYCLE);
    expect(checkLoop((e) => clocked(e, () => tick++))).toMatchObject(CYCLE);

    // The AI picks a or b; both reach X behind one observation, so the second visit of X is a memo hit, clock or not.
    const t = tableGame({ start: 'S', nodes: {
      S: { phase: 'turnChoice', p1: ['go'], ai: [{ name: 'a', p: rat(1, 2) }, { name: 'b', p: rat(1, 2) }], next: { 'go|a': [{ to: 'X', p: ONE }], 'go|b': [{ to: 'X', p: ONE }] } },
      X: { phase: 'turnChoice', p1: ['hit'], next: { 'hit|': [{ to: 'W', p: ONE }] } }, W: { phase: 'win', next: {} },
    } });
    const [atS, atX] = [edgeLabel(['S'], 'turnChoice'), edgeLabel(['X'], 'turnChoice')];
    const cert = handCert(t, [
      { id: 0, phase: 'entry', fight: 0, observation: '', action: lead(0), edges: { [atS]: 1 } },
      { id: 1, phase: 'turnChoice', fight: 0, observation: atS, action: move(0), edges: { [atX]: 2 } },
      { id: 2, phase: 'turnChoice', fight: 0, observation: atX, action: move(0), edges: {} },
    ]);
    const one = oracle('one', { checks: 1, mismatches: [] });
    for (const [what, e] of [['no clock', t.engine], ['ticking', clocked(t.engine, () => tick++)], ['frozen', clocked(t.engine, () => 1_762_660_000)]] as const) {
      const r = checkTable(t, cert, { engine: e, oracles: { damage: one, speed: one } });
      expectPass(r, what);
      expect([r.damageChecks, r.orderChecks, r.statesVisited], what).toEqual([3, 3, 3]);   // S's two steps and X's one
    }
    // A skipped hit counts like a damage check: X's memo hit adds none.
    const skipping = oracle('skip', { checks: 0, mismatches: [], skipped: { Counter: 1 } });
    expect(checkTable(t, cert, { oracles: { damage: skipping, speed: one } }).notCrossChecked).toEqual({ Counter: 3 });
  });

  it('a RAM gauntlet passes across the fight entry, and a heal is an explicit healed carry', () => {
    // An engine whose carryOut lists keys unsorted pins the checker's canonical JSON of the carry to the arena's.
    const toy = createToyEngine(safe1v1.registry);
    const unsorted: Engine = { ...toy, carryOut: (state) => ({ mons: toy.carryOut(state).mons.map((m) => ({ status: m.status, pp: m.pp, hp: m.hp })) }) };
    const healed = [...scenarioFights(safe1v1), ...scenarioFights(safe1v1, { healBefore: true })];
    for (const [what, fights, pp] of [['carried', twice(), 9], ['healed', healed, 10]] as const) {
      const cert = proofOf(safe1v1, { mode: 'ram', fights, engine: unsorted });
      expect([cert.mode, cert.fights], what).toEqual(['ram', 2]);
      const r = check(safe1v1, cert, { fights, engine: unsorted });
      expectPass(r, what);
      expect(r.endStates, what).toEqual([{ fight: 1, carry: { mons: [{ hp: 10, pp: [pp], status: { kind: 'none' } }] } }]);
    }
    // Hero is burned at 4/10 with 2 Strike PP in the save and both fights start healed: no battle is built from no carry.
    const built: BattleInput[] = [];
    const spy: Engine = {
      ...toy,
      createBattle: (input) => {
        built.push(input);
        return toy.createBattle(input);
      },
    };
    const [heal] = scenarioFights(safe1v1, { healBefore: true });
    const worn = { ...heal!, team: heal!.team.map((m) => ({ ...m, status: { kind: 'burn' } as const, mon: { ...m.mon, currentHp: 4, pp: [2], status: { kind: 'burn' } as const } })) };
    const h = check(safe1v1, proofOf(safe1v1, { fights: [worn, worn] }), { fights: [worn, worn], engine: spy });
    expectPass(h, 'both fights healed');
    const healedCarry = { mons: [{ hp: 10, pp: [10], status: { kind: 'none' } }] };
    expect([built.map((input) => input.carry), h.endStates]).toEqual([[healedCarry, healedCarry], [{ fight: 1, carry: healedCarry }]]);
  });

  it('the checker imports nothing from the search', () => {
    const source = readFileSync(new URL('../../../src/solver/check/checker.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(|^import\s+['"]/m);   // no dynamic or side-effect imports
    const statements = [...source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)];
    expect(statements.length).toBeGreaterThan(0);
    for (const [text, spec] of statements) {
      expect(spec, text).toMatch(/^(?:\.\.\/\.\.\/contracts\/[a-z]+\.js|\.\.\/(?:rational|types|edge|inputs|certificate)\.js|node:crypto)$/);
      if (spec === '../certificate.js') expect(text, 'the certificate import is type-only').toMatch(/^import\s+type\s/);
    }
  });
});
