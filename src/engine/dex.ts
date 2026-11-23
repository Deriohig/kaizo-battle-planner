// The `platkaizo` Showdown mod and the `gen4platkaizo` format: Showdown's Gen 4 with the hack's species and moves.
//
// How they are registered, through Showdown's public `Dex` only:
// - The mod is a `Dex.ModdedDex` named "platkaizo", put in `Dex.dexes`, the table that `Dex.mod(name)` and
//   `Dex.forFormat(format)` read. Its data tables are built in memory (`buildTables`: Showdown's `gen4` tables with the
//   ROM's species and the hack's moves laid over them) and set as its `dataCache`, so Showdown never looks for a
//   `data/mods/platkaizo` folder.
// - The mod's dex finds a hack move by its ID without Showdown's aliases, which would send "fireball" (the hack's
//   Fire Ball) to G-Max Fireball and "vicegrip" to Vise Grip. Every other lookup keeps them.
// - The format is a `Dex.Format` in `Dex.formats.rulesetCache`, the cache `Dex.formats.get(id)` reads first. That is
//   how `new Battle({ formatid })` finds it, and so does `Battle.fromJSON`, which makes its battle from the saved format
//   ID. It is registered when this module loads, so a battle in the format before `installKaizoDex` throws (there is
//   no mod) instead of falling back to Showdown's default format. Its one handler runs trainer bag items: the engine
//   queues each use as an `event` action, which fires it (trainerItems.ts).
// - A new install replaces the mod in `Dex.dexes`; a battle already made keeps the dex it was made with.

import { createHash } from 'node:crypto';
import PS from 'pokemon-showdown';
import type { KaizoMove } from '../battle/moves.js';
import type { LoadedData } from '../battle/types.js';
import type { NameIndex } from '../names/nameIndex.js';
import { FORMS, personalRowFor } from '../rom/forms.js';
import { TYPE_NAMES } from '../rom/tables.js';
import type { LevelUpMove, SpeciesRecord } from '../rom/types.js';
import { LAST_SPECIES, showdownMoveNames, speciesId } from './ids.js';
import { behaviourFields, engineEffect, isTableEffect } from './effects.js';
import { canonicalJson } from './key.js';
import { KAIZO_CONDITIONS } from './mod/conditions.js';
import { KAIZO_MOVE_CALLBACKS, KAIZO_MOVE_CONDITIONS, KAIZO_MOVE_SCRIPTS, moveCallbacks } from './mod/moves.js';
import { KAIZO_ABILITY_CHANGES } from './mod/abilities.js';
import { applyField, KAIZO_FIELD_CONDITIONS, KAIZO_FIELD_SCRIPTS } from './mod/field.js';
import { assertItemData } from './mod/itemData.js';
import { KAIZO_ITEM_CONDITIONS, KAIZO_ITEM_DATA, pinchAfterMove } from './mod/items.js';
import { KAIZO_ABILITIES, KAIZO_ITEM_PROCS } from './mod/procs.js';
import { KAIZO_ITEMS, KAIZO_SCRIPTS, micleTryMove } from './mod/scripts.js';
import './restoreGuard.js'; // the restore of a Transformed Pokémon with more moves of its own than copied (restoreGuard.ts)
import { runTrainerItem, TRAINER_ITEM_EVENT } from './trainerItems.js';

export { abilityId, itemId, speciesId } from './ids.js';

const { Dex, toID } = PS;

export const KAIZO_MOD = 'platkaizo';
export const KAIZO_FORMAT = 'gen4platkaizo';

const GEN4 = Dex.mod('gen4');

/** One entry of a Showdown data table, and the data tables by name ("Pokedex", "Moves", "Scripts" and so on). */
type Entry = Record<string, unknown>;
type Tables = Record<string, Record<string, unknown>>;

/**
 * Hand-written entries laid over the generated tables (`overlay`), one record of entries per Showdown data table, each
 * from its module under mod/: the cartridge's chance sites (`Scripts` and Quick Claw's `Items` entry, mod/scripts.ts); its counters and durations (`Conditions`, mod/conditions.ts), its move draws (Roar's target in `Scripts`,
 * mod/moves.ts) and its ability and item procs (`Abilities`, `Items`, mod/procs.ts). The move callbacks of
 * mod/moves.ts go on each move by its behaviour source instead (`showdownMoveData`, `baseMoveCallbacks`). It also adds
 * the hack's ability and item changes (mod/abilities.ts, mod/items.ts, the field at battle start mod/field.ts). It is read when a dex is installed, not when this module loads, as the mod's
 * modules import this one.
 */
