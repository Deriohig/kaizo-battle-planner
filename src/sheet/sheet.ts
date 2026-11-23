// The matchup sheet: for each trainer Pokémon against each of the player's, every move's damage and hit chance both
// ways, who moves first, and what a reader should know. The solver later uses its numbers as bounds.

import type { KaizoMove } from '../battle/moves.js';
import type { PlayerMon } from '../battle/playerMon.js';
import type { BattleMon, ResolvedMon, ResolvedTrainer } from '../battle/types.js';
import { hitChance } from '../calc/accuracy.js';
import { abilityName, abilityNameById, heldEffect, itemEffect, itemName, sideStatus, weatherSuppressed } from '../calc/battler.js';
import { type CalcSide, damage, type DamageResult } from '../calc/calc.js';
import { type CalcField, fieldFromNote } from '../calc/field.js';
import { NATURES } from '../rom/natures.js';
import { effectiveSpeed, laggingTail, speedOrder, stall } from './speed.js';

/**
 * One move on the sheet: its damage (null for a status or 0-power move) and its effective accuracy, 0 to 1.
 * - `unmodelled` is the result's `unmodelled`, or for a move with no result the move's own: a status
 *   move the docs give no known effect, or no row at all, may still do anything.
 * - `weatherDepends` is set when the pair's weather is not settled (its `weatherCases`): the cell is then the worse of
 *   the cases for the player, statistic by statistic (`worseCell`), not one case's numbers.
 */
export interface SheetMoveCell {
  move: KaizoMove; result: DamageResult | null; hitChance: number; inaccurate: boolean; unmodelled: string | null; weatherDepends?: true;
}

type Order = 'player' | 'enemy' | 'tie' | 'depends';
type Weather = NonNullable<CalcField['weather']>;

/**
 * One way a pair can turn out when its weather is not settled (`SheetPair.weatherCases`), and the pair worked out that
 * way: on that case's field, with the trainer Pokémon holding `enemyAbility`.
 * - `enemyAbility` is the trainer Pokémon's ability in this case: its own, or, when one of its disputed alternatives
 *   sets weather, that alternative.
 * - `lastIn` is who came in last when both Pokémon set a different weather (whose weather then holds), else null.
 * - `when` says the case in words: "Mon came in last", "Articuno has Snow Warning".
 */
export interface SheetPairCase {
  enemyAbility: number; lastIn: 'player' | 'enemy' | null; when: string; field: CalcField; order: Order; playerSpeed: number;
  enemySpeed: number; playerMoves: SheetMoveCell[]; enemyMoves: SheetMoveCell[];
}

/**
 * One player Pokémon against one trainer Pokémon.
 * - `field` is the field the pair is worked out on: the sheet's, except that a weather-setting ability
 *   on either Pokémon (`setsWeather`) brings its weather in on entry, replacing the field's, permanent or not. The
 *   weather is not settled when both set a different weather (it is then the one whose Pokémon came in last), or when
 *   the trainer Pokémon's ability is disputed and an alternative sets a weather the others do not give.
 *   Then `weatherCases` holds the pair in every case, `order` is `'depends'`, every cell is the worse case for the
 *   player (`weatherDepends`), and `field` is null: no single field holds.
 * - `weatherMayPersist` is true when another Pokémon of the battle (the trainer's others or the team's), by its
 *   ability or a disputed alternative, sets weather: a weather it brought in earlier may still be up when this pair
 *   meets, as its weather stays after it leaves. The pair's numbers count only its own two Pokémon's abilities; a
 *   battle note says the same.
 * - `playerMoves` and `enemyMoves` follow each Pokémon's move slots; status moves are listed too, with no result.
 * - `order` is who moves first: `'tie'` for a 50/50 speed tie, and `'depends'` when it can go either way: the moves'
 *   priorities make it depend on which moves are picked (the notes say which), the weather does, or a Quick Claw or
 *   Custap Berry holder on either side would not surely move first at equal priority (either may activate it). Each
 *   move's ROM priority comes first, then the cartridge's equal-priority order (Quick Claw and Custap Berry, then
 *   `speedOrder`: Lagging Tail and Stall, Trick Room, Speed). The sheet never gives an order the cartridge can break.
 * - A Zoom Lens counts in its holder's hit chances when the holder surely moves second, and for a trainer's Pokémon
 *   whenever it may (the worse case for the player).
 * - `playerSpeed` and `enemySpeed` are `effectiveSpeed`s; with `weatherCases`, the player's lower and the trainer's
 *   higher.
 * - `notes` covers weather-setting abilities, Quick Claw and other order effects, Speed items and abilities, disputed
 *   natures and abilities, and Psywave's odds.
 */
