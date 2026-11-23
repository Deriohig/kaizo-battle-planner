// The AI script commands that read no battle state: the random draws, the score, calcTemp comparisons and tables, the
// current move, the target check and the cursor commands. Literal ports of the AICmd_* handlers in trainer_ai.c; each
// cites its lines. Every handler starts as the C does, with AIScript_Iter(1) past its opcode.

import { AiError } from '../../errors.js';
import { s8 } from '../../int.js';
import { residueWeights } from '../../odds.js';
import type { OpHandler, OpTable, RunCtx } from '../run.js';

/** TABLE_END (aicmd.inc:632): 0xFFFFFFFF, as the script's int words read it (trainer_ai.c:866). */
const TABLE_END = -1;

/** `RandNext() % 256`: 256 residues, each the remainder of 256 of the 65536 draws. */
const RESIDUES_256 = residueWeights(256);

/**
 * One `RandNext() % 256` and whether `test` holds for it: one pick over [the draws for which it holds, the rest]. A
 * value out of 0–255 clamps itself, as the C comparison does.
 */
function drawHolds(ctx: RunCtx, test: (residue: number) => boolean): boolean {
  let holds = 0n;
  let total = 0n;
  RESIDUES_256.forEach((weight, residue) => {
    total += weight;
    if (test(residue)) holds += weight;
  });
  return ctx.pick([holds, total - holds]) === 0;
}

/** AICmd_IfRandom*: `int val`, `int jump`, then the draw (trainer_ai.c:528–574). */
function ifRandom(test: (residue: number, val: number) => boolean): OpHandler {
  return (ctx) => {
    ctx.iter(1);
    const val = ctx.read();
    const jump = ctx.read();
    if (drawHolds(ctx, (residue) => test(residue, val))) ctx.iter(jump);
  };
}

/** AICmd_IfLoaded*, IfTemp*: `int val`, `int jump`; the test reads calcTemp (trainer_ai.c:762–832, 1078–1100). */
function ifLoaded(test: (calcTemp: number, val: number) => boolean): OpHandler {
  return (ctx) => {
    ctx.iter(1);
    const val = ctx.read();
    const jump = ctx.read();
    if (test(ctx.calcTemp, val)) ctx.iter(jump);
  };
}

/** AICmd_IfMoveEqualTo, IfMoveNotEqualTo: AI_CONTEXT.move against `int val` (trainer_ai.c:834–856). */
function ifMove(test: (move: number, val: number) => boolean): OpHandler {
  return (ctx) => {
    ctx.iter(1);
    const val = ctx.read();
    const jump = ctx.read();
    if (test(ctx.move, val)) ctx.iter(jump);
  };
}

export const FLOW_OPS: OpTable = {
  IfRandomLessThan: ifRandom((residue, val) => residue < val), // trainer_ai.c:528–538
  IfRandomGreaterThan: ifRandom((residue, val) => residue > val), // trainer_ai.c:540–550
  IfRandomEqualTo: ifRandom((residue, val) => residue === val), // trainer_ai.c:552–562
  IfRandomNotEqualTo: ifRandom((residue, val) => residue !== val), // trainer_ai.c:564–574

  AddToMoveScore: (ctx) => { // trainer_ai.c:576–586
    ctx.iter(1);
    const val = ctx.read();
    ctx.score = s8(ctx.score + val); // :581: moveScore is s8 (ai_context.h), so 128 stores as -128
    if (ctx.score < 0) ctx.score = 0; // :583–585
  },

  IfLoadedLessThan: ifLoaded((calcTemp, val) => calcTemp < val), // trainer_ai.c:762–772
  IfLoadedGreaterThan: ifLoaded((calcTemp, val) => calcTemp > val), // trainer_ai.c:774–784
  IfLoadedEqualTo: ifLoaded((calcTemp, val) => calcTemp === val), // trainer_ai.c:786–796
  IfLoadedNotEqualTo: ifLoaded((calcTemp, val) => calcTemp !== val), // trainer_ai.c:798–808
  IfLoadedMask: ifLoaded((calcTemp, mask) => (calcTemp & mask) !== 0), // trainer_ai.c:810–820
  IfLoadedNotMask: ifLoaded((calcTemp, mask) => (calcTemp & mask) === 0), // trainer_ai.c:822–832

  IfMoveEqualTo: ifMove((move, val) => move === val), // trainer_ai.c:834–844
  IfMoveNotEqualTo: ifMove((move, val) => move !== val), // trainer_ai.c:846–856

  IfLoadedInTable: (ctx) => { // trainer_ai.c:858–874
    ctx.iter(1);
    let ofs = ctx.read();
    const jump = ctx.read();
    let val: number;
    while ((val = ctx.readOffset(ofs)) !== TABLE_END) { // :866
      if (ctx.calcTemp === val) { // :867–870
        ctx.iter(jump);
        break;
      }
      ofs++; // :872
    }
  },

  IfLoadedNotInTable: (ctx) => { // trainer_ai.c:876–893
    ctx.iter(1);
    let ofs = ctx.read();
    const jump = ctx.read();
    let val: number;
    while ((val = ctx.readOffset(ofs)) !== TABLE_END) { // :884
      if (ctx.calcTemp === val) return; // :885–887
      ofs++; // :889
    }
    ctx.iter(jump); // :892
  },

  IfTempEqualTo: ifLoaded((calcTemp, val) => val === calcTemp), // trainer_ai.c:1078–1088
  IfTempNotEqualTo: ifLoaded((calcTemp, val) => val !== calcTemp), // trainer_ai.c:1090–1100

  LoadCurrentMove: (ctx) => { // trainer_ai.c:1158–1162
    ctx.iter(1);
    ctx.calcTemp = ctx.move;
  },

  IfTargetIsPartner: (ctx) => { // trainer_ai.c:2630–2639
    ctx.iter(1);
    const jump = ctx.read();
    if ((ctx.attacker & 1) === (ctx.defender & 1)) ctx.iter(jump);
  },

  Escape: () => { // trainer_ai.c:1875–1879
    throw new AiError('ESCAPE', 'Escape (trainer_ai.c:1878) ends the decision with AI_ENEMY_ESCAPE: it belongs to roamers and the Safari Zone, never trainers');
  },

  Dummy3E: () => { // trainer_ai.c:1881–1884
    throw new AiError('UNSUPPORTED', 'Dummy3E returns without moving the cursor (trainer_ai.c:1883), so the cartridge would run it forever');
  },

  Dummy3F: () => { // trainer_ai.c:1886–1889
    throw new AiError('UNSUPPORTED', 'Dummy3F returns without moving the cursor (trainer_ai.c:1888), so the cartridge would run it forever');
  },

  PushAndGoTo: (ctx) => { // trainer_ai.c:2554–2559
    ctx.iter(1);
    const jump = ctx.read();
    ctx.push(jump); // the cursor pushed is past the jump word (:2673)
  },

  GoTo: (ctx) => { // trainer_ai.c:2561–2566
    ctx.iter(1);
    const jump = ctx.read();
    ctx.iter(jump);
  },

  PopOrEnd: (ctx) => { // trainer_ai.c:2568–2577
    ctx.iter(1);
    if (ctx.pop()) return; // :2572–2574
    ctx.done = true; // :2576: AI_STATUS_FLAG_DONE
  },
};
