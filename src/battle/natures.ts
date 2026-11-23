// Trainer Pokémon natures: how the docs' nature cells read, and which nature the planner uses.

import { normaliseName } from '../names/normalise.js';
import { NATURES } from '../rom/natures.js';
import type { TrainerMon } from '../rom/trainers.js';
import type { Sourced } from './types.js';

/**
 * The nature a docs cell gives a trainer of a female or male class, as the cross-checks against the ROM read it. The
 * docs write a rival's nature as "Careful/Bold", in the order of the trainer name "Dawn/Lucas": first the female (Dawn)
 * copy's, then the male (Lucas) copy's. Any other cell is returned as it is.
 */
export function docsNature(cell: string, femaleClass: boolean): string {
  const [first, second] = cell.split('/');
  return second === undefined ? cell : femaleClass ? first! : second;
}

const NATURE_IDS = new Map(NATURES.map((name, id) => [normaliseName(name), id]));

/**
 * The nature ID a docs nature cell gives the planner: trailing digits are stripped ("Lonely0" is Lonely),
 * and a cell holding "/" ("X/Y") or a word that is no nature ("Mantine") gives null. Names compare as `normaliseName`.
 */
export function cleanDocsNature(cell: string): number | null {
  const text = cell.trim().replace(/\d+$/, '');
  if (text.includes('/')) return null;
  return NATURE_IDS.get(normaliseName(text)) ?? null;
}

/**
 * The nature the planner uses for a trainer Pokémon: the ROM's plain-rule nature where it is known
 * (`natureKnown`), otherwise the docs cell's, cleaned by `cleanDocsNature`. Its alternatives:
 * - A known ROM nature is disputed where the docs give another, which is its alternative.
 * - A docs nature is always disputed, until spot check 1 settles the docs' natures. `pkcalcNature`,
 *   PKCalc's nature for the Pokémon, is its alternative where it differs. Where PKCalc gives none (null: PKCalc's
 *   data was not saved, or has no set for the Pokémon), nothing contradicts the docs, so every other nature, 24 of
 *   them, is an alternative: the worlds a proof covers never shrink with the data at hand.
 * - Where the docs give none either, the calc must assume a neutral one, and any of the 25 natures is an alternative.
 */
export function resolveNature(mon: Pick<TrainerMon, 'nature' | 'natureKnown'>, docsCell: string | null, pkcalcNature: number | null = null): Sourced<number | null> {
  const docs = docsCell === null ? null : cleanDocsNature(docsCell);
  if (mon.natureKnown) {
    const alternatives = docs !== null && docs !== mon.nature ? [docs] : [];
    return { value: mon.nature, source: 'rom', disputed: alternatives.length > 0, alternatives };
  }
  const all = NATURES.map((_, id) => id);
  if (docs === null) return { value: null, source: 'docs', disputed: true, alternatives: all };
  const alternatives = pkcalcNature === null ? all.filter((id) => id !== docs) : pkcalcNature !== docs ? [pkcalcNature] : [];
  return { value: docs, source: 'docs', disputed: true, alternatives };
}
