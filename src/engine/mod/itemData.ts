// The held items' hold effects and parameters, as the installed ROM's item data has them.
//
// The cartridge reads a held item's number from its item-data entry, `Battler_HeldItemPower` (src/battle/battle_lib.c:
// 5373-5390) giving `effectParam` and `Battler_HeldItemEffect` (:5352-5363) the hold effect, both none under Klutz or
// Embargo. The hack changes several of them (Plates 50 where vanilla has 20, King's Rock 11, the weather rocks 7, Jaboca
// and Rowap 6, Ganlon, Apicot and Shoal Salt 0...), so every engine handler that has a number reads it from here, not
// from Showdown's own constants. Without any item data (the engine's unit fixtures, other tests'
// fixtures) the handler's vanilla number stands in; real data (`loadLocalData`) always has it, and `assertItemData`
// refuses a `romdata.json` that predates the fields.
//
// This module is imported by the mod's modules, which dex.ts imports: it uses dex.ts only inside its functions.

import type { LoadedData } from '../../battle/types.js';
import { ITEM_COUNT } from '../../rom/items.js';
import { installedData } from '../dex.js';
import { itemId } from '../ids.js';

/** The hold effect numbers the engine reads (pokeplatinum generated/item_hold_effects.txt, a line number less one). */
export const HOLD_EFFECT = {
  hpRestore: 1, statusRestore: 12, hpPctRestore: 13, pinchAtkUp: 36, pinchDefUp: 37, pinchSpdefUp: 40,
} as const;

/** One item's hold effect and its parameter. */
export interface Held { effect: number; param: number }

/** Why a `LoadedData` is refused: its item records have no hold effect or parameter (an older `npm run extract`). */
export const STALE_ITEM_DATA = 'the ROM data lacks the items\' hold effects and parameters (an older extract wrote it): run npm run extract again';

/** Throws unless every item record of `data` has its hold effect and parameter, or `data` has no item records at all. */
export function assertItemData(data: LoadedData): void {
  if (data.rom.items.some((item) => item.holdEffect === undefined || item.holdParam === undefined)) throw new Error(STALE_ITEM_DATA);
}

/** Showdown item ID → the lowest ROM item number with that ID, per item records array. */
const numbers = new WeakMap<object, Map<string, number>>();

function numberOf(items: object, id: string): number | undefined {
  let map = numbers.get(items);
  if (map === undefined) {
    map = new Map();
    for (let item = ITEM_COUNT - 1; item >= 1; item--) map.set(itemId(item), item);
    numbers.set(items, map);
  }
  return map.get(id);
}

/**
 * The installed ROM's hold effect and parameter of the item with Showdown ID `id`, or null when the installed data has
 * no item records (a fixture without them). Throws for an item the ROM data has no entry for: that would be a
 * handler reading a number the ROM does not hold.
 */
export function heldData(id: string): Held | null {
  const { items } = installedData().rom;
  if (items.length === 0) return null;
  const number = numberOf(items, id);
  const record = number === undefined ? undefined : items[number];
  if (record === undefined || record.holdEffect === undefined || record.holdParam === undefined) {
    throw new Error(`The installed ROM data has no hold effect for item "${id}"`);
  }
  return { effect: record.holdEffect, param: record.holdParam };
}

/** `id`'s parameter (`effectParam`) in the installed ROM; `vanilla` stands in when the installed data has no item records. */
export function heldParam(id: string, vanilla: number): number {
  return heldData(id)?.param ?? vanilla;
}

/**
 * The cartridge's unsigned division `x / y` as pokeplatinum's battle code compiles it (`_u32_div_f`, ARM9 0x020E2178):
 * `cmp r1, #0; bxeq lr` returns the dividend untouched when the divisor is 0, so `x / 0` is `x`. Verified in the hack
 * ROM's overlay 16 for the pinch berries' check (docs/engine-spot-checks.md).
 */
export const divideUnsigned = (x: number, y: number): number => (y === 0 ? x : Math.floor(x / y));
