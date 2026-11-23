import { Dex } from '@pkmn/dex';
import { expect, it } from 'vitest';
import { NATURES } from '../../../src/rom/natures.js';
import { calcHp, calcStat, computeStats, natureMultipliers } from '../../../src/rom/stats.js';
import type { Stats } from '../../../src/rom/types.js';

const stats = (hp: number, atk: number, def: number, spa: number, spd: number, spe: number): Stats => ({ hp, atk, def, spa, spd, spe });
const [IMPISH, ADAMANT] = [8, 3];

it("computeStats gives the player's Monferno (L15 Impish, 0 EVs, ROM base stats) its real stats, and Shedinja 1 HP whatever its IVs, EVs and level", () => {
  // The save's party extra data stores max HP 44, and Smogon's calc gives the rest.
  expect(computeStats(stats(64, 78, 52, 78, 52, 81), stats(0, 26, 12, 10, 7, 24), stats(0, 0, 0, 0, 0, 0), 15, IMPISH)).toEqual(stats(44, 32, 24, 26, 21, 32));
  // Shedinja (292) is the ROM's only species with base HP 1.
  expect(computeStats(stats(1, 100, 5, 100, 10, 80), stats(31, 31, 31, 31, 31, 31), stats(252, 0, 0, 0, 0, 0), 100, ADAMANT).hp).toBe(1);
  expect(calcHp(1, 0, 0, 5)).toBe(1);
});

it('calcHp and calcStat count a quarter of the EVs, rounded down, and round down after the nature, as the game does in integers', () => {
  // Garchomp (base HP 108, Atk 130) at L100 with 31 IVs: the well-known 420 HP with 252 HP EVs, 394 Atk with 252 Atk EVs and a raising nature.
  expect([calcHp(108, 31, 0, 100), calcHp(108, 31, 252, 100), calcStat(130, 31, 252, 100, 1.1), calcStat(130, 31, 255, 100, 1.1)]).toEqual([357, 420, 394, 394]);
  // floor((2 * 52 + 12) * 15 / 100) + 5 = 22, and 22 * 1.1 = 24.2; 29 * 0.9 = 26.1.
  expect([calcStat(52, 12, 0, 15, 1.1), calcStat(78, 10, 0, 15, 0.9), calcStat(78, 26, 0, 15, 1)]).toEqual([24, 26, 32]);
});

it('natureMultipliers raises and lowers the stats @pkmn/dex gives each nature, and is 1 for every stat of a neutral one', () => {
  NATURES.forEach((name, id) => {
    const { plus, minus } = Dex.forGen(4).natures.get(name);
    const expected = stats(1, 1, 1, 1, 1, 1);
    if (plus && minus) Object.assign(expected, { [plus]: 1.1, [minus]: 0.9 });
    expect([name, natureMultipliers(id)]).toEqual([name, expected]);
  });
});

it.each([-1, 25, 1.5, Number.NaN])('natureMultipliers throws for nature %s, not 0 to 24', (nature) => expect(() => natureMultipliers(nature)).toThrow(`No nature ${nature}`));
