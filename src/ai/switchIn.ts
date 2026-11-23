// applySwitchIns: the leads' switch-in effects before the trainer AI's first decision, run through the engine.
// initialView loads both leads as BattleSystem_InitBattleMon does; this starts the same battle
// in the engine (createBattle), takes what the switch-in effects changed from the engine's state (viewFromState) and the
// AI's knowledge from its battle-start log (rememberStep, as model.ts initialMemory does), and checks each effect
// against the cartridge's rule. Where the engine can't give the cartridge's result it refuses, AiError('UNDEFINED')
// with a named reason (SWITCH_IN_REFUSALS), never a guess.
//
// The cartridge (pret/pokeplatinum 62bdaacdc). BattleControllerPlayer_TrainerMessage sorts monSpeedOrder before any
// field condition is set (battle_controller_player.c:249). BattleControllerPlayer_ShowBattleMon then runs
// BattleSystem_TriggerEffectOnSwitch (battle_lib.c:3649–4175) until it is done (battle_controller_player.c:254–267). It
// takes one step at a time, each step for both battlers in monSpeedOrder before the next:
// - the field weather (:3662–3707), which initialView applies from the trainer's field note (the engine applies the
//   note itself: permanent weather, Trick Room and Gravity);
// - Trace (:3712–3737), the weather abilities (:3739–3793), Intimidate (:3795–3813) and Download (:3815–3859);
// - Anticipation, Forewarn, Frisk, Slow Start, Mold Breaker and Pressure, which only print (:3861–4113);
// - the form changes (:4115–4121), Amulet Coin, the status-curing abilities (:4135–4149) and the held items
//   (:4151–4165).
// Then it sorts the speeds again (battle_controller_player.c:263): initialView's battleStartSpeeds.
//
// The engine runs Showdown's Gen 4 switch-ins, Pokémon by Pokémon in speed order. In singles that order changes no
// result but the weather's, which the weather check compares. Only the leads take part: no switch-in effect reads a
// bench Pokémon, so the engine gets the leads alone (its player side can't hold a fainted Pokémon, which a bench may).

import { buildMoves, type KaizoMove } from '../battle/moves.js';
import type { LoadedData } from '../battle/types.js';
import type { BattleInput } from '../contracts/engine.js';
// TODO(engine): re-export installedData from engine/index.ts, then import it from there (the AI uses only the
// engine's public exports; this one deep import is the exception until the engine adds it).
import { installedData } from '../engine/dex.js';
import { BATTLE_START_CHANCE_NOTE, battleStartLog, createBattle, installKaizoDex, unmodelledIn } from '../engine/index.js';
import { viewFromState } from './adapter.js';
import {
  ABILITY_GLUTTONY, ABILITY_KLUTZ, ABILITY_MULTITYPE, COMPARE_SPEED_FASTER,
  FIELD_CONDITION_CASTFORM, FIELD_CONDITION_DEEP_FOG, FIELD_CONDITION_GRAVITY, FIELD_CONDITION_HAILING, FIELD_CONDITION_HAILING_PERM, FIELD_CONDITION_RAINING,
  FIELD_CONDITION_RAINING_PERM, FIELD_CONDITION_SANDSTORM_PERM, FIELD_CONDITION_SUNNY, FIELD_CONDITION_SUNNY_PERM,
  FIELD_CONDITION_TRICK_ROOM, FIELD_CONDITION_WEATHER, ITEM_NONE, MON_CONDITION_ANY, MON_CONDITION_ANY_POISON, MON_CONDITION_BURN,
  MON_CONDITION_FREEZE, MON_CONDITION_PARALYSIS, MON_CONDITION_SLEEP, MOVE_NONE, SPECIES_ARCEUS, SPECIES_GIRATINA,
  TYPE_FIRE, TYPE_ICE, TYPE_NORMAL, TYPE_WATER,
} from './constants.js';
import { enumerate } from './enumerate.js';
import { AiError } from './errors.js';
import { cdiv } from './int.js';
import { noCloudNine } from './lib/battler.js';
import { PATHS } from './lib/known.js';
import { compareSpeed, type Latents, statStageBoost } from './lib/speed.js';
import { battleStartMemory } from './model.js';
import type { AiRomData } from './rom/aiData.js';
import { AI_BATTLER, type AiBattleMon, type AiDeps, type AiKnowledge, type AiPartyMon, type AiView, PLAYER_BATTLER } from './view.js';

/**
 * Why applySwitchIns refuses. Its UNDEFINED message is `turn-1 switch-in, <reason>: <detail>`.
 * - startChance: a draw decides the switch-ins: the engine marks its start unmodelled (BATTLE_START_CHANCE_NOTE: its
 *   start's chances end in different states, and battleStartLog holds the first outcome's lines). That covers
 *   SortMonSpeedOrder's draws (an exact tie, a Quick Claw's speedRand) where the order matters: the engine draws them too;
 * - giratina: Giratina-Origin without the Griseous Orb, which the cartridge reverts to Altered (battle_lib.c:6412–6458)
 *   and the engine doesn't;
 * - trace, weather, form, status, heldItem: the engine's result for that step isn't the cartridge's (a form change the
 *   engine doesn't make; White Herb after an Intimidate; an item whose hack record the engine doesn't model);
 * A pinch item whose parameter is 0 (the hack's Ganlon Berry, Apicot Berry and Shoal Salt) is no refusal since the
 * engine models it: the cartridge's `maxHP / param` is _u32_div_f (ARM9 0x020E2178), which gives x for x / 0, so it is eaten at
 * entry at any HP, and the engine models that (mod/items.ts pinchCheck); overlayLead checks its stage change.
 */
export const SWITCH_IN_REFUSALS = {
  startChance: 'battle-start chance', giratina: 'Giratina-Origin without the Griseous Orb', trace: 'Trace',
  weather: 'weather', fog: 'deep fog', trickRoom: 'Trick Room', gravity: 'Gravity', form: 'form change', status: 'status cure',
  heldItem: 'held item',
} as const;

/** The prefix of every refusal's message. */
export const SWITCH_IN_MESSAGE = 'turn-1 switch-in, ';

function refuse(reason: keyof typeof SWITCH_IN_REFUSALS, detail: string): never {
  throw new AiError('UNDEFINED', `${SWITCH_IN_MESSAGE}${SWITCH_IN_REFUSALS[reason]}: ${detail}`);
}

