// One store of the engine's and the AI's answers per worker. createResultStore wraps an Engine and an EnemyModel in an Engine and an EnemyModel
// that answer a call from the store when every input of it equals a stored call's, and otherwise ask the wrapped one and
// keep its answer. Callers do not know it is there: the arena keeps its own edge cache on top, keyed as before, and the
// checker reads the store too (checkerBareEngine and checkerCompare are its guards). The crit
// cap, the crit count and the level never reach the engine or the AI, so no game's parameters enter a key, and every
// game on one deps object (tier 1, each G_j, the ranking, the badge, the checker) shares the answers.
//
// Stored, as pure functions of their arguments (the contracts say so; nothing they read depends on the clock or on
// randomness): Engine.expandTurn, legalChoices, carryOut and hpOf (only when the wrapped engine has it), and
// EnemyModel.support, replacementSupport and remember. Passed through every time, unstored: the ids (getters, read
// when asked), createBattle, observe, unmodelledIn and initialMemory (once per battle start, cheap).
//
// The key is every argument the call gets, whatever the interface takes; trailing undefined arguments are dropped, as
// an optional parameter reads them the same way:
// - an EngineState: its `json` compared by ===, and the rest of the object (turn, phase, key and anything else it
//   carries) as exact text;
// - remember's Outcome: its state as above, its `log` compared line by line, and the rest of it (probability, labels,
//   critBy, unlabelled, observation, fainted, merged and anything else) as exact text;
// - expandTurn's options: every field but `shouldStop` as exact text. shouldStop changes no answer
//   (a call it does not stop returns what it returns without it), so it is never part of a key: a call with it and the
//   same call without it share one entry, and on a miss the call reaches the engine with its own options, shouldStop
//   included. A field set to undefined is left out, as the engine reads it like an absent one (`maxLeaves: undefined`
//   is the engine's own limit), and an options object with nothing left in it reads as none, like an absent last
//   argument.
// - every other argument (the choices, the side, an AiMemory with its key and its data) as exact text.
// Exact text (exactText) is canonical JSON made injective: object keys sorted at every level, and undefined, -0, NaN,
// the infinities and bigints written apart. An argument it cannot write exactly (a Map, a Set, a class instance, a
// function, an array with holes or extra properties, a symbol key, nesting past MAX_DEPTH) makes the call pass through,
// unstored. A hit needs every part equal; the hash only indexes (opts.hash, the tests' seam; by default the index text
// itself, made of the method, each state's key, the other arguments' exact texts and a hash of each state's json, so
// that one position reached by many steps, one key with many jsons, spreads over many buckets instead of one).
//
// A throw is never stored: the next call asks again (a stopped call too: its engine threw STOPPED). Answers are shared:
// every caller gets the same object, so nothing may change a returned outcome, state, support, choice, carry or memory.
// The arena, the checker and the rest of src/solver never do, and the tests pass opts.freeze, which
// deep-freezes every stored answer so that a write throws. Production does not freeze: it costs time.
//
// Bounded by bytes: an entry's size is twice the UTF-16 length (2 bytes per code unit) of its key texts and its
// answer's JSON (jsonLength: strings counted unescaped). Past opts.maxBytes the least recently used entries go first;
// an entry bigger than maxBytes on its own is not stored. A state's json is counted in every entry that holds it, so
// the bound overstates the memory the store keeps alive. Stats: hits, misses (every call that reached the wrapped
// engine or AI: a throw and an unkeyable call too), the bytes held and the evictions. The bound is set when the store
// is made (integration/deps.ts solverDeps' option, default DEFAULT_RESULT_STORE_BYTES), never by a solve's config:
// the deps and their store exist before any solve's config reaches them.

import type { EnemyModel } from '../contracts/ai.js';
import type { Engine } from '../contracts/engine.js';

/** The calls the store keeps answers for. */
export type StoredMethod = 'expandTurn' | 'legalChoices' | 'carryOut' | 'hpOf' | 'support' | 'replacementSupport' | 'remember';

/** The store's default byte bound per deps object, so per worker context: 256 MiB (solverDeps' `storeBytes`). */
export const DEFAULT_RESULT_STORE_BYTES = 268_435_456;

