// The opcodes over the AI's damage estimate, type effectiveness and speed comparison. Garchomp (Atk 150, SpA 100,
// Speed 122, level 50, Dragon/Ground) into Luxray (Def 99, SpD 99, Speed 90, HP 155, Electric), at 100%
// (TrainerAI_CalcDamage, trainer_ai.c:2868; battle_lib.c:2592–2642, 6956–7078):
//   Dragon Claw (80): 150 * 80 * 22 / 99 / 50 + 2 = 55, STAB 82. Earthquake (100): 68, STAB 102, super effective 204.
//   Crunch (80): 55, no STAB. Fire Fang (65): 45. Tackle (35): 25.

import { describe, expect, it } from 'vitest';
import type { Rational } from '../../../src/contracts/engine.js';
import {
  ABILITY_LEVITATE, AI_MOVE_IS_HIGHEST_DAMAGE, AI_NO_COMPARISON_MADE, AI_NOT_HIGHEST_DAMAGE, COMPARE_SPEED_FASTER,
  COMPARE_SPEED_SLOWER, COMPARE_SPEED_TIE, FIELD_CONDITION_RAINING, GENDER_NONE, MON_CONDITION_PARALYSIS, MOVE_GYRO_BALL,
  ROLL_FOR_DAMAGE, SPECIES_EGG, TYPE_BUG, TYPE_FIRE, TYPE_FLYING, TYPE_GRASS, TYPE_NORMAL, TYPE_ROCK, TYPE_STEEL,
  USE_MAX_DAMAGE,
} from '../../../src/ai/constants.js';
import { rat, residueWeights } from '../../../src/ai/odds.js';
import type { RunResult } from '../../../src/ai/script/run.js';
import type { AiView } from '../../../src/ai/view.js';
import { FX, fixtureView } from './fixtures.js';
import {
  AI, aiKnows, aiParty, ATK, ATK_PARTNER, BRANCH, branches, DEF, DEF_PARTNER, gyroDeps, latents, loads, mon,
  NOT_TAKEN, oddsOf, type Opts, PLAYER, playerAt, run, TAKEN, throws, viewWith,
} from './opsHarness.js';

const M = FX.move;
const MAX = USE_MAX_DAMAGE;
const ROLL = ROLL_FOR_DAMAGE;
const [HIGHEST, NOT_HIGHEST, NO_COMPARISON] = [AI_MOVE_IS_HIGHEST_DAMAGE, AI_NOT_HIGHEST_DAMAGE, AI_NO_COMPARISON_MADE];
const [DRAGON_CLAW_DAMAGE, EARTHQUAKE_DAMAGE, CRUNCH_DAMAGE, TACKLE_DAMAGE] = [82, 204, 55, 25];
const KILLS = `IfCurrentMoveKills ${MAX}, Taken`;
const SURVIVES = `IfCurrentMoveDoesNotKill ${MAX}, Taken`;

const tackleOnly = () => aiKnows([M.TACKLE, 0, 0, 0]);
/** Hyper Beam's recharge effect is in sNoDamageCalcMoveEffects (trainer_ai.c:31–46): no estimate at all. */
const hyperBeam = (curHP: number) => playerAt(curHP, aiKnows([M.HYPER_BEAM, M.TACKLE, 0, 0]));
const playerTypes = (a: number, b: number) => mon(PLAYER, { types: [a, b] });
const rain = () => fixtureView({ fieldConditionsMask: FIELD_CONDITION_RAINING });
const rolled = (roll: number): Opts => ({ v: playerAt(78), lat: { ...latents(), rolls: [roll, null, null, null] } });
/** The bench fainted, with party slot `active` the active one. */
const benchDown = (active: number) => viewWith((v) => { v.selectedPartySlot[AI] = active; }, aiParty({ 1: { hp: 0 }, 2: { hp: 0 } }, tackleOnly()));
const spark = (v: AiView) => viewWith((w) => { w.movePrevByBattler[PLAYER] = M.SPARK; }, v);
/** Luxray made genderless (no Rivalry) and Normal, using Hidden Power, against a Garchomp knowing only Crunch. */
const hiddenPower = (aiIv: number, playerIv: number): Opts => {
  const ivs = (n: number) => ({ hp: n, atk: n, def: n, spa: n, spd: n, spe: n });
  const v = mon(AI, { moves: [M.CRUNCH, 0, 0, 0], ivs: ivs(aiIv) }, fixtureView({ movePrevByBattler: [M.HIDDEN_POWER, 0, 0, 0] }));
  return { v: mon(PLAYER, { gender: GENDER_NONE, types: [TYPE_NORMAL, TYPE_NORMAL], ivs: ivs(playerIv) }, v) };
};

