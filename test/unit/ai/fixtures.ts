// Vanilla Gen 4 data and a turn-1 battle for the trainer AI's unit tests, typed in by hand from the decompilation
// (pret/pokeplatinum 62bdaacdc: res/moves, res/pokemon, res/items). Stats are level 50, 0 EVs, neutral nature; the
// AI's IVs are 30 (trainer_data.c:214, ivScale 250).

import type { AiItemRecord } from '../../../src/ai/rom/items.js';
import type { AiScript } from '../../../src/ai/rom/script.js';
import type { TypeChart } from '../../../src/ai/rom/typeChart.js';
import { scriptId } from '../../../src/ai/script/disasm.js';
import { OP } from '../../../src/ai/script/opcodes.js';
import {
  AI_FLAG_BASIC, BATTLE_TYPE_TRAINER_SINGLES, BATTLER_ENEMY_2, BATTLER_NONE, BATTLER_PLAYER_2, ITEM_FULL_RESTORE,
  TYPE_BUG, TYPE_DARK, TYPE_DRAGON, TYPE_ELECTRIC, TYPE_FIGHTING, TYPE_FIRE, TYPE_FLYING, TYPE_GHOST, TYPE_GRASS,
  TYPE_GROUND, TYPE_ICE, TYPE_MULTI_IMMUNE, TYPE_MULTI_NOT_VERY_EFF, TYPE_MULTI_SUPER_EFF, TYPE_NORMAL, TYPE_POISON,
  TYPE_PSYCHIC, TYPE_ROCK, TYPE_STEEL, TYPE_WATER,
} from '../../../src/ai/constants.js';
import { type AiBattleMon, type AiDeps, type AiKnowledge, type AiPartyMon, type AiView, EMPTY_MON } from '../../../src/ai/view.js';
import type { MoveCategory, MoveRecord, SpeciesRecord, Stats } from '../../../src/rom/types.js';

/** A partial of T whose arrays (and tuples) are whole: `fixtureView` replaces arrays instead of merging them. */
export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** The IDs of the fixture's records, for tests that patch them in. */
export const FX = {
  move: {
    TACKLE: 33, WATER_GUN: 55, HYPER_BEAM: 63, SEISMIC_TOSS: 69, DRAGON_RAGE: 82, EARTHQUAKE: 89, WATERFALL: 127,
    PSYWAVE: 149, PROTECT: 182, SLUDGE_BOMB: 188, SPARK: 209, MAGNITUDE: 222, HIDDEN_POWER: 237, CRUNCH: 242,
    SHADOW_BALL: 247, WEATHER_BALL: 311, DRAGON_CLAW: 337, DRAGON_DANCE: 349, ENERGY_BALL: 412, THUNDER_FANG: 422,
    ICE_FANG: 423, FIRE_FANG: 424,
  },
  species: { GYARADOS: 130, LUXRAY: 405, ROSERADE: 407, GARCHOMP: 445 },
  item: {
    POTION: 17, ANTIDOTE: 18, BURN_HEAL: 19, ICE_HEAL: 20, AWAKENING: 21, PARLYZ_HEAL: 22, FULL_RESTORE: 23,
    HYPER_POTION: 25, FULL_HEAL: 27, GUARD_SPEC: 55, DIRE_HIT: 56, X_ATTACK: 57, X_DEFENSE: 58, X_SPEED: 59,
    X_ACCURACY: 60, X_SPECIAL: 61, X_SP_DEF: 62, PERSIM_BERRY: 156, SITRUS_BERRY: 158, QUICK_CLAW: 217, LEFTOVERS: 234,
  },
  ability: { SAND_VEIL: 8, INTIMIDATE: 22, NATURAL_CURE: 30, POISON_POINT: 38, RIVALRY: 79 },
} as const;

const M = FX.move;
const S = FX.species;
const I = FX.item;
const A = FX.ability;

