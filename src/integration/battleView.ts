// The calc's view of an engine state's battle, for the oracles and the order hint: each side's active Pokémon as a calc
// side (`CalcSide`: the Pokémon's own data, with the world's nature and ability for a trainer's, and its live stat
// stages, status and HP) and the field. A Pokémon whose state the calc cannot describe (transformed, its ability, item or
// types changed, or any volatile condition that can change damage or Speed) has no view: callers skip it.

import type { KaizoMove } from '../battle/moves.js';
import { atLevel, type PlayerMon } from '../battle/playerMon.js';
import type { BattleMon, LoadedData, ResolvedTrainer } from '../battle/types.js';
import type { CalcField, CalcSide } from '../calc/calc.js';
import type { EngineState, Side } from '../contracts/engine.js';
import { abilityId, battleTrainer, itemId, moveId, restore, speciesId } from '../engine/index.js';
import { NATURES } from '../rom/natures.js';
import type { Stats } from '../rom/types.js';
import type { StartStatus } from '../save/status.js';

export interface BattleContext {
  data: Pick<LoadedData, 'rom'>;
  /** The hack's moves (`buildMoves`, as installed with `installKaizoDex`). */
  moves: ReadonlyMap<number, KaizoMove>;
  /** The player's Pokémon that may be in the battle (the save's eligible ones), or with `inPartyOrder` the battle's own party. */
  player: readonly PlayerMon[];
  /**
   * True: `player` is the battle's own party in order (`BattleInput.player`), so each of the player's Pokémon is found by its
   * party position and read at its level and moves now (`liveMon`), which a level-up in the fight changes. Absent or
   * false: by `matchPlayerSet` over its set.
   */
  inPartyOrder?: boolean;
  /** The resolved trainer (a variant included) with ROM index `romIndex`, or undefined. */
  trainer: (romIndex: number) => ResolvedTrainer | undefined;
  /**
   * A state as the reference engine's readers take it (the engine kit's `reference`, src/engines/select.ts,
   * which converts a native state). Absent: every state is a reference state already.
   */
  reference?: (state: EngineState) => EngineState;
}

/**
 * Volatile conditions that change no move's damage and no Speed; any other one leaves the Pokémon without a view.
 * `focusenergy` changes only the crit chance, which the server reads off the Pokémon itself (src/server/critChance.ts).
 */
const HARMLESS_VOLATILES: ReadonlySet<string> = new Set([
  'trapped', 'partiallytrapped', 'confusion', 'attract', 'leechseed', 'nightmare', 'curse', 'taunt', 'encore', 'disable',
  'torment', 'yawn', 'perishsong', 'mustrecharge', 'lockedmove', 'stall', 'destinybond', 'grudge', 'imprison', 'snatch',
  'magiccoat', 'protect', 'endure', 'focuspunch', 'choicelock', 'healblock', 'focusenergy',
]);

const WEATHERS: Record<string, CalcField['weather']> = { raindance: 'rain', sunnyday: 'sun', sandstorm: 'sand', hail: 'hail' };
const STATUSES: Record<string, StartStatus> = {
  '': { kind: 'none' }, slp: { kind: 'sleep', turns: 1 }, psn: { kind: 'poison' }, tox: { kind: 'toxic' }, brn: { kind: 'burn' },
  frz: { kind: 'freeze' }, par: { kind: 'paralysis' },
};

/** The installed dex's IDs back to the hack's: moves by name and by Showdown ID, abilities and items by Showdown ID. */
export interface Lookups { byName: Map<string, KaizoMove>; byId: Map<string, KaizoMove>; ability: Map<string, number>; item: Map<string, number> }

/** The lookups over `moves`; the dex must be installed. */
export function buildLookups(moves: ReadonlyMap<number, KaizoMove>): Lookups {
  const byName = new Map<string, KaizoMove>();
  const byId = new Map<string, KaizoMove>();
  for (const move of moves.values()) {
    byName.set(move.name, move);
    try {
      byId.set(moveId(move), move);
    } catch {
      // not in the installed dex
    }
  }
  const reverse = (toId: (id: number) => string, max: number): Map<string, number> => {
    const map = new Map<string, number>();
    for (let id = 1; id <= max; id++) {
      try {
        const key = toId(id);
        if (key !== '' && !map.has(key)) map.set(key, id);
      } catch {
        // an ID with no Showdown name
      }
    }
    return map;
  };
  return { byName, byId, ability: reverse(abilityId, 200), item: reverse(itemId, 700) };
}

/** One side's active Pokémon: the Showdown Pokémon, its protocol name ("p1a: Fernando") and its calc side. */
export interface Active { side: Side; ident: string; pokemon: Pokemon; calc: CalcSide }

