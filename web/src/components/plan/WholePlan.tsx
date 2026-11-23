// The whole plan (under the turn): one row per turn with who is his, his pick,
// who is theirs, what the turn marks fainted and its note's excerpt, then the fight note. A row is a button that jumps to
// its turn; the current one takes the selected look and `aria-current`. Plan words only: no odds, no outcome.
// What the list is sits behind the heading's ⓘ. The turn is plain bold text, not a box in the row.

import { type JSX, useId } from 'react';
import type { TurnRow } from '../../planStore';
import { InfoTip } from '../InfoTip';
import { MonToken } from './parts';

/** His token's level and types for a pool name, where the box has them. */
export type TokenLook = (name: string) => { level: number; types: readonly string[]; species?: number } | undefined;

export function WholePlan({ rows, fightNote, onJump, onFightNote, look }: {
  rows: TurnRow[]; fightNote: string; onJump(turn: number): void; onFightNote(text: string): void;
  /** Without it (or for a name it does not know) the token is the name alone. */
  look?: TokenLook;
}): JSX.Element {
  const noteId = useId();
  const headId = useId();
  return (
    <section className="plan-pan plan-whole" aria-labelledby={headId}>
      <div className="plan-whole-head">
        <h3 id={headId}>Whole plan</h3>
        <InfoTip label="Whole plan">every turn, with its note · click a row to edit it</InfoTip>
      </div>
      <ol className="plan-rows">
        {rows.map((row) => {
          const seen = row.mine === null ? undefined : look?.(row.mine);
          return (
            <li key={row.turn}>
              <button
                type="button" className={row.current ? 'plan-row selected' : 'plan-row'} aria-current={row.current ? 'true' : undefined}
                onClick={() => onJump(row.turn)}
              >
                <span className="plan-row-turn">T{row.turn}</span>
                <span className="plan-row-mine">
                  {row.mine === null ? 'nobody yet' : seen === undefined ? (
                    <span className="tok tok-s"><strong title={row.mine}>{row.mine}</strong></span>
                  ) : (
                    <MonToken name={row.mine} level={seen.level} types={seen.types} size="s" species={seen.species} badge={false} />
                  )}
                </span>
                <span className="plan-row-pick">{row.pick ?? 'No pick yet'}</span>
                <span className="plan-row-theirs">{row.theirs === null ? '' : `vs ${row.theirs}`}</span>
                <span className="plan-row-note">
                  {row.fainted.map((words, i) => <strong key={i} className="plan-row-fainted">{words}</strong>)}
                  {row.excerpt !== '' && <em>“{row.excerpt}”</em>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <label htmlFor={noteId} className="plan-fight-note-label">Fight note</label>
      <textarea id={noteId} className="plan-fight-note" value={fightNote} onChange={(e) => onFightNote(e.target.value)} />
    </section>
  );
}
