import { act, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxJson, BoxMonJson } from '../../../src/server/apiTypes';
import { App } from '../../../web/src/App';
import { BoxView } from '../../../web/src/components/BoxView';
import { Header, type HeaderStatus } from '../../../web/src/components/Header';
import { OLD_KEYS } from '../../../web/src/run';
import {
  box, FakeEventSource, mon, SAVE_12_JUNE, SAVE_23_MAY, settings, setup, sheetOf, stubEventSource, stubFetch, trainers, TRISTAN,
} from './stubServer';

/** What `GET /api/box` answers (422) when the chosen save copy has moved or gone. */
const SAVE_GONE = `Cannot read ${SAVE_12_JUNE}: ENOENT: no such file or directory, stat '${SAVE_12_JUNE}'`;
/** A `savedAt` five minutes after the fixture box's: the game saved again. */
const LATER = '2026-06-12T12:05:00.000Z';

/** The table row that names `name`; within the Box tab when the whole page shows (the Run tab names Pokémon too). */
function row(name: string): HTMLElement {
  const tr = within(screen.queryByRole('tabpanel', { name: 'Box' }) ?? document.body).getByText(name).closest('tr');
  if (tr === null) throw new Error(`no row for ${name}`);
  return tr;
}
const COLUMNS = ['Where', 'Pokémon', 'Lv', 'Nature', 'IVs', 'Ability', 'Item', 'Moves', 'HP', 'Status', 'Eligible', 'Notes'];
const cell = (tr: HTMLElement, column: string) => within(tr).getAllByRole('cell')[COLUMNS.indexOf(column)]!;
/** The table's row groups after the column headings, one per place that holds Pokémon. */
const groups = () => screen.getAllByRole('rowgroup').slice(1);
const groupName = (g: HTMLElement) => within(g).getByRole('rowheader').textContent;
function group(name: string): HTMLElement {
  const found = groups().find((g) => groupName(g) === name);
  if (found === undefined) throw new Error(`no group ${name}`);
  return found;
}
const namesIn = (g: HTMLElement) => within(g).getAllByRole('row').slice(1).map((tr) => cell(tr, 'Pokémon').textContent);
const egg = (ref: BoxMonJson['ref']) => mon(ref, { nickname: 'Egg', species: 'Riolu', eligible: false, ineligibleReasons: ['egg'] });

