// The stylesheet's pins. jsdom lays nothing out, so this reads styles.css (and any lane file under web/src/styles/) for the
// tokens, the type scale, the base rules and the declarations that keep the page from scrolling sideways at phone width.
// Contrast ratios are computed from the token values. One dark theme, so one `:root` token block.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hpBand } from '../../../web/src/hpBand';

interface Block { prelude: string; body: string }

/** The blocks at the top level of `text`, each its prelude (selector or at-rule) and body. */
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

/** A prelude's selectors, split at its top-level commas (not those inside `:not(…)`), each with its whitespace collapsed. */
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

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
// `__dirname`, not `new URL(…, import.meta.url)`: Vite rewrites the latter into an asset URL.
const WEB = resolve(__dirname, '../../../web/src');
const stylesDir = resolve(WEB, 'styles');
/** styles.css, then every lane file under web/src/styles/. */
const files = [
  stripComments(readFileSync(resolve(WEB, 'styles.css'), 'utf8')),
  ...(existsSync(stylesDir)
    ? readdirSync(stylesDir).filter((f) => f.endsWith('.css')).map((f) => stripComments(readFileSync(resolve(stylesDir, f), 'utf8')))
    : []),
];
const css = files[0]!;
const sheet = blocks(css);
const allBlocks = files.flatMap((f) => blocks(f));

/** Whether a block is for `selector`: its whole prelude is it (a grouped list given as is), or one of its selectors is. */
const isFor = (b: Block, selector: string) => b.prelude.replace(/\s+/g, ' ') === selector || selectorsOf(b.prelude).includes(selector);
function bodiesFor(found: readonly Block[], selector: string, where: string): string {
  const bodies = found.filter((b) => isFor(b, selector)).map((b) => b.body);
  if (bodies.length === 0) throw new Error(`styles.css has no "${selector} {" block${where}`);
  return bodies.join('\n');
}
/** The declarations of every top-level block for `selector`, alone or in a grouped rule. */
const rule = (selector: string): string => bodiesFor(sheet, selector, ' at the top level');
/** The declarations of every block for `selector` inside the top-level blocks whose prelude is `media`. */
function at(media: string, selector: string): string {
  const found = sheet.filter((b) => b.prelude === media);
  if (found.length === 0) throw new Error(`styles.css has no "${media}" block`);
  return bodiesFor(found.flatMap((b) => blocks(b.body)), selector, ` inside "${media}"`);
}
const PHONE = '@media (max-width: 860px)';

/** Selectors whose declarations (top level, or inside `media`) must hold a declaration, given as text or a pattern. */
type Pin = [selectors: string[], declaration: string | RegExp, media?: string];
function holds([selectors, declaration, media]: Pin) {
  const pattern = typeof declaration === 'string'
    ? new RegExp(declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:\s*/, ':\\s*'))
    : declaration;
  for (const s of selectors) expect(media === undefined ? rule(s) : at(media, s), s).toMatch(pattern);
}

const declarations = (body: string) => Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
const tokens = declarations(sheet.find((b) => b.prelude === ':root')!.body);
const token = (name: string) => tokens[name]!;

