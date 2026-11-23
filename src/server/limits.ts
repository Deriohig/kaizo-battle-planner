// Hosted mode's abuse limits, all in memory: the per-IP rate limits as token buckets, and the
// work gate that lets a few engine jobs run at once and queues the rest. Local mode uses neither.

import { isIPv4, isIPv6 } from 'node:net';
import { HttpError } from './http.js';

/** The rate classes of section 4.6's table. */
export type RateClass = 'static' | 'light' | 'work' | 'upload' | 'password';

/** A bucket of `capacity` tokens that refills at `capacity` per `perMs`. */
interface Rate { capacity: number; perMs: number }

const MINUTE = 60_000;
export const RATES: Readonly<Record<RateClass, readonly Rate[]>> = {
  static: [{ capacity: 3_000, perMs: MINUTE }],
  light: [{ capacity: 240, perMs: MINUTE }],
  work: [{ capacity: 180, perMs: MINUTE }],
  upload: [{ capacity: 30, perMs: MINUTE }, { capacity: 300, perMs: 60 * MINUTE }],
  password: [{ capacity: 10, perMs: 10 * MINUTE }],
};

/** The 8 groups of an IPv6 address, or null for one that does not parse. An IPv4 tail (`::ffff:1.2.3.4`) is two groups. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, '');
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4 !== null) {
    const [a, b, c, d] = v4[1]!.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0]!.split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1]!.split(':')) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** `ip` with an IPv4-mapped IPv6 address (`::ffff:203.0.113.9`) written as the IPv4 address it is. */
export function plainIp(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped !== null ? mapped[1]! : ip;
}

/**
 * `ip` cut to its first `v4Bits` (IPv4) or `v6Bits` (IPv6) as CIDR text: `203.0.113.0/24`, `2001:db8:1::/48`. A value
 * that is neither address is returned as it is (the socket always gives one).
 */
export function ipPrefix(ip: string, v4Bits: number, v6Bits: number): string {
  const plain = plainIp(ip);
  if (isIPv4(plain)) {
    const bytes = plain.split('.').map(Number);
    const kept = bytes.map((byte, i) => {
      const bits = Math.max(0, Math.min(8, v4Bits - i * 8));
      return byte & (0xff << (8 - bits)) & 0xff;
    });
    return `${kept.join('.')}/${v4Bits}`;
  }
  const groups = isIPv6(plain) ? ipv6Groups(plain) : null;
  if (groups === null) return plain;
  const kept = groups.map((group, i) => {
    const bits = Math.max(0, Math.min(16, v6Bits - i * 16));
    return bits === 0 ? 0 : group & (0xffff << (16 - bits)) & 0xffff;
  });
  const whole = Math.ceil(v6Bits / 16);
  return `${kept.slice(0, whole).map((g) => g.toString(16)).join(':')}::/${v6Bits}`;
}

/** The key a client is counted by: its IPv4 address, or its IPv6 /64. */
export const rateKey = (ip: string): string => ipPrefix(ip, 32, 64);

export interface RateLimiter {
  /**
   * Takes one token of `cls` for `key`: null when there was one in every bucket of the class (each loses one), else the
   * whole seconds until there is (nothing is taken).
   */
  take(cls: RateClass, key: string): number | null;
  /** As `take`, but takes nothing: null while a token is there. */
  peek(cls: RateClass, key: string): number | null;
  /** Forgets every key whose buckets are all full again. */
  sweep(): void;
  /** How many keys are held. */
  readonly size: number;
}

/**
 * Token buckets per key and class, at most `maxKeys` keys: past that a sweep runs, and if every key is still in use the
 * least recently counted is forgotten (a client forgotten starts full, which errs on its side).
 */
