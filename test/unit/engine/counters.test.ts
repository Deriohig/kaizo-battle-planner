// The cartridge's counters, durations and remaining chance sites, as their effective behaviour: the lost or extra turns
// and their exact probabilities. Citations are pokeplatinum (bcp = battle_controller_player.c, bl = battle_lib.c,
// bs = battle_script.c, scripts under res/battle/scripts/).

import { beforeAll, describe, expect, it } from 'vitest';
import type { BattleInput, Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import { carryOut, createBattle, legalChoices, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex, installedMoves, moveId } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { belowWeight, residueWeights } from '../../../src/engine/odds.js';
import { add, mul, ONE, rat, type Rational, ZERO } from '../../../src/engine/rational.js';
import { setStartStatus } from '../../../src/engine/sets.js';
import { unmodelledNotes } from '../../../src/engine/unmodelled.js';
import { ABILITY, BAG, fixtureDex, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
// The fixture's vanilla Outrage, Magnitude and Psywave get a text with no engine entry, so each keeps its Showdown behaviour.
fixture.moves.get(ID.psywave)!.calc.baseMove = 'Psywave';
for (const id of [ID.outrage, ID.magnitude, ID.psywave]) fixture.moves.get(id)!.effectText = 'Fixture: the behaviour source\'s own effect';
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

type Choices = { p1?: Choice; p2?: Choice };
const U16 = 65536;
const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH: Choices = { p1: move(0), p2: move(0) };
/** `weight` of the 65,536 draws. */
const draws = (weight: bigint | number): Rational => rat(BigInt(weight), BigInt(U16));

/** `state` after `change` to its battle. */
function changed(state: EngineState, change: (battle: Battle) => void): EngineState {
  const battle = restore(state);
  change(battle);
  return snapshot(battle);
}
const foeStatus = (status: string) => (battle: Battle) => { expect(battle.p2.active[0]!.setStatus(status)).toBe(true); };

const chanceOf = (outcomes: Outcome[], test: (outcome: Outcome) => boolean): Rational =>
  outcomes.filter(test).reduce((total, outcome) => add(total, outcome.probability), ZERO);
const allLabels = (outcomes: Outcome[]) => outcomes.flatMap((outcome) => outcome.labels);
const hasLabel = (outcomes: Outcome[], kind: string, source?: string) =>
  allLabels(outcomes).some((label) => label.kind === kind && (source === undefined || label.source === source));
const labelled = (outcomes: Outcome[]) => expect(outcomes.every((outcome) => !outcome.unlabelled)).toBe(true);
const logs = (line: string) => (outcome: Outcome) => outcome.log.includes(line);

/** Each result's probability as text, sorted, so two tallies compare with `toEqual`. */
function asText(results: ReadonlyMap<string, Rational>): Record<string, string> {
  return Object.fromEntries([...results].sort(([a], [b]) => a.localeCompare(b)).map(([key, p]) => [key, `${p.num}/${p.den}`]));
}
const expected = (entries: [string, Rational][]): Record<string, string> => asText(new Map(entries));
const quarters = (prefix: string, values: number[]) => expected(values.map((value) => [`${prefix} ${value}`, rat(1, 4)]));
const byWeights = (prefix: string, values: number[], weights: bigint[]) => expected(values.map((value, i) => [`${prefix} ${value}`, draws(weights[i]!)]));

/** The probability of each `classify` result over `outcomes`. */
function tally(outcomes: Outcome[], classify: (outcome: Outcome) => string): Record<string, string> {
  const results = new Map<string, Rational>();
  for (const outcome of outcomes) results.set(classify(outcome), add(results.get(classify(outcome)) ?? ZERO, outcome.probability));
  return asText(results);
}

/**
 * Walks the steps from `state` with `choose`'s choices until `done` names a result from the path's log lines ("unfinished"
 * past `steps` steps or at the battle's end). Returns each result's probability; throws on an outcome from a raw draw.
 */
function walk(
  state: EngineState, choose: (state: EngineState, step: number) => Choices,
  done: (lines: readonly string[]) => string | undefined, steps = 8,
): Record<string, string> {
  const results = new Map<string, Rational>();
  const visit = (at: EngineState, lines: readonly string[], p: Rational, step: number) => {
    for (const outcome of expandTurn(at, choose(at, step), { maxLeaves: 100_000 })) {
      if (outcome.unlabelled) throw new Error(`An outcome of step ${step} came through a raw draw: ${JSON.stringify(outcome.labels)}`);
      const path = [...lines, ...outcome.log];
      const q = mul(p, outcome.probability);
      const result = done(path) ?? (step >= steps || outcome.state.phase.kind === 'terminal' ? 'unfinished' : undefined);
      if (result === undefined) visit(outcome.state, path, q, step + 1);
      else results.set(result, add(results.get(result) ?? ZERO, q));
    }
  };
  visit(state, [], ONE, 1);
  return asText(results);
}

const count = (lines: readonly string[], line: string | RegExp): number =>
  lines.filter((text) => (typeof line === 'string' ? text === line : line.test(text))).length;
/** The `|turn|` lines before `line`. */
const turnsTo = (lines: readonly string[], line: string): number => lines.slice(0, lines.indexOf(line)).filter((text) => text.startsWith('|turn|')).length;
/** A `done` for `walk`: once `line` shows, `classify` the path. */
const ends = (line: string, classify: (lines: readonly string[]) => string) => (lines: readonly string[]) => (lines.includes(line) ? classify(lines) : undefined);

/** A single battle: the player's `mine` against the trainer's `theirs`. */
const duel = (mine: PlayerMon, theirs: ResolvedMon, enemyAbility?: number): BattleInput => ({
  player: [mine], trainer: resolvedTrainer(BAG.none, [theirs]), field: {},
  ...(enemyAbility === undefined ? {} : { world: { enemy: [{ ability: enemyAbility }] } }),
});
const battle = (mine: PlayerMon, theirs: ResolvedMon, enemyAbility?: number) => createBattle(duel(mine, theirs, enemyAbility));
const firstMove = (state: EngineState, side: 'p1' | 'p2'): Choice => legalChoices(state, side).find((choice) => choice.kind === 'move')!;
const foe = (outcome: Outcome) => restore(outcome.state).p2.active[0]!;
const mine = (outcome: Outcome) => restore(outcome.state).p1.active[0]!;

// Monferno (L30) outspeeds Zigzagoon (L20), but the hack's Mean Look has priority +1: a status move Monferno lands on
// turn 1 meets Zigzagoon's first attempt on turn 2.
const monferno = (moves: number[], fields: Partial<PlayerMon> = {}) => playerMon(ID.monferno, 30, moves, fields);
const zigzagoon = (moves: number[], fields: Partial<ResolvedMon> = {}) => resolvedMon(ID.zigzagoon, 20, moves, fields);
// A weak attacker and a bulky target, so a turn has few outcomes.
const weakZigzagoon = (moves: number[], fields: Partial<PlayerMon> = {}) => playerMon(ID.zigzagoon, 5, moves, fields);
const deoxys = (moves: number[], fields: Partial<ResolvedMon> = {}) => resolvedMon(ID.deoxys, 50, moves, fields);
const BA = ABILITY.battleArmor;

describe('durations, walked to their end', () => {
  const firstThenSecond = (_: EngineState, step: number) => ({ p1: move(step === 1 ? 0 : 1), p2: move(0) });
  const ownFirstMove = (state: EngineState) => ({ p1: firstMove(state, 'p1'), p2: move(0) });
  const fatigue = ends('|-start|p1a: Zigzagoon|confusion|[fatigue]', (lines) => `uses ${count(lines, /^\|move\|p1a: Zigzagoon\|Outrage\|/)}`);
  const uproarEnd = '|-end|p1a: Zigzagoon|Uproar';
  const sleeper = (ability?: number) => battle(monferno([ID.spore, ID.meanLook]), zigzagoon([ID.meanLook]), ability);
  const sleepLost = ends('|-curestatus|p2a: Zigzagoon|slp|[msg]', (lines) => `lost ${count(lines, '|cant|p2a: Zigzagoon|slp')}`);
  /** Turn 1 both Growl; turn 2 Monferno uses `moveOf`; then each its first legal move, none a chance. */
  const afterGrowl = (moveOf: number) => runFirstOutcome(battle(monferno([ID.growl, moveOf]), zigzagoon([ID.growl, ID.wish])), BOTH);
  const secondThenFirst = (state: EngineState, step: number) => ({ p1: step === 1 ? move(1) : firstMove(state, 'p1'), p2: firstMove(state, 'p2') });
  const turnsUntil = (line: string) => ends(line, (lines) => `turns ${turnsTo(lines, line)}`);
  const bind = (fields: Partial<PlayerMon> = {}) => battle(weakZigzagoon([ID.wrap, ID.meanLook], fields), deoxys([ID.growl]), BA);
  const bindHits = ends('|-end|p2a: Deoxys|Wrap|[partiallytrapped]', (lines) => `hits ${count(lines, /^\|-damage\|p2a: Deoxys\|.*\[partiallytrapped\]$/)}`);

  it.each<{ name: string; start: () => EngineState; choose: (state: EngineState, step: number) => Choices; done: (lines: readonly string[]) => string | undefined; want: () => Record<string, string>; steps?: number }>([
    // Sleep: counter r % 4 + 2 (subscript_fall_asleep.s:59), lowered before each attempt; Early Bird lowers it by 2 (bcp:2442-2452).
    { name: 'sleep loses 1 to 4 turns, 1/4 each', start: () => sleeper(), choose: firstThenSecond, done: sleepLost, want: () => quarters('lost', [1, 2, 3, 4]) },
    { name: 'sleep with Early Bird loses 0 to 2 turns: 1/4, 1/2, 1/4', start: () => sleeper(ABILITY.earlyBird), choose: firstThenSecond, done: sleepLost,
      want: () => expected([['lost 0', rat(1, 4)], ['lost 1', rat(1, 2)], ['lost 2', rat(1, 4)]]) },
    // Confusion: counter 2..5 (subscript_confuse.s:34), lowered first at each attempt (bcp:2614-2650).
    { name: 'confusion: 1 to 4 confused attempts, 1/4 each, then it snaps out', start: () => battle(monferno([ID.confuseRay, ID.meanLook]), zigzagoon([ID.meanLook])),
      choose: firstThenSecond, done: ends('|-end|p2a: Zigzagoon|confusion', (lines) => `confused ${count(lines, '|-activate|p2a: Zigzagoon|confusion')}`),
      want: () => quarters('confused', [1, 2, 3, 4]) },
    // Disable r % 4 + 3 (bs:4594), Encore r % 5 + 3 (bs:4742): T full turns after the turn they land (bcp:1565-1616).
    { name: 'Disable: 3 to 6 full turns, 1/4 each', start: () => afterGrowl(ID.disable), choose: secondThenFirst,
      done: turnsUntil('|-end|p2a: Zigzagoon|Disable'), want: () => quarters('turns', [3, 4, 5, 6]), steps: 10 },
    // Showdown's Gen 4 Disable adds a turn when its target already moved; the cartridge doesn't.
    { name: 'Disable: no extra turn when its target moved first that turn',
      start: () => runFirstOutcome(createBattle(duel(playerMon(ID.zigzagoon, 20, [ID.meanLook, ID.disable]), resolvedMon(ID.monferno, 30, [ID.leechSeed, ID.meanLook]))), BOTH),
      choose: (state, step) => (step === 1 ? { p1: move(1), p2: move(1) } : { p1: firstMove(state, 'p1'), p2: firstMove(state, 'p2') }),
      done: turnsUntil('|-end|p2a: Monferno|Disable'), want: () => quarters('turns', [3, 4, 5, 6]), steps: 10 },
    { name: 'Encore: 3 to 7 full turns, 13108 then 13107 of the draws each', start: () => afterGrowl(ID.encore), choose: secondThenFirst,
      done: turnsUntil('|-end|p2a: Zigzagoon|Encore'), want: () => byWeights('turns', [3, 4, 5, 6, 7], residueWeights(5)), steps: 10 },
    // Taunt r % 3 + 3 (subscript_taunt_start.s:8) ends when its decrement reaches 0 (bcp:1635-1645): T - 1 full turns.
    { name: 'Taunt: 2 to 4 full turns, 21846, 21845 and 21845 of the draws',
      start: () => runFirstOutcome(battle(playerMon(ID.deoxys, 50, [ID.meanLook, ID.taunt], { ability: knownAbility(BA) }), resolvedMon(ID.zigzagoon, 5, [ID.leechSeed, ID.tackle])), BOTH),
      choose: (state, step) => ({ p1: move(step === 1 ? 1 : 0), p2: firstMove(state, 'p2') }),
      done: turnsUntil('|-end|p2a: Zigzagoon|move: Taunt'), want: () => byWeights('turns', [2, 3, 4], residueWeights(3)), steps: 10 },
    // Outrage 2..3 (subscript_thrash.s:5), Uproar 3..6 (subscript_uproar.s:6).
    { name: 'Outrage: 2 or 3 uses, 1/2 each, then confusion from fatigue', start: () => battle(weakZigzagoon([ID.outrage]), deoxys([ID.meanLook]), BA),
      choose: ownFirstMove, done: fatigue, want: () => expected([['uses 2', rat(1, 2)], ['uses 3', rat(1, 2)]]) },
    // BattleContext_MoveFailed has no Truant term (bl:2808-2820), so loafing keeps the lock counting.
    { name: 'Outrage with Truant: loafing is no failed attempt, so the lock still ends and confuses',
      start: () => battle(weakZigzagoon([ID.outrage], { ability: knownAbility(ABILITY.truant) }), deoxys([ID.growl]), BA),
      choose: ownFirstMove, done: fatigue, want: () => expected([['uses 1', rat(1, 2)], ['uses 2', rat(1, 2)]]), steps: 5 },
    { name: 'Uproar: 3 to 6 uses, 1/4 each', start: () => battle(weakZigzagoon([ID.uproar]), deoxys([ID.growl]), BA), choose: ownFirstMove,
      done: ends(uproarEnd, (lines) => `uses ${count(lines, /^\|move\|p1a: Zigzagoon\|Uproar\|/)}`), want: () => quarters('uses', [3, 4, 5, 6]) },
    // The cartridge's `noEffect` comes from the type chart alone (bcp:2366-2369), so Soundproof blocking it doesn't end it.
    { name: 'Uproar: a Soundproof target blocking it doesn\'t end it early',
      start: () => changed(battle(weakZigzagoon([ID.uproar]), deoxys([ID.growl]), ABILITY.soundproof), (b) => { expect(b.p1.active[0]!.addVolatile('uproar')).toBe(true); }),
      choose: ownFirstMove, done: ends(uproarEnd, (lines) => `checks ${turnsTo(lines, uproarEnd) + 1}`), want: () => quarters('checks', [3, 4, 5, 6]) },
    // Binding 3..6, 6 with Grip Claw (subscript_bind_start.s:10-12); a hit each end of turn while it stays nonzero.
    { name: 'binding: 2 to 5 end-of-turn hits, 1/4 each', start: () => bind(), choose: firstThenSecond, done: bindHits, want: () => quarters('hits', [2, 3, 4, 5]), steps: 10 },
    { name: 'binding with Grip Claw: 5 hits', start: () => bind({ item: ITEM.gripClaw }), choose: firstThenSecond, done: bindHits, want: () => expected([['hits 5', ONE]]), steps: 10 },
  ])('$name', ({ start, choose, done, want, steps }) => expect(walk(start(), choose, done, steps)).toEqual(want()));

  it('a binding hit is max HP / 16 (bcp:1467)', () => {
    const start = battle(weakZigzagoon([ID.wrap, ID.meanLook]), deoxys([ID.meanLook]), BA);
    const [first] = expandTurn(start, BOTH).filter((outcome) => outcome.log.some((line) => line.endsWith('[partiallytrapped]')));
    const tick = first!.log.find((line) => /^\|-damage\|p2a: Deoxys\|.*\[partiallytrapped\]$/.test(line))!;
    const before = first!.log.filter((line) => line.startsWith('|-damage|p2a: Deoxys|')).at(-2)!;
    const hp = (line: string) => Number(/\|(\d+)\/\d+/.exec(line)![1]);
    expect(hp(before) - hp(tick)).toBe(Math.floor(restore(start).p2.active[0]!.maxhp / 16));
  });
});

describe('sleep', () => {
  const woke = logs('|-curestatus|p2a: Zigzagoon|slp|[msg]');

  it('hazards: the chance to wake at each attempt, given it slept so far', () => {
    const hazards = (enemyAbility: number | undefined, attempts: number): Rational[] => {
      let state = runFirstOutcome(battle(monferno([ID.spore, ID.meanLook]), zigzagoon([ID.meanLook]), enemyAbility), BOTH);
      expect(restore(state).p2.active[0]!.status).toBe('slp');
      const chances: Rational[] = [];
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const outcomes = expandTurn(state, { p1: move(1), p2: move(0) });
        const chance = chanceOf(outcomes, woke);
        chances.push(chance);
        labelled(outcomes);
        const wake = allLabels(outcomes).filter((label) => label.kind === 'sleepWake');
        expect(wake.length > 0).toBe(chance.num !== 0n && chance.num !== chance.den);
        for (const label of wake) expect(label).toMatchObject({ side: 'p2', source: 'slp' });
        if (attempt < attempts) {
          const asleep = outcomes.filter((outcome) => !woke(outcome));
          expect(asleep).toHaveLength(1);
          state = asleep[0]!.state;
        }
      }
      return chances;
    };
    expect(hazards(undefined, 5)).toEqual([rat(0, 1), rat(1, 4), rat(1, 3), rat(1, 2), rat(1, 1)]);
    // Early Bird: c = 2 wakes on attempt 1; c = 3, 4 of the 3 left on attempt 2; c = 5 on attempt 3.
    expect(hazards(ABILITY.earlyBird, 3)).toEqual([rat(1, 4), rat(2, 3), rat(1, 1)]);
  });

  it('a known counter stays exact: the save\'s, pre-sleep, and Rest\'s 3 (subscript_rest.s)', () => {
    /** The attempts spent asleep before `wakeLine`, each turn a single outcome with no wake draw. */
    const asleepFor = (start: EngineState, choices: Choices, wakeLine: string) => {
      let state = start;
      for (let attempt = 0; ; attempt++) {
        const outcomes = expandTurn(state, choices);
        expect(outcomes).toHaveLength(1);
        expect(hasLabel(outcomes, 'sleepWake')).toBe(false);
        if (outcomes[0]!.log.includes(wakeLine)) return attempt;
        state = outcomes[0]!.state;
      }
    };
    const saved = (turns: number) => battle(playerMon(ID.zigzagoon, 20, [ID.meanLook], { status: { kind: 'sleep', turns } }), resolvedMon(ID.monferno, 30, [ID.meanLook]));
    expect([3, 1].map((turns) => asleepFor(saved(turns), BOTH, '|-curestatus|p1a: Zigzagoon|slp|[msg]'))).toEqual([2, 0]);
    const rested = runFirstOutcome(changed(battle(monferno([ID.rest, ID.growl]), zigzagoon([ID.growl])), (b) => { b.p1.active[0]!.hp = 40; }), BOTH);
    expect(restore(rested).p1.active[0]!.status).toBe('slp');
    expect(asleepFor(rested, { p1: move(1), p2: move(0) }, '|-curestatus|p1a: Monferno|slp|[msg]')).toBe(2);
  });

  it('the hidden counter is not in the state: sleepers with different counters are one state', () => {
    const [asleep, ...others] = expandTurn(battle(monferno([ID.spore, ID.meanLook]), zigzagoon([ID.meanLook])), BOTH);
    expect(others).toEqual([]);
    expect(foe(asleep!).status).toBe('slp');
    expect(foe(asleep!).statusState).not.toHaveProperty('time');
    const [first, ...rest] = expandTurn(asleep!.state, { p1: move(1), p2: move(0) }); // attempt 1: asleep surely
    expect(rest).toEqual([]);
    const stillAsleep = expandTurn(first!.state, { p1: move(1), p2: move(0) }).filter((outcome) => foe(outcome).status === 'slp');
    expect(stillAsleep).toHaveLength(1);
    expect([stillAsleep[0]!.probability, stillAsleep[0]!.merged, foe(stillAsleep[0]!).statusState['slept']]).toEqual([rat(3, 4), 1, 2]);
  });

  it('a carried undrawn sleep goes on where it left off', () => {
    // Fight A: the poisoned trainer's Zigzagoon Spores Monferno, then faints from poison after `attempts` attempts asleep.
    // Fight B, built from the carry, must wake Monferno with the chances fight A going on would.
    const wokeMine = '|-curestatus|p1a: Monferno|slp|[msg]';
    const stillAsleep = (start: EngineState, turns: number): EngineState => {
      let state = start;
      for (let turn = 0; turn < turns; turn++) {
        const asleep = expandTurn(state, BOTH).filter((outcome) => !outcome.log.includes(wokeMine));
        expect(asleep).toHaveLength(1);
        state = asleep[0]!.state;
      }
      return state;
    };
    const roundTrip = (attempts: number, fields: Partial<PlayerMon>) => {
      const fightA = battle(monferno([ID.growl], fields), zigzagoon([ID.spore]));
      const tick = Math.floor(restore(fightA).p2.active[0]!.maxhp / 8);
      const end = stillAsleep(changed(fightA, (b) => {
        expect(b.p2.active[0]!.setStatus('psn')).toBe(true);
        b.p2.active[0]!.hp = tick * (attempts + 1);
      }), attempts + 1);
      expect(end.phase).toEqual({ kind: 'terminal', winner: 'p1' });
      const carry = carryOut(end);
      expect(carry.mons[0]!.status).toEqual({ kind: 'sleepUndrawn', attempts });
      const fightB = createBattle({ ...duel(monferno([ID.growl], fields), zigzagoon([ID.growl])), carry });
      expect(restore(fightB).p1.active[0]!.status).toBe('slp');
      const wake = (start: EngineState) => walk(start, () => BOTH, ends(wokeMine, (lines) => `asleep ${count(lines, '|cant|p1a: Monferno|slp')} more`));
      const carried = wake(fightB);
      expect(carried).toEqual(wake(stillAsleep(fightA, attempts + 1)));
      return carried;
    };
    // Two attempts asleep: the counter is 3, 4 or 5, a third each.
    expect(roundTrip(2, {})).toEqual(expected([0, 1, 2].map((more) => [`asleep ${more} more`, rat(1, 3)])));
    // Early Bird: one attempt used up 2 of the counter, so 0 more for two thirds, 1 more for a third.
    expect(roundTrip(1, { ability: knownAbility(ABILITY.earlyBird) })).toEqual(expected([['asleep 0 more', rat(2, 3)], ['asleep 1 more', rat(1, 3)]]));
  });
});

describe('freeze (bcp:2478-2500: thaw when r % 5 == 0)', () => {
  const frozen = (theirs: number[], mineFields: Partial<PlayerMon> = {}, mineMoves: number[] = [ID.meanLook]) =>
    changed(battle(monferno(mineMoves, mineFields), zigzagoon(theirs)), foeStatus('frz'));
  const stuck = logs('|cant|p2a: Zigzagoon|frz');

  it('thaws for 13108 of the draws per attempt; a thawing move always thaws its user', () => {
    const start = frozen([ID.meanLook, ID.flameWheel]);
    const outcomes = expandTurn(start, BOTH);
    expect(chanceOf(outcomes, (outcome) => foe(outcome).status === '')).toEqual(draws(residueWeights(5)[0]!));
    expect(chanceOf(outcomes, stuck)).toEqual(draws(U16 - 13108));
    expect(allLabels(outcomes)).toContainEqual({ kind: 'thaw', side: 'p2', source: 'frz', outcome: 'thaw' });
    labelled(outcomes);
    for (const outcome of expandTurn(start, { p1: move(0), p2: move(1) })) {
      expect([foe(outcome).status === 'frz', outcome.log.some((line) => line.startsWith('|move|p2a: Zigzagoon|Flame Wheel')), outcome.unlabelled]).toEqual([false, true, false]);
    }
  });

  it('the ROM\'s move effect (125 or 253) thaws its user, not Showdown\'s defrost flag (bcp:2481-2482)', () => {
    const [ember, wheel] = [installedMoves().get(ID.ember)!, installedMoves().get(ID.flameWheel)!];
    const effects = [ember.romEffect, wheel.romEffect] as const;
    try {
      [ember.romEffect, wheel.romEffect] = [125, 0];
      const start = frozen([ID.ember, ID.flameWheel]);
      for (const outcome of expandTurn(start, BOTH)) {
        expect([foe(outcome).status === 'frz', outcome.log.some((line) => line.startsWith('|move|p2a: Zigzagoon|Ember'))]).toEqual([false, true]);
      }
      expect(chanceOf(expandTurn(start, { p1: move(0), p2: move(1) }), stuck)).toEqual(draws(U16 - 13108));
    } finally {
      [ember.romEffect, wheel.romEffect] = effects;
    }
  });

  it('a thawing move\'s user stays frozen when a later check stops it (a flinch, bcp:2528-2541, before the thaw at :2728)', () => {
    // The faster Monferno's King's Rock (parameter 11) Tackle flinches the frozen Zigzagoon's Flame Wheel.
    const outcomes = expandTurn(frozen([ID.flameWheel], { item: ITEM.kingsRock }, [ID.tackle]), BOTH);
    const still = outcomes.filter((outcome) => foe(outcome).status === 'frz');
    expect(chanceOf(outcomes, (outcome) => still.includes(outcome))).toEqual(mul(draws(U16 - 13108), draws(belowWeight(100, 11))));
    for (const outcome of still) expect(outcome.log).toContain('|cant|p2a: Zigzagoon|flinch');
    for (const outcome of outcomes.filter((other) => !still.includes(other) && !other.log.includes('|cant|p2a: Zigzagoon|flinch'))) {
      expect(outcome.log.some((line) => line.startsWith('|move|p2a: Zigzagoon|Flame Wheel'))).toBe(true);
    }
  });
});

describe('confusion self-hits (bcp:2614-2650: r & 1, then CALC_SELF_HIT(MOVE_STRUGGLE, 40) with its own roll)', () => {
  /**
   * A trainer's L20 `species` holding `item`, confused on turn 1, at its first confused attempt: the outcomes, the
   * self-hit damage values with their chances, and a `power`-power self-hit's by the formula, each half the time.
   */
  const selfHit = (power: number, item?: number, species: number = ID.zigzagoon) => {
    const start = battle(monferno([ID.confuseRay, ID.meanLook]), resolvedMon(species, 20, [ID.meanLook], item === undefined ? {} : { item }));
    const outcomes = expandTurn(runFirstOutcome(start, BOTH), { p1: move(1), p2: move(0) }); // attempt 1 is always confused
    const self = restore(start).p2.active[0]!;
    const hurt = (outcome: Outcome) => outcome.log.some((line) => line.startsWith(`|-damage|p2a: ${self.name}|`) && line.endsWith('|[from] confusion'));
    const base = Math.floor(Math.floor(10 * power * self.storedStats.atk / self.storedStats.def) / 50) + 2;
    const rolls = new Map<number, number>();
    for (let r = 0; r < 16; r++) {
      const damage = Math.max(1, Math.floor(base * (100 - r) / 100));
      rolls.set(damage, (rolls.get(damage) ?? 0) + 1);
    }
    return {
      outcomes, hurt, damages: tally(outcomes.filter(hurt), (outcome) => `${self.maxhp - foe(outcome).hp}`),
      formula: expected([...rolls].map(([damage, n]) => [`${damage}`, rat(n, 32)])),
    };
  };

  it('a confused attempt hits itself half the time, a 40-power typeless physical hit with its own roll', () => {
    const { outcomes, hurt, damages, formula } = selfHit(40);
    expect(chanceOf(outcomes, hurt)).toEqual(rat(1, 2));
    expect(allLabels(outcomes)).toContainEqual({ kind: 'selfHit', side: 'p2', source: 'confusion', outcome: 'selfHit' });
    expect(damages).toEqual(formula);
    expect(hasLabel(outcomes.filter(hurt), 'roll', 'confusion')).toBe(true);
  });

  // Silk Scarf boosts it as Normal (bl:6679-6722, no STAB, no type chart); Light Ball doubles a Pikachu's power in
  // CalcMoveDamage whatever the class (bl:6748-6751), where Showdown's BasePower handler skips the self-hit.
  it.each<[string, number, number | undefined, number, number | undefined]>([
    ['Silk Scarf raises it to 48 power', 48, ITEM.silkScarf, ID.zigzagoon, 40],
    ['Light Ball doubles a Pikachu\'s', 80, ITEM.lightBall, ID.pikachu, 40],
    ['Light Ball changes no one else\'s', 40, ITEM.lightBall, ID.zigzagoon, undefined],
  ])('%s', (_, power, item, species, plainPower) => {
    const { damages, formula } = selfHit(power, item, species);
    expect(damages).toEqual(formula);
    if (plainPower !== undefined) expect(damages).not.toEqual(selfHit(plainPower, undefined, species).damages);
  });
});

describe('single-draw chances', () => {
  const PROC = belowWeight(10, 3); // r % 10 < 3 (bl:4200-4376, :3567-3587)
  const tackling = (fields: Partial<PlayerMon>, theirs: Partial<ResolvedMon>, ability?: number) => battle(monferno([ID.tackle], fields), zigzagoon([ID.meanLook], theirs), ability);
  const flinch = logs('|cant|p2a: Zigzagoon|flinch');
  const vsSeeder = (fields: Partial<PlayerMon>, moves: number[] = [ID.tackle]) => battle(monferno(moves, fields), zigzagoon([ID.leechSeed])); // Leech Seed moves after Monferno
  const loved = () => runFirstOutcome(battle(monferno([ID.attract, ID.meanLook]), zigzagoon([ID.meanLook], { gender: 'F' })), BOTH);

  it.each<{ name: string; start: () => EngineState; choices?: Choices; hit?: (outcome: Outcome) => boolean; chance?: Rational; label?: object; noLabel?: string }>([
    { name: 'Static: 19662 of the draws on a contact hit', start: () => tackling({}, {}, ABILITY.static), hit: (o) => mine(o).status === 'par', chance: draws(PROC), label: { kind: 'abilityProc' } },
    { name: 'Poison Point: 19662', start: () => tackling({}, {}, ABILITY.poisonPoint), hit: (o) => mine(o).status === 'psn', chance: draws(PROC), label: { kind: 'abilityProc' } },
    { name: 'Flame Body: 19662', start: () => battle(playerMon(ID.zigzagoon, 20, [ID.tackle]), resolvedMon(ID.monferno, 30, [ID.meanLook]), ABILITY.flameBody),
      hit: (o) => mine(o).status === 'brn', chance: draws(PROC), label: { kind: 'abilityProc' } },
    { name: 'Cute Charm: 19662 on a contact hit by the other gender', start: () => tackling({}, { gender: 'F' }, ABILITY.cuteCharm),
      hit: (o) => 'attract' in mine(o).volatiles, chance: draws(PROC) },
    { name: 'Shed Skin: 19662 at the end of turn', start: () => changed(battle(monferno([ID.meanLook]), zigzagoon([ID.meanLook]), ABILITY.shedSkin), foeStatus('psn')),
      hit: (o) => foe(o).status === '', chance: draws(PROC), label: { kind: 'abilityProc', side: 'p2', source: 'shedskin', outcome: 'cure' } },
    // bcp:4645-4669: r % 100 below the ROM parameter, on a move with the ROM's King's Rock flag.
    { name: 'King\'s Rock: the ROM\'s 11 of 100', start: () => vsSeeder({ item: ITEM.kingsRock }), hit: flinch, chance: draws(belowWeight(100, 11)),
      label: { kind: 'itemProc', side: 'p1', source: 'kingsrock', outcome: 'flinch' } },
    { name: 'Razor Fang: the ROM\'s 10 of 100', start: () => vsSeeder({ item: ITEM.razorFang }), hit: flinch, chance: draws(belowWeight(100, 10)),
      label: { kind: 'itemProc', side: 'p1', source: 'razorfang', outcome: 'flinch' } },
    { name: 'King\'s Rock never on Beat Up, which has no ROM King\'s Rock flag (Showdown\'s list has it)', start: () => vsSeeder({ item: ITEM.kingsRock }, [ID.beatUp]),
      hit: flinch, chance: ZERO, noLabel: 'itemProc' },
    // Serene Grace doubles only the move's own chance (bl:1552-1575); Showdown's would double a flinch added before it.
    { name: 'King\'s Rock under Serene Grace: still 11 of 100', start: () => vsSeeder({ item: ITEM.kingsRock, ability: knownAbility(ABILITY.sereneGrace) }),
      hit: flinch, chance: draws(belowWeight(100, 11)) },
    { name: 'Focus Band: 10 of 100 when the hit would knock its holder out (bcp:3386-3388)',
      start: () => changed(tackling({}, { item: ITEM.focusBand }), (b) => { b.p2.active[0]!.hp = 1; }), hit: (o) => foe(o).hp === 1, chance: draws(belowWeight(100, 10)),
      label: { kind: 'itemProc', side: 'p2', source: 'focusband', outcome: 'endure' } },
    { name: 'Focus Band draws nothing at full HP', start: () => tackling({}, { item: ITEM.focusBand }), noLabel: 'itemProc' },
    // bcp:2949-2954: x (100 - 11) / 100, so Tackle hits iff r % 100 < 89: 58331 of the draws.
    { name: 'BrightPowder: a labelled hit point at the ROM\'s parameter', start: () => tackling({}, { item: ITEM.brightPowder }),
      hit: (o) => o.log.some((line) => line.startsWith('|-miss|p1a: ')), chance: draws(U16 - 58331), label: { kind: 'hit', source: 'tackle' } },
    { name: 'Lax Incense: the same', start: () => tackling({}, { item: ITEM.laxIncense }),
      hit: (o) => o.log.some((line) => line.startsWith('|-miss|p1a: ')), chance: draws(U16 - 58331), label: { kind: 'hit', source: 'tackle' } },
    // bcp:2652-2692: full paralysis r % 4 == 0 unless Magic Guard; infatuation r & 1, checked after paralysis.
    { name: 'full paralysis: 1/4', start: () => changed(battle(monferno([ID.meanLook]), zigzagoon([ID.meanLook])), foeStatus('par')),
      hit: logs('|cant|p2a: Zigzagoon|par'), chance: rat(1, 4), label: { kind: 'fullPara', side: 'p2', source: 'par', outcome: 'fullPara' } },
    { name: 'full paralysis: none with Magic Guard', start: () => changed(battle(monferno([ID.meanLook]), zigzagoon([ID.meanLook]), ABILITY.magicGuard), foeStatus('par')),
      hit: logs('|cant|p2a: Zigzagoon|par'), chance: ZERO, noLabel: 'fullPara' },
    { name: 'infatuation: immobilised 1/2', start: loved, choices: { p1: move(1), p2: move(0) }, hit: logs('|cant|p2a: Zigzagoon|Attract'), chance: rat(1, 2),
      label: { kind: 'infatuation', side: 'p2', source: 'attract', outcome: 'immobilised' } },
    { name: 'infatuation after paralysis: 3/8 of the attempts', start: () => changed(loved(), foeStatus('par')), choices: { p1: move(1), p2: move(0) },
      hit: logs('|cant|p2a: Zigzagoon|Attract'), chance: rat(3, 8) },
    { name: 'paralysis before infatuation: 1/4', start: () => changed(loved(), foeStatus('par')), choices: { p1: move(1), p2: move(0) },
      hit: logs('|cant|p2a: Zigzagoon|par'), chance: rat(1, 4) },
    // A lower-level user must pass ((r & 0xFF) x (L1 + L2) >> 8) + 1 > target level / 4 (bl:3073-3087): b = 52..255 here.
    { name: 'Whirlwind from a lower level: 204 x 256 of the draws',
      start: () => createBattle({ player: [weakZigzagoon([ID.whirlwind])], field: {}, trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.monferno, 30, [ID.meanLook]), zigzagoon([ID.meanLook])]) }),
      hit: (o) => o.log.some((line) => line.startsWith('|drag|p2a: ')), chance: draws(204 * 256) },
  ])('$name', ({ start, choices = BOTH, hit, chance, label, noLabel }) => {
    const outcomes = expandTurn(start(), choices);
    labelled(outcomes);
    if (hit && chance) expect(chanceOf(outcomes, hit)).toEqual(chance);
    if (label) expect(allLabels(outcomes)).toContainEqual(expect.objectContaining(label));
    if (noLabel) expect(hasLabel(outcomes, noLabel)).toBe(false);
  });

  it('Protect chain: 1, 1/2, 1/4, 1/8, 1/8 for consecutive uses (bs:5128-5191); Endure shares the counter', () => {
    const start = battle(monferno([ID.protect, ID.endure]), zigzagoon([ID.meanLook]));
    const shielded = logs('|-singleturn|p1a: Monferno|Protect');
    let state = start;
    const chances: Rational[] = [];
    for (let use = 1; use <= 5; use++) {
      const outcomes = expandTurn(state, BOTH);
      chances.push(chanceOf(outcomes, shielded));
      labelled(outcomes);
      if (use > 1) expect(allLabels(outcomes)).toContainEqual({ kind: 'protect', side: 'p1', source: 'protect', outcome: 'success' });
      state = outcomes.find(shielded)!.state;
    }
    expect(chances).toEqual([ONE, draws(0x8000), draws(0x4000), draws(0x2000), draws(0x2000)]);
    const endured = expandTurn(runFirstOutcome(start, BOTH), { p1: move(1), p2: move(0) });
    expect(chanceOf(endured, logs('|-singleturn|p1a: Monferno|move: Endure'))).toEqual(rat(1, 2));
  });

  it('Protect fails with no draw when its user moves last (bs:5160-5168)', () => {
    const input: BattleInput = { player: [monferno([ID.protect])], field: {}, trainer: resolvedTrainer(BAG.none, [zigzagoon([ID.meanLook]), zigzagoon([ID.meanLook])]) };
    const outcomes = expandTurn(createBattle(input), { p1: move(0), p2: { kind: 'switch', index: 1 } });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.log).not.toContain('|-singleturn|p1a: Monferno|Protect');
    expect(hasLabel(outcomes, 'protect')).toBe(false);
  });
});

