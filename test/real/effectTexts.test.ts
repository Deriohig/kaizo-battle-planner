// Real-data check: the calc's effect lists classify every effect text in the official docs' Moves tab. The unit test in
// test/unit/battle/moves.test.ts runs the same check, but only where the gitignored docs CSVs are saved, so it skips on
// a fresh clone; this one reads the docs cache that globalSetup.ts refreshes.

import { describe, inject, it } from 'vitest';
import { loadDocs } from '../../src/data/load.js';
import { expectEveryEffectClassified } from '../fixtures/effectClassification.js';
import { needFiles } from './env.js';

const caches = inject('realCaches');
const suite = needFiles('Effect texts of the official docs', {}, [caches.docs]);

describe.skipIf(suite.skip)(suite.title, () => {
  it('every effect text in the docs\' Moves tab is in one of the calc\'s effect lists', () => {
    expectEveryEffectClassified(loadDocs(caches.docs.dir).moves);
  });
});
