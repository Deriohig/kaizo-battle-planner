// The opcodes that read battle state with no damage, speed, ability, party or knowledge helper: HP, status, side and
// field conditions, stat stages, stored stats, types, levels, move data, turn counters and the switching mask.

import { describe } from 'vitest';
import {
  AI_WEATHER_CLEAR, AI_WEATHER_DEEP_FOG, AI_WEATHER_HAILING, AI_WEATHER_RAINING, AI_WEATHER_SANDSTORM, AI_WEATHER_SUNNY,
  BATTLE_STAT, BATTLE_TYPE_FRONTIER, BATTLE_TYPE_TRAINER, BATTLE_TYPE_TRAINER_SINGLES, CHECK_DISABLE, CHECK_ENCORE,
  CHECK_EQUAL_TO_TARGET, CHECK_HIGHER_THAN_TARGET, CHECK_LOWER_THAN_TARGET, FIELD_CONDITION_DEEP_FOG,
  FIELD_CONDITION_HAILING_PERM, FIELD_CONDITION_RAINING, FIELD_CONDITION_RAINING_TEMP, FIELD_CONDITION_SANDSTORM_TEMP,
  FIELD_CONDITION_SUNNY_PERM, FIELD_CONDITION_TRICK_ROOM, FIELD_CONDITION_TRICK_ROOM_0, GENDER_FEMALE,
  LOAD_ATTACKER_PARTNER_TYPE_1, LOAD_ATTACKER_PARTNER_TYPE_2, LOAD_ATTACKER_TYPE_1, LOAD_ATTACKER_TYPE_2,
  LOAD_DEFENDER_PARTNER_TYPE_1, LOAD_DEFENDER_PARTNER_TYPE_2, LOAD_DEFENDER_TYPE_1, LOAD_DEFENDER_TYPE_2,
  LOAD_MOVE_TYPE, MON_CONDITION_BURN, MON_CONDITION_PARALYSIS, MOVE_CLASS, MOVE_DETECT, MOVE_EFFECT_LEECH_SEED,
  MOVE_EFFECT_PERISH_SONG, MOVE_ENDURE, MOVE_PROTECT, SIDE_CONDITION_LIGHT_SCREEN, SIDE_CONDITION_REFLECT,
  SIDE_CONDITION_SPIKES, SIDE_CONDITION_TOXIC_SPIKES, TYPE_DRAGON, TYPE_ELECTRIC, TYPE_FLYING, TYPE_GROUND, TYPE_WATER,
  VOLATILE_CONDITION_CONFUSION, VOLATILE_CONDITION_TORMENT,
} from '../../../src/ai/constants.js';
import { FX, fixtureView } from './fixtures.js';
import {
  AI, ATK, ATK_PARTNER, branches, DEF, DEF_PARTNER, loads, mon, type Opts, PLAYER, playerAt, throws, viewWith,
} from './opsHarness.js';

const M = FX.move;
const S = BATTLE_STAT;
const PARA = MON_CONDITION_PARALYSIS;
const BURN = MON_CONDITION_BURN;
const LEECH = MOVE_EFFECT_LEECH_SEED;
const REFLECT = SIDE_CONDITION_REFLECT;

