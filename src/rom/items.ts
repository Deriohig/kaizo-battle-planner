// The hack's item data (itemtool/itemdata/pl_item_data.narc): which entry the cartridge reads for an item, and what the
// planner reads from it. From pret/pokeplatinum at 62bdaacdc (the clone at ~/src/pokeplatinum).

/** Gen 4's item IDs, 0 (none) to 467 (generated/items.txt, whose last entry before `MAX_ITEMS` is the Secret Key). */
export const ITEM_COUNT = 468;

/** The Gen 3 leftovers 113 to 134 (`ITEM_UNUSED_113` to `ITEM_UNUSED_134`), which have no item data. */
const UNUSED_ITEMS = { first: 113, last: 134 } as const;

/** The item data's entries: one per item that has data, item 0's included. */
export const ITEM_DATA_ENTRIES = ITEM_COUNT - (UNUSED_ITEMS.last - UNUSED_ITEMS.first + 1);

/**
 * `sizeof(ItemData)` (include/item.h:56-77, `ALIGN_4`): the stride at which the battle reads the item data. Its
 * entries are 34 bytes (no padding) or 36.
 */
export const ITEM_DATA_STRIDE = 36;

/**
 * The item-data entry the cartridge reads for `item`: `sItemArchiveIDs[item].dataID` (`Item_FileID`, src/item.c:49-57),
 * which tools/dataproc/src/itemproc.c (126-129, 337-354) numbers in item order, giving the unused items 113-134 no
 * entry of their own (they and item 0 read entry 0, `ITEM_NONE`'s). So items 0 to 112 read their own number and items
 * 135 to 467 their number less 22: Nugget, item 92, reads entry 92, and the Bicycle, item 450, entry 428. Throws for an
 * ID past the last item.
 */
export function itemDataEntry(item: number): number {
  if (!Number.isInteger(item) || item < 0 || item >= ITEM_COUNT) throw new Error(`No Gen 4 item ${item}`);
  if (item < UNUSED_ITEMS.first) return item;
  if (item <= UNUSED_ITEMS.last) return 0;
  return item - (UNUSED_ITEMS.last - UNUSED_ITEMS.first + 1);
}

/**
 * One item, by item ID, from its item-data entry (`ItemData`, include/item.h:56-77). `flingPower` is byte 6, which
 * `Battler_ItemFlingPower` reads (src/battle/battle_lib.c:5491-5498) and Fling uses as its power, failing at 0
 * (`BattleSystem_FlingItem`, 5853-5862).
 *
 * `holdEffect` and `holdParam` are bytes 2 and 3 (the `HOLD_EFFECT_*` number, a line of generated/item_hold_effects.txt
 * less one, and `effectParam`), which `Battler_HeldItemEffect` and `Battler_HeldItemPower` read (battle_lib.c:5352-5390):
 * the engine takes every held item's parameter from them. `decodeItem` always sets them;
 * they are optional in the type only so that other tests' fixtures need not carry them; a `romdata.json` that an older extract wrote has another schema version, and the
 * engine refuses such data (`installKaizoDex`) instead of reading vanilla's numbers.
 */
export interface ItemRecord { id: number; flingPower: number; holdEffect?: number; holdParam?: number }

/** Decodes item `id` from its entry's bytes. Throws for an entry too short to hold the fields read. */
export function decodeItem(id: number, entry: Uint8Array): ItemRecord {
  if (entry.length < 8) throw new Error(`Item ${id}'s entry is ${entry.length} bytes, too short for its fling power and hold effect`);
  return { id, flingPower: entry[6]!, holdEffect: entry[2]!, holdParam: entry[3]! };
}
