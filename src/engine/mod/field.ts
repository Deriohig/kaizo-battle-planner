// The trainer's field conditions at battle start: weather, fog, Trick Room and Gravity, from the docs'
// field note (`FieldNote`, the contract's `FieldSpec`). Citations are pokeplatinum (bl = src/battle/battle_lib.c,
// bcp = src/battle/battle_controller_player.c, scripts under res/battle/scripts/subscripts/) and the hack ROM's overlay 16
// and battle-script NARC (battle/skill/sub_seq.narc), diffed against vanilla's (docs/engine-spot-checks.md).
//
// How the cartridge starts them: the map's weather (`BattleSystem_GetFieldWeather`) is read once, as the first state of the
// first switch-in sequence (`SWITCH_IN_CHECK_STATE_FIELD_WEATHER`, bl:3663-3716), before the leads' Trace and weather
// abilities (:3719-3780). Each case runs a subscript:
// - rain, hail and harsh sun (`subscript_overworld_rain`, `_hail`, `_sun`) set `FIELD_CONDITION_RAINING_PERM`, `_HAILING_PERM`
//   and `_SUNNY_PERM` and no `weatherTurns`: the `_PERM` bit never counts down (bcp:1115-1121 and its three siblings). Sand
//   (`_sand`) likewise. The docs write these "RAIN", "PERMANENT RAIN", "HAIL", "SUN" and so on: all are the map's weather.
// - fog (`subscript_overworld_fog`) sets `FIELD_CONDITION_DEEP_FOG`: a hit rate of × 6 / 10 unless Cloud Nine or Air Lock
//   is out (bcp:2923-2937), nothing else but a message each turn (bcp:1213-1224). Defog clears it (`subscript_defog.s:12, :64`).
// - Trick Room (the hack's map weather 18) runs `subscript_overworld_trick_room`, which sets `FIELD_CONDITION_TRICK_ROOM_INIT`
//   (a counter of 5); Gravity (the hack's map weather 12) runs the hack's new subscript 297, which plays Gravity's animation
//   and sets `FIELD_CONDITION_GRAVITY_INIT`, then grounds whatever floats (nothing does at the start). Both count down at the
//   end of each turn (bcp:1226-1235, :1822-1830), and the hack rewrote the subscripts they call when the count ends (238 for
//   Gravity, 251 for Trick Room) to set the condition again: so they never end, unless the Trick Room move toggles the room
//   off (effect_script_0259.s:3, :14), which Showdown's Trick Room does too. The same re-arm
//   doesn't ask what set the condition, so the move's Gravity and Trick Room never end either (`KAIZO_FIELD_CONDITIONS`).
// The cartridge's map holds one weather, so a note naming more than one of the four is unmodelled (`FIELD_COMBINATION_NOTE`).
//
// The deep fog is a weather bit: `FIELD_CONDITION_WEATHER` includes `FIELD_CONDITION_DEEP_FOG` (condition.h:131-135), so
// everything that sets a weather clears it first (the engine kept its flag forever before):
// - Rain Dance, Sunny Day, Sandstorm and Hail: `UpdateVar OPCODE_FLAG_OFF, BTLVAR_FIELD_CONDITIONS, FIELD_CONDITION_WEATHER`
//   once past their fail check (effect_script_0136.s:8, _0137.s:8, _0115.s:8, _0164.s:8);
// - Drizzle, Drought, Sand Stream and Snow Warning at switch-in: the same command in their subscripts (subscript_drizzle.s:11,
//   subscript_drought.s:11, subscript_sand_stream.s:11, subscript_snow_warning.s:12), run unless their own weather is
//   permanent already (bl:3740-3780), which under fog it never is;
// - Defog: `subscript_defog.s:64-65` clears the bit when it is set, with "{0} blew away the deep fog with {1}!" (:66-67).
//   Every branch above it reaches that line: the side-condition checks at :5-13 only choose whether the attack message
//   plays, and the evasion drop is a `Call` that returns (`BtlCmd_End` pops the script, battle_script.c:9459-9463).
// Nothing else writes the bit (`grep DEEP_FOG`: only the reads at bcp:1213-1224 and :2935, and the trainer AI's): a
// weather's end clears its own `_TEMP` bit alone. In the engine a successful `Field.setWeather` is exactly a weather move or
// a weather ability taking effect (`KAIZO_FIELD_SCRIPTS`), and Defog's own callback clears it (mod/moves.ts). The hack's
// effect scripts and subscripts are vanilla's here: it changes only effects 48, 88, 104, 141 and 182 and subscripts 238,
// 251 and 297 (src/ai/battleScripts.ts `HACK_CHANGED_EFFECTS`, `HACK_CHANGED_SUBSCRIPTS`, test/real/aiBattleScripts.test.ts).
// What reads the fog: the hit rate (mod/accuracy.ts), SolarBeam's halving (`FIELD_CONDITION_SOLAR_DOWN`, bl:7058; mod/damage.ts),
// Weather Ball's doubled power (any `FIELD_CONDITION_WEATHER`, bs:6847-6850, its type staying the ROM's: bl:7894-7911) and
// Synthesis, Moonlight and Morning Sun's quarter heal (`NO_WEATHER` false, bs:5970-5976) (mod/moves.ts), each unless Cloud
// Nine or Air Lock is out (`fogCounts`).
//
// A weather ability replaces the field weather unless that is its own weather, permanent already (bl:3740-3780 test only
// `FIELD_CONDITION_RAINING_PERM`, `_SANDSTORM_PERM`, `_SUNNY_PERM` and `_HAILING_PERM`): Showdown's Gen 4 `setWeather`
// refuses the same weather from an ability only when its duration is 0 (sim/field.ts:45-48), which is the permanent weather
// set here, so the ability rules need nothing more. Rain Dance, Sunny Day and Sandstorm fail under the same weather in
// either kind (`FIELD_CONDITION_RAINING` and so on cover both bits); Hail checks only the temporary bit and starts five turns
// of hail under a permanent one (mod/moves.ts `hailOnTry`).

