// Real-data check: our save reader against PKCalc's own import of the same save. Both read the same bytes,
// so they must agree exactly; nothing about the save is pinned, as it changes as the player plays. PKCalc's page runs in a
// fresh headless Chromium (Playwright), so the player's own browser is untouched. The page runs PKCalc's live third-party
// code and is handed the whole save, trainer name and ID included, so the network is cut once the page has loaded and
// before the save is handed over (`openPkcalcOffline`), and the test fails if any request gets out after that. Before
// the first run: `npx playwright install chromium`.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { buildPkcalcDex, type DexTables, diffBox, PAGE_DEX_TABLES, type PkcalcCustomSets } from '../../src/check/pkcalc.js';
import { openPkcalcOffline } from '../../src/check/pkcalcCalc.js';
import { extractRomData } from '../../src/rom/extract.js';
import { readSave } from '../../src/save/readSave.js';
import { needFiles, PK_ROM, PK_SAVE } from './env.js';

const suite = needFiles('Save against PKCalc\'s import of it', { PK_ROM, PK_SAVE });

describe.skipIf(suite.skip)(suite.title, () => {
  it('every Pokémon that is not an egg matches PKCalc\'s import, and PKCalc imports nothing else', async () => {
    const save = readSave(readFileSync(PK_SAVE), extractRomData(readFileSync(PK_ROM)));
    const browser = await chromium.launch({ headless: true });
    try {
      // PKCalc greets a new visitor with its changelog in an alert; any other alert means the import failed.
      const { page, alerts, attempted, escaped } = await openPkcalcOffline(browser);
      expect(await page.evaluate(() => localStorage.getItem('customsets'))).toBeNull();

      await page.setInputFiles('#saveFile', PK_SAVE);
      // parseSaveFile adds every Pokémon in one synchronous run, so customsets is complete once it appears.
      let customsets: PkcalcCustomSets;
      try {
        const stored = await page.waitForFunction(() => localStorage.getItem('customsets'), undefined, { timeout: 30_000 });
        customsets = JSON.parse((await stored.jsonValue())!) as PkcalcCustomSets;
      } catch (error) {
        throw new Error(`PKCalc did not import the save; its alerts: ${alerts.join(' | ')}`, { cause: error });
      }
      const dex = buildPkcalcDex(await page.evaluate(PAGE_DEX_TABLES) as DexTables);
      expect(escaped(), `requests that got out after the network was cut; all attempted: ${attempted().join(', ') || 'none'}`).toEqual([]);
      expect(diffBox([...save.party, ...save.boxes], customsets, dex)).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
