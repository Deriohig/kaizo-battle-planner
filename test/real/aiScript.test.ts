// Real-data check: the hack's trainer AI script, found in overlay 14 of the player's ROM, decodes from every flag it uses.

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AiScript, extractAiScript } from '../../src/ai/rom/script.js';
import { reachable } from '../../src/ai/script/disasm.js';
import { readOverlay } from '../../src/nds/overlay.js';
import { needFiles, PK_ROM } from './env.js';

/** Where the hack's gTrainerAITable sits in the decompressed overlay 14. */
const TABLE_OFFSET = 0x4c84;
/** The flags with routines; 11–28 are unused and point at one shared routine. */
const USED_BITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 29, 30, 31];

const suite = needFiles("the hack's AI script", { PK_ROM });

describe.skipIf(suite.skip)(suite.title, () => {
  let overlay: Uint8Array;
  let script: AiScript;

  beforeAll(() => {
    const rom = readFileSync(PK_ROM);
    overlay = readOverlay(rom, 14);
    script = extractAiScript(rom);
  });

  it('the flag table sits at overlay 14 file offset 0x4C84, and the words run to the overlay end', () => {
    const view = new DataView(overlay.buffer, overlay.byteOffset, overlay.byteLength);
    expect(script.words.length).toBe((overlay.length - TABLE_OFFSET) >> 2);
    expect([...script.words.subarray(0, 64)]).toEqual(Array.from({ length: 64 }, (_, i) => view.getInt32(TABLE_OFFSET + i * 4, true)));
  });

  it('table[0] is 32', () => {
    expect(script.words[0]).toBe(32);
    expect(script.flagEntries[0]).toBe(32);
  });

  it('table[11..28] are all 10606, and table[29] is 10567', () => {
    expect([...script.words.subarray(11, 29)]).toEqual(Array<number>(18).fill(10606));
    expect(script.flagEntries.slice(11, 29)).toEqual(Array<number>(18).fill(10606));
    // Bit 29 is AI_FLAG_ROAMING_POKEMON, whose own routine follows Terminate: it is not an unused bit.
    expect(script.words[29]).toBe(10567);
  });

  it("Basic's first eight words", () => {
    const basic = script.flagEntries[0]!;
    expect([...script.words.subarray(basic, basic + 8)]).toEqual([81, 10572, 23, 90, 8, 23, 32, 5]);
  });

  it('every instruction reachable from flags 0–10 and 29–31 decodes', () => {
    const instrs = reachable(script, USED_BITS);
    console.log(`The hack's AI script: ${instrs.size} instructions reachable from flags 0–10 and 29–31; scriptId ${script.sha256}`);
    expect(instrs.size).toBeGreaterThan(0);
  });
});
