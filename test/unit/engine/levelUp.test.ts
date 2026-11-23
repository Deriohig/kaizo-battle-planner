// `levelUp` and `applyLevel` (src/engine/levelUp.ts): a level-up of one of the player's Pokémon, checked against a battle
// created with `atLevel(mon, L)` and against the cartridge's level-up task (bl:169-194, pk:3935-3964, bs:9824-10037).

import { beforeAll, describe, expect, it } from 'vitest';
import { atLevel } from '../../../src/battle/playerMon.js';
import type { BattleInput, Choice, EngineState } from '../../../src/contracts/engine.js';
import { snapshot } from '../../../src/engine/battle.js';
import { createBattle, expandTurn, installKaizoDex, legalChoices, restore } from '../../../src/engine/index.js';
import { applyLevel, levelUp } from '../../../src/engine/levelUp.js';
import { BAG, FIXTURE_MOVES, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
// Invented learnsets: Monferno at 34 Ember (known: skipped) and Slash, at 35 Leer and Bite, at 36 Howl; Deoxys Leer at 51
// on its own row, Slash at 51 on Deoxys-Attack's (496); Charmander at 11 a move the installed dex lacks.
fixture.data.rom.learnsets[ID.monferno] = [
  { move: ID.ember, level: 34 }, { move: ID.slash, level: 34 }, { move: ID.leer, level: 35 }, { move: ID.bite, level: 35 }, { move: ID.howl, level: 36 },
];
fixture.data.rom.learnsets[ID.deoxys] = [{ move: ID.leer, level: 51 }];
fixture.data.rom.learnsets[496] = [{ move: ID.slash, level: 51 }];
const MISSING_MOVE = 500;
fixture.data.rom.learnsets[ID.charmander] = [{ move: MISSING_MOVE, level: 11 }];
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));
const move = (slot: number): Choice => ({ kind: 'move', slot });

type Mon = ReturnType<typeof playerMon>;
const monferno = playerMon(ID.monferno, 30, [ID.ember, ID.tackle]);
const monferno33 = playerMon(ID.monferno, 33, [ID.ember, ID.tackle]);
const bidoof = playerMon(ID.bidoof, 25, [ID.tackle]);
const input = (enemy = resolvedMon(ID.zigzagoon, 60, [ID.growl])): BattleInput => ({ player: [monferno, bidoof], trainer: resolvedTrainer(BAG.none, [enemy]), field: {} });
/** A battle whose lead is `lead` (bench: Bidoof), against `enemy`. */
const leading = (lead: Mon, enemy?: ReturnType<typeof resolvedMon>): EngineState => createBattle({ ...input(enemy), player: [lead, bidoof] });
const mine = (state: EngineState, index = 0) => {
  const side = restore(state).p1;
  return side.pokemon.find((p) => side.team.indexOf(p.set) === index)!;
};
const ids = (slots: { id: string }[]) => slots.map((s) => s.id);
/** Level, stats and HP fields of a Pokémon, to compare with a fresh one. */
const statsOf = (mon: Pokemon) => ({ maxhp: mon.maxhp, baseMaxhp: mon.baseMaxhp, stored: mon.storedStats, base: mon.baseStoredStats, details: mon.details });
const ownAt = (mon: Mon, level: number) => mine(leading(atLevel(mon, level)));
/** The first turn-choice state after Monferno's Tackle against Growl: hurt, and its Attack at -1. */
const afterGrowl = (state: EngineState) => expandTurn(state, { p1: move(1), p2: move(0) }).find((o) => o.state.phase.kind === 'turnChoice')!.state;
const fainted = () => expandTurn(createBattle(input(resolvedMon(ID.zigzagoon, 100, [ID.megaKick]))), { p1: move(1), p2: move(0) })
  .find((o) => o.state.phase.kind === 'playerReplacement')!.state;

/** `state` after `edit` on the player's active Pokémon of a restore. */
function edited(state: EngineState, edit: (battle: Battle) => void): EngineState {
  const battle = restore(state);
  edit(battle);
  return snapshot(battle);
}
const transformed = (state: EngineState) => edited(state, (b) => { if (!b.p1.active[0]!.transformInto(b.p2.active[0]!)) throw new Error('The transform failed'); });
const powerTricked = (state: EngineState) => edited(state, (b) => { b.actions.useMove('powertrick', b.p1.active[0]!); });