export interface SheetPair {
  player: PlayerMon; enemy: ResolvedMon; field: CalcField | null; playerMoves: SheetMoveCell[]; enemyMoves: SheetMoveCell[];
  order: Order; playerSpeed: number; enemySpeed: number; notes: string[]; weatherCases?: SheetPairCase[]; weatherMayPersist: boolean;
}

/**
 * A trainer's sheet: the field the battle starts on (each pair's own `field` may differ by weather), the starting HP
 * the player's side was worked out on (`SheetOptions.hp`), the pairs (by trainer Pokémon, then team member), and notes
 * on the whole battle.
 */
export interface Sheet { trainer: ResolvedTrainer; field: CalcField; hp: StartingHp; pairs: SheetPair[]; notes: string[] }

/**
 * The player side's starting HP: `'full'`, which planning assumes, or `'save'`, the
 * HP in the save. Either way the status is the save's.
 */
export type StartingHp = 'full' | 'save';

/**
 * `moves` is the hack's move table (`buildMoves`); `field` replaces the field the trainer's docs note and battle type
 * give; `hp` is the player side's starting HP, full by default.
 */
export interface SheetOptions { moves: ReadonlyMap<number, KaizoMove>; field?: CalcField; hp?: StartingHp }

/** The field a trainer fights on: its docs field note (`fieldFromNote`), and `doubles` for a double battle. */
export function trainerField(trainer: ResolvedTrainer): CalcField {
  const field = fieldFromNote(trainer.field);
  if (trainer.battleType === 'double') field.doubles = true;
  return field;
}

/** The moves in a Pokémon's slots, from the move table. Throws for a move the table lacks. */
function movesOf(mon: BattleMon, table: ReadonlyMap<number, KaizoMove>): KaizoMove[] {
  return mon.moves.filter((id) => id !== 0).map((id) => {
    const move = table.get(id);
    if (move === undefined) throw new Error(`${mon.name} has move ${id}, which the move table lacks`);
    return move;
  });
}

const WEATHER_NAMES: Record<Weather, string> = { rain: 'Rain', sun: 'Sun', sand: 'Sandstorm', hail: 'Hail' };

/**
 * The weather-setting abilities and their weathers. On entry each replaces the weather, a permanent field weather
 * included, and skips only when its own weather is already permanent (`SWITCH_IN_CHECK_STATE_WEATHER_ABILITIES`,
 * pokeplatinum src/battle/battle_lib.c:3740-3780); the weather it sets is permanent too (subscript_drizzle.s,
 * subscript_drought.s, subscript_sand_stream.s and subscript_snow_warning.s: lines 11-12, 12-13 for Snow Warning).
 */
const WEATHER_ABILITIES: Readonly<Record<string, Weather>> = { Drizzle: 'rain', Drought: 'sun', 'Sand Stream': 'sand', 'Snow Warning': 'hail' };

/** The weather ability `id` sets on entry, or null. */
const weatherOf = (id: number): Weather | null => WEATHER_ABILITIES[abilityNameById(id)] ?? null;

/** The weather a Pokémon's ability sets on entry, or null. */
export const setsWeather = (mon: BattleMon): Weather | null => weatherOf(mon.ability.value);

