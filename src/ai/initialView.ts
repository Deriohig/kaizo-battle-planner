// initialView: the trainer AI's view at its first decision (turn 1, both leads in), built from the planner's
// battle-ready Pokémon, with the leads' switch-in effects run through the engine; initialDecision: that view and the
// AI's knowledge then; worldsFor: the candidate worlds for a trainer's disputed natures and abilities; depsFor: the AI's
// ROM data for one trainer. The real-ROM sweep and the matchup sheet use them. They only read their arguments, but for
// the engine's dex, which initialView installs from `data` (switchIn.ts installDex).
//
// Battle start on the cartridge (pret/pokeplatinum 62bdaacdc). BattleContext_New clears the whole context, then runs
// BattleContext_Init, BattleContext_InitCounters and BattleControllerPlayer_InitAI (battle_controller_player.c:178–186).
// BattleControllerPlayer_InitBattleMons loads each lead with BattleSystem_InitBattleMon (:223–232). The switch-in
// effects run next (BattleControllerPlayer_ShowBattleMon, :254–267), and then command selection, where the AI decides.
// The leads never pass through BattleSystem_UpdateAfterSwitch: its one caller is the switch script command
// (battle_script.c:2522).
//
// The leads are loaded here as InitBattleMon loads them, with the field from the trainer's docs field note (the
// switch-in check's overworld weather step, battle_lib.c:3662–3707). The other switch-in effects come from the engine
// (switchIn.ts applySwitchIns), which refuses with a named reason where it can't give the
// cartridge's result. Friendship is known exactly: BattleMon.friendship.

import type { PlayerMon } from '../battle/playerMon.js';
import type { BattleMon, LoadedData, ResolvedMon, ResolvedTrainer, Sourced } from '../battle/types.js';
import type { BattleInput, FieldSpec, WorldAssignment } from '../contracts/engine.js';
import { computeStats } from '../rom/stats.js';
import { AI_FLAG_NAMES, type RomTrainer } from '../rom/trainers.js';
import type { StartStatus } from '../save/status.js';
import {
  BATTLE_STAT_MAX, BATTLE_TYPE_TRAINER_SINGLES, BATTLER_ENEMY_2, BATTLER_NONE, BATTLER_PLAYER_2, DEFAULT_STAT_STAGE,
  FIELD_CONDITION_DEEP_FOG, FIELD_CONDITION_GRAVITY_INIT, FIELD_CONDITION_HAILING_PERM, FIELD_CONDITION_RAINING_PERM, FIELD_CONDITION_SANDSTORM_PERM,
  FIELD_CONDITION_SUNNY_PERM, FIELD_CONDITION_TRICK_ROOM_INIT, GENDER_FEMALE, GENDER_MALE, GENDER_NONE, ITEM_NONE,
  LEARNED_MOVES_MAX, MON_CONDITION_BURN, MON_CONDITION_FREEZE, MON_CONDITION_NONE, MON_CONDITION_PARALYSIS,
  MON_CONDITION_POISON, MON_CONDITION_SLEEP, MON_CONDITION_TOXIC, MOVE_NONE,
} from './constants.js';
import { AiError } from './errors.js';
import { u8 } from './int.js';
import { compareSpeed, type Latents } from './lib/speed.js';
import { type AiRomData, aiScriptOf } from './rom/aiData.js';
import { applySwitchIns } from './switchIn.js';
import {
  AI_BATTLER, type AiBattleMon, type AiDeps, type AiKnowledge, type AiPartyMon, type AiView, EMPTY_MON, PLAYER_BATTLER,
} from './view.js';

/** What initialView builds a view from. */
export interface InitialViewInput {
  /** The player's party, lead first: 1 to 6 Pokémon, the lead with HP left. */
  player: PlayerMon[];
  /** A single-battle trainer; its lead is its first Pokémon. */
  trainer: ResolvedTrainer;
  /**
   * The candidate world (worldsFor): the nature and ability of each disputed trainer Pokémon, by party index. Required,
   * though it may be `{ enemy: [] }` for a trainer with nothing disputed: a disputed value is never assumed.
   */
  world: WorldAssignment;
  /** Each set field overrides the trainer's field note (`trainer.field`); an unset one takes the note's. */
  weather?: 'rain' | 'sun' | 'sand' | 'hail'; fog?: boolean; trickRoom?: boolean; gravity?: boolean;
}

