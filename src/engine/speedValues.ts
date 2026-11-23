// The cartridge's effective Speed, and the values of it the cartridge keeps (`battleCtx->monSpeedValues`), which the
// trainer AI's Gyro Ball estimate reads (`TrainerAI_CalcDamage`, trainer_ai.c:2995-3000) and so every Gyro Ball user's
// decision. Citations are pokeplatinum at 62bdaacdc, src/battle/ unless another path is given (bl = battle_lib.c,
// bcp = battle_controller_player.c, bs = battle_script.c).
//
// The formula (`cartridgeSpeed`) is `BattleSystem_CompareBattlerSpeed`'s (bl:1188-1454), in its order and its integers:
// each step is floored, where Showdown chains 4096-based modifiers and rounds once (to nearest, half down). Every speed
// compare of the engine uses it (mod/speedOrder.ts), and it reads the battle only: no Showdown event runs.
//
// The stored values. The compare writes both battlers' values (bl:1372-1373), unless exactly one of them has fainted,
// when it returns first (bl:1204-1211). The values start at 0 (the zeroed context, `BattleContext_New`, bcp:178-182).
// In a single battle the cartridge compares, and so writes, at (engine equivalent in mod/speedOrder.ts):
// - the turn's start, twice: `TrainerMessage` and `ShowBattleMon` sort `monSpeedOrder` (bcp:241-251, :254-266), at the
//   battle's start and after every `TurnEnd` (bcp:1847-1858), the second after the switch-in effects. It is the last
//   write before the player and the AI choose a turn's commands. Engine: after Showdown's `endTurn`, which ends the
//   battle's start too.
// - `CalcTurnOrder`, when both battlers chose the same command (bcp:772-787). Engine: `sortQueue` at the turn's start,
//   when it compares two sides' moves or two switches.
// - `BranchActions`, before each battler's action and before the end of turn (bcp:888). Engine: `runAction` for a
//   move, a switch chosen for the turn, a trainer item (an `event` action) and `residual`.
// - after Trick Room (`SortMonActionOrder` and `SortMonSpeedOrder`, bcp:3990-3992). No engine write: the next
//   `BranchActions` follows with the same battlers in the same state, so it writes the same values.
// - the trainer AI's own speed commands while it chooses (trainer_ai.c:1109, :1121, :2081): the trainer AI.s.
// No other code calls the compare (`BattleSystem_SortMonActionOrder` bl:7276-7302 runs only after Trick Room). So at a
// turn choice the values are both actives' Speed now; at a decision inside a turn (a replacement, a U-turn or Baton
// Pass switch) they are the last compare's in which both battlers were alive.

import { type HeldEffect, type HoldEffect, itemEffect } from '../calc/battler.js';
import type { EngineState, Side } from '../contracts/engine.js';
import { itemId } from './ids.js';

/** Each side's stored Speed value: the cartridge's `monSpeedValues` of the side's battler. */
export type SpeedValues = Record<Side, number>;

/** `formatData` key: the stored values, once the battle has compared (in the state and its key, never in the observation). */
const SPEED_VALUES_KEY = 'kaizoSpeedValues';

/** Ditto, whose Quick Powder doubles its Speed. */
const DITTO = 132;

/** `MON_CONDITION_ANY` (include/constants/battle/condition.h:25): a major status, as Quick Feet counts one. */
const STATUSES: ReadonlySet<string> = new Set(['slp', 'psn', 'brn', 'frz', 'par', 'tox']);

/** Item IDs are u16 (`BattleMon.heldItem`). */
const ITEM_IDS = 1 << 16;

/**
 * The hack's hold effects and parameters (calc/battler.ts, read from the hack ROM's item data) by the Showdown ID the
 * engine gives each item (`itemId`, as the sets do), so the speed formula and the hit rate (mod/accuracy.ts) read the
 * ROM's effect and parameter, not Showdown's item.
 */
