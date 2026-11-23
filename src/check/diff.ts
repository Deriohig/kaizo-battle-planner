// Diffs the decoded ROM against the official docs for the real-data checks: each field of a species, learnset, move
// or matched trainer Pokémon on which the two disagree becomes one Diff.

import { docsNature } from '../battle/natures.js';
import type { KaizoDocs } from '../data/load.js';
import { matchTrainers } from '../names/matchTrainers.js';
import type { NameIndex } from '../names/nameIndex.js';
import { normaliseName } from '../names/normalise.js';
import { abilityOf } from '../rom/abilities.js';
import type { RomData } from '../rom/extract.js';
import { NATURES } from '../rom/natures.js';
import { GROWTH_RATE_NAMES, TYPE_NAMES } from '../rom/tables.js';
import { FEMALE_TRAINER_CLASSES } from '../rom/trainerClassGender.js';
import type { Stats } from '../rom/types.js';

/**
 * The areas that compare with PKCalc rather than with the docs: the ROM's trainers (src/check/pkcalc.ts), and in `calc`
 * our damage calc's rolls (src/check/pkcalcCalc.ts), where the `rom` side is ours.
 */
export const PKCALC_AREAS = ['pkcalc-join', 'pkcalc-ai', 'pkcalc-party-order', 'pkcalc-sets', 'calc'] as const;
export type DiffArea = 'species' | 'learnset' | 'move' | 'trainer' | typeof PKCALC_AREAS[number];

/**
 * `field` of `key` (a species, learnset, move or trainer Pokémon) differs: the ROM says `rom`, the other source says
 * `docs`. The other source is the docs, except in the `pkcalc-` areas, where it is PKCalc.
 */
export type Diff = { area: DiffArea; key: string; field: string; rom: unknown; docs: unknown };

/** One difference as accepted-diffs.json holds it: the other side is named `pkcalc` in the `pkcalc-` areas, `docs` elsewhere. */
export type KeyedDiff = { rom: unknown; docs?: unknown; pkcalc?: unknown };

/** The name of a diff's other side in accepted-diffs.json and docs/data-discrepancies.md. */
export function otherSide(area: DiffArea): 'docs' | 'pkcalc' {
  return (PKCALC_AREAS as readonly string[]).includes(area) ? 'pkcalc' : 'docs';
}