// MoveData.flags (generated/move_flags.txt, a metang mask: line n is bit n − 1) and ranges (generated/move_ranges.txt).
const CONTACT = 1 << 0;
const PROTECT = 1 << 1;
const SNATCH = 1 << 3;
const MIRROR_MOVE = 1 << 4;
const KINGS_ROCK = 1 << 5;
const HIDES_HP_GAUGES = 1 << 6;
const HIDES_SHADOWS = 1 << 7;
const RANGE_SINGLE_TARGET = 0;
const RANGE_ALL_ADJACENT = 1 << 3;
const RANGE_USER = 1 << 4;

function move(
  id: number, category: MoveCategory, type: number, power: number, accuracy: number, pp: number, effect: number,
  effectChance: number, target: number, priority: number, flags: number,
): MoveRecord {
  return { id, effect, category, power, type, accuracy, pp, effectChance, target, priority, flags };
}

/** Vanilla move records. The effect is the line − 1 of its BATTLE_EFFECT_* in generated/move_battle_effects.txt. */
function moves(): MoveRecord[] {
  const records = [
    // none.json: MOVE_DATA(MOVE_NONE), which TrainerAI_CalcAllDamage reads for an empty slot (trainer_ai.c:2811, 2820).
    move(0, 'physical', TYPE_NORMAL, 0, 0, 0, 0, 0, RANGE_SINGLE_TARGET, 0, 0),
    move(M.TACKLE, 'physical', TYPE_NORMAL, 35, 95, 35, 0, 0, RANGE_SINGLE_TARGET, 0, CONTACT | PROTECT | MIRROR_MOVE | KINGS_ROCK | HIDES_HP_GAUGES),
    move(M.WATER_GUN, 'special', TYPE_WATER, 40, 100, 25, 0, 0, RANGE_SINGLE_TARGET, 0, PROTECT | MIRROR_MOVE | KINGS_ROCK),
    move(M.HYPER_BEAM, 'special', TYPE_NORMAL, 150, 90, 5, 80, 0, RANGE_SINGLE_TARGET, 0, PROTECT | MIRROR_MOVE | KINGS_ROCK | HIDES_SHADOWS),
    move(M.SEISMIC_TOSS, 'physical', TYPE_FIGHTING, 1, 100, 20, 87, 0, RANGE_SINGLE_TARGET, 0, CONTACT | PROTECT | MIRROR_MOVE | KINGS_ROCK | HIDES_SHADOWS),
    move(M.DRAGON_RAGE, 'special', TYPE_DRAGON, 1, 100, 10, 41, 0, RANGE_SINGLE_TARGET, 0, PROTECT | MIRROR_MOVE | KINGS_ROCK),
    move(M.EARTHQUAKE, 'physical', TYPE_GROUND, 100, 100, 10, 147, 0, RANGE_ALL_ADJACENT, 0, PROTECT | MIRROR_MOVE | KINGS_ROCK),
    move(M.WATERFALL, 'physical', TYPE_WATER, 80, 100, 15, 31, 20, RANGE_SINGLE_TARGET, 0, CONTACT | PROTECT | MIRROR_MOVE | KINGS_ROCK | HIDES_SHADOWS),
    move(M.PSYWAVE, 'special', TYPE_PSYCHIC, 1, 80, 15, 88, 0, RANGE_SINGLE_TARGET, 0, PROTECT | MIRROR_MOVE | KINGS_ROCK),
    move(M.PROTECT, 'status', TYPE_NORMAL, 0, 0, 10, 111, 0, RANGE_USER, 3, 0),
    move(M.SLUDGE_BOMB, 'special', TYPE_POISON, 90, 100, 10, 2, 30, RANGE_SINGLE_TARGET, 0, PROTECT | MIRROR_MOVE),
    move(M.SPARK, 'physical', TYPE_ELECTRIC, 65, 100, 20, 6, 30, RANGE_SINGLE_TARGET, 0, CONTACT | PROTECT | MIRROR_MOVE),
    // Magnitude's effect is the one the decompilation calls BATTLE_EFFECT_PSYWAVE (126).
    move(M.MAGNITUDE, 'physical', TYPE_GROUND, 1, 100, 30, 126, 0, RANGE_ALL_ADJACENT, 0, PROTECT | MIRROR_MOVE | KINGS_ROCK),
    move(M.HIDDEN_POWER, 'special', TYPE_NORMAL, 1, 100, 15, 135, 0, RANGE_SINGLE_TARGET, 0, PROTECT | MIRROR_MOVE | KINGS_ROCK),
    move(M.CRUNCH, 'physical', TYPE_DARK, 80, 100, 15, 69, 20, RANGE_SINGLE_TARGET, 0, CONTACT | PROTECT | MIRROR_MOVE),
    move(M.SHADOW_BALL, 'special', TYPE_GHOST, 80, 100, 15, 72, 20, RANGE_SINGLE_TARGET, 0, PROTECT | MIRROR_MOVE),
    move(M.WEATHER_BALL, 'special', TYPE_NORMAL, 50, 100, 10, 203, 0, RANGE_SINGLE_TARGET, 0, PROTECT | MIRROR_MOVE | KINGS_ROCK),
    move(M.DRAGON_CLAW, 'physical', TYPE_DRAGON, 80, 100, 15, 0, 0, RANGE_SINGLE_TARGET, 0, CONTACT | PROTECT | MIRROR_MOVE | KINGS_ROCK),
    move(M.DRAGON_DANCE, 'status', TYPE_DRAGON, 0, 0, 20, 212, 0, RANGE_USER, 0, SNATCH),
    move(M.ENERGY_BALL, 'special', TYPE_GRASS, 80, 100, 10, 72, 10, RANGE_SINGLE_TARGET, 0, PROTECT | MIRROR_MOVE),
    move(M.THUNDER_FANG, 'physical', TYPE_ELECTRIC, 65, 95, 15, 275, 10, RANGE_SINGLE_TARGET, 0, CONTACT | PROTECT | MIRROR_MOVE | KINGS_ROCK),
    move(M.ICE_FANG, 'physical', TYPE_ICE, 65, 95, 15, 274, 10, RANGE_SINGLE_TARGET, 0, CONTACT | PROTECT | MIRROR_MOVE | KINGS_ROCK),
    move(M.FIRE_FANG, 'physical', TYPE_FIRE, 65, 95, 15, 273, 10, RANGE_SINGLE_TARGET, 0, CONTACT | PROTECT | MIRROR_MOVE | KINGS_ROCK),
  ];
  const table: MoveRecord[] = [];
  for (const record of records) table[record.id] = record;
  return table;
}

