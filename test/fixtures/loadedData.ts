// Small `LoadedData` fixtures for the battle tests: ROM species and trainers, docs trainers, and the name index over
// the docs species.

import type { LoadedData } from '../../src/battle/types.js';
import type { DocTrainer, DocTrainerMon } from '../../src/docs/teams.js';
import type { DocSpecies } from '../../src/docs/types.js';
import { buildNameIndex } from '../../src/names/nameIndex.js';
import { ROM_SCHEMA_VERSION } from '../../src/rom/extract.js';
import type { RomTrainer, TrainerMon } from '../../src/rom/trainers.js';
import type { SpeciesRecord, Stats } from '../../src/rom/types.js';

export const stats = (hp: number, atk: number, def: number, spa: number, spd: number, spe: number): Stats => ({ hp, atk, def, spa, spd, spe });

/** A ROM species record; types and abilities are ROM IDs. Fields left out are 1s, Normal, ratio 127, base friendship 70 and no abilities. */
export function romSpecies(id: number, fields: Partial<Omit<SpeciesRecord, 'id'>> = {}): SpeciesRecord {
  return { id, baseStats: stats(1, 1, 1, 1, 1, 1), types: [0, 0], genderRatio: 127, baseFriendship: 70, baseExp: 0, evYield: 0, growthRate: 0, abilities: [0, 0], ...fields };
}

/** A trainer Pokémon with a known Hardy nature, no overrides, a male-class PID (low byte 136) and Tackle. */
export function trainerMon(species: number, level: number, fields: Partial<TrainerMon> = {}): TrainerMon {
  return {
    species, form: 0, level, iv: 31, pid: 136, nature: 0, natureKnown: true, abilitySlot: 0, genderOverride: 0,
    abilityOverride: 0, item: 0, moves: [33], ...fields,
  };
}

/** A ROM trainer of class 2 (Youngster), single battle, no AI flags. */
export function romTrainer(index: number, party: TrainerMon[], fields: Partial<RomTrainer> = {}): RomTrainer {
  return { index, trainerClass: 2, battleType: 0, aiMask: 0, aiFlags: [], items: [], party, ...fields };
}

/** A docs Pokémon: Hardy, a blank ability cell, no item, Tackle. */
export function docMon(species: string, level: number, fields: Partial<DocTrainerMon> = {}): DocTrainerMon {
  return { level, species, gender: null, nature: 'Hardy', ability: '', item: null, moves: ['Tackle'], ...fields };
}

/** A docs trainer on Route 202 with no tags. */
export function docTrainer(split: string, name: string, order: number, party: DocTrainerMon[], fields: Partial<DocTrainer> = {}): DocTrainer {
  return { split, location: 'Route 202', locationGauntlet: false, field: null, name, tags: { starred: false, raw: [] }, order, party, ...fields };
}

/** A Personal tab row; only the ID and name matter here. */
export function docSpecies(id: number, name: string): DocSpecies {
  return { id, name, baseStats: stats(1, 1, 1, 1, 1, 1), types: ['Normal', 'Normal'], growthRate: 'Medium Fast', abilities: ['-', '-'] };
}

/** `LoadedData` over these records: `species` indexed by ID, and the name index over `docSpecies`. */
export function loadedData(fields: { species: SpeciesRecord[]; trainers: RomTrainer[]; docSpecies: DocSpecies[]; docTrainers: DocTrainer[] }): LoadedData {
  const species: SpeciesRecord[] = [];
  for (const record of fields.species) species[record.id] = record;
  const docs = { species: fields.docSpecies, moves: [], learnsets: new Map(), trainers: fields.docTrainers, aiChangesText: '' };
  return {
    rom: { schemaVersion: ROM_SCHEMA_VERSION, gameCode: 'JAK7', species, learnsets: [], moves: [], growth: [], trainers: fields.trainers, items: [] },
    names: buildNameIndex(docs),
    docs,
  };
}
