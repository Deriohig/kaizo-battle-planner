// The matchup sheet of the open fight and the trainer AI's odds for it (moved out of FightView).
//
// The sheet is asked for with the team as drafted (`POST /api/sheet`): the whole team in order, each Pokémon as
// the team column holds it, its edits included, and an empty team too (the answer then has the trainer's Pokémon and no
// pairs). Any change to what it asks (an edit, the team, the fight, the copy, the save) asks again: at once when no sheet
// of that trainer copy is held, else after SHEET_DELAY_MS without another change, so a burst of edits asks once. A newer
// change aborts the request before, and until the new sheet lands the old one stays, with `loading` set.
//
// Once a sheet has landed, the trainer AI's odds for its pairs are streamed with the sheet's own body (`POST
// /api/sheet/ai/stream`), and each pair's row fills in as its odds arrive. A stream belongs to one sheet and is never
// reconnected: any change to what the sheet asks aborts it at once (no stream runs while a newer sheet is loading), as
// do a newer sheet and leaving the view, so only one runs. Its odds count only for the sheet they were asked for and
// only when the stream's `start` names that sheet's save (its `savedAt` and `savePath`), never an older fight, team or
// save, nor a newer save whose sheet has not come yet. A failed AI stream is one line on the sheet, which stays.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoxJson, DraftMonJson, SheetAiPairJson, SheetJson } from '../../src/server/apiTypes';
import { errorMessage, postSheet, streamSheetAi, type SheetQuery } from './api';
import type { SheetAi } from './components/sheet/AiOdds';

/** How long the page waits after a change, while a sheet of the same trainer copy is shown, before it asks again. */
export const SHEET_DELAY_MS = 250;

/** The sheet held (`query` is what it answers, set with it), whether a newer one is loading, and why the last did not load. */
export interface SheetState { sheet: SheetJson | null; query: SheetQuery | null; loading: boolean; error: string | null }

/** The sheet held, with the body (as JSON) and the box it was asked for. */
interface Held { sheet: SheetJson; body: string; box: BoxJson | null }

/**
 * The sheet of `fight` against the team as drafted (`draft`, in team order), asked for again when the body or the box (a
 * new save) changes.
 */
export function useSheet(fight: { trainerId: string; variant: number } | null, draft: readonly DraftMonJson[], box: BoxJson | null): SheetState {
  const [state, setState] = useState<SheetState>({ sheet: null, query: null, loading: false, error: null });
  // Set with the sheet in `state`, and read by the effect, which does not run again when a sheet lands.
  const held = useRef<Held | null>(null);
  const body = fight === null ? null : JSON.stringify({ trainer: fight.trainerId, variant: fight.variant, team: draft.map((d) => d.ref), draft });
  useEffect(() => {
    if (body === null) return undefined;
    const kept = held.current;
    if (kept !== null && kept.body === body && kept.box === box) {
      // Back to what the sheet held was asked with (a change undone inside the pause): nothing to ask.
      setState((s) => (s.loading ? { ...s, loading: false } : s));
      return undefined;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    const query = JSON.parse(body) as SheetQuery;
    const request = new AbortController();
    const ask = () => {
      postSheet(query, request.signal).then(
        (sheet) => {
          if (request.signal.aborted) return;
          held.current = { sheet, body, box };
          setState({ sheet, query, loading: false, error: null });
        },
        (e: unknown) => {
          if (request.signal.aborted) return;
          held.current = null;
          setState({ sheet: null, query: null, loading: false, error: errorMessage(e) });
        },
      );
    };
    const sameCopy = kept !== null && kept.sheet.trainer.id === query.trainer && kept.sheet.trainer.variant === query.variant;
    const timer = sameCopy ? setTimeout(ask, SHEET_DELAY_MS) : undefined;
    if (!sameCopy) ask();
    return () => {
      clearTimeout(timer);
      request.abort();
    };
  }, [body, box]);
  return state;
}

/** The AI's odds so far, and the sheet they were asked for. */
type AiAnswer = { sheet: SheetJson; ai: SheetAi };

const AI_PENDING: SheetAi = { state: 'pending', pairs: [] };
/** The odds of a sheet with no pairs (an empty team): there is nothing to ask for. */
const AI_NONE: SheetAi = { state: 'ready', pairs: [] };

/**
 * The trainer AI's odds for the sheet `state` holds, streamed with that sheet's own body once it has landed: each pair
 * shows as it arrives, and the stream's `done` makes them ready. No stream runs while a newer sheet is loading, nor for a
 * sheet with no pairs. A change seen (`loading`), a newer sheet, or leaving the view aborts the stream before, so only one
 * runs. The odds show only with the sheet they were asked for, and only from a stream whose `start` is that sheet's save
 * (`savedAt` and `savePath`): another save's stream is closed, and the rows go on saying "Working out the AI…". With `wanted`
 * false (the off AI odds level, aiOdds.ts) no stream runs at all.
 */
export function useSheetAi({ sheet, query, loading }: SheetState, wanted = true): { ai: SheetAi; retry(): void } {
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!wanted || loading || sheet === null || query === null || sheet.pairs.length === 0) return undefined;
    const request = new AbortController();
    const show = (ai: SheetAi) => { if (!request.signal.aborted) setAnswer({ sheet, ai }); };
    const pairs: SheetAiPairJson[] = [];
    streamSheetAi(query, {
      onStart: (save) => {
        if (save.savedAt !== sheet.savedAt || save.savePath !== sheet.savePath) request.abort();
      },
      onPair: (pair) => {
        pairs.push(pair);
        show({ state: 'pending', pairs: [...pairs] });
      },
    }, request.signal).then(
      () => show({ state: 'ready', pairs }),
      (e: unknown) => show({ state: 'failed', error: errorMessage(e) }),
    );
    return () => request.abort();
  }, [sheet, query, loading, attempt, wanted]);
  const retry = useCallback(() => { setAnswer(null); setAttempt((n) => n + 1); }, []);
  const ai = sheet !== null && sheet.pairs.length === 0 ? AI_NONE : answer === null || answer.sheet !== sheet ? AI_PENDING : answer.ai;
  return { ai, retry };
}
