// The next fights (NextFights.tsx): the shown split's trainers as a strip in game order, the open one pressed and
// scrolled into view, the single after it marked After this, a double and a beaten fight marked; the Split select at 8
// badges; and under it the search over every trainer (TrainerSearch.tsx).

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextFights } from '../../../web/src/components/NextFights';
import { SEARCH_DEBOUNCE_MS, TrainerSearch } from '../../../web/src/components/TrainerSearch';
import { splitFights } from '../../../web/src/run';
import { GARDENIA, ROARK, stubFetch, TAYLOR, trainerById, trainers, TRISTAN, TWINS } from './stubServer';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const strip = () => within(screen.getByRole('region', { name: 'Next fights' })).getByRole('list');
const fights = () => splitFights(trainers(), 'Roark Split');
const props = { split: 'Roark Split', splits: ['Roark Split'], onPick: vi.fn(), onSplit: vi.fn() };
function show(over: Partial<Parameters<typeof NextFights>[0]> = {}) {
  const onPick = vi.fn();
  const onSplit = vi.fn();
  render(<NextFights {...props} fights={fights()} openId={TRISTAN} onPick={onPick} onSplit={onSplit} {...over} />);
  return { onPick, onSplit, user: userEvent.setup() };
}
/** Fake timeouts (the search's debounce) and a user whose waits advance them: Testing Library only advances a clock under a `jest` global. */
function fakeTimeouts() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
  return userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
}
const found = (container: HTMLElement) => [...container.querySelectorAll('.trainer-name')].map((n) => n.textContent);
const searchBox = () => screen.getByRole('searchbox', { name: 'Search all trainers' });

