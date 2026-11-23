// The trainer AI's script interpreter: one run of one flag's script for one move slot, as TrainerAI_EvalMoves's EVAL
// step runs it (trainer_ai.c:499–520), one command at a time until PopOrEnd finds the stack empty. RunCtx carries the
// AIScript_* cursor helpers (trainer_ai.c:2671–2782). The handlers live in ops/: each module exports a table by
// command name, and HANDLERS joins them by opcode. The ops modules import only types from here, so there is no
// import cycle; a module that adds handlers adds its table to HANDLER_TABLES below.

import { AI_BATTLER_ATTACKER, AI_BATTLER_ATTACKER_PARTNER, AI_BATTLER_DEFENDER_PARTNER, AI_MAX_STACK_SIZE, BATTLE_TYPE_DOUBLES } from '../constants.js';
import type { Pick } from '../enumerate.js';
import { AiError } from '../errors.js';
import { u32, u8 } from '../int.js';
import { PATHS, requireKnown } from '../lib/known.js';
import type { Latents } from '../lib/speed.js';
import type { AiDeps, AiKnowledge, AiView } from '../view.js';
import { CALC_OPS } from './ops/calc.js';
import { FLOW_OPS } from './ops/flow.js';
import { KNOWLEDGE_OPS } from './ops/knowledge.js';
import { PARTY_OPS } from './ops/party.js';
import { STATE_OPS } from './ops/state.js';
import { OP, OPCODES, type OpName } from './opcodes.js';

export interface RunInput {
  v: AiView; d: AiDeps; k: AiKnowledge; lat: Latents;
  /** The AI_CONTEXT fields for this run: attacker, defender, moveSlot and move (MOVE_NONE when the slot has no PP). */
  attacker: number; defender: number; slot: number; move: number;
  /** moveScore[slot] (s8) and calcTemp (int) as the run starts: calcTemp is the caller's carried value. */
  score: number; calcTemp: number; pick: Pick;
  /**
   * battleCtx->monSpeedValues (4, by battler) as the run starts: the caller's carried copy, which an earlier run's speed
   * comparison may have written (battle_lib.c:1372–1373). The run reads these, not v.monSpeedValues.
   */
  monSpeedValues: number[];
  /**
   * True when `monSpeedValues` are still the decision-start values (the view's): no earlier run of this decision, in
   * cartridge order, has written them. The fast path always passes true; the slow path carries it from run to run. The
   * view-gap check throws AiError('UNDEFINED') for a run that reads incoming speeds while the view lists
   * 'monSpeedValues' as unknown, and only when this is true.
   */
  startSpeeds: boolean;
}

/**
 * `readIncomingTemp`: the run read calcTemp before writing it, so its outcome may depend on the carried value.
 * `lat`: the run's own copy of the input latents, with whatever the run fixed.
 * `monSpeedValues`: the run's final copy, the input's with whatever its speed comparisons wrote.
 * `readIncomingSpeeds`: the run read an entry of monSpeedValues (Gyro Ball's estimate, trainer_ai.c:2996) that its own
 * speed comparisons hadn't written, so its outcome may depend on the carried copy.
 */
export interface RunResult {
  score: number; calcTemp: number; readIncomingTemp: boolean; lat: Latents;
  monSpeedValues: number[]; readIncomingSpeeds: boolean;
}