function stats(hp: number, atk: number, def: number, spa: number, spd: number, spe: number): Stats {
  return { hp, atk, def, spa, spd, spe };
}

/** Vanilla species records (genderRatio 127 is FEMALE_50; growth rates 3 and 5 are MEDIUM_SLOW and SLOW). */
function species(): SpeciesRecord[] {
  const records: SpeciesRecord[] = [
    // none.json: the record SpeciesData_GetSpeciesValue reads for an empty battler slot (trainer_ai.c:1191–1192, 1236–1237).
    { id: 0, baseStats: stats(0, 0, 0, 0, 0, 0), types: [TYPE_NORMAL, TYPE_NORMAL], genderRatio: 0, baseFriendship: 0, baseExp: 0, evYield: 0, growthRate: 0, abilities: [0, 0] },
    { id: S.GYARADOS, baseStats: stats(95, 125, 79, 60, 100, 81), types: [TYPE_WATER, TYPE_FLYING], genderRatio: 127, baseFriendship: 70, baseExp: 0, evYield: 0, growthRate: 5, abilities: [A.INTIMIDATE, 0] },
    { id: S.LUXRAY, baseStats: stats(80, 120, 79, 95, 79, 70), types: [TYPE_ELECTRIC, TYPE_ELECTRIC], genderRatio: 127, baseFriendship: 70, baseExp: 0, evYield: 0, growthRate: 3, abilities: [A.RIVALRY, A.INTIMIDATE] },
    { id: S.ROSERADE, baseStats: stats(60, 70, 55, 125, 105, 90), types: [TYPE_GRASS, TYPE_POISON], genderRatio: 127, baseFriendship: 70, baseExp: 0, evYield: 0, growthRate: 3, abilities: [A.NATURAL_CURE, A.POISON_POINT] },
    { id: S.GARCHOMP, baseStats: stats(108, 130, 95, 80, 85, 102), types: [TYPE_DRAGON, TYPE_GROUND], genderRatio: 127, baseFriendship: 70, baseExp: 0, evYield: 0, growthRate: 5, abilities: [A.SAND_VEIL, 0] },
  ];
  const table: SpeciesRecord[] = [];
  for (const record of records) table[record.id] = record;
  return table;
}

