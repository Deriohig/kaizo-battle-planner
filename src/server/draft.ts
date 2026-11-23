// The draft team (`DraftMonJson`): the player's edits to one Pokémon for planning, never written to the save. The page
// sends each edit as an override of the save's value; `parseDraft` reads them from JSON and `applyDraft` checks them with
// the save reader's rules and makes the Pokémon the planner fights with. `draftItems` is the items a draft may hold
// (`GET /api/draft/options`). The rules themselves are `draftProblem` (./draftRules.ts), which the page shares;
// `factsOfMon` is what the server feeds them. Pure: no Node imports.

import { atLevel, type PlayerMon } from '../battle/playerMon.js';
import type { LocalData } from '../data/load.js';
import { personalRowFor } from '../rom/forms.js';
import type { Stats } from '../rom/types.js';
import type { StartStatus } from '../save/status.js';
import type { MonRef } from './apiTypes.js';
import { type DraftFacts, draftProblem, isRecord, movesFrom, sameStats, startHp, statsFrom } from './draftRules.js';
import { statusFromJson } from './json.js';

/** A draft the planner cannot use: a bad shape or a value the save reader's rules refuse. The message says why. */
export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftError';
  }
}

/** One Pokémon of the draft team, as `parseDraft` reads `DraftMonJson`: only `ref` is required, and a field left out is the save's value. */
export interface DraftMon {
  ref: MonRef; level?: number; exp?: number; hp?: number; status?: StartStatus; item?: number;
  moves?: { id: number; pp?: number }[]; ivs?: Stats; evs?: Stats; nature?: number;
}

/**
 * The hack's held items that the name index cannot name (it keeps @pkmn/dex's battle items only), by ROM id: the Lava
 * Cookie and Old Gateau, which the hack gives Lum Berry's hold effect, the Shoal Salt and the Shoal Shell. The engine
 * models them under these names (src/engine/ids.ts `HACK_ITEM_NAMES`).
 */
export const HACK_HELD_ITEMS: ReadonlyMap<number, string> = new Map([[42, 'Lava Cookie'], [54, 'Old Gateau'], [70, 'Shoal Salt'], [71, 'Shoal Shell']]);

/**
 * The held items the engine's EXP routine reads by ROM id that the name index cannot name (@pkmn/dex has no battle item
 * for them): the Exp. Share and the Lucky Egg (src/engine/exp.ts:169-171, `ITEM_EXP_SHARE` and `ITEM_LUCKY_EGG`). The EXP
 * a knockout pays depends on them, so a draft may hold them.
 */
export const EXP_HELD_ITEMS: ReadonlyMap<number, string> = new Map([[216, 'Exp. Share'], [231, 'Lucky Egg']]);

/**
 * The items a Pokémon may hold in a draft, sorted by name: every ROM item id from 1 that the name index names (an unnamed
 * one reads "(item <id>)"), plus `HACK_HELD_ITEMS` and `EXP_HELD_ITEMS`, each id once (one of those under its list's name).
 */
export function draftItems(data: LocalData): { id: number; name: string }[] {
  const names = new Map<number, string>();
  for (let id = 1; id < data.rom.items.length; id++) {
    const name = data.names.item(id);
    if (!name.startsWith('(')) names.set(id, name);
  }
  for (const [id, name] of [...HACK_HELD_ITEMS, ...EXP_HELD_ITEMS]) names.set(id, name);
  return [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id - b.id);
}

const DRAFT_FIELDS = new Set(['ref', 'level', 'exp', 'hp', 'status', 'item', 'moves', 'ivs', 'evs', 'nature']);
const NUMBER_FIELDS = ['level', 'exp', 'hp', 'item', 'nature'] as const;
const STATUS_CHOICES = 'none, sleep:1 to sleep:7, poison, toxic, burn, freeze or paralysis';

/**
 * Reads the draft from JSON: an array of `DraftMonJson`, each `ref` one of `team` and none twice. Shape and types only:
 * each field has its JSON type (numbers; `status` a status string, `'none'` included, read with `statusFromJson`; `moves` an
 * array of `{ id, pp? }`; `ivs` and `evs` objects of the six stats), and no other field. `applyDraft` checks the values.
 * Fields left out stay out. Throws `DraftError` naming the entry and the field.
 */
