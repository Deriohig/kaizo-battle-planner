// The engine selector: which battle engine a solve steps. `auto` runs a fight on the native engine
// where the native core covers it and on Showdown elsewhere; `showdown` and `native` run every fight on one engine.
//
// The selector routes and counts; it never converts a state or re-runs a step itself. The native engine is a whole
// Engine with its per-step fallback inside it: a step its core cannot run, it runs on the reference from the state's
// reference form and hands each outcome back as a native state where it can (`NativeProvider.engine` is total). So:
//
//   mode       createBattle(input)                                   every other call on `state`
//   showdown   reference                                             reference
//   native     native engine                                         native engine (it takes reference states too)
//   auto       native engine when supports(input).ok, else reference native engine when isNative(state), else reference
//
// `auto` is stateless after createBattle: a state says by its own form which engine takes it. An uncovered fight starts
// as a reference state and stays on Showdown; a covered one starts native and stays native while its states are. A
// state the native engine could not hold after a fallback step stays on Showdown with its subtree.
//
// Readers outside the engine (the trainer AI, the oracles, the order hint, the labeler) take reference states only:
// they read through `kit.reference`, and the AI through `referenceModel`.
//
// Every `expandTurn` is counted into the shared step counters (counters.ts) when the kit has them: `showdown` for a
// step sent straight to the reference, and for a step sent to the native engine the change in its own per-thread
// counts (`native` the core ran it, `fallback` the reference did). A step that throws is counted the same way and its
// error passes through untouched, except a step whose `shouldStop` already says stop as it begins: it still goes to its
// engine, which throws STOPPED before any work, and is not counted (it never ran). A panic in the native core is not
// caught: it fails the solve with its message. Every route hands expandTurn's options on as it was given them.
//
// The native engine is plugged in by native.ts; this file imports only contracts and takes both engines as values.

import { createHash } from 'node:crypto';
import type { AiMemory, EnemyModel } from '../contracts/ai.js';
import type { BattleInput, CarryState, Choice, Engine, EngineState, Outcome, Side } from '../contracts/engine.js';
import { FALLBACK, NATIVE, SHOWDOWN, type StepCounters } from './counters.js';

export type EngineMode = 'auto' | 'showdown' | 'native';
export const ENGINE_MODES: readonly EngineMode[] = ['auto', 'showdown', 'native'];
export const DEFAULT_ENGINE_MODE: EngineMode = 'showdown';
export const NATIVE_MISSING_NOTE = 'the native engine is not in this build';

/** `--engine`'s value (or ENGINE's) as a mode, else null. */
export function engineArg(raw: string): EngineMode | null {
  return (ENGINE_MODES as readonly string[]).includes(raw) ? (raw as EngineMode) : null;
}

/** What the selector needs of the native engine (src/engines/native.ts builds it; the tests pass a stub). */
export interface NativeProvider {
  /** Total: every call answers exactly as the reference would, for native and reference states alike. */
  readonly engine: Engine;
  /** The static forecast for a whole battle. May throw what the reference's createBattle throws. */
  supports(input: BattleInput): { ok: boolean; missing: string[] };
  isNative(state: EngineState): boolean;
  /** A native state as the reference engine's readers take it. Called only when isNative(state). */
  toReference(state: EngineState): EngineState;
  /** This thread's expandTurn counts so far, never decreasing: `native` the core ran, `fallback` the reference ran. */
  steps(): { native: number; fallback: number };
}

/** Mode auto or native asked of a thread that has no native engine (the mode was not resolved with resolveMode). */
export class NativeUnavailableError extends Error {
  readonly code = 'NATIVE_UNAVAILABLE';

  constructor(message = 'the native engine is not available on this thread') {
    super(message);
    this.name = 'NativeUnavailableError';
  }
}

/** The mode that runs for `requested`. Without a native engine, auto and native run as showdown, with the note. */
export function resolveMode(requested: EngineMode, nativeAvailable: boolean): { mode: EngineMode; note: string | null } {
  if (requested === 'showdown' || nativeAvailable) return { mode: requested, note: null };
  return { mode: 'showdown', note: NATIVE_MISSING_NOTE };
}

export interface SelectOptions {
  mode: EngineMode;                 // already resolved
  reference: Engine;                // showdownEngine
  native: NativeProvider | null;
  counters?: StepCounters;          // absent: nothing is counted
}

export interface EngineKit {
  readonly mode: EngineMode;
  readonly engine: Engine;
  /** Identity for a reference state; the provider's toReference, memoised per state object, for a native one. */
  reference(state: EngineState): EngineState;
  /** False in mode showdown: `reference` is the identity and readers need no wrapping. */
  readonly usesNative: boolean;
}

/** The most battle inputs whose forecast a kit keeps; the oldest is dropped first. */
const FORECASTS_KEPT = 256;

type Choices = { p1?: Choice; p2?: Choice };
/** expandTurn's options as the contract has them (maxLeaves, shouldStop): every route hands them on as it is given them. */
type StepOptions = Parameters<Engine['expandTurn']>[2];

const identity = (state: EngineState): EngineState => state;

/**
 * Whether a step's shouldStop already says stop as it begins (polled only when steps are counted). Its engine polls on
 * entry too and throws STOPPED before any work, so the step is not counted; a shouldStop that throws throws here as it
 * would there.
 */
const stoppedOnEntry = (o: StepOptions): boolean => o?.shouldStop?.() === true;

