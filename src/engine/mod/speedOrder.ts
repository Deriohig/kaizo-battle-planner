// The cartridge's speed order, for the turn's actions and for `monSpeedOrder`, the order of per-battler effects, with
// its draws labelled. Citations are pokeplatinum src/battle/ (bl = battle_lib.c, bcp = battle_controller_player.c).
//
// One compare decides both orders: `BattleSystem_CompareBattlerSpeed(battler1, battler2)` (bl:1188-1451, `compare`
// here). With equal priority it puts first, in this order: a battler whose Quick Claw activated or whose Custap Berry is
// at a pinch (both count as "Quick Claw", bl:1278-1300, :1344-1366); then one without Lagging Tail or Full Incense
// (bl:1302-1304, :1412-1421); then one without Stall (bl:1422-1431); then the slower in Trick Room, else the faster
// (bl:1432-1447). When both have the same item effect or both Stall, the faster goes first if both have Quick Claw, the
// slower if both have Lagging Tail or Stall (bl:1402-1427). Equal Speed in any of these is `RandNext() & 1` (a
// `speedTie` pick, 1/2 each). A fainted battler goes last (bl:1205-1211).
//
// Where the cartridge compares:
// - The turn's actions (`BattleControllerPlayer_CalcTurnOrder`, bcp:707-790): items and switches in battler order,
//   then moves, and two battlers with the same command compared (bcp:772-787), moves with their priority and the
//   Quick Claw and Custap flags set (`ignoreQuickClaw` FALSE), switches and items without priority (`sortQueue`,
//   source `actionOrder`).
// - After Trick Room starts or ends, `BattleSystem_SortMonActionOrder` (bl:7276-7302, bcp:3990-3993) compares the
//   turn's battlers again with `ignoreQuickClaw` FALSE and restarts the order from the top, skipping those that have
//   acted. In singles the order it gives changes nothing the engine needs: the battler that used Trick Room
//   has acted, so the other moves next either way; its equal-Speed draw decides no order; and the Speed values it writes
//   are the next action's (`runAction` stores them). mechanics.test.ts pins it. Its compare does set the Quick Claw and
//   Custap flags again, on the rolls and the HP of the moment, for a battler that has moved and had its flag cleared too:
//   `resortMoveFirst`.
// - `monSpeedOrder` (`BattleSystem_SortMonSpeedOrder`, bl:3364-3383, `ignoreQuickClaw` TRUE, so no priority and no
//   flags, but an activated Quick Claw still counts): sorted at the battle start (bcp:251, :263), before every action
//   and the end of turn (`BranchActions`, bcp:888) and after Trick Room (bcp:3992). The engine takes its inputs when
//   each Showdown action starts (`runAction`) and compares lazily, at the first sort that needs it (source
//   `speedOrder`): handlers of the two sides' Pokémon with equal order and priority (`handlerComparator`), the actives
//   in `eachEvent` (only when both have handlers for the event if deciding could draw), and the battle start's
//   switch-ins (`insertionIndex`).
//
// Quick Claw reads `speedRand[battler]` (`speedRand % (100 / 20) == 0`, bl:1279, :1345), one value per battler slot,
// which the cartridge draws for every slot at the battle start (`BattleContext_InitCounters`, bl:2024, called from
// `BattleContext_New`, bcp:185) and after each turn's order is set (`PRE_MOVE_ACTION_STATE_SPEED_RNG`, bcp:853-858,
// after `CalcTurnOrder` at bcp:790). One draw serves the rest of that turn's `monSpeedOrder` sorts, the trainer AI's
// next command selection (its speed compares, trainer_ai.c:1109, :1121, :2081) and the next turn's move order. Custap
// Berry reads no `speedRand` (HP against max HP over its param, bl:1288-1300, :1354-1366), so it draws nothing.
//
// The engine keeps one roll per side (`quickClaw`, 13108 of the 65536 draws; `formatData.kaizoSpeedRand`, in the state
// and its key, never read by the observation), so a Pokémon that comes into the slot reads the roll the slot holds:
// - At the redraw, right after the turn-start queue sort (`sortQueue`), every stored roll goes and one is drawn for each
//   side whose battler then in the slot (the target of the side's chosen switch, else its active Pokémon) holds a
//   working Quick Claw: the cartridge's draws whose value a compare can read. Other slots' draws are never read, so
//   battles without the item draw nothing.
// - A holder that comes into the slot or gets a working Quick Claw after the redraw (a U-turn or Baton Pass switch-in, a
//   replacement, Roar, Trick, Switcheroo, Thief, Covet, the end of Embargo) has no stored roll: it is picked the first
//   time a compare needs it (lazily, `quickClawRoll`), and at the latest at the turn's end (`endTurn`), so the next
//   command selection reads a stored value too. The cartridge's draw for that slot was independent and nothing read it
//   before, so picking it later gives the same distribution.
// - At the turn's end a roll whose slot has no working holder out (it switched out, fainted or lost the item) goes:
//   nothing reads it before the redraw, and keeping it would only split equal states.
// - The battle start's draw (bl:2024) is picked by the start's compares (the leads' switch-ins, `insertionIndex`).
//   `createBattle` returns one state, which can't hold a drawn roll: it keeps the start's roll only when the start's
//   outcome depends on it (with `BATTLE_START_CHANCE_NOTE`), otherwise it drops it and turn 1's order picks it afresh
//   (battle.ts). So the root state holds no roll.
//
// So a side with no stored roll (`quickClawRolls`, accessors.ts) means one of two things:
// - no working holder (alive, its Quick Claw not ignored under Klutz or Embargo) is in its slot; or
// - a working holder is in the slot, or about to come in, and its roll is not drawn yet. That happens only at the root
//   state and at mid-turn decision states (the U-turn and Baton Pass switches and the replacements), for a holder that
//   arrived or arrives after the turn's redraw.
// At every `turnChoice` state a step reaches (turn 2 on), each working holder out has a stored roll and no other side
// has one. A consumer, the trainer-AI adapter, must take for each working holder's absent roll the union of its
// behaviour over both values: an AND over a superset of the true joint support, sound for tier 1.
//
// The flags (bl:1282-1284, :1296-1298) are shown when the battler's move starts (`BEFORE_MOVE_STATE_QUICK_CLAW`,
// bcp:3140-3143, before sleep or paralysis): `subscript_check_quick_claw` plays Quick Claw's animation, or Custap's
// with its message, unless the battler moves last, and a Custap Berry is used up either way
// (res/battle/scripts/subscripts/subscript_check_quick_claw.s). The engine logs Showdown's `-activate` lines for them.
//
// Speed is the cartridge's own formula (`cartridgeSpeed`, speedValues.ts), never Showdown's `getStat('spe')`, whose
// rounding differs and which would run `ModifySpe` handlers in the middle of a sort. Each compare also writes both
// battlers' values into `monSpeedValues` (bl:1372-1373): the engine stores them (speedValues.ts) at the cartridge's
// compares, at the turn's start (`endTurn`), at `CalcTurnOrder` (`sortQueue`) and at each `BranchActions` (`runAction`).

