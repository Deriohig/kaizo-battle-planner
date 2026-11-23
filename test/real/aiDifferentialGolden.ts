// Writes the trainer AI's differential golden file (test/real/golden/aiDifferential.json) from the code as it is now:
// `npx tsx test/real/aiDifferentialGolden.ts` rewrites every record; `--add` keeps the existing records and adds only
// the keys the file lacks (the corpus's records, then the fixtures'). Run it only on code whose decisions are the reference (see aiDifferentialSuite.ts).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CORPUS_K, GOLDEN_FORMAT, GOLDEN_PATH, type Golden, goldenText, loadCorpus, runCorpus } from './aiCorpus.js';
import { runFixtures } from './aiFixtures.js';
import { DATA_DIR } from './env.js';

const add = process.argv.includes('--add');
const before: Golden | null = existsSync(GOLDEN_PATH) ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden : null;
if (add && before === null) throw new Error(`--add needs an existing ${GOLDEN_PATH}`);
const k = add ? before!.k : CORPUS_K;
const start = performance.now();
const corpus = loadCorpus(DATA_DIR, k);
// `--fixtures` (with `--add`) skips the sweep's cases, which the file already holds: only the fixtures' keys it lacks are run and added.
const fixturesOnly = add && process.argv.includes('--fixtures');
const actual = fixturesOnly ? new Map(Object.entries(before!.records)) : runCorpus(corpus);
for (const [key, value] of runFixtures(corpus)) actual.set(key, value); // the hand-made battles' `f/` records (aiFixtures.ts)
const records: Record<string, string> = {};
let added = 0;
for (const [key, value] of actual) {
  const kept = add ? before!.records[key] : undefined;
  if (kept === undefined) added += 1;
  records[key] = kept ?? value;
}
if (add) {
  for (const [key, value] of Object.entries(before!.records)) if (!(key in records)) records[key] = value;
}
mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
const text = goldenText({ format: GOLDEN_FORMAT, k, records });
writeFileSync(GOLDEN_PATH, text);
console.log(`${GOLDEN_PATH}: ${Object.keys(records).length} records (${added} ${add ? 'added' : 'written'}), `
  + `${corpus.cases.length} cases, k ${k}, ${(text.length / 1024).toFixed(0)} KiB, ${((performance.now() - start) / 1000).toFixed(1)} s`);