/** Throws NativeUnavailableError for mode auto or native with `native: null`. */
export function selectEngine(opts: SelectOptions): EngineKit {
  const { mode, reference, native, counters } = opts;
  if (!ENGINE_MODES.includes(mode)) throw new RangeError(`engine mode must be auto, showdown or native, got ${String(mode)}`);
  if (mode === 'showdown') return showdownKit(reference, counters);
  if (native === null) throw new NativeUnavailableError(`engine mode ${mode} needs the native engine, and this thread has none`);
  return nativeKit(mode, reference, native, counters);
}

/** Every call on the reference; with counters, each step counted as showdown. */
function showdownKit(reference: Engine, counters: StepCounters | undefined): EngineKit {
  if (counters === undefined) return { mode: 'showdown', engine: reference, reference: identity, usesNative: false };
  const engine: Engine = {
    get id(): string {
      return reference.id;
    },
    createBattle: (input: BattleInput): EngineState => reference.createBattle(input),
    legalChoices: (state: EngineState, side: Side): Choice[] => reference.legalChoices(state, side),
    expandTurn: (state: EngineState, choices: Choices, o?: StepOptions): Outcome[] => {
      if (!stoppedOnEntry(o)) counters.add(SHOWDOWN, 1);
      return reference.expandTurn(state, choices, o);
    },
    observe: (state: EngineState): string => reference.observe(state),
    carryOut: (state: EngineState): CarryState => reference.carryOut(state),
    unmodelledIn: (state: EngineState): string[] => reference.unmodelledIn(state),
    ...(reference.hpOf === undefined ? {} : { hpOf: (state: EngineState) => reference.hpOf!(state) }),
  };
  return { mode: 'showdown', engine, reference: identity, usesNative: false };
}

/** Mode auto or native: routed by the table at the top of the file. */
function nativeKit(mode: 'auto' | 'native', reference: Engine, native: NativeProvider, counters: StepCounters | undefined): EngineKit {
  const nativeEngine = native.engine;
  const auto = mode === 'auto';
  const forecasts = new Map<string, boolean>();

  /** Whether `input`'s battle starts on the native engine (auto: its forecast, asked once per input). */
  const startsNative = (input: BattleInput): boolean => {
    if (!auto) return true;
    const key = inputKey(input);
    const known = forecasts.get(key);
    if (known !== undefined) return known;
    let ok: boolean;
    try {
      ok = native.supports(input).ok;
    } catch {
      return false;   // not kept: the reference's createBattle throws the proper error
    }
    forecasts.set(key, ok);
    if (forecasts.size > FORECASTS_KEPT) {
      const oldest = forecasts.keys().next().value;
      if (oldest !== undefined) forecasts.delete(oldest);
    }
    return ok;
  };
  const onNative = (state: EngineState): boolean => !auto || native.isNative(state);
  const via = (state: EngineState): Engine => (onNative(state) ? nativeEngine : reference);

  const step = (state: EngineState, choices: Choices, o?: StepOptions): Outcome[] => {
    if (counters === undefined || stoppedOnEntry(o)) return via(state).expandTurn(state, choices, o);
    if (!onNative(state)) {
      counters.add(SHOWDOWN, 1);
      return reference.expandTurn(state, choices, o);
    }
    const before = native.steps();
    try {
      return nativeEngine.expandTurn(state, choices, o);
    } finally {
      const after = native.steps();
      counters.add(NATIVE, after.native - before.native);
      counters.add(FALLBACK, after.fallback - before.fallback);
    }
  };

  const hasHp = nativeEngine.hpOf !== undefined && (!auto || reference.hpOf !== undefined);
  const engine: Engine = {
    get id(): string {
      return auto ? `auto+${nativeEngine.id}` : nativeEngine.id;
    },
    createBattle: (input: BattleInput): EngineState => (startsNative(input) ? nativeEngine : reference).createBattle(input),
    legalChoices: (state: EngineState, side: Side): Choice[] => via(state).legalChoices(state, side),
    expandTurn: step,
    observe: (state: EngineState): string => via(state).observe(state),
    carryOut: (state: EngineState): CarryState => via(state).carryOut(state),
    unmodelledIn: (state: EngineState): string[] => via(state).unmodelledIn(state),
    ...(hasHp ? { hpOf: (state: EngineState) => via(state).hpOf!(state) } : {}),
  };

  const converted = new WeakMap<EngineState, EngineState>();
  const toReference = (state: EngineState): EngineState => {
    if (!native.isNative(state)) return state;
    let ref = converted.get(state);
    if (ref === undefined) {
      ref = native.toReference(state);
      converted.set(state, ref);
    }
    return ref;
  };

  return { mode, engine, reference: toReference, usesNative: true };
}

/** The forecast cache's key: the SHA-256 of the input's JSON, bigints as strings. */
function inputKey(input: BattleInput): string {
  const json = JSON.stringify(input, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
  return createHash('sha256').update(json).digest('hex');
}

/** `model` reading every state through `reference`: initialMemory, support and replacementSupport's state, and
 *  remember's `outcome.state` (a copy of the outcome only when the state changes). Same `id`. */
export function referenceModel(model: EnemyModel, reference: (state: EngineState) => EngineState): EnemyModel {
  return {
    get id(): string {
      return model.id;
    },
    initialMemory: (state: EngineState): AiMemory => model.initialMemory(reference(state)),
    support: (state: EngineState, memory: AiMemory) => model.support(reference(state), memory),
    replacementSupport: (state: EngineState, memory: AiMemory) => model.replacementSupport(reference(state), memory),
    remember: (memory: AiMemory, outcome: Outcome): AiMemory => {
      const state = reference(outcome.state);
      return model.remember(memory, state === outcome.state ? outcome : { ...outcome, state });
    },
  };
}
