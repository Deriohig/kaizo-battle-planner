// The settings, in a panel over the right of the page: the graveyard and the level cap override are saved together
// with "Save settings", as the whole SettingsJson the server wants: those two over the settings as the server holds them
// at that moment, since an extract in this same panel saves a new ROM path. The save copy is changed in the setup's
// step 2 ("Change save copy"), and the ROM by extracting another. Closing it, by Escape or Close, puts focus back where it
// was (the Settings button); if that is gone by then (the setup took over the page), focus is left alone.
// Hosted mode has its own panel, `HostedSettingsPanel`, in the same shell with the same two fields: saving
// hands them to the page (which re-sends the save with them), and a Save section names the loaded file, with
// "Change save" and "Remove save" on one line, and "Sign out" when the server has a password. It has no ROM section. The
// two hints behind the fields are one ⓘ each, and a path that is not set is muted text, not code.

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { BoxJson, HostedSettingsJson, SettingsJson, SetupJson } from '../../../src/server/apiTypes';
import { levelCapFor } from '../../../src/server/levelCap';
import { errorMessage, getSettings, putSettings } from '../api';
import { busyAria } from './busy';
import { InfoTip } from './InfoTip';
import { RomStep } from './Setup';
import { SignOutButton } from './SignOut';

const LAST_BOX = 18;

/** The two settings the form holds, or what is wrong with them. */
function read(graveyard: string, cap: string): HostedSettingsJson | string {
  let levelCapOverride: number | null = null;
  if (cap.trim() !== '') {
    const n = Number(cap);
    if (!Number.isInteger(n) || n < 1 || n > 100) return 'The level cap override must be a whole number from 1 to 100, or empty.';
    levelCapOverride = n;
  }
  return { graveyardBox: graveyard === '' ? null : Number(graveyard), levelCapOverride };
}

/** The panel itself: the backdrop, the dialog, its title and Close. Focus and Escape are handled here. */
function SettingsShell({ onClose, children }: { onClose(): void; children: ReactNode }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus moves into the panel once, when it opens, and goes back to what had it when the panel goes; Escape closes it.
  const closing = useRef(onClose);
  useEffect(() => {
    closing.current = onClose;
  });
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closing.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener !== null && opener.isConnected && opener !== document.body) opener.focus();
    };
  }, []);

  return (
    <>
      <div className="settings-backdrop" onClick={onClose} />
      <aside className="settings" role="dialog" aria-labelledby={titleId}>
        <div className="settings-head">
          <h2 id={titleId}>Settings</h2>
          <button type="button" className="button" ref={closeRef} onClick={onClose}>Close</button>
        </div>
        {children}
      </aside>
    </>
  );
}

