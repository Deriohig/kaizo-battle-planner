// The first matchup of a team member for the start screen: his Pokémon against the trainer's first, read from the sheet
// the page already has, so the start screen can say who goes first (in `speedOrderText`'s words) and whether it can be KO'd in one hit before a tree is
// started. It is Matchups' own reading of the pair (SheetView's `koView(move).oneHit`), not a second calculation.

import type { MonRef, SheetJson, SheetMoveJson } from '../../../../src/server/apiTypes';

/** loading: the sheet is not there for this fight yet, or has no pair for him; none: the sheet did not load. */
export type FirstMatchup =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'ready'; enemy: string; order: 'player' | 'enemy' | 'tie' | 'depends'; playerSpeed: number; enemySpeed: number; canKoInOne: boolean };

/**
 * Whether `move` has a real chance to KO in one use: its damage is bounded and its one-use KO chance is above 0 (an OHKO
 * move also needs a hit chance above 0). A move nothing bounds is not counted, as in Matchups.
 */
function koInOne(move: SheetMoveJson): boolean {
  const { damage } = move;
  if (damage === null || !damage.bounded || damage.koExact === null) return false;
  const one = damage.koExact.find((figure) => figure.hits === 1);
  if (one === undefined || one.num === '0') return false;
  return damage.ohko ? move.hitChance > 0 : true;
}

/**
 * `ref` against the first of the trainer's Pokémon on `sheet`. None when the sheet did not load (`sheetError`); loading
 * when the sheet is not there, is another trainer copy's, has no enemies or has no pair for `ref` and that Pokémon yet.
 * With `shown`, the figures the row shows for `ref`: a sheet whose player of that key has other ones is one the draft has
 * outrun, so it is loading too.
 */
export function firstMatchup(
  sheet: SheetJson | null, sheetError: string | null, fight: { trainerId: string; variant: number }, ref: MonRef,
  shown?: { level: number; hp: number; maxHp: number },
): FirstMatchup {
  if (sheetError !== null) return { state: 'none' };
  if (sheet === null || sheet.trainer.id !== fight.trainerId || sheet.trainer.variant !== fight.variant) return { state: 'loading' };
  const first = sheet.enemies[0];
  const pair = first === undefined ? undefined : sheet.pairs.find((p) => p.player === ref && p.enemy === first.key);
  if (first === undefined || pair === undefined) return { state: 'loading' };
  if (shown !== undefined) {
    const player = sheet.players.find((p) => p.key === ref);
    if (player === undefined || player.level !== shown.level || player.hp !== shown.hp || player.stats.hp !== shown.maxHp) return { state: 'loading' };
  }
  return {
    state: 'ready', enemy: first.name, order: pair.order, playerSpeed: pair.playerSpeed, enemySpeed: pair.enemySpeed,
    canKoInOne: pair.enemyMoves.some(koInOne),
  };
}
