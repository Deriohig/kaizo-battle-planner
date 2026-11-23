// The player's side: battle-ready Pokémon from the save, and the team the planner may fight with.

import { personalRowFor } from '../rom/forms.js';
import { computeStats } from '../rom/stats.js';
import type { Stats } from '../rom/types.js';
import { GAME_LANGUAGE, isEligible, type SaveData, type SaveLocation, type SaveMon, type SaveTrainer } from '../save/readSave.js';
import type { StartStatus } from '../save/status.js';
import type { BattleMon, LoadedData } from './types.js';

/**
 * One of the player's Pokémon as the planner uses it: the `BattleMon` fields, so the calc treats both sides alike, plus
 * what only the save knows.
 * - Level, IVs, EVs, item, moves, gender, nature (`pid % 25`) and ability ID come from the save; nature and ability are
 *   never disputed, so they have no alternatives.
 * - `pp` and `ppUps` line up with `moves`, entry k for move k.
 * - `status` and `currentHp` are the save's for a party Pokémon. A box Pokémon has no status and full HP, as the PC
 *   heals it.
 * - `notes` holds what a reader should know about the save's data: stored party stats that differ from the stat formula's.
 */
export interface PlayerMon extends BattleMon {
  nickname: string; status: StartStatus; currentHp: number; pp: number[]; ppUps: number[]; location: SaveLocation; notes: string[];
  /**
   * The save's experience points; absent for a Pokémon not read from a save. The engine starts the Pokémon's EXP from
   * it. When it does not fit `level` (a what-if level), the engine starts from the level's own
   * total, as a Rare Candy leaves it.
   */
  exp?: number;
  /**
   * Whose Pokémon the cartridge takes it for when it gives EXP (`BattleSystem_PokemonIsOT`, pokeplatinum src/battle/battle_lib.c:6286-6302): 'own' when its OT
   * ID (trainer ID and secret ID), OT gender and OT name are the save's trainer's; else 'traded' when its language is
   * the game's, 'tradedOtherLanguage' when not. A traded Pokémon gets 1.5 times the EXP, one of another language 1.7
   * times. Absent means 'own'.
   */
  origin?: 'own' | 'traded' | 'tradedOtherLanguage';
}

const STAT_LABELS: Record<keyof Stats, string> = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

/** A note naming each stat the game stored differently from the formula, or null when they all match. */
function storedStatsNote(stored: Stats, computed: Stats): string | null {
  const differ = (Object.keys(STAT_LABELS) as (keyof Stats)[]).filter((key) => stored[key] !== computed[key]);
  if (differ.length === 0) return null;
  const parts = differ.map((key) => `${STAT_LABELS[key]} ${stored[key]} stored, ${computed[key]} computed`);
  return `Stored stats differ from the formula's: ${parts.join('; ')}. The planner uses the computed stats.`;
}

/** What the origin rule reads of the save's trainer. */
export type OriginTrainer = Pick<SaveTrainer, 'id' | 'gender' | 'nameCodes'>;

/** The terminator of a Gen 4 name. */
const NAME_END = 0xffff;
/** TRAINER_NAME_LEN (pokeplatinum include/constants/string.h:5). */
const TRAINER_NAME_LEN = 7;

/**
 * `CharCode_CompareNumChars(a, b, TRAINER_NAME_LEN)` (charcode_util.c:87-103) over raw codes, true when it returns 0. It
 * tests that the two codes are equal before it tests the count, so with `num` 7 it compares 8 codes (the 8th is the
 * terminator of a 7-letter name), and it stops early at a terminator both names have. Anything after that is not read.
 */
function sameNameCodes(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0, num = TRAINER_NAME_LEN; (a[i] ?? NAME_END) === (b[i] ?? NAME_END); i++, num--) {
    if (num === 0 || (a[i] ?? NAME_END) === NAME_END) return true;
  }
  return false;
}

/**
 * `PlayerMon.origin` for save Pokémon `m`, by `BattleSystem_PokemonIsOT` (battle_lib.c:6286-6302): 'own' when its OT ID,
 * OT gender and OT name equal the trainer's (names compared as raw codes, `sameNameCodes`); else 'traded' when its
 * language is the game's, 'tradedOtherLanguage' when not.
 */
export function monOrigin(m: Pick<SaveMon, 'otId' | 'otGender' | 'otName' | 'language'>, trainer: OriginTrainer): NonNullable<PlayerMon['origin']> {
  if (m.otId === trainer.id && m.otGender === trainer.gender && sameNameCodes(trainer.nameCodes, m.otName)) return 'own';
  return m.language === GAME_LANGUAGE ? 'traded' : 'tradedOtherLanguage';
}

