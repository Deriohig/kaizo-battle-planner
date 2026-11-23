// The trainer AI adapter as it was before it was split up: src/ai/adapter.ts, unchanged but for its import paths, this
// header, and two behaviour changes made since, mirrored so the oracle still compares the new composition alone: a fainted
// AI battler's traced ability at its replacement (marked), and TryPursuit's tests on a player's
// Pursuit still queued at the AI's U-turn switch (marked). The oracle of aiViewOracle.test.ts and of
// test/unit/ai/readFaultOrder.test.ts: the view composed from the Showdown source's read must be this one-pass build's. This
// copy of the adapter is kept as the oracle.
//
// FROZEN ORACLE: do not edit the code below, not to fix it, tidy it, speed it up or follow a refactor. A change here
// changes what "unchanged" means for every check that compares against it. The one exception: a deliberate, reviewed fix
// of the AI's behaviour is mirrored into the code below and marked there (as the Trace fix is), and nothing else changes
// it. It restores its own battle (`restore`), never the AI's peek, so the AI's caches can't reach it. When something it
// imports changes:
// - moved or renamed, with the same behaviour (a file, an export, a constant's name): change the import lines only;
// - removed, or changed in what it returns or throws (the engine's accessors, `restore`, the ID tables, PATHS, the
//   constants): stop. The oracle then no longer reads as the original adapter did. Copy the import's old version beside
//   this file from the original adapter and import that, or, once the golden file of aiDifferential carries the proof alone,
//   delete this file with aiViewOracle.test.ts and readFaultOrder.test.ts. Never regenerate the oracle from the
//   current adapter.

// viewFromState: the one translation from the engine's state into the trainer AI's view. The engine's state is
// Showdown's Battle, restored from EngineState.json; the view is the cartridge's BattleContext and BattleMon in their
// own encodings (view.ts). Every field's comment names its Showdown source and the conversion, or the memory field, or
// the default it takes and why. `// GAP:` marks a value the state can't give exactly: the view lists it in `unknown`
// (lib/known.ts's PATHS), always or when the state can't settle it, so its reader throws AiError('UNDEFINED') instead
// of reading a default. Each gap has a spot-check item in
// docs/ai-spot-checks.md.
//
// Counters. A hidden counter the AI only tests for zero (docs/ai-reads.md) maps from Showdown's duration to a value
// clamped into the cartridge's bit field, at least 1 while the effect lasts. The counters the AI reads exactly are
// mapped exactly: the turn count, the turn a battler came in (Fake Out, Slow Start), Stockpile, Perish Song, Protect's
// chain, Last Resort and the hazard layers.
//
// Battler slots: 0 is the player (p1), 1 the AI (p2); singles leave slots 2 and 3 empty (EMPTY_MON). Pure: it restores
// its own copy of the battle and only reads it.

import type { LoadedData } from '../../src/battle/types.js';
import type { EngineState, FieldSpec } from '../../src/contracts/engine.js';
import { abilityId, battleField, itemId, lastSpeedValues, quickClawRolls, restore, speciesId, trainerBag } from '../../src/engine/index.js';
import { FORMS, personalRowFor } from '../../src/rom/forms.js';
import { TYPE_NAMES } from '../../src/rom/tables.js';
import type { Stats } from '../../src/rom/types.js';
import {
  ABILITY_NONE, BATTLE_TYPE_TRAINER_DOUBLES, BATTLE_TYPE_TRAINER_SINGLES, BATTLER_ENEMY_2, BATTLER_NONE,
  BATTLER_PLAYER_2, DEFAULT_STAT_STAGE, FIELD_CONDITION_DEEP_FOG, FIELD_CONDITION_HAILING_PERM, FIELD_CONDITION_HAILING_TEMP,
  FIELD_CONDITION_RAINING_PERM, FIELD_CONDITION_RAINING_TEMP, FIELD_CONDITION_SANDSTORM_PERM,
  FIELD_CONDITION_SANDSTORM_TEMP, FIELD_CONDITION_SUNNY_PERM, FIELD_CONDITION_SUNNY_TEMP, FIELD_CONDITION_WEATHER,
  ITEM_NONE, LEARNED_MOVES_MAX, MAX_TRAINER_ITEMS,
  MON_CONDITION_BURN, MON_CONDITION_FREEZE, MON_CONDITION_NONE, MON_CONDITION_PARALYSIS, MON_CONDITION_POISON,
  MON_CONDITION_SLEEP, MON_CONDITION_TOXIC, MOVE_DETECT, MOVE_EFFECT_ABILITY_SUPPRESSED, MOVE_EFFECT_AIRBORNE, MOVE_EFFECT_AQUA_RING,
  MOVE_EFFECT_CHARGE, MOVE_EFFECT_EMBARGO, MOVE_EFFECT_GRUDGE, MOVE_EFFECT_HEAL_BLOCK, MOVE_EFFECT_IMPRISON,
  MOVE_EFFECT_IMPRISONED, MOVE_EFFECT_INGRAIN, MOVE_EFFECT_LEECH_SEED, MOVE_EFFECT_MAGNET_RISE, MOVE_EFFECT_MINIMIZE,
  MOVE_EFFECT_MIRACLE_EYE, MOVE_EFFECT_MUD_SPORT, MOVE_EFFECT_PERISH_SONG, MOVE_EFFECT_POWER_TRICK,
  MOVE_EFFECT_SHADOW_FORCE, MOVE_EFFECT_UNDERGROUND, MOVE_EFFECT_UNDERWATER, MOVE_EFFECT_WATER_SPORT, MOVE_ENDURE,
  MOVE_NONE, MOVE_PROTECT, MOVE_SLEEP_TALK, SIDE_CONDITION_FUTURE_SIGHT, SIDE_CONDITION_LIGHT_SCREEN,
  SIDE_CONDITION_MIST, SIDE_CONDITION_REFLECT, SIDE_CONDITION_SAFEGUARD, SIDE_CONDITION_SPIKES, SIDE_CONDITION_STEALTH_ROCK,
  SIDE_CONDITION_TOXIC_SPIKES, SIDE_CONDITION_WISH, VOLATILE_CONDITION_CURSE, VOLATILE_CONDITION_DEFENSE_CURL,
  VOLATILE_CONDITION_DESTINY_BOND, VOLATILE_CONDITION_FLINCH, VOLATILE_CONDITION_FOCUS_ENERGY,
  VOLATILE_CONDITION_FORESIGHT, VOLATILE_CONDITION_MEAN_LOOK, VOLATILE_CONDITION_MOVE_LOCKED,
  VOLATILE_CONDITION_NIGHTMARE, VOLATILE_CONDITION_RAGE, VOLATILE_CONDITION_RECHARGING, VOLATILE_CONDITION_SUBSTITUTE,
  VOLATILE_CONDITION_TORMENT, VOLATILE_CONDITION_TRANSFORM,
} from '../../src/ai/constants.js';
import {
  BATTLE_EFFECT_HIT_BEFORE_SWITCH, BATTLE_EFFECT_SWITCH_HIT, S_MASK_EFFECTS, S_POWER_EFFECTS,
} from '../../src/ai/battleScripts.js';
import { AiError } from '../../src/ai/errors.js';
import { PATHS, REPLACEMENT_PATHS } from '../../src/ai/lib/known.js';
import type { AiMemoryData, FogFate, ProtocolIds } from '../../src/ai/memory.js';
import type { AiRomData } from '../../src/ai/rom/aiData.js';
import {
  AI_BATTLER, type AiBattleMon, type AiMoveEffectsData, type AiPartyMon, type AiSideConditions, type AiTurnFlags,
  type AiView, EMPTY_MON, PLAYER_BATTLER,
} from '../../src/ai/view.js';

type ShowdownSide = Battle['p1'];

// The bit fields' shifts and widths (include/constants/battle/condition.h, moves.h), for the counters packed in them.
const SLEEP_MAX = 7; // MON_CONDITION_SLEEP, bits 0–2
const TOXIC_COUNTER_SHIFT = 8; // MON_CONDITION_TOXIC_COUNTER, bits 8–11
const TOXIC_COUNTER_MAX = 15;
const CONFUSION_SHIFT = 0; // VOLATILE_CONDITION_CONFUSION, bits 0–2
const UPROAR_SHIFT = 4; // VOLATILE_CONDITION_UPROAR, bits 4–6
const BIDE_SHIFT = 8; // VOLATILE_CONDITION_BIDE, bits 8–9
const THRASH_SHIFT = 10; // VOLATILE_CONDITION_THRASH, bits 10–11
const BIND_SHIFT = 13; // VOLATILE_CONDITION_BIND, bits 13–15
const ATTRACT_SHIFT = 16; // VOLATILE_CONDITION_ATTRACT, one bit per battler from 16
const LOCK_ON_SHIFT = 3; // MOVE_EFFECT_LOCK_ON, bits 3–4
const YAWN_SHIFT = 11; // MOVE_EFFECT_YAWN, bits 11–12
const TAILWIND_SHIFT = 8; // SIDE_CONDITION_TAILWIND, bits 8–9
const LUCKY_CHANT_SHIFT = 12; // SIDE_CONDITION_LUCKY_CHANT, bits 12–14
const UPROAR_FIELD_SHIFT = 8; // FIELD_CONDITION_UPROAR, one bit per battler from 8
const GRAVITY_SHIFT = 12; // FIELD_CONDITION_GRAVITY, bits 12–14
const TRICK_ROOM_SHIFT = 16; // FIELD_CONDITION_TRICK_ROOM, bits 16–18
const TWO_BITS = 3;
const THREE_BITS = 7;

