// The hack's Gen 4 damage, written from the decompilation alone (pret/pokeplatinum at 62bdaacdc, the clone at
// ~/src/pokeplatinum). It shares no code with Showdown or @smogon/calc, only the plan's types and `computeStats`, so it is an
// independent check on both. `bl` = src/battle/battle_lib.c,
// `bs` = src/battle/battle_script.c, `bcp` = src/battle/battle_controller_player.c.
//
// The cartridge's order for one hit, which docs/engine-model.md ('Damage order') explains and cites line by line:
//   1. `BattleSystem_CalcMoveDamage` (bl:6601-7079): the power steps, each an integer multiply then divide that floors;
//      the stat terms on the RAW stat; the stage; `A * P * (L*2/5+2) / D / 50`; burn, screens, spread, weather, Flash Fire;
//      then `+ 2`.
//   2. `BattleScript_CalcMoveDamage` (bs:1323-1366): x the critical multiplier (2, or 3 with Sniper), Life Orb, the
//      Metronome item.
//   3. The roll (`BattleSystem_CalcDamageVariance`, bl:7081-7094): `d * (100 - r) / 100` for r in 0..15, at least 1.
//   4. `BattleSystem_ApplyTypeChart` (bl:2560-2679): STAB, then the chart row by row (each row `Divide(d * mul, 10)`),
//      then Filter / Solid Rock, Expert Belt, Tinted Lens.
//   5. The resist berry (subscript_type_resist_berry.s): `Divide(d, 2)`.
// The 16 rolls come out ascending, as `damage().rolls` do: index i is the 85 + i percent roll (r = 15 - i).

import type { BattleMon } from '../battle/types.js';
import type { KaizoMove } from '../battle/moves.js';
import { computeStats } from '../rom/stats.js';
import type { Stats } from '../rom/types.js';
import type { CalcField, CalcSide } from './calc.js';

/** Thrown for a move or state whose damage this function does not derive (see `UNSUPPORTED_BASES`). */
export class Gen4DamageUnsupported extends Error {}

// ---------------------------------------------------------------------------------------------------------------------
// Constants, all from the decompilation (generated/*.txt are enumerations: a line number less one is the value).

/** ROM types (generated/pokemon_types.txt; Mystery is 9). */
const T = { normal: 0, fighting: 1, flying: 2, poison: 3, ground: 4, rock: 5, bug: 6, ghost: 7, steel: 8, fire: 10, water: 11,
  grass: 12, electric: 13, psychic: 14, ice: 15, dragon: 16, dark: 17 } as const;

/** Ability IDs (generated/abilities.txt). */
const A = { cloudNine: 13, flashFire: 18, wonderGuard: 25, levitate: 26, hugePower: 37, thickFat: 47, hustle: 55, plus: 57, minus: 58,
  guts: 62, marvelScale: 63, overgrow: 65, blaze: 66, torrent: 67, swarm: 68, purePower: 74, airLock: 76, rivalry: 79, heatproof: 85,
  simple: 86, drySkin: 87, ironFist: 89, adaptability: 91, solarPower: 94, normalize: 96, sniper: 97, technician: 101, klutz: 103,
  moldBreaker: 104, unaware: 109, tintedLens: 110, filter: 111, slowStart: 112, scrappy: 113, solidRock: 116, reckless: 120,
  flowerGift: 122 } as const;

/** Hold effects (generated/item_hold_effects.txt). */
const H = { giratinaBoost: 2, dialgaBoost: 3, palkiaBoost: 4, choiceAtk: 55, latiSpecial: 60, clamperlSpAtk: 61, clamperlSpDef: 62,
  pikaSpAtkUp: 71, dittoDefUp: 90, coneAtkUp: 91, powerUpPhys: 94, powerUpSpec: 95, powerUpSe: 96, hpDrainOnAtk: 98,
  boostRepeated: 105, speedDownGrounded: 106, choiceSpAtk: 125 } as const;

/** `sTypeBoostingItems` (bl:6516-6540): hold effect → the type it strengthens. Effects 57-86 and the Plates' 126-141. */
const TYPE_BOOST: ReadonlyMap<number, number> = new Map([
  [57, T.bug], [68, T.steel], [72, T.ground], [73, T.rock], [74, T.grass], [75, T.dark], [76, T.fighting], [77, T.electric],
  [78, T.water], [79, T.flying], [80, T.poison], [81, T.ice], [82, T.ghost], [83, T.psychic], [84, T.fire], [85, T.dragon],
  [86, T.normal], [126, T.fire], [127, T.water], [128, T.electric], [129, T.grass], [130, T.ice], [131, T.fighting],
  [132, T.poison], [133, T.ground], [134, T.flying], [135, T.psychic], [136, T.bug], [137, T.rock], [138, T.ghost],
  [139, T.dragon], [140, T.dark], [141, T.steel],
]);

