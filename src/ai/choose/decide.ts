// The AI's whole turn: TrainerAI_PickCommand (trainer_ai.c:3989–4040) for the AI's battler in a single battle, as one
// exact distribution over the actions it takes. The C's order is kept: TrainerAI_ShouldSwitch first (:4001); if it
// stays, TrainerAI_ShouldUseItem (:4034); if no item, it fights (:4039), and the fight is TrainerAI_Main
// (battle_display.c:3587–3590). So
//
//   P(switch to i) = P(ShouldSwitch picks i) + P(ShouldSwitch picks the post-KO logic, which sends in i)
//   P(item)        = P(stay)                       when ShouldUseItem fires (it draws no random number)
//   P(move slot s) = P(stay) · moveDistribution(s)  otherwise
//
// ShouldSwitch's draws, the move choice's draws and the item check are independent: each RandNext() is its own uniform
// u16, and a ShouldSwitch that returns FALSE writes nothing the later steps read. Pure: the C's writes to
// aiSwitchedPartySlot, AI_CONTEXT and trainerItems come back as the actions.

import type { Rational } from '../../contracts/engine.js';
import { BATTLE_TYPE_TRAINER } from '../constants.js';
import { enumerate } from '../enumerate.js';
import { AiError } from '../errors.js';
import { assertGuarded } from '../lib/known.js';
import { isPokemon, partyOf, requireSingles, selectedSlot } from '../lib/party.js';
import { add, eq, mul, ONE, sum, ZERO } from '../odds.js';
import { AI_BATTLER, type AiDeps, type AiKnowledge, type AiView } from '../view.js';
import { shouldUseItem } from './items.js';
import { moveDistribution } from './moves.js';
import { replacement } from './postKo.js';
import { shouldSwitch, type SwitchOutcome } from './switch.js';

/**
 * What the AI does this turn. A move slot (0–3) as TrainerAI_Main picks it, which may be a slot it can't use (no PP,
 * Disabled; moves.ts); a party index to switch to; or a bag item, as TrainerAI_ShouldUseItem leaves it (items.ts):
 * usedItem (`item`, a ROM item ID), usedItemType (`type`, ITEM_AI_CATEGORY_*), usedItemCondition (`condition`) and the
 * trainerItems slots it zeroed (`consumed`). `type` and `condition` choose the routine that applies the item
 * (battle_controller_player.c:1913–1935), which can differ from `item`'s own effect when several slots are consumed.
 */
export type AiAction =
  | { kind: 'move'; slot: number }
  | { kind: 'switch'; partyIndex: number }
  | { kind: 'item'; item: number; type: number; condition: number; consumed: number[] };

/** An action with its exact probability. */
export interface ActionDist { action: AiAction; probability: Rational }

/** aiSwitchedPartySlot's value for "send in by the post-KO logic" (trainer_ai.c:3267, 3829, 3836, 3854, 4004). */
const POST_KO_SLOT = 6;

/** TrainerAI_PickCommand's command order (:4030, 4035, 4039), for sorting. */
const KIND_ORDER: Record<AiAction['kind'], number> = { switch: 0, item: 1, move: 2 };

function outcomeKey(outcome: SwitchOutcome): string {
  return outcome.kind === 'switch' ? `switch ${outcome.partyIndex}` : outcome.kind;
}

function actionKey(action: AiAction): string {
  if (action.kind === 'switch') return `switch ${action.partyIndex}`;
  if (action.kind === 'move') return `move ${action.slot}`;
  return 'item';
}

function actionIndex(action: AiAction): number {
  if (action.kind === 'switch') return action.partyIndex;
  if (action.kind === 'move') return action.slot;
  return 0;
}

/**
 * The party index sent in when TrainerAI_ShouldSwitch chose the post-KO logic (trainer_ai.c:4004–4027). ShouldSwitch
 * has written aiSwitchedPartySlot[battler] = 6 by then (:3267, 3829, 3836, 3854), and BattleAI_PostKOSwitchIn's bench
 * test reads it (battle_lib.c:7973–7974), so the replacement runs on the view with that write. In singles the
 * fallback here (:4013–4024) is replacement's: its extra aiSwitchedPartySlot test is against 6, which no index equals.
 */
function postKoPartyIndex(v: AiView, d: AiDeps): number {
  const switched = [...v.aiSwitchedPartySlot];
  switched[AI_BATTLER] = POST_KO_SLOT;
  return replacement({ ...v, aiSwitchedPartySlot: switched }, d);
}

/**
 * A switch to `partyIndex`, or AiError('BAD_VIEW') when there is nothing the cartridge could send in: an index at the
 * party's size, where the fallback's loop ends when no slot is left (:4014–4024), any other index outside the party,
 * a slot that holds no Pokémon, or the active Pokémon itself.
 */
function switchAction(v: AiView, partyIndex: number): AiAction {
  const party = partyOf(v, AI_BATTLER);
  if (partyIndex === party.length) throw new AiError('BAD_VIEW', `no Pokémon left to switch to (party of ${party.length})`);
  const mon = party[partyIndex];
  if (!Number.isInteger(partyIndex) || mon === undefined) throw new AiError('BAD_VIEW', `no party index ${partyIndex}`);
  if (!isPokemon(mon)) throw new AiError('BAD_VIEW', `party index ${partyIndex} holds no Pokémon`);
  if (partyIndex === selectedSlot(v, AI_BATTLER)) throw new AiError('BAD_VIEW', `party index ${partyIndex} is already in`);
  return { kind: 'switch', partyIndex };
}