/** MAX_PARTY_SIZE (constants/pokemon.h). */
const MAX_PARTY_SIZE = 6;
/** BattleContext_Init: every battler's aiSwitchedPartySlot is 6, "none" (battle_lib.c:2015). */
const NO_SWITCH = 6;
/** BattleContext_Init's powerMul (battle_lib.c:1980). */
const DEFAULT_POWER_MUL = 10;
/** MoveTable_CalcMaxPP clamps the PP Ups to 3 (move_table.c:26–28). */
const MAX_PP_UPS = 3;

/** The _PERM bit each overworld weather's battle-start subscript sets (subscript_overworld_<weather>.s:11). */
const WEATHER_PERM: Readonly<Record<NonNullable<InitialViewInput['weather']>, number>> = {
  rain: FIELD_CONDITION_RAINING_PERM, sun: FIELD_CONDITION_SUNNY_PERM, sand: FIELD_CONDITION_SANDSTORM_PERM, hail: FIELD_CONDITION_HAILING_PERM,
};

/**
 * The trainer AI's view at its first decision: turn 1 (totalTurns 0), the player's first Pokémon in battler slot 0 and
 * the trainer's in slot 1, slots 2 and 3 empty (EMPTY_MON), the field from the trainer's field note (or `input`'s
 * overrides), after the leads' switch-in effects (applySwitchIns). `world` gives each disputed trainer nature and
 * ability. `data` gives the ROM species and moves, and the engine's dex; `ai` the Pokédex weights and the item records
 * the switch-in effects and the battle-start speed comparison read. `unknown` lists nothing (the note's fog is a bit: fieldOf). Friendship is
 * BattleMon.friendship, exact.
 *
 * Throws AiError('UNSUPPORTED') for a double battle; AiError('UNDEFINED') for a disputed nature or ability `world` leaves
 * unset, or a switch-in effect the engine can't give exactly (switchIn.ts SWITCH_IN_REFUSALS); AiError('BAD_VIEW') for
 * what the cartridge couldn't hold (an empty or oversized party, a fainted lead, five moves, a move, item or ROM trainer
 * `data` lacks, a species `ai`'s Pokédex weights lack).
 */
export function initialView(input: InitialViewInput, data: LoadedData, ai: AiRomData): AiView {
  return initialDecision(input, data, ai).view;
}

/**
 * initialView's view, and the AI's knowledge at that first decision: AIContext cleared (battle_controller_player.c:4799)
 * and then what the switch-in effects' messages tell it, from model.ts battleStartMemory, the fold the EnemyModel's
 * initialMemory uses too, so both know the same. decide takes both. `steps` names the switch-in steps that fired (switchIn.ts FiredStep); with none, the view is initialLoad's.
 */
export function initialDecision(
  input: InitialViewInput, data: LoadedData, ai: AiRomData,
): { view: AiView; knowledge: AiKnowledge; steps: string[] } {
  const { view, deps, battle } = load(input, data, ai);
  const after = applySwitchIns(battle, view, deps, data, ai);
  return { view: { ...after.view, monSpeedValues: battleStartSpeeds(after.view, deps) }, knowledge: after.knowledge, steps: after.steps };
}

/**
 * The view as BattleSystem_InitBattleMon loads the leads, with the field note's conditions and the battle-start speed
 * comparison, before any other switch-in effect: initialView's view when no switch-in step fires (the sweep checks it).
 * Throws as initialView does before the engine runs. No engine.
 */
export function initialLoad(input: InitialViewInput, data: LoadedData, ai: AiRomData): AiView {
  const { view, deps } = load(input, data, ai);
  return { ...view, monSpeedValues: battleStartSpeeds(view, deps) };
}

