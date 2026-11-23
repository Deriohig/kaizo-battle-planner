import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiOddsJson, SheetJson, SheetMonJson, SheetMoveJson, SheetPairJson } from '../../../src/server/apiTypes';
import { copyText } from '../../../web/src/clipboard';
import type { SheetAi } from '../../../web/src/components/sheet/AiOdds';
import { MAY_PERSIST_NOTE, SHARED_PREFIX, splitNotes } from '../../../web/src/components/sheet/notes';
import { SheetView } from '../../../web/src/components/SheetView';

// A hand-written sheet: Commander Mars (Purugly, Bronzor) against Blaze the Monferno and a Raichu.

const stats = (hp: number, spe: number) => ({ hp, atk: 50, def: 50, spa: 50, spd: 50, spe });
type Damage = NonNullable<SheetMoveJson['damage']>;

/** A damaging move into `defender`: 16 rolls from `min` to `max`, crits double, percents of its HP and exact KO chances. */
function attack(name: string, min: number, max: number, defender: SheetMonJson, more: Partial<SheetMoveJson> = {}, damage: Partial<Damage> = {}): SheetMoveJson {
  const rolls = damage.rolls ?? Array.from({ length: 16 }, (_, k) => min + Math.round(((max - min) * k) / 15));
  const koExact = koOf(rolls, defender.hp);
  const pct = (hp: number) => Math.floor((hp * 1000) / defender.stats.hp) / 10;          // rounded down, as the calc rounds
  return {
    name, type: 'Normal', category: 'Physical', power: 70, hitChance: 1, inaccurate: false, unmodelled: null, weatherDepends: false,
    damage: {
      rolls, critRolls: rolls.map((roll) => roll * 2), min, max, percent: [pct(min), pct(max)],
      koChance: koExact.map(({ hits, num, den }) => ({ hits, chance: Number(num) / Number(den) })), koExact,
      bounded: true, ohko: false, desc: `${name}: ${min}-${max}`, ...damage,
    },
    ...more,
  };
}

/** The exact chance that 1 to 4 hits KO from `hp`, each hit one of `rolls`, reduced, as the calc counts it. */
function koOf(rolls: number[], hp: number): { hits: number; num: string; den: string }[] {
  const gcd = (x: bigint, y: bigint): bigint => (y === 0n ? x : gcd(y, x % y));
  let dealt = new Map<number, bigint>([[0, 1n]]);
  let total = 1n;
  return [1, 2, 3, 4].map((hits) => {
    const next = new Map<number, bigint>();
    for (const [sum, ways] of dealt) for (const roll of rolls) next.set(Math.min(hp, sum + roll), (next.get(Math.min(hp, sum + roll)) ?? 0n) + ways);
    dealt = next;
    total *= BigInt(rolls.length);
    const ko = dealt.get(hp) ?? 0n;
    const divisor = gcd(ko, total);
    return { hits, num: String(ko / divisor), den: String(total / divisor) };
  });
}

const statusMove = (name: string): SheetMoveJson => ({
  name, type: 'Dark', category: 'Status', power: 0, hitChance: 1, inaccurate: false, unmodelled: null, weatherDepends: false, damage: null,
});
const thunder = (min: number, max: number, defender: SheetMonJson) =>
  attack('Thunder', min, max, defender, { type: 'Electric', category: 'Special', power: 120, hitChance: 0.7, inaccurate: true });
const fakeOut = (min: number, max: number, defender: SheetMonJson) =>
  attack('Fake Out', min, max, defender, { power: 40, unmodelled: 'Flinches the target; works only on the first turn' });

const monferno: SheetMonJson = {
  key: 'party:1', name: 'Monferno', nickname: 'Blaze', level: 16, nature: 'Jolly', ability: 'Blaze', item: 'Oran Berry',
  moves: ['Mach Punch', 'Flame Wheel', 'Taunt'], stats: stats(46, 41), hp: 46, status: null, disputed: [],
  showdown: 'Blaze (Monferno) @ Oran Berry\nLevel: 16\nAbility: Blaze\nJolly Nature\n- Mach Punch\n- Flame Wheel\n- Taunt',
};
const raichu: SheetMonJson = {
  key: 'box:1:3', name: 'Raichu', nickname: null, level: 16, nature: 'Timid', ability: 'Static', item: null,
  moves: ['Thunder', 'Quick Attack'], stats: stats(44, 50), hp: 44, status: null, disputed: [],
  showdown: 'Raichu\nLevel: 16\nAbility: Static\nTimid Nature\n- Thunder\n- Quick Attack',
};
const purugly: SheetMonJson = {
  key: 'enemy:0', name: 'Purugly', nickname: null, level: 17, nature: 'Adamant', ability: 'Thick Fat', item: 'Sitrus Berry',
  moves: ['Body Slam', 'Fake Out'], stats: stats(60, 48), hp: 60, status: null, disputed: [{ field: 'nature', options: ['Adamant', 'Jolly'] }],
  showdown: 'Purugly @ Sitrus Berry\nLevel: 17\nAbility: Thick Fat\nAdamant Nature\n- Body Slam\n- Fake Out',
};
const bronzor: SheetMonJson = {
  key: 'enemy:1', name: 'Bronzor', nickname: null, level: 16, nature: null, ability: 'Levitate', item: null,
  moves: ['Confuse Ray', 'Extrasensory'], stats: stats(40, 41), hp: 40, status: null, disputed: [],
  showdown: 'Bronzor\nLevel: 16\nAbility: Levitate\n- Confuse Ray\n- Extrasensory',
};

const RAIN = { field: 'Rain', weatherMayPersist: false } as const;
const extrasensory = (min: number, max: number, defender: SheetMonJson) =>
  attack('Extrasensory', min, max, defender, { type: 'Psychic', category: 'Special', power: 80 });

