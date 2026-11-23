// viewFromRead: the trainer AI's view (view.ts AiView, the cartridge's BattleContext and BattleMon in their own
// encodings) of an engine state, from the engine's read of it (AiBattleRead, contracts/aiRead.ts; one source per engine,
// read/showdown.ts for Showdown), the AI's memory (memory.ts rememberStep) and the ROM data. Everything that needs the
// memory, AiRomData or LoadedData is here, once, so two engines cannot differ there.
// Every field's comment names the read field, or the memory field, or the default it takes and why. `// GAP:` marks a
// value the state can't give exactly: the view lists it in `unknown` (lib/known.ts's PATHS), always or when the read or
// the memory can't settle it, so its reader throws AiError('UNDEFINED') instead of reading a default.
// Each gap has a spot-check item in docs/ai-spot-checks.md.
//
// Battler slots: 0 is the player (p1), 1 the AI (p2); singles leave slots 2 and 3 empty (EMPTY_MON). Pure.
//
// Two steps: the base view, every field no memory field enters, built once per read and (data, ai) (baseViewOf),
// then the memory's fields over it (composeView), each in the view's one-pass build order.
//
// The fault registry (the first fault on a state stays the one the view reported before the split).
// The view used to be built in one pass over the engine's battle, the memory and the ROM data, so its first throw could
// come from any of them. Split, every engine read comes first, but a fault the one-pass build met only after its first
// read of the ROM data (mons[0]'s weight) must still come after that read. A source that meets such a fault records it
// here, beside the read (never inside it: the read stays the contract's plain data), under the read field it belongs to,
// and the composer rethrows it where the view's build reaches that field. A source that never meets one (native) never
// registers anything.

import type { LoadedData } from '../../battle/types.js';
import type { AiBattleRead, AiReadIvs, AiReadMon } from '../../contracts/aiRead.js';
import type { FieldSpec, Phase } from '../../contracts/engine.js';
import { FORMS, personalRowFor } from '../../rom/forms.js';
import type { Stats } from '../../rom/types.js';
import {
  BATTLE_EFFECT_HIT_BEFORE_SWITCH, BATTLE_EFFECT_SWITCH_HIT, S_MASK_EFFECTS, S_POWER_EFFECTS,
} from '../battleScripts.js';
import {
  ABILITY_SLOW_START, BATTLER_ENEMY_2, BATTLER_NONE, BATTLER_PLAYER_2, FIELD_CONDITION_DEEP_FOG, ITEM_NONE,
  LEARNED_MOVES_MAX, MAX_TRAINER_ITEMS, MON_CONDITION_FREEZE, MON_CONDITION_SLEEP, MOVE_EFFECT_IMPRISONED, MOVE_NONE,
} from '../constants.js';
import { AiError } from '../errors.js';
import { PATHS, REPLACEMENT_PATHS } from '../lib/known.js';
import type { AiMemoryData, FogFate } from '../memory.js';
import type { AiRomData } from '../rom/aiData.js';
import {
  AI_BATTLER, type AiBattleMon, type AiMoveEffectsData, type AiPartyMon, type AiSideConditions, type AiTurnFlags,
  type AiView, EMPTY_MON, PLAYER_BATTLER,
} from '../view.js';
import { attempt, type Caught, settled } from './caught.js';

/** A read field of one battler whose fault the view's build meets at a fixed position (rethrown there). */
type MonFaultField =
  | 'moves' | 'types' | 'ability' | 'heldItem' | 'status' | 'statusVolatile' | 'moveEffectsMask' | 'effects'
  | 'partyIndex' | 'moveProtect' | 'lastItem';

/**
 * Where a source's deferred fault belongs, by the read field it was met reading:
 * - `mons.<b>.<field>`: that field of battler b (`moves` stands for moves, ppCur and ppMax);
 * - `parties.<s>.<i>.pokemon`: party member i of side s has no Pokémon for its set; `parties.<s>.<i>.fields`: that
 *   member's moves, PP, status, held item or ability;
 * - `fieldConditionsMask`, `queuedPlayerMoves`: those fields;
 * - `protectChainKnown`: either battler's `protectChainKnown` (one fault for the pair, the player's first);
 * - `trainer`: the trainer's identity, which the view never reads (model.ts reads it; readTrainer);
 * - `request`: p2's move request, which the view never reads (model.ts's `support` reads it, and rethrows this
 *   where it read the request before the split).
 */
export type ReadFaultKey =
  | `mons.${0 | 1}.${MonFaultField}`
  | `parties.${0 | 1}.${number}.${'pokemon' | 'fields'}`
  | 'fieldConditionsMask' | 'queuedPlayerMoves' | 'protectChainKnown' | 'trainer' | 'request';

/** Each read's deferred faults, by the field each belongs to (registerReadFaults). */
const readFaults = new WeakMap<AiBattleRead, ReadonlyMap<ReadFaultKey, unknown>>();

/**
 * Records `faults` beside `read`: what reading each field threw, which a consumer of the field throws again where it
 * reads it (rethrowReadFault). The field itself holds a placeholder no consumer may read. For a source only, as it builds
 * the read; a read has one set of faults.
 */
export function registerReadFaults(read: AiBattleRead, faults: ReadonlyMap<ReadFaultKey, unknown>): void {
  readFaults.set(read, new Map(faults));
}

/** Throws again what reading `key` of `read` threw, if its source registered a fault there; else returns. */
export function rethrowReadFault(read: AiBattleRead, key: ReadFaultKey): void {
  const faults = readFaults.get(read);
  if (faults?.has(key)) throw faults.get(key);
}