describe('picks', () => {
  /** Roar's dragged slot: the bench's Zigzagoons are named "Zigzagoon 2" and on. */
  const dragged = (outcome: Outcome) => {
    const name = /^\|drag\|p2a: ([^|]+)\|/.exec(outcome.log.find((text) => text.startsWith('|drag|p2a: '))!)![1]!;
    return `${name === 'Zigzagoon' ? 0 : Number(name.split(' ')[1]) - 1}`;
  };
  const edges = [0, 5, 15, 35, 65, 85, 95, 100];
  const [triBurn, triFreeze, triPara] = residueWeights(3);
  const triChance = belowWeight(100, 30);
  const PROC = belowWeight(10, 3);
  const procAnd = (weight: bigint) => mul(draws(PROC), draws(weight));

  it.each<{ name: string; start: () => EngineState; classify: (outcome: Outcome, start: EngineState) => string; want: () => Record<string, string>; label?: object }>([
    // bs:5785-5830.
    { name: 'Magnitude: 4 to 10 by r % 100 against 5, 15, 35, 65, 85, 95', start: () => battle(weakZigzagoon([ID.magnitude]), deoxys([ID.meanLook]), BA),
      classify: (o) => o.log.find((line) => line.startsWith('|-activate|p1a: Zigzagoon|move: Magnitude|'))!.split('|')[4]!,
      want: () => expected([4, 5, 6, 7, 8, 9, 10].map((n, i) => [`${n}`, draws(belowWeight(100, edges[i + 1]!) - belowWeight(100, edges[i]!))])) },
    { name: 'Present: 40, 80 or 120 power or a heal by r & 0xFF against 102, 178, 204', start: () => battle(monferno([ID.present]), zigzagoon([ID.meanLook]), BA),
      classify: (o) => o.labels.find((label) => label.kind === 'pick' && label.source === 'present')!.outcome,
      want: () => expected([['40', draws(102 * 256)], ['80', draws(76 * 256)], ['120', draws(26 * 256)], ['heal', draws(52 * 256)]]) },
    // effect_script_0088.s: level x (r % 11 + 5) / 10, at least 1.
    { name: 'Psywave: residues 0 to 8 weighing 5958 and 9, 10 weighing 5957', start: () => battle(playerMon(ID.zigzagoon, 20, [ID.psywave]), deoxys([ID.meanLook]), BA),
      classify: (o, start) => `${restore(start).p2.active[0]!.maxhp - foe(o).hp}`,
      want: () => expected(residueWeights(11).map((weight, i) => [`${Math.max(1, Math.floor(20 * (i + 5) / 10))}`, draws(weight)])) },
    // effect_script_0036.s: r % 3 + 3 picks the subscript once the ROM's 30% chance passes.
    { name: 'Tri Attack: burn, freeze or paralysis, 21846, 21845 and 21845 of the draws', start: () => battle(weakZigzagoon([ID.triAttack]), deoxys([ID.growl]), BA),
      classify: (o) => foe(o).status || 'none',
      want: () => expected([['brn', mul(draws(triChance), draws(triBurn!))], ['frz', mul(draws(triChance), draws(triFreeze!))],
        ['par', mul(draws(triChance), draws(triPara!))], ['none', draws(BigInt(U16) - triChance)]]) },
    { name: 'Effect Spore: 19662 of the draws, then poison 21846, paralysis 21845, sleep 21845', start: () => battle(monferno([ID.tackle]), zigzagoon([ID.meanLook]), ABILITY.effectSpore),
      classify: (o) => mine(o).status || 'none',
      want: () => {
        const [poison, paralysis, sleep] = residueWeights(3);
        return expected([['psn', procAnd(poison!)], ['par', procAnd(paralysis!)], ['slp', procAnd(sleep!)], ['none', draws(U16 - Number(PROC))]]);
      } },
    // bs:5240-5318: a party slot r % (party size) until it is a living one not out.
    { name: 'Roar\'s target: each bench slot by its residue weight', start: () => createBattle({ player: [monferno([ID.roar])], field: {},
      trainer: resolvedTrainer(BAG.none, [1, 2, 3, 4, 5, 6].map(() => zigzagoon([ID.meanLook]))) }),
      classify: dragged, label: { kind: 'switchTarget', side: 'p1', source: 'roar', outcome: '1' },
      want: () => {
        const weights = residueWeights(6);
        const total = [1, 2, 3, 4, 5].reduce((sum, index) => sum + weights[index]!, 0n);
        return expected([1, 2, 3, 4, 5].map((index) => [`${index}`, rat(weights[index]!, total)]));
      } },
  ])('$name', ({ start, classify, want, label }) => {
    const state = start();
    const outcomes = expandTurn(state, BOTH);
    expect(tally(outcomes, (outcome) => classify(outcome, state))).toEqual(want());
    labelled(outcomes);
    if (label) expect(allLabels(outcomes)).toContainEqual(label);
  });

  it('Metronome: the hack\'s moves minus sCannotMetronomeMoves and the user\'s, by residue weight (bs:4537-4560)', () => {
    const start = battle(weakZigzagoon([ID.metronome]), deoxys([ID.meanLook]), BA);
    const outcomes = expandTurn(start, BOTH, { maxLeaves: 200_000 });
    const called = (outcome: Outcome) =>
      outcome.log.find((text) => text.startsWith('|move|p1a: Zigzagoon|') && /\[from\] ?move: Metronome/.test(text))?.split('|')[3] ?? 'none';
    const forbidden = new Set([118, 165, 166, 102, 448, 214, 274, 119, 68, 243, 182, 197, 203, 194, 168, 266, 289, 270, 343, 271, 264, 364, 383, 382, 415]);
    const weights = residueWeights(467);
    const allowed = [...installedMoves().values()].filter((kaizo) => kaizo.id >= 1 && kaizo.id <= 467 && !forbidden.has(kaizo.id));
    const total = allowed.reduce((sum, kaizo) => sum + weights[kaizo.id - 1]!, 0n);
    const dex = restore(start).dex;
    expect(tally(outcomes, called)).toEqual(expected(allowed.map((kaizo) => [dex.moves.get(moveId(kaizo)).name, rat(weights[kaizo.id - 1]!, total)])));
    // The fixture's dex lacks most of the 467 moves, so every draw is noted.
    expect(outcomes.every((outcome) => unmodelledNotes(restore(outcome.state)).some((note) => note.includes('Metronome')))).toBe(true);
    expect(allLabels(outcomes)).toContainEqual({ kind: 'pick', side: 'p1', source: 'metronome', outcome: 'tackle' });
    labelled(outcomes);
  });
});

