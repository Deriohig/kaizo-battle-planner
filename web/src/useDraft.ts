// The stored team the page holds (draft.ts): read for the save on screen, each member with its edits, and kept whenever
// The player changes it. It is worked out during the render, not in an effect, so the first render with a box (and the first
// sheet request) already has it. A new save (another path, or the same one saved again) reads again, so a changed save
// shows its own party; the same save sent again (a settings change) keeps the team, less the Pokémon that can no longer
// join. Empty while there is no box.
//
// When the same save file is saved again over a team the player had changed (not that save's party as it was), the team it
// replaced is held here, in memory only, and `replaced` offers one Undo: the old entries come back, each on its own
// Pokémon wherever the save moved it (followed by its key, the PID), checked against the save on screen. The next change
// to the team, or another save file, drops it.
//
// The editor's options (`GET /api/draft/options`: the items and the EXP tables) are asked for once. Without them the
// edits still work (an EXP and an item checked for shape only), and when they come the team is checked again by them.

import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import type { BoxJson, DraftMonJson, DraftOptionsJson, MonRef } from '../../src/server/apiTypes';
import { errorMessage, getDraftOptions } from './api';
import {
  added, allToCap, allToFull, baseline, canJoin, type DraftPatch, edited, fitted, MAX_TEAM, moved, movedTo, type Options, placed, readDraft,
  removed, tidy, writeDraft,
} from './draft';

export interface UseDraft {
  /** The team in order, the first leading. */
  team: MonRef[];
  /** Each member's entry (its edits), in the team's order. */
  mons: DraftMonJson[];
  /** What the editor offers (the items, the EXP tables); null while they load or when they did not. */
  options: DraftOptionsJson | null;
  /** Why the options did not load; null while they load or once they have. */
  optionsProblem: string | null;
  /** Asks for the options again. */
  retryOptions(): void;
  /** Puts `ref` last; nothing when the team is full or has it. */
  add(ref: MonRef): void;
  /** Takes `ref` out. */
  remove(ref: MonRef): void;
  /** Moves the member at `index` one place up (-1) or down (1). */
  move(index: number, by: -1 | 1): void;
  /**
   * Puts `ref` at `index` as one change (`placed`): a member moves there, a newcomer takes the slot (its occupant leaves)
   * or, at or past the end, goes last while the team has room. Nothing for a Pokémon not in the box or that cannot join.
   */
  place(index: number, ref: MonRef): void;
  /** Moves the member at `from` to `to` as one change (`movedTo`). */
  moveTo(from: number, to: number): void;
  /** Applies `patch` to `ref`'s entry (`edited`): null when it was taken, else why not in words, and nothing changes. */
  edit(ref: MonRef, patch: DraftPatch): string | null;
  /** `ref`'s entry back to the save's: `{ ref }`. */
  reset(ref: MonRef): void;
  /** The save's party in slot order with no edits (`baseline`). */
  resetAll(): void;
  /** Each member below the level cap raised to it (`allToCap`). */
  toCap(): void;
  /** Each member's HP set to its max HP (`allToFull`). */
  toFull(): void;
  /** While a save change has replaced a team the player had changed: `undo` brings that team back. */
  replaced: { undo(): void } | null;
}

/** An entry a save change replaced, with its Pokémon's key (`BoxMonJson.key`) in the box the team was worked out for. */
interface Stashed { key: string; entry: DraftMonJson }

/** The team, the box it was worked out for, and the team a save change replaced (null when there is none to undo). */
interface Held { box: BoxJson | null; team: DraftMonJson[]; replaced: Stashed[] | null }

/** `team`'s entries, each with the key of its Pokémon in `box`, the box the team was worked out for. */
function stashed(box: BoxJson, team: DraftMonJson[]): Stashed[] {
  const keys = new Map(box.mons.map((m) => [m.ref, m.key]));
  return team.flatMap((entry) => {
    const key = keys.get(entry.ref);
    return key === undefined ? [] : [{ key, entry }];
  });
}

const NOT_IN_TEAM = 'That Pokémon is not in the team.';

/** Whether two JSON values are the same: arrays item by item, objects key by key in any order. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const [x, y] = [a as Record<string, unknown>, b as Record<string, unknown>];
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((key) => Object.hasOwn(y, key) && same(x[key], y[key]));
}

/**
 * What is held for `box`, given what was held for the box before. Another save file, or the first box, reads its team
 * (`readDraft`) with nothing to undo. The same file saved again reads its team too; the team it replaces is kept to undo
 * (each entry with its Pokémon's key in the old box) when it was not that save's baseline, else an earlier one stays.
 * The same save sent again keeps the team, less what cannot join (the very same list when nobody drops out, so what
 * reads the team is not asked again).
 */
