// The `platkaizo` mod's counters and durations: the conditions whose length or per-attempt outcome the
// cartridge draws, each with the cartridge's effective behaviour (the turns lost or gained, and their exact chances) and
// its draws as labelled picks (chance.ts). Citations are pokeplatinum: bcp = src/battle/battle_controller_player.c,
// bl = src/battle/battle_lib.c, bs = src/battle/battle_script.c, scripts under res/battle/scripts/.
//
// Hidden counters. The cartridge draws sleep's, confusion's, Disable's, Encore's, Taunt's, the
// Thrash-type lock's, Uproar's and binding's length once, at infliction, and the player never sees it. The engine draws
// nothing then: the state keeps what the player can see, the attempts or end-of-turn checks elapsed (`slept`, `elapsed`), and
// each attempt or check resolves "ends now" with the conditional chance given that count (`counterEnds`): the prior
// (the drawn value's u16 weights) restricted to the values the history allows, split into those that end here and the
// rest. The two forms have the same distribution over every history; this one keeps equal-looking states equal, so
// the transposition table shrinks. A counter that is actually known stays exact (`statusState.time`): the save's, a
// pre-sleep counter of 1, Rest's 3.
//
// | Condition          | Prior                    | Ends at                                  | Kind            |
// |--------------------|--------------------------|------------------------------------------|-----------------|
// | sleep              | r % 4 + 2                | the attempt the counter reaches 0 (−1, −2 with Early Bird) | `sleepWake` |
// | confusion          | r % 4 + 2                | the attempt its decrement reaches 0      | `confusionSnap` |
// | Disable, Encore    | r % 4 + 3, r % 5 + 3     | the end-of-turn check that finds 0       | `durationEnd`   |
// | Taunt, Uproar, lock, binding | r % 3 + 3, r % 4 + 3, r % 2 + 2, r % 4 + 3 | the check its decrement reaches 0 | `durationEnd` |
//
// Per attempt: freeze thaws iff r % 5 == 0 (`thaw`), full paralysis iff r % 4 == 0 (`fullPara`), infatuation
// immobilises iff r & 1 == 0 (`infatuation`), a confused attempt hits itself iff r & 1 == 0 (`selfHit`). The Protect
// chain (`protect`) is the stall counter's draw. The order of the before-move checks is the cartridge's
// (bcp:2417-2756): sleep and freeze before recharging, paralysis between confusion and attraction.
//
// The end of turn. The cartridge runs each battler's whole condition list in turn, in monSpeedOrder (bcp:1289-1734),
// after the field's conditions (bcp:932-1254) and before Future Sight, Perish Song and Trick Room (bcp:1746-1842).
// Showdown's Gen 4 handlers put every battler's list at residual order 10, its effects at sub-orders that follow the
// cartridge's list (data/mods/gen4), and its handler sort compares Speed before the sub-order; the mod's handler sort
// (mod/speedOrder.ts, `handlerComparator`) orders two sides' handlers of one order by monSpeedOrder. So each battler's
// order-10 list runs whole, the first battler in monSpeedOrder first. The conditions here take sub-orders in the
// cartridge's list: Uproar 11, the lock 12, Disable 13, Encore 14, Taunt 15. Showdown faints after each handler and
// checks the battle's end (sim/battle.ts `fieldEvent`), as the cartridge does after each condition (bcp:1295-1299).

import PS from 'pokemon-showdown';
import type { ChanceKind, Side } from '../../contracts/engine.js';
import { type ChanceOption, pickLabelled } from '../chance.js';
import { installedMoves } from '../dex.js';
import { heldParam } from './itemData.js';
import { residueWeights, U16 } from '../odds.js';
import { addUnmodelledNote } from '../unmodelled.js';

const { Dex } = PS;

const GEN4 = Dex.mod('gen4');