export function parseDraft(raw: unknown, team: readonly MonRef[]): DraftMon[] {
  if (!Array.isArray(raw)) throw new DraftError('draft must be an array');
  const seen = new Set<string>();
  return raw.map((entry: unknown, i) => {
    if (!isRecord(entry) || typeof entry.ref !== 'string') throw new DraftError(`draft entry ${i + 1} must be an object with a ref`);
    const { ref } = entry;
    if (!team.includes(ref)) throw new DraftError(`draft: ${ref} is not in the team`);
    if (seen.has(ref)) throw new DraftError(`draft lists ${ref} twice`);
    seen.add(ref);
    const fail = (message: string): never => { throw new DraftError(`draft: ${ref} ${message}`); };
    const unknown = Object.keys(entry).find((key) => !DRAFT_FIELDS.has(key));
    if (unknown !== undefined) fail(`has an unknown field ${JSON.stringify(unknown)}`);

    const out: DraftMon = { ref };
    for (const field of NUMBER_FIELDS) {
      const value = entry[field];
      if (value === undefined) continue;
      if (typeof value !== 'number') fail(`${field} must be a number`);
      out[field] = value as number;
    }
    if (entry.status !== undefined) {
      const status = entry.status === 'none' ? { kind: 'none' as const } : typeof entry.status === 'string' ? statusFromJson(entry.status) : null;
      if (status === null) fail(`status must be ${STATUS_CHOICES}, not ${JSON.stringify(entry.status)}`);
      out.status = status!;
    }
    if (entry.moves !== undefined) out.moves = movesFrom(entry.moves) ?? fail('moves must be an array of { id, pp? }');
    for (const field of ['ivs', 'evs'] as const) {
      if (entry[field] !== undefined) out[field] = statsFrom(entry[field]) ?? fail(`${field} must be an object of six numbers`);
    }
    return out;
  });
}

/**
 * What the draft's rules (`draftProblem`) need of `mon`, the save's Pokémon: its level, EXP (the level's own total if it
 * has none), current HP, IVs, EVs, nature (0 when unknown), base stats and item; its moves with their PP and max PP,
 * floor(base × (5 + PP Ups) / 5) (0 without a ROM record); its form's level-up moves with their base PP (0 without a ROM
 * record); each move `known` when the ROM has it and the docs name it; its species' growth table (`growthTable`); and
 * the ids of `draftItems(data)`.
 */
export function factsOfMon(mon: PlayerMon, data: LocalData): DraftFacts {
  const known = (id: number) => data.rom.moves[id]?.pp !== undefined && namesMove(data, id);
  const growth = growthTable(mon, data);
  return {
    level: mon.level, exp: mon.exp ?? growth[mon.level]!, hp: mon.currentHp,
    ivs: pickStats(mon.ivs), evs: pickStats(mon.evs), nature: mon.nature.value ?? 0, baseStats: pickStats(mon.baseStats),
    item: mon.item,
    moves: mon.moves.map((id, k) => {
      const base = data.rom.moves[id]?.pp;
      return { id, pp: mon.pp[k] ?? 0, maxPp: base === undefined ? 0 : Math.floor((base * (5 + (mon.ppUps[k] ?? 0))) / 5), known: known(id) };
    }),
    learnset: (data.rom.learnsets[personalRowFor(mon.species, mon.form)] ?? []).map((entry) => (
      { level: entry.level, id: entry.move, pp: data.rom.moves[entry.move]?.pp ?? 0, known: known(entry.move) }
    )),
    growth,
    items: new Set(draftItems(data).map((held) => held.id)),
  };
}