/** NUM_ITEMS (constants/items.h:84). */
const NUM_ITEMS = 467;
/** naturalGiftType for an item without one (itemproc.c:242). */
const NO_GIFT_TYPE = 0x1f;

function item(id: number, fields: Partial<AiItemRecord>): AiItemRecord {
  return {
    id, holdEffect: 0, holdParam: 0, flingPower: 0, naturalGiftPower: 0, naturalGiftType: NO_GIFT_TYPE, hpRestore: false,
    hpRestored: 0, healSleep: false, healPoison: false, healBurn: false, healFreeze: false, healParalysis: false,
    healConfusion: false, atkStages: 0, defStages: 0, spAtkStages: 0, spDefStages: 0, speedStages: 0, accStages: 0,
    guardSpec: false, ...fields,
  };
}

/** The item table by ID, null where absent. hpRestored is the u8 of the data's s8 (-1 → 255 full; itemproc.c:168, 184). */
function items(): (AiItemRecord | null)[] {
  const table: (AiItemRecord | null)[] = Array.from({ length: NUM_ITEMS + 1 }, () => null);
  const heals = { healSleep: true, healPoison: true, healBurn: true, healFreeze: true, healParalysis: true, healConfusion: true };
  for (const record of [
    item(0, { naturalGiftType: TYPE_NORMAL }), // none.json
    item(I.POTION, { holdParam: 20, flingPower: 30, hpRestore: true, hpRestored: 20 }),
    item(I.ANTIDOTE, { flingPower: 30, healPoison: true }),
    item(I.BURN_HEAL, { flingPower: 30, healBurn: true }),
    item(I.ICE_HEAL, { flingPower: 30, healFreeze: true }),
    item(I.AWAKENING, { flingPower: 30, healSleep: true }),
    item(I.PARLYZ_HEAL, { flingPower: 30, healParalysis: true }),
    item(I.FULL_RESTORE, { holdParam: 255, flingPower: 30, hpRestore: true, hpRestored: 255, ...heals }),
    item(I.HYPER_POTION, { holdParam: 200, flingPower: 30, hpRestore: true, hpRestored: 200 }),
    item(I.FULL_HEAL, { flingPower: 30, ...heals }),
    item(I.GUARD_SPEC, { flingPower: 30, guardSpec: true }),
    // Dire Hit's one use param is critStages, which the AI never reads: every param it reads is 0.
    item(I.DIRE_HIT, { flingPower: 30 }),
    item(I.X_ATTACK, { flingPower: 30, atkStages: 1 }),
    item(I.X_DEFENSE, { flingPower: 30, defStages: 1 }),
    item(I.X_SPEED, { flingPower: 30, speedStages: 1 }),
    item(I.X_ACCURACY, { flingPower: 30, accStages: 1 }),
    item(I.X_SPECIAL, { flingPower: 30, spAtkStages: 1 }),
    item(I.X_SP_DEF, { flingPower: 30, spDefStages: 1 }),
    // HOLD_EFFECT_CONFUSE_RESTORE (11); the only status it cures is confusion.
    item(I.PERSIM_BERRY, { holdEffect: 11, flingPower: 10, naturalGiftPower: 60, naturalGiftType: TYPE_GROUND, healConfusion: true }),
    // HOLD_EFFECT_HP_PCT_RESTORE (13).
    item(I.SITRUS_BERRY, { holdEffect: 13, holdParam: 25, flingPower: 10, naturalGiftPower: 60, naturalGiftType: TYPE_PSYCHIC, hpRestore: true, hpRestored: 253 }),
    // HOLD_EFFECT_SOMETIMES_PRIORITY (52).
    item(I.QUICK_CLAW, { holdEffect: 52, holdParam: 20, flingPower: 80 }),
    // HOLD_EFFECT_HP_RESTORE_GRADUAL (69).
    item(I.LEFTOVERS, { holdEffect: 69, holdParam: 10, flingPower: 10 }),
  ]) {
    table[record.id] = record;
  }
  return table;
}

