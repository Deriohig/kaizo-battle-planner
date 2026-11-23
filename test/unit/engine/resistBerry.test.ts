// A resist berry and what reads the damage: the cartridge caps the damage (False Swipe, Endure, the Focus items) and
// records it (Bide, Counter, Mirror Coat, Metal Burst, Shell Bell) before the berry halves the HP change (bcp:3381-3433,
// subscript_type_resist_berry.s:111). The engine halves in the formula, so a hit where the order shows is noted.

import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { BattleInput, Choice, Outcome } from '../../../src/contracts/engine.js';
import { createBattle, restore, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { unmodelledIn } from '../../../src/engine/facts.js';
import { RESIST_BERRY_NOTE } from '../../../src/engine/mod/scripts.js';
import { BAG, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH_FIRST = { p1: move(0), p2: move(0) };
const duel = (mine: PlayerMon, theirs: ResolvedMon): BattleInput => ({ player: [mine], trainer: resolvedTrainer(BAG.none, [theirs]), field: {} });
const has = (outcome: Outcome, prefix: string): boolean => outcome.log.some((line) => line.startsWith(prefix));
const OCCA_BERRY = 184;
const CHILAN_BERRY = 200;

describe('a resist berry and what reads the damage (bcp:3381-3433)', () => {
  /** The outcomes of `mine` holding `berry` against `theirs` in which the berry was eaten, whether each is noted. */
  const noted = (mine: PlayerMon, theirs: ResolvedMon, line: string) => {
    const eaten = expandTurn(createBattle(duel(mine, theirs)), BOTH_FIRST).filter((outcome) => has(outcome, line));
    expect(eaten.length).toBeGreaterThan(0);
    return [...new Set(eaten.map((outcome) => unmodelledIn(outcome.state).includes(RESIST_BERRY_NOTE)))];
  };
  it.each<[string, () => PlayerMon, () => ResolvedMon, string, boolean]>([
    ['a halving after False Swipe\'s cap is noted', () => playerMon(ID.zigzagoon, 10, [ID.growl], { item: CHILAN_BERRY }), () => resolvedMon(ID.deoxys, 50, [ID.falseSwipe]),
      '|-enditem|p1a: Zigzagoon|Chilan Berry', true],
    ['so is one on a holder that knows Counter', () => playerMon(ID.tropius, 30, [ID.counter], { item: OCCA_BERRY }), () => resolvedMon(ID.monferno, 30, [ID.ember]),
      '|-enditem|p1a: Tropius|Occa Berry', true],
    ['a holder with no such move is not', () => playerMon(ID.tropius, 30, [ID.growl], { item: OCCA_BERRY }), () => resolvedMon(ID.monferno, 30, [ID.ember]),
      '|-enditem|p1a: Tropius|Occa Berry', false],
  ])('%s', (_, mine, theirs, line, expected) => expect(noted(mine(), theirs(), line)).toEqual([expected]));
});

describe('the berry script on HP changes besides the hit (subscript_update_hp.s:5-10)', () => {
  // Every HP loss in a move but the hit and a confusion self-hit skips the berry script, and the end of the turn has no
  // battler waiting (:9). The self-hit runs it, and only the Chilan Berry can work there (no move type yet): when the
  // confused battler's chosen move is Normal. The battlers waiting include the one acting (bcp:881-885, :3989).
  const confused = (moves: number[], item: number, foeLevel: number) => {
    const battle = restore(createBattle(duel(playerMon(ID.monferno, 30, moves, { item }), resolvedMon(ID.zigzagoon, foeLevel, [ID.growl]))));
    battle.p1.active[0]!.addVolatile('confusion');
    const start = snapshot(battle);
    const selfHits = expandTurn(start, BOTH_FIRST).filter((outcome) => has(outcome, '|-damage|p1a: Monferno|') && outcome.log.some((line) => line.includes('[from] confusion')));
    expect(selfHits.length).toBeGreaterThan(0);
    const lost = (outcome: Outcome) => restore(start).p1.active[0]!.hp - restore(outcome.state).p1.active[0]!.hp;
    return { selfHits, losses: [...new Set(selfHits.map(lost))].sort((a, b) => a - b) };
  };

  // At level 60 the foe moves first, so Monferno's self-hit comes with only its own action left: the count is 1, not 0.
  it.each([['moves first', 20], ['moves last', 60]])('a Chilan Berry halves the self-hit of a Normal move\'s user that %s, and is used up', (_, foeLevel) => {
    const plain = confused([ID.tackle], 0, foeLevel as number);
    const chilan = confused([ID.tackle], CHILAN_BERRY, foeLevel as number);
    for (const outcome of chilan.selfHits) {
      expect(has(outcome, '|-enditem|p1a: Monferno|Chilan Berry')).toBe(true);
      if (foeLevel === 60) {
        const at = (prefix: string) => outcome.log.findIndex((line) => line.startsWith(prefix));
        expect(at('|move|p2a: Zigzagoon|')).toBeGreaterThanOrEqual(0);
        expect(at('|move|p2a: Zigzagoon|')).toBeLessThan(at('|-activate|p1a: Monferno|confusion'));
      }
    }
    expect(chilan.losses).toEqual([...new Set(plain.losses.map((loss) => Math.max(1, Math.trunc(loss / 2))))]);
  });

  it('not with a move of another type', () => {
    for (const outcome of confused([ID.ember], CHILAN_BERRY, 20).selfHits) expect(has(outcome, '|-enditem|p1a: Monferno|Chilan Berry')).toBe(false);
  });
});
