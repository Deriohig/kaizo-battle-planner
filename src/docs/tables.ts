// Parsers for the docs' Moves, Personal and Level-Up Learnsets tabs, as saved by `downloadDocs`.

import { parse } from 'csv-parse/sync';
import type { MoveCategory } from '../rom/types.js';
import type { DocMove, DocSpecies } from './types.js';

const CATEGORIES: Record<string, MoveCategory> = { Physical: 'physical', Special: 'special', Status: 'status' };

/**
 * Reads a tab's CSV. Each of `names` is looked up in the header, so a moved column still parses and a renamed one
 * fails loudly; `cell(row, key)` then reads that column. Blank lines and rows of empty cells (the export keeps the
 * sheet's empty rows) are skipped, and so is row 0, a placeholder ("-" or "-----") in every tab.
 */
function readTab<K extends string>(csv: string, tab: string, names: Record<K, string>) {
  const [header = [], ...rows] = parse(csv, { skip_empty_lines: true, skip_records_with_empty_values: true });
  const index = {} as Record<K | 'id', number>;
  for (const [key, name] of Object.entries<string>({ ...names, id: 'ID Number' })) {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`The ${tab} tab has no "${name}" column`);
    index[key as K | 'id'] = i;
  }
  const cell = (row: string[], key: K | 'id') => row[index[key]] ?? '';
  return { header, rows: rows.filter((row) => cell(row, 'id') !== '0'), cell };
}

/**
 * A whole number, or NaN for anything else. The docs write a changed stat with its change from vanilla, such as
 * `92 (+10)` or `60 (-18)`; that reads as the new value, 92 or 60.
 */
function int(cell: string | undefined): number {
  const match = cell?.match(/^(-?\d+)(?: \([+-]\d+\))?$/);
  return match ? Number(match[1]) : NaN;
}

/** Every move in the Moves tab. The category becomes lower case; an unknown one throws, naming the move. */
export function parseMovesTab(csv: string): DocMove[] {
  const { rows, cell } = readTab(csv, 'Moves', {
    name: 'Name', effectText: 'Additional Effect', category: 'Category', power: 'Power', type: 'Type', accuracy: 'Accuracy',
    pp: 'PP', effectChance: 'Additional Effect Chance (%)', targets: 'Target(s)', priority: 'Priority', contact: 'Contact Move',
  });
  return rows.map((row) => {
    const name = cell(row, 'name');
    const category = CATEGORIES[cell(row, 'category')];
    if (category === undefined) throw new Error(`The Moves tab gives ${name} the unknown category "${cell(row, 'category')}"`);
    return {
      id: int(cell(row, 'id')), name, effectText: cell(row, 'effectText'), category, power: int(cell(row, 'power')),
      type: cell(row, 'type'), accuracy: int(cell(row, 'accuracy')), pp: int(cell(row, 'pp')),
      effectChance: int(cell(row, 'effectChance')), targets: cell(row, 'targets'), priority: int(cell(row, 'priority')),
      contact: cell(row, 'contact') === 'TRUE',
    };
  });
}

/** The docs list stats as HP, Atk, Def, SpA, SpD, Spe; columns are found by name, so the order does not matter here. */
export function parsePersonalTab(csv: string): DocSpecies[] {
  const { rows, cell } = readTab(csv, 'Personal', {
    name: 'Name', hp: 'HP', atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed',
    type1: 'Type 1', type2: 'Type 2', growthRate: 'Growth Rate', ability1: 'Ability 1', ability2: 'Ability 2',
  });
  return rows.map((row) => ({
    id: int(cell(row, 'id')),
    name: cell(row, 'name'),
    baseStats: {
      hp: int(cell(row, 'hp')), atk: int(cell(row, 'atk')), def: int(cell(row, 'def')),
      spa: int(cell(row, 'spa')), spd: int(cell(row, 'spd')), spe: int(cell(row, 'spe')),
    },
    types: [cell(row, 'type1'), cell(row, 'type2')],
    growthRate: cell(row, 'growthRate'),
    abilities: [cell(row, 'ability1'), cell(row, 'ability2')],
  }));
}

/** Each species' level-up moves by ID, in docs order. The tab repeats "Move","Level" column pairs; blank pairs are skipped. */
export function parseLearnsetTab(csv: string): Map<number, { move: string; level: number }[]> {
  const { header, rows, cell } = readTab(csv, 'Level-Up Learnsets', {});
  const pairs = header.flatMap((name, i) => (name === 'Move' && header[i + 1] === 'Level' ? [i] : []));
  if (pairs.length === 0) throw new Error('The Level-Up Learnsets tab has no "Move","Level" columns');
  return new Map(rows.map((row) => [
    int(cell(row, 'id')),
    pairs.filter((i) => row[i]).map((i) => ({ move: row[i]!, level: int(row[i + 1]) })),
  ]));
}
