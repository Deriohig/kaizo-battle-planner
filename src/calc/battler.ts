// What the cartridge reads off a battler for accuracy and turn order: its ability's name, its held item's hold effect
// (with the hack's numbers), and its status.

import type { BattleMon } from '../battle/types.js';
import { buildNameIndex } from '../names/nameIndex.js';
import type { StartStatus } from '../save/status.js';
import type { CalcSide } from './calc.js';

/** Ability names by Gen 4 ID; the name index's ability lookup needs no docs data. */
const NAMES = buildNameIndex({ species: [], moves: [] });

/** The battler's ability name, as @pkmn/dex names it ("Compound Eyes"). */
export const abilityName = (mon: BattleMon): string => NAMES.ability(mon.ability.value);

/** An ability's name by Gen 4 ID, as @pkmn/dex names it. */
export const abilityNameById = (id: number): string => NAMES.ability(id);

/** An item's name by Gen 4 ID, as @pkmn/dex names it ("Bright Powder"). */
export const itemName = (item: number): string => NAMES.item(item);

/**
 * The hold effects accuracy and turn order read, named after pokeplatinum's `HOLD_EFFECT_*` (generated/
 * item_hold_effects.txt).
 */
export type HoldEffect =
  | 'ACC_REDUCE' | 'ACCURACY_UP' | 'ACCURACY_UP_SLOWER' | 'CHOICE_SPEED' | 'DITTO_SPEED_UP' | 'SOMETIMES_PRIORITY'
  | 'PINCH_PRIORITY' | 'PRIORITY_DOWN' | 'SPEED_HALVING';

/** A held item's hold effect and its parameter (`effectParam`). */
export interface HeldEffect { effect: HoldEffect; param: number }

/**
 * The hack's hold effects and parameters by item ID, read from the hack ROM's item data (itemtool/itemdata/
 * pl_item_data.narc, whose entry is 22 below the item ID, so BrightPowder, item 213, is entry 191; byte 2 the hold
 * effect and byte 3 the parameter) on 2026-11-08. The docs' Items tab matches (its ID Number is the item-data entry, and
 * its "Battle Script" and "Power" columns hold the same two numbers), except that the docs give the six Power items
 * their vanilla `LVLUP_*_EV_UP` (117-122) with power 4. test/real/holdEffects.test.ts checks the table against both.
 * The ROM entries holding any of these effects are exactly the items below. The hack differs from vanilla Platinum in
 * two ways:
 * - BrightPowder and Lax Incense take 11% off accuracy; vanilla's res/items/data/brightpowder.json and
 *   lax_incense.json give 10.
 * - The Power items carry Macho Brace's effect (`EVS_UP_SPEED_DOWN`) instead of their own `LVLUP_*_EV_UP`; both are
 *   in the cartridge's speed-halving list (battle_lib.c:1160-1169), so Speed halves either way.
 */
const HELD_EFFECTS: ReadonlyMap<number, HeldEffect> = new Map<number, HeldEffect>([
  [210, { effect: 'PINCH_PRIORITY', param: 4 }], // Custap Berry
  [213, { effect: 'ACC_REDUCE', param: 11 }], // BrightPowder
  [215, { effect: 'SPEED_HALVING', param: 0 }], // Macho Brace
  [217, { effect: 'SOMETIMES_PRIORITY', param: 20 }], // Quick Claw
  [255, { effect: 'ACC_REDUCE', param: 11 }], // Lax Incense
  [265, { effect: 'ACCURACY_UP', param: 10 }], // Wide Lens
  [274, { effect: 'DITTO_SPEED_UP', param: 0 }], // Quick Powder
  [276, { effect: 'ACCURACY_UP_SLOWER', param: 20 }], // Zoom Lens
  [278, { effect: 'SPEED_HALVING', param: 0 }], // Iron Ball
  [279, { effect: 'PRIORITY_DOWN', param: 0 }], // Lagging Tail
  [287, { effect: 'CHOICE_SPEED', param: 0 }], // Choice Scarf
  [289, { effect: 'SPEED_HALVING', param: 0 }], // Power Bracer
  [290, { effect: 'SPEED_HALVING', param: 0 }], // Power Belt
  [291, { effect: 'SPEED_HALVING', param: 0 }], // Power Lens
  [292, { effect: 'SPEED_HALVING', param: 0 }], // Power Band
  [293, { effect: 'SPEED_HALVING', param: 0 }], // Power Anklet
  [294, { effect: 'SPEED_HALVING', param: 0 }], // Power Weight
  [316, { effect: 'PRIORITY_DOWN', param: 0 }], // Full Incense
]);

/** The hold effect of item `item` itself, whatever cancels it: the speed-halving items work even under Klutz. */
export const itemEffect = (item: number): HeldEffect | null => HELD_EFFECTS.get(item) ?? null;

/**
 * The battler's working hold effect, or null for none: Klutz makes it hold nothing (battle_lib.c `Battler_HeldItem`).
 * Embargo, the other way to lose it, is not battle state the planner tracks.
 */
export const heldEffect = (mon: BattleMon): HeldEffect | null => (abilityName(mon) === 'Klutz' ? null : itemEffect(mon.item));

/** The side's status: its own, else the save's for a player Pokémon, else none (as `CalcSide` describes). */
export function sideStatus(side: CalcSide): StartStatus {
  return side.status ?? ('status' in side.mon ? side.mon.status : { kind: 'none' });
}

/** Whether Cloud Nine or Air Lock is out on either side, which cancels the weather and fog (`NO_CLOUD_NINE`). */
export const weatherSuppressed = (a: BattleMon, b: BattleMon): boolean =>
  [abilityName(a), abilityName(b)].some((name) => name === 'Cloud Nine' || name === 'Air Lock');
