// Known-answer toy fights and table games under the toy rules (engine.ts) and AI (ai.ts); referee.test.ts confirms
// every value the naive referee can see. Moves default to accuracy 1, crit 0, priority 0 and 10 PP.
// ScenarioExpect, at level 1 (the AI's support):
//   tier1      display mode (observeAll = full information) proves a zero-death line within `horizon`
//   tier1Ram   the same in RAM mode, each world on its own
//   failure    least P(death ∪ cut-off ∪ unlabelled outcome) over the player's strategies (the worse world); ZERO at tier 1
//   critBudget null at tier 1; −1 when not even G_0 (enemy crits removed) is safe; else the largest j with a G_j-safe line
//   turns      the fewest turns a tier-1 proof needs (proven at `turns`, not at `turns − 1`)
// These are the game's values; whether a verdict may claim them (e.g. `mystery`, unmodelled) is the solver's business.
// A gauntlet lists its trainers in `fights` (trainerId = fights[0]): `horizon` and `turns` are per fight, `failure` and
// `critBudget` span the gauntlet. `preStatusCandidates` and `benchMonotone` (default true) are copied into MonInfo and
// FightInfo by fixtures.ts; the values are still those of the plain game with the whole p1 list.

import type { Rational, WorldAssignment } from '../../../../src/contracts/engine.js';
import type { StartStatus } from '../../../../src/save/status.js';
import { ONE, rat, ZERO } from '../../../../src/solver/rational.js';
import type { ToyMon, ToyRegistry, ToyTrainer } from './game.js';
import { mon, mv } from './helpers.js';
import type { TableSpec } from './table.js';

export interface ScenarioExpect { tier1?: boolean; tier1Ram?: boolean; failure?: Rational; critBudget?: number | null; turns?: number }
export interface Scenario {
  name: string; registry: ToyRegistry; p1: string[]; trainerId: string; horizon: number;
  worlds?: WorldAssignment[];   // the worlds of `trainerId`'s fight; default [{ enemy: [] }] (other trainers always have one world)
  fights?: string[];            // a gauntlet: the trainer ids in fight order (fights[0] === trainerId); absent = one fight
  preStatusCandidates?: Record<string, StartStatus[]>;   // per p1 mon name: its MonInfo.preStatusCandidates (default [])
  benchMonotone?: boolean;      // every fight's FightInfo.benchMonotone (default true)
  expect: ScenarioExpect;
}

/** p1's mons keyed by name, lead first; one trainer whose id is the scenario name; observeAll unless `hidden`. */
function scenario(name: string, p1: ToyMon[], party: ToyMon[], opts: {
  horizon: number; expect: ScenarioExpect; hidden?: boolean; trainer?: Partial<ToyTrainer>; registry?: Partial<ToyRegistry>; worlds?: WorldAssignment[];
  preStatusCandidates?: Record<string, StartStatus[]>; benchMonotone?: boolean;
}): Scenario {
  const registry: ToyRegistry = {
    mons: Object.fromEntries(p1.map((m) => [m.name, m])),
    trainers: { [name]: { id: name, party, ...opts.trainer } },
    ...(opts.hidden ? {} : { observeAll: true }),
    ...opts.registry,
  };
  return {
    name, registry, p1: p1.map((m) => m.name), trainerId: name, horizon: opts.horizon, ...(opts.worlds ? { worlds: opts.worlds } : {}),
    ...(opts.preStatusCandidates ? { preStatusCandidates: opts.preStatusCandidates } : {}),
    ...(opts.benchMonotone === undefined ? {} : { benchMonotone: opts.benchMonotone }), expect: opts.expect,
  };
}

const TIER1 = { tier1: true, tier1Ram: true, failure: ZERO, critBudget: null } as const;

// Hero is faster and Strike 5 KOs Imp before Scratch: one outcome, Hero ends at 10.
export const safe1v1 = scenario('safe1v1',
  [mon('Hero', 10, 10, [mv('Strike', [5])])],
  [mon('Imp', 5, 5, [mv('Scratch', [3])])],
  { horizon: 3, expect: { ...TIER1, turns: 1 } });

