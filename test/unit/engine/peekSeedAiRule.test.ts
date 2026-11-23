// The trainer AI keeps `peek`'s read rule (facts.ts): a kept battle equals a restore except inside active-move copies
// (beyond `id`, `num`, `name`), in keys holding `undefined`, and in shared arrays, so a reader may read values by name only.
// `peek` is mocked to hand the AI each battle behind a recording membrane (a Proxy over a shadow target, one per object)
// while the AI runs over the corpus; no read may go inside a copy, no `in`, key listing or own-property test may run
// except on array indices, and nothing may write.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { viewFromState } from '../../../src/ai/adapter.js';
import { type AiMemoryData, initialMemoryData } from '../../../src/ai/memory.js';
import { createTrainerAi } from '../../../src/ai/model.js';
import type { AiRomData } from '../../../src/ai/rom/aiData.js';
import type { AiMemory, EnemyModel } from '../../../src/contracts/ai.js';
import type { Outcome } from '../../../src/contracts/engine.js';
import { createBattle, installKaizoDex } from '../../../src/engine/index.js';
import { fixtureDeps } from '../ai/fixtures.js';
import { emberTurn, ID } from './fixtures.js';
import { peekSeedDex, walkCorpus } from './peekSeedCorpus.js';

const membrane = vi.hoisted(() => {
  /** Reads by path pattern, and reads that break the rule. */
  const reads = new Map<string, number>();
  const breaks = new Map<string, number>();
  const note = (map: Map<string, number>, what: string): void => {
    map.set(what, (map.get(what) ?? 0) + 1);
  };
  const OWN = new Set<string | undefined>(['Battle', 'Side', 'Pokemon', 'Field', 'BattleQueue', 'Object', 'Array', undefined]);
  const MOVE_KEYS = new Set(['id', 'num', 'name']);
  const nameOf = (value: object): string | undefined => (Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)?.constructor?.name;
  /** An active-move copy (peekCheck.ts `isActiveMove`): not a frozen dex entry, an own `hit`. */
  const isActiveMove = (value: object): boolean =>
    !OWN.has(nameOf(value)) && !Object.isFrozen(value) && Object.prototype.hasOwnProperty.call(value, 'hit');
  const isIndex = (key: PropertyKey): boolean => typeof key === 'string' && /^\d+$/.test(key);
  const proxies = new WeakMap<object, object>();

  const wrap = (real: object, path: string, inMove: boolean): object => {
    const known = proxies.get(real);
    if (known !== undefined) return known;
    const array = Array.isArray(real);
    const step = (key: string): string => (array && isIndex(key) ? `${path}[]` : `${path}.${key}`);
    const handler: ProxyHandler<object> = {
      get(_shadow, key) {
        const value: unknown = Reflect.get(real, key);
        if (typeof key === 'symbol') return value;
        const at = step(key);
        note(reads, at);
        if (inMove && !MOVE_KEYS.has(key) && !(array && (isIndex(key) || key === 'length'))) note(breaks, `read inside an active-move copy: ${at}`);
        if (value === null || typeof value !== 'object') return value;
        const move = isActiveMove(value);
        if (!move && !OWN.has(nameOf(value))) return value; // shared: the dex, the format, a dex entry, the chance generator
        return wrap(value, move ? `${at}{ActiveMove}` : at, inMove || move);
      },
      has(_shadow, key) {
        if (!(array && isIndex(key))) note(breaks, `has ${String(key)} at ${path}`);
        return Reflect.has(real, key);
      },
      ownKeys() {
        note(breaks, `own keys of ${path}`);
        return Reflect.ownKeys(real);
      },
      getOwnPropertyDescriptor(_shadow, key) {
        if (!(array && isIndex(key))) note(breaks, `own property ${String(key)} of ${path}`);
        const descriptor = Reflect.getOwnPropertyDescriptor(real, key);
        if (descriptor === undefined) return undefined;
        if (array && key === 'length') return { value: (real as unknown[]).length, writable: true, enumerable: false, configurable: false };
        return { ...descriptor, configurable: true };
      },
      getPrototypeOf: () => Reflect.getPrototypeOf(real),
      set(_shadow, key) {
        note(breaks, `write ${String(key)} at ${path}`);
        throw new TypeError(`a write through a peeked battle: ${path}.${String(key)}`);
      },
      defineProperty(_shadow, key) {
        note(breaks, `define ${String(key)} at ${path}`);
        throw new TypeError(`a write through a peeked battle: ${path}.${String(key)}`);
      },
      deleteProperty(_shadow, key) {
        note(breaks, `delete ${String(key)} at ${path}`);
        throw new TypeError(`a delete through a peeked battle: ${path}.${String(key)}`);
      },
    };
    const proxy = new Proxy(array ? [] : {}, handler);
    proxies.set(real, proxy);
    return proxy;
  };
  return { reads, breaks, recording: (battle: Battle): Battle => wrap(battle, 'battle', false) as Battle };
});

