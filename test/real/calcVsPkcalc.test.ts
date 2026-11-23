// Real-data check: our damage rolls against PKCalc's own damage calc, for identical inputs over a grid of
// real trainers and the player's party (`calcGrid`). PKCalc's page runs its live third-party code, so it runs only in a fresh
// headless Chromium with service workers blocked and the network cut once it has loaded (`openPkcalcOffline`); the test
// fails if any request gets out after that. Every difference must be in accepted-diffs.json under area `calc`, and the
// group check in romVsDocs.test.ts covers it; `npm run record:diffs` rewrites both files. Mechanical differences are our
// bugs, fixed rather than accepted. Before the first run: `npx playwright install chromium`.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, inject, it } from 'vitest';
import { buildCatalog } from '../../src/battle/catalog.js';
import { buildMoves } from '../../src/battle/moves.js';
import type { LoadedData } from '../../src/battle/types.js';
import { diffsByKey } from '../../src/check/diff.js';
import { type DexTables, PAGE_DEX_TABLES } from '../../src/check/pkcalc.js';
import { calcGrid, DERI_PROFILES, diffCalc, gridTrainers, openPkcalcOffline, pkcalcNames, SPLIT_LEVEL_CAPS } from '../../src/check/pkcalcCalc.js';
import { loadDocs } from '../../src/data/load.js';
import { buildNameIndex } from '../../src/names/nameIndex.js';
import { extractRomData } from '../../src/rom/extract.js';
import { acceptedFor } from './accepted.js';
import { needFiles, PK_ROM } from './env.js';

const caches = inject('realCaches');
// PKCalc's own data files are not read here, but its cache's status says whether the network reaches PKCalc.
const suite = needFiles('Damage rolls against PKCalc', { PK_ROM }, [caches.docs, caches.pkcalc]);

describe.skipIf(suite.skip)(suite.title, () => {
  it('our 16 rolls, normal and critical, match PKCalc\'s over the grid, apart from the accepted diffs', async () => {
    const docs = loadDocs(caches.docs.dir);
    const data: LoadedData = { rom: extractRomData(readFileSync(PK_ROM)), names: buildNameIndex(docs), docs };
    const trainers = gridTrainers(buildCatalog(data));
    expect(trainers.map((trainer) => trainer.split)).toEqual(Object.keys(SPLIT_LEVEL_CAPS).flatMap((split) => [split, split, split]));
    const cases = calcGrid(trainers, DERI_PROFILES, data, buildMoves(data));

    const browser = await chromium.launch({ headless: true });
    try {
      const pkcalc = await openPkcalcOffline(browser);
      const { diffs, coverage } = await diffCalc(pkcalc.page, cases, pkcalcNames(await pkcalc.page.evaluate(PAGE_DEX_TABLES) as DexTables));
      expect(pkcalc.escaped(), `requests that got out after the network was cut; all attempted: ${pkcalc.attempted().join(', ') || 'none'}`).toEqual([]);
      // Not a vacuous comparison: most calcs deal damage (immunities deal none), and only accepted ones differ.
      expect(coverage.trainers).toBe(30);
      expect(coverage.rolls).toBe(2 * cases.length);
      expect(coverage.damaging).toBeGreaterThan(coverage.rolls * 0.8);
      expect(diffsByKey(diffs)).toEqual(acceptedFor('calc'));
    } finally {
      await browser.close();
    }
  });
});
