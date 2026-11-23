// What the trainer AI reads: a plain-data copy of the parts of BattleContext (battle_context.h) and BattleMon
// (battle_mon.h) the AI and its battle_lib.c helpers read, in the cartridge's own encodings. The engine adapter
// builds it; nothing in src/ai reads the engine.

import type { MoveRecord, SpeciesRecord, Stats } from '../rom/types.js';
import type { AiItemRecord } from './rom/items.js';
import type { AiScript } from './rom/script.js';
import type { TypeChart } from './rom/typeChart.js';

/** One battler slot: BattleContext.battleMons[i] (battle_mon.h:57). */
export interface AiBattleMon {
  species: number; form: number; level: number;
  /** Cartridge gender: 0 male, 1 female, 2 genderless (GENDER_*). */
  gender: number;
  types: [number, number]; ability: number; heldItem: number;
  /** In hectograms, as BattleMon.weight. */
  weight: number;
  friendship: number;
  /** hpIV … spDefenseIV. */
  ivs: Stats;
  curHP: number; maxHP: number; attack: number; defense: number; spAttack: number; spDefense: number; speed: number;
  /** 8 stages in BATTLE_STAT order, 0–12, 6 = neutral. */
  statBoosts: number[];
  /** 4 each; move 0 = empty. ppMax is each move's maximum PP. */
  moves: number[]; ppCur: number[]; ppMax: number[];
  /** MON_CONDITION_*, VOLATILE_CONDITION_* and MOVE_EFFECT_* masks. */
  status: number; statusVolatile: number; moveEffectsMask: number;
  effects: AiMoveEffectsData;
}

/**
 * The BattleMon.moveEffectsData fields (battle_mon.h:8) the AI and its helpers read, under their C names. Tasks 5–6 add
 * any other field BattleSystem_CheckInvalidMoves or BattleSystem_CalcMoveDamage reads, under its C name.
 */
export interface AiMoveEffectsData {
  disabledMove: number; disabledTurns: number; encoredMove: number; encoredTurns: number; tauntedTurns: number;
  embargoTurns: number; perishSongTurns: number; stockpileCount: number; protectSuccessTurns: number;
  fakeOutTurnNumber: number; slowStartTurnNumber: number; lastResortCount: number; flashFire: boolean;
  canUnburden: boolean; healBlockTurns: number; magnetRiseTurns: number; choiceLockedMove: number;
}

/** One party member, as Pokemon_GetValue reads it. */
export interface AiPartyMon {
  species: number; form: number; level: number; hp: number; maxHp: number; status: number;
  /** 4 each; move 0 = empty. */
  moves: number[]; pp: number[]; ppMax: number[];
  heldItem: number; ability: number; types: [number, number]; ivs: Stats;
}

/** What the AI reads of a side's entry hazards. */
export interface AiSideConditions { spikesLayers: number; toxicSpikesLayers: number }

/**
 * BattleContext.turnFlags[i] (battle_context.h:57): the fields the AI's helpers read. `helpingHand` (battle_context.h:61)
 * is read by BattleSystem_CalcMoveDamage (battle_lib.c:6694).
 */
export interface AiTurnFlags { roosting: boolean; helpingHand: boolean }

