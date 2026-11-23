// The hidden Quick Claw roll is drawn where the cartridge draws `speedRand` (after the turn's order, bcp:853-858; at the
// battle start, bl:2024), so the trainer AI reads at each turn choice the value the cartridge holds then (`quickClawRolls`).

import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import { createBattle, restore, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { BATTLE_START_CHANCE_NOTE, quickClawRolls, unmodelledIn } from '../../../src/engine/index.js';
import { add, eq, mul, ONE, rat, type Rational, ZERO } from '../../../src/engine/rational.js';
import { ABILITY, BAG, emberTurn, fixtureDex, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const QUICK_CLAW = rat(13108, 65536); // speedRand % 5 == 0
const move = (slot: number): Choice => ({ kind: 'move', slot });
const swap = (index: number): Choice => ({ kind: 'switch', index });
const BOTH_FIRST = { p1: move(0), p2: move(0) };
const chanceOf = (outcomes: Outcome[], test: (outcome: Outcome) => boolean): Rational =>
  outcomes.filter(test).reduce((sum, outcome) => add(sum, outcome.probability), ZERO);
const firstMover = (outcome: Outcome) => outcome.log.find((line) => line.startsWith('|move|'))!.slice(6, 9);
/** Whose end-of-turn poison ran first: `monSpeedOrder`. */
const firstPoisoned = (outcome: Outcome) => outcome.log.find((line) => line.startsWith('|-damage|') && line.endsWith('|[from] psn'))!.slice(9, 12);
const quickClawLabels = (outcomes: Outcome[]) => outcomes.flatMap((outcome) => outcome.labels.filter((label) => label.kind === 'quickClaw'));
const rollSides = (state: EngineState) => Object.keys(quickClawRolls(state)).sort();

function battle(player: PlayerMon[], enemy: ResolvedMon[], poisonEnemy = false): EngineState {
  const start = createBattle({ player, trainer: resolvedTrainer(BAG.none, enemy), field: {} });
  if (!poisonEnemy) return start;
  const restored = restore(start);
  expect(restored.p2.active[0]!.setStatus('psn')).toBe(true);
  return snapshot(restored);
}
/** Mean Look draws nothing (+1 for both), so the only chances are the speed order's. */
const meanLooker = (species: number, level: number, item = 0) => resolvedMon(species, level, [ID.meanLook], { item });
const monferno = (fields: Partial<PlayerMon> = {}, moves: number[] = [ID.meanLook]) => playerMon(ID.monferno, 30, moves, fields);
/** Every outcome of a mid-turn switch after each of `root`'s outcomes, weighted by both steps. */
function throughSwitch(root: EngineState, choice: { p1?: Choice; p2?: Choice }, phase: string): Outcome[] {
  return expandTurn(root, BOTH_FIRST).flatMap((mid) => {
    expect(mid.state.phase).toEqual({ kind: phase });
    const after = expandTurn(mid.state, choice);
    expect(eq(chanceOf(after, () => true), ONE)).toBe(true);
    return after.map((outcome) => ({ ...outcome, probability: mul(mid.probability, outcome.probability) }));
  });
}
/** The redraw on a restore of `state` with old rolls `old`: what the turn-start queue sort leaves. */
const redraw = (state: EngineState, old: Record<string, boolean>) => {
  const restored = restore(state);
  restored.formatData['kaizoSpeedRand'] = old;
  restored.queue.list.length = 0;
  restored.speedSort(restored.queue.list);
  return restored.formatData['kaizoSpeedRand'];
};

describe('the Quick Claw roll at the cartridge\'s draw point', () => {
  it('a roll is stored at every turn choice for each side with a holder out; the root holds none (its draw changes nothing)', () => {
    const root = battle([monferno({ item: ITEM.quickClaw })], [meanLooker(ID.zigzagoon, 20, ITEM.quickClaw)]);
    expect(quickClawRolls(root)).toEqual({});
    expect(unmodelledIn(root)).not.toContain(BATTLE_START_CHANCE_NOTE);
    let frontier = [root];
    for (let turn = 1; turn <= 3; turn++) {
      const outcomes = frontier.flatMap((state) => expandTurn(state, BOTH_FIRST));
      for (const outcome of outcomes) {
        expect(outcome.state.phase, `turn ${turn}`).toEqual({ kind: 'turnChoice' });
        expect(Object.values(quickClawRolls(outcome.state)).map((roll) => typeof roll)).toEqual(['boolean', 'boolean']);
        expect(rollSides(outcome.state)).toEqual(['p1', 'p2']);
      }
      // The stored roll is the redraw's: true for 13108 of the 65536 draws, on each side.
      if (turn === 1) for (const side of ['p1', 'p2'] as const) expect(chanceOf(outcomes, (outcome) => quickClawRolls(outcome.state)[side] === true)).toEqual(QUICK_CLAW);
      frontier = [...new Map(outcomes.map((outcome) => [outcome.state.key, outcome.state])).values()];
    }
  });

  it('no holder, no draw: no quickClaw labels and quickClawRolls is {}', () => {
    const root = createBattle(emberTurn());
    const outcomes = [root, ...expandTurn(root, BOTH_FIRST).map((outcome) => outcome.state)].flatMap((state) => (state.phase.kind === 'turnChoice' ? expandTurn(state, BOTH_FIRST) : []));
    expect(quickClawLabels(outcomes)).toEqual([]);
    for (const state of [root, ...outcomes.map((outcome) => outcome.state)]) expect(quickClawRolls(state)).toEqual({});
  });

  it('the holder moves first this turn and next for 13108 / 65536 (slower) and 19661 / 32768 (a tie)', () => {
    const firstNextTurn = (root: EngineState): Rational => expandTurn(root, BOTH_FIRST).reduce(
      (sum, outcome) => add(sum, mul(outcome.probability, chanceOf(expandTurn(outcome.state, BOTH_FIRST), (later) => firstMover(later) === 'p2a'))), ZERO);
    for (const [foeMon, odds] of [[meanLooker(ID.zigzagoon, 20, ITEM.quickClaw), QUICK_CLAW], [meanLooker(ID.monferno, 30, ITEM.quickClaw), rat(19661, 32768)]] as const) {
      const root = battle([monferno()], [foeMon]);
      expect([chanceOf(expandTurn(root, BOTH_FIRST), (outcome) => firstMover(outcome) === 'p2a'), firstNextTurn(root)]).toEqual([odds, odds]);
    }
  });

  it('a holder that comes in after the draw point gets the roll lazily at the first read, and keeps it', () => {
    // The player's Monferno U-turns into a Quick Claw Zigzagoon; both sides poisoned, the end of turn's monSpeedOrder reads it.
    const poisoned = { status: { kind: 'poison' } } as const;
    const root = battle([monferno(poisoned, [ID.uTurn]), playerMon(ID.zigzagoon, 20, [ID.meanLook], { ...poisoned, item: ITEM.quickClaw })], [meanLooker(ID.monferno, 30)], true);
    expect(quickClawLabels(expandTurn(root, BOTH_FIRST))).toEqual([]); // no holder out at the redraw
    const lazy = throughSwitch(root, { p1: swap(1) }, 'playerMidTurnSwitch');
    expect(chanceOf(lazy, (outcome) => firstPoisoned(outcome) === 'p1a')).toEqual(QUICK_CLAW);
    for (const outcome of lazy) expect([outcome.state.phase.kind, quickClawRolls(outcome.state)]).toEqual(['turnChoice', { p1: firstPoisoned(outcome) === 'p1a' }]);
  });

  it('with nothing reading it, a newcomer\'s roll is drawn by the next turn choice', () => {
    const outcomes = throughSwitch(battle([monferno()], [resolvedMon(ID.monferno, 30, [ID.uTurn]), meanLooker(ID.zigzagoon, 20, ITEM.quickClaw)]), { p2: swap(1) }, 'enemyMidTurnSwitch');
    for (const outcome of outcomes) expect([outcome.state.phase.kind, rollSides(outcome.state)]).toEqual(['turnChoice', ['p2']]);
    expect(chanceOf(outcomes, (outcome) => quickClawRolls(outcome.state).p2 === true)).toEqual(QUICK_CLAW);
    expect(quickClawLabels(outcomes).every((label) => label.side === 'p2' && label.source === 'quickclaw')).toBe(true);
  });

  it('a holder switching out by choice leaves no roll: different commands compare nothing', () => {
    const outcomes = expandTurn(battle([monferno()], [meanLooker(ID.zigzagoon, 20, ITEM.quickClaw), meanLooker(ID.zigzagoon, 20)]), { p1: move(0), p2: swap(1) });
    expect(quickClawLabels(outcomes)).toEqual([]);
    for (const outcome of outcomes) expect(quickClawRolls(outcome.state)).toEqual({});
  });

  it('a roll nothing can read before the redraw stays through the mid-turn switch, and is dropped at the turn\'s end', () => {
    const root = battle([monferno()], [resolvedMon(ID.zigzagoon, 20, [ID.uTurn], { item: ITEM.quickClaw }), meanLooker(ID.zigzagoon, 20)]);
    const mids = expandTurn(root, BOTH_FIRST);
    for (const mid of mids) expect([mid.state.phase.kind, rollSides(mid.state)]).toEqual(['enemyMidTurnSwitch', ['p2']]);
    const ends = mids.flatMap((mid) => expandTurn(mid.state, { p2: swap(1) }));
    for (const end of ends) expect(quickClawRolls(end.state)).toEqual({});
    expect(new Set(ends.map((end) => end.state.key)).size).toBeLessThan(new Set(mids.map((mid) => mid.state.key)).size);
  });

  it('the redraw follows the turn-start queue sort whatever the queue holds: old rolls go, a holder draws anew', () => {
    const state = battle([monferno()], [meanLooker(ID.zigzagoon, 20, ITEM.quickClaw)]);
    expect(restore(state).midTurn).toBe(false);
    expect(redraw(state, { p1: true, p2: false })).toEqual({ p2: true }); // the driver's first option: it activates
  });

  it('a Klutz holder (no item, bl:5352-5363) is skipped at the redraw and pruned at the turn\'s end', () => {
    const klutz = monferno({ item: ITEM.quickClaw, ability: knownAbility(ABILITY.klutz) });
    const root = battle([klutz], [meanLooker(ID.zigzagoon, 20, ITEM.quickClaw)]);
    expect(redraw(root, { p1: true, p2: false })).toEqual({ p2: true });
    const turn = expandTurn(root, BOTH_FIRST);
    expect(quickClawLabels(turn).length).toBeGreaterThan(0);
    expect(quickClawLabels(turn).every((label) => label.side === 'p2')).toBe(true);
    for (const outcome of turn) expect(rollSides(outcome.state)).toEqual(['p2']);
    // A roll the Klutz slot holds mid-turn (written by hand) goes at the turn's end; the trainer's incoming holder gets one.
    for (const mid of expandTurn(battle([klutz], [resolvedMon(ID.monferno, 30, [ID.uTurn]), meanLooker(ID.zigzagoon, 20, ITEM.quickClaw)]), BOTH_FIRST)) {
      expect(mid.state.phase).toEqual({ kind: 'enemyMidTurnSwitch' });
      const midBattle = restore(mid.state);
      midBattle.formatData['kaizoSpeedRand'] = { p1: true };
      const withRoll = snapshot(midBattle);
      expect(quickClawRolls(withRoll)).toEqual({ p1: true });
      for (const end of expandTurn(withRoll, { p2: swap(1) })) expect([end.state.phase.kind, rollSides(end.state)]).toEqual(['turnChoice', ['p2']]);
    }
  });
});
