// The check of a kept battle against a restore of its state.
// `expandTurn` hands a kept leaf's
// live battle to `peek` (facts.ts `keepLive`); under test, `peek` compares that battle with `restore(state)` on its first
// peek, with `peekDifferences`, and throws on any difference. Not exported from index.ts: the engine and its tests only.
//
// The walk compares both battles' whole object graphs, stricter than any reader:
// - own property names, enumerable or not, and their order;
// - prototypes;
// - primitive values by `Object.is` (so `-0`, `NaN`, and `undefined` against a missing key all count);
// - the shape of shared references: an object met twice in one graph must be met at the same two places in the other;
// - functions by source text, `Set`s by their members in order (a `Map` or a symbol key is reported, never compared);
// - an object that is not the battle's own (the dex, the format, a dex entry) must be the same object: a frozen object
//   with a class prototype other than the battle's own classes is a dex entry. An active-move copy (not frozen, an own
//   `hit`) is the battle's own.
//
// `battleDiff` is the raw walk: it reports everything, the three classes a restore is known to differ in among them
// (`differenceClass`). `peekDifferences` is the walk with `peek`'s read rule built in (facts.ts `peek`), so it reports
// only what a reader that keeps the rule could see:
// - A. Inside an active-move copy (`battle.lastMove`, `pokemon.lastMove`, `lastMoveUsed`, an effect state's
//   `sourceEffect`, a queued action's `move`) only `id`, `num` and `name` are compared, and its identity is not: a
//   restore gives each place its own copy, rebuilt from the dex move (Showdown 0.11.11 dist/sim/state.js:238-252), where
//   the live battle shares one and holds keys the step set or deleted.
// - U. Inside a queued action, or inside an effect state held in a condition map (`sideConditions`, `slotConditions`,
//   `pseudoWeather`, `volatiles`), a key holding `undefined` equals a missing key: `JSON` drops it (a queued action's
//   `zmove`, a hazard's `duration`). So do a Pokémon's three staleness keys, Showdown's endless-battle bookkeeping,
//   which `eatItem`, `useItem` and `clearVolatile` set to `undefined` and nothing in the engine or the trainer AI reads.
//   Nowhere else: the condition maps' own keys in particular are compared strictly,
//   because the engine's `observe` lists `sideConditions` and `pseudoWeather` by key (observe.ts `sideConditions`,
//   `observe`), so a condition ID holding `undefined` would change what it sees.
// - S. A plain array of primitives is compared by value, never by identity: Showdown's `setType` keeps the array it is
//   given (sim/pokemon.ts `setType`), so two Pokémon can hold one species' `types` array live and two copies restored.

/** What kind of difference the walk found at a path. */
export type DifferenceKind =
  | 'value' | 'absent' | 'undefinedKey' | 'shared' | 'prototype' | 'frozenEntry' | 'function' | 'set' | 'map'
  | 'nonEnumerable' | 'keyOrder' | 'symbols';

/** One difference between a live battle (`live`) and a restore (`restored`) at `path`. */
export interface Difference {
  readonly path: string;
  readonly kind: DifferenceKind;
  readonly live: string;
  readonly restored: string;
  /** At or inside an active-move copy. */
  readonly activeMove: boolean;
  /** A shared reference to a plain array of primitives on both sides. */
  readonly primitiveArray: boolean;
  /** A key holding `undefined` against a missing one where the read rule allows it (U: `undefinedAllowedIn`). */
  readonly undefinedAllowed: boolean;
}

const proto = (value: object): object | null => Object.getPrototypeOf(value) as object | null;
const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** A short text for a value in a difference. */
function show(value: unknown): string {
  if (value === undefined) return '<undefined>';
  if (typeof value === 'function') return `<fn ${value.name}>`;
  if (typeof value === 'object' && value !== null) {
    const name = proto(value)?.constructor?.name ?? 'null-proto';
    const id = (value as { id?: unknown }).id;
    return `<${name}${typeof id === 'string' ? `:${id}` : ''}${Array.isArray(value) ? ` len ${value.length}` : ''}>`;
  }
  if (typeof value === 'bigint') return `${value}n`;
  return Object.is(value, -0) ? '-0' : JSON.stringify(value) ?? String(value);
}

/** An active-move copy: a `Move`-prototyped object that is not a frozen dex entry and has its own `hit` (`getActiveMove`). */
export function isActiveMove(value: object): boolean {
  const name = proto(value)?.constructor?.name;
  return name !== 'Object' && name !== 'Array' && !Object.isFrozen(value) && hasOwn(value, 'hit');
}

/** A plain array whose elements are all primitives. */
function isPrimitiveArray(value: object): boolean {
  return Array.isArray(value) && proto(value) === Array.prototype
    && value.every((element: unknown) => element === null || (typeof element !== 'object' && typeof element !== 'function'));
}

