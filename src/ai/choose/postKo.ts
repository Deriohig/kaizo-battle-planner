// The post-KO replacement: BattleAI_PostKOSwitchIn (battle_lib.c:7923), and the first-living fallback the party menu
// task applies when it returns 6 (battle_display.c:4543–4559). No random draw in singles. Literal ports over AiView;
// each rule cites its C line. Pure.
//
// The switch-in may run before the turn's BattleContext_Init (battle_controller_player.c:1845–1855), so
// battleStatusMask and powerMul are read as the view gives them. Each action's MoveEnd has run it already
// (battle_controller_player.c:3998), so after a KO they are reset; at the AI's own mid-turn switch, inside its action,
// they may not be, and the adapter lists them then (read/compose.ts replacementState, battleScripts.ts). Neither stage
// compares speeds: no speedRand or Quick Claw read.

import { LEARNED_MOVES_MAX, MOVE_NONE, MOVE_STATUS_IMMUNE, MOVE_STATUS_SUPER_EFFECTIVE } from '../constants.js';
import { AiError } from '../errors.js';
import { u8 } from '../int.js';
import { battlerSide, battlerType, moveData, partyMoveType } from '../lib/battler.js';
import { calcMoveDamage } from '../lib/damage.js';
import { assertGuarded } from '../lib/known.js';
import {
  aiSlots, isBenchCandidate, moveSlots, partyMoveEffectiveness, partyOf, requireSingles, selectedSlot,
} from '../lib/party.js';
import { applyTypeChart, typeMatchupMultiplier } from '../lib/typeChart.js';
import { AI_BATTLER, type AiDeps, type AiView } from '../view.js';

/** The party index the C uses for "none" (`u8 picked = 6`, battle_lib.c:7934). */
const NO_PICK = 6;
/** Every party slot disregarded (battle_lib.c:7959, 8027). */
const ALL_DISREGARDED = 0x3f;

/**
 * BattleAI_PostKOSwitchIn, battle_lib.c:7923: the party index `battler` sends in, or 6 for none.
 *
 * Stage 1 (:7959–8029) picks the best two-type matchup against the defender that also has a super-effective move; its
 * u8 `score` wraps a 160 + 160 matchup to 64 (:7933, docs/bugs_and_glitches.md). Stage 2 (:8031–8086) picks the most
 * damage the fainted `battler` itself would deal with each candidate's moves, as a u8. A move it skips (empty, or
 * power 1) still compares the stale `score`, which before stage 2's first computed move is what stage 1 left.
 */
