// deploy/usage.sh against a pretend server: a fake `ssh` runs the remote side here, with fake `sudo`, `journalctl` and
// `docker` that log their calls and print fake request lines; python3 is the real one, and a stand-in `maxminddb` module
// (on PYTHONPATH) reads the pretend server's ~/pkp/geo/ databases as JSON.

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const HOST = 'root@203.0.113.7';
const SINCE = ['--since', '2026-11-01'];

let root = '', home = '', bin = '', log = '', py = '';

function script(name: string, body: string): void {
  writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pkp-usage-'));
  [home, bin, log, py] = ['server-home', 'bin', 'calls.log', 'py'].map((name) => path.join(root, name)) as [string, string, string, string];
  for (const dir of [home, bin, py]) mkdirSync(dir, { recursive: true });
  // python3-maxminddb's open_database(path).get(address), for a "database" that is a JSON object of address to record.
  writeFileSync(path.join(py, 'maxminddb.py'), 'import json\nclass Reader:\n    def __init__(self, path):\n        with open(path, encoding="utf-8") as f:\n'
    + '            self.records = json.load(f)\n    def get(self, address):\n        return self.records.get(str(address))\n'
    + '    def close(self):\n        pass\ndef open_database(path, mode=0):\n    return Reader(path)\n');
  // Never to be called: the report reads, it never fetches or installs.
  for (const name of ['curl', 'wget', 'apt-get']) script(name, `echo "${name} $*" >> "${log}"; exit 1`);
  writeFileSync(path.join(root, 'key'), 'not a real key');
  // ssh [options] host command…: the command runs in the pretend server's home, with the fakes first on PATH.
  script('ssh', `echo "ssh $*" >> "${log}"
while [ $# -gt 0 ]; do case $1 in -i|-o|-l|-p) shift 2 ;; -*) shift ;; *) break ;; esac; done; shift
cd "${home}" && HOME="${home}" PATH="${bin}:$PATH" exec bash -c "$*"`);
  script('sudo', `[ "$1" = -n ] && shift; echo "sudo $*" >> "${log}"; exec "$@"`);
  script('journalctl', `echo "journalctl $*" >> "${log}"; [ -f "${root}/journal.txt" ] && cat "${root}/journal.txt"; exit 0`);
  script('docker', `echo "docker $*" >> "${log}"
case $1 in
  ps) [ -f "${root}/container" ] && cat "${root}/container" ;;
  inspect) cat "${root}/driver" ;;
  logs) [ -f "${root}/docker.txt" ] && cat "${root}/docker.txt"; echo 'Plat Kaizo Planner (hosted, version abc1234) on http://0.0.0.0:8080' >&2 ;;
esac
exit 0`);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Runs deploy/usage.sh in New York time: the report is in Madrid time whatever TZ says. The call log is emptied first. */
async function usage(args: string[], env: Record<string, string> = {}) {
  rmSync(log, { force: true });
  return run('bash', ['deploy/usage.sh', ...args], {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PKP_DEPLOY_KEY: path.join(root, 'key'), TZ: 'America/New_York', ...env },
  });
}

interface Line {
  t: string; ip: string; m?: string; p: string; s: number; sess?: string | null; user?: string | null; code?: string | null;
  // The usage fields, written only when given, so lines without them are lines from before them.
  ua?: string | null; lang?: string | null; src?: string | null; fmt?: string | null; run?: unknown; fight?: string | null; turns?: number | null;
}
const USAGE_KEYS = ['ua', 'lang', 'src', 'fmt', 'run', 'fight', 'turns'] as const;
const line = (l: Line): string => JSON.stringify({
  t: l.t, ip: l.ip, m: l.m ?? 'GET', p: l.p, s: l.s, ms: 3, in: 0, sess: l.sess ?? null, user: l.user ?? null, code: l.code ?? null,
  ...Object.fromEntries(USAGE_KEYS.filter((key) => l[key] !== undefined).map((key) => [key, l[key]])),
});
const text = (lines: Line[], extra: string[] = []): string => `${[...extra, ...lines.map(line)].join('\n')}\n`;
/** A request at `t` ('20T13:02:05' is 20 November, UTC), `route` 'METHOD /path' or a path it GETs. */
const req = (t: string, ip: string, route: string, s = 200, more: Partial<Line> = {}): Line => {
  const [m, p] = route.includes(' ') ? route.split(' ') : ['GET', route];
  return { t: `2026-11-${t}.000Z`, ip, m, p: p!, s, ...more };
};

