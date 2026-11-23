// The readers of an engine state, answered without a restore for a state the engine built.
//
// What is kept, and when. Beside each state object the engine builds, in a `WeakMap` keyed by the object (never in its
// `json` or `key`, so no key or JSON changes), an entry holds what the readers answer for it, computed by the readers'
// own functions (battle.ts `carryIn`, `hpIn` and `choicesIn`; observe.ts `observe` with no step log; unmodelled.ts
// `unmodelledInBattle`):
// - `expandTurn` (expand.ts): when a leaf becomes its merge class's kept leaf, the one whose state the outcome returns,
//   the carry, HP and both sides' legal choices from that leaf's live battle (`rememberLive`). The observation and
//   the unmodelled list are computed on the first read, from the state's peeked battle (`peek`), and kept.
// - `createBattle` and `levelUp`: all five from one restore of the new state (`rememberRestored`). Their live battles
//   are not read: `createBattle` sets the trainer's PP, and `levelUp` a learned move, after the requests were made.
// - Any other state object (parsed from JSON elsewhere, a `{ ...state }` copy, a `snapshot` a caller made): on its first
//   read, from a restore as before, then kept under that object.
// An entry carries the dex install it was read under (dex.ts `installToken`): under another install it is a miss, as
// the readers depend on the installed mod (the restore builds the battle in it; `unmodelledIn` reads its moves).
// Readers return copies, as they returned fresh objects before. Keeping never throws: a field whose computation throws
// is left out, and its reader computes it from a restore and throws there, as before.
//
// Why a kept answer is the restore's. Each reader's function reads only fields of the battle that `toJSON` writes and
// `Battle.fromJSON` reads back unchanged (integers, strings, booleans, plain objects; the party order through
// `side.team`), and that the key covers; no reader reads the log, which a restore clears. Two things a restore makes
// rather than reads back, and `rememberLive` makes them the same way:
// - the requests: `side.activeRequest` is not serialised; `State.deserializeBattle` makes them again with
//   `battle.getRequests(battle.requestState)` for every side not serialised as null (Showdown 0.11.11
//   dist/sim/state.js:132-142). `remakeRequests` does exactly that on the live battle. `getRequests` draws no chance,
//   and its writes (`trapped` for a locked Pokémon, the `maybe*` flags, pokemon.js:728-764) are idempotent: the step's
//   own `makeRequest` made them before the snapshot, so the JSON holds them;
// - the base move slots: `State.deserializePokemon` puts a Pokémon's move slot in place of its base move slot of the
//   same index when the IDs match and the slot is not a virtual copy (state.js:199-211); `restoredBaseSlots` mirrors it
//   for the carry's PP.
// Merged leaves: the kept fields come from the kept leaf's own battle, whose snapshot is the outcome's state object.
// (Every reader reads only keyed content, so any leaf of the class would give the same answers; nothing relies on it.)
//
// `peek` (the end of this file): one battle per state object for read-only callers, kept in a bounded LRU
// (not a `WeakMap`: the solver keeps many states alive, and a battle per state would hold hundreds of MB), with a chance
// driver that throws and, under test, deep-frozen, so a write or a draw through it throws instead of changing what later
// readers of the state see. The battle of an `expandTurn` outcome is the kept leaf's own live battle,
// handed over at the capture (`keepLive`, after `rememberLive`) and reset to what a restore gives, so the trainer AI's
// first peek of an outcome restores nothing. Kept battles nobody has read yet wait in their own pool (the unread pool,
// `SEED_LIMIT`), beside the LRU; `peek` says what a reader may read of either.

import type { CarryState, Choice, EngineState, Side } from '../contracts/engine.js';
import { type CarriedMon, carryIn, choicesIn, hpIn, restore } from './battle.js';
import { attachDriver, ChanceDriver } from './chance.js';
import { installToken } from './dex.js';
import { forgetSpeedOrder, hasSpeedOrderMemo } from './mod/speedOrder.js';
import { observe } from './observe.js';
import { describeDifferences, peekDifferences } from './peekCheck.js';
import { unmodelledInBattle } from './unmodelled.js';

type MoveSlot = Pokemon['moveSlots'][number];
type Hp = { p1: number[]; p2: number[] };

const SIDES = ['p1', 'p2'] as const;

