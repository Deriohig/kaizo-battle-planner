// The team column: the team the player plans the next fight with (useDraft), the save's party at first. A row is one line at
// one height: the Pokémon's name, its level in a field to type a new one in, the HP it starts the fight on,
// Edit, and a ⋯ menu (CardMenu) with Move up, Move down and Remove. Under that line, only when there are any, its marks:
// its status, what the entry changes from the save ("Changed: Lv 22, HP 1/61 and burned", from `changesOf`), and "over
// the level cap (16)" on one whose level is over the cap (it may join); all as the fight will start it (`shown`: the save
// with the entry's edits). The order of the rows is the default order of the fight (the lead is chosen on the start
// screen); Move up and down keep the menu open on the moved row. Edit opens that Pokémon's editor under its row, one at a
// time, and the editor's Close shuts it. Any box Pokémon that can join comes in from the add row, up to six (the row says
// so when nobody else can; a full team just has no add row). Under the team, one button raises everyone below the level
// cap to it, one sets everyone's HP to its max (an edit, so those rows say Changed), and one puts the save's party back.
// Above it, a save change that reset the team says so, with one Undo, and a fight the server refused to start says why.
// It is for planning only: the save is never changed, as the heading's ⓘ says.

import { useId, useState, type JSX } from 'react';
import type { BoxJson, BoxMonJson, DraftMonJson, MonRef } from '../../../src/server/apiTypes';
import { MAX_LEVEL } from '../../../src/server/draftRules';
import { allToCap, baseline, canJoin, isEdited, MAX_TEAM, type Options, shown } from '../draft';
import { monLabel, monName, statusLabel } from '../labels';
import type { UseDraft } from '../useDraft';
import { CardMenu } from './draft/CardMenu';
import { changedText, changesOf } from './draft/changes';
import { DraftEditor } from './draft/DraftEditor';
import { NumberField } from './draft/NumberField';
import { InfoTip } from './InfoTip';

/** Over the level cap, as the server judges it from the save: it may join the team, marked. */
const overCap = (m: BoxMonJson): boolean => m.ineligibleReasons.includes('over cap');

/** Whether the team is the save's party in slot order with no edits (`baseline`). */
function atBaseline(box: BoxJson, mons: DraftMonJson[]): boolean {
  const party = baseline(box);
  return mons.length === party.length && mons.every((entry, i) => !isEdited(entry) && entry.ref === party[i]!.ref);
}

/**
 * Whether "All to the level cap" would change nothing: nobody in the team, or nobody `allToCap` raises. It hands back the
 * very entry for each member it leaves (at or above the cap, or a raise the rules refuse), and a new one for a raise.
 */
function nothingToRaise(box: BoxJson, options: Options, mons: DraftMonJson[]): boolean {
  return allToCap(box, options, mons).every((entry, i) => entry === mons[i]);
}

/** Whether "All to full HP" would change nothing: every row's shown HP is its max HP (nobody in the team included). */
function allFull(box: BoxJson, options: Options, mons: DraftMonJson[]): boolean {
  return mons.every((entry) => {
    const m = box.mons.find((mon) => mon.ref === entry.ref);
    if (m === undefined || !canJoin(m)) return true;
    const s = shown(m, options, entry);
    return s.hp === s.maxHp;
  });
}

export function TeamPanel({ box, boxProblem, draft, problem }: {
  box: BoxJson | null;
  /** Why there is no box (the save did not read); null while it is being read. */
  boxProblem: string | null;
  draft: UseDraft;
  /** Why the server refused to start the fight, in words; null when it did not. */
  problem: string | null;
}): JSX.Element {
  return (
    <aside className="team-panel" aria-label="Team for this fight">
      <div className="team-panel-head">
        <h2 className="team-panel-heading">Team for this fight</h2>
        <InfoTip label="Team for this fight">For planning only. Your save is not changed.</InfoTip>
      </div>
      {draft.replaced !== null && (
        <div className="banner banner-warn team-panel-notice" role="status" aria-label="Your save changed">
          <span>Your save changed, so the team was reset to it.</span>
          <button type="button" className="button" onClick={draft.replaced.undo}>Undo</button>
        </div>
      )}
      {problem !== null && <p className="banner banner-danger" role="alert"><strong>The fight did not start.</strong> {problem}</p>}
      {box === null ? (
        boxProblem === null
          ? <p className="app-loading">Reading the save…</p>
          : <p className="team-panel-note">{`The save did not read: ${boxProblem}`}</p>
      ) : (
        <>
          <Members box={box} draft={draft} />
          <div className="team-panel-tools">
            <button type="button" className="button" disabled={nothingToRaise(box, draft.options, draft.mons)} onClick={draft.toCap}>
              {`All to the level cap (${box.levelCap})`}
            </button>
            <button type="button" className="button" disabled={allFull(box, draft.options, draft.mons)} onClick={draft.toFull}>All to full HP</button>
            <button type="button" className="button" disabled={atBaseline(box, draft.mons)} onClick={draft.resetAll}>Reset to save</button>
          </div>
          {draft.team.length < MAX_TEAM && <AddRow box={box} team={draft.team} onAdd={draft.add} />}
        </>
      )}
    </aside>
  );
}

/**
 * The team in order, each row with its level field, facts, marks and buttons, and the open editor under its row; or that
 * nobody is in it.
 */
