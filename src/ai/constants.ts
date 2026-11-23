// Cartridge constants the trainer AI reads: those trainer_ai.c and the battle_lib.c helpers it calls name, copied
// from pret/pokeplatinum at 62bdaacdc. Each block cites its source.
// - `#define` blocks keep the header's own expressions.
// - generated/<list>.txt files are metang source lists (generated/meson.build). An `enum` list numbers its lines from
//   0, and none of the lists used here gives an explicit `= value`, so a constant's value is its line number minus 1.
//   The two `mask` lists are explained at their blocks.
// - Where a list is long, only the entries the C names are kept; the block says so.

import type { MoveCategory } from '../rom/types.js';

// include/constants/battle.h:24–56
export const BATTLE_TYPE_SINGLES = (0 << 0);
export const BATTLE_TYPE_WILD_MON = (0 << 0);
export const BATTLE_TYPE_TRAINER = (1 << 0);
export const BATTLE_TYPE_DOUBLES = (1 << 1);
export const BATTLE_TYPE_LINK = (1 << 2);
export const BATTLE_TYPE_2vs2 = (1 << 3); // This is, explicitly, two distinct battlers on each side
export const BATTLE_TYPE_TAG = (1 << 4); // This is, explicitly, a battle with a partner
export const BATTLE_TYPE_SAFARI = (1 << 5);
export const BATTLE_TYPE_AI = (1 << 6);
export const BATTLE_TYPE_FRONTIER = (1 << 7);
export const BATTLE_TYPE_ROAMER = (1 << 8);
export const BATTLE_TYPE_PAL_PARK = (1 << 9);
export const BATTLE_TYPE_CATCH_TUTORIAL = (1 << 10);
export const BATTLE_TYPE_DEBUG = (1 << 31);
export const BATTLE_TYPE_TRAINER_SINGLES = (BATTLE_TYPE_SINGLES | BATTLE_TYPE_TRAINER);
export const BATTLE_TYPE_TRAINER_DOUBLES = (BATTLE_TYPE_DOUBLES | BATTLE_TYPE_TRAINER);
export const BATTLE_TYPE_LINK_DOUBLES = (BATTLE_TYPE_LINK | BATTLE_TYPE_TRAINER_DOUBLES);
export const BATTLE_TYPE_FRONTIER_SINGLES = (BATTLE_TYPE_FRONTIER | BATTLE_TYPE_TRAINER_SINGLES);
export const BATTLE_TYPE_FRONTIER_DOUBLES = (BATTLE_TYPE_FRONTIER | BATTLE_TYPE_TRAINER_DOUBLES);
export const BATTLE_TYPE_FRONTIER_LINK = (BATTLE_TYPE_LINK | BATTLE_TYPE_FRONTIER);
export const BATTLE_TYPE_TAG_DOUBLES = (BATTLE_TYPE_TAG | BATTLE_TYPE_TRAINER_DOUBLES);
export const BATTLE_TYPE_AI_PARTNER = (BATTLE_TYPE_DOUBLES | BATTLE_TYPE_2vs2 | BATTLE_TYPE_AI);
export const BATTLE_TYPE_TRAINER_WITH_AI_PARTNER = (BATTLE_TYPE_TRAINER | BATTLE_TYPE_AI_PARTNER);
export const BATTLE_TYPE_FRONTIER_WITH_AI_PARTNER = (BATTLE_TYPE_FRONTIER | BATTLE_TYPE_TRAINER_WITH_AI_PARTNER);
export const BATTLE_TYPE_SPECIAL_WILD = (BATTLE_TYPE_SAFARI | BATTLE_TYPE_ROAMER | BATTLE_TYPE_PAL_PARK
  | BATTLE_TYPE_CATCH_TUTORIAL);
export const BATTLE_TYPE_FORCED_SET_MODE = (BATTLE_TYPE_DOUBLES | BATTLE_TYPE_LINK | BATTLE_TYPE_FRONTIER);
export const BATTLE_TYPE_NO_AI_ITEMS = (BATTLE_TYPE_LINK | BATTLE_TYPE_FRONTIER | BATTLE_TYPE_SAFARI | BATTLE_TYPE_AI
  | BATTLE_TYPE_PAL_PARK);
export const BATTLE_TYPE_NO_MOVES = (BATTLE_TYPE_SAFARI | BATTLE_TYPE_PAL_PARK);
export const BATTLE_TYPE_NO_EXPERIENCE = (BATTLE_TYPE_LINK | BATTLE_TYPE_SAFARI | BATTLE_TYPE_FRONTIER
  | BATTLE_TYPE_PAL_PARK);
export const BATTLE_TYPE_NO_ABILITIES = (BATTLE_TYPE_SAFARI | BATTLE_TYPE_PAL_PARK);
export const BATTLE_TYPE_2vs2_TAG = (BATTLE_TYPE_2vs2 | BATTLE_TYPE_TAG);
export const BATTLE_TYPE_ALWAYS_CATCH = (BATTLE_TYPE_PAL_PARK | BATTLE_TYPE_CATCH_TUTORIAL);

// include/constants/battle.h:59, 61, 69
export const MAX_BATTLERS = 4;
export const MAX_BATTLERS_PER_SIDE = 2;
export const MAX_TRAINER_ITEMS = 4;

// include/constants/battle.h:95–99, 105, 109–110
export const BATTLER_PLAYER_1 = 0;
export const BATTLER_ENEMY_1 = 1;
export const BATTLER_PLAYER_2 = 2;
export const BATTLER_ENEMY_2 = 3;
export const BATTLER_NONE = 0xFF;
export const BATTLER_TYPE_PLAYER_SIDE_SLOT_2 = 4;
export const BATTLE_SIDE_PLAYER = 0;
export const BATTLE_SIDE_ENEMY = 1;

// include/constants/battle.h:121–131 (the invalid-move checks of BattleSystem_CheckInvalidMoves)
export const CHECK_INVALID_NO_MOVE = (1 << 0);
export const CHECK_INVALID_NO_PP = (1 << 1);
export const CHECK_INVALID_DISABLED = (1 << 2);
export const CHECK_INVALID_TORMENTED = (1 << 3);
export const CHECK_INVALID_TAUNTED = (1 << 4);
export const CHECK_INVALID_IMPRISONED = (1 << 5);
export const CHECK_INVALID_GRAVITY = (1 << 6);
export const CHECK_INVALID_HEAL_BLOCK = (1 << 7);
export const CHECK_INVALID_ENCORE = (1 << 8); // this one is only implicit
export const CHECK_INVALID_CHOICE_ITEM = (1 << 9);
export const CHECK_INVALID_ALL = ~0;