// IDs are line − 1 of generated/abilities.txt, species.txt, items.txt and item_hold_effects.txt; forms.h gives forms.
const ABILITY_DRIZZLE = 2;
const ABILITY_LIMBER = 7;
const ABILITY_INSOMNIA = 15;
const ABILITY_IMMUNITY = 17;
const ABILITY_INTIMIDATE = 22;
const ABILITY_TRACE = 36;
const ABILITY_CLEAR_BODY = 29;
const ABILITY_HYPER_CUTTER = 52;
const ABILITY_WHITE_SMOKE = 73;
const ABILITY_MAGMA_ARMOR = 40;
const ABILITY_WATER_VEIL = 41;
const ABILITY_SAND_STREAM = 45;
const ABILITY_FORECAST = 59;
const ABILITY_DROUGHT = 70;
const ABILITY_VITAL_SPIRIT = 72;
const ABILITY_DOWNLOAD = 88;
const ABILITY_SNOW_WARNING = 117;
const SPECIES_CASTFORM = 351;
const SPECIES_CHERRIM = 421;
const ITEM_GRISEOUS_ORB = 112;
const GIRATINA_FORM_ORIGIN = 1; // forms.h:94
const CASTFORM_FORM = { NORMAL: 0, SUNNY: 1, RAINY: 2, SNOWY: 3 } as const; // forms.h:48–51
const CHERRIM_FORM = { OVERCAST: 0, SUNSHINE: 1 } as const; // forms.h:73–74
const HOLD_EFFECT = {
  HP_RESTORE: 1, PRZ_RESTORE: 5, SLP_RESTORE: 6, PSN_RESTORE: 7, BRN_RESTORE: 8, FRZ_RESTORE: 9, PP_RESTORE: 10,
  CONFUSE_RESTORE: 11, STATUS_RESTORE: 12, HP_PCT_RESTORE: 13, HP_RESTORE_SPICY: 14, HP_RESTORE_DRY: 15,
  HP_RESTORE_SWEET: 16, HP_RESTORE_BITTER: 17, HP_RESTORE_SOUR: 18, PINCH_ATK_UP: 36, PINCH_DEF_UP: 37,
  PINCH_SPEED_UP: 38, PINCH_SPATK_UP: 39, PINCH_SPDEF_UP: 40, PINCH_CRITRATE_UP: 41, PINCH_RANDOM_UP: 42,
  PINCH_ACC_UP: 44, STATDOWN_RESTORE: 49, HEAL_INFATUATION: 54, ARCEUS_FIRE: 126,
} as const;

/** The weather abilities and the _PERM bit each sets (battle_lib.c:3746–3782; subscript_drizzle.s:11–12 and its kin). */
const WEATHER_ABILITY_BITS: ReadonlyMap<number, number> = new Map([
  [ABILITY_DRIZZLE, FIELD_CONDITION_RAINING_PERM], [ABILITY_SAND_STREAM, FIELD_CONDITION_SANDSTORM_PERM],
  [ABILITY_DROUGHT, FIELD_CONDITION_SUNNY_PERM], [ABILITY_SNOW_WARNING, FIELD_CONDITION_HAILING_PERM],
]);
/** The abilities Trace can't take (ChooseTraceTarget, battle_lib.c:7750–7782). */
const UNTRACEABLE: readonly number[] = [ABILITY_FORECAST, ABILITY_TRACE, ABILITY_MULTITYPE];
/**
 * The status each ability cures on entry (BattleSystem_RecoverStatusByAbility, battle_lib.c:4378–4431). Own Tempo and
 * Oblivious cure confusion and attraction, which no battler has at battle start.
 */
const ENTRY_STATUS_CURES: ReadonlyMap<number, number> = new Map([
  [ABILITY_IMMUNITY, MON_CONDITION_ANY_POISON], [ABILITY_LIMBER, MON_CONDITION_PARALYSIS],
  [ABILITY_INSOMNIA, MON_CONDITION_SLEEP], [ABILITY_VITAL_SPIRIT, MON_CONDITION_SLEEP],
  [ABILITY_WATER_VEIL, MON_CONDITION_BURN], [ABILITY_MAGMA_ARMOR, MON_CONDITION_FREEZE],
]);
/** The status each held item cures (BattleSystem_TriggerHeldItemOnStatus, battle_lib.c:4991–5024, 5052–5086). */
const ITEM_STATUS_CURES: ReadonlyMap<number, number> = new Map([
  [HOLD_EFFECT.PRZ_RESTORE, MON_CONDITION_PARALYSIS], [HOLD_EFFECT.SLP_RESTORE, MON_CONDITION_SLEEP],
  [HOLD_EFFECT.PSN_RESTORE, MON_CONDITION_ANY_POISON], [HOLD_EFFECT.BRN_RESTORE, MON_CONDITION_BURN],
  [HOLD_EFFECT.FRZ_RESTORE, MON_CONDITION_FREEZE], [HOLD_EFFECT.STATUS_RESTORE, MON_CONDITION_ANY],
]);
const FLAVOR_BERRIES: readonly number[] = [
  HOLD_EFFECT.HP_RESTORE_SPICY, HOLD_EFFECT.HP_RESTORE_DRY, HOLD_EFFECT.HP_RESTORE_SWEET, HOLD_EFFECT.HP_RESTORE_BITTER,
  HOLD_EFFECT.HP_RESTORE_SOUR,
];
const PINCH_ITEMS: readonly number[] = [
  HOLD_EFFECT.PINCH_ATK_UP, HOLD_EFFECT.PINCH_DEF_UP, HOLD_EFFECT.PINCH_SPEED_UP, HOLD_EFFECT.PINCH_SPATK_UP,
  HOLD_EFFECT.PINCH_SPDEF_UP, HOLD_EFFECT.PINCH_CRITRATE_UP, HOLD_EFFECT.PINCH_RANDOM_UP, HOLD_EFFECT.PINCH_ACC_UP,
];
/** The hold effects BattleSystem_TriggerHeldItemOnStatus acts on (battle_lib.c:4974–5297). */
export const ENTRY_HOLD_EFFECTS: ReadonlySet<number> = new Set([
  HOLD_EFFECT.HP_RESTORE, HOLD_EFFECT.HP_PCT_RESTORE, ...ITEM_STATUS_CURES.keys(), HOLD_EFFECT.PP_RESTORE,
  HOLD_EFFECT.CONFUSE_RESTORE, HOLD_EFFECT.STATDOWN_RESTORE, HOLD_EFFECT.HEAL_INFATUATION, ...FLAVOR_BERRIES, ...PINCH_ITEMS,
]);

/** An item's hold effect and parameter, as the switch-in reads them. */
interface HoldRecord { effect: number; param: number }

/**
 * Vanilla Platinum's items with a hold effect BattleSystem_TriggerHeldItemOnStatus acts on: res/items/data/<name>.json's
 * holdEffect and effectParam (checked against the vanilla ROM by test/real/aiRom.test.ts). The engine's items are
 * Showdown's Gen 4 ones, which are vanilla's, so an item whose ROM record differs is one the engine doesn't model.
 */
