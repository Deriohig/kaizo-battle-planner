// The stored team (web/src/draft.ts): the save's party as the baseline, the team kept in the browser for one save with
// each member's sparse edits, checked by the server's rules, and the helpers the editor and the slots work with. The
// fixture `box()`: Blaze `party:1`, Starly `party:2`, Big `box:1:4` over the cap, an unknown species `box:2:1`, a dead
// Bidoof `box:15:1`. `draftOptions()`: four items and EXP tables of level³.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftMonJson, DraftOptionsJson } from '../../../src/server/apiTypes';
import {
  added, allToCap, allToFull, baseline, DRAFT_KEY, type DraftPatch, type DraftStore, edited, fitted, isEdited, moveChoices, moved, movedTo,
  placed, problemText, readDraft, removed, shown, writeDraft,
} from '../../../web/src/draft';
import { box, draftOptions, mon } from './stubServer';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const O = draftOptions();
const blaze = () => box().mons[0]!;
const kept = (team: unknown, over: Partial<DraftStore> = {}) => JSON.stringify({ savePath: box().savePath, savedAt: box().savedAt, team, ...over });
const BASE = [{ ref: 'party:1' }, { ref: 'party:2' }];

describe('the team kept for a save', () => {
  it("the baseline is the save's party in slot order, without a fainted one but with one over the cap", () => {
    expect(baseline(box())).toEqual(BASE);
    const b = box({ mons: [mon('party:1', { hp: 0, eligible: false, ineligibleReasons: ['fainted'] }), mon('party:2', { level: 40, eligible: false, ineligibleReasons: ['over cap'] })] });
    expect(baseline(b)).toEqual([{ ref: 'party:2' }]);
  });

  it.each<[string, string | null, DraftMonJson[], DraftOptionsJson?]>([
    ['nothing kept gives the baseline', null, BASE],
    ['a kept team that is not a list gives the baseline', kept('x'), BASE],
    ['junk gives the baseline', 'not json', BASE],
    ['a team kept for this save saved again is not used', kept([{ ref: 'party:2' }], { savedAt: '2026-06-11T00:00:00.000Z' }), BASE],
    ['a team kept for another save is not used', kept([{ ref: 'party:2' }], { savePath: '/other.dsv' }), BASE],
    ['an emptied team stays empty', kept([]), []],
    ['in order, without what cannot join, a repeat or a seventh',
      kept([{ ref: 'box:1:4', level: 99 }, { ref: 'party:2' }, { ref: 'box:15:1' }, { ref: 'party:2' }, { ref: 'box:9:9' }, 7]), [{ ref: 'box:1:4', level: 99 }, { ref: 'party:2' }]],
    ['the edits, dropping only what the rules refuse',
      kept([{ ref: 'party:1', level: 16, hp: 999, item: 234, status: 'asleep', moves: [{ id: 172 }], foo: 1 }, { ref: 'party:2', level: 14, nature: 13, exp: 'x' }, { ref: 'box:15:1', level: 9 }]),
      [{ ref: 'party:1', level: 16, item: 234, moves: [{ id: 172 }] }, { ref: 'party:2' }], O],
    ['without the options, an EXP and item checked for shape only', kept([{ ref: 'party:1', exp: 3600, item: 9999 }, { ref: 'party:2', exp: 1.5 }]), [{ ref: 'party:1', exp: 3600, item: 9999 }, { ref: 'party:2' }]],
    ['with the options, an EXP and item checked by the tables', kept([{ ref: 'party:1', exp: 3600, item: 9999 }, { ref: 'party:2', exp: 1.5 }]), [{ ref: 'party:1', exp: 3600 }, { ref: 'party:2' }], O],
  ])('readDraft: %s', (_, stored, expected, options) => {
    if (stored !== null) localStorage.setItem(DRAFT_KEY, stored);
    expect(readDraft(box(), options)).toEqual(expected);
  });

  it('of a kept team of seven that can all join, the first six are read', () => {
    const refs = ['party:1', 'party:2', 'party:3', 'party:4', 'party:5', 'party:6', 'box:1:1'];
    localStorage.setItem(DRAFT_KEY, kept(refs.map((ref) => ({ ref }))));
    expect(readDraft(box({ mons: refs.map((ref) => mon(ref)) }))).toEqual(refs.slice(0, 6).map((ref) => ({ ref })));
  });

  it('writeDraft keeps the team under its save; a storage that refuses reads as the baseline and writes nothing', () => {
    writeDraft(box(), [{ ref: 'party:2' }]);
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!)).toEqual({ savePath: box().savePath, savedAt: box().savedAt, team: [{ ref: 'party:2' }] });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readDraft(box())).toEqual(BASE);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => writeDraft(box(), [])).not.toThrow();
  });
});

