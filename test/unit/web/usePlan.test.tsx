// usePlan: the plan the player writes, one step per turn, kept in the browser as he goes, with the cursor's numbers. The
// tests run the real client (`postPlanStep`) against the fake plan-step route (planServer.ts): Blaze and Starly against
// Imp, Mouse and Gloom. When their active is marked fainted, the route makes the highest standing index the likeliest.

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NO_ANSWER, postPlanStep } from '../../../web/src/api';
import { defaultField, type PlanMon, type PlanStart } from '../../../web/src/plan';
import { planCurrentKey, readCurrentPlan } from '../../../web/src/planStore';
import type { PlanFieldJson, PlanStepJson, PlanStepRequestJson } from '../../../web/src/planTypes';
import { FIELD_DEBOUNCE_MS, planFailureOf, SLOW_MS, usePlan, type UsePlan } from '../../../web/src/usePlan';
import { BENCH, SCRATCH } from './lineServer';
import { filledField, planServer, stepAnswer } from './planServer';
import { box, ROARK, stubFetch, TRISTAN } from './stubServer';

const BLAZE: PlanMon = { key: 'key-party:1', ref: 'party:1', name: 'Blaze (Monferno)', entry: { ref: 'party:1' } };
const STARLY: PlanMon = { key: 'key-party:2', ref: 'party:2', name: 'Starly', entry: { ref: 'party:2' } };
const BIG: PlanMon = { key: 'key-box:1:4', ref: 'box:1:4', name: 'Big (Bibarel)', entry: { ref: 'box:1:4', level: 16 } };
const START: PlanStart = { trainerId: TRISTAN, variant: 0, world: 0, mons: [BLAZE, STARLY], lead: BLAZE.key, enemies: ['Imp', 'Mouse', 'Gloom'] };
const ROARK_START: PlanStart = { trainerId: ROARK, variant: 0, world: 0, mons: [BLAZE, STARLY], lead: BLAZE.key, enemies: ['Cranidos', 'Geodude', 'Onix'] };
const SAVE = { savePath: box().savePath, savedAt: box().savedAt };
const KEY = planCurrentKey(TRISTAN, 0);
const rocksOn: PlanFieldJson = { ...defaultField('sand'), rocks: { player: true, enemy: false } };
const NO_ANSWER_TEXT = 'No answer from the planner. Your plan is kept; this turn has no numbers yet.';
const REFUSED = { status: 400, json: { error: 'draft: party:1 hp must be 1 to 44' } };
const DOWN = { status: 502, json: {} };
const SCRATCH_PICK = { kind: 'move', by: BLAZE.key, slot: 0, name: 'Scratch' };

const kept = () => readCurrentPlan(TRISTAN, 0)!;
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
/** Lets a field edit's debounce run out, so its request is made (or its answer found held). */
const debounced = () => act(async () => { await new Promise((r) => setTimeout(r, FIELD_DEBOUNCE_MS)); });

function setup(log?: boolean[]) {
  const server = planServer();
  const net = stubFetch(server.routes);
  const { result, unmount } = renderHook(() => {
    const p = usePlan({ step: postPlanStep });
    log?.push(p.busy);
    return p;
  });
  return { server, net, result, unmount, last: () => server.requests().at(-1)! };
}
async function begun(start = START, log?: boolean[]) {
  const s = setup(log);
  await act(() => s.result.current.begin(start, SAVE));
  return s;
}
/** Holds the route's next answer until `release()`. */
function holdNext(server: ReturnType<typeof planServer>): () => void {
  let release!: () => void;
  server.gate.hold = new Promise<void>((r) => { release = r; });
  return () => release();
}
/** A field edit, its request made and held: gives back the request and its release. */
async function heldEdit(s: Awaited<ReturnType<typeof begun>>, field: PlanFieldJson = rocksOn) {
  const release = holdNext(s.server);
  act(() => { void s.result.current.setField(field); });
  await debounced();
  return { release, call: s.net.calls.at(-1)! };
}
const withEnemyRocks = (p: UsePlan) => { const f = p.current!.field; return { ...f, rocks: { ...f.rocks, enemy: true } }; };

