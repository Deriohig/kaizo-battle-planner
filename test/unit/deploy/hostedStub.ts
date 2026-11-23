// A stub of the hosted server: just enough of its contract for deploy/smoke.sh and scripts/loadTest.ts. Each option
// breaks one thing, so a check can be seen to fail on its own.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_SAVE_BYTES, SESSION_HEADER, SESSION_ID } from '../../../src/contracts/hosted.js';

const SAVE_SIZES = new Set([524_288, 524_288 + 122]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SECURITY: Record<string, string> = {
  'content-security-policy': "default-src 'self'", 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=()', 'x-robots-tag': 'noindex',
};

export interface StubOptions {
  password?: string;
  /** A security header left off every answer. */
  dropHeader?: string;
  /** A too-big upload is answered before its body is read (closing the connection, the default), or after. */
  oversizeAnswer?: 'early' | 'after-read';
  /** Plan steps answer this status in place of 200. */
  planStatus?: { status: number; code?: string };
}

export interface Stub {
  url: string;
  /** This process, for the load test's memory measure. */
  pid: number;
  /** The `X-Forwarded-For` values the session-scoped routes saw. */
  forwarded: Set<string>;
  close(): Promise<void>;
}

export async function startStub(opts: StubOptions = {}): Promise<Stub> {
  const boxes = new Map<string, string>();
  const forwarded = new Set<string>();
  const headers = () => Object.fromEntries(Object.entries(SECURITY).filter(([name]) => name !== opts.dropHeader));
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers() }).end(JSON.stringify(body));
  };
  const body = (req: IncomingMessage) => new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk)).on('end', () => resolve(Buffer.concat(chunks)));
  });
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /api/health') return json(res, 200, { ok: true, mode: 'hosted', version: 'stub', uptimeSeconds: 1 });
      // With a password, the page, config, login and logout are open; the rest needs the cookie or Basic, else 401 SIGN_IN.
      let signedIn = opts.password === undefined;
      if (opts.password !== undefined) {
        const given = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString().split(':').slice(1).join(':');
        signedIn = given === opts.password || /(?:^|;\s*)pkp_auth=stub-token(?:;|$)/.test(req.headers.cookie ?? '');
        if (route === 'POST /api/login') {
          let sent: { password?: unknown } = {};
          try { sent = JSON.parse((await body(req)).toString() || '{}') as { password?: unknown }; } catch { /* a bad body is a wrong password */ }
          if (sent.password !== opts.password) return json(res, 401, { error: 'Wrong password', code: 'SIGN_IN' });
          return void res.writeHead(204, { 'set-cookie': 'pkp_auth=stub-token; HttpOnly; SameSite=Strict; Path=/', ...headers() }).end();
        }
        if (!['GET /', 'GET /api/config', 'POST /api/logout'].includes(route) && !signedIn) {
          return json(res, 401, { error: 'Sign in first', code: 'SIGN_IN' });
        }
      }
      if (route === 'GET /') return void res.writeHead(200, { 'content-type': 'text/html', ...headers() }).end('<!doctype html>');
      if (route === 'GET /api/config') {
        return json(res, 200, { mode: 'hosted', version: 'stub', maxSaveBytes: MAX_SAVE_BYTES, pollMs: 2000, passwordRequired: opts.password !== undefined, signedIn });
      }
      if (route === 'GET /api/sprites/icon/1.png') return void res.writeHead(200, { 'content-type': 'image/png', ...headers() }).end(PNG);
      if (route === 'GET /api/trainers') return json(res, 200, [{ id: 'a/double/1', battleType: 'double' }, { id: 'a/single/1', battleType: 'single' }]);
      const scoped = ['PUT /api/save', 'GET /api/box', 'POST /api/sheet', 'POST /api/plan/step', 'POST /api/sheet/ai/stream'];
      if (!scoped.includes(route)) return json(res, 404, { error: `No route ${url.pathname}` });
      const session = req.headers[SESSION_HEADER];
      if (typeof session !== 'string' || !SESSION_ID.test(session)) return json(res, 400, { error: 'The session header is missing', code: 'SESSION_REQUIRED' });
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string') forwarded.add(xff);
      if (route === 'PUT /api/save') {
        if (req.headers['content-type'] !== 'application/octet-stream') return json(res, 415, { error: 'octet-stream only' });
        if (Number(req.headers['content-length']) > MAX_SAVE_BYTES) {
          if (opts.oversizeAnswer === 'after-read') await body(req);
          else res.setHeader('connection', 'close');
          return json(res, 413, { error: 'Too large', code: 'TOO_LARGE' });
        }
        const bytes = await body(req);
        if (!SAVE_SIZES.has(bytes.length)) return json(res, 422, { error: 'Not a save', code: 'BAD_SAVE' });
        const box = JSON.stringify({ savePath: req.headers['x-pkp-save-name'], mons: [{ ref: 'party:1', draft: {}, ineligibleReasons: [] }] });
        boxes.set(session, box);
        return void res.writeHead(200, { 'content-type': 'application/json', ...headers() }).end(box);
      }
      const box = boxes.get(session);
      if (box === undefined) return json(res, 409, { error: 'Load your save again', code: 'NO_SAVE' });
      if (route === 'GET /api/box') return void res.writeHead(200, { 'content-type': 'application/json', ...headers() }).end(box);
      const asked = JSON.parse((await body(req)).toString()) as { trainer?: string; trainerId?: string; team: string[]; state?: unknown };
      const isPlan = route === 'POST /api/plan/step';
      if ((asked.trainer ?? asked.trainerId) !== 'a/single/1' || asked.team[0] !== 'party:1' || (isPlan && asked.state === undefined)) return json(res, 400, { error: 'bad body' });
      if (isPlan && opts.planStatus !== undefined) return json(res, opts.planStatus.status, { error: 'stub', code: opts.planStatus.code });
      if (route === 'POST /api/sheet/ai/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...headers() });
        return void res.end('event: start\ndata: {}\n\nevent: done\ndata: {}\n\n');
      }
      return json(res, 200, isPlan ? { phase: 'turnChoice' } : { pairs: [] });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    pid: process.pid,
    forwarded,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
