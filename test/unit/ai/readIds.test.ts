// The shared Showdown-ID to ROM-ID helpers (src/ai/read/ids.ts).
import PS from 'pokemon-showdown';
import { describe, expect, it } from 'vitest';
import { ABILITY_NONE, ABILITY_SLOW_START, ITEM_NONE, MOVE_NONE, TYPE_FIRE } from '../../../src/ai/constants.js';
import { AiError } from '../../../src/ai/errors.js';
import {
  dexLookup, formOf, genderOf, LAST_ABILITY, NUM_ITEMS, romAbility, romIds, romItem, romMove, romTypes,
} from '../../../src/ai/read/ids.js';
import { abilityId, itemId, speciesId } from '../../../src/engine/index.js';

const noRomId = (kind: string, id: string): AiError => new AiError('BAD_VIEW', `Showdown ${kind} "${id}" has no ROM ID`);

describe('romAbility / romItem', () => {
  it.each([
    ['ability', LAST_ABILITY, abilityId, romAbility], ['item', NUM_ITEMS, itemId, romItem],
  ] as const)('maps every ROM %s to the lowest ROM ID with the same Showdown ID', (_kind, last, toShowdown, toRom) => {
    for (let id = 1; id <= last; id++) {
      const showdown = toShowdown(id);
      let lowest = 1;
      while (toShowdown(lowest) !== showdown) lowest++;
      expect(toRom(showdown), `${id}`).toBe(lowest);
    }
  });

  it("maps Slow Start both ways, '' and 'noability' to none, and refuses an unknown ID with BAD_VIEW, from one cached table", () => {
    expect([abilityId(ABILITY_SLOW_START), romAbility('slowstart'), romIds().abilities.get('slowstart')]).toEqual(['slowstart', 112, 112]);
    expect([romAbility(''), romAbility('noability'), romItem('')]).toEqual([ABILITY_NONE, ABILITY_NONE, ITEM_NONE]);
    expect(() => romAbility('nonsense')).toThrow(noRomId('ability', 'nonsense'));
    expect(() => romItem('nonsense')).toThrow(noRomId('item', 'nonsense'));
    expect(romIds()).toBe(romIds());
  });
});

describe('romMove / dexLookup', () => {
  it("gives '' as MOVE_NONE and a known move as its num", () => {
    expect(romMove(dexLookup(PS.Dex), '')).toBe(MOVE_NONE);
    expect(romMove(dexLookup(PS.Dex), 'tackle')).toBe(PS.Dex.moves.get('tackle').num);
    expect(romMove({ moveNum: () => 33 }, 'tackle')).toBe(33);
  });

  it('refuses an unknown move, and a dex num of 0, NaN or a negative, with BAD_VIEW', () => {
    expect(() => romMove(dexLookup(PS.Dex), 'nosuchmove')).toThrow(noRomId('move', 'nosuchmove'));
    const nums: Record<string, number> = { zero: 0, nan: Number.NaN, negative: -3 };
    const odd = { moves: { get: (id: string) => ({ exists: id !== 'gone', num: nums[id] ?? 0 }) } };
    for (const id of ['zero', 'nan', 'negative', 'gone']) {
      expect(dexLookup(odd).moveNum(id), id).toBeUndefined();
      expect(() => romMove(dexLookup(odd), id)).toThrow(noRomId('move', id));
    }
    // romMove itself refuses such an answer, which a native lookup can't give.
    for (const num of [0, Number.NaN, -1, -Infinity]) expect(() => romMove({ moveNum: () => num }, 'odd'), String(num)).toThrow(noRomId('move', 'odd'));
  });
});

describe('formOf, genderOf, romTypes', () => {
  it.each([
    [386, 'deoxys', 3, 0], [386, 'deoxysattack', 0, 1], [386, speciesId(386, 3), 0, 3], [413, 'wormadamsandy', 0, 1], [351, speciesId(351, 2), 0, 2],
    [386, 'nonsense', 2, 2], // not one of its forms: the fallback
    [25, 'pikachu', 3, 0], [25, 'nonsense', 3, 0], // no FORMS entry: always 0, never the fallback
  ])('formOf(%i, %s, fallback %i) is %i', (species, id, fallback, form) => {
    expect(formOf(species, id, fallback)).toBe(form);
  });

  it("maps 'M', 'F', 'N' to 0, 1, 2, and a single type into both slots", () => {
    expect(['M', 'F', 'N'].map((gender) => genderOf(gender as 'M' | 'F' | 'N'))).toEqual([0, 1, 2]);
    expect(romTypes(['Fire'])).toEqual([TYPE_FIRE, TYPE_FIRE]);
    expect(() => romTypes([])).toThrow(AiError);
  });
});
