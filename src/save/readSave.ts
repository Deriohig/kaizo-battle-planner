// Reads a Platinum save, DeSmuME `.dsv` or raw `.sav`: strips the footer, picks the newest valid blocks, then decodes
// the party and the 18 boxes. Party Pokémon keep the level, status, current HP and stats in their party data; box
// Pokémon are always healthy, have no stored stats, and their level comes from experience and the species' growth rate.

import type { RomData } from '../rom/extract.js';
import { levelFromExp } from '../rom/growth.js';
import type { Stats } from '../rom/types.js';
import { selectBlocks } from './blocks.js';
import { rawSave } from './dsv.js';
import { BOX_RECORD_SIZE, decodePartyExtra, decodePk4, isEmptyRecord, PARTY_RECORD_SIZE, type Pk4 } from './pk4.js';
import type { StartStatus } from './status.js';
import { readTrainer, type SaveTrainer } from './trainer.js';
import { readTrainerFlags } from './trainerFlags.js';

export type { SaveTrainer } from './trainer.js';

export { SaveError } from '../errors.js';

const PARTY_COUNT = 0x9c;
const PARTY_START = 0xa0;
const PARTY_SLOTS = 6;
const BOXES_START = 4;
const BOX_COUNT = 18;
const BOX_SLOTS = 30;
/** The levels the game stores for a party Pokémon. */
const MIN_LEVEL = 1;
const MAX_LEVEL = 100;

/** Party slots, boxes and box slots all count from 1. */
export type SaveLocation = { kind: 'party'; slot: number } | { kind: 'box'; box: number; slot: number };

/**
 * One Pokémon from the save. A `badChecksum` Pokémon is returned as decoded, garbage and all. `currentHp` and
 * `storedStats` (the stats the game stored, max HP first) are set for party Pokémon only. A party Pokémon (not an egg)
 * whose stored level is outside 1–100 is `badChecksum` too: the checksum does not cover the party data, and the game
 * never stores such a level, so only a corrupt or crafted record holds one.
 */
export interface SaveMon extends Pk4 { location: SaveLocation; level: number; status: StartStatus; currentHp?: number; storedStats?: Stats }

/**
 * `partition` and `saveCounter` belong to the general block read. Empty slots are left out. `defeatedTrainers` holds the
 * ROM trainer indexes whose trainer-defeated flag is set (`readTrainerFlags`).
 */
export interface SaveData { partition: 0 | 1; saveCounter: number; trainer: SaveTrainer; party: SaveMon[]; boxes: SaveMon[]; defeatedTrainers: ReadonlySet<number> }

/**
 * The language of the game, as the cartridge's ROM holds it: a Pokémon whose `language` is not this one gets 1.7 times the
 * EXP when it is not the player's own. It is the byte at arm9 address `GAME_LANGUAGE_ADDRESS`
 * (file offset 0x4000 + 0xE4C44 in the stock arm9 layout); `test:real` reads it from `PK_ROM`. 2 is English.
 */
export const GAME_LANGUAGE = 2;
export const GAME_LANGUAGE_ADDRESS = 0x020e4c44;

/** Boxes 15–18 hold the dead, as in PKCalc. */
export const DEFAULT_GRAVEYARD_BOXES = [15, 16, 17, 18];

/** Decodes a save file. Throws `SaveError`: `BAD_SIZE` for a file of the wrong size, `EMPTY_SAVE` for a wiped save, `NO_VALID_SAVE` if neither partition is valid. */
export function readSave(file: Uint8Array, rom: Pick<RomData, 'species' | 'growth'>): SaveData {
  const { partition, saveCounter, general, storage } = selectBlocks(rawSave(file));
  return {
    partition, saveCounter, trainer: readTrainer(general), party: readParty(general), boxes: readBoxes(storage, rom),
    defeatedTrainers: readTrainerFlags(general),
  };
}

/** Why a Pokémon cannot fight. */
export type IneligibleReason = 'dead' | 'fainted' | 'egg' | 'over cap' | 'bad checksum';

/**
 * Why `m` cannot fight, in this order: in a graveyard box, fainted (a party Pokémon at exactly 0 HP: in a nuzlocke it is
 * dead even before it is boxed; box Pokémon have no stored HP, so never), an egg, over the level cap (never when
 * `levelCap` is left out), a bad checksum. Empty for a Pokémon that can fight.
 */
export function ineligibleReasons(m: SaveMon, opts: { graveyardBoxes: number[]; levelCap?: number }): IneligibleReason[] {
  const reasons: IneligibleReason[] = [];
  if (m.location.kind === 'box' && opts.graveyardBoxes.includes(m.location.box)) reasons.push('dead');
  if (m.location.kind === 'party' && m.currentHp === 0) reasons.push('fainted');
  if (m.isEgg) reasons.push('egg');
  if (opts.levelCap !== undefined && m.level > opts.levelCap) reasons.push('over cap');
  if (m.badChecksum) reasons.push('bad checksum');
  return reasons;
}

/** True for a Pokémon that can fight: not in a graveyard box, not fainted, not an egg, at or under the level cap, checksum good. */
export function isEligible(m: SaveMon, opts: { graveyardBoxes: number[]; levelCap: number }): boolean {
  return ineligibleReasons(m, opts).length === 0;
}

function readParty(general: Uint8Array): SaveMon[] {
  const count = Math.min(new DataView(general.buffer, general.byteOffset, general.byteLength).getUint32(PARTY_COUNT, true), PARTY_SLOTS);
  const party: SaveMon[] = [];
  for (let slot = 1; slot <= count; slot++) {
    const start = PARTY_START + (slot - 1) * PARTY_RECORD_SIZE;
    const record = general.subarray(start, start + PARTY_RECORD_SIZE);
    if (isEmptyRecord(record)) continue;
    const mon = decodePk4(record);
    const extra = decodePartyExtra(record);
    const levelFits = mon.isEgg || (extra.level >= MIN_LEVEL && extra.level <= MAX_LEVEL);
    party.push({ location: { kind: 'party', slot }, ...mon, ...extra, badChecksum: mon.badChecksum || !levelFits });
  }
  return party;
}

function readBoxes(storage: Uint8Array, rom: Pick<RomData, 'species' | 'growth'>): SaveMon[] {
  const boxes: SaveMon[] = [];
  for (let box = 1; box <= BOX_COUNT; box++) {
    for (let slot = 1; slot <= BOX_SLOTS; slot++) {
      const start = BOXES_START + ((box - 1) * BOX_SLOTS + slot - 1) * BOX_RECORD_SIZE;
      const record = storage.subarray(start, start + BOX_RECORD_SIZE);
      if (isEmptyRecord(record)) continue;
      const mon = decodePk4(record);
      boxes.push({ location: { kind: 'box', box, slot }, ...mon, level: boxLevel(mon, rom), status: { kind: 'none' } });
    }
  }
  return boxes;
}

/** The level for the Pokémon's experience, or 0 for a species the ROM lacks (only a bad checksum record has one). */
function boxLevel(mon: Pk4, rom: Pick<RomData, 'species' | 'growth'>): number {
  const species = rom.species[mon.species];
  return species === undefined ? 0 : levelFromExp(rom.growth, species.growthRate, mon.exp);
}
