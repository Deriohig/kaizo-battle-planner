// A whole team as Showdown import text, for PKCalc's Import box: each Pokémon's set (the server's `showdown`), one
// blank line between sets, as Showdown's own team export writes them. The sheet copies the trainer's team and yours;
// the box copies the party or a box.

import type { BoxMonJson } from '../../src/server/apiTypes';

/** What goes between two sets: one blank line. */
const SET_SEPARATOR = '\n\n';

/** The non-null `sets`, in order, one blank line between them; an empty string when there are none. */
export function teamText(sets: readonly (string | null)[]): string {
  return sets.filter((set): set is string => set !== null).join(SET_SEPARATOR);
}

/** `teamText` over the `mons` that are not eggs (no `'egg'` reason), in the order given. */
export function boxTeamText(mons: readonly Pick<BoxMonJson, 'showdown' | 'ineligibleReasons'>[]): string {
  return teamText(mons.filter((m) => !m.ineligibleReasons.includes('egg')).map((m) => m.showdown));
}
