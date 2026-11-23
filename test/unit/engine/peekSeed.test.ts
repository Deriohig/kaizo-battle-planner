// `expandTurn` hands each outcome's kept leaf battle to `peek` (facts.ts `keepLive`), so a first peek restores nothing.
// Over a corpus walked through every phase, each kept battle equals a restore in all `peek`'s read rule promises
// (peekCheck.ts), differs only in the three known classes, and gives the trainer AI the same view and answers. The check
// has teeth, the pools keep their bounds, the guards hold, and `PKP_SEED_PEEK=0` turns it off.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import PS from 'pokemon-showdown';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { viewFromState } from '../../../src/ai/adapter.js';
import { type AiMemoryData, initialMemoryData } from '../../../src/ai/memory.js';
import { createTrainerAi } from '../../../src/ai/model.js';
import type { AiRomData } from '../../../src/ai/rom/aiData.js';
import type { AiMemory, EnemyModel } from '../../../src/contracts/ai.js';
import type { BattleInput, Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import { applyChoices, snapshot } from '../../../src/engine/battle.js';
import { keepLive, NoChanceDriver, PEEK_LIMIT, peekConfig, peekPoolSizes, rememberLive, SEED_LIMIT } from '../../../src/engine/facts.js';
import { hasSpeedOrderMemo, speedOrderFirst } from '../../../src/engine/mod/speedOrder.js';
import {
  createBattle, EngineError, expandTurn, installKaizoDex, legalChoices, peek, restore, showdownEngine, trainerBag, unmodelledIn,
} from '../../../src/engine/index.js';
import { battleDiff, describeDifferences, differenceClass, pattern, peekDifferences } from '../../../src/engine/peekCheck.js';
import { fixtureDeps } from '../ai/fixtures.js';
import { BAG, emberTurn, fixtureDex, ID, resolvedMon, resolvedTrainer } from './fixtures.js';
import { levelUpLearn, MIMIC, peekSeedDex, pivots, playerWith, walkCorpus } from './peekSeedCorpus.js';
import { readAll } from './walk.js';

type Choices = { p1?: Choice; p2?: Choice };
const dex = peekSeedDex();
const move = (slot: number): Choice => ({ kind: 'move', slot });
const to = (index: number): Choice => ({ kind: 'switch', index });
const DEFAULTS = { ...peekConfig };
/** A restore of `state` as `peek` makes one (with the throwing chance driver): what a kept battle is compared with. */
const fresh = (state: EngineState): Battle => restore(state, new NoChanceDriver([]));
const spyFromJSON = () => vi.spyOn(PS.Battle, 'fromJSON');
const PIVOT = { p1: move(0), p2: move(1) };
const pivotOutcomes = () => expandTurn(createBattle(pivots()), PIVOT);

/** `run` with `peekConfig` changed by `patch`, then as it was. */
function withConfig<T>(patch: Partial<typeof peekConfig>, run: () => T): T {
  const before = { ...peekConfig };
  Object.assign(peekConfig, patch);
  try {
    return run();
  } finally {
    Object.assign(peekConfig, before);
  }
}

/** JSON of any value: bigints as text, an error as its message. */
const json = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v instanceof Error ? { error: v.message } : v)) ?? 'undefined';
/** `compute()`, or what it threw. */
const attempt = (compute: () => unknown): unknown => {
  try {
    return compute();
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) };
  }
};

// The trainer AI over the fixture's AI ROM data (an empty script) with flat weights.
const deps = fixtureDeps();
const weights = Array<number>(494).fill(100);
const aiData: AiRomData = {
  scriptWords: Array.from(deps.script.words), flagEntries: [...deps.script.flagEntries], scriptSha256: deps.script.sha256,
  items: deps.items, typeChart: deps.typeChart, weights, formWeights: weights,
};
const MEMORIES: [string, AiMemoryData][] = [
  ['initial', initialMemoryData(null)],
  ['after a U-turn', { ...initialMemoryData(null), switchAction: [ID.uTurn] }], // replacementState reads pursuitMayRun
];

/** What the corpus walk found. */
const found = {
  outcomes: 0, checked: 0, restoredAtPeek: [] as string[], differ: [] as string[], unknownClass: [] as string[],
  classes: new Map<string, number>(), patterns: new Map<string, number>(), views: 0, viewsThrew: 0, viewDiffers: [] as string[],
  answers: 0, answerDiffers: [] as string[], queued: 0, mimicked: 0, learned: 0, transformed: 0,
};

let model: EnemyModel;
let startMemory: AiMemory;

