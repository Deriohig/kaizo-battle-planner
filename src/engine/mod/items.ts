// The `platkaizo` mod's held items: every number a handler uses is the installed ROM's (mod/itemData.ts),
// and the items the hack adds or changes are written out here. Citations are pokeplatinum (bl =
// src/battle/battle_lib.c, bcp = src/battle/battle_controller_player.c, bs = src/battle/battle_script.c).
//
// | Item                                   | Cartridge                                                   | Here                     |
// |----------------------------------------|-------------------------------------------------------------|--------------------------|
// | Type boosters, Plates                  | power × (100 + param) / 100 for a move of the type (bl:6716-6721) | damage.ts `cartridgePower` (`TYPE_ITEMS`, `PLATES`) |
// | Muscle Band, Wise Glasses              | the same for a physical or a special move (bl:6776-6783)    | damage.ts `cartridgePower` |
// | Oran Berry, Shoal Shell (item 71)      | `HOLD_EFFECT_HP_RESTORE`: heals the param at half HP (bl:4585-4592) | `hpRestore`      |
// | Sitrus Berry                           | `HOLD_EFFECT_HP_PCT_RESTORE`: max HP × param / 100 (bl:4594-4602) | `sitrusberry`     |
// | Berry Juice, Leppa Berry               | the param in HP and PP                                      | `berryjuice`, `leppaberry` |
// | Jaboca, Rowap Berry                    | the attacker loses max HP / param                           | `recoilBerry`            |
// | Lava Cookie, Old Gateau (items 42, 54) | `HOLD_EFFECT_STATUS_RESTORE` (12), Lum Berry's              | `statusCure`             |
// | Ganlon, Apicot, Shoal Salt (item 70)   | a pinch stat item whose param is 0: `maxHP / 0` is `maxHP` | `PINCH_ITEMS`, below     |
// | Liechi, Salac, Petaya, Lansat, Starf, Micle | `HOLD_EFFECT_PINCH_*` (36-42, 44), param 4: a quarter of the max HP | `PINCH_ITEMS`, `starfEat` |
// | Weather rocks, Light Clay              | 5 turns plus the param (effect_script_0136.s:12-14 and its siblings) | `KAIZO_ITEM_CONDITIONS` |

import PS from 'pokemon-showdown';
import type { Side } from '../../contracts/engine.js';
import { pickLabelled } from '../chance.js';
import { residueWeights } from '../odds.js';
import { divideUnsigned, heldParam } from './itemData.js';

const { Battle: BattleClass, Dex } = PS;
const GEN4 = Dex.mod('gen4');

// ---------------------------------------------------------------------------------------------------------------------
// Power boosts

/**
 * The type each type-boosting item raises in the cartridge: `sTypeBoostingItems` (bl:6516-6531) maps the hold effects
 * `HOLD_EFFECT_STRENGTHEN_*` to types, and the Plates' `HOLD_EFFECT_ARCEUS_*` (bl:7629-7699) to the plate's. The Plates
 * come from Showdown's Gen 4 data (`onPlate`); test/real/engineVsCalcItems.test.ts checks every item here against the
 * ROM's hold effect.
 */
export const TYPE_ITEMS: Readonly<Record<string, string>> = {
  silkscarf: 'Normal', blackbelt: 'Fighting', blackglasses: 'Dark', charcoal: 'Fire', dragonfang: 'Dragon', hardstone: 'Rock',
  magnet: 'Electric', metalcoat: 'Steel', miracleseed: 'Grass', mysticwater: 'Water', nevermeltice: 'Ice', poisonbarb: 'Poison',
  sharpbeak: 'Flying', silverpowder: 'Bug', softsand: 'Ground', spelltag: 'Ghost', twistedspoon: 'Psychic',
  seaincense: 'Water', waveincense: 'Water', roseincense: 'Grass', rockincense: 'Rock', oddincense: 'Psychic',
};

export const PLATES: ReadonlyMap<string, string> = new Map(GEN4.items.all().filter((item) => item.onPlate !== undefined && item.gen <= 4).map((item) => [item.id, item.onPlate!]));

// The type boosters, the Plates, Muscle Band and Wise Glasses are applied by damage.ts `cartridgePower`, with the ROM's
// parameter, in the cartridge's order of the power steps; every item's `BasePower` handler is dropped there (`isDropped`),
// so none is defined here (the `typeBoost` and `classBoost` handlers here never ran).

// ---------------------------------------------------------------------------------------------------------------------
// Healing and recoil berries

