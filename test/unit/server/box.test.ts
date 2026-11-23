import { describe, expect, it } from 'vitest';
import { SaveError, type SaveLocation } from '../../../src/save/readSave.js';
import type { BoxMonJson, SettingsJson } from '../../../src/server/apiTypes.js';
import { buildBox, type BoxState, monKey, monRef, parseMonRef } from '../../../src/server/box.js';
import { runOf, splitsOf } from '../../../src/server/run.js';
import { DEFAULT_SETTINGS } from '../../../src/server/settings.js';
import type { TestMon } from '../../fixtures/buildSave.js';
import { GARDENIA_ID, inBox, monferno, SERVER_SAVE, type SaveFileOptions, saveFile, serverData, starly } from './fixtures.js';

const SAVE_PATH = '/mnt/c/Users/User/Desktop/Games/Emulators/Battery/x.dsv';
const data = serverData();
const build = (file: Uint8Array, d = data, settings: SettingsJson = DEFAULT_SETTINGS): BoxState =>
  buildBox({ file, savePath: SAVE_PATH, savedAt: new Date('2026-11-08T09:30:00.000Z'), data: d, settings });
const boxOf = (opts: SaveFileOptions, settings: Partial<SettingsJson> = {}) => build(saveFile(opts), data, { ...DEFAULT_SETTINGS, ...settings });
const monAt = (state: BoxState, ref: string): BoxMonJson => state.json.mons.find((m) => m.ref === ref)!;
const refs = (list: { ref: string }[]) => list.map((m) => m.ref);
const ALL = (iv: number) => ({ hp: iv, atk: iv, def: iv, spa: iv, spd: iv, spe: iv });

it('monRef and parseMonRef round-trip every location and refuse anything else; monKey is "pid:" and 8 lowercase hex digits', () => {
  const locations: SaveLocation[] = [{ kind: 'party', slot: 1 }, { kind: 'party', slot: 6 }, { kind: 'box', box: 1, slot: 1 }, { kind: 'box', box: 18, slot: 30 }];
  expect([locations.map(monRef), locations.map((l) => parseMonRef(monRef(l)))]).toEqual([['party:1', 'party:6', 'box:1:1', 'box:18:30'], locations]);
  const bad = ['box:19:1', 'x', 'party:0', 'party:7', 'box:1:31', 'box:0:1', 'box:01:1', 'party:1 ', 'box:1', ''];
  expect(bad.map(parseMonRef)).toEqual(bad.map(() => null));
  expect([0x2939ae6a, 42, 0xffffffff].map(monKey)).toEqual(['pid:2939ae6a', 'pid:0000002a', 'pid:ffffffff']);
});

