// The plan's toolbar: Save a copy and the saved plans above the start screen, Copy plan, Clear plan with Undo, Edit
// team, the world, and the stored copies that cannot be read. The real client against the fake plan-step route.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftMonJson, MonRef, SheetJson } from '../../../src/server/apiTypes';
import { postPlanStep } from '../../../web/src/api';
import { PlanView, type PlanViewProps } from '../../../web/src/components/PlanView';
import { planCurrentKey, planSavedKey } from '../../../web/src/planStore';
import { planServer } from './planServer';
import { stubDraft } from './planDraft';
import { box, draftOptions, sheetOf, stubFetch, trainerById, TRISTAN } from './stubServer';

const TEAM: MonRef[] = ['party:1', 'party:2'];
const DRAFT: DraftMonJson[] = [{ ref: 'party:1' }, { ref: 'party:2' }];
const SAVED = planSavedKey(TRISTAN, 0);
const CURRENT = planCurrentKey(TRISTAN, 0);
const base = sheetOf(TRISTAN);
const SHEET: SheetJson = { ...base, enemies: ['Imp', 'Mouse', 'Gloom'].map((name, i) => ({ ...base.enemies[0]!, name, key: `enemy:${i}` })) };
const props = (): PlanViewProps => ({
  fight: { trainerId: TRISTAN, variant: 0 }, trainer: trainerById(TRISTAN), sheet: SHEET, sheetError: null, box: box(), team: TEAM, draft: DRAFT,
  options: draftOptions(), active: true, onDraftProblem: vi.fn(), onPlanning: vi.fn(), onAddToTeam: vi.fn(), teamDraft: stubDraft(TEAM, DRAFT),
  teamOpen: false, onToggleTeam: vi.fn(), step: postPlanStep,
});

const settled = () => waitFor(() => expect(document.querySelector('.plan-turn')).not.toHaveAttribute('aria-busy'));
const chips = () => within(screen.getByRole('navigation', { name: 'Turns' })).getAllByRole('button');
const heading = () => screen.getByRole('heading', { name: 'Your action' });
const status = () => screen.getByRole('status');
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const savedList = () => screen.getByRole('region', { name: 'Saved plans' });
const nameBox = () => screen.getByLabelText('Plan name');
const stored = () => JSON.parse(localStorage.getItem(SAVED)!) as unknown[];
/** Adds an unreadable entry to the saved copies. */
const addJunk = (junk: unknown) => localStorage.setItem(SAVED, JSON.stringify([...(JSON.parse(localStorage.getItem(SAVED) ?? '[]') as unknown[]), junk]));

