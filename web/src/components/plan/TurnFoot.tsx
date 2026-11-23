// The foot of the plan's turn: the turn's note, kept as typed and never asked about, then
// the way on. A plan that has ended says so in one plain line (`ENDS_YOURS`, `ENDS_THEIRS`) with no way on, and never as a
// win or a loss or with odds of either: the page only says the plan has nowhere to go (the copied text keeps its own
// sentences, `planComplete` and `ALL_YOURS_FAINTED`); an earlier turn goes on
// to the next one; the last turn adds one ("Next turn"), held with the reason beside it until his replacement is picked,
// and held while the turn's numbers are worked out (`busyProps`), as their likeliest send-in comes with them. What Next
// turn carries on sits behind its ⓘ.

import { type JSX, useId } from 'react';
import type { UsePlan } from '../../usePlan';
import { busyProps } from '../busy';
import { InfoTip } from '../InfoTip';

export const PICK_FIRST = 'Pick who comes in first.';
export const ENDS_YOURS = 'All of yours are marked fainted, so the plan ends here. Undo a faint to keep going.';
export const ENDS_THEIRS = 'All of theirs are marked fainted, so the plan ends here.';
export const NEXT_HINT = 'Carries both Pokémon on, unless one fainted or you switched.';

export function TurnFoot({ plan }: { plan: UsePlan }): JSX.Element | null {
  const noteId = useId();
  const whyId = useId();
  const { plan: shown, current } = plan;
  if (shown === null || current === null) return null;
  const n = current.turn;
  const row = plan.rows[shown.cursor];
  const last = shown.cursor === shown.turns.length - 1;
  let way: JSX.Element;
  if (plan.ended !== null) {
    way = <p className="banner plan-end">{plan.ended === 'complete' ? ENDS_THEIRS : ENDS_YOURS}</p>;
  } else if (!last) {
    way = <button type="button" className="button button-primary" onClick={() => void plan.nextTurn()}>Go to turn {n + 1}</button>;
  } else {
    const held = !plan.canNext;
    const next = busyProps(plan.busy || held, () => void plan.nextTurn());
    way = (
      <>
        <p className="plan-next">
          <button type="button" className="button button-primary" {...next} aria-describedby={held ? whyId : undefined}>Next turn</button>
          {held && <>{' '}<span id={whyId}>{PICK_FIRST}</span></>}
          <InfoTip label="Next turn">{NEXT_HINT}</InfoTip>
        </p>
      </>
    );
  }
  // The note on the plain surface with a small label, two rows that grow as he types (plan.css), then the way on.
  return (
    <div className="plan-foot">
      <div className="plan-note">
        <label htmlFor={noteId}>Turn {n} note</label>
        <textarea id={noteId} rows={2} value={row?.note ?? ''} onChange={(e) => plan.setNote(e.target.value)} />
      </div>
      <div className="plan-way">{way}</div>
    </div>
  );
}
