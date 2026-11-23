// Saved copies on the plan screen: Save a copy never replaces one, opening a copy never drops the plan it replaces (the
// plan on the page, a cleared one held for Undo, or a kept one that did not open) without moving it into Saved plans and
// saying so, a copy of this save opens with today's draft, and the controls that go away with their click leave focus on
// a heading. The real PlanView and usePlan against the fake plan-step route.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftMonJson, MonRef, SheetJson } from '../../../src/server/apiTypes';
import { postPlanStep } from '../../../web/src/api';
import { PlanView, type PlanViewProps } from '../../../web/src/components/PlanView';
import { SavedPlans } from '../../../web/src/components/plan/SavedPlans';
import { planCurrentKey, planSavedKey } from '../../../web/src/planStore';
import { SLOW_MS } from '../../../web/src/usePlan';
import { planServer } from './planServer';
import { stubDraft } from './planDraft';
import { box, draftOptions, sheetOf, stubFetch, trainerById, TRISTAN } from './stubServer';

const TEAM: MonRef[] = ['party:1', 'party:2'];
const DRAFT: DraftMonJson[] = [{ ref: 'party:1' }, { ref: 'party:2' }];
const SAVED = planSavedKey(TRISTAN, 0);
const base = sheetOf(TRISTAN);
const SHEET: SheetJson = { ...base, enemies: ['Imp', 'Mouse', 'Gloom'].map((name, i) => ({ ...base.enemies[0]!, name, key: `enemy:${i}` })) };
function props(over: Partial<PlanViewProps> = {}): PlanViewProps {
  const p = {
    fight: { trainerId: TRISTAN, variant: 0 }, trainer: trainerById(TRISTAN), sheet: SHEET, sheetError: null, box: box(), team: TEAM, draft: DRAFT,
    options: draftOptions(), active: true, onDraftProblem: vi.fn(), onPlanning: vi.fn(), onAddToTeam: vi.fn(),
    teamOpen: false, onToggleTeam: vi.fn(), step: postPlanStep, ...over,
  };
  return { teamDraft: stubDraft(p.team, p.draft), ...p };
}
const settled = () => waitFor(() => expect(document.querySelector('.plan-turn')).not.toHaveAttribute('aria-busy'));
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const savedList = () => screen.getByRole('region', { name: 'Saved plans' });
const openSaved = (user: UserEvent, at = 0) => user.click(within(savedList()).getAllByRole('button', { name: 'Open' })[at]!);
const status = () => screen.getByRole('status');
const notice = () => document.querySelector('.banner-warn')?.textContent ?? null;
const planHeading = () => screen.getByRole('heading', { name: /^Battle plan · vs / });
type Stored = Array<{ name?: string; kept?: string; plan?: { turns: Array<{ note: string }> } }>;
const stored = (): Stored => JSON.parse(localStorage.getItem(SAVED) ?? '[]') as Stored;
const named = (name: string) => stored().find((c) => c.name === name);

