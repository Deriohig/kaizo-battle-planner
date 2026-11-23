// The start screen (StartScreen.tsx): the trainer's Pokémon, his own team each with "Start with X", the first matchup's
// speed line, the kept tree offer and the saved trees; and `firstMatchup`, the sheet's first pair read for it.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstMatchup } from '../../../web/src/components/start/firstMatchup';
import { StartScreen, type StartScreenProps } from '../../../web/src/components/start/StartScreen';
import type { LineRecord, SavedLine } from '../../../web/src/line';
import type { BoxJson, MonRef, SheetJson, SheetMoveJson } from '../../../src/server/apiTypes';
import { box, draftOptions, GARDENIA, mon, sheetOf, TRISTAN, trainerById } from './stubServer';

afterEach(cleanup);

const FIGHT = { trainerId: TRISTAN, variant: 0 };
const REF_A: MonRef = 'party:1';
const REF_B: MonRef = 'party:2';
const WORKING = 'Working out the first matchup…';

/** A move with a one-use KO chance `num/16` (bounded), as `over` changes it. */
function move(num: string, over: Partial<SheetMoveJson> = {}, damageOver: Partial<NonNullable<SheetMoveJson['damage']>> = {}): SheetMoveJson {
  return {
    name: 'Ember', type: 'Fire', category: 'Special', power: 40, hitChance: 1, inaccurate: false, unmodelled: null, weatherDepends: false,
    damage: { rolls: [], critRolls: [], min: 1, max: 2, percent: [1, 2], koChance: null, koExact: [{ hits: 1, num, den: '16' }, { hits: 2, num: '16', den: '16' }], bounded: true, ohko: false, desc: '', ...damageOver },
    ...over,
  };
}
/** A sheet whose pairs' enemy moves are `enemyMoves`; the first enemy Numel, the pairs speed 26 vs 21 and 16 vs 21. */
function sheet(enemyMoves: SheetMoveJson[] = [move('0')], over: Partial<SheetJson> = {}): SheetJson {
  const base = sheetOf(TRISTAN);
  const enemy = { ...base.enemies[0]!, name: 'Numel', key: 'enemy:0', item: 'Oran Berry', moves: ['Ember', 'Tackle'], level: 12 };
  // The players as the start screen shows them (levels, HP), so the sheet is current for the rows.
  const players = base.players.map((p) => (p.key === REF_A ? { ...p, level: 15, hp: 30, stats: { ...p.stats, hp: 40 } } : { ...p, level: 14, hp: 38, stats: { ...p.stats, hp: 38 } }));
  return {
    ...base, enemies: [enemy], players,
    pairs: base.pairs.map((p) => (p.player === REF_A
      ? { ...p, enemy: 'enemy:0', order: 'player' as const, playerSpeed: 26, enemySpeed: 21, enemyMoves }
      : { ...p, enemy: 'enemy:0', order: 'enemy' as const, playerSpeed: 16, enemySpeed: 21, enemyMoves })),
    ...over,
  };
}
/** Prinplup and Machop, each changed by `over`. */
function team(a: Partial<BoxJson['mons'][number]> = {}, b: Partial<BoxJson['mons'][number]> = {}) {
  const t = box();
  t.mons = [
    mon(REF_A, { nickname: 'Prinplup', species: 'Prinplup', level: 15, hp: 30, maxHp: 44, status: null, ...a }),
    mon(REF_B, { nickname: 'Machop', species: 'Machop', level: 14, hp: 38, maxHp: 38, status: null, ...b }),
  ];
  return { box: t, mons: new Map(t.mons.map((m) => [m.ref, m])) };
}
function show(over: Partial<StartScreenProps> = {}) {
  const p: StartScreenProps = {
    trainer: trainerById(TRISTAN), sheet: sheet(), sheetError: null, fight: FIGHT, teamRefs: [REF_A, REF_B], draft: [], options: draftOptions(),
    ...team(), saved: [], busy: false, slow: false, onStop: vi.fn(), again: null, onAgain: vi.fn(),
    nameOf: (id) => id, onLead: vi.fn(), onOpen: vi.fn(), onDelete: vi.fn(), ...over,
  };
  const view = render(<StartScreen {...p} />);
  return { p, ...view, user: userEvent.setup(), rows: () => [...view.container.querySelectorAll<HTMLElement>('.start-team > li')] };
}

