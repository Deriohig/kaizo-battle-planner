import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_TURN, newPlan, resolve, type Plan, type PlanMon, type PlanStart, type PlanTurn } from '../../../web/src/plan';
import {
  ALL_YOURS_FAINTED, NOTE_EXCERPT, planComplete, planCurrentKey, planSavedKey, planText, readCurrentPlan, readCurrentPlanText,
  readSavedPlans, refoundPlan, toPlanRecord, turnRows, turnText, writeCurrentPlan, writeCurrentPlanText, writeSavedPlans,
  type PlanRecord, type SavedPlan,
} from '../../../web/src/planStore';
import { box, mon, TRISTAN } from './stubServer';

const BLAZE: PlanMon = { key: 'key-party:1', ref: 'party:1', name: 'Blaze (Monferno)', entry: { ref: 'party:1' } };
const STARLY: PlanMon = { key: 'key-party:2', ref: 'party:2', name: 'Starly', entry: { ref: 'party:2' } };
const START: PlanStart = { trainerId: TRISTAN, variant: 0, world: 0, mons: [BLAZE, STARLY], lead: BLAZE.key, enemies: ['Imp', 'Mouse', 'Gloom'] };
const turn = (over: Partial<PlanTurn> = {}): PlanTurn => ({ ...EMPTY_TURN, fainted: {}, sendIn: {}, field: {}, ...over });
const plan = (turns: PlanTurn[], over: Partial<Plan> = {}): Plan => ({ ...newPlan(START), turns, ...over });
const record = (p: Plan = plan([turn()])): PlanRecord => ({ v: 1, save: { savePath: '/a.dsv', savedAt: '2026-06-12T12:00:00.000Z' }, plan: p });
/** A record as plain JSON, to break. */
const raw = (rec: PlanRecord = record()) => JSON.parse(JSON.stringify(rec)) as Record<string, any>;
const NOTE = 'Watch for Quick Attack here, it outspeeds\nsecond line';
const TRIED = turn({
  mine: 'key-box:1:4', pick: { kind: 'move', by: 'key-box:1:4', slot: 2, name: 'Surf' },
  before: { mine: STARLY.key, pick: { kind: 'move', by: STARLY.key, slot: 0, name: 'Peck' }, fainted: STARLY.key, sendIn: BLAZE.key, added: ['key-box:1:4'] },
});

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('what is kept', () => {
  it.each<[string, Plan]>([
    ['picks, notes, a cursor and the weather', plan([turn({ pick: { kind: 'move', by: BLAZE.key, slot: 0, name: 'Scratch' }, note: 'n', mine: BLAZE.key }), turn()], { cursor: 1, note: 'fight', weather0: 'rain' })],
    ["the battle start's stages", plan([turn()], { stages0: { player: { atk: -1 }, enemy: {} } })],
    ["the start's Trick Room", plan([turn()], { trickRoom0: true })],
    ['no Trick Room at the start', plan([turn()], { trickRoom0: false })],
    ['a try not yet kept, with what its turn had before', plan([turn(), TRIED, turn({ mine: STARLY.key, before: { pick: null } })], { cursor: 1 })],
  ])('a plan with %s round-trips', (_, p) => {
    writeCurrentPlan(TRISTAN, 0, record(p));
    expect(readCurrentPlan(TRISTAN, 0)).toEqual(record(p));
    expect(localStorage.getItem('pkp.plan.current.roark-split/youngster-tristan/1.0')).not.toBeNull();
  });

  it('keys by trainer and copy', () => {
    expect(planCurrentKey(TRISTAN, 0)).toBe('pkp.plan.current.roark-split/youngster-tristan/1.0');
    expect(planSavedKey(TRISTAN, 1)).toBe('pkp.plan.saved.roark-split/youngster-tristan/1.1');
    expect(readCurrentPlan(TRISTAN, 1)).toBeNull();
  });

  it('junk reads as no plan, and a cursor past the end is clamped', () => {
    const good = raw();
    const startWith = (over: object) => ({ ...good, plan: { ...good.plan, start: { ...good.plan.start, ...over } } });
    const lineRecord = { save: null, start: { trainerId: TRISTAN, variant: 0, world: 0, team: [], draft: [] }, path: [], others: [] };
    for (const value of [
      lineRecord, { ...good, plan: { ...good.plan, turns: [] } }, startWith({ mons: [BLAZE, { ...STARLY, key: BLAZE.key }] }),
      startWith({ mons: [{ ...BLAZE, entry: { ref: 'party:9' } }] }), { ...good, plan: { ...good.plan, weather0: 'fog' } },
      { ...good, plan: { ...good.plan, turns: Array.from({ length: 201 }, () => good.plan.turns[0]) } },
    ].map((v) => JSON.stringify(v)).concat(['{', '[]', '{"v":2}'])) {
      localStorage.setItem(planCurrentKey(TRISTAN, 0), value);
      expect(readCurrentPlan(TRISTAN, 0), value.slice(0, 30)).toBeNull();
    }
    localStorage.setItem(planCurrentKey(TRISTAN, 0), JSON.stringify({ ...good, plan: { ...good.plan, turns: [good.plan.turns[0], good.plan.turns[0]], cursor: 99 } }));
    expect(readCurrentPlan(TRISTAN, 0)?.plan.cursor).toBe(1);
  });

  it.each<[string, unknown[]]>([
    ['stages0', [null, 'x', { player: { atk: -1 } }, { player: { atk: 'x' }, enemy: {} }, { player: { atk: 7 }, enemy: {} }, { player: { hp: 1 }, enemy: {} }]],
    ['trickRoom0', [null, 'yes', 1]],
  ])('a bad %s is dropped (learned again), not the plan', (field, values) => {
    for (const value of values) {
      const read = toPlanRecord({ ...raw(), plan: { ...raw().plan, [field]: value } });
      expect(read, JSON.stringify(value)).not.toBeNull();
      expect(field in read!.plan, JSON.stringify(value)).toBe(false);
    }
  });

  it("a bad try makes the plan unreadable, never kept; so does one without the turn's own Pokémon", () => {
    const good = raw(record(plan([turn(), TRIED], { cursor: 1 })));
    const withBefore = (before: unknown) => ({ ...good, plan: { ...good.plan, turns: [good.plan.turns[0], { ...good.plan.turns[1], before }] } });
    for (const before of [null, 'x', [], {}, { pick: 'Surf' }, { pick: null, mine: 3 }, { pick: null, fainted: false }, { pick: null, sendIn: 1 }, { pick: null, added: 'key-box:1:4' }, { pick: null, added: [1] }]) {
      expect(toPlanRecord(withBefore(before)), JSON.stringify(before)).toBeNull();
    }
    const noMine = withBefore({ pick: null });
    delete noMine.plan.turns[1].mine;
    expect(toPlanRecord(noMine)).toBeNull();
  });

  it('unknown keys are dropped and a bad save reads as null', () => {
    const read = toPlanRecord({ ...record(), extra: 1, save: ['x'], plan: { ...record().plan, junk: true } });
    expect(read!.save).toBeNull();
    expect(Object.keys(read!).sort()).toEqual(['plan', 'save', 'v']);
    expect(Object.keys(read!.plan).sort()).toEqual(['cursor', 'note', 'start', 'turns', 'weather0']);
  });

  it("the stored bytes come back exactly, and the tree's keys are never touched", () => {
    const treeKeys = [`pkp.tree.current.${TRISTAN}.0`, `pkp.tree.saved.${TRISTAN}.0`];
    for (const k of treeKeys) localStorage.setItem(k, 'KEEP');
    const key = planCurrentKey(TRISTAN, 0);
    const odd = '{"v":1, "odd":  "spacing"}';
    localStorage.setItem(key, odd);
    writeCurrentPlanText(TRISTAN, 0, readCurrentPlanText(TRISTAN, 0));
    expect(localStorage.getItem(key)).toBe(odd);
    writeCurrentPlanText(TRISTAN, 0, null);
    expect([localStorage.getItem(key), readCurrentPlanText(TRISTAN, 0)]).toEqual([null, null]);
    writeCurrentPlan(TRISTAN, 0, record());
    writeCurrentPlan(TRISTAN, 0, null);
    writeSavedPlans(TRISTAN, 0, [{ name: 'a', ...record() }]);
    writeSavedPlans(TRISTAN, 0, []);
    for (const k of treeKeys) expect(localStorage.getItem(k)).toBe('KEEP');
  });

  it('storage that throws keeps nothing and breaks nothing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    expect(() => writeCurrentPlan(TRISTAN, 0, record())).not.toThrow();
    expect(() => writeCurrentPlanText(TRISTAN, 0, 'x')).not.toThrow();
    expect(() => writeSavedPlans(TRISTAN, 0, [{ name: 'a', ...record() }])).not.toThrow();
    vi.restoreAllMocks();
    expect(readCurrentPlan(TRISTAN, 0)).toBeNull();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('no'); });
    expect([readCurrentPlan(TRISTAN, 0), readSavedPlans(TRISTAN, 0), readCurrentPlanText(TRISTAN, 0)]).toEqual([null, [], null]);
  });

  it('saved copies are read in order, a nameless one left out, and an empty list deleted', () => {
    const a: SavedPlan = { name: 'first', ...record() };
    const b: SavedPlan = { name: 'second', ...record(plan([turn(), turn()])) };
    writeSavedPlans(TRISTAN, 0, [a, b]);
    expect(readSavedPlans(TRISTAN, 0)).toEqual([a, b]);
    const { name: _name, ...nameless } = a;
    localStorage.setItem(planSavedKey(TRISTAN, 0), JSON.stringify([nameless, b]));
    expect(readSavedPlans(TRISTAN, 0).map((p) => p.name)).toEqual(['second']);
    writeSavedPlans(TRISTAN, 0, []);
    expect(localStorage.getItem(planSavedKey(TRISTAN, 0))).toBeNull();
  });
});

