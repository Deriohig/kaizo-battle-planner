// The HTTP helpers the routes share (`app.ts`, `setup.ts`, `lines.ts` and hosted mode's `hostedRoutes.ts`): the
// client-error type, the JSON body reader, the JSON and `{ error }` answers, the data and box a route needs, the
// local-only guard on `/api`, and hosted mode's JSON cap and 500. No route imports `app.ts`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { oneLineMessage as oneLine } from '../docs/fetchDocs.js';
import type { BoxState } from './box.js';
import type { ServerData, ServerState } from './state.js';

const MAX_BODY_BYTES = 1 << 20;
/** Hosted mode's cap on a JSON body. */
export const HOSTED_JSON_BYTES = 256 * 1024;

/**
 * A failure the client caused or must act on: answered as `{ error: message }` with `status`, and not logged. A `code`
 * (the line builder's `LINE_LOST`, hosted mode's `HostedErrorCode`) is answered beside the message, and `headers` (a
 * `Retry-After`, a `WWW-Authenticate`) with it.
 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string, readonly headers?: Readonly<Record<string, string>>) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * How `readJsonBody` caps a body: local mode's default is 1 MiB with no code; hosted mode passes `HOSTED_JSON_BYTES`,
 * its words and `TOO_LARGE`, and a `Content-Length` over the cap is refused before a byte is read.
 */
export interface JsonBodyCap { maxBytes: number; label: string; code: string }

/** The request body parsed as JSON: 413 over 1 MiB (or `cap`), 400 when it is not JSON. */
export async function readJsonBody(req: IncomingMessage, cap?: JsonBodyCap): Promise<unknown> {
  const max = cap?.maxBytes ?? MAX_BODY_BYTES;
  const tooLarge = () => (cap === undefined
    ? new HttpError(413, 'The request body is over 1 MiB')
    : new HttpError(413, `The request body is over ${cap.label}`, cap.code, { Connection: 'close' }));
  const length = req.headers['content-length'];
  if (cap !== undefined && length !== undefined && /^\d+$/.test(length) && Number(length) > max) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > max) throw tooLarge();
      chunks.push(chunk);
    }
  } catch (error) {
    // Hosted mode: a client that hangs up mid-body is 499, not a 500 with a stack in the log. Local mode as before.
    if (cap !== undefined && !(error instanceof HttpError)) throw new HttpError(499, 'The request was closed before its body arrived', 'CLOSED');
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new HttpError(400, `The request body is not JSON: ${oneLine(error)}`);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** `{ error }` with `status` (and `headers`); a response already under way (an event stream) is ended instead. */
export function sendError(res: ServerResponse, status: number, error: string, code?: string, headers?: Readonly<Record<string, string>>): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value);
  sendJson(res, status, code === undefined ? { error } : { error, code });
}

/** Hosted mode's 500 (section 4.6): the ref names the log line holding the stack, which never reaches the client. */
export function hostedInternalError(ref: string): { error: string; code: 'INTERNAL' } {
  return { error: `Something went wrong on the server (ref ${ref})`, code: 'INTERNAL' };
}

/** The data, or 409 while there is none. */
export function requireData(state: ServerState): ServerData {
  const data = state.data();
  if (data !== null) return data;
  const { state: dataState, message } = state.dataStatus();
  throw new HttpError(409, dataState === 'error' && message !== null
    ? `The game data cannot be loaded: ${message}`
    : 'No game data yet: run the setup first');
}

/** The box: 409 before a save is chosen or while there is no data, 422 with the read error of a save that never read. */
export function requireBox(state: ServerState): BoxState {
  if (state.settings().savePath === null) throw new HttpError(409, 'Choose a save first');
  requireData(state);
  const box = state.box();
  if (box === null) throw new HttpError(409, 'The save has not been read yet');
  if ('error' in box) throw new HttpError(422, box.error);
  return box;
}

/**
 * Throws unless an `/api` request comes from the planner page (or the Vite dev proxy, which sends `changeOrigin`):
 * - 403 when `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, `<port>` being the one the request came in on. A
 *   page on another name that resolves to 127.0.0.1 (DNS rebinding) sends its own name.
 * - 415 when a PUT or POST is not `Content-Type: application/json` (parameters such as a charset may follow). Another
 *   site's page can send a text/plain or form body without asking first, but not a JSON one.
 */
export function checkLocalRequest(req: IncomingMessage): void {
  const port = req.socket.localPort;
  const host = (req.headers.host ?? '').toLowerCase();
  if (port === undefined || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
    throw new HttpError(403, 'Requests must come from the planner page');
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') {
      throw new HttpError(415, `A ${req.method} to the planner takes a JSON body: send Content-Type: application/json`);
    }
  }
}
