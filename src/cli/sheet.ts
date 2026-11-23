// `npm run sheet -- --save <path> --trainer <id or search text> [--cap N] [--variant N] [--hp full|save]`: prints the
// matchup sheet of the save's eligible Pokémon against one trainer. For each trainer Pokémon and each team member: who
// moves first, then every move both ways with its damage range, KO chance and hit chance, then notes. The team starts
// at full HP unless `--hp save` asks for the save's. It needs the data `npm run extract` saves in `data/`.

import { parseArgs } from 'node:util';
import { buildCatalog } from '../battle/catalog.js';
import { buildMoves } from '../battle/moves.js';
import { eligibleTeam, type PlayerMon } from '../battle/playerMon.js';
import type { BattleMon, ResolvedTrainer, TrainerCatalog } from '../battle/types.js';
import { abilityName, itemName } from '../calc/battler.js';
import type { CalcField } from '../calc/field.js';
import { type NatureAlternatives, natureAlternatives } from '../data/load.js';
import { normaliseName } from '../names/normalise.js';
import { NATURES } from '../rom/natures.js';
import { calcHp } from '../rom/stats.js';
import { DEFAULT_GRAVEYARD_BOXES } from '../save/readSave.js';
import { buildSheet, type Sheet, type SheetPair, type StartingHp } from '../sheet/sheet.js';
import { fail, loadData, loadSave, MAX_LEVEL, parseCap, statusCode } from './common.js';
import { moveLine } from './sheetText.js';

const USAGE = 'Usage: npm run sheet -- --save <path> --trainer <id or search text> [--cap N] [--variant N] [--hp full|save]';

/** How many trainers an error line lists. */
const LISTED = 5;

interface Args { save: string; trainer: string; cap: number | undefined; variant: number; hp: StartingHp }

