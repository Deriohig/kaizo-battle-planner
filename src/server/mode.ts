// Which mode the server runs in, read once at start from the flags and the environment. Local mode is the planner on the player's PC, exactly as before: 127.0.0.1 on `--port` (default 4310), `PORT` and
// `PKP_HOST` ignored. Hosted mode (`PKP_MODE=hosted`, or `--hosted`) binds `PKP_HOST` (default 0.0.0.0) on `--port`,
// else `$PORT`, else 8080, and takes its limits from the `PKP_*` variables. An empty variable counts as unset (a compose
// `.env` writes `PKP_PASSWORD=` for "none"). A value that does not parse is a `ModeError` naming it, which `main.ts`
// prints as its one line before it exits. `PKP_AI_ODDS` (section 4.10) is read in both modes: how much of the trainer
// AI's odds the server sends, `full` by default.

import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { AiOddsLevel, HealthJson } from '../contracts/api.js';

export const LOCAL_USAGE = 'Usage: npm run serve -- [--port <n>]';
const HOSTED_USAGE = 'Usage: node dist/server/server/main.js --hosted [--port <n>]';
const LOCAL_PORT = 4310;
const HOSTED_PORT = 8080;
const MAX_PORT = 65_535;

/** Hosted mode's settings (section 8.4), every value parsed and in range. */
export interface HostedConfig {
  host: string; port: number;
  /** `PKP_DATA`: the data bundle's folder. */
  dataDir: string;
  /** The built page (`staticDirFor`). */
  staticDir: string;
  /** `PKP_PASSWORD`; null is a public site. */
  password: string | null;
  /** `PKP_TRUST_PROXY`: how many proxies in front append to `X-Forwarded-For`. */
  trustProxy: number;
  /** `PKP_ALLOW_ORIGIN`: extra origins whose requests pass the `Origin` check, each as `new URL(...).origin` gives it. */
  allowOrigins: string[];
  maxSessions: number; sessionsPerIp: number; sessionIdleMs: number; sessionMemoryBytes: number;
  heavyConcurrency: number; heavyQueue: number;
  /** `PKP_LOG` is not `off`: one line per API request. */
  logRequests: boolean;
  version: string;
  /** `PKP_AI_ODDS`: how much of the trainer AI's odds the server sends. */
  aiOdds: AiOddsLevel;
}

export type ServerMode =
  | { mode: 'local'; port: number; dataDir: string; staticDir: string; version: string; aiOdds: AiOddsLevel }
  | { mode: 'hosted'; config: HostedConfig };

const AI_ODDS_LEVELS: readonly AiOddsLevel[] = ['full', 'likeliest', 'ranked', 'off'];

/** `PKP_AI_ODDS`, `full` when unset or empty; a `ModeError` naming it for anything but a level. */
function aiOddsOf(env: Env): AiOddsLevel {
  const raw = value(env, 'PKP_AI_ODDS') ?? 'full';
  const level = AI_ODDS_LEVELS.find((l) => l === raw);
  if (level === undefined) throw new ModeError(`PKP_AI_ODDS must be full, likeliest, ranked or off, not ${JSON.stringify(raw)}`);
  return level;
}

/** A flag or variable that does not parse; the message is the one line to print. */
export class ModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModeError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** `env[name]`, or undefined when it is unset or empty. */
function value(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}

/** `env[name]` as a whole number from `min` (`fallback` when unset); a `ModeError` naming it otherwise. */
function whole(env: Env, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) throw new ModeError(`${name} must be a whole number from ${min}${max === Number.MAX_SAFE_INTEGER ? '' : ` to ${max}`}, not ${JSON.stringify(raw)}`);
  return n;
}

function portOf(raw: string, what: string, usage: string): number {
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > MAX_PORT) throw new ModeError(`${what} must be a port number from 1 to ${MAX_PORT}. ${usage}`);
  return port;
}

/**
 * The built page's folder: `PKP_STATIC` when set; else `dist/web` beside the repo when `mainUrl` (main's own
 * `import.meta.url`) is the TypeScript source run by tsx (`src/server/main.ts`); else `../../web` from the compiled
 * `dist/server/server/main.js`, which is the same `dist/web`.
 */
export function staticDirFor(env: Env, mainUrl: string): string {
  const given = value(env, 'PKP_STATIC');
  if (given !== undefined) return path.resolve(given);
  return fileURLToPath(new URL(mainUrl.endsWith('.ts') ? '../../dist/web' : '../../web', mainUrl));
}

