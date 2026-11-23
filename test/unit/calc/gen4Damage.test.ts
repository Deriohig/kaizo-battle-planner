// `gen4Damage`, derived from pret/pokeplatinum (battle_lib.c); the expected numbers are worked out by hand. Its type step
// is checked against the chart walk in typeChart.test.ts, through `damage`.
import { describe, expect, it } from 'vitest';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { CalcSide } from '../../../src/calc/calc.js';
import { Gen4DamageUnsupported, gen4ConfusionDamage, gen4Damage } from '../../../src/calc/gen4Damage.js';
import { move } from '../../fixtures/battleMons.js';
import { stats } from '../../fixtures/loadedData.js';

const [HUGE_POWER, GUTS, NO_GUARD, TINTED_LENS, SCRAPPY] = [37, 62, 99, 110, 113];
const ability = (value: number) => ({ ability: { value, source: 'rom' as const, disputed: false, alternatives: [] } });
/** A level 50 Normal Pokémon, 100 in every base stat (120 at 31 IVs), with Natural Cure, which changes nothing here. */
const mon = (fields: Partial<ResolvedMon> = {}): ResolvedMon => ({
  species: 263, form: 0, name: 'Mon', level: 50, gender: 'M', ivs: stats(31, 31, 31, 31, 31, 31), evs: stats(0, 0, 0, 0, 0, 0),
  nature: { value: 0, source: 'rom', disputed: false, alternatives: [] }, ...ability(30),
  item: 0, moves: [33], baseStats: stats(100, 100, 100, 100, 100, 100), types: [0, 0], friendship: 70, ...fields,
});
const side = (m: ResolvedMon, fields: Omit<CalcSide, 'mon'> = {}): CalcSide => ({ mon: m, ...fields });
const rolls = (attacker: CalcSide, defender: CalcSide = side(mon()), used = move(33, { power: 100 })) => gen4Damage(attacker, defender, used, {}, false);

describe('gen4Damage', () => {
  it('applies stat terms to the raw stat, each floored, before the stage: Huge Power at +1 on an odd Attack', () => {
    // Raw 11 × 2 = 22, then × 15 / 10 = 33; Showdown's order gave 3 × 11 − 1.
    const odd = { baseStats: stats(100, 6, 100, 100, 100, 100), ivs: stats(31, 0, 31, 31, 31, 31) };
    expect(rolls(side(mon({ ...odd, ...ability(HUGE_POWER) }), { boosts: { atk: 1 } }))[15]).toBeGreaterThan(rolls(side(mon(odd), { boosts: { atk: 1 } }))[15]!);
  });

  it('Guts with a status skips the burn halving and takes Attack × 1.5', () => {
    // Attack 180: floor(180 × 100 × 22 / 120 / 50) + 2 = 68, × 1.5 STAB = 102 at the top roll. Attack 120: 46, then 69.
    expect(rolls(side(mon(ability(GUTS)), { status: { kind: 'burn' } }))[15]).toBe(102);
    expect(rolls(side(mon(ability(GUTS))))[15]).toBe(69);
  });

  it('gives a fixed-damage move its damage, and 0 against an immunity', () => {
    const seismic = move(69, { type: 1, power: 1, romEffect: 87, calc: { baseMove: 'Seismic Toss', fixedDamage: 'level' } });
    expect(rolls(side(mon()), side(mon()), seismic)).toEqual(Array(16).fill(50));
    expect(rolls(side(mon()), side(mon({ types: [7, 7] })), seismic)).toEqual(Array(16).fill(0));
  });

  it('deals 0 for Fighting on Ghost/Poison even with Tinted Lens: the Ghost immunity row after 0xFE comes last; Scrappy stops before it', () => {
    const closeCombat = move(370, { type: 1, power: 120 });
    expect(rolls(side(mon(ability(TINTED_LENS))), side(mon({ types: [7, 3] })), closeCombat)).toEqual(Array(16).fill(0));
    expect(Math.min(...rolls(side(mon(ability(SCRAPPY))), side(mon({ types: [7, 3] })), closeCombat))).toBeGreaterThan(0);
  });

  it('refuses a move whose damage it does not derive: Psywave, and Low Kick\'s power from weight', () => {
    for (const used of [move(149, { calc: { baseMove: 'Psywave', fixedDamage: 'psywave' } }), move(67, { power: 1, calc: { baseMove: 'Low Kick' } })]) {
      expect(() => rolls(side(mon()), side(mon()), used)).toThrow(Gen4DamageUnsupported);
    }
  });

  it('makes the confusion self-hit a 40-power typeless physical hit on itself: no weather, screen, crit or chart', () => {
    // floor(120 × 40 × 22 / 120 / 50) + 2 = 19, so the rolls run 16 to 19.
    expect(gen4ConfusionDamage(side(mon()))).toEqual([16, 16, 16, 16, 16, 17, 17, 17, 17, 17, 18, 18, 18, 18, 18, 19]);
  });

  it('has no damage term for No Guard', () => expect(rolls(side(mon(ability(NO_GUARD))))).toEqual(rolls(side(mon()))));
});
