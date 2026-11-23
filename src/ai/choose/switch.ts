// The voluntary switch: TrainerAI_ShouldSwitch (trainer_ai.c:3894) and its helpers (trainer_ai.c:3263–3884), singles
// paths only. One call follows one random path: each RandNext() the C draws is a `pick` over the exact count of the
// 65536 values that pass its test, so callers enumerate. Literal ports over AiView; each rule cites its C line. Pure:
// the C's write to aiSwitchedPartySlot[battler] comes back as the outcome.

import {
  ABILITY_ARENA_TRAP, ABILITY_FLASH_FIRE, ABILITY_MAGNET_PULL, ABILITY_NATURAL_CURE, ABILITY_SHADOW_TAG,
  ABILITY_VOLT_ABSORB, ABILITY_WATER_ABSORB, ABILITY_WONDER_GUARD, BATTLE_STAT, BATTLE_STAT_MAX, BATTLE_TYPE_DOUBLES,
  BATTLER_NONE, BATTLER_PLAYER_1, COUNT_ALL_BATTLERS_EXCEPT_ME, COUNT_ALL_BATTLERS_THEIR_SIDE, MON_CONDITION_SLEEP,
  MOVE_EFFECT_INGRAIN, MOVE_EFFECT_PERISH_SONG, MOVE_NONE, MOVE_STATUS_INEFFECTIVE, MOVE_STATUS_NOT_VERY_EFFECTIVE,
  MOVE_STATUS_SUPER_EFFECTIVE, TYPE_ELECTRIC, TYPE_FIRE, TYPE_STEEL, TYPE_WATER, VOLATILE_CONDITION_TRAPPED,
} from '../constants.js';
import type { Pick } from '../enumerate.js';
import { AiError } from '../errors.js';
import { cdiv, u32, u8 } from '../int.js';
import { aiMoveType, battleMon, battlerAbility, countAbility, itemData, moveData, partyMoveType } from '../lib/battler.js';
import {
  aiSlots, isBenchCandidate, isPokemon, moveSlots, partyMoveEffectiveness, partyOf, requireSingles, selectedSlot, slotOf,
} from '../lib/party.js';
import { applyTypeChart, calcEffectiveness, monHasType } from '../lib/typeChart.js';
import { countU16, residueWeights, U16 } from '../odds.js';
import { AI_BATTLER, type AiDeps, type AiView } from '../view.js';

/**
 * What TrainerAI_ShouldSwitch leaves: FALSE ('stay'), or TRUE with aiSwitchedPartySlot[battler] set to a party index
 * ('switch') or to 6, which TrainerAI_PickCommand resolves with the post-KO logic (trainer_ai.c:4004) ('postKo').
 */
export type SwitchOutcome = { kind: 'stay' } | { kind: 'switch'; partyIndex: number } | { kind: 'postKo' };

const STAY: SwitchOutcome = Object.freeze({ kind: 'stay' });
const POST_KO: SwitchOutcome = Object.freeze({ kind: 'postKo' });

function switchTo(partyIndex: number): SwitchOutcome {
  return { kind: 'switch', partyIndex };
}

// Each draw's count: the r in 0..65535 for which the C's test passes.
/** `RandNext() % 3 < 2` (trainer_ai.c:3339, 3459, 3477): 43691. */
const MOD_3_BELOW_2 = countU16((r) => r % 3 < 2);
/** `RandNext() % 2 == 0` (trainer_ai.c:3518, 3536): 32768. */
const MOD_2_IS_0 = countU16((r) => r % 2 === 0);
/** `RandNext() % 10 != 0` (trainer_ai.c:3588): 58982. */
const MOD_10_NOT_0 = countU16((r) => r % 10 !== 0);
/** `RandNext() % 3 != 0` (trainer_ai.c:3651): 43690 skip the absorb check, 21846 go on. */
const MOD_3_NOT_0 = countU16((r) => r % 3 !== 0);
/** `RandNext() & 1` (trainer_ai.c:3706, 3828, 3835, 3853): 32768. */
const LOW_BIT = countU16((r) => (r & 1) !== 0);