const ANA = '203.0.113.0/24';
const BEA = '198.51.100.0/24';
/** Ana: two visits on Friday 20 November (CET, UTC+1), her page opens carrying no session. */
const ana = ([
  ['13:02:00', '/api/config', 200, { sess: null }], ['13:02:05', 'PUT /api/save'], ['13:03:00', 'POST /api/plan/step'], ['13:05:00', 'POST /api/plan/step'],
  ['13:10:00', 'POST /api/sheet'], ['13:11:00', 'POST /api/sheet/ai/stream'], ['13:30:00', '/api/box', 409, { code: 'NO_SAVE' }],
  ['13:40:00', 'POST /api/plan/step', 422, { code: 'AI_UNDEFINED' }], ['18:30:00', '/api/config', 200, { sess: null }], ['18:30:02', '/api/box'],
  ['18:45:00', 'POST /api/plan/step'],
] as [string, string, number?, Partial<Line>?][]).map(([t, route, s, more]) => req(`20T${t}`, ANA, route, s, { sess: 'a41f9c', user: 'Ana', ...more }));
/** No name typed; one visit across midnight, Saturday into Sunday. */
const bea = [req('21T22:50:00', BEA, '/api/config'), ...[['21T22:50:03', 'PUT /api/save'], ['21T23:05:00', 'POST /api/plan/step'], ['21T23:20:00', 'POST /api/plan/step']]
  .map(([t, route]) => req(t!, BEA, route!, 200, { sess: 'b7e2d0' }))];
/** Opened the page and loaded no save: no session at all. */
const carmen = [req('21T09:00:00', '192.0.2.0/24', '/api/config', 200, { user: 'Carmen' }), req('21T09:00:20', '192.0.2.0/24', '/api/trainers', 200, { user: 'Carmen' })];
/** The password's refusals: the browser's first ask from Ana's /24, and three scanners' /24s. */
const refused = [
  req('20T13:01:58', ANA, '/', 401), ...['/', '/js/lkk_ch.js', '/licensor.js'].map((p) => req('21T14:47:43', '146.70.134.0/24', p, 401)),
  req('21T13:50:39', '16.145.223.0/24', '/', 401), req('21T14:26:21', '44.255.207.0/24', '/', 401),
];
const noise = [req('21T15:00:00', '100.64.1.0/24', '/api/nope', 404)];
/** Before the --since: never in the report. */
const old: Line[] = [{ t: '2026-10-01T10:00:00.000Z', ip: ANA, p: '/api/config', s: 200, sess: 'old000', user: 'Old' }];
const notRequests = [
  'Plat Kaizo Planner (hosted, version abc1234) on http://0.0.0.0:8080', '{not json',
  JSON.stringify({ t: '2026-11-20T13:20:00.000Z', level: 'error', ref: '1a2b3c4d', what: 'POST /api/sheet', class: 'TypeError', frames: [] }),
];
/** 2026-11-01 00:00 in Madrid (CET), as the epoch seconds the server is asked from. */
const NOV_1 = Date.UTC(2026, 9, 31, 23, 0, 0) / 1000;
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
/** Every call after the ssh is a read of the journal or of docker. */
const readsOnly = () => calls().trim().split('\n').slice(1).every((call) => /^(sudo )?(journalctl -t pkp-planner |docker (ps|inspect|logs) )/.test(call));
const sinceAsked = () => Number(/journalctl -t pkp-planner --since @(\d+)/.exec(calls())![1]);

/**
 * Visitors for the location report: d1d1d1 in Zaragoza, then once from Madrid on mobile data; Eva on the same provider in
 * the same city; Madrid over IPv6; a private /24 the databases hold a record for (never looked up); a public /24 they do
 * not know; and one only the ASN database knows.
 */