/** What the readers answer for one state object, under one dex install; a field is absent until computed, or when computing it threw. */
interface Facts {
  readonly install: object;
  carry?: { mons: CarriedMon[] }; // every field, EXP and moves included from `carryIn` at capture
  hp?: Hp;
  legal: Partial<Record<Side, Choice[]>>;
  observation?: string;
  unmodelled?: string[];
}

const facts = new WeakMap<EngineState, Facts>();

/** `compute()`, or undefined when it throws. */
function attempt<T>(compute: () => T): T | undefined {
  try {
    return compute();
  } catch {
    return undefined;
  }
}

/** The carry, HP and legal choices of `battle` that `entry` lacks, each left out if computing it throws. */
function fill(entry: Facts, battle: Battle, slotsOf?: (pokemon: Pokemon) => readonly MoveSlot[] | null): void {
  entry.carry ??= attempt(() => carryIn(battle, slotsOf));
  entry.hp ??= attempt(() => hpIn(battle));
  for (const side of SIDES) entry.legal[side] ??= attempt(() => choicesIn(battle, side));
}

/**
 * A Pokémon's base move slots as a restore would hold them (`State.deserializePokemon`, state.js:199-211, with the engine's
 * guard, restoreGuard.ts): a base slot past the move slots (a Transformed Pokémon with more moves of its own than copied)
 * stays its own.
 */
function restoredBaseSlots(pokemon: Pokemon): readonly MoveSlot[] {
  const { baseMoveSlots: base, moveSlots } = pokemon;
  if (base.length === moveSlots.length && base.every((slot, i) => slot === moveSlots[i])) return base;
  return base.map((slot, i) => {
    const moveSlot = moveSlots[i];
    return moveSlot !== undefined && moveSlot.id === slot.id && !moveSlot.virtual ? moveSlot : slot;
  });
}

/** Makes `battle`'s requests again as a restore does (`State.deserializeBattle`, state.js:132-142). */
function remakeRequests(battle: Battle): true {
  if (battle.sides.some((side) => side.activeRequest !== null)) {
    const requests = battle.getRequests(battle.requestState);
    battle.sides.forEach((side, i) => {
      side.activeRequest = side.activeRequest === null ? null : requests[i]!;
    });
  }
  return true;
}

/**
 * Keeps the carry, HP and legal choices of `state`, the snapshot of `battle`, a live leaf battle of `expandTurn`. It
 * changes `battle` (its chance driver, first, so the leaf's driver records nothing more; its requests, made again as a
 * restore makes them, with their idempotent writes), so the caller calls it after everything else that reads the battle
 * or the leaf's driver, and then either drops the battle or hands it to `keepLive`. Returns whether it made the requests
 * again (`keepLive` keeps the battle only then). Never throws.
 */
export function rememberLive(state: EngineState, battle: Battle): boolean {
  let remade = false;
  try {
    const entry: Facts = { install: installToken(), legal: {} };
    attachDriver(battle, new ChanceDriver([])); // the driver `restore` attaches
    entry.carry = attempt(() => carryIn(battle, restoredBaseSlots));
    entry.hp = attempt(() => hpIn(battle));
    if (attempt(() => remakeRequests(battle)) === true) {
      remade = true;
      for (const side of SIDES) entry.legal[side] = attempt(() => choicesIn(battle, side));
    }
    facts.set(state, entry);
  } catch {
    return false; // nothing kept: the readers restore
  }
  return remade;
}

/**
 * Keeps everything the readers answer for `state`, from one restore of it, and returns `state`. Never throws. The
 * observation and the unmodelled list, which only read the battle, are computed first: `choicesIn` runs Showdown events
 * (p2's bag check, the requests' `getLockedMove`), which write the battle's event state, so they come last.
 */
export function rememberRestored(state: EngineState): EngineState {
  try {
    const entry: Facts = { install: installToken(), legal: {} };
    const battle = restore(state);
    entry.observation = attempt(() => observe(battle, []));
    entry.unmodelled = attempt(() => unmodelledInBattle(battle));
    fill(entry, battle);
    facts.set(state, entry);
  } catch {
    // nothing kept: the readers restore
  }
  return state;
}

