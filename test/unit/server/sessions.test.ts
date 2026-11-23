import { describe, expect, it } from 'vitest';
import type { BoxState } from '../../../src/server/box.js';
import { bytesEstimate, createSessionStore, type SessionLimits, type SessionStore } from '../../../src/server/sessions.js';

/** A stand-in box: the store only holds it and asks `estimate` what it costs. */
function box(name: string, bytes = 10): BoxState {
  return { json: { savePath: name, bytes } } as unknown as BoxState;
}
const estimate = (b: BoxState): number => (b.json as unknown as { bytes: number }).bytes;

const IPS = ['', '203.0.113.1/32', '203.0.113.2/32', '203.0.113.3/32'];
const [, IP1, IP2, IP3] = IPS as [string, string, string, string];

/** A store with a clock the test moves (`clock.t`), roomy caps and a 1 s idle time unless `limits` sets them. */
function store(limits: Partial<SessionLimits> = {}): { s: SessionStore; clock: { t: number } } {
  const clock = { t: 0 };
  const s = createSessionStore({ maxSessions: 100, perIp: 100, idleMs: 1000, memoryBytes: 1_000_000, now: () => clock.t, estimate, ...limits });
  return { s, clock };
}

describe('createSessionStore: get, put, has, delete and idle expiry', () => {
  it('holds a box with its cost, time and IP; a put again replaces it, counting only the new one; ids are apart and matched exactly', () => {
    const { s, clock } = store();
    const [one, two] = ['0123456789abcdef0123456789abcdef', 'fedcba9876543210fedcba9876543210'];
    clock.t = 5;
    const a = box('a.dsv', 40);
    s.put(one, a, IP1);
    expect([s.get(one), s.get(one)!.box === a, s.has(one), s.size, s.bytes])
      .toEqual([{ box: a, bytesEstimate: 40, lastUsed: 5, ip: IP1 }, true, true, 1, 40]);
    expect([s.get('nope'), s.has('nope'), s.get(one.toUpperCase()), s.get(one.slice(1))]).toEqual([undefined, false, undefined, undefined]);
    const [b, replaced] = [box('b', 20), box('two', 25)];
    s.put(two, b, IP1);
    s.put(one, replaced, IP2);
    expect([s.get(one), s.get(two)!.box === b, s.size, s.bytes])
      .toEqual([expect.objectContaining({ box: replaced, ip: IP2, bytesEstimate: 25 }), true, 2, 45]);
    // A delete forgets the id; one of an unknown id changes nothing.
    s.delete(one);
    s.delete('zzz');
    expect([s.has(one), s.get(one), s.size, s.bytes]).toEqual([false, undefined, 1, 20]);
  });

  it('costs a box at 4 × its JSON length by default', () => {
    const b = { json: { savePath: 'x.dsv' } } as unknown as BoxState;
    expect(bytesEstimate(b)).toBe(4 * JSON.stringify({ savePath: 'x.dsv' }).length);
    const s = createSessionStore({ maxSessions: 10, perIp: 10, idleMs: 1000, memoryBytes: 1000 });
    s.put('a', b, IP1);
    expect(s.bytes).toBe(4 * 20);
  });

  it('holds a session up to the idle time and not a millisecond past it; get restarts the idle time, has does not', () => {
    const { s, clock } = store();
    s.put('a', box('a'), IP1);
    s.put('b', box('b'), IP1);
    clock.t = 900;
    s.get('a');
    expect(s.has('b')).toBe(true);
    clock.t = 1001;
    expect([s.has('b'), s.has('a')]).toEqual([false, true]);
    clock.t = 1900;
    expect(s.get('a')!.lastUsed).toBe(1900);
    clock.t = 2901;
    expect([s.get('a'), s.get('b'), s.size, s.bytes]).toEqual([undefined, undefined, 0, 0]);
  });

  it('sweep drops every idle session and keeps the rest, with the bytes kept exact', () => {
    const { s, clock } = store();
    s.put('old', box('old', 30), IP1);
    clock.t = 600;
    s.put('new', box('new', 7), IP2);
    clock.t = 1500;
    s.sweep();
    expect([s.has('old'), s.has('new'), s.size, s.bytes]).toEqual([false, true, 1, 7]);
  });
});

