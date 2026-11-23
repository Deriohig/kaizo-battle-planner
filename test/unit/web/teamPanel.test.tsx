// The team column (TeamPanel over useDraft): the save's party at first, then the team kept in the browser for this save,
// changed with move, remove, add, a typed level, all to the cap, all to full HP, Reset to save and the editor. The
// fixture `box()`: Blaze `party:1` Lv 15 (HP 30/44) asleep, Starly `party:2` Lv 14 (HP 38/38), Big `box:1:4` Lv 20 over
// the cap (16), an unknown species `box:2:1`, a dead Bidoof `box:15:1`.

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BoxJson, MonRef } from '../../../src/server/apiTypes';
import { changedText, changesOf } from '../../../web/src/components/draft/changes';
import { TeamPanel } from '../../../web/src/components/TeamPanel';
import { DRAFT_KEY } from '../../../web/src/draft';
import { boxTeamText, teamText } from '../../../web/src/teamText';
import { useDraft } from '../../../web/src/useDraft';
import { stubDraft } from './planDraft';
import { box, draftOptions, mon, stubFetch } from './stubServer';

beforeEach(() => {
  localStorage.clear();
  stubFetch({ 'GET /api/draft/options': { json: draftOptions() } });
});

function Harness({ box, problem = null }: { box: BoxJson | null; problem?: string | null }) {
  return <TeamPanel box={box} boxProblem={null} draft={useDraft(box)} problem={problem} />;
}

const rows = () => within(screen.getByRole('list', { name: 'Team' })).getAllByRole('listitem').map((li) => li.textContent);
/** Opens `name`'s ⋯ menu (Move up, Move down, Remove) and gives back its item `label`. */
function teamItem(name: string, label: string): HTMLElement {
  const button = screen.getByRole('button', { name: `Actions for ${name}` });
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
  return screen.getByRole('menuitem', { name: label });
}
const level = (name: string) => screen.getByRole('spinbutton', { name: `Level of ${name}` });
const setLevel = async (user: UserEvent, name: string, n: number | string) => {
  await user.clear(level(name));
  await user.type(level(name), `${n}{Enter}`);
};
const kept = () => JSON.parse(localStorage.getItem(DRAFT_KEY)!).team;