export function postKoSwitchIn(v: AiView, d: AiDeps, battler: number): number {
  requireSingles(v);
  const slots = aiSlots(v, battler); // :7941–7947
  // :7949: BattleSystem_RandomOpponent, which in singles is `attacker ^ 1` with no draw (battle_lib.c:4193–4194).
  const defender = battler ^ 1;
  const party = partyOf(v, battler); // :7950

  let battlersDisregarded = 0; // :7951, a u8
  /** `u8 score` (:7933): never reset, so stage 2 starts from stage 1's last value. undefined = not yet written. */
  let score: number | undefined;
  let maxScore: number;
  let picked: number;

  while (battlersDisregarded !== ALL_DISREGARDED) { // :7959
    maxScore = 0; // :7960
    picked = NO_PICK; // :7961
    for (let i = 0; i < party.length; i++) { // :7963
      const mon = party[i]!;
      if (isBenchCandidate(v, mon, i, slots) && (battlersDisregarded & (1 << i)) === 0) { // :7967–7974
        const defenderType1 = u8(battlerType(v, d, defender, 1)); // :7975
        const defenderType2 = u8(battlerType(v, d, defender, 2)); // :7976
        const monType1 = u8(mon.types[0]); // :7977
        const monType2 = u8(mon.types[1]); // :7978
        score = u8(typeMatchupMultiplier(d, monType1, defenderType1, defenderType2)); // :7980
        score = u8(score + typeMatchupMultiplier(d, monType2, defenderType1, defenderType2)); // :7981
        if (maxScore < score) { // :7983–7986: the first of equal scores wins
          maxScore = score;
          picked = i;
        }
      } else {
        battlersDisregarded = u8(battlersDisregarded | (1 << i)); // :7988
      }
    }

    if (picked === NO_PICK) {
      battlersDisregarded = ALL_DISREGARDED; // :8025–8028
      continue;
    }
    // :7994–8016: the first of its moves super-effective on the defender.
    const mon = party[picked]!;
    const moves = moveSlots(mon.moves);
    let i: number;
    for (i = 0; i < LEARNED_MOVES_MAX; i++) {
      const move = moves[i]!;
      const moveType = partyMoveType(v, d, mon, move); // :7998, for every slot
      if (move !== MOVE_NONE) {
        const flags = partyMoveEffectiveness(v, d, mon, move, moveType, defender); // :8000–8010
        if ((flags & MOVE_STATUS_SUPER_EFFECTIVE) !== 0) break; // :8012–8014
      }
    }
    if (i !== LEARNED_MOVES_MAX) return picked; // :8022–8024
    battlersDisregarded = u8(battlersDisregarded | (1 << picked)); // :8020–8021
  }

  maxScore = 0; // :8031
  picked = NO_PICK; // :8032
  for (let i = 0; i < party.length; i++) { // :8038
    const mon = party[i]!;
    if (!isBenchCandidate(v, mon, i, slots)) continue; // :8042–8048
    const moves = moveSlots(mon.moves);
    for (let j = 0; j < LEARNED_MOVES_MAX; j++) { // :8049
      const move = moves[j]!;
      const moveType = partyMoveType(v, d, mon, move); // :8051, for every slot
      if (move !== MOVE_NONE && moveData(d, move).power !== 1) { // :8053
        const sideMask = v.sideConditionsMask[battlerSide(defender)]; // :8057
        if (sideMask === undefined) throw new AiError('BAD_VIEW', `no sideConditionsMask for side ${battlerSide(defender)}`);
        // :8054–8063: the fainted battler's own stats, item and ability, with this move; power and type from the move.
        score = u8(calcMoveDamage(v, d, move, sideMask, v.fieldConditionsMask, 0, 0, battler, defender, 1));
        const chart = applyTypeChart(v, d, move, moveType, battler, defender, score); // :8065–8073, on the u8
        score = u8(chart.damage);
        if ((chart.flags & MOVE_STATUS_IMMUNE) !== 0) score = 0; // :8075–8077
      }
      // :8080–8083, for every slot, the skipped ones too (the stale-score bug). Stage 1 always wrote `score` before
      // any candidate reaches here: every candidate of stage 2 was scored on stage 1's first pass.
      if (score === undefined) throw new AiError('UNDEFINED', 'BattleAI_PostKOSwitchIn reads an uninitialised score');
      if (maxScore < score) {
        maxScore = score;
        picked = i;
      }
    }
  }
  return picked; // :8088
}

/**
 * The party index the AI sends in when aiSwitchedPartySlot[battler] is 6 (a forced switch after a KO, or a voluntary
 * switch to the post-KO logic): postKoSwitchIn, else the first living party slot that neither AI slot has selected
 * (Task_TrainerShowPartyMenu, battle_display.c:4545–4558; its partySlots are battleCtx->selectedPartySlot,
 * battle_display.c:926). In singles this is also TrainerAI_PickCommand's fallback (trainer_ai.c:4005–4024), whose extra
 * aiSwitchedPartySlot test is against 6. With no such slot the loop ends at the party's size, as the C's does.
 */
export function replacement(v: AiView, d: AiDeps): number {
  assertGuarded(v); // AiError('UNDEFINED') for an unknown path no reader guards
  const battler = AI_BATTLER;
  let slot = postKoSwitchIn(v, d, battler); // :4546
  if (slot !== NO_PICK) return slot;
  const [, partnerSlot] = aiSlots(v, battler); // :4537–4541
  const party = partyOf(v, battler); // :4549
  for (slot = 0; slot < party.length; slot++) { // :4551
    // :4554: HP alone, with no species or Egg test.
    if (party[slot]!.hp !== 0 && selectedSlot(v, battler) !== slot && selectedSlot(v, partnerSlot) !== slot) break;
  }
  return slot;
}