export const VANILLA_ENTRY_ITEMS: ReadonlyMap<number, HoldRecord> = new Map(([
  [43, 1, 20], // Berry Juice
  [149, 5, 0], [150, 6, 0], [151, 7, 0], [152, 8, 0], [153, 9, 0], // Cheri, Chesto, Pecha, Rawst, Aspear
  [154, 10, 10], [155, 1, 10], [156, 11, 0], [157, 12, 0], [158, 13, 25], // Leppa, Oran, Persim, Lum, Sitrus
  [159, 14, 8], [160, 15, 8], [161, 16, 8], [162, 17, 8], [163, 18, 8], // Figy, Wiki, Mago, Aguav, Iapapa
  [201, 36, 4], [202, 37, 4], [203, 38, 4], [204, 39, 4], [205, 40, 4], [206, 41, 4], [207, 42, 4], // Liechi … Starf
  [209, 44, 4], // Micle
  [214, 49, 0], [219, 54, 0], // White Herb, Mental Herb
] as const).map(([id, effect, param]) => [id, { effect, param }]));

/**
 * The hack's pinch items with parameter 0, which the engine models (mod/items.ts pinchCheck): Ganlon
 * Berry (item 202, Defense), Apicot Berry (205, Sp. Def) and Shoal Salt (70, Attack), by ROM item ID. They stand in for
 * VANILLA_ENTRY_ITEMS' record (Ganlon and Apicot with parameter 4, Shoal Salt with no effect) as the engine's.
 * test/real/aiRom.test.ts checks them against the hack's item data.
 */
export const HACK_PINCH_ZERO_ITEMS: ReadonlyMap<number, HoldRecord> = new Map([
  [70, { effect: HOLD_EFFECT.PINCH_ATK_UP, param: 0 }],
  [202, { effect: HOLD_EFFECT.PINCH_DEF_UP, param: 0 }],
  [205, { effect: HOLD_EFFECT.PINCH_SPDEF_UP, param: 0 }],
]);

const LEADS = [PLAYER_BATTLER, AI_BATTLER] as const;

/**
 * What applySwitchIns gives: the view after the switch-in effects, the AI's knowledge at its first decision, and the
 * steps that fired, by name (FiredStep). With none, every field the engine gives equals the load's (overlayLead), so
 * the view is `loaded` itself.
 */
export interface SwitchInResult { view: AiView; knowledge: AiKnowledge; steps: string[] }

/**
 * The view `loaded` (initialView's, as InitBattleMon loads the leads, with the field note's conditions) after the
 * leads' switch-in effects, and the AI's knowledge then. `battle` is the battle start for the engine: the two leads,
 * their side's data and `loaded`'s field note. `deps` needs only the item records (the speed comparison reads them).
 * The view's monSpeedValues are `loaded`'s: the caller compares the speeds again. Installs the engine's dex from `data`
 * (installDex). Throws AiError('UNDEFINED') with a SWITCH_IN_REFUSALS reason, and AiError('BAD_VIEW') where the engine
 * changed a field no step that fired changes (overlayLead), or its leads aren't the loaded ones (sameLoad).
 */
export function applySwitchIns(battle: BattleInput, loaded: AiView, deps: AiDeps, data: LoadedData, ai: AiRomData): SwitchInResult {
  for (const b of LEADS) {
    const mon = loaded.mons[b];
    if (mon.species === SPECIES_GIRATINA && mon.form === GIRATINA_FORM_ORIGIN && mon.heldItem !== ITEM_GRISEOUS_ORB) {
      refuse('giratina', `battler ${b} would revert to Altered (battle_lib.c:6412–6417, subscript_giratina_form_change.s)`);
    }
  }

  installDex(data);
  const state = createBattle(battle);
  if (unmodelledIn(state).includes(BATTLE_START_CHANCE_NOTE)) {
    refuse('startChance', 'the engine\'s battle start ends in different states (it keeps the first outcome\'s)');
  }
  const log = battleStartLog(state);
  const lines = log.map(parseLine);

  const { abilities, traced } = postTraceAbilities(loaded, lines);
  const { mask, fired: weatherFired } = switchInWeather(loaded, deps, abilities, lines);
  // The AI's knowledge as the engine path's initialMemory has it: the same fold, from the note's _PERM weather, which
  // drops a weather ability's line where the cartridge prints none.
  const memory = battleStartMemory(state);
  const engine = viewFromState(state, data, ai, memory);
  for (const b of LEADS) sameLoad(loaded.mons[b], engine.mons[b], b);
  checkField(engine.fieldConditionsMask, mask);

  const afterAbilities: AiView = { ...loaded, fieldConditionsMask: mask, mons: withAbilities(loaded, abilities) };
  const mons = [...loaded.mons] as AiView['mons'];
  const parties: AiView['parties'] = [[...loaded.parties[0]], [...loaded.parties[1]]];
  const recycleItem = [...loaded.recycleItem];
  const steps: string[] = weatherFired ? ['a weather ability'] : [];
  for (const b of LEADS) {
    const item = checkHeldItem(afterAbilities, ai, abilities[b]!, b, lines, engine.mons[b]);
    const fired = leadSteps(loaded, b, abilities, traced, item);
    const lead = overlayLead(
      { mon: loaded.mons[b], party: loaded.parties[b][0]!, recycleItem: loaded.recycleItem[b]! },
      { mon: engine.mons[b], party: engine.parties[b][0]!, recycleItem: engine.recycleItem[b]! }, fired, b,
    );
    // Battler_Ability after the Trace step, as the later steps read it.
    if (lead.mon.ability !== abilities[b]) {
      throw new AiError('BAD_VIEW', `the engine's battler ${b} has ability ${lead.mon.ability} after the switch-ins, the C's ${abilities[b]}`);
    }
    const form = switchInForm(afterAbilities, ai, b, engine.mons[b]);
    if (form.form !== loaded.mons[b].form || form.types.join() !== loaded.mons[b].types.join()) fired.push({ step: 'a form change', fields: [] });
    mons[b] = { ...lead.mon, ...form };
    parties[b][0] = lead.party;
    recycleItem[b] = lead.recycleItem;
    steps.push(...fired.map((step) => `${step.step} (battler ${b})`));
  }
  // The engine view's gaps among the fields taken from it: the recycleItem its memory can't settle (read/compose.ts).
  const taken = LEADS.map((b) => PATHS.recycleItem(b));
  const unknown = [...new Set([...loaded.unknown, ...engine.unknown.filter((path) => taken.includes(path))])];
  return { view: { ...loaded, mons, parties, recycleItem, fieldConditionsMask: mask, unknown }, knowledge: memory.knowledge, steps };
}

/** The moves buildMoves made for each LoadedData, so a repeated install of the same data is the engine's no-op. */
const builtMoves = new WeakMap<LoadedData, Map<number, KaizoMove>>();

/**
 * The engine's dex from `data`. When the installed dex is already `data`'s (installedData, engine/dex.ts, which
 * engine/index.ts doesn't re-export), it is kept with its moves; otherwise installKaizoDex installs `data`'s, its moves
 * built once per LoadedData. The dex is global: createBattle, restore and everything that reads a state run on the
 * installed one (docs/ai-reads.md, "The first decision").
 */
function installDex(data: LoadedData): void {
  if (installedDataOrNull() === data) return;
  let moves = builtMoves.get(data);
  if (moves === undefined) {
    moves = buildMoves(data);
    builtMoves.set(data, moves);
  }
  installKaizoDex(data, moves);
}

