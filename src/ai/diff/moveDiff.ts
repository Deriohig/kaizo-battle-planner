// The hack's move data against vanilla's, as the trainer AI reads it. The script picks routines by a move's effect ID
// (MOVE_DATA(move).effect: trainer_ai.c:1167, 1448, 1460, 2535), so a move whose effect changed is scored by other
// routines. Its power, type and class feed the damage estimate and the LoadMovePower (trainer_ai.c:1009), LoadTypeFrom
// (trainer_ai.c:962) and LoadCurrentMoveClass (trainer_ai.c:2047) reads.

import type { MoveRecord } from '../../rom/types.js';
import { isDamageEstimated } from '../lib/damage.js';
import type { AiScript } from '../rom/script.js';
import { type Instr, reachable } from '../script/disasm.js';
import type { SourceLabel } from './labels.js';
import { type ConstantNames, loadedKind, tableAt } from './scriptDiff.js';

/**
 * A move whose effect ID differs. The routines are the script's branches on each effect: "Label → Target" where a move
 * with that effect jumps, and "Label" where it falls through. Label is the nearest label before the branch.
 * `damageScoring` is damageScoringNote's note for the move.
 */
export interface MoveEffectChange {
  move: number; name: string; vanillaEffect: number; hackEffect: number; vanillaEffectName: string; hackEffectName: string;
  vanillaRoutines: string[]; hackRoutines: string[]; damageScoring: string | null;
}

/** The other move fields the AI reads or the battle uses, in table order. */
export const MOVE_FIELDS = ['power', 'type', 'class', 'accuracy', 'pp', 'priority'] as const;
export type MoveField = (typeof MOVE_FIELDS)[number];

/** One field of one move that differs, both values rendered: types by name, classes capitalised. */
export interface MoveFieldChange { move: number; name: string; field: MoveField; vanilla: string; hack: string }

const ALL_BITS = Array.from({ length: 32 }, (_, bit) => bit);
/** Tests of the current move's effect (trainer_ai.c:1441–1463). */
const CURRENT_EFFECT_TESTS = new Set(['IfCurrentMoveEffectEqualTo', 'IfCurrentMoveEffectNotEqualTo']);
/** Tests of calcTemp against one value (trainer_ai.c:786–808). */
const LOADED_TESTS = new Set(['IfLoadedEqualTo', 'IfLoadedNotEqualTo']);
/** Tests of calcTemp against a table (trainer_ai.c:858–893). */
const LOADED_TABLE_TESTS = new Set(['IfLoadedInTable', 'IfLoadedNotInTable']);
/** The tests that jump when the value matches; the others jump when it doesn't, so a matching move falls through. */
const JUMP_ON_MATCH = new Set(['IfCurrentMoveEffectEqualTo', 'IfLoadedEqualTo', 'IfLoadedInTable']);

/**
 * The routines that branch on each effect ID in `script`'s code reachable from any flag:
 * - IfCurrentMoveEffectEqualTo and IfCurrentMoveEffectNotEqualTo with that ID;
 * - IfLoadedEqualTo and IfLoadedNotEqualTo with that ID, and IfLoadedInTable and IfLoadedNotInTable with a table
 *   holding it, where the straight-line code before last loaded an effect (LoadCurrentMoveEffect or
 *   LoadEffectOfLoadedMove).
 *
 * Each routine is listed once per effect, in script order. `labels` must name `script`'s own words.
 */
export function effectRoutines(script: AiScript, labels: SourceLabel[]): Map<number, string[]> {
  const code = [...reachable(script, ALL_BITS).values()];
  const sorted = [...labels].sort((a, b) => a.at - b.at);
  const nearest = (at: number): SourceLabel | null => {
    let found: SourceLabel | null = null;
    for (const label of sorted) {
      if (label.at > at) break;
      found = label;
    }
    return found;
  };
  const brancher = (at: number) => nearest(at)?.name ?? `@${at}`;
  const target = (at: number) => {
    const label = nearest(at);
    if (label === null) return `@${at}`;
    return label.at === at ? label.name : `${label.name}+${at - label.at}`;
  };

  const routines = new Map<number, string[]>();
  for (const instr of code) {
    const effects = testedEffects(script, code, instr);
    if (effects.length === 0) continue;
    // The jump is each test's last argument (opcodes.ts).
    const routine = JUMP_ON_MATCH.has(instr.op.name) ? `${brancher(instr.at)} → ${target(instr.targets.at(-1)!)}` : brancher(instr.at);
    for (const effect of effects) {
      const list = routines.get(effect) ?? [];
      if (!list.includes(routine)) list.push(routine);
      routines.set(effect, list);
    }
  }
  return routines;
}

