// The editor of one draft Pokémon (DraftEditor.tsx): EXP, HP, status, held item, moves, Advanced (nature, IVs, EVs) and
// Reset. The harness holds one entry and applies each edit with `edited`, so the component runs on the real rules. The
// fixture `box()`: Blaze `party:1` Lv 15 (HP 30/44, asleep 2 turns, an Oran Berry, Mach Punch and Ember; learns Scratch
// at 1, Flame Wheel at 16), Starly `party:2` Lv 14 (HP 38/38, Jolly). `draftOptions()`: four items, EXP tables of level³.

import { render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import type { BoxMonJson, DraftMonJson, DraftOptionsJson } from '../../../src/server/apiTypes';
import { DraftEditor } from '../../../web/src/components/draft/DraftEditor';
import { type DraftPatch, edited } from '../../../web/src/draft';
import { box, draftOptions } from './stubServer';

let seen: DraftMonJson;

function Harness({ which = 0, options = draftOptions() as DraftOptionsJson | null, start, onRetry = () => undefined }: { which?: number; options?: DraftOptionsJson | null; start?: DraftMonJson; onRetry?: () => void }) {
  const m = box().mons[which]!;
  const [entry, setEntry] = useState<DraftMonJson>(start ?? { ref: m.ref });
  seen = entry;
  return <DraftEditor mon={m} entry={entry} options={options} optionsProblem={options === null ? 'boom' : null} onRetryOptions={onRetry}
    onEdit={(patch) => { const r = edited(m, options, entry, patch); setEntry(r.entry); return r.problem; }} onReset={() => setEntry({ ref: m.ref })} onClose={() => undefined} />;
}
/** The editor alone, its edits answered by `onEdit`. */
const bare = (m: BoxMonJson, entry: DraftMonJson, onEdit: (patch: DraftPatch) => string | null = () => null, options: DraftOptionsJson | null = draftOptions()) => (
  <DraftEditor mon={m} entry={entry} options={options} optionsProblem={null} onRetryOptions={() => undefined} onEdit={onEdit} onReset={() => undefined} onClose={() => undefined} />
);
const type = async (user: UserEvent, label: string, text: string) => { const f = screen.getByRole('spinbutton', { name: label }); await user.clear(f); await user.type(f, `${text}{Enter}`); };
const field = (label: string) => screen.getByRole('spinbutton', { name: label });
const optionNames = (label: string) => within(screen.getByLabelText(label)).getAllByRole('option').map((o) => o.textContent);

it("shows the save's values, Reset off", () => {
  render(<Harness />);
  expect(screen.getByRole('region', { name: 'Edit Blaze (Monferno)' })).toBeInTheDocument();
  expect([field('HP'), field('HP percent')].map((f) => (f as HTMLInputElement).value)).toEqual(['30', '68']);
  expect(screen.getByText('/ 44')).toBeInTheDocument();
  expect(screen.getByLabelText('Status')).toHaveValue('sleep');
  expect(screen.getByLabelText('Sleep turns')).toHaveValue('2');
  expect(screen.getByLabelText('Held item')).toHaveDisplayValue('Oran Berry (in the save)');
  expect(screen.getByLabelText('Move 1')).toHaveDisplayValue('Mach Punch');
  expect(screen.getByLabelText('Move 3')).toHaveDisplayValue('—');
  expect(screen.getByText('Level 15 is 3375 to 4095 EXP.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reset Blaze (Monferno) to the save' })).toBeDisabled();
});

it('HP by number, by percent and by the three buttons', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await type(user, 'HP', '10');
  expect(seen).toEqual({ ref: 'party:1', hp: 10 });
  await type(user, 'HP percent', '50');
  expect(seen.hp).toBe(22);
  for (const [button, hp] of [['Full', 44], ['Half HP', 22], ['1 HP', 1]] as const) {
    await user.click(screen.getByRole('button', { name: button }));
    expect(seen.hp).toBe(hp);
  }
});

