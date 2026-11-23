// Hosted mode's log: one JSON line per API request on stdout, and errors on stderr under a
// short ref the client is given in their place. What a line may hold is fixed here, so nothing from a save can reach it:
// the IP cut to /24 or /48, a hash of the session id, the path without its query, the status, the time taken, the
// request's size and the error code; and, to show the player how the site is used, the device and browser summed up in fixed
// words, the first language tag, how a save came in and what its size says it is, three facts of the run at an upload
// (badges, split, level cap) and the trainer a fight route was asked for. Never a body, a box's Pokémon, a file name, a
// session id, the password, the in-game trainer, note text, the full User-Agent or any other header's value as sent.
// An error is logged as its class and stack frames, without its message, since a message can quote what it read.

import { createHash, randomBytes } from 'node:crypto';
import { SAVE_SOURCES, type SaveSource } from '../contracts/hosted.js';
import { saveKind } from '../save/dsv.js';
import { ipPrefix } from './limits.js';

/** What a save's size and end say it is (`saveFormat`). */
export type SaveFormat = 'raw .sav' | 'DeSmuME .dsv' | 'other';

/** Where a run is, from the box an upload built: its badge count, its split (null when the data has none) and the level cap. */
export interface RunFacts { badges: number; split: string | null; cap: number }

/** One request line. */
export interface RequestLine {
  /** ISO time the request came in. */
  t: string;
  /** The client's IP cut to /24 or /48 (`logIp`). */
  ip: string;
  m: string;
  /** The path, without its query. */
  p: string;
  s: number;
  ms: number;
  /** The request body's size in bytes, as `Content-Length` gives it (0 without one). */
  in: number;
  /** `sessionTag` of the session id, or null without a well-formed one. */
  sess: string | null;
  /** The `code` of the error answered, or null. */
  code: string | null;
  /** Who: the name typed at sign-in (from the cookie), else the Basic user name, else null. Never a password or token. */
  user: string | null;
  /** The device and browser, as `deviceSummary` sums up the User-Agent ("Chrome 142 · Windows · desktop"); null without one. */
  ua: string | null;
  /** The first tag of `Accept-Language` ("es-ES"), when it is one (`firstLanguage`); else null. */
  lang: string | null;
  /** `PUT /api/save` only: how the page came to send it (`x-pkp-save-source`, checked by `saveSource`); else null. */
  src: SaveSource | null;
  /** `PUT /api/save` only, once its body is read: what its size says it is (`saveFormat`); else null. */
  fmt: SaveFormat | null;
  /** A `PUT /api/save` that built a box only: the run's badges, split and level cap; else null. */
  run: RunFacts | null;
  /** The plan step, sheet and AI stream routes: the trainer ID asked for, when the catalog has it; else null. */
  fight: string | null;
  /** A plan step's turn count, when its request carries one. None does yet (`PlanStepRequestJson` has no turn), so null. */
  turns: number | null;
}

export interface HostedLog {
  request(line: RequestLine): void;
  /** A one-line warning (stderr), such as the proxy one. */
  warn(message: string): void;
  /** `error` under `ref`, `what` saying where (a method and path, or "uncaughtException"): its class and stack frames. */
  error(ref: string, what: string, error: unknown): void;
}

/** The IP as a request line holds it: IPv4 to its /24, IPv6 to its /48. */
export const logIp = (ip: string): string => ipPrefix(ip, 24, 48);

/** The first 6 hex of the session id's SHA-256: enough to follow one session through the log, never the id. */
export const sessionTag = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 6);

/** A fresh error ref: 8 hex. */
export const errorRef = (): string => randomBytes(4).toString('hex');

/** How much of a User-Agent is looked at. */
const UA_LENGTH = 512;