// Brute (faster) Bashes 3, or 6 on a crit (1/4); Hero needs two Strikes. Hero lives only with no crit on either turn:
// failure 1 − (3/4)² = 7/16. G_0 wins in 2; in G_1 crit then normal kills → budget 0.
export const critOnlyBudget0 = scenario('critOnlyBudget0',
  [mon('Hero', 7, 5, [mv('Strike', [4])])],
  [mon('Brute', 8, 10, [mv('Bash', [3], { critChance: rat(1, 4) })])],
  { horizon: 3, expect: { tier1: false, tier1Ram: false, failure: rat(7, 16), critBudget: 0 } });

// critOnlyBudget0 with Hero at 10: only two crits kill (10 − 6 − 6), failure (1/4)² = 1/16; G_1 is safe → budget 1.
export const critOnlyBudget1 = scenario('critOnlyBudget1',
  [mon('Hero', 10, 5, [mv('Strike', [4])])],
  [mon('Brute', 8, 10, [mv('Bash', [3], { critChance: rat(1, 4) })])],
  { horizon: 3, expect: { tier1: false, tier1Ram: false, failure: rat(1, 16), critBudget: 1 } });

// Brute (faster) Bashes 3 or 4. Strike first wins only on rolls 3 then 3 (failure 3/4). Gamble first (hit 1/2 wins at
// once; on a miss Hero must survive Bash, 1/4, and hit on turn 2, 1/2): 1/2 + 1/16 = 9/16, failure 7/16 for horizon ≥ 2
// (1/2 at horizon 1). No crits → budget −1.
export const deadlyRolls = scenario('deadlyRolls',
  [mon('Hero', 7, 5, [mv('Strike', [4]), mv('Gamble', [8], { accuracy: rat(1, 2) })])],
  [mon('Brute', 8, 10, [mv('Bash', [3, 4])])],
  { horizon: 3, expect: { tier1: false, tier1Ram: false, failure: rat(7, 16), critBudget: -1 } });

// Hero (faster) Jab hits (3/4) and KOs; a miss lets Scratch KO Hero. A death without a crit → budget −1.
export const playerMissKills = scenario('playerMissKills',
  [mon('Hero', 5, 10, [mv('Jab', [5], { accuracy: rat(3, 4) })])],
  [mon('Imp', 5, 5, [mv('Scratch', [5])])],
  { horizon: 2, expect: { tier1: false, tier1Ram: false, failure: rat(1, 4), critBudget: -1 } });

// World 0: Gremlin 3 HP, speed 10: Quick (priority 1) KOs it, Strike lets Blast KO Hero. World 1: 6 HP, speed 4: Strike
// KOs it, Quick lets Blast KO Hero. One bar segment hides HP and speed, so display mode picks one first move for both
// worlds (failure 1 in the worse) while RAM mode is tier 1 in 1 turn.
export const worldsSplit = scenario('worldsSplit',
  [mon('Hero', 10, 5, [mv('Quick', [3], { priority: 1 }), mv('Strike', [6])])],
  [mon('Gremlin', 3, 10, [mv('Blast', [10])], { worlds: [{}, { maxHp: 6, speed: 4 }] })],
  {
    horizon: 2, hidden: true, trainer: { hpBarSegments: 1 }, worlds: [{ enemy: [{ nature: 0 }] }, { enemy: [{ nature: 1 }] }],
    expect: { tier1: false, tier1Ram: true, failure: ONE, critBudget: -1 },
  });

// Sandman (faster) Dozes Hero (counter 2 or 3, hidden: a two-member belief), then Bonks 2 a turn since Doze never
// targets a sleeper; Hero wakes on turn 2 or 3 and Strike 4 KOs. Tier 1 within 3 turns.
export const hiddenCounterSafe = scenario('hiddenCounterSafe',
  [mon('Hero', 10, 5, [mv('Strike', [4])])],
  [mon('Sandman', 4, 10, [mv('Doze', [], { effect: 'doze' }), mv('Bonk', [2])])],
  { horizon: 3, hidden: true, expect: { ...TIER1, turns: 3 } });

// Scout leads: Volt 5 (Brute 8 → 3), U-turn to Tank, Bash (Tank 13); turn 2 Bash (Tank 6), Strike KOs. Any other line
// dies: Scout takes Bash 7 > 6, and Tank alone takes three Bashes before two Strikes KO.
export const uturnLine = scenario('uturnLine',
  [mon('Scout', 6, 10, [mv('Volt', [5], { effect: 'uturn' })]), mon('Tank', 20, 3, [mv('Strike', [3])])],
  [mon('Brute', 8, 5, [mv('Bash', [7])])],
  { horizon: 3, expect: { ...TIER1, turns: 2 } });