describe('TeamPanel', () => {
  it("starts as the save's party, one line a row, its status and marks under it only when there are any", () => {
    render(<Harness box={box()} />);
    expect(rows()[0]).toMatch(/Blaze \(Monferno\).*HP 30\/44.*Asleep \(2 turns\)/);
    expect(rows()[1]).toMatch(/Starly.*HP 38\/38/);
    expect([level('Blaze (Monferno)'), level('Starly')].map((f) => (f as HTMLInputElement).value)).toEqual(['15', '14']);
    expect(rows().join(' ')).not.toMatch(/Lead|Healthy|Edited|Changed/);
    const [blaze, starly] = within(screen.getByRole('list', { name: 'Team' })).getAllByRole('listitem');
    const line = (li: HTMLElement) => Array.from(li.children).map((el) => el.className.split(' ').find((c) => c.startsWith('team-panel-') || c.startsWith('card-menu')));
    const parts = ['team-panel-name', 'team-panel-level', 'team-panel-fact', 'team-panel-edit', 'card-menu-button'];
    expect(line(starly!)).toEqual(parts);
    expect(line(blaze!)).toEqual([...parts, 'team-panel-marks']);
    expect(within(blaze!).getByText('Asleep (2 turns)').closest('.team-panel-marks')).not.toBeNull();
    expect(within(starly!).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Edit Starly', 'Actions for Starly']);
    expect(screen.getByRole('button', { name: 'About Team for this fight' })).toHaveAttribute('title', 'For planning only. Your save is not changed.');
    expect(screen.getByText('For planning only. Your save is not changed.')).not.toBeVisible();
  });

  it('move, remove and add change the team and what is kept; a Pokémon over the cap may join, marked', async () => {
    const user = userEvent.setup();
    render(<Harness box={box()} />);
    await user.click(teamItem('Starly', 'Move Starly up'));
    await user.click(teamItem('Blaze (Monferno)', 'Remove Blaze (Monferno)'));
    expect(screen.getByRole('option', { name: 'Big (Bibarel) Lv 20 · over the level cap (16)' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Bidoof|species 414/ })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Add from the box'), 'box:1:4');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(rows()[1]).toMatch(/Big \(Bibarel\).*over the level cap \(16\)/);
    expect(level('Big (Bibarel)')).toHaveValue(20);
    expect(kept()).toEqual([{ ref: 'party:2' }, { ref: 'box:1:4' }]);
  });

  it('Move up is off on the first row and Move down on the last; a move keeps the menu open on the moved row', async () => {
    const user = userEvent.setup();
    render(<Harness box={box()} />);
    expect(teamItem('Blaze (Monferno)', 'Move Blaze (Monferno) up')).toHaveAttribute('aria-disabled', 'true');
    expect(teamItem('Blaze (Monferno)', 'Move Blaze (Monferno) down')).not.toHaveAttribute('aria-disabled');
    expect(teamItem('Starly', 'Move Starly down')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Starly' }));        // closed again
    screen.getByRole('button', { name: 'Actions for Starly' }).focus();
    await user.keyboard('{Enter}');
    const menu = screen.getByRole('menu', { name: 'Actions for Starly' });
    expect(within(menu).getAllByRole('menuitem').map((el) => el.getAttribute('aria-label'))).toEqual(['Move Starly up', 'Move Starly down', 'Remove Starly']);
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Move Starly up' }));
    await user.keyboard('{Enter}');
    expect(rows()[0]).toMatch(/^Starly/);
    expect(rows()[1]).toMatch(/^Blaze \(Monferno\)/);
    expect(rows()[1]).not.toMatch(/Lead/);
    // Now first, Move up is off: focus moves to its neighbour, the menu still open.
    expect(screen.getByRole('menuitem', { name: 'Move Starly up' })).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Move Starly down' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for Starly' }));
  });

  it('a full team has no add row and says nothing; an empty team says so; no box says why', () => {
    const six = box({ mons: [...[1, 2, 3, 4, 5, 6].map((i) => mon(`party:${i}`, { nickname: `P${i}` })), mon('box:1:1', { nickname: 'Spare' })] });
    const { rerender } = render(<Harness box={six} />);
    expect(rows()).toHaveLength(6);
    expect(screen.queryByText(/team is full/)).toBeNull();
    expect(screen.queryByLabelText('Add from the box')).toBeNull();
    for (const i of [1, 2, 3, 4, 5, 6]) fireEvent.click(teamItem(`P${i} (Starly)`, `Remove P${i} (Starly)`));
    expect(screen.getByText('Nobody is in the team. Add a Pokémon to start a fight.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Team' })).toBeNull();
    expect(screen.getByLabelText('Add from the box')).toBeInTheDocument();
    rerender(<Harness box={null} />);
    expect(screen.getByText('Reading the save…')).toBeInTheDocument();
    rerender(<TeamPanel box={null} boxProblem="x" draft={stubDraft([])} problem={null} />);
    expect(screen.getByText('The save did not read: x')).toBeInTheDocument();
    expect(screen.queryByText('Reading the save…')).toBeNull();
  });

  it('says nobody else in the box can join when everyone who can is in the team', () => {
    render(<Harness box={box({ mons: box().mons.filter((m) => m.ref !== 'box:1:4') })} />);
    expect(screen.getByText('Nobody else in the box can join.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Add from the box')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  it('the team is there on the first render with a box, so the first sheet request already has it', () => {
    const seen: MonRef[][] = [];
    function Probe({ box }: { box: BoxJson | null }) {
      seen.push(useDraft(box).team);
      return null;
    }
    const { rerender } = render(<Probe box={null} />);
    expect(seen.every((team) => team.length === 0)).toBe(true);
    const before = seen.length;
    rerender(<Probe box={box()} />);
    expect(seen[before]).toEqual(['party:1', 'party:2']);
  });

  it('a level typed in the row changes the level, the HP it starts on and what is kept, and says what changed', async () => {
    const user = userEvent.setup();
    render(<Harness box={box()} />);
    await setLevel(user, 'Blaze (Monferno)', 16);
    expect(rows()[0]).toMatch(/HP 32\/46.*Changed: Lv 16(?!,| and)/);
    expect(rows()[1]).not.toMatch(/Changed/);
    expect(rows().join(' ')).not.toMatch(/Lead|Edited/);
    expect(kept()[0]).toEqual({ ref: 'party:1', level: 16 });
    await setLevel(user, 'Blaze (Monferno)', 17);
    expect(rows()[0]).toMatch(/over the level cap \(16\)/);
  });

  it.each([[101, 15], [0, 14]])('a level of %i snaps back and the row says why, until the field holds a valid level (%i)', async (bad, good) => {
    const user = userEvent.setup();
    render(<Harness box={box()} />);
    await setLevel(user, 'Starly', bad);
    expect(level('Starly')).toHaveValue(14);
    expect(rows()[1]).toMatch(/Level must be 1 to 100\./);
    expect(rows()[0]).not.toMatch(/Level must be/);
    await setLevel(user, 'Starly', good);                          // 14 is the level it already shows: nothing is sent
    expect(level('Starly')).toHaveValue(good);
    expect(rows()[1]).not.toMatch(good === 14 ? /Level must be|Changed/ : /Level must be/);
  });

  it('All to the level cap sets every level; it is off when it would change nothing; Reset to save puts the party back', async () => {
    const user = userEvent.setup();
    render(<Harness box={box()} />);
    const toCap = () => screen.getByRole('button', { name: 'All to the level cap (16)' });
    expect(screen.getByRole('button', { name: 'Reset to save' })).toBeDisabled();
    await setLevel(user, 'Blaze (Monferno)', 16);
    expect(toCap()).toBeEnabled();                                     // Starly is still 14
    await user.click(toCap());
    expect([level('Blaze (Monferno)'), level('Starly')].map((f) => (f as HTMLInputElement).value)).toEqual(['16', '16']);
    await setLevel(user, 'Starly', 20);
    expect(toCap()).toBeDisabled();                                    // one at the cap, one above it
    await user.click(teamItem('Starly', 'Move Starly up'));
    await user.click(screen.getByRole('button', { name: 'Reset to save' }));
    expect(rows()[0]).toMatch(/^Blaze \(Monferno\)/);
    expect(level('Starly')).toHaveValue(14);
    await user.click(teamItem('Blaze (Monferno)', 'Remove Blaze (Monferno)'));
    await user.click(teamItem('Starly', 'Remove Starly'));
    expect(toCap()).toBeDisabled();                                    // nobody in the team
  });

  it('All to full HP fills every Pokémon in one click, and is off once all are full', async () => {
    const user = userEvent.setup();
    render(<Harness box={box()} />);
    await user.click(screen.getByRole('button', { name: 'All to full HP' }));
    expect(rows()[0]).toMatch(/HP 44\/44.*Changed: HP 44\/44/);
    expect(rows()[1]).not.toMatch(/Changed/);                          // Starly was full already
    expect(kept()).toEqual([{ ref: 'party:1', hp: 44 }, { ref: 'party:2' }]);
    expect(screen.getByRole('button', { name: 'All to full HP' })).toBeDisabled();
  });

  it("Edit opens that Pokémon's editor under its row, one at a time; Reset, Close and Remove", async () => {
    const user = userEvent.setup();
    render(<Harness box={box()} />);
    await user.click(screen.getByRole('button', { name: 'Edit Starly' }));
    expect(screen.getByRole('button', { name: 'Edit Starly' })).toHaveAttribute('aria-expanded', 'true');
    const editor = screen.getByRole('region', { name: 'Edit Starly' });
    await user.selectOptions(within(editor).getByLabelText('Status'), 'Burned');
    await user.click(within(editor).getByRole('button', { name: '1 HP' }));
    expect(rows()[1]).toMatch(/HP 1\/38.*Burned.*Changed: HP 1\/38 and burned/);
    await user.click(within(editor).getByRole('button', { name: 'Reset Starly to the save' }));
    expect(within(editor).getByLabelText('Status')).toHaveValue('none');
    await user.click(screen.getByRole('button', { name: 'Edit Blaze (Monferno)' }));
    expect(screen.queryByRole('region', { name: 'Edit Starly' })).toBeNull();
    expect(rows()[1]).toMatch(/HP 38\/38/);
    expect(rows()[1]).not.toMatch(/Burned|Changed/);
    expect(kept()[1]).toEqual({ ref: 'party:2' });
    await user.click(within(screen.getByRole('region', { name: 'Edit Blaze (Monferno)' })).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: /^Edit / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit Blaze (Monferno)' })).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('button', { name: 'Edit Blaze (Monferno)' }));
    await user.click(teamItem('Blaze (Monferno)', 'Remove Blaze (Monferno)'));
    expect(screen.queryByRole('region', { name: /^Edit / })).toBeNull();
  });

  it('the same save sent again keeps the team; a changed save says the team was reset, with one Undo', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness box={box()} />);
    await setLevel(user, 'Starly', 16);
    rerender(<Harness box={box({ levelCap: 20 })} />);
    expect(level('Starly')).toHaveValue(16);
    await user.click(screen.getByRole('button', { name: 'Edit Blaze (Monferno)' }));   // its editor has a status line of its own
    rerender(<Harness box={box({ savedAt: '2026-06-12T13:00:00.000Z' })} />);
    const notice = screen.getByRole('status', { name: 'Your save changed' });
    expect(notice).toHaveTextContent('Your save changed, so the team was reset to it.');
    expect(screen.getAllByRole('button', { name: 'Undo' })).toEqual([within(notice).getByRole('button', { name: 'Undo' })]);
    expect(level('Starly')).toHaveValue(14);
    await user.click(within(notice).getByRole('button', { name: 'Undo' }));
    expect(level('Starly')).toHaveValue(16);
    expect(screen.queryByRole('status', { name: 'Your save changed' })).toBeNull();
  });

  it('a refused fight start is said above the team', () => {
    render(<Harness box={box()} problem="Starly: HP must be a whole number from 1 to 38, not 0" />);
    expect(screen.getByRole('alert')).toHaveTextContent('The fight did not start. Starly: HP must be a whole number from 1 to 38, not 0');
  });
});

describe('what the team panel says changed', () => {
  const O = draftOptions();
  const starly = box().mons[1]!;
  const stats = { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
  it.each<[string, Parameters<typeof changesOf>[2], string[]]>([
    ['no edits', { ref: 'party:2' }, []],
    ['a level', { ref: 'party:2', level: 22 }, ['Lv 22']],
    ['an HP', { ref: 'party:2', hp: 1 }, ['HP 1/38']],
    ['a status', { ref: 'party:2', status: 'burn' }, ['burned']],
    ['sleep', { ref: 'party:2', status: 'sleep:2' }, ['asleep (2 turns)']],
    ['an EXP edit', { ref: 'party:2', exp: 3000 }, ['EXP']],
    ['an EXP edit with the level', { ref: 'party:2', level: 15, exp: 3375 }, ['Lv 15']],
    ['an item', { ref: 'party:2', item: 234 }, ['item']],
    ['moves', { ref: 'party:2', moves: [{ id: 33 }] }, ['moves']],
    ['IVs', { ref: 'party:2', ivs: stats }, ['IVs']],
    ['EVs', { ref: 'party:2', evs: stats }, ['EVs']],
    ['a nature', { ref: 'party:2', nature: 3 }, ['nature']],
    ['several, in a fixed order', { ref: 'party:2', nature: 3, evs: stats, status: 'burn', level: 22, item: 234 }, ['Lv 22', 'burned', 'item', 'EVs', 'nature']],
  ])('changesOf names %s', (_, entry, names) => {
    expect(changesOf(starly, O, entry)).toEqual(names);
  });

  it('changesOf names a healed save status; changedText says none, up to three, or three and more', () => {
    expect(changesOf(mon('party:2', { status: 'poison' }), O, { ref: 'party:2', status: 'none' })).toEqual(['healthy']);
    expect(changedText([])).toBeNull();
    expect(changedText(['Lv 22'])).toBe('Changed: Lv 22');
    expect(changedText(['Lv 22', 'HP 1/61', 'burned'])).toBe('Changed: Lv 22, HP 1/61 and burned');
    expect(changedText(['Lv 22', 'HP 1/61', 'burned', 'item', 'moves'])).toBe('Changed: Lv 22, HP 1/61, burned and more');
  });
});

describe('teamText', () => {
  const [A, B] = ['A\n- Tackle', 'B\n- Growl'];
  it.each<[(string | null)[], string]>([
    [[A, B], `${A}\n\n${B}`], [[A], A], [[A, null, B], `${A}\n\n${B}`], [[null, A, null], A], [[], ''], [[null, null], ''],
  ])('joins %j with one blank line between sets, nulls skipped', (sets, text) => {
    expect(teamText(sets)).toBe(text);
  });

  it('boxTeamText leaves out an egg and a Pokémon with no set, and keeps the order', () => {
    const egg = { showdown: 'Riolu\n- Quick Attack', ineligibleReasons: ['egg'] };
    expect(boxTeamText([{ showdown: B, ineligibleReasons: ['over cap'] }, egg, { showdown: null, ineligibleReasons: ['bad checksum'] }, { showdown: A, ineligibleReasons: [] }]))
      .toBe(`${B}\n\n${A}`);
    expect(boxTeamText([egg])).toBe('');
  });
});