export interface StoreOptions {
  maxBytes: number;
  freeze?: boolean;                                               // deep-freeze stored answers (the tests): a write throws
  hash?: (text: string) => string;                                // the tests' seam: the bucket of an index text and its states' json hashes (default: that text)
  tamper?: (method: StoredMethod, answer: unknown) => unknown;    // the tests' seam: a wrong store, rewriting an answer as it is stored
}

export interface StoreStats { hits: number; misses: number; bytes: number; evictions: number }

/** An argument the store cannot write exactly: the call passes through. */
class Unkeyable extends Error {}

/** How one argument enters the key: `expandOpts` is expandTurn's options (see the top of the file). */
type ArgKind = 'state' | 'outcome' | 'expandOpts' | 'plain';

/** A key part: a text compared by ===, or lines compared one by one. */
type Part = string | readonly string[];

interface Key { bucket: string; parts: Part[]; length: number }

interface Entry { bucket: string; parts: Part[]; answer: unknown; bytes: number }

/** Nested deeper than this, an argument or an answer is refused (a cycle would never end). */
const MAX_DEPTH = 200;

function plainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Canonical, injective text of plain data: object keys sorted at every level; undefined 'u', null 'n', booleans 't' and
 * 'f', numbers as String() gives them but -0 as '-0', bigints with a trailing 'n', strings as JSON. Throws Unkeyable for
 * anything else (see the top of the file).
 */
export function exactText(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new Unkeyable('nested too deeply');
  switch (typeof value) {
    case 'undefined': return 'u';
    case 'boolean': return value ? 't' : 'f';
    case 'number': return Object.is(value, -0) ? '-0' : String(value);
    case 'bigint': return `${value}n`;
    case 'string': return JSON.stringify(value);
    case 'object': {
      if (value === null) return 'n';
      if (Object.getOwnPropertySymbols(value).length > 0) throw new Unkeyable('a symbol key');
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) throw new Unkeyable('an array with holes or extra properties');
        let out = '[';
        for (let i = 0; i < value.length; i++) out += (i === 0 ? '' : ',') + exactText(value[i], depth + 1);
        return `${out}]`;
      }
      if (!plainObject(value)) throw new Unkeyable('not plain data');
      const record = value as Record<string, unknown>;
      let out = '{';
      let first = true;
      for (const k of Object.keys(record).sort()) {
        out += `${first ? '' : ','}${JSON.stringify(k)}:${exactText(record[k], depth + 1)}`;
        first = false;
      }
      return `${out}}`;
    }
    default: throw new Unkeyable(`a ${typeof value}`);
  }
}

/** The UTF-16 length of `value`'s JSON, strings counted unescaped (the store's size of an answer). */
function jsonLength(value: unknown, depth = 0): number {
  if (depth > MAX_DEPTH) throw new Unkeyable('nested too deeply');
  switch (typeof value) {
    case 'string': return value.length + 2;
    case 'number':
    case 'bigint': return String(value).length;
    case 'boolean': return value ? 4 : 5;
    case 'object': {
      if (value === null) return 4;
      if (Array.isArray(value)) {
        let n = 2 + Math.max(0, value.length - 1);
        for (const item of value) n += jsonLength(item, depth + 1);
        return n;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      let n = 2 + Math.max(0, keys.length - 1);
      for (const k of keys) n += k.length + 3 + jsonLength(record[k], depth + 1);
      return n;
    }
    default: return 0;
  }
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const v of Object.values(value)) deepFreeze(v);
}

/** 32-bit FNV-1a of `text` as 8 hex digits: a bucket index only, never equality. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Each state object's json hash, made once (a state is immutable; a stale hash could only cost a miss: equality decides). */
const jsonHashes = new WeakMap<object, string>();

function jsonHash(state: object, json: string): string {
  let h = jsonHashes.get(state);
  if (h === undefined) {
    h = fnv1a(json);
    jsonHashes.set(state, h);
  }
  return h;
}

