// Trainer bag items: the trainer's four trdata item slots, which its AI uses on its active Pokémon.
//
// The bag. At battle start the cartridge copies the trainer's non-empty item slots, in ROM order, into the AI's item
// list (pokeplatinum src/battle/battle_controller_player.c:4801-4813). That is the list `RomTrainer.items` gives, and
// `Choice.consumeSlots` indexes it. A use empties slots in place (`trainerItems[i] = 0`,
// src/battle/trainer_ai/trainer_ai.c:4191-4194), so positions never shift. The engine keeps the list at its starting
// length, with 0 for a used slot, in the battle's `formatData`, which Showdown's `toJSON` carries.
//
// A use. `checkTrainerItem` checks a p2 item choice. `queueTrainerItem` then empties its slots, keeps the use as
// pending and queues an `event` action at order 103.5: after the player's switch (Showdown's switches are order 103)
// and before every move (order 200). The cartridge runs items and switches before moves, in battler order with the
// player's battler first, and sorts only commands of the same kind by speed (battle_controller_player.c:754-786). The
// action fires the format's `on<TRAINER_ITEM_EVENT>` handler (dex.ts), which calls `runTrainerItem`.
//
// The effects are the cartridge's for a trainer's item. `BattleControllerPlayer_ItemCommand` runs the subscript of the
// AI's category (`usedItemType`) with the AI's item (`usedItem`) as its message and numbers
// (battle_controller_player.c:1912-1943). Each subscript prints "used one <item>!" and calls `BattleSystem_UseBagItem`
// (src/battle/battle_system.c:435-758), which applies every one of the item's own parameters
// (res/items/data/<item>.json, `itemUseParams`); some subscripts then add their own step. The category and item can
// differ after a multi-slot use (the contract's `ItemEffect`); without an `effect`, the item runs its own category.

import PS from 'pokemon-showdown';
import type { ItemEffect } from '../contracts/engine.js';
import { itemId } from './ids.js';
import { EngineError } from './types.js';
import { addUnmodelledNote } from './unmodelled.js';

const { toID } = PS;

/** The event a trainer item action fires, and the format's handler for it is `on` + this. */
export const TRAINER_ITEM_EVENT = 'KaizoTrainerItem';

/** After the player's switch, before every move. */
const TRAINER_ITEM_ORDER = 103.5;

/**
 * Gen 4 names of the medicine and battle items, by ROM item ID: pokeplatinum generated/items.txt gives the IDs
 * (line ID + 1), res/items/data/<item>.json the names. Other IDs (Poké Balls, held items) have Showdown names. The
 * engine's index exports it, so a consumer (the solver's labeler) can name a bag item as `bagItemId` IDs it.
 */
export const BAG_ITEM_NAMES: Readonly<Record<number, string>> = {
  17: 'Potion', 18: 'Antidote', 19: 'Burn Heal', 20: 'Ice Heal', 21: 'Awakening', 22: 'Parlyz Heal', 23: 'Full Restore',
  24: 'Max Potion', 25: 'Hyper Potion', 26: 'Super Potion', 27: 'Full Heal', 28: 'Revive', 29: 'Max Revive',
  30: 'Fresh Water', 31: 'Soda Pop', 32: 'Lemonade', 33: 'Moomoo Milk', 34: 'EnergyPowder', 35: 'Energy Root',
  36: 'Heal Powder', 37: 'Revival Herb', 38: 'Ether', 39: 'Max Ether', 40: 'Elixir', 41: 'Max Elixir', 42: 'Lava Cookie',
  43: 'Berry Juice', 44: 'Sacred Ash', 45: 'HP Up', 46: 'Protein', 47: 'Iron', 48: 'Carbos', 49: 'Calcium',
  50: 'Rare Candy', 51: 'PP Up', 52: 'Zinc', 53: 'PP Max', 54: 'Old Gateau', 55: 'Guard Spec.', 56: 'Dire Hit',
  57: 'X Attack', 58: 'X Defend', 59: 'X Speed', 60: 'X Accuracy', 61: 'X Special', 62: 'X Sp. Def',
};

/**
 * The id a `Choice` item names ROM item `romItem` by: `toID` of its Gen 4 name ("potion", "fullrestore", "xspdef",
 * "guardspec"), or the Showdown item ID for an item outside `BAG_ITEM_NAMES` ("pokeball"); '' for 0 (no item). The
 * trainer AI builds its item choices with this.
 */
