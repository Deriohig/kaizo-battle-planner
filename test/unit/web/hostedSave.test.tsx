// The hosted page's state machine (`useHostedSave`): the load screen, uploads, the stored save sent
// again when the server has lost the session, the connected file's permission and poll, the settings and removing the
// save, and the other tabs' messages. The server is `stubHosted`, the store a memory one, the file access a fake.

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBox, postPlanStep, postSheet, setHosted, type SheetQuery } from '../../../web/src/api';
import type { FileAccess, FilePermission, SaveFile } from '../../../web/src/hosted/fileAccess';
import { memorySaveStore, type SaveStore, type StoredSave } from '../../../web/src/hosted/saveStore';
import { SETTINGS_KEY } from '../../../web/src/hosted/session';
import { useHostedSave, type HostedConfig, type HostedSaveDeps } from '../../../web/src/hosted/useHostedSave';
import type { PlanStepRequestJson } from '../../../web/src/planTypes';
import { GRAVEYARD_HEADER, LEVEL_CAP_HEADER, SAVE_SOURCE_HEADER } from '../../../src/contracts/hosted';
import { stubHosted } from './hostedServer';

const CONFIG: HostedConfig = { mode: 'hosted', version: 'test', maxSaveBytes: 1_048_576, pollMs: 2_000 };
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const BAD_SAVE = { status: 422, json: { error: 'The save is cut short', code: 'BAD_SAVE' } };

function saveFile(name = 'plat.dsv', modified = T0, size = 64): File {
  return new File([new Uint8Array(size)], name, { lastModified: modified });
}

async function stored(file: File, source: StoredSave['source'] = 'upload'): Promise<StoredSave> {
  return { bytes: await file.arrayBuffer(), name: file.name, modified: file.lastModified, size: file.size, source };
}

interface FakeHandle extends SaveFile {
  file: File;
  permission: FilePermission;
  granted: FilePermission;
}

/** A connected file: `file` is what `getFile` gives, `permission` what `queryPermission` says, `granted` the prompt's answer. */
function fakeHandle(file: File, permission: FilePermission = 'granted'): FakeHandle {
  const h: FakeHandle = {
    file, permission, granted: 'granted',
    get handle() { return h; },
    name: file.name,
    getFile: async () => h.file,
    queryPermission: async () => h.permission,
    requestPermission: async () => { h.permission = h.granted; return h.granted; },
  };
  return h;
}

function fakeFiles(canConnect = true, picked: SaveFile | null = null): FileAccess & { pick: ReturnType<typeof vi.fn> } {
  return {
    canConnect,
    pick: vi.fn(async () => picked),
    fromStored: (h: unknown) => (typeof h === 'object' && h !== null && 'getFile' in h ? h as SaveFile : null),
  };
}

/** A `BroadcastChannel` stand-in: `posted` holds what the hook sent, `deliver` hands it a message from another tab. */
function fakeChannel() {
  const listeners = new Set<(e: MessageEvent) => void>();
  const posted: unknown[] = [];
  const channel = {
    postMessage: (data: unknown) => { posted.push(data); },
    addEventListener: (_t: string, l: (e: MessageEvent) => void) => { listeners.add(l); },
    removeEventListener: (_t: string, l: (e: MessageEvent) => void) => { listeners.delete(l); },
    close: vi.fn(),
  };
  return {
    channel: channel as unknown as BroadcastChannel,
    posted,
    close: channel.close,
    deliver(data: unknown) { for (const l of [...listeners]) l(new MessageEvent('message', { data })); },
  };
}

function setup(over: Partial<HostedSaveDeps> = {}) {
  const store = over.store ?? memorySaveStore();
  const files = over.files ?? fakeFiles();
  const deps: HostedSaveDeps = { config: CONFIG, store, files, channel: null, locks: null, ...over };
  const view = renderHook(() => useHostedSave(deps));
  return { ...view, store, files };
}

