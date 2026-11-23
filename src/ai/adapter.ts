// viewFromState: the one translation from the engine's state into the trainer AI's view (view.ts AiView, the
// cartridge's BattleContext and BattleMon in their own encodings), for the Showdown engine (contracts/aiRead.ts).
// Two parts, each with the field-by-field account of its fields:
// - read/showdown.ts showdownAiSource: the engine's read of the state, every value that depends on the state alone,
//   from Showdown's Battle in the cartridge's encodings (AiBattleRead);
// - read/compose.ts viewFromRead: the view of a read, with what only the AI's memory and the ROM data give.
// The first fault on a state is the one-pass build's: see the two files.
//
// Also the AI's names for the Showdown source's helpers that model.ts and the tests import from here (peekBattle, the
// JSON accessors through one cut, protocolIds).

import type { LoadedData } from '../battle/types.js';
import type { EngineState } from '../contracts/engine.js';
import type { AiMemoryData } from './memory.js';
import { viewFromRead } from './read/compose.js';
import { showdownAiSource } from './read/showdown.js';
import type { AiRomData } from './rom/aiData.js';
import type { AiView } from './view.js';

export { accessorState, CUT_CAPACITY, fieldNoteOf, peekBattle, protocolIds, startLogOf, trainerOf } from './read/showdown.js';

/**
 * The engine state `state` as the trainer AI sees it at its decision: the Showdown source's read of it, composed. `data`
 * is the LoadedData the engine's mod was installed from, `ai` the AI's ROM data, and `memory` what the AI remembers
 * (rememberStep), which gives the fields Showdown doesn't keep. Throws AiError('BAD_VIEW') for a value it can't encode
 * (an unknown Showdown ID, a weather Gen 4 doesn't have, a ROM table without the battler's species).
 */
export function viewFromState(state: EngineState, data: LoadedData, ai: AiRomData, memory: AiMemoryData): AiView {
  return viewFromRead(showdownAiSource.read(state), state.phase.kind, data, ai, memory);
}
