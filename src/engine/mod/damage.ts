// The `platkaizo` mod's damage formula, in the cartridge's order. Showdown's Gen 4 formula chains its
// modifiers in 4096ths and applies the item and ability terms to the staged stat; the cartridge multiplies and divides
// integers one step at a time, with the terms on the RAW stat before the stage (battle_lib.c:6601-7079, `bl` below;
// docs/engine-model.md, "Damage order"). This module is that formula, reading Showdown's battle state:
//
// - `cartridgePower` the power steps (bl:6673-6919), after Showdown's move-specific `BasePower` handlers (Facade, Brine,
//   the rollout storage), which are the cartridge's `powerMul` and `inPower`;
// - `cartridgeBaseDamage` the stat terms, the stages, the formula, burn, screens, weather and Flash Fire, `+ 2`
//   (bl:6921-7077);
// - `chartStep` STAB and the type chart row by row, with Filter, Solid Rock, Expert Belt and Tinted Lens (bl:2560-2679).
//
// scripts.ts calls them from `getDamage` and `modifyDamage`, and `DROPPED_HANDLERS` turns off the Showdown handlers they
// replace (`findEventHandlers` in scripts.ts), so no term is applied twice.

import { typeMultipliers } from '../../calc/gen4Damage.js';
import { installedMoves } from '../dex.js';
import { fogCounts } from './field.js';
import { HALVE_DEFENSE_EFFECT } from './procs.js';
import { PLATES, TYPE_ITEMS } from './items.js';
import { heldParam } from './itemData.js';

/** The volatiles (Showdown's names for the state) each hiding-aware ROM effect looks for in its target. */
const HIDING: Readonly<Record<number, readonly string[]>> = { 146: ['fly', 'bounce'], 149: ['fly', 'bounce'], 147: ['dig'], 126: ['dig'], 261: ['dive'], 257: ['dive'], 150: ['minimize'] };

/** The ROM move effects that make a Reckless user's `powerMul` 12 (res/battle/scripts/effects/effect_script_0045/0048/0198/0253/0262/0269.s). */
const RECKLESS_EFFECTS: ReadonlySet<number> = new Set([45, 48, 198, 253, 262, 269]);
/** Fire Fang's effect: the cartridge's Wonder Guard check treats it as never on its damaging turn (bl:7588-7605); the engine's Wonder Guard is procs.ts's. */
const MOVE_STRUGGLE = 165;
const MOVE_SOLAR_BEAM = 76;
const PIKACHU = 25;
const [LATIAS, LATIOS, CLAMPERL, DITTO, CUBONE, MAROWAK, DIALGA, PALKIA, GIRATINA] = [380, 381, 366, 132, 104, 105, 483, 484, 487];

const mul = (value: number, numerator: number, denominator: number): number => Math.floor((value * numerator) / denominator);
const percent = (value: number, id: string, vanilla: number): number => mul(value, 100 + heldParam(id, vanilla), 100);

/**
 * The handlers the cartridge terms replace, by event: Showdown's `BasePower` ones of every item and ability and of
 * Charge, Helping Hand, Mud Sport and Water Sport, SolarBeam's; every `ModifyAtk`, `ModifySpA`, `ModifyDef` and
 * `ModifySpD`; `ModifyDamagePhase1` (screens, Flash Fire) and `Phase2` (Life Orb); `WeatherModifyDamage`; and `ModifyDamage`
 * of the abilities, Expert Belt, and the Dig, Dive, Fly, Bounce and Minimize conditions' doubling (the cartridge doubles the
 * power instead: `cartridgePower`). What stays: the move's own `BasePower` (Facade, Brine, the rollout storage) and the
 * resist berries (they eat the berry).
 */
