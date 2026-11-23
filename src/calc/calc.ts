// Gen 4 damage for the hack: @smogon/calc 0.12 run on the ROM's numbers, with the cartridge's own rules where Smogon's
// data or code differ (Hidden Power, move targets, punch and sound moves, fixed damage, hit counts), and KO chances
// worked out exactly over the damage rolls.

import { Dex } from '@pkmn/dex';
import { calculate, Generations, Move, Pokemon, type Result, toID } from '@smogon/calc';
import { getBerryResistType } from '@smogon/calc/dist/items.js';
import { type CalcMoveSpec, hiddenPower, type KaizoMove } from '../battle/moves.js';
import type { PlayerMon } from '../battle/playerMon.js';
import type { BattleMon, ResolvedMon } from '../battle/types.js';
import { buildNameIndex } from '../names/nameIndex.js';
import { FORMS } from '../rom/forms.js';
import { NATURES } from '../rom/natures.js';
import { calcHp } from '../rom/stats.js';
import { TYPE_NAMES } from '../rom/tables.js';
import type { Stats } from '../rom/types.js';
import type { StartStatus } from '../save/status.js';
import { hitChance, isOhko } from './accuracy.js';
import { Gen4DamageUnsupported, gen4Damage } from './gen4Damage.js';
import { type CalcField, smogonField } from './field.js';

export { type CalcField, fieldFromNote } from './field.js';

/**
 * One side of a damage calc: a Pokémon and its battle state.
 * - `boosts` are stat stages, −6 to +6. Damage uses Atk to Spe; accuracy and evasion stages change no damage.
 * - `curHp` defaults to full HP for both sides: planning assumes it; pass a
 *   `PlayerMon`'s `currentHp` to use the save's. It is kept within 0 to max HP. `status` defaults to the save's for a
 *   `PlayerMon`, and to no status for a `ResolvedMon`.
 * - `abilityOn` marks an ability that needs a trigger as active: Flash Fire's boost, Intimidate on entry, Plus or Minus
 *   with a partner, Slow Start's first turns.
 * - `confused` marks a confused Pokémon. Only accuracy reads it: Tangled Feet halves the accuracy of moves against it.
 * - `foresight` marks a Pokémon identified by Foresight or Odor Sleuth (`VOLATILE_CONDITION_FORESIGHT`): Normal and
 *   Fighting moves hit it though it is a Ghost (battle_lib.c:2612-2621), and its raised evasion stops counting
 *   (`MON_IS_IDENTIFIED`, battle_controller_player.c:2888-2890).
 */
export interface CalcSide {
  mon: ResolvedMon | PlayerMon; boosts?: Partial<Stats & { accuracy: number; evasion: number }>; status?: StartStatus; curHp?: number; abilityOn?: boolean;
  confused?: boolean; foresight?: boolean;
  /** Consecutive uses of the same move, as the cartridge counts them (`metronomeTurns`, 0 to 10): a Metronome item's `(10 + turns) / 10` (bs:1350-1352). */
  metronomeTurns?: number;
  /** The state a Dig, Fly, Dive, Bounce or Minimize left this Pokémon in: the moves that hit it then have twice the power (effects 146/149, 147/126, 261/257, 150; `powerMul` 20). */
  hiding?: 'airborne' | 'underground' | 'underwater' | 'minimized';
}

/**
 * One move's damage from one side to the other.
 * - `rolls` are one hit's 16 damage rolls, 85% to 100%, and `critRolls` the same hit's rolls as a critical hit. A
 *   multi-hit move gives its first hit here. A fixed-damage move has no rolls and can't crit: its value fills all 16
 *   of both, except Psywave's (see `psywaveRolls`).
 * - Psywave's 16 `rolls` slots are not equally likely: its 11 damage values, each 1/11, are spread over the 16 slots,
 *   so 5 values take 2 slots and 6 take 1. Never read them as 16 equal odds; `koChance` and `desc` carry the true odds.
 * - `min`, `max` and `percent` are for one use of the move with every hit summed: the fewest hits' lowest rolls to the
 *   most hits' highest. `percent` is of the defender's max HP, rounded down to 0.1 as @smogon/calc rounds it. With
 *   `damage`'s `crit`, they are over the crit rolls.
 * - `koChance` has entries for 1 to 4 uses (`hits`) of the move: the chance they take the defender from its current
 *   HP to 0, exact over every roll and hit-count combination, with no crits (with `damage`'s `crit`, every hit of every
 *   use a crit). It is counted in integers and divided once, so it is exactly 1 only for a certain KO and exactly 0
 *   only for an impossible one. Every use deals the first use's damage, except that Super Fang and Endeavor work from
 *   the HP left; nothing else changes between uses (no recovery, berry, item, weather or residual damage). Like every
 *   move's, it is conditional on every use hitting: the accuracy is `hitChance`'s. It is null when the damage is
 *   unbounded (`bounded` false): no KO chance, and never "no KO", can be given.
 *   - An OHKO move (`ohko`) has the same 4 entries, each 1 when it can affect the defender (a hit then
 *     KOs), else 0: Sturdy without Mold Breaker, a defender of a higher level (`BtlCmd_TryOHKOMove`,
 *     src/battle/battle_script.c:4334-4388), or a type or ability immunity Smogon finds (a Ghost to Guillotine,
 *     Levitate to Fissure, Wonder Guard).
 * - `koExact` is `koChance` as exact fractions: for the same uses (`hits` 1 to 4), each chance as `count / total`,
 *   reduced (gcd 1, `total` ≥ 1) from the integer counts `koChance` divides, so 0/1 for an impossible KO and 1/1 for a
 *   certain one. It is null exactly when `koChance` is. A bigint has no JSON form, so `JSON.stringify` throws on a
 *   result: send one field by field, as the sheet route does.
 * - `bounded` is false when nothing bounds the damage: the result is `unmodelled`, and not an OHKO move
 *   (whose damage is the defender's HP whatever its effect text says). Then `koChance` and `koExact` are null, and
 *   `rolls`, `critRolls`, `min`, `max` and `percent` are meaningless: they are the base move's numbers (Counter's,
 *   Bide's, Present's power 1), not a bound on anything. Every consumer (the sheet, the solver, the engine's
 *   verification) must treat such a move as dealing any damage at all; `desc` shows its range as "?".
 * - `ohko` marks an OHKO move. Its `rolls`, `critRolls`, `min` and `max` are what it deals when it hits, the
 *   defender's current HP (`BtlCmd_TryOHKOMove`, src/battle/battle_script.c:4334-4383), or 0 when it cannot land.
 * - `unmodelled` is the move's own `unmodelled`, an effect on damage that these numbers leave out, joined by "; " to a
 *   Fling's note when its held item's fling power is unknown (`flingOverride`).
 * - `desc` reads like "Monferno Ember vs. Zigzagoon: 22-27 (110 - 135%)", or "…: ?" when unbounded, plus notes in
 *   brackets. With `damage`'s `crit`, the move reads "Ember (crit)", or "Ember (crit blocked by Shell Armor)" where the
 *   defender's ability stops the crit.
 */
