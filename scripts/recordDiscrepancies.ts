// `npm run record:diffs`: diffs the ROM (`PK_ROM`) against the docs and against PKCalc (each re-downloaded when over a
// day old), and our damage calc against PKCalc's own (its page in headless Chromium, offline once loaded), then rewrites
// test/real/accepted-diffs.json and docs/data-discrepancies.md. Each difference is explained by its group in
// src/check/groups.ts; one no group explains stops the script. Review the result in git, then commit both.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { buildCatalog } from '../src/battle/catalog.js';
import { buildMoves } from '../src/battle/moves.js';
import { docsNature } from '../src/battle/natures.js';
import { type Diff, diffLearnsets, diffMoves, diffsByKey, diffSpecies, diffTrainers, otherSide } from '../src/check/diff.js';
import { DOCS_ONLY_REASONS, type DiscrepancyGroup, type GroupContext, GROUPS, groupHeading, groupOf, SECTIONS, trainerSlot } from '../src/check/groups.js';
import { type DexTables, diffPkcalc, joinPkcalc, loadPkcalc, PAGE_DEX_TABLES, PKCALC_URL } from '../src/check/pkcalc.js';
import { calcGrid, DERI_PROFILES, diffCalc, gridTrainers, openPkcalcOffline, pkcalcNames } from '../src/check/pkcalcCalc.js';
import { loadDocs } from '../src/data/load.js';
import { matchTrainers } from '../src/names/matchTrainers.js';
import { buildNameIndex } from '../src/names/nameIndex.js';
import { normaliseName } from '../src/names/normalise.js';
import { extractRomData } from '../src/rom/extract.js';
import { personalRowFor } from '../src/rom/forms.js';
import { NATURES } from '../src/rom/natures.js';
import { trainerPid } from '../src/rom/trainers.js';
import { FEMALE_TRAINER_CLASSES } from '../src/rom/trainerClassGender.js';
import { PK_ROM, refreshDocs, refreshPkcalc } from '../test/real/env.js';

const JSON_FILE = 'test/real/accepted-diffs.json';
const MD_FILE = 'docs/data-discrepancies.md';

if (!existsSync(PK_ROM)) {
  console.error(`PK_ROM file not found: ${PK_ROM} (set PK_ROM to its path)`);
  process.exit(1);
}

const rom = extractRomData(readFileSync(PK_ROM));
const fetchedAtIn = (dir: string) => (JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { fetchedAt: string }).fetchedAt;
const caches = [await refreshDocs(), await refreshPkcalc()];
for (const cache of caches) {
  if (cache.skip !== null) {
    console.error(`Cannot record the differences: ${cache.skip}`);
    process.exit(1);
  }
}
const [docsDir, pkcalcDir] = caches.map((cache) => cache.dir) as [string, string];
const docs = loadDocs(docsDir);
const fetchedAt = fetchedAtIn(docsDir);
const pkcalc = loadPkcalc(pkcalcDir);
const pkcalcFetchedAt = fetchedAtIn(pkcalcDir);
const names = buildNameIndex(docs);
const report = matchTrainers(rom.trainers, docs.trainers, names);
const pkcalcJoin = joinPkcalc(report.matched, rom.trainers, pkcalc);
const docsDiffs: Diff[] = [...diffSpecies(rom, docs, names), ...diffLearnsets(rom, docs, names), ...diffMoves(rom, docs, names), ...diffTrainers(rom, docs, names)];
const pkcalcDiffs = diffPkcalc(pkcalcJoin, rom, pkcalc, names);

// Our damage rolls against PKCalc's own calc, in its page with the network cut once it has loaded.
const data = { rom, names, docs };
const calcCases = calcGrid(gridTrainers(buildCatalog(data)), DERI_PROFILES, data, buildMoves(data));
const browser = await chromium.launch({ headless: true });
let calc: Awaited<ReturnType<typeof diffCalc>>;
try {
  const pkcalcPage = await openPkcalcOffline(browser);
  calc = await diffCalc(pkcalcPage.page, calcCases, pkcalcNames(await pkcalcPage.page.evaluate(PAGE_DEX_TABLES) as DexTables));
  const escaped = pkcalcPage.escaped();
  if (escaped.length > 0) throw new Error(`Requests got out of PKCalc's page after the network was cut: ${escaped.join(', ')}`);
} finally {
  await browser.close();
}
const diffs = [...docsDiffs, ...pkcalcDiffs, ...calc.diffs];
const ctx: GroupContext = { report, trainers: rom.trainers };
const docsOnly = report.docsOnly.map((trainer) => `${trainer.split}: ${trainer.name}`);