export function isDropped(eventName: string, effect: { effectType: string; id: string }): boolean {
  const key = `${effect.effectType}:${effect.id}`;
  switch (eventName) {
    case 'BasePower':
      return effect.effectType === 'Ability' || effect.effectType === 'Item' || ['Condition:bounce', 'Condition:charge', 'Condition:helpinghand', 'Condition:mudsport',
        'Condition:watersport', 'Move:solarbeam'].includes(key);
    case 'ModifyAtk': case 'ModifyDef':
      return key !== 'Condition:beatup'; // Beat Up's hitters stand in for the stats (below)
    case 'ModifySpA': case 'ModifySpD': case 'ModifyDamagePhase1': case 'ModifyDamagePhase2': case 'WeatherModifyDamage':
      return true;
    case 'ModifyDamage':
      return effect.effectType === 'Ability' || ['Item:expertbelt', 'Condition:dig', 'Condition:dive', 'Condition:fly', 'Condition:minimize'].includes(key);
    default:
      return false;
  }
}

/** `Battler_HeldItem`: the held item, none under Klutz or Embargo. */
const workingItem = (pokemon: Pokemon): string => (pokemon.ignoringItem() ? '' : pokemon.item);

/** The cartridge's weather for a damage calculation: Showdown's, unless Cloud Nine or Air Lock suppresses it. */
function weatherOf(battle: Battle): string {
  return battle.field.effectiveWeather();
}

/** `Battler_IgnorableAbility(attacker, defender, ability)`: the defender has it, and the attacker's Mold Breaker does not ignore it. */
const ignorable = (attacker: Pokemon, defender: Pokemon, ability: string): boolean => defender.hasAbility(ability) && !attacker.hasAbility('moldbreaker');

/** The cartridge's move ROM effect (the installed hack move's), or undefined for a move the hack does not define. */
function romEffectOf(move: ActiveMove): number | undefined {
  return installedMoves().get(move.num)?.romEffect;
}

/**
 * The power after the cartridge's steps (bl:6673-6919), from `power`, the move's power after its own `BasePower` handlers
 * (Facade's and Brine's doubling are the cartridge's `powerMul`, which comes first). In the cartridge's order: Reckless,
 * Charge, Helping Hand, Technician, the type item, Light Ball, the orbs, Muscle Band and Wise Glasses, Thick Fat, Mud and
 * Water Sport, the pinch abilities, Heatproof, Dry Skin, Rivalry, Iron Fist; each one floors.
 */
