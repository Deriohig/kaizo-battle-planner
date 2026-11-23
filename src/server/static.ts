// The built page (`dist/web`, from `npm run build:web`). A file is served by its path with its MIME type; any other GET
// outside `/api` gets `index.html`, so a reload on any path still opens the page. A path that resolves outside the folder
// gives 404, and a folder with no `index.html` gives 503 until the page is built. Hosted mode marks the hashed assets
// (`/assets/`, Vite's output) as cacheable for a year; local mode sends no cache header on them, as before.

import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};
const OTHER_TYPE = 'application/octet-stream';
const NOT_BUILT = 'Build the page first: npm run build:web';
/** Vite's hashed assets: a new build gives new names, so a year is safe. */
const ASSET_PREFIX = '/assets/';
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Answers a GET or HEAD outside `/api` from `dir` and resolves true. Resolves false, writing nothing, for any other
 * method and for `/api` paths, which are the caller's. The raw request path is decoded and checked, so `..` segments
 * (escaped or not) cannot reach outside `dir`.
 */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, dir: string, opts: { assetCacheControl?: string } = {}): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') return false;
  const raw = (req.url ?? '/').replace(/[?#].*$/s, '');
  if (raw === '/api' || raw.startsWith('/api/')) return false;

  const root = path.resolve(dir);
  const index = path.join(root, 'index.html');
  if (!(await isFile(index))) {
    sendText(res, 503, NOT_BUILT);
    return true;
  }
  const file = fileFor(root, raw);
  if (file === null) {
    sendText(res, 404, 'Not found');
    return true;
  }
  const served = file !== root && (await isFile(file)) ? file : index;
  const body = await fs.promises.readFile(served);
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(served).toLowerCase()] ?? OTHER_TYPE,
    'Content-Length': body.length,
    // index.html names the hashed assets of the current build, so it is checked on every load.
    ...(served === index ? { 'Cache-Control': 'no-cache' } : opts.assetCacheControl !== undefined && raw.startsWith(ASSET_PREFIX) ? { 'Cache-Control': opts.assetCacheControl } : {}),
  });
  res.end(method === 'HEAD' ? undefined : body);
  return true;
}

/** The file `rawPath` names under `root`, or null for a malformed escape, a NUL byte or a path outside `root`. */
function fileFor(root: string, rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const file = path.join(root, decoded);
  const rel = path.relative(root, file);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return file;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch {
    return false;
  }
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
