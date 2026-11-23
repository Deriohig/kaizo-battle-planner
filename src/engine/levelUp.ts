// A level-up of one of the player's Pokémon, as the cartridge applies it to the party Pokémon and to the active battler
// (the line builder's step).
// - `applyLevel` is one turn of the cartridge's level-up loop, on a live battle. The EXP payout calls it once per level.
// - `levelUp` is the line builder's: a state in, a fresh snapshot out, any number of levels, one `applyLevel` each.
//
// Sources: pret/pokeplatinum at 62bdaac. bs = src/battle/battle_script.c, bl = src/battle/battle_lib.c,
// pk = src/pokemon.c.
//
// The loop (`BattleScript_GetExpTask`): once a Pokémon's EXP is added, `Pokemon_ShouldLevelUp` raises its level by one
// when its EXP reaches the next level's total (bs:9824-9836, pk:3501-3525). For that one level: friendship (bs:9857),
// `Pokemon_CalcStats` (bs:9858), the active battler's reload (bs:9860-9865), then each move the learnset teaches at that
// level (bs:10003-10037). With no move left the task goes back to the EXP check (bs:10012-10014, :9814), so several
// levels from one knock-out are taken one at a time, each with its own moves. A Pokémon in Showdown is both the party
// Pokémon and its battler, so `applyLevel` writes both at once.
//
// One level (`applyLevel`):
// - Level: one up (pk:3520-3522), on the Pokémon and its set (Showdown restores `level` from the set).
// - Stats (`Pokemon_CalcStats`, pk:564-631): the standard formula at the new level, over the Pokémon's own species and
//   form, IVs, EVs and nature; Shedinja's max HP is 1 (pk:598-602). The engine's `spreadModify` over its own species,
//   which `createBattle` runs too (inferred equal: docs/engine-spot-checks.md, "Level-up mid-fight").
// - HP: up by the max HP gained, unless it is 0; Shedinja stays at 1 (pk:633-640).
// - The reload (`BattleSystem_ReloadPokemon`, bl:169-194) copies the five stats, level, friendship, HP and max HP from
//   the party to the active battler, whatever the battler's state, and its moves only when it is not Transformed
//   (bl:183-193). So:
//   - a Transformed battler gets its own new stats back, while its moves, types, ability and species stay the copy's;
//   - Power Trick's swap is overwritten by the natural stats and its flag stays. Using Power Trick again toggles the flag
//     off and swaps them (subscript_user_swap_atk_and_def.s:5-9), as Showdown's `powertrick` does (`onRestart` ends it
//     and its `onEnd` swaps).
//   Not touched: stat stages, status, volatiles, item, ability, types. A benched Pokémon has no battler to reload
//   (bs:9860); its stats take effect when it comes in, as Showdown's are its own.
// - Moves (`Pokemon_LevelUpMove`, pk:3935-3964): each learnset entry of the new level, in ROM order, from the learnset of
//   the Pokémon's own species and form (`Pokemon_LoadLevelUpMovesOf`, pk:4585-4589, by the form's Personal row):
//   - already known: skipped (`BoxPokemon_AddMove`, pk:3864-3867; bs:10008-10010);
//   - a free slot: learned at once, with no prompt, into the first free slot (pk:3857-3862), at full PP with the slot's
//     PP Ups (`BoxPokemon_SetMoveSlot`, pk:3925-3933), which are 0. The active battler gets it unless it is
//     Transformed (bs:10022-10027, bl:183-190);
//   - four moves known: offered ("wants to learn", bs:10016-10019, :10041-10048) and declined.
// - Not modelled: friendship (pk:2623, :2635-2684): nothing in the engine reads it, as Return and Frustration are plain
//   hits (engine/sets.ts). EXP is the payout's. No evolution: the task only marks the Pokémon (bs:9867) and the game
//   evolves after the battle.
//
// `levelUp` raises party member `partyIndex` of p1 to `level` with `applyLevel`, one level at a time, then applies
// `learn`, the line builder's choice. A move the line builder replaces a slot with is the cartridge's "make it forget"
// branch (bs:10162-10181): the new move at full PP with PP Ups 0, and the battler's copy of that slot unless it is
// Transformed or Mimicked (bl:183-190). Applied after the loop, it gives the state the cartridge reaches with that
// choice at its level: the offer comes only with four moves known, and with four known no later level changes a move,
// whichever of the two swapped moves its learnset holds.
//
// The payout (mod/exp.ts) calls `applyLevel` once for each level a knock-out's EXP reaches, inside the step.
// `levelUp` also sets the Pokémon's EXP (`m.exp`, exp.ts) to the new level's total, as a Rare Candy leaves it
// (item_use_pokemon.c:291-292 adds `Pokemon_GetExpToNextLevel`, pk:2308-2319), so the next payout counts from the level
// it now has.

