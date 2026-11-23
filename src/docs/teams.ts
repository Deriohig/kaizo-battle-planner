// Parser for the docs' split tabs ("Roark Split" … "Elite Four Split"): each trainer's party, location and notes.

import { parse } from 'csv-parse/sync';

/** One mon of a docs trainer. A mon cell with no gender, or "♀/♂", gives `gender: null`; an item cell in `NO_ITEM` gives `item: null`. */
export interface DocTrainerMon { level: number; species: string; gender: 'M' | 'F' | null; nature: string; ability: string; item: string | null; moves: string[] }

/** A field condition note, such as "PERMANENT RAIN". `raw` is the note's text; the other fields are what it was read as. */
export interface FieldNote { raw: string; weather?: 'rain' | 'sun' | 'sand' | 'hail'; trickRoom?: boolean; fog?: boolean; gravity?: boolean }

/**
 * What a trainer name's parentheses and trailing `*` say. `raw` holds every parenthetical piece (each parenthesis split
 * at commas), mapped or not.
 * - `partner` is the other trainer of a multi or tag battle, or the name in "TAG PARTNER <name>".
 * - `playerPartner` marks a trainer who fights on the player's side ("TAG PARTNER", "PARTNER").
 * - `backToBack` names the trainer of a "B2B With <name>" pair, fought one after the other without healing.
 */
export interface TrainerTags { gauntlet?: 'start' | 'middle' | 'end'; optional?: boolean; battle?: 'double' | 'multi' | 'tag'; partner?: string; superboss?: boolean; playerPartner?: boolean; backToBack?: string; starred: boolean; raw: string[] }

/**
 * One trainer of a split tab. `order` is its 0-based position in the tab. `field` merges the location heading's note
 * with the trainer's own; `locationGauntlet` is set under a "GYM TRAINERS ARE A GAUNTLET" heading.
 */
export interface DocTrainer { split: string; location: string; locationGauntlet: boolean; field: FieldNote | null; name: string; tags: TrainerTags; order: number; party: DocTrainerMon[] }

/** A preset gauntlet; its trainers are in docs order. */
export interface DocGauntlet { split: string; location: string; trainers: DocTrainer[] }

/** Column 4 holds the headings (locations and trainer names) and the first mon; column 16 labels a party's rows. */
const HEADING = 4;
const LABEL = 16;

/** A party's mons sit in these columns; in its Nature/Abillity row, each ability is one column right of its nature. */
const MON_COLUMNS = [4, 6, 8, 10, 12, 14];

/** The title ("  PLATINUM KAIZO - ROARK SPLIT") and "AI Flag Key:" rows top every tab; neither is a heading. */
const NOT_A_HEADING = /^(PLATINUM KAIZO\b|AI Flag Key)/i;

/** "Lv 5 Zigzagoon ♂". The tabs also write "LV", double spaces, "♀/♂" for either gender and, late on, no gender at all. */
const MON_CELL = /^lv\s*(\d+)\s+(.+?)(?:\s+(♂|♀|♀\/♂))?$/i;
const GENDERS: Record<string, 'M' | 'F'> = { '♂': 'M', '♀': 'F' };

/** Item cells meaning no item: "(None)", an empty cell, or "None" (Leader Fantina's first team in the Fantina Split). */
const NO_ITEM = new Set(['(None)', '', 'None']);

const WEATHERS: [RegExp, NonNullable<FieldNote['weather']>][] = [
  [/\bRAIN\b/i, 'rain'], [/\bSUN(NY)?\b/i, 'sun'], [/\bSAND(STORM)?\b/i, 'sand'], [/\bHAIL\b/i, 'hail']];

/** "MULTI BATTLE With Galactic Luna" or "TAG BATTLE with Galactic Cupid". The Galactic Split once writes "MUTLI". */
const PARTNERED = /^(MULTI|MUTLI|TAG) BATTLE with (.+)$/i;
/** "TAG PARTNER", "PARTNER", "TAG PARTNER MIRA" or "TAG PARTNER if Player chose Piplup"; an "if …" is not a name. */
const PLAYER_PARTNER = /^(?:TAG )?PARTNER\b\s*(.*)$/i;
const BACK_TO_BACK = /^B2B with (.+)$/i;
const GAUNTLET = /\bGAUNTLET(?: (START|END))?\b/i;
const GYM_GAUNTLET = /\bGYM TRAINERS ARE A GAUNTLET\b/i;

/**
 * A heading's text before its first parenthesis (without `*`), its parenthetical pieces, and whether a `*` sits outside
 * the parentheses. Text after the last parenthesis (the docs have a stray "." twice) is dropped.
 */
function splitHeading(text: string): { bare: string; pieces: string[]; starred: boolean } {
  const open = text.indexOf('(');
  return {
    bare: (open < 0 ? text : text.slice(0, open)).replaceAll('*', '').trim(),
    pieces: [...text.matchAll(/\(([^)]*)\)/g)].flatMap((match) => match[1]!.split(',')).map((piece) => piece.trim()).filter(Boolean),
    starred: text.replace(/\([^)]*\)/g, '').includes('*'),
  };
}