/**
 * The battle `state` holds (read through the context's `reference`), and the resolved trainer it is against (undefined
 * when the context does not know it).
 */
export function battleOf(state: EngineState, ctx: BattleContext): { battle: Battle; trainer: ResolvedTrainer | undefined } {
  const ref = ctx.reference?.(state) ?? state;
  let trainer: ResolvedTrainer | undefined;
  try {
    trainer = ctx.trainer(battleTrainer(ref).romIndex);
  } catch {
    trainer = undefined;
  }
  return { battle: restore(ref), trainer };
}

/** `side`'s active Pokémon in `battle` (see the top of the file), or null. */
export function activeOf(battle: Battle, trainer: ResolvedTrainer | undefined, side: Side, ctx: BattleContext, look: Lookups): Active | null {
  const pokemon = battle[side].active[0];
  return pokemon === undefined || pokemon === null ? null : viewOf(pokemon, trainer, side, ctx, look);
}

/** The party member at `index` (its original party position, as `Choice.switch.index` counts) of `side`, or null. */
export function memberOf(battle: Battle, trainer: ResolvedTrainer | undefined, side: Side, index: number, ctx: BattleContext, look: Lookups): Active | null {
  const set = battle[side].team[index];
  const pokemon = set === undefined ? undefined : battle[side].pokemon.find((p) => p.set === set);
  return pokemon === undefined ? null : viewOf(pokemon, trainer, side, ctx, look);
}

/**
 * Abilities whose effect the view's stat stages already hold but @smogon/calc's Gen 4 code applies again by itself:
 * Download (its +1 at switch-in, which the calc adds with no condition).
 */
const DOUBLE_COUNTED_ABILITIES: ReadonlySet<string> = new Set(['download']);

function viewOf(pokemon: Pokemon, trainer: ResolvedTrainer | undefined, side: Side, ctx: BattleContext, look: Lookups): Active | null {
  if (pokemon.fainted) return null;
  if (pokemon.transformed || pokemon.ability !== pokemon.baseAbility) return null;
  if (DOUBLE_COUNTED_ABILITIES.has(pokemon.ability)) return null;
  if (Object.keys(pokemon.volatiles).some((id) => !HARMLESS_VOLATILES.has(id))) return null;
  if (JSON.stringify(pokemon.types) !== JSON.stringify(pokemon.species.types) || pokemon.addedType) return null;
  const base = side === 'p2' ? enemyMon(trainer, pokemon, look) : playerMon(pokemon, ctx, look);
  if (base === null) return null;
  let mon: BattleMon = base;
  if (pokemon.item !== itemId(base.item)) {
    if (pokemon.item !== '') return null;   // an item other than its own
    mon = { ...base, item: 0 };               // its item was used up or taken
  }
  const status = STATUSES[pokemon.status];
  if (status === undefined) return null;
  const { atk, def, spa, spd, spe, accuracy, evasion } = pokemon.boosts;
  return {
    side, ident: `${side}a: ${pokemon.name}`, pokemon,
    calc: { mon: mon as PlayerMon, boosts: { atk, def, spa, spd, spe, accuracy, evasion }, status, curHp: pokemon.hp, abilityOn: false },
  };
}

/** The trainer's Pokémon behind `pokemon`, with the world's nature and ability (from its set). */
function enemyMon(trainer: ResolvedTrainer | undefined, pokemon: Pokemon, look: Lookups): BattleMon | null {
  const index = pokemon.side.team.indexOf(pokemon.set);
  const base = trainer?.party[index];
  if (base === undefined) return null;
  const nature = NATURES.indexOf(pokemon.set.nature as (typeof NATURES)[number]);
  const ability = look.ability.get(pokemon.set.ability);
  if (nature < 0 || ability === undefined) return null;
  return {
    ...base,
    nature: { value: nature, source: 'rom', disputed: false, alternatives: [] },
    ability: { value: ability, source: 'rom', disputed: false, alternatives: [] },
  };
}

/**
 * The player's Pokémon behind `pokemon`: with `inPartyOrder` the one at its party position, at its level and moves now
 * (`liveMon`); else `matchPlayerSet` over its set.
 */
function playerMon(pokemon: Pokemon, ctx: BattleContext, look: Lookups): BattleMon | null {
  if (ctx.inPartyOrder !== true) return matchPlayerSet(pokemon.set, ctx.player, ctx.moves, look);
  const base = ctx.player[pokemon.side.team.indexOf(pokemon.set)];
  return base === undefined ? null : liveMon(base, pokemon, look);
}