/** The order TrainerAI_PickCommand tries actions in: switches by party index, then the item, then moves by slot. */
function byCommandOrder(a: ActionDist, b: ActionDist): number {
  return KIND_ORDER[a.action.kind] - KIND_ORDER[b.action.kind] || actionIndex(a.action) - actionIndex(b.action);
}

/** Adds `action` at `probability` to `merged`, summing with an equal action already there. */
function addTo(merged: Map<string, ActionDist>, action: AiAction, probability: Rational): void {
  const key = actionKey(action);
  const seen = merged.get(key);
  if (seen) seen.probability = add(seen.probability, probability);
  else merged.set(key, { action, probability });
}

/**
 * TrainerAI_PickCommand alone (trainer_ai.c:3989–4040), the command the AI's battler picks when the battle asks it
 * (Task_TrainerSetCommandSelection, battle_display.c:3408–3411): its switches and its bag item, each with its exact
 * probability (`actions`, merged and in the C's order), and `fight`, the probability it returns PLAYER_INPUT_FIGHT
 * (:4039). The move is a later, separate step (decide): TrainerAI_Main, unless the battle plays a forced move
 * (battle_controller_player.c:432–455). `actions` and `fight` sum to ONE. Throws as decide does, the move choice's
 * errors aside: first of all 'UNDEFINED' for a view listing an unknown path no reader guards (assertGuarded).
 */
export function pickCommand(v: AiView, d: AiDeps): { actions: ActionDist[]; fight: Rational } {
  assertGuarded(v); // AiError('UNDEFINED') for an unknown path no reader guards
  requireSingles(v);
  const merged = new Map<string, ActionDist>();
  const addAction = (action: AiAction, probability: Rational): void => addTo(merged, action, probability);

  let stay = ONE;
  // :4000: the switch and item checks run in a trainer battle, or for a battler on the player's side. The AI's battler
  // is on the enemy side, so outside a trainer battle it only fights. (Of those, only a roamer's move comes from
  // TrainerAI_Main; another wild Pokémon's is a plain `RandNext() % validMovesCount`, battle_display.c:3600–3611, which
  // this doesn't model. The adapter builds trainer battles only.)
  if ((v.battleType & BATTLE_TYPE_TRAINER) !== 0) {
    stay = ZERO;
    // :4001. enumerate merges equal outcomes, so each comes once: the replacement runs at most once.
    for (const { value: outcome, probability } of enumerate((pick) => shouldSwitch(v, d, pick), outcomeKey)) {
      if (outcome.kind === 'stay') stay = add(stay, probability);
      // :4030, PLAYER_INPUT_PARTY; the post-KO logic first resolves to a party index (:4004–4027).
      else if (outcome.kind === 'switch') addAction(switchAction(v, outcome.partyIndex), probability);
      else addAction(switchAction(v, postKoPartyIndex(v, d)), probability);
    }

    if (stay.num !== 0n) {
      const use = shouldUseItem(v, d); // :4034
      if (use !== null) { // :4035, PLAYER_INPUT_ITEM
        const { item, type, condition, consumed } = use;
        addAction({ kind: 'item', item, type, condition, consumed: [...consumed] }, stay);
        stay = ZERO;
      }
    }
  }

  const actions = [...merged.values()].sort(byCommandOrder);
  const total = add(sum(actions.map((entry) => entry.probability)), stay);
  if (!eq(total, ONE)) throw new Error(`the commands sum to ${total.num}/${total.den}, not 1`);
  return { actions, fight: stay };
}

/**
 * TrainerAI_PickCommand, trainer_ai.c:3989, and the fight it leads to: every action the AI's battler can take this
 * turn, with its exact probability, summing to ONE. Equal actions are merged, so a switch reached both directly and
 * through the post-KO logic is one entry. Ordered as the C tries them: switches by party index, then the item, then
 * moves by slot. Every probability is above 0.
 *
 * Throws AiError as its parts do: 'UNSUPPORTED' (double battles), 'UNDEFINED' (Weather Ball without usable weather in
 * the switch checks), the move choice's errors, and 'BAD_VIEW' for a switch to the active Pokémon or to no
 * Pokémon. The item check and the move choice run only when the switch check can stay, the replacement only when it
 * can choose the post-KO logic, as in the cartridge.
 */
export function decide(v: AiView, d: AiDeps, k: AiKnowledge): ActionDist[] {
  const { actions, fight } = pickCommand(v, d);
  const merged = new Map<string, ActionDist>(actions.map((entry) => [actionKey(entry.action), { ...entry }]));
  if (fight.num !== 0n) {
    // :4039, PLAYER_INPUT_FIGHT: TrainerAI_Main picks the move (battle_display.c:3587–3590).
    for (const { slot, probability } of moveDistribution(v, d, k)) {
      addTo(merged, { kind: 'move', slot }, mul(fight, probability));
    }
  }

  const result = [...merged.values()].sort(byCommandOrder);
  const total = sum(result.map((entry) => entry.probability));
  if (!eq(total, ONE)) throw new Error(`the actions sum to ${total.num}/${total.den}, not 1`);
  return result;
}
