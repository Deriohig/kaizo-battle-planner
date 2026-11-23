// PKCalc (pkcalc.anastarawneh.com), the community damage calculator for Platinum Kaizo, as a second source for the
// real-data checks: its trainers' AI flags, party orders and sets against the ROM, and its import of the player's save against
// ours. Its data files are plain scripts that each define one global. Only the public site's files are read, and they
// are never run: each global's literal is parsed and read as data (`readLiteralConst`).

import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type AnyNode, parse, type Program } from 'acorn';
import { resolveNature } from '../battle/natures.js';
import type { PkcalcNatures } from '../battle/types.js';
import { writeWhole } from '../docs/fetchDocs.js';
import type { DocTrainer } from '../docs/teams.js';
import type { TrainerMatch } from '../names/matchTrainers.js';
import type { NameIndex } from '../names/nameIndex.js';
import { normaliseName } from '../names/normalise.js';
import { abilityOf } from '../rom/abilities.js';
import type { RomData } from '../rom/extract.js';
import { NATURES } from '../rom/natures.js';
import { FEMALE_TRAINER_CLASSES } from '../rom/trainerClassGender.js';
import { AI_FLAG_NAMES, type AiFlagName, type RomTrainer, type TrainerMon } from '../rom/trainers.js';
import type { SpeciesRecord, Stats } from '../rom/types.js';
import { DEFAULT_GRAVEYARD_BOXES, type SaveMon } from '../save/readSave.js';
import type { Diff } from './diff.js';

export const PKCALC_URL = 'https://pkcalc.anastarawneh.com';

/**
 * The site's data files, by the global each defines: the trainers (sets, AI flags, party orders, battle flags) and the
 * dex tables that give its species, move, item and ability names their Gen 4 IDs.
 */
export const PKCALC_FILES = {
  SETDEX_PK: 'js/data/sets.js',
  TRAINER_AI_FLAGS_PK: 'js/data/trainer_flags.js',
  PARTY_ORDER_PK: 'js/data/party_order.js',
  FLAGS_PK: 'js/data/flags.js',
  SPECIES: 'js/data/dex/species.js',
  MOVES: 'js/data/dex/moves.js',
  ITEMS: 'js/data/dex/items.js',
  ABILITIES: 'js/data/dex/abilities.js',
} as const;
export type PkcalcGlobal = keyof typeof PKCALC_FILES;

