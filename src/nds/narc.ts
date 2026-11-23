// Reads NARC archives: the bundles of numbered files (such as one record per trainer) in the cartridge file system.

import { RomError } from '../errors.js';

const HEADER_SIZE_OFFSET = 0x0c;
const CHUNK_HEADER_SIZE = 8;

/** The files in a NARC archive, in order. The values are views into `data`, not copies. */
export function readNarc(data: Uint8Array): Uint8Array[] {
  expectMagic(data, 0, 'NARC');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // BTAF: u32 chunk size, u16 count, u16 reserved, then count × (u32 start, u32 end).
  const btafStart = view.getUint16(HEADER_SIZE_OFFSET, true);
  expectMagic(data, btafStart, 'BTAF');
  const count = view.getUint16(btafStart + 8, true);

  // BTNF (the file names) is skipped by its size. In GMIF, offsets are relative to the data after the chunk header.
  const btnfStart = btafStart + view.getUint32(btafStart + 4, true);
  expectMagic(data, btnfStart, 'BTNF');
  const gmifStart = btnfStart + view.getUint32(btnfStart + 4, true);
  expectMagic(data, gmifStart, 'GMIF');
  const dataStart = gmifStart + CHUNK_HEADER_SIZE;

  return Array.from({ length: count }, (_, index) => {
    const entry = btafStart + 12 + index * 8;
    return data.subarray(dataStart + view.getUint32(entry, true), dataStart + view.getUint32(entry + 4, true));
  });
}

function expectMagic(data: Uint8Array, offset: number, magic: string): void {
  const found = String.fromCharCode(...data.subarray(offset, offset + 4));
  if (found !== magic) {
    throw new RomError('BAD_FORMAT', `Not a NARC archive: expected ${magic} at 0x${offset.toString(16)}`);
  }
}
