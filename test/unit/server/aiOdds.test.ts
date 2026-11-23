// The AI odds level's cut of a sheet pair's odds (src/server/aiOdds.ts): full is the answer itself; likeliest keeps the
// actions tied for the top, ranked keeps every action with its rank, neither with a probability; a `depends` whose cases
// come out the same at the level is merged, down to `ok` when one case is left.

import { describe, expect, it } from 'vitest';
import type { AiOddsJson, SheetAiPairJson } from '../../../src/contracts/api.js';
import { sheetOddsAt, sheetPairAt } from '../../../src/server/aiOdds.js';

const c = (label: string, probability: string, kind: 'move' | 'switch' | 'item' = 'move') => ({ label, kind, probability });
const ok = (...choices: ReturnType<typeof c>[]): AiOddsJson => ({ status: 'ok', choices });
/** Choices at a cut level: [label, rank] pairs, moves unless `kind` says otherwise. */
const ranked = (pairs: [string, number][], kind: 'move' | 'switch' = 'move') => pairs.map(([label, rank]) => ({ label, kind, rank }));

describe('sheetOddsAt', () => {
  const odds = ok(c('Earthquake', '1/2'), c('Gyro Ball', '1/4'), c('Rock Slide', '1/4'), c('Explosion', '0/1'));
  const depends: AiOddsJson = {
    status: 'depends', on: "Forretress's nature",
    cases: [
      { when: 'Hardy', choices: [c('Earthquake', '1/1')] },
      { when: 'Sassy or Bold', choices: [c('Earthquake', '3/4'), c('Gyro Ball', '1/4')] },
      { when: 'Brave', choices: [c('Gyro Ball', '3/4'), c('Earthquake', '1/4')] },
    ],
  };

  it.each<[string, 'likeliest' | 'ranked', AiOddsJson, unknown]>([
    ['likeliest: the top action alone, rank 1', 'likeliest', odds, { status: 'ok', choices: ranked([['Earthquake', 1]]) }],
    ['likeliest: every one tied for the top', 'likeliest', ok(c('Growl', '1/2'), c('Tackle', '1/2')), { status: 'ok', choices: ranked([['Growl', 1], ['Tackle', 1]]) }],
    ['likeliest: ties are exact, 2/4 is 1/2', 'likeliest', ok(c('Growl', '2/4'), c('Tackle', '1/2')), { status: 'ok', choices: ranked([['Growl', 1], ['Tackle', 1]]) }],
    ['ranked: ties share a rank and the next counts them', 'ranked', odds,
      { status: 'ok', choices: ranked([['Earthquake', 1], ['Gyro Ball', 2], ['Rock Slide', 2], ['Explosion', 4]]) }],
    ['likeliest: depends cases that come out the same are merged, their values listed together', 'likeliest', depends, {
      status: 'depends', on: "Forretress's nature",
      cases: [{ when: 'Hardy, Sassy or Bold', choices: ranked([['Earthquake', 1]]) }, { when: 'Brave', choices: ranked([['Gyro Ball', 1]]) }],
    }],
    ['ranked: each depends case cut to the level', 'ranked', depends, {
      status: 'depends', on: "Forretress's nature",
      cases: [
        { when: 'Hardy', choices: ranked([['Earthquake', 1]]) },
        { when: 'Sassy or Bold', choices: ranked([['Earthquake', 1], ['Gyro Ball', 2]]) },
        { when: 'Brave', choices: ranked([['Gyro Ball', 1], ['Earthquake', 2]]) },
      ],
    }],
    ['likeliest: one case left once merged is plain ok, so the answer does not tell the odds differ', 'likeliest', {
      status: 'depends', on: "Bronzor's ability",
      cases: [{ when: 'Levitate', choices: [c('Bronzong', '1/1', 'switch')] }, { when: 'Heatproof', choices: [c('Bronzong', '2/3', 'switch'), c('Onix', '1/3', 'switch')] }],
    }, { status: 'ok', choices: ranked([['Bronzong', 1]], 'switch') }],
    ['ranked: an unproven sum of odds loses its figures', 'ranked', { status: 'unproven', code: 'BAD_SUPPORT', reason: "The AI's odds sum to 3/4, not 1" },
      { status: 'unproven', code: 'BAD_SUPPORT', reason: "The AI's odds do not add up" }],
  ])('%s', (_name, level, answer, cut) => {
    expect(sheetOddsAt(level, answer)).toEqual(cut);
  });

  it('full is the very answer; none, unsupported and unproven pass through every level', () => {
    const bad: AiOddsJson = { status: 'unproven', code: 'BAD_SUPPORT', reason: "The AI's odds sum to 3/4, not 1" };
    expect([sheetOddsAt('full', odds) === odds, sheetOddsAt('full', bad) === bad]).toEqual([true, true]);
    const plain = [
      { status: 'none', reason: 'Nothing left to send in' }, { status: 'unsupported', reason: 'The weather is not settled for this pair' },
      { status: 'unproven', code: 'DIV_ZERO', reason: 'division by zero' },
    ] as AiOddsJson[];
    expect([plain.map((p) => sheetOddsAt('likeliest', p)), plain.map((p) => sheetOddsAt('ranked', p))]).toEqual([plain, plain]);
  });
});

it('sheetPairAt cuts both answers and keeps whose pair it is; full is the pair itself', () => {
  const pair: SheetAiPairJson = {
    player: 'party:1', enemy: 'enemy:0', next: ok(c('Growl', '1/2'), c('Tackle', '1/2')), ifFaints: ok(c('Starly', '2/3', 'switch'), c('Bidoof', '1/3', 'switch')),
  };
  expect([sheetPairAt('full', pair) === pair, sheetPairAt('likeliest', pair), sheetPairAt('ranked', pair).ifFaints]).toEqual([true, {
    player: 'party:1', enemy: 'enemy:0',
    next: { status: 'ok', choices: ranked([['Growl', 1], ['Tackle', 1]]) }, ifFaints: { status: 'ok', choices: ranked([['Starly', 1]], 'switch') },
  }, { status: 'ok', choices: ranked([['Starly', 1], ['Bidoof', 2]], 'switch') }]);
});
