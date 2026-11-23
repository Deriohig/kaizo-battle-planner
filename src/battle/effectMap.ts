// The docs' "Additional Effect" texts, sorted by what they do to the damage of a move's own hit, for the damage calc.
// The battle engine extends this (status, stat changes, weather and so on).
//
// Every docs text is in exactly one of three lists, each keyed by `normaliseEffectText`:
// - `EFFECT_MAP`: the text changes a hit's damage or how it lands, and the calc reproduces it, through the spec's fields
//   and a base move whose @smogon/calc mechanics are the text's.
// - `UNMODELLED_EFFECTS`: the text changes damage in some battle state, and the calc can't reproduce that exactly. The
//   spec is the nearest the calc gets (a plain hit when nothing is nearer), and the move's `unmodelled` names the text.
// - `NO_DAMAGE_EFFECTS` (noDamageEffects.ts): the text has no bearing on the damage of the move's own hit.
// A text in none of them (a new docs effect) also calcs as a plain hit and is reported as unmodelled.
//
// The docs warn that moves exported from the game can show effects they don't have, so these texts, never the ROM's
// effect IDs, decide behaviour. A base move named here is used only when the move's own name isn't a
// Smogon move with these mechanics (`buildMoves`). Behaviour the docs don't spell out is vanilla Gen 4: every move here
// that the Move Changes tab doesn't list (Weather Ball, Solar Beam, Punishment...) is unchanged from vanilla.

import type { CalcMoveSpec } from './moves.js';

/** An effect text as the lists key it: trimmed, inner spacing collapsed to one space, lower case. */
export function normaliseEffectText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** `entries` keyed by normalised text. Two texts that normalise alike throw, so no entry hides another. */
export function byEffectText<T>(entries: Record<string, T>): Record<string, T> {
  const keyed: Record<string, T> = {};
  for (const [text, value] of Object.entries(entries)) {
    const key = normaliseEffectText(text);
    if (key in keyed) throw new Error(`Two effect texts normalise to "${key}"`);
    keyed[key] = value;
  }
  return keyed;
}

/** The texts that change a hit's damage or how it lands, which the calc reproduces. */
export const EFFECT_MAP: Record<string, Partial<CalcMoveSpec>> = byEffectText<Partial<CalcMoveSpec>>({
  // Multi-hit: each hit is a full hit.
  'Hits twice': { hits: 2 },
  'Hits twice; chance to poison': { hits: 2 },
  'Hits target 2-5 times': { hits: [2, 5] },

  // Recoil, as a fraction of the damage dealt. "fixed AI" and "VANILLA AI" are about the trainer AI, not the damage.
  '1/2 damage dealt recoil, fixed AI': { recoil: [1, 2] },
  '1/2 damage dealt recoil, VANILLA AI': { recoil: [1, 2] },
  '1/3 damage dealt recoil': { recoil: [1, 3] },
  '1/4 damage dealt recoil': { recoil: [1, 4] },
  'Chance of causing Burn; 1/3 damage dealt recoil': { recoil: [1, 3] },
  'Chance of causing Paralysis; 1/3 damage dealt recoil': { recoil: [1, 3] },

  // Drain. Dream Eater's "sleeping target" is a condition for the move to work, not a change to its damage.
  'Damages target; heals user up to 50% of damage dealt': { drain: [1, 2] },
  'Damages sleeping target; heals user up to 50% of damage dealt': { drain: [1, 2] },

  // High crit ratio: crit stage +1.
  'High crit ratio': { critStage: 1 },
  'Chance of causing Burn; increased Crit ratio': { critStage: 1 },
  'Chance of causing Poison; increased crit ratio': { critStage: 1 },
  'Charging turn; high crit ratio': { critStage: 1 },

  // Never misses: no accuracy check, so accuracy and evasion stages don't matter.
  'Always hits': { ignoresAccuracy: true },

  // Fixed or level damage, which `fixedDamage` gives instead of the formula.
  'Inflicts 20 damage': { baseMove: 'Sonic Boom', fixedDamage: 20 },
  'Deals 40 damage': { baseMove: 'Dragon Rage', fixedDamage: 40 },
  'Deals damage equal to user\'s level': { baseMove: 'Seismic Toss', fixedDamage: 'level' },
  'Deals damage equal to 1/2 target\'s current hp': { baseMove: 'Super Fang', fixedDamage: 'half-hp' },
  'Target\'s HP becomes equal to the user\'s current HP': { baseMove: 'Endeavor', fixedDamage: 'endeavor' },

  // Variable power or type, which the calc's Gen 4 code works out by base-move name from what it knows: HP, status,
  // weight, weather and the held item.
  '2x power if target is at or below 1/2 HP': { baseMove: 'Brine' },
  '2x power if user is Poisoned; Paralyzed; or Burned.': { baseMove: 'Facade' },
  '2x power if target is asleep; wakes up target': { baseMove: 'Wake-Up Slap' },
  'Higher power the less HP the user has': { baseMove: 'Flail' },
  'Power= Base power x(user\'s current HP/ user\'s max HP)': { baseMove: 'Water Spout' },
  'Inflicts greater damage on heavier targets': { baseMove: 'Low Kick' },
  'Type changes to match weather': { baseMove: 'Weather Ball' }, // vanilla, so power doubles in weather too
  'Type= Type of Plate held by user': { baseMove: 'Judgment' },
  'Natural Gift effect': { baseMove: 'Natural Gift' },
  'Power and effect determined by held item': { baseMove: 'Fling' },
  // The calc's Gen 4 code has no Hidden Power case: the calc wrapper sets the type and power from `hiddenPower(ivs)`.
  'Hidden Power effect': { baseMove: 'Hidden Power' },

  // Other mechanics the calc takes from the base move.
  'Pursuit effect': { baseMove: 'Pursuit' }, // 2x power against a switching target
  'Removes Light Screen/ Reflect from target\'s side of the field': { baseMove: 'Brick Break' }, // screens go first
  'Charging turn unless in Harsh Sunlight': { baseMove: 'Solar Beam' }, // vanilla, so half power in rain, sand or hail
  'Selfdestruct/ Explosion effect': { baseMove: 'Explosion' }, // halves the target's Defense
  'Struggle effect': { baseMove: 'Struggle' }, // typeless
  'Future Sight effect': { baseMove: 'Future Sight' }, // typeless in Gen 4
  'Can only hit targets that have used Protect/ Detect': { baseMove: 'Feint' }, // hits through Protect
  'Shadow Force effect': { baseMove: 'Shadow Force' }, // hits through Protect
  'Deals 1/2 user\'s max HP to user if it misses': { baseMove: 'Jump Kick' }, // crash damage, which Reckless boosts
});