const MAD6 = '2a01:4f8:ab00::/48';
const located = [
  req('20T10:00:00', '62.40.120.0/24', '/api/config'), req('20T10:00:04', '62.40.120.0/24', 'PUT /api/save', 200, { sess: 'd1d1d1' }),
  req('20T10:10:00', '62.40.120.0/24', 'POST /api/plan/step', 200, { sess: 'd1d1d1' }), req('20T10:20:00', MAD6, 'POST /api/plan/step', 200, { sess: 'd1d1d1' }),
  req('20T11:00:00', '62.40.121.0/24', 'PUT /api/save', 200, { sess: 'e2e2e2', user: 'Eva' }),
  ...[['12', MAD6, 'f3f3f3'], ['13', '10.1.2.0/24', 'a0a0a0'], ['14', '81.0.0.0/24', 'b0b0b0'], ['15', '88.1.2.0/24', 'c0c0c0']]
    .map(([hour, ip, sess]) => req(`20T${hour}:00:00`, ip!, 'PUT /api/save', 200, { sess })),
];
const city = (name: string) => ({
  city: { names: { en: name, es: name } }, continent: { code: 'EU', names: { en: 'Europe' } },
  country: { iso_code: 'ES', names: { en: name === 'Nowhere' ? 'Private' : 'Spain', es: 'España' } }, location: { latitude: 41.65, longitude: -0.88 },
});
const asn = (org: string) => ({ autonomous_system_number: 3352, autonomous_system_organization: org });

/** DB-IP's two databases in the pretend server's ~/pkp/geo/, keyed by the network address the report looks up. */
function geo(which: { city?: boolean; asn?: boolean } = { city: true, asn: true }): void {
  const dir = path.join(home, 'pkp', 'geo');
  mkdirSync(dir, { recursive: true });
  const telefonica = asn('Telefonica de Espana');
  if (which.city) {
    writeFileSync(path.join(dir, 'dbip-city-lite.mmdb'), JSON.stringify({
      '62.40.120.0': city('Zaragoza'), '62.40.121.0': city('Zaragoza'), '2a01:4f8:ab00::': city('Madrid'), '10.1.2.0': city('Nowhere') }));
  }
  if (which.asn) {
    writeFileSync(path.join(dir, 'dbip-asn-lite.mmdb'), JSON.stringify({ '62.40.120.0': telefonica, '62.40.121.0': telefonica,
      '2a01:4f8:ab00::': asn('Digi Spain Telecom'), '10.1.2.0': asn('Private'), '88.1.2.0': asn('Vodafone Spain') }));
  }
}

/** A visitor whose lines carry the usage fields: two devices, three saves taken and one refused, and the fights planned. */
const FIA = '192.0.2.0/24';
const CHROME = 'Chrome 142 · Windows · desktop';
const IPHONE = 'Safari 18 · iPhone · phone';
const ROARK = 'roark-split/leader-roark/1';
const MARS = 'galactic-split/commander-mars/1';
const fiaReq = (t: string, route: string, more: Partial<Line>) => req(`21T10:${t}`, FIA, route, 200, { sess: 'f1a000', ua: CHROME, lang: 'es-ES', ...more });
const step = (t: string, fight: string | null, s = 200) => fiaReq(t, 'POST /api/plan/step', { fight, turns: null, s });
const sheet = (t: string, fight: string, route = 'POST /api/sheet') => fiaReq(t, route, { fight, turns: null });
const save = (t: string, s: number, src: string, fmt: string, run: unknown, phone = false) =>
  fiaReq(t, 'PUT /api/save', { s, src, fmt, run, fight: null, ...(phone ? { ua: IPHONE, lang: 'en-GB' } : {}), ...(s === 200 ? {} : { code: 'BAD_SAVE' }) });
