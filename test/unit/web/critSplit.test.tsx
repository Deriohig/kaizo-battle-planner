// CritSplit and splitRows: the non-crit and crit rows of a move with their exact chances; DamageBand: the band's
// geometry in percent of the bar, the decorative bar, and the caption beside it.

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LineMoveDamageJson, LineRationalJson } from '../../../src/server/apiTypes';
import { CritSplit } from '../../../web/src/components/tree/CritSplit';
import { BandBar, DamageBand, bandParts } from '../../../web/src/components/tree/DamageBand';
import { splitRows } from '../../../web/src/line';

const r = (num: number, den: number): LineRationalJson => ({ num: String(num), den: String(den) });
const ZERO = r(0, 1);
const ONE = r(1, 1);
const NO_NUMBERS = { percent: null, critPercent: null, hp: null, critHp: null, koExact: null, koCritExact: null };
const PER_HIT = '1/16 per hit; the chance for the whole move depends on how many hits land';

/** Aqua Cutter on Lileep: 30–36 HP (68.2–81.8%), 45–54 HP on a crit; 2HKO 100%, OHKO 100% on a crit. */
function move(over: Partial<LineMoveDamageJson> = {}): LineMoveDamageJson {
  return {
    name: 'Aqua Cutter', hitChance: 1, status: false, percent: [68.2, 81.8], critPercent: [102.3, 122.7], ko: 0, koCrit: 1,
    koExact: [ZERO, ONE, ONE, ONE], koCritExact: ONE, hp: [30, 36], critHp: [45, 54], note: null, priority: 0, ...over,
  };
}

describe('splitRows', () => {
  it("gives the plan's example, the crit at the base rate when the server sent none, and the server's chance exactly when sent", () => {
    expect(splitRows(move())).toEqual([
      { label: 'Non-crit', chance: r(15, 16), base: true, damage: '30–36 HP (68.2–81.8%)', ko: '2HKO 100%' },
      { label: 'Crit', chance: r(1, 16), base: true, damage: '45–54 HP (102.3–122.7%)', ko: 'OHKO 100% on a crit' },
    ]);
    expect(splitRows(move({ critChance: r(1, 8) })).map((x) => [x.chance, x.base])).toEqual([[r(7, 8), false], [r(1, 8), false]]);
  });

  it.each<[string, Partial<LineMoveDamageJson>, [string, string]]>([
    ['an OHKO', { koExact: [r(1, 2), ONE, ONE, ONE] }, ['OHKO 50%', 'OHKO 100% on a crit']],
    ['no KO in 4 hits', { koExact: [ZERO, ZERO, ZERO, ZERO], koCritExact: ZERO }, ['No KO in 4 hits', 'No OHKO on a crit']],
    ['no crit figure', { koCritExact: null }, ['2HKO 100%', '']],
    ['a hit chance', { hitChance: 0.85 }, ['Hits 85% · if it hits: 2HKO 100%', 'Hits 85% · if it hits: OHKO 100% on a crit']],
    ['a hit chance and no crit figure', { hitChance: 0.85, koCritExact: null }, ['Hits 85% · if it hits: 2HKO 100%', '']],
    ['a Focus Sash after an OHKO claim', { survives: 'Focus Sash' }, ['2HKO 100%', 'OHKO 100% on a crit · Focus Sash: survives one hit from full HP']],
    ['a Focus Sash and no OHKO', { survives: 'Focus Sash', koCritExact: ZERO }, ['2HKO 100%', 'No OHKO on a crit']],
  ])('reads the rows\' KO words for %s', (_, over, kos) => {
    expect(splitRows(move(over)).map((x) => x.ko)).toEqual(kos);
  });

  it('gives one row of chance 1 when no crit can land (0/1), one with no chance when the server could not tell, none without numbers', () => {
    const noCrit = { critHp: null, critPercent: null, koCritExact: null };
    expect(splitRows(move({ ...noCrit, critChance: ZERO }))).toEqual([{ label: 'Non-crit', chance: ONE, base: false, damage: '30–36 HP (68.2–81.8%)', ko: '2HKO 100%' }]);
    expect(splitRows(move({ ...noCrit, critChance: null }))).toEqual([{ label: 'Non-crit', chance: null, base: false, damage: '30–36 HP (68.2–81.8%)', ko: '2HKO 100%' }]);
    expect(splitRows(move(noCrit))[0]!.chance).toBeNull();
    expect(splitRows(move({ ...NO_NUMBERS, status: true }))).toEqual([]);
    expect(splitRows(move({ ...NO_NUMBERS, note: 'Fixed damage' }))).toEqual([]);
  });

  it('labels a multi-hit move by every hit and no hit, with no chance, the per-hit chance in the title', () => {
    expect(splitRows(move({ name: 'Double Kick', multiHit: true, critChance: r(1, 16), koCritExact: r(1, 2) }))).toEqual([
      { label: 'No hit crits', chance: null, base: false, damage: '30–36 HP (68.2–81.8%)', ko: '2HKO 100%', title: PER_HIT },
      { label: 'Every hit crits', chance: null, base: false, damage: '45–54 HP (102.3–122.7%)', ko: 'OHKO 50% if every hit crits', title: PER_HIT },
    ]);
    const fury = splitRows(move({ name: 'Fury Attack', multiHit: true, koCritExact: ZERO, hitChance: 0.85 }));
    expect(fury.map((x) => [x.label, x.chance, x.base])).toEqual([['No hit crits', null, true], ['Every hit crits', null, true]]);
    expect(fury[1]).toMatchObject({ ko: 'Hits 85% · if it hits: No OHKO if every hit crits', title: PER_HIT });
    expect(splitRows(move({ name: 'Fury Attack', multiHit: true }))[1]!.ko).toBe('OHKO 100% if every hit crits');
  });
});