describe('changing the team', () => {
  const two = [{ ref: 'party:1' }, { ref: 'party:2' }];
  const three: DraftMonJson[] = [{ ref: 'party:1', level: 16 }, { ref: 'party:2' }, { ref: 'box:1:4', status: 'burn' }];
  const six: DraftMonJson[] = [1, 2, 3, 4, 5, 6].map((slot) => ({ ref: `box:3:${slot}` }));
  const refs = (team: DraftMonJson[]) => team.map((d) => d.ref);

  it('added, removed and moved', () => {
    expect(refs(added(two, 'box:1:4'))).toEqual(['party:1', 'party:2', 'box:1:4']);
    expect(added(two, 'party:1')).toEqual(two);
    expect(added(six, 'party:1')).toHaveLength(6);
    expect(removed(two, 'party:1')).toEqual([{ ref: 'party:2' }]);
    expect(refs(moved(two, 1, -1))).toEqual(['party:2', 'party:1']);
    expect(moved(two, 0, -1)).toEqual(two);
  });

  it.each<[string, DraftMonJson[], number, string, DraftMonJson[]]>([
    ['onto an occupied slot replaces the occupant, the newcomer with no edits', three, 1, 'box:5:5', [three[0]!, { ref: 'box:5:5' }, three[2]!]],
    ['onto an empty index appends', three, 3, 'box:5:5', [...three, { ref: 'box:5:5' }]],
    ['onto an index past the end appends', three, 5, 'box:5:5', [...three, { ref: 'box:5:5' }]],
    ['onto an empty team appends', [], 0, 'box:5:5', [{ ref: 'box:5:5' }]],
    ['a full team still takes a newcomer onto an occupied slot', six, 2, 'box:5:5', [six[0]!, six[1]!, { ref: 'box:5:5' }, ...six.slice(3)]],
    ['a member at another index moves, keeping its entry', three, 0, 'box:1:4', [three[2]!, three[0]!, three[1]!]],
    ['a member past the end goes last', three, 4, 'party:1', [three[1]!, three[2]!, three[0]!]],
    ['a member at its own index stays', three, 1, 'party:2', three],
  ])('placed: %s', (_, team, index, ref, expected) => {
    expect(placed(team, index, ref as DraftMonJson['ref'])).toEqual(expected);
  });

  it('placed returns the same team for a full append or a negative index; movedTo moves one member', () => {
    expect(placed(six, 6, 'box:5:5')).toBe(six);
    expect(placed(three, -1, 'box:5:5')).toBe(three);
    expect(refs(movedTo(three, 0, 2))).toEqual(['party:2', 'box:1:4', 'party:1']);
    expect(movedTo(three, 2, 0)).toEqual([three[2], three[0], three[1]]);
    expect(movedTo(three, 1, 1)).toEqual(three);
    for (const [from, to] of [[3, 0], [0, 3], [-1, 0]]) expect(movedTo(three, from!, to!)).toBe(three);
  });
});

