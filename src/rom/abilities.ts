// The ability a trainer Pokémon has in battle, from the ROM alone.

import { personalRowFor } from './forms.js';
import type { TrainerMon } from './trainers.js';
import type { SpeciesRecord } from './types.js';

/**
 * A trainer Pokémon's ability ID, from its form's Personal row, with the first ability when the species has no second.
 * `byPid` says the PID's lowest bit chose it: no override, and two different abilities to choose from.
 */
export function abilityOf(species: SpeciesRecord[], mon: TrainerMon): { id: number; byPid: boolean } {
  const row = personalRowFor(mon.species, mon.form);
  const record = species[row];
  if (record === undefined) throw new Error(`The ROM has no species record ${row}`);
  const [first, second] = record.abilities;
  return {
    id: mon.abilitySlot === 1 && second !== 0 ? second : first,
    byPid: mon.abilityOverride === 0 && second !== 0 && second !== first,
  };
}