/**
 * The trainer's identity in `read` (its ROM index and raw AI mask), after the fault its source registered for it, if
 * any: a state createBattle didn't make has none, and the read then holds a placeholder (`{ romIndex: 0, aiMask: 0 }`)
 * that would read as trainer 0 with no AI flags. Every consumer of the trainer reads it through this, never
 * `read.trainer` (model.ts's aiMaskFromState).
 */
export function readTrainer(read: AiBattleRead): AiBattleRead['trainer'] {
  rethrowReadFault(read, 'trainer');
  return read.trainer;
}

/** BattleContext_Init's powerMul (battle_lib.c:1980). */
const DEFAULT_POWER_MUL = 10;
/** The powerMul TryPursuit sets for a Pursuit at a switching battler (battle_script.c:6928). */
const PURSUIT_POWER_MUL = 20;
/** aiSwitchedPartySlot's "none" (BattleContext_Init, battle_lib.c:2015). */
const NO_SWITCH = 6;
/** The party slot a battler with no Pokémon left gets (battle_controller_player.c:4111, 4135). */
const NO_PARTY_SLOT = 6;

/**
 * The engine state read as `read` as the trainer AI sees it at its decision, at phase `phase`. `data` is the LoadedData
 * the engine's mod was installed from, `ai` the AI's ROM data, and `memory` what the AI remembers (rememberStep), which
 * gives the fields the engine doesn't keep. Throws AiError('BAD_VIEW') for a ROM table without the read's species (a
 * weight, a Personal row), and what the read's source registered for a field where the build reaches it.
 *
 * Two steps: the base view, every field no memory field enters, built once per read (baseViewOf), then the
 * memory's fields over it (composeView). A read with a fault refuses as the one-pass build did, with the same error,
 * even with two faults: the base keeps each throw that comes after a read of the memory in the one-pass order, and
 * composeView meets it there (BaseView).
 */
export function viewFromRead(
  read: AiBattleRead, phase: Phase['kind'], data: LoadedData, ai: AiRomData, memory: AiMemoryData,
): AiView {
  return composeView(settled(baseViewOf(read, data, ai)), phase, data, memory);
}

/** The read's faults, looked up once per base: `check(key)` throws the one registered for `key`. */
type FaultCheck = (key: ReadFaultKey) => void;

/** `value`, or the fault registered for `key` as a Caught, for composeView to meet where the one-pass build read it. */
function caughtField<T>(faults: ReadonlyMap<ReadFaultKey, unknown> | undefined, key: ReadFaultKey, value: () => T): Caught<T> {
  return faults?.has(key) ? { ok: false, error: faults.get(key) } : { ok: true, value: value() };
}

/**
 * The part of a read's view that no memory field enters, from the read and the ROM data alone. The one-pass build
 * read the state and the memory interleaved; up to `recycleItem` no read of the memory could throw, so a throw there
 * fails the whole base. After it, each read that can throw is kept as a Caught, in that order, for composeView to meet
 * after the memory's reads that came first: recycleItem's lastItem (read only where the memory has no override),
 * Pursuit's queue (read only after some switching actions) and the Protect chains (unknownOf).
 */
interface BaseView {
  battleType: number;
  /**
   * battleMonOf's, without MOVE_EFFECT_IMPRISONED and a fainted AI battler's traced ability, which composeView adds from
   * the memory.
   */
  mons: [AiBattleMon, AiBattleMon];
  parties: AiView['parties'];
  selectedPartySlot: number[];
  totalTurns: number;
  /** The read's mask, without the deep fog bit, which composeView adds from the note and the memory. */
  fieldMask: number;
  turnFlags: AiTurnFlags[];
  sideConditionsMask: [number, number];
  sideConditions: [AiSideConditions, AiSideConditions];
  moveProtect: number[];
  /** Each active Pokémon's `lastItem` (a ROM item ID), which recycleItem takes where the memory has no override. */
  lastItems: [Caught<number>, Caught<number>];
  /** The view's fields after recycleItem. */
  rest: Pick<AiView, 'battlersSwitchingMask' | 'monSpeedValues' | 'quickClawThisTurn' | 'trainerItems' | 'trainerItemCount'>;
  /** The trainer's field note (the read's fieldNote), for the deep fog's fate (fogOf). */
  note: FieldSpec;
  /** The AI's battler has 0 HP (replacementState). */
  enemyFainted: boolean;
  /** pursuitMayRun (replacementState). */
  pursuitMayRun: Caught<boolean>;
  /** protectChainKnown for battlers 0 and 1 (unknownOf). */
  protectKnown: Caught<[boolean, boolean]>;
  transformed: [boolean, boolean];
  /** weightOf's `known` for battlers 0 and 1 (unknownOf). */
  weightKnown: [boolean, boolean];
  /** A transformed Slow Start battler is out (unknownOf). */
  slowStartTransformed: boolean;
}

/** A read's base view, over the (data, ai) it was last built for (baseViewOf). */
interface KeptBase {
  readonly data: LoadedData;
  readonly ai: AiRomData;
  readonly base: Caught<BaseView>;
}

/**
 * The base views, by read. A source gives each state object
 * one read while it keeps it (Showdown's: per dex install, among the READ_CAPACITY read last), so a read stands for
 * exactly one state: another state object or a new read of it misses here, and an entry goes when its read does, so the
 * source's bound bounds these too. The (data, ai) pair is checked on every hit: one pair per read, as before.
 */
