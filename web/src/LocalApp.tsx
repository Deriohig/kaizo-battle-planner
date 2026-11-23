// The page in local mode (the planner on the player's PC; `App` picks it when `GET /api/config` says local), moved here as it
// was. Built around the run, it loads the setup first and shows the first-run `Setup` until there is game
// data to plan with and a save copy is chosen; then the workspace: the header (where the run is, the save, the live dot,
// Settings), the tabs "Run" (`FightView`: the next fights, the team and the open fight, fed the live box) and "Box" (the
// whole save, read only), and the settings panel. Old data counts: a re-extract that failed leaves `data.state` at
// 'error' while the data from before still serves, so the workspace shows with a warning banner. While an extract runs,
// the setup shows its progress. The box stays live through the server's events (`useServerEvents`); one with another
// level cap reads the settings again, so the header's "(override)" stays true when another tab changed it. A box that
// cannot be had (the save moved or does not read) is said above the tabs, with "Change save copy", and the Run tab says
// why it has no team. When the page opens, what the old Fight view kept in the browser and nothing reads any more is removed
// (`removeOldKeys`). The workspace's first link skips to the fight: it opens the Run tab
// and focuses the fight section (`#fight`, FightView), hidden until it has focus.

import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { BoxJson, SettingsJson, SetupJson } from '../../src/server/apiTypes';
import { errorMessage, getBox, getSettings, getSetup } from './api';
import { BoxView } from './components/BoxView';
import { FightView } from './components/FightView';
import { Header } from './components/Header';
import { SettingsPanel } from './components/SettingsPanel';
import { Setup } from './components/Setup';
import { removeOldKeys } from './run';
import { useServerEvents } from './useServerEvents';

/** How long "Box updated" shows after the save changes (not after a box sent again for a settings change). */
export const FLASH_MS = 3_000;

/** True for `ms` after each `trigger()`; a new trigger starts the time again. */
function useFlash(ms: number): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const trigger = useCallback(() => {
    clearTimeout(timer.current);
    setOn(true);
    timer.current = setTimeout(() => setOn(false), ms);
  }, [ms]);
  return [on, trigger];
}

/**
 * Whether `next` comes from a changed save: another copy, or the same one saved again (`savedAt` is the file's time).
 * The server also sends the box again for a settings change, such as the level cap override, with the save as it was.
 */
function saveChanged(shown: BoxJson | null, next: BoxJson): boolean {
  return shown === null || shown.savedAt !== next.savedAt || shown.savePath !== next.savePath;
}

/** Whether the workspace can open: there is data to plan with (old data counts), a save is chosen, and no extract runs. */
function usable(setup: SetupJson): boolean {
  return setup.data.trainers !== null && setup.savePath !== null && setup.data.state !== 'extracting';
}

// "Run", not "Fight": the open fight's own views are the tabs "Fight" and "Matchups", and two tabs of one name would be
// one name to a screen reader.
type Tab = 'run' | 'box';
const TABS: { id: Tab; label: string }[] = [{ id: 'run', label: 'Run' }, { id: 'box', label: 'Box' }];