describe('damage opcodes', () => {
  const ties = aiKnows([M.DRAGON_CLAW, M.DRAGON_CLAW, M.CRUNCH, M.PROTECT]);
  loads([
    // TrainerAI_CalcAllDamage over 82, 204, 55, 45 (trainer_ai.c:1035–1065): highest when no slot is strictly larger,
    // a tie included; a status move makes no comparison, though Seismic Toss (power 1, sAltPowerMoveEffects) does.
    [`FlagMoveDamageScore ${MAX}`, NOT_HIGHEST],
    [`FlagMoveDamageScore ${MAX}`, HIGHEST, { slot: 1 }],
    [`FlagMoveDamageScore ${MAX}`, NO_COMPARISON, { v: aiKnows([M.DRAGON_CLAW, M.PROTECT, 0, 0]), slot: 1 }],
    [`FlagMoveDamageScore ${MAX}`, HIGHEST, { v: aiKnows([M.SEISMIC_TOSS, M.PROTECT, 0, 0]) }],
    [`FlagMoveDamageScore ${MAX}`, HIGHEST, { v: ties, slot: 0 }],
    [`FlagMoveDamageScore ${MAX}`, HIGHEST, { v: ties, slot: 1 }],
    [`FlagMoveDamageScore ${MAX}`, NOT_HIGHEST, { v: ties, slot: 2 }],
    [`FlagMoveDamageScore ${MAX}`, NO_COMPARISON, { v: hyperBeam(155) }],
    [`CheckIfHighestDamageWithPartner ${MAX}`, NO_COMPARISON, { v: hyperBeam(155) }],
    // Singles: the partner is the AI itself (battle_system.c:400–402), so both passes estimate Garchomp (:2397–2432).
    [`CheckIfHighestDamageWithPartner ${MAX}`, NOT_HIGHEST],
    [`CheckIfHighestDamageWithPartner ${MAX}`, HIGHEST, { slot: 1 }],
    // The best move at base 40 (trainer_ai.c:1272–1307): Earthquake's 120 maps to 80, twice super effective 240 to 160;
    // Levitate makes it immune, leaving Dragon Claw's STAB 60; all slots empty keep TYPE_MULTI_IMMUNE, 0.
    ['CalcMaxEffectiveness', 80],
    ['CalcMaxEffectiveness', 160, { v: playerTypes(TYPE_FIRE, TYPE_ROCK) }],
    ['CalcMaxEffectiveness', 60, { v: mon(PLAYER, { ability: ABILITY_LEVITATE }) }],
    ['CalcMaxEffectiveness', 0, { v: aiKnows([0, 0, 0, 0]), calcTemp: 99 }],
    ['CalcMaxEffectiveness', 80, { v: aiKnows([M.EARTHQUAKE, M.DRAGON_CLAW, M.CRUNCH, M.WEATHER_BALL], undefined, rain()) }],
  ]);

  branches([
    // Kills when the real curHP <= the estimate (trainer_ai.c:1570), survives when above it (:1621).
    [KILLS, true, { v: playerAt(DRAGON_CLAW_DAMAGE) }],
    [KILLS, false, { v: playerAt(DRAGON_CLAW_DAMAGE + 1) }],
    [KILLS, true, { v: playerAt(EARTHQUAKE_DAMAGE), slot: 1 }],
    [KILLS, false, { v: playerAt(EARTHQUAKE_DAMAGE + 1), slot: 1 }],
    [KILLS, true, { v: playerAt(CRUNCH_DAMAGE), slot: 2 }],
    [KILLS, false, { v: playerAt(CRUNCH_DAMAGE + 1), slot: 2 }],
    [KILLS, true, { v: playerAt(TACKLE_DAMAGE, tackleOnly()) }],
    [KILLS, false, { v: playerAt(TACKLE_DAMAGE + 1, tackleOnly()) }],
    [SURVIVES, true, { v: playerAt(DRAGON_CLAW_DAMAGE + 1) }],
    [SURVIVES, false, { v: playerAt(DRAGON_CLAW_DAMAGE) }],
    [KILLS, false, { v: hyperBeam(1) }],
    [SURVIVES, false, { v: hyperBeam(155) }],
    ['IfCurrentMoveKills 2, Taken', true, { v: playerAt(DRAGON_CLAW_DAMAGE) }], // only TRUE reads the roll (:1533)
    // A fixed roll latent is read, not drawn: Divide(82 * roll, 100) is 78 at 96, 77 at 95 (:1534, 3109).
    [`IfCurrentMoveKills ${ROLL}, Taken`, true, rolled(96)],
    [`IfCurrentMoveKills ${ROLL}, Taken`, false, rolled(95)],
    // The active Tackle's 25 against each live bench member's moves, estimated from Garchomp (trainer_ai.c:2130–2165):
    // Gyarados's Waterfall is 55. A fainted member or an egg is skipped, and so is the active slot (:2142–2147).
    [`IfPartyMemberDealsMoreDamage ${MAX}, Taken`, true, { v: tackleOnly() }],
    [`IfPartyMemberDealsMoreDamage ${MAX}, Taken`, false, { v: benchDown(0) }],
    [`IfPartyMemberDealsMoreDamage ${MAX}, Taken`, true, { v: benchDown(1) }], // Garchomp's party Earthquake counts
    [`IfPartyMemberDealsMoreDamage ${MAX}, Taken`, false, { v: aiParty({ 1: { species: SPECIES_EGG }, 2: { hp: 0 } }, tackleOnly()) }],
    [`IfPartyMemberDealsMoreDamage ${MAX}, Taken`, false],
    // The battler's last move into AI_CONTEXT.defender (:2210–2236, 2878), here Luxray into itself: Spark with Rivalry,
    // 65 * 125 / 100 = 81 power, 52, STAB 78, Electric into Electric 39. That beats Tackle's 25, not Earthquake's 204.
    [`IfBattlerDealsMoreDamage ${DEF}, ${MAX}, Taken`, true, { v: spark(tackleOnly()) }],
    [`IfBattlerDealsMoreDamage ${DEF}, ${MAX}, Taken`, false, { v: spark(fixtureView()) }],
    // The battler's move is estimated with the AI's IVs (:2206–2232), so Hidden Power takes the AI's type. From IVs all
    // 30: power 70, Fighting (:2973–2993), 37, into Normal 74 > Crunch's 55. From IVs all 31: Dark, 37.
    [`IfBattlerDealsMoreDamage ${DEF}, ${MAX}, Taken`, true, hiddenPower(30, 31)],
    [`IfBattlerDealsMoreDamage ${DEF}, ${MAX}, Taken`, false, hiddenPower(31, 31)],
    [`IfBattlerDealsMoreDamage ${DEF}, ${MAX}, Taken`, false, hiddenPower(31, 30)],
    // The current move alone (trainer_ai.c:1320–1345): Earthquake 120 maps to 80, a neutral STAB move is 60, halved
    // STAB 30 maps to 20, quartered 15 to 10, and Ground into Flying is 0. Weather Ball in rain is Water: 40.
    ['IfMoveEffectivenessEquals 80, Taken', true, { slot: 1 }],
    ['IfMoveEffectivenessEquals 120, Taken', false, { slot: 1 }],
    ['IfMoveEffectivenessEquals 60, Taken', true],
    ['IfMoveEffectivenessEquals 20, Taken', true, { v: playerTypes(TYPE_STEEL, TYPE_STEEL) }],
    ['IfMoveEffectivenessEquals 10, Taken', true, { v: playerTypes(TYPE_GRASS, TYPE_BUG), slot: 1 }],
    ['IfMoveEffectivenessEquals 0, Taken', true, { v: playerTypes(TYPE_FLYING, TYPE_FLYING), slot: 1 }],
    ['IfMoveEffectivenessEquals 40, Taken', true, { v: aiKnows([M.WEATHER_BALL, 0, 0, 0], undefined, rain()) }],
    // AI_HasSuperEffectiveMove (trainer_ai.c:2182, 3571–3599): Earthquake, with no draw; a battler in
    // battlersSwitchingMask isn't checked, and singles has no partner to try.
    ['IfHasSuperEffectiveMove Taken', true],
    ['IfHasSuperEffectiveMove Taken', false, { v: aiKnows([M.DRAGON_CLAW, M.CRUNCH, 0, 0]) }],
    ['IfHasSuperEffectiveMove Taken', false, { v: viewWith((v) => { v.battlersSwitchingMask |= 1 << PLAYER; }) }],
  ]);

  // Weather Ball with no weather has no type (trainer_ai.c:3222), and each opcode types a slot before checking its move
  // (:1278, 1323, 3578), so it throws even after a super-effective slot.
  throws([
    ['CalcMaxEffectiveness', 'UNDEFINED', { v: aiKnows([M.EARTHQUAKE, M.DRAGON_CLAW, M.CRUNCH, M.WEATHER_BALL]) }],
    ['IfMoveEffectivenessEquals 40, Taken', 'UNDEFINED', { v: aiKnows([M.WEATHER_BALL, 0, 0, 0]) }],
    ['IfHasSuperEffectiveMove Taken', 'UNDEFINED', { v: aiKnows([M.DRAGON_CLAW, M.WEATHER_BALL, M.EARTHQUAKE, 0]) }],
  ]);

  // ROLL_FOR_DAMAGE draws 100 - RandNext() % 16 (trainer_ai.c:240): 5 of the 16 rolls take Dragon Claw to 78 or more.
  it.each<[string, Opts, Record<string, Rational>]>([
    [`IfCurrentMoveKills ${ROLL}, Taken`, { v: playerAt(78) }, { [NOT_TAKEN]: rat(11, 16), [TAKEN]: rat(5, 16) }],
    [`IfCurrentMoveDoesNotKill ${ROLL}, Taken`, { v: playerAt(78) }, { [TAKEN]: rat(11, 16), [NOT_TAKEN]: rat(5, 16) }],
    // An exact speed tie draws RandNext() & 1 (battle_lib.c:1445–1447).
    [`IfSpeedCompareEqualTo ${COMPARE_SPEED_TIE}, Taken`, { v: mon(PLAYER, { speed: 122 }) }, { [NOT_TAKEN]: rat(1, 2), [TAKEN]: rat(1, 2) }],
    // The player's Quick Claw fires with prior 13108/65536, and then the AI is slower.
    [`IfSpeedCompareEqualTo ${COMPARE_SPEED_SLOWER}, Taken`, { v: mon(PLAYER, { heldItem: FX.item.QUICK_CLAW }) },
      { [TAKEN]: rat(13108, 65536), [NOT_TAKEN]: rat(65536 - 13108, 65536) }],
  ])('%s draws', (instr, opts, want) => expect(oddsOf(`${instr}${BRANCH}`, opts)).toEqual(want));

  it('CheckIfHighestDamageWithPartner draws Psywave again in its second pass', () => {
    // The second pass's fresh draw (trainer_ai.c:3015) against the first's (:2416–2424): NOT_HIGHEST when it is larger.
    const w = residueWeights(11);
    let larger = 0n;
    for (let x = 0; x < 11; x++) for (let y = x + 1; y < 11; y++) larger += w[x]! * w[y]!;
    const total = 65536n * 65536n;
    expect(oddsOf(`CheckIfHighestDamageWithPartner ${MAX}\nPopOrEnd`, { v: aiKnows([M.PSYWAVE, 0, 0, 0]) }, (r) => r.calcTemp))
      .toEqual({ [HIGHEST]: rat(total - larger, total), [NOT_HIGHEST]: rat(larger, total) });
  });
});

