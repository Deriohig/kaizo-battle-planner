// The hosted page's sign-in, drawn when the server has a password and this browser holds no valid sign-in: a
// centred card with the wordmark, "Password", "Sign in" and, under it, a line saying visits are logged with a rough
// location, device and the fights planned (the usage report tells visitors apart by the location and provider of their
// IP's /24, and shows each one's device, language, save and the fights they plan; the page asks for no name). It replaces the browser's own password popup. A wrong password is one plain line; a 429 says how long to wait
// (seconds up to 90, then minutes). The page reads the config again once the server answers 204 (`onSignedIn`); what
// that rejects with is shown as the line.

import { useId, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, login } from '../api';
import { busyAria } from '../components/busy';
import { Wordmark } from '../components/Wordmark';

/** Seconds up to this are said in seconds ("42 s"), longer waits in whole minutes, rounded up ("9 min"). */
const SECONDS_UP_TO = 90;

/** How long to wait, from `Retry-After` in seconds. */
const waitText = (seconds: number): string => {
  const s = Math.ceil(seconds);
  return s <= SECONDS_UP_TO ? `${s} s` : `${Math.ceil(s / 60)} min`;
};

/** The words for a refused sign-in. */
function problem(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) {
    return error.retryAfter === undefined ? 'Too many tries. Try again in a few minutes.' : `Too many tries. Try again in ${waitText(error.retryAfter)}.`;
  }
  if (error instanceof ApiError && error.status === 401) return 'Wrong password';
  return errorMessage(error);
}

export function SignIn({ onSignedIn }: {
  /** Called after the server accepted the password; resolves once the page has taken the new state, rejects with what to show. */
  onSignedIn(): Promise<void>;
}) {
  const passwordId = useId();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    if (password === '') {
      setError('Enter the password');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(password);
      await onSignedIn();
    } catch (err) {
      setError(problem(err));
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <Wordmark size="lg" />
      <form className="signin-card" onSubmit={(e) => { void submit(e); }}>
        <h1 className="signin-title">Sign in</h1>
        <div className="signin-field">
          <div className="signin-label"><label htmlFor={passwordId}>Password</label></div>
          <input
            id={passwordId} type="password" autoComplete="current-password" value={password} autoFocus
            onChange={(e) => { setPassword(e.target.value); setError(null); }}
          />
        </div>
        {error !== null && <p className="signin-error" role="alert">{error}</p>}
        <button type="submit" className="button button-primary signin-submit" aria-disabled={busyAria(busy)}>Sign in</button>
        <p className="signin-note">Visits are logged with a rough location, device and the fights you plan.</p>
      </form>
    </main>
  );
}
