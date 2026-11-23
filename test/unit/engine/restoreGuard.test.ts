// The engine's guard on Showdown's restore of a Transformed Pokémon with more moves of its own than it copied
// (src/engine/restoreGuard.ts), on which Showdown's `State.deserializePokemon` threw: a restore gives the battle the live
// one holds (key, legal choices, continuations), on the player's side and the trainer's.

import PS from 'pokemon-showdown';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Choice } from '../../../src/contracts/engine.js';
import { applyChoices, choicesIn, createBattle, restore, snapshot } from '../../../src/engine/battle.js';
import { ChanceDriver, nextScript } from '../../../src/engine/chance.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { carryOut, legalChoices } from '../../../src/engine/index.js';
import { applyLevel } from '../../../src/engine/levelUp.js';
import { BAG, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
fixture.data.rom.learnsets[ID.monferno] = [{ move: ID.slash, level: 34 }];
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));
const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH_FIRST = { p1: move(0), p2: move(0) };

/** `battle`'s requests made again, as a restore makes them (facts.ts `remakeRequests`), after a change between steps. */
function remakeRequests(battle: Battle): Battle {
  const requests = battle.getRequests(battle.requestState);
  battle.sides.forEach((side, i) => {
    if (side.activeRequest !== null) side.activeRequest = requests[i]!;
  });
  return battle;
}

/**
 * The player's Monferno (Ember, Tackle) Transformed into the trainer's two-move Zigzagoon, then levelled to 34, whose Slash it
 * learns into its own free slot (`applyLevel`): three moves of its own, two copied. A live battle drawing through `driver`.
 */
function playerSide(driver: ChanceDriver): Battle {
  const battle = restore(createBattle({
    player: [playerMon(ID.monferno, 33, [ID.ember, ID.tackle]), playerMon(ID.bidoof, 25, [ID.tackle])],
    trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 60, [ID.growl, ID.leer])]), field: {},
  }), driver);
  const mine = battle.p1.active[0]!;
  expect(mine.transformInto(battle.p2.active[0]!)).toBe(true);
  expect(applyLevel(battle, mine, 34).learned).toEqual([ID.slash]);
  return remakeRequests(battle);
}

/**
 * The trainer's four-move Zigzagoon (a Smeargle's Transform and three other moves, in the hack) Transformed into the player's
 * one-move Bidoof: four moves of its own, one copied. No level-up. A live battle drawing through `driver`.
 */
function enemySide(driver: ChanceDriver): Battle {
  const battle = restore(createBattle({
    player: [playerMon(ID.bidoof, 25, [ID.tackle]), playerMon(ID.monferno, 30, [ID.ember])],
    trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 30, [ID.growl, ID.leer, ID.bite, ID.tackle])]), field: {},
  }), driver);
  expect(battle.p2.active[0]!.transformInto(battle.p1.active[0]!)).toBe(true);
  return remakeRequests(battle);
}

/**
 * Every chance of one step with `choices`, run twice with the same draws: on the live battle `make` builds, and on a
 * restore of its snapshot (as `expandTurn` runs it). The keys each reached, and how many pairs differed.
 */
function liveAgainstRestored(make: (driver: ChanceDriver) => Battle, choices: { p1?: Choice; p2?: Choice }): { live: Set<string>; differ: number } {
  const state = snapshot(make(new ChanceDriver([])));
  const live = new Set<string>();
  let differ = 0;
  for (let script: number[] | null = []; script !== null;) {
    const driver = new ChanceDriver(script);
    const battle = make(driver);
    applyChoices(battle, choices);
    const liveKey = snapshot(battle).key;
    const restored = restore(state, new ChanceDriver(script));
    applyChoices(restored, choices);
    if (snapshot(restored).key !== liveKey) differ++;
    live.add(liveKey);
    script = nextScript(driver.points);
  }
  return { live, differ };
}

describe('a Transformed Pokémon with more moves of its own than it copied restores as the live battle holds it', () => {
  it.each([
    ['the player\'s side: a free-slot move learned while Transformed', playerSide], ['the trainer\'s side: a Transform into a Pokémon with fewer moves', enemySide],
  ] as const)('%s: same key, moves and legal choices; every continuation reaches the live key, as expandTurn finds', (_, make) => {
    const live = make(new ChanceDriver([]));
    const state = snapshot(live);
    const restored = restore(state);
    expect(snapshot(restored).key).toBe(state.key);
    const slots = (mon: Pokemon) => [mon.baseMoveSlots.map((s) => [s.id, s.pp]), mon.moveSlots.map((s) => [s.id, s.pp, s.virtual ?? false])];
    for (const side of ['p1', 'p2'] as const) {
      expect(slots(restored[side].active[0]!)).toEqual(slots(live[side].active[0]!));
      expect(legalChoices(state, side)).toEqual(choicesIn(live, side));
    }
    const { live: keys, differ } = liveAgainstRestored(make, BOTH_FIRST);
    expect([keys.size > 0, differ]).toEqual([true, 0]);
    expect(new Set(expandTurn(snapshot(make(new ChanceDriver([]))), BOTH_FIRST).map((o) => o.state.key))).toEqual(keys);
  });

  it("expandTurn's leaves keep the carry of the player's Transformed Pokémon: carryOut restores nothing, and agrees with a restore (facts.ts restoredBaseSlots)", () => {
    const leaves = expandTurn(snapshot(playerSide(new ChanceDriver([]))), BOTH_FIRST);
    expect(leaves.length).toBeGreaterThan(0);
    const fromJSON = vi.spyOn(PS.Battle, 'fromJSON');
    try {
      const cached = leaves.map((leaf) => carryOut(leaf.state));
      expect(fromJSON).toHaveBeenCalledTimes(0);
      expect(leaves.map((leaf) => carryOut({ ...leaf.state }))).toEqual(cached);
      expect(cached[0]!.mons[0]!.pp).toHaveLength(3);
    } finally {
      fromJSON.mockRestore();
    }
  });
});
