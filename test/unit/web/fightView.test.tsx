import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SheetAiPairJson, SheetJson, SheetRequestJson } from '../../../src/server/apiTypes';
import { FightView } from '../../../web/src/components/FightView';
import { FightHeader } from '../../../web/src/components/fight/FightHeader';
import { MatchupsView } from '../../../web/src/components/MatchupsView';
import { planMonOf } from '../../../web/src/components/plan/planScreen';
import { problemText } from '../../../web/src/draft';
import { newPlan } from '../../../web/src/plan';
import { planCurrentKey, readCurrentPlan } from '../../../web/src/planStore';
import type { PlanStepRequestJson } from '../../../web/src/planTypes';
import { CURSOR_KEY, readCursor } from '../../../web/src/run';
import { planServer, stepAnswer } from './planServer';
import {
  type Answer, box, draftOptions, type FetchCall, GARDENIA, liveStream, ROARK, sheetOf, stubFetch, TAYLOR, trainerById, trainers, TRISTAN,
} from './stubServer';

// The page's plan step is the real client, so it goes through `fetch` to the fake route (planServer.ts).

interface LiveCall { call: FetchCall; live: ReturnType<typeof liveStream> }
type Route = Parameters<typeof stubFetch>[0][string];

const LATER = '2026-06-12T12:20:00.000Z';
/** The server's refusal of a draft whose EXP does not fit Blaze's level. */
const REFUSAL = 'draft: party:1 exp must fit level 15';

/** The trainer AI's odds for `player` against a `sheetOf` sheet's Starly: `move` 5/8 or Growl 3/8, and no one left. */
function aiPair(player: string, move: string): SheetAiPairJson {
  return {
    player, enemy: 'enemy:0',
    next: { status: 'ok', choices: [{ label: move, kind: 'move', probability: '5/8' }, { label: 'Growl', kind: 'move', probability: '3/8' }] },
    ifFaints: { status: 'none', reason: 'Nothing left to send in' },
  };
}
/** The AI stream's `start` for a `sheetOf` sheet (two pairs), read from the save of `savedAt`. */
const aiStart = (savedAt = box().savedAt) => ({ savedAt, savePath: box().savePath, total: 2 });
/** The whole AI stream for a `sheetOf` sheet: `start`, each pair with `move` 5/8, then `done`. */
function aiStream(move: string, savedAt?: string): Answer {
  const pairs = sheetOf(TRISTAN).pairs.map((pair): [string, unknown] => ['pair', aiPair(pair.player, move)]);
  return { events: [['start', aiStart(savedAt)], ...pairs, ['done', {}]] };
}
/** An AI stream route the test feeds: each request a live stream, kept in `streams`. */
function liveAi(): { streams: LiveCall[]; route: Route } {
  const streams: LiveCall[] = [];
  return { streams, route: (call) => { const live = liveStream(call.signal); streams.push({ call, live }); return { stream: live.stream }; } };
}
/** Every fixture trainer, or those whose name holds the search, as the server's `search` does. */
function trainersRoute(call: FetchCall): Answer {
  const search = new URL(call.url, 'http://127.0.0.1').searchParams.get('search')?.toLowerCase();
  return { json: search === undefined ? trainers() : trainers().filter((t) => t.name.toLowerCase().includes(search)) };
}

/** The fake server: trainers, sheets, the AI stream (Tackle 5/8 unless given), the draft options and the plan step. */
function serve(over: { ai?: Route; sheet?: Route; trainers?: Route; start?: Route } = {}) {
  const stub = stubFetch({
    'GET /api/trainers': over.trainers ?? trainersRoute,
    'POST /api/sheet': over.sheet ?? sheetRoute,
    'POST /api/sheet/ai/stream': over.ai ?? aiStream('Tackle'),
    'GET /api/draft/options': { json: draftOptions() },
    ...planServer().routes,
    ...(over.start === undefined ? {} : { 'POST /api/plan/step': over.start }),
  });
  return {
    ...stub,
    stepCalls: () => stub.calls.filter((c) => c.url === '/api/plan/step').map((c) => c.body as PlanStepRequestJson),
    sheetCalls: () => stub.calls.filter((c) => c.url === '/api/sheet').map((c) => c.body as SheetRequestJson),
    aiCalls: () => stub.calls.filter((c) => c.url === '/api/sheet/ai/stream'),
  };
}
/** The fixture sheet the body asks for, read from the save of `savedAt`. */
function sheetRoute(call: FetchCall, savedAt?: string): Answer {
  const body = call.body as SheetRequestJson;
  return { json: sheetOf(body.trainer, { variant: body.variant ?? 0, ...(savedAt !== undefined && { savedAt }) }) };
}
/** `sheetRoute`'s answer with a note saying which body it answers: "Asked for party:2 then party:1, Blaze at 44 HP". */
function notedRoute(call: FetchCall): Answer {
  const body = call.body as SheetRequestJson;
  const sheet = (sheetRoute(call) as { json: SheetJson }).json;
  const hp = body.draft.find((d) => d.ref === 'party:1')?.hp ?? 'save';
  return { json: { ...sheet, notes: [`Asked for ${body.team.join(' then ')}, Blaze at ${hp} HP`] } };
}
/** A route whose answers the test gives: each call waits in `held` until `answer` is called. */
function holdAnswers(): { held: { call: FetchCall; answer(a: Answer): void }[]; route: (call: FetchCall) => Promise<Answer> } {
  const held: { call: FetchCall; answer(a: Answer): void }[] = [];
  return { held, route: (call) => new Promise<Answer>((resolve) => { held.push({ call, answer: resolve }); }) };
}
/** A plan step that refuses its first request with `error` (a 400), then answers as the fake route does. */
function refuseOnce(error: string): Route {
  let n = 0;
  return (call) => (n++ === 0 ? { status: 400, json: { error } } : { json: stepAnswer(call.body as PlanStepRequestJson) });
}
/** Keeps a plan for Roark's first copy, led by party `lead` (0 or 1). */
function keepRoarkPlan(lead: number) {
  const b = box();
  const mons = ['party:1', 'party:2'].map((ref) => planMonOf(b.mons.find((m) => m.ref === ref)!, []));
  const plan = newPlan({ trainerId: ROARK, variant: 0, world: 0, mons, lead: mons[lead]!.key, enemies: ['Starly'] });
  localStorage.setItem(planCurrentKey(ROARK, 0), JSON.stringify({ v: 1, save: { savePath: b.savePath, savedAt: b.savedAt }, plan }));
}