export function bagItemId(romItem: number): string {
  if (romItem === 0) return '';
  const name = BAG_ITEM_NAMES[romItem];
  return name === undefined ? itemId(romItem) : toID(name);
}

type StatusId = 'slp' | 'psn' | 'tox' | 'brn' | 'frz' | 'par';
type ItemStat = NonNullable<ItemEffect['stat']>;

/** What `BattleSystem_UseBagItem` does with a supported item's own parameters, in its order. */
interface BagItemParams {
  /** The statuses it cures; poison covers toxic (battle_system.c:459-541). */
  cures?: readonly StatusId[];
  /** It snaps the Pokémon out of confusion (battle_system.c:543-551). */
  confusion?: true;
  /** Mist on the user's side for 5 turns, unless the side has Mist (battle_system.c:563-573): Showdown's `mist`. */
  mist?: true;
  /**
   * +1 stage to this stat, up to +6, whatever the item's stage parameter (battle_system.c:575-615). The stage is added
   * directly, not through a stat change, so Simple does not double it.
   */
  stage?: ItemStat;
  /**
   * Sets the Focus Energy flag unless it is set (battle_system.c:617-626), worth +2 critical-hit stages
   * (src/battle/battle_lib.c:7123): Showdown's `focusenergy` volatile. Dire Hit's `critStages` parameter is unused.
   */
  focusEnergy?: true;
  /**
   * The HP restored, or 'full' for the 0xFF parameter (battle_system.c:677-680), when the Pokémon's HP is not full
   * (battle_system.c:674). For the trainer's side it is only stored, in `moveEffectsData.itemHPRecovery`
   * (battle_system.c:704-706); the potion subscript then heals by it (subscript_use_potion.s:12-17).
   */
  hp?: number | 'full';
}

const ALL_STATUSES: readonly StatusId[] = ['slp', 'psn', 'tox', 'brn', 'frz', 'par'];

/** The supported items' parameters, by ROM item ID, from res/items/data/<item>.json. */
const ITEM_PARAMS: ReadonlyMap<number, BagItemParams> = new Map<number, BagItemParams>([
  [17, { hp: 20 }], // Potion
  [18, { cures: ['psn', 'tox'] }], // Antidote
  [19, { cures: ['brn'] }], // Burn Heal
  [20, { cures: ['frz'] }], // Ice Heal
  [21, { cures: ['slp'] }], // Awakening
  [22, { cures: ['par'] }], // Parlyz Heal
  [23, { cures: ALL_STATUSES, confusion: true, hp: 'full' }], // Full Restore
  [24, { hp: 'full' }], // Max Potion
  [25, { hp: 200 }], // Hyper Potion: the JSON's -56 is the u8 200
  [26, { hp: 50 }], // Super Potion
  [27, { cures: ALL_STATUSES, confusion: true }], // Full Heal
  [55, { mist: true }], // Guard Spec.
  [56, { focusEnergy: true }], // Dire Hit
  [57, { stage: 'atk' }], // X Attack
  [58, { stage: 'def' }], // X Defend
  [59, { stage: 'spe' }], // X Speed
  [60, { stage: 'accuracy' }], // X Accuracy
  [61, { stage: 'spa' }], // X Special
  [62, { stage: 'spd' }], // X Sp. Def
]);

const FULL_RESTORE = 23;

/** The AI's status condition flags (`usedItemCondition`), ITEM_RECOVER_* in include/constants/items.h:38-48. */
const RECOVER_CONFUSION = 1 << 0;
const RECOVER_FULL = 0x3e; // sleep, poison, burn, freeze, paralysis
/** Each cure's flag, in the order the AI's checks try them (trainer_ai.c:4118-4155). */
const CURE_FLAGS: readonly [StatusId, number][] = [['slp', 1 << 5], ['psn', 1 << 4], ['brn', 1 << 3], ['frz', 1 << 2], ['par', 1 << 1]];

/** The flag the AI sets when `params`' item passes its status check: its first cure in the AI's order, 0 for none. */
function ownStatusFlag(params: BagItemParams): number {
  const cure = CURE_FLAGS.find(([status]) => params.cures?.includes(status));
  return cure ? cure[1] : params.confusion ? RECOVER_CONFUSION : 0;
}

