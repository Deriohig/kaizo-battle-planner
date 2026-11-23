// The cartridge's EXP participation mask, and the payout of EXP at each
// enemy faint, with the level-ups it brings, at the cartridge's points.
// Citations are pokeplatinum at 62bdaac: bs = src/battle/battle_script.c, bl = src/battle/battle_lib.c,
// bcp = src/battle/battle_controller_player.c, pk = src/pokemon.c, sub/ = res/battle/scripts/subscripts/.
//
// THE MASK. For the enemy's active Pokémon, which of the player's party slots count as having fought it. The cartridge
// (verified):
// - `battleCtx->sideGetExpMask[(battler >> 1) & 1]` (include/battle/battle_context.h:176): one u32 of the player's
//   party slots per enemy battler position, so one in a single battle.
// - Bit i is party slot i: `FlagIndex(battleCtx->selectedPartySlot[side])` (bl:1470). `selectedPartySlot` is the slot in
//   the party itself, set to the new battler's slot by `BtlCmd_SwitchAndUpdateMon` (bs:2513) before each send-out;
//   switches reorder only the display order `partyOrder` (`BattleSystem_SwitchSlots`, bl:6476-6507), never the party.
//   The engine's party index (the set's index in `side.team`, battle.ts `partyIndexOf`) is that slot.
// - `BattleSystem_ClearSideExpGain(enemy)` (bl:1456-1459) empties the enemy's mask.
// - `BattleSystem_FlagBattlerExpGain(enemy)` (bl:1461-1478) ORs in the bit of the player's active slot
//   (`selectedPartySlot[0]`; the loop's side 2 is out in a single battle, bl:2031-2034) when neither battler is out of
//   Pokémon (`battlersSwitchingMask`, set only for a side whose party has no HP left: bcp:4108-4111, :4133-4135) and the
//   enemy battler's HP is above 0 (bl:1469). It never reads the player's Pokémon's HP.
// - Only the two "show a Pokémon" commands call them, `BtlCmd_PokemonSlideIn` (bs:437-536) and `BtlCmd_PokemonSendOut`
//   (bs:543-634):
//   - one of the player's Pokémon shown: flag each enemy (bs:465-466, :486-487, :501-502, :516-517; bs:571-572,
//     :592-593, :607-608, :621-622);
//   - an enemy Pokémon shown: clear its mask, then flag it (bs:474-475, :489-490, :504-505, :519-520; bs:580-581,
//     :595-596, :610-611, :625-626).
// - Every send-out runs one of them, then the hazards check (`BATTLE_SUBSCRIPT_HAZARDS_CHECK`), so the mask is set
//   while the newcomer still has the HP it came in with:
//
//   | Send-out                                         | Script line (show)                                   | Hazards |
//   |--------------------------------------------------|------------------------------------------------------|---------|
//   | trainer battle start, enemy then player           | sub/subscript_start_encounter.s:84, :91 (SlideIn)    | none    |
//   | (a recorded battle: player, then enemy)           | sub/subscript_start_encounter.s:111, :118            | none    |
//   | a switch chosen for the turn, either side         | sub/subscript_switch_pokemon.s:39 (SendOut)          | :43     |
//   | U-turn, either side                               | sub/subscript_attack_then_switch_out.s:71, then      |         |
//   |                                                   | sub/subscript_show_party_list.s:18 (SendOut)         | :22     |
//   | Baton Pass, either side                           | sub/subscript_baton_pass.s:17, then show_party_list  | :22     |
//   | a replacement after a faint, either side          | sub/subscript_replace_fainted.s:58 (SendOut)         | :62     |
//   | Roar or Whirlwind, the Pokémon dragged in         | sub/subscript_force_target_to_switch_or_flee.s:22    | :31     |
//
// So, for the enemy's active Pokémon E: its mask holds the slots of the player's that were out at any moment since E's latest
// send-out while E had HP. An enemy send-out (its switch, U-turn, Baton Pass, replacement, or a Roar on it) starts it
// again as the player's active Pokémon alone: whoever fought E before no longer counts, even when E comes back. The player's
// send-outs (a switch, U-turn, Baton Pass, a replacement, a Roar on his Pokémon) add the newcomer, unless E has 0 HP:
// a U-turn that knocked E out (the U-turn user keeps its bit and is paid on the bench), or both sides replacing at once,
// which sends the player's first (`switchedMon` is the lowest switching battler: bs:2408-2413, bs:2546-2552; the engine's
// mod/speedOrder.ts `replacePlayerFirst`).
//
// In Showdown every send-out is one `BattleActions.switchIn` call (sim/battle-actions.ts): a switch or replacement
// action (sim/battle.ts `runAction`, 'switch' and 'instaswitch'), a drag (`dragIn`), and the battle start ('start': p1's
// lead, then p2's). Its hazards and other switch-in effects come later, in the newcomer's own `runSwitch` action. The
// mod wraps `switchIn` (mod/scripts.ts) and calls `noteSendOut` when the base call succeeds, before `runSwitch`, as on
// the cartridge.
//
// Canonical form (design 2.3), so equal futures get equal keys: the mask never holds the bit of a Pokémon of the player's with
// 0 HP. Each send-out write drops the bits of those that fainted, and so does every faint (`faintMessages`, below), and
// `expMask` reads it through `livingOnly` whatever is stored. The cartridge keeps such bits (an enemy sent out while
// The player's active Pokémon lies fainted flags its slot: bl:1470 reads no HP of the player's), but never pays them: the payout
// counts and pays only Pokémon with HP above 0 (`BtlCmd_CalcExpGain`, bs:2204-2206; `BattleScript_GetExpTask`, bs:9740),
// and nothing in the engine revives (should a Revive used by the player ever be modelled, a revived Pokémon that fought would
// be paid on the cartridge and not here). After a payout the mask is 0: every visited slot's bit is cleared as its turn
// in the payout ends (`SEQ_GET_EXP_CHECK_DONE`, bs:10190-10192).
//
// THE PAYOUT. The cartridge marks each faint for payout (`BtlCmd_PlayFaintAnimation`,
// bs:1796-1806) and pays the lowest marked battler (`BattleControllerPlayer_AnyExpPayout`, bcp:4449-4469) at three
// points, each before the battle-over check and before any replacement:
//   1. the end of every move, after its after-hit effects and faints (`BattleControllerPlayer_MoveEnd`, bcp:3962-3972);
//   2. the top of each end-of-turn loop, right after a weather, poison, burn or Leech Seed faint (bcp:940-941,
//      :1295-1296);
//   3. the turn's end (`BattleControllerPlayer_TurnEnd`, bcp:1846, before `CheckBattleOver` and `ReplaceFainted`):
//      Future Sight, Doom Desire and Perish Song faints, whose end-of-turn group (`CheckSideConditions`,
//      bcp:1737-1842: Future Sight, then Perish Song, then Trick Room's end) runs only the faint check.
// The engine (Showdown's flow):
// - `faintMessages` (a `Scripts` entry, so it replaces Showdown's on every battle) records the trainer's active Pokémon
//   before Showdown's faint runs (`expEnemyOf`: the faint clears a Transform, sim/battle.ts `faintMessages`), and each
//   one that faints becomes a pending payout (`EXP_PENDING_KEY`) or is paid at once.
// - (a) Every action but the end of turn: Showdown's `runAction` returns (mod/speedOrder.ts `runAction` calls
//   `runActionPaying`) and every pending faint is paid. Showdown's recoil, Life Orb and Shell Bell have run
//   (battle-actions.ts `runMove`), no other action has started and no choice has been made: the cartridge's point 1.
//   A replacement request made at the action's end is made again by every reader from the state (facts.ts), so it shows
//   the payout.
// - (b) Inside the end of turn (`residual`): paid at once, in `faintMessages`, which Showdown calls after each residual
//   handler (sim/battle.ts `fieldEvent`): the cartridge's point 2. Every check after it reads the new level's HP, Micle
//   Berry's too: its two steps are in its holder's own list (mod/items.ts), so a holder whose list ran before
//   the fainting enemy's was checked before the level-up, as on the cartridge (bcp:1362-1368, :1699-1709).
// - (c) the player's U-turn that knocks the enemy out: the cartridge sends the player's newcomer in and checks its hazards inside
//   the move's script (the switch at sub/subscript_attack_then_switch_out.s:71; sub/subscript_show_party_list.s:18,
//   :22), and pays at `MoveEnd` after it. So while the battle waits on the player's mid-move switch the pending faint stays in
//   the state (and its key, at the `playerMidTurnSwitch` state), and it is paid when the newcomer's `runSwitch` (its
//   hazards) ends. The newcomer has no bit (the enemy has 0 HP, bl:1469), and the U-turn user is paid on the bench.
// - (d) A Future Sight, Doom Desire or Perish Song faint in the end of turn stays pending and is paid when the
//   `residual` action ends: the cartridge's point 3. That payout is the last thing of the end of turn in both (bcp:1846
//   after `CheckSideConditions`; here after Showdown's `fieldEvent`), so a handler Showdown runs after such a faint (Slow
//   Start, order 28; White Herb, 29; Truant's and a volatile's end, no order) runs before the payout on both sides and
//   cannot change it; only its order against the knock-out itself is Showdown's. The turn start's
//   held-item check comes after the payout on both (`ShowBattleMon`, bcp:254-266; mod/speedOrder.ts `endTurn`).
// - Pursuit on a switching enemy: paid when the switch action ends; the cartridge pays inside the Pursuit script
//   (sub/subscript_pursuit.s:108), before the new enemy is shown. Gen 4's requeued switch (sim/battle.ts `runAction`,
//   `'pursuitfaint'`) is its own action, so the new enemy's send-out comes after the payout. Seven lines later the script
//   corrupts the field conditions when the player's Pursuit made the knock-out ("Acid Rain", :115): the engine notes that,
//   mod/moves.ts `PURSUIT_FIELD_NOTE`.
//
// Each payout (`payOut`, `BattleScript_GetExpTask` bs:9685-10201): the formula is exp.ts `expGain`, with the mask as
// above; each paid Pokémon's EXP goes up (bs:9767-9775), then `Pokemon_ShouldLevelUp` (pk:3501-3525) clamps it to the
// level 100 total and raises the level by one while it reaches the next level's total, each level one `applyLevel`
// (levelUp.ts) with its moves (bs:9824-10037). Protocol lines, public, in party order, for each paid
// Pokémon (none for one that got 0: fainted, not visited, or level 100):
//   |-kaizoexp|IDENT|N                 own Pokémon ("X gained N Exp. Points!", bs:9737)
//   |-kaizoexp|IDENT|N|[boosted]       traded ("X gained a boosted N Exp. Points!", bs:9765)
//   |-kaizolevel|IDENT|LEVEL           each level gained, in order (bs:9870-9875)
//   |-kaizolearn|IDENT|MOVE NAME       a move learned into a free slot (bs:10030-10035)
//   |-kaizooffer|IDENT|MOVE NAME       a move offered with four moves known, and declined (bs:10043-10048)
// IDENT is Showdown's (`p1a: NAME` when active, `p1: NAME` on the bench); MOVE NAME the installed move's name, as on
// `|move|` lines. Every engine battle is a trainer battle (`BattleInput.trainer`), so the trainer multiplier always
// applies (`BATTLE_TYPE_TRAINER`, bs:9753-9755). No draw anywhere.

