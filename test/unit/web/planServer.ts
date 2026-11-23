// The fake plan-step route the page's tests share: the same fight as lineServer.ts (Blaze and Bench against Imp, Mouse and Gloom).
// Tests reach it through `fetch`, as every page test does: `stubFetch(planServer().routes)`. Like the real route it always
// says the battle start's stages (`startStages`, none by default); `extra` is merged into every answer from then on, so a
// test can give the start an Intimidate or make the send-out an error.

import type { LineRationalJson } from '../../../src/server/apiTypes';
import type { PlanFieldJson, PlanStepJson, PlanStepRequestJson } from '../../../web/src/planTypes';
import { BENCH, NUMBERS, r, SCRATCH, turnOdds, view } from './lineServer';
import type { Answer, FetchCall } from './stubServer';

const THEIRS = ['Imp', 'Mouse', 'Gloom'];

/** His replacement choices: a switch to every position of `team` after the first (the active is always first in `team`) that is not marked fainted. */
export function replacementChoices(req: PlanStepRequestJson): PlanStepJson['choices'] {
  return req.team.flatMap((ref, i) => (i === 0 || req.state.player.fainted.includes(ref) ? [] : [{ choice: { kind: 'switch' as const, index: i }, label: `Switch to ${ref}` }]));
}

/** The request's field with the weather the battle starts in (sand here) and its Trick Room (none here) filled. */
export const filledField = (req: PlanStepRequestJson): PlanFieldJson => ({
  ...req.state.field, weather: req.state.field.weather ?? 'sand', trickRoom: req.state.field.trickRoom ?? false,
});

/** The answer for `req`. When their active is marked fainted, the highest standing index is the likeliest (3/4), so a test can tell it from the first standing. */
export function stepAnswer(req: PlanStepRequestJson, extra: Partial<PlanStepJson> = {}): PlanStepJson {
  const replacing = req.state.player.fainted.includes(req.state.player.active);
  const answer: PlanStepJson = {
    phase: replacing ? 'playerReplacement' : 'turnChoice',
    view: view(), choices: replacing ? replacementChoices(req) : [SCRATCH, BENCH],
    damage: NUMBERS, aiOdds: turnOdds, field: filledField(req), startStages: { player: {}, enemy: {} }, unmodelled: [], world: req.world ?? 0,
  };
  const { active, fainted } = req.state.enemy;
  const left = [0, 1, 2].filter((i) => !fainted.includes(i));
  if (fainted.includes(active) && left.length > 0) {
    const top = Math.max(...left);
    const share = (i: number): LineRationalJson => (left.length === 1 ? r(1, 1) : i === top ? r(3, 4) : r(1, 4 * (left.length - 1)));
    answer.sendOut = { kind: 'replacement', choices: left.map((index) => ({ index, label: THEIRS[index]!, probability: share(index), percent: Number(share(index).num) / Number(share(index).den) * 100 })) };
  }
  return { ...answer, ...extra };
}

export function planServer(): {
  routes: { 'POST /api/plan/step': (call: FetchCall) => Promise<Answer> };
  requests(): PlanStepRequestJson[];
  gate: { hold: Promise<void> | null; fail: Answer | null };
  /** Merged into every answer from now on. */
  extra: Partial<PlanStepJson>;
} {
  const seen: PlanStepRequestJson[] = [];
  const gate: { hold: Promise<void> | null; fail: Answer | null } = { hold: null, fail: null };
  const server = {
    routes: {
      'POST /api/plan/step': async (call: FetchCall): Promise<Answer> => {
        const req = call.body as PlanStepRequestJson;
        seen.push(req);
        const { hold, fail } = gate;
        gate.hold = null;
        gate.fail = null;
        if (hold !== null) await hold;
        if (fail !== null) return fail;
        return { json: stepAnswer(req, server.extra) };
      },
    },
    requests: () => seen,
    gate,
    extra: {} as Partial<PlanStepJson>,
  };
  return server;
}
