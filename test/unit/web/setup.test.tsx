import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsJson } from '../../../src/server/apiTypes';
import { levelCapFor } from '../../../src/server/levelCap';
import { App } from '../../../web/src/App';
import { RomStep } from '../../../web/src/components/Setup';
import { SettingsPanel } from '../../../web/src/components/SettingsPanel';
import { type Answer, box, liveStream, ROM, SAVE_12_JUNE, SAVE_23_MAY, settings, setup, stubEventSource, stubFetch, trainers, type FetchCall } from './stubServer';

const MISSING = setup({ data: { state: 'missing', message: null, trainers: null }, romPath: null, saveCandidates: [] });
/** The server's words for a docs download that failed mid-extract. */
const DOCS_FAILED = 'Cannot download the docs: "Personal" tab could not be fetched: fetch failed (HTTP)';
type Routes = Parameters<typeof stubFetch>[0];

/** The save copies' radio cards, in page order (the custom path's radio left out). */
const saveCards = () => screen.getAllByRole('radio').filter((r) => !r.matches('[value="custom"]'));
const puts = (calls: FetchCall[]) => calls.filter((c) => c.method === 'PUT' && c.url === '/api/settings');
function putBody(calls: FetchCall[]): SettingsJson {
  const put = puts(calls)[0];
  if (put === undefined) throw new Error('no PUT /api/settings');
  expect(put.headers.get('Content-Type')).toBe('application/json');
  return put.body as SettingsJson;
}
/** The workspace's routes on the 12 June save, `over` on top. */
const workspace = (over: Routes = {}): Routes => ({
  'GET /api/setup': { json: setup({ savePath: SAVE_12_JUNE }) },
  'GET /api/settings': { json: settings({ savePath: SAVE_12_JUNE }) },
  'PUT /api/settings': ({ body }) => ({ json: body }),
  'GET /api/box': { json: box() },
  'GET /api/trainers': { json: trainers() },
  ...over,
});
/** A route that waits until `release()`, then answers with the body it was sent. */
function held() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { release, route: async ({ body }: FetchCall): Promise<Answer> => { await gate; return { json: body }; } };
}

beforeEach(() => { stubEventSource(); });
afterEach(() => vi.unstubAllGlobals());

