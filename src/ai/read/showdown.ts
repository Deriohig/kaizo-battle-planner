// The Showdown engine's AiBattleSource (contracts/aiRead.ts): every value of an engine state that the trainer AI
// reads and that depends on the state alone, from Showdown's Battle restored from EngineState.json, in the cartridge's
// own encodings (ROM IDs, the MON_CONDITION_*, VOLATILE_CONDITION_*, MOVE_EFFECT_*, SIDE_CONDITION_* and
// FIELD_CONDITION_* masks, the C counters). The composer (compose.ts viewFromRead) adds what only the AI's memory and the
// ROM data give. Every field's comment names its Showdown source and the conversion. `// GAP:` marks a value the state
// can't give exactly: the read gives what Showdown holds, or the flag the contract has for it, and the composer lists the
// path in `unknown`. Each gap has a spot-check item in
// docs/ai-spot-checks.md.
//
// Counters. A hidden counter the AI only tests for zero (docs/ai-reads.md) maps from Showdown's duration to a value
// clamped into the cartridge's bit field, at least 1 while the effect lasts (activeCounter: the contract's non-zero-only
// class). The counters the AI reads exactly are mapped exactly: the turn count, the turn a battler came in (Fake Out,
// Slow Start), Stockpile, Perish Song, Protect's chain, Last Resort and the hazard layers.
//
// Battlers: 0 is the player (p1), 1 the AI (p2), each side's `active[0]`. Pure: it reads the state's battle through
// peekBattle, the engine's one frozen battle per state object, and never writes to it.
//
// Errors. The read throws as the view's one-pass build did, in its order, up to that build's first read
// of the ROM data (the player's battler's weight, the composer's): no active Pokémon, the bag, the JSON accessors, the
// field note, then the player's battler's moves, types, ability and held item. A fault the one-pass build met only after
// that read (every other field it read), and a fault in a field it never read (the trainer and the request, which
// model.ts reads), is not thrown: the read holds a placeholder there and registers the fault beside it (compose.ts
// registerReadFaults), and the composer throws it where the view's build reaches that field. So a state with a missing
// weight and a party fault still reports the weight. A consumer of the read outside the composer gets a field with a
// registered fault through compose.ts: the trainer through `readTrainer(read)`, never `read.trainer`, which holds a
// placeholder (`{ romIndex: 0, aiMask: 0 }`, trainer 0 with no AI flags) after a fault; the request after
// `rethrowReadFault(read, 'request')`.

import PS from 'pokemon-showdown';
import type {
  AiBattleRead, AiBattleSource, AiReadEffects, AiReadIvs, AiReadMon, AiReadPartyMon, AiReadRequest,
} from '../../contracts/aiRead.js';
import type { EngineState, FieldSpec } from '../../contracts/engine.js';
import {
  battleField, battleStartLog, battleTrainer, KAIZO_FORMAT, lastSpeedValues, legalChoices, peek, quickClawRolls, trainerBag,
} from '../../engine/index.js';
import {
  ABILITY_NONE, BATTLE_TYPE_TRAINER_DOUBLES, BATTLE_TYPE_TRAINER_SINGLES, DEFAULT_STAT_STAGE, FIELD_CONDITION_HAILING_PERM,
  FIELD_CONDITION_HAILING_TEMP, FIELD_CONDITION_RAINING_PERM, FIELD_CONDITION_RAINING_TEMP, FIELD_CONDITION_SANDSTORM_PERM,
  FIELD_CONDITION_SANDSTORM_TEMP, FIELD_CONDITION_SUNNY_PERM, FIELD_CONDITION_SUNNY_TEMP, ITEM_NONE, LEARNED_MOVES_MAX,
  MON_CONDITION_BURN, MON_CONDITION_FREEZE, MON_CONDITION_NONE, MON_CONDITION_PARALYSIS, MON_CONDITION_POISON,
  MON_CONDITION_TOXIC, MOVE_DETECT, MOVE_EFFECT_ABILITY_SUPPRESSED, MOVE_EFFECT_AIRBORNE, MOVE_EFFECT_AQUA_RING,
  MOVE_EFFECT_CHARGE, MOVE_EFFECT_EMBARGO, MOVE_EFFECT_GRUDGE, MOVE_EFFECT_HEAL_BLOCK, MOVE_EFFECT_IMPRISON,
  MOVE_EFFECT_INGRAIN, MOVE_EFFECT_LEECH_SEED, MOVE_EFFECT_MAGNET_RISE, MOVE_EFFECT_MINIMIZE, MOVE_EFFECT_MIRACLE_EYE,
  MOVE_EFFECT_MUD_SPORT, MOVE_EFFECT_PERISH_SONG, MOVE_EFFECT_POWER_TRICK, MOVE_EFFECT_SHADOW_FORCE,
  MOVE_EFFECT_UNDERGROUND, MOVE_EFFECT_UNDERWATER, MOVE_EFFECT_WATER_SPORT, MOVE_ENDURE, MOVE_NONE, MOVE_PROTECT,
  MOVE_SLEEP_TALK, SIDE_CONDITION_FUTURE_SIGHT, SIDE_CONDITION_LIGHT_SCREEN, SIDE_CONDITION_MIST, SIDE_CONDITION_REFLECT,
  SIDE_CONDITION_SAFEGUARD, SIDE_CONDITION_SPIKES, SIDE_CONDITION_STEALTH_ROCK, SIDE_CONDITION_TOXIC_SPIKES,
  SIDE_CONDITION_WISH, VOLATILE_CONDITION_CURSE, VOLATILE_CONDITION_DEFENSE_CURL, VOLATILE_CONDITION_DESTINY_BOND,
  VOLATILE_CONDITION_FLINCH, VOLATILE_CONDITION_FOCUS_ENERGY, VOLATILE_CONDITION_FORESIGHT, VOLATILE_CONDITION_MEAN_LOOK,
  VOLATILE_CONDITION_MOVE_LOCKED, VOLATILE_CONDITION_NIGHTMARE, VOLATILE_CONDITION_RAGE, VOLATILE_CONDITION_RECHARGING,
  VOLATILE_CONDITION_SUBSTITUTE, VOLATILE_CONDITION_TORMENT, VOLATILE_CONDITION_TRANSFORM,
} from '../constants.js';
import { AiError } from '../errors.js';
import type { ProtocolIds } from '../memory.js';
import { attempt, type Caught, settled } from './caught.js';
import { type ReadFaultKey, registerReadFaults } from './compose.js';
import { dexLookup, formOf, genderOf, type IdLookup, romAbility, romItem, romMove, romTypes } from './ids.js';

type ShowdownSide = Battle['p1'];

// The bit fields' shifts and widths (include/constants/battle/condition.h, moves.h), for the counters packed in them.
const SLEEP_MAX = 7; // MON_CONDITION_SLEEP, bits 0–2
const TOXIC_COUNTER_SHIFT = 8; // MON_CONDITION_TOXIC_COUNTER, bits 8–11
const TOXIC_COUNTER_MAX = 15;
const CONFUSION_SHIFT = 0; // VOLATILE_CONDITION_CONFUSION, bits 0–2
const UPROAR_SHIFT = 4; // VOLATILE_CONDITION_UPROAR, bits 4–6
const BIDE_SHIFT = 8; // VOLATILE_CONDITION_BIDE, bits 8–9
const THRASH_SHIFT = 10; // VOLATILE_CONDITION_THRASH, bits 10–11
const BIND_SHIFT = 13; // VOLATILE_CONDITION_BIND, bits 13–15
const ATTRACT_SHIFT = 16; // VOLATILE_CONDITION_ATTRACT, one bit per battler from 16
const LOCK_ON_SHIFT = 3; // MOVE_EFFECT_LOCK_ON, bits 3–4
const YAWN_SHIFT = 11; // MOVE_EFFECT_YAWN, bits 11–12
const TAILWIND_SHIFT = 8; // SIDE_CONDITION_TAILWIND, bits 8–9
const LUCKY_CHANT_SHIFT = 12; // SIDE_CONDITION_LUCKY_CHANT, bits 12–14
const UPROAR_FIELD_SHIFT = 8; // FIELD_CONDITION_UPROAR, one bit per battler from 8
const GRAVITY_SHIFT = 12; // FIELD_CONDITION_GRAVITY, bits 12–14
const TRICK_ROOM_SHIFT = 16; // FIELD_CONDITION_TRICK_ROOM, bits 16–18
const TWO_BITS = 3;
const THREE_BITS = 7;

