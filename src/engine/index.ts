// The battle engine: `showdownEngine`, the contract's `Engine` that the trainer AI and the solver run against,
// and the engine's public functions.

import type { Engine } from '../contracts/engine.js';
import { createBattle } from './battle.js';
import { installedDataDigest, itemId } from './dex.js';
import { expandTurn } from './expand.js';
import { carryOut, hpOf, legalChoices, observeState, unmodelledIn } from './facts.js';
import { ENGINE_REVISION, SHOWDOWN_VERSION } from './version.js';

// Not `runFirstOutcome` (battle.ts): one path with every chance's first outcome is not a step anyone should prove with.
export { applyChoices, BATTLE_START_CHANCE_NOTE, createBattle, PICKUP_NOTE, restore, snapshot } from './battle.js';
// Battle-level notes: the new ones by name, and all of them by `isBattleNote`.
export { KNOCK_OFF_PLATE_NOTE, PURSUIT_FIELD_NOTE } from './mod/moves.js';
export { RESIST_BERRY_NOTE } from './mod/scripts.js';
export { BATTLE_NOTES, isBattleNote } from './notes.js';
// The readers of a state: answered from what the engine kept when it built the state, else from a restore.
export { carryOut, hpOf, legalChoices, peek, unmodelledIn } from './facts.js';
export { attachDriver, ChanceDriver, type ChanceOption, type ChancePoint } from './chance.js';
export { abilityId, installedData, installKaizoDex, itemId, KAIZO_FORMAT, moveId, speciesId } from './dex.js';
export { DEFAULT_MAX_LEAVES, expandTurn } from './expand.js';
export { ENGINE_EFFECTS, engineEffect, type EngineEffect } from './effects.js';
export { cartridgeHitRate } from './mod/accuracy.js';
export { stateKey } from './key.js';
export { battleField, battleStartLog, battleTrainer, quickClawRolls } from './accessors.js';
export { barPixels, observe, omniscientLog } from './observe.js';
export { belowWeight, residueWeights, U16 } from './odds.js';
export { add, cmp, eq, mul, ONE, rat, toNumber, ZERO } from './rational.js';
export { lastSpeedValues } from './speedValues.js';
export { type LearnedMove, levelUp } from './levelUp.js';
export { BAG_ITEM_NAMES, bagItemId, trainerBag, UNDEFINED_CATEGORY_NOTE } from './trainerItems.js';
export { EngineError } from './types.js';
export { isUnmodelled, unmodelledMoves } from './unmodelled.js';
export { ENGINE_REVISION, SHOWDOWN_VERSION } from './version.js';

/** `showdown@<Showdown version>+platkaizo@<ENGINE_REVISION>-<installedDataDigest()>`. Throws if no mod is installed. */
export function engineId(): string {
  return `showdown@${SHOWDOWN_VERSION}+platkaizo@${ENGINE_REVISION}-${installedDataDigest()}`;
}

/**
 * The engine over Showdown 0.11.11 and the installed `platkaizo` mod (`installKaizoDex` first). Its readers answer a state
 * it built without a restore (facts.ts); `hpOf` is the contract's optional HP reader, for search ordering only.
 */
export const showdownEngine: Engine & Required<Pick<Engine, 'hpOf'>> = {
  get id() {
    return engineId();
  },
  createBattle,
  legalChoices,
  expandTurn,
  observe: observeState,
  carryOut,
  unmodelledIn,
  hpOf,
};
