// The hosted page's "Load your save" screen: the wordmark over one centred card in the upper third. The drop
// area holds the one primary action, "Connect save file" where the browser can watch a file ("Upload a save" is then a text-level
// second choice, and the primary one otherwise), and one line says where the save is read. Signed in to a server with a
// password, "Sign out" is at the card's foot (the only way out before a save is loaded). It only draws and reports: the file
// goes to `onFile` with how it came (picked or dropped), the connect press to `onConnect`.

import { useRef, useState, type DragEvent } from 'react';
import { pickSaveFile } from '../hosted/useFileDrop';
import { busyAria } from './busy';
import { InfoTip } from './InfoTip';
import { SignOutButton } from './SignOut';
import { Wordmark } from './Wordmark';

export interface LoadSaveProps {
  /** The browser can watch a file (Chrome, Edge). */
  canConnect: boolean;
  uploading: boolean;
  /** The server's words for a refusal, or the page's own. */
  error: string | null;
  /** A line above the heading saying why the screen is here (for example `Load your save again.`). */
  reason: string | null;
  /** A file from the Upload button's picker ('upload') or dropped on the area ('drop'). */
  onFile(file: File, how: 'upload' | 'drop'): void;
  onConnect(): void;
  /** Offered when the screen was opened from Settings. */
  onCancel?: () => void;
  /** Given when the server has a password and this browser is signed in: "Sign out". */
  onSignOut?: () => Promise<void>;
}

export function LoadSave({ canConnect, uploading, error, reason, onFile, onConnect, onCancel, onSignOut }: LoadSaveProps) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  function drop(e: DragEvent<HTMLDivElement>): void {
    if (!Array.from(e.dataTransfer.types ?? []).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation(); // the window's drop listener would load it a second time
    setOver(false);
    if (uploading) return;
    const file = pickSaveFile(e.dataTransfer.files);
    if (file !== null) onFile(file, 'drop');
  }

  const busy = busyAria(uploading);
  const upload = (
    <button
      type="button" className={canConnect ? 'button load-secondary' : 'button button-primary'} aria-disabled={busy}
      onClick={() => { if (!uploading) input.current?.click(); }}
    >
      Upload a save
    </button>
  );
  return (
    <section className="setup load-screen">
      <div className="load-brand"><Wordmark size="lg" /></div>
      {reason !== null && <p className="setup-hint">{reason}</p>}
      <div className="setup-step load-card">
        <h2>Load your save</h2>
        <div
          className={`load-drop${over ? ' is-over' : ''}`}
          onDragEnter={() => setOver(true)}
          onDragOver={(e) => { if (Array.from(e.dataTransfer.types ?? []).includes('Files')) e.preventDefault(); }}
          onDragLeave={() => setOver(false)}
          onDrop={drop}
        >
          <strong>Drop your save file here</strong>
          <span>.dsv or .sav, from DeSmuME's Battery folder</span>
          {canConnect && (
            <button type="button" className="button button-primary" aria-disabled={busy} onClick={() => { if (!uploading) onConnect(); }}>
              Connect save file
            </button>
          )}
          {upload}
        </div>
        {onCancel !== undefined && (
          <div className="setup-actions"><button type="button" className="button" onClick={onCancel}>Cancel</button></div>
        )}
        <input
          ref={input} type="file" accept=".dsv,.sav" hidden data-testid="load-save-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file !== undefined) onFile(file, 'upload');
          }}
        />
        {!canConnect && <p className="setup-hint">This browser can't watch a file. Upload the save again after you save in game.</p>}
        <p className="setup-hint">
          Read in your browser; nothing is stored on the server.{' '}
          {canConnect && <InfoTip label="watching your save">The planner reads the file again each time you save in game. Keep this tab open.</InfoTip>}
        </p>
        {uploading && <p className="setup-hint" role="status">Reading the save…</p>}
        {error !== null && <p className="setup-error" role="alert">{error}</p>}
        {onSignOut !== undefined && <p className="load-signout"><SignOutButton onSignOut={onSignOut} className="button load-secondary" /></p>}
      </div>
    </section>
  );
}
