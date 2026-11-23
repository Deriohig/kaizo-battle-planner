// The plan screen: the Fight view of the fight page. The player writes the fight as a
// plan, one step per turn, with no outcomes: HP never changes and nothing here works out what happens next. The numbers
// for the turn under the cursor come from the plan's one request (`usePlan`).
//
// No plan on the page: the start screen, whose "Start with X" begins one with X as the lead and the team in its order,
// once the sheet is in (the trainer's Pokémon are named from it). A plan on the page: its heading, how many of
// theirs are marked fainted and a chip per turn; then the turn, with what is worked out, its head ("Turn n", "Your
// action"), the choices and their reply over the answer (or, while new numbers are worked out, the last ones shown on this
// turn, `stale`), what the numbers leave out (one muted line), a send-out the AI cannot decide in the server's
// words, and "Work out this turn" when nothing is held for it and nothing runs. The head holds who moves first in one
// line, and the exchange (`SplitRows`, the turn's hero) comes straight under it. "Your action" is the two cards
// with their marks, his choices between them and their send-in picker (`TurnAction`), then the turn's note and the way on
// (`TurnFoot`). The field row sits in the right column.
//
// Another fight takes the plan off the page (`reset`, which also drops any Undo held for the last one), and that fight's
// kept plan is picked up when the view shows it, with no focus move. The plan follows the team and the save at once:
// each time the pool as it is now differs from the plan's, or the save does, it is handed to `setMons`.
//
// Focus: each arrival (a start, a jump, an opened plan, Undo) moves focus once to "Your action". Stop, Try
// again and Work out this turn go as they are pressed: focus that fell to the page body goes to the same heading. A
// control in the saved plans that goes with its click (Delete, Keep it, a removal) leaves focus on a heading (`dropping`). The one status region (spec
// 0.6) says each arrival once the turn's numbers are in (or its request has ended without them), a notice, "Still working
// out turn n." once slow, and a cleared plan (`hear`).

import { type JSX, useEffect, useEffectEvent, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  BoxJson, DraftMonJson, DraftOptionsJson, MonRef, SheetJson, TrainerSummaryJson,
} from '../../../src/server/apiTypes';
import { useAiOdds } from '../aiOdds';
import type { PlanStepFn } from '../api';
import { canJoin } from '../draft';
import { trainerName } from '../labels';
import { sameSave, saveOf } from '../line';
import { readCurrentPlan, type SavedPlan } from '../planStore';
import { likeliestMove } from '../tree';
import type { UseDraft } from '../useDraft';
import { deleteCopy, dropUnreadable, readCopies, savedProblemText, usePlan } from '../usePlan';
import { busyProps } from './busy';
import { InfoTip } from './InfoTip';
import { OpponentCard } from './plan/OpponentCard';
import { spriteSpecies } from './plan/MonToken';
import { BoxAndTeam, FieldRow, TheirReply } from './plan/parts';
import { PlanToolbar } from './plan/PlanToolbar';
import {
  clearedText, type Heard, hear, markedMine, markedTheirs, orderLine, planMonOf, planWorkingText, poolDiffers, poolNow, shownMine, shownTheirs,
  startOf, turnSaid,
} from './plan/planScreen';
import { SavedPlans, UnreadablePlans } from './plan/SavedPlans';
import { SplitRows } from './plan/SplitRows';
import { WholePlan } from './plan/WholePlan';
import { TurnAction } from './plan/TurnAction';
import { TurnChips } from './plan/TurnChips';
import { TurnFoot } from './plan/TurnFoot';
import { ServerWords } from './ServerWords';
import { StartScreen } from './start/StartScreen';

export interface PlanViewProps {
  fight: { trainerId: string; variant: number } | null;
  trainer: TrainerSummaryJson | undefined;
  sheet: SheetJson | null; sheetError: string | null;
  box: BoxJson | null;
  team: MonRef[]; draft: DraftMonJson[]; options: DraftOptionsJson | null;
  /** The Fight tab is showing. */
  active: boolean;
  onDraftProblem(message: string | null): void;
  /** A plan is on the page, or stopped being. */
  onPlanning?(on: boolean): void;
  /** FightView: draft.add, for a tried Pokémon's "Add to team". */
  onAddToTeam(ref: MonRef): void;
  /**
   * FightView's draft (`useDraft`), for the box and team column: each drop or reorder is one change (`place`, `moveTo`),
   * which keeps every member's entry (its HP, level, moves and item) as it was.
   */
  teamDraft: UseDraft;
  /** "Edit team". */
  teamOpen: boolean; onToggleTeam(): void;
  /** Tests only: passed to usePlan. */
  step?: PlanStepFn;
}

