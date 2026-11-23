// The drag contract for a Pokémon: the box tray and the team slots write it, any drop target reads it. The
// payload is `JSON.stringify(ref)` under one MIME type, so a file, text or link dragged in from outside the page reads as
// no Pokémon. Both readers take a DOM or a React drag event, as only `dataTransfer` is used.

import type { MonRef } from '../../src/server/apiTypes';

/** The drag type a carried Pokémon travels under. */
export const MON_DRAG_TYPE = 'application/x-pkp-mon';
/** The same type under its first name. */
export const MON_MIME = MON_DRAG_TYPE;

/** The part of a drag event the contract uses. */
export interface DragLike { dataTransfer: DataTransfer | null }

const REF = /^(party:\d+|box:\d+:\d+)$/;

/** Starts carrying `ref`: sets the data and says the drag moves. */
export function writeDraggedMon(e: DragLike, ref: MonRef): void {
  if (e.dataTransfer === null) return;
  e.dataTransfer.setData(MON_DRAG_TYPE, JSON.stringify(ref));
  e.dataTransfer.effectAllowed = 'move';
}

/** The ref being carried, or null for anything else (no data, foreign data, junk, a string that is not a ref). Only in `drop`: `dragover` cannot read it. */
export function readDraggedMon(e: DragLike): MonRef | null {
  try {
    const text = e.dataTransfer?.getData(MON_DRAG_TYPE);
    if (text === undefined || text === '') return null;
    const value: unknown = JSON.parse(text);
    return typeof value === 'string' && REF.test(value) ? (value as MonRef) : null;
  } catch {
    return null;
  }
}

/** Whether a Pokémon is being carried: its type is on the drag. For `dragover` and `dragenter`, where the data cannot be read. */
export function carriesMon(e: DragLike): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes(MON_DRAG_TYPE);
}