/** Whether a Pokémon's ability, or a disputed alternative to it, sets weather on entry. */
const maySetWeather = (mon: BattleMon): boolean => [mon.ability.value, ...mon.ability.alternatives].some((id) => weatherOf(id) !== null);

/**
 * The name the notes use for one of the player's Pokémon: its nickname, or the species name when the nickname is the game's
 * default (the species in capitals, "FINNEON"), as the page and the Showdown text read it.
 */
function pageName(mon: PlayerMon): string {
  return mon.nickname === '' || mon.nickname.toLowerCase() === mon.name.toLowerCase() ? mon.name : mon.nickname;
}

/** Notes on the whole battle: the docs' field note, what each part of the field does here, and the weather setters. */
function battleNotes(trainer: ResolvedTrainer, field: CalcField, team: PlayerMon[]): string[] {
  const notes: string[] = [];
  if (field.doubles) notes.push("Double battle: can't be built yet. Spread moves deal 3/4 damage here.");
  if (trainer.field) notes.push(`Docs field note: ${trainer.field.raw}`);
  if (field.weather) {
    notes.push(`${WEATHER_NAMES[field.weather]} from the start: in the damage, hit chances and Speeds, except in pairs where a weather-setting ability replaces it`);
  }
  // Each Pokémon's setter ability, and each disputed alternative that is one.
  const setters = [...trainer.party.map((mon) => [mon.name, mon] as const), ...team.map((mon) => [pageName(mon), mon] as const)]
    .flatMap(([label, mon]) => [
      ...(setsWeather(mon) === null ? [] : [`${label} (${abilityName(mon)})`]),
      ...mon.ability.alternatives.filter((id) => weatherOf(id) !== null).map((id) => `${label} (${abilityNameById(id)}, if its disputed ability is that)`),
    ]);
  if (setters.length > 0) {
    notes.push(`Weather-setting abilities: ${setters.join(', ')}. A setter's weather replaces the field's when it comes in and stays after it leaves, `
      + 'so later pairs may be fought in it; each pair here counts only its own two Pokémon\'s abilities');
  }
  if (field.fog) notes.push('Fog: every move\'s accuracy is x6/10, in the hit chances (Cloud Nine and Air Lock lift it)');
  if (field.trickRoom) notes.push('Trick Room: at equal priority the slower Pokémon moves first');
  if (field.gravity) notes.push('Gravity: accuracy x10/6, in the hit chances');
  if (field.reflect) notes.push('Reflect is up on the defending side');
  if (field.lightScreen) notes.push('Light Screen is up on the defending side');
  if (trainer.levelMismatch) notes.push('The docs\' levels differ from the ROM\'s; the sheet uses the ROM\'s');
  return notes;
}

/** "Quick Attack +1, Protect +3", or "all priority 0". */
function priorityList(moves: KaizoMove[]): string {
  const listed = moves.filter((move) => move.priority !== 0).map((move) => `${move.name} ${move.priority > 0 ? '+' : ''}${move.priority}`);
  return listed.length > 0 ? listed.join(', ') : 'all priority 0';
}

/** A Pokémon's disputed nature and ability, as notes. */
function disputeNotes(mon: BattleMon): string[] {
  const notes: string[] = [];
  const from = (source: 'rom' | 'docs') => (source === 'rom' ? 'the ROM' : 'the docs');
  if (mon.nature.disputed) {
    notes.push(mon.nature.value === null
      ? `${mon.name}'s nature is unknown (no source gives one): the sheet uses a neutral nature`
      : `${mon.name}'s nature (${NATURES[mon.nature.value]}, from ${from(mon.nature.source)}) is disputed: check it in game`);
  }
  if (mon.ability.disputed) {
    const others = mon.ability.alternatives.map(abilityNameById);
    const or = others.length > 0 ? ` (or ${others.join(' or ')})` : '';
    notes.push(`${mon.name}'s ability (${abilityName(mon)}, from ${from(mon.ability.source)}) is disputed${or}: check it in game`);
  }
  return notes;
}

