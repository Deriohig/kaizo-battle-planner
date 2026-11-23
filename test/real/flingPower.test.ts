// Real-data check: every trainer Pokémon's Fling resolves to its held item's fling power in the hack
// ROM's item data, which is what the cartridge reads (`Battler_ItemFlingPower`, pokeplatinum battle_lib.c:5491-5498:
// byte 6 of the item's entry in itemtool/itemdata/pl_item_data.narc). The item ID map the extract uses
// (`itemDataEntry`, from `Item_FileID`) is checked against the docs' Items tab, whose ID Number is the entry.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { describe, expect, inject, it } from 'vitest';
import { buildCatalog } from '../../src/battle/catalog.js';
import { buildMoves, type KaizoMove } from '../../src/battle/moves.js';
import type { LoadedData } from '../../src/battle/types.js';
import { itemName } from '../../src/calc/battler.js';
import { damage } from '../../src/calc/calc.js';
import { DERI_PROFILES, profileMon } from '../../src/check/pkcalcCalc.js';
import { loadDocs } from '../../src/data/load.js';
import { buildNameIndex } from '../../src/names/nameIndex.js';
import { normaliseName } from '../../src/names/normalise.js';
import { readNarc } from '../../src/nds/narc.js';
import { readNdsFiles } from '../../src/nds/ndsFs.js';
import { extractRomData } from '../../src/rom/extract.js';
import { ITEM_COUNT, itemDataEntry } from '../../src/rom/items.js';
import { needFiles, PK_ROM } from './env.js';

const caches = inject('realCaches');
const suite = needFiles('Fling powers from the ROM\'s item data', { PK_ROM }, [caches.docs]);

/** Each item-data entry's byte 6, read straight from the ROM's NARC. */
function rawFlingPowers(): number[] {
  const narc = readNdsFiles(readFileSync(PK_ROM)).get('itemtool/itemdata/pl_item_data.narc');
  if (narc === undefined) throw new Error('The ROM has no itemtool/itemdata/pl_item_data.narc');
  return readNarc(narc).map((entry) => entry[6]!);
}

describe.skipIf(suite.skip)(suite.title, () => {
  it('the item ID map is the docs\' Items tab\'s: every item @pkmn/dex names has its own name at its entry', () => {
    const rows = parse(readFileSync(join(caches.docs.dir, 'Items.csv'), 'utf8'), { columns: true }) as Record<string, string>[];
    const names = new Map(rows.map((row) => [Number(row['ID Number']), row.Name!]));
    const named = Array.from({ length: ITEM_COUNT - 1 }, (_, i) => i + 1).filter((item) => !/^\(item \d+\)$/.test(itemName(item)));
    // @pkmn/dex calls item 137, Gen 4's first Mail, plain "Mail".
    const nameOf = (item: number) => (item === 137 && itemName(item) === 'Mail' ? 'Grass Mail' : itemName(item));
    const wrong = named.filter((item) => normaliseName(names.get(itemDataEntry(item)) ?? '') !== normaliseName(nameOf(item)))
      .map((item) => [item, itemName(item), itemDataEntry(item), names.get(itemDataEntry(item))]);
    expect(wrong).toEqual([]);
    // Items on both sides of the unused 113-134: Master Ball (1) to Griseous Orb (112), and Adamant Orb (135) onwards.
    expect(named.filter((item) => item <= 112).length).toBeGreaterThan(30);
    expect(named.filter((item) => item >= 135).length).toBeGreaterThan(150);
  });

  it('every trainer Pokémon with Fling flings at its held item\'s ROM power, Nugget at 250 and the Bicycle at 150', () => {
    const rom = extractRomData(readFileSync(PK_ROM));
    const raw = rawFlingPowers();
    expect(rom.items.map((item) => item.flingPower)).toEqual(Array.from({ length: ITEM_COUNT }, (_, item) => raw[itemDataEntry(item)]));
    const docs = loadDocs(caches.docs.dir);
    const data: LoadedData = { rom, names: buildNameIndex(docs), docs };
    const moves = buildMoves(data);
    const flings = new Map([...moves].filter(([, move]) => move.calc.baseMove === 'Fling'));
    expect([...flings.keys()]).toEqual([374]);
    for (const move of flings.values()) expect(move.unmodelled).toBeNull();

    // Every ROM trainer Pokémon that knows Fling, with its item and the power it flings at.
    const users = rom.trainers.flatMap((trainer) => trainer.party.flatMap((mon, slot) => {
      const move = mon.moves.map((id) => flings.get(id)).find((found): found is KaizoMove => found !== undefined);
      return move === undefined ? [] : [{ trainer: trainer.index, slot, species: mon.species, item: mon.item, power: move.calc.flingPower?.[mon.item] }];
    }));
    expect(users.filter((user) => user.power !== raw[itemDataEntry(user.item)])).toEqual([]);
    const pick = (trainer: number) => users.filter((user) => user.trainer === trainer).map(({ slot, species, item, power }) => [slot, species, item, power]);
    expect(pick(335)).toEqual([[0, 6, 92, 250], [1, 275, 92, 250], [2, 326, 92, 250]]); // Rich Boy Trey: Charizard, Shiftry, Grumpig
    expect(pick(383)).toEqual([[2, 57, 92, 250]]); // Clown Bob: Primeape
    expect(pick(166).filter(([, , item]) => item === 450)).toEqual([[1, 419, 450, 150]]); // Dora & Diego: Floatzel

    // The calc flings at that power for every resolved trainer Pokémon with Fling: a plain hit of it, bounded, unflagged.
    const target = { mon: profileMon(DERI_PROFILES[0]!, 50, data) };
    const resolved = buildCatalog(data).trainers.flatMap((trainer) => [trainer, ...trainer.variants]).flatMap((trainer) => trainer.party);
    const flingers = resolved.filter((mon) => mon.moves.some((id) => flings.has(id)));
    expect(flingers.length).toBeGreaterThanOrEqual(5);
    for (const mon of flingers) {
      const move = flings.get(mon.moves.find((id) => flings.has(id))!)!;
      const result = damage({ mon }, target, move, {})!;
      const plain = damage({ mon }, target, { ...move, power: raw[itemDataEntry(mon.item)]!, calc: { baseMove: 'Tackle' } }, {})!;
      expect([mon.name, mon.item, result.unmodelled, result.bounded, result.rolls]).toEqual([mon.name, mon.item, null, true, plain.rolls]);
    }
  });
});
