// The `platkaizo` mod's move draws: the callbacks of Showdown's Gen 4 moves whose random draws the
// cartridge makes differently, or makes at all, each as a labelled pick with the cartridge's u16 weights. They are keyed
// by behaviour source (the Showdown move a hack move runs, `KaizoMove.calc.baseMove`): dex.ts lays them over every hack
// move that runs its source's Showdown data (an `inherit` or not-yet-modelled effect, effects.ts; a move whose
// behaviour the engine builds from the docs' text takes none), and over Showdown's own entry of that ID. Citations are
// pokeplatinum (bs = src/battle/battle_script.c, bl = src/battle/battle_lib.c, scripts under res/battle/scripts/).
//
// | Move              | Cartridge                                                     | Label                       |
// |-------------------|---------------------------------------------------------------|-----------------------------|
// | Metronome         | (r % 467) + 1 until allowed (bs:4537-4560, bl:7152-7210)      | `pick`, the move's ID       |
// | Magnitude         | r % 100 against 5, 15, 35, 65, 85, 95 (bs:5821-5853)          | `pick`, the magnitude       |
// | Present           | r & 0xFF against 102, 178, 204, else heal (bs:5789-5808)      | `pick`, `40` … `heal`       |
// | Psywave           | x = r % 11 + 5, level × x / 10, at least 1 (effect_script_0088.s) | `pick`, the damage      |
// | Roar, Whirlwind   | the level check (bl:3073-3087), then a party slot r % size until valid (bs:5296-5310) | `hit`, `switchTarget` |
// | Tri Attack        | r % 3 + 3 picks burn, freeze or paralysis (effect_script_0036.s) | `effect`                 |
// | Sleep Talk        | r % 4 over the move slots until valid (bs:4907-4939)          | `pick`, the move's ID       |
// | Uproar            | using it wakes no one (the uproar condition does, mod/conditions.ts) | none                 |
// | Struggle          | recoil max HP / 4, rounded toward zero (subscript_struggle.s): Showdown's Gen 4 already | none |
// | Assist (9b)       | r % count over the other members' callable moves (bs:6405-6450) | `pick`, the move's ID       |
// | Acupressure (9b)  | r % count over the stats below +6, Attack … evasion (bs:8932-8960) | `pick`, the stat         |
//
// The named mechanics' overrides are added too, none of which draws: Pursuit's switch-out hit by the move's own ID,
// Fake Out's first-turn rule, Stomp's power on Minimize's marker, Imprison's shared-move check, Hail under a permanent
// hail, Focus Punch's flinch and Sleep Talk's list by the cartridge's rule.

import PS from 'pokemon-showdown';
import type { Side } from '../../contracts/engine.js';
import { type ChanceOption, pickLabelled } from '../chance.js';
import { installedMoves, moveId } from '../dex.js';
import { belowWeight, residueWeights, U16 } from '../odds.js';
import { storedSpeedValues } from '../speedValues.js';
import { addUnmodelledNote, isUnmodelled } from '../unmodelled.js';
import { clearFog, FOG_KEY, fogCounts } from './field.js';
import { custapFlagged, moveFirstFlagged } from './speedOrder.js';

const { toID } = PS;

const sideOf = (pokemon: Pokemon): Side => pokemon.side.id as Side;

// ---------------------------------------------------------------------------------------------------------------------
// Metronome

/** `NUM_VALID_MOVES` (include/constants/moves.h:12): MAX_MOVES − 1, the last move ID. */
const NUM_VALID_MOVES = 467;

/**
 * `sCannotMetronomeMoves` (bl:7152-7180) by move ID: Metronome, Struggle, Sketch, Mimic, Chatter, Sleep Talk, Assist,
 * Mirror Move, Counter, Mirror Coat, Protect, Detect, Endure, Destiny Bond, Thief, Follow Me, Snatch, Helping Hand,
 * Covet, Trick, Focus Punch, Feint, Copycat, Me First, Switcheroo (generated/moves.txt). The table is by ID, so a hack
 * move in one of these slots is forbidden whatever it is.
 */
const CANNOT_METRONOME: ReadonlySet<number> = new Set([
  118, 165, 166, 102, 448, 214, 274, 119, 68, 243, 182, 197, 203, 194, 168, 266, 289, 270, 343, 271, 264, 364, 383, 382, 415,
]);

/** The note for a Metronome draw that could name a move ID the installed dex lacks (a partial ROM). */
export const METRONOME_GAP_NOTE = 'engine: Metronome could draw a move ID the installed dex lacks';

/**
 * Metronome's draw, `BtlCmd_Metronome` (bs:4537-4560): `(RandNext() % NUM_VALID_MOVES) + 1` again and again until the
 * move is not one the user knows and `Move_CanBeMetronomed` passes (bl:7194-7210: not in `sCannotMetronomeMoves`, not
 * failing in Gravity, not heal-blocked). So each allowed move weighs its residue's draws, `residueWeights(467)[id − 1]`,
 * out of the allowed ones' total.
 */
function metronomeOnHit(this: Battle, pokemon: Pokemon) {
  const moves = installedMoves();
  const known = new Set(pokemon.moveSlots.map((slot) => this.dex.moves.get(slot.id).num));
  const weights = residueWeights(NUM_VALID_MOVES);
  const options: ChanceOption[] = [];
  let missing = false;
  for (let id = 1; id <= NUM_VALID_MOVES; id++) {
    const kaizo = moves.get(id);
    if (kaizo === undefined) {
      missing = true;
      continue;
    }
    if (known.has(id) || CANNOT_METRONOME.has(id)) continue;
    const showdownId = moveId(kaizo);
    const data = this.dex.moves.get(showdownId);
    if (this.field.pseudoWeather['gravity'] && data.flags['gravity']) continue; // Move_FailsInHighGravity
    if (pokemon.volatiles['healblock'] && data.flags['heal']) continue; // Move_HealBlocked
    options.push({ weight: weights[id - 1]!, outcome: showdownId });
  }
  if (missing) addUnmodelledNote(this, METRONOME_GAP_NOTE);
  if (options.length === 0) return false;
  const chosen = options[pickLabelled(this, 'pick', sideOf(pokemon), 'metronome', options)]!.outcome;
  // The called move can be outside the battle's move lists (unmodelledIn's), so an unmodelled one is noted.
  if (isUnmodelled(chosen)) addUnmodelledNote(this, metronomeCallNote(this.dex.moves.get(chosen).name));
  this.actions.useMove(chosen, pokemon);
}

// ---------------------------------------------------------------------------------------------------------------------
// Magnitude, Present, Psywave

/** `BtlCmd_CalcMagnitudePower` (bs:5821-5853): `r % 100` below each bound gives the magnitude and its power. */
const MAGNITUDES = [
  { below: 5, magnitude: 4, power: 10 }, { below: 15, magnitude: 5, power: 30 }, { below: 35, magnitude: 6, power: 50 },
  { below: 65, magnitude: 7, power: 70 }, { below: 85, magnitude: 8, power: 90 }, { below: 95, magnitude: 9, power: 110 },
  { below: 100, magnitude: 10, power: 150 },
] as const;

