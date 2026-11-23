// What a turn carries across a mid-turn step boundary: a `*MidTurnSwitch` state ends a step mid-turn and the next step
// restores it (with an empty log), so anything the turn still reads at its end must live in the battle's state.

import { beforeAll, describe, expect, it } from 'vitest';
import type { BattleInput, Choice, EngineState, Side } from '../../../src/contracts/engine.js';
import { applyChoices, choicesIn, createBattle, restore, snapshot } from '../../../src/engine/battle.js';
import { ChanceDriver, nextScript } from '../../../src/engine/chance.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { BAG, fixtureDex, ID, ITEM, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

type Choices = { p1?: Choice; p2?: Choice };
const move = (slot: number): Choice => ({ kind: 'move', slot });
const FIRST = { p1: move(0), p2: move(0) };
const SECOND = { p1: move(1), p2: move(0) };
const fight = (player: BattleInput['player'], party: Parameters<typeof resolvedTrainer>[1], field: BattleInput['field'] = {}) =>
  createBattle({ player, trainer: resolvedTrainer(BAG.none, party), field });
function changed(state: EngineState, change: (battle: Battle) => void): EngineState {
  const battle = restore(state);
  change(battle);
  return snapshot(battle);
}
/** Whether the trainer's lead holds `volatile`. */
const foeHas = (volatile: string) => (state: EngineState): boolean =>
  volatile in (JSON.parse(state.json) as { sides: { pokemon: { volatiles: object }[] }[] }).sides[1]!.pokemon[0]!.volatiles;
const uproarOn = foeHas('uproar');
const lockOn = foeHas('lockedmove');

/** The trainer's Deoxys (L50) in an uproar, against the player's slower Gengar (a Ghost: U-turn, Tackle) and Monferno. */
const uproarAgainstGengar = () => changed(fight([playerMon(ID.gengar, 20, [ID.uTurn, ID.tackle]), playerMon(ID.monferno, 30, [ID.tackle])], [resolvedMon(ID.deoxys, 50, [ID.uproar])]),
  (battle) => { expect(battle.p2.active[0]!.addVolatile('uproar')).toBe(true); });
/** The trainer's Deoxys locked into a Ground move against the player's Flying Tropius, `change`d first. */
const lockedQuake = (change: (target: Pokemon) => void = () => {}) => changed(fight([playerMon(ID.tropius, 30, [ID.growl])], [resolvedMon(ID.deoxys, 50, [ID.plainQuake])]), (battle) => {
  const deoxys = battle.p2.active[0]!;
  expect(deoxys.addVolatile('lockedmove', deoxys, battle.dex.getActiveMove(deoxys.moveSlots[0]!.id))).toBe(true);
  change(battle.p1.active[0]!);
});

describe('the no-effect flag: the type chart\'s immunity ends an uproar or a lock, whatever happens after (bcp:1523-1563, bl:2808-2820)', () => {
  it('Uproar into the Ghost ends the uproar', () => {
    const outcomes = expandTurn(uproarAgainstGengar(), SECOND);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) expect([outcome.log.includes('|-immune|p1a: Gengar'), uproarOn(outcome.state)]).toEqual([true, false]);
  });

  it('with Gengar\'s U-turn after it, the uproar still ends at the end of the turn', () => {
    const switches = expandTurn(uproarAgainstGengar(), FIRST).filter((outcome) => outcome.state.phase.kind === 'playerMidTurnSwitch');
    expect(switches.length).toBeGreaterThan(0);
    const ends = switches.flatMap((mid) => {
      expect(mid.log).toContain('|-immune|p1a: Gengar');
      return expandTurn(mid.state, { p1: { kind: 'switch', index: 1 } });
    });
    expect(ends.length).toBeGreaterThan(0);
    for (const outcome of ends) expect([outcome.state.phase.kind, uproarOn(outcome.state)]).toEqual(['turnChoice', false]);
  });

  it('a semi-invulnerable Ghost: the chart still runs after the miss, and the uproar ends (bcp:3254-3279, :3040)', () => {
    const outcomes = expandTurn(changed(uproarAgainstGengar(), (battle) => { expect(battle.p1.active[0]!.addVolatile('fly')).toBe(true); }), SECOND);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) expect([outcome.log.includes('|-miss|p2a: Deoxys|p1a: Gengar'), uproarOn(outcome.state)]).toEqual([true, false]);
  });

  // Levitate and Magnet Rise are their own flags (bl:2600-2608), not the chart's: the lock goes on.
  it.each<[string, (target: Pokemon) => void, boolean]>([
    ['a Ground lock into a Flying-type ends', () => {}, false],
    ['a Ground lock into a Levitate Flying-type goes on', (target) => { target.setAbility('levitate'); }, true],
    ['a Ground lock into a Flying-type under Magnet Rise goes on', (target) => { expect(target.addVolatile('magnetrise')).toBe(true); }, true],
  ])('%s', (_, change, on) => {
    const outcomes = expandTurn(lockedQuake(change), FIRST);
    expect(outcomes.length).toBeGreaterThan(0);
    expect(new Set(outcomes.map((outcome) => lockOn(outcome.state)))).toEqual(new Set([on]));
  });
});