/**
 * Checks one step's outcomes (`walkCorpus`): each first peek restores nothing (verify off: checked here by hand), shows no
 * difference a reader could see from a restore, raw differences only in the known classes, and the AI's view and answers
 * equal those from a copy of the state (which misses every cache and is restored).
 */
function checkStep(outcomes: readonly Outcome[]): void {
  const fromJSON = vi.mocked(PS.Battle.fromJSON);
  const unread = outcomes.slice(-peekConfig.seedLimit); // a turn wider than the pool loses its oldest seeds, by design
  for (const outcome of outcomes) {
    const { state } = outcome;
    found.outcomes += 1;
    const where = `${state.key.slice(0, 10)} (turn ${state.turn}, ${state.phase.kind})`;
    fromJSON.mockClear();
    const battle = withConfig({ verify: false }, () => peek(state));
    if (unread.includes(outcome) && fromJSON.mock.calls.length !== 0) found.restoredAtPeek.push(where);
    found.checked += 1;
    const restored = fresh(state);
    const differences = peekDifferences(battle, restored);
    if (differences.length > 0) found.differ.push(`${where}: ${describeDifferences(differences)}`);
    for (const difference of battleDiff(battle, restored)) {
      const kind = differenceClass(difference);
      if (kind === null) found.unknownClass.push(`${where}: ${describeDifferences([difference])}`);
      found.classes.set(kind ?? '?', (found.classes.get(kind ?? '?') ?? 0) + 1);
      found.patterns.set(`${kind}: ${pattern(difference.path)}`, (found.patterns.get(`${kind}: ${pattern(difference.path)}`) ?? 0) + 1);
    }
    if (battle.queue.list.length > 0) found.queued += 1;
    if (battle.sides.some((side) => side.pokemon.some((pokemon) => pokemon.moveSlots.some((slot) => slot.virtual) && !pokemon.transformed))) found.mimicked += 1;
    if (battle.sides.some((side) => side.pokemon.some((pokemon) => pokemon.transformed))) found.transformed += 1;
    if (outcome.log.some((line) => line.startsWith('|-kaizolearn|'))) found.learned += 1;

    const copy = { ...state };
    for (const [name, memory] of MEMORIES) {
      const [mine, theirs] = [json(attempt(() => viewFromState(state, dex.data, aiData, memory))), json(attempt(() => viewFromState(copy, dex.data, aiData, memory)))];
      found.views += 1;
      if (mine.startsWith('{"threw"')) found.viewsThrew += 1;
      if (mine !== theirs && found.viewDiffers.length < 5) found.viewDiffers.push(`${where}, ${name}: ${mine.slice(0, 300)} VS ${theirs.slice(0, 300)}`);
    }
    const remembered = attempt(() => model.remember(startMemory, outcome));
    const answers: [string, () => unknown, () => unknown][] = [['remember', () => remembered, () => model.remember(startMemory, { ...outcome, state: copy })]];
    const memory = (remembered as { threw?: string }).threw === undefined ? remembered as AiMemory : startMemory;
    if (state.phase.kind === 'turnChoice') answers.push(['support', () => model.support(state, memory), () => model.support(copy, memory)]);
    if (state.phase.kind === 'enemyReplacement' || state.phase.kind === 'enemyMidTurnSwitch') {
      answers.push(['replacementSupport', () => model.replacementSupport(state, memory), () => model.replacementSupport(copy, memory)]);
    }
    for (const [name, mineOf, theirsOf] of answers) {
      const [mine, theirs] = [json(attempt(mineOf)), json(attempt(theirsOf))];
      found.answers += 1;
      if (mine !== theirs && found.answerDiffers.length < 5) found.answerDiffers.push(`${where}, ${name}: ${mine.slice(0, 300)} VS ${theirs.slice(0, 300)}`);
    }
  }
}

beforeAll(() => {
  installKaizoDex(dex.data, dex.moves);
  model = createTrainerAi(dex.data, aiData);
  startMemory = model.initialMemory(createBattle(emberTurn()));
  const fromJSON = spyFromJSON();
  try {
    walkCorpus(checkStep);
  } finally {
    fromJSON.mockRestore();
  }
  console.log(`peekSeed corpus: ${found.outcomes} outcomes; raw classes ${json([...found.classes])}; ${found.queued} with a queue, `
    + `${found.mimicked} with a Mimic copy, ${found.transformed} Transformed, ${found.learned} with a move learned; views ${found.views} `
    + `(${found.viewsThrew} threw), answers ${found.answers}`);
  console.log(`peekSeed raw patterns: ${[...found.patterns].sort((a, b) => b[1] - a[1]).map(([key, n]) => `${n} ${key}`).join(' | ')}`);
}, 900_000);

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(peekConfig, DEFAULTS);
});

