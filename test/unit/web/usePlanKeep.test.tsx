// usePlan: a kept plan opens again (on its own save or another), the team as it is now, Clear plan with Undo, and named
// copies. The same setup as usePlan.test.tsx: the real client against the fake plan-step route (planServer.ts).

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postPlanStep } from '../../../web/src/api';
import { defaultField, type PlanMon, type PlanStart } from '../../../web/src/plan';
import { planCurrentKey, planSavedKey, readCurrentPlan, readSavedPlans, toPlanRecord, type PlanRecord } from '../../../web/src/planStore';
import { usePlan, type UsePlan } from '../../../web/src/usePlan';
import { planServer } from './planServer';
import { box, mon, stubFetch, TRISTAN } from './stubServer';

const BLAZE: PlanMon = { key: 'key-party:1', ref: 'party:1', name: 'Blaze (Monferno)', entry: { ref: 'party:1' } };
const STARLY: PlanMon = { key: 'key-party:2', ref: 'party:2', name: 'Starly', entry: { ref: 'party:2' } };
const START: PlanStart = { trainerId: TRISTAN, variant: 0, world: 0, mons: [BLAZE, STARLY], lead: BLAZE.key, enemies: ['Imp', 'Mouse', 'Gloom'] };
const OTHER: PlanStart = { ...START, mons: [STARLY, BLAZE], lead: STARLY.key };
const SAVE = { savePath: box().savePath, savedAt: box().savedAt };
const LATER = '2026-11-11T09:30:00.000Z';
const later = { savePath: SAVE.savePath, savedAt: LATER };
const KEY = planCurrentKey(TRISTAN, 0);
const SAVED_KEY = planSavedKey(TRISTAN, 0);
const GONE = "None of this plan's Pokémon are in this save, so it was not opened.";
const STARLY_GONE = 'Your save changed since this plan was written. Not in this save: Starly.';

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
/** The stored text with odd spacing, so a rewrite (any JSON.stringify) would show. */
const odd = (value: unknown): string => JSON.stringify(value, null, 3).replace(/\n/g, '\n ');
const kept = () => readCurrentPlan(TRISTAN, 0);
const names = (p: UsePlan) => p.saved.map((s) => s.name);
/** Blaze alone, now at party:3, on a later save. */
const blazeMoved = () => box({ savedAt: LATER, mons: [mon('party:3', { key: 'key-party:1', nickname: 'Blaze', species: 'Monferno' })] });

