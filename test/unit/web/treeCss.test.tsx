// The tree's step-panel styles: the design tokens used straight from styles.css (no literal colour, no local copies, no
// fallbacks), every tile and chip rule scoped to the tree's own lists, the selected look, and the import.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../../../web/src/styles/tree.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const declarations = [...css.matchAll(/^\s*([a-z-]+)\s*:\s*([^;{}]+);/gm)].map((m) => ({ prop: m[1]!, value: m[2]!.trim() }));
/** Every rule as its selectors (split at top-level commas) and body. */
const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => {
  const selectors: string[] = [];
  let depth = 0;
  let from = 0;
  const prelude = m[1]!;
  for (let i = 0; i < prelude.length; i += 1) {
    if (prelude[i] === '(') depth += 1;
    else if (prelude[i] === ')') depth -= 1;
    else if (prelude[i] === ',' && depth === 0) {
      selectors.push(prelude.slice(from, i));
      from = i + 1;
    }
  }
  selectors.push(prelude.slice(from));
  return { selectors: selectors.map((s) => s.trim().replace(/\s+/g, ' ')), body: m[2]! };
});
/** The bodies of every rule for `selector` (that holds `holding`, when given), joined. */
const bodyOf = (selector: string, holding = '') => rules.filter((r) => r.selectors.includes(selector) && r.body.includes(holding)).map((r) => r.body).join('\n');