const single: SheetJson = {
  trainer: { id: 'mars-windworks', name: 'Commander Mars', location: 'Valley Windworks', battleType: 'single', variant: 0, variants: 2, field: 'PERMANENT RAIN' },
  savedAt: '2026-06-12T12:00:00.000Z', savePath: '/saves/game.dsv',
  notes: ['Docs field note: PERMANENT RAIN'],
  enemies: [purugly, bronzor],
  players: [monferno, raichu],
  pairs: [
    {
      ...RAIN, player: 'party:1', enemy: 'enemy:0', order: 'enemy', playerSpeed: 41, enemySpeed: 48, notes: [],
      playerMoves: [attack('Mach Punch', 27, 32, purugly, { type: 'Fighting', power: 40 }), attack('Flame Wheel', 15, 18, purugly, { type: 'Fire', power: 60 }), statusMove('Taunt')],
      enemyMoves: [attack('Body Slam', 20, 24, monferno, { power: 85 }), fakeOut(8, 10, monferno)],
    },
    {
      ...RAIN, player: 'party:1', enemy: 'enemy:1', order: 'tie', playerSpeed: 41, enemySpeed: 41, notes: [],
      playerMoves: [attack('Mach Punch', 10, 12, bronzor, { type: 'Fighting', power: 40 }), attack('Flame Wheel', 18, 21, bronzor, { type: 'Fire', power: 60 }), statusMove('Taunt')],
      enemyMoves: [statusMove('Confuse Ray'), extrasensory(18, 22, monferno)],
    },
    {
      ...RAIN, player: 'box:1:3', enemy: 'enemy:0', order: 'player', playerSpeed: 50, enemySpeed: 48, notes: [],
      playerMoves: [thunder(23, 27, purugly), attack('Quick Attack', 9, 11, purugly, { power: 40 })],
      enemyMoves: [attack('Body Slam', 40, 47, raichu, { power: 85 }), fakeOut(8, 10, raichu)],
    },
    {
      ...RAIN, player: 'box:1:3', enemy: 'enemy:1', order: 'depends', playerSpeed: 50, enemySpeed: 41, notes: ['Quick Attack moves first'],
      playerMoves: [thunder(15, 18, bronzor), attack('Quick Attack', 6, 8, bronzor, { power: 40 })],
      enemyMoves: [statusMove('Confuse Ray'), extrasensory(20, 24, raichu)],
    },
  ],
};

// The sheet's own note says it is a double; the server adds none of its own.
const double: SheetJson = {
  ...single,
  trainer: { ...single.trainer, battleType: 'double', variants: 1 },
  notes: [...single.notes, "Double battle: can't be built yet. Spread moves deal 3/4 damage here."],
};

/** `sheet` with the pair of `player` and `enemy` changed by `change`. */
function withPair(player: string, enemy: string, change: (pair: SheetPairJson) => SheetPairJson, sheet: SheetJson = single): SheetJson {
  return { ...sheet, pairs: sheet.pairs.map((pair) => (pair.player === player && pair.enemy === enemy ? change(pair) : pair)) };
}

// The trainer AI's odds for Mars: Purugly picks Body Slam 5/8, Fake Out 3/8 against Blaze; Bronzor always Confuse Rays
// it. Its script stumps the AI against Raichu, and Raichu's weather against Bronzor is not settled.

type AiChoice = Extract<AiOddsJson, { status: 'ok' }>['choices'][number];
type AiPair = Extract<SheetAi, { state: 'ready' }>['pairs'][number];
const picks = (...choices: AiChoice[]): AiOddsJson => ({ status: 'ok', choices });
const move = (label: string, probability: string): AiChoice => ({ label, kind: 'move', probability });
const sendIn = (label: string, probability: string): AiChoice => ({ label, kind: 'switch', probability });
const depends = (cases: { when: string; choices: AiChoice[] }[]): AiOddsJson => ({ status: 'depends', on: "Forretress's nature", cases });
const UNSETTLED: AiOddsJson = { status: 'unsupported', reason: 'The weather is not settled for this pair' };
const AI_NOTE = "AI odds: the trainer AI's odds in each situation shown, not a proof.";

const marsPairs: AiPair[] = [
  { player: 'party:1', enemy: 'enemy:0', next: picks(move('Body Slam', '5/8'), move('Fake Out', '3/8')), ifFaints: picks(sendIn('Bronzor', '1/1')) },
  { player: 'party:1', enemy: 'enemy:1', next: picks(move('Confuse Ray', '1/1')), ifFaints: picks(sendIn('Purugly', '1/1')) },
  { player: 'box:1:3', enemy: 'enemy:0', next: { status: 'unproven', code: 'UNKNOWN_OPCODE', reason: 'Unknown AI script opcode 0x5A' }, ifFaints: picks(sendIn('Bronzor', '1/1')) },
  { player: 'box:1:3', enemy: 'enemy:1', next: UNSETTLED, ifFaints: UNSETTLED },
];
const marsAi: SheetAi = { state: 'ready', pairs: marsPairs };
/** Mars's odds with Purugly's pair against Blaze changed by `over`. */
const marsWith = (over: Partial<AiPair>): SheetAi => ({ state: 'ready', pairs: marsPairs.map((pair, i) => (i === 0 ? { ...pair, ...over } : pair)) });

/** Replaces the clipboard; call it after `userEvent.setup()`, which puts its own stub in place. */
function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

const section = (name: RegExp) => screen.getByRole('region', { name });
function rowOf(container: HTMLElement, player: RegExp): HTMLElement {
  const row = within(container).getByRole('heading', { level: 4, name: player }).closest('li');
  if (row === null) throw new Error(`No pair for ${player}`);
  return row;
}
const pairRow = (enemy: string, player: string) => rowOf(section(new RegExp(enemy)), new RegExp(player));
const matchupBar = () => document.querySelector('.matchup-bar') as HTMLElement;
const headOf = (enemy: HTMLElement) => enemy.querySelector('.matchup-enemy-head') as HTMLElement;
const orderOf = (pair: HTMLElement) => pair.querySelector('.matchup-order') as HTMLElement;
/** An element's text with the damage ranges' joiners undone, as a reader sees it. */
const plain = (el: HTMLElement) => (el.textContent ?? '').replace(/⁠/g, '').replace(/ /g, ' ');
function moveCell(row: HTMLElement, name: string): HTMLElement {
  const cell = within(row).getByText(name).closest('li');
  if (cell === null) throw new Error(`No cell for ${name}`);
  return cell;
}
/** The accessible names of every button that reads "Copy set". */
const copySetNames = () => screen.getAllByRole('button').filter((b) => b.textContent === 'Copy set').map((b) => b.getAttribute('aria-label'));
const aiLines = (row: HTMLElement) => [...row.querySelectorAll('.sheet-ai-line')].map((line) => line.textContent);