/** sTypeMatchupMultipliers, battle_lib.c:2400–2515, without the 0xFF terminator (as TypeChart keeps it). */
function typeChart(): TypeChart {
  const NVE = TYPE_MULTI_NOT_VERY_EFF;
  const SE = TYPE_MULTI_SUPER_EFF;
  const IMMUNE = TYPE_MULTI_IMMUNE;
  return [
    [TYPE_NORMAL, TYPE_ROCK, NVE], [TYPE_NORMAL, TYPE_STEEL, NVE],
    [TYPE_FIRE, TYPE_FIRE, NVE], [TYPE_FIRE, TYPE_WATER, NVE], [TYPE_FIRE, TYPE_GRASS, SE], [TYPE_FIRE, TYPE_ICE, SE],
    [TYPE_FIRE, TYPE_BUG, SE], [TYPE_FIRE, TYPE_ROCK, NVE], [TYPE_FIRE, TYPE_DRAGON, NVE], [TYPE_FIRE, TYPE_STEEL, SE],
    [TYPE_WATER, TYPE_FIRE, SE], [TYPE_WATER, TYPE_WATER, NVE], [TYPE_WATER, TYPE_GRASS, NVE], [TYPE_WATER, TYPE_GROUND, SE],
    [TYPE_WATER, TYPE_ROCK, SE], [TYPE_WATER, TYPE_DRAGON, NVE],
    [TYPE_ELECTRIC, TYPE_WATER, SE], [TYPE_ELECTRIC, TYPE_ELECTRIC, NVE], [TYPE_ELECTRIC, TYPE_GRASS, NVE],
    [TYPE_ELECTRIC, TYPE_GROUND, IMMUNE], [TYPE_ELECTRIC, TYPE_FLYING, SE], [TYPE_ELECTRIC, TYPE_DRAGON, NVE],
    [TYPE_GRASS, TYPE_FIRE, NVE], [TYPE_GRASS, TYPE_WATER, SE], [TYPE_GRASS, TYPE_GRASS, NVE], [TYPE_GRASS, TYPE_POISON, NVE],
    [TYPE_GRASS, TYPE_GROUND, SE], [TYPE_GRASS, TYPE_FLYING, NVE], [TYPE_GRASS, TYPE_BUG, NVE], [TYPE_GRASS, TYPE_ROCK, SE],
    [TYPE_GRASS, TYPE_DRAGON, NVE], [TYPE_GRASS, TYPE_STEEL, NVE],
    [TYPE_ICE, TYPE_WATER, NVE], [TYPE_ICE, TYPE_GRASS, SE], [TYPE_ICE, TYPE_ICE, NVE], [TYPE_ICE, TYPE_GROUND, SE],
    [TYPE_ICE, TYPE_FLYING, SE], [TYPE_ICE, TYPE_DRAGON, SE], [TYPE_ICE, TYPE_STEEL, NVE], [TYPE_ICE, TYPE_FIRE, NVE],
    [TYPE_FIGHTING, TYPE_NORMAL, SE], [TYPE_FIGHTING, TYPE_ICE, SE], [TYPE_FIGHTING, TYPE_POISON, NVE],
    [TYPE_FIGHTING, TYPE_FLYING, NVE], [TYPE_FIGHTING, TYPE_PSYCHIC, NVE], [TYPE_FIGHTING, TYPE_BUG, NVE],
    [TYPE_FIGHTING, TYPE_ROCK, SE], [TYPE_FIGHTING, TYPE_DARK, SE], [TYPE_FIGHTING, TYPE_STEEL, SE],
    [TYPE_POISON, TYPE_GRASS, SE], [TYPE_POISON, TYPE_POISON, NVE], [TYPE_POISON, TYPE_GROUND, NVE],
    [TYPE_POISON, TYPE_ROCK, NVE], [TYPE_POISON, TYPE_GHOST, NVE], [TYPE_POISON, TYPE_STEEL, IMMUNE],
    [TYPE_GROUND, TYPE_FIRE, SE], [TYPE_GROUND, TYPE_ELECTRIC, SE], [TYPE_GROUND, TYPE_GRASS, NVE], [TYPE_GROUND, TYPE_POISON, SE],
    [TYPE_GROUND, TYPE_FLYING, IMMUNE], [TYPE_GROUND, TYPE_BUG, NVE], [TYPE_GROUND, TYPE_ROCK, SE], [TYPE_GROUND, TYPE_STEEL, SE],
    [TYPE_FLYING, TYPE_ELECTRIC, NVE], [TYPE_FLYING, TYPE_GRASS, SE], [TYPE_FLYING, TYPE_FIGHTING, SE],
    [TYPE_FLYING, TYPE_BUG, SE], [TYPE_FLYING, TYPE_ROCK, NVE], [TYPE_FLYING, TYPE_STEEL, NVE],
    [TYPE_PSYCHIC, TYPE_FIGHTING, SE], [TYPE_PSYCHIC, TYPE_POISON, SE], [TYPE_PSYCHIC, TYPE_PSYCHIC, NVE],
    [TYPE_PSYCHIC, TYPE_DARK, IMMUNE], [TYPE_PSYCHIC, TYPE_STEEL, NVE],
    [TYPE_BUG, TYPE_FIRE, NVE], [TYPE_BUG, TYPE_GRASS, SE], [TYPE_BUG, TYPE_FIGHTING, NVE], [TYPE_BUG, TYPE_POISON, NVE],
    [TYPE_BUG, TYPE_FLYING, NVE], [TYPE_BUG, TYPE_PSYCHIC, SE], [TYPE_BUG, TYPE_GHOST, NVE], [TYPE_BUG, TYPE_DARK, SE],
    [TYPE_BUG, TYPE_STEEL, NVE],
    [TYPE_ROCK, TYPE_FIRE, SE], [TYPE_ROCK, TYPE_ICE, SE], [TYPE_ROCK, TYPE_FIGHTING, NVE], [TYPE_ROCK, TYPE_GROUND, NVE],
    [TYPE_ROCK, TYPE_FLYING, SE], [TYPE_ROCK, TYPE_BUG, SE], [TYPE_ROCK, TYPE_STEEL, NVE],
    [TYPE_GHOST, TYPE_NORMAL, IMMUNE], [TYPE_GHOST, TYPE_PSYCHIC, SE], [TYPE_GHOST, TYPE_DARK, NVE],
    [TYPE_GHOST, TYPE_STEEL, NVE], [TYPE_GHOST, TYPE_GHOST, SE],
    [TYPE_DRAGON, TYPE_DRAGON, SE], [TYPE_DRAGON, TYPE_STEEL, NVE],
    [TYPE_DARK, TYPE_FIGHTING, NVE], [TYPE_DARK, TYPE_PSYCHIC, SE], [TYPE_DARK, TYPE_GHOST, SE], [TYPE_DARK, TYPE_DARK, NVE],
    [TYPE_DARK, TYPE_STEEL, NVE],
    [TYPE_STEEL, TYPE_FIRE, NVE], [TYPE_STEEL, TYPE_WATER, NVE], [TYPE_STEEL, TYPE_ELECTRIC, NVE], [TYPE_STEEL, TYPE_ICE, SE],
    [TYPE_STEEL, TYPE_ROCK, SE], [TYPE_STEEL, TYPE_STEEL, NVE],
    [0xfe, 0xfe, IMMUNE],
    // Foresight and Scrappy skip what follows the separator (battle_lib.c:2511–2514).
    [TYPE_NORMAL, TYPE_GHOST, IMMUNE], [TYPE_FIGHTING, TYPE_GHOST, IMMUNE],
  ];
}

