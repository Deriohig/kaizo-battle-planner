// The team slots, presentational: six places, the occupied ones holding a compact draggable row (keyed by its
// `MonRef`) whose ⋯ menu holds Try, Box, and Earlier and Later (reordering must work without a mouse). A drop on
// a slot is decided from `team`: a member moves there (`onMove`; on an empty slot, to the end), a member on its own slot
// changes nothing, and any other Pokémon `mons` knows goes to `onPlace` (the caller checks it can join; its occupant goes
// back to the box). While nothing is running the first slot says it leads: the order sets the default lead and "Start
// with" the actual one. One menu is open at a time, held here by `MonRef`, so Earlier and Later keep it open on the moved
// Pokémon, focus on the same item (useFocusFollow); after Box focus goes to the next row's ⋯ button. An empty slot is a
// quiet line, outlined only while a Pokémon is carried (run.css). How to drag sits behind the heading's ⓘ.

import { useId, useRef, useState } from 'react';
import type { BoxMonJson, MonRef } from '../../../../src/server/apiTypes';
import { MAX_TEAM } from '../../draft';
import { monName } from '../../labels';
import { CardMenu } from '../draft/CardMenu';
import { InfoTip } from '../InfoTip';
import { type FocusFollow, useFocusFollow } from './focusFollow';
import { MonCard } from './MonToken';
import { useDropZone } from './useDropZone';

export interface TeamSlotsProps {
  team: MonRef[];
  mons: ReadonlyMap<MonRef, BoxMonJson>;
  active: MonRef | null;
  fainted: readonly MonRef[];
  busy: boolean;
  onTry(ref: MonRef): void;
  onToBox(ref: MonRef): void;
  /** A box Pokémon dropped on slot `index`. */
  onPlace(index: number, ref: MonRef): void;
  /** Drag reorder, and Move earlier / later. */
  onMove(from: number, to: number): void;
  /** The Pokémon being carried, when the caller knows (a drag that started inside the box and team); a slot does not light for the member already on it. */
  dragged?: MonRef | null;
}

export const TEAM_TIP = 'The six you bring. Drag to reorder, to the box, or onto the turn.';

interface SlotProps extends TeamSlotsProps {
  index: number;
  mon: BoxMonJson | undefined;
  focus: FocusFollow;
  menuOpen: boolean;
  onMenu(ref: MonRef, open: boolean): void;
}

function Slot({ index, mon, team, mons, active, fainted, busy, onTry, onToBox, onPlace, onMove, focus, dragged, menuOpen, onMenu }: SlotProps) {
  const zone = useDropZone((ref) => {
    const from = team.indexOf(ref);
    if (from >= 0) {
      const to = Math.min(index, team.length - 1);
      if (to !== from) onMove(from, to);
      return;
    }
    if (mons.has(ref)) onPlace(index, ref);
  }, () => dragged == null || team[index] !== dragged);
  const className = ['slot', mon === undefined ? 'is-empty' : '', zone.over ? 'is-over' : ''].filter(Boolean).join(' ');
  if (mon === undefined) return <li className={className} {...zone.props}>Empty</li>;
  const name = monName(mon);
  const ref = mon.ref;
  return (
    <li className={className} {...zone.props}>
      <MonCard key={ref} mon={mon} active={active} fainted={fainted} tag={index === 0 && active === null ? 'Leads' : undefined}>
        <CardMenu
          name={name} open={menuOpen} onOpenChange={(open) => onMenu(ref, open)} triggerRef={focus.bind(ref, 'menu')}
          actions={[
            { text: 'Try', label: `Try ${name}`, busy, onSelect: () => onTry(ref) },
            {
              text: 'To box', label: `Put ${name} back in the box`,
              onSelect: (item) => {
                focus.leaving(ref, 'menu', item);
                onToBox(ref);
              },
            },
            {
              text: 'Earlier', label: `Move ${name} earlier`, disabled: index === 0, stays: true, itemRef: focus.bind(ref, 'earlier'),
              onSelect: (item) => {
                focus.moving(ref, 'earlier', 'later', item);
                onMove(index, index - 1);
              },
            },
            {
              text: 'Later', label: `Move ${name} later`, disabled: index >= team.length - 1, stays: true, itemRef: focus.bind(ref, 'later'),
              onSelect: (item) => {
                focus.moving(ref, 'later', 'earlier', item);
                onMove(index, index + 1);
              },
            },
          ]}
        />
      </MonCard>
    </li>
  );
}

export function TeamSlots(props: TeamSlotsProps) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const { team, mons } = props;
  const [menu, setMenu] = useState<MonRef | null>(null);
  // A Pokémon that left the team (a drag to the box) takes its open menu with it.
  if (menu !== null && !team.includes(menu)) setMenu(null);
  const focus = useFocusFollow(team, heading);
  const onMenu = (ref: MonRef, open: boolean) => setMenu((was) => (open ? ref : was === ref ? null : was));
  return (
    <section aria-labelledby={headingId} className="team-slots">
      <div className="box-and-team-head">
        <h3 id={headingId} ref={heading} tabIndex={-1}>{`Team (${team.length})`}</h3>
        <InfoTip label="Team">{TEAM_TIP}</InfoTip>
      </div>
      <ul>
        {Array.from({ length: MAX_TEAM }, (_, index) => {
          const ref = team[index];
          return (
            <Slot
              key={index} {...props} index={index} mon={ref === undefined ? undefined : mons.get(ref)} focus={focus}
              menuOpen={ref !== undefined && menu === ref} onMenu={onMenu}
            />
          );
        })}
      </ul>
    </section>
  );
}
