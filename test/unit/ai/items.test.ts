// TrainerAI_ShouldUseItem (trainer_ai.c:4056), singles, on the fixture's turn-1 view: Garchomp (183/183 HP) with
// Gyarados and Roserade on the bench. The expected ItemUse is what the C loop leaves in usedItem, usedItemType and
// usedItemCondition, with the bag slots it zeroes. Slot n needs aliveMons <= itemCount - n + 1 (:4092).

import { describe, expect, it } from 'vitest';
import { shouldUseItem } from '../../../src/ai/choose/items.js';
import {
  BATTLE_STAT, BATTLE_TYPE_TRAINER_DOUBLES, ITEM_AI_CATEGORY_FULL_RESTORE, ITEM_AI_CATEGORY_GUARD_SPEC,
  ITEM_AI_CATEGORY_MAX, ITEM_AI_CATEGORY_RECOVER_HP, ITEM_AI_CATEGORY_RECOVER_STATUS, ITEM_AI_CATEGORY_STAT_BOOSTER,
  MON_CONDITION_BURN, MON_CONDITION_FREEZE, MON_CONDITION_PARALYSIS, MON_CONDITION_POISON, MON_CONDITION_SLEEP_1,
  MON_CONDITION_TOXIC, MOVE_EFFECT_EMBARGO, SIDE_CONDITION_MIST, VOLATILE_CONDITION_CONFUSION_1,
} from '../../../src/ai/constants.js';
import type { AiItemRecord } from '../../../src/ai/rom/items.js';
import { AI_BATTLER as AI, type AiBattleMon, type AiDeps, type AiView } from '../../../src/ai/view.js';
import { FX, fixtureDeps, fixtureView } from './fixtures.js';
import { code, frozen } from './miscHarness.js';

const I = FX.item;
const HP = ITEM_AI_CATEGORY_RECOVER_HP;
const STATUS = ITEM_AI_CATEGORY_RECOVER_STATUS;
const SLEEP = MON_CONDITION_SLEEP_1;
const CONFUSED = VOLATILE_CONDITION_CONFUSION_1;

interface Setup {
  /** The bag, as initialView and the adapter give it: the compacted list, not padded to four (default: the fixture's). */
  bag?: number[];
  mon?: Partial<AiBattleMon>;
  /** Roserade fainted: two of the AI's Pokémon alive. */
  two?: boolean;
  totalTurns?: number;
  sideConditionsMask?: [number, number];
}

/** shouldUseItem on the fixture after `setup`, frozen so a write to the view throws. */
function use({ bag, mon, two, totalTurns = 0, sideConditionsMask = [0, 0] }: Setup, d: AiDeps = fixtureDeps()) {
  const v: AiView = fixtureView({ totalTurns, sideConditionsMask });
  if (bag) Object.assign(v, { trainerItems: bag, trainerItemCount: bag.length });
  Object.assign(v.mons[AI], mon);
  if (two) v.parties[1][2]!.hp = 0;
  return shouldUseItem(frozen(v), d);
}

const used = (item: number, type: number, consumed: number[], condition = 0) => ({ item, type, condition, consumed });

