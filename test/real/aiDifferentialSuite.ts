// The trainer AI's differential test: every record of the corpus (aiCorpus.ts) run on
// the code as it is now must equal the golden file's, which aiDifferentialGolden.ts wrote on the code before the AI's
// speed work. Records are digests of every support (actions and exact probabilities, in order), every memory key, every
// replacement support and every refusal (code and message). On a difference it lists the first 20 differing records,
// action by action.
//
// The corpus is split by the sweep's player lead into three test files (aiDifferential.p<n>.test.ts), which vitest runs
// in parallel; each compares the golden records of its own cases. A fourth, aiDifferential.fixtures.test.ts, compares the
// `f/` records of the hand-made battles (aiFixtures.ts). Together they compare every record
// (aiDifferentialShards.test.ts checks that).
//
// The golden file is regenerated only on purpose: `npx tsx test/real/aiDifferentialGolden.ts` rewrites it, and
// `--add` keeps every existing record and adds only the keys it lacks (a new kind of record, generated on code whose
// behaviour is the golden's).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Corpus, diffRecords, FIELD_STRIDE, GOLDEN_FORMAT, GOLDEN_PATH, type Golden, loadCorpus, playerOf, runCorpus } from './aiCorpus.js';
import { runFixtures } from './aiFixtures.js';
import { DATA_DIR, needFiles, PK_ROM } from './env.js';

const ROM_DIR = join(DATA_DIR, 'rom');

/** The shards, by the sweep's player lead: one test file each (aiDifferential.p<n>.test.ts). */
export const DIFFERENTIAL_SHARDS: readonly number[] = [0, 1, 2];

/** The prefix of the fixtures' record keys: the kind `f` (aiFixtures.ts). */
export const FIXTURES_KEY_PREFIX = 'f/';

/** The first 20 differing records of `diffs`, each with its lines. */
function shown(diffs: ReturnType<typeof diffRecords>): string {
  return diffs.slice(0, 20).map((diff) => `${diff.key}\n${diff.lines.map((line) => `    ${line}`).join('\n')}`).join('\n');
}

/** The differential test of the corpus's cases against player lead `player` (0 Garchomp, 1 Gengar, 2 Forretress). */
export function differentialSuite(player: number): void {
  const suite = needFiles(`the trainer AI's decisions against the golden file, player lead ${player}`, { PK_ROM, GOLDEN: GOLDEN_PATH }, [{
    name: 'ROM extract', dir: ROM_DIR,
    skip: ['romdata.json', 'trainer-ai.json'].every((file) => existsSync(join(ROM_DIR, file)))
      ? null : `${ROM_DIR} lacks romdata.json or trainer-ai.json; run npm run extract -- --rom <path>`,
  }]);

  describe.skipIf(suite.skip)(suite.title, () => {
    it('reproduces every golden record of its cases', () => {
      const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
      expect(golden.format).toBe(GOLDEN_FORMAT);
      const start = performance.now();
      const corpus: Corpus = loadCorpus(DATA_DIR, golden.k);
      const cases = corpus.cases.filter((c) => playerOf(c.id) === player);
      const actual = runCorpus(corpus, cases);
      const seconds = (performance.now() - start) / 1000;
      const kinds = new Map<string, number>();
      for (const key of actual.keys()) kinds.set(key[0]!, (kinds.get(key[0]!) ?? 0) + 1);
      console.log(`AI differential, player lead ${player}: ${cases.length} cases (deep: every ${golden.k}th, those with a bag item, every ${FIELD_STRIDE}th of each field note); `
        + `${actual.size} records (${[...kinds].map(([kind, n]) => `${kind} ${n}`).join(', ')}) in ${seconds.toFixed(1)} s`);
      const want = Object.fromEntries(Object.entries(golden.records).filter(([key]) => playerOf(key) === player));
      const diffs = diffRecords(want, actual);
      expect(diffs.length, `${diffs.length} records differ from the golden file; the first 20:\n${shown(diffs)}`).toBe(0);
      expect(actual.size).toBeGreaterThan(cases.length - 1);
    });
  });
}

/** The differential test of the fixtures (aiFixtures.ts FIXTURES) against the golden file's `f/` records. */
export function fixturesSuite(): void {
  const suite = needFiles("the trainer AI's decisions against the golden file, the fixtures", { PK_ROM, GOLDEN: GOLDEN_PATH }, [{
    name: 'ROM extract', dir: ROM_DIR,
    skip: ['romdata.json', 'trainer-ai.json'].every((file) => existsSync(join(ROM_DIR, file)))
      ? null : `${ROM_DIR} lacks romdata.json or trainer-ai.json; run npm run extract -- --rom <path>`,
  }]);

  describe.skipIf(suite.skip)(suite.title, () => {
    it('reproduces every golden record of the fixtures', () => {
      const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
      expect(golden.format).toBe(GOLDEN_FORMAT);
      const start = performance.now();
      const corpus: Corpus = loadCorpus(DATA_DIR, golden.k);
      const actual = runFixtures(corpus);
      const seconds = (performance.now() - start) / 1000;
      console.log(`AI differential, fixtures: ${actual.size} records in ${seconds.toFixed(1)} s`);
      const want = Object.fromEntries(Object.entries(golden.records).filter(([key]) => key.startsWith(FIXTURES_KEY_PREFIX)));
      const diffs = diffRecords(want, actual);
      expect(diffs.length, `${diffs.length} records differ from the golden file; the first 20:\n${shown(diffs)}`).toBe(0);
      expect(actual.size).toBeGreaterThan(0);
    });
  });
}