/** The field conditions a piece of text names. Whole words only, so "TRAINERS" is not rain. */
function conditions(text: string): Omit<FieldNote, 'raw'> {
  const found: Omit<FieldNote, 'raw'> = {};
  const weather = WEATHERS.find(([pattern]) => pattern.test(text));
  if (weather) found.weather = weather[1];
  if (/\bTRICK ROOM\b/i.test(text)) found.trickRoom = true;
  if (/\bFOG\b/i.test(text)) found.fog = true;
  if (/\bGRAVITY\b/i.test(text)) found.gravity = true;
  return found;
}

/** The note made of these pieces, or null for none. */
function fieldNote(pieces: string[]): FieldNote | null {
  if (pieces.length === 0) return null;
  const note: FieldNote = { raw: pieces.join(', ') };
  for (const piece of pieces) Object.assign(note, conditions(piece));
  return note;
}

/** The location's note overlaid with the trainer's own: the texts joined, and the trainer's conditions winning. */
function mergeFields(location: FieldNote | null, own: FieldNote | null): FieldNote | null {
  if (!own) return location && { ...location };
  if (!location) return own;
  return { ...location, ...own, raw: location.raw === own.raw ? own.raw : `${location.raw}, ${own.raw}` };
}

interface Location { name: string; gauntlet: boolean; field: FieldNote | null }

/** "Eterna Gym (PERMANENT RAIN, GYM TRAINERS ARE A GAUNTLET)": every piece but the gauntlet flag is a field note. */
function parseLocation(text: string): Location {
  const { bare, pieces } = splitHeading(text);
  const notes = pieces.filter((piece) => !GYM_GAUNTLET.test(piece));
  return { name: bare, gauntlet: notes.length < pieces.length, field: fieldNote(notes) };
}

/** Marks a player-side partner if `text` (a piece, or a bare name like "TAG PARTNER MIRA") says so; returns whether it did. */
function markPlayerPartner(tags: TrainerTags, text: string): boolean {
  const match = text.match(PLAYER_PARTNER);
  if (!match) return false;
  tags.playerPartner = true;
  const name = match[1]!.trim();
  if (name && !/^if\b/i.test(name)) tags.partner = name;
  return true;
}

/** "Twins Liv & Liz (DOUBLE) (Gauntlet Start)*": the bare name, its tags, and its own field note. */
function parseTrainerName(text: string): { name: string; tags: TrainerTags; field: FieldNote | null } {
  const { bare, pieces, starred } = splitHeading(text);
  const tags: TrainerTags = { starred, raw: pieces };
  const notes: string[] = [];
  markPlayerPartner(tags, bare);
  for (const piece of pieces) {
    // In these pieces the rest is a name, which is not searched for other words.
    const partnered = piece.match(PARTNERED);
    if (partnered) {
      tags.battle = partnered[1]!.toUpperCase() === 'TAG' ? 'tag' : 'multi';
      tags.partner = partnered[2]!.trim();
      continue;
    }
    const backToBack = piece.match(BACK_TO_BACK);
    if (backToBack) {
      tags.backToBack = backToBack[1]!.trim();
      continue;
    }
    if (markPlayerPartner(tags, piece)) continue;
    const gauntlet = piece.match(GAUNTLET);
    if (gauntlet) tags.gauntlet = gauntlet[1] === undefined ? 'middle' : /start/i.test(gauntlet[1]) ? 'start' : 'end';
    if (/\bDOUBLE\b/i.test(piece)) tags.battle = 'double';
    if (/\bOPTIONAL\b/i.test(piece)) tags.optional = true;
    if (/\bSUPERBOSS\b/i.test(piece)) tags.superboss = true;
    if (Object.keys(conditions(piece)).length > 0) notes.push(piece);
  }
  return { name: bare, tags, field: fieldNote(notes) };
}

/** The mon in column `c` of the party whose Pokémon row is `at`, or null if that column is empty. */
function parseMon(rows: string[][], at: number, c: number, split: string): DocTrainerMon | null {
  const cell = (row: number, column = c) => rows[at + row]?.[column]?.trim() ?? '';
  if (!cell(0)) return null;
  const match = cell(0).match(MON_CELL);
  if (!match) throw new Error(`${split} row ${at + 1}: cannot read the Pokémon cell "${cell(0)}"`);
  const item = cell(2);
  return {
    level: Number(match[1]), species: match[2]!, gender: GENDERS[match[3] ?? ''] ?? null,
    nature: cell(1), ability: cell(1, c + 1), item: NO_ITEM.has(item) ? null : item,
    moves: [3, 4, 5, 6].map((row) => cell(row)).filter(Boolean),
  };
}

