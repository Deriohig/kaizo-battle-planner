// The hosted page's state machine: where the save comes from and what the page says about it. It opens
// on the load screen when the browser holds no save; with one, it asks `GET /api/box` (the API re-sends the stored save
// on `NO_SAVE`, through `resend` here) and goes on with the connected file, if any: polling it, waiting for a click to
// grant the permission again, or upload mode. Only a visible tab polls: it holds the Web Lock `pkp-poll` while it is
// visible (taking it from any other tab) and lets it go when hidden. Uploads by button, drop, the picker, the poll, the
// re-send and a settings save all end in `PUT /api/save`, one at a time through one queue, each reading what to send when
// its turn comes and saying which it is (`x-pkp-save-source`: upload, drop, connected for the picker and the poll, resend,
// settings), for the server's usage log; the bytes are stored only after a 200. The other tabs hear of an accepted save (`{ type: 'box' }`) and
// a removed one (`{ type: 'removed' }`) on the `BroadcastChannel` `pkp`.
// The work is done by a plain object made when the hook mounts and dropped when it unmounts (so React's double mount in
// development makes a second one rather than reusing a closed one); React only draws the view it hands over.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SaveSource } from '../../../src/contracts/hosted';
import type { BoxJson, ConfigJson, HostedSettingsJson } from '../../../src/server/apiTypes';
import { ApiError, deleteSave, errorMessage, getBox, isAbort, NO_ANSWER, putSave, setHosted } from '../api';
import { FLASH_MS } from '../LocalApp';
import { browserFileAccess, startPoll, stampOf, type FileAccess, type FileStamp, type Poller, type SaveFile } from './fileAccess';
import { openSaveStore, type SaveStore, type StoredSave } from './saveStore';
import { readHostedSettings, sessionId, writeHostedSettings } from './session';
import type { HostedWatch } from './types';

export type HostedConfig = Extract<ConfigJson, { mode: 'hosted' }>;

/** What the machine works with. Each one left out gets the browser's own; a test passes fakes, and `null` for none. */
export interface HostedSaveDeps {
  config: HostedConfig;
  store?: SaveStore;
  files?: FileAccess;
  channel?: BroadcastChannel | null;
  locks?: LockManager | null;
}

/** What `HostedApp` draws, and what it can ask for. */
export interface HostedSave {
  phase: 'starting' | 'load' | 'ready';
  box: BoxJson | null;
  fileName: string | null;
  settings: HostedSettingsJson;
  watch: HostedWatch;
  uploading: boolean;
  noAnswer: boolean;
  canConnect: boolean;
  /** The load screen was opened from Settings (Cancel is shown). */
  changing: boolean;
  /** A refusal on the load screen. */
  loadError: string | null;
  /** Why the load screen is open: `Load your save again.` */
  loadReason: string | null;
  /** A refused automatic upload (the server's words). */
  autoError: string | null;
  /** A refused manual upload while in the workspace. */
  uploadError: string | null;
  /** "Box updated", for FLASH_MS after the save changed (its name or time), not after a re-send of the same save. */
  updated: boolean;
  /** A file from a button or picker (`how` 'upload', the default) or a drop ('drop'), as the server's log is told. */
  upload(file: File, how?: ManualSource): Promise<void>;
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  /** Rejects with the error the settings panel shows. */
  saveSettings(s: HostedSettingsJson): Promise<void>;
  changeSave(): void;
  cancelChange(): void;
  removeSave(): Promise<void>;
}

/** How a file the player gave by hand came: a button or picker, or a drop. */
export type ManualSource = Extract<SaveSource, 'upload' | 'drop'>;

type View = Omit<HostedSave,'canConnect' | 'upload' | 'connect' | 'reconnect' | 'saveSettings' | 'changeSave' | 'cancelChange' | 'removeSave'>;

/** What the tabs say to each other on the `pkp` channel. */
type TabMessage = { type: 'box' } | { type: 'removed' };

/** What one automatic upload came to: taken, refused (`bad` is a 422, sent once more), or to be tried again later. */
type AutoResult = 'ok' | 'bad' | 'refused' | 'later' | 'skipped';

type SaveBody = { bytes: ArrayBuffer; name: string; modified: number };