/** The resist berries' effects 19-34 and the type each halves (subscript_type_resist_berry.s); 35 is Chilan's, Normal's. */
const BERRY_TYPE: ReadonlyMap<number, number> = new Map([
  [19, T.fire], [20, T.water], [21, T.electric], [22, T.grass], [23, T.ice], [24, T.fighting], [25, T.poison], [26, T.ground],
  [27, T.flying], [28, T.psychic], [29, T.bug], [30, T.rock], [31, T.ghost], [32, T.dragon], [33, T.dark], [34, T.steel],
]);
const CHILAN = 35;

/**
 * The damage-relevant held items of the hack ROM (itemtool/itemdata, bytes 2 and 3 of each entry, read 2026-11-09), by Gen
 * 4 item ID: `[hold effect, parameter]`. The hack's Plates carry 50 where vanilla has 20 (test/real/engineVsCalcItems.test.ts
 * and holdEffects check the table against the ROM). The speed-halving Iron Ball (278) is here for the Flying immunity.
 */
const ITEMS: ReadonlyMap<number, readonly [number, number]> = new Map([
  [112, [2, 20]], [135, [3, 20]], [136, [4, 20]], [220, [55, 0]], [225, [60, 0]], [226, [61, 0]], [227, [62, 0]], [236, [71, 0]],
  [257, [90, 0]], [258, [91, 0]], [266, [94, 10]], [267, [95, 10]], [268, [96, 20]], [270, [98, 30]], [277, [105, 10]],
  [278, [106, 0]], [297, [125, 0]],
  ...Array.from({ length: 17 }, (_, i): [number, readonly [number, number]] => [184 + i, [19 + i, 0]]), // the resist berries
  [222, [57, 20]], [233, [68, 20]], [237, [72, 20]], [238, [73, 20]], [239, [74, 20]], [240, [75, 20]], [241, [76, 20]],
  [242, [77, 20]], [243, [78, 20]], [244, [79, 20]], [245, [80, 20]], [246, [81, 20]], [247, [82, 20]], [248, [83, 20]],
  [249, [84, 20]], [250, [85, 20]], [251, [86, 20]], [254, [78, 20]], [314, [83, 20]], [315, [73, 20]], [317, [78, 20]],
  [318, [74, 20]], [319, [58, 10]], [320, [59, 0]],
  ...Array.from({ length: 16 }, (_, i): [number, readonly [number, number]] => [298 + i, [126 + i, 50]]), // the Plates
] as [number, readonly [number, number]][]);

/** `sStatStageBoosts` (bl:6550-6564), stage -6 to +6. */
const STAGES: readonly (readonly [number, number])[] = [[10, 40], [10, 35], [10, 30], [10, 25], [10, 20], [10, 15], [10, 10],
  [15, 10], [20, 10], [25, 10], [30, 10], [35, 10], [40, 10]];

/** `sPunchingMoves` (bl:6566-6582) by move ID: Iron Fist reads the move's ID. */
const PUNCHING = new Set([8, 7, 9, 183, 264, 146, 223, 359, 5, 4, 309, 325, 409, 418, 327]);

/** `sTypeMatchupMultipliers` (bl:2399-2517), `[attacking type, defending type, multiplier x10]`, in the chart's row order. */
export const CHART: readonly (readonly [number, number, number])[] = [
  [0, 5, 5], [0, 8, 5], [10, 10, 5], [10, 11, 5], [10, 12, 20], [10, 15, 20], [10, 6, 20], [10, 5, 5],
  [10, 16, 5], [10, 8, 20], [11, 10, 20], [11, 11, 5], [11, 12, 5], [11, 4, 20], [11, 5, 20], [11, 16, 5],
  [13, 11, 20], [13, 13, 5], [13, 12, 5], [13, 4, 0], [13, 2, 20], [13, 16, 5], [12, 10, 5], [12, 11, 20],
  [12, 12, 5], [12, 3, 5], [12, 4, 20], [12, 2, 5], [12, 6, 5], [12, 5, 20], [12, 16, 5], [12, 8, 5],
  [15, 11, 5], [15, 12, 20], [15, 15, 5], [15, 4, 20], [15, 2, 20], [15, 16, 20], [15, 8, 5], [15, 10, 5],
  [1, 0, 20], [1, 15, 20], [1, 3, 5], [1, 2, 5], [1, 14, 5], [1, 6, 5], [1, 5, 20], [1, 17, 20],
  [1, 8, 20], [3, 12, 20], [3, 3, 5], [3, 4, 5], [3, 5, 5], [3, 7, 5], [3, 8, 0], [4, 10, 20],
  [4, 13, 20], [4, 12, 5], [4, 3, 20], [4, 2, 0], [4, 6, 5], [4, 5, 20], [4, 8, 20], [2, 13, 5],
  [2, 12, 20], [2, 1, 20], [2, 6, 20], [2, 5, 5], [2, 8, 5], [14, 1, 20], [14, 3, 20], [14, 14, 5],
  [14, 17, 0], [14, 8, 5], [6, 10, 5], [6, 12, 20], [6, 1, 5], [6, 3, 5], [6, 2, 5], [6, 14, 20],
  [6, 7, 5], [6, 17, 20], [6, 8, 5], [5, 10, 20], [5, 15, 20], [5, 1, 5], [5, 4, 5], [5, 2, 20],
  [5, 6, 20], [5, 8, 5], [7, 0, 0], [7, 14, 20], [7, 17, 5], [7, 8, 5], [7, 7, 20], [16, 16, 20],
  [16, 8, 5], [17, 1, 5], [17, 14, 20], [17, 7, 20], [17, 17, 5], [17, 8, 5], [8, 10, 5], [8, 11, 5],
  [8, 13, 5], [8, 15, 20], [8, 5, 20], [8, 8, 5],
  [0xfe, 0xfe, 0], // the marker: the rows below are the Ghost immunities, which Foresight and Scrappy remove
  [0, 7, 0], [1, 7, 0],
];
const MARKER = CHART.findIndex(([attack]) => attack === 0xfe);