/** `state`'s entry under the installed dex (a new, empty one for a state not seen under it), or null with no dex installed. */
function entryOf(state: EngineState): Facts | null {
  const install = attempt(installToken);
  if (install === undefined) return null;
  let entry = facts.get(state);
  if (entry === undefined || entry.install !== install) {
    entry = { install, legal: {} };
    facts.set(state, entry);
  }
  return entry;
}

/**
 * A field of `state`'s entry (`get`), else, from one restore of `state`, every carry, HP and legal-choice field the entry
 * lacks, then that field; one that throws there is computed again (`compute`) to throw as the reader did before.
 */
function cheap<T>(state: EngineState, get: (entry: Facts) => T | undefined, compute: (battle: Battle) => T): T {
  const entry = entryOf(state);
  if (entry === null) return compute(restore(state));
  const kept = get(entry);
  if (kept !== undefined) return kept;
  const battle = restore(state);
  fill(entry, battle);
  return get(entry) ?? compute(battle);
}

/**
 * A field computed on its first read from `state`'s peeked battle (`peek`: `compute` only reads, so the frozen battle
 * serves, and the other lazy field and the trainer AI's reads of the state share its one restore), and kept in its entry.
 */
function lazy<T>(state: EngineState, get: (entry: Facts) => T | undefined, set: (entry: Facts, value: T) => void, compute: (battle: Battle) => T): T {
  const entry = entryOf(state);
  const kept = entry === null ? undefined : get(entry);
  if (kept !== undefined) return kept;
  const value = compute(entry === null ? restore(state) : peek(state));
  if (entry !== null) set(entry, value);
  return value;
}

/**
 * What the player's party carries out of `state`, in party order (battle.ts `carryIn`): each Pokémon's HP, the PP and ROM
 * move IDs of its own moves in slot order (not Transform's or Mimic's copies), its status, its held item as a ROM item
 * ID (0 for none) and its total EXP. `item`, `exp` and `moves` are always given (the contract).
 */
export function carryOut(state: EngineState): CarryState {
  const carry = cheap(state, (entry) => entry.carry, (battle) => carryIn(battle));
  return {
    mons: carry.mons.map((mon) => ({
      hp: mon.hp, pp: [...mon.pp], status: { ...mon.status }, item: mon.item, exp: mon.exp, moves: [...mon.moves],
    })),
  };
}

/**
 * Each side's current HP by party index, in the side's original party order, 0 for a fainted Pokémon (battle.ts `hpIn`):
 * the contract's optional `Engine.hpOf`, for search ordering only.
 */
export function hpOf(state: EngineState): Hp {
  const hp = cheap(state, (entry) => entry.hp, hpIn);
  return { p1: [...hp.p1], p2: [...hp.p2] };
}

/** The choices `side` has in `state`; none when it has nothing to decide (battle.ts `choicesIn`). */
export function legalChoices(state: EngineState, side: Side): Choice[] {
  return cheap(state, (entry) => entry.legal[side], (battle) => choicesIn(battle, side)).map((choice) => ({ ...choice }));
}

/** What the player sees in `state`, the root view: observe.ts `observe` with no step log (`Engine.observe`; not an outcome's observation). */
export function observeState(state: EngineState): string {
  return lazy(state, (entry) => entry.observation, (entry, value) => { entry.observation = value; }, (battle) => observe(battle, []));
}

/** What in `state`'s battle the engine doesn't model (unmodelled.ts `unmodelledInBattle`). Non-empty means a proof through it is unproven. */
export function unmodelledIn(state: EngineState): string[] {
  return [...lazy(state, (entry) => entry.unmodelled, (entry, value) => { entry.unmodelled = value; }, unmodelledInBattle)];
}

// `peek`: one battle per state object for read-only callers; `expandTurn` seeds it.

/**
 * The most battles `peek` keeps once read: an LRU by state object. Sized from real solves (four benchmark solves,
 * one thread, the peeks replayed against LRU sizes 16 to 512): a kept battle holds about 37 KB (2v2)
 * to 69 KB (6v4) of heap, so about 75 KB at 6v6, and every solve worker has its own cache (up to 4 workers by default,
 * `defaultThreads`), which the solver's store byte cap doesn't count. Nearly every peek is of a new state (0.1% to 12.5% of
 * peeks were of a kept one at 256), and the hit rate at 64 is within 1 point of 256's on all four runs (16 is not, on
 * two of them), so 64 keeps about 5 MB per worker, where 256 kept about 17 MB for the same hits. The unread pool
 * (`SEED_LIMIT`) is apart from it.
 */
