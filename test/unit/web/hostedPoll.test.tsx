// The hosted page's file access: the poll that follows a connected save file and `browserFileAccess`. Fake timers drive
// the poll; the "file" is a fake `SaveFile` the test changes, and the document a fake with a visibility state and listeners.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserFileAccess, startPoll, stampOf, type FileStamp, type Poller, type SaveFile } from '../../../web/src/hosted/fileAccess';

const POLL = 2000;
const SETTLE = 750;
const makeFile = (modified: number, size = 10) => new File([new Uint8Array(size)], 'save.dsv', { lastModified: modified });

interface FakeFile extends SaveFile { file: File; reads: number; next: unknown[] }
/** A save file whose `next` outcomes come first: a File is returned, anything else thrown. */
function fakeSaveFile(initial: File): FakeFile {
  const f: FakeFile = {
    handle: {}, name: 'save.dsv', file: initial, reads: 0, next: [],
    async getFile() {
      f.reads += 1;
      if (f.next.length === 0) return f.file;
      const n = f.next.shift();
      if (n instanceof File) return n;
      throw n;
    },
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
  };
  return f;
}
function fakeDoc(state: 'visible' | 'hidden' = 'visible') {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: state as string,
    addEventListener: (_t: string, l: () => void) => { listeners.add(l); },
    removeEventListener: (_t: string, l: () => void) => { listeners.delete(l); },
  };
  return { doc: doc as unknown as Document, listeners, set(s: 'visible' | 'hidden') { doc.visibilityState = s; for (const l of [...listeners]) l(); } };
}
function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('startPoll', () => {
  let poller: Poller | null = null;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { poller?.stop(); poller = null; vi.useRealTimers(); });

  function start(file: FakeFile, d = fakeDoc(), last: FileStamp = stampOf(file.file)) {
    const calls = { onSettled: vi.fn(), onUnreadable: vi.fn(), onReadable: vi.fn() };
    poller = startPoll(file, { pollMs: POLL, last, ...calls, doc: d.doc });
    return calls;
  }

  it('reads on every tick but settles nothing while the stamp is unchanged, nor a stamp set as the last', async () => {
    const file = fakeSaveFile(makeFile(1000));
    const { onSettled } = start(file);
    await advance(POLL * 5);
    expect(file.reads).toBeGreaterThanOrEqual(4);
    file.file = makeFile(2000);
    poller!.setLast(stampOf(file.file));
    await advance(POLL * 4);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('settles a change 750 ms after it is seen, the wait starting over when the stamp changes during it', async () => {
    const file = fakeSaveFile(makeFile(1000));
    const { onSettled } = start(file);
    file.file = makeFile(2000);
    await advance(POLL);                                       // sees 2000
    expect(onSettled).not.toHaveBeenCalled();
    file.file = makeFile(3000);                                // changes during the wait
    await advance(SETTLE);
    expect(onSettled).not.toHaveBeenCalled();
    await advance(SETTLE);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]![0].lastModified).toBe(3000);
  });

  it('counts a NotReadableError, during the wait or at the first read, as a change', async () => {
    const file = fakeSaveFile(makeFile(1000));
    const { onSettled, onUnreadable } = start(file);
    file.file = makeFile(2000);
    await advance(POLL);
    file.next = [domError('NotReadableError')];                // the look after the wait throws
    await advance(SETTLE * 2);
    expect(onSettled).not.toHaveBeenCalled();                 // 2000 after an unreadable look is not yet "the same twice"
    await advance(SETTLE);
    expect(onSettled).toHaveBeenCalledTimes(1);
    poller!.stop();
    // The write under way when the first look fails ends in a new stamp.
    const fresh = fakeSaveFile(makeFile(1000));
    const second = start(fresh);
    fresh.next = [domError('NotReadableError')];
    fresh.file = makeFile(2000);
    await advance(POLL + SETTLE * 3);
    expect(second.onSettled.mock.calls.map((c) => c[0].lastModified)).toEqual([2000]);
    expect([onUnreadable, second.onUnreadable].map((f) => f.mock.calls.length)).toEqual([0, 0]);
  });

  it('reads nothing while hidden, at once when the tab becomes visible, and at once when it starts in a visible tab', async () => {
    const file = fakeSaveFile(makeFile(1000));
    const d = fakeDoc('hidden');
    const { onSettled } = start(file, d);
    file.file = makeFile(2000);
    await advance(POLL * 5);
    expect(file.reads).toBe(0);
    d.set('visible');
    await advance(0);
    expect(file.reads).toBe(1);
    await advance(SETTLE);
    expect(onSettled).toHaveBeenCalledTimes(1);
    poller!.stop();
    const changed = fakeSaveFile(makeFile(2000));
    const visible = start(changed, fakeDoc(), stampOf(makeFile(1000)));
    await advance(0);
    expect(changed.reads).toBe(1);
    await advance(SETTLE);
    expect(visible.onSettled).toHaveBeenCalledTimes(1);
  });

  it('calls onUnreadable on another error, keeps polling, and onReadable on the next good read, once each', async () => {
    const file = fakeSaveFile(makeFile(1000));
    const { onUnreadable, onReadable, onSettled } = start(file);
    const boom = domError('NotFoundError');
    file.next = [boom];
    await advance(POLL);
    expect(onUnreadable).toHaveBeenCalledExactlyOnceWith(boom);
    expect(onReadable).not.toHaveBeenCalled();
    await advance(POLL * 3);
    expect([onUnreadable.mock.calls.length, onReadable.mock.calls.length, onSettled.mock.calls.length]).toEqual([1, 1, 0]);
  });

  it('stop() stops reads, removes the listener, and ends a settle wait without calling onSettled', async () => {
    const file = fakeSaveFile(makeFile(1000));
    const d = fakeDoc();
    const { onSettled } = start(file, d);
    expect(d.listeners.size).toBe(1);
    file.file = makeFile(2000);
    await advance(POLL);
    poller!.stop();
    expect(d.listeners.size).toBe(0);
    const before = file.reads;
    await advance(POLL * 5);
    expect(file.reads).toBe(before);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('never overlaps ticks while onSettled is still running', async () => {
    const file = fakeSaveFile(makeFile(1000));
    let release: () => void = () => {};
    const onSettled = vi.fn(() => new Promise<void>((r) => { release = r; }));
    poller = startPoll(file, { pollMs: POLL, last: stampOf(file.file), onSettled, onUnreadable: vi.fn(), onReadable: vi.fn(), doc: fakeDoc().doc });
    file.file = makeFile(2000);
    await advance(POLL + SETTLE);
    expect(onSettled).toHaveBeenCalledTimes(1);
    const readsBefore = file.reads;
    await advance(POLL * 3);
    expect(file.reads).toBe(readsBefore);
    poller.setLast(stampOf(file.file));
    release();
    await advance(POLL * 2);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(file.reads).toBeGreaterThan(readsBefore);
  });
});

describe('browserFileAccess', () => {
  const win = (over: object) => ({ isSecureContext: true, ...over }) as unknown as Window;

  it('can connect only with the picker in a secure context, and asks for .dsv and .sav', async () => {
    expect(browserFileAccess(win({})).canConnect).toBe(false);
    expect(browserFileAccess(win({ isSecureContext: false, showOpenFilePicker: vi.fn() })).canConnect).toBe(false);
    const picker = vi.fn(async () => [{ name: 'a.dsv', getFile: vi.fn() }]);
    const access = browserFileAccess(win({ showOpenFilePicker: picker }));
    expect(access.canConnect).toBe(true);
    expect((await access.pick())?.name).toBe('a.dsv');
    expect(picker).toHaveBeenCalledWith({ types: [{ description: 'DS save', accept: { 'application/octet-stream': ['.dsv', '.sav'] } }], multiple: false });
  });

  it('pick resolves null on an AbortError and rethrows others; fromStored returns null for anything without getFile', async () => {
    const throwing = (name: string) => browserFileAccess(win({ showOpenFilePicker: vi.fn(async () => { throw domError(name); }) }));
    expect(await throwing('AbortError').pick()).toBeNull();
    await expect(throwing('SecurityError').pick()).rejects.toThrow('SecurityError');
    const access = browserFileAccess(win({}));
    expect([null, {}, 'x'].map((h) => access.fromStored(h))).toEqual([null, null, null]);
    expect(access.fromStored({ name: 'a.dsv', getFile: async () => makeFile(1) })?.name).toBe('a.dsv');
  });
});