const bases = new WeakMap<AiBattleRead, KeptBase>();

/**
 * The base view of `read` over `data` and `ai`: the one kept for it (a failed build included, which throws again each
 * time), else built and kept. Nothing writes to it: views share its parts (tests freeze them, test/unit/ai/model.test.ts).
 */
function baseViewOf(read: AiBattleRead, data: LoadedData, ai: AiRomData): Caught<BaseView> {
  const kept = bases.get(read);
  if (kept !== undefined && kept.data === data && kept.ai === ai) return kept.base;
  const base = attempt(() => buildBase(read, data, ai));
  bases.set(read, { data, ai, base });
  return base;
}

/** The memory-free part of the view, in the one-pass build's order (BaseView), each read field's fault met at its place. */
function buildBase(read: AiBattleRead, data: LoadedData, ai: AiRomData): BaseView {
  const faults = readFaults.get(read);
  const check: FaultCheck = (key) => {
    if (faults?.has(key)) throw faults.get(key);
  };
  const [player, enemy] = read.mons;
  // Every member of the side's party at 0 HP.
  const outOfPokemon = read.parties.map((party) => party.every((member) => member.hp === 0));
  const weightKnown: [boolean, boolean] = [false, false];
  // Each side's active Pokémon, in battler order; slots 2 and 3 hold no Pokémon in singles. Built first, as the one-pass
  // build did (the read's battleType, before them, can't throw); Pursuit's tests read the player's (pursuitMayRun).
  const mons: [AiBattleMon, AiBattleMon] = [
    battleMonOf(read, PLAYER_BATTLER, ai, check, (known) => { weightKnown[PLAYER_BATTLER] = known; }),
    battleMonOf(read, AI_BATTLER, ai, check, (known) => { weightKnown[AI_BATTLER] = known; }),
  ];
  return {
    // The read's battleType: singles, or doubles, which the AI refuses (AiError).
    battleType: read.battleType,
    mons,
    // The read's parties, in party order (the engine's party indices), with the Personal row's types.
    parties: [partyOf(read, PLAYER_BATTLER, data, check), partyOf(read, AI_BATTLER, data, check)],
    // The active Pokémon's party index. 6 once a side has no Pokémon left (battle_controller_player.c:4111, 4135). Slots
    // 2 and 3 are never written in singles: BattleContext_New clears the context (battle_controller_player.c:182), and
    // the battle start sets the party slots of the battlers in play only.
    selectedPartySlot: [
      outOfPokemon[0] ? NO_PARTY_SLOT : partyIndexOf(read, PLAYER_BATTLER, check),
      outOfPokemon[1] ? NO_PARTY_SLOT : partyIndexOf(read, AI_BATTLER, check), 0, 0,
    ],
    // The read's totalTurns. Exact: LoadTurnCount reads it (trainer_ai.c:934).
    totalTurns: read.totalTurns,
    // The read's field mask: weather, Trick Room and Gravity, and each battler's Uproar; the deep fog bit is the note's
    // and the memory's (composeView).
    fieldMask: field(check, 'fieldConditionsMask', read.fieldConditionsMask),
    // Each battler's roosting and helpingHand; none in the empty slots.
    turnFlags: [turnFlagsOf(player), turnFlagsOf(enemy), turnFlagsOf(null), turnFlagsOf(null)],
    sideConditionsMask: [read.sideConditionsMask[0], read.sideConditionsMask[1]],
    sideConditions: [hazardsOf(read, 0), hazardsOf(read, 1)],
    // Each battler's moveProtect: a Protect, Detect or Endure whose chain is alive.
    // GAP: listed unknown where the read can't settle the chain (protectChainKnown). Spot check 16.
    moveProtect: [
      field(check, 'mons.0.moveProtect', player.moveProtect), field(check, 'mons.1.moveProtect', enemy.moveProtect),
      MOVE_NONE, MOVE_NONE,
    ],
    // Each battler's `lastItem` (a ROM item ID), for recycleItem.
    lastItems: [caughtField(faults, 'mons.0.lastItem', () => player.lastItem), caughtField(faults, 'mons.1.lastItem', () => enemy.lastItem)],
    rest: {
      // BattleContext_InitCounters sets the bits of the two empty slots in singles (battle_lib.c:2031–2033); a side whose
      // whole party has fainted gets its battler's bit (battle_controller_player.c:4110, 4134): every member of the
      // side's party at 0 HP.
      battlersSwitchingMask: (1 << BATTLER_PLAYER_2) | (1 << BATTLER_ENEMY_2)
        | (outOfPokemon[0] ? 1 << PLAYER_BATTLER : 0) | (outOfPokemon[1] ? 1 << AI_BATTLER : 0),
      // The cartridge's monSpeedValues for battlers 0 and 1: what its latest BattleSystem_CompareBattlerSpeed wrote
      // (battle_lib.c:1372–1373), the read's. The AI's own compares while it decides (trainer_ai.c:1109, 1121, 2081)
      // write run-local copies that the interpreter carries (RunInput.monSpeedValues, the slow path), so this is the
      // decision-start value. Slots 2 and 3 are never compared in singles: 0 (cleared, battle_controller_player.c:182).
      // GAP: the engine's compare doesn't reset a transformed battler's Slow Start turn (battle_script.c:5360), so with a
      // transformed Slow Start battler out, the values are listed unknown (PATHS.monSpeedValues). Spot check 21.
      monSpeedValues: [read.monSpeedValues[0], read.monSpeedValues[1], 0, 0],
      // This turn's Quick Claw draw (speedRand, battle_lib.c:1279), where the engine has picked it (quickClawRollOf):
      // the same draw, so the AI's read is exact. Where it hasn't, null: the AI marginalises it at its prior.
      quickClawThisTurn: [
        quickClawRollOf(read.quickClawRolls[0], ai, player), quickClawRollOf(read.quickClawRolls[1], ai, enemy), null, null,
      ],
      // AI_CONTEXT.trainerItems, a u16[MAX_TRAINER_ITEMS] in the cleared AIContext: battle start copies the trainer's
      // non-empty ROM item slots to its front, in order (battle_controller_player.c:4801–4813), so the rest stay 0. The
      // read's bag is that compacted list, with 0 for a used slot (trainer_ai.c:4191).
      trainerItems: [...read.bag, ...Array<number>(Math.max(0, MAX_TRAINER_ITEMS - read.bag.length)).fill(ITEM_NONE)],
      // AI_CONTEXT.trainerItemCounts: the compacted list's length, which battle start counts (battle_controller_player.c:4809)
      // and a use never lowers. The engine keeps the list at that length.
      trainerItemCount: read.bag.length,
    },
    note: read.fieldNote,
    enemyFainted: enemy.curHP === 0,
    // The queue's fault, if any, met where replacementState reads it. The player's battler, whose fields' faults the
    // base met above (battleMonOf), gives TryPursuit's tests.
    pursuitMayRun: caughtField(faults, 'queuedPlayerMoves', () => pursuitMayRun(read.queuedPlayerMoves, mons[PLAYER_BATTLER], data)),
    // protectChainKnown, the AI's battler's with its bag (the read's).
    protectKnown: caughtField(faults, 'protectChainKnown', (): [boolean, boolean] => [player.protectChainKnown, enemy.protectChainKnown]),
    transformed: [player.transformed, enemy.transformed],
    weightKnown,
    slowStartTransformed: read.mons.some((mon) => mon.transformed && mon.ability === ABILITY_SLOW_START),
  };
}

