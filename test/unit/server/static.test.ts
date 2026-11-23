import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { serveStatic } from '../../../src/server/static.js';

const INDEX = '<!doctype html><title>Plat Kaizo Planner</title><div id="root"></div>';
const HTML = 'text/html; charset=utf-8';

let root: string;
let dir: string;
let server: http.Server | undefined;

beforeEach(() => {
  // <root>/package.json sits next to the served folder <root>/web, so a path that climbs out of it would find a file.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-static-test-'));
  dir = path.join(root, 'web');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX);
  fs.writeFileSync(path.join(root, 'package.json'), '{ "secret": true }');
});

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** A request for `rawPath`, sent as written, to a server where `serveStatic(served)` answers or leaves a 418. */
async function request(rawPath: string, method = 'GET', served = dir): Promise<{ status: number; type: string | undefined; body: string }> {
  if (!server) {
    const s = http.createServer((req, res) => {
      void serveStatic(req, res, served).then((handled) => {
        if (!handled) res.writeHead(418).end();
      });
    });
    server = s;
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  }
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.end();
  });
}

it.each([
  ['app.js', 'text/javascript; charset=utf-8'], ['app.css', 'text/css; charset=utf-8'], ['logo.svg', 'image/svg+xml'], ['logo.png', 'image/png'],
  ['favicon.ico', 'image/x-icon'], ['data.json', 'application/json; charset=utf-8'], ['font.woff2', 'font/woff2'],
  ['app.js.map', 'application/json; charset=utf-8'], ['index.HTML', HTML],
])('serves assets/%s as %s', async (name, type) => {
  fs.writeFileSync(path.join(dir, 'assets', name), `contents of ${name}`);
  expect(await request(`/assets/${name}?v=1`)).toEqual({ status: 200, type, body: `contents of ${name}` });
});

it.each([
  // index.html at / and for any other GET outside /api
  ['/', 200], ['/fight', 200], ['/fight/tristan?trainer=x', 200], ['/assets', 200], ['/missing.js', 200],
  // a path that resolves outside the folder, a malformed escape or a NUL byte
  ['/../package.json', 404], ['/%2e%2e/package.json', 404], ['/assets/../../package.json', 404], ['/..%2fpackage.json', 404], ['/%2e%2e', 404],
  ['/%E0%A4%A', 404], ['/index.html%00.js', 404],
  // /api is the caller's
  ['/api/box', 418], ['/api', 418],
])('GET %s is %i', async (raw, status) => {
  const res = await request(raw);
  expect({ status: res.status, index: res.body === INDEX && res.type === HTML, secret: res.body.includes('secret') }).toEqual({ status, index: status === 200, secret: false });
});

it('answers HEAD with the headers alone, and leaves other methods to the caller', async () => {
  expect(await request('/', 'HEAD')).toEqual({ status: 200, type: HTML, body: '' });
  expect((await request('/', 'POST')).status).toBe(418);
});

it('gives 503 "Build the page first" while the folder is missing', async () => {
  const notBuilt = path.join(root, 'not-built');
  expect(await request('/', 'GET', notBuilt)).toEqual({ status: 503, type: 'text/plain; charset=utf-8', body: 'Build the page first: npm run build:web' });
  expect((await request('/fight', 'GET', notBuilt)).status).toBe(503);
});
