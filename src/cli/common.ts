// What the save-reading CLIs (`npm run box`, `npm run sheet`) share: one-line errors, the local data and the save.

import { readFileSync } from 'node:fs';
import { type LocalData, loadLocalData, MissingDataError } from '../data/load.js';
import { readSave, SaveError, type SaveData } from '../save/readSave.js';
import type { StartStatus } from '../save/status.js';

export const MAX_LEVEL = 100;

/** Prints `message` to stderr and exits 1. */
export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** A Node.js system error, such as ENOENT or EACCES from reading the save. */
function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).syscall === 'string';
}

/** `--cap`'s level, or one line with the usage and exit 1 for anything but a whole level from 1 to 100. */
export function parseCap(text: string, usage: string): number {
  const cap = Number(text);
  if (!/^\d+$/.test(text) || cap < 1 || cap > MAX_LEVEL) fail(`--cap must be a level from 1 to ${MAX_LEVEL}. ${usage}`);
  return cap;
}

/**
 * The local data, or the extract hint and exit 1 when some of it is missing, or one line and exit 1 when it cannot be
 * read or parsed: the ROM data, a docs tab, or PKCalc's saved data (whose error says to delete or save it again).
 */
export function loadData(): LocalData {
  try {
    return loadLocalData();
  } catch (error) {
    if (error instanceof MissingDataError) fail('Run npm run extract -- --rom <path> first');
    return fail((error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, ' '));
  }
}

/** The decoded save. A file that cannot be read or is not a save prints one line and exits 1. */
export function loadSave(path: string, data: LocalData): SaveData {
  try {
    return readSave(readFileSync(path), data.rom);
  } catch (error) {
    if (error instanceof SaveError) fail(`Cannot read ${path}: ${error.message} (${error.code})`);
    if (isSystemError(error)) fail(`Cannot read ${path}: ${error.message}`);
    throw error;
  }
}

const STATUS_CODES: Record<Exclude<StartStatus['kind'], 'none' | 'sleep'>, string> = {
  poison: 'PSN', toxic: 'TOX', burn: 'BRN', freeze: 'FRZ', paralysis: 'PAR',
};

/** "SLP2", "BRN" and so on, or '' for no status. */
export function statusCode(status: StartStatus): string {
  if (status.kind === 'none') return '';
  return status.kind === 'sleep' ? `SLP${status.turns}` : STATUS_CODES[status.kind];
}
