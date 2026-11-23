// The editor of one Pokémon of the draft team, opened under its row in the team column. It shows the Pokémon as the
// fight will start it (`shown`: the save with the entry's edits over it) and every control sends one field as an edit
// (`onEdit`, which applies the server's own rules): its EXP, HP, status, held item and moves, and under Advanced its
// nature, IVs and EVs. A refused edit, or a number outside its field's range (which snaps back), is said in words in a
// status line that is always there (so a screen reader hears it change) until the next edit that is taken or the entry
// changes from outside (the row's level, Reset). It never sends PP: a save move keeps its PP, a new one starts full.
// Without the options (still loading, or failed) the EXP is read-only and the item list holds only None and the save's
// own item, each with a line saying why. The level is set in the team row; here the EXP moves it. Its Close button asks
// the row to close it. For planning only: the save is never changed.

import { useId, useState, type JSX } from 'react';
import { NATURES } from '../../../../src/rom/natures';
import { natureMultipliers } from '../../../../src/rom/stats';
import type { Stats } from '../../../../src/rom/types';
import type { BoxMonJson, DraftMonJson, DraftOptionsJson } from '../../../../src/server/apiTypes';
import { MAX_EV, MAX_EV_TOTAL, MAX_IV, MAX_MOVES, STAT_KEYS } from '../../../../src/server/draftRules';
import { type DraftPatch, isEdited, moveChoices, shown } from '../../draft';
import { monName, statusLabel } from '../../labels';
import { NumberField } from './NumberField';

const MAX_EXP = 9_999_999;
const SLEEP_TURNS = [1, 2, 3, 4, 5, 6, 7];

const STAT_NAMES: Record<keyof Stats, string> = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

/** The status choices: 'none' and 'sleep' are the editor's own words, the rest `statusLabel`'s. */
const STATUS_CHOICES: { value: string; label: string }[] = [
  { value: 'none', label: 'None' },
  ...['burn', 'poison', 'toxic', 'paralysis'].map((value) => ({ value, label: statusLabel(value) })),
  { value: 'sleep', label: 'Asleep' },
  { value: 'freeze', label: statusLabel('freeze') },
];

const SLEEP = /^sleep:([1-7])$/;

/** "Jolly (+Spe −SpA)": the nature's name and the stats it raises and lowers; a neutral one just its name. */
function natureText(nature: number): string {
  const multipliers = natureMultipliers(nature);
  const up = STAT_KEYS.find((key) => multipliers[key] > 1);
  const down = STAT_KEYS.find((key) => multipliers[key] < 1);
  const name = NATURES[nature]!;
  return up === undefined || down === undefined ? name : `${name} (+${STAT_NAMES[up]} −${STAT_NAMES[down]})`;
}

/** A number as the page writes it in a sentence: "9,999,999". */
const amount = (n: number): string => n.toLocaleString('en-GB');

/**
 * The HP as a percent of the max, rounded, but never 0 while it has HP and never 100 while it is not full: 1 to 99
 * then, so the field never says empty or full when it is not.
 */
function hpPercent(hp: number, maxHp: number): number {
  if (hp >= maxHp) return 100;
  return Math.min(99, Math.max(1, Math.round((100 * hp) / maxHp)));
}

