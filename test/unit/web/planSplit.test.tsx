// The crit split rows and the bands: his pick's rows on theirs and their shown move's rows on his (the likelihood list's
// pick for this turn, else their likeliest), and each card's band showing the other side's move. The real client
// against the fake plan-step route (planServer.ts).

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DraftMonJson, MonRef, SheetJson } from '../../../src/server/apiTypes';
import { postPlanStep } from '../../../web/src/api';
import { PlanView, type PlanViewProps } from '../../../web/src/components/PlanView';
import { planMonOf } from '../../../web/src/components/plan/planScreen';
import { SPLIT_NOTE } from '../../../web/src/components/plan/SplitRows';
import { NEXT_HINT } from '../../../web/src/components/plan/TurnFoot';
import { KO_KEY, saveOf } from '../../../web/src/line';
import { REPLY_BLIND } from '../../../web/src/tree';
import { newPlan } from '../../../web/src/plan';
import { planCurrentKey } from '../../../web/src/planStore';
import type { PlanStepJson } from '../../../web/src/planTypes';
import { NUMBERS, r } from './lineServer';
import { planServer } from './planServer';
import { stubDraft } from './planDraft';
import { box, draftOptions, ROARK, sheetOf, stubFetch, trainerById, TRISTAN } from './stubServer';

const TEAM: MonRef[] = ['party:1', 'party:2'];
const DRAFT: DraftMonJson[] = [{ ref: 'party:1' }, { ref: 'party:2' }];
const base = sheetOf(TRISTAN);
const SHEET: SheetJson = { ...base, enemies: ['Imp', 'Mouse', 'Gloom'].map((name, i) => ({ ...base.enemies[0]!, name, key: `enemy:${i}` })) };
const props = (): PlanViewProps => ({
  fight: { trainerId: TRISTAN, variant: 0 }, trainer: trainerById(TRISTAN), sheet: SHEET, sheetError: null, box: box(), team: TEAM, draft: DRAFT,
  options: draftOptions(), active: true, onDraftProblem: vi.fn(), onPlanning: vi.fn(), onAddToTeam: vi.fn(), teamDraft: stubDraft(TEAM, DRAFT),
  teamOpen: false, onToggleTeam: vi.fn(), step: postPlanStep,
});
const LIKELIEST = "Imp's Quick Attack on Blaze (Monferno) · their likeliest move, 62.5%";

const settled = () => waitFor(() => expect(document.querySelector('.plan-turn')).not.toHaveAttribute('aria-busy'));
const yourRows = () => screen.queryByRole('region', { name: 'Your move' });
const theirRows = () => screen.getByRole('region', { name: 'Their move' });
const heading = (region: HTMLElement) => within(region).getByRole('heading', { level: 4 }).textContent;
const mine = () => screen.getByRole('region', { name: 'Your Pokémon' });
const theirs = () => screen.getByRole('region', { name: 'Their Pokémon' });
const range = (card: HTMLElement) => card.querySelector('.band .band-range');
const tile = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