async function started() {
  const server = planServer();
  stubFetch(server.routes);
  const p = props();
  const view = render(<PlanView {...p} />);
  const user = userEvent.setup();
  await user.click(button('Start with Blaze (Monferno)'));
  await screen.findByRole('button', { name: /^Scratch/ });
  await settled();
  return { server, user, props: p, view };
}
async function saveAs(user: UserEvent, name: string) {
  if (name !== '') await user.type(nameBox(), name);
  await user.click(button('Save a copy'));
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('The plan toolbar', () => {
  it('Save a copy names the plan (the placeholder when empty), empties the box, and lists it on the start screen to open again', async () => {
    const { user } = await started();
    expect(nameBox()).toHaveAttribute('placeholder', 'Blaze (Monferno), 1 turn');
    await saveAs(user, 'Lead Blaze');
    expect(status()).toHaveTextContent('Saved a copy of the plan as Lead Blaze.');
    expect(nameBox()).toHaveValue('');
    await saveAs(user, '');
    await saveAs(user, '');
    await user.click(button('Clear plan'));
    expect(within(savedList()).getByRole('heading', { name: 'Saved plans' })).toBeInTheDocument();
    // The turn count once, also after a taken name's number.
    expect(Array.from(savedList().querySelectorAll('.plan-saved-name')).map((el) => el.textContent)).toEqual(['Lead Blaze · 1 turn', 'Blaze (Monferno), 1 turn', 'Blaze (Monferno), 1 turn (2)']);
    const openFirst = () => user.click(within(savedList()).getAllByRole('button', { name: 'Open' })[0]!);
    await openFirst();
    await settled();
    expect(chips()).toHaveLength(1);
    expect(heading()).toHaveFocus();
    expect(nameBox()).toHaveValue('Lead Blaze');
    await user.clear(nameBox());
    await user.type(nameBox(), 'Something else');
    await openFirst();
    await settled();
    expect(nameBox()).toHaveValue('Lead Blaze');
  });

  it('Delete asks first, Escape closes the confirm onto Delete, and a deleted copy goes while an unreadable one stays', async () => {
    const { user } = await started();
    await saveAs(user, 'Lead Blaze');
    addJunk({ junk: true });
    const del = within(savedList()).getByRole('button', { name: 'Delete' });
    await user.click(del);
    expect(within(savedList()).getByRole('button', { name: 'Keep it' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(within(savedList()).queryByRole('button', { name: 'Keep it' })).toBeNull();
    expect(del).toHaveFocus();
    expect(stored()).toHaveLength(2);
    await user.click(del);
    await user.click(within(savedList()).getByRole('button', { name: 'Delete it' }));
    expect(screen.queryByRole('region', { name: 'Saved plans' })).toBeNull();
    expect(stored()).toEqual([{ junk: true }]);
  });

  it('Copy plan copies the turns and notes', async () => {
    const { user } = await started();
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    await user.type(screen.getByLabelText('Fight note'), 'Sash on Imp');
    await user.click(button('Copy plan'));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const text = write.mock.calls[0]![0];
    expect(text).toMatch(/^Youngster Tristan — /);
    expect(text).toContain('Sash on Imp');
    expect(text).not.toContain('%');
    expect(button('Copy plan')).toHaveAttribute('title', 'Copy the turns and notes as text');
    await waitFor(() => expect(status()).toHaveTextContent('Plan copied.'));
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('Clear plan can be undone', async () => {
    const { user } = await started();
    await user.click(button('Next turn'));
    await settled();
    const bytes = localStorage.getItem(CURRENT);
    expect(bytes).not.toBeNull();
    await user.click(button('Clear plan'));
    const cleared = document.querySelector<HTMLElement>('.plan-cleared')!;
    expect(cleared).toHaveTextContent(/^Plan cleared \(2 turns\)\. Undo$/);
    expect(cleared).toHaveFocus();
    expect(button('Start with Blaze (Monferno)')).toBeInTheDocument();
    expect(localStorage.getItem(CURRENT)).toBeNull();
    expect(status()).toHaveTextContent('Plan cleared (2 turns).');
    await user.click(within(cleared).getByRole('button', { name: 'Undo' }));
    await settled();
    expect(chips()).toHaveLength(2);
    expect(localStorage.getItem(CURRENT)).toBe(bytes);
    expect(heading()).toHaveFocus();
    await waitFor(() => expect(status()).toHaveTextContent('Plan restored.'));
    expect(status().textContent).not.toMatch(/sav/i);
  });

  it('Edit team toggles; the world select shows only when the answer has worlds', async () => {
    const { server, user, props: p, view } = await started();
    expect(button('Edit team')).toHaveAttribute('aria-expanded', 'false');
    await user.click(button('Edit team'));
    expect(p.onToggleTeam).toHaveBeenCalledTimes(1);
    view.rerender(<PlanView {...p} teamOpen />);
    expect(button('Edit team')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('combobox', { name: /World/ })).toBeNull();
    server.extra = { worlds: [{ index: 0, label: 'Sun' }, { index: 1, label: 'Rain' }] };
    await user.click(button('Trick Room'));
    await settled();
    const world = await screen.findByRole('combobox', { name: /World/ });
    expect(world).toHaveValue('0');
    await user.selectOptions(world, '1');
    await settled();
    expect(server.requests().at(-1)!.world).toBe(1);
  });
});

describe('Saved copies that cannot be read', () => {
  it('are said, and removed only after a confirm that says it cannot be undone, focus then on the plan\'s heading', async () => {
    localStorage.setItem(SAVED, JSON.stringify([{ junk: 1 }, { junk: 2 }]));
    const { user } = await started();
    expect(screen.getByText(/2 saved plans for this fight could not be read/)).toBeInTheDocument();
    const remove = button('Remove the 2 plans that could not be read');
    await user.click(remove);
    expect(remove).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    await user.click(button('Keep them'));
    expect(localStorage.getItem(SAVED)).not.toBeNull();
    await user.click(remove);
    await user.click(button('Remove them'));
    expect(localStorage.getItem(SAVED)).toBeNull();
    expect(screen.queryByText(/could not be read/)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /^Battle plan · vs / }));
  });

  it('show on the start screen too, beside the readable ones, and their removal focuses "Saved plans"', async () => {
    const { user } = await started();
    await saveAs(user, 'Keep me');
    addJunk('junk');
    await user.click(button('Clear plan'));
    expect(screen.getByText(/1 saved plan for this fight could not be read/)).toBeInTheDocument();
    await user.click(button('Remove the plan that could not be read'));
    await user.click(button('Remove it'));
    expect(screen.queryByText(/could not be read/)).toBeNull();
    expect(savedList()).toHaveTextContent('Keep me · 1 turn');
    expect(stored()).toHaveLength(1);
    expect(document.activeElement).toBe(within(savedList()).getByRole('heading', { name: 'Saved plans' }));
  });
});
