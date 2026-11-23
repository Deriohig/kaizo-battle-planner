// scripts/loadTest.ts: its verdicts, and short runs against the hosted stub (hostedStub.ts).

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { percentile, verdicts } from '../../../scripts/loadTest.js';
import { startStub, type Stub, type StubOptions } from './hostedStub.js';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const tsx = path.join(repo, 'node_modules', '.bin', 'tsx');

type S = Parameters<typeof verdicts>[0][number];
type Facts = Parameters<typeof verdicts>[1];
const sample = (op: S['op'], status: number, ms = 10, code: string | null = null): S => ({ op, status, ms, code });
const FACTS: Facts = { peakMb: 400, memoryRequired: true, playersWithoutSave: 0 };
const healthy = [sample('upload', 200), sample('plan', 200, 100), sample('sheet', 200), sample('health', 200, 5)];
const many = Array.from({ length: 99 }, () => sample('sheet', 200));   // with `healthy`, one more request is 1 in 103

let stub: Stub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

it('percentile is the nearest rank', () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1);
  expect([percentile(values, 95), percentile(values, 99), percentile([5, 1, 3], 50)]).toEqual([95, 99, 3]);
  expect(percentile([], 50)).toBeNaN();
});

describe('verdicts', () => {
  it.each<[string, S[], Partial<Facts>, (string | RegExp)[]]>([
    ['a quiet run', [], {}, []],
    ['a 5xx', [sample('plan', 500, 10, 'INTERNAL')], {}, [/^requests: 4; failed other than BUSY and NO_SAVE: 1 \(plan 500 INTERNAL\)/]],
    ['a 4xx', [sample('sheet', 400)], {}, [/\(sheet 400\)$/]],
    ['a RATE_LIMITED', [sample('plan', 429, 10, 'RATE_LIMITED')], {}, [/\(plan 429 RATE_LIMITED\)$/]],
    ['no answer at all', [sample('ai', 0)], {}, [/^requests: 4; failed other than BUSY and NO_SAVE: 1 /]],
    ['NO_SAVE under 1%', [...many, sample('plan', 409, 10, 'NO_SAVE')], {}, []],
    ['NO_SAVE at 1% or more', [sample('plan', 409, 10, 'NO_SAVE')], {}, [/^NO_SAVE \(a dropped session, re-sent\): 1 \(25\.00%/]],
    ["a plan step's 422 AI_UNDEFINED, an expected answer", [sample('plan', 422, 10, 'AI_UNDEFINED')], {}, []],
    ['a 422 AI_UNDEFINED that is not a plan step', [sample('sheet', 422, 10, 'AI_UNDEFINED')], {}, [/\(sheet 422 AI_UNDEFINED\)$/]],
    ["a plan step's other 422", [sample('plan', 422, 10, 'BAD_START')], {}, [/\(plan 422 BAD_START\)$/]],
    ['a player that never got its save in', [], { playersWithoutSave: 2 }, ['players that never held a save: 2']],
    ['BUSY under 1% (health is not a request)', [...many, sample('plan', 503, 10, 'BUSY')], {}, []],
    ['BUSY at 1% or more', [sample('plan', 503, 10, 'BUSY')], {}, [/^BUSY: 1 \(25\.00%/]],
    ['a slow plan step p95', Array.from({ length: 5 }, () => sample('plan', 200, 2500)), {}, [/^plan step p95: 2500 ms/]],
    ['a slow health', [sample('health', 200, 600)], {}, [/^health p99: 600 ms/]],
    ['a failing health', [sample('health', 0, 1)], {}, [/1 not 200/]],
    ['memory at 700 MB', [], { peakMb: 700 }, ['memory peak: 700 MB (under 700 to pass)']],
    ['memory at 699 MB', [], { peakMb: 699 }, []],
    ['memory not measured', [], { peakMb: null }, ['memory: not measured (pass --pid or --container, or --no-memory to skip it)']],
    ['memory not measured, waived', [], { peakMb: null, memoryRequired: false }, []],
    ['every session gone after the idle time', [], { idle: { gone: 20, of: 20 } }, []],
    ['a session left after the idle time', [], { idle: { gone: 19, of: 20 } }, ['sessions gone after the idle time: 19 of 20']],
  ])('%s', (_, extra, facts, failed) => {
    const lines = verdicts([...healthy, ...extra], { ...FACTS, ...facts }).filter((v) => !v.ok).map((v) => v.line);
    expect(lines).toEqual(failed.map((line) => (typeof line === 'string' ? line : expect.stringMatching(line))));
  });

  it("reports a plan step's AI_UNDEFINED apart", () => {
    const answers = [sample('plan', 422, 10, 'AI_UNDEFINED'), sample('plan', 422, 10, 'AI_UNDEFINED')];
    expect(verdicts([...healthy, ...answers], FACTS))
      .toContainEqual({ line: 'plan steps the AI cannot answer (422 AI_UNDEFINED, an expected answer): 2', ok: true });
  });
});

describe('npm run loadtest', () => {
  it('runs players against a hosted server, each with its own forwarded address, and passes', async () => {
    stub = await startStub();
    const { stdout } = await run(tsx, ['scripts/loadTest.ts', stub.url, '--players', '3', '--seconds', '2', '--think', '20', '--pid', String(stub.pid)], { cwd: repo });
    expect(stdout).toMatch(/^Load: 3 players for 2 s/m);
    for (const line of ['requests: \\d+; failed other than BUSY and NO_SAVE: 0$', 'players that never held a save: 0$', 'memory peak: \\d+ MB', 'plan step p95']) {
      expect(stdout).toMatch(new RegExp(`^ok {4}${line}`, 'm'));
    }
    expect(stdout).not.toMatch(/^FAIL/m);
    expect([...stub.forwarded].sort()).toEqual(['198.51.100.1', '198.51.100.2', '198.51.100.3']);
  });

  it.each<[string, StubOptions, string[], RegExp]>([
    ['plan steps fail', { planStatus: { status: 500, code: 'INTERNAL' } }, ['--players', '2', '--no-memory'], /^FAIL {2}requests: .*plan 500 INTERNAL/m],
    ['memory was not measured', {}, ['--players', '1'], /^FAIL {2}memory: not measured/m],
  ])('exits 1 when %s (--same-ip forwards no address)', async (_, opts, args, failed) => {
    stub = await startStub(opts);
    await expect(run(tsx, ['scripts/loadTest.ts', stub.url, ...args, '--same-ip', '--seconds', '1', '--think', '20'], { cwd: repo }))
      .rejects.toMatchObject({ code: 1, stdout: expect.stringMatching(failed) });
    expect(stub.forwarded.size).toBe(0);
  });
});
