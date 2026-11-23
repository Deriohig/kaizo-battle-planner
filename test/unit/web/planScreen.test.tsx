import { describe, expect, it } from 'vitest';
import {
  clearedText, entryOf, hear, koStripe, markedMine, markedTheirs, orderLine, planMonOf, planWorkingText, poolDiffers, poolNow, shownMine,
  shownTheirs, startOf, turnSaid, type Heard, type StepPanel,
} from '../../../web/src/components/plan/planScreen';
import { EMPTY_TURN, newPlan, resolve, stepRequest, type Plan, type PlanStart, type PlanTurn } from '../../../web/src/plan';
import { hpBarText, likeliestMove } from '../../../web/src/tree';
import { NUMBERS, r } from './lineServer';
import { stepAnswer } from './planServer';
import { box, TRISTAN } from './stubServer';

const mons = new Map(box().mons.map((m) => [m.ref, m]));
const BLAZE = mons.get('party:1')!;
const STARLY = mons.get('party:2')!;
const BIG = mons.get('box:1:4')!;
const FIGHT = { trainerId: TRISTAN, variant: 0 };
const ENEMIES = ['Imp', 'Mouse', 'Gloom'];
const TEAM = ['party:1', 'party:2'];
const turn = (over: Partial<PlanTurn> = {}): PlanTurn => ({ ...EMPTY_TURN, ...over });
function planOf(turns: PlanTurn[], start?: PlanStart): Plan {
  return { ...newPlan(start ?? startOf(FIGHT, 'party:1', TEAM, mons, [], ENEMIES)!), turns };
}
/** The step answer for turn `i` of `plan`, as the route gives it. */
const stepFor = (plan: Plan, i: number): StepPanel => stepAnswer(stepRequest(plan, i)!);
const refs = (pool: { ref: string }[]) => pool.map((m) => m.ref);
const odds = (...choices: [string, ReturnType<typeof r>][]) => ({ ...stepFor(planOf([turn()]), 0), aiOdds: { kind: 'turn' as const, choices: choices.map(([label, probability]) => ({ label, probability, percent: (Number(probability.num) / Number(probability.den)) * 100 })) } });