/** The arguments. Bad ones print one line with the usage. */
function cliArgs(): Args {
  let values: { save?: string; trainer?: string; cap?: string; variant?: string; hp?: string } = {};
  try {
    values = parseArgs({
      options: {
        save: { type: 'string' }, trainer: { type: 'string' }, cap: { type: 'string' }, variant: { type: 'string' }, hp: { type: 'string' },
      },
    }).values;
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}. ${USAGE}`);
  }
  const save = values.save ?? fail(USAGE);
  const trainer = values.trainer ?? fail(USAGE);
  if (values.variant !== undefined && !/^\d+$/.test(values.variant)) fail(`--variant must be a whole number from 0. ${USAGE}`);
  const hp = values.hp ?? 'full';
  if (hp !== 'full' && hp !== 'save') fail(`--hp must be full or save. ${USAGE}`);
  return {
    save, trainer, cap: values.cap === undefined ? undefined : parseCap(values.cap, USAGE), variant: Number(values.variant ?? 0), hp,
  };
}

/** The edit distance between two strings: the fewest single-character insertions, deletions and substitutions. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row.push(Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    previous = row;
  }
  return previous[b.length]!;
}

/**
 * The trainers closest to `text`: the most of its words found in their name, split or location first, then the
 * smallest edit distance from the text to their name (both normalised), then docs order.
 */
function closestTrainers(catalog: TrainerCatalog, text: string): ResolvedTrainer[] {
  const words = text.split(/\s+/).map(normaliseName).filter(Boolean);
  const query = normaliseName(text);
  const scored = catalog.trainers.map((trainer, place) => {
    const fields = [trainer.name, trainer.split, trainer.location].map(normaliseName);
    const found = words.filter((word) => fields.some((field) => field.includes(word))).length;
    return { trainer, place, found, distance: editDistance(query, normaliseName(trainer.name)) };
  });
  scored.sort((a, b) => b.found - a.found || a.distance - b.distance || a.place - b.place);
  return scored.slice(0, LISTED).map((entry) => entry.trainer);
}

const trainerList = (trainers: ResolvedTrainer[]) => trainers.map((trainer) => `${trainer.name} (${trainer.id})`).join(', ');

/** The one trainer `text` names (an ID or search words), or one line and exit 1 for none or several. */
function findTrainer(catalog: TrainerCatalog, text: string): ResolvedTrainer {
  const found = catalog.search(text);
  if (found.length === 1) return found[0]!;
  if (found.length === 0) fail(`No trainer matches "${text}". Closest: ${trainerList(closestTrainers(catalog, text))}`);
  const more = found.length > LISTED ? `, and ${found.length - LISTED} more` : '';
  return fail(`"${text}" matches ${found.length} trainers: ${trainerList(found.slice(0, LISTED))}${more}. Pass one ID with --trainer`);
}

/** Copy `variant` of the trainer: 0 is the copy the catalog picked, k ≥ 1 is `variants[k - 1]`. */
function pickVariant(trainer: ResolvedTrainer, variant: number): ResolvedTrainer {
  const copies = [trainer, ...trainer.variants];
  const copy = copies[variant];
  if (copy === undefined) fail(`--variant must be from 0 to ${copies.length - 1}: ${trainer.name} has ${copies.length} ROM ${copies.length === 1 ? 'copy' : 'copies'}. ${USAGE}`);
  return copy;
}

// ---------------------------------------------------------------------------------------------------------------------
// Printing.

const maxHp = (mon: BattleMon) => calcHp(mon.baseStats.hp, mon.ivs.hp, mon.evs.hp, mon.level);
const playerLabel = (mon: PlayerMon) => `${mon.nickname} (${mon.name})`;

/** "Mon moves first (Spe 32 vs 12)", and so on for each order, of the pair or one of its weather cases. */
function orderText(pair: SheetPair, of: Pick<SheetPair, 'order' | 'playerSpeed' | 'enemySpeed'> = pair): string {
  const who = {
    player: `${pair.player.nickname} moves first`, enemy: `${pair.enemy.name} moves first`, tie: 'speed tie, 50% each',
    depends: 'either may move first (see the notes)',
  }[of.order];
  return `${who} (Spe ${of.playerSpeed} vs ${of.enemySpeed})`;
}

/** Both sides' move lines, indented by `indent`. */
function printMoves(pair: SheetPair, of: Pick<SheetPair, 'playerMoves' | 'enemyMoves'>, indent: string): void {
  console.log(`${indent}${pair.player.nickname}'s moves:`);
  for (const cell of of.playerMoves) console.log(`${indent}  ${moveLine(cell)}`);
  console.log(`${indent}${pair.enemy.name}'s moves:`);
  for (const cell of of.enemyMoves) console.log(`${indent}  ${moveLine(cell)}`);
}

