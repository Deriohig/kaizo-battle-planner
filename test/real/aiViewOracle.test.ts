// The trainer AI's view against the adapter as it was before it was split up (aiLegacyAdapter.ts), over every record of the differential corpus (aiCorpus.ts, the golden file's k) and of
// its hand-made battles (aiFixtures.ts FIXTURES). At each state the corpus reaches, with the memory the solver's
// calls reach it with, the view composed from the Showdown source's read (viewFromRead(showdownAiSource.read(state),
// …), which viewFromState is) must be the one-pass build's, field for field and in key order (so `unknown` as an ordered
// array), or both must throw the same error (its class, code and message). And the turn fact `remember` stores for a
// turn-choice state (model.ts withTurnFact: fightKind of the view is 'menu', else 'forced', or 'unknown' on an AiError)
// must be the same both ways. Each state is also viewed with its case's root memory, through the same caches, so no
// memory's fields stay in another's view. Every golden record of the cases walked is reached but those whose state or
// memory the corpus never had (a refusal at the battle start, a step the engine refused, a `remember` that threw), and
// nothing outside the golden file is.
//
// Two sizes. With AI_READ_FULL=1 (`npm run test:ai-read`): every case and every fixture, one walk of the
// whole corpus in one process, about 13 minutes at load 6 to 10, with its own timeout (split across files, each part would
// be another process holding a corpus walk's memory, about 1.2 GB, beside the differential's). Without it
// (`npm run test:real`): every fixture and every SAMPLE_STRIDE-th corpus case by case index, a fixed sample within the
// project's timeout. Every fix touching src/ai/read runs the full one first.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AiError } from '../../src/ai/errors.js';
import type { AiMemoryData } from '../../src/ai/memory.js';
import { fightKind } from '../../src/ai/model.js';
import { viewFromRead } from '../../src/ai/read/compose.js';
import { showdownAiSource } from '../../src/ai/read/showdown.js';
import { aiScriptOf } from '../../src/ai/rom/aiData.js';
import type { AiDeps, AiView } from '../../src/ai/view.js';
import type { EngineState } from '../../src/contracts/engine.js';
import { type Corpus, GOLDEN_PATH, type Golden, loadCorpus, runCase } from './aiCorpus.js';
import { FIXTURES, runFixture } from './aiFixtures.js';
import { viewFromState as legacyViewFromState } from './aiLegacyAdapter.js';
import { DATA_DIR, needFiles, PK_ROM } from './env.js';

const ROM_DIR = join(DATA_DIR, 'rom');
const suite = needFiles('the view composed from the read against the one-pass view', { PK_ROM, GOLDEN: GOLDEN_PATH }, [{
  name: 'ROM extract', dir: ROM_DIR,
  skip: ['romdata.json', 'trainer-ai.json'].every((file) => existsSync(join(ROM_DIR, file)))
    ? null : `${ROM_DIR} lacks romdata.json or trainer-ai.json; run npm run extract -- --rom <path>`,
}]);

/** The whole corpus (`npm run test:ai-read` sets it), else a sample. */
const FULL = process.env['AI_READ_FULL'] === '1';
/** Without AI_READ_FULL, the corpus cases walked: every SAMPLE_STRIDE-th by case index (and every fixture). */
const SAMPLE_STRIDE = 16;
/** The whole walk's timeout: an hour, for a loaded machine (the project's 10 minutes is for one shard's work). */
const WALK_TIMEOUT_MS = 60 * 60_000;
/** What the test walks, for its name. */
const WALKED = FULL
  ? 'every corpus case and every fixture (AI_READ_FULL=1)'
  : `every fixture and every ${SAMPLE_STRIDE}th corpus case by index (npm run test:ai-read walks them all)`;

/** The case id in a corpus record's key (`r/<case>`, `o/<case>/…`); null for a fixture's (`f/…`). */
function caseOf(key: string): string | null {
  return key.startsWith('f/') ? null : key.split('/')[1]!;
}

/** What `error` is: its class, its code (an AiError's or an engine error's), and its message. */
function errorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const kind = error instanceof Error ? error.constructor.name : typeof error;
  return `${kind}${typeof code === 'string' ? ` ${code}` : ''}: ${error instanceof Error ? error.message : String(error)}`;
}

/** A view as JSON in its own key order (callers may see the order), or the error its build threw. */
function built(build: () => AiView): string {
  try {
    return JSON.stringify(build());
  } catch (error) {
    return `throws ${errorText(error)}`;
  }
}