/** BattleContext_Init's powerMul (battle_lib.c:1980). */
const DEFAULT_POWER_MUL = 10;
/** The powerMul TryPursuit sets for a Pursuit at a switching battler (battle_script.c:6928). */
const PURSUIT_POWER_MUL = 20;
/** aiSwitchedPartySlot's "none" (BattleContext_Init, battle_lib.c:2015). */
const NO_SWITCH = 6;
/** The party slot a battler with no Pokémon left gets (battle_controller_player.c:4111, 4135). */
const NO_PARTY_SLOT = 6;
/** NUM_ITEMS, constants/items.h:84. */
const NUM_ITEMS = 467;
/** ABILITY_BAD_DREAMS, the last Gen 4 ability (generated/abilities.txt). */
const LAST_ABILITY = 123;

/**
 * The engine state `state` as the trainer AI sees it at its decision. `data` is the LoadedData the engine's mod was
 * installed from, `ai` the AI's ROM data, and `memory` what the AI remembers (rememberStep), which gives the fields
 * Showdown doesn't keep. Throws AiError('BAD_VIEW') for a value it can't encode (an unknown Showdown ID, a weather Gen 4
 * doesn't have).
 */
export function viewFromState(state: EngineState, data: LoadedData, ai: AiRomData, memory: AiMemoryData): AiView {
  const battle = restore(state);
  const player = activeOf(battle.p1);
  const enemy = activeOf(battle.p2);
  // BattleContext.totalTurns counts finished turns: 0 until the first turn ends, then +1 at each turn end
  // (battle_controller_player.c:1852). Showdown's `turn` is 1 for the first turn and rises at its end, and a mid-turn
  // or post-KO decision comes before that (Battle.endTurn runs once every switch is made). So turn − 1.
  const totalTurns = battle.turn - 1;
  const actives: [Pokemon, Pokemon] = [player, enemy];
  const outOfPokemon = [battle.p1, battle.p2].map((side) => side.pokemon.every((pokemon) => pokemon.hp === 0));
  const bag = trainerBag(battle).items;
  const speeds = lastSpeedValues(state);
  const rolls = quickClawRolls(state);
  const fog = fogOf(fieldNoteOf(state), memory);

  const view: Omit<AiView, 'unknown'> = {
    // The engine runs singles trainer battles only (createBattle throws UNSUPPORTED_DOUBLE). Showdown's gameType
    // 'singles' is BATTLE_TYPE_TRAINER_SINGLES; anything else maps to doubles, which the AI refuses (AiError).
    battleType: battle.gameType === 'singles' ? BATTLE_TYPE_TRAINER_SINGLES : BATTLE_TYPE_TRAINER_DOUBLES,
    // Each side's active Pokémon (`side.active[0]`), in battler order; slots 2 and 3 hold no Pokémon in singles.
    mons: [
      battleMonOf(battle, ai, player, memory.imprisonedMark[PLAYER_BATTLER], totalTurns),
      battleMonOf(battle, ai, enemy, memory.imprisonedMark[AI_BATTLER], totalTurns), EMPTY_MON, EMPTY_MON,
    ],
    // `side.team` is the party in its original order (the engine's party indices); each set's Pokémon is in `side.pokemon`.
    parties: [partyOf(battle, data, battle.p1), partyOf(battle, data, battle.p2)],
    // The active Pokémon's party index: its set's index in `side.team`. 6 once a side has no Pokémon left
    // (battle_controller_player.c:4111, 4135). Slots 2 and 3 are never written in singles: BattleContext_New clears the
    // context (battle_controller_player.c:182), and the battle start sets the party slots of the battlers in play only.
    selectedPartySlot: [
      outOfPokemon[0] ? NO_PARTY_SLOT : partyIndexOf(player), outOfPokemon[1] ? NO_PARTY_SLOT : partyIndexOf(enemy), 0, 0,
    ],
    // Default: BattleContext_Init sets 6 ("none") for every battler at each turn end (battle_lib.c:2015); only the
    // AI's own switch decision writes it, and Showdown keeps no pending AI switch. So 6 everywhere.
    aiSwitchedPartySlot: [NO_SWITCH, NO_SWITCH, NO_SWITCH, NO_SWITCH],
    // Showdown's `battle.turn` − 1 (see above). Exact: LoadTurnCount reads it (trainer_ai.c:934).
    totalTurns,
    // Showdown's `field`: weather, Trick Room and Gravity, and each battler's Uproar, and the note's deep fog (fieldMaskOf).
    fieldConditionsMask: fieldMaskOf(battle, actives, fog === 'standing'),
    // No AI-read bit: Showdown keeps no SYSCTL_* flags, and none of the bits the AI's helpers read (LAST_OF_MULTI_TURN,
    // IGNORE_TYPE_CHECKS, IGNORE_IMMUNITIES) is set at any decision but one. BattleContext_Init clears them (SYSCTL_INIT,
    // battle_lib.c:2009; system_control.h:31–40) at the end of every action (battle_controller_player.c:3998) and of
    // every turn (:1855), and between the last action and a turn choice or a post-KO replacement only the turn-end
    // checks run, whose scripts never set them (battleScripts.ts). The one exception is the AI's own mid-turn switch,
    // which runs inside its switching move's action: there the view lists REPLACEMENT_PATHS.statusMask when that action's
    // moves can set one (unknownOf). The bits SYSCTL_INIT keeps (Mold Breaker's, the fainted and self-destructed
    // battlers') are never read by the AI, and aiCalcDamage throws on IGNORE_TYPE_CHECKS.
    battleStatusMask: 0,
    // 10, BattleContext_Init's value (battle_lib.c:1980), exact by the same argument: every powerMul writer (the effect
    // scripts in battleScripts.ts, Revenge's CalcRevengePowerMul and Pursuit's TryPursuit, battle_script.c:6531–6533,
    // 6928) runs inside an action, whose MoveEnd resets it. At the AI's mid-turn switch it is 20 after a Pursuit at the
    // switching battler, or listed as REPLACEMENT_PATHS.powerMul when its action can have written it (replacementState,
    // which sets the returned view's value).
    powerMul: DEFAULT_POWER_MUL,
    // Each active Pokémon's volatiles (turnFlagsOf); none in the empty slots.
    turnFlags: [turnFlagsOf(player), turnFlagsOf(enemy), turnFlagsOf(null), turnFlagsOf(null)],
    // Each side's `sideConditions` and its slot's `slotConditions` (sideMaskOf).
    sideConditionsMask: [sideMaskOf(battle.p1), sideMaskOf(battle.p2)],
    // The hazards' `layers` on each side.
    sideConditions: [hazardsOf(battle.p1), hazardsOf(battle.p2)],
    // From the memory: movePrevByBattler is the cartridge's "last move that ran" (rememberStep's lastMoveBy), which
    // Showdown's `lastMove` doesn't match (a Pokémon that can't move keeps it). Slots 2 and 3: never written in singles.
    movePrevByBattler: [memory.lastMoveBy[PLAYER_BATTLER], memory.lastMoveBy[AI_BATTLER], MOVE_NONE, MOVE_NONE],
    // From the memory's lastHitBy (the AI battler's moveHit). The AI reads only its own battler's (trainer_ai.c:3656,
    // 3737), so the player's slot takes the empty value MOVE_NONE, as do slots 2 and 3.
    moveHit: [MOVE_NONE, memory.lastHitBy?.move ?? MOVE_NONE, MOVE_NONE, MOVE_NONE],
    // From the memory's lastHitBy, with BATTLER_NONE for none (battle_lib.c:2022); the other slots as moveHit.
    moveHitBattler: [BATTLER_NONE, memory.lastHitBy?.battler ?? BATTLER_NONE, BATTLER_NONE, BATTLER_NONE],
    // Each active Pokémon's last move when it is a Protect, Detect or Endure whose chain is alive (moveProtectOf).
    // GAP: listed unknown where the state can't settle the chain (protectChainKnown). Spot check 16.
    moveProtect: [moveProtectOf(battle, player), moveProtectOf(battle, enemy), MOVE_NONE, MOVE_NONE],
    // Each active Pokémon's `lastItem`, the item Recycle gives back, as a ROM item ID, unless the memory overrides it.
    // Showdown's Gen 1–4 lastItem follows the battler slot: a switch-in takes the outgoing Pokémon's and
    // clears it (sim/battle-actions.ts switchIn), as the cartridge keeps recycleItem per slot and never clears it on a
    // switch. It is set where the cartridge's BtlCmd_RemoveItem sets recycleItem (battle_script.c:8978: a consumed held
    // item, Fling, Natural Gift) and cleared by Recycle (:9005–9007). Bug Bite and Pluck also record the eaten berry in
    // the victim's slot (subscript_pluck.s:10, RemoveItem BTLSCR_DEFENDER), where Showdown's takeItem leaves lastItem
    // alone: the memory keeps that berry (rememberStep, recycleOverride), and the view takes it.
    // GAP: a Recycle or Natural Gift in such a slot leaves the memory 'unknown': listed (PATHS.recycleItem). Spot check
    // 14. Slots 2 and 3 are never written in singles: ITEM_NONE, exact.
    recycleItem: [
      recycleItemOf(memory, PLAYER_BATTLER, player), recycleItemOf(memory, AI_BATTLER, enemy), ITEM_NONE, ITEM_NONE,
    ],
    // BattleContext_InitCounters sets the bits of the two empty slots in singles (battle_lib.c:2031–2033); a side whose
    // whole party has fainted gets its battler's bit (battle_controller_player.c:4110, 4134): in Showdown, every
    // Pokémon of the side at 0 HP.
    battlersSwitchingMask: (1 << BATTLER_PLAYER_2) | (1 << BATTLER_ENEMY_2)
      | (outOfPokemon[0] ? 1 << PLAYER_BATTLER : 0) | (outOfPokemon[1] ? 1 << AI_BATTLER : 0),
    // The cartridge's monSpeedValues for battlers 0 and 1: what its latest BattleSystem_CompareBattlerSpeed wrote
    // (battle_lib.c:1372–1373), which the engine records (lastSpeedValues; at a turn choice, the turn start's sort,
    // battle_controller_player.c:251, 263). The AI's own compares while it decides (trainer_ai.c:1109, 1121, 2081) write
    // run-local copies that the interpreter carries (RunInput.monSpeedValues, the interpreter's slow path), so this is the
    // decision-start value. Slots 2 and 3 are never compared in singles: 0 (cleared, battle_controller_player.c:182).
    // GAP: the engine's compare doesn't reset a transformed battler's Slow Start turn (battle_script.c:5360), so with a
    // transformed Slow Start battler out, the values are listed unknown (PATHS.monSpeedValues). Spot check 21.
    monSpeedValues: [speeds.p1, speeds.p2, 0, 0],
    // This turn's Quick Claw draw (speedRand, battle_lib.c:1279), where the engine has picked it (quickClawRollOf):
    // the same draw, so the AI's read is exact. Where it hasn't, null: the AI marginalises it at its prior.
    quickClawThisTurn: [
      quickClawRollOf(rolls.p1, ai, player), quickClawRollOf(rolls.p2, ai, enemy), null, null,
    ],
    // AI_CONTEXT.trainerItems, a u16[MAX_TRAINER_ITEMS] in the cleared AIContext: battle start copies the trainer's
    // non-empty ROM item slots to its front, in order (battle_controller_player.c:4801–4813), so the rest stay 0. The
    // engine's bag (trainerBag) is that compacted list, with 0 for a used slot (trainer_ai.c:4191).
    trainerItems: [...bag, ...Array<number>(Math.max(0, MAX_TRAINER_ITEMS - bag.length)).fill(ITEM_NONE)],
    // AI_CONTEXT.trainerItemCounts: the compacted list's length, which battle start counts (battle_controller_player.c:4809)
    // and a use never lowers. The engine keeps the list at that length.
    trainerItemCount: bag.length,
  };
  // A used slot is 0 (battle start keeps only non-empty slots, battle_controller_player.c:4801–4813).
  const bagUsed = bag.some((item) => item === ITEM_NONE);
  // The player's battler gives TryPursuit's tests (compose.ts tryPursuitRuledOut).
  const replacing = replacementState(state.phase.kind, battle, data, memory, enemy, view.mons[PLAYER_BATTLER]);
  // At a fainted AI battler's replacement, a traced ability is the memory's (adapter.ts composeView).
  const [mon0, mon1, mon2, mon3] = view.mons;
  const mons: AiView['mons'] = replacing.ability === undefined ? view.mons : [mon0, { ...mon1, ability: replacing.ability }, mon2, mon3];
  return {
    ...view,
    mons,
    powerMul: replacing.powerMul,
    unknown: [...unknownOf(battle, ai, memory, actives, bagUsed, fog), ...replacing.gaps],
  };
}

