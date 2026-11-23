// The groups that docs/data-discrepancies.md explains the accepted ROM-vs-docs differences by. scripts/recordDiscrepancies.ts
// writes the file from them, and the real test checks that every accepted difference falls into a group the file
// describes, with the right count. Explanations are written here; `{name}` placeholders are figures the script fills in.

import type { MatchReport, TrainerMatch } from '../names/matchTrainers.js';
import { normaliseName } from '../names/normalise.js';
import type { RomTrainer, TrainerMon } from '../rom/trainers.js';
import type { Diff, DiffArea } from './diff.js';

/** What a group may look at besides the diff itself. */
export interface GroupContext { report: MatchReport; trainers: RomTrainer[] }

/**
 * How the script lays out a group's differences: a table of key, ROM and docs (`rows`); species and what differs
 * (`learnsets`); one table row per trainer with each Pokémon's levels (`levels`); one line per trainer listing its
 * Pokémon (`monList`); or one line per trainer with its count of the Pokémon compared (`natureCounts`).
 */
export type GroupLayout = 'rows' | 'learnsets' | 'levels' | 'monList' | 'natureCounts';

export interface Section { id: string; area: DiffArea; heading: string; intro: string }

export interface DiscrepancyGroup {
  id: string;
  section: string;
  title: string;
  text: string;
  layout: GroupLayout;
  /** The `rows` layout's headings for the two values; by default "ROM" and the other side ("Docs" or "PKCalc"). */
  columns?: [string, string];
  /** The diff fields the group takes, within its section's area. */
  fields: string[];
  /** Further condition; a diff goes to the first group of its area and field whose condition holds. */
  matches?: (diff: Diff, ctx: GroupContext) => boolean;
}

/** The heading a group gets in the markdown, with its count of differences. */
export function groupHeading(group: DiscrepancyGroup, count: number): string {
  return `### ${group.title} (${count})`;
}

