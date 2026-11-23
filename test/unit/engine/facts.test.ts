// The engine keeps what the cheap readers answer beside each state it builds (src/engine/facts.ts): for every such state
// each reader answers as for the same state rebuilt (a cache miss), a cached read restores nothing, and the cache is
// never in the state. `peek` gives one restored battle per state object, in an LRU, deep-frozen, drawing no chance.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import PS from 'pokemon-showdown';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Choice, EngineState, Phase } from '../../../src/contracts/engine.js';
import { applyChoices, carryIn, choicesIn, hpIn, restore, snapshot } from '../../../src/engine/battle.js';
import { FREEZE_PEEKED, PEEK_LIMIT, rememberLive, rememberRestored } from '../../../src/engine/facts.js';
import {
  carryOut, createBattle, expandTurn, hpOf, installKaizoDex, legalChoices, levelUp, peek, showdownEngine, stateKey, trainerBag,
  unmodelledIn,
} from '../../../src/engine/index.js';
import { observe } from '../../../src/engine/observe.js';
import { unmodelledInBattle } from '../../../src/engine/unmodelled.js';
import { ABILITY, emberTurn, FIXTURE_MOVES, fixtureDex, ID, knownAbility } from './fixtures.js';
import { BASE_WALKS, locks, pivots, sixes } from './peekSeedCorpus.js';
import { cacheMismatches, type Corpus, emptyCorpus, readAll, walk } from './walk.js';

const fixture = fixtureDex();
const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH = { p1: move(0), p2: move(0) };
const PIVOT = { p1: move(0), p2: move(1) };
const ALL_PHASES: Phase['kind'][] = ['turnChoice', 'playerMidTurnSwitch', 'enemyMidTurnSwitch', 'enemyReplacement', 'playerReplacement', 'terminal'];
const spyFromJSON = () => vi.spyOn(PS.Battle, 'fromJSON');
/** `run` under another fixture dex install, then the usual one again. */
const underOtherInstall = <T>(run: () => T): T => {
  const other = fixtureDex();
  installKaizoDex(other.data, other.moves);
  try {
    return run();
  } finally {
    installKaizoDex(fixture.data, fixture.moves);
  }
};

let corpus: Corpus;
let levelUps: EngineState[];