/** `value`, the read's field at `key`, after the fault its source registered there, if any. */
function field<T>(check: FaultCheck, key: ReadFaultKey, value: T): T {
  check(key);
  return value;
}

/** The six IVs as the view's Stats. */
function ivsOf(ivs: AiReadIvs): Stats {
  return { hp: ivs.hp, atk: ivs.atk, def: ivs.def, spa: ivs.spa, spd: ivs.spd, spe: ivs.spe };
}

/** BattleMon.moveEffectsData's fields the AI reads: the read's, in the view's order. */
function effectsOf(effects: AiMoveEffectsData): AiMoveEffectsData {
  return {
    disabledMove: effects.disabledMove,
    disabledTurns: effects.disabledTurns,
    encoredMove: effects.encoredMove,
    encoredTurns: effects.encoredTurns,
    tauntedTurns: effects.tauntedTurns,
    embargoTurns: effects.embargoTurns,
    perishSongTurns: effects.perishSongTurns,
    stockpileCount: effects.stockpileCount,
    protectSuccessTurns: effects.protectSuccessTurns,
    fakeOutTurnNumber: effects.fakeOutTurnNumber,
    slowStartTurnNumber: effects.slowStartTurnNumber,
    lastResortCount: effects.lastResortCount,
    flashFire: effects.flashFire,
    canUnburden: effects.canUnburden,
    healBlockTurns: effects.healBlockTurns,
    magnetRiseTurns: effects.magnetRiseTurns,
    choiceLockedMove: effects.choiceLockedMove,
  };
}

/**
 * BattleMon.weight: the Pokédex weight BattleSystem_InitBattleMon loads for the read's weightSpecies, from the table
 * Pokedex_SetupGiratina picks by the battler's form (battle_lib.c:145–150; src/rom/weights.ts): `ai.weights` for form 0,
 * `ai.formWeights` for any other. `known` is false (GAP, spot check 18) when the two tables differ for the species and
 * the form can't be read: a species FORMS doesn't list, or a transformed battler, whose target's own form at its
 * switch-in the state doesn't keep. In both ROMs the tables differ only for Giratina, whose form FORMS lists.
 */
function weightOf(ai: AiRomData, mon: AiReadMon): { weight: number; known: boolean } {
  const species = mon.weightSpecies;
  const weight = (mon.weightForm === 0 ? ai.weights : ai.formWeights)[species];
  if (weight === undefined) throw new AiError('BAD_VIEW', `the ROM's Pokédex has no weight for species ${species}`);
  const formless = ai.weights[species] === ai.formWeights[species];
  return { weight, known: formless || (FORMS[species] !== undefined && !mon.transformed) };
}

/**
 * One battler slot from the read's battler, without the memory's MOVE_EFFECT_IMPRISONED (composeView adds it), each
 * field's registered fault met where the one-pass build read the field. `weightKnown` is told weightOf's `known`, which
 * unknownOf lists from.
 */