/** One RandNext() whose test passes for `count` of its 65536 values: whether it passed. */
function draw(pick: Pick, count: bigint): boolean {
  return pick([count, U16 - count]) === 0;
}

/** AI_PerishSongKO, trainer_ai.c:3263. Dead in the cartridge: the counter is never seen at 0 (trainer_ai.c:3255–3257). */
function perishSongKO(v: AiView, battler: number): SwitchOutcome | null {
  const mon = battleMon(v, battler);
  if ((mon.moveEffectsMask & MOVE_EFFECT_PERISH_SONG) !== 0 && mon.effects.perishSongTurns === 0) return POST_KO; // :3265–3269
  return null;
}

/** AI_CannotDamageWonderGuard, trainer_ai.c:3286. */
function cannotDamageWonderGuard(v: AiView, d: AiDeps, battler: number, pick: Pick): SwitchOutcome | null {
  if ((v.battleType & BATTLE_TYPE_DOUBLES) !== 0) return null; // :3294–3296
  const opponent = battler ^ 1; // BATTLER_OPP (include/battle/common.h:33)
  if (battleMon(v, opponent).ability !== ABILITY_WONDER_GUARD) return null; // :3298: the stored ability

  for (const move of moveSlots(battleMon(v, battler).moves)) { // :3300
    const moveType = aiMoveType(v, d, battler, move); // :3302, for every slot
    if (move !== MOVE_NONE) {
      const { flags } = applyTypeChart(v, d, move, moveType, battler, opponent, 0); // :3304–3306
      if ((flags & MOVE_STATUS_SUPER_EFFECTIVE) !== 0) return null; // :3308–3310
    }
  }

  const party = partyOf(v, battler);
  for (let i = 0; i < party.length; i++) { // :3315
    const mon = party[i]!;
    // :3318–3321: no aiSwitchedPartySlot test here, and only this battler's selected slot.
    if (mon.hp !== 0 && isPokemon(mon) && i !== selectedSlot(v, battler)) {
      for (const move of moveSlots(mon.moves)) { // :3322
        const moveType = partyMoveType(v, d, mon, move); // :3324
        if (move !== MOVE_NONE) {
          const effectiveness = partyMoveEffectiveness(v, d, mon, move, moveType, opponent); // :3326–3336
          // :3339: `RandNext() % 3 < 2`, drawn only for a super-effective move.
          if ((effectiveness & MOVE_STATUS_SUPER_EFFECTIVE) !== 0 && draw(pick, MOD_3_BELOW_2)) return switchTo(i);
        }
      }
    }
  }
  return null;
}

/** AI_OnlyIneffectiveMoves, trainer_ai.c:3361. */
function onlyIneffectiveMoves(v: AiView, d: AiDeps, battler: number, pick: Pick): SwitchOutcome | null {
  // :3374–3380: in singles both defenders are the player's battler, so every check below runs twice on it.
  const defenders = [BATTLER_PLAYER_1, BATTLER_PLAYER_1];

  let numMoves = 0;
  for (const move of moveSlots(battleMon(v, battler).moves)) { // :3385
    const type = aiMoveType(v, d, battler, move); // :3387, for every slot
    if (move !== MOVE_NONE && moveData(d, move).power !== 0) { // :3389
      numMoves++;
      for (const defender of defenders) { // :3392–3408
        let effectiveness = 0;
        if (battleMon(v, defender).curHP !== 0) effectiveness = applyTypeChart(v, d, move, type, battler, defender, 0).flags;
        if ((effectiveness & MOVE_STATUS_INEFFECTIVE) === 0) return null;
      }
    }
  }
  if (numMoves < 2) return null; // :3413–3415

  const slots = aiSlots(v, battler); // :3417–3422
  const party = partyOf(v, battler); // :3424–3425
  // :3431–3484: a bench move super-effective on either defender switches on `RandNext() % 3 < 2` (:3459, 3477).
  // :3490–3543: then one exactly neutral (effectiveness 0) switches on `RandNext() % 2 == 0` (:3518, 3536).
  const passes: [(effectiveness: number) => boolean, bigint][] = [
    [(effectiveness) => (effectiveness & MOVE_STATUS_SUPER_EFFECTIVE) !== 0, MOD_3_BELOW_2],
    [(effectiveness) => effectiveness === 0, MOD_2_IS_0],
  ];
  for (const [qualifies, count] of passes) {
    for (let i = 0; i < party.length; i++) {
      const mon = party[i]!;
      if (!isBenchCandidate(v, mon, i, slots)) continue;
      for (const move of moveSlots(mon.moves)) {
        const type = partyMoveType(v, d, mon, move); // :3443, 3502, for every slot
        if (move === MOVE_NONE || moveData(d, move).power === 0) continue; // :3445, 3504
        for (const defender of defenders) {
          let effectiveness = 0;
          if (battleMon(v, defender).curHP !== 0) effectiveness = partyMoveEffectiveness(v, d, mon, move, type, defender);
          if (qualifies(effectiveness) && draw(pick, count)) return switchTo(i);
        }
      }
    }
  }
  return null;
}