/**
 * The category `item` runs when its own check passes in `TrainerAI_ShouldUseItem`, as that check sets it: Full
 * Restore (trainer_ai.c:4099), HP restore (:4105), the status cures with their flag (:4118-4155), the stat boosters
 * with their stat (:4157-4180), Guard Spec. (:4181-4185). Null for an item that no check passes (Dire Hit), which then
 * runs `BattleSystem_UseBagItem` alone.
 */
function ownEffect(item: number, params: BagItemParams): ItemEffect | null {
  if (item === FULL_RESTORE) return { category: 'fullRestore' };
  if (params.hp !== undefined) return { category: 'recoverHp' };
  const flag = ownStatusFlag(params);
  if (flag !== 0) return { category: 'recoverStatus', statusMask: flag };
  if (params.stage !== undefined) return { category: 'statBooster', stat: params.stage };
  if (params.mist) return { category: 'guardSpec' };
  return null;
}

/** Whether the engine models ROM item `romItem`'s effect as a trainer bag item. */
export function isModelledBagItem(romItem: number): boolean {
  return ITEM_PARAMS.has(romItem);
}

const TRAINER_ITEM_NAMES: ReadonlySet<string> = new Set([...ITEM_PARAMS.keys()].map((item) => BAG_ITEM_NAMES[item]!));

/**
 * Whether `name` is a bag item `runTrainerItem` uses, which its log lines name ("[from] item: Full Restore"). None does
 * anything when held, so a held item's name never is one.
 */
export function isTrainerItemName(name: string): boolean {
  return TRAINER_ITEM_NAMES.has(name);
}

/** A checked item use: the bag slots it empties, the item it applies (a ROM item ID) and the category it runs (null: none). */
export interface TrainerItemUse { slots: number[]; item: number; effect: ItemEffect | null }

/** The trainer's bag in a battle: ROM item IDs in slot order, 0 for a used slot, and the queued use (null for none). */
export interface TrainerBag { items: number[]; pending: { item: number; effect: ItemEffect | null } | null }

const BAG_KEY = 'kaizoTrainerBag';

/** The trainer's bag in `battle`. Throws for a battle `createBattle` did not make. */
export function trainerBag(battle: Battle): TrainerBag {
  const bag = battle.formatData[BAG_KEY] as TrainerBag | undefined;
  if (bag === undefined) throw new Error('This battle has no trainer bag: createBattle gives a battle one');
  return bag;
}

/** Gives `battle` the trainer bag `items` (`RomTrainer.items`), every slot unused. */
export function setTrainerBag(battle: Battle, items: readonly number[]): void {
  battle.formatData[BAG_KEY] = { items: [...items], pending: null } satisfies TrainerBag;
}

/**
 * Whether the trainer may use an item on `pokemon`: not under Embargo (trainer_ai.c:4076), and able to pick a command,
 * which a Pokémon locked into its move (recharging, Outrage, Uproar, a charging or rolling move) cannot
 * (battle_controller_player.c:334-338, `Battler_CanPickCommand` in battle_lib.c:6224-6236).
 */
function canUseItemOn(pokemon: Pokemon): boolean {
  return !pokemon.volatiles['embargo'] && !pokemon.getLockedMove();
}

/** The ids of the distinct modelled items left in the trainer's bag, in slot order, when the trainer may use one on `pokemon`. */
export function usableBagItems(battle: Battle, pokemon: Pokemon): string[] {
  if (!canUseItemOn(pokemon)) return [];
  return [...new Set(trainerBag(battle).items.filter((item) => item !== 0 && ITEM_PARAMS.has(item)).map(bagItemId))];
}

const CATEGORIES: ReadonlySet<string> = new Set(['fullRestore', 'recoverHp', 'recoverStatus', 'statBooster', 'guardSpec', 'undefined']);
const STATS: ReadonlySet<string> = new Set(['atk', 'def', 'spa', 'spd', 'spe', 'accuracy']);

function badEffect(effect: ItemEffect): string | null {
  if (!CATEGORIES.has(effect.category)) return `no category "${effect.category}"`;
  if (effect.stat !== undefined && !STATS.has(effect.stat)) return `no stat "${effect.stat}"`;
  const mask = effect.statusMask;
  if (mask !== undefined && !(Number.isInteger(mask) && mask > 0 && mask < 1 << 6)) return `statusMask ${mask} is not a set of ITEM_RECOVER_* flags`;
  return null;
}