/**
 * Every pair of steps from `state`: `c1`, then from each leaf that stops mid-turn that side's first legal choice, run on
 * a restore of the mid-turn snapshot and on the live battle that made it: the mid-turn stops, continuations, and differences.
 */
function liveAgainstRestored(state: EngineState, c1: Choices): { mids: number; continuations: number; differ: number } {
  let [mids, continuations, differ] = [0, 0, 0];
  for (let script: number[] | null = []; script !== null;) {
    const first = new ChanceDriver(script);
    const live = restore(state, first);
    applyChoices(live, c1);
    const mid = snapshot(live);
    script = nextScript(first.points);
    if (!mid.phase.kind.endsWith('MidTurnSwitch')) continue;
    mids++;
    const side: Side = mid.phase.kind.startsWith('player') ? 'p1' : 'p2';
    const choice = choicesIn(live, side)[0]!;
    for (let second: number[] | null = []; second !== null;) {
      const restoredDriver = new ChanceDriver(second);
      const restored = restore(mid, restoredDriver);
      applyChoices(restored, { [side]: choice });
      const again = restore(state, new ChanceDriver([...first.points, ...restoredDriver.points].map((point) => point.chosen)));
      applyChoices(again, c1);
      applyChoices(again, { [side]: choice });
      continuations++;
      if (snapshot(again).key !== snapshot(restored).key) differ++;
      second = nextScript(restoredDriver.points);
    }
  }
  return { mids, continuations, differ };
}

describe('continuing a live battle and a restore of its mid-turn snapshot reach the same keys, on every chance path', () => {
  it.each<[string, () => EngineState, Choices]>([
    ['the player\'s slower U-turn after the trainer\'s Uproar into his Ghost', uproarAgainstGengar, FIRST],
    ['the player\'s U-turn, Quick Claw on both sides', () => fight([playerMon(ID.monferno, 30, [ID.uTurn], { item: ITEM.quickClaw }), playerMon(ID.zigzagoon, 20, [ID.tackle], { item: ITEM.quickClaw })],
      [resolvedMon(ID.zigzagoon, 20, [ID.tackle], { item: ITEM.quickClaw })]), FIRST],
    ['a speed-tie mirror, both U-turn', () => fight([playerMon(ID.zigzagoon, 20, [ID.uTurn]), playerMon(ID.zigzagoon, 20, [ID.tackle])],
      [resolvedMon(ID.zigzagoon, 20, [ID.uTurn]), resolvedMon(ID.zigzagoon, 20, [ID.tackle])]), FIRST],
    ['the player\'s Baton Pass in sand against Ember', () => fight([playerMon(ID.monferno, 30, [ID.batonPass]), playerMon(ID.zigzagoon, 20, [ID.tackle], { item: ITEM.leftovers })],
      [resolvedMon(ID.deoxys, 30, [ID.ember, ID.wrap])], { weather: 'sand' }), FIRST],
    ['the trainer\'s U-turn into the player\'s Ember', () => fight([playerMon(ID.monferno, 30, [ID.thunderWave, ID.ember])],
      [resolvedMon(ID.deoxys, 30, [ID.uTurn]), resolvedMon(ID.zigzagoon, 20, [ID.tackle], { item: ITEM.kingsRock })]), SECOND],
  ])('%s', (_, start, c1) => {
    const { mids, continuations, differ } = liveAgainstRestored(start(), c1);
    expect([mids > 0, continuations > 0, differ]).toEqual([true, true, 0]);
  }, 120_000);
});
