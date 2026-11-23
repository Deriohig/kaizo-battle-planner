// Real-data check of the trainer-defeated flags (src/save/trainerFlags.ts) on the player's frozen 12 June save (`PK_SAVE`: no
// badges yet, so the Roark Split), and what the run makes of them. The flags set there are trainers 1-4, 10-12, 322, 323,
// 355 and 356, whom pokeplatinum names Youngster Tristan, Youngster Logan, Lass Natalie, Youngster Michael, Youngster Tyler,
// Lass Samantha, Lass Sarah, Lass Madeline, Lass Kaitlin, Youngster Dallas and Youngster Sebastian (generated/
// vars_flags.txt:1367-1722, trainer n at line 1366 + n): the docs' Route 202, 204 and 203 trainers. The twelfth, 756, is a
// rematch slot (Skier Andrea's) no docs trainer stands for. Not set: the Jubilife clowns and the Trainer School (before
// Route 204 in the docs), the rival on Route 203 (a battle a script starts), and everything from Oreburgh Gate on, where
// `next` is.
// Needs the extracted data in DATA_DIR (`npm run extract`) and PK_SAVE.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { trainerId } from '../../src/battle/resolveTrainer.js';
import { type LocalData, loadLocalData } from '../../src/data/load.js';
import { matchTrainers } from '../../src/names/matchTrainers.js';
import { readSave, type SaveData } from '../../src/save/readSave.js';
import { TRAINER_FLAG_COUNT } from '../../src/save/trainerFlags.js';
import { buildBox } from '../../src/server/box.js';
import { runFights, splitsOf } from '../../src/server/run.js';
import { DEFAULT_SETTINGS } from '../../src/server/settings.js';
import { DATA_DIR, needFiles, PK_SAVE } from './env.js';

const DATA = path.resolve(DATA_DIR);
const suite = needFiles("the trainer-defeated flags of the player's 12 June save", { ROMDATA: path.join(DATA, 'rom', 'romdata.json'), PK_SAVE });

/** The Roark Split fights the 12 June save has beaten, in docs order. */
const BEATEN = [
  'youngster-tristan', 'lass-natalie', 'bug-catcher-logan', 'lass-samantha', 'youngster-tyler', 'lass-sarah',
  'youngster-dallas', 'youngster-michael', 'bug-catcher-sebastian', 'lass-kaitlin', 'lass-madeline',
].map((name) => `roark-split/${name}/1`);

describe.skipIf(suite.skip)(suite.title, () => {
  // Read in `beforeAll`: vitest runs a skipped suite's body to collect it (boxOrigin.test.ts).
  let data: LocalData;
  let save: SaveData;
  beforeAll(() => {
    data = loadLocalData(DATA);
    save = readSave(fs.readFileSync(PK_SAVE), data.rom);
  });

  it('every ROM trainer has a flag: the ROM holds trainers 0 to 927, as many as the game has flags for', () => {
    expect(data.rom.trainers.map((t) => t.index)).toEqual(Array.from({ length: TRAINER_FLAG_COUNT }, (_, index) => index));
  });

  it('reads the flags of the Route 202, 203 and 204 trainers', () => {
    expect(save.trainer.badges).toBe(0);
    expect([...save.defeatedTrainers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 10, 11, 12, 322, 323, 355, 356, 756]);
  });

  it('the box\'s run: the Roark Split\'s fights up to Route 203 beaten, the first single after the last of them next', () => {
    const { run } = buildBox({ file: fs.readFileSync(PK_SAVE), savePath: PK_SAVE, savedAt: new Date(), data, settings: { ...DEFAULT_SETTINGS } }).json;
    expect(run.split).toBe('Roark Split');
    expect(run.fights.filter((f) => f.defeated).map((f) => f.id)).toEqual(BEATEN);
    // Not the Jubilife clowns, the Trainer School or the rival, unflagged before the last beaten fight (Lass Madeline).
    expect(run.next).toBe('roark-split/camper-curtis/1');
    // Unbeaten from Oreburgh Gate on.
    const gate = run.fights.findIndex((f) => f.id === 'roark-split/camper-curtis/1');
    expect(gate).toBeGreaterThan(0);
    expect(run.fights.slice(gate).every((f) => !f.defeated)).toBe(true);
  });

  it('no fight of a later split is beaten, and a docs trainer with no ROM trainer is listed, unbeaten, never next', () => {
    for (const split of splitsOf(data.docs).slice(1)) {
      expect(runFights(split, data, save.defeatedTrainers).fights.filter((f) => f.defeated), split).toEqual([]);
    }
    const gardenia = runFights('Gardenia Split', data, save.defeatedTrainers);
    expect(gardenia.next).toBe('gardenia-split/galacticf-venus/1');
    const docsOnly = matchTrainers(data.rom.trainers, data.docs.trainers, data.names).docsOnly
      .filter((doc) => doc.split === 'Gardenia Split' && doc.tags.playerPartner !== true)
      .map((doc) => trainerId(doc, data.docs.trainers));
    for (const id of docsOnly) expect(gardenia.fights).toContainEqual({ id, defeated: false });
  });
});