import PS from 'pokemon-showdown';
import type { Side } from '../../contracts/engine.js';
import { type ChanceOption, pickLabelled } from '../chance.js';
import { installedMoves } from '../dex.js';
import { runActionPaying } from './exp.js';
import { divideUnsigned, heldParam } from './itemData.js';
import { pinchTurnStart } from './items.js';
import { residueWeights, U16 } from '../odds.js';
import { cartridgeSpeed, storeSpeedValues } from '../speedValues.js';
import { addUnmodelledNote } from '../unmodelled.js';

const { Battle, toID } = PS;

export type TieOrder = 'actionOrder' | 'speedOrder';

/** `formatData` key: each side's Quick Claw roll of its slot's current `speedRand`, once drawn (see the top of this file). */
export const SPEED_RAND_KEY = 'kaizoSpeedRand';

/**
 * `formatData` key: the Quick Claw or Custap Berry flag a move-order compare set on each side's battler
 * (`moveEffectsData.quickClaw`, `.custapBerry`, bl:1282-1284, :1296-1298), and `turn`, the turn whose order compared two
 * moves (`resortMoveFirst` reads it). Until its battler's move starts, Knock Off and the other item moves read the flag
 * (`moveFirstFlagged`); the move's start clears it (`showMoveFirst`: subscript_check_quick_claw.s:22-28, run first in
 * every move, bcp:3140-3143). A battler switching in starts with none (`clearMoveFirst`;
 * `MoveEffectsData` is zeroed, bl:2100-2104). Nothing clears it at the turn's end: one Trick Room's re-sort set again
 * after its holder moved stays into the next turn (`endTurnMoveFirst`).
 */
const MOVE_FIRST_KEY = 'kaizoMoveFirst';

type Rolls = Partial<Record<Side, boolean>>;
type MoveFirst = Partial<Record<Side, 'quickClaw' | 'custapBerry'>> & { turn?: number };

/** Quick Claw's `effectParam` in vanilla (res/items/data/quick_claw.json): 20; the hack's ROM has 20 too. */
const VANILLA_QUICK_CLAW_POWER = 20;

/** Quick Claw activates iff `speedRand % (100 / param) == 0` (bl:1279, :1345), its param the ROM's (mod/itemData.ts). */
function quickClawOptions(): readonly ChanceOption[] {
  const param = heldParam('quickclaw', VANILLA_QUICK_CLAW_POWER);
  if (param <= 0) throw new Error('A Quick Claw whose parameter is 0 divides 100 by 0 on the cartridge: not modelled');
  const modulus = Math.floor(100 / param);
  return [{ weight: residueWeights(modulus)[0]!, outcome: 'activate' }, { weight: U16 - residueWeights(modulus)[0]!, outcome: 'none' }];
}

/** `RandNext() & 1` on equal Speed: the first battler stays first for even draws. */
const TIE: readonly ChanceOption[] = [{ weight: U16 / 2n, outcome: 'p1First' }, { weight: U16 / 2n, outcome: 'p2First' }];

/** What the compare reads of one battler (bl:1213-1304). */
interface Battler {
  readonly side: Side;
  readonly alive: boolean;
  readonly speed: number;
  readonly quickClaw: boolean; // holds `HOLD_EFFECT_SOMETIMES_PRIORITY`
  readonly custap: boolean; // `HOLD_EFFECT_PINCH_PRIORITY` at a pinch
  readonly priorityDown: boolean; // `HOLD_EFFECT_PRIORITY_DOWN`
  readonly stall: boolean;
}

/** The two battlers and the field, as one sort reads them. */
interface Sort { readonly a: Battler; readonly b: Battler; readonly trickRoom: boolean }