describe('Uproar and sleep', () => {
  const inUproar = (b: Battle, side: 'p1' | 'p2') => expect(b[side].active[0]!.addVolatile('uproar')).toBe(true);

  it('the uproar wakes no Soundproof sleeper, and using it wakes no one: the sleeper wakes at its own attempt (bcp:1506-1521)', () => {
    const sleeper = (ability: number) => changed(battle(monferno([ID.uproar]), zigzagoon([ID.growl]), ability), (b) => {
      inUproar(b, 'p1');
      setStartStatus(b.p2.active[0]!, { kind: 'sleep', turns: 5 });
    });
    for (const outcome of expandTurn(sleeper(ABILITY.soundproof), BOTH)) expect(foe(outcome).status).toBe('slp');
    for (const outcome of expandTurn(sleeper(BA), BOTH)) {
      expect(foe(outcome).status).toBe('');
      const hit = outcome.log.findIndex((line) => line.startsWith('|-damage|p2a: Zigzagoon|'));
      expect(hit).toBeGreaterThanOrEqual(0);
      expect(outcome.log.indexOf('|-curestatus|p2a: Zigzagoon|slp|[msg]')).toBeGreaterThan(hit);
    }
  });

  it('a Soundproof Pokémon can Rest in an uproar, another can\'t (subscript_rest.s:10-11)', () => {
    const resting = (ability: number) => changed(battle(monferno([ID.rest], { ability: knownAbility(ability) }), zigzagoon([ID.uproar])), (b) => {
      inUproar(b, 'p2');
      b.p1.active[0]!.hp = 20;
    });
    for (const outcome of expandTurn(resting(ABILITY.soundproof), BOTH)) expect(mine(outcome).status).toBe('slp');
    for (const outcome of expandTurn(resting(BA), BOTH)) expect(mine(outcome).status).toBe('');
  });

  it('a sleeping Soundproof uproarer stays locked into Uproar: no Sleep Talk (bl:6223-6234, :1834-1841)', () => {
    const start = changed(battle(weakZigzagoon([ID.uproar, ID.sleepTalk], { ability: knownAbility(ABILITY.soundproof) }), deoxys([ID.growl])), (b) => {
      inUproar(b, 'p1');
      setStartStatus(b.p1.active[0]!, { kind: 'sleep', turns: 5 });
    });
    for (const outcome of expandTurn(start, BOTH).filter((other) => 'uproar' in mine(other).volatiles)) {
      expect(mine(outcome).status).toBe('slp');
      expect(legalChoices(outcome.state, 'p1')).toEqual([move(0)]);
    }
  });

  it('the end-of-turn check wakes a sleeper dragged in, even when the uproarer\'s attempt failed (bcp:1506-1527)', () => {
    const start = changed(createBattle({
      player: [weakZigzagoon([ID.uproar])], field: {}, trainer: resolvedTrainer(BAG.none, [zigzagoon([ID.growl]), zigzagoon([ID.growl])]),
    }), (b) => {
      inUproar(b, 'p1');
      expect(b.p1.active[0]!.setStatus('par')).toBe(true);
      setStartStatus(b.p2.pokemon[1]!, { kind: 'sleep', turns: 5 });
    });
    const outcomes = expandTurn(start, { p1: move(0), p2: { kind: 'switch', index: 1 } });
    const paralysed = outcomes.filter(logs('|cant|p1a: Zigzagoon|par'));
    expect(chanceOf(outcomes, (outcome) => paralysed.includes(outcome))).toEqual(rat(1, 4));
    for (const outcome of outcomes) expect(foe(outcome).status).toBe('');
    for (const outcome of paralysed) expect(mine(outcome).volatiles).not.toHaveProperty('uproar');
  });
});