export const TOO_BIG = 'That file is too big to be a save.';
export const LOAD_AGAIN = 'Load your save again.';
/** How often the first `GET /api/box` is tried again while the server does not answer; also the first back-off. */
const RETRY_MS = 3_000;
/** The longest wait between automatic uploads after the server did not take one for a passing reason. */
const MAX_BACKOFF_MS = 60_000;
/** How long after a refused automatic upload the file is read and sent once more (DeSmuME caught mid-write). */
const AUTO_RETRY_MS = 1_500;

const errorName = (e: unknown): string => (typeof e === 'object' && e !== null ? String((e as { name?: unknown }).name ?? '') : '');
const isNoAnswer = (e: unknown): boolean => e instanceof ApiError && e.code === NO_ANSWER;
const isNoSave = (e: unknown): boolean => e instanceof ApiError && e.status === 409 && e.code === 'NO_SAVE';
const isRefused = (e: unknown): boolean => e instanceof ApiError && e.status === 422;
const stampOfSave = (s: StoredSave): FileStamp => ({ lastModified: s.modified, size: s.size });
const visible = (): boolean => typeof document === 'undefined' || document.visibilityState === 'visible';

/** Whether `next` comes from another save than the one shown: another name or another file time. Nothing shown: no. */
function saveChanged(shown: BoxJson | null, next: BoxJson): boolean {
  return shown !== null && (shown.savedAt !== next.savedAt || shown.savePath !== next.savePath);
}

/** A store call whose failure is carried on without (a private window may refuse IndexedDB). */
async function quietly<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    return fallback;
  }
}

/** Whether a stored handle is the file already followed (`isSameEntry` where the browser has it). */
async function sameFile(file: SaveFile, handle: unknown): Promise<boolean> {
  if (file.handle === handle) return true;
  const own = file.handle as { isSameEntry?: (other: unknown) => Promise<boolean> } | null;
  if (typeof own?.isSameEntry !== 'function') return false;
  return quietly(() => own.isSameEntry!(handle), false);
}

function firstView(): View {
  return {
    phase: 'starting', box: null, fileName: null, settings: readHostedSettings(), watch: 'upload', uploading: false, noAnswer: false,
    changing: false, loadError: null, loadReason: null, autoError: null, uploadError: null, updated: false,
  };
}

/** The machine. One per mount; `dispose` ends its timers, its poll and its channel, and it draws nothing after. */
class Machine {
  private view: View = firstView();
  private alive = true;
  /** The last save the server accepted, kept here as well as in the store (a store that throws still leaves this). */
  private record: StoredSave | null = null;
  /** The box on screen, to tell a changed save from the same one sent again. */
  private shown: BoxJson | null = null;
  /** The connected file, polled or waiting for its permission. */
  private file: SaveFile | null = null;
  /** Counts each poll started or stopped, so the work of a stopped one ends there. */
  private pollGen = 0;
  /** Ends the current poll: its poller, its lock and its visibility listener. */
  private pollStop: (() => void) | null = null;
  /** Counts each time the save was forgotten (removed here or in another tab), so work begun before ends there. */
  private gen = 0;
  /** The uploads, one after another: each `PUT /api/save` runs in its own turn. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The number of the last PUT sent, and of the last whose answer was taken (an older answer is never shown). */
  private seq = 0;
  private acceptedSeq = 0;
  /** PUTs under way, for `uploading`. */
  private uploads = 0;
  /** After an automatic upload the server did not take for a passing reason, the next waits (`backoffMs`, doubling). */
  private backoff = false;
  private backoffMs = 0;
  /** Why the last re-send failed, so the first `GET /api/box` can tell a server that did not answer from a lost save. */
  private resendFailure: unknown = null;
  /** The first box has been had (by `GET /api/box` or an upload), or the save was removed: the start's retries stop. */
  private started = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly channel: BroadcastChannel | null;
  private readonly ownChannel: boolean;
  private readonly onMessage = (e: MessageEvent) => { this.heard(e.data as TabMessage); };

  constructor(
    private readonly config: HostedConfig,
    private readonly store: SaveStore,
    private readonly files: FileAccess,
    channel: BroadcastChannel | null | undefined,
    private readonly locks: LockManager | null,
    private readonly draw: (view: View) => void,
  ) {
    this.ownChannel = channel === undefined;
    this.channel = channel === undefined ? (typeof BroadcastChannel === 'function' ? new BroadcastChannel('pkp') : null) : channel;
    this.channel?.addEventListener('message', this.onMessage);
  }

