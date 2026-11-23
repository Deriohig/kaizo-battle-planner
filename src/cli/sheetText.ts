// How `npm run sheet` writes a move's numbers: KO chances, percentages and the move line.

import type { DamageResult } from '../calc/calc.js';
import type { SheetMoveCell } from '../sheet/sheet.js';

/**
 * A chance as a percentage for the sheet: 100% only for a certain KO, never 0% or 100% for one that is neither, and
 * one decimal place at most. The KO odds are exact (`damage` counts them in integers), so only 1 is certain.
 */
export function percent(chance: number): string {
  if (chance === 1) return '100%';
  return `${Math.min(99.9, Math.max(0.1, Math.round(chance * 1000) / 10))}%`;
}

/**
 * "OHKO 31%, 2HKO 100%": the fewest uses that can KO and their chance, then the fewest that always do, if more. An
 * unbounded move's unknown KO chance (null) reads "KO ?". An OHKO move reads "KO if it hits (40%)",
 * with `hitChance`, the cell's chance that it hits, since its KO chance is conditional on hitting, or
 * "no KO (the OHKO cannot land)" when it cannot affect the target.
 */
export function koText(koChance: DamageResult['koChance'], ohko: boolean, hitChance = 1): string {
  if (koChance === null) return 'KO ?';
  if (ohko) {
    const lands = (koChance[0]?.chance ?? 0) > 0 && hitChance > 0;
    return lands ? `KO if it hits (${percent(hitChance)})` : 'no KO (the OHKO cannot land)';
  }
  const label = (uses: number) => (uses === 1 ? 'OHKO' : `${uses}HKO`);
  const first = koChance.find((entry) => entry.chance > 0);
  if (first === undefined) return `no KO in ${koChance.length}`;
  const sure = koChance.find((entry) => entry.chance === 1);
  const text = `${label(first.hits)} ${percent(first.chance)}`;
  return sure === undefined || sure === first ? text : `${text}, ${label(sure.hits)} 100%`;
}

/**
 * `Ember  22-27 (110-135%)  OHKO 100%  crit 45-53  hit 100%`: the move (with its priority when not 0), one use's
 * damage and percent of the target's max HP, the KO chance in uses, one hit's crit range, the calc's notes, and the
 * hit chance, flagged when below 100%. A status move reads `status` in place of the damage, then its unmodelled flag.
 * An unbounded move (`DamageResult.bounded` false) reads `?  KO ?` with no crit range, as its numbers bound nothing.
 */
export function moveLine(cell: SheetMoveCell): string {
  const { move, result } = cell;
  const parts = [move.priority === 0 ? move.name : `${move.name} ${move.priority > 0 ? '+' : ''}${move.priority}`];
  if (result === null) {
    parts.push(move.category === 'status' ? 'status' : 'no damage');
    if (cell.unmodelled !== null) parts.push(`[unmodelled: ${cell.unmodelled}]`);
  } else if (!result.bounded) {
    parts.push('?', 'KO ?');
    const notes = result.desc.match(/ \[(.*)\]$/)?.[1];
    if (notes !== undefined) parts.push(`[${notes}]`);
  } else {
    parts.push(`${result.min}-${result.max} (${result.percent[0]}-${result.percent[1]}%)`, koText(result.koChance, result.ohko, cell.hitChance));
    const fixed = move.calc.fixedDamage !== undefined || result.ohko;
    if (!fixed) parts.push(`crit ${Math.min(...result.critRolls)}-${Math.max(...result.critRolls)}${move.calc.hits === undefined ? '' : ' per hit'}`);
    const notes = result.desc.match(/ \[(.*)\]$/)?.[1];
    if (notes !== undefined) parts.push(`[${notes}]`);
  }
  parts.push(`hit ${Math.round(cell.hitChance * 100)}%${cell.inaccurate ? ' (inaccurate)' : ''}`);
  return parts.join('  ');
}