/** withTurnFact's classification of the view `build` gives (model.ts). */
function turnFact(build: () => AiView, deps: AiDeps): string {
  try {
    return fightKind(build(), deps) === 'menu' ? 'menu' : 'forced';
  } catch (error) {
    if (error instanceof AiError) return 'unknown';
    throw error;
  }
}

describe.skipIf(suite.skip)(suite.title, () => {
  it(`builds every record's view, and its turn fact, as the one-pass adapter did: ${WALKED}`, () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
    const start = performance.now();
    const corpus: Corpus = loadCorpus(DATA_DIR, golden.k);
    const deps: AiDeps = {
      script: aiScriptOf(corpus.ai), moves: corpus.data.rom.moves, species: corpus.data.rom.species, items: corpus.ai.items,
      typeChart: corpus.ai.typeChart, aiFlags: 0,
    };
    const mismatches: string[] = [];
    const facts = new Map<string, number>();
    const refusals = new Map<string, number>();
    const reached = new Set<string>();
    let views = 0;
    let root: AiMemoryData | null = null;
    const check = (key: string, state: EngineState, memory: AiMemoryData, which: string): void => {
      const legacy = () => legacyViewFromState(state, corpus.data, corpus.ai, memory);
      const composed = () => viewFromRead(showdownAiSource.read(state), state.phase.kind, corpus.data, corpus.ai, memory);
      const [want, got] = [built(legacy), built(composed)];
      views++;
      if (got.startsWith('throws ')) refusals.set(got, (refusals.get(got) ?? 0) + 1);
      if (got !== want) mismatches.push(`${key} with ${which}: ${got.slice(0, 200)} where the one-pass build gives ${want.slice(0, 200)}`);
      if (state.phase.kind !== 'turnChoice') return;
      const [a, b] = [turnFact(legacy, deps), turnFact(composed, deps)];
      facts.set(b, (facts.get(b) ?? 0) + 1);
      if (a !== b) mismatches.push(`${key} with ${which}: the turn fact is ${b}, the one-pass build's ${a}`);
    };
    const visit = (key: string, state: EngineState, md: AiMemoryData): void => {
      if (key.startsWith('r/') || /^f\/[^/]+\/0$/.test(key)) root = md;
      if (reached.has(key)) throw new Error(`the oracle reached ${key} twice`);
      reached.add(key);
      check(key, state, md, 'its memory');
      if (root !== null && root !== md) check(key, state, root, 'the root memory');
    };
    const cases = corpus.cases.filter((_, index) => FULL || index % SAMPLE_STRIDE === 0);
    for (const c of cases) {
      root = null;
      runCase(corpus, c, new Map(), (key, state, memory) => visit(key, state, memory.data as AiMemoryData));
    }
    for (const fixture of FIXTURES) {
      root = null;
      runFixture(corpus, fixture, new Map(), (key, state, memory) => visit(key, state, memory.data as AiMemoryData));
    }
    const walked = new Set(cases.map((c) => c.id));
    const records = Object.entries(golden.records).filter(([key]) => {
      const id = caseOf(key);
      return id === null || walked.has(id);
    });
    const unreached = records.filter(([key, value]) => !reached.has(key) && !value.startsWith('!')).map(([key]) => key);
    const stray = [...reached].filter((key) => golden.records[key] === undefined);
    const seconds = (performance.now() - start) / 1000;
    console.log(`View oracle (${FULL ? 'full' : `every ${SAMPLE_STRIDE}th case`}): ${reached.size} of ${records.length} golden records reached `
      + `(${cases.length} of ${corpus.cases.length} cases, ${FIXTURES.length} fixtures), `
      + `${views} views; turn facts ${JSON.stringify(Object.fromEntries(facts))}; refusals ${JSON.stringify(Object.fromEntries(refusals))}; `
      + `${mismatches.length} mismatches in ${seconds.toFixed(1)} s`);
    expect(mismatches.slice(0, 20)).toEqual([]);
    expect(unreached.slice(0, 20), `${unreached.length} golden records unreached`).toEqual([]);
    expect(stray.slice(0, 20)).toEqual([]);
    expect(reached.size).toBeGreaterThan(records.length * 0.9);
  }, FULL ? WALK_TIMEOUT_MS : undefined);
});