describe('BoxView', () => {
  it('lists every Pokémon with its place, moves, HP and status, and says in words why one cannot fight', () => {
    render(<BoxView box={box({ mons: [
      ...box().mons,
      mon('party:3', { species: 'Shinx', nickname: 'SHINX', hp: 0, eligible: false, ineligibleReasons: ['fainted'] }),
      egg('box:3:1'),
      mon('box:3:2', { species: 'Unreadable', nickname: '', level: 0, moves: [], eligible: false, ineligibleReasons: ['bad checksum'] }),
    ] })} />);
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(COLUMNS);
    const blaze = row('Blaze (Monferno)');
    const shown = Object.fromEntries(['Where', 'Lv', 'Item', 'Moves', 'HP', 'Status'].map((column) => [column, cell(blaze, column).textContent]));
    expect(shown).toMatchObject({ Where: 'Party 1', Lv: '15', Item: 'Oran Berry', HP: '30/44', Status: 'Asleep (2 turns)' });
    expect(shown.Moves).toContain('Mach Punch 28/30');
    expect(within(blaze).getByText('Iron Fist boosts punching moves by 20%')).toBeInTheDocument();
    expect(cell(row('Bidoof'), 'Where')).toHaveTextContent('Box 15, slot 1');
    for (const [name, eligible] of [
      ['Blaze (Monferno)', 'Yes'], ['Bidoof', 'In the graveyard'], ['Big (Bibarel)', 'Over the level cap'],
      ['(species 414 form 1)', 'Unknown species 414 form 1'], ['Shinx', 'Fainted'], ['Egg (Riolu)', 'Egg'], ['Unreadable', 'Bad checksum'],
    ]) expect(cell(row(name!), 'Eligible')).toHaveTextContent(eligible!);
  });

  it("shows each Pokémon's IVs coloured by value with the nature's marks, their total, Hidden Power and the EVs", () => {
    render(<BoxView box={box({ mons: [
      mon('party:1', {
        nickname: 'Blaze', species: 'Monferno', ivs: { hp: 31, atk: 26, def: 12, spa: 10, spd: 7, spe: 24 },
        evs: { hp: 4, atk: 252, def: 1, spa: 2, spd: 3, spe: 250 }, natureEffect: { up: 'def', down: 'spa' }, hiddenPower: { type: 'Steel', power: 61 },
      }),
      mon('box:1:2', {
        species: 'Unreadable', nickname: '', level: 0, moves: [], eligible: false, ineligibleReasons: ['bad checksum'], ivs: null, evs: null, hiddenPower: null, natureEffect: null,
      }),
    ] })} />);
    const ivs = cell(row('Blaze (Monferno)'), 'IVs');
    const chips = [...ivs.querySelectorAll<HTMLElement>('span.box-iv')];
    // The nature's marks: an arrow to see, words to hear after a space. No other chip has a mark.
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'HP 31', 'Atk 26', 'Def 12↑ raised by the nature', 'SpA 10↓ lowered by the nature', 'SpD 7', 'Spe 24',
    ]);
    expect(chips.map((chip) => chip.style.getPropertyValue('--iv'))).toEqual(['31', '26', '12', '10', '7', '24']);
    expect(within(chips[2]!).getByText('↑')).toHaveAttribute('aria-hidden', 'true');
    expect(within(chips[2]!).getByText('raised by the nature')).toHaveClass('visually-hidden');
    expect(within(chips[3]!).getByText('↓')).toHaveAttribute('aria-hidden', 'true');
    expect(within(chips[3]!).getByText('lowered by the nature')).toHaveClass('visually-hidden');
    expect(within(ivs).getByText('Total 110')).toBeInTheDocument();
    expect(within(ivs).getByText('Hidden Power Steel 61')).toBeInTheDocument();
    expect(within(ivs).getByText('EVs 4 / 252 / 1 / 2 / 3 / 250')).toHaveClass('box-evs');
    expect(cell(row('Unreadable'), 'IVs')).toHaveTextContent(/^—$/);
  });

  it('groups the Pokémon by place, each opened by its heading; a graveyard box says it is left out', () => {
    render(<BoxView box={box()} />);
    expect(groups().map((g) => [groupName(g), namesIn(g)])).toEqual([
      ['Party', ['Blaze (Monferno)', 'Starly']], ['Box 1', ['Big (Bibarel)']], ['Box 2', ['(species 414 form 1)']], ['Box 15', ['Bidoof']],
    ]);
    for (const g of groups()) {
      expect(within(g).getByRole('rowheader')).toHaveAttribute('scope', 'rowgroup');
      expect(within(g).getAllByRole('row')[0]).toContainElement(within(g).getByRole('rowheader'));
    }
    expect(within(group('Box 15')).getByText('Graveyard: always left out')).toBeInTheDocument();
    expect(within(group('Box 1')).queryByText('Graveyard: always left out')).toBeNull();
  });

  it('"Eligible only" hides the rows that cannot fight and the groups with nothing left, and shows them again', async () => {
    const user = userEvent.setup();
    render(<BoxView box={box()} />);
    const toggle = screen.getByRole('checkbox', { name: 'Eligible only' });
    await user.click(toggle);
    expect(groups().map(groupName)).toEqual(['Party']);
    expect(screen.queryByText('Bidoof')).toBeNull();
    expect(screen.queryByText('In the graveyard')).toBeNull();
    await user.click(toggle);
    expect(groups().map(groupName)).toEqual(['Party', 'Box 1', 'Box 2', 'Box 15']);
  });

  it('copies a place\'s sets in slot order: eggs and set-less Pokémon left out, graveyards and hidden rows kept', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const b = box();
    const sparky = mon('box:1:6', { nickname: 'Sparky', species: 'Shinx', level: 12, moves: [{ name: 'Spark', pp: 20, maxPp: 20 }] });
    b.mons.splice(3, 0, egg('box:1:5'), sparky);
    b.mons.push(egg('box:16:1'));
    const [blaze, starly, big] = b.mons;
    const bidoof = b.mons.find((m) => m.species === 'Bidoof')!;
    render(<BoxView box={b} />);
    // No button for a box of only an egg, or only a Pokémon with no set (box 2).
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Copy party', 'Copy box 1', 'Copy box 15']);
    await user.click(within(group('Box 15')).getByRole('button', { name: 'Copy box 15' }));
    expect(writeText).toHaveBeenLastCalledWith(bidoof.showdown);
    await user.click(within(group('Party')).getByRole('button', { name: 'Copy party' }));
    expect(writeText).toHaveBeenLastCalledWith([blaze, starly].map((m) => m!.showdown).join('\n\n'));
    expect(await within(group('Party')).findByText('Copied')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Eligible only' }));
    expect(namesIn(group('Box 1'))).toEqual(['Sparky (Shinx)']);
    const copyBox = within(group('Box 1')).getByRole('button', { name: 'Copy box 1' });
    expect(copyBox).toHaveTextContent(/^Copy box$/);
    await user.click(copyBox);
    expect(writeText).toHaveBeenLastCalledWith([big, sparky].map((m) => m!.showdown).join('\n\n'));
  });
});

