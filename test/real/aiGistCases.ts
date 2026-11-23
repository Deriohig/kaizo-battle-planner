// The runner for the gist's scoring rules (lhearachel's "Generation 4 Pokemon Trainer AI" gist): each case runs one AI
// flag of the hack's real script, from the player's ROM, over a hand-built singles view, and compares one move slot's exact
// final score distribution (slotScores) with the rule's score change and its odds. This file covers every flag but
// Expert; the Expert tests reuse gistCase.
//
// The ROM data is read once, on first use, straight from PK_ROM: the hack's move records (their effect IDs are the
// hack's, which is what the script routes on), species, item records, type chart and AI script. A test file gates its
// suites with needFiles({ PK_ROM }) (env.ts).
//
// IDs are line − 1 of pret/pokeplatinum's generated/moves.txt, move_battle_effects.txt, abilities.txt and items.txt
// (62bdaacdc). The hack reuses many move IDs for new moves; a move keeps its vanilla constant name here, and where the
// hack renamed it (the docs' Moves tab), the comment gives the hack's name.

import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { slotScores } from '../../src/ai/choose/moves.js';
import { BATTLE_STAT, BATTLE_TYPE_TRAINER_SINGLES, BATTLER_ENEMY_2, BATTLER_NONE, BATTLER_PLAYER_2, GENDER_FEMALE, GENDER_MALE, TYPE_NORMAL } from '../../src/ai/constants.js';
import { AiError, type AiErrorCode } from '../../src/ai/errors.js';
import { compareSpeed } from '../../src/ai/lib/speed.js';
import { aiScriptOf, extractAiData } from '../../src/ai/rom/aiData.js';
import { type AiBattleMon, type AiDeps, type AiKnowledge, type AiMoveEffectsData, type AiPartyMon, type AiView, AI_BATTLER, EMPTY_MON, PLAYER_BATTLER } from '../../src/ai/view.js';
import { extractRomData } from '../../src/rom/extract.js';
import type { Stats } from '../../src/rom/types.js';
import { PK_ROM } from './env.js';

