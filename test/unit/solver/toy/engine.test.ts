import { describe, expect, it } from 'vitest';
import type { BattleInput, CarryState, Choice, Engine, EngineState, Outcome } from '../../../../src/contracts/engine.js';
import { rat } from '../../../../src/solver/rational.js';
import { createToyEngine, readToyState } from './engine.js';
import type { ToyMon, ToyRegistry, ToyTrainer } from './game.js';
import { choiceKey, mon, mv, toyInput } from './helpers.js';

/** p1's mons keyed by name (lead first), one trainer 'foe'. */
function registry(p1: ToyMon[], foes: ToyMon[], extra: { reg?: Partial<ToyRegistry>; trainer?: Partial<ToyTrainer> } = {}): ToyRegistry {
  return { mons: Object.fromEntries(p1.map((m) => [m.name, m])), trainers: { foe: { id: 'foe', party: foes, ...extra.trainer } }, ...extra.reg };
}

function battle(reg: ToyRegistry, extra?: Partial<BattleInput>) {
  const engine = createToyEngine(reg);
  return { engine, state: engine.createBattle(toyInput(reg, Object.keys(reg.mons), 'foe', extra)) };
}

const move = (slot: number): Choice => ({ kind: 'move', slot });
const M00 = { p1: move(0), p2: move(0) };
const legal = (engine: Engine, s: EngineState) => (['p1', 'p2'] as const).map((side) => engine.legalChoices(s, side).map(choiceKey));

/** An outcome in one line: probability, p1-p2 active HP, phase, chance outcomes, then crit, faint, unlabelled and merge flags. */
function brief(o: Outcome): string {
  const s = readToyState(o.state);
  const phase = o.state.phase.kind === 'terminal' ? `${o.state.phase.winner} wins` : o.state.phase.kind;
  const fainted = [...o.fainted.p1.map((i) => `p1:${i}`), ...o.fainted.p2.map((i) => `p2:${i}`)].join(',');
  return [
    `${o.probability.num}/${o.probability.den}`, `${s.p1[s.active.p1]!.hp}-${s.p2[s.active.p2]!.hp}`, phase,
    o.labels.map((l) => `${l.side}:${l.outcome}`).join(','), o.critBy.p1 && 'critBy p1', o.critBy.p2 && 'critBy p2',
    fainted && `fainted ${fainted}`, o.unlabelled && 'unlabelled', o.merged > 1 && `merged ${o.merged}`,
  ].filter(Boolean).join(' ');
}

const bash = mv('Bash', [3, 4], { accuracy: rat(3, 4), critChance: rat(1, 4) });
// Hero and Brute both carry Bash (accuracy 3/4, crit 1/4, damage 3 or 4); Brute is faster and has a potion.
const chancy = registry([mon('Hero', 20, 5, [bash, mv('Poke', [1])]), mon('Tank', 20, 3, [mv('Strike', [4])])], [mon('Brute', 20, 10, [bash])], { trainer: { bag: ['potion'] } });
const tie = registry([mon('Hero', 10, 5, [mv('Tap', [1])])], [mon('Twin', 10, 5, [mv('Tip', [1])])]);
const plain = registry([mon('Hero', 10, 10, [mv('Strike', [3])])], [mon('Imp', 10, 5, [mv('Scratch', [2])])]);
const brute = mon('Brute', 10, 10, [mv('Bash', [3])]);
const gremlin = registry(
  [mon('Hero', 10, 5, [mv('Strike', [6])])],
  [mon('Gremlin', 3, 10, [mv('Blast', [10])], { worlds: [{}, { maxHp: 6, speed: 4 }] })],
  { trainer: { hpBarSegments: 1 } },
);
const world = (nature: number): Partial<BattleInput> => ({ world: { enemy: [{ nature }] } });