beforeAll(() => {
  installKaizoDex(fixture.data, fixture.moves);
  corpus = emptyCorpus();
  // The eight base inputs (all but Mimic, which this dex lacks), each walked with two seeds.
  for (const [input, steps] of BASE_WALKS.slice(0, 8)) for (const seed of [1, 2]) walk(corpus, input(), steps, seed, 1_500);
  const ember = createBattle(emberTurn());
  const spent = createBattle(emberTurn([ID.meanLook], { pp: [0, FIXTURE_MOVES.get(ID.tackle)!.pp] })); // Ember at 0 PP
  const hurt = corpus.outcomes.find((outcome) => outcome.state.phase.kind === 'turnChoice' && hpOf(outcome.state).p1[0]! > 0)!.state;
  levelUps = [
    levelUp(ember, 0, 33),
    levelUp(ember, 0, 34, { moveId: ID.uTurn, replaceSlot: null }), // a move added to a free slot
    levelUp(spent, 0, 31, { moveId: ID.waterBall, replaceSlot: 0 }), // the slot at 0 PP replaced
    levelUp(hurt, 0, 60),
  ];
}, 600_000);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cached readers', () => {
  it('the corpus reaches every phase, and sleep and poison, a carried sleep among them', () => {
    expect(new Set(corpus.phases)).toEqual(new Set(ALL_PHASES));
    expect(corpus.states.length).toBeGreaterThan(300);
    const statuses = new Set(corpus.states.flatMap((state) => carryOut(state).mons.map((mon) => mon.status.kind)));
    for (const kind of ['sleep', 'sleepUndrawn', 'poison']) expect(statuses, kind).toContain(kind);
  });

  it('every reader answers for each state the engine built what it answers for the same state rebuilt (uncached)', () => {
    expect(cacheMismatches([...corpus.states, ...levelUps])).toEqual([]);
  }, 600_000);

  it('a cached read restores nothing; a state rebuilt restores once and is then cached itself', () => {
    const fromJSON = spyFromJSON();
    const root = createBattle(pivots());
    const outcome = expandTurn(root, PIVOT)[0]!.state;
    const up = levelUp(root, 1, 45, { moveId: ID.ember, replaceSlot: null });
    const cheap = (state: EngineState) => [carryOut(state), hpOf(state), legalChoices(state, 'p1'), legalChoices(state, 'p2')];
    const calls = (run: () => void) => {
      fromJSON.mockClear();
      run();
      return fromJSON.mock.calls.length;
    };
    expect(calls(() => { cheap(outcome); cheap(outcome); })).toBe(0);
    // Both lazy fields read the one peeked battle.
    expect(calls(() => { showdownEngine.observe(outcome); unmodelledIn(outcome); showdownEngine.observe(outcome); unmodelledIn(outcome); })).toBe(1);
    expect(calls(() => { for (const state of [root, up]) { cheap(state); showdownEngine.observe(state); unmodelledIn(state); } })).toBe(0);
    const copy = { ...outcome };
    expect(calls(() => { carryOut(copy); cheap(copy); })).toBe(1);
  });

  it('the cache is not in the state: the same four fields, and the key of its restore', () => {
    for (const state of [...corpus.states, ...levelUps]) {
      expect(Object.keys(state)).toEqual(['json', 'turn', 'phase', 'key']);
      expect(stateKey(restore(state))).toBe(state.key);
    }
  }, 600_000);

  it('hpOf: the carry\'s HP for the player, 0 for every Pokémon an outcome fainted, and the Engine\'s', () => {
    expect(showdownEngine.hpOf).toBe(hpOf);
    for (const state of corpus.states) expect(hpOf(state).p1).toEqual(carryOut(state).mons.map((mon) => mon.hp));
    const faintedHp = corpus.outcomes.flatMap((outcome) => (['p1', 'p2'] as const).flatMap((side) => outcome.fainted[side].map((index) => hpOf(outcome.state)[side][index])));
    expect(faintedHp.length).toBeGreaterThan(0);
    expect(faintedHp.every((hp) => hp === 0)).toBe(true);
    const restored = restore(corpus.states[1]!);
    expect(hpOf(corpus.states[1]!).p2).toEqual(restored.p2.team.map((set) => restored.p2.pokemon.find((pokemon) => pokemon.set === set)!.hp));
  });

  it('readers return copies: changing one answer changes no later one', () => {
    const state = corpus.outcomes.find((outcome) => legalChoices(outcome.state, 'p1').length > 1)!.state;
    const fresh = () => ({ carry: carryOut(state), hp: hpOf(state), p1: legalChoices(state, 'p1'), unmodelled: unmodelledIn(state) });
    const first = fresh();
    first.carry.mons[0]!.hp = -1;
    first.carry.mons[0]!.pp[0] = -1;
    (first.carry.mons[0]!.status as { kind: string }).kind = 'changed';
    first.hp.p1[0] = -1;
    first.hp.p2.pop();
    (first.p1[0] as { kind: string }).kind = 'changed';
    first.p1.pop();
    first.unmodelled.push('changed');
    expect(fresh()).toEqual({ carry: carryOut({ ...state }), hp: hpOf({ ...state }), p1: legalChoices({ ...state }, 'p1'), unmodelled: unmodelledIn({ ...state }) });
  });

  it('an entry or a lazy field made under another dex install is a miss', () => {
    const fromJSON = spyFromJSON();
    const state = createBattle(emberTurn());
    fromJSON.mockClear();
    carryOut(state);
    expect(fromJSON).toHaveBeenCalledTimes(0);
    underOtherInstall(() => {
      expect(carryOut(state)).toEqual(carryOut({ ...state }));
      carryOut(state);
      expect(fromJSON).toHaveBeenCalledTimes(2); // the state's miss, and the copy's
    });
    const stepped = expandTurn(createBattle(pivots()), PIVOT)[0]!.state;
    const observation = showdownEngine.observe(stepped);
    fromJSON.mockClear();
    expect(showdownEngine.observe(stepped)).toBe(observation);
    expect(fromJSON).toHaveBeenCalledTimes(0);
    underOtherInstall(() => {
      expect(showdownEngine.observe(stepped)).toBe(observation);
      expect(fromJSON).toHaveBeenCalledTimes(1); // the peek under the new install
      expect(unmodelledIn(stepped)).toEqual(unmodelledIn({ ...stepped }));
    });
  });

  it('merged leaves: each outcome\'s state is its kept leaf\'s, cached, and the step\'s outcomes are as before', () => {
    const fromJSON = spyFromJSON();
    const root = createBattle(emberTurn());
    const outcomes = expandTurn(root, BOTH, { collapse: false });
    expect(outcomes.some((outcome) => outcome.merged > 1)).toBe(true);
    fromJSON.mockClear();
    for (const outcome of outcomes) carryOut(outcome.state);
    expect(fromJSON).toHaveBeenCalledTimes(0);
    expect(cacheMismatches(outcomes.map((outcome) => outcome.state))).toEqual([]);
    expect(expandTurn(root, BOTH, { collapse: false })).toEqual(outcomes);
  });

  it('rememberLive reads a live battle\'s move slots as a restore does: a virtual copy, a slot object of its own, another move', () => {
    // State.deserializePokemon puts the move slot in place of its base slot when the IDs match and it isn't virtual.
    const live = restore(createBattle(sixes()));
    const [a, b, c] = live.p1.pokemon;
    a!.moveSlots[0] = { ...a!.moveSlots[0]!, pp: 1, virtual: true }; // a copy: the base slot's PP stays
    b!.moveSlots[1] = { ...b!.moveSlots[1]!, pp: 2 }; // same move: its PP is the carry's
    c!.moveSlots[2] = { ...c!.moveSlots[2]!, id: 'tackle' as ID, move: 'Tackle', pp: 3 }; // another move: the base slot's PP
    const state = snapshot(live);
    rememberLive(state, live);
    const fromJSON = spyFromJSON();
    const cached = carryOut(state);
    expect(fromJSON).toHaveBeenCalledTimes(0);
    expect(cached).toEqual(carryOut({ ...state }));
    expect([cached.mons[0]!.pp[0] === 1, cached.mons[1]!.pp[1], cached.mons[2]!.pp[2] === 3]).toEqual([false, 2, false]);
  });

  it('rememberRestored keeps the observation and the unmodelled list a fresh restore gives', () => {
    for (const state of [createBattle(pivots()), createBattle(locks()), ...levelUps]) {
      const kept = rememberRestored({ ...state });
      expect(showdownEngine.observe(kept)).toBe(observe(restore(state), []));
      expect(unmodelledIn(kept)).toEqual(unmodelledInBattle(restore(state)));
    }
  });

  it('a capture never throws: a carry that throws is left to the reader, which throws as before', () => {
    // An undrawn sleep counter with Early Bird off for an attempt: startStatusOf (sets.ts) throws for it.
    const battle = restore(createBattle(emberTurn([ID.meanLook], { ability: knownAbility(ABILITY.earlyBird) })));
    const mon = battle.p1.active[0]!;
    (mon as { status: string }).status = 'slp';
    delete mon.statusState['time'];
    mon.statusState['slept'] = 1;
    const built = snapshot(battle);
    expect(() => carryOut({ ...built })).toThrow(/undrawn sleep counter/);
    const fromRestore = { ...built };
    expect(() => rememberRestored(fromRestore)).not.toThrow();
    const live = restore(built);
    const fromLive = snapshot(live);
    expect(() => rememberLive(fromLive, live)).not.toThrow();
    const fromJSON = spyFromJSON();
    for (const state of [fromRestore, fromLive]) {
      fromJSON.mockClear();
      expect([hpOf(state), legalChoices(state, 'p1')]).toEqual([hpOf({ ...built }), legalChoices({ ...built }, 'p1')]);
      expect(fromJSON).toHaveBeenCalledTimes(2); // the two copies'
      expect(() => carryOut(state)).toThrow(/undrawn sleep counter/);
    }
  });
});

