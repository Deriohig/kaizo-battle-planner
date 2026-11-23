// PlanView, the Fight tab as the plan screen: the start ("Start with X", not before the sheet is in), an arrival's focus
// and its one announcement, a pick that asks nothing, another fight (reset, then that fight's kept plan), the plan
// following the draft and the save once, a failure with Try again, a slow turn's Stop, and the server's words. The real
// client against the fake plan-step route (planServer.ts).

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftMonJson, MonRef, SheetJson } from '../../../src/server/apiTypes';
import { ApiError, NO_ANSWER, postPlanStep } from '../../../web/src/api';
import { PlanView, type PlanViewProps } from '../../../web/src/components/PlanView';
import { planMonOf } from '../../../web/src/components/plan/planScreen';
import { TurnChips } from '../../../web/src/components/plan/TurnChips';
import { saveOf } from '../../../web/src/line';
import { newPlan, type PlanStart } from '../../../web/src/plan';
import { planCurrentKey, readCurrentPlan, type TurnRow } from '../../../web/src/planStore';
import { NONE_LEFT, planFailureOf, SLOW_MS } from '../../../web/src/usePlan';
import { planServer } from './planServer';
import { stubDraft } from './planDraft';
import { box, draftOptions, ROARK, sheetOf, stubFetch, trainerById, TRISTAN } from './stubServer';

const BOX = box();
const LATER = '2026-06-12T13:00:00.000Z';
const TEAM: MonRef[] = ['party:1', 'party:2'];
const DRAFT: DraftMonJson[] = [{ ref: 'party:1' }, { ref: 'party:2' }];
const FIGHT = { trainerId: TRISTAN, variant: 0 };
const OTHER = { trainerId: ROARK, variant: 0 };
const KEY = planCurrentKey(TRISTAN, 0);
const base = sheetOf(TRISTAN);
const SHEET: SheetJson = { ...base, enemies: ['Imp', 'Mouse', 'Gloom'].map((name, i) => ({ ...base.enemies[0]!, name, key: `enemy:${i}` })) };