/** The loaded view (its monSpeedValues placeholders), the AiDeps its speed comparison reads, and the engine's battle start. */
function load(input: InitialViewInput, data: LoadedData, ai: AiRomData): { view: AiView; deps: AiDeps; battle: BattleInput } {
  const { player, trainer, world } = input;
  if (trainer.battleType !== 'single') throw new AiError('UNSUPPORTED', `${trainerLabel(trainer)} is a double battle; the AI runs singles only`);
  checkPartySize(player.length, 'the player');
  checkPartySize(trainer.party.length, trainerLabel(trainer));
  const where = (index: number) => `${trainerLabel(trainer)} party index ${index}`;

  const playerMons = player.map((mon, index) => playerBattleMon(mon, data, ai, `the player's party index ${index}`));
  const enemyMons = trainer.party.map((mon, index) => enemyBattleMon(
    mon, worldValue(mon.nature, world.enemy[index]?.nature, where(index), 'nature'),
    worldValue(mon.ability, world.enemy[index]?.ability, where(index), 'ability'), data, ai, where(index),
  ));
  const playerLead = playerMons[0]!;
  const enemyLead = enemyMons[0]!;
  if (playerLead.curHP <= 0) throw new AiError('BAD_VIEW', `the player's lead has ${playerLead.curHP} HP: a fainted Pokémon can't lead`);
  const field = fieldOf(input);
  const bag = romTrainerOf(trainer, data).items.filter((item) => item !== ITEM_NONE);

  const view: AiView = {
    // A trainer's single battle: BATTLE_TYPE_TRAINER, no BATTLE_TYPE_DOUBLES (constants/battle.h:24–56).
    battleType: BATTLE_TYPE_TRAINER_SINGLES,
    // InitBattleMons loads battler 0 (the player) and battler 1 (the trainer) only, as singles have 2 battlers; slots 2
    // and 3 keep the cleared context (battle_controller_player.c:182, 223–228).
    mons: [playerLead, enemyLead, EMPTY_MON, EMPTY_MON],
    // Party data as Pokemon_GetValue reads it, the same values InitBattleMon copies (battle_lib.c:70–166).
    parties: [playerMons.map(partyMonOf), enemyMons.map(partyMonOf)],
    // Each lead is its side's party slot 0: the player's list is lead first, and a trainer leads with its first Pokémon.
    // Slots 2 and 3 are never written in singles (cleared, battle_controller_player.c:182).
    selectedPartySlot: [0, 0, 0, 0],
    aiSwitchedPartySlot: [NO_SWITCH, NO_SWITCH, NO_SWITCH, NO_SWITCH], // battle_lib.c:2015
    // Cleared at :182 and first raised at the end of turn 1 (battle_controller_player.c:1852).
    totalTurns: 0,
    fieldConditionsMask: field.mask,
    // Cleared (:182); BattleContext_Init only clears bits (battle_lib.c:2009), and none the AI reads is set before it runs.
    battleStatusMask: 0,
    powerMul: DEFAULT_POWER_MUL, // battle_lib.c:1980
    // Cleared (:182): no Roost or Helping Hand before the first move.
    turnFlags: [0, 1, 2, 3].map(() => ({ roosting: false, helpingHand: false })),
    // Cleared (:182): no screens, hazards or other side conditions at battle start.
    sideConditionsMask: [0, 0],
    sideConditions: [{ spikesLayers: 0, toxicSpikesLayers: 0 }, { spikesLayers: 0, toxicSpikesLayers: 0 }],
    // Cleared (:182): no move has run, hit or protected yet, and no item has been used.
    movePrevByBattler: [MOVE_NONE, MOVE_NONE, MOVE_NONE, MOVE_NONE],
    moveHit: [MOVE_NONE, MOVE_NONE, MOVE_NONE, MOVE_NONE],
    moveHitBattler: [BATTLER_NONE, BATTLER_NONE, BATTLER_NONE, BATTLER_NONE], // battle_lib.c:2022
    moveProtect: [MOVE_NONE, MOVE_NONE, MOVE_NONE, MOVE_NONE],
    recycleItem: [ITEM_NONE, ITEM_NONE, ITEM_NONE, ITEM_NONE],
    // Singles mark the two empty slots as switching (battle_lib.c:2031–2033).
    battlersSwitchingMask: (1 << BATTLER_PLAYER_2) | (1 << BATTLER_ENEMY_2),
    // Filled in below from the finished view (battleStartSpeeds).
    monSpeedValues: [0, 0, 0, 0],
    // This turn's Quick Claw is a latent the AI marginalises at its prior.
    quickClawThisTurn: [null, null, null, null],
    // BattleControllerPlayer_InitAI copies the trainer's non-empty item slots in order and counts them
    // (battle_controller_player.c:4801–4813): RomTrainer.items with any empty slot dropped.
    trainerItems: bag,
    trainerItemCount: bag.length,
    // No gaps: the field's fog is exact (fieldOf).
    unknown: field.unknown,
  };
  // The switch-in effects and the speed comparison read only the item records; the rest of AiDeps is there for its type.
  const deps: AiDeps = {
    script: aiScriptOf(ai), moves: data.rom.moves, species: data.rom.species, items: ai.items, typeChart: ai.typeChart, aiFlags: 0,
  };
  // The engine's battle start: the two leads (no switch-in effect reads a bench Pokémon), the world's values for the
  // trainer's lead and the field note, exactly as BattleInput takes them.
  const battle: BattleInput = {
    player: [player[0]!], trainer: { ...trainer, party: [trainer.party[0]!] }, field: field.spec, world: { enemy: [world.enemy[0] ?? {}] },
  };
  return { view, deps, battle };
}