export interface DamageResult {
  rolls: number[]; critRolls: number[]; min: number; max: number; percent: [number, number];
  koChance: { hits: number; chance: number }[] | null; koExact: { hits: number; count: bigint; total: bigint }[] | null;
  bounded: boolean; ohko: boolean; unmodelled: string | null; desc: string;
}

const GEN4 = Generations.get(4);
type TypeName = Pokemon['types'][number];
type SmogonTypes = Pokemon['types'];
type MoveTarget = Move['target'];
type StatusName = Pokemon['status'];
type PokemonOptions = NonNullable<ConstructorParameters<typeof Pokemon>[2]>;

/** Item and ability names by Gen 4 ID. The name index's item and ability lookups need no docs data. */
const NAMES = buildNameIndex({ species: [], moves: [] });

/** Ability 92. Only the attacker's ability name matters here, so compare names. */
const SKILL_LINK = 'Skill Link';

/** Plain base moves, as `buildMoves` uses for a damaging move with no base of its own. */
const NEUTRAL_PHYSICAL_BASE = 'Tackle';
const NEUTRAL_SPECIAL_BASE = 'Swift';

/** Griseous Orb, which Fling never throws (res/battle/scripts/effects/effect_script_0233.s:6). */
const GRISEOUS_ORB = 112;

/**
 * How a Fling runs: always as a plain hit of `power` (0 when it fails), never on @smogon/calc's own Fling, whose fling
 * powers are @pkmn/dex's and not the hack's (Nugget is 250 in the hack's item data, and @pkmn/dex has no Nugget at
 * all). `note` is set when the power is unknown: the result is then unbounded, and the numbers are run
 * on the move's own power, as for any unmodelled move. Null for any other move. From the cartridge
 * (effect_script_0233.s, `BattleSystem_FlingItem` at src/battle/battle_lib.c:5853-5862):
 * - The power is the held item's fling power in the ROM's item data (`Battler_ItemFlingPower`, 5491-5498), which
 *   `buildMoves` puts on the move as `calc.flingPower`.
 * - It fails at fling power 0 (as with no held item, which reads item-data entry 0), for a Multitype user, or with a
 *   held Griseous Orb (the script's lines 5-7).
 * - Klutz does not stop it: `Battler_ItemFlingPower` reads the held item itself and checks only Embargo, while Klutz
 *   takes away the item's hold effect (`Battler_HeldItem`, 5352-5363).
 */
function flingOverride(attacker: BattleMon, move: KaizoMove): { power: number; note: string | null } | null {
  if (move.calc.baseMove !== 'Fling') return null;
  const ability = NAMES.ability(attacker.ability.value);
  if (attacker.item === 0 || attacker.item === GRISEOUS_ORB || ability === 'Multitype') return { power: 0, note: null };
  const table = move.calc.flingPower;
  if (table === undefined) return { power: move.power, note: 'Fling: no item data for the held item\'s fling power' };
  const power = table[attacker.item];
  if (typeof power !== 'number') return { power: move.power, note: `Fling: item ${attacker.item} has no fling power in the ROM's item data` };
  return { power, note: null };
}

// ---------------------------------------------------------------------------------------------------------------------
// The cartridge's move flags and targets, from pret/pokeplatinum at 62bdaacdc (the clone at ~/src/pokeplatinum).

/**
 * Bits of the ROM's move flags byte: `MOVE_FLAG_MAKES_CONTACT` and `MOVE_FLAG_CAN_PROTECT`, the first two entries of
 * generated/move_flags.txt:1-2. That file is a metang mask (generated/meson.build:70), so entry k is bit k − 1. The
 * ROM agrees: Tackle has 115 (contact), Surf 50 (no contact), and both can be Protected.
 */
const MOVE_FLAG_MAKES_CONTACT = 1 << 0;
const MOVE_FLAG_CAN_PROTECT = 1 << 1;

/**
 * `sPunchingMoves` (src/battle/battle_lib.c:6566-6582), the moves Iron Fist boosts. The cartridge compares the move ID
 * against this table (battle_lib.c:6914-6919), so a hack move in one of these ID slots counts as a punch: Ice Punch 8,
 * Fire Punch 7, Thunder Punch 9, Mach Punch 183, Focus Punch 264, Dizzy Punch 146, Dynamic Punch 223, Hammer Arm 359,
 * Mega Punch 5, Comet Punch 4 (Water Ball in the hack), Meteor Mash 309, Shadow Punch 325, Drain Punch 409, Bullet
 * Punch 418, Sky Uppercut 327.
 */
const PUNCHING_MOVES: ReadonlySet<number> = new Set([8, 7, 9, 183, 264, 146, 223, 359, 5, 4, 309, 325, 409, 418, 327]);

/**
 * `sSoundMoves` (src/battle/battle_lib.c:3473-3486), the moves Soundproof blocks, also compared by move ID
 * (battle_lib.c:3523-3530): Growl 45, Roar 46, Sing 47, Supersonic 48, Screech 103, Snore 173, Uproar 253, Metal Sound
 * 319, GrassWhistle 320, Hyper Voice 304, Bug Buzz 405, Chatter 448.
 */
const SOUND_MOVES: ReadonlySet<number> = new Set([45, 46, 47, 48, 103, 173, 253, 319, 320, 304, 405, 448]);

/** What the cartridge decides about a move by its ROM flags byte (contact, Protect) and its ID (punch, sound). */
export interface MoveFlags { contact: boolean; protect: boolean; punch: boolean; sound: boolean }

/**
 * A move's flags as the cartridge decides them: `contact` and `protect` (blocked by Protect) from the ROM flags byte,
 * `punch` (Iron Fist) and `sound` (Soundproof) from the cartridge's move-ID tables. The calc uses these in place of its
 * base move's flags.
 */
export function moveFlags(move: Pick<KaizoMove, 'id' | 'flags'>): MoveFlags {
  return {
    contact: (move.flags & MOVE_FLAG_MAKES_CONTACT) !== 0, protect: (move.flags & MOVE_FLAG_CAN_PROTECT) !== 0,
    punch: PUNCHING_MOVES.has(move.id), sound: SOUND_MOVES.has(move.id),
  };
}

