// Downloads the official docs' tabs through the sheet's CSV export.

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { parseLearnsetTab, parseMovesTab, parsePersonalTab } from './tables.js';
import { parseTeamTab } from './teams.js';

const SHEET_ID = '1y95UYKY9HNgZjUlbeZbQ3BWf5IqcFqAkmstC-OSa6vc';

/** The tabs we download, by their names in the sheet. Each is saved as `<dir>/<tab>.csv`, spaces and all. */
export const DOC_TABS = ['Personal', 'Ability Changes', 'Evolutions', 'Level-Up Learnsets', 'Moves', 'Move Changes', 'AI Changes', 'Items', 'Roark Split', 'Gardenia Split', 'Fantina Split', 'Maylene Split', 'Wake Split', 'Byron Split', 'Candice Split', 'Volkner Split', 'Galactic Split', 'Elite Four Split'] as const;

export type DocTab = (typeof DOC_TABS)[number];

/** Each tab's gid, which the export URL needs, read from the sheet's htmlview on 2026-11-08. */
export const DOC_TAB_GIDS: Record<DocTab, string> = {
  'Personal': '2132949512',
  'Ability Changes': '352641164',
  'Evolutions': '1172055843',
  'Level-Up Learnsets': '694053409',
  'Moves': '1144076770',
  'Move Changes': '605673371',
  'AI Changes': '1725998549',
  'Items': '33983143',
  'Roark Split': '904958359',
  'Gardenia Split': '2138894915',
  'Fantina Split': '867079846',
  'Maylene Split': '1727680714',
  'Wake Split': '1434695111',
  'Byron Split': '536140236',
  'Candice Split': '783972457',
  'Volkner Split': '1234723554',
  'Galactic Split': '1656167063',
  'Elite Four Split': '665629702',
};

/**
 * Text each tab shows in its first 5 rows, matched ignoring case against each row's cells joined by commas.
 * It catches a gid that points at the wrong tab. Checked against the real export on 2026-11-08: each signature
 * matches its own tab and no other.
 */
export const DOC_TAB_SIGNATURES: Record<DocTab, string> = {
  'Personal': 'ID Number,Name,HP',
  'Ability Changes': 'Pokémon Name',
  'Evolutions': 'ID Number,Name,Method',
  'Level-Up Learnsets': 'ID Number,Name,Move,Level',
  'Moves': 'ID Number,Name,Additional Effect',
  'Move Changes': 'Move Changes',
  'AI Changes': 'AI CHANGES',
  'Items': 'ID Number,Name,Price',
  'Roark Split': 'ROARK SPLIT',
  'Gardenia Split': 'GARDENIA SPLIT',
  'Fantina Split': 'FANTINA SPLIT',
  'Maylene Split': 'MAYLENE SPLIT',
  'Wake Split': 'WAKE SPLIT',
  'Byron Split': 'BYRON SPLIT',
  'Candice Split': 'CANDICE SPLIT',
  'Volkner Split': 'VOLKNER SPLIT',
  'Galactic Split': 'GALACTIC SPLIT',
  'Elite Four Split': 'ELITE FOUR SPLIT',
};

