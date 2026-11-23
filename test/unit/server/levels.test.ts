// What-if levels for the split bench's plan request (docs/what-if-levels.md): the `levels` field's parsing and checks,
// and applying it to the box's Pokémon.

import { expect, it } from 'vitest';
import { buildBox } from '../../../src/server/box.js';
import { levelledMons, levelsFromBody, levelsProblem, levelsRecord } from '../../../src/server/levels.js';
import { DEFAULT_SETTINGS } from '../../../src/server/settings.js';
import { saveFile, serverData } from './fixtures.js';

it.each<[unknown, unknown]>([
  [{ 'party:1': 18, 'box:2:5': 16 }, { ok: true, entries: [['party:1', 18], ['box:2:5', 16]] }],
  [undefined, { ok: true, entries: [] }],
  [{}, { ok: true, entries: [] }],
  ...[null, [], 'party:1=18', 18].map((raw): [unknown, unknown] => [raw, { ok: false, error: 'levels must be an object from MonRef to level' }]),
  [{ 'party:1': '18' }, { ok: false, error: 'levels: the level for party:1 must be a whole number, not "18"' }],
  [{ 'party:1': 18.5 }, expect.objectContaining({ ok: false })],
  [{ 'party:1': null }, expect.objectContaining({ ok: false })],
])('levelsFromBody(%j) gives %j', (raw, result) => {
  expect(levelsFromBody(raw)).toEqual(result);
});

it.each<[[string, number][], 'team' | 'pool', string | null]>([
  [[['party:1', 15], ['party:2', 100]], 'team', null],   // from the save's level up to 100
  [[], 'team', null],
  [[['party:1', 14]], 'team', 'levels: party:1 is level 15 in the save, so its level must be a whole number from 15 to 100, not 14'],
  [[['party:2', 101]], 'team', 'levels: party:2 is level 14 in the save, so its level must be a whole number from 14 to 100, not 101'],
  [[['party:1', 16], ['party:1', 17]], 'team', 'levels lists party:1 twice'],
  [[['box:1:1', 20]], 'team', 'levels: box:1:1 is not in the team'],
  [[['box:1:1', 20]], 'pool', 'levels: box:1:1 is not in the pool'],
])('levelsProblem: %j in the %s gives %j', (entries, where, problem) => {
  expect(levelsProblem(entries, new Map([['party:1', 15], ['party:2', 14]]), where)).toBe(problem);
});

it('levelledMons raises the named Pokémon, leaving the others and the map as they were; levelsRecord gives a solve request\'s object', () => {
  // The fixture save's box: Monferno Lv 15 at party:1, Starly Lv 14 at party:2.
  const { byRef } = buildBox({ file: saveFile(), savePath: 'x.dsv', savedAt: new Date(0), data: serverData(), settings: DEFAULT_SETTINGS });
  const out = levelledMons(byRef, new Map([['party:2', 20]]));
  expect([out.get('party:1') === byRef.get('party:1'), out.get('party:2')!.level, byRef.get('party:2')!.level, levelledMons(byRef, new Map())])
    .toEqual([true, 20, 14, byRef]);
  expect([levelsRecord(new Map([['party:2', 20], ['party:1', 18]])), levelsRecord(new Map())]).toEqual([{ 'party:2': 20, 'party:1': 18 }, {}]);
});