/** `pokemon`'s held item as the compare reads it: `Battler_HeldItem`, none under Klutz or Embargo (bl:5352-5363). */
const heldItem = (pokemon: Pokemon): string => (pokemon.ignoringItem() ? '' : pokemon.item);

/**
 * Whether a compare reads the roll of `pokemon`'s slot: it is alive (a fainted battler's compare returns first,
 * bl:1205-1211) and holds a Quick Claw that works (`HOLD_EFFECT_SOMETIMES_PRIORITY`, bl:1278-1279).
 */
const readsQuickClawRoll = (pokemon: Pokemon | undefined): boolean => !!pokemon && pokemon.hp > 0 && heldItem(pokemon) === 'quickclaw';

function battlerOf(pokemon: Pokemon): Battler {
  const item = heldItem(pokemon);
  // Custap Berry: `curHP <= maxHP / itemPower`, the ROM's param (4 in vanilla, res/items/data/custap_berry.json) halved by
  // Gluttony (bl:1288-1293); an unsigned division, which returns maxHP for a power of 0 (itemData.ts `divideUnsigned`).
  const power = heldParam('custapberry', 4);
  const pinch = divideUnsigned(pokemon.maxhp, pokemon.hasAbility('gluttony') ? Math.trunc(power / 2) : power);
  return {
    side: pokemon.side.id as Side,
    alive: pokemon.hp > 0,
    speed: cartridgeSpeed(pokemon), // bl:1213-1276
    quickClaw: item === 'quickclaw',
    custap: item === 'custapberry' && pokemon.hp <= pinch,
    priorityDown: item === 'laggingtail' || item === 'fullincense', // res/items/data/lagging_tail.json, full_incense.json
    stall: pokemon.hasAbility('stall'),
  };
}

/** The battle's two battlers now, the player's first (battler 0), or null without both. */
function sortOf(battle: Battle): Sort | null {
  const [mine, theirs] = [battle.p1.active[0], battle.p2.active[0]];
  if (!mine || !theirs) return null;
  return { a: battlerOf(mine), b: battlerOf(theirs), trickRoom: !!battle.field.getPseudoWeather('trickroom') };
}

/**
 * Stores `sort`'s Speeds as the battle's `monSpeedValues`, as the compare does (bl:1372-1373), unless exactly one
 * battler has fainted: the compare returns before it writes then (bl:1204-1211).
 */
function storeSpeeds(battle: Battle, sort: Sort | null): void {
  if (sort === null || sort.a.alive !== sort.b.alive) return;
  storeSpeedValues(battle, { p1: sort.a.speed, p2: sort.b.speed });
}

/** The Quick Claw roll of `side`'s slot's current `speedRand`: picked when first drawn or needed, then kept until the redraw. */
function quickClawRoll(battle: Battle, side: Side): boolean {
  const rolls = (battle.formatData[SPEED_RAND_KEY] ??= {}) as Rolls;
  return (rolls[side] ??= pickLabelled(battle, 'quickClaw', side, 'quickclaw', quickClawOptions()) === 0);
}

/**
 * Picks the roll of each side whose battler `inSlot` gives would have it read (`readsQuickClawRoll`) and has none
 * stored, the player's first (battler 0 first, as bl:2021-2025 and bcp:854-856 draw).
 */
function drawQuickClawRolls(battle: Battle, inSlot: (side: Side) => Pokemon | undefined): void {
  for (const side of ['p1', 'p2'] as const) if (readsQuickClawRoll(inSlot(side))) quickClawRoll(battle, side);
}

/** The Pokémon `side`'s switch chosen for this turn sends in, if it chose one. */
function chosenSwitchTarget(battle: Battle, side: Side): Pokemon | undefined {
  const action = battle.queue.list.find((other) => other.choice === 'switch' && sideOfAction(other) === side);
  return action?.choice === 'switch' ? action.target : undefined;
}

/**
 * The redraw after the turn's order is set (`PRE_MOVE_ACTION_STATE_SPEED_RNG`, bcp:853-858): every stored roll goes,
 * and each side whose battler in the slot once its chosen switch is made holds a working Quick Claw gets a new one. A
 * holder switching out by choice gets none: its slot's new value is its replacement's to read.
 */
function redrawSpeedRand(battle: Battle): void {
  delete battle.formatData[SPEED_RAND_KEY];
  drawQuickClawRolls(battle, (side) => chosenSwitchTarget(battle, side) ?? battle[side].active[0]);
}

/**
 * The flags a compare with `ignoreQuickClaw` FALSE sets: each battler's Quick Claw flag when its claw activated, else its
 * Custap Berry flag when the berry is at a pinch (bl:1278-1300, :1344-1366). It only sets them; a flag already set stays.
 */
function setMoveFirstFlags(battle: Battle, battlers: readonly (readonly [Battler, boolean])[]): MoveFirst {
  const flags = (battle.formatData[MOVE_FIRST_KEY] ??= {}) as MoveFirst;
  for (const [battler, claw] of battlers) {
    if (claw) flags[battler.side] = 'quickClaw'; // bl:1282-1284, :1348-1350
    else if (battler.custap) flags[battler.side] = 'custapBerry'; // bl:1296-1298, :1362-1364
  }
  return flags;
}

/**
 * `BattleSystem_CompareBattlerSpeed(a, b)` (bl:1188-1451): the side that goes first. `priorities` are the two moves'
 * for the move-order compare (`ignoreQuickClaw` FALSE), which also sets each battler's Quick Claw or Custap flag.
 */
