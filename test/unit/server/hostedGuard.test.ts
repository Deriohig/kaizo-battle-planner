import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  accessGuard, checkContentType, checkOrigin, clientIp, SECURITY_HEADERS, sessionIdOf, sessionIdOrNull, setSecurityHeaders,
} from '../../../src/server/hostedGuard.js';
import { HttpError } from '../../../src/server/http.js';
import { createRateLimiter } from '../../../src/server/limits.js';
import { AUTH_COOKIE, cleanName, makeToken, readToken, SIGN_IN_MAX_AGE_S } from '../../../src/server/signIn.js';

const SOCKET = '203.0.113.9';

/** An `IncomingMessage` as the guard reads one: headers (lower-case names), the method and the socket's address. */
function req(headers: Record<string, string | string[]> = {}, remoteAddress: string | null = SOCKET, method = 'GET'): IncomingMessage {
  return { headers, method, socket: { remoteAddress: remoteAddress ?? undefined } } as unknown as IncomingMessage;
}

/** The `HttpError` `run` throws. */
function httpError(run: () => unknown): HttpError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error('Expected an HttpError');
}

describe('SECURITY_HEADERS', () => {
  it('are exactly these, with no CORS or HSTS header, and setSecurityHeaders sets each', () => {
    expect(SECURITY_HEADERS).toEqual({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'X-Robots-Tag': 'noindex',
    });
    const set = new Map<string, string>();
    setSecurityHeaders({ setHeader: (name: string, value: string) => set.set(name, value) } as unknown as ServerResponse);
    expect(Object.fromEntries(set)).toEqual(SECURITY_HEADERS);
  });
});

describe('clientIp', () => {
  // onProxied fires only when a forwarded header comes to a server that trusts no proxy.
  it.each<[string | string[] | undefined, string | null, number, string]>([
    [undefined, SOCKET, 0, SOCKET], [undefined, '::ffff:198.51.100.4', 0, '198.51.100.4'], [undefined, '2001:db8::7', 0, '2001:db8::7'],
    [undefined, null, 0, '0.0.0.0'], ['198.51.100.1', SOCKET, 0, SOCKET], [undefined, SOCKET, 1, SOCKET],
    ['10.0.0.1, 198.51.100.1, 198.51.100.2', SOCKET, 1, '198.51.100.2'], ['198.51.100.2', SOCKET, 1, '198.51.100.2'],
    ['10.0.0.1, 198.51.100.1, 198.51.100.2', SOCKET, 2, '198.51.100.1'], ['198.51.100.1', SOCKET, 2, SOCKET], [' , ', SOCKET, 1, SOCKET],
    ['::ffff:198.51.100.7', SOCKET, 1, '198.51.100.7'], ['[2001:db8::1]:443', SOCKET, 1, '2001:db8::1'], ['198.51.100.7:5678', SOCKET, 1, '198.51.100.7'],
    [['198.51.100.1', '198.51.100.2'], SOCKET, 1, '198.51.100.2'],
    // A hop that is no IP at all never becomes a rate key.
    ['unknown', SOCKET, 1, SOCKET], [`x${Math.random()}`, SOCKET, 1, SOCKET],
  ])('X-Forwarded-For %j from socket %s, trustProxy %i: %s', (xff, socket, trustProxy, ip) => {
    const onProxied = vi.fn();
    expect(clientIp(req(xff === undefined ? {} : { 'x-forwarded-for': xff }, socket), trustProxy, onProxied)).toBe(ip);
    expect(onProxied).toHaveBeenCalledTimes(trustProxy === 0 && xff !== undefined ? 1 : 0);
  });
});