/** The message engine/dex.ts current() throws with when no dex is installed (a plain Error, with no code to match). */
const NO_DEX_MESSAGE = 'No Kaizo dex is installed';

/** installedData(), or null when no dex is installed, where it throws (engine/dex.ts current()). Rethrows anything else. */
function installedDataOrNull(): LoadedData | null {
  try {
    return installedData();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(NO_DEX_MESSAGE)) return null;
    throw error;
  }
}

/** One battle-start log line: its command, the battler its first argument names (null for none), its arguments and tags. */
interface StartLine { cmd: string; subject: number | null; args: string[]; from: string; of: number | null }

/** `p1a: Name` → 0, `p2a: Name` → 1, anything else → null. */
function battlerOf(ident: string | undefined): number | null {
  const match = /^p([12])a(?::|$)/.exec(ident ?? '');
  if (match === null) return null;
  return match[1] === '1' ? PLAYER_BATTLER : AI_BATTLER;
}

function parseLine(text: string): StartLine {
  const [cmd = '', ...parts] = text.startsWith('|') ? text.slice(1).split('|') : [''];
  const args = parts.filter((part) => !part.startsWith('['));
  const tag = (name: string) => parts.find((part) => part.startsWith(`[${name}] `))?.slice(name.length + 3);
  return { cmd, subject: battlerOf(args[0]), args, from: tag('from') ?? '', of: battlerOf(tag('of')) };
}

/**
 * Each lead's ability after the Trace step, checked against the engine's. Trace (battle_lib.c:3712–3737) takes the
 * foe's ability when the tracer holds no Griseous Orb (:3723) and ChooseTraceTarget finds the foe: alive, and its
 * ability not Forecast, Trace or Multitype (:7750–7782; in singles both of its slots are the one foe). Showdown's Gen 4
 * Trace refuses the same three (their `notrace` flag), and the engine's doesn't trace for a Griseous Orb holder either;
 * a difference is refused. The later steps read the traced ability (Battler_Ability).
 */
function postTraceAbilities(loaded: AiView, lines: readonly StartLine[]): { abilities: number[]; traced: boolean[] } {
  const traced = LEADS.map((b) => {
    const mon = loaded.mons[b];
    const foe = loaded.mons[b ^ 1]!;
    const traces = mon.ability === ABILITY_TRACE && mon.heldItem !== ITEM_GRISEOUS_ORB && foe.curHP > 0 && !UNTRACEABLE.includes(foe.ability);
    const engineTraced = lines.some((line) => line.cmd === '-ability' && line.subject === b && line.from === 'ability: Trace');
    if (traces !== engineTraced) {
      refuse('trace', `battler ${b} ${traces ? 'traces' : 'doesn\'t trace'} ability ${foe.ability} on the cartridge, and ${engineTraced ? 'does' : 'doesn\'t'} in the engine`);
    }
    return traces;
  });
  return { abilities: LEADS.map((b) => (traced[b] ? loaded.mons[b ^ 1]!.ability : loaded.mons[b].ability)), traced };
}

/** `loaded`'s first two battlers with `abilities`. */
function withAbilities(loaded: AiView, abilities: readonly number[]): AiView['mons'] {
  const mons = [...loaded.mons] as AiView['mons'];
  for (const b of LEADS) mons[b] = { ...loaded.mons[b], ability: abilities[b]! };
  return mons;
}

/**
 * The switch-in weather: fieldConditionsMask after the weather step. In monSpeedOrder, a weather ability whose _PERM
 * bit is clear clears every weather bit and sets its own, announcing itself; one whose bit is set already does nothing
 * (battle_lib.c:3746–3782; subscript_drizzle.s:8–12 and its kin). The field starts with the note's weather
 * (initialView), and so does the engine: this checks that the engine announced just the holders the
 * cartridge does. Two leads with weather abilities in an order a draw decides: refused by
 * the engine's start-chance note, as the last one's weather stays and only the first may announce. `fired`: a weather
 * ability's subscript ran on the cartridge, so the field changed.
 */
function switchInWeather(
  loaded: AiView, deps: AiDeps, abilities: readonly number[], lines: readonly StartLine[],
): { mask: number; fired: boolean } {
  const holders = LEADS.filter((b) => WEATHER_ABILITY_BITS.has(abilities[b]!));
  if (holders.length === 0) return { mask: loaded.fieldConditionsMask, fired: false };
  const order = holders.length === 2 ? switchInOrder(loaded, deps) : [holders[0]!];
  // A draw here (an exact tie, a Quick Claw's speedRand) is one the engine draws too, and as the two orders leave
  // different weathers, its start is marked unmodelled and refused before this (BATTLE_START_CHANCE_NOTE; the unit test
  // 'two weather abilities whose order a Quick Claw draw decides'). Reaching it means the engine's speeds aren't the
  // cartridge's.
  if (order === null) {
    throw new AiError('BAD_VIEW', 'SortMonSpeedOrder draws the order of the two weather abilities (battle_lib.c:3364–3384), but the engine has no start chance');
  }
  const announced = (start: number): Set<number> => {
    let weather = start;
    const out = new Set<number>();
    for (const b of order) {
      const bit = WEATHER_ABILITY_BITS.get(abilities[b]!);
      if (bit === undefined || (weather & bit) !== 0) continue;
      weather = bit;
      out.add(b);
    }
    return out;
  };
  const noteWeather = loaded.fieldConditionsMask & FIELD_CONDITION_WEATHER;
  const cartridge = announced(noteWeather);
  // The engine starts the note's weather first, so it announces just what the cartridge does.
  const engineExpected = cartridge;
  const engineAnnounced = new Set<number>();
  for (const line of lines) {
    if (line.cmd === '-weather' && line.from.startsWith('ability: ') && line.of !== null) engineAnnounced.add(line.of);
  }
  if ([...engineExpected].sort().join() !== [...engineAnnounced].sort().join()) {
    refuse('weather', `the engine announces battlers [${[...engineAnnounced].join(', ')}], expected [${[...engineExpected].join(', ')}]`);
  }
  // The last holder in monSpeedOrder sets the weather that stays, announced or not.
  const last = WEATHER_ABILITY_BITS.get(abilities[order[order.length - 1]!]!)!;
  return { mask: (loaded.fieldConditionsMask & ~FIELD_CONDITION_WEATHER) | last, fired: cartridge.size > 0 };
}

/**
 * The engine's field conditions against the cartridge's after the switch-ins, refusing (AiError('UNDEFINED'), by name) where
 * they differ. The engine starts the note's weather (permanent), Trick Room and Gravity itself, and a
 * weather ability replaces its weather as the cartridge does; its view shows the note's deep fog until a weather clears it
 * (memory.ts `fog`). Compared: the weather bits (the _PERM bit and the _TEMP bit alike), the deep fog bit, and whether Trick
 * Room and Gravity are up, not their counters (the AI tests them for non-zero, and the engine's are the move's, with no end).
 */
