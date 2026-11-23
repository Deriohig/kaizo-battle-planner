// The plan step's field and boosts row (FieldRow.tsx): steppers, the Boosts summary, chips, the two selects, Reset
// boosts, the busy state (aria-disabled, no onChange) and that `value` is never mutated.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FieldRow } from '../../../web/src/components/plan/FieldRow';
import { carry, planFieldDefault, stageSummary, stageText, withStage, type PlanFieldJson } from '../../../web/src/planField';

function deepFreeze<T>(o: T): T {
  if (typeof o === 'object' && o !== null) {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}
/** Renders the row for a frozen `value`, so any mutation throws; gives back onChange. */
function show(value: PlanFieldJson = planFieldDefault(), busy = false) {
  const onChange = vi.fn<(next: PlanFieldJson) => void>();
  render(<FieldRow value={deepFreeze(value)} onChange={onChange} playerName="Prinplup" enemyName="Bonsly" busy={busy} />);
  return onChange;
}
const withStages = (player: PlanFieldJson['stages']['player'], enemy: PlanFieldJson['stages']['enemy'] = {}): PlanFieldJson => ({ ...planFieldDefault(), stages: { player, enemy } });
const field = (change: (f: PlanFieldJson) => void) => {
  const f = planFieldDefault();
  change(f);
  return f;
};
const last = (fn: ReturnType<typeof show>): PlanFieldJson => fn.mock.calls.at(-1)![0];
const button = (name: string) => screen.getByRole('button', { name });
const summary = () => document.querySelector('.field-boosts > summary')!.textContent;

it.each<[string, PlanFieldJson, string, PlanFieldJson['stages']['player']]>([
  ['raising a stat gives a stage of 1', planFieldDefault(), "Raise Prinplup's Atk", { atk: 1 }],
  ['a stored stage of 9 steps down from +6', withStages({ atk: 9 }), "Lower Prinplup's Atk", { atk: 5 }],
  ['a stage back at 0 is dropped', withStages({ atk: 1 }), "Lower Prinplup's Atk", {}],
])('%s', async (_, value, press, stages) => {
  const onChange = show(value);
  await userEvent.click(button(press));
  expect(last(onChange).stages.player).toEqual(stages);
});

it('a stepper at +6 cannot go up, at -6 cannot go down; a stored 9 shows as +6', () => {
  show(withStages({ atk: 9, def: -6 }));
  expect(screen.getByRole('group', { name: 'Prinplup Atk' })).toHaveTextContent('+6');
  expect([button("Raise Prinplup's Atk"), button("Lower Prinplup's Def")].map((b) => (b as HTMLButtonElement).disabled)).toEqual([true, true]);
  expect([button("Lower Prinplup's Atk"), button("Raise Prinplup's Def")].map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, false]);
});

it('the summary says Boosts alone with no stage, and names the stages set', () => {
  show();
  expect(summary()).toBe('Boosts');
  document.body.innerHTML = '';
  show(withStages({ atk: 1 }, { def: -1 }));
  expect(summary()).toBe('Boosts: Prinplup Atk +1 · Bonsly Def −1');
});

it('each chip mirrors its value in aria-pressed', () => {
  show(field((f) => { f.trickRoom = true; f.rocks.enemy = true; f.screens.player.lightScreen = true; }));
  const pressed = (name: string) => button(name).getAttribute('aria-pressed');
  expect(['Trick Room', 'Stealth Rock on their side', 'Light Screen on your side'].map(pressed)).toEqual(['true', 'true', 'true']);
  expect(['Stealth Rock on your side', 'Reflect on your side', 'Reflect on their side', 'Light Screen on their side'].map(pressed)).toEqual(['false', 'false', 'false', 'false']);
});

it('a chip flips its own field and leaves the rest; the selects set theirs', async () => {
  const onChange = show();
  await userEvent.click(button('Stealth Rock on their side'));
  expect(last(onChange)).toEqual(field((f) => { f.rocks.enemy = true; }));
  await userEvent.click(button('Trick Room'));
  expect(last(onChange)).toEqual(field((f) => { f.trickRoom = true; }));
  await userEvent.click(button('Reflect on their side'));
  expect(last(onChange)).toEqual(field((f) => { f.screens.enemy.reflect = true; }));
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Weather' }), 'Rain');
  expect(last(onChange).weather).toBe('rain');
  await userEvent.selectOptions(screen.getByRole('combobox', { name: "Bonsly's status" }), 'Burned');
  expect(last(onChange).enemyStatus).toBe('brn');
});

it('Reset boosts empties both sides, and is disabled with none set or only stages of 0', async () => {
  const onChange = show(withStages({ atk: 1 }, { def: -2 }));
  await userEvent.click(button('Reset boosts'));
  expect(last(onChange).stages).toEqual({ player: {}, enemy: {} });
  for (const value of [planFieldDefault(), withStages({ atk: 0 }, { def: 0 })]) {
    document.body.innerHTML = '';
    show(value);
    expect(button('Reset boosts')).toBeDisabled();
  }
});

