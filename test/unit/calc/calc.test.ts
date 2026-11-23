import { describe, expect, it } from 'vitest';
import type { KaizoMove } from '../../../src/battle/moves.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import { type CalcSide, damage, type DamageResult, moveFlags } from '../../../src/calc/calc.js';
import { type CalcField, fieldFromNote } from '../../../src/calc/field.js';
import { EMBER, FISSURE, GROWL, monferno, move, PSYWAVE, TACKLE, zigzagoon } from '../../fixtures/battleMons.js';
import { stats } from '../../fixtures/loadedData.js';

// Ability and item IDs (Gen 4 nums, as the ROM stores them). Item 300's fling power of 0 is made up.
const [BATTLE_ARMOR, STURDY, CLOUD_NINE, SOUNDPROOF, SHELL_ARMOR, IRON_FIST, SKILL_LINK, TECHNICIAN, KLUTZ, MOLD_BREAKER, MULTITYPE] =
  [4, 5, 13, 43, 75, 89, 92, 101, 103, 104, 121];
const [NUGGET, GRISEOUS_ORB, HARD_STONE, FLAME_PLATE, SPLASH_PLATE, NO_POWER, SKY_PLATE, TOWN_MAP, BICYCLE] = [92, 112, 238, 298, 299, 300, 306, 442, 450];

const ability = (value: number) => ({ ability: { value, source: 'rom' as const, disputed: false, alternatives: [] } });
const side = (mon: PlayerMon | ResolvedMon, fields: Omit<CalcSide, 'mon'> = {}): CalcSide => ({ mon, ...fields });
const fill = (roll: number) => Array<number>(16).fill(roll);
const ko = (...chances: number[]) => chances.map((chance, i) => ({ hits: i + 1, chance }));
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

/** `damage`, checking every result's koExact: koChance's uses, each a reduced fraction equal to that use's chance. */
function calc(attacker: CalcSide, defender: CalcSide, used: KaizoMove, field: CalcField = {}, opts?: { crit?: boolean }) {
  const result = damage(attacker, defender, used, field, opts);
  expect(result?.koExact?.map((entry) => entry.hits)).toEqual(result?.koChance?.map((entry) => entry.hits));
  result?.koExact?.forEach(({ count, total }, i) => {
    expect(total >= 1n && count >= 0n && count <= total && gcd(count, total) === 1n).toBe(true);
    expect(Number(count) / Number(total)).toBe(result.koChance![i]!.chance);
  });
  return result;
}

const MF = monferno();
const ZIG = zigzagoon();
const BARE = zigzagoon({ item: 0 }); // no Silk Scarf
const BULKY = zigzagoon({ baseStats: stats(150, 30, 41, 30, 41, 60) }); // 31 HP; the same Sp. Def, so the same rolls
const BULKIER_STATS = stats(300, 30, 41, 30, 41, 60);
const BULKIER = zigzagoon({ baseStats: BULKIER_STATS }); // 46 HP
const DAMAGED = monferno({ currentHp: 10, status: { kind: 'burn' } }); // the save's 10 of 44 HP, burned
const UNBURNED = monferno({ currentHp: 10 });
const SKILL_LINKER = zigzagoon({ item: 0, ...ability(SKILL_LINK) });
const TECH_SKY = monferno({ ...ability(TECHNICIAN), item: SKY_PLATE });
const RAIN: CalcField = { weather: 'rain' };

