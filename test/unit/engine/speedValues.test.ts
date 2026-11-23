// The cartridge's stored Speed values (src/engine/speedValues.ts): each compare writes each battler's effective Speed
// into `monSpeedValues` (bl:1372-1373), and the trainer AI's Gyro Ball estimate reads them (trainer_ai.c:2996).

import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { BattleInput, Choice, Outcome } from '../../../src/contracts/engine.js';
import { createBattle, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { lastSpeedValues, showdownEngine } from '../../../src/engine/index.js';
import { add, rat, type Rational, ZERO } from '../../../src/engine/rational.js';
import { cartridgeSpeed } from '../../../src/engine/speedValues.js';
import { effectiveSpeed } from '../../../src/sheet/speed.js';
import { ABILITY, BAG, emberTurn, fixtureDex, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH_FIRST = { p1: move(0), p2: move(0) };
const SPE_EVS = (spe: number) => ({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe });
const chanceOf = (outcomes: Outcome[], test: (outcome: Outcome) => boolean): Rational => outcomes.filter(test).reduce((sum, outcome) => add(sum, outcome.probability), ZERO);
/** Whose `|move|` or `|cant|` line comes first. */
const firstActor = (outcome: Outcome) => outcome.log.find((line) => line.startsWith('|move|') || line.startsWith('|cant|'))!.slice(6, 9);
const versus = (mine: PlayerMon, theirs: ResolvedMon[]): BattleInput => ({ player: [mine], trainer: resolvedTrainer(BAG.none, theirs), field: {} });
/** Monferno L30 (Speed 62) with Mean Look, which draws nothing and moves at +1, as both sides use it. */
const monferno = (fields: Partial<PlayerMon> = {}) => playerMon(ID.monferno, 30, [ID.meanLook], fields);
/** Zigzagoon L20 (Speed 35) with Mean Look. */
const zigzagoon = (fields: Partial<ResolvedMon> = {}) => resolvedMon(ID.zigzagoon, 20, [ID.meanLook], fields);
/** A paralysed Monferno at Speed 63: 15 on the cartridge (floored, bl:1259-1261), 16 in Showdown (4096-based). */
const paralysed = () => monferno({ evs: SPE_EVS(4), status: { kind: 'paralysis' } });

describe('the cartridge speed values', () => {
  it('after a turn: each active\'s effective Speed, as the sheet computes it', () => {
    const input = emberTurn();
    const expected = { p1: effectiveSpeed({ mon: input.player[0]! }, {}), p2: effectiveSpeed({ mon: input.trainer.party[0]! }, {}) };
    expect(expected).toEqual({ p1: 62, p2: 35 });
    const outcomes = expandTurn(createBattle(input), BOTH_FIRST);
    expect(outcomes.length).toBeGreaterThan(1);
    for (const outcome of outcomes) expect(lastSpeedValues(outcome.state)).toEqual(expected); // a burn leaves Speed alone
  });

  it('follow paralysis, Speed stages (at the next compare) and held items, as the formula and the sheet say', () => {
    const start = createBattle(versus(paralysed(), [zigzagoon()]));
    expect([lastSpeedValues(start), effectiveSpeed({ mon: paralysed() }, {}), restore(start).p1.active[0]!.getStat('spe')]).toEqual([{ p1: 15, p2: 35 }, 15, 16]);
    // A stage (bl:1225, :6550-6564) changes the value at the next compare, not when the stage does.
    const plain = createBattle(versus(monferno(), [zigzagoon()]));
    const staged = (spe: number) => {
      const battle = restore(plain);
      battle.p1.active[0]!.boosts.spe = spe;
      const before = snapshot(battle);
      expect(lastSpeedValues(before)).toEqual({ p1: 62, p2: 35 });
      return lastSpeedValues(runFirstOutcome(before, BOTH_FIRST)).p1;
    };
    expect([staged(1), staged(-1), ...[1, -1].map((spe) => effectiveSpeed({ mon: monferno(), boosts: { spe } }, {}))]).toEqual([93, 41, 93, 41]);
    // Choice Scarf x15/10 (bl:1248-1250); Iron Ball / 2 (:1240-1246).
    const [scarf, ironBall] = [monferno({ item: ITEM.choiceScarf }), zigzagoon({ item: ITEM.ironBall })];
    expect([lastSpeedValues(createBattle(versus(scarf, [ironBall]))), effectiveSpeed({ mon: scarf }, {}), effectiveSpeed({ mon: ironBall }, {})]).toEqual([{ p1: 93, p2: 17 }, 93, 17]);
  });

  it('are in the state key, and not in what the player sees', () => {
    const state = createBattle(versus(monferno(), [zigzagoon()]));
    const withValues = (p1: number, p2: number) => {
      const battle = restore(state);
      battle.formatData['kaizoSpeedValues'] = { p1, p2 };
      return snapshot(battle);
    };
    const [a, b] = [withValues(62, 35), withValues(35, 62)];
    expect([lastSpeedValues(a), lastSpeedValues(b)]).toEqual([{ p1: 62, p2: 35 }, { p1: 35, p2: 62 }]);
    expect(a.key).not.toBe(b.key);
    expect(showdownEngine.observe(a)).toBe(showdownEngine.observe(b));
  });

  it('read 0 before any compare; the battle start sorts after the switch-in effects, so Drizzle doubles a Swift Swim lead (bcp:251, :263)', () => {
    const bidoof = resolvedMon(ID.bidoof, 25, [ID.meanLook]); // Swift Swim, Speed 65
    const state = createBattle(versus(monferno({ ability: knownAbility(ABILITY.drizzle) }), [bidoof]));
    const json = JSON.parse(state.json);
    expect(json.formatData.kaizoSpeedValues).toBeDefined();
    delete json.formatData.kaizoSpeedValues;
    expect(lastSpeedValues({ ...state, json: JSON.stringify(json) })).toEqual({ p1: 0, p2: 0 }); // the zeroed battle context
    expect([lastSpeedValues(state), effectiveSpeed({ mon: bidoof }, { weather: 'rain' })]).toEqual([{ p1: 62, p2: 130 }, 130]);
  });

  it('a battler that fainted keeps its last value until the next turn\'s sort (bl:1204-1211)', () => {
    const knockedOut = expandTurn(createBattle({ player: [playerMon(ID.monferno, 30, [ID.ember])],
      trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 2, [ID.tackle]), resolvedMon(ID.bidoof, 25, [ID.tackle])]), field: {} }), BOTH_FIRST);
    for (const outcome of knockedOut) {
      expect([outcome.state.phase.kind, lastSpeedValues(outcome.state)]).toEqual(['enemyReplacement', { p1: 62, p2: 8 }]);
      for (const next of expandTurn(outcome.state, { p2: { kind: 'switch', index: 1 } })) expect([next.state.phase.kind, lastSpeedValues(next.state)]).toEqual(['turnChoice', { p1: 62, p2: 65 }]);
    }
  });

  it('Slow Start halves a lead\'s Speed for the first five turns (bl:1263-1266)', () => {
    let state = createBattle(versus(monferno({ ability: knownAbility(ABILITY.slowStart) }), [zigzagoon()]));
    const values = [lastSpeedValues(state).p1];
    for (let turn = 1; turn <= 5; turn++) values.push(lastSpeedValues(state = runFirstOutcome(state, BOTH_FIRST)).p1);
    expect(values).toEqual([31, 31, 31, 31, 31, 62]);
  });

  /** [cartridge, Showdown's getStat('spe')] for a Monferno at Speed 63 against a Zigzagoon. */
  const measure = (fields: Partial<PlayerMon>, foe: Partial<ResolvedMon> = {}, tweak: (pokemon: Pokemon) => void = () => {}) => {
    const battle = restore(createBattle(versus(monferno({ evs: SPE_EVS(4), ...fields }), [zigzagoon(foe)])));
    tweak(battle.p1.active[0]!);
    return [cartridgeSpeed(battle.p1.active[0]!), battle.p1.active[0]!.getStat('spe')];
  };
  const tailwind = (pokemon: Pokemon) => void pokemon.side.addSideCondition('tailwind', pokemon);
  const weather = (id: string) => (pokemon: Pokemon) => void pokemon.battle.field.setWeather(id, pokemon);
  const stage = (spe: number) => (pokemon: Pokemon) => void (pokemon.boosts.spe = spe);
  const ability = (id: number) => ({ ability: knownAbility(id) });
  it.each<[string, Partial<PlayerMon>, Partial<ResolvedMon>, ((pokemon: Pokemon) => void) | undefined, number[]]>([
    // Iron Ball halves even under Klutz or Embargo (bl:1240-1246); Showdown skips its handler then.
    ['Iron Ball under Klutz', { item: ITEM.ironBall, ...ability(ABILITY.klutz) }, {}, undefined, [31, 63]],
    ['Iron Ball under Embargo', { item: ITEM.ironBall }, {}, (pokemon) => void pokemon.addVolatile('embargo', pokemon), [31, 63]],
    // Each step floors, where Showdown chains its 4096-based modifiers and rounds once.
    ['Macho Brace with Tailwind', { item: ITEM.machoBrace }, {}, tailwind, [62, 63]],
    ['Quick Feet with Tailwind', { ...ability(ABILITY.quickFeet), status: { kind: 'poison' } }, {}, tailwind, [188, 189]],
    ['Choice Scarf when paralysed', { item: ITEM.choiceScarf, status: { kind: 'paralysis' } }, {}, undefined, [23, 24]],
    // As Showdown: Simple doubles the stage within -6..+6; Swift Swim and Chlorophyll double, unless Cloud Nine or Air Lock.
    ['Simple at +2', ability(ABILITY.simple), {}, stage(2), [189, 189]],
    ['Simple at +4', ability(ABILITY.simple), {}, stage(4), [252, 252]],
    ['Swift Swim in rain', ability(ABILITY.swiftSwim), {}, weather('raindance'), [126, 126]],
    ['Swift Swim in rain against Cloud Nine', ability(ABILITY.swiftSwim), ability(ABILITY.cloudNine), weather('raindance'), [63, 63]],
    ['Chlorophyll in sun', ability(ABILITY.chlorophyll), {}, weather('sunnyday'), [126, 126]],
    ['Chlorophyll in sun against Air Lock', ability(ABILITY.chlorophyll), ability(ABILITY.airLock), weather('sunnyday'), [63, 63]],
  ])('the cartridge\'s Speed and Showdown\'s: %s', (_, fields, foe, tweak, expected) => expect(measure(fields, foe, tweak)).toEqual(expected));

  it('the turn order uses the cartridge Speed where Showdown\'s rounds differently', () => {
    const order = (theirs: ResolvedMon) => expandTurn(createBattle(versus(paralysed(), [theirs])), BOTH_FIRST);
    const actionTies = (outcome: Outcome) => outcome.labels.filter((label) => label.kind === 'speedTie' && label.source === 'actionOrder');
    // Against a Zigzagoon at 15: a tie on the cartridge (RandNext() & 1, bl:1445), where Showdown has Monferno first.
    const tied = order(resolvedMon(ID.zigzagoon, 7, [ID.meanLook]));
    expect(chanceOf(tied, (outcome) => firstActor(outcome) === 'p2a')).toEqual(rat(1, 2));
    expect(tied.every((outcome) => actionTies(outcome).length === 1)).toBe(true);
    // Against a Zigzagoon at 16: faster on the cartridge, where Showdown has a tie.
    const faster = order(resolvedMon(ID.zigzagoon, 7, [ID.meanLook], { evs: SPE_EVS(28) }));
    expect([faster.every((outcome) => firstActor(outcome) === 'p2a'), faster.flatMap(actionTies)]).toEqual([true, []]);
  });
});
