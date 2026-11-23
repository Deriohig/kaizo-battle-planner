// Pairs each docs trainer with its ROM trainers by party: the species, form and level of each Pokémon, in order, with
// held items and moves breaking ties.

import type { DocTrainer } from '../docs/teams.js';
import type { RomTrainer, TrainerMon } from '../rom/trainers.js';
import type { NameIndex } from './nameIndex.js';
import { normaliseName } from './normalise.js';

/**
 * A docs trainer and a ROM trainer it stands for.
 * - `shared`: a further ROM trainer with the docs trainer's exact party, such as the rival's copy for the other player
 *   gender.
 * - `levelMismatch`: matched on species and forms alone, because the docs' levels differ. The ROM's levels are the
 *   ones the game uses.
 */
export interface TrainerMatch { romIndex: number; doc: DocTrainer; shared?: true; levelMismatch?: true }

/**
 * `matched` and `docsOnly` are in docs order, with a docs trainer's shared matches after its own; `romOnly` holds the
 * unmatched ROM indexes in ascending order.
 */
export interface MatchReport { matched: TrainerMatch[]; romOnly: number[]; docsOnly: DocTrainer[] }

/** One docs Pokémon of a party key. `form` is null for a bare species name ("Shellos"), which fits any form. */
interface Slot { species: number; form: number | null; level: number }

/** A docs trainer's party key, or null when a species name does not resolve. */
function docsKey(trainer: DocTrainer, names: NameIndex): Slot[] | null {
  const slots: Slot[] = [];
  for (const mon of trainer.party) {
    const species = names.speciesId(mon.species);
    if (species === null) return null;
    const bare = normaliseName(mon.species) === normaliseName(names.species(species.id));
    slots.push({ species: species.id, form: bare ? null : species.form, level: mon.level });
  }
  return slots;
}

/**
 * Whether a ROM party fits a docs key: the same species in each slot, the same form unless the docs name is bare, and
 * the same level if `levels`.
 */
function fits(key: Slot[], party: TrainerMon[], levels: boolean): boolean {
  return key.length === party.length && key.every((slot, i) => {
    const mon = party[i]!;
    return mon.species === slot.species && (slot.form === null || mon.form === slot.form) && (!levels || mon.level === slot.level);
  });
}

const speciesList = (species: number[]) => species.join(' ');

/**
 * How many of a ROM party's held items and move sets, slot by slot, are the docs trainer's. It breaks ties between ROM
 * trainers that fit one docs trainer equally, such as the Galactic Split's three SwimmerF Wang fights, which share
 * species and levels.
 */
function agreement(doc: DocTrainer, party: TrainerMon[], names: NameIndex): number {
  return party.reduce((count, mon, i) => {
    const docMon = doc.party[i]!;
    const sameItem = (mon.item === 0 ? null : normaliseName(names.item(mon.item))) === (docMon.item === null ? null : normaliseName(docMon.item));
    const sameMoves = mon.moves.length === docMon.moves.length && mon.moves.every((move, k) => names.moveId(docMon.moves[k]!) === move);
    return count + Number(sameItem) + Number(sameMoves);
  }, 0);
}

/**
 * Matches docs trainers to ROM trainers by party, in three steps:
 * 1. Exact, one to one: the same species, form and level in each slot (a bare species name fits any form).
 * 2. Shared: each ROM trainer still free whose party fits a docs trainer exactly goes to that docs trainer
 *    too, or to the last such docs trainer in docs order; it is marked `shared`. Any docs trainer it fits was matched
 *    in step 1, since it was free then.
 * 3. Levels, one to one: the docs trainers still unmatched, on species and form alone; marked `levelMismatch`.
 *
 * In steps 1 and 3 each docs trainer takes, of the ROM trainers that fit and are still free, the one whose items and
 * moves agree with it most (`agreement`), the lowest index among equals. Docs trainers take theirs in docs order,
 * except that those whose names all carry their forms go first, so a bare name never takes the ROM trainer a named
 * form needs. Exact matches are all made before level ones. A docs trainer with an unresolved species name or no
 * ROM trainer left is docs-only; ROM trainers never matched (rematches, unused entries) are ROM-only. Never throws.
 */
export function matchTrainers(rom: RomTrainer[], docs: DocTrainer[], names: NameIndex): MatchReport {
  // The ROM trainers a docs key can fit are those with its species list; each list is in index order.
  const sorted = [...rom].sort((a, b) => a.index - b.index);
  const bySpecies = new Map<string, RomTrainer[]>();
  for (const trainer of sorted) {
    const list = speciesList(trainer.party.map((mon) => mon.species));
    const trainers = bySpecies.get(list);
    if (trainers) trainers.push(trainer);
    else bySpecies.set(list, [trainer]);
  }

  const keys = docs.map((trainer) => docsKey(trainer, names));
  const taken = new Set<number>();
  const found: { at: number; match: TrainerMatch }[] = [];
  const matchedDocs = new Set<number>();
  const take = (at: number, trainer: RomTrainer, flags: Pick<TrainerMatch, 'shared' | 'levelMismatch'> = {}) => {
    taken.add(trainer.index);
    matchedDocs.add(at);
    found.push({ at, match: { romIndex: trainer.index, doc: docs[at]!, ...flags } });
  };

  const oneToOne = (levels: boolean) => {
    const named = (at: number) => keys[at]!.every((slot) => slot.form !== null);
    const order = keys.flatMap((key, at) => (key && !matchedDocs.has(at) ? [at] : []))
      .sort((a, b) => Number(named(b)) - Number(named(a)) || a - b);
    for (const at of order) {
      const key = keys[at]!;
      const candidates = (bySpecies.get(speciesList(key.map((slot) => slot.species))) ?? [])
        .filter((candidate) => !taken.has(candidate.index) && fits(key, candidate.party, levels));
      // The first (lowest-index) candidate with the most agreement.
      let trainer: RomTrainer | undefined;
      let most = -1;
      for (const candidate of candidates) {
        const score = agreement(docs[at]!, candidate.party, names);
        if (score > most) [trainer, most] = [candidate, score];
      }
      if (trainer) take(at, trainer, levels ? {} : { levelMismatch: true });
    }
  };

  oneToOne(true);
  for (const trainer of sorted.filter((candidate) => !taken.has(candidate.index))) {
    const at = keys.findLastIndex((key) => key !== null && fits(key, trainer.party, true));
    if (at >= 0) take(at, trainer, { shared: true });
  }
  oneToOne(false);

  return {
    matched: found.sort((a, b) => a.at - b.at || a.match.romIndex - b.match.romIndex).map(({ match }) => match),
    romOnly: sorted.filter((trainer) => !taken.has(trainer.index)).map((trainer) => trainer.index),
    docsOnly: docs.filter((_, at) => !matchedDocs.has(at)),
  };
}