describe('buildBox', () => {
  it('lists a party Monferno at 20/44 HP, asleep 2 turns, with its IVs, EVs, nature effect and Hidden Power', () => {
    // Hidden Power from the IVs in game order (HP, Atk, Def, Spe, SpA, SpD): lowest bits give 32, so floor(32 × 15 / 63) = 7,
    // Steel; second bits give 50, so floor(50 × 40 / 63) + 30 = 61.
    const state = boxOf({ party: [monferno({ currentHp: 20, status: 2 })] });
    expect(state.json.mons).toEqual([{
      ref: 'party:1', key: 'pid:2939ae6a', nickname: 'Mon', species: 'Monferno', speciesId: 391, level: 15, nature: 'Impish', ability: 'Blaze', item: 'Quick Claw',
      moves: [{ name: 'Tackle', pp: 35, maxPp: 35 }, { name: 'Ember', pp: 30, maxPp: 30 }], hp: 20, maxHp: 44, status: 'sleep:2',
      location: 'party', box: null, slot: 1, eligible: true, ineligibleReasons: [], notes: [],
      ivs: { hp: 0, atk: 26, def: 12, spa: 10, spd: 7, spe: 24 }, evs: { hp: 4, atk: 252, def: 1, spa: 2, spd: 3, spe: 250 },
      hiddenPower: { type: 'Steel', power: 61 }, natureEffect: { up: 'def', down: 'spa' }, types: ['Fire', 'Fighting'],
      showdown: [
        'Mon (Monferno) (M) @ Quick Claw', 'Level: 15', 'Ability: Blaze', 'EVs: 4 HP / 252 Atk / 1 Def / 2 SpA / 3 SpD / 250 Spe', 'Impish Nature',
        'IVs: 0 HP / 26 Atk / 12 Def / 10 SpA / 7 SpD / 24 Spe', '- Tackle', '- Ember',
      ].join('\n'),
      draft: {
        exp: 2449, growthRate: 3, baseStats: { hp: 64, atk: 78, def: 52, spa: 78, spd: 52, spe: 81 }, nature: 8, item: 217,
        moves: [{ id: 33, ppUps: 0 }, { id: 52, ppUps: 1 }], learnset: [],
      },
    }]);
    expect(state.team.map((m) => [m.nickname, m.currentHp, m.status])).toEqual([['Mon', 20, { kind: 'sleep', turns: 2 }]]);
  });

  it.each<[string, TestMon, object]>([
    ['a box Pokémon: its Showdown set, full HP and no status', inBox(starly({ nickname: 'Pidge' }), 2, 5), {
      species: 'Starly', level: 14, nature: 'Quiet', ability: 'Keen Eye', item: null, hp: 35, maxHp: 35, status: null, location: 'box', box: 2, slot: 5, eligible: true,
      showdown: ['Pidge (Starly) (M)', 'Level: 14', 'Ability: Keen Eye', 'Quiet Nature', 'IVs: 0 HP / 0 Atk / 0 Def / 0 SpA / 0 SpD / 0 Spe', '- Tackle'].join('\n'),
    }],
    ['PP Ups in the max PP', monferno({ pp: [50, 28], ppUps: [3, 1] }), { moves: [{ name: 'Tackle', pp: 50, maxPp: 56 }, { name: 'Ember', pp: 28, maxPp: 30 }] }],
    ['all-31 IVs: Hidden Power Dark 70', starly({ pid: 0xdeadbeef, ivs: ALL(31) }), { hiddenPower: { type: 'Dark', power: 70 } }],
    ['all-0 IVs: Hidden Power Fighting 30', starly({ pid: 0x1234abcd, ivs: ALL(0) }), { hiddenPower: { type: 'Fighting', power: 30 } }],
    ['a neutral nature (PID 25,000,000, a multiple of 25): Hardy, no effect', starly({ pid: 0x017d7840 }), { nature: 'Hardy', natureEffect: null }],
    ['the ROM types once when both slots agree', starly(), { types: ['Normal', 'Flying'] }],
  ])('gives %s', (_name, mon, expected) => {
    const opts = 'box' in mon ? { boxes: [mon as ReturnType<typeof inBox>] } : { party: [mon] };
    expect(boxOf(opts).json.mons[0]).toMatchObject(expected);
  });

  it('sets each team member\'s origin from the save\'s trainer: "own", "traded" or "tradedOtherLanguage"', () => {
    const own = { otId: 777, otName: 'Lucas', otGender: 0 as const, language: 2 };
    const state = boxOf({
      trainer: { name: 'Lucas', id: 777, gender: 0, badgeMask: 1 },
      party: [monferno({ ...own }), starly({ ...own, otId: 25643, nickname: 'Hilary' }), starly({ ...own, otId: 25643, language: 1, nickname: 'Abroad' })],
      boxes: [inBox(starly({ ...own, otId: 25643, nickname: 'Boxed' }), 1, 1)],
    });
    expect(state.team.map((m) => [m.nickname, m.origin])).toEqual([['Mon', 'own'], ['Hilary', 'traded'], ['Abroad', 'tradedOtherLanguage'], ['Boxed', 'traded']]);
  });

  it('makes a Pokémon in the graveyard (box 15 on, or the setting\'s box on) ineligible as dead, and one over the cap "over cap"', () => {
    const graves = boxOf({ boxes: [inBox(starly(), 16, 3), inBox(starly(), 17, 1)] });
    expect([graves.json.mons.map((m) => [m.ref, m.eligible, m.ineligibleReasons]), graves.team]).toEqual([[['box:16:3', false, ['dead']], ['box:17:1', false, ['dead']]], []]);
    const from17 = boxOf({ boxes: [inBox(starly(), 16, 3), inBox(starly(), 17, 1)] }, { graveyardBox: 17 });
    expect([refs(from17.json.mons.filter((m) => m.eligible)), boxOf({}, { graveyardBox: 12 }).json.graveyardBoxes]).toEqual([['box:16:3'], [12, 13, 14, 15, 16, 17, 18]]);
    // Experience 5460 is level 20 on the medium slow curve; with no badges the cap is 16, with two 28.
    const save = { party: [monferno()], boxes: [inBox(monferno({ exp: 5460 }), 1, 1)] };
    expect([monAt(boxOf(save), 'box:1:1'), boxOf(save).team.map((m) => monRef(m.location))])
      .toMatchObject([{ level: 20, eligible: false, ineligibleReasons: ['over cap'] }, ['party:1']]);
    expect(monAt(boxOf({ ...save, badgeMask: 0b11 }), 'box:1:1')).toMatchObject({ eligible: true, ineligibleReasons: [] });
  });

  it('flags eggs, unknown IDs and bad checksums, without failing the rest of the box', () => {
    const state = boxOf({
      party: [monferno()],
      boxes: [
        inBox(starly({ moves: [33, 999], pp: [35, 10], ppUps: [0, 0] }), 1, 1), inBox(starly({ pid: 0x00c0ffee, corrupt: true }), 1, 2),
        inBox(starly({ nickname: 'Pidge' }), 1, 3), inBox(starly({ species: 400, nickname: 'Bibby' }), 1, 4), inBox(starly({ isEgg: true }), 1, 5),
      ],
    });
    expect(state.json.mons).toMatchObject([
      { ref: 'party:1', eligible: true },
      { ref: 'box:1:1', eligible: false, ineligibleReasons: ['unknown move 999'], showdown: null,
        moves: [{ name: 'Tackle', pp: 35, maxPp: 35 }, { name: '(move 999)', pp: 10, maxPp: 0 }] },
      { ref: 'box:1:2' },
      { ref: 'box:1:3', eligible: true },
      { ref: 'box:1:4', nickname: 'Bibby', species: '(species 400)', speciesId: 400, eligible: false, ineligibleReasons: ['unknown species 400'], showdown: null, types: [] },
      { ref: 'box:1:5', eligible: false, ineligibleReasons: ['egg'], showdown: null },
    ]);
    // Keyed by its PID like every other.
    expect(monAt(state, 'box:1:2')).toEqual({
      ref: 'box:1:2', key: 'pid:00c0ffee', nickname: '', species: 'Unreadable', speciesId: 0, level: 0, nature: null, ability: '', item: null, moves: [],
      hp: 0, maxHp: 0, status: null, location: 'box', box: 1, slot: 2, eligible: false, ineligibleReasons: ['bad checksum'], notes: [],
      ivs: null, evs: null, hiddenPower: null, natureEffect: null, types: [], showdown: null, draft: null,
    });
    expect([state.team.map((m) => m.nickname), [...state.byRef.keys()], state.byRef.get('box:1:3') === state.team[1]]).toEqual([['Mon', 'Pidge'], ['party:1', 'box:1:3'], true]);
  });

  it('reads types from the ROM, and flags a species or move the ROM lacks as unknown, even when the docs name it', () => {
    const changed = serverData();
    changed.rom.species[396] = { ...changed.rom.species[396]!, types: [11, 11] };
    expect(build(saveFile({ party: [monferno(), starly()] }), changed).json.mons.map((m) => m.types)).toEqual([['Fire', 'Fighting'], ['Water']]);
    delete changed.rom.moves[52];
    delete changed.rom.species[396];
    const state = build(saveFile({ party: [monferno(), starly()] }), changed);
    expect([state.json.mons, state.team]).toMatchObject([[
      { species: 'Monferno', eligible: false, ineligibleReasons: ['unknown move 52'], showdown: null,
        moves: [{ name: 'Tackle', pp: 35, maxPp: 35 }, { name: 'Ember', pp: 30, maxPp: 0 }] },
      // With no Personal row to compute from, a party Pokémon's max HP is its stored one.
      { species: 'Starly', hp: 35, maxHp: 35, eligible: false, ineligibleReasons: ['unknown species 396'], showdown: null },
    ], []]);
  });

  it('follows the badge mask for badges and the level cap, unless the cap is overridden; a file that is not a save throws', () => {
    // The fixture docs have two splits, so five badges stop at the last.
    expect(boxOf({ badgeMask: 0b00011111 }).json).toEqual({
      savePath: SAVE_PATH, savedAt: '2026-11-08T09:30:00.000Z', badges: 5, levelCap: 63, graveyardBoxes: [15, 16, 17, 18], mons: [],
      run: {
        split: 'Gardenia Split', splitIndex: 1, splits: ['Roark Split', 'Gardenia Split'], alsoPossible: [], fights: [{ id: GARDENIA_ID, defeated: false }], next: GARDENIA_ID,
      },
    });
    expect([boxOf({ badgeMask: 0b111 }).json, boxOf({ badgeMask: 0b111 }, { levelCapOverride: 47 }).json])
      .toMatchObject([{ badges: 3, levelCap: 42 }, { badges: 3, levelCap: 47 }]);
    expect(() => build(new Uint8Array(10))).toThrow(SaveError);
  });

  it('lists the party first, then the boxes by box and slot, and maps each eligible ref to its team member', () => {
    const state = boxOf({
      party: [monferno(), starly()],
      boxes: [inBox(starly({ nickname: 'C' }), 3, 1), inBox(starly({ nickname: 'B' }), 1, 2), inBox(starly({ nickname: 'A' }), 1, 1), inBox(starly(), 15, 1)],
    });
    expect(refs(state.json.mons)).toEqual(['party:1', 'party:2', 'box:1:1', 'box:1:2', 'box:3:1', 'box:15:1']);
    expect([[...state.byRef.entries()].map(([ref, mon]) => `${ref} ${mon.nickname}`), state.team.map((m) => m.nickname)])
      .toEqual([['party:1 Mon', 'party:2 Starly', 'box:1:1 A', 'box:1:2 B', 'box:3:1 C'], ['Mon', 'Starly', 'A', 'B', 'C']]);
  });

  it('gives sprite fields: shiny when its PID and OT IDs XOR below 8 (not an egg); a non-zero form that has a sprite of its own', () => {
    const [TID, SID] = [12345, 54321];
    const otId = ((SID << 16) | TID) >>> 0;
    const pidXor = (xor: number) => ((((TID ^ SID ^ 0x7e4b ^ xor) & 0xffff) << 16) | 0x7e4b) >>> 0;
    const mons: Partial<TestMon>[] = [
      { pid: pidXor(7), otId }, { pid: pidXor(8), otId }, { pid: pidXor(0), otId, isEgg: true },
      { species: 479, form: 2 }, { species: 201, form: 27 }, { species: 479, form: 0 }, { form: 1 },   // Starly has no forms
    ];
    const sprite = (m: BoxMonJson) => ({ speciesId: m.speciesId, ...('formId' in m && { formId: m.formId }), ...('shiny' in m && { shiny: m.shiny }) });
    expect(boxOf({ boxes: mons.map((fields, k) => inBox(starly(fields), 1, k + 1)) }).json.mons.map(sprite)).toEqual([
      { speciesId: 396, shiny: true }, { speciesId: 396 }, { speciesId: 396 },
      { speciesId: 479, formId: 2 }, { speciesId: 201, formId: 27 }, { speciesId: 479 }, { speciesId: 396 },
    ]);
  });
});