function battleMonOf(
  read: AiBattleRead, battler: 0 | 1, ai: AiRomData, check: FaultCheck, weightKnown: (known: boolean) => void,
): AiBattleMon {
  const mon = read.mons[battler];
  const weighed = (): number => {
    const { weight, known } = weightOf(ai, mon);
    weightKnown(known);
    return weight;
  };
  check(`mons.${battler}.moves`); // the one-pass build read the moves first
  return {
    species: mon.species,
    form: mon.form,
    level: mon.level,
    gender: mon.gender,
    types: field(check, `mons.${battler}.types`, [mon.types[0], mon.types[1]]),
    ability: field(check, `mons.${battler}.ability`, mon.ability),
    heldItem: field(check, `mons.${battler}.heldItem`, mon.heldItem),
    // The ROM's Pokédex weight in hectograms (weightOf), not Showdown's `weighthg`.
    weight: weighed(),
    friendship: mon.friendship,
    ivs: ivsOf(mon.ivs),
    curHP: mon.curHP,
    maxHP: mon.maxHP,
    attack: mon.attack,
    defense: mon.defense,
    spAttack: mon.spAttack,
    spDefense: mon.spDefense,
    speed: mon.speed,
    statBoosts: [...mon.statBoosts],
    moves: [...mon.moves],
    ppCur: [...mon.ppCur],
    ppMax: [...mon.ppMax],
    status: field(check, `mons.${battler}.status`, mon.status),
    statusVolatile: field(check, `mons.${battler}.statusVolatile`, mon.statusVolatile),
    moveEffectsMask: field(check, `mons.${battler}.moveEffectsMask`, mon.moveEffectsMask),
    effects: field(check, `mons.${battler}.effects`, effectsOf(mon.effects)),
  };
}

/** One side's party in party order, as Pokemon_GetValue reads the party data. */
function partyOf(read: AiBattleRead, side: 0 | 1, data: LoadedData, check: FaultCheck): AiPartyMon[] {
  return read.parties[side].map((member, i) => {
    check(`parties.${side}.${i}.pokemon`);
    const row = data.rom.species[personalRowFor(member.species, member.form)];
    if (row === undefined) throw new AiError('BAD_VIEW', `no Personal row for species ${member.species} form ${member.form}`);
    check(`parties.${side}.${i}.fields`);
    return {
      species: member.species,
      form: member.form,
      level: member.level,
      hp: member.hp,
      maxHp: member.maxHp,
      status: member.status,
      moves: [...member.moves],
      pp: [...member.pp],
      ppMax: [...member.ppMax],
      heldItem: member.heldItem,
      ability: member.ability,
      // The Personal row's types for the set's species and form (MON_DATA_TYPE_1/2), from LoadedData.
      types: [row.types[0], row.types[1]],
      ivs: ivsOf(member.ivs),
    };
  });
}

/** The read's party index of battler `battler`'s active Pokémon, after the fault its source registered there. */
function partyIndexOf(read: AiBattleRead, battler: 0 | 1, check: FaultCheck): number {
  return field(check, `mons.${battler}.partyIndex`, read.mons[battler].partyIndex);
}

/** BattleContext.turnFlags[i] from the read's battler in slot i (null: an empty slot, all clear). */
function turnFlagsOf(mon: AiReadMon | null): AiTurnFlags {
  return { roosting: mon !== null && mon.roosting, helpingHand: mon !== null && mon.helpingHand };
}

/** Exact (LoadSpikesLayers, trainer_ai.c:1948): the read's hazard layers on side `side`. */
function hazardsOf(read: AiBattleRead, side: 0 | 1): AiSideConditions {
  const { spikesLayers, toxicSpikesLayers } = read.sideConditions[side];
  return { spikesLayers, toxicSpikesLayers };
}

/**
 * Whether a player's Pursuit may run at the AI's U-turn switch where the engine's didn't: a move action still queued for
 * the player (the read's `queued`, a battler that hasn't acted, battle_script.c:6900) whose move has the hack's
 * BATTLE_EFFECT_HIT_BEFORE_SWITCH, unless TryPursuit's own tests rule it out for `player`, the player's battler
 * (tryPursuitRuledOut).
 */
function pursuitMayRun(queued: readonly number[], player: AiBattleMon, data: LoadedData): boolean {
  return queued.some((move) => data.rom.moves[move]?.effect === BATTLE_EFFECT_HIT_BEFORE_SWITCH
    && !tryPursuitRuledOut(player, move, data));
}

/**
 * Whether BtlCmd_TryPursuit (battle_script.c:6884–6955) doesn't run `selected`, the move `mon` (the player's battler, the
 * one foe in singles) chose, at the AI's switching battler, by tests the view settles. A test it can't settle never rules
 * the Pursuit out.
 * - Fainted (bs:6901) or asleep or frozen (bs:6902, MON_CONDITION_SLEEP | MON_CONDITION_FREEZE): exact.
 * - Truant's loafing (bs:6903, Battler_CheckTruant, battle_lib.c:3304–3314) compares moveEffectsData.truant with the turn
 *   count's parity; the read doesn't have that bit (a switch-in or a faint, Transform, Skill Swap and Role Play write it,
 *   battle_lib.c:2119, 2197, battle_script.c:5359, subscript_exchange_abilities.s:19–20, subscript_copy_ability.s:13), so
 *   it never rules out.
 * - The move tested (bs:6905–6910) is the Encore move when encoredMove is set and still in its slot
 *   (moves[encoredMoveSlot]), else the selected one. The read has no encoredMoveSlot, so with an encoredMove other than
 *   `selected` still among the moves both are tried; one no longer among the moves can't be in its slot.
 * - A tested move rules out when its effect isn't BATTLE_EFFECT_HIT_BEFORE_SWITCH or its first slot has no PP
 *   (bs:6913–6916, Battler_SlotForMove, battle_lib.c:2376–2387); a move in no slot settles nothing (the C would read
 *   past ppCur).
 */
