// The `platkaizo` mod's chance sites: each random draw of the cartridge's battle code becomes a labelled pick of the
// battle's chance driver (`pickLabelled`, chance.ts) with the cartridge's exact u16 weights (odds.ts), in place of
// Showdown's raw draw. Each site cites the pokeplatinum lines it follows (src/battle/ unless another path is given).
//
// | Site                                   | Label       | Outcomes                    | Weights                                      |
// |----------------------------------------|-------------|-----------------------------|----------------------------------------------|
// | damage roll (`modifyDamage`, `damageRoll`) | `roll`  | see below                   | 4096 × the rolls (of 16) the option groups   |
// | crit (`getDamage`)                     | `crit`      | `crit`, `normal`            | `residueWeights(16/8/4/3/2)[0]` by stage     |
// | accuracy (`hitStepAccuracy`)           | `hit`       | `hit`, `miss`               | `belowWeight(100, cartridgeHitRate)`         |
// | secondary effects, self effects        | `effect`    | the effect, `none`          | `belowWeight(100, chance)`                   |
// | action order, equal Speed (speedOrder.ts) | `speedTie` | `p1First`, `p2First`     | 1/2 each (`RandNext() & 1`)                  |
// | `monSpeedOrder`, equal Speed (speedOrder.ts) | `speedTie` | `p1First`, `p2First`  | 1/2 each, once per action                    |
// | Quick Claw's `speedRand` (speedOrder.ts) | `quickClaw` | `activate`, `none`         | `residueWeights(5)[0]` against the rest      |
// | variable multi-hit                     | `multiHit`  | `2` … `5`                   | 3 : 3 : 1 : 1                                |
//
// A `roll` label's outcome has two meanings, which its `rollValue` names. A collapsed pick
// (`finalRolls`: only under `expandTurn`'s driver, in `modifyDamage`, when the hit's `ModifyDamage` handlers are all
// pure) has one option per final damage, the damage after STAB, the type chart and the final modifier but before the
// HP cap, labelled with that number; on a hit that lands at once and whose `Damage` handlers are all in
// `SAME_FOR_FATAL_HITS` (`fatalHitsAlike`), every roll whose final damage is at least the target's HP is instead in one
// option labelled `≥hp` (the knock-out, or 1 HP left through False Swipe, Endure or a Focus item). Its labels say
// 'final'. The confusion self-hit (mod/conditions.ts `confusionHit`) goes through `modifyDamage` like any hit, so it
// collapses too (equal damage only: it doesn't land through `getSpreadDamage`). Every other pick (any other driver, a
// hit with a resist berry, and Showdown's own rolls through `damageRoll`: `randomizer`, and `getConfusionDamage`, which
// the mod's confusion doesn't call) has one option per value at the roll's own stage of the formula, before STAB and
// the type chart, labelled with that number; its labels say 'base' (chance.ts `labelOf`).
// Either way the options are highest first and each weighs 4096 per roll it groups.
//
// The first option of each pick is the one a script-less run takes: a crit, the highest roll, the effect, a hit, the
// player first, Quick Claw activating, two hits (Showdown's raw draws took the same first outcomes). A site with one
// possible outcome draws nothing. The speed order, its ties, Quick Claw and the stored Speed values (`endTurn` among
// them) are speedOrder.ts's; the counters and durations conditions.ts's, the move draws moves.ts's, the ability and item
// procs procs.ts's. Any other random draw is still raw, and so unproven.

import PS from 'pokemon-showdown';
import type { Side } from '../../contracts/engine.js';
import { type ChanceOption, driverOf, pickLabelled } from '../chance.js';
import { belowWeight, residueWeights, U16 } from '../odds.js';
import { installedMoves } from '../dex.js';
import { cartridgeHitRate, type MicleMove, sturdyStopsOhko, usesAccuracyFormula } from './accuracy.js';
import { markNoEffect, typeChartImmune } from './conditions.js';
import { cartridgeBaseDamage, cartridgePower, chartFlags, chartStep, isDropped } from './damage.js';
import { faintMessages, noteSendOut } from './exp.js';
import { heldParam } from './itemData.js';
import { findPokemonEventHandlers, pinchAfterMove } from './items.js';
import { addUnmodelledNote } from '../unmodelled.js';
import { switchInChecks } from './procs.js';
import { clearMoveFirst, eachEvent, endTurn, insertionIndex, runAction, speedSort } from './speedOrder.js';

const { Battle, Dex, toID } = PS;

type SecondaryEffect = NonNullable<ActiveMove['secondaries']>[number];

/** The side `pokemon` is on, or null for none. */
function sideOf(pokemon: Pokemon | null | undefined): Side | null {
  return pokemon ? (pokemon.side.id as Side) : null;
}

/**
 * A move's ID for a label. Gen 4's Future Sight and Doom Desire compute their damage from a plain move object with a
 * name and no ID (data/mods/gen4/moves.ts, `onTry`), so the ID comes from the name then.
 */
function moveIdOf(move: ActiveMove): string {
  return move.id || toID(move.name);
}

/** A yes/no point's options: `yes` of the 65,536 draws for the first, the rest for the second. */
function yesNo(yes: bigint, yesName: string, noName: string): ChanceOption[] {
  return [{ weight: yes, outcome: yesName }, { weight: U16 - yes, outcome: noName }];
}

// ---------------------------------------------------------------------------------------------------------------------
// The damage roll

/** One damage roll's share: `r % 16` takes each of its 16 values for 4096 of the draws. */
const ROLL_WEIGHT = U16 / 16n;

/**
 * The 16 rolls of `BattleSystem_CalcDamageVariance` (battle_lib.c:7081-7094) on a nonzero damage: the damage times
 * `100 − (r % 16)`, divided by 100, at least 1, grouped by the value they give (highest first: the values only fall
 * as r rises), each value with the rolls' weight, 4096 per roll.
 */
function rollValues(battle: Battle, damage: number): { values: number[]; weights: bigint[] } {
  const tr = battle.trunc;
  const values: number[] = [];
  const weights: bigint[] = [];
  for (let r = 0; r < 16; r++) {
    const value = Math.max(1, tr(tr(damage * (100 - r)) / 100));
    if (values[values.length - 1] === value) {
      weights[weights.length - 1]! += ROLL_WEIGHT;
    } else {
      values.push(value);
      weights.push(ROLL_WEIGHT);
    }
  }
  return { values, weights };
}

/**
 * The damage roll, `BattleSystem_CalcDamageVariance` (battle_lib.c:7081-7094): a nonzero damage times
 * `100 − (r % 16)`, divided by 100, at least 1. The 16 rolls are grouped by the damage they give, so the pick has one
 * option per damage value (highest first), weighed 4096 per roll; its label is `roll`, outcome the damage value at this
 * stage of the formula (before STAB and the type chart), `rollValue` 'base'. A move's damage rolls in `modifyDamage`, which can group them further (`finalRolls`); this is every other
 * roll.
 */
export function damageRoll(battle: Battle, damage: number, attacker: Pokemon | null, source: string): number {
  if (damage === 0) return 0;
  const { values, weights } = rollValues(battle, damage);
  const options = values.map((value, i): ChanceOption => ({ weight: weights[i]!, outcome: `${value}` }));
  return values[pickLabelled(battle, 'roll', sideOf(attacker), source, options)]!;
}