const noop = () => {};

/** Where focus goes when a control in the copies that cannot be read goes (`dropping`): the plan's heading first. */
const HEAD_FIRST: readonly string[] = ['.plan-head h2', '.plan-saved h3'];
/** The same for a control in the saved plans: "Saved plans" first, while any are left. */
const SAVED_FIRST: readonly string[] = ['.plan-saved h3', '.plan-head h2'];

export function PlanView(props: PlanViewProps): JSX.Element {
  const { fight, trainer, sheet, sheetError, box, team, draft, options, active } = props;
  const aiOdds = useAiOdds();
  const plan = usePlan({ step: props.step });
  const { reset, restore, setMons } = plan;
  const key = fight === null ? '' : `${fight.trainerId}|${fight.variant}`;
  /** The fight whose kept plan was last picked up; '' once another fight dropped it, so it is picked up again when shown. */
  const restored = useRef('');
  const name = trainer === undefined ? (fight?.trainerId ?? '') : trainerName(trainer.name);

  // The Pokémon that may be in a plan: those that can join the team (over the level cap included).
  const mons = useMemo(() => new Map(box?.mons.filter(canJoin).map((m) => [m.ref, m]) ?? []), [box]);
  const teamRefs = team.filter((ref) => mons.has(ref));

  const panel = plan.answer ?? plan.stale;
  /**
   * Their move picked in the likelihood list, for the fight, turn and Pokémon of theirs it was picked on (`at`): a pick for
   * any other counts as none (the likeliest shows again).
   */
  /** The plan name box: an opened copy's name, else what the player typed; Save a copy and Clear plan empty it. */
  const [planName, setPlanName] = useState('');
  const [theirPick, setTheirPick] = useState<{ at: string; move: string } | null>(null);
  /**
   * The one status region's words (`hear`), set during the render that brings what it says, as LineView did. An arrival is
   * said once its request has ended (`busy` holds the last seq said), so its sentence carries the numbers that came.
   */
  const [heard, setHeard] = useState<Heard>({ seq: 0, slow: false, notices: [], cleared: null, text: '' });
  /**
   * Words said before the next arrival's sentence, for the arrival after `seq` only: which turn Remove this turn took away,
   * or what an Undo brought back ("Turn 4 restored.", "Plan restored."). Undo puts back what was on the page; it saves nothing new.
   */
  const [said, setSaid] = useState<{ seq: number; words: string } | null>(null);
  const sayNext = (words: string) => setSaid({ seq: plan.arrival?.seq ?? 0, words });
  const nextHeard = hear(
    heard,
    {
      seq: plan.busy ? heard.seq : (plan.arrival?.seq ?? 0), slow: plan.slow, busy: plan.busy,
      notices: plan.notice === null ? [] : [plan.notice], cleared: plan.cleared,
    },
    () => {
      if (plan.current === null) return null;
      const sentence = turnSaid(plan.current, panel);
      return said !== null && plan.arrival?.seq === said.seq + 1 ? `${said.words} ${sentence}` : sentence;
    },
    () => planWorkingText(plan.working?.turn ?? plan.current?.turn ?? 1, true),
  );
  if (nextHeard !== null) setHeard(nextHeard);

  // Another fight: the plan leaves the page (what is kept stays) and any Undo held for it goes, so its kept plan is
  // picked up when the view shows it. `reset`, not a bare `restore`: a refused restore keeps the plan and the hold it had.
  /**
   * The team, draft and box (by identity) a plan kept on another save, or a saved copy of another save, was opened with.
   * While all three are unchanged the plan does not follow them: following goes through `setMons`, which keeps the plan, so
   * merely opening one would rewrite it (and ask again). Dropped once any of them changes, or another fight opens; then the
   * plan follows them again. A plan or saved copy of this very save is not held: draft edits made since are his (his
   * HP is the draft's), so it is compared once as it opens and follows them if they differ (and rewrites nothing if not).
   */
  const opened = useRef<{ team: MonRef[]; draft: DraftMonJson[]; box: BoxJson } | null>(null);
  useEffect(() => {
    reset();
    restored.current = '';
    opened.current = null;
  }, [key, reset]);

  // When the view shows a fight whose kept plan is not picked up yet, it is, with no focus move.
  useEffect(() => {
    if (!active || fight === null || box === null || restored.current === key) return;
    restored.current = key;
    const record = readCurrentPlan(fight.trainerId, fight.variant);
    if (record === null) return;
    opened.current = sameSave(record.save, saveOf(box)) ? null : { team, draft, box };
    void restore(record, box, options);
  }, [active, box, draft, fight, key, options, restore, team]);

  // The plan follows the team, its entries and the save at once. The plan's pool is compared on the Pokémon the
  // pool now has: one `setMons` keeps (an old one a turn still names) is not in it, so the comparison holds after the call.
  // On another save `setMons` finds a Pokémon a turn names by key over the whole box, or names it as gone. A plan of
  // another fight still drawn in the render that brought this one (its reset comes after) is never followed.
  const shown = plan.plan;
  const { save } = plan;
  useEffect(() => {
    if (shown === null || box === null || `${shown.start.trainerId}|${shown.start.variant}` !== key) return;
    const held = opened.current;
    if (held !== null) {
      if (held.team === team && held.draft === draft && held.box === box) return;
      opened.current = null;
    }
    const now = saveOf(box);
    const next = poolNow(shown, team, mons, draft);
    const keys = new Set(next.map((m) => m.key));
    const ours = { ...shown, start: { ...shown.start, mons: shown.start.mons.filter((m) => keys.has(m.key)) } };
    if (poolDiffers(ours, next) || !sameSave(save, now)) void setMons(next, now, box, options);
  }, [shown, save, box, key, team, mons, draft, options, setMons]);

  // A refused draft is said beside the team, and whether a plan is on the page is the page's too: each told as it changes,
  // and again for another fight (FightView keeps "planning" per fight, so a plan kept for the next one is told too).
  const tellDraft = useEffectEvent((message: string | null) => props.onDraftProblem(message));
  useEffect(() => { tellDraft(plan.draftProblem); }, [plan.draftProblem]);
  const planning = shown !== null;
  const tellPlanning = useEffectEvent((on: boolean) => props.onPlanning?.(on));
  useEffect(() => { tellPlanning(planning); }, [planning, key]);

  const root = useRef<HTMLDivElement>(null);
  /** The last arrival focus was moved for: a plan drawn again later (a kept one picked up) moves none. */
  const focused = useRef(0);
  const { arrival } = plan;
  useLayoutEffect(() => {
    if (arrival === null || arrival.seq <= focused.current) return;
    focused.current = arrival.seq;
    root.current?.querySelector<HTMLElement>('[data-focus="turn"]')?.focus();
  }, [arrival]);
  /** Set by Stop and Try again, which go as they are pressed: focus that fell to the body goes to the turn's heading. */
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const now = document.activeElement;
    if (now !== null && now !== document.body && now.isConnected) return;
    root.current?.querySelector<HTMLElement>('[data-focus="turn"]')?.focus();
  });
  /** Set by Clear plan: once the plan has gone, focus goes to "Plan cleared". */
  const clearing = useRef(false);
  const { cleared } = plan;
  useLayoutEffect(() => {
    if (!clearing.current || cleared === null) return;
    clearing.current = false;
    root.current?.querySelector<HTMLElement>('.plan-cleared')?.focus();
  }, [cleared]);
  /**
   * Set by a control that goes with its click, in the saved plans or the copies that cannot be read (a removal, Delete, Keep
   * it): focus that fell to the body goes to the first heading of the list it holds that is on the page, else the start
   * screen's first heading. The copies that cannot be read go to the plan's heading first (`HEAD_FIRST`), the saved plans
   * to "Saved plans" first (`SAVED_FIRST`). `settle` asks for a render, for a click whose own render is only its block's.
   */
  const dropping = useRef<readonly string[] | null>(null);
  const [, settleRender] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    const order = dropping.current;
    if (order === null) return;
    dropping.current = null;
    const now = document.activeElement;
    if (now !== null && now !== document.body && now.isConnected) return;
    const at = root.current;
    const heading = [...order, 'h3'].reduce<HTMLElement | null>((found, sel) => found ?? at?.querySelector<HTMLElement>(sel) ?? null, null);
    if (heading === null) return;
    heading.focus();
  });
  const settle = (order: readonly string[]) => {
    dropping.current = order;
    settleRender();
  };

  // The fight's saved copies while no plan is on the page (the hook reads them only for a plan on it), read again after a
  // Delete or a removal here (`copiesRead`). Unreadable entries are counted, and kept by every write but their own removal.
  const [copiesRead, setCopiesRead] = useState(0);
  const startCopies = useMemo(
    () => (fight === null || shown !== null ? null : readCopies(fight.trainerId, fight.variant)),
    [fight, shown, copiesRead, cleared],   // copiesRead and cleared ask for a fresh read of what is stored
  );

  if (fight === null) return <p className="line-muted">Pick a trainer to plan a fight against.</p>;

  // Nothing starts until this fight's sheet is in, as the trainer's Pokémon are named from it.
  const onLead = (lead: MonRef) => {
    if (sheet === null || box === null || sheet.trainer.id !== fight.trainerId || sheet.trainer.variant !== fight.variant) return;
    const start = startOf(fight, lead, teamRefs, mons, draft, sheet.enemies.map((e) => e.name));
    if (start !== null) void plan.begin(start, saveOf(box));
  };
  const retry = () => {
    refocus.current = true;
    plan.retry();
  };
  const stop = () => {
    refocus.current = true;
    plan.stop();
  };

  const { failure, current } = plan;
  const pickAt = current === null ? null : `${key}|${current.turn}|${current.theirs}`;
  const pickedTheirs = theirPick !== null && theirPick.at === pickAt ? theirPick.move : null;
  const theirShown = shownTheirs(panel, pickedTheirs, aiOdds);
  const mineShown = shownMine(panel, current?.pick ?? null);
  const mineName = shown?.start.mons.find((m) => m.key === current?.mine)?.name ?? 'Your Pokémon';
  const theirName = current?.theirs == null ? 'Their Pokémon' : (shown?.start.enemies[current.theirs] ?? 'Their Pokémon');
  /** Who moves first, one line in the turn's head. */
  const order = panel === null ? null : orderLine(panel.damage, mineName, theirName);
  const mineBox = (() => {
    const ref = shown?.start.mons.find((m) => m.key === current?.mine)?.ref;
    return ref === undefined ? undefined : mons.get(ref);
  })();
  const refOfKey = (k: string | null | undefined) => shown?.start.mons.find((m) => m.key === k)?.ref;
  const mineRef = refOfKey(current?.mine);
  const faintedMine = markedMine(plan.turns).flatMap((k) => refOfKey(k) ?? []);
  /** The sheet when it is this trainer's: `useSheet` keeps the last one until the new one lands. */
  const ownSheet = sheet !== null && sheet.trainer.id === fight.trainerId && sheet.trainer.variant === fight.variant ? sheet : null;
  /** His token in the whole plan: the pool Pokémon of that name as the box has it. */
  const look = (poolName: string) => {
    const ref = shown?.start.mons.find((m) => m.name === poolName)?.ref;
    const m = ref === undefined ? undefined : mons.get(ref);
    return m === undefined ? undefined : { level: m.level, types: m.types, species: spriteSpecies(m) };
  };
  // Remove this turn arrives on the turn before (focus and the status region), and its Undo on the turn it put back.
  const removeTurn = () => {
    if (current !== null) sayNext(`Turn ${current.turn} removed.`);
    void plan.removeLastTurn();
  };
  const undoRemove = () => {
    if (plan.removed !== null) sayNext(`Turn ${plan.removed} restored.`);
    void plan.undo();
  };
  const clearPlan = () => {
    clearing.current = true;
    setPlanName('');
    plan.clear();
  };
  const undoClear = () => {
    sayNext('Plan restored.');
    void plan.undo();
  };
  /** Words for the status region now (Save a copy, Copy plan); the next arrival or change says its own. */
  const say = (text: string) => setHeard((was) => ({ ...was, text }));
  /**
   * A saved copy opened, from the start screen or with a plan on the page: it arrives (focus on the heading), and the plan
   * it replaces goes into Saved plans first, said (`openCopy`). Like a kept plan, one of this save follows the draft once
   * as it opens (`opened` is not held), and one of another save is not rewritten until he acts.
   */
  const openSaved = (copy: SavedPlan) => {
    if (box === null) return;
    restored.current = key;
    opened.current = sameSave(copy.save, saveOf(box)) ? null : { team, draft, box };
    setPlanName(copy.name);
    void plan.openCopy(copy, box, options);
  };
  const deleteSaved = (copyName: string) => {
    dropping.current = SAVED_FIRST;
    if (shown !== null) plan.removeSaved(copyName);
    else {
      deleteCopy(fight.trainerId, fight.variant, copyName);
      setCopiesRead((n) => n + 1);
    }
    say(`Deleted the saved plan ${copyName}.`);
  };
  const removeUnreadable = () => {
    dropping.current = HEAD_FIRST;
    plan.removeUnreadable();
  };
  const dropUnreadableHere = () => {
    dropping.current = HEAD_FIRST;
    dropUnreadable(fight.trainerId, fight.variant);
    setCopiesRead((n) => n + 1);
  };
  const workOut = () => {
    refocus.current = true;   // the button goes as the request starts
    void plan.workOut();
  };
  const leadName = shown?.start.mons.find((m) => m.key === shown.start.lead)?.name ?? 'Plan';
  return (
    <div className="plan" ref={root}>
      {failure !== null && (
        // The live region is the words alone; Try again and the server's own words (behind Details) sit beside them.
        <div className="banner banner-danger plan-error">
          <p role="alert"><strong>This turn has no numbers.</strong> {failure.text}</p>
          {failure.retry && <button type="button" className="button" {...busyProps(plan.busy, retry)}>Try again</button>}
          {failure.detail !== undefined && <ServerWords text={failure.detail} />}
        </div>
      )}
      {/* Shown here; said by the status region below (`hear`), not a live region of its own. */}
      {plan.notice !== null && <p className="banner banner-warn">{plan.notice}</p>}
      <p className="plan-status visually-hidden" role="status">{heard.text}</p>
      {shown === null && cleared !== null && (
        <p className="plan-cleared" tabIndex={-1}>
          {clearedText(cleared)}{' '}
          <button type="button" className="button" onClick={undoClear}>Undo</button>
        </p>
      )}
      {shown === null && startCopies !== null && (
        <>
          {startCopies.skipped > 0 && (
            <UnreadablePlans
              problem={savedProblemText(startCopies.skipped) ?? ''} count={startCopies.skipped} onRemove={dropUnreadableHere}
              onKeep={() => settle(HEAD_FIRST)}
            />
          )}
          <SavedPlans saved={startCopies.list} onOpen={openSaved} onDelete={deleteSaved} onKeep={() => settle(SAVED_FIRST)} />
        </>
      )}
      {shown === null ? (
        <StartScreen
          trainer={trainer} sheet={sheet} sheetError={sheetError} fight={fight} teamRefs={teamRefs} draft={draft} options={options} mons={mons} box={box}
          saved={[]} busy={sheet === null && sheetError === null} slow={false} onStop={noop} again={null} onAgain={noop} nameOf={() => name}
          onLead={onLead} onOpen={noop} onDelete={noop}
        />
      ) : (
        <>
          <div className="plan-grid">
            <div className="plan-left">
              {box !== null && (
                <BoxAndTeam
                  box={box} draft={props.teamDraft} active={mineRef ?? null} fainted={faintedMine} busy={plan.busy}
                  onTry={(ref) => {
                    const m = mons.get(ref);
                    if (m !== undefined) void plan.tryMon(planMonOf(m, draft));
                  }}
                />
              )}
            </div>
            <div className="plan-centre">
              <section className="plan-head">
                <h2 tabIndex={-1}>Battle plan · vs {name}</h2>
                <span>{markedTheirs(plan.turns).length} of {shown.start.enemies.length} marked fainted</span>
                <TurnChips rows={plan.rows} onJump={(turn) => void plan.goTo(turn)} />
                <PlanToolbar
                  plan={plan} name={planName} onName={setPlanName} trainer={name} copies={trainer?.variants ?? 1} lead={leadName}
                  teamOpen={props.teamOpen} onToggleTeam={props.onToggleTeam} onClear={clearPlan} onSay={say}
                />
                {plan.savedProblem !== null && (
                  <UnreadablePlans
                    problem={plan.savedProblem} count={plan.savedSkipped} onRemove={removeUnreadable} onKeep={() => settle(HEAD_FIRST)}
                  />
                )}
                {/* The saved plans while this one is on the page, so a copy opens without Clear plan. */}
                <SavedPlans saved={plan.saved} onOpen={openSaved} onDelete={deleteSaved} onKeep={() => settle(SAVED_FIRST)} />
              </section>
              <section className="plan-turn" aria-busy={plan.busy || undefined}>
                {plan.working !== null && (
                  <p className="plan-working">
                    {planWorkingText(plan.working.turn, plan.slow)}
                    {plan.slow && <>{' '}<button type="button" className="button" onClick={stop}>Stop</button></>}
                  </p>
                )}
                <div className="plan-turn-head">
                  <span className="plan-badge">Turn {current?.turn ?? shown.cursor + 1}</span>
                  <h3 tabIndex={-1} data-focus="turn">Your action</h3>
                  {order !== null && <p className="plan-order">{order}</p>}
                  {current !== null && current.turn === plan.turns.length && plan.turns.length > 1 && (
                    <button type="button" className="button-link plan-remove" onClick={removeTurn}>Remove this turn</button>
                  )}
                </div>
                {plan.removed !== null && (
                  <p className="plan-removed">
                    Turn {plan.removed} removed.{' '}
                    <button type="button" className="button-link" onClick={undoRemove}>Undo</button>{' '}
                    {/* His next edit closes this Undo, so the page says so. */}
                    <span className="line-muted">(until your next edit)</span>
                  </p>
                )}
                <SplitRows panel={panel} pick={current?.pick ?? null} theirPick={pickedTheirs} mine={mineName} theirs={theirName} />
                <TurnAction
                  plan={plan} panel={panel} trainer={name} mine={mineBox} mons={mons} draft={draft} team={team} onAddToTeam={props.onAddToTeam}
                  bands={{ mine: theirShown?.move ?? null, theirs: mineShown }}
                />
                {/* What the numbers leave out, in the server's plain sentences (as the tree's matchup header says it). */}
                {panel !== null && panel.unmodelled.length > 0 && (
                  <p className="line-muted plan-unmodelled">Not modelled in this battle: {panel.unmodelled.join('; ')}</p>
                )}
                {/* Their send-out the AI cannot decide (`sendOutError`), in the server's own words: in their send-in picker
                    once theirs is marked fainted (TurnAction), here otherwise. */}
                {panel?.sendOutError !== undefined && current?.fainted.theirs !== true && (
                  <p className="banner banner-warn plan-sendout-error">{panel.sendOutError}</p>
                )}
                {!plan.busy && failure === null && plan.unsettled && (
                  <p className="plan-unsettled">
                    <button type="button" className="button" onClick={workOut}>Work out this turn</button>
                  </p>
                )}
                <TurnFoot plan={plan} />
              </section>
              <WholePlan
                rows={plan.rows} fightNote={plan.fightNote} onJump={(turn) => void plan.goTo(turn)} onFightNote={plan.setFightNote} look={look}
              />
            </div>
            <div className="plan-right">
              <OpponentCard
                key={key} enemies={shown.start.enemies} sheet={ownSheet} loading={ownSheet === null && sheetError === null} active={current?.theirs ?? null} activeSpecies={panel?.view.enemy.active?.speciesId}
                fainted={current === null ? [] : current.fainted.theirs && current.theirs !== null ? [...current.faintedBefore.theirs, current.theirs] : current.faintedBefore.theirs}
              />
              {/* TheirReply is its own "Next move likelihood" heading and odds line. */}
              {panel !== null && (
                <section className="plan-pan">
                  <TheirReply
                    node={panel} selected={theirShown?.move.name ?? pickedTheirs ?? likeliestMove(panel) ?? undefined}
                    onSelect={(move) => pickAt !== null && setTheirPick({ at: pickAt, move })}
                  />
                </section>
              )}
              {current !== null && (
                <section className="plan-pan" aria-labelledby="plan-field-h">
                  <div className="plan-pan-head">
                    <h3 id="plan-field-h">Field</h3>
                    <InfoTip label="Field">Carries to the next turn.</InfoTip>
                  </div>
                  <FieldRow
                    value={current.field} onChange={(next) => void plan.setField(next)} busy={false}
                    playerName={shown.start.mons.find((m) => m.key === current.mine)?.name ?? 'Your Pokémon'}
                    enemyName={current.theirs === null ? 'Their Pokémon' : (shown.start.enemies[current.theirs] ?? 'Their Pokémon')}
                  />
                </section>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
