// Pick-time collapses may only remove leaves: with and without them (`collapse: false`), `expandTurn` gives the same
// outcomes, each with the same state key, probability, `critBy` and observation.

import { beforeAll, describe, expect, it } from 'vitest';
import type { BattleInput, Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import { createBattle, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { BAG, emberRolls, emberTurn, fixtureDex, ID, ITEM, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH_FIRST = { p1: move(0), p2: move(0) };
function changed(state: EngineState, change: (battle: Battle) => void): EngineState {
  const battle = restore(state);
  change(battle);
  return snapshot(battle);
}
/** The player's Monferno (L30) knowing `moves` against the trainer's Zigzagoon (L20) knowing `enemyMoves`. */
const duel = (moves: number[], enemyMoves: number[] = [ID.meanLook], enemyFields = {}): EngineState => createBattle({
  player: [playerMon(ID.monferno, 30, moves)], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, enemyMoves, enemyFields)]), field: {},
} as BattleInput);
const foeAt = (state: EngineState, hp: number) => changed(state, (battle) => { battle.p2.active[0]!.hp = hp; });
const substitute = (hp: number) => (battle: Battle) => {
  battle.p2.active[0]!.addVolatile('substitute');
  battle.p2.active[0]!.volatiles['substitute']!['hp'] = hp;
};
/** Each outcome's (state key, critBy, observation) and its probability; no two outcomes share the first. */
function distribution(outcomes: readonly Outcome[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const outcome of outcomes) {
    const id = `${outcome.state.key}|${outcome.critBy.p1}|${outcome.critBy.p2}|${outcome.observation}`;
    expect(map.has(id)).toBe(false);
    map.set(id, `${outcome.probability.num}/${outcome.probability.den}`);
  }
  return map;
}
const leaves = (outcomes: readonly Outcome[]) => outcomes.reduce((total, outcome) => total + outcome.merged, 0);
/** Ember's median non-crit damage: half its rolls knock out a Zigzagoon left on it. */
const MEDIAN_EMBER = [...emberRolls(false)].sort((a, b) => a - b)[8]!;
const halfKnockOut = () => foeAt(createBattle(emberTurn()), MEDIAN_EMBER);

describe('knock-out rolls collapse at the pick', () => {
  // 'fewer': a hit that can knock out (or leave 1 HP through False Swipe, Endure or Focus Band) on a neutral target with
  // no `ModifyDamage` handler, so only the `>=hp` group can cut leaves (equal-damage grouping merges nothing). 'same': a
  // substitute takes the hit, or Bide adds the damage up, so every roll stays.
  it.each<[string, 'fewer' | 'same', () => EngineState]>([
    ['Ember: every crit knocks out', 'fewer', () => createBattle(emberTurn())],
    ['Ember: half the rolls knock out', 'fewer', halfKnockOut],
    ['Mega Kick (90% accuracy) on a weakened foe', 'fewer', () => foeAt(duel([ID.megaKick]), 30)],
    ['Tackle on a substitute', 'same', () => changed(duel([ID.tackle]), substitute(9))],
    ['Double-Edge on a substitute', 'same', () => changed(duel([ID.doubleEdge]), substitute(20))],
    ['Double-Edge: recoil from a knock-out', 'fewer', () => duel([ID.doubleEdge])],
    ['Double-Edge on a weakened foe', 'fewer', () => foeAt(duel([ID.doubleEdge]), 40)],
    ['Giga Drain: drain from a knock-out', 'fewer', () => changed(foeAt(duel([ID.gigaDrain]), 25), (battle) => { battle.p1.active[0]!.hp = 10; })],
    ['Focus Band on a fatal hit', 'fewer', () => foeAt(duel([ID.tackle], [ID.meanLook], { item: ITEM.focusBand }), 8)],
    ['Endure against Mega Kick', 'fewer', () => duel([ID.megaKick], [ID.endure])],
    ['False Swipe on a weakened foe', 'fewer', () => foeAt(duel([ID.falseSwipe]), 12)],
    ['Fury Attack on a weakened foe', 'fewer', () => foeAt(duel([ID.furyAttack]), 14)],
    ['Bide stores a fatal hit', 'same', () => changed(runFirstOutcome(duel([ID.bide, ID.tackle], [ID.tackle]), BOTH_FIRST), (battle) => { battle.p1.active[0]!.hp = 6; })],
    ['the trainer knocks the player out', 'fewer', () => createBattle({ player: [playerMon(ID.zigzagoon, 5, [ID.tackle]), playerMon(ID.monferno, 5, [ID.tackle])],
      trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.deoxys, 50, [ID.waterBall])]), field: {} })],
  ])('same outcomes with and without the collapse: %s', (_, fewer, start) => {
    const state = start();
    const exact = expandTurn(state, BOTH_FIRST, { collapse: false });
    const collapsed = expandTurn(state, BOTH_FIRST);
    expect(distribution(collapsed)).toEqual(distribution(exact));
    if (fewer === 'fewer') expect(leaves(collapsed)).toBeLessThan(leaves(exact));
    else expect(leaves(collapsed)).toBe(leaves(exact));
  }, 60_000);

  it('the knock-out group is one labelled leaf, and the crit branch (every roll a knock-out) draws no roll', () => {
    const state = halfKnockOut();
    const exact = expandTurn(state, BOTH_FIRST, { collapse: false });
    const collapsed = expandTurn(state, BOTH_FIRST);
    // Knocked out by the hit itself (a burn after a roll that leaves 1 HP knocks out at the turn's end): one leaf each for
    // the crits and the non-crit group.
    const knockedOut = (outcomes: Outcome[]) => leaves(outcomes.filter((outcome) => restore(outcome.state).p2.pokemon[0]!.hp === 0 && !outcome.labels.some((label) => label.kind === 'effect')));
    expect([knockedOut(exact) > 2, knockedOut(collapsed)]).toEqual([true, 2]);
    const ko = collapsed.find((outcome) => !outcome.critBy.p1 && restore(outcome.state).p2.pokemon[0]!.hp === 0)!;
    expect([ko.merged, ko.labels]).toEqual([1, expect.arrayContaining([{ kind: 'roll', side: 'p1', source: 'ember', outcome: '≥hp', rollValue: 'final' }])]);
    expect(collapsed.find((outcome) => outcome.critBy.p1)!.labels.map((label) => `${label.kind}:${label.outcome}`)).toEqual(['crit:crit']);
  });
});