export function checkField(engine: number, cartridge: number): void {
  const weather = FIELD_CONDITION_WEATHER & ~FIELD_CONDITION_DEEP_FOG;
  if ((engine & weather) !== (cartridge & weather)) {
    refuse('weather', `the engine's weather bits ${engine & weather} aren't the cartridge's ${cartridge & weather}`);
  }
  if ((engine & FIELD_CONDITION_DEEP_FOG) !== (cartridge & FIELD_CONDITION_DEEP_FOG)) {
    refuse('fog', `the engine's deep fog is ${(engine & FIELD_CONDITION_DEEP_FOG) !== 0 ? 'up' : 'down'}, the cartridge's ${(cartridge & FIELD_CONDITION_DEEP_FOG) !== 0 ? 'up' : 'down'}`);
  }
  if (((engine & FIELD_CONDITION_TRICK_ROOM) !== 0) !== ((cartridge & FIELD_CONDITION_TRICK_ROOM) !== 0)) {
    refuse('trickRoom', `the engine's Trick Room bits ${engine & FIELD_CONDITION_TRICK_ROOM} and the cartridge's ${cartridge & FIELD_CONDITION_TRICK_ROOM} differ in being up`);
  }
  if (((engine & FIELD_CONDITION_GRAVITY) !== 0) !== ((cartridge & FIELD_CONDITION_GRAVITY) !== 0)) {
    refuse('gravity', `the engine's Gravity bits ${engine & FIELD_CONDITION_GRAVITY} and the cartridge's ${cartridge & FIELD_CONDITION_GRAVITY} differ in being up`);
  }
}

/**
 * monSpeedOrder as BattleControllerPlayer_TrainerMessage sorts it (battle_controller_player.c:249): before the field
 * weather is set, so with an empty field mask; BattleSystem_SortMonSpeedOrder swaps battlers 0 and 1 when
 * BattleSystem_CompareBattlerSpeed(0, 1, ignoreQuickClaw TRUE) isn't COMPARE_SPEED_FASTER (battle_lib.c:3364–3384).
 * Null when a draw decides it: an exact tie, or a Quick Claw holder's speedRand, drawn at battle start (battle_lib.c:2024).
 */
function switchInOrder(loaded: AiView, deps: AiDeps): number[] | null {
  const atTrainerMessage: AiView = { ...loaded, fieldConditionsMask: 0 };
  const latents = (): Latents => ({ rolls: [null, null, null, null], quickClaw: [null, null, null, null] });
  const swaps = enumerate((pick) => compareSpeed(atTrainerMessage, deps, latents(), PLAYER_BATTLER, AI_BATTLER, pick).result !== COMPARE_SPEED_FASTER, String)
    .filter((leaf) => leaf.probability.num !== 0n);
  if (swaps.length !== 1) return null;
  return swaps[0]!.value ? [AI_BATTLER, PLAYER_BATTLER] : [PLAYER_BATTLER, AI_BATTLER];
}

/**
 * The form step for battler `b` (BattleSystem_TriggerFormChange, battle_lib.c:6305–6463), checked against the
 * engine's, on `v`: the view after the abilities' steps (the switch-in weather, the traced abilities). It repeats until
 * nothing changes; for one battler one change is the fixed point. Cloud Nine and Air Lock are NO_CLOUD_NINE's
 * (include/battle/common.h:63, lib/battler.ts noCloudNine).
 * - Forecast Castform (:6314–6364): Normal with no rain, sun or hail (or under Cloud Nine or Air Lock), else the
 *   weather's type and form, unless it has that type already; in sand it keeps its own.
 * - Cherrim (:6366–6397, any ability): Sunshine in the sun, Overcast with no weather or in rain or hail (or under Cloud
 *   Nine or Air Lock); in sand it keeps its own.
 * - Multitype Arceus: the form is its plate's type (:6399–6410), as are the types InitBattleMon loads for it
 *   (pokemon.c:1221–1222): Pokemon_GetArceusTypeOf of the item's hold effect (pokemon.c:4319–4373), Normal for none.
 *   The engine's Showdown form gives the types, not BattleMon.form, so the form is this rule's.
 * Giratina was refused before. Any other species' form and types are the load's. The engine's form or types differing
 * from the cartridge's: refused.
 */
function switchInForm(v: AiView, ai: AiRomData, b: number, engine: AiBattleMon): Pick<AiBattleMon, 'types' | 'form'> {
  const mon = v.mons[b]!;
  let expected: Pick<AiBattleMon, 'types' | 'form'> = { types: [mon.types[0], mon.types[1]], form: mon.form };
  let compareForm = true;
  if (mon.species === SPECIES_CASTFORM && mon.ability === ABILITY_FORECAST) expected = castformForm(v, mon);
  else if (mon.species === SPECIES_CHERRIM) expected = { ...expected, form: cherrimForm(v, mon.form) };
  else if (mon.species === SPECIES_ARCEUS && mon.ability === ABILITY_MULTITYPE) {
    const type = arceusType(holdRecord(ai, mon.heldItem)?.effect ?? 0);
    expected = { types: [type, type], form: type };
    compareForm = false;
  } else {
    return expected;
  }
  const same = engine.types[0] === expected.types[0] && engine.types[1] === expected.types[1] && (!compareForm || engine.form === expected.form);
  if (!same) {
    refuse('form', `battler ${b} (species ${mon.species}) is types ${expected.types.join('/')}, form ${expected.form} on the cartridge, `
      + `types ${engine.types.join('/')}, form ${engine.form} in the engine`);
  }
  return expected;
}

function castformForm(v: AiView, mon: AiBattleMon): Pick<AiBattleMon, 'types' | 'form'> {
  const has = (type: number) => mon.types[0] === type || mon.types[1] === type;
  const to = (type: number, form: number) => ({ types: [type, type] as [number, number], form });
  const mask = v.fieldConditionsMask;
  if (!noCloudNine(v) || (mask & FIELD_CONDITION_CASTFORM) === 0) { // :6318–6326, 6355–6362
    return has(TYPE_NORMAL) ? { types: [mon.types[0], mon.types[1]], form: mon.form } : to(TYPE_NORMAL, CASTFORM_FORM.NORMAL);
  }
  if ((mask & FIELD_CONDITION_SUNNY) !== 0 && !has(TYPE_FIRE)) return to(TYPE_FIRE, CASTFORM_FORM.SUNNY); // :6327–6335
  if ((mask & FIELD_CONDITION_RAINING) !== 0 && !has(TYPE_WATER)) return to(TYPE_WATER, CASTFORM_FORM.RAINY); // :6336–6344
  if ((mask & FIELD_CONDITION_HAILING) !== 0 && !has(TYPE_ICE)) return to(TYPE_ICE, CASTFORM_FORM.SNOWY); // :6345–6353
  return { types: [mon.types[0], mon.types[1]], form: mon.form };
}