/** Battle effects the cartridge's formulas read by number (generated/move_battle_effects.txt): the ROM decides these, not the docs. */
const E = { hit: 0, halveDefense: 7, removeScreens: 186, flinchBurnHit: 273 } as const;
const HIDING_EFFECTS = new Map<number, CalcSide['hiding']>([[146, 'airborne'], [149, 'airborne'], [147, 'underground'], [126, 'underground'], [261, 'underwater'], [257, 'underwater'], [150, 'minimized']]);
const RECKLESS_EFFECTS = new Set([45, 48, 198, 253, 262, 269]);
/**
 * The mechanics the calc dispatches on, by the move's `calc.baseMove` (the docs' effect text decides a move's behaviour;
 * src/battle/moves.ts `MECHANICS`), whose power depends on state `CalcSide` does not carry (or on the hit number): not derived here.
 */
const UNSUPPORTED_BASES = new Set(['Triple Kick', 'Rollout', 'Ice Ball', 'Fury Cutter', 'Magnitude', 'Spit Up', 'Revenge', 'Assurance',
  'Low Kick', 'Grass Knot', 'Gyro Ball', 'Natural Gift', 'Payback', 'Fling', 'Trump Card', 'Wring Out', 'Crush Grip', 'Judgment', 'Present',
  'Beat Up', 'Psywave', 'Bide', 'Counter', 'Mirror Coat', 'Metal Burst', 'Fissure', 'Guillotine', 'Horn Drill', 'Sheer Cold', 'Future Sight', 'Doom Desire']);

/** The Explosion effect: the ROM's `BATTLE_EFFECT_HALVE_DEFENSE`, or the docs' Explosion text. */
const halvesDefense = (move: KaizoMove): boolean => move.romEffect === 7 || move.calc.baseMove === 'Explosion' || move.calc.baseMove === 'Self-Destruct';
const MOVE_STRUGGLE = 165;
const MOVE_SOLAR_BEAM = 76;
const RANGE_ADJACENT_OPPONENTS = 4;
const RANGE_ALL_ADJACENT = 8;

// ---------------------------------------------------------------------------------------------------------------------
// One battler, as the formulas read it.

interface Battler {
  mon: BattleMon; ability: number; stats: Stats; hp: number; maxHp: number; status: string; boosts: Record<string, number>;
  /** The working hold effect `[effect, parameter]`; null with no item, an item with none of the ones read, or Klutz. */
  held: readonly [number, number] | null; types: readonly [number, number]; flashFire: boolean; foresight: boolean;
  metronomeTurns: number; hiding: CalcSide['hiding'];
}

const STATUS_NAMES = ['none', 'sleep', 'poison', 'toxic', 'burn', 'freeze', 'paralysis'];

function battler(side: CalcSide): Battler {
  const { mon } = side;
  const stats = computeStats(mon.baseStats, mon.ivs, mon.evs, mon.level, mon.nature.value ?? 0);
  const maxHp = stats.hp;
  const hp = Math.min(maxHp, Math.max(0, side.curHp ?? maxHp));
  const status = side.status ?? ('status' in mon ? mon.status : { kind: 'none' as const });
  if (!STATUS_NAMES.includes(status.kind)) throw new Gen4DamageUnsupported(`status ${status.kind}`);
  const ability = mon.ability.value;
  return {
    mon, ability, stats, hp, maxHp, status: status.kind, boosts: { ...side.boosts },
    held: ability === A.klutz ? null : (ITEMS.get(mon.item) ?? null), types: mon.types, flashFire: !!side.abilityOn && ability === A.flashFire,
    foresight: !!side.foresight, metronomeTurns: Math.max(0, Math.min(10, side.metronomeTurns ?? 0)), hiding: side.hiding,
  };
}

const effectOf = (b: Battler): number => b.held?.[0] ?? -1;
const paramOf = (b: Battler): number => b.held?.[1] ?? 0;
const stage = (b: Battler, stat: string): number => Math.max(-6, Math.min(6, b.boosts[stat] ?? 0));

