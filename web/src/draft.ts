// The stored team: the team the player plans the next fight with, kept in `localStorage` for one save (its path and the time
// it was saved), and the save's own party when none is kept for it. Each member's entry holds only the player's edits, the
// fields that differ from the save (`DraftMonJson`), and each is checked with the server's own rules (`draftRules`), so
// the page never starts a fight with a draft the server would refuse. It is never written to the save file. Every read
// and write is wrapped: the storage can be missing or refuse (a private window), and the page then works without it.
// Below the store are the editor's helpers: an edit (`edited`), all to the level cap, all to full HP, what a row shows,
// the moves on offer and a refusal in words. Without `/api/draft/options` (`Options` null) an EXP and an item are
// checked for shape only, and the server is the backstop for those two. The imports name their `.js` files: the server's
// parity test (test/unit/server/draftParity.test.ts) loads this file, so the server's type check (NodeNext) reads it too.

import type { Stats } from '../../src/rom/types.js';
import type { BoxDraftJson, BoxJson, BoxMonJson, DraftMonJson, DraftOptionsJson, MonRef } from '../../src/server/apiTypes.js';
import {
  type DraftFacts, draftProblem, isDraftStatus, isRecord, levelOfExp, MAX_LEVEL, maxHpOf, movesFrom, sameStats, startHp, statsFrom,
} from '../../src/server/draftRules.js';
import { monName } from './labels.js';

export const DRAFT_KEY = 'pkp.draft';
export const MAX_TEAM = 6;

/** What is kept: the team and the save it is for. */
export interface DraftStore { savePath: string; savedAt: string; team: DraftMonJson[] }

/** `GET /api/draft/options`, or null while it loads or when it failed. */
export type Options = DraftOptionsJson | null;

/**
 * A change to one entry: any of its fields but the ref. To clear a level or an EXP edit, patch it to the save's own value
 * (`tidy` then drops it), never to `undefined`: `edited` keeps level and EXP consistent only for a patch that gives one.
 */
export type DraftPatch = Partial<Omit<DraftMonJson, 'ref'>>;

/** Whether a Pokémon can join the team: the server gives it draft facts (over the level cap included). */
export const canJoin = (m: BoxMonJson): boolean => m.draft !== null;

/** The save's party in slot order, those that can join, as refs. */
export function baseline(box: BoxJson): DraftMonJson[] {
  return box.mons
    .filter((m) => m.location === 'party' && canJoin(m))
    .sort((a, b) => a.slot - b.slot)
    .map((m) => ({ ref: m.ref }));
}

/**
 * The team kept for this save: in order, without a ref the box lacks or that cannot join, a ref seen before, or anything
 * past six, and each entry through `tidy` (sparse, and what the rules refuse dropped). A kept empty team stays empty.
 * Anything else (none kept, another save or this one saved again, junk, no storage) is the baseline.
 */
export function readDraft(box: BoxJson, options: Options = null): DraftMonJson[] {
  let value: unknown;
  try {
    const text = localStorage.getItem(DRAFT_KEY);
    value = text === null ? null : (JSON.parse(text) as unknown);
  } catch {
    return baseline(box);
  }
  if (!isRecord(value) || value.savePath !== box.savePath || value.savedAt !== box.savedAt || !Array.isArray(value.team)) return baseline(box);
  const joins = new Map(box.mons.filter(canJoin).map((m) => [m.ref, m]));
  const team: DraftMonJson[] = [];
  for (const entry of value.team) {
    if (team.length === MAX_TEAM) break;
    if (!isRecord(entry) || typeof entry.ref !== 'string' || team.some((d) => d.ref === entry.ref)) continue;
    const mon = joins.get(entry.ref);
    if (mon !== undefined) team.push(tidy(mon, options, entry));
  }
  return team;
}

/** Keeps the team for this save. Without storage it just is not kept. */
export function writeDraft(box: BoxJson, team: DraftMonJson[]): void {
  const store: DraftStore = { savePath: box.savePath, savedAt: box.savedAt, team };
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(store));
  } catch {
    // The storage is unavailable: the team just is not kept.
  }
}