/**
 * The texts that change damage in some battle state the calc can't reproduce exactly. Each spec is the nearest the
 * calc gets; `{}` is a plain hit.
 */
export const UNMODELLED_EFFECTS: Record<string, Partial<CalcMoveSpec>> = byEffectText<Partial<CalcMoveSpec>>({
  // The calc gets close but not exact.
  '2x Power if user moves after target': { baseMove: 'Payback' }, // the calc judges turn order by Speed alone, not priority or Trick Room
  'Power = min(150; (25 x Target\'s Current Speed / User\'s Current Speed) + 1)': { baseMove: 'Gyro Ball' }, // the calc's Gen 4 formula lacks the + 1
  'Power= 60 + (20x # of stat increases of target)': { baseMove: 'Punishment' }, // the calc counts no accuracy or evasion boosts

  // Doubled power in a state the calc doesn't know.
  '2x damage if the target has already taken damage this turn': {},
  '2x Damage on Pokemon using Bounce/Fly': {}, // Fly still has its semi-invulnerable turn in the hack
  'Causes flinch and 2x damage if target has used Minimize': {},
  '2x power if target is Paralyzed; cures target of Paralysis': {}, // the calc's Gen 4 code has no case for it

  // Damage from something other than the formula on the move's numbers.
  '2x last amount of damage received': {},
  'Damage= 1.5x damage dealt by the target\'s last attack': {},
  'Mirror Coat effect': {},
  'OHKO': {},
  'Beat Up effect': {},
  'Present Effect': {},
  'The less PP the move has; the greater its Power': {}, // Trump Card: the ROM gives it 1 PP
  'Hits the target up to 3 times; increases power by 10 with each hit': {},
  'False Swipe effect': {}, // can't KO

  // The docs give Thief Splash's effect, so whether it still deals damage is unknown.
  'Splash effect': {},

  // Uses another move, whose damage the calc can't know from this one.
  'Metronome effect': {},
  'Assist effect': {},
  'Mirror Move effect': {},
  'Sleep Talk effect': {},
  'User uses the last move that was used in battle': {},
  'If the target has not moved yet; the user copies their move and uses it with 1.5x power': {},
  'Nature Power effect': {},
});
