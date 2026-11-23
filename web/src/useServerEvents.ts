// The server's live events (`GET /api/events`): `box` after the watched save changes and is re-read, `boxError` when
// that read fails. The browser's EventSource retries a dropped stream by itself, but gives up for good on an answer that
// is not an event stream (a server that is down behind the dev proxy, for one), so then this opens a new one after
// RETRY_MS. The status is 'live' while the stream is open, else 'reconnecting'.

import { useEffect, useRef, useState } from 'react';
import type { BoxJson } from '../../src/server/apiTypes';

export const RETRY_MS = 3_000;

export type LiveStatus = 'live' | 'reconnecting';

function data(e: Event): unknown {
  try {
    return JSON.parse((e as MessageEvent<string>).data);
  } catch {
    return undefined;
  }
}

export function useServerEvents(onBox: (b: BoxJson) => void, onBoxError: (e: string) => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('reconnecting');
  // The newest callbacks, so the stream is opened once and not again on every render.
  const handlers = useRef({ onBox, onBoxError });
  useEffect(() => {
    handlers.current = { onBox, onBoxError };
  });

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    function connect(): void {
      const es = new EventSource('/api/events');
      source = es;
      es.addEventListener('open', () => setStatus('live'));
      es.addEventListener('error', () => {
        setStatus('reconnecting');
        if (es.readyState === EventSource.CLOSED && !stopped) {
          clearTimeout(retry);
          retry = setTimeout(connect, RETRY_MS);
        }
      });
      es.addEventListener('box', (e) => {
        const box = data(e);
        if (typeof box === 'object' && box !== null) handlers.current.onBox(box as BoxJson);
      });
      es.addEventListener('boxError', (e) => {
        const body = data(e) as { error?: unknown } | undefined;
        handlers.current.onBoxError(typeof body?.error === 'string' ? body.error : 'The save could not be read');
      });
    }

    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      source?.close();
    };
  }, []);

  return status;
}