/** What a handler reads and changes: the run's input, the score, calcTemp, the cursor and the stack. */
export interface RunCtx {
  readonly v: AiView; readonly d: AiDeps; readonly k: AiKnowledge; readonly pick: Pick;
  /** The run's own latents (a copy of the input's); helpers that read a latent fix it here. */
  readonly lat: Latents;
  readonly attacker: number; readonly defender: number; readonly slot: number; readonly move: number;
  /** AI_CONTEXT.moveScore[moveSlot], an s8. */
  score: number;
  /** AI_CONTEXT.calcTemp, an int. A read before the run's first write sets the result's readIncomingTemp. */
  calcTemp: number;
  /** battleCtx->aiScriptCursor: the index of the next word. */
  cursor: number;
  /** AI_CONTEXT.scriptStackPointer[0 … scriptStackSize − 1]. */
  readonly stack: number[];
  /** AI_STATUS_FLAG_DONE: set by PopOrEnd on an empty stack; the run ends after the command. */
  done: boolean;
  /**
   * The view the damage estimate reads: `v` with the run's own monSpeedValues in place of the view's, as
   * TrainerAI_CalcDamage reads battleCtx->monSpeedValues for Gyro Ball (trainer_ai.c:2996). Reading an entry the run
   * hasn't written sets the result's readIncomingSpeeds.
   */
  readonly calcView: AiView;
  /**
   * Stores what BattleSystem_CompareBattlerSpeed writes to monSpeedValues[b1] and [b2] (battle_lib.c:1372–1373) in the
   * run's copy. `speeds` null writes nothing, as when the C returns early (battle_lib.c:1204–1211).
   */
  writeSpeeds(b1: number, b2: number, speeds: readonly [number, number] | null): void;
  /** AIScript_Read (trainer_ai.c:2726): the word at the cursor, then the cursor moves past it. */
  read(): number;
  /** AIScript_ReadOffset (trainer_ai.c:2741): the word `ofs` past the cursor; the cursor stays. */
  readOffset(ofs: number): number;
  /** AIScript_Iter (trainer_ai.c:2752): moves the cursor by `i` words. */
  iter(i: number): void;
  /** AIScript_Battler (trainer_ai.c:2765): the battler slot a script battler code names. */
  battler(inBattler: number): number;
  /** AIScript_PushCursor (trainer_ai.c:2671): pushes the cursor, then moves it by `offset`. */
  push(offset: number): void;
  /** AIScript_PopCursor (trainer_ai.c:2687): pops the cursor; false when the stack is empty. */
  pop(): boolean;
}

export type OpHandler = (ctx: RunCtx) => void;
/** One ops module's handlers, by command name. */
export type OpTable = Partial<Record<OpName, OpHandler>>;

/** The ops modules' tables. */
const HANDLER_TABLES: readonly OpTable[] = [FLOW_OPS, STATE_OPS, CALC_OPS, KNOWLEDGE_OPS, PARTY_OPS];

/**
 * sAICommandTable (trainer_ai.c:207): the handler for each opcode. An opcode with no entry, or past the table (the C
 * doesn't check, trainer_ai.c:501), throws AiError('UNKNOWN_OPCODE') when a run reaches it.
 */
export const HANDLERS: (OpHandler | undefined)[] = joinTables(HANDLER_TABLES);

function joinTables(tables: readonly OpTable[]): (OpHandler | undefined)[] {
  const handlers: (OpHandler | undefined)[] = Array.from({ length: OPCODES.length }, () => undefined);
  for (const table of tables) {
    for (const [name, handler] of Object.entries(table) as [OpName, OpHandler][]) {
      const code = OP[name];
      if (handlers[code] !== undefined) throw new Error(`AI command ${name} has two handlers`);
      handlers[code] = handler;
    }
  }
  return handlers;
}

/**
 * More commands than any run of a well-formed script takes. A script that loops forever would hang the cartridge, as
 * Dummy3E and Dummy3F would; the port throws AiError('LIMIT') instead.
 */
const MAX_COMMANDS = 100_000;

/**
 * calcView's monSpeedValues: the run's speeds, entry by entry, each read through Run.readSpeed, which notes a read of an
 * entry the run hasn't written. Its getters live on the prototype, so a run defines no property (the four
 * Object.defineProperty calls and closures a frozen array of getters took per run were the interpreter's largest cost).
 * The damage estimate, its one reader, indexes it by battler (damage.ts, Gyro Ball); an index past the run's speeds reads
 * undefined, as an index past the array did.
 */
class TrackedSpeeds {
  readonly #run: Run;
  readonly #startSpeeds: boolean;

  constructor(run: Run, startSpeeds: boolean) {
    this.#run = run;
    this.#startSpeeds = startSpeeds;
  }

  get 0(): number | undefined {
    return this.#run.readSpeed(0, this.#startSpeeds);
  }

  get 1(): number | undefined {
    return this.#run.readSpeed(1, this.#startSpeeds);
  }

  get 2(): number | undefined {
    return this.#run.readSpeed(2, this.#startSpeeds);
  }