const gets = (calls: { method: string; url: string }[]) => calls.filter((c) => c.method === 'GET' && c.url === '/api/box');
/** The `x-pkp-save-source` each upload carried, in order. */
const sources = (puts: { headers: Headers }[]) => puts.map((c) => c.headers.get(SAVE_SOURCE_HEADER));

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(() => {
  setHosted(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the load screen and uploads', () => {
  it.each(['upload', 'drop'] as const)('opens the load screen with no stored save; an upload (%s) shows the box and stores the bytes as an upload', async (via) => {
    const server = stubHosted();
    const { result, store } = setup();
    await waitFor(() => expect(result.current.phase).toBe('load'));
    expect(server.calls).toHaveLength(0);
    await act(() => result.current.upload(saveFile(), via));
    expect(result.current).toMatchObject({ phase: 'ready', box: { savePath: 'plat.dsv' }, fileName: 'plat.dsv' });
    expect(sources(server.puts())).toEqual([via]);
    expect(await store.readSave()).toMatchObject({ name: 'plat.dsv', modified: T0, size: 64, source: 'upload' });
  });

  it.each<[string, Partial<HostedSaveDeps>, boolean, File, string]>([
    ["refused: the server's words", {}, true, saveFile(), 'The save is cut short'],
    ['over the cap: refused in the page, without a request', { config: { ...CONFIG, maxSaveBytes: 32 } }, false, saveFile('big.dsv', T0, 33), 'That file is too big to be a save.'],
  ])('an upload %s, and nothing stored', async (_, over, refuse, file, error) => {
    const server = stubHosted();
    if (refuse) server.nextPut(BAD_SAVE);
    const { result, store } = setup(over);
    await waitFor(() => expect(result.current.phase).toBe('load'));
    await act(() => result.current.upload(file));
    expect(result.current).toMatchObject({ phase: 'load', loadError: error });
    expect(server.puts()).toHaveLength(refuse ? 1 : 0);
    expect(await store.readSave()).toBeNull();
  });
});

describe('a stored save', () => {
  it('asks GET /api/box once and uploads nothing when the server holds the session', async () => {
    const server = stubHosted();
    const store = memorySaveStore();
    // The server holds this session from a first visit.
    const first = setup({ store });
    await waitFor(() => expect(first.result.current.phase).toBe('load'));
    await act(() => first.result.current.upload(saveFile()));
    first.unmount();
    const before = server.calls.length;

    const { result } = setup({ store });
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    const after = server.calls.slice(before);
    expect(gets(after)).toHaveLength(1);
    expect(after.filter((c) => c.method === 'PUT')).toHaveLength(0);
    expect(result.current).toMatchObject({ box: { savePath: 'plat.dsv' }, updated: false });
  });

  it('re-sends once after the server forgot the session, then shows the box', async () => {
    const server = stubHosted();
    const store = memorySaveStore();
    await store.writeSave(await stored(saveFile()));
    const { result } = setup({ store });
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(gets(server.calls)).toHaveLength(2);
    expect(sources(server.puts())).toEqual(['resend']);
    expect(result.current).toMatchObject({ box: { savePath: 'plat.dsv' }, updated: false });
  });

  it('three session calls failing at once cause exactly one PUT', async () => {
    const server = stubHosted({
      routes: { 'POST /api/sheet': { json: { ok: 'sheet' } }, 'POST /api/plan/step': { json: { ok: 'step' } } },
    });
    const store = memorySaveStore();
    await store.writeSave(await stored(saveFile()));
    const { result } = setup({ store });
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    const puts = server.puts().length;

    server.forget();
    await act(() => Promise.all([
      getBox(),
      postSheet({ trainerId: 't' } as unknown as SheetQuery),
      postPlanStep({ trainerId: 't' } as unknown as PlanStepRequestJson),
    ]));
    expect(server.puts().length - puts).toBe(1);
  });

  it('a server that does not answer says so and is asked again every 3 s', async () => {
    const server = stubHosted();
    const answering = globalThis.fetch;
    let down = true;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      (down ? Promise.reject(new TypeError('Failed to fetch')) : answering(input, init)));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const store = memorySaveStore();
    await store.writeSave(await stored(saveFile()));
    const { result } = setup({ store });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(result.current).toMatchObject({ phase: 'ready', noAnswer: true, fileName: 'plat.dsv' });

    down = false;
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(result.current.noAnswer).toBe(false);
    expect(result.current.box?.savePath).toBe('plat.dsv');
    expect(server.puts()).toHaveLength(1);
  });

  it('a re-send the server refuses opens the load screen with "Load your save again."', async () => {
    const server = stubHosted();
    server.nextPut(BAD_SAVE);
    const store = memorySaveStore();
    await store.writeSave(await stored(saveFile()));
    const { result } = setup({ store });
    await waitFor(() => expect(result.current.phase).toBe('load'));
    expect(result.current).toMatchObject({ loadReason: 'Load your save again.', loadError: null });
    expect(server.puts()).toHaveLength(1);
  });
});

