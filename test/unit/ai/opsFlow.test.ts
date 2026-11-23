// The script interpreter (runScript) and the opcodes that read no battle state: random draws, the score, calcTemp
// comparisons and tables, the current move and the cursor commands (trainer_ai.c).

import { describe, expect, it } from 'vitest';
import { BATTLE_TYPE_DOUBLES, BATTLE_TYPE_TRAINER } from '../../../src/ai/constants.js';
import type { Latents } from '../../../src/ai/lib/speed.js';
import { rat } from '../../../src/ai/odds.js';
import { HANDLERS } from '../../../src/ai/script/run.js';
import { fixtureView, FX } from './fixtures.js';
import {
  BRANCH, branches, codeOf, loads, NOT_TAKEN, oddsOf, type Opts, run, TAKEN, throws,
} from './opsHarness.js';

const M = FX.move;
/** A table after the code, which IfLoadedInTable and IfLoadedNotInTable read (aicmd.inc:632). */
const TABLE = 'Table:\nTableEntry 33\nTableEntry 55\nTableEnd';

describe('flow opcodes', () => {
  // `RandNext() % 256` against the value (trainer_ai.c:535–571): `n` of the 256 residues jump, none or all out of range.
  it.each<[string, number]>([
    ['IfRandomLessThan 128', 128], ['IfRandomLessThan 0', 0], ['IfRandomLessThan 256', 256],
    ['IfRandomLessThan 300', 256], ['IfRandomLessThan -5', 0],
    ['IfRandomGreaterThan 127', 128], ['IfRandomGreaterThan 200', 55], ['IfRandomGreaterThan 255', 0],
    ['IfRandomGreaterThan -1', 256],
    ['IfRandomEqualTo 0', 1], ['IfRandomEqualTo 256', 0], ['IfRandomNotEqualTo 7', 255], ['IfRandomNotEqualTo 256', 256],
  ])('%s jumps for %i of 256 draws', (instr, n) => {
    const want = Object.entries({ [NOT_TAKEN]: rat(256 - n, 256), [TAKEN]: rat(n, 256) }).filter(([, p]) => p.num !== 0n);
    expect(oddsOf(`${instr}, Taken${BRANCH}`)).toEqual(Object.fromEntries(want));
  });

  it.each<[string, number, Opts?]>([
    ['AddToMoveScore 5\nPopOrEnd', 105], // moveScore[moveSlot] += val (trainer_ai.c:581)
    ['AddToMoveScore -3\nPopOrEnd', 97],
    ['AddToMoveScore 27\nPopOrEnd', 127],
    // moveScore is s8 (ai_context.h): 128 stores as -128, which the clamp at trainer_ai.c:583–585 makes 0.
    ['AddToMoveScore 28\nPopOrEnd', 0],
    ['AddToMoveScore -10\nPopOrEnd', 0, { score: 5 }],
    // PushAndGoTo pushes the cursor past the jump word, then jumps; PopOrEnd returns there (trainer_ai.c:2556–2558).
    ['PushAndGoTo Sub\nAddToMoveScore 2\nPopOrEnd\nSub: AddToMoveScore 1\nPopOrEnd', 103],
    ['GoTo Skip\nAddToMoveScore 5\nSkip: AddToMoveScore 1\nPopOrEnd', 101], // trainer_ai.c:2563–2565
    ['GoTo Start\nBack: AddToMoveScore 1\nPopOrEnd\nStart: AddToMoveScore 2\nGoTo Back', 103], // a negative jump
    ['PopOrEnd\nAddToMoveScore 5\nPopOrEnd', 100], // an empty stack ends the run (trainer_ai.c:2572–2576)
  ])('%j scores %i', (src, score, opts) => expect(run(src, opts).score).toBe(score));

  // calcTemp tests are int compares and masks (trainer_ai.c:769–829, 1085–1097), bit 31 included. The table scan stops
  // at 0xFFFFFFFF, which never matches (:866–892).
  it.each<[string, number, boolean]>([
    ['IfLoadedLessThan 6', 5, true], ['IfLoadedLessThan 6', 6, false], ['IfLoadedLessThan 0', -1, true],
    ['IfLoadedGreaterThan 6', 7, true], ['IfLoadedGreaterThan 6', 6, false],
    ['IfLoadedEqualTo 6', 6, true], ['IfLoadedEqualTo 6', 7, false],
    ['IfLoadedNotEqualTo 6', 7, true], ['IfLoadedNotEqualTo 6', 6, false],
    ['IfLoadedMask 4', 6, true], ['IfLoadedMask 9', 6, false], [`IfLoadedMask ${1 << 31}`, (1 << 31) | 1, true],
    ['IfLoadedNotMask 9', 6, true], ['IfLoadedNotMask 4', 6, false], [`IfLoadedNotMask ${1 << 31}`, 1 << 31, false],
    ['IfTempEqualTo 3', 3, true], ['IfTempEqualTo 3', 4, false],
    ['IfTempNotEqualTo 3', 4, true], ['IfTempNotEqualTo 3', 3, false],
    ['IfLoadedInTable Table', 55, true], ['IfLoadedInTable Table', 33, true], ['IfLoadedInTable Table', 63, false],
    ['IfLoadedInTable Table', -1, false],
    ['IfLoadedNotInTable Table', 63, true], ['IfLoadedNotInTable Table', -1, true], ['IfLoadedNotInTable Table', 55, false],
  ])('%s with calcTemp %i → %s', (instr, calcTemp, taken) => {
    expect(run(`${instr}, Taken${BRANCH}\n${TABLE}`, { calcTemp }).score).toBe(taken ? TAKEN : NOT_TAKEN);
  });

  branches([
    // AI_CONTEXT.move == val (trainer_ai.c:841–853): slot 0 is Dragon Claw.
    [`IfMoveEqualTo ${M.DRAGON_CLAW}, Taken`, true],
    [`IfMoveEqualTo ${M.EARTHQUAKE}, Taken`, false],
    [`IfMoveEqualTo ${M.EARTHQUAKE}, Taken`, true, { slot: 1 }],
    [`IfMoveNotEqualTo ${M.EARTHQUAKE}, Taken`, true],
    [`IfMoveNotEqualTo ${M.DRAGON_CLAW}, Taken`, false],
    // (attacker & 1) == (defender & 1) (trainer_ai.c:2636): only the slot numbers.
    ['IfTargetIsPartner Taken', false],
    ['IfTargetIsPartner Taken', true, { defender: 3 }],
  ]);

  // calcTemp = AI_CONTEXT.move (trainer_ai.c:1161), which the caller sets to MOVE_NONE for a slot without PP.
  loads([['LoadCurrentMove', M.DRAGON_CLAW], ['LoadCurrentMove', M.EARTHQUAKE, { slot: 1 }], ['LoadCurrentMove', 0, { move: 0 }]]);
});