export function cartridgePower(battle: Battle, source: Pokemon, target: Pokemon, move: ActiveMove, basePower: number): number {
  let power = basePower;
  const type = move.type;
  // A move that hits a Pokémon in the state its effect looks for has twice the power from the first step (`powerMul` 20,
  // effect scripts 146, 147, 149, 150, 257, 261, 126), where Showdown doubles the final damage.
  const looksFor = HIDING[romEffectOf(move) ?? -1];
  if (looksFor !== undefined && looksFor.some((volatile) => target.volatiles[volatile])) power *= 2;
  if (source.hasAbility('reckless') && RECKLESS_EFFECTS.has(romEffectOf(move) ?? -1)) power = mul(power, 12, 10);
  if (source.volatiles['charge'] && type === 'Electric') power *= 2;
  if (source.volatiles['helpinghand']) power = mul(power, 15, 10);
  if (source.hasAbility('technician') && move.id !== 'struggle' && power <= 60) power = mul(power, 15, 10);
  const item = workingItem(source);
  // Life Orb's recoil is a volatile that its `BasePower` handler added (data/mods/gen4/items.ts): not on a hit that lands on a substitute.
  if (item === 'lifeorb' && !target.volatiles['substitute']) source.addVolatile('lifeorb');
  const boosted = TYPE_ITEMS[item] ?? PLATES.get(item);
  if (item !== '' && boosted === type) power = percent(power, item, 20);
  if (item === 'lightball' && source.species.num === PIKACHU) power *= 2;
  const num = source.species.num;
  if (item === 'adamantorb' && num === DIALGA && (type === 'Dragon' || type === 'Steel')) power = percent(power, item, 20);
  if (item === 'lustrousorb' && num === PALKIA && (type === 'Dragon' || type === 'Water')) power = percent(power, item, 20);
  if (item === 'griseousorb' && num === GIRATINA && (type === 'Dragon' || type === 'Ghost') && !source.transformed) power = percent(power, item, 20);
  if (item === 'muscleband' && move.category === 'Physical') power = percent(power, item, 10);
  if (item === 'wiseglasses' && move.category === 'Special') power = percent(power, item, 10);
  if (ignorable(source, target, 'thickfat') && (type === 'Fire' || type === 'Ice')) power = Math.floor(power / 2);
  const sports = battle.getAllActive();
  if (type === 'Electric' && sports.some((mon) => mon.volatiles['mudsport'])) power = Math.floor(power / 2);
  if (type === 'Fire' && sports.some((mon) => mon.volatiles['watersport'])) power = Math.floor(power / 2);
  // An Explosion effect faints its user before the damage is worked out (effect_script_0007.s:8), so the pinch abilities see 0 HP.
  const rom = romEffectOf(move);
  const hp = rom === HALVE_DEFENSE_EFFECT ? 0 : source.hp;
  const pinch = hp <= Math.floor(source.maxhp / 3);
  for (const [ability, pinchType] of [['overgrow', 'Grass'], ['blaze', 'Fire'], ['torrent', 'Water'], ['swarm', 'Bug']] as const) {
    if (type === pinchType && source.hasAbility(ability) && pinch) power = mul(power, 150, 100);
  }
  if (type === 'Fire' && ignorable(source, target, 'heatproof')) power = Math.floor(power / 2);
  if (type === 'Fire' && ignorable(source, target, 'dryskin')) power = mul(power, 125, 100);
  if (source.hasAbility('rivalry') && (source.gender === 'M' || source.gender === 'F') && (target.gender === 'M' || target.gender === 'F')) {
    power = mul(power, source.gender === target.gender ? 125 : 75, 100);
  }
  if (source.hasAbility('ironfist') && move.flags['punch']) power = mul(power, 12, 10);
  return power;
}

/** `sStatStageBoosts` (bl:6550-6564): stage -6 to +6 as numerator / denominator. */
const STAGES: readonly (readonly [number, number])[] = [[10, 40], [10, 35], [10, 30], [10, 25], [10, 20], [10, 15], [10, 10], [15, 10], [20, 10],
  [25, 10], [30, 10], [35, 10], [40, 10]];

/**
 * The cartridge's damage before the critical multiplier, the roll and the type chart (bl:6921-7077): the raw stats with
 * their item and ability terms (each floored), the stages (Simple, Unaware, a crit's rule), `A × P × (L × 2 / 5 + 2) / D / 50`,
 * burn, a screen, weather, Flash Fire, and `+ 2`. `selfHit` is the confusion hit (`CALC_SELF_HIT`, common.h:35-45): no weather,
 * screens or crit.
 */