/**
 * `base` (the Pokémon the battle's `pokemon` was made from) as it is in the battle now: the engine's level-up (`applyLevel`) changes its level and may teach it moves. `base` itself when the level and the own moves (`baseMoveSlots`,
 * in order) are its own; otherwise `atLevel` at the battle's level, with the battle's moves (their PP and PP Ups the
 * base's for a move it has, else the slot's maximum PP and none). A move the installed dex cannot name leaves the base's
 * moves as they are.
 */
export function liveMon(base: PlayerMon, pokemon: Pokemon, look: Lookups): PlayerMon {
  const ids = pokemon.baseMoveSlots.map((slot) => look.byId.get(slot.id)?.id);
  const sameMoves = ids.length === base.moves.length && ids.every((id, k) => id === base.moves[k]);
  if (pokemon.level === base.level && sameMoves) return base;
  const mon = pokemon.level === base.level ? base : atLevel(base, pokemon.level);
  if (sameMoves || ids.some((id) => id === undefined)) return mon;
  const moves = ids as number[];
  const at = moves.map((id) => base.moves.indexOf(id));
  return {
    ...mon, moves,
    pp: at.map((k, i) => (k < 0 ? pokemon.baseMoveSlots[i]!.maxpp : base.pp[k]!)),
    ppUps: at.map((k) => (k < 0 ? 0 : base.ppUps[k]!)),
  };
}

const sameStats = (a: Stats, b: Partial<Stats>): boolean => (Object.keys(a) as (keyof Stats)[]).every((k) => a[k] === b[k]);

/** What the calc reads of a Pokémon: two candidates that agree on all of it are the same for every oracle and hint. */
const calcKey = (mon: BattleMon): string => JSON.stringify([
  mon.species, mon.form, mon.level, mon.ivs, mon.evs, mon.nature.value, mon.ability.value, mon.item, mon.moves, mon.gender,
  mon.friendship, mon.baseStats, mon.types,
]);

/**
 * The one Pokémon of `player` that the Showdown set `set` was made from (engine/sets.ts `showdownSet`): the same
 * species and form, level, nature, moves, IVs, EVs, ability, held item, gender and friendship. Null when none fits, or
 * when several fit that differ in anything the calc reads: an ambiguous match is never guessed.
 */
export function matchPlayerSet(set: PokemonSet, player: readonly PlayerMon[], moves: ReadonlyMap<number, KaizoMove>, look: Lookups): PlayerMon | null {
  const fits = player.filter((mon) => {
    if (mon.level !== set.level || mon.moves.length !== set.moves.length) return false;
    try {
      if (speciesId(mon.species, mon.form) !== set.species || abilityId(mon.ability.value) !== set.ability || itemId(mon.item) !== set.item) return false;
    } catch {
      return false;
    }
    if (NATURES[mon.nature.value ?? 0] !== set.nature || (mon.gender ?? 'N') !== set.gender || mon.friendship !== set.happiness) return false;
    if (!sameStats(mon.ivs, set.ivs) || !sameStats(mon.evs, set.evs)) return false;
    return mon.moves.every((id, k) => {
      const move = moves.get(id);
      return move !== undefined && look.byId.get(set.moves[k]!) === move;
    });
  });
  if (fits.length === 0) return null;
  return fits.every((mon) => calcKey(mon) === calcKey(fits[0]!)) ? fits[0]! : null;
}

/**
 * The calc field for `a` hitting `b`: the weather (none under Cloud Nine or Air Lock), Trick Room, Gravity, and the
 * Reflect and Light Screen on `b`'s side (the calc ignores them on a crit, as the cartridge does); null for a weather
 * the calc lacks.
 */
export function fieldOf(battle: Battle, a: Active, b: Active): CalcField | null {
  const field: CalcField = {};
  const screens = battle[b.side].sideConditions;
  if (screens['reflect']) field.reflect = true;
  if (screens['lightscreen']) field.lightScreen = true;
  const suppressed = [a, b].some(({ pokemon }) => pokemon.ability === 'cloudnine' || pokemon.ability === 'airlock');
  const weather = battle.field.weather as string;
  if (weather !== '' && !suppressed) {
    const mapped = WEATHERS[weather];
    if (mapped === undefined) return null;
    field.weather = mapped;
  }
  if (battle.field.pseudoWeather['trickroom']) field.trickRoom = true;
  if (battle.field.pseudoWeather['gravity']) field.gravity = true;
  return field;
}

/** The ID of the move `side`'s request offers at `slot` (as `legalChoices` numbers it), or undefined. */
export function requestMoveId(battle: Battle, side: Side, slot: number): string | undefined {
  const request = battle[side].activeRequest as { active?: { moves: { id: string }[] }[] } | null;
  return request?.active?.[0]?.moves[slot]?.id;
}