function cherrimForm(v: AiView, form: number): number {
  const mask = v.fieldConditionsMask;
  if (!noCloudNine(v)) return form === CHERRIM_FORM.SUNSHINE ? CHERRIM_FORM.OVERCAST : form; // :6391–6395
  if ((mask & FIELD_CONDITION_CASTFORM) === 0 && form === CHERRIM_FORM.SUNSHINE) return CHERRIM_FORM.OVERCAST; // :6369–6374
  if ((mask & FIELD_CONDITION_SUNNY) !== 0 && form === CHERRIM_FORM.OVERCAST) return CHERRIM_FORM.SUNSHINE; // :6375–6379
  if ((mask & (FIELD_CONDITION_RAINING | FIELD_CONDITION_HAILING)) !== 0 && form === CHERRIM_FORM.SUNSHINE) return CHERRIM_FORM.OVERCAST; // :6380–6389
  return form;
}

/** Pokemon_GetArceusTypeOf (pokemon.c:4319–4373): the plates' hold effects 126–141 in their order, Normal otherwise. */
function arceusType(holdEffect: number): number {
  // Fire, Water, Electric, Grass, Ice, Fighting, Poison, Ground, Flying, Psychic, Bug, Rock, Ghost, Dragon, Dark, Steel.
  const PLATE_TYPES = [10, 11, 13, 12, 15, 1, 3, 4, 2, 14, 6, 5, 7, 16, 17, 8];
  return PLATE_TYPES[holdEffect - HOLD_EFFECT.ARCEUS_FIRE] ?? TYPE_NORMAL;
}

/** Item `item`'s ROM hold effect and parameter; AiError('BAD_VIEW') for an item the data has no record of. */
function holdRecord(ai: AiRomData, item: number): HoldRecord | null {
  if (item === ITEM_NONE) return null;
  const record = ai.items[item];
  if (record === undefined || record === null) throw new AiError('BAD_VIEW', `item ${item} has no record; the cartridge would read past its item table`);
  return { effect: record.holdEffect, param: record.holdParam };
}

/** What the held-item step did for a battler: whether its ability cured its status first, and the item that acted. */
interface ItemStep { cured: boolean; item: number; effect: number | null }

/**
 * The held-item step for battler `b` (battle_lib.c:4151–4165), checked against the engine's. On `v` (after the ability
 * steps), the battler's item acts as BattleSystem_TriggerHeldItemOnStatus says (entryItemActs) on the ROM's record of
 * its item; none under Klutz (Battler_HeldItemEffect, battle_lib.c:5354). The engine acts when its log uses the item up
 * (`-enditem`: every such item is used up). Refused: an item whose ROM record isn't the engine's (VANILLA_ENTRY_ITEMS,
 * or HACK_PINCH_ZERO_ITEMS for the pinch items with parameter 0, which the engine models) when either side can act; a vanilla item the two sides use differently (Showdown's White Herb
 * doesn't act on a battle-start stat drop). Where both act, the HP, status and PP the engine ends with must be the C's
 * (the status-curing ability's step included).
 */
function checkHeldItem(v: AiView, ai: AiRomData, ability: number, b: number, lines: readonly StartLine[], engine: AiBattleMon): ItemStep {
  const mon = v.mons[b]!;
  // The status-curing abilities' step comes first (battle_lib.c:4135–4149): BattleSystem_RecoverStatusByAbility.
  const cure = ENTRY_STATUS_CURES.get(ability) ?? 0;
  const cured = (mon.status & cure) !== 0;
  let status = cured ? 0 : mon.status;
  let hp = mon.curHP;
  const pp = [...mon.ppCur];
  const rom = ability === ABILITY_KLUTZ ? null : holdRecord(ai, mon.heldItem);
  const vanilla = HACK_PINCH_ZERO_ITEMS.get(mon.heldItem) ?? VANILLA_ENTRY_ITEMS.get(mon.heldItem) ?? null;
  const entry = rom !== null && ENTRY_HOLD_EFFECTS.has(rom.effect) ? rom : null;
  // Intimidate is the one earlier step that lowers a stage (subscript_intimidate.s): its `-unboost` line.
  const lowered = lines.some((line) => line.cmd === '-unboost' && line.subject === b);
  const acts = entry === null ? false : entryItemActs(entry, { ...mon, status }, ability, lowered);
  const engineActs = lines.some((line) => line.cmd === '-enditem' && line.subject === b);
  const vanillaRecord = ability === ABILITY_KLUTZ ? null : vanilla;
  const same = entry?.effect === vanillaRecord?.effect && entry?.param === vanillaRecord?.param;
  if (!same && (acts || engineActs)) {
    refuse('heldItem', `battler ${b}'s item ${mon.heldItem} has the hack's hold effect ${entry?.effect ?? 0}/${entry?.param ?? 0}, `
      + `the engine's is vanilla's ${vanillaRecord?.effect ?? 0}/${vanillaRecord?.param ?? 0}`);
  }
  if (acts !== engineActs) {
    refuse('heldItem', `battler ${b}'s item ${mon.heldItem} ${acts ? 'acts' : 'doesn\'t act'} on the cartridge, and ${engineActs ? 'does' : 'doesn\'t'} in the engine`);
  }
  if (acts && entry !== null) {
    const effect = entry.effect;
    // subscript_held_item_hp_restore.s adds hpCalcTemp up to maxHP.
    if (effect === HOLD_EFFECT.HP_RESTORE) hp = Math.min(mon.maxHP, hp + entry.param); // :4975–4981
    if (effect === HOLD_EFFECT.HP_PCT_RESTORE) hp = Math.min(mon.maxHP, hp + divide(mon.maxHP * entry.param, 100)); // :4983–4989
    if (FLAVOR_BERRIES.includes(effect)) hp = Math.min(mon.maxHP, hp + divide(mon.maxHP, entry.param)); // :5121–5194
    const itemCure = ITEM_STATUS_CURES.get(effect);
    if (itemCure !== undefined) status &= ~itemCure;
    if (effect === HOLD_EFFECT.PP_RESTORE) { // :5026–5043; BattleMon_AddVal caps at the maximum PP (battle_lib.c:1013–1018)
      const slot = mon.moves.findIndex((move, i) => move !== MOVE_NONE && pp[i] === 0);
      pp[slot] = Math.min(mon.ppMax[slot]!, pp[slot]! + entry.param);
    }
  }
  if (engine.status !== status) refuse('status', `battler ${b}'s status is ${status} on the cartridge, ${engine.status} in the engine`);
  if (engine.curHP !== hp || engine.ppCur.join() !== pp.join()) {
    refuse('heldItem', `battler ${b} has ${hp} HP and PP ${pp.join('/')} on the cartridge, ${engine.curHP} and ${engine.ppCur.join('/')} in the engine`);
  }
  return { cured, item: mon.heldItem, effect: acts && entry !== null ? entry.effect : null };
}

