// The plan step's field and boosts row: weather, Trick Room, each side's chips, their status, then a Boosts
// disclosure with a stepper per stat for each side. One line each, the labels in one column: a side's three
// chips sit on its line under short words ("Rocks", "Reflect", "Screen") with the full name as their `title` and, with
// the side, as their accessible name; Trick Room is its own line, its chip saying On or Off. Controlled: it keeps no state
// (the disclosure is a native <details>), calls `onChange` with a new value and never touches `value`. Busy:
// every control is aria-disabled and ignores its click or change, never `disabled`; a stepper at its limit is
// `disabled`, as that is unavailable, not busy.

import { useId } from 'react';
import { busyAria, busyProps } from '../busy';
import {
  MAX_STAGE, MIN_STAGE, STAT_NAMES, STATS, stageOf, stageSummary, stageText, withStage,
  type PlanFieldJson, type PlanStages, type PlanStat, type PlanStatus, type PlanWeather,
} from '../../planField';

export interface FieldRowProps {
  value: PlanFieldJson;
  onChange(next: PlanFieldJson): void;
  playerName: string;
  enemyName: string;
  busy: boolean;
}

const WEATHERS: readonly (readonly [PlanWeather, string])[] = [
  ['none', 'No weather'], ['sun', 'Sun'], ['rain', 'Rain'], ['sand', 'Sandstorm'], ['hail', 'Hail'],
];
const STATUSES: readonly (readonly [PlanStatus, string])[] = [
  ['none', 'Healthy'], ['brn', 'Burned'], ['par', 'Paralysed'], ['psn', 'Poisoned'], ['tox', 'Badly poisoned'], ['slp', 'Asleep'], ['frz', 'Frozen'],
];

type Side = 'player' | 'enemy';

export function FieldRow({ value, onChange, playerName, enemyName, busy }: FieldRowProps) {
  const weatherId = useId();
  const statusId = useId();
  const summary = stageSummary(value, playerName, enemyName);
  // The same non-zero rule as the summary: a stored 0 is no boost.
  const anyStage = summary !== '';

  /**
   * A chip: short visible `text`, the full `name` (with its side) for assistive tech when it differs, and the full move
   * or effect as its hover `title` when the text is short for it.
   */
  const chip = (text: string, name: string, title: string | undefined, pressed: boolean, apply: (f: PlanFieldJson) => PlanFieldJson) => (
    <button
      type="button" className="button field-chip" aria-pressed={pressed} aria-label={name === text ? undefined : name} title={title}
      {...busyProps(busy, () => onChange(apply(value)))}
    >
      {text}
    </button>
  );
  const screen = (side: Side, which: 'reflect' | 'lightScreen', text: string, full: string, suffix: string) =>
    chip(text, `${full} ${suffix}`, full, value.screens[side][which], (f) => ({
      ...f, screens: { ...f.screens, [side]: { ...f.screens[side], [which]: !f.screens[side][which] } },
    }));
  const rocks = (side: Side, suffix: string) =>
    chip('Rocks', `Stealth Rock ${suffix}`, 'Stealth Rock', value.rocks[side], (f) => ({ ...f, rocks: { ...f.rocks, [side]: !f.rocks[side] } }));
  /** One side's three chips on its line, its label in the label column. */
  const sideChips = (side: Side, label: string, suffix: string) => (
    <div className="field-side" role="group" aria-label={label}>
      <span className="field-side-label">{label}</span>
      <div className="field-chips">
        {rocks(side, suffix)}
        {screen(side, 'reflect', 'Reflect', 'Reflect', suffix)}
        {screen(side, 'lightScreen', 'Screen', 'Light Screen', suffix)}
      </div>
    </div>
  );
  const withStages = (side: Side, stages: PlanStages): PlanFieldJson => ({ ...value, stages: { ...value.stages, [side]: stages } });

  const block = (side: Side, name: string) => (
    <div className="field-boost-block" key={side}>
      <div className="field-boost-name">{name}</div>
      <div className="field-steppers">
        {STATS.map((stat: PlanStat) => {
          const n = stageOf(value.stages[side], stat);
          const step = (by: number) => () => onChange(withStages(side, withStage(value.stages[side], stat, n + by)));
          return (
            <div className="field-stepper" key={stat} role="group" aria-label={`${name} ${STAT_NAMES[stat]}`}>
              <span className="field-stat">{STAT_NAMES[stat]}</span>
              <button
                type="button" className="button field-step" aria-label={`Lower ${name}'s ${STAT_NAMES[stat]}`}
                disabled={n <= MIN_STAGE} {...busyProps(busy, step(-1))}
              >
                {'−'}
              </button>
              <span className="field-stage" aria-live="off">{stageText(n)}</span>
              <button
                type="button" className="button field-step" aria-label={`Raise ${name}'s ${STAT_NAMES[stat]}`}
                disabled={n >= MAX_STAGE} {...busyProps(busy, step(1))}
              >
                +
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="field-row" role="group" aria-label="Field and boosts">
      <label className="field-label" htmlFor={weatherId}>Weather</label>
      <div className="field-line">
        {/* A select has no click: busy, it is aria-disabled and ignores a change (React puts its value back). */}
        <select
          id={weatherId} value={value.weather} aria-disabled={busyAria(busy)}
          onChange={(e) => { if (!busy) onChange({ ...value, weather: e.target.value as PlanWeather }); }}
        >
          {WEATHERS.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
        </select>
      </div>
      <span className="field-label" aria-hidden="true">Trick Room</span>
      <div className="field-line">
        {chip(value.trickRoom ? 'On' : 'Off', 'Trick Room', undefined, value.trickRoom, (f) => ({ ...f, trickRoom: !f.trickRoom }))}
      </div>
      {sideChips('player', 'Your side', 'on your side')}
      {sideChips('enemy', 'Their side', 'on their side')}
      <label className="field-label" htmlFor={statusId}>{enemyName}'s status</label>
      <div className="field-line">
        <select
          id={statusId} value={value.enemyStatus} aria-disabled={busyAria(busy)}
          onChange={(e) => { if (!busy) onChange({ ...value, enemyStatus: e.target.value as PlanStatus }); }}
        >
          {STATUSES.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
        </select>
      </div>
      <details className="field-boosts">
        <summary>{summary === '' ? 'Boosts' : `Boosts: ${summary}`}</summary>
        {block('player', playerName)}
        {block('enemy', enemyName)}
        <button
          type="button" className="button field-reset" disabled={!anyStage}
          {...busyProps(busy, () => onChange({ ...value, stages: { player: {}, enemy: {} } }))}
        >
          Reset boosts
        </button>
      </details>
    </div>
  );
}
