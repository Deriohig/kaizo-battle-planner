// The draft team's overrides (src/server/draft.ts), their shared rules (src/server/draftRules.ts, which the page uses too)
// and the items a Pokémon may hold in a draft.

import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_LEVEL as BATTLE_MAX_LEVEL } from '../../../src/battle/playerMon.js';
import type { DraftOptionsJson } from '../../../src/contracts/api.js';
import { installKaizoDex, itemId } from '../../../src/engine/index.js';
import { computeStats } from '../../../src/rom/stats.js';
import type { Stats } from '../../../src/rom/types.js';
import { buildBox } from '../../../src/server/box.js';
import { applyDraft, DraftError, type DraftMon, draftItems, factsOfMon, HACK_HELD_ITEMS, parseDraft } from '../../../src/server/draft.js';
import { type DraftEdit, type DraftFacts, draftProblem, isDraftStatus, levelOfExp, MAX_LEVEL, maxHpOf, startHp } from '../../../src/server/draftRules.js';
import { DEFAULT_SETTINGS } from '../../../src/server/settings.js';
import { factsOf } from '../../../web/src/draft.js';
import { fixtureDex } from '../engine/fixtures.js';
import { saveFile, serverData } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

// Moves the fixture has and the save's Monferno (Tackle 33, Ember 52) does not know.
const [SCRATCH, GROWL] = [10, 45];
const data = serverData();
data.rom.learnsets[391] = [{ move: SCRATCH, level: 16 }, { move: GROWL, level: 40 }];
// `saveFile()`: party Monferno Lv 15 (exp 2449, medium slow) and Starly Lv 14; box 1 slot 1 Starly; box 15 slot 1 dead.
const state = buildBox({ file: saveFile(), savePath: '/saves/x.dsv', savedAt: new Date('2026-11-20T09:00:00.000Z'), data, settings: DEFAULT_SETTINGS });
const { pool } = state;
const M = () => pool.get('party:1')!;   // Monferno Lv 15
const apply = (d: Partial<DraftMon>, mon = M()) => applyDraft(mon, { ref: 'party:1', ...d }, data);
const ZERO = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
const maxHp = (level: number) => computeStats(M().baseStats, M().ivs, M().evs, level, M().nature.value ?? 0).hp;

describe('applyDraft', () => {
  it('applies each edit: a level sets its own EXP total, HP, status, moves, item, IVs and nature; none is a copy of the save\'s', () => {
    expect([apply({}), apply({}) === M()]).toEqual([M(), false]);
    const edits: Partial<DraftMon>[] = [{ level: 16 }, { level: 14 }, { exp: 2100 }, { hp: 1 }, { status: { kind: 'burn' } }, { ivs: ZERO, nature: 3 }];
    expect(edits.map((edit) => apply(edit))).toMatchObject([
      { level: 16, exp: 2535 }, { level: 14, exp: 1612 }, { level: 15, exp: 2100 }, { currentHp: 1 }, { status: { kind: 'burn' } }, { ivs: ZERO, nature: { value: 3 } },
    ]);
    expect(apply({ status: { kind: 'none' } }, { ...M(), status: { kind: 'sleep', turns: 3 } }).status).toEqual({ kind: 'none' });
    // Items: none, one from the list, and the EXP items the engine pays for by id though the data cannot name them.
    for (const item of [0, draftItems(data)[0]!.id, 216, 231]) expect(apply({ item }).item).toBe(item);
    // Left out, the HP keeps the HP lost and stays alive.
    const hurt = { ...M(), currentHp: 1 };
    expect([apply({ level: 1 }, hurt).currentHp, apply({ level: 16 }, hurt).currentHp]).toEqual([1, maxHp(16) - (maxHp(15) - 1)]);
    // The save's moves keep their PP and PP Ups, a level-up move comes in full.
    const kept = apply({ level: 16, moves: [{ id: SCRATCH }, { id: 33 }] }, { ...M(), pp: M().pp.map(() => 3), ppUps: M().ppUps.map(() => 2) });
    expect([kept.moves, kept.pp, kept.ppUps]).toEqual([[SCRATCH, 33], [data.rom.moves[SCRATCH]!.pp, 3], [0, 2]]);
  });

  it.each<[Partial<DraftMon>, string]>([
    [{ exp: 5 }, 'exp 5 does not fit level 15 (2035 to 2534)'],
    [{ level: 0 }, 'level must be a whole number from 1 to 100, not 0'],
    [{ hp: 0 }, 'hp must be a whole number from 1 to 44, not 0'],
    [{ level: 14, hp: 44 }, 'hp must be a whole number from 1 to 42, not 44'],
    [{ moves: [{ id: SCRATCH }] }, `cannot know move ${SCRATCH} at level 15`],   // learned at 16
    [{ moves: [] }, 'needs 1 to 4 moves'],
    [{ moves: [{ id: 33 }, { id: 33 }] }, 'lists move 33 twice'],
    [{ moves: [{ id: 33, pp: 36 }] }, 'move 33 pp must be a whole number from 0 to 35, not 36'],
    [{ item: 120 }, 'item 120 is not an item a Pokémon can hold here'],   // an unused Gen 3 leftover
    [{ ivs: { ...ZERO, hp: 32 } }, 'ivs must be six whole numbers from 0 to 31'],
    [{ evs: { ...ZERO, hp: 255, atk: 255, def: 1 } }, 'evs must be six whole numbers from 0 to 255, 510 in all at most'],
    [{ nature: 25 }, 'nature must be a whole number from 0 to 24'],
  ])('refuses %j: "%s"', (edit, error) => {
    expect(() => apply(edit)).toThrow(new DraftError(`draft: party:1 ${error}`));
  });
});

