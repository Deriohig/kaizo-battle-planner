// The run's cursor and helpers (web/src/run.ts): which split's fights the page shows, the fight it opens and the one
// after, the trainer last opened kept per save, the ids beaten, and the search ranked name, then location, then split.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RunJson, TrainerSummaryJson } from '../../../src/server/apiTypes';
import {
  beatenIds, CURSOR_KEY, nextChoices, type NextChoices, nextFight, OLD_KEYS, openFight, rankFound, readCursor, removeOldKeys, searchTier, shownSplit,
  splitFights, writeCursor,
} from '../../../web/src/run';
import { box, GARDENIA, ROARK, TAYLOR, trainerById, trainers, TRISTAN, TWINS } from './stubServer';

const ROARK_SPLIT = () => splitFights(trainers(), 'Roark Split');
const RUN8: RunJson = { split: 'Galactic Split', splitIndex: 8, splits: ['Galactic Split', 'Elite Four Split'], alsoPossible: ['Elite Four Split'], fights: [], next: null };
/** A trainer of `split` at `order` in it, a single battle unless said. */
const T = (id: string, split: string, order: number, battleType: 'single' | 'double' = 'single'): TrainerSummaryJson =>
  ({ id, name: id, split, location: 'Route 1', order, battleType, tags: [], variants: 1 });
const at = (trainerId: string) => ({ split: 'Roark Split', trainerId });
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it("a split's fights are its trainers in game order; the split shown is the cursor's only when the save could be there", () => {
  expect(ROARK_SPLIT().map((t) => t.id)).toEqual([TRISTAN, TWINS, ROARK]);
  expect(shownSplit(RUN8, { split: 'Elite Four Split', trainerId: 'x' })).toBe('Elite Four Split');
  expect(shownSplit(RUN8, at(TRISTAN))).toBe('Galactic Split');
  expect(shownSplit(box().run, null)).toBe('Roark Split');
});

it.each<[string, TrainerSummaryJson[], ReturnType<typeof at> | null, string | null | undefined, string | null]>([
  ['the trainer last opened', ROARK_SPLIT(), at(ROARK), undefined, ROARK],
  ['else the first single battle', ROARK_SPLIT(), null, undefined, TRISTAN],
  ['a cursor gone from the split', ROARK_SPLIT(), at('gone'), undefined, TRISTAN],
  ['else the first trainer', [trainerById(TWINS)], null, undefined, TWINS],
  ['nothing in an empty split', [], null, undefined, null],
  ["the save's next fight when it is listed, over the cursor", ROARK_SPLIT(), at(TRISTAN), ROARK, ROARK],
  ['the first single when the next is not listed', ROARK_SPLIT(), null, GARDENIA, TRISTAN],
  ['the cursor when the next is not listed', ROARK_SPLIT(), at(ROARK), 'nope', ROARK],
  ['the cursor when the next is null', ROARK_SPLIT(), at(ROARK), null, ROARK],
  ['the first single when the next is null', ROARK_SPLIT(), null, null, TRISTAN],
])('openFight opens %s', (_, fights, cursor, next, id) => {
  expect(openFight(fights, cursor, next)?.id ?? null).toBe(id);
});

it('the next fight skips doubles and is none after the last', () => {
  expect([TRISTAN, ROARK, null, 'gone'].map((id) => nextFight(ROARK_SPLIT(), id)?.id ?? null)).toEqual([ROARK, null, TRISTAN, TRISTAN]);
});

it("the next fight is the split's next single battle, and the first of the next split at its end; doubles are never offered", () => {
  const all = [T('a', 'One', 1), T('d', 'One', 2, 'double'), T('b', 'One', 3), T('c', 'Two', 1, 'double'), T('e', 'Two', 2), T('f', 'Three', 1)];
  const ids = (c: NextChoices) => [c.next?.id ?? null, c.groups.map((g) => [g.split, g.fights.map((t) => t.id)])];
  expect(ids(nextChoices(all, ['One', 'Two', 'Three'], all[0]!))).toEqual(['b', [['One', ['b']], ['Two', ['e']]]]);
  expect(ids(nextChoices(all, ['One', 'Two', 'Three'], all[2]!))).toEqual(['e', [['One', ['a']], ['Two', ['e']]]]);
  expect(ids(nextChoices(all, ['One', 'Two', 'Three'], all[5]!))).toEqual([null, []]);
  expect(ids(nextChoices(all, ['Two'], all[0]!))).toEqual(['b', [['One', ['b']]]]);              // a split the run does not list has none after it
});