/** A pinch item's parameter as the C tests it: halved under Gluttony (battle_lib.c:5197–5199 and kin), in C integers. */
function pinchParam(record: HoldRecord, ability: number): number {
  return ability === ABILITY_GLUTTONY ? Math.trunc(record.param / 2) : record.param;
}

/**
 * Whether BattleSystem_TriggerHeldItemOnStatus acts for `record` on the battler `mon` at battle start
 * (battle_lib.c:4973–5297). No battler is confused, attracted or focused at battle start, and no stage is at +6, so
 * those tests pass or fail outright. `lowered`: a stage is below neutral (White Herb, :5088–5100). A pinch item's
 * `maxHP / param` is _u32_div_f's (u32Divide), so a parameter of 0 acts at any HP.
 */
function entryItemActs(record: HoldRecord, mon: AiBattleMon, ability: number, lowered: boolean): boolean {
  const { effect } = record;
  const halfHp = mon.curHP <= cdiv(mon.maxHP, 2);
  if (effect === HOLD_EFFECT.HP_RESTORE || effect === HOLD_EFFECT.HP_PCT_RESTORE || FLAVOR_BERRIES.includes(effect)) return halfHp;
  const cure = ITEM_STATUS_CURES.get(effect);
  if (cure !== undefined) return (mon.status & cure) !== 0;
  if (effect === HOLD_EFFECT.PP_RESTORE) return mon.moves.some((move, i) => move !== MOVE_NONE && mon.ppCur[i] === 0);
  if (effect === HOLD_EFFECT.STATDOWN_RESTORE) return lowered;
  if (PINCH_ITEMS.includes(effect)) return mon.curHP <= u32Divide(mon.maxHP, pinchParam(record, ability));
  return false; // CONFUSE_RESTORE and HEAL_INFATUATION: no confusion or attraction yet
}

/**
 * The pinch checks' `maxHP / itemPower`: overlay 16 calls _u32_div_f there (BLX to ARM9 0x020E2178 in both ROMs, F2's
 * handler diff), which returns x for x / 0.
 */
function u32Divide(dividend: number, divisor: number): number {
  return divisor === 0 ? dividend : Math.trunc(dividend / divisor);
}

/** BattleSystem_Divide (battle_lib.c:3599–3618): C division, at least 1 in size for a non-zero dividend. */
function divide(dividend: number, divisor: number): number {
  if (dividend === 0) return 0;
  const quotient = cdiv(dividend, divisor);
  return quotient === 0 ? Math.sign(dividend) : quotient;
}

/**
 * The engine's lead is the one initialView loaded: the same species, level and stats. AiError('BAD_VIEW') otherwise: the
 * engine's dex isn't the loaded data's, and its fields can't be laid over the load's.
 */
function sameLoad(loaded: AiBattleMon, engine: AiBattleMon, b: number): void {
  const fields = ['species', 'level', 'maxHP', 'attack', 'defense', 'spAttack', 'spDefense', 'speed'] as const;
  const differ = fields.filter((field) => loaded[field] !== engine[field]);
  if (differ.length > 0) {
    throw new AiError('BAD_VIEW', `the engine's battler ${b} differs from the loaded one in ${differ.map((field) => `${field} ${engine[field]} (loaded ${loaded[field]})`).join(', ')}`);
  }
}

/** A lead's fields a switch-in step can change: in its BattleMon, in its party entry, and its recycleItem. */
export type LeadField =
  | 'statBoosts' | 'ability' | 'status' | 'curHP' | 'heldItem' | 'statusVolatile' | 'ppCur'
  | 'party.hp' | 'party.status' | 'party.heldItem' | 'party.pp' | 'recycleItem';

/** Every LeadField: what applySwitchIns takes from the engine for a lead (with the form step's types and form). */
const LEAD_FIELDS: readonly LeadField[] = [
  'statBoosts', 'ability', 'status', 'curHP', 'heldItem', 'statusVolatile', 'ppCur', 'party.hp', 'party.status', 'party.heldItem',
  'party.pp', 'recycleItem',
];

/** A lead's LeadFields' holders: its BattleMon, its party entry and its recycleItem. */
export interface LeadFields { mon: AiBattleMon; party: AiPartyMon; recycleItem: number }

/**
 * A switch-in step that fired for a lead, by name, and the fields its rule in this port can change. `stages`: the
 * change it makes to each of the 8 stat stages (BATTLE_STAT order), as the C computes it, where the step changes
 * statBoosts and the port knows the change; overlayLead checks the engine's stages against them.
 */
export interface FiredStep { step: string; fields: readonly LeadField[]; stages?: readonly number[] }

/**
 * The steps that fired for battler `b` on `loaded`, each with the fields it changes and, for the stages, the C's change:
 * - Trace: the ability, in the BattleMon only (subscript_trace.s:7);
 * - the foe's Intimidate (battle_lib.c:3795–3813): Attack −1 (subscript_intimidate.s:15), or nothing where
 *   BtlCmd_ChangeStatStage blocks it: Clear Body, White Smoke or Hyper Cutter on the battler, which the intimidator,
 *   holding Intimidate, can't break with Mold Breaker (battle_script.c:2883–2903; Mist, a Substitute and a stage of −6
 *   can't be there at battle start);
 * - the battler's own Download (:3815–3859): Sp. Atk +1 when the foe's stage-adjusted Defense is at least its Sp. Def,
 *   else Attack +1, nothing when both are 0 (downloadStages);
 * - a status-curing ability: the status, in battle and in the party (subscript_ability_forbids_status.s:13–17, copied
 *   to the party by BtlCmd_UpdateMonData, battle_script.c:3078);
 * - the held item that acted (itemFields), with a pinch berry's +1 to its stat (subscript_held_item_raise_stat.s:7–11:
 *   QUARTER_RECOIL plus the stat is that stat's UP_1_STAGE pointer, generated/battle_move_subscript_ptrs.txt:15–16);
 *   Starf Berry's stat is drawn (battle_lib.c:5286–5289), so its stages aren't predicted.
 */
function leadSteps(loaded: AiView, b: number, abilities: readonly number[], traced: readonly boolean[], item: ItemStep): FiredStep[] {
  const steps: FiredStep[] = [];
  const change = (stat: number, by: number): number[] => Array.from({ length: 8 }, (_, i) => (i === stat ? by : 0));
  if (traced[b]) steps.push({ step: 'Trace', fields: ['ability'] });
  if (abilities[b ^ 1] === ABILITY_INTIMIDATE) {
    const blocked = [ABILITY_CLEAR_BODY, ABILITY_WHITE_SMOKE, ABILITY_HYPER_CUTTER].includes(abilities[b]!);
    steps.push({ step: 'the foe\'s Intimidate', fields: ['statBoosts'], stages: change(STAT.ATTACK, blocked ? 0 : -1) });
  }
  if (abilities[b] === ABILITY_DOWNLOAD) steps.push({ step: 'Download', fields: ['statBoosts'], stages: downloadStages(loaded.mons[b ^ 1]!) });
  if (item.cured) steps.push({ step: 'a status-curing ability', fields: ['status', 'party.status'] });
  if (item.effect !== null) {
    const stat = PINCH_STATS.get(item.effect);
    steps.push({
      step: `held item ${item.item}`, fields: itemFields(item.effect), ...(stat !== undefined && { stages: change(stat, 1) }),
    });
  }
  return steps;
}