/** A script whose every flag runs a lone PopOrEnd: no flag changes a score. */
function emptyScript(): AiScript {
  const script: AiScript = { words: Int32Array.of(OP.PopOrEnd), flagEntries: Array<number>(32).fill(0), sha256: '' };
  script.sha256 = scriptId(script);
  return script;
}

/** ROM data for the AI: the moves, species and items above, the vanilla type chart, and `script` run under `aiFlags`. */
export function fixtureDeps(script: AiScript = emptyScript(), aiFlags: number = AI_FLAG_BASIC): AiDeps {
  return { script, moves: moves(), species: species(), items: items(), typeChart: typeChart(), aiFlags };
}

const NEUTRAL_STAGES = [6, 6, 6, 6, 6, 6, 6, 6];

/** A Pokémon just sent out on turn 1: switch-in sets fakeOutTurnNumber and slowStartTurnNumber to totalTurns + 1 (battle_lib.c:2117–2118). */
function battleMon(fields: Omit<AiBattleMon, 'statBoosts' | 'status' | 'statusVolatile' | 'moveEffectsMask' | 'effects' | 'curHP' | 'form'>): AiBattleMon {
  return {
    ...fields, form: 0, curHP: fields.maxHP, statBoosts: [...NEUTRAL_STAGES], status: 0, statusVolatile: 0, moveEffectsMask: 0,
    effects: { ...structuredClone(EMPTY_MON.effects), fakeOutTurnNumber: 1, slowStartTurnNumber: 1 },
  };
}

