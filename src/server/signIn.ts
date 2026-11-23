// The hosted site's sign-in (polish phase): with `PKP_PASSWORD` set, the page asks for the password once
// (`POST /api/login`) and the browser keeps a cookie, in place of the browser's own Basic-auth popup. The cookie holds a
// token, `base64url(json { n: name | null, iat }) + "." + base64url(HMAC-SHA256)`, signed with a key derived from the
// password: it never holds the password, an edited one fails its MAC, and changing the password signs everyone out.
// The name is the one the player typed (optional), for the player's usage report; it is not an account.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const AUTH_COOKIE = 'pkp_auth';
/** How long a sign-in lasts: 30 days, the cookie's `Max-Age` and the token's age limit. */
export const SIGN_IN_MAX_AGE_S = 2_592_000;
/** How far ahead of the server's clock a token's time may be (a clock a little off). */
const CLOCK_SKEW_S = 60;
const NAME_LENGTH = 40;

/** A token's contents: the name typed at sign-in (or null) and its time, in whole seconds since 1970. */
export interface SignIn { name: string | null; iat: number }

/** A typed name: trimmed, control characters stripped, cut to 40 characters; null for nothing or a non-string. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = [...raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()].slice(0, NAME_LENGTH).join('').trim();
  return name === '' ? null : name;
}

/** The token key for `password`: an HMAC of it under a fixed label, so the key is never the password itself. */
const keyOf = (password: string): Buffer => createHmac('sha256', 'pkp-sign-in-v1').update(password, 'utf8').digest();

const macOf = (password: string, payload: string): Buffer => createHmac('sha256', keyOf(password)).update(payload, 'ascii').digest();

/** A token for `name`, signed now (`nowMs`) under `password`. */
export function makeToken(password: string, name: string | null, nowMs: number): string {
  const payload = Buffer.from(JSON.stringify({ n: name, iat: Math.floor(nowMs / 1000) }), 'utf8').toString('base64url');
  return `${payload}.${macOf(password, payload).toString('base64url')}`;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * The sign-in `token` holds, or null unless its MAC is right under `password` (compared in constant time), its contents
 * are `{ n, iat }`, and it is at most 30 days old and not from the future.
 */
export function readToken(password: string, token: string, nowMs: number): SignIn | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, mac] = parts as [string, string];
  if (!BASE64URL.test(payload) || !BASE64URL.test(mac)) return null;
  const given = Buffer.from(mac, 'base64url');
  const expected = macOf(password, payload);
  if (given.length !== expected.length || given.toString('base64url') !== mac || !timingSafeEqual(given, expected)) return null;
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const { n, iat } = body as Record<string, unknown>;
  if ((n !== null && typeof n !== 'string') || typeof iat !== 'number' || !Number.isInteger(iat)) return null;
  const now = Math.floor(nowMs / 1000);
  if (iat > now + CLOCK_SKEW_S || now - iat > SIGN_IN_MAX_AGE_S) return null;
  return { name: n, iat };
}

/** The request's sign-in cookie value, or null. */
export function authCookieOf(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === AUTH_COOKIE) return part.slice(at + 1).trim();
  }
  return null;
}

/** The request's HTTP Basic credentials (the user name and the password), or null. */
export function basicCredentials(req: IncomingMessage): { user: string; password: string } | null {
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(req.headers.authorization ?? '');
  if (basic === null) return null;
  const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? { user: '', password: decoded } : { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/**
 * Whether the request came over HTTPS: only a trusted proxy can say so (`trustProxy` > 0), by `X-Forwarded-Proto`, the
 * last value of which is the nearest proxy's. The Node server itself speaks plain HTTP.
 */
export function cameOverHttps(req: IncomingMessage, trustProxy: number): boolean {
  if (trustProxy === 0) return false;
  const proto = req.headers['x-forwarded-proto'];
  const last = (Array.isArray(proto) ? proto.join(',') : proto ?? '').split(',').map((p) => p.trim().toLowerCase()).pop();
  return last === 'https';
}

const COOKIE_ATTRIBUTES = 'HttpOnly; SameSite=Strict; Path=/';

/** The `Set-Cookie` that signs a browser in with `token`. */
export const signInCookie = (token: string, secure: boolean): string => `${AUTH_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${SIGN_IN_MAX_AGE_S}${secure ? '; Secure' : ''}`;

/** The `Set-Cookie` that signs a browser out. */
export const signOutCookie = (secure: boolean): string => `${AUTH_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0${secure ? '; Secure' : ''}`;