describe('firstMatchup', () => {
  it.each<[string, Parameters<typeof firstMatchup>, string]>([
    ['an error', [sheet(), 'nope', FIGHT, REF_A], 'none'],
    ['no sheet', [null, null, FIGHT, REF_A], 'loading'],
    ['another trainer', [sheet(), null, { trainerId: 'other', variant: 0 }, REF_A], 'loading'],
    ['another copy', [sheet(), null, { ...FIGHT, variant: 1 }, REF_A], 'loading'],
    ['no enemy', [sheet([move('0')], { enemies: [] }), null, FIGHT, REF_A], 'loading'],
    ['no pair', [sheet(), null, FIGHT, 'party:5'], 'loading'],
    ['a sheet whose player differs in level', [sheet(), null, FIGHT, REF_A, { level: 16, hp: 30, maxHp: 40 }], 'loading'],
    ['in HP', [sheet(), null, FIGHT, REF_A, { level: 15, hp: 29, maxHp: 40 }], 'loading'],
    ['in max HP', [sheet(), null, FIGHT, REF_A, { level: 15, hp: 30, maxHp: 41 }], 'loading'],
    ['no player', [sheet([move('0')], { players: [] }), null, FIGHT, REF_A, { level: 15, hp: 30, maxHp: 40 }], 'loading'],
    ['a sheet that agrees', [sheet(), null, FIGHT, REF_A, { level: 15, hp: 30, maxHp: 40 }], 'ready'],
  ])('for %s is %s', (_, args, state) => {
    expect(firstMatchup(...args).state).toBe(state);
  });

  it("is ready with the pair's speeds and order; a KO in one hit only for a bounded move with a one-use chance, or an OHKO move that can hit", () => {
    expect(firstMatchup(sheet(), null, FIGHT, REF_A)).toEqual({ state: 'ready', enemy: 'Numel', order: 'player', playerSpeed: 26, enemySpeed: 21, canKoInOne: false });
    const can = (m: SheetMoveJson) => {
      const r = firstMatchup(sheet([m]), null, FIGHT, REF_A);
      return r.state === 'ready' && r.canKoInOne;
    };
    expect([
      move('1'), move('0'), move('1', {}, { bounded: false, koExact: null }), move('1', {}, { ohko: true }), move('1', { hitChance: 0 }, { ohko: true }), move('1', { damage: null }),
    ].map(can)).toEqual([true, false, false, true, false, false]);
  });
});