/** What a move cell shows: text, title parts, its KO figure (null: none) and whether it reads as danger. */
interface CellSpec { has?: string[]; not?: string[]; title?: string[]; ko?: string | null; koTitle?: string; cls?: string[]; danger?: boolean }
function expectCell(cell: HTMLElement, { has = [], not = [], title = [], ko, koTitle, cls = [], danger }: CellSpec): void {
  for (const text of has) expect(plain(cell)).toContain(text);
  for (const text of not) expect(plain(cell)).not.toContain(text);
  for (const text of title) expect(cell.getAttribute('title')).toContain(text);
  const koEl = cell.querySelector('.tile-ko');
  if (ko === null) expect(koEl).toBeNull();
  else if (ko !== undefined) expect(koEl).toHaveTextContent(ko);
  if (koTitle !== undefined) expect(koEl).toHaveAttribute('title', koTitle);
  for (const name of cls) expect(cell).toHaveClass(name);
  if (danger !== undefined) for (const el of [cell, koEl]) if (el !== null) expect(el.classList.contains('is-danger')).toBe(danger);
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'execCommand');
});

describe('SheetView', () => {
  it('is cards, not a table: per trainer Pokémon a section, per pair who, Your moves, Their moves and Their reply', () => {
    render(<SheetView sheet={single} ai={marsAi} />);
    expect(screen.queryByRole('table')).toBeNull();
    const pair = pairRow('Purugly', 'Monferno');
    expect([...pair.children].slice(0, 4).map((el) => el.className.split(' ')[0])).toEqual(['matchup-who', 'matchup-side', 'matchup-side', 'matchup-reply']);
    expect([...pair.querySelectorAll('.matchup-label')].map((el) => el.textContent)).toEqual(['Your moves', 'Their moves', 'Their reply']);
    expect(within(matchupBar()).getByRole('tooltip', { hidden: true })).toHaveTextContent(AI_NOTE);
    expect(screen.getAllByText(/not a proof/)).toHaveLength(1);
    expect(within(pairRow('Bronzor', 'Raichu')).getByText('The weather is not settled for this pair')).toHaveClass('sheet-ai-muted');
  });

  it("the bar holds the field, the notes and the actions; the trainer's name and team strip are the fight page's", () => {
    const withNote = { ...single, notes: [...single.notes, 'Rain from the start: in the damage and Speeds'] };
    const { rerender } = render(<SheetView sheet={withNote} />);
    const bar = matchupBar();
    expect(within(bar).getByText('Rain all fight')).toBeInTheDocument();
    expect(bar).not.toHaveTextContent(/PERMANENT|Docs field note/);                    // the note only repeats the field
    expect(within(bar).getByRole('tooltip', { hidden: true })).toHaveTextContent('Rain from the start: in the damage and Speeds.');
    for (const name of ['Copy your team', "Copy trainer's team", 'About matchups']) expect(within(bar).getByRole('button', { name })).toBeInTheDocument();
    const link = within(bar).getByRole('link', { name: 'Open PKCalc' });
    expect(link).toHaveAttribute('href', 'https://pkcalc.anastarawneh.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Your team' })).toBeNull();
    expect(screen.queryByText(/Valley Windworks|Single battle/)).toBeNull();
    rerender(<SheetView sheet={{ ...withNote, trainer: { ...single.trainer, field: null } }} />);
    expect(matchupBar()).not.toHaveTextContent('Rain all fight');
  });

  it.each([
    ['each set', single, ['Purugly', 'Bronzor']],
    ['two of the same species by a numbered label', { ...single, enemies: [{ ...purugly, name: 'Koffing' }, { ...bronzor, name: 'Koffing' }] }, ['Koffing', 'Koffing 2']],
  ])('names every Copy set button for whose set it copies: %s', (_, sheet, [first, second]) => {
    render(<SheetView sheet={sheet} />);
    expect(copySetNames()).toEqual([first, second].flatMap((enemy) => [
      `Copy their ${enemy}`, `Copy your Blaze (Monferno) (against ${enemy})`, `Copy your Raichu (against ${enemy})`,
    ]));
  });

  it("each pair says the HP (when not full), status and held item its numbers use; a pair with no matchup says so", () => {
    const hurt: SheetMonJson = { ...monferno, hp: 5, status: 'burn' };
    const asleep: SheetMonJson = { ...raichu, status: 'sleep:2' };
    const { rerender } = render(<SheetView sheet={{ ...single, players: [hurt, asleep] }} />);
    const stateOf = (enemy: string, player: string) => pairRow(enemy, player).querySelector('.matchup-who .matchup-state')?.textContent;
    expect(stateOf('Purugly', 'Monferno')).toBe('HP 5/46 · Burned · Held item: Oran Berry');
    expect(stateOf('Bronzor', 'Monferno')).toBe('HP 5/46 · Burned · Held item: Oran Berry');
    expect(stateOf('Purugly', 'Raichu')).toBe('Asleep (2 turns)');
    rerender(<SheetView sheet={{ ...single, pairs: single.pairs.filter((pair) => pair.player !== 'party:1' || pair.enemy !== 'enemy:1') }} />);
    expect(stateOf('Purugly', 'Raichu')).toBeUndefined();
    expect(stateOf('Purugly', 'Monferno')).toBe('Held item: Oran Berry');
    const missing = pairRow('Bronzor', 'Monferno');
    expect(missing).toHaveTextContent('No matchup for this pair.');
    expect(missing.querySelector('.matchup-side')).toBeNull();
    expect(stateOf('Bronzor', 'Monferno')).toBe('Held item: Oran Berry');
    expect(pairRow('Purugly', 'Monferno')).not.toHaveTextContent('No matchup for this pair.');
  });

  it('a pair where a move of theirs can KO in one use is marked, in words as well as colour', () => {
    render(<SheetView sheet={single} />);
    expect(pairRow('Purugly', 'Raichu')).toHaveClass('is-danger');                       // Body Slam "OHKO 50%"
    expect(pairRow('Purugly', 'Raichu')).toHaveTextContent('Can KO you in one hit');
    expect(pairRow('Purugly', 'Monferno')).not.toHaveClass('is-danger');
    expect(pairRow('Purugly', 'Monferno')).not.toHaveTextContent('Can KO you in one hit');
  });

  it('a Pokémon over the level cap is marked beside its name, in every pair of its', () => {
    render(<SheetView sheet={single} levelCap={15} />);
    expect(screen.getAllByText('over the level cap (15)')).toHaveLength(4);
    expect(pairRow('Bronzor', 'Raichu')).toHaveTextContent('over the level cap (15)');
    render(<SheetView sheet={single} levelCap={16} />);
    expect(screen.getAllByText('over the level cap (15)')).toHaveLength(4);
  });

  it('shows the levels, both speeds, the turn order and the notes of each pair', () => {
    render(<SheetView sheet={single} />);
    expect(within(section(/Purugly/)).getByRole('heading', { level: 3 })).toHaveTextContent('Purugly Lv 17');
    expect(within(pairRow('Purugly', 'Monferno')).getByRole('heading', { level: 4 })).toHaveTextContent('Blaze (Monferno) Lv 16');
    const order = orderOf(pairRow('Purugly', 'Monferno'));
    expect(order).toHaveTextContent('Purugly moves first · Speed 48 vs 41');
    expect(order).not.toHaveTextContent('Field:');                // the bar's "Rain all fight"
    expect(within(order).getByTitle('Your Speed')).toHaveTextContent('41');
    expect(within(order).getByTitle("Purugly's Speed")).toHaveTextContent('48');
    expect(orderOf(pairRow('Purugly', 'Raichu'))).toHaveTextContent('Raichu moves first');
    expect(orderOf(pairRow('Bronzor', 'Monferno'))).toHaveTextContent('Speed tie');
    expect(orderOf(pairRow('Bronzor', 'Raichu'))).toHaveTextContent('Either may go first (see notes)');
    expect(pairRow('Bronzor', 'Raichu').querySelector('.matchup-notes')).toHaveTextContent('Quick Attack moves first');
    expect(pairRow('Purugly', 'Monferno').querySelector('.matchup-notes')).toBeNull();
  });

  it.each<[string, string, string, CellSpec]>([
    ['Purugly', 'Monferno', 'Mach Punch', {
      has: ['27–32 HP (45–53.3%)', '2HKO 41.41%'], not: ['to hit', 'inaccurate'],
      title: ['Mach Punch: Fighting, Physical', 'Crit 54–64 HP (90–106.6%)'],                // Purugly has 60 HP
    }],
    ['Purugly', 'Monferno', 'Flame Wheel', { ko: '4HKO 100%' }],
    ['Purugly', 'Monferno', 'Body Slam', { has: ['20–24 HP (43.4–52.1%)'], ko: '2HKO 20.31%', danger: false }],
    ['Purugly', 'Monferno', 'Taunt', { not: ['—', '%'], ko: null }],                         // a status move: its name alone
    ['Bronzor', 'Monferno', 'Flame Wheel', { ko: '2HKO 36.72%' }],
    ['Bronzor', 'Raichu', 'Extrasensory', {
      ko: '2HKO 60.94%', title: ['KO chance, no crits: OHKO 0%, 2HKO 60.94%, 3HKO 100%, 4HKO 100%', 'Damage 20–24 HP (45.4–54.5%)'],
    }],
    ['Purugly', 'Raichu', 'Thunder', { has: ['70% to hit', 'inaccurate'], ko: '3HKO 100%' }],
    ['Purugly', 'Raichu', 'Body Slam', { ko: 'OHKO 50%', danger: true, title: ['Crit 80–94 HP (181.8–213.6%)'] }],   // Raichu has 44 HP
    ['Purugly', 'Raichu', 'Fake Out', { has: ['18.1–22.7%'], ko: null }],                      // KOs in none of 1 to 4 hits
  ])('%s against %s: %s', (enemy, player, name, spec) => {
    render(<SheetView sheet={single} />);
    expectCell(moveCell(pairRow(enemy, player), name), spec);
  });

  it('a move is a plain tile in its list item, its flags in the extra row: unmodelled with its reason on hover', () => {
    render(<SheetView sheet={single} />);
    const machPunch = moveCell(pairRow('Purugly', 'Monferno'), 'Mach Punch');
    expect(machPunch.querySelector(':scope > .tile')).not.toBeNull();
    expect(machPunch.querySelector('button')).toBeNull();
    expect(machPunch.querySelector('.tile-extra')).toBeNull();
    const extra = moveCell(pairRow('Purugly', 'Monferno'), 'Fake Out').querySelector('.tile-extra') as HTMLElement;
    expect(within(extra).getByText('unmodelled')).toHaveAttribute('title', 'Flinches the target; works only on the first turn');
    expect(moveCell(pairRow('Purugly', 'Raichu'), 'Thunder').querySelector('.tile-extra')).toHaveTextContent('70% to hit');
  });

  it('shows the enemy item, ability and nature, and each dispute: "X or Y", one option alone, a long list as a count', () => {
    const { rerender } = render(<SheetView sheet={single} />);
    for (const text of ['Sitrus Berry', 'Thick Fat', 'Adamant']) expect(section(/Purugly/)).toHaveTextContent(text);
    expect(within(section(/Purugly/)).getByText('disputed: Adamant or Jolly').getAttribute('title')).toMatch(/nature/i);
    expect(within(section(/Bronzor/)).queryByText(/disputed/)).toBeNull();
    expect(section(/Bronzor/)).toHaveTextContent('No item');
    expect(section(/Bronzor/)).toHaveTextContent('Unknown (neutral)');
    const natures = Array.from({ length: 25 }, (_, i) => `N${i}`);
    rerender(<SheetView sheet={{
      ...single,
      enemies: [
        { ...purugly, disputed: [{ field: 'nature', options: ['Adamant'] }, { field: 'ability', options: ['Thick Fat', 'Own Tempo'] }] },
        { ...bronzor, disputed: [{ field: 'nature', options: natures }] },
      ],
    }} />);
    expect(within(section(/Purugly/)).getByText('disputed: Thick Fat or Own Tempo').getAttribute('title')).toMatch(/ability/);
    expect(within(section(/Purugly/)).getByText('disputed').getAttribute('title')).toMatch(/nature/);
    const long = within(section(/Bronzor/)).getByText('disputed: one of 25');
    expect(long.getAttribute('title')).toContain('N0, N1, N2');
    expect(long.getAttribute('title')).toContain('N24');
  });

  it("names a Pokémon by its species when its nickname is the game's default", () => {
    render(<SheetView sheet={{ ...single, players: [{ ...raichu, nickname: 'RAICHU' }, monferno] }} />);
    expect(within(section(/Purugly/)).queryByText(/RAICHU \(Raichu\)/)).toBeNull();
    expect(within(section(/Purugly/)).getByRole('heading', { level: 4, name: 'Raichu Lv 16' })).toBeInTheDocument();
  });

  it('with no players: no Copy your team, and each trainer Pokémon says to add one', () => {
    render(<SheetView sheet={{ ...single, players: [], pairs: [] }} />);
    expect(screen.getAllByText('Add a Pokémon to the team to see matchups.')).toHaveLength(2);
    expect(within(section(/Purugly/)).getByText('Add a Pokémon to the team to see matchups.')).toHaveClass('sheet-empty');
    expect(screen.queryByRole('button', { name: 'Copy your team' })).toBeNull();
    expect(within(matchupBar()).getByRole('button', { name: "Copy trainer's team" })).toBeInTheDocument();
    expect(document.querySelector('.matchup-pairs')).toBeNull();
  });

  it("says a double can't be built yet once, in the sheet's note, with no badge; a single says neither", () => {
    const { container, rerender } = render(<SheetView sheet={double} />);
    const said = screen.getByText(/can't be built yet/);
    expect(said).toHaveTextContent("Double battle: can't be built yet. Spread moves deal 3/4 damage here.");
    expect(said).toHaveClass('info-tip-text');
    expect(container.querySelector('.sheet-badge')).toBeNull();
    rerender(<SheetView sheet={single} />);
    expect(screen.queryByText(/can't be built yet/)).toBeNull();
  });

  it('notes every pair of an enemy shares are printed once, in its head; a note only one pair has stays in that pair', () => {
    const notes = (...extra: string[]) => (pair: SheetPairJson): SheetPairJson => ({ ...pair, notes: ['Drought sets sun', ...extra] });
    const sheet = withPair('box:1:3', 'enemy:0', notes('Speed boost first'), withPair('party:1', 'enemy:0', notes()));
    render(<SheetView sheet={sheet} />);
    expect(headOf(section(/Purugly/)).textContent).toContain(`${SHARED_PREFIX}Drought sets sun`);
    expect(screen.getAllByText(/Drought sets sun/)).toHaveLength(1);
    expect(headOf(section(/Purugly/))).not.toHaveTextContent('Speed boost first');
    expect(pairRow('Purugly', 'Monferno')).not.toHaveTextContent('Speed boost first');
    expect(pairRow('Purugly', 'Raichu')).toHaveTextContent('Speed boost first');
  });
});

describe('copying sets', () => {
  it.each([
    ['Copy their Purugly', () => headOf(section(/Purugly/)), purugly.showdown],
    ['Copy your Raichu (against Bronzor)', () => pairRow('Bronzor', 'Raichu'), raichu.showdown],
    ["Copy trainer's team", matchupBar, [purugly.showdown, bronzor.showdown].join('\n\n')],
  ])('%s copies its text and says "Copied" there alone', async (name, scope, text) => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    render(<SheetView sheet={single} />);
    await user.click(within(scope()).getByRole('button', { name }));
    expect(writeText).toHaveBeenCalledWith(text);
    expect(await within(scope()).findByText('Copied')).toBeInTheDocument();
    expect(screen.getAllByText('Copied')).toHaveLength(1);
  });

  it('two quick clicks on the two team buttons each show their own "Copied"', async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    render(<SheetView sheet={single} />);
    const trainers = within(matchupBar()).getByRole('button', { name: "Copy trainer's team" });
    const yours = within(matchupBar()).getByRole('button', { name: 'Copy your team' });
    await user.click(trainers);
    await user.click(yours);
    expect(writeText).toHaveBeenLastCalledWith([monferno.showdown, raichu.showdown].join('\n\n'));
    expect(await within(trainers.parentElement!).findByText('Copied')).toBeInTheDocument();
    expect(await within(yours.parentElement!).findByText('Copied')).toBeInTheDocument();
  });

  it('says "Copy failed" when the clipboard refuses and the fallback fails too', async () => {
    const user = userEvent.setup();
    stubClipboard(vi.fn().mockRejectedValue(new Error('Not allowed')));
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true });
    render(<SheetView sheet={single} />);
    await user.click(within(matchupBar()).getByRole('button', { name: 'Copy your team' }));
    expect(await within(matchupBar()).findByText('Copy failed')).toHaveClass('is-failed');
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('shows "Copied" for 2 s', async () => {
    vi.useFakeTimers();
    stubClipboard();
    render(<SheetView sheet={single} />);
    const head = headOf(section(/Purugly/));
    fireEvent.click(within(head).getByRole('button', { name: 'Copy their Purugly' }));
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    act(() => { vi.advanceTimersByTime(1999); });
    expect(within(head).getByText('Copied')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(within(head).queryByText('Copied')).toBeNull();
  });

  it('copyText writes through the clipboard API, else a hidden textarea and execCommand, else reports false', async () => {
    const writeText = stubClipboard();
    expect(await copyText('Purugly')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('Purugly');

    stubClipboard(vi.fn().mockRejectedValue(new Error('Not allowed')));
    let copied: string | undefined;
    const execCommand = vi.fn((command: string) => {
      copied = document.querySelector('textarea')?.value;
      return command === 'copy';
    });
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    expect(await copyText('Bronzor\nLevel: 16')).toBe(true);
    expect(copied).toBe('Bronzor\nLevel: 16');

    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true });
    expect(await copyText('Raichu')).toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });
});