function modExtensions(): Partial<Tables> {
  return {
    Scripts: { ...KAIZO_SCRIPTS, ...KAIZO_MOVE_SCRIPTS, field: KAIZO_FIELD_SCRIPTS },
    Items: { ...KAIZO_ITEMS, ...KAIZO_ITEM_DATA, ...KAIZO_ITEM_PROCS },
    Conditions: { ...KAIZO_ITEM_CONDITIONS, ...KAIZO_FIELD_CONDITIONS, ...KAIZO_CONDITIONS, ...KAIZO_MOVE_CONDITIONS },
    Abilities: { ...KAIZO_ABILITIES, ...KAIZO_ABILITY_CHANGES },
  };
}

/**
 * mod/moves.ts's callbacks laid over Showdown's own move entries of their IDs that no hack move took (the hack's moves
 * get theirs by behaviour source, `showdownMoveData`), so a Showdown move called by ID draws as the hack's do.
 */
function baseMoveCallbacks(moves: Record<string, unknown>, hackMoves: Record<string, Entry>): Record<string, Entry> {
  const entries: Record<string, Entry> = {};
  for (const id of Object.keys(KAIZO_MOVE_CALLBACKS)) {
    const base = moves[id];
    if (isEntry(base) && !Object.hasOwn(hackMoves, id)) entries[id] = { ...base, ...moveCallbacks(id) };
  }
  return entries;
}

const ARCEUS = 493;

/** Arceus's plate formes ("arceusfire"), which Showdown's Gen 4 Arceus changes into on switch-in (data/mods/gen4/conditions.ts). */
const ARCEUS_PLATE_FORMS = GEN4.species.all()
  .filter((species) => species.num === ARCEUS && species.forme !== '' && !species.isNonstandard)
  .map((species) => species.id as string);

/**
 * Showdown formes whose types the battle sets, not the Personal row: Castform's weather forms (Forecast makes it Fire,
 * Water or Ice, pokeplatinum src/battle/battle_lib.c:6327-6353) and Arceus's plate forms (Multitype gives it its
 * plate's type, battle_lib.c:7629-7699). They keep Showdown's types, which are the battle's, and take their base stats
 * and abilities from the species' row.
 */
const BATTLE_TYPED = new Set(['castformsunny', 'castformrainy', 'castformsnowy', ...ARCEUS_PLATE_FORMS]);

/**
 * Each Showdown species entry that a Personal row holds the data of, with that row's index: every species and form in
 * `FORMS` (`personalRowFor`), and Arceus's plate forms (Arceus's row). A cosmetic form such as Unown-B has no entry of
 * its own (Showdown reads its species' entry), so it is left out.
 */
function personalRows(): [string, number][] {
  const rows: [string, number][] = ARCEUS_PLATE_FORMS.map((id) => [id, ARCEUS]);
  for (let species = 1; species <= LAST_SPECIES; species++) {
    for (let form = 0; form < (FORMS[species]?.length ?? 1); form++) rows.push([speciesId(species, form), personalRowFor(species, form)]);
  }
  return rows.filter(([id]) => Object.hasOwn(GEN4.data.Pokedex, id));
}

const PERSONAL_ROWS = personalRows();

const CATEGORIES = { physical: 'Physical', special: 'Special', status: 'Status' } as const;

// The format: singles in the mod, with no rules at all, as the cartridge has no clauses and no team preview.
Dex.formats.rulesetCache.set(toID(KAIZO_FORMAT), new Dex.Format({
  name: '[Gen 4] Plat Kaizo', mod: KAIZO_MOD, gameType: 'singles', effectType: 'Format',
  [`on${TRAINER_ITEM_EVENT}`](this: Battle, pokemon: Pokemon) {
    runTrainerItem(this, pokemon);
  },
  // The cartridge's after-move held-item checks for the pinch items (mod/items.ts: the parameter-0 ones, Micle
  // Berry and the other berries); a move its user couldn't make runs no `AfterMove`, but its `MoveEnd` checks too.
  onAfterMove: pinchAfterMove,
  onMoveAborted: pinchAfterMove,
  // The cartridge's hit-rate formula spends a pending Micle Berry boost before the overrides, the type chart and the
  // immunity abilities (mod/scripts.ts `micleTryMove`); first of every `TryMove` handler.
  onTryMovePriority: 1000,
  onTryMove: micleTryMove,
  // The trainer's field conditions, before the leads' switch-in (mod/field.ts).
  onBattleStart: applyField,
}));

interface Installed { data: LoadedData; moves: Map<number, KaizoMove>; moveNames: Map<number, string>; tables: Tables; digest?: string }
let installed: Installed | null = null;

function current(): Installed {
  if (installed === null) throw new Error('No Kaizo dex is installed: call installKaizoDex first');
  return installed;
}