/** Clicks "Start with {name}" once the sheet is in (until then it is held). */
async function startWith(user: UserEvent, name: string) {
  const button = await screen.findByRole('button', { name: `Start with ${name}` });
  await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'));
  await user.click(button);
}
/** Lets an answer the test just gave reach the page, so that a test can see it was dropped. */
const settle = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve, 0); }));
function teamItem(name: string, label: string): HTMLElement {
  const button = screen.getByRole('button', { name: `Actions for ${name}` });
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
  return screen.getByRole('menuitem', { name: label });
}
const sheetPanel = () => screen.getByRole('tabpanel', { name: 'Matchups' });
function pairRow(player: RegExp): HTMLElement {
  const row = within(within(sheetPanel()).getByRole('region', { name: 'Starly Lv 5' })).getByRole('heading', { level: 4, name: player }).closest('li');
  if (row === null) throw new Error(`No pair for ${player}`);
  return row;
}
const BLAZE = /Blaze \(Monferno\)/;
const STARLY = /^Starly/;
/** The live region beside the sheet's AI note. */
const aiStatus = () => sheetPanel().querySelector('.sheet-ai-status[role="status"]');
const matchups = async (user: UserEvent) => { await user.click(await screen.findByRole('tab', { name: 'Matchups' })); };
const teamColumn = () => screen.getByRole('complementary', { name: 'Team for this fight' });
const isPlanning = () => document.querySelector('.fight')!.classList.contains('is-planning');
const afterThis = () => screen.queryByRole('button', { name: /^Leader Roark.*After this/ });
async function pickTrainer(user: UserEvent, name: string) {
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${name}`) }));
}
/** Searches every trainer for `text` and opens the one named `name`. */
async function searchAndOpen(user: UserEvent, text: string, name: string) {
  const search = screen.getByRole('searchbox', { name: 'Search all trainers' });
  await user.clear(search);
  await user.type(search, text);
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${name}`) }, { timeout: 5_000 }));
  return screen.findByRole('region', { name });
}