import PS from 'pokemon-showdown';
import type { Side } from '../../contracts/engine.js';
import { partyIndexOf } from '../battle.js';
import { growthTableOf, installedMoves, moveId } from '../dex.js';
import { EXP_KEY, EXP_RATE, EXP_RATE_KEY, type ExpEnemy, expEnemyOf, expGain, expSlotOf } from '../exp.js';
import { applyLevel } from '../levelUp.js';

const { Battle } = PS;

/**
 * `formatData` key: the participation mask of the trainer's active Pokémon, bit i for the player's party index i
 * (`side.team`). Written at every send-out from the battle's start on, so every state holds it, in its JSON and its key
 * (key.ts); canonical (no bit of a Pokémon with 0 HP), and 0 after each payout (design 2.3).
 */
export const EXP_MASK_KEY = 'kaizoExpMask';

/**
 * `formatData` key: the enemy faints whose EXP is not paid yet, each as `expGain` reads the enemy (`ExpEnemy`), recorded
 * before the faint. It is emptied before every action ends but in one case, the player's U-turn that knocks the enemy out
 * (rule (c) above), so a snapshot holds it only at that `playerMidTurnSwitch` state, in its JSON and key (design 9).
 */
export const EXP_PENDING_KEY = 'kaizoExpPending';