export const PEEK_LIMIT = 64;

/**
 * The most kept battles nobody has peeked yet (the unread pool): `expandTurn` outcomes' battles, oldest
 * first; a peek moves one to the LRU, and only a later seed pushes one out. The solver reads a call's outcomes in order,
 * so the pool must hold a wide turn's outcomes until they are read. Measured on five benchmark solves (one
 * thread, fixed work): at 128, the Galactic Venus one (whose widest turns keep more than 128 outcomes)
 * still restored 626 of its 3,340 first peeks, 2.4 to 3.2% of its wall; at 256, 7. Three others are the same at both sizes,
 * the fifth 1 point apart. A kept battle holds 59 to 74 KB, so a full pool of 256 is 15 to 19 MB of battles per solve worker
 * (each worker has its own), beside the LRU's 4.5 MB. The pool also holds its states, its keys: an outcome the solver has
 * dropped (a dead or unlabelled one, a kept leaf nobody reads) stays alive here with its JSON, about 34 KB at 6v6,
 * so up to about 9 MB more per worker. None of it is in the solver's store byte cap.
 */
export const SEED_LIMIT = 256;

const env = (name: string): string | undefined => (typeof process === 'undefined' ? undefined : process.env[name]);
const UNDER_TEST = env('VITEST') !== undefined;

/**
 * Whether `peek` deep-freezes the battle it keeps: only in a test. `process.env.VITEST` is set in every vitest run
 * (unit, web and real, worker threads included); `PKP_FREEZE_PEEK=1` turns it on by hand. It is off for `serve`,
 * `bench:split`, `profile:solve` and the solve workers: the freeze is a bug trap for tests, and cost about 15% of every
 * peek. Read once, at load; `peekConfig.freeze` starts from it.
 */
export const FREEZE_PEEKED: boolean = UNDER_TEST || env('PKP_FREEZE_PEEK') === '1';

/**
 * `peek`'s switches, read once at load; tests and tools may change them, nothing else does. Not exported
 * from index.ts.
 * - `seed` (on unless `PKP_SEED_PEEK=0`): `expandTurn` hands its kept leaves' battles to `peek` (`keepLive`). Off,
 *   every first peek restores, as before the seeding existed: the switch to rule the seeding out of any doubted result.
 * - `verify` (on under vitest, or with `PKP_VERIFY_PEEK=1`): a kept battle's first peek compares it with a restore of its
 *   state (peekCheck.ts `peekDifferences`) and throws on any difference a reader could see.
 * - `freeze` (`FREEZE_PEEKED`): `peek` deep-freezes each battle it gives out the first time (`freezeOwned`).
 * - `seedLimit` (`SEED_LIMIT`): the unread pool's size.
 */
export const peekConfig: { seed: boolean; verify: boolean; freeze: boolean; seedLimit: number } = {
  seed: env('PKP_SEED_PEEK') !== '0',
  verify: UNDER_TEST || env('PKP_VERIFY_PEEK') === '1',
  freeze: FREEZE_PEEKED,
  seedLimit: SEED_LIMIT,
};

interface Kept { readonly install: object; readonly battle: Battle }

/** Read battles, least recently peeked first (at most `PEEK_LIMIT`). */
const peeked = new Map<EngineState, Kept>();
/** Kept battles nobody has peeked, oldest first (at most `peekConfig.seedLimit`). A state is never in both maps. */
const unread = new Map<EngineState, Kept>();

/** The number of battles in each of `peek`'s two pools, for tests and tools. */
export function peekPoolSizes(): { unread: number; read: number } {
  return { unread: unread.size, read: peeked.size };
}

/**
 * The chance driver of a peeked battle: any draw throws, as a draw is a step, which a peeked battle never takes. Exported
 * for tests (a restore to compare a peeked battle with), not from index.ts.
 */
export class NoChanceDriver extends ChanceDriver {
  override pick(): number {
    throw new Error('a read of a peeked battle drew a chance: restore the state to step it');
  }
}

