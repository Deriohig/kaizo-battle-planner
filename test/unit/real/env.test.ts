import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsError } from '../../../src/docs/fetchDocs.js';
import { refreshCache } from '../../real/env.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** What Node's fetch throws when it cannot reach the server. */
const offline = () => new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND docs.google.com') });

describe('refreshCache', () => {
  let dir: string;
  const fetchedAgo = (ms: number) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ fetchedAt: new Date(Date.now() - ms).toISOString() }));
  };
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'pk-cache-')), 'docs');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(join(dir, '..'), { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each<[string, number, boolean]>([['leaves a cache fetched under a day ago alone', -60_000, false], ['downloads a cache over a day old', 60_000, true]])('%s', async (_, past, downloads) => {
    fetchedAgo(DAY_MS + past);
    const download = vi.fn(async () => {});
    expect(await refreshCache('docs', dir, download)).toEqual({ name: 'docs', dir, skip: null });
    expect(download.mock.calls).toEqual(downloads ? [[dir]] : []);
  });

  it('skips the suites, saying why, when a stale or missing cache cannot be downloaded for want of a network', async () => {
    fetchedAgo(2 * DAY_MS);
    const stale = await refreshCache('docs', dir, async () => {
      throw new DocsError('HTTP', 'Personal', '"Personal" tab could not be fetched', { cause: offline() });
    });
    expect(stale).toEqual({ name: 'docs', dir, skip: `the docs cache in ${dir} is over a day old and the network is unavailable ("Personal" tab could not be fetched)` });
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))).toHaveProperty('fetchedAt');
    rmSync(dir, { recursive: true });
    expect(await refreshCache('PKCalc', dir, async () => {
      throw offline();
    })).toMatchObject({ skip: `the PKCalc cache in ${dir} is missing and the network is unavailable (fetch failed (getaddrinfo ENOTFOUND docs.google.com))` });
  });

  it('fails on any other download error, such as a docs tab its parser cannot read', async () => {
    fetchedAgo(2 * DAY_MS);
    await expect(refreshCache('docs', dir, async () => {
      throw new DocsError('BAD_FORMAT', 'Personal', '"Personal" tab cannot be parsed: no "Attack" column');
    })).rejects.toThrow('"Personal" tab cannot be parsed');
  });
});