/** Oran Berry's and Shoal Shell's `HOLD_EFFECT_HP_RESTORE` (bl:4585-4592): the param in HP at half HP or less. */
function hpRestoreAmount(id: string, vanilla: number): number {
  return heldParam(id, vanilla);
}

/** Jaboca and Rowap: the attacker that hit with a physical (Jaboca) or special (Rowap) move loses max HP / param. */
function recoilBerry(id: string, category: 'Physical' | 'Special') {
  return {
    onDamagingHit(this: Battle, _damage: number, target: Pokemon, source: Pokemon, move: ActiveMove) {
      if (move.category === category && !source.hasAbility('magicguard')) {
        if (target.eatItem()) this.damage(source.baseMaxhp / heldParam(id, 8), source, target, null, true);
      }
    },
  };
}

/** Berry Juice's and Shoal Shell's check: the param in HP at half HP or less, used up (an `onKaizoHeldCheck`, below). */
function hpRestoreCheck(id: string, vanilla: number) {
  return function (this: Battle, pokemon: Pokemon) {
    if (pokemon.hp > pokemon.maxhp / 2) return;
    const amount = hpRestoreAmount(id, vanilla);
    if (this.runEvent('TryHeal', pokemon, null, this.effect, amount) && pokemon.useItem()) this.heal(amount);
  };
}

/** A non-berry that heals `amount` HP when its holder is at half HP or less and is used up (Berry Juice's shape). */
function hpRestoreItem(name: string, id: string, num: number, vanilla: number) {
  return { name, num, gen: 4, onKaizoHeldCheck: hpRestoreCheck(id, vanilla) };
}

/**
 * A non-berry that cures a status or confusion and is used up: Lum Berry's effect, `HOLD_EFFECT_STATUS_RESTORE`, checked
 * at the cartridge's points (`onKaizoHeldCheck`, below), not the moment a status is set.
 */