export function DraftEditor({ mon, entry, options, optionsProblem, onRetryOptions, onEdit, onReset, onClose }: {
  mon: BoxMonJson; entry: DraftMonJson;
  /** The editor's options; null while they load or when they did not. */
  options: DraftOptionsJson | null;
  /** Why the options did not load; null while they load or once they have. */
  optionsProblem: string | null;
  onRetryOptions(): void;
  /** Applies one field's edit: null when taken, else why not in words. */
  onEdit(patch: DraftPatch): string | null;
  onReset(): void;
  /** Closes the editor; it moves no focus. */
  onClose(): void;
}): JSX.Element {
  const id = useId();
  // What went wrong, with the entry it was said for: an entry changed from outside (a new object) makes it stale, so it
  // is not shown. A refused edit leaves the entry as it was, the very same object.
  const [problem, setProblem] = useState<{ text: string; entry: DraftMonJson } | null>(null);
  const [advanced, setAdvanced] = useState(() => entry.ivs !== undefined || entry.evs !== undefined || entry.nature !== undefined);
  const s = shown(mon, options, entry);
  const name = monName(mon);
  const said = problem !== null && problem.entry === entry ? problem.text : '';
  const say = (text: string | null) => setProblem(text === null ? null : { text, entry });

  /** Sends one edit; a refusal stays on screen until an edit is taken. */
  const send = (patch: DraftPatch): boolean => {
    const refused = onEdit(patch);
    say(refused);
    return refused === null;
  };

  const loading = options === null && optionsProblem === null;

  // EXP
  const expLine = s.expRange === null
    ? (loading ? 'Loading the EXP tables…' : 'The EXP tables did not load.')
    : s.expRange.to === null ? `Level ${s.level} is ${s.expRange.from} EXP or more.` : `Level ${s.level} is ${s.expRange.from} to ${s.expRange.to} EXP.`;

  // Status: sleep is one choice, its turns a second select.
  const sleep = SLEEP.exec(s.status);
  const statusValue = sleep !== null ? 'sleep' : s.status;
  const statusChoices = STATUS_CHOICES.some((choice) => choice.value === statusValue)
    ? STATUS_CHOICES
    : [{ value: statusValue, label: statusLabel(statusValue) }, ...STATUS_CHOICES];   // one the editor cannot set, shown as it is
  const saveSleep = mon.status !== null && SLEEP.test(mon.status) ? mon.status : null;

  // Held item: None, the save's own, then the list. An item kept while the list did not load is shown by its number.
  const saveItem = mon.draft!.item;
  const itemName = (item: number) => options?.items.find((choice) => choice.id === item)?.name ?? `(item ${item})`;
  const items: { id: number; name: string }[] = [{ id: 0, name: 'None' }];
  if (saveItem !== 0) items.push({ id: saveItem, name: `${mon.item ?? itemName(saveItem)} (in the save)` });
  for (const item of options?.items ?? []) if (item.id !== saveItem) items.push(item);
  if (!items.some((item) => item.id === s.item)) items.push({ id: s.item, name: itemName(s.item) });

  // Moves: four slots, the shown moves in order, then empty ones.
  const choices = moveChoices(mon, s.level);
  const slots = Array.from({ length: MAX_MOVES }, (_, k) => s.moves[k]?.id ?? null);
  const filled = slots.filter((slot) => slot !== null).length;
  const setSlot = (k: number, value: string) => {
    const next = slots.map((slot, j) => (j === k ? (value === '' ? null : Number(value)) : slot));
    send({ moves: next.filter((slot) => slot !== null).map((moveId) => ({ id: moveId })) });
  };

  const evsUsed = STAT_KEYS.reduce((sum, key) => sum + s.evs[key], 0);

  return (
    <section className="draft-editor" aria-label={`Edit ${name}`}>
      <div className="draft-row">
        <span className="draft-label">EXP</span>
        <NumberField
          label="EXP" className="draft-exp" value={s.exp} min={0} max={MAX_EXP} disabled={s.expRange === null}
          onCommit={(n) => send({ exp: n })} onInvalid={() => say(`EXP must be 0 to ${amount(MAX_EXP)}.`)}
        />
        <p className="draft-note">{expLine}</p>
      </div>

      <div className="draft-row">
        <span className="draft-label">HP</span>
        <NumberField label="HP" value={s.hp} min={1} max={s.maxHp} onCommit={(n) => send({ hp: n })} onInvalid={() => say(`HP must be 1 to ${amount(s.maxHp)}.`)} />
        <span>{`/ ${s.maxHp}`}</span>
        <NumberField
          label="HP percent" value={hpPercent(s.hp, s.maxHp)} min={1} max={100}
          onCommit={(n) => send({ hp: Math.max(1, Math.round((s.maxHp * n) / 100)) })} onInvalid={() => say('HP percent must be 1 to 100.')}
        />
        <span>%</span>
        <button type="button" className="button" onClick={() => send({ hp: s.maxHp })}>Full</button>
        <button type="button" className="button" aria-label="Half HP" onClick={() => send({ hp: Math.max(1, Math.floor(s.maxHp / 2)) })}>½</button>
        <button type="button" className="button" onClick={() => send({ hp: 1 })}>1 HP</button>
      </div>

      <div className="draft-row">
        <label className="draft-label" htmlFor={`${id}-status`}>Status</label>
        <select
          id={`${id}-status`} value={statusValue}
          onChange={(event) => send({ status: event.target.value === 'sleep' ? saveSleep ?? 'sleep:1' : event.target.value })}
        >
          {statusChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select>
        {sleep !== null && (
          <>
            <label htmlFor={`${id}-sleep`}>Sleep turns</label>
            <select id={`${id}-sleep`} value={sleep[1]} onChange={(event) => send({ status: `sleep:${event.target.value}` })}>
              {SLEEP_TURNS.map((n) => <option key={n} value={n}>{`${n} ${n === 1 ? 'turn' : 'turns'}`}</option>)}
            </select>
          </>
        )}
      </div>

      <div className="draft-row">
        <label className="draft-label" htmlFor={`${id}-item`}>Held item</label>
        <select id={`${id}-item`} value={s.item} onChange={(event) => send({ item: Number(event.target.value) })}>
          {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        {options === null && (loading
          ? <p className="draft-note">Loading the item list…</p>
          : (
            <>
              <p className="draft-note">{`The item list did not load. ${optionsProblem}`}</p>
              <button type="button" className="button" onClick={onRetryOptions}>Try again</button>
            </>
          ))}
      </div>

      <div className="draft-row">
        <span className="draft-label">Moves</span>
        {slots.map((slot, k) => {
          const others = slots.filter((other, j) => j !== k && other !== null);
          const offered = choices.filter((choice) => !others.includes(choice.id));
          if (slot !== null && !offered.some((choice) => choice.id === slot)) offered.unshift({ id: slot, name: s.moves[k]!.name, level: null });
          return (
            <select key={k} aria-label={`Move ${k + 1}`} value={slot ?? ''} onChange={(event) => setSlot(k, event.target.value)}>
              {!(slot !== null && filled === 1) && <option value="">—</option>}
              {offered.map((choice) => (
                <option key={choice.id} value={choice.id}>{choice.level === null ? choice.name : `${choice.name} (Lv ${choice.level})`}</option>
              ))}
            </select>
          );
        })}
        <p className="draft-note">{`Its moves in the save, and what it learns by level ${s.level}. A new move starts with full PP.`}</p>
      </div>

      <div className="draft-advanced">
        <button type="button" className="button" aria-expanded={advanced} aria-controls={`${id}-advanced`} onClick={() => setAdvanced((open) => !open)}>
          Advanced
        </button>
        {/* Always there, so `aria-controls` names an element; empty and hidden while closed. */}
        <div className="draft-advanced-body" id={`${id}-advanced`} hidden={!advanced}>
          {advanced && (
            <>
              <div className="draft-row">
                <label className="draft-label" htmlFor={`${id}-nature`}>Nature</label>
                <select id={`${id}-nature`} value={s.nature} onChange={(event) => send({ nature: Number(event.target.value) })}>
                  {NATURES.map((_, nature) => <option key={nature} value={nature}>{natureText(nature)}</option>)}
                </select>
              </div>
              <StatGrid
                id={`${id}-ivs`} heading="IVs" prefix="IV" stats={s.ivs} max={MAX_IV}
                onCommit={(ivs) => send({ ivs })} onInvalid={() => say(`IVs are 0 to ${MAX_IV}.`)}
              />
              <StatGrid
                id={`${id}-evs`} heading="EVs" prefix="EV" stats={s.evs} max={MAX_EV}
                onCommit={(evs) => send({ evs })} onInvalid={() => say(`EVs are 0 to ${MAX_EV}.`)}
              />
              <p className="draft-note">{`EVs used: ${evsUsed} of ${MAX_EV_TOTAL}.`}</p>
            </>
          )}
        </div>
      </div>

      <div className="draft-row">
        <p className="draft-alert" role="status">{said}</p>
        <button type="button" className="button" disabled={!isEdited(entry)} onClick={() => { setProblem(null); onReset(); }}>
          {`Reset ${name} to the save`}
        </button>
        <button type="button" className="button" onClick={onClose}>Close</button>
      </div>
    </section>
  );
}

/**
 * Six whole-number fields, one per stat (`<prefix> HP` … `<prefix> Spe`, 0 to `max`), each sending all six; a group
 * named by its heading ("IVs (0 to 31)").
 */
function StatGrid({ id, heading, prefix, stats, max, onCommit, onInvalid }: {
  id: string; heading: string; prefix: string; stats: Stats; max: number; onCommit(stats: Stats): boolean; onInvalid(): void;
}) {
  return (
    <div className="draft-stats-part" role="group" aria-labelledby={id}>
      <span className="draft-label" id={id}>{`${heading} (0 to ${max})`}</span>
      <div className="draft-stats">
        {STAT_KEYS.map((key) => (
          <div key={key} className="draft-stat">
            <span className="draft-stat-name">{STAT_NAMES[key]}</span>
            <NumberField
              label={`${prefix} ${STAT_NAMES[key]}`} value={stats[key]} min={0} max={max}
              onCommit={(n) => onCommit({ ...stats, [key]: n })} onInvalid={onInvalid}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