/** The graveyard and level cap fields with "Save settings"; `onSave` stores them and rejects with what to show. */
function SettingsForm({ initial, box, onSave }: {
  initial: HostedSettingsJson;
  box: BoxJson | null;
  onSave(edited: HostedSettingsJson): Promise<void>;
}) {
  const graveyardId = useId();
  const capId = useId();
  const [graveyard, setGraveyard] = useState(initial.graveyardBox === null ? '' : String(initial.graveyardBox));
  const [cap, setCap] = useState(initial.levelCapOverride === null ? '' : String(initial.levelCapOverride));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(): Promise<void> {
    const edited = read(graveyard, cap);
    if (typeof edited === 'string') {
      setResult({ ok: false, text: edited });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      await onSave(edited);
      setResult({ ok: true, text: 'Settings saved' });
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  const badgeCap = box === null ? null : levelCapFor(box.badges, null);
  const capHint = `Empty: the cap from the badges${badgeCap !== null && box !== null ? ` (${badgeCap} with ${box.badges} ${box.badges === 1 ? 'badge' : 'badges'})` : ''}. `
    + 'Set it for the second rival fight, which a badge count cannot tell.';
  return (
    // While saving, Save settings is busy: aria-disabled, not disabled, so focus stays; a submit waits.
    <form className="settings-form" onSubmit={(e) => { e.preventDefault(); if (!busy) void save(); }}>
      <div className="settings-field">
        <div className="settings-label">
          <label htmlFor={graveyardId}>Graveyard</label>
          <InfoTip label="Graveyard">A Pokémon in these boxes is out of the run and never fights.</InfoTip>
        </div>
        <select id={graveyardId} value={graveyard} onChange={(e) => { setGraveyard(e.target.value); setResult(null); }}>
          <option value="">Boxes 15–18 (default)</option>
          {Array.from({ length: LAST_BOX }, (_, k) => k + 1).map((n) => (
            <option key={n} value={String(n)}>Graveyard: box {n} to {LAST_BOX}</option>
          ))}
        </select>
      </div>

      <div className="settings-field">
        <div className="settings-label">
          <label htmlFor={capId}>Level cap override</label>
          <InfoTip label="Level cap override">{capHint}</InfoTip>
        </div>
        <input
          id={capId} type="number" min={1} max={100} step={1} value={cap} placeholder="From badges"
          onChange={(e) => { setCap(e.target.value); setResult(null); }}
        />
      </div>

      <div className="settings-actions">
        <button type="submit" className="button button-primary" aria-disabled={busyAria(busy)}>Save settings</button>
        {result !== null && (
          <span className={result.ok ? 'settings-ok' : 'settings-error'} role={result.ok ? 'status' : 'alert'}>{result.text}</span>
        )}
      </div>
    </form>
  );
}

export function SettingsPanel({ settings, setup, box, onSaved, onSetup, onChangeSave, onClose }: {
  settings: SettingsJson;
  setup: SetupJson;
  box: BoxJson | null;
  onSaved(s: SettingsJson): void;
  onSetup(next: SetupJson): void;
  onChangeSave(): void;
  onClose(): void;
}) {
  async function save(edited: HostedSettingsJson): Promise<void> {
    // The panel's fields over the stored settings, not the ones from when the panel opened: "Extract another ROM"
    // saved a new ROM path since.
    const current = await getSettings();
    const next: SettingsJson = { ...current, ...edited };
    onSaved(await putSettings(next));
  }

  return (
    <SettingsShell onClose={onClose}>
      <SettingsForm initial={settings} box={box} onSave={save} />

      <section className="settings-section">
        <h3>Save copy</h3>
        {settings.savePath === null ? <p className="settings-none">None chosen</p> : <code className="settings-path">{settings.savePath}</code>}
        <button type="button" className="button" onClick={onChangeSave}>Change save copy</button>
      </section>

      <section className="settings-section">
        <h3>ROM</h3>
        {settings.romPath === null ? <p className="settings-none">Not set</p> : <code className="settings-path">{settings.romPath}</code>}
        <details className="settings-extract">
          <summary>Extract another ROM</summary>
          <RomStep setup={setup} onSetup={onSetup} again />
        </details>
      </section>
    </SettingsShell>
  );
}

/** "Sign out": ends the sign-in; the page then shows the sign-in page. A failure is shown here. */
function SignOutSection({ onSignOut }: { onSignOut: () => Promise<void> }) {
  return (
    <section className="settings-section">
      <h3>Account</h3>
      <SignOutButton onSignOut={onSignOut} />
    </section>
  );
}

/** Hosted mode's settings: the two fields, and the Save section. `onSave` re-sends the save with them. */
export function HostedSettingsPanel({ settings, box, fileName, onSave, onChangeSave, onRemoveSave, onSignOut, onClose }: {
  settings: HostedSettingsJson;
  box: BoxJson | null;
  fileName: string | null;
  onSave(s: HostedSettingsJson): Promise<void>;
  onChangeSave(): void;
  onRemoveSave(): void;
  /** Given when the server has a password: signs out, and rejects with what to show. */
  onSignOut?: () => Promise<void>;
  onClose(): void;
}) {
  return (
    <SettingsShell onClose={onClose}>
      <SettingsForm initial={settings} box={box} onSave={onSave} />

      <section className="settings-section">
        <h3>Save</h3>
        {fileName === null ? <p className="settings-none">None loaded</p> : <code className="settings-path">{fileName}</code>}
        <div className="settings-buttons">
          <button type="button" className="button" onClick={onChangeSave}>Change save</button>
          <button type="button" className="button" onClick={onRemoveSave}>Remove save</button>
        </div>
      </section>

      {onSignOut !== undefined && <SignOutSection onSignOut={onSignOut} />}
    </SettingsShell>
  );
}