/** The effect IDs `instr` tests, or none when it doesn't test an effect. */
function testedEffects(script: AiScript, code: Instr[], instr: Instr): number[] {
  const name = instr.op.name;
  if (CURRENT_EFFECT_TESTS.has(name)) return [instr.args[0]!];
  if (!LOADED_TESTS.has(name) && !LOADED_TABLE_TESTS.has(name)) return [];
  if (loadedKind(code, instr) !== 'effect') return [];
  return LOADED_TESTS.has(name) ? [instr.args[0]!] : tableAt(script, instr.targets[0]!);
}

/**
 * Every move whose effect ID differs between `vanilla` and `hack`, in ID order, with the routines of `script` (the
 * hack's) that branch on each side's effect, and its damage-scoring note. `labels` must name `script`'s words.
 * `names.effect` names the effects and `names.move` the moves: the CLI passes the docs' Moves tab names there, since
 * the hack renames moves.
 */
export function diffMoveEffects(
  vanilla: MoveRecord[], hack: MoveRecord[], script: AiScript, labels: SourceLabel[], names: ConstantNames,
): MoveEffectChange[] {
  checkLengths(vanilla, hack);
  const routines = effectRoutines(script, labels);
  const effectName = (effect: number) => names.effect?.[effect] ?? String(effect);
  return hack.flatMap((after, id) => {
    const before = vanilla[id]!;
    if (before.effect === after.effect) return [];
    return [{
      move: id,
      name: moveName(names, id),
      vanillaEffect: before.effect,
      hackEffect: after.effect,
      vanillaEffectName: effectName(before.effect),
      hackEffectName: effectName(after.effect),
      vanillaRoutines: [...(routines.get(before.effect) ?? [])],
      hackRoutines: [...(routines.get(after.effect) ?? [])],
      damageScoring: damageScoringNote(before, after),
    }];
  });
}

/**
 * "now damage-scored" or "no longer damage-scored" when the AI's damage-estimate test (the port's isDamageEstimated,
 * from the move's effect and power) gives `before` and `after` different answers; null when it gives the same.
 */
export function damageScoringNote(before: MoveRecord, after: MoveRecord): string | null {
  const was = isDamageEstimated(before);
  const is = isDamageEstimated(after);
  if (was === is) return null;
  return is ? 'now damage-scored' : 'no longer damage-scored';
}

/**
 * Every power, type, class, accuracy, PP and priority that differs between `vanilla` and `hack`, by move ID and then
 * in MOVE_FIELDS order. `names.type` names the types and `names.move` the moves, as for diffMoveEffects.
 */
export function diffMoveFields(vanilla: MoveRecord[], hack: MoveRecord[], names: ConstantNames): MoveFieldChange[] {
  checkLengths(vanilla, hack);
  const render: Record<MoveField, (move: MoveRecord) => string> = {
    power: (move) => String(move.power),
    type: (move) => names.type?.[move.type] ?? String(move.type),
    class: (move) => move.category.charAt(0).toUpperCase() + move.category.slice(1),
    accuracy: (move) => String(move.accuracy),
    pp: (move) => String(move.pp),
    priority: (move) => String(move.priority),
  };
  return hack.flatMap((after, id) => MOVE_FIELDS.flatMap((field) => {
    const before = render[field](vanilla[id]!);
    const now = render[field](after);
    return before === now ? [] : [{ move: id, name: moveName(names, id), field, vanilla: before, hack: now }];
  }));
}

function moveName(names: ConstantNames, id: number): string {
  return names.move?.[id] ?? String(id);
}

function checkLengths(vanilla: MoveRecord[], hack: MoveRecord[]): void {
  if (vanilla.length !== hack.length) throw new Error(`vanilla has ${vanilla.length} moves but the hack has ${hack.length}`);
}