const MAGNITUDE_OPTIONS: readonly ChanceOption[] = MAGNITUDES.map(({ below, magnitude }, i) => ({
  weight: belowWeight(100, below) - belowWeight(100, i === 0 ? 0 : MAGNITUDES[i - 1]!.below), outcome: `${magnitude}`,
}));

/** Magnitude's draw, once per use (the cartridge draws only while `battleCtx->magnitude` is 0, bs:5824). */
function magnitudeOnModifyMove(this: Battle, move: ActiveMove, pokemon: Pokemon) {
  const { magnitude, power } = MAGNITUDES[pickLabelled(this, 'pick', sideOf(pokemon), 'magnitude', MAGNITUDE_OPTIONS)]!;
  move.magnitude = magnitude;
  move.basePower = power;
}

/** `BtlCmd_Present` (bs:5789-5808): `r & 0xFF` below 255 × 40 / 100 = 102, × 70 / 100 = 178, × 80 / 100 = 204, else a heal. */
const PRESENT: readonly { outcome: string; values: number; power: number }[] = [
  { outcome: '40', values: 102, power: 40 }, { outcome: '80', values: 178 - 102, power: 80 },
  { outcome: '120', values: 204 - 178, power: 120 }, { outcome: 'heal', values: 256 - 204, power: 0 },
];

/** Each byte value is the low byte of 256 of the draws. */
const PRESENT_OPTIONS: readonly ChanceOption[] = PRESENT.map(({ outcome, values }) => ({ weight: BigInt(values) * (U16 / 256n), outcome }));

/**
 * Present's draw. The heal (a quarter of the target's max HP, bs:5803) deals no damage: its power is 0, whatever the
 * ROM's (Showdown's Present has 0; the hack's has 1).
 */
function presentOnModifyMove(this: Battle, move: ActiveMove, pokemon: Pokemon) {
  const { outcome, power } = PRESENT[pickLabelled(this, 'pick', sideOf(pokemon), 'present', PRESENT_OPTIONS)]!;
  move.basePower = power;
  if (outcome === 'heal') {
    move.heal = [1, 4];
    move.infiltrates = true;
  }
}

/**
 * Psywave's damage (effect_script_0088.s): x = `Random 10, 5` = r % 11 + 5, damage = level × x / 10, at least 1; each x
 * weighs its residue's draws, and the x that give one damage value are one option (as damage rolls are, scripts.ts).
 */
function psywaveDamage(this: Battle, pokemon: Pokemon): number {
  const damages: number[] = [];
  const options: ChanceOption[] = [];
  residueWeights(11).forEach((weight, i) => {
    const damage = Math.max(1, Math.floor((pokemon.level * (i + 5)) / 10));
    const at = damages.indexOf(damage);
    if (at >= 0) {
      options[at]!.weight += weight;
    } else {
      damages.push(damage);
      options.push({ weight, outcome: `${damage}` });
    }
  });
  return damages[pickLabelled(this, 'pick', sideOf(pokemon), 'psywave', options)]!;
}

// ---------------------------------------------------------------------------------------------------------------------
// Roar and Whirlwind

/**
 * `BattleSystem_CanWhirlwind` (bl:3073-3087): a user of at least the target's level always succeeds; otherwise it
 * succeeds iff `(((RandNext() & 0xFF) × (L1 + L2)) >> 8) + 1 > L2 / 4`. Each low byte is 256 of the draws. A target
 * with no one to switch in fails before the draw (bs:5285-5288), as Showdown's `forceSwitch` does without it.
 */
function whirlwindOnTryHit(this: Battle, target: Pokemon, source: Pokemon, move: ActiveMove) {
  if (source.level >= target.level || !this.canSwitch(target.side)) return;
  let passing = 0;
  for (let byte = 0; byte < 256; byte++) {
    if (((byte * (source.level + target.level)) >> 8) + 1 > Math.floor(target.level / 4)) passing++;
  }
  const weight = BigInt(passing) * (U16 / 256n);
  if (pickLabelled(this, 'hit', sideOf(source), move.id, [{ weight, outcome: 'hit' }, { weight: U16 - weight, outcome: 'fail' }]) !== 0) return false;
}

/**
 * Showdown's `getRandomSwitchable` (sim/battle.ts:1567-1570), the Pokémon Roar or Whirlwind drags in, as
 * `BtlCmd_TryWhirlwind` picks it (bs:5296-5310): a party slot `RandNext() % party size` again and again until it holds
 * a living Pokémon not out. So each bench Pokémon weighs its party slot's residue draws, `residueWeights(size)[slot]`.
 * The slots are the original party order (the party itself, not the display order `SwitchSlots` reorders, bl:6476-6506),
 * the engine's party indices (`side.team`). The label is the dragger's, `switchTarget`, outcome the party index.
 */
