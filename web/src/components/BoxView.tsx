// The box: every party and box Pokémon as the planner reads the save, with its IVs, its moves' PP, HP, status, and why
// it cannot fight in words, in one group per place (the party, then each box) that opens with a heading row. A graveyard
// box's heading says it is always left out. "Eligible only" narrows it to the Pokémon the planner may use, and hides the
// groups left empty.
//
// Each group's heading also has "Copy party" or "Copy box" (named "Copy box N"), which puts the whole place's Showdown
// sets on the clipboard for PKCalc's Import box: every Pokémon there whatever "Eligible only" shows, a graveyard box's
// too, but eggs and the Pokémon with no set. A place with nothing to copy has no button.
//
// Each Pokémon's IVs show as six chips, coloured from 0 (red) to 31 (green) and always with the number, the nature's
// raised stat marked ↑ and its lowered one ↓; then their total and Hidden Power, and the EVs on a smaller line.

import { type CSSProperties, useId, useState } from 'react';
import type { BoxJson, BoxMonJson } from '../../../src/server/apiTypes';
import { monName, reasonLabel, statusLabel } from '../labels';
import { boxTeamText } from '../teamText';
import { CopyButton } from './CopyButton';

const COLUMNS = ['Where', 'Pokémon', 'Lv', 'Nature', 'IVs', 'Ability', 'Item', 'Moves', 'HP', 'Status', 'Eligible', 'Notes'];

const NONE = '—';

type Stat = keyof NonNullable<BoxMonJson['ivs']>;

/** The six stats in the order the box shows them, each with its label. */
const STATS: readonly { stat: Stat; label: string }[] = [
  { stat: 'hp', label: 'HP' }, { stat: 'atk', label: 'Atk' }, { stat: 'def', label: 'Def' },
  { stat: 'spa', label: 'SpA' }, { stat: 'spd', label: 'SpD' }, { stat: 'spe', label: 'Spe' },
];

/** Where a Pokémon is: the party, or a box by its number (1-based). */
type Place = number | 'party';

/** A place's Pokémon in box order, and whether it is a graveyard box. */
interface Group {
  place: Place;
  graveyard: boolean;
  mons: BoxMonJson[];
}

const placeOf = (m: BoxMonJson): Place => m.box ?? 'party';

const placeName = (place: Place) => (place === 'party' ? 'Party' : `Box ${place}`);

/** `mons` (in box order: the party, then box 1 to 18) as one group per place, in that order. */
function groupsOf(mons: readonly BoxMonJson[], graveyardBoxes: readonly number[]): Group[] {
  const groups = new Map<Place, Group>();
  for (const m of mons) {
    const place = placeOf(m);
    let group = groups.get(place);
    if (group === undefined) {
      group = { place, graveyard: place !== 'party' && graveyardBoxes.includes(place), mons: [] };
      groups.set(place, group);
    }
    group.mons.push(m);
  }
  return [...groups.values()];
}

function where(m: BoxMonJson): string {
  return m.location === 'party' ? `Party ${m.slot}` : `Box ${m.box}, slot ${m.slot}`;
}

/**
 * A group's heading row: its name, then for a graveyard box that it is left out; then its copy button, which copies
 * `team` (the whole place's sets) and is left out when `team` is empty.
 */
function GroupHeading({ group, team }: { group: Group; team: string }) {
  const name = placeName(group.place);
  const party = group.place === 'party';
  const inWords = party ? 'the party' : name;
  return (
    <tr className="box-group">
      <th scope="rowgroup" colSpan={2}>{name}</th>
      <td colSpan={COLUMNS.length - 2}>
        <div className="box-group-tools">
          {group.graveyard && <span className="box-graveyard">Graveyard: always left out</span>}
          {team !== '' && (
            <CopyButton
              text={team} label={party ? 'Copy party' : 'Copy box'} name={party ? undefined : `Copy box ${group.place}`}
              title={`Copy every Pokémon in ${inWords} as Showdown import text, for PKCalc's Import box. Eggs, and Pokémon with a species or move the planner cannot name, are left out.`}
            />
          )}
        </div>
      </td>
    </tr>
  );
}

/** The nature's mark on a stat: an arrow to see, and words for a screen reader. */
function NatureMark({ arrow, words }: { arrow: string; words: string }) {
  return (
    <>
      <span aria-hidden="true">{arrow}</span>
      <span className="visually-hidden"> {words}</span>
    </>
  );
}

