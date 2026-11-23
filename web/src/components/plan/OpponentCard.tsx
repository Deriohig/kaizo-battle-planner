// The opponent card (first in the right column): the trainer's Pokémon on the
// field this turn as the sheet has it (level, said once beside the name; ability, item, moves and stats), then their team in party order, each with
// its level or the word "fainted" as this turn has it. Theirs carry no types, so their tokens are neutral. The
// roster is not clickable: who comes in is picked on their card. Without the sheet, the names alone, and while this
// trainer's sheet is on its way a plain loading line (PlanView passes only this trainer's sheet, never the last one's).

import { type JSX, useState } from 'react';
import type { SheetJson } from '../../../../src/server/apiTypes';
import { spriteUrls } from '../../sprites';
import { MonToken } from './parts';

const NO_TYPES: readonly string[] = [];

/** A roster chip's disc: the icon (the form's, else the species') when the sheet names the species, else the initials (and when the images fail). */
function RosterDisc({ name, species, form }: { name: string; species: number | undefined; form: number | undefined }): JSX.Element {
  const urls = species === undefined || species === 0 ? [] : spriteUrls('icon', species, { form });
  const [failed, setFailed] = useState<readonly string[]>([]);
  const src = urls.find((url) => !failed.includes(url)) ?? null;
  return (
    <span className="disc" aria-hidden="true">
      {src !== null ? (
        <img
          key={src} className="spr spr-icon" src={src} alt="" draggable={false} decoding="async"
          width={32} height={32} onError={() => setFailed((was) => (was.includes(src) ? was : [...was, src]))}
        />
      ) : Array.from(name).slice(0, 2).join('')}
    </span>
  );
}

export function OpponentCard({ enemies, sheet, loading = false, active, fainted, activeSpecies }: {
  /** Their Pokémon's names in party order (the plan's `start.enemies`). */
  enemies: readonly string[];
  /** This trainer's sheet; null while it loads or when it did not. */
  sheet: SheetJson | null;
  /** This trainer's sheet is on its way. */
  loading?: boolean;
  /** Who is theirs on the field this turn; null for none. */
  active: number | null;
  /** Who is marked fainted as of this turn. */
  fainted: readonly number[];
  /** The active one's species number as this turn's step has it (`LineMonJson.speciesId`); used only when the sheet's own `speciesId` is missing. */
  activeSpecies?: number;
}): JSX.Element {
  const mon = active === null ? undefined : sheet?.enemies[active];
  const name = active === null ? undefined : enemies[active];
  return (
    <section className="plan-pan plan-opponent" aria-label="Opponent">
      <h3>Opponent</h3>
      {loading && sheet === null && <p className="line-muted">Loading their details…</p>}
      {name !== undefined && (
        <div className="plan-opponent-active">
          {mon === undefined ? (
            <span className="tok tok-l"><strong title={name}>{name}</strong></span>
          ) : (
            <>
              <MonToken name={name} level={mon.level} types={NO_TYPES} size="l" species={mon.speciesId ?? activeSpecies} form={mon.formId} sprite="front" badge={false} />
              <p className="plan-opponent-pills">
                <span className="pill">{mon.ability}</span>
                {mon.item !== null && <span className="pill">holds {mon.item}</span>}
              </p>
              <p className="plan-opponent-moves">Moves: {mon.moves.join(' · ')}</p>
              <p className="plan-opponent-stats">
                HP {mon.stats.hp} · Atk {mon.stats.atk} · Def {mon.stats.def} · SpA {mon.stats.spa} · SpD {mon.stats.spd} · Spe {mon.stats.spe}
              </p>
            </>
          )}
        </div>
      )}
      <ul aria-label="Their team" className="plan-roster">
        {enemies.map((enemy, i) => {
          const down = fainted.includes(i);
          const on = i === active;
          const sheetMon = sheet?.enemies[i];
          const level = sheetMon?.level;
          const cls = [on ? 'selected' : '', down ? 'is-fainted' : ''].filter((c) => c !== '').join(' ') || undefined;
          return (
            <li key={`${i}|${enemy}`} className={cls} aria-current={on ? 'true' : undefined}>
              <span className="tok tok-s">
                <RosterDisc name={enemy} species={sheetMon?.speciesId ?? (on ? activeSpecies : undefined)} form={sheetMon?.formId} />
                <strong title={enemy}>{enemy}</strong>
              </span>
              {' '}
              {down ? <small className="is-fainted">fainted</small> : level !== undefined && <small>Lv {level}</small>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
