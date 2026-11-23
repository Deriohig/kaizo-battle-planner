// Loads what `npm run extract` saved under `data/`: the decoded ROM, the docs tabs parsed and the name index, plus
// PKCalc's data where the real-data checks saved it.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { loadPkcalc, type PkcalcData } from '../check/pkcalc.js';
import { DOC_TABS, DocsError, type DocTab, oneLineMessage } from '../docs/fetchDocs.js';
import { parseLearnsetTab, parseMovesTab, parsePersonalTab } from '../docs/tables.js';
import { type DocTrainer, parseTeamTab } from '../docs/teams.js';
import type { DocMove, DocSpecies } from '../docs/types.js';
import { RomError } from '../errors.js';
import { buildNameIndex, type NameIndex } from '../names/nameIndex.js';
import { ROM_SCHEMA_VERSION, type RomData } from '../rom/extract.js';

/** The docs tabs the planner reads, parsed. `trainers` holds every split tab's trainers, the tabs in `DOC_TABS` order. */
export interface KaizoDocs {
  species: DocSpecies[];
  moves: DocMove[];
  learnsets: Map<number, { move: string; level: number }[]>;
  trainers: DocTrainer[];
  /** The AI Changes tab's text: its non-empty cells (in practice one) joined by newlines, CSV quoting undone. */
  aiChangesText: string;
}

/**
 * What `loadLocalData` reads. `pkcalc` is PKCalc's data (`loadPkcalc`), present only where its files were saved (by
 * `npm run test:real` or `npm run record:diffs`); the trainer catalog takes PKCalc's natures from it.
 */
export interface LocalData { rom: RomData; names: NameIndex; docs: KaizoDocs; pkcalc?: PkcalcData }

/**
 * Where the docs' natures take their alternatives from with this data: `'pkcalc'` when PKCalc's data
 * was loaded (a docs nature lists PKCalc's nature where it differs), `'all'` when it was not (a docs nature lists all
 * 24 other natures). The sheet's header says which (`npm run sheet`).
 */
export type NatureAlternatives = 'pkcalc' | 'all';

/** The `NatureAlternatives` mode `data` gives the trainer catalog (`buildCatalog`). */
export const natureAlternatives = (data: Pick<LocalData, 'pkcalc'>): NatureAlternatives => (data.pkcalc === undefined ? 'all' : 'pkcalc');

/** A file `loadLocalData` needs is missing, so `npm run extract` has not been run in this directory. */
export class MissingDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingDataError';
  }
}

const SPLIT_TABS = DOC_TABS.filter((tab) => tab.endsWith(' Split'));
const NEEDED_TABS: DocTab[] = ['Personal', 'Moves', 'Level-Up Learnsets', 'AI Changes', ...SPLIT_TABS];

/** Every non-empty cell of a CSV, in reading order, joined by newlines. */
function cellText(csv: string): string {
  const rows: string[][] = parse(csv, { relax_column_count: true });
  return rows.flat().filter((cell) => cell.trim() !== '').join('\n');
}

const tabFile = (docsDir: string, tab: DocTab) => join(docsDir, `${tab}.csv`);

/** Throws `MissingDataError` naming each of `files` that does not exist. */
function requireFiles(files: string[]): void {
  const missing = files.filter((file) => !existsSync(file));
  if (missing.length > 0) throw new MissingDataError(`Missing ${missing.join(', ')}`);
}

/**
 * Reads and parses the docs tabs saved in `docsDir`. Throws `MissingDataError`, naming every missing tab, before reading
 * any; a tab that cannot be read or parsed throws `DocsError` BAD_FORMAT, with a one-line message naming the tab.
 */
export function loadDocs(docsDir: string): KaizoDocs {
  requireFiles(NEEDED_TABS.map((name) => tabFile(docsDir, name)));
  const read = <T>(name: DocTab, parse: (csv: string) => T): T => {
    try {
      return parse(readFileSync(tabFile(docsDir, name), 'utf8'));
    } catch (error) {
      const message = `docs cache unreadable: ${name}: ${oneLineMessage(error)}; run npm run extract -- --rom <path> to download it again`;
      throw new DocsError('BAD_FORMAT', name, message, { cause: error });
    }
  };
  return {
    species: read('Personal', parsePersonalTab),
    moves: read('Moves', parseMovesTab),
    learnsets: read('Level-Up Learnsets', parseLearnsetTab),
    trainers: SPLIT_TABS.flatMap((split) => read(split, (csv) => parseTeamTab(csv, split))),
    aiChangesText: read('AI Changes', cellText),
  };
}

