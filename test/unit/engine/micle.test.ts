// Micle Berry checked where the cartridge checks it (mod/items.ts has the rules; bl = battle_lib.c, bcp =
// battle_controller_player.c): `curHP <= maxHP / 4` (halved by Gluttony, none under Klutz or Embargo) at the switch-in
// sequence, after every hit, and twice in the holder's end-of-turn list. The boost it sets is spent by the next hit-rate
// formula, a switch-out or a faint. HP lines: Machop 50 145 (line 36), Zigzagoon 50 113 (28; 56 with Gluttony), Deoxys 50 165 (41).

import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { Choice, EngineState, FieldSpec } from '../../../src/contracts/engine.js';
import { createBattle, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { unmodelledIn } from '../../../src/engine/facts.js';
import { ABILITY, BAG, fixtureDex, ID, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const MICLE = 209; // HOLD_EFFECT_PINCH_ACC_UP, parameter 4 in the hack ROM
const UNBURDEN = 84;
const SOLAR_BEAM = 76; // "Charging turn unless in Harsh Sunlight"

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH = { p1: move(0), p2: move(0) };
const SECOND = { p1: move(1), p2: move(0) };

const battle = (player: PlayerMon[], trainer: ResolvedMon[], field: FieldSpec = {}): EngineState =>
  createBattle({ player, trainer: resolvedTrainer(BAG.none, trainer), field });
function edited(state: EngineState, edit: (battle: Battle) => void): EngineState {
  const live = restore(state);
  edit(live);
  return snapshot(live);
}
const foeHp = (hp: number) => (live: Battle) => { live.p2.active[0]!.hp = hp; };
const logOf = (state: EngineState): string[] => (JSON.parse(state.json) as { log: string[] }).log;
/** The index of the first line that starts with `prefix`, which must be there. */
const at = (log: readonly string[], prefix: string): number => {
  const index = log.findIndex((line) => line.startsWith(prefix));
  expect(index, `no line ${prefix}`).toBeGreaterThan(-1);
  return index;
};
/** `prefixes` appear in this order. */
const inOrder = (log: readonly string[], ...prefixes: string[]) => {
  const indices = prefixes.map((prefix) => at(log, prefix));
  expect(indices).toEqual([...indices].sort((a, b) => a - b));
};
const has = (log: readonly string[], prefix: string): boolean => log.some((line) => line.startsWith(prefix));
const foe = (state: EngineState) => restore(state).p2.active[0]!;
const mine = (state: EngineState) => restore(state).p1.active[0]!;
/** The holder's eat line; the boost eaten by a hit-rate formula logs the same line without `[eat]`. */
const eat = (who: string): string => `|-enditem|${who}|Micle Berry|[eat]`;
const boostUsed = (log: readonly string[], who: string): boolean => log.includes(`|-enditem|${who}|Micle Berry`);
/** [item, has the boost] of a side's active Pokémon. */
const held = (mon: Pokemon) => [mon.item, mon.volatiles['micleberry'] !== undefined];

/** A trainer's Pokémon with a Micle Berry and Oblivious (nothing that changes the case). */
const holder = (species: number, level: number, moves: number[], fields: Partial<ResolvedMon> = {}) =>
  resolvedMon(species, level, moves, { item: MICLE, ability: knownAbility(ABILITY.oblivious), ...fields });
const deoxys = (moves: number[] = [ID.growl]) => playerMon(ID.deoxys, 50, moves);
const zigzagoonHolder = (fields: Partial<ResolvedMon> = {}) => holder(ID.zigzagoon, 50, [ID.growl], fields);

describe('after a move (bcp:3672-3698, :3730-3755)', () => {
  // The faster Deoxys's weak hit (1 to 4) takes Machop into its pinch; Machop's Mega Kick (90) is then at 108: a sure hit.
  const start = () => edited(battle([deoxys([ID.plainHit, ID.growl])], [holder(ID.machop, 50, [ID.megaKick, ID.growl])]), (live) => {
    live.p2.active[0]!.hp = 37; // one above the line
    live.p1.active[0]!.storedStats.atk = 1;
  });

  it('the berry is eaten right after the hit, so the holder\'s move that turn is boosted and uses the boost up; next turn it can miss', () => {
    const outcomes = expandTurn(start(), BOTH);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const { log, state } of outcomes) {
      inOrder(log, '|move|p1a: Deoxys|', eat('p2a: Machop'), '|move|p2a: Machop|Mega Kick');
      expect([boostUsed(log, 'p2a: Machop'), has(log, '|-miss|p2a: Machop'), held(foe(state)), unmodelledIn(state)]).toEqual([true, false, ['', false], []]);
    }
    expect(expandTurn(runFirstOutcome(start(), BOTH), SECOND).some((outcome) => has(outcome.log, '|-miss|p2a: Machop'))).toBe(true);
  });

  it('a move its user couldn\'t make reaches `MoveEnd`, which checks too: a confusion self-hit eats the berry before the foe moves', () => {
    // Machop hits itself from 50 into its pinch; the slower Magikarp's Knock Off then finds no berry.
    const confused = edited(battle([playerMon(ID.magikarp, 21, [ID.knockOff])], [holder(ID.machop, 50, [ID.growl])]), (live) => {
      live.p2.active[0]!.hp = 50;
      live.p2.active[0]!.addVolatile('confusion');
    });
    const selfHits = expandTurn(confused, BOTH).filter((outcome) => outcome.log.some((line) => line.includes('[from] confusion')));
    expect(selfHits.length).toBeGreaterThan(0);
    for (const { log, state } of selfHits) {
      expect(at(log, eat('p2a: Machop'))).toBeGreaterThan(log.findIndex((line) => line.includes('[from] confusion')));
      expect(at(log, eat('p2a: Machop'))).toBeLessThan(at(log, '|move|p1a: Magikarp|Knock Off'));
      expect(foe(state).volatiles['micleberry']).toBeDefined();
    }
  });

  it('after each hit of a multi-hit move: a holder hit into its pinch eats before the next hit; one knocked out by a later hit has eaten it', () => {
    const fury = (hp: number, atk?: number, second = false) => runFirstOutcome(edited(battle([playerMon(ID.monferno, 30, [ID.furyAttack])],
      second ? [zigzagoonHolder(), zigzagoonHolder()] : [zigzagoonHolder()]), (live) => {
      live.p2.active[0]!.hp = hp;
      if (atk !== undefined) live.p1.active[0]!.storedStats.atk = atk;
    }), BOTH);
    const log = logOf(fury(35));
    // Each hit logs the exact HP (`/113`).
    const hits = log.flatMap((line, i) => (line.startsWith('|-damage|p2a: Zigzagoon|') && line.includes('/113') && !line.includes('[from]') ? [i] : []));
    const into = hits.findIndex((i) => Number(log[i]!.split('|')[3]!.split('/')[0]) <= 28);
    expect([hits.length >= 2, into >= 0, into < hits.length - 1]).toEqual([true, true, true]);
    expect(at(log, eat('p2a: Zigzagoon'))).toBeGreaterThan(hits[into]!);
    expect(at(log, eat('p2a: Zigzagoon'))).toBeLessThan(hits[into + 1]!);
    const knocked = fury(30, 120, true); // about 20 a hit: 30 -> 10, then the knock-out
    inOrder(logOf(knocked), '|-damage|p2a: Zigzagoon|', eat('p2a: Zigzagoon'), '|faint|p2a: Zigzagoon');
    expect(restore(knocked).p2.pokemon[0]!.item).toBe('');
  });

  it('exactly at the line it works, one above it not; Gluttony halves the power to 2', () => {
    const eatenAfterGrowl = (hp: number, mon: ResolvedMon) => expandTurn(edited(battle([deoxys()], [mon]), foeHp(hp)), BOTH).map(({ log }) => {
      const eaten = log.indexOf(eat('p2a: Zigzagoon'));
      return eaten > at(log, '|move|p1a: Deoxys|Growl') && eaten < at(log, '|move|p2a: Zigzagoon|');
    });
    const gluttonous = resolvedMon(ID.zigzagoon, 50, [ID.growl], { item: MICLE }); // the fixture row's Gluttony
    expect([eatenAfterGrowl(28, zigzagoonHolder()), eatenAfterGrowl(29, zigzagoonHolder()), eatenAfterGrowl(56, gluttonous), eatenAfterGrowl(57, gluttonous)])
      .toEqual([[true], [false], [true], [false]]);
  });

  it('never under Klutz, at any check point', () => {
    let state = edited(battle([deoxys()], [zigzagoonHolder({ ability: knownAbility(ABILITY.klutz) })]), foeHp(10));
    for (let turn = 0; turn < 3; turn++) state = runFirstOutcome(state, BOTH);
    expect(held(foe(state))).toEqual(['micleberry', false]);
  });

  it('not under Embargo; in the end of turn whose Embargo ends, after the end, at its item-condition step', () => {
    const after = runFirstOutcome(edited(battle([deoxys()], [zigzagoonHolder()]), (live) => {
      live.p2.active[0]!.hp = 10;
      live.p2.active[0]!.addVolatile('embargo');
      live.p2.active[0]!.volatiles['embargo']!.duration = 1; // ends at this end of turn
    }), BOTH);
    inOrder(logOf(after), '|move|p2a: Zigzagoon|', '|-end|p2a: Zigzagoon|Embargo', eat('p2a: Zigzagoon'));
    expect(foe(after).volatiles['micleberry']).toBeDefined();
  });

  it('eating it starts Unburden (Showdown\'s `AfterUseItem`; the cartridge doubles the Speed once the item is gone, bl:1268-1272)', () => {
    const after = runFirstOutcome(edited(battle([deoxys()], [zigzagoonHolder({ ability: knownAbility(UNBURDEN) })]), foeHp(20)), BOTH);
    inOrder(logOf(after), eat('p2a: Zigzagoon'), '|move|p2a: Zigzagoon|');
    expect(foe(after).volatiles['unburden']).toBeDefined();
  });
});

describe('at a switch-in and at the turn\'s start (bl:4152-4160)', () => {
  it('the player\'s holder switches in in its pinch and eats at once: the trainer\'s Knock Off that turn finds no berry', () => {
    const start = edited(battle([playerMon(ID.zigzagoon, 20, [ID.growl]), playerMon(ID.machop, 50, [ID.growl], { item: MICLE })], [resolvedMon(ID.magikarp, 21, [ID.knockOff])]),
      (live) => { live.p1.pokemon[1]!.hp = 36; });
    for (const { log, state } of expandTurn(start, { p1: { kind: 'switch', index: 1 }, p2: move(0) })) {
      inOrder(log, '|switch|p1a: Machop', eat('p1a: Machop'), '|move|p2a: Magikarp|Knock Off');
      expect(held(mine(state))).toEqual(['', true]);
    }
  });

  it('Future Sight takes the holder into its pinch after every list: the turn\'s start eats the berry, before the next commands', () => {
    // Special Attack 1: Future Sight does 2 or 3, landing on a Zigzagoon at 29.
    let state = edited(battle([deoxys([ID.futureSight, ID.growl])], [zigzagoonHolder()]), (live) => { live.p1.active[0]!.storedStats.spa = 1; });
    state = runFirstOutcome(runFirstOutcome(state, BOTH), SECOND);
    const landed = runFirstOutcome(edited(state, foeHp(29)), SECOND);
    const log = logOf(landed);
    expect(at(log, eat('p2a: Zigzagoon'))).toBeGreaterThan(log.findIndex((line) => line.startsWith('|-end|p2a: Zigzagoon|move: Future Sight')));
    expect(foe(landed).hp).toBeLessThanOrEqual(28);
    expect(held(foe(landed))).toEqual(['', true]);
  });
});

describe('in the holder\'s own end-of-turn list (bcp:1362-1368, :1699-1709)', () => {
  it('the use-item step comes before the poison: a holder the sandstorm took into its pinch eats, then faints to Toxic', () => {
    // 29 - 7 (sandstorm) = 22 <= 28; Toxic at its 4th stage then does 28.
    const after = runFirstOutcome(edited(battle([deoxys()], [zigzagoonHolder(), zigzagoonHolder()], { weather: 'sand' }), (live) => {
      live.p2.active[0]!.hp = 29;
      live.p2.active[0]!.setStatus('tox');
      live.p2.active[0]!.statusState['stage'] = 3;
    }), BOTH);
    inOrder(logOf(after), '|-damage|p2a: Zigzagoon|22/113 tox|[from] Sandstorm', eat('p2a: Zigzagoon'), '|faint|p2a: Zigzagoon');
    expect(restore(after).p2.pokemon[0]!.item).toBe('');
  });

  it('the item-condition step comes after the poison and before the next battler\'s list: eaten before Leech Seed heals it back', () => {
    // The faster trainer's Deoxys at 42 seeds Giratina; poison leaves 22 <= 41; Giratina's list then drains 28 to it.
    const after = runFirstOutcome(edited(battle([playerMon(ID.giratina, 50, [ID.growl])], [holder(ID.deoxys, 50, [ID.leechSeed])]), (live) => {
      live.p2.active[0]!.hp = 42;
      live.p2.active[0]!.setStatus('psn');
    }), BOTH);
    inOrder(logOf(after), '|-damage|p2a: Deoxys|22/165 psn|[from] psn', eat('p2a: Deoxys'), '|-damage|p1a: Giratina|197/225|[from] Leech Seed', '|-heal|p2a: Deoxys|50/165 psn');
    expect([foe(after).hp, ...held(foe(after))]).toEqual([50, '', true]);
  });
});

describe('the boost\'s lifetime: spent by the next hit-rate formula, before anything can stop the move (bcp:2967-2970, :3237-3296)', () => {
  it('no expiry: three turns of Howl (no formula) keep it, and the Mega Kick after uses it', () => {
    let state = edited(battle([deoxys()], [holder(ID.machop, 50, [ID.howl, ID.megaKick])]), foeHp(30));
    for (let turn = 0; turn < 3; turn++) state = runFirstOutcome(state, BOTH);
    expect(held(foe(state))).toEqual(['', true]);
    for (const { log, state: after } of expandTurn(state, { p1: move(0), p2: move(1) })) {
      expect([boostUsed(log, 'p2a: Machop'), has(log, '|-miss|p2a: Machop'), held(foe(after))]).toEqual([true, false, ['', false]]);
    }
  });

  const boosted = (player: PlayerMon, moves: number[], extra: (live: Battle) => void = () => {}) => edited(battle([player], [holder(ID.machop, 50, moves)]), (live) => {
    expect(live.p2.active[0]!.addVolatile('micleberry')).toBe(true);
    extra(live);
  });
  // The formula comes first; then the overrides (Protect, No Guard, a semi-invulnerable target), the type chart and the abilities.
  it.each<[string, () => EngineState, string]>([
    ['into a Ghost: Mega Kick does nothing', () => boosted(playerMon(ID.gengar, 50, [ID.growl]), [ID.megaKick]), '|-immune|p1a: Gengar'],
    ['a Ground move into Levitate', () => boosted(playerMon(ID.monferno, 30, [ID.growl], { ability: knownAbility(ABILITY.levitate) }), [ID.plainQuake]), '|-immune|p1a: Monferno'],
    ['into an underground target: the move misses (bcp:3001-3032)', () => boosted(playerMon(ID.monferno, 30, [ID.growl]), [ID.megaKick],
      (live) => { expect(live.p1.active[0]!.addVolatile('dig')).toBe(true); }), '|-miss|p2a: Machop'],
  ])('%s, and the boost is gone', (_, start, stopped) => {
    const after = runFirstOutcome(start(), BOTH);
    const log = logOf(after);
    expect(boostUsed(log, 'p2a: Machop')).toBe(true);
    expect(log.indexOf('|-enditem|p2a: Machop|Micle Berry')).toBeLessThan(at(log, stopped));
    expect(foe(after).volatiles['micleberry']).toBeUndefined();
  });

  it('a move that fails in its own script spends it: Fake Out after its first turn (effect_script_0158.s)', () => {
    let state = runFirstOutcome(battle([deoxys()], [holder(ID.machop, 50, [ID.fakeOut, ID.growl])]), { p1: move(0), p2: move(1) });
    state = edited(state, (live) => { expect(live.p2.active[0]!.addVolatile('micleberry')).toBe(true); });
    const after = runFirstOutcome(state, BOTH);
    expect([boostUsed(logOf(after), 'p2a: Machop'), foe(after).volatiles['micleberry']]).toEqual([true, undefined]);
  });

  it('a charge turn runs no formula (bcp:2906-2908): a two-turn move keeps the boost on its first turn and spends it on its second', () => {
    const first = runFirstOutcome(boosted(deoxys(), [SOLAR_BEAM]), BOTH);
    expect([boostUsed(logOf(first), 'p2a: Machop'), foe(first).volatiles['micleberry'] !== undefined]).toEqual([false, true]);
    const second = runFirstOutcome(first, BOTH);
    expect([boostUsed(logOf(second), 'p2a: Machop'), foe(second).volatiles['micleberry']]).toEqual([true, undefined]);
  });
});
