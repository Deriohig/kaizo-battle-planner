import { describe, expect, it } from 'vitest';
import type { AiMemory } from '../../../src/contracts/ai.js';
import type { BattleInput, Choice, Engine, EngineState, Outcome } from '../../../src/contracts/engine.js';
import type { SolveRequest, Verdict } from '../../../src/contracts/solver.js';
import { newCounters, stepCounters, type EngineSteps } from '../../../src/engines/counters.js';
import { ENGINE_MODES, engineArg, NATIVE_MISSING_NOTE, NativeUnavailableError, referenceModel, resolveMode, selectEngine, type EngineMode } from '../../../src/engines/select.js';
import { createSolver, type SolverDeps } from '../../../src/solver/index.js';
import { rat } from '../../../src/solver/rational.js';
import type { DamageOracle, SpeedOracle, StepContext } from '../../../src/solver/types.js';
import { createToyAi } from '../solver/toy/ai.js';
import { toyDeps } from '../solver/toy/deps.js';
import { createToyEngine, readToyState } from '../solver/toy/engine.js';
import type { ToyRegistry } from '../solver/toy/game.js';
import { toyInput, toyTrainer } from '../solver/toy/helpers.js';
import { toyOracles } from '../solver/toy/oracles.js';
import { safe1v1, twoSafeLines, type Scenario } from '../solver/toy/scenarios.js';
import { isStubNative, stubNative, type StubRules } from './stubNative.js';

// Two fights. A: Tapper (faster) Taps 2 or 3, Strike leaves it at 3. B: Brute (faster) Bashes 3, or 6 on a crit (1/4).
const REGISTRY: ToyRegistry = {
  mons: { Hero: { name: 'Hero', maxHp: 10, speed: 5, moves: [{ name: 'Strike', damage: [3] }, { name: 'Mend', damage: [], effect: 'heal3' }] } },
  trainers: {
    A: { id: 'A', party: [{ name: 'Tapper', maxHp: 6, speed: 10, moves: [{ name: 'Tap', damage: [2, 3] }] }] },
    B: { id: 'B', party: [{ name: 'Brute', maxHp: 8, speed: 10, moves: [{ name: 'Bash', damage: [3], critChance: rat(1, 4) }] }] },
  },
  observeAll: true,
};
const inputA = (): BattleInput => toyInput(REGISTRY, ['Hero'], 'A');
const inputB = (): BattleInput => toyInput(REGISTRY, ['Hero'], 'B');
const FOE: Choice = { kind: 'move', slot: 0 };
const move = (slot: number) => ({ p1: { kind: 'move', slot } as Choice, p2: FOE });
const strike = move(0);
const mend = move(1);
const isMend = (_state: EngineState, choices: { p1?: Choice }): boolean => choices.p1?.kind === 'move' && choices.p1.slot === 1;
const onlyA: StubRules = { covers: (input) => input.trainer.id === 'A' };
const CALLS = ['legalChoices', 'observe', 'carryOut', 'unmodelledIn', 'expandTurn'];

/** Every call but createBattle on `s` (expandTurn's outcomes through `plain`), in the order of CALLS. */
const everyCall = (engine: Engine, s: EngineState, plain = (o: Outcome): Outcome => o): unknown[] =>
  [engine.legalChoices(s, 'p1'), engine.observe(s), engine.carryOut(s), engine.unmodelledIn(s), engine.expandTurn(s, mend).map(plain)];

/** `engine`, recording every call that reaches it: a stub that holds no state passes each call on as it is. */
function recording(engine: Engine): { engine: Engine; calls: string[] } {
  const { provider, log } = stubNative(engine, { holds: () => false });
  return { engine: provider.engine, calls: log.calls };
}

/** `engine` with shouldStop as the contract has it: polled on entry and after the work (`afterEntry` runs between). */
function stopping(engine: Engine, afterEntry: () => void = () => {}): { engine: Engine; options: unknown[] } {
  const options: unknown[] = [];
  const poll = (opts: Parameters<Engine['expandTurn']>[2]): void => {
    if (opts?.shouldStop?.() === true) throw Object.assign(new Error('stopping: shouldStop said stop'), { code: 'STOPPED' });
  };
  const expandTurn: Engine['expandTurn'] = (state, choices, opts) => {
    options.push(opts);
    poll(opts);
    afterEntry();
    const outcomes = engine.expandTurn(state, choices, opts);
    poll(opts);
    return outcomes;
  };
  return { options, engine: { ...engine, expandTurn } };
}