describe("SheetView's odd figures and fields", () => {
  // Fixed damage as the calc has it: Seismic Toss deals Blaze's level, Endeavor 0 to a Blaze with no more HP than it.
  const fixed = (name: string, hp: number, defender: SheetMonJson) => attack(name, hp, hp, defender, { power: 1 }, { critRolls: Array<number>(16).fill(hp) });
  const counter = attack('Counter', 1, 1, monferno, { type: 'Fighting', power: 1, unmodelled: 'Returns double the physical damage taken' }, {
    bounded: false, koChance: null, koExact: null, desc: 'Purugly Counter vs. Monferno: ?',
  });
  // A landing OHKO move deals the defender's HP, so its percent is 100.
  const ohko = (name: string, hitChance: number, lands: boolean, defender: SheetMonJson) => {
    const hp = lands ? defender.stats.hp : 0;
    return attack(name, hp, hp, defender, { type: 'Ground', power: 1, hitChance, inaccurate: true }, { ohko: true });
  };
  const odd = withPair('box:1:3', 'enemy:0', (pair) => ({
    ...pair,
    playerMoves: [
      ohko('Horn Drill', 0.45, true, purugly),
      attack('Odd Hit', 9, 11, purugly, {}, { koChance: null, koExact: null }),
      attack('Tiny Hit', 9, 11, purugly, {}, { koChance: [], koExact: [1, 2, 3, 4].map((hits) => ({ hits, num: hits === 4 ? '1526' : '0', den: '100000000' })) }),
    ],
    enemyMoves: [ohko('Fissure', 0.45, true, raichu), ohko('Sheer Cold', 0.3, false, raichu)],
  }), withPair('party:1', 'enemy:0', (pair) => ({
    ...pair,
    playerMoves: [attack('Slash', 51, 60, purugly), fixed('Seismic Toss', 16, purugly), { ...counter, name: 'Bide' }],
    enemyMoves: [fixed('Endeavor', 0, monferno), counter],
  })));

  it.each<[string, string, CellSpec]>([
    ['Monferno', 'Slash', { ko: 'OHKO 6.25%', koTitle: '1/16' }],                         // only the top roll of 16 KOs
    ['Monferno', 'Seismic Toss', { title: ['Damage 16 HP (26.6%)\nCrit 16 HP (26.6%)'] }],
    ['Monferno', 'Counter', { has: ['?'], not: ['2.1%'], ko: 'KO ?', title: ['cannot bound'], cls: ['is-unknown', 'is-ko-unknown'], danger: false }],
    ['Monferno', 'Bide', { ko: 'KO ?', cls: ['is-ko-unknown'], danger: false }],
    ['Raichu', 'Fissure', { has: ['45% to hit'], ko: 'KO if it hits (45%)', danger: true }],
    ['Raichu', 'Horn Drill', { ko: 'KO if it hits (45%)', danger: false }],
    ['Raichu', 'Sheer Cold', { ko: null, danger: false, title: ['cannot land'] }],
    ['Raichu', 'Odd Hit', { has: ['15–18.3%'], ko: null }],
    ['Raichu', 'Tiny Hit', { ko: '4HKO <0.1%', koTitle: '1526/100000000' }],
  ])('%s against Purugly: %s', (player, name, spec) => {
    render(<SheetView sheet={odd} />);
    expectCell(moveCell(pairRow('Purugly', player), name), spec);
  });

  it('the damage text is one string that breaks only before "(", one figure for an equal range, "0 HP" and "?" bare', () => {
    const { container } = render(<SheetView sheet={odd} />);
    const damageOf = (player: string, name: string) => moveCell(pairRow('Purugly', player), name).querySelector('.tile-damage')?.textContent;
    expect(damageOf('Raichu', 'Odd Hit')).toBe('9–⁠11 HP (15–⁠18.3%)');
    expect(damageOf('Monferno', 'Seismic Toss')).toBe('16 HP (26.6%)');
    expect(damageOf('Monferno', 'Endeavor')).toBe('0 HP');
    expect(damageOf('Monferno', 'Counter')).toBe('?');
    expect(moveCell(pairRow('Purugly', 'Monferno'), 'Counter').getAttribute('title')).not.toMatch(/Rolls:/);
    const noEqualRange = /\b(\d+(\.\d+)?)–\1%/;
    expect(plain(container)).not.toMatch(noEqualRange);
    expect([...container.querySelectorAll('[title]')].map((e) => e.getAttribute('title')).join('\n')).not.toMatch(noEqualRange);
  });

  it('a pair shows its own field only when it is not the bar\'s and has something set', () => {
    for (const [field, said] of [['No weather, Trick Room', 'Field: No weather, Trick Room'], ['No weather', null]] as const) {
      const { unmount } = render(<SheetView sheet={withPair('party:1', 'enemy:1', (pair) => ({ ...pair, field }))} />);
      expect(pairRow('Purugly', 'Monferno')).not.toHaveTextContent('Field:');
      if (said === null) expect(pairRow('Bronzor', 'Monferno')).not.toHaveTextContent(/Field:|No weather/);
      else expect(pairRow('Bronzor', 'Monferno')).toHaveTextContent(said);
      unmount();
    }
  });

  it('notes a pair whose weather another Pokémon of the battle may have set', () => {
    render(<SheetView sheet={withPair('party:1', 'enemy:1', (pair) => ({ ...pair, weatherMayPersist: true }))} />);
    expect(pairRow('Bronzor', 'Monferno')).toHaveTextContent('Weather may persist');
    expect(pairRow('Purugly', 'Monferno')).not.toHaveTextContent('Weather may persist');
  });

  it('splitNotes shares a line every pair has (the may-persist one as a warning), never with a single pair', () => {
    const pairOf = (player: string, notes: string[], more: Partial<SheetPairJson> = {}): SheetPairJson => ({ ...single.pairs[0]!, player, notes, ...more });
    const first = pairOf('party:1', ['Drought sets sun']);
    const second = pairOf('box:1:3', ['Drought sets sun', 'Quick Attack moves first']);
    const both = splitNotes([first, second]);
    expect(both.shared).toEqual([{ text: 'Drought sets sun', warn: false }]);
    expect([both.own(first), both.own(second)]).toEqual([[], [{ text: 'Quick Attack moves first', warn: false }]]);
    const alone = splitNotes([first]);
    expect([alone.shared, alone.own(first)]).toEqual([[], [{ text: 'Drought sets sun', warn: false }]]);
    const persist = { weatherMayPersist: true };
    expect(splitNotes([pairOf('party:1', [], persist), pairOf('box:1:3', [], persist)]).shared).toEqual([{ text: MAY_PERSIST_NOTE, warn: true }]);
  });

  it('a pair whose weather is not settled says so, flags its moves and folds each case, closed, with its own order and cells', async () => {
    // Raichu against a Purugly whose disputed ability may be Drizzle: worked out with each, each cell the worse case.
    const thunderIn = (hitChance: number, min: number, max: number) => ({ ...thunder(min, max, purugly), hitChance, inaccurate: hitChance < 1 });
    const bodySlam = attack('Body Slam', 40, 47, raichu, { power: 85 });
    const unsettled = withPair('box:1:3', 'enemy:0', (pair) => ({
      ...pair, field: null, order: 'depends',
      notes: ["Purugly's ability is disputed: Thick Fat or Drizzle, which sets rain on entry"],
      playerMoves: [{ ...thunderIn(0.7, 23, 27), weatherDepends: true }],
      enemyMoves: [{ ...bodySlam, weatherDepends: true }],
      weatherCases: [
        { enemyAbility: 'Thick Fat', lastIn: null, when: 'Purugly has Thick Fat', field: 'No weather', order: 'player', playerSpeed: 50, enemySpeed: 48, playerMoves: [thunderIn(0.7, 23, 27)], enemyMoves: [bodySlam] },
        { enemyAbility: 'Drizzle', lastIn: null, when: 'Purugly has Drizzle', field: 'Rain', order: 'enemy', playerSpeed: 50, enemySpeed: 52, playerMoves: [thunderIn(1, 24, 29)], enemyMoves: [bodySlam] },
      ],
    }));
    const user = userEvent.setup();
    render(<SheetView sheet={unsettled} />);
    const row = pairRow('Purugly', 'Raichu');
    expect(orderOf(row)).toHaveTextContent('Weather not settled');
    expect(within(orderOf(row)).getByTitle('Your lowest Speed and its highest over the weather cases')).toHaveTextContent('50 vs 48');
    const [yours, theirs] = [...row.querySelectorAll<HTMLElement>('.matchup-side')];
    expect(within(moveCell(yours!, 'Thunder')).getByText('depends on weather')).toHaveClass('sheet-flag');
    expect(moveCell(theirs!, 'Body Slam').querySelector('.tile-extra')).toHaveTextContent('depends on weather');
    expect(within(moveCell(pairRow('Purugly', 'Monferno'), 'Body Slam')).queryByText('depends on weather')).toBeNull();

    const cases = row.querySelector('.matchup-cases') as HTMLElement;
    expect(cases).toHaveTextContent('Weather cases for Raichu against Purugly');
    expect(pairRow('Purugly', 'Monferno').querySelector('.matchup-cases')).toBeNull();
    const folds = [...cases.querySelectorAll('details')];
    expect(section(/Purugly/).querySelectorAll('details')).toHaveLength(folds.length);
    expect(folds.map((fold) => fold.querySelector('summary')?.textContent)).toEqual(['If Purugly has Thick Fat · No weather', 'If Purugly has Drizzle · Rain']);
    expect(folds.filter((fold) => fold.hasAttribute('open'))).toHaveLength(0);
    await user.click(folds[1]!.querySelector('summary')!);
    expect(folds[1]).toHaveAttribute('open');
    const [dry, rain] = [folds[0]!, folds[1]!];
    expect(dry).toHaveTextContent('Raichu moves first');
    expect(dry).toHaveTextContent('50 vs 48');
    expect(moveCell(dry, 'Thunder')).toHaveTextContent('70% to hit');
    expect(rain).toHaveTextContent('Purugly moves first');
    expect(rain).toHaveTextContent('52 vs 50');
    expect(rain).toHaveTextContent('Drizzle');
    expect([...rain.querySelectorAll('.sheet-case-label')].map((label) => label.textContent)).toEqual(['Your moves', 'Their moves']);
    expectCell(moveCell(rain, 'Thunder'), { has: ['40–48.3%'], not: ['to hit', 'depends on weather'] });
    expectCell(moveCell(rain, 'Body Slam'), { ko: 'OHKO 50%', danger: true });
  });
});