type Handler = (this: Battle, ...args: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
type ConditionData = Record<string, unknown>;

/** The side `pokemon` is on. */
const sideOf = (pokemon: Pokemon): Side => pokemon.side.id as Side;

/** A move's own condition in Showdown's Gen 4 data (Disable's, Encore's...), copied. */
function gen4MoveCondition(id: string): ConditionData {
  const condition = (GEN4.data.Moves[id] as { condition?: ConditionData } | undefined)?.condition;
  if (condition === undefined) throw new Error(`Showdown's Gen 4 ${id} has no condition`);
  return { ...condition };
}

/** A Gen 4 condition's own handler, to call from an override. */
function gen4Handler(condition: ConditionData, name: string): Handler {
  const handler = condition[name];
  if (typeof handler !== 'function') throw new Error(`No Gen 4 ${name} handler`);
  return handler as Handler;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hidden counters

/** One value the cartridge can draw for a counter, with its share of the 65,536 draws. */
export interface CounterValue { readonly value: number; readonly weight: bigint }

/** The counter `r % n + offset`: residue i weighs `residueWeights(n)[i]` (`BtlCmd_Random`, bs:3200-3211). */
export function residuePrior(n: number, offset: number): readonly CounterValue[] {
  return residueWeights(n).map((weight, i) => ({ value: i + offset, weight }));
}

/** Sleep: `Random 3, 2` (subscript_fall_asleep.s:59), 2..5. */
export const SLEEP_PRIOR = residuePrior(4, 2);
/** Confusion: `Random 3, 2` (subscript_confuse.s:34), 2..5. */
export const CONFUSION_PRIOR = residuePrior(4, 2);
/** Disable: `r % 4 + 3` (bs:4594), 3..6. */
export const DISABLE_PRIOR = residuePrior(4, 3);
/** Encore: `r % 5 + 3` (bs:4742), 3..7: 13108 of the draws for 3, 13107 for each other. */
export const ENCORE_PRIOR = residuePrior(5, 3);
/** Taunt: `Random 2, 3` (subscript_taunt_start.s:8), 3..5: 21846, 21845, 21845. */
export const TAUNT_PRIOR = residuePrior(3, 3);
/** Thrash, Outrage, Petal Dance: `Random 1, 2` (subscript_thrash.s:5), 2..3. */
export const LOCK_PRIOR = residuePrior(2, 2);
/** Uproar: `Random 3, 3` (subscript_uproar.s:6), 3..6. */
export const UPROAR_PRIOR = residuePrior(4, 3);
/** Binding: `Random 3, 3` (subscript_bind_start.s:10), 3..6. */
export const BIND_PRIOR = residuePrior(4, 3);
/** Binding with the trapping-extension item (Grip Claw): set to 6 (subscript_bind_start.s:11-12), a known counter. */
const GRIP_CLAW_BIND: readonly CounterValue[] = [{ value: 6, weight: U16 }];

/**
 * Whether a hidden counter ends at this attempt or check: a labelled point whose first option (`names[0]`) weighs the
 * prior's values that `end` here among those still `possible` (the history so far rules the others out), and the
 * second the rest. With one possible outcome it draws nothing. Throws if no value fits the history.
 */
export function counterEnds(
  battle: Battle, kind: ChanceKind, side: Side, source: string, prior: readonly CounterValue[],
  possible: (value: number) => boolean, ends: (value: number) => boolean, names: readonly [string, string] = ['end', 'continue'],
): boolean {
  let [stop, go] = [0n, 0n];
  for (const { value, weight } of prior) {
    if (!possible(value)) continue;
    if (ends(value)) stop += weight;
    else go += weight;
  }
  if (stop + go === 0n) throw new Error(`${source}: no counter value fits the history`);
  return pickLabelled(battle, kind, side, source, [{ weight: stop, outcome: names[0] }, { weight: go, outcome: names[1] }]) === 0;
}

/** A state's elapsed count (`slept`, `elapsed`): 0 before the first attempt or check. */
const count = (state: Pokemon['statusState'], key: string): number => (state[key] as number | undefined) ?? 0;

// ---------------------------------------------------------------------------------------------------------------------
// Per-attempt draws

/** Freeze thaws iff `RandNext() % 5 == 0` (bcp:2480): 13108 of the draws. */
const THAW: readonly ChanceOption[] = [{ weight: residueWeights(5)[0]!, outcome: 'thaw' }, { weight: U16 - residueWeights(5)[0]!, outcome: 'frozen' }];
/** Full paralysis iff `RandNext() % 4 == 0` (bcp:2655): 16384 of the draws. */
const FULL_PARA: readonly ChanceOption[] = [{ weight: residueWeights(4)[0]!, outcome: 'fullPara' }, { weight: U16 - residueWeights(4)[0]!, outcome: 'none' }];
/** `RandNext() & 1`: 0 for half of the draws, 1 for the other half. */
const HALF = U16 / 2n;
/** Infatuation: `r & 1` acts for 1, is immobilised for 0 (bcp:2674-2687). */
const INFATUATION: readonly ChanceOption[] = [{ weight: HALF, outcome: 'immobilised' }, { weight: HALF, outcome: 'none' }];
/** A confused attempt: `r & 1` acts for 1, hits itself for 0 (bcp:2621-2640). */
const SELF_HIT: readonly ChanceOption[] = [{ weight: HALF, outcome: 'selfHit' }, { weight: HALF, outcome: 'none' }];

/** The note for a sleeping or frozen Pokémon that still has to recharge. */
export const RECHARGE_NOTE = 'engine: a sleeping or frozen Pokémon had to recharge (the cartridge keeps the recharge for its first attempt awake)';

/**
 * The cartridge keeps the recharge flag of a battler that is asleep or frozen, and spends it on the first attempt that
 * passes those checks (bcp:2514-2526); Showdown's `mustrecharge` lapses at the end of the turn. Noted, so a line
 * through it is unproven.
 */
function noteRecharge(battle: Battle, pokemon: Pokemon): void {
  if (pokemon.volatiles['mustrecharge']) addUnmodelledNote(battle, RECHARGE_NOTE);
}

/** Whether an uproar is on the field that `pokemon` hears (bcp:2432-2433: anyone's uproar, unless Soundproof). */
const hearsUproar = (battle: Battle, pokemon: Pokemon): boolean =>
  !pokemon.hasAbility('soundproof') && battle.getAllActive().some((active) => !!active.volatiles['uproar']);

/** Silk Scarf's and Muscle Band's `effectParam` in vanilla (res/items/data/silk_scarf.json, muscle_band.json): 20 and 10; the engine reads the ROM's (mod/itemData.ts). */
const VANILLA_SILK_SCARF_POWER = 20;
const VANILLA_MUSCLE_BAND_POWER = 10;
/** `SPECIES_PIKACHU`, the one species Light Ball works for (bl:6748-6749). */
const PIKACHU = 25;

/**
 * The self-hit of a confused attempt, `CALC_SELF_HIT(MOVE_STRUGGLE, 40)` (bcp:2632; include/battle/common.h:35-45):
 * `BattleSystem_CalcMoveDamage` for Struggle with power 40, `inType` 0, on itself, no crit, then its own damage roll
 * (bcp:2633), with no STAB and no type chart. Its power takes `CalcMoveDamage`'s power terms in their order, each
 * rounded down:
 * - `inType` 0 is `TYPE_NORMAL`, so the move's type is Struggle's, Normal (bl:6679-6684), and a Normal type-boosting
 *   item, Silk Scarf, raises it (`sTypeBoostingItems`, bl:6516-6531, :6716-6722);
 * - Light Ball doubles it for a Pikachu (`HOLD_EFFECT_PIKA_SPATK_UP`, bl:6748-6751), whatever the move's class;
 * - Struggle is physical, so Muscle Band raises it (bl:6776-6779);
 * - Rivalry raises it, the target being itself, of the same gender unless it has none (bl:6901-6906);
 * - Technician never does: it skips Struggle (bl:6698-6702).
 * The move's type stays Showdown's `???` (no STAB, no type chart), and getDamage skips Showdown's `BasePower` handlers
 * for it (`kaizoFixedPower`), so every power term the cartridge has is here. Its ID labels its roll `confusion`.
 */
function confusionHit(battle: Battle, pokemon: Pokemon): ActiveMove {
  const item = pokemon.ignoringItem() ? '' : pokemon.item; // Battler_HeldItem: none under Klutz or Embargo
  let power = 40;
  if (item === 'silkscarf') power = Math.floor((power * (100 + heldParam('silkscarf', VANILLA_SILK_SCARF_POWER))) / 100);
  if (item === 'lightball' && pokemon.species.num === PIKACHU) power *= 2;
  if (item === 'muscleband') power = Math.floor((power * (100 + heldParam('muscleband', VANILLA_MUSCLE_BAND_POWER))) / 100);
  // bl:6901-6906 needs the two genders equal and neither GENDER_NONE; Showdown's genderless is '' (sim/pokemon.ts:341).
  if (pokemon.hasAbility('rivalry') && (pokemon.gender === 'M' || pokemon.gender === 'F')) power = Math.floor((power * 125) / 100);
  const move = new Dex.Move({ name: 'confusion', basePower: power, type: '???', category: 'Physical', willCrit: false }) as ActiveMove;
  move.hit = 0;
  (move as { kaizoFixedPower?: boolean }).kaizoFixedPower = true;
  return battle.dex.getActiveMove(move);
}

/**
 * Whether `target`'s immunity to `source`'s `move`, which Showdown's type-immunity step just found (`runImmunity` false),
 * is the type chart's: the only kind that sets the cartridge's `moveFailFlags.noEffect` (`MOVE_STATUS_INEFFECTIVE`,
 * bcp:2366-2369). A blocking ability such as Soundproof is `TriggerImmunityAbilities`', not this step. Every type's
 * immunity but a Ground move's is the chart (`dex.getImmunity`). Showdown finds a Ground move's through `isGrounded`,
 * and `BattleSystem_ApplyTypeChart` checks Levitate first (`Battler_IgnorableAbility`, so not against Mold Breaker) and
 * Magnet Rise second, each setting its own flag (`MOVE_STATUS_LEVITATED`, `_MAGNET_RISE`, bl:2600-2608) instead of
 * running the chart: so the chart's is a Flying-type target's with neither. Gravity, Ingrain
 * and an Iron Ball ground the target in both, so it reaches no immunity here.
 */
export function typeChartImmune(target: Pokemon, move: ActiveMove, source: Pokemon): boolean {
  if (move.type !== 'Ground') return true;
  const levitates = target.hasAbility('levitate') && !source.hasAbility('moldbreaker');
  return target.hasType('Flying') && !levitates && !target.volatiles['magnetrise'];
}

/**
 * Records that `pokemon`'s move this turn had no effect on its target (`moveFailFlags.noEffect`, read by
 * `BattleContext_MoveFailed`, bl:2808-2820). The cartridge's flag lives in the battle context for the whole turn
 * (cleared for the next one, `BattleSystem_SetupNextTurn`), and only the uproar's and the lock's end-of-turn checks read
 * it (bcp:1523-1535, :1547-1563), so it is kept as their `failed` field, which `onMoveAborted` sets for the attempt's
 * other failures and their residual clears: in the battle's state and its key, so a mid-turn snapshot keeps it. A Pokémon with neither volatile has nothing that reads the flag.
 */
export function markNoEffect(pokemon: Pokemon): void {
  for (const id of ['uproar', 'lockedmove']) {
    const state = pokemon.volatiles[id];
    if (state) state['failed'] = true;
  }
}

/**
 * The `|cant|` reasons that `BattleContext_MoveFailed` doesn't count (bl:2808-2820 counts paralysis, no effect,
 * Imprison, infatuation, Disable, Taunt, flinching, Gravity and a confusion self-hit): sleep, freeze, recharging,
 * Truant's loafing and Heal Block.
 */
const NOT_FAILED: ReadonlySet<string> = new Set(['slp', 'frz', 'recharge', 'ability: Truant', 'move: Heal Block']);

/**
 * Whether the attempt `pokemon` just aborted (Showdown's `MoveAborted`) failed as `BattleContext_MoveFailed` sees it:
 * by the reason on its `|cant|` line this turn. An abort with no such line is a confusion self-hit, which fails
 * (`moveFailFlags.confused`, bcp:2628).
 */
function abortFailed(battle: Battle, pokemon: Pokemon): boolean {
  const prefix = `|cant|${pokemon}|`;
  for (let i = battle.log.length - 1; i >= 0; i--) {
    const line = battle.log[i]!;
    if (line.startsWith('|turn|')) break;
    if (line.startsWith(prefix)) return !NOT_FAILED.has(line.slice(prefix.length).split('|')[0]!);
  }
  return true;
}

/** `BATTLE_EFFECT_THAW_AND_BURN_HIT` and `BATTLE_EFFECT_RECOIL_BURN_HIT` (generated/move_battle_effects.txt: 125, 253). */
const THAWING_EFFECTS: ReadonlySet<number> = new Set([125, 253]);

/**
 * Whether `move` thaws its frozen user, as the cartridge decides it: by the ROM's move effect (bcp:2481-2482,
 * :2728-2730). A move the hack doesn't define falls back to Showdown's `defrost` flag.
 */
function thawsUser(move: ActiveMove): boolean {
  const kaizo = installedMoves().get(move.num);
  return kaizo === undefined ? !!move.flags['defrost'] : THAWING_EFFECTS.has(kaizo.romEffect);
}

// ---------------------------------------------------------------------------------------------------------------------
// The conditions

const gen4Encore = gen4MoveCondition('encore');
const gen4Taunt = gen4MoveCondition('taunt');
const gen4Uproar = gen4MoveCondition('uproar');
const gen4Attract = gen4MoveCondition('attract');
const gen4Disable = gen4MoveCondition('disable');
const gen4Trapped = { ...(GEN4.data.Conditions['partiallytrapped'] as ConditionData) };

/** Sleep (Showdown's Gen 4 `slp`, data/mods/gen4/conditions.ts, with the hazard form and the cartridge's order). */
const slp: ConditionData = {
  onStart(this: Battle, target: Pokemon, _source: Pokemon, sourceEffect: Effect | null) {
    if (sourceEffect && sourceEffect.effectType === 'Move') {
      this.add('-status', target, 'slp', `[from] move: ${sourceEffect.name}`);
    } else {
      this.add('-status', target, 'slp');
    }
    // No counter is drawn: the attempts slept so far are the state, from 0.
    this.effectState['slept'] = 0;
    if (target.removeVolatile('nightmare')) this.add('-end', target, 'Nightmare', '[silent]');
  },
  // Before recharging (11): the cartridge checks sleep first (bcp:2430 before :2514).
  onBeforeMovePriority: 12,
  onBeforeMove(this: Battle, pokemon: Pokemon, _target: Pokemon, move: ActiveMove) {
    const state = pokemon.statusState;
    let woke: boolean;
    if (hearsUproar(this, pokemon)) {
      woke = true; // an uproar wakes it before the counter moves (bcp:2432-2439)
    } else {
      const step = pokemon.hasAbility('earlybird') ? 2 : 1; // bcp:2442-2447
      if (typeof state['time'] === 'number') { // a known counter: the save's, pre-sleep's 1, Rest's 3
        state['time'] -= step;
        woke = state['time'] <= 0;
      } else {
        // Asleep after `slept` of the counter: it wakes iff the counter is at most `slept` + step (bcp:2448-2454).
        const slept = count(state, 'slept');
        woke = counterEnds(this, 'sleepWake', sideOf(pokemon), 'slp', SLEEP_PRIOR, (c) => c > slept, (c) => c <= slept + step, ['wake', 'sleep']);
        if (!woke) state['slept'] = slept + step;
      }
    }
    if (woke) {
      pokemon.cureStatus(); // wakes and acts (bcp:2463-2471)
      return;
    }
    noteRecharge(this, pokemon);
    if (move.sleepUsable) return; // Snore and Sleep Talk go ahead, with no "fast asleep" message (bcp:2455)
    this.add('cant', pokemon, 'slp');
    return false;
  },
};

/** Freeze (Showdown's Gen 4 `frz` with the labelled thaw and the cartridge's order). */
const frz: ConditionData = {
  onBeforeMovePriority: 12,
  onBeforeMove(this: Battle, pokemon: Pokemon, _target: Pokemon, move: ActiveMove) {
    // The thaw is drawn at every attempt, a thawing move's too (bcp:2480).
    if (pickLabelled(this, 'thaw', sideOf(pokemon), 'frz', THAW) === 0) {
      pokemon.cureStatus();
      return;
    }
    // A thawing move (the ROM's THAW_AND_BURN_HIT or RECOIL_BURN_HIT) only gets past the freeze check, still frozen
    // (bcp:2481-2482): the later checks (Truant, recharging, flinching, Disable, Taunt, Imprison, Gravity, Heal Block,
    // confusion, paralysis, attraction, Bide, bcp:2502-2726) can stop it there.
    if (thawsUser(move)) return;
    noteRecharge(this, pokemon);
    this.add('cant', pokemon, 'frz');
    return false;
  },
  // CHECK_STATUS_STATE_SELF_THAW (bcp:2728-2736), the last before-move check, thaws the user of a thawing move once
  // every other check has let it through: here, as the move starts, with Showdown's line. The ROM's effect decides
  // (`thawsUser`), not Showdown's `defrost` flag.
  onModifyMove(this: Battle, move: ActiveMove, pokemon: Pokemon) {
    if (!thawsUser(move)) return;
    this.add('-curestatus', pokemon, 'frz', `[from] move: ${move.name}`);
    pokemon.clearStatus();
  },
};

/** Paralysis (Showdown's Gen 4 `par`, labelled, between confusion and attraction as bcp:2614-2692 has it). */
const par: ConditionData = {
  onBeforeMovePriority: 2.5,
  onBeforeMove(this: Battle, pokemon: Pokemon) {
    if (pokemon.hasAbility('magicguard')) return; // bcp:2654
    if (pickLabelled(this, 'fullPara', sideOf(pokemon), 'par', FULL_PARA) === 0) {
      this.add('cant', pokemon, 'par');
      return false;
    }
  },
};

/** Confusion (Showdown's Gen 4 `confusion` with the hazard form and the labelled self-hit). */
const confusion: ConditionData = {
  onStart(this: Battle, target: Pokemon, source: Pokemon, sourceEffect: Effect | null) {
    if (sourceEffect?.id === 'lockedmove') {
      this.add('-start', target, 'confusion', '[fatigue]');
    } else if (sourceEffect?.effectType === 'Ability') {
      this.add('-start', target, 'confusion', `[from] ability: ${sourceEffect.name}`, `[of] ${source}`);
    } else {
      this.add('-start', target, 'confusion');
    }
    this.effectState['elapsed'] = 0; // no counter drawn: the confused attempts so far are the state
  },
  onBeforeMove(this: Battle, pokemon: Pokemon, _target: Pokemon, move: ActiveMove) {
    const state = pokemon.volatiles['confusion']!;
    let snaps: boolean;
    if (typeof state['time'] === 'number') {
      state['time']--;
      snaps = !state['time'];
    } else {
      // The counter is lowered first; it snaps out at 0 (bcp:2618-2620, :2642-2648).
      const done = count(state, 'elapsed');
      snaps = counterEnds(this, 'confusionSnap', sideOf(pokemon), 'confusion', CONFUSION_PRIOR, (c) => c > done, (c) => c === done + 1, ['snap', 'confused']);
      if (!snaps) state['elapsed'] = done + 1;
    }
    if (snaps) {
      pokemon.removeVolatile('confusion');
      return;
    }
    this.add('-activate', pokemon, 'confusion');
    if (pickLabelled(this, 'selfHit', sideOf(pokemon), 'confusion', SELF_HIT) !== 0) return;
    this.activeTarget = pokemon;
    const damage = this.actions.getDamage(pokemon, pokemon, confusionHit(this, pokemon));
    if (typeof damage !== 'number') throw new Error('Confusion damage not dealt');
    this.damage(chilanOnSelfHit(this, pokemon, move, damage), pokemon, pokemon, { id: 'confused', effectType: 'Move', type: '???' } as unknown as ActiveMove);
    return false;
  },
};

/**
 * The resist berries' script on a confusion self-hit. subscript_hurt_self_in_confusion.s:17
 * calls `BATTLE_SUBSCRIPT_UPDATE_HP` without `SYSCTL_SKIP_SPRITE_BLINK`, the only HP loss in a move but the hit itself to
 * do so, so subscript_update_hp.s:5-10 runs subscript_type_resist_berry.s, with the confused battler as the holder
 * (`msgBattlerTemp`, bcp:2629-2630). Its one other gate, `BTLVAR_WAITING_BATTLERS` at 0 (:9), never stops it here: the
 * count is of every battler whose action isn't finished, the one acting included (bcp:881-885), and an action is marked
 * finished only at its end (bcp:3989), so it is 1 for the last mover and 0 only at the end of the turn; the self-hit
 * comes in its holder's own action, first or last. The move status was zeroed for the action
 * (`BattleContext_Init`, bl:1983), so no berry that needs a super-effective hit works (:22); the Chilan Berry (hold effect
 * 35) is tested first and needs only a Normal type (:21, :41-42): the move type, `TYPE_NORMAL` from `BattleContext_Init`
 * (bl:1981), sends the script to the chosen move's ROM type (:12, :17), or Normalize makes it Normal (:7-9). Then it halves
 * the self-hit (`BattleSystem_Divide`, :111; bs:4413) and is used up (:116). Showdown's self-hit is typeless, so its
 * Chilan Berry never works on it. Logged as Showdown's Chilan Berry logs a halving.
 */
function chilanOnSelfHit(battle: Battle, pokemon: Pokemon, move: ActiveMove, damage: number): number {
  if (pokemon.ignoringItem() || pokemon.item !== 'chilanberry') return damage; // `GetItemHoldEffect`: none under Klutz or Embargo
  const normal = pokemon.hasAbility('normalize') || installedMoves().get(move.num)?.type === 0;
  if (!normal || !pokemon.eatItem()) return damage;
  battle.add('-enditem', pokemon, 'Chilan Berry', '[weaken]');
  return Math.max(1, Math.trunc(damage / 2));
}

/** Infatuation (Showdown's Gen 4 Attract condition with the labelled draw). */
const attract: ConditionData = {
  ...gen4Attract,
  name: 'Attract',
  onBeforeMovePriority: 2,
  onBeforeMove(this: Battle, pokemon: Pokemon) {
    this.add('-activate', pokemon, 'move: Attract', `[of] ${this.effectState['source']}`);
    if (pickLabelled(this, 'infatuation', sideOf(pokemon), 'attract', INFATUATION) === 0) {
      this.add('cant', pokemon, 'Attract');
      return false;
    }
  },
};

/**
 * Disable (Showdown's Gen 4 Disable condition, data/mods/gen4/moves.ts): drawn r % 4 + 3 (bs:4594) and checked at each
 * end of turn, which ends it on finding 0 and lowers it otherwise (bcp:1565-1589), and ends it at once when the move is
 * no longer known (bcp:1567-1575). So it lasts T full turns after the turn it lands, whoever moved first (Showdown's
 * extra turn for a target that had moved is gone).
 */
const disable: ConditionData = {
  ...gen4Disable,
  name: 'Disable',
  duration: undefined,
  durationCallback: undefined,
  onStart(this: Battle, pokemon: Pokemon) {
    if (!pokemon.lastMove) return false;
    for (const moveSlot of pokemon.moveSlots) {
      if (moveSlot.id !== pokemon.lastMove.id) continue;
      if (!moveSlot.pp) return false;
      this.add('-start', pokemon, 'Disable', moveSlot.move);
      this.effectState['move'] = pokemon.lastMove.id;
      this.effectState['elapsed'] = 0;
      return;
    }
    return false;
  },
  onResidualOrder: 10,
  onResidualSubOrder: 13,
  onResidual(this: Battle, pokemon: Pokemon) {
    const state = this.effectState;
    const done = count(state, 'elapsed');
    const ends = !pokemon.hasMove(state['move'] as string)
      || counterEnds(this, 'durationEnd', sideOf(pokemon), 'disable', DISABLE_PRIOR, (t) => t >= done, (t) => t === done);
    if (ends) pokemon.removeVolatile('disable');
    else state['elapsed'] = done + 1;
  },
};

/**
 * Encore (Showdown's Gen 4 Encore condition): drawn r % 5 + 3 (bs:4742), checked like Disable at each end of turn
 * (bcp:1591-1616), and ended at once when the move is gone or has no PP (bcp:1593-1602): T full turns after its turn.
 */
const encore: ConditionData = {
  ...gen4Encore,
  name: 'Encore',
  duration: undefined,
  durationCallback: undefined,
  onStart(this: Battle, target: Pokemon, source: Pokemon) {
    const result = gen4Handler(gen4Encore, 'onStart').call(this, target, source);
    if (result !== false) this.effectState['elapsed'] = 0;
    return result;
  },
  onResidualOrder: 10,
  onResidualSubOrder: 14,
  onResidual(this: Battle, target: Pokemon) {
    const state = this.effectState;
    const moveSlot = target.getMoveData(state['move'] as string);
    const done = count(state, 'elapsed');
    const ends = !moveSlot || moveSlot.pp <= 0
      || counterEnds(this, 'durationEnd', sideOf(target), 'encore', ENCORE_PRIOR, (t) => t >= done, (t) => t === done);
    if (ends) target.removeVolatile('encore');
    else state['elapsed'] = done + 1;
  },
};

/**
 * Taunt (Showdown's Gen 4 Taunt condition): drawn r % 3 + 3 (subscript_taunt_start.s:8) and lowered at each end of
 * turn, ending when it reaches 0 (bcp:1635-1645, `--tauntedTurns == 0`): T − 1 full turns after its turn.
 */
const taunt: ConditionData = {
  ...gen4Taunt,
  name: 'Taunt',
  duration: undefined,
  durationCallback: undefined,
  onStart(this: Battle, target: Pokemon) {
    gen4Handler(gen4Taunt, 'onStart').call(this, target);
    this.effectState['elapsed'] = 0;
  },
  onResidualOrder: 10,
  onResidualSubOrder: 15,
  onResidual(this: Battle, target: Pokemon) {
    const state = this.effectState;
    const done = count(state, 'elapsed');
    if (counterEnds(this, 'durationEnd', sideOf(target), 'taunt', TAUNT_PRIOR, (t) => t > done, (t) => t === done + 1)) target.removeVolatile('taunt');
    else state['elapsed'] = done + 1;
  },
};

/**
 * Uproar (Showdown's Gen 4 Uproar condition): drawn r % 4 + 3 (subscript_uproar.s:6) and lowered at each end of turn,
 * ending at 0 or when this turn's attempt failed (bcp:1523-1535, `BattleContext_MoveFailed`, bl:2808-2820: the
 * attempt's own failures, `abortFailed`, and a type-chart immunity, `markNoEffect`, kept in its state): T uses.
 * Before it moves, each end-of-turn check wakes every sleeper on the field that isn't Soundproof (bcp:1506-1521), one
 * after another in battler order; using Uproar wakes no one (the Gen 4 move's `onTryHit` wake is gone, mod/moves.ts),
 * and a sleeper hearing the uproar wakes at its own attempt (`slp`, bcp:2432-2439). It keeps any Pokémon from falling
 * asleep, Rest included, except a Soundproof one: the sleep subscript and Rest's both skip the uproar check for it
 * (subscript_fall_asleep.s:12-14, :44-46; subscript_rest.s:10-11). The uproarer stays locked into Uproar even asleep:
 * `Battler_CanPickCommand` refuses any battler with uproar turns left (bl:6223-6234), whatever
 * `Battler_UnlockMoveChoice` clears for a sleeper (bl:2240-2243, :1834-1841: `MOVE_LOCKED`, not the uproar), as
 * Showdown's `onLockMove` keeps it.
 */
const uproar: ConditionData = {
  ...gen4Uproar,
  name: 'Uproar',
  duration: undefined,
  durationCallback: undefined,
  onStart(this: Battle, target: Pokemon) {
    gen4Handler(gen4Uproar, 'onStart').call(this, target);
    this.effectState['elapsed'] = 0;
  },
  onAnySetStatus(this: Battle, status: Condition, pokemon: Pokemon, source: Pokemon, effect: Effect) {
    if (status.id === 'slp' && pokemon.hasAbility('soundproof')) return;
    return gen4Handler(gen4Uproar, 'onAnySetStatus').call(this, status, pokemon, source, effect);
  },
  onMoveAborted(this: Battle, pokemon: Pokemon) {
    if (abortFailed(this, pokemon)) this.effectState['failed'] = true;
  },
  onResidualOrder: 10,
  onResidualSubOrder: 11,
  onResidual(this: Battle, target: Pokemon) {
    for (const sleeper of this.getAllActive()) {
      if (sleeper.status === 'slp' && sleeper.hp > 0 && !sleeper.hasAbility('soundproof')) sleeper.cureStatus();
    }
    const state = this.effectState;
    const failed = !!state['failed']; // `onMoveAborted`, or no effect (`markNoEffect`)
    delete state['failed'];
    const done = count(state, 'elapsed');
    if (failed || counterEnds(this, 'durationEnd', sideOf(target), 'uproar', UPROAR_PRIOR, (t) => t > done, (t) => t === done + 1)) {
      target.removeVolatile('uproar');
      return;
    }
    state['elapsed'] = done + 1;
    this.add('-start', target, 'Uproar', '[upkeep]');
  },
};

/**
 * The Thrash-type lock (Showdown's `lockedmove`, Gen 4): drawn r % 2 + 2 on the first hit (subscript_thrash.s:5,
 * effect_script_0027.s) and lowered at each end of turn (bcp:1547-1563): at 0 the user is confused from fatigue unless
 * already confused (subscript_thrash_end.s); a turn whose attempt failed (paralysis, flinch, a self-hit, no effect...:
 * `BattleContext_MoveFailed`, bl:2808-2820, `abortFailed`, `markNoEffect`) ends the lock with no confusion; falling
 * asleep ends it (bl:2244-2248). A miss, Truant's loafing or a freeze doesn't stop it. Showdown's `duration` and
 * `trueDuration` are gone, so nothing else ends it.
 */
const lockedmove: ConditionData = {
  duration: undefined,
  onStart(this: Battle, _target: Pokemon, _source: Pokemon, effect: Effect) {
    this.effectState['move'] = effect.id;
    this.effectState['elapsed'] = 0;
  },
  onRestart() {
    return undefined;
  },
  onMoveAborted(this: Battle, pokemon: Pokemon) {
    if (abortFailed(this, pokemon)) this.effectState['failed'] = true;
  },
  onAfterMove: undefined,
  onEnd: undefined,
  onResidualOrder: 10,
  onResidualSubOrder: 12,
  onResidual(this: Battle, target: Pokemon) {
    const state = this.effectState;
    if (target.status === 'slp') {
      delete target.volatiles['lockedmove'];
      return;
    }
    const failed = !!state['failed']; // `onMoveAborted`, or no effect (`markNoEffect`)
    delete state['failed'];
    if (failed) {
      target.removeVolatile('lockedmove');
      return;
    }
    const done = count(state, 'elapsed');
    if (counterEnds(this, 'durationEnd', sideOf(target), 'lockedmove', LOCK_PRIOR, (c) => c > done, (c) => c === done + 1)) {
      target.removeVolatile('lockedmove');
      target.addVolatile('confusion'); // from fatigue: this effect is the lock, so the line says so
      return;
    }
    state['elapsed'] = done + 1;
  },
};

/**
 * Binding (Showdown's Gen 4 `partiallytrapped`): drawn r % 4 + 3, 6 with Grip Claw (subscript_bind_start.s:10-12), and
 * lowered at each end of turn; while it stays nonzero the bound Pokémon loses max HP / 16 (bcp:1462-1482). So 2 to 5 hits,
 * 5 with Grip Claw. Showdown's trapper checks stay.
 */
const partiallytrapped: ConditionData = {
  duration: undefined,
  durationCallback: undefined,
  // Baton Pass keeps only `VOLATILE_CONDITION_BATON_PASSED` (Focus Energy, Mean Look, confusion, Curse, Substitute;
  // include/constants/battle/condition.h:72-76) of the volatile bits (bl:2075), so the bind stays behind; Showdown's
  // `copyVolatileFrom` copies every volatile that isn't `noCopy` (sim/pokemon.ts).
  noCopy: true,
  onStart(this: Battle, pokemon: Pokemon, source: Pokemon) {
    gen4Handler(gen4Trapped, 'onStart').call(this, pokemon, source);
    this.effectState['elapsed'] = 0;
    if (source.hasItem('gripclaw')) this.effectState['gripClaw'] = true;
  },
  onResidual(this: Battle, pokemon: Pokemon) {
    const state = this.effectState;
    const trapper = state['source'] as Pokemon | undefined;
    if (trapper && (!trapper.isActive || trapper.hp <= 0 || !trapper.activeTurns)) {
      delete pokemon.volatiles['partiallytrapped'];
      this.add('-end', pokemon, state['sourceEffect'] as Effect, '[partiallytrapped]', '[silent]');
      return;
    }
    const done = count(state, 'elapsed');
    const prior = state['gripClaw'] ? GRIP_CLAW_BIND : BIND_PRIOR;
    if (counterEnds(this, 'durationEnd', sideOf(pokemon), 'partiallytrapped', prior, (b) => b > done, (b) => b === done + 1)) {
      pokemon.removeVolatile('partiallytrapped');
      return;
    }
    state['elapsed'] = done + 1;
    this.damage(pokemon.baseMaxhp / (state['boundDivisor'] as number));
  },
};

/** `sProtectSuccessRate` (bs:5128-5133): Protect, Detect and Endure succeed iff the rate is at least `RandNext()`. */
const PROTECT_RATES = [0xffff, 0x7fff, 0x3fff, 0x1fff] as const;

/**
 * The Protect chain (Showdown's Gen 4 `stall`, whose counter doubles from 2 to 8): the n-th consecutive use succeeds
 * for `sProtectSuccessRate[n] + 1` of the draws, n capped at 3 (bs:5167, :5182-5184); a failure resets it (bs:5186).
 * The first use has no stall condition and draws nothing; a user moving last fails before any draw matters
 * (`queue.willAct`, bs:5160-5168).
 */
const stall: ConditionData = {
  onStallMove(this: Battle, pokemon: Pokemon) {
    const counter = (this.effectState['counter'] as number | undefined) || 1;
    const rate = PROTECT_RATES[Math.min(Math.round(Math.log2(counter)), PROTECT_RATES.length - 1)]!;
    const weight = BigInt(rate) + 1n;
    const source = this.activeMove?.id ?? 'protect';
    const success = pickLabelled(this, 'protect', sideOf(pokemon), source, [{ weight, outcome: 'success' }, { weight: U16 - weight, outcome: 'fail' }]) === 0;
    if (!success) delete pokemon.volatiles['stall'];
    return success;
  },
};

/**
 * Unburden's flag (Showdown's `unburden` volatile, which speedValues.ts reads as the cartridge's `canUnburden`) isn't
 * passed by Baton Pass: `canUnburden` is a `MoveEffectsData` field the switch clears and Baton Pass doesn't restore
 * (bl:2105-2114 restores only the substitute's HP, Lock-On, Perish Song, Mean Look, Magnet Rise, Embargo and Heal
 * Block). Showdown's condition isn't `noCopy`. Charge likewise: `MOVE_EFFECT_CHARGE` is not in `MOVE_EFFECT_BATON_PASSED`
 * (include/constants/battle/moves.h:46-48) and `chargedTurns` isn't restored, while Showdown's Gen 4 Charge lasts until
 * an Electric move. Of the other volatiles Showdown copies and the cartridge drops (Taunt, the Protect chain, Uproar,
 * the lock, Bide, recharging), none can be on a Pokémon as it uses Baton Pass and still matter: a taunted one can't use
 * it, the chain's `stall` lapses at that turn's end, the rest lock their user in.
 */
const unburden: ConditionData = { ...gen4Owned(GEN4.data.Abilities['unburden'], 'unburden'), name: 'Unburden', noCopy: true };
const charge: ConditionData = { ...gen4Owned(GEN4.data.Moves['charge'], 'charge'), name: 'Charge', noCopy: true };
/**
 * A pending Micle Berry boost (Showdown's `micleberry` volatile, which mod/accuracy.ts reads as the cartridge's
 * `moveEffectsData.micleBerry`) isn't passed either: the switch clears `MoveEffectsData` (bl:2101-2104) and Baton Pass
 * doesn't restore the flag (bl:2105-2114).
 *
 * Nor does it run out. The flag is a bit of `MoveEffectsData`
 * (include/battle/battle_mon.h:33): set when the berry is eaten (subscript_held_item_temp_acc_up.s:11), cleared only by
 * the hit-rate formula that uses it (bcp:2967-2970, mod/scripts.ts eats it there) and by the zeroing of `MoveEffectsData`
 * at a switch-in or a faint (bl:2101-2104, :2186). Nothing counts turns on it, so a holder that uses no move with an
 * accuracy for a while keeps it. Showdown's Gen 4 condition lasts 2 turns (`duration: 2`), which is dropped here. Its
 * `onSourceAccuracy` and `onSourceModifyAccuracy` never run in the mod: Showdown's accuracy step is replaced by the
 * cartridge's formula (mod/scripts.ts `hitStepAccuracy`).
 */
const micleberry: ConditionData = { ...gen4Owned(GEN4.data.Items['micleberry'], 'micleberry'), name: 'Micle Berry', noCopy: true, duration: undefined };

/** The condition an ability or move of Showdown's Gen 4 data owns, copied. */
function gen4Owned(owner: unknown, id: string): ConditionData {
  const condition = (owner as { condition?: ConditionData } | undefined)?.condition;
  if (condition === undefined) throw new Error(`Showdown's Gen 4 ${id} has no condition`);
  return { ...condition };
}

/**
 * The mod's `Conditions` entries. Each overrides Showdown's Gen 4 condition of its ID, which is also how a move's own
 * condition is found by ID (sim/dex-conditions.ts `getByID` reads the Conditions table first), so every hack move whose
 * behaviour source sets the volatile gets the override.
 */
export const KAIZO_CONDITIONS: Record<string, ConditionData> = {
  slp, frz, par, confusion, attract, disable, encore, taunt, uproar, lockedmove, partiallytrapped, stall, unburden, charge,
  micleberry,
};