/**
 * AI_HasSuperEffectiveMove, trainer_ai.c:3560: whether a move of the battler's is super-effective on the opposing
 * battler. With `flag` the first one answers TRUE; without it each draws `RandNext() % 10 != 0` (:3588).
 */
function hasSuperEffectiveMove(v: AiView, d: AiDeps, battler: number, flag: boolean, pick: Pick): boolean {
  // :3571–3572: the battler of the opposite type; a singles battler's type is its slot (battle_main.c:948).
  const defender = battler ^ 1;
  if ((v.battlersSwitchingMask & (1 << defender)) === 0) { // :3574
    for (const move of moveSlots(battleMon(v, battler).moves)) { // :3576
      const type = aiMoveType(v, d, battler, move); // :3578, for every slot
      if (move !== MOVE_NONE) {
        const { flags } = applyTypeChart(v, d, move, type, battler, defender, 0); // :3581–3582
        if ((flags & MOVE_STATUS_SUPER_EFFECTIVE) !== 0) { // :3585
          if (flag) return true; // :3586–3587
          if (draw(pick, MOD_10_NOT_0)) return true; // :3588–3589
        }
      }
    }
  }
  return false; // :3597–3599: the partner's check is doubles-only
}

/** AI_HasAbsorbAbilityInParty, trainer_ai.c:3640. */
function hasAbsorbAbilityInParty(v: AiView, d: AiDeps, battler: number, pick: Pick): SwitchOutcome | null {
  // :3651: with a super-effective move, `RandNext() % 3 != 0` skips the check (2 in 3, though :3650 says 33%).
  if (hasSuperEffectiveMove(v, d, battler, true, pick) && draw(pick, MOD_3_NOT_0)) return null;

  const moveHit = slotOf(v.moveHit, battler, 'moveHit');
  if (moveHit === MOVE_NONE) return null; // :3656–3658
  if (moveData(d, moveHit).power === 0) return null; // :3661–3663

  const moveType = u8(moveData(d, moveHit).type); // :3665, the move's own type
  let checkAbility: number;
  if (moveType === TYPE_FIRE) checkAbility = ABILITY_FLASH_FIRE; // :3666–3667
  else if (moveType === TYPE_WATER) checkAbility = ABILITY_WATER_ABSORB; // :3668–3669
  else if (moveType === TYPE_ELECTRIC) checkAbility = ABILITY_VOLT_ABSORB; // :3670–3671
  else return null; // :3672–3674: ABILITY_NONE, that is FALSE

  if (battlerAbility(v, battler) === checkAbility) return null; // :3677–3679

  const slots = aiSlots(v, battler); // :3681–3686
  const party = partyOf(v, battler);
  for (let i = 0; i < party.length; i++) { // :3693
    const mon = party[i]!;
    if (isBenchCandidate(v, mon, i, slots)) {
      // :3703–3709: `RandNext() & 1`, drawn only for a matching ability.
      if (checkAbility === u8(mon.ability) && draw(pick, LOW_BIT)) return switchTo(i);
    }
  }
  return null;
}

