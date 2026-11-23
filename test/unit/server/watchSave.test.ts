import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchSave } from '../../../src/server/watchSave.js';

type Stamp = { mtimeMs: number; size: number } | null;

const SAVE = '/mnt/c/Battery/kaizo.dsv';
const STAMP = { mtimeMs: 1_000, size: 524_416 };
let watcher: { close(): void } | undefined;

afterEach(() => {
  watcher?.close();
  watcher = undefined;
});

describe('watchSave (fake timers)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  /** A watcher over a stat that answers whatever the test last `set`; `fail` makes it reject until the next `set`. */
  function watch(initial: Stamp = STAMP, opts: Parameters<typeof watchSave>[2] = {}, onChange: () => unknown = () => undefined) {
    let current = initial;
    let failing = false;
    const stat = vi.fn(async (_path: string): Promise<Stamp> => {
      if (failing) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return current;
    });
    const changed = vi.fn(onChange);
    const w = watchSave(SAVE, changed as () => void, { stat, ...opts });
    watcher = w;
    return { stat, changed, w, set(next: Stamp) { current = next; failing = false; }, fail() { failing = true; } };
  }

  /** A stat that gives `answers` in turn (a function answer may hang), then the last one for good. */
  function sequence(answers: (Stamp | (() => Promise<Stamp>))[]) {
    let calls = 0;
    return vi.fn((_path: string): Promise<Stamp> => {
      const answer = answers[Math.min(calls++, answers.length - 1)]!;
      return typeof answer === 'function' ? answer() : Promise.resolve(answer);
    });
  }

  it.each<[string, Stamp, (w: ReturnType<typeof watch>) => void]>([
    ['an mtime change', STAMP, (w) => w.set({ mtimeMs: 2_000, size: 524_416 })],
    ['a size change with the same mtime', STAMP, (w) => w.set({ mtimeMs: 1_000, size: 262_144 })],
    ['a deleted file', STAMP, (w) => w.set(null)],
    ['a file appearing after a missing baseline', null, (w) => w.set({ mtimeMs: 9_000, size: 524_416 })],
    ['a stat error (read as a missing file)', STAMP, (w) => w.fail()],
  ])('%s fires once, 750 ms after the poll that sees it', async (_name, initial, change) => {
    const w = watch(initial);
    await tick(5_000);
    expect([w.changed.mock.calls.length, w.stat.mock.calls.length >= 5]).toEqual([0, true]);
    expect(w.stat).toHaveBeenCalledWith(SAVE);
    change(w);
    await tick(1_000 + 749);
    expect(w.changed).not.toHaveBeenCalled();
    await tick(1);
    expect(w.changed).toHaveBeenCalledTimes(1);
    await tick(10_000);
    expect(w.changed).toHaveBeenCalledTimes(1);
  });

  it('a stat error and a missing file are the same stamp; a file that comes back fires again', async () => {
    const w = watch();
    await tick(0);
    w.fail();
    await tick(1_750);
    w.set(null);
    await tick(5_000);
    expect(w.changed).toHaveBeenCalledTimes(1);
    w.set({ mtimeMs: 2_000, size: 524_416 });
    await tick(1_750);
    expect(w.changed).toHaveBeenCalledTimes(2);
  });

  it('a burst of changes fires once, a debounce after the last', async () => {
    const w = watch(STAMP, { intervalMs: 1_000, debounceMs: 1_500 });
    await tick(0);
    for (const n of [1, 2, 3]) {
      w.set({ mtimeMs: 1_000 + n, size: 524_416 + n });
      await tick(1_000);                                // t = n s: the poll sees change n
    }
    await tick(1_499);
    expect(w.changed).not.toHaveBeenCalled();
    await tick(1);                                      // t = 4.5 s: 1500 ms after the last change
    expect(w.changed).toHaveBeenCalledTimes(1);
    await tick(10_000);
    expect(w.changed).toHaveBeenCalledTimes(1);
  });

  it('with the default timings, a write seen by two polls fires once, after the stamp settles', async () => {
    const w = watch();
    await tick(0);
    w.set({ mtimeMs: 2_000, size: 262_144 });           // DeSmuME starts writing; poll 1 at 1 s sees it
    await tick(1_500);
    w.set({ mtimeMs: 2_500, size: 524_416 });           // t = 1.5 s: the write finishes; poll 2 at 2 s sees it
    await tick(999);                                    // the 1.75 s settle check saw the stamp move
    expect(w.changed).not.toHaveBeenCalled();
    await tick(1);                                      // t = 2.5 s: the stamp has held for 750 ms
    expect(w.changed).toHaveBeenCalledTimes(1);
    await tick(10_000);
    expect(w.changed).toHaveBeenCalledTimes(1);
  });

  it('a stamp that moves between the debounce and its re-stat delays the call, which still comes once', async () => {
    const stat = sequence([STAMP, { mtimeMs: 2_000, size: 262_144 }, { mtimeMs: 2_100, size: 524_416 }]);
    const onChange = vi.fn();
    watcher = watchSave(SAVE, onChange, { intervalMs: 5_000, debounceMs: 500, stat });
    await tick(5_500);                                  // the poll at 5 s sees a change; the re-stat at 5.5 s sees it move again
    expect([stat.mock.calls.length, onChange.mock.calls.length]).toEqual([3, 0]);
    await tick(499);
    expect(onChange).not.toHaveBeenCalled();
    await tick(1);                                      // t = 6 s: the re-stat matches
    expect(onChange).toHaveBeenCalledTimes(1);
    await tick(20_000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('a poll that sees a change while the settle re-stat hangs leaves the call to the newer debounce', async () => {
    const half = { mtimeMs: 2_000, size: 262_144 };
    const done = { mtimeMs: 2_500, size: 524_416 };
    let answerSettle: (stamp: Stamp) => void = () => {};
    const stat = sequence([STAMP, half, () => new Promise<Stamp>((resolve) => { answerSettle = resolve; }), done]);
    const onChange = vi.fn();
    watcher = watchSave(SAVE, onChange, { stat });
    await tick(2_000);                                  // poll 2 records the finished file while the settle stat hangs
    expect(stat).toHaveBeenCalledTimes(4);
    answerSettle(done);
    await tick(0);
    expect(onChange).not.toHaveBeenCalled();
    await tick(750);                                    // t = 2.75 s: poll 2's debounce and its settle check
    await tick(10_000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['throws', () => { throw new Error('cannot read the box'); }, true],
    ['rejects', async () => { throw new Error('cannot read the box'); }, true],
    ['throws, with onError left to its default console.error,', () => { throw new Error('cannot read the box'); }, false],
  ])('an onChange that %s is reported, and a later change fires again', async (_kind, failing, given) => {
    const onError = given ? vi.fn() : vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const w = watch(STAMP, given ? { onError: onError as never } : {}, failing);
      await tick(0);
      for (const n of [1, 2]) {
        w.set({ mtimeMs: 1_000 + n * 1_000, size: 524_416 });
        await tick(1_750);
        expect([w.changed.mock.calls.length, onError.mock.calls.length]).toEqual([n, n]);
      }
      expect(onError.mock.calls.flat()).toContainEqual(expect.objectContaining({ message: 'cannot read the box' }));
    } finally {
      onError.mockRestore();
    }
  });

  it('after close nothing fires and polling stops, even with the debounce pending', async () => {
    const w = watch();
    await tick(0);
    w.set({ mtimeMs: 2_000, size: 524_416 });
    await tick(1_000);                                  // the debounce timer is pending
    w.w.close();
    const calls = w.stat.mock.calls.length;
    await tick(10_000);
    expect([w.changed.mock.calls.length, w.stat.mock.calls.length, vi.getTimerCount()]).toEqual([0, calls, 0]);
  });

  it('a stat still running at close does not start a timer when it answers', async () => {
    let answer: (stamp: Stamp) => void = () => {};
    const stat = sequence([STAMP, () => new Promise<Stamp>((resolve) => { answer = resolve; })]);
    const onChange = vi.fn();
    const w = watchSave(SAVE, onChange, { stat });
    watcher = w;
    await tick(1_000);                                  // the second stat is in flight
    w.close();
    answer({ mtimeMs: 2_000, size: 524_416 });
    await tick(10_000);
    expect([onChange.mock.calls.length, stat.mock.calls.length, vi.getTimerCount()]).toEqual([0, 2, 0]);
  });
});

it('watchSave with the default stat fires when the file on disk is rewritten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-t5-'));
  try {
    const file = path.join(dir, 'kaizo.dsv');
    fs.writeFileSync(file, 'first');
    const fired = new Promise<void>((resolve) => { watcher = watchSave(file, resolve, { intervalMs: 20, debounceMs: 30 }); });
    await new Promise((resolve) => setTimeout(resolve, 60));   // past the baseline stat
    fs.writeFileSync(file, 'second, and longer');
    await expect(Promise.race([fired.then(() => 'fired'), new Promise((resolve) => setTimeout(() => resolve('timed out'), 2_000))])).resolves.toBe('fired');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