const HOLD_EFFECTS: ReadonlyMap<string, HeldEffect> = (() => {
  const effects = new Map<string, HeldEffect>();
  for (let item = 1; item < ITEM_IDS; item++) {
    const held = itemEffect(item);
    if (held !== null) effects.set(itemId(item), held);
  }
  return effects;
})();

/** The ROM's hold effect and parameter of the item with Showdown ID `item`, among calc/battler.ts's effects. */
export const romHeldEffect = (item: string): HeldEffect | undefined => (item === '' ? undefined : HOLD_EFFECTS.get(item));

const holdEffect = (item: string): HoldEffect | undefined => romHeldEffect(item)?.effect;

/** `sStatStageBoosts` (bl:6550-6564): the stat multiplier for stages −6 to +6, as numerator and denominator. */
function stageFraction(stage: number): [number, number] {
  return stage >= 0 ? [10 + 5 * stage, 10] : [10, 10 - 5 * stage];
}

/**
 * `NO_CLOUD_NINE` is false (include/battle/common.h:63-64): a living battler has Cloud Nine or Air Lock
 * (`COUNT_ALIVE_BATTLERS`, bl:2952-2959, through `Battler_Ability`).
 */
function weatherSuppressed(battle: Battle): boolean {
  return battle.getAllActive().some((pokemon) => pokemon.hp > 0 && (pokemon.hasAbility('cloudnine') || pokemon.hasAbility('airlock')));
}

/**
 * `pokemon`'s Speed as `BattleSystem_CompareBattlerSpeed` computes it (bl:1213-1276). Abilities are `Battler_Ability`'s
 * (bl:3088-3106: none under Gastro Acid), which Showdown's `hasAbility` matches. In order:
 * 1. the Speed stat (`battleMons[].speed`, Showdown's `storedStats.spe`) times `sStatStageBoosts` of its stage, Simple
 *    doubling the stage within −6..+6 (`CompareSpeed_ApplySimple`, bl:1171-1186, :1219-1226);
 * 2. ×2 for Swift Swim in rain or Chlorophyll in sun, unless Cloud Nine or Air Lock is out (bl:1228-1238);
 * 3. ÷2 for a speed-halving item (`sSpeedHalvingItemEffects`, bl:1160-1169: Macho Brace, Iron Ball, the Power items),
 *    read from the held item itself, so even under Klutz or Embargo (bl:1240-1246);
 * 4. ×15/10 for Choice Scarf (bl:1248-1250) and ×2 for Quick Powder on a Ditto (bl:1252-1255), both through
 *    `Battler_HeldItemEffect` (bl:5438-5442), so no item under Klutz or Embargo (`Battler_HeldItem`, bl:5352-5363);
 * 5. ×15/10 for Quick Feet with any major status, otherwise ÷4 when paralysed (bl:1257-1261);
 * 6. ÷2 for Slow Start while `totalTurns − slowStartTurnNumber < 5` (bl:1263-1266). A switch-in sets the number to
 *    `totalTurns + 1` (`BattleSystem_UpdateAfterSwitch` bl:2117-2118, from `BtlCmd_SwitchAndUpdateMon` bs:2522); a lead
 *    keeps the zeroed context's 0, as the battle's start sends it out without that command
 *    (res/battle/scripts/subscripts/subscript_start_encounter.s); `totalTurns` grows at each `TurnEnd` (bcp:1852).
 *    Showdown's `activeTurns` is 0 at a switch-in (sim/battle-actions.ts:137) and grows at each `endTurn`, the battle
 *    start's included (sim/battle.ts:1762), so the difference is `activeTurns − 1` for a lead and every later
 *    switch-in alike;
 * 7. ×2 for Unburden with no item once its flag is set (bl:1268-1272). The flag (`canUnburden`, bl:161-166, :4433-4436)
 *    is Showdown's Unburden volatile here: both mean the holder had an item while it had Unburden;
 * 8. ×2 under the battler's side's Tailwind (bl:1274-1276).
 * Each ÷ and ×15/10 is floored, as the cartridge's integer division does.
 */
