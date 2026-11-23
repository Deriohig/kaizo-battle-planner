// Which engine, AI and oracles the checker replays a line on (the checker reads the
// worker's store, with two guards). The checker itself is unchanged: it imports only the contracts and never sees the
// arena; this only picks what checkCertificate is given.
//
// - By default, the deps' own: over the real engine they are the worker's store (integration/deps.ts solverDeps), so
//   the check reuses the search's answers to exactly equal inputs.
// - config checkerBareEngine, with deps.bare: the unwrapped engine, AI and oracles.
// - config checkerCompare (tests and the bench only), with deps.bare: both, the deps' own first. When both walks finish
//   and anything they return differs (passed, the reason, the mismatches, the unmodelled entries, a figure or a count),
//   the result is the deps' own made a verificationMismatch whose first mismatch is 'store and bare checks differ: '
//   naming each field that differs (onDiffer hears the same text). A walk cut short (past its deadline, or the signal
//   aborted) is a timeout, never a difference: the first run cut short is returned as it is, uncompared. One run
//   throwing where the other finishes is a difference too (unless the other was cut short: then the throw
//   propagates); both throwing propagates the deps' own error.
// Without deps.bare both flags check once on the deps' own: there is no store to doubt.

import type { CheckInput, CheckResult } from './check/checker.js';
import { checkCertificate } from './check/checker.js';
import { exactText } from './store.js';
import type { SolverConfig, SolverDeps } from './types.js';

/** A checker call without the engine, the AI and the oracles, which runChecker picks. */
export type CheckCall = Omit<CheckInput, 'engine' | 'enemyModel' | 'oracles'>;

/** The text that opens a store-and-bare difference (the verdict's detail starts with it). */
export const STORE_DIFFERS = 'store and bare checks differ: ';

type On = Pick<CheckInput, 'engine' | 'enemyModel' | 'oracles'>;
type Run = { result: CheckResult; cut: boolean } | { error: unknown };

/** One check on `on`, with whether it was cut short (any clock reading past the deadline, or the signal aborted). */
function attempt(call: CheckCall, on: On): Run {
  let late = false;
  const now = (): number => {
    const t = call.now();
    if (t > call.deadline) late = true;
    return t;
  };
  try {
    const result = checkCertificate({ ...call, ...on, now });
    return { result, cut: late || call.signal?.aborted === true };
  } catch (error) {
    return { error };
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function textOf(value: unknown): string {
  try {
    return exactText(value);
  } catch {
    return String(value);
  }
}

function clip(text: string): string {
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
}

/** Each field of two check results that differs, named with both values (the store's first). */
function differences(store: CheckResult, bare: CheckResult): string[] {
  const fields = [...new Set([...Object.keys(store), ...Object.keys(bare)])].sort();
  const out: string[] = [];
  for (const field of fields) {
    const [a, b] = [textOf((store as unknown as Record<string, unknown>)[field]), textOf((bare as unknown as Record<string, unknown>)[field])];
    if (a !== b) out.push(`${field} ${clip(a)} on the store, ${clip(b)} bare`);
  }
  return out;
}

function differing(base: CheckResult, what: string[], onDiffer: ((detail: string) => void) | undefined): CheckResult {
  const detail = `${STORE_DIFFERS}${what.join('; ')}`;
  onDiffer?.(detail);
  return { ...base, passed: false, reason: 'verificationMismatch', mismatches: [detail, ...base.mismatches] };
}

/** checkCertificate on the engine, AI and oracles `cfg` picks from `deps` (see the top of the file). */
export function runChecker(deps: Pick<SolverDeps, 'engine' | 'enemyModel' | 'oracles' | 'bare'>, cfg: Pick<SolverConfig, 'checkerBareEngine' | 'checkerCompare'>,
  call: CheckCall, onDiffer?: (detail: string) => void): CheckResult {
  const own: On = { engine: deps.engine, enemyModel: deps.enemyModel, oracles: deps.oracles };
  const { bare } = deps;
  if (bare === undefined || (!cfg.checkerCompare && !cfg.checkerBareEngine)) return checkCertificate({ ...call, ...own });
  if (!cfg.checkerCompare) return checkCertificate({ ...call, ...bare });
  const a = attempt(call, own);
  if ('result' in a && a.cut) return a.result;
  const b = attempt(call, bare);
  if ('error' in a) {
    if ('error' in b || b.cut) throw a.error;
    return differing(b.result, [`the store's check threw (${clip(messageOf(a.error))}), the bare check did not`], onDiffer);
  }
  if ('error' in b) return differing(a.result, [`the bare check threw (${clip(messageOf(b.error))}), the store's did not`], onDiffer);
  if (b.cut) return b.result;
  const what = differences(a.result, b.result);
  return what.length === 0 ? a.result : differing(a.result, what, onDiffer);
}
