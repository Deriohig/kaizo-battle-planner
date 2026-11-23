// Vitest global setup for the real project: refreshes the docs and PKCalc caches once, before any test file runs, so
// that parallel test files never download (and write) the same files at once. The test files read the result with
// `inject('realCaches')`. Only the suites that read PK_ROM read the caches, so without it nothing is downloaded.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { type CacheStatus, DATA_DIR, PK_ROM, refreshDocs, refreshPkcalc } from './env.js';

export default async function setup(project: TestProject): Promise<void> {
  const notRefreshed = (name: string, dir: string): CacheStatus => ({ name, dir, skip: `the ${name} cache was not refreshed, as PK_ROM is missing` });
  const haveRom = existsSync(PK_ROM);
  project.provide('realCaches', {
    docs: haveRom ? await refreshDocs() : notRefreshed('docs', join(DATA_DIR, 'docs')),
    pkcalc: haveRom ? await refreshPkcalc() : notRefreshed('PKCalc', join(DATA_DIR, 'pkcalc')),
  });
}