function getRandomSwitchable(this: Battle, side: Battle['p1']): Pokemon | null {
  const canSwitchIn = side.pokemonLeft ? side.pokemon.slice(side.active.length).filter((pokemon) => !pokemon.fainted) : [];
  if (canSwitchIn.length === 0) return null;
  const weights = residueWeights(side.team.length);
  const options = canSwitchIn.map((pokemon) => {
    const index = side.team.indexOf(pokemon.set);
    return { weight: weights[index]!, outcome: `${index}` };
  });
  const dragger = side.foe.id as Side;
  return canSwitchIn[pickLabelled(this, 'switchTarget', dragger, this.activeMove?.id ?? 'dragout', options)]!;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tri Attack

/** `Random 2, 3` (effect_script_0036.s): 3, 4 or 5, `MOVE_SUBSCRIPT_PTR_BURN`, `_FREEZE`, `_PARALYZE` (generated/battle_move_subscript_ptrs.txt). */
const TRI_ATTACK: readonly ChanceOption[] = (['brn', 'frz', 'par'] as const).map((status, i) => ({ weight: residueWeights(3)[i]!, outcome: status }));

/** Tri Attack's status, drawn when its effect happens (the cartridge draws it first; the two draws are independent). */
function triAttackOnHit(this: Battle, target: Pokemon, source: Pokemon) {
  const status = TRI_ATTACK[pickLabelled(this, 'effect', sideOf(source), 'triattack', TRI_ATTACK)]!.outcome;
  target.trySetStatus(status, source);
}

// ---------------------------------------------------------------------------------------------------------------------
// Sleep Talk

/** The note for a Sleep Talk whose user has a move the cartridge's list could leave out where Showdown's keeps it. */
export const SLEEP_TALK_NOTE = 'engine: Sleep Talk with a disabled move (the cartridge\'s and Showdown\'s lists of moves to call may differ)';

/**
 * The moves Sleep Talk never calls by ID (bs:4917-4920): `Move_IsInvoker` (bl:3032-3046: none, Sleep Talk, Copycat,
 * Assist, Me First, Mirror Move, Metronome), Focus Punch, Uproar and Chatter.
 */
const NO_SLEEP_TALK_IDS: ReadonlySet<number> = new Set([0, 214, 383, 274, 382, 119, 118, 264, 253, 448]);

/**
 * The ROM effects of `Move_IsMultiTurn` (bl:2975-2992), which Sleep Talk never calls either (bs:4921): Bide, the charge
 * turns of Razor Wind, Sky Attack, Skull Bash and SolarBeam, Fly, Dive, Dig, Bounce and Shadow Force
 * (generated/move_battle_effects.txt: 26, 39, 75, 145, 151, 155, 255, 256, 263, 272).
 */
const MULTI_TURN_EFFECTS: ReadonlySet<number> = new Set([26, 39, 75, 145, 151, 155, 255, 256, 263, 272]);

/**
 * Sleep Talk's draw (bs:4907-4939): `RandNext() % 4` over the move slots until one is allowed, so each allowed slot
 * weighs 16384 of the draws, uniform. A slot is allowed as the cartridge decides: not in `NO_SLEEP_TALK_IDS` and not
 * of a `MULTI_TURN_EFFECTS` ROM effect, whatever Showdown's flags (the hack's table-built moves have none of Showdown's
 * Sleep Talk flags; Showdown also leaves out Mimic, Sketch and Nature Power, which the cartridge calls). The cartridge
 * also leaves out a move `BattleSystem_CheckInvalidMoves` blocks (disabled, taunted, imprisoned, encore or choice
 * locked...), so a user with a disabled move is noted. A move the hack doesn't define keeps Showdown's flags.
 */
function sleepTalkOnHit(this: Battle, pokemon: Pokemon) {
  const hack = installedMoves();
  const moves: string[] = [];
  for (const moveSlot of pokemon.moveSlots) {
    if (!moveSlot.id) continue;
    const move = this.dex.moves.get(moveSlot.id);
    const kaizo = hack.get(move.num);
    const barred = kaizo === undefined
      ? !!(move.flags['nosleeptalk'] || move.flags['charge'])
      : NO_SLEEP_TALK_IDS.has(kaizo.id) || MULTI_TURN_EFFECTS.has(kaizo.romEffect);
    if (!barred) moves.push(moveSlot.id);
  }
  if (moves.length === 0) return false;
  if (pokemon.moveSlots.some((moveSlot) => moveSlot.disabled)) addUnmodelledNote(this, SLEEP_TALK_NOTE);
  const options = moves.map((id) => ({ weight: U16 / 4n, outcome: id }));
  this.actions.useMove(moves[pickLabelled(this, 'pick', sideOf(pokemon), 'sleeptalk', options)]!, pokemon);
}

// ---------------------------------------------------------------------------------------------------------------------
// Pursuit

/**
 * Pursuit's `beforeTurnCallback`: the switch-out watch, with this move as its source, so the hit on a switching foe is
 * this move (the hack's Rage is a Fighting-type Pursuit; Showdown's watch always uses Pursuit by ID).
 */
function pursuitWatch(id: string) {
  return function beforeTurnCallback(this: Battle, pokemon: Pokemon) {
    pokemon.addVolatile('pursuit', pokemon, this.dex.getActiveMove(id));
  };
}

/**
 * Pursuit on a switching target (Showdown's `beingCalledBack`, or `switchFlag` for a U-turn): no accuracy check at
 * all, as subscript_pursuit.s:7-12 runs CalcCrit, CalcDamage and the type chart with no accuracy command. Showdown's
 * `onModifyMove` sets `accuracy = true`, which the engine's hit rate never reads (it takes the move data's accuracy,
 * mod/accuracy.ts `dataAccuracy`, as `MOVE_DATA(move).accuracy`), so this also sets `alwaysHit`, which
 * `hitStepAccuracy` reads first (mod/scripts.ts). Against a staying target the hit rate is the cartridge's as usual.
 */
function pursuitOnModifyMove(this: Battle, move: ActiveMove, _source: Pokemon, target?: Pokemon) {
  if (!target?.beingCalledBack && !target?.switchFlag) return;
  move.accuracy = true;
  move.tracksTarget = true;
  move.alwaysHit = true;
}

/**
 * Pursuit's switch-out hit, `BtlCmd_TryPursuit` (bs:6884-6955) as subscript_pursuit.s runs it: a foe that has not
 * acted, is neither asleep nor frozen nor loafing, and whose move (its Encore move if encored) has the Pursuit effect
 * and PP left, uses it on the battler switching out, at double power (`powerMul` 20; Showdown's `basePowerCallback`)
 * and always hitting (`pursuitOnModifyMove`). Showdown's Gen 4 watch with the watching move's own ID. A regular
 * switch and a U-turn switch both call it (subscript_switch_pokemon.s:11, subscript_attack_then_switch_out.s:54), Baton
 * Pass doesn't (Showdown's Baton Pass skips `BeforeSwitchOut`). On a U-turn the cartridge hits before the party list
 * opens and, if it knocks the user out, the replacement waits for the turn's end (subscript_attack_then_switch_out.s:
 * 55); Showdown runs `BeforeSwitchOut` for a U-turn before it asks for the switch (sim/battle.ts `runAction`) and
 * drops the switch of a fainted user, the same. A knock-out by the player's Pursuit with a field condition up records
 * `PURSUIT_FIELD_NOTE` ("Acid Rain", below).
 */
const pursuit: Record<string, unknown> = {
  name: 'Pursuit', // Showdown's `[from] Pursuit` on the hit's line, which the trainer AI reads
  duration: 1,
  onFoeBeforeSwitchOut(this: Battle, pokemon: Pokemon) {
    const source = this.effectState['source'] as Pokemon;
    const id = (this.effectState['sourceEffect'] as Effect | undefined)?.id ?? 'pursuit';
    const encore = source.volatiles['encore'];
    if (['frz', 'slp'].includes(source.status) || (source.hasAbility('truant') && source.volatiles['truant'])
      || !source.isAdjacent(pokemon) || !source.hp || (encore && encore['move'] !== id) || !this.queue.cancelMove(source)) return;
    const move = this.dex.getActiveMove(id);
    const fieldUp = fieldConditionsUp(this);
    source.deductPP(move.id);
    source.moveUsed(move, pokemon.position);
    if (this.actions.useMove(move, source, { target: pokemon }) && source.getItem().isChoice) source.addVolatile('choicelock');
    if (fieldUp && source.side === this.p1 && pokemon.hp <= 0) addUnmodelledNote(this, PURSUIT_FIELD_NOTE);
  },
};

/**
 * The note for "Acid Rain" (pokeplatinum docs/bugs_and_glitches.md): when Pursuit
 * knocks out the battler switching out, subscript_pursuit.s saves the fainted battler (:100), pays its EXP (:104-113),
 * then subtracts the fainted battler's number from the field-condition mask (:115, `UpdateVarFromVar OPCODE_SUB_TO_ZERO,
 * BTLVAR_FIELD_CONDITIONS, BTLVAR_SCRIPT_TEMP`; bs:2732-2737, floored at 0). The hack's script is vanilla's byte for
 * byte. For the trainer's battler (1) any field condition up turns into others: the mask's lowest set bit goes and every
 * bit below it is set (include/constants/battle/condition.h:110-128: the hack's permanent sandstorm 0x08 becomes 0x07, rain
 * twice and a temporary sandstorm at once; Trick Room's turn count loses one and gains every weather, Uproar, Gravity and
 * fog bit). Showdown holds one weather at a time, so the engine cannot follow the result and notes the step instead. With
 * no field condition the subtraction stays at 0, and the trainer's Pursuit knocking out the player's battler subtracts 0.
 */
export const PURSUIT_FIELD_NOTE = 'engine: the player\'s Pursuit knocked out a switching foe with a weather, Trick Room, Gravity, Uproar or fog up, which the cartridge then corrupts ("Acid Rain": the fainted battler is subtracted from the field-condition mask, subscript_pursuit.s:115)';

/**
 * Whether the cartridge's field-condition mask (`fieldConditionsMask`, condition.h:110-128) is not 0: a weather (Showdown's
 * raw weather, also under Cloud Nine or Air Lock, which leave the bit set), the deep fog (mod/field.ts `FOG_KEY`), Trick
 * Room, Gravity, or an active Pokémon in an Uproar. Exported for its test (test/unit/engine/expApply.test.ts): a single
 * battle never has an uproarer out at a Pursuit knock-out of a switching foe, as the uproarer is locked in.
 */
export function fieldConditionsUp(battle: Battle): boolean {
  const field = battle.field;
  return field.weather !== '' || battle.formatData[FOG_KEY] === true || field.pseudoWeather['trickroom'] !== undefined
    || field.pseudoWeather['gravity'] !== undefined || battle.getAllActive().some((pokemon) => pokemon.volatiles['uproar'] !== undefined);
}

// ---------------------------------------------------------------------------------------------------------------------
// Fake Out, Stomp, Imprison, Hail, Focus Punch

/**
 * Fake Out fails unless its user's `fakeOutTurnNumber` is the battle's `totalTurns` (effect_script_0158.s:5): set to
 * `totalTurns + 1` when it comes in (`BattleSystem_UpdateAfterSwitch`, bl:2117) and 0 for a lead (`totalTurns` is 0 in
 * turn 1, counted at each turn's end, bcp:1852). So it works only in the first turn after its user came in, whether or
 * not it moved before (a trainer's bag item, a Pursuit on a switching foe). That is Showdown's `activeTurns` of 1: it
 * counts the turn ends the Pokémon was out for, the battle start's included. Showdown counts move actions instead.
 */
function fakeOutOnTry(this: Battle, source: Pokemon) {
  if (source.activeTurns !== 1) {
    this.hint('Fake Out only works on your first turn out.');
    return false;
  }
}

/** Stomp's power ×2 on a target with Minimize's marker (effect_script_0150.s:6-8, `powerMul` 20, bl:6687-6688). */
function stompPower(this: Battle, _pokemon: Pokemon, target: Pokemon | undefined, move: ActiveMove): number {
  return target?.volatiles['minimize'] ? move.basePower * 2 : move.basePower;
}

/**
 * Imprison's shared-move check, `BtlCmd_TryImprison` (bs:6674-6719): the user's moves against every battler of the
 * other side, fainted or not (it reads the battle Pokémon's moves without an HP check), so a foe knocked out earlier
 * this turn still counts until its replacement comes in. Showdown's `foes()` leaves a fainted foe out.
 */
function imprisonOnTryHit(this: Battle, pokemon: Pokemon) {
  const own = new Set(pokemon.moveSlots.map((slot) => slot.id));
  if (!pokemon.side.foe.active.some((foe) => !!foe && foe.moveSlots.some((slot) => own.has(slot.id)))) return false;
}

/**
 * Hail checks only for a temporary hail (effect_script_0164.s:5, `FIELD_CONDITION_HAILING_TEMP`; the other weather
 * moves check both kinds), so under a permanent hail (an ability's, Showdown's duration 0) it starts five turns of
 * hail where Showdown's would fail.
 */
function hailOnTry(this: Battle) {
  if (this.field.weather === 'hail' && !this.field.weatherState['duration']) this.field.clearWeather();
}

// The weather rocks' and Light Clay's turns are the ROM's parameters, read by the weather and screen conditions (mod/items.ts
// `KAIZO_ITEM_CONDITIONS`): 5 turns plus the held extend item's parameter (effect_script_0136.s:12-14 and its siblings;
// Reflect and Light Screen, bs:4229, :4272).

const GEN4_MOVES = PS.Dex.mod('gen4').data.Moves as unknown as Record<string, { condition?: Record<string, unknown> }>;

/**
 * Focus Punch's condition without Showdown's flinch immunity: the cartridge's before-move flinch check comes before
 * effect 170's focus check, so a flinched Focus Punch user flinches (Steadfast and all).
 */
const focuspunch: Record<string, unknown> = { ...GEN4_MOVES['focuspunch']!.condition, name: 'Focus Punch', onTryAddVolatile: undefined };

/**
 * Minimize's marker (subscript_minimize.s): only Stomp reads it (`stompPower`); Showdown's final ×2 on damage is gone,
 * as the cartridge doubles the power. It isn't passed by Baton Pass (Showdown's `noCopy`).
 */
const minimize: Record<string, unknown> = { name: 'Minimize', noCopy: true, onRestart: () => null };

// ---------------------------------------------------------------------------------------------------------------------
// Variable power. Each is the power command of the move's ROM effect script; Showdown's Gen 4 Flail, Water
// Spout, Brine, Punishment, Trump Card and Hidden Power already compute the same, and need nothing here.

/** `sWeightToPower` (include/data/battle/weight_to_power.h): a weight (hg) at most each bound gives its power. */
const WEIGHT_TO_POWER: readonly (readonly [number, number])[] = [[100, 20], [250, 40], [500, 60], [1000, 80], [2000, 100]];

/**
 * Low Kick's and Grass Knot's power, `BtlCmd_CalcWeightBasedPower` (bs:6808-6828): the first band whose bound is at
 * least the target's `BattleMon.weight`, 120 past the last. The weight is the ROM's Pokédex weight (dex.ts
 * `pokedexWeightKg`); Transform copies it, as Showdown's `transformInto` does. Showdown's bands are "at least" each
 * bound, so a target of exactly 10.0 kg (Magikarp) took 40 there and takes 20 here.
 */
function weightPower(this: Battle, _pokemon: Pokemon, target: Pokemon | undefined): number {
  const weight = target?.weighthg ?? 0;
  return WEIGHT_TO_POWER.find(([bound]) => bound >= weight)?.[1] ?? 120;
}

/**
 * Payback's power, and the hack's Revenge's (ROM effect 230): `BtlCmd_CalcPaybackPower` (bs:7198-7208) doubles the
 * ROM's power once the target's action this turn is done (`DEFENDER_ACTION[PICK_COMMAND] == BATTLE_CONTROL_MOVE_END`):
 * Showdown's "no action of the target left in the queue". Showdown's own Payback is a fixed 50 or 100.
 */
function paybackPower(this: Battle, _pokemon: Pokemon, target: Pokemon | undefined, move: ActiveMove): number {
  return target && this.queue.willMove(target) ? move.basePower : move.basePower * 2;
}

/**
 * In-battle Gyro Ball, `BtlCmd_CalcGyroBallPower` (bs:7123-7133): `1 + 25 × monSpeedValues[defender] /
 * monSpeedValues[attacker]`, at most 150, from the stored values of the battle's last speed compare (speedValues.ts),
 * not the live Speed Showdown's reads. The turn's start sort always writes them before a move runs.
 */
function gyroBallPower(this: Battle, pokemon: Pokemon, target: Pokemon | undefined): number {
  if (!target) return 1;
  const stored = storedSpeedValues(this);
  return Math.min(150, 1 + Math.floor((25 * stored[sideOf(target)]) / Math.max(1, stored[sideOf(pokemon)])));
}

/** `MON_CONDITION_FACADE_BOOST`: poison, bad poison, paralysis and burn (effect_script_0169.s, `POWER_MULTI` 20). */
const FACADE_BOOST: ReadonlySet<string> = new Set(['psn', 'tox', 'par', 'brn']);

/** Facade's ×2 for its user's status; Showdown's doubles any status but sleep, freeze too. */
function facadeOnBasePower(this: Battle, _basePower: number, pokemon: Pokemon) {
  if (FACADE_BOOST.has(pokemon.status)) return this.chainModify(2);
}

/**
 * SmellingSalt's and Wake-Up Slap's power: ×2 (`POWER_MULTI` 20) on a target with `status`, unless a substitute takes
 * the hit (`CheckSubstitute` first, effect_script_0171.s, 0217.s). Showdown's doubles through a substitute. The cure
 * stays Showdown's `onHit`, which a substitute's hit never reaches, as the cartridge's on-hit subscript.
 */
function doubledOn(status: string) {
  return function basePowerCallback(this: Battle, _pokemon: Pokemon, target: Pokemon | undefined, move: ActiveMove): number {
    return target?.status === status && !target.volatiles['substitute'] ? move.basePower * 2 : move.basePower;
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The remaining placeholders' overrides

/** `Move_IsInvoker` (bl:3032-3046): none, Sleep Talk, Copycat, Assist, Me First, Mirror Move, Metronome. */
const INVOKERS: ReadonlySet<number> = new Set([0, 214, 383, 274, 382, 119, 118]);

/**
 * `Move_CanBeMetronomed` (bl:7194-7210) for `user`'s move `id`: not in `sCannotMetronomeMoves`, not failing in Gravity,
 * not heal-blocked, each by the cartridge's rule (ID lists, dex.ts `withRomFlags`). A move the dex lacks can't be called.
 */
function canBeMetronomed(battle: Battle, user: Pokemon, id: number): boolean {
  const kaizo = installedMoves().get(id);
  if (kaizo === undefined || CANNOT_METRONOME.has(id)) return false;
  const data = battle.dex.moves.get(moveId(kaizo));
  return !(battle.field.pseudoWeather['gravity'] && data.flags['gravity']) && !(user.volatiles['healblock'] && data.flags['heal']);
}

/**
 * Assist's draw, `BtlCmd_TryAssist` (bs:6405-6450): every move of the other party members, the party in its own
 * order (`side.team`, as Roar's pick reads it) and each one's four moves in order, fainted members too, that isn't an
 * invoker and can be Metronomed, then `RandNext() % count`: each entry weighs its residue's draws, and entries of the
 * same move are one option. Showdown's Assist read its own flags and drew raw.
 */
function assistOnHit(this: Battle, pokemon: Pokemon) {
  const entries: string[] = [];
  for (const set of pokemon.side.team) {
    if (set === pokemon.set) continue;
    for (const name of set.moves) {
      const data = this.dex.moves.get(name);
      if (!INVOKERS.has(data.num) && canBeMetronomed(this, pokemon, data.num)) entries.push(data.id);
    }
  }
  if (entries.length === 0) return false;
  const weights = residueWeights(entries.length);
  const options: ChanceOption[] = [];
  entries.forEach((id, i) => {
    const option = options.find((candidate) => candidate.outcome === id);
    if (option === undefined) options.push({ weight: weights[i]!, outcome: id });
    else option.weight += weights[i]!;
  });
  this.actions.useMove(options[pickLabelled(this, 'pick', sideOf(pokemon), 'assist', options)]!.outcome, pokemon);
}

/** The stats `BtlCmd_BoostRandomStatBy2` walks, `BATTLE_STAT_ATTACK` to `BATTLE_STAT_EVASION` in order. */
const ACUPRESSURE_STATS = ['atk', 'def', 'spe', 'spa', 'spd', 'accuracy', 'evasion'] as const;

/**
 * Acupressure (effect_script_0226.s): fails behind its target's substitute, else `BtlCmd_BoostRandomStatBy2`
 * (bs:8932-8960) lists the stats below +6 in the cartridge's order and picks `RandNext() % count`, each its residue's
 * draws, for +2. Showdown's drew raw over its own order of the stats.
 */
function acupressureOnHit(this: Battle, target: Pokemon) {
  if (target.volatiles['substitute']) return false;
  const stats = ACUPRESSURE_STATS.filter((stat) => target.boosts[stat] < 6);
  if (stats.length === 0) return false;
  const weights = residueWeights(stats.length);
  const options = stats.map((stat, i): ChanceOption => ({ weight: weights[i]!, outcome: stat }));
  this.boost({ [stats[pickLabelled(this, 'pick', sideOf(target), 'acupressure', options)]!]: 2 });
}

const GEN4_PSYCH_UP = (PS.Dex.mod('gen4').data.Moves as unknown as Record<string, { onHit: (this: Battle, target: Pokemon, source: Pokemon, move: ActiveMove) => unknown }>)['psychup']!;

/**
 * Psych Up, `BtlCmd_CopyStatStages` (bs:6042-6050): every stage, then `ATTACKING_MON.statusVolatile |=
 * (DEFENDING_MON.statusVolatile & VOLATILE_CONDITION_FOCUS_ENERGY)`, so the user gains the target's Focus Energy and
 * keeps its own. Showdown's Gen 4 Psych Up copies the stages only.
 */
function psychUpOnHit(this: Battle, target: Pokemon, source: Pokemon, move: ActiveMove) {
  const result = GEN4_PSYCH_UP.onHit.call(this, target, source, move);
  if (target.volatiles['focusenergy'] && !source.volatiles['focusenergy']) source.addVolatile('focusenergy', source);
  return result;
}

/**
 * The moves that run another move: `Move_IsInvoker`'s (bl:3032-3046: Sleep Talk, Copycat, Assist, Me First, Mirror
 * Move, Metronome) and Nature Power.
 */
const MOVE_CALLERS: ReadonlySet<number> = new Set([214, 383, 274, 382, 119, 118, 267]);

/** The note for a Last Resort whose user knows a move caller. */
export const LAST_RESORT_CALLER_NOTE = 'engine: Last Resort by a Pokémon that knows a move caller (the cartridge counts every distinct move it ran, called ones too, battle_lib.c:3443-3458)';

const GEN4_LAST_RESORT = (PS.Dex.mod('gen4').data.Moves as unknown as Record<string, { onTry: (this: Battle, source: Pokemon, target: Pokemon, move: ActiveMove) => unknown }>)['lastresort']!;

/**
 * Last Resort, `BtlCmd_TryLastResort` (bs:7567-7580): it fails unless its user ran at least as many distinct other
 * moves as it knows less one. `BattleSystem_UpdateLastResort` (bl:3443-3458, at each move's execution, bcp:3218)
 * counts each distinct move but Last Resort, a move called by Metronome, Sleep Talk and the like included. Showdown
 * counts each known slot's `used`. Both start afresh at every switch-in, a Baton Pass's too: the cartridge zeroes the
 * incoming battler's `moveEffectsData` (bl:2100-2104), and Baton Pass restores only bl:2105-2114's fields, not the
 * count; Showdown's `switchIn` clears every slot's `used` (sim/battle-actions.ts `switchIn`; dist/sim/battle-actions.js:
 * 139-141), though `clearVolatile` keeps the slot objects. So they differ only where a move that isn't in a slot
 * counts: a called move (noted here when its user knows a move caller), or a move Transform or Mimic replaced (both
 * unmodelled). The check stays Showdown's.
 */
function lastResortOnTry(this: Battle, source: Pokemon, target: Pokemon, move: ActiveMove) {
  if (source.moveSlots.some((slot) => MOVE_CALLERS.has(this.dex.moves.get(slot.id).num))) addUnmodelledNote(this, LAST_RESORT_CALLER_NOTE);
  return GEN4_LAST_RESORT.onTry.call(this, source, target, move);
}

/** The note for Brick Break at a type-immune target with a screen up. */
export const BRICK_BREAK_IMMUNE_NOTE = 'engine: Brick Break at a type-immune target with a screen up (the cartridge breaks the screen anyway, battle_lib.c:1490-1500)';

/**
 * Brick Break breaks the screens even when its target is immune to its type (bl:1490-1500: `MOVE_SIDE_EFFECT_BREAK_SCREENS`
 * with `MOVE_STATUS_DID_NOT_AFFECT`), after its accuracy roll (the cartridge rolls before the type check). Showdown's
 * Gen 4 stops at the type immunity, before Brick Break's `onTryHit`; that case is noted.
 */
function brickBreakOnModifyMove(this: Battle, move: ActiveMove, _source: Pokemon, target?: Pokemon) {
  if (!target || !(target.side.sideConditions['reflect'] || target.side.sideConditions['lightscreen'])) return;
  if (!target.runImmunity(move)) addUnmodelledNote(this, BRICK_BREAK_IMMUNE_NOTE);
}

/** The note for a Metronome that called a move the engine doesn't model. */
export const metronomeCallNote = (name: string): string => `engine: Metronome called ${name}, which the engine doesn't model`;

/** The note for a Wish that healed a Pokémon other than its user. */
export const WISH_RECIPIENT_NOTE = 'engine: Wish healed another Pokémon than its user (the cartridge heals the recipient by half its own max HP; the docs say the user\'s)';

const GEN4_WISH = GEN4_MOVES['wish']!.condition! as Record<string, unknown> & { onEnd: (this: Battle, target: Pokemon) => unknown };

/**
 * Wish's slot condition: the cartridge heals the Pokémon in the wisher's slot by half its own max HP, if it has HP
 * (bcp:1086-1104, `BattleSystem_Divide(maxHP, 2)`), as Showdown's Gen 4 Wish does. The docs say "1/2 of user's max HP",
 * so a recipient that isn't the user (after a switch) is noted.
 */
const wish: Record<string, unknown> = {
  ...GEN4_WISH,
  name: 'Wish',
  onEnd(this: Battle, target: Pokemon) {
    if (!target.fainted && this.effectState['source'] !== target) addUnmodelledNote(this, WISH_RECIPIENT_NOTE);
    return GEN4_WISH.onEnd.call(this, target);
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Bug Bite and Pluck

const GEN4_BUG_BITE = (PS.Dex.mod('gen4').data.Moves as unknown as Record<string, { onHit: (this: Battle, target: Pokemon, source: Pokemon, move: ActiveMove) => unknown }>)['bugbite']!;

/**
 * Bug Bite and Pluck eat the target's berry as an ON_HIT side effect (effect_script_0224.s). The ON_HIT trigger runs
 * whatever the target's substitute (bl:1524-1529), but the routine it reaches doesn't: `BattleSystem_PluckBerry` returns
 * FALSE first when the hit landed on the defender's substitute (bl:5546-5548; `SELF_TURN_FLAG_SUBSTITUTE_HIT`, set by
 * the substitute's hit, broken or not, bcp:3371, read at bl:6259-6268), so `BtlCmd_TryPluck` jumps past the message and
 * `RemoveItem` (bs:8125-8127; subscript_pluck.s:5-10): the berry stays. Showdown's `onHit` never runs on a substitute's
 * hit either, so they match. Off a substitute, any berry is taken,
 * one with no pluck effect too (the `default` case, bl:5832-5836), as Showdown's. The berry goes to the victim's recycle
 * slot (`RemoveItem`, bs:8978), which only Recycle and Natural Gift read; both are unmodelled (effects.ts).
 *
 * Bug Bite and Pluck as `BtlCmd_TryPluck` runs them (bs:8116-8143): Sticky Hold (that the user's Mold Breaker doesn't
 * ignore) stops them first, with its message (:8122-8124; Showdown's `TakeItem` event shows and refuses it the same way
 * for a berry); then a target that holds an item and whose Custap Berry flag is set, so it has not moved yet this turn
 * (speedOrder.ts `custapFlagged`), keeps its berry, and nothing is shown (:8125-8127 jump past subscript_pluck.s's message
 * and `RemoveItem`, :5, :15). That berry is then eaten by its holder's own move start (subscript_check_quick_claw.s:26-28,
 * speedOrder.ts `showMoveFirst`). The Quick Claw flag is not read: a Quick Claw is no berry, which `BattleSystem_PluckBerry`
 * passes over (bl:5832-5836) and Showdown's Bug Bite too.
 */
function bugBiteOnHit(this: Battle, target: Pokemon, source: Pokemon, move: ActiveMove) {
  const stickyHold = target.hasAbility('stickyhold') && !source.hasAbility('moldbreaker');
  if (!stickyHold && target.item !== '' && custapFlagged(this, target)) return;
  return GEN4_BUG_BITE.onHit.call(this, target, source, move);
}

// ---------------------------------------------------------------------------------------------------------------------
// The deep fog's readers and Defog (mod/field.ts has the fog's rules)

type MoveHandler = (this: Battle, ...args: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
const gen4MoveHandler = (id: string, name: string): MoveHandler =>
  (PS.Dex.mod('gen4').data.Moves as unknown as Record<string, Record<string, MoveHandler>>)[id]![name]!;

/** The fog's name on the `|-fieldend|` line Defog's clearing logs (subscript_defog.s:66-67, "{0} blew away the deep fog with {1}!"). */
const FOG_END = 'Deep Fog';

/**
 * Defog: Showdown's effect, then the cartridge's fog clearing (subscript_defog.s:64-67), which every hit reaches (mod/field.ts).
 * Defog stays unmodelled for the rest (effects.ts): Showdown's also clears hazards on its user's side, which the script doesn't.
 */
function defogOnHit(this: Battle, target: Pokemon, source: Pokemon, move: ActiveMove) {
  const result = gen4MoveHandler('defog', 'onHit').call(this, target, source, move);
  if (!clearFog(this)) return result;
  this.add('-fieldend', FOG_END, `[from] move: ${move.name}`, `[of] ${source}`);
  return true;
}

/**
 * Weather Ball doubles its power in any `FIELD_CONDITION_WEATHER`, the deep fog included (`BtlCmd_CalcWeatherBallParams`,
 * bs:6847-6850), its type staying the move's own in fog (none of the type branches, bs:6852-6866; `CalcMoveType`,
 * bl:7894-7911). Showdown's Weather Ball has no fog, so its power is doubled here when only the fog counts.
 */
function weatherBallOnModifyMove(this: Battle, move: ActiveMove, pokemon: Pokemon, target?: Pokemon) {
  gen4MoveHandler('weatherball', 'onModifyMove').call(this, move, pokemon, target);
  if (fogCounts(this) && this.field.effectiveWeather() === '') move.basePower *= 2;
}

/**
 * Synthesis, Moonlight and Morning Sun heal a quarter of the user's max HP in any weather but sun, the deep fog included
 * (`BtlCmd_WeatherHPRecovery`, bs:5970-5976: `NO_WEATHER` is false in fog, so `BattleSystem_Divide(maxHP, 4)`, at least 1,
 * as Showdown's `heal` rounds). Showdown's heal half with no weather of its own.
 *
 * At full HP, in any weather, the fog or none, the heal does nothing: the effect script hands the heal to
 * `subscript_present_heal` (effect_script_0132.s:7; include/data/move_side_effect_subscripts.h:104), which calls
 * `BATTLE_SUBSCRIPT_RECOVER_HP` (subscript_present_heal.s:9), and that compares the current HP with the max HP
 * (subscript_recover_hp.s:5-6): equal, it prints "{0}'s HP is full!" and sets `MOVE_STATUS_NO_MORE_WORK` (:22-28), which
 * is one of `MOVE_STATUS_NO_EFFECTS` (include/constants/battle/moves.h:85), so the Metronome item counts the use as one
 * that did nothing (bl:6184). Recover and Roost reach the same subscript (subscript_recover_half_max_hp.s:10,
 * subscript_roost.s:10), and Showdown's `heal` path gives them `|-fail|POKEMON|heal` ("HP is full!") and a move that did
 * nothing (sim/battle-actions.ts `runMoveEffects`): these three get the same, where Showdown's Gen 4 handlers logged
 * nothing and the fog's heal a bare `|-fail|`.
 */
function weatherHeal(id: string) {
  return function onHit(this: Battle, pokemon: Pokemon, ...rest: unknown[]) {
    if (pokemon.hp >= pokemon.maxhp) {
      this.add('-fail', pokemon, 'heal');
      this.attrLastMove('[still]');
      return null;
    }
    if (fogCounts(this) && this.field.effectiveWeather() === '') {
      this.heal(pokemon.baseMaxhp / 4);
      return;
    }
    return gen4MoveHandler(id, 'onHit').call(this, pokemon, ...rest);
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Knock Off

/**
 * `Pokemon.m` key: the item Knock Off took from the Pokémon (its Showdown ID). The cartridge empties the battler's item
 * and sets its party slot's `knockedOffItemsMask` bit with no copy to the party (bs:6624-6628), and every later copy skips
 * the item (battle_io_command.c:590), so the party keeps this item after the fight: battle.ts `carriedItem` reads it.
 */
export const KNOCKED_OFF_KEY = 'kaizoKnockedOff';

/**
 * Knock Off as subscript_knock_off.s runs it, recording the item taken. Its checks, in order:
 * - a substitute stops it (:5): Showdown runs no `AfterHit` for a hit its substitute took;
 * - Multitype (:6, the battler's ability field, Gastro Acid or not), a held Griseous Orb (:7, whoever holds it), and the
 *   defender's Quick Claw or Custap Berry flag (:8-9, `BATTLEMON_QUICK_CLAW`, `_CUSTAP_BERRY`; set by this turn's order
 *   and cleared when its holder's move starts, subscript_check_quick_claw.s:22-28, so only a holder that has not moved
 *   yet: speedOrder.ts `moveFirstFlagged`) stop it. Showdown's Gen 4 Knock Off already refused the first two (Gen 4's
 *   Griseous Orb has `onTakeItem: false`); the flag it never read;
 * - `BtlCmd_TryKnockOff` (bs:6610-6633): Sticky Hold (ignorable: Mold Breaker passes it) shows and stops it, else the
 *   item is gone, with no copy to the party (`KNOCKED_OFF_KEY`).
 * Then Showdown's Gen 4 Knock Off runs: its `TakeItem` event is Sticky Hold's check and Unburden's start (the cartridge's
 * `canUnburden` stays set, bl:161-166); the item is gone and unusable for the rest of the fight, and the Pokémon can't
 * take another (`itemKnockedOff`, sim/pokemon.ts `takeItem`; bs:5105, :6348). The one `TakeItem` refusal left that the
 * cartridge doesn't make, a Plate knocked off by an Arceus, is noted (`KNOCK_OFF_PLATE_NOTE`).
 */
function knockOffOnAfterHit(this: Battle, target: Pokemon, source: Pokemon, move: ActiveMove) {
  const item = target.item;
  if (item === '' || target.ability === 'multitype' || item === 'griseousorb' || moveFirstFlagged(this, target)) return;
  if (source.baseSpecies.num === ARCEUS && this.dex.items.get(item).onPlate !== undefined) addUnmodelledNote(this, KNOCK_OFF_PLATE_NOTE);
  gen4MoveHandler('knockoff', 'onAfterHit').call(this, target, source, move);
  if (target.item === '' && target.itemKnockedOff) (target.m as Record<string, unknown>)[KNOCKED_OFF_KEY] = item;
}

const ARCEUS = 493;

/** The note for an Arceus knocking off a Plate, which Showdown's Plate refuses and the cartridge allows. */
export const KNOCK_OFF_PLATE_NOTE = 'engine: Knock Off by an Arceus on a Plate (Showdown\'s Plate refuses it; subscript_knock_off.s does not)';

// ---------------------------------------------------------------------------------------------------------------------
// Perish Song

/**
 * Perish Song as `BtlCmd_TryPerishSong` sets it (bs:5462-5487): every battler with HP left and no perish count yet gets
 * one, except one with Soundproof that the user's Mold Breaker doesn't ignore (`Battler_IgnorableAbility(attacker, i,
 * ABILITY_SOUNDPROOF)`), the user's own Soundproof included; it fails when no one gets a count. Its subscript then shows
 * each Soundproof Pokémon blocking it (subscript_perish_song_start.s:15-25). Showdown's Gen 4 Soundproof (data/mods/gen7
 * `onTryHit`, inherited) blocks the user's own count too, but its Perish Song succeeds when every Pokémon blocks it (a
 * `TryHit` of null counts as a result) and misses a semi-invulnerable Pokémon, which the command doesn't check.
 */
function perishSongOnHitField(this: Battle, _target: Pokemon, source: Pokemon) {
  let started = false;
  const blocked: Pokemon[] = [];
  for (const pokemon of this.getAllActive()) {
    if (pokemon.volatiles['perishsong'] || !pokemon.hp) continue;
    if (pokemon.hasAbility('soundproof') && !source.hasAbility('moldbreaker')) {
      blocked.push(pokemon);
      continue;
    }
    pokemon.addVolatile('perishsong');
    this.add('-start', pokemon, 'perish3', '[silent]');
    started = true;
  }
  if (!started) return false;
  this.add('-fieldactivate', 'move: Perish Song');
  for (const pokemon of blocked) this.add('-immune', pokemon, '[from] ability: Soundproof');
}

// ---------------------------------------------------------------------------------------------------------------------
// The tables

/** A move's callbacks, or a function of the move's own Showdown ID that gives them. */
type MoveCallbacks = Record<string, unknown> | ((id: string) => Record<string, unknown>);

/** The mod's move callbacks, by behaviour source (Showdown move ID), laid over each move that runs that source. */
export const KAIZO_MOVE_CALLBACKS: Readonly<Record<string, MoveCallbacks>> = {
  pursuit: (id) => ({ beforeTurnCallback: pursuitWatch(id), onModifyMove: pursuitOnModifyMove }),
  fakeout: { onTry: fakeOutOnTry },
  stomp: { basePowerCallback: stompPower },
  imprison: { onTryHit: imprisonOnTryHit },
  hail: { onTry: hailOnTry },
  metronome: { onHit: metronomeOnHit },
  magnitude: { onModifyMove: magnitudeOnModifyMove },
  present: { onModifyMove: presentOnModifyMove },
  psywave: { damageCallback: psywaveDamage },
  roar: { onTryHit: whirlwindOnTryHit },
  whirlwind: { onTryHit: whirlwindOnTryHit },
  // The secondary's chance is the ROM's, set after these (dex.ts `showdownMoveData`).
  triattack: { secondary: { chance: 20, onHit: triAttackOnHit } },
  sleeptalk: { onHit: sleepTalkOnHit },
  // Using Uproar wakes no one on the cartridge (subscript_uproar.s): the uproar's end-of-turn check and each sleeper's
  // own attempt do (mod/conditions.ts `uproar`, `slp`). Showdown's Gen 4 `onTryHit` woke every sleeper, Soundproof too.
  uproar: { onTryHit: undefined },
  // Variable power and Bug Bite.
  lowkick: { basePowerCallback: weightPower },
  payback: { basePowerCallback: paybackPower },
  gyroball: { basePowerCallback: gyroBallPower },
  facade: { onBasePower: facadeOnBasePower },
  smellingsalts: { basePowerCallback: doubledOn('par') },
  wakeupslap: { basePowerCallback: doubledOn('slp') },
  bugbite: { onHit: bugBiteOnHit },
  // The remaining placeholders.
  assist: { onHit: assistOnHit },
  acupressure: { onHit: acupressureOnHit },
  psychup: { onHit: psychUpOnHit },
  lastresort: { onTry: lastResortOnTry },
  brickbreak: { onModifyMove: brickBreakOnModifyMove },
  // Follow Me succeeds in singles (BtlCmd_FollowMe, bs:6261-6290, sets the side's Follow Me with no ally check), where
  // it redirects nothing; Showdown's fails without an ally.
  followme: { onTry: undefined },
  // The hack's Thief has Splash's effect (85, effect_script_0085.s): no CalcDamage, so after its accuracy check it does
  // nothing ("But nothing happened!"); Showdown's Thief would hit and steal.
  thief: { basePowerCallback: () => 0, onAfterHit: undefined, onHit(this: Battle) { this.add('-nothing'); } },
  // The deep fog (mod/field.ts).
  defog: { onHit: defogOnHit },
  weatherball: { onModifyMove: weatherBallOnModifyMove },
  synthesis: { onHit: weatherHeal('synthesis') },
  moonlight: { onHit: weatherHeal('moonlight') },
  morningsun: { onHit: weatherHeal('morningsun') },
  // The item a gauntlet carries (battle.ts `carriedItem`), and subscript_knock_off.s's checks.
  knockoff: { onAfterHit: knockOffOnAfterHit },
  // The user's own Soundproof (bs:5462-5487).
  perishsong: { onHitField: perishSongOnHitField },
};

/**
 * The callbacks for a behaviour source (a Smogon move name or a Showdown ID) on the move whose Showdown ID is `id` (the
 * source's own by default), copied; none for most moves.
 */
export function moveCallbacks(behaviour: string, id: string = toID(behaviour)): Record<string, unknown> {
  const callbacks = KAIZO_MOVE_CALLBACKS[toID(behaviour)];
  if (callbacks === undefined) return {};
  return structuredCloneCallbacks(typeof callbacks === 'function' ? callbacks(id) : callbacks);
}

/** The mod's move conditions, merged into its `Conditions` (dex.ts) by condition ID. */
export const KAIZO_MOVE_CONDITIONS: Record<string, Record<string, unknown>> = { pursuit, focuspunch, minimize, wish };

/** A shallow copy, with a nested secondary copied too (so a move's ROM chance never lands in the shared table). */
function structuredCloneCallbacks(callbacks: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...callbacks };
  if (typeof copy['secondary'] === 'object' && copy['secondary'] !== null) copy['secondary'] = { ...(copy['secondary'] as object) };
  return copy;
}

// Struggle's recoil needs no override: the cartridge's max HP × −1 / 4 through `BattleSystem_Divide` (subscript_struggle.s,
// bl:3599-3619), a quarter rounded toward zero and at least 1, is Showdown's Gen 4 `applyRecoilDamage` already
// (data/mods/gen4/scripts.ts:205-220, `Math.floor`; the base rounds to nearest). counters.test.ts pins it.

/** The mod's `Battle` methods for moves, merged into its `Scripts` (dex.ts). */
export const KAIZO_MOVE_SCRIPTS: Record<string, unknown> = { getRandomSwitchable };