  get 3(): number | undefined {
    return this.#run.readSpeed(3, this.#startSpeeds);
  }
}

class Run implements RunCtx {
  readonly v: AiView;
  readonly d: AiDeps;
  readonly k: AiKnowledge;
  readonly pick: Pick;
  readonly lat: Latents;
  readonly attacker: number;
  readonly defender: number;
  readonly slot: number;
  readonly move: number;
  score: number;
  cursor: number;
  readonly stack: number[] = [];
  done = false;
  readIncomingTemp = false;
  readIncomingSpeeds = false;
  readonly #words: Int32Array;
  #calcTemp: number;
  #wroteTemp = false;
  /** The run's copy of battleCtx->monSpeedValues, and which entries the run has written. */
  readonly #speeds: number[];
  readonly #wroteSpeed: boolean[];
  /** RunInput.startSpeeds, for calcView's speeds. */
  readonly #startSpeeds: boolean;
  /** calcView, made at its first read: a run that estimates no damage never makes it. */
  #calcView: AiView | null = null;

  constructor(entry: number, input: RunInput) {
    this.v = input.v;
    this.d = input.d;
    this.k = input.k;
    this.pick = input.pick;
    this.lat = { rolls: [...input.lat.rolls], quickClaw: [...input.lat.quickClaw] };
    this.attacker = input.attacker;
    this.defender = input.defender;
    this.slot = input.slot;
    this.move = input.move;
    this.score = input.score;
    this.#calcTemp = input.calcTemp;
    this.#speeds = [...input.monSpeedValues];
    this.#wroteSpeed = this.#speeds.map(() => false);
    this.#startSpeeds = input.startSpeeds;
    this.#words = input.d.script.words;
    this.cursor = entry; // battleCtx->aiScriptCursor = aiScriptTemp[thinkingBitShift] (trainer_ai.c:488)
  }

  /**
   * The view the damage estimate reads (RunCtx.calcView). The run guards monSpeedValues itself, entry by entry
   * (TrackedSpeeds), so the damage estimate's own guard is off.
   */
  get calcView(): AiView {
    this.#calcView ??= {
      ...this.v,
      monSpeedValues: new TrackedSpeeds(this, this.#startSpeeds) as unknown as number[],
      unknown: this.v.unknown.filter((path) => path !== PATHS.monSpeedValues),
    };
    return this.#calcView;
  }

