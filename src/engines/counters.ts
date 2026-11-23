// The engine step counters: which engine ran each `expandTurn` of a solve, counted on every thread, and
// how many more `expandTurn` calls the result store answered from earlier work without running an engine.
//
// The real solver owns one SharedArrayBuffer of four 64-bit cells for its whole life and sends it in every worker
// context; a clone of the buffer (structuredClone, workerData, postMessage) shares its cells, so every thread's
// engine selector (select.ts) and every thread's deps (integration/deps.ts, the `remembered` cell) add to the same
// counts with Atomics. A solve reads the cells at its start and end, and `stepsSince` gives its own run.

/**
 * The cells: steps the native core ran, steps the native engine ran on Showdown, steps sent straight to Showdown (the
 * three engine runs, counted by the engine selector), and steps the result store answered without running an engine
 * (counted at the store's front by the deps).
 */
export const NATIVE = 0, FALLBACK = 1, SHOWDOWN = 2, REMEMBERED = 3;

export interface EngineSteps { native: number; fallback: number; showdown: number; remembered: number }

const CELLS = 4;

/** 32 bytes: four 64-bit cells, all zero. */
export function newCounters(): SharedArrayBuffer {
  return new SharedArrayBuffer(CELLS * BigInt64Array.BYTES_PER_ELEMENT);
}

export interface StepCounters { add(cell: 0 | 1 | 2 | 3, n: number): void; read(): EngineSteps }

/** Over a BigInt64Array of `buffer`; add is Atomics.add (a no-op for n <= 0), read is Atomics.load of each cell. */
export function stepCounters(buffer: SharedArrayBuffer): StepCounters {
  const cells = new BigInt64Array(buffer, 0, CELLS);
  return {
    add(cell: 0 | 1 | 2 | 3, n: number): void {
      if (n > 0) Atomics.add(cells, cell, BigInt(n));
    },
    read(): EngineSteps {
      return {
        native: Number(Atomics.load(cells, NATIVE)),
        fallback: Number(Atomics.load(cells, FALLBACK)),
        showdown: Number(Atomics.load(cells, SHOWDOWN)),
        remembered: Number(Atomics.load(cells, REMEMBERED)),
      };
    },
  };
}

/** The steps counted between `start` and `now` (two reads of the same cells). */
export function stepsSince(now: EngineSteps, start: EngineSteps): EngineSteps {
  return {
    native: now.native - start.native, fallback: now.fallback - start.fallback, showdown: now.showdown - start.showdown,
    remembered: now.remembered - start.remembered,
  };
}
