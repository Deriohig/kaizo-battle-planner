// The bag-item use: TrainerAI_ShouldUseItem (trainer_ai.c:4056). No random draw. A literal port over AiView; each rule
// cites its C line. Pure: the C's writes to AI_CONTEXT come back as the ItemUse.

import {
  BATTLE_STAT, ITEM_AI_CATEGORY_FULL_RESTORE, ITEM_AI_CATEGORY_GUARD_SPEC, ITEM_AI_CATEGORY_MAX,
  ITEM_AI_CATEGORY_RECOVER_HP, ITEM_AI_CATEGORY_RECOVER_STATUS, ITEM_AI_CATEGORY_STAT_BOOSTER, ITEM_FULL_RESTORE,
  ITEM_NONE, MAX_TRAINER_ITEMS, MON_CONDITION_BURN, MON_CONDITION_FREEZE, MON_CONDITION_PARALYSIS, MON_CONDITION_POISON,
  MON_CONDITION_SLEEP, MON_CONDITION_TOXIC, MOVE_EFFECT_EMBARGO, SIDE_CONDITION_MIST, VOLATILE_CONDITION_CONFUSION,
} from '../constants.js';
import { AiError } from '../errors.js';
import { cdiv, u16, u32, u8 } from '../int.js';
import { battleMon } from '../lib/battler.js';
import { isPokemon, partyOf, requireSingles } from '../lib/party.js';
import type { AiItemRecord } from '../rom/items.js';
import { AI_BATTLER, type AiDeps, type AiView } from '../view.js';

/**
 * What TrainerAI_ShouldUseItem leaves when it returns TRUE: AI_CONTEXT.usedItem (`item`, the last bag slot it zeroed),
 * usedItemType (`type`, ITEM_AI_CATEGORY_*), usedItemCondition (`condition`: the OR of FlagIndex bits of every status
 * branch that passed, or the BATTLE_STAT_* of the last stat booster), and the trainerItems slots it zeroed
 * (`consumed`, in order). Item IDs are the ROM's.
 */
export interface ItemUse { item: number; type: number; condition: number; consumed: number[] }

/** FlagIndex(n) (include/battle/common.h): bit n. */
function flagIndex(n: number): number {
  return 1 << n;
}

/**
 * BattleSystem_GetItemData, battle_lib.c:7254: `item`'s record, as AiItemRecord already reads each parameter
 * (item.c:186–194). AiError('BAD_VIEW') when there is none: the cartridge would read past its item table.
 */
function itemRecord(d: AiDeps, item: number): AiItemRecord {
  const record = d.items[u16(item)];
  if (record === undefined || record === null) {
    throw new AiError('BAD_VIEW', `item ${item} has no record; the cartridge would read past its item table`);
  }
  return record;
}

/**
 * TrainerAI_ShouldUseItem, trainer_ai.c:4056, for the AI's battler: the item use, or null for FALSE. There is no break
 * after a usable item (:4191–4194): `result` stays TRUE, so every later bag slot that passes the alive-count gate is
 * zeroed and becomes usedItem as well, whether or not its own test passed, and usedItemType and usedItemCondition are
 * as the last branch that set them left them.
 */