/**
 * Every candidate world of `trainer`'s disputed natures and abilities: one per combination of their candidates, each
 * field's candidates being its value (when it has one) and then its alternatives. The fields go in party order, nature
 * before ability, and the earlier field varies slowest, so the first world takes every value as the planner resolved
 * it. Each world has one entry per party index, holding only that Pokémon's disputed fields. A trainer with nothing
 * disputed has the one empty world. Throws AiError('UNDEFINED') for a disputed field with no candidate.
 */
export function worldsFor(trainer: ResolvedTrainer): WorldAssignment[] {
  let worlds: WorldAssignment[] = [{ enemy: trainer.party.map(() => ({})) }];
  trainer.party.forEach((mon, index) => {
    for (const field of ['nature', 'ability'] as const) {
      const sourced: Sourced<number | null> = mon[field];
      if (!needsWorld(sourced)) continue;
      const candidates = [...new Set([...(sourced.value === null ? [] : [sourced.value]), ...sourced.alternatives])];
      if (candidates.length === 0) {
        throw new AiError('UNDEFINED', `${trainerLabel(trainer)} party index ${index}: its ${field} is disputed with no candidate`);
      }
      worlds = worlds.flatMap((world) => candidates.map((value) => ({
        enemy: world.enemy.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)),
      })));
    }
  });
  return worlds;
}

/**
 * The AI's ROM data for `trainer`: its ROM trainer's whole AI mask (trainer_ai.c:249 reads header.aiMask, so bits past
 * the named flags count too), the script, the item records and type chart from `ai`, the moves and species from
 * `data`. Throws AiError('BAD_VIEW') when `data` has no ROM trainer `trainer.romIndex`, when that trainer's mask doesn't
 * give `trainer.aiFlags`, or when `data` lacks species record 0 (pl_personal 0), which LoadBattlerAbility and
 * CheckBattlerAbility read for an empty battler slot (trainer_ai.c:1191–1192, 1236–1237).
 */
export function depsFor(trainer: ResolvedTrainer, data: LoadedData, ai: AiRomData): AiDeps {
  const rom = romTrainerOf(trainer, data);
  const named = AI_FLAG_NAMES.filter((_, bit) => (rom.aiMask >>> bit) & 1);
  if (named.join() !== trainer.aiFlags.join()) {
    throw new AiError('BAD_VIEW', `${trainerLabel(trainer)}: ROM mask ${rom.aiMask} names [${named.join(', ')}], not [${trainer.aiFlags.join(', ')}]`);
  }
  if (data.rom.species[0] === undefined) {
    throw new AiError('BAD_VIEW', 'the data has no species record 0, which the AI reads for an empty battler slot (trainer_ai.c:1191, 1236)');
  }
  return {
    script: aiScriptOf(ai), moves: data.rom.moves, species: data.rom.species, items: ai.items, typeChart: ai.typeChart,
    aiFlags: rom.aiMask >>> 0,
  };
}

/** "<id> [ROM <index>]", naming a trainer in errors. */
function trainerLabel(trainer: ResolvedTrainer): string {
  return `${trainer.id} [ROM ${trainer.romIndex}]`;
}

function checkPartySize(size: number, side: string): void {
  if (size < 1 || size > MAX_PARTY_SIZE) throw new AiError('BAD_VIEW', `${side} has ${size} Pokémon, not 1 to ${MAX_PARTY_SIZE}`);
}

