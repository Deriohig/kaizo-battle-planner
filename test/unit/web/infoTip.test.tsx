// The ⓘ that holds a panel's explanation: named for its panel, the text as its title and description, opened by a click
// or the keyboard and closed by Escape or a press outside. Escape on an open tip is the tip's alone (the Settings sheet
// stays), the open popover has no native title over it, and the button is a 24 px target.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { InfoTip } from '../../../web/src/components/InfoTip';
import { HostedSettingsPanel } from '../../../web/src/components/SettingsPanel';

it('is a named button whose title and description hold the text; a click or Enter opens it without the title, Escape closes it', async () => {
  const user = userEvent.setup();
  render(<InfoTip label="Your choice">OHKO: the chance it faints in one hit.</InfoTip>);
  const button = screen.getByRole('button', { name: 'About Your choice' });
  expect(button).toHaveAttribute('title', 'OHKO: the chance it faints in one hit.');
  expect(button).toHaveAccessibleDescription('OHKO: the chance it faints in one hit.');
  expect(screen.getByText('OHKO: the chance it faints in one hit.')).not.toBeVisible();
  await user.click(button);
  expect(button).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('tooltip')).toBeVisible();
  expect(button).not.toHaveAttribute('title');                     // not shown twice
  expect(button).toHaveAccessibleDescription('OHKO: the chance it faints in one hit.');
  await user.click(button);
  expect(button).toHaveAttribute('title', 'OHKO: the chance it faints in one hit.');
  button.focus();
  await user.keyboard('{Enter}');
  expect(button).toHaveAttribute('aria-expanded', 'true');
  await user.keyboard('{Escape}');
  expect(button).toHaveAttribute('aria-expanded', 'false');
});

it('a press outside closes it, without the button losing focus first (Safari does not focus a clicked button)', () => {
  render(<><InfoTip label="Your choice">Text.</InfoTip><p>Elsewhere</p></>);
  const button = screen.getByRole('button', { name: 'About Your choice' });
  fireEvent.click(button);
  fireEvent.pointerDown(screen.getByRole('tooltip'));
  expect(button).toHaveAttribute('aria-expanded', 'true');      // a press on the popover itself leaves it open
  fireEvent.pointerDown(screen.getByText('Elsewhere'));
  expect(button).toHaveAttribute('aria-expanded', 'false');
});

it('in Settings, Escape closes the open tip and leaves the sheet open; the next Escape closes the sheet', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<HostedSettingsPanel settings={{ graveyardBox: null, levelCapOverride: null }} box={null} fileName={null}
    onSave={vi.fn(async () => {})} onChangeSave={vi.fn()} onRemoveSave={vi.fn()} onClose={onClose} />);
  const tip = within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('button', { name: 'About Graveyard' });
  await user.click(tip);
  await user.keyboard('{Escape}');
  expect(tip).toHaveAttribute('aria-expanded', 'false');
  expect(onClose).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('the button is at least a 24 px target', () => {
  const body = /\n\.info-tip-button \{([^}]*)\}/.exec(readFileSync(resolve(__dirname, '../../../web/src/styles.css'), 'utf8'))?.[1] ?? '';
  for (const prop of ['width', 'height']) expect(Number(new RegExp(`(^|\\s)${prop}:\\s*(\\d+)px`).exec(body)?.[2]), prop).toBeGreaterThanOrEqual(24);
});
