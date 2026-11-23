// Trying a Pokémon on the turn: his card is the drop target for a carried Pokémon (the drag contract), and while a tried
// one is the turn's own the trial strip offers Keep, Back to and Add to team. The real client against the fake route.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DraftMonJson, MonRef, SheetJson } from '../../../src/server/apiTypes';
import { postPlanStep } from '../../../web/src/api';
import { PlanView, type PlanViewProps } from '../../../web/src/components/PlanView';
import { MON_DRAG_TYPE } from '../../../web/src/monDrag';
import { planServer } from './planServer';
import { stubDraft } from './planDraft';
import { box, draftOptions, sheetOf, stubFetch, trainerById, TRISTAN } from './stubServer';

const TEAM: MonRef[] = ['party:1', 'party:2'];
const DRAFT: DraftMonJson[] = [{ ref: 'party:1' }, { ref: 'party:2' }];
const base = sheetOf(TRISTAN);
const SHEET: SheetJson = { ...base, enemies: ['Imp', 'Mouse', 'Gloom'].map((name, i) => ({ ...base.enemies[0]!, name, key: `enemy:${i}` })) };
function props(over: Partial<PlanViewProps> = {}): PlanViewProps {
  const p = {
    fight: { trainerId: TRISTAN, variant: 0 }, trainer: trainerById(TRISTAN), sheet: SHEET, sheetError: null, box: box(), team: TEAM, draft: DRAFT,
    options: draftOptions(), active: true, onDraftProblem: vi.fn(), onPlanning: vi.fn(), onAddToTeam: vi.fn(), teamOpen: false, onToggleTeam: vi.fn(), step: postPlanStep, ...over,
  };
  return { teamDraft: stubDraft(p.team, p.draft), ...p };
}

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
const mine = () => screen.getByRole('region', { name: 'Your Pokémon' });
const settled = () => waitFor(() => expect(document.querySelector('.plan-turn')).not.toHaveAttribute('aria-busy'));
const strip = () => document.querySelector('.plan-trial');
/** A drag's `dataTransfer` as the page sees it: its types, and the data under the Pokémon type when it carries one. */
const carried = (types: string[], data: string) => ({ dataTransfer: { types, dropEffect: 'none', getData: (t: string) => (t === MON_DRAG_TYPE && types.includes(MON_DRAG_TYPE) ? data : '') } });
/** Drags over his card, then drops; returns whether the dragover was left to the browser (not claimed). */
function dropOnHim(types: string[], data: string): boolean {
  const unclaimed = fireEvent.dragOver(mine(), carried(types, data));
  fireEvent.drop(mine(), carried(types, data));
  return unclaimed;
}
const dropRef = (ref: string) => dropOnHim([MON_DRAG_TYPE], JSON.stringify(ref));

async function started(over: Partial<PlanViewProps> = {}) {
  const server = planServer();
  stubFetch(server.routes);
  const p = props(over);
  render(<PlanView {...p} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Start with Blaze (Monferno)' }));
  await screen.findByRole('button', { name: /^Scratch/ });
  await settled();
  return { server, user, props: p };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('a dragged Pokémon lights his card until it leaves; dropped, a box Pokémon is tried on this turn', async () => {
  const { server } = await started();
  expect(fireEvent.dragOver(mine(), carried([MON_DRAG_TYPE], ''))).toBe(false);
  expect(mine()).toHaveClass('is-over');
  expect(within(mine()).getByText('Drop here to try it against Imp')).toBeInTheDocument();
  fireEvent.dragLeave(mine(), carried([MON_DRAG_TYPE], ''));
  expect(mine()).not.toHaveClass('is-over');
  fireEvent.dragOver(mine(), carried([MON_DRAG_TYPE], ''));
  fireEvent.drop(mine(), carried([MON_DRAG_TYPE], '"box:1:4"'));
  expect(mine()).not.toHaveClass('is-over');
  expect(within(mine()).queryByText(/^Drop here/)).toBeNull();
  await settled();
  expect(mine()).toHaveTextContent('Big (Bibarel)');
  expect(strip()).toHaveTextContent('Trying Big (Bibarel) here.');
  expect(server.requests().at(-1)!.team[0]).toBe('box:1:4');
});

it('a drop that is not one of his, or is his active, does nothing', async () => {
  const { server, user } = await started();
  const nothing = async (drop: () => unknown) => {
    const [asked, before] = [server.requests().length, mine().textContent];
    drop();
    await flush();
    expect(mine().textContent).toBe(before);
    expect(strip()).toBeNull();
    expect(server.requests()).toHaveLength(asked);
  };
  await nothing(() => {
    expect(() => dropRef('box:9:9')).not.toThrow();
    expect(() => dropOnHim([MON_DRAG_TYPE], '{')).not.toThrow();
    expect(dropOnHim(['text/plain'], '"box:1:4"')).toBe(true);
    expect(mine()).not.toHaveClass('is-over');
    dropRef('party:1');
  });
  // Blaze marked fainted on turn 1, Starly in on turn 2: Blaze dropped there does nothing.
  await user.click(within(mine()).getByRole('button', { name: /^Mark .* fainted$/ }));
  await settled();
  await user.click(screen.getByRole('button', { name: /^Bench/ }));
  await user.click(screen.getByRole('button', { name: 'Next turn' }));
  await settled();
  expect(mine()).toHaveTextContent('Starly');
  await nothing(() => dropRef('party:1'));
});

// Each of the strip's buttons takes the strip away with it, so focus goes to the turn's heading, not the page body.
it.each<[string, (user: UserEvent, p: PlanViewProps) => Promise<void>]>([
  ['Back to Blaze (Monferno)', async () => {
    expect(mine()).toHaveTextContent('Blaze (Monferno)');
    expect(mine()).not.toHaveTextContent('Big');
  }],
  ['Keep', async (user) => {
    expect(mine()).toHaveTextContent('Big (Bibarel)');
    await user.click(screen.getByRole('button', { name: 'Next turn' }));
    await settled();
    expect(screen.getByLabelText('Turn 2 note')).toBeInTheDocument();
    expect(mine()).toHaveTextContent('Big (Bibarel)');
  }],
  ['Add to team', async (_, p) => { expect(p.onAddToTeam).toHaveBeenCalledWith('box:1:4'); }],
])('%s closes the strip, focus on "Your action"', async (name, then) => {
  const { user, props: p } = await started();
  dropRef('box:1:4');
  await settled();
  await user.click(screen.getByRole('button', { name }));
  await settled();
  expect(strip()).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Your action' }));
  await then(user, p);
});

it('with a full team there is no Add to team', async () => {
  await started({ team: ['party:1', 'party:2', 'box:3:1', 'box:3:2', 'box:3:3', 'box:3:4'] });
  dropRef('box:1:4');
  await settled();
  expect(strip()).toHaveTextContent('Trying Big (Bibarel) here.');
  expect(screen.queryByRole('button', { name: 'Add to team' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Keep' })).toBeInTheDocument();
});