/** Three turns with notes 'one', 'two', 'three' and a fight note, then edits on turn 1 that change what turns 2 and 3 resolve to. */
async function backEdits(result: { current: UsePlan }) {
  act(() => result.current.setNote('one'));
  await act(() => result.current.nextTurn());
  act(() => result.current.setNote('two'));
  await act(() => result.current.nextTurn());
  act(() => result.current.setNote('three'));
  act(() => result.current.setFightNote('the whole fight'));
  await act(() => result.current.goTo(1));
  await act(() => result.current.setMine(STARLY.key));
  await act(() => result.current.toggleFainted('mine'));
  await act(() => result.current.setField(rocksOn));
  await act(() => result.current.tryMon(BIG));
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('usePlan', () => {
  it('begin shows turn 1 with its numbers and keeps the plan, by the default transport too', async () => {
    const { result, server } = await begun();
    expect(result.current).toMatchObject({ busy: false, arrival: { seq: 1, kind: 'turn' }, save: SAVE, plan: { weather0: 'sand' }, current: { mine: BLAZE.key } });
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.answer?.aiOdds?.choices[0]?.label).toBe('Quick Attack');
    expect(server.requests()).toHaveLength(1);
    expect(kept()).toMatchObject({ save: SAVE, plan: { weather0: 'sand' } });
    expect(kept().plan.turns).toHaveLength(1);

    const roark = planServer();
    const net = stubFetch(roark.routes);
    const plain = renderHook(() => usePlan());
    await act(() => plain.result.current.begin(ROARK_START, SAVE));
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]).toMatchObject({ method: 'POST', url: '/api/plan/step' });
    expect(roark.requests()[0]!.trainerId).toBe(ROARK);
  });

  // A trainer whose field is a permanent Trick Room: turn 1 sends none, the answer echoes the start's, and the plan learns
  // it as it learns the weather; a Trick Room he set is never overwritten.
  it("learns the battle start's Trick Room from turn 1's answer, and never overwrites his own", async () => {
    const asked: PlanStepRequestJson[] = [];
    const step = async (req: PlanStepRequestJson): Promise<PlanStepJson> => {
      asked.push(req);
      return stepAnswer(req, { field: { ...filledField(req), trickRoom: req.state.field.trickRoom ?? true } });
    };
    const { result } = renderHook(() => usePlan({ step }));
    await act(() => result.current.begin(START, SAVE));
    expect('trickRoom' in asked[0]!.state.field).toBe(false);
    expect([result.current.plan?.trickRoom0, kept().plan.trickRoom0, result.current.current?.field.trickRoom]).toEqual([true, true, true]);
    await act(() => result.current.nextTurn());
    expect(asked.at(-1)!.state.field.trickRoom).toBe(true);
    await act(() => result.current.goTo(1));
    await act(() => result.current.setField({ ...result.current.current!.field, trickRoom: false }));
    await debounced();
    expect(asked.at(-1)!.state.field.trickRoom).toBe(false);
    expect([result.current.current?.field.trickRoom, result.current.turns[1]?.field.trickRoom, kept().plan.turns[0]?.field.trickRoom]).toEqual([false, false, false]);
    expect(result.current.plan?.trickRoom0).toBe(true);
  });

  it('an action without a plan does nothing', async () => {
    const { result, net } = setup();
    act(() => result.current.pick({ kind: 'move', slot: 0, name: 'Scratch' }));
    act(() => result.current.setNote('x'));
    await act(() => result.current.toggleFainted('mine'));
    await act(() => result.current.nextTurn());
    expect(result.current).toMatchObject({ plan: null, turns: [], rows: [], fightNote: '' });
    expect(net.calls).toHaveLength(0);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("a pick, or a panel's choice, is recorded and asks the server nothing; a switch to his own active or nobody is no pick", async () => {
    const { result, server } = await begun();
    expect(result.current.selected).toBeNull();
    act(() => result.current.pick({ kind: 'move', slot: 0, name: 'Scratch' }));
    expect(result.current.current?.pick).toEqual(SCRATCH_PICK);
    expect(kept().plan.turns[0]?.pick).toEqual(SCRATCH_PICK);
    for (const to of [BLAZE.key, 'nobody']) act(() => result.current.pick({ kind: 'switch', to }));
    expect(result.current.current?.pick).toEqual(SCRATCH_PICK);
    act(() => result.current.pick(null));
    expect(kept().plan.turns[0]?.pick).toBeNull();
    act(() => result.current.choose(SCRATCH.choice));
    expect(result.current.current?.pick).toEqual(SCRATCH_PICK);
    expect(result.current.selected).toEqual({ choice: SCRATCH.choice });
    act(() => result.current.choose(BENCH.choice));
    expect(result.current.current?.pick).toEqual({ kind: 'switch', by: BLAZE.key, to: STARLY.key });
    expect(result.current.selected).toEqual({ choice: BENCH.choice });
    act(() => result.current.choose({ kind: 'switch', index: 5 }));
    expect(result.current.current?.pick).toEqual({ kind: 'switch', by: BLAZE.key, to: STARLY.key });
    expect(server.requests()).toHaveLength(1);
  });

  it('after his faint the answer is a replacement step whose choice is who comes in; next turn waits for it', async () => {
    const { result, last } = await begun();
    await act(() => result.current.toggleFainted('mine'));
    expect(result.current.answer?.phase).toBe('playerReplacement');
    expect([result.current.selected, result.current.canNext]).toEqual([null, false]);
    await act(() => result.current.nextTurn());
    expect(result.current.turns).toHaveLength(1);
    const choice = result.current.answer!.choices[0]!.choice;
    act(() => result.current.choose(choice));
    expect(result.current.current).toMatchObject({ sendIn: { mine: STARLY.key }, pick: null });
    expect(result.current.selected?.choice).toEqual(choice);
    expect(result.current.canNext).toBe(true);
    await act(() => result.current.nextTurn());
    expect(result.current.current?.mine).toBe(STARLY.key);
    expect(last().team[0]).toBe('party:2');
  });

  it('a switch index is a team position, not a pool position', async () => {
    const { result, last } = await begun({ ...START, mons: [BLAZE, STARLY, BIG] });
    await act(() => result.current.setMine(BIG.key));
    expect(last().team).toEqual(['box:1:4', 'party:1', 'party:2']);
    act(() => result.current.choose({ kind: 'switch', index: 1 }));
    expect(result.current.current?.pick).toEqual({ kind: 'switch', by: BIG.key, to: BLAZE.key });
    expect(result.current.selected).toEqual({ choice: { kind: 'switch', index: 1 } });
  });

  it('HP never changes, and no request but the draft carries one', async () => {
    const { result, server } = await begun();
    const hp0 = result.current.answer!.view.player.active!.hp;
    const hps: number[] = [];
    const see = () => hps.push(result.current.answer!.view.player.active!.hp);
    act(() => result.current.pick({ kind: 'move', slot: 0, name: 'Scratch' })); see();
    for (const side of ['mine', 'mine', 'theirs', 'theirs'] as const) { await act(() => result.current.toggleFainted(side)); see(); }
    await act(() => result.current.setField(rocksOn)); see();
    await act(() => result.current.nextTurn()); see();
    await act(() => result.current.nextTurn()); see();
    expect(hps).toEqual(Array(8).fill(hp0));
    for (const req of server.requests()) {
      const { draft: _draft, ...rest } = req;
      expect(JSON.stringify(rest)).not.toContain('"hp"');
    }
  });

  it('a note is kept as typed, at once, and asks nothing', async () => {
    const log: boolean[] = [];
    const { result, server } = await begun(START, log);
    log.length = 0;
    act(() => result.current.setNote('a\nb'));
    expect(kept().plan.turns[0]?.note).toBe('a\nb');
    expect(result.current.rows[0]).toMatchObject({ note: 'a\nb', excerpt: 'a…' });
    act(() => result.current.setFightNote('whole fight'));
    expect([result.current.fightNote, kept().plan.note]).toEqual(['whole fight', 'whole fight']);
    expect(server.requests()).toHaveLength(1);
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((b) => b)).toBe(false);
  });

  it('a note can be written while numbers are worked out, and survives Stop and a failure', async () => {
    const s = await begun();
    const { result, server } = s;
    let { release, call } = await heldEdit(s);
    expect(result.current.busy).toBe(true);
    act(() => result.current.setNote('typed while busy'));
    expect(call.signal?.aborted).toBe(false);
    expect(result.current.busy).toBe(true);
    act(() => result.current.stop());
    expect(call.signal?.aborted).toBe(true);
    release();
    await flush();
    expect([result.current.rows[0]?.note, kept().plan.turns[0]?.note]).toEqual(['typed while busy', 'typed while busy']);

    server.gate.fail = DOWN;
    ({ release, call } = await heldEdit(s, { ...rocksOn, trickRoom: true }));
    act(() => result.current.setNote('typed again'));
    expect(call.signal?.aborted).toBe(false);
    release();
    await waitFor(() => expect(result.current.failure?.text).toBe(NO_ANSWER_TEXT));
    expect([result.current.rows[0]?.note, kept().plan.turns[0]?.note]).toEqual(['typed again', 'typed again']);
    expect(kept().plan.turns[0]?.field.trickRoom).toBe(true);
  });

  it('notes survive Back edits and the recompute of later turns, and no action stores an outcome', async () => {
    const { result } = await begun();
    await backEdits(result);
    expect(result.current.current).toMatchObject({ turn: 1, mine: BIG.key });
    expect(result.current.rows.map((r) => r.note)).toEqual(['one', 'two', 'three']);
    expect(kept().plan.turns.map((t) => t.note)).toEqual(['one', 'two', 'three']);
    expect([result.current.fightNote, kept().plan.note]).toEqual(['the whole fight', 'the whole fight']);
    act(() => result.current.pick({ kind: 'move', slot: 0, name: 'Scratch' }));
    expect(result.current.answer?.damage?.yours[0]?.critHp).toBeDefined();
    const raw = JSON.parse(localStorage.getItem(KEY)!) as { plan: { start: { mons?: unknown } } };
    delete raw.plan.start.mons;
    const text = JSON.stringify(raw);
    for (const word of ['"hp"', '"damage"', '"crit"', '"roll"', '"outcome"']) expect(text).not.toContain(word);
  });

  it('marking theirs fainted toggles, asks for the send-out odds, preselects the likeliest and brings the chosen one in next turn', async () => {
    const { result, last } = await begun();
    await act(() => result.current.toggleFainted('theirs'));
    await act(() => result.current.toggleFainted('theirs'));                     // off again with one call
    expect(result.current.current?.fainted.theirs).toBe(false);
    expect(result.current.plan?.turns[0]).toMatchObject({ sendIn: {}, fainted: {} });
    await act(() => result.current.toggleFainted('theirs'));
    expect(last().state.enemy).toEqual({ active: 0, fainted: [0] });
    expect(result.current.answer?.sendOut).toBeDefined();
    expect([result.current.current?.sendIn.theirs, kept().plan.turns[0]?.sendIn.theirs]).toEqual([2, 2]);
    act(() => result.current.sendIn('theirs', 1));
    await act(() => result.current.setField(rocksOn));
    expect(last().state.field.rocks.player).toBe(true);
    expect(result.current.answer?.sendOut).toBeDefined();
    expect(result.current.current?.sendIn.theirs).toBe(1);
    expect(kept().plan.turns[0]?.sendIn).toEqual({ theirs: 1, theirsPicked: true });
    await act(() => result.current.nextTurn());
    expect(result.current.current?.theirs).toBe(1);
    expect(last().state.enemy).toEqual({ active: 1, fainted: [0] });
  });

  it('next turn carries the same two, and asks nothing when the state is the same', async () => {
    const { result, server } = await begun();
    await act(() => result.current.nextTurn());
    expect(result.current.current).toMatchObject({ turn: 2, mine: BLAZE.key, theirs: 0 });
    expect(result.current.arrival?.seq).toBe(2);
    expect(result.current.answer).not.toBeNull();
    expect(server.requests().map((r) => r.state.field.weather)).toEqual([undefined, 'sand']);
    await act(() => result.current.nextTurn());
    expect(result.current.turns).toHaveLength(3);
    expect(result.current.arrival?.seq).toBe(3);
    expect(result.current.answer).not.toBeNull();
    expect(server.requests()).toHaveLength(2);
  });

  it('a box Pokémon can be tried on any turn, once', async () => {
    const { result, last } = await begun();
    await act(() => result.current.nextTurn());
    await act(() => result.current.tryMon(BIG));
    expect(result.current.plan?.start.mons).toHaveLength(3);
    expect(result.current.current?.mine).toBe(BIG.key);
    expect([last().team[0], last().draft[0]]).toEqual(['box:1:4', BIG.entry]);
    expect(result.current.turns[0]?.mine).toBe(BLAZE.key);
    await act(() => result.current.tryMon(BIG));
    expect(result.current.plan?.start.mons).toHaveLength(3);
    await act(() => result.current.setMine(null));
    expect(result.current.current?.mine).toBe(BLAZE.key);
    expect(kept().plan.turns[1]?.mine).toBeUndefined();
  });

  it('going back edits an earlier turn and the later ones recompute', async () => {
    const { result, last } = await begun();
    await act(() => result.current.nextTurn());
    await act(() => result.current.nextTurn());
    await act(() => result.current.goTo(1));
    expect(result.current.current?.turn).toBe(1);
    const seq = result.current.arrival!.seq;
    for (const turn of [1, 0, 4]) await act(() => result.current.goTo(turn));
    await act(() => result.current.setField(rocksOn));
    expect(result.current.arrival?.seq).toBe(seq);
    await act(() => result.current.goTo(3));
    expect(result.current.current?.field.rocks.player).toBe(true);
    expect(last().state.field.rocks.player).toBe(true);
    expect(result.current.turns).toHaveLength(3);
    expect(result.current.arrival?.seq).toBe(seq + 1);
  });

  it('plan complete, and all of yours', async () => {
    const { result } = await begun();
    for (const theirs of [2, 1]) {
      await act(() => result.current.toggleFainted('theirs'));
      await act(() => result.current.nextTurn());
      expect(result.current.current?.theirs).toBe(theirs);
    }
    expect(result.current.ended).toBeNull();
    await act(() => result.current.toggleFainted('theirs'));
    expect([result.current.ended, result.current.canNext]).toEqual(['complete', false]);
    await act(() => result.current.nextTurn());
    expect(result.current.turns).toHaveLength(3);
    await act(() => result.current.begin(START, SAVE));
    expect(result.current.turns).toHaveLength(1);
    await act(() => result.current.toggleFainted('mine'));
    act(() => result.current.sendIn('mine', STARLY.key));
    await act(() => result.current.nextTurn());
    await act(() => result.current.toggleFainted('mine'));
    expect([result.current.ended, result.current.canNext]).toEqual(['allFainted', false]);
  });

  it('a stopped request shows nothing late, says nothing, and the same action works again', async () => {
    const s = await begun();
    const { result } = s;
    const { release, call } = await heldEdit(s);
    expect(result.current).toMatchObject({ busy: true, working: { turn: 1 }, unsettled: false });
    act(() => result.current.stop());
    expect(result.current).toMatchObject({ busy: false, working: null, failure: null, answer: null, unsettled: true });
    expect(result.current.current?.field.rocks.player).toBe(true);
    expect(call.signal?.aborted).toBe(true);
    release();
    await flush();
    expect(result.current).toMatchObject({ answer: null, failure: null });
    await act(() => result.current.workOut());
    expect(result.current.answer?.field.rocks.player).toBe(true);
    expect(result.current.unsettled).toBe(false);
  });

  it('the newest of two quick edits wins', async () => {
    const s = await begun();
    const { result } = s;
    const { release, call } = await heldEdit(s);
    await act(() => result.current.setField(withEnemyRocks(result.current)));
    expect(call.signal?.aborted).toBe(true);
    release();
    await flush();
    expect(result.current.answer?.field.rocks).toEqual({ player: true, enemy: true });
    expect(result.current.current?.field.rocks).toEqual({ player: true, enemy: true });
    expect(result.current).toMatchObject({ failure: null, busy: false });
  });

  it('an overtaken request that fails says nothing and leaves the newer one running', async () => {
    const s = await begun();
    const { result, server } = s;
    server.gate.fail = DOWN;
    const first = await heldEdit(s);
    const second = await heldEdit(s, withEnemyRocks(result.current));
    expect(result.current.busy).toBe(true);
    first.release();
    await flush();
    expect(result.current).toMatchObject({ failure: null, busy: true, working: { turn: 1 } });
    second.release();
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.answer?.field.rocks).toEqual({ player: true, enemy: true });
    expect(result.current.failure).toBeNull();
  });

  it('moving to a held turn, or one that cannot be asked about, clears the old failure and refused draft', async () => {
    const { result, server } = await begun();
    server.gate.fail = DOWN;
    await act(() => result.current.nextTurn());
    expect(result.current.failure?.text).toBe(NO_ANSWER_TEXT);
    await act(() => result.current.goTo(1));
    expect(result.current.failure).toBeNull();
    expect(result.current.answer).not.toBeNull();
    server.gate.fail = REFUSED;
    await act(() => result.current.goTo(2));
    expect(result.current.draftProblem).toBe(REFUSED.json.error);
    await act(() => result.current.goTo(1));
    expect(result.current.draftProblem).toBeNull();
    await act(() => result.current.goTo(2));
    await act(() => result.current.nextTurn());
    await act(() => result.current.goTo(2));
    await act(() => result.current.toggleFainted('mine'));   // no replacement: turn 3 has no active of his
    server.gate.fail = DOWN;
    await act(() => result.current.setField(rocksOn));
    expect(result.current.failure?.text).toBe(NO_ANSWER_TEXT);
    await act(() => result.current.goTo(3));
    expect(result.current.current?.mine).toBeNull();
    expect(result.current).toMatchObject({ failure: null, unsettled: false });
  });

  it('Back while a turn is worked out shows the turn it went to', async () => {
    const s = await begun();
    const { result } = s;
    await act(() => result.current.nextTurn());
    const { release, call } = await heldEdit(s);
    expect(result.current.working).toEqual({ turn: 2 });
    await act(() => result.current.goTo(1));
    expect(call.signal?.aborted).toBe(true);
    expect(result.current.busy).toBe(false);
    release();
    await flush();
    expect(result.current.current?.turn).toBe(1);
    expect(result.current.answer?.field.rocks.player).toBe(false);
    expect(result.current).toMatchObject({ failure: null, busy: false });
  });

  it('slow turns on after SLOW_MS', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, server } = await begun();
    const release = holdNext(server);
    act(() => { void result.current.setField(rocksOn); });
    act(() => { vi.advanceTimersByTime(FIELD_DEBOUNCE_MS); });
    expect(result.current.busy).toBe(true);
    act(() => { vi.advanceTimersByTime(SLOW_MS - 1); });
    expect(result.current.slow).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.slow).toBe(true);
    release();
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.slow).toBe(false);
  });

  it('a failure keeps what he wrote and can be tried again', async () => {
    const { result, server } = await begun();
    server.gate.fail = DOWN;
    await act(() => result.current.setField(rocksOn));
    expect(result.current).toMatchObject({ failure: { text: NO_ANSWER_TEXT, retry: true }, answer: null, unsettled: true });
    expect(kept().plan.turns[0]?.field.rocks?.player).toBe(true);
    act(() => result.current.retry());
    await flush();
    expect(result.current.failure).toBeNull();
    expect(result.current.answer).not.toBeNull();
  });

  it("a refused draft is the draft's problem, not the plan's", async () => {
    const { result, server } = setup();
    server.gate.fail = REFUSED;
    await act(() => result.current.begin(START, SAVE));
    expect(result.current).toMatchObject({ draftProblem: REFUSED.json.error, failure: null });
    expect(result.current.plan).not.toBeNull();
    await act(() => result.current.workOut());
    expect(result.current.draftProblem).toBeNull();
    expect(result.current.answer).not.toBeNull();
  });

  it.each<[string, Error, ReturnType<typeof planFailureOf>]>([
    ['no answer', new ApiError(0, 'down', NO_ANSWER), { text: NO_ANSWER_TEXT, retry: true }],
    ['a bad start', new ApiError(422, 'no lead', 'BAD_START'), { text: 'This fight cannot be set up with the team as it is.', retry: false, detail: 'no lead' }],
    ...['UNSUPPORTED_DOUBLE', 'UNMODELLED_ITEM', 'LIMIT'].map((code): [string, Error, ReturnType<typeof planFailureOf>] =>
      [code, new ApiError(422, 'words', code), { text: `The planner could not work this turn out (${code}).`, retry: false, detail: 'words' }]),
    ['another code', new ApiError(500, 'boom', 'WHAT'), { text: 'This turn could not be worked out.', retry: true, detail: 'boom' }],
    ['no code', new ApiError(500, 'plain'), { text: 'This turn could not be worked out.', retry: true, detail: 'plain' }],
    ['any other error', new Error('x'), { text: 'x', retry: false }],
  ])('planFailureOf: %s', (_, error, failure) => {
    expect(planFailureOf(error)).toEqual(failure);
  });

  it('reset takes the plan off the page and keeps it', async () => {
    const s = await begun();
    const { result } = s;
    const { release, call } = await heldEdit(s);
    act(() => result.current.reset());
    expect(result.current).toMatchObject({ plan: null, turns: [], current: null, busy: false });
    expect(call.signal?.aborted).toBe(true);
    expect(kept().plan.turns[0]?.field.rocks?.player).toBe(true);
    release();
    await flush();
    expect(result.current).toMatchObject({ plan: null, answer: null, failure: null });
  });
});

