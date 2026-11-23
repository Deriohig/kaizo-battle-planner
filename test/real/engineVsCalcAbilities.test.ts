// Real-data check: the docs' Ability Changes tab (one row per species with its two abilities,
// src/docs/abilityChanges.ts) against the ROM's Personal data, which the engine reads. Every difference is listed, so a new
// one, a vanished one or a changed value fails; the differences are the docs' errors or the ROM's, not engine changes.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { loadLocalData } from '../../src/data/load.js';
import { parseAbilityChangesTab } from '../../src/docs/abilityChanges.js';
import { DATA_DIR, needFiles, PK_ROM } from './env.js';

const caches = inject('realCaches');
const suite = needFiles('The Ability Changes tab against the ROM', { PK_ROM }, [caches.docs]);

describe.skipIf(suite.skip)(suite.title, () => {
  it('every row names a species or form of the ROM, and its abilities are the ROM\'s apart from the listed differences', () => {
    const rows = parseAbilityChangesTab(readFileSync(join(caches.docs.dir, 'Ability Changes.csv'), 'utf8'));
    const data = loadLocalData(DATA_DIR);
    const unknown: string[] = [];
    const differences: string[][] = [];
    for (const row of rows) {
      const found = data.names.speciesId(row.name);
      if (found === null) {
        unknown.push(row.name);
        continue;
      }
      const record = data.rom.species[found.id]!;
      // The tab writes a missing ability "-" (ability 0) and spells some names its own way ("Lightningrod"), so compare IDs.
      const doc = row.abilities.map((ability) => (ability === '-' ? 0 : data.names.abilityId(ability) ?? -1));
      if (doc[0] !== record.abilities[0] || doc[1] !== record.abilities[1]) {
        differences.push([row.name, ...row.abilities, '|', ...record.abilities.map((ability) => (ability === 0 ? '-' : data.names.ability(ability)))]);
      }
    }
    expect(rows.length).toBeGreaterThan(300);
    expect({ unknown, differences }).toMatchInlineSnapshot(`
      {
        "differences": [
          [
            "SANDSHREW",
            "Hyper Cutter",
            "Rough Skin",
            "|",
            "Rough Skin",
            "Rough Skin",
          ],
          [
            "SANDSLASH",
            "Hyper Cutter",
            "Rough Skin",
            "|",
            "Rough Skin",
            "Rough Skin",
          ],
          [
            "GOLEM",
            "Shed Skin",
            "Shell Armor",
            "|",
            "Shell Armor",
            "Shell Armor",
          ],
          [
            "FARFETCH’D",
            "Scrappy",
            "Super Luck",
            "|",
            "Super Luck",
            "Scrappy",
          ],
          [
            "DEWGONG",
            "Swift Swim",
            "Swift Swim",
            "|",
            "Swift Swim",
            "Ice Body",
          ],
          [
            "SCYTHER",
            "Hyper Cutter",
            "Hyper Cutter",
            "|",
            "Technician",
            "Technician",
          ],
          [
            "QUAGSIRE",
            "Simple",
            "Simple",
            "|",
            "Simple",
            "Poison Point",
          ],
          [
            "SLOWKING",
            "Simple",
            "Simple",
            "|",
            "Simple",
            "Magic Guard",
          ],
          [
            "ARMALDO",
            "Swift Swim",
            "Hyper Cutter",
            "|",
            "Swift Swim",
            "Battle Armor",
          ],
          [
            "TROPIUS",
            "Overgrow",
            "Overgrow",
            "|",
            "Chlorophyll",
            "Overgrow",
          ],
          [
            "TANGROWTH",
            "Magic Guard",
            "Unaware",
            "|",
            "Magic Guard",
            "Magic Guard",
          ],
          [
            "GALLADE",
            "Hyper Cutter",
            "Hyper Cutter",
            "|",
            "Hyper Cutter",
            "Steadfast",
          ],
        ],
        "unknown": [],
      }
    `);
  });
});
