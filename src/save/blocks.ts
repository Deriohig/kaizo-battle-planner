// Picks the blocks to read from a raw save. The save holds two partitions, at 0x0 and 0x40000, each a general block
// followed by a storage block. Every block ends in a 0x14-byte footer: u32 link ID, u32 save counter, u32 block size,
// u32 magic, u16 block ID, then the u16 CRC-16-CCITT of the block without its footer.

import { SaveError } from '../errors.js';
import { crc16Ccitt } from './crc16.js';

const PARTITIONS = [0, 1] as const;
const PARTITION_SIZE = 0x40000;
const GENERAL_SIZE = 0xcf2c;
const STORAGE_SIZE = 0x121e4;
const FOOTER_SIZE = 0x14;
const MAGIC = 0x20060623;

/** The blocks to read. `partition` and `saveCounter` are the general block's. */
export interface SaveBlocks { partition: 0 | 1; saveCounter: number; general: Uint8Array; storage: Uint8Array }

interface Block { partition: 0 | 1; bytes: Uint8Array; linkId: number; counter: number }

/**
 * Takes the valid general block with the highest save counter, paired with the valid storage block that shares its
 * link ID (the newer one if both partitions do). A general block with no such storage block is skipped for the next.
 * Throws `SaveError` `EMPTY_SAVE` for a wiped save (both partitions all 0xFF, as after the game's save reset and
 * before the first in-game save), and `NO_VALID_SAVE` when no pair is left otherwise.
 */
export function selectBlocks(save: Uint8Array): SaveBlocks {
  if (save.subarray(0, 2 * PARTITION_SIZE).every((byte) => byte === 0xff)) {
    throw new SaveError('EMPTY_SAVE', 'The save is empty: the game has not been saved since it was reset. Save once in-game and the planner reads it.');
  }
  const generals = validBlocks(save, 0, GENERAL_SIZE).sort((a, b) => b.counter - a.counter);
  const storages = validBlocks(save, GENERAL_SIZE, STORAGE_SIZE);
  for (const general of generals) {
    const own = (block: Block) => Number(block.partition === general.partition);
    const [storage] = storages.filter((block) => block.linkId === general.linkId).sort((a, b) => b.counter - a.counter || own(b) - own(a));
    if (storage !== undefined) {
      return { partition: general.partition, saveCounter: general.counter, general: general.bytes, storage: storage.bytes };
    }
  }
  throw new SaveError('NO_VALID_SAVE', 'Neither save partition holds a valid general block with a matching storage block');
}

/** The blocks at `start` in each partition whose footer has the right size and magic and whose CRC matches. */
function validBlocks(save: Uint8Array, start: number, size: number): Block[] {
  return PARTITIONS.flatMap((partition) => {
    const offset = partition * PARTITION_SIZE + start;
    const bytes = save.subarray(offset, offset + size);
    const footer = new DataView(bytes.buffer, bytes.byteOffset + size - FOOTER_SIZE, FOOTER_SIZE);
    const valid = footer.getUint32(8, true) === size
      && footer.getUint32(12, true) === MAGIC
      && footer.getUint16(18, true) === crc16Ccitt(bytes.subarray(0, size - FOOTER_SIZE));
    return valid ? [{ partition, bytes, linkId: footer.getUint32(0, true), counter: footer.getUint32(4, true) }] : [];
  });
}
