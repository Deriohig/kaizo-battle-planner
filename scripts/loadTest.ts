// `npm run loadtest -- <base URL> [options]`: the hosted server under load. Each of
// `--players` (20) players uploads its own made-up save (scripts/makeSmokeSave.ts), then for `--seconds` (60) mixes plan
// steps, sheets and AI odds streams against random single battles, pausing about `--think` ms (500) between requests,
// while health is asked every 250 ms. It passes when: every answer is 200 but BUSY (under 1%), NO_SAVE (re-sent, as
// the page does) and a plan step's 422 AI_UNDEFINED (expected, counted apart), a RATE_LIMITED included; every player got
// its save in; plan step p95 under 2 s; health p99 under
// 500 ms; and the memory peak under 700 MB, measured with `--pid` (a local process) or `--container` (a Docker one);
// `--no-memory` skips that. `--idle-check <min>` then waits that long plus the one-minute sweep and passes when every
// player's session is gone (409 NO_SAVE); it prints the memory then, to compare with a second run's "before". Exits 1
// when any check fails.
//
// Every player sends its own `X-Forwarded-For` (198.51.100.<n>, a documentation range), so the per-IP limits and session
// caps see twenty players, as they would in production. Run it against the planner itself (not through Caddy), started
// with PKP_TRUST_PROXY=1; `--same-ip` sends none, so every player shares this machine's address and its limits.
//
// Options: --password <p>  --players <n>  --seconds <n>  --think <ms>  --pid <n> | --container <name>  --no-memory
//          --idle-check <min>  --same-ip  --insecure (accept a certificate Node cannot check)

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { SESSION_HEADER } from '../src/contracts/hosted.js';
import { smokeSave } from './makeSmokeSave.js';

const USAGE = 'Usage: npm run loadtest -- <base URL> [--password <p>] [--players <n>] [--seconds <n>] [--think <ms>] [--pid <n> | --container <name> | --no-memory] [--idle-check <min>] [--same-ip] [--insecure]';

type Op = 'plan' | 'sheet' | 'ai';
interface Sample { op: Op | 'upload' | 'health'; status: number; code: string | null; ms: number }

/** The p-th percentile (0–100) of `values`, nearest rank; NaN for none. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

/** What a run saw besides its samples: the memory peak, the players that never held a save, and the idle check's count. */
export interface RunFacts {
  /** The memory peak in MB, null when it was not measured. */
  peakMb: number | null;
  /** Whether a run without a memory measure fails (`--no-memory` turns it off). */
  memoryRequired: boolean;
  /** Players whose first upload was refused, so they sent nothing else. */
  playersWithoutSave: number;
  /** `--idle-check`: of the players' sessions, how many answered NO_SAVE after the idle time. */
  idle?: { gone: number; of: number };
}

/**
 * A plan step the trainer AI cannot answer: 422 AI_UNDEFINED, a documented answer (src/server/lines.ts `aiUndefined`) for
 * a state where the AI's behaviour is undefined. The random battles meet it now and then; it is not the server failing.
 */
const aiUndefined = (s: Sample) => s.op === 'plan' && s.status === 422 && s.code === 'AI_UNDEFINED';

/**
 * Whether a request's answer is a failure: anything but 200, BUSY (refused for load), NO_SAVE (re-sent, as the page does)
 * and a plan step's AI_UNDEFINED (expected).
 */
const failed = (s: Sample) => s.status !== 200 && s.code !== 'BUSY' && !(s.status === 409 && s.code === 'NO_SAVE') && !aiUndefined(s);
const label = (s: Sample) => `${s.op} ${s.status}${s.code === null ? '' : ` ${s.code}`}`;

