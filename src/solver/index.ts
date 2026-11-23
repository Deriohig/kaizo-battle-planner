// The solver's public entry (the server imports only this): createSolver over SolverDeps, and
// createSolverPool for a pool of worker threads that outlives solves.

export { createSolver } from './solve.js';
export { createSolverPool } from './parallel/solverPool.js';
export type * from './types.js';
export { DEFAULT_RANKING, DEFAULT_BUDGETS_MS, DEFAULT_HORIZON_TURNS } from './config.js';
