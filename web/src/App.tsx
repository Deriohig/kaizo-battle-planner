// The page. It asks the server which mode it runs in (`GET /api/config`) and draws that mode's page: `LocalApp`,
// the planner on the player's PC as it has always been (an older server without the route answers 404, which counts as local),
// or `HostedApp`, where the save comes from the browser. One build holds both. While it asks, the header and "Loading…";
// a failure, the banner with "Try again". A hosted server with a password and no valid sign-in (the config says so, or a
// later call is refused 401 `SIGN_IN`) gets the sign-in page instead of the app; signing in reads the config again. The
// config's AI odds level (`aiOdds`, full when it does not say) is provided to the whole app (aiOdds.ts).

import { useCallback, useEffect, useState } from 'react';
import { AiOddsContext } from './aiOdds';
import { errorMessage, getConfig, logout, onSignInRequired, type PageConfig } from './api';
import { Header } from './components/Header';
import { HostedApp } from './hosted/HostedApp';
import { SignIn } from './hosted/SignIn';
import { LocalApp } from './LocalApp';

export { FLASH_MS } from './LocalApp';

export function App() {
  const [config, setConfig] = useState<PageConfig | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadProblem(null);
    getConfig().then(setConfig, (e: unknown) => setLoadProblem(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  // A call refused 401 `SIGN_IN` (the cookie ran out, the password changed) brings the sign-in page back. Once signed out
  // the state no longer changes, so a second refusal does nothing.
  useEffect(() => onSignInRequired(() => setConfig((c) => (
    c?.mode === 'hosted' && c.signedIn !== false ? { ...c, passwordRequired: true, signedIn: false } : c
  ))), []);

  /** After the server took the password: the config again, which must now say signed in. */
  const signedIn = useCallback(async () => {
    const next = await getConfig();
    if (next.mode === 'hosted' && next.passwordRequired === true && next.signedIn !== true) {
      throw new Error('Signed in, but this browser did not keep it. Allow cookies for this site and try again.');
    }
    setConfig(next);
  }, []);

  const signOut = useCallback(async () => {
    await logout();
    setConfig((c) => (c?.mode === 'hosted' ? { ...c, signedIn: false } : c));
  }, []);

  if (config?.mode === 'local') return <AiOddsContext value={config.aiOdds ?? 'full'}><LocalApp /></AiOddsContext>;
  if (config?.mode === 'hosted') {
    if (config.passwordRequired === true && config.signedIn !== true) return <SignIn onSignedIn={signedIn} />;
    return (
      <AiOddsContext value={config.aiOdds ?? 'full'}>
        <HostedApp config={config} onSignOut={config.passwordRequired === true ? signOut : undefined} />
      </AiOddsContext>
    );
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
        ) : (
          <p className="app-loading">Loading…</p>
        )}
      </main>
    </div>
  );
}