/**
 * What a replacement reads of the turn that the state doesn't hold, from the memory: powerMul,
 * and the paths (REPLACEMENT_PATHS) the state can't give.
 * - At the AI's mid-turn switch (U-turn, Baton Pass), which runs inside its switching action before that action's
 *   MoveEnd resets battleStatusMask and powerMul (battleScripts.ts), memory.switchAction holds the action's moves:
 *   - battleStatusMask's AI-read bits are listed when one of their effects is in S_MASK_EFFECTS;
 *   - powerMul is listed when one is in S_POWER_EFFECTS, U-turn's aside. U-turn's effect writes it only through
 *     subscript_pursuit (subscript_attack_then_switch_out.s:54, before the pick at :71): when a foe that hasn't moved
 *     chose a BATTLE_EFFECT_HIT_BEFORE_SWITCH move, TryPursuit sets powerMul 20 (battle_script.c:6898–6928) and that
 *     move hits the switching battler. Showdown runs it at the same point (its `[from] Pursuit` line is in the action),
 *     so when the action shows it, powerMul is exactly 20: nothing after it in the action writes powerMul. When a player's
 *     move with that effect is still queued, Showdown didn't run it: TryPursuit's own tests on its user that rule it out
 *     make powerMul 10 and the battler's HP the state's; otherwise the cartridge may have run it, and powerMul and the
 *     battler's HP are listed (pursuitMayRun, tryPursuitRuledOut);
 *   - a step at the switch that shows no AI action, or a move with no record, lists both.
 * - At a replacement after the AI's battler fainted: the fields its BattleMon keeps through the faint that the log shows
 *   changed since its switch-in (memory.aiKept), which Showdown's faint has reset.
 * - At a turn choice, nothing: 10, and no path (see `battleStatusMask` and `powerMul` above).
 */
function replacementState(
  phase: string, battle: Battle, data: LoadedData, memory: AiMemoryData, enemy: Pokemon, player: AiBattleMon,
): { powerMul: number; gaps: string[]; ability: number | undefined } {
  const gaps: string[] = [];
  const fainted = phase === 'enemyReplacement' && enemy.hp === 0;
  if (fainted) gaps.push(...memory.aiKept);
  const ability = fainted ? memory.aiTraced : undefined;
  if (phase !== 'enemyMidTurnSwitch') return { powerMul: DEFAULT_POWER_MUL, gaps, ability };
  const action = memory.switchAction;
  const effects = (action ?? []).map((move) => data.rom.moves[move]?.effect);
  if (action === null || effects.some((effect) => effect === undefined)) {
    return { powerMul: DEFAULT_POWER_MUL, gaps: [...gaps, REPLACEMENT_PATHS.statusMask, REPLACEMENT_PATHS.powerMul], ability };
  }
  if (effects.some((effect) => S_MASK_EFFECTS.has(effect!))) gaps.push(REPLACEMENT_PATHS.statusMask);
  const otherWriter = effects.some((effect) => effect !== BATTLE_EFFECT_SWITCH_HIT && S_POWER_EFFECTS.has(effect!));
  const queued = effects.includes(BATTLE_EFFECT_SWITCH_HIT) && pursuitMayRun(battle, data, player);
  if (otherWriter || queued) gaps.push(REPLACEMENT_PATHS.powerMul);
  if (queued) gaps.push(REPLACEMENT_PATHS.field(AI_BATTLER, 'curHP'));
  const pursued = effects.includes(BATTLE_EFFECT_HIT_BEFORE_SWITCH);
  return { powerMul: pursued ? PURSUIT_POWER_MUL : DEFAULT_POWER_MUL, gaps, ability };
}

/**
 * Whether the player's side has a queued move action whose move has the hack's BATTLE_EFFECT_HIT_BEFORE_SWITCH that
 * TryPursuit's own tests don't rule out for `player`, the player's battler: compose.ts
 * pursuitMayRun, mirrored.
 */
function pursuitMayRun(battle: Battle, data: LoadedData, player: AiBattleMon): boolean {
  return battle.queue.list.some((action) => action.choice === 'move' && action.pokemon.side === battle.p1
    && data.rom.moves[action.move.num]?.effect === BATTLE_EFFECT_HIT_BEFORE_SWITCH
    && !tryPursuitRuledOut(player, action.move.num, data));
}

/**
 * As compose.ts's tryPursuitRuledOut: whether BtlCmd_TryPursuit (battle_script.c:6884–6955) doesn't
 * run `selected`, the move `mon` chose, at the AI's switching battler, by tests the view settles: fainted (bs:6901),
 * asleep or frozen (bs:6902); the move tested (bs:6905–6910) is the Encore move while it is in its slot, else `selected`,
 * so with an encoredMove other than `selected` still among the moves (no encoredMoveSlot in the view) both are tried; a
 * tested move rules out when its effect isn't BATTLE_EFFECT_HIT_BEFORE_SWITCH or its first slot has no PP (bs:6913–6916),
 * and settles nothing in no slot. Truant's loafing (bs:6903) reads moveEffectsData.truant, which the view lacks: it never
 * rules out.
 */
