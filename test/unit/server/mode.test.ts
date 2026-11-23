import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { healthJson, type HostedConfig, ModeError, readMode, staticDirFor } from '../../../src/server/mode.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const MAIN_TS = 'file:///repo/src/server/main.ts';
const MAIN_JS = 'file:///repo/dist/server/server/main.js';
const MB = 1024 * 1024;
const HOSTED = ['--hosted'];
const LEVELS = ['full', 'likeliest', 'ranked', 'off'];
const ODDS_ERROR = (bad: string) => `PKP_AI_ODDS must be full, likeliest, ranked or off, not ${JSON.stringify(bad)}`;

/** The `ModeError` message `run` throws. */
function modeError(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ModeError);
    return (error as ModeError).message;
  }
  throw new Error('Expected a ModeError');
}

const HOSTED_DEFAULTS: HostedConfig = {
  host: '0.0.0.0', port: 8080, dataDir: 'data', staticDir: '/repo/dist/web', password: null, trustProxy: 0, allowOrigins: [],
  maxSessions: 200, sessionsPerIp: 8, sessionIdleMs: 120 * 60_000, sessionMemoryBytes: 256 * MB, heavyConcurrency: 2, heavyQueue: 32,
  logRequests: true, version: 'dev', aiOdds: 'full',
};
const H = (config: object) => ({ mode: 'hosted', config });