describe('runScript', () => {
  /** `depth` nested PushAndGoTo calls, each subroutine calling the next; the deepest adds 1. */
  function nested(depth: number): string {
    const lines: string[] = [];
    for (let i = 0; i < depth; i++) lines.push(`${i === 0 ? '' : `L${i}: `}PushAndGoTo L${i + 1}`, 'PopOrEnd');
    lines.push(`L${depth}: AddToMoveScore 1`, 'PopOrEnd');
    return lines.join('\n');
  }

  throws([
    ['Escape', 'ESCAPE'], // roamers and the Safari Zone only (trainer_ai.c:1878)
    ['PopOrEnd\nEscape', undefined],
    ['Dummy3E 0', 'UNSUPPORTED'], // returns without moving the cursor, so the cartridge would hang (:1881–1884)
    ['Dummy3F', 'UNSUPPORTED'],
    [nested(8), undefined], // scriptStackPointer holds AI_MAX_STACK_SIZE (8) cursors (trainer_ai.c:2673, 2676)
    [nested(9), 'STACK'],
    ['TableEntry 109', 'UNKNOWN_OPCODE'], // sAICommandTable has 109 entries (:207); the C doesn't check (:501)
    ['Loop: GoTo Loop', 'LIMIT'], // the cartridge would hang
    ['PopOrEnd', 'UNSUPPORTED', { v: fixtureView({ battleType: BATTLE_TYPE_TRAINER | BATTLE_TYPE_DOUBLES }) }],
  ]);

  it('running off the script throws UNKNOWN_OPCODE', () => {
    expect(codeOf(() => run('AddToMoveScore 1'))).toBe('UNKNOWN_OPCODE');
  });

  const READ = 'IfLoadedEqualTo 0, Taken\nPopOrEnd\nTaken: PopOrEnd';
  it.each<[string, boolean, Opts?]>([
    [READ, true],
    [`LoadTurnCount\n${READ}`, false],
    // An empty table stops both loops before their calcTemp test (trainer_ai.c:866–867, 884–885).
    ['IfLoadedInTable Table, Taken\nPopOrEnd\nTaken: PopOrEnd\nTable:\nTableEnd', false],
    ['IfLoadedNotInTable Table, Taken\nPopOrEnd\nTaken: PopOrEnd\nTable:\nTableEnd', false],
    // An unknown LoadTypeFrom parameter only asserts (trainer_ai.c:985–987), so it writes nothing.
    [`LoadTypeFrom 99\n${READ}`, true],
    [`LoadTypeFrom 0\n${READ}`, false],
    // A write on one branch only flags the path that skips it: Dragon Claw jumps over the load, Earthquake doesn't.
    [`IfMoveEqualTo ${M.DRAGON_CLAW}, Skip\nLoadTurnCount\nSkip: ${READ}`, true, { slot: 0 }],
    [`IfMoveEqualTo ${M.DRAGON_CLAW}, Skip\nLoadTurnCount\nSkip: ${READ}`, false, { slot: 1 }],
  ])('%j reads the incoming calcTemp: %s', (src, read, opts) => expect(run(src, opts).readIncomingTemp).toBe(read));

  it('calcTemp carries through a run that does not load', () => {
    expect(run('PopOrEnd', { calcTemp: 77 })).toMatchObject({ calcTemp: 77, readIncomingTemp: false });
    expect(run('LoadTurnCount\nPopOrEnd', { calcTemp: 77 }).calcTemp).toBe(0);
  });

  it("the run's latents are its own copy", () => {
    const lat: Latents = { rolls: [90, null, null, null], quickClaw: [null, true, null, null] };
    const result = run('PopOrEnd', { lat });
    expect(result.lat).toEqual(lat);
    expect(result.lat).not.toBe(lat);
  });

  it('every one of the 109 opcodes has a handler', () => {
    // sAICommandTable (trainer_ai.c:207) has an entry for every AICMD_* of aicmd.h.
    expect(HANDLERS).toHaveLength(109);
    expect(HANDLERS.filter((handler) => typeof handler === 'function')).toHaveLength(109);
  });
});