/** The toy engine with an hpOf over its own states. */
const withHp = (engine: Engine): Engine => ({
  ...engine,
  hpOf: (state) => ({ p1: readToyState(state).p1.map((m) => m.hp), p2: readToyState(state).p2.map((m) => m.hp) }),
});

/** A counted kit of `mode` over the toy engine (recorded as `ref`) and a stub native engine over the raw toy engine. */
function setup(mode: EngineMode, rules: StubRules = {}) {
  const toy = createToyEngine(REGISTRY);
  const ref = recording(toy);
  const stub = stubNative(toy, rules);
  const counters = stepCounters(newCounters());
  const kit = selectEngine({ mode, reference: ref.engine, native: stub.provider, counters });
  const clear = (): void => {
    ref.calls.length = 0;
    stub.log.calls.length = 0;
  };
  return { toy, ref, stub, counters, kit, clear, isNative: stub.provider.isNative };
}

/** The selector's counts (it never counts a remembered step). */
const steps = (native: number, fallback: number, showdown: number): EngineSteps => ({ native, fallback, showdown, remembered: 0 });
const total = (s: EngineSteps): number => s.native + s.fallback + s.showdown;

/** What `run` throws; fails the test when it returns. */
function caught(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error('expected a throw, and nothing was thrown');
}