it.each<[unknown, string]>([
  [{}, 'draft must be an array'],
  [[{ ref: 'party:9' }], 'draft: party:9 is not in the team'],
  [[{ ref: 'party:1' }, { ref: 'party:1' }], 'draft lists party:1 twice'],
  [[{ ref: 'party:1', foo: 1 }], 'draft: party:1 has an unknown field "foo"'],
  [[{ ref: 'party:1', status: 'asleep' }], 'draft: party:1 status must be none, sleep:1 to sleep:7, poison, toxic, burn, freeze or paralysis, not "asleep"'],
  [[{ ref: 'party:1', hp: '7' }], 'draft: party:1 hp must be a number'],
])('parseDraft refuses %j', (body, error) => {
  expect(() => parseDraft(body, ['party:1'])).toThrow(error);
});

it('parseDraft reads the JSON; a draft status is exactly what it takes', () => {
  expect(parseDraft([{ ref: 'party:1', hp: 7, status: 'sleep:2', moves: [{ id: 5, pp: 1 }] }, { ref: 'party:2', status: 'none' }], ['party:1', 'party:2']))
    .toEqual([{ ref: 'party:1', hp: 7, status: { kind: 'sleep', turns: 2 }, moves: [{ id: 5, pp: 1 }] }, { ref: 'party:2', status: { kind: 'none' } }]);
  for (const status of ['none', 'sleep:1', 'sleep:7', 'sleep:0', 'sleep:8', 'poison', 'toxic', 'burn', 'freeze', 'paralysis', 'asleep', 'healthy', '']) {
    const parses = (() => { try { parseDraft([{ ref: 'a', status }], ['a']); return true; } catch { return false; } })();
    expect(isDraftStatus(status), status).toBe(parses);
  }
});

describe('draftProblem', () => {
  const S = (v: number): Stats => ({ hp: v, atk: v, def: v, spa: v, spd: v, spe: v });
  const cube = Array.from({ length: 101 }, (_, level) => level ** 3);
  // Base HP 50, IVs 31, no EVs: max HP 44 at Lv 15, 46 at Lv 16, 42 at Lv 14.
  const facts = (over: Partial<DraftFacts> = {}): DraftFacts => ({
    level: 15, exp: 3500, hp: 30, ivs: S(31), evs: S(0), nature: 0, baseStats: { ...S(40), hp: 50 }, item: 155,
    moves: [{ id: 183, pp: 28, maxPp: 30, known: true }, { id: 52, pp: 25, maxPp: 25, known: true }],
    learnset: [{ level: 16, id: 172, pp: 25, known: true }, { level: 1, id: 999, pp: 0, known: false }],
    growth: cube, items: new Set([149, 234]), ...over,
  });

  it.each<[DraftEdit, string | null]>([
    [{}, null],
    [{ ivs: { ...S(0), hp: 32 }, level: 0 }, 'ivs must be six whole numbers from 0 to 31'],   // the first rule broken, in applyDraft's order
    [{ level: 101 }, 'level must be a whole number from 1 to 100, not 101'],
    [{ exp: 5 }, 'exp 5 does not fit level 15 (3375 to 4095)'],
    [{ level: 100, exp: 5 }, 'exp 5 does not fit level 100 (1000000 or more)'],
    [{ moves: [{ id: 172 }] }, 'cannot know move 172 at level 15'],
    [{ level: 16, moves: [{ id: 172 }] }, null],
    [{ moves: [{ id: 999 }] }, 'move 999 is not in the data'],
    [{ moves: [{ id: 183, pp: 31 }] }, 'move 183 pp must be a whole number from 0 to 30, not 31'],
    [{ item: 0 }, null], [{ item: 155 }, null], [{ item: 234 }, null],
    [{ hp: 45 }, 'hp must be a whole number from 1 to 44, not 45'],
    [{ level: 14, hp: 43 }, 'hp must be a whole number from 1 to 42, not 43'],
  ])('%j gives %j', (edit, problem) => {
    expect(draftProblem(facts(), edit)).toBe(problem);
  });

  it('without the tables, EXP and the item are checked for shape only', () => {
    const bare = facts({ growth: null, items: null });
    expect([draftProblem(bare, { exp: 5, item: 120 }), draftProblem(bare, { exp: 1.5 }), draftProblem(bare, { item: -1 })])
      .toEqual([null, 'exp must be a whole number, not 1.5', 'item -1 is not an item a Pokémon can hold here']);
  });

  it('max HP follows the level and IVs; the start HP is the HP given, else keeps the HP lost and stays alive; the level of an EXP', () => {
    expect([maxHpOf(facts()), maxHpOf(facts(), { level: 16 }), maxHpOf(facts(), { ivs: S(0) })]).toEqual([44, 46, 40]);
    expect([startHp(facts(), {}), startHp(facts(), { level: 16 }), startHp(facts({ hp: 1 }), { level: 1 }), startHp(facts(), { hp: 7 })]).toEqual([30, 32, 1, 7]);
    expect([0, 1, 3374, 3375, 999_999, 1_000_000, 2_000_000].map((exp) => levelOfExp(cube, exp))).toEqual([1, 1, 14, 15, 99, 100, 100]);
    expect(MAX_LEVEL).toBe(BATTLE_MAX_LEVEL);
  });
});

