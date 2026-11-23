// "Your action": the turn's two cards with their fainted marks, their send-in with the AI's odds, his replacement through
// his choices, the turn's note, their move split, and the way on (Next turn, Go to turn n, the end sentences). A turn with
// no numbers still takes a note, a mark and Next turn. The real client against the fake plan-step route: its view is
// always Blaze and Bench against Imp and Mouse, so a card's name is the plan's.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftMonJson, MonRef, SheetJson } from '../../../src/server/apiTypes';
import { postPlanStep } from '../../../web/src/api';
import { PlanView, type PlanViewProps } from '../../../web/src/components/PlanView';
import { PREVIOUS_NUMBERS } from '../../../web/src/components/plan/TurnAction';
import { NEXT_HINT, PICK_FIRST } from '../../../web/src/components/plan/TurnFoot';
import { turnOrderOf } from '../../../web/src/line';
import { readCurrentPlan } from '../../../web/src/planStore';
import { hpBarText } from '../../../web/src/tree';
import { NUMBERS, view } from './lineServer';
import { planServer } from './planServer';
import { stubDraft } from './planDraft';
import { box, draftOptions, sheetOf, stubFetch, trainerById, TRISTAN } from './stubServer';

const BOX = box();
/** Blaze as a Fire and Fighting type at Lv 17, so his token's colour and level show. */
const FIRE = { ...BOX, mons: BOX.mons.map((m) => (m.ref === 'party:1' ? { ...m, types: ['Fire', 'Fighting'], level: 17 } : m)) };
const TEAM: MonRef[] = ['party:1', 'party:2'];
const DRAFT: DraftMonJson[] = [{ ref: 'party:1' }, { ref: 'party:2' }];
const base = sheetOf(TRISTAN);
const SHEET: SheetJson = { ...base, enemies: ['Imp', 'Mouse', 'Gloom'].map((name, i) => ({ ...base.enemies[0]!, name, key: `enemy:${i}` })) };
const props = (): PlanViewProps => ({
  fight: { trainerId: TRISTAN, variant: 0 }, trainer: trainerById(TRISTAN), sheet: SHEET, sheetError: null, box: FIRE, team: TEAM, draft: DRAFT,
  options: draftOptions(), active: true, onDraftProblem: vi.fn(), onPlanning: vi.fn(), onAddToTeam: vi.fn(), teamDraft: stubDraft(TEAM, DRAFT),
  teamOpen: false, onToggleTeam: vi.fn(), step: postPlanStep,
});
const DOWN = { status: 502, json: {} };

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
const mine = () => screen.getByRole('region', { name: 'Your Pokémon' });
const theirs = () => screen.getByRole('region', { name: 'Their Pokémon' });
const markMine = () => within(mine()).getByRole('button', { name: /^Mark .* fainted$/ });
const markTheirs = () => within(theirs()).getByRole('button', { name: /^Mark .* fainted$/ });
const chips = () => within(screen.getByRole('navigation', { name: 'Turns' })).getAllByRole('button');
const next = () => screen.getByRole('button', { name: 'Next turn' });
const scratch = () => screen.findByRole('button', { name: /^Scratch/ });
const settled = () => waitFor(() => expect(document.querySelector('.plan-turn')).not.toHaveAttribute('aria-busy'));
const stored = () => readCurrentPlan(TRISTAN, 0)!.plan;
const colour = (el: HTMLElement) => el.querySelector<HTMLElement>('.tok')!.style.getPropertyValue('--tc');
const theWay = () => document.querySelector('.plan-way')!.textContent;

