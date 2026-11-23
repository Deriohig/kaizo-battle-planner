// Showdown sets for both sides, and the player's HP, PP, status and EXP state before turn 1 (from the save, or from a
// gauntlet's carry: its held item, level, moves, HP, PP and status).

import type { PlayerMon } from '../battle/playerMon.js';
import type { BattleMon, ResolvedMon } from '../battle/types.js';
import type { CarryState, UndrawnSleep, WorldAssignment } from '../contracts/engine.js';
import { NATURES } from '../rom/natures.js';
import type { StartStatus } from '../save/status.js';
import { abilityId, installedMoves, itemId, moveId, speciesId } from './dex.js';
import { EXP_KEY, EXP_RATE_KEY, expRateOf, startExp, startLevel } from './exp.js';
import { SLEEP_PRIOR } from './mod/conditions.js';

/**
 * Showdown names for one side's Pokémon, unique within the side so a protocol line names one party member: each name
 * without "|" (a protocol separator), a repeat getting " 2", " 3" and so on ("Zubat", "Zubat 2").
 */
function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const name = raw.replace(/[|\r\n]/g, '').trim() || 'Pokemon';
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} ${count}`;
  });
}

/**
 * One Showdown set: the hack's species, form and moves (`moveId`), Showdown's ability and item IDs, `nature` (an ID,
 * 0–24), and the mon's friendship as its happiness (`BattleMon.friendship`: the save's for the player's Pokémon, the
 * species' base friendship for the trainer's). Only Showdown's Return and Frustration read happiness; in this hack
 * both are plain 121-power hits, which the mod makes them by dropping Showdown's callbacks.
 */
function showdownSet(mon: BattleMon, name: string, nature: number, ability: number): PokemonSet {
  const moves = installedMoves();
  return {
    name, species: speciesId(mon.species, mon.form), level: mon.level, gender: mon.gender ?? 'N',
    nature: NATURES[nature] ?? fail(`No nature ${nature}`), ability: abilityId(ability), item: itemId(mon.item),
    moves: mon.moves.map((id) => moveId(moves.get(id) ?? fail(`Move ${id} is not in the installed Kaizo dex`))),
    evs: { ...mon.evs }, ivs: { ...mon.ivs }, happiness: mon.friendship,
  };
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * The player's sets, in party order: each named by its nickname, and from `carry`'s entry where it gives one (the party
 * Pokémon at the end of the last fight of a gauntlet), else from the save:
 * - its held item: `CarryState.mons[].item`, 0 for none, else the save's;
 * - its level: the one `CarryState.mons[].exp` reaches on its growth table (exp.ts `startLevel`), else the
 *   save's. Showdown makes the set's stats at that level with `spreadModify` over the Pokémon's own species, the formula
 *   a level-up mid-fight applies (levelUp.ts `applyLevel`; Shedinja's max HP 1 both ways);
 * - its moves: `CarryState.mons[].moves`, ROM move IDs in slot order (`startMoves`), else the save's.
 */
export function playerSets(player: PlayerMon[], carry?: CarryState): PokemonSet[] {
  const names = uniqueNames(player.map((mon) => mon.nickname || mon.name));
  return player.map((mon, index) => {
    const carried = carry?.mons[index];
    const item = carried?.item ?? mon.item;
    const level = startLevel(mon, carried?.exp);
    const moves = [...startMoves(mon, carried?.moves)];
    return showdownSet({ ...mon, item, level, moves }, names[index]!, mon.nature.value ?? 0, mon.ability.value);
  });
}

/** MAX_MON_MOVES. */
const MAX_MOVES = 4;

/**
 * The ROM move IDs `mon` starts a battle with, in slot order: `carried` (`CarryState.mons[].moves`) when given, else the
 * save's. A carried list differs from the save's only where a level-up taught a move into a free slot (or the line
 * builder's `levelUp` replaced one). Throws RangeError for a carried list that is empty, has more than four moves or names
 * a move twice; a move the installed dex lacks fails in `showdownSet`.
 */
function startMoves(mon: PlayerMon, carried: readonly number[] | undefined): readonly number[] {
  if (carried === undefined) return mon.moves;
  if (carried.length < 1 || carried.length > MAX_MOVES) {
    throw new RangeError(`${mon.name}'s carried moves are 1 to ${MAX_MOVES} move IDs, not ${carried.length}`);
  }
  if (new Set(carried).size !== carried.length) throw new RangeError(`${mon.name}'s carried moves name a move twice: ${carried.join(', ')}`);
  return carried;
}