describe('StartScreen', () => {
  it('shows their Pokémon and his with moves and the speed line against their first, every start button the same secondary style', () => {
    const { container, rows } = show({ saved: [{ start: { trainerId: TRISTAN, variant: 0, world: 0, team: [REF_A], draft: [{ ref: REF_A }] }, path: [], others: [], save: null, name: 'Plan one' } as SavedLine] });
    expect(screen.getByRole('list', { name: 'Their Pokémon' })).toBeTruthy();
    for (const name of ['Their Pokémon', 'Start the fight', 'Saved trees']) expect(screen.getByRole('heading', { name })).toHaveAttribute('tabindex', '-1');
    const theirs = container.querySelector('.start-theirs')!.textContent;
    for (const words of ['Numel', 'Lv 12 · Hardy · Keen Eye', 'Oran Berry', 'Ember, Tackle']) expect(theirs).toContain(words);
    expect(rows()[0]!.textContent).toContain('Prinplup Lv 15 · 30/40');
    expect(rows()[0]!.textContent).toContain('Tackle · Growl');
    expect(rows()[0]!.textContent).toContain('Against Numel: Prinplup moves first · Speed 26 vs 21');
    expect(rows()[1]!.textContent).toContain('Against Numel: Numel moves first · Speed 21 vs 16');
    expect(container.querySelector('.start-danger')).toBeNull();
    for (const name of ['Start with Prinplup', 'Start with Machop']) expect(screen.getByRole('button', { name }).className).toBe('button');
    expect(container.querySelectorAll('.button-primary')).toHaveLength(0);
    cleanup();
    expect(show({ sheet: sheet([move('1')]) }).container.querySelector('.start-danger')!.textContent).toBe('Can KO you in one hit');
  });

  it("names his status and item (the draft's, else the save's, (item N) when the options cannot name it), and No item for theirs without one", () => {
    const base = sheet();
    const { container, rows } = show({
      ...team({ status: 'burn', item: 'Oran Berry', draft: { ...mon(REF_A).draft!, item: 0 } }, { draft: { ...mon(REF_B).draft!, item: 234 } }),
      sheet: { ...base, enemies: [{ ...base.enemies[0]!, item: null }] },
    });
    expect(container.querySelector('.start-theirs')!.textContent).toContain('No item');
    expect(rows()[0]!.textContent).toContain('· Burned');
    expect(rows()[0]!.textContent).not.toContain('Oran Berry');
    expect(rows()[1]!.textContent).toContain('· Leftovers');
    cleanup();
    const nameless = show({
      ...team({ item: 'Oran Berry', draft: { ...mon(REF_A).draft!, item: 155 } }, { item: 'Oran Berry', draft: { ...mon(REF_B).draft!, item: 155 } }),
      draft: [{ ref: REF_A, item: 9999 }], options: { ...draftOptions(), items: [] },
    });
    expect(nameless.rows()[0]!.textContent).toContain('(item 9999)');
    expect(nameless.rows()[0]!.textContent).not.toContain('Oran Berry');
    expect(nameless.rows()[1]!.textContent).toContain('Oran Berry');
  });

  it.each<[string, Partial<StartScreenProps>, number]>([
    ["another fight's sheet", { sheet: sheetOf(GARDENIA) }, 2],
    ['no pair yet', { sheet: sheet([move('0')], { pairs: [] }) }, 2],
    ['a stale sheet (the draft changed a level), for that row only', { draft: [{ ref: REF_A, level: 20 }] }, 1],
  ])('says it is working out the first matchup for %s', (_, over, working) => {
    const { rows } = show(over);
    expect(screen.getAllByText(WORKING)).toHaveLength(working);
    if (working === 1) {
      expect(rows()[0]!.textContent).not.toContain('Speed');
      expect(rows()[1]!.textContent).toContain('Speed 21 vs 16');
    }
  });

  it('says their Pokémon are loading with no sheet or error, and did not load, with nothing of the matchup, on an error', () => {
    show({ sheet: null });
    expect(screen.getByText('Loading their Pokémon…')).toBeTruthy();
    cleanup();
    const { container } = show({ sheet: null, sheetError: 'broke' });
    expect(container.textContent).not.toMatch(/Against|Working out the first matchup/);
    expect(container.textContent).toContain('Their Pokémon did not load.');
  });

  it('a click on a button or anywhere on a row starts with that Pokémon, once', async () => {
    const { p, user, rows } = show();
    expect(rows()[1]).toHaveClass('start-pick');
    await user.click(within(rows()[1]!).getByText('Tackle · Growl'));
    expect(p.onLead).toHaveBeenCalledExactlyOnceWith(REF_B);
    await user.click(within(rows()[0]!).getByRole('button', { name: 'Start with Prinplup' }));
    expect(vi.mocked(p.onLead).mock.calls).toEqual([[REF_B], [REF_A]]);
  });

  it('busy: the buttons are aria-disabled and start nothing, a row neither, with the working words, and Stop once slow', async () => {
    const { p, user, rows } = show({ busy: true, slow: true });
    const button = screen.getByRole('button', { name: 'Start with Prinplup' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await user.click(button);
    await user.click(rows()[0]!);
    expect(p.onLead).not.toHaveBeenCalled();
    expect(screen.getByText('Still working out the first matchup.')).toBeTruthy();
    expect(screen.queryByText(/step/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(p.onStop).toHaveBeenCalled();
  });

  it('a start that cannot go says why, disables the buttons, and a row click starts nothing', async () => {
    show({ teamRefs: [] });
    expect(screen.getByText('Add a Pokémon to the team first')).toBeTruthy();
    cleanup();
    const { p, user, rows } = show({ box: null });
    expect(screen.getByText('Reading the save…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start with Prinplup' })).toBeDisabled();
    expect(rows()[0]).not.toHaveClass('start-pick');
    await user.click(rows()[0]!);
    expect(p.onLead).not.toHaveBeenCalled();
  });

  it('no outlined rows: their Pokémon split by a hairline, his on a filled tile', () => {
    const css = readFileSync(resolve(__dirname, '../../../web/src/styles/run.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (sel: string) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1]!.split(',').map((x) => x.trim()).includes(sel)).map((m) => m[2]).join(' ');
    expect(rule('.start-team > li')).not.toMatch(/(^|[^-])border:/);
    expect(rule('.start-team > li')).toMatch(/background:\s*var\(--surface-muted\)/);
    expect(rule('.start-theirs > li')).not.toMatch(/(^|[^-])border:/);
    expect(rule('.start-theirs > li + li')).toMatch(/border-top:\s*1px solid var\(--border\)/);
  });

  it('the kept tree offer and saved trees open and delete, with no step count', async () => {
    const record: LineRecord = { save: null, start: { trainerId: TRISTAN, variant: 0, world: 0, team: [REF_A], draft: [{ ref: REF_A }] }, path: [], others: [] };
    const saved: SavedLine = { ...record, name: 'Plan one', path: [{ choice: 'a' }] as never };
    const { p, user } = show({ again: { fresh: false, record, key: 'k' } as StartScreenProps['again'], saved: [saved] });
    await user.click(within(screen.getByRole('region', { name: 'Kept tree' })).getByRole('button', { name: 'Open the kept tree' }));
    expect(p.onAgain).toHaveBeenCalled();
    const list = screen.getByRole('region', { name: 'Saved trees' });
    expect(within(list).getByText('Plan one')).toBeTruthy();
    expect(within(list).queryByText(/\bsteps?\b/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open Plan one' }));
    expect(p.onOpen).toHaveBeenCalledWith(saved);
    await user.click(screen.getByRole('button', { name: 'Delete Plan one' }));
    expect(p.onDelete).toHaveBeenCalledWith('Plan one');
  });
});