// Hero KOs Imp; the replacement is Mouse or Tiger (1/2 each), and Hero KOs both in turn, taking one Maul (4, or 8 on a
// crit) from Tiger either way: Hero ends at 6 or 2.
export const replacementTie = scenario('replacementTie',
  [mon('Hero', 10, 15, [mv('Strike', [5])])],
  [mon('Imp', 5, 5, [mv('Scratch', [1])]), mon('Mouse', 5, 5, [mv('Nibble', [1])]), mon('Tiger', 5, 25, [mv('Maul', [4], { critChance: rat(1, 4) })])],
  { horizon: 3, expect: { ...TIER1, turns: 3 } });

// Watcher Jabs (2 beats Brace's 0) until Roar (scary) is revealed, then Braces (heal 3) every turn and never falls.
// Strike, Strike wins in 2 turns, never using Roar.
export const aiMemory = scenario('aiMemory',
  [mon('Hero', 10, 5, [mv('Roar', [1], { tags: ['scary'] }), mv('Strike', [3])])],
  [mon('Watcher', 6, 10, [mv('Jab', [2]), mv('Brace', [], { effect: 'heal3' })], { ai: { preferAgainstScary: 'Brace' } })],
  { horizon: 3, expect: { ...TIER1, turns: 2 } });

// Level 1: aiScore picks Poke (Hero 9), Strike KOs → tier 1 in 1 turn. Level 2 (every legal action): Blast 10 KOs Hero.
export const level2Gap = scenario('level2Gap',
  [mon('Hero', 10, 10, [mv('Strike', [5])])],
  [mon('Bully', 5, 20, [mv('Poke', [1], { aiScore: 10 }), mv('Blast', [10], { aiScore: 1 })])],
  { horizon: 2, expect: { ...TIER1, turns: 1 } });

// Tapper (faster) Taps 2 a turn; two Strikes KO it. Strike, Strike ends 6/10 in 2 turns; within 4 the best is Strike,
// Mend, Mend, Strike, ending 8/10.
export const twoSafeLines = scenario('twoSafeLines',
  [mon('Hero', 10, 5, [mv('Strike', [3]), mv('Mend', [], { effect: 'heal3' })])],
  [mon('Tapper', 6, 10, [mv('Tap', [2])])],
  { horizon: 4, expect: { ...TIER1, turns: 2 } });

// Glare does nothing and every turn is a speed tie: every line is cut off → failure 1, budget −1.
export const stall = scenario('stall',
  [mon('Hero', 10, 5, [mv('Glare', [])])],
  [mon('Statue', 10, 5, [mv('Glare', [])])],
  { horizon: 3, expect: { tier1: false, tier1Ram: false, failure: ONE, critBudget: -1 } });

// keyOmitsTurn, unlimited PP: positions repeat. Hero's Strike 3 hits 1/2. Healer at 6 (A) ties Mend and Glare; Glare and
// a hit → 3 (B), 1/4. At B desperation → Mend: a hit KOs first (1/2), a miss → Mend → A. No horizon proves it.
// P_win(A, n) = 1/4 P_win(B, n−1) + 3/4 P_win(A, n−1), P_win(B, n) = 1/2 + 1/2 P_win(A, n−1): A at 4 is 39/128.
export const loopEscape = scenario('loopEscape',
  [mon('Hero', 10, 10, [mv('Strike', [3], { accuracy: rat(1, 2), pp: null })])],
  [mon('Healer', 6, 5, [mv('Mend', [], { effect: 'heal3', tags: ['desperation'], pp: null }), mv('Glare', [], { pp: null })], { ai: { desperationAtOrBelow: 3 } })],
  { horizon: 4, registry: { keyOmitsTurn: true }, expect: { tier1: false, tier1Ram: false, failure: rat(89, 128), critBudget: -1 } });

// Wild (4 + raw 0..2) KOs Imp on every draw: one merged unlabelled outcome, so failure 1 and budget −1.
export const unlabelledOnly = scenario('unlabelledOnly',
  [mon('Hero', 10, 10, [mv('Wild', [4], { effect: 'raw3' })])],
  [mon('Imp', 4, 5, [mv('Scratch', [1])])],
  { horizon: 2, expect: { tier1: false, tier1Ram: false, failure: ONE, critBudget: -1 } });