describe('readMode', () => {
  it('is local by default; --hosted or PKP_MODE=hosted give every hosted default, and --hosted wins over PKP_MODE=local', () => {
    expect(readMode([], {}, MAIN_TS)).toEqual({ mode: 'local', port: 4310, dataDir: 'data', staticDir: '/repo/dist/web', version: 'dev', aiOdds: 'full' });
    expect([readMode(HOSTED, {}, MAIN_TS), readMode([], { PKP_MODE: 'hosted' }, MAIN_TS)]).toEqual([H(HOSTED_DEFAULTS), H(HOSTED_DEFAULTS)]);
    expect(readMode(HOSTED, { PKP_MODE: 'local' }, MAIN_TS).mode).toBe('hosted');
  });

  it.each<[string[], Record<string, string>, object]>([
    // Local mode ignores PORT and PKP_HOST, even ones that would not parse.
    [[], { PORT: '9999', PKP_HOST: 'not a host' }, { mode: 'local', port: 4310 }], [[], { PKP_MODE: 'local' }, { mode: 'local' }],
    [[], { PKP_MODE: '' }, { mode: 'local' }], [['--port', '5000'], {}, { mode: 'local', port: 5000 }], [['--port=65535'], {}, { port: 65535 }],
    [[], { PKP_DATA: '/srv/data', PKP_VERSION: '1.2.3' }, { dataDir: '/srv/data', version: '1.2.3' }],
    [[], { PKP_STATIC: '/srv/web' }, { staticDir: '/srv/web' }], [HOSTED, { PKP_STATIC: '/srv/web' }, H({ staticDir: '/srv/web' })],
    // Hosted: --port over PORT over 8080.
    [['--hosted', '--port', '7000'], { PORT: '9000' }, H({ port: 7000 })], [HOSTED, { PORT: '9000' }, H({ port: 9000 })],
    [HOSTED, { PORT: '' }, H({ port: 8080 })], [HOSTED, { PKP_HOST: '::' }, H({ host: '::' })],
    [HOSTED, { PKP_HOST: '127.0.0.1' }, H({ host: '127.0.0.1' })], [HOSTED, { PKP_HOST: '' }, H({ host: '0.0.0.0' })],
    [HOSTED, { PKP_PASSWORD: 'hunter2' }, H({ password: 'hunter2' })], [HOSTED, { PKP_PASSWORD: '' }, H({ password: null })],
    [HOSTED, { PKP_LOG: 'requests' }, H({ logRequests: true })], [HOSTED, { PKP_LOG: 'off' }, H({ logRequests: false })],
    [HOSTED, { PKP_LOG: '' }, H({ logRequests: true })], [HOSTED, { PKP_TRUST_PROXY: '0' }, H({ trustProxy: 0 })],
    // Origins trimmed, a trailing slash dropped, empty parts skipped.
    [HOSTED, { PKP_ALLOW_ORIGIN: 'http://localhost:5173, https://dev.example.com/,,' },
      H({ allowOrigins: ['http://localhost:5173', 'https://dev.example.com'] })],
    [HOSTED, { PKP_ALLOW_ORIGIN: '' }, H({ allowOrigins: [] })],
    [HOSTED, { PKP_DATA: '/data', PKP_VERSION: 'v7' }, H({ dataDir: '/data', version: 'v7' })],
    // PKP_AI_ODDS in both modes: full by default and when empty, else the level given.
    ...[undefined, '', ...LEVELS].flatMap((level): [string[], Record<string, string>, object][] => {
      const env: Record<string, string> = level === undefined ? {} : { PKP_AI_ODDS: level };
      return [[[], env, { mode: 'local', aiOdds: level || 'full' }], [HOSTED, env, H({ aiOdds: level || 'full' })]];
    }),
  ])('argv %j and env %j give %j', (argv, env, expected) => {
    expect(readMode(argv, env, MAIN_TS)).toMatchObject(expected);
  });

  // [variable, field, value set, field's value for it].
  it.each<[string, keyof HostedConfig, string, number]>([
    ['PKP_TRUST_PROXY', 'trustProxy', '1', 1], ['PKP_MAX_SESSIONS', 'maxSessions', '50', 50], ['PKP_SESSIONS_PER_IP', 'sessionsPerIp', '3', 3],
    ['PKP_SESSION_IDLE_MIN', 'sessionIdleMs', '30', 30 * 60_000], ['PKP_SESSION_MEMORY_MB', 'sessionMemoryBytes', '64', 64 * MB],
    ['PKP_HEAVY_CONCURRENCY', 'heavyConcurrency', '4', 4], ['PKP_HEAVY_QUEUE', 'heavyQueue', '0', 0],
  ])('%s sets %s from %s; empty is unset; a bad value names it', (name, field, given, expected) => {
    expect([readMode(HOSTED, { [name]: given }, MAIN_TS), readMode(HOSTED, { [name]: '' }, MAIN_TS)])
      .toMatchObject([H({ [field]: expected }), H({ [field]: HOSTED_DEFAULTS[field] })]);
    for (const bad of ['abc', '-1', '1.5', ' 2', '1e3']) expect(modeError(() => readMode(HOSTED, { [name]: bad }, MAIN_TS))).toContain(name);
  });

  type Refusal = [string[], Record<string, string>, string | null];
  // [argv, env, what the message holds (null: any)].
  it.each<Refusal>([
    ...['abc', '0', '65536', '-1', '1.5', ''].map((bad): Refusal => [['--port', bad], {}, '--port']),
    [[], { PKP_MODE: 'Hosted' }, 'PKP_MODE must be local or hosted, not "Hosted"'], [HOSTED, { PKP_MODE: 'prod' }, 'PKP_MODE'],
    [['--nope'], {}, null], [['--hosted', '--nope'], {}, null], [['extra'], {}, null], [['--port'], {}, null],
    [HOSTED, { PORT: 'abc' }, 'PORT must be a port number'], [HOSTED, { PORT: '70000' }, 'PORT'], [['--hosted', '--port', '0'], {}, '--port'],
    [HOSTED, { PKP_HOST: 'example.com' }, 'PKP_HOST'], [HOSTED, { PKP_LOG: 'verbose' }, 'PKP_LOG'],
    ...['localhost:5173', 'http://localhost:5173/path', 'ftp://example.com', 'not a url']
      .map((bad): Refusal => [HOSTED, { PKP_ALLOW_ORIGIN: bad }, 'PKP_ALLOW_ORIGIN']),
    // At least 1 where 0 would mean nothing runs; at most 16 proxies.
    ...['PKP_MAX_SESSIONS', 'PKP_SESSIONS_PER_IP', 'PKP_SESSION_IDLE_MIN', 'PKP_SESSION_MEMORY_MB', 'PKP_HEAVY_CONCURRENCY']
      .map((name): Refusal => [HOSTED, { [name]: '0' }, name]),
    [HOSTED, { PKP_TRUST_PROXY: '17' }, 'PKP_TRUST_PROXY'],
    ...['top', 'Full', 'none', ' off', 'likeliest,ranked']
      .flatMap((bad): Refusal[] => [[], HOSTED].map((argv): Refusal => [argv, { PKP_AI_ODDS: bad }, ODDS_ERROR(bad)])),
  ])('refuses argv %j with env %j (a variable in one line)', (argv, env, words) => {
    const message = modeError(() => readMode(argv, env, MAIN_TS));
    if (words !== null) expect(message).toContain(words);
    if (Object.keys(env).length > 0) expect(message).not.toContain('\n');
  });

  it('a bad PKP_AI_ODDS stops the server at start: code 1 and that one line on stderr, nothing on stdout', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
      cwd: path.resolve(import.meta.dirname, '../../..'), env: { ...process.env, PKP_AI_ODDS: 'percent', PKP_MODE: '' }, encoding: 'utf8', timeout: 60_000,
    });
    expect([run.status, run.stderr, run.stdout]).toEqual([1, `${ODDS_ERROR('percent')}\n`, '']);
  }, 60_000);
});

describe('staticDirFor and healthJson', () => {
  it.each([
    [{ PKP_STATIC: '/srv/web' }, MAIN_TS, '/srv/web'], [{ PKP_STATIC: 'public' }, MAIN_JS, path.resolve('public')],
    [{}, MAIN_TS, '/repo/dist/web'], [{ PKP_STATIC: '' }, MAIN_TS, '/repo/dist/web'], [{}, MAIN_JS, '/repo/dist/web'],
  ])('staticDirFor(%j, %s) is %s', (env, main, dir) => {
    expect(staticDirFor(env, main)).toBe(dir);
  });

  it('healthJson is ok, the mode, the version and the whole seconds of uptime', () => {
    vi.spyOn(process, 'uptime').mockReturnValue(12.9);
    expect([healthJson('hosted', '1.2.3'), healthJson('local', 'dev')])
      .toEqual([{ ok: true, mode: 'hosted', version: '1.2.3', uptimeSeconds: 12 }, { ok: true, mode: 'local', version: 'dev', uptimeSeconds: 12 }]);
  });
});
