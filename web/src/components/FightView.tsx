// The fight page, built around the run. At the top, the next fights (NextFights): the shown split's trainers as
// one strip, and the search over every trainer. Under it, the team column (TeamPanel: the stored team, the save's party at
// first) beside the open fight: one bar holding its header (FightHeader: the trainer and the copy) and the Fight / Matchups
// tabs, then two views kept mounted, Fight
// (the plan screen, PlanView) and Matchups (MatchupsView: the sheet and the trainer AI's odds). A double cannot be built
// yet: it shows Matchups only, and says so.
//
// Which fight is open: on load, the trainer the cursor names (run.ts: the one last clicked, per
// save), else the split's first single battle. Opening by itself never moves the cursor; a click does, and only for a
// trainer of the run's split or of `run.alsoPossible`, so a trainer found by search in another split opens without moving
// it. "Up next" marks the single battle after the open fight; while a trainer from outside the strip is open, after the
// run's position instead (the trainer the page would open by itself).
//
// Matchups and the plan both use the whole team as drafted, in order, each Pokémon with its edits (over the level cap
// included), so each starts on the HP the team shows ("All to full HP" in the team column heals them all); the plan
// follows an edit at once. A turn the server refuses for its draft is said in the team column, in words, until
// another fight opens or the team changes. A sheet it refuses is said in Matchups.
//
// While a plan is on the Fight tab, the page is `is-planning` and the team column (TeamPanel, the draft
// editor) is put away behind "Edit team" (`teamOpen`), still mounted so the editor keeps its state; it is shut when a plan
// arrives, and opened by a refused draft, so its words show.
//
// The fight section (`.fight-main`, open fight or not) is `#fight`, which the page's skip link focuses (App.tsx, design
// pass 1.8): it takes focus from code only.

import { useEffect, useId, useMemo, useState, type JSX } from 'react';
import type { BoxJson, DraftMonJson, TrainerSummaryJson } from '../../../src/server/apiTypes';
import { useAiOdds } from '../aiOdds';
import { errorMessage, getTrainers } from '../api';
import { problemText } from '../draft';
import { beatenIds, type Cursor, nextFight, openFight, readCursor, shownSplit, splitFights, writeCursor } from '../run';
import { useDraft } from '../useDraft';
import { useSheet, useSheetAi } from '../useSheet';
import { ErrorBoundary } from './ErrorBoundary';
import { FightHeader } from './fight/FightHeader';
import { Tabs, tabIds } from './fight/Tabs';
import { MatchupsView } from './MatchupsView';
import { NextFights } from './NextFights';
import { PlanView } from './PlanView';
import { TeamPanel } from './TeamPanel';
import { TrainerSearch } from './TrainerSearch';

type View = 'fight' | 'matchups';
type Catalog = { list: TrainerSummaryJson[] | null; byId: ReadonlyMap<string, TrainerSummaryJson> | null; error: string | null };

const VIEWS: [View, string][] = [['fight', 'Fight'], ['matchups', 'Matchups']];

