import { describe, expect, it } from 'vitest';
import { HttpError } from '../../../src/server/http.js';
import {
  createRateLimiter, createWorkGate, ipPrefix, plainIp, type RateClass, rateKey, rateLimited, workTimedOut,
} from '../../../src/server/limits.js';

describe('ipPrefix, plainIp and rateKey', () => {
  it.each([
    ['203.0.113.77', 24, 48, '203.0.113.0/24'], ['203.0.113.77', 32, 64, '203.0.113.77/32'], ['10.255.255.255', 24, 48, '10.255.255.0/24'],
    ['::ffff:203.0.113.77', 24, 48, '203.0.113.0/24'], ['::FFFF:1.2.3.4', 32, 64, '1.2.3.4/32'],
    ['2001:db8:1:2:3:4:5:6', 24, 48, '2001:db8:1::/48'], ['2001:db8:1:2:3:4:5:6', 32, 64, '2001:db8:1:2::/64'],
    ['2001:DB8:ABCD:12FF::1', 32, 64, '2001:db8:abcd:12ff::/64'],
    // ::-compressed forms are expanded first.
    ['2001:db8::1', 24, 48, '2001:db8:0::/48'], ['2001:db8::1', 32, 64, '2001:db8:0:0::/64'], ['::1', 32, 64, '0:0:0:0::/64'],
    ['::', 24, 48, '0:0:0::/48'], ['fe80::', 32, 64, 'fe80:0:0:0::/64'], ['2001:db8:1:2::', 32, 64, '2001:db8:1:2::/64'],
    // An IPv4 tail that is not a mapped address reads as two groups; a value that is no address stays as it is.
    ['64:ff9b::1.2.3.4', 32, 64, '64:ff9b:0:0::/64'], ['unknown', 24, 48, 'unknown'],
  ])('ipPrefix(%s, %i, %i) is %s', (ip, v4, v6, prefix) => {
    expect(ipPrefix(ip, v4, v6)).toBe(prefix);
  });

  it('plainIp writes a mapped address as IPv4; rateKey counts IPv4 whole and IPv6 by its /64', () => {
    expect([plainIp('::ffff:1.2.3.4'), plainIp('2001:db8::1')]).toEqual(['1.2.3.4', '2001:db8::1']);
    expect([rateKey('1.2.3.4'), rateKey('::ffff:1.2.3.4'), rateKey('2001:db8:1:2::a')]).toEqual(['1.2.3.4/32', '1.2.3.4/32', '2001:db8:1:2::/64']);
    const same = (a: string, b: string) => rateKey(a) === rateKey(b);
    expect([same('1.2.3.5', '1.2.3.4'), same('2001:db8:1:2::a', '2001:db8:1:2:ffff:ffff:ffff:b'), same('2001:db8:1:3::a', '2001:db8:1:2::a')])
      .toEqual([false, true, false]);
    const limiter = createRateLimiter({ now: () => 0 });
    for (let i = 0; i < 240; i++) expect(limiter.take('light', rateKey(`2001:db8:1:2::${(i % 200).toString(16)}`))).toBeNull();
    expect([limiter.take('light', rateKey('2001:db8:1:2:dead:beef::1')), limiter.take('light', rateKey('2001:db8:1:3::1'))]).toEqual([1, null]);
  });
});

