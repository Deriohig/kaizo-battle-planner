import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCatalog } from '../../../src/battle/catalog.js';
import { buildMoves } from '../../../src/battle/moves.js';
import { SaveError } from '../../../src/errors.js';
import { buildBox } from '../../../src/server/box.js';
import { HttpError } from '../../../src/server/http.js';
import { readUploadBody, saveName, uploadedBox, uploadMeta, type UploadMeta } from '../../../src/server/saveUpload.js';
import type { ServerData } from '../../../src/server/state.js';
import { saveFile, serverData } from './fixtures.js';

const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** What `run` throws, if anything. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The `HttpError` `run` throws. */
function httpError(run: () => unknown): HttpError {
  const error = thrown(run);
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

describe('saveName', () => {
  const enc = encodeURIComponent;
  it.each([
    ['game.dsv', 'game.dsv'], [enc('Platinum Kaizo (1) ñ.dsv'), 'Platinum Kaizo (1) ñ.dsv'],
    // An escape that does not decode.
    ['%', null], ['bad%E0%A4%A.dsv', null], ['%FF.dsv', null],
    // Only the last path part, for / and \, without control characters.
    [enc('/home/player/saves/game.dsv'), 'game.dsv'], [enc('C:\\Users\\Player\\game.dsv'), 'game.dsv'], [enc('../../etc/passwd'), 'passwd'],
    [enc('a/b\\c.sav'), 'c.sav'], [enc('ga\u0000me\n\r\t\u001f\u007f\u0085\u009f.dsv'), 'game.dsv'],
    // At most 120 characters, counting code points.
    ['a'.repeat(130), 'a'.repeat(120)], [enc('é'.repeat(130)), 'é'.repeat(120)], [enc('😀'.repeat(130)), '😀'.repeat(120)],
    // save.dsv when nothing is left.
    ['', 'save.dsv'], [enc('\u0001\u0002'), 'save.dsv'], [enc('saves/'), 'save.dsv'], [enc('saves/\u0007'), 'save.dsv'],
  ])('%j is %j', (raw, name) => {
    expect(saveName(raw)).toBe(name);
  });
});

describe('uploadMeta', () => {
  const NOW = Date.UTC(2026, 10, 21, 12);
  const DAY = 86_400_000;
  const EARLIEST = Date.UTC(2004, 0, 1);
  const MODIFIED = Date.UTC(2026, 10, 20, 8, 30);
  const base = { 'x-pkp-save-name': encodeURIComponent('My Save.dsv'), 'x-pkp-save-modified': String(MODIFIED) };
  const meta = (headers: Record<string, string | string[] | undefined>) => uploadMeta({ ...base, ...headers }, NOW);
  const settings = (graveyardBox: number | null, levelCapOverride: number | null) => ({ settings: { graveyardBox, levelCapOverride } });

  it.each<[Record<string, string | string[]>, object]>([
    [{}, { name: 'My Save.dsv', modified: new Date(MODIFIED), ...settings(null, null) }],
    [{ 'x-pkp-graveyard-box': '12', 'x-pkp-level-cap': '55' }, settings(12, 55)],
    // The first of a repeated header; an empty name.
    [{ 'x-pkp-graveyard-box': ['3', '99'] }, settings(3, null)], [{ 'x-pkp-save-name': '' }, { name: 'save.dsv' }],
    // The edges of each range.
    [{ 'x-pkp-save-modified': String(EARLIEST) }, { modified: new Date(EARLIEST) }],
    [{ 'x-pkp-save-modified': String(NOW + DAY) }, { modified: new Date(NOW + DAY) }],
    [{ 'x-pkp-graveyard-box': '1', 'x-pkp-level-cap': '100' }, settings(1, 100)],
    [{ 'x-pkp-graveyard-box': '18', 'x-pkp-level-cap': '1' }, settings(18, 1)],
  ])('reads %j', (headers, expected) => {
    expect(meta(headers)).toMatchObject(expected);
  });

  it.each(Object.entries({
    'x-pkp-save-name': [undefined, '%E0%A4%A'],
    'x-pkp-save-modified': [undefined, 'abc', '1.5', '-1', ' 1700000000000', '1e12', '', String(EARLIEST - 1), String(NOW + DAY + 1)],
    'x-pkp-graveyard-box': ['0', '19', 'x', '', '1.0', '-3'],
    'x-pkp-level-cap': ['0', '101', 'max', ''],
  }).flatMap(([header, raws]) => raws.map((raw) => [header, raw] as const)))('refuses %s %j with a 400 naming it', (header, raw) => {
    const error = httpError(() => meta({ [header]: raw }));
    expect([error.status, error.code, error.message]).toEqual([400, undefined, expect.stringContaining(header)]);
  });

  it('checks in order: name, time, graveyard, cap', () => {
    const allBad = { 'x-pkp-save-name': '%', 'x-pkp-save-modified': 'x', 'x-pkp-graveyard-box': '0', 'x-pkp-level-cap': '0' };
    const fixed = [{}, { 'x-pkp-save-name': 'a.dsv' }, { 'x-pkp-save-modified': String(MODIFIED) }, { 'x-pkp-graveyard-box': '5' }];
    ['x-pkp-save-name', 'x-pkp-save-modified', 'x-pkp-graveyard-box', 'x-pkp-level-cap'].forEach((named, i) => {
      expect(httpError(() => meta(Object.assign({}, allBad, ...fixed.slice(0, i + 1)))).message).toContain(named);
    });
  });
});

describe('readUploadBody', () => {
  type Outcome = { body?: Uint8Array; error?: unknown };
  type Send = (req: http.ClientRequest) => unknown;
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

  /** A PUT, sent by `send`, to a server that reads its body with `readUploadBody(opts)`: what the server read, or the error it got. */
  async function upload(opts: { maxBytes: number; timeoutMs?: number }, headers: Record<string, number>, send: Send): Promise<Outcome> {
    let report!: (outcome: Outcome) => void;
    const outcome = new Promise<Outcome>((resolve) => { report = resolve; });
    const server = http.createServer((req, res) => {
      readUploadBody(req, opts).then((body) => { report({ body }); res.end('ok'); }, (error: HttpError) => {
        report({ error });
        res.writeHead(error.status ?? 500, { ...error.headers }).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/', headers: { 'Content-Type': 'application/octet-stream', ...headers } });
    req.on('error', () => undefined).on('response', (res) => res.resume());
    await send(req);
    const result = await outcome;
    req.destroy();
    return result;
  }

  it.each<[string, Record<string, number>, number[]]>([
    ['a chunked body, whole', {}, [300, 1, 299]], ['a body of exactly the cap', { 'Content-Length': 1000 }, [1000]],
    ['an empty body', { 'Content-Length': 0 }, []],
  ])('reads %s as one Uint8Array', async (_, headers, sizes) => {
    const parts = sizes.map((n) => randomBytes(n));
    const { body, error } = await upload({ maxBytes: 1000 }, headers, (req) => {
      for (const part of parts) req.write(part);
      req.end();
    });
    const sent = Buffer.concat(parts);
    expect([error, body instanceof Uint8Array, body!.length, sha(body!)]).toEqual([undefined, true, sent.length, sha(sent)]);
  });

  const closing: Send = async (req) => {
    req.write(randomBytes(10));
    await new Promise((resolve) => setTimeout(resolve, 20));
    req.destroy();
  };
  it.each<[string, number | undefined, Record<string, number>, Send, number, string | undefined]>([
    ['a Content-Length over the cap, before a byte is sent', undefined, { 'Content-Length': 1001 }, (req) => req.flushHeaders(), 413, 'TOO_LARGE'],
    ['a chunked body once it passes the cap', undefined, {}, (req) => req.write(randomBytes(600)) && req.write(randomBytes(401)), 413, 'TOO_LARGE'],
    ['a body that has not arrived within timeoutMs', 50, { 'Content-Length': 100 }, (req) => req.write(randomBytes(10)), 408, undefined],
    // Node emits the request's 'error' (ECONNRESET "aborted") before 'close': either way it is 499 CLOSED, not a 500.
    ['a request that closes before its end', undefined, { 'Content-Length': 100 }, closing, 499, 'CLOSED'],
  ])('refuses %s', async (_, timeoutMs, headers, send, status, code) => {
    const { body, error } = await upload({ maxBytes: 1000, timeoutMs }, headers, send);
    expect([body, error instanceof HttpError, (error as HttpError).code]).toEqual([undefined, true, code]);
    expect(error).toMatchObject({ status, ...(status === 499 ? {} : { headers: { Connection: 'close' } }) });
  });
});

describe('uploadedBox', () => {
  const local = serverData();
  const data: ServerData = { local, catalog: buildCatalog(local), moves: buildMoves(local) };
  const MODIFIED = new Date(Date.UTC(2026, 10, 20, 8, 30));
  const meta = (settings: Partial<UploadMeta['settings']> = {}): UploadMeta => ({
    name: 'My Save.dsv', modified: MODIFIED, settings: { graveyardBox: null, levelCapOverride: null, ...settings },
  });
  const boxOf = (file: Uint8Array, graveyardBox: number | null = null, levelCapOverride: number | null = null) => buildBox({
    file, savePath: 'My Save.dsv', savedAt: MODIFIED, data: local, settings: { romPath: null, savePath: 'My Save.dsv', graveyardBox, levelCapOverride },
  });

  it.each([[null, null], [3, 40]])('is the box buildBox gives for its name and time, graveyard %s and cap %s', (graveyardBox, levelCapOverride) => {
    const logFailure = vi.fn();
    const expected = boxOf(saveFile(), graveyardBox, levelCapOverride).json;
    expect(uploadedBox(saveFile(), meta({ graveyardBox, levelCapOverride }), data, logFailure).json).toEqual(expected);
    expect([expected.savePath, expected.savedAt, logFailure.mock.calls]).toEqual(['My Save.dsv', '2026-11-20T08:30:00.000Z', []]);
  });

  it.each([['random bytes', new Uint8Array(randomBytes(4096))], ['a save-sized file of zeros', new Uint8Array(524_288)]])(
    'answers %s with 422 BAD_SAVE and the SaveError message, logging nothing',
    (_, file) => {
      const saveError = thrown(() => boxOf(file));
      expect(saveError).toBeInstanceOf(SaveError);
      const logFailure = vi.fn();
      const error = httpError(() => uploadedBox(file, meta(), data, logFailure));
      expect([error.status, error.code, error.message, logFailure.mock.calls]).toEqual([422, 'BAD_SAVE', (saveError as SaveError).message, []]);
    },
  );

  it('answers any other throw with 422 BAD_SAVE "not a Platinum save", after logFailure gets the error', () => {
    const broken = { ...data, local: { ...local, rom: null } } as unknown as ServerData;
    const logFailure = vi.fn();
    expect(httpError(() => uploadedBox(saveFile(), meta(), broken, logFailure)))
      .toMatchObject({ status: 422, code: 'BAD_SAVE', message: 'This file does not read as a Platinum save' });
    const logged = logFailure.mock.calls[0]![0] as unknown;
    expect([logFailure.mock.calls.length, logged instanceof Error, logged instanceof SaveError, logged instanceof HttpError])
      .toEqual([1, true, false, false]);
  });
});