  private set(patch: Partial<View>): void {
    this.view = { ...this.view, ...patch };
    if (this.alive) this.draw(this.view);
  }

  private later(ms: number, work: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.alive) work();
    }, ms);
    this.timers.add(timer);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.later(ms, resolve));
  }

  private post(message: TabMessage): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // a closed channel: the other tabs catch up on their next read
    }
  }

  private flash(): void {
    clearTimeout(this.flashTimer);
    this.set({ updated: true });
    this.flashTimer = setTimeout(() => { this.set({ updated: false }); }, FLASH_MS);
  }

  /** Shows `box`, flashing when it comes from a changed save. */
  private show(box: BoxJson): void {
    const changed = saveChanged(this.shown, box);
    this.shown = box;
    this.set({ box });
    if (changed) this.flash();
  }

  // The upload queue.

  /** Runs `work` when every upload queued before it has finished. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * One `PUT /api/save`, from inside a queued turn, counted in `uploading`, saying how it came (`source`). Any answer from
   * the server clears "no answer". Resolves with the box and the PUT's number.
   */
  private async send(save: SaveBody, settings: HostedSettingsJson, source: SaveSource): Promise<{ box: BoxJson; seq: number }> {
    const seq = ++this.seq;
    this.uploads += 1;
    this.set({ uploading: true });
    try {
      const box = await putSave(save, settings, source);
      this.set({ noAnswer: false });
      return { box, seq };
    } catch (error) {
      if (error instanceof ApiError && !isNoAnswer(error)) this.set({ noAnswer: false });
      throw error;
    } finally {
      this.uploads -= 1;
      this.set({ uploading: this.uploads > 0 });
    }
  }

  /** Whether an answer may still be shown: the machine lives, the save was not forgotten since, and nothing newer was taken. */
  private current(gen: number, seq: number): boolean {
    return this.alive && gen === this.gen && seq > this.acceptedSeq;
  }

  /**
   * The server accepted `rec` (PUT number `seq`) and answered `box`: it is kept, shown and told to the other tabs, and the
   * workspace opens. A poll's upload (`byPoll`) leaves a load screen opened from Settings where it is.
   */
  private async accepted(rec: StoredSave, box: BoxJson, seq: number, byPoll = false): Promise<void> {
    this.acceptedSeq = seq;
    this.record = rec;
    this.started = true;
    await quietly(() => this.store.writeSave(rec), undefined);
    if (!this.alive) return;
    this.show(box);
    const toWorkspace = this.view.phase !== 'ready' && !(byPoll && this.view.changing);
    this.set({
      fileName: rec.name, noAnswer: false, autoError: null, uploadError: null, loadError: null,
      ...(toWorkspace ? { phase: 'ready' as const, changing: false, loadReason: null } : {}),
    });
    this.post({ type: 'box' });
  }

  /** Where a refusal is said: on the load screen, or in the workspace's banner. */
  private refused(message: string): void {
    if (this.view.phase === 'ready') this.set({ uploadError: message });
    else this.set({ loadError: message });
  }

  private toLoad(reason: string | null): void {
    this.set({ phase: 'load', loadReason: reason, loadError: null, changing: false });
  }

  // The start.

  async start(): Promise<void> {
    setHosted({ session: sessionId, resend: () => this.resend() });
    const rec = await quietly(() => this.store.readSave(), null);
    if (!this.alive) return;
    if (rec === null) {
      if (this.view.phase === 'starting') this.toLoad(null);
      return;
    }
    this.record ??= rec;
    this.set({ fileName: this.record.name });
    await this.firstBox();
  }

  /** The first `GET /api/box`, tried again every 3 s while the server does not answer; then the connected file. */
  private async firstBox(): Promise<void> {
    if (this.started) return;
    const gen = this.gen;
    try {
      const box = await getBox();
      if (!this.alive || this.started || gen !== this.gen) return;
      this.started = true;
      this.show(box);
      this.set({ phase: this.view.phase === 'load' && this.view.changing ? 'load' : 'ready', noAnswer: false });
      await this.resumeFile();
    } catch (error) {
      if (!this.alive || this.started || gen !== this.gen) return;
      // A failed re-send rejects with the first NO_SAVE: its own failure says what really happened.
      const why = isNoSave(error) && this.resendFailure !== null ? this.resendFailure : error;
      if (isNoAnswer(why)) {
        // The page says "Reconnecting…" next to the stored save's name until the server answers.
        this.set({ phase: this.view.phase === 'starting' ? 'ready' : this.view.phase, noAnswer: true });
        this.later(RETRY_MS, () => { void this.firstBox(); });
      } else if (this.view.phase === 'load') {
        // the re-send has opened the load screen already
      } else if (isNoSave(why)) {
        this.toLoad(LOAD_AGAIN);
      } else {
        this.set({ phase: 'load', loadError: errorMessage(why), noAnswer: false });
      }
    }
  }

  /**
   * The stored handle: polled when the permission holds, a Reconnect button when it must be asked, else upload mode. A save
   * uploaded by hand (now, or while this ran) means no connection: the handle is dropped.
   */
  private async resumeFile(): Promise<void> {
    const gen = this.gen;
    const since = this.acceptedSeq;
    const stale = () => !this.alive || gen !== this.gen || this.acceptedSeq !== since;
    if (this.record?.source === 'upload') {
      await this.disconnect();
      return;
    }
    const handle = await quietly(() => this.store.readHandle(), null);
    const file = handle === null ? null : this.files.fromStored(handle);
    if (stale()) return;
    if (file === null) {
      this.set({ watch: 'upload' });
      return;
    }
    let permission: string;
    try {
      permission = await file.queryPermission();
    } catch {
      permission = 'denied';
    }
    if (stale()) return;
    if (permission === 'granted') this.poll(file);
    else if (permission === 'prompt') {
      this.stopPoll();
      this.file = file;
      this.set({ watch: 'needs-permission' });
    } else await this.disconnect();
  }

  // The connected file.

  private stopPoll(): void {
    this.pollGen += 1;
    this.pollStop?.();
    this.pollStop = null;
  }

  /** Drops the connected file: no poll, no stored handle, upload mode. The stored bytes stay. */
  private async disconnect(): Promise<void> {
    this.stopPoll();
    this.file = null;
    this.set({ watch: 'upload' });
    await quietly(() => this.store.clearHandle(), undefined);
  }

  /**
   * Follows `file`. With Web Locks, it polls only while this tab is visible and holds `pkp-poll`: it takes the lock (from
   * any other tab) when it becomes visible and lets it go when hidden; a tab the lock was taken from waits for it again.
   * "Watching for saves" is said once the lock is held.
   */
  private poll(file: SaveFile): void {
    this.stopPoll();
    const gen = this.pollGen;
    this.file = file;
    const begin = (): Poller => {
      const poller: Poller = startPoll(file, {
        pollMs: this.config.pollMs,
        // What was last uploaded, as of now: another tab may have uploaded while this one waited for the lock.
        last: this.record === null ? { lastModified: 0, size: -1 } : stampOfSave(this.record),
        onSettled: (f) => this.settled(file, poller, gen, f),
        onUnreadable: (error) => {
          if (gen !== this.pollGen) return;
          if (errorName(error) === 'NotFoundError') void this.disconnect();
          else this.set({ watch: 'unreadable' });
        },
        onReadable: () => { if (gen === this.pollGen) this.set({ watch: 'polling' }); },
      });
      return poller;
    };

    const locks = this.locks;
    if (locks === null) {
      this.set({ watch: 'polling' });
      const poller = begin();
      this.pollStop = () => poller.stop();
      return;
    }

    // One request at a time: what it may hold (the waiting request's abort, the held lock's release, the poller).
    type LockRequest = { abort?: AbortController; release?: () => void; poller?: Poller };
    let req: LockRequest | null = null;
    const drop = () => {
      const r = req;
      req = null;
      r?.poller?.stop();
      r?.abort?.abort();
      r?.release?.();
    };
    const take = (steal: boolean) => {
      if (req !== null || gen !== this.pollGen || !this.alive) return;
      const r: LockRequest = {};
      req = r;
      const options: LockOptions = steal ? { steal: true } : { signal: (r.abort = new AbortController()).signal };
      locks.request('pkp-poll', options, () => new Promise<void>((release) => {
        if (req !== r || gen !== this.pollGen || !this.alive || !visible()) {
          release();
          if (req === r) req = null;
          return;
        }
        r.release = release;
        this.set({ watch: 'polling' });
        r.poller = begin();
      })).catch(() => {
        if (req !== r) return; // let go by this tab
        // Taken by a tab that became visible: it polls now. This one waits for the lock again while it is visible.
        r.poller?.stop();
        req = null;
        if (visible()) take(false);
      });
    };
    const onVisibility = () => {
      if (visible()) take(true);
      else drop();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (visible()) take(true);
    this.pollStop = () => {
      document.removeEventListener('visibilitychange', onVisibility);
      drop();
    };
  }

  /**
   * A write to the connected file has settled: send it. A refusal moves the poll on to the next write, after one more try
   * 1.5 s later for a 422; a passing failure (no answer, 408, 429, 5xx) leaves it to be sent again.
   */
  private async settled(file: SaveFile, poller: Poller, pgen: number, f: File): Promise<void> {
    const first = await this.autoUpload(f, pgen);
    if (first === 'ok' || first === 'refused') {
      poller.setLast(stampOf(f));
      return;
    }
    if (first !== 'bad') return;
    await this.sleep(AUTO_RETRY_MS);
    if (!this.alive || pgen !== this.pollGen) return;
    let again: File;
    try {
      again = await file.getFile();
    } catch {
      poller.setLast(stampOf(f));
      return;
    }
    const second = await this.autoUpload(again, pgen);
    if (second !== 'later' && second !== 'skipped') poller.setLast(stampOf(again));
  }

  /** Waits before the next automatic upload: doubling from 3 s up to a minute, or the server's `Retry-After` if longer. */
  private pause(error: ApiError): void {
    this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(RETRY_MS, this.backoffMs * 2));
    const ms = Math.max(this.backoffMs, (error.retryAfter ?? 0) * 1000);
    this.backoff = true;
    this.later(ms, () => { this.backoff = false; });
  }

  /** The poll's upload, in its queued turn. An answer the server gave is taken even if the poll stopped meanwhile. */
  private autoUpload(f: File, pgen: number): Promise<AutoResult> {
    const gen = this.gen;
    return this.enqueue(async (): Promise<AutoResult> => {
      if (!this.alive || gen !== this.gen || pgen !== this.pollGen) return 'skipped';
      if (this.backoff) return 'later';
      if (f.size > this.config.maxSaveBytes) {
        this.set({ autoError: TOO_BIG });
        return 'refused';
      }
      let bytes: ArrayBuffer;
      try {
        bytes = await f.arrayBuffer();
      } catch {
        return 'later'; // written again under the read (NotReadableError): the next tick sees the change
      }
      try {
        const { box, seq } = await this.send({ bytes, name: f.name, modified: f.lastModified }, readHostedSettings(), 'connected');
        this.backoffMs = 0;
        if (this.current(gen, seq)) {
          await this.accepted({ bytes, name: f.name, modified: f.lastModified, size: f.size, source: 'connected' }, box, seq, true);
        }
        return 'ok';
      } catch (error) {
        if (!this.alive || gen !== this.gen) return 'skipped';
        if (!(error instanceof ApiError)) return 'later';
        if (isNoAnswer(error)) {
          this.set({ noAnswer: true });
          this.pause(error);
          return 'later';
        }
        this.set({ autoError: errorMessage(error) });
        if (error.status === 408 || error.status === 429 || error.status >= 500) {
          this.pause(error);
          return 'later';
        }
        return error.status === 422 ? 'bad' : 'refused';
      }
    });
  }

  // What the page asks for.

  /** A file from the button, the load screen or a drop (`how`). Once it is accepted, any connected file is dropped. */
  async upload(f: File, how: ManualSource = 'upload'): Promise<void> {
    this.set({ loadError: null, uploadError: null });
    if (f.size > this.config.maxSaveBytes) {
      this.refused(TOO_BIG);
      return;
    }
    const gen = this.gen;
    try {
      await this.enqueue(async () => {
        const bytes = await f.arrayBuffer();
        const { box, seq } = await this.send({ bytes, name: f.name, modified: f.lastModified }, readHostedSettings(), how);
        if (!this.current(gen, seq)) return;
        await this.disconnect();
        await this.accepted({ bytes, name: f.name, modified: f.lastModified, size: f.size, source: 'upload' }, box, seq);
      });
    } catch (error) {
      if (this.alive && gen === this.gen && !isAbort(error)) this.refused(errorMessage(error));
    }
  }

  /** "Connect save file": the picker, then the file's upload; on a 200 its handle is kept and polled. */
  async connect(): Promise<void> {
    this.set({ loadError: null, uploadError: null });
    let file: SaveFile | null;
    try {
      file = await this.files.pick();
    } catch (error) {
      this.refused(errorMessage(error));
      return;
    }
    if (file === null || !this.alive) return;
    const picked = file;
    const gen = this.gen;
    try {
      await this.enqueue(async () => {
        const f = await picked.getFile();
        if (f.size > this.config.maxSaveBytes) {
          this.refused(TOO_BIG);
          return;
        }
        const bytes = await f.arrayBuffer();
        const { box, seq } = await this.send({ bytes, name: f.name, modified: f.lastModified }, readHostedSettings(), 'connected');
        if (!this.current(gen, seq)) return;
        this.stopPoll();
        await quietly(() => this.store.writeHandle(picked.handle), undefined);
        await this.accepted({ bytes, name: f.name, modified: f.lastModified, size: f.size, source: 'connected' }, box, seq);
        if (this.alive && gen === this.gen) this.poll(picked);
      });
    } catch (error) {
      if (this.alive && gen === this.gen && !isAbort(error)) this.refused(errorMessage(error));
    }
  }

  /** "Reconnect save file": the browser asks the player (this needs the click); granted polls, else upload mode. */
  async reconnect(): Promise<void> {
    const file = this.file;
    if (file === null) {
      this.set({ watch: 'upload' });
      return;
    }
    let permission: string;
    try {
      permission = await file.requestPermission();
    } catch {
      permission = 'denied';
    }
    if (!this.alive || this.file !== file) return;
    if (permission === 'granted') this.poll(file);
    else await this.disconnect();
  }

  /**
   * The API's re-send, in its queued turn: the stored save `PUT` again with the current settings. Nothing is sent when
   * an upload was accepted while it waited (the server holds a box again). No record, or a refusal, opens the load screen
   * with `Load your save again.` (a refused record is dropped, with its handle); every failure rejects, so the waiting
   * calls fail with their `NO_SAVE`.
   */
  resend(): Promise<void> {
    const gen = this.gen;
    const before = this.acceptedSeq;
    return this.enqueue(async () => {
      this.resendFailure = null;
      const fail = (error: unknown): never => {
        this.resendFailure = error;
        throw error;
      };
      if (!this.alive || gen !== this.gen) fail(new Error('The save was removed'));
      if (this.acceptedSeq !== before) return;
      const rec = this.record ?? await quietly(() => this.store.readSave(), null);
      if (!this.alive || gen !== this.gen) fail(new Error('The save was removed'));
      if (rec === null) {
        this.toLoad(LOAD_AGAIN);
        fail(new Error('No stored save'));
        return;
      }
      try {
        const { box, seq } = await this.send(rec, readHostedSettings(), 'resend');
        if (!this.current(gen, seq)) return;
        this.acceptedSeq = seq;
        this.record = rec;
        this.show(box);
      } catch (error) {
        if (this.alive && gen === this.gen && isRefused(error)) {
          // A file the server refuses is never kept, so the next visit does not send it again.
          this.record = null;
          this.stopPoll();
          this.file = null;
          this.set({ watch: 'upload' });
          await quietly(() => this.store.clearAll(), undefined);
          this.toLoad(LOAD_AGAIN);
        }
        fail(error);
      }
    });
  }

  async saveSettings(s: HostedSettingsJson): Promise<void> {
    writeHostedSettings(s);
    this.set({ settings: { graveyardBox: s.graveyardBox, levelCapOverride: s.levelCapOverride } });
    const gen = this.gen;
    await this.enqueue(async () => {
      const rec = this.record ?? await quietly(() => this.store.readSave(), null);
      if (rec === null || !this.alive || gen !== this.gen) return;
      const { box, seq } = await this.send(rec, s, 'settings');
      if (!this.current(gen, seq)) return;
      this.acceptedSeq = seq;
      this.show(box);
      this.post({ type: 'box' });
    });
  }

  changeSave(): void {
    this.set({ phase: 'load', changing: true, loadError: null, loadReason: null });
  }

  cancelChange(): void {
    this.set({ phase: this.shown === null && this.record === null ? 'load' : 'ready', changing: false, loadError: null });
  }

  /**
   * Forgets the save in this browser and on the server, and opens the load screen. The other tabs are told first; the store
   * and the server are cleared in the upload queue's next turn, so an upload under way cannot put the bytes back after.
   */
  async removeSave(): Promise<void> {
    this.forgetHere();
    this.post({ type: 'removed' });
    await this.enqueue(async () => {
      await quietly(() => this.store.clearAll(), undefined);
      await quietly(() => deleteSave(), undefined);
    });
  }

  /** The save is gone (removed here or in another tab): no poll, nothing shown, the load screen; work under way ends. */
  private forgetHere(): void {
    this.gen += 1;
    this.started = true;
    this.stopPoll();
    this.file = null;
    this.record = null;
    this.shown = null;
    this.set({
      phase: 'load', box: null, fileName: null, watch: 'upload', changing: false, loadError: null, loadReason: null, autoError: null,
      uploadError: null, noAnswer: false,
    });
  }

  // The other tabs.

  private heard(message: TabMessage): void {
    if (!this.alive || typeof message !== 'object' || message === null) return;
    if (message.type === 'removed') this.forgetHere();
    else if (message.type === 'box') void this.otherTabSaved();
  }

  /** Another tab sent a save or new settings: read the settings, the stored save, its file and the box again. */
  private async otherTabSaved(): Promise<void> {
    const gen = this.gen;
    const stale = () => !this.alive || gen !== this.gen;
    this.set({ settings: readHostedSettings() });
    const rec = await quietly(() => this.store.readSave(), null);
    if (stale()) return;
    if (rec !== null) {
      this.record = rec;
      this.set({ fileName: rec.name });
    }
    // A manual upload there dropped the connection; a file connected there (or another one) is taken up here, and the
    // lock keeps the polling to the visible tab.
    const handle = await quietly(() => this.store.readHandle(), null);
    if (stale()) return;
    if (handle === null && this.file !== null) {
      this.stopPoll();
      this.file = null;
      this.set({ watch: 'upload' });
    } else if (handle !== null && (this.file === null || !(await sameFile(this.file, handle)))) {
      if (stale()) return;
      void this.resumeFile();
    }
    try {
      const box = await getBox();
      if (stale()) return;
      this.started = true;
      this.set({ noAnswer: false });
      this.show(box);
      if (this.view.phase !== 'ready' && !this.view.changing) this.set({ phase: 'ready', loadReason: null, loadError: null });
    } catch {
      // this tab keeps what it shows; its next call re-sends if it must
    }
  }

  dispose(): void {
    this.alive = false;
    setHosted(null);
    this.stopPoll();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    clearTimeout(this.flashTimer);
    this.channel?.removeEventListener('message', this.onMessage);
    if (this.ownChannel) this.channel?.close();
  }
}