describe('an edit', () => {
  const edit = (patch: DraftPatch, from: DraftMonJson = { ref: 'party:1' }) => edited(blaze(), O, from, patch);

  it('holds only what differs from the save', () => {
    for (const patch of [{ level: 15 }, { hp: 30 }, { item: 155 }, { status: 'sleep:2' }, { moves: [{ id: 183 }, { id: 52 }] }, { nature: blaze().draft!.nature }, { ivs: blaze().ivs! }, { exp: 3500 }]) {
      expect(edit(patch)).toEqual({ entry: { ref: 'party:1' }, problem: null });
    }
  });

  it.each<[string, DraftPatch, DraftMonJson, DraftMonJson]>([
    ['a healed status', { status: 'none' }, { ref: 'party:1' }, { ref: 'party:1', status: 'none' }],
    ['no item', { item: 0 }, { ref: 'party:1' }, { ref: 'party:1', item: 0 }],
    ['reordered moves', { moves: [{ id: 52 }, { id: 183 }] }, { ref: 'party:1' }, { ref: 'party:1', moves: [{ id: 52 }, { id: 183 }] }],
    ['a level', { level: 16 }, { ref: 'party:1' }, { ref: 'party:1', level: 16 }],
    ['an EXP inside the level', { exp: 3600 }, { ref: 'party:1' }, { ref: 'party:1', exp: 3600 }],
    ['an EXP of a higher level moves the level', { exp: 5000 }, { ref: 'party:1' }, { ref: 'party:1', level: 17, exp: 5000 }],
    ['a level drops an EXP outside it', { level: 20 }, { ref: 'party:1', level: 17, exp: 5000 }, { ref: 'party:1', level: 20 }],
    ["the save's EXP drops the level too", { exp: 3500 }, { ref: 'party:1', level: 17, exp: 5000 }, { ref: 'party:1' }],
    ['full HP stays full when the max moves', { level: 16 }, { ref: 'party:1', hp: 44 }, { ref: 'party:1', level: 16, hp: 46 }],
    ['an HP keeps its lost HP', { level: 16 }, { ref: 'party:1', hp: 1 }, { ref: 'party:1', level: 16, hp: 3 }],
    // Max 12: 1 HP is what the save's lost HP gives there too, so it is no edit.
    ['an HP stays alive', { level: 1 }, { ref: 'party:1', hp: 1 }, { ref: 'party:1', level: 1 }],
    ['a lower level drops a move it can no longer know', { level: 15 }, { ref: 'party:1', level: 16, moves: [{ id: 183 }, { id: 172 }] }, { ref: 'party:1', moves: [{ id: 183 }] }],
    ["with no move left the save's moves are back", { level: 15 }, { ref: 'party:1', level: 16, moves: [{ id: 172 }] }, { ref: 'party:1' }],
  ])('of %s', (_, patch, from, entry) => {
    expect(edit(patch, from)).toEqual({ entry, problem: null });
  });

  it('that the rules refuse changes nothing and says why by name in plain words; the server\'s refusal reads the same', () => {
    expect(edit({ hp: 45 })).toEqual({ entry: { ref: 'party:1' }, problem: 'Blaze (Monferno): HP must be a whole number from 1 to 44, not 45' });
    expect(edit({ moves: [{ id: 172 }] }).problem).toBe('Blaze (Monferno): cannot know Flame Wheel at level 15');
    expect(edit({ evs: { hp: 255, atk: 255, def: 1, spa: 0, spd: 0, spe: 0 } }).problem).toBe('Blaze (Monferno): EVs must be six whole numbers from 0 to 255, 510 in all at most');
    expect(edit({ status: 'asleep' }).problem).not.toBeNull();
    expect(problemText(box(), 'draft: party:2 hp must be a whole number from 1 to 38, not 0')).toBe('Starly: HP must be a whole number from 1 to 38, not 0');
    for (const other of ['draft lists party:1 twice', 'draft: box:9:9 level must be a number']) expect(problemText(box(), other)).toBe(other);
  });
});

describe('what the editor works with', () => {
  it('what a row shows: the save, then the edits, and the HP the fight starts with', () => {
    expect(shown(blaze(), O, { ref: 'party:1' })).toMatchObject({ level: 15, exp: 3500, expRange: { from: 3375, to: 4095 }, hp: 30, maxHp: 44, status: 'sleep:2', item: 155, moves: [{ id: 183, name: 'Mach Punch' }, { id: 52, name: 'Ember' }] });
    expect(shown(blaze(), O, { ref: 'party:1', level: 16, status: 'none', moves: [{ id: 172 }] })).toMatchObject({ level: 16, exp: 4096, hp: 32, maxHp: 46, status: 'none', moves: [{ id: 172, name: 'Flame Wheel' }] });
    expect(shown(blaze(), null, { ref: 'party:1', level: 16 })).toMatchObject({ exp: null, expRange: null, maxHp: 46 });
  });

  it("the moves on offer: the save's, then what it learns by that level, each once", () => {
    expect(moveChoices(blaze(), 16)).toEqual([{ id: 183, name: 'Mach Punch', level: null }, { id: 52, name: 'Ember', level: null }, { id: 10, name: 'Scratch', level: 1 }, { id: 172, name: 'Flame Wheel', level: 16 }]);
  });

  it('all to the cap raises those below it only; all to full sets each HP to its max; fitted checks each member in order', () => {
    expect(allToCap(box(), O, [{ ref: 'party:1' }, { ref: 'party:2', level: 10 }, { ref: 'box:1:4' }])).toEqual([{ ref: 'party:1', level: 16 }, { ref: 'party:2', level: 16 }, { ref: 'box:1:4' }]);
    expect(allToFull(box(), O, [{ ref: 'party:1', level: 16 }, { ref: 'party:2' }])).toEqual([{ ref: 'party:1', level: 16, hp: 46 }, { ref: 'party:2' }]);
    expect(fitted(box(), O, ['party:2', 'party:1', 'box:15:1'], [{ ref: 'party:1', level: 16, hp: 999 }])).toEqual([{ ref: 'party:2' }, { ref: 'party:1', level: 16 }, { ref: 'box:15:1' }]);
    expect([isEdited({ ref: 'party:1' }), isEdited({ ref: 'party:1', level: 16 })]).toEqual([false, true]);
  });
});