describe('the connected file', () => {
  async function connected(permission: FilePermission) {
    stubHosted();
    const file = saveFile();
    const handle = fakeHandle(file, permission);
    const store = memorySaveStore();
    await store.writeSave(await stored(file, 'connected'));
    await store.writeHandle(handle);
    return { store, handle };
  }

  it.each<[FilePermission, string]>([['granted', 'polling'], ['prompt', 'needs-permission'], ['denied', 'upload']])('with the permission %s it is %s', async (permission, watch) => {
    const { store } = await connected(permission);
    const { result } = setup({ store });
    await waitFor(() => expect(result.current.watch).toBe(watch));
    if (permission === 'granted') expect(result.current.phase).toBe('ready');
    if (permission === 'prompt') {
      await act(() => result.current.reconnect());
      expect(result.current.watch).toBe('polling');
    }
    if (permission === 'denied') {                         // the handle is dropped, the bytes kept
      expect(await store.readHandle()).toBeNull();
      expect(await store.readSave()).not.toBeNull();
    }
  });

  it('a settled change uploads once and flashes "Box updated"', async () => {
    const { store, handle } = await connected('granted');
    const server = stubHosted();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { result } = setup({ store });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(result.current.watch).toBe('polling');
    const puts = server.puts().length;

    handle.file = saveFile('plat.dsv', T0 + 60_000);
    await act(() => vi.advanceTimersByTimeAsync(2_000 + 750 + 50));
    expect(server.puts().length - puts).toBe(1);
    // The start re-sent the stored save (the new stub holds no session); the poll's upload is the connected file's.
    expect(sources(server.puts())).toEqual(['resend', 'connected']);
    expect(result.current.updated).toBe(true);
    expect(result.current.box?.savedAt).toBe(new Date(T0 + 60_000).toISOString());
    expect((await store.readSave())?.modified).toBe(T0 + 60_000);

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(server.puts().length - puts).toBe(1);
    expect(result.current.updated).toBe(false);
  });

  it('a refused automatic upload keeps the box, says why and tries once more after 1.5 s', async () => {
    const { store, handle } = await connected('granted');
    const server = stubHosted();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { result } = setup({ store });
    await act(() => vi.advanceTimersByTimeAsync(10));
    const box = result.current.box;
    expect(box).not.toBeNull();
    const puts = server.puts().length;

    server.nextPut(BAD_SAVE, BAD_SAVE);
    handle.file = saveFile('plat.dsv', T0 + 60_000);
    await act(() => vi.advanceTimersByTimeAsync(2_000 + 750 + 50));
    expect(server.puts().length - puts).toBe(1);
    expect(result.current.autoError).toBe('The save is cut short');
    expect(result.current.box).toBe(box);

    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(server.puts().length - puts).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(server.puts().length - puts).toBe(2);
    expect(result.current.box).toBe(box);
  });

  it('connect() uploads the picked file, stores its handle and polls', async () => {
    const server = stubHosted();
    const handle = fakeHandle(saveFile('picked.dsv'));
    const files = fakeFiles(true, handle);
    const { result, store } = setup({ files });
    await waitFor(() => expect(result.current.phase).toBe('load'));
    await act(() => result.current.connect());
    expect(result.current).toMatchObject({ phase: 'ready', watch: 'polling' });
    expect(sources(server.puts())).toEqual(['connected']);
    expect(await store.readHandle()).toBe(handle);
    expect((await store.readSave())?.source).toBe('connected');
  });
});

