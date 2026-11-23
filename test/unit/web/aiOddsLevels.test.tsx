// The page at each AI odds level (`PKP_AI_ODDS`, web/src/aiOdds.ts): the plan screen's likelihood panel, the turn's
// exchange and their send-in picker, and Matchups' "Their reply", each fed what the server sends at that level (the fake
// routes' full answers cut by the server's own aiOdds.ts), and App handing the config's level to the page. Full is the
// rest of the suite, which renders without a level.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiOddsJson, AiOddsLevel, DraftMonJson, MonRef, SheetAiPairJson, SheetJson } from '../../../src/server/apiTypes';
import { planStepAt, sheetPairAt } from '../../../src/server/aiOdds';
import { App } from '../../../web/src/App';
import { AiOddsContext } from '../../../web/src/aiOdds';
import { postPlanStep } from '../../../web/src/api';
import { PlanView } from '../../../web/src/components/PlanView';
import { AiOdds } from '../../../web/src/components/sheet/AiOdds';
import type { PlanStepJson, PlanStepRequestJson } from '../../../web/src/planTypes';
import { QUICK, r, SAND } from './lineServer';
import { stubDraft } from './planDraft';
import { planServer } from './planServer';
import { type Answer, box, draftOptions, type FetchCall, SAVE_12_JUNE, settings, setup, sheetOf, stubFetch, trainerById, trainers, TRISTAN } from './stubServer';

const TEAM: MonRef[] = ['party:1', 'party:2'];
const DRAFT: DraftMonJson[] = [{ ref: 'party:1' }, { ref: 'party:2' }];
const THEIRS = ['Imp', 'Mouse', 'Gloom'];
const base = sheetOf(TRISTAN);
const SHEET: SheetJson = { ...base, enemies: THEIRS.map((name, i) => ({ ...base.enemies[0]!, name, key: `enemy:${i}` })) };
const TIE = { aiOdds: { kind: 'turn' as const, choices: [{ ...QUICK, probability: r(1, 2), percent: 50 }, { ...SAND, probability: r(1, 2), percent: 50 }] } };

/** The fake plan-step route (planServer.ts) with each answer cut to `level` as the server cuts it. */
function serveAt(level: AiOddsLevel) {
  const server = planServer();
  const full = server.routes['POST /api/plan/step'];
  stubFetch({
    'POST /api/plan/step': async (call: FetchCall): Promise<Answer> => {
      const answer = await full(call);
      if (!('json' in answer) || (answer.status ?? 200) !== 200) return answer;
      const { enemy } = (call.body as PlanStepRequestJson).state;
      const standing = [0, 1, 2].filter((i) => i !== enemy.active && !enemy.fainted.includes(i)).map((index) => ({ index, label: THEIRS[index]! }));
      return { json: planStepAt(level, answer.json as PlanStepJson, standing) };
    },
  });
  return server;
}

const settled = () => waitFor(() => expect(document.querySelector('.plan-turn')).not.toHaveAttribute('aria-busy'));
const reply = () => screen.getByRole('region', { name: 'Their reply' });
const theirMove = () => screen.getByRole('region', { name: 'Their move' });
const heading = (region: HTMLElement) => within(region).getByRole('heading', { level: 4 }).textContent;
const rowNames = () => [...reply().querySelectorAll('.likelihood-move')].map((el) => el.textContent);
const theirCard = () => screen.getByRole('region', { name: 'Their Pokémon' });
const sendIns = () => within(within(theirCard()).getByRole('group', { name: 'Who comes in?' })).getAllByRole('button');
const pick = (user: UserEvent, name: string) => user.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
/** No AI figure in the page's text (the moves' 62.5% and 37.5%, the send-in's 75% and 25%), nor its exact fraction in a title. */
function noAiFigures(): void {
  expect(document.body.textContent).not.toMatch(/(?<![\d.])(62\.5|37\.5|75|25)%/);
  expect([...document.querySelectorAll('[title]')].map((el) => el.getAttribute('title')).filter((title) => ['5/8', '3/8', '3/4', '1/4'].includes(title ?? ''))).toEqual([]);
}

