// The trainer AI: `trainerAi`, the contract's EnemyModel (src/contracts/ai.ts) over the engine, and what its
// users need besides.

export { AiError, type AiErrorCode } from './errors.js';
export { itemChoice, type ItemChoice } from './itemChoice.js';
export { type AiMemoryData, type RecycleOverride } from './memory.js';
export { createTrainerAi, trainerAi } from './model.js';