describe('levelUp', () => {
  it('gives the stats and max HP of a Pokémon created at that level, for the lead and the bench alike', () => {
    for (const [index, base] of [[0, monferno], [1, bidoof]] as const) {
      const up = mine(levelUp(createBattle(input()), index, base.level + 3), index);
      const fresh = mine(createBattle({ ...input(), player: [index === 0 ? atLevel(monferno, 33) : monferno, index === 1 ? atLevel(bidoof, 28) : bidoof] }), index);
      expect([up.level, up.set.level]).toEqual([base.level + 3, base.level + 3]);
      expect(statsOf(up)).toEqual(statsOf(fresh));
    }
  });

  it('raises the HP by the max HP gained, keeps the damage taken, stages, PP and turn, and changes the key', () => {
    const hurt = afterGrowl(createBattle(input()));
    const before = mine(hurt);
    expect(before.boosts.atk).toBe(-1);
    const up = levelUp(hurt, 0, 33);
    const after = mine(up);
    expect(after.maxhp - before.maxhp).toBeGreaterThan(0);
    expect([after.hp, after.boosts.atk, after.moveSlots.map((s) => [s.id, s.pp]), restore(up).turn])
      .toEqual([before.hp + after.maxhp - before.maxhp, -1, before.moveSlots.map((s) => [s.id, s.pp]), restore(hurt).turn]);
    expect(up.key).not.toBe(hurt.key);
    expect(up.key).toBe(levelUp(hurt, 0, 33).key);
  });

  it('learns a move: it replaces a slot at full PP with no PP Ups, or is added when there is room', () => {
    const state = createBattle(input());
    const replaced = mine(levelUp(state, 0, 31, { moveId: ID.slash, replaceSlot: 1 }));
    const pp = fixture.data.rom.moves[ID.slash]!.pp;
    expect([ids(replaced.baseMoveSlots), ids(replaced.moveSlots), replaced.set.moves, replaced.moveSlots[1]!.pp, replaced.moveSlots[1]!.maxpp, replaced.ppUps[1]])
      .toEqual([['ember', 'slash'], ['ember', 'slash'], ['ember', 'slash'], pp, pp, 0]);
    const added = levelUp(state, 0, 31, { moveId: ID.slash, replaceSlot: null });
    expect(ids(mine(added).baseMoveSlots)).toEqual(['ember', 'tackle', 'slash']);
    expect(legalChoices(added, 'p1').filter((c) => c.kind === 'move')).toHaveLength(3);
  });

  it.each<[string, () => EngineState, number, number, { moveId: number; replaceSlot: number | null }?]>([
    ['a level not above the current one', () => createBattle(input()), 0, 30],
    ['a level over 100', () => createBattle(input()), 0, 101],
    ['a level that is no whole number', () => createBattle(input()), 0, 31.5],
    ['a bad party index', () => createBattle(input()), 5, 31],
    ['a bad slot', () => createBattle(input()), 0, 31, { moveId: ID.slash, replaceSlot: 4 }],
    ['a move added with four known', () => leading(playerMon(ID.monferno, 30, [ID.ember, ID.tackle, ID.growl, ID.meanLook])), 0, 31, { moveId: ID.slash, replaceSlot: null }],
    ['a fainted Pokémon', fainted, 0, 40],
    ['a chosen move it knows before the level-up', () => createBattle(input()), 0, 31, { moveId: ID.ember, replaceSlot: null }],
    ['a chosen move the level-up learned into a free slot', () => leading(monferno33), 0, 34, { moveId: ID.slash, replaceSlot: 0 }],
    ['a chosen move for a free slot when the level\'s own move took the last one', () => leading(playerMon(ID.monferno, 33, [ID.ember, ID.tackle, ID.growl])), 0, 34,
      { moveId: ID.uTurn, replaceSlot: null }],
    ['a slot past the moves an earlier level filled', () => leading(playerMon(ID.monferno, 33, [ID.ember, ID.tackle, ID.growl])), 0, 35, { moveId: ID.leer, replaceSlot: 4 }],
  ])('refuses %s', (_, start, index, level, move) => expect(() => levelUp(start(), index, level, move)).toThrow(RangeError));

  it('accepts a move added into a free slot, and the bench Pokémon of a battle whose lead fainted', () => {
    expect(() => levelUp(createBattle(input()), 0, 31, { moveId: ID.slash, replaceSlot: null })).not.toThrow();
    expect(() => levelUp(fainted(), 1, 40)).not.toThrow();
  });
});