/**
 * Checks a p2 item choice and returns the use it makes. The slots are `consumeSlots`, or else the first slot holding
 * `item`; the effect is `effect`, or `item`'s own (`ownEffect`). A `recoverStatus` effect without a `statusMask` takes
 * `item`'s own flag.
 *
 * Throws `BAD_CHOICE` unless the battle waits on p2's turn choice, the trainer may use an item, every slot holds an
 * item, the highest slot holds `item` (the AI's `usedItem` is the last slot it empties, trainer_ai.c:4191-4194), and
 * `effect` is well formed. Throws `UNMODELLED_ITEM` when `item` is an item the engine does not model, unless the
 * category is `'undefined'`, which applies nothing.
 */
export function checkTrainerItem(battle: Battle, choice: { item: string; consumeSlots?: number[]; effect?: ItemEffect }): TrainerItemUse {
  const pokemon = battle.p2.active[0];
  const request = battle.p2.activeRequest;
  if (battle.requestState !== 'move' || pokemon === undefined || request === null || 'wait' in request) {
    throw new EngineError('BAD_CHOICE', 'The trainer can use an item only at a turn choice');
  }
  if (!canUseItemOn(pokemon)) throw new EngineError('BAD_CHOICE', `The trainer cannot use an item on ${pokemon.name} now`);
  const { items } = trainerBag(battle);
  const slots = choice.consumeSlots ?? [items.findIndex((held) => held !== 0 && bagItemId(held) === choice.item)];
  const valid = slots.length > 0 && new Set(slots).size === slots.length
    && slots.every((slot) => Number.isInteger(slot) && slot >= 0 && slot < items.length && items[slot] !== 0);
  if (!valid) throw new EngineError('BAD_CHOICE', `The bag [${items.join(', ')}] has no ${choice.item} to use in slots [${slots.join(', ')}]`);
  const item = items[Math.max(...slots)]!;
  if (bagItemId(item) !== choice.item) {
    throw new EngineError('BAD_CHOICE', `The highest slot of [${slots.join(', ')}] holds ${bagItemId(item)}, not ${choice.item}`);
  }
  const problem = choice.effect === undefined ? null : badEffect(choice.effect);
  if (problem !== null) throw new EngineError('BAD_CHOICE', `Bad item effect ${JSON.stringify(choice.effect)}: ${problem}`);
  if (choice.effect?.category === 'undefined') return { slots: [...slots], item, effect: { category: 'undefined' } };
  const params = ITEM_PARAMS.get(item);
  if (params === undefined) throw new EngineError('UNMODELLED_ITEM', `The engine does not model the trainer item ${choice.item} (ROM item ${item})`);
  if (choice.effect === undefined) return { slots: [...slots], item, effect: ownEffect(item, params) };
  const effect: ItemEffect = { ...choice.effect };
  if (effect.category === 'recoverStatus' && effect.statusMask === undefined) {
    effect.statusMask = ownStatusFlag(params);
    if (effect.statusMask === 0) throw new EngineError('BAD_CHOICE', `recoverStatus needs a statusMask: ${choice.item} cures no status`);
  }
  return { slots: [...slots], item, effect };
}

/** Empties `use`'s slots (from `checkTrainerItem`) and queues the use as p2's action. */
export function queueTrainerItem(battle: Battle, use: TrainerItemUse): void {
  const bag = trainerBag(battle);
  bag.pending = { item: use.item, effect: use.effect === null ? null : { ...use.effect } };
  for (const slot of use.slots) bag.items[slot] = 0;
  const action = { choice: 'event', event: TRAINER_ITEM_EVENT, pokemon: battle.p2.active[0], order: TRAINER_ITEM_ORDER, priority: 0 };
  (battle.p2.choice.actions as unknown[]).push(action);
}

export const UNDEFINED_CATEGORY_NOTE = 'trainer item: undefined effect category (ITEM_AI_CATEGORY_MAX)';

/**
 * `ItemCommand`'s message number for a status condition (battle_controller_player.c:1922-1931): 6 when the flags hold
 * confusion and a status, else the lowest flag's bit, 32 for none (`LowestBit`, src/pokemon.c:4979-4993).
 */