/** The ROM trainer index and 0-based party slot in a trainer diff's key ("… [ROM 307] mon 3 (Rotom)"). */
export function trainerSlot(key: string): { romIndex: number; slot: number } {
  const match = key.match(/\[ROM (\d+)\] mon (\d+) \(/);
  if (!match) throw new Error(`Not a trainer Pokémon key: ${key}`);
  return { romIndex: Number(match[1]), slot: Number(match[2]) - 1 };
}

/** The ROM trainer index in a trainer or PKCalc diff's key ("… [ROM 307]…"). */
function romIndexOf(key: string): number {
  const match = key.match(/\[ROM (\d+)\]/);
  if (!match) throw new Error(`Not a trainer key: ${key}`);
  return Number(match[1]);
}

function matchOf(diff: Diff, ctx: GroupContext): TrainerMatch {
  const romIndex = romIndexOf(diff.key);
  const match = ctx.report.matched.find((candidate) => candidate.romIndex === romIndex);
  if (!match) throw new Error(`No match for ROM trainer ${romIndex}`);
  return match;
}

function monOf(diff: Diff, ctx: GroupContext): { trainer: RomTrainer; mon: TrainerMon } {
  const { romIndex, slot } = trainerSlot(diff.key);
  const trainer = ctx.trainers.find((candidate) => candidate.index === romIndex);
  const mon = trainer?.party[slot];
  if (!trainer || !mon) throw new Error(`No ROM Pokémon for ${diff.key}`);
  return { trainer, mon };
}

const CATS = new Set(['Meowth', 'Persian', 'Skitty', 'Delcatty', 'Glameow', 'Purugly']);
const DIFFERING_MOVES = new Set(['Swords Dance', 'Constrict', 'Hurricane', 'Triple Axel', 'Substitute', 'Triple Kick', 'Spite', 'Fury Cutter', 'Ice Ball', 'Rock Wrecker']);
const ITEM_SPELLINGS = new Set(['Leek', 'Lax Inscence', 'Jacoba Berry']);
/** ROM move and the docs' name for it, where that is the only difference in the moveset. */
const MOVE_SPELLINGS: [string, string][] = [
  ['Hidden Power', 'HP Dark'], ['SmellingSalt', 'SmellingSalts'], ['Fire Ball', 'Weather Ball Fire'], ['Rollout', 'Accelerock'],
  ['Hail Ball', 'Weather Ball'], ['Weather Ball', 'Water Ball'],
];
/** Team Galactic trainer classes: grunts (73, 89), Squad (99), Commanders Mars, Jupiter and Saturn (72, 87, 88), Cyrus (86). */
const GALACTIC_CLASSES = new Set([72, 73, 86, 87, 88, 89, 99]);

/** Gambler John Keating's Staraptor, Kingler and Magmortar, the last three of his six. */
const JOHN_KEATING_LAST_THREE = /: Gambler John Keating \[ROM 228\] mon [4-6] \(/;

/**
 * Whether a trainer diff's Pokémon is on a further ROM copy of a docs trainer's team (`shared`) and holds
 * another value in the diff's field (`item`, or `moves` as a set) than the first copy's Pokémon in the same slot.
 */
function copiesDiffer(diff: Diff, ctx: GroupContext): boolean {
  const match = matchOf(diff, ctx);
  if (!match.shared) return false;
  const first = ctx.report.matched.find((other) => other.doc === match.doc && !other.shared);
  const firstMon = ctx.trainers.find((trainer) => trainer.index === first?.romIndex)?.party[trainerSlot(diff.key).slot];
  if (!firstMon) return false;
  const value = (mon: TrainerMon) => (diff.field === 'item' ? String(mon.item) : [...mon.moves].sort((a, b) => a - b).join(' '));
  return value(monOf(diff, ctx).mon) !== value(firstMon);
}

const names = (value: unknown) => (Array.isArray(value) ? value.map((name) => normaliseName(String(name))) : []);
/** The one move each side has that the other lacks, or null if the movesets differ in more than one. */
function swappedMove(diff: Diff): [string, string] | null {
  const rom = names(diff.rom);
  const docs = names(diff.docs);
  const romOnly = (diff.rom as string[]).filter((_, i) => !docs.includes(rom[i]!));
  const docsOnly = (diff.docs as string[]).filter((_, i) => !rom.includes(docs[i]!));
  return romOnly.length === 1 && docsOnly.length === 1 ? [romOnly[0]!, docsOnly[0]!] : null;
}

export const SECTIONS: Section[] = [
  { id: 'species', area: 'species', heading: 'Species (Personal tab)', intro: 'Base stats, types, abilities and growth rate of each species. The game uses the ROM\'s values.' },
  { id: 'learnsets', area: 'learnset', heading: 'Learnsets (Level-Up Learnsets tab)', intro: '' },
  { id: 'moves', area: 'move', heading: 'Moves (Moves tab)', intro: 'Power, type, accuracy, PP, priority, category and effect chance; effects are not compared, as the docs warn the game file shows some wrongly on purpose.' },
  { id: 'levels', area: 'trainer', heading: 'Trainer levels', intro: '' },
  { id: 'forms', area: 'trainer', heading: 'Trainer species and forms', intro: 'Compared as one resolved species-and-form name. The docs write the bare species name where the ROM sets a form.' },
  { id: 'abilities', area: 'trainer', heading: 'Trainer abilities', intro: 'Every difference here is disputed and the planner uses the ROM\'s ability until an in-game spot check settles it.' },
  { id: 'items', area: 'trainer', heading: 'Trainer items', intro: 'The planner uses the ROM\'s items.' },
  { id: 'trainerMoves', area: 'trainer', heading: 'Trainer moves', intro: 'Moves are compared by ID. The planner uses the ROM\'s moves and their order.' },
  {
    id: 'natures', area: 'trainer', heading: 'Trainer natures (cross-check)',
    intro: [
      'A trainer Pokémon\'s nature comes from the ROM\'s plain Gen 4 rule (a PID from the trainer\'s index and class and the Pokémon\'s IVs, level and species) wherever the decoder knows it, that is where `natureKnown` holds: no gender or ability override earlier in the party. The docs\' nature is used only where it does not. Every difference below is a disputed value: the planner uses the ROM\'s, and in-game spot checks will settle it.',
      '',
      '{knownNatures} matched Pokémon have a known ROM nature. A rival\'s docs nature "X/Y" (Trainer Dawn/Lucas) means X for the Dawn copy and Y for the Lucas copy; read that way, every rival nature agrees. Two docs cells are not natures at all: "Mantine" (Sailor Cesar\'s Mantine, ROM 279) and "Lonely0" (Galactic Prospero\'s Alakazam, ROM 526). Both Pokémon have a known ROM nature, so the planner never reads those cells.',
    ].join('\n'),
  },
  {
    id: 'pkcalc-join', area: 'pkcalc-join', heading: 'PKCalc: matched trainers that join no PKCalc trainer',
    intro: 'Pinned with the ROM party against null (field `key`), so a trainer PKCalc adds later fails the test until it is recorded.',
  },
  {
    id: 'pkcalc-sets', area: 'pkcalc-sets', heading: 'PKCalc: trainer sets',
    intro: 'Level, ability, item, moves (by ID, through PKCalc\'s own move table, so "Feint Attack" is the docs\' "Faint Attack") and nature of each ROM Pokémon against the PKCalc set of its species. The nature compared is the one the planner uses: the ROM\'s where it is known (`nature`), the docs\' where it is not (`nature-from-docs`).',
  },
  {
    id: 'calc', area: 'calc', heading: 'PKCalc: damage rolls',
    intro: [
      '`test/real/calcVsPkcalc.test.ts` runs our damage calc and PKCalc\'s own (its fork of the Smogon calc, in its page in headless Chromium, offline once loaded) on identical inputs: species, level, gender, nature, IVs, EVs, item, ability, move and field, with our base stats, types and move numbers passed as overrides, as PKCalc\'s page does from its editable fields (`src/check/pkcalcCalc.ts`). Each calc compares the 16 rolls of one hit (a multi-hit move\'s first), normal (field `rolls`) and as a critical hit (`crit-rolls`).',
      '',
      'The grid: 3 opponents in each of the 10 splits (the first, the first double battle or else the middle one, and the last), every Pokémon of each against 3 profiles of the player\'s party on 2026-11-08 (Monferno, Delibird, Phanpy) at the split\'s level cap, both ways, with each attacker\'s first 2 damaging moves (Psywave left out). That is {calcCases} calcs and {calcRolls} roll comparisons over {calcMons} trainer Pokémon of {calcTrainers} trainers and {calcMoves} moves; {calcDamaging} comparisons deal damage on our side. {calcSame} agree exactly.',
      '',
      'Keys read `Split: Trainer [ROM index] mon N (species) Move vs. Profile Llevel` for the trainer\'s move and `… mon N (species) hit by Profile Llevel Move` for the profile\'s; ours is the `rom` side. A field suffix names a cause that `diffCalc` shows by giving PKCalc our choice and getting our rolls back. Two mechanical differences were our bugs, fixed with a failing test first, and are not listed: the hack\'s Plates boost 1.5x (the docs\' Items tab gives them power 50, vanilla 20), and the Explosion effect halves only physical Defense, so the special Memento hits full Special Defense. A third fix changed Fling: its power is the held item\'s fling power in the ROM\'s item data, as the game reads it. Before, an item `@pkmn/dex` knew no fling power for read as 0 damage, and then as a 130-power worst case, which the ROM\'s Nugget (250) and Bicycle (150) exceed.',
    ].join('\n'),
  },
];

export const GROUPS: DiscrepancyGroup[] = [
  {
    id: 'fearow', section: 'species', title: 'Fearow\'s Sp. Atk, a docs typo', layout: 'rows', fields: ['spa'],
    matches: (diff) => diff.key === 'Fearow',
    text: 'The docs\' own BST (472) only adds up with the ROM\'s 61.',
  },
  {
    id: 'cat-growth', section: 'species', title: 'Growth rates of the cat Pokémon', layout: 'rows', fields: ['growthRate'],
    matches: (diff) => CATS.has(diff.key),
    text: 'The ROM gives all six cat Pokémon the Erratic rate; the docs still show the vanilla rate. The game uses the ROM\'s rate, and so does the save reader when it works out a boxed Pokémon\'s level from its experience.',
  },
  {
    id: 'learnsets', section: 'learnsets', title: 'Level-up learnsets', layout: 'learnsets', fields: ['moves'],
    text: 'Each difference holds both whole learnsets in the JSON; the table says what differs. {sameLearnsets} of {allLearnsets} learnsets agree exactly, so the decoder is sound: these look like late edits the docs never got, plus a few docs slips. The game uses the ROM\'s learnsets.',
  },
  {
    id: 'move-data', section: 'moves', title: 'Move data', layout: 'rows',
    fields: ['power', 'type', 'accuracy', 'pp', 'priority', 'category', 'effectChance'], matches: (diff) => DIFFERING_MOVES.has(diff.key),
    text: 'The docs\' Moves tab (and its Move Changes tab, where it covers these moves) gives the docs\' values; the ROM\'s move file holds the others. It is not a decoder slip: the other {sameMoves} moves agree on every field. The docs warn that some moves exported from the game deliberately show the wrong effect, and that may extend to these numbers; the files cannot tell. The spec has the docs win for move behaviour in the battle engine, while the trainer AI scores with what the ROM holds. An in-game spot check should confirm the odd ones, above all Constrict (255 power, Psychic, priority -1 in the ROM) and the PP values (Swords Dance has 2 PP in the ROM).',
  },
  {
    id: 'levels', section: 'levels', title: 'Levels on level-mismatch matches', layout: 'levels', fields: ['level'],
    matches: (diff, ctx) => matchOf(diff, ctx).levelMismatch === true,
    text: 'These docs trainers fit a ROM trainer on species and forms but not on levels, so they were matched without levels. The game uses the ROM\'s levels. Most are late-game Galactic and Elite Four Split trainers, one to ten levels apart: the docs predate a level rebalance, as their natures confirm (see the natures).',
  },
  {
    id: 'cosmetic-forms', section: 'forms', title: 'Forms that change nothing for the planner', layout: 'rows', fields: ['species'],
    matches: (diff) => /^(Shellos|Gastrodon|Castform|Unown)-/.test(String(diff.rom)),
    text: 'Shellos and Gastrodon East (looks only), Castform Rainy (a weather form) and Unown letters.',
  },
  {
    id: 'rotom-wash', section: 'forms', title: 'Worker Conrad\'s Rotom-Wash', layout: 'rows', fields: ['species'],
    matches: (diff) => diff.rom === 'Rotom-Wash',
    text: 'Rotom-Wash is form 2, with its own Personal row (504). In this hack\'s Personal tab it has the same types (Electric/Ghost) and base stats as Rotom. The planner uses the ROM\'s form.',
  },
  {
    id: 'ability-slips', section: 'abilities', title: 'Docs slips', layout: 'rows', fields: ['ability'],
    matches: (diff) => diff.docs === '' || diff.docs === 'Syncronize' || (diff.rom === 'Serene Grace' && diff.docs === 'Natural Cure'),
    text: 'Cyrus\'s Giratina-Origin has a blank ability in the docs; its own Personal row (501) gives Levitate. Dragon Tamer Clinton\'s Espeon has the typo "Syncronize". Champion Cynthia\'s Shaymin-Sky gets the Land Forme\'s Natural Cure; the Sky Forme row (502) has Serene Grace only.',
  },
  {
    id: 'ability-override', section: 'abilities', title: 'Ability overrides the docs contradict', layout: 'rows', fields: ['ability'],
    matches: (diff, ctx) => monOf(diff, ctx).mon.abilityOverride !== 0,
    text: 'The ROM\'s override byte (1 for the first ability, 2 for the second) sets these abilities, and all three are Garchomps on which the docs give the other one. The mapping itself is confirmed: over the {overrides} overridden Pokémon on matched trainers it gives the docs\' ability for {overridesAgree}, against {overridesFlipped} with 1 and 2 swapped. Counting only the {overridesChoice} whose species has two different abilities, that is {overridesChoiceAgree} against {overridesChoiceFlipped}. Garchomp\'s abilities are the same in the docs\' Personal tab and the ROM (Sand Veil, then Rough Skin), so that is not the cause. The docs may be out of date for these fights; Commander Mars\'s Galactic Split fight is a level-mismatch match.',
  },
  {
    id: 'ability-plain-pid', section: 'abilities', title: 'Second abilities in the docs where the plain rule gives the first', layout: 'rows', fields: ['ability'],
    matches: (diff, ctx) => monOf(diff, ctx).mon.natureKnown,
    text: 'No override and a known nature, so the ROM\'s ability comes from the plain-rule PID. That PID is always even, so it always picks the first ability; the docs give the second.',
  },
  {
    id: 'ability-cross-check', section: 'abilities', title: 'Abilities picked by an untrusted PID', layout: 'rows', fields: ['ability-cross-check'],
    text: 'No override and two abilities to choose from, so the PID\'s lowest bit picks one, but these Pokémon\'s PIDs are untrusted (`natureKnown` is false: an override comes earlier in the party). The ROM side is the plain-rule pick, the first ability. Pinned under the field `ability-cross-check`, like the natures.',
  },
  {
    id: 'item-unnamed', section: 'items', title: 'Items with no name yet', layout: 'rows', fields: ['item'],
    matches: (diff) => /^\(item \d+\)$/.test(String(diff.rom)),
    text: 'The ROM\'s item ID is fine, but `@pkmn/dex` names only Gen 4 battle items, so these print as "(item N)" until a Gen 4 item table is added. Items 70 and 71 are the hack\'s Berserk Gene and RageCandyBar, which do matter in battle. Galactic Triton\'s "Beserk Gene" is also a docs typo.',
  },
  {
    id: 'item-spelling', section: 'items', title: 'Docs spellings of items', layout: 'rows', fields: ['item'],
    matches: (diff) => ITEM_SPELLINGS.has(String(diff.docs)),
    text: 'The same item: "Leek" is the Gen 8 name for Stick, and "Lax Inscence" and "Jacoba Berry" are typos.',
  },
  {
    id: 'item-second-copy', section: 'items', title: 'Items on second ROM copies of a team', layout: 'rows', fields: ['item'],
    matches: copiesDiffer,
    text: 'Each Pokémon here is on a further ROM trainer with a docs trainer\'s exact party, and holds another item than the first copy\'s Pokémon in the same slot. The docs list one team for both copies, so they can agree with only one. The planner uses each copy\'s own item.',
  },
  {
    id: 'item-john-keating', section: 'items', title: 'Gambler John Keating\'s last three Pokémon: items', layout: 'rows', fields: ['item'],
    matches: (diff) => JOHN_KEATING_LAST_THREE.test(diff.key),
    text: 'The docs give his Staraptor, Kingler and Magmortar (Pokémon 4 to 6) other items than the ROM, and other moves too (see the trainer moves); his first three Pokémon agree with the docs. PKCalc has the ROM\'s items and moves for all three, which points to the docs being out of date for this team. The planner uses the ROM\'s.',
  },
  {
    id: 'item-real', section: 'items', title: 'Different items, cause unknown', layout: 'rows', fields: ['item'],
    text: 'A real difference between the ROM and the docs that no group above explains, with no known cause. The planner uses the ROM\'s item; each is a candidate for an in-game spot check.',
  },
  {
    id: 'solarbeam', section: 'trainerMoves', title: 'SolarBeam or Solar-Beam', layout: 'rows', fields: ['moves'],
    matches: (diff) => (diff.rom as string[]).includes('SolarBeam') && (diff.docs as string[]).includes('Solar-Beam'),
    text: 'The hack has two moves: SolarBeam (76, with a charging turn) and Solar-Beam (130, no charge, 15 PP). The docs\' team tabs write "Solar-Beam" for both: of the docs\' "Solar-Beam" Pokémon, {solarBeam130} have move 130 in the ROM and {solarBeam76} have move 76. In battle that is a charging turn or none.',
  },
  {
    id: 'move-spelling', section: 'trainerMoves', title: 'Docs spellings of moves', layout: 'rows', fields: ['moves'],
    matches: (diff) => {
      const swapped = swappedMove(diff);
      return swapped !== null && MOVE_SPELLINGS.some(([rom, docs]) => rom === swapped[0] && docs === swapped[1]);
    },
    text: 'The same move under another name: "HP Dark" for Hidden Power (trainer IVs of 31 make it Dark-type), "SmellingSalts", "Weather Ball Fire" for the hack\'s Fire Ball, "Accelerock" for the hack\'s Rollout (a 40-power Rock move with +1 priority), "Weather Ball" for Hail Ball, and "Water Ball" for Castform\'s Weather Ball.',
  },
  {
    id: 'moves-second-copy', section: 'trainerMoves', title: 'Moves on second ROM copies of a team', layout: 'rows', fields: ['moves'],
    matches: copiesDiffer,
    text: 'Each Pokémon here is on a further ROM trainer with a docs trainer\'s exact party, and has other moves than the first copy\'s Pokémon in the same slot, not just another order. The docs list one team for both copies, so they can agree with only one. The planner uses each copy\'s own moves.',
  },
  {
    id: 'moves-john-keating', section: 'trainerMoves', title: 'Gambler John Keating\'s last three Pokémon: moves', layout: 'rows', fields: ['moves'],
    matches: (diff) => JOHN_KEATING_LAST_THREE.test(diff.key),
    text: 'His Staraptor, Kingler and Magmortar (Pokémon 4 to 6) have moves the docs do not list, and their items differ too (see the trainer items); his first three Pokémon agree with the docs. PKCalc has the ROM\'s moves and items for all three, which points to the docs being out of date for this team. The planner uses the ROM\'s.',
  },
  {
    id: 'moves-real', section: 'trainerMoves', title: 'Different moves, cause unknown', layout: 'rows', fields: ['moves'],
    text: 'A real difference between the ROM and the docs that no group above explains, with no known cause. The planner uses the ROM\'s moves; each is a candidate for an in-game spot check.',
  },
  {
    id: 'move-order', section: 'trainerMoves', title: 'Same moves in another order', layout: 'monList', fields: ['move-order'],
    text: 'The ROM holds the same moves as the docs, in other slots (field `move-order`). Mostly Elite Four Split trainers.',
  },
  {
    id: 'nature-level', section: 'natures', title: 'Natures on level-mismatch matches', layout: 'natureCounts', fields: ['nature-cross-check'],
    matches: (diff, ctx) => matchOf(diff, ctx).levelMismatch === true,
    text: 'Here the docs\' natures are what the plain rule gives at the docs\' own levels: {lmAtDocs} of the {lmKnown} known natures fit that way, against {lmAtRom} at the ROM\'s levels. So the docs\' natures predate these trainers\' level changes, and the docs\' exporter itself used the plain rule.',
  },
  {
    id: 'nature-shared', section: 'natures', title: 'Natures on second ROM copies', layout: 'natureCounts', fields: ['nature-cross-check'],
    matches: (diff, ctx) => matchOf(diff, ctx).shared === true,
    text: 'A further ROM trainer with a docs trainer\'s party has another trainer index, so another PID; the docs give one nature for both.',
  },
  {
    id: 'nature-galactic', section: 'natures', title: 'Natures of Team Galactic', layout: 'natureCounts', fields: ['nature-cross-check'],
    matches: (diff, ctx) => GALACTIC_CLASSES.has(monOf(diff, ctx).trainer.trainerClass),
    text: 'Nearly every Galactic grunt, Squad member and Commander differs on every Pokémon. A search over other trainer indexes and classes found no rule that reproduces the docs\' natures.',
  },
  {
    id: 'nature-other', section: 'natures', title: 'Other natures', layout: 'natureCounts', fields: ['nature-cross-check'],
    text: 'Pokémon of other trainers, mostly one or two per trainer.',
  },
  {
    id: 'pkcalc-school-kids', section: 'pkcalc-join', title: 'School Kids', layout: 'rows', fields: ['key'],
    matches: (diff) => diff.key.includes('School Kid'),
    text: 'PKCalc lists no School Kid trainers at all.',
  },
  {
    id: 'pkcalc-jeffrey', section: 'pkcalc-join', title: 'The Ranger the docs call Jeffrey twice', layout: 'rows', fields: ['key'],
    matches: (diff) => diff.key.includes('Pkmn Ranger Jeffrey'),
    text: 'The docs name both of the Galactic Split\'s one-Pokémon Rangers Jeffrey. PKCalc calls this one (Primeape) Pokémon Ranger Allison and the other (Arcanine) Jeffrey, so the docs\' name finds only the other\'s key, which his party fits.',
  },
  {
    id: 'pkcalc-copy-natures', section: 'pkcalc-sets', title: 'Natures on second ROM copies of a team', layout: 'rows', fields: ['nature-other-copy'],
    text: 'PKCalc has one set per trainer key, and both ROM copies of a docs trainer\'s team join that key. Another trainer index means another plain-rule PID, so the copies\' natures differ. Each nature here is on the copy whose nature PKCalc does not list: the other copy has PKCalc\'s nature (field `nature-other-copy`, checked by `diffPkcalc`). For Galactic Mercury\'s first fight PKCalc lists the shared copy, ROM 296, rather than ROM 211. Every other Pokémon whose ROM nature is known has PKCalc\'s nature (a difference without a copy to explain it has no group), which supports the plain rule.',
  },
  {
    id: 'pkcalc-copy-flint-move', section: 'pkcalc-sets', title: 'Elite Four Flint\'s second copy: SolarBeam for Solar-Beam', layout: 'rows', fields: ['moves-other-copy'],
    matches: (diff) => diff.key.includes('Elite Four Flint [ROM 874]'),
    text: 'A real difference between the ROM\'s two copies of Flint\'s team, not a spelling. ROM 874 gives Exeggutor SolarBeam (move 76, with a charging turn) where the first copy, ROM 868, and PKCalc have Solar-Beam (move 130, no charging turn). The docs write "Solar-Beam" for both moves.',
  },
  {
    id: 'pkcalc-copy-flint-item', section: 'pkcalc-sets', title: 'Elite Four Flint\'s second copy: Life Orb for Charcoal', layout: 'rows', fields: ['item-other-copy'],
    matches: (diff) => diff.key.includes('Elite Four Flint [ROM 874]'),
    text: 'ROM 874\'s Magmortar holds Life Orb where the first copy, ROM 868, and PKCalc have Charcoal; the docs agree with ROM 868 too (see the trainer items above).',
  },
  {
    id: 'pkcalc-form-abilities', section: 'pkcalc-sets', title: 'Abilities of Shaymin-Sky and Giratina-Origin', layout: 'rows', fields: ['ability'],
    matches: (diff) => /\((Shaymin-Sky|Giratina-Origin)\)$/.test(diff.key),
    text: 'PKCalc gives these forms their base forms\' abilities (Natural Cure, Pressure), as the docs do for Shaymin-Sky. The ROM gives each form\'s own Personal row (502, 501): Serene Grace and Levitate, which is what the game uses.',
  },
  {
    id: 'pkcalc-ability-cross-check', section: 'pkcalc-sets', title: 'Abilities picked by an untrusted PID, against PKCalc', layout: 'rows', fields: ['ability-cross-check'],
    text: 'Pokémon from the docs\' list of these above, where PKCalc gives the docs\' ability: the PID\'s lowest bit picks it, and these PIDs are untrusted (`natureKnown` is false).',
  },
  {
    id: 'calc-fling-power', section: 'calc', title: 'Fling: PKCalc\'s fling power for the held item differs from the ROM\'s', layout: 'rows', columns: ['Ours', 'PKCalc'],
    fields: ['rolls-fling-power', 'crit-rolls-fling-power'],
    text: 'Fling\'s power is its held item\'s fling power, which the game reads from its item data (`Battler_ItemFlingPower`: byte 6 of the item\'s entry in `pl_item_data.narc`). Ours reads the same bytes from the ROM, so the cause of any difference here is PKCalc\'s data: PKCalc gives our rolls once its Fling is a plain hit of the ROM\'s power (suffix `-fling-power`), so its own fling power for the item is not the ROM\'s. PKCalc\'s items do not always follow the ROM: it calls item 92, the hack\'s Nugget (250 in the ROM, 200 in the docs\' Items tab), "Big Nugget".',
  },
  {
    id: 'calc-unmodelled', section: 'calc', title: 'Moves our calc reports as unmodelled', layout: 'rows', columns: ['Ours', 'PKCalc'],
    fields: ['rolls-unmodelled', 'crit-rolls-unmodelled'],
    text: 'Our move\'s `unmodelled` names an effect on damage that our numbers leave out (src/battle/effectMap.ts), and the planner reports it with the result, so PKCalc may well model it differently. PKCalc gives our rolls once it runs the base move our calc runs in place of the move\'s own, so the difference is exactly that effect. A difference on such a move that this does not show is labelled `-unexplained`, which no group accepts.',
  },
  {
    id: 'calc-ohko', section: 'calc', title: 'OHKO moves: ours deal the target\'s HP when they hit', layout: 'rows', columns: ['Ours', 'PKCalc'],
    fields: ['rolls-ohko', 'crit-rolls-ohko'],
    text: 'When an OHKO move hits, the cartridge sets the damage to the target\'s current HP (`BtlCmd_TryOHKOMove`, pokeplatinum src/battle/battle_script.c:4334-4383), so our rolls are the target\'s HP and the KO chance is conditional on the hit, 1 or 0 for each of its entries, with accuracy only in `hitChance`. PKCalc runs the move on its power-1 numbers. The suffix `-ohko` goes only to an OHKO move whose 16 rolls are all exactly the target\'s HP; one that cannot land (Sturdy, a type immunity) deals 0 and gets no such label.',
  },
  {
    id: 'calc-punch-sound', section: 'calc', title: 'The cartridge\'s punch and sound tables', layout: 'rows', columns: ['Ours', 'PKCalc'],
    fields: ['rolls-punch-sound', 'crit-rolls-punch-sound'],
    text: 'Iron Fist and Soundproof go by the cartridge\'s move-ID tables (`moveFlags`), so a hack move in a punch or sound move\'s ID slot counts as one; PKCalc goes by its move names. PKCalc gives our rolls once given our flags.',
  },
  {
    id: 'calc-target', section: 'calc', title: 'Move targets from the ROM', layout: 'rows', columns: ['Ours', 'PKCalc'],
    fields: ['rolls-target', 'crit-rolls-target'],
    text: 'In a double battle a move that hits both foes or every adjacent Pokémon deals 3/4 damage. Our targets are the ROM\'s; PKCalc\'s are its move data\'s. PKCalc gives our rolls once given our target.',
  },
  {
    id: 'calc-hidden-power', section: 'calc', title: 'Hidden Power from the IVs', layout: 'rows', columns: ['Ours', 'PKCalc'],
    fields: ['rolls-hidden-power', 'crit-rolls-hidden-power'],
    text: 'Our Hidden Power takes its type and power from the attacker\'s IVs by the Gen 4 formula (`hiddenPower`); PKCalc works them out its own way. PKCalc gives our rolls once given our type and power.',
  },
  {
    id: 'pkcalc-nature-from-docs', section: 'pkcalc-sets', title: 'Natures the ROM cannot give: the docs\' against PKCalc\'s', layout: 'rows', fields: ['nature-from-docs'],
    columns: ['Docs (used)', 'PKCalc'],
    text: 'Where `natureKnown` is false (an override earlier in the party), the planner takes the docs\' nature. PKCalc agrees with the docs on {nfdAgree} of these {nfdAll} Pokémon: {nfdOtherAgree} of {nfdOther} on exact and shared matches, but only {nfdLmAgree} of {nfdLm} on level-mismatch matches, where the docs\' natures are stale. Of the {nfdDiffer} that differ, PKCalc\'s nature is the plain-rule one on {nfdPlain}. Where PKCalc gets these natures is unknown; it may know the hack\'s rule for overridden parties. Disputed, like the docs\' natures: in-game spot checks will settle them.',
  },
];

/** Why each docs-only trainer matched no ROM trainer, by a pattern on "Split: Name". */
export const DOCS_ONLY_REASONS: [RegExp, string][] = [
  [/Maid Yoki/, 'No ROM trainer has her party (six Pokémon at level 67).'],
  [/Byron Split: Pkmn Ranger/, 'The Byron Split lists these one-Pokémon Rangers again; their ROM trainers went to the Galactic Split\'s copies.'],
  [/Ace Trainer Blake/, 'The docs list a Porygon; the ROM trainer has Porygon2.'],
  [/Rosalind|Puck/, 'Listed twice in the docs; the second listing (with level 1 placeholder Pokémon) has no ROM trainer left.'],
  [/Laomedeia/, 'The docs list 3 Pokémon; the ROM trainer has 4.'],
];

/** The group a difference belongs to. Throws for one no group explains, so an unexplained difference cannot be recorded. */
export function groupOf(diff: Diff, ctx: GroupContext): DiscrepancyGroup {
  const group = GROUPS.find((candidate) => {
    const section = SECTIONS.find((s) => s.id === candidate.section)!;
    return section.area === diff.area && candidate.fields.includes(diff.field) && (candidate.matches?.(diff, ctx) ?? true);
  });
  if (!group) throw new Error(`No discrepancy group explains ${diff.area}/${diff.key}/${diff.field}`);
  return group;
}
