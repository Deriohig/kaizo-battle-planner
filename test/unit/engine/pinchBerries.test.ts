// The pinch berries with a parameter above 0 (Liechi, Salac, Petaya, Lansat, Starf, all 4 in the hack): what each needs
// besides `curHP <= maxHP / 4` (bl:4773-4895: HP left, no Klutz or Embargo, Gluttony halving the parameter, the stat below
// +6, Lansat no Focus Energy yet, Starf a drawn stat). They are checked at Micle's points (micle.test.ts) through the same
// pinch check. HP lines: Zigzagoon 50 113 (28; 56 with Gluttony).

import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { Choice, EngineState, FieldSpec, Outcome } from '../../../src/contracts/engine.js';
import { createBattle, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { residueWeights } from '../../../src/engine/odds.js';
import { cmp, rat } from '../../../src/engine/rational.js';
import { ABILITY, BAG, fixtureDex, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const LIECHI = ITEM.liechiBerry; // 201
const SALAC = 203;
const PETAYA = 204;
const LANSAT = 206;
const STARF = 207;
const SPEED_BOOST = 3;

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH = { p1: move(0), p2: move(0) };
const battle = (player: PlayerMon[], trainer: ResolvedMon[], field: FieldSpec = {}): EngineState =>
  createBattle({ player, trainer: resolvedTrainer(BAG.none, trainer), field });
function edited(state: EngineState, edit: (battle: Battle) => void): EngineState {
  const live = restore(state);
  edit(live);
  return snapshot(live);
}
const logOf = (state: EngineState): string[] => (JSON.parse(state.json) as { log: string[] }).log;
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
const foe = (state: EngineState) => restore(state).p2.active[0]!;
const eat = (who: string, berry: string): string => `|-enditem|${who}|${berry}|[eat]`;

/** A trainer's Pokémon holding `item`, with Oblivious (nothing that changes the case). */
const holder = (speciesId: number, level: number, moves: number[], item: number, fields: Partial<ResolvedMon> = {}) =>
  resolvedMon(speciesId, level, moves, { item, ability: knownAbility(ABILITY.oblivious), ...fields });
/** The player's Howling Deoxys against a Zigzagoon holding `item` at `hp`, edited further by `extra`. */
const versusZigzagoon = (zigzagoon: ResolvedMon, hp: number, extra: (mon: Pokemon) => void = () => {}) =>
  edited(battle([playerMon(ID.deoxys, 50, [ID.howl])], [zigzagoon]), (live) => {
    live.p2.active[0]!.hp = hp;
    extra(live.p2.active[0]!);
  });

describe('what each berry needs besides the HP (bl:4773-4895)', () => {
  it.each([
    [LIECHI, 'atk', 'liechiberry'], [ITEM.ganlonBerry, 'def', 'ganlonberry'], [SALAC, 'spe', 'salacberry'], [PETAYA, 'spa', 'petayaberry'], [ITEM.apicotBerry, 'spd', 'apicotberry'],
  ] as const)('a stat at +6 keeps the berry (item %i, %s)', (item, stat, id) => {
    // Ganlon and Apicot have parameter 0 (eaten at the battle start): given back with the stat at +6.
    const after = runFirstOutcome(versusZigzagoon(holder(ID.zigzagoon, 50, [ID.growl], item), 20, (mon) => { mon.boosts[stat] = 6; mon.setItem(id); }), BOTH);
    expect(logOf(after).some((line) => line.startsWith('|-enditem|p2a: Zigzagoon|'))).toBe(false);
    expect(foe(after).item).toBe(id);
  });

  it('the use-item step comes after the ability (bcp:1354-1368): Speed Boost to +6 first, so a Salac Berry at +5 stays', () => {
    // Turn 1 first: Speed Boost does nothing on its holder's first turn out. Then 29 HP in sand leaves 22 <= 28.
    let state = battle([playerMon(ID.deoxys, 50, [ID.howl])], [holder(ID.zigzagoon, 50, [ID.growl], SALAC, { ability: knownAbility(SPEED_BOOST) })], { weather: 'sand' });
    state = edited(runFirstOutcome(state, BOTH), (live) => {
      live.p2.active[0]!.hp = 29;
      live.p2.active[0]!.boosts.spe = 5;
    });
    const after = runFirstOutcome(state, BOTH);
    expect(at(logOf(after), '|-boost|p2a: Zigzagoon|spe|1')).toBeGreaterThan(-1);
    expect([foe(after).item, foe(after).boosts.spe, foe(after).hp]).toEqual(['salacberry', 6, 22]);
  });

  it('Gluttony halves the parameter to 2: eaten at 56, not at 57; under Gastro Acid it halves nothing (bl:3088-3092)', () => {
    const gluttonous = () => resolvedMon(ID.zigzagoon, 50, [ID.growl], { item: SALAC }); // the fixture row's Gluttony
    const eatenAt = (hp: number, extra?: (mon: Pokemon) => void) =>
      logOf(runFirstOutcome(versusZigzagoon(gluttonous(), hp, extra), BOTH)).some((line) => line.startsWith(eat('p2a: Zigzagoon', 'Salac Berry')));
    expect([eatenAt(56), eatenAt(57), eatenAt(40, (mon) => { expect(mon.addVolatile('gastroacid')).toBe(true); })]).toEqual([true, false, false]);
  });

  it('Lansat Berry: kept while Focus Energy is up; eaten for Focus Energy otherwise', () => {
    const lansat = (focused: boolean) => runFirstOutcome(versusZigzagoon(holder(ID.zigzagoon, 50, [ID.growl], LANSAT), 20, (mon) => { if (focused) mon.addVolatile('focusenergy'); }), BOTH);
    expect(foe(lansat(true)).item).toBe('lansatberry');
    const eaten = lansat(false);
    inOrder(logOf(eaten), eat('p2a: Zigzagoon', 'Lansat Berry'), '|move|p2a: Zigzagoon|');
    expect(foe(eaten).volatiles['focusenergy']).toBeDefined();
  });

  it('never under Klutz', () => {
    let state = versusZigzagoon(holder(ID.zigzagoon, 50, [ID.growl], LIECHI, { ability: knownAbility(ABILITY.klutz) }), 10);
    for (let turn = 0; turn < 2; turn++) state = runFirstOutcome(state, BOTH);
    expect(foe(state).item).toBe('liechiberry');
  });
});

describe('Starf Berry\'s stat: the cartridge\'s draw, an `itemProc` chance (bl:4850-4870)', () => {
  // `do { i = RandNext() % 5 } while (stat i is at +6)`: stat i weighs residueWeights(5)[i] among those below +6, +2.
  const STATS = ['atk', 'def', 'spe', 'spa', 'spd'] as const;
  const starf = (edit: (pokemon: Pokemon) => void = () => {}) => versusZigzagoon(holder(ID.zigzagoon, 50, [ID.growl], STARF), 20, edit);
  const starfOutcome = (outcome: Outcome) => outcome.labels.find((entry) => entry.source === 'starfberry')!;

  it('every stat below +6: five outcomes, Attack 13108 / 65536 and each other 13107 / 65536, labelled, each stat +2', () => {
    const outcomes = expandTurn(starf(), BOTH);
    expect(outcomes).toHaveLength(5);
    const weights = residueWeights(5);
    for (const outcome of outcomes) {
      expect(outcome.unlabelled).toBe(false);
      expect(starfOutcome(outcome)).toMatchObject({ kind: 'itemProc', side: 'p2' });
      const i = STATS.indexOf(starfOutcome(outcome).outcome as typeof STATS[number]);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(cmp(outcome.probability, rat(weights[i]!, 65536n))).toBe(0);
      expect([foe(outcome.state).boosts[STATS[i]!], foe(outcome.state).item]).toEqual([2, '']);
    }
  });

  it('a stat at +6 is never drawn: Attack at +6 leaves four, 1/4 each; one at +5 goes to +6; all at +6 keeps the berry', () => {
    const outcomes = expandTurn(starf((pokemon) => { pokemon.boosts.atk = 6; pokemon.boosts.def = 5; }), BOTH);
    expect(outcomes.map((outcome) => starfOutcome(outcome).outcome).sort()).toEqual(['def', 'spa', 'spd', 'spe']);
    for (const outcome of outcomes) expect(cmp(outcome.probability, rat(1, 4))).toBe(0);
    expect(foe(outcomes.find((outcome) => starfOutcome(outcome).outcome === 'def')!.state).boosts.def).toBe(6);
    expect(foe(runFirstOutcome(starf((pokemon) => { for (const stat of STATS) pokemon.boosts[stat] = 6; }), BOTH)).item).toBe('starfberry');
  });

  it('Bug Bite on a Starf Berry by a user at +6 in all five: the berry is eaten, nothing is drawn, nothing crashes (bl:5798-5813)', () => {
    const start = edited(battle([playerMon(ID.monferno, 30, [ID.bugBite])], [holder(ID.zigzagoon, 50, [ID.meanLook], STARF)]), (live) => {
      for (const stat of STATS) live.p1.active[0]!.boosts[stat] = 6;
    });
    const outcomes = expandTurn(start, BOTH);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      expect(outcome.labels.some((label) => label.source === 'starfberry')).toBe(false);
      expect([foe(outcome.state).item, STATS.map((stat) => restore(outcome.state).p1.active[0]!.boosts[stat])]).toEqual(['', [6, 6, 6, 6, 6]]);
    }
  });
});