describe('the plan screen helpers', () => {
  it('entryOf, planMonOf and startOf build the pool from the team the box has, in team order, the lead by key', () => {
    expect(entryOf([{ ref: 'party:1', level: 16 }], 'party:1')).toEqual({ ref: 'party:1', level: 16 });
    expect(entryOf([{ ref: 'party:1', level: 16 }], 'party:2')).toEqual({ ref: 'party:2' });
    expect(planMonOf(BLAZE, [{ ref: 'party:1', level: 16 }])).toEqual({ key: BLAZE.key, ref: 'party:1', name: 'Blaze (Monferno)', entry: { ref: 'party:1', level: 16 } });
    expect(planMonOf(STARLY, []).name).toBe('Starly');
    const start = startOf(FIGHT, 'party:2', ['party:2', 'box:9:9', 'party:1'], mons, [], ENEMIES)!;
    expect(refs(start.mons)).toEqual(['party:2', 'party:1']);
    expect(start).toMatchObject({ trainerId: TRISTAN, variant: 0, world: 0, lead: STARLY.key, enemies: ENEMIES });
    expect(startOf(FIGHT, 'box:9:9', ['party:1'], mons, [], ENEMIES)).toBeNull();          // the lead is not in the box
  });

  it('poolNow keeps a tried box Pokémon after the team, drops one the box no longer has, and gives each entry as the draft has it', () => {
    const plan = planOf([turn()], startOf(FIGHT, 'party:1', [...TEAM, 'box:1:4'], mons, [], ENEMIES)!);
    expect(refs(poolNow(plan, TEAM, mons, []))).toEqual(['party:1', 'party:2', 'box:1:4']);
    const without = new Map(mons);
    without.delete(BIG.ref);
    expect(refs(poolNow(plan, TEAM, without, []))).toEqual(TEAM);
    expect(refs(poolNow(plan, ['party:2', 'party:1'], mons, [])).slice(0, 2)).toEqual(['party:2', 'party:1']);
    expect(poolNow(planOf([turn()]), TEAM, mons, [{ ref: 'party:2', level: 20 }])[1]!.entry).toEqual({ ref: 'party:2', level: 20 });
  });

  // After a save change a ref may be another Pokémon's: a pool Pokémon is looked up by its key, never by its old ref.
  it('poolNow finds a pool Pokémon by key: moved, it is at its new ref; another Pokémon at its old ref is not it', () => {
    const plan = planOf([turn()], startOf(FIGHT, 'party:1', [...TEAM, 'box:1:4'], mons, [], ENEMIES)!);
    const at = (...list: (typeof BLAZE)[]) => new Map(list.map((m) => [m.ref, m]));
    const imposter = { ...STARLY, key: 'key-other', ref: 'box:1:4' as const };
    const pool = poolNow(plan, TEAM, at(BLAZE, STARLY, { ...BIG, ref: 'box:3:2' }, imposter), [{ ref: 'box:3:2', level: 21 }]);
    expect(pool.map((m) => [m.key, m.ref])).toEqual([[BLAZE.key, 'party:1'], [STARLY.key, 'party:2'], [BIG.key, 'box:3:2']]);
    expect(pool[2]!.entry).toEqual({ ref: 'box:3:2', level: 21 });
    expect(poolNow(plan, TEAM, at(BLAZE, STARLY, imposter), []).map((m) => m.key)).toEqual([BLAZE.key, STARLY.key]);   // gone: left out
    expect(refs(poolNow(plan, [...TEAM, 'party:3'], at(BLAZE, STARLY, { ...BIG, ref: 'party:3' }), []))).toEqual(['party:1', 'party:2', 'party:3']);   // once, on the team
  });

  it('poolDiffers compares key, ref and entry in order, not the name', () => {
    const plan = planOf([turn()]);
    const same = poolNow(plan, TEAM, mons, []);
    expect([
      poolDiffers(plan, same), poolDiffers(plan, [...same].reverse()), poolDiffers(plan, same.slice(0, 1)),
      poolDiffers(plan, poolNow(plan, TEAM, mons, [{ ref: 'party:1', level: 16 }])), poolDiffers(plan, same.map((m) => ({ ...m, name: 'Renamed' }))),
    ]).toEqual([false, true, true, true, false]);
  });

  it("markedTheirs and markedMine list every faint marked, the last turn's included", () => {
    const theirs = resolve(planOf([turn({ fainted: { theirs: 0 } }), turn({ fainted: { theirs: 1 } })]));
    expect([markedTheirs(theirs), markedTheirs(theirs.slice(0, 1)), markedTheirs([])]).toEqual([[0, 1], [0], []]);
    expect(markedTheirs(resolve(planOf([turn({ fainted: { theirs: 0 } }), turn()])))).toEqual([0]);
    const mine = resolve(planOf([turn({ fainted: { mine: BLAZE.key }, sendIn: { mine: STARLY.key } }), turn({ fainted: { mine: STARLY.key } })]));
    expect([markedMine(mine), markedMine(mine.slice(0, 1)), markedMine(resolve(planOf([turn()])))]).toEqual([[BLAZE.key, STARLY.key], [BLAZE.key], []]);
  });

  it("shownMine is the move of the pick's slot, and null for a switch, no pick or no damage", () => {
    const step = stepFor(planOf([turn()]), 0);
    const move = { kind: 'move' as const, by: BLAZE.key, slot: 0, name: 'Scratch' };
    expect(shownMine(step, move)).toBe(NUMBERS.yours[0]);
    for (const [s, pick] of [[step, { ...move, slot: 3 }], [step, { kind: 'switch', by: BLAZE.key, to: STARLY.key }], [step, null], [{ ...step, damage: undefined }, move], [null, move]] as const) {
      expect(shownMine(s, pick)).toBeNull();
    }
  });

  // One rule for "their likeliest move", the reply list's (`likeliestMove`), so the list and the split agree.
  it.each<[string, ReturnType<typeof odds>, string | null, { name: string; likeliest: boolean; percent: string | null } | null]>([
    ['a tie: what the reply list marks likeliest', odds(['Sand-Attack', r(1, 2)], ['Quick Attack', r(1, 2)]), null, { name: 'Quick Attack', likeliest: true, percent: '50%' }],
    ['a 0% move never', odds(['Quick Attack', r(0, 1)]), null, null],
    ['exactly, past what a float tells apart', odds(['Quick Attack', { num: String(10n ** 30n), den: String(2n * 10n ** 30n + 1n) }], ['Sand-Attack', { num: String(10n ** 30n + 1n), den: String(2n * 10n ** 30n + 3n) }]), null, { name: 'Sand-Attack', likeliest: true, percent: '50%' }],
    ['a likeliest label that is not a move is skipped', odds(['Switch to Onix', r(3, 4)], ['Sand-Attack', r(3, 16)], ['Quick Attack', r(1, 16)]), null, { name: 'Sand-Attack', likeliest: true, percent: '18.75%' }],
    ['only a switch: none', odds(['Switch to Onix', r(1, 1)]), null, null],
    ['a picked move, not the likeliest', stepFor(planOf([turn()]), 0) as ReturnType<typeof odds>, 'Sand-Attack', { name: 'Sand-Attack', likeliest: false, percent: '37.5%' }],
    ['no odds: no percent', { ...stepFor(planOf([turn()]), 0), aiOdds: undefined } as unknown as ReturnType<typeof odds>, 'Quick Attack', { name: 'Quick Attack', likeliest: false, percent: null }],
    ['no odds and no pick: none', { ...stepFor(planOf([turn()]), 0), aiOdds: undefined } as unknown as ReturnType<typeof odds>, null, null],
    ['no damage: none', { ...stepFor(planOf([turn()]), 0), damage: undefined } as unknown as ReturnType<typeof odds>, 'Quick Attack', null],
  ])('shownTheirs: %s', (_, step, picked, expected) => {
    const shown = shownTheirs(step, picked);
    expect(shown === null ? null : { name: shown.move.name, likeliest: shown.likeliest, percent: shown.percent }).toEqual(expected);
    if (shown !== null && shown.likeliest) expect(shown.move.name).toBe(likeliestMove(step));
  });

  it('shownTheirs of no step is none; turnSaid says the turn, and both HPs when the step has both actives', () => {
    expect(shownTheirs(null, null)).toBeNull();
    const plan = planOf([turn(), turn()]);
    const step = stepFor(plan, 0);
    const rs = resolve(plan);
    expect(turnSaid(rs[0]!, step)).toBe(`Turn 1. Blaze (Monferno) 44/44 against Imp ${hpBarText(step.view.enemy.active!)}.`);
    expect(turnSaid(rs[0]!, step)).toBe('Turn 1. Blaze (Monferno) 44/44 against Imp HP bar 100% (20/20).');
    expect(turnSaid(rs[1]!, null)).toBe('Turn 2.');
    expect(turnSaid(rs[0]!, { ...step, view: { ...step.view, enemy: { ...step.view.enemy, active: null } } })).toBe('Turn 1.');
    expect([planWorkingText(4, false), planWorkingText(4, true), clearedText(1), clearedText(3)]).toEqual(['Working out turn 4…', 'Still working out turn 4.', 'Plan cleared (1 turn).', 'Plan cleared (3 turns).']);
  });

  it('hear says what changed for the live region: arrivals with a fresh notice once, slow, cleared, and notices after the step', () => {
    const start: Heard = { seq: 0, slow: false, notices: [], cleared: null, text: '' };
    const now = (over: Partial<Parameters<typeof hear>[1]> = {}) => ({ seq: 0, slow: false, busy: false, notices: [] as string[], cleared: null, ...over });
    const none = () => null;
    const working = () => 'Still working out turn 2.';
    expect(hear(start, now(), none, working)).toBeNull();                                           // nothing changed
    const first = hear(start, now({ seq: 1, notices: ['Team changed.'] }), () => 'Turn 2.', working)!;
    expect(first.text).toBe('Turn 2. Team changed.');
    expect(hear(first, now({ seq: 2, notices: ['Team changed.'] }), () => 'Turn 3.', working)!.text).toBe('Turn 3.');
    expect(hear({ ...start, text: 'Turn 1.' }, now({ seq: 1 }), none, working)!.text).toBe('Turn 1.');   // no sentence: the old words
    const slow = hear(start, now({ slow: true }), none, working)!;
    expect(slow.text).toBe('Still working out turn 2.');
    expect(hear(slow, now({ slow: false }), none, working)!.text).toBe('');
    const cleared = hear(start, now({ cleared: 3 }), none, working)!;
    expect(cleared.text).toBe('Plan cleared (3 turns).');
    expect(hear(cleared, now({ cleared: null }), none, working)!.text).toBe('');
    expect(hear(start, now({ busy: true, notices: ['Team changed.'] }), none, working)).toBeNull();      // waits for the step's end
    expect(hear(start, now({ notices: ['Team changed.'] }), none, working)!.text).toBe('Team changed.');
  });
});

