// Contract between the trainer AI (`src/ai`) and an engine's view of a battle state, for the AI's reads. Types only. One cartridge-shaped, plain-data snapshot per state (`AiBattleRead`),
// built by an `AiBattleSource`, one per engine.
// The AI composes its own view from a read, its memory and the ROM data, so the two engines cannot differ
// there. `docs/ai-reads.md` lists the
// reads and the cartridge source of each field.
//
// Value conventions: IDs are ROM IDs (moves, abilities, items, species, types; 0 is none for moves, abilities and
// items), except `AiReadRequest`'s Showdown move IDs. Battler 0 is the player's side (`p1`), 1 the trainer's (`p2`);
// singles only. Party order is the engine's party index, as `Choice.index`. A source that cannot give a field exactly
// sets the flag the interface has for it (`protectChainKnown`, `transformed`) or throws; it never writes a guess.
//
// A new read is added here first, then to both sources.

import type { Choice, EngineState, FieldSpec } from './engine.js';

/** hpIV … spDefenseIV, as src/rom/types.ts `Stats`. */
export interface AiReadIvs { hp: number; atk: number; def: number; spa: number; spd: number; spe: number }

/** BattleMon.moveEffectsData (battle_mon.h:8): the fields the AI reads, under their C names. */
export interface AiReadEffects {
  disabledMove: number; disabledTurns: number; encoredMove: number; encoredTurns: number; tauntedTurns: number;
  embargoTurns: number; perishSongTurns: number; stockpileCount: number; protectSuccessTurns: number;
  fakeOutTurnNumber: number; slowStartTurnNumber: number; lastResortCount: number; flashFire: boolean;
  canUnburden: boolean; healBlockTurns: number; magnetRiseTurns: number; choiceLockedMove: number;
}

/** One side's active battler: BattleContext.battleMons[b] (battle_mon.h:57) and the per-battler BattleContext fields. */
export interface AiReadMon {
  /** The active Pokémon's party index. */
  partyIndex: number;
  species: number; form: number; level: number;
  /** 0 male, 1 female, 2 genderless. */
  gender: number;
  types: [number, number]; ability: number; heldItem: number;
  friendship: number; ivs: AiReadIvs;
  curHP: number; maxHP: number; attack: number; defense: number; spAttack: number; spDefense: number; speed: number;
  /** 8 stages in BATTLE_STAT order (HP, Atk, Def, Speed, SpAtk, SpDef, accuracy, evasion), 0–12, 6 neutral. */
  statBoosts: number[];
  /** 4 each; move 0 = empty slot. */
  moves: number[]; ppCur: number[]; ppMax: number[];
  /** MON_CONDITION_*; a fainted battler keeps the status it fainted with. */
  status: number;
  /** VOLATILE_CONDITION_*. */
  statusVolatile: number;
  /** MOVE_EFFECT_*, WITHOUT MOVE_EFFECT_IMPRISONED (the composer adds it from the memory). */
  moveEffectsMask: number;
  effects: AiReadEffects;
  /** BattleContext.turnFlags[b].roosting and .helpingHand (battle_context.h:57, :61). */
  roosting: boolean; helpingHand: boolean;
  /** The battler is transformed. The composer lists slowStartTurnNumber and the IVs unknown, and gates monSpeedValues. */
  transformed: boolean;
  /** The species and form whose Pokédex weight BattleMon.weight holds (the composer looks the weight up). */
  weightSpecies: number; weightForm: number;
  /** BattleContext.moveProtect[b] as LoadProtectChain reads it: Protect, Detect or Endure with a live chain, else 0. */
  moveProtect: number;
  /** False when the engine cannot settle moveProtect and protectSuccessTurns (docs/ai-spot-checks.md item 16). */
  protectChainKnown: boolean;
  /** The engine's own record of the item Recycle would restore (0 none). The composer applies the memory's override. */
  lastItem: number;
}

/** One party member, as Pokemon_GetValue reads the party data. */
export interface AiReadPartyMon {
  species: number; form: number; level: number; hp: number; maxHp: number;
  /** MON_CONDITION_*; a fainted member reads 0. */
  status: number;
  moves: number[]; pp: number[]; ppMax: number[];
  heldItem: number; ability: number; ivs: AiReadIvs;
}

/** p2's move request at a turn choice, for mapping the AI's slot to the contract's `Choice.slot`. */
export interface AiReadRequest {
  /** The request's entries in order: each move's Showdown ID, and whether it may be chosen (not disabled, PP not 0). */
  entries: { id: string; usable: boolean }[];
  /** The Showdown IDs of the trainer's active Pokémon's move slots, in slot order (up to 4). */
  slotIds: string[];
}

export interface AiBattleRead {
  /** BATTLE_TYPE_* mask. */
  battleType: number;
  /** BattleContext.totalTurns (battle_context.h:202): finished turns. */
  totalTurns: number;
  mons: [AiReadMon, AiReadMon];
  parties: [AiReadPartyMon[], AiReadPartyMon[]];
  /** FIELD_CONDITION_* (battle_context.h:210) WITHOUT the deep-fog bit (the composer adds it from the note and the memory). */
  fieldConditionsMask: number;
  /** SIDE_CONDITION_* by side (battle_context.h:213). */
  sideConditionsMask: [number, number];
  sideConditions: [{ spikesLayers: number; toxicSpikesLayers: number }, { spikesLayers: number; toxicSpikesLayers: number }];
  /** BattleContext.monSpeedValues for battlers 0 and 1 (battle_context.h:259); 0 before the first compare. */
  monSpeedValues: [number, number];
  /** The engine's stored Quick Claw roll per side (true = activates); null = not drawn. Ungated: the composer gates it. */
  quickClawRolls: [boolean | null, boolean | null];
  /** The trainer's bag as battle start compacted it, 0 for a used slot (length = the start bag's, at most 4). */
  bag: number[];
  /** `move.num` of each `move` action still queued for p1, in queue order (for the Pursuit-at-U-turn gap). */
  queuedPlayerMoves: number[];
  /** Null when the battle does not wait on p2's turn choice. */
  request: AiReadRequest | null;
  /** The trainer's ROM index and raw u32 AI mask. */
  trainer: { romIndex: number; aiMask: number };
  /** The trainer's field note as createBattle stored it. */
  fieldNote: FieldSpec;
}

/** What the trainer AI needs of an engine. One implementation per engine; a dispatcher picks by state. */
export interface AiBattleSource {
  /** The read of `state`. Pure; equal state keys give deep-equal reads. Cached per state object. */
  read(state: EngineState): AiBattleRead;
  /** p2's legal choices, as Engine.legalChoices(state, 'p2'). */
  legalChoices(state: EngineState): Choice[];
  /** The battle-start protocol lines (omniscient), as the engine's battleStartLog(state). */
  startLog(state: EngineState): string[];
}