// include/constants/battle.h:144–153 (type chart multipliers × 10, and damage multipliers × 40)
export const TYPE_MULTI_IMMUNE = 0;
export const TYPE_MULTI_NOT_VERY_EFF = 5;
export const TYPE_MULTI_SUPER_EFF = 20;
export const TYPE_MULTI_QUARTER_DAMAGE = 10;
export const TYPE_MULTI_HALF_DAMAGE = 20;
export const TYPE_MULTI_BASE_DAMAGE = 40;
export const TYPE_MULTI_STAB_DAMAGE = 60;
export const TYPE_MULTI_DOUBLE_DAMAGE = 80;
export const TYPE_MULTI_QUADRUPLE_DAMAGE = 160;

// include/constants/battle.h:163–165
export const COMPARE_SPEED_FASTER = 0;
export const COMPARE_SPEED_SLOWER = 1;
export const COMPARE_SPEED_TIE = 2;

// include/constants/battle/condition.h:6–29 (BattleMon.status)
export const MON_CONDITION_NONE = 0;
export const MON_CONDITION_SLEEP_0 = (1 << 0);
export const MON_CONDITION_SLEEP_1 = (1 << 1);
export const MON_CONDITION_SLEEP_2 = (1 << 2);
export const MON_CONDITION_POISON = (1 << 3);
export const MON_CONDITION_BURN = (1 << 4);
export const MON_CONDITION_FREEZE = (1 << 5);
export const MON_CONDITION_PARALYSIS = (1 << 6);
export const MON_CONDITION_TOXIC = (1 << 7);
export const MON_CONDITION_TOXIC_COUNTER_0 = (1 << 8);
export const MON_CONDITION_TOXIC_COUNTER_1 = (1 << 9);
export const MON_CONDITION_TOXIC_COUNTER_2 = (1 << 10);
export const MON_CONDITION_TOXIC_COUNTER_3 = (1 << 11);
export const MON_CONDITION_TOXIC_COUNT_INC = MON_CONDITION_TOXIC_COUNTER_0;
export const MON_CONDITION_SLEEP = (MON_CONDITION_SLEEP_0 | MON_CONDITION_SLEEP_1 | MON_CONDITION_SLEEP_2);
export const MON_CONDITION_TOXIC_COUNTER = (MON_CONDITION_TOXIC_COUNTER_0 | MON_CONDITION_TOXIC_COUNTER_1
  | MON_CONDITION_TOXIC_COUNTER_2 | MON_CONDITION_TOXIC_COUNTER_3);
export const MON_CONDITION_ANY_POISON = (MON_CONDITION_POISON | MON_CONDITION_TOXIC | MON_CONDITION_TOXIC_COUNTER);
export const MON_CONDITION_ANY = (MON_CONDITION_SLEEP | MON_CONDITION_POISON | MON_CONDITION_BURN | MON_CONDITION_FREEZE
  | MON_CONDITION_PARALYSIS | MON_CONDITION_TOXIC);
export const MON_CONDITION_NOT_SLEEP = ~MON_CONDITION_SLEEP;
export const MON_CONDITION_CAN_SYNCHRONIZE = (MON_CONDITION_POISON | MON_CONDITION_BURN | MON_CONDITION_PARALYSIS);
export const MON_CONDITION_FACADE_BOOST = (MON_CONDITION_TOXIC | MON_CONDITION_POISON | MON_CONDITION_BURN
  | MON_CONDITION_PARALYSIS);

// include/constants/battle/condition.h:31–78 (BattleMon.statusVolatile; the *_SHIFT constants are left out)
export const VOLATILE_CONDITION_NONE = 0;
export const VOLATILE_CONDITION_CONFUSION_0 = (1 << 0);
export const VOLATILE_CONDITION_CONFUSION_1 = (1 << 1);
export const VOLATILE_CONDITION_CONFUSION_2 = (1 << 2);
export const VOLATILE_CONDITION_FLINCH = (1 << 3);
export const VOLATILE_CONDITION_UPROAR_0 = (1 << 4);
export const VOLATILE_CONDITION_UPROAR_1 = (1 << 5);
export const VOLATILE_CONDITION_UPROAR_2 = (1 << 6);
export const VOLATILE_CONDITION_BIDE_0 = (1 << 8);
export const VOLATILE_CONDITION_BIDE_1 = (1 << 9);
export const VOLATILE_CONDITION_THRASH_0 = (1 << 10);
export const VOLATILE_CONDITION_THRASH_1 = (1 << 11);
export const VOLATILE_CONDITION_MOVE_LOCKED = (1 << 12);
export const VOLATILE_CONDITION_BIND_0 = (1 << 13);
export const VOLATILE_CONDITION_BIND_1 = (1 << 14);
export const VOLATILE_CONDITION_BIND_2 = (1 << 15);
export const VOLATILE_CONDITION_ATTRACT_0 = (1 << 16);
export const VOLATILE_CONDITION_ATTRACT_1 = (1 << 17);
export const VOLATILE_CONDITION_ATTRACT_2 = (1 << 18);
export const VOLATILE_CONDITION_ATTRACT_3 = (1 << 19);
export const VOLATILE_CONDITION_FOCUS_ENERGY = (1 << 20);
export const VOLATILE_CONDITION_TRANSFORM = (1 << 21);
export const VOLATILE_CONDITION_RECHARGING = (1 << 22);
export const VOLATILE_CONDITION_RAGE = (1 << 23);
export const VOLATILE_CONDITION_SUBSTITUTE = (1 << 24);
export const VOLATILE_CONDITION_DESTINY_BOND = (1 << 25);
export const VOLATILE_CONDITION_MEAN_LOOK = (1 << 26);
export const VOLATILE_CONDITION_NIGHTMARE = (1 << 27);
export const VOLATILE_CONDITION_CURSE = (1 << 28);
export const VOLATILE_CONDITION_FORESIGHT = (1 << 29);
export const VOLATILE_CONDITION_DEFENSE_CURL = (1 << 30);
export const VOLATILE_CONDITION_TORMENT = (1 << 31);
export const VOLATILE_CONDITION_CONFUSION = (VOLATILE_CONDITION_CONFUSION_0 | VOLATILE_CONDITION_CONFUSION_1
  | VOLATILE_CONDITION_CONFUSION_2);