/** Where `downloadPkcalc(dir)` saves the file defining `name`: its site path below `dir`, without `js/data/`. */
export const pkcalcFile = (dir: string, name: PkcalcGlobal): string => join(dir, PKCALC_FILES[name].replace(/^js\/data\//, ''));

/**
 * Downloads every file in `PKCALC_FILES` below `dir` and writes `<dir>/meta.json` as `{ fetchedAt }`. Each file must
 * define its global, which catches an error page, as literal data that `readLiteralConst` reads; all are fetched and
 * checked before anything is written.
 */
export async function downloadPkcalc(dir = 'data/pkcalc', fetchFn: typeof fetch = fetch): Promise<void> {
  const fetchedAt = new Date().toISOString();
  const files: [string, string][] = [];
  for (const [name, path] of Object.entries(PKCALC_FILES) as [PkcalcGlobal, string][]) {
    const response = await fetchFn(`${PKCALC_URL}/${path}`);
    if (!response.ok) throw new Error(`PKCalc ${path} returned HTTP ${response.status}`);
    const body = await response.text();
    if (!new RegExp(`^const ${name} = `, 'm').test(body)) throw new Error(`PKCalc ${path} does not define ${name}`);
    readLiteralConst(body, name, path);
    files.push([pkcalcFile(dir, name), body]);
  }
  files.push([join(dir, 'meta.json'), `${JSON.stringify({ fetchedAt }, null, 2)}\n`]);
  for (const [file, text] of files) {
    await mkdir(dirname(file), { recursive: true });
    await writeWhole(file, text);
  }
}

/** Reads a downloaded data file's global `name` (see `readLiteralConst`). The file is parsed, never run. */
export function loadPkcalcGlobal(file: string, name: PkcalcGlobal): unknown {
  return readLiteralConst(readFileSync(file, 'utf8'), name, file);
}

/**
 * The value of the top-level `const <name> = <literal>;` in the script `source` (named `file` in errors), read without
 * running anything. Statements after it, such as the functions in `flags.js`, are parsed and ignored. The literal may
 * hold objects (keys as names, strings or numbers), arrays, strings, numbers, a minus sign on a number, true, false,
 * null and templates without placeholders. Anything else throws, naming the line.
 */
export function readLiteralConst(source: string, name: string, file: string): unknown {
  let program: Program;
  try {
    program = parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  } catch (error) {
    throw new Error(`${file} is not a script that can be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const statement of program.body) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue;
    const declarator = statement.declarations.find((candidate) => candidate.id.type === 'Identifier' && candidate.id.name === name);
    if (declarator?.init) return literalValue(declarator.init, file);
  }
  throw new Error(`${file} has no top-level const ${name}`);
}

/** "a CallExpression", "an Identifier". */
const withArticle = (type: string) => `${/^[AEIOU]/.test(type) ? 'an' : 'a'} ${type}`;

/** The value of a literal-only expression, as `readLiteralConst` describes. */
function literalValue(node: AnyNode, file: string): unknown {
  const refuse = (what: string, at: AnyNode = node) =>
    new Error(`${file} line ${at.loc?.start.line ?? '?'}: ${what} is not literal data; only objects, arrays, strings, numbers, true, false and null are read`);
  switch (node.type) {
    case 'ObjectExpression': {
      const object: Record<string, unknown> = {};
      for (const property of node.properties) {
        if (property.type === 'SpreadElement') throw refuse('a SpreadElement', property);
        if (property.kind !== 'init' || property.method || property.shorthand || property.computed) {
          throw refuse('a getter, setter, method, shorthand or computed key', property);
        }
        const { key } = property;
        const name = key.type === 'Identifier' ? key.name
          : key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number') ? String(key.value) : null;
        if (name === null) throw refuse(`${withArticle(key.type)} key`, key);
        // In a literal, `__proto__: value` sets the prototype instead of adding a key.
        if (name === '__proto__') throw refuse('a __proto__ key', key);
        object[name] = literalValue(property.value, file);
      }
      return object;
    }
    case 'ArrayExpression':
      return node.elements.map((element) => {
        if (element === null) throw refuse('an array hole');
        if (element.type === 'SpreadElement') throw refuse('a SpreadElement', element);
        return literalValue(element, file);
      });
    case 'Literal': {
      // A regex or BigInt literal has `regex` or `bigint` set, and a null `value` where it cannot be built.
      const plain = !node.regex && !node.bigint;
      const { value } = node;
      if (plain && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null)) return value;
      throw refuse(`the literal ${node.raw ?? ''}`);
    }
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') return -node.argument.value;
      throw refuse(`${withArticle(node.type)} (${node.operator})`);
    case 'TemplateLiteral': {
      const cooked = node.expressions.length === 0 ? node.quasis[0]?.value.cooked : undefined;
      if (typeof cooked === 'string') return cooked;
      throw refuse('a TemplateLiteral with placeholders');
    }
    default:
      throw refuse(withArticle(node.type));
  }
}

/** PKCalc's six stats, as its sets and save import name them. */
export interface PkcalcStats { hp: number; at: number; df: number; sa: number; sd: number; sp: number }

/** One trainer Pokémon in `SETDEX_PK`. `item` is left out for none. */
export interface PkcalcSet { ability: string; gender: string; item?: string; ivs: PkcalcStats; level: number; moves: string[]; nature: string }

/** `SETDEX_PK`: species name, then trainer key, then the set. */
export type Setdex = Record<string, Record<string, PkcalcSet>>;

/** PKCalc's AI flag names and ours (`AI_FLAG_NAMES`). */
export const PKCALC_AI_FLAGS = {
  Basic: 'Basic', EvaluateAttack: 'EvalAttack', Expert: 'Expert', Setup: 'SetupFirstTurn', Risky: 'Risky',
  DamagePriority: 'PrioritizeExtremes', BatonPass: 'BatonPass', TagStrategy: 'TagStrategy', CheckHP: 'CheckHP',
  Weather: 'Weather', Harassment: 'Harassment',
} as const satisfies Record<string, AiFlagName>;

/** One trainer's `TRAINER_AI_FLAGS_PK` entry: each PKCalc flag, 0 or 1. */
export type PkcalcAiFlags = Record<keyof typeof PKCALC_AI_FLAGS, 0 | 1>;

interface DexSpecies { num: number; id: string; name: string; baseSpecies?: string; formes?: string[] }
interface DexNamed { num: number; calcName: string }

/** The fields of PKCalc's dex tables that `buildPkcalcDex` reads, each table keyed by PKCalc's ID ("rotomwash"). */
export interface DexTables { SPECIES: Record<string, DexSpecies>; MOVES: Record<string, DexNamed>; ITEMS: Record<string, DexNamed>; ABILITIES: Record<string, DexNamed> }

/** A PKCalc species name's species and form. `form` is null where PKCalc keeps no forms for the species (Burmy, Unown). */
export interface PkcalcSpecies { id: number; form: number | null }

/** Gen 4 IDs for PKCalc's names: species by name ("Rotom-Wash"), the rest by the calculator's name ("Feint Attack"). Null for an unknown name. */
export interface PkcalcDex {
  species(name: string): PkcalcSpecies | null;
  move(name: string): number | null;
  item(name: string): number | null;
  ability(name: string): number | null;
}

/**
 * Indexes PKCalc's dex tables. A form's entry (`baseSpecies` set) has its base species' ID; its form is its place in
 * the base's `formes`, which list the base first, in the game's form order.
 */
export function buildPkcalcDex(tables: DexTables): PkcalcDex {
  const species = new Map(Object.values(tables.SPECIES).map((entry): [string, PkcalcSpecies] => {
    const formes = (entry.baseSpecies ? tables.SPECIES[entry.baseSpecies] : entry)?.formes ?? [];
    const form = formes.indexOf(entry.id);
    if (formes.length > 0 && form < 0) throw new Error(`PKCalc's ${entry.name} is not among its species' formes`);
    return [entry.name, { id: entry.num, form: formes.length > 0 ? form : null }];
  }));
  const byName = (table: Record<string, DexNamed>) => {
    const ids = new Map(Object.values(table).map((entry) => [entry.calcName, entry.num]));
    return (name: string) => ids.get(name) ?? null;
  };
  return { species: (name) => species.get(name) ?? null, move: byName(tables.MOVES), item: byName(tables.ITEMS), ability: byName(tables.ABILITIES) };
}

/** Run in the PKCalc page: its dex tables as `DexTables`, cut down to the fields `buildPkcalcDex` reads. */
export const PAGE_DEX_TABLES = `(() => {
  const pick = (table, fields) => Object.fromEntries(Object.entries(table).map(([id, entry]) => [id, Object.fromEntries(fields.map((field) => [field, entry[field]]))]));
  return { SPECIES: pick(SPECIES, ['num', 'id', 'name', 'baseSpecies', 'formes']), MOVES: pick(MOVES, ['num', 'calcName']), ITEMS: pick(ITEMS, ['num', 'calcName']), ABILITIES: pick(ABILITIES, ['num', 'calcName']) };
})()`;

/** The PKCalc data the checks read. */
export interface PkcalcData { sets: Setdex; aiFlags: Record<string, PkcalcAiFlags>; partyOrder: Record<string, string[]>; dex: PkcalcDex }

/** Loads what `downloadPkcalc(dir)` saved. */
export function loadPkcalc(dir = 'data/pkcalc'): PkcalcData {
  const load = (name: PkcalcGlobal) => loadPkcalcGlobal(pkcalcFile(dir, name), name);
  return {
    sets: load('SETDEX_PK') as Setdex,
    aiFlags: load('TRAINER_AI_FLAGS_PK') as Record<string, PkcalcAiFlags>,
    partyOrder: load('PARTY_ORDER_PK') as Record<string, string[]>,
    dex: buildPkcalcDex({ SPECIES: load('SPECIES'), MOVES: load('MOVES'), ITEMS: load('ITEMS'), ABILITIES: load('ABILITIES') } as DexTables),
  };
}

/** The flags PKCalc sets, by our names in bit order. Throws for a flag it does not know or a value other than 0 or 1. */
export function pkcalcAiFlags(flags: PkcalcAiFlags): AiFlagName[] {
  const set = new Set<AiFlagName>();
  for (const [flag, value] of Object.entries(flags)) {
    if (!Object.hasOwn(PKCALC_AI_FLAGS, flag) || (value !== 0 && value !== 1)) throw new Error(`Unknown PKCalc AI flag ${flag}: ${String(value)}`);
    if (value === 1) set.add(PKCALC_AI_FLAGS[flag as keyof typeof PKCALC_AI_FLAGS]);
  }
  return AI_FLAG_NAMES.filter((name) => set.has(name));
}

/** The flags of a ROM `aiMask`, by name; a bit past `AI_FLAG_NAMES` shows as "bit N". */
function maskFlags(mask: number): string[] {
  return Array.from({ length: 32 }, (_, bit) => bit).filter((bit) => (mask >>> bit) & 1).map((bit) => AI_FLAG_NAMES[bit] ?? `bit ${bit}`);
}

/** A PKCalc trainer key in parts. `base` is the name normalised by `trainerBase`; `tag` is the bracketed starter or letter. */
export interface PkcalcKey { key: string; base: string; number: number | null; place: string | null; tag: string | null }

/** "Pokémon Trainer Barry #2 [Chimchar]", "Pokémon Trainer Dawn @ Jubilife City [Prinplup]", "Swimmer Wang [A]". */
const KEY_PARTS = /^(.+?)(?: #(\d+))?(?: @ (.+?))?(?: \[(.+)\])?$/;

/**
 * A trainer name in a form both sides share: "Pokémon Trainer", "Trainer" or "TAG PARTNER" dropped from the front,
 * "Pkmn" spelt "Pokémon", "and" as "&", then `normaliseName`.
 */
function trainerBase(name: string): string {
  return normaliseName(name.replace(/\bpkmn\b/gi, 'Pokémon').replace(/^(Pokémon Trainer|Trainer|TAG PARTNER) /i, '').replace(/ and /gi, ' & '));
}

export function parsePkcalcKey(key: string): PkcalcKey {
  const [, name, number, place, tag] = key.match(KEY_PARTS)!;
  return { key, base: trainerBase(name!), number: number === undefined ? null : Number(number), place: place ?? null, tag: tag ?? null };
}

/** Docs trainers PKCalc names another way, by `trainerBase`: the docs' name, then PKCalc's. */
const DOCS_ALIASES: Record<string, string> = {
  // The docs call Cyrus a Leader, or give him no class.
  leadercyrus: 'galacticbosscyrus', cyrus: 'galacticbosscyrus',
  leadercrasherwake: 'leaderwake',
  // A docs typo.
  picknickertori: 'picnickertori',
  // The two sides disagree on whether Leda and Themisto are in the Galactic Squad.
  galacticsquadleda: 'galacticleda', galacticthemisto: 'galacticsquadthemisto',
};

/**
 * A docs trainer name as `trainerBase` gives PKCalc's, with its fight number ("Barry #2"). The docs' female-class mark
 * ("GalacticfVenus", "CyclistF Megan") is dropped, "Dawn/Lucas" is Dawn for a female class and Lucas otherwise, and text
 * after a comma ("Idol Zoe, the best trainer…") is cut.
 */
export function docsTrainerBase(name: string, femaleClass: boolean): { base: string; number: number | null } {
  const [, text, number] = name.split(',')[0]!.match(/^(.*?)(?:\s*#(\d+))?\s*$/)!;
  const base = trainerBase(text!
    .replace(/(\p{Ll})[fF](?=\s|\p{Lu})/u, '$1 ')
    .replace(/(\S+)\/(\S+)/, (_, female: string, male: string) => (femaleClass ? female : male)));
  return { base: DOCS_ALIASES[base] ?? base, number: number === undefined ? null : Number(number) };
}

/** Matched trainers and the PKCalc trainer keys they join; `unusedKeys` are the keys none joined, in PKCalc's order. */
export interface PkcalcJoin { joined: { match: TrainerMatch; key: string }[]; unjoined: TrainerMatch[]; unusedKeys: string[] }

/** Keys PKCalc fills in from its settings ("Pokémon Trainer Barry #1 [{RIVAL_STARTER_1}]"), with no party of their own. */
const TEMPLATE_KEY = /\{/;

/**
 * Joins each matched trainer to a PKCalc trainer key by docs name. The candidates are the keys with the same name
 * (`docsTrainerBase`, `parsePkcalcKey`), the same fight number if the docs give one, and a bracketed starter in the ROM
 * party; a key already taken by another docs trainer is out (a shared ROM copy takes its docs trainer's key). Of these
 * a trainer takes the first in PKCalc's order (so "#n" keys go by order), first among keys whose party has the ROM
 * trainer's species, then among any, so a key goes to the trainer it fits even when the docs name two trainers alike.
 */
export function joinPkcalc(matched: TrainerMatch[], trainers: RomTrainer[], pkcalc: Pick<PkcalcData, 'partyOrder' | 'dex'>): PkcalcJoin {
  const keys = Object.keys(pkcalc.partyOrder).filter((key) => !TEMPLATE_KEY.test(key)).map(parsePkcalcKey);
  const byIndex = new Map(trainers.map((trainer) => [trainer.index, trainer]));
  const speciesList = (ids: number[]) => ids.sort((a, b) => a - b).join(' ');
  const pkcalcSpecies = (key: string) => speciesList(pkcalc.partyOrder[key]!.map((name) => pkcalc.dex.species(name)?.id ?? -1));
  const owners = new Map<string, DocTrainer>();
  const keyOf = new Map<TrainerMatch, string>();
  for (const needFit of [true, false]) {
    for (const match of matched) {
      if (keyOf.has(match)) continue;
      const trainer = byIndex.get(match.romIndex);
      if (!trainer) throw new Error(`No ROM trainer ${match.romIndex}`);
      const { base, number } = docsTrainerBase(match.doc.name, FEMALE_TRAINER_CLASSES.has(trainer.trainerClass));
      const romSpecies = speciesList(trainer.party.map((mon) => mon.species));
      const key = keys.find((candidate) => {
        if (candidate.base !== base || (number !== null && candidate.number !== number)) return false;
        if ((owners.get(candidate.key) ?? match.doc) !== match.doc) return false;
        const starter = candidate.tag === null ? null : pkcalc.dex.species(candidate.tag);
        if (starter !== null && !trainer.party.some((mon) => mon.species === starter.id)) return false;
        return !needFit || pkcalcSpecies(candidate.key) === romSpecies;
      });
      if (key) {
        keyOf.set(match, key.key);
        owners.set(key.key, match.doc);
      }
    }
  }
  const used = new Set(keyOf.values());
  return {
    joined: matched.flatMap((match) => (keyOf.has(match) ? [{ match, key: keyOf.get(match)! }] : [])),
    unjoined: matched.filter((match) => !keyOf.has(match)),
    unusedKeys: keys.map(({ key }) => key).filter((key) => !used.has(key)),
  };
}

const sameName = (a: string, b: string) => normaliseName(a) === normaliseName(b);
const listed = (values: unknown[]) => JSON.stringify(values);

/** Whether a PKCalc species name stands for a Pokémon: the same species, and the same form where PKCalc keeps forms. */
function namesMon(dex: PkcalcDex, name: string, mon: { species: number; form: number }): boolean {
  const found = dex.species(name);
  return found !== null && found.id === mon.species && (found.form === null || found.form === mon.form);
}

/**
 * PKCalc's set for a ROM trainer Pokémon whose trainer joined `key`: the set under `key` of the first name in the key's
 * party that stands for it (`namesMon`). `name` is undefined where the party has no such name, and `set` where PKCalc
 * has no set for it.
 */
function setOf(pkcalc: Pick<PkcalcData, 'sets' | 'partyOrder' | 'dex'>, key: string, mon: TrainerMon): { name?: string; set?: PkcalcSet } {
  const name = pkcalc.partyOrder[key]?.find((candidate) => namesMon(pkcalc.dex, candidate, mon));
  return { name, set: name === undefined ? undefined : pkcalc.sets[name]?.[key] };
}

const PKCALC_NATURE_IDS = new Map(NATURES.map((name, id) => [normaliseName(name), id]));

/**
 * PKCalc's nature for each Pokémon of the joined trainers (`join`), by ROM index and party slot: the nature ID of its
 * set (`setOf`, as `diffPkcalc` finds it). Null for a trainer that joined no key, a Pokémon PKCalc has no set for, and
 * a set whose nature names no nature (natures compare as `normaliseName`).
 */
export function pkcalcNatures(join: PkcalcJoin, trainers: RomTrainer[], pkcalc: Pick<PkcalcData, 'sets' | 'partyOrder' | 'dex'>): PkcalcNatures {
  const byIndex = new Map(trainers.map((trainer) => [trainer.index, trainer]));
  const natures = new Map<string, number>();
  for (const { match, key } of join.joined) {
    byIndex.get(match.romIndex)?.party.forEach((mon, slot) => {
      const nature = setOf(pkcalc, key, mon).set?.nature;
      const id = nature === undefined ? undefined : PKCALC_NATURE_IDS.get(normaliseName(nature));
      if (id !== undefined) natures.set(`${match.romIndex}/${slot}`, id);
    });
  }
  return (romIndex, slot) => natures.get(`${romIndex}/${slot}`) ?? null;
}

/**
 * One field of a ROM Pokémon against a PKCalc set. `kind` is the field's family (`move-order` is of kind `moves`, and
 * `ability-cross-check` of kind `ability`); `values` gives the ROM's and PKCalc's by name.
 */
interface SetField { field: string; kind: string; same: boolean; values: () => [unknown, unknown] }

/** `mon` against `set`, field by field, as `diffPkcalc` describes; `docsCell` is its docs nature cell, if any. */
function compareSet(mon: TrainerMon, set: PkcalcSet, docsCell: string | null, species: SpeciesRecord[], dex: PkcalcDex, names: NameIndex): SetField[] {
  const ability = abilityOf(species, mon);
  const moves = set.moves.map((move) => dex.move(move));
  const sameMoves = listed(moves) === listed(mon.moves);
  const sameMoveSet = listed([...moves].sort()) === listed([...mon.moves].sort());
  const resolved = resolveNature(mon, docsCell);
  const nature = resolved.value === null ? null : NATURES[resolved.value]!;
  const natureField = resolved.source === 'rom' ? 'nature' : 'nature-from-docs';
  return [
    { field: 'level', kind: 'level', same: mon.level === set.level, values: () => [mon.level, set.level] },
    {
      field: ability.byPid && !mon.natureKnown ? 'ability-cross-check' : 'ability', kind: 'ability',
      same: ability.id === dex.ability(set.ability), values: () => [names.ability(ability.id), set.ability],
    },
    {
      field: 'item', kind: 'item', same: mon.item === (set.item === undefined ? 0 : dex.item(set.item)),
      values: () => [mon.item === 0 ? null : names.item(mon.item), set.item ?? null],
    },
    { field: !sameMoves && sameMoveSet ? 'move-order' : 'moves', kind: 'moves', same: sameMoves, values: () => [mon.moves.map((id) => names.move(id)), set.moves] },
    { field: natureField, kind: natureField, same: nature !== null && sameName(nature, set.nature), values: () => [nature, set.nature] },
  ];
}

/**
 * The ROM against PKCalc for the joined trainers, in four areas:
 * - `pkcalc-join`: each matched trainer that joins no key (field `key`, the ROM party against null).
 * - `pkcalc-ai`: AI flags against the ROM's `aiMask` (field `flags`).
 * - `pkcalc-party-order`: the party, slot by slot (field `order`); a PKCalc name without a form fits any form.
 * - `pkcalc-sets`: each ROM Pokémon against the set of its species (field `set` when PKCalc has none): `level`,
 *   `ability` (`ability-cross-check` where the PID that picks it is untrusted, as in `diffTrainers`), `item`, `moves`
 *   by ID (`move-order` for the same moves in another order) and the nature the planner uses (by
 *   `resolveNature`): the ROM's where it is known (`nature`), the docs' cleaned value otherwise
 *   (`nature-from-docs`, null where the docs cell gives none). A set difference gets the suffix
 *   `-other-copy` (`nature-other-copy`) where another ROM copy of the team joined to the same key has
 *   PKCalc's value in that field, so that PKCalc lists the other copy's value.
 * Keys read "Roark Split: Youngster Tristan [ROM 1]", plus " mon 2 (Sentret)" for a set, the species as PKCalc names it.
 */
export function diffPkcalc(join: PkcalcJoin, rom: Pick<RomData, 'species' | 'trainers'>, pkcalc: PkcalcData, names: NameIndex): Diff[] {
  const byIndex = new Map(rom.trainers.map((trainer) => [trainer.index, trainer]));
  const trainerOf = (match: TrainerMatch) => byIndex.get(match.romIndex)!;
  const label = (match: TrainerMatch) => `${match.doc.split}: ${match.doc.name} [ROM ${match.romIndex}]`;
  const speciesName = (mon: TrainerMon) => names.species(mon.species, mon.form);
  const diffs: Diff[] = join.unjoined.map((match) => ({ area: 'pkcalc-join', key: label(match), field: 'key', rom: trainerOf(match).party.map(speciesName), docs: null }));
  for (const { match, key } of join.joined) {
    const trainer = trainerOf(match);
    const party = pkcalc.partyOrder[key]!;
    const flags = pkcalc.aiFlags[key];
    const pkcalcFlags = flags === undefined ? null : pkcalcAiFlags(flags);
    if (pkcalcFlags === null || listed(pkcalcFlags) !== listed(maskFlags(trainer.aiMask))) {
      diffs.push({ area: 'pkcalc-ai', key: label(match), field: 'flags', rom: maskFlags(trainer.aiMask), docs: pkcalcFlags });
    }
    if (party.length !== trainer.party.length || !trainer.party.every((mon, i) => namesMon(pkcalc.dex, party[i]!, mon))) {
      diffs.push({ area: 'pkcalc-party-order', key: label(match), field: 'order', rom: trainer.party.map(speciesName), docs: party });
    }
    const copies = join.joined.filter((other) => other.key === key && other.match !== match).map((other) => other.match);
    trainer.party.forEach((mon, slot) => {
      const { name, set } = setOf(pkcalc, key, mon);
      const setKey = `${label(match)} mon ${slot + 1} (${name ?? speciesName(mon)})`;
      const add = (field: string, romValue: unknown, pkcalcValue: unknown) => diffs.push({ area: 'pkcalc-sets', key: setKey, field, rom: romValue, docs: pkcalcValue });
      if (name === undefined || !set) {
        add('set', speciesName(mon), null);
        return;
      }
      const fieldsOf = (owner: TrainerMatch, target: TrainerMon) =>
        compareSet(target, set, owner.doc.party[slot]?.nature ?? null, rom.species, pkcalc.dex, names);
      for (const field of fieldsOf(match, mon)) {
        if (field.same) continue;
        const otherCopy = copies.some((copy) => {
          const copyMon = trainerOf(copy).party[slot];
          return copyMon !== undefined && namesMon(pkcalc.dex, name, copyMon) && fieldsOf(copy, copyMon).some((other) => other.kind === field.kind && other.same);
        });
        add(otherCopy ? `${field.field}-other-copy` : field.field, ...field.values());
      }
    });
  }
  return diffs;
}

/**
 * One Pokémon of PKCalc's save import (`localStorage.customsets`), pinned from its import of the player's save on 2026-11-08.
 * `data.id` is the PID, the IVs (hp, at, df, sa, sd, sp) and the met level in hex: "2939ae6a-001a0c0a0718-05".
 * `data.dead` marks box slots from 421 on (boxes 15–18). Its import reads no EVs, so `evs` is left out today.
 */
export interface PkcalcCustomSet {
  ability: string; level: number; gender: string; ivs: PkcalcStats; moves: string[]; nature: string; item?: string; evs?: PkcalcStats;
  data: { id: string; abilityIndex: number; location?: string; dead: boolean };
}

/** `localStorage.customsets`: species name, then nickname ("Custom Set" for a Pokémon with none), then the Pokémon. */
export type PkcalcCustomSets = Record<string, Record<string, PkcalcCustomSet>>;

/** PKCalc's stat names, in the order its `data.id` writes the IVs. */
const PKCALC_STATS: (keyof PkcalcStats)[] = ['hp', 'at', 'df', 'sa', 'sd', 'sp'];
const pkcalcStats = (stats: Stats): PkcalcStats => ({ hp: stats.hp, at: stats.atk, df: stats.def, sa: stats.spa, sd: stats.spd, sp: stats.spe });
const sameStats = (stats: Stats, other: PkcalcStats) => PKCALC_STATS.every((stat) => pkcalcStats(stats)[stat] === other[stat]);
const hex = (value: number, digits: number) => value.toString(16).padStart(digits, '0');

/**
 * Our save reader's Pokémon against PKCalc's import of the same save. Each Pokémon that is not an egg must have exactly
 * one entry with its PID and IVs (`data.id`), with the same species (and form where PKCalc keeps forms), level, nature,
 * ability, item, moves, IVs, EVs where PKCalc has them, and graveyard state. Every entry must belong to a Pokémon, eggs
 * included. Returns one line per difference; IDs on our side, PKCalc's names on its own.
 */
export function diffBox(mons: SaveMon[], customsets: PkcalcCustomSets, dex: PkcalcDex, graveyardBoxes: number[] = DEFAULT_GRAVEYARD_BOXES): string[] {
  const entries = Object.entries(customsets).flatMap(([species, sets]) => Object.entries(sets).map(([nickname, set]) => ({ species, nickname, set })));
  const claimed = new Set<(typeof entries)[number]>();
  const lines: string[] = [];
  for (const mon of mons) {
    const ivs = pkcalcStats(mon.ivs);
    const id = `${hex(mon.pid, 8)}-${PKCALC_STATS.map((stat) => hex(ivs[stat], 2)).join('')}`;
    const found = entries.filter((entry) => entry.set.data.id.startsWith(`${id}-`));
    for (const entry of found) claimed.add(entry);
    if (mon.isEgg) continue;
    const where = mon.location.kind === 'party' ? `party ${mon.location.slot}` : `box ${mon.location.box}/${mon.location.slot}`;
    const say = (text: string) => lines.push(`${where} ${mon.nickname}: ${text}`);
    if (found.length !== 1) {
      say(`${found.length === 0 ? 'no PKCalc entry' : `${found.length} PKCalc entries`} with PID ${hex(mon.pid, 8)} and these IVs`);
      continue;
    }
    const { species, set } = found[0]!;
    if (!namesMon(dex, species, mon)) say(`species ${mon.species} form ${mon.form}, PKCalc ${species}`);
    if (mon.level !== set.level) say(`level ${mon.level}, PKCalc ${set.level}`);
    if (!sameName(NATURES[mon.nature]!, set.nature)) say(`nature ${NATURES[mon.nature]}, PKCalc ${set.nature}`);
    if (mon.ability !== dex.ability(set.ability)) say(`ability ${mon.ability}, PKCalc ${set.ability}`);
    if (mon.item !== (set.item === undefined ? 0 : dex.item(set.item))) say(`item ${mon.item}, PKCalc ${set.item}`);
    if (listed(mon.moves) !== listed(set.moves.map((move) => dex.move(move)))) say(`moves ${mon.moves.join(',')}, PKCalc ${set.moves.join(',')}`);
    if (!sameStats(mon.ivs, set.ivs)) say(`IVs ${JSON.stringify(mon.ivs)}, PKCalc ${JSON.stringify(set.ivs)}`);
    if (set.evs !== undefined && !sameStats(mon.evs, set.evs)) say(`EVs ${JSON.stringify(mon.evs)}, PKCalc ${JSON.stringify(set.evs)}`);
    const dead = mon.location.kind === 'box' && graveyardBoxes.includes(mon.location.box);
    if (dead !== set.data.dead) say(`dead ${set.data.dead} in PKCalc`);
  }
  for (const entry of entries) {
    if (!claimed.has(entry)) lines.push(`PKCalc entry ${entry.species} "${entry.nickname}" (${entry.set.data.id}) matches no Pokémon in the save`);
  }
  return lines;
}
