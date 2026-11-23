// Real-data check: the calc's hard-coded hold-effect table (`itemEffect`, src/calc/battler.ts) against the docs' Items
// tab and the hack ROM's item data, so the table cannot drift from either. The docs' "Battle Script" and "Power"
// columns, like the item data's bytes 2 and 3, are an item's hold effect and its parameter; the docs' "ID Number" is the
// item data's entry (itemtool/itemdata/pl_item_data.narc), which for these items is the item ID less 22, as Gen 4's
// unused items 113–134 have no entry.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { describe, expect, inject, it } from 'vitest';
import { type HeldEffect, type HoldEffect, itemEffect, itemName } from '../../src/calc/battler.js';
import { normaliseName } from '../../src/names/normalise.js';
import { readNarc } from '../../src/nds/narc.js';
import { readNdsFiles } from '../../src/nds/ndsFs.js';
import { needFiles, PK_ROM } from './env.js';

const caches = inject('realCaches');
const suite = needFiles('Hold effects against the docs and the ROM', { PK_ROM }, [caches.docs]);

/**
 * The table's effect for each of pokeplatinum's `HOLD_EFFECT_*` numbers it models (generated/item_hold_effects.txt,
 * from 0). Macho Brace's EVS_UP_SPEED_DOWN, Iron Ball's SPEED_DOWN_GROUNDED and the Power items' LVLUP_*_EV_UP are all
 * in the cartridge's speed-halving list (battle_lib.c:1160-1169), which the table calls SPEED_HALVING.
 */
const MODELLED: ReadonlyMap<number, HoldEffect> = new Map<number, HoldEffect>([
  [45, 'PINCH_PRIORITY'], [48, 'ACC_REDUCE'], [50, 'SPEED_HALVING'], [52, 'SOMETIMES_PRIORITY'], [93, 'ACCURACY_UP'],
  [102, 'DITTO_SPEED_UP'], [104, 'ACCURACY_UP_SLOWER'], [106, 'SPEED_HALVING'], [107, 'PRIORITY_DOWN'], [115, 'CHOICE_SPEED'],
  [117, 'SPEED_HALVING'], [118, 'SPEED_HALVING'], [119, 'SPEED_HALVING'], [120, 'SPEED_HALVING'], [121, 'SPEED_HALVING'],
  [122, 'SPEED_HALVING'],
]);

/** The docs' and item data's entry for an item is its ID less this. */
const ENTRY_OFFSET = 22;

/** Gen 4's item IDs run to 467; the scan goes further, so that a stray table key shows. */
const ITEM_IDS = Array.from({ length: 1000 }, (_, id) => id);

/** Every item the table gives a hold effect, with it, by item ID. */
const table = () => ITEM_IDS.flatMap((item) => {
  const effect = itemEffect(item);
  return effect === null ? [] : [[item, effect] as [number, HeldEffect]];
});

/**
 * The Power items (Power Bracer to Power Weight): the docs give them their vanilla LVLUP_*_EV_UP (117–122) with power 4,
 * but the hack's item data gives them Macho Brace's EVS_UP_SPEED_DOWN (50) with parameter 0, which the table holds.
 * Both halve Speed. Checked against the ROM on 2026-11-08.
 */
const POWER_ITEMS: ReadonlyMap<number, number> = new Map([[289, 117], [290, 118], [291, 119], [292, 120], [293, 121], [294, 122]]);

describe.skipIf(suite.skip)(suite.title, () => {
  it('the table holds exactly the docs\' items with a modelled hold effect, each under its entry plus 22, with the docs\' effect and power', () => {
    const rows = parse(readFileSync(join(caches.docs.dir, 'Items.csv'), 'utf8'), { columns: true }) as Record<string, string>[];
    const docs = rows.flatMap((row) => {
      const script = Number(row['Battle Script']);
      const effect = MODELLED.get(script);
      if (effect === undefined) return [];
      return [{ item: Number(row['ID Number']) + ENTRY_OFFSET, name: row.Name!, script, held: { effect, param: Number(row.Power) } }];
    });
    // The offset holds: the docs' name of each entry is the item's name.
    expect(docs.filter(({ item, name }) => normaliseName(itemName(item)) !== normaliseName(name)).map(({ item, name }) => [item, name, itemName(item)])).toEqual([]);
    // The docs' only difference from the ROM: the Power items' vanilla effect and power.
    expect(docs.filter(({ item }) => POWER_ITEMS.has(item)).map(({ item, script, held }) => [item, script, held.param]))
      .toEqual([...POWER_ITEMS].map(([item, script]) => [item, script, 4]));
    const expected = docs.map(({ item, held }): [number, HeldEffect] => [item, POWER_ITEMS.has(item) ? { ...held, param: 0 } : held]);
    expect(table()).toEqual(expected);
  });

  it('the table holds exactly the ROM item data\'s items with a modelled hold effect, with its effect and parameter', () => {
    const files = readNdsFiles(readFileSync(PK_ROM));
    const data = files.get('itemtool/itemdata/pl_item_data.narc');
    if (data === undefined) throw new Error('The ROM has no itemtool/itemdata/pl_item_data.narc');
    const entries = readNarc(data);
    const rom = entries.flatMap((entry, index): [number, HeldEffect][] => {
      const effect = MODELLED.get(entry[2]!);
      return effect === undefined ? [] : [[index + ENTRY_OFFSET, { effect, param: entry[3]! }]];
    });
    // The Power items carry Macho Brace's EVS_UP_SPEED_DOWN (50) with parameter 0.
    expect([...POWER_ITEMS.keys()].map((item) => [item, entries[item - ENTRY_OFFSET]?.[2], entries[item - ENTRY_OFFSET]?.[3]]))
      .toEqual([...POWER_ITEMS.keys()].map((item) => [item, 50, 0]));
    expect(table()).toEqual(rom);
  });
});