import PS from 'pokemon-showdown';
import type { FieldSpec } from '../../contracts/engine.js';
import { addUnmodelledNote } from '../unmodelled.js';
import { resortMoveFirst } from './speedOrder.js';

/** `formatData` key: the trainer's field spec (`BattleInput.field`), as given; `battleField(state)` reads it. */
export const FIELD_KEY = 'kaizoField';

/**
 * `formatData` key: true while the deep fog is up, absent once a weather or Defog cleared it (`clearFog`). Nothing in
 * Showdown is fog; `fogCounts` reads this.
 */
export const FOG_KEY = 'kaizoFog';

/**
 * Whether the deep fog is up and counts: its bit is set and no Cloud Nine or Air Lock is out (`NO_CLOUD_NINE`, the gate
 * of every read: bcp:2923, bl:7046, bs:6847, and `NO_WEATHER` at bs:5970).
 */
export function fogCounts(battle: Battle): boolean {
  return battle.formatData[FOG_KEY] === true && !battle.field.suppressingWeather();
}

/** Clears the deep fog's bit; whether it was set. */
export function clearFog(battle: Battle): boolean {
  if (battle.formatData[FOG_KEY] !== true) return false;
  delete battle.formatData[FOG_KEY];
  return true;
}

type SetWeather = (this: Battle['field'], status: string | Condition, source?: Pokemon | 'debug' | null, sourceEffect?: Effect | null) => boolean | null;

/**
 * The mod's `Field` scripts (dex.ts, the `Scripts` table's `field`): Showdown's `setWeather`, which, when it sets a
 * weather, clears the deep fog, as every weather move and weather ability does on the cartridge (the top of this file).
 * A weather move into its own weather fails in both, and clears nothing.
 */
export const KAIZO_FIELD_SCRIPTS: Record<string, unknown> = {
  setWeather(this: Battle['field'], status: string | Condition, source?: Pokemon | 'debug' | null, sourceEffect?: Effect | null): boolean | null {
    const showdown = (Object.getPrototypeOf(this) as { setWeather: SetWeather }).setWeather;
    const result = showdown.call(this, status, source, sourceEffect);
    if (result) clearFog(this.battle);
    return result;
  },
};

/** The note for a field note with more than one of weather, fog, Trick Room and Gravity: the map's weather is one. */
export const FIELD_COMBINATION_NOTE = 'engine: a field note names more than one overworld weather (the cartridge\'s map holds one)';

