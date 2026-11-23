// The worker's deps per context key (worker.ts): a value is made once per key and kept for the `capacity` most recently
// used keys, so two overlapping solves (two keys) can share a worker without rebuilding, and a third key evicts the
// least recently used one. A worker keeps CONTEXTS_KEPT keys, and forgets a key whose build failed (worker.ts).

/** How many context keys a worker keeps deps for. */
export const CONTEXTS_KEPT = 2;

export class RecentCache<V> {
  private readonly entries = new Map<string, V>();   // least recently used first

  constructor(private readonly capacity: number) {
    if (!(Number.isInteger(capacity) && capacity >= 1)) throw new RangeError(`cache: capacity must be a positive integer, got ${capacity}`);
  }

  /** The value for `key`: the kept one (now the most recent), else `make()`'s, kept, evicting the least recent past capacity. */
  get(key: string, make: () => V): V {
    if (this.entries.has(key)) {
      const kept = this.entries.get(key) as V;
      this.entries.delete(key);
      this.entries.set(key, kept);
      return kept;
    }
    const value = make();
    this.entries.set(key, value);
    for (const old of this.entries.keys()) {
      if (this.entries.size <= this.capacity) break;
      this.entries.delete(old);
    }
    return value;
  }

  /** Drops `key` when it still holds `value` (a later value for the key stays). */
  forget(key: string, value: V): void {
    if (this.entries.get(key) === value) this.entries.delete(key);
  }

  /** The kept keys, least recently used first. */
  keys(): string[] {
    return [...this.entries.keys()];
  }
}