/** A fresh page with its own fake route, the plan not started. */
function shown(over: Partial<PlanViewProps> = {}) {
  const server = planServer();
  stubFetch(server.routes);
  render(<PlanView {...props(over)} />);
  return { server, user: userEvent.setup() };
}
async function started(over: Partial<PlanViewProps> = {}) {
  const s = shown(over);
  await s.user.click(button('Start with Blaze (Monferno)'));
  await screen.findByRole('button', { name: /^Scratch/ });
  await settled();
  return s;
}
async function saveAs(user: UserEvent, name: string) {
  if (name !== '') await user.type(screen.getByLabelText('Plan name'), name);
  await user.click(button('Save a copy'));
}
async function note(user: UserEvent, turn: number, text: string) {
  await user.clear(screen.getByLabelText(`Turn ${turn} note`));
  await user.type(screen.getByLabelText(`Turn ${turn} note`), text);
}
/** A copy named "Copy", then a second turn with an unsaved note. */
async function copyThenWork(user: UserEvent) {
  await saveAs(user, 'Copy');
  await user.click(button('Next turn'));
  await settled();
  await note(user, 2, 'unsaved work');
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('Save a copy never replaces a saved plan: a name in use, default or typed, takes the next free one, and that is said', async () => {
  const { user } = await started();
  await note(user, 1, 'first idea');
  await saveAs(user, '');
  await note(user, 1, 'second idea');
  await saveAs(user, '');
  expect(status()).toHaveTextContent('Saved a copy of the plan as Blaze (Monferno), 1 turn (2).');
  await saveAs(user, 'Lead Blaze');
  await note(user, 1, 'changed');
  await saveAs(user, 'Lead Blaze');
  expect(stored().map((c) => `${c.name} = ${c.plan!.turns[0]!.note}`)).toEqual([
    'Blaze (Monferno), 1 turn = first idea', 'Blaze (Monferno), 1 turn (2) = second idea', 'Lead Blaze = second idea', 'Lead Blaze (2) = changed',
  ]);
  expect(status()).toHaveTextContent('Saved a copy of the plan as Lead Blaze (2). A saved plan is already named Lead Blaze.');
});

describe('opening a saved copy moves the plan it replaces into Saved plans first, and says so', () => {
  it('a kept plan that did not open, byte for byte', async () => {
    const first = await started();
    await saveAs(first.user, 'Copy');
    cleanup();
    const keptBytes = '{"v":0,"notes":"my old notes"}';
    localStorage.setItem(planCurrentKey(TRISTAN, 0), keptBytes);
    const { user } = shown();
    await openSaved(user);
    await settled();
    expect(stored().find((c) => c.kept === keptBytes)?.name).toBe('Plan that could not be read');
    expect(notice()).toMatch(/could not be read/);
    await user.type(screen.getByLabelText('Turn 1 note'), 'x');
    expect(localStorage.getItem(SAVED)).toContain('my old notes');
  });

  it('the plan on the page, listed with Open', async () => {
    const { user } = await started();
    await copyThenWork(user);
    expect(within(savedList()).getByText(/^Copy · 1 turn$/)).toBeInTheDocument();
    await openSaved(user);
    await settled();
    expect(screen.getByLabelText('Turn 1 note')).toBeInTheDocument();
    expect(screen.queryByLabelText('Turn 2 note')).toBeNull();
    expect(named('Earlier plan')?.plan?.turns[1]?.note).toBe('unsaved work');
    expect(notice()).toBe('The plan that was on the page is in Saved plans as "Earlier plan".');
  });

  it.each<[string, (user: UserEvent) => Promise<void>]>([
    ['Open a copy', (user) => openSaved(user)],
    ['Start with X', (user) => user.click(button('Start with Blaze (Monferno)'))],
  ])('a plan cleared for Undo, then %s', async (_, next) => {
    const { user } = await started();
    await copyThenWork(user);
    await user.click(button('Clear plan'));
    await next(user);
    await settled();
    expect(named('Cleared plan')?.plan?.turns[1]?.note).toBe('unsaved work');
    expect(notice()).toBe('The plan you cleared is in Saved plans as "Cleared plan".');
  });

  it('but a copy that is already in Saved plans, unchanged, is not saved again', async () => {
    const { user } = await started();
    await saveAs(user, 'A');
    await user.type(screen.getByLabelText('Turn 1 note'), 'b');
    await saveAs(user, 'B');
    for (const at of [0, 1]) {
      await openSaved(user, at);
      await settled();
      expect(stored().map((c) => c.name)).toEqual(['A', 'B']);
    }
    expect(notice()).toBeNull();
  });

  it('a copy of this save follows the draft as it is now, once, as it opens', async () => {
    const first = await started();
    await saveAs(first.user, 'Copy');
    await first.user.click(button('Clear plan'));
    cleanup();
    const { user, server } = shown({ draft: [{ ref: 'party:1', hp: 20 }, { ref: 'party:2' }] });
    await openSaved(user);
    await settled();
    await flush();
    await settled();
    expect(server.requests().at(-1)!.draft[0]).toEqual({ ref: 'party:1', hp: 20 });
  });
});

it('the saved plans list says the turn count once: not after a default name that already ends with it', () => {
  const copy = (name: string, turns: number) => ({ name, v: 1, save: null, plan: { turns: Array.from({ length: turns }, () => ({})) } }) as never;
  render(<SavedPlans saved={[copy('Prinplup, 2 turns', 2), copy('Prinplup, 1 turn', 1), copy('Lead Blaze', 2), copy('2 turns, my way', 3)]} onOpen={vi.fn()} onDelete={vi.fn()} />);
  expect(Array.from(document.querySelectorAll('.plan-saved-name')).map((n) => n.textContent)).toEqual(['Prinplup, 2 turns', 'Prinplup, 1 turn', 'Lead Blaze · 2 turns', '2 turns, my way · 3 turns']);
});

describe('controls that go with their click leave focus on a heading', () => {
  it('removing an unreadable plan on the start screen focuses a heading made focusable; Keep it on the plan screen its heading', async () => {
    localStorage.setItem(SAVED, JSON.stringify([{ junk: 1 }]));
    const first = shown();
    await first.user.click(button('Remove the plan that could not be read'));
    await first.user.click(button('Remove it'));
    expect((document.activeElement as HTMLElement).tagName).toBe('H3');
    expect(document.activeElement).toHaveAttribute('tabindex', '-1');
    cleanup();
    localStorage.setItem(SAVED, JSON.stringify([{ junk: 1 }]));
    const { user } = await started();
    await user.click(button('Remove the plan that could not be read'));
    await user.click(button('Keep it'));
    expect(document.activeElement).toBe(planHeading());
  });

  it('Delete a saved plan asks first, then focus goes to a heading and the status region says it', async () => {
    const { user } = await started();
    await saveAs(user, 'One');
    await saveAs(user, 'Two');
    await user.click(button('Clear plan'));
    await user.click(within(savedList()).getAllByRole('button', { name: 'Delete' })[0]!);
    expect(within(savedList()).getByText(/cannot be undone/)).toBeInTheDocument();
    await user.click(within(savedList()).getByRole('button', { name: 'Keep it' }));
    expect(stored()).toHaveLength(2);
    expect(document.activeElement?.tagName).toMatch(/^H[1-4]$/);
    await user.click(within(savedList()).getAllByRole('button', { name: 'Delete' })[0]!);
    await user.click(within(savedList()).getByRole('button', { name: 'Delete it' }));
    expect(stored().map((c) => c.name)).toEqual(['Two']);
    expect(document.activeElement).toBe(within(savedList()).getByRole('heading', { name: 'Saved plans' }));
    expect(status()).toHaveTextContent('Deleted the saved plan One.');
  });

  it("Delete the last saved plan with a plan on the page focuses the plan's heading", async () => {
    const { user } = await started();
    await saveAs(user, 'One');
    await user.click(within(savedList()).getByRole('button', { name: 'Delete' }));
    await user.click(within(savedList()).getByRole('button', { name: 'Delete it' }));
    expect(screen.queryByRole('region', { name: 'Saved plans' })).toBeNull();
    expect(stored()).toEqual([]);
    expect(document.activeElement).toBe(planHeading());
    expect(status()).toHaveTextContent('Deleted the saved plan One.');
  });

  it('"Work out this turn" leaves focus on "Your action"', async () => {
    vi.useFakeTimers();
    const server = planServer();
    stubFetch(server.routes);
    render(<PlanView {...props()} />);
    let release!: () => void;
    server.gate.hold = new Promise<void>((r) => { release = r; });
    act(() => fireEvent.click(button('Start with Blaze (Monferno)')));
    await act(async () => { await vi.advanceTimersByTimeAsync(SLOW_MS); });
    act(() => fireEvent.click(button('Stop')));
    const work = button('Work out this turn');
    server.gate.hold = new Promise<void>(() => {});
    work.focus();
    act(() => fireEvent.click(work));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Your action' }));
    release();
  });
});
