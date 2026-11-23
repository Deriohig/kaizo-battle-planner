// Reads the NDS cartridge file system: the file name table (FNT) and file allocation table (FAT).

const GAME_CODE_OFFSET = 0x0c;
const FNT_OFFSET = 0x40;
const FAT_OFFSET = 0x48;
const ROOT_DIR_ID = 0xf000;
const DIR_INDEX_MASK = 0x0fff;
const DIR_FLAG = 0x80;
const NAME_LENGTH_MASK = 0x7f;

/** The four-character game code from the header, such as `CPUE`. */
export function readGameCode(rom: Uint8Array): string {
  return String.fromCharCode(...rom.subarray(GAME_CODE_OFFSET, GAME_CODE_OFFSET + 4));
}

/**
 * Every file in the cartridge file system, keyed by path (such as `poketool/trainer/trdata.narc`).
 * The values are views into `rom`, not copies.
 */
export function readNdsFiles(rom: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const fntStart = view.getUint32(FNT_OFFSET, true);
  const fatStart = view.getUint32(FAT_OFFSET, true);
  const files = new Map<string, Uint8Array>();

  const readDir = (dirId: number, prefix: string): void => {
    // Main table entry: u32 sub-table offset, u16 first file ID, u16 parent.
    const entry = fntStart + (dirId & DIR_INDEX_MASK) * 8;
    let pos = fntStart + view.getUint32(entry, true);
    let fileId = view.getUint16(entry + 4, true);

    // Sub-table entries: a length byte (0 ends the table, bit 0x80 marks a directory), then the name.
    for (let lengthByte = view.getUint8(pos); lengthByte !== 0; lengthByte = view.getUint8(pos)) {
      const nameEnd = pos + 1 + (lengthByte & NAME_LENGTH_MASK);
      const name = String.fromCharCode(...rom.subarray(pos + 1, nameEnd));
      pos = nameEnd;
      if (lengthByte & DIR_FLAG) {
        readDir(view.getUint16(pos, true), `${prefix}${name}/`);
        pos += 2;
      } else {
        // FAT entry: u32 start, u32 end.
        const fatEntry = fatStart + fileId * 8;
        files.set(prefix + name, rom.subarray(view.getUint32(fatEntry, true), view.getUint32(fatEntry + 4, true)));
        fileId++;
      }
    }
  };

  readDir(ROOT_DIR_ID, '');
  return files;
}