// The knock-out-roll collapse. A move's roll in `modifyDamage` can be picked after the rest of the
// formula (STAB, the type chart, Showdown's `ModifyDamage` handlers), when each of those handlers only reads the
// battle: then every roll's final damage is known at the pick, so rolls that deal the same damage are one option, and
// on a hit that lands now (`getSpreadDamage`) every roll that deals at least the target's HP is one option too, the
// `≥hp` group (its label's outcome), when nothing downstream reads more than "at least the HP". Only an expansion's
// own driver collapses (`ChanceDriver.collapse`, expand.ts); every other driver picks as the cartridge draws, one
// option per value before STAB.
//
// Who reads the damage after the roll, and why the `≥hp` group is exact (Showdown 0.11.11 sim/battle.ts, the engine,
// and pokeplatinum src/battle/battle_controller_player.c `BattleControllerPlayer_UpdateHP` :3342-3443):
// - Showdown's `Damage` handlers see the damage before it is capped. `SAME_FOR_FATAL_HITS` lists those whose result
//   and side effects are the same for every damage of at least the HP (False Swipe, Endure, Focus Sash, Focus Band:
//   HP − 1 and their message or pick; the rest pass move damage through). Any other handler on the hit (Bide's, which
//   adds the damage up) turns the group off.
// - Then `Pokemon.damage` caps the damage at the HP (sim/pokemon.ts `damage`), and everything after reads the capped
//   value: drain (`spreadDamage`), recoil (`move.totalDamage`, the sum of capped hits), Shell Bell, `lastDamage`,
//   Counter and Mirror Coat (`attackedBy`), `DamagingHit` handlers (Rage, contact abilities), the next hit of a
//   multi-hit move (which a knock-out ends), the `|-damage|` line (the HP left). Life Orb's recoil is a tenth of the
//   user's max HP.
// - The cartridge caps the same way for everything that outlives the hit: `hitDamage` (battle_script.c:1700-1705),
//   which recoil (subscript_recoil_1_2/1_3/1_4.s) and drain (subscript_drain_half_damage_dealt.s) read, and Shell
//   Bell's `shellBellDamageDealt` (:3427-3431), are capped at the HP; False Swipe, Endure and the Focus items cap at
//   HP − 1 first (:3381-3404). Only a knocked-out defender's own records keep the uncapped damage (`storedDamage`,
//   `physicalDamageTakenFrom`, `specialDamageTakenFrom`, `lastDamageTaken`, :3407-3433), which Bide, Counter, Mirror
//   Coat and Metal Burst read for the fainted defender itself, which never moves again: the turn flags are cleared
//   before the next turn (`BattleSystem_SetupNextTurn`, battle_lib.c:2228-2231), and a Bide that starts sets its stored
//   damage to 0 (subscript_bide_start.s:8).
// - A substitute (its own `TryPrimaryHit` handler, not `getSpreadDamage`), Future Sight (stored for later) and the
//   confusion self-hit get the equal-damage grouping only.

/**
 * `ModifyDamage` handlers (gen4 and the mod) that only read the
 * battle and return a `chainModify`: running them once per roll changes nothing. The resist berries are not among
 * them: they eat the berry.
 */
const PURE_MODIFY_DAMAGE: ReadonlySet<string> = new Set([
  'Condition:dynamax', 'Condition:minimize', 'Condition:dig', 'Condition:dive', 'Condition:fly', 'Condition:auroraveil',
  'Condition:glaiverush',
]);

/**
 * `Damage` handlers whose result and side effects are the same for every move damage of at least the target's HP:
 * False Swipe, Endure, gen4 Focus Sash's volatile and the mod's Focus Band (HP − 1, with their message or pick,
 * mod/procs.ts), and those that pass move damage through (Magic Guard, Damp, Heatproof, Poison Heal, Rock Head) or set
 * one flag (Gluttony's `abilityState.gluttony`). Not Bide, which adds the damage up.
 */
const SAME_FOR_FATAL_HITS: ReadonlySet<string> = new Set([
  'Move:falseswipe', 'Condition:endure', 'Condition:focussash', 'Item:focussash', 'Item:focusband',
  'Ability:magicguard', 'Ability:damp', 'Ability:heatproof', 'Ability:poisonheal', 'Ability:rockhead', 'Ability:gluttony',
]);

const handlerKey = (handler: { effect: { effectType: string; id: string } }) => `${handler.effect.effectType}:${handler.effect.id}`;

/**
 * The target of the hit whose damage `getSpreadDamage` is computing now, by battle: that damage lands at once. Empty at
 * every snapshot: set around one `getDamage` call and deleted in its `finally`. So an `expandTurn` leaf's battle handed
 * to `peek` (facts.ts `keepLive`) holds no entry, as a restored one holds none. A per-battle memo here that
 * outlives the call must be dropped in `keepLive` too.
 */
const landingNow = new WeakMap<Battle, Pokemon>();

/**
 * The options of the roll in `modifyDamage` when the rest of the formula (`rest`) only reads the battle: one per final
 * damage (highest first, labelled with it), and on a hit that lands now, the rolls that deal at least the target's HP
 * as one `≥hp` option, each with `rollValue` 'final'. Null when the rolls can't be grouped so (a handler with side
 * effects, or no collapse asked).
 */
function finalRolls(
  battle: Battle, pokemon: Pokemon, target: Pokemon, move: ActiveMove, values: readonly number[], weights: readonly bigint[],
  rest: (value: number) => number,
): { finals: number[]; options: ChanceOption[] } | null {
  if (!driverOf(battle).collapse || battle.debugMode) return null; // debug mode would log each handler run
  if (!battle.findEventHandlers(pokemon, 'ModifyDamage', target).every((handler) => PURE_MODIFY_DAMAGE.has(handlerKey(handler)))) return null;
  const hp = landingNow.get(battle) === target && fatalHitsAlike(battle, pokemon, target, move) ? target.hp : Infinity;
  const finals: number[] = [];
  const options: ChanceOption[] = [];
  for (let i = 0; i < values.length; i++) {
    const final = rest(values[i]!);
    const at = final >= hp ? finals.findIndex((other) => other >= hp) : finals.indexOf(final);
    if (at >= 0) {
      options[at]!.weight += weights[i]!;
    } else {
      finals.push(final);
      options.push({ weight: weights[i]!, outcome: final >= hp ? '≥hp' : `${final}`, rollValue: 'final' });
    }
  }
  return { finals, options };
}

/** Whether every `Damage` handler on `pokemon`'s hit on `target` treats all damage of at least the HP alike. */
function fatalHitsAlike(battle: Battle, pokemon: Pokemon, target: Pokemon, move: ActiveMove): boolean {
  if (typeof (move as { onDamage?: unknown }).onDamage === 'function' && !SAME_FOR_FATAL_HITS.has(`Move:${move.id}`)) return false;
  return battle.findEventHandlers(target, 'Damage', pokemon).every((handler) => SAME_FOR_FATAL_HITS.has(handlerKey(handler)));
}

// ---------------------------------------------------------------------------------------------------------------------
// The crit

