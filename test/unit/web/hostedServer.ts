// A fake hosted planner server for the page's tests, over `stubFetch`: `GET /api/config` says hosted, `PUT /api/save`
// holds a box per `x-pkp-session`, and the box routes answer 409 `NO_SAVE` until the session has one (or after `forget()`,
// a server restart) and 400 `SESSION_REQUIRED` without the header. With `password` set it is the server with a sign-in:
// `POST /api/login` takes that password (a wrong one is 401 `SIGN_IN`, answers can be queued, a 429 among them), `POST /api/logout`
// signs out, `expire()` is a cookie running out, and every route but the config answers 401 `SIGN_IN` while signed out.

import type { BoxJson } from '../../../src/server/apiTypes';
import { SAVE_MODIFIED_HEADER, SAVE_NAME_HEADER, SESSION_HEADER } from '../../../src/contracts/hosted';
import { box, stubFetch, type Answer, type FetchCall } from './stubServer';

type Route = Answer | ((call: FetchCall) => Answer | Promise<Answer>);

export interface HostedStub {
  calls: FetchCall[];
  /** The `PUT /api/save` calls, in order. */
  puts(): FetchCall[];
  /** Drops every session's box, as a server restart does. */
  forget(): void;
  /** Queues answers for the next `PUT /api/save` calls, one each; the default answer is `box()` for the uploaded file. */
  nextPut(...answers: Answer[]): void;
  /** The `POST /api/login` bodies, in order. */
  logins(): { password: string; name?: string }[];
  /** Queues answers for the next `POST /api/login` calls, one each (before the password is checked). */
  nextLogin(...answers: Answer[]): void;
  /** The sign-in cookie runs out: every protected route answers 401 `SIGN_IN` from now on. */
  expire(): void;
  /** Whether the stub holds a sign-in. */
  signedIn(): boolean;
}

/** Stubs `fetch` as a hosted server; `opts.routes` answers the routes that need a save, once the session holds one. */
export function stubHosted(opts: { routes?: Record<string, Route>; password?: string; signedIn?: boolean } = {}): HostedStub {
  const asked = opts.password !== undefined;
  let signedIn = !asked || opts.signedIn === true;
  const logins: { password: string; name?: string }[] = [];
  const loginQueue: Answer[] = [];
  const SIGN_IN: Answer = { status: 401, json: { error: 'Sign in first', code: 'SIGN_IN' } };
  const protect = (route: Route): Route => (call) => (signedIn ? (typeof route === 'function' ? route(call) : route) : SIGN_IN);

  const held = new Map<string, BoxJson>();
  const queue: Answer[] = [];
  const NO_SAVE: Answer = { status: 409, json: { error: 'Load your save again', code: 'NO_SAVE' } };
  const NO_SESSION: Answer = { status: 400, json: { error: 'Missing session', code: 'SESSION_REQUIRED' } };

  const guarded = (key: string, fallback?: Route): Route => async (call) => {
    const session = call.headers.get(SESSION_HEADER);
    if (session === null || session === '') return NO_SESSION;
    const mine = held.get(session);
    if (mine === undefined) return NO_SAVE;
    const route = opts.routes?.[key] ?? fallback;
    if (route === undefined) return { status: 404, json: { error: `No stub for ${key}` } };
    return typeof route === 'function' ? route(call) : route;
  };

  const routes: Record<string, Route> = {
    'GET /api/config': () => ({
      json: { mode: 'hosted', version: 'test', maxSaveBytes: 1_048_576, pollMs: 2_000, ...(asked ? { passwordRequired: true, signedIn } : {}) },
    }),
    'POST /api/login': (call) => {
      const body = call.body as { password: string; name?: string };
      logins.push(body);
      const queued = loginQueue.shift();
      if (queued !== undefined) return queued;
      if (body.password !== opts.password) return { status: 401, json: { error: 'Wrong password', code: 'SIGN_IN' } };
      signedIn = true;
      return { status: 204, json: null };
    },
    'POST /api/logout': () => {
      signedIn = false;
      return { status: 204, json: null };
    },
    'PUT /api/save': (call) => {
      const session = call.headers.get(SESSION_HEADER);
      if (session === null || session === '') return NO_SESSION;
      const queued = queue.shift();
      if (queued !== undefined) return queued;
      const name = decodeURIComponent(call.headers.get(SAVE_NAME_HEADER) ?? 'save.dsv');
      const modified = Number(call.headers.get(SAVE_MODIFIED_HEADER) ?? 0);
      const mine = box({ savePath: name, savedAt: new Date(modified).toISOString() });
      held.set(session, mine);
      return { json: mine };
    },
    'DELETE /api/save': (call) => {
      held.delete(call.headers.get(SESSION_HEADER) ?? '');
      return { status: 204, json: null };
    },
    'GET /api/box': guarded('GET /api/box', (call) => ({ json: held.get(call.headers.get(SESSION_HEADER) ?? '') })),
    'POST /api/sheet': guarded('POST /api/sheet'),
    'POST /api/sheet/ai/stream': guarded('POST /api/sheet/ai/stream'),
    'POST /api/plan/step': guarded('POST /api/plan/step'),
  };
  for (const key of Object.keys(routes)) {
    if (!key.includes('/api/config') && !key.includes('/api/login') && !key.includes('/api/logout')) routes[key] = protect(routes[key]!);
  }
  const stub = stubFetch(routes);

  return {
    calls: stub.calls,
    puts: () => stub.calls.filter((c) => c.method === 'PUT' && c.url === '/api/save'),
    forget: () => held.clear(),
    nextPut: (...answers) => { queue.push(...answers); },
    logins: () => logins,
    nextLogin: (...answers) => { loginQueue.push(...answers); },
    expire: () => { signedIn = false; },
    signedIn: () => signedIn,
  };
}