export const VOLATILE_CONDITION_UPROAR = (VOLATILE_CONDITION_UPROAR_0 | VOLATILE_CONDITION_UPROAR_1
  | VOLATILE_CONDITION_UPROAR_2);
export const VOLATILE_CONDITION_BIDE = (VOLATILE_CONDITION_BIDE_0 | VOLATILE_CONDITION_BIDE_1);
export const VOLATILE_CONDITION_THRASH = (VOLATILE_CONDITION_THRASH_0 | VOLATILE_CONDITION_THRASH_1);
export const VOLATILE_CONDITION_BIND = (VOLATILE_CONDITION_BIND_0 | VOLATILE_CONDITION_BIND_1
  | VOLATILE_CONDITION_BIND_2);
export const VOLATILE_CONDITION_ATTRACT = (VOLATILE_CONDITION_ATTRACT_0 | VOLATILE_CONDITION_ATTRACT_1
  | VOLATILE_CONDITION_ATTRACT_2 | VOLATILE_CONDITION_ATTRACT_3);
export const VOLATILE_CONDITION_BATON_PASSED = (VOLATILE_CONDITION_FOCUS_ENERGY | VOLATILE_CONDITION_MEAN_LOOK
  | VOLATILE_CONDITION_CONFUSION | VOLATILE_CONDITION_CURSE | VOLATILE_CONDITION_SUBSTITUTE);
export const VOLATILE_CONDITION_TRAPPED = (VOLATILE_CONDITION_BIND | VOLATILE_CONDITION_MEAN_LOOK);

// include/constants/battle/condition.h:87–105 (BattleContext.sideConditionsMask)
export const SIDE_CONDITION_NONE = 0;
export const SIDE_CONDITION_REFLECT = (1 << 0);
export const SIDE_CONDITION_LIGHT_SCREEN = (1 << 1);
export const SIDE_CONDITION_SPIKES = (1 << 2);
export const SIDE_CONDITION_SAFEGUARD = (1 << 3);
export const SIDE_CONDITION_FUTURE_SIGHT = (1 << 4);
export const SIDE_CONDITION_WISH = (1 << 5);
export const SIDE_CONDITION_MIST = (1 << 6);
export const SIDE_CONDITION_STEALTH_ROCK = (1 << 7);
export const SIDE_CONDITION_TAILWIND_0 = (1 << 8);
export const SIDE_CONDITION_TAILWIND_1 = (1 << 9);
export const SIDE_CONDITION_TOXIC_SPIKES = (1 << 10);
export const SIDE_CONDITION_LUCKY_CHANT_0 = (1 << 12);
export const SIDE_CONDITION_LUCKY_CHANT_1 = (1 << 13);
export const SIDE_CONDITION_LUCKY_CHANT_2 = (1 << 14);
export const SIDE_CONDITION_TAILWIND = (SIDE_CONDITION_TAILWIND_0 | SIDE_CONDITION_TAILWIND_1);
export const SIDE_CONDITION_LUCKY_CHANT = (SIDE_CONDITION_LUCKY_CHANT_0 | SIDE_CONDITION_LUCKY_CHANT_1
  | SIDE_CONDITION_LUCKY_CHANT_2);

// include/constants/battle/condition.h:110–145 (BattleContext.fieldConditionsMask)
export const FIELD_CONDITION_RAINING_TEMP = (1 << 0);
export const FIELD_CONDITION_RAINING_PERM = (1 << 1);
export const FIELD_CONDITION_SANDSTORM_TEMP = (1 << 2);
export const FIELD_CONDITION_SANDSTORM_PERM = (1 << 3);
export const FIELD_CONDITION_SUNNY_TEMP = (1 << 4);
export const FIELD_CONDITION_SUNNY_PERM = (1 << 5);
export const FIELD_CONDITION_HAILING_TEMP = (1 << 6);
export const FIELD_CONDITION_HAILING_PERM = (1 << 7);
export const FIELD_CONDITION_UPROAR = ((1 << 8) | (1 << 9) | (1 << 10)
  | (1 << 11)); // mask for which clients are in an Uproar
export const FIELD_CONDITION_GRAVITY_0 = (1 << 12);
export const FIELD_CONDITION_GRAVITY_1 = (1 << 13);
export const FIELD_CONDITION_GRAVITY_2 = (1 << 14);
export const FIELD_CONDITION_DEEP_FOG = (1 << 15);
export const FIELD_CONDITION_TRICK_ROOM_0 = (1 << 16);
export const FIELD_CONDITION_TRICK_ROOM_1 = (1 << 17);
export const FIELD_CONDITION_TRICK_ROOM_2 = (1 << 18);
export const FIELD_CONDITION_RAINING = (FIELD_CONDITION_RAINING_TEMP | FIELD_CONDITION_RAINING_PERM);
export const FIELD_CONDITION_SANDSTORM = (FIELD_CONDITION_SANDSTORM_TEMP | FIELD_CONDITION_SANDSTORM_PERM);
export const FIELD_CONDITION_SUNNY = (FIELD_CONDITION_SUNNY_TEMP | FIELD_CONDITION_SUNNY_PERM);
export const FIELD_CONDITION_HAILING = (FIELD_CONDITION_HAILING_TEMP | FIELD_CONDITION_HAILING_PERM);
export const FIELD_CONDITION_WEATHER = (FIELD_CONDITION_RAINING | FIELD_CONDITION_SANDSTORM | FIELD_CONDITION_SUNNY
  | FIELD_CONDITION_HAILING | FIELD_CONDITION_DEEP_FOG);
export const FIELD_CONDITION_SOLAR_DOWN = (FIELD_CONDITION_RAINING | FIELD_CONDITION_SANDSTORM | FIELD_CONDITION_HAILING
  | FIELD_CONDITION_DEEP_FOG);
export const FIELD_CONDITION_CASTFORM = (FIELD_CONDITION_RAINING | FIELD_CONDITION_SUNNY | FIELD_CONDITION_HAILING);
export const FIELD_CONDITION_GRAVITY = (FIELD_CONDITION_GRAVITY_0 | FIELD_CONDITION_GRAVITY_1
  | FIELD_CONDITION_GRAVITY_2);
export const FIELD_CONDITION_GRAVITY_INIT = (FIELD_CONDITION_GRAVITY_0 | FIELD_CONDITION_GRAVITY_2);
export const FIELD_CONDITION_TRICK_ROOM = (FIELD_CONDITION_TRICK_ROOM_0 | FIELD_CONDITION_TRICK_ROOM_1
  | FIELD_CONDITION_TRICK_ROOM_2);
