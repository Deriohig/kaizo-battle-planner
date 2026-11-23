import { describe, expect, it } from 'vitest';
import { BATTLE_NOTES, BATTLE_START_CHANCE_NOTE, KNOCK_OFF_PLATE_NOTE, PICKUP_NOTE, RESIST_BERRY_NOTE } from '../../../src/engine/index.js';
import { metronomeCallNote } from '../../../src/engine/mod/moves.js';
import { expectEngineOnlyDetail } from '../../real/unmodelledDetail.js';

describe('expectEngineOnlyDetail', () => {
  const MOVE = 'Pursuit: no entry for its effect text ("Hits a switching foe")';
  const REST = 'Rest: a status-move effect on a physical move';

  it.each([
    `unmodelled: ${MOVE}`,
    `unmodelled: ${MOVE}; ${REST}`,
    'unmodelled: engine: move "zzz" is not a hack move',
    `unmodelled: Roost: damage calc: has a note; ${REST}`,
    'unmodelled: Facade: not modelled yet ("2x power if user is Poisoned; Paralyzed; or Burned.")',   // "; " inside a move note
    `unmodelled: ${BATTLE_START_CHANCE_NOTE}; ${RESIST_BERRY_NOTE}; ${PICKUP_NOTE}; ${KNOCK_OFF_PLATE_NOTE}`,
    ...[...BATTLE_NOTES, metronomeCallNote('Splash')].flatMap((note) => [`unmodelled: ${note}`, `unmodelled: ${MOVE}; ${note}; ${REST}`]),
  ])('accepts what the engine itself reports: %s', (detail) => {
    expectEngineOnlyDetail(detail);
  });

  it.each([
    `unmodelled: ${MOVE}; integration: the trainer's field (rain) is not applied`,
    'unmodelled: integration: something',
    `unmodelled: ${MOVE}; undefined AI behaviour: UNDEFINED`,
    `unmodelled: ${MOVE}; AI error DIV_ZERO`,
    'unmodelled: trainer item: undefined effect category (ITEM_AI_CATEGORY_MAX)',
    `unmodelled: ${BATTLE_START_CHANCE_NOTE} and more`,
    'unmodelled: engine: Metronome called Splash, which the engine models',
    'unmodelled: engine: some invented note',
    'unmodelled: ',
    '',
    undefined,
  ])('rejects an integration note, an AI error, a note the engine does not report, or no detail: %s', (detail) => {
    expect(() => expectEngineOnlyDetail(detail)).toThrow();
  });
});
