// The line service's test deps (the solver's toy engine, AI and resolver, the default labeler, a view of the toy state)
// and small toy fights with known odds.

import type { LineMonJson, LineViewJson } from '../../../src/contracts/api.js';
import type { EngineState } from '../../../src/contracts/engine.js';
import type { LineDeps } from '../../../src/server/lines.js';
import type { ServerData } from '../../../src/server/state.js';
import { defaultLabeler } from '../../../src/solver/labeler.js';
import { rat } from '../../../src/solver/rational.js';
import { createToyAi } from '../solver/toy/ai.js';
import { toyResolver } from '../solver/toy/deps.js';
import { createToyEngine, readToyState, type ToyMonState } from '../solver/toy/engine.js';
import type { ToyMon, ToyMove, ToyTrainer } from '../solver/toy/game.js';
import type { Scenario } from '../solver/toy/scenarios.js';

export const mv = (name: string, damage: number[], extra: Partial<ToyMove> = {}): ToyMove => ({ name, damage, ...extra });
export const mon = (name: string, maxHp: number, speed: number, moves: ToyMove[], extra: Partial<ToyMon> = {}): ToyMon => ({ name, maxHp, speed, moves, ...extra });

/** A scenario of the toy game: `p1` mons (lead first) against one trainer, whose id is the scenario's name. */
export function scenario(name: string, p1: ToyMon[], party: ToyMon[], extra: { trainer?: Partial<ToyTrainer>; worlds?: Scenario['worlds'] } = {}): Scenario {
  return {
    name, registry: { mons: Object.fromEntries(p1.map((m) => [m.name, m])), trainers: { [name]: { id: name, party, ...extra.trainer } }, observeAll: true },
    p1: p1.map((m) => m.name), trainerId: name, horizon: 3, ...(extra.worlds === undefined ? {} : { worlds: extra.worlds }), expect: {},
  };
}

/** Hero (10 HP, faster) against Imp (8 HP): Scratch (3, crit 1/4 for 6) and Poke (3) tie. A turn-1 Strike (5): Scratch 3/8, crit 1/8, Poke 1/2. */
export const duel = scenario('duel',
  [mon('Hero', 10, 10, [mv('Strike', [5]), mv('Weak', [1])])],
  [mon('Imp', 8, 5, [mv('Scratch', [3], { critChance: rat(1, 4) }), mv('Poke', [3])])]);

/** `duel` with a Spare on the bench of the full team: the same fight whether the team is Hero alone or Hero and Spare. */
export const spareDuel = scenario('spareDuel',
  [mon('Hero', 10, 10, [mv('Strike', [5]), mv('Weak', [1])]), mon('Spare', 9, 1, [mv('Nudge', [1])])],
  [mon('Imp', 8, 5, [mv('Scratch', [3], { critChance: rat(1, 4) }), mv('Poke', [3])])]);

/** Hero faster, Strike 5 KOs Imp at once: both AI actions lead to Imp's fall and the replacement is Mouse or Tiger, 1/2 each. */
export const replacement = scenario('replacement',
  [mon('Hero', 10, 15, [mv('Strike', [5])])],
  [mon('Imp', 5, 5, [mv('Scratch', [1])]), mon('Mouse', 5, 5, [mv('Nibble', [1])]), mon('Tiger', 5, 25, [mv('Maul', [4])])]);

/** Brute (faster) kills Hero (4 HP) with Bash 5; Backup (10 HP) is on the bench: a `playerReplacement`. */
export const frail = scenario('frail',
  [mon('Hero', 4, 5, [mv('Strike', [1])]), mon('Backup', 10, 3, [mv('Strike', [1])])],
  [mon('Brute', 8, 10, [mv('Bash', [5])])]);

/** Scout's Volt (U-turn) pauses the turn for Scout's switch to Tank: a `playerMidTurnSwitch`. */
export const uturn = scenario('uturn',
  [mon('Scout', 6, 10, [mv('Volt', [5], { effect: 'uturn' })]), mon('Tank', 20, 3, [mv('Strike', [3])])],
  [mon('Brute', 8, 5, [mv('Bash', [7])])]);