export const FIELD_CONDITION_TRICK_ROOM_INIT = (FIELD_CONDITION_TRICK_ROOM_0 | FIELD_CONDITION_TRICK_ROOM_2);

// include/constants/battle/moves.h:7–50 (BattleMon.moveEffectsMask; *_SHIFT and the initial duration are left out)
export const MOVE_EFFECT_NONE = 0;
export const MOVE_EFFECT_LEECH_SEED_RECIPIENT_0 = (1 << 0);
export const MOVE_EFFECT_LEECH_SEED_RECIPIENT_1 = (1 << 1);
export const MOVE_EFFECT_LEECH_SEED = (1 << 2);
export const MOVE_EFFECT_LOCK_ON_0 = (1 << 3);
export const MOVE_EFFECT_LOCK_ON_1 = (1 << 4);
export const MOVE_EFFECT_PERISH_SONG = (1 << 5);
export const MOVE_EFFECT_AIRBORNE = (1 << 6); // Fly, Bounce
export const MOVE_EFFECT_UNDERGROUND = (1 << 7); // Dig
export const MOVE_EFFECT_MINIMIZE = (1 << 8);
export const MOVE_EFFECT_CHARGE = (1 << 9);
export const MOVE_EFFECT_INGRAIN = (1 << 10);
export const MOVE_EFFECT_YAWN_0 = (1 << 11);
export const MOVE_EFFECT_YAWN_1 = (1 << 12);
export const MOVE_EFFECT_IMPRISON = (1 << 13); // applied to mons which use Imprison
export const MOVE_EFFECT_GRUDGE = (1 << 14);
export const MOVE_EFFECT_NO_CRITICAL = (1 << 15); // checked for, but never set
export const MOVE_EFFECT_MUD_SPORT = (1 << 16);
export const MOVE_EFFECT_WATER_SPORT = (1 << 17);
export const MOVE_EFFECT_UNDERWATER = (1 << 18); // Dive
export const MOVE_EFFECT_ABILITY_SUPPRESSED = (1 << 21); // Gastro Acid
export const MOVE_EFFECT_MIRACLE_EYE = (1 << 22);
export const MOVE_EFFECT_POWER_TRICK = (1 << 23);
export const MOVE_EFFECT_AQUA_RING = (1 << 24);
export const MOVE_EFFECT_HEAL_BLOCK = (1 << 25);
export const MOVE_EFFECT_EMBARGO = (1 << 26);
export const MOVE_EFFECT_MAGNET_RISE = (1 << 27);
export const MOVE_EFFECT_CAMOUFLAGE = (1 << 28);
export const MOVE_EFFECT_SHADOW_FORCE = (1 << 29);
export const MOVE_EFFECT_IMPRISONED = (1 << 30); // applied to mons which are affected by Imprison
export const MOVE_EFFECT_LEECH_SEED_RECIPIENT = (MOVE_EFFECT_LEECH_SEED_RECIPIENT_0
  | MOVE_EFFECT_LEECH_SEED_RECIPIENT_1);
export const MOVE_EFFECT_LOCK_ON = (MOVE_EFFECT_LOCK_ON_0 | MOVE_EFFECT_LOCK_ON_1);
export const MOVE_EFFECT_YAWN = (MOVE_EFFECT_YAWN_0 | MOVE_EFFECT_YAWN_1);
export const MOVE_EFFECT_SEMI_INVULNERABLE = (MOVE_EFFECT_AIRBORNE | MOVE_EFFECT_UNDERGROUND | MOVE_EFFECT_UNDERWATER
  | MOVE_EFFECT_SHADOW_FORCE);
export const MOVE_EFFECT_BATON_PASSED = (MOVE_EFFECT_LEECH_SEED_RECIPIENT | MOVE_EFFECT_LEECH_SEED | MOVE_EFFECT_LOCK_ON
  | MOVE_EFFECT_PERISH_SONG | MOVE_EFFECT_INGRAIN | MOVE_EFFECT_MUD_SPORT | MOVE_EFFECT_WATER_SPORT
  | MOVE_EFFECT_NO_CRITICAL | MOVE_EFFECT_POWER_TRICK | MOVE_EFFECT_AQUA_RING | MOVE_EFFECT_ABILITY_SUPPRESSED
  | MOVE_EFFECT_EMBARGO | MOVE_EFFECT_HEAL_BLOCK | MOVE_EFFECT_MAGNET_RISE);
export const MOVE_EFFECT_NO_WEATHER_DAMAGE = (MOVE_EFFECT_UNDERGROUND | MOVE_EFFECT_UNDERWATER);

// include/constants/battle/moves.h:57–89 (BattleContext.moveStatusFlags)
export const MOVE_STATUS_MISSED = (1 << 0);
export const MOVE_STATUS_SUPER_EFFECTIVE = (1 << 1);
export const MOVE_STATUS_NOT_VERY_EFFECTIVE = (1 << 2);
export const MOVE_STATUS_INEFFECTIVE = (1 << 3);
export const MOVE_STATUS_CRITICAL_HIT = (1 << 4);
export const MOVE_STATUS_ONE_HIT_KO = (1 << 5);
export const MOVE_STATUS_FAILED = (1 << 6);
export const MOVE_STATUS_ENDURED = (1 << 7);
export const MOVE_STATUS_ENDURED_ITEM = (1 << 8);
export const MOVE_STATUS_NO_PP = (1 << 9);
export const MOVE_STATUS_BYPASSED_ACCURACY = (1 << 10);
export const MOVE_STATUS_LEVITATED = (1 << 11);
export const MOVE_STATUS_ONE_HIT_KO_FAILED = (1 << 12);
export const MOVE_STATUS_SPLASH = (1 << 13);
export const MOVE_STATUS_MULTI_HIT_DISRUPTED = (1 << 14);
export const MOVE_STATUS_PROTECTED = (1 << 15);
export const MOVE_STATUS_SEMI_INVULNERABLE = (1 << 16);
export const MOVE_STATUS_LOST_FOCUS = (1 << 17);
export const MOVE_STATUS_WONDER_GUARD = (1 << 18);
export const MOVE_STATUS_STURDY = (1 << 19);
export const MOVE_STATUS_MAGNET_RISE = (1 << 20);
export const MOVE_STATUS_NO_MORE_WORK = (1 << 31);
export const MOVE_STATUS_DID_NOT_HIT = (MOVE_STATUS_MISSED | MOVE_STATUS_INEFFECTIVE | MOVE_STATUS_FAILED
  | MOVE_STATUS_LEVITATED | MOVE_STATUS_ONE_HIT_KO_FAILED | MOVE_STATUS_MULTI_HIT_DISRUPTED | MOVE_STATUS_PROTECTED
  | MOVE_STATUS_SEMI_INVULNERABLE | MOVE_STATUS_LOST_FOCUS | MOVE_STATUS_WONDER_GUARD | MOVE_STATUS_STURDY
  | MOVE_STATUS_MAGNET_RISE);
