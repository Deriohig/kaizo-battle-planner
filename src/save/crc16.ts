// CRC-16-CCITT as the Gen 4 save blocks use it: polynomial 0x1021, initial value 0xFFFF, no reflection, no final XOR.

const POLYNOMIAL = 0x1021;

const TABLE = Uint16Array.from({ length: 256 }, (_, byte) => {
  let crc = byte << 8;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000 ? (crc << 1) ^ POLYNOMIAL : crc << 1) & 0xffff;
  return crc;
});

/** The CRC-16-CCITT of `bytes`. */
export function crc16Ccitt(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) crc = ((crc << 8) & 0xffff) ^ TABLE[(crc >> 8) ^ byte]!;
  return crc;
}
