// The cartridge's chance points, labelled: rolls, crits, accuracy, secondary effects, speed ties, Quick Claw, multi-hit.

import { beforeAll, describe, expect, it } from 'vitest';
import type { BattleInput, Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import { createBattle, restore, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { cartridgeHitRate } from '../../../src/engine/mod/accuracy.js';
import { add, mul, rat, type Rational, ZERO } from '../../../src/engine/rational.js';
import { unmodelledNotes } from '../../../src/engine/unmodelled.js';
import { ABILITY, BAG, emberRolls, emberTurn, fixtureDex, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const U16 = 65536;
const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH_FIRST = { p1: move(0), p2: move(0) };
const chanceOf = (outcomes: Outcome[], test: (outcome: Outcome) => boolean): Rational =>
  outcomes.filter(test).reduce((sum, outcome) => add(sum, outcome.probability), ZERO);
const foe = (outcome: Outcome) => restore(outcome.state).p2.active[0]!;
const hasPoint = (outcomes: Outcome[], kind: string) => outcomes.some((outcome) => outcome.labels.some((label) => label.kind === kind));
const missed = (outcome: Outcome) => outcome.log.some((line) => line.startsWith('|-miss|p1a: '));
/** "p1a" or "p2a": whose `|move|` line comes first. */
const firstMover = (outcome: Outcome) => outcome.log.find((line) => line.startsWith('|move|'))!.slice(6, 9);
const turn = (state: EngineState) => expandTurn(state, BOTH_FIRST);
const missChance = (state: EngineState) => chanceOf(turn(state), missed);

function changed(state: EngineState, change: (battle: Battle) => void): EngineState {
  const battle = restore(state);
  change(battle);
  return snapshot(battle);
}
const withWeather = (state: EngineState, weather: string) => changed(state, (battle) => { expect(battle.field.setWeather(weather, battle.p1.active[0]!)).toBe(true); });
const accuracyStage = (state: EngineState, stage: number) => changed(state, (battle) => { battle.p1.active[0]!.boosts.accuracy = stage; });
/** The player's Monferno (L30) with `moves`, against the Ember turn's Zigzagoon (L20, Mean Look). */
const monfernoWith = (moves: number[], fields: Partial<PlayerMon> = {}): BattleInput => ({ ...emberTurn(), player: [playerMon(ID.monferno, 30, moves, fields)] });
const monferno = (moves: number[], fields: Partial<PlayerMon> = {}) => createBattle(monfernoWith(moves, fields));
/** The player's `species` at `level` with `move` against the trainer's `theirs` (Mean Look). */
const versus = (species: number, level: number, moveId: number, theirs: [number, number], fields: Partial<PlayerMon> = {}, extra: Partial<BattleInput> = {}) => createBattle({
  player: [playerMon(species, level, [moveId], fields)], trainer: resolvedTrainer(BAG.none, [resolvedMon(theirs[0], theirs[1], [ID.meanLook])]), field: {}, ...extra,
});
/** `cartridgeHitRate` of the player's `moveId` on the trainer's active Pokémon. */
function hitRate(state: EngineState, moveId: string): number | true {
  const battle = restore(state);
  return cartridgeHitRate(battle.p1.active[0]!, battle.p2.active[0]!, battle.dex.getActiveMove(moveId), battle);
}

describe('labelled cartridge chances', () => {
  it('roll collapse: one outcome per damage value, weighed count / 16, labelled', () => {
    const state = createBattle(emberTurn());
    const outcomes = turn(state);
    const maxhp = restore(state).p2.active[0]!.maxhp;
    const counts = new Map<number, number>();
    for (const damage of emberRolls(false)) counts.set(damage, (counts.get(damage) ?? 0) + 1);
    const branch = rat(BigInt(U16 - 4096) * BigInt(U16 - 6560), BigInt(U16) ** 2n); // no crit, no burn
    const plain = outcomes.filter((outcome) => !outcome.critBy.p1 && foe(outcome).status !== 'brn');
    expect(plain.map((outcome) => maxhp - foe(outcome).hp).sort((a, b) => a - b)).toEqual([...counts.keys()].sort((a, b) => a - b));
    for (const outcome of plain) {
      expect([outcome.probability, outcome.merged]).toEqual([mul(branch, rat(counts.get(maxhp - foe(outcome).hp)!, 16)), 1]);
      expect(outcome.labels.find((label) => label.kind === 'roll')).toMatchObject({ side: 'p1', source: 'ember' });
    }
    expect(outcomes.every((outcome) => !outcome.unlabelled)).toBe(true);
  });

  it('crit odds: stage 0 r % 16, Scope Lens and Slash r % 4, Super Luck as well r % 3 (21846, not 1/3); Battle Armor blocks it', () => {
    const critChance = (state: EngineState) => chanceOf(turn(state), (outcome) => outcome.critBy.p1);
    expect([critChance(createBattle(emberTurn())), critChance(monferno([ID.slash], { item: ITEM.scopeLens })),
      critChance(monferno([ID.slash], { item: ITEM.scopeLens, ability: knownAbility(ABILITY.superLuck) }))]).toEqual([rat(4096, U16), rat(1, 4), rat(21846, U16)]);
    expect(hasPoint(turn(createBattle({ ...emberTurn(), world: { enemy: [{ ability: ABILITY.battleArmor }] } })), 'crit')).toBe(false);
    expect(turn(createBattle(emberTurn())).find((outcome) => outcome.critBy.p1)!.labels[0]).toEqual({ kind: 'crit', side: 'p1', source: 'ember', outcome: 'crit' });
  });

  // Hit rates (bcp:2923-3031): stages x75/100 .. x33/100, Compound Eyes x130/100, the weather rules (Hurricane takes
  // Thunder's in the hack), No Guard on either side, BrightPowder and Lax Incense x(100 - 11)/100, Wide Lens x110/100,
  // and a one-hit KO's accuracy plus the level difference (none against a higher level, which never misses).
  it.each<[string, () => EngineState, string, number | true]>([
    ['Mega Kick', () => monferno([ID.megaKick]), 'megakick', 90],
    ['Tackle', () => monferno([ID.tackle]), 'tackle', 100],
    ['Tackle at -1 accuracy', () => accuracyStage(monferno([ID.tackle]), -1), 'tackle', 75],
    ['Tackle at -6 accuracy (Showdown\'s 3/9 would give 33.3)', () => accuracyStage(monferno([ID.tackle]), -6), 'tackle', 33],
    ['Compound Eyes on Thunder', () => monferno([ID.thunder], { ability: knownAbility(ABILITY.compoundEyes) }), 'thunder', 91],
    ['Thunder', () => monferno([ID.thunder]), 'thunder', 70],
    ['Thunder in rain', () => withWeather(monferno([ID.thunder]), 'raindance'), 'thunder', true],
    ['Thunder in sun', () => withWeather(monferno([ID.thunder]), 'sunnyday'), 'thunder', 50],
    ['Hurricane', () => monferno([ID.hurricane]), 'hurricane', 70],
    ['Hurricane in sun', () => withWeather(monferno([ID.hurricane]), 'sunnyday'), 'hurricane', 50],
    ['Hurricane in rain', () => withWeather(monferno([ID.hurricane]), 'raindance'), 'hurricane', true],
    ['Blizzard', () => monferno([ID.blizzard]), 'blizzard', 70],
    ['Blizzard in hail', () => withWeather(monferno([ID.blizzard]), 'hail'), 'blizzard', true],
    ['Blizzard with the user\'s No Guard', () => monferno([ID.blizzard], { ability: knownAbility(ABILITY.noGuard) }), 'blizzard', true],
    ['Blizzard into a No Guard target', () => createBattle({ ...monfernoWith([ID.blizzard]), world: { enemy: [{ ability: ABILITY.noGuard }] } }), 'blizzard', true],
    ['Blizzard into BrightPowder', () => createBattle({ ...monfernoWith([ID.blizzard]), trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.meanLook], { item: ITEM.brightPowder })]) }), 'blizzard', 62],
    ['Blizzard into Lax Incense', () => createBattle({ ...monfernoWith([ID.blizzard]), trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.meanLook], { item: ITEM.laxIncense })]) }), 'blizzard', 62],
    ['Blizzard with Wide Lens', () => monferno([ID.blizzard], { item: ITEM.wideLens }), 'blizzard', 77],
    ['Guillotine down 10 levels', () => monferno([ID.guillotine]), 'guillotine', 40],
    ['Guillotine up 10 levels', () => versus(ID.zigzagoon, 20, ID.guillotine, [ID.monferno, 30]), 'guillotine', true],
  ])('hit rate: %s', (_, state, moveId, rate) => expect(hitRate(state(), moveId)).toBe(rate));

  it('a sure hit draws no hit point; a roll labels its miss', () => {
    for (const state of [monferno([ID.tackle]), withWeather(monferno([ID.thunder]), 'raindance'), withWeather(monferno([ID.hurricane]), 'raindance'),
      withWeather(monferno([ID.blizzard]), 'hail'), versus(ID.zigzagoon, 20, ID.guillotine, [ID.monferno, 30])]) expect(hasPoint(turn(state), 'hit')).toBe(false);
    expect(hasPoint(turn(monferno([ID.thunder])), 'hit')).toBe(true);
    expect(turn(monferno([ID.megaKick])).find(missed)!.labels).toContainEqual({ kind: 'hit', side: 'p1', source: 'megakick', outcome: 'miss' });
  });

  // r % 100 < N: 656 x 36 + 655 x (N - 36) of the draws.
  it.each<[string, () => EngineState, number]>([
    ['Mega Kick (90)', () => monferno([ID.megaKick]), 58986],
    ['Tackle at -1 (75)', () => accuracyStage(monferno([ID.tackle]), -1), 49161],
    ['Guillotine (40)', () => monferno([ID.guillotine]), 26236],
    // Zoom Lens x120/100 once the defender has moved: the slower Zigzagoon's Blizzard at 84.
    ['Zoom Lens after the defender moved (84)', () => versus(ID.zigzagoon, 20, ID.blizzard, [ID.monferno, 30], { item: ITEM.zoomLens }), 55056],
    ['Zoom Lens when moving first: nothing (70)', () => createBattle({ player: [playerMon(ID.monferno, 30, [ID.blizzard], { item: ITEM.zoomLens })],
      trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.tackle])]), field: {} }), 45886],
  ])('miss odds: %s', (_, state, hits) => expect(missChance(state())).toEqual(rat(U16 - hits, U16)));

  it('Sturdy stops a one-hit KO move before the level check, and shows (bs:4340-4341)', () => {
    const outcomes = turn(versus(ID.zigzagoon, 20, ID.guillotine, [ID.monferno, 30], {}, { world: { enemy: [{ ability: ABILITY.sturdy }] } }));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.log.some((line) => line.startsWith('|-immune|p2a: Monferno') && line.includes('ability: Sturdy'))).toBe(true);
    expect(outcomes[0]!.log.some((line) => line.includes('[ohko]'))).toBe(false);
  });

  it('roll labels name Future Sight, whose damage Gen 4 computes from a move with no ID', () => {
    const rolls = turn(monferno([ID.futureSight])).flatMap((outcome) => outcome.labels.filter((label) => label.kind === 'roll'));
    expect(rolls.length).toBeGreaterThan(0);
    expect(rolls.every((label) => label.source === 'futuresight' && label.side === 'p1')).toBe(true);
  });

  it('secondary odds: Ember\'s 10% burn (6560), doubled by Serene Grace (13120); every crit KOs, so only the non-crit branch draws', () => {
    const burnChance = (input: BattleInput) => chanceOf(turn(createBattle(input)), (outcome) => foe(outcome).status === 'brn');
    const noCrit = rat(U16 - 4096, U16);
    expect([burnChance(emberTurn()), burnChance(emberTurn([ID.meanLook], { ability: knownAbility(ABILITY.sereneGrace) }))])
      .toEqual([mul(noCrit, rat(6560, U16)), mul(noCrit, rat(13120, U16))]);
    expect(turn(createBattle(emberTurn())).find((outcome) => foe(outcome).status === 'brn')!.labels).toContainEqual({ kind: 'effect', side: 'p1', source: 'ember', outcome: 'brn' });
  });

  it('a speed tie orders by RandNext() & 1, 1/2 each; tied end-of-turn effects follow the battler order, picked once', () => {
    const mirror = (moveId: number, status?: boolean) => {
      const state = createBattle({ player: [playerMon(ID.monferno, 30, [moveId], status ? { status: { kind: 'poison' } } : {})],
        trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.monferno, 30, [moveId])]), field: {} });
      return status ? changed(state, (battle) => { expect(battle.p2.active[0]!.setStatus('psn')).toBe(true); }) : state;
    };
    expect(unmodelledNotes(restore(mirror(ID.tackle)))).toEqual([]);
    const outcomes = turn(mirror(ID.tackle));
    expect([chanceOf(outcomes, (o) => firstMover(o) === 'p1a'), chanceOf(outcomes, (o) => firstMover(o) === 'p2a')]).toEqual([rat(1, 2), rat(1, 2)]);
    for (const outcome of outcomes) {
      expect(outcome.unlabelled).toBe(false);
      expect(outcome.labels.filter((label) => label.kind === 'speedTie')).toEqual([
        { kind: 'speedTie', side: null, source: 'actionOrder', outcome: firstMover(outcome) === 'p1a' ? 'p1First' : 'p2First' },
      ]);
    }
    // Both poisoned, Mean Look drawing nothing: the only chances are the two ties.
    const poisoned = turn(mirror(ID.meanLook, true));
    const firstHurt = (outcome: Outcome) => outcome.log.find((line) => line.startsWith('|-damage|') && line.endsWith('|[from] psn'))!.slice(9, 12);
    expect(chanceOf(poisoned, (outcome) => firstHurt(outcome) === 'p1a')).toEqual(rat(1, 2));
    for (const outcome of poisoned) {
      expect(outcome.unlabelled).toBe(false);
      expect(outcome.labels.map((label) => [label.kind, label.source])).toEqual([['speedTie', 'actionOrder'], ['speedTie', 'speedOrder']]);
    }
  });

  it('multi-hit: Fury Attack hits 2, 3, 4, 5 times for 3/8, 3/8, 1/8, 1/8; Skill Link five, with no point', () => {
    const fury = (fields: Partial<PlayerMon> = {}) => turn(createBattle({
      player: [playerMon(ID.zigzagoon, 5, [ID.furyAttack], fields)], trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.deoxys, 50, [ID.meanLook])]), field: {},
      world: { enemy: [{ ability: ABILITY.battleArmor }] },
    }));
    const hits = (outcome: Outcome) => Number(/^\|-hitcount\|p2a: Deoxys\|(\d)$/.exec(outcome.log.find((line) => line.startsWith('|-hitcount|'))!)![1]);
    const outcomes = fury();
    expect([2, 3, 4, 5].map((count) => chanceOf(outcomes, (outcome) => hits(outcome) === count))).toEqual([rat(3, 8), rat(3, 8), rat(1, 8), rat(1, 8)]);
    for (const outcome of outcomes) expect(outcome.labels.filter((label) => label.kind === 'multiHit')).toEqual([{ kind: 'multiHit', side: 'p1', source: 'furyattack', outcome: `${hits(outcome)}` }]);
    const linked = fury({ ability: knownAbility(ABILITY.skillLink) });
    expect([linked.every((outcome) => hits(outcome) === 5), hasPoint(linked, 'multiHit')]).toEqual([true, false]);
  });
});