describe('createSessionStore: caps', () => {
  /** Runs `ops` on a fresh store: `a1` puts box a from IP 1 (`a1:40` costing 40 bytes); `get a` and `has a` read it. */
  function run(limits: Partial<SessionLimits>, ops: string[]): { s: SessionStore; ids: string[] } {
    const { s } = store(limits);
    const ids: string[] = [];
    for (const op of ops) {
      const [verb, id] = op.split(' ') as [string, string];
      if (verb === 'get') s.get(id);
      else if (verb === 'has') s.has(id);
      else {
        const [, name, ip, bytes] = /^([a-z]+)(\d)(?::(\d+))?$/.exec(op)! as unknown as [string, string, string, string | undefined];
        if (!ids.includes(name)) ids.push(name);
        s.put(name, box(name, bytes === undefined ? 10 : Number(bytes)), IPS[Number(ip)]!);
      }
    }
    return { s, ids };
  }

  it.each<[string, Partial<SessionLimits>, string[], string[], number?]>([
    ['over the count cap, the least recently used goes, whoever holds it', { maxSessions: 2 }, ['a1', 'b2', 'c3'], ['b', 'c']],
    ['a get moves a session to the back of the drop order', { maxSessions: 2 }, ['a1', 'b2', 'get a', 'c3'], ['a', 'c']],
    ['a has does not move it', { maxSessions: 2 }, ['a1', 'b2', 'has a', 'c3'], ['b', 'c']],
    ['over the per-IP cap, that IP drops its own oldest, not an older one of another IP', { perIp: 2 }, ['a1', 'x2', 'b1', 'c1'], ['x', 'b', 'c']],
    ['the per-IP drop order follows get too', { perIp: 2 }, ['a1', 'b1', 'get a', 'c1'], ['a', 'c']],
    ['a replace by the same id counts once against the per-IP cap', { perIp: 1 }, ['a1', 'a1'], ['a']],
    ['the session just put stays over a per-IP cap of 1', { perIp: 1 }, ['a1', 'b1'], ['b']],
    ['the session just put stays over a count cap of 1', { maxSessions: 1 }, ['a1', 'b2'], ['b']],
    ['over the memory budget, the least recently used go until it fits', { memoryBytes: 100 }, ['a1:40', 'b2:40', 'c3:40'], ['b', 'c'], 80],
    ['a big one drops all the others', { memoryBytes: 100 }, ['a1:40', 'b2:40', 'c3:40', 'd1:90'], ['d'], 90],
    ['the session just put stays, even alone over the memory budget', { memoryBytes: 50 }, ['a1:10', 'big2:80'], ['big'], 80],
  ])('%s', (_, limits, ops, kept, bytes) => {
    const { s, ids } = run(limits, ops);
    expect(ids.filter((id) => s.has(id))).toEqual(kept);
    expect(s.size).toBe(kept.length);
    if (bytes !== undefined) expect(s.bytes).toBe(bytes);
  });

  it('keeps bytes equal to the sum of what it holds through puts, replaces, drops, deletes and expiry', () => {
    const { s, clock } = store({ maxSessions: 3, perIp: 2, memoryBytes: 200 });
    const sizes = new Map<string, number>();
    const check = () => expect(s.bytes).toBe([...sizes].reduce((sum, [id, bytes]) => sum + (s.has(id) ? bytes : 0), 0));
    for (const [id, bytes, ip] of [['a', 50, IP1], ['b', 60, IP1], ['c', 70, IP1], ['a', 10, IP2], ['d', 90, IP3], ['e', 120, IP2]] as const) {
      sizes.set(id, bytes);
      s.put(id, box(id, bytes), ip);
      check();
    }
    s.delete('e');
    sizes.delete('e');
    check();
    sizes.set('f', 5);
    s.put('f', box('f', 5), IP3);
    check();
    clock.t = 5000;
    s.sweep();
    expect([s.size, s.bytes]).toEqual([0, 0]);
  });
});