/** The verdicts of a run, each a line and whether it passed. */
export function verdicts(samples: readonly Sample[], facts: RunFacts): { line: string; ok: boolean }[] {
  const work = samples.filter((s) => s.op !== 'health');
  const busy = work.filter((s) => s.code === 'BUSY').length;
  const failures = work.filter(failed);
  const plan = samples.filter((s) => s.op === 'plan' && s.status === 200).map((s) => s.ms);
  const health = samples.filter((s) => s.op === 'health').map((s) => s.ms);
  const healthFailed = samples.filter((s) => s.op === 'health' && s.status !== 200).length;
  const busyShare = work.length === 0 ? 0 : busy / work.length;
  // A dropped session is re-sent, but a server that keeps dropping them is failing: under 1% as BUSY is.
  const noSave = work.filter((s) => s.status === 409 && s.code === 'NO_SAVE').length;
  const noSaveShare = work.length === 0 ? 0 : noSave / work.length;
  const out = [
    { line: `requests: ${work.length}; failed other than BUSY and NO_SAVE: ${failures.length}${failures.length > 0 ? ` (${[...new Set(failures.map(label))].join(', ')})` : ''}`, ok: work.length > 0 && failures.length === 0 },
    { line: `players that never held a save: ${facts.playersWithoutSave}`, ok: facts.playersWithoutSave === 0 },
    { line: `BUSY: ${busy} (${(busyShare * 100).toFixed(2)}%, under 1% to pass)`, ok: busyShare < 0.01 },
    { line: `NO_SAVE (a dropped session, re-sent): ${noSave} (${(noSaveShare * 100).toFixed(2)}%, under 1% to pass)`, ok: noSaveShare < 0.01 },
    { line: `plan steps the AI cannot answer (422 AI_UNDEFINED, an expected answer): ${work.filter(aiUndefined).length}`, ok: true },
    { line: `plan step p95: ${percentile(plan, 95).toFixed(0)} ms over ${plan.length} (under 2000 to pass)`, ok: plan.length > 0 && percentile(plan, 95) < 2000 },
    { line: `health p99: ${percentile(health, 99).toFixed(0)} ms over ${health.length}, ${healthFailed} not 200 (under 500 and all 200 to pass)`, ok: health.length > 0 && percentile(health, 99) < 500 && healthFailed === 0 },
  ];
  out.push(facts.peakMb === null
    ? { line: `memory: not measured (pass --pid or --container${facts.memoryRequired ? ', or --no-memory to skip it' : ''})`, ok: !facts.memoryRequired }
    : { line: `memory peak: ${facts.peakMb.toFixed(0)} MB (under 700 to pass)`, ok: facts.peakMb < 700 });
  if (facts.idle !== undefined) {
    out.push({ line: `sessions gone after the idle time: ${facts.idle.gone} of ${facts.idle.of}`, ok: facts.idle.gone === facts.idle.of });
  }
  return out;
}

