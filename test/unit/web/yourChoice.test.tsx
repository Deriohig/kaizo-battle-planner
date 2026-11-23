// "Your choice": moves as tiles, switches as chips under "Switch instead", the busy and working states, and the heading's focus hooks.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Choice } from '../../../src/contracts/engine';
import type { LineMoveDamageJson, LineNodeJson, LineRationalJson } from '../../../src/server/apiTypes';
import { YourChoice } from '../../../web/src/components/tree/YourChoice';
import { KO_KEY } from '../../../web/src/line';

const r = (num: number, den: number): LineRationalJson => ({ num: String(num), den: String(den) });
const ZERO = r(0, 1);
const ONE = r(1, 1);
const SURE = { koExact: [ONE, ONE, ONE, ONE], koCritExact: ONE };

function damage(slot: number, name: string, over: Partial<LineMoveDamageJson> = {}): LineMoveDamageJson {
  return {
    slot, name, hitChance: 1, status: false, percent: [44, 54], critPercent: [66, 80], ko: 0, koCrit: 0,
    koExact: [ZERO, r(51, 128), ONE, ONE], koCritExact: r(1, 2), hp: [22, 27], critHp: [33, 40], note: null, priority: 0, survives: null, ...over,
  } as LineMoveDamageJson;
}
const mon = (name: string, hp: number, maxHp: number, status: string | null = null, moves: unknown[] = []) => ({
  ident: name, name, species: name, level: 20, hp, maxHp, percent: 50, status, boosts: {}, item: null, ability: 'x', fainted: false, active: false, moves,
});

const MOVE0: Choice = { kind: 'move', slot: 0 };
const MOVE1: Choice = { kind: 'move', slot: 1 };
const SWITCH1: Choice = { kind: 'switch', index: 1 };
const SWITCH2: Choice = { kind: 'switch', index: 2 };
const SWITCHES = [{ choice: SWITCH1, label: 'Switch to Machop' }, { choice: SWITCH2, label: 'Switch to Gloom' }];

function node(over: { phase?: LineNodeJson['phase']; yours?: LineMoveDamageJson[]; choices?: { choice: Choice; label: string }[]; aiError?: string; status?: string | null } = {}): LineNodeJson {
  const active = { ...mon('Prinplup', 51, 61, over.status ?? null, [{ name: 'Aerial Ace', pp: 19, maxPp: 20 }, { name: 'Tackle', pp: 35, maxPp: 35 }]), active: true };
  return {
    phase: over.phase ?? 'turnChoice', aiError: over.aiError,
    view: {
      player: { active, party: [active, mon('Machop', 62, 62), mon('Gloom', 40, 57, 'poisoned')] },
      enemy: { active: mon('Numel', 20, 20), party: [] }, field: { weather: null, conditions: [], player: [], enemy: [] },
    },
    choices: over.choices ?? [{ choice: MOVE0, label: 'Use Aerial Ace' }, { choice: MOVE1, label: 'Use Tackle' }, ...SWITCHES],
    damage: { yours: over.yours ?? [damage(0, 'Aerial Ace'), damage(1, 'Tackle', { hitChance: 0.85, ...SURE })], theirs: [], against: 'Numel', order: null },
  } as unknown as LineNodeJson;
}
/** The default node with Aerial Ace's damage changed by `over`. */
const withAce = (over: Partial<LineMoveDamageJson>) => node({ yours: [damage(0, 'Aerial Ace', over), damage(1, 'Tackle')] });

const props = { selected: null, working: null, busy: false, onChoose: () => undefined };
const tile = (name: RegExp) => screen.getByRole('button', { name });
const ace = () => tile(/Aerial Ace/);                     // after the type chip, when it has one
const options = () => screen.getAllByRole('button').filter((b) => b.classList.contains('tree-option'));   // not the heading's ⓘ

