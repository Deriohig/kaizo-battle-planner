import { describe, expect, it } from 'vitest';
import type { Diff } from '../../../src/check/diff.js';
import { type GroupContext, GROUPS, groupHeading, groupOf, SECTIONS } from '../../../src/check/groups.js';
import type { DocTrainer } from '../../../src/docs/teams.js';
import type { TrainerMon } from '../../../src/rom/trainers.js';
import { romTrainer, trainerMon } from '../../fixtures/loadedData.js';

const DOC: DocTrainer = { split: 'Byron Split', location: 'Route 1', locationGauntlet: false, field: null, name: 'Galactic Grunt', tags: { starred: false, raw: [] }, order: 0, party: [] };
const mon = (fields: Partial<TrainerMon> = {}) => trainerMon(16, 5, { pid: 0, moves: [], ...fields });

/** ROM trainer 7 of `trainerClass` with `party`, matched as `flags` say, and with `copy` as its shared copy ROM 8. */
function context(trainerClass: number, party: TrainerMon[], flags: { levelMismatch?: true; shared?: true } = {}, copy?: TrainerMon[]): GroupContext {
  const matched = [{ romIndex: 7, doc: DOC, ...flags }, ...(copy ? [{ romIndex: 8, doc: DOC, shared: true as const }] : [])];
  const trainers = [romTrainer(7, party, { trainerClass }), ...(copy ? [romTrainer(8, copy, { trainerClass })] : [])];
  return { report: { matched, romOnly: [], docsOnly: [] }, trainers };
}
const NONE = context(2, []);
const GALACTIC = context(73, [mon()]);
const copies = (first: Partial<TrainerMon>, copy: Partial<TrainerMon>) => context(73, [mon(first)], {}, [mon(copy)]);
const WITH_COPY = copies({}, {});
const KEATING_CTX: GroupContext = { report: { matched: [{ romIndex: 228, doc: DOC }], romOnly: [], docsOnly: [] }, trainers: [] };

const GRUNT = 'Byron Split: Galactic Grunt [ROM 7] mon 1 (Pidgey)';
const COPY = 'Byron Split: Galactic Grunt [ROM 8] mon 1 (Pidgey)';
const diff = (area: Diff['area'], field: string, rom: unknown = 'A', docs: unknown = 'B', key = GRUNT): Diff => ({ area, key, field, rom, docs });
const keating = (slot: number, field: string) => diff('trainer', field, field === 'moves' ? ['Crabhammer'] : 'Quick Claw', field === 'moves' ? ['Agility'] : 'Berserk Gene',
  `Maylene Split: Gambler John Keating [ROM 228] mon ${slot} (Kingler)`);
const unjoined = (name: string) => diff('pkcalc-join', 'key', ['Vulpix'], null, `Roark Split: ${name} [ROM 7]`);
const set = (field: string, key = GRUNT) => diff('pkcalc-sets', field, 'Hardy', 'Bold', key);
const flint = (field: string, species: string) => set(field, `Elite Four Split: Elite Four Flint [ROM 874] mon 3 (${species})`);
const cyrus = (species: string) => diff('pkcalc-sets', 'ability', 'Levitate', 'Pressure', `Galactic Split: CYRUS [ROM 7] mon 1 (${species})`);
const calcDiff = (field: string) => diff('calc', field, [20], [2], 'Zigzagoon Fling vs. Zigzagoon');