describe('FightView', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("opens the split's first fight with the save's party in one bar with the tabs, and marks the next", async () => {
    serve();
    render(<FightView box={box()} />);
    const region = await screen.findByRole('region', { name: 'Youngster Tristan' });
    expect(region).toHaveTextContent('Route 202 · Roark Split · Single battle');
    const bar = within(region).getByRole('tablist', { name: 'Fight or matchups' }).parentElement!;
    expect(bar).toHaveClass('fight-bar');
    expect([...bar.children].map((el) => el.className)).toEqual(['fight-header', 'tabs']);
    expect(within(bar).getByRole('heading', { level: 2 })).toHaveTextContent('Youngster Tristan');
    expect(screen.getByRole('tab', { name: 'Fight' })).toHaveAttribute('aria-selected', 'true');
    expect(within(teamColumn()).getAllByRole('listitem')).toHaveLength(2);
    expect(afterThis()).toBeInTheDocument();
    expect(localStorage.getItem(CURSOR_KEY)).toBeNull();                      // opening by itself does not move the cursor
  });

  it("a click keeps its fight as the cursor; a trainer found by search opens without moving it; After this follows the cursor", async () => {
    serve();
    const user = userEvent.setup();
    const first = render(<FightView box={box()} />);
    await screen.findByRole('region', { name: 'Youngster Tristan' });
    expect(await searchAndOpen(user, 'tay', 'Aroma Lady Taylor')).toHaveTextContent('Eterna Gym · Gardenia Split · Single battle');
    expect(readCursor(box().savePath)).toBeNull();
    expect(screen.getByRole('region', { name: 'Next fights' })).toHaveTextContent('Roark Split · 3 fights');
    expect(afterThis()).toBeInTheDocument();                                   // with no cursor, the run is at the first single

    await pickTrainer(user, 'Leader Roark');
    expect(readCursor(box().savePath)).toEqual({ split: 'Roark Split', trainerId: ROARK });
    expect(afterThis()).toBeNull();                                            // nothing follows Roark in his split
    await searchAndOpen(user, 'tay', 'Aroma Lady Taylor');
    expect(afterThis()).toBeNull();                                            // not the split's first single
    expect(readCursor(box().savePath)).toEqual({ split: 'Roark Split', trainerId: ROARK });
    first.unmount();

    render(<FightView box={box()} />);                                         // the page opens at the cursor again
    expect(await screen.findByRole('region', { name: 'Leader Roark' })).toBeInTheDocument();
    await pickTrainer(user, 'Youngster Tristan');
    await searchAndOpen(user, 'tay', 'Aroma Lady Taylor');
    expect(afterThis()).toBeInTheDocument();
  });

  it('at 8 badges the Split select lists the other split, opens its first single and keeps it as the cursor; a click there is kept too', async () => {
    serve();
    const user = userEvent.setup();
    render(<FightView box={box({ run: { split: 'Roark Split', splitIndex: 0, splits: ['Roark Split', 'Gardenia Split'], alsoPossible: ['Gardenia Split'], fights: [], next: null } })} />);
    await screen.findByRole('region', { name: 'Youngster Tristan' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Split' }), 'Gardenia Split');
    expect(await screen.findByRole('region', { name: 'Aroma Lady Taylor' })).toBeInTheDocument();
    expect(readCursor(box().savePath)).toEqual({ split: 'Gardenia Split', trainerId: TAYLOR });
    await user.click(screen.getByRole('button', { name: /^Leader Gardenia/ }));
    expect(readCursor(box().savePath)).toEqual({ split: 'Gardenia Split', trainerId: GARDENIA });
  });

  it('a double opens Matchups only, and says why', async () => {
    serve();
    const user = userEvent.setup();
    render(<FightView box={box()} />);
    await pickTrainer(user, 'Twins Ally and Ann');
    expect(screen.getByText("Double battle: can't be built yet. Matchups still work.")).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Fight' })).toBeNull();
    expect(afterThis()).toBeInTheDocument();                                   // the next single is still Roark
    expect(await screen.findByRole('region', { name: 'Starly Lv 5' })).toBeInTheDocument();
  });

  const ASKED = { trainer: TRISTAN, variant: 0, team: ['party:1', 'party:2'], draft: [{ ref: 'party:1' }, { ref: 'party:2' }] };

  it('Matchups asks for the whole team as drafted, says nothing about the save, and follows an edit and the order', async () => {
    const { sheetCalls } = serve();
    const user = userEvent.setup();
    render(<FightView box={box()} />);
    await matchups(user);
    expect(sheetCalls()[0]).toEqual(ASKED);
    expect(sheetPanel()).not.toHaveTextContent(/save's values|Left out of Matchups|HP: /);
    await user.click(screen.getByRole('button', { name: 'All to full HP' }));
    await waitFor(() => expect(sheetCalls().at(-1)).toEqual({ ...ASKED, draft: [{ ref: 'party:1', hp: 44 }, { ref: 'party:2' }] }));
    await user.click(teamItem('Starly', 'Move Starly up'));
    await waitFor(() => expect(sheetCalls().at(-1)).toMatchObject({ team: ['party:2', 'party:1'], draft: [{ ref: 'party:2' }, { ref: 'party:1', hp: 44 }] }));
  });

  it('a team member over the cap is asked for like any other; an empty team asks for the trainer alone, with no AI', async () => {
    const { sheetCalls, aiCalls } = serve({
      sheet: (call) => {
        const s = sheetRoute(call) as { json: SheetJson };
        return (call.body as { team: string[] }).team.length > 0 ? s : { json: { ...s.json, players: [], pairs: [] } };
      },
    });
    const user = userEvent.setup();
    render(<FightView box={box()} />);
    await user.selectOptions(await screen.findByLabelText('Add from the box'), 'box:1:4');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await matchups(user);
    await waitFor(() => expect(sheetCalls().at(-1)).toMatchObject({ team: ['party:1', 'party:2', 'box:1:4'] }));
    await waitFor(() => expect(aiCalls().length).toBeGreaterThan(0));
    for (const name of ['Blaze (Monferno)', 'Starly', 'Big (Bibarel)']) await user.click(teamItem(name, `Remove ${name}`));
    await waitFor(() => expect(sheetCalls().at(-1)).toMatchObject({ team: [], draft: [] }));
    const asked = aiCalls().length;
    expect(sheetPanel()).toHaveTextContent('Add a Pokémon to the team to see matchups.');
    await user.click(screen.getByRole('tab', { name: 'Fight' }));
    expect(await screen.findByText(/Starly/, { selector: '.line-start *' })).toBeInTheDocument();     // the trainer's sets still show
    await settle();
    expect(aiCalls()).toHaveLength(asked);
  });

  it('the trainer copy is picked in the fight header and goes to the sheet', async () => {
    const { sheetCalls } = serve();
    const user = userEvent.setup();
    render(<FightView box={box()} />);
    await screen.findByRole('region', { name: 'Youngster Tristan' });
    expect(screen.queryByRole('combobox', { name: 'Trainer copy' })).toBeNull();
    await pickTrainer(user, 'Leader Roark');
    const copy = screen.getByRole('combobox', { name: 'Trainer copy' });
    expect(within(copy).getAllByRole('option').map((o) => o.textContent)).toEqual(['Copy 1 (default)', 'Copy 2']);
    await user.selectOptions(copy, 'Copy 2');
    await waitFor(() => expect(sheetCalls().at(-1)).toMatchObject({ trainer: ROARK, variant: 1 }));
  });

  it("an edit goes to the fight that starts next, a turn carries no hp switch, and the team column is put away while planning", async () => {
    const t = serve();
    const user = userEvent.setup();
    render(<FightView box={box()} />);
    const field = await screen.findByRole('spinbutton', { name: 'Level of Starly' });
    await user.clear(field);
    await user.type(field, '16{Enter}');
    await startWith(user, 'Starly');
    expect(await screen.findByRole('heading', { name: 'Battle plan · vs Youngster Tristan' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Start at full HP' })).toBeNull();
    await waitFor(() => expect(t.stepCalls()).toHaveLength(1));
    expect(t.stepCalls()[0]).toMatchObject({ trainerId: TRISTAN, variant: 0, world: 0, team: ['party:2', 'party:1'] });
    expect(t.stepCalls()[0]!.draft).toEqual([{ ref: 'party:2', level: 16 }, { ref: 'party:1' }]);       // no hp, nor any other key
    // While a plan is on the Fight tab the draft editor is put away, still mounted; Matchups shows it again.
    expect(isPlanning()).toBe(true);
    expect(screen.queryByRole('complementary', { name: 'Team for this fight' })).toBeNull();
    expect(document.querySelector('.fight-team .team-panel')).not.toBeNull();
    await matchups(user);
    expect(isPlanning()).toBe(false);
    expect(teamColumn()).toBeInTheDocument();
  });

  it('another fight with a kept plan keeps the page planning, the team column put away', async () => {
    keepRoarkPlan(0);
    serve();
    const user = userEvent.setup();
    render(<FightView box={box()} />);
    await startWith(user, 'Starly');
    expect(await screen.findByRole('heading', { name: 'Battle plan · vs Youngster Tristan' })).toBeInTheDocument();
    await pickTrainer(user, 'Leader Roark');
    expect(await screen.findByRole('heading', { name: 'Battle plan · vs Leader Roark' })).toBeInTheDocument();
    await settle();
    expect(isPlanning()).toBe(true);
    expect(screen.queryByRole('complementary', { name: 'Team for this fight' })).toBeNull();
  });

  // The plan's team column changes the draft through its own place and move, which keep each entry.
  it("a reorder in the plan's team column keeps the draft's edits", async () => {
    const t = serve();
    const user = userEvent.setup();
    render(<FightView box={box()} />);
    await user.click(await screen.findByRole('button', { name: 'All to full HP' }));            // Blaze 30/44 -> 44
    await startWith(user, 'Blaze (Monferno)');
    await screen.findByRole('heading', { name: 'Battle plan · vs Youngster Tristan' });
    await waitFor(() => expect(t.stepCalls()).toHaveLength(1));
    expect(t.stepCalls()[0]!.draft[0]).toEqual({ ref: 'party:1', hp: 44 });
    await user.click(screen.getByRole('button', { name: 'Actions for Blaze (Monferno)' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move Blaze (Monferno) later' }));
    await waitFor(() => expect(readCurrentPlan(TRISTAN, 0)!.plan.start.mons.map((m) => m.ref)).toEqual(['party:2', 'party:1']));
    await settle();
    expect(readCurrentPlan(TRISTAN, 0)!.plan.start.mons[1]!.entry).toEqual({ ref: 'party:1', hp: 44 });
    expect(t.stepCalls().at(-1)!.draft.find((d) => d.ref === 'party:1')).toEqual({ ref: 'party:1', hp: 44 });
    await matchups(user);
    expect(within(teamColumn()).getAllByRole('listitem')[0]).toHaveTextContent('Starly');
  });

  const REFUSED = 'draft: party:2 hp must be a whole number from 1 to 38, not 0';

  it('a refused draft is said beside the team in plain words, the team column opens for it, the plan stays, and the next edit clears it', async () => {
    serve({ start: refuseOnce(REFUSED) });
    const user = userEvent.setup();
    render(<FightView box={box()} />);
    await startWith(user, 'Starly');
    const team = await waitFor(() => teamColumn());
    expect(await within(team).findByRole('alert')).toHaveTextContent('The fight did not start. Starly: HP must be a whole number from 1 to 38, not 0');
    expect(screen.getByRole('heading', { name: 'Battle plan · vs Youngster Tristan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Work out this turn' })).toBeInTheDocument();
    expect(within(screen.getByRole('tabpanel', { name: 'Fight' })).queryByRole('alert')).toBeNull();   // not said in the fight too
    await user.click(screen.getByRole('button', { name: 'Edit Starly' }));
    expect(within(team).getByRole('alert')).toBeInTheDocument();                                    // opening the editor is no edit
    await user.click(screen.getByRole('button', { name: '1 HP' }));
    expect(within(team).queryByRole('alert')).toBeNull();
  });

  it('a refused draft goes when another fight opens', async () => {
    serve({ start: refuseOnce(REFUSED) });
    const user = userEvent.setup();
    render(<FightView box={box()} />);
    await startWith(user, 'Starly');
    expect(await within(await waitFor(() => teamColumn())).findByRole('alert')).toBeInTheDocument();
    await pickTrainer(user, 'Leader Roark');
    expect(await screen.findByRole('region', { name: 'Leader Roark' })).toBeInTheDocument();
    expect(within(teamColumn()).queryByRole('alert')).toBeNull();
  });

  // A copy changed and changed back on Matchups must not leave the pickup skipped, or "Start with X" would replace the plan.
  it('a kept plan is picked up when the Fight tab shows its copy again, after the copy was changed and changed back on Matchups', async () => {
    keepRoarkPlan(1);
    const t = serve();
    const user = userEvent.setup();
    render(<FightView box={box()} />);
    await pickTrainer(user, 'Leader Roark');
    const fight = () => screen.getByRole('tabpanel', { name: 'Fight' });
    expect(await within(fight()).findByRole('heading', { name: 'Battle plan · vs Leader Roark' })).toBeInTheDocument();
    await matchups(user);
    const copy = screen.getByRole('combobox', { name: 'Trainer copy' });
    await user.selectOptions(copy, 'Copy 2');
    await user.selectOptions(copy, 'Copy 1 (default)');
    await user.click(screen.getByRole('tab', { name: 'Fight' }));
    expect(await within(fight()).findByRole('heading', { name: 'Battle plan · vs Leader Roark' })).toBeInTheDocument();
    expect(within(fight()).queryByRole('button', { name: /^Start with/ })).toBeNull();
    await waitFor(() => expect(t.stepCalls()).toHaveLength(2));                                      // opened, then picked up again
    expect(t.stepCalls()[1]!.team[0]).toBe('party:2');
  });

  it('the trainers failing to load is said, and nothing else breaks', async () => {
    serve({ trainers: { status: 500, json: { error: 'boom' } } });
    render(<FightView box={box()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The trainers did not load. boom');
    expect(within(teamColumn()).getAllByRole('listitem')).toHaveLength(2);
  });

  describe('the sheet', () => {
    it('an older sheet that answers late is dropped: the last body wins', async () => {
      const sheets = holdAnswers();
      const { sheetCalls } = serve({ sheet: sheets.route });
      const user = userEvent.setup();
      render(<FightView box={box()} />);
      await matchups(user);
      const [first, older, last] = ['Asked for party:1 then party:2, Blaze at save HP', 'Asked for party:2 then party:1, Blaze at save HP', 'Asked for party:2 then party:1, Blaze at 44 HP'];
      await waitFor(() => expect(sheets.held).toHaveLength(1));
      act(() => sheets.held[0]!.answer(notedRoute(sheets.held[0]!.call)));
      await waitFor(() => expect(sheetPanel()).toHaveTextContent(first));
      await user.click(teamItem('Starly', 'Move Starly up'));
      await waitFor(() => expect(sheets.held).toHaveLength(2));
      await user.click(screen.getByRole('button', { name: 'All to full HP' }));
      await waitFor(() => expect(sheets.held).toHaveLength(3));
      expect(sheets.held[1]!.call.signal!.aborted).toBe(true);
      act(() => sheets.held[1]!.answer(notedRoute(sheets.held[1]!.call)));           // late, and for an older body
      await settle();
      expect(within(sheetPanel()).getByText('Working out the matchups…')).toBeInTheDocument();
      expect(sheetPanel()).toHaveTextContent(first);
      expect(sheetPanel()).not.toHaveTextContent(older);
      act(() => sheets.held[2]!.answer(notedRoute(sheets.held[2]!.call)));
      await waitFor(() => expect(within(sheetPanel()).queryByText('Working out the matchups…')).toBeNull());
      expect(sheetPanel()).toHaveTextContent(last);
      for (const gone of [first, older]) expect(sheetPanel()).not.toHaveTextContent(gone);
      expect(sheetCalls()).toHaveLength(3);
    });

    it('a draft the server refuses is said in the team column\'s words, with no sheet under it; the next edit asks again', async () => {
      let refuse = true;
      const { sheetCalls } = serve({ sheet: (call) => (refuse ? { status: 400, json: { error: REFUSAL } } : sheetRoute(call)) });
      const user = userEvent.setup();
      render(<FightView box={box()} />);
      await matchups(user);
      const alert = await within(sheetPanel()).findByRole('alert');
      expect(alert.textContent).toBe(`Matchups can't use this team. ${problemText(box(), REFUSAL)}`);
      expect(alert).toHaveTextContent('Blaze (Monferno): EXP must fit level 15');
      expect(within(sheetPanel()).queryByRole('region', { name: /Starly Lv 5/ })).toBeNull();
      refuse = false;
      await user.click(teamItem('Starly', 'Move Starly up'));
      expect(await within(sheetPanel()).findByRole('region', { name: /Starly Lv 5/ })).toBeInTheDocument();
      expect(sheetCalls()).toHaveLength(2);
    });

    it("a sheet that fails for another reason: the Fight tab says their Pokémon did not load, Matchups gives the server's words", async () => {
      serve({ sheet: { status: 500, json: { error: 'The save did not read' } } });
      const user = userEvent.setup();
      render(<FightView box={box()} />);
      const fight = await screen.findByRole('tabpanel', { name: 'Fight' });
      expect(await within(fight).findByText('Their Pokémon did not load.')).toBeInTheDocument();
      expect(within(fight).getByRole('region', { name: 'Their Pokémon' })).not.toHaveTextContent('Loading');
      await matchups(user);
      expect((await within(sheetPanel()).findByRole('alert')).textContent).toBe('The matchups did not load. The save did not read');
      expect(within(sheetPanel()).queryByRole('region', { name: /Starly Lv 5/ })).toBeNull();
    });
  });

  describe("the trainer AI's odds on the sheet", () => {
    it("are asked for with the sheet's own body once it is in, and again after an edit", async () => {
      const sheets = holdAnswers();
      const { aiCalls, sheetCalls } = serve({ sheet: sheets.route });
      const user = userEvent.setup();
      render(<FightView box={box()} />);
      await matchups(user);
      await waitFor(() => expect(sheets.held).toHaveLength(1));
      await settle();
      expect(aiCalls()).toHaveLength(0);                        // not before the sheet is in
      act(() => sheets.held[0]!.answer(sheetRoute(sheets.held[0]!.call)));
      await waitFor(() => expect(aiCalls()).toHaveLength(1));
      expect(aiCalls()[0]!.body).toEqual(sheetCalls()[0]);
      expect(await within(sheetPanel()).findByText(/the trainer AI's odds in each situation shown, not a proof/)).toBeInTheDocument();
      await waitFor(() => expect(pairRow(BLAZE)).toHaveTextContent('AI picks: Tackle 62.5% · Growl 37.5%'));
      expect(pairRow(BLAZE)).toHaveTextContent('If it faints: nothing left to send in');
      expect(within(pairRow(STARLY)).getByTitle('5/8')).toHaveTextContent('Tackle 62.5%');
      expect(within(pairRow(STARLY)).getByTitle('3/8')).toHaveTextContent('Growl 37.5%');
      await user.click(screen.getByRole('button', { name: 'All to full HP' }));
      await waitFor(() => expect(sheets.held).toHaveLength(2));
      act(() => sheets.held[1]!.answer(sheetRoute(sheets.held[1]!.call)));
      await waitFor(() => expect(aiCalls()).toHaveLength(2));
      expect(aiCalls()[1]!.body).toEqual(sheetCalls()[1]);
      expect(sheetCalls()[1]).toMatchObject({ draft: [{ ref: 'party:1', hp: 44 }, { ref: 'party:2' }] });
    });

    it('fill each pair row as its odds arrive, the others "Working out the AI…", and clear the status line at `done`', async () => {
      const ai = liveAi();
      serve({ ai: ai.route });
      const user = userEvent.setup();
      render(<FightView box={box()} />);
      await matchups(user);
      await waitFor(() => expect(ai.streams).toHaveLength(1));
      const { live } = ai.streams[0]!;
      for (const row of [BLAZE, STARLY]) expect(pairRow(row)).toHaveTextContent('Working out the AI…');
      act(() => { live.send('start', aiStart()); live.send('pair', aiPair('party:1', 'Ember')); });
      await waitFor(() => expect(pairRow(BLAZE)).toHaveTextContent('AI picks: Ember 62.5% · Growl 37.5%'));
      expect(pairRow(STARLY)).toHaveTextContent('Working out the AI…');
      expect(pairRow(STARLY)).not.toHaveTextContent('AI picks:');
      act(() => live.send('pair', aiPair('party:2', 'Tackle')));
      await waitFor(() => expect(pairRow(STARLY)).toHaveTextContent('AI picks: Tackle 62.5% · Growl 37.5%'));
      expect(aiStatus()).toHaveTextContent('Working out the AI…');   // every pair is in, but the stream is not done yet
      act(() => { live.send('done', {}); live.close(); });
      await waitFor(() => expect(aiStatus()?.textContent).toBe(''));
      expect(within(sheetPanel()).queryByText('Working out the AI…')).toBeNull();
      expect(pairRow(STARLY)).toHaveTextContent('If it faints: nothing left to send in');
    });

    it('an edit while the odds stream aborts that stream at once, asks for the new sheet once, and streams again with the new body', async () => {
      const ai = liveAi();
      const { sheetCalls } = serve({ ai: ai.route });
      const user = userEvent.setup();
      render(<FightView box={box()} />);
      await matchups(user);
      await waitFor(() => expect(ai.streams).toHaveLength(1));
      act(() => { ai.streams[0]!.live.send('start', aiStart()); ai.streams[0]!.live.send('pair', aiPair('party:1', 'Tackle')); });
      await user.click(teamItem('Starly', 'Move Starly up'));
      await user.click(screen.getByRole('button', { name: 'All to full HP' }));      // two changes inside the pause
      expect(ai.streams[0]!.call.signal!.aborted).toBe(true);                        // at once, with no new stream or sheet yet
      expect([ai.streams.length, sheetCalls().length]).toEqual([1, 1]);
      await waitFor(() => expect(ai.streams).toHaveLength(2));
      expect(sheetCalls()).toHaveLength(2);                                          // one request for both changes
      expect(ai.streams[1]!.call.body).toEqual(sheetCalls()[1]);
      act(() => { ai.streams[1]!.live.send('start', aiStart()); ai.streams[1]!.live.send('pair', aiPair('party:1', 'Growl')); });
      await waitFor(() => expect(pairRow(BLAZE)).toHaveTextContent('AI picks: Growl 62.5%'));
      expect(sheetPanel()).not.toHaveTextContent('AI picks: Tackle');
    });

    it('a newer fight drops the older answer and aborts its stream; leaving the fight view aborts the latest', async () => {
      const ai = holdAnswers();
      serve({ ai: ai.route });
      const user = userEvent.setup();
      const { unmount } = render(<FightView box={box()} />);
      await matchups(user);
      await waitFor(() => expect(ai.held).toHaveLength(1));
      await pickTrainer(user, 'Leader Roark');
      await matchups(user);
      await within(sheetPanel()).findByRole('region', { name: 'Starly Lv 5' });   // Roark's
      await waitFor(() => expect(ai.held).toHaveLength(2));
      expect((ai.held[1]!.call.body as SheetRequestJson).trainer).toBe(ROARK);
      expect([ai.held[0]!.call.signal?.aborted, ai.held[1]!.call.signal?.aborted]).toEqual([true, false]);
      ai.held[1]!.answer(aiStream('Rock Throw'));
      await waitFor(() => expect(pairRow(STARLY)).toHaveTextContent('AI picks: Rock Throw 62.5%'));
      ai.held[0]!.answer(aiStream('Tackle'));                    // Tristan's stream, late
      await settle();
      expect(sheetPanel()).not.toHaveTextContent('Tackle 62.5%');
      await pickTrainer(user, 'Youngster Tristan');
      await matchups(user);
      await waitFor(() => expect(ai.held).toHaveLength(3));
      expect(ai.held[2]!.call.signal?.aborted).toBe(false);
      unmount();
      expect(ai.held[2]!.call.signal?.aborted).toBe(true);
    });

    it('a newer team drops the older answers', async () => {
      const ai = holdAnswers();
      const { aiCalls } = serve({ ai: ai.route });
      const user = userEvent.setup();
      render(<FightView box={box()} />);
      await matchups(user);
      await waitFor(() => expect(ai.held).toHaveLength(1));
      await user.click(teamItem('Starly', 'Move Starly up'));
      await waitFor(() => expect((aiCalls().at(-1)!.body as SheetRequestJson).team).toEqual(['party:2', 'party:1']));
      const [latest, ...older] = [...ai.held].reverse();
      expect(older.length).toBeGreaterThan(0);
      expect(older.every(({ call }) => call.signal?.aborted)).toBe(true);
      for (const { answer } of older) answer(aiStream('Tackle'));
      await settle();
      expect(sheetPanel()).not.toHaveTextContent('AI picks:');
      expect(pairRow(STARLY)).toHaveTextContent('Working out the AI…');
      latest!.answer(aiStream('Quick Attack'));
      await waitFor(() => expect(pairRow(STARLY)).toHaveTextContent('AI picks: Quick Attack 62.5%'));
      expect(sheetPanel()).not.toHaveTextContent('Tackle 62.5%');
    });

    it("closes a stream whose start is another save's than the sheet's, and shows the one for the sheet of the save the box moves to", async () => {
      const ai = holdAnswers();
      let savedAt = box().savedAt;                                 // the save the server reads the sheet from
      serve({ ai: ai.route, sheet: (call) => sheetRoute(call, savedAt) });
      const user = userEvent.setup();
      const { rerender } = render(<FightView box={box()} />);
      await matchups(user);
      await waitFor(() => expect(ai.held).toHaveLength(1));
      ai.held[0]!.answer(aiStream('Tackle', LATER));               // the server has read a newer save than the sheet's
      await settle();
      expect(ai.held[0]!.call.signal?.aborted).toBe(true);
      expect(sheetPanel()).not.toHaveTextContent(/AI picks:|The AI odds did not load/);
      for (const row of [BLAZE, STARLY]) expect(pairRow(row)).toHaveTextContent('Working out the AI…');
      savedAt = LATER;
      rerender(<FightView box={box({ savedAt: LATER })} />);
      await waitFor(() => expect(ai.held).toHaveLength(2));        // the sheet is read again for the new save, then the AI
      ai.held[1]!.answer(aiStream('Quick Attack', LATER));
      await waitFor(() => expect(pairRow(STARLY)).toHaveTextContent('AI picks: Quick Attack 62.5%'));
    });

    it("drops an answer for the box's new save while the sheet shown is still the old save's", async () => {
      const sheets = holdAnswers();
      const ai = holdAnswers();
      serve({ sheet: sheets.route, ai: ai.route });
      const user = userEvent.setup();
      const { rerender } = render(<FightView box={box()} />);
      await matchups(user);
      await waitFor(() => expect(sheets.held).toHaveLength(1));
      act(() => sheets.held[0]!.answer(sheetRoute(sheets.held[0]!.call)));   // the sheet of save A
      await waitFor(() => expect(ai.held).toHaveLength(1));
      rerender(<FightView box={box({ savedAt: LATER })} />);                 // the box moves to save B: its sheet loads
      await waitFor(() => expect(sheets.held).toHaveLength(2));
      act(() => ai.held[0]!.answer(aiStream('Tackle', LATER)));             // save A's stream, read from save B
      await settle();
      expect(within(sheetPanel()).getByRole('region', { name: 'Starly Lv 5' })).toBeInTheDocument();
      expect(sheetPanel()).not.toHaveTextContent('AI picks:');
      expect(pairRow(STARLY)).toHaveTextContent('Working out the AI…');
    });

    it.each<[string, Route, string]>([
      ['a failed request', { status: 500, json: { error: 'The AI batch failed' } }, 'The AI batch failed'],
      ['an `error` event', { events: [['error', { error: 'The AI data did not load' }]] }, 'The AI data did not load'],
      ['an `error` after a pair has shown', { events: [['start', aiStart()], ['pair', aiPair('party:1', 'Ember')], ['error', { error: 'The AI batch stopped' }]] }, 'The AI batch stopped'],
      ["a pair before the stream's start", { events: [['pair', aiPair('party:1', 'Ember')], ['start', aiStart()], ['done', {}]] },
        'Unexpected answer from the planner server (HTTP 200): a pair before the start event'],
    ])('%s says the odds did not load in one line, and the sheet stays without any reply', async (_, route, error) => {
      serve({ ai: route });
      const user = userEvent.setup();
      render(<FightView box={box()} />);
      await matchups(user);
      expect(await within(sheetPanel()).findByText(`The AI odds did not load: ${error}`)).toBeInTheDocument();
      expect(within(sheetPanel()).getAllByText(/The AI odds did not load/)).toHaveLength(1);
      expect(sheetPanel()).not.toHaveTextContent(/AI picks:|Working out the AI|The matchups did not load/);
      expect(pairRow(STARLY)).toHaveTextContent('Starly moves first');
      expect(pairRow(BLAZE).querySelector('.matchup-reply')).toBeNull();
    });

    it('Try again asks again: a second failure keeps the alert and the button with the new message, a success shows the odds', async () => {
      let n = 0;
      const { aiCalls } = serve({ ai: () => (n++ < 2 ? { status: 500, json: { error: n === 1 ? 'First failure' : 'Second failure' } } : aiStream('Tackle')) });
      const user = userEvent.setup();
      render(<FightView box={box()} />);
      await matchups(user);
      expect(await within(sheetPanel()).findByRole('alert')).toHaveTextContent('The AI odds did not load: First failure');
      await user.click(within(sheetPanel()).getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(within(sheetPanel()).getByRole('alert')).toHaveTextContent('The AI odds did not load: Second failure'));
      await user.click(within(sheetPanel()).getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(pairRow(STARLY)).toHaveTextContent('AI picks: Tackle'));
      expect(aiCalls()).toHaveLength(3);
      expect(within(sheetPanel()).queryByRole('alert')).toBeNull();
      expect(within(sheetPanel()).queryByRole('button', { name: 'Try again' })).toBeNull();
    });

    it('a retry asks for the current sheet only', async () => {
      const sheets = holdAnswers();
      const ai = holdAnswers();
      let n = 0;
      const { aiCalls, sheetCalls } = serve({ sheet: sheets.route, ai: (call) => (n++ === 0 ? { status: 500, json: { error: 'The AI batch failed' } } : ai.route(call)) });
      const user = userEvent.setup();
      render(<FightView box={box()} />);
      await matchups(user);
      await waitFor(() => expect(sheets.held).toHaveLength(1));
      act(() => sheets.held[0]!.answer(sheetRoute(sheets.held[0]!.call)));
      expect(await within(sheetPanel()).findByRole('alert')).toHaveTextContent('The AI batch failed');
      await user.click(teamItem('Starly', 'Move Starly up'));   // a new sheet, still loading
      await waitFor(() => expect(sheets.held).toHaveLength(2));
      await user.click(within(sheetPanel()).getByRole('button', { name: 'Try again' }));
      await settle();
      expect(ai.held).toHaveLength(0);                                             // no stream for the old sheet
      act(() => sheets.held[1]!.answer(sheetRoute(sheets.held[1]!.call)));
      await waitFor(() => expect(ai.held).toHaveLength(1));
      expect(aiCalls().at(-1)!.body).toEqual(sheetCalls()[1]);
      expect((aiCalls().at(-1)!.body as SheetRequestJson).team).toEqual(['party:2', 'party:1']);
      ai.held[0]!.answer(aiStream('Growl'));
      await waitFor(() => expect(pairRow(STARLY)).toHaveTextContent('AI picks: Growl'));
    });
  });
});

describe('MatchupsView and FightHeader', () => {
  const view = (sheet: SheetJson | null, error: string | null, b: ReturnType<typeof box> | null) => (
    <MatchupsView state={{ sheet, query: null, loading: false, error }} ai={{ state: 'pending', pairs: [] }} onRetry={vi.fn()}
      fight={{ trainerId: TRISTAN, variant: 0 }} teamEmpty={false} box={b} />
  );

  it("a refused draft with no save on screen gives the server's words as they are", () => {
    render(view(null, REFUSAL, null));
    expect(screen.getByRole('alert').textContent).toBe(`Matchups can't use this team. ${REFUSAL}`);
  });

  it("marks a Pokémon over the save's level cap in its pairs, with the team column's words", () => {
    const sheet = sheetOf(TRISTAN);
    render(view({ ...sheet, players: sheet.players.map((mon) => (mon.key === 'party:1' ? { ...mon, level: box().levelCap + 1 } : mon)) }, null, box()));
    const pair = (name: RegExp) => screen.getByRole('heading', { level: 4, name }).closest('li')!;
    expect(pair(BLAZE)).toHaveTextContent(`over the level cap (${box().levelCap})`);
    expect(pair(STARLY)).not.toHaveTextContent('over the level cap');
  });

  it('a trainer the docs mark female is named with the class plain and ♀ after the name', () => {
    render(<FightHeader titleId="fight-title" trainer={{ ...trainerById(TRISTAN), name: 'GalacticfTerra' }} trainerId={TRISTAN} variant={0} onVariant={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Galactic Terra ♀');
  });
});