// The turn order names who moves first, the first mover's Speed first.
it('orderLine names the first mover, its Speed first, with the priority note and the items that can change it', () => {
  const order = (first: 'player' | 'enemy' | 'tie', player: number, enemy: number, changers: string[] = []) => ({ first, player, enemy, changers });
  const line = (o: ReturnType<typeof order> | null, priority = 0) => orderLine({ ...NUMBERS, order: o, theirs: NUMBERS.theirs.map((m) => ({ ...m, priority })) }, 'Prinplup', 'Miltank');
  expect(line(order('enemy', 52, 65))).toBe('Miltank moves first · Speed 65 vs 52');
  expect(line(order('player', 65, 52))).toBe('Prinplup moves first · Speed 65 vs 52');
  expect(line(order('tie', 21, 21))).toBe('Speed tie at 21: either moves first');
  expect(line(order('enemy', 52, 65, ['Quick Claw']), 1)).toBe('Miltank moves first · Speed 65 vs 52 · at equal priority · Quick Claw can change this');
  expect(line(null)).toBe('Speed order not worked out here.');
  expect(orderLine(undefined, 'Prinplup', 'Miltank')).toBeNull();
});

it('koStripe is danger when one hit can KO him, warn when only a crit can or a held item survives it, else none', () => {
  const [ONE, ZERO] = [r(1, 1), r(0, 1)];
  const quick = NUMBERS.theirs[0]!;
  expect(koStripe({ ...quick, koExact: [r(1, 2), ONE, ONE, ONE] })).toBe('danger');
  expect(koStripe({ ...quick, koExact: [ZERO, ONE, ONE, ONE], koCritExact: r(1, 2) })).toBe('warn');
  expect(koStripe({ ...quick, koExact: [ONE, ONE, ONE, ONE], survives: 'Focus Sash' })).toBe('warn');
  expect(koStripe(quick)).toBeNull();
  expect(koStripe(NUMBERS.theirs[1]!)).toBeNull();                                         // a status move
});