/** A one-leaf step (no chance), its outcome's state and the kept leaf's live battle as the step restored it, unfrozen. */
function keptOne(input: () => BattleInput = pivots, choices: Choices = { p1: to(1), p2: to(1) }): { state: EngineState; battle: Battle } {
  const root = createBattle(input());
  const fromJSON = spyFromJSON();
  const outcomes = expandTurn(root, choices);
  const battles = fromJSON.mock.results.map((result) => result.value as Battle);
  fromJSON.mockRestore();
  expect([outcomes.length, battles.length]).toEqual([1, 1]);
  return { state: outcomes[0]!.state, battle: battles[0]! };
}

/** Growl against Growl, Monferno the faster (one leaf); Monferno also knows Baton Pass. */
const growls = (): BattleInput => ({
  player: [playerWith(ID.monferno, 30, [ID.growl, ID.batonPass]), playerWith(ID.bidoof, 30, [ID.tackle])],
  trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 30, [ID.growl])]), field: {},
});
/** Both Growl: the kept battle holds last moves (active-move copies). */
const GROWL = { p1: move(0), p2: move(0) };
/** Baton Pass first: the kept battle waits on the player's mid-turn switch with the trainer's Growl queued. */
const PASS = { p1: move(1), p2: move(0) };
const queuedMove = (battle: Battle): { id: string; num: number; name: string } =>
  (battle.queue.list.find((action) => action.choice === 'move') as unknown as { move: { id: string; num: number; name: string } }).move;
const DIFFERS = /peek: the kept battle of .* differs from its restore/;

describe('every outcome\'s kept battle over the corpus', () => {
  it('reaches what the corpus is for: queues, Mimic, Transform and a move learned mid-fight', () => {
    expect(found.outcomes).toBeGreaterThan(1_500);
    expect([found.queued, found.mimicked, found.transformed, found.learned].every((n) => n > 0)).toBe(true);
  });

  it('the first peek restores nothing; no difference a reader could see; raw differences only in classes A, U and S', () => {
    expect(found.checked).toBe(found.outcomes);
    expect([found.restoredAtPeek, found.differ, found.unknownClass.slice(0, 10)]).toEqual([[], [], []]);
  });

  it('the trainer AI\'s view (two memories), remember, support and replacementSupport equal a restore\'s', () => {
    expect(found.views).toBe(found.outcomes * MEMORIES.length);
    expect(found.viewsThrew).toBeLessThan(found.views); // the views are built, not refused
    expect(found.answers).toBeGreaterThan(found.outcomes);
    expect([found.viewDiffers, found.answerDiffers]).toEqual([[], []]);
  });

  it('the comparison has teeth: one write to a kept battle (verify and freeze off) changes the AI\'s view', () => {
    const { state, battle } = keptOne();
    battle.p1.active[0]!.hp -= 1;
    withConfig({ verify: false, freeze: false }, () => {
      expect(json(viewFromState(state, dex.data, aiData, MEMORIES[0]![1]))).not.toBe(json(viewFromState({ ...state }, dex.data, aiData, MEMORIES[0]![1])));
    });
  });
});

