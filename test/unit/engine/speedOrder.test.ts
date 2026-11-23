// The cartridge's speed order (mod/speedOrder.ts): `BattleSystem_CompareBattlerSpeed` (bl:1188-1451) for the turn's
// actions and `monSpeedOrder`, and Quick Claw's `speedRand` drawn at the battle start and after each turn's order.

import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { Choice, EngineState, Outcome, WorldAssignment } from '../../../src/contracts/engine.js';
import { createBattle, restore, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { showdownEngine, unmodelledIn } from '../../../src/engine/index.js';
import { FLAGGED_ITEM_NOTE } from '../../../src/engine/mod/speedOrder.js';
import { add, ONE, rat, type Rational, ZERO } from '../../../src/engine/rational.js';
import { ABILITY, BAG, emberTurn, fixtureDex, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const U16 = 65536;
const QUICK_CLAW = 13108; // speedRand % 5 == 0
const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH_FIRST = { p1: move(0), p2: move(0) };
const chanceOf = (outcomes: Outcome[], test: (outcome: Outcome) => boolean): Rational =>
  outcomes.filter(test).reduce((sum, outcome) => add(sum, outcome.probability), ZERO);
const firstMover = (outcome: Outcome) => outcome.log.find((line) => line.startsWith('|move|'))!.slice(6, 9);
/** Whose end-of-turn poison ran first: `monSpeedOrder`. */
const firstPoisoned = (outcome: Outcome) => outcome.log.find((line) => line.startsWith('|-damage|') && line.endsWith('|[from] psn'))!.slice(9, 12);
const labelsOf = (outcomes: Outcome[], kind: string) => outcomes.flatMap((outcome) => outcome.labels.filter((label) => label.kind === kind));
const duel = (mine: PlayerMon, theirs: ResolvedMon) => createBattle({ player: [mine], trainer: resolvedTrainer(BAG.none, [theirs]), field: {} });
/** Both sides poisoned and using Mean Look (no draw, +1 for both): the end of turn shows whom `monSpeedOrder` puts first. */
function poisoned(mine: PlayerMon, theirs: ResolvedMon, world?: WorldAssignment): EngineState {
  const battle = restore(createBattle({ player: [mine], trainer: resolvedTrainer(BAG.none, [theirs]), field: {}, ...(world ? { world } : {}) }));
  expect(battle.p2.active[0]!.setStatus('psn')).toBe(true);
  return snapshot(battle);
}
const monferno = (fields: Partial<PlayerMon> = {}) => playerMon(ID.monferno, 30, [ID.meanLook], { status: { kind: 'poison' }, ...fields });
const foe = (species: number, level: number, fields: Partial<ResolvedMon> = {}, moves: number[] = [ID.meanLook]) => resolvedMon(species, level, moves, fields);
const clawed = { item: ITEM.quickClaw };
/** `state` with its trainer's lead at a quarter of its HP: a Custap Berry's pinch (its parameter 4). */
const atPinch = (state: EngineState) => {
  const battle = restore(state);
  battle.p2.active[0]!.hp = Math.floor(battle.p2.active[0]!.maxhp / 4);
  return snapshot(battle);
};

describe('the cartridge speed order', () => {
  it('a speed tie with one Quick Claw holder: the holder first for 13108 + 26214 of the draws, in the move order and monSpeedOrder', () => {
    const moves = expandTurn(duel(playerMon(ID.monferno, 30, [ID.tackle]), foe(ID.monferno, 30, clawed, [ID.tackle])), BOTH_FIRST);
    const endOfTurn = expandTurn(poisoned(monferno(), foe(ID.monferno, 30, clawed)), BOTH_FIRST);
    expect([chanceOf(moves, (o) => firstMover(o) === 'p2a'), chanceOf(endOfTurn, (o) => firstPoisoned(o) === 'p2a')]).toEqual([rat(QUICK_CLAW + 26214, U16), rat(QUICK_CLAW + 26214, U16)]);
    expect([...moves, ...endOfTurn].every((outcome) => !outcome.unlabelled)).toBe(true);
  });

  it('a slower Quick Claw holder goes first in monSpeedOrder for 13108, and that one draw moves it first next turn (bcp:853-858)', () => {
    const turn = expandTurn(poisoned(monferno(), foe(ID.zigzagoon, 20, clawed)), BOTH_FIRST);
    expect(chanceOf(turn, (outcome) => firstPoisoned(outcome) === 'p2a')).toEqual(rat(QUICK_CLAW, U16));
    expect(labelsOf(turn, 'quickClaw').every((label) => label.side === 'p2' && label.source === 'quickclaw')).toBe(true);
    expect(new Set(turn.map(firstPoisoned))).toEqual(new Set(['p1a', 'p2a']));
    for (const outcome of turn) {
      const activated = firstPoisoned(outcome) === 'p2a';
      const next = expandTurn(outcome.state, BOTH_FIRST);
      expect(chanceOf(next, (later) => firstMover(later) === 'p2a')).toEqual(activated ? ONE : ZERO);
      for (const later of next) {
        expect(later.log.includes('|-activate|p2a: Zigzagoon|item: Quick Claw')).toBe(activated);
        expect(labelsOf([later], 'quickClaw')).toHaveLength(1); // only its own end of turn's pick
      }
    }
  });

  it('Quick Claw shows when its holder moves first, and only then: 13108 of the draws, labelled', () => {
    const outcomes = expandTurn(createBattle({ ...emberTurn(), trainer: resolvedTrainer(BAG.none, [foe(ID.zigzagoon, 20, clawed, [ID.leechSeed])]) }), BOTH_FIRST);
    for (const outcome of outcomes) expect(outcome.log.includes('|-activate|p2a: Zigzagoon|item: Quick Claw')).toBe(firstMover(outcome) === 'p2a');
    const early = outcomes.filter((outcome) => firstMover(outcome) === 'p2a');
    expect(chanceOf(early, () => true)).toEqual(rat(QUICK_CLAW, U16));
    for (const outcome of early) expect(outcome.labels[0]).toEqual({ kind: 'quickClaw', side: 'p2', source: 'quickclaw', outcome: 'activate' });
    expect(outcomes.every((outcome) => !outcome.unlabelled)).toBe(true);
  });

  it('switch against switch: ordered by the compare, Quick Claw included, with no message (bcp:772-787, bl:1278-1280)', () => {
    const outcomes = expandTurn(createBattle({
      player: [playerMon(ID.monferno, 30, [ID.tackle]), playerMon(ID.zigzagoon, 30, [ID.tackle])],
      trainer: resolvedTrainer(BAG.none, [foe(ID.zigzagoon, 20, clawed, [ID.tackle]), foe(ID.zigzagoon, 20, {}, [ID.tackle])]), field: {},
    }), { p1: { kind: 'switch', index: 1 }, p2: { kind: 'switch', index: 1 } });
    expect(chanceOf(outcomes, (outcome) => outcome.log.find((line) => line.startsWith('|switch|'))!.slice(8, 11) === 'p2a')).toEqual(rat(QUICK_CLAW, U16));
    expect(outcomes.some((outcome) => outcome.log.some((line) => line.includes('Quick Claw')))).toBe(false);
  });

  // Ties decided without a draw (bl:1412-1427): a Lagging Tail, Full Incense or Stall holder last; both slow, the slower first.
  it.each<[string, () => EngineState, string]>([
    ['Lagging Tail goes last at the end of turn', () => poisoned(monferno({ item: ITEM.laggingTail }), foe(ID.monferno, 30)), 'p2a'],
    ['Full Incense goes last', () => poisoned(monferno(), foe(ID.monferno, 30, { item: ITEM.fullIncense })), 'p1a'],
    ['both with Lagging Tail: the slower first', () => poisoned(monferno({ item: ITEM.laggingTail }), foe(ID.zigzagoon, 20, { item: ITEM.laggingTail })), 'p2a'],
    ['both with Stall: the slower first', () => poisoned(monferno({ ability: knownAbility(ABILITY.stall) }), foe(ID.zigzagoon, 20), { enemy: [{ ability: ABILITY.stall }] }), 'p2a'],
    ['Stall alone goes last, whatever the Speed', () => poisoned(monferno({ ability: knownAbility(ABILITY.stall) }), foe(ID.zigzagoon, 20)), 'p2a'],
  ])('%s', (_, start, first) => expect(new Set(expandTurn(start(), BOTH_FIRST).map(firstPoisoned))).toEqual(new Set([first])));

  it('Lagging Tail goes last in the move order too, with no tie draw', () => {
    const lagging = expandTurn(duel(playerMon(ID.monferno, 30, [ID.tackle], { item: ITEM.laggingTail }), foe(ID.monferno, 30, {}, [ID.tackle])), BOTH_FIRST);
    expect([lagging.every((outcome) => firstMover(outcome) === 'p2a'), labelsOf(lagging, 'speedTie')]).toEqual([true, []]);
  });

  it('a Quick Claw roll in the state changes its key, never the observation', () => {
    const state = poisoned(monferno(), foe(ID.zigzagoon, 20, clawed));
    const withRoll = (roll: boolean) => {
      const battle = restore(state);
      battle.formatData['kaizoSpeedRand'] = { p2: roll };
      return snapshot(battle);
    };
    const [rolled, unrolled] = [withRoll(true), withRoll(false)];
    expect(rolled.key).not.toBe(unrolled.key);
    expect([showdownEngine.observe(rolled), showdownEngine.observe(unrolled)]).toEqual([showdownEngine.observe(state), showdownEngine.observe(state)]);
  });

  it('an item-taking move on a battler whose Quick Claw flag is set is noted (the cartridge\'s flags stop Thief, bs:5114-5116)', () => {
    // Both claws activate: the faster Monferno's Thief meets Zigzagoon's flag, which its own move would clear.
    const outcomes = expandTurn(duel(playerMon(ID.monferno, 30, [ID.thief], clawed), foe(ID.zigzagoon, 20, clawed, [ID.leechSeed])), BOTH_FIRST);
    expect(chanceOf(outcomes, (outcome) => unmodelledIn(outcome.state).includes(FLAGGED_ITEM_NOTE))).toEqual(rat(QUICK_CLAW * QUICK_CLAW, U16 * U16));
  });

  it('Bug Bite reads the Custap flag alone: a flagged holder keeps its berry until its own move eats it (bs:8125-8127)', () => {
    // When the player's claw activates too, his faster Monferno's Bug Bite meets the flag and takes nothing; otherwise the
    // holder moves first and eats it. Battle Armor keeps the holder up.
    const outcomes = expandTurn(atPinch(duel(playerMon(ID.monferno, 30, [ID.bugBite], clawed),
      foe(ID.monferno, 20, { item: ITEM.custapBerry, ability: knownAbility(ABILITY.battleArmor) }, [ID.growl]))), BOTH_FIRST);
    const claw = (outcome: Outcome) => outcome.labels.find((label) => label.kind === 'quickClaw' && label.side === 'p1')?.outcome === 'activate';
    expect([outcomes.some(claw), outcomes.some((outcome) => !claw(outcome))]).toEqual([true, true]);
    for (const outcome of outcomes) {
      expect(firstMover(outcome)).toBe(claw(outcome) ? 'p1a' : 'p2a');
      expect([outcome.log.some((line) => line.includes('[from] stealeat')), restore(outcome.state).p2.active[0]!.item, unmodelledIn(outcome.state)]).toEqual([false, '', []]);
    }
  });

  it('Custap Berry at a pinch moves its holder first and is used up', () => {
    const outcomes = expandTurn(atPinch(createBattle({ ...emberTurn(), trainer: resolvedTrainer(BAG.none, [foe(ID.zigzagoon, 20, { item: ITEM.custapBerry }, [ID.leechSeed])]) })), BOTH_FIRST);
    for (const outcome of outcomes) {
      expect([firstMover(outcome), restore(outcome.state).p2.pokemon[0]!.item]).toEqual(['p2a', '']);
      expect(outcome.log).toContain('|-activate|p2a: Zigzagoon|item: Custap Berry|[consumed]');
    }
  });
});