describe('state branches', () => {
  const paralyzed = mon(PLAYER, { status: PARA });
  const torment = mon(PLAYER, { statusVolatile: VOLATILE_CONDITION_TORMENT }); // bit 31: a negative mask word
  const leech = mon(AI, { moveEffectsMask: LEECH });
  const reflect = fixtureView({ sideConditionsMask: [0, REFLECT] });
  const plusTwo = viewWith((v) => { v.mons[PLAYER].statBoosts[S.ATTACK] = 8; });
  const disabled = mon(PLAYER, { effects: { disabledTurns: 2 } });
  const encored = mon(PLAYER, { effects: { disabledTurns: 2, encoredTurns: 1 } });
  const locked = mon(AI, { effects: { disabledMove: M.DRAGON_CLAW, encoredMove: M.EARTHQUAKE } });
  const taunted = mon(PLAYER, { effects: { tauntedTurns: 2 } });
  const partnerUp = fixtureView({ battlersSwitchingMask: 1 << 2 });
  const lastResort = (lastResortCount: number, moves: number[] = [M.DRAGON_CLAW, M.EARTHQUAKE, M.CRUNCH, M.FIRE_FANG]) =>
    ({ v: mon(AI, { moves, effects: { lastResortCount } }) });
  const speedTie = mon(PLAYER, { speed: 122 });
  const flashFire = mon(AI, { effects: { flashFire: true } });
  const trickRoom = fixtureView({ fieldConditionsMask: FIELD_CONDITION_TRICK_ROOM_0 });

  branches([
    // curHP * 100 / maxHP as u32 (trainer_ai.c:596–643): 77 of 155 is 49, 78 is 50.
    [`IfHPPercentLessThan ${DEF}, 50, Taken`, true, { v: playerAt(77) }],
    [`IfHPPercentLessThan ${DEF}, 50, Taken`, false, { v: playerAt(78) }],
    [`IfHPPercentLessThan ${ATK}, 100, Taken`, false, { v: playerAt(77) }],
    [`IfHPPercentGreaterThan ${DEF}, 49, Taken`, true, { v: playerAt(78) }],
    [`IfHPPercentGreaterThan ${DEF}, 49, Taken`, false, { v: playerAt(77) }],
    [`IfHPPercentGreaterThan ${DEF}, -1, Taken`, false], // the int target as u32: 100 > 0xFFFFFFFF is false
    [`IfHPPercentEqualTo ${DEF}, 50, Taken`, true, { v: playerAt(78) }],
    [`IfHPPercentEqualTo ${DEF}, 50, Taken`, false, { v: playerAt(77) }],
    [`IfHPPercentNotEqualTo ${DEF}, 50, Taken`, true, { v: playerAt(77) }],
    [`IfHPPercentNotEqualTo ${DEF}, 50, Taken`, false, { v: playerAt(78) }],
    // The singles partners are the empty slots 3 and 2 (trainer_ai.c:2777–2780), HP 0/0. The cartridge's divide gives
    // the dividend for a zero divisor, so 0 * 100 / 0 is 0, as TagStrategy relies on (script.s:6663).
    ...[ATK_PARTNER, DEF_PARTNER].flatMap((p): [string, boolean][] => [
      [`IfHPPercentEqualTo ${p}, 0, Taken`, true], [`IfHPPercentNotEqualTo ${p}, 0, Taken`, false],
      [`IfHPPercentLessThan ${p}, 1, Taken`, true], [`IfHPPercentGreaterThan ${p}, 0, Taken`, false],
    ]),
    // The battler code is a u8, and anything but 1–3 is the defender (trainer_ai.c:2765–2774).
    [`IfStatus 4, ${BURN}, Taken`, false, { v: mon(AI, { status: BURN }) }],
    [`IfStatus ${256 + ATK}, ${BURN}, Taken`, true, { v: mon(AI, { status: BURN }) }],
    // Status, volatile and move-effect masks (trainer_ai.c:657–727).
    [`IfStatus ${DEF}, ${PARA}, Taken`, true, { v: paralyzed }],
    [`IfStatus ${DEF}, ${BURN}, Taken`, false, { v: paralyzed }],
    [`IfStatus ${ATK}, ${PARA}, Taken`, false, { v: paralyzed }],
    [`IfNotStatus ${DEF}, ${BURN}, Taken`, true, { v: paralyzed }],
    [`IfNotStatus ${DEF}, ${PARA}, Taken`, false, { v: paralyzed }],
    [`IfVolatileStatus ${DEF}, ${VOLATILE_CONDITION_TORMENT}, Taken`, true, { v: torment }],
    [`IfVolatileStatus ${DEF}, ${VOLATILE_CONDITION_CONFUSION}, Taken`, false, { v: torment }],
    [`IfNotVolatileStatus ${DEF}, ${VOLATILE_CONDITION_CONFUSION}, Taken`, true, { v: torment }],
    [`IfNotVolatileStatus ${DEF}, ${VOLATILE_CONDITION_TORMENT}, Taken`, false, { v: torment }],
    [`IfMoveEffect ${ATK}, ${LEECH}, Taken`, true, { v: leech }],
    [`IfMoveEffect ${DEF}, ${LEECH}, Taken`, false, { v: leech }],
    [`IfMoveEffect ${ATK}, ${MOVE_EFFECT_PERISH_SONG}, Taken`, false, { v: leech }],
    [`IfNotMoveEffect ${DEF}, ${LEECH}, Taken`, true, { v: leech }],
    [`IfNotMoveEffect ${ATK}, ${LEECH}, Taken`, false, { v: leech }],
    // By the battler's side (trainer_ai.c:740–757): the AI and its empty partner slot 3 are side 1.
    [`IfSideCondition ${ATK}, ${REFLECT}, Taken`, true, { v: reflect }],
    [`IfSideCondition ${ATK_PARTNER}, ${REFLECT}, Taken`, true, { v: reflect }],
    [`IfSideCondition ${DEF}, ${REFLECT}, Taken`, false, { v: reflect }],
    [`IfSideCondition ${ATK}, ${SIDE_CONDITION_LIGHT_SCREEN}, Taken`, false, { v: reflect }],
    [`IfNotSideCondition ${DEF}, ${REFLECT}, Taken`, true, { v: reflect }],
    [`IfNotSideCondition ${ATK}, ${REFLECT}, Taken`, false, { v: reflect }],
    // Any slot whose move has power, PP ignored (trainer_ai.c:901–926).
    ['IfAttackerHasDamagingMoves Taken', true],
    ['IfAttackerHasDamagingMoves Taken', false, { v: mon(AI, { moves: [M.DRAGON_DANCE, M.PROTECT, 0, 0] }) }],
    ['IfAttackerHasDamagingMoves Taken', true, { v: mon(AI, { moves: [0, M.DRAGON_DANCE, 0, M.EARTHQUAKE], ppCur: [0, 20, 0, 0] }) }],
    ['IfAttackerHasNoDamagingMoves Taken', false],
    ['IfAttackerHasNoDamagingMoves Taken', true, { v: mon(AI, { moves: [M.DRAGON_DANCE, M.PROTECT, 0, 0] }) }],
    // Dragon Claw's effect is 0, Earthquake's 147 (trainer_ai.c:1448–1460).
    ['IfCurrentMoveEffectEqualTo 0, Taken', true], ['IfCurrentMoveEffectEqualTo 147, Taken', false],
    ['IfCurrentMoveEffectEqualTo 147, Taken', true, { slot: 1 }],
    ['IfCurrentMoveEffectNotEqualTo 147, Taken', true], ['IfCurrentMoveEffectNotEqualTo 0, Taken', false],
    // The player's Attack at +2, stage 8 (trainer_ai.c:1475–1520).
    [`IfStatStageLessThan ${DEF}, ${S.ATTACK}, 9, Taken`, true, { v: plusTwo }],
    [`IfStatStageLessThan ${DEF}, ${S.ATTACK}, 8, Taken`, false, { v: plusTwo }],
    [`IfStatStageGreaterThan ${DEF}, ${S.ATTACK}, 7, Taken`, true, { v: plusTwo }],
    [`IfStatStageGreaterThan ${ATK}, ${S.ATTACK}, 7, Taken`, false, { v: plusTwo }],
    [`IfStatStageEqualTo ${DEF}, ${S.ATTACK}, 8, Taken`, true, { v: plusTwo }],
    [`IfStatStageEqualTo ${DEF}, ${S.DEFENSE}, 8, Taken`, false, { v: plusTwo }],
    [`IfStatStageNotEqualTo ${DEF}, ${S.DEFENSE}, 8, Taken`, true, { v: plusTwo }],
    [`IfStatStageNotEqualTo ${DEF}, ${S.ATTACK}, 8, Taken`, false, { v: plusTwo }],
    // Disable and Encore turns (trainer_ai.c:1833–1846); any other check is false.
    [`IfBattlerUnderEffect ${DEF}, ${CHECK_DISABLE}, Taken`, true, { v: disabled }],
    [`IfBattlerUnderEffect ${DEF}, ${CHECK_ENCORE}, Taken`, false, { v: disabled }],
    [`IfBattlerUnderEffect ${ATK}, ${CHECK_DISABLE}, Taken`, false, { v: disabled }],
    [`IfBattlerUnderEffect ${DEF}, ${CHECK_ENCORE}, Taken`, true, { v: encored }],
    [`IfBattlerUnderEffect ${DEF}, 2, Taken`, false, { v: encored }],
    // The AI's own disabled or encored move against AI_CONTEXT.move (trainer_ai.c:1857–1872).
    [`IfCurrentMoveMatchesEffect ${CHECK_DISABLE}, Taken`, true, { v: locked }],
    [`IfCurrentMoveMatchesEffect ${CHECK_DISABLE}, Taken`, false, { v: locked, slot: 1 }],
    [`IfCurrentMoveMatchesEffect ${CHECK_ENCORE}, Taken`, true, { v: locked, slot: 1 }],
    [`IfCurrentMoveMatchesEffect ${CHECK_ENCORE}, Taken`, false, { v: locked }],
    ['IfCurrentMoveMatchesEffect 2, Taken', false, { v: locked }],
    // The AI's level against the defender's, both 50 (trainer_ai.c:2586–2607).
    [`IfLevel ${CHECK_EQUAL_TO_TARGET}, Taken`, true], [`IfLevel ${CHECK_HIGHER_THAN_TARGET}, Taken`, false],
    [`IfLevel ${CHECK_LOWER_THAN_TARGET}, Taken`, false],
    [`IfLevel ${CHECK_HIGHER_THAN_TARGET}, Taken`, true, { v: mon(AI, { level: 60 }) }],
    [`IfLevel ${CHECK_EQUAL_TO_TARGET}, Taken`, false, { v: mon(AI, { level: 60 }) }],
    [`IfLevel ${CHECK_LOWER_THAN_TARGET}, Taken`, true, { v: mon(PLAYER, { level: 60 }) }],
    ['IfLevel 3, Taken', false, { v: mon(PLAYER, { level: 60 }) }],
    ['IfTargetIsTaunted Taken', true, { v: taunted }], ['IfTargetIsTaunted Taken', false], // trainer_ai.c:2615–2625
    ['IfTargetIsNotTaunted Taken', true], ['IfTargetIsNotTaunted Taken', false, { v: taunted }],
    [`IfActivatedFlashFire ${ATK}, Taken`, true, { v: flashFire }], [`IfActivatedFlashFire ${DEF}, Taken`, false, { v: flashFire }],
    [`IfFieldConditionsMask ${FIELD_CONDITION_TRICK_ROOM}, Taken`, true, { v: trickRoom }],
    [`IfFieldConditionsMask ${FIELD_CONDITION_RAINING}, Taken`, false, { v: trickRoom }],
    // lastResortCount >= numKnownMoves - 1 && numKnownMoves > 1 (trainer_ai.c:2039), counting up to the first empty
    // slot (battle_lib.c:3461).
    [`IfCanUseLastResort ${ATK}, Taken`, true, lastResort(3)],
    [`IfCanUseLastResort ${ATK}, Taken`, false, lastResort(2)],
    [`IfCanUseLastResort ${ATK}, Taken`, true, lastResort(1, [M.DRAGON_CLAW, M.EARTHQUAKE, 0, M.CRUNCH])],
    [`IfCanUseLastResort ${ATK}, Taken`, false, lastResort(0, [M.DRAGON_CLAW, 0, 0, 0])],
    // The stored stats (trainer_ai.c:2282–2336): Atk 150 against 140, SpA 100 against 115; HP compares curHP.
    [`IfBattlerHasHigherStat ${DEF}, ${S.SP_ATTACK}, Taken`, true], [`IfBattlerHasHigherStat ${DEF}, ${S.ATTACK}, Taken`, false],
    [`IfBattlerHasLowerStat ${DEF}, ${S.ATTACK}, Taken`, true], [`IfBattlerHasLowerStat ${DEF}, ${S.SP_ATTACK}, Taken`, false],
    [`IfBattlerHasEqualStat ${DEF}, ${S.SPEED}, Taken`, true, { v: speedTie }], [`IfBattlerHasEqualStat ${DEF}, ${S.SPEED}, Taken`, false],
    [`IfBattlerHasEqualStat ${DEF}, ${S.HP}, Taken`, true, { v: mon(PLAYER, { maxHP: 200, curHP: 183 }) }],
    // battlersSwitchingMask & FlagIndex(battler) (trainer_ai.c:2449–2465); singles set the empty slots 2 and 3.
    [`IfBattlerFainted ${DEF_PARTNER}, Taken`, true], [`IfBattlerFainted ${ATK_PARTNER}, Taken`, true],
    [`IfBattlerFainted ${ATK_PARTNER}, Taken`, false, { v: partnerUp }],
    [`IfBattlerNotFainted ${ATK_PARTNER}, Taken`, true, { v: partnerUp }],
    [`IfBattlerNotFainted ${DEF_PARTNER}, Taken`, false, { v: partnerUp }],
  ]);

  // A stat without a case leaves both values uninitialised (trainer_ai.c:2363–2365).
  throws([[`IfBattlerHasHigherStat ${DEF}, ${S.ACCURACY}, Taken`, 'UNDEFINED']]);
});