// safe1v1 with an unmodelled item: the same values; the verdict is unproven (unmodelledIn() is non-empty).
export const mystery = scenario('mystery',
  [mon('Hero', 10, 10, [mv('Strike', [5])], { item: 'mystery' })],
  [mon('Imp', 5, 5, [mv('Scratch', [3])])],
  { horizon: 3, expect: { ...TIER1, turns: 1 } });

// safe1v1, but the AI throws UNDEFINED for Glitch from turn 1: the solver makes that node an unlabelled leaf, so the
// values are unlabelledOnly's (at level 2 Hero wins in 1). Not in ALL_SCENARIOS: support() would throw.
export const aiUndefined = scenario('aiUndefined',
  [mon('Hero', 10, 10, [mv('Strike', [5])])],
  [mon('Glitch', 5, 5, [mv('Scratch', [1])], { ai: { undefinedBehaviour: true } })],
  { horizon: 2, expect: { tier1: false, tier1Ram: false, failure: ONE, critBudget: -1 } });

// aiUndefined with AI error code DIV_ZERO (a pinch-berry check): any AI error code is unproven. Not in ALL_SCENARIOS.
export const aiDivZero = scenario('aiDivZero',
  [mon('Hero', 10, 10, [mv('Strike', [5])])],
  [mon('Berry', 5, 5, [mv('Scratch', [1])], { ai: { undefinedBehaviour: 'DIV_ZERO' } })],
  { horizon: 2, expect: { tier1: false, tier1Ram: false, failure: ONE, critBudget: -1 } });

// Pre-status (prestatus.test.ts): Hero (guts) may start burned. Unstatused, Sandman2 keeps Dozing and Smashing him and
// every failing branch dies within 7 turns: tier 3, budget −1, failure from the referee. Burned, Doze is never chosen
// and guts makes Strike 4: Smash, Strike, burn; Smash, Strike KOs, burn: tier 1 in 2 turns, Hero ends 2/10.
export const preBurn = scenario('preBurn',
  [mon('Hero', 10, 5, [mv('Strike', [2])], { guts: true })],
  [mon('Sandman2', 6, 10, [mv('Doze', [], { effect: 'doze' }), mv('Smash', [3])])],
  { horizon: 7, preStatusCandidates: { Hero: [{ kind: 'burn' }] }, expect: { tier1: false, tier1Ram: false, critBudget: -1 } });

// Team search (team.test.ts): pool A, B, C, teams of up to 2, no chance anywhere. A (fast) KOs Fang but dies to Wisp's
// Zap; C survives three Zaps and KOs Wisp but dies to Fang's Bite; B dies to anything. Only {A, C} is tier 1: A leads
// and KOs Fang, switch to C (Zap), Smash KOs Wisp, in 3 turns. benchMonotone false: every size is tried, no no-goods.
export const teamPool = scenario('teamPool',
  [mon('A', 4, 15, [mv('Strike', [5])]), mon('B', 3, 1, [mv('Poke', [1])]), mon('C', 9, 1, [mv('Smash', [5])])],
  [mon('Fang', 5, 10, [mv('Bite', [10])]), mon('Wisp', 5, 20, [mv('Zap', [4])])],
  { horizon: 3, benchMonotone: false, expect: { ...TIER1, turns: 3 } });

// A long search to cancel (parallel.test.ts): Statue and Hero Tap 1 from 1000 HP and Statue wins on turn 1000, so
// iterative deepening searches about 500,000 nodes. Not in ALL_SCENARIOS.
export const slowStall = scenario('slowStall',
  [mon('Hero', 1000, 5, [mv('Tap', [1], { pp: null })])],
  [mon('Statue', 1000, 10, [mv('Tap', [1], { pp: null })])],
  { horizon: 1000, expect: { tier1: false, tier1Ram: false, failure: ONE, critBudget: -1 } });

// slowStall at 2000 HP plus Spare (10 HP, slowest), which alone dies on turn 10. Values unread; not in ALL_SCENARIOS.
export const slowPair = scenario('slowPair',
  [mon('Hero', 2000, 5, [mv('Tap', [1], { pp: null })]), mon('Spare', 10, 1, [mv('Tap', [1], { pp: null })])],
  [mon('Statue', 2000, 10, [mv('Tap', [1], { pp: null })])],
  { horizon: 2000, expect: {} });