/**
 * Installs the mod built from `data` and its moves (`buildMoves(data)`), and keeps both for the engine
 * (`installedData`, `installedMoves`). Installing the same data and moves again does nothing; anything else replaces
 * the mod.
 */
export function installKaizoDex(data: LoadedData, moves: Map<number, KaizoMove>): void {
  if (installed?.data === data && installed.moves === moves) return;
  assertItemData(data);
  const moveNames = showdownMoveNames(moves);
  const dex = new Dex.ModdedDex(KAIZO_MOD);
  const tables = buildTables(data, moves, moveNames);
  dex.dataCache = tables as unknown as typeof dex.dataCache;
  dex.gen = GEN4.gen;
  dex.parentMod = 'gen4';
  const hackMoveIds = new Set([...moveNames.values()].map((name) => toID(name) as string));
  const aliasOf = dex.getAlias.bind(dex);
  dex.getAlias = (id) => (hackMoveIds.has(id) ? undefined : aliasOf(id));
  Dex.dexes[KAIZO_MOD] = dex;
  installed = { data, moves, moveNames, tables };
}

/**
 * A short digest of the installed data: the first 12 hex digits of the SHA-256 of the mod's species and move tables
 * (`Pokedex` and `Moves`, as canonical JSON; callbacks, which are Showdown's code, are left out), of each hack move's
 * `unmodelled` and `effectText`, which `unmodelledIn` reads besides the tables, of the held items' hold effects and
 * parameters, and of what EXP and level-ups read: each Personal row's base EXP and growth rate, the
 * growth tables and the learnsets. The engine's id carries it, so a proof names the data it ran on. Throws if no mod is
 * installed.
 */
export function installedDataDigest(): string {
  const mod = current();
  if (mod.digest === undefined) {
    const kaizoMoves = [...mod.moves.values()].sort((a, b) => a.id - b.id)
      .map(({ id, unmodelled, effectText }) => ({ id, unmodelled, effectText }));
    const { rom } = mod.data;
    // The held items' hold effects and parameters are engine behaviour too (mod/itemData.ts), so they are in the digest.
    const hold = rom.items.map((item) => [item.holdEffect ?? null, item.holdParam ?? null]);
    // So are the EXP formula's and the level-up's data (exp.ts, levelUp.ts): a row with no record is null, and so is a
    // learnset the data lacks (canonical JSON writes a hole as null).
    const exp = {
      baseExp: Array.from(rom.species, (record) => record?.baseExp ?? null),
      growthRate: Array.from(rom.species, (record) => record?.growthRate ?? null),
      growth: rom.growth, learnsets: rom.learnsets,
    };
    const data = { Pokedex: mod.tables['Pokedex'], Moves: mod.tables['Moves'], kaizoMoves, hold, exp };
    mod.digest = createHash('sha256').update(canonicalJson(data)).digest('hex').slice(0, 12);
  }
  return mod.digest;
}

/**
 * The identity of the installed mod: a new object for each install that replaced the mod, the same one while it stays
 * (installing the same data and moves again is a no-op). What the engine keeps beside a state (facts.ts) is read under
 * one install; another install makes it stale. Throws if none is installed.
 *
 * It tells installs apart by the `data` and `moves` objects, not their contents: a `KaizoMove` (or the data) edited in
 * place after `installKaizoDex` keeps the token, so what facts.ts kept is not recomputed, and the mod's tables, built at
 * install, don't see the edit either. Install a fresh `buildMoves` result instead of editing one.
 */
export function installToken(): object {
  return current();
}

/** The `LoadedData` the installed mod was built from. Throws if none is installed. */
export function installedData(): LoadedData {
  return current().data;
}

/** `encoreBarredEffects` of the installed moves, or none when no mod is installed (a direct `showdownMoveData` call). */
function installedEncoreBarred(): ReadonlySet<number> {
  return installed === null ? new Set() : encoreBarredEffects(installed.moves);
}

/** The moves the installed mod was built from, by move ID. Throws if none is installed. */
export function installedMoves(): Map<number, KaizoMove> {
  return current().moves;
}

// ---------------------------------------------------------------------------------------------------------------------
// What EXP and level-ups read. pk = pokeplatinum src/pokemon.c.

/** The installed data's Personal row `row`. Throws if no mod is installed or the data has no such row. */
function speciesRecord(row: number): SpeciesRecord {
  const record = current().data.rom.species[row];
  if (record === undefined) throw new Error(`The installed ROM data has no species record ${row}`);
  return record;
}