const PLAYER = 0;
const ENEMY = 1;

// The AI's one read of a restored battle. Every AI read of a state's Showdown battle goes
// through peekBattle: the read below and `support`'s request (model.ts). It is the engine's peek (facts.ts): one
// restore per state object, shared by `remember`'s turn fact, the `support` or `replacementSupport` that follows on the
// same state object and the engine's own lazy readers, kept in the engine's LRU and restored again under another dex
// install. The AI keeps no battle of its own. Nothing in the AI writes to a peeked battle, and the engine guards it
// always: its own object graph is deep-frozen and its chance driver throws, so a write or a draw through it throws
// (strict mode) instead of changing what later readers of the state see.
//
// The freeze has gaps (facts.ts freezeOwned): Sets (`battle.hints`, `side.choice.switchIns`) and the battle's own
// active-move copies (a battler's `lastMove`, a queued action's `move`), which have another prototype, stay writable. A
// write to one would not throw but would change the shared peek for every later reader, so AI code must never write to
// them on a peeked battle. This file reads two fields of the copies (`lastMove.id`, a queued `move.num`) and nothing of
// the Sets; the AI's tests freeze those copies before reading them (adapter.test.ts, model.test.ts).

/**
 * The battle in `state`, for the AI to read and never to write: the engine's `peek(state)`. The one seam through which
 * the AI reads a state's battle.
 */
export function peekBattle(state: EngineState): Battle {
  return peek(state);
}

/** A read, or what building it threw, over the dex the battle it was read from was restored with. */
interface KeptRead {
  readonly dex: object;
  readonly read: Caught<AiBattleRead>;
}

/**
 * The most reads the Showdown source keeps: the ones read last (an LRU by state object). A read is about
 * 25 KB on a 6-against-6 battle, and its base view (compose.ts, kept as long as its read) about as much again, while the
 * solver keeps tens of thousands of states alive (its edge cache), so a cache as long-lived as the states could add
 * hundreds of MB. A read that falls out is built again from its state, as the base views were after the engine's peek
 * of their battle fell out.
 */
export const READ_CAPACITY = 1024;

/**
 * A Showdown source keeping the `capacity` reads read last (READ_CAPACITY for `showdownAiSource`; tests pass a small
 * one). A state is immutable, so its read is too. Each read is kept with the installed dex it
 * was read under, and read again under another (installKaizoDex replaces the mod's dex, and the engine's peek then
 * restores the state again), as the engine's peek does by its install token. A hit makes the read the most recent. A read
 * outlives the engine's eviction of its peek. A failed read is kept the same way, and throws the same error each time.
 */
export function createShowdownAiSource(capacity: number = READ_CAPACITY): AiBattleSource {
  /** The reads, least recently read first. */
  const reads = new Map<EngineState, KeptRead>();
  return {
    read(state: EngineState): AiBattleRead {
      const kept = reads.get(state);
      if (kept !== undefined) {
        reads.delete(state);
        if (kept.dex === kaizoDex()) {
          reads.set(state, kept); // the most recent last
          return settled(kept.read);
        }
      }
      const battle = peekBattle(state);
      const read = attempt(() => showdownRead(battle, state));
      reads.set(state, { dex: battle.dex, read });
      if (reads.size > capacity) reads.delete(reads.keys().next().value!);
      return settled(read);
    },
    legalChoices(state) {
      return legalChoices(state, 'p2');
    },
    startLog(state) {
      return startLogOf(state);
    },
  };
}

/** The Showdown engine's source of the AI's reads, keeping the READ_CAPACITY read last. */
export const showdownAiSource: AiBattleSource = createShowdownAiSource();

/** How the read gets a field that may throw: at once (the field's throw goes through), or deferred (see the header). */
type Run = <T>(key: ReadFaultKey, compute: () => T, placeholder: T) => T;

const atOnce: Run = (_key, compute) => compute();

/**
 * The read of `state`, whose battle is `battle` (the state's peek, never written to), built in the order of the view's
 * one-pass build (see the header for which faults it throws and which it registers). Pure but for that registration.
 */
export function showdownRead(battle: Battle, state: EngineState): AiBattleRead {
  const player = activeOf(battle.p1);
  const enemy = activeOf(battle.p2);
  // BattleContext.totalTurns counts finished turns: 0 until the first turn ends, then +1 at each turn end
  // (battle_controller_player.c:1852). Showdown's `turn` is 1 for the first turn and rises at its end, and a mid-turn
  // or post-KO decision comes before that (Battle.endTurn runs once every switch is made). So turn − 1.
  const totalTurns = battle.turn - 1;
  // A used slot is 0 (battle start keeps only non-empty slots, battle_controller_player.c:4801–4813). Only the trainer
  // uses bag items in the engine (applyChoices refuses a p1 item).
  const bag = [...trainerBag(battle).items];
  const speeds = lastSpeedValues(accessorState(state));
  const rolls = quickClawRolls(accessorState(state));
  const fieldNote = fieldNoteOf(state);
  const lookup = dexLookup(battle.dex);
  const faults = new Map<ReadFaultKey, unknown>();
  const later: Run = (key, compute, placeholder) => {
    try {
      return compute();
    } catch (error) {
      faults.set(key, error);
      return placeholder;
    }
  };
  const bagUsed = bag.some((item) => item === ITEM_NONE);
  // protectChainKnown, the AI's battler's with its bag; one fault for the pair, as the view's build met it.
  const protectKnown = later<[boolean, boolean]>('protectChainKnown', () => [
    protectChainKnown(lookup, player, false), protectChainKnown(lookup, enemy, bagUsed),
  ], [true, true]);
  const read: AiBattleRead = {
    // The engine runs singles trainer battles only (createBattle throws UNSUPPORTED_DOUBLE). Showdown's gameType
    // 'singles' is BATTLE_TYPE_TRAINER_SINGLES; anything else maps to doubles, which the AI refuses (AiError).
    battleType: battle.gameType === 'singles' ? BATTLE_TYPE_TRAINER_SINGLES : BATTLE_TYPE_TRAINER_DOUBLES,
    totalTurns,
    // The player's battler up to its held item is read at once (before the view's first read of the ROM data, its
    // weight); everything after, and all of the AI's battler, is deferred.
    mons: [
      monOf(battle, lookup, player, PLAYER, totalTurns, protectKnown[PLAYER], atOnce, later),
      monOf(battle, lookup, enemy, ENEMY, totalTurns, protectKnown[ENEMY], later, later),
    ],
    // `side.team` is the party in its original order (the engine's party indices); each set's Pokémon is in `side.pokemon`.
    parties: [partyOf(battle, lookup, battle.p1, PLAYER, later), partyOf(battle, lookup, battle.p2, ENEMY, later)],
    // Showdown's `field`: weather, Trick Room and Gravity, and each battler's Uproar (fieldMaskOf).
    fieldConditionsMask: later('fieldConditionsMask', () => fieldMaskOf(battle, [player, enemy]), 0),
    // Each side's `sideConditions` and its slot's `slotConditions` (sideMaskOf).
    sideConditionsMask: [sideMaskOf(battle.p1), sideMaskOf(battle.p2)],
    // The hazards' `layers` on each side.
    sideConditions: [hazardsOf(battle.p1), hazardsOf(battle.p2)],
    // What the cartridge's latest BattleSystem_CompareBattlerSpeed wrote (battle_lib.c:1372–1373), which the engine
    // records (lastSpeedValues; at a turn choice, the turn start's sort, battle_controller_player.c:251, 263); 0 before
    // the first compare.
    monSpeedValues: [speeds.p1, speeds.p2],
    // Each side's entry of the engine's quickClawRolls(state): its Quick Claw roll of the battler's current speedRand,
    // which the engine picks the first time a compare reads it and drops at the redraw (bcp:853–858, engine
    // sortQueue). At a turn choice that is the draw this turn's order and the AI's compares read. A side with no stored
    // roll (absent: usually so at a turn boundary until the engine draws it) is null. The engine's roll is
    // `speedRand % 5 == 0`, Quick Claw's param 20; the composer gates it by the held item's own param.
    quickClawRolls: [rolls.p1 ?? null, rolls.p2 ?? null],
    // The engine's bag (trainerBag): the trainer's non-empty ROM item slots in order, as battle start compacts them
    // (battle_controller_player.c:4801–4813), with 0 for a used slot (trainer_ai.c:4191).
    bag,
    queuedPlayerMoves: later('queuedPlayerMoves', () => queuedPlayerMovesOf(battle), []),
    // p2's move request, which the view never read (model.ts's `support` did, from the battle): deferred.
    request: later('request', () => requestOf(battle), null),
    // The engine's battleTrainer(state) (model.ts aiMaskFromState), through accessorState. It throws for a state
    // createBattle didn't make, which the view never read: deferred.
    trainer: later('trainer', () => trainerOf(state), { romIndex: 0, aiMask: 0 }),
    fieldNote,
  };
  if (faults.size > 0) registerReadFaults(read, faults);
  return read;
}