it('a plan on another save follows its Pokémon by key, and says who is missing', () => {
  const blaze = mon('party:2', { key: 'key-party:1', nickname: 'Blaze', species: 'Monferno' });
  const out = refoundPlan(box({ mons: [blaze, mon('box:1:1', { key: 'key-party:2' })] }), null, record());
  expect(out.missing).toEqual([]);
  expect(out.record.plan.start.mons.map((m) => [m.key, m.ref, m.entry.ref, m.name])).toEqual([
    [BLAZE.key, 'party:2', 'party:2', 'Blaze (Monferno)'], [STARLY.key, 'box:1:1', 'box:1:1', 'Starly'],
  ]);
  expect(out.record.plan.start.lead).toBe(BLAZE.key);
  const lost = refoundPlan(box({ mons: [blaze] }), null, record());
  expect([lost.record.plan.start.mons.length, lost.missing]).toEqual([1, ['Starly']]);
  expect(() => resolve(lost.record.plan)).not.toThrow();
  const none = refoundPlan(box({ mons: [] }), null, record());
  expect([none.record.plan.start.mons, none.missing]).toEqual([[], ['Blaze (Monferno)', 'Starly']]);
});

describe('the rows and the copied text', () => {
  const p = plan([turn({ pick: { kind: 'move', by: BLAZE.key, slot: 0, name: 'Scratch' }, fainted: { theirs: 0 }, note: NOTE }), turn()]);
  const cut = NOTE.split('\n')[0]!.slice(0, NOTE_EXCERPT);
  const firstRow = (t: PlanTurn) => turnRows(plan([t]))[0]!;

  it('rows say who, what, what fainted and the note, whole and as an excerpt', () => {
    const rows = turnRows(p);
    expect(rows[0]).toMatchObject({ mine: 'Blaze (Monferno)', theirs: 'Imp', pick: 'Scratch', fainted: ['Imp fainted'], current: true, note: NOTE, excerpt: `${cut}…` });
    expect(rows[1]).toMatchObject({ theirs: 'Mouse', pick: null, current: false });
    expect(firstRow(turn({ pick: { kind: 'switch', by: BLAZE.key, to: STARLY.key } })).pick).toBe('switch to Starly');
    expect(firstRow(turn({ fainted: { mine: BLAZE.key, theirs: 0 } })).fainted).toEqual(['Blaze (Monferno) fainted', 'Imp fainted']);
    expect(['ten chars!', '\n\nlate', 'short\nmore', '  \n '].map((note) => firstRow(turn({ note })).excerpt)).toEqual(['ten chars!', 'late', 'short…', '']);
    expect(turnText(rows[0]!)).toBe(`T1 · Blaze (Monferno): Scratch · Imp fainted · ${cut}…`);
    expect(turnText(rows[0]!, false)).toBe('T1 · Blaze (Monferno): Scratch · Imp fainted');
    expect(turnText(rows[1]!)).toBe('T2 · Blaze (Monferno)');
  });

  it('the plan copies as text with its notes, the copy named when there are two, and either end sentence', () => {
    const text = planText({ trainer: 'Youngster Tristan', copies: 1 }, { ...p, note: 'Lead with Blaze.' });
    const lines = text.split('\n');
    expect(lines.slice(0, 2)).toEqual(['Youngster Tristan — Blaze (Monferno), Starly', 'Lead with Blaze.']);
    for (const line of ['T1 · Blaze (Monferno): Scratch · Imp fainted', '  Watch for Quick Attack here, it outspeeds', '  second line']) expect(lines).toContain(line);
    expect(text).not.toMatch(/%|Plan complete/);
    expect(planText({ trainer: 'Youngster Tristan', copies: 2 }, p).split('\n')[0]).toBe('Youngster Tristan (copy 1) — Blaze (Monferno), Starly');
    expect(planText({ trainer: 'Youngster Tristan', copies: 2 }, { ...p, start: { ...START, variant: 1 } }).split('\n')[0]).toContain('(copy 2)');
    const last = (t: Plan) => planText({ trainer: 'Youngster Tristan', copies: 1 }, t).split('\n').at(-1);
    expect(last(plan([turn({ fainted: { theirs: 0 } }), turn({ fainted: { theirs: 1 } }), turn({ fainted: { theirs: 2 } })]))).toBe(planComplete('Youngster Tristan'));
    expect(planComplete('X')).toBe("Plan complete: all of X's Pokémon marked fainted.");
    expect(last(plan([turn({ fainted: { mine: BLAZE.key }, sendIn: { mine: STARLY.key } }), turn({ fainted: { mine: STARLY.key } })]))).toBe(ALL_YOURS_FAINTED);
  });
});