const fia: Line[] = [
  fiaReq('00:00', '/api/config', { sess: null, ua: IPHONE, lang: 'en-GB' }),
  save('00:05', 200, 'upload', 'DeSmuME .dsv', { badges: 1, split: 'Roark Split', cap: 20 }, true), save('01:00', 422, 'drop', 'other', null, true),
  step('02:00', ROARK), step('03:00', ROARK), step('04:00', ROARK), step('05:00', ROARK, 422), sheet('06:00', ROARK), sheet('07:00', ROARK),
  sheet('08:00', MARS, 'POST /api/sheet/ai/stream'), sheet('09:00', 'galactic-split/galactic-grunt/1'), sheet('10:00', 'gardenia-split/galactic-grunt/1'),
  sheet('11:00', 'roark-split/youngster-tristan/2'), step('12:00', 'wake-split/swimmer-ana/1'), step('13:00', null),
  save('20:00', 200, 'connected', 'raw .sav', { badges: 2, split: 'Gardenia Split', cap: 28 }),
  save('25:00', 200, 'resend', 'DeSmuME .dsv', { badges: 2, split: 'Gardenia Split', cap: 28 }),
  fiaReq('26:00', '/api/box', { ua: null, lang: null }),
];
/** A visitor who planned ten fights, none in the bundle: the first eight by raw ID, then how many more. */
const many = Array.from({ length: 10 }, (_, i) => req(`21T12:${10 + i}:00`, BEA, 'POST /api/plan/step', 200,
  { sess: 'c0ffee', fight: `volkner-split/trainer-${i + 1}/1`, ...(i === 0 ? { ua: 'script' } : {}) }));

/** The data bundle's split tabs on the pretend server, which the trainer names come from. */
function bundle(): void {
  const dir = path.join(home, 'pkp', 'deploy', 'pkp-data', 'docs');
  mkdirSync(dir, { recursive: true });
  const tab = (rows: string[]) => `${rows.map((cell) => `,,,,${cell},,,,,,,,,,,,`).join('\n')}\n`;
  writeFileSync(path.join(dir, 'Roark Split.csv'), tab(['  PLATINUM KAIZO - ROARK SPLIT', 'AI Flag Key:', 'Oreburgh Gym (GYM TRAINERS ARE A GAUNTLET)', 'Youngster Tristan', 'Lv 5 Starly ♂', 'YOUNGSTER TRISTAN (Gauntlet Start)', '"Leader Roark (SUPERBOSS)*"']));
  writeFileSync(path.join(dir, 'Galactic Split.csv'), `﻿${tab(['Valley Windworks', 'Commander Mars (DOUBLE)', 'Galactic Grunt'])}`);
  writeFileSync(path.join(dir, 'Gardenia Split.csv'), tab(['Eterna City', 'Galactic Grunt']));
  writeFileSync(path.join(dir, 'Moves.csv'), 'Name,Power\nTackle,40\n');
}

/** The pretend server's journal, docker logs, and the container's log driver. */
function server(opts: { journal?: string; docker?: string; driver?: string }): void {
  if (opts.driver !== undefined) writeFileSync(path.join(root, 'container'), 'cid123\n');
  for (const [file, content] of [['journal.txt', opts.journal], ['docker.txt', opts.docker], ['driver', opts.driver && `${opts.driver}\n`]]) {
    if (content !== undefined) writeFileSync(path.join(root, file!), content);
  }
}

