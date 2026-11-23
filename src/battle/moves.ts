// The hack's moves as the planner uses them: the ROM's numbers, the docs' name and effect text, and how the
// damage calc runs each one.

import { Dex } from '@pkmn/dex';
import { Generations, toID } from '@smogon/calc';
import type { DocMove } from '../docs/types.js';
import type { MoveCategory, MoveRecord, Stats } from '../rom/types.js';
import { EFFECT_MAP, normaliseEffectText, UNMODELLED_EFFECTS } from './effectMap.js';
import { NO_DAMAGE_EFFECTS } from './noDamageEffects.js';
import type { LoadedData } from './types.js';

/** How the damage calc runs a move, on top of the ROM's power, type, category and priority. */
export interface CalcMoveSpec {
  /**
   * The Gen 4 @smogon/calc move the calc runs, overridden with the ROM's numbers: the move's own name when Smogon's
   * move has the docs' mechanics, else the base an effect list names for them, else Tackle (physical), Swift (special)
   * or Splash (status). "Hidden Power" takes its type and power from `hiddenPower(ivs)`, which the calc doesn't do.
   */
  baseMove: string;
  /** Hits per use: a number, or [min, max] for a random count. */
  hits?: number | [number, number];
  /** The fraction of the damage dealt that the user takes back. */
  recoil?: [number, number];
  /** The fraction of the damage dealt that the user regains. */
  drain?: [number, number];
  /** The crit stage the move adds: 1 for a high crit ratio. */
  critStage?: number;
  /** The damage instead of the formula: a number, the user's level, half the target's current HP, Psywave's range, or Endeavor's HP difference. */
  fixedDamage?: 'level' | number | 'half-hp' | 'psywave' | 'endeavor';
  /** Always a critical hit. */
  alwaysCrit?: boolean;
  /** Never misses: no accuracy check. */
  ignoresAccuracy?: boolean;
  /**
   * For a move that runs as Fling: its power by the held item's ID (0 to 467), the ROM's item data (`RomData.items`),
   * which the cartridge reads (`Battler_ItemFlingPower`). `buildMoves` sets it; without it, or for an item
   * past it, the calc knows no power and the result is unbounded.
   */
  flingPower?: readonly number[];
}

/**
 * A move of the hack. The numbers (power, type, accuracy, PP, priority, category, effect chance, target, flags) are
 * the ROM's, and so is `romEffect`, its effect ID, which the trainer AI scores by. The name and `effectText` are the
 * docs' (Moves tab, by ID), and the effect text, never `romEffect`, decides behaviour. `unmodelled` is the effect text
 * when the calc can't reproduce the effect's damage, and null otherwise; the calc then runs `calc`, the nearest it gets.
 */
export interface KaizoMove {
  id: number; name: string; type: number; category: MoveCategory; power: number; accuracy: number; pp: number; priority: number;
  effectChance: number; target: number; flags: number; romEffect: number; effectText: string; calc: CalcMoveSpec; unmodelled: string | null;
}

const GEN4 = Generations.get(4);
const DEX4 = Dex.forGen(4);
type SmogonMove = NonNullable<ReturnType<typeof GEN4.moves.get>>;

/** The base for a move whose own name won't do and whose effect names no base. */
const NEUTRAL_BASES: Record<MoveCategory, string> = { physical: 'Tackle', special: 'Swift', status: 'Splash' };

/** Old docs spellings that `toID` doesn't bridge to Smogon's names ("DoubleSlap" and "Selfdestruct" it does). */
const OLD_NAMES: Record<string, string> = {
  ViceGrip: 'Vise Grip', 'Hi Jump Kick': 'High Jump Kick', 'Faint Attack': 'Feint Attack', SmellingSalt: 'Smelling Salts',
};

/**
 * Gen 4 Smogon moves whose damage is not the plain formula on the move's numbers, each keyed to a name shared by the
 * moves with the same mechanics. They come from @smogon/calc 0.12.0's Gen 4 code, which works these out by move name
 * (mechanics/gen4.js, mechanics/util.js, move.js), plus the calc wrapper's own: fixed damage and Hidden Power. Breaking
 * Protect and crash damage come from the move data instead. Status moves are left out, as the calc never runs one.
 * Fire Fang's quirk of hitting through Wonder Guard is left out too: it belongs to Fire Fang itself, which the hack
 * leaves unchanged.
 */