vi.mock('../../../src/engine/index.js', async (importOriginal) => {
  const engine = await importOriginal<typeof import('../../../src/engine/index.js')>();
  return { ...engine, peek: (state: Parameters<typeof engine.peek>[0]) => membrane.recording(engine.peek(state)) };
});

const dex = peekSeedDex();
const deps = fixtureDeps();
const weights = Array<number>(494).fill(100);
const aiData: AiRomData = {
  scriptWords: Array.from(deps.script.words), flagEntries: [...deps.script.flagEntries], scriptSha256: deps.script.sha256,
  items: deps.items, typeChart: deps.typeChart, weights, formWeights: weights,
};
const MEMORIES: AiMemoryData[] = [initialMemoryData(null), { ...initialMemoryData(null), switchAction: [ID.uTurn] }];

let model: EnemyModel;
let start: AiMemory;
let outcomes = 0;
const attempt = (run: () => unknown): void => {
  try {
    run();
  } catch {
    // a refusal is an answer; the reads before it are recorded
  }
};

/** The AI's every read of each outcome's battle, right after its `expandTurn` (the kept battle, on its first peek). */
function readStep(step: readonly Outcome[]): void {
  for (const outcome of step) {
    outcomes += 1;
    const { state } = outcome;
    for (const memory of MEMORIES) attempt(() => viewFromState(state, dex.data, aiData, memory));
    let memory = start;
    attempt(() => { memory = model.remember(start, outcome); });
    if (state.phase.kind === 'turnChoice') attempt(() => model.support(state, memory));
    if (state.phase.kind === 'enemyReplacement' || state.phase.kind === 'enemyMidTurnSwitch') attempt(() => model.replacementSupport(state, memory));
  }
}

beforeAll(() => {
  installKaizoDex(dex.data, dex.moves);
  model = createTrainerAi(dex.data, aiData);
  start = model.initialMemory(createBattle(emberTurn()));
  walkCorpus(readStep);
  const inMoves = [...membrane.reads].filter(([path]) => path.includes('{ActiveMove}'));
  console.log(`peekSeedAiRule: ${outcomes} outcomes, ${membrane.reads.size} distinct paths read; through active-move copies: ${inMoves.map(([path, n]) => `${n} ${path}`).join(' | ') || 'none'}`);
}, 900_000);

describe('the trainer AI keeps peek\'s read rule', () => {
  it('reads the corpus\'s peeked battles through the membrane: nothing inside a copy but id, num and name, no key tests or listing, no writes', () => {
    expect(outcomes).toBeGreaterThan(1_500);
    expect(membrane.reads.get('battle.turn')).toBeGreaterThan(0);
    expect([...membrane.reads.keys()].some((path) => path.startsWith('battle.sides') || path.startsWith('battle.p1'))).toBe(true);
    expect([...membrane.breaks].map(([what, n]) => `${n} ${what}`)).toEqual([]);
  });

  it('the membrane has teeth: each kind of read the rule forbids is recorded', async () => {
    const before = new Map(membrane.breaks);
    try {
      const { expandTurn, peek } = await import('../../../src/engine/index.js');
      const root = createBattle(emberTurn());
      const outcome = expandTurn(root, { p1: { kind: 'move', slot: 0 }, p2: { kind: 'move', slot: 0 } })[0]!;
      const battle = peek(outcome.state); // the mocked peek: the kept battle behind the membrane
      const mon = battle.p1.active[0]!;
      void mon.lastMove?.basePower; // inside an active-move copy
      void ('hp' in mon);
      void Object.keys(battle.p1.sideConditions);
      void Object.prototype.hasOwnProperty.call(mon.volatiles, 'confusion');
      expect(() => { mon.hp = 1; }).toThrow();
      const fresh = [...membrane.breaks.keys()].filter((what) => !before.has(what));
      const kinds = ['read inside an active-move copy: battle.p1.active[].lastMove{ActiveMove}.basePower', 'has hp', 'own keys of battle.p1.sideConditions', 'own property confusion', 'write hp'];
      expect(kinds.filter((kind) => !fresh.some((what) => what.startsWith(kind)))).toEqual([]);
    } finally {
      membrane.breaks.clear();
      for (const [what, n] of before) membrane.breaks.set(what, n);
    }
  });
});