/**
 * The save's `values` (one per save move: its PP or its PP Ups) lined up with `moves`, the moves `mon` starts with: each
 * move's entry in the save's move list, undefined for a move the save lacks.
 */
function bySaveMove(mon: PlayerMon, values: readonly number[], moves: readonly number[]): (number | undefined)[] {
  if (moves === mon.moves) return [...values];
  return moves.map((id) => {
    const k = mon.moves.indexOf(id);
    return k < 0 ? undefined : values[k];
  });
}

/**
 * The trainer's sets, in ROM party order: each named by its species. A nature the data lacks is Hardy; `world` (ROM
 * numbers per party index) overrides the nature and ability.
 */
export function enemySets(party: ResolvedMon[], world?: WorldAssignment): PokemonSet[] {
  const names = uniqueNames(party.map((mon) => mon.name));
  return party.map((mon, index) => {
    const override = world?.enemy[index];
    return showdownSet(mon, names[index]!, override?.nature ?? mon.nature.value ?? 0, override?.ability ?? mon.ability.value);
  });
}

/**
 * Sets `pokemon`'s PP and maximum PP: maximum PP is the Gen 4 formula's, base PP + base PP × PP Ups / 5 rounded down
 * (Showdown would give every move 3 PP Ups; `ppUps[k]` default 0); `pp[k]` (default full) is clamped to it, so a value
 * above the maximum means full PP (the contract's `CarryState.pp`: a heal needs no move data).
 */
export function setMovePp(pokemon: Pokemon, pp: readonly (number | undefined)[] | null, ppUps: readonly (number | undefined)[]): void {
  pokemon.baseMoveSlots.forEach((slot, k) => {
    const ups = ppUps[k] ?? 0;
    const base = pokemon.battle.dex.moves.get(slot.id).pp;
    slot.maxpp = Math.floor((base * (5 + ups)) / 5);
    slot.pp = Math.max(0, Math.min(slot.maxpp, pp?.[k] ?? slot.maxpp));
    pokemon.ppUps[k] = ups;
  });
}

const STATUS_IDS: Record<StartStatus['kind'], string> = { none: '', sleep: 'slp', poison: 'psn', toxic: 'tox', burn: 'brn', freeze: 'frz', paralysis: 'par' };

/** How far one attempt asleep lowers the counter: 2 with Early Bird, else 1 (bcp:2442-2447). */
const sleepStep = (ability: string): number => (ability === 'earlybird' ? 2 : 1);

/**
 * Gives `pokemon` `status` without Showdown's start handlers, which would log it (and, in Showdown's own sleep, roll a
 * length). Sleep takes one of two forms (mod/conditions.ts, `slp`):
 * - a known counter, `{ kind: 'sleep', turns }` (the save's, or pre-sleep's 1): `statusState.time` = c, lowered before
 *   each move attempt; the Pokémon wakes and acts once it reaches 0, so c − 1 attempts asleep, then it acts on attempt c;
 * - an undrawn counter carried from an earlier fight (`UndrawnSleep`, a move's sleep): `statusState.slept` = the counter
 *   used up so far = `attempts` × the Pokémon's own step (2 with Early Bird), so its wake chances go on from attempt
 *   `attempts + 1` as they would have in that fight. Throws when no counter (2..5) outlasts that much.
 */
export function setStartStatus(pokemon: Pokemon, status: StartStatus | UndrawnSleep): void {
  if (status.kind === 'sleepUndrawn') {
    const { attempts } = status;
    if (!(Number.isInteger(attempts) && attempts >= 0)) throw new RangeError(`Attempts asleep must be a whole number from 0, not ${attempts}`);
    const slept = attempts * sleepStep(pokemon.baseAbility);
    if (!SLEEP_PRIOR.some(({ value }) => value > slept)) throw new RangeError(`No sleep counter outlasts ${attempts} attempts asleep`);
    pokemon.status = 'slp' as ID;
    pokemon.statusState = pokemon.battle.initEffectState({ id: 'slp' as ID, target: pokemon, slept });
    return;
  }
  if (status.kind === 'sleep' && !(Number.isInteger(status.turns) && status.turns >= 1)) {
    throw new RangeError(`A sleep counter must be a whole number from 1, not ${status.turns}`);
  }
  const id = STATUS_IDS[status.kind] as ID;
  pokemon.status = id;
  const extra = status.kind === 'sleep' ? { time: status.turns } : status.kind === 'toxic' ? { stage: 0 } : {};
  pokemon.statusState = pokemon.battle.initEffectState(id === '' ? {} : { id, target: pokemon, ...extra });
}

