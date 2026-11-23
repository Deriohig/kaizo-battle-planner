// Real-data check: the engine's held-item numbers are the hack ROM's item data
// (src/rom/items.ts bytes 2 and 3), and the hack differs from vanilla Platinum in exactly the items listed here. A new
// difference, a vanished one or a changed value fails: the engine's handlers (src/engine/mod/items.ts, procs.ts,
// speedOrder.ts) either read the ROM or are pinned here to agree with it. The docs' Items tab is keyed by item-data
// entry, which for items 113 and up is the item ID less 22.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { describe, expect, inject, it } from 'vitest';
import { loadLocalData } from '../../src/data/load.js';
import { itemId } from '../../src/engine/ids.js';
import { HELD_CHECK_ITEMS, PINCH_ITEMS, type PinchAct, PLATES, TYPE_ITEMS } from '../../src/engine/mod/items.js';
import { readNarc } from '../../src/nds/narc.js';
import { readNdsFiles } from '../../src/nds/ndsFs.js';
import { ITEM_COUNT, itemDataEntry } from '../../src/rom/items.js';
import { DATA_DIR, needFiles, PK_ROM, PK_VANILLA_ROM } from './env.js';

const caches = inject('realCaches');
const suite = needFiles('The engine\'s item numbers against the ROM and the docs', { PK_ROM, PK_VANILLA_ROM }, [caches.docs]);

const entries = (path: string): Uint8Array[] => {
  const data = readNdsFiles(readFileSync(path)).get('itemtool/itemdata/pl_item_data.narc');
  if (data === undefined) throw new Error(`${path} has no item data`);
  return readNarc(data);
};

/** `[item, vanilla effect, vanilla param, hack effect, hack param]` for every item whose hold effect or parameter differs. */
function hackChanges(): number[][] {
  const [hack, vanilla] = [entries(PK_ROM), entries(PK_VANILLA_ROM)];
  const rows: number[][] = [];
  for (let item = 1; item < ITEM_COUNT; item++) {
    if (item >= 113 && item <= 134) continue; // the unused items read entry 0
    const [h, v] = [hack[itemDataEntry(item)]!, vanilla[itemDataEntry(item)]!];
    if (h[2] !== v[2] || h[3] !== v[3]) rows.push([item, v[2]!, v[3]!, h[2]!, h[3]!]);
  }
  return rows;
}

/** The ROM's STRENGTHEN_* hold effects (a line of generated/item_hold_effects.txt less one) and the type each boosts. */
const STRENGTHEN: Readonly<Record<string, number>> = {
  Bug: 57, Steel: 68, Ground: 72, Rock: 73, Grass: 74, Dark: 75, Fighting: 76, Electric: 77, Water: 78, Flying: 79,
  Poison: 80, Ice: 81, Ghost: 82, Psychic: 83, Fire: 84, Dragon: 85, Normal: 86,
};
/** The Plates' ARCEUS_* hold effects, by the type each gives. */
const PLATE_EFFECTS: Readonly<Record<string, number>> = {
  Fire: 126, Water: 127, Electric: 128, Grass: 129, Ice: 130, Fighting: 131, Poison: 132, Ground: 133, Flying: 134,
  Psychic: 135, Bug: 136, Rock: 137, Ghost: 138, Dragon: 139, Dark: 140, Steel: 141,
};