  get calcTemp(): number {
    if (!this.#wroteTemp) this.readIncomingTemp = true;
    return this.#calcTemp;
  }

  set calcTemp(value: number) {
    this.#wroteTemp = true;
    this.#calcTemp = value | 0; // int calcTemp (ai_context.h)
  }

  /**
   * calcView's speed of `battler`: the run's own, noting a read of an entry the run hasn't written. That entry is the
   * incoming copy's; while the copy is the decision start's (`startSpeeds`) and the view lists it as unknown
   * (PATHS.monSpeedValues), the read throws AiError('UNDEFINED'). Past the run's speeds, undefined, with nothing noted.
   */
  readSpeed(battler: number, startSpeeds: boolean): number | undefined {
    if (battler >= this.#speeds.length) return undefined;
    if (!this.#wroteSpeed[battler]) {
      if (startSpeeds) requireKnown(this.v, PATHS.monSpeedValues);
      this.readIncomingSpeeds = true;
    }
    return this.#speeds[battler];
  }

  writeSpeeds(b1: number, b2: number, speeds: readonly [number, number] | null): void {
    if (speeds === null) return;
    this.#writeSpeed(b1, speeds[0]); // battle_lib.c:1372
    this.#writeSpeed(b2, speeds[1]); // :1373
  }

  #writeSpeed(battler: number, speed: number): void {
    if (this.#speeds[battler] === undefined) throw new AiError('BAD_VIEW', `no monSpeedValues entry for battler ${battler}`);
    this.#speeds[battler] = u32(speed); // u32 monSpeedValues[MAX_BATTLERS] (battle_context.h:259)
    this.#wroteSpeed[battler] = true;
  }

  /** The script word at `at`. AiError('UNKNOWN_OPCODE') when the cursor has left the script. */
  word(at: number): number {
    const word = this.#words[at];
    if (word === undefined) throw new AiError('UNKNOWN_OPCODE', `the cursor left the script: word ${at} of ${this.#words.length}`);
    return word;
  }

  read(): number {
    const word = this.word(this.cursor); // trainer_ai.c:2728
    this.cursor++; // :2729
    return word;
  }

  readOffset(ofs: number): number {
    return this.word(this.cursor + ofs); // trainer_ai.c:2743
  }

  iter(i: number): void {
    this.cursor += i; // trainer_ai.c:2754
  }

  battler(inBattler: number): number {
    switch (u8(inBattler)) { // the parameter is a u8 (trainer_ai.c:2765)
      case AI_BATTLER_ATTACKER:
        return this.attacker; // :2769–2770
      case AI_BATTLER_ATTACKER_PARTNER:
        return this.attacker ^ 2; // :2776–2777
      case AI_BATTLER_DEFENDER_PARTNER:
        return this.defender ^ 2; // :2779–2780
      default:
        return this.defender; // AI_BATTLER_DEFENDER and any other code (:2772–2774)
    }
  }

  push(offset: number): void {
    // trainer_ai.c:2673: scriptStackPointer holds AI_MAX_STACK_SIZE cursors; a ninth would overwrite scriptStackSize
    // itself, and the GF_ASSERT after it (:2676) is compiled out.
    if (this.stack.length >= AI_MAX_STACK_SIZE) {
      throw new AiError('STACK', `PushAndGoTo with ${AI_MAX_STACK_SIZE} cursors already on the stack (trainer_ai.c:2673)`);
    }
    this.stack.push(this.cursor);
    this.iter(offset); // :2674
  }

  pop(): boolean {
    const cursor = this.stack.pop(); // trainer_ai.c:2689–2691
    if (cursor === undefined) return false; // :2695
    this.cursor = cursor;
    return true; // :2692
  }

  result(): RunResult {
    return {
      score: this.score, calcTemp: this.#calcTemp, readIncomingTemp: this.readIncomingTemp, lat: this.lat,
      monSpeedValues: [...this.#speeds], readIncomingSpeeds: this.readIncomingSpeeds,
    };
  }
}

/**
 * Runs the script from word `entry` for one move slot, one command per step, as TrainerAI_EvalMoves's EVAL step does
 * (trainer_ai.c:499–501), until PopOrEnd finds the stack empty (AI_STATUS_FLAG_DONE, :507). The caller skips a slot
 * whose move is MOVE_NONE (:500–504). Draws go through `input.pick`; latents fixed by the run come back in `lat`, and
 * the speeds its comparisons wrote in `monSpeedValues`, both copies. Throws AiError('UNDEFINED') where a handler reads a
 * field the view lists as unknown (lib/known.ts); AiError('UNSUPPORTED') for a double battle, and for Dummy3E and Dummy3F; AiError('ESCAPE') at Escape;
 * AiError('STACK') past 8 nested PushAndGoTo; AiError('UNKNOWN_OPCODE') at an opcode without a handler or when the
 * cursor leaves the script; AiError('LIMIT') past MAX_COMMANDS commands.
 */
export function runScript(entry: number, input: RunInput): RunResult {
  if ((input.v.battleType & BATTLE_TYPE_DOUBLES) !== 0) throw new AiError('UNSUPPORTED', 'double battles are not supported');
  const run = new Run(entry, input);
  for (let commands = 0; !run.done; commands++) {
    if (commands === MAX_COMMANDS) {
      throw new AiError('LIMIT', `the script ran ${MAX_COMMANDS} commands without ending (from word ${entry}); the cartridge would hang`);
    }
    const at = run.cursor;
    const code = run.word(at);
    const handler = HANDLERS[code]; // sAICommandTable[aiScriptTemp[aiScriptCursor]] (trainer_ai.c:501)
    if (handler === undefined) {
      const name = OPCODES[code]?.name;
      throw new AiError('UNKNOWN_OPCODE', `no handler for AI opcode ${code}${name ? ` (${name})` : ''} at word ${at}`);
    }
    handler(run);
  }
  return run.result();
}
