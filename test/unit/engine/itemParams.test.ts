// Every held item's numbers come from the ROM's item data (src/rom/items.ts, bytes 2 and 3), not Showdown's or vanilla's
// constants: each case runs the fixture's hack parameters (fixtures.ts `ROM_ITEM_HOLD`) and a copy whose ROM says
// something else, to show the handler reads the ROM. bl = battle_lib.c, bcp = battle_controller_player.c.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BattleInput, Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import { createBattle, restore, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { assertItemData, heldData, heldParam, STALE_ITEM_DATA } from '../../../src/engine/mod/itemData.js';
import { belowWeight } from '../../../src/engine/odds.js';
import { add, rat, type Rational, ZERO } from '../../../src/engine/rational.js';
import { buildMoves } from '../../../src/battle/moves.js';
import { decodeItem } from '../../../src/rom/items.js';
import { ABILITY, BAG, fixtureData, fixtureDex, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const base = fixtureDex();
beforeAll(() => installKaizoDex(base.data, base.moves));
afterAll(() => installKaizoDex(base.data, base.moves));

type Patch = Record<number, [number, number]>;
/** Runs `run` with a fixture dex whose ROM item data says `patch` (item -> [hold effect, parameter]), then reinstalls the fixture's. */
function withItems<T>(patch: Patch, run: () => T): T {
  const alt = fixtureDex();
  for (const [item, [holdEffect, holdParam]] of Object.entries(patch)) alt.data.rom.items[Number(item)] = { ...alt.data.rom.items[Number(item)]!, holdEffect, holdParam };
  installKaizoDex(alt.data, alt.moves);
  try {
    return run();
  } finally {
    installKaizoDex(base.data, base.moves);
  }
}

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH_FIRST = { p1: move(0), p2: move(0) };
const draws = (weight: bigint | number): Rational => rat(BigInt(weight), 65536n);
const chanceOf = (outcomes: Outcome[], test: (outcome: Outcome) => boolean): Rational => outcomes.filter(test).reduce((total, outcome) => add(total, outcome.probability), ZERO);
const foe = (outcome: Outcome | EngineState) => restore('state' in outcome ? outcome.state : outcome).p2.active[0]!;
const mine = (outcome: Outcome | EngineState) => restore('state' in outcome ? outcome.state : outcome).p1.active[0]!;
const foeHp = (state: EngineState, hp: number) => {
  const battle = restore(state);
  battle.p2.active[0]!.hp = hp;
  return snapshot(battle);
};
const duel = (player: ReturnType<typeof playerMon>, theirs: ReturnType<typeof resolvedMon>): BattleInput => ({ player: [player], trainer: resolvedTrainer(BAG.none, [theirs]), field: {} });
const monferno = (moves: number[], fields: Partial<ReturnType<typeof playerMon>> = {}) => playerMon(ID.monferno, 30, moves, fields);
const zigzagoon = (moves: number[], fields: Partial<ReturnType<typeof resolvedMon>> = {}) => resolvedMon(ID.zigzagoon, 20, moves, fields);
const deoxys = (moves: number[], fields: Partial<ReturnType<typeof resolvedMon>> = {}) => resolvedMon(ID.deoxys, 50, moves, fields);

describe('the ROM item data', () => {
  it('decodeItem reads the hold effect and its parameter, bytes 2 and 3 of the entry (include/item.h:56-77)', () => {
    const entry = new Uint8Array(36);
    entry.set([0, 0, 56, 11], 0);
    entry[6] = 30;
    expect(decodeItem(221, entry)).toEqual({ id: 221, flingPower: 30, holdEffect: 56, holdParam: 11 });
  });

  it('refuses ROM data from an older extract, which lacks the fields, instead of reading vanilla\'s numbers', () => {
    const stale = fixtureData();
    stale.rom.items[221] = { id: 221, flingPower: 30 };
    expect(() => assertItemData(stale)).toThrow(STALE_ITEM_DATA);
    expect(() => installKaizoDex(stale, buildMoves(stale))).toThrow(STALE_ITEM_DATA);
  });

  it('heldData and heldParam read the installed ROM by Showdown ID: the hack\'s King\'s Rock is 11, Ganlon\'s 0', () => {
    expect(heldData('kingsrock')).toEqual({ effect: 56, param: 11 });
    expect(['razorfang', 'ganlonberry', 'shoalsalt'].map((id) => heldParam(id, 99))).toEqual([10, 0, 0]);
    expect(withItems({ 221: [56, 25] }, () => heldParam('kingsrock', 99))).toBe(25);
  });
});

describe('chance items read their parameter', () => {
  const flinch = () => chanceOf(expandTurn(createBattle(duel(monferno([ID.tackle], { item: ITEM.kingsRock }), zigzagoon([ID.leechSeed]))), BOTH_FIRST), (o) => o.log.includes('|cant|p2a: Zigzagoon|flinch'));
  const fang = () => chanceOf(expandTurn(createBattle(duel(monferno([ID.tackle], { item: ITEM.razorFang }), zigzagoon([ID.leechSeed]))), BOTH_FIRST), (o) => o.log.includes('|cant|p2a: Zigzagoon|flinch'));
  const endure = () => chanceOf(expandTurn(foeHp(createBattle(duel(monferno([ID.tackle]), zigzagoon([ID.meanLook], { item: ITEM.focusBand }))), 1), BOTH_FIRST), (o) => foe(o).hp === 1);
  const claw = () => chanceOf(expandTurn(createBattle(duel(monferno([ID.tackle]), zigzagoon([ID.leechSeed], { item: ITEM.quickClaw }))), BOTH_FIRST),
    (o) => o.log.includes('|-activate|p2a: Zigzagoon|item: Quick Claw'));
  // King's Rock, Razor Fang and Focus Band: r % 100 below the parameter (bcp:4645-4669, :3386-3388); Quick Claw:
  // speedRand % (100 / parameter) == 0 (bl:1279, :1345).
  it.each<[string, () => Rational, Patch, Rational]>([
    ['King\'s Rock, the hack\'s 11', flinch, {}, draws(belowWeight(100, 11))], ['King\'s Rock at 25', flinch, { 221: [56, 25] }, draws(belowWeight(100, 25))],
    ['Razor Fang, 10', fang, {}, draws(belowWeight(100, 10))], ['Razor Fang at 40', fang, { 327: [56, 40] }, draws(belowWeight(100, 40))],
    ['Focus Band, 10', endure, {}, draws(belowWeight(100, 10))], ['Focus Band at 30', endure, { 230: [65, 30] }, draws(belowWeight(100, 30))],
    ['Quick Claw, 20: 1 in 5', claw, {}, rat(13108, 65536)], ['Quick Claw at 50: 1 in 2', claw, { 217: [52, 50] }, rat(32768, 65536)],
  ])('%s', (_, chance, patch, expected) => expect(withItems(patch, chance)).toEqual(expected));
});

describe('weather rocks and Light Clay: 5 turns plus the ROM\'s parameter (effect_script_0136.s:12-14; bs:4229, :4272)', () => {
  const durations = (moveId: number, item: number | undefined, patch: Patch = {}) => withItems(patch, () => {
    const state = createBattle(duel(playerMon(ID.deoxys, 50, [moveId], { ability: knownAbility(ABILITY.battleArmor), ...(item === undefined ? {} : { item }) }), deoxys([ID.howl])));
    return [...new Set(expandTurn(state, BOTH_FIRST).map((outcome) => {
      const battle = restore(outcome.state);
      return (moveId === ID.lightScreen ? battle.p1.sideConditions['lightscreen']?.['duration'] : battle.field.weatherState['duration']) as number | undefined;
    }))];
  });
  // One turn is used up by the turn that set it.
  it.each<[string, number, number | undefined, Patch, number]>([
    ['Rain Dance, bare', ID.rainDance, undefined, {}, 4], ['Rain Dance, Damp Rock at the hack\'s 7', ID.rainDance, ITEM.dampRock, {}, 11],
    ['Rain Dance, Damp Rock at 2', ID.rainDance, ITEM.dampRock, { 285: [113, 2] }, 6], ['Sunny Day, Heat Rock', ID.sunnyDay, ITEM.heatRock, {}, 11],
    ['Sandstorm, Smooth Rock', ID.sandstorm, ITEM.smoothRock, {}, 11], ['Hail, Icy Rock', ID.hail, ITEM.icyRock, {}, 11], ['Hail, Icy Rock at 4', ID.hail, ITEM.icyRock, { 282: [110, 4] }, 8],
    ['Light Screen, bare', ID.lightScreen, undefined, {}, 4], ['Light Screen, Light Clay at 3', ID.lightScreen, ITEM.lightClay, {}, 7],
    ['Light Screen, Light Clay at 6', ID.lightScreen, ITEM.lightClay, { 269: [97, 6] }, 10],
  ])('%s', (_, moveId, item, patch, turns) => expect(durations(moveId, item, patch)).toEqual([turns]));
});

describe('type-boosting items and Plates (bl:6716-6721)', () => {
  it('a Plate raises its type by (100 + 50) / 100 in the hack (vanilla 20: 1.2), as the ROM says; another type\'s does nothing', () => {
    /** The most damage Monferno's Ember does to a Deoxys, holding `item`. */
    const best = (item: number | undefined, patch: Patch = {}) => withItems(patch, () => {
      const state = createBattle(duel(monferno([ID.ember], item === undefined ? {} : { item }), deoxys([ID.meanLook])));
      return Math.max(...expandTurn(state, BOTH_FIRST).map((outcome) => foe(state).hp - foe(outcome).hp));
    });
    const none = best(undefined);
    const ratios = [best(ITEM.flamePlate), best(ITEM.flamePlate, { 298: [126, 20] }), best(ITEM.flamePlate, { 298: [126, 100] })].map((damage) => damage / none);
    expect([ratios[0]! > 1.4 && ratios[0]! < 1.6, ratios[1]! < 1.25, ratios[2]! > 1.8]).toEqual([true, true, true]);
    expect(best(ITEM.splashPlate)).toBe(none);
  });
});

describe('healing and recoil berries', () => {
  /** The HP the trainer's Deoxys at 20 HP holding `item` gains in a turn of nothing. */
  const healed = (item: number, patch: Patch = {}) => withItems(patch, () =>
    [...new Set(expandTurn(foeHp(createBattle(duel(monferno([ID.growl]), deoxys([ID.growl], { item }))), 20), BOTH_FIRST).map((outcome) => foe(outcome).hp - 20))]);
  const maxhp = () => foe(createBattle(duel(monferno([ID.growl]), deoxys([ID.growl])))).maxhp;
  // Oran Berry and Berry Juice heal their parameter, Shoal Shell 100 at half HP or less, Sitrus Berry max HP x parameter / 100.
  it.each<[string, number, Patch, () => number]>([
    ['Oran Berry, 10', ITEM.oranBerry, {}, () => 10], ['Oran Berry at 40', ITEM.oranBerry, { 155: [1, 40] }, () => 40],
    ['Berry Juice, 20', ITEM.berryJuice, {}, () => 20], ['Berry Juice at 30', ITEM.berryJuice, { 43: [1, 30] }, () => 30],
    ['Shoal Shell, 100', ITEM.shoalShell, {}, () => 100], ['Shoal Shell at 60', ITEM.shoalShell, { 71: [1, 60] }, () => 60],
    ['Sitrus Berry, a quarter', ITEM.sitrusBerry, {}, () => Math.floor(maxhp() * 25 / 100)], ['Sitrus Berry at 50', ITEM.sitrusBerry, { 158: [13, 50] }, () => Math.floor(maxhp() * 50 / 100)],
  ])('%s', (_, item, patch, heal) => expect(healed(item, patch)).toEqual([heal()]));

  it('Jaboca Berry costs a physical attacker max HP / its parameter (6 in the hack, vanilla 8), Rowap Berry a special attacker', () => {
    const lost = (item: number, attack: number, patch: Patch = {}) => withItems(patch, () => {
      const state = createBattle(duel(monferno([attack]), deoxys([ID.growl], { item })));
      return [...new Set(expandTurn(state, BOTH_FIRST).filter((outcome) => foe(outcome).item === '').map((outcome) => mine(state).hp - mine(outcome).hp))];
    });
    const max = mine(createBattle(duel(monferno([ID.tackle]), deoxys([ID.growl])))).maxhp;
    expect([lost(ITEM.jabocaBerry, ID.tackle), lost(ITEM.jabocaBerry, ID.tackle, { 211: [46, 4] }), lost(ITEM.rowapBerry, ID.ember), lost(ITEM.jabocaBerry, ID.ember)])
      .toEqual([[Math.floor(max / 6)], [Math.floor(max / 4)], [Math.floor(max / 6)], []]); // the wrong class leaves it alone
  });
});
