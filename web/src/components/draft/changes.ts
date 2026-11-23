// What a team row says an entry changes from the save: the names of its edited fields in a fixed order ("Lv 22",
// "HP 1/61", "burned", "item"), and the one line a row shows from them ("Changed: Lv 22, HP 1/61 and burned"). Entries
// are tidied, so every field an entry holds besides its ref is a real change.

import type { BoxMonJson, DraftMonJson } from '../../../../src/server/apiTypes';
import { type Options, shown } from '../../draft';
import { nameList, statusLabel } from '../../labels';

/** The most changes a row names; with more, it names this many and "more". */
const NAMED = 3;

/**
 * What `entry` changes of `mon`, in this order: level, EXP (only when the level is not edited too, as the level sets it),
 * HP, status ("healthy" for none), item, moves, IVs, EVs, nature. The level and HP are as the fight starts them.
 */
export function changesOf(mon: BoxMonJson, options: Options, entry: DraftMonJson): string[] {
  const s = shown(mon, options, entry);
  const changes: string[] = [];
  if (entry.level !== undefined) changes.push(`Lv ${s.level}`);
  else if (entry.exp !== undefined) changes.push('EXP');
  if (entry.hp !== undefined) changes.push(`HP ${s.hp}/${s.maxHp}`);
  if (entry.status !== undefined) changes.push(s.status === 'none' ? 'healthy' : statusLabel(s.status).toLowerCase());
  if (entry.item !== undefined) changes.push('item');
  if (entry.moves !== undefined) changes.push('moves');
  if (entry.ivs !== undefined) changes.push('IVs');
  if (entry.evs !== undefined) changes.push('EVs');
  if (entry.nature !== undefined) changes.push('nature');
  return changes;
}

/** The row's line for `changes`: null for none, all of up to three, else the first three and "more". */
export function changedText(changes: readonly string[]): string | null {
  if (changes.length === 0) return null;
  if (changes.length <= NAMED) return `Changed: ${nameList(changes)}`;
  return `Changed: ${changes.slice(0, NAMED).join(', ')} and more`;
}