function partyMonOf(mon: AiBattleMon): AiPartyMon {
  return {
    species: mon.species, form: mon.form, level: mon.level, hp: mon.curHP, maxHp: mon.maxHP, status: mon.status,
    moves: [...mon.moves], pp: [...mon.ppCur], ppMax: [...mon.ppMax], heldItem: mon.heldItem, ability: mon.ability,
    types: [...mon.types], ivs: { ...mon.ivs },
  };
}

const PLAYER_IVS = stats(31, 31, 31, 31, 31, 31);
const AI_IVS = stats(30, 30, 30, 30, 30, 30);

/** The player's lead: Luxray, Rivalry, holding a Sitrus Berry. Weight 42.0 kg (the Pokédex). */
function luxray(): AiBattleMon {
  return battleMon({
    species: S.LUXRAY, level: 50, gender: 0, types: [TYPE_ELECTRIC, TYPE_ELECTRIC], ability: A.RIVALRY,
    heldItem: I.SITRUS_BERRY, weight: 420, friendship: 70, ivs: { ...PLAYER_IVS },
    maxHP: 155, attack: 140, defense: 99, spAttack: 115, spDefense: 99, speed: 90,
    moves: [M.SPARK, M.CRUNCH, M.ICE_FANG, M.THUNDER_FANG], ppCur: [20, 15, 15, 15], ppMax: [20, 15, 15, 15],
  });
}

/** The AI's lead: Garchomp, Sand Veil, holding Leftovers. Weight 95.0 kg (the Pokédex). */
function garchomp(): AiBattleMon {
  return battleMon({
    species: S.GARCHOMP, level: 50, gender: 0, types: [TYPE_DRAGON, TYPE_GROUND], ability: A.SAND_VEIL,
    heldItem: I.LEFTOVERS, weight: 950, friendship: 70, ivs: { ...AI_IVS },
    maxHP: 183, attack: 150, defense: 115, spAttack: 100, spDefense: 105, speed: 122,
    moves: [M.DRAGON_CLAW, M.EARTHQUAKE, M.CRUNCH, M.FIRE_FANG], ppCur: [15, 10, 15, 15], ppMax: [15, 10, 15, 15],
  });
}

