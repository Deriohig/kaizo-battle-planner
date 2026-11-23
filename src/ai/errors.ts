/**
 * Why the AI cannot go on. `UNDEFINED`: the cartridge's behaviour is undefined here (an uninitialised value); the
 * result can't be modelled until measured.
 */
export type AiErrorCode = 'UNKNOWN_OPCODE' | 'STACK' | 'DIV_ZERO' | 'ESCAPE' | 'LIMIT' | 'UNSUPPORTED' | 'BAD_VIEW' | 'UNDEFINED';

/** The trainer AI script or its run cannot be decoded or ported faithfully: the code says why. */
export class AiError extends Error {
  readonly code: AiErrorCode;

  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.name = 'AiError';
    this.code = code;
  }
}
