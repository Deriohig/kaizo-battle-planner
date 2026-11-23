// The EXP a knock-out pays, as the cartridge computes it, and the EXP each of the player's Pokémon starts a battle with.
//
// Sources: pret/pokeplatinum at 62bdaac. bs = src/battle/battle_script.c, bl = src/battle/battle_lib.c,
// pk = src/pokemon.c. The hack's EXP routines are the vanilla ones.
//
// `expGain` is the formula, pure: `BtlCmd_CalcExpGain` (bs:2187-2245) works out the shares once per enemy faint, then
// `BattleScript_GetExpTask` (bs:9685-9775) visits each party slot in order and pays it. Paying it out mid-fight is `mod/exp.ts`'s, and so is who took part (the
// mask). The adapters read a live battle as the routine reads the cartridge:
// - `expEnemyOf`: the fainted enemy's species and level;
// - `expSlotOf`: one of the player's party slots, its item by `expItemOf`.
//
// State, in each of the player's Pokémon's Showdown mod data (`Pokemon.m`, serialised, so in the state key: key.ts):
// - `m.exp` (`EXP_KEY`): its total EXP, from `startExp` at `createBattle` (sets.ts `applyPlayerStart`), at the level
//   `startLevel` gives (sets.ts `playerSets`); a gauntlet's carry gives both, and `carryOut` gives it back;
// - `m.expRate` (`EXP_RATE_KEY`): its origin's multiplier (`EXP_RATE`), fixed for the battle.
// The trainer's Pokémon have neither: the cartridge pays only the player's side (bs:2196, bs:9701).

import type { PlayerMon } from '../battle/playerMon.js';
import { baseExpOf, growthTableOf } from './dex.js';
import { itemId } from './ids.js';
import { heldData } from './mod/itemData.js';
import { KNOCKED_OFF_KEY } from './mod/moves.js';

/** `Pokemon.m` key: the Pokémon's total EXP. */
export const EXP_KEY = 'exp';

/** `Pokemon.m` key: the Pokémon's EXP rate (`EXP_RATE` of its origin), fixed for the battle. */
export const EXP_RATE_KEY = 'expRate';

/** HOLD_EFFECT_EXP_SHARE, the Exp. Share's hold effect (generated/item_hold_effects.txt:52, a line number less one). */
export const HOLD_EFFECT_EXP_SHARE = 51;

/** HOLD_EFFECT_EXP_UP, the Lucky Egg's hold effect (generated/item_hold_effects.txt:67). */
export const HOLD_EFFECT_EXP_UP = 66;

/**
 * The traded multiplier of each origin, ×rate/100 (bs:9757-9765): none for the save's own Pokémon
 * (`BattleSystem_PokemonIsOT`, bl:6286-6302), 150 for a traded one of the game's language (`gGameLanguage`, English, 2:
 * src/game_version.c:4), 170 for one of another language. `PlayerMon.origin` settles which (the save reader, playerMon.ts).
 */
export const EXP_RATE: Readonly<Record<NonNullable<PlayerMon['origin']>, number>> = { own: 100, traded: 150, tradedOtherLanguage: 170 };

/** The origin's EXP rate (`EXP_RATE`); absent means own. Throws RangeError for anything else. */
export function expRateOf(origin: PlayerMon['origin']): number {
  const rate = Object.hasOwn(EXP_RATE, origin ?? 'own') ? EXP_RATE[origin ?? 'own'] : undefined;
  if (rate === undefined) throw new RangeError(`A Pokémon's origin is 'own', 'traded' or 'tradedOtherLanguage', not ${JSON.stringify(origin)}`);
  return rate;
}

/** MAX_POKEMON_LEVEL. */
const MAX_LEVEL = 100;

/**
 * The fainted enemy as the formula reads its battler (`battleMons[faintedMon]`, bs:2216-2217): its own species (National
 * Dex number) and level, and the species it copied when it is Transformed. `BtlCmd_Transform` copies the battler's
 * fields up to and including the ability, the species among them but not the level (bs:5345-5348; battle_mon.h:57-84),
 * so a Transformed enemy pays the copied species' base EXP at its own level.
 */
