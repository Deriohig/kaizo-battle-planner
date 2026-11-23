// The AI odds level (`PKP_AI_ODDS`, `AiOddsLevel` in src/contracts/api.ts): how much of the
// trainer AI's odds the server sends. The Hall of Fame moderators worry that exact odds do too much for a player, so a
// site can send less, and it never sends what its level hides: anyone reading the page's requests learns no more than the
// page shows. Each cut is made on the answer as the full level builds it, at the routes' edge (plan.ts for the plan step,
// fight.ts `streamOdds` for the sheet's stream), so the AI, its batches and the answer caches are the same at every level.
// - `full`: the answer itself, the very object.
// - `likeliest`: the actions tied for the top, each with `rank: 1`, and no probability. A plan step's send-out: every
//   Pokémon of theirs still standing, in party order, those tied for the top marked `likeliest: true`, with no rank. A
//   sheet pair's send-in (`ifFaints`) is cut as its next move is: the likeliest alone, as Matchups shows it.
// - `ranked`: every action in its own order (the likeliest first, then by label) with its rank: 1 plus the number of
//   actions strictly likelier, so ties share a rank and the next counts them (1, 2, 2, 4). No probability.
// - `off`: nothing of the AI's answer: the plan step leaves out its odds, its send-out and both AI errors, and the sheet's
//   stream route answers 501 (`AI_ODDS_OFF`) before any work.
// A sheet pair's `depends` is cut case by case, and cases that come out the same at the level are merged, their values
// listed together; one case left is plain `ok`, so the answer does not say the odds differ where the level shows nothing
// that does. Ties are exact: probabilities compared as fractions, by cross-multiplying.

import type {
  AiChoiceJson, AiOddsJson, AiOddsLevel, LineAiOddsJson, LineRationalJson, PlanSendOutChoiceJson, PlanStepJson, SheetAiPairJson,
} from '../contracts/api.js';

/** The sheet AI stream's answer at the `off` level (501). */
export const AI_ODDS_OFF = 'The AI odds are off on this server';

/** What a level below full but above off keeps. */
type Cut = 'likeliest' | 'ranked';

interface Fraction { num: bigint; den: bigint }

/** A probability as the plan step (`{ num, den }`) or the sheet ("num/den") sends it at the full level. */
function fractionOf(probability: LineRationalJson | string | undefined): Fraction {
  if (probability === undefined) throw new Error('aiOdds: a choice without its probability is not a full answer');
  if (typeof probability !== 'string') return { num: BigInt(probability.num), den: BigInt(probability.den) };
  const [num, den] = probability.split('/');
  return { num: BigInt(num!), den: BigInt(den!) };
}

const likelier = (a: Fraction, b: Fraction): boolean => a.num * b.den > b.num * a.den;

/** Each probability's rank: 1 plus how many are strictly likelier, so ties share a rank and the next counts them. */
export function ranksOf(probabilities: readonly Fraction[]): number[] {
  return probabilities.map((p) => 1 + probabilities.filter((q) => likelier(q, p)).length);
}