describe('usePlan: field edits wait for a pause', () => {
  /** Only the page's own timers are faked: the fake route's answers still arrive once real timers are back. */
  const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  it('rapid edits ask once, FIELD_DEBOUNCE_MS after the last, for the state they made', async () => {
    const { result, server } = await begun();
    fakeTimers();
    const edit = (change: (f: PlanFieldJson) => PlanFieldJson) => act(() => { void result.current.setField(change(result.current.current!.field)); });
    edit((f) => ({ ...f, trickRoom: true }));
    expect([result.current.current?.field.trickRoom, kept().plan.turns[0]?.field.trickRoom]).toEqual([true, true]);   // shown and kept at once
    act(() => { vi.advanceTimersByTime(FIELD_DEBOUNCE_MS - 1); });
    edit((f) => ({ ...f, rocks: { ...f.rocks, enemy: true } }));
    act(() => { vi.advanceTimersByTime(FIELD_DEBOUNCE_MS - 1); });
    edit((f) => ({ ...f, stages: { ...f.stages, player: { atk: 1 } } }));
    act(() => { vi.advanceTimersByTime(FIELD_DEBOUNCE_MS - 1); });
    expect(server.requests()).toHaveLength(1);                              // nothing asked while he is still editing
    expect(result.current).toMatchObject({ busy: false, answer: null, unsettled: false });
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toMatchObject({ busy: true, working: { turn: 1 } });
    vi.useRealTimers();
    await flush();
    expect(server.requests()).toHaveLength(2);
    expect(server.requests()[1]!.state.field).toMatchObject({ trickRoom: true, rocks: { enemy: true }, stages: { player: { atk: 1 } } });
    expect(result.current.answer?.field.stages.player).toEqual({ atk: 1 });
    expect(result.current.busy).toBe(false);
  });

  it('any other action asks at once, with the waiting edit in it, and the wait then asks nothing', async () => {
    const { result, server } = await begun();
    fakeTimers();
    act(() => { void result.current.setField(rocksOn); });
    act(() => { void result.current.toggleFainted('theirs'); });
    expect(result.current.busy).toBe(true);
    act(() => { vi.advanceTimersByTime(FIELD_DEBOUNCE_MS); });
    vi.useRealTimers();
    await flush();
    expect(server.requests()).toHaveLength(2);
    expect(server.requests()[1]!.state).toMatchObject({ field: { rocks: { player: true } }, enemy: { fainted: [0] } });
    expect(result.current.answer).not.toBeNull();
  });

  it.each<[string, (p: UsePlan) => void, (p: UsePlan, asked: string[]) => void]>([
    ['a fight switch (reset): nothing is asked', (p) => p.reset(), (p, asked) => {
      expect(asked).toEqual([TRISTAN]);
      expect(p).toMatchObject({ unsettled: false, busy: false });
      expect(kept().plan.turns[0]?.field.rocks?.player).toBe(true);           // the edit itself is kept
    }],
    ['Stop: nothing is asked, and Work out this turn is on offer', (p) => p.stop(), (p, asked) => {
      expect(asked).toEqual([TRISTAN]);
      expect(p).toMatchObject({ busy: false, answer: null, unsettled: true });
    }],
    ['begin on another trainer: only the new plan is asked about', (p) => { void p.begin(ROARK_START, SAVE); }, (p, asked) => {
      expect(asked).toEqual([TRISTAN, ROARK]);
      expect(p.plan?.start.trainerId).toBe(ROARK);
      expect(p.answer).not.toBeNull();
      expect(p.unsettled).toBe(false);
    }],
  ])('%s drops a waiting edit', async (_, action, check) => {
    const { result, server } = await begun();
    fakeTimers();
    act(() => { void result.current.setField(rocksOn); });
    expect(result.current).toMatchObject({ pending: true, unsettled: false });
    act(() => action(result.current));
    expect(result.current.pending).toBe(false);
    act(() => { vi.advanceTimersByTime(FIELD_DEBOUNCE_MS); });
    vi.useRealTimers();
    await flush();
    expect(result.current.pending).toBe(false);
    check(result.current, server.requests().map((r) => r.trainerId));
  });

  it('an edit drops the answer still on its way, and asks for the new state after the pause', async () => {
    const s = await begun();
    const { result, server } = s;
    const { release, call } = await heldEdit(s);
    expect(result.current.busy).toBe(true);
    act(() => { void result.current.setField({ ...result.current.current!.field, trickRoom: true }); });
    expect(call.signal?.aborted).toBe(true);
    expect(result.current.busy).toBe(false);
    release();
    await flush();                                                          // within the pause: the late answer is dropped
    expect(result.current).toMatchObject({ answer: null, failure: null });
    await debounced();
    await flush();
    expect(server.requests()).toHaveLength(3);
    expect(result.current.answer?.field).toMatchObject({ trickRoom: true, rocks: { player: true, enemy: false } });
  });
});

