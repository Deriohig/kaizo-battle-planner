import { describe, expect, it } from 'vitest';
import {
  canNext, defaultField, EMPTY_TURN, ending, likeliest, newPlan, patchOf, patched, requestKey, resolve, stepRequest, withoutLastTurn,
  type Plan, type PlanMon, type PlanStart, type PlanTurn,
} from '../../../web/src/plan';
import type { PlanSendOutJson } from '../../../web/src/planTypes';
import { TRISTAN } from './stubServer';

const BLAZE: PlanMon = { key: 'key-party:1', ref: 'party:1', name: 'Blaze (Monferno)', entry: { ref: 'party:1' } };
const STARLY: PlanMon = { key: 'key-party:2', ref: 'party:2', name: 'Starly', entry: { ref: 'party:2' } };
const BIG: PlanMon = { key: 'key-box:1:4', ref: 'box:1:4', name: 'Big (Bibarel)', entry: { ref: 'box:1:4' } };
const START: PlanStart = { trainerId: TRISTAN, variant: 0, world: 0, mons: [BLAZE, STARLY], lead: BLAZE.key, enemies: ['Imp', 'Mouse', 'Gloom'] };
const THREE = { ...START, mons: [BLAZE, STARLY, BIG] };
const EIGHT: PlanMon[] = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, ref: `party:${i + 1}`, name: `M${i}`, entry: { ref: `party:${i + 1}` } }));
const turn = (over: Partial<PlanTurn> = {}): PlanTurn => ({ ...EMPTY_TURN, ...over });
const plan = (turns: PlanTurn[], over: Partial<Plan> = {}): Plan => ({ ...newPlan(START), turns, ...over });
const switchTo = (by: PlanMon, to: PlanMon): PlanTurn['pick'] => ({ kind: 'switch', by: by.key, to: to.key });
const rat = (num: number | string, den: number | string) => ({ num: String(num), den: String(den) });
const field = (p: Plan, at: number) => stepRequest(p, at)!.state.field;