const STATS: (keyof Stats)[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

/** The Personal tab writes "-" for a species' missing second ability, which the ROM stores as ability 0. */
const NO_ABILITY = '-';

const typeName = (id: number) => TYPE_NAMES[id] ?? `(type ${id})`;

/** Whether two names are the same once normalised (`normaliseName`); null (none) equals only null. */
function sameName(a: string | null, b: string | null): boolean {
  return a === null || b === null ? a === b : normaliseName(a) === normaliseName(b);
}

/** Collects one key's diffs. `exact` compares values with `===`; `named` compares names with `sameName`. */
function differ(area: Diff['area'], key: string) {
  const diffs: Diff[] = [];
  const add = (field: string, rom: unknown, docs: unknown) => {
    diffs.push({ area, key, field, rom, docs });
  };
  return {
    diffs,
    add,
    exact(field: string, rom: unknown, docs: unknown) {
      if (rom !== docs) add(field, rom, docs);
    },
    named(field: string, rom: string | null, docs: string | null) {
      if (!sameName(rom, docs)) add(field, rom, docs);
    },
  };
}

/** Each Personal row against the ROM species of its ID: base stats, types, abilities and growth rate. */
export function diffSpecies(rom: Pick<RomData, 'species'>, docs: Pick<KaizoDocs, 'species'>, names: NameIndex): Diff[] {
  return docs.species.flatMap((row) => {
    const d = differ('species', names.species(row.id));
    const record = rom.species[row.id];
    if (record === undefined) {
      d.add('record', null, row.name);
      return d.diffs;
    }
    for (const stat of STATS) d.exact(stat, record.baseStats[stat], row.baseStats[stat]);
    record.types.forEach((type, i) => d.exact(`type${i + 1}`, typeName(type), row.types[i]));
    record.abilities.forEach((ability, i) => d.named(`ability${i + 1}`, ability === 0 ? NO_ABILITY : names.ability(ability), row.abilities[i]!));
    d.exact('growthRate', GROWTH_RATE_NAMES[record.growthRate] ?? `(rate ${record.growthRate})`, row.growthRate);
    return d.diffs;
  });
}

/**
 * Each species' docs learnset against the ROM's, as one diff holding both lists ("L7 Mud-Slap") when any level or move
 * differs. Docs move names are matched by `names.moveId`, so the learnset tab's spellings ("Mud Slap") still match.
 */
export function diffLearnsets(rom: Pick<RomData, 'learnsets'>, docs: Pick<KaizoDocs, 'learnsets'>, names: NameIndex): Diff[] {
  return [...docs.learnsets].flatMap(([id, docsMoves]): Diff[] => {
    const romMoves = rom.learnsets[id] ?? [];
    const same = romMoves.length === docsMoves.length
      && romMoves.every((learnt, i) => learnt.level === docsMoves[i]!.level && learnt.move === names.moveId(docsMoves[i]!.move));
    if (same) return [];
    return [{
      area: 'learnset', key: names.species(id), field: 'moves',
      rom: romMoves.map((learnt) => `L${learnt.level} ${names.move(learnt.move)}`),
      docs: docsMoves.map((learnt) => `L${learnt.level} ${learnt.move}`),
    }];
  });
}

/**
 * Each Moves row against the ROM move of its ID: power, type, accuracy, PP, priority, category and effect chance. The
 * effect is left out: the docs warn that the game file shows some effects wrongly on purpose.
 */
export function diffMoves(rom: Pick<RomData, 'moves'>, docs: Pick<KaizoDocs, 'moves'>, names: NameIndex): Diff[] {
  return docs.moves.flatMap((row) => {
    const d = differ('move', names.move(row.id));
    const record = rom.moves[row.id];
    if (record === undefined) {
      d.add('record', null, row.name);
      return d.diffs;
    }
    d.exact('power', record.power, row.power);
    d.exact('type', typeName(record.type), row.type);
    d.exact('accuracy', record.accuracy, row.accuracy);
    d.exact('pp', record.pp, row.pp);
    d.exact('priority', record.priority, row.priority);
    d.exact('category', record.category, row.category);
    d.exact('effectChance', record.effectChance, row.effectChance);
    return d.diffs;
  });
}

/**
 * Each Pokémon of each matched trainer (`matchTrainers(...).matched`, shared and level-mismatch matches included)
 * against its docs Pokémon in the same slot: level, species and form as one name, ability, item and moves.
 * Moves are matched by ID (`names.moveId`); the same moves in another order are reported as `move-order`, not `moves`.
 * Nature is compared only where the ROM nature is known (`natureKnown`), under `nature-cross-check`, against the docs
 * cell as written (a rival's "X/Y" read by `docsNature`), so the cells that cleaning fixes still show. An ability chosen by
 * the PID's lowest bit where the nature is unknown goes under `ability-cross-check`, since that PID is untrusted too.
 * The ROM side is what the planner uses in both.
 * Keys read "Byron Split: Worker Conrad [ROM 307] mon 3 (Rotom)", the species as the docs write it.
 */
export function diffTrainers(rom: Pick<RomData, 'species' | 'trainers'>, docs: Pick<KaizoDocs, 'trainers'>, names: NameIndex): Diff[] {
  const byIndex = new Map(rom.trainers.map((trainer) => [trainer.index, trainer]));
  return matchTrainers(rom.trainers, docs.trainers, names).matched.flatMap(({ romIndex, doc }) => {
    const trainer = byIndex.get(romIndex)!;
    const femaleClass = FEMALE_TRAINER_CLASSES.has(trainer.trainerClass);
    // A match has the docs trainer's party size, and every docs species name resolves.
    return trainer.party.flatMap((mon, slot) => {
      const docMon = doc.party[slot]!;
      const docsSpecies = names.speciesId(docMon.species)!;
      const d = differ('trainer', `${doc.split}: ${doc.name} [ROM ${romIndex}] mon ${slot + 1} (${docMon.species})`);
      d.exact('level', mon.level, docMon.level);
      d.exact('species', names.species(mon.species, mon.form), names.species(docsSpecies.id, docsSpecies.form));
      const ability = abilityOf(rom.species, mon);
      // A PID-chosen ability is as untrusted as the PID's nature where that is unknown.
      d.named(ability.byPid && !mon.natureKnown ? 'ability-cross-check' : 'ability', names.ability(ability.id), docMon.ability);
      d.named('item', mon.item === 0 ? null : names.item(mon.item), docMon.item);
      // A docs name that resolves to no move is null, which equals no ID.
      const docsMoves = docMon.moves.map((name) => names.moveId(name));
      const listed = (moves: (number | null)[]) => JSON.stringify(moves);
      if (listed(docsMoves) !== listed(mon.moves)) {
        const sameSet = listed([...docsMoves].sort()) === listed([...mon.moves].sort());
        d.add(sameSet ? 'move-order' : 'moves', mon.moves.map((id) => names.move(id)), docMon.moves);
      }
      const romNature = NATURES[mon.nature]!;
      if (mon.natureKnown && !sameName(romNature, docsNature(docMon.nature, femaleClass))) d.add('nature-cross-check', romNature, docMon.nature);
      return d.diffs;
    });
  });
}

/**
 * The diffs keyed `area/key/field`, as `test/real/accepted-diffs.json` holds them, the other side named by `otherSide`.
 * Throws if two share a key.
 */
export function diffsByKey(diffs: Diff[]): Record<string, KeyedDiff> {
  const keyed: Record<string, KeyedDiff> = {};
  for (const { area, key, field, rom, docs } of diffs) {
    const id = `${area}/${key}/${field}`;
    if (Object.hasOwn(keyed, id)) throw new Error(`Two diffs have the key ${id}`);
    keyed[id] = { rom, [otherSide(area)]: docs };
  }
  return keyed;
}

const AREAS: readonly DiffArea[] = ['species', 'learnset', 'move', 'trainer', ...PKCALC_AREAS];

/**
 * The diffs back from `diffsByKey`'s form. The area runs to the first `/` and the field from the last, neither holding
 * one, so a key may (as in "Trainer Dawn/Lucas"). Throws for a key in no known area.
 */
export function diffsFromKeyed(keyed: Record<string, KeyedDiff>): Diff[] {
  return Object.entries(keyed).map(([id, value]) => {
    const area = AREAS.find((candidate) => id.startsWith(`${candidate}/`));
    const fieldAt = id.lastIndexOf('/');
    if (area === undefined || fieldAt <= area.length) throw new Error(`Not an area/key/field key: ${id}`);
    return { area, key: id.slice(area.length + 1, fieldAt), field: id.slice(fieldAt + 1), rom: value.rom, docs: value[otherSide(area)] };
  });
}