describe('speed opcodes', () => {
  // BattleSystem_CompareBattlerSpeed(attacker, defender, TRUE) (trainer_ai.c:1109–1121): 122 against 90, quartered to
  // 30 by paralysis (battle_lib.c:1259–1261).
  branches([
    [`IfSpeedCompareEqualTo ${COMPARE_SPEED_FASTER}, Taken`, true],
    [`IfSpeedCompareEqualTo ${COMPARE_SPEED_SLOWER}, Taken`, false],
    [`IfSpeedCompareEqualTo ${COMPARE_SPEED_SLOWER}, Taken`, true, { v: mon(AI, { status: MON_CONDITION_PARALYSIS }) }],
    [`IfSpeedCompareNotEqualTo ${COMPARE_SPEED_SLOWER}, Taken`, true],
    [`IfSpeedCompareNotEqualTo ${COMPARE_SPEED_FASTER}, Taken`, false],
  ]);

  // One comparison in singles (trainer_ai.c:2070–2093): the slower battler swaps down. Battlers 2 and 3 are beyond
  // GetMaxBattlers, so the search finds nothing and calcTemp keeps the turn count.
  loads([
    [`LoadBattlerSpeedRank ${ATK}`, 0],
    [`LoadBattlerSpeedRank ${DEF}`, 1],
    [`LoadBattlerSpeedRank ${ATK}`, 1, { v: mon(PLAYER, { speed: 200 }) }],
    [`LoadTurnCount\nLoadBattlerSpeedRank ${ATK_PARTNER}`, 5, { v: fixtureView({ totalTurns: 5 }) }],
    [`LoadTurnCount\nLoadBattlerSpeedRank ${DEF_PARTNER}`, 5, { v: fixtureView({ totalTurns: 5 }) }],
  ]);

  it('LoadBattlerSpeedRank swaps on a tie and writes monSpeedValues', () => {
    // Any non-zero result swaps (trainer_ai.c:2081); the comparison writes [0] and [1] (battle_lib.c:1372–1373).
    expect(oddsOf(`LoadBattlerSpeedRank ${ATK}\nPopOrEnd`, { v: mon(PLAYER, { speed: 122 }) }, (r) => r.calcTemp))
      .toEqual({ 0: rat(1, 2), 1: rat(1, 2) });
    expect(run(`LoadBattlerSpeedRank ${ATK}\nPopOrEnd`, { monSpeedValues: [1, 2, 3, 4] }).monSpeedValues).toEqual([90, 122, 3, 4]);
  });
});

