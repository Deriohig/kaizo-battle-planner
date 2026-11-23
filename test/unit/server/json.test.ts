import { describe, expect, it } from 'vitest';
import type { ProofReport } from '../../../src/contracts/solver.js';
import type { StartStatus } from '../../../src/save/status.js';
import { rationalJson, statusFromJson, statusToJson, toJsonValue } from '../../../src/server/json.js';

const report: ProofReport = {
  nodes: 12, turnExecutions: 30, ttEntries: 4, ttHits: 1, elapsedMs: 5, enumerated: ['rolls', 'crits'], assumptions: ['independence'],
  rejectedTeams: [{ team: ['party:2'], firstFailure: 'dies to Rock Slide' }],
  verification: { passed: true, damageChecks: 2, orderChecks: 1, mismatches: [], notCrossChecked: [] }, modelNote: null,
};
const r = (num: bigint, den: bigint) => ({ num, den });

describe('rationalJson and toJsonValue', () => {
  it('turns every Rational in a nested verdict-like object into "num/den", copying deeply and leaving the input alone', () => {
    expect([rationalJson(r(1n, 16n)), rationalJson(r(0n, 1n))]).toEqual(['1/16', '0/1']);
    const value = {
      tier: 2, deathProbability: r(1n, 16n), killers: [{ path: ['If Rock Slide crits'], probability: r(1n, 16n), cause: 'crit' }],
      tree: { kind: 'chance', branches: [
        { label: 'If Rock Slide crits', probability: r(1n, 16n), next: { result: 'death' } },
        { label: '', probability: r(15n, 16n), next: { result: 'win', endHp: [40, 0], endStatus: [{ kind: 'sleep', turns: 1 }, { kind: 'none' }] } },
      ] },
      report,
    };
    const json = toJsonValue(value) as typeof value;
    expect(json).toEqual({
      ...value, deathProbability: '1/16', killers: [{ ...value.killers[0], probability: '1/16' }],
      tree: { kind: 'chance', branches: [{ ...value.tree.branches[0], probability: '1/16' }, { ...value.tree.branches[1], probability: '15/16' }] },
    });
    expect(() => JSON.stringify(json)).not.toThrow();
    expect([json.report === report, json.report.verification === report.verification, value.deathProbability]).toEqual([false, false, r(1n, 16n)]);
  });

  it('a bigint outside a Rational throws a TypeError with its path', () => {
    const thrown = (value: unknown) => { try { toJsonValue(value); return null; } catch (e) { return [(e as Error).name, (e as Error).message]; } };
    expect([{ report: { nodes: 5n } }, { killers: [{ probability: { num: 1n } }] }, { odds: { num: 1n, den: 2n, extra: 3n } }, 5n].map(thrown)).toEqual([
      ['TypeError', expect.stringMatching(/report\.nodes/)], ['TypeError', expect.stringMatching(/killers\[0\]\.probability\.num/)],
      ['TypeError', expect.stringMatching(/odds\.num/)], ['TypeError', expect.any(String)],
    ]);
  });
});

describe('status strings', () => {
  const named = ['poison', 'toxic', 'burn', 'freeze', 'paralysis'] as const;
  it('statusToJson and statusFromJson map sleep:1 to sleep:7 and the named statuses both ways; no status is null', () => {
    const pairs: [StartStatus, string][] = [[{ kind: 'sleep', turns: 1 }, 'sleep:1'], [{ kind: 'sleep', turns: 7 }, 'sleep:7'], ...named.map((kind): [StartStatus, string] => [{ kind }, kind])];
    for (const [status, text] of pairs) expect([statusToJson(status), statusFromJson(text)]).toEqual([text, status]);
    expect(statusToJson({ kind: 'none' })).toBeNull();
    expect(statusToJson({ kind: 'sleepUndrawn', attempts: 2 })).toBe('sleepUndrawn:2');   // a carried sleep not yet drawn
  });

  it.each(['sleep:0', 'frozen', 'sleep:8', 'sleep:', 'sleep:01', 'none', '', ' burn', 'Burn', 'sleep'])('statusFromJson(%j) is null', (text) => {
    expect(statusFromJson(text)).toBeNull();
  });
});
