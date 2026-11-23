// deploy/smoke.sh against a stub of the hosted server that keeps its contract (hostedStub.ts), each option breaking one check.

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { startStub, type Stub, type StubOptions } from './hostedStub.js';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));

let stub: Stub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

describe('deploy/smoke.sh', () => {
  it.each<[string, StubOptions, string[], number, RegExp[]]>([
    ['passes all ten checks against a server that keeps the contract', {}, [], 0, [/All 10 checks passed/]],
    ['signs in with a password', { password: 'hunter2 with spaces' }, ['hunter2 with spaces'],
      0, [/^ok {4}2 {2}sign-in: the page is open, the API is 401 SIGN_IN with no browser prompt, and signing in works$/m]],
    ['fails every check behind a wrong password', { password: 'right' }, ['wrong'], 1, [/^ok {4}1 /m, /^FAIL {2}2 /m, /^FAIL {2}5 /m]],
    ['accepts a 413 sent before the body is read', { oversizeAnswer: 'early' }, [], 0, [/^ok {4}7 /m]],
    ['accepts a 413 sent after the body is read', { oversizeAnswer: 'after-read' }, [], 0, [/^ok {4}7 /m]],
    ['fails check 9 when a plan step does not answer 200', { planStatus: { status: 503, code: 'BUSY' } }, [], 1, [/^FAIL {2}9 {2}a\/single\/1: sheet 200 .*plan step 503/m]],
    ['names a missing security header', { dropHeader: 'x-robots-tag' }, [], 1,
      [/^FAIL {2}10 missing headers: config:x-robots-tag page:x-robots-tag$/m, /1 of 10 checks failed/]],
  ])('%s', async (_, opts, args, code, patterns) => {
    stub = await startStub(opts);
    const result = await run('bash', ['deploy/smoke.sh', stub.url, ...args], { cwd: repo })
      .then(({ stdout }) => ({ code: 0, stdout }), (error: { code: number; stdout: string }) => error);
    expect(result.code).toBe(code);
    for (const pattern of patterns) expect(result.stdout).toMatch(pattern);
  });

  it('refuses a base URL that is not http or https, and a missing one', async () => {
    for (const args of [['planner.example.com'], []]) {
      await expect(run('bash', ['deploy/smoke.sh', ...args], { cwd: repo })).rejects.toMatchObject({ code: 2 });
    }
  });
});