describe('resolving a plan', () => {
  it.each<[string, Plan, (string | null)[]]>([
    ['the same two carry over', plan([turn(), turn(), turn()]), [BLAZE.key, BLAZE.key, BLAZE.key]],
    ['a switch pick makes the switched-in Pokémon active next turn', plan([turn({ pick: switchTo(BLAZE, STARLY) }), turn()]), [BLAZE.key, STARLY.key]],
    ['his faint with no replacement leaves nobody', plan([turn({ fainted: { mine: BLAZE.key } }), turn()]), [BLAZE.key, null]],
    ['his replacement comes in', plan([turn({ fainted: { mine: BLAZE.key }, sendIn: { mine: STARLY.key } }), turn()]), [BLAZE.key, STARLY.key]],
    ['any pool Pokémon can be his active on a turn', { ...plan([turn(), turn({ mine: BIG.key }), turn()]), start: THREE }, [BLAZE.key, BIG.key, BIG.key]],
    ['a key the pool lacks is nobody', plan([turn()], { start: { ...START, lead: 'key-gone' } }), [null]],
  ])('%s', (_, p, mine) => {
    const rs = resolve(p);
    expect(rs.map((r) => r.turn)).toEqual(mine.map((__, i) => i + 1));
    expect(rs.map((r) => r.mine)).toEqual(mine);
  });

  it('their faint sends in the stored one, else the lowest standing; a switch pick is kept on its turn', () => {
    const picked = resolve(plan([turn({ fainted: { theirs: 0 }, sendIn: { theirs: 2 } }), turn()]));
    expect(picked.map((r) => r.theirs)).toEqual([0, 2]);
    expect(picked[1]?.faintedBefore.theirs).toEqual([0]);
    expect(resolve(plan([turn({ fainted: { theirs: 0 } }), turn()]))[1]?.theirs).toBe(1);
    expect(resolve(plan([turn({ pick: switchTo(BLAZE, STARLY) })]))[0]?.pick).toEqual(switchTo(BLAZE, STARLY));
    expect(stepRequest(plan([turn()], { start: { ...START, lead: 'key-gone' } }), 0)).toBeNull();
  });

  it("the field carries, a switch resets that side's boosts, and their status goes with them", () => {
    const patch = { rocks: { player: true }, stages: { player: { atk: 2 }, enemy: { def: -1 } }, enemyStatus: 'par', weather: 'rain' } as const;
    expect(resolve(plan([turn({ pick: switchTo(BLAZE, STARLY), field: patch }), turn()]))[1]?.field).toMatchObject({
      rocks: { player: true }, weather: 'rain', stages: { player: {}, enemy: { def: -1 } }, enemyStatus: 'par',
    });
    expect(resolve(plan([turn({ fainted: { theirs: 0 }, field: patch }), turn()]))[1]?.field).toMatchObject({ stages: { enemy: {} }, enemyStatus: 'none' });
    expect(resolve(plan([turn({ field: { weather: 'rain' } }), turn(), turn({ field: { weather: 'sun' } })])).map((r) => r.field.weather)).toEqual(['rain', 'rain', 'sun']);
  });

  it('an edit to turn 1 reaches turn 3, and what he set on turn 2 stays', () => {
    const turns = [turn({ field: { rocks: { player: true } } }), turn({ field: { stages: { player: { atk: 1 } } } }), turn()];
    expect(resolve(plan(turns))[2]!.field).toMatchObject({ rocks: { player: true }, stages: { player: { atk: 1 } } });
    expect(resolve(plan([turn(), turns[1]!, turns[2]!]))[2]!.field).toMatchObject({ rocks: { player: false }, stages: { player: { atk: 1 } } });
  });

  it('patchOf and patched round-trip, a 0 overrides a carried boost, and a stage is clamped to ±6', () => {
    const c = { ...defaultField(), stages: { player: { atk: 2 }, enemy: {} } };
    const n = defaultField();
    const p = patchOf(c, n);
    expect(p).toEqual({ stages: { player: { atk: 0 } } });
    expect(patched(c, p)).toEqual(n);
    expect(patchOf(c, c)).toEqual({});
    expect(patched(defaultField(), { stages: { player: { atk: 9 }, enemy: { spe: -9 } } }).stages).toEqual({ player: { atk: 6 }, enemy: { spe: -6 } });
  });

  it('a later pick that no longer applies is ignored and comes back; a mark names who it is about', () => {
    const later = turn({ pick: switchTo(BLAZE, STARLY) });
    const rs = resolve(plan([turn({ mine: STARLY.key }), later, turn()]));
    expect([rs[1]?.pick, rs[2]?.mine]).toEqual([null, STARLY.key]);
    expect(resolve(plan([turn(), later, turn()]))[1]?.pick).toEqual(later.pick);
    const fainted = resolve(plan([turn({ fainted: { mine: BLAZE.key }, sendIn: { mine: STARLY.key } }), turn(), turn({ mine: STARLY.key, pick: switchTo(STARLY, BLAZE) })]));
    expect(fainted[2]?.pick).toBeNull();
    const marked = resolve(plan([turn({ mine: STARLY.key }), turn({ fainted: { mine: BLAZE.key } })]));
    expect([marked[1]?.mine, marked[1]?.fainted.mine]).toEqual([STARLY.key, false]);
  });

  it('his faint waits for a replacement; the end comes with all of theirs or all of his, never with an empty side', () => {
    expect(canNext(plan([turn({ fainted: { mine: BLAZE.key } })]))).toBe(false);
    expect(canNext(plan([turn({ fainted: { mine: BLAZE.key }, sendIn: { mine: STARLY.key } })]))).toBe(true);
    const all = plan([turn({ fainted: { theirs: 0 } }), turn({ fainted: { theirs: 1 } }), turn({ fainted: { theirs: 2 } })]);
    expect([ending(all), canNext(all)]).toEqual(['complete', false]);
    const dead = plan([turn({ fainted: { mine: BLAZE.key }, sendIn: { mine: STARLY.key } }), turn({ fainted: { mine: STARLY.key } })]);
    expect([ending(dead), canNext(dead)]).toEqual(['allFainted', false]);
    expect(ending(plan([turn({ fainted: { theirs: 0 } }), turn({ fainted: { theirs: 1 } })]))).toBeNull();
    expect(ending(plan([turn()], { start: { ...START, enemies: [] } }))).toBeNull();
    expect(ending(plan([turn()], { start: { ...START, mons: [], lead: 'none' } }))).toBeNull();
  });

  it('a try not yet kept is his on its own turn only: later turns keep their picks, marks, notes and boosts', () => {
    const scratch = { kind: 'move', by: BLAZE.key, slot: 0, name: 'Scratch' } as const;
    const surf = { kind: 'move', by: BIG.key, slot: 2, name: 'Surf' } as const;
    const tried = turn({ mine: BIG.key, pick: surf, before: { pick: { kind: 'move', by: BLAZE.key, slot: 1, name: 'Ember' } }, note: 'two' });
    const turns = [turn({ pick: scratch, field: { stages: { player: { atk: 2 } } }, note: 'one' }), tried, turn({ pick: scratch, fainted: { mine: BLAZE.key }, note: 'three' })];
    const rs = resolve({ ...plan(turns), start: THREE });
    expect(rs.map((r) => r.mine)).toEqual([BLAZE.key, BIG.key, BLAZE.key]);
    expect(rs[1]).toMatchObject({ pick: surf, field: { stages: { player: {} } } });            // the tried one came in fresh
    expect(rs[2]).toMatchObject({ pick: scratch, fainted: { mine: true }, faintedBefore: { mine: [] }, field: { stages: { player: { atk: 2 } } } });
    const keptTry = { ...tried };
    delete keptTry.before;                                     // kept, it carries as any switch-in does
    const ks = resolve({ ...plan([turns[0]!, keptTry, turns[2]!]), start: THREE });
    expect(ks.map((r) => r.mine)).toEqual([BLAZE.key, BIG.key, BIG.key]);
    expect(ks[2]?.pick).toBeNull();
  });
});