describe('the strip', () => {
  it("lists the split's fights in order, the open one pressed, the next single After this, a double and a beaten fight marked", () => {
    show({ beaten: [TRISTAN] });
    const items = within(strip()).getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toMatch(/^Youngster Tristan/);
    expect(items[1]).toMatch(/Twins Ally and Ann.*2v2/);
    expect(items[2]).toMatch(/Leader Roark.*After this/);
    expect(screen.getByRole('button', { name: /^Youngster Tristan/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Youngster Tristan/ }).querySelector('.pill.run-beaten')).toHaveTextContent('Beaten');
    expect(screen.getByRole('button', { name: /^Leader Roark/ })).not.toHaveTextContent('Beaten');
    expect(screen.getByText('Roark Split · 3 fights')).toBeInTheDocument();
    expect(screen.queryByText('Up next')).toBeNull();
    expect(screen.queryByLabelText('Split')).toBeNull();
    cleanup();
    show({ openId: ROARK });                                             // the split's last single: nothing after it
    expect(screen.queryByText(/After this|Beaten/)).toBeNull();
    expect(screen.getByRole('button', { name: /^Leader Roark/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a click opens that trainer; at 8 badges a Split select picks which of the two splits is listed', async () => {
    const t = show({ splits: ['Roark Split', 'Gardenia Split'] });
    await t.user.click(screen.getByRole('button', { name: /^Leader Roark/ }));
    expect(t.onPick).toHaveBeenCalledWith(trainerById(ROARK));
    await t.user.selectOptions(screen.getByLabelText('Split'), 'Gardenia Split');
    expect(t.onSplit).toHaveBeenCalledWith('Gardenia Split');
  });

  it('says it is loading, that a split has no fights, and counts a split of one as "1 fight"', () => {
    show({ fights: null });
    expect(screen.getByText('Loading the trainers…')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
    cleanup();
    show({ fights: [] });
    expect(screen.getByText('No fights are listed for this split. Search for a trainer.')).toBeInTheDocument();
    expect(screen.getByText('Roark Split · 0 fights')).toBeInTheDocument();
    expect(searchBox()).toBeInTheDocument();
    cleanup();
    show({ fights: [trainerById(ROARK)], openId: ROARK });
    expect(screen.getByText('Roark Split · 1 fight')).toBeInTheDocument();
  });

  it('a trainer the docs mark female shows the class plain and ♀ after the name', () => {
    show({ fights: [{ ...trainerById(TRISTAN), name: 'GalacticfTerra' }, { ...trainerById(ROARK), name: 'Galacticf Venus' }] });
    expect(within(strip()).getAllByRole('listitem').map((li) => li.querySelector('.run-fight-name')?.textContent)).toEqual(['Galactic Terra ♀', 'Galactic Venus ♀']);
    expect(within(strip()).queryByText(/Galacticf/)).toBeNull();
  });
});

describe('scrolling the strip to the open fight', () => {
  /** jsdom has no layout: the strip at offsetLeft 10 with a window of `clientWidth`, each fight 200 px at 10, 210, 410. */
  function layOut(list: HTMLElement, scrollLeft: number, clientWidth = 300) {
    def(list, { offsetLeft: 10, clientWidth, scrollLeft });
    [...list.querySelectorAll('button.run-fight')].forEach((b, i) => def(b as HTMLElement, { offsetLeft: 10 + i * 200, offsetWidth: 200 }));
  }
  function def(el: HTMLElement, values: Record<string, number>) {
    for (const [k, v] of Object.entries(values)) Object.defineProperty(el, k, { value: v, configurable: true, writable: true });
  }
  const view = (openId: string | null, list: ReturnType<typeof fights> | null = fights()) => <NextFights {...props} fights={list} openId={openId} />;
  /** Every ResizeObserver made; `fire` calls each that is still connected. */
  const observers: { cb: () => void; live: boolean }[] = [];
  const fire = () => observers.filter((o) => o.live).forEach((o) => o.cb());
  function stubObserver() {
    observers.length = 0;
    vi.stubGlobal('ResizeObserver', class {
      private o: { cb: () => void; live: boolean };
      constructor(cb: () => void) { this.o = { cb, live: true }; observers.push(this.o); }
      observe() { /* nothing */ }
      disconnect() { this.o.live = false; }
    });
  }

  it('scrolls only the strip when another fight opens, never the page, and not on every render', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const { rerender } = render(view(TRISTAN));
      layOut(strip(), 0);
      rerender(view(ROARK));                               // Roark spans 400..600: past the 300 px window
      expect(strip().scrollLeft).toBe(300);
      strip().scrollLeft = 120;                            // the player scrolls; the same fight rendering again leaves it
      rerender(view(ROARK));
      expect(strip().scrollLeft).toBe(120);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it('leaves the strip alone when the open fight is already visible, and scrolls back left to one cut off at the left', () => {
    const { rerender } = render(view(ROARK));
    layOut(strip(), 150);                                  // window 150..450: Twins (200..400) is whole inside it
    rerender(view(TWINS));
    expect(strip().scrollLeft).toBe(150);
    rerender(view(TRISTAN));
    expect(strip().scrollLeft).toBe(0);
  });

  it('a strip with no width yet (a hidden pane or tab) puts the open fight at its start, so it shows whole once laid out', () => {
    const { rerender } = render(view(null));
    layOut(strip(), 0, 0);
    rerender(view(TRISTAN));
    expect(strip().scrollLeft).toBe(0);
    rerender(view(ROARK));                                 // its left edge at the strip's
    expect(strip().scrollLeft).toBe(400);
    layOut(strip(), 0, 120);                               // a strip narrower than a fight shows its start, not its end
    rerender(view(TWINS));
    expect(strip().scrollLeft).toBe(200);
  });

  it('scrolls when the strip goes from no width to a width, and not on other resizes; disconnects on unmount', () => {
    stubObserver();
    const { unmount } = render(view(ROARK));
    layOut(strip(), 0, 0);
    fire();                                                // still no width: nothing happens
    expect(strip().scrollLeft).toBe(0);
    def(strip(), { clientWidth: 300 });                    // shown: Roark spans 410..610, past the 300 px window
    fire();
    expect(strip().scrollLeft).toBe(300);
    strip().scrollLeft = 120;                              // the player scrolls, then the strip is resized
    def(strip(), { clientWidth: 350 });
    fire();
    expect(strip().scrollLeft).toBe(120);
    unmount();
    expect(observers.every((o) => !o.live)).toBe(true);
  });

  it('observes a list that mounts late, hidden when it arrives', () => {
    stubObserver();
    const { rerender } = render(view(ROARK, null));
    rerender(view(ROARK));
    layOut(strip(), 0, 0);
    fire();
    expect(strip().scrollLeft).toBe(0);
    def(strip(), { clientWidth: 300 });
    fire();
    expect(strip().scrollLeft).toBe(300);
  });

  it('an open fight that changes while the strip is hidden is the one scrolled to when it is shown', () => {
    stubObserver();
    const list = fights();
    const { rerender } = render(view(list[0]!.id, list));
    layOut(strip(), 0, 0);
    rerender(view(ROARK, list));
    expect(strip().scrollLeft).toBe(400);                  // hidden: it starts at the fight
    strip().scrollLeft = 0;
    def(strip(), { clientWidth: 300 });
    fire();
    expect(strip().scrollLeft).toBe(300);                  // shown: the new open fight (410..610) ends the window
  });
});

describe('the search', () => {
  it('lists nothing until typed in, asks the server after 200 ms, opens a result and empties the box', async () => {
    const user = fakeTimeouts();
    const stub = stubFetch({ 'GET /api/trainers': { json: [trainerById(GARDENIA)] } });
    const t = show();
    expect(screen.queryByRole('heading', { name: 'Gardenia Split' })).toBeNull();
    await user.type(searchBox(), 'gard');
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1));
    expect(stub.calls).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(stub.calls.map((c) => c.url)).toEqual(['/api/trainers?search=gard']);
    await user.click(await screen.findByRole('button', { name: /^Leader Gardenia/ }));
    expect(t.onPick).toHaveBeenCalledWith(trainerById(GARDENIA));
    expect(searchBox()).toHaveValue('');
  });

  it('lists name matches first under one heading per split; emptying the box clears at once, and new text asks only for itself', async () => {
    const user = fakeTimeouts();
    const stub = stubFetch({ 'GET /api/trainers': (call) => ({ json: call.url.includes('gard') ? [trainerById(TAYLOR), trainerById(GARDENIA)] : [trainerById(ROARK)] }) });
    const { container } = render(<TrainerSearch openId={null} onPick={vi.fn()} />);
    await user.type(searchBox(), 'gard');
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    await waitFor(() => expect(found(container)).toEqual(['Leader Gardenia', 'Aroma Lady Taylor']));
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Gardenia Split']);
    await user.clear(searchBox());
    expect(found(container)).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2));
    expect(stub.calls).toHaveLength(1);
    await user.type(searchBox(), 'roark');
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(stub.calls.map((c) => c.url)).toEqual(['/api/trainers?search=gard', '/api/trainers?search=roark']);
    await waitFor(() => expect(found(container)).toEqual(['Leader Roark']));
  });

  it('is driven from the keyboard: Down into the results, Up and Down between them, Escape and Up from the first go back, Enter opens', async () => {
    const user = userEvent.setup();
    stubFetch({ 'GET /api/trainers': { json: [trainerById(ROARK), trainerById(GARDENIA)] } });
    const onPick = vi.fn();
    const { container } = render(<TrainerSearch openId={null} onPick={onPick} />);
    await user.type(searchBox(), 'leader');
    await waitFor(() => expect(found(container)).toHaveLength(2));
    const rows = screen.getAllByRole('button', { name: /^Leader / });
    for (const [key, focused] of [['{ArrowDown}', rows[0]], ['{ArrowDown}', rows[1]], ['{ArrowDown}', rows[1]], ['{ArrowUp}', rows[0]], ['{ArrowUp}', searchBox()], ['{ArrowDown}{Escape}', searchBox()]] as const) {
      await user.keyboard(key);
      expect(focused, key).toHaveFocus();
    }
    expect(searchBox()).toHaveValue('leader');
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledExactlyOnceWith(trainerById(GARDENIA));
    expect(searchBox()).toHaveValue('');
  });

  it('a search that failed once and is typed again shows what it finds, not the old error', async () => {
    const user = userEvent.setup();
    let searches = 0;
    stubFetch({ 'GET /api/trainers': () => (++searches === 1 ? { status: 500, json: { error: 'The trainer search broke' } } : { json: [trainerById(ROARK)] }) });
    const { container } = render(<TrainerSearch openId={null} onPick={vi.fn()} />);
    await user.type(searchBox(), 'roark');
    expect(await screen.findByRole('alert')).toHaveTextContent('The search failed. The trainer search broke');
    await user.clear(searchBox());
    expect(found(container)).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
    await user.type(searchBox(), 'roark');
    await waitFor(() => expect(found(container)).toEqual(['Leader Roark']));
    expect(searches).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a double carries one quiet 2v2 tag, a search that finds nobody says so, and tags read in sentence case with ♀ names', async () => {
    const user = userEvent.setup();
    stubFetch({
      'GET /api/trainers': (call) => ({
        json: call.url.includes('twins') ? [trainerById(TWINS)]
          : call.url.includes('tethys') ? [{ ...trainerById(ROARK), name: 'GalacticfTethys', tags: ['GAUNTLET START', 'MULTI BATTLE with GalacticfDione'] }] : [],
      }),
    });
    const { container } = render(<TrainerSearch openId={null} onPick={vi.fn()} />);
    await user.type(searchBox(), 'twins');
    const twins = await screen.findByRole('button', { name: /^Twins Ally and Ann/ });
    expect(twins).toHaveTextContent('2v2');
    expect(within(twins).getByTitle("Double battle: can't be planned yet")).toBeTruthy();
    await user.clear(searchBox());
    await user.type(searchBox(), 'zzz');
    expect(await screen.findByText('No trainer matches “zzz”.')).toBeInTheDocument();
    await user.clear(searchBox());
    await user.type(searchBox(), 'tethys');
    await waitFor(() => expect(found(container)).toEqual(['Galactic Tethys ♀']));
    expect([...container.querySelectorAll('.pill-tag')].map((p) => p.textContent)).toEqual(['First of a no-heal run', 'Multi battle with Galactic Dione ♀']);
  });
});
