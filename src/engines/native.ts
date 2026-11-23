// The plug-in point for the native engine. This is the one file that will import `src/native`; the
// selector (select.ts) takes the provider built here as a value and never imports the native module itself.
//
// Today this build has no native engine: `nativeAvailable()` is false and `nativeFor()` is null, so the server
// resolves auto and native to showdown (resolveMode, with NATIVE_MISSING_NOTE) before anything is built.
//
// WHAT PLUGS IN HERE (when stage 1 of the native engine, `src/native`, lands; nothing else here
// changes):
//
//   import { createNativeEngine, isNativeState, loadAddon, nativeStats, toReference } from '../native/index.js';
//   nativeAvailable(): try { loadAddon(); return true; } catch { return false; }   (kept once per thread)
//   nativeFor(inputs): const engine = createNativeEngine({ reference, data, moves: moves as Map<number, KaizoMove> });
//     return { engine, supports: (input) => engine.supports(input), isNative: isNativeState, toReference,
//              steps: () => { const s = nativeStats(); return { native: s.nativeSteps, fallback: s.fallbackSteps + s.referenceSteps }; } };

import type { KaizoMove } from '../battle/moves.js';
import type { LoadedData } from '../battle/types.js';
import type { Engine } from '../contracts/engine.js';
import type { NativeProvider } from './select.js';

export interface NativeInputs { reference: Engine; data: LoadedData; moves: ReadonlyMap<number, KaizoMove> }

/** Whether this build has a native engine that loads. Today: false. */
export function nativeAvailable(): boolean {
  return false;
}

/** This thread's provider over `inputs` (one per thread and data), or null. Today: null. */
export function nativeFor(_inputs: NativeInputs): NativeProvider | null {
  return null;
}
