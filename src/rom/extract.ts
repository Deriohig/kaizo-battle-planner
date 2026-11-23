// Extracts everything the planner needs from a Platinum Kaizo ROM: checks the game code, finds the data NARCs,
// checks their record sizes and decodes every record. Failures in the file system, NARC and record decoders all
// come out as RomError, naming the file (and record) at fault.

import { RomError } from '../errors.js';
import { readNarc } from '../nds/narc.js';
import { readGameCode, readNdsFiles } from '../nds/ndsFs.js';
import { decodeGrowth } from './growth.js';
import { decodeItem, ITEM_COUNT, ITEM_DATA_ENTRIES, ITEM_DATA_STRIDE, type ItemRecord, itemDataEntry } from './items.js';
import { decodeLearnset } from './learnsets.js';
import { decodeMove } from './moves.js';
import { decodePersonal } from './personal.js';
import { decodeTrainer, type RomTrainer } from './trainers.js';
import type { LevelUpMove, MoveRecord, SpeciesRecord } from './types.js';

/**
 * The version of `RomData`'s shape, saved in `romdata.json` so that `loadLocalData` can reject a file an older extract
 * wrote. Raise it whenever that shape changes. Version 2 added `items`; version 4 added each item's hold effect and parameter; version 5 added each species' `baseExp` and `evYield`.
 */
export const ROM_SCHEMA_VERSION = 5;

/**
 * The decoded ROM. `species`, `learnsets` and `moves` are indexed by ROM ID, `trainers` by trainer index, `items` by
 * item ID (0 to 467, each from the item-data entry the cartridge reads for it, `itemDataEntry`), and
 * `growth[rate][level]` is the total experience needed at that level.
 */
export interface RomData {
  schemaVersion: typeof ROM_SCHEMA_VERSION;
  gameCode: 'JAK7';
  species: SpeciesRecord[];
  learnsets: LevelUpMove[][];
  moves: MoveRecord[];
  growth: number[][];
  trainers: RomTrainer[];
  items: ItemRecord[];
}

const GAME_CODE = 'JAK7';

const PERSONAL = 'poketool/personal/pl_personal.narc';
const LEARNSETS = 'poketool/personal/wotbl.narc';
const MOVES = 'poketool/waza/pl_waza_tbl.narc';
const GROWTH = 'poketool/personal/pl_growtbl.narc';
const TRDATA = 'poketool/trainer/trdata.narc';
const TRPOKE = 'poketool/trainer/trpoke.narc';
const ITEM_DATA = 'itemtool/itemdata/pl_item_data.narc';

const PERSONAL_SIZE = 44;
const MOVE_SIZE = 16;
const GROWTH_SIZE = 404;
const TRDATA_SIZE = 20;

/** Decodes a Platinum Kaizo ROM. Throws `RomError`: `WRONG_ROM` unless the game code is JAK7, `MISSING_FILE`, or `BAD_FORMAT`. */
export function extractRomData(rom: Uint8Array): RomData {
  const gameCode = readGameCode(rom);
  if (gameCode !== GAME_CODE) {
    throw new RomError('WRONG_ROM', `Expected Platinum Kaizo (game code ${GAME_CODE}), found game code ${JSON.stringify(gameCode)}`);
  }

  let files: Map<string, Uint8Array>;
  try {
    files = readNdsFiles(rom);
  } catch (error) {
    throw new RomError('BAD_FORMAT', `Cannot read the ROM file system: ${messageOf(error)}`);
  }

  /** The records of the NARC at `path`, each checked to be `size` bytes when a size is given. */
  const records = (path: string, size?: number): Uint8Array[] => {
    const file = files.get(path);
    if (file === undefined) throw new RomError('MISSING_FILE', `The ROM has no ${path}`);
    let narc: Uint8Array[];
    try {
      narc = readNarc(file);
    } catch (error) {
      throw new RomError('BAD_FORMAT', `${path}: ${messageOf(error)}`);
    }
    narc.forEach((rec, index) => {
      if (size !== undefined && rec.length !== size) {
        throw new RomError('BAD_FORMAT', `${path} record ${index} is ${rec.length} bytes, not ${size}`);
      }
    });
    return narc;
  };

  const species = decodeEach(PERSONAL, records(PERSONAL, PERSONAL_SIZE), (rec, id) => decodePersonal(id, rec));
  const learnsets = decodeEach(LEARNSETS, records(LEARNSETS), (rec) => decodeLearnset(rec));
  const moves = decodeEach(MOVES, records(MOVES, MOVE_SIZE), (rec, id) => decodeMove(id, rec));
  const growth = decodeEach(GROWTH, records(GROWTH, GROWTH_SIZE), (rec) => decodeGrowth(rec));

  // Trainer i is header i of trdata.narc plus party i of trpoke.narc. Headers are size-checked, so a decode
  // failure lies in the party record.
  const headers = records(TRDATA, TRDATA_SIZE);
  const parties = records(TRPOKE);
  if (parties.length !== headers.length) {
    throw new RomError('BAD_FORMAT', `${TRPOKE} and ${TRDATA} differ in record count (${parties.length} and ${headers.length})`);
  }
  const trainers = decodeEach(TRPOKE, parties, (party, index) => decodeTrainer(index, headers[index]!, party));
  const items = decodeItems(records(ITEM_DATA));

  return { schemaVersion: ROM_SCHEMA_VERSION, gameCode: GAME_CODE, species, learnsets, moves, growth, trainers, items };
}

/**
 * Every item, by item ID, from the item data's entries. The battle loads the entries as one table from the start of
 * entry 0, `sizeof(ItemData)` bytes apart (`ItemTable_Load` and `ItemTable_Index`, pokeplatinum src/item.c:394-403),
 * so each entry must be 34 or 36 bytes and start 36 bytes after the one before it, as the NARC's 4-byte padding lays
 * them out; and the entry count must be the one the cartridge's item ID map reads (`itemDataEntry`). Anything else
 * throws `BAD_FORMAT`.
 */
function decodeItems(entries: Uint8Array[]): ItemRecord[] {
  if (entries.length !== ITEM_DATA_ENTRIES) {
    throw new RomError('BAD_FORMAT', `${ITEM_DATA} has ${entries.length} entries, not ${ITEM_DATA_ENTRIES}`);
  }
  const start = entries[0]!.byteOffset;
  entries.forEach((entry, index) => {
    if (entry.length !== 34 && entry.length !== ITEM_DATA_STRIDE) {
      throw new RomError('BAD_FORMAT', `${ITEM_DATA} entry ${index} is ${entry.length} bytes, not 34 or ${ITEM_DATA_STRIDE}`);
    }
    if (entry.byteOffset - start !== index * ITEM_DATA_STRIDE) {
      throw new RomError('BAD_FORMAT', `${ITEM_DATA} entry ${index} does not start ${index * ITEM_DATA_STRIDE} bytes after entry 0`);
    }
  });
  return Array.from({ length: ITEM_COUNT }, (_, id) => {
    try {
      return decodeItem(id, entries[itemDataEntry(id)]!);
    } catch (error) {
      throw new RomError('BAD_FORMAT', `${ITEM_DATA}: ${messageOf(error)}`);
    }
  });
}

/** Decodes each record, turning any failure into `BAD_FORMAT` naming the file and record index. */
function decodeEach<T>(path: string, records: Uint8Array[], decode: (rec: Uint8Array, index: number) => T): T[] {
  return records.map((rec, index) => {
    try {
      return decode(rec, index);
    } catch (error) {
      throw new RomError('BAD_FORMAT', `${path} record ${index}: ${messageOf(error)}`);
    }
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