describe('selectEngine', () => {
  it('showdown without counters is the reference itself; the ids name what runs; auto or native need a native engine', () => {
    const toy = createToyEngine(REGISTRY);
    const kit = selectEngine({ mode: 'showdown', reference: toy, native: null });
    expect(kit.engine).toBe(toy);
    expect([kit.mode, kit.usesNative]).toEqual(['showdown', false]);
    const s = toy.createBattle(inputA());
    expect(kit.reference(s)).toBe(s);
    const { provider } = stubNative(toy);
    const id = (mode: EngineMode) => selectEngine({ mode, reference: toy, native: provider, counters: stepCounters(newCounters()) }).engine.id;
    expect(ENGINE_MODES.map(id)).toEqual([`auto+native-stub@1+${toy.id}`, toy.id, `native-stub@1+${toy.id}`]);
    for (const mode of ['auto', 'native'] as const) {
      const error = caught(() => selectEngine({ mode, reference: toy, native: null }));
      expect(error).toBeInstanceOf(NativeUnavailableError);
      expect(error).toHaveProperty('code', 'NATIVE_UNAVAILABLE');
    }
  });

  it('auto starts a covered fight native and an uncovered one on the reference, asking supports once per input', () => {
    const { toy, ref, stub, kit, clear, isNative } = setup('auto', onlyA);
    const a = kit.engine.createBattle(inputA());
    const b = kit.engine.createBattle(inputB());
    expect([isNative(a), isNative(b)]).toEqual([true, false]);
    expect(b).toEqual(toy.createBattle(inputB()));
    expect([stub.log.calls, ref.calls]).toEqual([['createBattle'], ['createBattle']]);
    for (const input of [inputA, inputB, inputA]) kit.engine.createBattle(input());
    expect(stub.log.supports).toBe(2);
    // Then every call goes where its state says.
    clear();
    expect(everyCall(kit.engine, a, (o) => ({ ...o, state: kit.reference(o.state) }))).toEqual(everyCall(toy, kit.reference(a)));
    expect([stub.log.calls, ref.calls]).toEqual([CALLS, []]);
    clear();
    expect(everyCall(kit.engine, b)).toEqual(everyCall(toy, b));
    expect([stub.log.calls, ref.calls]).toEqual([[], CALLS]);
  });

  it('counts a covered step as native, a fallback step as fallback, and a step of an uncovered fight as showdown', () => {
    const { counters, kit, isNative } = setup('auto', { ...onlyA, runs: (s, c) => !isMend(s, c) });
    const a = kit.engine.createBattle(inputA());
    const afterA = kit.engine.expandTurn(a, strike)[0]!.state;
    kit.engine.expandTurn(afterA, strike);
    kit.engine.expandTurn(a, mend);
    const afterB = kit.engine.expandTurn(kit.engine.createBattle(inputB()), strike)[0]!.state;
    kit.engine.expandTurn(afterB, strike);
    expect([isNative(afterA), isNative(afterB)]).toEqual([true, false]);
    expect(counters.read()).toEqual(steps(2, 1, 2));
  });

  it('auto leaves a state the native engine cannot hold on the reference, with its subtree', () => {
    const { ref, stub, counters, kit, clear, isNative } = setup('auto', { holds: (s) => readToyState(s).p1[0]!.hp !== 7 });
    const outcomes = kit.engine.expandTurn(kit.engine.createBattle(inputA()), strike);
    expect(outcomes.map((o) => isNative(o.state)).sort()).toEqual([false, true]);
    const left = outcomes.find((o) => !isNative(o.state))!.state;
    expect(readToyState(left).p1[0]!.hp).toBe(7);
    clear();
    kit.engine.expandTurn(left, strike);
    expect([ref.calls, stub.log.calls]).toEqual([['expandTurn'], []]);
    expect(counters.read()).toEqual(steps(1, 0, 1));
  });

  it('native mode sends every call to the native engine, reference states too, and never asks supports', () => {
    const { ref, stub, counters, kit, isNative } = setup('native', { covers: () => false, holds: () => false });
    const states = [kit.engine.createBattle(inputA()), kit.engine.createBattle(inputB())];
    expect(states.some(isNative)).toBe(false);
    for (const s of states) everyCall(kit.engine, s);
    expect([ref.calls, stub.log.calls]).toEqual([[], ['createBattle', 'createBattle', ...CALLS, ...CALLS]]);
    expect([counters.read(), stub.log.supports, kit.usesNative]).toEqual([steps(0, 2, 0), 0, true]);
  });

  it('a supports that throws sends the battle to the reference, which throws its own error, and is not cached', () => {
    const { ref, stub, kit } = setup('auto', {
      covers: () => {
        throw new Error('stub: no forecast for a double');
      },
    });
    const double: BattleInput = { ...inputA(), trainer: { ...toyTrainer('A'), battleType: 'double' } };
    for (const n of [1, 2]) {
      expect(caught(() => kit.engine.createBattle(double))).toMatchObject({ code: 'UNSUPPORTED_DOUBLE', message: expect.stringMatching(/^toy engine: /) as unknown });
      expect([stub.log.supports, ref.calls.length]).toEqual([n, n]);
    }
  });

  it('a step that throws is counted and its error passes through', () => {
    const limit = Object.assign(new Error('stub: more leaves than allowed'), { code: 'LIMIT' });
    const { counters, kit } = setup('auto', { ...onlyA, fails: (s, c) => (isMend(s, c) ? limit : undefined) });
    expect(caught(() => kit.engine.expandTurn(kit.engine.createBattle(inputA()), mend))).toBe(limit);
    expect(counters.read()).toEqual(steps(1, 0, 0));
    // A step the reference refuses, in a fight the native engine does not cover, counts as showdown.
    expect(caught(() => kit.engine.expandTurn(kit.engine.createBattle(inputB()), move(5)))).toMatchObject({ code: 'BAD_CHOICE' });
    expect(counters.read()).toEqual(steps(1, 0, 1));
  });

  it('reference() converts a native state once per object; referenceModel hands the AI reference states only', () => {
    const { toy, stub, kit } = setup('auto', onlyA);
    const memory: AiMemory = { key: 'm', data: null };
    const support = [{ choice: FOE, probability: rat(1) }];
    const states: EngineState[] = [];
    const remembered: Outcome[] = [];
    const ai = referenceModel({
      id: 'recording-ai@1',
      initialMemory: (state) => (states.push(state), memory),
      support: (state) => (states.push(state), support),
      replacementSupport: (state) => (states.push(state), support),
      remember: (m, outcome) => (remembered.push(outcome), m),
    }, kit.reference);
    const a = kit.engine.createBattle(inputA());
    const b = kit.engine.createBattle(inputB());
    expect(kit.reference(a)).toBe(kit.reference(a));
    expect([kit.reference(a), kit.reference(b)]).toEqual([toy.createBattle(inputA()), b]);
    expect(kit.reference(b)).toBe(b);
    expect(stub.log.toReference).toBe(1);

    const native = kit.engine.expandTurn(a, strike)[0]!;
    expect(isStubNative(a) && isStubNative(native.state)).toBe(true);
    expect([ai.id, ai.initialMemory(a), ai.support(a, memory), ai.replacementSupport(a, memory), ai.remember(memory, native)])
      .toEqual(['recording-ai@1', memory, support, support, memory]);
    expect(states).toEqual([kit.reference(a), kit.reference(a), kit.reference(a)]);
    expect(remembered[0]).toEqual({ ...native, state: kit.reference(native.state) });
    // An outcome already in its reference form is handed on as it is.
    const plain = kit.engine.expandTurn(b, strike)[0]!;
    ai.remember(memory, plain);
    expect(remembered[1]).toBe(plain);
  });

  it('hpOf is there only when every engine it routes to has it, and is routed by the state', () => {
    const toy = createToyEngine(REGISTRY);
    const hp = withHp(toy);
    const counters = stepCounters(newCounters());
    const has = (mode: EngineMode, reference: Engine, native: Engine): boolean =>
      'hpOf' in selectEngine({ mode, reference, native: mode === 'showdown' ? null : stubNative(native).provider, counters }).engine;
    expect(ENGINE_MODES.map((mode) => has(mode, toy, hp))).toEqual([false, false, true]);    // auto, showdown, native
    expect(ENGINE_MODES.map((mode) => has(mode, hp, toy))).toEqual([false, true, false]);

    const ref = recording(hp);
    const both = stubNative(hp, onlyA);
    const kit = selectEngine({ mode: 'auto', reference: ref.engine, native: both.provider, counters });
    const a = kit.engine.createBattle(inputA());
    const afterB = hp.expandTurn(kit.engine.createBattle(inputB()), strike)[0]!.state;
    ref.calls.length = 0;
    both.log.calls.length = 0;
    expect(kit.engine.hpOf!(a)).toEqual({ p1: [10], p2: [6] });
    expect([both.log.calls, ref.calls]).toEqual([['hpOf'], []]);
    expect(kit.engine.hpOf!(afterB)).toEqual(hp.hpOf!(afterB));
    expect([both.log.calls, ref.calls]).toEqual([['hpOf'], ['hpOf']]);
  });

  it('resolveMode runs auto and native as showdown, with a note, without a native engine; engineArg reads a mode', () => {
    expect(ENGINE_MODES.flatMap((mode) => [resolveMode(mode, true), resolveMode(mode, false)])).toEqual([
      { mode: 'auto', note: null }, { mode: 'showdown', note: NATIVE_MISSING_NOTE }, { mode: 'showdown', note: null },
      { mode: 'showdown', note: null }, { mode: 'native', note: null }, { mode: 'showdown', note: NATIVE_MISSING_NOTE },
    ]);
    expect(['auto', 'showdown', 'native', '', 'Auto', 'rust'].map((raw) => engineArg(raw))).toEqual(['auto', 'showdown', 'native', null, null, null]);
  });
});

