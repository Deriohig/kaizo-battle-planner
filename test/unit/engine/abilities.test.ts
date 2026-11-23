// The docs' Ability Changes tab: one row per species with its two abilities (src/docs/abilityChanges.ts). Against the
// real ROM: test/real/engineVsCalcAbilities.test.ts; the mod's behaviour changes (Oblivious): effects.test.ts.

import { describe, expect, it } from 'vitest';
import { parseAbilityChangesTab } from '../../../src/docs/abilityChanges.js';

describe('the Ability Changes tab', () => {
  it('parses one row per species with its two abilities, skipping empty rows; a tab without its columns throws', () => {
    const tab = 'Pokémon Name,Ability 1,Ability 2\nBULBASAUR,Overgrow,Overgrow\nVENUSAUR,Chlorophyll,Overgrow\n,,\nCHARIZARD,Solar Power,Blaze\n';
    expect(parseAbilityChangesTab(tab)).toEqual([
      { name: 'BULBASAUR', abilities: ['Overgrow', 'Overgrow'] }, { name: 'VENUSAUR', abilities: ['Chlorophyll', 'Overgrow'] }, { name: 'CHARIZARD', abilities: ['Solar Power', 'Blaze'] },
    ]);
    expect(() => parseAbilityChangesTab('Name,Ability 1,Ability 2\nBULBASAUR,Overgrow,Overgrow\n')).toThrow('no "Pokémon Name" column');
  });
});