describe('YourChoice', () => {
  it('shows each move as a tile: name, the % range (no PP, no HP), KO lines, the fractions as the KO title, and a choice key on each option', () => {
    const { container } = render(<YourChoice node={node()} {...props} />);
    expect(container.querySelectorAll('ul.tree-tiles > li')).toHaveLength(2);
    expect(ace()).toHaveClass('tile', 'tree-option');
    expect(ace().querySelector('.tile-name')).toHaveTextContent('Aerial Ace');
    expect(ace().querySelector('.tile-meta')).toBeNull();
    expect(ace()).not.toHaveTextContent(/PP|HP/);
    expect(ace().querySelector('.tile-damage')!.textContent).toBe('44–54%');
    expect([...ace().querySelectorAll('.tile-ko .tile-ko-line')].map((e) => e.textContent)).toEqual(['No OHKO · 2HKO 39.84%', 'Crit: OHKO 50%']);
    expect(ace().querySelector('.tile-ko')).toHaveAttribute('title', '1 hit 0/1 · 2 hits 51/128 · 3 hits 1/1 · 4 hits 1/1 · on a crit 1/2');
    // An absent type, category or power shows no chip and no sub line.
    expect(ace().querySelector('.type-chip, .tile-sub')).toBeNull();
    // The band is drawn against their active percent (Numel is at 50).
    expect(ace().querySelector('.band-fill')).toHaveStyle({ width: '50%' });
    expect([...container.querySelectorAll('.tree-option')].map((e) => e.getAttribute('data-choice'))).toEqual(['m0', 'm1', 's1', 's2']);
    expect([...container.querySelectorAll('.matchup-label')].map((e) => e.textContent)).toEqual(['Use move', 'Switch instead']);
    expect(container).toHaveTextContent(KO_KEY);
    const heading = screen.getByRole('heading', { name: 'Your choice' });         // takes focus from code only
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading).toHaveAttribute('data-focus', 'choice');
  });

  it('a tile shows the type chip, "Physical · 70 power" and a band, in phrasing content only', () => {
    render(<YourChoice node={withAce({ type: 'Water', category: 'physical', power: 70 })} {...props} />);
    expect(ace().querySelector('.type-chip')).toHaveTextContent('Water');
    expect(ace().querySelector('.type-chip')).toHaveAttribute('data-type', 'Water');
    expect(ace().querySelector('.tile-sub')).toHaveTextContent('Physical · 70 power');
    expect(ace().querySelector('.band')).not.toBeNull();
    expect(ace().querySelector('div')).toBeNull();                                    // a button holds phrasing content only
  });

  it.each<[string, Partial<LineMoveDamageJson>, string]>([
    ['a null power shows just the category', { category: 'special', power: null }, 'Special'],
    ['a status move shows "Status"', { type: 'Normal', category: 'status', power: null, status: true, percent: null, critPercent: null }, 'Status'],
    ['a status move of unknown category shows "Status"', { category: null, status: true, power: null, percent: null, critPercent: null }, 'Status'],
  ])('%s', (_, over, sub) => {
    render(<YourChoice node={withAce(over)} {...props} />);
    expect(ace().querySelector('.tile-sub')!.textContent).toBe(sub);
    if (over.status) expect(ace().querySelector('.band, .tile-damage')).toBeNull();
  });

  it('a tile shows its KO as separate short lines, and a priority line only for a priority move', () => {
    render(<YourChoice node={node({ yours: [
      damage(0, 'Aerial Ace', { hitChance: 0.85, koExact: [r(3, 16), ONE, ONE, ONE], koCritExact: ONE, survives: 'Focus Sash', priority: 1 }), damage(1, 'Tackle'),
    ] })} {...props} />);
    expect([...ace().querySelectorAll('.tile-ko > .tile-ko-line')].map((e) => e.textContent)).toEqual(['85% to hit', 'OHKO 18.75%', 'Crit: OHKO 100%', 'Focus Sash: survives 1 hit']);
    expect(ace().querySelector('.tile-priority')).toHaveTextContent('Priority +1');
    expect(tile(/^Tackle/)).not.toHaveTextContent('Priority');
  });

  it('the KO tone is ok only for a sure "OHKO 100%" that cannot miss and that no Focus Sash can stop', () => {
    const tone = (name: RegExp) => tile(name).querySelector('.tile-ko')!;
    const { rerender } = render(<YourChoice node={node({ yours: [damage(0, 'Aerial Ace', SURE), damage(1, 'Tackle', { hitChance: 0.85, ...SURE })] })} {...props} />);
    expect(tone(/^Aerial Ace/)).toHaveTextContent(/^OHKO 100%$/);
    expect(tone(/^Aerial Ace/)).toHaveClass('is-ok');
    expect(tone(/^Tackle/)).toHaveTextContent('85% to hit OHKO 100%');
    expect(tone(/^Tackle/)).not.toHaveClass('is-ok');
    rerender(<YourChoice node={node()} {...props} />);
    expect(tone(/^Aerial Ace/)).not.toHaveClass('is-ok');
    // Beat Up and Triple Kick: the calc runs one plain hit, so a Focus Sash could still stop them; a counted multi-hit move can be ok.
    const sure = { ...SURE, multiHit: true };
    const pair = (a: string, b: string, bOver: Partial<LineMoveDamageJson>) => node({
      choices: [{ choice: MOVE0, label: `Use ${a}` }, { choice: MOVE1, label: `Use ${b}` }], yours: [damage(0, a, sure), damage(1, b, bOver)],
    });
    rerender(<YourChoice node={pair('Beat Up', 'Double Kick', sure)} {...props} />);
    expect(tone(/^Beat Up/)).toHaveTextContent(/^OHKO 100%$/);
    expect(tone(/^Beat Up/)).not.toHaveClass('is-ok');
    expect(tone(/^Double Kick/)).toHaveClass('is-ok');
    rerender(<YourChoice node={pair('Triple Kick', 'Tackle', { ...sure, multiHit: false })} {...props} />);
    expect(tone(/^Triple Kick/)).not.toHaveClass('is-ok');
    expect(tone(/^Tackle/)).toHaveClass('is-ok');
  });

  it('shows switches as chips with HP and status, a list named by the "Switch instead" label; no item choices', () => {
    const { container } = render(<YourChoice node={node()} {...props} />);
    const chips = [...container.querySelectorAll('ul.tree-chips > li > button.chip')];
    expect(chips.map((c) => [c.textContent, c.getAttribute('data-choice')])).toEqual([['Machop 62/62', 's1'], ['Gloom 40/57 · poisoned', 's2']]);
    const list = screen.getByRole('list', { name: 'Switch instead' });
    expect(list).toHaveClass('tree-chips');
    expect(list.getAttribute('aria-labelledby')).toBe([...container.querySelectorAll('.matchup-label')].at(-1)!.id);
    const item = { kind: 'item', item: 17 } as unknown as Choice;
    const { container: withItem } = render(<YourChoice node={node({ choices: [{ choice: MOVE0, label: 'Use Aerial Ace' }, SWITCHES[0]!, { choice: item, label: 'Use Potion' }] })} {...props} />);
    expect([...withItem.querySelectorAll('[data-choice]')].map((e) => e.getAttribute('data-choice'))).toEqual(['m0', 's1']);
    expect(withItem).not.toHaveTextContent('Potion');
  });

  it('draws nothing when the choices are items only', () => {
    const { container } = render(<YourChoice node={node({ choices: [{ choice: { kind: 'item', item: 'Potion' } as unknown as Choice, label: 'Use Potion' }] })} {...props} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['playerReplacement', 'One of yours fainted: send out'],
    ['playerMidTurnSwitch', 'Switch in'],
  ] as const)('at %s the switches are chips named by the heading "%s", with no label and no tiles', (phase, heading) => {
    const { container } = render(<YourChoice node={node({ phase, choices: SWITCHES })} {...props} />);
    expect(container.querySelector('.matchup-label')).toBeNull();
    expect(container.querySelectorAll('ul.tree-tiles')).toHaveLength(0);
    expect(container.querySelectorAll('ul.tree-chips button.chip')).toHaveLength(2);
    expect(screen.getByRole('list', { name: heading }).getAttribute('aria-labelledby')).toBe(screen.getByRole('heading', { name: heading }).id);
  });

  it('picking a tile or a chip calls onChoose; the selected one is aria-pressed', async () => {
    const onChoose = vi.fn();
    const { rerender } = render(<YourChoice node={node()} {...props} onChoose={onChoose} />);
    await userEvent.click(ace());
    await userEvent.click(tile(/^Gloom/));
    expect(onChoose.mock.calls).toEqual([[MOVE0], [SWITCH2]]);
    rerender(<YourChoice node={node()} {...props} selected={{ choice: MOVE1 }} />);
    expect(tile(/^Tackle/)).toHaveAttribute('aria-pressed', 'true');
    expect(tile(/^Tackle/)).toHaveClass('is-selected');
    expect(ace()).toHaveAttribute('aria-pressed', 'false');
    rerender(<YourChoice node={node()} {...props} selected={{ choice: SWITCH1 }} />);
    expect(tile(/^Machop/)).toHaveAttribute('aria-pressed', 'true');
    expect(tile(/^Tackle/)).toHaveAttribute('aria-pressed', 'false');
  });

  it('working says "Working out…" on that tile or chip only, and it is the selected one', () => {
    const { rerender } = render(<YourChoice node={node()} {...props} selected={{ choice: MOVE0 }} working={MOVE1} busy />);
    expect(tile(/^Tackle/)).toHaveTextContent('Working out…');
    expect(tile(/^Tackle/)).toHaveAttribute('aria-pressed', 'true');
    expect(ace()).not.toHaveTextContent('Working out…');
    expect(ace()).toHaveAttribute('aria-pressed', 'false');
    rerender(<YourChoice node={node()} {...props} working={SWITCH2} busy />);
    expect(tile(/^Gloom/)).toHaveTextContent('Working out…');
    expect(screen.getAllByText('Working out…')).toHaveLength(1);
  });

  it('busy makes every tile and chip aria-disabled and ignores clicks, without disabling them', async () => {
    const onChoose = vi.fn();
    render(<YourChoice node={node()} {...props} busy onChoose={onChoose} />);
    expect(options()).toHaveLength(4);
    for (const b of options()) {
      expect(b).toHaveAttribute('aria-disabled', 'true');
      expect(b).not.toBeDisabled();
      await userEvent.click(b);
    }
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('an AI error leaves every tile and chip enabled, at a turn and at a replacement: a pick only records the choice', async () => {
    const onChoose = vi.fn();
    const { unmount } = render(<YourChoice node={node({ aiError: 'AI undefined' })} {...props} onChoose={onChoose} />);
    for (const b of options()) {
      expect(b).toBeEnabled();
      await userEvent.click(b);
    }
    expect(onChoose.mock.calls).toEqual([[MOVE0], [MOVE1], [SWITCH1], [SWITCH2]]);
    unmount();
    render(<YourChoice node={node({ phase: 'playerReplacement', aiError: 'AI undefined', choices: SWITCHES })} {...props} onChoose={onChoose} />);
    await userEvent.click(tile(/^Gloom/));
    expect(onChoose.mock.calls.at(-1)).toEqual([SWITCH2]);
  });

  it('keeps the may-not-move line under the options', () => {
    const { container } = render(<YourChoice node={node({ status: 'paralysed' })} {...props} />);
    expect(container).toHaveTextContent('Prinplup is paralysed: it may not move.');
  });
});
