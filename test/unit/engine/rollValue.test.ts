// A damage roll's label says what its number is (`ChanceLabel.rollValue`): 'final', the hit's damage after every modifier,
// for a pick the collapse grouped by final damage (and the `>=hp` group, and the confusion self-hit's equal-damage groups);
// 'base', the roll's own value before STAB, the chart and the final modifiers, for every other roll pick (`collapse:
// false`, an impure `ModifyDamage` handler such as a resist berry's, Showdown's own `damageRoll`). No other label has one.

import { beforeAll, describe, expect, it } from 'vitest';
import type { BattleInput, ChanceLabel, Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import { createBattle, restore, runFirstOutcome, snapshot } from '../../../src/engine/battle.js';
import { ChanceDriver, labelOf } from '../../../src/engine/chance.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import { expandTurn } from '../../../src/engine/expand.js';
import { hpOf } from '../../../src/engine/index.js';
import { BAG, emberRolls, emberTurn, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';
import { knockouts, locks } from './peekSeedCorpus.js';
import { emptyCorpus, walk } from './walk.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH_FIRST = { p1: move(0), p2: move(0) };
const CONFUSED_ATTEMPT = { p1: move(1), p2: move(0) }; // Mean Look into the confused foe's first attempt
const OCCA_BERRY = 184;
const CHILAN_BERRY = 200;
const duel = (mine: PlayerMon, theirs: ResolvedMon): BattleInput => ({ player: [mine], trainer: resolvedTrainer(BAG.none, [theirs]), field: {} });

/** Ember's median non-crit damage: half its rolls knock out a Zigzagoon left on it. */
const MEDIAN_EMBER = [...emberRolls(false)].sort((a, b) => a - b)[8]!;
/** Tropius holding an Occa Berry against Monferno's Ember: STAB, the chart's 2, the berry's 1/2. */
const occaTurn = () => createBattle(duel(playerMon(ID.tropius, 30, [ID.growl], { item: OCCA_BERRY }), resolvedMon(ID.monferno, 30, [ID.ember])));
/** The trainer's Zigzagoon (holding `item`) confused by Confuse Ray, before its first confused attempt. */
const confused = (item?: number) => runFirstOutcome(createBattle(duel(playerMon(ID.monferno, 30, [ID.confuseRay, ID.meanLook]),
  resolvedMon(ID.zigzagoon, 20, [ID.meanLook], item === undefined ? {} : { item }))), BOTH_FIRST);

const rolls = (outcome: Outcome): ChanceLabel[] => outcome.labels.filter((label) => label.kind === 'roll');
/** `outcome`'s one roll label. */
function rollOf(outcome: Outcome): ChanceLabel {
  expect(rolls(outcome)).toHaveLength(1);
  return rolls(outcome)[0]!;
}
/** Whether `outcome` drew a secondary effect, whose end-of-turn damage adds to the hit's. */
const effected = (outcome: Outcome) => outcome.labels.some((label) => label.kind === 'effect' && label.outcome !== 'none');
const lost = (side: 'p1' | 'p2', before: EngineState, outcome: Outcome) => hpOf(before)[side][0]! - hpOf(outcome.state)[side][0]!;
/** Each rolled outcome's label matches `label`, and (where `dealt` is given and checkable) the HP lost is `dealt(roll)`. */
function checkRolls(start: EngineState, outcomes: Outcome[], side: 'p1' | 'p2', label: object, dealt: (roll: number) => number, skipUnclean = true) {
  let checked = 0;
  for (const outcome of outcomes.filter((each) => rolls(each).length > 0)) {
    const roll = rollOf(outcome);
    expect(roll).toMatchObject(label);
    if (skipUnclean && (effected(outcome) || hpOf(outcome.state)[side][0] === 0)) continue;
    expect(lost(side, start, outcome)).toBe(dealt(Number(roll.outcome)));
    checked++;
  }
  return checked;
}
const stab = (roll: number) => Math.floor((roll * 15) / 10); // Monferno's STAB on Ember

describe('a roll label says what its number is', () => {
  it('a collapsed pick says final, and its outcome is the damage the hit dealt: Ember\'s 16 rolls by value', () => {
    const start = createBattle(emberTurn());
    // Every crit knocks Zigzagoon out at full HP, so the crit branch draws no roll.
    const outcomes = expandTurn(start, BOTH_FIRST).filter((outcome) => !effected(outcome));
    expect(checkRolls(start, outcomes, 'p2', { side: 'p1', source: 'ember', rollValue: 'final' }, (roll) => roll)).toBeGreaterThan(5);
    expect(new Set(outcomes.filter((outcome) => rolls(outcome).length > 0).map((outcome) => Number(rollOf(outcome).outcome)))).toEqual(new Set(emberRolls(false)));
  });

  it('the >=hp option says final, as do the collapsed rolls that leave the foe standing', () => {
    const start = (() => { const battle = restore(createBattle(emberTurn())); battle.p2.active[0]!.hp = MEDIAN_EMBER; return snapshot(battle); })();
    const outcomes = expandTurn(start, BOTH_FIRST);
    expect(outcomes.find((outcome) => !outcome.critBy.p1 && hpOf(outcome.state).p2[0] === 0)!.labels)
      .toContainEqual({ kind: 'roll', side: 'p1', source: 'ember', outcome: '≥hp', rollValue: 'final' });
    const standing = outcomes.filter((outcome) => hpOf(outcome.state).p2[0]! > 0 && !effected(outcome));
    expect(checkRolls(start, standing, 'p2', { rollValue: 'final' }, (roll) => roll)).toBe(new Set(emberRolls(false).filter((damage) => damage < MEDIAN_EMBER)).size);
  });

  it('a pick left uncollapsed for a resist berry says base: STAB, the chart\'s 2 and the berry\'s 1/2 give the roll x 1.5', () => {
    const start = occaTurn();
    expect(checkRolls(start, expandTurn(start, BOTH_FIRST), 'p1', { side: 'p2', source: 'ember', rollValue: 'base' }, stab)).toBeGreaterThan(5);
  });

  it('the confusion self-hit collapses by equal damage: final, the damage it dealt itself (8, 7 and 6)', () => {
    const start = confused();
    const hurt = expandTurn(start, CONFUSED_ATTEMPT).filter((outcome) => rolls(outcome).length > 0);
    expect(hurt).toHaveLength(3);
    checkRolls(start, hurt, 'p2', { side: 'p2', source: 'confusion', rollValue: 'final' }, (roll) => roll, false);
  });

  it('a confused resist-berry holder rolls its self-hit uncollapsed: base, the roll before the Chilan Berry halves it', () => {
    // The berry fires on this self-hit (the chosen Mean Look is Normal); 8 gives 4, and 7 and 6 both 3, merged.
    const start = confused(CHILAN_BERRY);
    const hurt = expandTurn(start, CONFUSED_ATTEMPT).filter((outcome) => rolls(outcome).length > 0);
    expect(hurt).toHaveLength(2);
    for (const outcome of hurt) expect(outcome.log.some((line) => line.startsWith('|-enditem|p2a: Zigzagoon|Chilan Berry'))).toBe(true);
    checkRolls(start, hurt, 'p2', { side: 'p2', source: 'confusion', rollValue: 'base' }, (roll) => Math.max(1, Math.trunc(roll / 2)), false);
  });

  it('with collapse: false every roll pick says base, and its outcome is the roll before STAB', () => {
    const start = createBattle(emberTurn());
    expect(checkRolls(start, expandTurn(start, BOTH_FIRST, { collapse: false }), 'p2', { rollValue: 'base' }, stab)).toBeGreaterThan(5);
    const selfHits = expandTurn(confused(), CONFUSED_ATTEMPT, { collapse: false }).flatMap(rolls);
    expect(selfHits.map((roll) => roll.rollValue)).toEqual(['base', 'base', 'base']);
  });

  it('Showdown\'s own rolls through damageRoll (randomizer, getConfusionDamage) say base, even under a collapsing driver', () => {
    const driver = new ChanceDriver([], { collapse: true });
    const battle = restore(createBattle(emberTurn()), driver);
    battle.randomizer(50);
    battle.actions.getConfusionDamage(battle.p1.active[0]!, 40);
    expect(driver.points.map(labelOf).map(({ kind, source, rollValue }) => [kind, source, rollValue])).toEqual([['roll', 'damage', 'base'], ['roll', 'confusion', 'base']]);
  });

  it('over a corpus of turns, every roll label has a rollValue and no label of another kind has one', () => {
    /** A mirror lead (speed ties) and chance-heavy moves: burns, confusion, sleep, paralysis, Present, Magnitude, locks. */
    const chances = (): BattleInput => ({
      player: [playerMon(ID.monferno, 30, [ID.ember, ID.confuseRay, ID.thunderWave, ID.furyAttack]), playerMon(ID.pikachu, 30, [ID.thunder, ID.spore, ID.magnitude, ID.present])],
      trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.monferno, 30, [ID.triAttack, ID.confuseRay, ID.outrage, ID.wrap]), resolvedMon(ID.zigzagoon, 30, [ID.spore, ID.roar, ID.protect, ID.flameWheel])]),
      field: {},
    });
    const corpus = emptyCorpus();
    for (const [input, steps, seeds] of [[emberTurn, 4, [1, 2]], [knockouts, 6, [1, 2]], [locks, 4, [1, 2]], [chances, 8, [2, 3]]] as const) {
      for (const seed of seeds) walk(corpus, input(), steps, seed, 1_500);
    }
    const labels = [...corpus.outcomes, ...expandTurn(occaTurn(), BOTH_FIRST), ...expandTurn(confused(CHILAN_BERRY), CONFUSED_ATTEMPT),
      ...expandTurn(createBattle(emberTurn()), BOTH_FIRST, { collapse: false })].flatMap((outcome) => outcome.labels);
    expect(new Set(labels.map((label) => label.kind)).size).toBeGreaterThanOrEqual(10);
    for (const label of labels) {
      if (label.kind === 'roll') expect(['final', 'base']).toContain(label.rollValue);
      else expect(Object.hasOwn(label, 'rollValue')).toBe(false);
    }
    expect(new Set(labels.filter((label) => label.kind === 'roll').map((label) => label.rollValue))).toEqual(new Set(['final', 'base']));
  }, 300_000);
});