/**
 * The IVs as six chips, each with its number and coloured by it (`--iv`), the nature's raised and lowered stats marked;
 * then the IV total and Hidden Power, and the EVs on a smaller line. "—" for an unreadable Pokémon, which has no IVs.
 */
function IvCell({ mon }: { mon: BoxMonJson }) {
  const { ivs, evs, hiddenPower, natureEffect } = mon;
  if (ivs === null) return NONE;
  const total = STATS.reduce((sum, { stat }) => sum + ivs[stat], 0);
  return (
    <>
      <div className="box-ivs">
        {STATS.map(({ stat, label }) => (
          <span key={stat} className="box-iv" style={{ '--iv': ivs[stat] } as CSSProperties}>
            {label} {ivs[stat]}
            {natureEffect?.up === stat && <NatureMark arrow="↑" words="raised by the nature" />}
            {natureEffect?.down === stat && <NatureMark arrow="↓" words="lowered by the nature" />}
          </span>
        ))}
      </div>
      <div className="box-iv-summary">
        <span>Total {total}</span>
        {hiddenPower !== null && <span>Hidden Power {hiddenPower.type} {hiddenPower.power}</span>}
      </div>
      {evs !== null && <div className="box-evs">EVs {STATS.map(({ stat }) => evs[stat]).join(' / ')}</div>}
    </>
  );
}

/** One Pokémon's row. */
function BoxRow({ mon }: { mon: BoxMonJson }) {
  const unwell = mon.status !== null;
  return (
    <tr className={mon.eligible ? undefined : 'is-ineligible'}>
      <td className="box-where">{where(mon)}</td>
      <td className="box-name">{monName(mon)}</td>
      <td className="box-num">{mon.level > 0 ? mon.level : NONE}</td>
      <td>{mon.nature ?? NONE}</td>
      <td><IvCell mon={mon} /></td>
      <td>{mon.ability || NONE}</td>
      <td>{mon.item ?? NONE}</td>
      <td>
        {mon.moves.length === 0 ? NONE : (
          <ul className="box-moves">
            {mon.moves.map((move, k) => (
              <li key={k}>{move.name} <span className="box-pp">{move.pp}/{move.maxPp}</span></li>
            ))}
          </ul>
        )}
      </td>
      <td className="box-num">{mon.maxHp > 0 ? `${mon.hp}/${mon.maxHp}` : NONE}</td>
      <td className={unwell ? 'box-status is-unwell' : 'box-status'}>{statusLabel(mon.status)}</td>
      <td>
        {mon.eligible ? <span className="box-yes">Yes</span> : (
          <ul className="box-reasons">
            {mon.ineligibleReasons.map((reason) => <li key={reason}>{reasonLabel(reason)}</li>)}
          </ul>
        )}
      </td>
      <td>
        {mon.notes.length > 0 && (
          <ul className="box-notes">
            {mon.notes.map((note, k) => <li key={k}>{note}</li>)}
          </ul>
        )}
      </td>
    </tr>
  );
}

export function BoxView({ box }: { box: BoxJson }) {
  const [eligibleOnly, setEligibleOnly] = useState(false);
  const titleId = useId();
  const eligible = box.mons.filter((m) => m.eligible);
  const shown = eligibleOnly ? eligible : box.mons;
  // Each place's copy takes the whole place, whatever the filter shows.
  const teams = new Map(groupsOf(box.mons, box.graveyardBoxes).map((group) => [group.place, boxTeamText(group.mons)]));

  return (
    <section className="box" aria-labelledby={titleId}>
      <div className="box-toolbar">
        <h2 id={titleId}>Box</h2>
        <p className="box-count">{eligible.length} of {box.mons.length} can fight</p>
        <label className="box-filter">
          <input type="checkbox" checked={eligibleOnly} onChange={(e) => setEligibleOnly(e.target.checked)} />
          {' '}Eligible only
        </label>
      </div>
      <div className="box-scroll">
        <table className="box-table">
          <thead>
            <tr>{COLUMNS.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
          </thead>
          {groupsOf(shown, box.graveyardBoxes).map((group) => (
            <tbody key={group.place}>
              <GroupHeading group={group} team={teams.get(group.place) ?? ''} />
              {group.mons.map((m) => <BoxRow key={m.ref} mon={m} />)}
            </tbody>
          ))}
        </table>
      </div>
      {shown.length === 0 && <p className="box-empty">{eligibleOnly ? 'No Pokémon in the save can fight.' : 'The save holds no Pokémon.'}</p>}
    </section>
  );
}
