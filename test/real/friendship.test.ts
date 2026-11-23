// Real-data check: base friendship from the hack ROM's Personal records (byte 0x12, `SpeciesData.baseFriendship` in
// pokeplatinum include/struct_defs/species.h). Known vanilla species are checked against pokeplatinum's
// res/pokemon/<species>/data.json `base_friendship` (commit 62bdaacdc): 70 for most, 140 for the Clefairy and Chansey
// lines, 0 for Mewtwo.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractRomData } from '../../src/rom/extract.js';
import { needFiles, PK_ROM } from './env.js';

const suite = needFiles('Base friendship from the ROM', { PK_ROM });

// [species ID, name, base friendship]
const KNOWN: [number, string, number][] = [
  [1, 'Bulbasaur', 70], [25, 'Pikachu', 70], [35, 'Clefairy', 140], [113, 'Chansey', 140], [150, 'Mewtwo', 0],
  [175, 'Togepi', 70], [242, 'Blissey', 140], [391, 'Monferno', 70], [448, 'Lucario', 70],
];

describe.skipIf(suite.skip)(suite.title, () => {
  const rom = suite.skip ? undefined : extractRomData(readFileSync(PK_ROM));

  it.each(KNOWN)('species %i (%s) has base friendship %i', (id, _name, friendship) => {
    expect(rom?.species[id]?.baseFriendship).toBe(friendship);
  });

  it('gives every species a byte value', () => {
    for (const record of rom?.species ?? []) expect(record.baseFriendship).toBeLessThanOrEqual(255);
  });
});
