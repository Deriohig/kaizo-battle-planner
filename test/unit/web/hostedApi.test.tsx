// The hosted page's session, settings and API client: the session id and settings in localStorage, `GET /api/config`,
// the session header, the save upload and the one-shot re-send on 409 NO_SAVE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError, deleteSave, getBox, getConfig, postPlanStep, postSheet, putSave, setHosted, streamSheetAi, type SheetQuery,
} from '../../../web/src/api';
import type { PlanStepRequestJson } from '../../../web/src/planTypes';
import {
  newSessionId, readHostedSettings, sessionId, SESSION_KEY, SETTINGS_KEY, writeHostedSettings,
} from '../../../web/src/hosted/session';
import { stubHosted } from './hostedServer';
import { stubFetch } from './stubServer';

const SHEET_Q = { trainerId: 't', variant: 0, team: [], draft: [] } as unknown as SheetQuery;
const STEP_Q = { trainerId: 't', variant: 0, world: 0, team: [], draft: [] } as unknown as PlanStepRequestJson;
const FILE = { bytes: new Uint8Array([1, 2, 3]).buffer, name: 'my save (1).dsv', modified: 1_700_000_000_123.9 };
const NONE = { graveyardBox: null, levelCapOverride: null };

const okRoutes = {
  'POST /api/sheet': { json: { ok: 'sheet' } },
  'POST /api/plan/step': { json: { ok: 'step' } },
  'POST /api/sheet/ai/stream': { events: [['start', { savedAt: 'x', pairs: 0 }], ['done', {}]] as [string, unknown][] },
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  setHosted(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('sessionId makes 32 lowercase hex, stores it and returns it next time; a malformed stored value is replaced', () => {
  expect(newSessionId()).toMatch(/^[0-9a-f]{32}$/);
  const id = sessionId();
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(localStorage.getItem(SESSION_KEY)).toBe(id);
  expect(sessionId()).toBe(id);
  localStorage.setItem(SESSION_KEY, 'NOT-AN-ID');
  const fresh = sessionId();
  expect(fresh).toMatch(/^[0-9a-f]{32}$/);
  expect(localStorage.getItem(SESSION_KEY)).toBe(fresh);
});

describe('readHostedSettings', () => {
  it.each([
    ['missing', null],
    ['malformed', '{nope'],
    ['not an object', '[1]'],
    ['a box of 0', '{"graveyardBox":0,"levelCapOverride":null}'],
    ['a box of 19', '{"graveyardBox":19,"levelCapOverride":null}'],
    ['a cap of 101', '{"graveyardBox":null,"levelCapOverride":101}'],
    ['a fractional cap', '{"graveyardBox":null,"levelCapOverride":50.5}'],
    ['a string box', '{"graveyardBox":"3","levelCapOverride":null}'],
    ['a missing key', '{"graveyardBox":3}'],
  ])('gives the defaults for a %s value', (_what, stored) => {
    if (stored !== null) localStorage.setItem(SETTINGS_KEY, stored);
    expect(readHostedSettings()).toEqual(NONE);
  });

  it('round-trips a valid value', () => {
    writeHostedSettings({ graveyardBox: 18, levelCapOverride: 1 });
    expect(readHostedSettings()).toEqual({ graveyardBox: 18, levelCapOverride: 1 });
    writeHostedSettings(NONE);
    expect(readHostedSettings()).toEqual(NONE);
  });
});

it('getConfig resolves local on a 404, the hosted body on a 200, and rejects on another failure', async () => {
  stubFetch({});
  await expect(getConfig()).resolves.toEqual({ mode: 'local' });
  stubHosted();
  await expect(getConfig()).resolves.toEqual({ mode: 'hosted', version: 'test', maxSaveBytes: 1_048_576, pollMs: 2_000 });
  stubFetch({ 'GET /api/config': { status: 500, json: { error: 'boom' } } });
  await expect(getConfig()).rejects.toMatchObject({ status: 500, message: 'boom' });
});

describe('putSave and deleteSave', () => {
  it('the session header rides on a call while hosted, and not otherwise', async () => {
    const hosted = stubHosted();
    setHosted({ session: () => 'a'.repeat(32), resend: async () => undefined });
    await putSave(FILE, NONE, 'upload');
    await getBox();
    expect(hosted.calls.map((c) => c.headers.get('x-pkp-session'))).toEqual(['a'.repeat(32), 'a'.repeat(32)]);

    setHosted(null);
    const local = stubFetch({ 'GET /api/box': { json: {} } });
    await getBox();
    expect(local.calls[0]!.headers.has('x-pkp-session')).toBe(false);
  });

  it('sends the six headers, the name encoded, the time whole and how the save came in; null settings send none', async () => {
    const hosted = stubHosted();
    setHosted({ session: () => 'b'.repeat(32), resend: async () => undefined });
    await putSave(FILE, { graveyardBox: 3, levelCapOverride: 40 }, 'connected');
    const call = hosted.puts()[0]!;
    expect(Object.fromEntries(call.headers.entries())).toEqual({
      'content-type': 'application/octet-stream',
      'x-pkp-session': 'b'.repeat(32),
      'x-pkp-save-name': encodeURIComponent('my save (1).dsv'),
      'x-pkp-save-modified': '1700000000123',
      'x-pkp-graveyard-box': '3',
      'x-pkp-level-cap': '40',
      'x-pkp-save-source': 'connected',
    });
    for (const source of ['upload', 'drop', 'resend', 'settings'] as const) {
      const box = await putSave(FILE, NONE, source);
      const { headers } = hosted.puts().at(-1)!;
      expect(headers.get('x-pkp-save-source')).toBe(source);
      expect(headers.has('x-pkp-graveyard-box') || headers.has('x-pkp-level-cap')).toBe(false);
      expect(box.savePath).toBe('my save (1).dsv');
    }
  });

  it('never re-sends: a NO_SAVE on the upload is thrown', async () => {
    const hosted = stubHosted();
    const resend = vi.fn(async () => undefined);
    setHosted({ session: () => 'c'.repeat(32), resend });
    hosted.nextPut({ status: 409, json: { error: 'Load your save again', code: 'NO_SAVE' } });
    await expect(putSave(FILE, NONE, 'upload')).rejects.toMatchObject({ status: 409, code: 'NO_SAVE' });
    expect(resend).not.toHaveBeenCalled();
  });

  it('deleteSave resolves on a 204', async () => {
    const hosted = stubHosted();
    setHosted({ session: () => 'd'.repeat(32), resend: async () => undefined });
    await expect(deleteSave()).resolves.toBeUndefined();
    expect(hosted.calls[0]).toMatchObject({ method: 'DELETE', url: '/api/save' });
  });
});

describe('the re-send on NO_SAVE', () => {
  /** A hosted server holding nothing, and a `resend` that uploads the file once. */
  function setup() {
    const hosted = stubHosted({ routes: okRoutes });
    const resend = vi.fn(async () => { await putSave(FILE, NONE, 'resend'); });
    setHosted({ session: () => 'e'.repeat(32), resend });
    return { hosted, resend };
  }

  it('three calls failing together re-send once, and each succeeds on the retry', async () => {
    const { hosted, resend } = setup();
    const answers = await Promise.all([getBox(), postSheet(SHEET_Q), postPlanStep(STEP_Q)]);
    expect(resend).toHaveBeenCalledTimes(1);
    expect(hosted.puts()).toHaveLength(1);
    expect(answers[0]).toMatchObject({ savePath: 'my save (1).dsv' });
    expect(answers[1]).toEqual({ ok: 'sheet' });
    expect(answers[2]).toEqual({ ok: 'step' });
  });

  it('a call that fails again after its retry is thrown, with no second re-send', async () => {
    stubHosted({ routes: okRoutes });
    const resend = vi.fn(async () => undefined);  // uploads nothing, so the retry fails too
    setHosted({ session: () => 'f'.repeat(32), resend });
    await expect(postSheet(SHEET_Q)).rejects.toMatchObject({ status: 409, code: 'NO_SAVE' });
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it('a re-send that rejects makes the call reject with the original NO_SAVE', async () => {
    stubHosted({ routes: okRoutes });
    const resend = vi.fn(async () => { throw new Error('no stored save'); });
    setHosted({ session: () => '1'.repeat(32), resend });
    const err = await getBox().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'NO_SAVE', message: 'Load your save again' });
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it('a call whose NO_SAVE lands after a failed re-send rejects, without a second re-send', async () => {
    stubHosted({ routes: okRoutes });
    const answering = globalThis.fetch;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/sheet') await gate;
      return answering(input, init);
    });
    const resend = vi.fn(async () => { throw new Error('refused'); });
    setHosted({ session: () => '2'.repeat(32), resend });
    const sheet = postSheet(SHEET_Q).catch((e: unknown) => e);
    await expect(getBox()).rejects.toMatchObject({ status: 409, code: 'NO_SAVE' });
    open();
    expect(await sheet).toMatchObject({ status: 409, code: 'NO_SAVE' });
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it('carries Retry-After on the error', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'Slow down', code: 'RATE_LIMITED' }), {
      status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
    }));
    setHosted({ session: () => '3'.repeat(32), resend: async () => undefined });
    await expect(putSave(FILE, NONE, 'upload')).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfter: 30 });
  });

  it('a later NO_SAVE (a restart) re-sends again', async () => {
    const { hosted, resend } = setup();
    await getBox();
    hosted.forget();
    await getBox();
    expect(resend).toHaveBeenCalledTimes(2);
  });

  it('streamSheetAi answered 409 NO_SAVE before the stream opens re-sends, then streams', async () => {
    const { resend } = setup();
    const events: string[] = [];
    await streamSheetAi(SHEET_Q, { onStart: () => events.push('start'), onPair: () => events.push('pair') }, new AbortController().signal);
    expect(resend).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['start']);
  });

  it('does nothing special in local mode', async () => {
    setHosted(null);
    stubFetch({ 'GET /api/box': { status: 409, json: { error: 'x', code: 'NO_SAVE' } } });
    await expect(getBox()).rejects.toMatchObject({ status: 409, code: 'NO_SAVE' });
  });
});
