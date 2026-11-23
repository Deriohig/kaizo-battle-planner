// What-if levels for the split bench's plan request (docs/what-if-levels.md): its `levels`, `MonRef → level`
// (src/integration/planRequest.ts), read from a JSON object, checked against the Pokémon it may name (the request's team
// or pool) and their levels in the save, and applied with `atLevel`, the one place the rule lives (`levelledMons`, which
// the real solver uses). No route takes `levels`: the sheet, its AI odds and a line start read a level from the draft
// (`applyDraft`, src/server/draft.ts). This module has no `node:` imports, so the plan request's checks share it.

import { atLevel, MAX_LEVEL, type PlayerMon } from '../battle/playerMon.js';
import type { MonRef } from './apiTypes.js';

/** The levels as given, in order, so a ref listed twice can be told. */
export type LevelEntries = [MonRef, number][];

export type ParsedLevels = { ok: true; entries: LevelEntries } | { ok: false; error: string };

const notWhole = (ref: string, got: unknown) => `levels: the level for ${ref} must be a whole number, not ${JSON.stringify(got)}`;

/** `levels` from a JSON body: an object from ref to level. Absent is none. */
export function levelsFromBody(raw: unknown): ParsedLevels {
  if (raw === undefined) return { ok: true, entries: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'levels must be an object from MonRef to level' };
  const entries: LevelEntries = [];
  for (const [ref, level] of Object.entries(raw)) {
    if (typeof level !== 'number' || !Number.isInteger(level)) return { ok: false, error: notWhole(ref, level) };
    entries.push([ref, level]);
  }
  return { ok: true, entries };
}

/**
 * Why `entries` cannot be used, in a sentence, or null. `scope` is the Pokémon they may name, by ref, with their levels in
 * the save; `noun` is what the scope is called in the message ("team" or "pool"). A level is a whole number from the
 * save's level (its own is fine) to 100.
 */
export function levelsProblem(entries: LevelEntries, scope: ReadonlyMap<MonRef, number>, noun: string): string | null {
  const seen = new Set<MonRef>();
  for (const [ref, level] of entries) {
    if (seen.has(ref)) return `levels lists ${ref} twice`;
    seen.add(ref);
    const saved = scope.get(ref);
    if (saved === undefined) return `levels: ${ref} is not in the ${noun}`;
    if (!Number.isInteger(level) || level < saved || level > MAX_LEVEL) {
      return `levels: ${ref} is level ${saved} in the save, so its level must be a whole number from ${saved} to ${MAX_LEVEL}, not ${level}`;
    }
  }
  return null;
}

/** `mons` with each Pokémon named in `levels` at its level (`atLevel`); the others are the same objects. `mons` is not changed. */
export function levelledMons(mons: ReadonlyMap<MonRef, PlayerMon>, levels: ReadonlyMap<MonRef, number>): Map<MonRef, PlayerMon> {
  return new Map([...mons].map(([ref, mon]) => {
    const level = levels.get(ref);
    return [ref, level === undefined ? mon : atLevel(mon, level)];
  }));
}

/** The levels as the plain object a solve request carries. */
export function levelsRecord(levels: ReadonlyMap<MonRef, number>): Record<MonRef, number> {
  return Object.fromEntries(levels);
}
