// The AI odds level the server runs at (`ConfigJson.aiOdds`, `PKP_AI_ODDS`), for every part of the
// page that shows the trainer AI's answer: App reads it from `GET /api/config` and provides it here, `full` when the server
// does not say (an older one) and for any part drawn without App (the tests). The server sends only what its level allows,
// so each part draws from what came, in the level's own words:
// - `full`: the exact odds, as the page always showed them.
// - `likeliest`: the likeliest move by name ("Bonsly's likeliest move: Stealth Rock"), every one tied for it; no percent,
//   bar or list of odds. Their send-in: every one still standing, the likeliest marked "likely".
// - `ranked`: their moves in order of likelihood, each with its place ("1st", "=2nd" for a joint place); no percent.
// - `off`: nothing of the AI's: their moves with their damage, in their own order, and no Matchups "Their reply".

import { createContext, useContext } from 'react';
import type { AiOddsLevel } from '../../src/server/apiTypes';

export const AiOddsContext = createContext<AiOddsLevel>('full');

/** The AI odds level the page is drawn at. */
export const useAiOdds = (): AiOddsLevel => useContext(AiOddsContext);

/** "1st", "2nd", "3rd", "4th", "11th", "22nd". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** A place in the AI's order as a list cell says it: "1st", "=2nd" for a place shared with another action. */
export const rankText = (rank: number, tied: boolean): string => `${tied ? '=' : ''}${ordinal(rank)}`;

/** "A", "A or B", "A, B or C". */
export const orList = (items: readonly string[]): string => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)!}`);