// ---------------------------------------------------------------------------------------------------------------------
// The move: the numbers the formulas read, with the effects that set the power or type before the formula.

interface Strike {
  id: number; effect: number; power: number; type: number; category: 'physical' | 'special'; range: number;
  /** `battleCtx->powerMul` x10 (10 is none), `inPower` (0 for the move's own power) and `inType`. */
  powerMul: number; inPower: number; inType: number | null; halves: boolean;
}

/** `BtlCmd_CalcHiddenPowerParams` (bs:6007-6040). */
function hiddenPowerOf(ivs: Stats): { power: number; type: number } {
  const bit = (iv: number, n: number) => (iv & (1 << n)) >> n;
  const p = bit(ivs.hp, 1) | (bit(ivs.atk, 1) << 1) | (bit(ivs.def, 1) << 2) | (bit(ivs.spe, 1) << 3) | (bit(ivs.spa, 1) << 4) | (bit(ivs.spd, 1) << 5);
  const t = bit(ivs.hp, 0) | (bit(ivs.atk, 0) << 1) | (bit(ivs.def, 0) << 2) | (bit(ivs.spe, 0) << 3) | (bit(ivs.spa, 0) << 4) | (bit(ivs.spd, 0) << 5);
  const type = Math.floor((t * 15) / 63) + 1;
  return { power: Math.floor((p * 40) / 63) + 30, type: type >= 9 ? type + 1 : type };
}

/** `sHPPixelsToFlailPower` (bs:4941-4948) and `App_PixelCount` (src/unk_0208C098.c:41-49) at 64 pixels. */
function flailPower(hp: number, maxHp: number): number {
  let pixels = Math.floor((hp * 64) / maxHp);
  if (pixels === 0 && hp > 0) pixels = 1;
  const table = [[1, 200], [5, 150], [12, 100], [21, 80], [42, 40], [64, 20]] as const;
  for (const [limit, power] of table) if (pixels <= limit) return power;
  return table[table.length - 1]![1] ?? 0;
}