function tryPursuitRuledOut(mon: AiBattleMon, selected: number, data: LoadedData): boolean {
  if (mon.curHP === 0 || (mon.status & (MON_CONDITION_SLEEP | MON_CONDITION_FREEZE)) !== 0) return true;
  const moves = mon.moves.slice(0, LEARNED_MOVES_MAX);
  const encored = mon.effects.encoredMove;
  const tested = encored !== MOVE_NONE && encored !== selected && moves.includes(encored) ? [encored, selected] : [selected];
  return tested.every((move) => {
    const effect = data.rom.moves[move]?.effect;
    if (effect === undefined) return false;
    if (effect !== BATTLE_EFFECT_HIT_BEFORE_SWITCH) return true;
    const slot = moves.indexOf(move);
    return slot >= 0 && mon.ppCur[slot] === 0;
  });
}

/**
 * `roll`, one side's Quick Claw roll in the read (null where the engine has drawn none, which the AI marginalises).
 * The engine's roll is `speedRand % 5 == 0`, Quick Claw's param 20; the AI reads
 * `speedRand % (100 / param)` with the held item's own param (battle_lib.c:1279, 1345). They are the same draw only when
 * `100 / param` is 5 in C integers, so for any other item the roll isn't read (null). The AI reads it only for a
 * HOLD_EFFECT_SOMETIMES_PRIORITY holder, which the engine's Quick Claw is.
 */
function quickClawRollOf(roll: boolean | null, ai: AiRomData, mon: AiReadMon): boolean | null {
  if (roll === null) return null;
  const param = ai.items[mon.heldItem]?.holdParam ?? 0;
  return param !== 0 && Math.trunc(100 / param) === 5 ? roll : null;
}

/**
 * `mon` with MOVE_EFFECT_IMPRISONED in its moveEffectsMask when `imprisoned` (the memory's imprisonedMark for its
 * battler). Imprison marks its user's foe whether or not it works (battle_script.c:6686–6690), and only the marked
 * battler's own switch-in or faint clears it (battle_lib.c:2071, 2076, 2166); Showdown keeps only the user's 'imprison'.
 * So the bit is the memory's (rememberStep's imprisonedMark), exact from the log; nothing is listed, as no case is left
 * that the log can't settle (spot check 15). The user's own MOVE_EFFECT_IMPRISON, which Move_Imprisoned reads with its
 * moves (battle_lib.c:3316–3336), is the read's: both set it on a working Imprison and drop it at the switch-out
 * (Showdown's 'imprison' is noCopy).
 */
function withImprisoned(mon: AiBattleMon, imprisoned: boolean): AiBattleMon {
  return imprisoned ? { ...mon, moveEffectsMask: mon.moveEffectsMask | MOVE_EFFECT_IMPRISONED } : mon;
}

/** `mon` with `ability`, the one its BattleMon keeps through a faint (replacementState), or as it is for none. */
function withAbility(mon: AiBattleMon, ability: number | undefined): AiBattleMon {
  return ability === undefined ? mon : { ...mon, ability };
}

/**
 * The view of `base` for `memory` at `phase`, every field in the one-pass build's key order. Its own arrays hold the
 * memory's fields; the rest are the base's, shared by every view of the read, which no caller writes (baseViewOf).
 */
