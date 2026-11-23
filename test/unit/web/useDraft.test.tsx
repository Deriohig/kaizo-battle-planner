// The draft as the page holds it (web/src/useDraft.ts): the team with each member's edits, kept for the save on screen;
// the editor's options and the edits without them; and the one Undo a save change offers when it replaced a team the
// player had changed. The fixture `box()`: Blaze `party:1` Lv 15 (HP 30/44), Starly `party:2` Lv 14, Big `box:1:4` over
// the cap (16), an unknown species `box:2:1`, a dead Bidoof `box:15:1`.

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import type { BoxJson } from '../../../src/server/apiTypes';
import { baseline, DRAFT_KEY } from '../../../web/src/draft';
import { useDraft } from '../../../web/src/useDraft';
import { box, draftOptions, mon, stubFetch } from './stubServer';

const serveOptions = () => stubFetch({ 'GET /api/draft/options': { json: draftOptions() } });
/** Options that fail until `options.fail` is set false. */
function flakyOptions() {
  const options = { fail: true };
  stubFetch({ 'GET /api/draft/options': () => (options.fail ? { status: 500, json: { error: 'boom' } } : { json: draftOptions() }) });
  return options;
}
const hook = (b = box()) => renderHook(({ b }) => useDraft(b), { initialProps: { b } });
async function readyHook() {
  serveOptions();
  const h = hook();
  await ready(h);
  return h;
}
const ready = (h: ReturnType<typeof hook>) => waitFor(() => expect(h.result.current.options).not.toBeNull());
const kept = () => JSON.parse(localStorage.getItem(DRAFT_KEY)!);
const NEWER = { savedAt: '2026-06-12T13:00:00.000Z' };
/** `box(over)` with Blaze and Starly swapped in the party (Starly `party:1`, Blaze `party:2`), each keeping its key. */
function swapped(over: Partial<BoxJson> = {}): BoxJson {
  const [blaze, starly, ...rest] = box().mons;
  return box({ ...over, mons: [{ ...starly!, ref: 'party:1', slot: 1 }, { ...blaze!, ref: 'party:2', slot: 2 }, ...rest] });
}

beforeEach(() => localStorage.clear());

it('an edit changes the entry and what is kept; a refused edit says why and changes nothing', async () => {
  const h = await readyHook();
  let problem: string | null = null;
  act(() => { problem = h.result.current.edit('party:1', { level: 16, status: 'burn' }); });
  expect(problem).toBeNull();
  expect(h.result.current.mons).toEqual([{ ref: 'party:1', level: 16, status: 'burn' }, { ref: 'party:2' }]);
  expect(kept().team).toEqual(h.result.current.mons);
  act(() => { problem = h.result.current.edit('party:1', { hp: 999 }); });
  expect(problem).toMatch(/^Blaze \(Monferno\): HP must be/);
  expect(h.result.current.mons[0]).toEqual({ ref: 'party:1', level: 16, status: 'burn' });
});

it('reset one, all to the cap, all to full HP, reset the team', async () => {
  const h = await readyHook();
  act(() => h.result.current.toCap());
  act(() => h.result.current.toFull());
  expect(h.result.current.mons).toEqual([{ ref: 'party:1', level: 16, hp: 46 }, { ref: 'party:2', level: 16 }]);   // Starly was full already
  expect(kept().team).toEqual(h.result.current.mons);
  act(() => h.result.current.reset('party:1'));
  expect(h.result.current.mons[0]).toEqual({ ref: 'party:1' });
  act(() => h.result.current.move(1, -1));
  act(() => h.result.current.resetAll());
  expect(h.result.current.mons).toEqual(baseline(box()));
});

it('place and moveTo change the team and what is kept; a place that changes nothing keeps nothing', async () => {
  const h = await readyHook();
  act(() => h.result.current.place(1, 'party:2'));                // its own slot
  act(() => h.result.current.moveTo(0, 0));
  for (const ref of ['box:15:1', 'box:2:1', 'box:9:9'] as const) act(() => h.result.current.place(0, ref));   // cannot join, or gone
  expect(h.result.current.team).toEqual(['party:1', 'party:2']);
  expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  act(() => h.result.current.place(1, 'box:1:4'));
  expect(kept().team).toEqual([{ ref: 'party:1' }, { ref: 'box:1:4' }]);
  act(() => h.result.current.add('party:2'));
  act(() => h.result.current.moveTo(0, 2));
  expect(h.result.current.team).toEqual(['box:1:4', 'party:2', 'party:1']);
  expect(kept().team).toEqual([{ ref: 'box:1:4' }, { ref: 'party:2' }, { ref: 'party:1' }]);
});

it('without the options the edits still work and the problem is said; options that come late drop what they refuse', async () => {
  const options = flakyOptions();
  const h = hook();
  await waitFor(() => expect(h.result.current.optionsProblem).toBe('boom'));
  act(() => { h.result.current.edit('party:1', { exp: 5000, item: 9999 }); });       // Lv 15 is 3375 to 4095 EXP; 9999 is on no list
  expect(h.result.current.mons[0]).toEqual({ ref: 'party:1', exp: 5000, item: 9999 });
  options.fail = false;
  act(() => h.result.current.retryOptions());
  await ready(h);
  expect(h.result.current.optionsProblem).toBeNull();
  expect(h.result.current.mons).toEqual([{ ref: 'party:1' }, { ref: 'party:2' }]);
  expect(kept().team).toEqual(h.result.current.mons);
});