export interface ExpEnemy { species: number; level: number; transformedInto?: number }

/**
 * One of the player's party slots as the routine reads it, in party order:
 * - `hp`: the party Pokémon's HP, which is its battler's (written at every HP change);
 * - `level`: its level;
 * - `holdEffect`: the hold effect of the party Pokémon's item (`MON_DATA_HELD_ITEM`, bs:2209-2210, :9705-9707,
 *   :9724-9725), 0 for none: from a battle, `expSlotOf`;
 * - `expRate`: its origin's multiplier (`EXP_RATE`);
 * - `participant`: its bit in the fainted enemy's mask (`sideGetExpMask`, bs:2205, :9709, :9741).
 */
export interface ExpSlot { hp: number; level: number; holdEffect: number; expRate: number; participant: boolean }

/** What one enemy faint pays from: the enemy, the player's whole party in order, and whether it is a trainer battle. */
export interface ExpInput { enemy: ExpEnemy; party: readonly ExpSlot[]; trainerBattle: boolean }

/**
 * The EXP each of `input.party`'s slots gets for one enemy faint, in party order, exactly as the cartridge computes it.
 * Every division is the cartridge's integer one, a floor. `baseExp` gives a species' base EXP yield (default: the
 * installed dex's, `baseExpOf`). Throws RangeError for an enemy level outside 1 to 100.
 *
 * The shares (`BtlCmd_CalcExpGain`, bs:2187-2245):
 * - bs:2201-2214: over the whole party, A counts the living Pokémon (`MON_DATA_HP` not 0, bs:2204) whose bit is in the
 *   mask (bs:2205-2207), S the living ones whose item has the Exp. Share's hold effect (bs:2209-2212). No level check:
 *   a level 100 Pokémon counts in both.
 * - bs:2216: base = the base EXP of the battler's species, the copied one when Transformed (`ExpEnemy`).
 * - bs:2217: exp = ⌊base × level / 7⌋, the enemy's own level. (`exp` is a u16; at most ⌊255 × 100 / 7⌋ = 3642, so the
 *   store never wraps.)
 * - bs:2219-2230: with S > 0, gained = ⌊⌊exp / 2⌋ / A⌋ and shared = ⌊⌊exp / 2⌋ / S⌋, each at least 1;
 * - bs:2231-2239: with S = 0, gained = ⌊exp / A⌋, at least 1, and shared = 0.
 * - A = 0 (every participant has fainted): bs:2220 and :2232 divide by 0, but nothing reads `gained` then, as no living
 *   Pokémon has a bit in the mask. It is never computed here.
 *
 * The payout (`BattleScript_GetExpTask`, bs:9685-9775), slot by slot:
 * - bs:9703-9712: a slot is visited when its item has the Exp. Share's hold effect or its bit is in the mask; any other
 *   slot gets nothing.
 * - bs:9740: it is paid only when its HP is not 0 and its level is not 100.
 * - bs:9741-9743: total = gained when its bit is in the mask;
 * - bs:9745-9747: + shared when it holds an Exp. Share;
 * - bs:9749-9751: ×150/100 when it holds a Lucky Egg (HOLD_EFFECT_EXP_UP);
 * - bs:9753-9755: ×150/100 in a trainer battle;
 * - bs:9757-9765: ×150/100 when traded, ×170/100 when traded and of another language (`expRate`), each step floored.
 * - bs:9767-9775: the total is added to its EXP (`mod/exp.ts` then runs the level-up).
 * One slot's level-up comes before the next slot is paid, but it changes nothing the next slot's payment reads: the
 * shares are fixed at bs:2219-2239, and a slot's HP, level and item are its own.
 */