/** The moves the gist cases use (generated/moves.txt). */
export const M = {
  NONE: 0, POUND: 1, GUILLOTINE: 12, RAZOR_WIND: 13, SWORDS_DANCE: 14, WHIRLWIND: 18, MEGA_KICK: 25, SAND_ATTACK: 28, HORN_DRILL: 32,
  TACKLE: 33, TAKE_DOWN: 36, TAIL_WHIP: 39, LEER: 43, GROWL: 45, ROAR: 46, SUPERSONIC: 48, DISABLE: 50,
  FLAMETHROWER: 53, MIST: 54, HYDRO_PUMP: 56, SURF: 57, BLIZZARD: 59, HYPER_BEAM: 63, COUNTER: 68, SEISMIC_TOSS: 69,
  LEECH_SEED: 73, GROWTH: 74, POISON_POWDER: 77, STUN_SPORE: 78, STRING_SHOT: 81, DRAGON_RAGE: 82, THUNDERBOLT: 85,
  THUNDER_WAVE: 86, EARTHQUAKE: 89, FISSURE: 90, TOXIC: 92, HYPNOSIS: 95, AGILITY: 97, QUICK_ATTACK: 98, RAGE: 99,
  NIGHT_SHADE: 101, SCREECH: 103, DOUBLE_TEAM: 104, RECOVER: 105, HARDEN: 106, MINIMIZE: 107, CONFUSE_RAY: 109,
  BARRIER: 112, LIGHT_SCREEN: 113, HAZE: 114, REFLECT: 115, FOCUS_ENERGY: 116, BIDE: 117, METRONOME: 118,
  MIRROR_MOVE: 119, SELF_DESTRUCT: 120, AMNESIA: 133, KINESIS: 134, DREAM_EATER: 138, POISON_GAS: 139,
  PSYWAVE: 149, // "Triple Axel" in the hack
  EXPLOSION: 153, REST: 156,
  CONVERSION: 160, // "HP Ice" in the hack
  SUPER_FANG: 162, SLASH: 163, SUBSTITUTE: 164, TRIPLE_KICK: 167, MIND_READER: 170, COTTON_SPORE: 178, REVERSAL: 179,
  NIGHTMARE: 171, // "HP Ghost" in the hack
  SNORE: 173, CURSE: 174, FLAIL: 175, CONVERSION_2: 176, SPITE: 180, PROTECT: 182, SCARY_FACE: 184, BELLY_DRUM: 187, SPIKES: 191,
  FORESIGHT: 193, DESTINY_BOND: 194, DETECT: 197, PERISH_SONG: 195, LOCK_ON: 199, SANDSTORM: 201, ENDURE: 203, CHARM: 204,
  ROLLOUT: 205, SWAGGER: 207, FURY_CUTTER: 210, MEAN_LOOK: 212, ATTRACT: 213, SLEEP_TALK: 214, PRESENT: 217,
  SAFEGUARD: 219, PAIN_SPLIT: 220,
  MAGNITUDE: 222, // "Bulldoze" in the hack
  BATON_PASS: 226, ENCORE: 227, SWEET_SCENT: 230, MORNING_SUN: 234, HIDDEN_POWER: 237, RAIN_DANCE: 240, SUNNY_DAY: 241,
  MIRROR_COAT: 243, PSYCH_UP: 244, ANCIENT_POWER: 246, FUTURE_SIGHT: 248, WHIRLPOOL: 250, FAKE_OUT: 252,
  STOCKPILE: 254,
  SPIT_UP: 255, // "HP Rock" in the hack
  SWALLOW: 256, HAIL: 258, TORMENT: 259, FLATTER: 260, WILL_O_WISP: 261, MEMENTO: 262, FOCUS_PUNCH: 264,
  FOLLOW_ME: 266, NATURE_POWER: 267, HELPING_HAND: 270,
  TRICK: 271, // "HP Psychic" in the hack
  INGRAIN: 275, SUPERPOWER: 276, REVENGE: 279, BRICK_BREAK: 280, KNOCK_OFF: 282, SKILL_SWAP: 285, IMPRISON: 286,
  ERUPTION: 284, REFRESH: 287, GRUDGE: 288, SECRET_POWER: 290, CAMOUFLAGE: 293,
  MUD_SPORT: 300, // "HP Ground" in the hack
  HYPER_VOICE: 304, HYDRO_CANNON: 308, TICKLE: 321, COSMIC_POWER: 322, WATER_SPOUT: 323, HOWL: 336, BULK_UP: 339,
  WATER_SPORT: 346, // "Scald" in the hack
  CALM_MIND: 347, DRAGON_DANCE: 349, ROOST: 355, GRAVITY: 356, MIRACLE_EYE: 357, GYRO_BALL: 360,
  HEALING_WISH: 361, // "HP Electric" in the hack
  NATURAL_GIFT: 363, TAILWIND: 366, ACUPRESSURE: 367, METAL_BURST: 368, CLOSE_COMBAT: 370, PAYBACK: 371,
  EMBARGO: 373, FLING: 374, PSYCHO_SHIFT: 375, TRUMP_CARD: 376,
  HEAL_BLOCK: 377, // "Aqua Cutter" in the hack
  WRING_OUT: 378, POWER_TRICK: 379, GASTRO_ACID: 380, LUCKY_CHANT: 381, ME_FIRST: 382, COPYCAT: 383,
  POWER_SWAP: 384, GUARD_SWAP: 385, LAST_RESORT: 387, WORRY_SEED: 388, SUCKER_PUNCH: 389, TOXIC_SPIKES: 390,
  AQUA_RING: 392, MAGNET_RISE: 393, BRAVE_BIRD: 413, NASTY_PLOT: 417, DEFOG: 432, TRICK_ROOM: 433, DISCHARGE: 435, LAVA_PLUME: 436,
  ROCK_WRECKER: 439, CAPTIVATE: 445, STEALTH_ROCK: 446, HEAD_SMASH: 457, LUNAR_DANCE: 461,
  // The Expert cases' moves.
  KARATE_CHOP: 2, FLY: 19, WRAP: 35, DOUBLE_EDGE: 38, SING: 47, BUBBLE_BEAM: 61, ABSORB: 71, SOLAR_BEAM: 76,
  SLEEP_POWDER: 79, THUNDER: 87, DIG: 91, MEDITATE: 96, SMOKE_SCREEN: 108, WITHDRAW: 110,
  DEFENSE_CURL: 111, // "Rock Ball" in the hack
  CLAMP: 128, SWIFT: 129,
  SKULL_BASH: 130, // "Solar-Beam" in the hack, a plain hit
  SOFTBOILED: 135, GLARE: 137, SKY_ATTACK: 143, BUBBLE: 145, FLASH: 148, ACID_ARMOR: 151, SHARPEN: 159, THIEF: 168,
  SPIDER_WEB: 169, SWEET_KISS: 186, ICY_WIND: 196, OUTRAGE: 200, GIGA_DRAIN: 202, HEAL_BELL: 215, PURSUIT: 228,
  VITAL_THROW: 233, SYNTHESIS: 235, MOONLIGHT: 236, FACADE: 263, SMELLING_SALT: 265, ROLE_PLAY: 272, MAGIC_COAT: 277,
  RECYCLE: 278, YAWN: 281, ENDEAVOR: 283,
  SNATCH: 289, // "Drill Run" in the hack
  DIVE: 291, TAIL_GLOW: 294, FEATHER_DANCE: 297, TEETER_DANCE: 298, BLAZE_KICK: 299, ICE_BALL: 301, WEATHER_BALL: 311,
  AROMATHERAPY: 312, FAKE_TEARS: 313, OVERHEAT: 315, ODOR_SLEUTH: 316, ROCK_TOMB: 317, METAL_SOUND: 319, SHEER_COLD: 329,
  AERIAL_ACE: 332, IRON_DEFENSE: 334, BLOCK: 335, BOUNCE: 340, MUD_SHOT: 341, POISON_TAIL: 342,
  COVET: 343, // "HP Grass" in the hack
  VOLT_TACKLE: 344, SHOCK_WAVE: 351, DOOM_DESIRE: 353, PSYCHO_BOOST: 354, WAKE_UP_SLAP: 358, HAMMER_ARM: 359, BRINE: 362,
  FEINT: 364, PLUCK: 365, U_TURN: 369, ASSURANCE: 372, PUNISHMENT: 386, HEART_SWAP: 391, FLARE_BLITZ: 394,
  ROCK_POLISH: 397, DRAIN_PUNCH: 409, EARTH_POWER: 414,
  SWITCHEROO: 415, // "HP Flying" in the hack
  GIGA_IMPACT: 416, AVALANCHE: 419, DRACO_METEOR: 434, LEAF_STORM: 437, CROSS_POISON: 440, BUG_BITE: 450,
  DEFEND_ORDER: 455, CRUSH_GRIP: 462, DARK_VOID: 464, SHADOW_FORCE: 467,
} as const;