/** The routes a step can take through a kit; every one but the last counts its steps. */
const ROUTES = ['showdown', 'auto, a fight not covered', 'auto, a covered step', 'auto, a step that falls back', 'native, not counted'] as const;

/** A kit whose steps from fight A's start take `route`, over the toy engine with shouldStop; `stub` is null off the stub. */
function onRoute(route: (typeof ROUTES)[number], afterEntry?: () => void) {
  const toy = createToyEngine(REGISTRY);
  const ref = stopping(toy, afterEntry);
  const counters = stepCounters(newCounters());
  const uncovered = route === 'auto, a fight not covered';
  const stub = route === 'showdown' ? null : stubNative(ref.engine, uncovered ? { covers: () => false } : route === 'auto, a step that falls back' ? { runs: () => false } : {});
  const mode = route === 'showdown' ? 'showdown' : route === 'native, not counted' ? 'native' : 'auto';
  const kit = selectEngine({ mode, reference: ref.engine, native: stub?.provider ?? null, ...(mode === 'native' ? {} : { counters }) });
  const start = kit.engine.createBattle(inputA());
  expect(isStubNative(start), route).toBe(stub !== null && !uncovered);
  return { toy, ref, stub: uncovered ? null : stub, counters, kit, start };
}

describe("expandTurn's options (maxLeaves, shouldStop)", () => {
  it.each(ROUTES)('%s: handed on as given; LIMIT and STOPPED pass through; a stop on entry is not counted, a later one is', (route) => {
    const { toy, ref, stub, counters, kit, start } = onRoute(route);
    const opts = [{ maxLeaves: 50, shouldStop: () => false }, { maxLeaves: 1 }, { shouldStop: () => true }];  // Tap rolls 2 or 3: two leaves
    const outcomes = kit.engine.expandTurn(start, strike, opts[0]);
    expect(outcomes.map((o) => ({ ...o, state: kit.reference(o.state) }))).toEqual(toy.expandTurn(kit.reference(start), strike));
    expect(caught(() => kit.engine.expandTurn(start, strike, opts[1]))).toMatchObject({ code: 'LIMIT' });
    expect(caught(() => kit.engine.expandTurn(start, strike, opts[2]))).toMatchObject({ code: 'STOPPED' });
    for (const seen of [ref.options, stub?.log.options ?? opts]) {
      expect(seen).toHaveLength(3);
      seen.forEach((o, i) => expect(o).toBe(opts[i]));
    }
    const counted = route !== 'native, not counted';
    expect(total(counters.read())).toBe(counted ? 2 : 0);
    let stop = false;
    const late = onRoute(route, () => {
      stop = true;
    });
    expect(caught(() => late.kit.engine.expandTurn(late.start, strike, { shouldStop: () => stop }))).toMatchObject({ code: 'STOPPED' });
    expect(total(late.counters.read())).toBe(counted ? 1 : 0);
  });
});

