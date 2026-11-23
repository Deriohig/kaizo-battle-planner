// deploy/remote.sh against a pretend server: a fake `ssh` runs the remote side in a temp folder standing for the
// server's home (so the real rsync copies through it), and fake `sudo`, `docker`, `curl` and `python3` log their calls.

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));

/** This month and last month in UTC, as DB-IP names its monthly files ("2026-11"). */
const now = new Date();
const THIS_MONTH = now.toISOString().slice(0, 7);
const LAST_MONTH = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
const dbip = (kind: 'city' | 'asn', month: string) => `https://download.db-ip.com/free/dbip-${kind}-lite-${month}.mmdb.gz`;
const fakeDb = (kind: 'city' | 'asn', month: string) => `fake mmdb from ${dbip(kind, month)} MaxMind.com\n`;
const HOST = 'ubuntu@203.0.113.7';

let root = '', home = '', bin = '', bundle = '', log = '';

function script(name: string, body: string): void {
  writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pkp-remote-'));
  home = path.join(root, 'server-home');
  bin = path.join(root, 'bin');
  bundle = path.join(root, 'bundle', 'pkp-data');
  log = path.join(root, 'calls.log');
  for (const dir of [home, bin, path.join(bundle, 'rom')]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(bundle, 'bundle.json'), '{}');
  writeFileSync(path.join(bundle, 'rom', 'romdata.json'), '{}');
  writeFileSync(path.join(root, 'key'), 'not a real key');
  // ssh [options] host command…: the command runs in the pretend server's home, the fakes first on PATH (rsync passes -l user).
  script('ssh', `while [ $# -gt 0 ]; do case $1 in -i|-o|-l|-p) shift 2 ;; -*) shift ;; *) break ;; esac; done; shift
cd "${home}" && HOME="${home}" PATH="${bin}:$PATH" exec bash -c "$*"`);
  // The server's iptables accepts everything, or with FAKE_BLOCKING=1 ends INPUT with a REJECT rule.
  script('sudo', `echo "sudo $*" >> "${log}"
if [ "$1" = iptables ] && [ "$2" = -S ]; then printf -- '-P INPUT ACCEPT\\n'; [ "\${FAKE_BLOCKING:-}" = 1 ] && printf -- '-A INPUT -j REJECT --reject-with icmp-host-prohibited\\n'; exit 0; fi
if [ "$1" = iptables ] && [ "$2" = -C ]; then exit 1; fi
if [ "$1" = iptables ] && [ "$2" = -L ]; then printf 'num target prot opt source destination\\n5 ACCEPT tcp -- 0.0.0.0/0 0.0.0.0/0\\n6 REJECT all -- 0.0.0.0/0 0.0.0.0/0\\n'; fi
exit 0`);
  script('docker', `echo "docker $*" >> "${log}"`);
  script('netfilter-persistent', 'exit 0');
  // DB-IP has this month's and last month's files (FAKE_DBIP_MONTHS changes that), each a gzip of the MaxMind marker and
  // its URL, or with FAKE_DBIP_BAD=1 an HTML page. Every other URL answers 200.
  script('curl', `echo "curl $*" >> "${log}"
out=''; url=''; prev=''
for a in "$@"; do [ "$prev" = -o ] && out=$a; case $a in https://*) url=$a ;; esac; prev=$a; done
case $url in
  https://download.db-ip.com/free/*)
    month=\${url##*-lite-}; month=\${month%.mmdb.gz}
    case " \${FAKE_DBIP_MONTHS-${THIS_MONTH} ${LAST_MONTH}} " in *" $month "*) ;; *) exit 22 ;; esac
    if [ "\${FAKE_DBIP_BAD:-}" = 1 ]; then printf '<html>Not here</html>\\n' | gzip > "$out"
    else printf 'fake mmdb from %s MaxMind.com\\n' "$url" | gzip > "$out"; fi ;;
esac
exit 0`);
  // The server's python3 has maxminddb, or with FAKE_NO_MAXMINDDB=1 not yet.
  script('python3', `echo "python3 $*" >> "${log}"; [ "\${FAKE_NO_MAXMINDDB:-}" = 1 ] && exit 1; exit 0`);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Runs deploy/remote.sh with `args`, the call log emptied first. */
async function deploy(args: string[], env: Record<string, string> = {}) {
  rmSync(log, { force: true });
  return run('bash', ['deploy/remote.sh', ...args], {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PKP_DEPLOY_KEY: path.join(root, 'key'), PKP_BUNDLE_DIR: bundle, PKP_PASSWORD: '', ...env },
  });
}