/** The move effects the gist cases name (generated/move_battle_effects.txt). */
export const E = {
  HIT: 0, STATUS_SLEEP: 1, HALVE_DEFENSE: 7, RECOVER_DAMAGE_SLEEP: 8, COPY_MOVE: 9, ATK_UP: 10, DEF_UP: 11,
  SPEED_UP: 12, SP_ATK_UP: 13, SP_DEF_UP: 14, ACC_UP: 15, EVA_UP: 16, ATK_DOWN: 18, DEF_DOWN: 19, SPEED_DOWN: 20,
  SP_ATK_DOWN: 21, SP_DEF_DOWN: 22, ACC_DOWN: 23, EVA_DOWN: 24, RESET_STAT_CHANGES: 25, BIDE: 26, FORCE_SWITCH: 28,
  CONVERSION: 30, RESTORE_HALF_HP: 32, STATUS_BADLY_POISON: 33, SET_LIGHT_SCREEN: 35, REST: 37, ONE_HIT_KO: 38,
  CHARGE_TURN_HIGH_CRIT: 39, HALVE_HP: 40, FLAT_40: 41, HIGH_CRITICAL: 43, PREVENT_STAT_REDUCTION: 46, CRIT_UP_2: 47,
  RECOIL_QUARTER: 48, STATUS_CONFUSE: 49, ATK_UP_2: 50, DEF_UP_2: 51, SPEED_UP_2: 52, SP_ATK_UP_2: 53, SP_DEF_UP_2: 54,
  ACC_UP_2: 55, EVA_UP_2: 56, ATK_DOWN_2: 58, DEF_DOWN_2: 59, SPEED_DOWN_2: 60, SP_ATK_DOWN_2: 61, SP_DEF_DOWN_2: 62,
  EVA_DOWN_2: 63, ACC_DOWN_2: 64, SET_REFLECT: 65, STATUS_POISON: 66, STATUS_PARALYZE: 67, PARALYZE_HIT: 6,
  BURN_HIT: 4, SET_SUBSTITUTE: 79, RECHARGE_AFTER: 80, RAISE_ATK_WHEN_HIT: 81, CALL_RANDOM_MOVE: 83,
  STATUS_LEECH_SEED: 84, DISABLE: 86, LEVEL_DAMAGE_FLAT: 87, RANDOM_DAMAGE_1_TO_150_LEVEL: 88, COUNTER: 89,
  ENCORE: 90, AVERAGE_HP: 91, DAMAGE_WHILE_ASLEEP: 92, CONVERSION2: 93, NEXT_ATTACK_ALWAYS_HITS: 94,
  USE_RANDOM_LEARNED_MOVE_SLEEP: 97, KO_MON_THAT_DEFEATED_USER: 98, INCREASE_POWER_WITH_LESS_HP: 99,
  DECREASE_LAST_MOVE_PP: 100, LOWER_SPEED_HIT: 70, PRIORITY_1: 103, HIT_THREE_TIMES: 104, PREVENT_ESCAPE: 106, STATUS_NIGHTMARE: 107,
  EVA_UP_2_MINIMIZE: 108, CURSE: 109, PROTECT: 111, SET_SPIKES: 112, FORESIGHT: 113, ALL_FAINT_3_TURNS: 114,
  WEATHER_SANDSTORM: 115, SURVIVE_WITH_1_HP: 116, DOUBLE_POWER_EACH_TURN_LOCK_INTO: 117,
  ATK_UP_2_STATUS_CONFUSION: 118, DOUBLE_POWER_EACH_TURN: 119, INFATUATE: 120, POWER_BASED_ON_FRIENDSHIP: 121,
  RANDOM_POWER_MAYBE_HEAL: 122, POWER_BASED_ON_LOW_FRIENDSHIP: 123, PREVENT_STATUS: 124, PSYWAVE: 126,
  PASS_STATS_AND_STATUS: 127, HIT_BEFORE_SWITCH: 128, FLAT_20: 130, HEAL_HALF_MORE_IN_SUN: 132,
  RANDOM_POWER_BASED_ON_IVS: 135, WEATHER_RAIN: 136, WEATHER_SUN: 137, RAISE_ALL_STATS_HIT: 140,
  MAX_ATK_LOSE_HALF_MAX_HP: 142, COPY_STAT_CHANGES: 143, MIRROR_COAT: 144, CHARGE_TURN_DEF_UP: 145,
  DOUBLE_DAMAGE_DIG: 147, HIT_IN_3_TURNS: 148, ALWAYS_FLINCH_FIRST_TURN_ONLY: 158, STOCKPILE: 160, SPIT_UP: 161,
  SWALLOW: 162, WEATHER_HAIL: 164, TORMENT: 165, SP_ATK_UP_CAUSE_CONFUSION: 166, STATUS_BURN: 167,
  FAINT_AND_ATK_SP_ATK_DOWN_2: 168, HIT_LAST_WHIFF_IF_HIT: 170, MAKE_GLOBAL_TARGET: 172, NATURE_POWER: 173,
  BOOST_ALLY_POWER_BY_50_PERCENT: 176, SWITCH_HELD_ITEMS: 177, GROUND_TRAP_USER_CONTINUOUS_HEAL: 181,
  LOWER_OWN_ATK_AND_DEF: 182, DOUBLE_POWER_IF_HIT: 185, REMOVE_SCREENS: 186, STATUS_SLEEP_NEXT_TURN: 187,
  REMOVE_HELD_ITEM: 188, SET_HP_EQUAL_TO_USER: 189, DECREASE_POWER_WITH_LESS_USER_HP: 190, SWITCH_ABILITIES: 191,
  MAKE_SHARED_MOVES_UNUSEABLE: 192, HEAL_STATUS: 193, REMOVE_ALL_PP_ON_DEFEAT: 194, INCREASE_POWER_WITH_WEIGHT: 196,
  SECRET_POWER: 197, CONFUSE_ALL: 199, HALVE_ELECTRIC_DAMAGE: 201, ATK_DEF_DOWN: 205, DEF_SPD_UP: 206,
  ATK_DEF_UP: 208, HALVE_FIRE_DAMAGE: 210, SP_ATK_SP_DEF_UP: 211, ATK_SPD_UP: 212, CAMOUFLAGE: 213,
  HEAL_HALF_REMOVE_FLYING_TYPE: 214, GRAVITY: 215, IGNORE_EVATION_REMOVE_DARK_IMMUNE: 216,
  POWER_BASED_ON_LOW_SPEED: 219, FAINT_AND_FULL_HEAL_NEXT_MON: 220, DOUBLE_POWER_WHEN_BELOW_HALF: 221,
  NATURAL_GIFT: 222, DOUBLE_SPEED_3_TURNS: 225, RANDOM_STAT_UP_2: 226, METAL_BURST: 227,
  DOUBLE_POWER_IF_MOVING_SECOND: 230, PREVENT_ITEM_USE: 232, FLING: 233, TRANSFER_STATUS: 234,
  HIGHER_POWER_WHEN_LOW_PP: 235, PREVENT_HEALING: 236, INCREASE_POWER_WITH_MORE_HP: 237, SWAP_ATK_DEF: 238,
  SUPRESS_ABILITY: 239, PREVENT_CRITS: 240, USE_MOVE_FIRST: 241, USE_LAST_USED_MOVE: 242,
  SWAP_ATK_SP_ATK_STAT_CHANGES: 243, SWAP_DEF_SP_DEF_STAT_CHANGES: 244, INCREASE_POWER_WITH_MORE_STAT_UP: 245,
  FAIL_IF_NOT_USED_ALL_OTHER_MOVES: 246, SET_ABILITY_TO_INSOMNIA: 247, HIT_FIRST_IF_TARGET_ATTACKING: 248,
  TOXIC_SPIKES: 249, SWAP_STAT_CHANGES: 250, RESTORE_HP_EVERY_TURN: 251, GIVE_GROUND_IMMUNITY: 252,
  RECOIL_BURN_HIT: 253, DOUBLE_DAMAGE_DIVE: 257, REMOVE_HAZARDS_SCREENS_EVA_DOWN: 258, TRICK_ROOM: 259, WHIRLPOOL: 261,
  RECOIL_PARALYZE_HIT: 262, SP_ATK_DOWN_2_OPPOSITE_GENDER: 265, STEALTH_ROCK: 266, RECOIL_HALF: 269,
  FAINT_FULL_RESTORE_NEXT_MON: 270, CHARGE_TURN_HIGH_CRIT_FLINCH: 75,
  // The Expert cases' effects.
  RECOVER_HALF_DAMAGE_DEALT: 3, BYPASS_ACCURACY: 17, BIND_HIT: 42, PRIORITY_NEG_1_BYPASS_ACCURACY: 78, DO_NOTHING: 85,
  CURE_PARTY_STATUS: 102, STEAL_HELD_ITEM: 105, THAW_AND_BURN_HIT: 125, UNUSED_133: 133, UNUSED_134: 134,
  SKIP_CHARGE_TURN_IN_SUN: 151, THUNDER: 152, FLY: 155, DEF_UP_DOUBLE_ROLLOUT_POWER: 156, UNUSED_157: 157,
  DOUBLE_POWER_WHEN_STATUSED: 169, DOUBLE_POWER_AND_CURE_PARALYSIS: 171, COPY_ABILITY: 178, APPLY_MAGIC_COAT: 183,
  RECYCLE: 184, STEAL_STATUS_MOVE: 195, RECOIL_THIRD: 198, HIGH_CRITICAL_BURN_HIT: 200, USER_SP_ATK_DOWN_2: 204,
  HIGH_CRITICAL_POISON_HIT: 209, DOUBLE_POWER_HEAL_SLEEP: 217, SPEED_DOWN_HIT: 218, REMOVE_PROTECT: 223, EAT_BERRY: 224,
  SWITCH_HIT: 228, DEF_SPD_DOWN_HIT: 229, DOUBLE_POWER_IF_TARGET_HIT: 231, DIVE: 255, DIG: 256, BLIZZARD: 260,
  BOUNCE: 263, SHADOW_FORCE: 272, FLINCH_FREEZE_HIT: 274,
} as const;