/** The team with `ref` last; unchanged when it is full or `ref` is in it. */
export function added(team: DraftMonJson[], ref: MonRef): DraftMonJson[] {
  if (team.length >= MAX_TEAM || team.some((d) => d.ref === ref)) return team;
  return [...team, { ref }];
}

/** The team without `ref`. */
export function removed(team: DraftMonJson[], ref: MonRef): DraftMonJson[] {
  return team.filter((d) => d.ref !== ref);
}

/** The team with the member at `index` one place up (-1) or down (1); unchanged when it is at that end. */
export function moved(team: DraftMonJson[], index: number, by: -1 | 1): DraftMonJson[] {
  const to = index + by;
  if (index < 0 || index >= team.length || to < 0 || to >= team.length) return team;
  const next = [...team];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** The team with the member at `from` taken out and put back at `to`, the rest in their order; unchanged when either is off the team. */
export function movedTo(team: DraftMonJson[], from: number, to: number): DraftMonJson[] {
  if (from === to || from < 0 || from >= team.length || to < 0 || to >= team.length) return team;
  const next = [...team];
  const [member] = next.splice(from, 1);
  next.splice(to, 0, member!);
  return next;
}

/**
 * The team with `ref` at `index` (a drop on a team slot). A member keeps its entry and moves there (`movedTo`; last for
 * an `index` at or past the end), so the team keeps its size. A newcomer enters with no edits (`{ ref }`): on an
 * occupied slot the occupant leaves, at or past the end it is put last. Unchanged for a negative `index`, and for a
 * newcomer past the end of a full team.
 */
export function placed(team: DraftMonJson[], index: number, ref: MonRef): DraftMonJson[] {
  if (index < 0) return team;
  const at = team.findIndex((d) => d.ref === ref);
  if (at >= 0) return movedTo(team, at, Math.min(index, team.length - 1));
  if (index < team.length) return team.map((d, k) => (k === index ? { ref } : d));
  return team.length >= MAX_TEAM ? team : [...team, { ref }];
}

// The draft model: one entry against its box Pokémon.

/** `mon`'s draft facts from the box; throws for one that cannot join (`canJoin`). */
function draftOf(mon: BoxMonJson): BoxDraftJson & { ivs: Stats; evs: Stats } {
  if (mon.draft === null || mon.ivs === null || mon.evs === null) throw new Error(`${mon.ref} cannot join a draft`);
  return { ...mon.draft, ivs: mon.ivs, evs: mon.evs };
}

const sixStats = (stats: Stats): Stats => ({ hp: stats.hp, atk: stats.atk, def: stats.def, spa: stats.spa, spd: stats.spd, spe: stats.spe });

/** Whether the data knows a learnset move, as the server's `known`: the docs name it (else the box writes "(move <id>)") and the ROM gives it PP. */
const isKnown = (move: { name: string; pp: number }) => !move.name.startsWith('(') && move.pp !== 0;

/**
 * What the rules need of `mon` (`DraftFacts`), as the server's `factsOfMon` builds them from the save: the level, HP, IVs
 * and EVs of the box Pokémon; the EXP, nature, base stats and item of its draft facts; its moves with their PP and max PP
 * (all known); its learnset with base PP; the growth row of its rate and the ids of the items, both null without options.
 * Throws for a Pokémon that cannot join.
 */
export function factsOf(mon: BoxMonJson, options: Options): DraftFacts {
  const draft = draftOf(mon);
  return {
    level: mon.level, exp: draft.exp, hp: mon.hp,
    ivs: sixStats(draft.ivs), evs: sixStats(draft.evs), nature: draft.nature, baseStats: sixStats(draft.baseStats),
    item: draft.item,
    moves: draft.moves.map(({ id }, k) => ({ id, pp: mon.moves[k]?.pp ?? 0, maxPp: mon.moves[k]?.maxPp ?? 0, known: true })),
    learnset: draft.learnset.map((move) => ({ level: move.level, id: move.id, pp: move.pp, known: isKnown(move) })),
    growth: options === null ? null : options.growth[draft.growthRate] ?? null,
    items: options === null ? null : new Set(options.items.map((item) => item.id)),
  };
}

const NUMBER_FIELDS = ['nature', 'level', 'exp', 'item', 'hp'] as const;

/**
 * The fields of `entry` with the JSON type `parseDraft` takes (the moves and stats through its own `movesFrom` and
 * `statsFrom`), copied; a field of another type and any other key are left out.
 */
function shaped(entry: Record<string, unknown>): DraftPatch {
  const out: DraftPatch = {};
  for (const field of NUMBER_FIELDS) {
    const value = entry[field];
    if (typeof value === 'number') out[field] = value;
  }
  if (typeof entry.status === 'string') out.status = entry.status;
  const moves = movesFrom(entry.moves);
  if (moves !== null) out.moves = moves;
  for (const field of ['ivs', 'evs'] as const) {
    const stats = statsFrom(entry[field]);
    if (stats !== null) out[field] = stats;
  }
  return out;
}

/** The order `tidy` takes the fields in: a field's rules read only the fields before it. */
const FIELD_ORDER = ['ivs', 'evs', 'nature', 'level', 'exp', 'moves', 'item', 'status', 'hp'] as const;

/** The PP a move has when the entry gives none: a save move's own PP, a new move's base PP. */
const defaultPp = (facts: DraftFacts, id: number): number | undefined =>
  facts.moves.find((move) => move.id === id)?.pp ?? facts.learnset.find((move) => move.id === id)?.pp;

/**
 * `entry` for `mon`, sparse and legal: `{ ref: mon.ref }` for anything that is not an object. Each field of the wrong JSON
 * type is left out, and so is any key `DraftMonJson` lacks. The fields are then taken in `FIELD_ORDER`, each kept when
 * the entry so far with it has no `draftProblem` (the status: when `isDraftStatus`). Last, in the same order, what is the
 * save's own value is dropped: equal IVs, EVs, nature, level and item; an EXP equal to the save's at the save's level, or
 * to the level's own total at another (kept without a table); a move's PP equal to its default, then the moves when they
 * are the save's in order with no PP left; the save's status ('none' for none); the HP the save's lost HP gives.
 */
export function tidy(mon: BoxMonJson, options: Options, entry: unknown): DraftMonJson {
  if (!isRecord(entry)) return { ref: mon.ref };
  const facts = factsOf(mon, options);
  const given = shaped(entry);
  let out: DraftMonJson = { ref: mon.ref };
  for (const field of FIELD_ORDER) {
    if (given[field] === undefined) continue;
    const trial: DraftMonJson = { ...out, [field]: given[field] };
    if (field === 'status' ? isDraftStatus(given.status!) : draftProblem(facts, trial) === null) out = trial;
  }

  if (out.ivs !== undefined && sameStats(out.ivs, facts.ivs)) delete out.ivs;
  if (out.evs !== undefined && sameStats(out.evs, facts.evs)) delete out.evs;
  if (out.nature === facts.nature) delete out.nature;
  if (out.level === facts.level) delete out.level;
  if (out.exp !== undefined && out.exp === (out.level === undefined ? facts.exp : facts.growth?.[out.level])) delete out.exp;
  if (out.moves !== undefined) {
    const moves = out.moves.map((move) => (move.pp !== undefined && move.pp === defaultPp(facts, move.id) ? { id: move.id } : move));
    const own = moves.length === facts.moves.length && moves.every((move, k) => move.pp === undefined && move.id === facts.moves[k]!.id);
    if (own) delete out.moves;
    else out.moves = moves;
  }
  if (out.item === facts.item) delete out.item;
  if (out.status !== undefined && out.status === (mon.status ?? 'none')) delete out.status;
  if (out.hp !== undefined) {
    const { hp, ...rest } = out;
    if (hp === startHp(facts, rest)) delete out.hp;
  }
  return out;
}

/**
 * The team's entries for `team` (refs, in order): for each, the `tidy` of its entry in `entries` when its box Pokémon can
 * join, else `{ ref }`.
 */
export function fitted(box: BoxJson, options: Options, team: readonly MonRef[], entries: readonly DraftMonJson[]): DraftMonJson[] {
  return team.map((ref) => {
    const mon = box.mons.find((m) => m.ref === ref);
    return mon === undefined || !canJoin(mon) ? { ref } : tidy(mon, options, entries.find((entry) => entry.ref === ref));
  });
}

const STATUS_CHOICES = 'none, sleep:1 to sleep:7, poison, toxic, burn, freeze or paralysis';

/**
 * `entry` (`mon`'s) with `patch` applied, kept consistent, then tidied:
 * 1. a new level without an EXP drops the EXP edit; a new EXP with a growth table sets the level it gives;
 * 2. when the max HP changes, an HP edit the patch does not set keeps its lost HP, at least 1 and at most the new max;
 * 3. when the level changes, drafted moves the patch does not set keep only those still allowed at the new level (the
 *    save's, or the learnset's at or below it); with none left, the save's are back.
 * A status `isDraftStatus` refuses, or a `draftProblem`, leaves `entry` as it was, with the refusal in words
 * (`problemText`'s: "Blaze (Monferno): HP must be …").
 */
export function edited(mon: BoxMonJson, options: Options, entry: DraftMonJson, patch: DraftPatch): { entry: DraftMonJson; problem: string | null } {
  const facts = factsOf(mon, options);
  const next: DraftMonJson = { ...entry, ...patch };
  if (patch.level !== undefined && patch.exp === undefined) delete next.exp;
  if (patch.exp !== undefined && facts.growth !== null) next.level = levelOfExp(facts.growth, patch.exp);

  const [oldMax, newMax] = [maxHpOf(facts, entry), maxHpOf(facts, next)];
  if (newMax !== oldMax && next.hp !== undefined && patch.hp === undefined) next.hp = Math.min(newMax, Math.max(1, newMax - (oldMax - next.hp)));

  const level = next.level ?? facts.level;
  if (level !== (entry.level ?? facts.level) && next.moves !== undefined && patch.moves === undefined) {
    const allowed = next.moves.filter(({ id }) => facts.moves.some((move) => move.id === id) || facts.learnset.some((move) => move.id === id && move.level <= level));
    if (allowed.length === 0) delete next.moves;
    else next.moves = allowed;
  }

  if (next.status !== undefined && !isDraftStatus(next.status)) return { entry, problem: inWords(mon, `status must be ${STATUS_CHOICES}, not ${JSON.stringify(next.status)}`) };
  const problem = draftProblem(facts, next);
  if (problem !== null) return { entry, problem: inWords(mon, problem) };
  return { entry: tidy(mon, options, next), problem: null };
}

/** Whether an entry holds an edit (anything but its ref). */
export const isEdited = (entry: DraftMonJson): boolean => Object.keys(entry).length > 1;

/** The team with each member whose shown level is below the box's level cap raised to it (`edited`); nobody is lowered. */
export function allToCap(box: BoxJson, options: Options, team: DraftMonJson[]): DraftMonJson[] {
  return team.map((entry) => {
    const mon = box.mons.find((m) => m.ref === entry.ref);
    if (mon === undefined || !canJoin(mon) || (entry.level ?? mon.level) >= box.levelCap) return entry;
    return edited(mon, options, entry, { level: box.levelCap }).entry;
  });
}

/**
 * The team with each member's HP set to its max HP (`edited`), so it starts the fight full. A member already at its max
 * (the save's HP, or an HP edit) keeps its very entry; an HP that is the save's own is no edit (`tidy`).
 */
export function allToFull(box: BoxJson, options: Options, team: DraftMonJson[]): DraftMonJson[] {
  return team.map((entry) => {
    const mon = box.mons.find((m) => m.ref === entry.ref);
    if (mon === undefined || !canJoin(mon)) return entry;
    const facts = factsOf(mon, options);
    const max = maxHpOf(facts, entry);
    return startHp(facts, entry) === max ? entry : edited(mon, options, entry, { hp: max }).entry;
  });
}

/** What a team row and the editor show of one Pokémon: the save's values with the entry's edits over them. */
export interface ShownMon {
  level: number; exp: number | null; expRange: { from: number; to: number | null } | null;   // null: no growth table
  hp: number; maxHp: number; status: string;                                                 // status: 'none' or a status string
  item: number; moves: { id: number; name: string }[]; ivs: Stats; evs: Stats; nature: number;
}

/** Move `id`'s name for `mon`: the save's name for one of its moves, else the learnset's, else "(move <id>)". */
function moveName(mon: BoxMonJson, draft: BoxDraftJson, id: number): string {
  const k = draft.moves.findIndex((move) => move.id === id);
  return (k < 0 ? undefined : mon.moves[k]?.name) ?? draft.learnset.find((move) => move.id === id)?.name ?? `(move ${id})`;
}

/**
 * `mon` with `entry`'s edits: the level, the EXP (at a changed level without its own, the level's total, null without a
 * table) and the level's EXP range (`to` null at 100), the max HP and the HP the fight starts with (`startHp`: the HP
 * edit, else the save's lost HP kept), the status ('none' for none), the item, the moves by name, the IVs, EVs and nature.
 */
export function shown(mon: BoxMonJson, options: Options, entry: DraftMonJson): ShownMon {
  const draft = draftOf(mon);
  const facts = factsOf(mon, options);
  const level = entry.level ?? facts.level;
  const { growth } = facts;
  return {
    level,
    exp: entry.exp ?? (level === facts.level ? facts.exp : growth?.[level] ?? null),
    expRange: growth === null ? null : { from: growth[level]!, to: level < MAX_LEVEL ? growth[level + 1]! - 1 : null },
    hp: startHp(facts, entry),
    maxHp: maxHpOf(facts, entry),
    status: entry.status ?? mon.status ?? 'none',
    item: entry.item ?? facts.item,
    moves: (entry.moves ?? facts.moves).map(({ id }) => ({ id, name: moveName(mon, draft, id) })),
    ivs: entry.ivs ?? facts.ivs, evs: entry.evs ?? facts.evs, nature: entry.nature ?? facts.nature,
  };
}

/**
 * The moves `mon` may know at `level`: the save's in order (`level` null), then its learnset's known moves learned at or
 * below `level` that are not listed yet, each once, in learnset order, with the level it learns them at.
 */
export function moveChoices(mon: BoxMonJson, level: number): { id: number; name: string; level: number | null }[] {
  const draft = draftOf(mon);
  const choices: { id: number; name: string; level: number | null }[] = draft.moves.map(({ id }, k) => ({ id, name: mon.moves[k]?.name ?? `(move ${id})`, level: null }));
  for (const move of draft.learnset) {
    if (move.level <= level && isKnown(move) && !choices.some((choice) => choice.id === move.id)) choices.push({ id: move.id, name: move.name, level: move.level });
  }
  return choices;
}

const FIELD_WORDS: Record<string, string> = { hp: 'HP', ivs: 'IVs', evs: 'EVs', exp: 'EXP', level: 'Level', nature: 'Nature', item: 'Item' };

/** "<monName>: <rest>", with a leading field in words ("HP") and "move <id>" by its name where `moveChoices(mon, 100)` names it. */
function inWords(mon: BoxMonJson, rest: string): string {
  const names = new Map(canJoin(mon) ? moveChoices(mon, MAX_LEVEL).map((move) => [move.id, move.name]) : []);
  const words = rest
    .replace(/^(?:hp|ivs|evs|exp|level|nature|item)\b/, (field) => FIELD_WORDS[field]!)
    .replace(/\bmove (\d+)\b/g, (whole, id: string) => names.get(Number(id)) ?? whole);
  return `${monName(mon)}: ${words}`;
}

/**
 * A draft refusal in words: "draft: <ref> <rest>" whose ref is in the box becomes "<monName>: <rest>" (`inWords`); any
 * other message is returned as it is.
 */
export function problemText(box: BoxJson, message: string): string {
  const match = /^draft: (\S+) ([\s\S]+)$/.exec(message);
  const mon = match === null ? undefined : box.mons.find((m) => m.ref === match[1]);
  return match === null || mon === undefined ? message : inWords(mon, match[2]!);
}
