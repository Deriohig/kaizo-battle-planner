// Watches the save file by polling `stat` (mtime and size), not `fs.watch`: DeSmuME writes the `.dsv` from Windows
// into `/mnt/c`, and inotify does not see Windows-side writes on drvfs. A change waits out a debounce and then a settle
// check (a re-stat that must match), so a save caught mid-write gives one call, after the writes stop.

import fs from 'node:fs';

export interface FileStamp { mtimeMs: number; size: number }

export interface WatchSaveOptions {
  /** Time between the end of one poll's stat and the start of the next. Default 1000 ms. */
  intervalMs?: number;
  /** Quiet time after the last change before the settle check. Default 750 ms. */
  debounceMs?: number;
  /** null: no file. Default `fs.promises.stat`. */
  stat?: (path: string) => Promise<FileStamp | null>;
  /** Gets what `onChange` threw or rejected with; the watcher keeps going. Default `console.error`. */
  onError?: (error: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_DEBOUNCE_MS = 750;

/**
 * Calls `onChange` once the file at `path` has changed and then held still. The first stat sets the baseline and does
 * not fire. Any later change of (mtime, size), the file disappearing or appearing included, starts or restarts the
 * debounce. When the debounce runs out the file is stat'ed again (the settle check): a stamp that moved since the last
 * one seen is recorded and restarts the debounce; a matching one fires `onChange`. The default debounce (750 ms) is
 * shorter than the poll interval (1000 ms), so without the settle check a write straddling two polls would fire twice,
 * the first time on a half-written file. A stat error counts as no file. A throw or rejection from `onChange` goes to
 * `onError`. `close` stops polling, any pending settle check and any pending call.
 */
export function watchSave(path: string, onChange: () => void | Promise<void>, opts: WatchSaveOptions = {}): { close(): void } {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const stat = opts.stat ?? statFile;
  const onError = opts.onError ?? ((error: unknown) => console.error(`Save watcher for ${path}: onChange failed:`, error));

  let closed = false;
  let haveBaseline = false;
  let last: FileStamp | null = null;
  let changes = 0;                                                   // changes recorded; lets a settle check see a newer one
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const read = async (): Promise<FileStamp | null> => {
    try {
      const s = await stat(path);
      return s && { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  };

  /** Records a new stamp and starts the debounce over. */
  const changed = (now: FileStamp | null) => {
    last = now;
    changes++;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void settle(), debounceMs);
  };

  const notify = () => {
    let result: void | Promise<void>;
    try {
      result = onChange();
    } catch (error) {
      onError(error);
      return;
    }
    Promise.resolve(result).catch(onError);
  };

  const settle = async () => {
    debounceTimer = undefined;
    const seen = changes;
    const now = await read();
    // Closed, or a poll recorded a newer change while this stat ran and has restarted the debounce itself.
    if (closed || changes !== seen) return;
    if (sameStamp(last, now)) notify();
    else changed(now);
  };

  const poll = async () => {
    pollTimer = undefined;
    const now = await read();
    if (closed) return;
    if (!haveBaseline) {
      haveBaseline = true;
      last = now;
    } else if (!sameStamp(last, now)) {
      changed(now);
    }
    pollTimer = setTimeout(() => void poll(), intervalMs);
  };

  void poll();

  return {
    close() {
      closed = true;
      clearTimeout(pollTimer);
      clearTimeout(debounceTimer);
      pollTimer = undefined;
      debounceTimer = undefined;
    },
  };
}

async function statFile(path: string): Promise<FileStamp> {
  const s = await fs.promises.stat(path);
  return { mtimeMs: s.mtimeMs, size: s.size };
}

function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}