it("a number outside its field's range snaps back and says why; an EXP from another level moves the level", async () => {
  const user = userEvent.setup();
  render(<Harness which={1} />);
  const status = () => screen.getByRole('status');
  expect(status()).toBeEmptyDOMElement();
  await type(user, 'HP', '0');
  expect(field('HP')).toHaveValue(38);
  expect(status()).toHaveTextContent('HP must be 1 to 38.');
  expect(seen).toEqual({ ref: 'party:2' });
  await type(user, 'EXP', '10000000');
  expect(status()).toHaveTextContent('EXP must be 0 to 9,999,999.');
  await user.click(screen.getByRole('button', { name: 'Advanced' }));
  await type(user, 'IV Spe', '32');
  expect(status()).toHaveTextContent('IVs are 0 to 31.');
  expect(field('IV Spe')).toHaveValue(31);
  await type(user, 'EXP', '10');                                   // level 2 is 8 to 26
  expect(status()).toBeEmptyDOMElement();
  expect(seen).toEqual({ ref: 'party:2', level: 2, exp: 10 });
  expect(screen.getByText('Level 2 is 8 to 26 EXP.')).toBeInTheDocument();
});

it('status: pre-burn, sleep with its turns, and none', async () => {
  const user = userEvent.setup();
  render(<Harness which={1} />);
  expect(screen.queryByLabelText('Sleep turns')).toBeNull();
  await user.selectOptions(screen.getByLabelText('Status'), 'Burned');
  expect(seen).toEqual({ ref: 'party:2', status: 'burn' });
  await user.selectOptions(screen.getByLabelText('Status'), 'Asleep');
  expect(seen.status).toBe('sleep:1');
  await user.selectOptions(screen.getByLabelText('Sleep turns'), '3 turns');
  expect(seen.status).toBe('sleep:3');
  await user.selectOptions(screen.getByLabelText('Status'), 'None');
  expect(seen).toEqual({ ref: 'party:2' });
});

it("held item: none, the save's own, or one from the list, each once", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  expect(optionNames('Held item')).toEqual(['None', 'Oran Berry (in the save)', 'Cheri Berry', 'Leftovers', 'Lucky Egg']);
  await user.selectOptions(screen.getByLabelText('Held item'), 'Leftovers');
  expect(seen.item).toBe(234);
  await user.selectOptions(screen.getByLabelText('Held item'), 'None');
  expect(seen.item).toBe(0);
});

it('moves: what it knows and what it learns by its level; the last move cannot be emptied; Reset puts all back', async () => {
  const user = userEvent.setup();
  render(<Harness start={{ ref: 'party:1', level: 16 }} />);
  expect(optionNames('Move 3')).toEqual(['—', 'Scratch (Lv 1)', 'Flame Wheel (Lv 16)']);
  await user.selectOptions(screen.getByLabelText('Move 3'), 'Flame Wheel (Lv 16)');
  expect(seen.moves).toEqual([{ id: 183 }, { id: 52 }, { id: 172 }]);
  await user.selectOptions(screen.getByLabelText('Move 1'), '—');
  await user.selectOptions(screen.getByLabelText('Move 1'), '—');
  expect(seen.moves).toEqual([{ id: 172 }]);
  expect(optionNames('Move 1')).not.toContain('—');
  await user.click(screen.getByRole('button', { name: 'Reset Blaze (Monferno) to the save' }));
  expect(seen).toEqual({ ref: 'party:1' });
});