describe('peek', () => {
  it('gives one battle per state object while it is kept, in an LRU of PEEK_LIMIT', () => {
    const [state, other] = [corpus.states[1]!, corpus.states[2]!];
    const first = peek(state);
    expect(peek(state)).toBe(first);
    expect(peek({ ...state })).not.toBe(first);
    expect(peek(state)).toBe(first);
    for (let i = 0; i < PEEK_LIMIT; i++) peek({ ...other });
    const again = peek(state);
    expect(again).not.toBe(first);
    expect(JSON.stringify(again.toJSON())).toBe(JSON.stringify(first.toJSON()));
  });

  it('a battle peeked under one dex install is restored again under another', () => {
    const state = createBattle(pivots());
    const first = peek(state);
    expect(peek(state)).toBe(first);
    underOtherInstall(() => {
      const again = peek(state);
      expect(again).not.toBe(first);
      expect(peek(state)).toBe(again);
      expect(JSON.stringify(again.toJSON())).toBe(JSON.stringify(first.toJSON()));
    });
    expect(peek(state)).not.toBe(first); // the entry is the other install's now
  });

  it('refuses every write through a peeked battle and every chance draw, allows reads, and leaves the shared dex, format and rule table unfrozen', () => {
    const battle = peek(createBattle(pivots()));
    const mon = battle.p1.active[0]!;
    const writes: [string, () => void][] = [
      ['hp', () => { mon.hp = 1; }],
      ['status', () => { (mon as { status: string }).status = 'brn'; }],
      ['a boost', () => { mon.boosts.atk = 1; }],
      ['a PP', () => { mon.moveSlots[0]!.pp = 0; }],
      ['set.level', () => { mon.set.level = 99; }],
      ['a volatile', () => { (mon.volatiles as Record<string, unknown>)['confusion'] = { id: 'confusion' }; }],
      ['a side condition', () => { (battle.p1.sideConditions as Record<string, unknown>)['reflect'] = { id: 'reflect' }; }],
      ['the weather', () => { (battle.field as { weather: string }).weather = 'raindance'; }],
      ['formatData', () => { battle.formatData['x'] = 1; }],
      ['the bag', () => { trainerBag(battle).items[0] = 0; }],
      ['a choice', () => { battle.p1.choice.actions.push({} as never); }],
      ['the log', () => { battle.log.push('|x|'); }],
      ['the party order', () => { battle.p1.pokemon.reverse(); }],
      ['the turn', () => { (battle as { turn: number }).turn = 9; }],
      ['a step', () => { applyChoices(battle, BOTH); }],
    ];
    for (const [name, write] of writes) expect(write, name).toThrow();
    expect(() => battle.prng.random(2)).toThrow(/peeked battle drew a chance/);
    expect(() => battle.randomChance(1, 2)).toThrow(/peeked battle drew a chance/);
    const reads: [string, () => unknown][] = [
      ['a species', () => battle.dex.species.get('pikachu')], ['a move', () => battle.dex.moves.get('tackle')],
      ['the queue', () => battle.queue.list.some(() => true)], ['a request', () => battle.p1.activeRequest],
      ['hasAbility', () => mon.hasAbility('blaze')], ['ignoringItem', () => mon.ignoringItem()], ['toJSON', () => battle.toJSON()],
      ['observe', () => observe(battle, [])], ['p1 choices', () => choicesIn(battle, 'p1')], ['carry', () => carryIn(battle)],
      ['hp', () => hpIn(battle)], ['unmodelled', () => unmodelledInBattle(battle)],
    ];
    for (const [name, read] of reads) expect(read, name).not.toThrow();
    expect(mon.hp).toBe(restore(createBattle(pivots())).p1.active[0]!.hp);
    expect([battle, mon, battle.formatData, battle.dex, battle.format, battle.ruleTable].map((object) => Object.isFrozen(object))).toEqual([true, true, true, false, false, false]);
  });

  it('the freeze is on under vitest, and off in a plain node process unless PKP_FREEZE_PEEK=1', () => {
    expect(FREEZE_PEEKED).toBe(true);
    expect(Object.isFrozen(peek(createBattle(pivots())))).toBe(true);
    // The probe runs from the repository root, where `--import tsx` and tsx's tsconfig are found.
    const script = fileURLToPath(new URL('./peekFreezeProbe.ts', import.meta.url));
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const probe = (extra: Record<string, string>): string => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
      for (const name of ['VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID']) delete env[name];
      if (extra.PKP_FREEZE_PEEK === undefined) delete env.PKP_FREEZE_PEEK;
      const r = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: root, env, encoding: 'utf8' });
      expect([r.error, r.stderr, r.status, r.signal]).toEqual([undefined, '', 0, null]);
      return r.stdout.trim();
    };
    expect([probe({}), probe({ PKP_FREEZE_PEEK: '1' })]).toEqual(['flag=false frozen=false draws=throws', 'flag=true frozen=true draws=throws']);
  }, 90_000);

  it('peeking, and writes refused through the peek, change nothing the engine answers for the state', () => {
    const state = createBattle(pivots());
    const [json, key, before, read] = [state.json, state.key, expandTurn(state, PIVOT), readAll({ ...state })];
    const battle = peek(state);
    for (const write of [() => { battle.p1.active[0]!.hp = 1; }, () => { battle.formatData['x'] = 1; }, () => { battle.p2.pokemon.reverse(); }]) expect(write).toThrow();
    expect(expandTurn(state, PIVOT)).toEqual(before);
    expect([state.json, state.key, readAll(state), readAll({ ...state })]).toEqual([json, key, read, read]);
  });

  it('a peeked battle reads as a restored one: the observation and the unmodelled list over the corpus', () => {
    const differ = [...corpus.states, ...levelUps].filter((state) => {
      const [peeked, restored] = [peek(state), restore(state)];
      return observe(peeked, []) !== observe(restored, []) || !isDeepStrictEqual(unmodelledInBattle(peeked), unmodelledInBattle(restored));
    }).map((state) => state.key);
    expect(differ).toEqual([]);
  }, 600_000);
});