function props(over: Partial<PlanViewProps> = {}): PlanViewProps {
  const p = {
    fight: FIGHT, trainer: trainerById(TRISTAN), sheet: SHEET, sheetError: null, box: BOX, team: TEAM, draft: DRAFT, options: draftOptions(),
    active: true, onDraftProblem: vi.fn(), onPlanning: vi.fn(), onAddToTeam: vi.fn(), teamOpen: false, onToggleTeam: vi.fn(), step: postPlanStep, ...over,
  };
  return { teamDraft: stubDraft(p.team, p.draft), ...p };
}
function setup(over: Partial<PlanViewProps> = {}) {
  const server = planServer();
  stubFetch(server.routes);
  const view = render(<PlanView {...props(over)} />);
  return { server, ...view, asked: () => server.requests(), rerenderWith: (more: Partial<PlanViewProps>) => view.rerender(<PlanView {...props({ ...over, ...more })} />) };
}
/** Holds the route's next answer until the returned function is called. */
function holdNext(server: ReturnType<typeof planServer>): () => void {
  let release!: () => void;
  server.gate.hold = new Promise<void>((r) => { release = r; });
  return () => release();
}
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
const heading = () => screen.getByRole('heading', { name: 'Your action' });
const planHeading = () => screen.queryByRole('heading', { name: /Battle plan/ });
const status = () => screen.getByRole('status');
const scratch = () => screen.findByRole('button', { name: /^Scratch/ });
const startButton = () => screen.getByRole('button', { name: 'Start with Blaze (Monferno)' });
const chips = () => within(screen.getByRole('navigation', { name: 'Turns' })).getAllByRole('button');
const kept = () => readCurrentPlan(TRISTAN, 0)!;
async function started(over: Partial<PlanViewProps> = {}) {
  const s = setup(over);
  const user = userEvent.setup();
  await user.click(startButton());
  await scratch();
  return { ...s, user };
}
/** Keeps a plan for Tristan with each member's entry from `draft`, on `save` (this box's unless given). */
function keepPlan(draft: DraftMonJson[], save = saveOf(BOX), change?: (plan: ReturnType<typeof newPlan>) => void, space?: number) {
  const mons = TEAM.map((ref) => planMonOf(BOX.mons.find((m) => m.ref === ref)!, draft));
  const plan = newPlan({ trainerId: TRISTAN, variant: 0, world: 0, mons, lead: mons[0]!.key, enemies: ['Imp', 'Mouse', 'Gloom'] } as PlanStart);
  change?.(plan);
  const text = JSON.stringify({ v: 1, save, plan }, null, space);
  localStorage.setItem(KEY, text);
  return text;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PlanView', () => {
  it('says to pick a trainer when no fight is open, and starts nothing before the sheet is in', async () => {
    setup({ fight: null });
    expect(screen.getByText('Pick a trainer to plan a fight against.')).toHaveClass('line-muted');
    cleanup();
    const { asked } = setup({ sheet: null });
    expect(startButton()).toHaveAttribute('aria-disabled', 'true');
    expect(startButton()).not.toBeDisabled();
    await userEvent.setup().click(startButton());
    await flush();
    expect(asked()).toHaveLength(0);
    expect(planHeading()).toBeNull();
  });

  it("Start with X starts a plan by the server's plan step, moves focus to the turn, says it once, and a pick asks nothing", async () => {
    const onPlanning = vi.fn();
    const { asked, user } = await started({ onPlanning, step: undefined });
    expect(screen.getByRole('heading', { name: 'Battle plan · vs Youngster Tristan' })).toBeInTheDocument();
    expect(screen.getByText('0 of 3 marked fainted')).toBeInTheDocument();
    expect(chips()).toHaveLength(1);
    expect(chips()[0]).toHaveTextContent(/^Turn 1/);
    expect(chips()[0]).toHaveAttribute('aria-current', 'true');
    expect(chips()[0]).toHaveClass('selected');
    expect(asked().map((r) => r.team[0])).toEqual(['party:1']);
    expect(kept()).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^Start with/ })).toBeNull();
    expect(onPlanning).toHaveBeenLastCalledWith(true);
    expect(screen.queryByText(/Sample numbers/)).toBeNull();
    expect(document.querySelector('.plan-sample')).toBeNull();
    expect(document.activeElement).toBe(heading());
    expect(heading()).toHaveAttribute('tabindex', '-1');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    const said = status().textContent ?? '';
    expect(said).toMatch(/^Turn 1\. .*Blaze.*Imp/);
    await flush();
    expect(status().textContent).toBe(said);
    await user.click(await scratch());
    expect(await scratch()).toHaveAttribute('data-choice');
    expect(await scratch()).toHaveAttribute('aria-pressed', 'true');
    await flush();
    expect(asked()).toHaveLength(1);
  });

  it('another fight takes the plan off the page, drops its late answer, and the first fight\'s kept plan comes back without moving focus', async () => {
    const s = setup();
    const user = userEvent.setup();
    const release = holdNext(s.server);
    await user.click(startButton());
    expect(planHeading()).toBeInTheDocument();
    s.rerenderWith({ fight: OTHER, trainer: trainerById(ROARK) });
    expect(planHeading()).toBeNull();
    expect(startButton()).toBeInTheDocument();
    release();
    await flush();
    expect(planHeading()).toBeNull();
    expect(screen.queryByRole('button', { name: /^Scratch/ })).toBeNull();
    const before = document.activeElement;
    s.rerenderWith({ fight: FIGHT, trainer: trainerById(TRISTAN), active: true });
    expect(await screen.findByRole('heading', { name: 'Battle plan · vs Youngster Tristan' })).toBeInTheDocument();
    await scratch();
    expect(document.activeElement).toBe(before);
  });

  it("another fight resets the plan even when that fight's kept plan cannot open", async () => {
    // A kept plan for Roark on another save, with none of its Pokémon in this one: restore refuses it.
    const gone = { key: 'key-gone', ref: 'box:9:9' as MonRef, name: 'Gone', entry: { ref: 'box:9:9' as MonRef } };
    const plan = newPlan({ trainerId: ROARK, variant: 0, world: 0, mons: [gone], lead: gone.key, enemies: ['Geodude'] });
    localStorage.setItem(planCurrentKey(ROARK, 0), JSON.stringify({ v: 1, save: { savePath: 'other.dsv', savedAt: '2020-01-01T00:00:00.000Z' }, plan }));
    const s = await started();
    s.rerenderWith({ fight: OTHER, trainer: trainerById(ROARK) });
    expect(await screen.findByText(NONE_LEFT, { selector: '.banner-warn' })).toBeInTheDocument();
    expect(status()).toHaveTextContent(NONE_LEFT);
    expect(planHeading()).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Turns' })).toBeNull();
    expect(startButton()).toBeInTheDocument();
  });

  it('a kept plan of another save opens with its own numbers and rewrites nothing; a draft change then follows, once', async () => {
    const text = keepPlan([{ ref: 'party:1', level: 16 }], { ...saveOf(BOX), savedAt: '2026-06-11T12:00:00.000Z' }, undefined, 3);   // odd spacing shows a rewrite
    const s = setup();
    expect(await screen.findByRole('heading', { name: 'Battle plan · vs Youngster Tristan' })).toBeInTheDocument();
    await scratch();
    await flush();
    expect(localStorage.getItem(KEY)).toBe(text);
    expect(s.asked().map((r) => r.draft[0]!.level)).toEqual([16]);
    for (let i = 0; i < 2; i++) s.rerenderWith({ draft: [{ ref: 'party:1', level: 17 }, { ref: 'party:2' }] });
    await waitFor(() => expect(s.asked()).toHaveLength(2));
    await flush();
    expect(s.asked()).toHaveLength(2);
    expect(s.asked()[1]!.draft[0]!.level).toBe(17);
    expect(kept().plan.start.mons[0]!.entry).toEqual({ ref: 'party:1', level: 17 });
  });

  // Draft edits made while another fight was open: on the same save the reopened plan follows them, once; unchanged, nothing.
  it.each<[string, DraftMonJson[]]>([['an edited draft', [{ ref: 'party:1', hp: 20 }, { ref: 'party:2' }]], ['the draft unchanged', DRAFT]])('a kept plan reopened on the same save with %s', async (_, draft) => {
    const text = keepPlan(DRAFT, saveOf(BOX), undefined, 3);
    const s = setup({ draft });
    await scratch();
    await flush();
    if (draft === DRAFT) {
      expect(localStorage.getItem(KEY)).toBe(text);
      expect(s.asked()).toHaveLength(1);
      return;
    }
    expect(s.asked().at(-1)!.draft[0]).toEqual({ ref: 'party:1', hp: 20 });
    expect(kept().plan.start.mons[0]!.entry).toEqual({ ref: 'party:1', hp: 20 });
    const asked = s.asked().length;
    s.rerenderWith({ draft });
    await flush();
    expect(s.asked()).toHaveLength(asked);
  });

  // A save change while a plan is open: a Pokémon a turn names that is off the team is found by its key wherever the new
  // save put it; one the save no longer has is named, never silently lost.
  it.each<[string, boolean]>([['deposited into the box is followed by key', true], ['the new save no longer has is named', false]])('a Pokémon a turn names %s', async (_, deposited) => {
    keepPlan([], saveOf(BOX), (plan) => { plan.turns[0]!.pick = { kind: 'switch', by: plan.start.mons[0]!.key, to: plan.start.mons[1]!.key }; });
    const s = setup();
    await scratch();
    await flush();
    const starly = BOX.mons.find((m) => m.ref === 'party:2')!;
    const later = box({ savedAt: LATER });
    later.mons = [...later.mons.filter((m) => m.ref !== 'party:2'), ...(deposited ? [{ ...starly, ref: 'box:3:1' as const, location: 'box' as const, box: 3, slot: 1 }] : [])];
    s.rerenderWith({ box: later, team: ['party:1'], draft: [{ ref: 'party:1' }] });
    await flush();
    if (deposited) {
      expect(kept().save).toEqual(saveOf(later));
      expect(kept().plan.start.mons.map((m) => [m.key, m.ref])).toEqual([['key-party:1', 'party:1'], [starly.key, 'box:3:1']]);
      expect(s.asked().at(-1)!.team).toEqual(['party:1', 'box:3:1']);
      expect(screen.queryByText(/Your save changed/)).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    } else {
      expect(await screen.findByText('Your save changed since this plan was written. Not in this save: Starly.', { selector: '.banner-warn' })).toBeInTheDocument();
      expect(kept().plan.start.mons.map((m) => m.ref)).toEqual(['party:1']);
      expect(s.asked().at(-1)!.team).toEqual(['party:1']);
    }
  });

  it('a save where the lead can no longer join follows once, names him, and settles; a plain save change asks nothing', async () => {
    const s = await started();
    const later = box({ savedAt: LATER });
    s.rerenderWith({ box: later });
    await flush();
    expect(kept().save).toEqual(saveOf(later));
    expect(s.asked()).toHaveLength(1);                         // the same state: the held answer
    // Blaze cannot join in the new save: his old ref would be refused, so he leaves the pool and is named.
    const without = box({ savedAt: '2026-06-12T14:00:00.000Z' });
    without.mons = without.mons.map((m) => (m.ref === 'party:1' ? { ...m, draft: null } : m));
    s.rerenderWith({ box: without, team: ['party:2'], draft: [{ ref: 'party:2' }] });
    await flush();
    const followed = kept();
    expect(followed.save).toEqual(saveOf(without));
    expect(followed.plan.start.mons.map((m) => m.ref)).toEqual(['party:2']);
    expect(screen.getByText('Your save changed since this plan was written. Not in this save: Blaze (Monferno).', { selector: '.banner-warn' })).toBeInTheDocument();
    const asked = s.asked().length;
    s.rerenderWith({ box: without, team: ['party:2'], draft: [{ ref: 'party:2' }] });
    await flush();
    expect(s.asked()).toHaveLength(asked);
    expect(kept()).toEqual(followed);
  });

  it('a failure keeps the turn and offers Try again', async () => {
    const { server, user, asked } = await started();
    server.gate.fail = { status: 502, json: {} };
    await user.click(screen.getByRole('button', { name: 'Trick Room' }));
    expect((await screen.findByRole('alert')).textContent).toBe(`This turn has no numbers. ${planFailureOf(new ApiError(0, 'x', NO_ANSWER)).text}`);
    expect(chips()).toHaveLength(1);
    expect(heading()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Work out this turn' })).toBeNull();   // not beside Try again
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(await scratch()).not.toHaveAttribute('aria-disabled');
    expect(document.activeElement).not.toBe(document.body);
    expect(asked()).toHaveLength(3);
  });

  it('slow shows Stop, the field still takes clicks, and Stop leaves a way on', async () => {
    vi.useFakeTimers();
    const s = setup();
    holdNext(s.server);
    act(() => fireEvent.click(startButton()));
    await act(async () => { await vi.advanceTimersByTimeAsync(SLOW_MS - 1); });
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByText('Working out turn 1…')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText('Still working out turn 1.', { selector: 'p:not([role])' })).toBeInTheDocument();
    expect(status()).toHaveTextContent('Still working out turn 1.');
    expect(document.querySelector('.plan-turn')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Trick Room' })).not.toHaveAttribute('aria-disabled');   // setField aborts and debounces
    const stop = screen.getByRole('button', { name: 'Stop' });
    stop.focus();
    act(() => fireEvent.click(stop));
    expect(screen.getByRole('button', { name: 'Work out this turn' })).toBeInTheDocument();
    expect(document.activeElement).toBe(heading());
    expect(status().textContent).toBe('Turn 1.');           // the start, said once its request ended, with no numbers
  });

  it("what the numbers leave out is one muted line, and a send-out the AI cannot decide is said in the server's words", async () => {
    const words = "The AI's behaviour is undefined here (AI_UNDEFINED: no rule for this)";
    const s = setup();
    s.server.extra = { sendOutError: words };
    const user = userEvent.setup();
    await user.click(startButton());
    await scratch();
    expect(screen.getByText(words)).toHaveClass('plan-sendout-error');
    expect(document.querySelector('.plan-unmodelled')).toBeNull();
    s.server.extra = { unmodelled: ['their sleep (its counter is unknown)', 'Leftovers'] };
    await user.click(screen.getByRole('button', { name: 'Trick Room' }));
    expect(await screen.findByText('Not modelled in this battle: their sleep (its counter is unknown); Leftovers')).toHaveClass('line-muted', 'plan-unmodelled');
    expect(document.querySelectorAll('.plan-unmodelled')).toHaveLength(1);
    expect(screen.queryByText(words)).toBeNull();
  });
});

