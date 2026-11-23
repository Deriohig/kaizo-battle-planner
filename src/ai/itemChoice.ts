// The contract Choice of the AI's bag-item use (choose/items.ts's ItemUse, through decide's AiAction): the item, and
// for a use that empties several bag slots, those slots and the routine that runs.

import type { Choice, ItemEffect } from '../contracts/engine.js';
import { bagItemId } from '../engine/index.js';
import {
  BATTLE_STAT, ITEM_AI_CATEGORY_FULL_RESTORE, ITEM_AI_CATEGORY_GUARD_SPEC, ITEM_AI_CATEGORY_MAX, ITEM_AI_CATEGORY_RECOVER_HP,
  ITEM_AI_CATEGORY_RECOVER_STATUS, ITEM_AI_CATEGORY_STAT_BOOSTER,
} from './constants.js';
import { AiError } from './errors.js';

/** A bag-item Choice. */
export type ItemChoice = Extract<Choice, { kind: 'item' }>;

const STATS: Readonly<Record<number, NonNullable<ItemEffect['stat']>>> = {
  [BATTLE_STAT.ATTACK]: 'atk', [BATTLE_STAT.DEFENSE]: 'def', [BATTLE_STAT.SPEED]: 'spe', [BATTLE_STAT.SP_ATTACK]: 'spa',
  [BATTLE_STAT.SP_DEFENSE]: 'spd', [BATTLE_STAT.ACCURACY]: 'accuracy',
};

/**
 * The contract Choice of a bag-item use (TrainerAI_ShouldUseItem's usedItem, usedItemType, usedItemCondition and the
 * slots it emptied): `item` is usedItem's bagItemId. When it emptied more than one slot, `consumeSlots` and the routine
 * that runs (`effect`, from usedItemType and usedItemCondition, battle_controller_player.c:1912–1943) go with it:
 * recoverStatus's statusMask is the condition, statBooster's stat is the condition's BATTLE_STAT, and
 * ITEM_AI_CATEGORY_MAX, which ItemCommand doesn't handle, is 'undefined'. A one-slot use runs the item's own routine,
 * so it carries neither.
 */
export function itemChoice(use: { item: number; type: number; condition: number; consumed: readonly number[] }): ItemChoice {
  const item = bagItemId(use.item);
  if (use.consumed.length <= 1) return { kind: 'item', item };
  return { kind: 'item', item, consumeSlots: [...use.consumed], effect: itemEffect(use.type, use.condition) };
}

function itemEffect(type: number, condition: number): ItemEffect {
  switch (type) {
    case ITEM_AI_CATEGORY_FULL_RESTORE: return { category: 'fullRestore' };
    case ITEM_AI_CATEGORY_RECOVER_HP: return { category: 'recoverHp' };
    case ITEM_AI_CATEGORY_RECOVER_STATUS: return { category: 'recoverStatus', statusMask: condition };
    case ITEM_AI_CATEGORY_STAT_BOOSTER: {
      const stat = STATS[condition];
      if (stat === undefined) throw new AiError('BAD_VIEW', `a stat booster's condition ${condition} names no boostable stat`);
      return { category: 'statBooster', stat };
    }
    case ITEM_AI_CATEGORY_GUARD_SPEC: return { category: 'guardSpec' };
    case ITEM_AI_CATEGORY_MAX: return { category: 'undefined' };
    default: throw new AiError('BAD_VIEW', `usedItemType ${type} is no ITEM_AI_CATEGORY`);
  }
}