describe('createRateLimiter', () => {
  /** A limiter with a clock the test moves. */
  function limiter(maxKeys?: number) {
    const clock = { t: 0 };
    return { l: createRateLimiter({ now: () => clock.t, ...(maxKeys === undefined ? {} : { maxKeys }) }), clock };
  }

  it.each<[RateClass, number, number]>([
    ['static', 3000, 1], ['light', 240, 1], ['work', 180, 1], ['upload', 30, 2], ['password', 10, 60],
  ])('%s: %i at once, then Retry-After %i s; another key or class has its own bucket', (cls, capacity, retry) => {
    const { l } = limiter();
    for (let i = 0; i < capacity; i++) expect(l.take(cls, 'k')).toBeNull();
    expect([l.take(cls, 'k'), l.take(cls, 'k'), l.take(cls, 'other'), l.take(cls === 'light' ? 'work' : 'light', 'k')])
      .toEqual([retry, retry, null, null]);
  });

  it('refills at the class rate with Retry-After in whole seconds rounded up; peek takes nothing and knows no uncounted key', () => {
    const { l, clock } = limiter();
    expect([l.peek('light', 'new'), l.size]).toEqual([null, 0]);
    for (let i = 0; i < 239; i++) l.take('light', 'k');
    expect([l.peek('light', 'k'), l.peek('light', 'k'), l.take('light', 'k'), l.peek('light', 'k'), l.take('light', 'k')])
      .toEqual([null, null, null, 1, 1]);
    clock.t = 250;
    expect([l.take('light', 'k'), l.take('light', 'k')]).toEqual([null, 1]);
    clock.t = 60_250;
    for (let i = 0; i < 240; i++) expect(l.take('light', 'k')).toBeNull();
    for (let i = 0; i < 10; i++) l.take('password', 'k');
    expect([l.take('light', 'k'), l.take('password', 'k')]).toEqual([1, 60]);
    for (const [t, retry] of [[90_750, 30], [120_249, 1], [120_260, null]] as const) {
      clock.t = t;
      expect([t, l.take('password', 'k')]).toEqual([t, retry]);
    }
  });

  it('upload: 30 a minute AND 300 an hour; a refused take takes nothing', () => {
    const { l, clock } = limiter();
    // 30 a minute for 11 minutes: the hour bucket loses 30 and regains 5 a minute, so 25 are left in minute 11.
    for (let minute = 0; minute < 11; minute++) {
      clock.t = minute * 60_000;
      for (let i = 0; i < 30; i++) expect(l.take('upload', 'k'), `minute ${minute}, upload ${i}`).toBeNull();
      expect(l.take('upload', 'k')).toBe(2);
    }
    clock.t = 11 * 60_000;
    for (let i = 0; i < 25; i++) expect(l.take('upload', 'k')).toBeNull();
    // The minute bucket still holds 5; the hour bucket is empty and refills one in 12 s.
    expect([l.take('upload', 'k'), l.peek('upload', 'k')]).toEqual([12, 12]);
    clock.t += 12_000;
    expect([l.take('upload', 'k'), l.take('upload', 'k')]).toEqual([null, 12]);
  });

  it('sweep forgets keys whose buckets are all full again, and keeps the rest', () => {
    const { l, clock } = limiter();
    l.take('light', 'a');
    clock.t = 50_000;
    for (let i = 0; i < 240; i++) l.take('light', 'b');
    clock.t = 60_000;
    l.sweep();
    expect(l.size).toBe(1);
    for (let i = 0; i < 40; i++) expect(l.take('light', 'b')).toBeNull();
    expect(l.take('light', 'b')).toBe(1);
  });

  it('holds at most maxKeys (10,000 by default): a new key sweeps first, then forgets the least recently counted', () => {
    const { l, clock } = limiter(2);
    l.take('light', 'a');
    for (let i = 0; i < 240; i++) l.take('light', 'b');
    // 300 ms on, a is full again (swept) and b holds 1.2 tokens (kept, not started afresh).
    clock.t = 300;
    l.take('light', 'c');
    expect([l.size, l.take('light', 'b'), l.take('light', 'b')]).toEqual([2, null, 1]);
    for (let i = 0; i < 240; i++) l.take('light', 'c');
    l.take('light', 'd');
    // b was counted before c, so b went; c is still empty.
    expect([l.size, l.take('light', 'c')]).toEqual([2, 1]);
    const big = limiter().l;
    for (let i = 0; i < 240; i++) big.take('light', 'k0');
    for (let i = 1; i <= 10_000; i++) big.take('light', `k${i}`);
    expect([big.size, big.take('light', 'k0')]).toEqual([10_000, null]);
  });

  it('rateLimited is a 429 RATE_LIMITED with Retry-After; workTimedOut the 503 TIMEOUT', () => {
    expect([rateLimited(7) instanceof HttpError, rateLimited(7), workTimedOut()]).toEqual([
      true, expect.objectContaining({ status: 429, code: 'RATE_LIMITED', headers: { 'Retry-After': '7' } }),
      expect.objectContaining({ status: 503, code: 'TIMEOUT' }),
    ]);
  });
});