async function started(level: AiOddsLevel, extra: Partial<PlanStepJson> = {}) {
  const server = serveAt(level);
  Object.assign(server.extra, extra);
  render(<AiOddsContext value={level}><PlanView fight={{ trainerId: TRISTAN, variant: 0 }} trainer={trainerById(TRISTAN)} sheet={SHEET} sheetError={null} box={box()}
    team={TEAM} draft={DRAFT} options={draftOptions()} active onDraftProblem={vi.fn()} onPlanning={vi.fn()} onAddToTeam={vi.fn()} teamDraft={stubDraft(TEAM, DRAFT)}
    teamOpen={false} onToggleTeam={vi.fn()} step={postPlanStep} /></AiOddsContext>);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Start with Blaze (Monferno)' }));
  await screen.findByRole('button', { name: /^Scratch/ });
  await settled();
  const markTheirs = async () => {
    await user.click(within(theirCard()).getByRole('button', { name: /^Mark .* fainted$/ }));
    await settled();
  };
  return { server, user, markTheirs };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the plan screen below full', () => {
  it('likeliest names their likeliest move, no figures; every move keeps its damage in their own order; the send-in marks "likely"', async () => {
    const { user, markTheirs } = await started('likeliest');
    expect(within(reply()).getByText(/likeliest move:/).textContent).toBe("Imp's likeliest move: Quick Attack");
    expect(heading(reply())).toBe('Their moves');
    expect(rowNames()).toEqual(['Quick Attack', 'Sand-Attack', 'Rock Slide']);
    expect(reply().querySelector('.likelihood-bar, .likelihood-percent, .likelihood-rank')).toBeNull();
    expect(reply()).toHaveTextContent('4–5 HP (9–11.3%)');
    expect(reply()).toHaveTextContent('Status move · no damage');
    expect(heading(theirMove())).toBe("Imp's Quick Attack on Blaze (Monferno) · their likeliest move");
    noAiFigures();
    await pick(user, 'Sand-Attack');
    expect(heading(theirMove())).toBe("Imp's Sand-Attack on Blaze (Monferno)");
    expect(screen.getByRole('button', { name: /^Sand-Attack/ })).toHaveAttribute('aria-pressed', 'true');
    await markTheirs();
    expect(sendIns().map((b) => [b.textContent, b.getAttribute('aria-pressed'), b.getAttribute('title')])).toEqual([['Mouse', 'false', null], ['Gloom · likely', 'true', null]]);
    await user.click(sendIns()[0]!);
    expect(within(theirCard()).getByRole('button', { name: 'Mouse' })).toHaveAttribute('aria-pressed', 'true');
    noAiFigures();
  });

  it('ranked lists their moves in the AI order by place, an unranked one last; a picked move and the send-in by place', async () => {
    const { user, markTheirs } = await started('ranked');
    expect(heading(reply())).toBe('Their moves, likeliest first');
    expect(rowNames()).toEqual(['Quick Attack', 'Sand-Attack', 'Rock Slide']);
    expect([...reply().querySelectorAll('.likelihood-row')].map((row) => row.querySelector('.likelihood-rank')?.textContent ?? null)).toEqual(['1st', '2nd', null]);
    expect(reply().querySelector('.likelihood-bar, .likelihood-percent')).toBeNull();
    expect(reply()).toHaveTextContent('4–5 HP (9–11.3%)');
    expect(within(reply()).queryByText(/likeliest move:/)).toBeNull();
    expect(heading(theirMove())).toBe("Imp's Quick Attack on Blaze (Monferno) · their likeliest move");
    await pick(user, 'Sand-Attack');
    expect(heading(theirMove())).toBe("Imp's Sand-Attack on Blaze (Monferno) · 2nd likeliest");
    await markTheirs();
    expect(sendIns().map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Gloom · 1st', 'true'], ['Mouse · 2nd', 'false']]);
    noAiFigures();
  });

  it.each<[AiOddsLevel, (user: UserEvent) => Promise<void>]>([
    ['likeliest', async () => {
      expect(within(reply()).getByText(/likeliest move:/).textContent).toBe("Imp's likeliest move: Quick Attack or Sand-Attack");
      expect(heading(theirMove())).toBe("Imp's Quick Attack on Blaze (Monferno) · one of their likeliest moves");
    }],
    ['ranked', async (user) => {
      expect([...reply().querySelectorAll('.likelihood-rank')].map((el) => el.textContent)).toEqual(['=1st', '=1st']);
      await pick(user, 'Sand-Attack');
      expect(heading(theirMove())).toBe("Imp's Sand-Attack on Blaze (Monferno) · one of their likeliest moves");
    }],
  ])('%s: a tie for the top is said as a tie', async (level, check) => {
    const { user } = await started(level, TIE);
    await check(user);
  });

  it('off has no likelihood panel, no likeliest anywhere, and the send-in in party order; the damage calc\'s chances stay', async () => {
    const { markTheirs } = await started('off');
    expect(heading(reply())).toBe('Their moves');
    expect(rowNames()).toEqual(['Quick Attack', 'Sand-Attack', 'Rock Slide']);
    expect(reply().querySelector('.likelihood-bar, .likelihood-percent, .likelihood-rank')).toBeNull();
    expect(reply()).toHaveTextContent('4–5 HP (9–11.3%)');
    expect(heading(theirMove())).toBe("Imp's Quick Attack on Blaze (Monferno)");
    expect(theirMove()).toHaveTextContent('Non-crit(93.75%)4–5 HP (9–11.3%)');
    expect(theirMove()).toHaveTextContent('Crit(6.25%)8–10 HP (18.1–22.7%)');
    expect(document.body.textContent).not.toMatch(/likeliest|likely/);
    noAiFigures();
    await markTheirs();
    expect(sendIns().map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Mouse', 'true'], ['Gloom', 'false']]);
  });
});

it("Matchups' Their reply below full: the likeliest by name, or every pick in order, ties joined, each case of a depends answer", () => {
  const c = (label: string, probability: string, kind: 'move' | 'switch' = 'move') => ({ label, kind, probability });
  const ok = (...choices: ReturnType<typeof c>[]): AiOddsJson => ({ status: 'ok', choices });
  const PAIR: SheetAiPairJson = {
    player: 'party:1', enemy: 'enemy:0',
    next: ok(c('Body Slam', '5/8'), c('Fake Out', '3/16'), c('Tackle', '3/16')), ifFaints: ok(c('Zigzagoon', '2/3', 'switch'), c('Bidoof', '1/3', 'switch')),
  };
  const lines = (level: AiOddsLevel, pair: SheetAiPairJson = PAIR) => {
    const { container, unmount } = render(<AiOddsContext value={level}><AiOdds ai={{ state: 'ready', pairs: [sheetPairAt(level, pair)] }} player="party:1" enemy="enemy:0" /></AiOddsContext>);
    const out = [...container.querySelectorAll('.sheet-ai-line')].map((el) => el.textContent);
    unmount();
    return out;
  };
  const depends: AiOddsJson = {
    status: 'depends', on: "Forretress's nature",
    cases: [{ when: 'Hardy', choices: [c('Earthquake', '1/1')] }, { when: 'Sassy', choices: [c('Gyro Ball', '3/4'), c('Earthquake', '1/4')] }],
  };
  expect(lines('likeliest')).toEqual(['AI most likely picks: Body Slam', 'If it faints: most likely sends in Zigzagoon']);
  expect(lines('likeliest', { ...PAIR, next: ok(c('Growl', '1/2'), c('Tackle', '1/2')) })[0]).toBe('AI most likely picks: Growl or Tackle');
  expect(lines('ranked')).toEqual(['AI picks, likeliest first: Body Slam · Fake Out = Tackle', 'If it faints: sends in, likeliest first: Zigzagoon · Bidoof']);
  expect(lines('likeliest', { ...PAIR, next: depends })).toEqual([
    "AI's likeliest pick depends on Forretress's nature:", 'if Hardy: Earthquake', 'if Sassy: Gyro Ball', 'If it faints: most likely sends in Zigzagoon',
  ]);
  expect(lines('ranked', { ...PAIR, next: depends }).slice(0, 3)).toEqual(["AI's order depends on Forretress's nature:", 'if Hardy: Earthquake', 'if Sassy: Gyro Ball · Earthquake']);
});

describe('App hands the config level to the page', () => {
  /** The local page over the fixture save, with `aiOdds` in its config (left out: an older server's), on Matchups. */
  async function matchups(aiOdds: AiOddsLevel | undefined) {
    const sheetBody = sheetOf(TRISTAN);
    const pairs = sheetBody.pairs.map((p): [string, unknown] => ['pair', sheetPairAt(aiOdds ?? 'full', {
      player: p.player, enemy: p.enemy, ifFaints: { status: 'none', reason: 'Nothing left to send in' },
      next: { status: 'ok', choices: [{ label: 'Tackle', kind: 'move', probability: '5/8' }, { label: 'Growl', kind: 'move', probability: '3/8' }] },
    })]);
    const stub = stubFetch({
      'GET /api/config': { json: aiOdds === undefined ? { mode: 'local' } : { mode: 'local', aiOdds } },
      'GET /api/setup': { json: setup({ savePath: SAVE_12_JUNE }) },
      'GET /api/settings': { json: settings({ savePath: SAVE_12_JUNE }) },
      'GET /api/box': { json: box() },
      'GET /api/trainers': { json: trainers() },
      'GET /api/draft/options': { json: draftOptions() },
      'POST /api/sheet': { json: sheetBody },
      'POST /api/sheet/ai/stream': { events: [['start', { savedAt: sheetBody.savedAt, savePath: sheetBody.savePath, total: pairs.length }], ...pairs, ['done', {}]] },
    });
    render(<App />);
    await userEvent.setup().click(await screen.findByRole('tab', { name: 'Matchups' }));
    await waitFor(() => expect(stub.calls.some((call) => call.url === '/api/sheet')).toBe(true));
    await screen.findAllByText('Their moves');
    await act(async () => { for (let i = 0; i < 6; i++) await new Promise((res) => setTimeout(res, 0)); });
    return stub;
  }

  it('off: Matchups never asks for the AI stream and has no Their reply', async () => {
    const stub = await matchups('off');
    expect(stub.calls.filter((call) => call.url === '/api/sheet/ai/stream')).toHaveLength(0);
    expect(screen.queryByText(/Their reply|AI picks/)).toBeNull();
  });

  it.each<[string, AiOddsLevel | undefined, RegExp]>([
    ['likeliest: the stream is read and Matchups says the likeliest pick', 'likeliest', /AI most likely picks:/],
    ['a config without the level is full', undefined, /AI picks:/],
  ])('%s', async (_, level, said) => {
    await matchups(level);
    expect((await screen.findAllByText(said)).length).toBeGreaterThan(0);
  });
});