/**
 * Hands `battle`, the live battle of an `expandTurn` leaf that just became its class's kept leaf, to `peek` as the battle
 * of `state`, its snapshot. `remade` is `rememberLive`'s answer: the battle is kept only when the requests
 * were made again as a restore makes them. `replaced` is the state of the class's former kept leaf, or null: its battle
 * is dropped at once (its state is garbage). The battle first gets what a restore gives (battle.ts `restoreParsed`): a
 * chance driver that throws, an empty log and input log, `sentLogPos` 0 and `lastMoveLine` -1, the base move slots a
 * restore makes (`restoredBaseSlots`), and no `monSpeedOrder` memo (mod/speedOrder.ts). Never throws: on a throw nothing
 * is kept, and the first peek restores. The caller drops the battle afterwards.
 */
export function keepLive(state: EngineState, battle: Battle, remade: boolean, replaced: EngineState | null): void {
  if (replaced !== null) unread.delete(replaced);
  if (!peekConfig.seed || !remade) return;
  try {
    const install = installToken();
    attachDriver(battle, new NoChanceDriver([]));
    battle.log.length = 0; // in place, as `restoreParsed` does: nothing else holds the leaf's log (`leafOf` copied it)
    battle.inputLog.length = 0;
    battle.sentLogPos = 0; // an equivalent reset: nothing sends a leaf's log, so it is 0 already; as `restoreParsed`
    battle.lastMoveLine = -1;
    for (const side of battle.sides) {
      for (const pokemon of side.pokemon) {
        const slots = restoredBaseSlots(pokemon);
        if (slots !== pokemon.baseMoveSlots) (pokemon as { baseMoveSlots: MoveSlot[] }).baseMoveSlots = [...slots];
      }
    }
    forgetSpeedOrder(battle);
    unread.set(state, { install, battle });
    while (unread.size > peekConfig.seedLimit) unread.delete(unread.keys().next().value!);
  } catch {
    // nothing kept: the first peek restores
  }
}

/** Drops `state`'s kept battle if nobody has peeked it: `expandTurn` calls it for every outcome of a call that throws. */
export function dropKept(state: EngineState): void {
  unread.delete(state);
}

/**
 * Deep-freezes `battle`'s own object graph: the battle, its field, sides, Pokémon and queue, and every plain object and
 * array reachable from them through own enumerable properties (`formatData`, each Pokémon's set, move slots, boosts,
 * volatiles and states, each side's conditions, choice and requests, the log...). Not what other battles share: the dex
 * and its entries, the format, the rule table, the chance generator and the actions, whose prototypes are none of these.
 * Known gaps, left writable: `Set`s (`battle.hints`, `side.choice.switchIns`) and active-move copies (`battle.activeMove`,
 * a queued action's `move`), which have a `Move` prototype.
 */
function freezeOwned(battle: Battle): void {
  const own = new Set<object | null>([
    Object.prototype, Array.prototype, null,
    Object.getPrototypeOf(battle), Object.getPrototypeOf(battle.field), Object.getPrototypeOf(battle.sides[0]!),
    Object.getPrototypeOf(battle.sides[0]!.pokemon[0]!), Object.getPrototypeOf(battle.queue),
  ]);
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
    if (!own.has(Object.getPrototypeOf(value) as object | null)) return;
    Object.freeze(value);
    for (const key of Object.keys(value)) walk((value as Record<string, unknown>)[key]);
  };
  walk(battle);
}

/**
 * A kept battle's first peek: with `peekConfig.verify`, throws when it holds a `monSpeedOrder` memo (outside
 * its object graph; a restore has none) or differs from a restore of `state` in anything a reader keeping `peek`'s read
 * rule could see (peekCheck.ts `peekDifferences`); then, with `peekConfig.freeze`, deep-freezes it.
 */
function firstPeek(state: EngineState, battle: Battle): void {
  if (peekConfig.verify) {
    // Outside the object graph, so outside the walk: the mod's per-battle memo a live step leaves (keepLive drops it).
    if (hasSpeedOrderMemo(battle)) {
      throw new Error(`peek: the kept battle of ${state.key.slice(0, 12)} (turn ${state.turn}, ${state.phase.kind}) keeps a monSpeedOrder memo (mod/speedOrder.ts), which a restore doesn't have`);
    }
    const differences = peekDifferences(battle, restore(state, new NoChanceDriver([])));
    if (differences.length > 0) {
      throw new Error(`peek: the kept battle of ${state.key.slice(0, 12)} (turn ${state.turn}, ${state.phase.kind}) differs from its restore: ${describeDifferences(differences)}`);
    }
  }
  if (peekConfig.freeze) freezeOwned(battle);
}