/** The abilities the gist cases name (generated/abilities.txt). */
export const A = {
  NONE: 0, STENCH: 1, SPEED_BOOST: 3, STURDY: 5, DAMP: 6, LIMBER: 7, SAND_VEIL: 8, VOLT_ABSORB: 10, WATER_ABSORB: 11,
  OBLIVIOUS: 12, INSOMNIA: 15, IMMUNITY: 17, FLASH_FIRE: 18, OWN_TEMPO: 20, SUCTION_CUPS: 21, SHADOW_TAG: 23,
  WONDER_GUARD: 25, LEVITATE: 26, CLEAR_BODY: 29, SWIFT_SWIM: 33, ILLUMINATE: 35, HUGE_POWER: 37, SOUNDPROOF: 43,
  WATER_VEIL: 41, RUN_AWAY: 50, KEEN_EYE: 51, HYPER_CUTTER: 52, PICKUP: 53, TRUANT: 54, STICKY_HOLD: 60, GUTS: 62, VITAL_SPIRIT: 72,
  WHITE_SMOKE: 73, PURE_POWER: 74, MOTOR_DRIVE: 78, SNOW_CLOAK: 81, SIMPLE: 86, DRY_SKIN: 87, POISON_HEAL: 90,
  HYDRATION: 93, SOLAR_POWER: 94, MAGIC_GUARD: 98, NO_GUARD: 99, STALL: 100, LEAF_GUARD: 102, KLUTZ: 103,
  MOLD_BREAKER: 104, FILTER: 111, SLOW_START: 112, ICE_BODY: 115, SOLID_ROCK: 116, HONEY_GATHER: 118, MULTITYPE: 121,
  FLOWER_GIFT: 122,
  BATTLE_ARMOR: 4, ROUGH_SKIN: 24, RAIN_DISH: 44, PRESSURE: 46, ROCK_HEAD: 69, SHELL_ARMOR: 75,
} as const;