export function shouldUseItem(v: AiView, d: AiDeps): ItemUse | null {
  requireSingles(v);
  const battler = AI_BATTLER;
  let condition = 0; // :4066: usedItemCondition = 0, a u8
  /** usedItemType: not reset (:4056–4067), but every branch that sets `result` sets it first. */
  let type: number | undefined;
  let usedItem = ITEM_NONE;
  const consumed: number[] = [];
  let result = false; // :4067

  // :4070–4073, the AI partner's gate, needs BATTLE_TYPE_DOUBLES (in BATTLE_TYPE_TRAINER_WITH_AI_PARTNER): never in singles.
  const mon = battleMon(v, battler);
  if ((mon.moveEffectsMask & MOVE_EFFECT_EMBARGO) !== 0) return null; // :4076–4078

  let aliveMons = 0; // :4059, a u8; the active Pokémon counts too
  for (const member of partyOf(v, battler)) { // :4080–4089
    if (member.hp !== 0 && isPokemon(member)) aliveMons = u8(aliveMons + 1);
  }

  // AIContext.trainerItems holds MAX_TRAINER_ITEMS per side (ai_context.h:31). A shorter list is the compacted one
  // initialView and the adapter give: battle start clears AIContext and copies the non-empty ROM slots to its front
  // (battle_controller_player.c:4799–4813), so every slot past the list holds ITEM_NONE.
  if (v.trainerItems.length > MAX_TRAINER_ITEMS) {
    throw new AiError('BAD_VIEW', `${v.trainerItems.length} trainerItems slots, more than ${MAX_TRAINER_ITEMS}`);
  }
  // s32 curHP against u32 maxHP: the comparisons and the subtraction are u32 (:4100, 4112–4113).
  const curHP = u32(mon.curHP);
  const maxHP = u32(mon.maxHP);

  for (let i = 0; i < MAX_TRAINER_ITEMS; i++) { // :4091
    if (!(i === 0 || aliveMons <= u8(v.trainerItemCount) - i + 1)) continue; // :4092
    const item = u16(v.trainerItems[i] ?? ITEM_NONE); // :4093; past the compacted list, the cleared ITEM_NONE
    if (item === ITEM_NONE) continue; // :4095–4097

    if (item === ITEM_FULL_RESTORE) { // :4099
      if (curHP < cdiv(maxHP, 4) && curHP !== 0) { // :4100–4101
        type = ITEM_AI_CATEGORY_FULL_RESTORE;
        result = true;
      }
    } else {
      const record = itemRecord(d, item);
      if (record.hpRestore) { // :4105
        const hpRestore = u8(record.hpRestored); // :4106, into a u8
        if (hpRestore !== 0) { // :4110
          if (curHP !== 0 && (curHP < cdiv(maxHP, 4) || u32(maxHP - curHP) > hpRestore)) { // :4111–4113
            type = ITEM_AI_CATEGORY_RECOVER_HP;
            result = true;
          }
        }
      } else if (record.healSleep) { // :4118
        if ((mon.status & MON_CONDITION_SLEEP) !== 0) {
          condition = u8(condition | flagIndex(5));
          type = ITEM_AI_CATEGORY_RECOVER_STATUS;
          result = true;
        }
      } else if (record.healPoison) { // :4124
        if ((mon.status & MON_CONDITION_POISON) !== 0 || (mon.status & MON_CONDITION_TOXIC) !== 0) {
          condition = u8(condition | flagIndex(4));
          type = ITEM_AI_CATEGORY_RECOVER_STATUS;
          result = true;
        }
      } else if (record.healBurn) { // :4131
        if ((mon.status & MON_CONDITION_BURN) !== 0) {
          condition = u8(condition | flagIndex(3));
          type = ITEM_AI_CATEGORY_RECOVER_STATUS;
          result = true;
        }
      } else if (record.healFreeze) { // :4137
        if ((mon.status & MON_CONDITION_FREEZE) !== 0) {
          condition = u8(condition | flagIndex(2));
          type = ITEM_AI_CATEGORY_RECOVER_STATUS;
          result = true;
        }
      } else if (record.healParalysis) { // :4143
        if ((mon.status & MON_CONDITION_PARALYSIS) !== 0) {
          condition = u8(condition | flagIndex(1));
          type = ITEM_AI_CATEGORY_RECOVER_STATUS;
          result = true;
        }
      } else if (record.healConfusion) { // :4149
        if ((mon.statusVolatile & VOLATILE_CONDITION_CONFUSION) !== 0) {
          condition = u8(condition | flagIndex(0));
          type = ITEM_AI_CATEGORY_RECOVER_STATUS;
          result = true;
        }
      } else if (mon.effects.fakeOutTurnNumber - v.totalTurns >= 0) {
        // :4156, int arithmetic: true while totalTurns <= fakeOutTurnNumber, which switch-in sets to totalTurns + 1
        // (battle_lib.c:2117). So these are used early, not "after the first turn" as the comment at :4155 says.
        if (record.atkStages !== 0) { // :4157
          condition = BATTLE_STAT.ATTACK;
          type = ITEM_AI_CATEGORY_STAT_BOOSTER;
          result = true;
        } else if (record.defStages !== 0) { // :4161
          condition = BATTLE_STAT.DEFENSE;
          type = ITEM_AI_CATEGORY_STAT_BOOSTER;
          result = true;
        } else if (record.spAtkStages !== 0) { // :4165
          condition = BATTLE_STAT.SP_ATTACK;
          type = ITEM_AI_CATEGORY_STAT_BOOSTER;
          result = true;
        } else if (record.spDefStages !== 0) { // :4169
          condition = BATTLE_STAT.SP_DEFENSE;
          type = ITEM_AI_CATEGORY_STAT_BOOSTER;
          result = true;
        } else if (record.speedStages !== 0) { // :4173
          condition = BATTLE_STAT.SPEED;
          type = ITEM_AI_CATEGORY_STAT_BOOSTER;
          result = true;
        } else if (record.accStages !== 0) { // :4177
          condition = BATTLE_STAT.ACCURACY;
          type = ITEM_AI_CATEGORY_STAT_BOOSTER;
          result = true;
        } else if (record.guardSpec && (v.sideConditionsMask[1] & SIDE_CONDITION_MIST) === 0) { // :4181–4182: side 1
          type = ITEM_AI_CATEGORY_GUARD_SPEC;
          result = true;
        }
      } else {
        type = ITEM_AI_CATEGORY_MAX; // :4186–4188: unrecognised; `result` untouched
      }
    }

    if (result) { // :4191–4194
      usedItem = item;
      consumed.push(i);
    }
  }

  if (!result) return null; // :4198
  return { item: usedItem, type: type!, condition, consumed };
}