describe('the check on a first peek', () => {
  /** Single writes to a kept battle, one per kind of read the trainer AI makes, and the walker's own comparisons. */
  const writes: [string, (battle: Battle) => void][] = [
    ['hp', (b) => { b.p1.active[0]!.hp -= 1; }],
    ['status', (b) => { (b.p1.active[0] as { status: string }).status = 'brn'; }],
    ['statusState.time', (b) => { b.p1.active[0]!.statusState['time'] = 2; }],
    ['a volatile added', (b) => { b.p1.active[0]!.volatiles['taunt'] = { id: 'taunt', duration: 3 } as never; }],
    ['a boost', (b) => { b.p2.active[0]!.boosts.atk = 1; }],
    ['a move slot\'s pp', (b) => { b.p1.active[0]!.moveSlots[0]!.pp -= 1; }],
    ['a move slot\'s used', (b) => { b.p1.active[0]!.moveSlots[0]!.used = true; }],
    ['a base move slot\'s pp', (b) => { const mon = b.p2.active[0]!; mon.baseMoveSlots[0] = { ...mon.baseMoveSlots[0]!, pp: 1 }; }],
    ['item', (b) => { (b.p1.active[0] as { item: string }).item = 'leftovers'; }],
    ['lastItem', (b) => { (b.p1.active[0] as { lastItem: string }).lastItem = 'potion'; }],
    ['ability', (b) => { (b.p2.active[0] as { ability: string }).ability = 'levitate'; }],
    ['types', (b) => { b.p1.active[0]!.types = ['Fire']; }],
    ['level', (b) => { (b.p2.active[0] as { level: number }).level += 1; }],
    ['happiness', (b) => { (b.p1.active[0] as { happiness: number }).happiness = 1; }],
    ['activeTurns', (b) => { b.p1.active[0]!.activeTurns += 5; }],
    ['transformed', (b) => { b.p2.active[0]!.transformed = true; }],
    ['a hazard\'s layers', (b) => { b.p2.sideConditions['spikes'] = { id: 'spikes', layers: 2 } as never; }],
    ['a slot condition', (b) => { b.p1.slotConditions[0]!['wish'] = { id: 'wish', duration: 2 } as never; }],
    ['field.weather', (b) => { (b.field as { weather: string }).weather = 'raindance'; }],
    ['a pseudo-weather\'s duration', (b) => { b.field.pseudoWeather['trickroom'] = { id: 'trickroom', duration: 3 } as never; }],
    ['turn', (b) => { (b as { turn: number }).turn += 1; }],
    ['battle.lastMove', (b) => { b.lastMove = b.dex.getActiveMove('tackle'); }],
    ['a Pokémon\'s lastMove', (b) => { b.p2.active[0]!.lastMove = b.dex.getActiveMove('ember'); }],
    ['a request move\'s disabled', (b) => { (b.p2.activeRequest as { active: { moves: { disabled: boolean }[] }[] }).active[0]!.moves[0]!.disabled = true; }],
    ['the bag', (b) => { trainerBag(b).items[0] = 0; }],
    ['two entries of side.team swapped', (b) => { const team = b.p1.team; [team[0], team[1]] = [team[1]!, team[0]!]; }],
    ['a set\'s IV', (b) => { b.p1.active[0]!.set.ivs.atk = 0; }],
    ['a prototype', (b) => { Object.setPrototypeOf(b.p1.active[0]!.boosts, { boosted: true }); }],
    ['a function\'s source', (b) => { (b as unknown as { send: unknown }).send = (...args: unknown[]) => args.length; }],
    ['a Set\'s members', (b) => { b.hints.add('a hint'); }],
    ['a side condition ID holding undefined', (b) => { (b.p1.sideConditions as Record<string, unknown>)['reflect'] = undefined; }],
    ['a pseudo-weather ID holding undefined', (b) => { (b.field.pseudoWeather as Record<string, unknown>)['gravity'] = undefined; }],
  ];

  it.each(writes)('a write to %s makes the check differ, and the first peek throw', (_name, write) => {
    const { state, battle } = keptOne();
    expect(peekDifferences(battle, fresh(state))).toEqual([]);
    write(battle);
    expect(peekDifferences(battle, fresh(state)).length).toBeGreaterThan(0);
    withConfig({ freeze: false }, () => expect(() => peek(state)).toThrow(DIFFERS));
  });

  it('a write inside a queued action, or to a live volatile\'s counter, makes the check differ', () => {
    for (const write of [(b: Battle) => { (b.queue.list[0] as { choice: string }).choice = 'shift'; }, (b: Battle) => { (b.queue.list[0] as { priority: number }).priority += 1; }]) {
      const { state, battle } = withConfig({ verify: false, freeze: false }, () => {
        const outcome = pivotOutcomes().find((o) => o.state.phase.kind === 'playerMidTurnSwitch')!;
        return { state: outcome.state, battle: peek(outcome.state) };
      });
      expect(battle.queue.list.length).toBeGreaterThan(0);
      expect(peekDifferences(battle, fresh(state))).toEqual([]);
      write(battle);
      expect(peekDifferences(battle, fresh(state)).length).toBeGreaterThan(0);
    }
    const counted = withConfig({ verify: false, freeze: false }, () => {
      const state = expandTurn(createBattle(pivots()), { p1: move(2), p2: move(1) }).find((o) => o.state.phase.kind === 'turnChoice')!.state;
      return { state, battle: peek(state) };
    });
    const volatile = { id: 'confusion', time: 3 };
    counted.battle.p1.active[0]!.volatiles['confusion'] = volatile as never;
    const withVolatile = fresh(counted.state);
    withVolatile.p1.active[0]!.volatiles['confusion'] = { id: 'confusion', time: 3 } as never;
    expect(peekDifferences(counted.battle, withVolatile)).toEqual([]);
    volatile.time = 2;
    expect(peekDifferences(counted.battle, withVolatile).length).toBeGreaterThan(0);
  });

  it('allowed differences pass: undefined in an effect state (U), an active-move copy\'s other keys (A), a shared primitive array (S)', () => {
    const { state, battle } = keptOne();
    const restored = fresh(state);
    (battle.p2.sideConditions as Record<string, unknown>)['spikes'] = { id: 'spikes', layers: 1, duration: undefined };
    (restored.p2.sideConditions as Record<string, unknown>)['spikes'] = { id: 'spikes', layers: 1 };
    battle.lastMove = battle.dex.getActiveMove('tackle');
    (battle.lastMove as unknown as Record<string, unknown>)['pranksterBoosted'] = true;
    restored.lastMove = restored.dex.getActiveMove('tackle');
    const shared = [...battle.p2.pokemon[1]!.types];
    battle.p2.pokemon[1]!.types = shared;
    battle.p2.pokemon[2]!.types = shared;
    restored.p2.pokemon[1]!.types = [...shared];
    restored.p2.pokemon[2]!.types = [...shared];
    expect(peekDifferences(battle, restored)).toEqual([]);
    expect(new Set(battleDiff(battle, restored).map(differenceClass))).toEqual(new Set(['U', 'A', 'S']));
  });

  it('a Pokémon\'s staleness keys (set to undefined by eatItem and clearVolatile) may hold undefined; another key may not', () => {
    const { state, battle } = keptOne();
    for (const key of ['staleness', 'pendingStaleness', 'volatileStaleness']) (battle.p2.active[0] as unknown as Record<string, unknown>)[key] = undefined;
    const restored = fresh(state);
    expect(peekDifferences(battle, restored)).toEqual([]);
    expect(new Set(battleDiff(battle, restored).map(differenceClass))).toEqual(new Set(['U']));
    (battle.p1.active[0] as unknown as Record<string, unknown>)['someKey'] = undefined;
    expect(peekDifferences(battle, restored).map((d) => d.path)).toEqual(['mon(p1#0).someKey']);
    expect(battleDiff(battle, restored).map(differenceClass)).toContain(null);
  });
});

