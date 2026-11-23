// Finds the trainer AI script, gTrainerAITable (script.s:15), in ARM9 overlay 14 by the shape of its flag table. Works
// on any Platinum-based ROM: there is no game-code check, so the hack and vanilla both load.

import { RomError } from '../../errors.js';
import { readOverlay } from '../../nds/overlay.js';
import { scriptId } from '../script/disasm.js';

const AI_OVERLAY = 14;
/** One table entry per AI flag bit (script.s:18–50). */
const FLAG_COUNT = 32;
/** script.s points the unused bits 11–28 at one routine, Terminate. */
const UNUSED_BITS = { first: 11, last: 28 };
/** The words start at the table, so the table is at word 0. */
const TABLE_WORD = 0;

export interface AiScript {
  /** The overlay's words from gTrainerAITable to the overlay's end, as the cartridge reads them (`int`, trainer_ai.c:2728). */
  words: Int32Array;
  /** The word index of each flag bit's routine (32 of them). */
  flagEntries: number[];
  /** scriptId: the flag entries, then the words reachable from bits 0–10 and 29–31. */
  sha256: string;
}

/** The AI script in overlay 14. RomError('BAD_FORMAT') unless exactly one flag table matches there. */
export function extractAiScript(rom: Uint8Array): AiScript {
  const overlay = readOverlay(rom, AI_OVERLAY);
  const view = new DataView(overlay.buffer, overlay.byteOffset, overlay.byteLength);
  const hits: number[] = [];
  for (let offset = 0; offset + FLAG_COUNT * 4 <= overlay.length; offset += 4) {
    if (isFlagTable(view, offset)) hits.push(offset);
  }
  if (hits.length !== 1) {
    const where = hits.map((offset) => `0x${offset.toString(16)}`).join(', ');
    throw new RomError('BAD_FORMAT', `expected one trainer AI flag table in overlay ${AI_OVERLAY}, found ${hits.length}${where ? ` (at ${where})` : ''}`);
  }

  const start = hits[0]!;
  const words = new Int32Array((overlay.length - start) >> 2);
  for (let i = 0; i < words.length; i++) words[i] = view.getInt32(start + i * 4, true);
  // Each entry is a LabelDistance, in words from the table (aicmd.inc:638), and a flag's run starts at
  // aiScriptTemp[thinkingBitShift] (trainer_ai.c:488), with aiScriptTemp = gTrainerAITable (battle_controller_player.c:4816).
  const flagEntries = Array.from(words.subarray(TABLE_WORD, TABLE_WORD + FLAG_COUNT), (distance) => TABLE_WORD + distance);
  const script: AiScript = { words, flagEntries, sha256: '' };
  script.sha256 = scriptId(script);
  return script;
}

/**
 * Whether the 32 u32s at `offset` look like the flag table: entry 0 is 32 (Basic_Main follows the table), entries
 * 11–28 are equal (all Terminate), and every entry is in 1..0xFFFF.
 */
function isFlagTable(view: DataView, offset: number): boolean {
  const entry = (bit: number) => view.getUint32(offset + bit * 4, true);
  if (entry(0) !== FLAG_COUNT) return false;
  const unused = entry(UNUSED_BITS.first);
  for (let bit = 0; bit < FLAG_COUNT; bit++) {
    const value = entry(bit);
    if (value < 1 || value > 0xffff) return false;
    if (bit >= UNUSED_BITS.first && bit <= UNUSED_BITS.last && value !== unused) return false;
  }
  return true;
}
