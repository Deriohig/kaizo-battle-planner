// The fight's Matchups view: the matchup sheet against the team as drafted, every member included, with the trainer AI's
// odds. A sheet the server refuses for its draft says "Matchups can't use this team." and why, in the team column's words,
// with no sheet under it. With nobody in the team it says to add a Pokémon, and shows no sheet. The trainer copy is picked
// in the fight header, not here. His Pokémon over the save's level cap say so in their pairs, in the team column's words.

import type { JSX } from 'react';
import type { BoxJson } from '../../../src/server/apiTypes';
import { problemText } from '../draft';
import type { SheetState } from '../useSheet';
import { ErrorBoundary } from './ErrorBoundary';
import type { SheetAi } from './sheet/AiOdds';
import { SheetView } from './SheetView';

export function MatchupsView({ state, ai, onRetry, fight, teamEmpty, box }: {
  /** `ai` left out (the off AI odds level, aiOdds.ts): the pairs have no Their reply. */
  state: SheetState; ai: SheetAi | undefined; onRetry(): void; fight: { trainerId: string; variant: number };
  /** Whether the team has nobody in it. */
  teamEmpty: boolean;
  /** The save on screen, to name the Pokémon a refused draft is about and for its level cap; null while it is read. */
  box: BoxJson | null;
}): JSX.Element {
  return (
    <div className="matchups">
      {teamEmpty
        ? <p className="matchups-note">Add a Pokémon to the team to see matchups.</p>
        : <SheetPanel state={state} ai={ai} onRetry={onRetry} fight={fight} box={box} />}
    </div>
  );
}

/** The sheet, or while it loads the last one of the same trainer copy (an edit, a new team or save), never another trainer's. */
function SheetPanel({ state, ai, onRetry, fight, box }: {
  state: SheetState; ai: SheetAi | undefined; onRetry(): void; fight: { trainerId: string; variant: number }; box: BoxJson | null;
}) {
  const { sheet, error } = state;
  const same = sheet !== null && sheet.trainer.id === fight.trainerId && sheet.trainer.variant === fight.variant;
  return (
    <div className="fight-sheet" aria-busy={state.loading}>
      {state.loading && <p className="app-loading" role="status">Working out the matchups…</p>}
      {error !== null && (
        <p className="banner banner-danger" role="alert">
          {error.startsWith('draft: ')
            ? <><strong>{"Matchups can't use this team."}</strong> {box === null ? error : problemText(box, error)}</>
            : <><strong>The matchups did not load.</strong> {error}</>}
        </p>
      )}
      {same && <ErrorBoundary resetKey={sheet}><SheetView key={`${sheet.trainer.id}|${sheet.trainer.variant}`} sheet={sheet} ai={ai} onRetry={onRetry} levelCap={box?.levelCap} /></ErrorBoundary>}
    </div>
  );
}
