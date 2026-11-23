// Real-data check: each Pokémon's OT fields, the save's trainer and `PlayerMon.origin`, and the
// game-language byte in the ROM.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { readArm9 } from '../../src/ai/rom/items.js';
import { toPlayerMon } from '../../src/battle/playerMon.js';
import type { LoadedData } from '../../src/battle/types.js';
import { loadDocs } from '../../src/data/load.js';
import { buildNameIndex } from '../../src/names/nameIndex.js';
import { extractRomData } from '../../src/rom/extract.js';
import { GAME_LANGUAGE, GAME_LANGUAGE_ADDRESS, readSave } from '../../src/save/readSave.js';
import { needFiles, PK_ROM, PK_SAVE } from './env.js';

const caches = inject('realCaches');
const ARM9_RAM_ADDRESS = 0x28;
const DERI_NAME = [0x12e, 0x12f, 0x13c, 0x133, 0xffff];

const lang = needFiles('the game language in the ROM', { PK_ROM });

describe.skipIf(lang.skip)(lang.title, () => {
  it('GAME_LANGUAGE is the byte the ROM holds at 0x020E4C44', () => {
    const romFile = readFileSync(PK_ROM);
    const arm9 = readArm9(romFile);
    const base = new DataView(romFile.buffer, romFile.byteOffset, romFile.byteLength).getUint32(ARM9_RAM_ADDRESS, true);
    expect(GAME_LANGUAGE_ADDRESS).toBe(0x020e4c44);
    expect(arm9[GAME_LANGUAGE_ADDRESS - base]).toBe(GAME_LANGUAGE);
    expect(GAME_LANGUAGE).toBe(2);
  });
});

/**
 * The player's current run (trainer ID 180441969), which holds the exact values of the design's section 8.2 and the one traded
 * Pokémon. `PK_SAVE_CURRENT` if set, else `pk-run-2026-11-11.dsv` next to `PK_SAVE`.
 */
const PK_SAVE_CURRENT = process.env.PK_SAVE_CURRENT || join(dirname(PK_SAVE), 'pk-run-2026-11-11.dsv');

const data = (rom: ReturnType<typeof extractRomData>): LoadedData => {
  const docs = loadDocs(caches.docs.dir);
  return { rom, names: buildNameIndex(docs), docs };
};

/** The name codes up to and including the first terminator, or all of them when there is none (the game then compares all 8). */
const nameUpToEnd = (codes: number[]) => (codes.includes(0xffff) ? codes.slice(0, codes.indexOf(0xffff) + 1) : codes);

const current = needFiles("the player's current save: OT fields, the trainer and origin", { PK_ROM, PK_SAVE_CURRENT }, [caches.docs]);

describe.skipIf(current.skip)(current.title, () => {
  // Read in `beforeAll`, not the describe body: vitest runs a skipped suite's body to collect it (see boxOrigin.test.ts).
  let save: ReturnType<typeof readSave>;
  let origins: Array<ReturnType<typeof toPlayerMon>['origin']>;
  beforeAll(() => {
    const rom = extractRomData(readFileSync(PK_ROM));
    save = readSave(readFileSync(PK_SAVE_CURRENT), rom);
    origins = save.party.map((m) => toPlayerMon(m, data(rom), save.trainer).origin);
  });

  it('the trainer is the player: ID 180441969, gender 0, "DERI", 1 badge', () => {
    expect(save.trainer).toMatchObject({ id: 180441969, gender: 0, name: 'DERI', badges: 1 });
    expect(save.trainer.nameCodes.slice(0, 5)).toEqual(DERI_NAME);
  });

  it(`language 2 throughout; slots 1, 2, 3, 5, 6 are his own, slot 4 (Chestnut) is Hilary's and "traded"`, () => {
    expect(save.party.map((m) => m.nickname)[3]).toBe('Chestnut');
    expect(save.party.map((m) => m.language)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(save.party.map((m) => m.otId)).toEqual([180441969, 180441969, 180441969, 25643, 180441969, 180441969]);
    expect(save.party.map((m) => m.otGender)).toEqual([0, 0, 0, 1, 0, 0]);
    for (const slot of [0, 1, 2, 4, 5]) expect(save.party[slot]!.otName.slice(0, 5)).toEqual(DERI_NAME);
    // "Hilary": H i l a r y, then the terminator.
    expect(save.party[3]!.otName.slice(0, 7)).toEqual([0x132, 0x14d, 0x150, 0x145, 0x156, 0x15d, 0xffff]);
    expect(origins).toEqual(['own', 'own', 'own', 'traded', 'own', 'own']);
  });
});

const suite = needFiles('origin on the default save (structure)', { PK_ROM, PK_SAVE }, [caches.docs]);

// Whatever PK_SAVE is (the default is the 12 June run, another trainer's, all own), every party Pokémon's origin follows the
// rule. Names are compared with the game's rule: up to the first terminator, all 8 codes when there is none.
describe.skipIf(suite.skip)(suite.title, () => {
  let rom: ReturnType<typeof extractRomData>;
  let save: ReturnType<typeof readSave>;
  beforeAll(() => {
    rom = extractRomData(readFileSync(PK_ROM));
    save = readSave(readFileSync(PK_SAVE), rom);
  });

  it(`every party Pokémon has an origin, "own" exactly when its OT ID, gender and name codes match the trainer's`, () => {
    expect(save.party.length).toBeGreaterThan(0);
    for (const m of save.party) {
      const same = m.otId === save.trainer.id && m.otGender === save.trainer.gender
        && nameUpToEnd(m.otName).join() === nameUpToEnd(save.trainer.nameCodes).join();
      expect(toPlayerMon(m, data(rom), save.trainer).origin).toBe(same ? 'own' : m.language === GAME_LANGUAGE ? 'traded' : 'tradedOtherLanguage');
    }
  });

  it('two different names with no terminator are not the same name', () => {
    expect(nameUpToEnd([1, 2, 3, 4, 5, 6, 7, 8]).join()).not.toBe(nameUpToEnd([1, 2, 3, 4, 5, 6, 7, 9]).join());
  });
});
