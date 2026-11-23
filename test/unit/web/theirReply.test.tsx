// Their reply (TheirReply.tsx): "Next move likelihood" as a list of odds bars, the rows' tones and words, the type chip,
// picking a move, the other steps' headings, and the AI error.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LineAiChoiceJson, LineMoveDamageJson, LineNodeJson, LineRationalJson } from '../../../src/server/apiTypes';
import { TheirReply } from '../../../web/src/components/tree/TheirReply';
import { REPLY_BLIND } from '../../../web/src/tree';

const r = (num: number, den: number): LineRationalJson => ({ num: String(num), den: String(den) });
const ZERO = r(0, 1);
const ONE = r(1, 1);

function move(name: string, over: Partial<LineMoveDamageJson> = {}): LineMoveDamageJson {
  return {
    name, hitChance: 1, status: false, percent: [10, 12], critPercent: [15, 18], ko: 0, koCrit: 0,
    koExact: [ZERO, ZERO, ZERO, ZERO], koCritExact: ZERO, hp: [5, 6], critHp: [8, 9], note: null, priority: 0, survives: null, ...over,
  };
}
const pick = (label: string, p: LineRationalJson): LineAiChoiceJson => ({ label, probability: p, percent: Number(p.num) / Number(p.den) * 100 });
function mon(name: string, hp: number, maxHp: number) {
  return { ident: name, name, species: name, level: 20, hp, maxHp, percent: 50, status: null, boosts: {}, item: null, ability: 'x', fainted: false, active: true, moves: [] };
}
function node(over: { moves?: LineMoveDamageJson[]; choices?: LineAiChoiceJson[]; phase?: LineNodeJson['phase']; aiError?: string; noActive?: boolean; noDamage?: boolean }): LineNodeJson {
  return {
    phase: over.phase ?? 'turnChoice',
    view: { player: { active: over.noActive ? null : mon('Prinplup', 51, 61), party: [] }, enemy: { active: mon('Numel', 20, 20), party: [] }, field: { weather: null, conditions: [], player: [], enemy: [] } },
    aiOdds: over.choices === undefined ? undefined : { kind: over.phase === 'enemyReplacement' ? 'replacement' : 'turn', choices: over.choices },
    aiError: over.aiError,
    damage: over.phase === 'enemyReplacement' || over.noDamage ? undefined : { yours: [], theirs: over.moves ?? [], against: 'Prinplup', order: null },
  } as unknown as LineNodeJson;
}

const dangerous = move('Flamethrower', { hp: [22, 27], percent: [44, 54], koExact: [r(1, 4), ONE, ONE, ONE], koCritExact: ONE });
const warning = move('Flame Wheel', { koExact: [ZERO, r(51, 128), ONE, ONE], koCritExact: r(1, 2) });
const idle = move('Tackle');
const turn = () => node({ moves: [dangerous, warning, idle], choices: [pick('Flamethrower', r(1, 2)), pick('Flame Wheel', r(1, 3)), pick('Tackle', r(1, 6)), pick('Switch to Onix', ZERO)] });
// The odds bars' fixture: AncientPower (Rock), Earth Power (Ground), Growl (status) and a switch.
const ancient = move('AncientPower', { type: 'Rock' });
const full = () => node({
  moves: [ancient, move('Earth Power', { type: 'Ground' }), move('Growl', { status: true, percent: null, hp: null, koExact: null, koCritExact: null })],
  choices: [pick('AncientPower', r(4702, 10000)), pick('Switch to Onix', r(3, 10)), pick('Earth Power', r(1298, 10000)), pick('Growl', r(1, 10))],
});

const items = (root: HTMLElement) => within(root).getAllByRole('listitem');
const names = (root: HTMLElement) => items(root).map((li) => li.querySelector('.likelihood-move')!.textContent);
const row = (name: string) => items(screen.getByRole('list')).find((li) => li.querySelector('.likelihood-move')!.textContent === name)!;
const region = () => screen.getByRole('region', { name: 'Their reply' });

afterEach(() => vi.restoreAllMocks());

