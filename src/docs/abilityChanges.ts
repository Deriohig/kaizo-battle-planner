// Parser for the docs' Ability Changes tab, as saved by `downloadDocs` (the save reader doesn't parse
// it, so the engine does, in a file of its own).
//
// The tab is not a list of changes to what an ability does: it is one row per Personal row with its two abilities
// ("Pokémon Name,Ability 1,Ability 2"), in the hack's assignment. The ROM's Personal data holds the same assignment, which
// is what the engine reads (test/real/engineVsCalcAbilities.test.ts checks the tab against it).

import { parse } from 'csv-parse/sync';

/** One row of the Ability Changes tab: a species or form named as the tab names it, and its two abilities. */
export interface DocAbilityRow { name: string; abilities: [string, string] }

/** Every row of the Ability Changes tab. Blank lines and rows of empty cells are skipped; a missing column throws. */
export function parseAbilityChangesTab(csv: string): DocAbilityRow[] {
  const [header = [], ...rows] = parse(csv, { skip_empty_lines: true, skip_records_with_empty_values: true }) as string[][];
  const columns = ['Pokémon Name', 'Ability 1', 'Ability 2'].map((name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`The Ability Changes tab has no "${name}" column`);
    return i;
  });
  return rows.map((row) => ({ name: row[columns[0]!] ?? '', abilities: [row[columns[1]!] ?? '', row[columns[2]!] ?? ''] as [string, string] }));
}