/** The AI's bench, level 50: Gyarados (Intimidate, no item) and Roserade (Natural Cure, Quick Claw). */
function aiBench(): AiPartyMon[] {
  return [
    {
      species: S.GYARADOS, form: 0, level: 50, hp: 170, maxHp: 170, status: 0,
      moves: [M.WATERFALL, M.ICE_FANG, M.DRAGON_DANCE, M.PROTECT], pp: [15, 15, 20, 10], ppMax: [15, 15, 20, 10],
      heldItem: 0, ability: A.INTIMIDATE, types: [TYPE_WATER, TYPE_FLYING], ivs: { ...AI_IVS },
    },
    {
      species: S.ROSERADE, form: 0, level: 50, hp: 135, maxHp: 135, status: 0,
      moves: [M.ENERGY_BALL, M.SLUDGE_BOMB, M.SHADOW_BALL, M.HIDDEN_POWER], pp: [10, 10, 15, 15], ppMax: [10, 10, 15, 15],
      heldItem: I.QUICK_CLAW, ability: A.NATURAL_CURE, types: [TYPE_GRASS, TYPE_POISON], ivs: { ...AI_IVS },
    },
  ];
}

function baseView(): AiView {
  const player = luxray();
  const ai = garchomp();
  return {
    battleType: BATTLE_TYPE_TRAINER_SINGLES,
    mons: [player, ai, structuredClone(EMPTY_MON), structuredClone(EMPTY_MON)],
    parties: [[partyMonOf(player)], [partyMonOf(ai), ...aiBench()]],
    selectedPartySlot: [0, 0, 0, 0],
    aiSwitchedPartySlot: [6, 6, 6, 6], // battle_lib.c:2015
    totalTurns: 0, // incremented at the end of each turn (battle_controller_player.c:1852), so turn 1 reads 0
    fieldConditionsMask: 0,
    battleStatusMask: 0,
    powerMul: 10, // BattleContext_Init (battle_lib.c:1980)
    turnFlags: Array.from({ length: 4 }, () => ({ roosting: false, helpingHand: false })) as AiView['turnFlags'],
    sideConditionsMask: [0, 0],
    sideConditions: [{ spikesLayers: 0, toxicSpikesLayers: 0 }, { spikesLayers: 0, toxicSpikesLayers: 0 }],
    movePrevByBattler: [0, 0, 0, 0],
    moveHit: [0, 0, 0, 0],
    moveHitBattler: [BATTLER_NONE, BATTLER_NONE, BATTLER_NONE, BATTLER_NONE], // battle_lib.c:2022
    moveProtect: [0, 0, 0, 0],
    recycleItem: [0, 0, 0, 0],
    battlersSwitchingMask: (1 << BATTLER_PLAYER_2) | (1 << BATTLER_ENEMY_2), // singles: battle_lib.c:2031–2033
    monSpeedValues: [player.speed, ai.speed, 0, 0], // as BattleSystem_CompareBattlerSpeed writes them (battle_lib.c:1372)
    quickClawThisTurn: [null, null, null, null],
    trainerItems: [ITEM_FULL_RESTORE, I.HYPER_POTION, 0, 0],
    trainerItemCount: 2,
    unknown: [], // every field above is given
  };
}

/**
 * A fresh turn-1 singles view: Luxray against Garchomp (Gyarados, Roserade benched; Full Restore and Hyper Potion in
 * the bag). `patch` is deep-merged, but arrays (and tuples) are replaced whole.
 */
export function fixtureView(patch: DeepPartial<AiView> = {}): AiView {
  return merge(baseView(), patch) as AiView;
}

function merge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return structuredClone(patch);
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = merge(base[key], value);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the AI knows at battle start: nothing (AIContext's battlerMoves, battlerAbilities, battlerHeldItems, ai_context.h). */
export function emptyKnowledge(): AiKnowledge {
  return {
    battlerMoves: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    battlerAbilities: [0, 0, 0, 0],
    battlerHeldItems: [0, 0, 0, 0],
  };
}