function tryPursuitRuledOut(mon: AiBattleMon, selected: number, data: LoadedData): boolean {
  if (mon.curHP === 0 || (mon.status & (MON_CONDITION_SLEEP | MON_CONDITION_FREEZE)) !== 0) return true;
  const moves = mon.moves.slice(0, LEARNED_MOVES_MAX);
  const encored = mon.effects.encoredMove;
  const tested = encored !== MOVE_NONE && encored !== selected && moves.includes(encored) ? [encored, selected] : [selected];
  return tested.every((move) => {
    const effect = data.rom.moves[move]?.effect;
    if (effect === undefined) return false;
    if (effect !== BATTLE_EFFECT_HIT_BEFORE_SWITCH) return true;
    const slot = moves.indexOf(move);
    return slot >= 0 && mon.ppCur[slot] === 0;
  });
}

/**
 * ProtocolIds over `state`'s battle (rememberStep): the ROM IDs of the names its log lines use, from the installed mod's
 * entries and the engine's own ID maps (romMove, romAbility, romItem). A name the battle's dex doesn't know throws
 * AiError('BAD_VIEW'), never a guessed ID.
 */
export function protocolIds(state: EngineState): ProtocolIds {
  const dex = restore(state).dex;
  const known = <T extends { exists: boolean; id: string }>(entry: T, kind: string, name: string): string => {
    if (!entry.exists) throw new AiError('BAD_VIEW', `the battle knows no ${kind} "${name}"`);
    return entry.id;
  };
  return {
    move: (name) => {
      const move = dex.moves.get(name);
      if (!move.exists || !(move.num > 0)) throw new AiError('BAD_VIEW', `the battle knows no move "${name}"`);
      return move.num;
    },
    ability: (name) => romAbility(known(dex.abilities.get(name), 'ability', name)),
    item: (name) => romItem(known(dex.items.get(name), 'item', name)),
  };
}

/** recycleItem for `battler`: the memory's override, else the active Pokémon's `lastItem` as a ROM item ID. */
function recycleItemOf(memory: AiMemoryData, battler: number, pokemon: Pokemon): number {
  const override = memory.recycleOverride[battler];
  return typeof override === 'number' ? override : romItem(pokemon.lastItem);
}

/**
 * `roll`, one side's entry of the engine's quickClawRolls(state): its Quick Claw roll of the battler's current
 * speedRand, which the engine picks the first time a compare reads it and drops at the redraw (bcp:853–858, engine
 * sortQueue). At a turn choice that is the draw this turn's order and the AI's compares read. A side with no stored roll
 * (absent: usually so at a turn boundary) gives null, which the AI marginalises. The engine's roll is `speedRand % 5 == 0`, Quick Claw's param 20; the AI reads `speedRand % (100 / param)`
 * with the held item's own param (battle_lib.c:1279, 1345). They are the same draw only when `100 / param` is 5 in C
 * integers, so for any other item the roll isn't read (null). The AI reads it only for a
 * HOLD_EFFECT_SOMETIMES_PRIORITY holder, which the engine's Quick Claw is.
 */
function quickClawRollOf(roll: boolean | undefined, ai: AiRomData, pokemon: Pokemon): boolean | null {
  if (roll === undefined) return null;
  const param = ai.items[romItem(pokemon.item)]?.holdParam ?? 0;
  return param !== 0 && Math.trunc(100 / param) === 5 ? roll : null;
}

/**
 * The view paths `viewFromState` can't derive from the state (AiView.unknown), in this order:
 * - recycleItem, for a battler whose slot the memory can't settle (a Recycle or Natural Gift after a Bug Bite or Pluck
 *   ate its berry; see `recycleItem` above; spot check 14);
 * - moveProtect and protectSuccessTurns, for a battler whose chain the state can't settle (protectChainKnown; spot
 *   check 16);
 * - slowStartTurnNumber and the IVs, for a transformed battler: Transform copies the target's IVs (battle_script.c:
 *   5346–5348, BattleMon up to `ability`) and resets the turn number (:5360), and Showdown records neither the target's
 *   IVs nor when it transformed (spot checks 17 and 19);
 * - the weight, where the Pokédex tables differ and the form can't be read (weightOf; spot check 18);
 * - deep fog, when the trainer's field note says fog and a Defog since may have blown it away (memory.ts `fog`; spot check 20);
 * - monSpeedValues, while a transformed Slow Start battler is out (see `monSpeedValues` above; spot check 21);
 * - the player's known moves, when the memory couldn't settle a turn's record (memory.ts playerMovesUnknown).
 * Friendship is exact since the engine sets happiness from BattleMon.friendship (spot check 22), and the foe's
 * MOVE_EFFECT_IMPRISONED since the memory derives it from the log (moveEffectsMaskOf; spot check 15), so neither is
 * listed. Slots 2 and 3 are EMPTY_MON, which the cartridge never writes in singles: exact.
 */
function unknownOf(
  battle: Battle, ai: AiRomData, memory: AiMemoryData, actives: readonly [Pokemon, Pokemon], bagUsed: boolean, fog: FogFate,
): string[] {
  const unknown: string[] = [];
  actives.forEach((_, battler) => {
    if (memory.recycleOverride[battler] === 'unknown') unknown.push(PATHS.recycleItem(battler));
  });
  actives.forEach((pokemon, battler) => {
    // Only the trainer uses bag items in the engine (applyChoices refuses a p1 item).
    if (!protectChainKnown(battle, pokemon, battler === AI_BATTLER && bagUsed)) {
      unknown.push(PATHS.moveProtect(battler), PATHS.protectSuccessTurns(battler));
    }
  });
  actives.forEach((pokemon, battler) => {
    if (pokemon.transformed) unknown.push(PATHS.slowStartTurnNumber(battler), PATHS.ivs(battler));
  });
  actives.forEach((pokemon, battler) => {
    if (!weightOf(battle, ai, pokemon).known) unknown.push(PATHS.weight(battler));
  });
  if (fog === 'unknown') unknown.push(PATHS.fog);
  if (actives.some((pokemon) => pokemon.transformed && pokemon.ability === 'slowstart')) unknown.push(PATHS.monSpeedValues);
  if (memory.playerMovesUnknown) unknown.push(PATHS.knownMoves(PLAYER_BATTLER));
  return unknown;
}

/**
 * The trainer's field note as the engine keeps it (BattleInput.field, an empty object for none), through the engine's
 * `battleField(state)`. The engine applies the weather, Trick Room and Gravity itself, so the view's mask shows them
 * (fieldMaskOf); the note is read for the deep fog, which Showdown has no weather for (fogOf), and for the weather the
 * memory starts from (model.ts battleStartMemory). createBattle always records it, so a state without the record (one
 * createBattle didn't make) can't say whether the cartridge has a field weather, Trick Room, Gravity or fog:
 * AiError('BAD_VIEW'), never read as no note.
 */