import type { EngineState } from '../contracts/engine.js';
import { restore, snapshot } from './battle.js';
import { growthTableOf, installedMoves, learnsetOf, moveId } from './dex.js';
import { EXP_KEY } from './exp.js';
import { rememberRestored } from './facts.js';

const MAX_LEVEL = 100;
const MAX_MOVES = 4;
const STATS = ['atk', 'def', 'spa', 'spd', 'spe'] as const;

/** A move learned with the level-up: its hack move ID, and the slot (0 to 3) it replaces, or null to add it to a free slot. */
export interface LearnedMove { moveId: number; replaceSlot: number | null }

/**
 * What one level did (`applyLevel`): the level reached, and the hack move IDs it learned into a free slot and offered
 * with four moves known (and declined), each in learnset order. The payout writes its protocol lines from it.
 */
export interface LevelStep { level: number; learned: number[]; offered: number[] }

/**
 * One turn of the cartridge's level-up loop: `pokemon` (party Pokémon and battler) goes up to `level`. See the header for
 * the rule.
 * - `level` must be its level + 1 and at most 100; anything else is a RangeError. So a Pokémon at level 100 throws. The
 *   cartridge leaves it alone instead (`Pokemon_ShouldLevelUp` returns FALSE at 100, pk:3514-3516). The caller asks first,
 *   as it does for the EXP that decides the level.
 * - A fainted Pokémon is not refused: its stats rise and its HP stays 0 (pk:633-640). The cartridge pays it no EXP, so it
 *   never gets here, and the caller skips it.
 * - A learnset move the installed dex lacks is a data error (Error).
 */
export function applyLevel(battle: Battle, pokemon: Pokemon, level: number): LevelStep {
  if (level !== pokemon.level + 1 || level > MAX_LEVEL) {
    throw new RangeError(`${pokemon.name} is at level ${pokemon.level}: one turn of the level-up goes to level ${pokemon.level + 1}, at most ${MAX_LEVEL}, not ${level}`);
  }
  (pokemon as { level: number }).level = level;
  pokemon.set.level = level;
  pokemon.details = ownDetails(pokemon);

  const own = pokemon.baseSpecies; // its own species, also when Transformed: what it reverts to (Showdown's clearVolatile)
  const stats = battle.spreadModify(own.baseStats, pokemon.set);
  if (own.maxHP) stats.hp = own.maxHP; // Shedinja
  const gain = stats.hp - pokemon.baseMaxhp;
  pokemon.baseStoredStats = stats;
  for (const stat of STATS) pokemon.storedStats[stat] = stats[stat];
  pokemon.baseMaxhp = stats.hp;
  pokemon.maxhp = stats.hp;
  if (pokemon.hp > 0) pokemon.hp += gain;
  pokemon.updateSpeed();

  const step: LevelStep = { level, learned: [], offered: [] };
  const { row, moves } = learnsetOf(pokemon.baseSpecies); // its own species and form (dex.ts, the engine's one lookup)
  for (const entry of moves) {
    if (entry.level !== level) continue;
    const kaizo = installedMoves().get(entry.move);
    if (kaizo === undefined) {
      throw new Error(`${pokemon.name}'s learnset (Personal row ${row}) teaches move ${entry.move} at level ${level}, which the installed Kaizo dex lacks: the ROM's learnsets and the installed moves are out of step`);
    }
    const move = battle.dex.moves.get(moveId(kaizo));
    if (pokemon.baseMoveSlots.some((slot) => slot.id === move.id)) continue;
    if (pokemon.baseMoveSlots.length >= MAX_MOVES) {
      step.offered.push(entry.move);
      continue;
    }
    addMove(pokemon, move);
    step.learned.push(entry.move);
  }
  return step;
}

/**
 * `state` with party member `partyIndex` of the player raised to `level` (`applyLevel` for each level in turn), learning
 * `learn` when given. A fresh snapshot, so its key differs from `state`'s. Throws RangeError for a party index with no
 * Pokémon, a fainted Pokémon, a level that is not a whole number above its level now and at most 100, a slot outside its
 * moves once the levels are done (so a slot an earlier level filled can be replaced), a move to add with no
 * free slot left, or a move it knows (unless the level-up learned it into a free slot and `learn` adds it, which changes
 * nothing).
 */
