// The logic the plan screen's step panels need that has no React: exact odds in BigInt, and their reply's table rows.
//
// Their reply's table rows are worked out here (`replyRows`): a row for each move of theirs and each
// other action of the AI's, likeliest first, with a tone (danger, warn, zero) and the KO words as "Can KO you…" (none for
// a move his held Focus Sash at full HP survives: such a row is warn when the move has a one-hit figure, as the Sash leaves
// him at 1 HP). `likeliestMove` is the move the AI is likeliest to use; `barWidth` and `hpBarText` are display helpers.
//
// Odds are exact: every sum, product and comparison is BigInt over the server's num/den strings, never a Number.

import type { AiOddsLevel, LineAiOddsJson, LineEndHpJson, LineMoveDamageJson, LineNodeJson, LineRationalJson } from '../../src/server/apiTypes';
import { koText } from './line';

// ---- Exact odds ---------------------------------------------------------------------------------------------------

function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** `num/den` in lowest terms; zero is 0/1. */
function reduced(num: bigint, den: bigint): LineRationalJson {
  if (num === 0n) return { num: '0', den: '1' };
  const g = gcd(num, den);
  return { num: String(num / g), den: String(den / g) };
}

const big = (r: LineRationalJson): [bigint, bigint] => [BigInt(r.num), BigInt(r.den)];

/** The exact sum, reduced; 0/1 for none. */
export function sumOdds(parts: readonly LineRationalJson[]): LineRationalJson {
  let [num, den] = [0n, 1n];
  for (const part of parts) {
    const [n, d] = big(part);
    [num, den] = [num * d + n * den, den * d];
    const g = gcd(num, den);
    if (g > 1n) [num, den] = [num / g, den / g];
  }
  return reduced(num, den);
}

/** The exact product, reduced. */
export function timesOdds(a: LineRationalJson, b: LineRationalJson): LineRationalJson {
  const [an, ad] = big(a);
  const [bn, bd] = big(b);
  return reduced(an * bn, ad * bd);
}