describe('createWorkGate', () => {
  /** A job the test settles by hand, noting whether it started and the signal it got; `onAbort` rejects it when its signal aborts. */
  function job(onAbort?: Error) {
    let resolve!: (value: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const rec = { started: false, signal: null as AbortSignal | null, resolve, reject };
    const fn = (signal: AbortSignal): Promise<string> => {
      Object.assign(rec, { started: true, signal });
      if (onAbort) signal.addEventListener('abort', () => reject(onAbort));
      return promise;
    };
    return { rec, fn };
  }

  const settled = <T>(p: Promise<T>): Promise<{ value?: T; error?: unknown }> => p.then((value) => ({ value }), (error: unknown) => ({ error }));
  const sync = (): Promise<string> => {
    throw new Error('sync');
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  async function expectHttp(p: Promise<unknown>, status: number, code: string, headers?: Record<string, string>): Promise<void> {
    const { error } = await settled(p);
    expect([error instanceof HttpError, error]).toEqual([true, expect.objectContaining({ status, code, ...(headers && { headers }) })]);
  }

  it('runs at most concurrency jobs at once, queues the rest in order, and answers 503 BUSY (Retry-After 2) when the queue is full', async () => {
    const gate = createWorkGate({ concurrency: 2, queue: 2 });
    const jobs = [job(), job(), job(), job(), job()];
    const [pa, pb, pc, pd, pe] = jobs.map((j, i) => gate.run(`o${i}`, undefined, 10_000, j.fn));
    const state = () => [jobs.map((j) => j.rec.started), gate.running, gate.queued];
    await expectHttp(pe!, 503, 'BUSY', { 'Retry-After': '2' });
    expect(state()).toEqual([[true, true, false, false, false], 2, 2]);
    jobs[0]!.rec.resolve('A');
    await expect(pa).resolves.toBe('A');
    expect(state()).toEqual([[true, true, true, false, false], 2, 1]);
    jobs[1]!.rec.reject(new Error('boom'));
    await expect(pb).rejects.toThrow('boom');
    expect(jobs[3]!.rec.started).toBe(true);
    jobs[2]!.rec.resolve('C');
    jobs[3]!.rec.resolve('D');
    await expect(Promise.all([pc, pd])).resolves.toEqual(['C', 'D']);
    expect([gate.running, gate.queued]).toEqual([0, 0]);
  });

  it('answers 429 BUSY to a fifth job of one owner, running or queued, and frees the place when one ends, fails or times out', async () => {
    const gate = createWorkGate({ concurrency: 1, queue: 10 });
    const jobs = [job(), job(), job(), job()];
    const runs = jobs.map((j) => gate.run('s', undefined, 10_000, j.fn));
    await expectHttp(gate.run('s', undefined, 10_000, job().fn), 429, 'BUSY', { 'Retry-After': '2' });
    const other = job();
    const po = gate.run('t', undefined, 10_000, other.fn);
    expect(gate.queued).toBe(4);
    jobs[0]!.rec.resolve('0');
    await runs[0];
    const fifth = job();
    const p5 = gate.run('s', undefined, 10_000, fifth.fn);
    await expectHttp(gate.run('s', undefined, 10_000, job().fn), 429, 'BUSY');
    for (const j of [...jobs.slice(1), other, fifth]) j.rec.resolve('x');
    await expect(Promise.all([...runs, po, p5])).resolves.toHaveLength(6);

    const one = createWorkGate({ concurrency: 4, queue: 0, perOwner: 1 });
    const failing = job();
    const pf = settled(one.run('s', undefined, 10_000, failing.fn));
    failing.rec.reject(new Error('no'));
    await pf;
    await expectHttp(one.run('s', undefined, 20, job(new Error('stopped')).fn), 503, 'TIMEOUT');
    const last = job();
    const pl = one.run('s', undefined, 10_000, last.fn);
    last.rec.resolve('ok');
    await expect(pl).resolves.toBe('ok');
  });

  it('caps the jobs of one group (a client IP) across its owners: 429 BUSY past perGroup, other groups unaffected', async () => {
    const gate = createWorkGate({ concurrency: 1, queue: 10, perOwner: 4, perGroup: 2 });
    const [a, b, c, d] = [job(), job(), job(), job()];
    const pa = gate.run('s1', undefined, 10_000, a.fn, 'ip-1');
    const pb = gate.run('s2', undefined, 10_000, b.fn, 'ip-1');
    await expectHttp(gate.run('s3', undefined, 10_000, job().fn, 'ip-1'), 429, 'BUSY');
    const pc = gate.run('s4', undefined, 10_000, c.fn, 'ip-2');
    a.rec.resolve('a');
    await expect(pa).resolves.toBe('a');
    const pd = gate.run('s3', undefined, 10_000, d.fn, 'ip-1');
    for (const [j, v] of [[b, 'b'], [c, 'c'], [d, 'd']] as const) j.rec.resolve(v);
    await expect(Promise.all([pb, pc, pd])).resolves.toEqual(['b', 'c', 'd']);
  });

  it('drops a queued job whose request closes (499 CLOSED) or whose time runs out (503 TIMEOUT): never started, its place freed', async () => {
    const gate = createWorkGate({ concurrency: 1, queue: 4, perOwner: 1 });
    const a = job();
    const pa = gate.run('o1', undefined, 10_000, a.fn);
    const closed = new AbortController();
    const [b, c, again, d] = [job(), job(), job(), job()];
    const pb = gate.run('o2', closed.signal, 10_000, b.fn);
    const pc = gate.run('o3', undefined, 20, c.fn);
    expect(gate.queued).toBe(2);
    closed.abort();
    await expectHttp(pb, 499, 'CLOSED');
    await expectHttp(pc, 503, 'TIMEOUT');
    expect(gate.queued).toBe(0);
    a.rec.resolve('A');
    await pa;
    await flush();
    expect([b.rec.started, c.rec.started, gate.running]).toEqual([false, false, 0]);
    const pAgain = gate.run('o2', undefined, 10_000, again.fn);
    again.rec.resolve('again');
    await expect(pAgain).resolves.toBe('again');
    // A request already closed is 499 at once.
    await expectHttp(gate.run('o4', closed.signal, 10_000, d.fn), 499, 'CLOSED');
    expect([d.rec.started, gate.running]).toEqual([false, 0]);
  });

  it('aborts a running job\'s signal when its time runs out (503 TIMEOUT whatever it threw; the next starts) or its request closes', async () => {
    const gate = createWorkGate({ concurrency: 1, queue: 1 });
    const a = job(new Error('the engine stopped'));
    const pa = gate.run('o1', undefined, 20, a.fn);
    const closed = new AbortController();
    const b = job(new Error('closed'));
    const pb = settled(gate.run('o2', closed.signal, 10_000, b.fn));
    await expectHttp(pa, 503, 'TIMEOUT');
    expect([a.rec.signal!.aborted, a.rec.signal!.reason]).toEqual([true, expect.objectContaining({ status: 503, code: 'TIMEOUT' })]);
    expect([b.rec.started, b.rec.signal!.aborted]).toEqual([true, false]);
    closed.abort();
    expect([b.rec.signal!.aborted, (await pb).error, gate.running]).toEqual([true, new Error('closed'), 0]);
  });

  it('frees the place of a job that throws before it returns a promise, running or queued, and starts the next', async () => {
    const gate = createWorkGate({ concurrency: 1, queue: 2 });
    await expect(gate.run('o0', undefined, 10_000, sync)).rejects.toThrow('sync');
    const [a, c] = [job(), job()];
    const pa = gate.run('o1', undefined, 10_000, a.fn);
    expect([gate.running, a.rec.started]).toEqual([1, true]);
    const pb = settled(gate.run('o2', undefined, 10_000, sync));
    const pc = gate.run('o3', undefined, 10_000, c.fn);
    a.rec.resolve('A');
    await expect(pa).resolves.toBe('A');
    expect([(await pb).error, c.rec.started]).toEqual([new Error('sync'), true]);
    c.rec.resolve('C');
    await expect(pc).resolves.toBe('C');
    expect(gate.running).toBe(0);
  });
});