it('the chips show short words beside a side label, their full names as name and title; each row is one labelled line', () => {
  show(field((f) => { f.trickRoom = true; }));
  expect(screen.getByRole('group', { name: 'Their side' })).toHaveTextContent(/^Their sideRocksReflectScreen$/);
  expect(button('Stealth Rock on your side')).toHaveTextContent(/^Rocks$/);
  expect(button('Stealth Rock on your side')).toHaveAttribute('title', 'Stealth Rock');
  expect(button('Reflect on their side')).toHaveTextContent(/^Reflect$/);
  expect(button('Light Screen on their side')).toHaveTextContent(/^Screen$/);
  expect(button('Light Screen on their side')).toHaveAttribute('title', 'Light Screen');
  const labels = Array.from(document.querySelectorAll('.field-row > .field-label, .field-side > .field-side-label')).map((el) => el.textContent);
  expect(labels).toEqual(['Weather', 'Trick Room', 'Your side', 'Their side', "Bonsly's status"]);
  expect(button('Trick Room')).toHaveTextContent(/^On$/);                      // its state; its name stays "Trick Room"
  expect(screen.getByRole('combobox', { name: 'Weather' }).parentElement!.children).toHaveLength(1);
  const css = readFileSync(resolve(__dirname, '../../../web/src/styles/run.css'), 'utf8');
  expect(/\.field-chips \.field-chip \{([^}]*)\}/.exec(css)![1]).toMatch(/white-space:\s*nowrap/);
});

it('busy: every kind of control is aria-disabled and does nothing', async () => {
  const onChange = show(withStages({ atk: 1 }), true);
  const controls = [
    ...['Trick Room', "Raise Prinplup's Def", "Lower Prinplup's Atk", 'Reset boosts'].map(button),
    screen.getByRole('combobox', { name: 'Weather' }), screen.getByRole('combobox', { name: "Bonsly's status" }),
  ];
  for (const c of controls) {
    expect(c).toHaveAttribute('aria-disabled', 'true');
    expect(c).not.toBeDisabled();
  }
  for (const c of controls.slice(0, 4)) await userEvent.click(c);
  await userEvent.selectOptions(controls[4]!, 'Rain');
  await userEvent.selectOptions(controls[5]!, 'Burned');
  expect(onChange).not.toHaveBeenCalled();
});

describe('the field helpers (planField.ts)', () => {
  const busyField = (): PlanFieldJson => ({
    weather: 'rain', trickRoom: true, rocks: { player: true, enemy: false },
    screens: { player: { reflect: true, lightScreen: false }, enemy: { reflect: false, lightScreen: true } },
    stages: { player: { atk: 2, spe: -1 }, enemy: { def: 1 } }, enemyStatus: 'brn',
  });

  it('the default is everything off, no stages and no status, from the weather it is given', () => {
    expect(planFieldDefault()).toEqual({
      weather: 'none', trickRoom: false, rocks: { player: false, enemy: false },
      screens: { player: { reflect: false, lightScreen: false }, enemy: { reflect: false, lightScreen: false } }, stages: { player: {}, enemy: {} }, enemyStatus: 'none',
    });
    expect(planFieldDefault('rain').weather).toBe('rain');
  });

  it('carry with no switch equals prev and shares no objects with it', () => {
    const prev = busyField();
    const next = carry(prev, { player: false, enemy: false });
    expect(next).toEqual(prev);
    for (const pick of [(f: PlanFieldJson) => f, (f) => f.rocks, (f) => f.screens, (f) => f.screens.player, (f) => f.screens.enemy, (f) => f.stages, (f) => f.stages.player, (f) => f.stages.enemy] as ((f: PlanFieldJson) => object)[]) {
      expect(pick(next)).not.toBe(pick(prev));
    }
  });

  it.each<[string, { player: boolean; enemy: boolean }, Partial<PlanFieldJson>]>([
    ['a player switch clears his stages only', { player: true, enemy: false }, { stages: { player: {}, enemy: { def: 1 } }, enemyStatus: 'brn' }],
    ['an enemy switch clears their stages and status', { player: false, enemy: true }, { stages: { player: { atk: 2, spe: -1 }, enemy: {} }, enemyStatus: 'none' }],
  ])('carry: %s, and always keeps weather, Trick Room, rocks and screens', (_, switched, expected) => {
    const prev = busyField();
    expect(carry(prev, switched)).toEqual({ ...prev, ...expected });
  });

  it('withStage clamps to ±6, drops a stage back at 0, and leaves the old object alone; stageText writes a real minus', () => {
    expect([withStage({}, 'atk', 7), withStage({}, 'atk', -9), withStage({ atk: 1 }, 'atk', 0)]).toEqual([{ atk: 6 }, { atk: -6 }, {}]);
    const before = Object.freeze({ atk: 1 });
    expect(withStage(before, 'def', 2)).toEqual({ atk: 1, def: 2 });
    expect(before).toEqual({ atk: 1 });
    expect([1, 0, -1].map(stageText)).toEqual(['+1', '0', '−1']);
  });

  it('stageSummary names his stages in stat order, then theirs, and is empty with none', () => {
    const f = planFieldDefault();
    f.stages = { player: { spe: 2, atk: 1, spa: -1 }, enemy: { def: -1 } };
    expect(stageSummary(f, 'Prinplup', 'Bonsly')).toBe('Prinplup Atk +1 · Prinplup SpA −1 · Prinplup Spe +2 · Bonsly Def −1');
    expect(stageSummary(planFieldDefault(), 'Prinplup', 'Bonsly')).toBe('');
  });
});

it('never mutates value: a frozen value survives every interaction', async () => {
  const onChange = show(withStages({ atk: 1 }, { def: 2 }));
  for (const name of ['Trick Room', 'Stealth Rock on your side', 'Light Screen on their side', "Raise Bonsly's Eva", "Lower Prinplup's Atk", 'Reset boosts']) await userEvent.click(button(name));
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Weather' }), 'Hail');
  await userEvent.selectOptions(screen.getByRole('combobox', { name: "Bonsly's status" }), 'Asleep');
  expect(onChange).toHaveBeenCalledTimes(8);
});