function Members({ box, draft }: { box: BoxJson; draft: UseDraft }) {
  // Whose editor is open. A Pokémon that leaves the team closes it (set during the render, as useDraft takes a box).
  const [open, setOpen] = useState<MonRef | null>(null);
  // Whose ⋯ menu is open: one at a time.
  const [menu, setMenu] = useState<MonRef | null>(null);
  // Why a typed level snapped back, with the entry it was said for: a change to that entry, or typing in that field
  // again, takes it away.
  const [said, setSaid] = useState<{ ref: MonRef; text: string; entry: DraftMonJson } | null>(null);
  if (open !== null && !draft.team.includes(open)) setOpen(null);
  if (menu !== null && !draft.team.includes(menu)) setMenu(null);
  if (draft.mons.length === 0) return <p className="team-panel-note">Nobody is in the team. Add a Pokémon to start a fight.</p>;
  const byRef = new Map(box.mons.map((m) => [m.ref, m]));
  const last = draft.mons.length - 1;
  return (
    <ol className="team-panel-list" aria-label="Team">
      {draft.mons.map((entry, i) => {
        const { ref } = entry;
        const m = byRef.get(ref);
        if (m === undefined || !canJoin(m)) return null;
        const name = monName(m);
        const s = shown(m, draft.options, entry);
        const editing = open === ref;
        const changed = changedText(changesOf(m, draft.options, entry));
        const levelSaid = said !== null && said.ref === ref && said.entry === entry ? said.text : null;
        return (
          <li key={ref} className="team-panel-row">
            <span className="team-panel-name">{name}</span>
            {/* The field's change events bubble here: typing in it again takes this row's line away (a commit of the
                level it already shows sends nothing, so it would otherwise stay). */}
            <span className="team-panel-level" onChange={() => setSaid((was) => (was !== null && was.ref === ref ? null : was))}>
              <span aria-hidden="true">Lv</span>
              <NumberField
                label={`Level of ${name}`} value={s.level} min={1} max={MAX_LEVEL}
                onCommit={(level) => {
                  const refused = draft.edit(ref, { level });
                  setSaid(refused === null ? null : { ref, text: refused, entry });
                  return refused === null;
                }}
                onInvalid={() => setSaid({ ref, text: `Level must be 1 to ${MAX_LEVEL}.`, entry })}
              />
            </span>
            <span className="team-panel-fact">{`HP ${s.hp}/${s.maxHp}`}</span>
            <button
              type="button" className="button button-sm team-panel-edit" aria-label={`Edit ${name}`} aria-expanded={editing}
              onClick={() => setOpen(editing ? null : ref)}
            >
              Edit
            </button>
            {/* The ⋯ button ends the line; its open menu wraps onto a line of its own under it (run.css). */}
            <CardMenu
              name={name} open={menu === ref} onOpenChange={(o) => setMenu((was) => (o ? ref : was === ref ? null : was))}
              actions={[
                { text: 'Move up', label: `Move ${name} up`, disabled: i === 0, stays: true, onSelect: () => draft.move(i, -1) },
                { text: 'Move down', label: `Move ${name} down`, disabled: i === last, stays: true, onSelect: () => draft.move(i, 1) },
                { text: 'Remove', label: `Remove ${name}`, onSelect: () => draft.remove(ref) },
              ]}
            />
            {(s.status !== 'none' || changed !== null || s.level > box.levelCap) && (
              <span className="team-panel-marks">
                {s.status !== 'none' && <span className="team-panel-fact">{statusLabel(s.status)}</span>}
                {changed !== null && <span className="pill team-panel-changed">{changed}</span>}
                {s.level > box.levelCap && <span className="pill team-panel-over">{`over the level cap (${box.levelCap})`}</span>}
              </span>
            )}
            {levelSaid !== null && <p className="team-panel-alert" role="alert">{levelSaid}</p>}
            {editing && (
              <DraftEditor
                mon={m} entry={entry} options={draft.options} optionsProblem={draft.optionsProblem}
                onRetryOptions={draft.retryOptions} onEdit={(patch) => draft.edit(ref, patch)} onReset={() => draft.reset(ref)}
                onClose={() => setOpen(null)}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Every box Pokémon that can join and is not in the team, in the box's order, to pick and add; one muted line in its
 * place when there is none.
 */
function AddRow({ box, team, onAdd }: { box: BoxJson; team: MonRef[]; onAdd(ref: MonRef): void }) {
  const id = useId();
  const [picked, setPicked] = useState<MonRef>('');
  const inTeam = new Set(team);
  const addable = box.mons.filter((m) => canJoin(m) && !inTeam.has(m.ref));
  const choice = addable.some((m) => m.ref === picked) ? picked : '';
  if (addable.length === 0) return <p className="team-panel-note">Nobody else in the box can join.</p>;
  return (
    <div className="team-panel-add">
      <label htmlFor={id}>Add from the box</label>
      <select id={id} value={choice} onChange={(event) => setPicked(event.target.value)}>
        <option value="">Pick a Pokémon…</option>
        {addable.map((m) => (
          <option key={m.ref} value={m.ref}>{`${monLabel(m)}${overCap(m) ? ` · over the level cap (${box.levelCap})` : ''}`}</option>
        ))}
      </select>
      <button
        type="button" className="button" disabled={choice === ''}
        onClick={() => {
          onAdd(choice);
          setPicked('');
        }}
      >
        Add
      </button>
    </div>
  );
}