describe('inside active-move copies the check compares id, num and name', () => {
  it.each<[string, Choices, (battle: Battle) => void]>([
    ['a Pokémon\'s lastMove.id', GROWL, (b) => { (b.p2.active[0]!.lastMove as unknown as { id: string }).id = 'tackle'; }],
    ['battle.lastMove.num', GROWL, (b) => { (b.lastMove as unknown as { num: number }).num = 33; }],
    ['battle.lastMove.name', GROWL, (b) => { (b.lastMove as unknown as { name: string }).name = 'Tackle'; }],
    ['a queued action\'s move.num', PASS, (b) => { queuedMove(b).num = 33; }],
    ['a queued action\'s move.id', PASS, (b) => { queuedMove(b).id = 'tackle'; }],
  ])('a write to %s makes the check differ, and the first peek throw', (_name, choices, write) => {
    const { state, battle } = keptOne(growls, choices);
    expect(battle.lastMove).not.toBeNull();
    if (choices === PASS) expect(state.phase.kind).toBe('playerMidTurnSwitch');
    expect(peekDifferences(battle, fresh(state))).toEqual([]);
    write(battle);
    expect(peekDifferences(battle, fresh(state)).length).toBeGreaterThan(0);
    withConfig({ freeze: false }, () => expect(() => peek(state)).toThrow(DIFFERS));
  });

  it('a write to any other key inside a copy passes, as the read rule allows', () => {
    for (const choices of [GROWL, PASS]) {
      const { state, battle } = keptOne(growls, choices);
      (battle.lastMove as unknown as { basePower: number }).basePower = 999;
      if (choices === PASS) (queuedMove(battle) as unknown as { priority: number }).priority = 5;
      expect(peekDifferences(battle, fresh(state))).toEqual([]);
      expect(() => peek(state)).not.toThrow();
    }
  });
});

