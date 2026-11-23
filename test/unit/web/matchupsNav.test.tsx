import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SheetJson, SheetMonJson, SheetPairJson } from '../../../src/server/apiTypes';
import { SheetView } from '../../../web/src/components/SheetView';
import { enemyLabels } from '../../../web/src/components/sheet/names';
import { SHARED_PREFIX } from '../../../web/src/components/sheet/notes';

const mon = (key: string, name: string, nickname: string | null = null): SheetMonJson => ({
  key, name, nickname, level: 16, nature: 'Jolly', ability: 'Blaze', item: null, moves: [], stats: { hp: 40, atk: 50, def: 50, spa: 50, spd: 50, spe: 40 }, hp: 40,
  status: null, disputed: [], showdown: name,
});
const monferno = mon('party:1', 'Monferno', 'Blaze');
const raichu = mon('box:1:3', 'Raichu');
const purugly = mon('enemy:0', 'Purugly');
const bronzor = mon('enemy:1', 'Bronzor');
const pairOf = (player: string, enemy: string, notes: string[] = []): SheetPairJson => ({
  player, enemy, order: 'player', playerSpeed: 50, enemySpeed: 40, notes, field: 'Sun', weatherMayPersist: false, playerMoves: [], enemyMoves: [],
});
const sheetOf = (enemies: SheetMonJson[], players: SheetMonJson[], pairs?: SheetPairJson[]): SheetJson => ({
  trainer: { id: 't', name: 'Commander Mars', location: 'Valley Windworks', battleType: 'single', variant: 0, variants: 1, field: null },
  savedAt: '2026-06-12T12:00:00.000Z', savePath: '/saves/game.dsv', notes: [],
  enemies, players, pairs: pairs ?? enemies.flatMap((e) => players.map((p) => pairOf(p.key, e.key))),
});
const full = () => sheetOf([purugly, bronzor], [monferno, raichu]);
const nav = () => screen.getByRole('navigation', { name: 'Matchups navigation' });
const show = () => screen.getByRole('group', { name: 'Show' });
/** The pair headings in each section. */
const pairsShown = () => screen.getAllByRole('region').map((region) => within(region).getAllByRole('heading', { level: 4 }).map((h) => h.textContent!.split(' ')[0]));

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });

it('enemyLabels numbers the second and third of a species', () => {
  expect(enemyLabels(['Koffing', 'Zubat', 'Koffing', 'Koffing'].map((name, i) => mon(`enemy:${i}`, name)))).toEqual(['Koffing', 'Zubat', 'Koffing 2', 'Koffing 3']);
});