// The ROM's moves, as `buildMoves` makes them.
const SEISMIC_TOSS = move(69, { name: 'Seismic Toss', type: 1, power: 1, flags: 179, romEffect: 87, calc: { baseMove: 'Seismic Toss', fixedDamage: 'level' } });
const SUPER_FANG = move(162, { name: 'Super Fang', type: 17, power: 1, flags: 83, romEffect: 40, calc: { baseMove: 'Super Fang', fixedDamage: 'half-hp' } });
const DRAGON_RAGE = move(82, { name: 'Dragon Rage', type: 16, category: 'special', power: 1, flags: 50, romEffect: 41, calc: { baseMove: 'Dragon Rage', fixedDamage: 40 } });
const ENDEAVOR = move(283, { name: 'Endeavor', type: 9, power: 1, flags: 115, romEffect: 189, calc: { baseMove: 'Endeavor', fixedDamage: 'endeavor' } });
const WATER_BALL = move(4, { name: 'Water Ball', type: 11, category: 'special', power: 100, flags: 114, calc: { baseMove: 'Swift' } });
const HIDDEN_POWER = move(237, { name: 'Hidden Power', category: 'special', power: 1, flags: 50, romEffect: 135, calc: { baseMove: 'Hidden Power' } });
const COUNTER_TEXT = '2x last amount of damage received';
const COUNTER = move(68, { name: 'Counter', type: 1, power: 1, priority: -5, target: 1, flags: 1, romEffect: 89, effectText: COUNTER_TEXT, calc: { baseMove: 'Counter' }, unmodelled: COUNTER_TEXT });
const GUILLOTINE = move(12, { name: 'Guillotine', power: 1, accuracy: 30, flags: 19, romEffect: 38, effectText: 'OHKO', calc: { baseMove: 'Guillotine' }, unmodelled: 'OHKO' });
const AERIAL_ACE = move(332, { name: 'Aerial Ace', type: 2, power: 60, calc: { baseMove: 'Aerial Ace' } });
const JUDGMENT = move(449, { name: 'Judgment', category: 'special', power: 100, calc: { baseMove: 'Judgment' } });
const WEATHER_BALL = move(311, { name: 'Weather Ball', category: 'special', power: 50, calc: { baseMove: 'Weather Ball' } });
const HYPER_VOICE = move(304, { category: 'special', power: 90, target: 4, flags: 50, calc: { baseMove: 'Hyper Voice' } });
const ICE_PUNCH_BASE = move(470, { type: 15, power: 75, calc: { baseMove: 'Ice Punch' } });
const MEMENTO = move(262, { name: 'Memento', type: 17, category: 'special', power: 255, calc: { baseMove: 'Explosion' } });
const SELF_DESTRUCT = move(120, { name: 'Selfdestruct', power: 200, calc: { baseMove: 'Self-Destruct' } });
const FURY = move(31, { power: 250, calc: { baseMove: 'Tackle', hits: [2, 5] } }); // on Monferno: 10 (4/16), 12 (11/16) or 13 a hit
// Fling's power is the held item's in the ROM's item data, as the cartridge reads it (`Battler_ItemFlingPower`).
const ROM_POWERS: Record<number, number> = { 0: 0, [NUGGET]: 250, [BICYCLE]: 150, [HARD_STONE]: 100, [TOWN_MAP]: 120, [NO_POWER]: 0 };
const FLING = move(374, { name: 'Fling', type: 17, power: 1, flags: 18, romEffect: 233, calc: { baseMove: 'Fling', flingPower: Array.from({ length: 468 }, (_, item) => ROM_POWERS[item] ?? 30) } });

const onZig = (attacker: PlayerMon, used: KaizoMove, field: CalcField = {}) => calc(side(attacker), side(ZIG), used, field);
const fling = (item: number, fields: Partial<ResolvedMon> = {}, used = FLING) => calc(side(zigzagoon({ item, ...fields })), side(MF), used);
const darkHit = (power: number) => calc(side(BARE), side(MF), move(500, { type: 17, power }));

const EMBER_ROLLS = [22, 22, 22, 22, 24, 24, 24, 24, 24, 24, 25, 25, 25, 25, 25, 27];
const EMBER_CRITS = [45, 45, 46, 46, 48, 48, 48, 49, 49, 49, 51, 51, 51, 52, 52, 54];
const [SURE, NEVER] = [ko(1, 1, 1, 1), ko(0, 0, 0, 0)];
type Pair = [name: string, a: () => DamageResult | null, b: () => DamageResult | null];