/** The browsers told apart, first match first (Edge, Opera and Samsung Internet also say Chrome; Chrome also says Safari). */
const BROWSERS: readonly [name: string, version: RegExp][] = [
  ['Edge', /\bEdg(?:e|A|iOS)?\/(\d+)/],
  ['Opera', /\b(?:OPR|OPiOS)\/(\d+)/],
  ['Samsung Internet', /\bSamsungBrowser\/(\d+)/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome', /\b(?:CriOS|Chrome)\/(\d+)/],
  ['Safari', /\bVersion\/(\d+)[^]*\bSafari\//],
];

/** The systems told apart, first match first (an iPhone says "like Mac OS X"; Android and ChromeOS also say Linux). */
const SYSTEMS: readonly [name: string, test: RegExp][] = [
  ['iPhone', /\b(?:iPhone|iPod)\b/],
  ['iPad', /\biPad\b/],
  ['Android', /\bAndroid\b/],
  ['Windows', /\bWindows\b/],
  ['ChromeOS', /\bCrOS\b/],
  ['macOS', /\b(?:Macintosh|Mac OS X)\b/],
  ['Linux', /\b(?:Linux|X11)\b/],
];

const BOT = /bot\b|crawl|spider|slurp|headless/i;
const SCRIPT = /^(?:curl|wget|python|aiohttp|httpx|node|undici|axios|go-http-client|java|okhttp|powershell|postmanruntime|insomnia|httpie|libwww)\b/i;

/**
 * The device and browser a User-Agent says, in fixed words: the browser and its major version, the system, and phone,
 * tablet or desktop ("Chrome 142 · Windows · desktop", "Safari 18 · iPhone · phone"); "bot" for a crawler or a headless
 * browser, "script" for a tool such as curl, "other" for anything else that is not a browser. A part it cannot tell is
 * left out ("other browser" when only the browser is unknown). Null without a User-Agent. Nothing of the text is kept
 * but a version of at most four digits.
 */
export function deviceSummary(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const ua = raw.slice(0, UA_LENGTH);
  if (ua.trim() === '') return null;
  if (BOT.test(ua)) return 'bot';
  if (SCRIPT.test(ua.trim())) return 'script';
  if (!/^Mozilla\//.test(ua.trim())) return 'other';
  let browser = 'other browser';
  for (const [name, pattern] of BROWSERS) {
    const found = pattern.exec(ua);
    if (found === null) continue;
    browser = found[1]!.length <= 4 ? `${name} ${Number(found[1])}` : name;
    break;
  }
  if (browser === 'other browser' && /\bSafari\//.test(ua) && !/\bChrom/.test(ua)) browser = 'Safari';
  const system = SYSTEMS.find(([, test]) => test.test(ua))?.[0];
  return [browser, system, deviceKind(ua)].filter((part) => part !== undefined).join(' · ');
}

/** Phone, tablet or desktop: an iPad says "Mobile" too, and an Android tablet leaves "Mobile" out. */
function deviceKind(ua: string): 'phone' | 'tablet' | 'desktop' {
  if (/\b(?:iPad|Tablet)\b/.test(ua)) return 'tablet';
  if (/\b(?:iPhone|iPod|Mobi|Windows Phone)/.test(ua)) return 'phone';
  return /\bAndroid\b/.test(ua) ? 'tablet' : 'desktop';
}

/** A language tag: letters, then up to three subtags of letters and digits ("es", "es-ES", "zh-Hant-TW"). */
const LANGUAGE_TAG = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/;

/** The first tag of an `Accept-Language` header ("es-ES,es;q=0.9" gives "es-ES"), or null when it is not a language tag. */
export function firstLanguage(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const first = raw.slice(0, 200).split(',')[0]!.split(';')[0]!.trim();
  return LANGUAGE_TAG.test(first) ? first : null;
}

/** The `x-pkp-save-source` header as one of `SAVE_SOURCES`, exactly; null for anything else, or none. */
export function saveSource(raw: string | string[] | undefined): SaveSource | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (SAVE_SOURCES as readonly string[]).includes(value ?? '') ? value as SaveSource : null;
}

/** What an uploaded file's size and end say it is, by `saveKind` (src/save/dsv.ts): never its contents. */
export function saveFormat(file: Uint8Array): SaveFormat {
  const kind = saveKind(file);
  return kind === 'raw' ? 'raw .sav' : kind === 'dsv' ? 'DeSmuME .dsv' : 'other';
}

/** `error`'s class and stack frames, with no message. */
export function errorShape(error: unknown): { class: string; frames: string[] } {
  if (!(error instanceof Error)) return { class: typeof error, frames: [] };
  const frames = (error.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line)).map((line) => line.trim()).slice(0, 20);
  return { class: error.constructor?.name || error.name, frames };
}

export function createLog(opts: { requests: boolean; out?: (line: string) => void; err?: (line: string) => void; now?: () => Date }): HostedLog {
  const out = opts.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = opts.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = opts.now ?? (() => new Date());
  return {
    request(line) {
      if (opts.requests) out(JSON.stringify(line));
    },
    warn(message) {
      err(JSON.stringify({ t: now().toISOString(), level: 'warn', message }));
    },
    error(ref, what, error) {
      err(JSON.stringify({ t: now().toISOString(), level: 'error', ref, what, ...errorShape(error) }));
    },
  };
}