const envFile = () => path.join(home, 'pkp', 'deploy', '.env');
const env = () => readFileSync(envFile(), 'utf8');
const geo = (file = '') => path.join(home, 'pkp', 'geo', file);
const geoText = (file: string) => readFileSync(geo(file), 'utf8');
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
const downloads = () => calls().split('\n').filter((l) => l.startsWith('curl ') && l.includes('download.db-ip.com'));
/** Makes a file look `days` old. */
const age = (file: string, days: number) => {
  const t = Date.now() / 1000 - days * 86_400;
  utimesSync(file, t, t);
};

describe('deploy/remote.sh', () => {
  it('copies the build inputs and the bundle, never data, tests, saves or a local .env; writes .env; starts compose', async () => {
    const { stdout } = await deploy([HOST], { PKP_PASSWORD: 'p w$x #1' });
    const pkp = path.join(home, 'pkp');
    for (const file of ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.server.json', 'vite.config.ts', 'src/server/main.ts', 'web/index.html', 'deploy/docker-compose.yml', 'deploy/Caddyfile', 'deploy/pkp-data/bundle.json', 'deploy/pkp-data/rom/romdata.json']) {
      expect(existsSync(path.join(pkp, file)), file).toBe(true);
    }
    for (const file of ['data', 'test', 'node_modules', '.git', 'dist', 'scripts', 'docs']) expect(existsSync(path.join(pkp, file)), file).toBe(false);
    expect(env()).toMatch(/^PKP_DOMAIN=203-0-113-7\.sslip\.io\nPKP_PASSWORD='p w\$x #1'\nPKP_VERSION=[0-9a-f]+(-dirty)?\n$/);
    expect(statSync(envFile()).mode & 0o777).toBe(0o600);
    // An open firewall is left alone; the password never reaches a command line.
    expect(calls()).not.toMatch(/iptables -[IA] |netfilter-persistent|iptables-persistent|p w\$x/);
    for (const call of [/docker compose up -d --build --remove-orphans/, /docker compose restart planner/, /curl -fsS --max-time 5 https:\/\/203-0-113-7\.sslip\.io\/api\/health/]) {
      expect(calls()).toMatch(call);
    }
    expect(stdout).toContain('Up: https://203-0-113-7.sslip.io/');
  });

  it("opens 80 and 443 before the REJECT rule when the server's own iptables blocks them, and saves the rules", async () => {
    await deploy([HOST], { PKP_PASSWORD: 'x', FAKE_BLOCKING: '1' });
    for (const rule of ['tcp --dport 80 -m state --state NEW -j ACCEPT', 'tcp --dport 443 -m state --state NEW -j ACCEPT', 'udp --dport 443 ']) {
      expect(calls()).toContain(`sudo iptables -I INPUT 6 -p ${rule}`);
    }
    expect(calls()).toMatch(/sudo netfilter-persistent save/);
  });

  it('writes any password into .env as written, then keeps it and a setting added by hand when none is given, takes a new domain, and keeps .env out of --delete', async () => {
    for (const password of ['a\\b', 'ünï cødé', 'say "hi"', 'back`tick', '#lead', 'a=b', '$(touch pwned)']) {
      await deploy([HOST], { PKP_PASSWORD: password });
      expect(env().split('\n')[1]).toBe(`PKP_PASSWORD='${password}'`);
    }
    expect(existsSync(path.join(home, 'pwned'))).toBe(false);
    writeFileSync(envFile(), `${env()}PKP_SESSION_IDLE_MIN=30\n# a note\n`);
    writeFileSync(path.join(bundle, 'new.json'), '{}');
    await deploy([HOST, 'planner.example.com']);
    expect(env()).toMatch(/^PKP_DOMAIN=planner\.example\.com\nPKP_PASSWORD='\$\(touch pwned\)'\nPKP_VERSION=.*\nPKP_SESSION_IDLE_MIN=30\n# a note\n$/);
    expect(existsSync(path.join(home, 'pkp', 'deploy', 'pkp-data', 'new.json'))).toBe(true);
    rmSync(path.join(bundle, 'new.json'));
    await deploy([HOST], { PKP_PASSWORD: 'second' });
    expect(env()).toMatch(/^PKP_DOMAIN=203-0-113-7\.sslip\.io\nPKP_PASSWORD='second'\n/);
    expect(existsSync(path.join(home, 'pkp', 'deploy', 'pkp-data', 'new.json'))).toBe(false);
  });

  it('refuses a first run without a password, a bad password, no bundle, and no user@host, writing nothing', async () => {
    for (const [args, vars, refusal] of [
      [[HOST], {}, { stderr: expect.stringContaining('No password set yet') }],
      [[HOST], { PKP_PASSWORD: "it's" }, { code: 2 }],
      [[HOST], { PKP_PASSWORD: 'ends in \\' }, { code: 2, stderr: expect.stringContaining('end in a backslash') }],
      [['203.0.113.7'], { PKP_PASSWORD: 'x' }, { code: 2 }],
    ] as [string[], Record<string, string>, object][]) {
      await expect(deploy(args, vars)).rejects.toMatchObject(refusal);
    }
    rmSync(path.join(bundle, 'bundle.json'));
    await expect(deploy([HOST], { PKP_PASSWORD: 'x' })).rejects.toMatchObject({ stderr: expect.stringContaining('npm run bundle') });
    expect(existsSync(envFile())).toBe(false);
  });

  it('a second run changes only what it must: maxminddb, Caddy and the planner only when needed, no fresh download', async () => {
    await deploy([HOST], { PKP_PASSWORD: 'x', FAKE_NO_MAXMINDDB: '1' });
    expect(calls()).toMatch(/python3 -c import maxminddb/);
    expect(calls()).toMatch(/^sudo env DEBIAN_FRONTEND=noninteractive apt-get .* install -y -qq python3-maxminddb$/m);
    expect(calls()).toMatch(/docker compose up -d --force-recreate --no-deps caddy/);
    await deploy([HOST]);
    expect(calls()).not.toMatch(/apt-get|--force-recreate|restart planner/);
    expect(downloads()).toEqual([]);
    writeFileSync(path.join(bundle, 'bundle.json'), '{"createdAt":"later"}');
    writeFileSync(path.join(home, 'pkp', '.state', 'caddyfile.sha256'), 'an older Caddyfile\n');
    await deploy([HOST]);
    expect(calls()).toMatch(/docker compose restart planner/);
    expect(calls()).toMatch(/--force-recreate --no-deps caddy/);
  });

  it("keeps DB-IP's City and ASN Lite of this month in ~/pkp/geo/, unpacked, with a SOURCE naming them, the date and the licence", async () => {
    await deploy([HOST], { PKP_PASSWORD: 'x' });
    const today = new Date().toISOString().slice(0, 10);
    for (const kind of ['city', 'asn'] as const) {
      expect(geoText(`dbip-${kind}-lite.mmdb`)).toBe(fakeDb(kind, THIS_MONTH));
      expect(geoText('SOURCE')).toContain(`dbip-${kind}-lite.mmdb from ${dbip(kind, THIS_MONTH)}, downloaded ${today}\n`);
    }
    for (const credit of ['DB-IP (https://db-ip.com)', 'CC BY 4.0']) expect(geoText('SOURCE')).toContain(credit);
    expect(readdirSync(geo()).sort()).toEqual(['SOURCE', 'dbip-asn-lite.mmdb', 'dbip-city-lite.mmdb']);
  });

  it("falls back to last month's files, and downloads one again only when it is missing or over 40 days old, keeping the other's SOURCE line", async () => {
    await deploy([HOST], { PKP_PASSWORD: 'x', FAKE_DBIP_MONTHS: LAST_MONTH });
    expect([geoText('dbip-city-lite.mmdb'), geoText('dbip-asn-lite.mmdb')]).toEqual([fakeDb('city', LAST_MONTH), fakeDb('asn', LAST_MONTH)]);
    age(geo('dbip-city-lite.mmdb'), 41);
    age(geo('dbip-asn-lite.mmdb'), 39);
    await deploy([HOST]);
    expect(downloads()).toHaveLength(1);
    expect([geoText('dbip-city-lite.mmdb'), geoText('dbip-asn-lite.mmdb')]).toEqual([fakeDb('city', THIS_MONTH), fakeDb('asn', LAST_MONTH)]);
    for (const [kind, month] of [['city', THIS_MONTH], ['asn', LAST_MONTH]] as const) expect(geoText('SOURCE')).toContain(`dbip-${kind}-lite.mmdb from ${dbip(kind, month)}, `);
    expect(geoText('SOURCE').match(/^dbip-city-lite\.mmdb /gm)).toHaveLength(1);
    rmSync(geo('dbip-asn-lite.mmdb'));
    await deploy([HOST]);
    expect(downloads()).toEqual([`curl -fsSL --retry 2 --connect-timeout 20 --max-time 900 -o ${geo('dbip-asn-lite.mmdb.gz.part')} ${dbip('asn', THIS_MONTH)}`]);
  });

  it('a failed download is a warning and the deploy goes on; a file already there stays, and a page that is not a database is never kept', async () => {
    const first = await deploy([HOST], { PKP_PASSWORD: 'x', FAKE_DBIP_MONTHS: '' });
    expect(first.stdout).toContain('Up: https://203-0-113-7.sslip.io/');
    expect(first.stderr).toContain(`warning: could not download DB-IP's dbip-city-lite for ${THIS_MONTH} or ${LAST_MONTH}`);
    expect(first.stderr).toContain("warning: could not download DB-IP's dbip-asn-lite ");
    expect(existsSync(geo('dbip-city-lite.mmdb')) || existsSync(geo('SOURCE'))).toBe(false);

    await deploy([HOST]);
    age(geo('dbip-city-lite.mmdb'), 50);
    const kept = await deploy([HOST], { FAKE_DBIP_BAD: '1' });
    expect(kept.stdout).toContain('Up: https://203-0-113-7.sslip.io/');
    expect(kept.stderr).toMatch(/warning: could not download DB-IP's dbip-city-lite .*; keeping the one there/);
    expect(geoText('dbip-city-lite.mmdb')).toBe(fakeDb('city', THIS_MONTH));
    expect(readdirSync(geo()).sort()).toEqual(['SOURCE', 'dbip-asn-lite.mmdb', 'dbip-city-lite.mmdb']);
  });

  it('prints its plan and runs nothing on a dry run', async () => {
    const { stdout } = await deploy([HOST], { PKP_REMOTE_DRY_RUN: '1' });
    expect(stdout).toMatch(/as https:\/\/203-0-113-7\.sslip\.io\//);
    // A deploy/.env on this PC is never sent; the server's own is protected from --delete.
    for (const line of ['--exclude=/deploy/.env', '--filter=P /deploy/.env', 'geo: DB-IP IP to City Lite and IP to ASN Lite into ~/pkp/geo/ when missing or over 40 days old']) {
      expect(stdout).toContain(line);
    }
    expect(existsSync(log)).toBe(false);
  });
});
