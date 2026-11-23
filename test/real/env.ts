// Paths for the real-data checks (`npm run test:real`), which read the player's ROM and save and the official docs. Each
// can be overridden by the environment variable of the same name. The docs and PKCalc caches are refreshed once per run
// by globalSetup.ts (and by `npm run record:diffs`); the test files only read them.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadPkcalc } from '../../src/check/pkcalc.js';
import { downloadDocs } from '../../src/docs/fetchDocs.js';

// The ROMs are read from Linux-side copies (git-ignored): reading the 128 MB files over /mnt/c from several test
// workers and sessions at once failed with ENOMEM. Copy them in with `mkdir -p data/roms` and cp, or set the variables.
export const PK_ROM = process.env.PK_ROM || 'data/roms/plat-kaizo-nightmare-update-final.nds';
/** Vanilla Platinum (US, CPUE), for the AI-script and move-data diffs. */
export const PK_VANILLA_ROM = process.env.PK_VANILLA_ROM || 'data/roms/platinum-us.nds';
/** A frozen copy of the player's 12 June 2026 run (git-ignored), not his live save, which changes and is wiped on a reset. */
export const PK_SAVE = process.env.PK_SAVE || 'data/saves/pk-run-2026-06-12.dsv';
/** Where `npm run extract` keeps its data. The docs tabs live in `<DATA_DIR>/docs`, PKCalc's files in `<DATA_DIR>/pkcalc`. */
export const DATA_DIR = process.env.DATA_DIR || 'data';

/** A cache the real tests read: its directory, and why the suites that read it are skipped, or null. */
export interface CacheStatus { name: string; dir: string; skip: string | null }

declare module 'vitest' {
  /** What globalSetup.ts hands the real test files. */
  export interface ProvidedContext { realCaches: { docs: CacheStatus; pkcalc: CacheStatus } }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether to skip a suite that reads `files` (each named by its environment variable) and `caches`, and the suite's
 * title, which says why when it is skipped. A skip is also printed as a warning, so it shows in the default reporter.
 */
export function needFiles(title: string, files: Record<string, string>, caches: CacheStatus[] = []): { title: string; skip: boolean } {
  const reasons = [
    ...Object.entries(files).filter(([, path]) => !existsSync(path)).map(([name, path]) => `${name} file not found: ${path} (set ${name} to its path)`),
    ...caches.flatMap((cache) => (cache.skip === null ? [] : [cache.skip])),
  ];
  if (reasons.length === 0) return { title, skip: false };
  const reason = reasons.join('; ');
  console.warn(`Skipping "${title}": ${reason}`);
  return { title: `${title} (skipped: ${reason})`, skip: true };
}

/** Whether the files in `dir` were fetched under a day ago, by the `fetchedAt` in their `meta.json`. */
function fetchedToday(dir: string): boolean {
  const meta = join(dir, 'meta.json');
  if (!existsSync(meta)) return false;
  const { fetchedAt } = JSON.parse(readFileSync(meta, 'utf8')) as { fetchedAt?: string };
  const age = Date.now() - Date.parse(fetchedAt ?? '');
  return age >= 0 && age < DAY_MS;
}

/** Whether `error`, or an error it was caused by, is Node's fetch failing to reach the server ("fetch failed"). */
function isNetworkFailure(error: unknown): boolean {
  for (let cause = error, depth = 0; cause instanceof Error && depth < 10; cause = cause.cause, depth++) {
    if (cause instanceof TypeError && cause.message === 'fetch failed') return true;
  }
  return false;
}

/**
 * Brings the cache called `name` in `dir` up to date with `download`, unless it was fetched under a day ago. When the
 * download cannot reach the network, the suites that read the cache are to be skipped, and `skip` says why; any other
 * failure throws, so a docs or PKCalc change that breaks a check fails the run.
 */
export async function refreshCache(name: string, dir: string, download: (dir: string) => Promise<void>): Promise<CacheStatus> {
  if (fetchedToday(dir)) return { name, dir, skip: null };
  try {
    await download(dir);
    return { name, dir, skip: null };
  } catch (error) {
    if (!isNetworkFailure(error)) throw error;
    const age = existsSync(join(dir, 'meta.json')) ? 'over a day old' : 'missing';
    // PKCalc's download lets fetch's own error through, whose cause says what failed ("getaddrinfo ENOTFOUND …").
    const plain = error instanceof TypeError && error.cause instanceof Error;
    const detail = plain ? `${error.message} (${(error.cause as Error).message})` : (error as Error).message;
    const skip = `the ${name} cache in ${dir} is ${age} and the network is unavailable (${detail})`;
    console.warn(`Skipping the suites that read the ${name} cache: ${skip}`);
    return { name, dir, skip };
  }
}

/** `<DATA_DIR>/docs`, downloaded first unless the docs there were fetched under a day ago. */
export const refreshDocs = () => refreshCache('docs', join(DATA_DIR, 'docs'), downloadDocs);

/** `<DATA_DIR>/pkcalc`, downloaded first unless PKCalc's files there were fetched under a day ago. */
export const refreshPkcalc = () => refreshCache('PKCalc', join(DATA_DIR, 'pkcalc'), downloadPkcalc);