export function levelUp(state: EngineState, partyIndex: number, level: number, learn?: LearnedMove): EngineState {
  const battle = restore(state);
  const side = battle.p1;
  const set = side.team[partyIndex];
  const pokemon = set === undefined ? undefined : side.pokemon.find((p) => p.set === set);
  if (pokemon === undefined) throw new RangeError(`The player has no party member ${partyIndex}`);
  if (pokemon.fainted || pokemon.hp <= 0) throw new RangeError(`${pokemon.name} has fainted and cannot level up`);
  if (!Number.isInteger(level) || level <= pokemon.level || level > MAX_LEVEL) {
    throw new RangeError(`${pokemon.name} is at level ${pokemon.level}: a level-up is to a whole level above it, up to ${MAX_LEVEL}, not ${level}`);
  }

  const learned = new Set<number>();
  for (let next = pokemon.level + 1; next <= level; next++) {
    for (const id of applyLevel(battle, pokemon, next).learned) learned.add(id);
  }
  // The new level's total EXP, as a Rare Candy leaves it (item_use_pokemon.c:291-292), on its species' growth table.
  (pokemon.m as Record<string, unknown>)[EXP_KEY] = growthTableOf(pokemon.baseSpecies.num)[level];

  if (learn !== undefined) {
    const replaceSlot = learn.replaceSlot ?? null;
    if (replaceSlot !== null && (!Number.isInteger(replaceSlot) || replaceSlot < 0 || replaceSlot >= pokemon.baseMoveSlots.length)) {
      throw new RangeError(`${pokemon.name} has no move slot ${replaceSlot}`);
    }
    const move = installedMove(battle, learn.moveId);
    if (pokemon.baseMoveSlots.some((slot) => slot.id === move.id)) {
      if (replaceSlot !== null || !learned.has(learn.moveId)) {
        throw new RangeError(`${pokemon.name} knows ${move.name} already${learned.has(learn.moveId) ? ': the level-up taught it into a free slot' : ''}`);
      }
    } else if (replaceSlot === null) {
      if (pokemon.baseMoveSlots.length >= MAX_MOVES) throw new RangeError(`${pokemon.name} has no free move slot`);
      addMove(pokemon, move);
    } else {
      replaceMove(pokemon, replaceSlot, move);
    }
  }
  // The readers are kept from a restore of the new state, not from `battle`, whose requests predate the level-up (facts.ts).
  return rememberRestored(snapshot(battle));
}

/**
 * Showdown's `details` at the new level, named by its own species: Showdown sets `details` at creation and at a permanent
 * forme change only, so a Transform or a battle forme (Castform's weather forms) leaves it alone, as the cartridge's
 * reload leaves the battler's species (bl:169-194).
 */
function ownDetails(pokemon: Pokemon): string {
  const shown = pokemon.species;
  pokemon.species = pokemon.baseSpecies;
  try {
    return pokemon.getUpdatedDetails();
  } finally {
    pokemon.species = shown;
  }
}

/** The installed mod's move of hack move ID `id` (the line builder's `learn`). Throws if the installed dex has no such move. */
function installedMove(battle: Battle, id: number): Move {
  const kaizo = installedMoves().get(id);
  if (kaizo === undefined) throw new Error(`Move ${id} is not in the installed Kaizo dex`);
  return battle.dex.moves.get(moveId(kaizo));
}

/** A move slot holding `move` at full PP (no PP Ups). */
function freshSlot(move: Move): Pokemon['baseMoveSlots'][number] {
  return { move: move.name, id: move.id, pp: move.pp, maxpp: move.pp, target: move.target, disabled: false, disabledSource: '', used: false };
}

/**
 * `move` into the first free slot at full PP, PP Ups 0 (pk:3857-3862, :3925-3933), on the party Pokémon and, unless it is
 * Transformed, on the battler (bl:183-190), sharing the slot as Showdown's `clearVolatile` does.
 */
function addMove(pokemon: Pokemon, move: Move): void {
  const slot = pokemon.baseMoveSlots.length;
  const fresh = freshSlot(move);
  if (!pokemon.transformed) {
    if (pokemon.moveSlots.length !== slot) throw new Error(`${pokemon.name} has ${pokemon.moveSlots.length} battle move slots for ${slot} of its own`);
    pokemon.moveSlots.push(fresh);
  }
  pokemon.baseMoveSlots.push(fresh);
  pokemon.ppUps[slot] = 0;
  pokemon.set.moves[slot] = move.id;
}

/**
 * `move` over slot `slot` at full PP, PP Ups 0 (bs:10169-10171), on the party Pokémon and on the battler's copy of that
 * slot, which a Transformed or Mimicked battler does not have (bl:183-190).
 */
function replaceMove(pokemon: Pokemon, slot: number, move: Move): void {
  const old = pokemon.baseMoveSlots[slot]!;
  const fresh = freshSlot(move);
  pokemon.baseMoveSlots[slot] = fresh;
  const shared = pokemon.moveSlots.indexOf(old);
  if (shared >= 0) pokemon.moveSlots[shared] = fresh;
  pokemon.ppUps[slot] = 0;
  pokemon.set.moves[slot] = move.id;
}
