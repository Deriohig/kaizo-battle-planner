// The box tray and the team slots (BoxAndTeam.tsx) against a mocked `UseDraft`: each action is asserted as the call it
// makes. The fixture: Blaze `party:1` and Starly `party:2` (the team), Big `box:1:4` over the cap (listed), `box:2:1`
// and the dead `box:15:1` (not listed), and Mon1..Mon4 in box 3. `Live` is a team that really changes, for where focus
// goes. Each row's actions sit in its ⋯ menu, "Actions for <name>"; `menuItem()` opens it first.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { BoxJson, MonRef } from '../../../src/server/apiTypes';
import { BoxAndTeam } from '../../../web/src/components/plan/BoxAndTeam';
import { carriesMon, MON_MIME, readDraggedMon, writeDraggedMon } from '../../../web/src/monDrag';
import type { UseDraft } from '../../../web/src/useDraft';
import { FakeTransfer } from './fakeTransfer';
import { stubDraft } from './planDraft';
import { box, mon } from './stubServer';

const base = (): BoxJson => {
  const b = box();
  b.mons.push(...[1, 2, 3, 4].map((s) => mon(`box:3:${s}` as MonRef, { nickname: '', species: `Mon${s}` })));
  return b;
};
const FULL: MonRef[] = ['party:1', 'party:2', 'box:3:1', 'box:3:2', 'box:3:3', 'box:3:4'];

function setup(team: MonRef[] = ['party:1', 'party:2'], busy = false, b: BoxJson = base(), run: { active?: MonRef; fainted?: MonRef[] } = {}) {
  const draft = stubDraft(team);
  const onTry = vi.fn();
  const view = render(<BoxAndTeam box={b} draft={draft} active={run.active ?? null} fainted={run.fainted ?? []} busy={busy} onTry={onTry} />);
  return { draft, onTry, view };
}

/** A team that changes when the buttons ask, as `useDraft` would (add, remove, moveTo). */
function Live({ initial }: { initial: MonRef[] }) {
  const [team, setTeam] = useState(initial);
  const [b] = useState(base);
  const draft: UseDraft = {
    ...stubDraft(team),
    add: (ref) => setTeam((t) => (t.length >= 6 || t.includes(ref) ? t : [...t, ref])),
    remove: (ref) => setTeam((t) => t.filter((r) => r !== ref)),
    moveTo: (from, to) => setTeam((t) => {
      const next = [...t];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    }),
  };
  return <BoxAndTeam box={b} draft={draft} active={null} fainted={[]} busy={false} onTry={() => {}} />;
}