/**
 * `mon` (the save's Pokémon, from the box's pool) with `draft` applied: a new object, `mon` untouched. The rules are
 * `draftProblem`'s on `factsOfMon(mon, data)`, checked in this order, each refusal a `DraftError` "draft: <ref> …":
 * 1. `ivs` six whole numbers 0–31; `evs` six whole numbers 0–255, 510 in all at most; `nature` whole 0–24.
 * 2. `level` whole 1–100. A changed level goes through `atLevel`.
 * 3. `exp` whole, with `growth[level] <= exp < growth[level + 1]` (at 100, `exp >= growth[100]`) on the species' own growth
 *    row, as the engine reads it (the form's row only if the ROM lacks the species', as the box's `BoxDraftJson.growthRate`).
 *    Left out: the save's when the level is unchanged, else that level's own total.
 * 4. `moves` 1 to 4, none twice, each one of the save's moves or a level-up move of its form's learnset at a level up to
 *    the draft level, and one the data knows (a ROM record and a docs name). A save move keeps its PP Ups and, without
 *    `pp`, its save PP; a new one has 0 PP Ups and its base PP. A given `pp` is whole, 0 to floor(base × (5 + ups) / 5).
 * 5. `item` 0, the save's own item, or an id in `draftItems(data)`.
 * 6. `status` replaces the save's (`{ kind: 'none' }` clears it).
 * 7. HP last, on the max HP of the final level, IVs, EVs and nature: a given `hp` is whole, 1 to that max. Left out: the
 *    save's lost HP (its max HP minus its current HP) is kept, at least 1 and never over the max (`startHp`).
 * The note about stored stats (`notes`) is the save's stats', so it goes when the level, IVs, EVs or nature change.
 */
export function applyDraft(mon: PlayerMon, draft: DraftMon, data: LocalData): PlayerMon {
  const facts = factsOfMon(mon, data);
  const problem = draftProblem(facts, draft);
  if (problem !== null) throw new DraftError(`draft: ${draft.ref} ${problem}`);

  const level = draft.level ?? mon.level;
  // At its own level `atLevel` is an equal copy; its current HP is replaced below.
  const out = atLevel(mon, level);
  if (draft.ivs !== undefined) out.ivs = pickStats(draft.ivs);
  if (draft.evs !== undefined) out.evs = pickStats(draft.evs);
  if (draft.nature !== undefined) out.nature = { ...out.nature, value: draft.nature };
  if (!sameStats(out.ivs, mon.ivs) || !sameStats(out.evs, mon.evs) || out.nature.value !== mon.nature.value) out.notes = [];

  if (draft.exp !== undefined || level !== mon.level) out.exp = draft.exp ?? facts.growth![level]!;

  if (draft.moves !== undefined) {
    const kept = draft.moves.map(({ id }) => mon.moves.indexOf(id));
    out.moves = draft.moves.map(({ id }) => id);
    out.ppUps = kept.map((k) => (k < 0 ? 0 : mon.ppUps[k] ?? 0));
    // A new move comes in full: 0 PP Ups, so its base PP.
    out.pp = draft.moves.map(({ id, pp }, i) => pp ?? (kept[i]! < 0 ? data.rom.moves[id]!.pp : mon.pp[kept[i]!] ?? 0));
  }

  if (draft.item !== undefined) out.item = draft.item;

  if (draft.status !== undefined) out.status = { ...draft.status };

  out.currentHp = startHp(facts, draft);
  return out;
}

/** The six stats of `stats`, copied. */
function pickStats(stats: Stats): Stats {
  return { hp: stats.hp, atk: stats.atk, def: stats.def, spa: stats.spa, spd: stats.spd, spe: stats.spe };
}

/** Whether the docs name move `id` (the name index throws for one they lack). */
function namesMove(data: LocalData, id: number): boolean {
  try {
    data.names.move(id);
    return true;
  } catch {
    return false;
  }
}

/** The EXP table of `mon`'s species' own growth rate (its form's row only if the ROM lacks the species' row). */
function growthTable(mon: PlayerMon, data: LocalData): number[] {
  const record = data.rom.species[mon.species] ?? data.rom.species[personalRowFor(mon.species, mon.form)];
  const table = record === undefined ? undefined : data.rom.growth[record.growthRate];
  if (table === undefined) throw new Error(`The ROM has no growth table for species ${mon.species}`);
  return table;
}
