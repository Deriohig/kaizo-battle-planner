// One side's Pokémon on the plan's turn: a micro-label, the token (`MonToken`: the disc, the name and the level, said once, with no badge on the disc), its ability and item, the HP line
// over the damage band, and the mark.
// The band has no caption: the exchange under "Your action" says the numbers once. A bar the lowest roll empties
// is drawn red with "OHKO" on it (`bandKo`), never a plain black bar; a move with no numbers leaves the bar as it is.
// HP never changes: the line is the step's own (his "HP 44/44", theirs `hpBarText`). The name is always the plan's (who
// the turn has on the field); the step's Pokémon (`mon`) gives the numbers, and with none (no numbers yet, or none could
// be worked out) the card is the name alone, with no bar. The mark says it in words as well as the fade: the pill
// "fainted", and the button "Fainted · undo".
//
// With `onDropMon` the card is a drop target for a carried Pokémon (`useDropZone`): only a drag that
// carries one is claimed (`is-over`, and `dropLabel` in words while over it); a drop hands its ref on, and the caller
// decides whether it does anything.

import type { JSX, ReactNode } from 'react';
import type { LineMonJson, LineMoveDamageJson, MonRef } from '../../../../src/server/apiTypes';
import { hpBarText } from '../../tree';
import { busyProps } from '../busy';
import { BandBar, bandKo } from '../tree/DamageBand';
import { MonToken } from './parts';
import { useDropZone } from './useDropZone';

export interface MonCardProps {
  side: 'mine' | 'theirs';
  /** Who the plan has on the field: the pool's name, or the trainer's from `start.enemies`. */
  name: string;
  /** The step's Pokémon for this side; null when the turn has no numbers. */
  mon: LineMonJson | null;
  fainted: boolean;
  onToggleFainted(): void;
  /** While the turn's numbers are worked out the mark is held (`busyProps`). */
  busy: boolean;
  /** The other side's shown move: its band over this card's HP bar; null for none. */
  band: LineMoveDamageJson | null;
  /** The token's disc colour and level where the step gives none: his from the box Pokémon (types, level), theirs unknown (neutral). */
  types?: readonly string[];
  level?: number;
  /** A carried Pokémon dropped on the card. Without it the card is no drop target. */
  onDropMon?(ref: MonRef): void;
  /** Said on the card while a carried Pokémon is over it. */
  dropLabel?: string;
  /** The species' number (`LineMonJson.speciesId`, or the box's) for the token's sprite: his card shows the back view, theirs the front. Without it, the initials. */
  species?: number;
  /** Under the bar: the send-in picker, the trial strip. */
  children?: ReactNode;
}

export function MonCard({
  side, name, mon, fainted, onToggleFainted, busy, band, types, level, onDropMon, dropLabel, species, children,
}: MonCardProps): JSX.Element {
  const lv = mon?.level ?? level;
  const zone = useDropZone((ref) => onDropMon?.(ref));
  const target = onDropMon !== undefined;
  const over = target && zone.over;
  const className = ['plan-card', fainted ? 'is-fainted' : '', over ? 'is-over' : ''].filter((c) => c !== '').join(' ');
  return (
    <section
      className={className} data-side={side} aria-label={side === 'mine' ? 'Your Pokémon' : 'Their Pokémon'}
      {...(target ? zone.props : {})}
    >
      <p className="matchup-label">{side === 'mine' ? 'Your Pokémon' : 'Their Pokémon'}</p>
      {over && dropLabel !== undefined && <p className="plan-drop-label">{dropLabel}</p>}
      {lv === undefined ? (
        <span className="tok tok-l"><strong title={name}>{name}</strong></span>
      ) : (
        <MonToken name={name} level={lv} types={types ?? []} size="l" species={species} sprite={side === 'mine' ? 'back' : 'front'} badge={false} />
      )}
      {fainted && <span className="pill pill-danger">fainted</span>}
      {mon !== null && (
        <>
          <p className="plan-card-meta">{mon.ability} · {mon.item ?? 'no item'}</p>
          <p className="plan-card-hp">{side === 'mine' ? `HP ${mon.hp}/${mon.maxHp}` : hpBarText(mon)}</p>
          <span className="plan-card-bar">
            <BandBar move={band} percent={mon.percent} side={side} />
            {bandKo(band, mon.percent) && <span className="plan-card-ko">OHKO</span>}
          </span>
        </>
      )}
      <button
        type="button" className="button plan-mark" aria-pressed={fainted} aria-label={`Mark ${name} fainted`}
        {...busyProps(busy, onToggleFainted)}
      >
        {fainted ? 'Fainted · undo' : 'Mark fainted'}
      </button>
      {children}
    </section>
  );
}