/** The CSV export URL of one tab. */
export function docTabUrl(tab: DocTab): string {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${DOC_TAB_GIDS[tab]}`;
}

/** The parsers the planner reads tabs with. `downloadDocs` runs each on its tab before saving anything. */
const TAB_PARSERS: Partial<Record<DocTab, (csv: string, tab: DocTab) => unknown>> = {
  'Personal': parsePersonalTab,
  'Moves': parseMovesTab,
  'Level-Up Learnsets': parseLearnsetTab,
  ...Object.fromEntries(DOC_TABS.filter((tab) => tab.endsWith(' Split')).map((tab) => [tab, parseTeamTab])),
};

export type DocsErrorCode = 'NOT_CSV' | 'HTTP' | 'WRONG_TAB' | 'BAD_FORMAT';

/**
 * A docs tab that could not be downloaded as CSV, that came back as some other tab, or that its parser cannot read
 * (`BAD_FORMAT`, whether just downloaded or saved earlier).
 */
export class DocsError extends Error {
  readonly code: DocsErrorCode;
  readonly tab: string;

  constructor(code: DocsErrorCode, tab: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DocsError';
    this.code = code;
    this.tab = tab;
  }
}

/** An unpublished or private sheet answers 200 with a sign-in page instead of CSV. */
const HTML_PAGE = /^\s*<(!doctype html|html)/i;

/** `fetch failed (getaddrinfo ENOTFOUND docs.google.com)`: Node's fetch puts the useful part in `cause`. */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

/** An error's message on one line, for the CLIs: a parser can quote a cell with a line break in it. */
export function oneLineMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, ' ');
}

/** Throws BAD_FORMAT, with the parser's message, if `tab` has a parser and it cannot read `body`. */
function checkParses(tab: DocTab, body: string): void {
  try {
    TAB_PARSERS[tab]?.(body, tab);
  } catch (error) {
    throw new DocsError('BAD_FORMAT', tab, `"${tab}" tab cannot be parsed: ${oneLineMessage(error)}`, { cause: error });
  }
}

/** Throws NOT_CSV if `body` is not CSV, or WRONG_TAB if its first 5 rows lack the tab's signature. */
function checkTab(tab: DocTab, body: string): void {
  if (HTML_PAGE.test(body)) throw new DocsError('NOT_CSV', tab, `"${tab}" tab returned an HTML page instead of CSV`);
  let rows: string[][];
  try {
    rows = parse(body, { to: 5, relax_column_count: true });
  } catch (error) {
    throw new DocsError('NOT_CSV', tab, `"${tab}" tab is not valid CSV: ${describeFailure(error)}`, { cause: error });
  }
  const signature = DOC_TAB_SIGNATURES[tab];
  if (!rows.some((row) => row.join(',').toLowerCase().includes(signature.toLowerCase()))) {
    throw new DocsError('WRONG_TAB', tab, `"${tab}" tab does not show "${signature}" in its first 5 rows`);
  }
}

async function fetchTab(tab: DocTab, fetchFn: typeof fetch): Promise<string> {
  let response: Response;
  let body: string;
  try {
    response = await fetchFn(docTabUrl(tab));
    body = await response.text();
  } catch (error) {
    throw new DocsError('HTTP', tab, `"${tab}" tab could not be fetched: ${describeFailure(error)}`, { cause: error });
  }
  if (!response.ok) throw new DocsError('HTTP', tab, `"${tab}" tab returned HTTP ${response.status}`);
  checkTab(tab, body);
  return body;
}

/**
 * Writes `path` through a temporary file renamed into place, so a failed write never leaves a partial file. The
 * temporary file is named for the process, so two processes writing the same file never share one.
 */
export async function writeWhole(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Downloads every tab in `DOC_TABS` to `<dir>/<tab>.csv` and writes `<dir>/meta.json` as `{ fetchedAt }`.
 * Every tab is fetched and checked (signature, then the parser the planner reads it with, where it has one) before
 * anything is written, so a run that fails on any tab leaves the earlier download as it was.
 */
export async function downloadDocs(dir: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const fetchedAt = new Date().toISOString();
  const tabs: [DocTab, string][] = [];
  for (const tab of DOC_TABS) tabs.push([tab, await fetchTab(tab, fetchFn)]);
  for (const [tab, body] of tabs) checkParses(tab, body);
  const files = tabs.map(([tab, body]): [string, string] => [`${tab}.csv`, body]);
  files.push(['meta.json', `${JSON.stringify({ fetchedAt }, null, 2)}\n`]);
  await mkdir(dir, { recursive: true });
  for (const [name, text] of files) await writeWhole(join(dir, name), text);
}