const FAKE: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] };

function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

/** A one-lock `LockManager`: grants in order, honours `signal` and `steal` (the holder rejects with AbortError); `held()` names who holds it. */
function fakeLocks() {
  interface Entry { who: 'tab' | 'other'; cb?: () => Promise<unknown>; resolve(v?: unknown): void; reject(e: unknown): void; settled: boolean }
  let held: Entry | null = null;
  const queue: Entry[] = [];
  const finish = (e: Entry, ok: boolean, v?: unknown) => {
    if (e.settled) return;
    e.settled = true;
    if (ok) e.resolve(v);
    else e.reject(v);
  };
  const grant = (e: Entry) => {
    held = e;
    void e.cb?.().then((v) => {
      if (held === e) {
        held = null;
        const next = queue.shift();
        if (next) grant(next);
      }
      finish(e, true, v);
    });
  };
  const locks = {
    request(_name: string, opts: { steal?: boolean; signal?: AbortSignal }, cb: () => Promise<unknown>) {
      return new Promise((resolve, reject) => {
        const e: Entry = { who: 'tab', cb, resolve, reject, settled: false };
        if (opts.steal) {
          if (held) {
            const old = held;
            held = null;
            finish(old, false, new DOMException('stolen', 'AbortError'));
          }
          grant(e);
          return;
        }
        opts.signal?.addEventListener('abort', () => {
          const i = queue.indexOf(e);
          if (i >= 0) {
            queue.splice(i, 1);
            finish(e, false, new DOMException('aborted', 'AbortError'));
          }
        });
        if (held === null) grant(e);
        else queue.push(e);
      });
    },
  };
  return {
    locks: locks as unknown as LockManager,
    held: () => held?.who ?? null,
    holdOther() { held = { who: 'other', resolve: () => undefined, reject: () => undefined, settled: false }; },
  };
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Stubs `fetch` over the current one: `down(call)` true makes that call fail as a network failure; PUTs can be slowed. */
function flakyFetch(opts: { down?: (method: string, url: string) => boolean; putDelayMs?: number } = {}) {
  const answering = globalThis.fetch;
  const state = { putsStarted: 0 };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (opts.down?.(method, String(input))) throw new TypeError('Failed to fetch');
    if (method === 'PUT') {
      state.putsStarted += 1;
      if (opts.putDelayMs !== undefined) await new Promise((r) => setTimeout(r, opts.putDelayMs));
    }
    return answering(input, init);
  });
  return state;
}

async function advanceUntil(done: () => boolean, maxMs = 10_000): Promise<void> {
  for (let t = 0; t < maxMs && !done(); t += 50) await act(() => vi.advanceTimersByTimeAsync(50));
  expect(done()).toBe(true);
}