const tray = () => screen.getByRole('region', { name: /^Box \(/ });
const teamRegion = () => screen.getByRole('region', { name: /^Team \(/ });
const slots = () => within(teamRegion()).getAllByRole('listitem');
const carrying = (ref: string) => {
  const t = new FakeTransfer();
  writeDraggedMon({ dataTransfer: t as unknown as DataTransfer }, ref as MonRef);
  return { dataTransfer: t };
};
const foreign = () => {
  const t = new FakeTransfer();
  t.setData('text/plain', 'box:1:4');
  return { dataTransfer: t };
};
const asEvent = (t: FakeTransfer | null) => ({ dataTransfer: t as unknown as DataTransfer | null });
const cardOf = (el: HTMLElement) => el.closest('[draggable="true"]') as HTMLElement;
const card = (name: string) => cardOf(screen.getByText(name));
const root = () => document.querySelector('.box-and-team')!;
const focusedName = () => document.activeElement?.getAttribute('aria-label') ?? null;
const teamNames = () => slots().map((s) => s.querySelector('.tok > strong')?.textContent ?? 'Empty');
const menuButton = (name: string) => screen.getByRole('button', { name: `Actions for ${name}` });
const menuItem = (name: string, label: string) => {
  if (menuButton(name).getAttribute('aria-expanded') !== 'true') fireEvent.click(menuButton(name));
  return screen.getByRole('menuitem', { name: label });
};
/** Every draft change the component asked for, as [method, ...args]. */
const draftCalls = (d: UseDraft) => (['place', 'moveTo', 'remove', 'add'] as const).flatMap((k) => (d[k] as Mock).mock.calls.map((c) => [k, ...c]));

beforeEach(() => localStorage.clear());

describe('monDrag', () => {
  it('writes a ref as JSON under its type and reads back only a well-formed ref', () => {
    const t = new FakeTransfer();
    expect(carriesMon(asEvent(t))).toBe(false);
    writeDraggedMon(asEvent(t), 'box:1:4');
    expect([t.data.get(MON_MIME), t.effectAllowed, readDraggedMon(asEvent(t)), carriesMon(asEvent(t))]).toEqual(['"box:1:4"', 'move', 'box:1:4', true]);
    const f = foreign().dataTransfer;
    expect([readDraggedMon(asEvent(f)), carriesMon(asEvent(f))]).toEqual([null, false]);
    expect([readDraggedMon(asEvent(null)), carriesMon(asEvent(null))]).toEqual([null, false]);
    for (const raw of ['{not json', '"party:x"', '"box:1"', '"box:1:4 "', '"hello"', '42', '["party:1"]', '{"ref":"party:1"}', 'null', '']) {
      const junk = new FakeTransfer();
      junk.setData(MON_MIME, raw);
      expect(readDraggedMon(asEvent(junk)), raw).toBeNull();
    }
  });
});

describe('the lists', () => {
  it('the tray lists what can join and is not on the team; the team has six slots, the first leading', () => {
    const b = base();
    b.mons.push(mon('box:3:5', { nickname: 'Chestnut', species: 'Slugma', level: 22 }));
    setup(['party:1', 'party:2'], false, b);
    expect(within(tray()).getByRole('heading', { name: 'Box (6)' })).toBeInTheDocument();
    expect(within(tray()).getByRole('group', { name: 'Chestnut (Slugma) Lv 22' })).toBeInTheDocument();
    expect(within(tray()).getByText('Big (Bibarel)')).toHaveAttribute('title', 'Big (Bibarel)');   // a long name in full on hover
    expect(within(tray()).getByText(/over cap/)).toBeInTheDocument();
    expect(within(tray()).queryByText(/Bidoof|species 414|Blaze/)).toBeNull();
    expect(within(teamRegion()).getByRole('heading', { name: 'Team (2)' })).toBeInTheDocument();
    expect(slots().map((s) => s.textContent === 'Empty')).toEqual([false, false, true, true, true, true]);
    expect(slots()[0]).toHaveTextContent('Leads');
    expect(slots()[1]).not.toHaveTextContent('Leads');
  });

  it('a party Pokémon out of the team is listed first', () => {
    setup(['party:2']);
    expect(within(tray()).getAllByRole('listitem')[0]).toHaveTextContent('Blaze (Monferno)');
  });

  it('how to drag sits behind one ⓘ per section; a token draws a hidden disc and has one ⋯ button', () => {
    setup();
    const tip = 'Drag into a team slot, or onto “Your Pokémon” to try it on this turn.';
    expect(within(tray()).getByRole('button', { name: 'About Box' })).toHaveAttribute('title', tip);
    expect(within(teamRegion()).getByRole('button', { name: 'About Team' })).toHaveAttribute('title', 'The six you bring. Drag to reorder, to the box, or onto the turn.');
    expect(screen.getByText(tip)).not.toBeVisible();
    expect(document.querySelector('.box-and-team-body > section > p')).toBeNull();

    const tok = within(slots()[0]!).getByText('Blaze (Monferno)').closest('.tok') as HTMLElement;
    expect(tok).toHaveClass('tok-m');
    expect(tok.style.getPropertyValue('--tc')).toBe('var(--type-normal, var(--type-unknown))');
    const disc = tok.querySelector('.disc')!;
    expect(disc).toHaveAttribute('aria-hidden', 'true');
    expect(disc.querySelector('em')).toBeNull();
    expect(tok).toHaveTextContent(/^BlBlaze \(Monferno\)Lv 15$/);
    for (const name of ['Big (Bibarel)', 'Blaze (Monferno)']) expect(within(card(name)).getAllByRole('button')).toEqual([menuButton(name)]);
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  it('the CSS wraps a long name, stacks the rows and outlines an empty slot only while a Pokémon is carried', () => {
    const css = readFileSync(resolve(__dirname, '../../../web/src/styles/run.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (selector: string) => new RegExp(`${selector.replace(/[.[\]()]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)![1];
    expect(rule(".box-and-team [draggable='true'] .tok > strong")).toMatch(/white-space:\s*normal/);
    expect(rule(".box-and-team [draggable='true'] .tok > strong")).not.toMatch(/ellipsis/);
    expect(rule('.box-and-team ul')).toMatch(/flex-direction:\s*column/);
    expect(rule(".box-and-team [draggable='true']")).toMatch(/min-height:\s*36px/);
    const dashed = [...css.matchAll(/([^{}]+)\{([^}]*dashed[^}]*)\}/g)].map((m) => m[1]!.trim());
    expect(dashed).toContain('.box-and-team.is-dragging li.slot.is-empty');
    expect(dashed.filter((sel) => sel.includes('slot') && !sel.includes('.is-dragging'))).toEqual([]);
  });
});

describe('drag and drop', () => {
  const slot = (i: number) => () => slots()[i]!;
  it.each<[string, string, () => HTMLElement, unknown[] | null, MonRef[]?]>([
    ['a box Pokémon on an occupied slot is placed there', 'box:1:4', slot(1), ['place', 1, 'box:1:4']],
    ['a box Pokémon on an empty slot is placed at that index', 'box:1:4', slot(4), ['place', 4, 'box:1:4']],
    ['with a full team a box Pokémon on an occupied slot is still placed', 'box:1:4', slot(2), ['place', 2, 'box:1:4'], FULL],
    ['a member on another slot moves there', 'party:1', slot(1), ['moveTo', 0, 1]],
    ['a member on an empty slot goes to the end of the team', 'party:1', slot(5), ['moveTo', 0, 1]],
    ['a member on the tray comes off the team', 'party:2', tray, ['remove', 'party:2']],
    ['a box Pokémon on the tray does nothing', 'box:1:4', tray, null],
    ['a member on its own slot does nothing', 'party:1', slot(0), null],
  ])('%s', (_, ref, target, call, team) => {
    const { draft } = setup(team);
    fireEvent.dragOver(target(), carrying(ref));
    fireEvent.drop(target(), carrying(ref));
    expect(draftCalls(draft)).toEqual(call === null ? [] : [call]);
  });

  it('a stale ref, data from outside the page or no data at all does nothing, and foreign data is not claimed', () => {
    const { draft } = setup();
    for (const target of [slots()[1]!, slots()[4]!, tray()]) {
      for (const ref of ['box:9:9', 'box:15:1', 'box:2:1']) fireEvent.drop(target, carrying(ref));
      fireEvent.drop(target, foreign());
      expect(fireEvent.dragOver(target, carrying('box:1:4')), 'a Pokémon').toBe(false);
      expect(fireEvent.dragOver(target, foreign()), 'foreign data').toBe(true);
    }
    fireEvent.drop(slots()[0]!, { dataTransfer: null });
    expect(draftCalls(draft)).toEqual([]);
  });

  it('dragstart on a token writes its ref, from the tray, a slot, and a row with its menu open', () => {
    setup();
    for (const [name, ref] of [['Big (Bibarel)', '"box:1:4"'], ['Starly', '"party:2"']]) {
      const t = new FakeTransfer();
      fireEvent.dragStart(card(name!), { dataTransfer: t });
      expect(t.data.get(MON_MIME)).toBe(ref);
    }
    fireEvent.click(menuButton('Starly'));
    const t = new FakeTransfer();
    fireEvent.dragStart(cardOf(menuButton('Starly')), { dataTransfer: t });
    expect(t.data.get(MON_MIME)).toBe('"party:2"');
  });

  it('the root is is-dragging from dragstart to drop or dragend, and the hovered zone is-over; a file is no drag', () => {
    setup();
    const big = card('Big (Bibarel)');
    const files = new FakeTransfer();
    files.setData('Files', '');
    fireEvent.dragStart(root(), { dataTransfer: files });
    expect(root()).not.toHaveClass('is-dragging');
    fireEvent.dragStart(big, { dataTransfer: new FakeTransfer() });
    expect(root()).toHaveClass('is-dragging');
    fireEvent.dragEnter(slots()[3]!, carrying('box:1:4'));
    fireEvent.dragOver(slots()[3]!, carrying('box:1:4'));
    expect(slots()[3]).toHaveClass('is-over');
    fireEvent.dragLeave(slots()[3]!, { relatedTarget: document.body });
    expect(slots()[3]).not.toHaveClass('is-over');
    fireEvent.dragEnd(big);
    expect(root()).not.toHaveClass('is-dragging');
    fireEvent.dragStart(card('Starly'), { dataTransfer: new FakeTransfer() });
    fireEvent.dragOver(tray(), carrying('party:2'));
    expect(tray()).toHaveClass('is-over');
    fireEvent.drop(tray(), carrying('party:2'));
    expect(root()).not.toHaveClass('is-dragging');
    expect(tray()).not.toHaveClass('is-over');
  });

  it('is-dragging clears on dragend when the carried card has gone, and when the box changes', () => {
    const b = base();
    const { view, draft } = setup(['party:1', 'party:2'], false, b);
    const starly = card('Starly');
    fireEvent.dragStart(starly, { dataTransfer: new FakeTransfer() });
    view.rerender(<BoxAndTeam box={b} draft={{ ...draft, team: ['party:1'] }} active={null} fainted={[]} busy={false} onTry={vi.fn()} />);
    expect(starly.isConnected).toBe(false);
    expect(root()).toHaveClass('is-dragging');
    fireEvent.dragEnd(starly);
    expect(root()).not.toHaveClass('is-dragging');
    fireEvent.dragStart(card('Big (Bibarel)'), { dataTransfer: new FakeTransfer() });
    expect(root()).toHaveClass('is-dragging');
    view.rerender(<BoxAndTeam box={base()} draft={draft} active={null} fainted={[]} busy={false} onTry={vi.fn()} />);
    expect(root()).not.toHaveClass('is-dragging');
  });

  it('no highlight and no claim where a drop changes nothing; a drag from elsewhere still lights', () => {
    const { view } = setup();
    const claims = (target: HTMLElement, ref: string) => {
      const claimed = !fireEvent.dragOver(target, carrying(ref));
      expect(target.classList.contains('is-over')).toBe(claimed);
      return claimed;
    };
    expect([claims(tray(), 'box:1:4'), claims(slots()[1]!, 'party:2')]).toEqual([true, true]);     // no known source
    view.unmount();
    setup();
    const big = card('Big (Bibarel)');
    fireEvent.dragStart(big, { dataTransfer: new FakeTransfer() });
    expect([claims(tray(), 'box:1:4'), claims(slots()[3]!, 'box:1:4')]).toEqual([false, true]);
    fireEvent.dragEnd(big);
    const starly = card('Starly');
    fireEvent.dragStart(starly, { dataTransfer: new FakeTransfer() });
    expect([claims(slots()[1]!, 'party:2'), claims(slots()[0]!, 'party:2'), claims(tray(), 'party:2')]).toEqual([false, true, true]);
    fireEvent.dragEnd(starly);
    expect(fireEvent.dragOver(slots()[1]!, carrying('party:2'))).toBe(false);          // nothing known again
  });
});

describe('the ⋯ menu', () => {
  it('is a button named for the Pokémon that opens a menu of its actions, focus on the first', () => {
    setup();
    const button = menuButton('Big (Bibarel)');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'Actions for Big (Bibarel)' });
    expect(button).toHaveAttribute('aria-controls', menu.id);
    expect(within(menu).getAllByRole('menuitem').map((el) => el.getAttribute('aria-label'))).toEqual(['Try Big (Bibarel)', 'Add Big (Bibarel) to the team']);
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Try Big (Bibarel)' }));
    fireEvent.click(button);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('the arrows move between every item (an unavailable one too, so its state is heard), Home and End go to the ends', async () => {
    const user = userEvent.setup();
    setup();
    menuButton('Blaze (Monferno)').focus();
    const [TRY, BOX, EARLIER, LATER] = ['Try Blaze (Monferno)', 'Put Blaze (Monferno) back in the box', 'Move Blaze (Monferno) earlier', 'Move Blaze (Monferno) later'];
    const steps: [string, string | undefined][] = [
      ['{ArrowDown}', TRY], ['{ArrowDown}', BOX], ['{ArrowDown}', EARLIER], ['{ArrowDown}', LATER], ['{ArrowDown}', TRY],
      ['{ArrowUp}', LATER], ['{ArrowLeft}', EARLIER], ['{Home}', TRY], ['{End}', LATER],
    ];
    for (const [key, item] of steps) {
      await user.keyboard(key);
      expect(focusedName(), key).toBe(item);
      if (item === EARLIER) expect(document.activeElement).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('Escape closes it and puts focus back on its button; ArrowUp opens it on the last item, even an unavailable one', async () => {
    const user = userEvent.setup();
    setup();
    menuButton('Starly').focus();
    await user.keyboard('{Enter}');
    expect(focusedName()).toBe('Try Starly');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(menuButton('Starly'));
    expect(menuButton('Starly')).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{ArrowUp}');
    expect(focusedName()).toBe('Move Starly later');
    expect(document.activeElement).toHaveAttribute('aria-disabled', 'true');
  });

  it('Tab and a press outside close it, and one menu is open at a time', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(menuButton('Starly'));
    await user.tab();
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(menuButton('Starly'));
    await user.click(within(teamRegion()).getByRole('heading', { name: 'Team (2)' }));
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(menuButton('Blaze (Monferno)'));
    await user.click(menuButton('Starly'));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(menuButton('Blaze (Monferno)')).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('the actions', () => {
  it('Try calls onTry with the ref, from the tray and from a slot, and closes the menu, focus back on its button', async () => {
    const user = userEvent.setup();
    const { onTry } = setup();
    await user.click(menuButton('Big (Bibarel)'));
    await user.click(screen.getByRole('menuitem', { name: 'Try Big (Bibarel)' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(menuButton('Big (Bibarel)'));
    fireEvent.click(menuItem('Starly', 'Try Starly'));
    expect(onTry.mock.calls).toEqual([['box:1:4'], ['party:2']]);
  });

  it.each([
    ['Big (Bibarel)', 'Add Big (Bibarel) to the team', ['add', 'box:1:4']],
    ['Blaze (Monferno)', 'Put Blaze (Monferno) back in the box', ['remove', 'party:1']],
    ['Starly', 'Move Starly earlier', ['moveTo', 1, 0]],
    ['Blaze (Monferno)', 'Move Blaze (Monferno) later', ['moveTo', 0, 1]],
  ])('%s: %s, even while busy', (name, label, call) => {
    const { draft } = setup(['party:1', 'party:2'], true);
    fireEvent.click(menuItem(name, label));
    expect(draftCalls(draft)).toEqual([call]);
  });

  it('while busy Try is unavailable but reachable, and a press is ignored', () => {
    const { onTry } = setup(['party:1', 'party:2'], true);
    const item = menuItem('Big (Bibarel)', 'Try Big (Bibarel)');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).not.toBeDisabled();
    fireEvent.click(item);
    expect(screen.getByRole('menu', { name: 'Actions for Big (Bibarel)' })).toBeInTheDocument();
    fireEvent.click(menuItem('Starly', 'Try Starly'));
    expect(onTry).not.toHaveBeenCalled();
  });

  it('earlier and later stop at the ends', () => {
    const { draft } = setup();
    for (const [name, label] of [['Blaze (Monferno)', 'Move Blaze (Monferno) earlier'], ['Starly', 'Move Starly later']]) {
      const item = menuItem(name!, label!);
      expect(item).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(item);
    }
    expect(draftCalls(draft)).toEqual([]);
  });

  // A `disabled` item could not be reached, so its reason never reached a keyboard or a reader.
  it('Add with a full team is unavailable but reachable: aria-disabled, the reason as its description, a press ignored', async () => {
    const { draft } = setup(FULL);
    const user = userEvent.setup();
    menuButton('Big (Bibarel)').focus();
    await user.keyboard('{ArrowUp}');
    const item = screen.getByRole('menuitem', { name: 'Add Big (Bibarel) to the team' });
    expect(document.activeElement).toBe(item);
    expect(item).not.toBeDisabled();
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAccessibleDescription('The team is full (6)');
    expect(item).toHaveAttribute('title', 'The team is full (6)');
    await user.keyboard('{Enter}');
    fireEvent.click(item);
    expect(draft.add).not.toHaveBeenCalled();
    expect(screen.getByRole('menu', { name: 'Actions for Big (Bibarel)' })).toBeInTheDocument();
    expect(document.activeElement).toBe(item);
  });

  it('the one on the field says so with the accent edge, a fainted one says Fainted, no slot leads, and Try works for all', () => {
    const { onTry } = setup(['party:1', 'party:2'], false, base(), { active: 'party:1', fainted: ['party:2', 'box:1:4'] });
    const blaze = cardOf(within(slots()[0]!).getByText('Blaze (Monferno)'));
    expect(within(blaze).getByText('On the field')).toHaveClass('visually-hidden');
    expect(blaze).toHaveClass('is-active');
    expect(blaze).not.toHaveClass('is-fainted');
    expect(slots()[0]).not.toHaveTextContent('Leads');
    const starly = cardOf(within(slots()[1]!).getByText('Starly'));
    expect(within(starly).getByText('Fainted')).toBeInTheDocument();
    expect(starly).toHaveClass('is-fainted');
    expect(starly).not.toHaveClass('is-active');
    expect(within(tray()).getByText('Fainted')).toBeInTheDocument();
    expect(within(tray()).queryByText('On the field')).toBeNull();
    for (const name of ['Blaze (Monferno)', 'Starly', 'Big (Bibarel)']) {
      const item = menuItem(name, `Try ${name}`);
      expect(item).not.toHaveAttribute('aria-disabled');
      fireEvent.click(item);
    }
    expect(onTry.mock.calls.map((c) => c[0])).toEqual(['party:1', 'party:2', 'box:1:4']);
  });
});

describe('focus follows the Pokémon', () => {
  it('Earlier pressed twice moves the same Pokémon two places, its menu open and focus staying on its item', async () => {
    const user = userEvent.setup();
    render(<Live initial={['party:1', 'party:2', 'box:3:1']} />);
    menuItem('Mon1', 'Move Mon1 earlier').focus();
    await user.keyboard('{Enter}');
    expect(teamNames().slice(0, 3)).toEqual(['Blaze (Monferno)', 'Mon1', 'Starly']);
    expect(focusedName()).toBe('Move Mon1 earlier');
    await user.keyboard('{Enter}');
    expect(teamNames().slice(0, 3)).toEqual(['Mon1', 'Blaze (Monferno)', 'Starly']);
    expect(focusedName()).toBe('Move Mon1 later');                 // at the front Earlier is unavailable
    await user.keyboard('{Enter}');
    expect(teamNames().slice(0, 3)).toEqual(['Blaze (Monferno)', 'Mon1', 'Starly']);
    expect(focusedName()).toBe('Move Mon1 later');
    expect(screen.getByRole('menu', { name: 'Actions for Mon1' })).toBeInTheDocument();
  });

  it("Box moves focus to the next row's ⋯ button, else the previous, else the heading", async () => {
    const user = userEvent.setup();
    render(<Live initial={['party:1', 'party:2', 'box:3:1']} />);
    menuItem('Starly', 'Put Starly back in the box').focus();
    await user.keyboard('{Enter}');
    expect(teamNames().slice(0, 3)).toEqual(['Blaze (Monferno)', 'Mon1', 'Empty']);
    expect(focusedName()).toBe('Actions for Mon1');
    await user.keyboard('{Enter}');                       // opens Mon1's menu on Try
    await user.keyboard('{ArrowRight}');
    expect(focusedName()).toBe('Put Mon1 back in the box');
    await user.keyboard('{Enter}');
    expect(teamNames()[1]).toBe('Empty');
    expect(focusedName()).toBe('Actions for Blaze (Monferno)');
    menuItem('Blaze (Monferno)', 'Put Blaze (Monferno) back in the box').focus();
    await user.keyboard('{Enter}');
    expect(teamNames()[0]).toBe('Empty');
    expect(document.activeElement).toBe(within(teamRegion()).getByRole('heading', { name: 'Team (0)' }));
  });

  it("Add in the tray moves focus to the next row's ⋯ button in the tray, else the previous", async () => {
    const user = userEvent.setup();
    render(<Live initial={['party:1']} />);
    menuItem('Big (Bibarel)', 'Add Big (Bibarel) to the team').focus();      // the tray: Starly, Big, Mon1..Mon4
    await user.keyboard('{Enter}');
    expect(teamNames()[1]).toBe('Big (Bibarel)');
    expect(focusedName()).toBe('Actions for Mon1');
    menuItem('Mon4', 'Add Mon4 to the team').focus();
    await user.keyboard('{Enter}');
    expect(focusedName()).toBe('Actions for Mon3');
  });
});

it('the band toggle flips aria-expanded, hides both sections, and keeps it for next time', () => {
  const { view } = setup();
  const toggle = screen.getByRole('button', { name: 'Hide box and team' });
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const body = document.getElementById(toggle.getAttribute('aria-controls')!)!;
  expect(body).not.toHaveClass('box-and-team');
  expect(body).toContainElement(tray());
  expect(body).toContainElement(teamRegion());
  fireEvent.click(toggle);
  expect(screen.getByRole('button', { name: 'Show box and team' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: /^(Box|Team) \(/ })).toBeNull();
  expect(localStorage.getItem('pkp.plan.trayHidden')).toBe('1');
  view.unmount();
  setup();                                                         // starts hidden when it was kept hidden
  fireEvent.click(screen.getByRole('button', { name: 'Show box and team' }));
  expect(tray()).toBeInTheDocument();
  expect(teamRegion()).toBeInTheDocument();
  expect(localStorage.getItem('pkp.plan.trayHidden')).toBeNull();
});