export function cartridgeBaseDamage(battle: Battle, source: Pokemon, target: Pokemon, move: ActiveMove, power: number, crit: boolean, selfHit: boolean): number {
  const physical = move.category === 'Physical';
  const type = move.type;
  const rom = romEffectOf(move);
  const explodes = rom === undefined ? ['explosion', 'selfdestruct'].includes(move.id) : rom === HALVE_DEFENSE_EFFECT;
  const sourceItem = workingItem(source);
  const targetItem = workingItem(target);
  const weather = selfHit ? '' : weatherOf(battle);
  const sun = weather === 'sunnyday';
  let [atk, def, spa, spd] = [source.storedStats.atk, target.storedStats.def, source.storedStats.spa, target.storedStats.spd];

  if (source.hasAbility('hugepower') || source.hasAbility('purepower')) atk *= 2;
  if (source.hasAbility('slowstart') && source.abilityState['counter']) atk = Math.floor(atk / 2);
  if (sourceItem === 'choiceband') atk = mul(atk, 150, 100);
  if (sourceItem === 'choicespecs') spa = mul(spa, 150, 100);
  if (sourceItem === 'souldew' && (source.species.num === LATIAS || source.species.num === LATIOS)) spa = mul(spa, 150, 100);
  if (targetItem === 'souldew' && (target.species.num === LATIAS || target.species.num === LATIOS)) spd = mul(spd, 150, 100);
  if (sourceItem === 'deepseatooth' && source.species.num === CLAMPERL) spa *= 2;
  if (targetItem === 'deepseascale' && target.species.num === CLAMPERL) spd *= 2;
  if (targetItem === 'metalpowder' && target.species.num === DITTO) def *= 2;
  if (sourceItem === 'thickclub' && (source.species.num === CUBONE || source.species.num === MAROWAK)) atk *= 2;
  if (source.hasAbility('hustle')) atk = mul(atk, 150, 100);
  if (source.hasAbility('guts') && source.status) atk = mul(atk, 150, 100);
  if (ignorable(source, target, 'marvelscale') && target.status) def = mul(def, 150, 100);
  const partner = source.hasAbility('plus') ? 'minus' : source.hasAbility('minus') ? 'plus' : null;
  if (!selfHit && partner !== null && source.allies().some((ally) => ally.hasAbility(partner))) spa = mul(spa, 150, 100);

  let attackStage = source.boosts[physical ? 'atk' : 'spa'];
  let defenseStage = target.boosts[physical ? 'def' : 'spd'];
  // Beat Up (data/mods/gen4/moves.ts): its hitter's base Attack and the target's base Defense stand in for both stats, stage and all.
  const beatUp = !!source.volatiles['beatup'];
  const clamp = (stage: number) => Math.max(-6, Math.min(6, stage));
  if (source.hasAbility('simple')) attackStage = clamp(attackStage * 2);
  if (ignorable(source, target, 'simple')) defenseStage = clamp(defenseStage * 2);
  if (ignorable(source, target, 'unaware')) attackStage = 0;
  if (source.hasAbility('unaware')) defenseStage = 0;

  if (!selfHit && weather !== '') {
    if (sun && source.hasAbility('solarpower')) spa = mul(spa, 15, 10);
    if (weather === 'sandstorm' && target.hasType('Rock')) spd = mul(spd, 15, 10);
    if (sun && source.hasAbility('flowergift')) atk = mul(atk, 15, 10);
    if (sun && !source.hasAbility('moldbreaker') && target.hasAbility('flowergift')) spd = mul(spd, 15, 10);
  }
  if (explodes && physical) def = Math.floor(def / 2);
  if (beatUp) {
    atk = battle.runEvent('ModifyAtk', source, target, move, atk);
    def = battle.runEvent('ModifyDef', target, source, move, def);
    attackStage = 0;
    defenseStage = 0;
  }

  const staged = (stat: number, stage: number, keep: boolean) => (keep ? Math.max(1, mul(stat, STAGES[stage + 6]![0], STAGES[stage + 6]![1])) : stat);
  const attack = physical ? atk : spa;
  const defense = physical ? def : spd;
  let damage = staged(attack, attackStage, !crit || attackStage > 0);
  damage *= power;
  damage *= Math.floor((source.level * 2) / 5) + 2;
  damage = Math.floor(damage / staged(defense, defenseStage, !crit || defenseStage < 0));
  damage = Math.floor(damage / 50);

  if (physical && source.status === 'brn' && !source.hasAbility('guts')) damage = Math.floor(damage / 2);
  if (!selfHit && !crit && target.side.getSideCondition(physical ? 'reflect' : 'lightscreen') !== null && rom !== 186) damage = Math.floor(damage / 2);
  if (move.spreadHit) damage = mul(damage, 3, 4);

  if (!selfHit) {
    const fog = fogCounts(battle); // until a weather or Defog clears it (mod/field.ts)
    if (weather === 'raindance') {
      if (type === 'Fire') damage = Math.floor(damage / 2);
      if (type === 'Water') damage = mul(damage, 15, 10);
    }
    if ((weather === 'raindance' || weather === 'sandstorm' || weather === 'hail' || fog) && move.num === MOVE_SOLAR_BEAM) damage = Math.floor(damage / 2);
    if (sun) {
      if (type === 'Fire') damage = mul(damage, 15, 10);
      if (type === 'Water') damage = Math.floor(damage / 2);
    }
    if (source.volatiles['flashfire'] && type === 'Fire') damage = mul(damage, 15, 10);
  }
  return damage + 2;
}

