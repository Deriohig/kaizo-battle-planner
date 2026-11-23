// What the engine doesn't model. Notes on what it could not model in a battle live in the battle's `formatData`, so
// every snapshot after them carries them, and `unmodelledIn(state)` reports them: a line through such a state is
// unproven. The moves it doesn't model are `unmodelledMoves`, listed in docs/engine-model.md.
//
// This module is imported by the mod's modules, which dex.ts imports: it uses dex.ts only inside its functions.

import PS from 'pokemon-showdown';
import type { KaizoMove } from '../battle/moves.js';
import { installedMoves, moveId as showdownId } from './dex.js';
import { engineEffect } from './effects.js';

const { toID } = PS;

const NOTES_KEY = 'kaizoUnmodelled';

/** Records `note` in `battle` (once). */
export function addUnmodelledNote(battle: Battle, note: string): void {
  const notes = (battle.formatData[NOTES_KEY] ??= []) as string[];
  if (!notes.includes(note)) notes.push(note);
}

/** The notes recorded in `battle`, oldest first. */
export function unmodelledNotes(battle: Battle): string[] {
  return [...((battle.formatData[NOTES_KEY] as string[] | undefined) ?? [])];
}

/**
 * Why the engine doesn't model `move`, or null when it does: its engine effect's reason when that is
 * `unmodelled` (effects.ts), or for a move with no docs text the calc's note (`KaizoMove.unmodelled`, which then says
 * the docs lack it). A move the engine models is never reported for its calc-only note: the
 * engine is the model of record.
 */
export function unmodelledReason(move: KaizoMove): string | null {
  const effect = engineEffect(move);
  if (effect.kind !== 'unmodelled') return null;
  return move.effectText.trim() === '' ? move.unmodelled ?? effect.reason : effect.reason;
}

/** Every move of `moves` the engine doesn't model, by move ID, with the reason (`unmodelledReason`). */
export function unmodelledMoves(moves: Map<number, KaizoMove>): { move: KaizoMove; reason: string }[] {
  return [...moves.values()].sort((a, b) => a.id - b.id).flatMap((move) => {
    const reason = unmodelledReason(move);
    return reason === null ? [] : [{ move, reason }];
  });
}

/** The installed moves by Showdown ID, per installed move map. */
const byShowdownId = new WeakMap<Map<number, KaizoMove>, Map<string, KaizoMove>>();

/** The installed moves by Showdown ID (later moves win an ID two share), built once per installed move map. Throws if no dex is installed. */
export function installedMovesById(): ReadonlyMap<string, KaizoMove> {
  const moves = installedMoves();
  let ids = byShowdownId.get(moves);
  if (ids === undefined) {
    ids = new Map([...moves.values()].map((move) => [showdownId(move), move]));
    byShowdownId.set(moves, ids);
  }
  return ids;
}

/**
 * Whether the move with Showdown ID `moveId` is one the engine doesn't model in the installed dex, which the planner uses to
 * mark a line unproven: an `unmodelledMoves` move, or an ID that is no hack move. Throws if no dex is installed.
 */
export function isUnmodelled(moveId: string): boolean {
  const move = installedMovesById().get(moveId);
  return move === undefined || unmodelledReason(move) !== null;
}

/**
 * What the engine doesn't model about `move`, or null: its `unmodelledReason`, named by move, reason and docs text. A
 * move the engine models is not reported for the calc's `KaizoMove.unmodelled`.
 */
function moveNote(move: KaizoMove): string | null {
  const reason = unmodelledReason(move);
  if (reason === null) return null;
  const text = move.effectText.trim();
  return text === '' ? `${move.name}: ${reason}` : `${move.name}: ${reason} ("${text}")`;
}

/**
 * What in `battle` the engine doesn't model (`unmodelledIn`, facts.ts, of the state `battle` holds; per move): for each move in the battle, on either side, that is one of `unmodelledMoves`
 * (docs/engine-model.md), one entry (`moveNote`), and one for a move that is no hack move; then the battle's own notes
 * (`unmodelledNotes`), which include the field note's (mod/field.ts), the pinch items' (mod/items.ts) and the held
 * items'. Moves are every Pokémon's set moves and move slots (Mimic's and Transform's copies too), in party order, p1
 * first, each once. Non-empty means a proof through the battle is unproven, so the list errs towards non-empty.
 */
export function unmodelledInBattle(battle: Battle): string[] {
  const moves = installedMovesById();
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const side of battle.sides) {
    for (const set of side.team) {
      const pokemon = side.pokemon.find((candidate) => candidate.set === set)!;
      const ids = [...set.moves.map((name) => toID(name)), ...pokemon.baseMoveSlots.map((slot) => slot.id), ...pokemon.moveSlots.map((slot) => slot.id)];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const move = moves.get(id);
        const note = move === undefined ? `engine: move "${id}" is not a hack move` : moveNote(move);
        if (note !== null) notes.push(note);
      }
    }
  }
  return [...notes, ...unmodelledNotes(battle)];
}
