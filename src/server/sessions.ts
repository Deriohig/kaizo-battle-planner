// Hosted mode's session store: each player's box, by the session id their page made, in this
// one process. The raw save bytes are never kept, only the box built from them. A session dropped (idle, over a cap,
// or a restart) heals by itself: the page re-sends its save on the next `NO_SAVE`. So nobody is ever refused for room.

import type { BoxState } from './box.js';

export interface Session { box: BoxState; bytesEstimate: number; lastUsed: number; ip: string }

/** What a box costs the store: 4 × its JSON's length (section 4.3). */
export const bytesEstimate = (box: BoxState): number => 4 * JSON.stringify(box.json).length;

export interface SessionStore {
  /** The session `id` holds, marked as just used; undefined when there is none (never loaded, dropped or expired). */
  get(id: string): Session | undefined;
  /** Whether `id` is held, without marking it used. */
  has(id: string): boolean;
  /**
   * Gives `id` the box `box`, replacing any it held, for a client at `ip` (the rate key it is counted by), then drops the
   * least recently used sessions while a cap is passed: `ip`'s own first over the per-IP cap, then anyone's over the
   * count and the memory budget. The session just put is never the one dropped.
   */
  put(id: string, box: BoxState, ip: string): void;
  delete(id: string): void;
  /** Drops every session idle for longer than the idle time. */
  sweep(): void;
  readonly size: number;
  /** The sum of the held sessions' `bytesEstimate`. */
  readonly bytes: number;
}

export interface SessionLimits {
  maxSessions: number; perIp: number; idleMs: number; memoryBytes: number;
  now?: () => number;
  /** How a box is costed (default `bytesEstimate`); the tests pass a smaller one. */
  estimate?: (box: BoxState) => number;
}

export function createSessionStore(limits: SessionLimits): SessionStore {
  const now = limits.now ?? Date.now;
  const estimate = limits.estimate ?? bytesEstimate;
  /** Least recently used first: a use moves a session to the end. */
  const sessions = new Map<string, Session>();
  let bytes = 0;

  function drop(id: string): void {
    const session = sessions.get(id);
    if (session === undefined) return;
    bytes -= session.bytesEstimate;
    sessions.delete(id);
  }

  /** The least recently used session other than `keep` that `match` accepts, or undefined. */
  function oldest(keep: string, match: (s: Session) => boolean = () => true): string | undefined {
    for (const [id, session] of sessions) if (id !== keep && match(session)) return id;
    return undefined;
  }

  function expired(session: Session, t: number): boolean {
    return t - session.lastUsed > limits.idleMs;
  }

  return {
    get(id) {
      const session = sessions.get(id);
      if (session === undefined) return undefined;
      const t = now();
      if (expired(session, t)) {
        drop(id);
        return undefined;
      }
      session.lastUsed = t;
      sessions.delete(id);
      sessions.set(id, session);
      return session;
    },
    has(id) {
      const session = sessions.get(id);
      return session !== undefined && !expired(session, now());
    },
    put(id, box, ip) {
      drop(id);
      const session: Session = { box, bytesEstimate: estimate(box), lastUsed: now(), ip };
      sessions.set(id, session);
      bytes += session.bytesEstimate;
      let fromIp = 0;
      for (const s of sessions.values()) if (s.ip === ip) fromIp += 1;
      while (fromIp > limits.perIp) {
        const victim = oldest(id, (s) => s.ip === ip);
        if (victim === undefined) break;
        drop(victim);
        fromIp -= 1;
      }
      while (sessions.size > limits.maxSessions || bytes > limits.memoryBytes) {
        const victim = oldest(id);
        if (victim === undefined) break;
        drop(victim);
      }
    },
    delete: drop,
    sweep() {
      const t = now();
      for (const [id, session] of sessions) if (expired(session, t)) drop(id);
    },
    get size() {
      return sessions.size;
    },
    get bytes() {
      return bytes;
    },
  };
}