export const MOVE_STATUS_NO_EFFECTS = (MOVE_STATUS_DID_NOT_HIT | MOVE_STATUS_NO_PP | MOVE_STATUS_NO_MORE_WORK);
export const MOVE_STATUS_DID_NOT_AFFECT = (MOVE_STATUS_INEFFECTIVE | MOVE_STATUS_WONDER_GUARD);
export const MOVE_STATUS_IMMUNE = (MOVE_STATUS_DID_NOT_AFFECT | MOVE_STATUS_LEVITATED | MOVE_STATUS_MAGNET_RISE);
export const MOVE_STATUS_GENERAL_MISS = (MOVE_STATUS_MISSED | MOVE_STATUS_SEMI_INVULNERABLE);
export const MOVE_STATUS_BASIC_EFFECTIVENESS = (MOVE_STATUS_SUPER_EFFECTIVE | MOVE_STATUS_NOT_VERY_EFFECTIVE);

// include/constants/battle/battle_script.h:4–6 (stat stages)
export const MIN_STAT_STAGE = 0;
export const DEFAULT_STAT_STAGE = 6;
export const MAX_STAT_STAGE = 12;

// include/constants/battle/system_control.h (BattleContext.battleStatusMask): the bits the helpers name
export const SYSCTL_LAST_OF_MULTI_TURN = (1 << 9);
export const SYSCTL_IGNORE_TYPE_CHECKS = (1 << 11);
export const SYSCTL_IGNORE_IMMUNITIES = (1 << 15);
export const SYSCTL_APPLY_MOLD_BREAKER = (1 << 23);

// include/constants/moves.h:8
export const LEARNED_MOVES_MAX = 4;

// include/constants/battle/trainer_ai.h:9–53
export const AI_INIT_SCORE_MOVE_1 = (1 << 0);
export const AI_INIT_SCORE_MOVE_2 = (1 << 1);
export const AI_INIT_SCORE_MOVE_3 = (1 << 2);
export const AI_INIT_SCORE_MOVE_4 = (1 << 3);
export const AI_INIT_SCORE_ALL_MOVES = (AI_INIT_SCORE_MOVE_1 | AI_INIT_SCORE_MOVE_2 | AI_INIT_SCORE_MOVE_3
  | AI_INIT_SCORE_MOVE_4);
export const AI_STATUS_FLAG_DONE = (1 << 0);
export const AI_STATUS_FLAG_ESCAPE = (1 << 1);
export const AI_STATUS_FLAG_SAFARI = (1 << 2);
export const AI_STATUS_FLAG_BREAK = (1 << 3);
export const AI_STATUS_FLAG_CONTINUE = (1 << 4);
export const AI_STATUS_FLAG_DONE_OFF = (AI_STATUS_FLAG_DONE ^ 0xFF);
export const AI_STATUS_FLAG_ESCAPE_OFF = (AI_STATUS_FLAG_ESCAPE ^ 0xFF);
export const AI_STATUS_FLAG_SAFARI_OFF = (AI_STATUS_FLAG_SAFARI ^ 0xFF);
export const AI_STATUS_FLAG_BREAK_OFF = (AI_STATUS_FLAG_BREAK ^ 0xFF);
export const AI_STATUS_FLAG_CONTINUE_OFF = (AI_STATUS_FLAG_CONTINUE ^ 0xFF);
export const AI_BATTLER_DEFENDER = 0;
export const AI_BATTLER_ATTACKER = 1;
export const AI_BATTLER_DEFENDER_PARTNER = (AI_BATTLER_DEFENDER ^ 2);
export const AI_BATTLER_ATTACKER_PARTNER = (AI_BATTLER_ATTACKER ^ 2);
export const AI_MAX_STACK_SIZE = 8;
export const AI_NO_COMPARISON_MADE = 0;
export const AI_NOT_HIGHEST_DAMAGE = 1;
export const AI_MOVE_IS_HIGHEST_DAMAGE = 2;
export const AI_NOT_HAVE = 0;
export const AI_HAVE = 1;
export const AI_UNKNOWN = 2;
export const USE_MAX_DAMAGE = 0;
export const ROLL_FOR_DAMAGE = 1;
export const CHECK_DISABLE = 0;
export const CHECK_ENCORE = 1;
export const CHECK_HIGHER_THAN_TARGET = 0;
export const CHECK_LOWER_THAN_TARGET = 1;
export const CHECK_EQUAL_TO_TARGET = 2;

// generated/ai_flags.txt, a metang `mask` list with --no-auto: line 1 is AI_FLAG_NONE (0), and lines 2–33 are bits
// 0–31, the order of the flag table's comments in script.s:18–50. The unused bits 11–28 and NONE/ALL are left out.
export const AI_FLAG_BASIC = 1 << 0;
export const AI_FLAG_EVAL_ATTACK = 1 << 1;
export const AI_FLAG_EXPERT = 1 << 2;
export const AI_FLAG_SETUP_FIRST_TURN = 1 << 3;
export const AI_FLAG_RISKY = 1 << 4;
export const AI_FLAG_PRIORITIZE_EXTREMES = 1 << 5;
export const AI_FLAG_BATON_PASS = 1 << 6;
export const AI_FLAG_TAG_STRATEGY = 1 << 7;
export const AI_FLAG_CHECK_HP = 1 << 8;
export const AI_FLAG_WEATHER = 1 << 9;
export const AI_FLAG_HARRASSMENT = 1 << 10;
export const AI_FLAG_ROAMING_POKEMON = 1 << 29;
export const AI_FLAG_SAFARI = 1 << 30;
export const AI_FLAG_CATCH_TUTORIAL = 1 << 31;

// generated/ai_load_type_targets.txt (metang enum; LoadTypeFrom's argument)
export const LOAD_DEFENDER_TYPE_1 = 0;
export const LOAD_ATTACKER_TYPE_1 = 1;
export const LOAD_DEFENDER_TYPE_2 = 2;
export const LOAD_ATTACKER_TYPE_2 = 3;
export const LOAD_MOVE_TYPE = 4;
export const LOAD_DEFENDER_PARTNER_TYPE_1 = 5;
export const LOAD_ATTACKER_PARTNER_TYPE_1 = 6;
export const LOAD_DEFENDER_PARTNER_TYPE_2 = 7;
export const LOAD_ATTACKER_PARTNER_TYPE_2 = 8;

