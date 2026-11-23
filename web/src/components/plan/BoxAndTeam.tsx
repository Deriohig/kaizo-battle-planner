// The box and the team, the plan page's left column: the draft-wired wrapper round the box tray and the six
// team slots (both presentational), with a band toggle. It builds the tray's list (every Pokémon that can join
// and is not on the team, the party's first, then the boxes), the `mons` map and `teamFull`, and wires the draft: Team
// adds, a drop on the tray takes a team member off, a drop on a slot places a Pokémon that can join, and a reorder moves.
// While a Pokémon is carried (its `dragstart` to its `dragend` or a `drop`) the root has `is-dragging`; each zone marks
// itself `is-over` (useDropZone). The state is cleared by a once-only native `dragend` on the carried card too, which
// still fires when the card has unmounted mid-drag, and drops when the box changes. Between 960 and 1179 px the two sit
// side by side and the toggle (run.css shows it only there) hides them, kept per viewer in `localStorage`; from 1180 px
// they stack and the kept choice does not apply. `readDraggedMon` (web/src/monDrag.ts) is for any other drop target on the
// page, such as the turn's "Your Pokémon".

import { useEffect, useId, useMemo, useState } from 'react';
import type { BoxJson, BoxMonJson, MonRef } from '../../../../src/server/apiTypes';
import { canJoin, MAX_TEAM } from '../../draft';
import { carriesMon, readDraggedMon } from '../../monDrag';
import type { UseDraft } from '../../useDraft';
import { BoxTray } from './BoxTray';
import { TeamSlots } from './TeamSlots';

export interface BoxAndTeamProps {
  box: BoxJson;
  draft: UseDraft;
  active: MonRef | null;
  fainted: readonly MonRef[];
  busy: boolean;
  onTry(ref: MonRef): void;
}

export const TRAY_HIDDEN_KEY = 'pkp.plan.trayHidden';
const NARROW = '(max-width: 1179px)';

/** Where a Pokémon is kept, as an order: party slots, then box by box. */
const place = (m: BoxMonJson): [number, number, number] => (m.location === 'party' ? [0, 0, m.slot] : [1, m.box ?? 0, m.slot]);

/** What the tray lists: every Pokémon that can join and is not on the team, the party's first, then the boxes in order. */
export function trayMons(box: BoxJson, team: readonly MonRef[]): BoxMonJson[] {
  return box.mons
    .filter((m) => canJoin(m) && !team.includes(m.ref))
    .sort((a, b) => {
      const [pa, pb] = [place(a), place(b)];
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    });
}

function readHidden(): boolean {
  try {
    return localStorage.getItem(TRAY_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(TRAY_HIDDEN_KEY, '1');
    else localStorage.removeItem(TRAY_HIDDEN_KEY);
  } catch {
    // No storage: the choice just is not kept.
  }
}

/** Whether the viewport is in the band where the toggle shows (true without `matchMedia`). */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => (typeof matchMedia === 'function' ? matchMedia(NARROW).matches : true));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const query = matchMedia(NARROW);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

export function BoxAndTeam({ box, draft, active, fainted, busy, onTry }: BoxAndTeamProps) {
  const [hidden, setHidden] = useState(readHidden);
  // The box a drag started under: a new box ends the dragging state with no effect needed.
  const [drag, setDrag] = useState<{ box: BoxJson; ref: MonRef | null } | null>(null);
  const dragging = drag?.box === box;
  const dragged = dragging ? drag.ref : null;
  const narrow = useNarrow();
  const bodyId = useId();
  const shown = !(hidden && narrow);
  const mons = useMemo(() => new Map<MonRef, BoxMonJson>(box.mons.map((m) => [m.ref, m])), [box]);
  const toBox = (ref: MonRef) => {
    if (draft.team.includes(ref)) draft.remove(ref);
  };
  return (
    <div
      className={dragging ? 'box-and-team is-dragging' : 'box-and-team'}
      onDragStart={(e) => {
        if (!carriesMon(e)) return;
        setDrag({ box, ref: readDraggedMon(e) });
        e.target.addEventListener('dragend', () => setDrag(null), { once: true });
      }}
      onDragEnd={() => setDrag(null)}
      onDrop={() => setDrag(null)}
    >
      <button
        type="button" className="box-and-team-toggle" aria-expanded={!hidden} aria-controls={bodyId}
        onClick={() => { writeHidden(!hidden); setHidden(!hidden); }}
      >
        {hidden ? 'Show box and team' : 'Hide box and team'}
      </button>
      <div id={bodyId} className="box-and-team-body">
        {shown && (
          <BoxTray
            mons={trayMons(box, draft.team)} active={active} fainted={fainted} busy={busy} teamFull={draft.team.length >= MAX_TEAM}
            onTry={onTry} onToTeam={(ref) => draft.add(ref)} onToBox={toBox}
            team={draft.team} dragged={dragged}
          />
        )}
        {shown && (
          <TeamSlots
            team={draft.team} mons={mons} active={active} fainted={fainted} busy={busy}
            onTry={onTry} onToBox={toBox} dragged={dragged}
            onPlace={(index, ref) => {
              const m = mons.get(ref);
              if (m !== undefined && canJoin(m)) draft.place(index, ref);
            }}
            onMove={(from, to) => draft.moveTo(from, to)}
          />
        )}
      </div>
    </div>
  );
}