/**
 * The base EXP yield of species `species` (its National Dex number): Personal byte 0x09 (`SpeciesRecord.baseExp`) of the
 * species' own row, never a form's. `BtlCmd_CalcExpGain` reads it by species ID (`SpeciesData_GetSpeciesValue(species,
 * SPECIES_DATA_BASE_EXP_REWARD)`, battle_script.c:2216), which loads the row of that ID (`SpeciesData_FromMonSpecies`,
 * pk:2283-2291). Throws if no mod is installed or its data has no record for `species`.
 */
export function baseExpOf(species: number): number {
  return speciesRecord(species).baseExp;
}

/** EXP_RATE_COUNT (pokeplatinum generated/exp_rates.txt:9): the growth rates, one table each in pl_growtbl.narc. */
const GROWTH_RATES = 8;
const MAX_LEVEL = 100;

/**
 * The total EXP at each level 0 to 100 of growth rate `rate`, as `Pokemon_GetExpRateBaseExpAt` reads it (pk:2338-2350:
 * member `rate` of pl_growtbl.narc, read whole by `Pokemon_LoadExperienceTableOf`, pk:2332-2336): the installed ROM's
 * table (`RomData.growth`). Data with no growth tables at all (the engine's unit fixtures, other tests' fixtures) gets
 * the vanilla tables instead (`vanillaGrowth`), which are the hack's own: the ROM's eight equal the decompilation's
 * (test/unit/engine/exp.test.ts pins all 808 values and checks them against data/rom where
 * it is present). Only data with no tables at all gets them: data with any has its own read, and a rate it lacks is an
 * error. Real data always has all eight, as `loadLocalData` refuses ROM data without them (src/data/load.ts). Throws if
 * no mod is installed, or for a rate with no table.
 */
export function growthTable(rate: number): readonly number[] {
  const { growth } = current().data.rom;
  const table = growth.length === 0 ? vanillaGrowth(rate) : growth[rate];
  if (table === undefined) throw new Error(`The installed ROM data has no table for growth rate ${rate}`);
  return table;
}

/**
 * The growth table of species `species` (its National Dex number): `growthTable` of the growth rate of the species'
 * own row, never a form's, as `Pokemon_GetSpeciesBaseExpAt` reads it (pk:2327-2330) for `Pokemon_ShouldLevelUp`
 * (pk:3503-3506) and `Pokemon_GetExpToNextLevel` (pk:2313-2320).
 */
export function growthTableOf(species: number): readonly number[] {
  return growthTable(speciesRecord(species).growthRate);
}

const vanillaTables = new Map<number, readonly number[]>();

/**
 * The vanilla growth table of `rate`, or undefined for a rate past EXP_RATE_COUNT: pokeplatinum
 * res/pokemon/.shared/exp_tables.csv, the source of pl_growtbl.narc, one column per `ExpRate` (generated/exp_rates.txt).
 * Written as the formulas that give each of that file's 808 values (all checked), levels 0 and 1 being 0:
 * - medium fast (0), and the two unused rates (6, 7): n³;
 * - erratic (1): ⌊n³(100 − n)/50⌋ to level 50, ⌊n³(150 − n)/100⌋ to 68, ⌊n³⌊(1911 − 10n)/3⌋/500⌋ to 98, then
 *   ⌊n³(160 − n)/100⌋;
 * - fluctuating (2): ⌊n³(⌊(n + 1)/3⌋ + 24)/50⌋ to level 15, ⌊n³(n + 14)/50⌋ to 36, then ⌊n³(⌊n/2⌋ + 32)/50⌋;
 * - medium slow (3): ⌊6n³/5⌋ − 15n² + 100n − 140;
 * - fast (4): ⌊4n³/5⌋; slow (5): ⌊5n³/4⌋.
 * Every product is below 2^53 and every quotient's distance from the next whole number is above a float's error, so the
 * floors are exact.
 */
function vanillaGrowth(rate: number): readonly number[] | undefined {
  if (!Number.isInteger(rate) || rate < 0 || rate >= GROWTH_RATES) return undefined;
  let table = vanillaTables.get(rate);
  if (table === undefined) {
    table = Object.freeze(Array.from({ length: MAX_LEVEL + 1 }, (_, level) => vanillaExpAt(rate, level)));
    vanillaTables.set(rate, table);
  }
  return table;
}

function vanillaExpAt(rate: number, n: number): number {
  if (n <= 1) return 0;
  const cube = n ** 3;
  const floor = Math.floor;
  switch (rate) {
    case 1:
      if (n <= 50) return floor((cube * (100 - n)) / 50);
      if (n <= 68) return floor((cube * (150 - n)) / 100);
      if (n <= 98) return floor((cube * floor((1911 - 10 * n) / 3)) / 500);
      return floor((cube * (160 - n)) / 100);
    case 2:
      if (n <= 15) return floor((cube * (floor((n + 1) / 3) + 24)) / 50);
      if (n <= 36) return floor((cube * (n + 14)) / 50);
      return floor((cube * (floor(n / 2) + 32)) / 50);
    case 3: return floor((6 * cube) / 5) - 15 * n * n + 100 * n - 140;
    case 4: return floor((4 * cube) / 5);
    case 5: return floor((5 * cube) / 4);
    default: return cube;
  }
}

