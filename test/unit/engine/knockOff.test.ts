// Knock Off as subscript_knock_off.s runs it: before `BtlCmd_TryKnockOff` (bs:6610-6633) it stops at a substitute (:5),
// Multitype (:6), a Griseous Orb (:7), and the defender's Quick Claw or Custap flag (:8-9), set at the turn's order
// (bl:1282-1284) and cleared when its holder's move starts (subscript_check_quick_claw.s:22-23). The item knocked off is
// the party's again after the fight (battle_io_command.c:590).

import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { BattleInput, Choice, Outcome } from '../../../src/contracts/engine.js';
import { carryOut, createBattle, restore } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { unmodelledIn } from '../../../src/engine/facts.js';
import { BAG, fixtureDex, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH_FIRST = { p1: move(0), p2: move(0) };
const duel = (mine: PlayerMon, theirs: ResolvedMon): BattleInput => ({ player: [mine], trainer: resolvedTrainer(BAG.none, [theirs]), field: {} });
const has = (outcome: Outcome, prefix: string): boolean => outcome.log.some((line) => line.startsWith(prefix));
const MULTITYPE = 121;
/** A side's first Quick Claw label: this turn's roll (the second is the next turn's, drawn after the order). */
const roll = (outcome: Outcome, side: 'p1' | 'p2') => outcome.labels.find((label) => label.kind === 'quickClaw' && label.side === side)?.outcome;
/** The last p2 Quick Claw label: the roll for the next turn. */
const nextRoll = (outcome: Outcome) => outcome.labels.filter((label) => label.kind === 'quickClaw' && label.side === 'p2').at(-1)?.outcome;
const item = (outcome: Outcome, side: 'p1' | 'p2') => restore(outcome.state)[side].active[0]!.item;
/** Every outcome kept the claw exactly when `kept` says, with a Knock Off line otherwise; both cases happen. */
function keptWhen(outcomes: Outcome[], side: 'p1' | 'p2', kept: (outcome: Outcome) => boolean) {
  const knocked = side === 'p1' ? '|-enditem|p1a: Monferno|Quick Claw|[from] move: Knock Off' : '|-enditem|p2a: Zigzagoon|Quick Claw|[from] move: Knock Off';
  for (const outcome of outcomes) expect([has(outcome, knocked), item(outcome, side)]).toEqual(kept(outcome) ? [false, 'quickclaw'] : [true, '']);
}
const clawMonferno = (moves: number[]) => playerMon(ID.monferno, 30, moves, { item: ITEM.quickClaw });

describe('Knock Off and the Quick Claw flag', () => {
  it('a Quick Claw is knocked off once its holder has moved, activated or not: its move\'s start cleared the flag (:8)', () => {
    const outcomes = expandTurn(createBattle(duel(clawMonferno([ID.growl]), resolvedMon(ID.deoxys, 35, [ID.knockOff]))), BOTH_FIRST);
    expect(['activate', 'none'].map((value) => outcomes.some((outcome) => roll(outcome, 'p1') === value))).toEqual([true, true]);
    keptWhen(outcomes, 'p1', () => false);
    for (const outcome of outcomes) expect(unmodelledIn(outcome.state)).toEqual([]);
  });

  it('it stays when Knock Off lands first: both claws activated (the faster Deoxys first, bl:1402-1407)', () => {
    const outcomes = expandTurn(createBattle(duel(clawMonferno([ID.growl]), resolvedMon(ID.deoxys, 35, [ID.knockOff], { item: ITEM.quickClaw }))), BOTH_FIRST);
    const both = (outcome: Outcome) => roll(outcome, 'p1') === 'activate' && roll(outcome, 'p2') === 'activate';
    expect([outcomes.some(both), outcomes.some((outcome) => !both(outcome))]).toEqual([true, true]);
    keptWhen(outcomes, 'p1', both);
  });

  it('it stays when Knock Off lands first: the holder\'s Counter (-5) comes after, its flag set at the order (bl:1282-1284)', () => {
    const outcomes = expandTurn(createBattle(duel(clawMonferno([ID.counter]), resolvedMon(ID.deoxys, 35, [ID.knockOff]))), BOTH_FIRST);
    expect(['activate', 'none'].map((value) => outcomes.some((outcome) => roll(outcome, 'p1') === value))).toEqual([true, true]);
    keptWhen(outcomes, 'p1', (outcome) => roll(outcome, 'p1') === 'activate');
  });

  // Trick Room's re-sort (bl:7276-7302) compares two battlers that both chose to fight without ignoring Quick Claw, so it
  // sets the flag again on the roll drawn after this turn's order; only the holder's next move or a switch-in clears it.
  // The hack's Trick Room has priority +7.
  const roomUser = () => resolvedMon(ID.zigzagoon, 20, [ID.trickRoom, ID.counter], { item: ITEM.quickClaw });

  it('Trick Room sets the flag again after its holder moved: a Knock Off later in the turn stops', () => {
    const outcomes = expandTurn(createBattle({ player: [playerMon(ID.monferno, 30, [ID.knockOff])], trainer: resolvedTrainer(BAG.none, [roomUser()]), field: {} }), BOTH_FIRST);
    expect(['activate', 'none'].map((value) => outcomes.some((outcome) => nextRoll(outcome) === value))).toEqual([true, true]);
    keptWhen(outcomes, 'p2', (outcome) => nextRoll(outcome) === 'activate');
  });

  // Turn 1: Trick Room (or the player switches); turn 2: an X Attack (an item against a move: no compare, bcp:772-787);
  // turn 3: the player's Knock Off before Zigzagoon's Counter.
  const roomItemKnockOff = (turn1: { p1: Choice; p2: Choice }, player: PlayerMon[]) => expandTurn(createBattle({ player, trainer: resolvedTrainer(BAG.potions, [roomUser()]), field: {} }), turn1)
    .flatMap((one) => expandTurn(one.state, { p1: move(0), p2: { kind: 'item', item: 'xattack' } }).flatMap((two) =>
      expandTurn(two.state, { p1: move(1), p2: move(1) }).map((three) => ({ turn2: nextRoll(one), turn3: nextRoll(two), three }))));
  const knockOffMonferno = () => playerMon(ID.monferno, 30, [ID.growl, ID.knockOff]);

  it('a flag Trick Room set again lasts past the turn\'s end, until its holder\'s next move', () => {
    const runs = roomItemKnockOff(BOTH_FIRST, [knockOffMonferno()]);
    const kept = (run: (typeof runs)[number]) => run.turn2 === 'activate' || run.turn3 === 'activate';
    expect([runs.some((run) => run.turn2 === 'activate' && run.turn3 === 'none'), runs.some((run) => !kept(run))]).toEqual([true, true]);
    for (const run of runs) expect(item(run.three, 'p2')).toBe(kept(run) ? 'quickclaw' : '');
    keptWhen(runs.map((run) => run.three), 'p2', (outcome) => kept(runs.find((run) => run.three === outcome)!));
  });

  it('Trick Room sets no flag when the two did not both choose to fight (bl:7288-7290): only turn 3\'s own roll stops it', () => {
    const runs = roomItemKnockOff({ p1: { kind: 'switch', index: 1 }, p2: move(0) }, [knockOffMonferno(), knockOffMonferno()]);
    expect(runs.some((run) => run.turn2 === 'activate' && run.turn3 === 'none')).toBe(true);
    keptWhen(runs.map((run) => run.three), 'p2', (outcome) => runs.find((run) => run.three === outcome)!.turn3 === 'activate');
  });
});

describe('Knock Off\'s other stops', () => {
  it.each<[string, Partial<PlayerMon>, string]>([
    ['a Griseous Orb is never knocked off (:7)', { item: ITEM.griseousOrb }, 'griseousorb'],
    ['a Multitype holder keeps its item (:6)', { item: ITEM.leftovers, ability: knownAbility(MULTITYPE) }, 'leftovers'],
    ['otherwise the item is gone for the fight', { item: ITEM.leftovers }, ''],
  ])('%s', (_, fields, held) => {
    for (const outcome of expandTurn(createBattle(duel(playerMon(ID.monferno, 30, [ID.growl], fields), resolvedMon(ID.deoxys, 50, [ID.knockOff]))), BOTH_FIRST)) {
      expect(item(outcome, 'p1')).toBe(held);
      expect(carryOut(outcome.state).mons[0]!.item).toBe(fields.item); // and the party's again after it
    }
  });
});