export function fieldNoteOf(state: EngineState): FieldSpec {
  try {
    return battleField(state);
  } catch (error) {
    throw new AiError('BAD_VIEW', `the state has no field-note record: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The deep fog's fate in `state`: the note's fog stands, or is gone, or is unknown (memory.ts `fog`); a note without fog
 * has none, 'cleared'.
 */
function fogOf(note: FieldSpec, memory: AiMemoryData): FogFate {
  return note.fog === true ? memory.fog : 'cleared';
}

/** `side.active[0]`. AiError('BAD_VIEW') when the side has none. */
function activeOf(side: ShowdownSide): Pokemon {
  const pokemon = side.active[0];
  if (pokemon === undefined || pokemon === null) throw new AiError('BAD_VIEW', `${side.id} has no active Pokémon`);
  return pokemon;
}

/** The engine's party index of `pokemon`: its set's index in `side.team` (engine/battle.ts). */
function partyIndexOf(pokemon: Pokemon): number {
  const index = pokemon.side.team.indexOf(pokemon.set);
  if (index < 0) throw new AiError('BAD_VIEW', `${pokemon.name} has no set in its side's team`);
  return index;
}

/** The battler slot of a Showdown side or slot ("p1", "p2a"): 0 for the player, 1 for the AI. */
function battlerOfSide(id: string): number {
  if (id.startsWith('p1')) return PLAYER_BATTLER;
  if (id.startsWith('p2')) return AI_BATTLER;
  throw new AiError('BAD_VIEW', `"${id}" is no side of a singles battle`);
}

/** A whole number from an effect state's field, or NaN. */
function wholeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
}

/**
 * A hidden counter the AI only tests for zero: Showdown's turns left, clamped into a field of at most `max`, and at
 * least 1 while the effect lasts (a missing duration counts as 1).
 */
function activeCounter(value: unknown, max: number): number {
  const turns = wholeNumber(value);
  return Number.isNaN(turns) ? 1 : Math.min(max, Math.max(1, turns));
}

// ROM IDs of Showdown IDs. Species and moves carry theirs as `num`; abilities and items are the inverse of the
// engine's own encoding (engine/ids.ts), built once.

/**
 * The ROM ID of Showdown move `id`: its mod entry's `num`. The engine's mod gives every hack move its ROM ID there
 * (showdownMoveData, engine/dex.ts); Showdown's own Gen 4 moves, such as Struggle, keep their number, which is the
 * vanilla ID. '' is MOVE_NONE.
 */
function romMove(battle: Battle, id: string): number {
  if (id === '') return MOVE_NONE;
  const move = battle.dex.moves.get(id);
  if (!move.exists || !(move.num > 0)) throw new AiError('BAD_VIEW', `Showdown move "${id}" has no ROM ID`);
  return move.num;
}

let reverseIds: { abilities: Map<string, number>; items: Map<string, number> } | null = null;

/** Showdown ability and item IDs → ROM IDs: the inverse of abilityId and itemId over every ROM ID (the lowest wins). */
function romIds(): { abilities: Map<string, number>; items: Map<string, number> } {
  if (reverseIds === null) {
    const abilities = new Map<string, number>([['noability', ABILITY_NONE]]); // Showdown's "No Ability"
    for (let id = LAST_ABILITY; id >= 1; id--) abilities.set(abilityId(id), id);
    const items = new Map<string, number>();
    for (let id = NUM_ITEMS; id >= 1; id--) items.set(itemId(id), id);
    reverseIds = { abilities, items };
  }
  return reverseIds;
}

/** The ROM ID of Showdown ability `id`; '' is ABILITY_NONE. */
function romAbility(id: string): number {
  if (id === '') return ABILITY_NONE;
  const ability = romIds().abilities.get(id);
  if (ability === undefined) throw new AiError('BAD_VIEW', `Showdown ability "${id}" has no ROM ID`);
  return ability;
}

/** The ROM ID of Showdown item `id`; '' is ITEM_NONE. */
function romItem(id: string): number {
  if (id === '') return ITEM_NONE;
  const item = romIds().items.get(id);
  if (item === undefined) throw new AiError('BAD_VIEW', `Showdown item "${id}" has no ROM ID`);
  return item;
}

/** The ROM ID of Showdown type `name` (rom/tables.ts's TYPE_NAMES; "???" is TYPE_MYSTERY). */
function romType(name: string): number {
  const type = TYPE_NAMES.indexOf(name);
  if (type < 0) throw new AiError('BAD_VIEW', `Showdown type "${name}" has no ROM ID`);
  return type;
}

/** type1 and type2 of Showdown `types`: a single type fills both, as the Personal data does. */
function romTypes(types: readonly string[]): [number, number] {
  const [first, second] = types;
  if (first === undefined) throw new AiError('BAD_VIEW', 'a Pokémon with no type');
  return [romType(first), romType(second ?? first)];
}

/**
 * The form number of `species` whose Showdown ID is `id` (the inverse of engine/ids.ts's speciesId over `FORMS`), or
 * `fallback`. A species `FORMS` doesn't list has form 0 (Arceus's plates are not Personal forms).
 */
function formOf(species: number, id: string, fallback: number): number {
  const forms = FORMS[species];
  if (forms === undefined) return 0;
  const form = forms.findIndex((_, f) => speciesId(species, f) === id);
  return form >= 0 ? form : fallback;
}

/** The form of `pokemon`'s set: the party data's form, as the engine encoded it (sets.ts). */
function setFormOf(battle: Battle, pokemon: Pokemon): number {
  const species = battle.dex.species.get(pokemon.set.species);
  return formOf(species.num, species.id, 0);
}

/** GENDER_MALE 0, GENDER_FEMALE 1, GENDER_NONE 2 (generated/genders.txt) from Showdown's 'M', 'F' or 'N'. */
function genderOf(pokemon: Pokemon): number {
  if (pokemon.gender === 'M') return 0;
  return pokemon.gender === 'F' ? 1 : 2;
}

/** The six IVs of `pokemon`'s set, in the Stats order. */
function ivsOf(pokemon: Pokemon): Stats {
  const { hp, atk, def, spa, spd, spe } = pokemon.set.ivs;
  return { hp, atk, def, spa, spd, spe };
}

/** Four move IDs, PP and maximum PP from Showdown move slots; an empty slot is move 0 with 0 PP. */
function movesOf(battle: Battle, slots: readonly Pokemon['moveSlots'][number][]): { moves: number[]; pp: number[]; ppMax: number[] } {
  const moves: number[] = [];
  const pp: number[] = [];
  const ppMax: number[] = [];
  for (let i = 0; i < LEARNED_MOVES_MAX; i++) {
    const slot = slots[i];
    moves.push(slot === undefined ? MOVE_NONE : romMove(battle, slot.id));
    pp.push(slot?.pp ?? 0);
    ppMax.push(slot?.maxpp ?? 0);
  }
  return { moves, pp, ppMax };
}

/**
 * BattleMon.status (MON_CONDITION_*) from Showdown's `status`. Sleep's counter is `statusState.time`, the attempts
 * left: Showdown's Gen 4 sleep lowers it before each attempt and wakes at 0 as the cartridge does with its counter
 * (engine/sets.ts), so it is the same number (non-zero while asleep). Toxic's counter is `statusState.stage`, which
 * rises at each turn end before the damage as the cartridge's does: exact, 0–15. 'fnt' has no cartridge bit: every
 * read of a party member's status skips a fainted one (trainer_ai.c:1371, 1404), and the party copy of a fainted
 * battler is sent with status 0 (battle_controller.c:1482–1486). `status` defaults to the Pokémon's own.
 */
function statusOf(pokemon: Pokemon, status: string = pokemon.status): number {
  switch (status) {
    case '':
    case 'fnt':
      return MON_CONDITION_NONE;
    case 'slp':
      return activeCounter(pokemon.statusState['time'], SLEEP_MAX);
    case 'psn':
      return MON_CONDITION_POISON;
    case 'brn':
      return MON_CONDITION_BURN;
    case 'frz':
      return MON_CONDITION_FREEZE;
    case 'par':
      return MON_CONDITION_PARALYSIS;
    case 'tox': {
      const stage = wholeNumber(pokemon.statusState['stage']);
      const counter = Number.isNaN(stage) ? 0 : Math.min(TOXIC_COUNTER_MAX, Math.max(0, stage));
      return MON_CONDITION_TOXIC | (counter << TOXIC_COUNTER_SHIFT);
    }
    default:
      throw new AiError('BAD_VIEW', `Showdown status "${status}" has no cartridge encoding`);
  }
}

/**
 * BattleMon.status of a battler slot. A fainted battler's BattleMon keeps the status it fainted with: nothing in the
 * faint clears it (BattleSystem_CleanupFaintedMon, battle_lib.c:2156–2210, leaves `status`; only the party copy is sent
 * as 0, battle_controller.c:1482–1486), and BattleAI_PostKOSwitchIn's damage estimate reads it (Guts and the burn halving,
 * battle_lib.c:6651, 6793, 6978). Showdown marks a fainted active Pokémon's status 'fnt' (Battle.checkFainted) without
 * touching `statusState`, whose `id` setStatus always sets (initEffectState({ id })), so the status it fainted with is
 * `statusState.id`: none when absent or ''.
 */
function battleStatusOf(pokemon: Pokemon): number {
  if (pokemon.status !== 'fnt') return statusOf(pokemon);
  const id = pokemon.statusState['id'];
  return statusOf(pokemon, typeof id === 'string' ? id : '');
}

/**
 * BattleMon.statusVolatile (VOLATILE_CONDITION_*) from `pokemon`'s volatiles. Counters are non-zero while active
 * (confusion's `time`; Uproar's, Bide's and Bind's `duration`; Thrash's `trueDuration`).
 */
function statusVolatileOf(pokemon: Pokemon): number {
  const v = pokemon.volatiles;
  let mask = 0;
  if (v['confusion']) mask |= activeCounter(v['confusion']['time'], THREE_BITS) << CONFUSION_SHIFT;
  if (v['flinch']) mask |= VOLATILE_CONDITION_FLINCH;
  if (v['uproar']) mask |= activeCounter(v['uproar'].duration, THREE_BITS) << UPROAR_SHIFT;
  if (v['bide']) mask |= activeCounter(v['bide'].duration, TWO_BITS) << BIDE_SHIFT;
  if (v['lockedmove']) mask |= activeCounter(v['lockedmove']['trueDuration'], TWO_BITS) << THRASH_SHIFT; // Thrash, Outrage, Petal Dance
  // Battler_LockMoveChoice (battle_lib.c:1828): a charge turn (subscript_vanish_on_charge_turn.s), Bide
  // (subscript_bide_start.s) and Rollout or Ice Ball (battle_script.c:5668). Showdown: 'twoturnmove', 'bide', 'rollout',
  // 'iceball'.
  if (v['twoturnmove'] || v['bide'] || v['rollout'] || v['iceball']) mask |= VOLATILE_CONDITION_MOVE_LOCKED;
  if (v['partiallytrapped']) mask |= activeCounter(v['partiallytrapped'].duration, THREE_BITS) << BIND_SHIFT;
  // Attract's bit is the battler it is attracted to: the volatile's `source`.
  const attractedTo = v['attract']?.['source'] as Pokemon | undefined;
  if (attractedTo) mask |= 1 << (ATTRACT_SHIFT + battlerOfSide(attractedTo.side.id));
  if (v['focusenergy']) mask |= VOLATILE_CONDITION_FOCUS_ENERGY;
  if (pokemon.transformed) mask |= VOLATILE_CONDITION_TRANSFORM;
  if (v['mustrecharge']) mask |= VOLATILE_CONDITION_RECHARGING;
  if (v['rage']) mask |= VOLATILE_CONDITION_RAGE;
  if (v['substitute']) mask |= VOLATILE_CONDITION_SUBSTITUTE;
  if (v['destinybond']) mask |= VOLATILE_CONDITION_DESTINY_BOND;
  if (v['trapped']) mask |= VOLATILE_CONDITION_MEAN_LOOK; // Mean Look, Block, Spider Web
  if (v['nightmare']) mask |= VOLATILE_CONDITION_NIGHTMARE;
  if (v['curse']) mask |= VOLATILE_CONDITION_CURSE;
  if (v['foresight']) mask |= VOLATILE_CONDITION_FORESIGHT; // Foresight and Odor Sleuth
  if (v['defensecurl']) mask |= VOLATILE_CONDITION_DEFENSE_CURL;
  if (v['torment']) mask |= VOLATILE_CONDITION_TORMENT;
  return mask;
}

/**
 * BattleMon.moveEffectsMask (MOVE_EFFECT_*) from `pokemon`'s volatiles, and MOVE_EFFECT_IMPRISONED when `imprisoned`
 * (the memory's imprisonedMark for its battler). MOVE_EFFECT_NO_CRITICAL and MOVE_EFFECT_CAMOUFLAGE stay clear: nothing
 * in the cartridge sets them (moves.h:23, "checked for, but never set"; Camouflage's bit has no writer in src/).
 */
function moveEffectsMaskOf(pokemon: Pokemon, imprisoned: boolean): number {
  const v = pokemon.volatiles;
  let mask = 0;
  // Leech Seed: the seeded Pokémon, with the battler that takes the HP in bits 0–1 (the volatile's `sourceSlot`).
  if (v['leechseed']) mask |= MOVE_EFFECT_LEECH_SEED | battlerOfSide(String(v['leechseed']['sourceSlot'] ?? ''));
  // Lock-On and Mind Reader: Showdown's 'lockon' on the user, as the cartridge's flag and counter are.
  if (v['lockon']) mask |= activeCounter(v['lockon'].duration, TWO_BITS) << LOCK_ON_SHIFT;
  if (v['perishsong']) mask |= MOVE_EFFECT_PERISH_SONG;
  if (v['fly'] || v['bounce']) mask |= MOVE_EFFECT_AIRBORNE; // the charge turn's volatile ('twoturnmove' adds it)
  if (v['dig']) mask |= MOVE_EFFECT_UNDERGROUND;
  if (v['dive']) mask |= MOVE_EFFECT_UNDERWATER;
  if (v['shadowforce']) mask |= MOVE_EFFECT_SHADOW_FORCE;
  if (v['minimize']) mask |= MOVE_EFFECT_MINIMIZE;
  if (v['charge']) mask |= MOVE_EFFECT_CHARGE;
  if (v['ingrain']) mask |= MOVE_EFFECT_INGRAIN;
  if (v['yawn']) mask |= activeCounter(v['yawn'].duration, TWO_BITS) << YAWN_SHIFT;
  if (v['imprison']) mask |= MOVE_EFFECT_IMPRISON;
  if (v['grudge']) mask |= MOVE_EFFECT_GRUDGE;
  if (v['mudsport']) mask |= MOVE_EFFECT_MUD_SPORT; // Gen 4's Mud and Water Sport are volatiles on the user
  if (v['watersport']) mask |= MOVE_EFFECT_WATER_SPORT;
  if (v['gastroacid']) mask |= MOVE_EFFECT_ABILITY_SUPPRESSED;
  if (v['miracleeye']) mask |= MOVE_EFFECT_MIRACLE_EYE;
  if (v['powertrick']) mask |= MOVE_EFFECT_POWER_TRICK;
  if (v['aquaring']) mask |= MOVE_EFFECT_AQUA_RING;
  if (v['healblock']) mask |= MOVE_EFFECT_HEAL_BLOCK;
  if (v['embargo']) mask |= MOVE_EFFECT_EMBARGO;
  if (v['magnetrise']) mask |= MOVE_EFFECT_MAGNET_RISE;
  // Imprison marks its user's foe whether or not it works (battle_script.c:6686–6690), and only the marked battler's
  // own switch-in or faint clears it (battle_lib.c:2071, 2076, 2166); Showdown keeps only the user's 'imprison'. So the
  // bit is the memory's (rememberStep's imprisonedMark), exact from the log; nothing is listed, as no case is left
  // that the log can't settle (spot check 15). The user's own MOVE_EFFECT_IMPRISON above, which Move_Imprisoned reads
  // with its moves (battle_lib.c:3316–3336), is Showdown's: both set it on a working Imprison and drop it at the
  // switch-out (Showdown's 'imprison' is noCopy).
  if (imprisoned) mask |= MOVE_EFFECT_IMPRISONED;
  return mask;
}

/**
 * The turn `pokemon` came in, as fakeOutTurnNumber and slowStartTurnNumber hold it: totalTurns + 1 at the switch-in
 * (battle_lib.c:2117–2118), so Showdown's turn then. Showdown counts `activeTurns` from 0 at the switch-in
 * (battle-actions.ts switchIn) up by one at each turn end it is in play for (Battle.endTurn), so that turn is
 * `turn − activeTurns`. A lead was never switched in on the cartridge and keeps the cleared 0: Showdown's leads come in
 * at turn 0 and end it, which gives the same 0. A fainted battler gets totalTurns + 1 (battle_lib.c:2195–2196).
 */
function switchInTurnOf(battle: Battle, pokemon: Pokemon, totalTurns: number): number {
  if (pokemon.hp === 0) return totalTurns + 1;
  return battle.turn - pokemon.activeTurns;
}

/**
 * Protect's chain (protectSuccessTurns, 0–3) from Showdown's Gen 4 'stall' volatile: its `counter` is 2 after one
 * success and doubles with each more, up to 8 (data/mods/gen4/conditions.ts `stall`, counterMax 8), as the
 * cartridge's success rate halves with each step of its chain (sProtectSuccessRate, battle_script.c:5167–5186). So the
 * chain is log2(counter). The volatile goes on a failure, as the chain resets (battle_script.c:5186), and a turn later
 * if the next move isn't a protecting one, when moveProtect stops naming one and LoadProtectChain reads 0
 * (trainer_ai.c:2545). Exact for that read, the only one.
 */
function protectChainOf(pokemon: Pokemon): number {
  const stall = pokemon.volatiles['stall'];
  if (!stall) return 0;
  const counter = wholeNumber(stall['counter']);
  if (Number.isNaN(counter) || counter < 2) return 0;
  return Math.min(3, Math.floor(Math.log2(counter)));
}

const PROTECT_MOVES: ReadonlySet<number> = new Set([MOVE_PROTECT, MOVE_DETECT, MOVE_ENDURE]);

/** Showdown's `lastMove` of `pokemon` as a ROM ID: its last move since the switch-in, MOVE_NONE for none. */
function lastMoveOf(battle: Battle, pokemon: Pokemon): number {
  return pokemon.lastMove === null ? MOVE_NONE : romMove(battle, pokemon.lastMove.id);
}

/**
 * moveProtect: the move the battler last showed the "used" message for (battle_controller_player.c:3938). The AI reads
 * it only to ask whether it is Protect, Detect or Endure (trainer_ai.c:2545), and only then reads the chain; so it is
 * Showdown's `lastMove` while that is one of the three and its 'stall' chain is alive, else MOVE_NONE. A failed
 * protecting move leaves the cartridge's chain at 0 (battle_script.c:5186), which reads the same as MOVE_NONE.
 * Exact where protectChainKnown holds.
 */
function moveProtectOf(battle: Battle, pokemon: Pokemon): number {
  if (!pokemon.volatiles['stall']) return MOVE_NONE;
  const move = lastMoveOf(battle, pokemon);
  return PROTECT_MOVES.has(move) ? move : MOVE_NONE;
}

/**
 * Whether moveProtectOf and protectChainOf give the cartridge's moveProtect and protectSuccessTurns, as
 * LoadProtectChain reads them. The cartridge writes moveProtect each time the battler runs a move: the move whose
 * "used" message showed (moveCur), else MOVE_NONE, as after a turn it couldn't move (UpdateMoveBuffers,
 * battle_controller_player.c:3936–3942). TryProtect keeps the chain only while moveProtect names Protect, Detect or
 * Endure (battle_script.c:5154–5158). A switch-in clears both (battle_lib.c:2104–2120), as Showdown's switch clears
 * 'stall' and `lastMove`, so a switch turn leaves no gap. Two things do:
 * - A bag item (`aiUsedItem`: the AI's bag has a used slot; the player uses none in the engine): the item turn runs no
 *   move, so the cartridge keeps moveProtect and the chain through it, and a protecting move after it continues the
 *   chain, while Showdown's 'stall' ends at the item turn's end. The state doesn't say when the item was used, so
 *   while the battler's last move protects, or is Sleep Talk, which may have called a protecting move, the chain is
 *   ambiguous.
 * - A protecting move called by Sleep Talk, the one caller that can call one (BtlCmd_TrySleepTalk, battle_script.c:
 *   4907–4934, has no Protect check; Metronome, Assist and Copycat refuse all three, sCannotMetronomeMoves at
 *   battle_lib.c:7152–7179; Mirror Move and Me First copy only other moves): moveProtect is the called move, but
 *   Showdown's `lastMove` is the caller, so a live 'stall' with a last move that doesn't protect is ambiguous.
 */
function protectChainKnown(battle: Battle, pokemon: Pokemon, aiUsedItem: boolean): boolean {
  const stall = pokemon.volatiles['stall'] !== undefined;
  if (!stall && !aiUsedItem) return true; // no chain alive, and no item turn could have kept one: both read 0
  const last = lastMoveOf(battle, pokemon);
  const protecting = PROTECT_MOVES.has(last);
  if (stall && !protecting) return false;
  return !(aiUsedItem && (protecting || last === MOVE_SLEEP_TALK));
}

/** BattleMon.moveEffectsData's fields the AI reads, from `pokemon`'s volatiles and move slots. */
function effectsOf(battle: Battle, pokemon: Pokemon, totalTurns: number): AiMoveEffectsData {
  const v = pokemon.volatiles;
  const switchInTurn = switchInTurnOf(battle, pokemon, totalTurns);
  const perishSong = wholeNumber(v['perishsong']?.duration);
  const stockpile = wholeNumber(v['stockpile']?.['layers']);
  return {
    // 'disable': the move in its `move`, as a ROM ID; its duration as the 3-bit counter (non-zero only).
    disabledMove: v['disable'] ? romMove(battle, String(v['disable']['move'] ?? '')) : MOVE_NONE,
    disabledTurns: v['disable'] ? activeCounter(v['disable'].duration, THREE_BITS) : 0,
    // 'encore': the same.
    encoredMove: v['encore'] ? romMove(battle, String(v['encore']['move'] ?? '')) : MOVE_NONE,
    encoredTurns: v['encore'] ? activeCounter(v['encore'].duration, THREE_BITS) : 0,
    // 'taunt' and 'embargo': their durations (non-zero only).
    tauntedTurns: v['taunt'] ? activeCounter(v['taunt'].duration, THREE_BITS) : 0,
    embargoTurns: v['embargo'] ? activeCounter(v['embargo'].duration, THREE_BITS) : 0,
    // Exact (trainer_ai.c:3266). The cartridge sets 3 (battle_script.c:5478) and, at each turn end, faints the battler
    // at 0 or else lowers it (battle_controller_player.c:1801–1809). Showdown's 'perishsong' starts at duration 4 and
    // loses 1 at each turn end, ending at 0: one more than the cartridge's count at every decision. So duration − 1.
    perishSongTurns: v['perishsong'] && !Number.isNaN(perishSong) ? Math.min(TWO_BITS, Math.max(0, perishSong - 1)) : 0,
    // Exact (trainer_ai.c:2501): 'stockpile''s `layers`, 1–3.
    stockpileCount: v['stockpile'] && !Number.isNaN(stockpile) ? Math.min(TWO_BITS, Math.max(0, stockpile)) : 0,
    // Exact for LoadProtectChain where protectChainKnown holds: 'stall''s `counter` (protectChainOf). GAP: listed
    // unknown otherwise. Spot check 16.
    protectSuccessTurns: protectChainOf(pokemon),
    // Exact (trainer_ai.c:2103, 2487, 4156): the turn the battler came in (switchInTurnOf).
    fakeOutTurnNumber: switchInTurn,
    // Exact (battle_lib.c:1264): the same turn. GAP: Transform also sets it to totalTurns + 1 (battle_script.c:5360),
    // which Showdown doesn't record, so it is listed unknown while the battler is transformed; only Slow Start reads
    // it. Spot check 17.
    slowStartTurnNumber: switchInTurn,
    // Exact (trainer_ai.c:2039): the distinct moves used since the switch-in, Last Resort itself left out
    // (BattleSystem_UpdateLastResort, battle_lib.c:3444–3458): the move slots Showdown marks `used`, up to 4.
    lastResortCount: Math.min(4, pokemon.moveSlots.filter((slot) => slot.used && slot.id !== 'lastresort').length),
    // 'flashfire', which Flash Fire's absorb adds.
    flashFire: v['flashfire'] !== undefined,
    // The speed check reads it only for an Unburden holder with no item (battle_lib.c:1268–1272), where it means the
    // Pokémon held an item when its ability was checked (battle_lib.c:4433–4436) and has lost it: Showdown's 'unburden',
    // which Gen 4 Unburden adds when the item goes.
    canUnburden: v['unburden'] !== undefined,
    // 'healblock' and 'magnetrise': their durations (non-zero only).
    healBlockTurns: v['healblock'] ? activeCounter(v['healblock'].duration, THREE_BITS) : 0,
    magnetRiseTurns: v['magnetrise'] ? activeCounter(v['magnetrise'].duration, THREE_BITS) : 0,
    // 'choicelock''s `move`, as a ROM ID: Showdown keeps it while the Choice item is held, as the cartridge keeps
    // choiceLockedMove (battle_controller_player.c:3929, 3932).
    choiceLockedMove: v['choicelock'] ? romMove(battle, String(v['choicelock']['move'] ?? '')) : MOVE_NONE,
  };
}

/**
 * BattleMon.weight: the Pokédex weight BattleSystem_InitBattleMon loads for the species, from the table
 * Pokedex_SetupGiratina picks by the battler's form (battle_lib.c:145–150; src/rom/weights.ts): `ai.weights` for form 0,
 * `ai.formWeights` for any other. Untransformed, the species and form are the set's: the party data the BattleMon was
 * built from, which a battle form change (Castform's weather forms) doesn't reload. Transform copies the target's
 * weight (battle_script.c:5346–5348, BattleMon up to `ability`), and a transformed Pokémon's Showdown species is its
 * target's. `known` is false (GAP, spot check 18) when the two tables differ for the species and the form can't be
 * read: a species FORMS doesn't list, or a transformed battler, whose target's own form at its switch-in the state
 * doesn't keep. In both ROMs the tables differ only for Giratina, whose form FORMS lists.
 */
function weightOf(battle: Battle, ai: AiRomData, pokemon: Pokemon): { weight: number; known: boolean } {
  const species = pokemon.transformed ? pokemon.species : battle.dex.species.get(pokemon.set.species);
  const form = formOf(species.num, species.id, 0);
  const weight = (form === 0 ? ai.weights : ai.formWeights)[species.num];
  if (weight === undefined) throw new AiError('BAD_VIEW', `the ROM's Pokédex has no weight for species ${species.num}`);
  const formless = ai.weights[species.num] === ai.formWeights[species.num];
  return { weight, known: formless || (FORMS[species.num] !== undefined && !pokemon.transformed) };
}

/** One battler slot from an active Showdown Pokémon (`imprisoned`: the memory's Imprison mark for its battler). */
function battleMonOf(battle: Battle, ai: AiRomData, pokemon: Pokemon, imprisoned: boolean, totalTurns: number): AiBattleMon {
  const { moves, pp, ppMax } = movesOf(battle, pokemon.moveSlots);
  const boosts = pokemon.boosts;
  return {
    // `species.num`, the National Dex number, which is the ROM's species ID; a transformed Pokémon's is its target's,
    // as Transform copies the BattleMon up to its ability (battle_script.c:5346–5348).
    species: pokemon.species.num,
    // The form of `species.id` (Castform's weather forms included), else the set's.
    form: formOf(pokemon.species.num, pokemon.species.id, setFormOf(battle, pokemon)),
    level: pokemon.level,
    // 'M', 'F' or 'N' as GENDER_*.
    gender: genderOf(pokemon),
    // `types`, the stored types (Transform, Conversion and Forecast change them, as on the cartridge), as ROM type IDs.
    // Roost's loss of Flying is a Type event, not stored, as the cartridge keeps it in turnFlags.roosting.
    types: romTypes(pokemon.types),
    // `ability`, the current one (Trace, Skill Swap, Transform), as a ROM ID. Gastro Acid keeps it, as the cartridge
    // does, and sets MOVE_EFFECT_ABILITY_SUPPRESSED.
    ability: romAbility(pokemon.ability),
    // `item`, as a ROM ID ('' once used or lost).
    heldItem: romItem(pokemon.item),
    // The ROM's Pokédex weight in hectograms (weightOf), not Showdown's `weighthg`.
    weight: weightOf(battle, ai, pokemon).weight,
    // `happiness`, which the engine sets from BattleMon.friendship (engine/sets.ts showdownSet): the save's for the
    // player's Pokémon, the species' base friendship for the trainer's. Exact: Transform copies
    // the BattleMon only up to `ability` (battle_script.c:5346–5348), which friendship follows, and Showdown's
    // transformInto leaves happiness too.
    friendship: pokemon.happiness,
    // The set's IVs. GAP: Transform copies the target's IVs (battle_script.c:5346–5348), which Showdown doesn't (it
    // copies the Hidden Power type only), so they are listed unknown while the battler is transformed; the AI reads
    // them only for Hidden Power. Spot check 19.
    ivs: ivsOf(pokemon),
    curHP: pokemon.hp,
    maxHP: pokemon.maxhp,
    // `storedStats` (Transform and Power Trick change them, as on the cartridge).
    attack: pokemon.storedStats.atk,
    defense: pokemon.storedStats.def,
    spAttack: pokemon.storedStats.spa,
    spDefense: pokemon.storedStats.spd,
    speed: pokemon.storedStats.spe,
    // `boosts` + 6, in BATTLE_STAT order (HP, Attack, Defense, Speed, Sp. Atk, Sp. Def, accuracy, evasion); HP has no
    // boost.
    statBoosts: [
      DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE + boosts.atk, DEFAULT_STAT_STAGE + boosts.def, DEFAULT_STAT_STAGE + boosts.spe,
      DEFAULT_STAT_STAGE + boosts.spa, DEFAULT_STAT_STAGE + boosts.spd, DEFAULT_STAT_STAGE + boosts.accuracy,
      DEFAULT_STAT_STAGE + boosts.evasion,
    ],
    // `moveSlots`, the moves in use (Transform's and Mimic's copies), in slot order, with their `pp` and `maxpp`. A slot
    // with 0 PP or a Disabled move stays in place, as the cartridge's AI can pick it. Showdown's request lists the same
    // slots in the same order, except when it offers one move alone (Struggle, or a locked move); mapping a pick to the
    // request's index is `support`'s.
    moves,
    ppCur: pp,
    ppMax,
    // The status, a fainted battler's included (battleStatusOf).
    status: battleStatusOf(pokemon),
    statusVolatile: statusVolatileOf(pokemon),
    moveEffectsMask: moveEffectsMaskOf(pokemon, imprisoned),
    effects: effectsOf(battle, pokemon, totalTurns),
  };
}

/** One side's party in party order (`side.team`), as Pokemon_GetValue reads the party data. */
function partyOf(battle: Battle, data: LoadedData, side: ShowdownSide): AiPartyMon[] {
  return side.team.map((set) => {
    const pokemon = side.pokemon.find((candidate) => candidate.set === set);
    if (pokemon === undefined) throw new AiError('BAD_VIEW', `${side.id} has no Pokémon for the set ${set.name}`);
    // The set's own species and form: the party data, which Transform and form changes in battle don't touch.
    const species = battle.dex.species.get(set.species);
    const form = formOf(species.num, species.id, 0);
    const row = data.rom.species[personalRowFor(species.num, form)];
    if (row === undefined) throw new AiError('BAD_VIEW', `no Personal row for species ${species.num} form ${form}`);
    // `baseMoveSlots`: the party's own moves (no Transform or Mimic copies), with their PP.
    const { moves, pp, ppMax } = movesOf(battle, pokemon.baseMoveSlots);
    return {
      species: species.num,
      form,
      level: pokemon.level,
      hp: pokemon.hp,
      maxHp: pokemon.maxhp,
      status: statusOf(pokemon),
      moves,
      pp,
      ppMax,
      // `item`: the battle keeps the party's held item in step with the battler's (BattleMon_CopyToParty).
      heldItem: romItem(pokemon.item),
      // `baseAbility`: the party data's ability (a battle change such as Skill Swap ends on the switch-out).
      ability: romAbility(pokemon.baseAbility),
      // The Personal row's types for the set's species and form (MON_DATA_TYPE_1/2), from LoadedData.
      types: [row.types[0], row.types[1]],
      ivs: ivsOf(pokemon),
    };
  });
}

/** BattleContext.turnFlags[i] from the volatiles of the Pokémon in slot i (null: an empty slot, all clear). */
function turnFlagsOf(pokemon: Pokemon | null): AiTurnFlags {
  return {
    // 'roost', which lasts until the turn's end, as turnFlags do (BattleSystem_SetupNextTurn, battle_lib.c:2228).
    roosting: pokemon !== null && pokemon.volatiles['roost'] !== undefined,
    // 'helpinghand': never in singles, where Helping Hand fails.
    helpingHand: pokemon !== null && pokemon.volatiles['helpinghand'] !== undefined,
  };
}

/**
 * BattleContext.fieldConditionsMask from Showdown's field:
 * - `field.weather` with its duration: none (0 or unset) means it lasts until replaced, the cartridge's _PERM bit
 *   (ability weather); a duration is the _TEMP bit (a move's). Checked against the engine (adapter.test.ts): Gen 4
 *   ability weather leaves 0, and a move's weather 5, then 4 after one turn end;
 * - each battler in an Uproar (its 'uproar' volatile) sets its bit from FIELD_CONDITION_UPROAR_SHIFT;
 * - 'gravity' and 'trickroom' in `pseudoWeather`, their durations as the 3-bit counters (non-zero only).
 * The trainer's field note's weather, Trick Room and Gravity are in the engine's field, so they show
 * here: the weather as the _PERM bit (its duration is 0), Trick Room and Gravity as a counter of 1 (the AI only tests them
 * for non-zero).
 * - the deep fog bit when `fog` (the note's fog still standing: fogOf). Gen 4's deep fog has no Showdown weather, and the
 *   engine keeps it as a flag nothing here reads, so the note and the memory give it (memory.ts `fog`); the weather bits
 *   above can't hold with it (a weather clears it). Spot check 20.
 */
function fieldMaskOf(battle: Battle, actives: readonly Pokemon[], fog: boolean): number {
  const permanent = !(wholeNumber(battle.field.weatherState.duration) > 0);
  let mask = fog ? FIELD_CONDITION_DEEP_FOG : 0;
  switch (battle.field.weather) {
    case '':
      break;
    case 'raindance':
      mask |= permanent ? FIELD_CONDITION_RAINING_PERM : FIELD_CONDITION_RAINING_TEMP;
      break;
    case 'sunnyday':
      mask |= permanent ? FIELD_CONDITION_SUNNY_PERM : FIELD_CONDITION_SUNNY_TEMP;
      break;
    case 'sandstorm':
      mask |= permanent ? FIELD_CONDITION_SANDSTORM_PERM : FIELD_CONDITION_SANDSTORM_TEMP;
      break;
    case 'hail':
      mask |= permanent ? FIELD_CONDITION_HAILING_PERM : FIELD_CONDITION_HAILING_TEMP;
      break;
    default:
      throw new AiError('BAD_VIEW', `Showdown weather "${battle.field.weather}" has no Gen 4 encoding`);
  }
  actives.forEach((pokemon, battler) => {
    if (pokemon.volatiles['uproar']) mask |= 1 << (UPROAR_FIELD_SHIFT + battler);
  });
  const { gravity, trickroom } = battle.field.pseudoWeather;
  if (gravity) mask |= activeCounter(gravity.duration, THREE_BITS) << GRAVITY_SHIFT;
  if (trickroom) mask |= activeCounter(trickroom.duration, THREE_BITS) << TRICK_ROOM_SHIFT;
  return mask;
}

/**
 * BattleContext.sideConditionsMask[side] from the side's `sideConditions` (screens, Safeguard, Mist, hazards,
 * Tailwind's and Lucky Chant's durations as their counters, non-zero only) and its slot's `slotConditions`: Future
 * Sight's 'futuremove' sits on the target's slot and Wish's 'wish' on the user's, the sides the cartridge marks.
 */
function sideMaskOf(side: ShowdownSide): number {
  const c = side.sideConditions;
  const slot = side.slotConditions[0] ?? {};
  let mask = 0;
  if (c['reflect']) mask |= SIDE_CONDITION_REFLECT;
  if (c['lightscreen']) mask |= SIDE_CONDITION_LIGHT_SCREEN;
  if (c['spikes']) mask |= SIDE_CONDITION_SPIKES;
  if (c['safeguard']) mask |= SIDE_CONDITION_SAFEGUARD;
  if (slot['futuremove']) mask |= SIDE_CONDITION_FUTURE_SIGHT;
  if (slot['wish']) mask |= SIDE_CONDITION_WISH;
  if (c['mist']) mask |= SIDE_CONDITION_MIST;
  if (c['stealthrock']) mask |= SIDE_CONDITION_STEALTH_ROCK;
  if (c['tailwind']) mask |= activeCounter(c['tailwind'].duration, TWO_BITS) << TAILWIND_SHIFT;
  if (c['toxicspikes']) mask |= SIDE_CONDITION_TOXIC_SPIKES;
  if (c['luckychant']) mask |= activeCounter(c['luckychant'].duration, THREE_BITS) << LUCKY_CHANT_SHIFT;
  return mask;
}

/** Exact (LoadSpikesLayers, trainer_ai.c:1948): the 'spikes' and 'toxicspikes' side conditions' `layers`, 0 without. */
function hazardsOf(side: ShowdownSide): AiSideConditions {
  const layers = (id: string): number => {
    const condition = side.sideConditions[id];
    if (!condition) return 0;
    const count = wholeNumber(condition['layers']);
    return Number.isNaN(count) ? 1 : count;
  };
  return { spikesLayers: layers('spikes'), toxicSpikesLayers: layers('toxicspikes') };
}
