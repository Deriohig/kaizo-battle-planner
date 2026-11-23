// Decodes Gen 4 text (nicknames): one u16 character code each, ending at 0xFFFF.

const TERMINATOR = 0xffff;
const UNKNOWN = '?';

const RANGES: { first: number; last: number; base: string }[] = [
  { first: 0x0121, last: 0x012a, base: '0' },
  { first: 0x012b, last: 0x0144, base: 'A' },
  { first: 0x0145, last: 0x015e, base: 'a' },
];

const SINGLES = new Map<number, string>([
  [0x01ab, '!'], [0x01ac, '?'], [0x01ad, ','], [0x01ae, '.'], [0x01b1, '/'], [0x01b3, "'"], [0x01b9, '('], [0x01ba, ')'],
  [0x01bb, '♂'], [0x01bc, '♀'], [0x01bd, '+'], [0x01be, '-'], [0x01de, ' '],
]);

/** The text up to the first 0xFFFF (or the end). Codes outside the character table decode as `?`. */
export function decodeText(codes: readonly number[]): string {
  const end = codes.indexOf(TERMINATOR);
  return (end === -1 ? codes : codes.slice(0, end)).map(decodeChar).join('');
}

function decodeChar(code: number): string {
  const range = RANGES.find(({ first, last }) => code >= first && code <= last);
  if (range !== undefined) return String.fromCharCode(range.base.charCodeAt(0) + code - range.first);
  return SINGLES.get(code) ?? UNKNOWN;
}