describe('TheirReply', () => {
  it('is a list under "Next move likelihood", with the odds line and the blind note at a turn choice, and no buttons without onSelect', () => {
    const { container } = render(<TheirReply node={turn()} />);
    expect(within(region()).getByRole('heading', { level: 4, name: 'Next move likelihood' })).toBeInTheDocument();
    expect(region()).toHaveTextContent("The AI's exact odds against Prinplup.");
    expect(region()).toHaveTextContent(REPLY_BLIND);
    expect(region()).not.toHaveTextContent('Pick a move');
    expect(screen.getByRole('list')).toHaveClass('likelihood');
    expect(names(region())).toEqual(['Flamethrower', 'Flame Wheel', 'Tackle', 'Switch to Onix']);
    expect(region().querySelector('table, .tree-reply-odds')).toBeNull();
    expect(screen.queryAllByRole('button').filter((b) => !b.classList.contains('info-tip-button'))).toHaveLength(0);   // the heading's ⓘ only
    expect(container.querySelectorAll('.likelihood-bar.is-unknown')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/\b(line|death|dead|p1|p2|solver|plan)\b/i);
  });

  it("styles the rows by tone, bolds a danger row's KO words, and gives each figure its exact fraction as a title", () => {
    render(<TheirReply node={turn()} />);
    expect(row('Flamethrower')).toHaveClass('likelihood-row', 'is-danger');
    expect(row('Flame Wheel')).toHaveClass('is-warn');
    expect(row('Switch to Onix')).toHaveClass('is-zero');
    expect(row('Tackle').className).not.toMatch(/is-/);
    expect(row('Flamethrower').querySelector('strong.tree-reply-ko')).toHaveTextContent('Can KO you: OHKO 25% · on a crit 100%');
    expect(row('Flamethrower').querySelector('.likelihood-range')).toHaveTextContent('22–27 HP (44–54%) · on a crit up to 9 HP (18%)');
    expect(row('Flame Wheel').querySelector('strong')).toBeNull();
    expect(screen.getByTitle('1/2')).toHaveTextContent('50%');
    expect(screen.getByTitle('1/3')).toHaveClass('tree-num');
    expect(screen.getByTitle('0/1')).toHaveTextContent('0%');
  });

  it('draws each bar as wide as its exact share with no figure of its own, a type chip, a status row, and a bare switch row', () => {
    const { container } = render(<TheirReply node={full()} />);
    const bar = (name: string) => row(name).querySelector('.likelihood-bar')!;
    expect(bar('AncientPower')).toHaveAttribute('aria-hidden', 'true');
    expect(bar('AncientPower').firstElementChild).toHaveStyle({ width: '47.02%' });
    expect(bar('Switch to Onix').firstElementChild).toHaveStyle({ width: '30%' });
    expect(bar('Growl').textContent).toBe('');
    expect([...container.querySelectorAll('.type-chip')].map((c) => [c.textContent, c.getAttribute('data-type')])).toEqual([['Rock', 'Rock'], ['Ground', 'Ground']]);
    expect(row('Growl')).toHaveTextContent('Status move · no damage');
    expect(row('Switch to Onix').textContent).toBe('Switch to Onix30%');
  });

  it('says the priority after a priority move\'s name and nothing for priority 0; two rows of one name raise no key warning', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<TheirReply node={node({ moves: [move('Quick Attack', { priority: 1 }), idle, move('Tackle')], choices: [pick('Quick Attack', r(1, 2)), pick('Tackle', r(1, 4)), pick('Tackle', r(1, 4))] })} />);
    expect(row('Quick Attack').querySelector('.tree-reply-priority')).toHaveTextContent('Priority +1');
    expect(row('Tackle').textContent).not.toContain('Priority');
    expect(error.mock.calls.filter((call) => String(call[0]).includes('same key'))).toEqual([]);
  });

  it('makes each move row a button when onSelect is given; a click picks it and the selected one is pressed', () => {
    const onSelect = vi.fn();
    render(<TheirReply node={full()} selected="AncientPower" onSelect={onSelect} />);
    const buttons = within(screen.getByRole('list')).getAllByRole('button');
    expect(buttons).toHaveLength(3);
    expect(buttons.every((b) => b.getAttribute('type') === 'button' && b.classList.contains('likelihood-pick'))).toBe(true);
    expect(screen.getByRole('button', { name: /^AncientPower/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Earth Power/ })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: /^AncientPower/ }));
    expect(onSelect).toHaveBeenCalledWith('AncientPower');
    expect(screen.queryByRole('button', { name: /Switch to Onix/ })).toBeNull();
    expect(region()).toHaveTextContent("The AI's exact odds against Prinplup. Pick a move to see its non-crit and crit damage.");
  });

  it('is only the name, the bar and the percent when the step has odds and no damage; an unknown share is left empty', () => {
    const { container, unmount } = render(<TheirReply node={node({ noDamage: true, choices: [pick('Tackle', ONE)] })} />);
    expect(container.querySelector('li')!.textContent).toBe('Tackle100%');
    expect(container.querySelector('.likelihood-range, .likelihood-ko')).toBeNull();
    unmount();
    render(<TheirReply node={node({ moves: [idle], choices: [pick('Other', ONE)] })} />);
    expect(row('Tackle').querySelector('.likelihood-percent')).toBeEmptyDOMElement();       // the odds do not say, nor make up all of them
  });

  it('other steps: the old heading with no active Pokémon of his, his reply to yours at a replacement of yours, "Next the trainer sends out"', () => {
    const { unmount } = render(<TheirReply node={node({ moves: [idle], choices: [pick('Tackle', ONE)], noActive: true })} />);
    expect(screen.getByRole('heading', { name: 'Next move likelihood' })).toBeInTheDocument();
    expect(screen.queryByText(/The AI's exact odds against/)).toBeNull();
    unmount();
    const second = render(<TheirReply node={node({ phase: 'playerReplacement' as LineNodeJson['phase'], moves: [idle], choices: [pick('Tackle', ONE)] })} />);
    expect(screen.getByRole('heading', { name: 'Their reply to Prinplup (51/61)' })).toBeInTheDocument();
    second.unmount();
    render(<TheirReply node={node({ phase: 'enemyReplacement', choices: [pick('Onix', r(1, 4)), pick('Geodude', r(3, 4))] })} />);
    expect(within(region()).getByRole('heading', { name: 'Next the trainer sends out' })).toBeInTheDocument();
    expect(region()).not.toHaveTextContent(REPLY_BLIND);
    expect(region()).not.toHaveTextContent('exact odds against');
    expect(items(region()).map((x) => x.textContent)).toEqual(['Geodude75%', 'Onix25%']);
  });

  it.each([
    ['without the AI odds', undefined],
    ['with an AI error', 'no model'],
  ])('%s at a turn choice with damage it is "Their moves", with no odds note', (_, aiError) => {
    const { container } = render(<TheirReply node={node({ moves: [dangerous, idle], aiError })} onSelect={() => undefined} />);
    expect(within(region()).getByRole('heading', { level: 4, name: 'Their moves' })).toBeInTheDocument();
    expect(region()).not.toHaveTextContent(/likelihood|exact odds|Pick a move/);
    expect(container.querySelector('.likelihood-note')).toBeNull();
    expect(names(region())).toEqual(['Flamethrower', 'Tackle']);
    if (aiError === undefined) return;
    expect(region()).not.toHaveTextContent(REPLY_BLIND);                                    // the AI is not modelled: no blind line
    for (const bar of container.querySelectorAll('.likelihood-bar')) expect(bar).toHaveClass('is-unknown');
  });

  it('an AI error with no damage keeps the warning banner, its detail folded, and no rows', () => {
    render(<TheirReply node={node({ moves: [ancient], noDamage: true, aiError: 'The AI has no move here' })} selected="x" onSelect={() => {}} />);
    expect(screen.getByText('How the trainer chooses here is not modelled.').closest('.banner')).toHaveClass('banner-warn');
    expect(screen.getByText('The AI has no move here').closest('details')).not.toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(region()).not.toHaveTextContent('The trainer picks without seeing');
  });
});