it('an Undo held when the options come is kept through their check', async () => {
  const options = flakyOptions();
  const h = hook();
  await waitFor(() => expect(h.result.current.optionsProblem).toBe('boom'));
  act(() => { h.result.current.edit('party:2', { status: 'burn' }); });
  // The save is saved again, and another tab, on the new save without the options too, kept Blaze with an EXP off its
  // level and an item on no list.
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ savePath: box().savePath, ...NEWER, team: [{ ref: 'party:1', exp: 5000, item: 9999 }, { ref: 'party:2' }] }));
  h.rerender({ b: box(NEWER) });
  expect(h.result.current.mons[0]).toEqual({ ref: 'party:1', exp: 5000, item: 9999 });
  options.fail = false;
  act(() => h.result.current.retryOptions());
  await ready(h);
  expect(h.result.current.mons).toEqual([{ ref: 'party:1' }, { ref: 'party:2' }]);
  expect(kept()).toMatchObject({ savedAt: NEWER.savedAt, team: h.result.current.mons });
  act(() => h.result.current.replaced!.undo());
  expect(h.result.current.mons).toEqual([{ ref: 'party:1' }, { ref: 'party:2', status: 'burn' }]);
});

it('a save change replaces a changed team by the new save, with one Undo that re-checks it', async () => {
  const h = await readyHook();
  act(() => { h.result.current.edit('party:1', { hp: 44 }); });
  act(() => h.result.current.add('box:1:4'));
  // The new save: Blaze took damage and is now Lv 16 (max 46); the box Pokémon died.
  const next = box({ ...NEWER, mons: [mon('party:1', { ...box().mons[0]!, level: 16, hp: 20, maxHp: 46 }), box().mons[1]!, mon('box:1:4', { ineligibleReasons: ['dead'], eligible: false, draft: null })] });
  h.rerender({ b: next });
  expect(h.result.current.mons).toEqual(baseline(next));
  act(() => h.result.current.replaced!.undo());
  expect(h.result.current.mons).toEqual([{ ref: 'party:1', hp: 44 }, { ref: 'party:2' }]);      // the dead one is left out; 44 is legal at Lv 16
  expect(h.result.current.replaced).toBeNull();
  expect(kept()).toMatchObject({ savedAt: NEWER.savedAt, team: h.result.current.mons });
});

it('no Undo for an unchanged team, for another save file, the same save sent again, or after the next change to the team', async () => {
  const h = await readyHook();
  h.rerender({ b: box(NEWER) });
  expect(h.result.current.replaced).toBeNull();
  act(() => { h.result.current.edit('party:2', { status: 'burn' }); });
  h.rerender({ b: box({ ...NEWER, levelCap: 20 }) });                      // a settings change keeps the edits
  expect(h.result.current.mons[1]).toEqual({ ref: 'party:2', status: 'burn' });
  expect(h.result.current.replaced).toBeNull();
  h.rerender({ b: box({ savePath: '/other.dsv' }) });
  expect(h.result.current.replaced).toBeNull();
  act(() => { h.result.current.edit('party:2', { status: 'burn' }); });
  h.rerender({ b: box({ savePath: '/other.dsv', savedAt: '2026-06-13T00:00:00.000Z' }) });
  expect(h.result.current.replaced).not.toBeNull();
  act(() => h.result.current.remove('party:1'));
  expect(h.result.current.replaced).toBeNull();
});

it('Undo after a save that swapped the party puts each edit back on its own Pokémon, at its new ref', async () => {
  const h = await readyHook();
  act(() => { h.result.current.edit('party:1', { status: 'burn' }); });
  act(() => { h.result.current.edit('party:2', { hp: 1 }); });
  const next = swapped(NEWER);                                // Starly is now party:1, Blaze party:2
  h.rerender({ b: next });
  expect(h.result.current.mons).toEqual(baseline(next));
  act(() => h.result.current.replaced!.undo());
  expect(h.result.current.mons).toEqual([{ ref: 'party:2', status: 'burn' }, { ref: 'party:1', hp: 1 }]);   // the team's order is kept
  expect(kept()).toMatchObject({ savedAt: NEWER.savedAt, team: h.result.current.mons });
});

it('Undo leaves out a Pokémon that is gone or can no longer join, and edits nobody who took its slot', async () => {
  const h = await readyHook();
  act(() => { h.result.current.edit('party:1', { status: 'burn' }); });
  act(() => { h.result.current.edit('party:2', { hp: 1 }); });
  act(() => h.result.current.add('box:1:4'));
  // Blaze is gone, Starly moved up, a Shinx is party:2, Big died and another Pokémon sits in its old slot.
  const next = box({
    ...NEWER,
    mons: [
      { ...box().mons[1]!, ref: 'party:1', slot: 1 },
      mon('party:2', { key: 'key-shinx', nickname: 'SHINX', species: 'Shinx' }),
      mon('box:1:4', { key: 'key-kricketot', nickname: 'KRICKETOT', species: 'Kricketot' }),
      mon('box:15:2', { key: 'key-box:1:4', nickname: 'Big', species: 'Bibarel', level: 20, ineligibleReasons: ['dead'], eligible: false }),
    ],
  });
  h.rerender({ b: next });
  act(() => h.result.current.replaced!.undo());
  expect(h.result.current.mons).toEqual([{ ref: 'party:1', hp: 1 }]);
});

// Only the player's own changes drop the Undo: a second save over the untouched new team keeps it.
it('two save changes in a row keep the Undo, following each Pokémon by its key from the box it was made for', async () => {
  const h = await readyHook();
  act(() => { h.result.current.edit('party:2', { status: 'burn' }); });
  h.rerender({ b: box(NEWER) });
  h.rerender({ b: swapped({ savedAt: '2026-06-12T14:00:00.000Z' }) });
  act(() => h.result.current.replaced!.undo());
  expect(h.result.current.mons).toEqual([{ ref: 'party:2' }, { ref: 'party:1', status: 'burn' }]);
});
