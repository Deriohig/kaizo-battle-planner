// The draft's rules: what `applyDraft` (src/server/draft.ts) refuses in a draft entry, as one pure function the
// page shares, so the page never starts a fight with a draft the server would refuse. The rules see one Pokémon through
// `DraftFacts`: the server builds them from the save (`factsOfMon`), the page from the box. The shape checks at the end
// (`movesFrom`, `statsFrom`) are shared the same way: `parseDraft` reads a request with them, the page its stored team.
// Pure: no Node imports and nothing from src/battle, so the web bundle can import it.

import { computeStats } from '../rom/stats.js';
import type { Stats } from '../rom/types.js';
import type { DraftMonJson } from './apiTypes.js';

export const MAX_LEVEL = 100, MAX_IV = 31, MAX_EV = 255, MAX_EV_TOTAL = 510, MAX_NATURE = 24, MAX_MOVES = 4;
export const STAT_KEYS: readonly (keyof Stats)[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

/** What the rules need of one Pokémon as the save has it. */
export interface DraftFacts {
  level: number; exp: number; hp: number;                                    // hp: its current HP
  ivs: Stats; evs: Stats; nature: number; baseStats: Stats;
  item: number;
  moves: { id: number; pp: number; maxPp: number; known: boolean }[];        // the save's; maxPp with its PP Ups
  learnset: { level: number; id: number; pp: number; known: boolean }[];     // its form's level-up moves; pp: base PP; known: a ROM record and a docs name
  growth: readonly number[] | null;                                          // total EXP by level 0–100; null: not loaded (the page only)
  items: ReadonlySet<number> | null;                                         // ids a draft may hold; null: not loaded (the page only)
}

/** One draft entry's edits, without its ref and its status (any status `isDraftStatus` takes is allowed). */
export type DraftEdit = Omit<DraftMonJson, 'ref' | 'status'>;

const isWhole = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
const statsWithin = (stats: Stats, max: number) => STAT_KEYS.every((key) => isWhole(stats[key], 0, max));

/**
 * Why `applyDraft` would refuse `edit` for the Pokémon of `facts`, in its words without the "draft: <ref> " prefix, or
 * null. The rules, checked in this order (the first one broken is the answer):
 * 1. `ivs` six whole numbers 0–31; `evs` six whole numbers 0–255, 510 in all at most; `nature` whole 0–24.
 * 2. `level` whole 1–100.
 * 3. `exp` whole and, with `growth`, `growth[level] <= exp < growth[level + 1]` (at 100, `exp >= growth[100]`).
 * 4. `moves` 1 to 4, none twice, each one of the save's moves or a level-up move at a level up to the draft level, and
 *    one the data knows. A given `pp` is whole, 0 to the max: a save move's `maxPp`, a new one's base PP.
 * 5. `item` 0, the save's own item, or one of `items`; without `items`, any whole number from 0.
 * 6. (The status, which `isDraftStatus` checks.)
 * 7. `hp` whole, 1 to the max HP of the draft's level, IVs, EVs and nature.
 */
export function draftProblem(facts: DraftFacts, edit: DraftEdit): string | null {
  if (edit.ivs !== undefined && !statsWithin(edit.ivs, MAX_IV)) return `ivs must be six whole numbers from 0 to ${MAX_IV}`;
  if (edit.evs !== undefined && (!statsWithin(edit.evs, MAX_EV) || STAT_KEYS.reduce((sum, key) => sum + edit.evs![key], 0) > MAX_EV_TOTAL)) {
    return `evs must be six whole numbers from 0 to ${MAX_EV}, ${MAX_EV_TOTAL} in all at most`;
  }
  if (edit.nature !== undefined && !isWhole(edit.nature, 0, MAX_NATURE)) return `nature must be a whole number from 0 to ${MAX_NATURE}`;

  if (edit.level !== undefined && !isWhole(edit.level, 1, MAX_LEVEL)) return `level must be a whole number from 1 to ${MAX_LEVEL}, not ${edit.level}`;
  const level = edit.level ?? facts.level;

  if (edit.exp !== undefined) {
    if (!Number.isInteger(edit.exp)) return `exp must be a whole number, not ${edit.exp}`;
    if (facts.growth !== null) {
      const from = facts.growth[level]!;
      const below = level < MAX_LEVEL ? facts.growth[level + 1]! : null;
      if (edit.exp < from || (below !== null && edit.exp >= below)) {
        return `exp ${edit.exp} does not fit level ${level} (${below === null ? `${from} or more` : `${from} to ${below - 1}`})`;
      }
    }
  }

  if (edit.moves !== undefined) {
    if (edit.moves.length < 1 || edit.moves.length > MAX_MOVES) return `needs 1 to ${MAX_MOVES} moves`;
    const seen: number[] = [];
    for (const { id, pp } of edit.moves) {
      if (seen.includes(id)) return `lists move ${id} twice`;
      seen.push(id);
      const kept = facts.moves.find((move) => move.id === id);
      const learned = kept === undefined ? facts.learnset.find((entry) => entry.id === id && entry.level <= level) : undefined;
      if (kept === undefined && learned === undefined) return `cannot know move ${id} at level ${level}`;
      const { known, max } = kept === undefined ? { known: learned!.known, max: learned!.pp } : { known: kept.known, max: kept.maxPp };
      if (!known) return `move ${id} is not in the data`;
      if (pp !== undefined && !isWhole(pp, 0, max)) return `move ${id} pp must be a whole number from 0 to ${max}, not ${pp}`;
    }
  }

  if (edit.item !== undefined) {
    const { item } = edit;
    const holdable = facts.items === null ? isWhole(item, 0, Infinity) : item === 0 || item === facts.item || facts.items.has(item);
    if (!holdable) return `item ${item} is not an item a Pokémon can hold here`;
  }

  if (edit.hp !== undefined) {
    const max = maxHpOf(facts, edit);
    if (!isWhole(edit.hp, 1, max)) return `hp must be a whole number from 1 to ${max}, not ${edit.hp}`;
  }
  return null;
}

const DRAFT_STATUS = /^(?:none|sleep:[1-7]|poison|toxic|burn|freeze|paralysis)$/;

/** Whether `status` is a draft entry's status as `parseDraft` takes it: 'none', 'sleep:1' to 'sleep:7', 'poison', 'toxic', 'burn', 'freeze' or 'paralysis'. */
export function isDraftStatus(status: string): boolean {
  return DRAFT_STATUS.test(status);
}

/**
 * The max HP on `edit`'s level, IVs, EVs and nature, each the save's where `edit` leaves it out. It expects an `edit`
 * that `draftProblem` has passed: it does not check the values, so for ones the rules refuse its number means nothing.
 */
export function maxHpOf(facts: DraftFacts, edit: DraftEdit = {}): number {
  return computeStats(facts.baseStats, edit.ivs ?? facts.ivs, edit.evs ?? facts.evs, edit.level ?? facts.level, edit.nature ?? facts.nature).hp;
}

/**
 * The HP the Pokémon starts the fight with: `edit.hp` when given; else the save's lost HP (its max HP minus its current
 * HP) is kept, at least 1 and never over the max. Like `maxHpOf`, it expects an `edit` that `draftProblem` has passed: a
 * given `hp` is returned as it is, unchecked.
 */
export function startHp(facts: DraftFacts, edit: DraftEdit): number {
  if (edit.hp !== undefined) return edit.hp;
  const max = maxHpOf(facts, edit);
  return Math.min(max, Math.max(1, max - (maxHpOf(facts) - facts.hp)));
}

/**
 * The level `exp` gives on `growth` (total EXP by level, 0 to 100): the highest from 1 to 100 whose total is at most
 * `exp`; 1 below level 1's. It assumes the table never decreases (as every growth table does): it walks up from level 1
 * and stops at the first level whose next total is over `exp`.
 */
export function levelOfExp(growth: readonly number[], exp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && growth[level + 1]! <= exp) level++;
  return level;
}