describe('damage', () => {
  it.each<[string, () => DamageResult | null, Record<string, unknown>]>([
    ['Monferno Ember on Zigzagoon: Smogon\'s rolls for the same inputs', () => onZig(MF, EMBER), {
      rolls: EMBER_ROLLS, critRolls: EMBER_CRITS, min: 22, max: 27, percent: [110, 135], koChance: SURE, unmodelled: null, bounded: true,
      desc: expect.stringContaining('Monferno Ember vs. Zigzagoon: 22-27 (110 - 135%)') }],
    ['rain halves Ember: base 16 to 8, + 2, then STAB', () => onZig(MF, EMBER, RAIN), { rolls: [12, 12, 12, 12, 12, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 15] }],
    ['Seismic Toss deals the level, crit or not', () => onZig(MF, SEISMIC_TOSS), { rolls: fill(15), critRolls: fill(15), min: 15, max: 15, bounded: true }],
    ['Dragon Rage deals 40', () => onZig(MF, DRAGON_RAGE), { rolls: fill(40) }],
    ['Super Fang halves the current HP each use, so 44 HP never falls (22, 11, 6, 3)', () => calc(side(ZIG), side(MF), SUPER_FANG), { rolls: fill(22), koChance: NEVER }],
    ['Super Fang KOs at 1 HP', () => calc(side(ZIG), side(MF, { curHp: 1 }), SUPER_FANG), { rolls: fill(1), koChance: SURE }],
    ['Endeavor brings the target down to the user\'s HP, and never KOs', () => calc(side(ZIG, { curHp: 10 }), side(MF), ENDEAVOR), { rolls: fill(34), koChance: NEVER }],
    ['Endeavor at equal HP deals 0', () => calc(side(ZIG, { curHp: 10 }), side(MF, { curHp: 10 }), ENDEAVOR), { rolls: fill(0) }],
    // floor(15 × x / 10) for x = 5..15, slot i holding x = 5 + floor(i × 11 / 16); two uses fall short in 15 of 121 pairs.
    ['Psywave: the cartridge\'s 11 values over 16 slots, and KO odds over the 11', () => calc(side(MF), side(BULKY, { curHp: 22 }), PSYWAVE), {
      rolls: [7, 7, 9, 10, 10, 12, 13, 13, 15, 16, 16, 18, 19, 19, 21, 22], min: 7, max: 22, koChance: ko(1 / 11, 106 / 121, 1330 / 1331, 1),
      desc: expect.stringContaining('7, 9, 10, 12, 13, 15, 16, 18, 19, 21, 22') }],
    ['fixed damage respects type immunity: Seismic Toss on a Ghost', () => calc(side(MF), side(zigzagoon({ types: [7, 3] })), SEISMIC_TOSS), { rolls: fill(0), koChance: NEVER }],
    ['a defender at exactly the max roll: 1/16 on one hit', () => calc(side(MF), side(BULKY, { curHp: 27 }), EMBER), { max: 27, koChance: ko(1 / 16, 1, 1, 1) }],
    ['the five 25s and the 27 KO 25 HP: exactly 3/8', () => calc(side(MF), side(BULKY, { curHp: 25 }), EMBER), {
      koExact: [{ hits: 1, count: 3n, total: 8n }, ...[2, 3, 4].map((hits) => ({ hits, count: 1n, total: 1n }))] }],
    ['two hits KO 46 HP in 240 of 256 pairs (only 22 + 22 falls short)', () => calc(side(MF), side(BULKIER), EMBER), { koChance: ko(0, 15 / 16, 1, 1) }],
    ['an unmodelled, unbounded move (Counter) has no KO chance, never "no KO", and a "?" range', () => calc(side(ZIG), side(MF), COUNTER), {
      koChance: null, koExact: null, bounded: false, unmodelled: COUNTER_TEXT, desc: `Zigzagoon Counter vs. Monferno: ? [unmodelled: ${COUNTER_TEXT}]` }],
    ['an unmapped effect is passed through', () => onZig(MF, { ...WATER_BALL, unmodelled: 'Power doubles' }), { unmodelled: 'Power doubles' }],
    ['Hidden Power names the type and power from the IVs', () => onZig(MF, HIDDEN_POWER), { desc: expect.stringContaining('Steel 61') }],
    // An OHKO move KOs if it hits (its accuracy is in hitChance) and it can affect the target; it deals the target's HP.
    ['Guillotine deals the target\'s HP, and KOs', () => calc(side(MF), side(ZIG, { curHp: 7 }), GUILLOTINE), {
      rolls: fill(7), min: 7, max: 7, koChance: SURE, ohko: true, bounded: true, unmodelled: 'OHKO' }],
    ['Fissure KOs a target of its own level', () => calc(side(MF), side(zigzagoon({ level: 15 })), FISSURE), { koChance: SURE }],
    ['Fissure KOs a lower-level target', () => onZig(MF, FISSURE), { koChance: SURE }],
    ['an OHKO move found by its effect text alone', () => onZig(MF, { ...FISSURE, romEffect: 0 }), { koChance: SURE, ohko: true }],
    ['an OHKO move cannot KO a higher-level target', () => calc(side(MF), side(zigzagoon({ level: 16 })), FISSURE), { koChance: NEVER }],
    ['an OHKO move cannot KO through Sturdy', () => calc(side(MF), side(zigzagoon(ability(STURDY))), GUILLOTINE), { koChance: NEVER }],
    ['an OHKO move from a lower level cannot KO', () => calc(side(ZIG), side(MF), GUILLOTINE), { koChance: NEVER }],
    ['an OHKO move into a type immunity deals 0', () => calc(side(MF), side(zigzagoon({ types: [7, 7] })), GUILLOTINE), { koChance: NEVER, max: 0 }],
    ['2-5 hits follow the cartridge\'s 3/8, 3/8, 1/8, 1/8: only 4 or 5 hits KO 40 HP', () => calc(side(BARE), side(MF, { curHp: 40 }), FURY), {
      rolls: [10, 10, 10, 10, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 13], min: 20, max: 65, koChance: ko(1 / 4, 1, 1, 1) }],
    ['2-5 hits KO 30 HP in 3 hits or more', () => calc(side(BARE), side(MF, { curHp: 30 }), FURY), { koChance: ko(5 / 8, 1, 1, 1) }],
    ['Skill Link always hits 5 times', () => calc(side(SKILL_LINKER), side(MF, { curHp: 40 }), FURY), { min: 50, max: 65, koChance: SURE }],
    ['KO odds are exact, not float sums: 4 uses of Skill Link (10-13 a hit) on 200 HP give exactly 1', () =>
      calc(side(SKILL_LINKER), side(monferno({ level: 30, baseStats: stats(255, 78, 22, 78, 52, 81), evs: stats(252, 0, 0, 0, 0, 0) }), { curHp: 200 }), FURY),
    { koChance: ko(0, 0, 0, 1) }],
    ['a 2-hit move sums both hits\' rolls', () => calc(side(BARE), side(MF, { curHp: 26 }), { ...FURY, calc: { baseMove: 'Tackle', hits: 2 } }), {
      min: 20, max: 26, koChance: ko(1 / 256, 1, 1, 1) }],
    ['a crit: min, max, percent and KO chance over the crit rolls; the rolls stay', () => calc(side(MF), side(BULKIER), EMBER, {}, { crit: true }), {
      rolls: EMBER_ROLLS, critRolls: EMBER_CRITS, min: 45, max: 54, percent: [97.8, 117.3], koChance: ko(7 / 8, 1, 1, 1),
      desc: 'Monferno Ember (crit) vs. Zigzagoon: 45-54 (97.8 - 117.3%)' }],
    ['a crit makes every hit of every use a crit: 2-5 hits always KO 44 HP', () => calc(side(BARE), side(MF), FURY, {}, { crit: true }), {
      critRolls: [22, 22, 22, 22, 24, 24, 24, 24, 24, 24, 25, 25, 25, 25, 25, 27], min: 44, max: 135, koChance: SURE, desc: expect.stringContaining('(crit)') }],
    ['Mold Breaker crits through Battle Armor', () =>
      calc(side(monferno(ability(MOLD_BREAKER))), side(zigzagoon({ baseStats: BULKIER_STATS, ...ability(BATTLE_ARMOR) })), EMBER, {}, { crit: true }),
    { min: 45, desc: expect.stringContaining('Monferno Ember (crit) vs. Zigzagoon') }],
    ['Soundproof blocks Hyper Voice\'s move ID', () => calc(side(MF), side(zigzagoon(ability(SOUNDPROOF))), HYPER_VOICE), { rolls: fill(0) }],
    // The hack's Plates have power 50: x(100 + 50) / 100 after Technician. The rolls are PKCalc's for the same inputs.
    ['a Flame Plate boosts Fire 1.5x', () => onZig(monferno({ item: FLAME_PLATE }), EMBER), { rolls: [33, 33, 33, 33, 34, 34, 34, 34, 36, 36, 36, 36, 37, 37, 37, 39] }],
    ['Technician then a Sky Plate: Aerial Ace 60, 90, 135', () => onZig(TECH_SKY, AERIAL_ACE), { rolls: [66, 67, 67, 68, 69, 70, 70, 71, 72, 73, 74, 74, 75, 76, 77, 78] }],
    ['Judgment takes a Flame Plate\'s type and 1.5x', () => calc(side(monferno({ item: FLAME_PLATE })), side(BARE), JUDGMENT), {
      rolls: [81, 82, 82, 84, 84, 85, 87, 87, 88, 90, 90, 91, 93, 93, 94, 96] }],
    ['Fling of a Nugget is modelled and bounded, with KO chances', () => fling(NUGGET), {
      unmodelled: null, bounded: true, koChance: expect.any(Array), desc: expect.not.stringMatching(/maximum|unmodelled/) }],
    ['Fling with no item fails, as in the game', () => fling(0), { rolls: fill(0), unmodelled: null, bounded: true }],
    ['Fling of an item of fling power 0 fails', () => fling(NO_POWER), { rolls: fill(0), unmodelled: null, bounded: true }],
    ['Fling of a Griseous Orb fails (effect_script_0233.s)', () => fling(GRISEOUS_ORB), { rolls: fill(0) }],
    ['Fling by a Multitype user fails', () => fling(HARD_STONE, ability(MULTITYPE)), { rolls: fill(0) }],
    ['Fling of an item past the ROM\'s table is unmodelled and unbounded', () => fling(500), {
      unmodelled: 'Fling: item 500 has no fling power in the ROM\'s item data', bounded: false, koChance: null }],
    ['Fling with no item table is unmodelled and unbounded, not a worst case', () => fling(TOWN_MAP, {}, { ...FLING, calc: { baseMove: 'Fling' } }), {
      unmodelled: 'Fling: no item data for the held item\'s fling power', bounded: false, koChance: null, ohko: false }],
    // The Explosion effect halves physical Defense only (battle_lib.c:6943-6945); PKCalc gives the same rolls.
    ['the special Memento hits full Special Defense', () => calc(side(BARE), side(MF), MEMENTO), { rolls: [...fill(4).slice(1), 5] }],
  ])('%s', (_, run, expected) => expect(run()).toMatchObject(expected));

  it.each<Pair>([
    ['Blaze stays off at the default full HP, though the save has 10 of 44', () => onZig(UNBURNED, EMBER), () => onZig(MF, EMBER)],
    ['Hidden Power: Monferno\'s IVs give Steel 61', () => onZig(MF, HIDDEN_POWER), () => onZig(MF, move(500, { type: 8, category: 'special', power: 61, calc: { baseMove: 'Swift' } }))],
    ['a single-target move gets no spread reduction in doubles', () => onZig(MF, WATER_BALL, { doubles: true }), () => onZig(MF, WATER_BALL)],
    ['a single ROM type replaces Smogon\'s two: a Normal Geodude', () => calc(side(MF), side(zigzagoon({ species: 74, name: 'Geodude' })), WATER_BALL), () => onZig(MF, WATER_BALL)],
    ['Iron Fist boosts Water Ball, in Comet Punch\'s ID slot', () => onZig(monferno(ability(IRON_FIST)), WATER_BALL), () => onZig(MF, { ...WATER_BALL, power: 120 })],
    ['Iron Fist ignores a punch base move under another ID', () => onZig(monferno(ability(IRON_FIST)), ICE_PUNCH_BASE), () => onZig(MF, ICE_PUNCH_BASE)],
    ['Soundproof ignores a sound base move under another ID', () => calc(side(MF), side(zigzagoon(ability(SOUNDPROOF))), { ...HYPER_VOICE, id: 470 }),
      () => onZig(MF, { ...HYPER_VOICE, id: 470 })],
    ['a Flame Plate is Ember at 60', () => onZig(monferno({ item: FLAME_PLATE }), EMBER), () => onZig(MF, { ...EMBER, power: 60 })],
    ['a Plate of another type does nothing', () => onZig(monferno({ item: SPLASH_PLATE }), EMBER), () => onZig(MF, EMBER)],
    ['Klutz keeps a Plate from working', () => onZig(monferno({ ...ability(KLUTZ), item: FLAME_PLATE }), EMBER), () => onZig(MF, EMBER)],
    ...([[60, 135], [40, 90], [26, 58], [70, 105]] as const).map(([power, boosted]): Pair =>
      [`Technician then a Sky Plate take Aerial Ace from ${power} to ${boosted}`, () => onZig(TECH_SKY, { ...AERIAL_ACE, power }), () => onZig(MF, { ...AERIAL_ACE, power: boosted })]),
    ['Judgment with a Flame Plate is a 150-power Ember', () => calc(side(monferno({ item: FLAME_PLATE })), side(BARE), JUDGMENT), () => calc(side(MF), side(BARE), { ...EMBER, power: 150 })],
    ['Weather Ball in rain is a doubled Water move, so a Splash Plate boosts it', () => onZig(monferno({ item: SPLASH_PLATE }), WEATHER_BALL, RAIN),
      () => onZig(MF, { ...WATER_BALL, power: 150 }, RAIN)],
    ['Cloud Nine keeps Weather Ball Normal, so a Splash Plate does nothing', () => calc(side(monferno({ item: SPLASH_PLATE })), side(zigzagoon(ability(CLOUD_NINE))), WEATHER_BALL, RAIN),
      () => calc(side(MF), side(zigzagoon(ability(CLOUD_NINE))), WEATHER_BALL, RAIN)],
    ...([[NUGGET, 250], [BICYCLE, 150], [TOWN_MAP, 120], [HARD_STONE, 100]] as const).map(([item, power]): Pair =>
      [`Fling of item ${item} is a ${power}-power Dark hit`, () => fling(item), () => darkHit(power)]),
    // Klutz only takes away a hold effect; the cartridge reads the fling power off the item itself.
    ...([[HARD_STONE, 100], [NUGGET, 250]] as const).map(([item, power]): Pair => [`Klutz does not stop Fling of item ${item}`, () => fling(item, ability(KLUTZ)), () => darkHit(power)]),
    ['the special Memento on an Explosion base is a plain special hit', () => calc(side(BARE), side(MF), MEMENTO), () => calc(side(BARE), side(MF), { ...MEMENTO, calc: { baseMove: 'Swift' } })],
  ])('the same rolls: %s', (_, a, b) => {
    const [x, y] = [a()!, b()!];
    expect([x.rolls, x.critRolls]).toEqual([y.rolls, y.critRolls]);
  });

  it.each<Pair>([
    ['a burned physical attacker deals half: the save\'s status counts', () => onZig(DAMAGED, TACKLE), () => onZig(MF, TACKLE)],
    ['Blaze turns on at a given 10 HP', () => onZig(MF, EMBER), () => calc(side(UNBURNED, { curHp: 10 }), side(ZIG), EMBER)],
    ['a spread move in doubles is reduced', () => onZig(MF, { ...WATER_BALL, target: 4 }, { doubles: true }), () => onZig(MF, WATER_BALL)],
    ['the Explosion effect halves physical Defense', () => calc(side(BARE), side(MF), { ...SELF_DESTRUCT, calc: { baseMove: 'Tackle' } }), () => calc(side(BARE), side(MF), SELF_DESTRUCT)],
  ])('a lower max: %s', (_, lower, higher) => expect(lower()!.max).toBeLessThan(higher()!.max));

  it('gives null for a status move', () => {
    expect(calc(side(ZIG), side(MF), GROWL)).toBeNull();
    expect(calc(side(ZIG), side(MF), move(500, { power: 0 }))).toBeNull();
  });

  it('plans a damaged party Pokémon at full HP unless curHp says otherwise', () => {
    const hit = move(500, { power: 120 });
    const full = calc(side(ZIG), side(MF), hit)?.koChance;
    expect(calc(side(ZIG), side(DAMAGED), hit)?.koChance).toEqual(full);
    expect(calc(side(ZIG), side(DAMAGED, { curHp: 10 }), hit)?.koChance).not.toEqual(full);
  });

  it('changes nothing for crit off, or for an OHKO or fixed-damage move, which cannot crit', () => {
    const cases: [CalcSide, CalcSide, KaizoMove, boolean][] = [
      [side(MF), side(BULKIER), EMBER, false], [side(MF), side(ZIG, { curHp: 7 }), GUILLOTINE, true], [side(MF), side(ZIG), SEISMIC_TOSS, true],
      [side(MF), side(BULKY, { curHp: 22 }), PSYWAVE, true], [side(ZIG), side(MF, { curHp: 1 }), SUPER_FANG, true],
    ];
    for (const [attacker, defender, used, crit] of cases) expect(calc(attacker, defender, used, {}, { crit })).toEqual(calc(attacker, defender, used));
  });

  it('blocks a crit against Battle Armor or Shell Armor: the plain numbers, and desc says so', () => {
    for (const [id, name] of [[BATTLE_ARMOR, 'Battle Armor'], [SHELL_ARMOR, 'Shell Armor']] as const) {
      const defender = side(zigzagoon({ baseStats: BULKIER_STATS, ...ability(id) }));
      const plain = calc(side(MF), defender, EMBER)!;
      expect(calc(side(MF), defender, EMBER, {}, { crit: true })).toEqual({ ...plain, desc: plain.desc.replace('Ember vs.', `Ember (crit blocked by ${name}) vs.`) });
    }
  });
});

describe('moveFlags and fieldFromNote', () => {
  it('takes contact and Protect from the ROM byte, punch and sound from the cartridge\'s move-ID tables', () => {
    expect([WATER_BALL, move(33, { flags: 115 }), move(304, { flags: 50 })].map((used) => moveFlags(used))).toEqual([
      { contact: false, protect: true, punch: true, sound: false }, // Comet Punch's ID
      { contact: true, protect: true, punch: false, sound: false }, // Tackle
      { contact: false, protect: true, punch: false, sound: true }, // Hyper Voice
    ]);
  });

  it('reads weather, Trick Room, fog (accuracy only) and Gravity', () => {
    expect(fieldFromNote({ raw: 'PERMANENT RAIN, TRICK ROOM, FOG', weather: 'rain', trickRoom: true, fog: true })).toEqual({ weather: 'rain', trickRoom: true, fog: true });
    expect(fieldFromNote({ raw: 'FOG', fog: true })).toEqual({ fog: true });
    expect(fieldFromNote({ raw: 'GRAVITY', gravity: true })).toEqual({ gravity: true });
    expect(fieldFromNote(null)).toEqual({});
  });
});
