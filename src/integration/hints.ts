// Search-order hints from the calc's numbers (docs/solver-integration.md section 7): which of the player's choices to try
// first, and which teams. Both only reorder: the hint returns every choice it was given, and the team score never drops
// a team. Unbounded damage (`bounded: false`), a 'depends' or 'tie' order and the like count for nothing here.

import type { KaizoMove } from '../battle/moves.js';
import type { PlayerMon } from '../battle/playerMon.js';
import { hitChance } from '../calc/accuracy.js';
import { type CalcField, type CalcSide, damage } from '../calc/calc.js';
import type { Choice } from '../contracts/engine.js';
import type { MonRef } from '../contracts/solver.js';
import { buildSheet, type SheetMoveCell, type SheetPair } from '../sheet/sheet.js';
import type { FightInfo, OrderHint } from '../solver/types.js';
import { type Active, activeOf, type BattleContext, battleOf, buildLookups, fieldOf, type Lookups, memberOf, requestMoveId } from './battleView.js';

const CACHE_LIMIT = 20_000;

/** How promising one move is against a defender: its chance to KO in one use, plus half its share of the HP left, times its accuracy. */
function moveScore(attacker: CalcSide, defender: CalcSide, move: KaizoMove | undefined, field: CalcField): number {
  if (move === undefined) return 0;
  const result = damage(attacker, defender, move, field);
  if (result === null || !result.bounded) return 0;
  const hp = Math.max(1, defender.curHp ?? 1);
  const mean = result.rolls.reduce((sum, roll) => sum + roll, 0) / result.rolls.length;
  const ko = result.koChance?.[0]?.chance ?? 0;
  return hitChance(attacker, defender, move, field) * (ko + 0.5 * Math.min(1, mean / hp));
}

/** A party member's best move score against `foe`. */
function memberScore(member: Active, foe: Active, field: CalcField, moves: ReadonlyMap<number, KaizoMove>): number {
  return Math.max(0, ...member.calc.mon.moves.map((id) => moveScore(member.calc, foe.calc, moves.get(id), field)));
}

/**
 * The order hint: at a turn choice, the player's moves by `moveScore` against the foe (switches after them, in their own
 * order); at a mid-turn switch, the bench by its best move's score. Ties and anything the view cannot describe keep the
 * order given. Scores are cached by state key.
 */
export function createOrderHint(ctx: BattleContext): OrderHint {
  let lookups: Lookups | null = null;
  const cache = new Map<string, Map<string, number>>();

  function scores(state: Parameters<OrderHint>[0], choices: Choice[]): Map<string, number> {
    const look = (lookups ??= buildLookups(ctx.moves));
    const out = new Map<string, number>();
    const { battle, trainer } = battleOf(state, ctx);
    const foe = activeOf(battle, trainer, 'p2', ctx, look);
    if (foe === null) return out;
    const me = activeOf(battle, trainer, 'p1', ctx, look);
    for (const choice of choices) {
      let score = 0;
      if (choice.kind === 'move' && me !== null) {
        const field = fieldOf(battle, me, foe);
        const id = requestMoveId(battle, 'p1', choice.slot);
        if (field !== null && id !== undefined) score = 1 + moveScore(me.calc, foe.calc, look.byId.get(id), field);
      } else if (choice.kind === 'switch') {
        const member = memberOf(battle, trainer, 'p1', choice.index, ctx, look);
        const field = member === null ? null : fieldOf(battle, member, foe);
        if (member !== null && field !== null) score = memberScore(member, foe, field, ctx.moves) / 2;
      }
      out.set(JSON.stringify(choice), score);
    }
    return out;
  }

  return (state, choices) => {
    if (state.phase.kind !== 'turnChoice' && state.phase.kind !== 'playerMidTurnSwitch') return choices;
    let known = cache.get(state.key);
    if (known === undefined || choices.some((c) => !known!.has(JSON.stringify(c)))) {
      known = scores(state, choices);
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(state.key, known);
    }
    const score = (c: Choice) => known!.get(JSON.stringify(c)) ?? 0;
    return choices.map((choice, index) => ({ choice, index })).sort((a, b) => score(b.choice) - score(a.choice) || a.index - b.index).map((x) => x.choice);
  };
}

/** How well `pair`'s player Pokémon handles its enemy: its best move's KO odds over two uses, a bonus for surely moving first, less the enemy's best one-use KO odds. */
function pairScore(pair: SheetPair): number {
  const odds = (cell: SheetMoveCell, uses: number) => (cell.result?.bounded ? (cell.result.koChance?.[uses - 1]?.chance ?? 0) * cell.hitChance : 0);
  const offence = Math.max(0, ...pair.playerMoves.map((cell) => odds(cell, 1) + 0.5 * odds(cell, 2)));
  const threat = Math.max(0, ...pair.enemyMoves.map((cell) => odds(cell, 1)));
  return offence + (pair.order === 'player' ? 0.25 : 0) - (pair.order === 'player' ? 0.5 : 1) * threat;
}

/**
 * The team score: over the fights and each enemy Pokémon, the best pair score of a team member against it (from the
 * matchup sheet, one sheet per Pokémon and fight, cached). Higher is more promising. A ref with no Pokémon scores nothing.
 */
export function createTeamScore(mons: ReadonlyMap<MonRef, PlayerMon>, moves: ReadonlyMap<number, KaizoMove>): (team: MonRef[], fights: FightInfo[]) => number {
  const cache = new Map<string, number[]>();
  /** Per enemy index, `ref`'s pair score against it in `fight`. */
  function against(ref: MonRef, fight: FightInfo): number[] {
    const key = `${ref}|${fight.trainer.romIndex}`;
    let row = cache.get(key);
    if (row === undefined) {
      const mon = mons.get(ref);
      row = mon === undefined ? [] : buildSheet([mon], fight.trainer, { moves }).pairs.map(pairScore);
      cache.set(key, row);
    }
    return row;
  }
  return (team, fights) => {
    let total = 0;
    for (const fight of fights) {
      const rows = team.map((ref) => against(ref, fight));
      for (let enemy = 0; enemy < fight.trainer.party.length; enemy++) {
        total += Math.max(-1, ...rows.map((row) => row[enemy] ?? -1));
      }
    }
    return total;
  };
}