describe('levelUp, as the cartridge levels an active battler', () => {
  it('a Transformed Pokémon gets its own new stats, level and HP back; the copied moves, types, ability and species stay', () => {
    const state = transformed(createBattle(input(resolvedMon(ID.zigzagoon, 60, [ID.growl, ID.leer, ID.bite]))));
    const before = mine(state);
    expect(before.transformed).toBe(true);
    expect(before.storedStats.atk).not.toBe(before.baseStoredStats!.atk);
    const after = mine(levelUp(state, 0, 33));
    const own = mine(createBattle({ ...input(), player: [atLevel(monferno, 33), bidoof] }));
    expect(statsOf(after)).toEqual(statsOf(own));
    expect([after.level, after.hp, after.speed]).toEqual([33, before.hp + own.maxhp - before.maxhp, own.speed]);
    expect([after.transformed, after.species.id, after.getTypes(), after.ability, ids(after.moveSlots)])
      .toEqual([true, 'zigzagoon', before.getTypes(), before.ability, ['growl', 'leer', 'bite']]);
  });

  it('a Transformed Pokémon learns a move into its own free slot, not into the copied moves, whatever the copy holds', () => {
    const copying = (lead: Mon, moves: number[]) => transformed(leading(lead, resolvedMon(ID.zigzagoon, 60, moves)));
    // The free slot is counted on its own moves: a copy of four still leaves it room.
    const names: Record<number, string> = { [ID.growl]: 'growl', [ID.leer]: 'leer', [ID.bite]: 'bite', [ID.tackle]: 'tackle' };
    for (const copy of [[ID.growl, ID.leer], [ID.growl, ID.leer, ID.bite], [ID.growl, ID.leer, ID.bite, ID.tackle]]) {
      const forced = mine(levelUp(copying(monferno33, copy), 0, 34));
      expect([ids(forced.baseMoveSlots), forced.set.moves, ids(forced.moveSlots)])
        .toEqual([['ember', 'tackle', 'slash'], ['ember', 'tackle', 'slash'], copy.map((id) => names[id])]);
    }
    const chosen = mine(levelUp(copying(monferno, [ID.growl, ID.leer]), 0, 31, { moveId: ID.uTurn, replaceSlot: null }));
    expect([ids(chosen.baseMoveSlots), ids(chosen.moveSlots)]).toEqual([['ember', 'tackle', 'uturn'], ['growl', 'leer']]);
  });

  it('Power Trick: the level-up\'s natural stats overwrite the swap and the volatile stays; Power Trick again swaps them and ends it', () => {
    const tricked = powerTricked(createBattle(input()));
    const swapped = mine(tricked);
    expect([!!swapped.volatiles['powertrick'], swapped.storedStats.atk, swapped.storedStats.def]).toEqual([true, swapped.baseStoredStats!.def, swapped.baseStoredStats!.atk]);
    const up = levelUp(tricked, 0, 33);
    const own = mine(createBattle({ ...input(), player: [atLevel(monferno, 33), bidoof] }));
    expect([!!mine(up).volatiles['powertrick'], mine(up).storedStats.atk, mine(up).storedStats.def]).toEqual([true, own.storedStats.atk, own.storedStats.def]);
    const again = mine(powerTricked(up));
    expect([!!again.volatiles['powertrick'], again.storedStats.atk, again.storedStats.def]).toEqual([false, own.storedStats.def, own.storedStats.atk]);
  });

  it('a move at the new level with a free slot is learned with no prompt, at full PP, usable at once; a known one is skipped; full HP stays full', () => {
    const up = levelUp(leading(monferno33), 0, 34);
    const after = mine(up);
    const pp = fixture.data.rom.moves[ID.slash]!.pp;
    expect([ids(after.baseMoveSlots), ids(after.moveSlots), after.set.moves]).toEqual(Array(3).fill(['ember', 'tackle', 'slash']));
    expect(after.moveSlots[2]).toBe(after.baseMoveSlots[2]);
    expect([after.moveSlots[2]!.pp, after.moveSlots[2]!.maxpp, after.ppUps[2], after.hp, after.maxhp]).toEqual([pp, pp, 0, ownAt(monferno33, 34).maxhp, ownAt(monferno33, 34).maxhp]);
    expect(legalChoices(up, 'p1').filter((c) => c.kind === 'move')).toHaveLength(3);
    // The line builder's choice of the move the cartridge learned anyway changes nothing.
    expect(levelUp(leading(monferno33), 0, 34, { moveId: ID.slash, replaceSlot: null }).key).toBe(up.key);
  });

  it('with four moves known the move is offered and declined; the line builder may still take it over a slot, even one an earlier level filled', () => {
    const full = leading(playerMon(ID.monferno, 33, [ID.ember, ID.tackle, ID.growl, ID.meanLook]));
    expect(ids(mine(levelUp(full, 0, 34)).baseMoveSlots)).toEqual(['ember', 'tackle', 'growl', 'meanlook']);
    expect(ids(mine(levelUp(full, 0, 34, { moveId: ID.slash, replaceSlot: 2 })).baseMoveSlots)).toEqual(['ember', 'tackle', 'slash', 'meanlook']);
    const three = leading(playerMon(ID.monferno, 33, [ID.ember, ID.tackle, ID.growl]));
    expect(ids(mine(levelUp(three, 0, 35, { moveId: ID.leer, replaceSlot: 3 })).baseMoveSlots)).toEqual(['ember', 'tackle', 'growl', 'leer']);
  });

  it('several levels in one go are one loop step each: each level\'s moves in order, the last level\'s stats and HP', () => {
    const hurt = afterGrowl(leading(monferno33));
    const jump = levelUp(hurt, 0, 36);
    const after = mine(jump);
    // 34's and 35's first moves fill the slots; Bite and 36's Howl are offered.
    expect([after.level, ids(after.baseMoveSlots), after.storedStats]).toEqual([36, ['ember', 'tackle', 'slash', 'leer'], ownAt(monferno33, 36).storedStats]);
    expect(after.hp).toBe(mine(hurt).hp + ownAt(monferno33, 36).maxhp - ownAt(monferno33, 33).maxhp);
    expect(levelUp(levelUp(levelUp(hurt, 0, 34), 0, 35), 0, 36).key).toBe(jump.key);
    // Two new moves at one level with two free slots: both, in learnset order.
    expect(ids(mine(levelUp(leading(playerMon(ID.monferno, 33, [ID.ember])), 0, 35)).baseMoveSlots)).toEqual(['ember', 'slash', 'leer', 'bite']);
  });

  it('the stats are the cartridge formula over its own nature, IVs and EVs (Adamant, written out from pk:598-630, :2593-2615)', () => {
    const ivs = { hp: 5, atk: 13, def: 22, spa: 30, spd: 7, spe: 0 };
    const evs = { hp: 252, atk: 255, def: 6, spa: 1, spd: 100, spe: 252 };
    const adamant = playerMon(ID.monferno, 30, [ID.ember, ID.tackle], { ivs, evs, nature: { value: 3, source: 'rom', disputed: false, alternatives: [] } });
    const base = fixture.data.rom.species[ID.monferno]!.baseStats;
    const core = (stat: keyof typeof ivs, level: number) => Math.floor(((2 * base[stat] + ivs[stat] + Math.floor(evs[stat] / 4)) * level) / 100);
    for (const level of [31, 47, 100]) {
      const up = mine(levelUp(leading(adamant), 0, level));
      const hp = core('hp', level) + level + 10;
      expect({ hp: up.maxhp, ...up.storedStats, now: up.hp }).toEqual({
        hp, atk: Math.floor(((core('atk', level) + 5) * 110) / 100), def: core('def', level) + 5, spa: Math.floor(((core('spa', level) + 5) * 90) / 100),
        spd: core('spd', level) + 5, spe: core('spe', level) + 5, now: hp,
      });
    }
  });

  it('a form with a Personal row of its own learns from that row\'s learnset (Deoxys-Attack, row 496)', () => {
    const attack = mine(levelUp(leading(playerMon(ID.deoxys, 50, [ID.tackle], { form: 1 })), 0, 51));
    expect([attack.baseSpecies.id, ids(attack.baseMoveSlots)]).toEqual(['deoxysattack', ['tackle', 'slash']]);
    expect(ids(mine(levelUp(leading(playerMon(ID.deoxys, 50, [ID.tackle])), 0, 51)).baseMoveSlots)).toEqual(['tackle', 'leer']);
  });

  it('the last level: 99 to 100 is taken, and no level goes past 100', () => {
    const mon99 = playerMon(ID.monferno, 99, [ID.ember, ID.tackle]);
    const top = levelUp(leading(mon99), 0, 100);
    const own = ownAt(mon99, 100);
    expect([mine(top).level, mine(top).maxhp, mine(top).storedStats.atk, mine(top).details]).toEqual([100, own.maxhp, own.storedStats.atk, own.details]);
    expect(() => levelUp(top, 0, 101)).toThrow(RangeError);
    const battle = restore(leading(mon99));
    expect(applyLevel(battle, battle.p1.active[0]!, 100)).toEqual({ level: 100, learned: [], offered: [] });
    expect(() => applyLevel(battle, battle.p1.active[0]!, 101)).toThrow(RangeError);
  });

  it('keeps its status: a paralysed Pokémon stays paralysed, at the new level\'s paralysed Speed', () => {
    const paralysed = playerMon(ID.monferno, 30, [ID.ember, ID.tackle], { status: { kind: 'paralysis' } });
    const after = mine(levelUp(leading(paralysed), 0, 33));
    expect([after.status, after.speed]).toEqual(['par', ownAt(paralysed, 33).speed]);
    expect(after.speed).toBeLessThan(after.storedStats.spe);
  });

  it('a learnset move the installed dex lacks is a data error that names the species, the level and the move', () => {
    expect(FIXTURE_MOVES.has(MISSING_MOVE)).toBe(false);
    expect(() => levelUp(leading(playerMon(ID.charmander, 10, [ID.tackle])), 0, 11))
      .toThrow(new RegExp(`Charmander's learnset \\(Personal row ${ID.charmander}\\) teaches move ${MISSING_MOVE} at level 11`));
  });

  it('keeps its own species in `details`: a battle forme (Castform in the sun) is not its name', () => {
    const castform = playerMon(ID.castform, 30, [ID.tackle]);
    const sunny = expandTurn(createBattle({ ...input(resolvedMon(ID.zigzagoon, 60, [ID.sunnyDay])), player: [castform, bidoof] }), { p1: move(0), p2: move(0) })
      .find((o) => o.state.phase.kind === 'turnChoice')!.state;
    expect(mine(sunny).species.id).toBe('castformsunny');
    expect(mine(levelUp(sunny, 0, 31)).details).toBe(mine(createBattle({ ...input(), player: [atLevel(castform, 31), bidoof] })).details);
  });
});

