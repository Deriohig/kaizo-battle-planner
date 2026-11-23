// The trainer AI's odds on the matchup sheet, streamed pair by pair from `POST /api/sheet/ai/stream`.
// Each pair row says what the AI does next, "AI picks: Tackle 62.5% · Growl 37.5%" (the
// exact fraction only in the choice's title; "Tackle (certain)" for a sure one), and whom it sends in if its Pokémon faints while yours is in, "If it
// faints: sends in Zigzagoon (certain)" or "nothing left to send in". Where one of the trainer's disputed values decides
// the odds (`depends`), the row gives each case side by side: "AI depends on Forretress's nature:", then "if Hardy:
// Earthquake (certain)", "if Sassy: Gyro Ball 75% · Earthquake 25%"; for a switch-in, "If it faints, depends on
// …:" and "if Hardy or Bold: sends in Bronzor (certain)". An AiError reads "AI: unproven (<reason>)", never a guess, as
// do odds the page can't read ("AI: unproven (unreadable odds)"); a pair the odds do not cover (a weather not settled)
// gives the reason in muted text, and one the finished answer leaves out says "AI: no answer for this pair". One note at
// the top of the sheet says these are the AI's odds in the situation shown, not a proof; a request that failed is one
// line there instead, and a double battle's sheet says there, once, that the odds are for single battles only. Beside
// the note, one live region says "Working out the AI…" until the odds are all in, and nothing after; each row still
// waiting for its pair says it as plain text.
//
// Below the full AI odds (aiOdds.ts) the stream carries ranks, not odds, and the lines have no figure: at `likeliest`
// "AI most likely picks: Body Slam" (every one tied joined by "or") and "If it faints: most likely sends in Zigzagoon";
// at `ranked` "AI picks, likeliest first: Body Slam · Fake Out = Tackle", a "=" joining a shared place. A `depends`
// answer's cases read the same way under "AI's likeliest pick depends on …:" or "AI's order depends on …:". At `off` the
// page asks for no odds and the pairs have no Their reply (FightView).

import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type { AiChoiceJson, AiOddsJson, AiOddsLevel, SheetAiJson } from '../../../../src/server/apiTypes';
import { orList, useAiOdds } from '../../aiOdds';
import { formatOdds } from '../../format';

/**
 * The AI's odds for the sheet shown: still being worked out (`pairs` holds those in so far), worked out, or a request
 * that failed.
 */
export type SheetAi =
  | { state: 'pending'; pairs: SheetAiJson['pairs'] }
  | { state: 'ready'; pairs: SheetAiJson['pairs'] }
  | { state: 'failed'; error: string };

/** The odds a pair row shows: still being worked out, or worked out (a failed request leaves the rows without them). */
export type RowAi = Exclude<SheetAi, { state: 'failed' }>;

/** The standing note that the odds are not a proof: the matchup bar holds it behind its ⓘ. */
export const AI_NOTE = "AI odds: the trainer AI's odds in each situation shown, not a proof.";

/** `AI_NOTE` at an AI odds level: below full the lines carry no odds, so the note does not call them that. */
export function aiNoteAt(level: AiOddsLevel): string {
  if (level === 'likeliest') return "AI: the trainer AI's likeliest choice in each situation shown, not a proof.";
  if (level === 'ranked') return "AI: the trainer AI's choices in order of likelihood in each situation shown, not a proof.";
  return AI_NOTE;
}

/** What is left below the full AI odds that shows the AI at all. */
type Cut = 'likeliest' | 'ranked';

/** The choices at `level`: "A or B" (those ranked first) at `likeliest`; "A · B = C" (the order, a shared place joined) at `ranked`. */
function placesText(choices: readonly AiChoiceJson[], level: Cut): string {
  if (level === 'likeliest') return orList(choices.filter((c) => c.rank === 1).map((c) => c.label));
  const places: string[][] = [];
  let last: number | undefined;
  for (const c of choices) {
    if (places.length > 0 && c.rank !== undefined && c.rank === last) places.at(-1)!.push(c.label);
    else places.push([c.label]);
    last = c.rank;
  }
  return places.map((place) => place.join(' = ')).join(' · ');
}
const DOUBLE_NOTE = 'AI odds: single battles only';
const PENDING = 'Working out the AI…';