/**
 * The battle-ready form of save Pokémon `m`. Base stats and types come from the ROM's Personal row for its species and
 * form (`personalRowFor`), its name from the docs. Stats are always the formula's (`computeStats`): a party Pokémon's
 * stored stats only add a note where they differ. A party Pokémon without a stored current HP is at full HP. A
 * cosmetic form (a Mothim's Burmy cloak, an Arceus plate form) has the species' row and name. Throws for
 * a species record or species name the data lacks, and for an unknown form of a species whose forms change its stats
 * (`personalRowFor`), so such a form fails loudly, as on the trainer side, and so does `eligibleTeam` when that
 * Pokémon is eligible. `trainer` (the save's, `SaveData.trainer`) is required: it sets `origin` (`monOrigin`), and a
 * caller without it would read every traded Pokémon as its own, with the wrong EXP.
 */
export function toPlayerMon(m: SaveMon, data: LoadedData, trainer: OriginTrainer): PlayerMon {
  const row = personalRowFor(m.species, m.form);
  const record = data.rom.species[row];
  if (record === undefined) throw new Error(`The ROM has no species record ${row}`);
  const computed = computeStats(record.baseStats, m.ivs, m.evs, m.level, m.nature);
  const inParty = m.location.kind === 'party';
  const note = m.storedStats === undefined ? null : storedStatsNote(m.storedStats, computed);
  return {
    species: m.species, form: m.form, name: data.names.species(m.species, m.form), nickname: m.nickname, level: m.level,
    gender: m.gender, ivs: { ...m.ivs }, evs: { ...m.evs },
    nature: { value: m.nature, source: 'rom', disputed: false, alternatives: [] },
    ability: { value: m.ability, source: 'rom', disputed: false, alternatives: [] },
    item: m.item, moves: [...m.moves], pp: [...m.pp], ppUps: [...m.ppUps],
    baseStats: { ...record.baseStats }, types: [...record.types], friendship: m.friendship,
    status: inParty ? { ...m.status } : { kind: 'none' }, currentHp: inParty ? m.currentHp ?? computed.hp : computed.hp,
    location: { ...m.location }, notes: note === null ? [] : [note], exp: m.exp,
    origin: monOrigin(m, trainer),
  };
}

/** The most a what-if level may be. */
export const MAX_LEVEL = 100;

/**
 * `mon` at a what-if level (docs/what-if-levels.md): for planning only, the save is not touched, and `mon` is not changed.
 * Its stats are the formula's from its own base stats, IVs, EVs and nature at `level` (every consumer computes them from
 * `level`, so setting it is the recompute). Max HP is the formula's at `level`, and current HP goes up by the max HP
 * gained, as the cartridge does on a level-up (a fainted Pokémon stays fainted; never over max HP). EVs stay the save's,
 * so real level-ups, which usually add some, would make the real Pokémon slightly stronger. The moves, PP, item,
 * ability, status and friendship are the save's: no level-up move is learned and nothing evolves. The note about stored
 * stats is the save's level's, so it goes at another level. At its own level `mon` comes back as an equal copy.
 * Throws RangeError for a level that is not a whole number from 1 to 100.
 */
export function atLevel(mon: PlayerMon, level: number): PlayerMon {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) throw new RangeError(`A level is a whole number from 1 to ${MAX_LEVEL}, not ${level}`);
  const maxHpAt = (at: number) => computeStats(mon.baseStats, mon.ivs, mon.evs, at, mon.nature.value ?? 0).hp;
  const gained = maxHpAt(level) - maxHpAt(mon.level);
  return {
    ...mon, level,
    ivs: { ...mon.ivs }, evs: { ...mon.evs }, baseStats: { ...mon.baseStats }, types: [...mon.types],
    nature: { ...mon.nature, alternatives: [...mon.nature.alternatives] }, ability: { ...mon.ability, alternatives: [...mon.ability.alternatives] },
    moves: [...mon.moves], pp: [...mon.pp], ppUps: [...mon.ppUps], status: { ...mon.status }, location: { ...mon.location },
    currentHp: mon.currentHp <= 0 ? 0 : Math.max(1, Math.min(maxHpAt(level), mon.currentHp + gained)),
    notes: level === mon.level ? [...mon.notes] : [],
  };
}

/** Where a location sorts: party slots before every box (boxes count from 1), then boxes by box and slot. */
function locationKey(location: SaveLocation): [number, number] {
  return location.kind === 'party' ? [0, location.slot] : [location.box, location.slot];
}

function locationOrder(a: SaveLocation, b: SaveLocation): number {
  const [[boxA, slotA], [boxB, slotB]] = [locationKey(a), locationKey(b)];
  return boxA - boxB || slotA - slotB;
}

/**
 * The Pokémon the player may fight with: every party and box Pokémon `isEligible` accepts (not in a graveyard box, not
 * fainted, not an egg, at or under the level cap, checksum good), party first, then the boxes in box and slot order.
 */
export function eligibleTeam(save: Pick<SaveData, 'party' | 'boxes'> & { trainer: OriginTrainer }, data: LoadedData, opts: { graveyardBoxes: number[]; levelCap: number }): PlayerMon[] {
  return [...save.party, ...save.boxes]
    .filter((m) => isEligible(m, opts))
    .sort((a, b) => locationOrder(a.location, b.location))
    .map((m) => toPlayerMon(m, data, save.trainer));
}