// protocolIds and idsOver are the memory's log-ID helpers (rememberStep's ProtocolIds), not part of the read: kept here,
// beside the Showdown dex they read (kaizoDex, which the read cache's dex check uses too), because adapter.ts re-exports
// protocolIds.

/**
 * The installed mod's dex: `Dex.forFormat(KAIZO_FORMAT)`, which is every engine battle's own `dex` (the Battle
 * constructor's `this.dex = Dex.forFormat(format)`, sim/battle.ts, as Battle.fromJSON makes a restored one; engine/dex.ts
 * installKaizoDex puts the mod in `Dex.dexes`, the table forFormat reads). installKaizoDex replaces it, so it is looked
 * up at each call: a table lookup, with no battle restored.
 */
function kaizoDex(): Battle['dex'] {
  return PS.Dex.forFormat(KAIZO_FORMAT);
}

/** protocolIds' maps, one per installed dex, each name looked up once. */
const idsByDex = new WeakMap<object, ProtocolIds>();

/**
 * ProtocolIds over the installed mod's dex (rememberStep), the dex every engine battle's log is written with: the ROM
 * IDs of the names its log lines use, from the mod's entries and the engine's own ID maps (romMove, romAbility,
 * romItem). A name the dex doesn't know throws AiError('BAD_VIEW'), never a guessed ID. Built once per installed dex
 * and memoized per name (no battle is restored for it); a name that throws is looked up again each time, and throws
 * again.
 */
export function protocolIds(): ProtocolIds {
  const dex = kaizoDex();
  let ids = idsByDex.get(dex);
  if (ids === undefined) {
    ids = idsOver(dex);
    idsByDex.set(dex, ids);
  }
  return ids;
}

function idsOver(dex: Battle['dex']): ProtocolIds {
  const known = <T extends { exists: boolean; id: string }>(entry: T, kind: string, name: string): string => {
    if (!entry.exists) throw new AiError('BAD_VIEW', `the battle knows no ${kind} "${name}"`);
    return entry.id;
  };
  const memo = (seen: Map<string, number>, lookup: (name: string) => number) => (name: string): number => {
    let id = seen.get(name);
    if (id === undefined) {
      id = lookup(name);
      seen.set(name, id);
    }
    return id;
  };
  return {
    move: memo(new Map(), (name) => {
      const move = dex.moves.get(name);
      if (!move.exists || !(move.num > 0)) throw new AiError('BAD_VIEW', `the battle knows no move "${name}"`);
      return move.num;
    }),
    ability: memo(new Map(), (name) => romAbility(known(dex.abilities.get(name), 'ability', name))),
    item: memo(new Map(), (name) => romItem(known(dex.items.get(name), 'item', name))),
  };
}

/**
 * The trainer's field note as the engine keeps it (BattleInput.field, an empty object for none), through the engine's
 * `battleField(state)`. The engine applies the weather, Trick Room and Gravity itself, so the read's mask shows them
 * (fieldMaskOf); the note is read for the deep fog, which Showdown has no weather for (compose.ts fogOf), and for the
 * weather the memory starts from (model.ts battleStartMemory). createBattle always records it, so a state without the
 * record (one createBattle didn't make) can't say whether the cartridge has a field weather, Trick Room, Gravity or fog:
 * AiError('BAD_VIEW'), never read as no note.
 */
