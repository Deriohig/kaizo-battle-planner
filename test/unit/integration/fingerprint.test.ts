import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PKCALC_FILES, type PkcalcGlobal, pkcalcFile } from '../../../src/check/pkcalc.js';
import { DOC_TABS } from '../../../src/docs/fetchDocs.js';
import { DATA_CHANGED, DATA_CHANGED_MESSAGE, DataChangedError, dataFiles, fingerprintData, readStable, stampData } from '../../../src/integration/fingerprint.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fingerprint-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

let folders = 0;
const newPath = (kind: string) => path.join(scratch, `${kind}-${folders++}`);
/** A new folder with a few bytes, its own path's, at every `dataFiles()` path. */
function fullFolder(): string {
  const dir = newPath('data');
  for (const { file } of dataFiles()) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), `bytes of ${file}\n`);
  }
  return dir;
}
const emptyFolder = () => {
  const dir = newPath('empty');
  fs.mkdirSync(dir);
  return dir;
};
/** Writes a copy of `file` with the same bytes beside it and renames it into place, as `writeWhole` does. */
function renameSameBytesIntoPlace(file: string): void {
  fs.writeFileSync(`${file}.tmp`, fs.readFileSync(file));
  fs.renameSync(`${file}.tmp`, file);
}
const personal = (dir: string) => path.join(dir, 'docs', 'Personal.csv');

describe('the data fingerprint', () => {
  it('is a sha-256 that is the same for the same bytes, and changes when any one file changes (meta.json by presence only)', () => {
    const dir = fullFolder();
    const base = fingerprintData(dir);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    const copy = newPath('copy');
    fs.cpSync(dir, copy, { recursive: true });
    expect([fingerprintData(dir), fingerprintData(copy)]).toEqual([base, base]);

    const changed = dataFiles().filter((entry) => !entry.presenceOnly).map(({ file }) => {
      const other = fullFolder();
      fs.appendFileSync(path.join(other, file), 'x');
      return fingerprintData(other);
    });
    expect(changed).not.toContain(base);
    expect(new Set(changed).size).toBe(changed.length);
    const withoutMeta = fullFolder();
    fs.rmSync(path.join(withoutMeta, 'pkcalc', 'meta.json'));
    expect(fingerprintData(withoutMeta)).not.toBe(base);
    const otherMeta = fullFolder();
    fs.writeFileSync(path.join(otherMeta, 'pkcalc', 'meta.json'), '{ "fetchedAt": "another day, other bytes" }\n');
    expect(fingerprintData(otherMeta)).toBe(base);
  });

  it('hashes missing files instead of throwing: an empty folder, no folder and a file in its place agree', () => {
    const empty = fingerprintData(emptyFolder());
    const notAFolder = newPath('file');
    fs.writeFileSync(notAFolder, 'not a folder\n');   // every file below it is missing (ENOTDIR)
    expect(empty).toMatch(/^[0-9a-f]{64}$/);
    expect(empty).not.toBe(fingerprintData(fullFolder()));
    expect([fingerprintData(path.join(scratch, 'no-such-folder')), fingerprintData(notAFolder)]).toEqual([empty, empty]);
  });

  it('keeps the content and changes the identity on a rewrite with the same bytes', () => {
    const dir = fullFolder();
    const before = stampData(dir);
    renameSameBytesIntoPlace(personal(dir));
    const after = stampData(dir);
    expect([after.content === before.content, after.identity === before.identity]).toEqual([true, false]);
  });

  it("dataFiles is the loaders' files, relative and with forward slashes", () => {
    const tabs = ['Personal', 'Moves', 'Level-Up Learnsets', 'AI Changes', ...DOC_TABS.filter((tab) => tab.endsWith(' Split'))];
    const pkcalc = (Object.keys(PKCALC_FILES) as PkcalcGlobal[]).map((name) => pkcalcFile('pkcalc', name));
    const expected = ['rom/romdata.json', 'rom/trainer-ai.json', ...tabs.map((tab) => `docs/${tab}.csv`), ...pkcalc, 'pkcalc/meta.json'];
    const files = dataFiles().map((entry) => entry.file);
    expect([...files].sort()).toEqual([...expected].sort());
    expect(dataFiles().filter((entry) => entry.presenceOnly).map((entry) => entry.file)).toEqual(['pkcalc/meta.json']);
    expect(files.filter((file) => file.includes('\\') || path.isAbsolute(file))).toEqual([]);
  });
});

describe('readStable', () => {
  const thrownBy = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  };
  /** What `run` threw, which must be the data-changed error. */
  function dataChanged(run: () => unknown): DataChangedError {
    const thrown = thrownBy(run);
    expect(thrown).toBeInstanceOf(DataChangedError);
    expect(thrown).toMatchObject({ code: 'DATA_CHANGED', name: 'DataChangedError', message: DATA_CHANGED_MESSAGE });
    return thrown as DataChangedError;
  }
  const failure = new Error('the loader failed');
  const fail = () => {
    throw failure;
  };

  it('passes a matching fingerprint (or none) with the value, and passes on a loader failure as it is', () => {
    const dir = fullFolder();
    const fingerprint = fingerprintData(dir);
    expect(DATA_CHANGED).toBe('DATA_CHANGED');
    expect(readStable(dir, fingerprint, () => 'loaded')).toEqual({ value: 'loaded', fingerprint });
    expect(readStable(dir, null, () => 42)).toEqual({ value: 42, fingerprint });
    for (const expected of [fingerprint, null]) expect(thrownBy(() => readStable(dir, expected, fail))).toBe(failure);
  });

  it('refuses an unexpected fingerprint before the load', () => {
    let ran = false;
    dataChanged(() => readStable(fullFolder(), fingerprintData(emptyFolder()), () => {
      ran = true;
    }));
    expect(ran).toBe(false);
  });

  it.each<[string, (file: string) => void]>([
    ['other bytes', (file) => fs.writeFileSync(file, 'other bytes\n')],
    ['the same bytes renamed into place (the loader may have read a file in between)', renameSameBytesIntoPlace],
  ])('refuses a folder rewritten with %s during the read, a loader failure meanwhile its cause', (_, rewrite) => {
    const dir = fullFolder();
    expect(dataChanged(() => readStable(dir, null, () => rewrite(personal(dir)))).cause).toBeUndefined();
    const next = fullFolder();
    const failed = dataChanged(() => readStable(next, fingerprintData(next), () => {
      rewrite(personal(next));
      fail();
    }));
    expect(failed.cause).toBe(failure);
  });
});