it("factsOfMon is what applyDraft rules on: the save's level, EXP, nature, growth, learnset, items and moves, max PP counting PP Ups", () => {
  // Tackle 35 PP with no PP Ups, Ember 25 base PP with one (25 × 6 / 5 = 30).
  expect(factsOfMon(M(), data)).toMatchObject({
    level: 15, exp: 2449, nature: M().nature.value, growth: data.rom.growth[data.rom.species[391]!.growthRate], items: new Set(draftItems(data).map((item) => item.id)),
    learnset: [{ level: 16, id: SCRATCH, pp: data.rom.moves[SCRATCH]!.pp, known: true }, { level: 40, id: GROWL, pp: data.rom.moves[GROWL]!.pp, known: true }],
    moves: [{ id: 33, pp: 35, maxPp: 35, known: true }, { id: 52, pp: 30, maxPp: 30, known: true }],
  });
  // A move with no ROM record has a max of 0 and is not known. Only a hand-built Pokémon reaches this: the box gives no
  // draft facts to one with an unknown move.
  expect(factsOfMon({ ...M(), moves: [33, 9999], pp: [35, 5], ppUps: [3, 3] }, data).moves)
    .toEqual([{ id: 33, pp: 35, maxPp: 56, known: true }, { id: 9999, pp: 5, maxPp: 0, known: false }]);
  // The page's facts (factsOf over the box JSON) are the server's for every draftable Pokémon.
  const options: DraftOptionsJson = { items: draftItems(data), growth: data.rom.growth };
  const draftable = state.json.mons.filter((m) => m.draft !== null);
  expect(draftable.map((m) => m.ref)).toEqual(['party:1', 'party:2', 'box:1:1']);
  for (const m of draftable) expect(factsOf(m, options), m.ref).toEqual(factsOfMon(pool.get(m.ref)!, data));
});

it('draftItems: every item the data names, plus the hack\'s four (the engine\'s) and the EXP items, each once, sorted by name', () => {
  expect([[42, 54, 70, 71].map(itemId), [...HACK_HELD_ITEMS]])
    .toEqual([['lavacookie', 'oldgateau', 'shoalsalt', 'shoalshell'], [[42, 'Lava Cookie'], [54, 'Old Gateau'], [70, 'Shoal Salt'], [71, 'Shoal Shell']]]);
  const full = serverData();
  full.rom.items = fixture.data.rom.items;   // ids 0 to 467, as the real ROM has them
  const items = draftItems(full);
  const names = items.map((item) => item.name);
  const ids = items.map((item) => item.id);
  // 120 is an unused Gen 3 leftover the data cannot name.
  expect([ids.includes(217), ids.includes(120), ids.filter((id) => id === 42).length, names.some((name) => name.startsWith('('))]).toEqual([true, false, 1, false]);
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
  for (const list of [draftItems(data), items]) {
    expect(list.filter((item) => item.id === 216 || item.id === 231)).toEqual([{ id: 216, name: 'Exp. Share' }, { id: 231, name: 'Lucky Egg' }]);
  }
});
