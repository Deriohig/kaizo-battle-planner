// Hosted mode's guard, in place of local mode's `checkLocalRequest`: the
// security headers every hosted answer carries, the client's IP, the site password (the sign-in cookie of signIn.ts, or
// HTTP Basic for scripts), the `Origin` check, the content types and the session header. No CORS header is ever sent, and the session travels in a custom header, so
// another site's page can neither read an answer nor send a player's session.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { SESSION_HEADER, SESSION_ID } from '../contracts/hosted.js';
import { HttpError } from './http.js';
import { plainIp, type RateLimiter, rateKey, rateLimited } from './limits.js';
import { authCookieOf, basicCredentials, cleanName, readToken } from './signIn.js';

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Robots-Tag': 'noindex',
};

/** Sets `SECURITY_HEADERS` on `res`; a later `writeHead` keeps them. */
export function setSecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

/**
 * The client's IP: the socket's address, or with `trustProxy` n > 0 the n-th address from the right of
 * `X-Forwarded-For` (each proxy in front appends the address it saw), falling back to the socket's when the header is
 * shorter. With `trustProxy` 0 a request carrying `X-Forwarded-For` calls `onProxied` (the server warns once: every
 * player would otherwise share the proxy's limits).
 */
export function clientIp(req: IncomingMessage, trustProxy: number, onProxied: () => void): string {
  const socketIp = plainIp(req.socket.remoteAddress ?? '0.0.0.0');
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded === undefined) return socketIp;
  if (trustProxy === 0) {
    onProxied();
    return socketIp;
  }
  const hops = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded).split(',').map((hop) => hop.trim()).filter((hop) => hop !== '');
  const hop = hops[hops.length - trustProxy];
  if (hop === undefined) return socketIp;
  // `[v6]:port` and `v4:port` lose their port; anything that is then not an IP falls back to the socket's address.
  const bare = plainIp(hop.replace(/^\[(.*)\](:\d+)?$/, '$1').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1'));
  return isIP(bare) === 0 ? socketIp : bare;
}

/** Who a request is, once let in: the name typed at sign-in, or the Basic user name, or null. */
export interface Access { user: string | null }

/** The 401 for a request with no sign-in: no `WWW-Authenticate`, so the browser shows no popup and the page signs in. */
const signInFirst = (): HttpError => new HttpError(401, 'Sign in first', 'SIGN_IN');
const wrongPassword = (): HttpError => new HttpError(401, 'Wrong password', 'SIGN_IN');

const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

export interface AccessGuard {
  /**
   * Lets a request in, or throws: a sign-in cookie made under the password passes; else HTTP Basic (scripts, the smoke
   * test), its password compared with `timingSafeEqual` over SHA-256 digests; else 401 "Sign in first". A wrong Basic
   * password is 401 "Wrong password" and counts as a wrong try; while the IP has used up its tries (10 in 10 minutes)
   * any Basic try is 429. A valid cookie is never locked out by someone else's wrong tries from the same address. On a
   * public site (no password) everyone passes.
   */
  check(req: IncomingMessage, ip: string): Access;
  /** As `check`, but never throws and counts nothing: null for a request that is not signed in. */
  peek(req: IncomingMessage): Access | null;
  /** `POST /api/login`'s password: returns for the right one; 429 while locked, 401 "Wrong password" (counted) else. */
  login(given: string, ip: string): void;
}

/** The site password's guard; `now` is the clock a token's age is read by. */
export function accessGuard(password: string | null, limiter: RateLimiter, now: () => number = Date.now): AccessGuard {
  const expected = password === null ? null : digest(password);
  const right = (given: string) => expected !== null && timingSafeEqual(digest(given), expected);
  const cookieUser = (req: IncomingMessage): Access | null => {
    const token = authCookieOf(req);
    const signedIn = token === null || password === null ? null : readToken(password, token, now());
    return signedIn === null ? null : { user: signedIn.name };
  };
  const attempt = (given: string, ip: string): void => {
    const key = rateKey(ip);
    const locked = limiter.peek('password', key);
    if (locked !== null) throw rateLimited(locked);
    if (right(given)) return;
    limiter.take('password', key);
    throw wrongPassword();
  };
  return {
    check(req, ip) {
      const basic = basicCredentials(req);
      if (password === null) return { user: basic === null ? null : cleanName(basic.user) };
      const signed = cookieUser(req);
      if (signed !== null) return signed;
      if (basic === null) throw signInFirst();
      attempt(basic.password, ip);
      return { user: cleanName(basic.user) };
    },
    peek(req) {
      const basic = basicCredentials(req);
      if (password === null) return { user: basic === null ? null : cleanName(basic.user) };
      const signed = cookieUser(req);
      if (signed !== null) return signed;
      return basic !== null && right(basic.password) ? { user: cleanName(basic.user) } : null;
    },
    login(given, ip) {
      if (password !== null) attempt(given, ip);
    },
  };
}

/**
 * 403 unless a request's `Origin`, when it has one, names the host it was sent to (the `Host` header) or is one of
 * `allowed` (`PKP_ALLOW_ORIGIN`, for the Vite dev proxy). An opaque origin ("null") is refused.
 */
export function checkOrigin(req: IncomingMessage, allowed: readonly string[]): void {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  if (allowed.includes(origin.replace(/\/$/, '').toLowerCase())) return;
  let host: string | null = null;
  try {
    const url = new URL(origin);
    if (url.protocol === 'http:' || url.protocol === 'https:') host = url.host.toLowerCase();
  } catch {
    host = null;
  }
  const own = (req.headers.host ?? '').toLowerCase();
  if (host === null || own === '' || host !== own) throw new HttpError(403, 'Requests must come from the planner page');
}

/** The body type a hosted route takes. */
export type BodyType = 'json' | 'octet';

/** 415 unless the request's `Content-Type` (its parameters aside) is `type`'s. */
export function checkContentType(req: IncomingMessage, type: BodyType): void {
  const given = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  const wanted = type === 'json' ? 'application/json' : 'application/octet-stream';
  if (given !== wanted) throw new HttpError(415, `A ${req.method} here takes ${type === 'json' ? 'a JSON body' : "the save file's bytes"}: send Content-Type: ${wanted}`);
}

/** The request's session id (`x-pkp-session`), or 400 `SESSION_REQUIRED` when it is missing or not 32 lowercase hex. */
export function sessionIdOf(req: IncomingMessage): string {
  const id = req.headers[SESSION_HEADER];
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new HttpError(400, 'The session header is missing', 'SESSION_REQUIRED');
  return id;
}

/** The request's session id when it has a well-formed one, else null (for the log). */
export function sessionIdOrNull(req: IncomingMessage): string | null {
  const id = req.headers[SESSION_HEADER];
  return typeof id === 'string' && SESSION_ID.test(id) ? id : null;
}