/** The ROM trainer `trainer` was resolved from. `RomData.trainers` is indexed by trainer index, but a list need not be. */
function romTrainerOf(trainer: ResolvedTrainer, data: LoadedData): RomTrainer {
  const { trainers } = data.rom;
  const found = trainers[trainer.romIndex]?.index === trainer.romIndex ? trainers[trainer.romIndex] : trainers.find((t) => t?.index === trainer.romIndex);
  if (found === undefined) throw new AiError('BAD_VIEW', `the data has no ROM trainer ${trainer.romIndex} (${trainer.id})`);
  return found;
}

/** Whether a field takes its value from the world: it is disputed, or no source gives one. */
function needsWorld(sourced: Sourced<number | null>): boolean {
  return sourced.disputed || sourced.value === null;
}

/** The world's value for a trainer Pokémon's field, else its own when undisputed; AiError('UNDEFINED') otherwise. */
function worldValue(sourced: Sourced<number | null>, fromWorld: number | undefined, where: string, field: 'nature' | 'ability'): number {
  if (fromWorld !== undefined) return fromWorld;
  if (sourced.disputed || sourced.value === null) {
    const candidates = [sourced.value, ...sourced.alternatives].filter((value) => value !== null).join(', ');
    throw new AiError('UNDEFINED', `${where}: its ${field} is disputed (${candidates || 'no candidate'}) and the world sets none`);
  }
  return sourced.value;
}

/**
 * fieldConditionsMask from the field (the note's, `input`'s fields overriding it), as the switch-in check's overworld
 * weather step sets it (battle_lib.c:3662–3707):
 * - weather: its _PERM bit (subscript_overworld_rain.s, _sun.s, _sand.s, _hail.s, each at line 11);
 * - Trick Room: FIELD_CONDITION_TRICK_ROOM_INIT (subscript_overworld_trick_room.s:14);
 * - Gravity: FIELD_CONDITION_GRAVITY_INIT, the move's starting counter (subscript_gravity_start.s:9). The AI only
 *   tests Trick Room's and Gravity's bits for non-zero (lib/speed.ts, lib/typeChart.ts, lib/battler.ts,
 *   lib/invalidMoves.ts), so any running counter reads the same;
 * - deep fog: FIELD_CONDITION_DEEP_FOG (subscript_overworld_fog.s:11). The same step is the battle's first, so the bit is the
 *   note's exactly; a lead's weather ability clears it with the weather bits (applySwitchIns), and nothing before the first
 *   decision can blow it away (Defog and the weather moves come later: memory.ts `fog`). Spot check 20.
 * `spec` is the same field as BattleInput.field takes it, for the engine (which applies it at battle start).
 */
function fieldOf(input: InitialViewInput): { mask: number; unknown: string[]; spec: FieldSpec } {
  const note = input.trainer.field;
  const weather = input.weather ?? note?.weather;
  const fog = input.fog ?? note?.fog ?? false;
  const trickRoom = input.trickRoom ?? note?.trickRoom ?? false;
  const gravity = input.gravity ?? note?.gravity ?? false;
  let mask = 0;
  if (weather !== undefined) mask |= WEATHER_PERM[weather];
  if (fog) mask |= FIELD_CONDITION_DEEP_FOG;
  if (trickRoom) mask |= FIELD_CONDITION_TRICK_ROOM_INIT;
  if (gravity) mask |= FIELD_CONDITION_GRAVITY_INIT;
  const spec: FieldSpec = {
    ...(weather !== undefined && { weather }), ...(fog && { fog }), ...(trickRoom && { trickRoom }), ...(gravity && { gravity }),
  };
  return { mask, unknown: [], spec };
}

/**
 * MON_CONDITION_* from a save status. Sleep keeps its counter (bits 0–2). Toxic has no counter: the party data never
 * holds one, as the battle strips it when it writes a battler back (battle_controller.c:1482).
 */
function statusOf(status: StartStatus, where: string): number {
  switch (status.kind) {
    case 'none': return MON_CONDITION_NONE;
    case 'sleep':
      if (!(Number.isInteger(status.turns) && status.turns >= 1 && status.turns <= MON_CONDITION_SLEEP)) {
        throw new AiError('BAD_VIEW', `${where}: a sleep counter of ${status.turns} doesn't fit MON_CONDITION_SLEEP`);
      }
      return status.turns;
    case 'poison': return MON_CONDITION_POISON;
    case 'toxic': return MON_CONDITION_TOXIC;
    case 'burn': return MON_CONDITION_BURN;
    case 'freeze': return MON_CONDITION_FREEZE;
    case 'paralysis': return MON_CONDITION_PARALYSIS;
  }
}

