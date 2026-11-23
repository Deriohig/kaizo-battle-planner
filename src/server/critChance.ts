// The chance one hit of a move is a crit on a node's state (`LineMoveDamageJson.critChance`), as the engine
// draws it: `getDamage` sums Showdown's `ModifyCritRatio` on the move's `critRatio` and `critRoll` turns the stage into
// 1 in 16, 8, 4, 3 or 2 (src/engine/mod/scripts.ts, `sCriticalStageRates`, battle_lib.c:7097-7148). The stage is the sum
// of, capped at 4:
// - the move's own (`ownCrit`): the engine's move's `critRatio` less 1, read from the same installed dex move the engine
//   draws with. A table-built move takes it from `KaizoMove.calc.critStage` (src/engine/effects.ts `behaviourFields`), but
//   an inherited or unmodelled one keeps its Showdown source's `critRatio` and `willCrit` (src/engine/dex.ts
//   `showdownMoveData`), which the calc spec may not have. Only where there is no engine move is the calc spec read
//   (`critStage`, and `alwaysCrit`); test/real/critStage.test.ts lists the moves where the two differ;
// - +1 for Super Luck (Showdown's `superluck`);
// - +2 for Focus Energy, the `focusenergy` volatile on the attacker's battle Pokémon (Showdown's condition; the move,
//   Dire Hit and the Lansat Berry set it);
// - +1 for a held Scope Lens or Razor Claw, +2 for a Stick on Farfetch'd or a Lucky Punch on Chansey: matched by the hold
//   effect in the ROM's item data, none under Klutz or Embargo (Showdown's `ignoringItem`, as the engine's item handlers
//   run). `heldEffect` (src/calc/battler.ts) holds only accuracy and turn order's hold effects, so these are read here.
// Where no crit can land the caller says so (`lands`), and the chance is 0/1. A move that always crits, where one lands,
// is 1/1 (Showdown's `willCrit`, or the calc spec's `alwaysCrit` without an engine move).

import type { KaizoMove } from '../battle/moves.js';
import { abilityName } from '../calc/battler.js';
import type { CalcSide } from '../calc/calc.js';
import type { BattleContext } from '../integration/battleView.js';
import type { LineRationalJson } from '../contracts/api.js';

/** The ROM's item records, by item ID: their hold effects. */
type Items = BattleContext['data']['rom']['items'];

/** Farfetch'd's and Chansey's national dex numbers. */
const FARFETCHD = 83;
const CHANSEY = 113;

/**
 * The held items that raise the crit stage, by the hold effect in the ROM's item data (a line of pokeplatinum's
 * generated/item_hold_effects.txt less one): the stages they add and the species they need, if any. In the hack ROM's
 * item data (read 2026-11-21), 67 is the Scope Lens's (232) and Razor Claw's (326), 89 the Lucky Punch's (256) and 92 the
 * Stick's (259), and no other item has any of the three.
 */
const CRIT_ITEMS: Readonly<Record<number, { stages: number; species?: number }>> = {
  67: { stages: 1 }, // HOLD_EFFECT_CRITRATE_UP: Scope Lens, Razor Claw
  89: { stages: 2, species: CHANSEY }, // HOLD_EFFECT_CHANSEY_CRITRATE_UP: Lucky Punch
  92: { stages: 2, species: FARFETCHD }, // HOLD_EFFECT_FARFETCHD_CRITRATE_UP: Stick
};

/** A crit is 1 in N at stages 0 to 4: the engine's `CRIT_RATES`. */
const CRIT_RATES = [16, 8, 4, 3, 2] as const;

/** The crit fields of the engine's move (the installed dex's): Showdown's `critRatio`, stages counted from 1, and `willCrit`. */
export interface EngineCrit { critRatio?: number; willCrit?: boolean }

/**
 * The move's own crit stage and whether it always crits, as the engine draws them: from its engine move `sim` (`critRatio`
 * less 1, absent read as Showdown's default 1; `willCrit`), or from the calc spec (`critStage`, `alwaysCrit`) where there is
 * no engine move (null).
 */
export function ownCrit(move: KaizoMove, sim: EngineCrit | null): { stage: number; always: boolean } {
  if (sim === null) return { stage: move.calc.critStage ?? 0, always: move.calc.alwaysCrit === true };
  return { stage: (sim.critRatio ?? 1) - 1, always: sim.willCrit === true };
}

/** The gen 4 crit stage of `move` from `attacker` (its calc side and its battle Pokémon), capped at 4; `sim` its engine move or null. */
export function critStage(items: Items, attacker: CalcSide, pokemon: Pokemon, move: KaizoMove, sim: EngineCrit | null): number {
  const { mon } = attacker;
  let stage = ownCrit(move, sim).stage;
  if (abilityName(mon) === 'Super Luck') stage += 1;
  if (pokemon.volatiles['focusenergy'] !== undefined) stage += 2;
  if (abilityName(mon) !== 'Klutz' && pokemon.volatiles['embargo'] === undefined) {
    const held = CRIT_ITEMS[items[mon.item]?.holdEffect ?? -1];
    if (held !== undefined && (held.species === undefined || held.species === mon.species)) stage += held.stages;
  }
  return Math.min(stage, CRIT_RATES.length - 1);
}

/**
 * The chance one hit of `move` from `attacker` is a crit: 0/1 where none `lands`, 1/1 where it always crits, else 1 in the
 * stage's rate. `sim` is the move's engine move (the installed dex's), or null where there is none.
 */
export function critChanceOf(items: Items, attacker: CalcSide, pokemon: Pokemon, move: KaizoMove, lands: boolean, sim: EngineCrit | null): LineRationalJson {
  if (!lands) return { num: '0', den: '1' };
  if (ownCrit(move, sim).always) return { num: '1', den: '1' };
  const stage = critStage(items, attacker, pokemon, move, sim);
  // An engine critRatio of 0 with nothing raising it: `getDamage` draws no crit at all (`if (critRatio)`).
  if (stage < 0) return { num: '0', den: '1' };
  return { num: '1', den: String(CRIT_RATES[stage]) };
}
