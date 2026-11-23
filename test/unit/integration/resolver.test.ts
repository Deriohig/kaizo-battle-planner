import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../../../src/battle/catalog.js';
import { buildMoves } from '../../../src/battle/moves.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import { createResolver, fieldSpec, fightWorlds, monLabel, preStatusCandidates } from '../../../src/integration/resolver.js';
import { buildBox } from '../../../src/server/box.js';
import { DEFAULT_SETTINGS } from '../../../src/server/settings.js';
import { monferno as monfernoMon, TACKLE, zigzagoon } from '../../fixtures/battleMons.js';
import { stats } from '../../fixtures/loadedData.js';
import { GARDENIA_ID, monferno, saveFile, SERVER_SAVE, serverData, starly, TRISTAN_ID, TWINS_ID } from '../server/fixtures.js';

const BURN_WORD = 0x10;

function resolverFor(save = SERVER_SAVE) {
  const data = serverData();
  const box = buildBox({ file: saveFile(save), savePath: '/saves/game.dsv', savedAt: new Date('2026-11-08T12:00:00Z'), data, settings: DEFAULT_SETTINGS });
  return createResolver({ data, catalog: buildCatalog(data), moves: buildMoves(data), mons: box.byRef });
}

describe('resolver.mon', () => {
  it("gives a party Pokémon's MonInfo from the save: stats, moves, PP and full PP with PP Ups, item, ability, nature, status", () => {
    expect(resolverFor().mon('party:1')).toMatchObject({
      ref: 'party:1', maxHp: 44, fullPp: [35, 30], status: { kind: 'none' }, label: 'Mon', preStatusCandidates: [],   // Ember 25 + 1 PP Up = 30
      mon: {
        species: 391, level: 15, item: 217, moves: [33, 52], pp: [35, 30], ppUps: [0, 1], currentHp: 44, nickname: 'Mon',
        nature: { value: 8, disputed: false }, ability: { value: 66 },   // Impish, Blaze
      },
    });
  });

  it('labels by nickname, else species; two of one page name by level when they differ, else by place; a re-read save gives the new ones', () => {
    expect(resolverFor({ ...SERVER_SAVE, boxes: [] }).mon('party:2').label).toBe('Starly');
    const sameLevel = resolverFor();   // party:2 and box:1:1 are both a level-14 "Starly"
    expect(['party:2', 'box:1:1'].map((ref) => sameLevel.mon(ref).label)).toEqual(['Starly (party 2)', 'Starly (box 1 slot 1)']);
    const otherLevel = resolverFor({ ...SERVER_SAVE, boxes: [{ ...starly({ exp: 2600 }), box: 1, slot: 1 }] });   // level 16 from the experience
    expect(['party:2', 'box:1:1'].map((ref) => otherLevel.mon(ref).label)).toEqual(['Starly (Lv 14)', 'Starly (Lv 16)']);
    expect(resolverFor({ ...SERVER_SAVE, party: [starly({ nickname: 'Hawk' })] }).mon('party:1').label).toBe('Hawk');
  });

  it('gives the save status of a party Pokémon, and none for a box one (the PC heals it)', () => {
    const resolver = resolverFor({ ...SERVER_SAVE, party: [monferno(), starly({ status: BURN_WORD, currentHp: 20 })], boxes: [{ ...starly({ status: BURN_WORD }), box: 1, slot: 1 }] });
    expect(resolver.mon('party:2')).toMatchObject({ status: { kind: 'burn' }, maxHp: 35, mon: { currentHp: 20 } });
    expect(resolver.mon('box:1:1')).toMatchObject({ status: { kind: 'none' }, mon: { currentHp: 35 } });
  });

  it('throws, naming the ref, for a fainted party Pokémon, an empty slot, an ineligible box Pokémon and nonsense', () => {
    expect(() => resolverFor({ ...SERVER_SAVE, party: [monferno(), starly({ currentHp: 0 })] }).mon('party:2')).toThrow(/party:2/);
    const resolver = resolverFor();
    for (const ref of ['party:6', 'box:15:1']) expect(() => resolver.mon(ref)).toThrow(ref);   // box:15:1: the dead Ghost
    expect(() => resolver.mon('nonsense')).toThrow();
  });
});

describe('preStatusCandidates', () => {
  const withAbility = (value: number) => monfernoMon({ ability: { value, source: 'rom', disputed: false, alternatives: [] } });
  const SLEEP_TALK = 214;
  it.each([
    ['Guts', withAbility(62), [{ kind: 'burn' }, { kind: 'poison' }, { kind: 'toxic' }, { kind: 'paralysis' }]],
    ['Poison Heal', withAbility(90), [{ kind: 'poison' }, { kind: 'toxic' }]],
    ['Natural Cure', withAbility(30), [{ kind: 'sleep', turns: 1 }, { kind: 'poison' }]],
    ['Blaze', withAbility(66), []],
    ['a Sleep Talk user', monfernoMon({ moves: [52, SLEEP_TALK] }), [{ kind: 'sleep', turns: 1 }]],
  ])('proposes only the statuses that change the fight: %s', (_, mon, expected) => {
    expect(preStatusCandidates(mon)).toEqual(expected);
  });
});