/**
 * AI_HasPartyMemberWithSuperEffectiveMove, trainer_ai.c:3727: a bench Pokémon that takes the last move that hit the
 * battler with an effectiveness in `checkEffectiveness`, with a move super-effective on whoever used it; each such
 * move switches on `RandNext() % rand == 0` (:3796).
 */
function hasPartyMemberWithSuperEffectiveMove(
  v: AiView, d: AiDeps, battler: number, checkEffectiveness: number, rand: number, pick: Pick,
): SwitchOutcome | null {
  const moveHit = slotOf(v.moveHit, battler, 'moveHit');
  const moveHitBattler = slotOf(v.moveHitBattler, battler, 'moveHitBattler');
  if (moveHit === MOVE_NONE || moveHitBattler === BATTLER_NONE) return null; // :3737–3739
  if (moveData(d, moveHit).power === 0) return null; // :3742–3744

  const passes = residueWeights(u8(rand))[0]!; // #{r : r % rand == 0}
  const slots = aiSlots(v, battler); // :3746–3751
  const party = partyOf(v, battler);
  for (let i = 0; i < party.length; i++) { // :3756
    const mon = party[i]!;
    if (!isBenchCandidate(v, mon, i, slots)) continue;
    // :3766–3777: the last move, from its user, against this party Pokémon's own ability, item and types.
    const hitType = aiMoveType(v, d, moveHitBattler, moveHit);
    const taken = calcEffectiveness(v, d, moveHit, hitType, battlerAbility(v, moveHitBattler), mon.ability,
      itemData(d, mon.heldItem, 'holdEffect'), mon.types[0], mon.types[1]);
    if ((taken & checkEffectiveness) === 0) continue; // :3779
    for (const move of moveSlots(mon.moves)) { // :3780
      const moveType = partyMoveType(v, d, mon, move); // :3782, for every slot
      if (move !== MOVE_NONE) {
        const effectiveness = partyMoveEffectiveness(v, d, mon, move, moveType, moveHitBattler); // :3784–3794
        if ((effectiveness & MOVE_STATUS_SUPER_EFFECTIVE) !== 0 && draw(pick, passes)) return switchTo(i); // :3796–3799
      }
    }
  }
  return null;
}

/** AI_IsAsleepWithNaturalCure, trainer_ai.c:3817. */
function isAsleepWithNaturalCure(v: AiView, d: AiDeps, battler: number, pick: Pick): SwitchOutcome | null {
  const mon = battleMon(v, battler);
  // :3820–3824; s32 curHP against u32 maxHP / 2 compares as u32.
  if ((mon.status & MON_CONDITION_SLEEP) === 0 || battlerAbility(v, battler) !== ABILITY_NATURAL_CURE
    || u32(mon.curHP) < cdiv(u32(mon.maxHP), 2)) {
    return null;
  }
  const moveHit = slotOf(v.moveHit, battler, 'moveHit');
  if (moveHit === MOVE_NONE && draw(pick, LOW_BIT)) return POST_KO; // :3828–3831
  // :3835–3838: MOVE_DATA(MOVE_NONE).power is 0 too, so with nothing hit yet this is a second coin.
  if (moveData(d, moveHit).power === 0 && draw(pick, LOW_BIT)) return POST_KO;
  const immune = hasPartyMemberWithSuperEffectiveMove(v, d, battler, MOVE_STATUS_INEFFECTIVE, 1, pick); // :3842–3844
  if (immune !== null) return immune;
  const resists = hasPartyMemberWithSuperEffectiveMove(v, d, battler, MOVE_STATUS_NOT_VERY_EFFECTIVE, 1, pick); // :3848–3850
  if (resists !== null) return resists;
  if (draw(pick, LOW_BIT)) return POST_KO; // :3853–3856
  return null;
}

