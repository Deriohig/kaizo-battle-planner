// usePlan: the last numbers stay on screen while new ones are worked out (`stale`), a tried Pokémon is named with who it
// replaced (`tried`, `carriedMine`), and the last turn can be removed (`removeLastTurn`, `withoutLastTurn`) with one Undo
// that puts the turn and its note back. The real client against the fake plan-step route (planServer.ts).

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postPlanStep } from '../../../web/src/api';
import { carriedMine, defaultField, newPlan, stepRequest, withoutLastTurn, type Plan, type PlanMon, type PlanStart } from '../../../web/src/plan';
import { planCurrentKey, readCurrentPlan, toPlanRecord } from '../../../web/src/planStore';
import type { PlanFieldJson } from '../../../web/src/planTypes';
import { FIELD_DEBOUNCE_MS, usePlan, type UsePlan } from '../../../web/src/usePlan';
import { planServer } from './planServer';
import { box, stubFetch, TRISTAN } from './stubServer';

const BLAZE: PlanMon = { key: 'key-party:1', ref: 'party:1', name: 'Blaze (Monferno)', entry: { ref: 'party:1' } };
const STARLY: PlanMon = { key: 'key-party:2', ref: 'party:2', name: 'Starly', entry: { ref: 'party:2' } };
const BIG: PlanMon = { key: 'key-box:1:4', ref: 'box:1:4', name: 'Big (Bibarel)', entry: { ref: 'box:1:4', level: 16 } };
const START: PlanStart = { trainerId: TRISTAN, variant: 0, world: 0, mons: [BLAZE, STARLY], lead: BLAZE.key, enemies: ['Imp', 'Mouse', 'Gloom'] };
const OTHER: PlanStart = { ...START, mons: [STARLY, BLAZE], lead: STARLY.key };
const SAVE = { savePath: box().savePath, savedAt: box().savedAt };
const KEY = planCurrentKey(TRISTAN, 0);
const rocksOn: PlanFieldJson = { ...defaultField('sand'), rocks: { player: true, enemy: false } };
const TRIED_BIG = { key: BIG.key, previous: BLAZE.key };

const kept = () => readCurrentPlan(TRISTAN, 0)!;
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
const debounced = () => act(async () => { await new Promise((r) => setTimeout(r, FIELD_DEBOUNCE_MS)); });
/** The stored text with odd spacing, so a rewrite (any JSON.stringify) would show. */
const odd = (value: unknown): string => JSON.stringify(value, null, 3).replace(/\n/g, '\n ');
const notes = (p: UsePlan) => p.rows.map((r) => r.note);
const keys = (p: UsePlan) => p.plan?.start.mons.map((m) => m.key);

