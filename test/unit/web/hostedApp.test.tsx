// The page in hosted mode: `App` asks `GET /api/config` and draws `HostedApp` (or the local page on a 404), the load
// screen, the workspace fed by `useHostedSave`, hosted settings, the window's file drop, the header's watch states, and
// the save store (the in-memory one; `idbSaveStore` needs a real browser).

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../web/src/App';
import { setHosted } from '../../../web/src/api';
import { Header, type HeaderStatus } from '../../../web/src/components/Header';
import { HostedApp } from '../../../web/src/hosted/HostedApp';
import { memorySaveStore, openSaveStore, type SaveStore, type StoredSave } from '../../../web/src/hosted/saveStore';
import type { HostedWatch } from '../../../web/src/hosted/types';
import type { HostedConfig } from '../../../web/src/hosted/useHostedSave';
import { LEVEL_CAP_HEADER, SAVE_SOURCE_HEADER } from '../../../src/contracts/hosted';
import { stubHosted } from './hostedServer';
import { box, setup, stubFetch } from './stubServer';

const CONFIG: HostedConfig = { mode: 'hosted', version: 'test', maxSaveBytes: 1_048_576, pollMs: 2_000 };
const saveFile = (name = 'plat.dsv') => new File([new Uint8Array(64)], name, { lastModified: Date.UTC(2026, 10, 1) });
const loadScreen = () => screen.queryByRole('heading', { name: 'Load your save' });

function renderHosted(store: SaveStore = memorySaveStore()) {
  render(<HostedApp config={CONFIG} deps={{ store, files: { canConnect: false, pick: async () => null, fromStored: () => null }, channel: null, locks: null }} />);
  return { store };
}
/** Loads a save through the load screen's Upload input and waits for the workspace. */
async function uploadThroughLoadScreen(name = 'plat.dsv') {
  await screen.findByRole('heading', { name: 'Load your save' });
  fireEvent.change(screen.getByTestId('load-save-input'), { target: { files: [saveFile(name)] } });
  await screen.findByRole('tab', { name: 'Run' });
}
const sources = (server: ReturnType<typeof stubHosted>) => server.puts().map((c) => c.headers.get(SAVE_SOURCE_HEADER));