async function started(fail = false) {
  const server = planServer();
  stubFetch(server.routes);
  if (fail) server.gate.fail = DOWN;
  render(<PlanView {...props()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Start with Blaze (Monferno)' }));
  if (fail) await screen.findByRole('alert');
  else await scratch();
  await settled();
  const go = async () => { await user.click(next()); await settled(); };
  const mark = async (which: () => HTMLElement) => { await user.click(which()); await settled(); };
  return { server, user, go, mark };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Your action', () => {
  it('shows the turn order, both cards and tokens, his choices between them, and Next turn; the note is kept as typed and asks nothing', async () => {
    const { server, user } = await started();
    expect(document.querySelector('.plan-order')).toHaveTextContent(turnOrderOf(NUMBERS)!);
    expect(within(mine()).getByText('Your Pokémon')).toBeInTheDocument();
    expect(within(mine()).getByText('HP 44/44')).toBeInTheDocument();
    expect(within(mine()).getByText('Blaze · no item')).toBeInTheDocument();
    expect(markMine()).toHaveAccessibleName('Mark Blaze (Monferno) fainted');
    expect(within(theirs()).getByText('Their Pokémon')).toBeInTheDocument();
    expect(within(theirs()).getByText(hpBarText(view().enemy.active!))).toBeInTheDocument();
    expect(markTheirs()).toHaveAccessibleName('Mark Imp fainted');
    // His token takes the disc colour of his Pokémon's first type; theirs stays neutral.
    expect([colour(mine()), colour(theirs())]).toEqual(['var(--type-fire, var(--type-unknown))', 'var(--type-unknown)']);
    expect(mine().querySelector('.disc')).toHaveTextContent(/^Bl/);
    expect(within(document.querySelector<HTMLElement>('.plan-action .plan-pick')!).getByRole('button', { name: /^Scratch/ })).toBeInTheDocument();
    expect(screen.queryByText(/\b(win|lose|dead|death)\b/i)).toBeNull();
    expect(next()).toHaveClass('button', 'button-primary');
    expect(next()).not.toHaveAttribute('aria-disabled');
    expect(screen.getByText(NEXT_HINT)).toBeInTheDocument();

    const asked = server.requests().length;
    const note = screen.getByLabelText('Turn 1 note');
    expect(note.tagName).toBe('TEXTAREA');
    await user.type(note, 'a{Enter}b');
    expect(note).toHaveValue('a\nb');
    expect(stored().turns[0]!.note).toBe('a\nb');
    expect(within(chips()[0]!).getByText('note')).toHaveClass('pill');
    await flush();
    expect(server.requests()).toHaveLength(asked);
  });

  it('Mark fainted toggles with one click each way, and is held, never disabled, while the turn is worked out', async () => {
    const { server, user } = await started();
    let release!: () => void;
    server.gate.hold = new Promise<void>((r) => { release = r; });
    await user.click(markTheirs());
    expect(markTheirs()).toHaveAttribute('aria-disabled', 'true');
    expect(markTheirs()).not.toBeDisabled();
    await user.click(markTheirs());                                         // ignored
    release();
    await settled();
    expect(markTheirs()).not.toHaveAttribute('aria-disabled');
    expect(markTheirs()).toHaveAttribute('aria-pressed', 'true');
    expect(markTheirs()).toHaveTextContent('Fainted · undo');
    expect(theirs()).toHaveClass('is-fainted');
    expect(within(theirs()).getByText('fainted')).toHaveClass('pill');
    expect(screen.getByText('1 of 3 marked fainted')).toBeInTheDocument();
    expect(within(chips()[0]!).getByText('fainted')).toHaveClass('pill');
    await settled();
    await user.click(markTheirs());
    expect(markTheirs()).toHaveAttribute('aria-pressed', 'false');
    expect(markTheirs()).toHaveTextContent('Mark fainted');
    expect(theirs()).not.toHaveClass('is-fainted');
    expect(screen.getByText('0 of 3 marked fainted')).toBeInTheDocument();
    expect(within(chips()[0]!).queryByText('fainted')).toBeNull();
    expect(stored().turns[0]).toMatchObject({ sendIn: {}, fainted: {} });
  });

  it('their send-in picker preselects the likeliest, shows the odds, and the pick comes in next turn', async () => {
    const { user, go, mark } = await started();
    expect(screen.queryByRole('group', { name: 'Who comes in?' })).toBeNull();
    await mark(markTheirs);
    const group = within(theirs()).getByRole('group', { name: 'Who comes in?' });
    expect(within(group).getByRole('heading', { name: 'Who comes in?' })).toBeInTheDocument();
    const choice = (name: string) => within(theirs()).getByRole('button', { name });
    expect(within(group).getAllByRole('button').map((b) => [b.textContent, b.getAttribute('aria-pressed'), b.getAttribute('title')])).toEqual([
      ['Mouse · 25%', 'false', '1/4'], ['Gloom · 75%', 'true', '3/4'],
    ]);
    await user.click(choice('Mouse · 25%'));
    expect([choice('Mouse · 25%'), choice('Gloom · 75%')].map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    await go();
    expect(chips()).toHaveLength(2);
    expect(markTheirs()).toHaveAccessibleName('Mark Mouse fainted');
  });

  it('a send-out the AI cannot decide is said in the picker once, the names in party order, the first standing picked', async () => {
    const words = "The AI's behaviour is undefined here (AI_UNDEFINED: no rule for this)";
    const { server, mark } = await started();
    server.extra = { sendOutError: words, sendOut: undefined };   // the route sends one or the other
    await mark(markTheirs);
    const group = within(theirs()).getByRole('group', { name: 'Who comes in?' });
    expect(within(group).getByText(words)).toBeInTheDocument();
    expect(screen.getAllByText(words)).toHaveLength(1);
    expect(within(group).getAllByRole('button').map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Mouse', 'true'], ['Gloom', 'false']]);
  });

  it('his faint asks who comes in, and Next turn waits for it', async () => {
    const { user, go, mark } = await started();
    await mark(markMine);
    expect(screen.getByRole('heading', { name: 'One of yours fainted: send out' })).toBeInTheDocument();
    expect(next()).toHaveAttribute('aria-disabled', 'true');
    expect(next()).not.toBeDisabled();
    expect(next()).toHaveAccessibleDescription(PICK_FIRST);
    await user.click(next());
    expect(chips()).toHaveLength(1);
    // The fake route's view names his second team member "Bench"; it is Starly (party:2), the request's team[1].
    await user.click(screen.getByRole('button', { name: /^Bench/ }));
    expect(next()).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText(PICK_FIRST)).toBeNull();
    await go();
    expect(chips()).toHaveLength(2);
    expect(markMine()).toHaveAccessibleName('Mark Starly fainted');
  });

  it("an earlier turn's button goes on, not adds", async () => {
    const { user, go } = await started();
    await go();
    await go();
    await user.click(chips()[0]!);
    await settled();
    expect(screen.queryByRole('button', { name: 'Next turn' })).toBeNull();
    const on = screen.getByRole('button', { name: 'Go to turn 2' });
    expect(on).toHaveClass('button-primary');
    await user.click(on);
    await settled();
    expect(chips()).toHaveLength(3);
    expect(chips()[1]).toHaveAttribute('aria-current', 'true');
    expect(screen.getByLabelText('Turn 2 note')).toBeInTheDocument();
  });

  it('the end sentences, in plain words, never a win or a loss', async () => {
    const first = await started();
    for (let turn = 1; turn <= 3; turn++) {
      await first.mark(markTheirs);
      if (turn < 3) await first.go();
    }
    expect(screen.getByText('All of theirs are marked fainted, so the plan ends here.')).toHaveClass('banner');
    expect(theWay()).not.toMatch(/(won|win|wins|lost|lose|odds)|%/i);
    expect(screen.queryByRole('button', { name: /^(Next turn|Go to turn)/ })).toBeNull();
    cleanup();
    localStorage.clear();
    const again = await started();
    await again.mark(markMine);
    await again.user.click(screen.getByRole('button', { name: /^Bench/ }));
    await again.go();
    await again.mark(markMine);
    expect(screen.getByText('All of yours are marked fainted, so the plan ends here. Undo a faint to keep going.')).toHaveClass('banner');
    expect(theWay()).not.toMatch(/(won|win|wins|lost|lose|odds)|%/i);
    expect(screen.queryByRole('button', { name: 'Next turn' })).toBeNull();
  });

  it('a turn with no numbers still shows his token, and takes a note, a mark and Next turn', async () => {
    const { server, user } = await started(true);
    expect(screen.queryByRole('button', { name: /^Scratch/ })).toBeNull();
    expect(document.querySelector('.plan-order')).toBeNull();
    expect(mine()).toHaveTextContent('Blaze (Monferno)');
    expect(within(mine()).queryByText(/^HP /)).toBeNull();
    expect(colour(mine())).toBe('var(--type-fire, var(--type-unknown))');
    expect(mine().querySelector('.disc em')).toBeNull();              // the level once, beside the name
    expect(within(mine()).getByText('Lv 17')).toBeInTheDocument();
    expect(theirs()).toHaveTextContent('Imp');
    expect(within(theirs()).queryByText(/HP bar/)).toBeNull();
    expect(theirs().querySelector('.disc')).toBeNull();
    await user.type(screen.getByLabelText('Turn 1 note'), 'no numbers');
    server.gate.fail = DOWN;
    await user.click(markTheirs());
    await screen.findByRole('alert');
    await settled();
    expect(markTheirs()).toHaveAttribute('aria-pressed', 'true');
    expect(within(theirs()).getAllByRole('button', { name: /^(Mouse|Gloom)$/ })).toHaveLength(2);
    await user.click(next());
    await flush();
    expect(chips()).toHaveLength(2);
    expect(stored().turns.map((t) => t.note)).toEqual(['no numbers', '']);
  });

  it("while a failure stands, the turn's earlier numbers say they are", async () => {
    const { server, user } = await started();
    expect(screen.queryByText(PREVIOUS_NUMBERS)).toBeNull();
    server.gate.fail = DOWN;
    await user.click(screen.getByRole('button', { name: 'Trick Room' }));
    await screen.findByRole('alert');
    expect(await scratch()).toBeInTheDocument();
    expect(screen.getByText(PREVIOUS_NUMBERS)).toHaveClass('line-muted');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByText(PREVIOUS_NUMBERS)).toBeNull();
  });

  it("the centre's their-move split follows the likelihood list's pick, the likeliest pressed first, and each turn has its own", async () => {
    const { user, go } = await started();
    const split = () => screen.getByRole('region', { name: 'Their move' });
    const pressed = () => ['Quick Attack', 'Sand-Attack'].map((name) => screen.getByRole('button', { name: new RegExp(`^${name}`) }).getAttribute('aria-pressed'));
    expect(split()).toHaveTextContent(/Imp's Quick Attack on Blaze.* · their likeliest move, 62\.5%/);
    expect(within(split()).getByRole('region', { name: 'Quick Attack on Blaze (Monferno)' })).toBeInTheDocument();
    expect(pressed()).toEqual(['true', 'false']);
    await user.click(screen.getByRole('button', { name: /^Sand-Attack/ }));
    expect(split()).toHaveTextContent(/Imp's Sand-Attack on Blaze.* · 37\.5%/);
    expect(split()).not.toHaveTextContent('their likeliest move');
    expect(within(split()).getByRole('region', { name: 'Sand-Attack on Blaze (Monferno)' })).toBeInTheDocument();
    expect(pressed()).toEqual(['false', 'true']);
    await go();
    await flush();
    expect(chips()).toHaveLength(2);
    expect(split()).toHaveTextContent(/Imp's Quick Attack on Blaze.* · their likeliest move/);
    expect(pressed()).toEqual(['true', 'false']);
  });
});
