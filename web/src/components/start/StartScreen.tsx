// The start screen before a tree: the trainer's Pokémon with their sets, then his own team as it is given, each
// row with its level, HP, status, item and moves, the first matchup against their first Pokémon (who goes first, the
// speeds, and a warning when it can KO in one hit), and "Start with X" to begin the tree with that Pokémon first: every
// one the same secondary button, as the list's order is not a recommendation, and the whole row a click target too.
// Also the
// tree Stop did not let open, offered again, the trees he named, and the busy line while a tree is opened. The tree's
// start itself, the sheet and the draft are the page's (`LineView`); this only shows them.

import type { JSX } from 'react';
import type {
  BoxJson, BoxMonJson, DraftMonJson, DraftOptionsJson, MonRef, SheetJson, SheetMonJson, TrainerSummaryJson,
} from '../../../../src/server/apiTypes';
import { shown } from '../../draft';
import { monName, speedOrderText, statusLabel } from '../../labels';
import type { LineRecord, SavedLine } from '../../line';
import { busyProps, workingText } from '../busy';
import { firstMatchup } from './firstMatchup';

export interface StartScreenProps {
  trainer: TrainerSummaryJson | undefined; sheet: SheetJson | null; sheetError: string | null; fight: { trainerId: string; variant: number };
  teamRefs: MonRef[]; draft: readonly DraftMonJson[]; options: DraftOptionsJson | null; mons: ReadonlyMap<MonRef, BoxMonJson>;
  box: BoxJson | null; saved: SavedLine[];
  /** A tree being opened (a start or a restore), and for `SLOW_MS` or more (`slow`): Stop (`onStop`) puts the start screen back. */
  busy: boolean; slow: boolean; onStop(): void;
  /** The tree Stop did not let open, offered again (`onAgain` opens it); null when there is none. */
  again: { fresh: boolean; record: LineRecord } | null; onAgain(): void;
  /** A trainer as the page names it: the fight a carried saved tree came from. */
  nameOf(trainerId: string): string;
  onLead(lead: MonRef): void; onOpen(line: SavedLine): void; onDelete(name: string): void;
}

/** The busy line while a plan starts: "Working out the first matchup…" (4.4's words; a plan has turns, not steps), with Stop once it is slow. */
function Working({ slow, onStop }: { slow: boolean; onStop(): void }) {
  return (
    <p className="tree-working">
      {workingText('the first matchup', slow)}
      {slow && <>{' '}<button type="button" className="button" onClick={onStop}>Stop</button></>}
    </p>
  );
}

/** The trainer's Pokémon, each over three lines: name, level, nature and ability; item; moves. */
function Theirs({ enemies }: { enemies: SheetMonJson[] }) {
  return (
    <ol className="start-theirs" aria-label="Their Pokémon">
      {enemies.map((e) => (
        <li key={e.key}>
          <span className="start-line"><strong>{e.name}</strong> Lv {e.level} · {e.nature ?? 'nature unknown'} · {e.ability}</span>
          <span className="start-line">{e.item ?? 'No item'}</span>
          <span className="start-line line-muted">{e.moves.join(', ')}</span>
        </li>
      ))}
    </ol>
  );
}

/** The item `mon` holds as shown: the draft's by name, the save's own name when the draft keeps the save's item, else (item N); null for none (id 0). */
function itemOf(mon: BoxMonJson, id: number, options: DraftOptionsJson | null): string | null {
  if (id === 0) return null;
  return options?.items.find((item) => item.id === id)?.name ?? (id === mon.draft?.item ? mon.item : `(item ${id})`);
}