describe("usePlan: the battle start's stages", () => {
  const INTIMIDATED = { player: { atk: -1 }, enemy: {} };
  async function intimidated() {
    const s = setup();
    s.server.extra = { startStages: INTIMIDATED };
    await act(() => s.result.current.begin(START, SAVE));
    return s;
  }

  it("seed turn 1's stages as carried, asked again with them, once", async () => {
    const s = await intimidated();
    expect(s.server.requests().map((r) => r.state.field.stages)).toEqual([{ player: {}, enemy: {} }, INTIMIDATED]);
    expect(s.result.current.current?.field.stages).toEqual(INTIMIDATED);
    expect(s.result.current.answer?.field.stages).toEqual(INTIMIDATED);
    expect(s.result.current.busy).toBe(false);
    expect(kept().plan.turns[0]?.field).toEqual({});                       // carried, not written as his edit
    await flush();
    expect(s.server.requests()).toHaveLength(2);
  });

  it('a seeded stage can still be changed, and a stage he set is never overwritten', async () => {
    const s = await intimidated();
    await act(() => s.result.current.setField({ ...s.result.current.current!.field, stages: { player: { spe: 1 }, enemy: {} } }));   // Atk back to 0, Spe +1
    expect(s.result.current.current?.field.stages.player).toEqual({ spe: 1 });
    expect(s.last().state.field.stages.player).toEqual({ spe: 1 });
    expect(kept().plan.turns[0]?.field.stages).toEqual({ player: { atk: 0, spe: 1 } });
    await act(() => s.result.current.setWorld(1));                         // a new answer says the start's stages again
    expect(s.last().world).toBe(1);
    expect(s.result.current.current?.field.stages.player).toEqual({ spe: 1 });
  });

  it("a stage he set before the start's were known stays his", async () => {
    const { result, server, last } = await begun();
    await act(() => result.current.setField({ ...result.current.current!.field, stages: { player: { atk: 2 }, enemy: {} } }));
    server.extra = { startStages: { player: { atk: -1 }, enemy: { spa: -1 } } };
    await act(() => result.current.setWorld(1));
    expect(result.current.current?.field.stages).toEqual({ player: { atk: 2 }, enemy: { spa: -1 } });
    expect(last().state.field.stages).toEqual({ player: { atk: 2 }, enemy: { spa: -1 } });
  });

  it('carry into the next turn while the same two stay in, and go with a switch', async () => {
    const s = await intimidated();
    await act(() => s.result.current.nextTurn());
    expect(s.result.current.current?.field.stages).toEqual(INTIMIDATED);
    expect(s.last().state.field.stages).toEqual(INTIMIDATED);
    await act(() => s.result.current.setMine(STARLY.key));
    expect(s.result.current.current?.field.stages).toEqual({ player: {}, enemy: {} });
  });
});
