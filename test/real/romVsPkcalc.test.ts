// Real-data check: the decoded ROM against PKCalc's trainer data. Each matched trainer is joined to a PKCalc
// trainer key by its docs name (`joinPkcalc`); then its AI flags, party order and sets are compared. Every difference,
// and every matched trainer that joins no key, must be in accepted-diffs.json under its `pkcalc-` area; the group check
// in romVsDocs.test.ts covers these areas too. `npm run record:diffs` rewrites both files.

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { buildCatalog } from '../../src/battle/catalog.js';
import { trainerId } from '../../src/battle/resolveTrainer.js';
import type { ResolvedTrainer } from '../../src/battle/types.js';
import { type Diff, diffsByKey } from '../../src/check/diff.js';
import { diffPkcalc, joinPkcalc, loadPkcalc, pkcalcAiFlags, type PkcalcData } from '../../src/check/pkcalc.js';
import { type KaizoDocs, loadDocs } from '../../src/data/load.js';
import { matchTrainers } from '../../src/names/matchTrainers.js';
import { buildNameIndex, type NameIndex } from '../../src/names/nameIndex.js';
import { extractRomData, type RomData } from '../../src/rom/extract.js';
import { NATURES } from '../../src/rom/natures.js';
import { acceptedFor } from './accepted.js';
import { needFiles, PK_ROM } from './env.js';

const caches = inject('realCaches');
const suite = needFiles('ROM against PKCalc', { PK_ROM }, [caches.docs, caches.pkcalc]);

describe.skipIf(suite.skip)(suite.title, () => {
  let rom: RomData;
  let docs: KaizoDocs;
  let names: NameIndex;
  let pkcalc: PkcalcData;
  let diffs: Diff[];
  const inArea = (area: Diff['area']) => diffsByKey(diffs.filter((diff) => diff.area === area));

  beforeAll(() => {
    rom = extractRomData(readFileSync(PK_ROM));
    docs = loadDocs(caches.docs.dir);
    names = buildNameIndex(docs);
    pkcalc = loadPkcalc(caches.pkcalc.dir);
    const join = joinPkcalc(matchTrainers(rom.trainers, docs.trainers, names).matched, rom.trainers, pkcalc);
    diffs = diffPkcalc(join, rom, pkcalc, names);
  });

  // Checked by hand on 2026-11-08: PKCalc and the ROM agree on these three Route 202 trainers.
  it.each([
    ['Youngster Tristan', 1, 0x7, ['Basic', 'EvalAttack', 'Expert']],
    ['Lass Natalie', 3, 0x5, ['Basic', 'Expert']],
    ['Bug Catcher Logan', 2, 0x1, ['Basic']],
  ] as const)('%s (ROM %i) has AI mask %i in the ROM and the same flags in PKCalc', (key, romIndex, mask, flags) => {
    expect(rom.trainers[romIndex]!.aiMask).toBe(mask);
    expect(rom.trainers[romIndex]!.aiFlags).toEqual(flags);
    expect(pkcalcAiFlags(pkcalc.aiFlags[key]!)).toEqual(flags);
  });

  it('the matched trainers that join no PKCalc trainer key are the accepted ones', () =>
    expect(inArea('pkcalc-join')).toEqual(acceptedFor('pkcalc-join')));

  it('AI flags match PKCalc, apart from the accepted diffs', () =>
    expect(inArea('pkcalc-ai')).toEqual(acceptedFor('pkcalc-ai')));

  it('party order matches PKCalc, apart from the accepted diffs', () =>
    expect(inArea('pkcalc-party-order')).toEqual(acceptedFor('pkcalc-party-order')));

  it('sets (level, moves, item, ability, nature) match PKCalc, apart from the accepted diffs', () =>
    expect(inArea('pkcalc-sets')).toEqual(acceptedFor('pkcalc-sets')));

  // A nature the docs alone give (a Pokémon after an override, whose ROM nature is unknown) is disputed
  // until spot check 1, with PKCalc's nature as its alternative where they differ (PKCalc disagrees with
  // the docs on 71 of 148 such natures). Counted on 2026-11-08: 144 among the opponents, 71 with PKCalc's alternative.
  it('disputes every docs nature, with PKCalc\'s nature as the alternative exactly where PKCalc\'s set differs', () => {
    const catalog = buildCatalog({ rom, names, docs, pkcalc });
    const resolved = docs.trainers.flatMap((doc) => catalog.byId(trainerId(doc, docs.trainers)) ?? []);
    const monsOf = (trainers: ResolvedTrainer[]) => trainers.flatMap((trainer) => [trainer, ...trainer.variants]).flatMap((trainer) =>
      trainer.party.map((mon, slot) => ({ key: `${trainer.split}: ${trainer.name} [ROM ${trainer.romIndex}] mon ${slot + 1}`, nature: mon.nature })));
    const fromDocs = monsOf(resolved).filter(({ nature }) => nature.source === 'docs');
    expect(fromDocs.filter(({ nature }) => !nature.disputed)).toEqual([]);
    // Each alternative is PKCalc's nature, exactly where the cross-check finds PKCalc's set differing from the docs.
    const withPkcalc = fromDocs.filter(({ nature }) => nature.value !== null && nature.alternatives.length > 0);
    const differing = diffs.filter((diff) => diff.field.startsWith('nature-from-docs') && diff.rom !== null);
    expect(withPkcalc.map(({ key, nature }) => [key, nature.alternatives.map((id) => NATURES[id!])]).sort())
      .toEqual(differing.map((diff) => [diff.key.replace(/ \([^)]*\)$/, ''), [diff.docs]]).sort());
    expect(withPkcalc.every(({ nature }) => nature.alternatives.length === 1)).toBe(true);
    // The opponents' counts, as the report gives them.
    const opponents = monsOf(catalog.trainers).filter(({ nature }) => nature.source === 'docs');
    expect([opponents.length, opponents.filter(({ nature }) => nature.disputed).length, opponents.filter(({ nature }) => nature.alternatives.length > 0).length])
      .toEqual([144, 144, 71]);
  });
});