/** The items the gist cases name (generated/items.txt). */
export const I = {
  NONE: 0, SHINY_STONE: 107, CHERI_BERRY: 149, PERSIM_BERRY: 156, WACAN_BERRY: 186, LEFTOVERS: 234, LIGHT_BALL: 236, TOXIC_ORB: 272,
  FLAME_ORB: 273,
  CHESTO_BERRY: 150, ORAN_BERRY: 155, LUM_BERRY: 157, STARF_BERRY: 207, JABOCA_BERRY: 211, ROWAP_BERRY: 212,
  KINGS_ROCK: 221, HARD_STONE: 238, POISON_BARB: 245, POWER_HERB: 271, IRON_BALL: 278, BLACK_SLUDGE: 281,
} as const;

/** BATTLE_STAT names for MonSpec.stages. */
export type StageName = 'attack' | 'defense' | 'speed' | 'spAttack' | 'spDefense' | 'accuracy' | 'evasion';
const STAGE_INDEX: Readonly<Record<StageName, number>> = {
  attack: BATTLE_STAT.ATTACK, defense: BATTLE_STAT.DEFENSE, speed: BATTLE_STAT.SPEED, spAttack: BATTLE_STAT.SP_ATTACK,
  spDefense: BATTLE_STAT.SP_DEFENSE, accuracy: BATTLE_STAT.ACCURACY, evasion: BATTLE_STAT.EVASION,
};