/**
 * The level-up learnset of a Showdown species (a battler's own, `Pokemon.baseSpecies`), with its Personal row: the ROM's
 * (`RomData.learnsets`, wotbl.narc) at the row of its species and form, as `Pokemon_LoadLevelUpMovesOf` reads it
 * (pk:4585-4589: member `Pokemon_GetFormNarcIndex(species, form)`; `personalRowFor`). The form is the one `FORMS` names
 * for the Showdown species' ID; any other Showdown forme (Castform's weather forms, Arceus's plates) uses the species'
 * own row. No moves when the data has none for the row. The engine's one learnset lookup (levelUp.ts reads it). Throws if no mod is installed.
 */
export function learnsetOf(species: { num: number; id: string }): { row: number; moves: readonly LevelUpMove[] } {
  const { num, id } = species;
  const form = (FORMS[num] ?? []).findIndex((_, f) => f > 0 && speciesId(num, f) === id);
  const row = personalRowFor(num, Math.max(form, 0));
  return { row, moves: current().data.rom.learnsets[row] ?? [] };
}

/**
 * The Showdown ID of a hack move in the installed mod: `toID` of its docs name, or of the name with its move ID added
 * when that ID is a lower-numbered move's ("solarbeam130" for Solar-Beam, 130, after SolarBeam, 76). Throws if no
 * mod is installed or the move is not in it.
 */
export function moveId(move: KaizoMove): string {
  const name = current().moveNames.get(move.id);
  if (name === undefined) throw new Error(`Move ${move.id} (${move.name}) is not in the installed Kaizo dex`);
  return toID(name);
}

/**
 * The move IDs whose `basePowerCallback` Showdown's requests call with only the Pokémon, to name the power
 * (sim/pokemon.ts:999-1001, :1176-1178; dist/sim/pokemon.js:650-652, :802-804). A hack move with one of these IDs must
 * keep a callable power callback even as a plain hit: Return and Frustration are plain 121-power hits
 * (ROM effect 0, docs "None").
 */
const REQUEST_POWER_IDS: ReadonlySet<string> = new Set(['return', 'frustration']);

/** A `basePowerCallback` that leaves the power as the data has it: the active move's `basePower`, else `power`. */
function plainPower(power: number) {
  return (_pokemon: Pokemon, _target?: Pokemon, move?: ActiveMove): number => move?.basePower ?? power;
}

/**
 * The behaviour source's Showdown flags that belong to its own mechanics, not to a hit the engine builds from the docs'
 * text: a charge or recharge turn and Showdown's Sleep Talk exclusions. The cartridge decides Sleep Talk's list by move
 * ID and ROM effect (battle_script.c:4907-4939, mod/moves.ts) and Gravity by move ID (`ID_FLAG_LISTS`, which sets
 * `gravity` again after these are dropped).
 */
const SOURCE_MECHANIC_FLAGS = ['charge', 'recharge', 'nosleeptalk', 'gravity'] as const;

/** Showdown targets that aim at a foe (in singles, the one foe). */
const FOE_TARGETS: ReadonlySet<string> = new Set(['normal', 'any', 'adjacentFoe', 'allAdjacentFoes', 'allAdjacent', 'randomNormal']);

/**
 * The ROM's move flag bits the battle code reads, each with the Showdown flag that does the same: generated/
 * move_flags.txt lists them in bit order, `MOVE_FLAG_MAKES_CONTACT` (bit 0; Rough Skin, Aftermath, Sticky Barb read
 * Showdown's `contact`, the chance-based contact abilities the ROM bit itself, mod/procs.ts `contactHit`),
 * `MOVE_FLAG_CAN_PROTECT` (bit 1, bcp:3008), `MOVE_FLAG_CAN_MAGIC_COAT` (bit 2, bcp:3070), `MOVE_FLAG_CAN_SNATCH`
 * (bit 3, bcp:3091) and `MOVE_FLAG_CAN_MIRROR_MOVE` (bit 4, bcp:4480). Bit 5 (King's Rock) is mod/procs.ts's; bits 6
 * and 7 only hide graphics (battle_display.c:6370-6376). So the hack's Sky Attack (base Tackle, ROM flags 50) makes no
 * contact and Mystical Fire (base Swift, ROM flags 115) does, and Mean Look (ROM flags 22) can be protected
 * against where Showdown's can't.
 */