const MECHANICS: Record<string, string> = {
  Brine: 'Brine', Eruption: 'Water Spout', 'Water Spout': 'Water Spout', Facade: 'Facade', Flail: 'Flail', Reversal: 'Flail',
  Fling: 'Fling', 'Low Kick': 'Low Kick', 'Grass Knot': 'Low Kick', 'Gyro Ball': 'Gyro Ball', Payback: 'Payback',
  Punishment: 'Punishment', Pursuit: 'Pursuit', 'Wake-Up Slap': 'Wake-Up Slap', 'Crush Grip': 'Wring Out',
  'Wring Out': 'Wring Out', 'Triple Kick': 'Triple Kick', 'Weather Ball': 'Weather Ball', Judgment: 'Judgment',
  'Natural Gift': 'Natural Gift', 'Brick Break': 'Brick Break', 'Solar Beam': 'Solar Beam', Explosion: 'Explosion',
  'Self-Destruct': 'Explosion', 'Seismic Toss': 'Seismic Toss', 'Night Shade': 'Seismic Toss', 'Dragon Rage': 'Dragon Rage',
  'Sonic Boom': 'Sonic Boom', Struggle: 'Struggle', 'Future Sight': 'Future Sight', 'Doom Desire': 'Future Sight',
  'Super Fang': 'Super Fang', Endeavor: 'Endeavor', Psywave: 'Psywave', 'Hidden Power': 'Hidden Power',
};

const smogonMove = (name: string): SmogonMove | undefined => GEN4.moves.get(toID(name));
const isStatus = (move: SmogonMove) => (move.category ?? 'Status') === 'Status';