function compare(battle: Battle, { a, b, trickRoom }: Sort, tie: TieOrder, priorities?: readonly [number, number]): Side {
  if (!a.alive && b.alive) return b.side; // bl:1205-1207
  if (a.alive && !b.alive) return a.side; // bl:1209-1211
  const [aClaw, bClaw] = [a.quickClaw && quickClawRoll(battle, a.side), b.quickClaw && quickClawRoll(battle, b.side)];
  if (priorities) {
    setMoveFirstFlags(battle, [[a, aClaw], [b, bClaw]]).turn = battle.turn;
    if (priorities[0] !== priorities[1]) return priorities[0] > priorities[1] ? a.side : b.side; // bl:1449-1451
  }
  const coin = () => (pickLabelled(battle, 'speedTie', null, tie, TIE) === 0 ? a.side : b.side);
  const faster = () => (a.speed > b.speed ? a.side : a.speed < b.speed ? b.side : coin());
  const slower = () => (a.speed < b.speed ? a.side : a.speed > b.speed ? b.side : coin());
  const [aFirst, bFirst] = [aClaw || a.custap, bClaw || b.custap];
  if (aFirst && bFirst) return faster(); // bl:1402-1407
  if (aFirst !== bFirst) return aFirst ? a.side : b.side; // bl:1408-1411
  if (a.priorityDown && b.priorityDown) return slower(); // bl:1412-1417
  if (a.priorityDown !== b.priorityDown) return a.priorityDown ? b.side : a.side; // bl:1418-1421
  if (a.stall && b.stall) return slower(); // bl:1422-1427
  if (a.stall !== b.stall) return a.stall ? b.side : a.side; // bl:1428-1431
  return trickRoom ? slower() : faster(); // bl:1432-1447
}

// ---------------------------------------------------------------------------------------------------------------------
// monSpeedOrder

/**
 * Each battle's current `monSpeedOrder`: the inputs its sort read, and its first side once compared. A restored battle
 * has no entry, so a kept `expandTurn` leaf's battle loses its own before `peek` gets it (facts.ts `keepLive`): a new per-battle memo here must be dropped there too.
 */
const speedOrders = new WeakMap<Battle, { sort: Sort | null; first?: Side }>();

/** Drops `battle`'s `monSpeedOrder` memo, which a restored battle doesn't have (facts.ts `keepLive`). */
export function forgetSpeedOrder(battle: Battle): void {
  speedOrders.delete(battle);
}

/** Whether `battle` holds a `monSpeedOrder` memo: a restored battle doesn't (facts.ts `peek`'s check on a kept battle). */
export function hasSpeedOrderMemo(battle: Battle): boolean {
  return speedOrders.has(battle);
}

/**
 * The side first in `battle`'s current `monSpeedOrder`, compared (and any draw picked) the first time it is asked. Its
 * inputs are the battle's as the action started, or as it is now when a side had no Pokémon in then (the battle start's
 * own action sends both leads in: the cartridge sorts once they are out, bcp:241-251).
 */
export function speedOrderFirst(battle: Battle): Side {
  let order = speedOrders.get(battle);
  if (order === undefined) speedOrders.set(battle, (order = { sort: sortOf(battle) }));
  order.sort ??= sortOf(battle);
  if (order.sort === null) return 'p1'; // one side has no Pokémon out: nothing to order
  return (order.first ??= compare(battle, order.sort, 'speedOrder'));
}

/**
 * The side first in `battle`'s current `monSpeedOrder` when a compare has decided it, else undefined. It never compares,
 * so it never draws.
 */
export function speedOrderDecided(battle: Battle): Side | undefined {
  return speedOrders.get(battle)?.first;
}

/** Whether deciding `battle`'s current `monSpeedOrder` could draw: a Quick Claw roll not picked yet, or equal Speed. */
function speedOrderMayDraw(battle: Battle): boolean {
  const order = speedOrders.get(battle);
  if (order?.first !== undefined) return false;
  const sort = order?.sort ?? sortOf(battle);
  if (!sort) return false;
  const rolls = battle.formatData[SPEED_RAND_KEY] as Rolls | undefined;
  const unrolled = (battler: Battler) => battler.quickClaw && rolls?.[battler.side] === undefined;
  return unrolled(sort.a) || unrolled(sort.b) || sort.a.speed === sort.b.speed;
}

/** The active Pokémon an event handler or a list entry belongs to, if any. */
function pokemonOf(entry: AnyObject): Pokemon | null {
  const holder: AnyObject | undefined = 'effectHolder' in entry ? entry.effectHolder : entry;
  return holder && 'getStat' in holder ? (holder as Pokemon) : null;
}

/**
 * Showdown's handler order (`comparePriority`), except that two sides' Pokémon's handlers of equal order and priority
 * go in `monSpeedOrder`, where Showdown would compare their Speed.
 */
function handlerComparator(battle: Battle): (a: AnyObject, b: AnyObject) => number {
  let comparator = handlerComparators.get(battle);
  if (comparator === undefined) {
    comparator = (a, b) => {
      const [x, y] = [pokemonOf(a), pokemonOf(b)];
      if (x && y && x.side !== y.side && (a.order || 0) === (b.order || 0) && (a.priority || 0) === (b.priority || 0)) {
        return x.side.id === speedOrderFirst(battle) ? -1 : 1;
      }
      return Battle.prototype.comparePriority(a, b);
    };
    handlerComparators.set(battle, comparator);
  }
  return comparator;
}

