// The hack's pinch items with hold-effect parameter 0 (Ganlon Berry, Apicot Berry, Shoal Salt). The check is
// `curHP <= maxHP / itemPower`, and the hack's u32 division (`_u32_div_f`) returns the dividend for a divisor of 0
// (docs/engine-spot-checks.md), so they work at any HP: at each switch-in, after each move and at the end of the turn.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BattleInput, Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import { createBattle, restore, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import * as engine from '../../../src/engine/index.js';
import { ABILITY, BAG, fixtureDex, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const base = fixtureDex();
beforeAll(() => installKaizoDex(base.data, base.moves));
afterAll(() => installKaizoDex(base.data, base.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH_FIRST = { p1: move(0), p2: move(0) };
const foe = (outcome: Outcome | EngineState) => restore('state' in outcome ? outcome.state : outcome).p2.active[0]!;
const mine = (outcome: Outcome | EngineState) => restore('state' in outcome ? outcome.state : outcome).p1.active[0]!;
function changed(state: EngineState, change: (battle: Battle) => void): EngineState {
  const battle = restore(state);
  change(battle);
  return snapshot(battle);
}
const duel = (playerMoves: number[], theirs: ReturnType<typeof resolvedMon>, fields: Partial<ReturnType<typeof playerMon>> = {}): BattleInput => ({
  player: [playerMon(ID.monferno, 30, playerMoves, fields)], trainer: resolvedTrainer(BAG.none, [theirs]), field: {},
});
const deoxys = (moves: number[], item: number) => resolvedMon(ID.deoxys, 50, moves, { item });
const zigzagoon = (moves: number[], item: number) => resolvedMon(ID.zigzagoon, 20, moves, { item });
const eaten = (log: readonly string[], who: string, name: string): number => log.findIndex((line) => line.startsWith(`|-enditem|${who}|${name}`));
const moveAt = (log: readonly string[], who: string): number => log.findIndex((line) => line.startsWith(`|move|${who}|`));

const ITEMS: [number, string, 'def' | 'spd' | 'atk'][] = [[ITEM.ganlonBerry, 'Ganlon Berry', 'def'], [ITEM.apicotBerry, 'Apicot Berry', 'spd'], [ITEM.shoalSalt, 'Shoal Salt', 'atk']];

describe('Ganlon Berry, Apicot Berry and Shoal Salt (parameter 0)', () => {
  it.each(ITEMS)('item %i (%s) is eaten at entry, at full HP, by both leads (bl:4152-4160), raising its stat by one; nothing is unmodelled', (item, name, stat) => {
    const start = createBattle(duel([ID.growl], deoxys([ID.growl], item), { item }));
    expect(foe(start).hp).toBe(foe(start).maxhp);
    for (const holder of [foe(start), mine(start)]) expect([holder.item, holder.boosts[stat]]).toEqual(['', 1]);
    expect(engine.battleStartLog(start).filter((line) => line.startsWith('|-enditem|') && line.split('|')[3] === name)).toHaveLength(2);
    expect(engine.unmodelledIn(createBattle(duel([ID.growl], deoxys([ID.growl], item))))).toEqual([]);
  });

  it('stays under Klutz, and with the stat at +6 (the check needs it below MAX_STAT_STAGE)', () => {
    expect(foe(createBattle({ ...duel([ID.growl], deoxys([ID.growl], ITEM.ganlonBerry)), world: { enemy: [{ ability: ABILITY.klutz }] } })).item).toBe('ganlonberry');
    const capped = changed(createBattle(duel([ID.growl], deoxys([ID.growl], 0))), (battle) => {
      battle.p2.active[0]!.boosts.def = 6;
      battle.p2.active[0]!.setItem('ganlonberry');
    });
    for (const outcome of expandTurn(capped, BOTH_FIRST)) expect(foe(outcome).item).toBe('ganlonberry');
  });

  it('is checked for every battler after a move, whoever it targeted: an item got mid-battle goes right after the first move', () => {
    // The faster Monferno Howls on itself; the slower Zigzagoon eats before it moves.
    const outcomes = expandTurn(changed(createBattle(duel([ID.howl], zigzagoon([ID.growl], 0))), (battle) => { battle.p2.active[0]!.setItem('ganlonberry'); }), BOTH_FIRST);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      const at = eaten(outcome.log, 'p2a: Zigzagoon', 'Ganlon Berry');
      expect(at).toBeGreaterThan(moveAt(outcome.log, 'p1a: Monferno'));
      expect(at).toBeLessThan(moveAt(outcome.log, 'p2a: Zigzagoon'));
      expect(foe(outcome).boosts.def).toBe(1);
    }
  });

  it('is checked at the `MoveEnd` of a move its user couldn\'t make: both fully paralysed, both berries go after the first `cant` (bcp:2660, :3973)', () => {
    const start = changed(createBattle(duel([ID.howl], zigzagoon([ID.howl], 0))), (battle) => {
      for (const holder of [battle.p1.active[0]!, battle.p2.active[0]!]) {
        expect(holder.setStatus('par')).toBe(true);
        holder.setItem('apicotberry');
      }
    });
    const outcomes = expandTurn(start, BOTH_FIRST).filter((outcome) => outcome.log.includes('|cant|p1a: Monferno|par') && outcome.log.includes('|cant|p2a: Zigzagoon|par'));
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      for (const who of ['p1a: Monferno', 'p2a: Zigzagoon']) {
        expect(eaten(outcome.log, who, 'Apicot Berry'), who).toBeGreaterThan(outcome.log.indexOf('|cant|p1a: Monferno|par'));
        expect(eaten(outcome.log, who, 'Apicot Berry'), who).toBeLessThan(outcome.log.indexOf('|cant|p2a: Zigzagoon|par'));
      }
      expect([mine(outcome).boosts.spd, foe(outcome).boosts.spd]).toEqual([1, 1]);
    }
  });

  it('with the ROM saying 4, Ganlon works at a quarter of the max HP and not above it, and Gluttony halves the power to 2', () => {
    const alt = fixtureDex();
    alt.data.rom.items[202] = { ...alt.data.rom.items[202]!, holdEffect: 37, holdParam: 4 };
    installKaizoDex(alt.data, alt.moves);
    try {
      const eatenAt = (share: number, extra: number, theirs: ReturnType<typeof resolvedMon>) => expandTurn(changed(createBattle(duel([ID.growl], theirs)), (battle) => {
        battle.p2.active[0]!.hp = Math.floor(battle.p2.active[0]!.maxhp / share) + extra;
      }), BOTH_FIRST).every((outcome) => foe(outcome).item === '');
      const plain = deoxys([ID.growl], ITEM.ganlonBerry);
      const gluttonous = { ...zigzagoon([ID.growl], ITEM.ganlonBerry), ability: knownAbility(ABILITY.gluttony) };
      expect([eatenAt(4, 0, plain), eatenAt(4, 1, plain), eatenAt(2, 0, gluttonous), eatenAt(2, 1, gluttonous)]).toEqual([true, false, true, false]);
    } finally {
      installKaizoDex(base.data, base.moves);
    }
  });
});
