// Real-data check: each species' base EXP yield (personal byte 0x09, `SpeciesData.baseExpReward`) and EV yield (the u16
// at 0x0A, `SpeciesEVYields`, pokeplatinum include/struct_defs/species.h:43-44) from the hack ROM. The EXP formula reads
// the first; the second is pinned to 0 for every species, and no item may give an EV-gaining hold effect, so the engine
// can leave EVs alone. Hold effects 117 to 122 are the Power items'
// HOLD_EFFECT_LVLUP_*_EV_UP (item_hold_effects.txt); the hack gives those items effect 50 instead (holdEffects.test.ts).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractRomData } from '../../src/rom/extract.js';
import { needFiles, PK_ROM } from './env.js';

const suite = needFiles('Base EXP and EV yield from the ROM', { PK_ROM });

// [species ID, name, base EXP yield]; the hack set Chansey and Blissey to 1.
const BASE_EXP: [number, string, number][] = [
  [1, 'Bulbasaur', 64], [77, 'Ponyta', 152], [113, 'Chansey', 1], [242, 'Blissey', 1], [400, 'Bibarel', 116], [394, 'Prinplup', 143],
];

describe.skipIf(suite.skip)(suite.title, () => {
  const rom = suite.skip ? undefined : extractRomData(readFileSync(PK_ROM));

  it('has 508 species records', () => expect(rom?.species).toHaveLength(508));

  it.each(BASE_EXP)('species %i (%s) has base EXP %i', (id, _name, baseExp) => {
    expect(rom?.species[id]?.baseExp).toBe(baseExp);
  });

  it('gives every species an EV yield of 0', () => {
    expect((rom?.species ?? []).filter((s) => s.evYield !== 0).map((s) => s.id)).toEqual([]);
  });

  it('gives no item a hold effect from 117 to 122 (the EV-gaining ones)', () => {
    expect(rom?.items.length).toBeGreaterThan(0);
    expect(rom?.items.every((i) => i.holdEffect !== undefined)).toBe(true);
    const evItems = (rom?.items ?? []).filter((i) => i.holdEffect !== undefined && i.holdEffect >= 117 && i.holdEffect <= 122);
    expect(evItems.map((i) => i.id)).toEqual([]);
  });
});