it('Advanced opens a named panel: nature, IVs and EVs in named groups; too many EVs is refused in words', async () => {
  const user = userEvent.setup();
  render(<Harness which={1} />);
  const advanced = screen.getByRole('button', { name: 'Advanced' });
  const panel = () => document.getElementById(advanced.getAttribute('aria-controls')!);
  expect(panel()).not.toBeVisible();
  expect(screen.queryByLabelText('Nature')).toBeNull();
  await user.click(advanced);
  expect(panel()).toBeVisible();
  expect(panel()).toContainElement(screen.getByLabelText('Nature'));
  for (const name of ['IVs (0 to 31)', 'EVs (0 to 255)']) expect(within(screen.getByRole('group', { name })).getAllByRole('spinbutton')).toHaveLength(6);
  expect(screen.getByLabelText('Nature')).toHaveDisplayValue('Jolly (+Spe −SpA)');
  await user.selectOptions(screen.getByLabelText('Nature'), 'Hardy');
  expect(seen.nature).toBe(0);
  await type(user, 'IV HP', '0');
  expect(seen.ivs).toMatchObject({ hp: 0, atk: 31 });
  await type(user, 'EV HP', '255');
  await type(user, 'EV Atk', '255');
  expect(screen.getByText('EVs used: 510 of 510.')).toBeInTheDocument();
  await type(user, 'EV Def', '1');
  expect(screen.getByRole('status')).toHaveTextContent('Starly: EVs must be six whole numbers from 0 to 255, 510 in all at most');
  expect(field('EV Def')).toHaveValue(0);
  await type(user, 'IV Atk', '30');
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
});

it('without the options: no item list and no EXP field, said in a line each, and Try again asks again', async () => {
  const onRetry = vi.fn();
  const user = userEvent.setup();
  const { unmount } = render(<Harness options={null} onRetry={onRetry} />);
  expect(field('EXP')).toBeDisabled();
  expect(screen.getByText('The EXP tables did not load.')).toBeInTheDocument();
  expect(optionNames('Held item')).toHaveLength(2);
  expect(screen.getByText('The item list did not load. boom')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(onRetry).toHaveBeenCalled();
  await user.selectOptions(screen.getByLabelText('Status'), 'Burned');
  expect(seen.status).toBe('burn');
  unmount();
  render(<Harness options={null} start={{ ref: 'party:1', item: 234 }} />);          // a kept item no list names: its number
  expect(screen.getByLabelText('Held item')).toHaveDisplayValue('(item 234)');
});

it('while the options load it says so, with nothing to try again yet', () => {
  render(bare(box().mons[0]!, { ref: 'party:1' }, () => null, null));
  expect(screen.getByText('Loading the EXP tables…')).toBeInTheDocument();
  expect(screen.getByText('Loading the item list…')).toBeInTheDocument();
  expect(field('EXP')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

it('at level 100 the EXP line has no top, and the HP percent never says empty or full when it is not', async () => {
  const user = userEvent.setup();
  render(<Harness start={{ ref: 'party:1', level: 100, hp: 240 }} />);   // max 241: 99.6% would round to 100
  expect(screen.getByText('Level 100 is 1000000 EXP or more.')).toBeInTheDocument();
  expect(field('EXP')).toHaveValue(1000000);
  expect(field('HP percent')).toHaveValue(99);
  await type(user, 'HP percent', '100');
  expect(seen.hp).toBe(241);
  expect(field('HP percent')).toHaveValue(100);
  await user.click(screen.getByRole('button', { name: '1 HP' }));      // 0.4% would round to 0
  expect(field('HP percent')).toHaveValue(1);
});

it('what went wrong goes when the entry changes from outside', async () => {
  const user = userEvent.setup();
  const m = box().mons[0]!;
  const { rerender } = render(bare(m, { ref: 'party:1' }, () => 'Blaze (Monferno): no'));
  await user.click(screen.getByRole('button', { name: '1 HP' }));
  expect(screen.getByRole('status')).toHaveTextContent('Blaze (Monferno): no');
  rerender(bare(m, { ref: 'party:1', level: 16 }, () => 'Blaze (Monferno): no'));
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
});

it("a status the editor cannot set is shown in statusLabel's words, and another can still be picked", async () => {
  const user = userEvent.setup();
  const onEdit = vi.fn<(patch: DraftPatch) => string | null>(() => null);
  render(bare({ ...box().mons[0]!, status: 'sleepUndrawn:2' }, { ref: 'party:1' }, onEdit));
  expect(screen.getByLabelText('Status')).toHaveDisplayValue('Asleep (2 turns so far)');
  expect(screen.queryByLabelText('Sleep turns')).toBeNull();
  await user.selectOptions(screen.getByLabelText('Status'), 'Burned');
  expect(onEdit).toHaveBeenCalledWith({ status: 'burn' });
});