/**
 * One battler, as a patch over the case's defaults: level 50, Normal/Normal, Illuminate (an ability no script routine
 * names), no item, 200/200 HP, 100 in every other stat but Speed, neutral stages, no status, every field of
 * moveEffectsData 0 (a lead on turn 1). The AI is male with Speed 90; the player is female with Speed 110, so by
 * default the AI is slower and nothing ties.
 */
export interface MonSpec {
  species?: number; level?: number; gender?: number; types?: [number, number]; ability?: number; item?: number;
  /** curHP and maxHP. */
  hp?: number; maxHP?: number;
  attack?: number; defense?: number; spAttack?: number; spDefense?: number; speed?: number;
  /** Stage changes from neutral, −6 to +6. */
  stages?: Partial<Record<StageName, number>>;
  status?: number; statusVolatile?: number; moveEffectsMask?: number; effects?: Partial<AiMoveEffectsData>;
  /** The moves (padded to 4 with MOVE_NONE), at full PP unless `pp` gives each slot's. */
  moves?: number[]; pp?: number[];
  ivs?: Partial<Stats>; weight?: number;
  /** movePrevByBattler for this battler. */
  prevMove?: number;
}

/** One party member behind the lead: a live 100/100 HP Pokémon with Tackle at full PP, unless patched. */
export type BenchSpec = Partial<AiPartyMon>;

/** What a gist case sets up. Everything not given takes the defaults above: a turn-1 singles trainer battle. */
export interface GistSetup {
  /** The AI's moves; `slot` (0 by default) is the one whose score the case checks. */
  moves: number[];
  slot?: number;
  /** The effect the hack gives the move under test, checked before the run: what the case assumes the script routes on. */
  effect?: number;
  /** The AI's battler (slot 1, the attacker) and the player's (slot 0, the defender). */
  ai?: MonSpec; player?: MonSpec;
  /** Each side's party behind the lead: a count of default members (1 by default; 0 = the lead is the last), or the members. */
  aiBench?: number | BenchSpec[]; playerBench?: number | BenchSpec[];
  /** fieldConditionsMask. */
  field?: number;
  /** sideConditionsMask by side: [player's, AI's]. */
  sides?: [number, number];
  /** Spikes and Toxic Spikes layers on the player's side. */
  playerHazards?: { spikes?: number; toxicSpikes?: number };
  /** totalTurns: 0 on the battle's first turn. */
  turn?: number;
  battleType?: number;
  /** recycleItem by battler. */
  recycleItem?: number[];
  /**
   * What the AI knows of the player's battler. By default it knows the player's real ability and item (so
   * LoadBattlerAbility never flips between the species' two) and none of its moves.
   */
  known?: { ability?: number; item?: number; moves?: number[] };
  /** A last change to the view, for anything else; monSpeedValues are computed after it. */
  patch?: (v: AiView) => void;
}

/**
 * The expected score change of the slot: `'-10'` for a certain change, or each change with its exact odds, as
 * `'176/256: +2, 80/256: 0'`. The odds must sum to 1. `{ throws }` expects the run to throw that AiError.
 */
export type Expected = string | { throws: AiErrorCode };

/** A slot's score as TrainerAI_Init starts it (trainer_ai.c:224–225); the score change is the final score less this. */
const START_SCORE = 100;
const NEUTRAL_STAGE = 6;
const NO_SWITCH = 6;
const POWER_MUL = 10;
const DEFAULT_ABILITY = A.ILLUMINATE;
/** The species of the default battlers and bench members: Snorlax, Arcanine, Bulbasaur (no species-specific rule reads them). */
const PLAYER_SPECIES = 143;
const AI_SPECIES = 59;
const BENCH_SPECIES = 1;

type RealDeps = Omit<AiDeps, 'aiFlags'>;
let real: RealDeps | undefined;

/** The hack's AI data, read from PK_ROM on first use: the script, moves, species, items and type chart. */
export function realDeps(): RealDeps {
  if (real === undefined) {
    const rom = readFileSync(PK_ROM);
    const data = extractRomData(rom);
    const ai = extractAiData(rom);
    real = { script: aiScriptOf(ai), moves: data.moves, species: data.species, items: ai.items, typeChart: ai.typeChart };
  }
  return real;
}

/** Every move the hack gives `effect`, by ID: an empty list means no rule routed on that effect can fire in the hack. */
export function movesWithEffect(effect: number): number[] {
  return realDeps().moves.flatMap((move) => (move !== undefined && move.id !== 0 && move.effect === effect ? [move.id] : []));
}

/** No hack move has any of `effects`, so the rules routed on them can't fire in the hack. */
export function noHackMove(...effects: number[]): void {
  for (const effect of effects) expect(movesWithEffect(effect), `the hack's moves with effect ${effect}`).toEqual([]);
}