function fieldText(field: CalcField): string {
  const parts = [
    field.weather, field.fog && 'fog', field.trickRoom && 'Trick Room', field.gravity && 'Gravity', field.reflect && 'Reflect',
    field.lightScreen && 'Light Screen', field.doubles && 'doubles',
  ].filter((part): part is string => typeof part === 'string');
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/** `Zigzagoon Lv 5  Hasty  Gluttony  @Silk Scarf  HP 20`; a nature no source gives reads "nature unknown". */
function enemyLine(mon: BattleMon): string {
  const nature = mon.nature.value === null ? 'nature unknown' : NATURES[mon.nature.value]!;
  return [`${mon.name} Lv ${mon.level}`, nature, abilityName(mon), mon.item === 0 ? '' : `@${itemName(mon.item)}`, `HP ${maxHp(mon)}`]
    .filter(Boolean).join('  ');
}

/**
 * `Mon (Monferno) Lv 15 HP 44/44 PAR`: the HP the sheet starts it on, and the save's after it when that differs
 * (`HP 44/44 (save 10/44)`).
 */
function teamEntry(mon: PlayerMon, hp: StartingHp): string {
  const max = maxHp(mon);
  const used = hp === 'full' ? max : mon.currentHp;
  const hpText = used === mon.currentHp ? `HP ${used}/${max}` : `HP ${used}/${max} (save ${mon.currentHp}/${max})`;
  return [`${playerLabel(mon)} Lv ${mon.level}`, hpText, statusCode(mon.status)].filter(Boolean).join(' ');
}

function printSheet(sheet: Sheet, team: PlayerMon[], cap: number | undefined, natures: NatureAlternatives): void {
  const { trainer } = sheet;
  console.log(`${trainer.name} (${trainer.id}): ${trainer.split}, ${trainer.location}, ${trainer.battleType} battle, ROM trainer ${trainer.romIndex}`);
  if (trainer.variants.length > 0) {
    console.log(`Copies: ${[trainer, ...trainer.variants].map((copy, k) => `${k} = ROM trainer ${copy.romIndex}`).join(', ')} (pick one with --variant N)`);
  }
  console.log(`Field: ${fieldText(sheet.field)}`);
  console.log(sheet.hp === 'full' ? 'Starting HP: full, as planning assumes (--hp save for the save\'s)' : 'Starting HP: the save\'s (--hp save)');
  console.log(`Nature alternatives: ${natures === 'pkcalc' ? 'PKCalc' : 'all (no PKCalc data)'}`);
  console.log(`Team (${cap === undefined ? 'no level cap: pass --cap N' : `level cap ${cap}`}): ${team.map((mon) => teamEntry(mon, sheet.hp)).join(', ')}`);
  const notes = [...sheet.notes, ...team.flatMap((mon) => mon.notes.map((note) => `${playerLabel(mon)}: ${note}`))];
  for (const note of notes) console.log(`Note: ${note}`);
  let enemy: SheetPair['enemy'] | undefined;
  for (const pair of sheet.pairs) {
    if (pair.enemy !== enemy) {
      enemy = pair.enemy;
      console.log('');
      console.log(enemyLine(enemy));
    }
    console.log(`  ${playerLabel(pair.player)} Lv ${pair.player.level} vs ${pair.enemy.name} Lv ${pair.enemy.level}: ${orderText(pair)}`);
    if (pair.weatherCases !== undefined) {
      console.log(`    Weather: not settled (see the notes); each move is the worse case of ${pair.weatherCases.length} for ${pair.player.nickname}`);
    } else if (pair.field?.weather !== sheet.field.weather) {
      console.log(`    Weather: ${pair.field?.weather ?? 'none'} (a weather-setting ability)`);
    }
    if (pair.weatherMayPersist) console.log('    Weather may persist: another Pokémon in this battle can set weather, not counted here');
    printMoves(pair, pair, '    ');
    for (const weatherCase of pair.weatherCases ?? []) {
      console.log(`    If ${weatherCase.when} (${weatherCase.field.weather ?? 'no weather'}): ${orderText(pair, weatherCase)}`);
      printMoves(pair, weatherCase, '      ');
    }
    for (const note of pair.notes) console.log(`    Note: ${note}`);
  }
}

/**
 * `run()`, or one line ("Cannot <what>: <message>") and exit 1 when it throws, never a stack trace: building the
 * catalog, the move table or the sheet throws for data the code does not expect.
 */
function attempt<T>(what: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    return fail(`Cannot ${what}: ${(error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, ' ')}`);
  }
}

const args = cliArgs();
const data = loadData();
const save = loadSave(args.save, data);
const trainer = pickVariant(findTrainer(attempt('build the trainer catalog', () => buildCatalog(data)), args.trainer), args.variant);
const team = attempt(`read the team from ${args.save}`, () => eligibleTeam(save, data, { graveyardBoxes: DEFAULT_GRAVEYARD_BOXES, levelCap: args.cap ?? MAX_LEVEL }));
if (team.length === 0) fail(`No eligible Pokémon in ${args.save}${args.cap === undefined ? '' : ` at level cap ${args.cap}`}`);
const moves = attempt('build the move table', () => buildMoves(data));
printSheet(attempt('build the sheet', () => buildSheet(team, trainer, { moves, hp: args.hp })), team, args.cap, natureAlternatives(data));