it('TurnChips: one chip per turn, with fainted and note pills, the current one marked; a click jumps', async () => {
  const row = (turn: number, over: Partial<TurnRow> = {}): TurnRow => ({ turn, mine: 'Blaze', theirs: 'Imp', pick: null, fainted: [], note: '', excerpt: '', current: false, ...over });
  const onJump = vi.fn();
  render(<TurnChips rows={[row(1, { fainted: ['Imp fainted'] }), row(2, { note: 'x', current: true }), row(3)]} onJump={onJump} />);
  const all = within(screen.getByRole('navigation', { name: 'Turns' })).getAllByRole('button');
  expect(all.map((b) => b.textContent)).toEqual(['Turn 1fainted', 'Turn 2note', 'Turn 3']);
  expect(within(all[0]!).getByText('fainted')).toHaveClass('pill', 'pill-danger');
  expect(within(all[1]!).getByText('note')).toHaveClass('pill');
  expect(all[1]).toHaveAttribute('aria-current', 'true');
  expect(all[1]).toHaveClass('chip', 'plan-chip', 'selected');
  expect(all[0]).not.toHaveAttribute('aria-current');
  expect(all[0]).not.toHaveClass('selected');
  await userEvent.setup().click(all[2]!);
  expect(onJump).toHaveBeenCalledExactlyOnceWith(3);
});