// generated/ai_weather_types.txt (metang enum; LoadCurrentWeather's values)
export const AI_WEATHER_CLEAR = 0;
export const AI_WEATHER_SUNNY = 1;
export const AI_WEATHER_RAINING = 2;
export const AI_WEATHER_SANDSTORM = 3;
export const AI_WEATHER_HAILING = 4;
export const AI_WEATHER_DEEP_FOG = 5;

// generated/ai_action_choices.txt (metang enum)
export const AI_ENEMY_ATTACK_1 = 0;
export const AI_ENEMY_ATTACK_2 = 1;
export const AI_ENEMY_ATTACK_3 = 2;
export const AI_ENEMY_ATTACK_4 = 3;
export const AI_ENEMY_ESCAPE = 4;
export const AI_ENEMY_SAFARI = 5;
export const AI_ENEMY_SWITCH = 6;

/** BattleMon.statBoosts indices: generated/battle_stats.txt (metang enum). */
export const BATTLE_STAT = Object.freeze({
  HP: 0, ATTACK: 1, DEFENSE: 2, SPEED: 3, SP_ATTACK: 4, SP_DEFENSE: 5, ACCURACY: 6, EVASION: 7,
} as const);
export const BATTLE_STAT_MAX = 8;

/** MoveData.class: generated/move_classes.txt (metang enum: CLASS_PHYSICAL, CLASS_SPECIAL, CLASS_STATUS). */
export const MOVE_CLASS = Object.freeze({ PHYSICAL: 0, SPECIAL: 1, STATUS: 2 } as const);

/** The cartridge class of a MoveRecord category. */
export function moveClass(category: MoveCategory): number {
  if (category === 'physical') return MOVE_CLASS.PHYSICAL;
  return category === 'special' ? MOVE_CLASS.SPECIAL : MOVE_CLASS.STATUS;
}

// generated/pokemon_types.txt (metang enum; NUM_POKEMON_TYPES left out)
export const TYPE_NORMAL = 0;
export const TYPE_FIGHTING = 1;
export const TYPE_FLYING = 2;
export const TYPE_POISON = 3;
export const TYPE_GROUND = 4;
export const TYPE_ROCK = 5;
export const TYPE_BUG = 6;
export const TYPE_GHOST = 7;
export const TYPE_STEEL = 8;
export const TYPE_MYSTERY = 9;
export const TYPE_FIRE = 10;
export const TYPE_WATER = 11;
export const TYPE_GRASS = 12;
export const TYPE_ELECTRIC = 13;
export const TYPE_PSYCHIC = 14;
export const TYPE_ICE = 15;
export const TYPE_DRAGON = 16;
export const TYPE_DARK = 17;

// generated/genders.txt (metang enum)
export const GENDER_MALE = 0;
export const GENDER_FEMALE = 1;
export const GENDER_NONE = 2;

// generated/item_ai_categories.txt (metang enum; AI_CONTEXT.usedItemType)
export const ITEM_AI_CATEGORY_FULL_RESTORE = 0;
export const ITEM_AI_CATEGORY_RECOVER_HP = 1;
export const ITEM_AI_CATEGORY_RECOVER_STATUS = 2;
export const ITEM_AI_CATEGORY_STAT_BOOSTER = 3;
export const ITEM_AI_CATEGORY_GUARD_SPEC = 4;
export const ITEM_AI_CATEGORY_MAX = 5;

// generated/item_hold_effects.txt (metang enum): the hold effects the C reads, incl. its tables
// sSpeedHalvingItemEffects (battle_lib.c:1160) and sTypeBoostingItems (battle_lib.c:6514)
export const HOLD_EFFECT_GIRATINA_BOOST = 2;
export const HOLD_EFFECT_DIALGA_BOOST = 3;
export const HOLD_EFFECT_PALKIA_BOOST = 4;
export const HOLD_EFFECT_PINCH_PRIORITY = 45;
export const HOLD_EFFECT_EVS_UP_SPEED_DOWN = 50;
export const HOLD_EFFECT_SOMETIMES_PRIORITY = 52;
export const HOLD_EFFECT_CHOICE_ATK = 55;
export const HOLD_EFFECT_STRENGTHEN_BUG = 57;
export const HOLD_EFFECT_LATI_SPECIAL = 60;
export const HOLD_EFFECT_CLAMPERL_SPATK = 61;
export const HOLD_EFFECT_CLAMPERL_SPDEF = 62;
export const HOLD_EFFECT_STRENGTHEN_STEEL = 68;
export const HOLD_EFFECT_PIKA_SPATK_UP = 71;
export const HOLD_EFFECT_STRENGTHEN_GROUND = 72;
export const HOLD_EFFECT_STRENGTHEN_ROCK = 73;
export const HOLD_EFFECT_STRENGTHEN_GRASS = 74;
export const HOLD_EFFECT_STRENGTHEN_DARK = 75;
export const HOLD_EFFECT_STRENGTHEN_FIGHT = 76;
export const HOLD_EFFECT_STRENGTHEN_ELECTRIC = 77;
export const HOLD_EFFECT_STRENGTHEN_WATER = 78;
export const HOLD_EFFECT_STRENGTHEN_FLYING = 79;
export const HOLD_EFFECT_STRENGTHEN_POISON = 80;
export const HOLD_EFFECT_STRENGTHEN_ICE = 81;
export const HOLD_EFFECT_STRENGTHEN_GHOST = 82;
export const HOLD_EFFECT_STRENGTHEN_PSYCHIC = 83;
export const HOLD_EFFECT_STRENGTHEN_FIRE = 84;
export const HOLD_EFFECT_STRENGTHEN_DRAGON = 85;
export const HOLD_EFFECT_STRENGTHEN_NORMAL = 86;
export const HOLD_EFFECT_DITTO_DEF_UP = 90;
export const HOLD_EFFECT_CUBONE_ATK_UP = 91;
export const HOLD_EFFECT_POWER_UP_PHYS = 94;
export const HOLD_EFFECT_POWER_UP_SPEC = 95;
export const HOLD_EFFECT_POWER_UP_SE = 96;
export const HOLD_EFFECT_DITTO_SPEED_UP = 102;
export const HOLD_EFFECT_SPEED_DOWN_GROUNDED = 106;
export const HOLD_EFFECT_PRIORITY_DOWN = 107;
export const HOLD_EFFECT_CHOICE_SPEED = 115;
export const HOLD_EFFECT_LVLUP_ATK_EV_UP = 117;
export const HOLD_EFFECT_LVLUP_DEF_EV_UP = 118;
export const HOLD_EFFECT_LVLUP_SPATK_EV_UP = 119;
export const HOLD_EFFECT_LVLUP_SPDEF_EV_UP = 120;
export const HOLD_EFFECT_LVLUP_SPEED_EV_UP = 121;
export const HOLD_EFFECT_LVLUP_HP_EV_UP = 122;
export const HOLD_EFFECT_CHOICE_SPATK = 125;
export const HOLD_EFFECT_ARCEUS_FIRE = 126;
export const HOLD_EFFECT_ARCEUS_WATER = 127;
export const HOLD_EFFECT_ARCEUS_ELECTRIC = 128;
export const HOLD_EFFECT_ARCEUS_GRASS = 129;
export const HOLD_EFFECT_ARCEUS_ICE = 130;
export const HOLD_EFFECT_ARCEUS_FIGHTING = 131;
export const HOLD_EFFECT_ARCEUS_POISON = 132;
export const HOLD_EFFECT_ARCEUS_GROUND = 133;
export const HOLD_EFFECT_ARCEUS_FLYING = 134;
export const HOLD_EFFECT_ARCEUS_PSYCHIC = 135;
export const HOLD_EFFECT_ARCEUS_BUG = 136;
export const HOLD_EFFECT_ARCEUS_ROCK = 137;
export const HOLD_EFFECT_ARCEUS_GHOST = 138;
export const HOLD_EFFECT_ARCEUS_DRAGON = 139;
export const HOLD_EFFECT_ARCEUS_DARK = 140;
export const HOLD_EFFECT_ARCEUS_STEEL = 141;