function Workspace({ setup, onSetup, onChangeSave }: { setup: SetupJson; onSetup(next: SetupJson): void; onChangeSave(): void }) {
  const [settings, setSettings] = useState<SettingsJson | null>(null);
  const [settingsProblem, setSettingsProblem] = useState<string | null>(null);
  const [box, setBox] = useState<BoxJson | null>(null);
  const [boxProblem, setBoxProblem] = useState<string | null>(null);   // the box could not be had at all
  const [boxError, setBoxError] = useState<string | null>(null);       // a re-read failed; the last box stays
  const [tab, setTab] = useState<Tab>('run');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updated, flash] = useFlash(FLASH_MS);

  // The box on screen, kept here as well so a `box` event can tell whether the save changed (see `saveChanged`).
  const shownBox = useRef<BoxJson | null>(null);
  const showBox = useCallback((b: BoxJson) => {
    shownBox.current = b;
    setBox(b);
  }, []);

  // Each `box` event counts here, so a GET /api/box that was sent before one never overwrites it.
  const boxEvents = useRef(0);
  const loadBox = useCallback(() => {
    const seen = boxEvents.current;
    getBox().then(
      (b) => {
        if (boxEvents.current !== seen) return;
        showBox(b);
        setBoxProblem(null);
      },
      (e: unknown) => {
        if (boxEvents.current === seen) setBoxProblem(errorMessage(e));
      },
    );
  }, [showBox]);

  useEffect(() => {
    getSettings().then(setSettings, (e: unknown) => setSettingsProblem(errorMessage(e)));
    loadBox();
  }, [loadBox]);

  const live = useServerEvents(
    (b) => {
      boxEvents.current += 1;
      const changed = saveChanged(shownBox.current, b);
      // Another cap may come from an override set elsewhere (another tab): the settings are read again, so the header's
      // "(override)" mark stays true. A failed read leaves things as they are.
      const capChanged = shownBox.current !== null && shownBox.current.levelCap !== b.levelCap;
      showBox(b);
      setBoxProblem(null);
      setBoxError(null);
      if (changed) flash();
      if (capChanged) getSettings().then(setSettings, () => undefined);
    },
    (error) => setBoxError(error),
  );

  // Saves made while the stream was down sent no event, so the box is read again once it is back.
  const wasLive = useRef(false);
  useEffect(() => {
    if (live !== 'live') return;
    if (wasLive.current) loadBox();
    wasLive.current = true;
  }, [live, loadBox]);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  /** The skip link: the Run tab is drawn first (`flushSync`), so the fight section is shown when it takes focus. */
  const skipToFight = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    flushSync(() => setTab('run'));
    document.getElementById('fight')?.focus();
  };

  return (
    <div className="app">
      <a className="skip-link" href="#fight" onClick={skipToFight}>Skip to the fight</a>
      <Header status={{
        box, savePath: settings?.savePath ?? setup.savePath, levelCapOverride: settings?.levelCapOverride ?? null,
        live, updated, onSettings: () => setSettingsOpen(true),
      }} />
      <main className="app-main">
        {setup.data.state === 'error' && setup.data.message !== null && (
          <p className="banner banner-warn" role="alert">
            <strong>The ROM data was not refreshed.</strong> {setup.data.message} The planner still uses the data from before.
          </p>
        )}
        {boxProblem !== null && (
          <div className="banner banner-danger" role="alert">
            <p>
              <strong>The box did not load.</strong> {boxProblem}
              {box !== null && ' The box shows the last good read.'}
            </p>
            <button type="button" className="button" onClick={onChangeSave}>Change save copy</button>
          </div>
        )}
        {boxError !== null && (
          <p className="banner banner-warn" role="alert">
            <strong>The save did not read.</strong> {boxError}{' '}
            {box !== null ? 'The box shows the last good read, and refreshes on the next save.' : 'The planner reads it again on the next save.'}
          </p>
        )}
        {settingsProblem !== null && (
          <p className="banner banner-danger" role="alert"><strong>The settings did not load.</strong> {settingsProblem}</p>
        )}

        <div className="tabs" role="tablist" aria-label="Workspace">
          {TABS.map(({ id, label }) => (
            <button
              key={id} type="button" role="tab" id={`tab-${id}`} aria-controls={`panel-${id}`} aria-selected={tab === id}
              className={`tab${tab === id ? ' is-active' : ''}`} onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Both panels stay mounted, so each keeps its state (the filter, later the fight) across a tab switch. */}
        <section role="tabpanel" id="panel-run" aria-labelledby="tab-run" hidden={tab !== 'run'}>
          <FightView box={box} boxProblem={boxProblem} />
        </section>
        <section role="tabpanel" id="panel-box" aria-labelledby="tab-box" hidden={tab !== 'box'}>
          {box !== null
            ? <BoxView box={box} />
            : boxProblem !== null
              ? <p className="app-loading">No box to show: the save did not read.</p>
              : <p className="app-loading">Reading the save…</p>}
        </section>
      </main>

      {settingsOpen && settings !== null && (
        <SettingsPanel
          settings={settings} setup={setup} box={box} onSetup={onSetup} onClose={closeSettings}
          onSaved={(s) => {
            setSettings(s);
            loadBox();
          }}
          onChangeSave={() => {
            setSettingsOpen(false);
            onChangeSave();
          }}
        />
      )}
    </div>
  );
}

export function LocalApp() {
  const [setup, setSetup] = useState<SetupJson | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [choosingSave, setChoosingSave] = useState(false);

  // Once, when the page opens: the old Fight view's keys are taken out of the browser.
  useEffect(removeOldKeys, []);

  const load = useCallback(() => {
    setLoadProblem(null);
    getSetup().then(setSetup, (e: unknown) => setLoadProblem(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const changeSave = useCallback(() => {
    // The copies on disk may have changed since the page loaded, so they are looked for again first.
    getSetup().then(setSetup, () => undefined).finally(() => setChoosingSave(true));
  }, []);

  if (setup !== null && usable(setup) && !choosingSave) {
    return <Workspace setup={setup} onSetup={setSetup} onChangeSave={changeSave} />;
  }

  return (
    <div className="app">
      <Header />
      <main className="app-main">
        {loadProblem !== null ? (
          <div className="banner banner-danger" role="alert">
            <p><strong>The page could not load.</strong> {loadProblem}</p>
            <button type="button" className="button" onClick={load}>Try again</button>
          </div>
        ) : setup === null ? (
          <p className="app-loading">Loading…</p>
        ) : (
          <Setup
            setup={setup} onSetup={setSetup}
            onSaved={(s) => {
              setSetup((prev) => (prev === null ? prev : { ...prev, savePath: s.savePath }));
              setChoosingSave(false);
            }}
            onCancel={choosingSave && usable(setup) ? () => setChoosingSave(false) : undefined}
          />
        )}
      </main>
    </div>
  );
}
