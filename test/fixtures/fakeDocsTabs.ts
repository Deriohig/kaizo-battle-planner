// Small stand-ins for the docs tabs, for the fake fetches: each passes its tab's wrong-tab check and its parser.

import { DOC_TAB_SIGNATURES, type DocTab } from '../../src/docs/fetchDocs.js';

/** The headers of the tabs whose parsers need more columns than the signature shows, from the CSV export on 2026-11-08. */
const HEADERS: Partial<Record<DocTab, string>> = {
  'Personal': 'ID Number,Name,HP,Attack,Defense,Sp. Atk,Sp. Def,Speed,BST,Type 1,Type 2,Catch Rate,Exp Drop,Uncommon Held Item,Rare Held Item,Gender Ratio,Hatch Multiplier,Base Happiness,Growth Rate,Egg Group 1,Egg Group 2,Ability 1,Ability 2,Safari Zone Run Chance,DO NOT TOUCH',
  'Moves': 'ID Number,Name,Additional Effect,Category,Power,Type,Accuracy,PP,Additional Effect Chance (%),Target(s),Priority,Contact Move,Blocked by Protect,Reflected by Magic Coat,Affected by Snatch,Affected by Mirror Move,Triggers Kings Rock,Hide HP Bars,Remove Target\'s Shadow,Contest Effect,Contest Type',
};

/**
 * A CSV for `tab`: its header (or, for the other tabs, its signature), then a row 0 placeholder that names the tab,
 * as wide as the header. The parsers skip row 0, so the table tabs parse to nothing and the split tabs to no trainers.
 */
export function fakeTabCsv(tab: DocTab): string {
  const header = HEADERS[tab] ?? DOC_TAB_SIGNATURES[tab];
  const placeholder = ['0', tab, ...Array<string>(Math.max(0, header.split(',').length - 2)).fill('')];
  return `${header}\r\n${placeholder.join(',')}\r\n`;
}

/** A Personal tab that passes its signature check ("ID Number,Name,HP") but lacks the columns its parser needs. */
export const PERSONAL_WITHOUT_STATS = 'ID Number,Name,HP\r\n1,BULBASAUR,45\r\n';
