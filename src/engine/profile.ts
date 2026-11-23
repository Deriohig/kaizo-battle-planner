// Opt-in timing of `expandTurn`'s leaves, for the throughput benchmark (scripts/benchEngine.ts). Off by
// default: then each probe is a function call that checks one module variable and returns 0, which is nothing next to
// a leaf (milliseconds). Not part of the engine's public index: only tools turn it on.
//
// A leaf's phases, in order (expand.ts and `snapshot` in battle.ts):
// - restore: `restoreShared(shared, driver)`, Showdown's `Battle.fromJSON` of the state (parsed once per step)
//   plus attaching the driver;
// - step: `applyChoices`, the choices checked and the turn run by Showdown and the mod;
// - snapshot: the reveals record folded in, `battle.toJSON()` and its JSON text (one `JSON.stringify` per Pokémon,
//   key.ts `serializedState`);
// - key: the canonical JSON (each Pokémon's looked up by its text) and its SHA-256, byte for byte `stateKey`'s;
// - leaf: the replay check and the leaf's outcome (path probability, omniscient log, observation, faints);
// - merge: the merge into the step's outcomes and the next script;
// - facts: for a leaf that becomes its class's kept leaf, its state's readers kept beside it (facts.ts).
// Time outside them (the phase of a snapshot, the outcomes' list and their sum) is the caller's to account for.

export type LeafPhase = 'restore' | 'step' | 'snapshot' | 'key' | 'leaf' | 'merge' | 'facts';

export const LEAF_PHASES: readonly LeafPhase[] = ['restore', 'step', 'snapshot', 'key', 'leaf', 'merge', 'facts'];

const zero = (): Record<LeafPhase, number> => ({ restore: 0, step: 0, snapshot: 0, key: 0, leaf: 0, merge: 0, facts: 0 });

/** Milliseconds spent in each phase, and the leaves timed, since `startLeafProfile`. */
export interface LeafProfile { leaves: number; ms: Record<LeafPhase, number> }

let profile: LeafProfile | null = null;

/** Starts timing leaves afresh. */
export function startLeafProfile(): void {
  profile = { leaves: 0, ms: zero() };
}

/** Stops timing leaves and returns what was timed (all zero if nothing was started). */
export function stopLeafProfile(): LeafProfile {
  const done = profile ?? { leaves: 0, ms: zero() };
  profile = null;
  return done;
}

/** The time now while profiling, else 0. */
export function mark(): number {
  return profile === null ? 0 : performance.now();
}

/** While profiling, adds the time since `since` (a `mark` or `lap`) to `phase` and returns the time now; else 0. */
export function lap(phase: LeafPhase, since: number): number {
  if (profile === null) return 0;
  const now = performance.now();
  profile.ms[phase] += now - since;
  return now;
}

/** While profiling, counts one leaf. */
export function countLeaf(): void {
  if (profile !== null) profile.leaves += 1;
}