function setup() {
  const server = planServer();
  stubFetch(server.routes);
  const { result, unmount } = renderHook(() => usePlan({ step: postPlanStep }));
  return { server, result, unmount };
}
async function begun(start = START) {
  const s = setup();
  await act(() => s.result.current.begin(start, SAVE));
  return s;
}
/** Holds the route's next answer until `release()`. */
function holdNext(server: ReturnType<typeof planServer>): () => void {
  let release!: () => void;
  server.gate.hold = new Promise<void>((r) => { release = r; });
  return () => release();
}
/** Three turns with notes 'one', 'two', 'three', the cursor on turn 3, and the stored text made odd so a rewrite shows. */
async function threeTurns(result: { current: UsePlan }): Promise<string> {
  act(() => result.current.setNote('one'));
  await act(() => result.current.nextTurn());
  act(() => result.current.setNote('two'));
  await act(() => result.current.setField(rocksOn));
  await act(() => result.current.nextTurn());
  act(() => result.current.setNote('three'));
  const text = odd(JSON.parse(localStorage.getItem(KEY)!));
  localStorage.setItem(KEY, text);
  return text;
}
/** Three turns with the last removed. */
async function cut() {
  const s = await begun();
  const text = await threeTurns(s.result);
  await act(() => s.result.current.removeLastTurn());
  return { ...s, text };
}
/** A plan with `n` blank turns, the cursor on `cursor`. */
function planOf(n: number, cursor: number): Plan {
  const p = newPlan(START);
  const turns = Array.from({ length: n }, (_, i) => ({ ...p.turns[0]!, fainted: {}, sendIn: {}, field: {}, note: `n${i + 1}` }));
  return { ...p, turns, cursor };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('usePlan: the last numbers stay on screen', () => {
  it('the last answer stays while new numbers are worked out, and only while no answer is shown', async () => {
    const { result, server } = await begun();
    const shown = result.current.answer!;
    expect(result.current.stale).toBeNull();
    const release = holdNext(server);
    act(() => { void result.current.setField(rocksOn); });
    await debounced();
    expect(result.current).toMatchObject({ busy: true, answer: null, stale: shown });
    release();
    await flush();
    expect(result.current.answer?.field.rocks.player).toBe(true);
    act(() => result.current.setNote('a later render'));
    expect(result.current.stale).toBeNull();
    // A new turn never answered, its request held: nothing stale.
    const release2 = holdNext(server);
    act(() => { void result.current.nextTurn(); });
    expect(result.current).toMatchObject({ current: { turn: 2 }, answer: null, stale: null });
    release2();
    await flush();
    expect(result.current.answer).not.toBeNull();
  });

  it('stale never crosses turns or plans', async () => {
    const { result, server } = await begun();
    await act(() => result.current.setField(rocksOn));
    const hold2 = holdNext(server);
    act(() => { void result.current.nextTurn(); });
    expect(result.current).toMatchObject({ answer: null, stale: null });   // turn 1's answer does not cross to turn 2
    hold2();
    await flush();
    await act(() => result.current.setField({ ...rocksOn, trickRoom: true }));
    const turn2 = result.current.answer!;
    await act(() => result.current.goTo(1));
    const turn1 = result.current.answer!;
    expect(turn1).not.toBe(turn2);
    const release = holdNext(server);
    act(() => { void result.current.setField({ ...defaultField('sand'), trickRoom: true }); });
    await debounced();
    expect(result.current).toMatchObject({ answer: null, stale: turn1 });  // turn 1's own last answer, never turn 2's
    release();
    await flush();
    const release2 = holdNext(server);
    act(() => { void result.current.begin(OTHER, SAVE); });
    expect(result.current.plan?.start).toEqual(OTHER);
    expect(result.current).toMatchObject({ answer: null, stale: null });   // nothing from the plan before
    release2();
    await flush();
  });

  it('a restored plan, or a removed turn index asked about again, starts with nothing stale', async () => {
    const first = await begun();
    await act(() => first.result.current.setField(rocksOn));
    const rec = kept();
    await act(() => first.result.current.begin(OTHER, SAVE));   // turn 1 of OTHER shown, so index 0 has an answer
    let release = holdNext(first.server);
    act(() => { void first.result.current.restore(toPlanRecord({ ...rec, plan: { ...rec.plan, start: { ...rec.plan.start, world: 1 } } })!, box()); });
    expect(first.result.current).toMatchObject({ answer: null, stale: null });
    release();
    await flush();

    localStorage.clear();
    const { result, server } = await cut();
    await act(() => result.current.toggleFainted('theirs'));   // so the next turn 3 faces another of theirs
    release = holdNext(server);
    act(() => { void result.current.nextTurn(); });
    expect(server.requests().at(-1)?.state.enemy.active).toBe(2);
    expect(result.current).toMatchObject({ current: { turn: 3 }, answer: null, stale: null });
    release();
    await flush();
  });
});

describe('usePlan: a tried Pokémon', () => {
  it('tried names who and who was there; a team Pokémon tried is not added again', async () => {
    const { result } = await begun();
    expect(result.current.tried).toBeNull();
    await act(() => result.current.nextTurn());
    await act(() => result.current.tryMon(BIG));
    expect(result.current.tried).toEqual(TRIED_BIG);
    await act(() => result.current.setMine(null));
    expect(result.current.tried).toBeNull();
    await act(() => result.current.goTo(1));
    await act(() => result.current.tryMon(STARLY));
    expect(result.current.tried).toEqual({ key: STARLY.key, previous: BLAZE.key });
    expect(result.current.plan?.start.mons).toHaveLength(2);
  });

  it('setting the lead on turn 1, or his Pokémon outright, is not a try: it carries at once', async () => {
    const { result } = await begun();
    await act(() => result.current.setMine(BLAZE.key));
    expect(result.current.plan?.turns[0]?.mine).toBe(BLAZE.key);
    expect(result.current.tried).toBeNull();
    await act(() => result.current.nextTurn());
    await act(() => result.current.goTo(1));
    await act(() => result.current.setMine(STARLY.key));
    expect(result.current.tried).toBeNull();
    expect(result.current.turns[1]?.mine).toBe(STARLY.key);
  });

  it('trying the Pokémon the turn would carry anyway is not a try, and writes nothing', async () => {
    const { result } = await begun({ ...START, mons: [BLAZE, STARLY, BIG], lead: BIG.key });
    await act(() => result.current.nextTurn());
    await act(() => result.current.tryMon(BIG));
    expect([result.current.plan?.turns[1]?.mine, result.current.plan?.turns[1]?.before]).toEqual([undefined, undefined]);
    expect(result.current.current?.mine).toBe(BIG.key);
    expect(result.current.tried).toBeNull();
  });

  it('an own pick that no longer applies is not named', async () => {
    const { result } = await begun();
    await act(() => result.current.nextTurn());
    await act(() => result.current.tryMon(STARLY));
    // Starly is set outright on turn 1, faints, and Blaze comes in: turn 2's tried Starly no longer applies.
    await act(() => result.current.goTo(1));
    await act(() => result.current.setMine(STARLY.key));
    await act(() => result.current.toggleFainted('mine'));
    act(() => result.current.sendIn('mine', BLAZE.key));
    await act(() => result.current.goTo(2));
    expect(result.current.plan?.turns[1]?.mine).toBe(STARLY.key);
    expect(result.current.current?.mine).toBe(BLAZE.key);
    expect(result.current.tried).toBeNull();
  });
});

const SCRATCH_PICK = { kind: 'move', slot: 0, name: 'Scratch' } as const;
const EMBER_PICK = { kind: 'move', slot: 1, name: 'Ember' } as const;
const by = (mon: PlanMon, p: { slot: number; name: string }) => ({ kind: 'move', by: mon.key, slot: p.slot, name: p.name });

/** Turn 1 Scratch, turn 2 Ember, turn 3 Scratch with Blaze marked fainted, notes 'one' to 'three'; the cursor on turn 2. */
async function picked(result: { current: UsePlan }) {
  for (const [i, note, pick] of [[1, 'one', SCRATCH_PICK], [2, 'two', EMBER_PICK], [3, 'three', SCRATCH_PICK]] as const) {
    act(() => result.current.setNote(note));
    act(() => result.current.pick(pick));
    if (i < 3) await act(() => result.current.nextTurn());
  }
  await act(() => result.current.toggleFainted('mine'));
  await act(() => result.current.goTo(2));
  await flush();
}

describe('usePlan: a try stays on its own turn until Keep', () => {
  it('later turns keep their picks, marks and notes while a try is not kept, and Keep makes it carry', async () => {
    const { result } = await begun();
    await picked(result);
    await act(() => result.current.tryMon(BIG));
    expect(result.current.current?.mine).toBe(BIG.key);
    expect(result.current.tried).toEqual(TRIED_BIG);
    const third = () => result.current.turns[2]!;
    expect(third()).toMatchObject({ mine: BLAZE.key, pick: by(BLAZE, SCRATCH_PICK), fainted: { mine: true } });
    expect(notes(result.current)).toEqual(['one', 'two', 'three']);
    await act(() => result.current.goTo(3));                    // away without Keep: turn 3 is still Blaze's
    expect(result.current.current).toMatchObject({ mine: BLAZE.key, pick: by(BLAZE, SCRATCH_PICK) });
    await act(() => result.current.goTo(2));
    expect(result.current.tried).toEqual(TRIED_BIG);
    await act(() => result.current.keepTry());
    expect(result.current.tried).toBeNull();
    expect([result.current.current?.mine, third().mine, kept().plan.turns[1]?.mine]).toEqual([BIG.key, BIG.key, BIG.key]);
    expect(kept().plan.turns[1]?.before).toBeUndefined();
    expect(notes(result.current)).toEqual(['one', 'two', 'three']);
  });

  it('a reload keeps a try not yet kept un-kept, with what Back puts back', async () => {
    const first = await begun();
    await picked(first.result);
    await act(() => first.result.current.tryMon(BIG));
    first.unmount();
    const { result } = setup();
    await act(() => result.current.restore(kept(), box()));
    expect(result.current).toMatchObject({ current: { turn: 2 }, tried: TRIED_BIG });
    expect(result.current.turns[2]).toMatchObject({ mine: BLAZE.key, pick: by(BLAZE, SCRATCH_PICK) });
    await act(() => result.current.setMine(null));
    expect(result.current.current?.mine).toBe(BLAZE.key);
    expect(keys(result.current)).toEqual([BLAZE.key, STARLY.key]);
  });

  it('Back restores the pick he had before the try', async () => {
    const { result } = await begun();
    await picked(result);
    await act(() => result.current.tryMon(BIG));
    act(() => result.current.pick({ kind: 'move', slot: 2, name: 'Surf' }));
    await flush();
    await act(() => result.current.toggleFainted('mine'));
    expect(result.current.current).toMatchObject({ pick: by(BIG, { slot: 2, name: 'Surf' }), fainted: { mine: true } });
    await act(() => result.current.setMine(null));
    expect(result.current.current).toMatchObject({ mine: BLAZE.key, pick: by(BLAZE, EMBER_PICK), fainted: { mine: false } });
    expect(result.current.tried).toBeNull();
    expect(kept().plan.turns[1]?.pick).toEqual(by(BLAZE, EMBER_PICK));
    expect(kept().plan.turns[1]?.before).toBeUndefined();
    expect(result.current.turns[2]?.pick).toEqual(by(BLAZE, SCRATCH_PICK));
  });

  it('Back restores his fainted mark and replacement from before the try', async () => {
    const { result } = await begun();
    await picked(result);
    await act(() => result.current.goTo(3));
    act(() => result.current.sendIn('mine', STARLY.key));
    await flush();
    await act(() => result.current.tryMon(BIG));
    await act(() => result.current.toggleFainted('mine'));
    await act(() => result.current.setMine(null));
    expect(result.current.current).toMatchObject({ mine: BLAZE.key, fainted: { mine: true }, sendIn: { mine: STARLY.key }, pick: by(BLAZE, SCRATCH_PICK) });
  });

  it('Back takes a Pokémon only the try added out of the plan; Add to team keeps it', async () => {
    const { result } = await begun();
    await act(() => result.current.nextTurn());
    await act(() => result.current.tryMon(BIG));
    expect(keys(result.current)).toEqual([BLAZE.key, STARLY.key, BIG.key]);
    expect(stepRequest(result.current.plan!, 0)!.team).toEqual(['party:1', 'party:2']);   // not on offer on turn 1
    await act(() => result.current.setMine(null));
    expect(keys(result.current)).toEqual([BLAZE.key, STARLY.key]);
    expect(kept().plan.start.mons).toHaveLength(2);
    // Both of his marked fainted: the ending does not wait on the tried one.
    await act(() => result.current.toggleFainted('mine'));
    act(() => result.current.sendIn('mine', STARLY.key));
    await flush();
    await act(() => result.current.nextTurn());
    await act(() => result.current.toggleFainted('mine'));
    expect(result.current.ended).toBe('allFainted');

    const again = await begun();
    await act(() => again.result.current.nextTurn());
    await act(() => again.result.current.tryMon(BIG));
    await act(() => again.result.current.setMons([BLAZE, STARLY, BIG]));
    await act(() => again.result.current.setMine(null));
    expect(keys(again.result.current)).toEqual([BLAZE.key, STARLY.key, BIG.key]);
  });
});

describe('plan: carriedMine and withoutLastTurn', () => {
  it('carriedMine is who the turn before hands over: none after his faint with no replacement, whatever the turn itself says', () => {
    const p = planOf(2, 1);
    expect(carriedMine(p, 1)).toBe(BLAZE.key);
    p.turns[0] = { ...p.turns[0]!, fainted: { mine: BLAZE.key } };
    expect(carriedMine(p, 1)).toBeNull();
    p.turns[1] = { ...p.turns[1]!, mine: STARLY.key };
    expect(carriedMine(p, 1)).toBeNull();                          // his own pick does not count
    p.turns[0] = { ...p.turns[0]!, sendIn: { mine: STARLY.key } };
    expect(carriedMine(p, 1)).toBe(STARLY.key);
    expect(p.turns[1]?.mine).toBe(STARLY.key);                     // the plan given is left as it was
    expect(carriedMine(p, 5)).toBeNull();
    const q = planOf(2, 1);
    q.turns[0] = { ...q.turns[0]!, pick: { kind: 'switch', by: BLAZE.key, to: STARLY.key } };
    q.turns[1] = { ...q.turns[1]!, mine: BLAZE.key };
    expect([carriedMine(q, 1), carriedMine(q, 0)]).toEqual([STARLY.key, BLAZE.key]);
  });

  it('withoutLastTurn drops the last turn and clamps the cursor; one turn is returned as given', () => {
    const one = planOf(1, 0);
    expect(withoutLastTurn(one)).toBe(one);
    const three = planOf(3, 2);
    const two = withoutLastTurn(three);
    expect([two.turns.map((t) => t.note), two.cursor, three.turns.length]).toEqual([['n1', 'n2'], 1, 3]);
    expect(withoutLastTurn(planOf(3, 0)).cursor).toBe(0);
  });
});

describe('usePlan: Remove this turn', () => {
  it('the last turn can be removed, and only the last', async () => {
    const { result } = await begun();
    await threeTurns(result);
    const seq = result.current.arrival!.seq;
    expect(result.current.removed).toBeNull();
    await act(() => result.current.removeLastTurn());
    expect(result.current.turns).toHaveLength(2);
    expect(result.current).toMatchObject({ current: { turn: 2 }, arrival: { seq: seq + 1, kind: 'turn' }, removed: 3 });
    expect(kept().plan.turns.map((t) => t.note)).toEqual(['one', 'two']);
    expect(result.current.answer).not.toBeNull();
    await act(() => result.current.goTo(1));
    await act(() => result.current.removeLastTurn());
    expect([result.current.turns.length, kept().plan.turns.length]).toEqual([2, 2]);
    await act(() => result.current.begin(START, SAVE));
    const seq1 = result.current.arrival!.seq;
    await act(() => result.current.removeLastTurn());
    expect(result.current.turns).toHaveLength(1);
    expect(result.current).toMatchObject({ arrival: { seq: seq1 }, removed: null });
  });

  it('Undo, once, puts the removed turn back with its note and the same bytes in storage, asking nothing', async () => {
    const { result, server, text } = await cut();
    const asked = server.requests().length;
    expect(localStorage.getItem(KEY)).not.toBe(text);
    expect(notes(result.current)).toEqual(['one', 'two']);
    const seq = result.current.arrival!.seq;
    await act(() => result.current.undo());
    expect(result.current.turns).toHaveLength(3);
    expect(result.current).toMatchObject({ current: { turn: 3 }, removed: null, cleared: null, arrival: { seq: seq + 1, kind: 'turn' } });
    expect(notes(result.current)).toEqual(['one', 'two', 'three']);
    expect(localStorage.getItem(KEY)).toBe(text);
    expect(result.current.answer).not.toBeNull();
    expect(server.requests()).toHaveLength(asked);             // its numbers were held
    await act(() => result.current.undo());
    expect(result.current.turns).toHaveLength(3);
    expect(localStorage.getItem(KEY)).toBe(text);
  });

  it.each<[string, (p: UsePlan) => unknown]>([
    ['a note', (p) => p.setNote('later')],
    ['the fight note', (p) => p.setFightNote('later')],
    ['a field change', (p) => p.setField({ ...rocksOn, trickRoom: true })],
    ['Next turn', (p) => p.nextTurn()],
    ['a pick', (p) => p.pick({ kind: 'move', slot: 0, name: 'Scratch' })],
    ['the world', (p) => p.setWorld(1)],
  ])('%s closes the Undo window', async (_, edit) => {
    const { result } = await cut();
    const late = result.current.undo;
    await act(async () => { await edit(result.current); });
    expect(result.current.removed).toBeNull();
    const after = localStorage.getItem(KEY);
    const shown = result.current.plan;
    await act(() => late());
    expect(result.current.plan).toBe(shown);
    expect(localStorage.getItem(KEY)).toBe(after);
    expect(notes(result.current)).not.toContain('three');
  });

  it.each<[string, (p: UsePlan) => Promise<unknown>]>([
    ['a jump to look at another turn', (p) => p.goTo(1)],
    ['the plan following the team', (p) => p.setMons([BLAZE, { ...STARLY, entry: { ref: 'party:2', level: 20 } }])],
  ])('%s leaves the Undo on offer', async (_, action) => {
    const { result } = await cut();
    await act(() => action(result.current));
    expect(result.current.removed).toBe(3);
    await act(() => result.current.undo());
    expect(notes(result.current)).toEqual(['one', 'two', 'three']);
    expect(result.current.current?.turn).toBe(3);
  });

  it('a plan stops at the most turns the page can read back, and says so', async () => {
    const { result } = setup();
    await act(() => result.current.restore({ v: 1, save: SAVE, plan: planOf(200, 199) }, box()));
    await act(() => result.current.nextTurn());
    expect(result.current.turns).toHaveLength(200);
    expect(result.current.notice).toBe('A plan holds at most 200 turns.');
    expect(toPlanRecord(JSON.parse(JSON.stringify({ v: 1, save: SAVE, plan: result.current.plan })))).not.toBeNull();
  });

  it('a late Undo never overwrites a newer plan: after Start, a restore that opens, or reset', async () => {
    const { result } = await cut();
    let late = result.current.undo;
    await act(() => result.current.begin(OTHER, SAVE));
    let newer = localStorage.getItem(KEY);
    await act(() => late());
    expect(result.current.plan?.start).toEqual(OTHER);
    expect(result.current.turns).toHaveLength(1);
    expect(localStorage.getItem(KEY)).toBe(newer);

    await act(() => result.current.begin(START, SAVE));
    await threeTurns(result);
    const rec = kept();
    await act(() => result.current.removeLastTurn());
    late = result.current.undo;
    await act(() => result.current.restore({ ...rec, plan: { ...rec.plan, start: OTHER, cursor: 0, turns: rec.plan.turns.slice(0, 1) } }, box()));
    newer = localStorage.getItem(KEY);
    await act(() => late());
    expect(result.current.plan?.start).toEqual(OTHER);
    expect(localStorage.getItem(KEY)).toBe(newer);

    await act(() => result.current.begin(START, SAVE));
    await threeTurns(result);
    await act(() => result.current.removeLastTurn());
    const two = localStorage.getItem(KEY);
    late = result.current.undo;
    act(() => result.current.reset());
    await act(() => late());
    expect(result.current.plan).toBeNull();
    expect(localStorage.getItem(KEY)).toBe(two);              // the kept two turns stay kept
  });

  it('Clear plan after a removal clears the plan as it is now, and its Undo brings back that plan, once', async () => {
    const { result } = await cut();
    const two = localStorage.getItem(KEY);
    act(() => result.current.clear());
    expect(result.current).toMatchObject({ removed: null, cleared: 2 });
    await act(() => result.current.undo());
    expect(result.current.turns).toHaveLength(2);
    expect(localStorage.getItem(KEY)).toBe(two);
    await act(() => result.current.undo());
    expect(result.current.turns).toHaveLength(2);
  });

  it('a kept plan opened and then cut is put back byte for byte, and not rewritten', async () => {
    const first = await begun();
    const text = await threeTurns(first.result);
    first.unmount();
    const { result } = setup();
    await act(() => result.current.restore(toPlanRecord(JSON.parse(text))!, box()));
    expect(localStorage.getItem(KEY)).toBe(text);
    await act(() => result.current.removeLastTurn());
    expect(kept().plan.turns).toHaveLength(2);
    await act(() => result.current.undo());
    expect(localStorage.getItem(KEY)).toBe(text);
    expect(notes(result.current)).toEqual(['one', 'two', 'three']);
    await flush();
    expect(localStorage.getItem(KEY)).toBe(text);              // quiet again until his next action
  });
});