/** "A", "A or B", "A, B or C" (sheetAi.ts's own list). */
const orList = (items: readonly string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)!}`);

// ---- The plan step ---------------------------------------------------------------------------------------------------

/** Their turn odds at `cut`: each action's label and rank, every one at `ranked`, those ranked 1 at `likeliest`. */
function planOddsAt(cut: Cut, odds: LineAiOddsJson): LineAiOddsJson {
  const ranks = ranksOf(odds.choices.map((c) => fractionOf(c.probability)));
  const choices = odds.choices.map((c, i) => ({ label: c.label, rank: ranks[i]! })).filter((c) => cut === 'ranked' || c.rank === 1);
  return { kind: odds.kind, choices };
}

/**
 * Their send-out at `cut`. `ranked`: the send-out's own choices in their order, each with its rank. `likeliest`: every one
 * of `standing` (their Pokémon still standing but the active, in party order), named as the send-out names it when it
 * does, those tied for the top marked.
 */
function planSendOutAt(cut: Cut, choices: readonly PlanSendOutChoiceJson[], standing: readonly { index: number; label: string }[]): PlanSendOutChoiceJson[] {
  const ranks = ranksOf(choices.map((c) => fractionOf(c.probability)));
  if (cut === 'ranked') return choices.map((c, i) => ({ label: c.label, index: c.index, rank: ranks[i]! }));
  const top = new Set(choices.filter((_, i) => ranks[i] === 1).map((c) => c.index));
  return standing.map(({ index, label }) => ({
    label: choices.find((c) => c.index === index)?.label ?? label, index, ...(top.has(index) ? { likeliest: true as const } : {}),
  }));
}

/**
 * A plan step's answer at `level`, cut from the full one: `full` gives `answer` itself; `off` leaves out `aiOdds`,
 * `aiError`, `sendOut` and `sendOutError`; `likeliest` and `ranked` cut `aiOdds` and `sendOut` and keep the AI errors.
 * `standing` is their Pokémon a `likeliest` send-out lists (see `planSendOutAt`). Nothing else of the answer changes.
 */
export function planStepAt(level: AiOddsLevel, answer: PlanStepJson, standing: readonly { index: number; label: string }[]): PlanStepJson {
  if (level === 'full') return answer;
  const out: PlanStepJson = { ...answer };
  if (level === 'off') {
    delete out.aiOdds;
    delete out.aiError;
    delete out.sendOut;
    delete out.sendOutError;
    return out;
  }
  if (answer.aiOdds !== undefined) out.aiOdds = planOddsAt(level, answer.aiOdds);
  if (answer.sendOut !== undefined) out.sendOut = { kind: answer.sendOut.kind, choices: planSendOutAt(level, answer.sendOut.choices, standing) };
  return out;
}

// ---- The sheet's AI stream -------------------------------------------------------------------------------------------

/** An `ok` list at `cut`: each choice's label, kind and rank, every one at `ranked`, those ranked 1 at `likeliest`. */
function choicesAt(cut: Cut, choices: readonly AiChoiceJson[]): AiChoiceJson[] {
  const ranks = ranksOf(choices.map((c) => fractionOf(c.probability)));
  return choices.map((c, i) => ({ label: c.label, kind: c.kind, rank: ranks[i]! })).filter((c) => cut === 'ranked' || c.rank === 1);
}

/**
 * One of a sheet pair's answers at `level` (see the top of the file). `none`, `unsupported` and `unproven` pass through,
 * but an unproven sum of odds (`BAD_SUPPORT`) loses its figures. At `off`, which no route streams, nothing of the AI's.
 */
export function sheetOddsAt(level: AiOddsLevel, odds: AiOddsJson): AiOddsJson {
  if (level === 'full') return odds;
  if (level === 'off') return { status: 'unsupported', reason: AI_ODDS_OFF };
  switch (odds.status) {
    case 'ok':
      return { status: 'ok', choices: choicesAt(level, odds.choices) };
    case 'depends': {
      const cases: { when: string[]; choices: AiChoiceJson[]; key: string }[] = [];
      for (const { when, choices } of odds.cases) {
        const cut = choicesAt(level, choices);
        const key = JSON.stringify(cut);
        // A case's values are an `orList` of natures or abilities, none of whose names holds ", " or " or ".
        const values = when.split(/, | or /);
        const same = cases.find((c) => c.key === key);
        if (same === undefined) cases.push({ when: values, choices: cut, key });
        else same.when.push(...values);
      }
      if (cases.length === 1) return { status: 'ok', choices: cases[0]!.choices };
      return { status: 'depends', on: odds.on, cases: cases.map(({ when, choices }) => ({ when: orList(when), choices })) };
    }
    case 'unproven':
      return odds.code === 'BAD_SUPPORT' ? { ...odds, reason: "The AI's odds do not add up" } : odds;
    default:
      return odds;
  }
}

/** A sheet pair at `level`: both of its answers cut (`sheetOddsAt`); `full` gives `pair` itself. */
export function sheetPairAt(level: AiOddsLevel, pair: SheetAiPairJson): SheetAiPairJson {
  if (level === 'full') return pair;
  return { ...pair, next: sheetOddsAt(level, pair.next), ifFaints: sheetOddsAt(level, pair.ifFaints) };
}