// Three slow leads, each far longer than any test's budget (sharedPool.test.ts). Values unread; not in ALL_SCENARIOS.
export const slowTrio = scenario('slowTrio',
  [mon('Hero', 2000, 5, [mv('Tap', [1], { pp: null })]), mon('Ally', 2000, 5, [mv('Tap', [1], { pp: null })]), mon('Third', 2000, 5, [mv('Tap', [1], { pp: null })])],
  [mon('Statue', 2000, 10, [mv('Tap', [1], { pp: null })])],
  { horizon: 2000, expect: {} });

// Two leads judged alone: Hero's Jab misses 1/4 and dies (refuted); Wilder always KOs Imp but only through an
// unlabelled outcome (not refuted). So tier 1 is unproven, with Hero's line (death 1/4) as `best`. Not in ALL_SCENARIOS.
export const rawOrRisk = scenario('rawOrRisk',
  [mon('Hero', 5, 10, [mv('Jab', [4], { accuracy: rat(3, 4) })]), mon('Wilder', 5, 10, [mv('Wild', [4], { effect: 'raw3' })])],
  [mon('Imp', 4, 5, [mv('Scratch', [5])])],
  { horizon: 2, expect: { tier1: false, tier1Ram: false, failure: rat(1, 4), critBudget: -1 } });

// Leading with Hero KOs Statue at once (tier 1 in 1 turn); leading with Slug deepens towards its death on turn 2,000,
// far beyond any test's budget. Values unread; not in ALL_SCENARIOS.
export const slowSecondLead = scenario('slowSecondLead',
  [mon('Hero', 10, 20, [mv('Strike', [100_000])]), mon('Slug', 20_000, 5, [mv('Tap', [1], { pp: null })])],
  [mon('Statue', 100_000, 10, [mv('Bash', [10], { pp: null })])],
  { horizon: 3_000, expect: {} });

// Strike, Strike is proven (Hero ends 6/10), but every better line passes through Wild's unlabelled outcome, so the
// ranking stops early. Values unread; not in ALL_SCENARIOS.
export const rankingStopsOnRaw = scenario('rankingStopsOnRaw',
  [mon('Hero', 10, 5, [mv('Strike', [3]), mv('Wild', [6], { effect: 'raw3' })])],
  [mon('Tapper', 6, 10, [mv('Tap', [2])])],
  { horizon: 3, expect: {} });

export const ALL_SCENARIOS: Scenario[] = [
  safe1v1, critOnlyBudget0, critOnlyBudget1, deadlyRolls, playerMissKills, worldsSplit, hiddenCounterSafe, uturnLine,
  replacementTie, aiMemory, level2Gap, twoSafeLines, stall, loopEscape, unlabelledOnly, mystery,
];

/** A gauntlet: p1's mons keyed by name, lead first; one fight per trainer, in the order given; full information. */
function gauntlet(name: string, p1: ToyMon[], trainers: ToyTrainer[], opts: { horizon: number; expect: ScenarioExpect; registry?: Partial<ToyRegistry> }): Scenario {
  const fights = trainers.map((t) => t.id);
  const registry: ToyRegistry = {
    mons: Object.fromEntries(p1.map((m) => [m.name, m])), trainers: Object.fromEntries(trainers.map((t) => [t.id, t])), observeAll: true,
    ...opts.registry,
  };
  return { name, registry, p1: p1.map((m) => m.name), trainerId: fights[0]!, fights, horizon: opts.horizon, expect: opts.expect };
}

// Fight 1: Ogre Crushes once (Hero 5) then Taps 1; Mend, Mend, Smash ends at 9/10, the only line that survives fight
// 2's Bash 8 (ends 1/10, PP 16). With healBefore on fight 2, every line enters at 10/10 and the 1-turn Smash line wins
// the ranking (ends 2/10, PP 19).
export const highHpGauntlet = gauntlet('highHpGauntlet',
  [mon('Hero', 10, 5, [mv('Smash', [6]), mv('Mend', [], { effect: 'heal3' })])],
  [
    { id: 'ogre', party: [mon('Ogre', 6, 10, [mv('Crush', [5], { pp: 1 }), mv('Tap', [1])])] },
    { id: 'brute', party: [mon('Brute', 6, 10, [mv('Bash', [8])])] },
  ],
  { horizon: 3, expect: { ...TIER1, turns: 3 } });