/** `map[key]` if `map` has its own `key` (so "constructor" finds nothing). */
const entry = <T>(map: Record<string, T>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

/** A fraction to two places, so Smogon's 33/100 recoil and the docs' 1/3 compare equal; 0 for none. */
const fraction = (pair: readonly number[] | undefined) => (pair ? Math.round((pair[0]! / pair[1]!) * 100) / 100 : 0);

/**
 * What decides a damaging hit's mechanics, as a string to compare: hits, recoil, drain, crit stage, always-crit,
 * never-miss, and from `base` (a Smogon move), breaking Protect, crash damage and `MECHANICS`.
 */
function mechanics(base: SmogonMove | undefined, hits: number | readonly number[] | undefined, recoil: readonly number[] | undefined,
  drain: readonly number[] | undefined, critStage: number, alwaysCrit: boolean, neverMisses: boolean): string {
  return JSON.stringify([hits ?? 1, fraction(recoil), fraction(drain), critStage, alwaysCrit, neverMisses, !!base?.breaksProtect,
    !!base?.hasCrashDamage, (base && entry(MECHANICS, base.name)) ?? null]);
}

/**
 * The move's own Smogon name, if Smogon's Gen 4 move by that name has the mechanics `spec` gives it, else null. A
 * status move needs only a status namesake. An accuracy of 0 in the ROM means the move never misses.
 */
function ownBase(name: string, rom: MoveRecord, spec: Partial<CalcMoveSpec>): string | null {
  const own = smogonMove(entry(OLD_NAMES, name) ?? name);
  if (own === undefined || isStatus(own) !== (rom.category === 'status')) return null;
  if (rom.category === 'status') return own.name;
  const dex = DEX4.moves.get(own.name);
  const theirs = mechanics(own, own.multihit, own.recoil, own.drain, (dex.critRatio ?? 1) - 1, !!own.willCrit, dex.accuracy === true);
  const specBase = spec.baseMove === undefined ? undefined : smogonMove(spec.baseMove);
  const ours = mechanics(specBase, spec.hits, spec.recoil, spec.drain, spec.critStage ?? 0, !!spec.alwaysCrit, !!spec.ignoresAccuracy || rom.accuracy === 0);
  return theirs === ours ? own.name : null;
}

/**
 * `MECHANICS` the calc applies as the cartridge does in either damage class. The Explosion effect halves the physical
 * Defense stat only (battle_lib.c:6943-6945), and a special move divides by Special Defense, so the calc runs a
 * special move on an Explosion base as a plain special hit (src/calc/calc.ts `smogonMove`): the special Memento.
 */
const EITHER_CLASS_MECHANICS: ReadonlySet<string> = new Set(['Explosion']);

/**
 * Whether the base's mechanics are borrowed into the other damage class, where the game may not apply them the same
 * way (Facade's doubling skips only a physical move's burn halving), unless the calc applies them as the game does in
 * either class (`EITHER_CLASS_MECHANICS`). Fixed damage ignores the class.
 */
function otherClass(baseMove: string, rom: MoveRecord, spec: Partial<CalcMoveSpec>): boolean {
  if (rom.category === 'status' || spec.fixedDamage !== undefined) return false;
  const base = smogonMove(baseMove);
  const mechanic = base && entry(MECHANICS, base.name);
  if (base === undefined || mechanic === undefined || EITHER_CLASS_MECHANICS.has(mechanic)) return false;
  return base.category !== (rom.category === 'physical' ? 'Physical' : 'Special');
}

/** A ROM move with its docs row (undefined when the docs lack it). */
function kaizoMove(rom: MoveRecord, doc: DocMove | undefined): KaizoMove {
  const name = doc?.name ?? `(move ${rom.id})`;
  const effectText = doc?.effectText ?? '';
  const key = normaliseEffectText(effectText);
  const mapped = entry(EFFECT_MAP, key);
  const spec = mapped ?? entry(UNMODELLED_EFFECTS, key) ?? {};
  const baseMove = ownBase(name, rom, spec) ?? spec.baseMove ?? NEUTRAL_BASES[rom.category];
  let unmodelled: string | null = mapped !== undefined || NO_DAMAGE_EFFECTS.has(key) ? null : effectText;
  if (mapped !== undefined && otherClass(baseMove, rom, spec)) unmodelled = effectText;
  if (doc === undefined) unmodelled = `No docs row for move ${rom.id}`;
  else if (key === '') unmodelled = `No effect text in the docs for move ${rom.id}`;
  return {
    id: rom.id, name, type: rom.type, category: rom.category, power: rom.power, accuracy: rom.accuracy, pp: rom.pp,
    priority: rom.priority, effectChance: rom.effectChance, target: rom.target, flags: rom.flags, romEffect: rom.effect,
    effectText, calc: { ...structuredClone(spec), baseMove }, unmodelled,
  };
}

/**
 * Every move in the ROM's move table by ID, except entry 0 (the table's empty slot). A ROM move the docs lack is named
 * "(move <id>)", calcs on its neutral base, and its `unmodelled` says the docs lack it; a blank docs effect cell is
 * reported the same way, so `unmodelled` is never an empty string. A move that runs as Fling carries the ROM's fling
 * power of every item (`CalcMoveSpec.flingPower`).
 */
export function buildMoves(data: LoadedData): Map<number, KaizoMove> {
  const docs = new Map(data.docs.moves.map((row) => [row.id, row]));
  const flingPower: number[] = [];
  for (const item of data.rom.items) flingPower[item.id] = item.flingPower;
  const moves = new Map<number, KaizoMove>();
  for (const rom of data.rom.moves) {
    if (rom === undefined || rom.id === 0) continue;
    const move = kaizoMove(rom, docs.get(rom.id));
    if (move.calc.baseMove === 'Fling') move.calc.flingPower = flingPower;
    moves.set(rom.id, move);
  }
  return moves;
}

/** Hidden Power's types in Gen 4 order (Fighting to Dark, without Normal and "???"), as ROM type IDs. */
const HIDDEN_POWER_TYPES = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17];

/**
 * Hidden Power's type (a ROM type ID) and power (30 to 70) for these IVs, by the Gen 4 formula. The game reads the IVs
 * as HP, Atk, Def, Spe, SpA, SpD: the type comes from each IV's lowest bit, the power from its second bit.
 */
export function hiddenPower(ivs: Stats): { type: number; power: number } {
  const order = [ivs.hp, ivs.atk, ivs.def, ivs.spe, ivs.spa, ivs.spd];
  const bits = (shift: number) => order.reduce((sum, iv, k) => sum + (((iv >> shift) & 1) << k), 0);
  return { type: HIDDEN_POWER_TYPES[Math.floor((bits(0) * 15) / 63)]!, power: Math.floor((bits(1) * 40) / 63) + 30 };
}