/** Pokemon_GetGender's GENDER_* from the planner's 'M', 'F' or null (genderless). */
function genderOf(gender: BattleMon['gender']): number {
  if (gender === 'M') return GENDER_MALE;
  return gender === 'F' ? GENDER_FEMALE : GENDER_NONE;
}

/**
 * BattleMon.weight in hectograms: the ROM's Pokédex weight of the species ID (battle_lib.c:145–150), from the table
 * Pokedex_SetupGiratina picks by the battler's form (pokedex_data_index.c:14–25; src/rom/weights.ts): `ai.weights` for
 * form 0, `ai.formWeights` for any other. The party data gives the form exactly, so the weight is exact.
 */
function weightOf(ai: AiRomData, species: number, form: number, where: string): number {
  const weight = (form === 0 ? ai.weights : ai.formWeights)[species];
  if (weight === undefined) throw new AiError('BAD_VIEW', `${where}: the ROM's Pokédex has no weight for species ${species}`);
  return weight;
}

/** MoveTable_CalcMaxPP: base PP + base PP × 20 × PP Ups / 100, in C integers, as a u8 (move_table.c:25–33). */
function maxPp(basePp: number, ppUps: number): number {
  const ups = Math.min(ppUps, MAX_PP_UPS);
  return u8(basePp + Math.trunc((basePp * 20 * ups) / 100));
}

/** What differs between the sides when a Pokémon is loaded. */
interface LoadFields { nature: number; ability: number; curHP: number | null; status: number; pp: readonly number[] | null; ppUps: readonly number[] }

/**
 * A Pokémon as BattleSystem_InitBattleMon loads it (battle_lib.c:70–166): its stats from computeStats with `nature`,
 * neutral stat stages (:97–101), no volatile status or move effects (cleared, battle_controller_player.c:182), and the
 * moves with their PP and maximum PP. `curHP` null is full HP, and is clamped to the maximum otherwise, as the engine
 * does (engine/sets.ts setStartHp); `pp` null is full PP, and a slot's PP is clamped to its maximum.
 */
function loadMon(mon: BattleMon, fields: LoadFields, data: LoadedData, ai: AiRomData, where: string): AiBattleMon {
  if (mon.moves.length > LEARNED_MOVES_MAX) throw new AiError('BAD_VIEW', `${where} has ${mon.moves.length} moves`);
  const stats = computeStats(mon.baseStats, mon.ivs, mon.evs, mon.level, fields.nature);
  const moves: number[] = [];
  const ppCur: number[] = [];
  const ppMax: number[] = [];
  for (let slot = 0; slot < LEARNED_MOVES_MAX; slot++) {
    const move = mon.moves[slot] ?? MOVE_NONE;
    if (move === MOVE_NONE) {
      moves.push(MOVE_NONE);
      ppCur.push(0);
      ppMax.push(0);
      continue;
    }
    const record = data.rom.moves[move];
    if (record === undefined) throw new AiError('BAD_VIEW', `${where}: the data has no move ${move}`);
    const max = maxPp(record.pp, fields.ppUps[slot] ?? 0);
    const pp = fields.pp === null ? max : fields.pp[slot];
    if (pp === undefined) throw new AiError('BAD_VIEW', `${where}: no PP for move slot ${slot}`);
    moves.push(move);
    ppCur.push(Math.max(0, Math.min(max, pp)));
    ppMax.push(max);
  }
  return {
    species: mon.species,
    form: mon.form, // MON_DATA_FORM (:132)
    level: mon.level, // :135
    gender: genderOf(mon.gender), // Pokemon_GetGender (:116)
    types: [mon.types[0], mon.types[1]], // MON_DATA_TYPE_1/2: the form's Personal row (:114–115)
    ability: fields.ability, // MON_DATA_ABILITY (:124)
    heldItem: mon.item, // MON_DATA_HELD_ITEM (:126); no item is knocked off yet (:161)
    weight: weightOf(ai, mon.species, mon.form, where), // :145–150
    // MON_DATA_FRIENDSHIP (:136), exact: BattleMon.friendship is the save's for the player's Pokémon (PK4
    // block A +0x0C) and the species' base friendship for a trainer's (Pokemon_InitWith, pokemon.c:435–436).
    friendship: mon.friendship,
    ivs: { ...mon.ivs }, // :88–93
    curHP: fields.curHP === null ? stats.hp : Math.min(stats.hp, fields.curHP), // :137
    maxHP: stats.hp, // :138
    attack: stats.atk, defense: stats.def, spAttack: stats.spa, spDefense: stats.spd, speed: stats.spe, // :75–79
    statBoosts: Array.from({ length: BATTLE_STAT_MAX }, () => DEFAULT_STAT_STAGE), // :97–101
    moves, ppCur, ppMax, // :82–86
    status: fields.status, // :125
    statusVolatile: 0,
    moveEffectsMask: 0,
    // Cleared (battle_controller_player.c:182), and a lead never gets UpdateAfterSwitch's turn numbers
    // (battle_lib.c:2117–2118), so fakeOutTurnNumber and slowStartTurnNumber are 0. canUnburden is set for a Pokémon
    // that comes in holding an item (:164–166).
    effects: { ...EMPTY_MON.effects, canUnburden: mon.item !== ITEM_NONE },
  };
}