const ROM_FLAG_BITS: readonly (readonly [number, string])[] = [
  [0x01, 'contact'], [0x02, 'protect'], [0x04, 'reflectable'], [0x08, 'snatch'], [0x10, 'mirror'],
];

/**
 * The decompilation's move-ID lists, each with the Showdown flag its readers check (these stay by move ID,
 * as the cartridge has them, so a hack move in one of these slots is on the list whatever it does):
 * - `sPunchingMoves` (bl:6566-6582), Iron Fist's list (bl:6914-6915): Showdown's `punch`;
 * - `sSoundMoves` (bl:3473-3486), Soundproof's list (bl:3523-3530): Showdown's `sound`. Perish Song's own script checks
 *   Soundproof too (subscript_perish_song_start.s:12-17), so its ROM effect keeps `sound` (`SOUND_EFFECTS`);
 * - `sMovesAffectedByGravity` (bl:3385-3392, `Move_FailsInHighGravity`): Showdown's `gravity`;
 * - `sMovesAffectedByHealBlock` (bl:3410-3425, `Move_HealBlocked`): Showdown's `heal`.
 */
const ID_FLAG_LISTS: readonly (readonly [string, ReadonlySet<number>])[] = [
  ['punch', new Set([8, 7, 9, 183, 264, 146, 223, 359, 5, 4, 309, 325, 409, 418, 327])],
  ['sound', new Set([45, 46, 47, 48, 103, 173, 253, 319, 320, 304, 405, 448])],
  ['gravity', new Set([19, 340, 26, 136, 150, 393])],
  ['heal', new Set([105, 135, 156, 208, 234, 235, 236, 256, 456, 303, 355, 461, 361, 273])],
];

/** `BATTLE_EFFECT_ALL_FAINT_3_TURNS` (generated/move_battle_effects.txt), Perish Song's, whose script checks Soundproof. */
const SOUND_EFFECTS: ReadonlySet<number> = new Set([114]);

/** `BATTLE_EFFECT_EVA_UP_2_MINIMIZE`: its subscript leaves the Minimize marker Stomp reads (subscript_minimize.s). */
const MINIMIZE_EFFECT = 108;

/**
 * `sCannotEncoreMoves` (bl:7212-7219): Transform, Mimic, Sketch, Mirror Move, Encore, Struggle. `Move_CanBeEncored`
 * (bl:7221-7232) refuses a move whose ROM effect is one of theirs, so these are compared by the installed ROM's
 * effects (`encoreBarredEffects`).
 */
const CANNOT_ENCORE_IDS: readonly number[] = [144, 102, 166, 119, 227, 165];

/** The ROM effects `Move_CanBeEncored` refuses: those of `CANNOT_ENCORE_IDS` in `moves`. */
function encoreBarredEffects(moves: Map<number, KaizoMove>): ReadonlySet<number> {
  return new Set(CANNOT_ENCORE_IDS.flatMap((id) => { const move = moves.get(id); return move === undefined ? [] : [move.romEffect]; }));
}

/**
 * `flags` (a copy of the behaviour source's) with the ROM's flag bits (`ROM_FLAG_BITS`), the decompilation's move-ID
 * lists (`ID_FLAG_LISTS`) and Encore's ROM-effect rule (Showdown's `failencore`, read by the Encore condition's
 * `onStart`) in place of the source's, for every hack move.
 */
function withRomFlags(flags: Record<string, number>, move: KaizoMove, encoreBarred: ReadonlySet<number>): Record<string, number> {
  for (const [bit, flag] of ROM_FLAG_BITS) {
    if (move.flags & bit) flags[flag] = 1;
    else delete flags[flag];
  }
  for (const [flag, ids] of ID_FLAG_LISTS) {
    if (ids.has(move.id) || (flag === 'sound' && SOUND_EFFECTS.has(move.romEffect))) flags[flag] = 1;
    else delete flags[flag];
  }
  if (encoreBarred.has(move.romEffect)) flags['failencore'] = 1;
  else delete flags['failencore'];
  return flags;
}