/** One step (Move 0 against Move 0 by default): every outcome's brief; the first outcome's fields and legal choices when given. */
interface Step { reg: ToyRegistry; extra?: Partial<BattleInput>; choices?: { p1: Choice; p2: Choice }; briefs: string[]; first?: Partial<Outcome>; legal?: string[][] }
const STEPS: Record<string, Step> = {
  'hit, crit and roll points carry exact weights and labels': {
    reg: chancy, choices: { p1: move(1), p2: move(0) },
    briefs: [
      '3/32 14-19 turnChoice p2:hit,p2:crit,p2:dmg=3 critBy p2', '3/32 12-19 turnChoice p2:hit,p2:crit,p2:dmg=4 critBy p2',
      '9/32 17-19 turnChoice p2:hit,p2:normal,p2:dmg=3', '9/32 16-19 turnChoice p2:hit,p2:normal,p2:dmg=4', '1/4 20-19 turnChoice p2:miss',
    ],
    first: {
      labels: [{ kind: 'hit', side: 'p2', source: 'bash', outcome: 'hit' }, { kind: 'crit', side: 'p2', source: 'bash', outcome: 'crit' }, { kind: 'roll', side: 'p2', source: 'bash', outcome: 'dmg=3' }],
      log: ['|move|p2a: Brute|Bash|p1a: Hero', '|-crit|p1a: Hero', '|-damage|p1a: Hero|14/20', '|move|p1a: Hero|Poke|p2a: Brute', '|-damage|p2a: Brute|19/20'],
    },
    legal: [['m0', 'm1', 's1'], ['m0', 'i:potion']],
  },
  'the potion goes first, heals 5 (capped) and empties the bag': {
    reg: chancy, choices: { p1: move(1), p2: { kind: 'item', item: 'potion' } }, briefs: ['1/1 20-19 turnChoice'],
    first: { log: ['|-heal|p2a: Brute|20/20|[from] item: Potion', '|move|p1a: Hero|Poke|p2a: Brute', '|-damage|p2a: Brute|19/20'] }, legal: [['m0', 'm1', 's1'], ['m0']],
  },
  "identical leaves merge; a fainted mon's pending move is skipped": {
    reg: registry([mon('Hero', 10, 10, [mv('Strike', [3, 4])])], [mon('Imp', 3, 5, [mv('Scratch', [1])])]),
    briefs: ['1/1 10-0 p1 wins p1:dmg=3 fainted p2:0 merged 2'],
    first: { log: ['|move|p1a: Hero|Strike|p2a: Imp', '|-damage|p2a: Imp|0 fnt', '|faint|p2a: Imp'] }, legal: [[], []],
  },
  'a speed tie is a chance point, 1/2 each order': {
    reg: tie, briefs: ['1/2 9-9 turnChoice p1:first', '1/2 9-9 turnChoice p2:first'],
    first: { log: ['|move|p1a: Hero|Tap|p2a: Twin', '|-damage|p2a: Twin|9/10', '|move|p2a: Twin|Tip|p1a: Hero', '|-damage|p1a: Hero|9/10'] },
  },
  'raw draws are unlabelled': {
    reg: registry([mon('Hero', 10, 10, [mv('Wild', [4], { effect: 'raw3' })])], [mon('Imp', 10, 5, [mv('Scratch', [1])])]),
    briefs: [0, 1, 2].map((k) => `1/3 9-${6 - k} turnChoice p1:raw=${k} unlabelled`),
  },
  'a multi-hit move draws a crit per hit': {
    reg: registry([mon('Hero', 20, 5, [mv('Poke', [1])])], [mon('Brute', 20, 10, [mv('Double', [2], { hits: 2, critChance: rat(1, 4) })])]),
    briefs: [
      '1/16 12-19 turnChoice p2:crit,p2:crit critBy p2', '3/16 14-19 turnChoice p2:crit,p2:normal critBy p2',
      '3/16 14-19 turnChoice p2:normal,p2:crit critBy p2', '9/16 16-19 turnChoice p2:normal,p2:normal',
    ],
  },
  'the last p1 faint ends the battle': {
    reg: registry([mon('Hero', 3, 5, [mv('Tap', [1])])], [brute]), briefs: ['1/1 0-10 p2 wins fainted p1:0'],
    first: { log: ['|move|p2a: Brute|Bash|p1a: Hero', '|-damage|p1a: Hero|0 fnt', '|faint|p1a: Hero'] },
  },
  'a p1 faint with a bench pauses for a replacement': {
    reg: registry([mon('Hero', 3, 5, [mv('Tap', [1])]), mon('Tank', 20, 3, [mv('Strike', [4])])], [brute]),
    briefs: ['1/1 0-10 playerReplacement fainted p1:0'], legal: [['s1'], []],
  },
  'damage follows the rules': { reg: plain, briefs: ['1/1 8-7 turnChoice'] },
  'bugDamagePlusOne adds 1 to every hit': { reg: { ...plain, bugDamagePlusOne: true }, briefs: ['1/1 7-6 turnChoice'] },
  'world 0: Gremlin is faster and KOs Hero': { reg: gremlin, extra: world(0), briefs: ['1/1 0-3 p2 wins fainted p1:0'] },
  'world 1: Gremlin has 6 HP and is slower, and Strike KOs it': { reg: gremlin, extra: world(1), briefs: ['1/1 10-0 p1 wins fainted p2:0'] },
};

