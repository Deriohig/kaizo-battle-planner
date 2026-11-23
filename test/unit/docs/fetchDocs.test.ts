import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOC_TAB_GIDS, DOC_TABS, DocsError, type DocTab, docTabUrl, downloadDocs, writeWhole } from '../../../src/docs/fetchDocs.js';
import { fakeTabCsv as tabCsv, PERSONAL_WITHOUT_STATS } from '../../fixtures/fakeDocsTabs.js';

const TAB_BY_GID = new Map(DOC_TABS.map((tab) => [DOC_TAB_GIDS[tab], tab]));

/** A fake fetch that answers `tab` (found by gid) with `bad()` and every other tab with its valid CSV, recording the URLs. */
function failOn(tab?: DocTab, bad?: () => Response) {
  const urls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    urls.push(String(input));
    const asked = TAB_BY_GID.get(new URL(String(input)).searchParams.get('gid') ?? '');
    if (asked === undefined) throw new Error(`No tab has the URL ${String(input)}`);
    return asked === tab ? bad!() : new Response(tabCsv(asked));
  };
  return Object.assign(fetchFn, { urls });
}

/** The error that `downloadDocs` rejects with, which must be a DocsError. */
async function docsError(dir: string, fetchFn: typeof fetch): Promise<DocsError> {
  const error = await downloadDocs(dir, fetchFn).then(() => 'no error', (e: unknown) => e);
  expect(error).toBeInstanceOf(DocsError);
  return error as DocsError;
}

// The real Moves header and a row, from the CSV export.
const MOVES_CSV = `ID Number,Name,Additional Effect,Category,Power,Type,Accuracy,PP,Additional Effect Chance (%),Target(s),Priority,Contact Move,Blocked by Protect,Reflected by Magic Coat,Affected by Snatch,Affected by Mirror Move,Triggers Kings Rock,Hide HP Bars,Remove Target's Shadow,Contest Effect,Contest Type\r
4,Water Ball,None,Special,100,Water,100,15,0,One opponent,0,FALSE,TRUE,FALSE,FALSE,TRUE,TRUE,TRUE,FALSE,7,4`;
const BAD_ROARK = readFileSync(new URL('../../fixtures/roarkSplitExcerpt.csv', import.meta.url), 'utf8').replace(/Lv 5 Zigzagoon ♂/, 'Level five Zigzagoon');
const HTML = '"Moves" tab returned an HTML page instead of CSV';