export function expGain(input: ExpInput, baseExp: (species: number) => number = baseExpOf): number[] {
  const { enemy, party, trainerBattle } = input;
  if (!Number.isInteger(enemy.level) || enemy.level < 1 || enemy.level > MAX_LEVEL) {
    throw new RangeError(`An enemy's level is a whole number from 1 to ${MAX_LEVEL}, not ${enemy.level}`);
  }
  // bs:2201-2214.
  let participants = 0;
  let holders = 0;
  for (const slot of party) {
    if (slot.hp <= 0) continue;
    if (slot.participant) participants++;
    if (slot.holdEffect === HOLD_EFFECT_EXP_SHARE) holders++;
  }
  // bs:2216-2217.
  const exp = Math.floor((baseExp(enemy.transformedInto ?? enemy.species) * enemy.level) / 7);
  // bs:2219-2239. With no living participant `gained` is never read (bs:9740-9743), so it is left at 0.
  const atLeastOne = (share: number): number => Math.max(1, share);
  let gained = 0;
  let shared = 0;
  if (holders > 0) {
    if (participants > 0) gained = atLeastOne(Math.floor(Math.floor(exp / 2) / participants)); // bs:2220-2224
    shared = atLeastOne(Math.floor(Math.floor(exp / 2) / holders)); // bs:2226-2230
  } else if (participants > 0) {
    gained = atLeastOne(Math.floor(exp / participants)); // bs:2232-2236; shared stays 0 (bs:2238)
  }
  return party.map((slot) => {
    const sharing = slot.holdEffect === HOLD_EFFECT_EXP_SHARE;
    if (!sharing && !slot.participant) return 0; // bs:9709: not visited
    if (slot.hp <= 0 || slot.level === MAX_LEVEL) return 0; // bs:9740
    let total = 0;
    if (slot.participant) total = gained; // bs:9741-9743
    if (sharing) total += shared; // bs:9745-9747
    if (slot.holdEffect === HOLD_EFFECT_EXP_UP) total = Math.floor((total * 150) / 100); // bs:9749-9751
    if (trainerBattle) total = Math.floor((total * 150) / 100); // bs:9753-9755
    if (slot.expRate !== EXP_RATE.own) total = Math.floor((total * slot.expRate) / 100); // bs:9757-9765
    return total;
  });
}

/**
 * The fainted enemy `pokemon` as `expGain` reads it (`ExpEnemy`): its own species and level, and the species it copied
 * when it is Transformed (Showdown's `transformInto` sets `species` and leaves `baseSpecies` and `level`). A form reads
 * as its species: the formula takes the species ID alone (bs:2216), so Deoxys-Attack pays Deoxys's row, never its own.
 * It is called before Showdown's faint clears the Transform.
 */
export function expEnemyOf(pokemon: Pokemon): ExpEnemy {
  const own = pokemon.baseSpecies.num;
  return pokemon.transformed ? { species: own, level: pokemon.level, transformedInto: pokemon.species.num } : { species: own, level: pokemon.level };
}

/**
 * The Showdown ID of the item the routine reads for the player's party Pokémon `pokemon`, '' for none: the party's
 * `MON_DATA_HELD_ITEM` (bs:2209, :9706, :9724), not the battler's. The party holds the battler's item after every item
 * change (battle_io_command.c:590-592), except after Knock Off, which empties the battler's item with no copy to the
 * party (bs:6624-6628), so the party keeps the item knocked off (mod/moves.ts `KNOCKED_OFF_KEY`): a Knocked Off Lucky Egg
 * or Exp. Share still pays. An item eaten, used up or Flung is written to the party, so
 * the current item counts. The routine reads the item table directly, with no Klutz or Embargo check (bs:2210, :9707).
 */
export function expItemOf(pokemon: Pokemon): string {
  const knockedOff = (pokemon.m as Record<string, unknown>)[KNOCKED_OFF_KEY];
  return typeof knockedOff === 'string' ? knockedOff : pokemon.item;
}

/** ROM item IDs of the Exp. Share and the Lucky Egg (the hack ROM's item data, test/unit/engine/fixtures.ts). */
const ITEM_EXP_SHARE = 216;
const ITEM_LUCKY_EGG = 231;

/**
 * The vanilla hold effects of the two items the routine reads, by Showdown ID (`itemId`: "item216" and "item231", as no
 * Showdown battle item names them), for data without item records (mod/itemData.ts `heldData`).
 */
const VANILLA_HOLD: ReadonlyMap<string, number> = new Map([[itemId(ITEM_EXP_SHARE), HOLD_EFFECT_EXP_SHARE], [itemId(ITEM_LUCKY_EGG), HOLD_EFFECT_EXP_UP]]);

