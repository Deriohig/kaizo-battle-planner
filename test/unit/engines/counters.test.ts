import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { FALLBACK, NATIVE, newCounters, REMEMBERED, SHOWDOWN, stepCounters, stepsSince } from '../../../src/engines/counters.js';

const COUNTERS_MODULE = new URL('../../../src/engines/counters.ts', import.meta.url).href;
const zero = { native: 0, fallback: 0, showdown: 0, remembered: 0 };

// Adds 7 native steps through the buffer it was started with, then 9 fallback and 5 remembered through one it is sent.
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.module).then(({ stepCounters, NATIVE, FALLBACK, REMEMBERED }) => {
  stepCounters(workerData.counters).add(NATIVE, 7);
  parentPort.once('message', (buffer) => {
    stepCounters(buffer).add(FALLBACK, 9);
    stepCounters(buffer).add(REMEMBERED, 5);
    parentPort.postMessage('done');
  });
  parentPort.postMessage('ready');
});
`;

describe('engine step counters', () => {
  it('a clone of the buffer shares its cells; add ignores zero or less and holds counts past 32 bits; stepsSince', () => {
    const counters = newCounters();
    expect(counters.byteLength).toBe(32);
    const cells = stepCounters(counters);
    expect(cells.read()).toEqual(zero);
    const clone = stepCounters(structuredClone({ counters }).counters);
    for (const [cell, n] of [[SHOWDOWN, 4], [NATIVE, 2], [REMEMBERED, 3], [FALLBACK, 0], [SHOWDOWN, -4]] as const) clone.add(cell, n);
    const start = cells.read();
    expect(start).toEqual({ native: 2, fallback: 0, showdown: 4, remembered: 3 });
    const big = 2 ** 32 + 5;
    for (const cell of [NATIVE, FALLBACK, SHOWDOWN, REMEMBERED, SHOWDOWN] as const) cells.add(cell, big);
    expect(stepsSince(cells.read(), start)).toEqual({ native: big, fallback: big, showdown: 2 * big, remembered: big });
  });

  it('adds from a worker thread land in the same cells', async () => {
    const counters = newCounters();
    const worker = new Worker(WORKER, { eval: true, workerData: { counters, module: COUNTERS_MODULE }, execArgv: ['--import', 'tsx'] });
    try {
      expect((await once(worker, 'message'))[0]).toBe('ready');
      worker.postMessage(counters);
      expect((await once(worker, 'message'))[0]).toBe('done');
    } finally {
      await worker.terminate();
    }
    expect(stepCounters(counters).read()).toEqual({ ...zero, native: 7, fallback: 9, remembered: 5 });
  });
});