describe('deploy/usage.sh: labels and automated checks', () => {
  /** Sam's phone (a labelled session), a deploy check (curl, no session) and one other person. */
  const lines = [
    req('21T19:06:53', '62.40.123.0/24', 'PUT /api/save', 200, { sess: '9a7b3c' }), req('21T19:06:54', '62.40.123.0/24', 'POST /api/plan/step', 200, { sess: '9a7b3c' }),
    req('22T00:45:26', '62.40.96.0/24', 'PUT /api/save', 200, { sess: '9a7b3c' }),
    req('22T00:56:10', '187.40.38.0/24', '/api/config', 200, { ua: 'script' }), req('22T01:15:40', '187.40.38.0/24', '/api/config', 200, { ua: 'script' }),
    req('21T23:11:12', '37.187.5.0/24', 'PUT /api/save', 200, { sess: '1167d9', ua: CHROME }),
  ];

  it.each<[string, string | null, string[], (string | RegExp)[], (string | RegExp)[]]>([
    ['leaves labelled visitors and automated checks out, and counts them at the end', '9a7b3c Sam\nnot a label line; rm -rf /\n', [],
      ['session 1167d9', /^Left out, Sam: 2 visits, last Sun 22 Nov 01:45 \(--all shows them\)\.$/m, /^Left out, automated checks: 2 requests \(--all shows them\)\.$/m],
      ['session 9a7b3c', '187.40.38.0/24']],
    ['--all shows them, the labelled one by its label', '9a7b3c Sam\n', ['--all'], [/^Sam \(session 9a7b3c\)$/m, '187.40.38.0/24'], ['Left out']],
    ['without a labels file, only the automated checks are left out', null, [], ['session 9a7b3c', /^Left out, automated checks: 2 requests/m], ['Left out, Sam']],
  ])('%s', async (_, labels, args, shown, hidden) => {
    server({ journal: text(lines) });
    if (labels !== null) writeFileSync(path.join(root, 'labels'), labels);
    const { stdout } = await usage([HOST, ...SINCE, ...args], { PKP_VISITOR_LABELS: path.join(root, 'labels') });
    for (const s of shown) expect(stdout).toMatch(s);
    for (const s of hidden) expect(stdout).not.toMatch(s);
    expect(calls()).not.toContain('rm -rf');
  });
});