export function cartridgeSpeed(pokemon: Pokemon): number {
  let stage = pokemon.boosts.spe;
  if (pokemon.hasAbility('simple')) stage = Math.max(-6, Math.min(6, stage * 2));
  const [num, den] = stageFraction(stage);
  let speed = Math.floor((pokemon.storedStats.spe * num) / den);
  const { weather } = pokemon.battle.field;
  if (((pokemon.hasAbility('swiftswim') && weather === 'raindance') || (pokemon.hasAbility('chlorophyll') && weather === 'sunnyday'))
    && !weatherSuppressed(pokemon.battle)) speed *= 2;
  if (holdEffect(pokemon.item) === 'SPEED_HALVING') speed = Math.floor(speed / 2);
  const held = holdEffect(pokemon.hasAbility('klutz') || pokemon.volatiles['embargo'] ? '' : pokemon.item);
  if (held === 'CHOICE_SPEED') speed = Math.floor((speed * 15) / 10);
  if (held === 'DITTO_SPEED_UP' && pokemon.species.num === DITTO) speed *= 2;
  if (pokemon.hasAbility('quickfeet') && STATUSES.has(pokemon.status)) speed = Math.floor((speed * 15) / 10);
  else if (pokemon.status === 'par') speed = Math.floor(speed / 4);
  if (pokemon.hasAbility('slowstart') && pokemon.activeTurns - 1 < 5) speed = Math.floor(speed / 2);
  if (pokemon.hasAbility('unburden') && pokemon.volatiles['unburden'] && pokemon.item === '') speed *= 2;
  if (pokemon.side.sideConditions['tailwind']) speed *= 2;
  return speed;
}

/**
 * `battle`'s stored `monSpeedValues` (`storeSpeedValues`), as the battle code reads them mid-turn: in-battle Gyro Ball's
 * power (`BtlCmd_CalcGyroBallPower`, battle_script.c:7123-7133, mod/moves.ts). 0 for both before the first compare.
 */
export function storedSpeedValues(battle: Battle): SpeedValues {
  const values = battle.formatData[SPEED_VALUES_KEY] as SpeedValues | undefined;
  return values === undefined ? { p1: 0, p2: 0 } : { p1: values.p1, p2: values.p2 };
}

/** Stores `values` as `battle`'s `monSpeedValues`: the compare's write (bl:1372-1373). */
export function storeSpeedValues(battle: Battle, values: SpeedValues): void {
  battle.formatData[SPEED_VALUES_KEY] = { p1: values.p1, p2: values.p2 } satisfies SpeedValues;
}

/**
 * The cartridge's `monSpeedValues` for each side's battler in `state`: the values of the battle's most recent speed
 * compare in which both battlers were alive (or both had fainted). At a turn choice that is the turn start's sort, so
 * both actives' Speed now; `createBattle`'s state already holds the battle start's. A state with none reads 0 for both,
 * the cartridge's value before its first compare.
 *
 * Approximations of `cartridgeSpeed`, each rare:
 * - Unburden's `canUnburden` flag is Showdown's `unburden` volatile (bl:161-166, :4433-4436 set the cartridge's).
 * - Transform resets the transformer's `slowStartTurnNumber` to `totalTurns + 1` (bs:5360); the engine doesn't, so a
 *   Pokémon that transforms into a Slow Start user keeps the timing of its own switch-in.
 * - In a compare where both battlers have fainted (which writes, bl:1204-1211), a fainted battler has no status here
 *   (Showdown's `'fnt'`), so no paralysis and no Quick Feet; the cartridge's status of a fainted battler is not traced.
 */
export function lastSpeedValues(state: EngineState): SpeedValues {
  const json = JSON.parse(state.json) as { formatData?: Record<string, unknown> };
  const values = json.formatData?.[SPEED_VALUES_KEY] as SpeedValues | undefined;
  return values === undefined ? { p1: 0, p2: 0 } : { p1: values.p1, p2: values.p2 };
}