describe('groupOf', () => {
  // null: no group explains the difference, so groupOf throws, naming it.
  it.each<[string, Diff, GroupContext, string | null]>([
    ['Fearow\'s Sp. Atk', diff('species', 'spa', 61, 31, 'Fearow'), NONE, 'fearow'],
    ['Glameow\'s growth rate', diff('species', 'growthRate', 'Erratic', 'Fast', 'Glameow'), NONE, 'cat-growth'],
    ['Pidgey\'s growth rate', diff('species', 'growthRate', 'Erratic', 'Fast', 'Pidgey'), NONE, null],
    // Natures by how the trainer matched, then by Team Galactic class.
    ['a nature on a level-mismatch match', diff('trainer', 'nature-cross-check'), context(73, [mon()], { levelMismatch: true }), 'nature-level'],
    ['a nature on a shared copy', diff('trainer', 'nature-cross-check'), context(73, [mon()], { shared: true }), 'nature-shared'],
    ['a Galactic nature', diff('trainer', 'nature-cross-check'), GALACTIC, 'nature-galactic'],
    ['another nature', diff('trainer', 'nature-cross-check'), context(2, [mon()]), 'nature-other'],
    // Abilities by override and by whether the nature is known.
    ['an overridden ability', diff('trainer', 'ability'), context(2, [mon({ abilityOverride: 1 })]), 'ability-override'],
    ['a plain-PID ability', diff('trainer', 'ability'), context(2, [mon()]), 'ability-plain-pid'],
    ['an ability on an untrusted PID', diff('trainer', 'ability-cross-check'), context(2, [mon({ natureKnown: false })]), 'ability-cross-check'],
    ['a docs ability slip', diff('trainer', 'ability', 'Synchronize', 'Syncronize'), context(2, [mon()]), 'ability-slips'],
    ['a level on a level-mismatch match', diff('trainer', 'level', 50, 51), context(2, [mon()], { levelMismatch: true }), 'levels'],
    ['a level on any other match', diff('trainer', 'level', 50, 51), context(2, [mon()]), null],
    ['a docs spelling of a move', diff('trainer', 'moves', ['Hidden Power', 'Protect'], ['HP Dark', 'Protect']), NONE, 'move-spelling'],
    ['a different move', diff('trainer', 'moves', ['Superpower', 'Protect'], ['Close Combat', 'Protect']), NONE, 'moves-real'],
    // Item and moves differences on the second copy only where the two ROM copies differ there.
    ['an item on a copy that differs', diff('trainer', 'item', 'Life Orb', 'Charcoal', COPY), copies({ item: 217 }, { item: 270 }), 'item-second-copy'],
    ['an item on a copy that does not differ', diff('trainer', 'item', 'Life Orb', 'Charcoal', COPY), copies({ item: 270 }, { item: 270 }), 'item-real'],
    ['an item on the first copy', diff('trainer', 'item', 'Charcoal', 'Life Orb'), copies({ item: 217 }, { item: 270 }), 'item-real'],
    ['moves on a copy that differs', diff('trainer', 'moves', ['Tackle'], ['Tackle', 'Growl'], COPY), copies({ moves: [33, 45] }, { moves: [33] }), 'moves-second-copy'],
    ['the same moves in another order on a copy', diff('trainer', 'moves', ['Growl', 'Tackle'], ['Tackle', 'Ember'], COPY), copies({ moves: [33, 45] }, { moves: [45, 33] }), 'moves-real'],
    // Gambler John Keating's last three Pokémon only.
    ['Keating\'s 4th item', keating(4, 'item'), KEATING_CTX, 'item-john-keating'],
    ['Keating\'s 6th moves', keating(6, 'moves'), KEATING_CTX, 'moves-john-keating'],
    ['Keating\'s 3rd item', keating(3, 'item'), KEATING_CTX, 'item-real'],
    ['Keating\'s 1st moves', keating(1, 'moves'), KEATING_CTX, 'moves-real'],
    // The matched trainers that join no PKCalc key, and only those it knows.
    ['an unjoined School Kid', unjoined('School KidfChristine'), NONE, 'pkcalc-school-kids'],
    ['the unjoined Ranger Jeffrey', unjoined('Pkmn Ranger Jeffrey'), NONE, 'pkcalc-jeffrey'],
    ['another unjoined trainer', unjoined('Youngster Tristan'), NONE, null],
    // A PKCalc set difference goes under the second copies only when the other copy has PKCalc's value ("-other-copy").
    ['a PKCalc nature the other copy has', set('nature-other-copy'), WITH_COPY, 'pkcalc-copy-natures'],
    ...['nature', 'moves', 'item'].map((field): [string, Diff, GroupContext, null] => [`a PKCalc ${field} no copy has`, set(field), WITH_COPY, null]),
    ['Flint\'s copy move', flint('moves-other-copy', 'Exeggutor'), NONE, 'pkcalc-copy-flint-move'],
    ['Flint\'s copy item', flint('item-other-copy', 'Magmortar'), NONE, 'pkcalc-copy-flint-item'],
    ['another trainer\'s copy move', set('moves-other-copy'), WITH_COPY, null],
    ['another trainer\'s copy item', set('item-other-copy'), WITH_COPY, null],
    ['a PKCalc nature against the docs', set('nature-from-docs'), GALACTIC, 'pkcalc-nature-from-docs'],
    ['a PKCalc ability on an untrusted PID', set('ability-cross-check'), GALACTIC, 'pkcalc-ability-cross-check'],
    ['PKCalc\'s Giratina-Origin ability', cyrus('Giratina-Origin'), NONE, 'pkcalc-form-abilities'],
    ['PKCalc\'s Giratina ability', cyrus('Giratina'), NONE, null],
    // Calc differences: only the causes shown are accepted.
    ['an unmodelled move\'s rolls', calcDiff('rolls-unmodelled'), NONE, 'calc-unmodelled'],
    ['an OHKO move\'s rolls', calcDiff('rolls-ohko'), NONE, 'calc-ohko'],
    ['a Fling\'s rolls', calcDiff('rolls-fling-power'), NONE, 'calc-fling-power'],
    ['unexplained rolls', calcDiff('rolls-unexplained'), NONE, null],
  ])('files %s', (_, d, ctx, id) => {
    if (id === null) expect(() => groupOf(d, ctx)).toThrow(`No discrepancy group explains ${d.area}/${d.key}/${d.field}`);
    else expect(groupOf(d, ctx).id).toBe(id);
  });

  it('has groups in known sections, with their own titles and a heading with their count', () => {
    expect(GROUPS.every((group) => SECTIONS.some((section) => section.id === group.section))).toBe(true);
    expect(new Set(GROUPS.map((group) => group.title)).size).toBe(GROUPS.length);
    expect(groupHeading(GROUPS.find((group) => group.id === 'fearow')!, 1)).toBe('### Fearow\'s Sp. Atk, a docs typo (1)');
  });
});
