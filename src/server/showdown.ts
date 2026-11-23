// Showdown import text for one Pokémon: what the sheet's Copy set button puts on the clipboard, to paste into PKCalc
// or Showdown's teambuilder. The sheet and the box (`BoxMonJson.showdown`) both carry it, and the page's team copies
// join these sets.

import type { BattleMon } from '../battle/types.js';
import type { NameIndex } from '../names/nameIndex.js';
import { NATURES } from '../rom/natures.js';
import type { Stats } from '../rom/types.js';

/** Showdown's stat labels, in its order. */
const STAT_LABELS: [keyof Stats, string][] = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];
const MAX_IV = 31;

/** The docs name of move `id`, or "(move <id>)" for one the docs lack, as `buildMoves` names it. */
export function moveName(names: NameIndex, id: number): string {
  try {
    return names.move(id);
  } catch {
    return `(move ${id})`;
  }
}

/** "252 Atk / 4 SpD": the stats whose value `keep` accepts, in HP to Spe order; empty when it accepts none. */
function statList(values: Stats, keep: (value: number) => boolean): string {
  return STAT_LABELS.filter(([key]) => keep(values[key])).map(([key, label]) => `${values[key]} ${label}`).join(' / ');
}

/**
 * The Pokémon as Showdown import text, one line each, in Showdown's export order:
 * - `Nick (Species) (M) @ Item`: the nickname wrapper only for a nickname other than the species name in any case, the gender
 *   only when known, `@ Item` only when it holds one;
 * - `Level: N` and `Ability: X`;
 * - `EVs: …` with the non-zero EVs, left out when all are 0;
 * - `<Nature> Nature`, left out for a null nature;
 * - `IVs: …` with the IVs below 31, left out when all are 31;
 * - `- Move` for each move.
 */
export function showdownSet(mon: BattleMon & { nickname?: string }, names: NameIndex): string {
  // The game's default nickname is the species name in capitals ("BIBAREL"), so case is ignored here.
  const nicknamed = mon.nickname !== undefined && mon.nickname !== '' && mon.nickname.toLowerCase() !== mon.name.toLowerCase();
  let head = nicknamed ? `${mon.nickname} (${mon.name})` : mon.name;
  if (mon.gender !== null) head += ` (${mon.gender})`;
  if (mon.item !== 0) head += ` @ ${names.item(mon.item)}`;
  const lines = [head, `Level: ${mon.level}`, `Ability: ${names.ability(mon.ability.value)}`];
  const evs = statList(mon.evs, (ev) => ev !== 0);
  if (evs !== '') lines.push(`EVs: ${evs}`);
  if (mon.nature.value !== null) lines.push(`${NATURES[mon.nature.value]} Nature`);
  const ivs = statList(mon.ivs, (iv) => iv < MAX_IV);
  if (ivs !== '') lines.push(`IVs: ${ivs}`);
  for (const id of mon.moves) lines.push(`- ${moveName(names, id)}`);
  return lines.join('\n');
}