/** Negative when `a` is the smaller, by cross-multiplying. */
function compareOdds(a: LineRationalJson, b: LineRationalJson): number {
  const [an, ad] = big(a);
  const [bn, bd] = big(b);
  const diff = an * bd - bn * ad;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A number to one decimal without a trailing .0. */
const one = (x: number) => String(Math.round(x * 10) / 10);

/**
 * The trainer's HP as the game shows it, then the HP the damage is worked out from: "HP bar 54.2% (28/50)". `percent` is the
 * server's, the 48-pixel bar's (lineView.ts, lineSummary.ts: floor(HP × 48 / max HP) pixels, at least 1 with HP left).
 */
export const hpBarText = (hp: Pick<LineEndHpJson, 'hp' | 'maxHp' | 'percent'>): string => `HP bar ${one(hp.percent)}% (${hp.hp}/${hp.maxHp})`;

/** The pieces of a step the panels read, the same in a line node and a plan step. */
export type StepPanel = Pick<LineNodeJson, 'phase' | 'view' | 'choices' | 'damage' | 'aiOdds' | 'aiError'>;

/** How the AI chooses is not modelled: said plainly where its odds would be (and with the AI's own words under it). */
export const AI_NOT_MODELLED = 'How the trainer chooses here is not modelled.';

// ---- Their reply --------------------------------------------------------------------------------

/** One row of their reply: a move of theirs, or another action of the AI's ("Switch to Onix", "Full Restore"). */
export interface ReplyRow {
  name: string;
  /** The AI's odds of this action; null: the cell is empty (the odds do not say, and do not account for the rest). */
  ai: LineRationalJson | null;
  /** Null for a switch or an item: no damage, no KO. */
  move: LineMoveDamageJson | null;
  /** `zero`: exactly 0% AI, muted whatever the move could do. */
  tone: 'danger' | 'warn' | 'zero' | null;
  /** The KO cell's words, with their "Can KO you…" prefix for a danger or warn row (none for a Sash's warn row). */
  ko: string;
  /** The `ranked` level only (`levelRows`): its place in the AI's order, null for a move the AI does not rank. */
  rank?: number | null;
  /** The `ranked` level only: another action shares its place. */
  tied?: boolean;
}

/** Under the heading of a step at a turn choice: what makes the table the same whichever choice the player picks. */
export const REPLY_BLIND = 'The trainer picks without seeing your choice. If you switch, the Pokémon coming in takes it.';

/** Whether the AI's odds that name one of `moves`, and its switches ("Switch to Mouse"), sum to exactly 1. */
function accountsForAll(aiOdds: LineAiOddsJson, moves: readonly LineMoveDamageJson[]): boolean {
  const names = new Set(moves.map((m) => m.name));
  const sum = sumOdds(aiOdds.choices.filter((c) => names.has(c.label) || c.label.startsWith('Switch to ')).map((c) => c.probability ?? ZERO));
  return sum.num === '1' && sum.den === '1';
}

const ZERO: LineRationalJson = { num: '0', den: '1' };

const NO_OHKO = 'No OHKO without a crit · ';

/**
 * A move's row: its tone and KO words ("Can KO you on a crit: " takes the place of "No OHKO without a crit · "). The
 * tone goes zero (an exact 0% from the AI), then Sash, then danger, then warn. A move with `survives` (a Focus Sash at full
 * HP) cannot KO him in one hit, so it gets no danger tone and no "Can KO you": its KO words stay as `koText` gives them. It
 * is a warn row when its one-hit figure is above 0 (the Sash leaves him at 1 HP, which weather or poison can finish), and
 * has no tone without one.
 */
function moveKo(m: LineMoveDamageJson, ai: LineRationalJson | null): Pick<ReplyRow, 'tone' | 'ko'> {
  const words = koText(m);
  const zero = ai !== null && ai.num === '0';
  const k1 = (m.note !== null && m.percent === null) || m.status ? undefined : m.koExact?.[0];
  const sash = m.survives ?? null;                                                  // absent reads as null
  if (zero || k1 === undefined) return { tone: zero ? 'zero' : null, ko: words };
  if (sash !== null) return { tone: k1.num !== '0' ? 'warn' : null, ko: words };
  if (k1.num !== '0') return { tone: 'danger', ko: `Can KO you: ${words}` };
  if (m.koCritExact !== null && m.koCritExact.num !== '0') return { tone: 'warn', ko: `Can KO you on a crit: ${words.replace(NO_OHKO, '')}` };
  return { tone: null, ko: words };
}

/**
 * Every action the AI may take as a row: one per move of theirs (`damage.theirs`, status moves too), then one per AI
 * action that is not one of those ("Switch to Onix", "Full Restore", a replacement's Pokémon). Likeliest first, an empty
 * cell as 0, then by name. A move the odds do not name is `0/1` when the named moves and switches make up all of them
 * (`accountsForAll`), else empty.
 */
export function replyRows(node: StepPanel): ReplyRow[] {
  const { aiOdds, damage } = node;
  const theirs = damage?.theirs ?? [];
  const zeroIsSure = aiOdds !== undefined && accountsForAll(aiOdds, theirs);
  const names = new Set(theirs.map((m) => m.name));
  const rows: ReplyRow[] = theirs.map((move) => {
    const named = aiOdds?.choices.find((c) => c.label === move.name);
    const ai = named?.probability !== undefined ? named.probability : zeroIsSure ? { num: '0', den: '1' } : null;
    return { name: move.name, ai, move, ...moveKo(move, ai) };
  });
  for (const c of aiOdds?.choices ?? []) {
    if (!names.has(c.label)) rows.push({ name: c.label, ai: c.probability ?? null, move: null, tone: c.probability?.num === '0' ? 'zero' : null, ko: '' });
  }
  const share = (row: ReplyRow): LineRationalJson => row.ai ?? { num: '0', den: '1' };
  return rows.sort((a, b) => compareOdds(share(b), share(a)) || byText(a.name, b.name));
}

/** The move the AI is likeliest to use: the first row with a move and a non-zero chance; null without one (no odds, or none above 0). */
export function likeliestMove(node: StepPanel): string | null {
  const row = replyRows(node).find((r) => r.move !== null && r.ai !== null && r.ai.num !== '0');
  return row === undefined ? null : row.name;
}

// ---- Below the full AI odds (aiOdds.ts) -----------------------------------------------------------------------------

/**
 * Their reply's rows when the server sends no odds (`PKP_AI_ODDS` below full), none of them with a share (`ai` null) and
 * none muted as a 0%: the tone and KO words are the damage's alone. `likeliest` and `off`: one row per move of theirs, in
 * their own order, so the order says nothing of the AI. `ranked`: the AI's actions in its order, each with its place
 * (`rank`; `tied` when another shares it), then the moves it does not rank, in their own order, with no place.
 */
export function levelRows(node: StepPanel, level: 'likeliest' | 'ranked' | 'off'): ReplyRow[] {
  const theirs = node.damage?.theirs ?? [];
  const moveRow = (move: LineMoveDamageJson): ReplyRow => ({ name: move.name, ai: null, move, ...moveKo(move, null) });
  if (level !== 'ranked') return theirs.map(moveRow);
  const choices = [...(node.aiOdds?.choices ?? [])].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  const named = new Set(choices.map((c) => c.label));
  const ranked = choices.map((c): ReplyRow => {
    const move = theirs.find((m) => m.name === c.label);
    const place = { rank: c.rank ?? null, tied: c.rank !== undefined && choices.filter((d) => d.rank === c.rank).length > 1 };
    return move === undefined ? { name: c.label, ai: null, move: null, tone: null, ko: '', ...place } : { ...moveRow(move), ...place };
  });
  return [...ranked, ...theirs.filter((m) => !named.has(m.name)).map(moveRow)];
}

/** The AI's actions ranked first (the `likeliest` and `ranked` levels): every one tied for the top, in the server's order. */
export const topLabels = (node: StepPanel): string[] => (node.aiOdds?.choices ?? []).filter((c) => c.rank === 1).map((c) => c.label);

/**
 * Their likeliest move at `level`: `likeliestMove` at full; below it, the first action the AI ranks that is a move of
 * theirs (at `likeliest` only those tied for the top come, so none when the top is a switch or an item); none at `off`.
 */
export function likeliestMoveAt(node: StepPanel, level: AiOddsLevel): string | null {
  if (level === 'full') return likeliestMove(node);
  if (level === 'off') return null;
  const names = new Set((node.damage?.theirs ?? []).map((m) => m.name));
  return (node.aiOdds?.choices ?? []).find((c) => names.has(c.label))?.label ?? null;
}

/** A chance as a bar's width in percent, from the exact fraction (integer maths, four decimals): display only, never printed. */
export function barWidth(r: LineRationalJson): number {
  const [n, d] = big(r);
  return d === 0n ? 0 : Number((n * 1000000n) / d) / 10000;
}