/** Keeps `battle` as `state`'s read battle, most recent last, within `PEEK_LIMIT`. */
function keepRead(state: EngineState, kept: Kept): void {
  peeked.set(state, kept);
  if (peeked.size > PEEK_LIMIT) peeked.delete(peeked.keys().next().value!);
}

/**
 * The battle `state` holds, one per state object and kept, for read-only callers: the trainer-AI adapter, `battleView`,
 * the hints, the line builder's view, and the engine's own lazy readers. Two peeks of one state object give the same
 * battle while it is kept; under another dex install it is restored again. Where it comes from: the read LRU
 * (`PEEK_LIMIT`); else, for an `expandTurn` outcome, its kept leaf's own live battle from the unread pool (`keepLive`),
 * checked against a restore under test on this first peek and moved to the LRU; else a restore.
 *
 * The read rule: what a caller may read. A peeked battle equals `restore(state)` in every own property value at any
 * depth, and in the identity of its Battle, Side, Pokémon, Field, queue and set objects. Not promised, because a kept
 * leaf's battle and a restore differ there: anything inside an active-move copy
 * (`battle.lastMove`, `pokemon.lastMove`, `lastMoveUsed`, an effect state's `sourceEffect`, a queued action's `move`)
 * beyond its `id`, `num` and `name`, or that copy's identity (one shared copy live, one per place restored); inside a
 * queued action, or inside an effect state held in a condition map (a hazard's `duration`), and for a Pokémon's
 * staleness keys (Showdown's endless-battle bookkeeping), whether a key that reads `undefined` exists at all (`in`,
 * `Object.keys`, spreads); whether two value-equal plain arrays are one object. So read
 * values by name; never enumerate those objects' keys, test them with `in`, or compare arrays by identity. The condition
 * maps' own keys are promised: the engine's `observe` lists `sideConditions` and `pseudoWeather` by key, and the check
 * compares them strictly. The trainer AI keeps this rule (test/unit/engine/peekSeedAiRule.test.ts); a new caller must too.
 *
 * Guarded. Always: its chance driver throws on any draw (`NoChanceDriver`, which costs nothing), so a reader that draws
 * fails at once. Under test only (`peekConfig.freeze`: vitest, or `PKP_FREEZE_PEEK=1`): the battle's own object graph is
 * also deep-frozen (`freezeOwned`), so a peeked battle then allows property reads and dex lookups only. Any write
 * throws a `TypeError`, and so does any Showdown method that runs an event (`getStat`, `getTypes`, `getLockedMove`,
 * `legalChoices`' p2 bag check: `runEvent` writes the battle's `event`), which on this engine can also draw a speed
 * tie or store Speed values. Outside tests the freeze is off because it was about 15% of every peek and a reader that
 * writes is caught by the tests; so there, code that writes to a peeked battle would corrupt the kept copy silently.
 * Never pass a peeked battle to code that steps or changes it (`applyChoices`, `snapshot` after a change): `restore`
 * the state. Under test a kept battle that differs from its restore in what the rule promises throws on its first peek
 * (`peekConfig.verify`); `PKP_SEED_PEEK=0` turns the seeding off.
 */
export function peek(state: EngineState): Battle {
  const install = installToken();
  const kept = peeked.get(state);
  if (kept !== undefined) {
    peeked.delete(state);
    if (kept.install === install) {
      peeked.set(state, kept); // most recent last
      return kept.battle;
    }
  }
  const young = unread.get(state);
  if (young !== undefined) {
    unread.delete(state);
    if (young.install === install) {
      firstPeek(state, young.battle);
      keepRead(state, young);
      return young.battle;
    }
  }
  const battle = restore(state, new NoChanceDriver([]));
  if (peekConfig.freeze) freezeOwned(battle);
  keepRead(state, { install, battle });
  return battle;
}