describe('the reset of what a restore makes', () => {
  it('keepLive forgets the monSpeedOrder memo the step left on its live battle; a kept battle holding one throws on its first peek', () => {
    /** Whether any battle the one-leaf step restored still holds the memo (a fact cache miss may add a plain restore). */
    const memoLeft = (seed: boolean): boolean => withConfig({ seed }, () => {
      const fromJSON = spyFromJSON();
      expect(expandTurn(createBattle(growls()), GROWL)).toHaveLength(1);
      const battles = fromJSON.mock.results.map((result) => result.value as Battle);
      fromJSON.mockRestore();
      expect(battles.length).toBeGreaterThan(0);
      return battles.some((battle) => hasSpeedOrderMemo(battle));
    });
    expect([memoLeft(false), memoLeft(true)]).toEqual([true, false]);
    const { state, battle } = keptOne(growls, GROWL);
    speedOrderFirst(battle); // distinct Speeds, no Quick Claw: no draw
    expect(hasSpeedOrderMemo(battle)).toBe(true);
    expect(() => peek(state)).toThrow(/keeps a monSpeedOrder memo/);
  });

  it('a base slot apart from its move slot of the same move becomes that move slot, as a restore makes it (state.js:199-211)', () => {
    const live = restore(createBattle(pivots()));
    const mon = live.p1.active[0]!;
    (mon.baseMoveSlots as Pokemon['moveSlots'])[0] = { ...mon.moveSlots[0]!, pp: 1 };
    const state = snapshot(live);
    const remade = rememberLive(state, live);
    expect(remade).toBe(true);
    keepLive(state, live, remade, null);
    expect(peek(state)).toBe(live); // kept, past the check against a restore
    expect(live.p1.active[0]!.baseMoveSlots[0]).toBe(live.p1.active[0]!.moveSlots[0]);
  });

  it('a battle whose requests were not made again is not kept: its first peek restores', () => {
    const live = restore(createBattle(pivots()));
    const state = snapshot(live);
    (live as unknown as { getRequests: () => never }).getRequests = () => { throw new Error('no requests'); };
    const remade = rememberLive(state, live);
    expect(remade).toBe(false);
    keepLive(state, live, remade, null);
    const fromJSON = spyFromJSON();
    expect(withConfig({ verify: false }, () => peek(state))).not.toBe(live);
    expect(fromJSON).toHaveBeenCalledTimes(1);
  });
});

describe('restores at a first peek', () => {
  it('with verify off, peeking each outcome, and its observation and unmodelled list, restores nothing', () => {
    const outcomes = pivotOutcomes();
    expect(outcomes.length).toBeGreaterThan(1);
    const fromJSON = spyFromJSON();
    withConfig({ verify: false }, () => {
      for (const outcome of outcomes) {
        peek(outcome.state);
        showdownEngine.observe(outcome.state);
        unmodelledIn(outcome.state);
      }
    });
    expect(fromJSON).toHaveBeenCalledTimes(0);
  });

  it('with verify on, the first peek restores once, for the check, and later peeks not at all; with seeding off each first peek restores', () => {
    const outcomes = pivotOutcomes();
    const fromJSON = spyFromJSON();
    for (const outcome of outcomes) peek(outcome.state);
    for (const outcome of outcomes) peek(outcome.state);
    expect(fromJSON).toHaveBeenCalledTimes(outcomes.length);
    const unseeded = withConfig({ seed: false }, () => pivotOutcomes());
    fromJSON.mockClear();
    withConfig({ verify: false }, () => { for (const outcome of unseeded) peek(outcome.state); });
    expect(fromJSON).toHaveBeenCalledTimes(unseeded.length);
  });
});

/** Ember against Tackle: a wide turn (both sides' damage rolls and crits). */
const wide = () => ({
  player: [playerWith(ID.monferno, 40, [ID.ember]), playerWith(ID.bidoof, 40, [ID.tackle])],
  trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 36, [ID.tackle]), resolvedMon(ID.castform, 36, [ID.tackle])]), field: {},
});
/** `expandTurn`'s outcomes summed between two stop polls after the last leaf (expand.ts STOP_POLL_OUTCOMES). */
const STOP_AFTER_LAST = 16;