function setup() {
  const server = planServer();
  stubFetch(server.routes);
  const { result, unmount } = renderHook(() => usePlan({ step: postPlanStep }));
  return { server, result, unmount, last: () => server.requests().at(-1)! };
}
async function begun(start = START) {
  const s = setup();
  await act(() => s.result.current.begin(start, SAVE));
  return s;
}
/** Three turns, each with a note, a fight note, rocks set on turn 2, the cursor on turn 2. */
async function threeTurns(result: { current: UsePlan }) {
  act(() => result.current.setNote('one'));
  await act(() => result.current.nextTurn());
  act(() => result.current.setNote('two'));
  await act(() => result.current.setField({ ...defaultField('sand'), rocks: { player: true, enemy: false } }));
  await act(() => result.current.nextTurn());
  act(() => result.current.setNote('three'));
  act(() => result.current.setFightNote('the whole fight'));
  await act(() => result.current.goTo(2));
}
/** A kept plan on SAVE whose turn 1 switches Blaze out to Starly, then a turn 2. */
async function switchRecord(): Promise<PlanRecord> {
  const { result, unmount } = await begun();
  act(() => result.current.pick({ kind: 'switch', to: STARLY.key }));
  await act(() => result.current.nextTurn());
  await act(() => result.current.goTo(1));
  const rec = kept()!;
  unmount();
  return rec;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('usePlan: kept plans', () => {
  it('a kept plan comes back with its cursor, notes and field, and asks only for the turn shown', async () => {
    const first = await begun();
    await threeTurns(first.result);
    const rec = kept()!;
    first.unmount();
    const { result, server } = setup();
    await act(() => result.current.restore(rec, box()));
    expect(result.current.turns).toHaveLength(3);
    expect(result.current).toMatchObject({ current: { turn: 2, field: { rocks: { player: true } } }, fightNote: 'the whole fight', arrival: null, notice: null, save: SAVE });
    expect(result.current.rows.map((r) => r.note)).toEqual(['one', 'two', 'three']);
    expect(result.current.plan?.turns[1]?.field).toEqual(rec.plan.turns[1]!.field);
    expect(server.requests()).toHaveLength(1);
    expect(result.current.answer).not.toBeNull();
    await act(() => result.current.restore(rec, box(), null, 'open'));
    expect(result.current.arrival?.kind).toBe('open');
  });

  it('restore writes nothing, not even what its answer teaches, until his next action', async () => {
    const { unmount } = await begun();
    const stored = kept()!;
    unmount();
    const text = odd({ ...stored, plan: { ...stored.plan, weather0: null } });   // so the first answer teaches it
    localStorage.setItem(KEY, text);
    const { result } = setup();
    await act(() => result.current.restore(toPlanRecord(JSON.parse(text))!, box()));
    await flush();
    expect(result.current.plan?.weather0).toBe('sand');          // learned on the page ...
    expect(localStorage.getItem(KEY)).toBe(text);                // ... and not written
    act(() => result.current.setNote('mine now'));
    expect(kept()?.plan).toMatchObject({ weather0: 'sand', turns: [{ note: 'mine now' }] });
  });

  it('on another save a plan follows its Pokémon and says who is gone, and keeps it there only from his next action', async () => {
    const rec = await switchRecord();
    const { result, last } = setup();
    await act(() => result.current.restore(rec, blazeMoved()));
    expect(last().team).toEqual(['party:3']);
    expect(result.current.plan?.start.mons).toHaveLength(1);
    expect(result.current).toMatchObject({ save: { savedAt: LATER }, notice: STARLY_GONE });
    expect(result.current.turns[0]?.pick).toBeNull();            // the switch to Starly
    expect(kept()?.save).toEqual(SAVE);
    await act(() => result.current.goTo(2));
    expect(result.current.current?.mine).toBe(BLAZE.key);
    expect(kept()?.save?.savedAt).toBe(LATER);
    expect(kept()?.plan.start.mons.map((m) => m.ref)).toEqual(['party:3']);
  });

  it('a plan with none of its Pokémon in the save is not opened, and a plan on the page stays as it was', async () => {
    const rec = await switchRecord();
    const before = localStorage.getItem(KEY);
    const { result, server } = setup();
    await act(() => result.current.restore(rec, box({ savedAt: LATER, mons: [mon('party:1', { key: 'key-someone-else' })] })));
    expect(result.current).toMatchObject({ plan: null, notice: GONE });
    expect(server.requests()).toHaveLength(0);
    expect(localStorage.getItem(KEY)).toBe(before);
    await act(() => result.current.begin(OTHER, SAVE));
    const shown = result.current.plan;
    await act(() => result.current.restore(rec, box({ savedAt: LATER, mons: [] })));
    expect(result.current.plan).toBe(shown);
    expect(result.current.notice).toBe(GONE);
  });

  it('setMons takes the team as it is now and keeps a Pokémon a turn still names', async () => {
    const { result, last } = await begun();
    await act(() => result.current.nextTurn());
    act(() => result.current.pick({ kind: 'switch', to: STARLY.key }));
    await act(() => result.current.setMons([{ ...BLAZE, entry: { ref: 'party:1', level: 16 } }], later, box({ savedAt: LATER })));
    expect(last().draft[0]?.level).toBe(16);
    expect(result.current.plan?.start.mons.map((m) => m.key)).toEqual([BLAZE.key, STARLY.key]);
    expect(result.current.save).toEqual(later);
    expect(kept()).toMatchObject({ save: later, plan: { start: { mons: [{ entry: { level: 16 } }, {}] } } });
    act(() => result.current.pick(null));                       // now no turn names Starly: it leaves the pool
    await act(() => result.current.setMons([BLAZE]));
    expect(result.current.plan?.start.mons.map((m) => m.key)).toEqual([BLAZE.key]);
    expect(result.current.save).toEqual(later);
  });
});

describe('usePlan: a save change while a plan is open', () => {
  const blazeAt1 = mon('party:1', { key: BLAZE.key, nickname: 'Blaze', species: 'Monferno' });
  const NEWCOMER: PlanMon = { key: 'key-newcomer', ref: 'party:2', name: 'Shinx', entry: { ref: 'party:2' } };
  /** Turn 2 switches Blaze out to Starly, so a turn names Starly. */
  async function starlyNamed() {
    const s = await begun();
    await act(() => s.result.current.nextTurn());
    act(() => s.result.current.pick({ kind: 'switch', to: STARLY.key }));
    await act(() => s.result.current.nextTurn());
    return { ...s, seen: s.server.requests().length };
  }
  const asked = (s: Awaited<ReturnType<typeof starlyNamed>>) => s.server.requests().slice(s.seen).map((r) => r.team);

  it('a Pokémon a turn names is found again by key over the box, never kept at its old ref', async () => {
    const s = await starlyNamed();
    // Starly was put in the box and saved; another Pokémon now sits at party:2, on the team.
    const moved = box({ savedAt: LATER, mons: [blazeAt1, mon('party:2', { key: NEWCOMER.key, species: 'Shinx', nickname: 'SHINX' }), mon('box:1:1', { key: STARLY.key })] });
    await act(() => s.result.current.setMons([BLAZE, NEWCOMER], later, moved));
    const pool = s.result.current.plan!.start.mons;
    expect(pool.map((m) => [m.key, m.ref, m.entry.ref])).toEqual([[BLAZE.key, 'party:1', 'party:1'], [NEWCOMER.key, 'party:2', 'party:2'], [STARLY.key, 'box:1:1', 'box:1:1']]);
    expect(s.result.current.notice).toBeNull();
    for (const team of asked(s)) expect(new Set(team).size, team.join()).toBe(team.length);
    expect(kept()?.save).toEqual(later);                            // a reload finds it as it is
    expect(kept()?.plan.start.mons.map((m) => m.ref)).toEqual(['party:1', 'party:2', 'box:1:1']);
    await act(() => s.result.current.goTo(3));
    expect(s.result.current.current?.mine).toBe(STARLY.key);
    expect(s.server.requests().at(-1)!.team[0]).toBe('box:1:1');
  });

  it.each<[string, () => [PlanMon[], typeof later, ReturnType<typeof box>?], string]>([
    ['not in the box', () => [[BLAZE], later, box({ savedAt: LATER, mons: [blazeAt1] })], STARLY_GONE],
    ['with no box to look in', () => [[BLAZE], later], 'Your save changed since this plan was written. Not on your team now: Starly.'],
  ])('one %s leaves the pool and is named; its turns stay as written', async (_, args, notice) => {
    const s = await starlyNamed();
    await act(() => s.result.current.setMons(...args()));
    expect(s.result.current.plan?.start.mons.map((m) => m.key)).toEqual([BLAZE.key]);
    expect(s.result.current.notice).toBe(notice);
    expect(s.result.current.plan?.turns[1]?.pick).toEqual({ kind: 'switch', by: BLAZE.key, to: STARLY.key });
    for (const team of asked(s)) expect(team).not.toContain('party:2');
  });

  it('on the same save a named Pokémon keeps its ref, and nothing is said', async () => {
    const { result } = await starlyNamed();
    await act(() => result.current.setMons([BLAZE], SAVE));
    expect(result.current.plan?.start.mons.map((m) => [m.key, m.ref])).toEqual([[BLAZE.key, 'party:1'], [STARLY.key, 'party:2']]);
    expect(result.current.notice).toBeNull();
  });
});

describe('usePlan: Start never overwrites a kept plan that was not opened', () => {
  it('a kept plan on another save moves to Saved plans as "Before save change", notes and all, never replacing a name', async () => {
    const first = await begun();
    act(() => first.result.current.setNote('turn one note'));
    act(() => first.result.current.setFightNote('fight note'));
    const old = JSON.parse(localStorage.getItem(KEY)!) as Record<string, unknown>;
    first.unmount();

    const { result } = setup();
    await act(() => result.current.restore(toPlanRecord(old)!, box({ savedAt: LATER, mons: [mon('party:1', { key: 'key-someone-else' })] })));
    expect(result.current.notice).toBe(GONE);
    const someone: PlanMon = { key: 'key-someone-else', ref: 'party:1', name: 'Starly', entry: { ref: 'party:1' } };
    await act(() => result.current.begin({ ...START, mons: [someone], lead: someone.key }, later));
    expect([result.current.plan?.start.lead, kept()?.plan.start.lead]).toEqual([someone.key, someone.key]);
    const copies = readSavedPlans(TRISTAN, 0);
    expect(copies.map((c) => c.name)).toEqual(['Before save change']);
    expect(copies[0]).toMatchObject({ save: SAVE, plan: { note: 'fight note', turns: [{ note: 'turn one note' }] } });
    expect(names(result.current)).toEqual(['Before save change']);
    expect(result.current.notice).toBe('The plan kept for this fight was not opened, so it is in Saved plans as "Before save change".');
    // Again, with another note: the name in use is not replaced, the new copy takes the next free one.
    act(() => result.current.reset());
    localStorage.setItem(KEY, JSON.stringify({ ...old, plan: { ...(old.plan as object), note: 'another fight note' } }));
    await act(() => result.current.begin(START, later));
    expect(readSavedPlans(TRISTAN, 0).map((c) => c.name)).toEqual(['Before save change', 'Before save change (2)']);
  });

  it('a kept record the page cannot read is kept in Saved plans exactly as it was, and counted', async () => {
    localStorage.setItem(KEY, '{ not a plan');
    const { result } = setup();
    await act(() => result.current.begin(START, SAVE));
    expect(kept()?.plan.start).toEqual(START);
    expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toMatchObject([{ kept: '{ not a plan' }]);
    expect(result.current).toMatchObject({ savedSkipped: 1, notice: 'The plan kept for this fight could not be read. It is kept as it was, but Saved plans cannot list it.' });
  });

  it('Start over the plan on the page moves nothing', async () => {
    const { result } = await begun();
    await act(() => result.current.begin(OTHER, SAVE));
    expect(localStorage.getItem(SAVED_KEY)).toBeNull();
    expect(result.current.notice).toBeNull();
  });

  it('when the copy cannot be written, the kept plan is not overwritten', async () => {
    const { unmount } = await begun();
    const before = localStorage.getItem(KEY);
    unmount();
    const { result } = setup();
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === SAVED_KEY) throw new Error('QuotaExceededError');
      real.call(this, key, value);
    });
    await act(() => result.current.begin(OTHER, later));
    vi.restoreAllMocks();
    expect(localStorage.getItem(KEY)).toBe(before);
    expect(result.current).toMatchObject({ plan: null, notice: 'The plan kept for this fight could not be moved to Saved plans, so no new plan was started.' });
  });
});