/** The classes of a battle's own objects: frozen ones (a frozen peeked battle) are walked, never taken for dex entries. */
const OWN_CLASSES: ReadonlySet<string | undefined> = new Set(['Battle', 'Side', 'Pokemon', 'Field', 'BattleQueue', 'Object', 'Array']);

/** A name for a battle's own objects that does not depend on how the walk reached them. */
function canonical(value: object): string | null {
  const name = proto(value)?.constructor?.name;
  if (name === 'Pokemon') return `mon(${(value as { side: { id: string } }).side.id}#${(value as { position: number }).position})`;
  if (name === 'Side') return `side(${(value as { id: string }).id})`;
  if (name === 'Field') return 'field';
  if (name === 'BattleQueue') return 'queue';
  return null;
}

/**
 * The objects whose keys may hold `undefined` where a restore has none (U): a queued action, and an effect state held in a
 * condition map. By the walk's path: `queue` is the battle's queue, `side(p1)`, `mon(p1#0)` and `field` its own objects.
 */
const UNDEFINED_ALLOWED: readonly RegExp[] = [
  /^queue\.list\[\d+\]$/, /\.(?:sideConditions|pseudoWeather|volatiles)\.[^.[\]]+$/, /\.slotConditions\[\d+\]\.[^.[\]]+$/,
];

/**
 * A Pokémon's own keys that may hold `undefined` where a restore has none (U): Showdown's endless-battle bookkeeping,
 * which `eatItem`, `useItem` and `clearVolatile` set to `undefined` (dist/sim/pokemon.js; `runMove`'s
 * `volatileStaleness`, dist/sim/battle.js). Nothing in the engine or the trainer AI reads them.
 */
const POKEMON_UNDEFINED_ALLOWED: ReadonlySet<string> = new Set(['staleness', 'pendingStaleness', 'volatileStaleness']);

/** Whether the object at `path` may hold a key with `undefined` that a restore lacks (U). */
export function undefinedAllowedIn(path: string): boolean {
  return UNDEFINED_ALLOWED.some((pattern) => pattern.test(path));
}

const ABSENT = Symbol('absent');
/** The keys `peekDifferences` compares inside an active-move copy (the read rule's). */
const MOVE_KEYS = ['id', 'num', 'name'] as const;

/**
 * Every difference between the object graphs of `live` and `restored` (see the top of this file), at most `limit`
 * (default 400). With `rule`, the read rule's three allowances apply (`peekDifferences`).
 */