describe('the pools', () => {
  it('a turn wider than the unread pool keeps its last outcomes, and a miss among them evicts none of the others', () => {
    const limit = 4;
    const outcomes = withConfig({ seedLimit: limit }, () => expandTurn(createBattle(emberTurn()), GROWL, { collapse: false }));
    expect(outcomes.length).toBeGreaterThan(limit + 1);
    expect(peekPoolSizes().unread).toBe(limit);
    const fromJSON = spyFromJSON();
    withConfig({ verify: false, seedLimit: limit }, () => {
      peek(outcomes[0]!.state); // pushed out: a miss, restored into the LRU
      expect(fromJSON).toHaveBeenCalledTimes(1);
      for (const outcome of outcomes.slice(-limit)) peek(outcome.state);
      expect(fromJSON).toHaveBeenCalledTimes(1);
    });
    expect(peekPoolSizes().unread).toBe(0);
  });

  it('a replaced leaf\'s battle is dropped: the pool grows by the outcomes, not by the leaves ever kept', () => {
    // Somewhere a later leaf of a class replaces its kept leaf: the leaves whose log keepLive emptied outnumber the outcomes.
    const candidates: [EngineState, Choices][] = [
      [createBattle(emberTurn()), GROWL], [createBattle(emberTurn([ID.tackle, ID.ember])), PIVOT],
      [createBattle(pivots()), { p1: move(2), p2: move(1) }], [createBattle(pivots()), GROWL],
    ];
    let replacedSeen = false;
    withConfig({ seedLimit: 100_000 }, () => {
      for (const [root, choices] of candidates) {
        const before = peekPoolSizes().unread;
        const fromJSON = spyFromJSON();
        const outcomes = expandTurn(root, choices, { collapse: false });
        const everKept = fromJSON.mock.results.filter((result) => (result.value as Battle).log.length === 0).length;
        fromJSON.mockRestore();
        expect(peekPoolSizes().unread).toBe(before + outcomes.length);
        if (everKept > outcomes.length) replacedSeen = true;
      }
    });
    expect(replacedSeen).toBe(true);
  });

  it('a peeked seed moves to the LRU and obeys PEEK_LIMIT', () => {
    const [outcome, other] = pivotOutcomes();
    const first = peek(outcome!.state);
    expect(peek(outcome!.state)).toBe(first);
    for (let i = 0; i < PEEK_LIMIT; i++) peek({ ...other!.state });
    const again = peek(outcome!.state);
    expect(again).not.toBe(first);
    expect([peekDifferences(again, fresh(outcome!.state)), peekDifferences(first, fresh(outcome!.state))]).toEqual([[], []]);
  });

  it('a STOPPED or LIMIT call leaves none of its kept battles in the pool', () => {
    withConfig({ seedLimit: 100_000 }, () => {
      const root = createBattle(wide());
      const all = expandTurn(root, GROWL, { collapse: false });
      expect(all.length).toBeGreaterThan(STOP_AFTER_LAST + 1);
      const leaves = all.reduce((sum, o) => sum + o.merged, 0);
      const stopAfter = (n: number) => () => { let polls = 0; return expandTurn(root, GROWL, { collapse: false, shouldStop: () => ++polls > n }); };
      for (const [name, call] of [['STOPPED among the leaves', stopAfter(40)], ['STOPPED after the last leaf', stopAfter(leaves + 1)],
        ['LIMIT', () => expandTurn(root, GROWL, { collapse: false, maxLeaves: 5 })]] as const) {
        const before = peekPoolSizes().unread;
        expect(call, name).toThrow(EngineError);
        expect(peekPoolSizes().unread, name).toBe(before);
      }
    });
  });
});

describe('the guards on a kept battle', () => {
  it('its first peek under vitest freezes it, as a root\'s peek (facts.test.ts): writes and a step throw, a draw throws', () => {
    const outcome = pivotOutcomes()[0]!;
    const battle = peek(outcome.state);
    expect(peek(outcome.state)).toBe(battle);
    const mon = battle.p1.active[0]!;
    for (const write of [() => { mon.hp = 1; }, () => { trainerBag(battle).items[0] = 0; }, () => { battle.log.push('|x|'); }, () => { applyChoices(battle, GROWL); }]) expect(write).toThrow();
    expect(() => battle.prng.random(2)).toThrow(/peeked battle drew a chance/);
    expect(() => battle.randomChance(1, 2)).toThrow(/peeked battle drew a chance/);
    expect([battle, mon, battle.formatData, battle.dex, battle.format, battle.ruleTable].map((object) => Object.isFrozen(object))).toEqual([true, true, true, false, false, false]);
    expect(peekDifferences(battle, fresh(outcome.state))).toEqual([]);
  });

  it('peeking a kept battle, and writes refused through it, change nothing the engine answers for its state', () => {
    const { state } = expandTurn(createBattle(pivots()), { p1: move(2), p2: move(1) }).find((o) => o.state.phase.kind === 'turnChoice')!;
    const [json0, key, read] = [state.json, state.key, readAll({ ...state })];
    const before = withConfig({ seed: false }, () => expandTurn({ ...state }, PASS));
    const battle = peek(state);
    for (const write of [() => { battle.p1.active[0]!.hp = 1; }, () => { battle.formatData['x'] = 1; }, () => { battle.p2.pokemon.reverse(); }]) expect(write).toThrow();
    expect(expandTurn(state, PASS)).toEqual(before);
    expect([state.json, state.key, readAll(state)]).toEqual([json0, key, read]);
  });

  it('a kept battle under another dex install is dropped and the state restored', () => {
    const outcome = pivotOutcomes()[0]!;
    const other = fixtureDex();
    installKaizoDex(other.data, other.moves);
    try {
      const fromJSON = spyFromJSON();
      const battle = withConfig({ verify: false }, () => peek(outcome.state));
      expect(fromJSON).toHaveBeenCalledTimes(1);
      expect(peek(outcome.state)).toBe(battle);
    } finally {
      installKaizoDex(dex.data, dex.moves);
    }
  });
});