/** What the type step found: the damage, and the cartridge's two flags (which cancel each other, bl:7557-7575). */
export interface ChartStep { damage: number; superEffective: boolean; notVeryEffective: boolean }

/** `BattleSystem_Divide` (bl:3599-3619): truncates, but never takes a nonzero value to 0. */
const divide = (dividend: number, divisor: number): number => (dividend === 0 ? 0 : Math.max(1, Math.floor(dividend / divisor)));

/**
 * `flags` of the chart walk for `target` (bl:2529-2558, :2612-2621): the multipliers in row order, and whether the
 * cartridge's two flags end up set. Struggle and a typeless move have none. Called once per hit, not per roll.
 */
export function chartFlags(source: Pokemon, target: Pokemon, move: ActiveMove, gravity: boolean): { multipliers: number[]; superEffective: boolean; notVeryEffective: boolean } {
  const [first, second] = [ROM_TYPE[target.getTypes()[0] ?? ''] ?? -1, ROM_TYPE[target.getTypes()[1] ?? ''] ?? -1];
  const multipliers = typeMultipliers(ROM_TYPE[move.type] ?? -1, [first, second === -1 ? first : second], {
    ghostRevealed: !!target.volatiles['foresight'] || source.hasAbility('scrappy'),
    groundedFlying: gravity || target.hasItem('ironball') || !!target.volatiles['ingrain'],
    roosting: !!target.volatiles['roost'], miracleEye: !!target.volatiles['miracleeye'],
  });
  let superEffective = false;
  let notVeryEffective = false;
  for (const m of multipliers) {
    if (m === 0) { superEffective = false; notVeryEffective = false; } else if (m === 5) {
      if (superEffective) superEffective = false; else notVeryEffective = true;
    } else if (notVeryEffective) {
      notVeryEffective = false;
    } else {
      superEffective = true;
    }
  }
  return { multipliers, superEffective, notVeryEffective };
}

/** The ROM type numbers by Showdown type name (generated/pokemon_types.txt; Mystery 9). */
const ROM_TYPE: Readonly<Record<string, number>> = {
  Normal: 0, Fighting: 1, Flying: 2, Poison: 3, Ground: 4, Rock: 5, Bug: 6, Ghost: 7, Steel: 8, Fire: 10, Water: 11, Grass: 12,
  Electric: 13, Psychic: 14, Ice: 15, Dragon: 16, Dark: 17,
};

/**
 * One rolled damage through STAB, the chart and the final modifiers (bl:2560-2679). `flags` is `chartFlags`' result for
 * the hit. A move of typeless `???` and Struggle (bl:2573-2575) skip STAB and the chart.
 */
export function chartStep(source: Pokemon, target: Pokemon, move: ActiveMove, rolled: number, flags: ReturnType<typeof chartFlags>): number {
  if (move.id === 'struggle' || move.num === MOVE_STRUGGLE || move.type === '???') return rolled;
  let damage = rolled;
  if (move.forceSTAB || source.hasType(move.type)) damage = source.hasAbility('adaptability') ? damage * 2 : mul(damage, 15, 10);
  for (const multiplier of flags.multipliers) damage = divide(damage * multiplier, 10);
  const hasPower = move.basePower !== 0 || move.basePowerCallback !== undefined;
  if (flags.superEffective && hasPower) {
    if (ignorable(source, target, 'filter') || ignorable(source, target, 'solidrock')) damage = divide(damage * 3, 4);
    if (source.hasItem('expertbelt')) damage = percent(damage, 'expertbelt', 20);
  }
  if (flags.notVeryEffective && hasPower && source.hasAbility('tintedlens')) damage *= 2;
  return damage;
}