describe("SheetView with the trainer AI's odds", () => {
  it.each<[string, SheetAi, [string, string], string[], (string | null)[]?]>([
    ['a pick of two and a certain send-in, each fraction only in its title', marsAi, ['Purugly', 'Monferno'],
      ['AI picks: Body Slam 62.5% · Fake Out 37.5%', 'If it faints: sends in Bronzor (certain)'], ['5/8', '3/8', null]],
    ['a certain pick', marsAi, ['Bronzor', 'Monferno'], ['AI picks: Confuse Ray (certain)', 'If it faints: sends in Purugly (certain)']],
    ['an AI error reads unproven, never a guess', marsAi, ['Purugly', 'Raichu'],
      ['AI: unproven (Unknown AI script opcode 0x5A)', 'If it faints: sends in Bronzor (certain)']],
    ['a pair the odds do not cover gives the reason once', marsAi, ['Bronzor', 'Raichu'], ['The weather is not settled for this pair']],
    ['each possible switch-in with its odds', marsWith({ ifFaints: picks(sendIn('Bronzor', '2/3'), sendIn('Zubat', '1/3')) }), ['Purugly', 'Monferno'],
      ['AI picks: Body Slam 62.5% · Fake Out 37.5%', 'If it faints: sends in Bronzor 66.67% · Zubat 33.33%']],
    ['a long denominator', marsWith({ next: picks(move('Body Slam', '87381/131072'), move('Fake Out', '43691/131072')) }), ['Purugly', 'Monferno'],
      ['AI picks: Body Slam 66.67% · Fake Out 33.33%', 'If it faints: sends in Bronzor (certain)'], ['87381/131072', '43691/131072', null]],
    ['a tiny share', marsWith({ next: picks(move('Body Slam', '1023/1024'), move('Fake Out', '1/1024')) }), ['Purugly', 'Monferno'],
      ['AI picks: Body Slam 99.9% · Fake Out 0.09766%', 'If it faints: sends in Bronzor (certain)'], ['1023/1024', '1/1024', null]],
    ['nothing left to send in', marsWith({ next: picks(move('Body Slam', '1/1')), ifFaints: { status: 'none', reason: 'Nothing left to send in' } }),
      ['Purugly', 'Monferno'], ['AI picks: Body Slam (certain)', 'If it faints: nothing left to send in']],
    ['a malformed probability', marsWith({ next: picks(move('Body Slam', 'oops'), move('Fake Out', '3/8')) }), ['Purugly', 'Monferno'],
      ['AI: unproven (unreadable odds)', 'If it faints: sends in Bronzor (certain)']],
    ['a disputed value that decides the pick', marsWith({
      next: depends([{ when: 'Hardy', choices: [move('Earthquake', '1/1')] }, { when: 'Sassy', choices: [move('Gyro Ball', '3/4'), move('Earthquake', '1/4')] }]),
    }), ['Purugly', 'Monferno'], [
      "AI depends on Forretress's nature:", 'if Hardy: Earthquake (certain)', 'if Sassy: Gyro Ball 75% · Earthquake 25%', 'If it faints: sends in Bronzor (certain)',
    ], [null, '3/4', '1/4', null]],
    ['a disputed value that decides the send-in', marsWith({
      ifFaints: depends([{ when: 'Hardy or Bold', choices: [sendIn('Bronzor', '1/1')] }, { when: 'Sassy', choices: [sendIn('Bronzor', '2/3'), sendIn('Zubat', '1/3')] }]),
    }), ['Purugly', 'Monferno'], [
      'AI picks: Body Slam 62.5% · Fake Out 37.5%', "If it faints, depends on Forretress's nature:", 'if Hardy or Bold: sends in Bronzor (certain)', 'if Sassy: sends in Bronzor 66.67% · Zubat 33.33%',
    ]],
    ['a disputed case whose odds do not read', marsWith({
      next: depends([{ when: 'Hardy', choices: [move('Earthquake', '1/1')] }, { when: 'Sassy', choices: [move('Gyro Ball', 'oops')] }]),
      ifFaints: depends([{ when: 'Hardy', choices: [sendIn('Bronzor', '0/0')] }]),
    }), ['Purugly', 'Monferno'], ['AI: unproven (unreadable odds)', 'If it faints: AI: unproven (unreadable odds)']],
    ['a pair the answer leaves out', { state: 'ready', pairs: marsPairs.filter((_, i) => i !== 1) }, ['Bronzor', 'Monferno'], ['AI: no answer for this pair']],
  ])('%s', (_, ai, [enemy, player], lines, titles) => {
    render(<SheetView sheet={single} ai={ai} />);
    const row = pairRow(enemy, player);
    expect(aiLines(row)).toEqual(lines);
    expect(row.querySelectorAll('.ai-fraction')).toHaveLength(0);
    if (titles !== undefined) expect([...row.querySelectorAll('.ai-choice')].map((choice) => choice.getAttribute('title'))).toEqual(titles);
  });

  const doubleAi: SheetAi = {
    state: 'ready',
    pairs: double.pairs.map(({ player, enemy }) => {
      const unsupported: AiOddsJson = { status: 'unsupported', reason: 'The AI odds are for single battles only' };
      return { player, enemy, next: unsupported, ifFaints: unsupported };
    }),
  };
  it.each<[string, ComponentProps<typeof SheetView>, string | null]>([
    ['without the AI', { sheet: single }, null],
    ['after a failed request, said once at the top', { sheet: single, ai: { state: 'failed', error: 'Cannot reach the planner server' } }, 'The AI odds did not load: Cannot reach the planner server'],
    ['for a double, said once at the top', { sheet: double, ai: doubleAi }, 'AI odds: single battles only'],
  ])('%s, no pair has a reply part', (_, props, said) => {
    render(<SheetView {...props} />);
    expect(pairRow('Purugly', 'Monferno')).toHaveClass('no-reply');
    expect(document.querySelector('.matchup-reply')).toBeNull();
    expect(screen.queryByText('Their reply')).toBeNull();
    expect(screen.queryByText(/not a proof|Working out the AI|The AI odds are for single battles only/)).toBeNull();
    if (said !== null) expect(screen.getByText(said)).toBeInTheDocument();
  });

  it('while the AI is worked out, pairs without odds say so, one live region beside the note says it, and empties once in', () => {
    const { rerender } = render(<SheetView sheet={single} ai={{ state: 'pending', pairs: marsPairs.slice(0, 1) }} />);
    expect(aiLines(pairRow('Purugly', 'Monferno'))[0]).toBe('AI picks: Body Slam 62.5% · Fake Out 37.5%');
    for (const [enemy, player] of [['Purugly', 'Raichu'], ['Bronzor', 'Monferno'], ['Bronzor', 'Raichu']]) {
      expect(pairRow(enemy!, player!)).toHaveTextContent('Working out the AI…');
    }
    const lines = document.querySelectorAll('.matchup-reply .sheet-ai-pending');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line.closest('[role="status"], [aria-live]')).toBeNull();
    const status = () => matchupBar().querySelector('.sheet-ai-status');
    expect(status()).toHaveAttribute('role', 'status');
    expect(status()).toHaveTextContent('Working out the AI…');
    expect(screen.getAllByRole('status').filter((region) => region.textContent?.includes('Working out the AI…'))).toHaveLength(1);
    expect(screen.getByText(AI_NOTE)).toBeInTheDocument();
    rerender(<SheetView sheet={single} ai={marsAi} />);
    expect(status()).toHaveAttribute('role', 'status');
    expect(status()?.textContent).toBe('');
  });
});
