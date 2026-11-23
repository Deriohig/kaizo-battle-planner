// Builds a minimal NARC archive for tests: a header, a file allocation chunk (BTAF), a minimal file name
// chunk (BTNF) and the file image chunk (GMIF). As in real archives, files are padded to 4 bytes with 0xFF.

const HEADER_SIZE = 0x10;
const CHUNK_HEADER_SIZE = 8;
const BTNF_SIZE = 0x10;

/** A NARC archive holding `files`, in order. */
export function buildNarc(files: Uint8Array[]): Uint8Array {
  const btafSize = CHUNK_HEADER_SIZE + 4 + files.length * 8;
  const btnfStart = HEADER_SIZE + btafSize;
  const gmifStart = btnfStart + BTNF_SIZE;
  const dataStart = gmifStart + CHUNK_HEADER_SIZE;
  const imageSize = files.reduce((total, bytes) => align4(total + bytes.length), 0);
  const narc = new Uint8Array(dataStart + imageSize).fill(0xff, dataStart);
  const view = new DataView(narc.buffer);

  // Header: magic, byte order mark, version, file size, header size, chunk count.
  narc.set(ascii('NARC'), 0);
  view.setUint16(0x04, 0xfffe, true);
  view.setUint16(0x06, 0x0100, true);
  view.setUint32(0x08, narc.length, true);
  view.setUint16(0x0c, HEADER_SIZE, true);
  view.setUint16(0x0e, 3, true);

  // BTAF: u32 chunk size, u16 count, u16 reserved, then count × (u32 start, u32 end) relative to the data.
  narc.set(ascii('BTAF'), HEADER_SIZE);
  view.setUint32(HEADER_SIZE + 4, btafSize, true);
  view.setUint16(HEADER_SIZE + 8, files.length, true);
  let offset = 0;
  files.forEach((bytes, index) => {
    const entry = HEADER_SIZE + 12 + index * 8;
    view.setUint32(entry, offset, true);
    view.setUint32(entry + 4, offset + bytes.length, true);
    narc.set(bytes, dataStart + offset);
    offset = align4(offset + bytes.length);
  });

  // BTNF: one root directory and no names, as in most real archives.
  narc.set(ascii('BTNF'), btnfStart);
  view.setUint32(btnfStart + 4, BTNF_SIZE, true);
  view.setUint32(btnfStart + 8, 4, true);
  view.setUint16(btnfStart + 14, 1, true);

  narc.set(ascii('GMIF'), gmifStart);
  view.setUint32(gmifStart + 4, CHUNK_HEADER_SIZE + imageSize, true);
  return narc;
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}