/** `sCriticalStageRates` (battle_lib.c:7097-7103): a crit is 1 in N at stages 0 to 4. */
const CRIT_RATES = [16, 8, 4, 3, 2] as const;

/**
 * Whether a hit crits, as `BattleSystem_CalcCriticalMulti` decides (battle_lib.c:7105-7148): a crit iff
 * `RandNext() % rate == 0` (:7134), so weight `residueWeights(rate)[0]`, unless Battle Armor or Shell Armor (which Mold
 * Breaker ignores), the defender's Lucky Chant or `MOVE_EFFECT_NO_CRITICAL` (never set) blocks it (:7135-7138). The
 * stage is Showdown's `ModifyCritRatio` sum less one (Showdown counts from 1), capped at 4: the move's own stage plus
 * Focus Energy's 2, Scope Lens and Razor Claw's 1, Super Luck's 1, and Lucky Punch and Stick's 2, the cartridge's terms
 * (:7123-7132). Showdown's blockers are its `CriticalHit` handlers, which only read the battle, so they run first and
 * a blocked crit draws nothing.
 */
function critRoll(battle: Battle, attacker: Pokemon, target: Pokemon, move: ActiveMove, critRatio: number): boolean {
  if (!battle.runEvent('CriticalHit', target, null, move)) return false;
  const rate = CRIT_RATES[Math.min(critRatio, CRIT_RATES.length) - 1]!;
  return pickLabelled(battle, 'crit', sideOf(attacker), moveIdOf(move), yesNo(residueWeights(rate)[0]!, 'crit', 'normal')) === 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Accuracy

/** Whether `attacker`'s `move` hits at `hitRate` (accuracy.ts): a hit iff `r % 100 < hitRate`. */
function hitRoll(battle: Battle, attacker: Pokemon, move: ActiveMove, hitRate: number | true): boolean {
  if (hitRate === true || hitRate >= 100) return true;
  return pickLabelled(battle, 'hit', sideOf(attacker), moveIdOf(move), yesNo(belowWeight(100, Math.max(0, hitRate)), 'hit', 'miss')) === 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Secondary effects

/** A secondary effect's name for its label: its status or volatile, or its stat changes. */
function effectName(effect: SecondaryEffect): string {
  if (effect.status) return effect.status;
  if (effect.volatileStatus) return effect.volatileStatus;
  const boosts = effect.boosts ?? effect.self?.boosts;
  if (boosts) {
    const changes = Object.entries(boosts).map(([stat, change]) => `${stat}${change > 0 ? '+' : ''}${change}`).join(',');
    return effect.boosts ? changes : `self:${changes}`;
  }
  return 'effect';
}

/**
 * Whether a move's secondary effect happens. The cartridge's probabilistic side effects (`MOVE_SIDE_EFFECT_PROBABILISTIC`
 * and the other indirect ones, battle_lib.c:1551-1587) happen iff `RandNext() % 100 < effectChance` (:1560, :1579),
 * the chance doubled by Serene Grace (:1552-1556, :1571-1575; Showdown's Gen 4 Serene Grace has already doubled it), so
 * weight `belowWeight(100, chance)`. An effect with no chance, or a chance of 100 or more, always happens, and one on
 * a target with no HP left never does (:1565-1567, :1582); neither draws.
 */
function effectRoll(
  battle: Battle, source: Pokemon, target: Pokemon | null, move: ActiveMove, effect: SecondaryEffect, name = effectName(effect),
): boolean {
  // King's Rock's and Razor Fang's flinch (mod/procs.ts) is the item's draw: `itemProc` by the item, weighed by its
  // `itemPower` alone, never Serene Grace's doubled chance (bcp:4645-4669).
  const { kaizoItemProc: item, kaizoItemPower: power } = effect as { kaizoItemProc?: string; kaizoItemPower?: number };
  const chance = item !== undefined ? power : effect.chance;
  if (chance === undefined || chance >= 100) return true;
  if (target && !target.hp && !effect.self) return false;
  const weight = belowWeight(100, Math.max(0, chance));
  if (item !== undefined) return pickLabelled(battle, 'itemProc', sideOf(source), item, yesNo(weight, name, 'none')) === 0;
  return pickLabelled(battle, 'effect', sideOf(source), moveIdOf(move), yesNo(weight, name, 'none')) === 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Multi-hit

/** `BtlCmd_SetMultiHit` (battle_script.c:2634-2660): `r & 3` gives 2 or 3 hits for 0 or 1, else `(r' & 3) + 2`. */
const MULTI_HIT: readonly ChanceOption[] = [
  { weight: 3n, outcome: '2' }, { weight: 3n, outcome: '3' }, { weight: 1n, outcome: '4' }, { weight: 1n, outcome: '5' },
];

/** The number of hits of `move`: its fixed count, or 2 to 5 picked as the cartridge draws them, 5 with Skill Link (:2642-2643). */
function multiHitCount(battle: Battle, pokemon: Pokemon, move: ActiveMove): number {
  const hits = move.multihit;
  if (!Array.isArray(hits)) return hits ?? 1;
  if (hits[0] === 2 && hits[1] === 5) {
    if (pokemon.hasAbility('skilllink')) return 5;
    return 2 + pickLabelled(battle, 'multiHit', sideOf(pokemon), moveIdOf(move), MULTI_HIT);
  }
  return battle.random(hits[0]!, hits[1]! + 1); // no Gen 4 move has another range: Showdown's raw draw, flagged
}

// ---------------------------------------------------------------------------------------------------------------------
// The overridden methods

/**
 * The ROM effects whose scripts test `VOLATILE_CONDITION_MOVE_LOCKED` (res/battle/scripts/effects/effect_script_0026, 0039, 0075, 0145,
 * 0151, 0155, 0255, 0256, 0263, 0272: Bide, the charge-turn moves, Fly, Dive, Dig, Bounce, Shadow Force), which `BattleSystem_UpdateMetronomeCount`
 * leaves the count alone for (bl:6162-6165), and Rollout and Ice Ball's (117; `VerifyMetronomeCount` skips a repeated move, bl:6187). Thrash
 * and Uproar have their own bits there. Showdown's count keeps going through all of them.
 */
const METRONOME_LOCKED_EFFECTS: ReadonlySet<number> = new Set([26, 39, 75, 117, 145, 151, 155, 255, 256, 263, 272]);

/** The note for a Metronome holder whose count the cartridge keeps differently from Showdown's (locked into a move, or its last use failed). */
export const METRONOME_COUNT_NOTE = "engine: a Metronome item's count after a locked or failed use is Showdown's, not the cartridge's (bl:6160-6200)";

/**
 * Showdown's `getDamage` (sim/battle-actions.ts:1585-1722) with the crit picked by `critRoll` and the damage worked out in
 * the cartridge's order (damage.ts): the move's power through its own `BasePower` handlers and the
 * cartridge's power steps, then the stat terms, the stages and the formula; `modifyDamage` does the rest.
 */
function getDamage(
  this: BattleActions, source: Pokemon, target: Pokemon, moveOrPower: string | number | ActiveMove, suppressMessages = false,
): number | undefined | null | false {
  let move: ActiveMove;
  if (typeof moveOrPower === 'string') {
    move = this.dex.getActiveMove(moveOrPower);
  } else if (typeof moveOrPower === 'number') {
    move = new Dex.Move({ basePower: moveOrPower, type: '???', category: 'Physical', willCrit: false }) as ActiveMove;
    move.hit = 0;
  } else {
    move = moveOrPower;
  }

  if (!target.runImmunity(move, !suppressMessages)) return false;

  // A one-hit KO move deals the target's current HP (`BtlCmd_TryOHKOMove`, battle_script.c:4378:
  // `battleCtx->damage = DEFENDING_MON.curHP * -1`), so a substitute with more HP survives it; Showdown's Gen 4 the max HP.
  if (move.ohko) return target.hp;
  if (move.damageCallback) return move.damageCallback.call(this.battle, source, target);
  if (move.damage === 'level') {
    return source.level;
  } else if (move.damage) {
    return move.damage;
  }

  let basePower: number | false | null = move.basePower;
  if (move.basePowerCallback) basePower = move.basePowerCallback.call(this.battle, source, target, move);
  if (!basePower) return basePower === 0 ? undefined : basePower;
  basePower = this.battle.clampIntRange(basePower, 1);

  // Gen 4 counts crit stages 0 to 4 as Showdown's critRatio 1 to 5 (`critRoll`).
  let critRatio = this.battle.runEvent('ModifyCritRatio', source, target, move, move.critRatio || 0);
  critRatio = this.battle.clampIntRange(critRatio, 0, 5);

  const moveHit = target.getMoveHitData(move);
  moveHit.crit = move.willCrit || false;
  if (move.willCrit === undefined) {
    if (critRatio) moveHit.crit = critRoll(this.battle, source, target, move, critRatio); // checks the blockers too
  } else if (moveHit.crit) {
    moveHit.crit = this.battle.runEvent('CriticalHit', target, null, move);
  }

  // A move whose power the mod set with the cartridge's own terms (the confusion self-hit, mod/conditions.ts
  // `confusionHit`) skips the power steps; its stat terms are the cartridge's like any move's.
  const selfHit = !!(move as { kaizoFixedPower?: boolean }).kaizoFixedPower;
  // happens after crit calculation. What `BasePower` still runs is the move's own (Facade's and Brine's doubling, the
  // rollout storage): `isDropped` (damage.ts) turns off every item and ability handler, which `cartridgePower` replaces.
  if (!selfHit) basePower = this.battle.runEvent('BasePower', source, target, move, basePower, true);

  if (!basePower) return 0;
  basePower = this.battle.clampIntRange(basePower, 1);
  if (!selfHit) basePower = cartridgePower(this.battle, source, target, move, basePower);

  return this.modifyDamage(cartridgeBaseDamage(this.battle, source, target, move, basePower, moveHit.crit, selfHit), source, target, move, suppressMessages);
}

/**
 * Showdown's Gen 4 `modifyDamage` (data/mods/gen4/scripts.ts:57-137) with the cartridge's order and the roll
 * picked by `damageRoll`. `damage` is `cartridgeBaseDamage`'s (it ends with the `+ 2`). Then, as `BattleScript_CalcMoveDamage`
 * (battle_script.c:1344-1348) and `BtlCmd_CalcDamage` (:1380-1389) do: the critical multiplier (3 with Sniper), Life Orb,
 * the roll; and as `BattleSystem_ApplyTypeChart` (battle_lib.c:2560-2679) does: STAB, the chart row by row, and the final modifiers
 * (`chartStep`). The confusion self-hit has no crit, Life Orb or chart.
 */
function modifyDamage(this: BattleActions, damage: number, pokemon: Pokemon, target: Pokemon, move: ActiveMove, suppressMessages = false): number {
  let baseDamage = damage;

  if (!move.type) move.type = '???';
  const selfHit = !!(move as { kaizoFixedPower?: boolean }).kaizoFixedPower;
  const isCrit = target.getMoveHitData(move).crit;
  if (isCrit) baseDamage *= pokemon.hasAbility('sniper') ? 3 : 2;
  if (!selfHit && pokemon.hasItem('lifeorb') && !move.flags['futuremove']) baseDamage = Math.floor((baseDamage * (100 + heldParam('lifeorb', 30))) / 100);

  // The Metronome item: x (10 + turns) / 10 (bs:1350-1352), turns the consecutive uses Showdown's volatile counts, at most 10.
  const metronome = pokemon.hasItem('metronome') ? pokemon.volatiles['metronome'] : undefined;
  // The cartridge counts differently when the holder is locked into a move (Thrash, Outrage, Petal Dance, Uproar, a charge) or its
  // last use failed (bl:6160-6200: the count is left alone while locked, and a failed repeat is taken back), by a whole step.
  const locked = METRONOME_LOCKED_EFFECTS.has(installedMoves().get(move.num)?.romEffect ?? -1) || ['lockedmove', 'uproar', 'twoturnmove', 'rollout', 'iceball'].some((id) => pokemon.volatiles[id]);
  if (!selfHit && metronome && (pokemon.moveLastTurnResult === false || locked)) addUnmodelledNote(this.battle, METRONOME_COUNT_NOTE);
  if (!selfHit && metronome) baseDamage = Math.floor((baseDamage * (10 + Math.min(10, (metronome['numConsecutive'] as number | undefined) ?? 0))) / 10);

  // The roll ("this is not a modifier") is picked last, below: the type chart's flags and the final modifiers come first.
  const flags = chartFlags(pokemon, target, move, !!this.battle.field.getPseudoWeather('gravity'));
  const typeMod = flags.superEffective ? 1 : flags.notVeryEffective ? -1 : 0;
  target.getMoveHitData(move).typeMod = typeMod;
  if (typeMod > 0 && !suppressMessages) this.battle.add('-supereffective', target);
  if (typeMod < 0 && !suppressMessages) this.battle.add('-resisted', target);

  if (isCrit && !suppressMessages) this.battle.add('-crit', target);

  /** The rest of the formula on a rolled damage: STAB, the type chart, the final modifiers, at least 1. */
  const rest = (rolled: number): number => {
    let damage = chartStep(pokemon, target, move, rolled, flags);
    // What `ModifyDamage` still runs: the resist berries and the semi-invulnerable and Minimize conditions.
    damage = this.battle.runEvent('ModifyDamage', pokemon, target, move, damage);
    return Math.floor(damage) || 1;
  };

  const held = target.item;
  if (baseDamage === 0) return rest(0); // no roll: the variance leaves 0 alone
  const { values, weights } = rollValues(this.battle, baseDamage);
  const side = sideOf(pokemon);
  const final = finalRolls(this.battle, pokemon, target, move, values, weights, rest);
  if (final !== null) return final.finals[pickLabelled(this.battle, 'roll', side, moveIdOf(move), final.options)]!;
  const options = values.map((value, i): ChanceOption => ({ weight: weights[i]!, outcome: `${value}` }));
  const dealt = rest(values[pickLabelled(this.battle, 'roll', side, moveIdOf(move), options)]!);
  if (held !== '' && target.item === '' && isResistBerry(this.battle, held)) noteResistBerry(this.battle, pokemon, target, move);
  return dealt;
}

/** The note for a resist berry's halving that the cartridge's later order would change (`noteResistBerry`). */
export const RESIST_BERRY_NOTE = 'engine: a resist berry halved a hit that False Swipe or Endure caps, or that Counter, Mirror Coat, Metal Burst or Shell Bell reads (the cartridge halves after the caps and the records, bcp:3381-3433)';

/** Whether Showdown item `id` is a resist berry (Gen 4's: it halves a hit in `SourceModifyDamage` and is a berry). */
function isResistBerry(battle: Battle, id: string): boolean {
  const item = battle.dex.items.get(id);
  return item.isBerry && typeof (item as { onSourceModifyDamage?: unknown }).onSourceModifyDamage === 'function';
}

/** `BATTLE_EFFECT_LEAVE_WITH_1_HP` (False Swipe), and the moves that read the damage a Pokémon took this turn: Bide, Counter, Mirror Coat, Metal Burst. */
const FALSE_SWIPE_EFFECT = 101;
const DAMAGE_READERS: ReadonlySet<number> = new Set([26, 89, 144, 227]);

/**
 * Notes a resist berry `target` just ate on `source`'s hit where the cartridge's order gives another result
 * (`RESIST_BERRY_NOTE`). The cartridge doesn't halve the damage in the formula:
 * `BattleControllerPlayer_UpdateHP` (bcp:3342-3443) first caps it at HP − 1 for False Swipe (:3381-3384), Endure and the
 * Focus items (:3386-3405), then records it for Bide (`storedDamage`, :3407), Counter and Mirror Coat
 * (`physicalDamageTakenFrom`, `specialDamageTakenFrom`, :3413-3425), Metal Burst (`lastDamageTaken`, :3433) and Shell Bell
 * (`shellBellDamageDealt`, :3427-3431), and only then subscript_update_hp halves the HP change in
 * subscript_type_resist_berry.s (:111, `DivideVarByValue BTLVAR_HP_CALC_TEMP, 2`). The engine halves in the formula
 * (Showdown's `onSourceModifyDamage`), before the caps, and its records hold the halved damage. So the two differ when the
 * hit is False Swipe's or the holder endures (the holder holds the berry, so no Focus item), when the holder can use a
 * move that reads the damage it took (by ROM effect: Bide, Counter, Mirror Coat, Metal Burst), or when the attacker holds
 * Shell Bell. Drain and recoil read the HP change itself (`hitDamage`, bs:1700-1705), which is halved on both.
 */
function noteResistBerry(battle: Battle, source: Pokemon, target: Pokemon, move: ActiveMove): void {
  const moves = installedMoves();
  const capped = moves.get(move.num)?.romEffect === FALSE_SWIPE_EFFECT || move.id === 'falseswipe' || !!target.volatiles['endure'];
  const reads = target.moveSlots.some((slot) => DAMAGE_READERS.has(moves.get(battle.dex.moves.get(slot.id).num)?.romEffect ?? -1));
  if (capped || reads || source.hasItem('shellbell')) addUnmodelledNote(battle, RESIST_BERRY_NOTE);
}

/**
 * Showdown's `findEventHandlers` without the handlers the cartridge terms replace (`isDropped`, damage.ts). Every other
 * event, and the other handlers of these, run as Showdown's.
 */
function findEventHandlers(this: Battle, ...args: Parameters<Battle['findEventHandlers']>): ReturnType<Battle['findEventHandlers']> {
  const handlers = Battle.prototype.findEventHandlers.apply(this, args);
  return handlers.filter((handler) => !isDropped(args[1], handler.effect));
}

/**
 * Showdown's `getSpreadDamage` (sim/battle-actions.ts:1148-1184), marking each target's damage as landing at once
 * (`landingNow`), for the knock-out-roll collapse.
 */
function getSpreadDamage(
  this: BattleActions, damage: SpreadMoveDamage, targets: SpreadMoveTargets, source: Pokemon, move: ActiveMove,
  moveData: ActiveMove, isSecondary?: boolean, isSelf?: boolean,
): SpreadMoveDamage {
  for (const [i, target] of targets.entries()) {
    if (!target) continue;
    this.battle.activeTarget = target;
    damage[i] = undefined;
    if (moveData === move) landingNow.set(this.battle, target); // spreadDamage deals it with `move` as the effect
    let curDamage: ReturnType<BattleActions['getDamage']>;
    try {
      curDamage = this.getDamage(source, target, moveData);
    } finally {
      landingNow.delete(this.battle);
    }
    // getDamage has several possible return values:
    //
    //   a number:
    //     means that much damage is dealt (0 damage still counts as dealing
    //     damage for the purposes of things like Static)
    //   false:
    //     gives error message: "But it failed!" and move ends
    //   null:
    //     the move ends, with no message (usually, a custom fail message
    //     was already output by an event handler)
    //   undefined:
    //     means no damage is dealt and the move continues
    //
    // basically, these values have the same meanings as they do for event
    // handlers.

    if (curDamage === false || curDamage === null) {
      if (damage[i] === false && !isSecondary && !isSelf) {
        this.battle.add('-fail', source);
        this.battle.attrLastMove('[still]');
      }
      this.battle.debug('damage calculation interrupted');
      damage[i] = false;
      continue;
    }
    damage[i] = curDamage;
  }
  return damage;
}

/** Showdown's `getConfusionDamage` (sim/battle-actions.ts:1850-1862) with the roll picked by `damageRoll`. */
function getConfusionDamage(this: BattleActions, pokemon: Pokemon, basePower: number): number {
  const tr = this.battle.trunc;

  const attack = pokemon.calculateStat('atk', pokemon.boosts['atk']);
  const defense = pokemon.calculateStat('def', pokemon.boosts['def']);
  const level = pokemon.level;
  const baseDamage = tr(tr(tr(tr(2 * level / 5 + 2) * basePower * attack) / defense) / 50) + 2;

  // Damage is 16-bit context in self-hit confusion damage
  let damage = tr(baseDamage, 16);
  damage = damageRoll(this.battle, damage, pokemon, 'confusion');
  return Math.max(1, damage);
}

/**
 * Showdown's `hitStepTypeImmunity` (sim/battle-actions.ts; dist/sim/battle-actions.js:553-562), which also records the
 * cartridge's `noEffect` flag for the user when a target is immune by the type chart (mod/conditions.ts `markNoEffect`,
 * `typeChartImmune`; bcp:2366-2369). The flag is kept in the battle's state for the rest of the turn, so a mid-turn
 * switch's restore keeps it.
 */
function hitStepTypeImmunity(this: BattleActions, targets: Pokemon[], pokemon: Pokemon, move: ActiveMove): boolean[] {
  if (move.ignoreImmunity === undefined) move.ignoreImmunity = move.category === 'Status';
  const hitResults: boolean[] = [];
  for (const [i, target] of targets.entries()) {
    hitResults[i] = target.runImmunity(move, !move.smartTarget);
    if (!hitResults[i] && typeChartImmune(target, move, pokemon)) markNoEffect(pokemon);
  }
  return hitResults;
}

type HitStep = (this: BattleActions, targets: Pokemon[], pokemon: Pokemon, move: ActiveMove) => (boolean | undefined | null)[];
/** Showdown's Gen 4 `hitStepInvulnerabilityEvent` (data/mods/gen4/scripts.ts). */
const GEN4_INVULNERABILITY = (Dex.mod('gen4').data.Scripts as unknown as { actions: { hitStepInvulnerabilityEvent: HitStep } }).actions.hitStepInvulnerabilityEvent;

/**
 * Showdown's Gen 4 `hitStepInvulnerabilityEvent`, then the cartridge's type chart for a target it found semi-invulnerable.
 * Showdown's semi-invulnerability step comes first and stops there, so its type-immunity step never sees such a target;
 * the cartridge runs the type chart after the accuracy check and its overrides whatever they found (bcp:3254-3279: the
 * semi-invulnerable target only gets `MOVE_STATUS_SEMI_INVULNERABLE`, bcp:3040, and the overrides return 0), so a
 * damaging move into a semi-invulnerable target the chart makes immune (a Ghost in the air or underground) still sets
 * `moveFailFlags.noEffect` (bcp:2350-2369). Recorded as `hitStepTypeImmunity` does; silent,
 * as the cartridge shows only the miss.
 */
function hitStepInvulnerabilityEvent(this: BattleActions, targets: Pokemon[], pokemon: Pokemon, move: ActiveMove): (boolean | undefined | null)[] {
  const hitResults = GEN4_INVULNERABILITY.call(this, targets, pokemon, move);
  if (move.category === 'Status' || move.ignoreImmunity === true) return hitResults; // bcp:2352-2357: a move with power
  for (const [i, target] of targets.entries()) {
    if (hitResults[i] === false && !target.runImmunity(move, false) && typeChartImmune(target, move, pokemon)) markNoEffect(pokemon);
  }
  return hitResults;
}

/**
 * Showdown's Gen 4 `hitStepAccuracy` (data/mods/gen4/scripts.ts:148-204) with the cartridge's hit rate
 * (`cartridgeHitRate`) and a labelled hit pick. A one-hit KO move against a higher level keeps Showdown's
 * `-immune [ohko]`, but Sturdy comes first, as the cartridge checks it first (`BtlCmd_TryOHKOMove`,
 * battle_script.c:4340-4341): its target passes here and Showdown's Sturdy stops the move and shows the ability. A
 * Micle Berry boost the move spent at the formula's step (`micleTryMove`) counts for this one formula; a boost still
 * pending here (a hit no `TryMove` came before, such as a delayed Future Sight) is eaten here.
 */
function hitStepAccuracy(this: BattleActions, targets: Pokemon[], pokemon: Pokemon, move: ActiveMove): boolean[] {
  const hitResults: boolean[] = [];
  for (const [i, target] of targets.entries()) {
    this.battle.activeTarget = target;
    if (move.ohko && !target.isSemiInvulnerable() && pokemon.level < target.level && !sturdyStopsOhko(pokemon, target)) {
      this.battle.add('-immune', target, '[ohko]');
      hitResults[i] = false;
      continue;
    }
    const hitRate = move.alwaysHit ? true : cartridgeHitRate(pokemon, target, move, this.battle);
    delete (move as MicleMove).kaizoMicleBoost; // the first formula's only: Triple Kick's later hits run their own
    eatMicleBoost(this.battle, pokemon, move);
    if (!hitRoll(this.battle, pokemon, move, hitRate)) {
      if (!move.spreadHit) this.battle.attrLastMove('[miss]');
      this.battle.add('-miss', pokemon, target);
      hitResults[i] = false;
      continue;
    }
    hitResults[i] = true;
  }
  return hitResults;
}

/**
 * The hit-rate formula eats a pending Micle Berry boost (bcp:2967-2970): after `cartridgeHitRate` has read it, the
 * volatile goes, with Showdown's `-enditem` line, whenever the formula ran (`usesAccuracyFormula`). `alwaysHit` is
 * Pursuit's switch-out hit (mod/moves.ts), whose subscript never runs the formula (subscript_pursuit.s:7-12).
 */
function eatMicleBoost(battle: Battle, pokemon: Pokemon, move: ActiveMove): boolean {
  if (pokemon.volatiles['micleberry'] && !move.alwaysHit && usesAccuracyFormula(move, battle)) {
    battle.add('-enditem', pokemon, 'Micle Berry');
    pokemon.removeVolatile('micleberry');
    return true;
  }
  return false;
}

/**
 * The format's `TryMove` handler, first of the event (dex.ts): where the cartridge's
 * hit-rate formula runs, and so where a pending Micle Berry boost is spent.
 *
 * The cartridge runs a move's own script first (`BeforeMove` loads it with `TryMove` next, bcp:3211-3216). A move that
 * fails in its script only flags it and ends (Sucker Punch, effect_script_0248.s:5, :10-12; Fake Out, 0158.s:5,
 * :12-13; Last Resort, 0246.s; Focus Punch losing focus, 0170.s:5-6, :12-16; Explosion under Damp, 0007.s:5,
 * :21-31). Then `TryMove` (bcp:3237-3296) runs the formula (`TRY_MOVE_STATE_CHECK_MOVE_HITS`, `CheckMoveHitAccuracy`,
 * which clears the flag at bcp:2967-2970) before the overrides (Protect, Lock-On, No Guard: bcp:3001-3032), the type
 * chart and the immunity abilities (Levitate, Volt Absorb, Wonder Guard and the rest). The formula returns before the
 * flag only for a move with no accuracy, a charge turn and a one-hit KO move (bcp:2900-2913), and nothing skips its
 * step on a first hit (`SYSCTL_SKIP_ACCURACY_CHECK` is set by no script). So the boost is spent by every move that gets
 * past `BeforeMove` with an accuracy, whatever then stops it.
 *
 * Showdown's `TryMove` event is that point: it comes after the move's own `TryMove` (a two-turn move's charge turn
 * stops there, before this handler, as the cartridge's charge turn skips the formula) and before the move's `Try`
 * (Sucker Punch, Fake Out, Last Resort, Gen 4 Focus Punch), Damp's `onAnyTryMove` (this handler's priority runs it
 * first), Protect's `TryHit`, the semi-invulnerable target, the type chart and `TryImmunity`. Pursuit's switch-out hit
 * (`alwaysHit`, mod/moves.ts) runs no formula (subscript_pursuit.s:7-12). The move keeps the boost for its own accuracy
 * check (mod/accuracy.ts reads `kaizoMicleBoost`), which Showdown runs after those steps.
 */
export function micleTryMove(this: Battle, pokemon: Pokemon, target: Pokemon | null, move: ActiveMove): void {
  if (target === null || target === undefined) return;
  if (eatMicleBoost(this, pokemon, move)) (move as MicleMove).kaizoMicleBoost = true;
}

/**
 * Showdown's `hitStepMoveHitLoop` (sim/battle-actions.ts:857-1022) with the hit count from `multiHitCount` and Triple
 * Kick's accuracy on each later hit from `cartridgeHitRate` (the cartridge checks it per hit: Triple Kick's script
 * omits `SYSCTL_SKIP_ACCURACY_CHECK`, battle_script.c:2622-2628), which eats a Micle Berry boost too (`eatMicleBoost`).
 * After each hit of a multi-hit move the pinch items are checked (mod/items.ts `pinchAfterMove`): the cartridge's
 * after-move effects run after every hit, before `LoopMultiHit` (bcp:3638-3769, :3777-3790), so a berry eaten after a
 * hit is gone before the next (a holder knocked out by a later hit has eaten it).
 */
function hitStepMoveHitLoop(this: BattleActions, targets: Pokemon[], pokemon: Pokemon, move: ActiveMove): SpreadMoveDamage {
  let damage: (number | boolean | undefined)[] = [];
  for (const i of targets.keys()) {
    damage[i] = 0;
  }
  move.totalDamage = 0;
  pokemon.lastDamage = 0;
  let targetHits = multiHitCount(this.battle, pokemon, move);
  if (targetHits === 10 && pokemon.hasItem('loadeddice')) targetHits -= this.battle.random(7);
  targetHits = Math.floor(targetHits);
  let nullDamage = true;
  let moveDamage: (number | boolean | undefined)[] = [];
  // There is no need to recursively check the ´sleepUsable´ flag as Sleep Talk can only be used while asleep.
  const isSleepUsable = move.sleepUsable || this.dex.moves.get(move.sourceEffect).sleepUsable;

  let targetsCopy: (Pokemon | false | null)[] = targets.slice(0);
  let hit: number;
  for (hit = 1; hit <= targetHits; hit++) {
    if (damage.includes(false)) break;
    if (hit > 1 && pokemon.status === 'slp' && (!isSleepUsable || this.battle.gen === 4)) break;
    if (targets.every((target) => !target?.hp)) break;
    move.hit = hit;
    move.lastHit = move.hit === targetHits;
    if (move.smartTarget && targets.length > 1) {
      targetsCopy = [targets[hit - 1]!];
      damage = [damage[hit - 1]];
    } else {
      targetsCopy = targets.slice(0);
    }
    const target = targetsCopy[0]; // some relevant-to-single-target-moves-only things are hardcoded
    if (target && typeof move.smartTarget === 'boolean') {
      if (hit > 1) {
        this.battle.addMove('-anim', pokemon, move.name, target);
      } else {
        this.battle.retargetLastMove(target);
      }
    }

    // like this (Triple Kick)
    if (target && move.multiaccuracy && hit > 1) {
      const hitRate = move.alwaysHit ? true : cartridgeHitRate(pokemon, target, move, this.battle);
      eatMicleBoost(this.battle, pokemon, move); // only a boost eaten after an earlier hit is left by now
      if (!hitRoll(this.battle, pokemon, move, hitRate)) break;
    }

    const moveData = move;
    if (!moveData.flags) moveData.flags = {};

    let moveDamageThisHit;
    // Modifies targetsCopy (which is why it's a copy)
    [moveDamageThisHit, targetsCopy] = this.spreadMoveHit(targetsCopy, pokemon, move, moveData);
    // When Dragon Darts targets two different pokemon, targetsCopy is a length 1 array each hit
    // so spreadMoveHit returns a length 1 damage array
    if (move.smartTarget) {
      moveDamage.push(...moveDamageThisHit);
    } else {
      moveDamage = moveDamageThisHit;
    }

    if (!moveDamage.some((val) => val !== false)) break;
    nullDamage = false;

    for (const [i, md] of moveDamage.entries()) {
      if (move.smartTarget && i !== hit - 1) continue;
      // Damage from each hit is individually counted for the
      // purposes of Counter, Metal Burst, and Mirror Coat.
      damage[i] = md === true || !md ? 0 : md;
      // Total damage dealt is accumulated for the purposes of recoil (Parental Bond).
      move.totalDamage += damage[i] as number;
    }
    this.battle.eachEvent('Update');
    if (move.multihit) pinchAfterMove.call(this.battle);
    if (!pokemon.hp && targets.length === 1) {
      hit++; // report the correct number of hits for multihit moves
      break;
    }
  }
  // hit is 1 higher than the actual hit count
  if (hit === 1) return damage.fill(false);
  if (nullDamage) damage.fill(false);
  this.battle.faintMessages(false, false, !pokemon.hp);
  if (move.multihit && typeof move.smartTarget !== 'boolean') {
    this.battle.add('-hitcount', targets[0]!, hit - 1);
  }

  if (move.totalDamage) {
    this.applyRecoilDamage(move.totalDamage, move, pokemon);
  }

  // smartTarget messes up targetsCopy, but smartTarget should in theory ensure that targets will never fail, anyway
  if (move.smartTarget) {
    targetsCopy = targets.slice(0);
  }

  for (const [i, target] of targetsCopy.entries()) {
    if (target && pokemon !== target) {
      target.gotAttacked(move, moveDamage[i] as number | false | undefined, pokemon);
      if (typeof moveDamage[i] === 'number') {
        target.timesAttacked += move.smartTarget ? 1 : hit - 1;
      }
    }
  }

  if (move.ohko && !targets[0]!.hp) this.battle.add('-ohko');

  if (!damage.some((val) => !!val || val === 0)) return damage;

  this.battle.eachEvent('Update');

  this.afterMoveSecondaryEvent(targetsCopy.filter((val): val is Pokemon => !!val), pokemon, move);

  if (!(move.hasSheerForce && pokemon.hasAbility('sheerforce'))) {
    for (const [i, d] of damage.entries()) {
      // There are no multihit spread moves, so it's safe to use move.totalDamage for multihit moves
      // The previous check was for `move.multihit`, but that fails for Dragon Darts
      const curDamage = targets.length === 1 ? move.totalDamage : d;
      if (typeof curDamage === 'number' && targets[i]!.hp) {
        const targetHPBeforeDamage = (targets[i]!.hurtThisTurn || 0) + curDamage;
        if (targets[i]!.hp <= targets[i]!.maxhp / 2 && targetHPBeforeDamage > targets[i]!.maxhp / 2) {
          this.battle.runEvent('EmergencyExit', targets[i]!, pokemon);
        }
      }
    }
  }

  return damage;
}

/** Showdown's `secondaries` (sim/battle-actions.ts:1336-1352) with each effect's chance picked by `effectRoll`. */
function secondaries(this: BattleActions, targets: SpreadMoveTargets, source: Pokemon, move: ActiveMove, moveData: ActiveMove, isSelf?: boolean): void {
  if (!moveData.secondaries) return;
  for (const target of targets) {
    if (target === false) continue;
    const effects: SecondaryEffect[] =
      this.battle.runEvent('ModifySecondaries', target, source, moveData, moveData.secondaries.slice());
    for (const effect of effects) {
      if (effectRoll(this.battle, source, target, move, effect)) this.moveHit(target, source, move, effect, true, isSelf);
    }
  }
}

/**
 * Showdown's `selfDrops` (sim/battle-actions.ts:1317-1335), drawing only for a self effect with a chance below 100
 * (Showdown drew `random(100)` even for a sure one, such as Close Combat's drops, which the cartridge applies on hit).
 */
function selfDrops(this: BattleActions, targets: SpreadMoveTargets, source: Pokemon, move: ActiveMove, moveData: ActiveMove, isSecondary?: boolean): void {
  for (const target of targets) {
    if (target === false) continue;
    if (moveData.self && !move.selfDropped) {
      if (!isSecondary && moveData.self.boosts) {
        const self = moveData.self;
        if (effectRoll(this.battle, source, null, move, self, `self:${effectName(self)}`)) this.moveHit(source, source, move, self, isSecondary, true);
        if (!move.multihit) move.selfDropped = true;
      } else {
        this.moveHit(source, source, move, moveData.self, isSecondary, true);
      }
    }
  }
}

/** Showdown's `BattleQueue.insertChoice` (sim/battle-queue.ts:364-398) with the place from `insertionIndex` (speedOrder.ts). */
function insertChoice(this: BattleQueue, choices: ActionChoice | ActionChoice[], midTurn = false): void {
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      this.insertChoice(choice);
    }
    return;
  }
  const choice = choices;
  if (choice.pokemon) {
    choice.pokemon.updateSpeed();
  }
  const actions = this.resolveAction(choice, midTurn);
  if (actions.length === 0) return;
  this.list.splice(insertionIndex(this.battle, this.list, actions[0]!), 0, ...actions);
}

/** Showdown's Gen 4 `runSwitch` (data/mods/gen4/scripts.ts), which `runSwitch` wraps. */
const GEN4_RUN_SWITCH = (Dex.mod('gen4').data.Scripts as unknown as { actions: { runSwitch: (this: BattleActions, pokemon: Pokemon) => boolean } }).actions.runSwitch;

/**
 * Showdown's Gen 4 `runSwitch` (a switch-in's hazards, abilities and item), then the cartridge's later switch-in
 * checks for every Pokémon out (mod/procs.ts `switchInChecks`: Giratina-Origin's form, White Herb). First the
 * slot's Quick Claw or Custap flag is dropped (speedOrder.ts `clearMoveFirst`).
 */
function runSwitch(this: BattleActions, pokemon: Pokemon): boolean {
  clearMoveFirst(this.battle, pokemon.side.id as Side); // a new battler has no Quick Claw or Custap flag (bl:2100-2104)
  const result = GEN4_RUN_SWITCH.call(this, pokemon);
  switchInChecks(this.battle);
  return result;
}

/**
 * The statuses each party ability forbids (`Ability_ForbidsStatus`, bl:4454-4492): Immunity any poison, Limber
 * paralysis, Insomnia and Vital Spirit sleep, Water Veil a burn, Magma Armor a freeze.
 */
const FORBIDDEN_STATUS: Readonly<Record<string, readonly string[]>> = {
  immunity: ['psn', 'tox'], limber: ['par'], insomnia: ['slp'], vitalspirit: ['slp'], waterveil: ['brn'], magmaarmor: ['frz'],
};

/**
 * Whether `BtlCmd_TryRestoreStatusOnSwitch` (bs:9139-9160) cures `pokemon`, a battler with HP left and a status: its
 * battle ability is Natural Cure (`battleMons[].ability`, bs:9151, as Showdown's `ability`: Gastro Acid leaves the field
 * and sets `MOVE_EFFECT_ABILITY_SUPPRESSED`, which only `Battler_Ability` reads, bl:3090), or its party ability forbids
 * its party status (`Ability_ForbidsStatus`, bs:9152; the save's ability, Showdown's `baseAbility`). The scripts that run
 * it then set the status to none: a switch-out (`switchIn`) and the player's win (battle.ts `carryIn`).
 */
export function restoresStatus(pokemon: Pokemon): boolean {
  if (pokemon.hp <= 0 || pokemon.status === '') return false;
  return pokemon.ability === 'naturalcure' || (FORBIDDEN_STATUS[pokemon.baseAbility]?.includes(pokemon.status) ?? false);
}

type SwitchIn = (this: BattleActions, pokemon: Pokemon, pos: number, sourceEffect?: Effect | null, isDrag?: boolean) => boolean | string;

/**
 * Showdown's `switchIn` (sim/battle-actions.ts, which Gen 4 keeps), then the cartridge's cure of the Pokémon switching
 * out: every switch-out script runs `TryRestoreStatusOnSwitch` on it and sets its status to none, with no message (a
 * switch, subscript_switch_pokemon.s:5-6; Baton Pass, subscript_baton_pass.s:7; U-turn, subscript_attack_then_switch_out.s:56;
 * Roar and Whirlwind, subscript_force_target_to_switch_or_flee.s:11). Showdown's Natural Cure cures at its `SwitchOut`
 * already, but not under Gastro Acid, and nothing of Showdown's cures a status the party ability forbids once the
 * battle ability doesn't (Gastro Acid, or another ability in battle): those are cured here. A fainted Pokémon is not (the command needs HP).
 *
 * Then the EXP participation mask's rule for the newcomer (mod/exp.ts `noteSendOut`). Every send-out comes
 * through here: a switch, a replacement, U-turn, Baton Pass, a Roar or Whirlwind drag, the battle start. It runs before
 * the newcomer's `runSwitch` action, so before its hazards, as the cartridge flags at `PokemonSendOut` and checks the
 * hazards after it (sub/subscript_switch_pokemon.s:39, :43). A switch-in that fails, or stops at Pursuit's knock-out
 * (`'pursuitfaint'`: the switch runs again later), sets no bit.
 */
function switchIn(this: BattleActions, pokemon: Pokemon, pos: number, sourceEffect?: Effect | null, isDrag?: boolean): boolean | string {
  const out = pokemon.side.active[pos];
  const cure = out !== undefined && out !== null && out !== pokemon && restoresStatus(out);
  const result = (Object.getPrototypeOf(this) as { switchIn: SwitchIn }).switchIn.call(this, pokemon, pos, sourceEffect, isDrag);
  if (cure && out.hp > 0 && out.status !== '') out.setStatus('');
  if (result === true) noteSendOut(this.battle, pokemon);
  return result;
}

/** Any other damage roll Showdown makes, through the battle's `randomizer` (sim/battle.ts:2388-2391). */
function randomizer(this: Battle, baseDamage: number): number {
  return damageRoll(this, baseDamage, this.activePokemon, this.activeMove ? moveIdOf(this.activeMove) : 'damage');
}

/**
 * The mod's `Scripts` entries: the battle's own methods, its actions' and its queue's, merged over Gen 4's.
 * `faintMessages` is the EXP payout's (mod/exp.ts); `findPokemonEventHandlers` adds a pinch item's second
 * end-of-turn step (mod/items.ts).
 */
export const KAIZO_SCRIPTS: Record<string, unknown> = {
  eachEvent, endTurn, faintMessages, findEventHandlers, findPokemonEventHandlers, randomizer, runAction, speedSort,
  actions: {
    getConfusionDamage, getDamage, getSpreadDamage, hitStepAccuracy, hitStepInvulnerabilityEvent, hitStepMoveHitLoop, hitStepTypeImmunity,
    modifyDamage, runSwitch, secondaries, selfDrops, switchIn,
  },
  queue: { insertChoice },
};

/**
 * The mod's `Items` entries, merged over Gen 4's. Quick Claw and Custap Berry act through the cartridge's speed order
 * (speedOrder.ts), so Showdown's Gen 4 handlers (data/mods/gen4/items.ts:73-101, :364-391), which draw Quick Claw at
 * the start of each turn and move the holder's action, are switched off.
 */
export const KAIZO_ITEMS: Record<string, unknown> = {
  custapberry: { onBeforeTurn: undefined, onCustap: undefined },
  quickclaw: { onBeforeTurn: undefined, onCustap: undefined },
};

