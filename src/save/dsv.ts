// Strips DeSmuME's `.dsv` footer. A `.dsv` file is the raw 512 KiB save followed by a footer ending in the 16-byte
// cookie `|-DESMUME SAVE-|`; a raw `.sav` is the save alone.

import { SaveError } from '../errors.js';

const SAVE_SIZE = 0x80000;

const COOKIE = Uint8Array.from('|-DESMUME SAVE-|', (char) => char.charCodeAt(0));

/**
 * What a file's size and end say it is: `raw` at exactly 0x80000 bytes (melonDS, DraStic, a flashcart), `dsv` for the raw
 * save followed by a footer ending in DeSmuME's cookie, else null. Its contents are not looked at.
 */
export function saveKind(file: Uint8Array): 'raw' | 'dsv' | null {
  if (file.length === SAVE_SIZE) return 'raw';
  if (file.length >= SAVE_SIZE + COOKIE.length && endsWithCookie(file)) return 'dsv';
  return null;
}

/** The raw save: the whole file at exactly 0x80000 bytes, or the first 0x80000 bytes before a DeSmuME footer. */
export function rawSave(file: Uint8Array): Uint8Array {
  const kind = saveKind(file);
  if (kind === 'raw') return file;
  if (kind === 'dsv') return file.subarray(0, SAVE_SIZE);
  throw new SaveError('BAD_SIZE', `A save is ${SAVE_SIZE} bytes, optionally followed by a DeSmuME footer; this file is ${file.length} bytes${file.length > SAVE_SIZE ? ' with no DeSmuME footer' : ''}`);
}

function endsWithCookie(file: Uint8Array): boolean {
  const tail = file.subarray(file.length - COOKIE.length);
  return COOKIE.every((byte, i) => tail[i] === byte);
}
