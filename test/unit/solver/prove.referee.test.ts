import { expect, it } from 'vitest';
import { rootBelief } from '../../../src/solver/belief.js';
import { defaultLabeler } from '../../../src/solver/labeler.js';
import { Prover } from '../../../src/solver/prove.js';
import { scenarioArena } from './toy/fixtures.js';
import { randomToyFight } from './toy/random.js';
import { refFightOf, refTier1 } from './toy/referee.js';

it('the prover agrees with the referee on 60 seeded fights, in display and RAM mode', () => {
  let wins = 0;
  let repetitions = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const fight = randomToyFight(seed);
    const expected = refTier1(refFightOf(fight));
    for (const mode of ['display', 'ram'] as const) {   // observeAll: display mode is full information
      const arena = scenarioArena({ ...fight, name: fight.trainerId, expect: {} });
      const { result } = new Prover(arena, {
        params: { level: 1, critBudget: null, thresholds: null }, mode, deadline: Number.POSITIVE_INFINITY, now: () => 0, labeler: defaultLabeler, history: new Map(),
      }).deepen(rootBelief(arena), fight.horizon);
      expect(result.kind, `seed ${seed} ${mode}`).not.toBe('unknown');
      expect(result.kind === 'win', `seed ${seed} ${mode}`).toBe(expected);
      if (mode === 'display' && result.kind === 'win') wins += 1;
      if (result.kind === 'fail' && result.reasons.repetition) repetitions += 1;
      if (result.kind === 'fail') expect(Object.values(result.reasons).some(Boolean), `seed ${seed} ${mode} reasons`).toBe(true);
    }
  }
  expect([wins, repetitions > 0]).toEqual([24, true]);   // the generator's tier-1 count; the repetition rule was exercised
});