/**
 * Every trainer in one split tab's CSV export, in docs order.
 *
 * A party is 7 rows: Pokémon, Nature/Abillity, Item, then the Moves row and 3 more move rows. It is found by its Moves
 * label, because the real tabs leave the Pokémon label out of 46 parties (most of the Galactic Split from Mount
 * Coronet on). The nearest column-4 text above a party is its trainer's name. The next one up, if it comes after the
 * previous party, is a location heading, which holds until the next one. Blank rows are skipped.
 *
 * Throws, naming the split and row, on a mon cell that is not `Lv N Species [♂/♀]` or a party with no name above it.
 */
export function parseTeamTab(csv: string, split: string): DocTrainer[] {
  const rows: string[][] = parse(csv, { relax_column_count: true });
  const trainers: DocTrainer[] = [];
  let location: Location = { name: '', gauntlet: false, field: null };
  let headings: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i + 3]?.[LABEL] === 'Moves') {
      const name = headings.pop();
      if (name === undefined) throw new Error(`${split} row ${i + 1}: a party has no trainer name above it`);
      const heading = headings.at(-1);
      if (heading !== undefined) location = parseLocation(heading);
      const own = parseTrainerName(name);
      trainers.push({
        split, location: location.name, locationGauntlet: location.gauntlet, field: mergeFields(location.field, own.field),
        name: own.name, tags: own.tags, order: trainers.length,
        party: MON_COLUMNS.flatMap((c) => parseMon(rows, i, c, split) ?? []),
      });
      headings = [];
      i += 6;
      continue;
    }
    const text = rows[i]?.[HEADING]?.trim();
    if (text && !NOT_A_HEADING.test(text)) headings.push(text);
  }
  return trainers;
}

/** A trainer name compared ignoring case and runs of spaces. */
const nameKey = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Whether a gauntlet-tagged trainer joins the open run: a run closes at its End, and a Start begins a new
 * one. The exception is the other foe of a multi battle, who carries the same Start or End tag as the trainer before.
 */
function continuesRun(run: DocGauntlet, trainer: DocTrainer): boolean {
  const last = run.trainers.at(-1)!.tags;
  const tag = trainer.tags.gauntlet;
  const sameFight = last.battle === 'multi' && trainer.tags.battle === 'multi' && last.gauntlet === tag;
  if (last.gauntlet === 'end') return sameFight;
  return tag !== 'start' || sameFight;
}

/**
 * The docs' preset gauntlets, ordered by their first trainer's place in `trainers` (docs order). A trainer on the
 * player's side (`playerPartner`) is never in one. There are three kinds:
 * - Each run of gauntlet-tagged trainers. A run opens at a Start, or at a Gauntlet or End trainer when none
 *   is open. Untagged trainers never join it. It closes at its End (see `continuesRun` for multi battles), at a change
 *   of location heading (any trainer of another location or split), or at the next Start; a run that never reaches its
 *   End is still returned.
 * - Each run of trainers under one "GYM TRAINERS ARE A GAUNTLET" heading (all of them, tagged or not).
 * - Each back-to-back pair: a "B2B With <name>" trainer and the nearest trainer of that name in its split, in docs
 *   order. A pair whose trainers name each other is one gauntlet; a name not found in the split gives none.
 */
export function groupGauntlets(trainers: DocTrainer[]): DocGauntlet[] {
  const place = new Map(trainers.map((trainer, i) => [trainer, i]));
  const at = (trainer: DocTrainer) => place.get(trainer)!;
  const opponents = trainers.filter((trainer) => !trainer.tags.playerPartner);
  const gauntlets: DocGauntlet[] = [];
  const open = (...members: DocTrainer[]): DocGauntlet => {
    const gauntlet = { split: members[0]!.split, location: members[0]!.location, trainers: members };
    gauntlets.push(gauntlet);
    return gauntlet;
  };

  let run: DocGauntlet | undefined;
  let gym: DocGauntlet | undefined;
  for (const trainer of trainers) {
    // Every trainer, partners and untagged ones included, shows which heading the docs are under.
    if (run && (run.split !== trainer.split || run.location !== trainer.location)) run = undefined;
    if (trainer.tags.playerPartner) continue;
    if (trainer.locationGauntlet) {
      if (gym?.split === trainer.split && gym.location === trainer.location) gym.trainers.push(trainer);
      else gym = open(trainer);
      continue;
    }
    gym = undefined;
    if (trainer.tags.gauntlet === undefined) continue;
    if (run && continuesRun(run, trainer)) run.trainers.push(trainer);
    else run = open(trainer);
  }

  const pairs = new Set<string>();
  for (const trainer of opponents) {
    const name = trainer.tags.backToBack;
    if (name === undefined) continue;
    const distance = (other: DocTrainer) => Math.abs(at(other) - at(trainer));
    const other = opponents
      .filter((o) => o !== trainer && o.split === trainer.split && nameKey(o.name) === nameKey(name))
      .sort((a, b) => distance(a) - distance(b))[0];
    if (other === undefined) continue;
    const pair = [trainer, other].sort((a, b) => at(a) - at(b));
    const key = pair.map(at).join();
    if (pairs.has(key)) continue;
    pairs.add(key);
    open(...pair);
  }

  return gauntlets.sort((a, b) => at(a.trainers[0]!) - at(b.trainers[0]!));
}