describe('usePlan: Clear plan and Undo', () => {
  it('Clear plan, then Undo, leaves the page and the storage as they were', async () => {
    const { result } = await begun();
    await threeTurns(result);
    const text = odd(JSON.parse(localStorage.getItem(KEY)!));
    localStorage.setItem(KEY, text);
    const notes = result.current.rows.map((r) => r.note);
    act(() => result.current.clear());
    expect(result.current).toMatchObject({ plan: null, cleared: 3, rows: [], fightNote: '' });
    expect(localStorage.getItem(KEY)).toBeNull();
    await act(() => result.current.undo());
    expect(result.current.turns).toHaveLength(3);
    expect(result.current).toMatchObject({ current: { turn: 2 }, cleared: null, fightNote: 'the whole fight', arrival: { kind: 'turn' }, save: SAVE });
    expect(localStorage.getItem(KEY)).toBe(text);
    expect(result.current.rows.map((r) => r.note)).toEqual(notes);
  });

  it('Undo puts back the notice, and a failure shown before Clear plan does not come back with it', async () => {
    const rec = await switchRecord();
    const { result, server } = setup();
    await act(() => result.current.restore(rec, blazeMoved()));
    expect(result.current.notice).toBe(STARLY_GONE);
    server.gate.fail = { status: 500, json: { error: 'boom' } };
    await act(() => result.current.nextTurn());
    expect(result.current.failure).not.toBeNull();
    act(() => result.current.clear());
    expect(result.current.notice).toBeNull();
    await act(() => result.current.undo());
    expect(result.current).toMatchObject({ notice: STARLY_GONE, failure: null, draftProblem: null });
  });

  it('a late Undo never overwrites a newer plan, after Start, reset or a restore that opens', async () => {
    const { result } = await begun();
    await threeTurns(result);
    act(() => result.current.clear());
    const late = result.current.undo;
    await act(() => result.current.begin(OTHER, SAVE));
    const newer = localStorage.getItem(KEY);
    await act(() => late());
    expect(result.current.cleared).toBeNull();
    expect(result.current.plan?.start).toEqual(OTHER);
    expect(localStorage.getItem(KEY)).toBe(newer);

    act(() => result.current.clear());
    const late2 = result.current.undo;
    act(() => result.current.reset());
    await act(() => late2());
    expect(result.current).toMatchObject({ plan: null, cleared: null });
    expect(localStorage.getItem(KEY)).toBeNull();

    await act(() => result.current.begin(START, SAVE));
    const rec = kept()!;
    act(() => result.current.clear());
    const late3 = result.current.undo;
    await act(() => result.current.restore({ ...rec, plan: { ...rec.plan, start: OTHER } }, box()));
    await act(() => late3());
    expect(result.current.plan?.start).toEqual(OTHER);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('a restore that opens nothing leaves Undo on offer', async () => {
    const rec = await switchRecord();
    const { result } = await begun();
    act(() => result.current.clear());
    await act(() => result.current.restore(rec, box({ savedAt: LATER, mons: [] })));
    expect(result.current.cleared).toBe(1);
    await act(() => result.current.undo());
    expect(result.current.plan?.start).toEqual(START);
  });

  it("the tree's keys survive everything", async () => {
    const tree = { [`pkp.tree.current.${TRISTAN}.0`]: '{ "odd":  1 }', [`pkp.tree.saved.${TRISTAN}.0`]: '[ { "name" : "x" } ]' };
    for (const [key, value] of Object.entries(tree)) localStorage.setItem(key, value);
    const { result } = await begun();
    act(() => result.current.pick({ kind: 'move', slot: 0, name: 'Scratch' }));
    await act(() => result.current.nextTurn());
    act(() => result.current.clear());
    await act(() => result.current.undo());
    act(() => result.current.saveCopy('A'));
    act(() => result.current.removeSaved('A'));
    act(() => result.current.reset());
    for (const [key, value] of Object.entries(tree)) expect(localStorage.getItem(key)).toBe(value);
  });
});

describe('usePlan: named copies', () => {
  it('Save a copy names the plan, and never replaces one: a name in use takes the next free one', async () => {
    const { result } = await begun();
    expect(result.current.saved).toEqual([]);
    const save = (name: string) => {
      let as: string | null = null;
      act(() => { as = result.current.saveCopy(name); });
      return as;
    };
    expect(save(' Lead Blaze ')).toBe('Lead Blaze');
    expect(readSavedPlans(TRISTAN, 0)).toHaveLength(1);
    await act(() => result.current.nextTurn());
    expect(save('Lead Blaze')).toBe('Lead Blaze (2)');
    expect(result.current.saved.map((s) => [s.name, s.plan.turns.length])).toEqual([['Lead Blaze', 1], ['Lead Blaze (2)', 2]]);
    save('Second');
    save('Lead Blaze');
    expect(names(result.current)).toEqual(['Lead Blaze', 'Lead Blaze (2)', 'Second', 'Lead Blaze (3)']);
    expect(save('  ')).toBeNull();
    expect(result.current.saved).toHaveLength(4);
    for (const name of ['Second', 'Lead Blaze', 'Lead Blaze (2)', 'Lead Blaze (3)']) act(() => result.current.removeSaved(name));
    expect(result.current.saved).toEqual([]);
    expect(localStorage.getItem(SAVED_KEY)).toBeNull();

    save('Turn one');
    const copy = result.current.saved[0]!;
    await act(() => result.current.begin(OTHER, SAVE));
    expect(names(result.current)).toEqual(['Turn one']);   // read when a plan arrives
    await act(() => result.current.restore(copy, box(), null, 'open'));
    expect(result.current.plan?.start).toEqual(START);
    expect(result.current.turns).toHaveLength(2);
    act(() => result.current.reset());
    expect(result.current.saved).toEqual([]);
  });

  /** A plan with the saved copies `stored` beside it (and no kept plan left unopened, which a new start would copy). */
  async function withSaved(build: (copies: unknown[]) => unknown[], ...copyNames: string[]) {
    const { result: r0, unmount } = await begun();
    for (const name of copyNames) act(() => r0.current.saveCopy(name));
    const copies = JSON.parse(localStorage.getItem(SAVED_KEY)!) as unknown[];
    unmount();
    localStorage.setItem(SAVED_KEY, JSON.stringify(build(copies)));
    localStorage.removeItem(KEY);
    return { ...(await begun()), copies };
  }

  it('a saved copy that cannot be read is counted, said, and never dropped', async () => {
    const bad = { name: 'Broken', v: 1, plan: { start: 'nope' } };
    const { result } = await withSaved((good) => [bad, ...good, 7], 'Good');
    expect(names(result.current)).toEqual(['Good']);
    expect(result.current).toMatchObject({ savedSkipped: 2, savedProblem: '2 saved plans for this fight could not be read, so they are not listed.' });
    act(() => result.current.saveCopy('New'));
    act(() => result.current.saveCopy('Good'));
    const after = JSON.parse(localStorage.getItem(SAVED_KEY)!) as unknown[];
    expect(after).toHaveLength(5);   // the second "Good" is "Good (2)"
    expect([after[0], after[2]]).toEqual([bad, 7]);
    for (const name of ['Good', 'Good (2)', 'New']) act(() => result.current.removeSaved(name));
    expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toEqual([bad, 7]);
    expect(result.current.saved).toEqual([]);
    expect(result.current.savedSkipped).toBe(2);
    localStorage.setItem(SAVED_KEY, JSON.stringify([bad]));
    act(() => result.current.saveCopy('Again'));
    expect(result.current.savedProblem).toBe('1 saved plan for this fight could not be read, so it is not listed.');
    act(() => result.current.reset());
    expect(result.current).toMatchObject({ savedSkipped: 0, savedProblem: null });
  });

  it('Remove unreadable drops exactly the entries the count names, and leaves the rest byte for byte', async () => {
    const { result, copies: [one, two] } = await withSaved(([a, b]) => [{ v: 1 }, a, 'x', { ...(a as object), name: 3 }, b, null], 'One', 'Two');
    expect(names(result.current)).toEqual(['One', 'Two']);
    expect(result.current.savedSkipped).toBe(4);
    act(() => result.current.removeUnreadable());
    expect(localStorage.getItem(SAVED_KEY)).toBe(`[${JSON.stringify(one)},${JSON.stringify(two)}]`);
    expect(names(result.current)).toEqual(['One', 'Two']);
    expect(result.current).toMatchObject({ savedSkipped: 0, savedProblem: null });
    // A list left empty is deleted, and so is a stored value that is not a list at all (it counts as one).
    localStorage.setItem(SAVED_KEY, JSON.stringify([{ v: 1 }, 7]));
    act(() => result.current.saveCopy('  '));                   // does nothing, but nothing re-reads either
    act(() => result.current.removeSaved('nobody'));            // re-reads
    expect(result.current.savedSkipped).toBe(2);
    act(() => result.current.removeUnreadable());
    expect(localStorage.getItem(SAVED_KEY)).toBeNull();
    expect(result.current.savedSkipped).toBe(0);
    localStorage.setItem(SAVED_KEY, '{ not json');
    act(() => result.current.removeSaved('nobody'));
    expect(result.current.savedSkipped).toBe(1);
    act(() => result.current.removeUnreadable());
    expect(localStorage.getItem(SAVED_KEY)).toBeNull();
    expect(result.current.savedProblem).toBeNull();
  });

  it('storage that refuses does not stop the plan', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    const { result } = setup();
    await act(() => result.current.begin(START, SAVE));
    act(() => result.current.pick({ kind: 'move', slot: 0, name: 'Scratch' }));
    await act(() => result.current.nextTurn());
    expect(result.current.turns).toHaveLength(2);
    act(() => result.current.saveCopy('Kept?'));
    expect(result.current.saved).toEqual([]);
    act(() => result.current.clear());
    expect(result.current.plan).toBeNull();
    await act(() => result.current.undo());
    expect(result.current.turns).toHaveLength(2);
    expect(result.current.turns[0]?.pick?.kind).toBe('move');
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
