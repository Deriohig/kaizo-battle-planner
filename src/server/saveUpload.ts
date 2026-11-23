// `PUT /api/save`: the save's bytes read from the request in memory, the headers that ride
// with them (the file's name and time, the graveyard and the level cap), and the box built from them. The bytes are
// dropped once the box is built; nothing of the upload touches the disk or the log.

import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { HostedSettingsJson, SettingsJson } from '../contracts/api.js';
import { GRAVEYARD_HEADER, LEVEL_CAP_HEADER, SAVE_MODIFIED_HEADER, SAVE_NAME_HEADER } from '../contracts/hosted.js';
import { SaveError } from '../errors.js';
import { MAX_LEVEL } from '../battle/playerMon.js';
import { type BoxState, buildBox } from './box.js';
import { HttpError } from './http.js';
import type { ServerData } from './state.js';

/** How long an upload's body may take to arrive. */
export const UPLOAD_BODY_MS = 15_000;
/** The longest name kept. */
const NAME_LENGTH = 120;
const FALLBACK_NAME = 'save.dsv';
/** The earliest modified time taken: 2004-01-01, before any DS save. */
const EARLIEST_MODIFIED = Date.UTC(2004, 0, 1);
const DAY_MS = 86_400_000;
const LAST_BOX = 18;
/** What a save that throws anything but `SaveError` is answered with. */
export const NOT_A_SAVE = 'This file does not read as a Platinum save';

/** An answer that ends the connection: the rest of a refused body is not read. */
const closing = { Connection: 'close' } as const;

/**
 * The request body, at most `maxBytes`, as one fresh `Uint8Array`. 413 `TOO_LARGE` for a `Content-Length` over the cap
 * before a byte is read, or once a body without one passes it; 408 when the whole body has not arrived `timeoutMs` after
 * the call. Both answers close the connection. A request that closes before its end rejects with 499 `CLOSED`.
 */
export function readUploadBody(req: IncomingMessage, opts: { maxBytes: number; timeoutMs?: number }): Promise<Uint8Array> {
  const tooLarge = () => new HttpError(413, `A save is at most ${opts.maxBytes} bytes; this file is larger`, 'TOO_LARGE', closing);
  const length = req.headers['content-length'];
  if (length !== undefined && /^\d+$/.test(length) && Number(length) > opts.maxBytes) return Promise.reject(tooLarge());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error: unknown, body?: Uint8Array) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
      if (error !== null) {
        req.pause();
        reject(error);
      } else {
        resolve(body!);
      }
    };
    const timer = setTimeout(() => finish(new HttpError(408, `The save took over ${Math.round((opts.timeoutMs ?? UPLOAD_BODY_MS) / 1000)} s to arrive`, undefined, closing)), opts.timeoutMs ?? UPLOAD_BODY_MS);
    function onData(chunk: Buffer): void {
      size += chunk.length;
      if (size > opts.maxBytes) finish(tooLarge());
      else chunks.push(chunk);
    }
    function onEnd(): void {
      const body = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        body.set(chunk, at);
        at += chunk.length;
      }
      finish(null, body);
    }
    function onError(): void {
      finish(new HttpError(499, 'The request was closed before the save arrived', 'CLOSED'));
    }
    function onClose(): void {
      finish(new HttpError(499, 'The request was closed before the save arrived', 'CLOSED'));
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

/**
 * The name to show for an upload: decoded (`encodeURIComponent`'s form), cut to its last path part, stripped of control
 * characters and cut to 120 characters; `save.dsv` when nothing is left. null for an escape that does not decode.
 */
export function saveName(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  const name = (decoded.split(/[/\\]/).pop() ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  const cut = [...name].slice(0, NAME_LENGTH).join('');
  return cut === '' ? FALLBACK_NAME : cut;
}

export interface UploadMeta { name: string; modified: Date; settings: HostedSettingsJson }

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** A header that must be a whole number from `min` to `max`, null when absent; 400 naming it otherwise. */
function wholeHeader(headers: IncomingHttpHeaders, name: string, min: number, max: number): number | null {
  const raw = header(headers, name);
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`);
  return n;
}

/**
 * The headers riding with an upload, checked in this order, each a 400 naming it: `x-pkp-save-name` (required;
 * `saveName`), `x-pkp-save-modified` (required: whole milliseconds from 2004-01-01 to a day after `now`),
 * `x-pkp-graveyard-box` (1 to 18) and `x-pkp-level-cap` (1 to 100), both optional.
 */
export function uploadMeta(headers: IncomingHttpHeaders, now: number): UploadMeta {
  const rawName = header(headers, SAVE_NAME_HEADER);
  if (rawName === undefined) throw new HttpError(400, `${SAVE_NAME_HEADER} is required: the file's name`);
  const name = saveName(rawName);
  if (name === null) throw new HttpError(400, `${SAVE_NAME_HEADER} must be the file's name as encodeURIComponent writes it`);
  const rawModified = header(headers, SAVE_MODIFIED_HEADER);
  if (rawModified === undefined) throw new HttpError(400, `${SAVE_MODIFIED_HEADER} is required: the file's last-modified time`);
  const modified = Number(rawModified);
  if (!/^\d+$/.test(rawModified) || modified < EARLIEST_MODIFIED || modified > now + DAY_MS) {
    throw new HttpError(400, `${SAVE_MODIFIED_HEADER} must be the file's last-modified time in whole milliseconds since 1970, from 2004 to now`);
  }
  return {
    name, modified: new Date(modified),
    settings: { graveyardBox: wholeHeader(headers, GRAVEYARD_HEADER, 1, LAST_BOX), levelCapOverride: wholeHeader(headers, LEVEL_CAP_HEADER, 1, MAX_LEVEL) },
  };
}

/**
 * The box of an uploaded save (section 4.7): `buildBox` over the bytes, the name as its `savePath` and the modified time
 * as its `savedAt`. Anything the build throws is a 422 `BAD_SAVE`: a `SaveError` with its own words, written for
 * players; anything else with `NOT_A_SAVE`, after `logFailure` gets the error (its class and stack go to the log under a
 * ref, never the bytes).
 */
export function uploadedBox(file: Uint8Array, meta: UploadMeta, data: ServerData, logFailure: (error: unknown) => void): BoxState {
  const settings: SettingsJson = { romPath: null, savePath: meta.name, ...meta.settings };
  try {
    return buildBox({ file, savePath: meta.name, savedAt: meta.modified, data: data.local, settings });
  } catch (error) {
    if (error instanceof SaveError) throw new HttpError(422, error.message, 'BAD_SAVE');
    logFailure(error);
    throw new HttpError(422, NOT_A_SAVE, 'BAD_SAVE');
  }
}