/** The AI's behaviour is undefined for Imp (the hack's pinch-berry check, say): its error code is DIV_ZERO. */
export const undefinedAi = scenario('undefinedAi',
  [mon('Hero', 10, 10, [mv('Strike', [5])])],
  [mon('Imp', 8, 5, [mv('Scratch', [3])], { ai: { undefinedBehaviour: 'DIV_ZERO' } })]);

/** A double battle, which the engine refuses. */
export const doubles = scenario('doubles',
  [mon('Hero', 10, 10, [mv('Strike', [5])])],
  [mon('Imp', 8, 5, [mv('Scratch', [3])])], { trainer: { double: true } });

/** Gremlin's nature is disputed: world 0 (Hardy) has it at 3 HP, world 1 (Lonely) at 6. */
export const disputed = scenario('disputed',
  [mon('Hero', 10, 5, [mv('Strike', [6])])],
  [mon('Gremlin', 3, 10, [mv('Blast', [1])], { worlds: [{}, { maxHp: 6, speed: 4 }] })],
  { worlds: [{ enemy: [{ nature: 0 }] }, { enemy: [{ nature: 1 }] }] });

/** Hero and Frail (2 HP) against `first` (fast Imp, 3 a hit, falls to a Strike), `second`, `bully` (fells anyone), `pair` (double). */
export const gauntlet: Scenario = (() => {
  const team = [mon('Hero', 10, 5, [mv('Strike', [5])]), mon('Frail', 2, 1, [mv('Tap', [1])])];
  const fights = [
    scenario('first', team, [mon('Imp', 5, 20, [mv('Scratch', [3])])]),
    scenario('second', team, [mon('Brute', 8, 1, [mv('Bash', [1])])]),
    scenario('bully', team, [mon('Ogre', 30, 20, [mv('Smash', [20])])]),
    scenario('pair', team, [mon('Imp', 8, 5, [mv('Scratch', [3])])], { trainer: { double: true } }),
  ];
  return { ...fights[0]!, registry: { ...fights[0]!.registry, trainers: Object.assign({}, ...fights.map((f) => f.registry.trainers)) } };
})();

/** What the page would show of a toy state: each mon as the toy state has it. */
function toyView(state: EngineState, labels: readonly string[]): LineViewJson {
  const s = readToyState(state);
  const side = (mons: ToyMonState[], active: number, named: boolean) => {
    const party: LineMonJson[] = mons.map((m, i) => ({
      ident: m.name, name: named ? (labels[i] ?? m.name) : m.name, species: m.name, level: 1, hp: m.hp, maxHp: m.maxHp,
      percent: Math.round((m.hp * 1000) / m.maxHp) / 10, status: m.status === 'none' ? null : m.status, boosts: {}, item: null, ability: '',
      fainted: m.fainted, active: i === active && !m.fainted,
    }));
    return { active: party[active] ?? null, party };
  };
  return {
    player: side(s.p1, s.active.p1, true), enemy: side(s.p2, s.active.p2, false),
    field: { weather: null, conditions: [], player: [], enemy: [] },
  };
}

/** The line service's deps over `s`: toy engine and AI, the default labeler, and `toyView`. `over` is spread last. */
export function toyLineDeps(s: Scenario, over: Partial<LineDeps> = {}): LineDeps {
  return {
    engine: createToyEngine(s.registry), model: createToyAi(s.registry), resolver: () => toyResolver(s), labeler: () => defaultLabeler,
    view: toyView, abilityName: (id) => `ability ${id}`, ...over,
  };
}

/** Server data the toy deps never read; a new object is a new data load. */
export const toyData = (): ServerData => ({} as ServerData);

/** The scenario's mons as `party:<i>` refs, in its order. */
export const refsOf = (s: Scenario): string[] => s.p1.map((_, i) => `party:${i}`);