/**
 * `pokemon`'s status as `setStartStatus` reads it (a fainted Pokémon has none). Sleep with a known counter gives its
 * `time` (`{ kind: 'sleep', turns }`); a move's sleep, whose counter was never drawn, gives `UndrawnSleep` with
 * `attempts` = the counter used up (`slept`) over the Pokémon's own step. That is the attempts it spent asleep, unless its
 * ability changed mid-sleep, and it restores the same wake chances either way. Throws for the one sleep it can't carry:
 * a Pokémon with Early Bird of its own that slept an attempt without it (an odd counter used up).
 */
export function startStatusOf(pokemon: Pokemon): StartStatus | UndrawnSleep {
  switch (pokemon.hp > 0 ? pokemon.status : '') {
    case 'slp': {
      const state = pokemon.statusState;
      if (typeof state['time'] === 'number') return { kind: 'sleep', turns: state['time'] };
      const slept = (state['slept'] as number | undefined) ?? 0;
      const step = sleepStep(pokemon.baseAbility);
      if (slept % step !== 0) {
        throw new Error(`${pokemon.name} used up ${slept} of an undrawn sleep counter with its Early Bird off for an attempt: no UndrawnSleep carries that`);
      }
      return { kind: 'sleepUndrawn', attempts: slept / step };
    }
    case 'psn': return { kind: 'poison' };
    case 'tox': return { kind: 'toxic' };
    case 'brn': return { kind: 'burn' };
    case 'frz': return { kind: 'freeze' };
    case 'par': return { kind: 'paralysis' };
    default: return { kind: 'none' };
  }
}

/**
 * Sets `pokemon`'s current HP, clamped to its maximum (at the level it starts at), so a value above the maximum means full
 * HP (the contract's `CarryState.hp`: a heal needs no stats). Throws for 0 or less: a fainted Pokémon cannot start a battle.
 */
function setStartHp(pokemon: Pokemon, hp: number, index: number): void {
  if (!(hp > 0)) throw new RangeError(`Player party index ${index} would start the battle with ${hp} HP`);
  pokemon.hp = Math.min(pokemon.maxhp, Math.floor(hp));
}

/**
 * Before turn 1, gives each of the player's Pokémon (`side.pokemon`, still in party order, at the level and with the moves
 * `playerSets` gave it) the save's current HP, PP (with its PP Ups) and status, then `carry`'s, then `startStatus`'s
 * status. `carry`'s held item is in the set already (`playerSets`).
 * - PP and PP Ups go by move: `pp` is indexed by `carry`'s `moves` when it gives them, else by the save's moves (the
 *   contract). Each move the save has keeps the save's PP Ups, and a move it lacks (learned into a free slot) has none
 *   (pk:3925-3933), its save PP full (`bySaveMove`).
 * - HP and PP above their maximum mean full (`setStartHp`, `setMovePp`), the maximum of the level it starts at.
 * - Its EXP state (exp.ts): `m.exp`, from `carry`'s EXP when it gives one (whose level `playerSets`
 *   took), else the save's when it fits the level, else the level's own total (`startExp`), and `m.expRate`, its origin's
 *   multiplier (`expRateOf`).
 */
export function applyPlayerStart(side: Battle['p1'], player: PlayerMon[], carry?: CarryState, startStatus?: Record<number, StartStatus>): void {
  player.forEach((mon, index) => {
    const pokemon = side.pokemon[index]!;
    const carried = carry?.mons[index];
    const moves = startMoves(mon, carried?.moves);
    const ppUps = bySaveMove(mon, mon.ppUps, moves);
    setStartHp(pokemon, mon.currentHp, index);
    setMovePp(pokemon, bySaveMove(mon, mon.pp, moves), ppUps);
    setStartStatus(pokemon, mon.status);
    if (carried !== undefined) {
      setStartHp(pokemon, carried.hp, index);
      setMovePp(pokemon, carried.pp, ppUps);
      setStartStatus(pokemon, carried.status);
    }
    const start = startStatus?.[index];
    if (start !== undefined) setStartStatus(pokemon, start);
    const m = pokemon.m as Record<string, unknown>;
    m[EXP_KEY] = startExp(mon, carried?.exp);
    m[EXP_RATE_KEY] = expRateOf(mon.origin);
  });
}
