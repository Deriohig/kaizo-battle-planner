// The plans the player saved a copy of for this fight (shown above the start screen, and under
// the toolbar while a plan is on the page), each with Open and Delete; and the stored copies the page cannot read, said in
// words with a way to remove them. Both removals ask first, as neither can be undone. Escape in a Delete row that is
// asking closes it like Keep it does, and focus goes back to the Delete that opened it (a Keep it press hands focus to PlanView). A control that goes with its click
// (Keep it, and the removals themselves) hands focus back through `onKeep` / the removal, for PlanView to put on a heading.

import { type JSX, useId, useRef, useState } from 'react';
import type { SavedPlan } from '../../planStore';

const turnsText = (n: number): string => `${n} ${n === 1 ? 'turn' : 'turns'}`;

/**
 * The row's text: the name and the turn count, the count once. The default name already ends with it, and so does that name
 * after a clash took a free one ("Prinplup, 2 turns (2)"), so a trailing " (2)" is looked past when checking.
 */
export const savedRowText = (name: string, turns: number): string => {
  const count = turnsText(turns);
  return name.replace(/ \(\d+\)$/, '').endsWith(count) ? name : `${name} · ${count}`;
};

/** Null when there are none. */
export function SavedPlans({ saved, onOpen, onDelete, onKeep }: {
  saved: SavedPlan[]; onOpen(plan: SavedPlan): void; onDelete(name: string): void;
  /** "Keep it" in a Delete confirm was pressed: its button goes. */
  onKeep?(): void;
}): JSX.Element | null {
  const headId = useId();
  const nameId = useId();
  /** The saved plan whose Delete is asking to confirm; null when none is. */
  const [asking, setAsking] = useState<string | null>(null);
  /** The Delete buttons by saved name, for Escape to hand focus back to. */
  const deletes = useRef(new Map<string, HTMLButtonElement>());
  if (saved.length === 0) return null;
  return (
    <section className="plan-pan plan-saved" aria-labelledby={headId}>
      <h3 id={headId} tabIndex={-1}>Saved plans</h3>
      <ul className="plan-saved-list">
        {saved.map((copy, i) => (
          <li
            key={copy.name}
            onKeyDown={(e) => {
              if (e.key !== 'Escape' || asking !== copy.name) return;
              e.stopPropagation();
              setAsking(null);
              deletes.current.get(copy.name)?.focus();
            }}
          >
            <span id={`${nameId}-${i}`} className="plan-saved-name">{savedRowText(copy.name, copy.plan.turns.length)}</span>
            <button type="button" className="button" aria-describedby={`${nameId}-${i}`} onClick={() => onOpen(copy)}>Open</button>
            <button
              type="button" className="button" aria-describedby={`${nameId}-${i}`} aria-expanded={asking === copy.name}
              ref={(el) => { if (el === null) deletes.current.delete(copy.name); else deletes.current.set(copy.name, el); }}
              aria-controls={`${nameId}-${i}-confirm`} onClick={() => setAsking(asking === copy.name ? null : copy.name)}
            >
              Delete
            </button>
            <div id={`${nameId}-${i}-confirm`} className="plan-saved-confirm-slot">
              {asking === copy.name && (
                <p className="plan-saved-confirm">
                  This deletes the saved plan {copy.name} for good: it cannot be undone.{' '}
                  <button type="button" className="button" onClick={() => { setAsking(null); onDelete(copy.name); }}>Delete it</button>{' '}
                  <button type="button" className="button" onClick={() => { setAsking(null); onKeep?.(); }}>Keep it</button>
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The copies that cannot be read: `problem` (`savedProblemText`), then the remove control and its confirm step. */
export function UnreadablePlans({ problem, count, onRemove, onKeep }: {
  problem: string; count: number; onRemove(): void;
  /** "Keep it" / "Keep them" was pressed: its button goes. */
  onKeep?(): void;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  const confirmId = useId();
  const them = count === 1 ? 'the plan that could not be read' : `the ${count} plans that could not be read`;
  return (
    <div className="plan-unreadable">
      <p>
        {problem}{' '}
        <button type="button" className="button-link" aria-expanded={asking} aria-controls={confirmId} onClick={() => setAsking(!asking)}>
          Remove {them}
        </button>
      </p>
      <div id={confirmId}>
        {asking && (
          <p className="plan-unreadable-confirm">
            This removes {them} for good: it cannot be undone.{' '}
            <button type="button" className="button" onClick={() => { setAsking(false); onRemove(); }}>
              {count === 1 ? 'Remove it' : 'Remove them'}
            </button>{' '}
            <button type="button" className="button" onClick={() => { setAsking(false); onKeep?.(); }}>{count === 1 ? 'Keep it' : 'Keep them'}</button>
          </p>
        )}
      </div>
    </div>
  );
}