export function FightView({ box, boxProblem = null }: {
  box: BoxJson | null;
  /** Why the box could not be had (the save did not read), shown where the box would be needed; null while it is fine. */
  boxProblem?: string | null;
}): JSX.Element {
  const titleId = useId();
  const ids = tabIds(useId());
  const catalog = useCatalog();
  const draft = useDraft(box);
  const [picked, setPicked] = useState<string | null>(null);
  const [chosen, setChosen] = useState<{ trainerId: string; variant: number } | null>(null);
  const [view, setView] = useState<View>('fight');

  // The cursor of the save on screen, read again during the render that brings another save (as useDraft does).
  const savePath = box?.savePath ?? null;
  const [kept, setKept] = useState<{ savePath: string | null; cursor: Cursor | null }>(() => ({ savePath, cursor: savePath === null ? null : readCursor(savePath) }));
  let cursor = kept.cursor;
  if (kept.savePath !== savePath) {
    cursor = savePath === null ? null : readCursor(savePath);
    setKept({ savePath, cursor });
  }
  const keepCursor = (next: Cursor) => {
    if (box === null) return;
    writeCursor(box.savePath, next);
    setKept({ savePath: box.savePath, cursor: next });
  };

  const run = box?.run ?? null;
  // A save that moves the next fight on (another save, a new win) takes the strip back to it: a click's pick no longer holds.
  const nextKey = run?.next ?? null;
  const [seenNext, setSeenNext] = useState<string | null>(nextKey);
  if (seenNext !== nextKey) {
    setSeenNext(nextKey);
    setPicked(null);
  }
  const split = run === null ? null : shownSplit(run, cursor);
  const splits = run === null ? [] : [run.split, ...run.alsoPossible];
  const fights = useMemo(() => (catalog.list === null || split === null ? null : splitFights(catalog.list, split)), [catalog.list, split]);
  const openId = picked ?? (fights === null ? null : (openFight(fights, cursor, run?.next ?? null)?.id ?? null));
  const trainer = openId === null ? undefined : catalog.byId?.get(openId);
  const openInSplit = fights?.some((t) => t.id === openId) ?? false;
  const runAt = openInSplit ? openId : fights === null ? null : (openFight(fights, cursor, run?.next ?? null)?.id ?? null);
  const nextId = fights === null ? null : (nextFight(fights, runAt)?.id ?? null);
  const variant = chosen !== null && chosen.trainerId === openId ? chosen.variant : 0;
  const fight = useMemo(() => (trainer === undefined ? null : { trainerId: trainer.id, variant }), [trainer, variant]);

  // A start the server refused for its draft: its words, with the fight and the team's entries they were said for. Another
  // fight or a change to the team takes them away (set during the render, as the cursor is).
  const fightKey = fight === null ? '' : `${fight.trainerId}|${fight.variant}`;
  const [startProblem, setStartProblem] = useState<{ message: string; fight: string; mons: DraftMonJson[] } | null>(null);
  if (startProblem !== null && (startProblem.fight !== fightKey || startProblem.mons !== draft.mons)) setStartProblem(null);
  // A refused draft opens the team column while a plan has it put away, so the words beside the team show.
  const onDraftProblem = (message: string | null) => {
    setStartProblem(message === null ? null : { message, fight: fightKey, mons: draft.mons });
    if (message !== null) setTeamOpen(true);
  };

  // Whether a plan is on the page (PlanView says so), with the fight it was said for: another fight takes it away (set
  // during the render, as the start problem is), and PlanView says it again for the new fight, so a plan kept for that one
  // keeps the page planning. The team column is put away each time a plan arrives.
  const [planningFight, setPlanningFight] = useState<string | null>(null);
  if (planningFight !== null && planningFight !== fightKey) setPlanningFight(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const onPlanning = (on: boolean) => {
    setPlanningFight(on ? fightKey : null);
    if (on) setTeamOpen(false);
  };
  const planningHere = planningFight !== null && planningFight === fightKey && view === 'fight' && trainer?.battleType !== 'double';

  // Matchups: the whole team as drafted, in order.
  const sheet = useSheet(fight, draft.mons, box);
  // At the off AI odds level (aiOdds.ts) the page asks for no AI odds, and the pairs have no Their reply.
  const aiOdds = useAiOdds();
  const { ai, retry } = useSheetAi(sheet, aiOdds !== 'off');

  function pick(t: TrainerSummaryJson) {
    setPicked(t.id);
    setChosen(null);
    setView(t.battleType === 'double' ? 'matchups' : 'fight');
    if (splits.includes(t.split)) keepCursor({ split: t.split, trainerId: t.id });
  }

  function pickSplit(s: string) {
    setPicked(null);
    setChosen(null);
    keepCursor({ split: s, trainerId: openFight(splitFights(catalog.list ?? [], s), null, s === run?.split ? run.next : null)?.id ?? '' });
  }

  const matchups = fight !== null && (
    <MatchupsView state={sheet} ai={aiOdds === 'off' ? undefined : ai} onRetry={retry} fight={fight} teamEmpty={draft.team.length === 0} box={box} />
  );

  return (
    <div className="fight-page">
      {split === null ? (
        <RunWaiting openId={openId} onPick={pick} />
      ) : (
        <NextFights
          fights={fights ?? (catalog.error === null ? null : [])} split={split} splits={splits} openId={openId} nextId={nextId}
          beaten={run === null ? [] : beatenIds(run, split)}
          onPick={pick} onSplit={pickSplit}
        />
      )}
      <div className={planningHere ? 'fight is-planning' : 'fight'}>
        <div className="fight-team" hidden={planningHere && !teamOpen}>
          <TeamPanel
            box={box} boxProblem={boxProblem} draft={draft}
            problem={startProblem === null || box === null ? null : problemText(box, startProblem.message)}
          />
        </div>
        {trainer === undefined || fight === null ? (
          <div className="fight-main" id="fight" tabIndex={-1}>
            {catalog.error !== null ? (
              <p className="banner banner-danger" role="alert"><strong>The trainers did not load.</strong> {catalog.error}</p>
            ) : catalog.list === null ? (
              <p className="app-loading">Loading the trainers…</p>
            ) : (
              <div className="empty-state">
                <h2>No fight is open</h2>
                <p>Search for a trainer above.</p>
              </div>
            )}
          </div>
        ) : (
          <section className="fight-main" id="fight" tabIndex={-1} aria-labelledby={titleId}>
            {/* One bar: the trainer on the left, the Fight / Matchups tabs on the right (a double has no tabs). */}
            <div className="fight-bar">
              <FightHeader
                titleId={titleId} trainer={trainer} trainerId={trainer.id} variant={variant}
                onVariant={(next) => setChosen({ trainerId: trainer.id, variant: next })}
              />
              {trainer.battleType !== 'double' && <Tabs<View> label="Fight or matchups" tabs={VIEWS} value={view} onChange={setView} ids={ids} />}
            </div>
            {trainer.battleType === 'double' ? (
              <>
                <p className="fight-note">{"Double battle: can't be built yet. Matchups still work."}</p>
                <div className="fight-panel">{matchups}</div>
              </>
            ) : (
              <>
                <div role="tabpanel" id={ids.panel('fight')} aria-labelledby={ids.tab('fight')} hidden={view !== 'fight'} className="fight-panel">
                  <ErrorBoundary resetKey={fight}>
                    <PlanView
                      fight={fight} trainer={trainer} sheet={sheet.sheet} sheetError={sheet.error} box={box} team={draft.team} draft={draft.mons} options={draft.options}
                      active={view === 'fight'} onDraftProblem={onDraftProblem} onPlanning={onPlanning}
                      onAddToTeam={draft.add} teamDraft={draft} teamOpen={teamOpen} onToggleTeam={() => setTeamOpen((open) => !open)}
                    />
                  </ErrorBoundary>
                </div>
                <div role="tabpanel" id={ids.panel('matchups')} aria-labelledby={ids.tab('matchups')} hidden={view !== 'matchups'} className="fight-panel">
                  {matchups}
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/** The next fights' place while there is no save to read the run from: the search over every trainer still works. */
function RunWaiting({ openId, onPick }: { openId: string | null; onPick(trainer: TrainerSummaryJson): void }) {
  return (
    <section className="run" aria-label="Next fights">
      <div className="run-head">
        <h2 className="run-heading">Next fights</h2>
      </div>
      <p className="run-none">The fights show once the save reads.</p>
      <TrainerSearch openId={openId} onPick={onPick} />
    </section>
  );
}

/** Every trainer, once, and by ID. */
function useCatalog(): Catalog {
  const [list, setList] = useState<TrainerSummaryJson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getTrainers().then((trainers) => { if (live) setList(trainers); }, (e: unknown) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, []);
  const byId = useMemo(() => (list === null ? null : new Map(list.map((t) => [t.id, t]))), [list]);
  return { list, byId, error };
}