describe('state loads', () => {
  const waterFlying = mon(PLAYER, { types: [TYPE_WATER, TYPE_FLYING] });
  const prev = fixtureView({ movePrevByBattler: [M.CRUNCH, M.EARTHQUAKE, 0, 0] });
  const weather = (fieldConditionsMask: number): Opts => ({ v: fixtureView({ fieldConditionsMask }), calcTemp: 9 });
  const protect = (moveProtect: number): Opts =>
    ({ v: mon(PLAYER, { effects: { protectSuccessTurns: 2 } }, fixtureView({ moveProtect: [moveProtect, 0, 0, 0] })), calcTemp: 9 });
  const spikes = fixtureView({ sideConditions: [{ spikesLayers: 2, toxicSpikesLayers: 1 }, { spikesLayers: 0, toxicSpikesLayers: 0 }] });
  const lastUsed = (move: number): Opts => ({ v: fixtureView({ movePrevByBattler: [move, M.WATER_GUN, 0, 0] }), calcTemp: 9 });
  const stockpile = mon(AI, { effects: { stockpileCount: 2 } });
  const stages = viewWith((v) => {
    v.mons[PLAYER].statBoosts = [6, 8, 4, 12, 6, 7, 6, 6];
    v.mons[AI].statBoosts[S.ATTACK] = 5;
  });

  loads([
    ['LoadTurnCount', 0, { calcTemp: 9 }], ['LoadTurnCount', 5, { v: fixtureView({ totalTurns: 5 }) }], // trainer_ai.c:934
    // The player made Water/Flying (trainer_ai.c:945–983). The partner is the battler itself in singles
    // (battle_system.c:400–402), and LOAD_DEFENDER_PARTNER_TYPE_2 loads type 1 by a bug (:980–983).
    [`LoadTypeFrom ${LOAD_DEFENDER_TYPE_1}`, TYPE_WATER, { v: waterFlying }],
    [`LoadTypeFrom ${LOAD_ATTACKER_TYPE_1}`, TYPE_DRAGON, { v: waterFlying }],
    [`LoadTypeFrom ${LOAD_DEFENDER_TYPE_2}`, TYPE_FLYING, { v: waterFlying }],
    [`LoadTypeFrom ${LOAD_ATTACKER_TYPE_2}`, TYPE_GROUND, { v: waterFlying }],
    [`LoadTypeFrom ${LOAD_MOVE_TYPE}`, TYPE_GROUND, { v: waterFlying, slot: 1 }],
    [`LoadTypeFrom ${LOAD_DEFENDER_PARTNER_TYPE_1}`, TYPE_WATER, { v: waterFlying }],
    [`LoadTypeFrom ${LOAD_ATTACKER_PARTNER_TYPE_1}`, TYPE_DRAGON, { v: waterFlying }],
    [`LoadTypeFrom ${LOAD_DEFENDER_PARTNER_TYPE_2}`, TYPE_WATER, { v: waterFlying }],
    [`LoadTypeFrom ${LOAD_ATTACKER_PARTNER_TYPE_2}`, TYPE_GROUND, { v: waterFlying }],
    ['LoadTypeFrom 9', 77, { v: waterFlying, calcTemp: 77 }], // the default only asserts (:985–987)
    ['LoadMovePower', 80], ['LoadMovePower', 100, { slot: 1 }], // trainer_ai.c:1009
    [`LoadBattlerPreviousMove ${DEF}`, M.CRUNCH, { v: prev }], // trainer_ai.c:1075
    [`LoadBattlerPreviousMove ${ATK}`, M.EARTHQUAKE, { v: prev }],
    [`LoadBattlerPreviousMove ${DEF_PARTNER}`, 0, { v: prev, calcTemp: 9 }],
    ['LoadCurrentMoveEffect', 0, { calcTemp: 9 }], ['LoadCurrentMoveEffect', 147, { slot: 1 }], // trainer_ai.c:1167
    // Clear, then each weather in turn, a later test winning (trainer_ai.c:1418–1438). Cloud Nine is not checked.
    ['LoadCurrentWeather', AI_WEATHER_CLEAR, weather(0)],
    ['LoadCurrentWeather', AI_WEATHER_RAINING, weather(FIELD_CONDITION_RAINING_TEMP)],
    ['LoadCurrentWeather', AI_WEATHER_SANDSTORM, weather(FIELD_CONDITION_SANDSTORM_TEMP)],
    ['LoadCurrentWeather', AI_WEATHER_SUNNY, weather(FIELD_CONDITION_SUNNY_PERM)],
    ['LoadCurrentWeather', AI_WEATHER_HAILING, weather(FIELD_CONDITION_HAILING_PERM)],
    ['LoadCurrentWeather', AI_WEATHER_DEEP_FOG, weather(FIELD_CONDITION_DEEP_FOG)],
    ['LoadCurrentWeather', AI_WEATHER_SUNNY, weather(FIELD_CONDITION_RAINING_TEMP | FIELD_CONDITION_SUNNY_PERM)],
    ['LoadCurrentWeather', AI_WEATHER_DEEP_FOG, weather(FIELD_CONDITION_DEEP_FOG | FIELD_CONDITION_RAINING_TEMP)],
    [`LoadGender ${DEF}`, GENDER_FEMALE, { v: mon(PLAYER, { gender: GENDER_FEMALE }) }], // trainer_ai.c:2477
    [`LoadGender ${ATK}`, 0, { v: mon(PLAYER, { gender: GENDER_FEMALE }), calcTemp: 9 }],
    // fakeOutTurnNumber < totalTurns ? FALSE : TRUE (trainer_ai.c:2487–2491); the switch-in set it to 1.
    [`LoadIsFirstTurnInBattle ${ATK}`, 1],
    [`LoadIsFirstTurnInBattle ${ATK}`, 1, { v: fixtureView({ totalTurns: 1 }) }],
    [`LoadIsFirstTurnInBattle ${ATK}`, 0, { v: fixtureView({ totalTurns: 2 }), calcTemp: 9 }],
    [`LoadStockpileCount ${ATK}`, 2, { v: stockpile }], [`LoadStockpileCount ${DEF}`, 0, { v: stockpile, calcTemp: 9 }], // :2501
    ['LoadBattleType', BATTLE_TYPE_TRAINER_SINGLES], // trainer_ai.c:2507
    ['LoadBattleType', BATTLE_TYPE_TRAINER | BATTLE_TYPE_FRONTIER, { v: fixtureView({ battleType: BATTLE_TYPE_TRAINER | BATTLE_TYPE_FRONTIER }) }],
    [`LoadRecycleItem ${ATK}`, FX.item.SITRUS_BERRY, { v: fixtureView({ recycleItem: [0, FX.item.SITRUS_BERRY, 0, 0] }) }],
    [`LoadRecycleItem ${DEF}`, 0, { v: fixtureView({ recycleItem: [0, FX.item.SITRUS_BERRY, 0, 0] }), calcTemp: 9 }],
    // The move data of the move in calcTemp (trainer_ai.c:2523–2535).
    ['LoadTypeOfLoadedMove', TYPE_WATER, { calcTemp: M.WATER_GUN }], ['LoadTypeOfLoadedMove', TYPE_ELECTRIC, { calcTemp: M.SPARK }],
    ['LoadPowerOfLoadedMove', 40, { calcTemp: M.WATER_GUN }], ['LoadPowerOfLoadedMove', 150, { calcTemp: M.HYPER_BEAM }],
    ['LoadEffectOfLoadedMove', 147, { calcTemp: M.EARTHQUAKE }], ['LoadEffectOfLoadedMove', 80, { calcTemp: M.HYPER_BEAM }],
    // protectSuccessTurns if moveProtect is Protect, Detect or Endure, else 0 (trainer_ai.c:2545–2551).
    [`LoadProtectChain ${DEF}`, 2, protect(MOVE_PROTECT)], [`LoadProtectChain ${DEF}`, 2, protect(MOVE_DETECT)],
    [`LoadProtectChain ${DEF}`, 2, protect(MOVE_ENDURE)], [`LoadProtectChain ${DEF}`, 0, protect(M.TACKLE)],
    // MON_HAS_TYPE: either current type (trainer_ai.c:999–1003).
    [`FlagBattlerIsType ${DEF}, ${TYPE_ELECTRIC}`, 1], [`FlagBattlerIsType ${DEF}, ${TYPE_GROUND}`, 0, { calcTemp: 9 }],
    [`FlagBattlerIsType ${ATK}, ${TYPE_GROUND}`, 1],
    // By the battler's side; any other side condition leaves calcTemp alone (trainer_ai.c:1957–1965).
    [`LoadSpikesLayers ${DEF}, ${SIDE_CONDITION_SPIKES}`, 2, { v: spikes }],
    [`LoadSpikesLayers ${DEF}, ${SIDE_CONDITION_TOXIC_SPIKES}`, 1, { v: spikes }],
    [`LoadSpikesLayers ${ATK}, ${SIDE_CONDITION_SPIKES}`, 0, { v: spikes, calcTemp: 9 }],
    [`LoadSpikesLayers ${DEF}, ${REFLECT}`, 77, { v: spikes, calcTemp: 77 }],
    ['LoadCurrentMovePP', 15], ['LoadCurrentMovePP', 10, { slot: 1 }], // ppCur[moveSlot] (trainer_ai.c:2027)
    ['LoadCurrentMoveClass', MOVE_CLASS.PHYSICAL, { calcTemp: 9 }], // trainer_ai.c:2047
    ['LoadCurrentMoveClass', MOVE_CLASS.SPECIAL, { move: M.WATER_GUN }],
    ['LoadCurrentMoveClass', MOVE_CLASS.STATUS, { move: M.DRAGON_DANCE }],
    ['LoadDefenderLastUsedMoveClass', MOVE_CLASS.PHYSICAL, lastUsed(M.SPARK)], // trainer_ai.c:2053
    ['LoadDefenderLastUsedMoveClass', MOVE_CLASS.SPECIAL, lastUsed(M.WATER_GUN)],
    ['LoadDefenderLastUsedMoveClass', MOVE_CLASS.STATUS, lastUsed(M.PROTECT)],
    // totalTurns - fakeOutTurnNumber (trainer_ai.c:2103): -1 on turn 1.
    [`LoadBattlerTurnCount ${ATK}`, -1], [`LoadBattlerTurnCount ${ATK}`, 2, { v: fixtureView({ totalTurns: 3 }) }],
    // The stages above 6 over all 8 (trainer_ai.c:2250–2256); the battler's stage minus the AI's (:2267).
    [`SumPositiveStatStages ${DEF}`, 2 + 6 + 1, { v: stages }],
    [`SumPositiveStatStages ${ATK}`, 0, { v: stages, calcTemp: 9 }],
    [`DiffStatStages ${DEF}, ${S.ATTACK}`, 3, { v: stages }],
    [`DiffStatStages ${DEF}, ${S.DEFENSE}`, -2, { v: stages }],
    [`DiffStatStages ${ATK}, ${S.ATTACK}`, 0, { v: stages, calcTemp: 9 }],
  ]);
});