/**
 * The ROM's move targets (`RANGE_*`, generated/move_ranges.txt, a metang mask whose first entry is 0) as @smogon/calc
 * names them. battle_lib.c:1611-1670 gives examples of each, and the ROM agrees: Tackle 0, Counter 1, Uproar 2, Swift
 * 4, Surf 8, Swords Dance 0x10, Reflect 0x20, Haze 0x40, Spikes 0x80, Helping Hand 0x100, Acupressure 0x200, Me First
 * 0x400. In a double battle the calc cuts damage to 3/4 for 'allAdjacentFoes' and 'allAdjacent' only.
 */
const TARGETS: ReadonlyMap<number, MoveTarget> = new Map<number, MoveTarget>([
  [0x000, 'normal'], // RANGE_SINGLE_TARGET
  [0x001, 'scripted'], // RANGE_SINGLE_TARGET_SPECIAL: Counter, Mirror Coat, Metal Burst
  [0x002, 'randomNormal'], // RANGE_RANDOM_OPPONENT: Uproar
  [0x004, 'allAdjacentFoes'], // RANGE_ADJACENT_OPPONENTS: Swift, Rock Slide
  [0x008, 'allAdjacent'], // RANGE_ALL_ADJACENT: Surf, Earthquake, Explosion
  [0x010, 'self'], // RANGE_USER
  [0x020, 'allySide'], // RANGE_USER_SIDE
  [0x040, 'all'], // RANGE_FIELD
  [0x080, 'foeSide'], // RANGE_OPPONENT_SIDE
  [0x100, 'adjacentAlly'], // RANGE_ALLY
  [0x200, 'adjacentAllyOrSelf'], // RANGE_USER_OR_ALLY
  [0x400, 'adjacentFoe'], // RANGE_SINGLE_TARGET_ME_FIRST
]);

/** A ROM move target (`RANGE_*`) as @smogon/calc names it. Throws for a target the ROM never uses. */
export function smogonTarget(target: number): MoveTarget {
  const name = TARGETS.get(target);
  if (name === undefined) throw new Error(`Unknown ROM move target ${target}`);
  return name;
}

/**
 * The Plates by Gen 4 item ID, each with the ROM type it boosts. The docs' Items tab gives every Plate a hold-effect
 * power of 50 where vanilla has 20, and the cartridge multiplies a move of the Plate's type by (100 + power) / 100
 * (`sTypeBoostingItems`, battle_lib.c:6716-6721), so 1.5x where @smogon/calc's Gen 4 code has 1.2x.
 */
const PLATES: ReadonlyMap<number, number> = new Map(Dex.forGen(4).items.all()
  .filter((item) => item.onPlate !== undefined && item.gen <= 4)
  .map((item) => [item.num, TYPE_NAMES.indexOf(item.onPlate!)]));

/**
 * The bases whose power @smogon/calc's Gen 4 code works out or scales itself (`calculateBasePowerDPP`, and Natural
 * Gift in `calculateDPP`), so that a power override is not the power it uses.
 */
const SMOGON_POWER_BASES: ReadonlySet<string> = new Set(['Brine', 'Eruption', 'Water Spout', 'Facade', 'Flail', 'Reversal', 'Fling',
  'Grass Knot', 'Low Kick', 'Gyro Ball', 'Payback', 'Punishment', 'Pursuit', 'Wake-Up Slap', 'Nature Power', 'Crush Grip',
  'Wring Out', 'Triple Kick', 'Weather Ball', 'Natural Gift']);

const WEATHER_TYPES = { rain: 11, sun: 10, sand: 5, hail: 15 } as const;

/**
 * How a Plate's 1.5x is passed to @smogon/calc, or null when the attacker's Plate does not boost the move. The Plate is
 * taken off the Smogon attacker, so Smogon's 1.2x is not applied, and Helping Hand is set: in Smogon's Gen 4 code it is
 * the only 1.5x power step before items, and nothing that could be on lies between them but Technician. The cartridge
 * applies Technician (power 60 or less) before the Plate and Smogon applies it after Helping Hand, which agree unless the
 * power is 41 to 60: then a move whose power is its own gets Technician applied here first, through `power`. A move whose
 * power Smogon works out itself (`SMOGON_POWER_BASES`) can't be helped that way, so with Technician at 41 to 60 power it
 * misses Technician; no trainer has such a move with its Plate.
 * - The boosted type is the move's after Normalize, Hidden Power, Judgment (the Plate's type) and Weather Ball (the
 *   weather's, unless Cloud Nine or Air Lock is out); `type` is set for Judgment, whose type Smogon takes from the
 *   held Plate.
 * - Klutz disables the Plate. A Fling is left out: the held Plate stays on the Smogon attacker, so a Dark Fling of a
 *   Dread Plate gets Smogon's 1.2x where the hack's 1.5x applies (a known minor; no trainer flings a Plate).
 */