export function fieldNoteOf(state: EngineState): FieldSpec {
  try {
    return battleField(accessorState(state));
  } catch (error) {
    throw new AiError('BAD_VIEW', `the state has no field-note record: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The most states whose cut JSON accessorState keeps: the ones read last (an LRU by state object). Every state the AI
 * cuts it also peeks, so this is the engine's peek limit (facts.ts PEEK_LIMIT) and the two keep mostly the same states.
 * Kept as long as their states (a WeakMap), the cuts grew with the solver's edge cache, which keeps tens of thousands
 * of states alive.
 * Coupled by hand to PEEK_LIMIT: the engine exports it from facts.ts only, not from its public index (engine/index.ts),
 * which the AI reads the engine through; change the two together.
 */
export const CUT_CAPACITY = 64;

/** Each recently read state's JSON cut to its `formatData` (accessorState), least recently read first. */
const cuts = new Map<EngineState, EngineState>();

/**
 * `state` with its JSON cut to the `formatData` the engine's JSON accessors read (accessors.ts battleTrainer,
 * battleField, battleStartLog and quickClawRolls; speedValues.ts lastSpeedValues). Each of them parses the state's whole
 * JSON to read that one object, so a read's four accessors were four parses. Cut once per state object while it is
 * among the CUT_CAPACITY read last, they cost one parse. The cut JSON is `JSON.stringify({ formatData })` of the parsed
 * value, which parses back to the same value (it came from JSON), so each accessor answers exactly as it does on
 * `state`, and throws as it does: a malformed JSON throws its SyntaxError at the first read (and is not kept), and a
 * missing `formatData` stays missing. Exported for its tests.
 * TODO(engine): an accessor returning every `formatData` record at once would remove the parse.
 */
export function accessorState(state: EngineState): EngineState {
  let cut = cuts.get(state);
  if (cut === undefined) {
    const { formatData } = JSON.parse(state.json) as { formatData?: unknown };
    cut = { ...state, json: JSON.stringify({ formatData }) };
  } else {
    cuts.delete(state);
  }
  cuts.set(state, cut); // the most recent last
  if (cuts.size > CUT_CAPACITY) cuts.delete(cuts.keys().next().value!);
  return cut;
}

/** The engine's battleTrainer(state) (model.ts aiMaskFromState), through accessorState. */
export function trainerOf(state: EngineState): { romIndex: number; aiMask: number } {
  return battleTrainer(accessorState(state));
}

/** The engine's battleStartLog(state) (model.ts battleStartMemory), through accessorState. */
export function startLogOf(state: EngineState): string[] {
  return battleStartLog(accessorState(state));
}

/** `side.active[0]`. AiError('BAD_VIEW') when the side has none. */
function activeOf(side: ShowdownSide): Pokemon {
  const pokemon = side.active[0];
  if (pokemon === undefined || pokemon === null) throw new AiError('BAD_VIEW', `${side.id} has no active Pokémon`);
  return pokemon;
}

/** The engine's party index of `pokemon`: its set's index in `side.team` (engine/battle.ts). */
function partyIndexOf(pokemon: Pokemon): number {
  const index = pokemon.side.team.indexOf(pokemon.set);
  if (index < 0) throw new AiError('BAD_VIEW', `${pokemon.name} has no set in its side's team`);
  return index;
}

/** The battler slot of a Showdown side or slot ("p1", "p2a"): 0 for the player, 1 for the AI. */
function battlerOfSide(id: string): number {
  if (id.startsWith('p1')) return PLAYER;
  if (id.startsWith('p2')) return ENEMY;
  throw new AiError('BAD_VIEW', `"${id}" is no side of a singles battle`);
}

/** A whole number from an effect state's field, or NaN. */
function wholeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
}

/**
 * A hidden counter the AI only tests for zero: Showdown's turns left, clamped into a field of at most `max`, and at
 * least 1 while the effect lasts (a missing duration counts as 1).
 */
function activeCounter(value: unknown, max: number): number {
  const turns = wholeNumber(value);
  return Number.isNaN(turns) ? 1 : Math.min(max, Math.max(1, turns));
}

/** The form of `pokemon`'s set: the party data's form, as the engine encoded it (sets.ts). */
function setFormOf(battle: Battle, pokemon: Pokemon): number {
  const species = battle.dex.species.get(pokemon.set.species);
  return formOf(species.num, species.id, 0);
}

/** The six IVs of `pokemon`'s set, in the Stats order. */
function ivsOf(pokemon: Pokemon): AiReadIvs {
  const { hp, atk, def, spa, spd, spe } = pokemon.set.ivs;
  return { hp, atk, def, spa, spd, spe };
}

/** Four move IDs, PP and maximum PP from Showdown move slots; an empty slot is move 0 with 0 PP. */
function movesOf(lookup: IdLookup, slots: readonly Pokemon['moveSlots'][number][]): { moves: number[]; pp: number[]; ppMax: number[] } {
  const moves: number[] = [];
  const pp: number[] = [];
  const ppMax: number[] = [];
  for (let i = 0; i < LEARNED_MOVES_MAX; i++) {
    const slot = slots[i];
    moves.push(slot === undefined ? MOVE_NONE : romMove(lookup, slot.id));
    pp.push(slot?.pp ?? 0);
    ppMax.push(slot?.maxpp ?? 0);
  }
  return { moves, pp, ppMax };
}

/** No moves: a deferred field's placeholder. */
function noMoves(): { moves: number[]; pp: number[]; ppMax: number[] } {
  return { moves: [0, 0, 0, 0], pp: [0, 0, 0, 0], ppMax: [0, 0, 0, 0] };
}

/**
 * BattleMon.status (MON_CONDITION_*) from Showdown's `status`. Sleep's counter is `statusState.time`, the attempts
 * left: Showdown's Gen 4 sleep lowers it before each attempt and wakes at 0 as the cartridge does with its counter
 * (engine/sets.ts), so it is the same number (non-zero while asleep). Toxic's counter is `statusState.stage`, which
 * rises at each turn end before the damage as the cartridge's does: exact, 0–15. 'fnt' has no cartridge bit: every
 * read of a party member's status skips a fainted one (trainer_ai.c:1371, 1404), and the party copy of a fainted
 * battler is sent with status 0 (battle_controller.c:1482–1486). `status` defaults to the Pokémon's own.
 */
function statusOf(pokemon: Pokemon, status: string = pokemon.status): number {
  switch (status) {
    case '':
    case 'fnt':
      return MON_CONDITION_NONE;
    case 'slp':
      return activeCounter(pokemon.statusState['time'], SLEEP_MAX);
    case 'psn':
      return MON_CONDITION_POISON;
    case 'brn':
      return MON_CONDITION_BURN;
    case 'frz':
      return MON_CONDITION_FREEZE;
    case 'par':
      return MON_CONDITION_PARALYSIS;
    case 'tox': {
      const stage = wholeNumber(pokemon.statusState['stage']);
      const counter = Number.isNaN(stage) ? 0 : Math.min(TOXIC_COUNTER_MAX, Math.max(0, stage));
      return MON_CONDITION_TOXIC | (counter << TOXIC_COUNTER_SHIFT);
    }
    default:
      throw new AiError('BAD_VIEW', `Showdown status "${status}" has no cartridge encoding`);
  }
}

/**
 * BattleMon.status of a battler slot. A fainted battler's BattleMon keeps the status it fainted with: nothing in the
 * faint clears it (BattleSystem_CleanupFaintedMon, battle_lib.c:2156–2210, leaves `status`; only the party copy is sent
 * as 0, battle_controller.c:1482–1486), and BattleAI_PostKOSwitchIn's damage estimate reads it (Guts and the burn halving,
 * battle_lib.c:6651, 6793, 6978). Showdown marks a fainted active Pokémon's status 'fnt' (Battle.checkFainted) without
 * touching `statusState`, whose `id` setStatus always sets (initEffectState({ id })), so the status it fainted with is
 * `statusState.id`: none when absent or ''.
 */
function battleStatusOf(pokemon: Pokemon): number {
  if (pokemon.status !== 'fnt') return statusOf(pokemon);
  const id = pokemon.statusState['id'];
  return statusOf(pokemon, typeof id === 'string' ? id : '');
}

/**
 * BattleMon.statusVolatile (VOLATILE_CONDITION_*) from `pokemon`'s volatiles. Counters are non-zero while active
 * (confusion's `time`; Uproar's, Bide's and Bind's `duration`; Thrash's `trueDuration`).
 */
function statusVolatileOf(pokemon: Pokemon): number {
  const v = pokemon.volatiles;
  let mask = 0;
  if (v['confusion']) mask |= activeCounter(v['confusion']['time'], THREE_BITS) << CONFUSION_SHIFT;
  if (v['flinch']) mask |= VOLATILE_CONDITION_FLINCH;
  if (v['uproar']) mask |= activeCounter(v['uproar'].duration, THREE_BITS) << UPROAR_SHIFT;
  if (v['bide']) mask |= activeCounter(v['bide'].duration, TWO_BITS) << BIDE_SHIFT;
  if (v['lockedmove']) mask |= activeCounter(v['lockedmove']['trueDuration'], TWO_BITS) << THRASH_SHIFT; // Thrash, Outrage, Petal Dance
  // Battler_LockMoveChoice (battle_lib.c:1828): a charge turn (subscript_vanish_on_charge_turn.s), Bide
  // (subscript_bide_start.s) and Rollout or Ice Ball (battle_script.c:5668). Showdown: 'twoturnmove', 'bide', 'rollout',
  // 'iceball'.
  if (v['twoturnmove'] || v['bide'] || v['rollout'] || v['iceball']) mask |= VOLATILE_CONDITION_MOVE_LOCKED;
  if (v['partiallytrapped']) mask |= activeCounter(v['partiallytrapped'].duration, THREE_BITS) << BIND_SHIFT;
  // Attract's bit is the battler it is attracted to: the volatile's `source`.
  const attractedTo = v['attract']?.['source'] as Pokemon | undefined;
  if (attractedTo) mask |= 1 << (ATTRACT_SHIFT + battlerOfSide(attractedTo.side.id));
  if (v['focusenergy']) mask |= VOLATILE_CONDITION_FOCUS_ENERGY;
  if (pokemon.transformed) mask |= VOLATILE_CONDITION_TRANSFORM;
  if (v['mustrecharge']) mask |= VOLATILE_CONDITION_RECHARGING;
  if (v['rage']) mask |= VOLATILE_CONDITION_RAGE;
  if (v['substitute']) mask |= VOLATILE_CONDITION_SUBSTITUTE;
  if (v['destinybond']) mask |= VOLATILE_CONDITION_DESTINY_BOND;
  if (v['trapped']) mask |= VOLATILE_CONDITION_MEAN_LOOK; // Mean Look, Block, Spider Web
  if (v['nightmare']) mask |= VOLATILE_CONDITION_NIGHTMARE;
  if (v['curse']) mask |= VOLATILE_CONDITION_CURSE;
  if (v['foresight']) mask |= VOLATILE_CONDITION_FORESIGHT; // Foresight and Odor Sleuth
  if (v['defensecurl']) mask |= VOLATILE_CONDITION_DEFENSE_CURL;
  if (v['torment']) mask |= VOLATILE_CONDITION_TORMENT;
  return mask;
}

/**
 * BattleMon.moveEffectsMask (MOVE_EFFECT_*) from `pokemon`'s volatiles, but MOVE_EFFECT_IMPRISONED, which the memory
 * gives (the composer adds it). MOVE_EFFECT_NO_CRITICAL and MOVE_EFFECT_CAMOUFLAGE stay clear: nothing in the cartridge
 * sets them (moves.h:23, "checked for, but never set"; Camouflage's bit has no writer in src/).
 */
function moveEffectsMaskOf(pokemon: Pokemon): number {
  const v = pokemon.volatiles;
  let mask = 0;
  // Leech Seed: the seeded Pokémon, with the battler that takes the HP in bits 0–1 (the volatile's `sourceSlot`).
  if (v['leechseed']) mask |= MOVE_EFFECT_LEECH_SEED | battlerOfSide(String(v['leechseed']['sourceSlot'] ?? ''));
  // Lock-On and Mind Reader: Showdown's 'lockon' on the user, as the cartridge's flag and counter are.
  if (v['lockon']) mask |= activeCounter(v['lockon'].duration, TWO_BITS) << LOCK_ON_SHIFT;
  if (v['perishsong']) mask |= MOVE_EFFECT_PERISH_SONG;
  if (v['fly'] || v['bounce']) mask |= MOVE_EFFECT_AIRBORNE; // the charge turn's volatile ('twoturnmove' adds it)
  if (v['dig']) mask |= MOVE_EFFECT_UNDERGROUND;
  if (v['dive']) mask |= MOVE_EFFECT_UNDERWATER;
  if (v['shadowforce']) mask |= MOVE_EFFECT_SHADOW_FORCE;
  if (v['minimize']) mask |= MOVE_EFFECT_MINIMIZE;
  if (v['charge']) mask |= MOVE_EFFECT_CHARGE;
  if (v['ingrain']) mask |= MOVE_EFFECT_INGRAIN;
  if (v['yawn']) mask |= activeCounter(v['yawn'].duration, TWO_BITS) << YAWN_SHIFT;
  if (v['imprison']) mask |= MOVE_EFFECT_IMPRISON;
  if (v['grudge']) mask |= MOVE_EFFECT_GRUDGE;
  if (v['mudsport']) mask |= MOVE_EFFECT_MUD_SPORT; // Gen 4's Mud and Water Sport are volatiles on the user
  if (v['watersport']) mask |= MOVE_EFFECT_WATER_SPORT;
  if (v['gastroacid']) mask |= MOVE_EFFECT_ABILITY_SUPPRESSED;
  if (v['miracleeye']) mask |= MOVE_EFFECT_MIRACLE_EYE;
  if (v['powertrick']) mask |= MOVE_EFFECT_POWER_TRICK;
  if (v['aquaring']) mask |= MOVE_EFFECT_AQUA_RING;
  if (v['healblock']) mask |= MOVE_EFFECT_HEAL_BLOCK;
  if (v['embargo']) mask |= MOVE_EFFECT_EMBARGO;
  if (v['magnetrise']) mask |= MOVE_EFFECT_MAGNET_RISE;
  // MOVE_EFFECT_IMPRISONED is the memory's: the composer adds it (compose.ts withImprisoned).
  return mask;
}

/**
 * The turn `pokemon` came in, as fakeOutTurnNumber and slowStartTurnNumber hold it: totalTurns + 1 at the switch-in
 * (battle_lib.c:2117–2118), so Showdown's turn then. Showdown counts `activeTurns` from 0 at the switch-in
 * (battle-actions.ts switchIn) up by one at each turn end it is in play for (Battle.endTurn), so that turn is
 * `turn − activeTurns`. A lead was never switched in on the cartridge and keeps the cleared 0: Showdown's leads come in
 * at turn 0 and end it, which gives the same 0. A fainted battler gets totalTurns + 1 (battle_lib.c:2195–2196).
 */
function switchInTurnOf(battle: Battle, pokemon: Pokemon, totalTurns: number): number {
  if (pokemon.hp === 0) return totalTurns + 1;
  return battle.turn - pokemon.activeTurns;
}

/**
 * Protect's chain (protectSuccessTurns, 0–3) from Showdown's Gen 4 'stall' volatile: its `counter` is 2 after one
 * success and doubles with each more, up to 8 (data/mods/gen4/conditions.ts `stall`, counterMax 8), as the
 * cartridge's success rate halves with each step of its chain (sProtectSuccessRate, battle_script.c:5167–5186). So the
 * chain is log2(counter). The volatile goes on a failure, as the chain resets (battle_script.c:5186), and a turn later
 * if the next move isn't a protecting one, when moveProtect stops naming one and LoadProtectChain reads 0
 * (trainer_ai.c:2545). Exact for that read, the only one.
 */
function protectChainOf(pokemon: Pokemon): number {
  const stall = pokemon.volatiles['stall'];
  if (!stall) return 0;
  const counter = wholeNumber(stall['counter']);
  if (Number.isNaN(counter) || counter < 2) return 0;
  return Math.min(3, Math.floor(Math.log2(counter)));
}

const PROTECT_MOVES: ReadonlySet<number> = new Set([MOVE_PROTECT, MOVE_DETECT, MOVE_ENDURE]);

/** Showdown's `lastMove` of `pokemon` as a ROM ID: its last move since the switch-in, MOVE_NONE for none. */
function lastMoveOf(lookup: IdLookup, pokemon: Pokemon): number {
  return pokemon.lastMove === null ? MOVE_NONE : romMove(lookup, pokemon.lastMove.id);
}

/**
 * moveProtect: the move the battler last showed the "used" message for (battle_controller_player.c:3938). The AI reads
 * it only to ask whether it is Protect, Detect or Endure (trainer_ai.c:2545), and only then reads the chain; so it is
 * Showdown's `lastMove` while that is one of the three and its 'stall' chain is alive, else MOVE_NONE. A failed
 * protecting move leaves the cartridge's chain at 0 (battle_script.c:5186), which reads the same as MOVE_NONE.
 * Exact where protectChainKnown holds.
 */
function moveProtectOf(lookup: IdLookup, pokemon: Pokemon): number {
  if (!pokemon.volatiles['stall']) return MOVE_NONE;
  const move = lastMoveOf(lookup, pokemon);
  return PROTECT_MOVES.has(move) ? move : MOVE_NONE;
}

/**
 * Whether moveProtectOf and protectChainOf give the cartridge's moveProtect and protectSuccessTurns, as
 * LoadProtectChain reads them. The cartridge writes moveProtect each time the battler runs a move: the move whose
 * "used" message showed (moveCur), else MOVE_NONE, as after a turn it couldn't move (UpdateMoveBuffers,
 * battle_controller_player.c:3936–3942). TryProtect keeps the chain only while moveProtect names Protect, Detect or
 * Endure (battle_script.c:5154–5158). A switch-in clears both (battle_lib.c:2104–2120), as Showdown's switch clears
 * 'stall' and `lastMove`, so a switch turn leaves no gap. Two things do:
 * - A bag item (`aiUsedItem`: the AI's bag has a used slot; the player uses none in the engine): the item turn runs no
 *   move, so the cartridge keeps moveProtect and the chain through it, and a protecting move after it continues the
 *   chain, while Showdown's 'stall' ends at the item turn's end. The state doesn't say when the item was used, so
 *   while the battler's last move protects, or is Sleep Talk, which may have called a protecting move, the chain is
 *   ambiguous.
 * - A protecting move called by Sleep Talk, the one caller that can call one (BtlCmd_TrySleepTalk, battle_script.c:
 *   4907–4934, has no Protect check; Metronome, Assist and Copycat refuse all three, sCannotMetronomeMoves at
 *   battle_lib.c:7152–7179; Mirror Move and Me First copy only other moves): moveProtect is the called move, but
 *   Showdown's `lastMove` is the caller, so a live 'stall' with a last move that doesn't protect is ambiguous.
 */
function protectChainKnown(lookup: IdLookup, pokemon: Pokemon, aiUsedItem: boolean): boolean {
  const stall = pokemon.volatiles['stall'] !== undefined;
  if (!stall && !aiUsedItem) return true; // no chain alive, and no item turn could have kept one: both read 0
  const last = lastMoveOf(lookup, pokemon);
  const protecting = PROTECT_MOVES.has(last);
  if (stall && !protecting) return false;
  return !(aiUsedItem && (protecting || last === MOVE_SLEEP_TALK));
}

/** BattleMon.moveEffectsData's fields the AI reads, from `pokemon`'s volatiles and move slots. */
function effectsOf(battle: Battle, lookup: IdLookup, pokemon: Pokemon, totalTurns: number): AiReadEffects {
  const v = pokemon.volatiles;
  const switchInTurn = switchInTurnOf(battle, pokemon, totalTurns);
  const perishSong = wholeNumber(v['perishsong']?.duration);
  const stockpile = wholeNumber(v['stockpile']?.['layers']);
  return {
    // 'disable': the move in its `move`, as a ROM ID; its duration as the 3-bit counter (non-zero only).
    disabledMove: v['disable'] ? romMove(lookup, String(v['disable']['move'] ?? '')) : MOVE_NONE,
    disabledTurns: v['disable'] ? activeCounter(v['disable'].duration, THREE_BITS) : 0,
    // 'encore': the same.
    encoredMove: v['encore'] ? romMove(lookup, String(v['encore']['move'] ?? '')) : MOVE_NONE,
    encoredTurns: v['encore'] ? activeCounter(v['encore'].duration, THREE_BITS) : 0,
    // 'taunt' and 'embargo': their durations (non-zero only).
    tauntedTurns: v['taunt'] ? activeCounter(v['taunt'].duration, THREE_BITS) : 0,
    embargoTurns: v['embargo'] ? activeCounter(v['embargo'].duration, THREE_BITS) : 0,
    // Exact (trainer_ai.c:3266). The cartridge sets 3 (battle_script.c:5478) and, at each turn end, faints the battler
    // at 0 or else lowers it (battle_controller_player.c:1801–1809). Showdown's 'perishsong' starts at duration 4 and
    // loses 1 at each turn end, ending at 0: one more than the cartridge's count at every decision. So duration − 1.
    perishSongTurns: v['perishsong'] && !Number.isNaN(perishSong) ? Math.min(TWO_BITS, Math.max(0, perishSong - 1)) : 0,
    // Exact (trainer_ai.c:2501): 'stockpile''s `layers`, 1–3.
    stockpileCount: v['stockpile'] && !Number.isNaN(stockpile) ? Math.min(TWO_BITS, Math.max(0, stockpile)) : 0,
    // Exact for LoadProtectChain where protectChainKnown holds: 'stall''s `counter` (protectChainOf). GAP: listed
    // unknown otherwise. Spot check 16.
    protectSuccessTurns: protectChainOf(pokemon),
    // Exact (trainer_ai.c:2103, 2487, 4156): the turn the battler came in (switchInTurnOf).
    fakeOutTurnNumber: switchInTurn,
    // Exact (battle_lib.c:1264): the same turn. GAP: Transform also sets it to totalTurns + 1 (battle_script.c:5360),
    // which Showdown doesn't record, so it is listed unknown while the battler is transformed; only Slow Start reads
    // it. Spot check 17.
    slowStartTurnNumber: switchInTurn,
    // Exact (trainer_ai.c:2039): the distinct moves used since the switch-in, Last Resort itself left out
    // (BattleSystem_UpdateLastResort, battle_lib.c:3444–3458): the move slots Showdown marks `used`, up to 4.
    lastResortCount: Math.min(4, pokemon.moveSlots.filter((slot) => slot.used && slot.id !== 'lastresort').length),
    // 'flashfire', which Flash Fire's absorb adds.
    flashFire: v['flashfire'] !== undefined,
    // The speed check reads it only for an Unburden holder with no item (battle_lib.c:1268–1272), where it means the
    // Pokémon held an item when its ability was checked (battle_lib.c:4433–4436) and has lost it: Showdown's 'unburden',
    // which Gen 4 Unburden adds when the item goes.
    canUnburden: v['unburden'] !== undefined,
    // 'healblock' and 'magnetrise': their durations (non-zero only).
    healBlockTurns: v['healblock'] ? activeCounter(v['healblock'].duration, THREE_BITS) : 0,
    magnetRiseTurns: v['magnetrise'] ? activeCounter(v['magnetrise'].duration, THREE_BITS) : 0,
    // 'choicelock''s `move`, as a ROM ID: Showdown keeps it while the Choice item is held, as the cartridge keeps
    // choiceLockedMove (battle_controller_player.c:3929, 3932).
    choiceLockedMove: v['choicelock'] ? romMove(lookup, String(v['choicelock']['move'] ?? '')) : MOVE_NONE,
  };
}

/** No effects: a deferred field's placeholder. */
function noEffects(): AiReadEffects {
  return {
    disabledMove: 0, disabledTurns: 0, encoredMove: 0, encoredTurns: 0, tauntedTurns: 0, embargoTurns: 0, perishSongTurns: 0,
    stockpileCount: 0, protectSuccessTurns: 0, fakeOutTurnNumber: 0, slowStartTurnNumber: 0, lastResortCount: 0,
    flashFire: false, canUnburden: false, healBlockTurns: 0, magnetRiseTurns: 0, choiceLockedMove: 0,
  };
}

/**
 * One battler from an active Showdown Pokémon, without the memory's MOVE_EFFECT_IMPRISONED (the composer adds it).
 * `head` runs the fields the view's build read before the battler's weight (its moves, types, ability and held item),
 * `later` the ones after (see the header); `protectKnown` is the battler's protectChainKnown.
 */
function monOf(
  battle: Battle, lookup: IdLookup, pokemon: Pokemon, battler: 0 | 1, totalTurns: number, protectKnown: boolean, head: Run,
  later: Run,
): AiReadMon {
  const { moves, pp, ppMax } = head(`mons.${battler}.moves`, () => movesOf(lookup, pokemon.moveSlots), noMoves());
  const boosts = pokemon.boosts;
  const types = head<[number, number]>(`mons.${battler}.types`, () => romTypes(pokemon.types), [0, 0]);
  const ability = head(`mons.${battler}.ability`, () => romAbility(pokemon.ability), ABILITY_NONE);
  const heldItem = head(`mons.${battler}.heldItem`, () => romItem(pokemon.item), ITEM_NONE);
  // The species BattleMon.weight is the Pokédex weight of (BattleSystem_InitBattleMon, battle_lib.c:145–150).
  // Untransformed, the species and form are the set's: the party data the BattleMon was built from, which a battle form
  // change (Castform's weather forms) doesn't reload. Transform copies the target's weight (battle_script.c:5346–5348,
  // BattleMon up to `ability`), and a transformed Pokémon's Showdown species is its target's.
  const weighed = pokemon.transformed ? pokemon.species : battle.dex.species.get(pokemon.set.species);
  return {
    // The engine's party index: the set's index in `side.team` (partyIndexOf). The composer reads it only while the side
    // has a Pokémon left.
    partyIndex: later(`mons.${battler}.partyIndex`, () => partyIndexOf(pokemon), 0),
    // `species.num`, the National Dex number, which is the ROM's species ID; a transformed Pokémon's is its target's,
    // as Transform copies the BattleMon up to its ability (battle_script.c:5346–5348).
    species: pokemon.species.num,
    // The form of `species.id` (Castform's weather forms included), else the set's.
    form: formOf(pokemon.species.num, pokemon.species.id, setFormOf(battle, pokemon)),
    level: pokemon.level,
    // 'M', 'F' or 'N' as GENDER_*.
    gender: genderOf(pokemon.gender),
    // `types`, the stored types (Transform, Conversion and Forecast change them, as on the cartridge), as ROM type IDs.
    // Roost's loss of Flying is a Type event, not stored, as the cartridge keeps it in turnFlags.roosting.
    types,
    // `ability`, the current one (Trace, Skill Swap, Transform), as a ROM ID. Gastro Acid keeps it, as the cartridge
    // does, and sets MOVE_EFFECT_ABILITY_SUPPRESSED. Showdown's faint resets it, which the cartridge's doesn't: at a
    // fainted AI battler's replacement, a traced one is the memory's (the composer's), and any other change is listed.
    ability,
    // `item`, as a ROM ID ('' once used or lost).
    heldItem,
    // `happiness`, which the engine sets from BattleMon.friendship (engine/sets.ts showdownSet): the save's for the
    // player's Pokémon, the species' base friendship for the trainer's. Exact: Transform copies
    // the BattleMon only up to `ability` (battle_script.c:5346–5348), which friendship follows, and Showdown's
    // transformInto leaves happiness too.
    friendship: pokemon.happiness,
    // The set's IVs. GAP: Transform copies the target's IVs (battle_script.c:5346–5348), which Showdown doesn't (it
    // copies the Hidden Power type only), so they are listed unknown while the battler is transformed; the AI reads
    // them only for Hidden Power. Spot check 19.
    ivs: ivsOf(pokemon),
    curHP: pokemon.hp,
    maxHP: pokemon.maxhp,
    // `storedStats` (Transform and Power Trick change them, as on the cartridge).
    attack: pokemon.storedStats.atk,
    defense: pokemon.storedStats.def,
    spAttack: pokemon.storedStats.spa,
    spDefense: pokemon.storedStats.spd,
    speed: pokemon.storedStats.spe,
    // `boosts` + 6, in BATTLE_STAT order (HP, Attack, Defense, Speed, Sp. Atk, Sp. Def, accuracy, evasion); HP has no
    // boost.
    statBoosts: [
      DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE + boosts.atk, DEFAULT_STAT_STAGE + boosts.def, DEFAULT_STAT_STAGE + boosts.spe,
      DEFAULT_STAT_STAGE + boosts.spa, DEFAULT_STAT_STAGE + boosts.spd, DEFAULT_STAT_STAGE + boosts.accuracy,
      DEFAULT_STAT_STAGE + boosts.evasion,
    ],
    // `moveSlots`, the moves in use (Transform's and Mimic's copies), in slot order, with their `pp` and `maxpp`. A slot
    // with 0 PP or a Disabled move stays in place, as the cartridge's AI can pick it. Showdown's request lists the same
    // slots in the same order, except when it offers one move alone (Struggle, or a locked move); mapping a pick to the
    // request's index is `support`'s.
    moves,
    ppCur: pp,
    ppMax,
    // The status, a fainted battler's included (battleStatusOf).
    status: later(`mons.${battler}.status`, () => battleStatusOf(pokemon), MON_CONDITION_NONE),
    statusVolatile: later(`mons.${battler}.statusVolatile`, () => statusVolatileOf(pokemon), 0),
    moveEffectsMask: later(`mons.${battler}.moveEffectsMask`, () => moveEffectsMaskOf(pokemon), 0),
    effects: later(`mons.${battler}.effects`, () => effectsOf(battle, lookup, pokemon, totalTurns), noEffects()),
    // BattleContext.turnFlags: 'roost', which lasts until the turn's end, as turnFlags do (BattleSystem_SetupNextTurn,
    // battle_lib.c:2228).
    roosting: pokemon.volatiles['roost'] !== undefined,
    // 'helpinghand': never in singles, where Helping Hand fails.
    helpingHand: pokemon.volatiles['helpinghand'] !== undefined,
    transformed: pokemon.transformed,
    weightSpecies: weighed.num,
    weightForm: formOf(weighed.num, weighed.id, 0),
    // The battler's last move when it is a Protect, Detect or Endure whose chain is alive (moveProtectOf).
    // GAP: the composer lists it unknown where the state can't settle the chain (protectChainKnown). Spot check 16.
    moveProtect: later(`mons.${battler}.moveProtect`, () => moveProtectOf(lookup, pokemon), MOVE_NONE),
    protectChainKnown: protectKnown,
    // `lastItem`, the item Recycle gives back, as a ROM item ID. Showdown's Gen 1–4 lastItem follows the battler slot: a
    // switch-in takes the outgoing Pokémon's and clears it (sim/battle-actions.ts switchIn), as the cartridge keeps
    // recycleItem per slot and never clears it on a switch. It is set where the cartridge's BtlCmd_RemoveItem sets
    // recycleItem (battle_script.c:8978: a consumed held item, Fling, Natural Gift) and cleared by Recycle (:9005–9007).
    // The composer reads it only where the memory has no override of its own (Bug Bite and Pluck).
    lastItem: later(`mons.${battler}.lastItem`, () => romItem(pokemon.lastItem), ITEM_NONE),
  };
}

/** One side's party in party order (`side.team`), as Pokemon_GetValue reads the party data. */
function partyOf(battle: Battle, lookup: IdLookup, side: ShowdownSide, s: 0 | 1, later: Run): AiReadPartyMon[] {
  return side.team.map((set, i) => {
    const pokemon = later<Pokemon | null>(`parties.${s}.${i}.pokemon`, () => {
      const found = side.pokemon.find((candidate) => candidate.set === set);
      if (found === undefined) throw new AiError('BAD_VIEW', `${side.id} has no Pokémon for the set ${set.name}`);
      return found;
    }, null);
    // The set's own species and form: the party data, which Transform and form changes in battle don't touch.
    const species = battle.dex.species.get(set.species);
    const form = formOf(species.num, species.id, 0);
    if (pokemon === null) {
      const none = noMoves();
      return {
        species: species.num, form, level: 0, hp: 0, maxHp: 0, status: MON_CONDITION_NONE, moves: none.moves, pp: none.pp,
        ppMax: none.ppMax, heldItem: ITEM_NONE, ability: ABILITY_NONE, ivs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      };
    }
    const fields = later(`parties.${s}.${i}.fields`, () => ({
      // `baseMoveSlots`: the party's own moves (no Transform or Mimic copies), with their PP.
      ...movesOf(lookup, pokemon.baseMoveSlots),
      status: statusOf(pokemon),
      // `item`: the battle keeps the party's held item in step with the battler's (BattleMon_CopyToParty).
      heldItem: romItem(pokemon.item),
      // `baseAbility`: the party data's ability (a battle change such as Skill Swap ends on the switch-out).
      ability: romAbility(pokemon.baseAbility),
    }), { ...noMoves(), status: MON_CONDITION_NONE, heldItem: ITEM_NONE, ability: ABILITY_NONE });
    return {
      species: species.num,
      form,
      level: pokemon.level,
      hp: pokemon.hp,
      maxHp: pokemon.maxhp,
      status: fields.status,
      moves: fields.moves,
      pp: fields.pp,
      ppMax: fields.ppMax,
      heldItem: fields.heldItem,
      ability: fields.ability,
      ivs: ivsOf(pokemon),
    };
  });
}

/**
 * BattleContext.fieldConditionsMask from Showdown's field, without the deep fog bit (the composer's, from the note and
 * the memory):
 * - `field.weather` with its duration: none (0 or unset) means it lasts until replaced, the cartridge's _PERM bit
 *   (ability weather); a duration is the _TEMP bit (a move's). Checked against the engine (adapter.test.ts): Gen 4
 *   ability weather leaves 0, and a move's weather 5, then 4 after one turn end;
 * - each battler in an Uproar (its 'uproar' volatile) sets its bit from FIELD_CONDITION_UPROAR_SHIFT;
 * - 'gravity' and 'trickroom' in `pseudoWeather`, their durations as the 3-bit counters (non-zero only).
 * The trainer's field note's weather, Trick Room and Gravity are in the engine's field, so they show
 * here: the weather as the _PERM bit (its duration is 0), Trick Room and Gravity as a counter of 1 (the AI only tests them
 * for non-zero).
 */
function fieldMaskOf(battle: Battle, actives: readonly Pokemon[]): number {
  const permanent = !(wholeNumber(battle.field.weatherState.duration) > 0);
  let mask = 0;
  switch (battle.field.weather) {
    case '':
      break;
    case 'raindance':
      mask |= permanent ? FIELD_CONDITION_RAINING_PERM : FIELD_CONDITION_RAINING_TEMP;
      break;
    case 'sunnyday':
      mask |= permanent ? FIELD_CONDITION_SUNNY_PERM : FIELD_CONDITION_SUNNY_TEMP;
      break;
    case 'sandstorm':
      mask |= permanent ? FIELD_CONDITION_SANDSTORM_PERM : FIELD_CONDITION_SANDSTORM_TEMP;
      break;
    case 'hail':
      mask |= permanent ? FIELD_CONDITION_HAILING_PERM : FIELD_CONDITION_HAILING_TEMP;
      break;
    default:
      throw new AiError('BAD_VIEW', `Showdown weather "${battle.field.weather}" has no Gen 4 encoding`);
  }
  actives.forEach((pokemon, battler) => {
    if (pokemon.volatiles['uproar']) mask |= 1 << (UPROAR_FIELD_SHIFT + battler);
  });
  const { gravity, trickroom } = battle.field.pseudoWeather;
  if (gravity) mask |= activeCounter(gravity.duration, THREE_BITS) << GRAVITY_SHIFT;
  if (trickroom) mask |= activeCounter(trickroom.duration, THREE_BITS) << TRICK_ROOM_SHIFT;
  return mask;
}

/**
 * BattleContext.sideConditionsMask[side] from the side's `sideConditions` (screens, Safeguard, Mist, hazards,
 * Tailwind's and Lucky Chant's durations as their counters, non-zero only) and its slot's `slotConditions`: Future
 * Sight's 'futuremove' sits on the target's slot and Wish's 'wish' on the user's, the sides the cartridge marks.
 */
function sideMaskOf(side: ShowdownSide): number {
  const c = side.sideConditions;
  const slot = side.slotConditions[0] ?? {};
  let mask = 0;
  if (c['reflect']) mask |= SIDE_CONDITION_REFLECT;
  if (c['lightscreen']) mask |= SIDE_CONDITION_LIGHT_SCREEN;
  if (c['spikes']) mask |= SIDE_CONDITION_SPIKES;
  if (c['safeguard']) mask |= SIDE_CONDITION_SAFEGUARD;
  if (slot['futuremove']) mask |= SIDE_CONDITION_FUTURE_SIGHT;
  if (slot['wish']) mask |= SIDE_CONDITION_WISH;
  if (c['mist']) mask |= SIDE_CONDITION_MIST;
  if (c['stealthrock']) mask |= SIDE_CONDITION_STEALTH_ROCK;
  if (c['tailwind']) mask |= activeCounter(c['tailwind'].duration, TWO_BITS) << TAILWIND_SHIFT;
  if (c['toxicspikes']) mask |= SIDE_CONDITION_TOXIC_SPIKES;
  if (c['luckychant']) mask |= activeCounter(c['luckychant'].duration, THREE_BITS) << LUCKY_CHANT_SHIFT;
  return mask;
}

/** Exact (LoadSpikesLayers, trainer_ai.c:1948): the 'spikes' and 'toxicspikes' side conditions' `layers`, 0 without. */
function hazardsOf(side: ShowdownSide): { spikesLayers: number; toxicSpikesLayers: number } {
  const layers = (id: string): number => {
    const condition = side.sideConditions[id];
    if (!condition) return 0;
    const count = wholeNumber(condition['layers']);
    return Number.isNaN(count) ? 1 : count;
  };
  return { spikesLayers: layers('spikes'), toxicSpikesLayers: layers('toxicspikes') };
}

/** `move.num` of each move action still queued for the player's side, in queue order (the composer's Pursuit test). */
function queuedPlayerMovesOf(battle: Battle): number[] {
  const moves: number[] = [];
  for (const action of battle.queue.list) {
    if (action.choice === 'move' && action.pokemon.side === battle.p1) moves.push(action.move.num);
  }
  return moves;
}

/**
 * p2's move request (`activeRequest.active[0].moves`: each entry's ID, and whether the engine's legalChoices lets it be
 * chosen, neither disabled nor at 0 PP) and its active Pokémon's move slots' IDs, or null where the battle doesn't wait
 * on p2's turn choice.
 */
function requestOf(battle: Battle): AiReadRequest | null {
  const request = battle.p2.activeRequest as { active?: { moves: { id: string; pp?: number; disabled?: unknown }[] }[] } | null;
  const moves = request?.active?.[0]?.moves;
  if (moves === undefined) return null;
  return {
    entries: moves.map((entry) => ({ id: entry.id, usable: !entry.disabled && entry.pp !== 0 })),
    slotIds: battle.p2.active[0]!.moveSlots.map((slot) => slot.id as string),
  };
}