/**
 * What a Pokémon's item, ability and status do to turn order and Speed, as notes; `label` names it. `zoomLens` says
 * how its hit chances count a Zoom Lens: `'counted'` when it surely moves second, `'worst case'` when it may (a
 * trainer's), `'left out'` when it may move first (the player's).
 */
function speedNotes(side: CalcSide, label: string, field: CalcField, zoomLens: 'counted' | 'worst case' | 'left out'): string[] {
  const { mon } = side;
  const notes: string[] = [];
  const held = heldEffect(mon);
  const item = mon.item === 0 ? '' : itemName(mon.item);
  const ability = abilityName(mon);
  if (held?.effect === 'SOMETIMES_PRIORITY') {
    notes.push(`${item} (${label}): moves first at equal priority ${Math.round(100 / Math.floor(100 / held.param))}% of the time`);
  }
  if (held?.effect === 'PINCH_PRIORITY') {
    const at = ability === 'Gluttony' ? '1/2' : `1/${held.param}`;
    notes.push(`${item} (${label}): moves first at equal priority, once, at ${at} HP or less`);
  }
  if (laggingTail(side)) notes.push(`${item} (${label}): moves last at equal priority`);
  if (stall(side)) notes.push(`Stall (${label}): moves last at equal priority`);
  if (held?.effect === 'CHOICE_SPEED') notes.push(`${item} (${label}): Speed x1.5, in its Speed; locked into the first move it uses`);
  if (itemEffect(mon.item)?.effect === 'SPEED_HALVING') notes.push(`${item} (${label}): Speed halved, in its Speed`);
  if (sideStatus(side).kind === 'paralysis' && ability !== 'Quick Feet') notes.push(`${label} is paralysed: Speed /4, in its Speed`);
  if (ability === 'Quick Feet' && sideStatus(side).kind !== 'none') notes.push(`Quick Feet (${label}): Speed x1.5 with its status, in its Speed`);
  if ((ability === 'Swift Swim' && field.weather === 'rain') || (ability === 'Chlorophyll' && field.weather === 'sun')) {
    notes.push(`${ability} (${label}): Speed x2 in this weather, in its Speed`);
  }
  if (ability === 'Slow Start') notes.push(`Slow Start (${label}): Speed and Attack halve for its first 5 turns, not in these numbers`);
  if (ability === 'Unburden') notes.push(`Unburden (${label}): Speed doubles once its item is gone, not in these numbers`);
  if (ability === 'Cloud Nine' || ability === 'Air Lock') notes.push(`${ability} (${label}): weather and fog have no effect on accuracy or Speed`);
  if (held?.effect === 'ACCURACY_UP_SLOWER' && zoomLens === 'left out') {
    notes.push(`${item} (${label}): accuracy x1.2 once the target has moved, not in its hit chances (it may move first)`);
  }
  if (held?.effect === 'ACCURACY_UP_SLOWER' && zoomLens === 'worst case') {
    notes.push(`${item} (${label}): accuracy x1.2 once the target has moved, in its hit chances as the worst case (it may move first)`);
  }
  return notes;
}

/** Notes on a side's moves: Psywave's odds. */
function moveNotes(moves: KaizoMove[], label: string): string[] {
  const notes: string[] = [];
  for (const move of moves) {
    if (move.calc.fixedDamage === 'psywave') {
      notes.push(`Psywave (${label}): its 16 rolls are not equally likely; its KO chance uses its 11 damage values, 1/11 each`);
    }
  }
  return notes;
}

/**
 * Who moves first over every pairing of the two sides' moves: the higher priority, else `atEqual`. One answer for
 * every pairing is the order; more than one, or `'depends'` at equal priority, is `'depends'`. A side with no moves
 * leaves only `atEqual`.
 */
function turnOrder(playerMoves: KaizoMove[], enemyMoves: KaizoMove[], atEqual: Order): SheetPair['order'] {
  const outcomes = new Set<SheetPair['order']>();
  for (const mine of playerMoves) {
    for (const theirs of enemyMoves) {
      outcomes.add(mine.priority > theirs.priority ? 'player' : mine.priority < theirs.priority ? 'enemy' : atEqual);
    }
  }
  if (outcomes.size === 0) return atEqual;
  return outcomes.size === 1 ? [...outcomes][0]! : 'depends';
}