/** The WCAG 2 contrast ratio of two #rrggbb colours. */
function ratio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('the design base', () => {
  it("has every token in one dark theme, with the planner's palette", () => {
    for (const [name, value] of [['--text-xs', '12px'], ['--text-sm', '13px'], ['--text-md', '14px'], ['--text-lg', '16px'], ['--text-xl', '20px'],
      ['--dim', '0.55'], ['--stripe', '4px'], ['--z-sticky', '10'], ['--z-sheet', '30'], ['--header-height', '0px'], ['--matchup-height', '0px'],
      ['--tap-size', '36px'], ['--border-strong', '#6f78b8'], ['--accent-surface', '#27245f'], ['--bg', '#090b18'], ['--ok', '#3fd3a4'],
      ['--accent', '#c3bbff'], ['--accent-fill', '#6f5dfa'], ['--sticky-top', 'calc(var(--header-height) + var(--matchup-height))']] as const) {
      expect(tokens[name], name).toBe(value);
    }
    for (const name of ['--accent-fill-text', '--mine-surface', '--theirs-surface', '--band', '--hp', '--hp-track', '--dmg']) expect(tokens[name], name).toMatch(/^#[0-9a-f]{6}$/i);
    expect(sheet.find((b) => b.prelude === ':root')!.body).toMatch(/color-scheme:\s*dark;/);
    expect(sheet.filter((b) => b.prelude === ':root')).toHaveLength(1);
    expect(tokens['--font-size']).toBeUndefined();
    expect(css).not.toMatch(/var\(--font-size\)/);
  });

  it('the fonts: Plex Sans for text, Chakra Petch for headings, each weight imported', () => {
    expect(tokens['--font-sans']).toMatch(/^'IBM Plex Sans'/);
    expect(tokens['--font-display']).toMatch(/^'Chakra Petch'/);
    holds([['h1', 'h2', 'h3'], 'font-family: var(--font-display)']);
    const main = readFileSync(resolve(WEB, 'main.tsx'), 'utf8');
    for (const imp of ['chakra-petch/latin-500.css', 'chakra-petch/latin-600.css', 'chakra-petch/latin-700.css', 'ibm-plex-sans/latin-400.css',
      'ibm-plex-sans/latin-500.css', 'ibm-plex-sans/latin-600.css']) expect(main).toContain(`import '@fontsource/${imp}';`);
  });

  it('no colour is written outside the :root blocks, in styles.css or a lane file', () => {
    for (const file of files) {
      const rest = blocks(file).map((b) => (b.prelude === ':root' ? '' : `${b.prelude}{${b.body}}`)).join('\n')
        .replace('rgb(0 0 0 / 0.3)', '')
        .replace(/hsl\(calc\(var\(--iv\) \* 120 \/ 31\) 45% 26%\)/g, '');
      expect(rest).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(rest).not.toMatch(/rgba?\(|hsla?\(/);
    }
    // The allowances are the only ones: --shadow (inside :root), the backdrop and the one `.box-iv` rule.
    expect(css.match(/rgb\(/g)?.length).toBe(2);
    expect(css.match(/hsl\(/g)?.length).toBe(1);
  });

  it('every font size is a type token (a lane file may give it a px fallback), and each rule has its size', () => {
    for (const file of files) {
      for (const m of file.matchAll(/font-size:\s*([^;]+);/g)) expect(m[1]!.trim(), m[0]).toMatch(/^(var\(--text-(xs|sm|md|lg|xl)(, ?\d+px)?\)|inherit)$/);
    }
    const size = (sel: string) => /font-size:\s*var\(--text-(xs|sm|md|lg|xl)\)/.exec(rule(sel))?.[1];
    const table: Record<string, string[]> = {
      xs: ['.pill', '.save-newest', '.save-card-path', '.box-evs', '.box-iv', '.box-iv-summary', '.box-table thead th', '.box-notes', '.box-graveyard',
        '.settings-hint', '.settings-path', '.sheet-copy-status', '.matchup-label', '.sheet-cases-head', '.trainer-split h3'],
      // Children of a 13 px parent stay xs: under --text-sm they would be the parent's size and lose the hierarchy.
      'xs children': ['.tree-option-numbers', '.tree-card-detail', '.tree-card-rolls', '.tree-card-exp',
        '.tree-card-crit', '.tree-exact-toggle', '.tree-exact-result'],
      sm: ['.setup-number', '.setup-hint', '.matchup-reply', '.matchup-notes', '.sheet-move', '.sheet-ai-failed', '.sheet-ai-status',
        '.run-fight-location', '.trainer-location', '.tree-card', '.tree-reply'],
      md: ['html', 'h4', '.tab', '.setup-input', '.sheet-copy button', '.matchup-who h4', '.header-file', '.header-saved', '.header-live'],
      lg: ['h2', 'h3', '.empty-state h2', '.setup-step h2', '.box-toolbar h2', '.settings-head h2', '.settings-section h3', '.matchup-enemy-head h3',
        '.fight-title h2', '.team-panel-heading', '.run-heading', '.line-start h3', '.tree-card-pct'],
      xl: ['h1', '.app-header h1'],
    };
    for (const [group, selectors] of Object.entries(table)) {
      for (const sel of selectors) expect(size(sel), `${sel} is ${group}`).toBe(group.slice(0, 2));
    }
  });

  it.each<[string, Pin[]]>([
    ['the page root scrolls targets clear of the sticky parts', [[['html'], 'scroll-padding-top: var(--sticky-top)']]],
    ["the header's file name is regular and muted", [[['.header-file'], 'font-weight: 400'], [['.header-file'], 'color: var(--text-muted)']]],
    ['a pill is an outline, never filled', [[['.pill'], 'background: none']]],
    ['a micro-label is uppercase', [[['.micro-label'], 'text-transform: uppercase']]],
    ['controls, tiles, cards and chips have the strong border; a checkbox takes the accent; a chip is a tap target', [
      [['.button', '.icon-button', '.chip', '.setup-input', '.settings-field input', '.fight-variant select', '.team-panel-add select',
        '.draft-editor select', '.draft-number', '.run-search-input', '.tree-option', '.sheet-move', '.sheet-copy button'], /border(-color)?:[^;]*var\(--border-strong\)/],
      [["input[type='checkbox']"], 'accent-color: var(--accent)'], [['.chip'], 'min-height: var(--tap-size)']]],
  ])('%s', (_, pins) => pins.forEach(holds));

  // The labels sit in `.settings-label` (beside their ⓘ), so `.settings-field > label` matches nothing.
  it("the Settings labels are one level with the sections' headings: one rule for both, on the selector the markup has", () => {
    const has = (b: Block, sel: string) => selectorsOf(b.prelude).includes(sel);
    const both = allBlocks.filter((b) => has(b, '.settings-section h3') && has(b, '.settings-label > label'));
    expect(both).toHaveLength(1);
    expect(both[0]!.body).toMatch(/font-size:\s*var\(--text-lg\)/);
    expect(both[0]!.body).toMatch(/font-weight:\s*600/);
    expect(allBlocks.filter((b) => has(b, '.settings-field > label'))).toEqual([]);
  });

  it('every fade is --dim, every tone edge --stripe wide, and no layer a literal', () => {
    for (const file of files) {
      expect(file).not.toMatch(/opacity:\s*0?\.\d/);
      expect(file).not.toMatch(/z-index:\s*-?\d/);
      for (const m of file.matchAll(/border-left(?:-width)?:\s*\d+px[^;]*;/g)) expect(m[0], 'a literal tone edge').not.toMatch(/var\(--(danger|warn|ok)\)/);
    }
    expect(files.join('\n').match(/opacity:\s*var\(--dim\)/g)?.length).toBeGreaterThanOrEqual(9);
    holds([['.banner'], 'border-left-width: var(--stripe)']);
    holds([['.matchup-pair.is-danger', '.tree-card.is-death', '.sheet-case', '.setup-error'], /border-left:\s*var\(--stripe\) solid var\(--(danger|warn)\)/]);
    for (const tone of ['danger', 'warn', 'ok']) holds([[`.stripe-${tone}`], `border-left: var(--stripe) solid var(--${tone})`]);
    for (const [sel, layer] of [['.app-header', 'var(--z-sticky)'], ['.settings-backdrop', 'var(--z-sheet)'], ['.settings', 'calc(var(--z-sheet) + 1)'],
      ['.skip-link:focus', 'calc(var(--z-sheet) + 2)']] as const) holds([[sel], `z-index: ${layer}`]);
  });

  it('selected is the accent border on the accent surface, never the primary fill, and comes after .chip', () => {
    for (const sel of ['.selected', '.tree-option.is-selected', ".chip[aria-pressed='true']"]) {
      holds([[sel], 'background: var(--accent-surface)']);
      holds([[sel], 'border-color: var(--accent)']);
      for (const block of allBlocks.filter((b) => selectorsOf(b.prelude).includes(sel))) {
        expect(block.body, sel).not.toMatch(/background:\s*var\(--accent(\)\s*;|-fill\))/);
        expect(block.body, sel).not.toMatch(/color:\s*var\(--accent(-fill)?-text\)/);
      }
    }
    // Equal specificity: the later rule wins, so `.chip.selected` gets the selected look.
    expect(css.indexOf('\n.selected,\n')).toBeGreaterThan(css.indexOf('\n.chip {'));
  });

  it('a micro-label is the matchup label; --ok fills nothing but the live dot', () => {
    expect(selectorsOf(sheet.find((b) => selectorsOf(b.prelude).includes('.micro-label'))!.prelude)).toContain('.matchup-label');
    expect(sheet.filter((b) => /background:\s*var\(--ok\)\s*;/.test(b.body)).map((b) => b.prelude)).toEqual(['.header-dot']);
    holds([['.save-newest'], 'background: none']);
  });

  it('contrast passes in the dark theme', () => {
    const at4 = (fgs: string[], bgs: string[], min = 4.5) => {
      for (const fg of fgs) for (const bg of bgs) expect(ratio(token(fg), token(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
    };
    at4(['--text', '--text-muted', '--accent', '--ok', '--warn', '--danger'], ['--surface', '--surface-muted', '--bg', '--accent-surface']);
    at4(['--accent-text'], ['--accent']);
    at4(['--accent-fill-text'], ['--accent-fill']);
    at4(['--text', '--ok'], ['--mine-surface']);
    at4(['--text', '--danger'], ['--theirs-surface']);
    at4(['--band', '--hp'], ['--dmg'], 3);
    at4(['--accent-fill'], ['--surface'], 3);
    at4(['--border-strong'], ['--surface', '--surface-muted', '--bg'], 3);
  });
});

describe('the fight page at phone width (375 px)', () => {
  it.each<[string, Pin[]]>([
    ['the page is one column: the team, then the fight', [[['.fight'], 'grid-template-columns: minmax(0, 1fr)', PHONE]]],
    ['the page header is not sticky', [[['.app-header'], 'position: static', PHONE]]],
    ['the fight strip scrolls inside its own box, never the page', [[['.run-fights'], 'overflow-x: auto'], [['.run-fights'], 'flex-wrap: nowrap'], [['.run'], 'min-width: 0']]],
    // A `.visually-hidden` word is absolute: in a scrolling box with no positioned ancestor it widens the page.
    ["a hidden word inside a scrolling box stays inside it: the strip's double tag and the IV chip are positioned", [[['.pill-double', '.box-iv'], 'position: relative']]],
    ['the columns may shrink below their content, and long names break', [[['.fight-page', '.fight-main', '.team-panel'], 'min-width: 0'], [['.team-panel-name'], 'overflow-wrap: anywhere']]],
    ["the fight's controls wrap onto a second line rather than push the page wider", [[['.fight-controls'], 'flex-wrap: wrap']]],
    ['the draft editor may shrink, its rows wrap, its selects and number fields stay inside', [
      [['.draft-editor', '.draft-editor select', '.draft-stat'], 'min-width: 0'], [['.draft-row'], 'flex-wrap: wrap'],
      [['.draft-editor select', '.draft-number'], 'max-width: 100%'], [['.draft-stats'], 'grid-template-columns: repeat(3, minmax(0, 1fr))']]],
    ["the team's rows, its two buttons and the save-change notice wrap; an editor in a row takes the row's full width", [
      [['.team-panel-row', '.team-panel-tools', '.team-panel-notice'], 'flex-wrap: wrap'], [['.team-panel-row > .draft-editor'], 'flex-basis: 100%']]],
    ['the team, editor, exact-results and Matchups controls are 36 px tall to tap, the icon buttons 36 px wide, a PKCalc link a centred flex box', [
      [['.team-panel button, .team-panel input, .team-panel select, .draft-editor button, .draft-editor input, .draft-editor select',
        '.tree-exact-toggle', '.sheet button', '.sheet summary', '.sheet-pkcalc'], 'min-height: var(--tap-size)', PHONE],
      [['.team-panel .icon-button'], 'min-width: var(--tap-size)', PHONE],
      [['.sheet-pkcalc'], 'display: inline-flex', PHONE], [['.sheet-pkcalc'], 'align-items: center', PHONE]]],
    // A grid display would beat the browser's own `[hidden] { display: none }`.
    ["the draft editor's closed Advanced panel and a card's closed exact results take no room", [[['.draft-advanced-body[hidden]', '.tree-exact[hidden]'], 'display: none']]],
    ["the step's parts shrink with their column, share one surface rule, and break names and numbers inside their boxes", [
      [['.tree-choice', '.tree-reply', '.tree-outcomes', '.tree-card', '.tree-choice, .tree-reply, .tree-outcomes'], 'min-width: 0'],
      [['.tree-choice, .tree-reply, .tree-outcomes'], 'background: var(--surface)'],
      [['.tree-card', '.tree-option', '.tree-exact-result', '.tree-reply-moves'], 'overflow-wrap: anywhere']]],
    ['Matchups is cards that stack: four parts across, two at 1180 px, one at phone width', [
      [['.sheet', '.matchup-enemy', '.matchup-pair', '.matchup-who', '.matchup-side', '.matchup-reply'], 'min-width: 0'],
      [['.matchup-pair'], 'grid-template-columns: minmax(0, 11rem) repeat(3, minmax(0, 1fr))'], [['.matchup-pair'], 'overflow-wrap: anywhere'],
      [['.matchup-pair, .matchup-pair.no-reply'], 'grid-template-columns: repeat(2, minmax(0, 1fr))', '@media (max-width: 1180px)'],
      [['.matchup-pair, .matchup-pair.no-reply'], 'grid-template-columns: minmax(0, 1fr)', PHONE]]],
    // A pair's part can be under 200 px wide: a move list asking for two 8.5rem columns would spill out of it.
    ["Matchups' move lists ask for two columns only where two fit, one at phone width", [
      [['.sheet-moves'], 'grid-template-columns: repeat(auto-fill, minmax(max(min(8.5rem, 100%), (100% - var(--space-1)) / 2), 1fr))'],
      [['.sheet-case-moves'], 'grid-template-columns: minmax(0, 1fr)', PHONE]]],
    // At 1200 px the who part is 11rem: "Copy set" and its "Copied" would run out of it on one line.
    ["a pair's Copy set wraps its status under the button", [[['.matchup-who .sheet-copy'], 'flex-wrap: wrap']]],
  ])('%s', (_, pins) => pins.forEach(holds));

  it('Matchups has no table to scroll', () => expect(css).not.toMatch(/\.sheet-table|\.sheet-scroll/));
});

it('a busy control keeps full contrast and shows a progress cursor; a choice truly disabled keeps its fade', () => {
  expect(css).not.toMatch(/\.tree-(card|exact-result|row-go):disabled/);
  for (const block of sheet.filter((b) => /aria-disabled/.test(b.prelude))) expect(block.body).not.toMatch(/opacity/);
  holds([["[aria-disabled='true']"], 'cursor: progress']);
  holds([['.tree-option:disabled'], 'opacity']);
});

it.each([[100, 'ok'], [50.1, 'ok'], [50, 'warn'], [20.1, 'warn'], [20, 'danger'], [3.3, 'danger'], [0, 'danger']] as const)('hpBand: %s%% is %s', (p, band) => {
  expect(hpBand(p)).toBe(band);
});