describe('accessGuard', () => {
  const PW = 'open sesame';
  const IP = SOCKET;
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  const basic = (user: string, password: string) => ({ authorization: `Basic ${b64(`${user}:${password}`)}` });
  const cookie = (password: string, name: string | null) => ({ cookie: `${AUTH_COOKIE}=${makeToken(password, name, Date.now())}` });

  function check(password: string | null = PW) {
    const clock = { t: 0 };
    const access = accessGuard(password, createRateLimiter({ now: () => clock.t }));
    return { guard: (r: IncomingMessage, ip = IP) => access.check(r, ip), access, clock };
  }

  /** The 401 that sends the page to its sign-in screen: code SIGN_IN, no WWW-Authenticate, so no browser popup. */
  function expect401(run: () => unknown, message = 'Wrong password'): void {
    const error = httpError(run);
    expect([error, error.headers]).toEqual([expect.objectContaining({ status: 401, code: 'SIGN_IN', message }), undefined]);
  }
  const expect429 = (run: () => unknown, retryAfter: string) =>
    expect(httpError(run)).toMatchObject({ status: 429, code: 'RATE_LIMITED', headers: { 'Retry-After': retryAfter } });

  // [what, the site's password, request headers, the user let in or the 401 message].
  it.each<[string, string | null, Record<string, string>, { user: string | null } | string]>([
    ['a public site, no credentials', null, {}, { user: null }],
    ['a public site, naming a Basic user', null, basic('smoke', 'x'), { user: 'smoke' }],
    ['the right Basic password, no user name', PW, basic('', PW), { user: null }],
    ['the right Basic password, any user name', PW, basic('anyone', PW), { user: 'anyone' }],
    ['a lower-case basic scheme', PW, { authorization: basic('player', PW).authorization.replace('Basic', 'basic') }, { user: 'player' }],
    ['a sign-in cookie among others', PW, { cookie: `a=b; ${cookie(PW, 'Sam').cookie}` }, { user: 'Sam' }],
    ['a sign-in cookie with no name', PW, cookie(PW, null), { user: null }],
    // Everything after the first colon is the password (RFC 7617), in UTF-8.
    ['a password with a colon', 'pa:ss wörd', basic('u', 'pa:ss wörd'), { user: 'u' }],
    ['a near miss of it', 'pa:ss wörd', basic('u', 'pa:ss word'), 'Wrong password'],
    ['it with no user part', 'pa:ss wörd', { authorization: `Basic ${b64('pa:ss wörd')}` }, 'Wrong password'],
    ['no credentials', PW, {}, 'Sign in first'],
    ['a Bearer token', PW, { authorization: `Bearer ${PW}` }, 'Sign in first'],
    ['a bare Basic', PW, { authorization: 'Basic' }, 'Sign in first'],
    ['a forged cookie', PW, { cookie: `${AUTH_COOKIE}=forged.token` }, 'Sign in first'],
    ['a cookie made under another password', PW, cookie('other', 'Sam'), 'Sign in first'],
    ['a wrong password', PW, basic('player', `${PW}!`), 'Wrong password'],
    ['an empty password', PW, basic('player', ''), 'Wrong password'],
  ])('%s', (_, password, headers, outcome) => {
    const { guard } = check(password);
    if (typeof outcome === 'string') expect401(() => guard(req(headers)), outcome);
    else expect(guard(req(headers))).toEqual(outcome);
  });

  it('does not count missing credentials, a right login or a peek as a wrong try; peek names a signed-in request and is null otherwise', () => {
    const { guard, access } = check();
    for (let i = 0; i < 30; i++) expect401(() => guard(req()), 'Sign in first');
    for (let i = 0; i < 30; i++) access.login(PW, IP);
    for (let i = 0; i < 30; i++) expect(access.peek(req(basic('', 'no')))).toBeNull();
    expect([access.peek(req(cookie(PW, 'Sam'))), access.peek(req(basic('smoke', PW))), access.peek(req()), guard(req(basic('', PW)))])
      .toEqual([{ user: 'Sam' }, { user: 'smoke' }, null, { user: null }]);
  });

  it('answers the 11th wrong try in 10 minutes with 429, even with the right password or a login; a cookie, another IP or another /64 pass', () => {
    const { guard, access } = check();
    const [v6, sameNet] = ['2001:db8:1:2::1', '2001:db8:1:2:ffff::9'];
    for (let i = 0; i < 10; i++) expect401(() => guard(req(basic('', `guess ${i}`)), v6));
    expect429(() => guard(req(basic('', 'guess 10')), sameNet), '60');
    expect429(() => guard(req(basic('', PW)), sameNet), '60');
    expect429(() => access.login(PW, v6), '60');
    expect401(() => guard(req(), v6), 'Sign in first');
    expect([guard(req(cookie(PW, 'Sam')), v6), guard(req(basic('', PW)), '2001:db8:1:3::1'), guard(req(basic('', PW)))])
      .toEqual([{ user: 'Sam' }, { user: null }, { user: null }]);
  });

  it('gives tries back over time, one a minute', () => {
    const { guard, clock } = check();
    for (let i = 0; i < 10; i++) expect401(() => guard(req(basic('', 'no'))));
    clock.t = 30_000;
    expect429(() => guard(req(basic('', PW))), '30');
    clock.t = 60_010;
    expect401(() => guard(req(basic('', 'no'))));
    expect429(() => guard(req(basic('', 'no'))), '60');
    clock.t = 120_100;
    expect(guard(req(basic('', PW)))).toEqual({ user: null });
  });
});