describe('MatchupsNav in SheetView', () => {
  it('a jump chip scrolls its section into view and focuses its heading', () => {
    render(<SheetView sheet={full()} />);
    fireEvent.click(within(nav()).getByRole('button', { name: 'Bronzor' }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect((Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.instances[0]).toBe(screen.getByRole('region', { name: /Bronzor/ }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'Bronzor Lv 16' }));
  });

  it("the filter shows one Pokémon's pair in each section and All every pair; it falls back to All, and is forgotten, when that Pokémon leaves", () => {
    const { rerender } = render(<SheetView sheet={full()} />);
    fireEvent.click(within(show()).getByRole('button', { name: 'Raichu' }));
    expect(['Raichu', 'All'].map((name) => within(show()).getByRole('button', { name }).getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(pairsShown()).toEqual([['Raichu'], ['Raichu']]);
    fireEvent.click(within(show()).getByRole('button', { name: 'All' }));
    expect(pairsShown()).toEqual([['Blaze', 'Raichu'], ['Blaze', 'Raichu']]);
    fireEvent.click(within(show()).getByRole('button', { name: 'Raichu' }));
    rerender(<SheetView sheet={sheetOf([purugly, bronzor], [monferno])} />);
    expect(pairsShown()).toEqual([['Blaze'], ['Blaze']]);
    rerender(<SheetView sheet={full()} />);                                           // it does not return with Raichu
    expect(pairsShown()).toEqual([['Blaze', 'Raichu'], ['Blaze', 'Raichu']]);
  });

  it.each<[string, SheetJson, boolean, boolean, string[]]>([
    ['two of each: Show and Go to', full(), true, true, ['Purugly', 'Bronzor']],
    ['one of yours: Go to alone', sheetOf([purugly, bronzor], [monferno]), false, true, ['Purugly', 'Bronzor']],
    ['one of his: Show alone', sheetOf([purugly], [monferno, raichu]), true, false, []],
    ['two of the same species: distinct chips', sheetOf([mon('enemy:0', 'Koffing'), mon('enemy:1', 'Koffing')], [monferno]), false, true, ['Koffing', 'Koffing 2']],
  ])('%s', (_, sheet, hasShow, hasGoTo, chips) => {
    const { container } = render(<SheetView sheet={sheet} />);
    expect(container.querySelectorAll('.matchups-nav')).toHaveLength(1);
    expect(container.querySelector('.matchup-bar')?.nextElementSibling).toBe(nav());     // right after the matchup bar
    expect(within(nav()).queryByRole('group', { name: 'Show' }) !== null).toBe(hasShow);
    const goTo = within(nav()).queryByRole('group', { name: 'Go to' });
    expect(goTo !== null).toBe(hasGoTo);
    if (goTo !== null) expect(within(goTo).getAllByRole('button').map((b) => b.textContent)).toEqual(chips);
    if (hasShow && goTo !== null) expect(show().compareDocumentPosition(goTo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has no bar when neither side has two', () => {
    render(<SheetView sheet={sheetOf([purugly], [monferno])} />);
    expect(screen.queryByRole('navigation', { name: 'Matchups navigation' })).toBeNull();
  });

  it('prints a note two pairs share once, over all pairs, when a third Pokémon has no pair and when the filter is on', () => {
    const notes = ['Drought sets sun'];
    const { container } = render(<SheetView sheet={sheetOf([purugly], [monferno, raichu, mon('box:2:0', 'Gible')], [pairOf('party:1', 'enemy:0', notes), pairOf('box:1:3', 'enemy:0', notes)])} />);
    const shared = () => {
      expect(container.querySelector('.matchup-enemy-head')!.textContent).toContain(`${SHARED_PREFIX}Drought sets sun`);
      expect(screen.getAllByText(/Drought sets sun/)).toHaveLength(1);
    };
    shared();
    fireEvent.click(within(show()).getByRole('button', { name: 'Raichu' }));
    shared();
  });

  describe('nav height', () => {
    const original = globalThis.ResizeObserver;
    afterEach(() => { globalThis.ResizeObserver = original; vi.restoreAllMocks(); });
    /** A ResizeObserver stand-in that keeps every one made, and an offsetHeight the test sets. */
    function stub() {
      const seen: { callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
      globalThis.ResizeObserver = class {
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
        constructor(callback: () => void) { seen.push({ callback, observe: this.observe, disconnect: this.disconnect }); }
      } as unknown as typeof ResizeObserver;
      const height = { value: 40 };
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height.value);
      return { seen, height };
    }

    it('writes --matchups-nav-height on the sheet as the observer fires, re-reads (and re-attaches) the nav each time, and disconnects on unmount', () => {
      const { seen, height } = stub();
      const { container, unmount } = render(<SheetView sheet={full()} />);
      const sheet = container.querySelector('.sheet') as HTMLElement;
      const value = () => sheet.style.getPropertyValue('--matchups-nav-height');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.observe).toHaveBeenCalledWith(sheet);
      expect(seen[0]!.observe).toHaveBeenCalledWith(container.querySelector('.matchups-nav'));
      expect(value()).toBe('40px');
      height.value = 72;
      seen[0]!.callback();
      expect(value()).toBe('72px');
      // The nav node is replaced behind the observer: the next callback measures and observes the new one.
      const old = container.querySelector('.matchups-nav') as HTMLElement;
      const fresh = old.cloneNode(true) as HTMLElement;
      old.replaceWith(fresh);
      height.value = 61;
      seen[0]!.callback();
      expect(value()).toBe('61px');
      expect(seen[0]!.observe).toHaveBeenCalledWith(fresh);
      fresh.replaceWith(old);
      unmount();
      expect(seen[0]!.disconnect).toHaveBeenCalled();
    });
  });
});

// Matchups as surfaces, not outlines, and the one-line bar evenly spaced (an empty "Copied" status held room after each Copy).
describe('Matchups styles', () => {
  const read = (path: string) => readFileSync(resolve(__dirname, '../../../web/src', path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  /** The top-level rules of styles.css then matchups.css, each as its selectors and body (at-rules left out). */
  const rules = [read('styles.css'), read('styles/matchups.css')].flatMap((text) => {
    const found: { selectors: string[]; body: string }[] = [];
    let depth = 0;
    let preludeAt = 0;
    let bodyAt = 0;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '{') {
        if (depth === 0) bodyAt = i + 1;
        depth += 1;
      } else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          const prelude = text.slice(preludeAt, bodyAt - 1).trim();
          if (!prelude.startsWith('@')) found.push({ selectors: prelude.split(',').map((s) => s.trim().replace(/\s+/g, ' ')), body: text.slice(bodyAt, i) });
          preludeAt = i + 1;
        }
      }
    }
    return found;
  });
  const bodies = (selector: string) => rules.filter((r) => r.selectors.includes(selector)).map((r) => r.body).join('\n');

  it('outlines neither the Show / Go to bar nor a pair, and spaces the one-line bar evenly', () => {
    expect(bodies('.matchups-nav')).toMatch(/background:\s*var\(--surface\)/);
    for (const selector of ['.matchups-nav', '.matchup-pair']) expect(bodies(selector), selector).not.toMatch(/(^|[\s;])border(-top)?:\s*1px/);
    expect(bodies('.matchup-pairs')).toMatch(/gap:/);
    const gap = (selector: string) => [...bodies(selector).matchAll(/(^|[\s;])gap:\s*([^;]+);/g)].at(-1)?.[2]?.trim().split(/\s+/).at(-1);
    expect(gap('.matchup-actions')).toBe(gap('.matchup-bar'));
    expect(bodies('.matchup-actions .sheet-copy')).toMatch(/position:\s*relative/);
    expect(bodies('.matchup-actions .sheet-copy-status')).toMatch(/position:\s*absolute/);
  });
});
