// The party and bench helpers the switch, post-KO and item ports share: literal reads of BattleContext and the party
// over AiView, each citing the C it ports. Pure.

import {
  BATTLE_TYPE_2vs2, BATTLE_TYPE_DOUBLES, BATTLE_TYPE_TAG, LEARNED_MOVES_MAX, SPECIES_EGG, SPECIES_NONE,
} from '../constants.js';
import { AiError } from '../errors.js';
import { u16 } from '../int.js';
import type { AiDeps, AiPartyMon, AiView } from '../view.js';
import { battlerAbility, battlerSide, battlerType, heldItemEffect, partner } from './battler.js';
import { calcEffectiveness } from './typeChart.js';

/** The party size limit: index 6 is the C's "none" (aiSwitchedPartySlot, BattleAI_PostKOSwitchIn's `picked`). */
const MAX_PARTY_SIZE = 6;

/** A singles view, or AiError('UNSUPPORTED'). */
export function requireSingles(v: AiView): void {
  if ((v.battleType & BATTLE_TYPE_DOUBLES) !== 0) throw new AiError('UNSUPPORTED', 'double battles are not supported');
}

/** BattleSystem_GetParty / GetPartyPokemon: `battler`'s side's party. AiError('BAD_VIEW') when missing or over 6. */
export function partyOf(v: AiView, battler: number): AiPartyMon[] {
  const party = v.parties[battlerSide(battler)];
  if (party === undefined || party.length > MAX_PARTY_SIZE) {
    throw new AiError('BAD_VIEW', `no party of at most ${MAX_PARTY_SIZE} for battler ${battler}`);
  }
  return party;
}

/** battleCtx->selectedPartySlot[battler]. */
export function selectedSlot(v: AiView, battler: number): number {
  return slotOf(v.selectedPartySlot, battler, 'selectedPartySlot');
}

/** battleCtx->aiSwitchedPartySlot[battler]. */
function switchedSlot(v: AiView, battler: number): number {
  return slotOf(v.aiSwitchedPartySlot, battler, 'aiSwitchedPartySlot');
}

/** `values[battler]`, a by-battler BattleContext array named `name`, or AiError('BAD_VIEW') when the view has none. */
export function slotOf(values: number[], battler: number, name: string): number {
  const value = values[battler];
  if (value === undefined) throw new AiError('BAD_VIEW', `no ${name} for battler ${battler}`);
  return value;
}

/**
 * aiSlot1 and aiSlot2 (trainer_ai.c:3416–3422 and its copies; battle_lib.c:7941–7947; battle_display.c:4537–4541):
 * the battler, and BattleSystem_GetPartner unless Tag or 2vs2. In singles the partner is the battler itself
 * (battle_system.c:400–402), so both slots are the battler.
 */
export function aiSlots(v: AiView, battler: number): [number, number] {
  if ((v.battleType & BATTLE_TYPE_TAG) !== 0 || (v.battleType & BATTLE_TYPE_2vs2) !== 0) return [battler, battler];
  return [battler, partner(v, battler)];
}

/** Pokemon_GetValue(MON_DATA_SPECIES_OR_EGG) is neither SPECIES_NONE nor SPECIES_EGG. */
export function isPokemon(mon: AiPartyMon): boolean {
  return mon.species !== SPECIES_NONE && mon.species !== SPECIES_EGG;
}

/**
 * The bench test the switch code repeats (trainer_ai.c:3434–3440, 3493–3499, 3696–3702, 3759–3765, 3929–3935; the
 * post-KO logic's at battle_lib.c:7967–7974 and 8042–8048): alive, a Pokémon, and neither the selected nor the
 * already-switched-to party slot of either AI slot.
 */
export function isBenchCandidate(v: AiView, mon: AiPartyMon, i: number, [slot1, slot2]: [number, number]): boolean {
  return mon.hp !== 0 && isPokemon(mon)
    && i !== selectedSlot(v, slot1) && i !== selectedSlot(v, slot2)
    && i !== switchedSlot(v, slot1) && i !== switchedSlot(v, slot2);
}

/** The four move slots of `moves`, as the C's u16 `move`. AiError('BAD_VIEW') if there are fewer. */
export function moveSlots(moves: number[]): number[] {
  if (moves.length < LEARNED_MOVES_MAX) throw new AiError('BAD_VIEW', `${moves.length} move slots, not ${LEARNED_MOVES_MAX}`);
  return moves.slice(0, LEARNED_MOVES_MAX).map(u16);
}

/**
 * BattleSystem_CalcEffectiveness of party Pokémon `mon`'s `move` (of variable type `type`) against battler
 * `defender`, as every switch caller passes it: the party Pokémon's own ability, and the defender's Battler_Ability,
 * Battler_HeldItemEffect and BattleMon_Get types (trainer_ai.c:3328–3336, 3448–3456, 3786–3794;
 * battle_lib.c:8002–8010).
 */
export function partyMoveEffectiveness(
  v: AiView, d: AiDeps, mon: AiPartyMon, move: number, type: number, defender: number,
): number {
  return calcEffectiveness(v, d, move, type, mon.ability, battlerAbility(v, defender), heldItemEffect(v, d, defender),
    battlerType(v, d, defender, 1), battlerType(v, d, defender, 2));
}