// accepted-diffs.json, one difference per line so that a change shows as one line in git.
const keyed = diffsByKey(diffs);
const lines = (items: string[]) => items.join(',\n');
writeFileSync(JSON_FILE, `${[
  '{',
  `  "about": ${JSON.stringify(`Accepted differences of the ROM from the docs and from PKCalc (areas pkcalc-*), and of our damage rolls from PKCalc's (area calc, ours as rom), written by npm run record:diffs against the docs fetched at ${fetchedAt} and PKCalc fetched at ${pkcalcFetchedAt}. Keys are area/key/field; docs/data-discrepancies.md explains each group. npm run test:real fails on any new, vanished or changed difference.`)},`,
  '  "diffs": {',
  lines(Object.entries(keyed).map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`)),
  '  },',
  '  "romOnly": [',
  lines(Array.from({ length: Math.ceil(report.romOnly.length / 20) }, (_, i) => `    ${report.romOnly.slice(i * 20, i * 20 + 20).join(', ')}`)),
  '  ],',
  '  "docsOnly": [',
  lines(docsOnly.map((name) => `    ${JSON.stringify(name)}`)),
  '  ]',
  '}',
].join('\n')}\n`);

// Figures the explanations quote.
const natureIndex = (cell: string, female: boolean) =>
  NATURES.findIndex((name) => normaliseName(name) === normaliseName(docsNature(cell, female)));
const figures: Record<string, number> = {
  allLearnsets: docs.learnsets.size, sameLearnsets: docs.learnsets.size - diffs.filter((d) => d.area === 'learnset').length,
  sameMoves: docs.moves.length - new Set(diffs.filter((d) => d.area === 'move').map((d) => d.key)).size,
  knownNatures: 0, lmKnown: 0, lmAtRom: 0, lmAtDocs: 0, solarBeam130: 0, solarBeam76: 0,
  overrides: 0, overridesAgree: 0, overridesFlipped: 0, overridesChoice: 0, overridesChoiceAgree: 0, overridesChoiceFlipped: 0,
};
for (const match of report.matched) {
  const trainer = rom.trainers[match.romIndex]!;
  const female = FEMALE_TRAINER_CLASSES.has(trainer.trainerClass);
  trainer.party.forEach((mon, i) => {
    const docMon = match.doc.party[i]!;
    if (mon.natureKnown) figures.knownNatures!++;
    // Level-mismatch natures: does the docs' nature fit the plain rule at the ROM's level, or at the docs' level?
    if (match.levelMismatch && mon.natureKnown) {
      const want = natureIndex(docMon.nature, female);
      const dvs = Array.from({ length: 256 }, (_, dv) => dv).filter((dv) => trainerPid(dv, mon.level, mon.species, trainer.index, trainer.trainerClass, female) === mon.pid);
      figures.lmKnown!++;
      if (mon.nature === want) figures.lmAtRom!++;
      if (dvs.some((dv) => trainerPid(dv, docMon.level, mon.species, trainer.index, trainer.trainerClass, female) % 25 === want)) figures.lmAtDocs!++;
    }
    if (docMon.moves.includes('Solar-Beam')) {
      if (mon.moves.includes(130)) figures.solarBeam130!++;
      if (mon.moves.includes(76)) figures.solarBeam76!++;
    }
    // Ability overrides as decoded (1 first, 2 second) and with 1 and 2 swapped.
    if (mon.abilityOverride !== 0) {
      const [first, second] = rom.species[personalRowFor(mon.species, mon.form)]!.abilities;
      const abilityIn = (slot: number) => normaliseName(names.ability(slot === 2 && second !== 0 ? second : first));
      const agree = abilityIn(mon.abilityOverride) === normaliseName(docMon.ability);
      const flipped = abilityIn(3 - mon.abilityOverride) === normaliseName(docMon.ability);
      const choice = second !== 0 && second !== first;
      figures.overrides!++;
      figures.overridesAgree! += Number(agree);
      figures.overridesFlipped! += Number(flipped);
      figures.overridesChoice! += Number(choice);
      figures.overridesChoiceAgree! += Number(choice && agree);
      figures.overridesChoiceFlipped! += Number(choice && flipped);
    }
  });
}
// PKCalc's natures where the ROM's is unknown: how often it gives the docs' nature, on level-mismatch matches and on the
// others, and how often it gives the plain-rule one where it does not.
Object.assign(figures, { nfdAll: 0, nfdOther: 0, nfdOtherAgree: 0, nfdLm: 0, nfdLmAgree: 0, nfdDiffer: 0, nfdPlain: 0 });
const monId = (key: string) => Object.values(trainerSlot(key)).join(':');
const fromDocs = new Map(pkcalcDiffs.filter((d) => d.field === 'nature-from-docs').map((d) => [monId(d.key), d]));
const noSet = new Set(pkcalcDiffs.filter((d) => d.field === 'set').map((d) => monId(d.key)));
for (const { match } of pkcalcJoin.joined) {
  rom.trainers[match.romIndex]!.party.forEach((mon, slot) => {
    const id = `${match.romIndex}:${slot}`;
    if (mon.natureKnown || noSet.has(id)) return;
    const diff = fromDocs.get(id);
    const kind = match.levelMismatch ? 'nfdLm' : 'nfdOther';
    figures.nfdAll!++;
    figures[kind]!++;
    if (!diff) figures[`${kind}Agree`]!++;
    else {
      figures.nfdDiffer!++;
      if (normaliseName(NATURES[mon.nature]!) === normaliseName(String(diff.docs))) figures.nfdPlain!++;
    }
  });
}
figures.nfdAgree = figures.nfdAll! - figures.nfdDiffer!;
// The damage-roll grid against PKCalc.
Object.assign(figures, {
  calcCases: calc.coverage.cases, calcRolls: calc.coverage.rolls, calcMons: calc.coverage.trainerMons, calcTrainers: calc.coverage.trainers,
  calcMoves: calc.coverage.moves, calcDamaging: calc.coverage.damaging, calcSame: calc.coverage.rolls - calc.coverage.differing,
});
const fill = (text: string) => text.replace(/\{(\w+)\}/g, (_, name: string) => {
  const value = figures[name];
  if (value === undefined) throw new Error(`No figure {${name}}`);
  return value.toLocaleString('en');
});

// Layouts.
const esc = (text: string) => text.replaceAll('|', '\\|');
const value = (v: unknown) => esc(v === null ? '(none)' : Array.isArray(v) ? v.join(', ') : v === '' ? '(blank)' : String(v));
const trainerOf = (key: string) => key.replace(/ mon \d+ \(.*\)$/, '');
const monLabel = (key: string) => key.match(/ mon (\d+) \((.*)\)$/)!.slice(1).join(' ');
const byTrainer = (list: Diff[]) => {
  const map = new Map<string, Diff[]>();
  for (const diff of list) map.set(trainerOf(diff.key), [...(map.get(trainerOf(diff.key)) ?? []), diff]);
  return map;
};
const table = (head: string[], rows: string[][]) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.join(' | ')} |`)];
function layout(group: DiscrepancyGroup, list: Diff[]): string[] {
  switch (group.layout) {
    case 'rows': {
      const area = SECTIONS.find((section) => section.id === group.section)!.area;
      const columns = group.columns ?? ['ROM', otherSide(area) === 'pkcalc' ? 'PKCalc' : 'Docs'];
      return table(['Key', ...columns], list.map((d) => [`\`${esc(`${d.area}/${d.key}/${d.field}`)}\``, value(d.rom), value(d.docs)]));
    }
    case 'learnsets':
      return table(['Species', 'What differs'], list.map((d) => {
        const left = [...(d.docs as string[])];
        const romOnly = (d.rom as string[]).filter((entry) => {
          const at = left.findIndex((other) => normaliseName(other) === normaliseName(entry));
          if (at < 0) return true;
          left.splice(at, 1);
          return false;
        });
        const what = romOnly.length === 0 && left.length === 0 ? 'Same moves and levels, in another order'
          : [romOnly.length > 0 ? `ROM only: ${romOnly.join(', ')}` : '', left.length > 0 ? `docs only: ${left.join(', ')}` : ''].filter(Boolean).join('; ');
        return [d.key, esc(what)];
      }));
    case 'levels':
      return table(['Trainer', 'Pokémon: ROM level (docs level)'], [...byTrainer(list)].map(([trainer, own]) =>
        [esc(trainer), own.map((d) => `${monLabel(d.key)}: ${d.rom} (${d.docs})`).join('; ')]));
    case 'monList':
      return [...byTrainer(list)].map(([trainer, own]) => `- ${esc(trainer)}: mon ${own.map((d) => trainerSlot(d.key).slot + 1).join(', ')}`);
    case 'natureCounts':
      return [...byTrainer(list)].map(([trainer, own]) => {
        const known = rom.trainers[trainerSlot(own[0]!.key).romIndex]!.party.filter((mon) => mon.natureKnown).length;
        return `- ${esc(trainer)}: ${own.length} of ${known}`;
      });
  }
}