export interface AiView {
  /** BATTLE_TYPE_* mask. */
  battleType: number;
  /** Battler slots. Singles: 0 = player, 1 = AI, 2 and 3 = EMPTY_MON. */
  mons: [AiBattleMon, AiBattleMon, AiBattleMon, AiBattleMon];
  /** By side (0 player, 1 AI), in party order. */
  parties: [AiPartyMon[], AiPartyMon[]];
  /** 4 each, by battler. aiSwitchedPartySlot 6 = none. */
  selectedPartySlot: number[]; aiSwitchedPartySlot: number[];
  totalTurns: number; fieldConditionsMask: number;
  /**
   * BattleContext.battleStatusMask (SYSCTL_*, battle_context.h:224) as it stands when the AI runs. Battle code sets and
   * clears its bits one at a time; BattleContext_Init clears the move-local ones (SYSCTL_INIT, battle_lib.c:2009) at the
   * end of every action (battle_controller_player.c:3998) and turn (:1855), so the bits the AI reads are set only inside
   * an action: at the AI's own mid-turn switch (battleScripts.ts).
   */
  battleStatusMask: number;
  /**
   * BattleContext.powerMul (battle_context.h:232): the move-power multiplier, in tenths, that BattleSystem_CalcMoveDamage
   * applies (battle_lib.c:6688). BattleContext_Init sets it to 10 (battle_lib.c:1980) at the end of every action and
   * turn; effect scripts, Revenge's power check and Pursuit on a switch set it inside an action (battleScripts.ts;
   * battle_script.c:6531–6533, 6928).
   */
  powerMul: number;
  /** 4, by battler: BattleContext.turnFlags (battle_context.h:216). */
  turnFlags: AiTurnFlags[];
  /** By side. */
  sideConditionsMask: [number, number]; sideConditions: [AiSideConditions, AiSideConditions];
  /** 4 each, by battler; moveHitBattler uses BATTLER_NONE (0xFF) for none. */
  movePrevByBattler: number[]; moveHit: number[]; moveHitBattler: number[]; moveProtect: number[]; recycleItem: number[];
  battlersSwitchingMask: number;
  /** 4, by battler: the speeds the last BattleSystem_CompareBattlerSpeed wrote. */
  monSpeedValues: number[];
  /**
   * 4, by battler: this turn's Quick Claw result from speedRand (the AI reads the same draw that orders this turn,
   * battle_controller_player.c:707 before :853); null = unknown, a latent with the cartridge prior.
   */
  quickClawThisTurn: (boolean | null)[];
  /**
   * The AI's bag, compacted as battle start compacts it (AI_CONTEXT.trainerItems); 0 = used. At most 4 slots; a slot
   * past the list is ITEM_NONE, as battle start clears AIContext (battle_controller_player.c:4799).
   */
  trainerItems: number[]; trainerItemCount: number;
  /**
   * The view fields its builder could not derive, by path. The engine adapter (adapter.ts, through read/compose.ts) lists lib/known.ts's PATHS
   * ('recycleItem.0', 'mons.1.ivs', 'monSpeedValues', 'fieldConditionsMask.fog' and so on) and, at a
   * replacement, REPLACEMENT_PATHS; initialView lists none (the recycleItem the adapter can't settle is the engine path's). Each
   * holds a value, but the code that reads it calls requireKnown first, which throws AiError('UNDEFINED') for a listed
   * path: a gap is never read as a default.
   * A listed path that no reader guards (one lib/known.ts's PATHS doesn't name) makes decide, moveDistribution,
   * slotScores and replacement throw UNDEFINED at entry (assertGuarded). A hand-built view lists none.
   */
  unknown: readonly string[];
}

/** A battler slot with no Pokémon: everything 0, stat stages neutral. Singles fill slots 2 and 3 with it. Frozen. */
export const EMPTY_MON: AiBattleMon = deepFreeze({
  species: 0, form: 0, level: 0, gender: 0, types: [0, 0], ability: 0, heldItem: 0, weight: 0, friendship: 0,
  ivs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
  curHP: 0, maxHP: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0,
  statBoosts: [6, 6, 6, 6, 6, 6, 6, 6],
  moves: [0, 0, 0, 0], ppCur: [0, 0, 0, 0], ppMax: [0, 0, 0, 0],
  status: 0, statusVolatile: 0, moveEffectsMask: 0,
  effects: {
    disabledMove: 0, disabledTurns: 0, encoredMove: 0, encoredTurns: 0, tauntedTurns: 0, embargoTurns: 0,
    perishSongTurns: 0, stockpileCount: 0, protectSuccessTurns: 0, fakeOutTurnNumber: 0, slowStartTurnNumber: 0,
    lastResortCount: 0, flashFire: false, canUnburden: false, healBlockTurns: 0, magnetRiseTurns: 0, choiceLockedMove: 0,
  },
});

/** What the AI remembers between turns: AIContext's persistent fields (ai_context.h). */
export interface AiKnowledge {
  /** [4][4], by battler slot. */
  battlerMoves: number[][];
  /** [4], by battler slot. */
  battlerAbilities: number[];
  /** [4], by battler slot. */
  battlerHeldItems: number[];
}

/** The ROM data the AI reads. `moves`, `species` and `items` are indexed by ID. */
export interface AiDeps {
  script: AiScript; moves: MoveRecord[]; species: SpeciesRecord[]; items: (AiItemRecord | null)[]; typeChart: TypeChart;
  aiFlags: number;
}

/** The AI's battler slot in singles (BATTLER_ENEMY_1). */
export const AI_BATTLER = 1;
/** The player's battler slot in singles (BATTLER_PLAYER_1). */
export const PLAYER_BATTLER = 0;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
