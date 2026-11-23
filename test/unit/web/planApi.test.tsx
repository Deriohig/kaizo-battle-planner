import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, isAbort, NO_ANSWER, postPlanStep } from '../../../web/src/api';
import type { PlanStepRequestJson } from '../../../web/src/planTypes';
import { planServer, stepAnswer } from './planServer';
import { stubFetch } from './stubServer';

const FIELD: PlanStepRequestJson['state']['field'] = {
  trickRoom: false, rocks: { player: false, enemy: false },
  screens: { player: { reflect: false, lightScreen: false }, enemy: { reflect: false, lightScreen: false } },
  stages: { player: {}, enemy: {} }, enemyStatus: 'none',
};
const req = (over: Partial<PlanStepRequestJson['state']> = {}): PlanStepRequestJson => ({
  trainerId: 't', variant: 0, world: 0, team: ['party:1', 'party:2'], draft: [],
  state: { player: { active: 'party:1', fainted: [] }, enemy: { active: 0, fainted: [] }, field: FIELD, ...over },
});

afterEach(() => vi.unstubAllGlobals());

describe('postPlanStep', () => {
  it("posts the step and passes the signal; a refusal is an ApiError with the server's code", async () => {
    const server = planServer();
    const { calls } = stubFetch(server.routes);
    const signal = new AbortController().signal;
    const answer = await postPlanStep(req(), signal);
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/plan/step', body: req(), signal });
    expect(calls[0]!.headers.get('Content-Type')).toBe('application/json');
    expect(answer.choices.map((c) => c.label)).toEqual(['Use Scratch', 'Switch to Bench']);
    server.gate.fail = { status: 422, json: { error: 'x', code: 'BAD_START' } };
    const err = await postPlanStep(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'BAD_START', message: 'x' });
    await expect(postPlanStep(req())).resolves.toBeDefined();  // the gate was used once
  });

  it('a fetch that throws is NO_ANSWER, an aborted signal an abort', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('down'); }));
    await expect(postPlanStep(req())).rejects.toMatchObject({ code: NO_ANSWER, status: 0 });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted === true) throw new DOMException('Aborted', 'AbortError');
      return new Response('{}');
    }));
    const c = new AbortController();
    c.abort();
    expect(isAbort(await postPlanStep(req(), c.signal).catch((e: unknown) => e))).toBe(true);
  });
});

it("the test server's answer: the highest standing index likeliest, the start's stages, the weather filled, `extra` merged", () => {
  const out = stepAnswer(req({ enemy: { active: 0, fainted: [0] } }));
  expect(out.sendOut!.kind).toBe('replacement');
  expect(out.sendOut!.choices.map((c) => [c.index, c.probability])).toEqual([[1, { num: '1', den: '4' }], [2, { num: '3', den: '4' }]]);
  expect(stepAnswer({ ...req(), world: 2 }).world).toBe(2);
  expect(stepAnswer(req())).toMatchObject({ startStages: { player: {}, enemy: {} }, field: { weather: 'sand' } });
  expect(stepAnswer(req({ field: { ...FIELD, weather: 'rain' } })).field.weather).toBe('rain');
  expect(stepAnswer(req(), { startStages: { player: { atk: -1 }, enemy: {} }, sendOutError: 'words' })).toMatchObject({ startStages: { player: { atk: -1 }, enemy: {} }, sendOutError: 'words' });
  const rep = stepAnswer(req({ player: { active: 'party:1', fainted: ['party:1'] } }));
  expect(rep.phase).toBe('playerReplacement');
  expect(rep.choices).toEqual([{ choice: { kind: 'switch', index: 1 }, label: 'Switch to party:2' }]);
});