/** The hack's effect for `move`. */
export function hackEffect(move: number): number {
  const record = realDeps().moves[move];
  if (record === undefined) throw new Error(`the hack has no move ${move}`);
  return record.effect;
}

function fullPp(d: RealDeps, moves: number[]): number[] {
  return moves.map((move) => (move === M.NONE ? 0 : (d.moves[move]?.pp ?? 0)));
}

function pad(moves: number[]): number[] {
  if (moves.length > 4) throw new Error(`${moves.length} moves`);
  return [...moves, ...Array<number>(4 - moves.length).fill(M.NONE)];
}

function battleMonOf(spec: MonSpec, defaults: { species: number; gender: number; speed: number; moves: number[] }, d: RealDeps): AiBattleMon {
  const moves = pad(spec.moves ?? defaults.moves);
  const ppMax = fullPp(d, moves);
  const statBoosts = Array<number>(8).fill(NEUTRAL_STAGE);
  for (const [name, change] of Object.entries(spec.stages ?? {}) as [StageName, number][]) statBoosts[STAGE_INDEX[name]] = NEUTRAL_STAGE + change;
  const maxHP = spec.maxHP ?? 200;
  return {
    species: spec.species ?? defaults.species, form: 0, level: spec.level ?? 50, gender: spec.gender ?? defaults.gender,
    types: spec.types ?? [TYPE_NORMAL, TYPE_NORMAL], ability: spec.ability ?? DEFAULT_ABILITY, heldItem: spec.item ?? I.NONE,
    weight: spec.weight ?? 1000, friendship: 70,
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31, ...spec.ivs },
    curHP: spec.hp ?? maxHP, maxHP,
    attack: spec.attack ?? 100, defense: spec.defense ?? 100, spAttack: spec.spAttack ?? 100,
    spDefense: spec.spDefense ?? 100, speed: spec.speed ?? defaults.speed,
    statBoosts, moves, ppCur: spec.pp === undefined ? [...ppMax] : pad(spec.pp), ppMax,
    status: spec.status ?? 0, statusVolatile: spec.statusVolatile ?? 0, moveEffectsMask: spec.moveEffectsMask ?? 0,
    effects: { ...EMPTY_MON.effects, ...spec.effects },
  };
}

function partyMonOf(mon: AiBattleMon): AiPartyMon {
  return {
    species: mon.species, form: mon.form, level: mon.level, hp: mon.curHP, maxHp: mon.maxHP, status: mon.status,
    moves: [...mon.moves], pp: [...mon.ppCur], ppMax: [...mon.ppMax], heldItem: mon.heldItem, ability: mon.ability,
    types: [mon.types[0], mon.types[1]], ivs: { ...mon.ivs },
  };
}

function benchOf(spec: number | BenchSpec[] | undefined): AiPartyMon[] {
  const members = typeof spec === 'object' ? spec : Array.from({ length: spec ?? 1 }, () => ({}));
  return members.map((member) => ({
    species: BENCH_SPECIES, form: 0, level: 50, hp: 100, maxHp: 100, status: 0, moves: [M.TACKLE, 0, 0, 0],
    pp: [35, 0, 0, 0], ppMax: [35, 0, 0, 0], heldItem: I.NONE, ability: DEFAULT_ABILITY, types: [TYPE_NORMAL, TYPE_NORMAL],
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, ...member,
  }));
}

/**
 * The case's view: a singles trainer battle on turn `setup.turn` (0 by default), the player's lead in battler slot 0,
 * the AI's in slot 1, and slots 2 and 3 EMPTY_MON, as initialView builds them. monSpeedValues are what
 * BattleSystem_CompareBattlerSpeed writes for the two leads (battle_lib.c:1372–1373), as at the end of the switch-in
 * step (initialView's battleStartSpeeds). Nothing is unknown.
 */
