// The trainer catalog: every docs trainer that matched the ROM, resolved, plus the docs' preset gauntlets.

import { joinPkcalc, pkcalcNatures } from '../check/pkcalc.js';
import { type DocTrainer, groupGauntlets } from '../docs/teams.js';
import { matchTrainers, type TrainerMatch } from '../names/matchTrainers.js';
import { normaliseName } from '../names/normalise.js';
import { resolveTrainer, slug, trainerId } from './resolveTrainer.js';
import type { CatalogGauntlet, LoadedData, ResolvedTrainer, TrainerCatalog } from './types.js';

/**
 * The docs' preset gauntlets (`groupGauntlets`), in docs order. A gauntlet's ID is its split and location as slugs and
 * its place (from 1) among that location's gauntlets: "roark-split/oreburgh-mine/gauntlet-1". Its name gives the
 * location and its first and last trainers. Its trainer IDs may include a docs trainer with no ROM match.
 */
function gauntlets(docs: DocTrainer[]): CatalogGauntlet[] {
  const seen = new Map<string, number>();
  return groupGauntlets(docs).map((gauntlet) => {
    const place = `${slug(gauntlet.split)}/${slug(gauntlet.location)}`;
    const count = (seen.get(place) ?? 0) + 1;
    seen.set(place, count);
    const first = gauntlet.trainers[0]!;
    const last = gauntlet.trainers.at(-1)!;
    return {
      id: `${place}/gauntlet-${count}`,
      name: `${gauntlet.location}: ${first.name} to ${last.name}`,
      trainerIds: gauntlet.trainers.map((trainer) => trainerId(trainer, docs)),
    };
  });
}

/**
 * Matches the docs trainers to the ROM's (`matchTrainers`) and resolves each matched docs trainer once, with its
 * shared ROM copies as variants (`resolveTrainer`), as `TrainerCatalog` describes. Where `data` holds PKCalc's saved
 * data, the matched trainers are joined to PKCalc's (`joinPkcalc`), and PKCalc's natures (`pkcalcNatures`) become the
 * alternatives to the docs' natures; without it, the docs' natures are still disputed, each with every
 * other nature as an alternative. `natureAlternatives(data)` (src/data/load.ts) names the mode.
 */
export function buildCatalog(data: LoadedData): TrainerCatalog {
  const matched = matchTrainers(data.rom.trainers, data.docs.trainers, data.names).matched;
  const matches = new Map<DocTrainer, TrainerMatch[]>();
  for (const match of matched) matches.set(match.doc, [...(matches.get(match.doc) ?? []), match]);
  const natures = data.pkcalc && pkcalcNatures(joinPkcalc(matched, data.rom.trainers, data.pkcalc), data.rom.trainers, data.pkcalc);
  const resolved = data.docs.trainers.flatMap((doc) => {
    const own = matches.get(doc);
    if (own === undefined) return [];
    const primary = own.find((match) => !match.shared) ?? own[0]!;
    return [resolveTrainer(primary, own.filter((match) => match !== primary), data, natures)];
  });
  const byId = new Map(resolved.map((trainer) => [trainer.id, trainer]));
  const trainers = resolved.filter((trainer) => !trainer.tags.playerPartner);
  const haystacks = new Map(trainers.map((trainer) => [trainer, [trainer.name, trainer.split, trainer.location].map(normaliseName)]));

  return {
    trainers,
    gauntlets: gauntlets(data.docs.trainers),
    byId: (id) => byId.get(id),
    search(text) {
      const exact = trainers.filter((trainer) => trainer.id === text.trim());
      if (exact.length > 0) return exact;
      const words = text.split(/\s+/).map(normaliseName).filter(Boolean);
      if (words.length === 0) return [];
      return trainers.filter((trainer: ResolvedTrainer) => words.every((word) => haystacks.get(trainer)!.some((field) => field.includes(word))));
    },
  };
}
