// A move as a tile: its name with a muted note at the right (the PP), then its damage range, then its
// KO words (their exact fractions as the title), then any further muted lines (`extra`: "Working out…", priority). The
// tree's "Your choice" shows these as buttons; the team sheet will show them as plain tiles.
//
// With `button` the tile is one `<button type="button">` carrying those props (the busy attributes, `data-choice`,
// `disabled`) and `aria-pressed` from `selected`; without it, a `<div>` that is not interactive. The KO words take a tone
// the caller picks: `ok` is the green of a sure KO, `danger` the red of a move that can KO.

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface MoveTileProps {
  name: string;
  /** A type chip before the name. */
  type?: string | null;
  /** A muted line under the name: "Physical · 70 power". */
  sub?: string;
  /** Drawn between the sub line and the damage line (a damage band). */
  band?: ReactNode;
  /** Right of the name, muted: "19/20 PP". */
  meta?: string;
  /** Line 2: "22–27 HP (44–54%)". */
  damage?: string;
  /** Line 3, with its exact fractions as the title: a string, or nodes (the tree's one span per short line). */
  ko?: ReactNode;
  koTitle?: string;
  koTone?: 'ok' | 'danger' | null;
  /** Further muted lines (Working out…, priority). */
  extra?: ReactNode;
  /** `aria-pressed` and `is-selected`. */
  selected?: boolean;
  /** Present: a button with these props; absent: a div. */
  button?: ButtonHTMLAttributes<HTMLButtonElement> & { 'data-choice'?: string };
}

export function MoveTile({ name, type, sub, band, meta, damage, ko, koTitle, koTone, extra, selected, button }: MoveTileProps) {
  const className = `tile${selected === true ? ' is-selected' : ''}`;
  // A space between the parts, so the button's name and text read as words (the parts are blocks only by the page's CSS).
  const has = (text: string | undefined): text is string => text !== undefined && text !== '';
  const parts = (
    <>
      <span className="tile-head">
        {type !== undefined && type !== null && type !== '' && <><span className="type-chip" data-type={type}>{type}</span>{' '}</>}
        <span className="tile-name">{name}</span>
        {has(meta) && <>{' '}<span className="tile-meta">{meta}</span></>}
      </span>
      {has(sub) && <>{' '}<span className="tile-sub">{sub}</span></>}
      {band !== undefined && band !== null && band !== false && <>{' '}{band}</>}
      {has(damage) && <>{' '}<span className="tile-damage">{damage}</span></>}
      {ko !== undefined && ko !== null && ko !== false && ko !== '' && <>{' '}<span className={`tile-ko${koTone === 'ok' ? ' is-ok' : koTone === 'danger' ? ' is-danger' : ''}`} title={koTitle}>{ko}</span></>}
      {extra !== undefined && extra !== null && extra !== false && <>{' '}<span className="tile-extra">{extra}</span></>}
    </>
  );
  if (button === undefined) return <div className={className}>{parts}</div>;
  return <button type="button" {...button} className={button.className === undefined ? className : `${className} ${button.className}`} aria-pressed={selected === true}>{parts}</button>;
}
