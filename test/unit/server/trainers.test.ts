import { expect, it } from 'vitest';
import { buildCatalog } from '../../../src/battle/catalog.js';
import { pickVariant, searchTrainers, trainerSummaries } from '../../../src/server/trainers.js';
import { GARDENIA_ID, serverData, TRISTAN_ID, TWINS_ID } from './fixtures.js';

const catalog = buildCatalog(serverData());
const ALL = [
  { id: TRISTAN_ID, name: 'Youngster Tristan', split: 'Roark Split', location: 'Route 202', order: 0, battleType: 'single', tags: [], variants: 1 },
  { id: TWINS_ID, name: 'Twins Ally and Ann', split: 'Roark Split', location: 'Route 203', order: 1, battleType: 'double', tags: ['DOUBLE'], variants: 1 },
  // Leader Gardenia's two ROM copies are 2 variants; her field note is a tag.
  { id: GARDENIA_ID, name: 'Leader Gardenia', split: 'Gardenia Split', location: 'Eterna Gym', order: 2, battleType: 'single', tags: ['PERMANENT RAIN'], variants: 2 },
];

it('trainerSummaries summarises every trainer in docs order, saying nothing of a solver', () => {
  expect(trainerSummaries(catalog)).toEqual(ALL);
});

it('splits a field note at commas, trims the pieces and drops repeats case-insensitively, keeping the first spelling', () => {
  const data = serverData();
  const gardenia = data.docs.trainers[2]!;
  gardenia.tags = { ...gardenia.tags, raw: ['Superboss', ' Trick Room'] };
  gardenia.field = { raw: ' PERMANENT RAIN , trick room,Permanent Rain, ', weather: 'rain', trickRoom: true };
  expect(trainerSummaries(buildCatalog(data))[2]!.tags).toEqual(['Superboss', 'Trick Room', 'PERMANENT RAIN']);
});

it.each([
  ['tristan', [ALL[0]]], ['gardenia', [ALL[2]]], ['cynthia', []], ['', ALL], ['   ', ALL], [null, ALL],
])('searchTrainers(%j) keeps each trainer\'s global order', (text, found) => {
  expect(searchTrainers(catalog, text)).toEqual(found);
});

it('pickVariant gives the trainer as resolved (ROM 4) for 0, its second copy (ROM 3, 0 IVs) for 1, else null', () => {
  const gardenia = catalog.byId(GARDENIA_ID)!;
  const second = pickVariant(gardenia, 1)!;
  expect([pickVariant(gardenia, 0) === gardenia, second === gardenia.variants[0], gardenia.romIndex, second.romIndex, second.party.map((mon) => mon.ivs.hp)])
    .toEqual([true, true, 4, 3, [0, 0]]);
  // Past the last copy, a negative one or a fraction.
  expect([...[2, -1, 0.5].map((v) => pickVariant(gardenia, v)), pickVariant(catalog.byId(TRISTAN_ID)!, 1)]).toEqual([null, null, null, null]);
});