export function battleDiff(live: object, restored: object, opts: { limit?: number; rule?: boolean } = {}): Difference[] {
  const limit = opts.limit ?? 400;
  const rule = opts.rule === true;
  const found: Difference[] = [];
  const seenLive = new Map<object, string>();
  const seenRestored = new Map<object, string>();
  const push = (path: string, kind: DifferenceKind, a: string, b: string, activeMove: boolean, primitiveArray = false, undefinedAllowed = false): void => {
    if (found.length < limit) found.push({ path, kind, live: a, restored: b, activeMove, primitiveArray, undefinedAllowed });
  };
  /** `lenient`: the key is one of an object whose keys may hold `undefined` (`undefinedAllowedIn`). */
  const walk = (x: unknown, y: unknown, at: string, inMove: boolean, lenient: boolean): void => {
    if (found.length >= limit) return;
    if (x === ABSENT || y === ABSENT) {
      const other = x === ABSENT ? y : x;
      if (rule && other === undefined && lenient) return; // U
      const kind = other === undefined ? 'undefinedKey' : 'absent';
      push(at, kind, x === ABSENT ? '<absent>' : show(x), y === ABSENT ? '<absent>' : show(y), inMove, false, other === undefined && lenient);
      return;
    }
    if (typeof x === 'function' && typeof y === 'function') {
      if (x !== y && x.toString() !== y.toString()) push(at, 'function', show(x), `${show(y)} (other source)`, inMove);
      return;
    }
    if (typeof x !== 'object' || x === null || typeof y !== 'object' || y === null) {
      if (!Object.is(x, y)) push(at, 'value', show(x), show(y), inMove);
      return;
    }
    const move = isActiveMove(x) || isActiveMove(y);
    const inside = inMove || move;
    const named = canonical(x);
    const path = move ? `${at}{ActiveMove}` : named ?? at;
    if (rule && move) { // A: the promised keys only, identity ignored
      if (!isActiveMove(x) || !isActiveMove(y)) {
        push(path, 'prototype', show(x), show(y), true);
        return;
      }
      for (const key of MOVE_KEYS) walk((x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key], `${path}.${key}`, true, false);
      return;
    }
    if (rule && isPrimitiveArray(x) && isPrimitiveArray(y)) { // S: by value
      const [a, b] = [x as unknown[], y as unknown[]];
      if (a.length !== b.length) push(`${path}.length`, 'value', String(a.length), String(b.length), inside);
      for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`, inside, false);
      return;
    }
    const [sx, sy] = [seenLive.get(x), seenRestored.get(y)];
    if (sx !== undefined || sy !== undefined) {
      if (sx !== sy) push(`${path} (shared reference)`, 'shared', sx ?? 'first met here', sy ?? 'first met here', inside, isPrimitiveArray(x) && isPrimitiveArray(y));
      return;
    }
    seenLive.set(x, path);
    seenRestored.set(y, path);
    if (proto(x) !== proto(y)) {
      push(`${path} (prototype)`, 'prototype', show(x), show(y), inside);
      return;
    }
    if (x === y) return; // one shared object: the dex, the format, a dex entry
    if (Object.isFrozen(x) && Object.isFrozen(y) && proto(x) !== null && !OWN_CLASSES.has(proto(x)?.constructor?.name)) {
      push(`${path} (frozen entry identity)`, 'frozenEntry', show(x), show(y), inside);
      return;
    }
    if (x instanceof Set && y instanceof Set) {
      const [mx, my] = [[...x].map(show).join(','), [...y].map(show).join(',')];
      if (mx !== my) push(`${path} (set)`, 'set', mx, my, inside);
      return;
    }
    if (x instanceof Map || x instanceof WeakMap || x instanceof WeakSet) {
      push(`${path} (map: not compared)`, 'map', show(x), show(y), inside);
      return;
    }
    const [kx, ky] = [Object.getOwnPropertyNames(x), Object.getOwnPropertyNames(y)];
    const [ex, ey] = [Object.keys(x), Object.keys(y)];
    if (kx.length !== ex.length || ky.length !== ey.length) {
      const hidden = (all: string[], shown: string[]): string => all.filter((key) => !shown.includes(key) && !(Array.isArray(x) && key === 'length')).join(',');
      const [hx, hy] = [hidden(kx, ex), hidden(ky, ey)];
      if (hx !== hy) push(`${path} (non-enumerable)`, 'nonEnumerable', hx, hy, inside);
    }
    if (kx.join('\u0000') !== ky.join('\u0000')) {
      const [onlyX, onlyY] = [kx.filter((key) => !ky.includes(key)), ky.filter((key) => !kx.includes(key))];
      if (onlyX.length === 0 && onlyY.length === 0) push(`${path} (key order)`, 'keyOrder', kx.join(','), ky.join(','), inside);
    }
    const lenientKeys = undefinedAllowedIn(path);
    const pokemon = named?.startsWith('mon(') === true;
    for (const key of new Set([...kx, ...ky])) {
      const child = Array.isArray(x) && /^\d+$/.test(key) ? `${path}[${key}]` : `${path}.${key}`;
      const lenient = lenientKeys || (pokemon && POKEMON_UNDEFINED_ALLOWED.has(key));
      walk(hasOwn(x, key) ? (x as Record<string, unknown>)[key] : ABSENT, hasOwn(y, key) ? (y as Record<string, unknown>)[key] : ABSENT, child, inside, lenient);
    }
    const [symbolsX, symbolsY] = [Object.getOwnPropertySymbols(x).length, Object.getOwnPropertySymbols(y).length];
    if (symbolsX + symbolsY > 0) push(`${path} (symbols: not compared)`, 'symbols', String(symbolsX), String(symbolsY), inside);
  };
  walk(live, restored, 'battle', false, false);
  return found;
}

/**
 * The differences between a kept battle (`live`) and `restored`, a restore of its state, that a reader keeping `peek`'s
 * read rule could see (the top of this file: the raw walk less classes A, U and S), at most `limit`.
 */
export function peekDifferences(live: Battle, restored: Battle, limit = 5): Difference[] {
  return battleDiff(live, restored, { limit, rule: true });
}

/**
 * Which of the three known classes a raw difference (`battleDiff` without `rule`) falls in: A (at or inside an
 * active-move copy), U (a key holding `undefined` against a missing one, where `undefinedAllowedIn` allows it), S (one
 * plain array of primitives held in two places on one side only), or null for any other.
 */
export function differenceClass(difference: Difference): 'A' | 'U' | 'S' | null {
  if (difference.activeMove) return 'A';
  if (difference.kind === 'undefinedKey' && difference.undefinedAllowed) return 'U';
  if (difference.kind === 'shared' && difference.primitiveArray) return 'S';
  return null;
}

/** A path with its indices and per-Pokémon parts generalised, to group differences. */
export function pattern(path: string): string {
  return path.replace(/\[\d+\]/g, '[]').replace(/mon\(p[12]#\d\)/g, 'mon').replace(/side\(p[12]\)/g, 'side');
}

/** `differences` as one line each, for an error message: path, kind, live value and restored value. */
export function describeDifferences(differences: readonly Difference[]): string {
  return differences.map((d) => `${d.path} [${d.kind}]: live ${d.live}, restored ${d.restored}`).join('; ');
}