describe('races and refusals', () => {
  async function connectedStore(permission: FilePermission = 'granted') {
    const file = saveFile();
    const handle = fakeHandle(file, permission);
    const store = memorySaveStore();
    await store.writeSave(await stored(file, 'connected'));
    await store.writeHandle(handle);
    return { store, handle };
  }

  it('a re-send waiting behind an automatic upload sends nothing, and the newer save stays', async () => {
    const { store, handle } = await connectedStore();
    const server = stubHosted();
    vi.useFakeTimers(FAKE);
    const net = flakyFetch({ putDelayMs: 500 });
    const { result } = setup({ store });
    await advanceUntil(() => result.current.watch === 'polling');
    const puts = server.puts().length;
    const started = net.putsStarted;

    server.forget();
    handle.file = saveFile('plat.dsv', T0 + 60_000);
    await advanceUntil(() => net.putsStarted > started);   // the poll's upload is on its way
    let read: Promise<unknown> = Promise.resolve();
    act(() => { read = getBox(); });                        // 409: the server has not got it yet
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    await expect(read).resolves.toMatchObject({ savedAt: new Date(T0 + 60_000).toISOString() });
    expect(server.puts().length - puts).toBe(1);
    expect(result.current.box?.savedAt).toBe(new Date(T0 + 60_000).toISOString());
    expect(result.current.uploading).toBe(false);
  });

  it('holds pkp-poll only while the tab is visible, and the visible tab takes it from another tab', async () => {
    for (const other of [false, true]) {
      const { store } = await connectedStore();
      stubHosted();
      const lock = fakeLocks();
      if (other) lock.holdOther();
      const { result, unmount } = setup({ store, locks: lock.locks });
      await waitFor(() => expect(lock.held()).toBe('tab'));
      expect(result.current.watch).toBe('polling');
      if (!other) {
        act(() => setVisibility('hidden'));
        await waitFor(() => expect(lock.held()).toBeNull());
        act(() => setVisibility('visible'));
        await waitFor(() => expect(lock.held()).toBe('tab'));
      }
      unmount();
    }
  });

  // The poller is made in the lock's callback, after the `visibilitychange` event, so it must look at once itself.
  it('looks at the file at once when the tab becomes visible again', async () => {
    const { store, handle } = await connectedStore();
    const server = stubHosted();
    vi.useFakeTimers(FAKE);
    const lock = fakeLocks();
    const { result } = setup({ store, locks: lock.locks });
    await advanceUntil(() => result.current.watch === 'polling');
    const puts = server.puts().length;

    act(() => setVisibility('hidden'));
    await act(() => vi.advanceTimersByTimeAsync(10));
    handle.file = saveFile('plat.dsv', T0 + 60_000);
    act(() => setVisibility('visible'));
    // The settle is 750 ms; the 2 s poll interval must not be waited for.
    await advanceUntil(() => server.puts().length > puts, 1_500);
    expect(server.puts().length - puts).toBe(1);
  });

  it('a stored save refused on a re-send is dropped, with its handle', async () => {
    const { store } = await connectedStore();
    const server = stubHosted();
    server.nextPut(BAD_SAVE);
    const { result } = setup({ store });
    await waitFor(() => expect(result.current.loadReason).toBe('Load your save again.'));
    expect(await store.readSave()).toBeNull();
    expect(await store.readHandle()).toBeNull();
  });

  it('a removed save does not come back when the server answers again', async () => {
    stubHosted();
    const store = memorySaveStore();
    const first = setup({ store });
    await waitFor(() => expect(first.result.current.phase).toBe('load'));
    await act(() => first.result.current.upload(saveFile()));   // the server holds the session
    first.unmount();

    vi.useFakeTimers(FAKE);
    let down = true;
    flakyFetch({ down: () => down });
    const { result } = setup({ store });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(result.current.noAnswer).toBe(true);
    await act(() => result.current.removeSave());
    down = false;
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(result.current).toMatchObject({ phase: 'load', box: null, loadReason: null });
  });

  it('a manual upload before the stored handle is resumed drops the handle', async () => {
    const { store } = await connectedStore();
    stubHosted();
    vi.useFakeTimers(FAKE);
    let down = true;
    flakyFetch({ down: (method, url) => down && method === 'GET' && url === '/api/box' });
    const { result } = setup({ store });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(result.current.noAnswer).toBe(true);
    await act(() => result.current.upload(saveFile('other.dsv', T0 + 5)));
    expect(await store.readHandle()).toBeNull();
    down = false;
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(result.current.watch).toBe('upload');
  });

  it('an automatic upload refused with a 400 is not sent again', async () => {
    const { store, handle } = await connectedStore();
    const server = stubHosted();
    vi.useFakeTimers(FAKE);
    const { result } = setup({ store });
    await advanceUntil(() => result.current.watch === 'polling');
    const puts = server.puts().length;
    server.nextPut({ status: 400, json: { error: 'The save name header is bad' } });
    handle.file = saveFile('plat.dsv', T0 + 60_000);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(server.puts().length - puts).toBe(1);
    expect(result.current.autoError).toBe('The save name header is bad');
  });

  it('an automatic upload answered 500 backs off instead of sending on every poll', async () => {
    const { store, handle } = await connectedStore();
    const server = stubHosted();
    vi.useFakeTimers(FAKE);
    const { result } = setup({ store });
    await advanceUntil(() => result.current.watch === 'polling');
    const puts = server.puts().length;
    server.nextPut(...Array.from({ length: 20 }, () => ({ status: 500, json: { error: 'boom', code: 'INTERNAL' } })));
    handle.file = saveFile('plat.dsv', T0 + 60_000);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    const sent = server.puts().length - puts;
    expect(sent).toBeGreaterThanOrEqual(2);
    expect(sent).toBeLessThanOrEqual(4);
  });

  it('an answer from the server clears "no answer" though the upload was refused', async () => {
    const { store, handle } = await connectedStore();
    const server = stubHosted();
    vi.useFakeTimers(FAKE);
    let failPuts = 0;
    flakyFetch({ down: (method) => method === 'PUT' && failPuts-- > 0 });
    const { result } = setup({ store });
    await advanceUntil(() => result.current.watch === 'polling');
    failPuts = 1;
    server.nextPut(BAD_SAVE, BAD_SAVE);
    handle.file = saveFile('plat.dsv', T0 + 60_000);
    await advanceUntil(() => result.current.noAnswer);
    await advanceUntil(() => result.current.autoError === 'The save is cut short', 15_000);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(result.current.noAnswer).toBe(false);
  });

  it('a file written again between the settle and the read is not called a bad save', async () => {
    const { store, handle } = await connectedStore();
    const server = stubHosted();
    vi.useFakeTimers(FAKE);
    const { result } = setup({ store });
    await advanceUntil(() => result.current.watch === 'polling');
    const puts = server.puts().length;
    const changed = saveFile('plat.dsv', T0 + 60_000);
    let failRead = true;
    const read = changed.arrayBuffer.bind(changed);
    Object.defineProperty(changed, 'arrayBuffer', { value: () => (failRead ? Promise.reject(domError('NotReadableError')) : read()) });
    handle.file = changed;
    await act(() => vi.advanceTimersByTimeAsync(2_000 + 750 + 50));
    expect(result.current.autoError).toBeNull();
    expect(server.puts().length - puts).toBe(0);
    failRead = false;
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(server.puts().length - puts).toBe(1);
  });

  it('a file connected in another tab is taken up by the polling tab', async () => {
    const { store } = await connectedStore();
    stubHosted();
    const tab = fakeChannel();
    const { result } = setup({ store, channel: tab.channel });
    await waitFor(() => expect(result.current.watch).toBe('polling'));
    // The other tab connects file B (its permission must be asked here) and tells this one.
    const other = saveFile('other.dsv', T0 + 9);
    await store.writeHandle(fakeHandle(other, 'prompt'));
    await store.writeSave(await stored(other, 'connected'));
    await act(async () => { tab.deliver({ type: 'box' }); });
    await waitFor(() => expect(result.current.watch).toBe('needs-permission'));
  });
});

