// Read-only accessors for the trainer-AI adapter: what the engine's state already holds
// about who the battle is against, how it started and the hidden Quick Claw rolls. They read the state's JSON
// (`formatData`), so no battle is restored.

import type { EngineState, FieldSpec, Side } from '../contracts/engine.js';
import { FIELD_KEY, START_LOG_KEY, TRAINER_KEY } from './battle.js';
import { SPEED_RAND_KEY } from './mod/speedOrder.js';

function formatData(state: EngineState): Record<string, unknown> {
  return ((JSON.parse(state.json) as { formatData?: Record<string, unknown> }).formatData ?? {});
}

/** The trainer this battle is against: its ROM index and its raw u32 AI flag mask (trdata), as `createBattle` stored them. */
export function battleTrainer(state: EngineState): { romIndex: number; aiMask: number } {
  const trainer = formatData(state)[TRAINER_KEY] as { romIndex: number; aiMask: number } | undefined;
  if (trainer === undefined) throw new Error('The state holds no trainer identity (not made by createBattle)');
  return { romIndex: trainer.romIndex, aiMask: trainer.aiMask };
}

/**
 * The battle-start protocol lines, omniscient and in Showdown's standard format: the leads' `|switch|` lines and the
 * start-of-battle `|-ability|` / `|-item|` lines (Intimidate, Frisk, weather abilities...). Kept in the state because a
 * restore trims the log. A state without them gives [].
 */
export function battleStartLog(state: EngineState): string[] {
  const log = formatData(state)[START_LOG_KEY] as string[] | undefined;
  return log === undefined ? [] : [...log];
}

/**
 * Each side's stored hidden Quick Claw roll (true = it activates): the value the cartridge's `speedRand` holds for the
 * side's slot, which the engine draws where the cartridge does, after each turn's order (mod/speedOrder.ts).
 *
 * A side is absent in one of two cases:
 * - no working Quick Claw holder is in its slot (none out, or fainted, or its Quick Claw ignored under Klutz or
 *   Embargo); or
 * - a working holder is in the slot, or about to come in, and its roll is not drawn yet. That happens only at the root
 *   state (`createBattle` returns one state, while the cartridge draws at the battle start, battle_lib.c:2024) and at mid-turn decision states (`playerMidTurnSwitch`, `enemyMidTurnSwitch`, `playerReplacement`,
 *   `enemyReplacement`), for a holder that arrived or arrives after the turn's redraw.
 *
 * At every `turnChoice` state an `expandTurn` step reaches (turn 2 on), each side with a working holder out has a
 * stored value and no other side has one. For each absent roll of a working holder, a consumer such as the trainer-AI
 * adapter must take the union of its behaviour over both values (activates or not): an AND over a superset of the true
 * joint support, which is sound for tier 1. A mid-turn state can also hold a roll for a side whose holder has left: the
 * slot's, which a holder coming in reads.
 */
export function quickClawRolls(state: EngineState): { p1?: boolean; p2?: boolean } {
  const stored = formatData(state)[SPEED_RAND_KEY] as Partial<Record<Side, boolean>> | undefined;
  const rolls: { p1?: boolean; p2?: boolean } = {};
  for (const side of ['p1', 'p2'] as const) if (stored?.[side] !== undefined) rolls[side] = stored[side];
  return rolls;
}

/**
 * The trainer's field note as `createBattle` stored it (`BattleInput.field`, an empty object for none): the weather, fog,
 * Trick Room and Gravity the cartridge started the battle with. The state's battle holds the conditions
 * themselves (they can end: the Trick Room move toggles it, Defog clears fog); this is the note, which never changes.
 */
export function battleField(state: EngineState): FieldSpec {
  const field = formatData(state)[FIELD_KEY] as FieldSpec | undefined;
  if (field === undefined) throw new Error('The state holds no field record (not made by createBattle)');
  return { ...field };
}
