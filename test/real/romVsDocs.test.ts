// Real-data check: the decoded ROM against the official docs. Every difference must be in
// accepted-diffs.json, keyed area/key/field, and fall into a group docs/data-discrepancies.md describes with the right
// count; a new difference, a vanished one or a changed value fails. `npm run record:diffs` rewrites both files. The group
// check covers every accepted difference, PKCalc's (romVsPkcalc.test.ts) included.

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { type Diff, diffLearnsets, diffMoves, diffsByKey, diffsFromKeyed, diffSpecies, diffTrainers } from '../../src/check/diff.js';
import { type DiscrepancyGroup, groupHeading, groupOf } from '../../src/check/groups.js';
import { type KaizoDocs, loadDocs } from '../../src/data/load.js';
import { type MatchReport, matchTrainers } from '../../src/names/matchTrainers.js';
import { buildNameIndex, type NameIndex } from '../../src/names/nameIndex.js';
import { extractRomData, type RomData } from '../../src/rom/extract.js';
import { accepted, acceptedFor } from './accepted.js';
import { needFiles, PK_ROM } from './env.js';

const markdown = readFileSync(new URL('../../docs/data-discrepancies.md', import.meta.url), 'utf8');

/** Disputed values where the ROM side is used, pinned in their own tests. */
const CROSS_CHECKS = ['nature-cross-check', 'ability-cross-check'];

const caches = inject('realCaches');
const suite = needFiles('ROM against the official docs', { PK_ROM }, [caches.docs]);

describe.skipIf(suite.skip)(suite.title, () => {
  let rom: RomData;
  let docs: KaizoDocs;
  let names: NameIndex;
  let report: MatchReport;
  let trainerDiffs: Diff[];

  beforeAll(() => {
    rom = extractRomData(readFileSync(PK_ROM));
    docs = loadDocs(caches.docs.dir);
    names = buildNameIndex(docs);
    report = matchTrainers(rom.trainers, docs.trainers, names);
    trainerDiffs = diffTrainers(rom, docs, names);
  });

  it('base stats, types, abilities and growth rates match the Personal tab, apart from the accepted diffs', () =>
    expect(diffsByKey(diffSpecies(rom, docs, names))).toEqual(acceptedFor('species')));

  it('learnsets match the Level-Up Learnsets tab, apart from the accepted diffs', () =>
    expect(diffsByKey(diffLearnsets(rom, docs, names))).toEqual(acceptedFor('learnset')));

  it('moves match the Moves tab, apart from the accepted diffs', () =>
    expect(diffsByKey(diffMoves(rom, docs, names))).toEqual(acceptedFor('move')));

  it('matched trainers\' Pokémon match their docs teams, apart from the accepted diffs', () =>
    expect(diffsByKey(trainerDiffs.filter((diff) => !CROSS_CHECKS.includes(diff.field))))
      .toEqual(acceptedFor('trainer', (field) => !CROSS_CHECKS.includes(field))));

  it.each(CROSS_CHECKS)('the %s differences are exactly the accepted, disputed ones (ROM used)', (field) =>
    expect(diffsByKey(trainerDiffs.filter((diff) => diff.field === field))).toEqual(acceptedFor('trainer', (f) => f === field)));

  it('levels differ only in level-mismatch matches, and in each of them', () => {
    const romIndex = (diff: Diff) => Number(diff.key.match(/\[ROM (\d+)\]/)![1]);
    const withLevelDiffs = new Set(trainerDiffs.filter((diff) => diff.field === 'level').map(romIndex));
    const levelMismatches = new Set(report.matched.filter((match) => match.levelMismatch).map((match) => match.romIndex));
    expect(withLevelDiffs).toEqual(levelMismatches);
  });

  it('the trainers only one side has are the accepted lists', () => {
    expect(report.docsOnly.map((trainer) => `${trainer.split}: ${trainer.name}`)).toEqual(accepted.docsOnly);
    expect(report.romOnly).toEqual(accepted.romOnly);
  });

  it('every accepted difference falls into a group docs/data-discrepancies.md describes, with that group\'s count', () => {
    const counts = new Map<DiscrepancyGroup, number>();
    for (const diff of diffsFromKeyed(accepted.diffs)) {
      const group = groupOf(diff, { report, trainers: rom.trainers });
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    const headings = markdown.split('\n').filter((line) => line.startsWith('### ')).sort();
    expect(headings).toEqual([...counts].map(([group, count]) => groupHeading(group, count)).sort());
  });
});