describe('CritSplit', () => {
  const draw = (m: LineMoveDamageJson, hot: 'mine' | 'theirs' = 'theirs') => render(<CritSplit move={m} targetName="Lileep" hot={hot} />).container;
  const texts = (c: HTMLElement, part: string) => [...c.querySelectorAll(`.crit-row .${part}`)].map((e) => e.textContent);

  it('draws the two rows with their texts and a band, named for the move and target, with nothing to press', () => {
    const c = draw(move());
    expect(texts(c, 'crit-label')).toEqual(['Non-crit', 'Crit']);
    expect(texts(c, 'crit-chance')).toEqual(['(93.75%)', '(6.25%)']);
    expect(texts(c, 'crit-damage')[0]).toBe('30–36 HP (68.2–81.8%)');
    expect(texts(c, 'crit-ko')).toEqual(['2HKO 100%', 'OHKO 100% on a crit']);
    expect(c.querySelectorAll('.crit-row')[1]!.querySelector('.band')).not.toBeNull();
    expect(c.querySelector('.crit-split')!.getAttribute('aria-label')).toBe('Aqua Cutter on Lileep');
    expect(c.querySelectorAll('button, [role="button"], a, input')).toHaveLength(0);
    // The chance's title says "base rate" only when the server sent none.
    expect(c.querySelector('.crit-chance')!.getAttribute('title')).toMatch(/base rate.*15\/16|15\/16.*base rate/s);
    expect(draw(move({ critChance: r(1, 8) })).querySelector('.crit-chance')!.getAttribute('title')).toBe('7/8');
  });

  /** Each row's KO tone class: 'is-danger', 'is-ok' or ''. */
  const tones = (m: LineMoveDamageJson, hot: 'mine' | 'theirs') =>
    [...draw(m, hot).querySelectorAll('.crit-ko')].map((e) => (e.classList.contains('is-danger') ? 'is-danger' : e.classList.contains('is-ok') ? 'is-ok' : ''));

  it.each<[string, Partial<LineMoveDamageJson>, 'mine' | 'theirs', string[]]>([
    // On his side any row that claims an OHKO is danger, a hit chance in front or not, unless a held item survives it.
    ['his: a crit OHKO', {}, 'mine', ['', 'is-danger']],
    ['his: a plain OHKO', { koExact: [r(1, 2), ONE, ONE, ONE] }, 'mine', ['is-danger', 'is-danger']],
    ['his: a crit OHKO that can miss', { hitChance: 0.85 }, 'mine', ['', 'is-danger']],
    ['his: a Sash survives', { survives: 'Focus Sash' }, 'mine', ['', '']],
    ['his: no crit OHKO', { koCritExact: ZERO }, 'mine', ['', '']],
    // On their side only a sure OHKO 100% that always hits and nothing survives is ok.
    ['theirs: a sure crit OHKO', {}, 'theirs', ['', 'is-ok']],
    ['theirs: sure OHKOs', { koExact: [ONE, ONE, ONE, ONE] }, 'theirs', ['is-ok', 'is-ok']],
    ['theirs: partial OHKOs', { koExact: [r(1, 2), ONE, ONE, ONE], koCritExact: r(1, 2) }, 'theirs', ['', '']],
    ['theirs: can miss', { hitChance: 0.85 }, 'theirs', ['', '']],
    ['theirs: a Sash survives', { survives: 'Focus Sash' }, 'theirs', ['', '']],
    // Beat Up and Triple Kick: the calc runs one plain hit, so a Focus Sash could still stop them.
    ['theirs: Beat Up', { name: 'Beat Up', multiHit: true, koExact: [ONE, ONE, ONE, ONE] }, 'theirs', ['', '']],
  ])('KO tones, %s', (_, over, hot, expected) => {
    expect(tones(move(over), hot)).toEqual(expected);
  });

  it.each<[string, Partial<LineMoveDamageJson>, string, string | null]>([
    ['a status move does no damage', { ...NO_NUMBERS, status: true }, 'Status move · no damage', null],
    ["the server's note for a move without numbers", { ...NO_NUMBERS, note: 'Damage depends on the target' }, 'Damage depends on the target', null],
    ['a non-status move without numbers is not a status move', { ...NO_NUMBERS, note: null }, 'No damage figures here.', 'Status move'],
  ])('says %s', (_, over, said, unsaid) => {
    const c = draw(move(over));
    expect(c.textContent).toContain(said);
    if (unsaid !== null) expect(c.textContent).not.toContain(unsaid);
    expect(c.querySelectorAll('.crit-row')).toHaveLength(0);
  });

  it('says no crit possible under the one row at 100% only when the server says 0/1, and not worked out when it could not tell', () => {
    const noCrit = { critHp: null, critPercent: null, koCritExact: null };
    const none = draw(move({ ...noCrit, critChance: ZERO }), 'mine');
    expect(none.querySelectorAll('.crit-row')).toHaveLength(1);
    expect(none.querySelector('.crit-chance')!.textContent).toBe('(100%)');
    expect(none.textContent).toContain('No crit possible');
    const unknown = draw(move({ ...noCrit, critChance: null }), 'mine');
    expect(unknown.querySelector('.crit-chance')).toBeNull();
    expect(unknown.querySelector('.crit-row')!.textContent).toBe('Non-crit30–36 HP (68.2–81.8%)2HKO 100%');
    expect(unknown.textContent).not.toContain('No crit possible');
    expect(unknown.textContent).toContain('Crit not worked out here');
  });

  it('a multi-hit move shows no chance on either row, and the per-hit chance as the row title', () => {
    const c = draw(move({ name: 'Double Kick', multiHit: true, critChance: r(1, 16), koCritExact: ZERO }));
    expect(texts(c, 'crit-label')).toEqual(['No hit crits', 'Every hit crits']);
    expect(c.querySelector('.crit-chance')).toBeNull();
    expect(c.textContent).not.toContain('6.25%');
    for (const x of c.querySelectorAll('.crit-row')) expect(x.getAttribute('title')).toBe(PER_HIT);
    expect(texts(c, 'crit-ko')[1]).toBe('No OHKO if every hit crits');
    expect(draw(move({ name: 'Fury Attack', multiHit: true })).querySelector('.crit-row')!.getAttribute('title')).toContain('base rate');
  });
});