function strike(attacker: Battler, defender: Battler, move: KaizoMove, field: CalcField): Strike {
  const base = move.calc.baseMove;
  if (UNSUPPORTED_BASES.has(base)) throw new Gen4DamageUnsupported(base);
  const s: Strike = { id: move.id, effect: move.romEffect, power: move.power, type: move.type, category: move.category === 'special' ? 'special' : 'physical',
    range: move.target, powerMul: 10, inPower: 0, inType: null, halves: halvesDefense(move) };
  if (move.category === 'status') throw new Gen4DamageUnsupported('status move');
  const weather = field.weather !== undefined || field.fog === true;
  const quiet = attacker.ability === A.cloudNine || attacker.ability === A.airLock || defender.ability === A.cloudNine || defender.ability === A.airLock;
  switch (base) {
    case 'Hidden Power': { const hp = hiddenPowerOf(attacker.mon.ivs); s.inPower = hp.power; s.inType = hp.type; break; }
    case 'Flail': case 'Reversal': s.inPower = flailPower(attacker.hp, attacker.maxHp); break;
    case 'Water Spout': case 'Eruption': s.inPower = Math.max(1, Math.floor((move.power * attacker.hp) / attacker.maxHp)); break; // bs:6645-6657
    case 'Punishment': { // bs:7354-7372: every positive stage of the target, accuracy and evasion too
      const sum = (['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const).reduce((n, stat) => n + Math.max(0, stage(defender, stat)), 0);
      s.inPower = Math.min(200, 60 + 20 * sum);
      break;
    }
    case 'Weather Ball': // bs:6843-6872
      if (!quiet && weather) {
        s.inPower = move.power * 2;
        if (field.weather === 'rain') s.inType = T.water;
        if (field.weather === 'sand') s.inType = T.rock;
        if (field.weather === 'sun') s.inType = T.fire;
        if (field.weather === 'hail') s.inType = T.ice;
      }
      break;
    case 'Facade': if (['poison', 'toxic', 'burn', 'paralysis'].includes(attacker.status)) s.powerMul = 20; break;
    case 'Brine': if (!(defender.hp > Math.floor(defender.maxHp / 2))) s.powerMul = 20; break;
    case 'Smelling Salts': case 'SmellingSalt': if (defender.status === 'paralysis') s.powerMul = 20; break;
    case 'Wake-Up Slap': if (defender.status === 'sleep') s.powerMul = 20; break;
    default:
  }
  // A move that hits a Pokémon in the state its effect looks for has twice the power from the first step (effect scripts 146, 147, 149, 150, 257, 261, 126).
  if (HIDING_EFFECTS.get(move.romEffect) === defender.hiding && defender.hiding !== undefined) s.powerMul = 20;
  if (RECKLESS_EFFECTS.has(move.romEffect) && attacker.ability === A.reckless) s.powerMul = 12;
  return s;
}

// ---------------------------------------------------------------------------------------------------------------------
// `BattleSystem_CalcMoveDamage`.

interface Context {
  attacker: Battler; defender: Battler; strike: Strike; field: CalcField; criticalMul: number;
  /** The defender's side's screens (zero for the confusion self-hit, which passes no side or field conditions). */
  reflect: boolean; lightScreen: boolean; weatherOn: boolean;
  /** `CalcSide.abilityOn` of the attacker: Slow Start still running, a Plus/Minus partner on its side. */
  attackerSlowStart: boolean; plusMinus: boolean;
}

/** `Battler_IgnorableAbility(attacker, defender, ability)`: the defender has it and the attacker has no Mold Breaker. */
const ignorable = (c: Context, ability: number): boolean => c.attacker.ability !== A.moldBreaker && c.defender.ability === ability;

function calcMoveDamage(c: Context): number {
  const { attacker, defender, strike: s, field } = c;
  let power = s.inPower === 0 ? s.power : s.inPower;
  const moveType = attacker.ability === A.normalize ? T.normal : s.inType ?? s.type;
  power = Math.floor((power * s.powerMul) / 10);
  const raw = { atk: attacker.stats.atk, def: defender.stats.def, spa: attacker.stats.spa, spd: defender.stats.spd };
  let { atk, def, spa, spd } = raw;
  let attackStage = stage(attacker, 'atk');
  let spAttackStage = stage(attacker, 'spa');
  let defenseStage = stage(defender, 'def');
  let spDefenseStage = stage(defender, 'spd');
  const species = (b: Battler) => b.mon.species;
  const atkSpecies = species(attacker);
  const defSpecies = species(defender);
  const hpBelow = attacker.hp <= Math.floor(attacker.maxHp / 3);
  const status = (b: Battler) => b.status !== 'none';
  const sunny = c.weatherOn && field.weather === 'sun';

  // Charge, Helping Hand and Mud/Water Sport (bl:6688-6700, :6811-6818) are battle state `CalcSide` does not carry.

  if (attacker.ability === A.technician && s.id !== MOVE_STRUGGLE && power <= 60) power = Math.floor((power * 15) / 10);

  if (attacker.ability === A.hugePower || attacker.ability === A.purePower) atk *= 2;
  if (attacker.ability === A.slowStart && c.attackerSlowStart) atk = Math.floor(atk / 2);

  const typeEffect = TYPE_BOOST.get(effectOf(attacker));
  if (typeEffect !== undefined && typeEffect === moveType) power = Math.floor((power * (100 + paramOf(attacker))) / 100);

  if (effectOf(attacker) === H.choiceAtk) atk = Math.floor((atk * 150) / 100);
  if (effectOf(attacker) === H.choiceSpAtk) spa = Math.floor((spa * 150) / 100);
  if (effectOf(attacker) === H.latiSpecial && (atkSpecies === 380 || atkSpecies === 381)) spa = Math.floor((spa * 150) / 100);
  if (effectOf(defender) === H.latiSpecial && (defSpecies === 380 || defSpecies === 381)) spd = Math.floor((spd * 150) / 100);
  if (effectOf(attacker) === H.clamperlSpAtk && atkSpecies === 366) spa *= 2;
  if (effectOf(defender) === H.clamperlSpDef && defSpecies === 366) spd *= 2;
  if (effectOf(attacker) === H.pikaSpAtkUp && atkSpecies === 25) power *= 2;
  if (effectOf(defender) === H.dittoDefUp && defSpecies === 132) def *= 2;
  if (effectOf(attacker) === H.coneAtkUp && (atkSpecies === 104 || atkSpecies === 105)) atk *= 2;
  const orb = (effect: number, species: number, types: number[]) => {
    if (effectOf(attacker) === effect && types.includes(moveType) && atkSpecies === species) power = Math.floor((power * (100 + paramOf(attacker))) / 100);
  };
  orb(H.dialgaBoost, 483, [T.dragon, T.steel]);
  orb(H.palkiaBoost, 484, [T.dragon, T.water]);
  orb(H.giratinaBoost, 487, [T.dragon, T.ghost]);
  if (effectOf(attacker) === H.powerUpPhys && s.category === 'physical') power = Math.floor((power * (100 + paramOf(attacker))) / 100);
  if (effectOf(attacker) === H.powerUpSpec && s.category === 'special') power = Math.floor((power * (100 + paramOf(attacker))) / 100);

  if (ignorable(c, A.thickFat) && (moveType === T.fire || moveType === T.ice)) power = Math.floor(power / 2);

  if (attacker.ability === A.hustle) atk = Math.floor((atk * 150) / 100);
  if (attacker.ability === A.guts && status(attacker)) atk = Math.floor((atk * 150) / 100);
  if (ignorable(c, A.marvelScale) && status(defender)) def = Math.floor((def * 150) / 100);
  if (c.plusMinus && attacker.ability === A.plus) spa = Math.floor((spa * 150) / 100);
  if (c.plusMinus && attacker.ability === A.minus) spa = Math.floor((spa * 150) / 100);

  const pinch = (ability: number, type: number) => {
    if (moveType === type && attacker.ability === ability && hpBelow) power = Math.floor((power * 150) / 100);
  };
  pinch(A.overgrow, T.grass);
  pinch(A.blaze, T.fire);
  pinch(A.torrent, T.water);
  pinch(A.swarm, T.bug);

  if (moveType === T.fire && ignorable(c, A.heatproof)) power = Math.floor(power / 2);
  if (moveType === T.fire && ignorable(c, A.drySkin)) power = Math.floor((power * 125) / 100);

  const clamp = (n: number) => Math.max(-6, Math.min(6, n));
  if (attacker.ability === A.simple) {
    attackStage = clamp(attackStage * 2);
    spAttackStage = clamp(spAttackStage * 2);
  }
  if (ignorable(c, A.simple)) {
    defenseStage = clamp(defenseStage * 2);
    spDefenseStage = clamp(spDefenseStage * 2);
  }
  if (ignorable(c, A.unaware)) {
    attackStage = 0;
    spAttackStage = 0;
  }
  if (attacker.ability === A.unaware) {
    defenseStage = 0;
    spDefenseStage = 0;
  }

  const male = (b: Battler) => b.mon.gender;
  if (attacker.ability === A.rivalry && male(attacker) !== null && male(defender) !== null) {
    power = Math.floor((power * (male(attacker) === male(defender) ? 125 : 75)) / 100);
  }
  if (attacker.ability === A.ironFist && PUNCHING.has(s.id)) power = Math.floor((power * 12) / 10);

  if (c.weatherOn) {
    if (sunny && attacker.ability === A.solarPower) spa = Math.floor((spa * 15) / 10);
    if (field.weather === 'sand' && (defender.types[0] === T.rock || defender.types[1] === T.rock)) spd = Math.floor((spd * 15) / 10);
    // `BattleSystem_CountAbility(.., COUNT_ALIVE_BATTLERS_OUR_SIDE, attacker, FLOWER_GIFT)` counts the battler itself.
    if (sunny && attacker.ability === A.flowerGift) atk = Math.floor((atk * 15) / 10);
    if (sunny && attacker.ability !== A.moldBreaker && defender.ability === A.flowerGift) spd = Math.floor((spd * 15) / 10);
  }

  if (s.halves) def = Math.floor(def / 2);

  const crit = c.criticalMul > 1;
  const staged = (value: number, st: number, keep: (st: number) => boolean) => {
    if (!keep(st)) return value;
    return Math.floor((value * STAGES[st + 6]![0]) / STAGES[st + 6]![1]);
  };
  const level = attacker.mon.level;
  const physical = s.category === 'physical';
  let damage = staged(physical ? atk : spa, physical ? attackStage : spAttackStage, (st) => !crit || st > 0);
  damage *= power;
  damage *= Math.floor((level * 2) / 5) + 2;
  const divisor = staged(physical ? def : spd, physical ? defenseStage : spDefenseStage, (st) => !crit || st < 0);
  damage = Math.floor(damage / Math.max(1, divisor));
  damage = Math.floor(damage / 50);

  if (physical && attacker.status === 'burn' && attacker.ability !== A.guts) damage = Math.floor(damage / 2);
  const screened = physical ? c.reflect : c.lightScreen;
  if (screened && !crit && s.effect !== E.removeScreens) damage = field.doubles ? Math.floor((damage * 2) / 3) : Math.floor(damage / 2);

  if (field.doubles && s.range === RANGE_ADJACENT_OPPONENTS) damage = Math.floor((damage * 3) / 4);
  if (field.doubles && s.range === RANGE_ALL_ADJACENT) damage = Math.floor((damage * 3) / 4);

  if (c.weatherOn) {
    if (field.weather === 'rain') {
      if (moveType === T.fire) damage = Math.floor(damage / 2);
      if (moveType === T.water) damage = Math.floor((damage * 15) / 10);
    }
    if ((field.weather === 'rain' || field.weather === 'sand' || field.weather === 'hail' || field.fog) && s.id === MOVE_SOLAR_BEAM) damage = Math.floor(damage / 2);
    if (sunny) {
      if (moveType === T.fire) damage = Math.floor((damage * 15) / 10);
      if (moveType === T.water) damage = Math.floor(damage / 2);
    }
  }
  if (attacker.flashFire && moveType === T.fire) damage = Math.floor((damage * 15) / 10);
  return damage + 2;
}

// ---------------------------------------------------------------------------------------------------------------------
// The type step, `BattleSystem_ApplyTypeChart` (bl:2560-2679), and the resist berry.

/** `BattleSystem_Divide` (bl:3599-3619): the quotient truncated, but never 0 from a nonzero dividend. */
const divide = (dividend: number, divisor: number): number => (dividend === 0 ? 0 : Math.max(1, Math.floor(dividend / divisor)));

interface TypeStep { damage: number; superEffective: boolean; notVeryEffective: boolean; none: boolean }

/** What changes the chart walk (bl:2529-2558, :2612-2621). */
export interface ChartRules { ghostRevealed: boolean; groundedFlying: boolean; roosting: boolean; miracleEye: boolean }

/**
 * The multipliers x10 the walk of `sTypeMatchupMultipliers` applies for a move of `moveType` against a defender of
 * `defenderTypes`, in the chart's row order: every row for the move's type whose defending type is the defender's first
 * type, or its second when that differs (bl:2610-2640), skipping the rows `BasicTypeMulApplies` (bl:2529-2558) turns off,
 * and the Ghost rows after the marker when `ghostRevealed` (Foresight, Scrappy).
 */
export function typeMultipliers(moveType: number, defenderTypes: readonly [number, number], rules: ChartRules): number[] {
  const rows = rules.ghostRevealed ? CHART.slice(0, MARKER) : [...CHART.slice(0, MARKER), ...CHART.slice(MARKER + 1)];
  const out: number[] = [];
  for (const [attackType, defendType, multiplier] of rows) {
    if (attackType !== moveType) continue;
    if (rules.groundedFlying && defendType === T.flying && multiplier === 0) continue;
    if (rules.roosting && defendType === T.flying) continue;
    if (rules.miracleEye && defendType === T.dark && multiplier === 0) continue;
    const matches = (defenderTypes[0] === defendType ? 1 : 0) + (defenderTypes[1] === defendType && defenderTypes[0] !== defenderTypes[1] ? 1 : 0);
    for (let i = 0; i < matches; i++) out.push(multiplier);
  }
  return out;
}

/**
 * The type step on `damage`. `none` is a damage of 0 whatever came in: a type immunity, Levitate, Wonder Guard. The
 * super-effective and not-very-effective flags cancel each other as the cartridge's do (`ApplyTypeMultiplier`,
 * bl:7557-7575), so Ice Beam on a Fire/Flying target is neither.
 */
function typeStep(c: Context, damage: number, moveType: number): TypeStep {
  const { attacker, defender, strike: s, field } = c;
  let d = damage;
  if (s.id === MOVE_STRUGGLE) return { damage: d, superEffective: false, notVeryEffective: false, none: false };
  if (attacker.types[0] === moveType || attacker.types[1] === moveType) d = attacker.ability === A.adaptability ? d * 2 : Math.floor((d * 15) / 10);
  let superEffective = false;
  let notVeryEffective = false;
  let none = false;
  if (ignorable(c, A.levitate) && moveType === T.ground && effectOf(defender) !== H.speedDownGrounded) {
    none = true;
  } else {
    const multipliers = typeMultipliers(moveType, defender.types, {
      ghostRevealed: defender.foresight || attacker.ability === A.scrappy,
      groundedFlying: !!field.gravity || effectOf(defender) === H.speedDownGrounded, roosting: false, miracleEye: false,
    });
    for (const multiplier of multipliers) {
      d = divide(d * multiplier, 10);
      if (multiplier === 0) {
        none = true;
        superEffective = false;
        notVeryEffective = false;
      } else if (multiplier === 5) {
        if (superEffective) superEffective = false;
        else notVeryEffective = true;
      } else if (notVeryEffective) {
        notVeryEffective = false;
      } else {
        superEffective = true;
      }
    }
  }
  // Wonder Guard (bl:2640-2644, :7588-7605): Fire Fang's effect always passes it (a recorded bug of the cartridge).
  const onDamagingTurn = s.effect !== E.flinchBurnHit;
  if (ignorable(c, A.wonderGuard) && onDamagingTurn && !superEffective && s.power !== 0) {
    none = true;
  } else if (superEffective && s.power !== 0) {
    if (ignorable(c, A.filter) || ignorable(c, A.solidRock)) d = divide(d * 3, 4);
    if (effectOf(attacker) === H.powerUpSe) d = Math.floor((d * (100 + paramOf(attacker))) / 100);
  } else if (notVeryEffective && s.power !== 0 && attacker.ability === A.tintedLens) {
    d *= 2;
  }
  return { damage: none ? 0 : d, superEffective, notVeryEffective, none };
}

/** The resist berry (subscript_type_resist_berry.s): super effective hits of its type, or Normal hits for Chilan's. */
function berryHalves(defender: Battler, moveType: number, step: TypeStep): boolean {
  const effect = effectOf(defender);
  if (effect === CHILAN) return moveType === T.normal;
  return step.superEffective && BERRY_TYPE.get(effect) === moveType;
}

// ---------------------------------------------------------------------------------------------------------------------

function context(attacker: CalcSide, defender: CalcSide, move: KaizoMove, field: CalcField, criticalMul: number, selfHit = false): { c: Context; moveType: number } {
  const a = battler(attacker);
  const d = selfHit ? a : battler(defender);
  if (halvesDefense(move)) a.hp = 0; // effect_script_0007.s:8: the user faints before the damage is worked out
  const s = strike(a, d, move, field);
  const quiet = [a.ability, d.ability].some((ability) => ability === A.cloudNine || ability === A.airLock);
  const c: Context = { attacker: a, defender: d, strike: s, field, criticalMul, reflect: !!field.reflect, lightScreen: !!field.lightScreen,
    weatherOn: !quiet, attackerSlowStart: !!attacker.abilityOn, plusMinus: !!attacker.abilityOn };
  return { c, moveType: a.ability === A.normalize ? T.normal : s.inType ?? s.type };
}

const ROLLS = Array.from({ length: 16 }, (_, i) => 15 - i); // r for index i: the 85 + i percent roll

const battlerAbility = (side: CalcSide): number => side.mon.ability.value;

/**
 * The 16 damage rolls (ascending, 85% to 100%) of one hit of `move` from `attacker` to `defender`, as a critical hit when
 * `crit` is set. It covers every move whose power the cartridge works out from the two Pokémon and the field: a plain hit,
 * the effects with a power rule (Facade, Brine, SmellingSalt, Wake-Up Slap, Flail, Water Spout, Punishment, Weather
 * Ball, Hidden Power, Return, Frustration, Explosion, the Reckless effects) and SolarBeam; a fixed-damage move gives its
 * damage (0 on an immunity). Throws `Gen4DamageUnsupported` for a move it does not derive: power that depends on weight,
 * speed, PP, the hit number or earlier turns, Psywave's draw, and a status move.
 * It does not model: Charge, Helping Hand, Mud and Water Sport, Magnet Rise, Ingrain, Roost and Miracle Eye, a Metronome
 * item's count, Me First, a semi-invulnerable target, and doubles' alive counts (a double battle assumes both foes up).
 */
export function gen4Damage(attacker: CalcSide, defender: CalcSide, move: KaizoMove, field: CalcField, crit: boolean): number[] {
  const kind = move.calc.fixedDamage;
  if (kind !== undefined) return fixedDamage(attacker, defender, move, field, kind);
  const criticalMul = !crit ? 1 : battlerAbility(attacker) === A.sniper ? 3 : 2;
  const { c, moveType } = context(attacker, defender, move, field, criticalMul);
  let damage = calcMoveDamage(c) * criticalMul;
  if (effectOf(c.attacker) === H.hpDrainOnAtk) damage = Math.floor((damage * (100 + paramOf(c.attacker))) / 100);
  if (effectOf(c.attacker) === H.boostRepeated) damage = Math.floor((damage * (10 + c.attacker.metronomeTurns)) / 10); // bs:1350-1352
  return ROLLS.map((r) => {
    const rolled = damage === 0 ? 0 : Math.max(1, Math.floor((damage * (100 - r)) / 100));
    const step = typeStep(c, rolled, moveType);
    return step.none ? 0 : berryHalves(c.defender, moveType, step) ? divide(step.damage, 2) : step.damage;
  });
}

/** A fixed-damage move: `kind`'s damage, unless the type step finds an immunity (or Wonder Guard stops it). */
function fixedDamage(attacker: CalcSide, defender: CalcSide, move: KaizoMove, field: CalcField, kind: NonNullable<KaizoMove['calc']['fixedDamage']>): number[] {
  if (kind === 'psywave') throw new Gen4DamageUnsupported('Psywave: eleven equally likely damages');
  const { c, moveType } = context(attacker, defender, move, field, 1);
  const step = typeStep(c, 1000, moveType); // a probe: only whether anything gets through matters
  let value: number;
  if (kind === 'level') value = attacker.mon.level;
  else if (kind === 'half-hp') value = Math.max(1, Math.floor(c.defender.hp / 2));
  else if (kind === 'endeavor') value = Math.max(0, c.defender.hp - c.attacker.hp);
  else value = kind;
  return Array<number>(16).fill(step.none ? 0 : value);
}

/**
 * The 16 rolls of a confused Pokémon's hit on itself: `CALC_SELF_HIT(MOVE_STRUGGLE, 40)` (include/battle/common.h:35-45;
 * bcp:2625-2640), then the roll. The move is a physical Normal 40-power Struggle, the Pokémon is both attacker and
 * defender, no side or field condition is passed (no weather, no screens), and there is no critical hit, Life Orb or type
 * chart, so what applies is the power terms (a Normal item, Muscle Band, Light Ball, Rivalry with itself), every stat term,
 * the stages (Simple, Unaware) and burn.
 */
export function gen4ConfusionDamage(side: CalcSide, struggleType: number = T.normal): number[] {
  const struggle = { id: MOVE_STRUGGLE, name: 'Struggle', type: struggleType, category: 'physical', power: 40, accuracy: 0, pp: 1, priority: 0,
    effectChance: 0, target: 0, flags: 0, romEffect: E.hit, effectText: '', calc: { baseMove: 'Struggle' }, unmodelled: null } as KaizoMove;
  const { c } = context(side, side, struggle, {}, 1, true);
  c.weatherOn = false;
  const damage = calcMoveDamage(c);
  return ROLLS.map((r) => Math.max(1, Math.floor((damage * (100 - r)) / 100)));
}
