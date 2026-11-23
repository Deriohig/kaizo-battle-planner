// The differential test's shards together check every golden record: each player shard
// (aiDifferential.p<n>.test.ts, through aiDifferentialSuite.ts) compares only the golden records whose key's player lead
// is its own (playerOf), and the fixtures shard (aiDifferential.fixtures.test.ts) the `f/` records, so a key whose lead
// parsed to anything else, or whose kind no shard reads, would be checked by none.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOLDEN_PATH, type Golden, playerOf } from './aiCorpus.js';
import { DIFFERENTIAL_SHARDS, FIXTURES_KEY_PREFIX } from './aiDifferentialSuite.js';

describe("the trainer AI's differential shards", () => {
  it('cover every golden record once: the per-shard counts sum to the golden total', () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
    const keys = Object.keys(golden.records);
    const fixtures = keys.filter((key) => key.startsWith(FIXTURES_KEY_PREFIX));
    const corpus = keys.filter((key) => !key.startsWith(FIXTURES_KEY_PREFIX));
    const perShard = DIFFERENTIAL_SHARDS.map((player) => corpus.filter((key) => playerOf(key) === player).length);
    const unsharded = corpus.filter((key) => !DIFFERENTIAL_SHARDS.includes(playerOf(key)));
    expect(unsharded.slice(0, 20), `${unsharded.length} golden keys belong to no shard`).toEqual([]);
    // No fixture key is also read by a player shard (playerOf is NaN for it), and every one is `f/<name>/<step>`.
    expect(fixtures.filter((key) => !Number.isNaN(playerOf(key)))).toEqual([]);
    expect(fixtures.filter((key) => !/^f\/[a-z0-9-]+\/\d+(\.\d+)?$/.test(key)).slice(0, 20)).toEqual([]);
    expect(perShard.reduce((sum, n) => sum + n, 0) + fixtures.length).toBe(keys.length);
    for (const n of perShard) expect(n).toBeGreaterThan(0);
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it('each shard has its test file, which runs that shard', () => {
    for (const player of DIFFERENTIAL_SHARDS) {
      const file = join('test', 'real', `aiDifferential.p${player}.test.ts`);
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain(`differentialSuite(${player});`);
    }
    const file = join('test', 'real', 'aiDifferential.fixtures.test.ts');
    expect(existsSync(file), file).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('fixturesSuite();');
  });
});