function plateBoost(attacker: BattleMon, defender: BattleMon, move: KaizoMove, field: CalcField): { type?: number; power?: number } | null {
  const plateType = PLATES.get(attacker.item);
  const ability = NAMES.ability(attacker.ability.value);
  const base = move.calc.baseMove;
  if (plateType === undefined || ability === 'Klutz' || base === 'Fling') return null;
  const hidden = hiddenPowerOf(attacker, move);
  const weatherOut = [ability, NAMES.ability(defender.ability.value)].some((name) => name === 'Cloud Nine' || name === 'Air Lock');
  const type = ability === 'Normalize' ? 0
    : base === 'Judgment' ? plateType
      : base === 'Weather Ball' && field.weather !== undefined && !weatherOut ? WEATHER_TYPES[field.weather]
        : hidden?.type ?? move.type;
  if (type !== plateType) return null;
  const power = hidden?.power ?? move.power;
  const technicianFirst = ability === 'Technician' && power > 40 && power <= 60 && !SMOGON_POWER_BASES.has(base);
  return { ...(base === 'Judgment' && { type }), ...(technicianFirst && { power: Math.floor(power * 1.5) }) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Smogon's Pokémon and moves, built from ours.

function typeName(id: number): TypeName {
  const name = TYPE_NAMES[id];
  if (name === undefined) throw new Error(`Unknown type ${id}`);
  return name as TypeName;
}

/** Each species' base form by national dex number, named as Smogon names it (@pkmn/dex's Gen 4 data). */
const BASE_SPECIES: ReadonlyMap<number, string> = new Map(Dex.forGen(4).species.all()
  .filter((species) => species.gen <= 4 && species.num > 0 && species.name === species.baseSpecies)
  .map((species) => [species.num, species.name]));

/**
 * The Smogon species a Pokémon is: its form ("Rotom-Wash") where Smogon has it, else the base species (Smogon has no
 * Burmy or Unown forms). The name decides only what Smogon looks up by name: weight, and items tied to a species (Light
 * Ball, Thick Club, Soul Dew, the orbs). Base stats and types are always ours.
 */
function smogonName(mon: BattleMon): string {
  const base = BASE_SPECIES.get(mon.species);
  if (base === undefined) throw new Error(`No Gen 4 species ${mon.species}`);
  const formName = mon.form > 0 ? FORMS[mon.species]?.[mon.form]?.name : undefined;
  return (formName ? GEN4.species.get(toID(`${base}-${formName}`))?.name : undefined) ?? base;
}

/**
 * A Smogon Pokémon that keeps our types through `calculate`, which clones both Pokémon. Smogon merges `overrides.types`
 * into its own species' types entry by entry, so a single type over a dual-typed species would keep Smogon's second
 * type; this sets the types outright, here and on every clone.
 */
class HackPokemon extends Pokemon {
  private readonly hackTypes: SmogonTypes;

  constructor(name: string, options: PokemonOptions, types: SmogonTypes) {
    super(GEN4, name, options);
    this.hackTypes = types;
    this.types = [...types] as SmogonTypes;
  }

  override clone(): ReturnType<Pokemon['clone']> {
    const copy = super.clone();
    copy.types = [...this.hackTypes] as SmogonTypes;
    return copy;
  }
}

const STATUSES: Record<StartStatus['kind'], StatusName> = {
  none: '', sleep: 'slp', poison: 'psn', toxic: 'tox', burn: 'brn', freeze: 'frz', paralysis: 'par',
};

/** A side's HP and status, with the defaults `CalcSide` describes. */
interface SideState { maxHp: number; hp: number; status: StartStatus }

function sideState(side: CalcSide): SideState {
  const { mon } = side;
  const maxHp = calcHp(mon.baseStats.hp, mon.ivs.hp, mon.evs.hp, mon.level);
  const hp = Math.min(maxHp, Math.max(0, side.curHp ?? maxHp));
  return { maxHp, hp, status: side.status ?? ('status' in mon ? mon.status : { kind: 'none' }) };
}

const itemName = (mon: BattleMon) => (mon.item === 0 ? undefined : NAMES.item(mon.item));

/**
 * The Smogon Pokémon for a side: our base stats, types, level, IVs, EVs, ability and item (left out with `noItem`), the
 * nature (Hardy, a neutral one, when unknown), and the side's state. An ability name is always given, as Smogon would
 * otherwise use its own species' first ability.
 */
function smogonPokemon(side: CalcSide, state: SideState, noItem = false): HackPokemon {
  const { mon } = side;
  const [first, second] = mon.types;
  const types: SmogonTypes = first === second ? [typeName(first)] : [typeName(first), typeName(second)];
  const item = noItem ? undefined : itemName(mon);
  return new HackPokemon(smogonName(mon), {
    level: mon.level, gender: mon.gender ?? 'N', nature: NATURES[mon.nature.value ?? 0] ?? 'Hardy',
    ability: NAMES.ability(mon.ability.value), abilityOn: !!side.abilityOn, ...(item !== undefined && { item }),
    ivs: { ...mon.ivs }, evs: { ...mon.evs }, curHP: state.hp, status: STATUSES[state.status.kind],
    boosts: { atk: side.boosts?.atk ?? 0, def: side.boosts?.def ?? 0, spa: side.boosts?.spa ?? 0, spd: side.boosts?.spd ?? 0, spe: side.boosts?.spe ?? 0 },
    overrides: { baseStats: { ...mon.baseStats }, types },
  }, types);
}

/** Hidden Power's type and power for the attacker, when the move runs as Hidden Power; null otherwise. */
function hiddenPowerOf(attacker: BattleMon, move: KaizoMove): { type: number; power: number } | null {
  return move.calc.baseMove === 'Hidden Power' ? hiddenPower(attacker.ivs) : null;
}

const bit = (on: boolean): 0 | 1 => (on ? 1 : 0);

/** Bases that halve the target's Defense (`BATTLE_EFFECT_HALVE_DEFENSE`). */
const HALVE_DEFENSE_BASES: ReadonlySet<string> = new Set(['Explosion', 'Self-Destruct']);

/**
 * The Smogon move: the base move's mechanics with the ROM's power, type, category, priority and target, Hidden Power's
 * type and power from the attacker's IVs, the cartridge's flags (`moveFlags`), and the spec's hits, recoil, drain and
 * always-crit. Only Gen 4 flags matter to the calc, and the rest are cleared. `plate` replaces the power or type as
 * `plateBoost` says; `flingPower` runs a Fling as a plain hit of that power (`flingOverride`).
 *
 * A special move on an Explosion base runs on Swift: the cartridge halves the physical Defense stat for the Explosion
 * effect (battle_lib.c:6943-6945) and a special move uses Special Defense (6992 on), where Smogon would halve the
 * Special Defense.
 */
function smogonMove(attacker: BattleMon, move: KaizoMove, opts: { isCrit: boolean; hits?: number; plate?: { type?: number; power?: number } | null; flingPower?: number }): Move {
  const { calc } = move;
  const hidden = hiddenPowerOf(attacker, move);
  const flags = moveFlags(move);
  const item = opts.plate ? undefined : itemName(attacker);
  const neutral = move.category === 'special' ? NEUTRAL_SPECIAL_BASE : NEUTRAL_PHYSICAL_BASE;
  const base = opts.flingPower !== undefined || (move.category === 'special' && HALVE_DEFENSE_BASES.has(calc.baseMove)) ? neutral : calc.baseMove;
  return new Move(GEN4, base, {
    ability: NAMES.ability(attacker.ability.value), ...(item !== undefined && { item }), isCrit: opts.isCrit,
    ...(opts.hits !== undefined && { hits: opts.hits }),
    overrides: {
      basePower: opts.flingPower ?? opts.plate?.power ?? hidden?.power ?? move.power,
      type: typeName(opts.plate?.type ?? hidden?.type ?? move.type),
      category: move.category === 'physical' ? 'Physical' : 'Special', priority: move.priority, target: smogonTarget(move.target),
      breaksProtect: !flags.protect,
      flags: { contact: bit(flags.contact), punch: bit(flags.punch), sound: bit(flags.sound), bite: 0, bullet: 0, pulse: 0, slicing: 0, wind: 0 },
      ...(calc.hits !== undefined && { multihit: calc.hits }),
      ...(calc.recoil !== undefined && { recoil: calc.recoil }),
      ...(calc.drain !== undefined && { drain: calc.drain }),
      ...(calc.alwaysCrit && { willCrit: true }),
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The type step in the cartridge's order.

type ChartRow = readonly [defender: number, times10: number];

/**
 * The cartridge's type chart, `sTypeMatchupMultipliers` (src/battle/battle_lib.c:2399-2507, up to the 0xFE marker),
 * by attacking ROM type: each defending type the move is not neutral against and its multiplier ×10 (0, 5 or 20,
 * include/constants/battle.h:144-146), in the chart's row order. The rows after the marker are `GHOST_IMMUNITIES`.
 */
const TYPE_CHART: ReadonlyMap<number, readonly ChartRow[]> = new Map([
  [0, [[5, 5], [8, 5]]], // Normal
  [10, [[10, 5], [11, 5], [12, 20], [15, 20], [6, 20], [5, 5], [16, 5], [8, 20]]], // Fire
  [11, [[10, 20], [11, 5], [12, 5], [4, 20], [5, 20], [16, 5]]], // Water
  [13, [[11, 20], [13, 5], [12, 5], [4, 0], [2, 20], [16, 5]]], // Electric
  [12, [[10, 5], [11, 20], [12, 5], [3, 5], [4, 20], [2, 5], [6, 5], [5, 20], [16, 5], [8, 5]]], // Grass
  [15, [[11, 5], [12, 20], [15, 5], [4, 20], [2, 20], [16, 20], [8, 5], [10, 5]]], // Ice: Fire's row is last
  [1, [[0, 20], [15, 20], [3, 5], [2, 5], [14, 5], [6, 5], [5, 20], [17, 20], [8, 20]]], // Fighting
  [3, [[12, 20], [3, 5], [4, 5], [5, 5], [7, 5], [8, 0]]], // Poison
  [4, [[10, 20], [13, 20], [12, 5], [3, 20], [2, 0], [6, 5], [5, 20], [8, 20]]], // Ground
  [2, [[13, 5], [12, 20], [1, 20], [6, 20], [5, 5], [8, 5]]], // Flying
  [14, [[1, 20], [3, 20], [14, 5], [17, 0], [8, 5]]], // Psychic
  [6, [[10, 5], [12, 20], [1, 5], [3, 5], [2, 5], [14, 20], [7, 5], [17, 20], [8, 5]]], // Bug
  [5, [[10, 20], [15, 20], [1, 5], [4, 5], [2, 20], [6, 20], [8, 5]]], // Rock
  [7, [[0, 0], [14, 20], [17, 5], [8, 5], [7, 20]]], // Ghost: its Ghost row comes after Dark and Steel
  [16, [[16, 20], [8, 5]]], // Dragon
  [17, [[1, 5], [14, 20], [7, 20], [17, 5], [8, 5]]], // Dark
  [8, [[10, 5], [11, 5], [13, 5], [15, 20], [5, 20], [8, 5]]], // Steel
]);

/**
 * The chart's rows after its 0xFE marker (battle_lib.c:2509-2514): Normal and Fighting do nothing to a Ghost. The walk
 * reaches them after every other row, and stops at the marker instead when the defender is identified by Foresight or
 * the attacker has Scrappy (2612-2621).
 */
const GHOST_IMMUNITIES: ReadonlyMap<number, readonly ChartRow[]> = new Map([[0, [[7, 0]]], [1, [[7, 0]]]]);

/** ROM type 2 (generated/pokemon_types.txt), and the Iron Ball's Gen 4 item ID. */
const TYPE_FLYING = 2;
const ITEM_IRON_BALL = 278;

/**
 * What changes the cartridge's chart walk for this attacker and defender:
 * - `ghostRevealed`: Foresight on the defender or Scrappy on the attacker, so the walk stops at the 0xFE marker;
 * - `flyingGrounded`: Gravity, or the defender's Iron Ball (`HOLD_EFFECT_SPEED_DOWN_GROUNDED`, which Klutz takes away),
 *   so the walk skips the Flying immunity row (`BasicTypeMulApplies`, battle_lib.c:2529-2552). Ingrain, Roost and
 *   Miracle Eye, the other cases there, are battle state the calc does not track.
 */
interface ChartRules { ghostRevealed: boolean; flyingGrounded: boolean }

function chartRules(attacker: CalcSide, defender: CalcSide, field: CalcField): ChartRules {
  const defenderAbility = NAMES.ability(defender.mon.ability.value);
  return {
    ghostRevealed: !!defender.foresight || NAMES.ability(attacker.mon.ability.value) === 'Scrappy',
    flyingGrounded: !!field.gravity || (defender.mon.item === ITEM_IRON_BALL && defenderAbility !== 'Klutz'),
  };
}

/**
 * The multipliers ×10 the cartridge applies for a move of ROM type `moveType` against a defender of `types`, in order:
 * `BattleSystem_ApplyTypeChart` (battle_lib.c:2600-2640) walks the rows, the Ghost immunities last unless `rules` reveal
 * the Ghost, and a row matching the defender's first or second type (the second only when it differs from the first)
 * multiplies the damage there and then.
 */
function chartMultipliers(moveType: number, [first, second]: readonly [number, number], rules: ChartRules): number[] {
  const rows = [...(TYPE_CHART.get(moveType) ?? []), ...(rules.ghostRevealed ? [] : GHOST_IMMUNITIES.get(moveType) ?? [])]
    .filter(([type, times10]) => !(rules.flyingGrounded && type === TYPE_FLYING && times10 === 0));
  return rows.flatMap(([type, times10]) => [
    ...(type === first ? [times10] : []), ...(type === second && second !== first ? [times10] : []),
  ]);
}

/**
 * One damage value through the cartridge's type multipliers: each is `ApplyTypeMultiplier` (battle_lib.c:7542-7548),
 * `BattleSystem_Divide(damage * mul, 10)` (3599-3619), which truncates but never takes a nonzero value to 0.
 */
function applyChart(dealt: number, multipliers: readonly number[]): number {
  return multipliers.reduce((value, times10) => (value === 0 || times10 === 0 ? 0 : Math.max(1, Math.floor((value * times10) / 10))), dealt);
}

/**
 * Whether @smogon/calc's type step can differ from the cartridge's on its own: when one type doubles and the other
 * halves. Smogon applies the two in its own fixed order and truncates to 0 on the way; when both multiply alike, or one
 * is neutral or immune, the order changes nothing and a 0 from truncation ends as Smogon's final minimum of 1, as the
 * cartridge's would. The product is then 1, so no modifier after the type step (Filter, Solid Rock, Expert Belt, Tinted
 * Lens, a resist berry) applies either.
 */
const mixedEffectiveness = (multipliers: readonly number[]) => multipliers.includes(20) && multipliers.includes(5) && !multipliers.includes(0);

/**
 * Whether the move is resisted and nothing more (x0.5 or x0.25): with Tinted Lens the cartridge then doubles the
 * damage after the type step (battle_lib.c:2668-2672), so a 1 that Smogon truncated to 0 on the way ends as 1 there
 * and as 2 on the cartridge.
 */
const resistedOnly = (multipliers: readonly number[]) => multipliers.includes(5) && !multipliers.includes(20) && !multipliers.includes(0);

/** Gen 4 for @smogon/calc with every type matchup neutral: its rolls are the damage just before the type step. */
const NEUTRAL_GEN4: typeof GEN4 = {
  ...GEN4,
  types: {
    get: (id) => {
      const type = GEN4.types.get(id);
      return type && { ...type, effectiveness: new Proxy(type.effectiveness, { get: () => 1 }) };
    },
    [Symbol.iterator]: () => GEN4.types[Symbol.iterator](),
  },
};

/** Each hit's 16 rolls from a Smogon result: `count` rows, all zero when Smogon dealt no damage. */
function hitRolls(result: Result, count: number): number[][] {
  const dealt = result.damage;
  if (typeof dealt === 'number') return Array.from({ length: count }, () => Array<number>(16).fill(dealt));
  const rows = (Array.isArray(dealt[0]) ? dealt : [dealt]) as number[][];
  if (rows.length !== count || rows.some((row) => row.length !== 16)) {
    throw new Error(`@smogon/calc gave ${rows.length} hits for ${result.move.name}, expected ${count} of 16 rolls`);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------------
// Odds: hit counts, Psywave, and KO chances.

/**
 * Damage values (or HP left) and their odds, counted exactly: each value's `weights` out of `total`. Every chance is
 * worked out in integers and divided once (`exactChance`), so a certain KO is exactly 1 however many cases it sums.
 */
interface Odds { weights: Map<number, bigint>; total: bigint }

function addWeight(weights: Map<number, bigint>, value: number, weight: bigint): void {
  weights.set(value, (weights.get(value) ?? 0n) + weight);
}

function evenOdds(values: readonly number[]): Odds {
  const weights = new Map<number, bigint>();
  for (const value of values) addWeight(weights, value, 1n);
  return { weights, total: BigInt(values.length) };
}

/** The sum of two independent damages, capped at `cap`: every sum at or past the defender's HP KOs alike. */
function sumOdds(a: Odds, b: Odds, cap: number): Odds {
  const weights = new Map<number, bigint>();
  for (const [x, p] of a.weights) for (const [y, q] of b.weights) addWeight(weights, Math.min(cap, x + y), p * q);
  return { weights, total: a.total * b.total };
}

/**
 * The hit counts of one use and their weights out of `total`. A 2-5 hit move follows the cartridge
 * (`BtlCmd_SetMultiHit`, src/battle/battle_script.c:2634-2659): `rand & 3` below 2 gives 2 or 3 hits, otherwise
 * `(rand & 3) + 2` hits, so 2 and 3 hits are 3/8 each and 4 and 5 hits 1/8 each. Skill Link always gives 5.
 */
function hitOdds(hits: CalcMoveSpec['hits'], skillLink: boolean): { counts: [count: number, weight: bigint][]; total: bigint } {
  if (hits === undefined) return { counts: [[1, 1n]], total: 1n };
  if (typeof hits === 'number') return { counts: [[hits, 1n]], total: 1n };
  if (hits[0] === 2 && hits[1] === 5) return skillLink ? { counts: [[5, 1n]], total: 1n } : { counts: [[2, 3n], [3, 3n], [4, 1n], [5, 1n]], total: 8n };
  throw new Error(`No hit-count odds for ${hits[0]}-${hits[1]} hits`);
}

/**
 * One use's damage odds: for each hit count, the sum of that many hits' rolls, capped at `cap`. All hit counts share
 * one total, the hit-count total times 16 rolls per hit of the most hits.
 */
function useOdds(rows: number[][], hits: ReturnType<typeof hitOdds>, cap: number): Odds {
  const weights = new Map<number, bigint>();
  let sum: Odds = { weights: new Map([[0, 1n]]), total: 1n };
  const most = rows.length;
  for (let hit = 1; hit <= most; hit++) {
    sum = sumOdds(sum, evenOdds(rows[hit - 1]!), cap);
    const weight = hits.counts.find(([count]) => count === hit)?.[1];
    const unrolled = 16n ** BigInt(most - hit);
    if (weight !== undefined) for (const [value, p] of sum.weights) addWeight(weights, value, weight * p * unrolled);
  }
  return { weights, total: hits.total * 16n ** BigInt(most) };
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

/** The largest double below 1. */
const BELOW_ONE = 1 - 2 ** -53;

/**
 * `count / total` as a number: exactly 0 or 1 only when it is, otherwise the nearest double strictly between them,
 * so a chance that is not certain never reads as 1, nor a possible one as 0.
 */
function exactChance(count: bigint, total: bigint): number {
  if (count === 0n) return 0;
  if (count === total) return 1;
  const scale = 2n ** 64n;
  return Math.min(BELOW_ONE, Math.max(Number.MIN_VALUE, Number((count * scale) / total) / 2 ** 64));
}

const USES = 4;

/**
 * The chance that 1 to `USES` uses take the defender from `startHp` to 0. `damageAt(hp)` gives one use's damage odds
 * against a defender on `hp`, so a move that works from the HP left (Super Fang, Endeavor) is followed use by use. The
 * odds stay integer counts throughout (`Odds`), over a common total, and each chance is one division (`koChance`);
 * `koExact` keeps each count and total, reduced.
 */
function koChances(startHp: number, damageAt: (hp: number) => Odds): {
  koChance: NonNullable<DamageResult['koChance']>; koExact: NonNullable<DamageResult['koExact']>;
} {
  let left: Odds = { weights: new Map([[startHp, 1n]]), total: 1n };
  const koChance: NonNullable<DamageResult['koChance']> = [];
  const koExact: NonNullable<DamageResult['koExact']> = [];
  for (let hits = 1; hits <= USES; hits++) {
    const uses = new Map([...left.weights.keys()].filter((hp) => hp > 0).map((hp) => [hp, damageAt(hp)]));
    const common = [...uses.values()].reduce((lcm, odds) => (lcm * odds.total) / gcd(lcm, odds.total), 1n);
    const weights = new Map<number, bigint>();
    for (const [hp, p] of left.weights) {
      const use = uses.get(hp);
      if (use === undefined) addWeight(weights, 0, p * common);
      else for (const [dealt, q] of use.weights) addWeight(weights, Math.max(0, hp - dealt), p * q * (common / use.total));
    }
    left = { weights, total: left.total * common };
    const count = left.weights.get(0) ?? 0n;
    const divisor = gcd(count, left.total);
    koChance.push({ hits, chance: exactChance(count, left.total) });
    koExact.push({ hits, count: count / divisor, total: left.total / divisor });
  }
  return { koChance, koExact };
}

/**
 * Psywave's damages: the cartridge's `Random 10, 5` gives x from 5 to 15, equally likely, and the damage is
 * floor(level × x / 10), at least 1 (res/battle/scripts/effects/effect_script_0088.s:6-11; the AI's estimate in
 * src/battle/trainer_ai/trainer_ai.c:3014-3015 reads `rand % 11 + 5`). That is 11 values, each 1/11.
 */
function psywaveValues(level: number): number[] {
  return Array.from({ length: 11 }, (_, k) => Math.max(1, Math.floor((level * (5 + k)) / 10)));
}

/**
 * Psywave's 11 values spread over the 16 roll slots: slot i holds x = 5 + floor(i × 11 / 16), the value whose 1/11
 * share of the range holds the slot's start. Every value appears; those for x = 5, 7, 9, 11 and 13 appear twice, so the
 * slots are not equally likely values: KO chances use the 11 values, each 1/11.
 */
function psywaveRolls(level: number): number[] {
  const values = psywaveValues(level);
  return Array.from({ length: 16 }, (_, i) => values[Math.floor((i * 11) / 16)]!);
}

/**
 * A fixed-damage move's possible damages (equally likely) against a defender on `hp`: the user's level, a number,
 * half the defender's HP left (at least 1), Psywave's 11 values, or Endeavor's HP difference (0 when the defender has
 * no more HP than the user).
 */
function fixedValues(kind: NonNullable<CalcMoveSpec['fixedDamage']>, attacker: BattleMon, attackerHp: number, hp: number): number[] {
  if (kind === 'level') return [attacker.level];
  if (kind === 'half-hp') return [Math.max(1, Math.floor(hp / 2))];
  if (kind === 'psywave') return psywaveValues(attacker.level);
  if (kind === 'endeavor') return [Math.max(0, hp - attackerHp)];
  return [kind];
}

// ---------------------------------------------------------------------------------------------------------------------

const percentOf = (dealt: number, maxHp: number) => Math.floor((dealt * 1000) / maxHp) / 10;

/** The bracketed notes on a result: what shaped the numbers beyond the plain line. */
function fieldNotes(field: CalcField): string[] {
  const notes: string[] = [];
  if (field.weather !== undefined) notes.push(`in ${field.weather}`);
  if (field.reflect) notes.push('Reflect');
  if (field.lightScreen) notes.push('Light Screen');
  if (field.doubles) notes.push('doubles');
  return notes;
}

/** The abilities that stop a critical hit (Smogon's Gen 4 `isCritical`, mechanics/gen4.js:73). */
const CRIT_BLOCKERS: readonly string[] = ['Battle Armor', 'Shell Armor'];

/**
 * The defender's ability that blocks `attacker`'s crits, or null: Battle Armor or Shell Armor, unless the attacker has
 * Mold Breaker, which Smogon's Gen 4 code lets ignore them (mechanics/gen4.js:68–72).
 */
function critBlocker(attacker: CalcSide, defender: CalcSide): string | null {
  if (NAMES.ability(attacker.mon.ability.value) === 'Mold Breaker') return null;
  const ability = NAMES.ability(defender.mon.ability.value);
  return CRIT_BLOCKERS.includes(ability) ? ability : null;
}

/**
 * The damage `move` does from `attacker` to `defender` on `field`, by Gen 4 rules for the hack, or null for a status
 * or 0-power move.
 * - Everything but fixed damage runs through @smogon/calc's Gen 4 code, on the ROM's power, type, category, priority
 *   and target (`smogonMove`), our base stats, types, IVs, EVs, level, nature, ability and item (`smogonPokemon`), and
 *   the cartridge's flags (`moveFlags`). Hidden Power takes its type and power from the attacker's IVs. A Plate boosts
 *   its type 1.5x, as the hack's item data has it (`plateBoost`), and the Explosion effect halves physical Defense only.
  * - A Metronome item's `CalcSide.metronomeTurns` and a target's `CalcSide.hiding` are state the planning calc has no way to know: both default to none (0 turns, not hiding).
 * - The hit's rolls are `gen4Damage`'s: the cartridge's own order worked out from the decompilation, for every move it
 *   derives: item and ability terms on the raw stat before the stage, each step floored, the power steps in the cartridge's order,
 *   the type chart row by row. Smogon's run still decides an immunity it finds (an absorbing ability, Soundproof) and every move
 *   `gen4Damage` throws for (power from weight, speed, PP or the hit number: Low Kick, Gyro Ball, Triple Kick, Fling, Judgment...).
 * - Fixed damage (`calc.fixedDamage`) bypasses the formula, but a type or ability immunity Smogon finds (a Ghost to
 *   Seismic Toss, Wonder Guard, Soundproof) still makes it 0.
 * - A multi-hit move's KO chances weigh each hit count by the cartridge's odds (`hitOdds`).
 * - An OHKO move (`isOhko`) deals the defender's current HP when it hits and can affect it, so each use's KO chance is
 *   1 or 0 (`DamageResult.ohko`); its accuracy is `hitChance`'s, as for every move.
 * - A Fling runs as a plain hit of its held item's fling power in the ROM's item data (`flingOverride`).
 * - `opts.crit` calcs every hit of every use as a critical hit: `min`, `max`, `percent` and `koChance` are worked out
 *   over the crit rolls by the same odds, and `desc` says "(crit)"; `rolls` and `critRolls` are unchanged. A
 *   fixed-damage or OHKO move cannot crit, so it ignores `crit`. Against Battle Armor or Shell Armor, without Mold
 *   Breaker, no crit lands: the numbers are Smogon's plain hit's, and `desc` says "(crit blocked by Battle Armor)".
 */
export function damage(attacker: CalcSide, defender: CalcSide, move: KaizoMove, field: CalcField, opts: { crit?: boolean } = {}): DamageResult | null {
  if (move.category === 'status' || move.power === 0) return null;
  const atk = sideState(attacker);
  const def = sideState(defender);
  const plate = plateBoost(attacker.mon, defender.mon, move, field);
  const fling = flingOverride(attacker.mon, move);
  const unmodelled = [move.unmodelled, fling?.note ?? null].filter((note) => note !== null).join('; ') || null;
  const smogonFieldFor = () => {
    const smogon = smogonField(field);
    if (plate) smogon.attackerSide.isHelpingHand = true;
    smogon.defenderSide.isForesight = !!defender.foresight;
    return smogon;
  };
  const runOn = (gen: typeof GEN4, isCrit: boolean, hits?: number) => calculate(gen, smogonPokemon(attacker, atk, !!plate), smogonPokemon(defender, def),
    smogonMove(attacker.mon, move, { isCrit, plate, ...(fling !== null && { flingPower: fling.power }), ...(hits !== undefined && { hits }) }), smogonFieldFor());
  const run = (isCrit: boolean, hits?: number) => runOn(GEN4, isCrit, hits);
  const tintedLens = NAMES.ability(attacker.mon.ability.value) === 'Tinted Lens';
  const rules = chartRules(attacker, defender, field);
  /**
   * Each hit's rolls with the type step in the cartridge's order: Smogon's own where they cannot differ, else a run with
   * every matchup neutral (the damage before the type step, after random and STAB as in the cartridge) taken through the
   * chart's multipliers in row order (`applyChart`), then Tinted Lens's x2. They can differ when the types double and
   * halve (`mixedEffectiveness`), or for Tinted Lens on a move resisted and nothing more (`resistedOnly`), unless the
   * defender holds the resist berry for the move's type, which Smogon's neutral run would also apply. The move's type
   * is the one Smogon used (after Normalize, Weather Ball, Judgment, Hidden Power and Natural Gift).
   *
   * Smogon's own 0 is always kept: it deals 0 only for an immunity (a type, the Ghost rows after the
   * chart's marker, Levitate, Wonder Guard, an absorbing ability), which the neutral run would lose.
   */
  /** One hit's 16 rolls from gen4Damage, or null for a move it does not derive (power from weight, speed, PP, the hit number...). */
  const cartridgeRolls = (isCrit: boolean, result: Result): number[] | null => {
    // Smogon's own entry effects (a Download or an Intimidate on entry, `abilityOn`) are boosts it applied to its clones: they are the
    // stages gen4Damage takes, as the planning calc has always assumed them.
    const staged = (side: CalcSide, boosts: Result['attacker']['boosts']): CalcSide => ({ ...side, boosts: { ...side.boosts, atk: boosts.atk, def: boosts.def, spa: boosts.spa, spd: boosts.spd, spe: boosts.spe } });
    try {
      return gen4Damage(staged(attacker, result.attacker.boosts), staged(defender, result.defender.boosts), move, field, isCrit);
    } catch (error) {
      if (error instanceof Gen4DamageUnsupported) return null;
      throw error;
    }
  };
  const typedRolls = (isCrit: boolean, count: number, hits?: number): number[][] => {
    const result = run(isCrit, hits);
    const own = hitRolls(result, count);
    if (own.every((row) => row.every((dealt) => dealt === 0))) return own;
    // The cartridge's own order (gen4Damage, from the decompilation) wherever it derives the move: its stat terms on the raw stat,
    // its power steps and its chart walk, which Smogon's chained or reordered terms round differently. A crit that Battle Armor
    // or Shell Armor stops is a plain hit, as Smogon has it.
    const derived = cartridgeRolls(isCrit && critBlocker(attacker, defender) === null, result);
    if (derived !== null) return Array.from({ length: count }, () => derived);
    const multipliers = chartMultipliers(TYPE_NAMES.indexOf(result.move.type), defender.mon.types, rules);
    const tinted = tintedLens && resistedOnly(multipliers) && getBerryResistType(itemName(defender.mon)) !== result.move.type;
    if (!mixedEffectiveness(multipliers) && !tinted) return own;
    return hitRolls(runOn(NEUTRAL_GEN4, isCrit, hits), count).map((row) => row.map((dealt) => applyChart(dealt, multipliers) * (tinted ? 2 : 1)));
  };

  const notes: string[] = [];
  const hidden = hiddenPowerOf(attacker.mon, move);
  if (hidden) notes.push(`Hidden Power ${TYPE_NAMES[hidden.type]} ${hidden.power}`);

  let rolls: number[];
  let critRolls: number[];
  let min: number;
  let max: number;
  let damageAt: (hp: number) => Odds;
  const ohko = isOhko(move);
  let ohkoLands = false;
  const kind = move.calc.fixedDamage;
  const crit = !!opts.crit && !ohko && kind === undefined;
  if (ohko) {
    // A type or ability immunity Smogon finds (a Ghost to Guillotine, Levitate to Fissure, Wonder Guard) stops it too;
    // `hitChance`'s OHKO rule is 0 for Sturdy and a higher-level defender.
    const immune = Math.max(...hitRolls(run(false), 1)[0]!) === 0;
    ohkoLands = !immune && hitChance(attacker, defender, move, field) > 0;
    const dealt = ohkoLands ? def.hp : 0;
    rolls = Array<number>(16).fill(dealt);
    critRolls = [...rolls];
    [min, max] = [dealt, dealt];
    damageAt = () => evenOdds([dealt]);
    if (ohkoLands) notes.push('OHKO: KO if it hits');
  } else if (kind !== undefined) {
    const immune = Math.max(...hitRolls(run(false), 1)[0]!) === 0;
    const valuesAt = (hp: number) => (immune ? [0] : fixedValues(kind, attacker.mon, atk.hp, hp));
    const values = valuesAt(def.hp);
    rolls = kind === 'psywave' && !immune ? psywaveRolls(attacker.mon.level) : Array<number>(16).fill(values[0]!);
    critRolls = [...rolls];
    [min, max] = [Math.min(...values), Math.max(...values)];
    damageAt = (hp) => evenOdds(valuesAt(hp));
    if (kind === 'psywave' && !immune) notes.push(`Psywave: ${values.join(', ')}, each 1/11`);
  } else {
    const counts = hitOdds(move.calc.hits, NAMES.ability(attacker.mon.ability.value) === SKILL_LINK);
    const most = Math.max(...counts.counts.map(([count]) => count));
    const fewest = Math.min(...counts.counts.map(([count]) => count));
    const hits = move.calc.hits === undefined ? undefined : most;
    const rows = typedRolls(false, most, hits);
    const critRows = typedRolls(true, most, hits);
    rolls = rows[0]!;
    critRolls = critRows[0]!;
    const used = crit ? critRows : rows;
    min = used.slice(0, fewest).reduce((sum, row) => sum + Math.min(...row), 0);
    max = used.reduce((sum, row) => sum + Math.max(...row), 0);
    const perUse = useOdds(used, counts, def.hp);
    damageAt = () => perUse;
    if (most > 1) notes.push(fewest === most ? `${most} hits` : `${fewest}-${most} hits`);
  }

  const bounded = ohko || unmodelled === null;
  if (max === 0 && bounded) notes.push('no effect');
  notes.push(...fieldNotes(field));
  if (unmodelled !== null) notes.push(`unmodelled: ${unmodelled}`);
  const percent: [number, number] = [percentOf(min, def.maxHp), percentOf(max, def.maxHp)];
  const range = bounded ? `${min}-${max} (${percent[0]} - ${percent[1]}%)` : '?';
  const blocker = crit ? critBlocker(attacker, defender) : null;
  const critText = !crit ? '' : blocker === null ? ' (crit)' : ` (crit blocked by ${blocker})`;
  const line = `${attacker.mon.name} ${move.name}${critText} vs. ${defender.mon.name}: ${range}`;
  const { koChance, koExact } = bounded ? koChances(def.hp, damageAt) : { koChance: null, koExact: null };
  return {
    rolls, critRolls, min, max, percent, koChance, koExact, bounded, ohko, unmodelled,
    desc: notes.length === 0 ? line : `${line} [${notes.join('; ')}]`,
  };
}
