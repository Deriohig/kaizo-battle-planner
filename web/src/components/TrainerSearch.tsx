// The search over every trainer, under the next fights. Typing waits 200 ms, then asks the server (`getTrainers(search)`);
// nothing lists while the box is empty. What it finds lists under the box, name matches first, under its split's heading, each row the name, location, battle
// type, tags and "N copies" for a trainer with several; a double carries the one quiet "2v2" tag (its title says it cannot be planned yet). Picking one opens it and
// empties the box. From the keyboard (roving focus over the result buttons, which stay buttons): Down in the box moves to
// the first result, Up and Down move between them (Up from the first goes back to the box), Enter opens the one in focus,
// and Escape in a result goes back to the box. Escape in the box is the search field's own: it clears it.

import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import type { TrainerSummaryJson } from '../../../src/server/apiTypes';
import { errorMessage, getTrainers } from '../api';
import { trainerName, trainerTag } from '../labels';
import { rankFound } from '../run';

export const SEARCH_DEBOUNCE_MS = 200;

/** A double's one quiet tag wherever it is listed, and its tooltip: the line builder cannot run a double battle yet. */
export const DOUBLE_PILL = '2v2';
export const DOUBLE_TITLE = "Double battle: can't be planned yet";

/** A location the data holds in capitals ("SPEAR PILLAR") shown in title case; any other spelling is left as it is. */
export function locationName(location: string): string {
  if (location !== location.toUpperCase() || location === location.toLowerCase()) return location;
  return location.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

type Trainer = TrainerSummaryJson;

export function TrainerSearch({ openId, onPick }: { openId: string | null; onPick(trainer: Trainer): void }): JSX.Element {
  const [text, setText] = useState('');
  // What the server is asked: the box's text once it has stayed the same for 200 ms, and '' as soon as it is emptied,
  // so typing again after a clear or a pick never asks for the old text first.
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; trainers: Trainer[] } | null>(null);
  const [error, setError] = useState<{ query: string; message: string } | null>(null);
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const typed = text.trim();
    if (typed === '') return undefined;
    const timer = setTimeout(() => setQuery(typed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    if (query === '') return undefined;
    let live = true;
    setError(null);                                             // a new try of a query that failed starts afresh
    getTrainers(query).then(
      (trainers) => { if (live) setFound({ query, trainers }); },
      (e: unknown) => { if (live) setError({ query, message: errorMessage(e) }); },
    );
    return () => { live = false; };
  }, [query]);

  const change = (value: string) => {
    setText(value);
    if (value.trim() === '') setQuery('');
  };
  const pick = (trainer: Trainer) => {
    onPick(trainer);
    change('');
  };

  const picks = () => Array.from(results.current?.querySelectorAll<HTMLButtonElement>('button.trainer-pick') ?? []);
  const fromBox = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowDown') return;
    const first = picks()[0];
    if (first === undefined) return;
    event.preventDefault();
    first.focus();
  };
  const inResults = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      input.current?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const all = picks();
    const at = all.findIndex((b) => b === document.activeElement);
    if (at < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowUp') (at === 0 ? input.current : all[at - 1])?.focus();
    else all[Math.min(at + 1, all.length - 1)]?.focus();
  };

  const failed = error !== null && error.query === query ? error.message : null;
  const shown = found !== null && found.query === query ? found.trainers : null;

  return (
    <div className="run-search">
      <input
        type="search" className="run-search-input" aria-label="Search all trainers" placeholder="Search all trainers"
        value={text} onChange={(event) => change(event.target.value)} ref={input} onKeyDown={fromBox} aria-describedby={hintId}
      />
      <span id={hintId} className="visually-hidden">Down arrow moves to the results, then Up and Down, and Enter opens one.</span>
      {query !== '' && (
        <div className="run-results" ref={results} onKeyDown={inResults}>
          {failed !== null ? (
            <p className="banner banner-danger" role="alert"><strong>The search failed.</strong> {failed}</p>
          ) : shown === null ? (
            <p className="app-loading" role="status">Searching…</p>
          ) : shown.length === 0 ? (
            <p className="trainer-none">No trainer matches “{query}”.</p>
          ) : (
            splits(shown, query).map((group) => <Split key={group.trainers[0]!.id} group={group} openId={openId} onPick={pick} />)
          )}
        </div>
      )}
    </div>
  );
}

interface Group { split: string; trainers: Trainer[] }

/** The trainers ranked by how well they match the text (name first), in runs of consecutive trainers of the same split. */
function splits(trainers: Trainer[], text: string): Group[] {
  const groups: Group[] = [];
  for (const trainer of rankFound(trainers, text)) {
    const last = groups.at(-1);
    if (last !== undefined && last.split === trainer.split) last.trainers.push(trainer);
    else groups.push({ split: trainer.split, trainers: [trainer] });
  }
  return groups;
}

function Split({ group, openId, onPick }: { group: Group; openId: string | null; onPick(trainer: Trainer): void }) {
  const headingId = useId();
  return (
    <section className="trainer-split" aria-labelledby={headingId}>
      <h3 id={headingId}>{group.split}</h3>
      <ul className="trainer-list">
        {group.trainers.map((trainer) => (
          <li key={trainer.id} className={trainer.id === openId ? 'trainer-row is-selected' : 'trainer-row'}>
            <button type="button" className="trainer-pick" aria-pressed={trainer.id === openId} onClick={() => onPick(trainer)}>
              <Facts trainer={trainer} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Facts({ trainer }: { trainer: Trainer }) {
  return (
    <>
      <span className="trainer-name">{trainerName(trainer.name)}</span>{' '}
      <span className="trainer-location">{locationName(trainer.location)}</span>{' '}
      <span className="trainer-pills">
        {trainer.battleType === 'double'
          ? <span className="pill pill-double" title={DOUBLE_TITLE}>{DOUBLE_PILL}<span className="visually-hidden"> ({DOUBLE_TITLE})</span></span>
          : <span className="pill">Single</span>}
        {trainer.variants > 1 && <>{' '}<span className="pill">{trainer.variants} copies</span></>}
        {trainer.tags.filter((tag) => !(trainer.battleType === 'double' && /^double( battle)?$/i.test(tag.trim()))).map((tag) => <span key={tag}>{' '}<span className="pill pill-tag">{trainerTag(tag)}</span></span>)}
      </span>
    </>
  );
}
