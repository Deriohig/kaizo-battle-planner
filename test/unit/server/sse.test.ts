import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { openSse, sseFrame, type SseStream } from '../../../src/server/sse.js';

it('sseFrame frames an event with one JSON data line, newlines escaped by JSON', () => {
  expect(sseFrame('progress', { a: 1 })).toBe('event: progress\ndata: {"a":1}\n\n');
  expect(sseFrame('error', { error: 'line 1\nline 2\r\nline 3' })).toBe('event: error\ndata: {"error":"line 1\\nline 2\\r\\nline 3"}\n\n');
});

describe('openSse', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    const s = server;
    server = undefined;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  async function listen(handler: http.RequestListener): Promise<string> {
    const s = http.createServer(handler);
    server = s;
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}/`;
  }

  it('a fetch client sees the SSE headers and two events', async () => {
    const res = await fetch(await listen((_req, res) => {
      const stream = openSse(res);
      stream.send('progress', { n: 1 });
      stream.send('verdict', { tier: 1 });
      stream.close();
    }));
    expect([res.status, ...['content-type', 'cache-control', 'connection', 'x-accel-buffering'].map((h) => res.headers.get(h))])
      .toEqual([200, 'text/event-stream; charset=utf-8', 'no-cache', 'keep-alive', 'no']);
    expect(await res.text()).toBe('event: progress\ndata: {"n":1}\n\nevent: verdict\ndata: {"tier":1}\n\n');
  });

  it('sends a keep-alive comment every heartbeatMs', async () => {
    const url = await listen((_req, res) => {
      const stream = openSse(res, { heartbeatMs: 10 });
      setTimeout(() => stream.close(), 60);
    });
    expect(await (await fetch(url)).text()).toMatch(/^(: keep-alive\n\n)+$/);
  });

  it('after the client aborts, send returns false and onClose has fired once; a late onClose fires at once', async () => {
    let opened!: (stream: SseStream) => void;
    const streamReady = new Promise<SseStream>((resolve) => { opened = resolve; });
    const url = await listen((_req, res) => opened(openSse(res)));
    const controller = new AbortController();
    expect((await fetch(url, { signal: controller.signal })).status).toBe(200);
    const stream = await streamReady;
    let closeCalls = 0;
    const closed = new Promise<void>((resolve) => stream.onClose(() => { closeCalls += 1; resolve(); }));
    expect([stream.send('progress', { n: 1 }), stream.closed]).toEqual([true, false]);
    controller.abort();
    await closed;
    expect([stream.closed, stream.send('progress', { n: 2 })]).toEqual([true, false]);
    stream.close();
    let lateCalls = 0;
    stream.onClose(() => { lateCalls += 1; });
    expect([closeCalls, lateCalls]).toEqual([1, 1]);
  });
});
