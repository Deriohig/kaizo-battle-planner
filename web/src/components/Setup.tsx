// First-run setup, in two steps. 1: the ROM. Once its data is extracted this says "ROM data ready (N trainers)";
// until then it takes the ROM's path (a pasted Windows path works) and "Check and extract" streams the extract's
// progress lines. 2: the save copy, as radio cards for the copies the server found, newest first, or a path typed in.
// "Use this save" stores it with `PUT /api/settings`. Settings reopens step 2 to change the save copy, with a Cancel.

import { useEffect, useId, useMemo, useState } from 'react';
import type { SettingsJson, SetupJson } from '../../../src/server/apiTypes';
import { errorMessage, getSettings, getSetup, putSettings, streamExtract } from '../api';
import { formatCount, formatDateTime } from '../format';
import { busyAria } from './busy';

/** How often the page looks again while an extract it did not start runs. */
const POLL_MS = 2_000;

/**
 * The ROM step. `again` (the settings panel) keeps the path input once the data is ready, to extract another ROM.
 * `onSetup` gets the new SetupJson after an extract, and the server's view after one fails (the old data may still be
 * in use). While an extract this page did not start runs, it shows the latest line and looks again every POLL_MS.
 */
export function RomStep({ setup, onSetup, again = false }: { setup: SetupJson; onSetup(next: SetupJson): void; again?: boolean }) {
  const inputId = useId();
  const [path, setPath] = useState(setup.romPath ?? '');
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [polls, setPolls] = useState(0);

  const { state, message, trainers } = setup.data;
  const ready = state === 'ready' && trainers !== null;
  const elsewhere = state === 'extracting' && !running;

  useEffect(() => {
    if (!elsewhere) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getSetup().then(
        (next) => { if (!cancelled) onSetup(next); },
        () => { if (!cancelled) setPolls((n) => n + 1); },
      );
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [elsewhere, setup, onSetup, polls]);

  async function extract(): Promise<void> {
    setRunning(true);
    setError(null);
    setLines([]);
    try {
      onSetup(await streamExtract(path, { onProgress: (line) => setLines((all) => [...all, line]) }));
    } catch (e) {
      setError(errorMessage(e));
      getSetup().then(onSetup, () => undefined);
    } finally {
      setRunning(false);
    }
  }

  const problem = error ?? (state === 'error' && !running ? message : null);
  return (
    <div className="rom-step">
      {ready && <p className="setup-ready">ROM data ready ({formatCount(trainers)} trainers)</p>}
      {(!ready || again) && (
        // While its extract runs, the path and "Check and extract" are busy: aria-disabled, not disabled, so the
        // focus that pressed it stays; the path is read-only and a submit waits. An extract this page did not start
        // (`elsewhere`) leaves them disabled: nothing here pressed them.
        <form className="setup-form" onSubmit={(e) => { e.preventDefault(); if (!running) void extract(); }}>
          <label htmlFor={inputId}>ROM path</label>
          <div className="setup-row">
            <input
              id={inputId} className="setup-input" value={path} spellCheck={false} disabled={elsewhere} readOnly={running} aria-disabled={busyAria(running)}
              placeholder="C:\Users\…\plat-kaizo-nightmare-update-final.nds" onChange={(e) => setPath(e.target.value)}
            />
            <button type="submit" className="button button-primary" disabled={elsewhere || path.trim() === ''} aria-disabled={busyAria(running)}>
              Check and extract
            </button>
          </div>
          <p className="setup-hint">
            The Platinum Kaizo (Nightmare Update) ROM; a path copied from Windows works. The first extract also downloads the
            official docs, which takes about 2 minutes.
          </p>
        </form>
      )}
      {elsewhere && <p className="setup-hint">An extract is running.</p>}
      {(elsewhere ? [message ?? 'Starting…'] : lines).length > 0 && (
        <ol className="setup-log" aria-label="Extract progress">
          {(elsewhere ? [message ?? 'Starting…'] : lines).map((line, k) => <li key={k}>{line}</li>)}
        </ol>
      )}
      {problem !== null && <p className="setup-error" role="alert">{problem}</p>}
    </div>
  );
}

const CUSTOM = 'custom';

/** The save step: the copies newest first, the newest readable one tagged, or another path typed in. */
function SaveStep({ setup, onSaved, onCancel }: { setup: SetupJson; onSaved(s: SettingsJson): void; onCancel?: () => void }) {
  const name = useId();
  const customId = useId();
  const candidates = useMemo(
    () => [...setup.saveCandidates].sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)),
    [setup.saveCandidates],
  );
  const newest = candidates.find((c) => c.error === null)?.path ?? null;
  const inUse = candidates.some((c) => c.path === setup.savePath && c.error === null) ? setup.savePath : null;
  const [selected, setSelected] = useState<string | null>(inUse ?? newest ?? (candidates.length === 0 ? CUSTOM : null));
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savePath = selected === CUSTOM ? custom.trim() : selected;

  async function use(): Promise<void> {
    if (savePath === null || savePath === '') return;
    setBusy(true);
    setError(null);
    try {
      const current = await getSettings();
      onSaved(await putSettings({ ...current, savePath }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    // While the save is stored, "Use this save" is busy: aria-disabled, not disabled, so focus stays; a submit waits.
    <form className="save-step" onSubmit={(e) => { e.preventDefault(); if (!busy) void use(); }}>
      <fieldset className="save-cards">
        <legend className="visually-hidden">Save copy</legend>
        {candidates.length === 0 && <p className="setup-hint">No save copies were found. Type the path to your .dsv file below.</p>}
        {candidates.map((c) => (
          <label key={c.path} className={`save-card${selected === c.path ? ' is-selected' : ''}${c.error !== null ? ' is-unusable' : ''}`}>
            <input
              type="radio" name={name} value={c.path} checked={selected === c.path} disabled={c.error !== null}
              onChange={() => setSelected(c.path)}
            />
            <span className="save-card-body">
              <span className="save-card-head">
                <span className="save-card-date">{formatDateTime(c.modifiedAt)}</span>
                {c.path === newest && <span className="save-newest">Newest</span>}
              </span>
              <code className="save-card-path">{c.path}</code>
              {c.summary !== null && <span className="save-card-summary">{c.summary}</span>}
              {c.error !== null && <span className="save-card-error">{c.error}</span>}
            </span>
          </label>
        ))}
        <div className={`save-card save-card-custom${selected === CUSTOM ? ' is-selected' : ''}`}>
          <input type="radio" id={customId} name={name} value={CUSTOM} checked={selected === CUSTOM} onChange={() => setSelected(CUSTOM)} />
          <span className="save-card-body">
            <label htmlFor={customId} className="save-card-date">Another file</label>
            <input
              className="setup-input" aria-label="Another save file" value={custom} spellCheck={false}
              placeholder="C:\Users\…\Battery\plat-kaizo-nightmare-update-final.dsv"
              onFocus={() => setSelected(CUSTOM)}
              onChange={(e) => { setCustom(e.target.value); setSelected(CUSTOM); }}
            />
          </span>
        </div>
      </fieldset>
      <div className="setup-actions">
        <button type="submit" className="button button-primary" disabled={savePath === null || savePath === ''} aria-disabled={busyAria(busy)}>Use this save</button>
        {onCancel !== undefined && <button type="button" className="button" onClick={onCancel}>Cancel</button>}
      </div>
      {error !== null && <p className="setup-error" role="alert">{error}</p>}
    </form>
  );
}

export function Setup({ setup, onSetup, onSaved, onCancel }: {
  setup: SetupJson;
  onSetup(next: SetupJson): void;
  /** The settings as stored after "Use this save". */
  onSaved(s: SettingsJson): void;
  /** Offered when step 2 was reopened from the settings. */
  onCancel?: () => void;
}) {
  const romId = useId();
  const saveId = useId();
  const dataReady = setup.data.trainers !== null && setup.data.state !== 'extracting';
  return (
    <div className="setup">
      <section className="setup-step" aria-labelledby={romId}>
        <h2 id={romId}><span className="setup-number">1</span> The ROM</h2>
        <RomStep setup={setup} onSetup={onSetup} />
      </section>
      <section className={`setup-step${dataReady ? '' : ' is-waiting'}`} aria-labelledby={saveId}>
        <h2 id={saveId}><span className="setup-number">2</span> The save copy</h2>
        {dataReady
          ? <SaveStep setup={setup} onSaved={onSaved} onCancel={onCancel} />
          : <p className="setup-hint">Once the ROM data is ready, choose which save copy the planner reads. It watches that file and refreshes the box whenever you save in game.</p>}
      </section>
    </div>
  );
}