describe('the run, the draft facts and the pool', () => {
  // The default save: 1 badge; party Monferno Lv 15 and Starly Lv 14; box 1 slot 1 Starly; box 15 slot 1 dead.
  // Monferno (391) learns Ember (52) at level 16 here: the shared fixture data has no learnsets.
  const learns = serverData();
  learns.rom.learnsets[391] = [{ move: 52, level: 16 }];
  const box = build(saveFile(), learns);

  it('the run is the badge count\'s split, its fights following the save\'s trainer-defeated flags', () => {
    // Leader Gardenia is ROM 4 with ROM 3 as its copy: either flag beats her. ROM 1 (Tristan) is in the Roark Split.
    const withFlags = (defeatedTrainers: number[]) => build(saveFile({ ...SERVER_SAVE, defeatedTrainers }), learns).json.run;
    expect([box.json.run, withFlags([3]), withFlags([1])]).toEqual([
      { ...runOf(1, splitsOf(learns.docs)), fights: [{ id: GARDENIA_ID, defeated: false }], next: GARDENIA_ID },
      { ...runOf(1, splitsOf(learns.docs)), fights: [{ id: GARDENIA_ID, defeated: true }], next: null },
      box.json.run,
    ]);
  });

  it('a Pokémon that may fight has its draft facts, with its level-up moves; one the data lacks is "(move <id>)" with 0 PP', () => {
    const mon = monferno();
    expect(monAt(box, 'party:1').draft).toEqual({
      exp: mon.exp, growthRate: learns.rom.species[391]!.growthRate, baseStats: learns.rom.species[391]!.baseStats, nature: mon.pid % 25, item: mon.item,
      moves: mon.moves!.map((id, k) => ({ id, ppUps: mon.ppUps![k] })), learnset: [{ level: 16, id: 52, name: 'Ember', pp: 25 }],
    });
    const odd = serverData();
    odd.rom.learnsets[396] = [{ move: 999, level: 1 }, { move: 33, level: 5 }];
    expect(monAt(build(saveFile(), odd), 'party:2').draft!.learnset).toEqual([{ level: 1, id: 999, name: '(move 999)', pp: 0 }, { level: 5, id: 33, name: 'Tackle', pp: 35 }]);
  });

  it('the dead and the unreadable have none and are not in the pool; over the cap, still draftable and in the pool', () => {
    const unreadable = boxOf({ party: [monferno()], boxes: [inBox(starly({ corrupt: true }), 1, 2)] });
    expect([monAt(box, 'box:15:1').draft, box.pool.has('box:15:1'), monAt(unreadable, 'box:1:2').draft, [...unreadable.pool.keys()]]).toEqual([null, false, null, ['party:1']]);
    const capped = build(saveFile(), learns, { ...DEFAULT_SETTINGS, levelCapOverride: 14 });
    const m = monAt(capped, 'party:1');
    expect([m.eligible, m.ineligibleReasons, m.draft === null, capped.byRef.has('party:1'), capped.pool.get('party:1')!.level]).toEqual([false, ['over cap'], false, false, 15]);
    // The pool is exactly the Pokémon with draft facts.
    expect([[...capped.pool.keys()], capped.json.mons.filter((x) => x.draft !== null).map((x) => x.ref)]).toEqual(Array(2).fill(['party:1', 'party:2', 'box:1:1']));
  });
});