export function createRateLimiter(opts: { now?: () => number; maxKeys?: number } = {}): RateLimiter {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  type Buckets = Partial<Record<RateClass, { tokens: number[]; at: number }>>;
  const keys = new Map<string, Buckets>();
  /** When the cap last ran a sweep: at most one a second, so a flood of new keys does not pay a full scan each. */
  let lastFullSweep = -Infinity;

  function bucketsOf(cls: RateClass, key: string, create: boolean): { tokens: number[]; at: number } | null {
    let held = keys.get(key);
    if (held === undefined) {
      if (!create) return null;
      if (keys.size >= maxKeys) {
        if (now() - lastFullSweep >= 1_000) {
          lastFullSweep = now();
          sweep();
        }
        if (keys.size >= maxKeys) keys.delete(keys.keys().next().value!);
      }
      held = {};
    } else {
      keys.delete(key);
    }
    keys.set(key, held);
    let buckets = held[cls];
    const t = now();
    if (buckets === undefined) {
      buckets = { tokens: RATES[cls].map((rate) => rate.capacity), at: t };
      held[cls] = buckets;
    }
    const elapsed = Math.max(0, t - buckets.at);
    buckets.tokens = buckets.tokens.map((tokens, i) => Math.min(RATES[cls][i]!.capacity, tokens + (elapsed * RATES[cls][i]!.capacity) / RATES[cls][i]!.perMs));
    buckets.at = t;
    return buckets;
  }

  function wait(cls: RateClass, tokens: readonly number[]): number | null {
    let ms = 0;
    tokens.forEach((left, i) => {
      if (left < 1) ms = Math.max(ms, ((1 - left) * RATES[cls][i]!.perMs) / RATES[cls][i]!.capacity);
    });
    return ms === 0 ? null : Math.max(1, Math.ceil(ms / 1000));
  }

  function sweep(): void {
    const t = now();
    for (const [key, held] of keys) {
      const full = (Object.keys(held) as RateClass[]).every((cls) => {
        const { tokens, at } = held[cls]!;
        return tokens.every((left, i) => left + ((t - at) * RATES[cls][i]!.capacity) / RATES[cls][i]!.perMs >= RATES[cls][i]!.capacity);
      });
      if (full) keys.delete(key);
    }
  }

  return {
    take(cls, key) {
      const buckets = bucketsOf(cls, key, true)!;
      const retry = wait(cls, buckets.tokens);
      if (retry === null) buckets.tokens = buckets.tokens.map((left) => left - 1);
      return retry;
    },
    peek(cls, key) {
      const buckets = bucketsOf(cls, key, false);
      return buckets === null ? null : wait(cls, buckets.tokens);
    },
    sweep,
    get size() {
      return keys.size;
    },
  };
}

/** The 429 for a rate limit, with its `Retry-After`. */
export const rateLimited = (retryAfter: number): HttpError => new HttpError(
  429, `Too many requests: wait ${retryAfter} s and try again`, 'RATE_LIMITED', { 'Retry-After': String(retryAfter) });

/** The work gate's `Retry-After` on a 503 or 429 `BUSY`, in seconds. */
const BUSY_RETRY_AFTER = '2';

export interface WorkGate {
  /**
   * Runs `job` once a place is free: at once while fewer than `concurrency` run, else after the queue ahead of it. The job
   * gets a signal that aborts when `signal` does (the request closed) or `timeoutMs` after the call (the time counts the
   * wait in the queue). Rejects with 429 `BUSY` when `owner` (a session) already has `perOwner` jobs running or queued,
   * 503 `BUSY` (`Retry-After: 2`) when the queue is full, 503 `TIMEOUT` when the time ran out (waiting, or once the job
   * stops on it), and 499 `CLOSED` when `signal` aborted while it waited; else as `job` settles. `group` (the client's
   * rate key) is capped too, at `perGroup` jobs across all its owners, with the same 429 `BUSY`: one IP's sessions
   * cannot fill the queue for everyone else.
   */
  run<T>(owner: string, signal: AbortSignal | undefined, timeoutMs: number, job: (signal: AbortSignal) => Promise<T>, group?: string): Promise<T>;
  readonly running: number;
  readonly queued: number;
}