describe('Gyro Ball and the carried monSpeedValues', () => {
  // Power 1 + 25 * speeds[defender] / speeds[attacker] (trainer_ai.c:2996). From [90, 122]: 19, so 14, Steel into
  // Electric 7. From the carried [244, 122]: 51, so 36, then 18. A speed compare writes [90, 122]
  // (battle_lib.c:1372–1373), but nothing when a battler has fainted (:1204–1211).
  const CARRIED = [244, 122, 0, 0];
  const WRITTEN = [90, 122, 0, 0];
  const COMPARE = `IfSpeedCompareEqualTo ${COMPARE_SPEED_FASTER}, Next\nNext: `;
  it.each<[string, string, number, Partial<RunResult>]>([
    ['reads the incoming copy', `${KILLS}${BRANCH}`, 18, { score: TAKEN, readIncomingSpeeds: true, monSpeedValues: CARRIED }],
    ['reads the incoming copy', `${KILLS}${BRANCH}`, 19, { score: NOT_TAKEN }],
    ['after a compare reads what it wrote', `${COMPARE}${KILLS}${BRANCH}`, 7, { score: TAKEN, readIncomingSpeeds: false, monSpeedValues: WRITTEN }],
    ['after a compare reads what it wrote', `${COMPARE}${KILLS}${BRANCH}`, 8, { score: NOT_TAKEN }],
    ['before a compare reads the incoming copy', `${KILLS}\nTaken: ${COMPARE}PopOrEnd`, 18, { readIncomingSpeeds: true, monSpeedValues: WRITTEN }],
    ['after a compare with a fainted battler reads the incoming copy', `${COMPARE}${KILLS}${BRANCH}`, 0,
      { score: TAKEN, readIncomingSpeeds: true, monSpeedValues: CARRIED }],
  ])('Gyro Ball %s (%i HP)', (_, src, curHP, want) => {
    const v = playerAt(curHP, aiKnows([MOVE_GYRO_BALL, 0, 0, 0]));
    expect(run(src, { v, d: gyroDeps(), monSpeedValues: CARRIED })).toMatchObject(want);
  });

  it('a run without Gyro Ball reads no speeds', () => {
    expect(run(`FlagMoveDamageScore ${MAX}\nPopOrEnd`, { monSpeedValues: CARRIED }))
      .toMatchObject({ readIncomingSpeeds: false, monSpeedValues: CARRIED });
  });
});
