// A Pokémon as a token: a round disc in its first type's colour holding its initials and a level badge, then its name and
// level. The disc is decoration (`aria-hidden`), so the accessible text is the name and level alone; the name
// carries a `title`, as it ellipsises (on the box and team rows it wraps instead, run.css, and the row carries the whole
// name and level as its own accessible name). `--tc` is the type's colour from run.css (`--type-*`), falling back to the unknown
// colour. `MonCard` is the draggable row the box tray and the team slots show: the token with one level (no
// badge), the run state as a mark (an accent edge for the one on the field, struck and dimmed when fainted, the words kept
// for readers), a short tag, then the row's ⋯ menu.

import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { BoxMonJson, MonRef } from '../../../../src/server/apiTypes';
import { monLabel, monName } from '../../labels';
import { writeDraggedMon } from '../../monDrag';
import { type SpriteKind, spriteUrls } from '../../sprites';

export interface MonTokenProps {
  name: string;
  level: number;
  types: readonly string[];
  size?: 's' | 'm' | 'l';
  /** A word after the level, such as "over cap". */
  note?: string;
  /** The key the sprite route takes: the national dex number (`speciesId`). Without it, at 0, or when the image fails, the disc shows the initials. */
  species?: string | number;
  /** Size `l` only: the front view (default) or the game-style back view. Sizes `s` and `m` show the icon. */
  sprite?: 'front' | 'back';
  /** The form's sprite (`formId`); 0 or none is the species' own. A form the server lacks falls back to the species' sprite. */
  form?: number;
  /** The shiny colours (front and back; icons have none). */
  shiny?: boolean;
  /** The level badge on the disc (default on). Off where the level is said beside the name, so it is shown once. */
  badge?: boolean;
}

export function MonToken({ name, level, types, size = 'm', note, species, sprite = 'front', form, shiny, badge = true }: MonTokenProps) {
  const kind: SpriteKind = size === 'l' ? sprite : 'icon';
  // 0 (and '') is "no species": the server's `speciesId` for an unreadable record.
  const urls = species === undefined || species === 0 || species === '' ? [] : spriteUrls(kind, species, { form, shiny });
  // The srcs that failed to load: the next one is tried, then the initials. A new species gives new srcs, which try again.
  const [failed, setFailed] = useState<readonly string[]>([]);
  const src = urls.find((url) => !failed.includes(url)) ?? null;
  const showImg = src !== null;
  const first = (types[0] ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const style = { '--tc': first === '' ? 'var(--type-unknown)' : `var(--type-${first}, var(--type-unknown))` } as CSSProperties;
  return (
    <span className={`tok tok-${size}`} style={style}>
      <span className="disc" aria-hidden="true">
        {showImg ? (
          <img
            key={src}
            className={kind === 'icon' ? 'spr spr-icon' : 'spr'}
            src={src}
            alt=""
            draggable={false}
            decoding="async"
            width={kind === 'icon' ? 32 : 80}
            height={kind === 'icon' ? 32 : 80}
            onError={() => setFailed((was) => (was.includes(src) ? was : [...was, src]))}
          />
        ) : (
          Array.from(name).slice(0, 2).join('')
        )}
        {badge && <em>{level}</em>}
      </span>
      <strong title={name}>{name}</strong>
      <small>{note === undefined ? `Lv ${level}` : `Lv ${level} · ${note}`}</small>
    </span>
  );
}

/** The note a token carries for a Pokémon over the level cap (`ineligibleReasons` keeps "over cap" for one that can still join). */
export const overCapNote = (m: BoxMonJson): string | undefined => (m.ineligibleReasons.includes('over cap') ? 'over cap' : undefined);

export interface MonCardProps {
  mon: BoxMonJson;
  /** The Pokémon on the field while a fight runs: its row has the accent edge and says so to readers. */
  active: MonRef | null;
  /** The fainted ones: the name struck and the row dimmed, and it says so to readers. Neither holds Try. */
  fainted: readonly MonRef[];
  /** A short word on the row before its menu ("Leads"). */
  tag?: string;
  /** The row's ⋯ menu (CardMenu): its button and, while open, its strip. */
  children: ReactNode;
}

/**
 * The box Pokémon's sprite key: `BoxMonJson.speciesId` (the national dex number), read
 * structurally; 0 or missing is no sprite.
 */
export const spriteSpecies = (m: BoxMonJson): number | undefined => {
  const id = (m as BoxMonJson & { speciesId?: number }).speciesId;
  return id === undefined || id === 0 ? undefined : id;
};

/** The box Pokémon's form and shininess for its sprite (`BoxMonJson.formId`, `shiny`), read the same way. */
export const spriteLook = (m: BoxMonJson): { form?: number; shiny?: boolean } => {
  const { formId, shiny } = m as BoxMonJson & { formId?: number; shiny?: boolean };
  return { ...(formId === undefined ? {} : { form: formId }), ...(shiny === true ? { shiny: true } : {}) };
};

/** A draggable row: dragging it carries the Pokémon (web/src/monDrag.ts). */
export function MonCard({ mon, active, fainted, tag, children }: MonCardProps) {
  const down = fainted.includes(mon.ref);
  const onField = active === mon.ref;
  const className = ['mon-row', onField ? 'is-active' : '', down ? 'is-fainted' : ''].filter(Boolean).join(' ');
  return (
    <div role="group" aria-label={monLabel(mon)} draggable="true" className={className} onDragStart={(e) => writeDraggedMon(e, mon.ref)}>
      <MonToken name={monName(mon)} level={mon.level} types={mon.types} note={overCapNote(mon)} species={spriteSpecies(mon)} badge={false} {...spriteLook(mon)} />
      {onField && <small className="visually-hidden">On the field</small>}
      {down && <small className="visually-hidden">Fainted</small>}
      {tag !== undefined && <small className="mon-row-tag">{tag}</small>}
      {children}
    </div>
  );
}