describe('the step request', () => {
  it('names the team, the draft and the state; the weather only once the start is known, or he set it', () => {
    const p = plan([turn({ fainted: { theirs: 0 } }), turn()]);
    const first = stepRequest(p, 0)!;
    expect(first).toMatchObject({ team: ['party:1', 'party:2'], draft: [{ ref: 'party:1' }, { ref: 'party:2' }], state: { enemy: { active: 0, fainted: [0] } } });
    expect(stepRequest(p, 1)!.state.enemy).toEqual({ active: 1, fainted: [0] });
    // Turn 1 never answered: the start's weather is not known, so no later turn says "none" for it either.
    expect(['weather' in first.state.field, 'weather' in field(p, 1)]).toEqual([false, false]);
    expect(field({ ...p, weather0: 'none' }, 1).weather).toBe('none');
    expect(field({ ...p, weather0: 'sand' }, 1).weather).toBe('sand');
    expect(field(plan([turn(), turn({ field: { weather: 'hail' } }), turn()]), 2).weather).toBe('hail');
    expect(field(plan([turn({ field: { weather: 'rain' } }), turn()]), 0).weather).toBe('rain');
    expect(requestKey(first)).toBe(JSON.stringify(first));
  });

  // A fight in a permanent Trick Room: the request leaves it out until the start's is known or he set one; his value wins.
  it("Trick Room is the battle start's until he sets one", () => {
    const p = plan([turn(), turn()]);
    expect(['trickRoom' in field(p, 0), 'trickRoom' in field(p, 1)]).toEqual([false, false]);
    const room = plan([turn(), turn()], { trickRoom0: true });
    expect(resolve(room).map((r) => r.field.trickRoom)).toEqual([true, true]);
    expect(['trickRoom' in field(room, 0), field(room, 1).trickRoom]).toEqual([false, true]);   // turn 1 always the start's
    expect(field(plan([turn(), turn()], { trickRoom0: false }), 1).trickRoom).toBe(false);
    const off = plan([turn({ field: { trickRoom: false } }), turn()], { trickRoom0: true });
    expect(resolve(off).map((r) => r.field.trickRoom)).toEqual([false, false]);
    expect(field(off, 0).trickRoom).toBe(false);                                                 // his value is sent, on turn 1 too
    expect(field(plan([turn(), turn({ field: { trickRoom: true } })]), 1).trickRoom).toBe(true);
    expect(resolve(plan([turn()]))[0]?.field.trickRoom).toBe(false);
  });

  it("the battle start's stages seed turn 1 under his own, and carry until a switch", () => {
    const stages0 = { player: { atk: -1 }, enemy: { spa: 1 } };
    expect(resolve(plan([turn(), turn(), turn({ mine: STARLY.key })], { stages0 })).map((r) => r.field.stages)).toEqual([stages0, stages0, { player: {}, enemy: { spa: 1 } }]);
    expect(resolve(plan([turn({ field: { stages: { player: { atk: 0, spe: 2 } } } })], { stages0 }))[0]?.field.stages).toEqual({ player: { spe: 2 }, enemy: { spa: 1 } });
    expect(field(plan([turn()], { stages0 }), 0).stages).toEqual(stages0);
    expect(resolve(plan([turn()]))[0]?.field.stages).toEqual({ player: {}, enemy: {} });
  });

  it('his active leads the team, the rest follow pool order, and the cut at six keeps him and the standing', () => {
    const small = stepRequest({ ...plan([turn({ mine: STARLY.key })]), start: THREE }, 0)!;
    expect(small).toMatchObject({ team: ['party:2', 'party:1', 'box:1:4'], draft: [{ ref: 'party:2' }, { ref: 'party:1' }, { ref: 'box:1:4' }], state: { player: { active: 'party:2' } } });
    expect(stepRequest({ ...plan([turn({ mine: 'k7' })]), start: { ...START, mons: EIGHT, lead: 'k0' } }, 0)!.team).toEqual(['party:8', 'party:1', 'party:2', 'party:3', 'party:4', 'party:5']);
    const cut = stepRequest(plan([turn({ mine: 'k1', fainted: { mine: 'k1' }, sendIn: { mine: 'k0' } }), turn()], { start: { ...START, mons: EIGHT, lead: 'k0' } }), 1)!;
    expect(cut.team).toHaveLength(6);
    expect(cut.team[0]).toBe('party:1');
    expect(cut.team).not.toContain('party:2');
    expect(cut.state.player.fainted).toEqual([]);
  });

  it('his fainted mark puts his active in state.player.fainted, and first in the team', () => {
    const req = stepRequest(plan([turn({ fainted: { mine: BLAZE.key }, sendIn: { mine: STARLY.key } })]), 0)!;
    expect(req.state.player).toMatchObject({ fainted: ['party:1'], active: 'party:1' });
    expect(req.team[0]).toBe('party:1');
  });

  it("a Pokémon only an un-kept try added is in no other turn's team, no ending waits on it, and removing the turn takes it out", () => {
    const p = {
      ...plan([
        turn({ fainted: { mine: BLAZE.key }, sendIn: { mine: STARLY.key } }),
        turn({ mine: BIG.key, before: { pick: null, added: [BIG.key] } }),
        turn({ fainted: { mine: STARLY.key } }),
      ]),
      start: THREE,
    };
    expect([0, 1, 2].map((i) => stepRequest(p, i)!.team)).toEqual([['party:1', 'party:2'], ['box:1:4', 'party:2'], ['party:2']]);
    expect(ending(p)).toBe('allFainted');
    // Kept, it is his for good: in the other turns' teams, and the ending waits on it.
    const kept = { ...p, turns: p.turns.map((t, i) => (i === 1 ? turn({ mine: BIG.key }) : t)) };
    expect(stepRequest(kept, 0)!.team).toEqual(['party:1', 'party:2', 'box:1:4']);
    expect(ending(kept)).toBeNull();
    const last = { ...plan([turn(), turn({ mine: BIG.key, before: { pick: null, added: [BIG.key] } })], { cursor: 1 }), start: THREE };
    expect(withoutLastTurn(last).start.mons.map((m) => m.key)).toEqual([BLAZE.key, STARLY.key]);
  });

  it('the likeliest send-out is exact even where floats collide, and ties go to the lower index', () => {
    const so = (...cs: [number, { num: string; den: string }][]): PlanSendOutJson => ({ kind: 'replacement', choices: cs.map(([index, probability]) => ({ index, label: `#${index}`, probability, percent: 0 })) });
    expect(333333333333333333 / 1000000000000000000).toBe(1 / 3);
    expect(likeliest(so([1, rat('333333333333333333', '1000000000000000000')], [2, rat(1, 3)]))).toBe(2);
    expect(likeliest(so([1, rat(1, 4)], [2, rat(3, 4)]))).toBe(2);
    expect(likeliest(so([2, rat(1, 2)], [1, rat(1, 2)]))).toBe(1);
    expect(likeliest(so([1, rat(1, 3)], [2, rat(333333, 1000000)]))).toBe(1);
    expect(likeliest(so())).toBeNull();
  });
});