/** The cells for one side's moves against the other. */
function cells(attacker: CalcSide, defender: CalcSide, moves: KaizoMove[], field: CalcField, defenderMoved: boolean): SheetMoveCell[] {
  return moves.map((move) => {
    const chance = hitChance(attacker, defender, move, field, { defenderMoved });
    const result = damage(attacker, defender, move, field);
    return { move, result, hitChance: chance, inaccurate: chance < 1, unmodelled: result === null ? move.unmodelled : result.unmodelled };
  });
}

/** A pair worked out on one field. */
type PairUnder = Omit<SheetPairCase, 'enemyAbility' | 'lastIn' | 'when' | 'field'> & { notes: string[] };

/** The pair of `player` and `enemy`, with their moves, worked out on `field`, the player starting on `hp`. */
function pairUnder(player: PlayerMon, enemy: ResolvedMon, playerMoves: KaizoMove[], enemyMoves: KaizoMove[], field: CalcField, hp: StartingHp): PairUnder {
  const playerSide: CalcSide = { mon: player, ...(hp === 'save' && { curHp: player.currentHp }) };
  const enemySide: CalcSide = { mon: enemy };
  // Cloud Nine and Air Lock cancel the weather's Speed effects; the calc and `hitChance` see the abilities themselves.
  const speedField: CalcField = weatherSuppressed(player, enemy) ? { ...field, weather: undefined } : field;
  const playerSpeed = effectiveSpeed(playerSide, speedField);
  const enemySpeed = effectiveSpeed(enemySide, speedField);
  const atEqual = ({ a: 'player', b: 'enemy', tie: 'tie' } as const)[speedOrder(playerSide, enemySide, speedField)];
  // A Quick Claw or Custap Berry can move its holder first at equal priority, before everything `speedOrder` counts
  // (battle_lib.c:1400-1448), so a holder that would not surely move first leaves the order open.
  const claw = (side: CalcSide) => ['SOMETIMES_PRIORITY', 'PINCH_PRIORITY'].includes(heldEffect(side.mon)?.effect ?? '');
  const clawOpens = (claw(playerSide) && atEqual !== 'player') || (claw(enemySide) && atEqual !== 'enemy');
  const order = turnOrder(playerMoves, enemyMoves, clawOpens ? 'depends' : atEqual);

  const notes: string[] = [];
  const first = { player: `${pageName(player)} moves first`, enemy: `${enemy.name} moves first`, tie: 'it is a speed tie, 50% each' }[atEqual];
  const priorities = new Set([...playerMoves, ...enemyMoves].map((move) => move.priority));
  if (priorities.size > 1) {
    notes.push(`Priority: ${pageName(player)}: ${priorityList(playerMoves)}; ${enemy.name}: ${priorityList(enemyMoves)}. At equal priority ${first} (Spe ${playerSpeed} vs ${enemySpeed}).`);
  }
  if (atEqual === 'tie') notes.push(`Speed tie at ${playerSpeed}: either moves first, 50% each`);
  if (field.trickRoom) notes.push('Trick Room: the slower one moves first at equal priority');
  // Zoom Lens counts only once the target has moved: in the player's hit chances only when the player surely moves
  // second, in the trainer's whenever it may (the worse case for the player).
  const playerZoom = order === 'enemy';
  const enemyZoom = order !== 'enemy';
  notes.push(...speedNotes(playerSide, pageName(player), speedField, playerZoom ? 'counted' : 'left out'));
  notes.push(...speedNotes(enemySide, enemy.name, speedField, order === 'player' ? 'counted' : 'worst case'));
  notes.push(...moveNotes(playerMoves, pageName(player)), ...moveNotes(enemyMoves, enemy.name));

  return {
    order, playerSpeed, enemySpeed, notes,
    playerMoves: cells(playerSide, enemySide, playerMoves, field, playerZoom),
    enemyMoves: cells(enemySide, playerSide, enemyMoves, field, enemyZoom),
  };
}