function composeView(base: BaseView, phase: Phase['kind'], data: LoadedData, memory: AiMemoryData): AiView {
  const fog = fogOf(base.note, memory);
  // Each active Pokémon's `lastItem`, the item Recycle gives back, as a ROM item ID (the read's), unless the memory
  // overrides it. Bug Bite and Pluck also record the eaten berry in the victim's slot (subscript_pluck.s:10,
  // RemoveItem BTLSCR_DEFENDER), where Showdown's takeItem leaves lastItem alone: the memory keeps that berry
  // (rememberStep, recycleOverride), and the view takes it.
  // GAP: a Recycle or Natural Gift in such a slot leaves the memory 'unknown': listed (PATHS.recycleItem). Spot check
  // 14. Slots 2 and 3 are never written in singles: ITEM_NONE, exact.
  const recycleItem = [
    recycleItemOf(memory, PLAYER_BATTLER, base.lastItems), recycleItemOf(memory, AI_BATTLER, base.lastItems), ITEM_NONE, ITEM_NONE,
  ];
  const { rest } = base;
  const replacing = replacementState(phase, data, memory, base);
  const unknown = [...unknownOf(memory, base, fog), ...replacing.gaps];
  return {
    battleType: base.battleType,
    mons: [
      withImprisoned(base.mons[PLAYER_BATTLER], memory.imprisonedMark[PLAYER_BATTLER]),
      withImprisoned(withAbility(base.mons[AI_BATTLER], replacing.ability), memory.imprisonedMark[AI_BATTLER]),
      EMPTY_MON, EMPTY_MON,
    ],
    parties: base.parties,
    selectedPartySlot: base.selectedPartySlot,
    // Default: BattleContext_Init sets 6 ("none") for every battler at each turn end (battle_lib.c:2015); only the
    // AI's own switch decision writes it, and Showdown keeps no pending AI switch. So 6 everywhere.
    aiSwitchedPartySlot: [NO_SWITCH, NO_SWITCH, NO_SWITCH, NO_SWITCH],
    totalTurns: base.totalTurns,
    // The base's mask and the note's deep fog while the memory says it stands. Gen 4's deep fog has no Showdown weather,
    // and the engine keeps it as a flag the read doesn't carry, so the note and the memory give it (memory.ts `fog`);
    // the weather bits can't hold with it (a weather clears it). Spot check 20.
    fieldConditionsMask: fog === 'standing' ? FIELD_CONDITION_DEEP_FOG | base.fieldMask : base.fieldMask,
    // No AI-read bit: Showdown keeps no SYSCTL_* flags, and none of the bits the AI's helpers read (LAST_OF_MULTI_TURN,
    // IGNORE_TYPE_CHECKS, IGNORE_IMMUNITIES) is set at any decision but one. BattleContext_Init clears them (SYSCTL_INIT,
    // battle_lib.c:2009; system_control.h:31–40) at the end of every action (battle_controller_player.c:3998) and of
    // every turn (:1855), and between the last action and a turn choice or a post-KO replacement only the turn-end
    // checks run, whose scripts never set them (battleScripts.ts). The one exception is the AI's own mid-turn switch,
    // which runs inside its switching move's action: there the view lists REPLACEMENT_PATHS.statusMask when that action's
    // moves can set one (unknownOf). The bits SYSCTL_INIT keeps (Mold Breaker's, the fainted and self-destructed
    // battlers') are never read by the AI, and aiCalcDamage throws on IGNORE_TYPE_CHECKS.
    battleStatusMask: 0,
    // 10, BattleContext_Init's value (battle_lib.c:1980), exact by the same argument: every powerMul writer (the effect
    // scripts in battleScripts.ts, Revenge's CalcRevengePowerMul and Pursuit's TryPursuit, battle_script.c:6531–6533,
    // 6928) runs inside an action, whose MoveEnd resets it. At the AI's mid-turn switch it is 20 after a Pursuit at the
    // switching battler, or listed as REPLACEMENT_PATHS.powerMul when its action can have written it (replacementState).
    powerMul: replacing.powerMul,
    turnFlags: base.turnFlags,
    sideConditionsMask: base.sideConditionsMask,
    sideConditions: base.sideConditions,
    // From the memory: movePrevByBattler is the cartridge's "last move that ran" (rememberStep's lastMoveBy), which
    // Showdown's `lastMove` doesn't match (a Pokémon that can't move keeps it). Slots 2 and 3: never written in singles.
    movePrevByBattler: [memory.lastMoveBy[PLAYER_BATTLER], memory.lastMoveBy[AI_BATTLER], MOVE_NONE, MOVE_NONE],
    // From the memory's lastHitBy (the AI battler's moveHit). The AI reads only its own battler's (trainer_ai.c:3656,
    // 3737), so the player's slot takes the empty value MOVE_NONE, as do slots 2 and 3.
    moveHit: [MOVE_NONE, memory.lastHitBy?.move ?? MOVE_NONE, MOVE_NONE, MOVE_NONE],
    // From the memory's lastHitBy, with BATTLER_NONE for none (battle_lib.c:2022); the other slots as moveHit.
    moveHitBattler: [BATTLER_NONE, memory.lastHitBy?.battler ?? BATTLER_NONE, BATTLER_NONE, BATTLER_NONE],
    moveProtect: base.moveProtect,
    recycleItem,
    battlersSwitchingMask: rest.battlersSwitchingMask,
    monSpeedValues: rest.monSpeedValues,
    quickClawThisTurn: rest.quickClawThisTurn,
    trainerItems: rest.trainerItems,
    trainerItemCount: rest.trainerItemCount,
    unknown,
  };
}

/**
 * What a replacement reads of the turn that the state doesn't hold (final fix wave, item 1), from the memory: powerMul,
 * and the paths (REPLACEMENT_PATHS) the state can't give.
 * - At the AI's mid-turn switch (U-turn, Baton Pass), which runs inside its switching action before that action's
 *   MoveEnd resets battleStatusMask and powerMul (battleScripts.ts), memory.switchAction holds the action's moves:
 *   - battleStatusMask's AI-read bits are listed when one of their effects is in S_MASK_EFFECTS;
 *   - powerMul is listed when one is in S_POWER_EFFECTS, U-turn's aside. U-turn's effect writes it only through
 *     subscript_pursuit (subscript_attack_then_switch_out.s:54, before the pick at :71): when a foe that hasn't moved
 *     chose a BATTLE_EFFECT_HIT_BEFORE_SWITCH move, TryPursuit sets powerMul 20 (battle_script.c:6898–6928) and that
 *     move hits the switching battler. Showdown runs it at the same point (its `[from] Pursuit` line is in the action),
 *     so when the action shows it, powerMul is exactly 20: nothing after it in the action writes powerMul. When a player's
 *     move with that effect is still queued (the read's queuedPlayerMoves), Showdown didn't run it: TryPursuit's own
 *     tests on its user (tryPursuitRuledOut: fainted, asleep or frozen, the tested move's effect and PP, under Encore)
 *     that rule it out make powerMul 10 and the battler's HP the state's, exact; otherwise the cartridge may have run it
 *     (every test passes, an engine disagreement, or a Truant user or an Encore the read can't settle): powerMul and the
 *     battler's HP are listed (pursuitMayRun);
 *   - a step at the switch that shows no AI action, or a move with no record, lists both.
 * - At a replacement after the AI's battler fainted: the fields its BattleMon keeps through the faint that the log shows
 *   changed since its switch-in (memory.aiKept), which Showdown's faint has reset. The ability a Trace gave it is no
 *   gap: the Trace line named it (memory.aiTraced), and its BattleMon keeps it (BattleSystem_CleanupFaintedMon,
 *   battle_lib.c:2156–2210), so `ability` is that one, over the reset ability the state holds.
 * - At a turn choice, nothing: 10, and no path (see `battleStatusMask` and `powerMul` above).
 */