/**
 * PKCalc's data saved in `pkcalcDir` (`loadPkcalc`, which parses its files and never runs them), or undefined where
 * none was saved there (no `meta.json`, which `downloadPkcalc` writes last). Data that cannot be read throws an error
 * with a one-line message naming the file.
 */
function loadSavedPkcalc(pkcalcDir: string): PkcalcData | undefined {
  if (!existsSync(join(pkcalcDir, 'meta.json'))) return undefined;
  try {
    return loadPkcalc(pkcalcDir);
  } catch (error) {
    throw new Error(`PKCalc data unreadable: ${oneLineMessage(error)}; delete ${pkcalcDir} or save it again with npm run record:diffs`, { cause: error });
  }
}

/** EXP_RATE_COUNT (pokeplatinum generated/exp_rates.txt:9): the growth tables of pl_growtbl.narc. */
const GROWTH_TABLES = 8;
/** Each growth table's entries, levels 0 to 100 (pokeplatinum src/pokemon.c:2343, `MAX_POKEMON_LEVEL + 1`). */
const GROWTH_LEVELS = 101;

/** Whether `growth` is all of pl_growtbl.narc's tables: `GROWTH_TABLES` lists of `GROWTH_LEVELS` whole numbers. */
function isGrowthTables(growth: unknown): boolean {
  return Array.isArray(growth) && growth.length === GROWTH_TABLES
    && growth.every((table) => Array.isArray(table) && table.length === GROWTH_LEVELS && table.every(Number.isInteger));
}

/**
 * Reads `<dir>/rom/romdata.json`, the docs tabs in `<dir>/docs/`, and PKCalc's data in `<dir>/pkcalc/` where it was
 * saved (`loadSavedPkcalc`). Throws `MissingDataError`, naming every missing ROM or docs file, before reading anything.
 * A docs tab that cannot be parsed throws as in `loadDocs`. A `romdata.json` that is not JSON, or lacks `schemaVersion`
 * `ROM_SCHEMA_VERSION` (an older extract wrote it), throws `RomError` BAD_FORMAT, with a one-line message saying to run
 * the extract again; so does one without all eight growth tables (`isGrowthTables`). The engine stands in the vanilla
 * tables only for data that has none at all (src/engine/dex.ts `growthTable`, a fixture's case), so real data must
 * never reach it with them missing.
 */
export function loadLocalData(dir = 'data'): LocalData {
  const romFile = join(dir, 'rom', 'romdata.json');
  const docsDir = join(dir, 'docs');
  const extractAgain = 'run npm run extract -- --rom <path> to extract it again';
  requireFiles([romFile, ...NEEDED_TABS.map((name) => tabFile(docsDir, name))]);
  const docs = loadDocs(docsDir);
  let rom: unknown;
  try {
    rom = JSON.parse(readFileSync(romFile, 'utf8'));
  } catch (error) {
    throw new RomError('BAD_FORMAT', `ROM data unreadable: ${romFile}: ${oneLineMessage(error)}; ${extractAgain}`);
  }
  const version = (rom as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version !== ROM_SCHEMA_VERSION) {
    const found = version === undefined ? 'no schema version' : `schema version ${JSON.stringify(version)}`;
    throw new RomError('BAD_FORMAT', `ROM data out of date: ${romFile} has ${found}, but the planner reads version ${ROM_SCHEMA_VERSION}; ${extractAgain}`);
  }
  if (!isGrowthTables((rom as { growth?: unknown }).growth)) {
    throw new RomError('BAD_FORMAT', `ROM data incomplete: ${romFile} lacks the ${GROWTH_TABLES} growth tables of ${GROWTH_LEVELS} levels (pl_growtbl.narc); ${extractAgain}`);
  }
  const pkcalc = loadSavedPkcalc(join(dir, 'pkcalc'));
  return { rom: rom as RomData, names: buildNameIndex(docs), docs, ...(pkcalc !== undefined && { pkcalc }) };
}