/**
 * The worse for the player of one move's cells in two cases (`SheetMoveCell.weatherDepends`), statistic by statistic:
 * for a trainer's move (`enemyAttacks`) the higher KO chance for each number of uses, the higher bottom
 * and top roll (`min`, `max`, with their `percent`) and the higher hit chance; for the player's move, the lower of each.
 * `rolls` and `critRolls` are the worse of the two at each index, in the same direction, so they agree with `min`,
 * `max` and `koChance`. A case whose result is unbounded makes the cell unbounded. Only `desc` (and the other
 * descriptive fields) is one case's: the unbounded one's, or else the one with the higher top roll (then bottom roll)
 * for a trainer's move and the lower for the player's; the pair's `weatherCases` hold each case's exact numbers.
 * `koExact` is, for each number of uses, the worse case's exact fraction in the same direction, compared exactly (count
 * times the other's total, never as floats): so the cases can each win some uses, as with `koChance`, which it agrees
 * with. Null when either case has none.
 */
export function worseCell(a: SheetMoveCell, b: SheetMoveCell, enemyAttacks: boolean): SheetMoveCell {
  const worse = (x: number, y: number) => (enemyAttacks ? Math.max(x, y) : Math.min(x, y));
  const hitChance = worse(a.hitChance, b.hitChance);
  const flags = { hitChance, inaccurate: hitChance < 1, weatherDepends: true as const };
  const [ra, rb] = [a.result, b.result];
  if (ra === null || rb === null) return { ...(ra === null ? b : a), ...flags };
  const aHigher = ra.max > rb.max || (ra.max === rb.max && ra.min >= rb.min);
  const picked = !ra.bounded ? a : !rb.bounded ? b : aHigher === enemyAttacks ? a : b;
  const minFrom = worse(ra.min, rb.min) === ra.min ? ra : rb;
  const maxFrom = worse(ra.max, rb.max) === ra.max ? ra : rb;
  const bounded = ra.bounded && rb.bounded;
  // The two lists are paired by `hits`, never by index (they can hold different hit counts). A hit count only one case
  // lists: for a trainer's move that case's entry stands (never understate the danger to the player); for the player's
  // move the entry stays with a zero chance (the other case claims no KO there, so none can be promised), so the list
  // keeps its hits 1 to 4. The calc always lists hits 1 to 4, so this branch is defensive.
  const byHits = <T extends { hits: number }>(x: T[], y: T[], both: (p: T, q: T) => T, zero: (hits: number) => T): T[] => {
    const other = new Map(y.map((entry) => [entry.hits, entry]));
    const mine = new Set(x.map((entry) => entry.hits));
    const joined = x.flatMap((p) => {
      const q = other.get(p.hits);
      return q !== undefined ? [both(p, q)] : [enemyAttacks ? p : zero(p.hits)];
    });
    const onlyY = y.filter((q) => !mine.has(q.hits)).map((q) => (enemyAttacks ? q : zero(q.hits)));
    return [...joined, ...onlyY].sort((p, q) => p.hits - q.hits);
  };
  const koChance = !bounded || ra.koChance === null || rb.koChance === null ? null
    : byHits(ra.koChance, rb.koChance, (x, y) => ({ hits: x.hits, chance: worse(x.chance, y.chance) }), (hits) => ({ hits, chance: 0 }));
  const koExact = koChance === null || ra.koExact === null || rb.koExact === null ? null
    : byHits(ra.koExact, rb.koExact, (x, y) => {
      // x ≥ y exactly when x.count / x.total ≥ y.count / y.total (both totals are at least 1).
      const xHigher = x.count * y.total >= y.count * x.total;
      const { count, total } = xHigher === enemyAttacks ? x : y;
      return { hits: x.hits, count, total };
    }, (hits) => ({ hits, count: 0n, total: 1n }));
  const perRoll = (x: number[], y: number[]) => x.map((roll, i) => worse(roll, y[i]!));
  const result: DamageResult = {
    ...picked.result!, rolls: perRoll(ra.rolls, rb.rolls), critRolls: perRoll(ra.critRolls, rb.critRolls), min: minFrom.min, max: maxFrom.max, percent: [minFrom.percent[0], maxFrom.percent[1]], koChance, koExact, bounded,
  };
  return { ...picked, result, ...flags };
}