/**
 * A hack move's Showdown data, from its docs effect text's `ENGINE_EFFECTS` entry (effects.ts), with the
 * ROM's number, type, category, power, accuracy (0, never misses, is Showdown's `true`), PP and priority, and the docs'
 * name.
 *
 * A table entry (`plain`, `secondary`, `status`, `heal`) builds the behaviour from the text alone: of the behaviour
 * source (`calc.baseMove`) only its flags (less `SOURCE_MECHANIC_FLAGS`), its target (a foe's, or the user's for a
 * self move) and its type-immunity rule are kept; the effect is `behaviourFields`'. So no Showdown callback comes along,
 * but a neutral `basePowerCallback` (`plainPower`) where the source had one or the move's ID is in
 * `REQUEST_POWER_IDS`; a volatile whose Showdown condition lives on its move (Focus Energy's) brings that condition, and
 * Minimize's ROM effect its marker.
 *
 * An `inherit` entry runs the Showdown move it names (Struggle's, and the named mechanics), and an
 * `unmodelled` one (a placeholder, or a text with no entry) keeps the behaviour source: either way the source's
 * Gen 4 data and the mod's draws and overrides for it (mod/moves.ts, some by the move's own ID `id`), with the ROM's
 * effect chance on each secondary effect. A chance of 0 removes them, as the cartridge's probabilistic check never
 * passes at 0 (battle_lib.c:1550-1561, :1570-1580): Twister ("Whirlpool effect", Showdown's Wrap) has none anyway.
 *
 * Every hack move's flags are the ROM's and the decompilation's (`withRomFlags`); `encoreBarred` is
 * `encoreBarredEffects` of the moves being installed.
 *
 * Every hack move also carries two plain strings the native engine reads through Showdown's `Dex`:
 * `kaizoBehaviourKind`, `'inherit'`, `'table'` or `'unmodelled'`, and `kaizoBehaviour`, a Showdown move ID
 * whose meaning follows the kind:
 * - `inherit`: the Showdown move whose behaviour runs (the entry's `from`), with the mod's overrides;
 * - `table`: only the source of the move's flags, target and type-immunity rule (`calc.baseMove`); the behaviour is
 *   `behaviourFields`', built from the docs' text, none of that move's own;
 * - `unmodelled`: the Showdown move that still runs (`calc.baseMove`), which no proof relies on.
 */
export function showdownMoveData(move: KaizoMove, id: string = toID(move.name), encoreBarred: ReadonlySet<number> = installedEncoreBarred()): object {
  const effect = engineEffect(move);
  const behaviour = effect.kind === 'inherit' ? effect.from : move.calc.baseMove;
  const source = GEN4.data.Moves[toID(behaviour)];
  if (source === undefined) throw new Error(`No Gen 4 Showdown move "${behaviour}" for move ${move.id} (${move.name})`);
  const numbers = {
    num: move.id, name: move.name, type: typeName(move.type), category: CATEGORIES[move.category], basePower: move.power,
    accuracy: move.accuracy === 0 ? true : move.accuracy, pp: move.pp, priority: move.priority,
    gen: 4, // every hack move is the cartridge's; Showdown would date moves 468 and up to Gen 5 and mark them Future
  };
  if (!isTableEffect(effect)) {
    const data: Entry = GEN4.deepClone(source);
    // The cartridge's draws and overrides for its behaviour source (mod/moves.ts), some of which name the move's own ID.
    Object.assign(data, moveCallbacks(behaviour, id), numbers);
    withRomChance(data, move.effectChance);
    data.flags = withRomFlags({ ...(source.flags as Record<string, number>) }, move, encoreBarred);
    data.kaizoBehaviour = toID(behaviour);
    data.kaizoBehaviourKind = effect.kind === 'inherit' ? 'inherit' : 'unmodelled';
    return data;
  }
  const flags = { ...(source.flags as Record<string, number>) };
  for (const flag of SOURCE_MECHANIC_FLAGS) delete flags[flag];
  withRomFlags(flags, move, encoreBarred); // after: Heal Block and Gravity go by the move-ID lists
  const self = effect.kind === 'heal' || (effect.kind === 'status' && effect.target === 'self');
  const data: Entry = {
    ...numbers, kaizoBehaviour: toID(behaviour), kaizoBehaviourKind: 'table', flags, target: self ? 'self' : FOE_TARGETS.has(source.target) ? source.target : 'normal',
    ...(source.ignoreImmunity === undefined ? {} : { ignoreImmunity: GEN4.deepClone(source.ignoreImmunity) }),
    ...behaviourFields(effect, move),
  };
  if (source.basePowerCallback !== undefined || REQUEST_POWER_IDS.has(toID(move.name))) data.basePowerCallback = plainPower(move.power);
  const volatile = effect.kind === 'status' ? effect.volatile : undefined;
  const owner = volatile === undefined ? undefined : GEN4.data.Moves[volatile];
  if (owner?.condition !== undefined) data.condition = GEN4.deepClone(owner.condition);
  // Minimize's marker, which Stomp's "2x damage if target has used Minimize" reads: the cartridge sets it by the ROM
  // effect (EVA_UP_2_MINIMIZE, effect_script_0108.s → subscript_minimize.s), whose docs text names only the boost. The
  // `minimize` condition is the mod's (mod/moves.ts `KAIZO_MOVE_CONDITIONS`): a marker only, Stomp doubles its power.
  if (move.romEffect === MINIMIZE_EFFECT && self) data.volatileStatus = 'minimize';
  return data;
}