function replacementState(
  phase: Phase['kind'], data: LoadedData, memory: AiMemoryData, base: BaseView,
): { powerMul: number; gaps: string[]; ability: number | undefined } {
  const gaps: string[] = [];
  const fainted = phase === 'enemyReplacement' && base.enemyFainted;
  if (fainted) gaps.push(...memory.aiKept);
  const ability = fainted ? memory.aiTraced : undefined;
  if (phase !== 'enemyMidTurnSwitch') return { powerMul: DEFAULT_POWER_MUL, gaps, ability };
  const action = memory.switchAction;
  const effects = (action ?? []).map((move) => data.rom.moves[move]?.effect);
  if (action === null || effects.some((effect) => effect === undefined)) {
    return { powerMul: DEFAULT_POWER_MUL, gaps: [...gaps, REPLACEMENT_PATHS.statusMask, REPLACEMENT_PATHS.powerMul], ability };
  }
  if (effects.some((effect) => S_MASK_EFFECTS.has(effect!))) gaps.push(REPLACEMENT_PATHS.statusMask);
  const otherWriter = effects.some((effect) => effect !== BATTLE_EFFECT_SWITCH_HIT && S_POWER_EFFECTS.has(effect!));
  const pursuable = effects.includes(BATTLE_EFFECT_SWITCH_HIT) && settled(base.pursuitMayRun);
  if (otherWriter || pursuable) gaps.push(REPLACEMENT_PATHS.powerMul);
  if (pursuable) gaps.push(REPLACEMENT_PATHS.field(AI_BATTLER, 'curHP'));
  const pursued = effects.includes(BATTLE_EFFECT_HIT_BEFORE_SWITCH);
  return { powerMul: pursued ? PURSUIT_POWER_MUL : DEFAULT_POWER_MUL, gaps, ability };
}

/**
 * recycleItem for `battler`: the memory's override, else the read's `lastItem` (the base view's
 * `lastItems`, which throws here what its source registered).
 */
function recycleItemOf(memory: AiMemoryData, battler: number, lastItems: BaseView['lastItems']): number {
  const override = memory.recycleOverride[battler];
  return typeof override === 'number' ? override : settled(lastItems[battler]!);
}

/**
 * The view paths the read and the memory can't settle (AiView.unknown), in this order:
 * - recycleItem, for a battler whose slot the memory can't settle (a Recycle or Natural Gift after a Bug Bite or Pluck
 *   ate its berry; see `recycleItem` above; spot check 14);
 * - moveProtect and protectSuccessTurns, for a battler whose chain the read can't settle (protectChainKnown; spot
 *   check 16);
 * - slowStartTurnNumber and the IVs, for a transformed battler: Transform copies the target's IVs (battle_script.c:
 *   5346–5348, BattleMon up to `ability`) and resets the turn number (:5360), and Showdown records neither the target's
 *   IVs nor when it transformed (spot checks 17 and 19);
 * - the weight, where the Pokédex tables differ and the form can't be read (weightOf; spot check 18);
 * - deep fog, when the trainer's field note says fog and a Defog since may have blown it away (memory.ts `fog`; spot check 20);
 * - monSpeedValues, while a transformed Slow Start battler is out (see `monSpeedValues` above; spot check 21);
 * - the player's known moves, when the memory couldn't settle a turn's record (memory.ts playerMovesUnknown).
 * Friendship is exact since the engine sets happiness from BattleMon.friendship (spot check 22), and the foe's
 * MOVE_EFFECT_IMPRISONED since the memory derives it from the log (withImprisoned; spot check 15), so neither is
 * listed. Slots 2 and 3 are EMPTY_MON, which the cartridge never writes in singles: exact.
 */
function unknownOf(memory: AiMemoryData, base: BaseView, fog: FogFate): string[] {
  const unknown: string[] = [];
  const battlers = [PLAYER_BATTLER, AI_BATTLER] as const;
  for (const battler of battlers) {
    if (memory.recycleOverride[battler] === 'unknown') unknown.push(PATHS.recycleItem(battler));
  }
  // protectChainKnown, the AI's battler's with its bag (the base view's protectKnown).
  const protectKnown = settled(base.protectKnown);
  for (const battler of battlers) {
    if (!protectKnown[battler]) unknown.push(PATHS.moveProtect(battler), PATHS.protectSuccessTurns(battler));
  }
  for (const battler of battlers) {
    if (base.transformed[battler]) unknown.push(PATHS.slowStartTurnNumber(battler), PATHS.ivs(battler));
  }
  for (const battler of battlers) {
    if (!base.weightKnown[battler]) unknown.push(PATHS.weight(battler));
  }
  if (fog === 'unknown') unknown.push(PATHS.fog);
  if (base.slowStartTransformed) unknown.push(PATHS.monSpeedValues);
  if (memory.playerMovesUnknown) unknown.push(PATHS.knownMoves(PLAYER_BATTLER));
  return unknown;
}

/**
 * The deep fog's fate in the read's field note: the note's fog stands, or is gone, or is unknown (memory.ts `fog`); a
 * note without fog has none, 'cleared'.
 */
function fogOf(note: FieldSpec, memory: AiMemoryData): FogFate {
  return note.fog === true ? memory.fog : 'cleared';
}
