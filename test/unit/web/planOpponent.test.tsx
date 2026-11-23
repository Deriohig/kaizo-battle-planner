// The opponent card: their Pokémon on the field as the sheet has it, and their team with its fainted marks as the turn has
// them; and the plan screen's sprites: his card the back view, theirs and the opponent card the front, the rows the icon,
// and the initials wherever no species is known. The cards alone, then on the plan screen against the fake route.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftMonJson, MonRef, SheetJson } from '../../../src/server/apiTypes';
import { postPlanStep } from '../../../web/src/api';
import { MonCard } from '../../../web/src/components/plan/MonCard';
import { OpponentCard } from '../../../web/src/components/plan/OpponentCard';
import { PlanView, type PlanViewProps } from '../../../web/src/components/PlanView';
import { planMonOf } from '../../../web/src/components/plan/planScreen';
import { WholePlan } from '../../../web/src/components/plan/WholePlan';
import { saveOf } from '../../../web/src/line';
import { newPlan } from '../../../web/src/plan';
import { planCurrentKey } from '../../../web/src/planStore';
import { planServer } from './planServer';
import { stubDraft } from './planDraft';
import { box, draftOptions, ROARK, sheetOf, stubFetch, trainerById, TRISTAN } from './stubServer';

const NAMES = ['Imp', 'Mouse', 'Gloom'];
const base = sheetOf(TRISTAN);
/** Imp (Lv 5, Guts, a Focus Sash, three moves), Mouse and Gloom; each enemy's fields changed by `over`. */
const sheet = (over: (i: number) => object = () => ({})): SheetJson => ({
  ...base,
  enemies: NAMES.map((name, i) => ({
    ...base.enemies[0]!, name, key: `enemy:${i}`, level: 5 + i, ability: i === 0 ? 'Guts' : 'Keen Eye', item: i === 0 ? 'Focus Sash' : null,
    moves: i === 0 ? ['Quick Attack', 'Sand-Attack', 'Rock Slide'] : ['Tackle'], stats: { hp: 44, atk: 19, def: 28, spa: 24, spd: 27, spe: 15 }, ...over(i),
  })),
});
const card = () => screen.getByRole('region', { name: 'Opponent' });
const roster = () => within(card()).getByRole('list', { name: 'Their team' });
const items = () => within(roster()).getAllByRole('listitem');
const srcs = (c: Element) => Array.from(c.querySelectorAll('img')).map((i) => i.getAttribute('src'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('OpponentCard', () => {
  it("shows the active's level, ability, item, moves and stats from the sheet, the item pill only with an item", () => {
    const { rerender } = render(<OpponentCard enemies={NAMES} sheet={sheet()} active={0} fainted={[]} />);
    expect(within(card()).getByRole('heading', { name: 'Opponent' })).toBeInTheDocument();
    expect(card()).toHaveTextContent('Lv 5');
    expect(within(card()).getByText('Guts')).toHaveClass('pill');
    expect(within(card()).getByText('holds Focus Sash')).toHaveClass('pill');
    expect(within(card()).getByText('Moves: Quick Attack · Sand-Attack · Rock Slide')).toBeInTheDocument();
    expect(within(card()).getByText('HP 44 · Atk 19 · Def 28 · SpA 24 · SpD 27 · Spe 15')).toBeInTheDocument();
    rerender(<OpponentCard enemies={NAMES} sheet={sheet()} active={1} fainted={[]} />);
    expect(within(card()).queryByText(/^holds/)).toBeNull();
    expect(within(card()).getByText('Keen Eye')).toHaveClass('pill');
  });

  it('the roster lists three to look at, the active marked current, a fainted one so; without the sheet the names still list', () => {
    const { rerender } = render(<OpponentCard enemies={NAMES} sheet={sheet()} active={1} fainted={[0]} />);
    const [imp, mouse, gloom] = items() as [HTMLElement, HTMLElement, HTMLElement];
    expect(items()).toHaveLength(3);
    expect(mouse).toHaveAttribute('aria-current', 'true');
    expect(mouse).toHaveClass('selected');
    expect(imp).not.toHaveAttribute('aria-current');
    expect(imp).toHaveTextContent('Imp fainted');
    expect(within(imp).getByText('fainted')).toHaveClass('is-fainted');
    expect(gloom).toHaveTextContent('Gloom Lv 7');
    expect(within(roster()).queryAllByRole('button')).toHaveLength(0);
    rerender(<OpponentCard enemies={NAMES} sheet={null} active={0} fainted={[]} />);
    expect(items().map((li) => li.querySelector('strong')!.textContent)).toEqual(NAMES);
    expect(card()).not.toHaveTextContent(/Moves:|Lv/);
  });

  it('shows the active one front and every roster chip its icon (speciesId and formId), initials without one, the level once beside the name', () => {
    const looks: [number | undefined, number | undefined][] = [[41, undefined], [30, 2], [undefined, undefined]];
    render(<OpponentCard enemies={NAMES} sheet={sheet((i) => ({ level: 21, speciesId: looks[i]![0], ...(looks[i]![1] === undefined ? {} : { formId: looks[i]![1] }) }))} active={0} fainted={[]} />);
    expect(srcs(card())).toEqual(['/api/sprites/front/41.png', '/api/sprites/icon/41.png', '/api/sprites/icon/30-2.png']);
    expect(items()[2]!.querySelector('img')).toBeNull();
    expect(items()[2]!.querySelector('.disc')).toHaveTextContent('Gl');
    const active = document.querySelector('.plan-opponent-active')!;
    expect(active.querySelector('.disc em')).toBeNull();
    expect(active.querySelector('.tok small')).toHaveTextContent('Lv 21');
  });
});

describe('the plan cards and rows', () => {
  const monCard = (p: Partial<Parameters<typeof MonCard>[0]>) => (
    <MonCard side="mine" name="Prinplup" mon={null} fainted={false} onToggleFainted={vi.fn()} busy={false} band={null} types={['Water']} level={20} {...p} />
  );
  const lineMon = { ident: 'x', name: 'x', species: 'x', speciesId: undefined, level: 20, hp: 40, maxHp: 44, percent: 90, status: null, ability: 'Guts', item: null } as never;

  it.each<[string, Partial<Parameters<typeof MonCard>[0]>, string[]]>([
    ['his card shows the back sprite', { species: 394 }, ['/api/sprites/back/394.png']],
    ['their card shows the front sprite', { side: 'theirs', name: 'Gloom', species: 44 }, ['/api/sprites/front/44.png']],
    ['a card with no species falls back to initials', { mon: lineMon }, []],
  ])('%s, and says the level once, beside the name', (_, p, sprites) => {
    const { container } = render(monCard(p));
    expect(srcs(container)).toEqual(sprites);
    if (sprites.length === 0) expect(container.querySelector('.disc')).toHaveTextContent('Pr');
    else {
      expect(container.querySelector('.disc em')).toBeNull();
      expect(container.querySelector('.tok small')).toHaveTextContent('Lv 20');
    }
  });

  it('a Whole plan row shows his icon, or initials when the look has no species', () => {
    const row = (mine: string, turn: number) => ({ turn, mine, theirs: 'Imp', pick: null, fainted: [], note: '', excerpt: '', current: false });
    const { container } = render(<WholePlan rows={[row('Prinplup', 1), row('Starly', 2)]} fightNote="" onJump={vi.fn()} onFightNote={vi.fn()}
      look={(n) => (n === 'Prinplup' ? { level: 20, types: ['Water'], species: 394 } : { level: 8, types: ['Normal'] })} />);
    expect(srcs(container)).toEqual(['/api/sprites/icon/394.png']);
    expect(container.querySelectorAll('.plan-row-mine .disc')[1]).toHaveTextContent('St');
  });
});

describe('The opponent card on the plan screen', () => {
  const TEAM: MonRef[] = ['party:1', 'party:2'];
  const DRAFT: DraftMonJson[] = [{ ref: 'party:1' }, { ref: 'party:2' }];
  const props = (): PlanViewProps => ({
    fight: { trainerId: TRISTAN, variant: 0 }, trainer: trainerById(TRISTAN), sheet: sheet(), sheetError: null, box: box(), team: TEAM, draft: DRAFT,
    options: draftOptions(), active: true, onDraftProblem: vi.fn(), onPlanning: vi.fn(), onAddToTeam: vi.fn(), teamDraft: stubDraft(TEAM, DRAFT),
    teamOpen: false, onToggleTeam: vi.fn(), step: postPlanStep,
  });
  const settled = () => waitFor(() => expect(document.querySelector('.plan-turn')).not.toHaveAttribute('aria-busy'));
  beforeEach(() => localStorage.clear());

  it('is first in the right column; a marked one reads fainted and the active moves to who comes in next turn', async () => {
    stubFetch(planServer().routes);
    render(<PlanView {...props()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Start with Blaze (Monferno)' }));
    await screen.findByRole('button', { name: /^Scratch/ });
    await settled();
    expect(document.querySelector('.plan-right')!.firstElementChild).toBe(card());
    expect(items()[0]).toHaveAttribute('aria-current', 'true');
    await user.click(within(screen.getByRole('region', { name: 'Their Pokémon' })).getByRole('button', { name: /^Mark .* fainted$/ }));
    await settled();
    expect(items()[0]).toHaveTextContent('Imp fainted');
    await user.click(screen.getByRole('button', { name: 'Next turn' }));
    await settled();
    expect(items()[0]).toHaveTextContent('Imp fainted');
    expect(items()[2]).toHaveAttribute('aria-current', 'true');
    expect(card()).toHaveTextContent('Gloom');
  });

  // The sheet still on the page is the last trainer's until this one's lands: the card shows none of it.
  it("while this trainer's sheet loads, the card shows the plan's names and a loading line, never the last trainer's details", async () => {
    stubFetch(planServer().routes);
    const mons = TEAM.map((ref) => planMonOf(box().mons.find((m) => m.ref === ref)!, DRAFT));
    localStorage.setItem(planCurrentKey(TRISTAN, 0), JSON.stringify({ v: 1, save: saveOf(box()), plan: newPlan({ trainerId: TRISTAN, variant: 0, world: 0, mons, lead: mons[0]!.key, enemies: NAMES }) }));
    const roark = sheetOf(ROARK);
    const last: SheetJson = { ...roark, enemies: NAMES.map((name, i) => ({ ...roark.enemies[0]!, name, key: `enemy:${i}`, level: 40, ability: 'Sturdy', moves: ['Stealth Rock'] })) };
    const view = render(<PlanView {...props()} sheet={last} />);
    await screen.findByRole('heading', { name: 'Battle plan · vs Youngster Tristan' });
    await settled();
    expect(card()).toHaveTextContent('Imp');
    expect(card()).not.toHaveTextContent(/Sturdy|Stealth Rock|Lv 40/);
    expect(within(card()).getByText('Loading their details…')).toHaveClass('line-muted');
    view.rerender(<PlanView {...props()} />);
    expect(within(card()).getByText('Guts')).toHaveClass('pill');
    expect(within(card()).queryByText('Loading their details…')).toBeNull();
  });
});
