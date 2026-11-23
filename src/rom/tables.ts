// Names for the ROM's type and growth rate IDs, shared by every module that prints or compares them.

/** Gen 4 type names by ROM ID. ID 9 is the unused "???" type. */
export const TYPE_NAMES: readonly string[] = ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', '???',
  'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark'];

/** Growth rate names by ROM ID, as the docs' Personal tab writes them. */
export const GROWTH_RATE_NAMES: readonly string[] = ['Medium Fast', 'Erratic', 'Fluctuating', 'Medium Slow', 'Fast', 'Slow'];
