import { describe, expect, it } from 'vitest';
import type { KaizoMove } from '../../../src/battle/moves.js';
import { type CalcSide, damage } from '../../../src/calc/calc.js';
import { monferno, move, zigzagoon } from '../../fixtures/battleMons.js';
import { POKEMON_TYPES_TXT, TYPE_MATCHUP_MULTIPLIERS_C } from '../../fixtures/cartridgeTypeChart.js';

// The type step follows the cartridge's chart-row order: `BattleSystem_ApplyTypeChart` (battle_lib.c:2560-2672) walks
// `sTypeMatchupMultipliers` row by row, applying each row that matches a defender type and truncating every time.
// @smogon/calc applies the two types in its own order, which differs for Ice on Fire/Flying and Ghost on Ghost/Dark.

// The reference walk, from the decompilation text alone. generated/pokemon_types.txt is an enum: line k is ID k - 1.
const TYPE_IDS = new Map(POKEMON_TYPES_TXT.trim().split('\n').map((name, id) => [name.trim(), id]));
const TYPE_LABELS = [...TYPE_IDS.keys()].map((name) => name.replace('TYPE_', ''));
const MULTIPLIERS: Record<string, number> = { TYPE_MULTI_IMMUNE: 0, TYPE_MULTI_NOT_VERY_EFF: 5, TYPE_MULTI_SUPER_EFF: 20 }; // battle.h:144-146
/** The rows: [attacking, defending, multiplier x10], with the 0xFE and 0xFF markers as -2 and -1. */
const ROWS = [...TYPE_MATCHUP_MULTIPLIERS_C.matchAll(/\{ (\w+), (\w+), (\w+) \}/g)].map(([, atk, def, mul]) => {
  const id = (name: string) => (name === '0xFE' ? -2 : name === '0xFF' ? -1 : TYPE_IDS.get(name)!);
  return [id(atk!), id(def!), MULTIPLIERS[mul!]!] as const;
});

/**
 * Walks the rows to 0xFF, stopping at 0xFE when the Ghost is revealed (Foresight or Scrappy, 2612-2621). Each matching row
 * multiplies nonzero damage through `BattleSystem_Divide`, which never truncates a nonzero result to 0, and updates the
 * effectiveness flags as `ApplyTypeMultiplier` does (7542-7575). Tinted Lens then doubles a not-very-effective hit.
 */
function cartridgeTypeStep(dealt: number, moveType: number, [type1, type2]: readonly [number, number], opts: { tintedLens?: boolean; ghostRevealed?: boolean } = {}): number {
  let [result, superEffective, notVeryEffective] = [dealt, false, false];
  const apply = (mul: number) => {
    const product = result * mul;
    result = product === 0 ? 0 : Math.trunc(product / 10) || 1;
    if (mul === 0) [superEffective, notVeryEffective] = [false, false];
    else if (mul === 5) [superEffective, notVeryEffective] = superEffective ? [false, notVeryEffective] : [superEffective, true];
    else if (mul === 20) [superEffective, notVeryEffective] = notVeryEffective ? [superEffective, false] : [true, notVeryEffective];
  };
  for (const [atk, def, mul] of ROWS) {
    if (atk === -1 || (atk === -2 && opts.ghostRevealed)) break;
    if (atk !== moveType) continue;
    if (def === type1) apply(mul);
    if (def === type2 && type1 !== type2) apply(mul);
  }
  return notVeryEffective && opts.tintedLens ? result * 2 : result;
}

const [NORMAL, FLYING, GROUND, BUG, MYSTERY] = [0, 2, 4, 6, 9];
const [KLUTZ, TINTED_LENS, SCRAPPY, IRON_BALL] = [103, 110, 113, 278];
const ability = (value: number) => ({ ability: { value, source: 'rom' as const, disputed: false, alternatives: [] } });

