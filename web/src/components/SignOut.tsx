// "Sign out": ends the sign-in, and the page then shows the sign-in page. Settings has it, and so does "Load
// your save", which a signed-in visitor with no save yet would otherwise have no way out of. While the request runs it is
// busy; a failure is shown beside it.

import { useState } from 'react';
import { errorMessage } from '../api';
import { busyAria } from './busy';

export function SignOutButton({ onSignOut, className = 'button' }: {
  /** Signs out; rejects with what to show. */
  onSignOut: () => Promise<void>;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function press(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSignOut();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className={className} aria-disabled={busyAria(busy)} onClick={() => { void press(); }}>Sign out</button>
      {error !== null && <span className="settings-error" role="alert">{error}</span>}
    </>
  );
}