describe('resolver.fight', () => {
  it('resolves the trainer, its field, its label and a copy of the spec', () => {
    const spec = { trainerId: TRISTAN_ID };
    const info = resolverFor().fight(spec);
    expect(info.spec).not.toBe(spec);
    // benchMonotone false: the AI reads the player's bench.
    expect(info).toMatchObject({ spec, trainer: { id: TRISTAN_ID }, label: 'Youngster Tristan', field: {}, benchMonotone: false });
  });

  it('applies the variant (0 the catalog copy, k variants[k-1]) and the field from the docs note; resolves a double as it is', () => {
    const resolver = resolverFor();
    const [first, second] = [resolver.fight({ trainerId: GARDENIA_ID }), resolver.fight({ trainerId: GARDENIA_ID, variant: 1 })];
    expect([first.trainer.romIndex, second.trainer.romIndex, first.field, second.label]).toEqual([4, 3, { weather: 'rain' }, 'Leader Gardenia (copy 2)']);
    expect(() => resolver.fight({ trainerId: GARDENIA_ID, variant: 2 })).toThrow(/variant 2/);
    expect(() => resolver.fight({ trainerId: 'roark-split/nobody/1' })).toThrow('roark-split/nobody/1');
    expect(resolver.fight({ trainerId: TWINS_ID }).trainer.battleType).toBe('double');
  });

  it("makes one world per disputed candidate, the trainer's value first", () => {
    const info = resolverFor().fight({ trainerId: TRISTAN_ID });
    expect(info.worlds.length).toBeGreaterThan(1);
    const starlyIndex = info.trainer.party.findIndex((m) => m.nature.disputed);
    expect(info.worlds[0]!.enemy[starlyIndex]).toEqual({ nature: info.trainer.party[starlyIndex]!.nature.value });
  });
});

describe('fightWorlds', () => {
  const sourced = <T>(value: T, alternatives: T[] = []) => ({ value, source: 'docs' as const, disputed: alternatives.length > 0, alternatives });
  const mon = (fields: Partial<ResolvedMon> = {}) => zigzagoon(fields);
  const nature = (value: number | null, alternatives: number[]) => ({ nature: sourced<number | null>(value, alternatives) });
  const [HARDY, LONELY, ADAMANT, DOCILE, SERIOUS, MODEST, MILD] = [0, 1, 3, 6, 12, 15, 16];

  it('gives one empty world when nothing is disputed, the neutral natures counting as one', () => {
    expect(fightWorlds([mon(), mon()])).toEqual([{ enemy: [] }]);
    expect(fightWorlds([mon(nature(HARDY, [DOCILE, SERIOUS]))])).toEqual([{ enemy: [] }]);
  });

  it('keeps natures that give different stats apart, and takes the product over the party', () => {
    expect(fightWorlds([mon(nature(HARDY, [ADAMANT])), mon(), mon({ ability: sourced(1, [2]) })])).toEqual([
      { enemy: [{ nature: HARDY }, {}, { ability: 1 }] },
      { enemy: [{ nature: HARDY }, {}, { ability: 2 }] },
      { enemy: [{ nature: ADAMANT }, {}, { ability: 1 }] },
      { enemy: [{ nature: ADAMANT }, {}, { ability: 2 }] },
    ]);
  });

  it('keeps natures apart by every stat, Special Attack too, even for a Pokémon with no special move', () => {
    // Atk 8 and SpA 16 at level 5: Lonely leaves Atk at 8, Mild raises SpA to 17; the AI's replacement reads SpA whatever the moves.
    const physical = mon({ level: 5, ivs: stats(31, 31, 31, 31, 31, 31), baseStats: stats(40, 20, 40, 100, 40, 40), moves: [TACKLE.id], ...nature(LONELY, [MILD]) });
    expect(fightWorlds([physical])).toEqual([{ enemy: [{ nature: LONELY }] }, { enemy: [{ nature: MILD }] }]);
  });

  it('covers every nature when no source gives one (value null), the neutral ones as one', () => {
    const natures = fightWorlds([mon(nature(null, Array.from({ length: 25 }, (_, n) => n)))]).map((w) => w.enemy[0]!.nature);
    expect(natures[0]).toBe(HARDY);
    expect(natures).toContain(MODEST);
    expect(natures).not.toContain(DOCILE);
    expect(natures.length).toBeLessThanOrEqual(21);
  });
});

it("fieldSpec turns the docs' field note into the engine's FieldSpec; monLabel names by nickname, or species for the default one", () => {
  expect(fieldSpec(null)).toEqual({});
  expect(fieldSpec({ raw: 'PERMANENT RAIN', weather: 'rain' })).toEqual({ weather: 'rain' });
  expect(fieldSpec({ raw: 'FOG, TRICK ROOM, GRAVITY', fog: true, trickRoom: true, gravity: true })).toEqual({ fog: true, trickRoom: true, gravity: true });
  expect([monLabel('Mon', 'Monferno'), monLabel('STARLY', 'Starly'), monLabel('', 'Starly')]).toEqual(['Mon', 'Starly', 'Starly']);
});
