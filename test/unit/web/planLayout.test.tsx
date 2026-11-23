// The plan screen's layout. jsdom lays nothing out, so web/src/styles/plan.css is read for the rules that make three
// columns, the two-column band below 1180 px, and keep the page from scrolling sideways; the columns are rendered for the
// box and team, Try and the field panel. The layout itself is measured in a real browser.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftMonJson, MonRef, SheetJson } from '../../../src/server/apiTypes';
import { postPlanStep } from '../../../web/src/api';
import { PlanView } from '../../../web/src/components/PlanView';
import { planServer } from './planServer';
import { stubDraft } from './planDraft';
import { box, draftOptions, sheetOf, stubFetch, trainerById, TRISTAN } from './stubServer';

interface Block { prelude: string; body: string }
/** The top-level blocks of `text`, each its prelude and body. */
function blocks(text: string): Block[] {
  const found: Block[] = [];
  let depth = 0;
  let preludeAt = 0;
  let bodyAt = 0;
  let prelude = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') {
      if (depth === 0) {
        prelude = text.slice(preludeAt, i).trim();
        bodyAt = i + 1;
      }
      depth += 1;
    } else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        found.push({ prelude, body: text.slice(bodyAt, i) });
        preludeAt = i + 1;
      }
    }
  }
  return found;
}
function selectorsOf(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < prelude.length; i += 1) {
    if (prelude[i] === '(') depth += 1;
    else if (prelude[i] === ')') depth -= 1;
    else if (prelude[i] === ',' && depth === 0) {
      out.push(prelude.slice(from, i));
      from = i + 1;
    }
  }
  out.push(prelude.slice(from));
  return out.map((s) => s.trim().replace(/\s+/g, ' '));
}
const read = (path: string) => readFileSync(resolve(__dirname, '../../../web/src', path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const css = read('styles/plan.css');
const sheetCss = blocks(css);
function bodiesFor(found: readonly Block[], selector: string): string {
  const bodies = found.filter((b) => selectorsOf(b.prelude).includes(selector)).map((b) => b.body);
  if (bodies.length === 0) throw new Error(`no "${selector} {" block`);
  return bodies.join('\n');
}
const rule = (selector: string) => bodiesFor(sheetCss, selector);
// The plan's own width, not the window's: 1147 px is the plan in a 1179 px window, and with Edit team open the plan at
// 1366 px is about as wide as at 960.
const NARROW = '@container plan (max-width: 1147px)';
const narrow = (selector: string) => bodiesFor(sheetCss.filter((b) => b.prelude === NARROW).flatMap((b) => blocks(b.body)), selector);

describe('plan.css', () => {
  it.each<[string, (s: string) => string, string, RegExp]>([
    // Three columns, the left one sticky under the header; sized by the plan's own width.
    ['a grid', rule, '.plan-grid', /display:\s*grid/],
    ['of three columns', rule, '.plan-grid', /grid-template-columns:\s*272px minmax\(0, 1fr\) 322px/],
    ['aligned to the top', rule, '.plan-grid', /align-items:\s*start/],
    ['the left column sticky', rule, '.plan-left', /position:\s*sticky/],
    ['under the header', rule, '.plan-left', /top:\s*var\(--sticky-top\)/],
    ['a container', rule, '.plan', /container:\s*plan \/ inline-size/],
    // Below 1180 px: two columns, the box and team a full-width band, the action two columns with the picks under both.
    ['two columns when narrow', narrow, '.plan-grid', /grid-template-columns:\s*minmax\(0, 1fr\) 300px/],
    ['the left column a full-width band when narrow', narrow, '.plan-left', /grid-column:\s*1 \/ -1/],
    ['not sticky when narrow', narrow, '.plan-left', /position:\s*static/],
    ['the action in two when narrow', narrow, '.plan-action', /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/],
    ['the picks under both when narrow', narrow, '.plan-action', /'m t'\s*'p p'/],
    ['the whole plan rows a grid, the turn first', rule, '.plan-row', /grid-template-columns:\s*42px /],
    ['the rows when narrow', narrow, '.plan-row', /grid-template-columns:\s*42px /],
    ['the row note on its own line when narrow', narrow, '.plan-row-note', /grid-column:\s*2 \/ -1/],
    // Colour in tokens.
    ["his card's label --ok", rule, ".plan-card[data-side='mine'] > .matchup-label", /var\(--ok\)/],
    ["theirs --danger", rule, ".plan-card[data-side='theirs'] > .matchup-label", /var\(--danger\)/],
    ['the badge --accent-fill', rule, '.plan-badge', /background:\s*var\(--accent-fill\)/],
    ['the note grows with its content', rule, '.plan-note textarea', /field-sizing:\s*content/],
    ['the HP track', rule, '.plan-bar', /var\(--hp-track\)/],
    ['the HP fill', rule, '.plan-bar > span', /var\(--hp\)/],
    ['the chips joined by a line', rule, '.plan-chip::after', /background:\s*var\(--border\)/],
    ['none after the last', rule, '.plan-chip:last-child::after', /display:\s*none/],
    ['Remove this turn and Undo accent text on the surface', rule, '.plan .button-link', /color:\s*var\(--accent\)/],
    ['the split rows a grid', rule, '.plan-split .crit-row', /display:\s*grid/],
    ['the panels on the surface', rule, '.plan-pan', /background:\s*var\(--surface\)/],
    ['cards muted', rule, '.plan-card', /background:\s*var\(--surface-muted\)/],
    ['the exchange muted', rule, '.plan-split', /background:\s*var\(--surface-muted\)/],
    ['the order one quiet line', rule, '.plan-order', /font-size:\s*var\(--text-sm\)/],
    ['their side striped danger', rule, '.plan-split.is-danger', /border-left:\s*var\(--stripe\) solid var\(--danger\)/],
    ['or warn', rule, '.plan-split.is-warn', /border-left:\s*var\(--stripe\) solid var\(--warn\)/],
    ['the exchange heading large', rule, '.plan-split h4', /font-size:\s*var\(--text-lg\)/],
    ["the roster's level at --text-xs", rule, '.plan-roster small', /font-size:\s*var\(--text-xs\)/],
    ['the name field at --tap-size', rule, '.plan-name', /(^|[\s;])height:\s*var\(--tap-size\)/],
    ['his name in a row gives way before the pick', rule, '.plan-row-mine', /overflow:\s*hidden/],
    ['and its token', rule, '.plan-row-mine > .tok', /max-width:\s*100%/],
  ])('%s', (_, at, selector, pattern) => {
    expect(at(selector)).toMatch(pattern);
  });

  it('lets every column shrink and wraps names and notes, so nothing scrolls sideways at 960 px; a card name wraps beside its disc', () => {
    for (const selector of ['.plan-left', '.plan-centre', '.plan-right', '.plan-action > *']) expect(rule(selector), selector).toMatch(/min-width:\s*0/);
    for (const selector of ['.plan-card', '.plan-card-meta', '.plan-split h4', '.plan-note textarea', '.plan-order']) expect(rule(selector), selector).toMatch(/overflow-wrap:\s*anywhere/);
    const all = (selectors: string[], ...patterns: RegExp[]) => {
      for (const selector of selectors) for (const pattern of patterns) expect(rule(selector), selector).toMatch(pattern);
    };
    all(['.plan-card .tok > :not(.disc)', '.plan-opponent-active .tok > :not(.disc)'], /white-space:\s*normal/, /overflow:\s*visible/);
    all(['.plan-split .crit-damage', '.plan-split .crit-chance', '.plan-right .likelihood-percent', '.plan-right .likelihood-range'], /font-variant-numeric:\s*tabular-nums/);
    all(['.plan-note textarea', '.plan-fight-note', '.plan-name'], /background:\s*var\(--surface\)/, /color:\s*var\(--text\)/);
    expect(sheetCss.some((b) => b.prelude.startsWith('@media (max-width'))).toBe(false);
  });

  it('fills only the turn badge with the primary colour, takes .selected\'s look for the current row and chip, and outlines no surface', () => {
    expect(sheetCss.filter((b) => /background:\s*var\(--accent-fill\)/.test(b.body)).map((b) => b.prelude)).toEqual(['.plan-badge']);
    for (const selector of [".plan-row[aria-current='true']", ".plan-chip[aria-current='true']"]) {
      expect(rule(selector), selector).toMatch(/background:\s*var\(--accent-surface\)/);
      expect(rule(selector), selector).toMatch(/border-color:\s*var\(--accent\)/);
      expect(rule(selector), selector).not.toMatch(/var\(--accent-fill\)/);
    }
    for (const selector of ['.plan-pan', '.plan-card', '.plan-split', '.plan-roster li', '.plan-note', '.plan-order', '.plan-row-turn', '.plan-cleared']) {
      expect(rule(selector), selector).not.toMatch(/(^|[\s;])border(-top)?:/);
    }
    expect(rule('.plan-note')).not.toMatch(/background|border/);
    expect(rule('.plan-order')).not.toMatch(/background/);
    expect(rule('.plan-pick .tree-chips')).not.toMatch(/border|dashed/);
    expect(css).not.toMatch(/dashed var\(--border\)/);
    expect(sheetCss.filter((b) => selectorsOf(b.prelude).some((s) => s.startsWith('.plan-card.is-fainted'))).some((b) => /opacity:\s*var\(--dim\)/.test(b.body))).toBe(true);
  });

  it('keeps --radius-lg for the outer panels only; is imported by main.tsx; the planning page has one column, the team column gone', () => {
    for (const selector of ['.plan-card', '.plan-split', '.plan-row', '.plan-next .button-primary']) expect(rule(selector), selector).toMatch(/border-radius:\s*var\(--radius\)/);
    expect(sheetCss.filter((b) => /border-radius:\s*var\(--radius-lg\)/.test(b.body)).map((b) => selectorsOf(b.prelude))).toEqual([['.plan-pan', '.plan-head', '.plan-turn', '.plan-right > section']]);
    expect(read('main.tsx')).toContain("import './styles/plan.css';");
    const page = blocks(read('styles.css'));
    expect(bodiesFor(page, '.fight.is-planning')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(bodiesFor(page, '.fight-team[hidden]')).toMatch(/display:\s*none/);
  });
});

describe('PlanView: the columns', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it('the left column holds the box and team, which hide and show; Try leads with a box Pokémon; the right column holds the list and the Field', async () => {
    const TEAM: MonRef[] = ['party:1', 'party:2'];
    const DRAFT: DraftMonJson[] = [{ ref: 'party:1' }, { ref: 'party:2' }];
    const base = sheetOf(TRISTAN);
    const SHEET: SheetJson = { ...base, enemies: ['Imp', 'Mouse'].map((name, i) => ({ ...base.enemies[0]!, name, key: `enemy:${i}` })) };
    const server = planServer();
    stubFetch(server.routes);
    render(<PlanView fight={{ trainerId: TRISTAN, variant: 0 }} trainer={trainerById(TRISTAN)} sheet={SHEET} sheetError={null} box={box()} team={TEAM} draft={DRAFT}
      options={draftOptions()} active onDraftProblem={vi.fn()} onPlanning={vi.fn()} onAddToTeam={vi.fn()} teamDraft={stubDraft(TEAM, DRAFT)} teamOpen={false} onToggleTeam={vi.fn()} step={postPlanStep} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Start with Blaze (Monferno)' }));
    await screen.findByRole('button', { name: /^Scratch/ });
    const left = within(document.querySelector<HTMLElement>('.plan-left')!);
    const right = within(document.querySelector<HTMLElement>('.plan-right')!);

    expect(left.getByRole('heading', { name: /^Box \(/ })).toBeInTheDocument();
    expect(left.getByRole('heading', { name: 'Team (2)' })).toBeInTheDocument();
    expect(left.getByRole('button', { name: 'Hide box and team' })).toHaveAttribute('aria-expanded', 'true');
    await user.click(left.getByRole('button', { name: 'Hide box and team' }));
    expect(left.getByRole('button', { name: 'Show box and team' })).toHaveAttribute('aria-expanded', 'false');
    expect(left.queryByRole('heading', { name: 'Team (2)' })).toBeNull();
    await user.click(left.getByRole('button', { name: 'Show box and team' }));
    expect(left.getByRole('heading', { name: 'Team (2)' })).toBeInTheDocument();

    const before = server.requests().length;
    await user.click(left.getByRole('button', { name: 'Actions for Big (Bibarel)' }));
    await user.click(left.getByRole('menuitem', { name: 'Try Big (Bibarel)' }));
    await act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
    expect(server.requests().length).toBeGreaterThan(before);
    expect(server.requests().at(-1)!.team[0]).toBe('box:1:4');
    expect(within(screen.getByRole('region', { name: 'Your Pokémon' })).getByTitle('Big (Bibarel)')).toBeInTheDocument();

    for (const name of ['Next move likelihood', 'Field']) expect(right.getByRole('heading', { name })).toBeInTheDocument();
    expect(right.getByRole('group', { name: 'Field and boosts' })).toBeInTheDocument();
    expect(right.getByText('Carries to the next turn.')).toBeInTheDocument();
    expect(within(document.querySelector<HTMLElement>('.plan-centre')!).queryByRole('heading', { name: 'Next move likelihood' })).toBeNull();
  });
});