/** Each origin of `PKP_ALLOW_ORIGIN` (comma-separated), as `URL.origin` writes it. */
function allowOrigins(env: Env): string[] {
  const raw = value(env, 'PKP_ALLOW_ORIGIN');
  if (raw === undefined) return [];
  return raw.split(',').map((part) => part.trim()).filter((part) => part !== '').map((part) => {
    let url: URL;
    try {
      url = new URL(part);
    } catch {
      throw new ModeError(`PKP_ALLOW_ORIGIN holds ${JSON.stringify(part)}, which is not an origin such as http://localhost:5173`);
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== part.replace(/\/$/, '')) {
      throw new ModeError(`PKP_ALLOW_ORIGIN holds ${JSON.stringify(part)}, which is not an origin such as http://localhost:5173`);
    }
    return url.origin;
  });
}

/**
 * The mode `argv` (the arguments after the script) and `env` ask for. `mainUrl` is main's `import.meta.url`, for the
 * built page's folder (`staticDirFor`). Throws `ModeError` for an unknown flag, a bad `--port`, a `PKP_MODE` other than
 * `local` or `hosted`, or (hosted) any variable of section 8.4 that does not parse.
 */
export function readMode(argv: readonly string[], env: Env, mainUrl: string): ServerMode {
  let flags: { port?: string; hosted?: boolean };
  try {
    flags = parseArgs({ args: [...argv], options: { port: { type: 'string' }, hosted: { type: 'boolean' } } }).values;
  } catch (error) {
    throw new ModeError(`${error instanceof Error ? error.message : String(error)}. ${LOCAL_USAGE}`);
  }
  const modeName = value(env, 'PKP_MODE') ?? 'local';
  if (modeName !== 'local' && modeName !== 'hosted') throw new ModeError(`PKP_MODE must be local or hosted, not ${JSON.stringify(modeName)}`);
  const hosted = flags.hosted === true || modeName === 'hosted';
  const dataDir = value(env, 'PKP_DATA') ?? 'data';
  const staticDir = staticDirFor(env, mainUrl);
  const version = value(env, 'PKP_VERSION') ?? 'dev';
  const aiOdds = aiOddsOf(env);
  if (!hosted) {
    return { mode: 'local', port: flags.port === undefined ? LOCAL_PORT : portOf(flags.port, '--port', LOCAL_USAGE), dataDir, staticDir, version, aiOdds };
  }

  const envPort = value(env, 'PORT');
  const port = flags.port !== undefined ? portOf(flags.port, '--port', HOSTED_USAGE)
    : envPort !== undefined ? portOf(envPort, 'PORT', HOSTED_USAGE) : HOSTED_PORT;
  const host = value(env, 'PKP_HOST') ?? '0.0.0.0';
  if (isIP(host) === 0 && host !== 'localhost') throw new ModeError(`PKP_HOST must be an IP address to bind (such as 0.0.0.0 or ::), not ${JSON.stringify(host)}`);
  const log = value(env, 'PKP_LOG') ?? 'requests';
  if (log !== 'requests' && log !== 'off') throw new ModeError(`PKP_LOG must be requests or off, not ${JSON.stringify(log)}`);
  return {
    mode: 'hosted',
    config: {
      host, port, dataDir, staticDir,
      password: value(env, 'PKP_PASSWORD') ?? null,
      trustProxy: whole(env, 'PKP_TRUST_PROXY', 0, 0, 16),
      allowOrigins: allowOrigins(env),
      maxSessions: whole(env, 'PKP_MAX_SESSIONS', 200, 1),
      sessionsPerIp: whole(env, 'PKP_SESSIONS_PER_IP', 8, 1),
      sessionIdleMs: whole(env, 'PKP_SESSION_IDLE_MIN', 120, 1, 7 * 24 * 60) * 60_000,
      sessionMemoryBytes: whole(env, 'PKP_SESSION_MEMORY_MB', 256, 1, 1 << 20) * 1024 * 1024,
      heavyConcurrency: whole(env, 'PKP_HEAVY_CONCURRENCY', 2, 1, 64),
      heavyQueue: whole(env, 'PKP_HEAVY_QUEUE', 32, 0, 10_000),
      logRequests: log === 'requests',
      version,
      aiOdds,
    },
  };
}

/** `GET /api/health`'s answer (section 5.5), both modes: `uptimeSeconds` is the process's, in whole seconds. */
export function healthJson(mode: HealthJson['mode'], version: string): HealthJson {
  return { ok: true, mode, version, uptimeSeconds: Math.floor(process.uptime()) };
}
