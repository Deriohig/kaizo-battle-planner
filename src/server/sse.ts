// Server-sent events over plain `node:http` (framing in `src/contracts/api.ts`): `event: <name>\ndata: <one JSON line>\n\n`.
// The only Node import is a type, so the page's tests can build streams with `sseFrame`.

import type { ServerResponse } from 'node:http';

export interface SseStream {
  /** Writes one event; false once the stream has closed (the client went away, or `close` was called). */
  send(event: string, data: unknown): boolean;
  /** Ends the response. */
  close(): void;
  readonly closed: boolean;
  /** Runs once when the stream closes, whichever side closed it; at once if it is already closed. */
  onClose(cb: () => void): void;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

/** One SSE frame. `data` must be JSON-ready (see `toJsonValue`); JSON escapes newlines, so it stays on one `data:` line. */
export function sseFrame(event: string, data: unknown): string {
  if (/[\r\n]/.test(event)) throw new TypeError(`An SSE event name cannot hold a line break: ${JSON.stringify(event)}`);
  const json = JSON.stringify(data);
  if (json === undefined) throw new TypeError(`SSE event ${event} has no JSON data`);
  return `event: ${event}\ndata: ${json}\n\n`;
}

/** Starts an event stream on `res`: the 200 status and headers go out at once, then a `: keep-alive` comment every `heartbeatMs`. */
export function openSse(res: ServerResponse, opts: { heartbeatMs?: number } = {}): SseStream {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let closed = false;
  const callbacks: (() => void)[] = [];
  const heartbeat = setInterval(() => {
    if (!gone()) res.write(': keep-alive\n\n');
  }, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref();

  function gone(): boolean {
    return closed || res.destroyed || res.writableEnded;
  }

  function finish(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const cb of callbacks.splice(0)) cb();
  }

  res.on('close', finish);

  return {
    send(event, data) {
      if (gone()) return false;
      res.write(sseFrame(event, data));
      return true;
    },
    close() {
      if (!res.writableEnded && !res.destroyed) res.end();
      finish();
    },
    get closed() {
      return closed;
    },
    onClose(cb) {
      if (closed) cb();
      else callbacks.push(cb);
    },
  };
}