/** 503 `TIMEOUT`: the work took longer than its time. */
export const workTimedOut = (): HttpError => new HttpError(503, 'The planner took too long on this; try again', 'TIMEOUT');

/** A client IP's jobs at once, running or queued, across all its sessions: two sessions' worth. */
export const PER_GROUP = 8;

export function createWorkGate(opts: { concurrency: number; queue: number; perOwner?: number; perGroup?: number }): WorkGate {
  const perOwner = opts.perOwner ?? 4;
  const perGroup = opts.perGroup ?? PER_GROUP;
  let running = 0;
  const waiting: { start(): void; drop(): void }[] = [];
  const owners = new Map<string, number>();
  const groups = new Map<string, number>();

  const count = (counts: Map<string, number>, key: string, by: number) => {
    const left = (counts.get(key) ?? 0) + by;
    if (left <= 0) counts.delete(key);
    else counts.set(key, left);
  };

  function next(): void {
    while (running < opts.concurrency && waiting.length > 0) waiting.shift()!.start();
  }

  return {
    run<T>(owner: string, signal: AbortSignal | undefined, timeoutMs: number, job: (signal: AbortSignal) => Promise<T>, group?: string): Promise<T> {
      if ((owners.get(owner) ?? 0) >= perOwner) {
        return Promise.reject(new HttpError(429, 'This session has too much running at once; wait for it', 'BUSY', { 'Retry-After': BUSY_RETRY_AFTER }));
      }
      if (group !== undefined && (groups.get(group) ?? 0) >= perGroup) {
        return Promise.reject(new HttpError(429, 'Too much is running for you at once; wait for it', 'BUSY', { 'Retry-After': BUSY_RETRY_AFTER }));
      }
      if (running >= opts.concurrency && waiting.length >= opts.queue) {
        return Promise.reject(new HttpError(503, 'The planner is busy; try again in a moment', 'BUSY', { 'Retry-After': BUSY_RETRY_AFTER }));
      }
      if (signal?.aborted === true) return Promise.reject(new HttpError(499, 'The request was closed', 'CLOSED'));
      count(owners, owner, 1);
      if (group !== undefined) count(groups, group, 1);
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(workTimedOut()), timeoutMs);
      timer.unref();
      const jobSignal = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]);

      return new Promise<T>((resolve, reject) => {
        let state: 'waiting' | 'running' | 'done' = 'waiting';
        const finish = () => {
          clearTimeout(timer);
          jobSignal.removeEventListener('abort', onAbort);
          count(owners, owner, -1);
          if (group !== undefined) count(groups, group, -1);
        };
        const entry = {
          start() {
            if (state !== 'waiting') return;
            state = 'running';
            running += 1;
            // A job that throws before it returns its promise still settles here, so its place is freed.
            let work: Promise<T>;
            try {
              work = job(jobSignal);
            } catch (error) {
              work = Promise.reject(error);
            }
            work.then(
              (value) => {
                state = 'done';
                running -= 1;
                finish();
                next();
                resolve(value);
              },
              (error: unknown) => {
                state = 'done';
                running -= 1;
                finish();
                next();
                reject(timeout.signal.aborted ? workTimedOut() : error);
              },
            );
          },
          drop() {
            state = 'done';
            finish();
            reject(timeout.signal.aborted ? workTimedOut() : new HttpError(499, 'The request was closed', 'CLOSED'));
          },
        };
        // A job still waiting leaves the queue when its time runs out or its request closes; a running one stops at its
        // next yield, on the signal it was handed.
        function onAbort(): void {
          if (state !== 'waiting') return;
          const at = waiting.indexOf(entry);
          if (at >= 0) waiting.splice(at, 1);
          entry.drop();
        }
        jobSignal.addEventListener('abort', onAbort);
        if (running < opts.concurrency) entry.start();
        else waiting.push(entry);
      });
    },
    get running() {
      return running;
    },
    get queued() {
      return waiting.length;
    },
  };
}