// The document.
const byGroup = new Map<DiscrepancyGroup, Diff[]>(GROUPS.map((group) => [group, []]));
for (const diff of diffs) byGroup.get(groupOf(diff, ctx))!.push(diff);
const count = (field: string) => diffs.filter((d) => d.area === 'trainer' && d.field === field).length;
const kinds = { exact: report.matched.filter((m) => !m.shared && !m.levelMismatch).length, level: report.matched.filter((m) => m.levelMismatch).length, shared: report.matched.filter((m) => m.shared).length };
const matchedMons = report.matched.reduce((n, m) => n + m.doc.party.length, 0);
const md: string[] = [
  '# Where the ROM disagrees with the official docs and PKCalc',
  '',
  'When the docs or PKCalc change: `npm run record:diffs`, review the diff, commit.',
  'This file and `test/real/accepted-diffs.json` are written by `scripts/recordDiscrepancies.ts`; edit the explanations in `src/check/groups.ts`.',
  '',
  `\`npm run test:real\` compares the player's ROM (\`plat-kaizo-nightmare-update-final.nds\`) with the official docs fetched at ${fetchedAt}: ${docs.species.length} species, ${docs.learnsets.size} level-up learnsets, ${docs.moves.length} moves, and the ${matchedMons.toLocaleString('en')} Pokémon of ${report.matched.length} matches (${kinds.exact + kinds.level} docs trainers + ${kinds.shared} shared ROM copies).`,
  'Base stats, types and abilities agree apart from one docs typo (Fearow); six cat Pokémon have another growth rate; some learnsets and moves differ.',
  'Most trainer differences are harmless (levels the docs never caught up with, the same moves in another order, docs spellings), and a short list are real changes.',
  `The ROM's nature differs from the docs' on ${count('nature-cross-check')} Pokémon; the docs turn out to be stale there, and the planner uses the ROM's.`,
  '',
  '## How to read this',
  '',
  '- Every difference is listed with both values in `test/real/accepted-diffs.json`, under a key `area/key/field`. The test fails when a difference appears, disappears or changes value, and when this file lacks a difference\'s group or has the wrong count.',
  '- Trainer keys read `Split: Trainer [ROM index] mon N (species as the docs write it)`. Counts are differences (one per field), not trainers.',
  '- PKCalc keys (areas `pkcalc-*`) read `Split: Trainer [ROM index]`, plus ` mon N (species as PKCalc names it)` for a set. The JSON names PKCalc\'s side `pkcalc` instead of `docs`.',
  '- Damage-roll keys (area `calc`) read `Split: Trainer [ROM index] mon N (species) Move vs. Profile Llevel`, or `… hit by Profile Llevel Move`; there the `rom` side is our calc\'s 16 rolls and `pkcalc` is PKCalc\'s.',
  '- Which side the planner uses: for trainer Pokémon, the ROM. Levels, species and forms, abilities, items and moves come from the ROM, and so does the nature wherever the decoder knows it (`natureKnown`); the docs\' nature is used only where it does not. Every disagreement on a trainer is disputed, to be settled by in-game spot checks.',
  '- For species, learnsets and moves the ROM is what the game reads. In the battle engine the docs win for move behaviour.',
  '- Two mismatches were our own bugs, fixed with a failing test first: the docs parser missed the bare item "None" (Leader Fantina), and the trainer matcher paired the three SwimmerF Wang fights and one Gardenia Split rival copy with the wrong ROM trainers. Neither is listed here.',
  '',
];
for (const section of SECTIONS) {
  const groups = GROUPS.filter((group) => group.section === section.id && byGroup.get(group)!.length > 0);
  if (section.id === 'levels') {
    md.push(`## Trainers that matched nothing: ${docsOnly.length} in the docs, ${report.romOnly.length} in the ROM`, '',
      `${report.matched.length} matches pair docs trainers with ROM trainers: ${kinds.exact} exact, ${kinds.level} on species and forms but not levels, and ${kinds.shared} further ROM copies with a docs trainer's exact party. These docs trainers matched none (\`docsOnly\` in the JSON):`, '',
      ...table(['Docs trainer', 'Why'], docsOnly.map((name) => {
        const reason = DOCS_ONLY_REASONS.find(([pattern]) => pattern.test(name));
        if (!reason) throw new Error(`No reason for the docs-only trainer ${name}`);
        return [esc(name), reason[1]];
      })), '',
      `The other way round, ${report.romOnly.length} ROM trainers match no docs trainer: rematches, unused entries, and copies the docs leave out (such as a rival's team for another starter or player gender). The test pins their indexes (\`romOnly\` in the JSON) rather than explaining each one.`, '');
  }
  if (section.id === 'pkcalc-join') {
    const joinedMons = pkcalcJoin.joined.reduce((n, { match }) => n + rom.trainers[match.romIndex]!.party.length, 0);
    const setDiffMons = new Set(pkcalcDiffs.filter((d) => d.area === 'pkcalc-sets').map((d) => d.key)).size;
    const keyCount = new Set(pkcalcJoin.joined.map(({ key }) => key)).size + pkcalcJoin.unusedKeys.length;
    md.push('## Against PKCalc', '',
      `\`npm run test:real\` also compares the ROM with PKCalc (${PKCALC_URL}), the community damage calculator for this hack, fetched at ${pkcalcFetchedAt}: the AI flags, party order and sets of each match that joins a PKCalc trainer. It also checks PKCalc's import of the player's save against our save reader (\`test/real/boxVsPkcalc.test.ts\`). Those must agree exactly, and nothing about the save is pinned, so that check has no entries here.`, '',
      `Each match is joined to a PKCalc trainer key by its docs name (\`joinPkcalc\` in \`src/check/pkcalc.ts\`): ${pkcalcJoin.joined.length} of the ${report.matched.length} matches join one, and ${pkcalcJoin.unjoined.length} do not (below). ${pkcalcJoin.unusedKeys.length} of PKCalc's ${keyCount} trainer keys join no match: ${pkcalcJoin.unusedKeys.map(esc).join('; ')}. These are teams the docs leave out or that match no docs trainer (see the docs-only trainers above).`, '',
      `AI flags and party order agree for all ${pkcalcJoin.joined.length} joined trainers: \`pkcalc-ai\` and \`pkcalc-party-order\` have no groups, so a difference there stops \`npm run record:diffs\` until one explains it. Of the joined trainers' ${joinedMons.toLocaleString('en')} Pokémon, ${setDiffMons} have a set that differs in some field.`, '');
  }
  if (groups.length === 0) continue;
  md.push(`## ${section.heading}: ${groups.reduce((n, group) => n + byGroup.get(group)!.length, 0)}`, '');
  if (section.intro) md.push(fill(section.intro), '');
  for (const group of groups) {
    const list = byGroup.get(group)!;
    md.push(groupHeading(group, list.length), '', fill(group.text), '', ...layout(group, list), '');
  }
}
writeFileSync(MD_FILE, `${md.join('\n').trimEnd()}\n`);

console.log(`Wrote ${JSON_FILE} and ${MD_FILE}: ${diffs.length} differences in ${[...byGroup.values()].filter((list) => list.length > 0).length} groups, ${report.romOnly.length} ROM-only, ${docsOnly.length} docs-only.`);
console.log(`PKCalc: ${pkcalcJoin.joined.length} of ${report.matched.length} matches join a trainer key, ${pkcalcJoin.unjoined.length} do not; ${pkcalcJoin.unusedKeys.length} keys unused; ${pkcalcDiffs.length} of the differences are PKCalc's.`);
console.log(`Damage rolls: ${calc.coverage.rolls} comparisons in ${calc.coverage.cases} calcs (${calc.coverage.trainerMons} Pokémon of ${calc.coverage.trainers} trainers, ${calc.coverage.moves} moves); ${calc.coverage.differing} differ.`);
console.log(`Ability overrides:${figures.overridesAgree}/${figures.overrides} agree with the docs as decoded, ${figures.overridesFlipped}/${figures.overrides} with 1 and 2 swapped (${figures.overridesChoiceAgree}/${figures.overridesChoice} and ${figures.overridesChoiceFlipped}/${figures.overridesChoice} where the species has two abilities).`);
