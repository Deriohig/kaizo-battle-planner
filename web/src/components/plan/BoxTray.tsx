// The box tray, presentational: it lists `mons` as given (BoxAndTeam passes every Pokémon that can join and is
// not on the team, the party's first). Each is a compact draggable row whose ⋯ menu holds Try and Team ("Add
// <name> to the team"); Team is disabled with the reason while the team is full. One menu is open at a time. The whole
// tray is a drop zone: any valid ref dropped calls `onToBox`, and the caller decides (a team member comes off the team,
// anything else changes nothing). Busy only holds Try: a draft edit never waits on the server. After Team,
// focus goes to the next row's ⋯ button (useFocusFollow). How to drag sits behind the heading's ⓘ.

import { useId, useRef, useState } from 'react';
import type { BoxMonJson, MonRef } from '../../../../src/server/apiTypes';
import { MAX_TEAM } from '../../draft';
import { monName } from '../../labels';
import { CardMenu } from '../draft/CardMenu';
import { InfoTip } from '../InfoTip';
import { useFocusFollow } from './focusFollow';
import { MonCard } from './MonToken';
import { useDropZone } from './useDropZone';

export interface BoxTrayProps {
  mons: BoxMonJson[];
  active: MonRef | null;
  fainted: readonly MonRef[];
  busy: boolean;
  /** The team has `MAX_TEAM`: Team is disabled. */
  teamFull: boolean;
  onTry(ref: MonRef): void;
  onToTeam(ref: MonRef): void;
  /** A Pokémon dropped on the tray (any valid ref; the caller checks it is on the team). */
  onToBox(ref: MonRef): void;
  /** The Pokémon being carried, when the caller knows (a drag that started inside the box and team); with `team`, the tray then lights only for a team member. Left out, any drag lights it. */
  dragged?: MonRef | null;
  team?: readonly MonRef[];
}

export const BOX_TIP = 'Drag into a team slot, or onto “Your Pokémon” to try it on this turn.';

export function BoxTray({ mons, active, fainted, busy, teamFull, onTry, onToTeam, onToBox, dragged, team }: BoxTrayProps) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [menu, setMenu] = useState<MonRef | null>(null);
  // A Pokémon that left the tray (a drag to a slot) takes its open menu with it.
  if (menu !== null && !mons.some((m) => m.ref === menu)) setMenu(null);
  const focus = useFocusFollow(mons.map((m) => m.ref), heading);
  const zone = useDropZone(onToBox, () => dragged == null || team === undefined || team.includes(dragged));
  return (
    <section aria-labelledby={headingId} className={zone.over ? 'box-tray is-over' : 'box-tray'} {...zone.props}>
      <div className="box-and-team-head">
        <h3 id={headingId} ref={heading} tabIndex={-1}>{`Box (${mons.length})`}</h3>
        <InfoTip label="Box">{BOX_TIP}</InfoTip>
      </div>
      <ul>
        {mons.map((m) => {
          const name = monName(m);
          return (
            <li key={m.ref}>
              <MonCard mon={m} active={active} fainted={fainted}>
                <CardMenu
                  name={name} open={menu === m.ref} triggerRef={focus.bind(m.ref, 'menu')}
                  onOpenChange={(open) => setMenu((was) => (open ? m.ref : was === m.ref ? null : was))}
                  actions={[
                    { text: 'Try', label: `Try ${name}`, busy, onSelect: () => onTry(m.ref) },
                    {
                      text: 'Add to team', label: `Add ${name} to the team`, disabled: teamFull,
                      title: teamFull ? `The team is full (${MAX_TEAM})` : undefined,
                      onSelect: (item) => {
                        focus.leaving(m.ref, 'menu', item);
                        onToTeam(m.ref);
                      },
                    },
                  ]}
                />
              </MonCard>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
