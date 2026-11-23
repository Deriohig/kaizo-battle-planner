// The store of engine and AI answers (src/solver/store.ts), read by the arena and the checker, and the checker's two
// guards (checkerBareEngine, checkerCompare; on a root split in recheck.test.ts). Counting wrappers record every input
// the bare engine and AI are asked.

import { describe, expect, it } from 'vitest';
import type { AiMemory, EnemyModel } from '../../../src/contracts/ai.js';
import type { Choice, Engine, EngineState, Outcome, Side } from '../../../src/contracts/engine.js';
import type { SolveRequest, Verdict } from '../../../src/contracts/solver.js';
import type { Arena } from '../../../src/solver/arena.js';
import { rootBelief } from '../../../src/solver/belief.js';
import { extractProof, type Certificate } from '../../../src/solver/certificate.js';
import { resolveConfig } from '../../../src/solver/config.js';
import { createSolver } from '../../../src/solver/index.js';
import type { ArenaFight } from '../../../src/solver/inputs.js';
import { defaultLabeler } from '../../../src/solver/labeler.js';
import { Prover } from '../../../src/solver/prove.js';
import { ONE, rat } from '../../../src/solver/rational.js';
import { checkLine } from '../../../src/solver/solve.js';
import {
  createResultStore, DEFAULT_RESULT_STORE_BYTES as BIG, exactText, resultStoreStats, type StoredMethod, type StoreOptions,
} from '../../../src/solver/store.js';
import type { SolverConfig, SolverDeps } from '../../../src/solver/types.js';
import { createToyAi } from './toy/ai.js';
import { skewedOracles, toyDeps, withStatus } from './toy/deps.js';
import { createToyEngine, readToyState } from './toy/engine.js';
import { makeArena, scenarioFights } from './toy/fixtures.js';
import { toyOracles } from './toy/oracles.js';
import { randomToyFight } from './toy/random.js';
import {
  aiMemory, ALL_SCENARIOS, critOnlyBudget0, critOnlyBudget1, critSpanGauntlet, deadlyRolls, deathGauntlet, doubleGauntlet, entryRangeGauntlet,
  hiddenCounterSafe, highHpGauntlet, leadSwapGauntlet, loopEscape, preBurn, replacementTie, sharedEntryGauntlet, teamPool, undrawnSleepGauntlet,
  type Scenario,
} from './toy/scenarios.js';

const INF = Number.POSITIVE_INFINITY;
const MISMATCH = { tier: 'unproven', reason: 'verificationMismatch', detail: expect.stringMatching(/^store and bare checks differ:/) };
const SEARCH = { kind: 'search' as const, pool: ['party:0', 'party:1', 'party:2'], maxSize: 2 };
const STORED: readonly StoredMethod[] = ['expandTurn', 'legalChoices', 'carryOut', 'support', 'replacementSupport', 'remember'];
const move = (slot: number): Choice => ({ kind: 'move', slot });
const st = (json: string, key = 'one key', turn = 1): EngineState => ({ json, turn, phase: { kind: 'turnChoice' }, key });