describe('shouldUseItem', () => {
  // The fixture's bag is a Full Restore and a Hyper Potion; with three alive, the Hyper Potion's slot is out of reach.
  it.each<[string, Setup, ReturnType<typeof used> | null]>([
    ['Full Restore under 25%: 44 < 183 / 4 (:4099–4104)', { mon: { curHP: 44 } }, used(I.FULL_RESTORE, ITEM_AI_CATEGORY_FULL_RESTORE, [0])],
    ['no Full Restore at 25% exactly: 45 < 180 / 4 fails', { mon: { maxHP: 180, curHP: 45 } }, null],
    ['Embargo blocks items (:4076–4078)', { mon: { curHP: 10, moveEffectsMask: MOVE_EFFECT_EMBARGO } }, null],
    ['Hyper Potion when missing more than 200 (:4105–4117)', { bag: [I.HYPER_POTION], mon: { maxHP: 300, curHP: 99 } }, used(I.HYPER_POTION, HP, [0])],
    ['no Hyper Potion when missing exactly 200', { bag: [I.HYPER_POTION], mon: { maxHP: 300, curHP: 100 } }, null],
    ['an empty bag', { bag: [], mon: { curHP: 1 } }, null],
    // fakeOutTurnNumber is 1: switch-in sets it to totalTurns + 1 (battle_lib.c:2117).
    ['X Attack while fakeOutTurnNumber - totalTurns >= 0 (:4156–4160)', { bag: [I.X_ATTACK], totalTurns: 1 }, used(I.X_ATTACK, ITEM_AI_CATEGORY_STAT_BOOSTER, [0], BATTLE_STAT.ATTACK)],
    ['no X Attack later: the item is unrecognised (:4186–4188)', { bag: [I.X_ATTACK], totalTurns: 2 }, null],
    ['three alive cannot reach slot 1', { bag: [I.FULL_RESTORE, I.POTION], mon: { curHP: 100 } }, null],
    ['two alive can: a Potion at 83 missing', { bag: [I.FULL_RESTORE, I.POTION], two: true, mon: { curHP: 100 } }, used(I.POTION, HP, [1])],
    // There is no break (:4191–4194): every passing slot is zeroed, and usedItem is the last.
    ['both slots fire: both consumed', { two: true, mon: { curHP: 40 } }, used(I.HYPER_POTION, HP, [0, 1])],
    // The Antidote branch matches (:4124) but its test fails; `result` is still TRUE, so it is consumed with the Potion's type.
    ['an Antidote on a healthy Pokémon behind a Potion', { bag: [I.POTION, I.ANTIDOTE], two: true, mon: { curHP: 100 } }, used(I.ANTIDOTE, HP, [0, 1])],
    // Full Heal matches sleep first (:4118–4123), never reaching confusion; the Hyper Potion doesn't fire but is consumed.
    ['Full Heal then a Hyper Potion', { bag: [I.FULL_HEAL, I.HYPER_POTION], two: true, mon: { curHP: 100, status: SLEEP, statusVolatile: CONFUSED } },
      used(I.HYPER_POTION, STATUS, [0, 1], 1 << 5)],
    // Guard Spec needs no Mist in sideConditionsMask[1], whatever the battler (:4181–4185); it sets no condition.
    ['Guard Spec', { bag: [I.GUARD_SPEC] }, used(I.GUARD_SPEC, ITEM_AI_CATEGORY_GUARD_SPEC, [0])],
    ['Guard Spec under Mist on the AI side', { bag: [I.GUARD_SPEC], sideConditionsMask: [0, SIDE_CONDITION_MIST] }, null],
    ["Guard Spec under Mist on the player's side", { bag: [I.GUARD_SPEC], sideConditionsMask: [SIDE_CONDITION_MIST, 0] },
      used(I.GUARD_SPEC, ITEM_AI_CATEGORY_GUARD_SPEC, [0])],
    ['Guard Spec behind an Awakening keeps its condition', { bag: [I.AWAKENING, I.GUARD_SPEC], two: true, mon: { status: SLEEP } },
      used(I.GUARD_SPEC, ITEM_AI_CATEGORY_GUARD_SPEC, [0, 1], 1 << 5)],
    ['Guard Spec behind an Awakening under Mist is consumed with its type', { bag: [I.AWAKENING, I.GUARD_SPEC], two: true, mon: { status: SLEEP },
      sideConditionsMask: [0, SIDE_CONDITION_MIST] }, used(I.GUARD_SPEC, STATUS, [0, 1], 1 << 5)],
  ])('%s', (_, setup, expected) => {
    expect(use(setup)).toEqual(expected);
  });

  // Each status branch ORs FlagIndex(n) into usedItemCondition, which starts at 0 (trainer_ai.c:4066, 4118–4154).
  const CURES: [string, number, number, number][] = [
    ['Awakening, asleep', I.AWAKENING, SLEEP, 0b100000],
    ['Antidote, poisoned', I.ANTIDOTE, MON_CONDITION_POISON, 0b010000],
    ['Antidote, badly poisoned', I.ANTIDOTE, MON_CONDITION_TOXIC, 0b010000],
    ['Burn Heal, burned', I.BURN_HEAL, MON_CONDITION_BURN, 0b001000],
    ['Ice Heal, frozen', I.ICE_HEAL, MON_CONDITION_FREEZE, 0b000100],
    ['Parlyz Heal, paralysed', I.PARLYZ_HEAL, MON_CONDITION_PARALYSIS, 0b000010],
  ];
  const PERSIM: [string, number, number, number] = ['Persim Berry, confused', I.PERSIM_BERRY, 0, 0b000001];
  it.each([...CURES, PERSIM])('%s sets its bit; healthy, nothing is used', (_, item, status, bit) => {
    const mon = item === I.PERSIM_BERRY ? { statusVolatile: CONFUSED } : { status };
    expect(use({ bag: [item], mon })).toEqual(used(item, STATUS, [0], bit));
    expect(use({ bag: [item] })).toBeNull();
  });

  it('status bits accumulate across passing slots, in either bag order', () => {
    for (const [, item, status, bit] of CURES) {
      for (const bag of [[item, I.PERSIM_BERRY], [I.PERSIM_BERRY, item]]) {
        expect(use({ bag, two: true, mon: { status, statusVolatile: CONFUSED } }), `bag ${bag.join(', ')}`)
          .toEqual(used(bag[1]!, STATUS, [0, 1], bit | 0b000001));
      }
    }
  });

  it.each([
    ['X Attack', I.X_ATTACK, BATTLE_STAT.ATTACK], ['X Defend', I.X_DEFENSE, BATTLE_STAT.DEFENSE],
    ['X Special', I.X_SPECIAL, BATTLE_STAT.SP_ATTACK], ['X Sp. Def', I.X_SP_DEF, BATTLE_STAT.SP_DEFENSE],
    ['X Speed', I.X_SPEED, BATTLE_STAT.SPEED], ['X Accuracy', I.X_ACCURACY, BATTLE_STAT.ACCURACY],
  ])('%s behind an Awakening overwrites its condition with its stat (trainer_ai.c:4157–4180)', (_, item, stat) => {
    expect(use({ bag: [I.AWAKENING, item], two: true, mon: { status: SLEEP } })).toEqual(used(item, ITEM_AI_CATEGORY_STAT_BOOSTER, [0, 1], stat));
  });

  it("X items and Dire Hit read as unusable when the hack's partyUse is 0", () => {
    // partyUse 0 with a 0 `dummy` byte makes every party param 0 (item.c:186–194).
    const zeroParty = (record: AiItemRecord): AiItemRecord => ({
      ...record, hpRestore: false, hpRestored: 0, healSleep: false, healPoison: false, healBurn: false, healFreeze: false,
      healParalysis: false, healConfusion: false, atkStages: 0, defStages: 0, spAtkStages: 0, spDefStages: 0,
      speedStages: 0, accStages: 0, guardSpec: false,
    });
    const d = fixtureDeps();
    d.items[I.X_ATTACK] = zeroParty(d.items[I.X_ATTACK]!);
    d.items[I.DIRE_HIT] = zeroParty(d.items[I.DIRE_HIT]!);
    // Alone they never fire: no stage branch matches (:4157–4185), and later the else branch only sets the type (:4186–4188).
    for (const totalTurns of [0, 2]) expect(use({ bag: [I.X_ATTACK, I.DIRE_HIT], two: true, totalTurns }, d)).toBeNull();
    // Behind a Hyper Potion that fires, both are consumed: its type on the first turn in, ITEM_AI_CATEGORY_MAX after.
    const behind = (totalTurns: number) => use({ bag: [I.HYPER_POTION, I.X_ATTACK, I.DIRE_HIT], two: true, totalTurns, mon: { maxHP: 300, curHP: 99 } }, d);
    expect(behind(0)).toEqual(used(I.DIRE_HIT, HP, [0, 1, 2]));
    expect(behind(2)).toEqual(used(I.DIRE_HIT, ITEM_AI_CATEGORY_MAX, [0, 1, 2]));
  });

  it('a bag of more than four slots is a bad view (ai_context.h:31); doubles are unsupported', () => {
    expect(() => use({ bag: [I.POTION, I.POTION, I.POTION, I.POTION, I.POTION] })).toThrow(code('BAD_VIEW'));
    expect(() => shouldUseItem(fixtureView({ battleType: BATTLE_TYPE_TRAINER_DOUBLES }), fixtureDeps())).toThrow(code('UNSUPPORTED'));
  });
});