function statusMessage(mask: number): number {
  if ((mask & RECOVER_CONFUSION) && (mask & RECOVER_FULL)) return 6;
  for (let bit = 0; bit < 32; bit++) if (mask & (1 << bit)) return bit;
  return 32;
}

/**
 * Runs the queued use on the trainer's `pokemon`, as `BattleControllerPlayer_ItemCommand` runs `usedItemType`'s
 * subscript with `usedItem` (battle_controller_player.c:1912-1943):
 * - `'undefined'` (`ITEM_AI_CATEGORY_MAX`) has no `case` there, so the cartridge runs an unset subscript: nothing is
 *   applied or logged, and the battle records `UNDEFINED_CATEGORY_NOTE`;
 * - every other category logs `|-activate|POKEMON|item: NAME|[trainer]` (each subscript's "used one NAME!") and runs
 *   `useBagItem`, which applies all of the item's own parameters, whatever the category;
 * - `fullRestore` first clears status and confusion (subscript_use_full_restore.s:7-8); it and `recoverHp` then heal by
 *   the item's HP recovery (subscript_use_potion.s:12-17), so an Antidote heals nothing;
 * - `recoverStatus` then snaps the Pokémon out of confusion when the message number is 0, and otherwise clears its
 *   status, whatever the item (subscript_use_status_recovery.s:12-26, 53-54);
 * - `statBooster` and `guardSpec` only print (subscript_use_stat_booster.s:13, subscript_use_guard_spec.s:13): the
 *   boost or Mist comes from the item's own parameters, and `stat` names the stat in the message only;
 * - an HP recovery that no potion subscript reads stays stored in the cartridge (`itemHPRecovery`), where a later use
 *   can pick it up: the battle records a note, as the engine does not carry it.
 */
export function runTrainerItem(battle: Battle, pokemon: Pokemon): void {
  const bag = trainerBag(battle);
  const use = bag.pending;
  bag.pending = null;
  if (use === null) throw new Error('No trainer item use is queued');
  const { item, effect } = use;
  if (effect?.category === 'undefined') {
    addUnmodelledNote(battle, UNDEFINED_CATEGORY_NOTE);
    return;
  }
  const params = ITEM_PARAMS.get(item);
  if (params === undefined) throw new Error(`The queued trainer item ${item} is not modelled`);
  if (!pokemon.hp || !pokemon.isActive) return;
  const name = `item: ${BAG_ITEM_NAMES[item]}`;
  battle.add('-activate', pokemon, name, '[trainer]');
  const category = effect?.category;
  if (category === 'fullRestore') {
    pokemon.cureStatus();
    pokemon.removeVolatile('confusion');
  }
  const recovery = useBagItem(battle, pokemon, params, name);
  if (category === 'fullRestore' || category === 'recoverHp') {
    if (recovery > 0 && pokemon.heal(recovery)) battle.add('-heal', pokemon, pokemon.getHealth, `[from] ${name}`);
    return;
  }
  if (category === 'recoverStatus') {
    if (statusMessage(effect!.statusMask!) === 0) pokemon.removeVolatile('confusion');
    else pokemon.cureStatus();
  }
  if (recovery > 0) {
    addUnmodelledNote(battle, `trainer item: ${BAG_ITEM_NAMES[item]}'s HP recovery left stored outside the potion routine (itemHPRecovery)`);
  }
}

/**
 * `BattleSystem_UseBagItem` for the trainer's active Pokémon: applies `params` in its order and returns the HP recovery
 * it stores (0 for none), which only the potion subscript applies.
 */
function useBagItem(battle: Battle, pokemon: Pokemon, params: BagItemParams, name: string): number {
  if (params.cures?.includes(pokemon.status as StatusId)) pokemon.cureStatus();
  if (params.confusion) pokemon.removeVolatile('confusion');
  if (params.mist) pokemon.side.addSideCondition('mist', pokemon);
  if (params.stage) battle.add('-boost', pokemon, params.stage, pokemon.boostBy({ [params.stage]: 1 }), `[from] ${name}`);
  // An explicit source effect: the volatile keeps it, and the default (the event's effect, this format) has no JSON form.
  if (params.focusEnergy) pokemon.addVolatile('focusenergy', pokemon, battle.dex.conditions.get('focusenergy'));
  if (params.hp === undefined || pokemon.hp >= pokemon.maxhp) return 0;
  return params.hp === 'full' ? pokemon.maxhp : params.hp;
}