/** One fight against the scenario's trainer with its whole p1 list as a fixed team, at its horizon. */
const request = (s: Scenario): SolveRequest => ({
  fights: [{ trainerId: s.trainerId }], team: { kind: 'fixed', party: s.p1.map((_, i) => `party:${i}`) }, preStatus: 'given',
  budgetMs: 600_000, horizonTurns: s.horizon, attemptAnyLegalBadge: false, ranking: [],
});

/** `oracles` reading every state through `reference`, as the integration's oracles do. */
function readingOracles(oracles: SolverDeps['oracles'], reference: (state: EngineState) => EngineState): SolverDeps['oracles'] {
  const through = (oracle: DamageOracle | SpeedOracle): DamageOracle & SpeedOracle => ({
    id: oracle.id,
    check: (step: StepContext) => oracle.check({ ...step, before: reference(step.before), outcome: { ...step.outcome, state: reference(step.outcome.state) } }),
  });
  return { damage: through(oracles.damage), speed: through(oracles.speed) };
}

const shown = (v: Verdict): unknown => (v.tier === 'unproven' ? { tier: v.tier, reason: v.reason, detail: v.detail } : { tier: v.tier, lead: v.lead, tree: v.tree });

describe('a solve through the selector', () => {
  // safe1v1 has one p1 move, so refusing slot 0 refuses every step; twoSafeLines refuses Mend only, so its count is mixed.
  it.each([{ scenario: safe1v1, refused: 0 }, { scenario: twoSafeLines, refused: 1 }])('$scenario.name gives the same verdict in every mode', async ({ scenario, refused }) => {
    const solveIn = async (mode: EngineMode, rules: StubRules = {}) => {
      const toy = createToyEngine(scenario.registry);
      const counters = stepCounters(newCounters());
      const kit = selectEngine({ mode, reference: toy, native: mode === 'showdown' ? null : stubNative(toy, rules).provider, counters });
      const deps = toyDeps(scenario, {
        engine: kit.engine, enemyModel: referenceModel(createToyAi(scenario.registry), kit.reference),
        oracles: readingOracles(toyOracles(scenario.registry), kit.reference),
      });
      const verdict = shown(await createSolver(deps).solve(request(scenario)));
      const { native, fallback, showdown } = counters.read();
      return { verdict, ran: [native > 0, fallback > 0, showdown > 0] };
    };
    const runs = (_state: EngineState, choices: { p1?: Choice }): boolean => !(choices.p1?.kind === 'move' && choices.p1.slot === refused);
    const results = [await solveIn('showdown'), await solveIn('auto'), await solveIn('auto', { runs }), await solveIn('native')];
    expect(results[0]!.verdict).toMatchObject({ tier: 1 });
    for (const { verdict } of results) expect(verdict).toEqual(results[0]!.verdict);
    // showdown, auto covered, auto mixed, native: which counts are above zero.
    expect(results.map((r) => r.ran)).toEqual([[false, false, true], [true, false, false], [refused === 1, true, false], [true, false, false]]);
  });
});
