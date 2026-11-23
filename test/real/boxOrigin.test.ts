// Real-data check: the box the server builds from the player's current save gives the traded Chestnut
// `origin: 'traded'` (before, `buildBox` called `eligibleTeam` without the trainer, so every Pokémon read as own).
// Needs the extracted data in DATA_DIR (`npm run extract`) and the current save (see saveOwnership.test.ts).

import fs from 'node:fs';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadBaseDeps } from '../../src/integration/deps.js';
import { buildBox } from '../../src/server/box.js';
import { DEFAULT_SETTINGS } from '../../src/server/settings.js';
import { DATA_DIR, needFiles, PK_SAVE } from './env.js';

const DATA = path.resolve(DATA_DIR);
/** The player's current run, as in saveOwnership.test.ts: `PK_SAVE_CURRENT` if set, else `pk-run-2026-11-11.dsv` next to `PK_SAVE`. */
const PK_SAVE_CURRENT = process.env.PK_SAVE_CURRENT || join(dirname(PK_SAVE), 'pk-run-2026-11-11.dsv');
const suite = needFiles("the box's team takes origin from the save's trainer", {
  ROMDATA: path.join(DATA, 'rom', 'romdata.json'), TRAINER_AI: path.join(DATA, 'rom', 'trainer-ai.json'), PK_SAVE_CURRENT,
});

describe.skipIf(suite.skip)(suite.title, () => {
  // Built in `beforeAll`, not the describe body: vitest runs a skipped suite's body to collect it, and reading a missing
  // save there failed the file with ENOENT instead of skipping it.
  let box: ReturnType<typeof buildBox>;
  beforeAll(() => {
    const base = loadBaseDeps(DATA);
    box = buildBox({ file: fs.readFileSync(PK_SAVE_CURRENT), savePath: PK_SAVE_CURRENT, savedAt: new Date(), data: base.data, settings: { ...DEFAULT_SETTINGS } });
  });

  it('Chestnut is "traded" and every other party Pokémon "own"', () => {
    const party = [...box.byRef.values()].filter((m) => m.location.kind === 'party').sort((a, b) => a.location.slot - b.location.slot);
    expect(party.map((m) => m.nickname)).toContain('Chestnut');
    expect(party.map((m) => [m.nickname, m.origin])).toEqual(party.map((m) => [m.nickname, m.nickname === 'Chestnut' ? 'traded' : 'own']));
  });
});