/** BATTLE_STAT indices (constants/battle.h): HP, Attack, Defense, Speed, Sp. Atk, Sp. Def, accuracy, evasion. */
const STAT = { ATTACK: 1, DEFENSE: 2, SPEED: 3, SP_ATTACK: 4, SP_DEFENSE: 5 } as const;

/** The stat each pinch berry raises (battle_lib.c:5196–5259). */
const PINCH_STATS: ReadonlyMap<number, number> = new Map([
  [HOLD_EFFECT.PINCH_ATK_UP, STAT.ATTACK], [HOLD_EFFECT.PINCH_DEF_UP, STAT.DEFENSE], [HOLD_EFFECT.PINCH_SPEED_UP, STAT.SPEED],
  [HOLD_EFFECT.PINCH_SPATK_UP, STAT.SP_ATTACK], [HOLD_EFFECT.PINCH_SPDEF_UP, STAT.SP_DEFENSE],
]);

/**
 * Download's change (battle_lib.c:3815–3859) against `foe`, the one living foe in singles, with no Substitute at battle
 * start: sumDef and sumSpDef are its Defense and Sp. Def times sStatStageBoosts of their stages, in C integers; Sp. Atk
 * +1 when sumDef >= sumSpDef, else Attack +1, nothing when both are 0.
 */
function downloadStages(foe: AiBattleMon): number[] {
  const adjusted = (stat: number, stage: number) => {
    const [num, den] = statStageBoost(stage);
    return Math.trunc((stat * num) / den);
  };
  const sumDef = foe.curHP > 0 ? adjusted(foe.defense, foe.statBoosts[STAT.DEFENSE]!) : 0;
  const sumSpDef = foe.curHP > 0 ? adjusted(foe.spDefense, foe.statBoosts[STAT.SP_DEFENSE]!) : 0;
  const stages = Array<number>(8).fill(0);
  if (sumDef + sumSpDef !== 0) stages[sumDef >= sumSpDef ? STAT.SP_ATTACK : STAT.ATTACK] = 1;
  return stages;
}

/**
 * The fields a held item that acted changes (BattleSystem_TriggerHeldItemOnStatus, battle_lib.c:4974–5297, and its
 * subscripts). Every one is used up through BtlCmd_RemoveItem, which keeps it in recycleItem and copies the battler to
 * the party (battle_script.c:8977–8981): the item, in battle and in the party, and recycleItem. Then the effect's own:
 * HP for the HP berries (the flavoured ones may confuse: statusVolatile); the status for the curing ones (Lum Berry's
 * also clears confusion); PP for Leppa Berry (:5035–5036); the stages for White Herb and the pinch berries; Focus
 * Energy (statusVolatile) for Lansat Berry. Micle Berry sets a flag the view doesn't hold.
 */
function itemFields(effect: number): LeadField[] {
  const fields: LeadField[] = ['heldItem', 'party.heldItem', 'recycleItem'];
  if (effect === HOLD_EFFECT.HP_RESTORE || effect === HOLD_EFFECT.HP_PCT_RESTORE || FLAVOR_BERRIES.includes(effect)) fields.push('curHP', 'party.hp');
  if (FLAVOR_BERRIES.includes(effect) || effect === HOLD_EFFECT.PINCH_CRITRATE_UP || effect === HOLD_EFFECT.CONFUSE_RESTORE
    || effect === HOLD_EFFECT.STATUS_RESTORE || effect === HOLD_EFFECT.HEAL_INFATUATION) fields.push('statusVolatile');
  if (ITEM_STATUS_CURES.has(effect)) fields.push('status', 'party.status');
  if (effect === HOLD_EFFECT.PP_RESTORE) fields.push('ppCur', 'party.pp');
  if (effect === HOLD_EFFECT.STATDOWN_RESTORE || (PINCH_ITEMS.includes(effect) && effect !== HOLD_EFFECT.PINCH_CRITRATE_UP
    && effect !== HOLD_EFFECT.PINCH_ACC_UP)) fields.push('statBoosts');
  return fields;
}

function leadValue(lead: LeadFields, field: LeadField): unknown {
  if (field === 'recycleItem') return lead.recycleItem;
  if (field.startsWith('party.')) return lead.party[field.slice('party.'.length) as keyof AiPartyMon];
  return lead.mon[field as keyof AiBattleMon];
}

/**
 * The lead's fields after the switch-in steps: each LeadField from the engine, which must equal the load's unless a
 * step in `fired` changes that field (FiredStep). So with no step fired, the lead is exactly as loaded. And the stat
 * stages must be the load's plus the fired steps' changes as the C computes them (FiredStep.stages, each stage kept in
 * 0–12, battle_script.c:2870–2872, 2971–2973), unless a step that changes them has no prediction (Starf Berry). AiError
 * ('BAD_VIEW') naming the field, both values and the steps that fired otherwise. Exported for its unit test.
 */
export function overlayLead(loaded: LeadFields, engine: LeadFields, fired: readonly FiredStep[], b: number): LeadFields {
  const names = fired.map((step) => step.step).join(', ') || 'none';
  for (const field of LEAD_FIELDS) {
    const [was, now] = [JSON.stringify(leadValue(loaded, field)), JSON.stringify(leadValue(engine, field))];
    if (was === now || fired.some((step) => step.fields.includes(field))) continue;
    throw new AiError('BAD_VIEW', `battler ${b}'s ${field} is ${now} in the engine and ${was} as loaded, but no switch-in step that `
      + `changes it fired (fired: ${names})`);
  }
  const staging = fired.filter((step) => step.fields.includes('statBoosts'));
  if (staging.every((step) => step.stages !== undefined)) {
    const expected = loaded.mon.statBoosts.map((stage, i) => Math.min(12, Math.max(0, stage + staging.reduce((sum, step) => sum + step.stages![i]!, 0))));
    if (JSON.stringify(expected) !== JSON.stringify(engine.mon.statBoosts)) {
      throw new AiError('BAD_VIEW', `battler ${b}'s statBoosts are ${JSON.stringify(engine.mon.statBoosts)} in the engine, the C's `
        + `${JSON.stringify(expected)} after its steps (fired: ${names})`);
    }
  }
  const { mon, party } = engine;
  return {
    mon: {
      ...loaded.mon, statBoosts: [...mon.statBoosts], ability: mon.ability, status: mon.status, curHP: mon.curHP,
      heldItem: mon.heldItem, statusVolatile: mon.statusVolatile, ppCur: [...mon.ppCur],
    },
    party: { ...loaded.party, hp: party.hp, status: party.status, heldItem: party.heldItem, pp: [...party.pp] },
    recycleItem: engine.recycleItem,
  };
}