function heldFor(box: BoxJson | null, held: Held, options: Options): Held {
  if (box === null) return { box, team: [], replaced: null };
  const old = held.box;
  if (old === null || old.savePath !== box.savePath) return { box, team: readDraft(box, options), replaced: null };
  if (old.savedAt !== box.savedAt) {
    return { box, team: readDraft(box, options), replaced: same(held.team, baseline(old)) ? held.replaced : stashed(old, held.team) };
  }
  const joins = new Set(box.mons.filter(canJoin).map((m) => m.ref));
  const kept = held.team.filter((d) => joins.has(d.ref));
  return { box, team: kept.length === held.team.length ? held.team : kept, replaced: held.replaced };
}

export function useDraft(box: BoxJson | null): UseDraft {
  const [options, setOptions] = useState<Options>(null);
  const [optionsProblem, setOptionsProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [held, setHeld] = useState<Held>(() => ({ box, team: box === null ? [] : readDraft(box), replaced: null }));
  // A new box is taken in during this render: React renders again at once with it, before anything is shown. A change
  // below sets `current` as well, so a second change in the same event starts from the first.
  let current = held;
  if (box !== held.box) {
    current = heldFor(box, held, options);
    setHeld(current);
  }
  const take = (next: Held) => {
    current = next;
    setHeld(next);
    if (next.box !== null) writeDraft(next.box, next.team);
  };

  /** Takes `team` and drops the Undo; nothing when it is the team already. */
  const change = (team: DraftMonJson[]) => {
    if (current.box !== null && !same(team, current.team)) take({ box: current.box, team, replaced: null });
  };

  // The options came: the team is checked again by them (an EXP and an item were checked for shape only).
  const arrived = useEffectEvent((next: DraftOptionsJson) => {
    setOptions(next);
    setOptionsProblem(null);
    const { box: b, team } = current;
    if (b === null) return;
    const checked = fitted(b, next, team.map((d) => d.ref), team);
    if (!same(checked, team)) take({ ...current, team: checked });
  });
  useEffect(() => {
    let live = true;
    getDraftOptions().then(
      (next) => { if (live) arrived(next); },
      (e: unknown) => { if (live) setOptionsProblem(errorMessage(e)); },
    );
    return () => { live = false; };
  }, [attempt]);

  // The refs as one key, so an edit (a new list of the same refs) gives the very same `team`.
  const refs = current.team.map((d) => d.ref).join(' ');
  const team = useMemo(() => (refs === '' ? [] : refs.split(' ')), [refs]);

  /**
   * The held team in its order, each entry on its own Pokémon in the box on screen: the one with its key that can join
   * (the one still at its ref first, should two share a key), at that Pokémon's ref, checked against it (`tidy`). An entry
   * whose Pokémon is gone or cannot join is left out, and so is a second one for the same Pokémon; at most six.
   */
  const undo = () => {
    const { box: b, replaced } = current;
    if (b === null || replaced === null) return;
    const joins = b.mons.filter(canJoin);
    const back: DraftMonJson[] = [];
    for (const { key, entry } of replaced) {
      if (back.length === MAX_TEAM) break;
      const mon = joins.find((m) => m.key === key && m.ref === entry.ref) ?? joins.find((m) => m.key === key);
      if (mon !== undefined && !back.some((d) => d.ref === mon.ref)) back.push(tidy(mon, options, entry));   // tidy gives it mon's ref
    }
    take({ box: b, team: back, replaced: null });
  };

  return {
    team,
    mons: current.team,
    options,
    optionsProblem,
    retryOptions: () => {
      setOptionsProblem(null);
      setAttempt((n) => n + 1);
    },
    add: (ref) => change(added(current.team, ref)),
    remove: (ref) => change(removed(current.team, ref)),
    move: (index, by) => change(moved(current.team, index, by)),
    place: (index, ref) => {
      if (current.box?.mons.some((m) => m.ref === ref && canJoin(m))) change(placed(current.team, index, ref));
    },
    moveTo: (from, to) => change(movedTo(current.team, from, to)),
    edit: (ref, patch) => {
      const mon = current.box?.mons.find((m) => m.ref === ref);
      const entry = current.team.find((d) => d.ref === ref);
      if (mon === undefined || entry === undefined || !canJoin(mon)) return NOT_IN_TEAM;
      const result = edited(mon, options, entry, patch);
      if (result.problem === null) change(current.team.map((d) => (d === entry ? result.entry : d)));
      return result.problem;
    },
    reset: (ref) => change(current.team.map((d) => (d.ref === ref ? { ref } : d))),
    resetAll: () => { if (current.box !== null) change(baseline(current.box)); },
    toCap: () => { if (current.box !== null) change(allToCap(current.box, options, current.team)); },
    toFull: () => { if (current.box !== null) change(allToFull(current.box, options, current.team)); },
    replaced: current.replaced === null ? null : { undo },
  };
}