it('the cursor is kept per save; junk and a storage that refuses read as none', () => {
  writeCursor('/a.dsv', at(ROARK));
  writeCursor('/b.dsv', { split: 'Gardenia Split', trainerId: TAYLOR });
  expect(readCursor('/a.dsv')).toEqual(at(ROARK));
  localStorage.setItem(CURSOR_KEY, '{"/a.dsv": 7}');
  expect(readCursor('/a.dsv')).toBeNull();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  expect(readCursor('/a.dsv')).toBeNull();
  expect(() => writeCursor('/a.dsv', { split: 's', trainerId: 't' })).not.toThrow();
});

it('removeOldKeys takes the what-if levels, the gauntlets and every kept line away, and nothing else', () => {
  for (const key of [...OLD_KEYS, 'pkp.draft', 'pkp.line.current.x.0', 'pkp.line.saved.y.1', 'pkp.tree.current.x.0']) localStorage.setItem(key, '1');
  removeOldKeys();
  expect(Object.keys(localStorage).sort()).toEqual(['pkp.draft', 'pkp.tree.current.x.0']);
});

it("lists the beaten ids only for the run's own split", () => {
  const run = { ...box().run, split: 'Roark Split', fights: [{ id: TRISTAN, defeated: true }, { id: ROARK, defeated: false }] };
  expect([beatenIds(run, 'Roark Split'), beatenIds(run, 'Gardenia Split')]).toEqual([[TRISTAN], []]);
});

const GARDEN_PATH = { ...trainerById(TAYLOR), id: 'x/garden-path/1', name: 'Hiker Ned', split: 'Other Split', location: 'Garden Path', order: 40 };
const gardenia = () => ({ ...trainerById(GARDENIA), order: 67 });
const taylor = () => ({ ...trainerById(TAYLOR), order: 30 });
const names = (list: TrainerSummaryJson[], text: string) => rankFound(list, text).map((t) => t.name);

it('the search ranks name, then location, then split, on words split at white space, in any order', () => {
  const list = [gardenia(), taylor(), GARDEN_PATH];
  expect(names(list, 'garden')).toEqual(['Leader Gardenia', 'Hiker Ned', 'Aroma Lady Taylor']);
  expect(names(list, 'Gàrden')).toEqual(names(list, 'GARDEN'));
  expect(names(list, '')).toEqual(['Aroma Lady Taylor', 'Hiker Ned', 'Leader Gardenia']);
  expect(names(list, 'garden path')).toEqual(['Hiker Ned', 'Aroma Lady Taylor', 'Leader Gardenia']);
  expect([
    searchTier(GARDEN_PATH, 'garden path'), searchTier(GARDEN_PATH, '  garden   path '), searchTier(gardenia(), 'gardenia split'),
    searchTier(taylor(), 'taylor aroma'), searchTier(gardenia(), 'gardenia eterna'),        // words apart, in another order
  ]).toEqual([1, 1, 2, 0, 1]);
  // A word that only the split holds separates all three tiers.
  const byName = { ...GARDEN_PATH, id: 'x/a/1', name: 'Ranger Split Gardenia', location: 'Route 1', order: 90 };
  const byPlace = { ...GARDEN_PATH, id: 'x/b/1', name: 'Hiker Ned', location: 'Gardenia Splitrock', order: 50 };
  expect([byName, byPlace, taylor()].map((t) => searchTier(t, 'gardenia split'))).toEqual([0, 1, 2]);
  expect(names([taylor(), byPlace, byName], 'gardenia split')).toEqual(['Ranger Split Gardenia', 'Hiker Ned', 'Aroma Lady Taylor']);
});
