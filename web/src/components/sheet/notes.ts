// A pair's note lines, and the ones every pair of one of theirs repeats: those print once in that
// enemy's header instead of under each pair. Lines match by exact text; a pair the sheet has no matchup for is not one.

import type { SheetPairJson } from '../../../../src/server/apiTypes';

export const MAY_PERSIST_NOTE = 'Weather may persist: another Pokémon in this battle can set weather, which may still be up when this pair meets; these numbers leave it out';
export const SHARED_PREFIX = 'Applies to every pair here: ';

export interface NoteLine { text: string; warn: boolean }

/** The may-persist line first (a warning), then the pair's own notes. */
export function pairNotes(pair: SheetPairJson): NoteLine[] {
  return [
    ...(pair.weatherMayPersist ? [{ text: MAY_PERSIST_NOTE, warn: true }] : []),
    ...pair.notes.map((text) => ({ text, warn: false })),
  ];
}

/** `shared`: the lines every pair has, in the first pair's order (none with fewer than 2 pairs); `own`: a pair's other lines. */
export function splitNotes(pairs: readonly SheetPairJson[]): { shared: NoteLine[]; own(pair: SheetPairJson): NoteLine[] } {
  const lines = pairs.map(pairNotes);
  const shared = pairs.length < 2 ? [] : (lines[0] ?? []).filter((line, index, all) =>
    all.findIndex((other) => other.text === line.text) === index && lines.every((set) => set.some((other) => other.text === line.text)));
  const sharedTexts = new Set(shared.map((line) => line.text));
  return { shared, own: (pair) => pairNotes(pair).filter((line) => !sharedTexts.has(line.text)) };
}