describe('Setup', () => {
  it.each<[string, Answer, (calls: FetchCall[]) => Promise<void>]>([
    ['streams the progress lines, then shows the data ready and the save step', {
      events: [['progress', { message: 'Decoding the ROM…' }], ['progress', { message: '493 species, 467 moves, 474 trainers' }], ['done', setup()]],
    }, async (calls) => {
      expect(await screen.findByText('ROM data ready (456 trainers)')).toBeInTheDocument();
      for (const line of ['Decoding the ROM…', '493 species, 467 moves, 474 trainers']) expect(screen.getByText(line)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Use this save' })).toBeInTheDocument();
      const post = calls.find((c) => c.method === 'POST');
      expect(post).toMatchObject({ url: '/api/setup/extract', body: { romPath: '/mnt/c/plat.nds' } });
      expect(post?.headers.get('Content-Type')).toBe('application/json');
    }],
    ['says why a ROM is refused and keeps the input', { status: 400, json: { error: 'Not Platinum Kaizo (Nightmare Update): game code CPUE; expected JAK7' } }, async () => {
      expect(await screen.findByText('Not Platinum Kaizo (Nightmare Update): game code CPUE; expected JAK7')).toBeInTheDocument();
      expect(screen.getByLabelText('ROM path')).toHaveValue('/mnt/c/plat.nds');
    }],
  ])('with no ROM data the ROM step asks for its path; "Check and extract" %s', async (_, answer, check) => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ 'GET /api/setup': { json: MISSING }, 'POST /api/setup/extract': answer });
    render(<App />);
    await user.type(await screen.findByLabelText('ROM path'), '/mnt/c/plat.nds');
    expect(screen.queryByText(/ROM data ready/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use this save' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check and extract' }));
    await check(calls);
  });

  it('lists two save copies newest first, "Newest" on 12 June; the 23 May one chosen goes into PUT /api/settings and opens the workspace', async () => {
    const user = userEvent.setup();
    const [june, may] = setup().saveCandidates;
    const { calls } = stubFetch(workspace({
      'GET /api/setup': { json: setup({ saveCandidates: [may!, june!] }) },             // even when they arrive oldest first
      'GET /api/box': { json: box({ savePath: SAVE_23_MAY }) },
    }));
    render(<App />);
    expect(await screen.findByText('ROM data ready (456 trainers)')).toBeInTheDocument();
    expect(screen.queryByLabelText('ROM path')).toBeNull();
    const [first, second] = saveCards();
    expect(saveCards()).toHaveLength(2);
    for (const part of [/12 June 2026/, /Newest/, /Party: Blaze \(Monferno\) Lv 15/]) expect(first).toHaveAccessibleName(part);
    expect(second).toHaveAccessibleName(/23 May 2026/);
    expect(second).not.toHaveAccessibleName(/Newest/);
    expect(screen.getByLabelText('Another save file')).toBeInTheDocument();
    await user.click(second!);
    await user.click(screen.getByRole('button', { name: 'Use this save' }));
    expect(await screen.findByRole('tab', { name: 'Box' })).toBeInTheDocument();
    expect(putBody(calls)).toEqual(settings({ savePath: SAVE_23_MAY }));
  });

  // A busy control is aria-disabled, never disabled, so focus stays on it.
  it('while the save is stored, "Use this save" is aria-disabled and keeps focus, and a second press sends nothing', async () => {
    const user = userEvent.setup();
    const put = held();
    const { calls } = stubFetch(workspace({ 'GET /api/setup': { json: setup() }, 'GET /api/settings': { json: settings() }, 'PUT /api/settings': put.route }));
    render(<App />);
    await screen.findByText('ROM data ready (456 trainers)');
    const use = screen.getByRole('button', { name: 'Use this save' });
    use.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(use).toHaveAttribute('aria-disabled', 'true');
    expect(use).not.toBeDisabled();
    expect(document.activeElement).toBe(use);
    await user.keyboard('{Enter}');
    expect(puts(calls)).toHaveLength(1);
    put.release();
    expect(await screen.findByRole('tab', { name: 'Box' })).toBeInTheDocument();
  });

  it('a custom path goes into PUT /api/settings as typed, and a refusal shows its message', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      'GET /api/setup': { json: setup() }, 'GET /api/settings': { json: settings() },
      'PUT /api/settings': { status: 400, json: { error: 'Cannot read /mnt/c/x.dsv: not a save' } },
    });
    render(<App />);
    await user.type(await screen.findByLabelText('Another save file'), '"C:\\x.dsv"');
    await user.click(screen.getByRole('button', { name: 'Use this save' }));
    expect(await screen.findByText('Cannot read /mnt/c/x.dsv: not a save')).toBeInTheDocument();
    expect(putBody(calls).savePath).toBe('"C:\\x.dsv"');
    expect(screen.queryByRole('tab', { name: 'Box' })).toBeNull();
  });

  it('a re-extract from the settings that fails mid-download keeps the workspace, with a warning; the old data still serves', async () => {
    const user = userEvent.setup();
    let current = setup({ savePath: SAVE_12_JUNE });
    stubFetch(workspace({
      'GET /api/setup': () => ({ json: current }),
      'POST /api/setup/extract': () => {
        current = setup({ data: { state: 'error', message: DOCS_FAILED, trainers: 456 }, savePath: SAVE_12_JUNE });   // the data from before still loaded
        return { events: [['progress', { message: 'Downloading the docs (18 tabs, about 2 minutes)…' }], ['error', { error: DOCS_FAILED }]] };
      },
    }));
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    const panel = screen.getByRole('dialog', { name: 'Settings' });
    await user.click(within(panel).getByText('Extract another ROM'));
    expect(within(panel).getByLabelText('ROM path')).toHaveValue(ROM);
    await user.click(within(panel).getByRole('button', { name: 'Check and extract' }));
    await waitFor(() => expect(screen.getByText('The ROM data was not refreshed.')).toBeInTheDocument());
    expect(screen.getByText('The ROM data was not refreshed.').closest('[role="alert"]')).toHaveTextContent(DOCS_FAILED);
    expect(within(screen.getByRole('tablist', { name: 'Workspace' })).getByRole('tab', { name: 'Run' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use this save' })).toBeNull();
    expect(screen.queryByText(/The trainers did not load/)).toBeNull();
  });

  it('an extract running when the page loads shows its progress on the setup page', async () => {
    stubFetch({ 'GET /api/setup': { json: setup({ data: { state: 'extracting', message: 'Downloading the docs (18 tabs, about 2 minutes)…', trainers: 456 }, savePath: SAVE_12_JUNE }) } });
    render(<App />);
    expect(await screen.findByText('Downloading the docs (18 tabs, about 2 minutes)…')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Box' })).toBeNull();
  });
});

describe('Settings', () => {
  async function openSettings(routes: Routes = workspace()) {
    const user = userEvent.setup();
    const { calls } = stubFetch(routes);
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    return { user, calls, panel: screen.getByRole('dialog', { name: 'Settings' }) };
  }

  it('has the graveyard, the level cap override, the save copy and the ROM, nothing of the solver; Escape and Close put focus back', async () => {
    const { user, panel } = await openSettings();
    for (const label of ['Graveyard', 'Level cap override']) expect(within(panel).getByLabelText(label)).toBeInTheDocument();
    expect(panel).not.toHaveTextContent(/budget|thread|engine/i);
    expect(within(panel).getByRole('heading', { name: 'Save copy' })).toBeInTheDocument();
    expect(within(panel).getByText(ROM)).toBeInTheDocument();
    for (const close of [() => user.keyboard('{Escape}'), () => user.click(within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('button', { name: 'Close' }))]) {
      await close();
      expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Settings' })).toHaveFocus();
      await user.click(screen.getByRole('button', { name: 'Settings' }));
    }
  });

  it('"Save settings" sends the whole settings back with the new graveyard and cap, and the ROM path a re-extract in the same panel set', async () => {
    const newRom = '/mnt/c/Users/User/Desktop/Games/Emulators/Roms/plat-kaizo-second-copy.nds';
    let stored = settings({ savePath: SAVE_12_JUNE });
    const { user, calls, panel } = await openSettings(workspace({
      'GET /api/settings': () => ({ json: stored }),
      'PUT /api/settings': ({ body }) => { stored = body as SettingsJson; return { json: body }; },
      'POST /api/setup/extract': () => {
        stored = { ...stored, romPath: newRom };                // the server saves the ROM path once the extract is good
        return { events: [['progress', { message: 'Decoding the ROM…' }], ['done', setup({ romPath: newRom, savePath: SAVE_12_JUNE })]] };
      },
    }));
    await user.click(within(panel).getByText('Extract another ROM'));
    await user.clear(within(panel).getByLabelText('ROM path'));
    await user.type(within(panel).getByLabelText('ROM path'), newRom);
    await user.click(within(panel).getByRole('button', { name: 'Check and extract' }));
    await within(panel).findByText('Decoding the ROM…');
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Check and extract' })).toBeEnabled());
    await user.selectOptions(within(panel).getByLabelText('Graveyard'), 'Graveyard: box 12 to 18');
    await user.type(within(panel).getByLabelText('Level cap override'), '30');
    await user.click(within(panel).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(putBody(calls)).toEqual({ romPath: newRom, savePath: SAVE_12_JUNE, graveyardBox: 12, levelCapOverride: 30 });
  });

  it('while settings save, "Save settings" is aria-disabled and keeps focus, and a second press sends nothing', async () => {
    const put = held();
    const { user, calls, panel } = await openSettings(workspace({ 'PUT /api/settings': put.route }));
    const save = within(panel).getByRole('button', { name: 'Save settings' });
    save.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).not.toBeDisabled();
    expect(document.activeElement).toBe(save);
    await user.keyboard('{Enter}');
    expect(puts(calls)).toHaveLength(1);
    put.release();
    expect(await within(panel).findByText('Settings saved')).toBeInTheDocument();
    expect(save).not.toHaveAttribute('aria-disabled');
  });

  it('"Change save copy" reopens the save step on the save in use, and Cancel goes back', async () => {
    const { user } = await openSettings();
    await user.click(screen.getByRole('button', { name: 'Change save copy' }));
    expect(await screen.findByRole('button', { name: 'Use this save' })).toBeInTheDocument();
    expect(saveCards()[0]).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('tab', { name: 'Box' })).toBeInTheDocument();
  });
});

describe('the Settings panel and the ROM step alone', () => {
  it('says what the graveyard boxes mean and where the level cap comes from, behind one ⓘ each', () => {
    render(<SettingsPanel settings={settings()} setup={setup()} box={box({ badges: 1 })} onSaved={vi.fn()} onSetup={vi.fn()} onChangeSave={vi.fn()} onClose={vi.fn()} />);
    const panel = screen.getByRole('dialog', { name: 'Settings' });
    expect(panel.querySelector('.settings-hint')).toBeNull();
    expect([...panel.querySelectorAll('.info-tip-text')].map((p) => p.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'A Pokémon in these boxes is out of the run and never fights.',
      `Empty: the cap from the badges (${levelCapFor(1, null)} with 1 badge). Set it for the second rival fight, which a badge count cannot tell.`,
    ]);
  });

  it('while an extract runs, "Check and extract" and the path are aria-disabled, never disabled, focus stays, and a second press sends nothing', async () => {
    const live = liveStream();
    const { calls } = stubFetch({ 'POST /api/setup/extract': { stream: live.stream }, 'GET /api/setup': { json: setup() } });
    const user = userEvent.setup();
    const onSetup = vi.fn();
    render(<RomStep setup={setup({ data: { state: 'missing', message: null, trainers: null }, romPath: null })} onSetup={onSetup} />);
    await user.type(screen.getByLabelText('ROM path'), '/mnt/c/plat.nds');
    const go = screen.getByRole('button', { name: 'Check and extract' });
    go.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(go).toHaveAttribute('aria-disabled', 'true'));
    expect(go).not.toBeDisabled();
    expect(document.activeElement).toBe(go);
    const input = screen.getByLabelText('ROM path');
    expect(input).not.toBeDisabled();
    expect(input).toHaveAttribute('aria-disabled', 'true');
    expect(input).toHaveAttribute('readonly');
    await user.keyboard('{Enter}');
    expect(calls.filter((c) => c.url === '/api/setup/extract')).toHaveLength(1);
    live.send('done', setup());
    live.close();
    await waitFor(() => expect(onSetup).toHaveBeenCalled());
    await waitFor(() => expect(go).not.toHaveAttribute('aria-disabled'));
    expect(input).not.toHaveAttribute('readonly');
  });
});