// The lead changes: Hero KOs Imp first in fight 1 (Tank would die to Scratch 20); Tank leads fight 2, survives Bash 10
// and Slam KOs Brute (Hero would die).
export const leadSwapGauntlet = gauntlet('leadSwapGauntlet',
  [mon('Hero', 10, 10, [mv('Strike', [5])]), mon('Tank', 20, 1, [mv('Slam', [8])])],
  [
    { id: 'imp', party: [mon('Imp', 5, 5, [mv('Scratch', [20])])] },
    { id: 'brute', party: [mon('Brute', 8, 20, [mv('Bash', [10])])] },
  ],
  { horizon: 2, expect: { ...TIER1, turns: 1 } });

// Fight 1's speed tie gives two screens but one carry (Hero 10/10, 9 PP): both enter fight 2 as one entry state.
export const sharedEntryGauntlet = gauntlet('sharedEntryGauntlet',
  [mon('Hero', 10, 5, [mv('Strike', [5])])],
  [
    { id: 'twin', party: [mon('Twin', 5, 5, [mv('Glare', [])])] },
    { id: 'imp', party: [mon('Imp', 5, 1, [mv('Scratch', [3])])] },
  ],
  { horizon: 1, expect: { ...TIER1, turns: 1 } });

// gauntlet.test.ts pre-sleeps Hero (counter 1) and Tank (counter 2). Biter Bites 1 or 2, Hero wakes and KOs it; benched
// Tank stays asleep. Fight 2 is entered with Hero 8–9 awake and Tank 2/2 'sleep:2'; Hero KOs Imp.
export const entryRangeGauntlet = gauntlet('entryRangeGauntlet',
  [mon('Hero', 10, 10, [mv('Strike', [5])]), mon('Tank', 2, 1, [mv('Poke', [1])])],
  [
    { id: 'biter', party: [mon('Biter', 5, 20, [mv('Bite', [1, 2])])] },
    { id: 'imp', party: [mon('Imp', 5, 5, [mv('Scratch', [3])])] },
  ],
  { horizon: 1, expect: { ...TIER1, turns: 1 } });

// Each fight: Bash (3, 6 on a crit) then Strike KOs. Death needs a crit in each fight (1/16): counted across the
// gauntlet G_1 is safe and G_2 is not → budget 1, though each fight alone survives one crit.
export const critSpanGauntlet = gauntlet('critSpanGauntlet',
  [mon('Hero', 10, 5, [mv('Strike', [4])])],
  [
    { id: 'brute', party: [mon('Brute', 4, 10, [mv('Bash', [3], { critChance: rat(1, 4) })])] },
    { id: 'bruiser', party: [mon('Bruiser', 4, 10, [mv('Bash', [3], { critChance: rat(1, 4) })])] },
  ],
  { horizon: 1, expect: { tier1: false, tier1Ram: false, failure: rat(1, 16), critBudget: 1 } });

// Fight 2 is a double battle, so the whole gauntlet is refused (nothing is searched).
export const doubleGauntlet = gauntlet('doubleGauntlet',
  [mon('Hero', 10, 10, [mv('Strike', [5])])],
  [
    { id: 'calm', party: [mon('Imp', 5, 5, [mv('Scratch', [3])])] },
    { id: 'pair', party: [mon('Imp', 5, 5, [mv('Scratch', [3])])], double: true },
  ],
  { horizon: 1, expect: {} });

// Fight 1: Hero's Jab must hit (3/4) before Imp's one Crush kills him; a p1 faint ends the line, so fight 2 is entered
// only after a hit (Hero 5/5, Jab 9 PP, Tank 3/3) and is safe. Least death 1/4 by a miss → budget −1.
export const deathGauntlet = gauntlet('deathGauntlet',
  [mon('Hero', 5, 10, [mv('Jab', [5], { accuracy: rat(3, 4) }), mv('Strike', [2])]), mon('Tank', 3, 1, [mv('Poke', [5])])],
  [
    { id: 'imp', party: [mon('Imp', 5, 5, [mv('Crush', [5], { pp: 1 }), mv('Tap', [1])])] },
    { id: 'gnat', party: [mon('Gnat', 2, 5, [mv('Nip', [1])])] },
  ],
  { horizon: 2, expect: { tier1: false, tier1Ram: false, failure: rat(1, 4), critBudget: -1 } });

