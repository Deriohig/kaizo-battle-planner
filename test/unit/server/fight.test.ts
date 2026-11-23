import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { streamOdds } from '../../../src/server/fight.js';
import type { SheetAi, SheetAiQuery } from '../../../src/server/sheetAi.js';

const servers: http.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

it('streamOdds ends with an error event as soon as its own signal aborts (the work gate\'s time limit), not waiting for the batch', async () => {
  // A batch that never ends, as a shared batch another stream keeps alive.
  const endless: SheetAi = { odds: () => new Promise(() => undefined), stream: () => new Promise(() => undefined) };
  const query = { save: { savedAt: '2026-11-21T00:00:00.000Z', savePath: 'a.dsv' } } as unknown as SheetAiQuery;
  let settled = false;
  const server = http.createServer((req, res) => {
    void streamOdds(req, res, endless, query, { signal: AbortSignal.timeout(50), failure: () => 'too long' }).then(() => { settled = true; });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const text = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { signal: AbortSignal.timeout(5_000) })).text();
  expect([text, settled]).toEqual([expect.stringMatching(/event: error[\s\S]*too long/), true]);
});
