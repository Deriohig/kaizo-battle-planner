// A stub native engine for the engine selector's tests (src/engines/select.ts, `NativeProvider`): every answer is the
// reference engine's, and a native state is the reference state with 'n1:stub:' before its json and 'n:' before its key.
// createBattle wraps the start when `holds` it; expandTurn counts a native state's step as `native` when `runs`, else
// `fallback`, throws what `fails` gives (after the count), and wraps each outcome's state the stub `holds`. The other
// calls unwrap and delegate. `supports` is `{ ok: covers(input) }`. `log` records the calls, options and counts.
// Defaults: `covers`, `runs` and `holds` true; `fails` never.

import type { BattleInput, Choice, Engine, EngineState } from '../../../src/contracts/engine.js';
import type { NativeProvider } from '../../../src/engines/select.js';

export const STUB_PREFIX = 'n1:stub:';
const KEY_PREFIX = 'n:';

type Choices = { p1?: Choice; p2?: Choice };
type StepOptions = Parameters<Engine['expandTurn']>[2];

export interface StubRules {
  covers?: (input: BattleInput) => boolean;
  runs?: (state: EngineState, choices: Choices) => boolean;
  /** Given the state in its reference form. */
  holds?: (state: EngineState) => boolean;
  fails?: (state: EngineState, choices: Choices) => unknown;
}

export interface StubLog {
  calls: string[];
  options: StepOptions[];
  supports: number;
  toReference: number;
  steps: { native: number; fallback: number };
}

export const isStubNative = (state: EngineState): boolean => state.json.startsWith(STUB_PREFIX);
const wrap = (s: EngineState): EngineState => ({ json: STUB_PREFIX + s.json, turn: s.turn, phase: s.phase, key: KEY_PREFIX + s.key });
const unwrap = (s: EngineState): EngineState => (!isStubNative(s) ? s
  : { json: s.json.slice(STUB_PREFIX.length), turn: s.turn, phase: s.phase, key: s.key.slice(KEY_PREFIX.length) });

/** A NativeProvider over `reference` that follows `rules`, and the log of what it was asked. */
export function stubNative(reference: Engine, rules: StubRules = {}): { provider: NativeProvider; log: StubLog } {
  const { covers = () => true, runs = () => true, holds = () => true } = rules;
  const log: StubLog = { calls: [], options: [], supports: 0, toReference: 0, steps: { native: 0, fallback: 0 } };
  const adopt = (state: EngineState): EngineState => (holds(state) ? wrap(state) : state);
  const delegate = (name: 'legalChoices' | 'observe' | 'carryOut' | 'unmodelledIn' | 'hpOf') => (state: EngineState, ...rest: unknown[]) => {
    log.calls.push(name);
    return (reference[name] as (...args: unknown[]) => unknown).call(reference, unwrap(state), ...rest);
  };

  const engine = {
    get id(): string {
      return `native-stub@1+${reference.id}`;
    },
    createBattle: (input: BattleInput): EngineState => (log.calls.push('createBattle'), adopt(reference.createBattle(input))),
    expandTurn: (state: EngineState, choices: Choices, opts?: StepOptions) => {
      log.calls.push('expandTurn');
      log.options.push(opts);
      if (isStubNative(state) && runs(state, choices)) log.steps.native += 1;
      else log.steps.fallback += 1;
      const failure = rules.fails?.(state, choices);
      if (failure !== undefined) throw failure;
      return reference.expandTurn(unwrap(state), choices, opts).map((o) => {
        const next = adopt(o.state);
        return next === o.state ? o : { ...o, state: next };
      });
    },
    legalChoices: delegate('legalChoices'),
    observe: delegate('observe'),
    carryOut: delegate('carryOut'),
    unmodelledIn: delegate('unmodelledIn'),
    ...(reference.hpOf === undefined ? {} : { hpOf: delegate('hpOf') }),
  } as Engine;

  const provider: NativeProvider = {
    engine,
    supports: (input) => (log.supports += 1, { ok: covers(input), missing: [] }),
    isNative: isStubNative,
    toReference: (state) => (log.toReference += 1, unwrap(state)),
    steps: () => ({ ...log.steps }),
  };
  return { provider, log };
}
