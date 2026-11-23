import { expect, it } from 'vitest';
import { runFights, runOf, splitsOf } from '../../../src/server/run.js';
import { docMon, docTrainer, romTrainer, trainerMon } from '../../fixtures/loadedData.js';
import { GARDENIA_ID, serverData, TRISTAN_ID, TWINS_ID } from './fixtures.js';

/** The docs' split tabs, in tab order. */
const SPLITS = ['Roark Split', 'Gardenia Split', 'Fantina Split', 'Maylene Split', 'Wake Split', 'Byron Split', 'Candice Split', 'Volkner Split', 'Galactic Split', 'Elite Four Split'];

it.each([
  [0, SPLITS, { split: 'Roark Split', splitIndex: 0, splits: SPLITS, alsoPossible: [] }],
  [7, SPLITS, { split: 'Volkner Split', splitIndex: 7, splits: SPLITS, alsoPossible: [] }],
  [8, SPLITS, { split: 'Galactic Split', splitIndex: 8, splits: SPLITS, alsoPossible: ['Elite Four Split'] }],   // the Elite Four is also possible
  [12, SPLITS, { split: 'Galactic Split', splitIndex: 8, splits: SPLITS, alsoPossible: ['Elite Four Split'] }],
  [5, ['A', 'B'], { split: 'B', splitIndex: 1, splits: ['A', 'B'], alsoPossible: [] }],   // fewer splits than badges stop at the last
  [0, [], { split: '', splitIndex: 0, splits: [], alsoPossible: [] }],
])('runOf: %i badges over %j', (badges, splits, run) => {
  expect(runOf(badges, splits)).toEqual(run);
});

it('splitsOf lists each split once, in order', () => {
  expect(splitsOf({ trainers: [{ split: 'A' }, { split: 'A' }, { split: 'B' }, { split: 'A' }] })).toEqual(['A', 'B']);
});

const [YOKI_ID, JOEY_ID] = ['roark-split/maid-yoki/1', 'roark-split/youngster-joey/1'];
const JUNE = ['Lass Sarah', 'Clown Moe', 'Barry', 'Lass Madeline', 'Camper Curtis', 'Leader Roark'];
const JUNE_IDS = ['lass-sarah', 'clown-moe', 'barry', 'lass-madeline', 'camper-curtis', 'leader-roark'].map((slug) => `june-split/${slug}/1`);

/**
 * `serverData()` with three more Roark Split trainers after the twins: Maid Yoki (docs only, no ROM trainer), Youngster
 * Joey (ROM 5, a single) and Dawn, a tag partner (ROM 6). Then a June Split of six singles with ROM trainers 10 to 15:
 * Lass Sarah, Clown Moe, the rival Barry (a battle a script starts), Lass Madeline, Camper Curtis and Leader Roark.
 */
const data = serverData();
data.docs.trainers.splice(2, 0,
  docTrainer('Roark Split', 'Maid Yoki', 2, [docMon('Starly', 50)]),
  docTrainer('Roark Split', 'Youngster Joey', 3, [docMon('Starly', 9)]),
  docTrainer('Roark Split', 'Trainer Dawn', 4, [docMon('Monferno', 20)], { tags: { playerPartner: true, starred: false, raw: ['TAG PARTNER'] } }));
data.rom.trainers.push(romTrainer(5, [trainerMon(396, 9)]), romTrainer(6, [trainerMon(391, 20)]));
JUNE.forEach((name, k) => {
  data.docs.trainers.push(docTrainer('June Split', name, k, [docMon('Starly', 20 + k)]));
  data.rom.trainers.push(romTrainer(10 + k, [trainerMon(396, 20 + k)]));
});

const fights = (ids: string[], beaten: number[]) => ids.map((id, k) => ({ id, defeated: beaten.includes(k) }));
const ROARK = [TRISTAN_ID, TWINS_ID, YOKI_ID, JOEY_ID];

it.each<[string, string, number[], { fights?: { id: string; defeated: boolean }[]; next: string | null }]>([
  ['the split\'s opponents in docs order, partners left out; none beaten, the first single is next', 'Roark Split', [], { fights: fights(ROARK, []), next: TRISTAN_ID }],
  // ROM 1 is Tristan; the twins (ROM 2) are a double and Maid Yoki has no ROM trainer, so neither is next.
  ['a flag marks its trainer; next skips a double and a docs-only trainer', 'Roark Split', [1], { fights: fights(ROARK, [0]), next: JOEY_ID }],
  ['the twins beaten: Tristan before them, with no flag, is passed over', 'Roark Split', [2], { fights: fights(ROARK, [1]), next: JOEY_ID }],
  ['a flag no docs trainer stands for marks nothing', 'Roark Split', [0, 6, 99], { fights: fights(ROARK, []), next: TRISTAN_ID }],
  // Leader Gardenia is ROM 4, with ROM 3 as its copy: either flag beats her.
  ['a trainer with ROM copies, none beaten', 'Gardenia Split', [], { fights: fights([GARDENIA_ID], []), next: GARDENIA_ID }],
  ['a trainer beaten by its copy\'s flag', 'Gardenia Split', [3], { fights: fights([GARDENIA_ID], [0]), next: null }],
  ['a trainer beaten by its own flag', 'Gardenia Split', [4], { fights: fights([GARDENIA_ID], [0]), next: null }],
  ['no split', '', [1], { fights: [], next: null }],
  ['a split with no trainers', 'Elite Four Split', [], { fights: [], next: null }],
  // Sarah and Madeline beaten; Clown Moe and Barry between them have no flag.
  ['past the unflagged clown and rival, the first unbeaten single after the last beaten', 'June Split', [10, 13], { fights: fights(JUNE_IDS, [0, 3]), next: JUNE_IDS[4]! }],
  ['flags only in the split before: its first single is next', 'June Split', [1, 5], { next: JUNE_IDS[0]! }],
  ['flags only in other splits, the Gardenia Split', 'Gardenia Split', [1, 5, 10, 13], { next: GARDENIA_ID }],
  ['an unbeaten scripted fight between beaten ones is skipped', 'June Split', [10, 11, 13], { next: JUNE_IDS[4]! }],
  ['the next after the last beaten', 'June Split', [10, 11, 13, 14], { next: JUNE_IDS[5]! }],
  ['every fight beaten: none', 'June Split', [10, 11, 12, 13, 14, 15], { next: null }],
  ['the last one beaten leaves nothing after it', 'June Split', [15], { next: null }],
])('runFights: %s', (_name, split, flags, expected) => {
  expect(runFights(split, data, new Set(flags))).toMatchObject(expected);
});