// generated/items.txt (metang enum): the items the C names
export const ITEM_NONE = 0;
export const ITEM_FULL_RESTORE = 23;

// generated/moves.txt (metang enum): the moves the C names, incl. its tables sMovesAffectedByGravity
// (battle_lib.c:3385), sMovesAffectedByHealBlock (battle_lib.c:3410) and sPunchingMoves (battle_lib.c:6566)
export const MOVE_NONE = 0;
export const MOVE_COMET_PUNCH = 4;
export const MOVE_MEGA_PUNCH = 5;
export const MOVE_FIRE_PUNCH = 7;
export const MOVE_ICE_PUNCH = 8;
export const MOVE_THUNDER_PUNCH = 9;
export const MOVE_FLY = 19;
export const MOVE_JUMP_KICK = 26;
export const MOVE_SONIC_BOOM = 49;
export const MOVE_LOW_KICK = 67;
export const MOVE_SEISMIC_TOSS = 69;
export const MOVE_SOLAR_BEAM = 76;
export const MOVE_DRAGON_RAGE = 82;
export const MOVE_NIGHT_SHADE = 101;
export const MOVE_RECOVER = 105;
export const MOVE_SOFTBOILED = 135;
export const MOVE_HI_JUMP_KICK = 136;
export const MOVE_DIZZY_PUNCH = 146;
export const MOVE_PSYWAVE = 149;
export const MOVE_SPLASH = 150;
export const MOVE_REST = 156;
export const MOVE_STRUGGLE = 165;
export const MOVE_CURSE = 174;
export const MOVE_PROTECT = 182;
export const MOVE_MACH_PUNCH = 183;
export const MOVE_DETECT = 197;
export const MOVE_ENDURE = 203;
export const MOVE_MILK_DRINK = 208;
export const MOVE_SLEEP_TALK = 214;
export const MOVE_RETURN = 216;
export const MOVE_FRUSTRATION = 218;
export const MOVE_MAGNITUDE = 222;
export const MOVE_DYNAMIC_PUNCH = 223;
export const MOVE_MORNING_SUN = 234;
export const MOVE_SYNTHESIS = 235;
export const MOVE_MOONLIGHT = 236;
export const MOVE_HIDDEN_POWER = 237;
export const MOVE_SWALLOW = 256;
export const MOVE_HAIL = 258;
export const MOVE_FOCUS_PUNCH = 264;
export const MOVE_WISH = 273;
export const MOVE_RECYCLE = 278;
export const MOVE_IMPRISON = 286;
export const MOVE_SLACK_OFF = 303;
export const MOVE_DEFOG = 432;
export const MOVE_METEOR_MASH = 309;
export const MOVE_WEATHER_BALL = 311;
export const MOVE_SHADOW_PUNCH = 325;
export const MOVE_SKY_UPPERCUT = 327;
export const MOVE_BOUNCE = 340;
export const MOVE_ROOST = 355;
export const MOVE_HAMMER_ARM = 359;
export const MOVE_GYRO_BALL = 360;
export const MOVE_HEALING_WISH = 361;
export const MOVE_NATURAL_GIFT = 363;
export const MOVE_MAGNET_RISE = 393;
export const MOVE_DRAIN_PUNCH = 409;
export const MOVE_BULLET_PUNCH = 418;
export const MOVE_GRASS_KNOT = 447;
export const MOVE_JUDGMENT = 449;
export const MOVE_HEAL_ORDER = 456;
export const MOVE_LUNAR_DANCE = 461;