/** The hosted save's state and actions. `deps` is read once, when the hook mounts. */
export function useHostedSave(deps: HostedSaveDeps): HostedSave {
  const [view, setView] = useState<View>(firstView);
  const machine = useRef<Machine | null>(null);
  const first = useRef(deps);
  const [files] = useState(() => deps.files ?? browserFileAccess());

  useEffect(() => {
    const d = first.current;
    const locks = d.locks !== undefined ? d.locks : (typeof navigator !== 'undefined' && navigator.locks) || null;
    const m = new Machine(d.config, d.store ?? openSaveStore(), files, d.channel, locks, setView);
    machine.current = m;
    void m.start();
    return () => {
      m.dispose();
      if (machine.current === m) machine.current = null;
    };
  }, [files]);

  const upload = useCallback(async (f: File, how?: ManualSource) => machine.current?.upload(f, how), []);
  const connect = useCallback(async () => machine.current?.connect(), []);
  const reconnect = useCallback(async () => machine.current?.reconnect(), []);
  const saveSettings = useCallback(async (s: HostedSettingsJson) => machine.current?.saveSettings(s), []);
  const changeSave = useCallback(() => machine.current?.changeSave(), []);
  const cancelChange = useCallback(() => machine.current?.cancelChange(), []);
  const removeSave = useCallback(async () => machine.current?.removeSave(), []);

  return useMemo(() => ({
    ...view, canConnect: files.canConnect, upload, connect, reconnect, saveSettings, changeSave, cancelChange, removeSave,
  }), [view, files, upload, connect, reconnect, saveSettings, changeSave, cancelChange, removeSave]);
}