describe('damage: the type step in the cartridge\'s chart-row order', () => {
  // Two setups: Monferno's 60-power special hit on a level 5 Zigzagoon (rolls in the 20s), and a level 5 Zigzagoon's
  // 10-power physical hit on Monferno (rolls of 1 to 3, where the division never truncates to 0). The rolls before the
  // type step are each setup's on a neutral defender.
  const setups: { name: string; attacker: (id: number | null) => CalcSide; defender: (types: [number, number]) => CalcSide; move: (type: number) => KaizoMove }[] = [
    { name: 'strong', attacker: (id) => ({ mon: monferno(id === null ? {} : ability(id)) }), defender: (types) => ({ mon: zigzagoon({ item: 0, types }) }),
      move: (type) => move(500, { type, category: 'special', power: 60, calc: { baseMove: 'Swift' } }) },
    { name: 'weak', attacker: (id) => ({ mon: zigzagoon({ item: 0, ...(id === null ? {} : ability(id)) }) }), defender: (types) => ({ mon: monferno({ types }) }),
      move: (type) => move(500, { type, power: 10 }) },
  ];
  const realTypes = [...TYPE_IDS.values()].filter((id) => id !== MYSTERY && id < 18);
  const defenderTypes = realTypes.flatMap((t1) => realTypes.filter((t2) => t2 >= t1).map((t2): [number, number] => [t1, t2]));

  // Tinted Lens (alone and on a Foresight target) and Scrappy walk the Ghost immunities after 0xFE and their exceptions.
  it.each([
    { name: 'plain', id: null, foresight: false }, { name: 'Tinted Lens', id: TINTED_LENS, foresight: false },
    { name: 'Tinted Lens on a Foresight target', id: TINTED_LENS, foresight: true }, { name: 'Scrappy', id: SCRAPPY, foresight: false },
  ])('every attacking type on every one- and two-type defender matches the reference: $name', ({ id, foresight }) => {
    const opts = { tintedLens: id === TINTED_LENS, ghostRevealed: foresight || id === SCRAPPY };
    const mismatches: string[] = [];
    for (const setup of setups) {
      const attacker = setup.attacker(id);
      const defender = (types: [number, number]): CalcSide => ({ ...setup.defender(types), ...(foresight && { foresight: true }) });
      for (let moveType = 0; moveType < 18; moveType++) {
        const hit = setup.move(moveType);
        // A "???" move has no chart rows, so a Normal defender is neutral to it.
        const neutral = damage(attacker, defender(moveType === MYSTERY ? [NORMAL, NORMAL] : [MYSTERY, MYSTERY]), hit, {})!;
        for (const types of defenderTypes) {
          const ours = damage(attacker, defender(types), hit, {})!;
          const step = (rolls: number[]) => rolls.map((roll) => cartridgeTypeStep(roll, moveType, types, opts));
          if (JSON.stringify([ours.rolls, ours.critRolls]) !== JSON.stringify([step(neutral.rolls), step(neutral.critRolls)])) {
            mismatches.push(`${setup.name}: ${TYPE_LABELS[moveType]} vs ${TYPE_LABELS[types[0]]}/${TYPE_LABELS[types[1]]}`);
          }
        }
      }
    }
    expect(defenderTypes).toHaveLength(153);
    expect(mismatches).toEqual([]);
  }, 30_000);

  it('keeps the defender\'s own types for everything else: a Rock defender\'s Sp. Def boost in sand', () => {
    // Water on Rock/Grass doubles and halves, so its type step is recomputed; in sand the Rock still gets x1.5 Sp. Def.
    const surf = move(57, { name: 'Surf', type: 11, category: 'special', power: 95, calc: { baseMove: 'Surf' } });
    const rockGrass = { mon: zigzagoon({ item: 0, types: [5, 12] }) };
    expect(damage({ mon: monferno() }, rockGrass, surf, { weather: 'sand' })!.max).toBeLessThan(damage({ mon: monferno() }, rockGrass, surf, {})!.max);
  });

  it('lifts the Flying immunity under Gravity or a held Iron Ball, unless Klutz (`BasicTypeMulApplies`, 2529-2552)', () => {
    // A Tinted Lens 10-power Ground hit on a Flying/Bug Monferno: the Bug row keeps a 1 at 1 and Tinted Lens doubles it.
    const mudSlap = move(502, { type: GROUND, power: 10 });
    const tinted = { mon: zigzagoon({ item: 0, ...ability(TINTED_LENS) }) };
    const flyingBug = (fields: Parameters<typeof monferno>[0] = {}): CalcSide => ({ mon: monferno({ types: [FLYING, BUG], ...fields }) });
    const neutral = damage(tinted, { mon: monferno({ types: [MYSTERY, MYSTERY] }) }, mudSlap, { gravity: true })!.rolls;
    expect(neutral).toContain(1);
    const grounded = neutral.map((roll) => 2 * cartridgeTypeStep(roll, GROUND, [BUG, BUG]));
    expect(damage(tinted, flyingBug(), mudSlap, { gravity: true })?.rolls).toEqual(grounded);
    expect(damage(tinted, flyingBug({ item: IRON_BALL }), mudSlap, {})?.rolls).toEqual(grounded);
    expect(damage(tinted, flyingBug(), mudSlap, {})?.rolls).toEqual(Array(16).fill(0));
    expect(damage(tinted, flyingBug({ item: IRON_BALL, ...ability(KLUTZ) }), mudSlap, {})?.rolls).toEqual(Array(16).fill(0));
  });
});
