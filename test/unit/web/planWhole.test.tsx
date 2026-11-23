// The whole plan, the fight note and Remove this turn: a row per turn that jumps there, the fight note kept as typed,
// and Remove this turn on the last of several turns, with its Undo. The real client against the fake plan-step route.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DraftMonJson, MonRef, SheetJson } from '../../../src/server/apiTypes';
import { postPlanStep } from '../../../web/src/api';
import { PlanView } from '../../../web/src/components/PlanView';
import { WholePlan } from '../../../web/src/components/plan/WholePlan';
import { readCurrentPlan } from '../../../web/src/planStore';
import { planServer } from './planServer';
import { stubDraft } from './planDraft';
import { box, draftOptions, sheetOf, stubFetch, trainerById, TRISTAN } from './stubServer';

const TEAM: MonRef[] = ['party:1', 'party:2'];
const DRAFT: DraftMonJson[] = [{ ref: 'party:1' }, { ref: 'party:2' }];
const base = sheetOf(TRISTAN);
const SHEET: SheetJson = { ...base, enemies: ['Imp', 'Mouse', 'Gloom'].map((name, i) => ({ ...base.enemies[0]!, name, key: `enemy:${i}` })) };

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((res) => setTimeout(res, 0)); });
const settled = () => waitFor(() => expect(document.querySelector('.plan-turn')).not.toHaveAttribute('aria-busy'));
const whole = () => screen.getByRole('region', { name: 'Whole plan' });
const rows = () => [...whole().querySelectorAll<HTMLElement>('button.plan-row')];
const chips = () => within(screen.getByRole('navigation', { name: 'Turns' })).getAllByRole('button');
const heading = () => screen.getByRole('heading', { name: 'Your action' });
const status = () => screen.getByRole('status');
const remove = () => screen.queryByRole('button', { name: 'Remove this turn' });

async function started() {
  const server = planServer();
  stubFetch(server.routes);
  render(<PlanView fight={{ trainerId: TRISTAN, variant: 0 }} trainer={trainerById(TRISTAN)} sheet={SHEET} sheetError={null} box={box()} team={TEAM} draft={DRAFT}
    options={draftOptions()} active onDraftProblem={vi.fn()} onPlanning={vi.fn()} onAddToTeam={vi.fn()} teamDraft={stubDraft(TEAM, DRAFT)} teamOpen={false} onToggleTeam={vi.fn()} step={postPlanStep} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Start with Blaze (Monferno)' }));
  await screen.findByRole('button', { name: /^Scratch/ });
  await settled();
  return { server, user };
}
/** Turn 1: Scratch, Imp marked fainted, a note; then turn 2. */
async function twoTurns(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Scratch/ }));
  await settled();
  await user.click(within(screen.getByRole('region', { name: 'Their Pokémon' })).getByRole('button', { name: /^Mark .* fainted$/ }));
  await settled();
  await user.type(screen.getByLabelText('Turn 1 note'), 'Sash first');
  await user.click(screen.getByRole('button', { name: 'Next turn' }));
  await settled();
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// A mirror match, both marked fainted on one turn, gives two equal words; React must not warn.
it('two equal fainted words on a row are both shown, with no key warning', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const row = { turn: 1, mine: 'Starly', theirs: 'Starly', pick: null, fainted: ['Starly fainted', 'Starly fainted'], note: '', excerpt: '', current: true };
  render(<WholePlan rows={[row]} fightNote="" onJump={vi.fn()} onFightNote={vi.fn()} look={() => undefined} />);
  expect(whole().querySelectorAll('.plan-row-fainted')).toHaveLength(2);
  expect(errors.mock.calls.filter((c) => String(c[0]).includes('same key'))).toEqual([]);
  errors.mockRestore();
});

it('the rows read as the plan, with no figures, and a row jumps to its turn', async () => {
  const { user } = await started();
  await twoTurns(user);
  expect(within(whole()).getByRole('heading', { name: 'Whole plan' })).toBeInTheDocument();
  expect(whole()).toHaveTextContent('every turn, with its note · click a row to edit it');
  const [one, two] = rows() as [HTMLElement, HTMLElement];
  expect(rows()).toHaveLength(2);
  for (const words of ['T1', 'Blaze (Monferno)', 'Scratch', 'vs Imp', 'Imp fainted', '“Sash first”']) expect(one).toHaveTextContent(words);
  expect(within(one).getByText('Imp fainted')).toHaveClass('plan-row-fainted');
  for (const words of ['T2', 'No pick yet', 'vs Gloom']) expect(two).toHaveTextContent(words);
  expect(two).toHaveAttribute('aria-current', 'true');
  expect(two).toHaveClass('selected');
  expect(one).not.toHaveAttribute('aria-current');
  for (const row of rows()) expect(row.textContent).not.toContain('%');
  await user.click(one);
  await settled();
  expect(chips()[0]).toHaveAttribute('aria-current', 'true');
  expect(rows()[0]).toHaveAttribute('aria-current', 'true');
  expect(heading()).toHaveFocus();
});

it('the fight note is kept as typed, and asks nothing', async () => {
  const { server, user } = await started();
  const asked = server.requests().length;
  const note = within(whole()).getByLabelText('Fight note');
  expect(note.tagName).toBe('TEXTAREA');
  await user.type(note, 'Lead Blaze{Enter}two hits');
  expect(note).toHaveValue('Lead Blaze\ntwo hits');
  expect(readCurrentPlan(TRISTAN, 0)!.plan.note).toBe('Lead Blaze\ntwo hits');
  await flush();
  expect(server.requests()).toHaveLength(asked);
});

it('Remove this turn shows on the last of several only, removes it, and Undo puts it back', async () => {
  const { user } = await started();
  expect(remove()).toBeNull();
  await twoTurns(user);
  await user.type(screen.getByLabelText('Turn 2 note'), 'gone soon');
  expect(remove()).toHaveClass('button-link');
  await user.click(remove()!);
  await settled();
  expect(chips()).toHaveLength(1);
  expect(heading()).toHaveFocus();
  await waitFor(() => expect(status()).toHaveTextContent('Turn 1.'));
  expect(status()).toHaveTextContent('Turn 2 removed.');
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(document.querySelector('.plan-removed')).toHaveTextContent(/^Turn 2 removed\. Undo \(until your next edit\)$/);
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  await settled();
  expect(chips()).toHaveLength(2);
  expect(heading()).toHaveFocus();
  expect(screen.getByLabelText('Turn 2 note')).toHaveValue('gone soon');
  await waitFor(() => expect(status()).toHaveTextContent('Turn 2 restored.'));
  expect(status().textContent).not.toMatch(/sav/i);
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  await user.click(chips()[0]!);                         // on turn 1 of two: no button
  await settled();
  expect(remove()).toBeNull();
});
