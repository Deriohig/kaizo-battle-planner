// The data fingerprint's file list against the files the loaders really read. Every path given
// to `readFileSync` or `existsSync` is recorded while `loadLocalData` and `loadAiData` load the real data folder, and
// each one in that folder must be in `dataFiles()`, so a file the loaders start reading cannot change the data
// unnoticed. It lives in the real tier because no unit fixture writes a loadable data folder. Needs the extracted data
// in DATA_DIR (`npm run extract`). The recorder sees `readFileSync` and `existsSync` only: a loader that starts reading
// through another call (`fs/promises`, `readdirSync`, `statSync`, ...) is not caught here.

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadAiData } from '../../src/ai/rom/aiData.js';
import { loadLocalData } from '../../src/data/load.js';
import { dataFiles } from '../../src/integration/fingerprint.js';
import { DATA_DIR, needFiles } from './env.js';

/** Every string path given to `readFileSync` or `existsSync` in this file's module graph, as given. */
const recorded = vi.hoisted(() => new Set<string>());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const record = (file: unknown) => {
    if (typeof file === 'string') recorded.add(file);
  };
  const readFileSync = ((file: unknown, ...rest: unknown[]) => {
    record(file);
    return (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.readFileSync;
  const existsSync = ((file: unknown) => {
    record(file);
    return actual.existsSync(file as string);
  }) as typeof actual.existsSync;
  return { ...actual, readFileSync, existsSync, default: { ...actual, readFileSync, existsSync } };
});

const DATA = path.resolve(DATA_DIR);
const suite = needFiles('the data fingerprint on the real data folder', {
  ROMDATA: path.join(DATA, 'rom', 'romdata.json'), TRAINER_AI: path.join(DATA, 'rom', 'trainer-ai.json'),
});

describe.skipIf(suite.skip)(suite.title, () => {
  it('the file list covers what the loaders read', () => {
    recorded.clear();
    const local = loadLocalData(DATA);
    loadAiData(path.join(DATA, 'rom'));
    const read = [...recorded].map((file) => path.resolve(file)).filter((file) => file.startsWith(`${DATA}${path.sep}`));
    // The recording sees the loaders' own reads, PKCalc's too where its data was saved.
    expect(read).toContain(path.join(DATA, 'rom', 'romdata.json'));
    expect(read).toContain(path.join(DATA, 'rom', 'trainer-ai.json'));
    expect(read).toContain(path.join(DATA, 'docs', 'Personal.csv'));
    expect(read).toContain(path.join(DATA, 'pkcalc', 'meta.json'));
    if (local.pkcalc !== undefined) expect(read).toContain(path.join(DATA, 'pkcalc', 'sets.js'));
    const listed = new Set(dataFiles().map(({ file }) => path.join(DATA, file)));
    expect(read.filter((file) => !listed.has(file))).toEqual([]);
  });
});
