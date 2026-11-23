// The sheet route's JSON (`POST /api/sheet`, `SheetJson` in `src/contracts/api.ts`) from the matchup sheet
// (`buildSheet` in `src/sheet/sheet.ts`), which the route takes as an injected `SheetBuilder` and builds over the team as
// drafted, each Pokémon on the HP it carries.

import type { PlayerMon } from '../battle/playerMon.js';
import type { BattleMon, ResolvedTrainer, Sourced } from '../battle/types.js';
import type { CalcField } from '../calc/field.js';
import type { NameIndex } from '../names/nameIndex.js';
import { NATURES } from '../rom/natures.js';
import { computeStats } from '../rom/stats.js';
import { TYPE_NAMES } from '../rom/tables.js';
import type { Stats } from '../rom/types.js';
import type { StartStatus } from '../save/status.js';
import type { Sheet, SheetMoveCell, SheetOptions, SheetPair, SheetPairCase } from '../sheet/sheet.js';
import { spriteIds } from '../sprites/forms.js';
import type { SheetJson, SheetMonJson, SheetMoveJson, SheetPairCaseJson, SheetPairJson } from './apiTypes.js';
import { monRef } from './box.js';
import { statusToJson } from './json.js';
import { moveName, showdownSet } from './showdown.js';

/** Builds a trainer's sheet against the team: `buildSheet`, or a stand-in in a test. */
export type SheetBuilder = (team: PlayerMon[], trainer: ResolvedTrainer, opts: SheetOptions) => Sheet;

const HARDY = 0;
const CATEGORY_NAMES = { physical: 'Physical', special: 'Special', status: 'Status' } as const;
const WEATHER_NAMES = { rain: 'Rain', sun: 'Sun', sand: 'Sandstorm', hail: 'Hail' } as const;

/** A Pokémon's stats by the formula; a null nature (no source gives one) counts as neutral, Hardy. */
export function sheetStats(mon: BattleMon): Stats {
  return computeStats(mon.baseStats, mon.ivs, mon.evs, mon.level, mon.nature.value ?? HARDY);
}

/**
 * A field in short, weather first: "Rain", "No weather, Trick Room", then Fog, Gravity, Reflect and Light Screen as
 * they are up. A double battle is left out: the sheet's header says so.
 */
export function fieldText(field: CalcField): string {
  const parts: [boolean | undefined, string][] = [
    [field.fog, 'Fog'], [field.trickRoom, 'Trick Room'], [field.gravity, 'Gravity'], [field.reflect, 'Reflect'], [field.lightScreen, 'Light Screen'],
  ];
  const weather = field.weather === undefined ? 'No weather' : WEATHER_NAMES[field.weather];
  return [weather, ...parts.filter(([on]) => on === true).map(([, name]) => name)].join(', ');
}

/** A trainer Pokémon's key on the page: "enemy:<party index>". */
export const enemyKey = (index: number) => `enemy:${index}`;

/**
 * The sheet's team in the order the pairs first name its members (the team's order), and its pairs in the page's
 * order, players outer, then by party slot, each with its trainer Pokémon's party index. Throws for a pair whose enemy
 * is not in the trainer's party.
 */
export function orderedPairs(sheet: Sheet): { team: PlayerMon[]; placed: { pair: SheetPair; enemy: number }[] } {
  const { trainer } = sheet;
  const team: PlayerMon[] = [];
  for (const { player } of sheet.pairs) if (!team.includes(player)) team.push(player);
  const placed = sheet.pairs.map((pair) => {
    const enemy = trainer.party.indexOf(pair.enemy);
    if (enemy < 0) throw new Error(`The sheet pairs ${pair.player.nickname} with a ${pair.enemy.name} not in ${trainer.name}'s party`);
    return { pair, player: team.indexOf(pair.player), enemy };
  });
  placed.sort((a, b) => a.player - b.player || a.enemy - b.enemy);
  return { team, placed: placed.map(({ pair, enemy }) => ({ pair, enemy })) };
}

/** The sheet's JSON without the save it was built from, which the route adds (`SheetJson.savedAt` and `savePath`). */
export type SheetBodyJson = Omit<SheetJson, 'savedAt' | 'savePath'>;

/**
 * The sheet as the page gets it, but for the save (the route's). `enemies` follow the trainer's party, and `players`
 * and `pairs` are in `orderedPairs`' order. `notes` are the sheet's as they are: the calc's own note already says a double
 * can't be built yet. `ctx.variant` and `ctx.variants` are the trainer copy's index and the number of
 * copies. Throws for a pair whose enemy is not in the trainer's party.
 */