describe('The live box', () => {
  let source: typeof FakeEventSource;
  beforeEach(() => {
    source = stubEventSource();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  type Routes = Parameters<typeof stubFetch>[0];
  function serve(over: { box?: BoxJson; levelCapOverride?: number | null; boxRoute?: Routes[string]; routes?: Routes } = {}) {
    return stubFetch({
      'GET /api/setup': { json: setup({ savePath: SAVE_12_JUNE }) },
      'GET /api/settings': { json: settings({ savePath: SAVE_12_JUNE, levelCapOverride: over.levelCapOverride ?? null }) },
      'GET /api/box': over.boxRoute ?? { json: over.box ?? box() },
      'GET /api/trainers': { json: trainers() },
      'POST /api/sheet': { json: sheetOf(TRISTAN) },
      ...over.routes,
    });
  }
  async function openBoxTab() {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('tab', { name: 'Box' }));
    await within(screen.getByRole('tabpanel', { name: 'Box' })).findByText('Blaze (Monferno)');
    const es = await waitFor(() => source.last());
    expect(es.url).toBe('/api/events');
    act(() => es.open());
  }
  const runLine = () => within(screen.getByRole('banner')).getByText(/^Run:/).textContent;

  it('a box event updates the box; it flashes "Box updated" for 3 s only for a new save time or save copy', async () => {
    serve();
    await openBoxTab();
    vi.useFakeTimers();
    // The box again after a settings change: the same save, read at the same time, with another level cap.
    act(() => source.last().emit('box', box({ levelCap: 20 })));
    expect(runLine()).toContain('cap 20');
    expect(screen.queryByText('Box updated')).toBeNull();

    const next = box({ savedAt: LATER });
    next.mons[0] = { ...next.mons[0]!, level: 16 };
    act(() => source.last().emit('box', next));
    expect(cell(row('Blaze (Monferno)'), 'Lv')).toHaveTextContent('16');
    expect(screen.getByText('Box updated')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2_900));
    expect(screen.getByText('Box updated')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByText('Box updated')).toBeNull();

    act(() => source.last().emit('box', box({ savedAt: LATER, savePath: SAVE_23_MAY })));
    expect(screen.getByText('Box updated')).toBeInTheDocument();
  });

  it('a boxError keeps the last box on screen and says why, until the next box', async () => {
    serve();
    await openBoxTab();
    act(() => source.last().emit('boxError', { error: `Cannot read ${SAVE_12_JUNE}: both save slots are invalid` }));
    expect(screen.getByRole('alert')).toHaveTextContent('both save slots are invalid');
    expect(screen.getByRole('alert')).toHaveTextContent('The box shows the last good read, and refreshes on the next save.');
    expect(within(screen.getByRole('tabpanel', { name: 'Box' })).getByText('Blaze (Monferno)')).toBeInTheDocument();
    act(() => source.last().emit('box', box()));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a boxError before any box has read does not claim a last good read', async () => {
    serve({ boxRoute: { status: 422, json: { error: SAVE_GONE } } });
    render(<App />);
    await within(await screen.findByRole('tablist', { name: 'Workspace' }, { timeout: 5_000 })).findByRole('tab', { name: 'Run' });
    const es = await waitFor(() => source.last(), { timeout: 5_000 });
    act(() => es.open());
    act(() => es.emit('boxError', { error: `Cannot read ${SAVE_12_JUNE}: both save slots are invalid` }));
    // Wait for this alert itself: the startup banner can render first under load.
    const alert = await waitFor(() => {
      const found = screen.getAllByRole('alert').find((a) => a.textContent?.includes('both save slots are invalid'));
      if (!found) throw new Error('the boxError alert has not rendered yet');
      return found;
    }, { timeout: 5_000 });
    expect(alert).toHaveTextContent('The save did not read.');
    expect(alert).not.toHaveTextContent(/last good read/);
    expect(alert).toHaveTextContent('The planner reads it again on the next save.');
  });

  it('a save that does not read at startup says why above the tabs, on the Run tab too, with "Change save copy"', async () => {
    const user = userEvent.setup();
    serve({ boxRoute: { status: 422, json: { error: SAVE_GONE } } });
    render(<App />);
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(`The box did not load. ${SAVE_GONE}`);
    const fight = screen.getByRole('tabpanel', { name: 'Run' });
    expect(await within(fight).findByText(`The save did not read: ${SAVE_GONE}`)).toBeInTheDocument();
    expect(within(fight).queryByText('Reading the save…')).toBeNull();
    expect(within(fight).getByText('The fights show once the save reads.')).toBeInTheDocument();
    await user.click(within(banner).getByRole('button', { name: 'Change save copy' }));
    expect(await screen.findByRole('button', { name: 'Use this save' })).toBeInTheDocument();
  });

  it('a box read that fails while a box is shown says so, and the box stays', async () => {
    let reads = 0;
    serve({ boxRoute: () => (++reads === 1 ? { json: box() } : { status: 422, json: { error: SAVE_GONE } }) });
    await openBoxTab();
    act(() => source.last().fail());
    act(() => source.last().open());                         // back: the box is read again, and that read fails
    const banner = await screen.findByRole('alert');
    expect(reads).toBe(2);
    expect(banner).toHaveTextContent(`The box did not load. ${SAVE_GONE} The box shows the last good read.`);
    expect(within(banner).getByRole('button', { name: 'Change save copy' })).toBeInTheDocument();
    expect(within(screen.getByRole('tabpanel', { name: 'Box' })).getByText('Blaze (Monferno)')).toBeInTheDocument();
  });

  it('on open: the header names the run, save, time, override and live state; old keys go; a dropped stream reconnects', async () => {
    for (const key of OLD_KEYS) localStorage.setItem(key, '{}');
    serve({ box: box({ badges: 3, levelCap: 20 }), levelCapOverride: 20 });
    await openBoxTab();
    for (const key of OLD_KEYS) expect(localStorage.getItem(key)).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Priority' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /priority/i })).toBeNull();
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('heading', { name: 'Plat Kaizo Planner' })).toBeInTheDocument();
    expect(within(header).getByText('plat-kaizo-nightmare-update-final.dsv')).toBeInTheDocument();
    expect(within(header).getByText(/^Saved 12 June 2026, \d\d:\d\d$/)).toBeInTheDocument();
    expect(runLine()).toBe('Run: 3 badges · cap 20 (override) · Roark Split');
    expect(within(header).getByText('Watching for saves')).toBeInTheDocument();

    act(() => source.last().fail());
    expect(within(header).getByText('Reconnecting…')).toBeInTheDocument();
    act(() => source.last().open());
    expect(within(header).getByText('Watching for saves')).toBeInTheDocument();

    // A stream the browser gives up on is opened again after a few seconds.
    vi.useFakeTimers();
    const first = source.last();
    act(() => first.fail(true));
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3_000));
    expect(source.instances).toHaveLength(2);
    act(() => source.last().open());
    expect(screen.getByText('Watching for saves')).toBeInTheDocument();
  });

  it('one badge is singular, an overridden cap says so, and at 8 badges both splits are named', () => {
    const status = (b: BoxJson, levelCapOverride: number | null = null): HeaderStatus => ({ box: b, savePath: b.savePath, levelCapOverride, live: 'live', updated: false, onSettings: () => undefined });
    const { rerender } = render(<Header status={status(box({ badges: 1, levelCap: 30 }), 30)} />);
    expect(screen.getByText(/^Run:/).textContent).toBe('Run: 1 badge · cap 30 (override) · Roark Split');
    const run = { split: 'Galactic Split', splitIndex: 8, splits: ['Galactic Split', 'Elite Four Split'], alsoPossible: ['Elite Four Split'], fights: [], next: null };
    rerender(<Header status={status(box({ badges: 8, levelCap: 100, run }))} />);
    expect(screen.getByText(/^Run:/).textContent).toBe('Run: 8 badges · cap 100 · Galactic Split or Elite Four Split');
  });

  it('a box event with another cap reads the settings again, so an override set in another tab says "(override)"', async () => {
    let reads = 0;
    serve({ routes: { 'GET /api/settings': () => ({ json: settings({ savePath: SAVE_12_JUNE, levelCapOverride: ++reads === 1 ? null : 20 }) }) } });
    await openBoxTab();
    expect(runLine()).toBe('Run: 0 badges · cap 16 · Roark Split');
    act(() => source.last().emit('box', box({ savedAt: LATER })));      // the same cap: no new read
    await act(async () => undefined);
    expect(reads).toBe(1);
    act(() => source.last().emit('box', box({ savedAt: LATER, levelCap: 20 })));
    await waitFor(() => expect(runLine()).toBe('Run: 0 badges · cap 20 (override) · Roark Split'));
    expect(reads).toBe(2);
  });

  it("the Run tab opens the split's first fight", async () => {
    serve();
    render(<App />);
    expect(within(await screen.findByRole('tablist', { name: 'Workspace' })).getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('region', { name: 'Youngster Tristan' })).toBeInTheDocument();
  });
});