describe('tree.css', () => {
  it('every colour-bearing value is a token, and no literal colour is written anywhere', () => {
    const colourProps = declarations.filter(({ prop }) => /^(color|background(-color)?|border.*|box-shadow)$/.test(prop) && !['border-collapse', 'border-radius', 'border-spacing'].includes(prop));
    expect(colourProps.length).toBeGreaterThan(20);
    for (const { prop, value } of colourProps) expect(value, `${prop}: ${value}`).toMatch(/var\(--|^0$|^transparent$|\stransparent$/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/rgba?\(|hsla?\(/);
  });

  it('uses the real tokens straight: no local copies, no :root or dark block, no fallbacks but the type chip\'s, every font size a token', () => {
    expect(css).not.toMatch(/--tree-|:root|prefers-color-scheme|tree-reply-table/);
    expect(css.replace(/var\(--type-[a-z]+, var\(--accent-fill\)\)/g, '')).not.toMatch(/var\(\s*--[\w-]+\s*,/);
    expect(css).toMatch(/var\(--border-strong\)/);
    expect(css).toMatch(/var\(--accent-surface\)/);
    const sizes = declarations.filter(({ prop }) => prop === 'font-size');
    expect(sizes.length).toBeGreaterThan(8);
    for (const { value } of sizes) expect(value).toMatch(/^var\(--text-(xs|sm|md|lg|xl)\)$/);
  });

  it('no bare .chip or .tile rule: each is under .tree-chips or .tree-tiles', () => {
    const hits = rules.flatMap((r) => r.selectors).filter((s) => /\.(chip|tile)(?![\w-])/.test(s));
    expect(hits.length).toBeGreaterThan(4);
    for (const s of hits) {
      if (/\.chip(?![\w-])/.test(s)) expect(s, s).toMatch(/^\.tree-chips \S*\.chip(?![\w-])/);
      if (/\.tile(?![\w-])/.test(s)) expect(s, s).toMatch(/^\.tree-tiles \S*\.tile(?![\w-])/);
    }
  });

  // A picked likelihood row's left stripe already says "can KO you", so it takes the accent surface alone.
  it('selected tiles and chips take the accent surface and border, no 2px border and no padding change; a picked reply row its fill alone', () => {
    const selected = rules.filter((r) => r.selectors.some((s) => /is-selected|aria-pressed/.test(s)) && !r.selectors.some((s) => s.startsWith('.likelihood-pick')));
    expect(selected.map((r) => r.selectors).flat()).toEqual(expect.arrayContaining(['.tree-tiles .tile.is-selected', ".tree-chips .chip[aria-pressed='true']"]));
    for (const { body } of selected) {
      expect(body).toMatch(/background:\s*var\(--accent-surface\)/);
      expect(body).toMatch(/border-color:\s*var\(--accent\)/);
      expect(body).not.toMatch(/2px|padding|border:/);
    }
    const picked = bodyOf(".likelihood-pick[aria-pressed='true']");
    expect(picked).toMatch(/background:\s*var\(--accent-surface\)/);
    expect(picked).not.toMatch(/border/);
  });

  it('every likelihood row lays its bar on the same track: no auto name or percent column, and the KO and damage lines span the row', () => {
    const tracks = (selector: string) => /grid-template-columns:\s*([^;]+);/.exec(bodyOf(selector, 'grid-template-columns'))?.[1]?.trim();
    const row = tracks('.likelihood-row');
    expect(row).toBeDefined();
    expect(tracks('.likelihood-pick')).toBe(row);
    const parts = row!.match(/minmax\([^)]*\)|\S+/g)!;                  // the name, the bar, the percent
    expect(parts).toHaveLength(3);
    for (const part of [parts[0], parts[2]]) expect(part).not.toMatch(/auto|min-content|max-content|fit-content/);
    for (const selector of ['.likelihood-range', '.likelihood-ko']) expect(bodyOf(selector, 'grid-column'), selector).toMatch(/grid-column:\s*1\s*\/\s*-1/);
  });

  it.each<[string, string, RegExp]>([
    ['the tone stripe lets clicks through to the row button', '.likelihood-row.is-danger::before', /pointer-events:\s*none/],
    ['the band is a span drawn as a block', '.band', /display:\s*block/],
    ['the band fill is a span drawn as a block', '.band-fill', /display:\s*block/],
    ['the band range is the amber stripe', '.band-range', /repeating-linear-gradient\([^)]*var\(--band\)/],
    ['the ghost is dimmed', '.band-ghost', /opacity:\s*var\(--dim\)/],
    ['a bar the lowest roll empties is red on his Pokémon', ".band.is-ko[data-side='mine'] .band-low", /background:\s*var\(--danger\)/],
    ['and --ok on theirs', ".band.is-ko[data-side='theirs'] .band-low", /background:\s*var\(--ok\)/],
    ['an unknown likelihood bar is a dashed outline', '.likelihood-bar.is-unknown', /border:\s*1px dashed var\(--border-strong\)/],
    ['with no fill', '.likelihood-bar.is-unknown', /background:\s*transparent/],
    ['the type chip text is the accent fill text', '.type-chip', /color:\s*var\(--accent-fill-text\)/],
    ['the crit split row wraps', '.crit-row', /flex-wrap:\s*wrap/],
  ])('%s', (_, selector, rule) => {
    expect(bodyOf(selector)).toMatch(rule);
  });

  it('every type chip falls back to the accent fill; the KO bar has no side-less rule; no crit split or row is outlined', () => {
    for (const t of ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark']) {
      expect(bodyOf(`.type-chip[data-type='${t}']`), t).toMatch(new RegExp(`background:\\s*var\\(--type-${t.toLowerCase()}, var\\(--accent-fill\\)\\)`));
    }
    expect(bodyOf('.band.is-ko .band-low')).toBe('');
    for (const selector of ['.crit-split', '.crit-row']) expect(bodyOf(selector), selector).not.toMatch(/(^|[\s;])border(-top)?:/);
  });

  it('has no fixed width above 440px, and main.tsx imports it once', () => {
    const widths = (text: string) => [...text.matchAll(/\b(?:min-|max-)?width:\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(widths('.x { max-width: 500px; }\n.y { width:80px; }')).toEqual([500, 80]);           // the check finds a too-wide rule
    for (const w of widths(css)) expect(w).toBeLessThanOrEqual(440);
    const main = readFileSync(resolve(__dirname, '../../../web/src/main.tsx'), 'utf8');
    expect(main.split("import './styles/tree.css';").length - 1).toBe(1);
  });
});
