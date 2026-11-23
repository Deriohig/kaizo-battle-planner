// The page in hosted mode, drawn from `useHostedSave`: "Loading…" while it starts, the load screen when the
// browser holds no save (or Settings → "Change save" opened it, with Cancel), else the workspace: the header with the
// hosted save states, a banner for a save that did not read (an automatic upload the server refused) or a file that
// did not load (a manual one), the Run and Box tabs as in local mode, and the hosted settings panel. A file dragged
// anywhere over the window, in any phase, shows "Drop to load this save" and loads on the drop. Settings and the load
// screen have "Sign out" when the page gives `onSignOut` (the server has a password).

import { type MouseEvent, useCallback, useState } from 'react';
import { flushSync } from 'react-dom';
import { BoxView } from '../components/BoxView';
import { FightView } from '../components/FightView';
import { Header } from '../components/Header';
import { LoadSave } from '../components/LoadSave';
import { HostedSettingsPanel } from '../components/SettingsPanel';
import { useFileDrop } from './useFileDrop';
import { useHostedSave, type HostedConfig, type HostedSave, type HostedSaveDeps } from './useHostedSave';

// As in local mode: "Run", not "Fight", so no two tabs share a name.
type Tab = 'run' | 'box';
const TABS: { id: Tab; label: string }[] = [{ id: 'run', label: 'Run' }, { id: 'box', label: 'Box' }];

/** The workspace, with a save loaded. */
function Workspace({ save, onSignOut }: { save: HostedSave; onSignOut?: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>('run');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { box, changeSave, removeSave } = save;

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  /** The skip link: the Run tab is drawn first (`flushSync`), so the fight section is shown when it takes focus. */
  const skipToFight = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    flushSync(() => setTab('run'));
    document.getElementById('fight')?.focus();
  };

  return (
    <>
      <a className="skip-link" href="#fight" onClick={skipToFight}>Skip to the fight</a>
      <Header status={{
        box, savePath: save.fileName, levelCapOverride: save.settings.levelCapOverride, live: 'live', updated: save.updated,
        onSettings: () => setSettingsOpen(true),
        hosted: { watch: save.watch, uploading: save.uploading, noAnswer: save.noAnswer, onReconnect: save.reconnect, onUpload: save.upload },
      }} />
      {/* Until the first box (the server did not answer at the start), only "Loading…": the Run tab's own first reads
          (the trainer list) are made once, when it mounts, so it mounts with the server answering. */}
      {box === null ? <main className="app-main"><p className="app-loading">Loading…</p></main> : (
      <main className="app-main">
        {save.autoError !== null && (
          <p className="banner banner-warn" role="alert">
            <strong>The save did not read.</strong> {save.autoError} The box shows the last good read, and refreshes on the next save.
          </p>
        )}
        {save.uploadError !== null && (
          <p className="banner banner-danger" role="alert"><strong>That file did not load.</strong> {save.uploadError}</p>
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

        {/* Both panels stay mounted, so each keeps its state across a tab switch. */}
        <section role="tabpanel" id="panel-run" aria-labelledby="tab-run" hidden={tab !== 'run'}>
          <FightView box={box} />
        </section>
        <section role="tabpanel" id="panel-box" aria-labelledby="tab-box" hidden={tab !== 'box'}>
          <BoxView box={box} />
        </section>
      </main>
      )}

      {settingsOpen && (
        <HostedSettingsPanel
          settings={save.settings} box={box} fileName={save.fileName} onSave={save.saveSettings} onClose={closeSettings}
          onChangeSave={() => {
            setSettingsOpen(false);
            changeSave();
          }}
          onRemoveSave={() => {
            setSettingsOpen(false);
            void removeSave();
          }}
          onSignOut={onSignOut}
        />
      )}
    </>
  );
}

/** Hosted mode's page. `deps` swaps the browser's store, file access, channel or locks for a test's. */
export function HostedApp({ config, deps, onSignOut }: { config: HostedConfig; deps?: Partial<HostedSaveDeps>; onSignOut?: () => Promise<void> }) {
  const save = useHostedSave({ ...deps, config });
  const { upload } = save;
  const dragging = useFileDrop((file) => { void upload(file, 'drop'); });

  return (
    <div className="app">
      {save.phase === 'ready' ? <Workspace save={save} onSignOut={onSignOut} /> : (
        <>
          <Header />
          <main className="app-main">
            {save.phase === 'starting' ? <p className="app-loading">Loading…</p> : (
              <LoadSave
                canConnect={save.canConnect} uploading={save.uploading} error={save.loadError} reason={save.loadReason}
                onFile={(file, how) => { void upload(file, how); }} onConnect={() => { void save.connect(); }}
                onCancel={save.changing ? save.cancelChange : undefined} onSignOut={onSignOut}
              />
            )}
          </main>
        </>
      )}
      {dragging && <div className="drop-overlay"><span>Drop to load this save</span></div>}
    </div>
  );
}