/** The resident memory in MB of a local process (`/proc/<pid>/status`) or a container (`docker stats`), else null. */
function memoryMb(target: { pid?: number; container?: string }): number | null {
  try {
    if (target.pid !== undefined) {
      const kb = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${target.pid}/status`, 'utf8'))?.[1];
      return kb === undefined ? null : Number(kb) / 1024;
    }
    if (target.container !== undefined) {
      const used = spawnSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', target.container], { encoding: 'utf8' }).stdout.split('/')[0]?.trim() ?? '';
      const match = /^([\d.]+)\s*([KMG]i?B)$/.exec(used);
      if (match === null) return null;
      const scale: Record<string, number> = { KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 };
      return Number(match[1]) * (scale[match[2]!] ?? Number.NaN);
    }
  } catch {
    return null;
  }
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const OPTIONS = {
  password: { type: 'string' }, players: { type: 'string' }, seconds: { type: 'string' }, think: { type: 'string' },
  pid: { type: 'string' }, container: { type: 'string' }, 'no-memory': { type: 'boolean' }, 'idle-check': { type: 'string' },
  'same-ip': { type: 'boolean' }, insecure: { type: 'boolean' },
} as const;

function usageExit(message: string): never {
  console.error(`${message}${message === '' ? '' : '. '}${USAGE}`);
  process.exit(2);
}

function readArgs() {
  try {
    return parseArgs({ allowPositionals: true, options: OPTIONS });
  } catch (error) {
    return usageExit(error instanceof Error ? error.message : String(error));
  }
}

/** `raw` as a whole number from `min`, else `fallback` when it is absent; anything else exits with the usage. */
function whole(name: string, raw: string | undefined, fallback: number, min = 1): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min) usageExit(`--${name} must be a whole number from ${min}`);
  return Number(raw);
}

async function main(): Promise<void> {
  const { values, positionals } = readArgs();
  const [baseArg, ...extra] = positionals;
  if (baseArg === undefined || extra.length > 0 || !/^https?:\/\//.test(baseArg)) usageExit('');
  const base = baseArg.replace(/\/$/, '');
  const players = whole('players', values.players, 20);
  const seconds = whole('seconds', values.seconds, 60);
  // 500 ms on average keeps one player near 1.6 work requests a second, under the 180 a minute each address may send.
  const think = whole('think', values.think, 500, 0);
  const pid = values.pid === undefined ? undefined : whole('pid', values.pid, 0);
  const container = values.container;
  const idleMinutes = values['idle-check'] === undefined ? undefined : whole('idle-check', values['idle-check'], 1);
  if (pid !== undefined && container !== undefined) usageExit('--pid and --container cannot both be given');
  if (values['no-memory'] === true && (pid !== undefined || container !== undefined)) usageExit('--no-memory and --pid or --container cannot both be given');
  if (values.insecure === true) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const auth: Record<string, string> = values.password !== undefined
    ? { authorization: `Basic ${Buffer.from(`load:${values.password}`).toString('base64')}` } : {};

  const samples: Sample[] = [];
  const timed = async (op: Sample['op'], url: string, init: RequestInit = {}): Promise<{ status: number; text: string }> => {
    const started = performance.now();
    let status = 0;
    let text = '';
    try {
      const res = await fetch(url, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } });
      status = res.status;
      text = await res.text();
    } catch {
      // no answer: status 0
    }
    let code: string | null = null;
    if (status !== 200 && text.startsWith('{')) {
      try {
        code = (JSON.parse(text) as { code?: string }).code ?? null;
      } catch {
        code = null;
      }
    }
    samples.push({ op, status, code, ms: performance.now() - started });
    return { status, text };
  };

  const health = await timed('health', `${base}/api/health`);
  if (health.status !== 200) {
    console.error(`${base}/api/health answered ${health.status}: is the server up?`);
    process.exit(1);
  }
  const trainersAnswer = await fetch(`${base}/api/trainers`, { headers: auth });
  const singles = trainersAnswer.ok ? ((await trainersAnswer.json()) as { id: string; battleType: string }[]).filter((t) => t.battleType === 'single').map((t) => t.id) : [];
  if (singles.length === 0) {
    console.error(`GET ${base}/api/trainers gave no single battle (status ${trainersAnswer.status})`);
    process.exit(1);
  }

  const memoryTarget = { ...(pid === undefined ? {} : { pid }), ...(container === undefined ? {} : { container }) };
  const memoryBefore = memoryMb(memoryTarget);
  let peakMb = memoryBefore;
  const deadline = Date.now() + seconds * 1000;
  let running = true;

  const healthLoop = (async () => {
    while (running) {
      await timed('health', `${base}/api/health`);
      await sleep(250);
    }
  })();
  const memoryLoop = (async () => {
    while (running && (pid !== undefined || container !== undefined)) {
      const mb = memoryMb(memoryTarget);
      if (mb !== null) peakMb = Math.max(peakMb ?? 0, mb);
      await sleep(pid !== undefined ? 1000 : 2000);
    }
  })();

  /** A player's run: its session's headers, or null when its first upload was refused and it sent nothing else. */
  const player = async (n: number): Promise<Record<string, string> | null> => {
    const session = randomBytes(16).toString('hex');
    const forwarded: Record<string, string> = values['same-ip'] === true ? {} : { 'x-forwarded-for': `198.51.100.${(n % 254) + 1}` };
    const scoped = { [SESSION_HEADER]: session, ...forwarded };
    const save = new Uint8Array(smokeSave(n));
    const upload = async (): Promise<string | null> => {
      const { status, text } = await timed('upload', `${base}/api/save`, {
        method: 'PUT', body: save,
        headers: { ...scoped, 'content-type': 'application/octet-stream', 'x-pkp-save-name': `load-${n}.dsv`, 'x-pkp-save-modified': String(Date.now()) },
      });
      if (status !== 200) return null;
      const box = JSON.parse(text) as { mons: { ref: string; draft: unknown; ineligibleReasons: string[] }[] };
      return box.mons.find((m) => m.draft !== null && m.ineligibleReasons.length === 0)?.ref ?? null;
    };
    const ref = await upload();
    if (ref === null) return null;
    const side = { reflect: false, lightScreen: false };
    const field = { rocks: { player: false, enemy: false }, screens: { player: side, enemy: side }, stages: { player: {}, enemy: {} }, enemyStatus: 'none' };
    while (Date.now() < deadline) {
      const trainer = singles[Math.floor(Math.random() * Math.min(singles.length, 60))]!;
      const roll = Math.random();
      const op: Op = roll < 0.5 ? 'plan' : roll < 0.8 ? 'sheet' : 'ai';
      const path = op === 'plan' ? '/api/plan/step' : op === 'sheet' ? '/api/sheet' : '/api/sheet/ai/stream';
      const body = op === 'plan'
        ? { trainerId: trainer, team: [ref], draft: [], state: { player: { active: ref, fainted: [] }, enemy: { active: 0, fainted: [] }, field } }
        : { trainer, team: [ref], draft: [] };
      const { status } = await timed(op, `${base}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { ...scoped, 'content-type': 'application/json' } });
      if (status === 409) await upload();                 // NO_SAVE: the session was dropped; re-send, as the page does
      await sleep(Math.random() * 2 * think);
    }
    return scoped;
  };

  console.log(`Load: ${players} players for ${seconds} s against ${base} (${singles.length} single battles to pick from)`);
  const sessions = await Promise.all(Array.from({ length: players }, (_, n) => player(n)));
  running = false;
  await Promise.all([healthLoop, memoryLoop]);
  const memoryAfter = memoryMb(memoryTarget);
  const held = sessions.filter((s): s is Record<string, string> => s !== null);

  let idle: RunFacts['idle'];
  if (idleMinutes !== undefined) {
    // The idle time, plus the sweep's minute, plus a little slack.
    const waitMs = (idleMinutes + 1) * 60_000 + 5_000;
    console.log(`  waiting ${(waitMs / 60_000).toFixed(1)} min for the sessions to expire…`);
    await sleep(waitMs);
    const answers = await Promise.all(held.map(async (headers) => {
      try {
        const res = await fetch(`${base}/api/box`, { headers: { ...auth, ...headers } });
        return res.status === 409 && ((await res.json()) as { code?: string }).code === 'NO_SAVE';
      } catch {
        return false;
      }
    }));
    idle = { gone: answers.filter(Boolean).length, of: held.length };
    const memoryIdle = memoryMb(memoryTarget);
    if (memoryIdle !== null) console.log(`  memory after the idle time: ${memoryIdle.toFixed(0)} MB (a second run's "before" should not be higher)`);
  }

  for (const op of ['upload', 'plan', 'sheet', 'ai'] as const) {
    const of = samples.filter((s) => s.op === op);
    const statuses = Object.entries(of.reduce<Record<string, number>>((acc, s) => ({ ...acc, [`${s.status}${s.code === null ? '' : ` ${s.code}`}`]: (acc[`${s.status}${s.code === null ? '' : ` ${s.code}`}`] ?? 0) + 1 }), {}))
      .map(([key, count]) => `${key}×${count}`).join(', ');
    const ms = of.filter((s) => s.status === 200).map((s) => s.ms);
    console.log(`  ${op.padEnd(6)} ${String(of.length).padStart(5)}  p50 ${percentile(ms, 50).toFixed(0)} ms  p95 ${percentile(ms, 95).toFixed(0)} ms  [${statuses}]`);
  }
  if (samples.some((s) => s.code === 'RATE_LIMITED')) {
    console.log('  Some requests were RATE_LIMITED: is the server running with PKP_TRUST_PROXY=1, reached directly (not through Caddy)?');
  }
  if (memoryBefore !== null) console.log(`  memory: ${memoryBefore.toFixed(0)} MB before, ${memoryAfter?.toFixed(0) ?? '?'} MB after`);
  const results = verdicts(samples, {
    peakMb, memoryRequired: values['no-memory'] !== true, playersWithoutSave: players - held.length, ...(idle === undefined ? {} : { idle }),
  });
  for (const { line, ok } of results) console.log(`${ok ? 'ok   ' : 'FAIL '} ${line}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