export function gistView(setup: GistSetup, d: RealDeps = realDeps()): AiView {
  const player = battleMonOf(setup.player ?? {}, { species: PLAYER_SPECIES, gender: GENDER_FEMALE, speed: 110, moves: [M.TACKLE] }, d);
  const ai = battleMonOf({ ...setup.ai, moves: setup.moves }, { species: AI_SPECIES, gender: GENDER_MALE, speed: 90, moves: [] }, d);
  const v: AiView = {
    battleType: setup.battleType ?? BATTLE_TYPE_TRAINER_SINGLES,
    mons: [player, ai, EMPTY_MON, EMPTY_MON],
    parties: [[partyMonOf(player), ...benchOf(setup.playerBench)], [partyMonOf(ai), ...benchOf(setup.aiBench)]],
    selectedPartySlot: [0, 0, 0, 0],
    aiSwitchedPartySlot: [NO_SWITCH, NO_SWITCH, NO_SWITCH, NO_SWITCH],
    totalTurns: setup.turn ?? 0,
    fieldConditionsMask: setup.field ?? 0,
    battleStatusMask: 0,
    powerMul: POWER_MUL,
    turnFlags: [0, 1, 2, 3].map(() => ({ roosting: false, helpingHand: false })),
    sideConditionsMask: setup.sides ?? [0, 0],
    sideConditions: [
      { spikesLayers: setup.playerHazards?.spikes ?? 0, toxicSpikesLayers: setup.playerHazards?.toxicSpikes ?? 0 },
      { spikesLayers: 0, toxicSpikesLayers: 0 },
    ],
    movePrevByBattler: [setup.player?.prevMove ?? M.NONE, setup.ai?.prevMove ?? M.NONE, M.NONE, M.NONE],
    moveHit: [0, 0, 0, 0],
    moveHitBattler: [BATTLER_NONE, BATTLER_NONE, BATTLER_NONE, BATTLER_NONE],
    moveProtect: [0, 0, 0, 0],
    recycleItem: setup.recycleItem ?? [0, 0, 0, 0],
    battlersSwitchingMask: (1 << BATTLER_PLAYER_2) | (1 << BATTLER_ENEMY_2),
    monSpeedValues: [0, 0, 0, 0],
    quickClawThisTurn: [null, null, null, null],
    trainerItems: [],
    trainerItemCount: 0,
    unknown: [],
  };
  setup.patch?.(v);
  const { speeds } = compareSpeed(v, { ...d, aiFlags: 0 }, { rolls: [null, null, null, null], quickClaw: [null, null, null, null] },
    PLAYER_BATTLER, AI_BATTLER, () => 0);
  return { ...v, monSpeedValues: speeds === null ? [0, 0, 0, 0] : [speeds[0], speeds[1], 0, 0] };
}

/** What the AI knows at the case's decision (GistSetup.known). */
export function gistKnowledge(setup: GistSetup, v: AiView): AiKnowledge {
  const player = v.mons[PLAYER_BATTLER];
  return {
    battlerMoves: [pad(setup.known?.moves ?? []), [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    battlerAbilities: [setup.known?.ability ?? player.ability, 0, 0, 0],
    battlerHeldItems: [setup.known?.item ?? player.heldItem, 0, 0, 0],
  };
}

/** Parses an Expected string into { change, odds } rows, ascending by change, odds reduced. */
function parseExpected(text: string): { change: number; odds: string }[] {
  const rows = text.split(',').map((term) => {
    const parts = term.split(':').map((part) => part.trim());
    const [oddsText, changeText] = parts.length === 1 ? ['1/1', parts[0]!] : [parts[0]!, parts[1]!];
    const match = /^(\d+)\/(\d+)$/.exec(oddsText);
    if (match === null || !/^[+-]?\d+$/.test(changeText)) throw new Error(`bad expected term "${term}"`);
    return { change: Number(changeText), num: BigInt(match[1]!), den: BigInt(match[2]!) };
  });
  // The odds must sum to exactly 1: a typo in a case fails here, not as a mismatch.
  let num = 0n;
  let den = 1n;
  for (const row of rows) {
    num = num * row.den + row.num * den;
    den *= row.den;
  }
  if (num !== den) throw new Error(`expected odds "${text}" don't sum to 1`);
  return rows
    .map(({ change, num, den }) => ({ change, odds: reducedText(num, den) }))
    .sort((a, b) => a.change - b.change);
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}

function reducedText(num: bigint, den: bigint): string {
  const g = gcd(num, den);
  return `${num / g}/${den / g}`;
}

function codeOf(fn: () => unknown): AiErrorCode | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof AiError) return error.code;
    throw error;
  }
  return undefined;
}

/**
 * One gist rule: runs `flag` alone (aiFlags is that one bit) over the view `setup` builds, and checks the slot under
 * test against `expected`: its exact final score distribution as score changes from 100, with their odds; or the
 * AiError the run throws. `setup.effect`, when given, is checked first against the hack's move data.
 */
export function gistCase(flag: number, setup: GistSetup, expected: Expected): void {
  const base = realDeps();
  const d: AiDeps = { ...base, aiFlags: flag };
  const slot = setup.slot ?? 0;
  const move = setup.moves[slot] ?? M.NONE;
  if (setup.effect !== undefined) expect(hackEffect(move), `the hack's effect for move ${move}`).toBe(setup.effect);
  const v = gistView(setup, base);
  const k = gistKnowledge(setup, v);
  if (typeof expected === 'object') {
    expect(codeOf(() => slotScores(v, d, k, slot)), `the AiError for move ${move}`).toBe(expected.throws);
    return;
  }
  const got = slotScores(v, d, k, slot).map(({ score, probability }) => ({
    change: score - START_SCORE, odds: reducedText(probability.num, probability.den),
  }));
  expect(got, `move ${move}'s score change`).toEqual(parseExpected(expected));
}