/** A pure function of the battle per battle, so a kept `expandTurn` leaf's battle may keep its own (facts.ts `keepLive`). */
const handlerComparators = new WeakMap<Battle, (a: AnyObject, b: AnyObject) => number>();

/** Showdown's `speedSort` selection sort (sim/battle.ts:429-460) without its shuffle: `onTie` may order a tie, else it keeps its order. */
function selectionSort<T>(list: T[], comparator: (a: T, b: T) => number, onTie?: (start: number, end: number) => void): void {
  let sorted = 0;
  while (sorted + 1 < list.length) {
    let nextIndexes = [sorted];
    for (let i = sorted + 1; i < list.length; i++) {
      const delta = comparator(list[nextIndexes[0]!]!, list[i]!);
      if (delta < 0) continue;
      if (delta > 0) nextIndexes = [i];
      if (delta === 0) nextIndexes.push(i);
    }
    for (let i = 0; i < nextIndexes.length; i++) {
      const index = nextIndexes[i]!;
      if (index !== sorted + i) [list[sorted + i], list[index]] = [list[index]!, list[sorted + i]!];
    }
    if (nextIndexes.length > 1) onTie?.(sorted, sorted + nextIndexes.length);
    sorted += nextIndexes.length;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The turn's actions

/** The parts of a move the cartridge orders with the moves: Focus Punch's and charging moves' early steps, and the move. */
const FIGHT = new Set(['move', 'beforeTurnMove', 'priorityChargeMove']);

const sideOfAction = (action: Action): Side | null => (action.pokemon ? (action.pokemon.side.id as Side) : null);

/** Two sides' actions of the same order tie for `sortQueue`: the cartridge's compare orders them. */
function queueComparator(a: Action, b: Action): number {
  const [x, y] = [sideOfAction(a), sideOfAction(b)];
  if (x && y && x !== y && ((a as AnyObject).order || 0) === ((b as AnyObject).order || 0)) return 0;
  return Battle.prototype.comparePriority(a, b);
}

/** A move's priority as the cartridge reads it (`MOVE_DATA(move).priority`, bl:1397-1398): Showdown's, less Lagging Tail's and Stall's fractions. */
function movePriority(battle: Battle, side: Side): number {
  const action = battle.queue.list.find((other) => other.choice === 'move' && sideOfAction(other) === side);
  return action?.choice === 'move' ? action.priority - (action.fractionalPriority || 0) : 0;
}

/** Puts the first side's entries of `list[start..end)` first, then the other side's, then any with no side, each in order. */
function partition(list: Action[], start: number, end: number, first: Side): void {
  const rank = (action: Action) => {
    const side = sideOfAction(action);
    return side === first ? 0 : side === null ? 2 : 1;
  };
  const group = list.slice(start, end).sort((a, b) => rank(a) - rank(b)); // stable
  for (let i = 0; i < group.length; i++) list[start + i] = group[i]!;
}

/** A fainted battler's replacement (Showdown's forced `instaswitch` out of a fainted Pokémon). */
const isReplacement = (action: Action): boolean => action.choice === 'instaswitch' && !!action.pokemon?.fainted;

/** The note for two replacements at once with an entry hazard on the field, whose timing the cartridge orders otherwise. */
export const DOUBLE_REPLACEMENT_NOTE = 'engine: both sides replaced a fainted Pokémon at once with an entry hazard down (the cartridge applies each hazard right after its own send-out)';

/**
 * Two sides replacing fainted battlers at once: the cartridge opens both party menus together and then sends them in
 * battler by battler, the player's first (`switchedMon` is the lowest switching battler, bs:2408-2413, :2537-2554; the
 * loop in subscript_show_party_list.s), with no speed compare. Each send-out runs its own hazard check right after it
 * (`BATTLE_SUBSCRIPT_HAZARDS_CHECK` there), before the other battler is out; Showdown's Gen 4 `runSwitch` runs each
 * switch-in's hazards with its abilities, after both send-outs, in monSpeedOrder (data/mods/gen4/scripts.ts:18-21). The
 * two agree but for an entry hazard on either side, which is noted.
 */
function replacePlayerFirst(battle: Battle): void {
  const hazards = ['spikes', 'toxicspikes', 'stealthrock'];
  if (battle.sides.some((side) => hazards.some((id) => side.sideConditions[id]))) addUnmodelledNote(battle, DOUBLE_REPLACEMENT_NOTE);
}

/**
 * Showdown's `BattleQueue.sort` (sim/battle-queue.ts:413-417) in the cartridge's turn order: two sides' moves (and
 * their early steps) by the move-order compare, two sides' switches or item uses by the compare without priority. At a
 * turn's start this is `CalcTurnOrder`: its compare stores the Speed values (bcp:780, bl:1372-1373), and the redraw of
 * `speedRand` (bcp:853-858) follows it, whatever the queue holds (`speedSort` calls this for a queue of any length).
 */
export function sortQueue(battle: Battle, list: Action[]): void {
  const decided: { fight?: Side; other?: Side } = {};
  selectionSort(list, queueComparator, (start, end) => {
    const group = list.slice(start, end);
    if (!(group.some((action) => sideOfAction(action) === 'p1') && group.some((action) => sideOfAction(action) === 'p2'))) return;
    if (group.every(isReplacement)) {
      replacePlayerFirst(battle);
      partition(list, start, end, 'p1');
      return;
    }
    const sort = sortOf(battle);
    if (sort === null) return;
    const first = group.every((action) => FIGHT.has(action.choice))
      ? (decided.fight ??= compare(battle, sort, 'actionOrder', [movePriority(battle, 'p1'), movePriority(battle, 'p2')]))
      : (decided.other ??= compare(battle, sort, 'actionOrder'));
    if (!battle.midTurn) storeSpeeds(battle, sort);
    partition(list, start, end, first);
  });
  if (!battle.midTurn) redrawSpeedRand(battle);
}

/**
 * Where `BattleQueue.insertChoice` puts `action`: Showdown's order, except that two sides' switch-ins (`runSwitch`) go
 * in `monSpeedOrder`, and any other tie of two sides' actions by the compare without priority. Returns the index.
 */
export function insertionIndex(battle: Battle, list: readonly Action[], action: Action): number {
  const compareTo = (other: Action): number => {
    const [x, y] = [sideOfAction(action), sideOfAction(other)];
    if (action.choice === 'runSwitch' && other.choice === 'runSwitch' && x && y && x !== y) return x === speedOrderFirst(battle) ? -1 : 1;
    return Battle.prototype.comparePriority(action, other);
  };
  let [firstIndex, lastIndex]: [number | null, number | null] = [null, null];
  for (const [i, other] of list.entries()) {
    const compared = compareTo(other);
    if (compared <= 0 && firstIndex === null) firstIndex = i;
    if (compared < 0) {
      lastIndex = i;
      break;
    }
  }
  if (firstIndex === null) return list.length;
  lastIndex ??= list.length;
  if (firstIndex === lastIndex) return firstIndex;
  // A tie Showdown would break at random (sim/battle-queue.ts:395).
  const mine = sideOfAction(action);
  const other = list.slice(firstIndex, lastIndex).some((tied) => sideOfAction(tied) !== null && sideOfAction(tied) !== mine);
  const sort = sortOf(battle);
  if (mine === null || !other || sort === null) return lastIndex;
  return compare(battle, sort, 'actionOrder') === mine ? firstIndex : lastIndex;
}

// ---------------------------------------------------------------------------------------------------------------------
// The Battle methods the mod replaces

/** Showdown's `speedSort` (sim/battle.ts:429-460): the queue in the cartridge's turn order, handlers in `monSpeedOrder`. */
export function speedSort<T extends AnyObject>(this: Battle, list: T[], comparator: (a: T, b: T) => number = this.comparePriority): void {
  if ((list as unknown) === this.queue.list) return sortQueue(this, list as unknown as Action[]); // any length: the redraw follows
  if (list.length < 2) return;
  selectionSort(list, comparator === this.comparePriority ? handlerComparator(this) : comparator);
}

/**
 * Showdown's `eachEvent` (sim/battle.ts:465-476): the actives in `monSpeedOrder`. When deciding it could draw, only if
 * both have handlers for the event: otherwise the order can't matter, nothing is drawn, and they keep Showdown's Speed
 * order.
 */
export function eachEvent(this: Battle, eventid: string, effect?: Effect | null, relayVar?: boolean): void {
  const actives = this.getAllActive();
  if (!effect && this.effect) effect = this.effect;
  const both = actives.length === 2 && actives[0]!.side !== actives[1]!.side
    && (!speedOrderMayDraw(this) || actives.every((pokemon) => this.findEventHandlers(pokemon, eventid).length > 0));
  if (both) {
    const first = speedOrderFirst(this);
    actives.sort((a, b) => (a.side.id === first ? -1 : 0) - (b.side.id === first ? -1 : 0));
  } else {
    selectionSort(actives, (a, b) => b.speed - a.speed);
  }
  for (const pokemon of actives) {
    this.runEvent(eventid, pokemon, null, effect, relayVar);
  }
  if (eventid === 'Weather' && this.gen >= 7) {
    // As Showdown's `endTurn` (sim/battle.ts), whose own comment marks the timing of this `Update` as unresearched.
    this.eachEvent('Update');
  }
}

/**
 * The Showdown actions a cartridge `BranchActions` comes before (bcp:888-894): each battler's action (a move, a switch
 * chosen for the turn, a trainer's item, which the engine queues as an `event`) and the end of turn (`residual`). A
 * replacement or a U-turn switch (`instaswitch`) and a switch-in's effects (`runSwitch`) are parts of another step.
 */
const BRANCH_ACTIONS: ReadonlySet<string> = new Set(['move', 'switch', 'event', 'residual']);

/**
 * Showdown's `runAction`, after the cartridge's `BranchActions`: a new `monSpeedOrder` from the battle as the action
 * starts, whose sort stores the Speed values (bcp:888, bl:1372-1373) when the action is one `BranchActions` comes
 * before; at a move, its Quick Claw or Custap flag shown and cleared (`BEFORE_MOVE_STATE_QUICK_CLAW`, bcp:3140-3143); at
 * the end of the turn, `endTurnMoveFirst`.
 */
export function runAction(this: Battle, action: Action): boolean | undefined {
  const sort = sortOf(this);
  speedOrders.set(this, { sort });
  if (BRANCH_ACTIONS.has(action.choice)) storeSpeeds(this, sort);
  if (action.choice === 'move') {
    noteFlaggedTarget(this, action.pokemon, action.move);
    showMoveFirst(this, action.pokemon);
  }
  if (action.choice === 'residual') endTurnMoveFirst(this);
  // The EXP of the enemy faints the action brings is paid as it returns, before any other action and before any choice
  // (mod/exp.ts: the cartridge's `MoveEnd` and `TurnEnd` payouts, bcp:3962-3972, :1846).
  return runActionPaying(this, action, () => Battle.prototype.runAction.call(this, action));
}

/**
 * Showdown's `endTurn` (sim/battle.ts:1620), then the turn start's sorts of `monSpeedOrder`, which store the Speed
 * values: `TurnEnd` (bcp:1847-1858, after the replacements and `totalTurns++`) goes to `TrainerMessage` and
 * `ShowBattleMon` (bcp:251, :263), as the battle's start does. The second sort, after any switch-in effects, overwrites
 * the first and is the last write before the next commands are chosen, so the engine stores once, here.
 *
 * Then the stored Quick Claw rolls become those of the active working holders (`settleQuickClawRolls`).
 *
 * First, `ShowBattleMon`'s switch-in sequence checks every battler's held item (bl:4152-4160): mod/items.ts
 * `pinchTurnStart`, so a pinch berry's holder that Future Sight or Doom Desire took into its pinch at the end of the turn
 * eats the berry before the next commands.
 */
export function endTurn(this: Battle): void {
  if (!this.ended) pinchTurnStart(this);
  Battle.prototype.endTurn.call(this);
  storeSpeeds(this, sortOf(this));
  if (!this.ended) settleQuickClawRolls(this);
}

/**
 * At the turn's end, before the next commands: the roll of each active working Quick Claw holder that has none stored
 * (one that came in or got the item after the redraw, and that no compare has read since) is picked, so the commands,
 * the trainer AI's speed compares among them, read a stored value (see the top of this file). A roll whose slot has no
 * working holder out goes: until the redraw only the commands and `CalcTurnOrder` compare, both with these battlers, so
 * nothing reads it, and keeping it would only split equal states.
 */
function settleQuickClawRolls(battle: Battle): void {
  drawQuickClawRolls(battle, (side) => battle[side].active[0]);
  const rolls = battle.formatData[SPEED_RAND_KEY] as Rolls | undefined;
  if (rolls === undefined) return;
  for (const side of ['p1', 'p2'] as const) if (!readsQuickClawRoll(battle[side].active[0])) delete rolls[side];
  if (rolls.p1 === undefined && rolls.p2 === undefined) delete battle.formatData[SPEED_RAND_KEY];
}

/** The note for an item-taking move used on a battler whose Quick Claw or Custap flag is still set. */
export const FLAGGED_ITEM_NOTE = 'engine: an item-taking move met a Quick Claw or Custap Berry flag';

/**
 * Moves the cartridge stops when their target's Quick Claw or Custap Berry flag is set: Thief and Covet
 * (`BtlCmd_TryStealItem`, battle_script.c:5114-5116), Embargo, Trick and Switcheroo
 * (res/battle/scripts/subscripts/subscript_embargo_start.s:10-11, subscript_exchange_items.s:11-12). Showdown doesn't, so
 * a battle where one meets a flag records `FLAGGED_ITEM_NOTE`, and a proof through it is unproven. A hack move counts by
 * its behaviour source (`KaizoMove.calc.baseMove`, whose Showdown callbacks it runs), not its name: the hack's Trick,
 * Covet and Switcheroo slots hold other moves. Modelled: Knock Off's stop (subscript_knock_off.s:8-9, mod/moves.ts
 * `knockOffOnAfterHit`), and Bug Bite's and Pluck's, which read the Custap flag alone (`BtlCmd_TryPluck`,
 * :8125-8127; mod/moves.ts `bugBiteOnHit`).
 */
const FLAG_STOPPED = new Set(['thief', 'covet', 'embargo', 'trick', 'switcheroo']);

/**
 * Whether `pokemon`'s Quick Claw or Custap Berry flag is set (`MOVE_FIRST_KEY`): this turn's compare set it and its move
 * has not started yet.
 */
export function moveFirstFlagged(battle: Battle, pokemon: Pokemon): boolean {
  const flags = battle.formatData[MOVE_FIRST_KEY] as MoveFirst | undefined;
  return flags?.[pokemon.side.id as Side] !== undefined;
}

/** Whether `pokemon`'s Custap Berry flag is set (`moveEffectsData.custapBerry`, bl:1296-1298; see `moveFirstFlagged`). */
export function custapFlagged(battle: Battle, pokemon: Pokemon): boolean {
  const flags = battle.formatData[MOVE_FIRST_KEY] as MoveFirst | undefined;
  return flags?.[pokemon.side.id as Side] === 'custapBerry';
}

/** Drops the flag of `side`'s battler as a Pokémon switches in there (`MoveEffectsData` zeroed, bl:2100-2104). */
export function clearMoveFirst(battle: Battle, side: Side): void {
  const flags = battle.formatData[MOVE_FIRST_KEY] as MoveFirst | undefined;
  if (flags?.[side] === undefined) return;
  delete flags[side];
  tidyMoveFirst(battle, flags);
}

/** Removes the `MOVE_FIRST_KEY` entry once it holds nothing. */
function tidyMoveFirst(battle: Battle, flags: MoveFirst): void {
  if (flags.p1 === undefined && flags.p2 === undefined && flags.turn === undefined) delete battle.formatData[MOVE_FIRST_KEY];
}

/**
 * Trick Room's re-sort of the turn (`BattleSystem_SortMonActionOrder`, bl:7276-7302), run at the end of a move that
 * started or ended the room (the effect script's `TrickRoom` command sets `trickRoomActivated` on both branches,
 * effect_script_0259.s:18, bs:7859-7866; bcp:3990-3993; mod/field.ts calls this at the toggle). It compares the two
 * battlers only when both chose to fight this turn (bl:7288-7290: the same command, `PLAYER_INPUT_FIGHT`), which is when
 * this turn's order compared two moves (`turn`), and then with `ignoreQuickClaw` FALSE: so each battler's flag is set
 * again from its Quick Claw's roll of the moment (the slot's `speedRand`, drawn again right after this turn's order,
 * bcp:853-858, so the roll that will decide the next turn's order: the stored one, `quickClawRoll`) or its Custap Berry
 * at a pinch now, a battler that has moved and had its flag cleared included. Not when either has fainted (the compare
 * returns first, bl:1205-1211). Its order and its equal-Speed draw change nothing the engine needs (the top of this
 * file).
 */
export function resortMoveFirst(battle: Battle): void {
  const flags = battle.formatData[MOVE_FIRST_KEY] as MoveFirst | undefined;
  const sort = sortOf(battle);
  if (flags?.turn !== battle.turn || sort === null || !sort.a.alive || !sort.b.alive) return;
  const claw = (battler: Battler) => battler.quickClaw && quickClawRoll(battle, battler.side);
  setMoveFirstFlags(battle, [[sort.a, claw(sort.a)], [sort.b, claw(sort.b)]]);
}

/**
 * At the end of the turn (`residual`): the record that the turn's order compared two moves (`turn`) goes, and so does a
 * fainted battler's flag (only a switch-in fills its slot, and that zeroes it, bl:2100-2104). A live battler's flag
 * stays: the cartridge clears it only when the battler's next move starts or a Pokémon switches into its slot, never at
 * the turn's end. Only Trick Room's re-sort leaves one set this late (`resortMoveFirst`): every other flag is cleared by
 * its holder's move this turn.
 */
function endTurnMoveFirst(battle: Battle): void {
  const flags = battle.formatData[MOVE_FIRST_KEY] as MoveFirst | undefined;
  if (flags === undefined) return;
  delete flags.turn;
  for (const side of ['p1', 'p2'] as const) {
    const pokemon = battle[side].active[0];
    if (flags[side] !== undefined && (!pokemon || pokemon.fainted || pokemon.hp <= 0)) delete flags[side];
  }
  tidyMoveFirst(battle, flags);
}

function noteFlaggedTarget(battle: Battle, pokemon: Pokemon, move: Move): void {
  const flags = battle.formatData[MOVE_FIRST_KEY] as MoveFirst | undefined;
  if (!flags) return;
  const behaviour = toID(installedMoves().get(move.num)?.calc.baseMove ?? move.id);
  if (!FLAG_STOPPED.has(behaviour)) return;
  if (pokemon.foes().some((foe) => moveFirstFlagged(battle, foe))) addUnmodelledNote(battle, FLAGGED_ITEM_NOTE);
}

/**
 * `subscript_check_quick_claw`: a battler with its flag set starts its move with Quick Claw's or Custap Berry's
 * activation, shown only when the other battler still has to move (`BTLVAR_WAITING_BATTLERS`, bcp:881-886); Custap
 * Berry is used up either way. Then both flags are cleared (:22-23, :26-27), so nothing reads them after the holder's
 * move started. Showdown's lines: `-activate|POKEMON|item: Quick Claw`, and Custap's `-enditem` (eaten) and
 * `-activate|POKEMON|item: Custap Berry|[consumed]` (data/mods/gen4/items.ts:92-101, :383-390).
 */
function showMoveFirst(battle: Battle, pokemon: Pokemon): void {
  const flags = battle.formatData[MOVE_FIRST_KEY] as MoveFirst | undefined;
  const side = pokemon.side.id as Side;
  const flag = flags?.[side];
  if (flag === undefined || !pokemon.isActive || pokemon.fainted) return;
  delete flags![side]; // subscript_check_quick_claw.s:22-28
  tidyMoveFirst(battle, flags!);
  const last = !battle.queue.list.some((other) => other.choice === 'move' && other.pokemon.side !== pokemon.side);
  if (flag === 'quickClaw') {
    if (!last) battle.add('-activate', pokemon, 'item: Quick Claw');
  } else if (pokemon.item === 'custapberry' && pokemon.eatItem() && !last) {
    battle.add('-activate', pokemon, 'item: Custap Berry', '[consumed]');
  }
}

/** Takes the Quick Claw rolls out of `battle`'s state and returns them, for `putQuickClawRolls`. */
export function takeQuickClawRolls(battle: Battle): unknown {
  const rolls = battle.formatData[SPEED_RAND_KEY];
  delete battle.formatData[SPEED_RAND_KEY];
  return rolls;
}

/** Puts back what `takeQuickClawRolls` took. */
export function putQuickClawRolls(battle: Battle, rolls: unknown): void {
  if (rolls !== undefined) battle.formatData[SPEED_RAND_KEY] = rolls;
}