beforeEach(() => localStorage.clear());
afterEach(() => {
  setHosted(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('App picks the mode: hosted with nothing stored shows the load screen; a 404 from /api/config the local setup', async () => {
  stubHosted();
  const { unmount } = render(<App />);
  expect(await screen.findByRole('heading', { name: 'Load your save' }, { timeout: 5000 })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Check and extract' })).not.toBeInTheDocument();
  unmount();
  setHosted(null);
  stubFetch({ 'GET /api/setup': { json: setup({ data: { state: 'missing', message: null, trainers: null }, saveCandidates: [] }) } });
  render(<App />);
  expect(await screen.findByRole('button', { name: 'Check and extract' })).toBeInTheDocument();
  expect(loadScreen()).not.toBeInTheDocument();
});

describe('HostedApp', () => {
  it('an upload opens the workspace with the file name and the Run tab; a browser that cannot watch a file has Upload save, no Connect', async () => {
    stubHosted();
    renderHosted();
    await screen.findByRole('heading', { name: 'Load your save' });
    expect(screen.queryByRole('button', { name: 'Connect save file' })).not.toBeInTheDocument();
    await uploadThroughLoadScreen('my run.dsv');
    const header = screen.getByRole('banner');
    expect(within(header).getByText('my run.dsv')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true');
    expect(within(header).getByRole('button', { name: 'Upload save' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect save file' })).not.toBeInTheDocument();
  });

  it('settings: the two fields and the Save section, no ROM; Save settings re-sends with the new cap; Change save has Cancel', async () => {
    const server = stubHosted();
    const user = userEvent.setup();
    renderHosted();
    await uploadThroughLoadScreen();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const panel = screen.getByRole('dialog', { name: 'Settings' });
    for (const label of ['Graveyard', 'Level cap override']) expect(within(panel).getByLabelText(label)).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Save' })).toBeInTheDocument();
    expect(within(panel).getByText('plat.dsv')).toBeInTheDocument();
    expect(within(panel).queryByRole('heading', { name: 'ROM' })).not.toBeInTheDocument();
    await user.type(within(panel).getByLabelText('Level cap override'), '40');
    await user.click(within(panel).getByRole('button', { name: 'Save settings' }));
    expect(await within(panel).findByRole('status')).toHaveTextContent('Settings saved');
    expect(sources(server)).toEqual(['upload', 'settings']);
    expect(server.puts().at(-1)?.headers.get(LEVEL_CAP_HEADER)).toBe('40');
    await user.click(screen.getByRole('button', { name: 'Change save' }));
    expect(loadScreen()).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('tab', { name: 'Run' })).toBeInTheDocument();
    expect(loadScreen()).not.toBeInTheDocument();
  });

  it('Remove save forgets the save and opens the load screen, without Cancel', async () => {
    const server = stubHosted();
    const user = userEvent.setup();
    const { store } = renderHosted();
    await uploadThroughLoadScreen();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Remove save' }));
    expect(await screen.findByRole('heading', { name: 'Load your save' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    await waitFor(() => expect(server.calls.some((c) => c.method === 'DELETE' && c.url === '/api/save')).toBe(true));
    expect(await store.readSave()).toBeNull();
  });

  it('a window drag with Files shows "Drop to load this save" and its drop loads it; the server hears how each save came in', async () => {
    const server = stubHosted();
    const user = userEvent.setup();
    renderHosted();
    await screen.findByRole('heading', { name: 'Load your save' });
    fireEvent.dragEnter(window, { dataTransfer: { types: ['text/plain'] } });
    expect(screen.queryByText('Drop to load this save')).not.toBeInTheDocument();
    fireEvent.dragEnter(window, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByText('Drop to load this save').parentElement).toHaveClass('drop-overlay');
    fireEvent.drop(window, { dataTransfer: { types: ['Files'], files: [saveFile('dropped.sav')] } });
    await screen.findByRole('tab', { name: 'Run' });
    expect(screen.queryByText('Drop to load this save')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Change save' }));
    fireEvent.change(screen.getByTestId('load-save-input'), { target: { files: [saveFile('picked.dsv')] } });
    await screen.findByRole('tab', { name: 'Run' });
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Change save' }));
    fireEvent.drop(screen.getByText('Drop your save file here').parentElement!, { dataTransfer: { types: ['Files'], files: [saveFile('area.dsv')] } });
    await screen.findByRole('tab', { name: 'Run' });
    await waitFor(() => expect(server.puts()).toHaveLength(3));
    expect(sources(server)).toEqual(['drop', 'upload', 'drop']);
  });

  it('while the server does not answer at the start, the header says so and the workspace waits for the box', async () => {
    stubHosted();
    const store = memorySaveStore();
    const file = saveFile();
    await store.writeSave({ bytes: await file.arrayBuffer(), name: file.name, modified: file.lastModified, size: file.size, source: 'upload' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const answering = globalThis.fetch;
    let down = true;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => (down ? Promise.reject(new TypeError('Failed to fetch')) : answering(input, init)));
    renderHosted(store);
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(within(screen.getByRole('banner')).getByText('Reconnecting…')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Run' })).not.toBeInTheDocument();
    down = false;
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(screen.getByRole('tab', { name: 'Run' })).toBeInTheDocument();
  });
});

describe('the hosted header', () => {
  function status(hosted?: Partial<NonNullable<HeaderStatus['hosted']>> & { watch: HostedWatch }): HeaderStatus {
    const b = box();
    return {
      box: b, savePath: b.savePath, levelCapOverride: null, live: 'live', updated: false, onSettings: () => undefined,
      ...(hosted && { hosted: { uploading: false, noAnswer: false, onReconnect: vi.fn(), onUpload: vi.fn(), ...hosted } }),
    };
  }

  it.each<[string, HeaderStatus, string, string | null, string[]]>([
    ['polling', status({ watch: 'polling' }), 'Watching for saves', '.header-dot', []],
    ['needs permission', status({ watch: 'needs-permission' }), 'Not watching', null, []],
    ['unreadable', status({ watch: 'unreadable' }), "Can't read the save file", null, []],
    ['upload', status({ watch: 'upload' }), 'Upload save', null, ['.header-dot', 'Watching for saves']],
    ['uploading, over the watch state', status({ watch: 'polling', uploading: true }), 'Reading the save…', null, ['Watching for saves']],
    ['no answer, over everything', status({ watch: 'polling', uploading: true, noAnswer: true }), 'Reconnecting…', '.header-live.is-reconnecting .header-dot', ['Reading the save…']],
    ['not hosted', status(), 'Watching for saves', null, []],
  ])('%s', (_, s, said, has, hasNot) => {
    const { container } = render(<Header status={s} />);
    expect(screen.getByText(said)).toBeTruthy();
    if (has !== null) expect(container.querySelector(has)).not.toBeNull();
    for (const gone of hasNot) expect(gone.startsWith('.') ? container.querySelector(gone) : screen.queryByText(gone)).toBeNull();
  });

  it('Reconnect calls onReconnect; Upload save takes .dsv and .sav and hands the file to onUpload', () => {
    const s = status({ watch: 'needs-permission' });
    const { rerender } = render(<Header status={s} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect save file' }));
    expect(s.hosted!.onReconnect).toHaveBeenCalledOnce();
    const u = status({ watch: 'upload' });
    rerender(<Header status={u} />);
    const input = screen.getByTestId('header-upload-input') as HTMLInputElement;
    expect(input.accept).toBe('.dsv,.sav');
    const f = new File(['x'], 'a.dsv');
    fireEvent.change(input, { target: { files: [f] } });
    expect(u.hosted!.onUpload).toHaveBeenCalledWith(f);
  });
});

it('the memory save store starts empty, round-trips a save and a handle, clears the handle or both; openSaveStore falls back to it without IndexedDB', async () => {
  const sample = (): StoredSave => ({ bytes: new Uint8Array([1, 2, 3]).buffer, name: 'Platinum.dsv', modified: 1700000000000, size: 3, source: 'upload' });
  const store = memorySaveStore();
  expect([await store.readSave(), await store.readHandle()]).toEqual([null, null]);
  const handle = { kind: 'file' };
  await store.writeSave(sample());
  await store.writeHandle(handle);
  expect(await store.readSave()).toEqual(sample());
  expect(await store.readHandle()).toBe(handle);
  await store.clearHandle();
  expect([await store.readHandle(), await store.readSave()]).toEqual([null, sample()]);
  await store.writeHandle(handle);
  await store.clearAll();
  expect([await store.readSave(), await store.readHandle()]).toEqual([null, null]);
  expect((globalThis as { indexedDB?: unknown }).indexedDB).toBeUndefined();
  const fallback = openSaveStore();
  await fallback.writeSave(sample());
  expect(await fallback.readSave()).toEqual(sample());
});