/** The ROM's effect chance on each of `data`'s secondary effects; a chance of 0 removes them. */
function withRomChance(data: Entry, chance: number): void {
  if (chance === 0) {
    delete data.secondary;
    delete data.secondaries;
    return;
  }
  const secondaries = Array.isArray(data.secondaries) ? data.secondaries as unknown[] : [];
  for (const secondary of [data.secondary, ...secondaries]) {
    if (isEntry(secondary)) secondary.chance = chance;
  }
}

/** The mod's data tables: Showdown's `gen4` tables with the ROM's species, the hack's moves, then `modExtensions()`. */
function buildTables(data: LoadedData, moves: Map<number, KaizoMove>, moveNames: Map<number, string>): Tables {
  const tables: Tables = { ...(GEN4.data as unknown as Tables) };
  const species: Record<string, Entry> = {};
  for (const [id, row] of PERSONAL_ROWS) {
    const record = data.rom.species[row];
    if (record !== undefined) species[id] = personalPatch(id, record, data.names, BATTLE_TYPED.has(id)); // without a row, Showdown's stays
  }
  overlay(tables, { Pokedex: species });
  // Each hack move replaces any Showdown move of its ID whole: its data comes from its behaviour source, not its namesake.
  const hackMoves: Record<string, Entry> = {};
  const encoreBarred = encoreBarredEffects(moves);
  for (const move of moves.values()) {
    const name = moveNames.get(move.id)!;
    hackMoves[toID(name)] = { ...showdownMoveData(move, toID(name), encoreBarred), name };
  }
  tables.Moves = { ...tables.Moves, ...baseMoveCallbacks(tables.Moves ?? {}, hackMoves), ...hackMoves };
  overlay(tables, modExtensions());
  return tables;
}

/**
 * The Pokédex weight (kg) the cartridge gives a battler of Showdown species `id` (src/rom/weights.ts):
 * `BattleSystem_InitBattleMon` (battle_lib.c:145-153) takes the entry at the battler's species ID, so a forme weighs its
 * species' entry (Shaymin-Sky Shaymin's 2.1 kg, where Showdown's own is 5.2), from zukan_data_gira.narc for form 0 and
 * zukan_data.narc for any other form (`Pokedex_SetupGiratina`, pokedex_data_index.c:14-25). The two tables differ only
 * at Giratina, whose other forms' entry is Origin's 650.0 kg. The hack's entries are vanilla's, which are Showdown's
 * base species' weights: the engine's tests check this against the ROM's decoded tables (data/rom/trainer-ai.json),
 * and test/real/aiRom prints where Showdown's own formes differ. Low Kick and Grass Knot read it (mod/moves.ts).
 */
export function pokedexWeightKg(id: string): number {
  const species = GEN4.species.get(id);
  return id === 'giratinaorigin' ? species.weightkg : GEN4.species.get(species.baseSpecies).weightkg;
}

/**
 * A Showdown species entry's fields from a Personal row: base stats, abilities, and types unless `battleTyped`; and
 * the ROM's Pokédex weight of species `id` (`pokedexWeightKg`).
 */
function personalPatch(id: string, row: SpeciesRecord, names: NameIndex, battleTyped: boolean): Entry {
  const { hp, atk, def, spa, spd, spe } = row.baseStats;
  const [first, second] = [...new Set(row.abilities.filter((ability) => ability !== 0))].map((ability) => names.ability(ability));
  return {
    baseStats: { hp, atk, def, spa, spd, spe },
    abilities: second === undefined ? { 0: first ?? 'No Ability' } : { 0: first, 1: second },
    ...(battleTyped ? {} : { types: [...new Set(row.types.map(typeName))] }),
    weightkg: pokedexWeightKg(id),
  };
}

function typeName(type: number): string {
  const name = TYPE_NAMES[type];
  if (name === undefined) throw new Error(`No type ${type}`);
  return name;
}

const isEntry = (value: unknown): value is Entry => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Lays `layer` over `tables`, copying each table it changes so the `gen4` dex keeps its own. An entry merges into the
 * table's entry of the same ID, replacing its top-level fields, as Showdown's `inherit: true` does; any other value
 * (a script function, or an entry the table lacks) is set as it is.
 */
function overlay(tables: Tables, layer: Partial<Tables>): void {
  for (const [name, entries] of Object.entries(layer)) {
    if (entries === undefined) continue;
    const table = (tables[name] = { ...tables[name] });
    for (const [id, entry] of Object.entries(entries)) {
      const base = table[id];
      table[id] = isEntry(base) && isEntry(entry) ? { ...base, ...entry } : entry;
    }
  }
}