// undrawnSleepCarry; gauntlet.test.ts pre-sleeps Hero (counter 3). Hero leads and takes Crush (5/10), one attempt slept
// through, then Tank comes in and Slam KOs Lull on turn 3. Hero enters fight 2 as 'sleepUndrawn:1' (counter 1) and
// Tank (1/3) KOs Gnat first. Tier 1 at 3 turns per fight; the Tank-lead line ties on every key, so the Hero lead shows.
export const undrawnSleepGauntlet = gauntlet('undrawnSleepGauntlet',
  [mon('Hero', 10, 5, [mv('Glare', [])]), mon('Tank', 3, 5, [mv('Slam', [5])])],
  [
    { id: 'lull', party: [mon('Lull', 5, 10, [mv('Crush', [5], { pp: 1 }), mv('Tap', [1])])] },
    { id: 'gnat', party: [mon('Gnat', 1, 1, [mv('Nip', [1])])] },
  ],
  { horizon: 3, registry: { undrawnSleepCarry: true }, expect: { ...TIER1, turns: 3 } });

const HALF = rat(1, 2);
const WIN = { phase: 'win', next: {} } as const;
const DEAD = { phase: 'lose', next: {} } as const;

// Table games (full information; nodes without `ai` give the AI one dummy choice).
export const TABLES = {
  // A|X and B|Y win, A|Y and B|X die: every first move dies 1/2 → never tier 1, failure 1/2, budget −1.
  coinFlip: {
    start: 'R',
    nodes: {
      R: { phase: 'turnChoice', p1: ['A', 'B'], ai: [{ name: 'X', p: HALF }, { name: 'Y', p: HALF }], next: {
        'A|X': [{ to: 'win', p: ONE }], 'A|Y': [{ to: 'dead', p: ONE, faintP1: true }], 'B|X': [{ to: 'dead', p: ONE, faintP1: true }], 'B|Y': [{ to: 'win', p: ONE }],
      } },
      win: WIN, dead: DEAD,
    },
  },
  // T → R or S. R: b wins. S → B1, whose x → R: tier 1 from horizon 4 (T, S, B1, R). A search that visits R first meets B1
  // while R is on the stack (x repeats, y dies), so B1 fails there; from S, R is settled and B1 wins through it.
  ghi: {
    start: 'T',
    nodes: {
      T: { phase: 'turnChoice', p1: ['t'], ai: [{ name: 'u', p: ONE }], next: { 't|u': [{ to: 'R', p: HALF }, { to: 'S', p: HALF }] } },
      R: { phase: 'turnChoice', p1: ['a', 'b'], next: { 'a|': [{ to: 'B1', p: ONE }], 'b|': [{ to: 'win', p: ONE }] } },
      S: { phase: 'turnChoice', p1: ['s'], next: { 's|': [{ to: 'B1', p: ONE }] } },
      B1: { phase: 'turnChoice', p1: ['x', 'y'], next: { 'x|': [{ to: 'R', p: ONE }], 'y|': [{ to: 'dead', p: ONE, faintP1: true }] } },
      win: WIN, dead: DEAD,
    },
  },
  // A dies half the time; B always wins, but only through an unlabelled outcome (unproven, not refuted). Failure 1/2.
  deadOrRaw: {
    start: 'R',
    nodes: {
      R: { phase: 'turnChoice', p1: ['A', 'B'], next: { 'A|': [{ to: 'win', p: HALF }, { to: 'dead', p: HALF, faintP1: true }], 'B|': [{ to: 'win', p: ONE, unlabelled: true }] } },
      win: WIN, dead: DEAD,
    },
  },
  // deadOrRaw with B dying 1/4 instead: tier 1 is refuted, failure 1/4.
  bothDie: {
    start: 'R',
    nodes: {
      R: { phase: 'turnChoice', p1: ['A', 'B'], next: {
        'A|': [{ to: 'win', p: HALF }, { to: 'dead', p: HALF, faintP1: true }], 'B|': [{ to: 'win', p: rat(3, 4) }, { to: 'dead', p: rat(1, 4), faintP1: true }],
      } },
      win: WIN, dead: DEAD,
    },
  },
  // C1 → C2 → C3 → win: tier 1 at horizon 3, cut off at 2.
  chain3: {
    start: 'C1',
    nodes: {
      C1: { phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to: 'C2', p: ONE }] } },
      C2: { phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to: 'C3', p: ONE }] } },
      C3: { phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to: 'win', p: ONE }] } },
      win: WIN,
    },
  },
} satisfies Record<string, TableSpec>;