let root: string;
let dir: string;
const listing = () => (existsSync(dir) ? readdirSync(dir).sort() : []);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pk-docs-'));
  dir = join(root, 'data', 'docs');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('downloadDocs', () => {
  it('fetches each tab by its gid and writes it to <tab>.csv plus meta.json, creating the directory', async () => {
    const fetchFn = failOn();
    const before = Date.now();
    await downloadDocs(dir, fetchFn);
    expect(listing()).toEqual([...DOC_TABS.map((tab) => `${tab}.csv`), 'meta.json'].sort());
    expect(fetchFn.urls).toEqual(DOC_TABS.map(docTabUrl));
    expect(docTabUrl('Level-Up Learnsets')).toBe('https://docs.google.com/spreadsheets/d/1y95UYKY9HNgZjUlbeZbQ3BWf5IqcFqAkmstC-OSa6vc/export?format=csv&gid=694053409');
    expect(readFileSync(join(dir, 'Level-Up Learnsets.csv'), 'utf8')).toBe('ID Number,Name,Move,Level\r\n0,Level-Up Learnsets,,\r\n');
    const { fetchedAt } = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    expect(new Date(fetchedAt).toISOString()).toBe(fetchedAt);
    expect(Date.parse(fetchedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(fetchedAt)).toBeLessThanOrEqual(Date.now());
  });

  it.each<[string, DocTab, () => Response, string, string | RegExp]>([
    ['an HTML page', 'Moves', () => new Response('<!DOCTYPE html><html lang="en"><head>'), 'NOT_CSV', HTML],
    ['an HTML page starting <html>', 'Moves', () => new Response('<html><head>'), 'NOT_CSV', HTML],
    ['an HTML page starting \\n<!doctype html>', 'Moves', () => new Response('\n<!doctype html>'), 'NOT_CSV', HTML],
    ['a response that is not valid CSV', 'Moves', () => new Response('"ID Number,Name'), 'NOT_CSV', /^"Moves" tab is not valid CSV/],
    ['the Moves CSV served for the Personal tab', 'Personal', () => new Response(MOVES_CSV), 'WRONG_TAB', '"Personal" tab does not show "ID Number,Name,HP" in its first 5 rows'],
    ['a non-2xx status', 'Items', () => new Response('Not Found', { status: 404 }), 'HTTP', '"Items" tab returned HTTP 404'],
    ['a request that fails', 'Personal', () => { throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND docs.google.com') }); },
      'HTTP', '"Personal" tab could not be fetched: fetch failed (getaddrinfo ENOTFOUND docs.google.com)'],
    // A docs edit can keep a tab's signature but break its parser; the saved copy must then stay as it was.
    ['a table tab its parser cannot read', 'Personal', () => new Response(PERSONAL_WITHOUT_STATS), 'BAD_FORMAT', '"Personal" tab cannot be parsed: The Personal tab has no "Attack" column'],
    ['a split tab its parser cannot read', 'Roark Split', () => new Response(BAD_ROARK), 'BAD_FORMAT',
      '"Roark Split" tab cannot be parsed: Roark Split row 9: cannot read the Pokémon cell "Level five Zigzagoon"'],
  ])('rejects %s, writing nothing', async (_, tab, bad, code, message) => {
    expect(await docsError(dir, failOn(tab, bad))).toMatchObject({ code, tab, message: typeof message === 'string' ? message : expect.stringMatching(message) });
    expect(listing()).toEqual([]);
  });

  it('looks for the signature in the first 5 rows only, ignoring case', async () => {
    const titled = (blankRows: number) => () => new Response(`${',,,\r\n'.repeat(blankRows)},,,,Platinum Kaizo - Roark Split\r\n`);
    await downloadDocs(dir, failOn('Roark Split', titled(4)));
    expect(await docsError(dir, failOn('Roark Split', titled(5)))).toMatchObject({ code: 'WRONG_TAB', tab: 'Roark Split' });
  });

  // Personal and Moves come first, so a download that fetched, parsed or wrote tab by tab would already have replaced them.
  it.each<[string, DocTab, () => Response]>([
    ['a later tab cannot be parsed', 'Roark Split', () => new Response(BAD_ROARK)],
    ['a later tab fails to download', 'Items', () => new Response('<html>')],
  ])('leaves an earlier download untouched when %s', async (_, tab, bad) => {
    mkdirSync(dir, { recursive: true });
    const old = { 'Moves.csv': 'old moves', 'Personal.csv': 'old personal', 'meta.json': 'old meta' };
    for (const [name, text] of Object.entries(old)) writeFileSync(join(dir, name), text);
    await docsError(dir, failOn(tab, bad));
    expect(Object.fromEntries(listing().map((name) => [name, readFileSync(join(dir, name), 'utf8')]))).toEqual(old);
  });
});

// Two processes (parallel test files, or record:diffs beside test:real) can write the same file at once.
it("writeWhole writes through a temporary file of its own process, leaving another process's alone", async () => {
  const path = join(root, 'Moves.csv');
  writeFileSync(`${path}.tmp`, 'another process, half way through');
  await writeWhole(path, 'moves');
  expect(readFileSync(path, 'utf8')).toBe('moves');
  expect(readFileSync(`${path}.tmp`, 'utf8')).toBe('another process, half way through');
  expect(readdirSync(root).sort()).toEqual(['Moves.csv', 'Moves.csv.tmp']);
});