/** A choice with its probability as the page shows it (`formatOdds`). */
type Shown = AiChoiceJson & { exact: string; percent: string };
type Depends = Extract<AiOddsJson, { status: 'depends' }>;

/**
 * What the bar shows of the AI note inline (a double's one line, or the line saying why the odds did not load; the
 * standing `AI_NOTE` is in the bar's ⓘ), and the live region beside it, which says "Working out the AI…" while the odds
 * are worked out and is empty otherwise.
 */
export function AiNote({ ai, double = false, onRetry }: { ai: SheetAi; double?: boolean; onRetry?: (() => void) | undefined }) {
  const note = double ? <p className="sheet-ai-note">{DOUBLE_NOTE}</p>
    : ai.state === 'failed' ? (
      <p className="sheet-ai-failed" role="alert">
        The AI odds did not load: {ai.error}
        {onRetry !== undefined && <> <button type="button" className="button" onClick={onRetry}>Try again</button></>}
      </p>
    )
      : null;
  return (
    <>
      {note}
      <p className="sheet-ai-status" role="status">{!double && ai.state === 'pending' ? PENDING : ''}</p>
    </>
  );
}

/** The AI's two lines for the pair of `player` and `enemy`, or "Working out the AI…" until that pair's odds are in. */
export function AiOdds({ ai, player, enemy }: { ai: RowAi; player: string; enemy: string }) {
  const odds = ai.pairs.find((pair) => pair.player === player && pair.enemy === enemy);
  if (odds === undefined) {
    return ai.state === 'pending' ? <span className="sheet-ai-pending">{PENDING}</span> : <Line tone="muted">AI: no answer for this pair</Line>;
  }
  const { next, ifFaints } = odds;
  // An unsettled weather leaves both out for the same reason: it is said once.
  const sameReason = next.status === 'unsupported' && ifFaints.status === 'unsupported' && next.reason === ifFaints.reason;
  return (
    <>
      <NextLine odds={next} />
      {!sameReason && <FaintLine odds={ifFaints} />}
    </>
  );
}

function NextLine({ odds }: { odds: AiOddsJson }) {
  const level = useAiOdds();
  if (odds.status === 'ok') {
    if (level === 'likeliest' || level === 'ranked') {
      return <Line lead={level === 'likeliest' ? 'AI most likely picks:' : 'AI picks, likeliest first:'}>{placesText(odds.choices, level)}</Line>;
    }
    const shown = shownChoices(odds.choices);
    return shown === null ? <Unreadable /> : <Line lead="AI picks:"><Choices choices={shown} /></Line>;
  }
  if (odds.status === 'unproven') return <Line tone="unproven" title={odds.code}>{unprovenText(odds)}</Line>;
  if (odds.status === 'depends') {
    const head = level === 'likeliest' ? `AI's likeliest pick depends on ${odds.on}:` : level === 'ranked' ? `AI's order depends on ${odds.on}:` : `AI depends on ${odds.on}:`;
    return <DependsLines odds={odds} head={head} />;
  }
  return <Line tone="muted">{odds.reason}</Line>;
}

function FaintLine({ odds }: { odds: AiOddsJson }) {
  const level = useAiOdds();
  const lead = 'If it faints:';
  if (odds.status === 'ok') {
    if (level === 'likeliest' || level === 'ranked') {
      return <Line lead={lead}>{level === 'likeliest' ? 'most likely sends in ' : 'sends in, likeliest first: '}{placesText(odds.choices, level)}</Line>;
    }
    const shown = shownChoices(odds.choices);
    return shown === null ? <Unreadable lead={lead} /> : <Line lead={lead}>sends in <Choices choices={shown} /></Line>;
  }
  if (odds.status === 'none') return <Line lead={lead}>nothing left to send in</Line>;
  if (odds.status === 'unproven') return <Line lead={lead} tone="unproven" title={odds.code}>{unprovenText(odds)}</Line>;
  if (odds.status === 'depends') {
    const head = level === 'likeliest' ? `If it faints, the likeliest send-in depends on ${odds.on}:`
      : level === 'ranked' ? `If it faints, the order depends on ${odds.on}:` : `If it faints, depends on ${odds.on}:`;
    return <DependsLines odds={odds} head={head} lead={lead} sendsIn />;
  }
  return <Line lead={lead} tone="muted">{odds.reason}</Line>;
}