// generated/abilities.txt (metang enum): the abilities the C names
export const ABILITY_NONE = 0;
export const ABILITY_VOLT_ABSORB = 10;
export const ABILITY_WATER_ABSORB = 11;
export const ABILITY_CLOUD_NINE = 13;
export const ABILITY_FLASH_FIRE = 18;
export const ABILITY_SHADOW_TAG = 23;
export const ABILITY_WONDER_GUARD = 25;
export const ABILITY_LEVITATE = 26;
export const ABILITY_NATURAL_CURE = 30;
export const ABILITY_SWIFT_SWIM = 33;
export const ABILITY_CHLOROPHYLL = 34;
export const ABILITY_HUGE_POWER = 37;
export const ABILITY_MAGNET_PULL = 42;
export const ABILITY_THICK_FAT = 47;
export const ABILITY_HUSTLE = 55;
export const ABILITY_PLUS = 57;
export const ABILITY_MINUS = 58;
export const ABILITY_GUTS = 62;
export const ABILITY_MARVEL_SCALE = 63;
export const ABILITY_OVERGROW = 65;
export const ABILITY_BLAZE = 66;
export const ABILITY_TORRENT = 67;
export const ABILITY_SWARM = 68;
export const ABILITY_ARENA_TRAP = 71;
export const ABILITY_PURE_POWER = 74;
export const ABILITY_AIR_LOCK = 76;
export const ABILITY_RIVALRY = 79;
export const ABILITY_GLUTTONY = 82;
export const ABILITY_UNBURDEN = 84;
export const ABILITY_HEATPROOF = 85;
export const ABILITY_SIMPLE = 86;
export const ABILITY_DRY_SKIN = 87;
export const ABILITY_IRON_FIST = 89;
export const ABILITY_ADAPTABILITY = 91;
export const ABILITY_SOLAR_POWER = 94;
export const ABILITY_QUICK_FEET = 95;
export const ABILITY_NORMALIZE = 96;
export const ABILITY_STALL = 100;
export const ABILITY_TECHNICIAN = 101;
export const ABILITY_KLUTZ = 103;
export const ABILITY_MOLD_BREAKER = 104;
export const ABILITY_UNAWARE = 109;
export const ABILITY_TINTED_LENS = 110;
export const ABILITY_FILTER = 111;
export const ABILITY_SLOW_START = 112;
export const ABILITY_SCRAPPY = 113;
export const ABILITY_SOLID_ROCK = 116;
export const ABILITY_MULTITYPE = 121;
export const ABILITY_FLOWER_GIFT = 122;

// generated/move_battle_effects.txt (metang enum): the move effects the C names
export const BATTLE_EFFECT_HALVE_DEFENSE = 7;
export const BATTLE_EFFECT_RECOVER_DAMAGE_SLEEP = 8;
export const BATTLE_EFFECT_BIDE = 26;
export const BATTLE_EFFECT_CHARGE_TURN_HIGH_CRIT = 39;
export const BATTLE_EFFECT_40_DAMAGE_FLAT = 41;
export const BATTLE_EFFECT_CHARGE_TURN_HIGH_CRIT_FLINCH = 75;
export const BATTLE_EFFECT_RECHARGE_AFTER = 80;
export const BATTLE_EFFECT_LEVEL_DAMAGE_FLAT = 87;
export const BATTLE_EFFECT_RANDOM_DAMAGE_1_TO_150_LEVEL = 88;
export const BATTLE_EFFECT_POWER_BASED_ON_FRIENDSHIP = 121;
export const BATTLE_EFFECT_POWER_BASED_ON_LOW_FRIENDSHIP = 123;
export const BATTLE_EFFECT_20_DAMAGE_FLAT = 130;
export const BATTLE_EFFECT_RANDOM_POWER_BASED_ON_IVS = 135;
export const BATTLE_EFFECT_CHARGE_TURN_DEF_UP = 145;
export const BATTLE_EFFECT_SKIP_CHARGE_TURN_IN_SUN = 151;
export const BATTLE_EFFECT_FLY = 155;
export const BATTLE_EFFECT_SPIT_UP = 161;
export const BATTLE_EFFECT_HIT_LAST_WHIFF_IF_HIT = 170;
export const BATTLE_EFFECT_LOWER_OWN_ATK_AND_DEF = 182;
export const BATTLE_EFFECT_REMOVE_SCREENS = 186;
export const BATTLE_EFFECT_DECREASE_POWER_WITH_LESS_USER_HP = 190;
export const BATTLE_EFFECT_INCREASE_POWER_WITH_WEIGHT = 196;
export const BATTLE_EFFECT_POWER_BASED_ON_LOW_SPEED = 219;
export const BATTLE_EFFECT_NATURAL_GIFT = 222;
export const BATTLE_EFFECT_HIT_FIRST_IF_TARGET_ATTACKING = 248;
export const BATTLE_EFFECT_DIVE = 255;
export const BATTLE_EFFECT_DIG = 256;
export const BATTLE_EFFECT_BOUNCE = 263;
export const BATTLE_EFFECT_JUDGEMENT = 268;
export const BATTLE_EFFECT_RECOIL_HALF = 269;
export const BATTLE_EFFECT_FLINCH_BURN_HIT = 273;

// generated/species.txt (metang enum): the species the C names
export const SPECIES_NONE = 0;
export const SPECIES_PIKACHU = 25;
export const SPECIES_CUBONE = 104;
export const SPECIES_MAROWAK = 105;
export const SPECIES_DITTO = 132;
export const SPECIES_CLAMPERL = 366;
export const SPECIES_LATIAS = 380;
export const SPECIES_LATIOS = 381;
export const SPECIES_DIALGA = 483;
export const SPECIES_PALKIA = 484;
export const SPECIES_GIRATINA = 487;
export const SPECIES_ARCEUS = 493;
export const SPECIES_EGG = 494;

// generated/move_ranges.txt, a metang `mask` list with --no-auto: line 1 is RANGE_SINGLE_TARGET (0), and line n > 1 is
// bit n − 2. Vanilla move data agrees (Rock Slide 4 = ADJACENT_OPPONENTS, Earthquake 8 = ALL_ADJACENT, Helping Hand
// 0x100 = ALLY, Acupressure 0x200 = USER_OR_ALLY). The ranges the C names:
export const RANGE_ADJACENT_OPPONENTS = 1 << 2;
export const RANGE_ALL_ADJACENT = 1 << 3;
export const RANGE_USER_OR_ALLY = 1 << 9;

// include/battle/battle_lib.h:15 (enum CountAbilityMode: BattleSystem_CountAbility's mode)
export const COUNT_ALL_BATTLERS_OUR_SIDE = 0;
export const COUNT_ALIVE_BATTLERS_OUR_SIDE = 1;
export const COUNT_ALL_BATTLERS_THEIR_SIDE = 2;
export const COUNT_ALIVE_BATTLERS_THEIR_SIDE = 3;
export const COUNT_ALIVE_BATTLERS_THEIR_SIDE_FLAG = 4;
export const COUNT_ALL_BATTLERS = 5;
export const COUNT_ALL_BATTLERS_EXCEPT_ME = 6;
export const COUNT_ALL_BATTLERS_EXCEPT_ME_RETURN_BATTLER = 7;
export const COUNT_ALIVE_BATTLERS = 8;
export const COUNT_ALIVE_BATTLERS_EXCEPT_ME = 9;

// include/battle/battle_lib.h:1011 (enum HeldItemPowerOp: Battler_HeldItemPower's mode)
export const ITEM_POWER_CHECK_ALL = 0;
export const ITEM_POWER_CHECK_NONE = 1;
export const ITEM_POWER_CHECK_EMBARGO = 2;