describe('applyLevel (one turn of the level-up loop, on a live battle)', () => {
  it('raises the level by one and names the moves learned and offered, in learnset order; refuses any other level', () => {
    const battle = restore(leading(monferno33));
    const me = battle.p1.active[0]!;
    expect([34, 35, 36].map((level) => applyLevel(battle, me, level))).toEqual([
      { level: 34, learned: [ID.slash], offered: [] }, { level: 35, learned: [ID.leer], offered: [ID.bite] }, { level: 36, learned: [], offered: [ID.howl] },
    ]);
    expect(me.level).toBe(36);
    expect(() => applyLevel(battle, me, 36)).toThrow(RangeError);
    expect(() => applyLevel(battle, me, 38)).toThrow(RangeError);
  });

  it('a fainted Pokémon stays at 0 HP; Shedinja stays at 1 of 1 (pk:633-640)', () => {
    const battle = restore(fainted());
    const dead = battle.p1.pokemon.find((p) => p.set === battle.p1.team[0])!;
    const maxBefore = dead.maxhp;
    applyLevel(battle, dead, 31);
    expect(dead.hp).toBe(0);
    expect(dead.maxhp).toBeGreaterThan(maxBefore);
    const shedinja = restore(createBattle({ ...input(), player: [monferno, playerMon(ID.shedinja, 30, [ID.tackle])] })).p1.pokemon[1]!;
    applyLevel(shedinja.battle, shedinja, 31);
    expect([shedinja.hp, shedinja.maxhp, shedinja.level]).toEqual([1, 1, 31]);
  });
});
