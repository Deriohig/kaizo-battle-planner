// The hosted mode's header names and limits.
// Constants only, with no Node imports, so the page can import them as the server does.

export const SESSION_HEADER = 'x-pkp-session';
export const SAVE_NAME_HEADER = 'x-pkp-save-name';          // encodeURIComponent(file.name)
export const SAVE_MODIFIED_HEADER = 'x-pkp-save-modified';  // whole milliseconds since 1970
export const GRAVEYARD_HEADER = 'x-pkp-graveyard-box';      // 1 to 18; absent: boxes 15 to 18
export const LEVEL_CAP_HEADER = 'x-pkp-level-cap';          // 1 to 100; absent: from the badges
export const SAVE_SOURCE_HEADER = 'x-pkp-save-source';      // one of SAVE_SOURCES; for the request log only
/**
 * How the page came to send a save, for the request log (section 4.9): the Upload button or picker, a drop, the connected
 * file (its first upload and each poll's), the re-send after `NO_SAVE`, and a settings save. Anything else is logged as null.
 */
export const SAVE_SOURCES = ['upload', 'drop', 'connected', 'resend', 'settings'] as const;
export type SaveSource = (typeof SAVE_SOURCES)[number];
export const SESSION_ID = /^[0-9a-f]{32}$/;
export const MAX_SAVE_BYTES = 1_048_576;
export const POLL_MS = 2_000;

/** `bundle.json` at the root of the data bundle (scripts/makeBundle.ts writes it, the hosted server checks it). */
export interface BundleManifest {
  bundleVersion: 1;
  createdAt: string;                                        // ISO time
  gameCode: 'JAK7';
  romSchemaVersion: number;                                 // ROM_SCHEMA_VERSION
  spriteVersion: number;                                    // sprites/manifest.json's version
  fingerprint: string;                                      // stampData(dir).content
  files: { path: string; bytes: number; sha256: string }[]; // every file, `/` separators, sorted by path
}