const weatherName = (weather: Weather | undefined) => (weather === undefined ? 'no weather' : WEATHER_NAMES[weather].toLowerCase());

/** One way a pair's weather can turn out: the trainer Pokémon's ability, who came in last when both set one, and the weather. */
interface WeatherWorld { enemyAbility: number; lastIn: 'player' | 'enemy' | null; weather: Weather | undefined }

/**
 * Every way the pair's weather can turn out on `field`. The trainer Pokémon's ability is its
 * own, or, when its own or a disputed alternative sets weather, each of them in turn. With each, a setter on either side
 * brings its weather in; when both set a different one, either may have come in last.
 */
function weatherWorlds(player: PlayerMon, enemy: ResolvedMon, field: CalcField): WeatherWorld[] {
  const mine = setsWeather(player);
  const candidates = [enemy.ability.value, ...enemy.ability.alternatives];
  const abilities = candidates.some((id) => weatherOf(id) !== null) ? candidates : [enemy.ability.value];
  return abilities.flatMap((enemyAbility): WeatherWorld[] => {
    const theirs = weatherOf(enemyAbility);
    if (mine !== null && theirs !== null && mine !== theirs) {
      return [{ enemyAbility, lastIn: 'player', weather: mine }, { enemyAbility, lastIn: 'enemy', weather: theirs }];
    }
    return [{ enemyAbility, lastIn: null, weather: mine ?? theirs ?? field.weather }];
  });
}

