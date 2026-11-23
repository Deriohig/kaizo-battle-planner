// The battle field a damage calc runs on, how a docs field note sets it, and the @smogon/calc field it becomes.

import { Field } from '@smogon/calc';
import type { FieldNote } from '../docs/teams.js';

/**
 * The field for a damage calc.
 * - `weather`, `gravity` and `trickRoom` hold for both sides. Trick Room changes turn order, not damage.
 * - `reflect` and `lightScreen` are up on the defender's side.
 * - `doubles` marks a double battle: a move whose ROM target is both foes or every adjacent Pokémon deals 3/4 damage,
 *   and a screen cuts damage by 1/3 instead of 1/2. Without it the battle is a single battle.
 * - `fog` is the battle's deep fog (`FIELD_CONDITION_DEEP_FOG`), which a foggy map sets at the start of the battle
 *   (pokeplatinum battle_lib.c:3684-3687, res/battle/scripts/subscripts/subscript_overworld_fog.s:11). It cuts
 *   accuracy to 6/10 (`hitChance`) and changes no damage.
 */
export interface CalcField {
  weather?: 'rain' | 'sun' | 'sand' | 'hail'; gravity?: boolean; trickRoom?: boolean; reflect?: boolean; lightScreen?: boolean; doubles?: boolean;
  fog?: boolean;
}

/**
 * The field a trainer's docs field note gives: its weather, Trick Room, fog and Gravity. No note gives an empty field.
 * The docs' FOG tag (33 trainers: Hearthome Gym rooms, Clamberclaw Cliffs, Celestic Town and Coronet Highlands) is the
 * battle's deep fog.
 */
export function fieldFromNote(note: FieldNote | null): CalcField {
  const field: CalcField = {};
  if (note?.weather !== undefined) field.weather = note.weather;
  if (note?.trickRoom) field.trickRoom = true;
  if (note?.fog) field.fog = true;
  if (note?.gravity) field.gravity = true;
  return field;
}

const WEATHERS = { rain: 'Rain', sun: 'Sun', sand: 'Sand', hail: 'Hail' } as const;

/** The @smogon/calc field for `field`, seen from the attacker: screens go on the defender's side. */
export function smogonField(field: CalcField): Field {
  return new Field({
    gameType: field.doubles ? 'Doubles' : 'Singles',
    ...(field.weather !== undefined && { weather: WEATHERS[field.weather] }),
    isGravity: !!field.gravity,
    defenderSide: { isReflect: !!field.reflect, isLightScreen: !!field.lightScreen },
  });
}