/** A state argument's parts: its json (===) and the rest as exact text; the index gets its key, the bucket its json's hash. */
function stateKey(state: unknown): { index: string; hash: string; parts: Part[] } {
  if (typeof state !== 'object' || state === null || !plainObject(state)) throw new Unkeyable('a state that is not plain data');
  const { json, ...rest } = state as Record<string, unknown>;
  if (typeof json !== 'string') throw new Unkeyable('a state without a json text');
  const key = (rest as { key?: unknown }).key;
  return { index: `S${typeof key === 'string' ? key : ''}`, hash: jsonHash(state, json), parts: [json, exactText(rest)] };
}

/** remember's outcome: its state's parts, its log line by line (a copy), and the rest as exact text. */
function outcomeKey(outcome: unknown): { index: string; hash: string; parts: Part[] } {
  if (typeof outcome !== 'object' || outcome === null || !plainObject(outcome)) throw new Unkeyable('an outcome that is not plain data');
  const { state, log, ...rest } = outcome as Record<string, unknown>;
  if (!Array.isArray(log) || log.some((line) => typeof line !== 'string')) throw new Unkeyable('an outcome log that is not lines');
  const s = stateKey(state);
  return { index: `O${s.index}`, hash: s.hash, parts: [...s.parts, [...(log as string[])], exactText(rest)] };
}

/** Whether expandTurn's options hold nothing but `shouldStop` and undefined fields: they read as none (see the top). */
function noOptions(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !plainObject(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.keys(record).every((k) => k === 'shouldStop' || record[k] === undefined);
}

/**
 * expandTurn's options without `shouldStop` and without the fields set to undefined, for exactText (see the top of the
 * file); anything but a plain object as it is (exactText decides).
 */
function withoutStop(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !plainObject(value)) return value;
  const { shouldStop: _stop, ...rest } = value as Record<string | symbol, unknown>;
  for (const k of Object.keys(rest)) if (rest[k] === undefined) delete rest[k];
  return rest;
}

function partLength(part: Part): number {
  if (typeof part === 'string') return part.length;
  let n = 0;
  for (const line of part) n += line.length;
  return n;
}

function samePart(a: Part, b: Part): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameParts(a: readonly Part[], b: readonly Part[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!samePart(a[i]!, b[i]!)) return false;
  return true;
}

const statsOf = new WeakMap<object, () => StoreStats>();

/** The stats of the store whose wrapper `engineOrAi` is (createResultStore's engine or ai); null for anything else. */
export function resultStoreStats(engineOrAi: Engine | EnemyModel): StoreStats | null {
  return statsOf.get(engineOrAi)?.() ?? null;
}

const STATE: readonly ArgKind[] = ['state'];
const STATE_PLAIN: readonly ArgKind[] = ['state', 'plain'];
const EXPAND: readonly ArgKind[] = ['state', 'plain', 'expandOpts'];
const MEMORY_OUTCOME: readonly ArgKind[] = ['plain', 'outcome'];

