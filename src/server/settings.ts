// The settings file (`SettingsJson`, contract in `src/contracts/api.ts`): where it lives, its defaults, loading and
// saving it, and checking a settings body from the page. Paths are stored as WSL paths: a Windows path pasted into
// setup or settings ("Copy as path" quotes and all) is turned into its `/mnt/<drive>/…` form.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SettingsJson } from './apiTypes.js';
import { DEFAULT_GRAVEYARD_BOXES } from '../save/readSave.js';

/** A settings file that cannot be read, is not JSON, or holds a bad value. The message is one line and names the file. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

export const DEFAULT_SETTINGS: SettingsJson = {
  romPath: null,
  savePath: null,
  graveyardBox: null,
  levelCapOverride: null,
};

const LAST_BOX = 18;
const MAX_LEVEL = 100;

/** `$PKP_SETTINGS`, else `$XDG_CONFIG_HOME/plat-kaizo-planner/settings.json`, else `~/.config/plat-kaizo-planner/settings.json`. */
export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PKP_SETTINGS) return env.PKP_SETTINGS;
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(configHome, 'plat-kaizo-planner', 'settings.json');
}

/**
 * The settings in `file`. A missing file gives the defaults; missing keys are filled from them. Unknown keys are dropped,
 * so a file from before 7c loads without the old priorities and the solver's settings, whatever they hold, and the next
 * save writes the four keys.
 * Throws `SettingsError` when the file cannot be read, is not JSON, is not a JSON object or holds a bad value.
 */
export function loadSettings(file: string): SettingsJson {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_SETTINGS);
    throw new SettingsError(`Cannot read the settings file ${file}: ${oneLine(e)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new SettingsError(`The settings file ${file} is not valid JSON: ${oneLine(e)}`);
  }
  if (!isRecord(raw)) throw new SettingsError(`The settings file ${file} does not hold a JSON object`);

  const result = parseSettings({ ...DEFAULT_SETTINGS, ...raw });
  if (!result.ok) throw new SettingsError(`The settings file ${file} is invalid: ${result.error}`);
  return result.settings;
}

/** Writes `s` to `file`, creating its folder: to `<file>.tmp` first, then renamed over `file`, so a reader never sees half a file. */
export function saveSettings(file: string, s: SettingsJson): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Checks a settings body (`PUT /api/settings`): each of the four keys must be present, with the right type and in range.
 * Paths go through `toLinuxPath` and an empty path becomes null. Unknown keys are dropped, so a body from a page tab
 * opened before 7c, which still sends the solver's keys, is taken without them. The error names the field.
 */
export function parseSettings(body: unknown): { ok: true; settings: SettingsJson } | { ok: false; error: string } {
  try {
    return { ok: true, settings: readSettings(body) };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    throw e;
  }
}

/**
 * A path as the player may paste it, as a WSL path: trimmed, one pair of surrounding quotes stripped, `X:\…` or `X:/…` as
 * `/mnt/x/…`, and backslashes as slashes. A Linux path comes back as it was.
 */
export function toLinuxPath(p: string): string {
  let s = p.trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0]) s = s.slice(1, -1).trim();
  s = s.replaceAll('\\', '/');
  const drive = /^([A-Za-z]):\/(.*)$/s.exec(s);
  return drive ? `/mnt/${drive[1]!.toLowerCase()}/${drive[2]}` : s;
}

/** The graveyard boxes: boxes 15–18 (`DEFAULT_GRAVEYARD_BOXES`) when `graveyardBox` is null, else `graveyardBox` to 18. */
export function graveyardBoxes(s: SettingsJson): number[] {
  if (s.graveyardBox === null) return [...DEFAULT_GRAVEYARD_BOXES];
  const boxes: number[] = [];
  for (let box = s.graveyardBox; box <= LAST_BOX; box++) boxes.push(box);
  return boxes;
}

/** A failed check inside `readSettings`; `parseSettings` turns it into `{ ok: false }`. */
class Invalid extends Error {}

function readSettings(body: unknown): SettingsJson {
  if (!isRecord(body)) throw new Invalid('The settings must be a JSON object');
  return {
    romPath: pathField(body, 'romPath'),
    savePath: pathField(body, 'savePath'),
    graveyardBox: wholeOrNull(body, 'graveyardBox', 1, LAST_BOX),
    levelCapOverride: wholeOrNull(body, 'levelCapOverride', 1, MAX_LEVEL),
  };
}

function pathField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Invalid(`${key} must be a path (a string) or null`);
  const linux = toLinuxPath(value);
  return linux === '' ? null : linux;
}

/** Whether `value` is an integer from `min` to `max`. */
export function isWhole(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function wholeOrNull(body: Record<string, unknown>, key: string, min: number, max: number): number | null {
  const value = body[key];
  if (value === null) return null;
  if (!isWhole(value, min, max)) throw new Invalid(`${key} must be a whole number from ${min} to ${max}, or null`);
  return value;
}

/** Whether `value` is a JSON object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneLine(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}