// The draft's shapes, as `parseDraft` reads a draft entry from JSON and the page reads its stored team.

/** Whether `value` is a plain object: not null, not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `{ id, pp? }` objects with numbers and no other field, copied; null for anything else. */
export function movesFrom(raw: unknown): { id: number; pp?: number }[] | null {
  if (!Array.isArray(raw)) return null;
  const moves: { id: number; pp?: number }[] = [];
  for (const move of raw) {
    if (!isRecord(move) || typeof move.id !== 'number' || !(move.pp === undefined || typeof move.pp === 'number')) return null;
    if (Object.keys(move).some((key) => key !== 'id' && key !== 'pp')) return null;
    moves.push(move.pp === undefined ? { id: move.id } : { id: move.id, pp: move.pp });
  }
  return moves;
}

/** An object of exactly the six stats, each a number, copied; null for anything else. */
export function statsFrom(raw: unknown): Stats | null {
  if (!isRecord(raw) || Object.keys(raw).length !== STAT_KEYS.length) return null;
  if (!STAT_KEYS.every((key) => typeof raw[key] === 'number')) return null;
  return Object.fromEntries(STAT_KEYS.map((key) => [key, raw[key]])) as unknown as Stats;
}

/** Whether two sets of stats are equal stat by stat. */
export const sameStats = (a: Stats, b: Stats): boolean => STAT_KEYS.every((key) => a[key] === b[key]);
