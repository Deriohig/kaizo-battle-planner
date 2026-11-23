// JSON conversion for the API (contract rules in `src/contracts/api.ts`): a Rational travels as "num/den", bigint never
// appears in JSON, and a StartStatus travels as its status string (`sleep:<n>`, `poison`, `toxic`, `burn`, `freeze`,
// `paralysis`), with null for no status. Pure: no Node imports, so the page's tests can use it too.

import type { UndrawnSleep } from '../contracts/engine.js';
import type { RationalJson } from './apiTypes.js';
import type { Rational } from '../contracts/engine.js';
import type { StartStatus } from '../save/status.js';

export function rationalJson(r: Rational): RationalJson {
  return `${r.num}/${r.den}`;
}

/** A deep copy with every `{ num: bigint; den: bigint }` as "num/den". Any other bigint throws a TypeError naming its path. */
export function toJsonValue(value: unknown): unknown {
  return convert(value, '');
}

export function statusToJson(s: StartStatus | UndrawnSleep): string | null {
  switch (s.kind) {
    case 'none': return null;
    case 'sleep': return `sleep:${s.turns}`;
    case 'sleepUndrawn': return `sleepUndrawn:${s.attempts}`;
    default: return s.kind;
  }
}

const NAMED_STATUSES = new Set(['poison', 'toxic', 'burn', 'freeze', 'paralysis']);

/** Parses a status string: `sleep:1` to `sleep:7`, `poison`, `toxic`, `burn`, `freeze` or `paralysis`; null for anything else. */
export function statusFromJson(s: string): StartStatus | null {
  const sleep = /^sleep:([1-7])$/.exec(s);
  if (sleep) return { kind: 'sleep', turns: Number(sleep[1]) };
  return NAMED_STATUSES.has(s) ? ({ kind: s } as StartStatus) : null;
}

function isRational(value: object): value is Rational {
  const keys = Object.keys(value);
  return keys.length === 2 && typeof (value as Partial<Rational>).num === 'bigint'
    && typeof (value as Partial<Rational>).den === 'bigint';
}

function child(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path === '' ? key : `${path}.${key}`;
}

function convert(value: unknown, path: string): unknown {
  if (typeof value === 'bigint') {
    throw new TypeError(`A bigint outside a Rational cannot go into JSON, at ${path === '' ? '(root)' : path}`);
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item, i) => convert(item, child(path, i)));
  if (isRational(value)) return rationalJson(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = convert(item, child(path, key));
  return out;
}
