export type RomErrorCode = 'WRONG_ROM' | 'MISSING_FILE' | 'BAD_FORMAT';

/** A ROM that is not the expected game, lacks a file we need, or holds data we cannot parse. */
export class RomError extends Error {
  readonly code: RomErrorCode;

  constructor(code: RomErrorCode, message: string) {
    super(message);
    this.name = 'RomError';
    this.code = code;
  }
}

export type SaveErrorCode = 'NO_VALID_SAVE' | 'BAD_SIZE' | 'EMPTY_SAVE';

/** A save file of the wrong size, or one where neither partition holds a valid save. */
export class SaveError extends Error {
  readonly code: SaveErrorCode;

  constructor(code: SaveErrorCode, message: string) {
    super(message);
    this.name = 'SaveError';
    this.code = code;
  }
}