describe('checkOrigin and checkContentType', () => {
  // [Host, Origin, passes, allowed origins].
  it.each<[string | undefined, string | undefined, boolean, string[]?]>([
    // No Origin, or one naming the same host as Host, port and case included.
    ['planner.example', undefined, true], ['planner.example', 'https://planner.example', true],
    ['planner.example:8080', 'http://planner.example:8080', true], ['Planner.Example', 'HTTPS://planner.EXAMPLE', true],
    ['[::1]:8080', 'http://[::1]:8080', true],
    // Another host or port, null, a non-http scheme, no Host.
    ['planner.example', 'https://evil.example', false], ['planner.example', 'https://planner.example.evil.example', false],
    ['planner.example', 'https://planner.example:444', false], ['planner.example:8080', 'http://planner.example', false],
    ['planner.example', 'null', false], ['planner.example', 'file://planner.example', false], ['planner.example', 'not a url', false],
    ['planner.example', 'chrome-extension://planner.example', false], [undefined, 'https://planner.example', false],
    // An allowed origin, whatever the Host.
    ['planner.example', 'http://localhost:5173', true, ['http://localhost:5173']],
    ['planner.example', 'http://localhost:5174', false, ['http://localhost:5173']],
  ])('checkOrigin: Host %s, Origin %s passes: %s', (host, origin, passes, allowed = []) => {
    const headers = Object.fromEntries(Object.entries({ host, origin }).filter(([, v]) => v !== undefined)) as Record<string, string>;
    const run = () => checkOrigin(req(headers), allowed);
    if (passes) expect(run).not.toThrow();
    else expect(httpError(run).status).toBe(403);
  });

  it.each<[string | undefined, 'json' | 'octet', boolean]>([
    ['application/json', 'json', true], ['application/json; charset=utf-8', 'json', true], ['Application/JSON', 'json', true],
    ['application/octet-stream', 'octet', true], ['application/octet-stream; foo=bar', 'octet', true],
    ['text/plain', 'json', false], [undefined, 'json', false], ['application/x-www-form-urlencoded', 'json', false],
    ['multipart/form-data', 'json', false], ['application/octet-stream', 'json', false], ['application/json', 'octet', false],
    [undefined, 'octet', false], ['application/jsonp', 'json', false],
  ])('checkContentType: %s for %s passes: %s', (given, wanted, passes) => {
    const run = () => checkContentType(req(given === undefined ? {} : { 'content-type': given }, SOCKET, 'POST'), wanted);
    if (passes) expect(run).not.toThrow();
    else expect(httpError(run).status).toBe(415);
  });
});

describe('sessionIdOf', () => {
  it('is the 32 lowercase hex of x-pkp-session; anything else is 400 SESSION_REQUIRED (sessionIdOrNull: null)', () => {
    const ID = '0123456789abcdef0123456789abcdef';
    expect([sessionIdOf(req({ 'x-pkp-session': ID })), sessionIdOrNull(req({ 'x-pkp-session': ID }))]).toEqual([ID, ID]);
    for (const bad of [undefined, [ID, ID], ID.toUpperCase(), ID.slice(1), `${ID}0`, `${ID.slice(1)}g`, '', ` ${ID}`, `${ID}\n`]) {
      const headers: Record<string, string | string[]> = bad === undefined ? {} : { 'x-pkp-session': bad };
      const error = httpError(() => sessionIdOf(req(headers)));
      expect([error.status, error.code, error.message]).toEqual([400, 'SESSION_REQUIRED', 'The session header is missing']);
      if (!Array.isArray(bad)) expect(sessionIdOrNull(req(headers))).toBeNull();
    }
  });
});

describe('cleanName and the sign-in token', () => {
  it.each([
    ['  Sam  ', 'Sam'], ['Sa\u0000m\u0007\n', 'Sam'], ['é'.repeat(50), 'é'.repeat(40)], ['🙂'.repeat(41), '🙂'.repeat(40)],
    ['   ', null], [undefined, null], [null, null],
  ])('cleanName(%j) is %j', (raw, clean) => {
    expect(cleanName(raw)).toBe(clean);
  });

  it('a token reads back its name and time under its password only, never holds it, and is refused forged, edited, old or future', () => {
    const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
    const token = makeToken('hunter2', 'Sam', NOW);
    const iat = Math.floor(NOW / 1000);
    const read = (t: string, at = NOW) => readToken('hunter2', t, at);
    expect([read(token, NOW + 1000), read(makeToken('hunter2', null, NOW)), readToken('hunter3', token, NOW)])
      .toEqual([{ name: 'Sam', iat }, { name: null, iat }, null]);
    expect([token.includes('hunter2'), Buffer.from(token.split('.')[0]!, 'base64url').toString().includes('hunter2')]).toEqual([false, false]);
    const [payload, mac] = token.split('.') as [string, string];
    const edited = Buffer.from(JSON.stringify({ n: 'Admin', iat })).toString('base64url');
    for (const bad of [
      `${edited}.${mac}`, `${payload}.${mac.slice(0, -2)}AA`, `${payload}.`, `.${mac}`, payload, '', 'a.b.c', `${payload}.${mac}x`,
      `${Buffer.from('not json').toString('base64url')}.${mac}`,
    ]) expect([bad, read(bad)]).toEqual([bad, null]);
    // Good for 30 days; one made 10 minutes in the future is refused.
    const age = SIGN_IN_MAX_AGE_S * 1000;
    expect([read(token, NOW + age - 1000) !== null, read(token, NOW + age + 1000), read(makeToken('hunter2', 'x', NOW + 600_000))])
      .toEqual([true, null, null]);
  });
});