describe('the end of turn (bcp:1289-1734)', () => {
  it('Struggle recoil is max HP / 4, rounded down (bl:3599-3619)', () => {
    const start = battle(playerMon(ID.zigzagoon, 20, [ID.tackle], { pp: [0] }), resolvedMon(ID.monferno, 30, [ID.meanLook]));
    expect(legalChoices(start, 'p1')).toEqual([move(0)]);
    const maxhp = restore(start).p1.active[0]!.maxhp;
    expect(maxhp % 4).toBeGreaterThanOrEqual(2); // where rounding down and Showdown's rounding differ
    for (const outcome of expandTurn(start, BOTH)) {
      expect(outcome.log.some((line) => line.startsWith('|move|p1a: Zigzagoon|Struggle|'))).toBe(true);
      expect(outcome.log.some((line) => line.startsWith('|-damage|p1a: Zigzagoon|') && line.endsWith('|[from] recoil'))).toBe(true);
      expect(mine(outcome).hp).toBe(maxhp - Math.floor(maxhp / 4));
    }
  });

  it('each battler\'s end-of-turn effects run together, in monSpeedOrder (bcp:1302-1310)', () => {
    const start = changed(battle(monferno([ID.meanLook], { item: ITEM.leftovers, status: { kind: 'poison' } }), zigzagoon([ID.meanLook], { item: ITEM.leftovers })), (b) => {
      expect(b.p2.active[0]!.setStatus('psn')).toBe(true);
      for (const side of [b.p1, b.p2]) side.active[0]!.hp -= 20;
    });
    const outcomes = expandTurn(start, BOTH);
    expect(outcomes).toHaveLength(1);
    const order = outcomes[0]!.log.filter((line) => /\|\[from\] (item: Leftovers|psn)$/.test(line))
      .map((line) => `${line.slice(line.indexOf('|p') + 1, line.indexOf('|p') + 4)} ${line.endsWith('psn') ? 'psn' : 'leftovers'}`);
    expect(order).toEqual(['p1a leftovers', 'p1a psn', 'p2a leftovers', 'p2a psn']);
  });

  it('Wish heals before the battlers\' own end-of-turn effects (bcp:1085-1111)', () => {
    const start = runFirstOutcome(battle(monferno([ID.wish, ID.meanLook], { status: { kind: 'poison' } }), zigzagoon([ID.meanLook])), BOTH);
    const [outcome] = expandTurn(changed(start, (b) => { b.p1.active[0]!.hp = 10; }), { p1: move(1), p2: move(0) });
    const wish = outcome!.log.findIndex((line) => line.includes('[from] move: Wish'));
    expect(wish).toBeGreaterThanOrEqual(0);
    expect(wish).toBeLessThan(outcome!.log.findIndex((line) => line.startsWith('|-damage|p1a: Monferno|') && line.endsWith('[from] psn')));
  });

  it('the trainer\'s last Pokémon fainting ends the battle before the player\'s own effects (bcp:1295-1299)', () => {
    // The faster trainer's Monferno is first in monSpeedOrder; its poison faints it before the player's Zigzagoon's runs.
    const start = changed(battle(playerMon(ID.zigzagoon, 20, [ID.meanLook], { status: { kind: 'poison' } }), resolvedMon(ID.monferno, 30, [ID.meanLook])), (b) => {
      expect(b.p2.active[0]!.setStatus('psn')).toBe(true);
      b.p1.active[0]!.hp = 1;
      b.p2.active[0]!.hp = 1;
    });
    const outcomes = expandTurn(start, BOTH);
    expect(outcomes).toHaveLength(1);
    expect([outcomes[0]!.state.phase, mine(outcomes[0]!).hp]).toEqual([{ kind: 'terminal', winner: 'p1' }, 1]);
  });

  it('two replacements at once: the player\'s goes in first, with no speed compare (bs:2408-2413); with a hazard down it is noted', () => {
    const doubleKo = (spikes: boolean) => {
      const start = changed(createBattle({
        player: [playerMon(ID.zigzagoon, 20, [ID.growl], { status: { kind: 'poison' } }), playerMon(ID.zigzagoon, 20, [ID.growl])], field: {},
        trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.monferno, 30, [ID.growl]), zigzagoon([ID.growl])]),
      }), (b) => {
        expect(b.p2.active[0]!.setStatus('psn')).toBe(true);
        b.p1.active[0]!.hp = 1;
        b.p2.active[0]!.hp = 1;
        if (spikes) b.p2.addSideCondition('spikes', b.p1.active[0]!);
      });
      const fainted = expandTurn(start, BOTH);
      expect(fainted).toHaveLength(1);
      expect(fainted[0]!.state.phase).toEqual({ kind: 'playerReplacement' });
      const replaced = expandTurn(fainted[0]!.state, { p1: { kind: 'switch', index: 1 }, p2: { kind: 'switch', index: 1 } });
      expect(replaced).toHaveLength(1);
      return replaced[0]!;
    };
    const plain = doubleKo(false);
    const mineIn = plain.log.findIndex((line) => line.startsWith('|switch|p1a: '));
    expect(mineIn).toBeGreaterThanOrEqual(0);
    expect(mineIn).toBeLessThan(plain.log.findIndex((line) => line.startsWith('|switch|p2a: ')));
    expect(hasLabel([plain], 'speedTie')).toBe(false);
    expect(unmodelledNotes(restore(plain.state))).toEqual([]);
    expect(unmodelledNotes(restore(doubleKo(true).state)).some((note) => note.includes('replaced'))).toBe(true);
  });

  it('Bad Dreams runs in its holder\'s list, the cartridge\'s in the sleeper\'s (bcp:1484-1503): unmodelled', () => {
    const start = changed(battle(monferno([ID.meanLook]), zigzagoon([ID.meanLook]), ABILITY.badDreams), (b) => { expect(b.p1.active[0]!.setStatus('slp')).toBe(true); });
    expect(unmodelledNotes(restore(expandTurn(start, BOTH)[0]!.state)).some((note) => note.includes('Bad Dreams'))).toBe(true);
  });
});
