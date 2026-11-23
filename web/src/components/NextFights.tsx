// The next fights: the shown split's trainers in game order, as one strip that scrolls sideways inside its own box. The
// open fight is pressed and scrolled into view, the single battle after it is marked After this (or the one the parent
// names), a fight already beaten says Beaten, and a double carries a quiet 2v2 tag (it stays in the list, in order).
// At 8 badges a Split select picks which of the save's two possible splits is listed. The search over every trainer sits under the strip.

import { useEffect, useLayoutEffect, useRef, type JSX } from 'react';
import type { TrainerSummaryJson } from '../../../src/server/apiTypes';
import { trainerName } from '../labels';
import { nextFight } from '../run';
import { DOUBLE_PILL, DOUBLE_TITLE, locationName, TrainerSearch } from './TrainerSearch';

type Trainer = TrainerSummaryJson;

export function NextFights({ fights, split, splits, openId, nextId: givenNextId, beaten, onPick, onSplit }: {
  /** The shown split's fights, in order; null while the trainers load. */
  fights: Trainer[] | null;
  split: string;
  /** The splits the save could be in: one, or two at 8 badges. */
  splits: string[];
  openId: string | null;
  /** The fight marked After this, when the parent says (it follows the run, not a trainer opened from search); left out, the single after the open one. */
  nextId?: string | null | undefined;
  /** The ids of the fights already beaten in the run; each shows a Beaten pill. */
  beaten?: readonly string[] | undefined;
  onPick(trainer: Trainer): void;
  onSplit(split: string): void;
}): JSX.Element {
  const openButton = useRef<HTMLButtonElement>(null);
  const strip = useRef<HTMLOListElement>(null);
  const nextId = givenNextId !== undefined ? givenNextId : fights === null ? null : (nextFight(fights, openId)?.id ?? null);
  const openListed = fights?.some((t) => t.id === openId) ?? false;

  // Only when another fight opens (or the open one first shows up in the list), so a strip the player has scrolled stays put.
  // The strip scrolls itself, just enough to show the open fight whole; scrollIntoView would also move the page. A strip
  // too narrow for the fight starts at it: one with no width yet (the page opened in a hidden pane or tab) would
  // otherwise scroll the fight off its left edge, and stay there once it is laid out.
  const scrollToOpen = () => {
    const list = strip.current; const item = openButton.current;
    if (!list || !item) return;
    const left = item.offsetLeft - list.offsetLeft;
    if (left < list.scrollLeft || item.offsetWidth > list.clientWidth) list.scrollLeft = left;
    else if (left + item.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = left + item.offsetWidth - list.clientWidth;
  };
  const scrollRef = useRef(scrollToOpen);
  useLayoutEffect(() => { scrollRef.current = scrollToOpen; });
  useEffect(() => { scrollToOpen(); }, [openId, openListed]);

  // A strip hidden behind a disclosure has no width; when it is shown again (zero to a real width) the open fight is
  // scrolled to once more. Other resizes leave a strip the player has scrolled where it is.
  const hasStrip = fights !== null && fights.length > 0;
  useEffect(() => {
    const list = strip.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    let width = list.clientWidth;
    const observer = new ResizeObserver(() => {
      const now = list.clientWidth;
      const shown = width === 0 && now > 0;
      width = now;
      if (shown) scrollRef.current();
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [hasStrip]);

  const count = fights === null ? split : `${split} · ${fights.length} ${fights.length === 1 ? 'fight' : 'fights'}`;

  return (
    <section className="run" aria-label="Next fights">
      <div className="run-head">
        <h2 className="run-heading">Next fights</h2>
        <p className="run-count">{count}</p>
        {splits.length > 1 && (
          <select className="run-split" aria-label="Split" value={split} onChange={(event) => onSplit(event.target.value)}>
            {splits.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
      </div>
      {fights === null ? (
        <p className="app-loading" role="status">Loading the trainers…</p>
      ) : fights.length === 0 ? (
        <p className="run-none">No fights are listed for this split. Search for a trainer.</p>
      ) : (
        <ol className="run-fights" ref={strip}>
          {fights.map((trainer) => (
            <li key={trainer.id}>
              <button
                type="button" className="run-fight" aria-pressed={trainer.id === openId}
                ref={trainer.id === openId ? openButton : undefined} onClick={() => onPick(trainer)}
              >
                <span className="run-fight-name">{trainerName(trainer.name)}</span>{' '}
                <span className="run-fight-location">{locationName(trainer.location)}</span>
                {beaten?.includes(trainer.id) === true && <>{' '}<span className="pill run-beaten">Beaten</span></>}
                {trainer.id === nextId && <>{' '}<span className="pill run-next">After this</span></>}
                {trainer.battleType === 'double' && <>{' '}<span className="pill pill-double" title={DOUBLE_TITLE}>{DOUBLE_PILL}<span className="visually-hidden"> ({DOUBLE_TITLE})</span></span></>}
              </button>
            </li>
          ))}
        </ol>
      )}
      <TrainerSearch openId={openId} onPick={onPick} />
    </section>
  );
}