export function sheetToJson(sheet: Sheet, ctx: { names: NameIndex; variant: number; variants: number }): SheetBodyJson {
  const { trainer } = sheet;
  const { names } = ctx;
  const { team, placed } = orderedPairs(sheet);
  return {
    trainer: {
      id: trainer.id, name: trainer.name, location: trainer.location, battleType: trainer.battleType,
      variant: ctx.variant, variants: ctx.variants, field: trainer.field?.raw ?? null,
    },
    notes: [...sheet.notes],
    enemies: trainer.party.map((mon, index) => monJson(mon, enemyKey(index), names)),
    // The HP its numbers use: the HP it carries with hp 'save', else its max; its status either way.
    players: team.map((mon) => monJson(mon, monRef(mon.location), names, { hp: sheet.hp === 'save' ? mon.currentHp : null, status: mon.status })),
    pairs: placed.map(({ pair, enemy }) => pairJson(pair, enemyKey(enemy), names)),
  };
}

const natureName = (id: number) => NATURES[id] ?? `(nature ${id})`;

/** Every candidate's name, the value's first; a null value (no nature known) has only its alternatives. */
function options<T extends number | null>(sourced: Sourced<T>, name: (id: number) => string): string[] {
  return [sourced.value, ...sourced.alternatives].filter((id): id is NonNullable<T> => id !== null).map((id) => name(id));
}

/**
 * One Pokémon as the sheet's JSON. `start` is how one of the player's starts the numbers: its HP (null: its max) and its
 * status. Left out (a trainer's), it is at full HP with no status.
 */
function monJson(mon: BattleMon & { nickname?: string }, key: string, names: NameIndex, start?: { hp: number | null; status: StartStatus }): SheetMonJson {
  const stats = sheetStats(mon);
  return {
    key, name: mon.name, ...spriteIds(mon.species, mon.form), nickname: mon.nickname ?? null, level: mon.level,
    nature: mon.nature.value === null ? null : NATURES[mon.nature.value] ?? null,
    ability: names.ability(mon.ability.value),
    item: mon.item === 0 ? null : names.item(mon.item),
    moves: mon.moves.map((id) => moveName(names, id)),
    stats,
    hp: start?.hp ?? stats.hp,
    status: start === undefined ? null : statusToJson(start.status),
    disputed: [
      ...(mon.nature.disputed ? [{ field: 'nature' as const, options: options(mon.nature, natureName) }] : []),
      ...(mon.ability.disputed ? [{ field: 'ability' as const, options: options(mon.ability, (id) => names.ability(id)) }] : []),
    ],
    showdown: showdownSet(mon, names),
  };
}

function pairJson(pair: SheetPair, enemy: string, names: NameIndex): SheetPairJson {
  return {
    player: monRef(pair.player.location), enemy, field: pair.field === null ? null : fieldText(pair.field),
    order: pair.order, playerSpeed: pair.playerSpeed, enemySpeed: pair.enemySpeed, notes: [...pair.notes],
    playerMoves: pair.playerMoves.map(moveJson), enemyMoves: pair.enemyMoves.map(moveJson),
    ...(pair.weatherCases !== undefined && { weatherCases: pair.weatherCases.map((c) => caseJson(c, names)) }),
    weatherMayPersist: pair.weatherMayPersist,
  };
}

function caseJson(c: SheetPairCase, names: NameIndex): SheetPairCaseJson {
  return {
    enemyAbility: names.ability(c.enemyAbility), lastIn: c.lastIn, when: c.when, field: fieldText(c.field), order: c.order,
    playerSpeed: c.playerSpeed, enemySpeed: c.enemySpeed, playerMoves: c.playerMoves.map(moveJson), enemyMoves: c.enemyMoves.map(moveJson),
  };
}

/**
 * A move cell, with the calc's `unmodelled` (the result's, or the move's own when there is no result). The calc's exact KO
 * chances (bigint counts, already reduced) go field by field as decimal strings, sorted by `hits`.
 */
function moveJson(cell: SheetMoveCell): SheetMoveJson {
  const { move, result } = cell;
  return {
    name: move.name, type: TYPE_NAMES[move.type] ?? `(type ${move.type})`, category: CATEGORY_NAMES[move.category], power: move.power,
    hitChance: cell.hitChance, inaccurate: cell.inaccurate, unmodelled: cell.unmodelled, weatherDepends: cell.weatherDepends === true,
    damage: result === null ? null : {
      rolls: [...result.rolls], critRolls: [...result.critRolls], min: result.min, max: result.max,
      percent: [result.percent[0], result.percent[1]],
      koChance: result.koChance === null ? null : result.koChance.map(({ hits, chance }) => ({ hits, chance })),
      koExact: result.koExact === null ? null
        : [...result.koExact].sort((a, b) => a.hits - b.hits).map(({ hits, count, total }) => ({ hits, num: String(count), den: String(total) })),
      bounded: result.bounded, ohko: result.ohko, desc: result.desc,
    },
  };
}
