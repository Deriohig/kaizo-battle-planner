// The hosted page's way to follow a save file on disk, for Chrome and Edge: the "Connect save file" picker, the
// stored handle's read permission, and the poll that notices the player saving in game. The poll mirrors `watchSave.ts`:
// a tick every `pollMs` while the tab is visible (and one at once when it becomes visible), and a change must stay the
// same for `settleMs` before it counts as a finished write. `NotReadableError` (DeSmuME mid-write) counts as a change.
// The poller never remembers an upload by itself: the caller says what was uploaded with `setLast`. The File System
// Access types are not in every TypeScript DOM lib, so the narrow ones this file needs are declared here.

/** What a poll compares: the two things a write changes. */
export interface FileStamp {
  lastModified: number;
  size: number;
}

export type FilePermission = 'granted' | 'prompt' | 'denied';

/** A file the player connected, wrapped so the page and the tests need no browser type. Permissions are for reading. */
export interface SaveFile {
  readonly handle: unknown;
  readonly name: string;
  getFile(): Promise<File>;
  queryPermission(): Promise<FilePermission>;
  requestPermission(): Promise<FilePermission>;
}

export interface FileAccess {
  readonly canConnect: boolean;
  /** Opens the picker. Resolves `null` when the player cancels it. */
  pick(): Promise<SaveFile | null>;
  /** Wraps a handle read back from storage, or `null` when it is not a file handle. */
  fromStored(handle: unknown): SaveFile | null;
}

/** The part of `FileSystemFileHandle` this file uses. */
interface FileHandleLike {
  name?: string;
  getFile(): Promise<File>;
  queryPermission?(desc: { mode: 'read' }): Promise<FilePermission>;
  requestPermission?(desc: { mode: 'read' }): Promise<FilePermission>;
}

interface PickerWindow {
  isSecureContext?: boolean;
  showOpenFilePicker?(options: {
    types: { description: string; accept: Record<string, string[]> }[];
    multiple: boolean;
  }): Promise<FileHandleLike[]>;
}

function wrapHandle(h: FileHandleLike): SaveFile {
  return {
    handle: h,
    name: h.name ?? '',
    getFile: () => h.getFile(),
    // A handle with no permission methods is as good as granted: reading it will tell.
    queryPermission: async () => (h.queryPermission ? h.queryPermission({ mode: 'read' }) : 'granted'),
    requestPermission: async () => (h.requestPermission ? h.requestPermission({ mode: 'read' }) : 'granted'),
  };
}

function isFileHandle(h: unknown): h is FileHandleLike {
  return typeof h === 'object' && h !== null && typeof (h as { getFile?: unknown }).getFile === 'function';
}

function errorName(err: unknown): string {
  return typeof err === 'object' && err !== null ? String((err as { name?: unknown }).name ?? '') : '';
}

/** The picker where the browser has it (Chrome and Edge, in a secure context). */
export function browserFileAccess(win: Window = window): FileAccess {
  const w = win as unknown as PickerWindow;
  const canConnect = 'showOpenFilePicker' in win && win.isSecureContext === true;
  return {
    canConnect,
    async pick() {
      if (!canConnect || !w.showOpenFilePicker) return null;
      try {
        const handles = await w.showOpenFilePicker({
          types: [{ description: 'DS save', accept: { 'application/octet-stream': ['.dsv', '.sav'] } }],
          multiple: false,
        });
        return handles[0] ? wrapHandle(handles[0]) : null;
      } catch (err) {
        if (errorName(err) === 'AbortError') return null;
        throw err;
      }
    },
    fromStored(handle) {
      return isFileHandle(handle) ? wrapHandle(handle) : null;
    },
  };
}

export function stampOf(file: File): FileStamp {
  return { lastModified: file.lastModified, size: file.size };
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.lastModified === b.lastModified && a.size === b.size;
}

export interface PollOptions {
  pollMs: number;
  /** How long a change must hold still before it counts as written. Default 750. */
  settleMs?: number;
  /** The stamp of the file as last uploaded. */
  last: FileStamp;
  /** A write has settled: the later `File`. The poll waits for this to finish before it ticks again. */
  onSettled(file: File): void | Promise<void>;
  /** The file could not be read for a reason other than a write in progress. The poll carries on. */
  onUnreadable(error: unknown): void;
  /** The first good read after `onUnreadable`. */
  onReadable(): void;
  doc?: Document;
}

export interface Poller {
  stop(): void;
  setLast(stamp: FileStamp): void;
}

/** What one read of the file gave: the file, or a write in progress (`null`). Anything else it throws. */
async function readFile(file: SaveFile): Promise<File | null> {
  try {
    return await file.getFile();
  } catch (err) {
    if (errorName(err) === 'NotReadableError') return null;
    throw err;
  }
}

export function startPoll(file: SaveFile, opts: PollOptions): Poller {
  const doc = opts.doc ?? document;
  const settleMs = opts.settleMs ?? 750;
  let last = opts.last;
  let stopped = false;
  let busy = false;
  let unreadable = false;
  const sleepers = new Set<{ timer: ReturnType<typeof setTimeout>; wake: () => void }>();

  const visible = () => doc.visibilityState === 'visible';

  /** Waits `ms`, or until `stop()`. */
  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry = { timer: setTimeout(() => { sleepers.delete(entry); resolve(); }, ms), wake: resolve };
      sleepers.add(entry);
    });
  }

  /** A read that reports other errors to `onUnreadable` (`failed` is then true), and the first good one to `onReadable`. */
  async function look(): Promise<{ failed: true } | { failed: false; file: File | null }> {
    let got: File | null;
    try {
      got = await readFile(file);
    } catch (err) {
      if (stopped) return { failed: true };
      unreadable = true;
      opts.onUnreadable(err);
      return { failed: true };
    }
    if (stopped) return { failed: true };
    if (unreadable) {
      unreadable = false;
      opts.onReadable();
    }
    return { failed: false, file: got };
  }

  async function tick(): Promise<void> {
    if (stopped || busy || !visible()) return;
    busy = true;
    try {
      const first = await look();
      if (first.failed) return;
      if (first.file && sameStamp(stampOf(first.file), last)) return;
      // A change (or a write in progress): wait, look again, and settle when two looks in a row agree.
      let previous = first.file;
      for (;;) {
        await sleep(settleMs);
        if (stopped || !visible()) return;
        const again = await look();
        if (again.failed) return;
        if (again.file && previous && sameStamp(stampOf(again.file), stampOf(previous))) {
          // `setLast` may have named this stamp while the look was under way: it is sent already.
          if (sameStamp(stampOf(again.file), last)) return;
          await opts.onSettled(again.file);
          return;
        }
        previous = again.file;
      }
    } finally {
      busy = false;
    }
  }

  const onVisibility = () => { if (visible()) void tick(); };
  const interval = setInterval(() => { void tick(); }, opts.pollMs);
  doc.addEventListener('visibilitychange', onVisibility);
  // A look at once: the poller is often made just after the tab became visible (in the Web Lock's callback), when its
  // own listener has missed that event, and the first interval tick is `pollMs` away.
  void tick();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      doc.removeEventListener('visibilitychange', onVisibility);
      for (const s of sleepers) { clearTimeout(s.timer); s.wake(); }
      sleepers.clear();
    },
    setLast(stamp) {
      last = stamp;
    },
  };
}
