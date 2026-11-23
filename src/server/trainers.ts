// The trainer route's JSON (`GET /api/trainers`, contract in `src/contracts/api.ts`) and the variant index the sheet and
// line routes take: 0 is the trainer as the catalog resolves it (the harder copy), and k ≥ 1 is
// `trainer.variants[k-1]`.

import type { ResolvedTrainer, TrainerCatalog } from '../battle/types.js';
import type { TrainerSummaryJson } from './apiTypes.js';

/**
 * Every opponent in catalog order (game order across the splits). `order` is the trainer's index in `catalog.trainers`;
 * `variants` counts its copies (always ≥ 1).
 */
export function trainerSummaries(catalog: TrainerCatalog): TrainerSummaryJson[] {
  return catalog.trainers.map(summary);
}

/**
 * The opponents `catalog.search` finds for `text`, each with its global `order`. Null, empty or blank text gives every
 * trainer.
 */
export function searchTrainers(catalog: TrainerCatalog, text: string | null): TrainerSummaryJson[] {
  if (text === null || text.trim() === '') return trainerSummaries(catalog);
  const orderById = new Map(catalog.trainers.map((trainer, order) => [trainer.id, order]));
  return catalog.search(text).flatMap((trainer) => {
    const order = orderById.get(trainer.id);
    return order === undefined ? [] : [summary(trainer, order)];
  });
}

/** Copy `variant` of `trainer`: 0 is `trainer` itself, k ≥ 1 is `trainer.variants[k-1]`; null for any other number. */
export function pickVariant(trainer: ResolvedTrainer, variant: number): ResolvedTrainer | null {
  if (!Number.isInteger(variant) || variant < 0) return null;
  if (variant === 0) return trainer;
  return trainer.variants[variant - 1] ?? null;
}

function summary(trainer: ResolvedTrainer, order: number): TrainerSummaryJson {
  return {
    id: trainer.id, name: trainer.name, split: trainer.split, location: trainer.location, order,
    battleType: trainer.battleType, tags: tagsOf(trainer), variants: 1 + trainer.variants.length,
  };
}

/**
 * The trainer's tags (`tags.raw`), then the comma-separated pieces of its field note ("PERMANENT RAIN"): each trimmed,
 * blank ones dropped, and a repeat (ignoring case) dropped in favour of its first spelling.
 */
function tagsOf(trainer: ResolvedTrainer): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const piece of [...trainer.tags.raw, ...(trainer.field?.raw.split(',') ?? [])]) {
    const tag = piece.trim();
    const key = tag.toLowerCase();
    if (tag === '' || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}