export function StartScreen({
  trainer, sheet, sheetError, fight, teamRefs, draft, options, mons, box, saved, busy, slow, onStop, again, onAgain, nameOf, onLead, onOpen, onDelete,
}: StartScreenProps): JSX.Element {
  const same = sheet !== null && sheet.trainer.id === fight.trainerId && sheet.trainer.variant === fight.variant;
  const double = trainer?.battleType === 'double';
  const problem = box === null ? 'Reading the save…' : double ? "Double battles can't be built yet" : teamRefs.length === 0 ? 'Add a Pokémon to the team first' : null;
  const rows = teamRefs.flatMap((ref) => {
    const m = mons.get(ref);
    return m === undefined ? [] : [{ ref, m }];
  });
  return (
    <div className="line-start start" aria-busy={busy || undefined}>
      {busy && <Working slow={slow} onStop={onStop} />}
      {again !== null && (
        // What a new start would replace, said where the start buttons are, with the way back to it (7g's words).
        <section className="line-again" aria-label={again.fresh ? 'Carried tree' : 'Kept tree'}>
          <p>
            {again.fresh
              ? `The team carried from ${nameOf(again.record.start.carried?.start.trainerId ?? '')} did not come in.`
              : 'This fight has a kept tree. A new lead replaces it.'}{' '}
            <button type="button" className="button" disabled={box === null} onClick={onAgain}>
              {again.fresh ? 'Open the carried tree' : 'Open the kept tree'}
            </button>
          </p>
        </section>
      )}
      <section aria-label="Their Pokémon">
        <h3 tabIndex={-1}>Their Pokémon</h3>
        {/* Matchups says why a sheet did not load; here it is enough that it did not. */}
        {same
          ? <Theirs enemies={sheet.enemies} />
          : <p className="line-muted">{sheetError === null ? 'Loading their Pokémon…' : 'Their Pokémon did not load.'}</p>}
      </section>
      <section aria-label="Start the fight">
        <h3 tabIndex={-1}>Start the fight</h3>
        <ol className="start-team">
          {rows.map(({ ref, m }) => {
            const s = shown(m, options, draft.find((e) => e.ref === ref) ?? { ref });
            const item = itemOf(m, s.item, options);
            const matchup = firstMatchup(sheet, sheetError, fight, ref, s);
            return (
              // The row is the mouse's click target too; the button stays the one control for the keyboard
              // and readers, so a click on it is its own and is not counted twice. Text being selected is not a click.
              <li
                key={ref} className={problem === null ? 'start-pick' : undefined}
                onClick={(e) => {
                  if ((e.target as Element).closest('button') !== null || problem !== null || busy) return;
                  if (window.getSelection()?.type === 'Range') return;
                  onLead(ref);
                }}
              >
                <span className="start-line">
                  <strong>{monName(m)}</strong> Lv {s.level} · {s.hp}/{s.maxHp}
                  {s.status !== 'none' && ` · ${statusLabel(s.status)}`}
                  {item !== null && ` · ${item}`}
                </span>
                <span className="start-line line-muted">{s.moves.map((move) => move.name).join(' · ')}</span>
                {matchup.state === 'ready' && (
                  <>
                    <span className="start-line">
                      Against {matchup.enemy}: {speedOrderText(matchup.order, monName(m), matchup.enemy, matchup.playerSpeed, matchup.enemySpeed)}
                    </span>
                    {matchup.canKoInOne && <p className="start-danger">Can KO you in one hit</p>}
                  </>
                )}
                {matchup.state === 'loading' && <span className="start-line line-muted">Working out the first matchup…</span>}
                <button type="button" className="button" disabled={problem !== null} {...busyProps(busy, () => onLead(ref))}>
                  Start with {monName(m)}
                </button>
              </li>
            );
          })}
        </ol>
        {problem !== null && <p className="line-muted">{problem}</p>}
      </section>
      {saved.length > 0 && (
        <section aria-label="Saved trees">
          <h3 tabIndex={-1}>Saved trees</h3>
          <ul className="line-saved">
            {saved.map((s) => (
              <li key={s.name}>
                <span>
                  {s.name}
                  {s.start.carried !== undefined && <>{' '}<span className="line-muted">· carried from {nameOf(s.start.carried.start.trainerId)}</span></>}
                </span>
                <button type="button" className="button" disabled={box === null} {...busyProps(busy, () => onOpen(s))}>Open {s.name}</button>
                <button type="button" className="icon-button" aria-label={`Delete ${s.name}`} onClick={() => onDelete(s.name)}>×</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