const WEATHER_IDS = { rain: 'raindance', sun: 'sunnyday', sand: 'sandstorm', hail: 'hail' } as const;

/**
 * Starts the battle's field conditions: the format's `onBattleStart` (dex.ts), which Showdown runs after `|start|` and
 * before the leads switch in, as the cartridge's field weather comes before the abilities. Weather is Showdown's own with
 * its duration 0 (no end, as an ability's Gen 4 weather has), which logs the plain `|-weather|` line the trainer AI's
 * memory keeps permanent weather from. Trick Room and Gravity are the move's conditions with duration 0; fog is a flag.
 */
export function applyField(this: Battle): void {
  const spec = (this.formatData[FIELD_KEY] ?? {}) as FieldSpec;
  const named = [spec.weather !== undefined, !!spec.fog, !!spec.trickRoom, !!spec.gravity].filter(Boolean).length;
  if (named > 1) addUnmodelledNote(this, FIELD_COMBINATION_NOTE);

  if (spec.weather !== undefined) {
    // `Field.setWeather` needs a source for the weather's `durationCallback`; the map has none, and the weather has no end,
    // so its steps are taken here: the weather, its state with duration 0, the plain `FieldStart` line, `WeatherChange`.
    const status = this.dex.conditions.get(WEATHER_IDS[spec.weather]);
    this.field.weather = status.id;
    this.field.weatherState = this.initEffectState({ id: status.id, duration: 0 });
    this.singleEvent('FieldStart', status, this.field.weatherState, this.field, null, null);
    this.eachEvent('WeatherChange');
  }
  if (spec.fog) this.formatData[FOG_KEY] = true;
  if (spec.trickRoom) {
    this.field.pseudoWeather['trickroom'] = this.initEffectState({ id: 'trickroom', source: null, sourceSlot: undefined, duration: 0 });
    this.add('-fieldstart', 'move: Trick Room'); // Showdown's own line would name a source, `[of] null`
  }
  if (spec.gravity) {
    const state = this.field.pseudoWeather['gravity'] = this.initEffectState({ id: 'gravity', source: null, sourceSlot: undefined, duration: 0 });
    this.singleEvent('FieldStart', this.dex.conditions.get('gravity'), state, this.field, null, null);
  }
}

/**
 * Gravity and Trick Room from a move last the whole battle too. The cartridge runs the expiry subscript when the counter
 * reaches 0 (bcp:1226-1235, :1822-1830) without asking what set it, and the hack's subscript 238 (Gravity) starts with
 * `UpdateVar FLAG_ON GRAVITY_INIT` and 251 (Trick Room), run with the room already off, falls through to
 * `UpdateVar FLAG_ON TRICK_ROOM_INIT` (sub_seq.narc, diffed against vanilla's). So the move's condition has duration 0, as the
 * start's. Trick Room used again still toggles it off (effect_script_0259.s).
 */
const GEN4_MOVES = PS.Dex.mod('gen4').data.Moves as unknown as Record<string, { condition?: Record<string, unknown> }>;
const forever = (id: string) => ({ ...GEN4_MOVES[id]!.condition!, duration: 0, durationCallback: () => 0 });

type FieldHandler = (this: Battle, ...args: unknown[]) => unknown;
const GEN4_TRICK_ROOM = GEN4_MOVES['trickroom']!.condition! as { onFieldStart: FieldHandler; onFieldRestart: FieldHandler };

/**
 * The move's Trick Room toggles the room either way (Showdown's `onFieldStart`, and `onFieldRestart`, which removes it),
 * and then the cartridge re-sorts the turn, which sets Quick Claw and Custap flags again (speedOrder.ts `resortMoveFirst`).
 * The field note's room is set directly at the start (`applyField`) and calls neither.
 */
const trickRoom = {
  ...forever('trickroom'),
  onFieldStart(this: Battle, ...args: unknown[]) {
    GEN4_TRICK_ROOM.onFieldStart.apply(this, args);
    resortMoveFirst(this);
  },
  onFieldRestart(this: Battle, ...args: unknown[]) {
    GEN4_TRICK_ROOM.onFieldRestart.apply(this, args);
    resortMoveFirst(this);
  },
};

export const KAIZO_FIELD_CONDITIONS: Record<string, Record<string, unknown>> = { gravity: forever('gravity'), trickroom: trickRoom };