/** A player Pokémon: the save's nature, ability, HP, status and PP (with its PP Ups). */
function playerBattleMon(mon: PlayerMon, data: LoadedData, ai: AiRomData, where: string): AiBattleMon {
  if (mon.nature.value === null) throw new AiError('BAD_VIEW', `${where} has no nature`);
  return loadMon(mon, {
    nature: mon.nature.value, ability: mon.ability.value, curHP: mon.currentHp, status: statusOf(mon.status, where), pp: mon.pp,
    ppUps: mon.ppUps,
  }, data, ai, where);
}

/**
 * A trainer Pokémon: `nature` and `ability` as the world resolved them, full HP, no status, and full PP without PP Ups,
 * as Pokemon_SetMoveSlot gives each trainer move (trainer_data.c:244, 301; pokemon.c:3925–3932).
 */
function enemyBattleMon(mon: ResolvedMon, nature: number, ability: number, data: LoadedData, ai: AiRomData, where: string): AiBattleMon {
  return loadMon(mon, { nature, ability, curHP: null, status: MON_CONDITION_NONE, pp: null, ppUps: [] }, data, ai, where);
}

/** The party data of a loaded Pokémon: the values InitBattleMon copied from it. */
function partyMonOf(mon: AiBattleMon): AiPartyMon {
  return {
    species: mon.species, form: mon.form, level: mon.level, hp: mon.curHP, maxHp: mon.maxHP, status: mon.status,
    moves: [...mon.moves], pp: [...mon.ppCur], ppMax: [...mon.ppMax], heldItem: mon.heldItem, ability: mon.ability,
    types: [mon.types[0], mon.types[1]], ivs: { ...mon.ivs },
  };
}

/**
 * monSpeedValues as the AI's first decision finds them: what the last BattleSystem_CompareBattlerSpeed before it wrote
 * (battle_lib.c:1372–1373). That is BattleSystem_SortMonSpeedOrder at the end of the switch-in effects
 * (battle_controller_player.c:263), which in singles compares battlers 0 and 1 once, with ignoreQuickClaw TRUE
 * (battle_lib.c:3364–3384). Both leads have HP, so the comparison writes; the speeds it writes depend on no draw, so the
 * port (compareSpeed) takes each draw's first option. Slots 2 and 3 are never compared: 0 (cleared,
 * battle_controller_player.c:182). `view` is the view after the switch-in effects, whose field, stat stages, statuses,
 * items and abilities the comparison reads.
 */
function battleStartSpeeds(view: AiView, deps: AiDeps): number[] {
  const latents: Latents = { rolls: [null, null, null, null], quickClaw: [null, null, null, null] };
  const { speeds } = compareSpeed(view, deps, latents, PLAYER_BATTLER, AI_BATTLER, () => 0);
  if (speeds === null) throw new AiError('BAD_VIEW', 'compareSpeed wrote no speeds for two leads with HP');
  return [speeds[0], speeds[1], 0, 0];
}
