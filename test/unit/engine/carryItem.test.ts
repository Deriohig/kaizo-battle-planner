// A gauntlet carries each Pokémon's held item (`CarryState.mons[].item`): the cartridge writes the battler's held item
// back to the party at every `BattleMon_CopyToParty` (bl:1819-1826, battle_io_command.c:590-592), so an item used up
// stays used up; a Knocked Off item comes back (knockOff.test.ts).

import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { BattleInput, CarryState, Choice, EngineState } from '../../../src/contracts/engine.js';
import { carryOut, createBattle, PICKUP_NOTE, restore, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { unmodelledIn } from '../../../src/engine/facts.js';
import { BAG, fixtureDex, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH = { p1: move(0), p2: move(0) };
const FOCUS_SASH = 275;
const PICKUP = 53;
const HONEY_GATHER = 118;

const input = (player: PlayerMon[], enemyMoves: number[], fields: Partial<BattleInput> = {}, enemyLevel = 50): BattleInput => ({
  player, trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.deoxys, enemyLevel, enemyMoves)]), field: {}, ...fields,
});
/** The next fight of a gauntlet: `next` with `previous`'s carry. */
const nextFight = (next: BattleInput, previous: EngineState): EngineState => createBattle({ ...next, carry: carryOut(previous) });
const heldItem = (state: EngineState) => restore(state).p1.active[0]!.item;
const logged = (prefix: string) => (outcome: { log: string[] }) => outcome.log.some((line) => line.startsWith(prefix));

describe('carryOut writes the held item', () => {
  it('an untouched item is carried as its ROM item ID, no item as 0, for every party Pokémon', () => {
    expect(carryOut(createBattle(input([playerMon(ID.monferno, 30, [ID.tackle], { item: ITEM.leftovers }), playerMon(ID.zigzagoon, 20, [ID.tackle])], [ID.growl]))).mons.map((mon) => mon.item))
      .toEqual([ITEM.leftovers, 0]);
  });

  it('a Sitrus Berry eaten in fight 1 (on coming in at a third of its HP) is gone in fight 2, with no second heal', () => {
    const lead = playerMon(ID.monferno, 30, [ID.tackle], { item: ITEM.sitrusBerry });
    const hurt = { ...lead, currentHp: Math.floor(lead.currentHp / 3) };
    const first = createBattle(input([hurt], [ID.growl]));
    const second = nextFight(input([hurt], [ID.growl]), first);
    expect([heldItem(first), carryOut(first).mons[0]!.item, heldItem(second), restore(second).p1.active[0]!.hp]).toEqual(['', 0, '', carryOut(first).mons[0]!.hp]);
  });

  it('a Focus Sash used up is gone; one that was not used stays', () => {
    const party = () => [playerMon(ID.zigzagoon, 5, [ID.tackle], { item: FOCUS_SASH }), playerMon(ID.monferno, 30, [ID.tackle])];
    const outcomes = expandTurn(createBattle(input(party(), [ID.megaKick])), BOTH);
    const used = outcomes.filter(logged('|-enditem|p1a: Zigzagoon|Focus Sash'));
    const missed = outcomes.filter(logged('|-miss|p2a: Deoxys'));
    expect([used.length > 0, missed.length > 0]).toEqual([true, true]);
    for (const outcome of used) expect([carryOut(outcome.state).mons[0]!.item, heldItem(nextFight(input(party(), [ID.megaKick]), outcome.state))]).toEqual([0, '']);
    for (const outcome of missed) expect(carryOut(outcome.state).mons[0]!.item).toBe(FOCUS_SASH);
  });

  it('a carry\'s item replaces the save\'s: 0 starts with none (a heal brings nothing back), another item is held, an absent one is the save\'s', () => {
    const lead = playerMon(ID.monferno, 30, [ID.tackle], { item: ITEM.sitrusBerry });
    const carried = (item?: number) => heldItem(createBattle(input([lead], [ID.growl], {
      carry: { mons: [{ hp: lead.currentHp, pp: [...lead.pp], status: { kind: 'none' }, ...(item === undefined ? {} : { item }) }] },
    })));
    expect([carried(0), carried(ITEM.leftovers), carried()]).toEqual(['', 'leftovers', 'sitrusberry']);
  });

  it('Bug Bite: the berry the foe ate is gone (bs:8116-8143, :8976-8981); an item gained in the fight is kept', () => {
    const eaten = expandTurn(createBattle(input([playerMon(ID.monferno, 30, [ID.growl], { item: ITEM.sitrusBerry })], [ID.bugBite], {}, 30)), BOTH)
      .filter(logged('|-enditem|p1a: Monferno|Sitrus Berry'));
    expect(eaten.length).toBeGreaterThan(0);
    for (const outcome of eaten) expect(carryOut(outcome.state).mons[0]!.item).toBe(0);
    const battle = restore(createBattle(input([playerMon(ID.monferno, 30, [ID.growl])], [ID.growl])));
    const mon = battle.p1.active[0]!;
    mon.item = 'leftovers' as ID;
    mon.itemState = battle.initEffectState({ id: 'leftovers', target: mon });
    expect(carryOut(snapshot(battle)).mons[0]!.item).toBe(ITEM.leftovers);
  });

  it('the carry\'s item survives a restore of a mid-fight state and the cached reader alike', () => {
    for (const outcome of expandTurn(createBattle(input([playerMon(ID.monferno, 30, [ID.growl], { item: ITEM.leftovers })], [ID.knockOff], {}, 30)), BOTH)) {
      expect(carryOut({ ...outcome.state })).toEqual(carryOut(outcome.state)); // a copy is read from a restore
    }
  });
});

describe('Pickup and Honey Gather between fights (bs:7781-7848)', () => {
  // A carry where such a Pokémon holds nothing came from an earlier fight whose end could have given it an item: noted. A
  // carry with no item field is a first fight's (the save's item), so nothing came before.
  const holder = (ability: number) => playerMon(ID.zigzagoon, 20, [ID.tackle], { ability: knownAbility(ability) });
  const noted = (ability: number, carry: number | undefined | 'none') => unmodelledIn(createBattle(input([holder(ability)], [ID.growl], carry === 'none' ? {} : {
    carry: { mons: [{ hp: holder(ability).currentHp, pp: [...holder(ability).pp], status: { kind: 'none' }, ...(carry === undefined ? {} : { item: carry }) }] },
  }))).includes(PICKUP_NOTE);
  it.each<[string, number, number | undefined | 'none', boolean]>([
    ['Pickup holding nothing', PICKUP, 0, true], ['Pickup holding an item', PICKUP, ITEM.leftovers, false], ['Pickup with no carry', PICKUP, 'none', false],
    ['Pickup with a first fight\'s carry (no item field)', PICKUP, undefined, false],
    ['Honey Gather holding nothing', HONEY_GATHER, 0, true], ['Honey Gather holding an item', HONEY_GATHER, ITEM.leftovers, false],
    ['Honey Gather with a first fight\'s carry', HONEY_GATHER, undefined, false],
  ])('%s', (_, ability, carry, expected) => expect(noted(ability, carry)).toBe(expected));

  it('a real second fight still gets the note: carryOut writes the item, 0 for none', () => {
    expect(unmodelledIn(nextFight(input([holder(PICKUP)], [ID.growl]), createBattle(input([holder(PICKUP)], [ID.growl]))))).toContain(PICKUP_NOTE);
  });
});