/** AI_IsHeavilyStatBoosted, trainer_ai.c:3872: the stages above neutral, summed in a u8, are at least 4. */
function isHeavilyStatBoosted(v: AiView, battler: number): boolean {
  const boosts = battleMon(v, battler).statBoosts;
  let numBoosts = 0;
  for (let stat = BATTLE_STAT.HP; stat < BATTLE_STAT_MAX; stat++) { // :3877
    const stage = boosts[stat];
    if (stage === undefined) throw new AiError('BAD_VIEW', `no stat stage ${stat}`);
    if (stage > 6) numBoosts = u8(numBoosts + stage - 6); // :3878–3880
  }
  return numBoosts >= 4; // :3883
}

/**
 * TrainerAI_ShouldSwitch, trainer_ai.c:3894, for the AI's battler on one random path. The rolls are the code's, not
 * its comments': `% 2 == 0` and `% 3 == 0` (1/2 and 1/3) where :3973 and :3979 say 33% and 25%. Weather Ball without
 * usable weather in any move slot read throws AiError('UNDEFINED').
 */
export function shouldSwitch(v: AiView, d: AiDeps, pick: Pick): SwitchOutcome {
  requireSingles(v);
  const battler = AI_BATTLER;
  const mon = battleMon(v, battler);

  // :3906–3913: the trap test, naive as :3903–3905 say.
  if ((mon.statusVolatile & VOLATILE_CONDITION_TRAPPED) !== 0
    || (mon.moveEffectsMask & MOVE_EFFECT_INGRAIN) !== 0
    || countAbility(v, COUNT_ALL_BATTLERS_THEIR_SIDE, battler, ABILITY_SHADOW_TAG) !== 0
    || countAbility(v, COUNT_ALL_BATTLERS_THEIR_SIDE, battler, ABILITY_ARENA_TRAP) !== 0
    || (countAbility(v, COUNT_ALL_BATTLERS_EXCEPT_ME, battler, ABILITY_MAGNET_PULL) !== 0
      && monHasType(v, d, battler, TYPE_STEEL))) {
    return STAY;
  }

  // :3915–3938: count the bench Pokémon it could switch to.
  const slots = aiSlots(v, battler);
  const party = partyOf(v, battler);
  let alivePartyMons = 0;
  for (let i = 0; i < party.length; i++) if (isBenchCandidate(v, party[i]!, i, slots)) alivePartyMons++;
  if (alivePartyMons === 0) return STAY; // :3940

  const perishSong = perishSongKO(v, battler); // :3941–3943
  if (perishSong !== null) return perishSong;
  const wonderGuard = cannotDamageWonderGuard(v, d, battler, pick); // :3945–3947
  if (wonderGuard !== null) return wonderGuard;
  const ineffective = onlyIneffectiveMoves(v, d, battler, pick); // :3949–3951
  if (ineffective !== null) return ineffective;
  const absorb = hasAbsorbAbilityInParty(v, d, battler, pick); // :3953–3955
  if (absorb !== null) return absorb;
  const naturalCure = isAsleepWithNaturalCure(v, d, battler, pick); // :3957–3959
  if (naturalCure !== null) return naturalCure;
  if (hasSuperEffectiveMove(v, d, battler, false, pick)) return STAY; // :3964–3966
  if (isHeavilyStatBoosted(v, battler)) return STAY; // :3969–3971
  const immune = hasPartyMemberWithSuperEffectiveMove(v, d, battler, MOVE_STATUS_INEFFECTIVE, 2, pick); // :3975–3977
  if (immune !== null) return immune;
  const resists = hasPartyMemberWithSuperEffectiveMove(v, d, battler, MOVE_STATUS_NOT_VERY_EFFECTIVE, 3, pick); // :3981–3983
  if (resists !== null) return resists;
  return STAY; // :3986
}