async function started(extra: Partial<PlanStepJson> = {}) {
  const server = planServer();
  Object.assign(server.extra, extra);
  stubFetch(server.routes);
  const view = render(<PlanView {...props()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Start with Blaze (Monferno)' }));
  await screen.findByRole('button', { name: /^Scratch/ });
  await settled();
  return { server, user, view };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows their likeliest move's rows first, his pick's rows once he picks a move, and the bands follow the moves shown", async () => {
  const { user } = await started();
  expect(yourRows()).toBeNull();
  expect(heading(theirRows())).toBe(LIKELIEST);
  expect(within(theirRows()).getByText('62.5%')).toHaveAttribute('title', expect.stringMatching(/^\d+\/\d+$/) as string);   // the exact fraction
  for (const legend of ['lowest roll', 'roll range', SPLIT_NOTE]) expect(screen.getByText(legend)).toBeInTheDocument();
  expect([range(mine()), range(theirs())].map((el) => el !== null)).toEqual([true, false]);
  await user.click(tile('Sand-Attack'));
  expect(range(mine())).toBeNull();                                         // a status move takes nothing off
  expect(theirRows()).toHaveTextContent('Status move · no damage');         // and the exchange says so in words
  await user.click(tile('Scratch'));
  await settled();
  expect(heading(yourRows()!)).toBe('Your Scratch on Imp');
  const split = within(yourRows()!).getByRole('region', { name: 'Scratch on Imp' });
  for (const row of ['Non-crit', 'Crit']) expect(within(split).getByText(row)).toBeInTheDocument();
  expect(range(theirs())).not.toBeNull();
  for (const card of [mine(), theirs()]) expect(card.querySelector('.band-caption')).toBeNull();   // the exchange says the numbers once
  await user.click(tile('Bench'));                                         // a switch pick shows no rows of his
  await settled();
  expect(tile('Bench')).toHaveAttribute('aria-pressed', 'true');
  expect(yourRows()).toBeNull();
  expect(theirRows()).toBeInTheDocument();
});

// The pick is the fight's, turn's and their Pokémon's: another fight's turn 1 shows its own likeliest.
it('the pick on the right is not carried to another fight on the same turn', async () => {
  const b = box();
  const mons = TEAM.map((ref) => planMonOf(b.mons.find((m) => m.ref === ref)!, DRAFT));
  localStorage.setItem(planCurrentKey(ROARK, 0), JSON.stringify({ v: 1, save: saveOf(b), plan: newPlan({ trainerId: ROARK, variant: 0, world: 0, mons, lead: mons[0]!.key, enemies: ['Imp', 'Mouse', 'Gloom'] }) }));
  const { user, view } = await started();
  await user.click(tile('Sand-Attack'));
  expect(heading(theirRows())).toBe("Imp's Sand-Attack on Blaze (Monferno) · 37.5%");
  view.rerender(<PlanView {...props()} fight={{ trainerId: ROARK, variant: 0 }} trainer={trainerById(ROARK)} />);
  await screen.findByRole('heading', { name: 'Battle plan · vs Leader Roark' });
  await screen.findByRole('button', { name: /^Scratch/ });
  await settled();
  expect(heading(theirRows())).toBe(LIKELIEST);
  expect([tile('Sand-Attack'), tile('Quick Attack')].map((b2) => b2.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
});

it('puts the exchange straight under "Your action", above the cards, with every help sentence behind an ⓘ', async () => {
  await started();
  const exchange = document.querySelector('.plan-splits')!;
  expect(document.querySelector('.plan-turn-head')!.compareDocumentPosition(exchange) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(exchange.compareDocumentPosition(document.querySelector('.plan-action')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  for (const words of [SPLIT_NOTE, NEXT_HINT, KO_KEY, 'Carries to the next turn.', 'every turn, with its note · click a row to edit it']) {
    expect(screen.getByText(words).closest('.info-tip-text'), words).toHaveAttribute('hidden');
  }
  expect(screen.getByText(REPLY_BLIND, { exact: false }).closest('.info-tip-text')).toHaveAttribute('hidden');
  for (const name of ['the damage rows', 'Your choice', 'Next turn', 'Next move likelihood', 'Field', 'Whole plan']) {
    expect(screen.getByRole('button', { name: `About ${name}` })).toBeInTheDocument();
  }
});

// The rows once had the sides swapped, so their sure KO of his Pokémon read green and his of theirs red.
it("their KO of his Pokémon reads as danger with the stripe, his of theirs as ok, and his card's bar says OHKO", async () => {
  const sure = { koExact: [r(1, 1), r(1, 1), r(1, 1), r(1, 1)], koCritExact: r(1, 1), ko: 1, koCrit: 1, percent: [110, 130] as [number, number], hp: [49, 57] as [number, number] };
  const { user } = await started({ damage: { ...NUMBERS, yours: NUMBERS.yours.map((m) => ({ ...m, ...sure })), theirs: NUMBERS.theirs.map((m, i) => (i === 0 ? { ...m, ...sure } : m)) } });
  const tones = (region: HTMLElement) => [...region.querySelectorAll('.crit-ko')].map((e) => (e.classList.contains('is-danger') ? 'danger' : e.classList.contains('is-ok') ? 'ok' : ''));
  expect(tones(theirRows())).toEqual(['danger', 'danger']);
  expect(theirRows()).toHaveClass('is-danger');
  expect(within(mine()).getByText('OHKO')).toBeInTheDocument();
  await user.click(tile('Scratch'));
  await settled();
  expect(tones(yourRows()!)).toEqual(['ok', 'ok']);
  expect(yourRows()).not.toHaveClass('is-danger');
});

it('no crit rate is printed but the one the answer carries', async () => {
  const withChance = (m: (typeof NUMBERS.yours)[number]) => ({ ...m, critChance: r(1, 8) });
  const { user } = await started({ damage: { ...NUMBERS, yours: NUMBERS.yours.map(withChance), theirs: NUMBERS.theirs.map(withChance) } });
  await user.click(tile('Scratch'));
  await settled();
  expect(document.querySelector('.plan-splits')).toHaveTextContent('12.5%');
  expect(document.querySelector('.plan-splits')!.textContent).not.toContain('6.25');
});
