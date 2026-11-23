// Where the run is, as the page keeps it: the cursor (the trainer the player last opened, and its split) per save in
// `localStorage`, which split's fights the page shows, the fight it opens (the save's next fight first), the fights beaten,
// the next one, and how search results are ranked. Every read and write is
// wrapped: the storage can be missing or refuse (a private window), and the page then works without it.

import { normaliseName } from '../../src/names/normalise';
import type { RunJson, TrainerSummaryJson } from '../../src/server/apiTypes';

/** The trainer last opened for a save, and the split it was opened in. */
export interface Cursor { split: string; trainerId: string }

/** The cursors, `{ [savePath]: Cursor }`. */
export const CURSOR_KEY = 'pkp.run.cursor';

/** What the old Fight view kept and 7b no longer reads: the what-if levels and the gauntlets. */
export const OLD_KEYS = ['pkp.whatIfLevels', 'plat-kaizo-planner:gauntlets'];

/** Where 7b to 7d kept lines, one key per trainer copy; 7e keeps trees under `pkp.tree.*` (line.ts) and never reads these. */
export const OLD_PREFIXES = ['pkp.line.current.', 'pkp.line.saved.'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCursor = (value: unknown): value is Cursor => isRecord(value) && typeof value.split === 'string' && typeof value.trainerId === 'string';

/** Every save's cursor as kept; an empty map when none is kept, what is kept is not a map, or there is no storage. */
function readCursors(): Record<string, unknown> {
  try {
    const text = localStorage.getItem(CURSOR_KEY);
    const value = text === null ? null : (JSON.parse(text) as unknown);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

/** The cursor kept for a save; null when none is kept, what is kept is not a cursor, or there is no storage. */
export function readCursor(savePath: string): Cursor | null {
  const cursors = readCursors();
  const value = Object.hasOwn(cursors, savePath) ? cursors[savePath] : undefined;
  return isCursor(value) ? { split: value.split, trainerId: value.trainerId } : null;
}

/** Keeps a save's cursor beside the other saves'. Without storage it just is not kept. */
export function writeCursor(savePath: string, cursor: Cursor): void {
  try {
    const cursors = readCursors();
    cursors[savePath] = { split: cursor.split, trainerId: cursor.trainerId };
    localStorage.setItem(CURSOR_KEY, JSON.stringify(cursors));
  } catch {
    // The storage is unavailable: the cursor just is not kept.
  }
}

/** The split whose fights the page shows: the cursor's when the save could be there (`run.split` or `run.alsoPossible`), else the save's. */
export function shownSplit(run: RunJson, cursor: Cursor | null): string {
  if (cursor !== null && (cursor.split === run.split || run.alsoPossible.includes(cursor.split))) return cursor.split;
  return run.split;
}

/** A split's trainers in game order. */
export function splitFights(trainers: readonly TrainerSummaryJson[], split: string): TrainerSummaryJson[] {
  return trainers.filter((t) => t.split === split).sort((a, b) => a.order - b.order);
}

/**
 * The fight the page opens: `next` (the save's next fight) when it is one of `fights`, else the cursor's trainer when it
 * is one of `fights`, else the first single battle, else the first; null for none. Left out or null, `next` changes nothing.
 */
export function openFight(fights: readonly TrainerSummaryJson[], cursor: Cursor | null, next?: string | null): TrainerSummaryJson | null {
  const saved = next === undefined || next === null ? undefined : fights.find((t) => t.id === next);
  const kept = cursor === null ? undefined : fights.find((t) => t.id === cursor.trainerId);
  return saved ?? kept ?? fights.find((t) => t.battleType === 'single') ?? fights[0] ?? null;
}

/** The ids of the fights the save has beaten in `split`: the run's fights with `defeated` set when `split` is the run's split, else none. */
export function beatenIds(run: RunJson, split: string): string[] {
  return split === run.split ? run.fights.filter((f) => f.defeated).map((f) => f.id) : [];
}

/** The words of search text, each normalised, none empty. */
const searchWords = (text: string): string[] => text.split(/\s+/).map(normaliseName).filter(Boolean);

function tierOf(trainer: TrainerSummaryJson, words: readonly string[]): 0 | 1 | 2 {
  if (words.length === 0) return 2;
  const name = normaliseName(trainer.name);
  if (words.every((w) => name.includes(w))) return 0;
  const place = normaliseName(trainer.location);
  return words.every((w) => name.includes(w) || place.includes(w)) ? 1 : 2;
}

/**
 * How well a trainer matches the search text, as the server matches it (`normaliseName` on each word): 0 when every word is in
 * its name, 1 when every word is in its name or its location, else 2 (it matched by its split). No words gives 2.
 */
export function searchTier(trainer: TrainerSummaryJson, text: string): 0 | 1 | 2 {
  return tierOf(trainer, searchWords(text));
}

/** The found trainers ordered by `searchTier`, then game order; a new array. */
export function rankFound(trainers: readonly TrainerSummaryJson[], text: string): TrainerSummaryJson[] {
  const words = searchWords(text);
  return trainers
    .map((t) => ({ t, tier: tierOf(t, words) }))
    .sort((a, b) => a.tier - b.tier || a.t.order - b.t.order)
    .map((x) => x.t);
}

/** The first single battle after `openId` in `fights` (from the start when `openId` is null or not there); null when none follows. */
export function nextFight(fights: readonly TrainerSummaryJson[], openId: string | null): TrainerSummaryJson | null {
  const at = openId === null ? -1 : fights.findIndex((t) => t.id === openId);
  return fights.slice(at + 1).find((t) => t.battleType === 'single') ?? null;
}

/** Who is offered as the next fight after a win: the one picked at first (null for none), and the ones to pick from, by split. */
export interface NextChoices { next: TrainerSummaryJson | null; groups: { split: string; fights: TrainerSummaryJson[] }[] }

/**
 * Who is offered as the next fight after a win over `from`. `groups`: the other single battles of `from`'s split in game
 * order, then those of the split after it in `splits` (the run's; none when `from`'s split is the last or not listed), each
 * under its split's name, an empty one left out. `next`: the first single battle after `from` in its split (`nextFight`),
 * else the first of the split after, else none. Doubles are never offered, and neither is `from`.
 */
export function nextChoices(trainers: readonly TrainerSummaryJson[], splits: readonly string[], from: TrainerSummaryJson): NextChoices {
  const singles = (split: string) => splitFights(trainers, split).filter((t) => t.battleType === 'single');
  const at = splits.indexOf(from.split);
  const following = at < 0 ? undefined : splits[at + 1];
  const own = { split: from.split, fights: singles(from.split).filter((t) => t.id !== from.id) };
  const after = following === undefined ? null : { split: following, fights: singles(following) };
  return {
    next: nextFight(splitFights(trainers, from.split), from.id) ?? after?.fights[0] ?? null,
    groups: [own, ...(after === null ? [] : [after])].filter((g) => g.fights.length > 0),
  };
}

/**
 * Removes what the old Fight view kept (`OLD_KEYS`) and every line 7b to 7d kept (each key starting with one of
 * `OLD_PREFIXES`). Without storage there is nothing to remove.
 */
export function removeOldKeys(): void {
  try {
    const old: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null && (OLD_KEYS.includes(key) || OLD_PREFIXES.some((prefix) => key.startsWith(prefix)))) old.push(key);
    }
    for (const key of old) localStorage.removeItem(key);
  } catch {
    // The storage is unavailable: nothing is kept there.
  }
}