/**
 * A `depends` answer, its cases side by side: the `head` line ("AI depends on Forretress's nature:"), then one line per
 * case, "if Hardy: Earthquake (certain)", the choices as an `ok` line shows them, after "sends in" for a switch-in
 * (`sendsIn`). A case whose odds don't read makes the whole answer unreadable, after `lead` when given.
 */
function DependsLines({ odds, head, lead, sendsIn = false }: { odds: Depends; head: string; lead?: string; sendsIn?: boolean }) {
  const level = useAiOdds();
  if (level === 'likeliest' || level === 'ranked') {
    return (
      <>
        <p className="sheet-ai-line sheet-ai-head"><span className="sheet-ai-lead">{head}</span></p>
        <ul className="sheet-ai-cases" role="list">
          {odds.cases.map((c, index) => (
            <li key={index} className="sheet-ai-line">if {c.when}: {sendsIn && 'sends in '}{placesText(c.choices, level)}</li>
          ))}
        </ul>
      </>
    );
  }
  const cases = shownCases(odds.cases);
  if (cases === null) return <Unreadable lead={lead} />;
  return (
    <>
      <p className="sheet-ai-line sheet-ai-head"><span className="sheet-ai-lead">{head}</span></p>
      {/* role="list": the cases' `list-style: none` would otherwise drop the list semantics in Safari/VoiceOver. */}
      <ul className="sheet-ai-cases" role="list">
        {cases.map((c, index) => (
          <li key={index} className="sheet-ai-line">
            if {c.when}: {sendsIn && 'sends in '}<Choices choices={c.choices} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** A line whose odds the page can't read (a probability that isn't "num/den"): unproven, never a guess or a crash. */
function Unreadable({ lead }: { lead?: string }) {
  return <Line {...(lead !== undefined && { lead })} tone="unproven">{unprovenText({ reason: 'unreadable odds' })}</Line>;
}

/** Each choice with its probability as shown, or null when one doesn't read (`formatOdds` throws). */
function shownChoices(choices: AiChoiceJson[]): Shown[] | null {
  try {
    return choices.map((choice) => {
      if (choice.probability === undefined) throw new Error('no probability');
      return { ...choice, ...formatOdds(choice.probability) };
    });
  } catch {
    return null;
  }
}

/** Each case of a `depends` answer with its choices as shown, or null when one of them doesn't read. */
function shownCases(cases: Depends['cases']): { when: string; choices: Shown[] }[] | null {
  const shown: { when: string; choices: Shown[] }[] = [];
  for (const { when, choices } of cases) {
    const read = shownChoices(choices);
    if (read === null) return null;
    shown.push({ when, choices: read });
  }
  return shown;
}

function Line({ lead, tone, title, children }: { lead?: string; tone?: 'muted' | 'unproven'; title?: string; children: ReactNode }) {
  return (
    <p className={tone === undefined ? 'sheet-ai-line' : `sheet-ai-line sheet-ai-${tone}`} title={title}>
      {lead !== undefined && <><span className="sheet-ai-lead">{lead}</span>{' '}</>}
      {children}
    </p>
  );
}

/** "AI: unproven (<reason>)": the AI cannot say exactly here, and the page never guesses. */
const unprovenText = (odds: { reason: string }) => `AI: unproven (${odds.reason})`;

/** "Tackle 62.5% 5/8 · Growl 37.5% 3/8". */
function Choices({ choices }: { choices: Shown[] }) {
  return choices.map((choice, index) => (
    <Fragment key={index}>
      {index > 0 && ' · '}
      <ChoiceText choice={choice} />
    </Fragment>
  ));
}

/**
 * "Tackle 62.5%", the percent through `formatOdds`; the exact fraction ("5/8") only in the choice's title. A sure choice
 * is "Tackle (certain)".
 */
function ChoiceText({ choice }: { choice: Shown }) {
  const { exact, percent } = choice;
  if (exact === '1/1') return <span className="ai-choice">{`${choice.label} (certain)`}</span>;
  return <span className="ai-choice" title={exact}>{`${choice.label} ${percent}`}</span>;
}