describe('settings, removing and other tabs', () => {
  async function ready(over: Partial<HostedSaveDeps> = {}) {
    const server = stubHosted();
    const view = setup(over);
    await waitFor(() => expect(view.result.current.phase).toBe('load'));
    await act(() => view.result.current.upload(saveFile()));
    return { server, ...view };
  }

  it('saveSettings writes pkp.settings and re-sends with the new headers, without a flash', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const server = stubHosted();
    const { result } = setup();
    await act(() => vi.advanceTimersByTimeAsync(10));
    await act(() => result.current.upload(saveFile()));
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(result.current.updated).toBe(false);

    await act(() => result.current.saveSettings({ graveyardBox: 12, levelCapOverride: 40 }));
    const put = server.puts().at(-1);
    expect(put?.headers.get(GRAVEYARD_HEADER)).toBe('12');
    expect(put?.headers.get(LEVEL_CAP_HEADER)).toBe('40');
    expect(sources(server.puts())).toEqual(['upload', 'settings']);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')).toEqual({ graveyardBox: 12, levelCapOverride: 40 });
    expect(result.current.settings).toEqual({ graveyardBox: 12, levelCapOverride: 40 });
    expect(result.current.updated).toBe(false);
  });

  it('removeSave empties the store, sends DELETE /api/save and opens the load screen', async () => {
    const { server, result, store } = await ready();
    await act(() => result.current.removeSave());
    expect(await store.readSave()).toBeNull();
    expect(server.calls.some((c) => c.method === 'DELETE' && c.url === '/api/save')).toBe(true);
    expect(result.current.phase).toBe('load');
    expect(result.current.box).toBeNull();
  });

  it('changeSave opens the load screen with Cancel; cancelChange goes back', async () => {
    const { result } = await ready();
    act(() => result.current.changeSave());
    expect(result.current).toMatchObject({ phase: 'load', changing: true });
    act(() => result.current.cancelChange());
    expect(result.current).toMatchObject({ phase: 'ready', changing: false });
  });

  it('posts { type: "box" } after an accepted upload; another tab\'s "box" reads GET /api/box once, its "removed" opens the load screen', async () => {
    const tab = fakeChannel();
    const { server, result } = await ready({ channel: tab.channel });
    expect(tab.posted).toEqual([{ type: 'box' }]);
    const before = gets(server.calls).length;
    await act(async () => { tab.deliver({ type: 'box' }); });
    await waitFor(() => expect(gets(server.calls).length - before).toBe(1));
    expect(result.current.phase).toBe('ready');
    act(() => tab.deliver({ type: 'removed' }));
    expect(result.current.phase).toBe('load');
  });

  it('a refused upload in the workspace is an uploadError, and the box stays', async () => {
    const { server, result } = await ready();
    const box = result.current.box;
    server.nextPut(BAD_SAVE);
    await act(() => result.current.upload(saveFile('other.dsv')));
    expect(result.current).toMatchObject({ phase: 'ready', uploadError: 'The save is cut short', loadError: null });
    expect(result.current.box).toBe(box);
  });

  it('a manual upload while connected drops the connection', async () => {
    const server = stubHosted();
    const handle = fakeHandle(saveFile('picked.dsv'));
    const { result, store } = setup({ files: fakeFiles(true, handle) });
    await waitFor(() => expect(result.current.phase).toBe('load'));
    await act(() => result.current.connect());
    await act(() => result.current.upload(saveFile('other.dsv', T0 + 5)));
    expect(server.puts()).toHaveLength(2);
    expect(result.current.watch).toBe('upload');
    expect(await store.readHandle()).toBeNull();
    expect((await store.readSave())?.source).toBe('upload');
  });

  it('a store that throws is carried on without: the upload still shows the box', async () => {
    stubHosted();
    const broken: SaveStore = {
      readSave: () => Promise.reject(new Error('blocked')),
      writeSave: () => Promise.reject(new Error('blocked')),
      readHandle: () => Promise.reject(new Error('blocked')),
      writeHandle: () => Promise.reject(new Error('blocked')),
      clearHandle: () => Promise.reject(new Error('blocked')),
      clearAll: () => Promise.reject(new Error('blocked')),
    };
    const { result } = setup({ store: broken });
    await waitFor(() => expect(result.current.phase).toBe('load'));
    await act(() => result.current.upload(saveFile()));
    expect(result.current.phase).toBe('ready');
  });
});