describe('DamageBand', () => {
  const cutter = (over: Partial<LineMoveDamageJson> = {}) => move({ percent: [44, 54], critPercent: [90, 108], hp: [22, 27], critHp: [45, 54], ...over });

  it.each<[string, LineMoveDamageJson | null, number, boolean, ReturnType<typeof bandParts>]>([
    ['the plain band off the right end of a full bar, the crit top a ghost to the edge', cutter(), 100, false, { fill: 100, low: 44, range: [46, 56], ghost: [0, 46] }],
    ['shifted with the fill', cutter(), 61, false, { fill: 61, low: 44, range: [7, 17], ghost: [0, 7] }],
    ['in crit mode from the crit range, no ghost', cutter(), 100, true, { fill: 100, low: 90, range: [0, 10], ghost: null }],
    ['stopped at 0 when the damage is more than the HP left', cutter(), 30, false, { fill: 30, low: 30, range: [0, 0], ghost: [0, 0] }],
    ['only the fill for no move', null, 61, false, { fill: 61, low: 0, range: [61, 61], ghost: null }],
    ['only the fill for a status move', cutter({ status: true }), 61, false, { fill: 61, low: 0, range: [61, 61], ghost: null }],
    ['only the fill with no percent', cutter({ percent: null }), 61, false, { fill: 61, low: 0, range: [61, 61], ghost: null }],
  ])('bandParts: %s', (_, m, fill, crit, parts) => {
    expect(bandParts(m, fill, crit)).toEqual(parts);
  });

  it('bandParts has no ghost when the crit top is not above the plain top', () => {
    for (const critPercent of [[50, 54] as [number, number], null]) expect(bandParts(cutter({ critPercent }), 100, false).ghost).toBeNull();
  });

  it('a bar the lowest roll empties is drawn as a KO, not a plain black bar; not when a roll leaves HP, for no move, or when a held item survives', () => {
    const ko = (m: LineMoveDamageJson | null, percent: number, crit = false) =>
      render(<BandBar move={m} percent={percent} side="mine" crit={crit} />).container.querySelector('.band')!.classList.contains('is-ko');
    expect([ko(cutter(), 30), ko(cutter(), 80, true)]).toEqual([true, true]);            // crit low 90
    expect([ko(cutter(), 61), ko(null, 0), ko(cutter({ survives: 'Focus Sash' }), 30)]).toEqual([false, false, false]);
  });

  it.each<[string, LineMoveDamageJson | null, string | null]>([
    ['a range', cutter(), 'Aqua Cutter: 22–27 HP (44–54%) · on a crit up to 54 HP (108%)'],
    ['a status move', cutter({ name: 'Growl', ...NO_NUMBERS, status: true }), 'Growl: status move, no damage'],
    ['a note and no numbers', cutter({ name: 'Counter', ...NO_NUMBERS, note: 'Depends on the hit it takes' }), 'Counter: Depends on the hit it takes'],
    ['no numbers and no note', cutter(NO_NUMBERS), null],
    ['no move', null, null],
  ])('captions %s', (_, m, caption) => {
    const c = render(<DamageBand move={m} percent={61} side="mine" />).container;
    expect(c.querySelector('.band-caption')?.textContent ?? null).toBe(caption);
  });

  it('draws a decorative bar of spans whose fill is the percent; BandBar has no caption', () => {
    const { container } = render(<DamageBand move={cutter()} percent={61} side="theirs" />);
    const bar = container.querySelector('.band')!;
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    expect(bar.getAttribute('data-side')).toBe('theirs');
    expect((container.querySelector('.band-fill') as HTMLElement).style.width).toBe('61%');
    expect(container.querySelector('.band-low')).not.toBeNull();
    expect(container.querySelector('.band-range')).not.toBeNull();
    // Spans, never divs: the bar sits inside move buttons.
    expect(container.querySelector('div')).toBeNull();
    expect([bar, ...bar.querySelectorAll('*')].every((e) => e.tagName === 'SPAN')).toBe(true);
    expect(render(<BandBar move={cutter()} percent={50} side="mine" />).container.querySelector('.band-caption')).toBeNull();
  });
});