/** MAX_POKEMON_LEVEL. */
const MAX_LEVEL = 100;

/** The bit of the player's `pokemon` in the mask: its party index (battle.ts `partyIndexOf`). */
const bitOf = (pokemon: Pokemon): number => 1 << partyIndexOf(pokemon);

/** Whether `pokemon` is there and has HP: `battleMons[battler].curHP` nonzero (bl:1469), Showdown's `hp` and `fainted`. */
function hasHp(pokemon: Pokemon | null | undefined): pokemon is Pokemon {
  return pokemon !== null && pokemon !== undefined && !pokemon.fainted && pokemon.hp > 0;
}

/** `mask` without the bits of the player's Pokémon with 0 HP (the canonical form, at the top of this file). */
export function livingOnly(battle: Battle, mask: number): number {
  let living = mask;
  for (const pokemon of battle.p1.pokemon) {
    if (!hasHp(pokemon)) living &= ~bitOf(pokemon);
  }
  return living;
}

/**
 * The participation mask `battle` holds, without the bit of any Pokémon of the player's with 0 HP (`livingOnly`), so no
 * reader can count a fainted Pokémon; 0 before the battle's first send-out.
 */
export function expMask(battle: Battle): number {
  return livingOnly(battle, (battle.formatData[EXP_MASK_KEY] as number | undefined) ?? 0);
}

