// The engine's own types: its error, and the contract's types (src/contracts/engine.ts, which owns them) re-exported
// for the engine's modules.

import type { EngineErrorCode } from '../contracts/engine.js';

export type {
  BattleInput, CarryState, Choice, EngineErrorCode, EngineState, FieldSpec, Phase, Side, WorldAssignment,
} from '../contracts/engine.js';

/**
 * A failure the engine reports with one of the contract's codes: `UNSUPPORTED_DOUBLE` (a double battle),
 * `UNMODELLED_ITEM` (a trainer bag item whose effect the engine does not model), `BAD_CHOICE` (a choice the state does
 * not allow), `LIMIT` (a size limit), `STOPPED` (`expandTurn`'s `shouldStop` said stop; not deterministic,
 * unlike `LIMIT`).
 */
export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}
