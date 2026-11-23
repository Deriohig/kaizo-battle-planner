// Contract between the trainer AI (`src/ai`) and the solver (`src/solver`). Types only.

import type { Choice, EngineState, Outcome, Rational } from './engine.js';

/**
 * What the trainer AI has seen and remembers (the player's revealed moves, the last move that hit it, and so on).
 * `key` is canonical: equal keys mean the AI will behave identically. The solver joins it to the engine state key.
 */
export interface AiMemory { readonly key: string; readonly data: unknown }

/** One action the AI can take, with its exact probability. A support list has every probability > 0 and sums to exactly 1. */
export interface ActionSupport { choice: Choice; probability: Rational }

/**
 * Where the cartridge's behaviour is undefined, `support`/`replacementSupport` throw an `AiError` (`src/ai/errors.ts`):
 * code `'UNDEFINED'` (e.g. Weather Ball's type with no usable weather is an uninitialised register,
 * trainer_ai.c:3222-3240; an AI-read field the engine can't supply) or `'DIV_ZERO'` (e.g. the hack's
 * Ganlon/Petaya Berry have hold-effect parameter 0, so the pinch check divides by zero). The solver treats ANY `AiError`
 * as an unproven node (reason 'unmodelled', the error's code and message in the detail), never as a crash and never as
 * safe.
 */
export interface EnemyModel {
  readonly id: string;                                               // e.g. 'pokeplatinum-ai@<sha of the ROM's AI script>'
  initialMemory(state: EngineState): AiMemory;
  /**
   * At phase `turnChoice`: every action the AI can take (move, voluntary switch, bag item), enumerated exactly over its
   * per-slot damage rolls, IfRandom draws, tie-breaks and switch/item rolls. The AI never reads p1's current choice.
   */
  support(state: EngineState, memory: AiMemory): ActionSupport[];
  /** At phases `enemyReplacement` and `enemyMidTurnSwitch`. */
  replacementSupport(state: EngineState, memory: AiMemory): ActionSupport[];
  /** Fold one engine step (its reveals) into the memory. Pure. */
  remember(memory: AiMemory, outcome: Outcome): AiMemory;
}
