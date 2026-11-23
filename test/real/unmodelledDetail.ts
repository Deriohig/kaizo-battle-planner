// Checks an unproven verdict's `detail` on real data: it may name only what the engine itself reports as unmodelled
// (`unmodelledIn`, engine/index.ts): a note per move, and the engine's battle-level `engine:` notes, by the engine's own
// list (`isBattleNote`: a correct verdict that meets one, a resist berry's say, must not fail).
// Nothing the integration added (`integration:`), no trainer-AI error code, no trainer item's note and no `engine:` note
// the engine doesn't list may be in it. A unit test (test/unit/integration/unmodelledDetail.test.ts) shows it fails for
// each.

import { expect } from 'vitest';
import { isBattleNote } from '../../src/engine/index.js';

const NO_HACK_MOVE = /^engine: move ".*" is not a hack move$/;
/** A per-move note: the move's name, then why (`<name>: <reason>`); never one of the other kinds of entry. */
const MOVE_NOTE = /^(?!integration:|engine:|trainer item:)[^:;"]+: \S/;
const AI_ERROR = /undefined AI behaviour|\b(UNKNOWN_OPCODE|STACK|DIV_ZERO|ESCAPE|LIMIT|UNSUPPORTED|BAD_VIEW|UNDEFINED)\b/;

/** `unmodelled: a; b`'s entries. A move note quotes the docs text, which may hold "; ", so a piece with no entry shape continues the last. */
function entries(list: string): string[] {
  const out: string[] = [];
  for (const piece of list.split('; ')) {
    if (out.length > 0 && !/^[^:;"]+: /.test(piece)) out[out.length - 1] += `; ${piece}`;
    else out.push(piece);
  }
  return out;
}

/** Asserts `detail` is an unproven verdict's `unmodelled: ...` list holding only entries the engine reports (see the top of the file). */
export function expectEngineOnlyDetail(detail: string | undefined): void {
  expect(detail, 'the verdict has a detail').toBeDefined();
  expect(detail!).toMatch(/^unmodelled: \S/);
  expect(detail!).not.toContain('integration:');
  expect(detail!).not.toMatch(AI_ERROR);
  for (const entry of entries(detail!.slice('unmodelled: '.length))) {
    const engine = NO_HACK_MOVE.test(entry) || MOVE_NOTE.test(entry) || isBattleNote(entry);
    expect(engine, `"${entry}" is an entry the engine reports as unmodelled`).toBe(true);
  }
}