/** `engine` and `ai` behind one store (see the top of the file). */
export function createResultStore(engine: Engine, ai: EnemyModel, opts: StoreOptions): { engine: Engine; ai: EnemyModel; stats(): StoreStats } {
  if (!(Number.isInteger(opts.maxBytes) && opts.maxBytes >= 0)) throw new RangeError(`store: maxBytes must be a non-negative integer, got ${opts.maxBytes}`);
  const hash = opts.hash ?? ((text: string) => text);
  const buckets = new Map<string, Entry[]>();
  const recent = new Set<Entry>();   // least recently used first
  const stats: StoreStats = { hits: 0, misses: 0, bytes: 0, evictions: 0 };

  /**
   * The call's key: the index text (method, each state's key, the other arguments' exact texts) first, then the heavy
   * parts; its bucket indexes the index text and each state's json hash (see the top of the file).
   */
  function keyOf(method: StoredMethod, kinds: readonly ArgKind[], args: readonly unknown[]): Key {
    let n = args.length;
    while (n > 0 && args[n - 1] === undefined) n -= 1;
    if (n > 0 && kinds[n - 1] === 'expandOpts' && noOptions(args[n - 1])) n -= 1;
    let index = method;
    let hashes = '';
    const heavy: Part[] = [];
    for (let i = 0; i < n; i++) {
      const kind = kinds[i] ?? 'plain';
      if (kind === 'plain' || kind === 'expandOpts') {
        index += `\u0000${exactText(kind === 'plain' ? args[i] : withoutStop(args[i]))}`;
        continue;
      }
      const k = kind === 'state' ? stateKey(args[i]) : outcomeKey(args[i]);
      index += `\u0000${k.index}`;
      hashes += `\u0000${k.hash}`;
      heavy.push(...k.parts);
    }
    const parts = [index, ...heavy];
    return { bucket: hash(`${index}\u0001${hashes}`), parts, length: parts.reduce((sum: number, p) => sum + partLength(p), 0) };
  }

  function find(key: Key): Entry | null {
    for (const entry of buckets.get(key.bucket) ?? []) if (sameParts(entry.parts, key.parts)) return entry;
    return null;
  }

  function drop(entry: Entry): void {
    recent.delete(entry);
    const list = buckets.get(entry.bucket)!;
    list.splice(list.indexOf(entry), 1);
    if (list.length === 0) buckets.delete(entry.bucket);
    stats.bytes -= entry.bytes;
  }

  function keep(key: Key, answer: unknown): void {
    let bytes: number;
    try {
      bytes = 2 * (key.length + jsonLength(answer));
    } catch (e) {
      if (e instanceof Unkeyable) return;
      throw e;
    }
    if (bytes > opts.maxBytes) return;
    if (opts.freeze === true) deepFreeze(answer);
    const entry: Entry = { bucket: key.bucket, parts: key.parts, answer, bytes };
    const list = buckets.get(key.bucket);
    if (list === undefined) buckets.set(key.bucket, [entry]);
    else list.push(entry);
    recent.add(entry);
    stats.bytes += bytes;
    while (stats.bytes > opts.maxBytes) {
      drop(recent.values().next().value!);
      stats.evictions += 1;
    }
  }

  function call<R>(method: StoredMethod, kinds: readonly ArgKind[], args: readonly unknown[], ask: () => R): R {
    let key: Key | null = null;
    try {
      key = keyOf(method, kinds, args);
    } catch (e) {
      if (!(e instanceof Unkeyable)) throw e;
    }
    if (key !== null) {
      const hit = find(key);
      if (hit !== null) {
        recent.delete(hit);
        recent.add(hit);
        stats.hits += 1;
        return hit.answer as R;
      }
    }
    stats.misses += 1;
    let answer = ask();   // a throw propagates and nothing is stored
    if (opts.tamper !== undefined) answer = opts.tamper(method, answer) as R;
    if (key !== null) keep(key, answer);
    return answer;
  }

  const { hpOf } = engine;
  const storedEngine: Engine = {
    get id() {
      return engine.id;
    },
    createBattle: (...args) => engine.createBattle(...args),
    legalChoices: (...args) => call('legalChoices', STATE_PLAIN, args, () => engine.legalChoices(...args)),
    expandTurn: (...args) => call('expandTurn', EXPAND, args, () => engine.expandTurn(...args)),   // a miss forwards shouldStop
    observe: (...args) => engine.observe(...args),
    carryOut: (...args) => call('carryOut', STATE, args, () => engine.carryOut(...args)),
    unmodelledIn: (...args) => engine.unmodelledIn(...args),
    ...(hpOf === undefined ? {} : { hpOf: (...args: Parameters<typeof hpOf>) => call('hpOf', STATE, args, () => hpOf.apply(engine, args)) }),
  };
  const storedAi: EnemyModel = {
    get id() {
      return ai.id;
    },
    initialMemory: (...args) => ai.initialMemory(...args),
    support: (...args) => call('support', STATE_PLAIN, args, () => ai.support(...args)),
    replacementSupport: (...args) => call('replacementSupport', STATE_PLAIN, args, () => ai.replacementSupport(...args)),
    remember: (...args) => call('remember', MEMORY_OUTCOME, args, () => ai.remember(...args)),
  };
  const read = (): StoreStats => ({ ...stats });
  statsOf.set(storedEngine, read);
  statsOf.set(storedAi, read);
  return { engine: storedEngine, ai: storedAi, stats: read };
}
