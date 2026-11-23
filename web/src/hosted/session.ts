// The hosted page's identity and settings, kept in `localStorage`: a random session id the server files this tab's box
// under (sent as `x-pkp-session` on every call), and the two settings that stay in the browser in hosted mode (the graveyard
// box and the level cap), which ride with each save upload. A `localStorage` that throws (a private window, blocked site
// data) is carried on without: the id lives in a module variable for this page and the settings are just not remembered.

import type { HostedSettingsJson } from '../../../src/server/apiTypes';
import { SESSION_ID } from '../../../src/contracts/hosted';

export const SESSION_KEY = 'pkp.session';
export const SETTINGS_KEY = 'pkp.settings';

const DEFAULT_SETTINGS: HostedSettingsJson = { graveyardBox: null, levelCapOverride: null };

/** The id kept for this page when `localStorage` cannot hold it. */
let memoryId: string | undefined;

/** 32 lowercase hex characters from the browser's random source. */
export function newSessionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** This browser's session id: the stored one when it is well formed, else a new one, stored. */
export function sessionId(): string {
  if (memoryId !== undefined) return memoryId;
  try {
    const stored = localStorage.getItem(SESSION_KEY);
    if (stored !== null && SESSION_ID.test(stored)) return stored;
  } catch {
    memoryId = newSessionId();
    return memoryId;
  }
  const id = newSessionId();
  try {
    localStorage.setItem(SESSION_KEY, id);
  } catch {
    memoryId = id;
  }
  return id;
}

const wholeIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** The stored hosted settings when valid (box null or 1 to 18, cap null or 1 to 100, whole numbers), else both null. */
export function readHostedSettings(): HostedSettingsJson {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return { ...DEFAULT_SETTINGS };
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...DEFAULT_SETTINGS };
    const { graveyardBox, levelCapOverride } = value as Record<string, unknown>;
    if ((graveyardBox === null || wholeIn(graveyardBox, 1, 18)) && (levelCapOverride === null || wholeIn(levelCapOverride, 1, 100))) {
      return { graveyardBox, levelCapOverride };
    }
  } catch {
    // unreadable or blocked: the defaults
  }
  return { ...DEFAULT_SETTINGS };
}

/** Stores the hosted settings; a blocked `localStorage` just does not remember them. */
export function writeHostedSettings(s: HostedSettingsJson): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ graveyardBox: s.graveyardBox, levelCapOverride: s.levelCapOverride }));
  } catch {
    // not remembered
  }
}
