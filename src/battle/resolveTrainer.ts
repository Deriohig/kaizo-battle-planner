// Resolves a matched docs trainer into a battle-ready `ResolvedTrainer`: the ROM's party with the nature, ability and
// gender rules applied, and its other ROM copies as variants.

import type { DocTrainer, DocTrainerMon } from '../docs/teams.js';
import type { TrainerMatch } from '../names/matchTrainers.js';
import { abilityOf } from '../rom/abilities.js';
import { personalRowFor } from '../rom/forms.js';
import { trainerMonGender } from '../rom/gender.js';
import type { RomTrainer, TrainerMon } from '../rom/trainers.js';
import type { SpeciesRecord, Stats } from '../rom/types.js';
import { resolveNature } from './natures.js';
import type { LoadedData, PkcalcNatures, ResolvedMon, ResolvedTrainer, Sourced } from './types.js';

/** The battle-type bit for a double battle (`BATTLE_TYPE_DOUBLES` in pret/pokeplatinum); the ROM's trainers hold 0 or 2. */
const BATTLE_TYPE_DOUBLES = 2;

/** "Pokéfan Martha" → "pokefan-martha": lower case, accents dropped, every other run of characters one hyphen. */
export function slug(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * A docs trainer's ID: its split and name as slugs, then its place (from 1) among the trainers of its split whose names
 * slug alike, in docs order (`all`, every docs trainer). "roark-split/barry-2/2" is the split's second "Barry #2".
 */
export function trainerId(doc: DocTrainer, all: readonly DocTrainer[]): string {
  const name = slug(doc.name);
  const before = all.filter((other) => other.split === doc.split && other.order < doc.order && slug(other.name) === name).length;
  return `${slug(doc.split)}/${name}/${before + 1}`;
}

const allStats = (value: number): Stats => ({ hp: value, atk: value, def: value, spa: value, spd: value, spe: value });

/** The ROM trainer with this index. `RomData.trainers` is indexed by trainer index, but a list need not be. */
function romTrainer(trainers: RomTrainer[], index: number): RomTrainer {
  const trainer = trainers[index]?.index === index ? trainers[index] : trainers.find((candidate) => candidate.index === index);
  if (trainer === undefined) throw new Error(`The ROM has no trainer ${index}`);
  return trainer;
}

/** Docs ability cells that misspell an ability, with the ability they mean (the discrepancy groups' "slips"). */
const DOCS_ABILITY_SLIPS: Record<string, string> = { Syncronize: 'Synchronize' };

/**
 * The ability a docs ability cell names, or null for a blank cell, which names none. A known slip is read as the
 * ability it means (`DOCS_ABILITY_SLIPS`); any other cell that names no Gen 4 ability throws, naming `where`, as its
 * ability could not be offered as a candidate.
 */
function docsAbilityId(cell: string, names: LoadedData['names'], where: string): number | null {
  const text = cell.trim();
  if (text === '') return null;
  const id = names.abilityId(Object.hasOwn(DOCS_ABILITY_SLIPS, text) ? DOCS_ABILITY_SLIPS[text]! : text);
  if (id === null) throw new Error(`${where}: the docs' ability "${text}" is no Gen 4 ability`);
  return id;
}

/**
 * One ROM Pokémon against its docs Pokémon (the same slot), `where` naming it in errors. Its nature is `resolveNature`'s,
 * with `pkcalcNature` (PKCalc's, or null) as the alternative to a docs nature. Its ability is the ROM's (`abilityOf`),
 * disputed where another is possible, each then an alternative:
 * - the docs name another (`docsAbilityId`);
 * - the PID's lowest bit picked it (no ability override, two abilities) and the PID is untrusted (`natureKnown` false:
 *   the hack makes those PIDs by a rule we do not know), so the species' other ability is as likely.
 */
function resolveMon(mon: TrainerMon, docMon: DocTrainerMon | undefined, data: LoadedData, where: string, pkcalcNature: number | null): ResolvedMon {
  const row = personalRowFor(mon.species, mon.form);
  const record = data.rom.species[row];
  if (record === undefined) throw new Error(`The ROM has no species record ${row}`);
  const { id: abilityId, byPid } = abilityOf(data.rom.species, mon);
  const docsAbility = docsAbilityId(docMon?.ability ?? '', data.names, where);
  const otherAbility = record.abilities[0] === abilityId ? record.abilities[1] : record.abilities[0];
  const candidates = [docsAbility, byPid && !mon.natureKnown ? otherAbility : null];
  const abilityAlternatives = [...new Set(candidates.filter((id): id is number => id !== null && id !== abilityId))];
  const ability: Sourced<number> = { value: abilityId, source: 'rom', disputed: abilityAlternatives.length > 0, alternatives: abilityAlternatives };
  return {
    species: mon.species, form: mon.form, name: data.names.species(mon.species, mon.form), level: mon.level,
    gender: trainerMonGender(mon, record.genderRatio), ivs: allStats(mon.iv), evs: allStats(0),
    nature: resolveNature(mon, docMon?.nature ?? null, pkcalcNature), ability, item: mon.item, moves: [...mon.moves],
    baseStats: { ...record.baseStats }, types: [...record.types], friendship: baseFriendshipOf(data.rom.species, mon.species, record),
  };
}

/**
 * A trainer Pokémon's friendship: its species' base friendship. The cartridge builds the party with `Pokemon_InitWith`
 * (trainer_data.c), whose `sub_02073E18` sets friendship to `SpeciesData_GetSpeciesValue(monSpecies, SPECIES_DATA_BASE_FRIENDSHIP)`
 * (pokemon.c:433) for the species ID before the form is set, so a form's own Personal row is not read; `formRow` is
 * the fallback for a species the table lacks.
 */
function baseFriendshipOf(species: SpeciesRecord[], id: number, formRow: SpeciesRecord): number {
  return (species[id] ?? formRow).baseFriendship;
}

/** One ROM copy of a docs trainer, with no variants; `pkcalcNatures` as `resolveTrainer` takes it. */
function resolveCopy(match: TrainerMatch, data: LoadedData, pkcalcNatures?: PkcalcNatures): ResolvedTrainer {
  const trainer = romTrainer(data.rom.trainers, match.romIndex);
  const { doc } = match;
  return {
    id: trainerId(doc, data.docs.trainers), name: doc.name, split: doc.split, location: doc.location, order: doc.order,
    romIndex: trainer.index, trainerClass: trainer.trainerClass,
    battleType: (trainer.battleType & BATTLE_TYPE_DOUBLES) !== 0 ? 'double' : 'single',
    aiFlags: [...trainer.aiFlags], field: doc.field, tags: doc.tags, levelMismatch: match.levelMismatch === true,
    party: trainer.party.map((mon, slot) => resolveMon(mon, doc.party[slot], data, `${doc.split}: ${doc.name} [ROM ${trainer.index}] mon ${slot + 1}`,
      pkcalcNatures?.(trainer.index, slot) ?? null)),
    variants: [],
  };
}

/** The summed base-stat total of a party. */
function partyTotal(trainer: ResolvedTrainer): number {
  return trainer.party.reduce((sum, mon) => sum + Object.values(mon.baseStats).reduce((a, b) => a + b, 0), 0);
}

/**
 * Resolves a docs trainer's ROM copies: `match` and `others`, the docs trainer's other matches (its `shared` ones). The
 * result is the harder copy: the higher summed base-stat total of the party, then the higher ROM index; the
 * rest are its `variants`. A rival's copy is picked by the player's gender later, among these.
 *
 * Each Pokémon's nature follows `resolveNature`, with PKCalc's nature from `pkcalcNatures`, where given, as
 * the alternative to a docs nature; its ability, level, item and moves are the ROM's; its gender is
 * `trainerMonGender` with its form's gender ratio. A disputed nature or ability carries its alternatives.
 * Throws for a ROM index, species record or species name the data lacks, and for a docs ability cell that
 * names no ability (`docsAbilityId`).
 */
export function resolveTrainer(match: TrainerMatch, others: TrainerMatch[], data: LoadedData, pkcalcNatures?: PkcalcNatures): ResolvedTrainer {
  const copies = [match, ...others].map((copy) => resolveCopy(copy, data, pkcalcNatures));
  const harder = (a: ResolvedTrainer, b: ResolvedTrainer) => partyTotal(a) - partyTotal(b) || a.romIndex - b.romIndex;
  const chosen = copies.reduce((best, copy) => (harder(copy, best) > 0 ? copy : best));
  return { ...chosen, variants: copies.filter((copy) => copy !== chosen).sort((a, b) => a.romIndex - b.romIndex) };
}
