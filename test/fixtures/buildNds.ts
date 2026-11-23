// Builds a minimal NDS image for tests: a header, a file name table (FNT), a file allocation table (FAT)
// and the file bytes.

const HEADER_SIZE = 0x200;
const DIR_ID = 0xf000;

interface Dir {
  index: number;
  parent: number;
  /** Files and subdirectories, in sub-table order. */
  entries: Map<string, Dir | Uint8Array>;
}

/** An NDS image holding `files`, keyed by path such as `a/b/c.bin`. */
export function buildNds(files: Record<string, Uint8Array>, gameCode = 'JAK7'): Uint8Array {
  const dirs = buildTree(files);
  const fnt = buildFnt(dirs);
  // File IDs run directory by directory, in entry order, matching buildFnt.
  const contents = dirs.flatMap((dir) => [...dir.entries.values()].filter((entry) => entry instanceof Uint8Array));

  const fatStart = HEADER_SIZE + fnt.length;
  const dataStart = fatStart + contents.length * 8;
  const rom = new Uint8Array(dataStart + contents.reduce((total, bytes) => total + bytes.length, 0));
  const view = new DataView(rom.buffer);

  rom.set(ascii(gameCode), 0x0c);
  view.setUint32(0x40, HEADER_SIZE, true);
  view.setUint32(0x44, fnt.length, true);
  view.setUint32(0x48, fatStart, true);
  view.setUint32(0x4c, contents.length * 8, true);
  rom.set(fnt, HEADER_SIZE);

  let offset = dataStart;
  contents.forEach((bytes, fileId) => {
    view.setUint32(fatStart + fileId * 8, offset, true);
    view.setUint32(fatStart + fileId * 8 + 4, offset + bytes.length, true);
    rom.set(bytes, offset);
    offset += bytes.length;
  });
  return rom;
}

/** All directories, root first, each indexed by its position in the list. */
function buildTree(files: Record<string, Uint8Array>): Dir[] {
  const root: Dir = { index: 0, parent: 0, entries: new Map() };
  const dirs = [root];
  for (const [path, bytes] of Object.entries(files)) {
    const names = path.split('/');
    const fileName = names.pop()!;
    let dir = root;
    for (const name of names) {
      const existing = dir.entries.get(name);
      if (existing && !(existing instanceof Uint8Array)) {
        dir = existing;
      } else {
        const child: Dir = { index: dirs.length, parent: dir.index, entries: new Map() };
        dir.entries.set(name, child);
        dirs.push(child);
        dir = child;
      }
    }
    dir.entries.set(fileName, bytes);
  }
  return dirs;
}

/** The main table (u32 sub-table offset, u16 first file ID, u16 parent) followed by the sub-tables. */
function buildFnt(dirs: Dir[]): Uint8Array {
  const mainTable: number[] = [];
  const subTables: number[] = [];
  let firstFileId = 0;
  for (const dir of dirs) {
    pushU32(mainTable, dirs.length * 8 + subTables.length);
    pushU16(mainTable, firstFileId);
    // The root's parent field holds the directory count instead.
    pushU16(mainTable, dir.index === 0 ? dirs.length : DIR_ID | dir.parent);
    for (const [name, entry] of dir.entries) {
      if (entry instanceof Uint8Array) {
        subTables.push(name.length, ...ascii(name));
        firstFileId++;
      } else {
        subTables.push(0x80 | name.length, ...ascii(name));
        pushU16(subTables, DIR_ID | entry.index);
      }
    }
    subTables.push(0);
  }
  return Uint8Array.from([...mainTable, ...subTables]);
}

function pushU16(out: number[], value: number): void {
  out.push(value & 0xff, (value >> 8) & 0xff);
}

function pushU32(out: number[], value: number): void {
  pushU16(out, value & 0xffff);
  pushU16(out, value >>> 16);
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}