describe('toy engine', () => {
  it.each(Object.entries(STEPS))('%s', (_, c) => {
    const { engine, state } = battle(c.reg, c.extra);
    const outcomes = engine.expandTurn(state, c.choices ?? M00);
    expect(outcomes.map(brief)).toEqual(c.briefs);
    if (c.first !== undefined) expect(outcomes[0]).toMatchObject(c.first);
    if (c.legal !== undefined) expect(legal(engine, outcomes[0]!.state)).toEqual(c.legal);
  });

  it('carry and start statuses apply; sleep ticks, burn costs 1 HP, no PP means Struggle', () => {
    const reg = registry(
      [mon('Hero', 10, 5, [mv('Strike', [3], { pp: 5 }), mv('Mend', [], { effect: 'heal3', pp: null })]), mon('Ally', 10, 5, [mv('Strike', [3])])],
      [mon('Imp', 20, 10, [mv('Scratch', [1])])],
    );
    const none = { kind: 'none' } as const;
    const carry: CarryState = { mons: [{ hp: 4, pp: [2], status: none }, { hp: 9, pp: [7], status: none }] };
    const { engine, state } = battle(reg, { carry, startStatus: { 0: { kind: 'sleep', turns: 1 } } });
    expect(engine.carryOut(state)).toEqual({ mons: [{ hp: 4, pp: [2], status: { kind: 'sleep', turns: 1 } }, carry.mons[1]] });
    expect(readToyState(state).p1[0]).toMatchObject({ hp: 4, pp: [2, null], status: 'sleep', sleep: 1 });
    // Counter 1 wakes and acts on its first attempt; counter 2 is fast asleep and spends no PP.
    const [woke] = engine.expandTurn(state, M00);
    expect([brief(woke!), woke!.log[2], engine.carryOut(woke!.state).mons[0]]).toEqual(['1/1 3-17 turnChoice', '|-curestatus|p1a: Hero|slp|[msg]', { hp: 3, pp: [1], status: none }]);
    const two = battle(reg, { startStatus: { 0: { kind: 'sleep', turns: 2 } } });
    const [asleep] = two.engine.expandTurn(two.state, M00);
    expect([brief(asleep!), asleep!.log.at(-1), readToyState(asleep!.state).p1[0]]).toMatchObject(['1/1 9-20 turnChoice', '|cant|p1a: Hero|slp', { status: 'sleep', sleep: 1, pp: [5, null] }]);
    // Burn ticks at the end of the turn; other start statuses are refused.
    const burnt = battle(reg, { startStatus: { 0: { kind: 'burn' } } });
    expect(burnt.engine.expandTurn(burnt.state, { p1: move(1), p2: move(0) })[0]!.log.at(-1)).toBe('|-damage|p1a: Hero|9/10|[from] brn');
    expect(() => battle(reg, { startStatus: { 0: { kind: 'paralysis' } } })).toThrow(/not supported/);
    const tired = battle(registry([mon('Solo', 10, 10, [mv('Strike', [3], { pp: 1 })])], [mon('Imp', 20, 5, [mv('Scratch', [1])])]), { carry: { mons: [{ hp: 10, pp: [0], status: none }] } });
    const [struggled] = tired.engine.expandTurn(tired.state, M00);
    expect([legal(tired.engine, tired.state)[0], brief(struggled!), struggled!.log[0]]).toEqual([['m0'], '1/1 9-19 turnChoice', '|move|p1a: Solo|Struggle|p2a: Imp']);
  });

  it('undrawnSleepCarry carries a sleeper as an undrawn sleep with its attempts', () => {
    const fight = (reg: Partial<ToyRegistry>) => registry([mon('Hero', 10, 5, [mv('Strike', [3])])], [mon('Imp', 20, 10, [mv('Scratch', [1])])], { reg });
    const reg = fight({ undrawnSleepCarry: true });
    const p1Of = (s: EngineState) => readToyState(s).p1[0];
    const carried = (attempts: number) => battle(reg, { carry: { mons: [{ hp: 9, pp: [10], status: { kind: 'sleepUndrawn', attempts } }] } });
    // Pre-slept with counter 3: one attempt slept through, then carried out with 1 attempt.
    const pre = battle(reg, { startStatus: { 0: { kind: 'sleep', turns: 3 } } });
    const [slept] = pre.engine.expandTurn(pre.state, M00);
    expect([pre.engine.carryOut(pre.state).mons[0]!.status, pre.engine.carryOut(slept!.state).mons[0]]).toEqual([
      { kind: 'sleepUndrawn', attempts: 0 }, { hp: 9, pp: [10], status: { kind: 'sleepUndrawn', attempts: 1 } },
    ]);
    // Carried in: counter max(1, 2 − attempts), attempts kept; with 1 attempt he wakes on the next.
    const one = carried(1);
    expect([p1Of(slept!.state), p1Of(carried(0).state), p1Of(one.state), p1Of(one.engine.expandTurn(one.state, M00)[0]!.state)]).toMatchObject([
      { status: 'sleep', sleep: 2, slept: 1 }, { status: 'sleep', sleep: 2, slept: 0 }, { status: 'sleep', sleep: 1, slept: 1 }, { status: 'none', sleep: 0, slept: 0 },
    ]);
    expect(() => carried(-1)).toThrow(/attempts/);
    // Without the flag the state has no `slept` (and carryOut keeps the counter, as in the carry test).
    expect(p1Of(battle(fight({}), { startStatus: { 0: { kind: 'sleep', turns: 3 } } }).state)).not.toHaveProperty('slept');
  });
});