describe.skipIf(suite.skip)(suite.title, () => {
  it('the hack\'s hold effects and parameters differ from vanilla Platinum\'s in exactly these items', () => {
    expect(hackChanges()).toEqual([
      [42, 0, 0, 12, 0], [54, 0, 0, 12, 0], // Lava Cookie, Old Gateau: Lum Berry's effect
      [70, 0, 0, 36, 0], [71, 0, 0, 1, 100], // Shoal Salt (a pinch-Attack item, parameter 0), item 71 (restores 100 HP)
      [202, 37, 4, 37, 0], [205, 40, 4, 40, 0], // Ganlon, Apicot: parameter 0
      [211, 46, 8, 46, 6], [212, 47, 8, 47, 6], // Jaboca, Rowap: max HP / 6
      [213, 48, 10, 48, 11], // BrightPowder: 11
      [221, 56, 10, 56, 11], // King's Rock: 11 (Razor Fang stays 10)
      [255, 48, 10, 48, 11], // Lax Incense: 11
      [282, 110, 3, 110, 7], [283, 111, 3, 111, 7], [284, 112, 3, 112, 7], [285, 113, 3, 113, 7], // the weather rocks: 7
      [289, 117, 4, 50, 0], [290, 118, 4, 50, 0], [291, 119, 4, 50, 0], [292, 120, 4, 50, 0], [293, 121, 4, 50, 0], [294, 122, 4, 50, 0],
      ...Array.from({ length: 16 }, (_, i) => [298 + i, 126 + i, 20, 126 + i, 50]), // the Plates: 50
    ]);
  });

  it('the extracted ROM data (data/rom/romdata.json) has every item\'s hold effect and parameter, the ROM\'s own', () => {
    const rom = entries(PK_ROM);
    const { rom: data } = loadLocalData(DATA_DIR);
    expect(data.items).toHaveLength(ITEM_COUNT);
    for (const item of data.items) {
      const entry = rom[itemDataEntry(item.id)]!;
      expect([item.id, item.holdEffect, item.holdParam]).toEqual([item.id, entry[2], entry[3]]);
    }
  });

  it('every item the engine boosts by type is a ROM STRENGTHEN or Plate item of that type, and every such ROM item is in the engine\'s table', () => {
    const rom = entries(PK_ROM);
    const effect = (id: string): number | undefined => {
      for (let item = 1; item < ITEM_COUNT; item++) if (itemId(item) === id) return rom[itemDataEntry(item)]![2];
      return undefined;
    };
    for (const [id, type] of Object.entries(TYPE_ITEMS)) expect(effect(id), id).toBe(STRENGTHEN[type]);
    for (const [id, type] of PLATES) expect(effect(id), id).toBe(PLATE_EFFECTS[type]);
    const strengthen = new Set(Object.values(STRENGTHEN));
    const plates = new Set(Object.values(PLATE_EFFECTS));
    for (let item = 1; item < ITEM_COUNT; item++) {
      if (item >= 113 && item <= 134) continue;
      const e = rom[itemDataEntry(item)]![2]!;
      if (strengthen.has(e)) expect(Object.keys(TYPE_ITEMS), `${item} ${itemId(item)} (effect ${e})`).toContain(itemId(item));
      if (plates.has(e)) expect([...PLATES.keys()], `${item} ${itemId(item)} (effect ${e})`).toContain(itemId(item));
    }
  });

  it('the docs\' Items tab gives every item the ROM\'s hold effect and parameter, except the Power items\' vanilla ones', () => {
    const rom = entries(PK_ROM);
    const rows = parse(readFileSync(join(caches.docs.dir, 'Items.csv'), 'utf8'), { columns: true }) as Record<string, string>[];
    const differing = rows.flatMap((row) => {
      const entry = Number(row['ID Number']);
      const bytes = rom[entry];
      if (bytes === undefined) return [];
      const [script, power] = [Number(row['Battle Script']), Number(row['Power'])];
      return script === bytes[2] && power === bytes[3] ? [] : [[entry < 113 ? entry : entry + 22, row['Name'], script, power, bytes[2], bytes[3]]];
    });
    // The docs give King's Rock parameter 10 (the ROM has 11, docs/engine-spot-checks.md) and the six Power items (289-294) their
    // vanilla LVLUP_*_EV_UP (117-122) with power 4; the ROM has Macho Brace's 50 and 0.
    expect(differing).toEqual([
      [221, 'King’s Rock', 56, 10, 56, 11],
      [289, 'Power Bracer', 117, 4, 50, 0], [290, 'Power Belt', 118, 4, 50, 0], [291, 'Power Lens', 119, 4, 50, 0],
      [292, 'Power Band', 120, 4, 50, 0], [293, 'Power Anklet', 121, 4, 50, 0], [294, 'Power Weight', 122, 4, 50, 0],
    ]);
  });

  it('the pinch items the engine checks at the cartridge\'s points are exactly the ROM\'s items with a pinch hold effect it acts on', () => {
    // HOLD_EFFECT_PINCH_ATK_UP (36) to _SPDEF_UP (40), _CRITRATE_UP (41), _RANDOM_UP (42), _ACC_UP (44): the cases of
    // BattleSystem_TriggerHeldItem and _OnStatus (bl:4773-4905, :5110-5118, :5196-5293). 45, _PRIORITY (Custap), is the
    // turn order's (speedOrder.ts), in neither.
    const ACTS: Readonly<Record<number, PinchAct>> = { 36: 'atk', 37: 'def', 38: 'spe', 39: 'spa', 40: 'spd', 41: 'crit', 42: 'random', 44: 'accuracy' };
    const rom = entries(PK_ROM);
    const found: [number, string, PinchAct, number][] = [];
    for (let item = 1; item < ITEM_COUNT; item++) {
      if (item >= 113 && item <= 134) continue; // the unused items read entry 0
      const [effect, param] = [rom[itemDataEntry(item)]![2]!, rom[itemDataEntry(item)]![3]!];
      if (ACTS[effect] !== undefined) found.push([item, itemId(item), ACTS[effect]!, param]);
    }
    expect(found).toEqual([
      [70, 'shoalsalt', 'atk', 0], [201, 'liechiberry', 'atk', 4], [202, 'ganlonberry', 'def', 0], [203, 'salacberry', 'spe', 4],
      [204, 'petayaberry', 'spa', 4], [205, 'apicotberry', 'spd', 0], [206, 'lansatberry', 'crit', 4], [207, 'starfberry', 'random', 4],
      [209, 'micleberry', 'accuracy', 4],
    ]);
    expect([...PINCH_ITEMS].map(([id, { act }]) => [id, act])).toEqual(found.map(([, id, act]) => [id, act]));
  });

  it('the rest of the two triggers\' family the engine checks at those points is exactly the ROM\'s items with those hold effects, but White Herb', () => {
    // The other cases of BattleSystem_TriggerHeldItem and _OnStatus (bl:4576-4920, :4967-5305): HP_RESTORE (1), the
    // status cures (5-9), PP_RESTORE (10), CONFUSE_RESTORE (11), STATUS_RESTORE (12), HP_PCT_RESTORE (13), the flavour
    // berries (14-18), STATDOWN_RESTORE (49) and HEAL_INFATUATION (54). White Herb (49) stays on Showdown's own
    // handlers (mod/items.ts `HELD_CHECK_ITEMS`).
    const FAMILY = new Set([1, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 49, 54]);
    const rom = entries(PK_ROM);
    const found: [number, string, number, number][] = [];
    for (let item = 1; item < ITEM_COUNT; item++) {
      if (item >= 113 && item <= 134) continue; // the unused items read entry 0
      const [effect, param] = [rom[itemDataEntry(item)]![2]!, rom[itemDataEntry(item)]![3]!];
      if (FAMILY.has(effect)) found.push([item, itemId(item), effect, param]);
    }
    expect(found).toEqual([
      [42, 'lavacookie', 12, 0], [43, 'berryjuice', 1, 20], [54, 'oldgateau', 12, 0], [71, 'shoalshell', 1, 100],
      [149, 'cheriberry', 5, 0], [150, 'chestoberry', 6, 0], [151, 'pechaberry', 7, 0], [152, 'rawstberry', 8, 0],
      [153, 'aspearberry', 9, 0], [154, 'leppaberry', 10, 10], [155, 'oranberry', 1, 10], [156, 'persimberry', 11, 0],
      [157, 'lumberry', 12, 0], [158, 'sitrusberry', 13, 25], [159, 'figyberry', 14, 8], [160, 'wikiberry', 15, 8],
      [161, 'magoberry', 16, 8], [162, 'aguavberry', 17, 8], [163, 'iapapaberry', 18, 8], [214, 'whiteherb', 49, 0],
      [219, 'mentalherb', 54, 0],
    ]);
    expect([...HELD_CHECK_ITEMS].sort()).toEqual(found.map(([, id]) => id).filter((id) => id !== 'whiteherb').sort());
  });
});