/** The hold effect of item `id` (a Showdown ID): the installed ROM's (`heldData`), or with no item data the vanilla one. */
function holdEffectOf(id: string): number {
  if (id === '') return 0;
  return heldData(id)?.effect ?? VANILLA_HOLD.get(id) ?? 0;
}

/**
 * The player's party Pokémon `pokemon` as `expGain` reads it (`ExpSlot`): its HP and level, the hold effect of its item
 * (`expItemOf`), its EXP rate (`m.expRate`, set at `createBattle`), and `participant`, its bit in the enemy's mask.
 */
export function expSlotOf(pokemon: Pokemon, participant: boolean): ExpSlot {
  const rate = (pokemon.m as Record<string, unknown>)[EXP_RATE_KEY];
  if (typeof rate !== 'number') throw new Error(`${pokemon.name} has no EXP rate: only the player's Pokémon get EXP`);
  return { hp: pokemon.hp, level: pokemon.level, holdEffect: holdEffectOf(expItemOf(pokemon)), expRate: rate, participant };
}

/** Whether `exp` is a total EXP of level `level` on growth table `table`: from its total up to the next level's, any at 100. */
function fitsLevel(table: readonly number[], level: number, exp: number): boolean {
  return Number.isInteger(exp) && exp >= table[level]! && (level === MAX_LEVEL || exp < table[level + 1]!);
}

/** What `startLevel` and `startExp` read of the player's Pokémon. */
type StartMon = Pick<PlayerMon, 'species' | 'level' | 'exp' | 'name'>;

/**
 * The level and EXP `mon` starts a battle with, on its species' growth table
 * (`growthTableOf`), so that `growth[level] <= exp < growth[level + 1]` always holds (any EXP from the level 100 total at
 * level 100):
 * - with `carried`, `CarryState.mons[].exp`: that EXP, a whole number from 0, at the level the growth
 *   table gives for it (`levelFromExp`'s rule, src/rom/growth.ts), whatever `mon.level` says. So a level gained in one
 *   fight of a gauntlet carries into the next, as the contract says, and so does a lower one;
 * - else at `mon.level`, with the save's EXP (`PlayerMon.exp`) when it fits that level (at level 100 any EXP from its
 *   total, as the cartridge clamps only when EXP is added: pk:1853-1854, pk:3509-3512), else (a what-if level, or no save
 *   EXP) the level's own total, as a Rare Candy leaves it: it adds the EXP to the next level (item_use_pokemon.c:291-294;
 *   pk:2313-2320).
 * Throws RangeError for a carried EXP that is not a whole number from 0, and, without one, for a level outside 1 to 100.
 */
function start(mon: StartMon, carried: number | undefined): { level: number; exp: number } {
  const table = growthTableOf(mon.species);
  if (carried !== undefined) {
    if (!Number.isInteger(carried) || carried < 0) throw new RangeError(`${mon.name}'s carried EXP is a whole number from 0, not ${carried}`);
    // Levels 0 and 1 both start at 0 EXP, so the last level reached is 1 at least; the table ends at level 100.
    return { level: table.findLastIndex((total) => total <= carried), exp: carried };
  }
  if (!Number.isInteger(mon.level) || mon.level < 1 || mon.level > MAX_LEVEL) {
    throw new RangeError(`${mon.name}'s level is a whole number from 1 to ${MAX_LEVEL}, not ${mon.level}`);
  }
  const exp = mon.exp !== undefined && fitsLevel(table, mon.level, mon.exp) ? mon.exp : table[mon.level]!;
  return { level: mon.level, exp };
}

/** The level `mon` starts a battle at (`start`): the carried EXP's level when the carry gives EXP, else `mon.level`. */
export function startLevel(mon: StartMon, carried?: number): number {
  return start(mon, carried).level;
}

/** The EXP `mon` starts a battle with (`m.exp`; `start`): the carried EXP, else the save's when it fits, else the level's total. */
export function startExp(mon: StartMon, carried?: number): number {
  return start(mon, carried).exp;
}
