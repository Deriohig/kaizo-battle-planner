// The Pokémon out when the player wins is cured by Natural Cure, or by a party ability that forbids its status, before
// the party is carried on (subscript_battle_won.s:6-11, `TryRestoreStatusOnSwitch` bs:9139-9160); the bench is not, and a
// lost fight cures no one. Every switch-out runs the same command first (subscript_switch_pokemon.s:5-6).

import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { BattleInput, Choice, Outcome } from '../../../src/contracts/engine.js';
import { carryOut, createBattle, restore, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { ABILITY, BAG, fixtureDex, ID, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const NATURAL_CURE = 30;
const LIMBER = 7;

/** The player's party against one level-2 Zigzagoon, which Deoxys's Tackle always knocks out first. */
const weakFoe = (player: PlayerMon[], fields: Partial<BattleInput> = {}): BattleInput => ({
  player, trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 2, [ID.growl])]), field: {}, ...fields,
});
const deoxys = (ability?: number) => playerMon(ID.deoxys, 50, [ID.tackle], ability === undefined ? {} : { ability: knownAbility(ability) });
const won = (outcome: Outcome) => outcome.state.phase.kind === 'terminal' && outcome.state.phase.winner === 'p1';
/** The carried status of party member `index` after each outcome of `choices`, from a battle with `first`'s status set and `change` made. */
const carried = (party: PlayerMon[], index: number, status: string, choices: { p1: Choice; p2: Choice }, change: (mon: Pokemon) => void = () => {}, onlyWins = false) => {
  const battle = restore(createBattle(weakFoe(party)));
  const mon = battle.p1.pokemon[index]!;
  change(mon);
  expect(mon.setStatus(status)).toBe(true);
  const outcomes = expandTurn(snapshot(battle), choices).filter((outcome) => !onlyWins || won(outcome));
  expect(outcomes.length).toBeGreaterThan(0);
  return [...new Set(outcomes.map((outcome) => JSON.stringify(carryOut(outcome.state).mons[index]!.status)))].map((text) => JSON.parse(text) as unknown);
};
const NONE = { kind: 'none' };
/** As after Worry Seed or Skill Swap: a battle ability other than the party's. */
const otherAbility = (mon: Pokemon) => { mon.ability = 'pressure' as ID; };
const ATTACK = { p1: move(0), p2: move(0) };
const SWITCH = { p1: { kind: 'switch', index: 1 } as Choice, p2: move(0) };

describe('the status carried out of a won fight (subscript_battle_won.s:6-11)', () => {
  it('a Natural Cure Pokémon out at the win is cured; before the end it is not', () => {
    const start = createBattle(weakFoe([deoxys(NATURAL_CURE)], { startStatus: { 0: { kind: 'poison' } } }));
    expect(carryOut(start).mons[0]!.status).toEqual({ kind: 'poison' });
    const outcomes = expandTurn(start, ATTACK);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) expect([won(outcome), carryOut(outcome.state).mons[0]!.status]).toEqual([true, NONE]);
  });

  it('a Natural Cure Pokémon on the bench keeps its status: only the battler out is named', () => {
    const start = createBattle(weakFoe([deoxys(), playerMon(ID.zigzagoon, 20, [ID.tackle], { ability: knownAbility(NATURAL_CURE) })], { startStatus: { 1: { kind: 'poison' } } }));
    for (const outcome of expandTurn(start, ATTACK)) expect([won(outcome), carryOut(outcome.state).mons[1]!.status]).toEqual([true, { kind: 'poison' }]);
  });

  it('a party ability that forbids the status cures it at the win, whatever the battle ability (bs:9152)', () => {
    expect(carried([deoxys(LIMBER)], 0, 'par', ATTACK, otherAbility, true)).toEqual([NONE]);
    expect(carried([deoxys(ABILITY.pressure)], 0, 'par', ATTACK, otherAbility, true)).toEqual([{ kind: 'paralysis' }]);
  });
});

describe('the status a switch-out cures (subscript_switch_pokemon.s:5-6)', () => {
  it.each<[string, PlayerMon, string, ((mon: Pokemon) => void) | undefined, object]>([
    ['Natural Cure cures (Showdown\'s does too)', deoxys(NATURAL_CURE), 'psn', undefined, NONE],
    ['Natural Cure cures under Gastro Acid: the command reads the battle ability field (bs:9151)', deoxys(NATURAL_CURE), 'psn', (mon) => { mon.addVolatile('gastroacid'); }, NONE],
    ['a party ability that forbids the status cures it, whatever the battle ability (bs:9152)', deoxys(LIMBER), 'par', otherAbility, NONE],
    ['a party ability that forbids nothing leaves it', deoxys(), 'par', otherAbility, { kind: 'paralysis' }],
  ])('%s', (_, first, status, change, expected) => expect(carried([first, deoxys()], 0, status, SWITCH, change)).toEqual([expected]));
});