describe('deploy/usage.sh', () => {
  // The same requests from the journal alone, or for a container that does not log there, its `docker logs` added.
  it.each([
    ['journald', 'Read 24 request lines from the journal.\n', { journal: text([...old, ...refused, ...ana, ...carmen, ...noise, ...bea], notRequests) }],
    ['json-file', 'Read 24 request lines: 5 from the journal, 19 from docker logs of the current container.\n',
      { journal: text(refused.slice(1)), docker: text([...old, refused[0]!, ...ana, ...carmen, ...noise, ...bea], notRequests) }],
  ])("with a %s container, prints one block per visitor in order of first seen, in Madrid time, then the password's refusals", async (driver, read, logs) => {
    server({ ...logs, driver });
    const { stdout } = await usage([HOST, ...SINCE]);
    expect(stdout).toContain('Plat Kaizo planner visitors since Sun 1 Nov 00:00 (Europe/Madrid time)\n');
    expect(stdout).toContain(read);
    const at = [
      ['Ana (session a41f9c)', '  IP /24      203.0.113.0/24', '  first seen  Fri 20 Nov 14:02', '  last seen   Fri 20 Nov 19:45',
        '  visits      Fri 20 Nov 14:02 to 14:40 (38 min, 8 requests)', '              Fri 20 Nov 19:30 to 19:45 (15 min, 3 requests)',
        '  did         page opens 2, save uploads 1, plan steps 3, Matchups sheets 1, AI streams 1'],
      ['Carmen (no session)', '  IP /24      192.0.2.0/24', '  first seen  Sat 21 Nov 10:00', '  last seen   Sat 21 Nov 10:00',
        '  visits      Sat 21 Nov 10:00 (2 requests)', '  did         page opens 1, save uploads 0, plan steps 0, Matchups sheets 0, AI streams 0'],
      ['no name given (session b7e2d0)', '  IP /24      198.51.100.0/24', '  first seen  Sat 21 Nov 23:50', '  last seen   Sun 22 Nov 00:20',
        '  visits      Sat 21 Nov 23:50 to Sun 22 Nov 00:20 (30 min, 4 requests)', '  did         page opens 1, save uploads 1, plan steps 2, Matchups sheets 0, AI streams 0'],
    ].map((block) => stdout.indexOf(block.join('\n')));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(stdout).not.toMatch(/old000|Old/);
    expect(stdout).toContain('Blocked by the password: 6 requests from 4 /24s (1 of those /24s also had a visitor: the browser asks once before it sends the password).\n');
    expect(stdout).toContain('Other requests without a session: 1 from 1 /24.\n');
    // Both from the cutoff; docker logs only for a container that does not log to the journal, saying so.
    expect(calls()).toMatch(new RegExp(`^journalctl -t pkp-planner --since @${NOV_1} `, 'm'));
    const docker = driver === 'json-file';
    expect(new RegExp(`^docker logs --since ${NOV_1} cid123$`, 'm').test(calls())).toBe(docker);
    expect(stdout.includes('The planner container does not log to the journal (json-file)')).toBe(docker);
  });

  it("groups visitors under their /24's city and provider from DB-IP's databases (either one), else prints today's report", async () => {
    server({ journal: text([...located, ...refused.slice(1)]), driver: 'journald' });
    const bare = (await usage([HOST, ...SINCE], { PYTHONPATH: py })).stdout;
    expect(bare).toContain('no name given (session d1d1d1)\n  IP /24      62.40.120.0/24, 2a01:4f8:ab00::/48\n  first seen  Fri 20 Nov 11:00\n');
    expect(bare).toContain('\n\nEva (session e2e2e2)\n  IP /24      62.40.121.0/24\n');
    expect(bare).not.toMatch(/DB-IP|Zaragoza/);
    geo({ city: true });
    const cityOnly = (await usage([HOST, ...SINCE], { PYTHONPATH: py })).stdout;
    expect(cityOnly).toContain('Zaragoza, Spain\n  session d1d1d1\n    IP /24      62.40.120.0/24, 2a01:4f8:ab00::/48 (Madrid, Spain)\n');
    expect(cityOnly).toContain('IP locations by DB-IP (db-ip.com), CC BY 4.0.\n');
    // Both databases there, but python3 cannot import maxminddb (no PYTHONPATH): the same report as without them.
    geo();
    expect((await usage([HOST, ...SINCE])).stdout).toBe(bare);

    const { stdout } = await usage([HOST, ...SINCE], { PYTHONPATH: py });
    expect(stdout).toContain(['Zaragoza, Spain · Telefonica de Espana', '  session d1d1d1',
      '    IP /24      62.40.120.0/24, 2a01:4f8:ab00::/48 (Madrid, Spain · Digi Spain Telecom)', '    first seen  Fri 20 Nov 11:00',
      '    last seen   Fri 20 Nov 11:20', '    visits      Fri 20 Nov 11:00 to 11:20 (20 min, 4 requests)',
      '    did         page opens 1, save uploads 1, plan steps 2, Matchups sheets 0, AI streams 0', '  Eva (session e2e2e2)', '    IP /24      62.40.121.0/24',
      '    first seen  Fri 20 Nov 12:00', '    last seen   Fri 20 Nov 12:00', '    visits      Fri 20 Nov 12:00 (1 request)',
      '    did         page opens 0, save uploads 1, plan steps 0, Matchups sheets 0, AI streams 0', '',
      'Madrid, Spain · Digi Spain Telecom', '  session f3f3f3', '    IP /24      2a01:4f8:ab00::/48', '    first seen  Fri 20 Nov 13:00'].join('\n'));
    // A private /24 and one the databases do not know: today's blocks. The provider alone when the city database has nothing.
    const blocks = ['\n\nno name given (session a0a0a0)\n  IP /24      10.1.2.0/24\n  first seen  Fri 20 Nov 14:00\n',
      '\n\nno name given (session b0b0b0)\n  IP /24      81.0.0.0/24\n', '\n\nVodafone Spain\n  session c0c0c0\n    IP /24      88.1.2.0/24\n'];
    for (const block of blocks) expect(stdout).toContain(block);
    const order = ['Zaragoza, Spain', 'Madrid, Spain · Digi Spain Telecom\n', ...blocks].map((s) => stdout.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(stdout).not.toContain('Nowhere');
    expect(stdout).toContain('Blocked by the password: 5 requests from 3 /24s.\n');
    expect(stdout.endsWith('\nIP locations by DB-IP (db-ip.com), CC BY 4.0.\n')).toBe(true);
    expect(readsOnly()).toBe(true);
  });

  it("shows each visitor's latest device and language, the saves by format and source, the latest run and the fights", async () => {
    server({ journal: text([...fia, ...many]), driver: 'journald' });
    // Without the bundle on the server, the trainers are named by their IDs as logged.
    expect((await usage([HOST, ...SINCE])).stdout)
      .toContain(`  fights      ${ROARK} (3 plan steps, Matchups ×2), ${MARS} (AI odds ×1), galactic-split/galactic-grunt/1 (Matchups ×1), `);
    bundle();
    const { stdout } = await usage([HOST, ...SINCE]);
    expect(stdout).toContain(['no name given (session f1a000)', '  IP /24      192.0.2.0/24', '  device      Chrome 142 · Windows · desktop',
      '  language    es-ES', '  first seen  Sat 21 Nov 11:00', '  last seen   Sat 21 Nov 11:26', '  visits      Sat 21 Nov 11:00 to 11:26 (26 min, 18 requests)',
      '  did         page opens 1, save uploads 3, plan steps 5, Matchups sheets 5, AI streams 1',
      '  save        DeSmuME .dsv, uploaded ×1, re-sent ×1; raw .sav, connected ×1', '  run         2 badges · Gardenia Split · cap 28',
      '  fights      Leader Roark (3 plan steps, Matchups ×2), Commander Mars (AI odds ×1), Galactic Grunt · Galactic Split (Matchups ×1), '
        + 'Galactic Grunt · Gardenia Split (Matchups ×1), 2nd YOUNGSTER TRISTAN (Matchups ×1), wake-split/swimmer-ana/1 (1 plan step)', ''].join('\n'));
    // Eight fights at most, most planned first; a trainer the bundle does not name by its ID.
    expect(stdout).toContain('no name given (session c0ffee)\n  IP /24      198.51.100.0/24\n  device      script\n  first seen  Sat 21 Nov 13:10\n');
    expect(stdout).toContain(`  fights      ${Array.from({ length: 8 }, (_, i) => `volkner-split/trainer-${i + 1}/1 (1 plan step)`).join(', ')}, and 2 more\n`);
    // Nothing the log never holds, nor a refused upload's format; the bundle is only read.
    expect(stdout).not.toMatch(/other ×|dropped|turns|null/);
    expect(readsOnly()).toBe(true);
  });

  it('reads only, through ssh with the deploy key, from 7 days back by default, or a --since of 3d or any time GNU date reads', async () => {
    await usage(['ubuntu@203.0.113.7']);
    expect(calls()).toMatch(new RegExp(`^ssh -i ${root}/key .*-o BatchMode=yes .*ubuntu@203\\.0\\.113\\.7 `));
    expect(readsOnly()).toBe(true);
    expect(Math.abs(sinceAsked() - (Date.now() / 1000 - 7 * 86_400))).toBeLessThan(120);
    await usage([HOST, '--since', '3d']);
    expect(Math.abs(sinceAsked() - (Date.now() / 1000 - 3 * 86_400))).toBeLessThan(120);
    const { stdout } = await usage([HOST, '--since=2026-11-20 18:00']);
    expect(sinceAsked()).toBe(Date.UTC(2026, 10, 20, 17, 0, 0) / 1000);
    // Nobody came.
    for (const said of ['No visitors since Fri 20 Nov 18:00.\n', 'Blocked by the password: none.\n']) expect(stdout).toContain(said);
  });

  it('refuses a missing or bare target, an unknown option, a --since that is not a time or is in the future, and no key', async () => {
    for (const [args, refusal, env] of [
      [[], { code: 2 }], [['203.0.113.7'], { code: 2 }], [[HOST, '--until', 'now'], { code: 2 }], [[HOST, '--since'], { code: 2 }],
      [[HOST, '--since', 'not a time'], { code: 2, stderr: expect.stringContaining('--since') }],
      [[HOST, '--since', 'tomorrow'], { code: 2, stderr: expect.stringContaining('future') }],
      [[HOST], { code: 1, stderr: expect.stringContaining('PKP_DEPLOY_KEY') }, { PKP_DEPLOY_KEY: path.join(root, 'none') }],
    ] as [string[], object, Record<string, string>?][]) {
      await expect(usage(args, env)).rejects.toMatchObject(refusal);
      expect(calls()).toBe('');
    }
  });
});