/** Canonical JSON of call arguments (trailing undefined dropped, keys sorted, bigint and undefined kept apart). */
function inputText(args: readonly unknown[]): string {
  let n = args.length;
  while (n > 0 && args[n - 1] === undefined) n -= 1;
  return JSON.stringify(args.slice(0, n), (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v === undefined ? '\u0000undefined'
    : v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
}

/** The toy engine and AI of `s`, every call recorded per method, behind a store with frozen answers. */
function storedToy(s: Pick<Scenario, 'registry'>) {
  const calls = new Map<string, string[]>();
  const wrap = <T extends object>(target: T): T => new Proxy(target, {
    get(t, p) {
      const v: unknown = Reflect.get(t, p);
      if (typeof v !== 'function') return v;
      return (...a: unknown[]): unknown => {
        (calls.get(String(p)) ?? calls.set(String(p), []).get(String(p))!).push(inputText(a));
        return v.apply(t, a);
      };
    },
  });
  const bare = {
    engine: wrap(createToyEngine(s.registry)), ai: wrap(createToyAi(s.registry)),
    count: (m: string): number => calls.get(m)?.length ?? 0, distinct: (m: string): number => new Set(calls.get(m)).size,
  };
  return { bare, store: createResultStore(bare.engine, bare.ai, { maxBytes: BIG, freeze: true }) };
}

/** The toy deps of `s` behind a store, with `tamper` and `config` when given. */
const stored = (s: Scenario, tamper?: StoreOptions['tamper'], config?: Partial<SolverConfig>): SolverDeps =>
  toyDeps(s, config === undefined ? {} : { config }, { store: { tamper } });

function request(s: Scenario, over: Partial<SolveRequest> = {}): SolveRequest {
  return {
    fights: (s.fights ?? [s.trainerId]).map((trainerId) => ({ trainerId })), team: { kind: 'fixed', party: s.p1.map((_, i) => `party:${i}`) }, preStatus: 'given',
    budgetMs: 600_000, horizonTurns: s.horizon, attemptAnyLegalBadge: false, ranking: [], ...over,
  };
}

/** `v` without its wall-clock times. */
function untimed(v: Verdict): unknown {
  const { elapsedMs: _ms, ...report } = v.report;
  return { ...v, report, ...(v.tier === 'unproven' && v.best !== undefined ? { best: untimed(v.best) } : {}) };
}

const prover = (arena: Arena, critBudget: number | null = null): Prover => new Prover(arena, {
  params: { level: 1, critBudget, thresholds: null }, mode: 'display', deadline: INF, now: () => 0, labeler: defaultLabeler, history: new Map(),
});

/** A tier-1 proof of `s` on `arena`, deepened to its horizon. */
function proofOn(arena: Arena, s: Scenario): Certificate {
  const p = prover(arena);
  const root = rootBelief(arena);
  const { result, horizon } = p.deepen(root, s.horizon);
  expect(result.kind, s.name).toBe('win');
  return extractProof(p, root, horizon);
}

const env = (deps: SolverDeps, fights: ArenaFight[], cfg: Partial<SolverConfig> = {}) => ({
  deps, cfg: resolveConfig(cfg), fights, labeler: defaultLabeler, checkerDeadline: INF,
});

/** A tamper that changes each observation of the first expandTurn answer stored: the search agrees with itself on it. */
function oneWrongStep(): NonNullable<StoreOptions['tamper']> {
  let done = false;
  return (method, answer) => {
    if (method !== 'expandTurn' || done) return answer;
    done = true;
    return (answer as Outcome[]).map((o) => ({ ...o, observation: `${o.observation}~` }));
  };
}

/** An engine and an AI whose answers echo their inputs, with every call counted per method. */
function echo(opts: { hpOf?: boolean } = {}) {
  const asked = new Map<string, number>();
  const ask = (m: string): void => void asked.set(m, (asked.get(m) ?? 0) + 1);
  const outcome = (state: EngineState, text: string): Outcome => ({
    probability: ONE, labels: [], critBy: { p1: false, p2: false }, unlabelled: false, state: st(`${state.json}>`, state.key), observation: text,
    log: [`|move|${text}`], fainted: { p1: [], p2: [] }, merged: 1,
  });
  const engine: Engine = {
    id: 'echo',
    createBattle: () => st('start'),
    legalChoices: (state, side) => (ask('legalChoices'), [move(state.json.charCodeAt(0) + 1000 * state.turn + (side === 'p2' ? 100 : 0))]),
    expandTurn: (state, choices, o) => (ask('expandTurn'), [outcome(state, `${state.json}|${JSON.stringify(choices)}|${o?.maxLeaves ?? '-'}`)]),
    observe: (state) => state.json,
    carryOut: (state) => (ask('carryOut'), { mons: [{ hp: 10 + state.json.charCodeAt(0) % 80, pp: [], status: { kind: 'none' } }] }),
    unmodelledIn: () => [],
    ...(opts.hpOf === true ? { hpOf: (state: EngineState) => (ask('hpOf'), { p1: [state.json.charCodeAt(0)], p2: [] }) } : {}),
  };
  const ai: EnemyModel = {
    id: 'echo-ai',
    initialMemory: () => ({ key: 'm', data: { n: 0 } }),
    support: (state, memory) => (ask('support'), [{ choice: move((memory.data as { n: number }).n + state.json.length), probability: ONE }]),
    replacementSupport: () => (ask('replacementSupport'), [{ choice: { kind: 'switch', index: 1 }, probability: ONE }]),
    remember: (memory, o) => (ask('remember'), { key: memory.key, data: { n: o.log.length + (o.probability.den === 1n ? 0 : 50) } }),
  };
  return { engine, ai, asked: (m: string): number => asked.get(m) ?? 0 };
}

describe('the store of engine and AI answers', () => {
  it('changes no result: every toy scenario, gauntlet and 60 random fights solve the same with it', async () => {
    const runs: [Scenario, Partial<SolveRequest>][] = [
      ...ALL_SCENARIOS.flatMap((s): [Scenario, Partial<SolveRequest>][] => [[s, {}], [s, { attemptAnyLegalBadge: true }]]),
      ...[highHpGauntlet, leadSwapGauntlet, sharedEntryGauntlet, entryRangeGauntlet, critSpanGauntlet, doubleGauntlet, deathGauntlet, undrawnSleepGauntlet]
        .map((s): [Scenario, Partial<SolveRequest>] => [s, {}]),
      [highHpGauntlet, { fights: [{ trainerId: 'ogre' }, { trainerId: 'brute', healBefore: true }] }],
      [preBurn, { preStatus: 'propose' }],
      [teamPool, { team: SEARCH }],
      ...Array.from({ length: 60 }, (_, i): [Scenario, Partial<SolveRequest>] => [{ ...randomToyFight(i + 1), name: `seed ${i + 1}`, expect: {} }, {}]),
    ];
    let hits = 0;
    for (const [s, over] of runs) {
      const deps = stored(s);
      const v = await createSolver(deps).solve(request(s, over));
      expect(untimed(v), `${s.name} ${JSON.stringify(over)}`).toEqual(untimed(await createSolver(toyDeps(s)).solve(request(s, over))));
      hits += resultStoreStats(deps.engine)?.hits ?? 0;
    }
    expect(hits).toBeGreaterThan(0);
  }, 300_000);

  it('a second game on one arena asks the bare engine and AI each distinct input once', () => {
    let reused = 0;
    for (const s of [critOnlyBudget0, critOnlyBudget1, deadlyRolls, aiMemory, replacementTie, hiddenCounterSafe, loopEscape]) {
      const { bare, store } = storedToy(s);
      const arena = makeArena(scenarioFights(s), store.engine, store.ai);
      prover(arena, 0).deepen(rootBelief(arena), s.horizon);
      const [expansions, hits] = [arena.stats.expansions, store.stats().hits];
      prover(arena).deepen(rootBelief(arena), s.horizon);   // another crit cap: the arena expands afresh
      expect(arena.stats.expansions, s.name).toBeGreaterThan(expansions);
      expect(STORED.map((m) => bare.count(m)), s.name).toEqual(STORED.map((m) => bare.distinct(m)));
      expect(bare.count('expandTurn'), s.name).toBeGreaterThan(0);
      reused += store.stats().hits - hits;
    }
    expect(reused).toBeGreaterThan(0);
  });

  it('equality decides a hit, not the hash', () => {
    const { engine, ai, asked } = echo({ hpOf: true });
    const store = createResultStore(engine, ai, { maxBytes: BIG, freeze: true, hash: () => 'x' });   // every input in one bucket
    const [a, b, a2] = [st('A'), st('B'), st('A', 'one key', 2)];   // one state key; b's json differs, a2's turn
    const legal = [store.engine.legalChoices(a, 'p1'), store.engine.legalChoices(b, 'p1'), store.engine.legalChoices(a2, 'p1'), store.engine.legalChoices(a, 'p2')];
    expect(legal).toEqual([[move(1065)], [move(1066)], [move(2065)], [move(1165)]]);
    expect(store.engine.legalChoices(st('A'), 'p1')).toBe(legal[0]);   // an equal input in a new object hits
    expect([store.engine.carryOut(a).mons[0]!.hp, store.engine.carryOut(b).mons[0]!.hp, store.engine.hpOf!(a).p1, store.engine.hpOf!(b).p1]).toEqual([75, 76, [65], [66]]);
    expect(store.engine.hpOf!(st('A'))).toBe(store.engine.hpOf!(a));
    const first = store.engine.expandTurn(a, { p1: move(0) });
    const others = [
      store.engine.expandTurn(a, { p1: move(1) }), store.engine.expandTurn(b, { p1: move(0) }), store.engine.expandTurn(a, { p1: move(0) }, { maxLeaves: 5 }),
      store.engine.expandTurn(a, { p1: move(0), p2: move(0) }),
    ];
    expect(new Set([first, ...others].map((o) => o[0]!.observation)).size).toBe(5);
    expect(store.engine.expandTurn(a, { p1: move(0) }, undefined)).toBe(first);   // a trailing undefined is no argument
    const mx: AiMemory = { key: 'same', data: { n: 1 } };
    expect([mx, { ...mx, data: { n: 2 } }].map((m) => store.ai.support(a, m)[0]!.choice)).toEqual([move(2), move(3)]);   // one key, other data
    const o = first[0]!;
    expect([o, { ...o, log: [...o.log, '|-crit|p2a: X'] }, { ...o, probability: rat(1, 2) }].map((x) => store.ai.remember(mx, x).data)).toEqual([{ n: 1 }, { n: 2 }, { n: 51 }]);
    expect([asked('legalChoices'), asked('hpOf'), asked('support'), asked('remember'), store.stats().hits]).toEqual([4, 2, 2, 3, 4]);
  });

  it('never stores a throw: a stopped step or an AI error is asked again', () => {
    const { engine, ai } = echo();
    let steps = 0;
    const stop = Object.assign(new Error('stopped'), { code: 'STOPPED' });
    const store = createResultStore({
      ...engine, expandTurn: (state, choices, o) => {
        steps += 1;
        if (o?.shouldStop?.() === true) throw stop;
        return engine.expandTurn(state, choices, o);
      },
    }, ai, { maxBytes: BIG, freeze: true });
    expect(() => store.engine.expandTurn(st('A'), { p1: move(0) }, { shouldStop: () => true })).toThrow(stop);
    expect(store.stats()).toEqual({ hits: 0, misses: 1, bytes: 0, evictions: 0 });
    const answer = store.engine.expandTurn(st('A'), { p1: move(0) }, { shouldStop: () => false });
    expect([store.engine.expandTurn(st('A'), { p1: move(0) }) === answer, steps]).toEqual([true, 2]);
    let supports = 0;
    const undef = Object.assign(new Error('undefined behaviour'), { code: 'UNDEFINED' });
    const store2 = createResultStore(engine, { ...ai, support: () => { supports += 1; throw undef; } }, { maxBytes: BIG });
    for (let i = 0; i < 2; i++) expect(() => store2.ai.support(st('A'), { key: 'm', data: null })).toThrow(undef);
    expect([supports, store2.stats()]).toEqual([2, { hits: 0, misses: 2, bytes: 0, evictions: 0 }]);
  });

  it('the byte bound evicts the least recently used entry and never keeps one bigger than the bound', () => {
    const { engine, ai, asked } = echo();
    const carry = (store: ReturnType<typeof createResultStore>, ...jsons: string[]): void => {
      for (const j of jsons) store.engine.carryOut(st(j, `k${j}`));
    };
    const probe = createResultStore(engine, ai, { maxBytes: BIG });
    carry(probe, 'A');
    const one = probe.stats().bytes;   // every entry below has this size
    const store = createResultStore(engine, ai, { maxBytes: 2 * one });
    const before = asked('carryOut');
    carry(store, 'A', 'B', 'A', 'C');   // the hit on A leaves B least recent: C evicts it
    expect(store.stats()).toEqual({ hits: 1, misses: 3, bytes: 2 * one, evictions: 1 });
    carry(store, 'A', 'B', 'A', 'C');   // A hits, B evicts C, A hits, C evicts B
    expect([asked('carryOut') - before, store.stats()]).toEqual([5, { hits: 3, misses: 5, bytes: 2 * one, evictions: 3 }]);
    const tight = createResultStore(engine, ai, { maxBytes: one - 1 });
    carry(tight, 'A', 'A');
    expect(tight.stats()).toEqual({ hits: 0, misses: 2, bytes: 0, evictions: 0 });
  });

  it("expandTurn's key ignores shouldStop and undefined fields, not maxLeaves; a miss forwards the caller's options", () => {
    const { engine, ai, asked } = echo();
    const forwarded: unknown[] = [];
    const store = createResultStore({ ...engine, expandTurn: (s, c, o) => (forwarded.push(o?.shouldStop), engine.expandTurn(s, c, o)) }, ai, { maxBytes: BIG, freeze: true });
    const go = (): boolean => false;
    const step = (json: string, o?: { maxLeaves?: number; shouldStop?: () => boolean }) => store.engine.expandTurn(st(json), { p1: move(0) }, o);
    const [plain, limited, stopped] = [step('A'), step('A', { maxLeaves: 5 }), step('B', { shouldStop: go })];
    const hits = [
      step('A', { shouldStop: go }) === plain, step('A', { maxLeaves: undefined, shouldStop: go }) === plain, step('B') === stopped, step('B', {}) === stopped,
      step('A', { maxLeaves: 5, shouldStop: go }) === limited, step('A', { maxLeaves: 6 }) === limited,
    ];
    expect(hits).toEqual([true, true, true, true, true, false]);
    expect([asked('expandTurn'), forwarded]).toEqual([4, [undefined, undefined, go, undefined]]);
  });

  it('an argument it cannot write exactly passes through unstored: a Map, a symbol key, nesting past 200 levels', () => {
    const { engine, ai, asked } = echo();
    const store = createResultStore(engine, ai, { maxBytes: BIG, freeze: true });
    const nested = (levels: number): unknown => Array.from({ length: levels }).reduce<unknown>((v) => [v], 0);
    for (const arg of [new Map([['slot', 0]]), { [Symbol('x')]: 1, kind: 'move', slot: 0 }, nested(201)]) {
      const before = asked('legalChoices') + asked('expandTurn');
      for (let i = 0; i < 2; i++) {
        store.engine.legalChoices(st('A'), arg as Side);
        store.engine.expandTurn(st('A'), { p1: arg as Choice });
        store.engine.expandTurn(st('A'), { p1: move(0) }, { maxLeaves: 5, extra: arg } as { maxLeaves: number });
      }
      expect(asked('legalChoices') + asked('expandTurn') - before).toBe(6);
    }
    expect(store.stats()).toEqual({ hits: 0, misses: 18, bytes: 0, evictions: 0 });
    for (let i = 0; i < 2; i++) store.engine.legalChoices(st('A'), nested(200) as Side);   // 200 levels is still plain data
    expect(store.stats()).toMatchObject({ hits: 1, misses: 19 });
  });

  it('exactText keeps apart what JSON would merge, but not key order', () => {
    const pairs: [unknown, unknown][] = [
      [-0, 0], [{ a: undefined }, {}], [[undefined], []], [[undefined], [null]], [1, '1'], [{ n: 1 }, { n: '1' }], [1n, 1], [1n, '1n'], [Number.NaN, 'NaN'],
      [INF, 'Infinity'], [true, 't'], [null, 'n'], [undefined, 'u'], [{}, []],
    ];
    for (const [x, y] of pairs) expect(exactText(x), String(exactText(y))).not.toBe(exactText(y));
    expect(exactText({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(exactText({ a: [2, { c: 4, d: 3 }], b: 1 }));
  });
});

describe("the checker's store guards", () => {
  it('checkerBareEngine checks on the bare engine and AI; by default the checker reads the store', () => {
    const s = hiddenCounterSafe;
    const { bare, store } = storedToy(s);
    const fights = scenarioFights(s);
    const deps: SolverDeps = {
      ...toyDeps(s), engine: store.engine, enemyModel: store.ai, bare: { engine: bare.engine, enemyModel: bare.ai, oracles: toyOracles(s.registry) },
    };
    const cert = proofOn(makeArena(fights, store.engine, store.ai), s);
    const counts = (): number[] => STORED.map((m) => bare.count(m));
    const [stats, asked] = [store.stats(), counts()];
    const onBare = checkLine(env(deps, fights, { checkerBareEngine: true }), cert).result;
    expect([onBare.passed, store.stats()]).toEqual([true, stats]);   // the store was not asked
    expect(bare.count('expandTurn')).toBeGreaterThan(asked[0]!);
    const asked2 = counts();
    expect(checkLine(env(deps, fights), cert).result).toEqual(onBare);
    expect(counts()).toEqual(asked2);
    expect(store.stats().hits).toBeGreaterThan(stats.hits);
  });

  it('checkerCompare: a wrong store is a verificationMismatch, unnoticed without it; a right one checks as one check', async () => {
    const s = hiddenCounterSafe;
    const fights = scenarioFights(s);
    const checks = (deps: SolverDeps) => {
      const cert = proofOn(makeArena(fights, deps.engine, deps.enemyModel), s);
      return [checkLine(env(deps, fights), cert).result, checkLine(env(deps, fights, { checkerCompare: true }), cert).result] as const;
    };
    const [once, compared] = checks(stored(s));
    expect([once.passed, once.mismatches, compared]).toEqual([true, [], once]);
    const [alone, caught] = checks(stored(s, oneWrongStep()));
    expect(alone.passed).toBe(true);   // the wrong store agrees with itself
    expect([caught.passed, caught.reason]).toEqual([false, 'verificationMismatch']);
    expect(caught.mismatches[0]).toMatch(/^store and bare checks differ:[^]*mismatches .* on the store, .* bare/);
    expect((await createSolver(stored(s, undefined, { checkerCompare: true })).solve(request(s))).tier).toBe(1);
    expect(await createSolver(stored(s, oneWrongStep(), { checkerCompare: true })).solve(request(s))).toMatchObject({ ...MISMATCH, best: { tier: 1 } });
    expect((await createSolver(stored(s, oneWrongStep())).solve(request(s))).tier).toBe(1);
  });

  it.each([
    { s: preBurn, over: { preStatus: 'propose' }, skew: (state: EngineState) => !withStatus('burn')(state), more: { best: { tier: 1, preStatus: { 'party:0': { kind: 'burn' } } } } },
    { s: teamPool, over: { team: SEARCH }, skew: (state: EngineState) => readToyState(state).p1Keys.includes('C'), more: { detail: expect.stringContaining('(team A, C)') } },
  ] as const)('checkerCompare: a $s.name run the verdict does not show still surfaces its store difference', async ({ s, over, skew, more }) => {
    const deps = (skewed: boolean): SolverDeps => {
      const d = stored(s, undefined, { checkerCompare: true });
      return skewed ? { ...d, bare: { ...d.bare!, oracles: skewedOracles(d.bare!.oracles, skew, 'count') } } : d;
    };
    const req = request(s, over as Partial<SolveRequest>);
    expect((await createSolver(deps(false)).solve(req)).tier).toBe(1);
    const v = await createSolver(deps(true)).solve(req);
    expect(v).toMatchObject(MISMATCH);
    expect(v).toMatchObject(more);
  });
});