function statusCure(name: string, num: number) {
  return {
    name, num, gen: 4,
    onKaizoHeldCheck(this: Battle, pokemon: Pokemon) {
      if (!(pokemon.status || pokemon.volatiles['confusion']) || !pokemon.useItem()) return;
      pokemon.cureStatus();
      pokemon.removeVolatile('confusion');
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The pinch items, checked where the cartridge checks them: the parameter-0 ones (Ganlon, Apicot, Shoal Salt),
// Micle Berry and the rest of the family (Liechi, Salac, Petaya, Lansat, Starf)

/** What a pinch item does once its check passes. */
export type PinchAct = 'atk' | 'def' | 'spe' | 'spa' | 'spd' | 'crit' | 'random' | 'accuracy';

/**
 * The `HOLD_EFFECT_PINCH_*` family that both of the cartridge's held-item triggers check, by Showdown ID: what each does,
 * and the parameter that stands in when the installed data has no item records (`heldParam`). The hack ROM's items with
 * hold effects 36 to 42 and 44 are exactly these (hold effect, parameter; test/real/engineVsCalcItems.test.ts reads them
 * from the ROM, and the docs' Items tab, "Battle Script" and "Power", agrees):
 * - 70 Shoal Salt (36, 0), the hack's: `HOLD_EFFECT_PINCH_ATK_UP`, used, not eaten;
 * - 201 Liechi (36, 4), 202 Ganlon (37, 0), 203 Salac (38, 4), 204 Petaya (39, 4), 205 Apicot (40, 0): `_ATK_UP` to
 *   `_SPDEF_UP`, the stat below `MAX_STAT_STAGE`, then +1 (subscript_held_item_raise_stat.s:7-11);
 * - 206 Lansat (41, 4), `_CRITRATE_UP`: no Focus Energy yet, then Focus Energy (subscript_held_item_raise_crit.s:11);
 * - 207 Starf (42, 4), `_RANDOM_UP`: some stat of five below the maximum, then one drawn goes up 2 (`starfEat`);
 * - 209 Micle (44, 4), `_ACC_UP`: no other condition (the boost: mod/conditions.ts, mod/scripts.ts).
 * Vanilla's parameter is 4 for every berry (res/items/data/*_berry.json); Ganlon, Apicot and Shoal Salt stand in with the
 * hack's 0. Custap Berry (45, `_PRIORITY`) is in neither trigger: the turn order reads it
 * (speedOrder.ts). The hold effects are generated/item_hold_effects.txt's lines less one.
 */
export const PINCH_ITEMS: ReadonlyMap<string, { readonly act: PinchAct; readonly standIn: number }> = new Map([
  ['shoalsalt', { act: 'atk', standIn: 0 }],
  ['liechiberry', { act: 'atk', standIn: 4 }],
  ['ganlonberry', { act: 'def', standIn: 0 }],
  ['salacberry', { act: 'spe', standIn: 4 }],
  ['petayaberry', { act: 'spa', standIn: 4 }],
  ['apicotberry', { act: 'spd', standIn: 0 }],
  ['lansatberry', { act: 'crit', standIn: 4 }],
  ['starfberry', { act: 'random', standIn: 4 }],
  ['micleberry', { act: 'accuracy', standIn: 4 }],
] as const);

/** Starf Berry's five stats in the cartridge's order: `BATTLE_STAT_ATTACK + i`, i = 0..4 (generated/battle_stats.txt). */
export const STARF_STATS = ['atk', 'def', 'spe', 'spa', 'spd'] as const;

/** `MAX_STAT_STAGE` (12, a stage of +6). */
const MAX_STAGE = 6;

/**
 * The pinch check, the same in `BattleSystem_TriggerHeldItem` (bl:4773-4905) and `BattleSystem_TriggerHeldItemOnStatus`
 * (bl:5110-5118, :5196-5293), case by case:
 * - with HP left (bl:4583, :4973), and no Klutz and no Embargo (`Battler_HeldItemEffect` through `Battler_HeldItem`,
 *   bl:5352-5363, :5438-5442; Showdown's `ignoringItem`);
 * - Gluttony halves the parameter (`itemPower /= 2`, a signed int; `Battler_Ability`, so not under Gastro Acid:
 *   Showdown's `hasAbility`);
 * - `curHP <= maxHP / itemPower`, an unsigned division: `_u32_div_f` (ARM9 0x020E2178) returns the dividend for a divisor
 *   of 0 (`cmp r1, #0; bxeq lr`), which the hack's overlay 16 calls from every pinch block (`blx 0x20e2178` at 0x2257d44
 *   and after, docs/engine-spot-checks.md), so a parameter of 0 works at any HP, at the item's first check;
 * - and, by the act: the stat below `MAX_STAT_STAGE` (bl:4778-4779 and each sibling); no Focus Energy
 *   (`VOLATILE_CONDITION_FOCUS_ENERGY`, bl:4843-4844, Showdown's `focusenergy` volatile, which the move, Dire Hit and
 *   Lansat set); one of Starf's five stats below the maximum (bl:4855-4862); nothing more for Micle (bl:4897-4905).
 * An item that fails its check stays held, to be checked again at the next point.
 */
function pinchDue(pokemon: Pokemon): boolean {
  const pinch = PINCH_ITEMS.get(pokemon.item);
  if (pinch === undefined || pokemon.hp <= 0 || pokemon.ignoringItem()) return false;
  let power = heldParam(pokemon.item, pinch.standIn);
  if (pokemon.hasAbility('gluttony')) power = Math.trunc(power / 2);
  if (pokemon.hp > divideUnsigned(pokemon.maxhp, power)) return false;
  switch (pinch.act) {
    case 'crit': return !pokemon.volatiles['focusenergy'];
    case 'random': return STARF_STATS.some((stat) => pokemon.boosts[stat] < MAX_STAGE);
    case 'accuracy': return true;
    default: return pokemon.boosts[pinch.act] < MAX_STAGE;
  }
}

/**
 * The pinch check for one holder: the item is used up (Shoal Salt, a hack item that isn't a berry: Showdown's `useItem`
 * and its `onUse`) or eaten (the berries: Showdown's `eatItem` and the berry's `onEat`) when the check passes. Eating
 * logs `-enditem|…|[eat]` and removes the berry, as the subscripts' `BATTLE_SUBSCRIPT_PLUCK_CHECK` does
 * (subscript_pluck_check.s:6, `BtlCmd_RemoveItem` bs:8972-8984, which copies the empty slot to the party), and starts
 * Unburden (`AfterUseItem`): the cartridge doubles an Unburden holder's Speed once its item is gone (`canUnburden`,
 * bl:1268-1272). The berry itself is the source effect, so a stale `battle.effect` of another item can't refuse the eat.
 */
function pinchCheck(pokemon: Pokemon): void {
  if (HELD_CHECK_ITEMS.has(pokemon.item)) {
    // The rest of the family: the item's own check (`onKaizoHeldCheck`), with HP left, out, and not under Klutz or
    // Embargo (`singleEvent` suppresses an ignored item's handlers).
    if (pokemon.hp > 0 && pokemon.isActive) pokemon.battle.singleEvent('KaizoHeldCheck', pokemon.getItem(), pokemon.itemState, pokemon);
    return;
  }
  if (!pinchDue(pokemon)) return;
  if (pokemon.item === 'shoalsalt') pokemon.useItem();
  else pokemon.eatItem(false, pokemon, pokemon.getItem());
}

/**
 * The rest of the held-item family both triggers check: every case of
 * `BattleSystem_TriggerHeldItem` (bl:4576-4920) is one of `BattleSystem_TriggerHeldItemOnStatus` (bl:4967-5305), with
 * the same condition, so these are checked at the pinch items' points (below), and only there. The hack ROM's items with
 * these hold effects, and the condition Showdown's Gen 4 `onUpdate` checks, which is the cartridge's:
 * - `HOLD_EFFECT_HP_RESTORE` (1; bl:4585-4591): 43 Berry Juice (20), 71 Shoal Shell (100), 155 Oran (10): half HP or
 *   less, then the parameter in HP; `_HP_PCT_RESTORE` (13; bl:4593-4599): 158 Sitrus (25): max HP × param / 100;
 * - `_HP_RESTORE_SPICY` to `_SOUR` (14-18; bl:4698-4772, :5121-5195): 159 Figy, 160 Wiki, 161 Mago, 162 Aguav,
 *   163 Iapapa (8): half HP or less, max HP / param, confusion for a nature that dislikes the flavour; no Gluttony;
 * - `_PRZ_RESTORE` to `_FRZ_RESTORE` (5-9): 149 Cheri, 150 Chesto, 151 Pecha, 152 Rawst, 153 Aspear: the status;
 *   `_CONFUSE_RESTORE` (11): 156 Persim: confusion; `_STATUS_RESTORE` (12): 157 Lum and the hack's 42 Lava Cookie and
 *   54 Old Gateau: any status or confusion;
 * - `_PP_RESTORE` (10): 154 Leppa: a move at 0 PP; `_HEAL_INFATUATION` (54): 219 Mental Herb: Attract.
 * Showdown ate them on its `Update` (after each hit, and at an action's end unless a switch was asked first, once after
 * the whole end of turn) and Lum and the cookies also the moment a status was set (`onAfterSetStatus`). Both are switched
 * off; each item's check moves to `onKaizoHeldCheck`, which `pinchCheck` runs. So a Sitrus holder the sandstorm takes
 * to half HP eats it in its own list, before its poison; a U-turn user knocked to half HP by Rough Skin leaves with its
 * berry; a holder knocked out with a switch to come eats before the EXP payout. White Herb (49, `_STATDOWN_RESTORE`) is
 * left to Showdown's handlers and mod/procs.ts's switch-in: nothing lowers a stage at the end of the turn, and its
 * after-move check is Showdown's `onAnyAfterMove`.
 */
export const HELD_CHECK_ITEMS: ReadonlySet<string> = new Set([
  'berryjuice', 'shoalshell', 'oranberry', 'sitrusberry', 'figyberry', 'wikiberry', 'magoberry', 'aguavberry', 'iapapaberry',
  'cheriberry', 'chestoberry', 'pechaberry', 'rawstberry', 'aspearberry', 'persimberry', 'lumberry', 'lavacookie', 'oldgateau',
  'leppaberry', 'mentalherb',
]);

/** Showdown's Gen 4 `onUpdate` check of item `id`, which the cartridge's points run in its place (`onKaizoHeldCheck`). */
function showdownCheck(id: string): Function {
  const check = (GEN4.items.get(id) as unknown as { onUpdate?: Function }).onUpdate;
  if (check === undefined) throw new Error(`Showdown's Gen 4 ${id} has no onUpdate`);
  return check;
}

/**
 * Starf Berry's effect (`onEat`, so also for a Bug Bite or Pluck user and a Fling target): the cartridge draws
 * `i = RandNext() % 5` until stat `BATTLE_STAT_ATTACK + i` is below the maximum (bl:4864-4866; Pluck's bl:5807-5809 and
 * Fling's :6120-6122 the same), then raises it by 2, at most to the maximum (subscript_held_item_sharply_raise_stat.s:14-18:
 * the stage itself, so no Simple doubling, which Showdown's Gen 4 Simple applies when a stage is read, not here). Each
 * stat below the maximum is drawn with its residue's share of the 65,536 draws, `residueWeights(5)[i]` (13,108 for
 * Attack, 13,107 for each other); a stat at the maximum is redrawn, so it weighs 0 and the rest keep their ratio. The
 * draw is an `itemProc` chance labelled `starfberry` on the eater's side, the stat's ID its outcome, in place of
 * Showdown's raw `sample`. With every stat at the maximum there is no draw and no boost (bl:4855-4862: Pluck and Fling
 * eat the berry all the same; the holder's own check never passes then).
 */
function starfEat(this: Battle, pokemon: Pokemon): void {
  const weights = residueWeights(STARF_STATS.length);
  const options = STARF_STATS.map((stat, i) => ({ weight: pokemon.boosts[stat] < MAX_STAGE ? weights[i]! : 0n, outcome: stat }));
  if (options.every((option) => option.weight === 0n)) return;
  const stat = STARF_STATS[pickLabelled(this, 'itemProc', pokemon.side.id as Side, 'starfberry', options)]!;
  const boost: SparseBoostsTable = { [stat]: 2 };
  this.boost(boost, pokemon);
}

/**
 * Where the cartridge makes the check. Every pinch case of `BattleSystem_TriggerHeldItem` is in
 * `BattleSystem_TriggerHeldItemOnStatus` too, and one battler holds one item, so the checks below differ only in where
 * they run:
 * - the switch-in sequence (`BattleSystem_TriggerEffectOnSwitch`, bl:3649), whose `SWITCH_IN_CHECK_STATE_HELD_ITEM_STATUS`
 *   checks every battler in monSpeedOrder (bl:4152-4160). It runs at the battle start and at every turn's start
 *   (`ShowBattleMon`, bcp:254-266, after `TurnEnd`'s replacements, bcp:1844-1858, :241-251), first among every hit's
 *   after-move effects (`AFTER_MOVE_EFFECT_TRIGGER_SWITCH_IN_EFFECTS`, bcp:3672-3681), and at every action's `MoveEnd`
 *   after its EXP payout (bcp:3962-3980): a move, one its user couldn't make (a confusion self-hit by `LOOP_FAINTED`,
 *   bcp:2637, :3820-3909, the other failed checks by `UPDATE_MOVE_BUFFERS`, e.g. bcp:2660, :3959; neither runs the
 *   after-move effects), a switch (bcp:1977-1987, `CheckAnyFainted` bcp:4002-4009), a trainer's item (bcp:1973);
 * - after every hit of a move, for the attacker and the defender (`AFTER_MOVE_EFFECT_ATTACKER_ITEM`, `_DEFENDER_ITEM`,
 *   `BattleSystem_TriggerHeldItem`, bcp:3684-3698) and for every battler not switching (`AFTER_MOVE_EFFECT_HELD_ITEM_STATUS`,
 *   bcp:3730-3755), before `LoopMultiHit` (bcp:3777-3790);
 * - in each battler's own end-of-turn list (bcp:1301-1734, the battlers in monSpeedOrder): `MON_COND_CHECK_STATE_USE_ITEM`
 *   (`TriggerHeldItem`, bcp:1362-1368), after Ingrain, Aqua Ring and the ability, before Leftovers; and
 *   `MON_COND_CHECK_STATE_ITEM_CONDITION` (`TriggerHeldItemOnStatus`, bcp:1699-1709), after Yawn, before the Orbs.
 * No other script checks them: a U-turn user, for one, leaves inside its move's script with no held-item check of its
 * own (sub/subscript_attack_then_switch_out.s:7-12; `TriggerHeldItemOnPivotMove`, bl:7336-7400, has no pinch case).
 *
 * The engine's points (Showdown's own `onUpdate`, which ate these berries after each hit and at an action's end unless
 * a switch was asked first, is switched off for every item of the family):
 * - `pinchSwitchIn`, after each Showdown switch-in's own effects (mod/procs.ts `switchInChecks`, from mod/scripts.ts
 *   `runSwitch`): the leads, a switch (its `MoveEnd`, after the hazards), a replacement, a U-turn or Baton Pass newcomer, a
 *   Pokémon dragged in. Pursuit's hit on a battler switching out has no after-move effects of its own on the cartridge
 *   (subscript_pursuit.s runs inside the switch's script) and the switch's `MoveEnd` comes once the newcomer is in; the
 *   engine's switch-out hit is `useMove` (mod/moves.ts), which runs no `AfterMove`, so the battler leaving isn't checked on
 *   either side.
 * - `pinchTurnStart`, from mod/speedOrder.ts `endTurn`: the turn's start, after the end of turn's last effects (Future
 *   Sight, Doom Desire) and the replacements.
 * - `pinchAfterMove`: the format's `AfterMove` (dex.ts), after a move Showdown ran, its recoil, drain, Jaboca and Rowap,
 *   Rough Skin, Life Orb and Shell Bell done; after every hit of a multi-hit move (mod/scripts.ts `hitStepMoveHitLoop`); and
 *   the format's `MoveAborted`, a move its user couldn't make (the confusion self-hit is the one that changes HP), which
 *   runs no `AfterMove`. The cartridge's Life Orb and Shell Bell come after the hits' after-move effects
 *   (`TriggerAfterMoveHitEffects`, bcp:4715-4790) and before `MoveEnd`'s check, but they need the attacker to hold them, so
 *   no pinch item holder has them. `MoveEnd`'s check after the EXP payout finds nothing new: a level-up adds the same amount
 *   d to HP and max HP, and `⌊(M + d) / p⌋ <= ⌊M / p⌋ + d`, so a holder above its line stays above it, and it changes no
 *   stage or Focus Energy. Nor after a trainer's item: it restores HP, cures, raises a stage or sets Focus Energy, none of
 *   which can make a failed check pass. A battler switching out (U-turn, Baton Pass) is skipped: on the
 *   cartridge it has left before the after-move effects (sub/subscript_attack_then_switch_out.s:71), and its newcomer is
 *   checked at its switch-in.
 * - The end of turn: the item's two steps in its holder's order-10 list (mod/conditions.ts, the top: each battler's list
 *   runs whole, in monSpeedOrder), at sub-orders between Showdown's Gen 4 ones, which follow the cartridge's list (the
 *   ability 3, Leftovers 4, ..., Yawn 19, the Orbs 20): the item's `onResidual` (`PINCH_USE_ITEM_SUB_ORDER`) and a second
 *   listener `findPokemonEventHandlers` adds (`PINCH_ITEM_CONDITION_SUB_ORDER`). So the item sees what the holder's own
 *   list did before it (weather in the field phase, poison and Leech Seed between the two), and an EXP level-up from an
 *   enemy that faints in its own list only when that list came first, as on the cartridge.
 * The cartridge's loops go in monSpeedOrder; the engine's in Showdown's action speed, which draws nothing. One battler's
 * check never changes another's, so only the log order of two items used at one point can differ (and, with two Starf
 * berries eaten at one point, the order of the two draws, which are independent).
 */
export function pinchSwitchIn(battle: Battle): void {
  for (const pokemon of battle.getAllActive()) pinchCheck(pokemon);
}

/** The turn start's check (`ShowBattleMon`'s switch-in sequence, bcp:254-266): every battler, as at a switch-in. */
export function pinchTurnStart(battle: Battle): void {
  pinchSwitchIn(battle);
}

/**
 * Format `AfterMove` and `MoveAborted` handler, and the check after each hit of a multi-hit move: every battler that isn't
 * switching out is checked, in action-speed order.
 */
export function pinchAfterMove(this: Battle): void {
  for (const pokemon of this.getAllActive().sort((x, y) => y.getActionSpeed() - x.getActionSpeed())) {
    if (!pokemon.switchFlag) pinchCheck(pokemon);
  }
}

/** The `MON_COND_CHECK_STATE_USE_ITEM` step: after the ability (Speed Boost, Shed Skin: 3), before Leftovers (4). */
const PINCH_USE_ITEM_SUB_ORDER = 3.5;
/** The `MON_COND_CHECK_STATE_ITEM_CONDITION` step: after Yawn (19), before the Toxic and Flame Orbs (20). */
const PINCH_ITEM_CONDITION_SUB_ORDER = 19.5;

/** One end-of-turn step of a pinch item's (a Showdown residual handler; Klutz and Embargo already stop the item's events). */
function pinchResidualStep(this: Battle, pokemon: Pokemon): void {
  pinchCheck(pokemon);
}

/**
 * Showdown's `findPokemonEventHandlers` (sim/battle.ts), plus the second end-of-turn step of a pinch item's holder: an
 * item has one `onResidual`, and the cartridge checks it twice in its holder's list (bcp:1362-1368, :1699-1709). The
 * added listener is the item's own (its effect, its state, its order 10), at the later sub-order, so Showdown's
 * `fieldEvent` and `singleEvent` treat it as the item's: not run for a fainted holder or under Klutz or Embargo, and it
 * does nothing once the item is gone (`pinchDue`). Only a holder gets it, so no other battle's handler sort changes. A
 * mod `Scripts` entry (mod/scripts.ts).
 */
export function findPokemonEventHandlers(this: Battle, pokemon: Pokemon, callbackName: string, getKey?: 'duration'): ReturnType<Battle['findPokemonEventHandlers']> {
  const handlers = BattleClass.prototype.findPokemonEventHandlers.call(this, pokemon, callbackName, getKey);
  if (callbackName === 'onResidual' && (PINCH_ITEMS.has(pokemon.item) || HELD_CHECK_ITEMS.has(pokemon.item))) {
    const handler = this.resolvePriority({ effect: pokemon.getItem(), callback: pinchResidualStep, state: pokemon.itemState, end: pokemon.clearItem, effectHolder: pokemon }, callbackName);
    handler.subOrder = PINCH_ITEM_CONDITION_SUB_ORDER;
    handlers.push(handler);
  }
  return handlers;
}

/** Every pinch item's own end-of-turn step, its use-item step; `findPokemonEventHandlers` adds the item-condition step. */
const pinchResidual = { onResidualOrder: 10, onResidualSubOrder: PINCH_USE_ITEM_SUB_ORDER, onResidual: pinchResidualStep };

/** A `HELD_CHECK_ITEMS` entry over Showdown's Gen 4 item `id`: its `onUpdate` off, run as `onKaizoHeldCheck` at the points. */
function heldCheck(id: string): Record<string, unknown> {
  return { onUpdate: undefined, onKaizoHeldCheck: showdownCheck(id), ...pinchResidual };
}

// ---------------------------------------------------------------------------------------------------------------------

/** The mod's item entries, merged over Showdown's Gen 4 ones by ID (dex.ts). */
export const KAIZO_ITEM_DATA: Record<string, Record<string, unknown>> = {
  oranberry: {
    ...heldCheck('oranberry'),
    onTryEatItem(this: Battle, _item: Item, pokemon: Pokemon) {
      if (!this.runEvent('TryHeal', pokemon, null, this.effect, hpRestoreAmount('oranberry', 10))) return false;
    },
    onEat(this: Battle) {
      this.heal(hpRestoreAmount('oranberry', 10));
    },
  },
  sitrusberry: {
    ...heldCheck('sitrusberry'),
    // `BattleSystem_Divide(maxHP * itemPower, 100)` (bl:4594-4602).
    onTryEatItem(this: Battle, _item: Item, pokemon: Pokemon) {
      if (!this.runEvent('TryHeal', pokemon, null, this.effect, Math.floor(pokemon.baseMaxhp * heldParam('sitrusberry', 25) / 100))) return false;
    },
    onEat(this: Battle, pokemon: Pokemon) {
      this.heal(Math.floor(pokemon.baseMaxhp * heldParam('sitrusberry', 25) / 100));
    },
  },
  berryjuice: { onUpdate: undefined, onKaizoHeldCheck: hpRestoreCheck('berryjuice', 20), ...pinchResidual },
  leppaberry: {
    ...heldCheck('leppaberry'),
    onEat(this: Battle, pokemon: Pokemon) {
      const moveSlot = pokemon.moveSlots.find((move) => move.pp === 0) || pokemon.moveSlots.find((move) => move.pp < move.maxpp);
      if (!moveSlot) return;
      moveSlot.pp = Math.min(moveSlot.pp + heldParam('leppaberry', 10), moveSlot.maxpp);
      this.add('-activate', pokemon, 'item: Leppa Berry', moveSlot.move, '[consumed]');
    },
  },
  jabocaberry: recoilBerry('jabocaberry', 'Physical'),
  rowapberry: recoilBerry('rowapberry', 'Special'),
  // The hack's items (docs Items tab entries 42, 54, 70, 71; ids.ts names them).
  lavacookie: { ...statusCure('Lava Cookie', 42), ...pinchResidual },
  oldgateau: { ...statusCure('Old Gateau', 54), ...pinchResidual },
  shoalshell: { ...hpRestoreItem('Shoal Shell', 'shoalshell', 71, 100), ...pinchResidual },
  shoalsalt: {
    name: 'Shoal Salt', num: 70, gen: 4, ...pinchResidual,
    onUse(this: Battle, pokemon: Pokemon) {
      this.boost({ atk: 1 }, pokemon);
    },
  },
  // The pinch berries: Showdown's `onUpdate` eats at its own times (after each hit, and at an action's end unless a switch
  // is asked first), and Micle Berry's only check is an `onResidual` with no order, last of the end of turn; the cartridge
  // checks at the points above (`pinchSwitchIn`, `pinchTurnStart`, `pinchAfterMove`, the two end-of-turn steps).
  liechiberry: { onUpdate: undefined, ...pinchResidual },
  ganlonberry: { onUpdate: undefined, ...pinchResidual },
  salacberry: { onUpdate: undefined, ...pinchResidual },
  petayaberry: { onUpdate: undefined, ...pinchResidual },
  apicotberry: { onUpdate: undefined, ...pinchResidual },
  lansatberry: { onUpdate: undefined, ...pinchResidual },
  starfberry: { onUpdate: undefined, ...pinchResidual, onEat: starfEat },
  micleberry: { ...pinchResidual },
  // The rest of the family (`HELD_CHECK_ITEMS`): Showdown's `onUpdate` (and Lum's `onAfterSetStatus`) off, its check run
  // at the cartridge's points. Oran, Sitrus, Berry Juice, Leppa and the hack's items are above.
  figyberry: heldCheck('figyberry'),
  wikiberry: heldCheck('wikiberry'),
  magoberry: heldCheck('magoberry'),
  aguavberry: heldCheck('aguavberry'),
  iapapaberry: heldCheck('iapapaberry'),
  cheriberry: heldCheck('cheriberry'),
  chestoberry: heldCheck('chestoberry'),
  pechaberry: heldCheck('pechaberry'),
  rawstberry: heldCheck('rawstberry'),
  aspearberry: heldCheck('aspearberry'),
  persimberry: heldCheck('persimberry'),
  lumberry: { ...heldCheck('lumberry'), onAfterSetStatus: undefined },
  mentalherb: heldCheck('mentalherb'),
};

// ---------------------------------------------------------------------------------------------------------------------
// Weather rocks and Light Clay

/** A copy of the Gen 4 condition `owner` (a Showdown condition, or a move or ability that owns one) holds. */
function condition(owner: unknown): Record<string, unknown> {
  const own = (owner as { condition?: Record<string, unknown> } | undefined)?.condition;
  return { ...(own ?? (owner as Record<string, unknown>)) };
}

/**
 * The duration of a weather move or a screen: 5 turns, plus the held extend item's parameter when the user holds it
 * (`GetItemEffectParam`, effect_script_0136.s:12-14, 0137.s, 0115.s, 0164.s; Reflect's and Light Screen's, bs:4229,
 * :4272). The hack's weather rocks have parameter 7, so 12 turns; Light Clay's is vanilla's 3. None under Klutz or
 * Embargo (Showdown's `hasItem`). A weather an ability sets has no end (Showdown's `onFieldStart`, Gen 4).
 */
function extended(base: Record<string, unknown>, item: string, vanilla: number) {
  return {
    ...base,
    durationCallback(this: Battle, source: Pokemon | null) {
      return 5 + (source?.hasItem(item) ? heldParam(item, vanilla) : 0);
    },
  };
}

const GEN4_CONDITIONS = GEN4.data.Conditions as unknown as Record<string, Record<string, unknown>>;
const GEN4_MOVES = GEN4.data.Moves as unknown as Record<string, unknown>;

/** The mod's conditions that read an extend item's parameter. Screens: the move's own condition, durationCallback(target, source). */
export const KAIZO_ITEM_CONDITIONS: Record<string, Record<string, unknown>> = {
  raindance: extended(condition(GEN4_CONDITIONS['raindance']), 'damprock', 3),
  sunnyday: extended(condition(GEN4_CONDITIONS['sunnyday']), 'heatrock', 3),
  sandstorm: extended(condition(GEN4_CONDITIONS['sandstorm']), 'smoothrock', 3),
  hail: extended(condition(GEN4_CONDITIONS['hail']), 'icyrock', 3),
  reflect: { ...condition(GEN4_MOVES['reflect']), durationCallback(this: Battle, _target: Pokemon, source: Pokemon | null) { return 5 + (source?.hasItem('lightclay') ? heldParam('lightclay', 3) : 0); } },
  lightscreen: { ...condition(GEN4_MOVES['lightscreen']), durationCallback(this: Battle, _target: Pokemon, source: Pokemon | null) { return 5 + (source?.hasItem('lightclay') ? heldParam('lightclay', 3) : 0); } },
};
