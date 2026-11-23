import { expect, it } from 'vitest';
import { DEFAULT_CONFIG, resolveConfig } from '../../../src/solver/config.js';

it('resolveConfig fills defaults and skips undefined', () => {
  expect(resolveConfig({ threads: undefined, planNodeLimit: 7 })).toEqual({ ...DEFAULT_CONFIG, planNodeLimit: 7 });
  expect(resolveConfig({ threads: 2, maxTeamCandidates: 0, checkerBudgetFactor: 0 })).toMatchObject({ threads: 2, maxTeamCandidates: 0, checkerBudgetFactor: 0 });
});

it.each([
  { threads: 0 }, { threads: 1.5 }, { planNodeLimit: 0 }, { checkerBudgetFactor: -1 }, { maxWorlds: 0 }, { maxTeamCandidates: -1 }, { maxTeamCandidates: 1.5 },
])('resolveConfig rejects %o', (bad) => {
  expect(() => resolveConfig(bad)).toThrow(RangeError);
});
