// The page header. It always holds the title (the wordmark; with no status it is a bare bar, which the load screen hides); in the workspace it also says where the run is ("Run: 1 badge · cap 28 ·
// Gardenia Split": the badges, the level cap, marked when the settings override it, and the save's split, both named at
// 8 badges, when nothing in the save tells the Galactic and Elite Four splits apart), then the save being read (its file
// name and when the game last saved it), whether the page is still watching the save, a "Box updated" flash after the
// save changes, and the Settings button.

import { useRef } from 'react';
import type { BoxJson } from '../../../src/server/apiTypes';
import { formatDateTime } from '../format';
import type { HostedWatch } from '../hosted/types';
import { useCssVar } from '../useCssVar';
import { Wordmark } from './Wordmark';
import type { LiveStatus } from '../useServerEvents';

export interface HeaderStatus {
  box: BoxJson | null;
  /** The save in the settings, shown until the box has been read. */
  savePath: string | null;
  levelCapOverride: number | null;
  live: LiveStatus;
  /** True for a few seconds after a `box` event from a changed save (not one sent again for a settings change). */
  updated: boolean;
  onSettings(): void;
  /** Hosted mode: what the page is doing about the save, in place of the live status. */
  hosted?: HostedHeader;
}

export interface HostedHeader {
  watch: HostedWatch;
  uploading: boolean;
  /** The server does not answer (NO_ANSWER). */
  noAnswer: boolean;
  onReconnect(): void;
  onUpload(file: File): void;
}

/** The last part of a path, Windows or WSL. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter((part) => part !== '').at(-1) ?? path;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Run: 8 badges · cap 100 (override) · Galactic Split or Elite Four Split"; no split part when the save has none. */
function runLine(box: BoxJson, override: boolean): string {
  const { split, alsoPossible } = box.run;
  const parts = [plural(box.badges, 'badge', 'badges'), `cap ${box.levelCap}${override ? ' (override)' : ''}`];
  if (split !== '') parts.push([split, ...alsoPossible].join(' or '));
  return `Run: ${parts.join(' · ')}`;
}

/** The hosted header's live area: the first state that matches. */
function HostedLive({ hosted }: { hosted: HostedHeader }) {
  const input = useRef<HTMLInputElement>(null);
  if (hosted.noAnswer) {
    return <span className="header-live is-reconnecting"><span className="header-dot" aria-hidden="true" />Reconnecting…</span>;
  }
  if (hosted.uploading) return <span className="header-live">Reading the save…</span>;
  switch (hosted.watch) {
    case 'polling':
      return <span className="header-live is-live"><span className="header-dot" aria-hidden="true" />Watching for saves</span>;
    case 'needs-permission':
      return (
        <>
          <span className="header-live">Not watching</span>
          <button type="button" className="button" onClick={hosted.onReconnect}>Reconnect save file</button>
        </>
      );
    case 'unreadable':
      return <span className="header-live is-reconnecting">Can't read the save file</span>;
    case 'upload':
      return (
        <>
          <button type="button" className="button" onClick={() => input.current?.click()}>Upload save</button>
          <input
            ref={input} type="file" accept=".dsv,.sav" hidden data-testid="header-upload-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file !== undefined) hosted.onUpload(file);
            }}
          />
        </>
      );
  }
}

function Status({ status }: { status: HeaderStatus }) {
  const { box, live } = status;
  const savePath = box?.savePath ?? status.savePath;
  return (
    <>
      {box !== null && <p className="header-run">{runLine(box, status.levelCapOverride !== null)}</p>}
      <div className="header-save">
        {savePath !== null && <span className="header-file" title={savePath}>{fileName(savePath)}</span>}
        {box !== null && <span className="header-saved">Saved {formatDateTime(box.savedAt)}</span>}
      </div>
      <div className="header-actions">
        <span className="header-flash" role="status">{status.updated ? 'Box updated' : ''}</span>
        {status.hosted !== undefined ? <HostedLive hosted={status.hosted} /> : (
          <span className={`header-live is-${live}`}>
            <span className="header-dot" aria-hidden="true" />
            {live === 'live' ? 'Watching for saves' : 'Reconnecting…'}
          </span>
        )}
        <button type="button" className="button" onClick={status.onSettings}>Settings</button>
      </div>
    </>
  );
}

export function Header({ status }: { status?: HeaderStatus }) {
  return (
    <header className={status === undefined ? 'app-header is-bare' : 'app-header'} ref={useCssVar('--header-height')}>
      <h1><Wordmark size="md" /></h1>
      {status !== undefined && <Status status={status} />}
    </header>
  );
}