describe('the steps no solve corpus reaches, each through the check', () => {
  it('a knock-out mid-fight that levels Monferno up and teaches it Slash', () => {
    const outcomes = expandTurn(createBattle(levelUpLearn()), GROWL);
    const learned = outcomes.filter((outcome) => outcome.log.some((line) => line === '|-kaizolearn|p1a: Monferno|Slash'));
    expect(learned.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      const fromJSON = spyFromJSON();
      const battle = peek(outcome.state); // verify on: one restore, for the check, which passes
      expect(fromJSON).toHaveBeenCalledTimes(1);
      fromJSON.mockRestore();
      if (learned.includes(outcome)) expect(battle.p1.active[0]!.moveSlots.map((slot) => slot.id)).toEqual(['plainhit', 'slash']);
    }
  });

  it('Mimic: the copy is a virtual move slot over the base slot, and the step after uses it', () => {
    const root = createBattle({ player: [playerWith(ID.monferno, 30, [MIMIC, ID.tackle])], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 30, [ID.growl])]), field: {} });
    // Turn 1 Tackle (so the foe has a last move Monferno lacks), turn 2 Mimic copies it, turn 3 the copy is used.
    const first = expandTurn(root, PASS).find((o) => o.state.phase.kind === 'turnChoice')!.state;
    for (const outcome of expandTurn(first, PASS)) peek(outcome.state);
    const mimicked = expandTurn(first, GROWL).filter((outcome) => peek(outcome.state).p1.active[0]!.moveSlots[0]!.virtual === true);
    expect(mimicked.length).toBeGreaterThan(0);
    const mon = peek(mimicked[0]!.state).p1.active[0]!;
    expect([mon.moveSlots[0]!.id, mon.baseMoveSlots[0]!.id]).toEqual(['growl', 'mimic']);
    const state = mimicked.find((outcome) => outcome.state.phase.kind === 'turnChoice')!.state;
    for (const outcome of expandTurn(state, GROWL)) expect(peekDifferences(peek(outcome.state), fresh(outcome.state))).toEqual([]);
  });

  it('a frozen kept battle: steps from its state and from every other state run as before', () => {
    const root = createBattle(pivots());
    const outcomes = expandTurn(root, PIVOT);
    for (const outcome of outcomes) expect(Object.isFrozen(peek(outcome.state))).toBe(true);
    for (const { state } of outcomes.filter((outcome) => outcome.state.phase.kind !== 'terminal')) {
      const choices: Choices = {};
      for (const side of ['p1', 'p2'] as const) if (legalChoices(state, side).length > 0) choices[side] = legalChoices(state, side)[0]!;
      expect(expandTurn(state, choices)).toEqual(withConfig({ seed: false }, () => expandTurn({ ...state }, choices)));
    }
    expect(expandTurn(root, PIVOT)).toEqual(outcomes);
  });
});

describe('the switches', () => {
  it('under vitest: seeding, the check and the freeze are on, and the pool is SEED_LIMIT', () => {
    expect(DEFAULTS).toEqual({ seed: true, verify: true, freeze: true, seedLimit: SEED_LIMIT });
  });

  it('in a plain node process: seeding on, the check and the freeze off; each variable flips its switch', () => {
    const script = fileURLToPath(new URL('./peekSeedProbe.ts', import.meta.url));
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const probe = (extra: Record<string, string>): string => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
      for (const name of ['VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID', 'PKP_SEED_PEEK', 'PKP_VERIFY_PEEK', 'PKP_FREEZE_PEEK']) {
        if (extra[name] === undefined) delete env[name];
      }
      const r = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: root, env, encoding: 'utf8' });
      expect([r.error, r.stderr, r.status, r.signal]).toEqual([undefined, '', 0, null]);
      return r.stdout.trim();
    };
    const n = probe({}).match(/outcomes=(\d+)/)?.[1];
    expect(Number(n)).toBeGreaterThan(1);
    expect([probe({}), probe({ PKP_SEED_PEEK: '0' }), probe({ PKP_VERIFY_PEEK: '1' }), probe({ PKP_FREEZE_PEEK: '1' })]).toEqual([
      `seed=true verify=false freeze=false outcomes=${n} restores=0 frozen=false`,
      `seed=false verify=false freeze=false outcomes=${n} restores=${n} frozen=false`,
      `seed=true verify=true freeze=false outcomes=${n} restores=${n} frozen=false`,
      `seed=true verify=false freeze=true outcomes=${n} restores=0 frozen=true`,
    ]);
  }, 120_000);
});
