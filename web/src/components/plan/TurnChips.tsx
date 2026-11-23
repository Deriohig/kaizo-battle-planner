// The plan's turns as chips under its heading: one per turn, with "fainted" when the turn marks one and "note" when it has
// one; the current turn takes the selected look and `aria-current`. A click jumps there. Never held while a
// turn's numbers are worked out: a jump overtakes the request.

import type { JSX } from 'react';
import type { TurnRow } from '../../planStore';

export function TurnChips({ rows, onJump }: { rows: TurnRow[]; onJump(turn: number): void }): JSX.Element {
  return (
    <nav aria-label="Turns" className="plan-chips">
      {rows.map((row) => (
        <button
          key={row.turn} type="button" className={row.current ? 'chip plan-chip selected' : 'chip plan-chip'}
          aria-current={row.current ? 'true' : undefined} onClick={() => onJump(row.turn)}
        >
          Turn {row.turn}
          {row.fainted.length > 0 && <span className="pill pill-danger">fainted</span>}
          {row.note !== '' && <span className="pill">note</span>}
        </button>
      ))}
    </nav>
  );
}