function pairFor(player: PlayerMon, enemy: ResolvedMon, field: CalcField, table: ReadonlyMap<number, KaizoMove>, hp: StartingHp, weatherMayPersist: boolean): SheetPair {
  const playerMoves = movesOf(player, table);
  const enemyMoves = movesOf(enemy, table);
  const [mine, theirs] = [setsWeather(player), setsWeather(enemy)];
  const setterLabel = (mon: BattleMon, label: string) => `${abilityName(mon)} (${label})`;
  const worlds = weatherWorlds(player, enemy, field);

  if (new Set(worlds.map((world) => world.weather)).size > 1) {
    const abilityDisputed = worlds.some((world) => world.enemyAbility !== enemy.ability.value);
    const lastInLabel = { player: pageName(player), enemy: enemy.name };
    const cases = worlds.map((world): SheetPairCase & { notes: string[] } => {
      const when = [
        ...(abilityDisputed ? [`${enemy.name} has ${abilityNameById(world.enemyAbility)}`] : []),
        ...(world.lastIn === null ? [] : [`${lastInLabel[world.lastIn]} came in last`]),
      ].join(' and ');
      const caseField = { ...field, weather: world.weather };
      const caseEnemy = world.enemyAbility === enemy.ability.value ? enemy : { ...enemy, ability: { ...enemy.ability, value: world.enemyAbility } };
      return { enemyAbility: world.enemyAbility, lastIn: world.lastIn, when, field: caseField, ...pairUnder(player, caseEnemy, playerMoves, enemyMoves, caseField, hp) };
    });
    const caseNotes = cases.flatMap((c) => c.notes.map((note) => (cases.every((other) => other.notes.includes(note)) ? note : `If ${c.when}: ${note}`)));
    const notes: string[] = [];
    if (mine !== null && theirs !== null && mine !== theirs) {
      notes.push(`${setterLabel(player, pageName(player))} and ${setterLabel(enemy, enemy.name)} both set weather: it is the one whose Pokémon came in last `
        + `(when both lead, the slower one's, as the setters go in Speed order)`);
    }
    if (abilityDisputed) {
      const candidates = [enemy.ability.value, ...enemy.ability.alternatives];
      const setters = candidates.filter((id) => weatherOf(id) !== null);
      const sets = setters.length === 1 && setters[0] === candidates.at(-1)
        ? `, which sets ${weatherName(weatherOf(setters[0]!)!)} on entry`
        : `; ${setters.map((id) => `${abilityNameById(id)} sets ${weatherName(weatherOf(id)!)}`).join(' and ')} on entry`;
      notes.push(`${enemy.name}'s ability is disputed: ${candidates.map(abilityNameById).join(' or ')}${sets}`);
    }
    notes.push(`Worked out under each: ${cases.map((c) => `${weatherName(c.field.weather)} if ${c.when}`).join('; ')}; each move shows the worse case for ${pageName(player)}`);
    const strip = ({ notes: _notes, ...rest }: SheetPairCase & { notes: string[] }): SheetPairCase => rest;
    const worst = (pick: (c: SheetPairCase) => SheetMoveCell[], enemyAttacks: boolean): SheetMoveCell[] =>
      pick(cases[0]!).map((cell, i) => cases.slice(1).reduce<SheetMoveCell>((acc, c) => worseCell(acc, pick(c)[i]!, enemyAttacks), { ...cell, weatherDepends: true }));
    return {
      player, enemy, field: null, order: 'depends', notes: [...notes, ...new Set(caseNotes), ...disputeNotes(enemy)],
      playerSpeed: Math.min(...cases.map((c) => c.playerSpeed)), enemySpeed: Math.max(...cases.map((c) => c.enemySpeed)),
      playerMoves: worst((c) => c.playerMoves, false), enemyMoves: worst((c) => c.enemyMoves, true),
      weatherCases: cases.map(strip), weatherMayPersist,
    };
  }

  const notes: string[] = [];
  const setter = mine !== null ? { weather: mine, label: setterLabel(player, pageName(player)) } : theirs !== null ? { weather: theirs, label: setterLabel(enemy, enemy.name) } : null;
  const pairField = setter === null ? field : { ...field, weather: setter.weather };
  if (setter !== null && setter.weather !== field.weather) {
    const before = field.weather === undefined ? 'with no field weather before it' : `replacing the field's ${weatherName(field.weather)}`;
    notes.push(`${setter.label}: ${weatherName(setter.weather)} from its entry, ${before}; this pair is worked out in ${weatherName(setter.weather)}`);
  }
  const under = pairUnder(player, enemy, playerMoves, enemyMoves, pairField, hp);
  return { player, enemy, field: pairField, ...under, notes: [...notes, ...under.notes, ...disputeNotes(enemy)], weatherMayPersist };
}

/**
 * The matchup sheet for `team` against `trainer`: a pair for each trainer Pokémon (in party order) against each team
 * member (in team order). The player's Pokémon start at full HP (or the save's, with `opts.hp` `'save'`) with the
 * save's status, the trainer's at full HP with no status, and no stat stages. The field is `opts.field`, else the
 * trainer's (`trainerField`); each pair's own field adds the weather its Pokémon's abilities set (`SheetPair.field`),
 * and `weatherMayPersist` marks a pair another Pokémon's weather may reach. Throws for a move the move table lacks.
 */
export function buildSheet(team: PlayerMon[], trainer: ResolvedTrainer, opts: SheetOptions): Sheet {
  const field = opts.field ?? trainerField(trainer);
  const hp = opts.hp ?? 'full';
  const pairs = trainer.party.flatMap((enemy, e) => team.map((player, p) => {
    const others = [...trainer.party.filter((_, i) => i !== e), ...team.filter((_, i) => i !== p)];
    return pairFor(player, enemy, field, opts.moves, hp, others.some(maySetWeather));
  }));
  return { trainer, field, hp, pairs, notes: battleNotes(trainer, field, team) };
}