function setExpMask(battle: Battle, mask: number): void {
  battle.formatData[EXP_MASK_KEY] = livingOnly(battle, mask);
}

/**
 * The mask's rule at a send-out: `pokemon` has just come in (Showdown's `switchIn` succeeded; its `runSwitch`, with the
 * hazards, is still to come).
 * - The trainer's: `BattleSystem_ClearSideExpGain` (bl:1456-1459), then `BattleSystem_FlagBattlerExpGain` (bl:1461-1478)
 *   for it: the player's active Pokémon's bit, as the newcomer has HP (bl:1469). With the player's active Pokémon fainted the
 *   cartridge flags its slot all the same; that bit is never paid, so the canonical mask is empty.
 * - the player's: `BattleSystem_FlagBattlerExpGain` for the enemy (bs:621-622 and the other player branches): the newcomer's
 *   bit when the enemy's active Pokémon has HP (bl:1469); nothing new when it has 0 (a U-turn knock-out, both sides
 *   replacing at once). The bits already set stay.
 */
export function noteSendOut(battle: Battle, pokemon: Pokemon): void {
  const side = pokemon.side.id as Side;
  if (side === 'p2') {
    const mine = battle.p1.active[0];
    setExpMask(battle, hasHp(mine) && hasHp(pokemon) ? bitOf(mine) : 0);
  } else {
    const theirs = battle.p2.active[0];
    setExpMask(battle, hasHp(theirs) ? expMask(battle) | bitOf(pokemon) : expMask(battle));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The payout

/** What a `runAction` call is running. Never in a snapshot: it lives inside the one call. */
interface Running {
  /** The action is the end of turn (`residual`). */
  readonly residual: boolean;
  /** The trainer's Pokémon with a perish count as the end of turn starts: a faint with no effect then is Perish Song's. */
  readonly perishing: ReadonlySet<Pokemon>;
}

/**
 * The action `runActionPaying` is running, by battle. Empty at every snapshot: set for the length of one action and
 * deleted (or the outer one put back) in its `finally`, and a snapshot is taken between steps, never inside an action.
 * So an `expandTurn` leaf's battle handed to `peek` (facts.ts `keepLive`) holds no entry, as a restored
 * one holds none. A per-battle memo here that outlives an action must be dropped in `keepLive` too.
 */
const running = new WeakMap<Battle, Running>();

const NO_ONE: ReadonlySet<Pokemon> = new Set();

/**
 * Showdown's `runAction` (`run`), with the EXP of the enemy faints it brings paid when it returns (rules (a), (c), (d)
 * at the top of this file). mod/speedOrder.ts's `runAction` calls it.
 */
export function runActionPaying(battle: Battle, action: Action, run: () => boolean | undefined): boolean | undefined {
  const outer = running.get(battle);
  const residual = action.choice === 'residual';
  running.set(battle, { residual, perishing: residual ? perishing(battle) : NO_ONE });
  let result: boolean | undefined;
  try {
    result = run();
  } finally {
    if (outer === undefined) running.delete(battle);
    else running.set(battle, outer);
  }
  if (!keepsPending(battle, action)) payPending(battle);
  return result;
}

/** The trainer's Pokémon that hold a perish count now (Showdown's `perishsong` volatile). */
function perishing(battle: Battle): ReadonlySet<Pokemon> {
  const holders = battle.p2.pokemon.filter((pokemon) => pokemon.volatiles['perishsong'] !== undefined);
  return holders.length === 0 ? NO_ONE : new Set(holders);
}

/**
 * Whether the pending payout waits past this action (rule (c)): the battle waits on the player's mid-move switch (his active
 * Pokémon, alive, has its `switchFlag`: battle.ts `phaseOf`'s `playerMidTurnSwitch`), or that switch has just sent the
 * newcomer in and its `runSwitch`, with the hazards, is next.
 */
function keepsPending(battle: Battle, action: Action): boolean {
  if (battle.formatData[EXP_PENDING_KEY] === undefined) return false;
  const mine = battle.p1.active[0];
  if (!battle.ended && battle.requestState === 'switch' && mine?.switchFlag && !mine.fainted) return true;
  if (action.choice !== 'instaswitch' || action.pokemon.side !== battle.p1) return false;
  const next = battle.queue.peek();
  return next?.choice === 'runSwitch' && next.pokemon === action.target;
}

/** Pays every pending faint, oldest first. */
function payPending(battle: Battle): void {
  const pending = battle.formatData[EXP_PENDING_KEY] as ExpEnemy[] | undefined;
  if (pending === undefined) return;
  delete battle.formatData[EXP_PENDING_KEY];
  for (const enemy of pending) payOut(battle, enemy);
}

function addPending(battle: Battle, enemy: ExpEnemy): void {
  ((battle.formatData[EXP_PENDING_KEY] ??= []) as ExpEnemy[]).push(enemy);
}

/**
 * Showdown's `faintMessages` (sim/battle.ts), and then the EXP of each trainer's Pokémon it fainted: pending inside an
 * action (rule (a)), and in the end of turn paid at once (rule (b)) unless Future Sight, Doom Desire or Perish Song
 * fainted it (rule (d)). The mask then drops the bit of any of the player's that fainted (design 2.3).
 */
export function faintMessages(this: Battle, lastFirst = false, forceCheck = false, checkWin = true): boolean {
  if (this.faintQueue.length === 0) return Battle.prototype.faintMessages.call(this, lastFirst, forceCheck, checkWin) === true;
  // Before Showdown's faint: it clears a Transform (`clearVolatile`), and it shifts the queue with each faint's effect.
  // Only an active Pokémon faints; one queued during the call (Destiny Bond's) is recorded here as well.
  const enemies = this.p2.active.flatMap((pokemon) => (pokemon && !pokemon.fainted
    ? [{ pokemon, enemy: expEnemyOf(pokemon), effect: this.faintQueue.find((entry) => entry.target === pokemon)?.effect }]
    : []));
  const result = Battle.prototype.faintMessages.call(this, lastFirst, forceCheck, checkWin) === true;
  const context = running.get(this);
  for (const { pokemon, enemy, effect } of enemies) {
    if (!pokemon.fainted) continue;
    if (context !== undefined && (!context.residual || paidAtTurnEnd(context, pokemon, effect))) {
      addPending(this, enemy);
    } else {
      payOut(this, enemy); // rule (b), or a faint outside any action (paid at once)
    }
  }
  if (typeof this.formatData[EXP_MASK_KEY] === 'number') setExpMask(this, this.formatData[EXP_MASK_KEY] as number);
  return result;
}

/**
 * Whether an end-of-turn faint of `pokemon` is paid at the turn's end (rule (d)): Future Sight's or Doom Desire's hit
 * (Showdown's Gen 4 `futuremove` hits with a move flagged `futuremove`, data/mods/gen4/moves.ts), or Perish Song's
 * (its `onEnd` faints the Pokémon with no effect, data/moves.ts `perishsong`; nothing else in the end of turn does).
 */
function paidAtTurnEnd(context: Running, pokemon: Pokemon, effect: Effect | null | undefined): boolean {
  if (effect === null || effect === undefined) return context.perishing.has(pokemon);
  return effect.effectType === 'Move' && !!(effect as Move).flags?.['futuremove'];
}

/**
 * The payout for one enemy faint (`BtlCmd_CalcExpGain` bs:2187-2245, `BattleScript_GetExpTask` bs:9685-10201): each of
 * The player's party Pokémon, in party order, gets `expGain`'s share, from the mask now (`expMask`: living only) and each
 * Pokémon's HP, level and item now; then the mask is 0 (bs:10190-10192).
 */
function payOut(battle: Battle, enemy: ExpEnemy): void {
  const mask = expMask(battle);
  const party = [...battle.p1.pokemon].sort((a, b) => partyIndexOf(a) - partyIndexOf(b));
  const gains = expGain({ enemy, party: party.map((pokemon) => expSlotOf(pokemon, (mask & bitOf(pokemon)) !== 0)), trainerBattle: true });
  party.forEach((pokemon, i) => {
    if (gains[i]! > 0) gainExp(battle, pokemon, gains[i]!);
  });
  battle.formatData[EXP_MASK_KEY] = 0;
}

/**
 * `pokemon` gains `gain` EXP (bs:9767-9775) and takes the levels it reaches one at a time (bs:9824-10037,
 * `Pokemon_ShouldLevelUp` pk:3501-3525: EXP above the level 100 total is clamped to it; a level when the EXP reaches the
 * next level's total, on its species' growth table, pk:3503-3506), with the protocol lines.
 */
function gainExp(battle: Battle, pokemon: Pokemon, gain: number): void {
  const m = pokemon.m as Record<string, unknown>;
  const before = m[EXP_KEY];
  if (typeof before !== 'number') throw new Error(`${pokemon.name} has no EXP: only the player's Pokémon get EXP`);
  const table = growthTableOf(pokemon.baseSpecies.num);
  const exp = Math.min(before + gain, table[MAX_LEVEL]!);
  m[EXP_KEY] = exp;
  battle.add('-kaizoexp', pokemon, gain, ...(m[EXP_RATE_KEY] === EXP_RATE.own ? [] : ['[boosted]']));
  while (pokemon.level < MAX_LEVEL && exp >= table[pokemon.level + 1]!) {
    const step = applyLevel(battle, pokemon, pokemon.level + 1);
    battle.add('-kaizolevel', pokemon, step.level);
    for (const id of step.learned) battle.add('-kaizolearn', pokemon, moveName(battle, id));
    for (const id of step.offered) battle.add('-kaizooffer', pokemon, moveName(battle, id));
  }
}

/** The installed move's name for hack move ID `id`, as `|move|` lines name it. */
function moveName(battle: Battle, id: number): string {
  return battle.dex.moves.get(moveId(installedMoves().get(id)!)).name;
}
