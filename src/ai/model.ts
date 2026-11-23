// trainerAi: the contract's EnemyModel (src/contracts/ai.ts) over the engine. It ties the AI port to the battle engine:
// engine state → the AI's view (viewFromState) → the cartridge's exact decision (pickCommand, moveDistribution,
// replacement) → contract Choices, and the AI's memory (rememberStep).
//
// How the cartridge gets the AI's move (pret/pokeplatinum 62bdaacdc; bcp = battle_controller_player.c, bd =
// battle_display.c, bl = battle_lib.c):
// 1. Command selection starts (bcp:321). A battler that can't pick a command (Battler_CanPickCommand, bl:6224–6236:
//    recharging, a Thrash-type lock, an Uproar or a move-locking volatile) gets Fight with no AI call at all
//    (bcp:334–338): the battle plays its locked move. Showdown's request then offers that one move.
// 2. Otherwise the AI picks a command (Task_TrainerSetCommandSelection → TrainerAI_PickCommand, bd:3408–3411): a
//    switch, a bag item, or Fight.
// 3. On Fight: with every slot invalid (CHECK_INVALID_ALL gives STRUGGLING_ALL), the battle plays Struggle with no move
//    menu (bcp:432–440). With an Encore, it plays encoredMoveSlot with no move menu (bcp:442–451). Otherwise the move
//    menu runs TrainerAI_Main (Task_TrainerShowMoveSelectMenu, bd:3580–3595).
// 4. A slot the AI picks that BattleSystem_CanUseMove refuses (Disabled, Tormented, Taunted, Imprisoned, Gravity, Heal
//    Block, a Choice lock, no PP; bl:2321–2373) gets an alert, which the AI's battler acknowledges at once
//    (BattleDisplay_SetAlertMessage, bd:1387–1389), and the state goes back to the move menu (bcp:524–534, :670–675),
//    which runs TrainerAI_Main again (bcp:516–518). Each run draws its own damage rolls (TrainerAI_Init, trainer_ai.c:240)
//    and tie-break (:338), and it starts from the same state: TrainerAI_Init clears the AI's scratch fields (:217–221),
//    recording the last move again is a no-op (:2708), and monSpeedValues, the one BattleContext field a run writes,
//    take the run's compare value W. One draw is NOT redrawn: this turn's Quick Claw draw, speedRand, which
//    only bcp:855 and bl:2024 draw, so every re-run reads the same one. So, when W equals the decision-start values,
//    given the Quick Claw draws q the runs are independent copies of the first, and the slot played is s with
//    probability Σ_q P(q) · P(s | q) / P(usable | q) (playedSlots: an unknown draw is conditioned on, not summed out
//    first). With W unequal, a later run could start from other speeds: UNDEFINED. With no usable pick for some q of
//    prior > 0, the cartridge loops forever there: UNDEFINED too.

import type { LoadedData } from '../battle/types.js';
import type { ActionSupport, AiMemory, EnemyModel } from '../contracts/ai.js';
import type { Choice, EngineState, Outcome, Rational } from '../contracts/engine.js';
import { loadLocalData } from '../data/load.js';
import { legalChoices } from '../engine/index.js';
import { AI_FLAG_NAMES } from '../rom/trainers.js';
import { fieldNoteOf, peekBattle, protocolIds, startLogOf, trainerOf, viewFromState } from './adapter.js';
import { type AiAction, pickCommand } from './choose/decide.js';
import { moveDistribution, type SlotDist } from './choose/moves.js';
import { replacement } from './choose/postKo.js';
import {
  CHECK_INVALID_CHOICE_ITEM, CHECK_INVALID_DISABLED, CHECK_INVALID_GRAVITY, CHECK_INVALID_HEAL_BLOCK,
  CHECK_INVALID_IMPRISONED, CHECK_INVALID_NO_PP, CHECK_INVALID_TAUNTED, CHECK_INVALID_TORMENTED,
  HOLD_EFFECT_SOMETIMES_PRIORITY, ITEM_POWER_CHECK_ALL, LEARNED_MOVES_MAX,
  VOLATILE_CONDITION_MOVE_LOCKED, VOLATILE_CONDITION_RECHARGING, VOLATILE_CONDITION_THRASH, VOLATILE_CONDITION_UPROAR,
} from './constants.js';
import { enumerate } from './enumerate.js';
import { AiError } from './errors.js';
import { u8 } from './int.js';
import { itemChoice } from './itemChoice.js';
import { assertGuarded } from './lib/known.js';
import { heldItemEffect, heldItemPower } from './lib/battler.js';
import { invalidMoves } from './lib/invalidMoves.js';
import { compareSpeed, readQuickClaw } from './lib/speed.js';
import { type AiMemoryData, initialMemoryData, memoryKey, recordLastMove, rememberStep, type TurnFight } from './memory.js';
import { add, eq, mul, ONE, rat, sum, ZERO } from './odds.js';
import { type AiRomData, aiScriptOf, loadAiData } from './rom/aiData.js';
import { AI_BATTLER, type AiBattleMon, type AiDeps, type AiKnowledge, type AiView, PLAYER_BATTLER } from './view.js';

/**
 * The trainer's whole AI mask (`header.aiMask`, which TrainerAI_Init reads, trainer_ai.c:249) for the battle in `state`,
 * as a u32. The engine keeps the trainer's ROM index and raw mask in the state (battleTrainer, read
 * through adapter.ts trainerOf; it throws for a state createBattle didn't make, and that throw goes through). The mask
 * must be the loaded data's for that ROM trainer, as depsFor checks a catalog trainer's (initialView.ts): the same raw
 * mask, and the same named flags (RomTrainer.aiFlags, which the catalog's ResolvedTrainer.aiFlags copy). Otherwise the
 * engine and the AI run on different data: AiError('BAD_VIEW'). So it is too without species record 0, which
 * LoadBattlerAbility and CheckBattlerAbility read for an empty battler slot (trainer_ai.c:1191–1192, 1236–1237). Only
 * the move choice reads the mask (choose/moves.ts): the switch and item checks, the forced moves and the post-KO
 * replacement don't.
 */
function aiMaskFromState(data: LoadedData, state: EngineState): number {
  const { romIndex, aiMask } = trainerOf(state);
  const mask = aiMask >>> 0;
  const { trainers } = data.rom;
  const rom = trainers[romIndex]?.index === romIndex ? trainers[romIndex] : trainers.find((trainer) => trainer?.index === romIndex);
  if (rom === undefined) throw new AiError('BAD_VIEW', `the loaded data has no ROM trainer ${romIndex}, which the battle is against`);
  const named = AI_FLAG_NAMES.filter((_, bit) => (mask >>> bit) & 1);
  if ((rom.aiMask >>> 0) !== mask || named.join() !== rom.aiFlags.join()) {
    throw new AiError('BAD_VIEW', `ROM trainer ${romIndex}: the engine's AI mask ${mask} [${named.join(', ')}] is not the loaded `
      + `trainer's ${rom.aiMask >>> 0} [${rom.aiFlags.join(', ')}]`);
  }
  if (data.rom.species[0] === undefined) {
    throw new AiError('BAD_VIEW', 'the data has no species record 0, which the AI reads for an empty battler slot (trainer_ai.c:1191, 1236)');
  }
  return mask;
}

/** CHECK_INVALID_ALL's result when every slot is invalid (constants/battle.h:137, STRUGGLING_ALL). */
const STRUGGLING_ALL = (1 << LEARNED_MOVES_MAX) - 1;

/** The checks BattleSystem_CanUseMove makes before the battle plays a picked slot (bl:2321–2373). */
const CAN_USE_MOVE_CHECKS = CHECK_INVALID_DISABLED | CHECK_INVALID_TORMENTED | CHECK_INVALID_TAUNTED
  | CHECK_INVALID_IMPRISONED | CHECK_INVALID_GRAVITY | CHECK_INVALID_HEAL_BLOCK | CHECK_INVALID_CHOICE_ITEM | CHECK_INVALID_NO_PP;


/** Battler_CanPickCommand, bl:6224–6236. */
function canPickCommand(mon: AiBattleMon): boolean {
  const locked = VOLATILE_CONDITION_RECHARGING | VOLATILE_CONDITION_THRASH | VOLATILE_CONDITION_UPROAR | VOLATILE_CONDITION_MOVE_LOCKED;
  return (mon.statusVolatile & locked) === 0;
}

/**
 * How the AI's Fight goes at this turn's command selection (see the top of this file): 'locked', no command selection
 * at all (Battler_CanPickCommand FALSE, bcp:334–338); 'struggle', every slot invalid (bcp:432–440); 'encore', an Encore
 * lock (bcp:442–451); else 'menu', the move menu, which runs TrainerAI_Main. `support` takes its branches from it, and the
 * memory its fact "TrainerAI_Main ran" (memory.ts turnFight), so the two can't drift.
 */
export function fightKind(v: AiView, d: AiDeps): 'locked' | 'struggle' | 'encore' | 'menu' {
  const mon = v.mons[AI_BATTLER];
  if (!canPickCommand(mon)) return 'locked';
  if (invalidMoves(v, d, AI_BATTLER) === STRUGGLING_ALL) return 'struggle';
  return mon.effects.encoredMove !== 0 ? 'encore' : 'menu';
}

/** One move in Showdown's request: its ID, and whether it may be chosen (the engine's legalChoices test). */
interface RequestMove { id: string; usable: boolean }

/** p2's move request in `battle`, entry by entry. AiError('BAD_VIEW') when the battle doesn't wait on p2's turn choice. */
function requestMoves(battle: Battle): RequestMove[] {
  const request = battle.p2.activeRequest as { active?: { moves: { id: string; pp?: number; disabled?: unknown }[] }[] } | null;
  const moves = request?.active?.[0]?.moves;
  if (moves === undefined) throw new AiError('BAD_VIEW', 'the battle does not wait on the trainer\'s turn choice');
  return moves.map((entry) => ({ id: entry.id, usable: !entry.disabled && entry.pp !== 0 }));
}

/** The Choice that plays Showdown move `id` from the request, or AiError('BAD_VIEW') where the engine refuses it. */
function requestChoice(moves: readonly RequestMove[], id: string, why: string): Choice {
  const slot = moves.findIndex((entry) => entry.id === id);
  if (slot < 0 || !moves[slot]!.usable) {
    throw new AiError('BAD_VIEW', `${why}: the engine's request [${moves.map((entry) => entry.id).join(', ')}] doesn't offer ${id}`);
  }
  return { kind: 'move', slot };
}

function choiceOf(action: AiAction): Choice {
  if (action.kind === 'switch') return { kind: 'switch', index: action.partyIndex };
  if (action.kind === 'item') return itemChoice(action);
  throw new Error('a move action needs the request to map');
}

/** The probabilities of `entries`, merged by Choice (canonical JSON), in first-seen order, checked to sum to ONE. */
function merged(entries: readonly ActionSupport[]): ActionSupport[] {
  const byKey = new Map<string, ActionSupport>();
  for (const { choice, probability } of entries) {
    if (probability.num === 0n) continue;
    const key = JSON.stringify(choice);
    const seen = byKey.get(key);
    byKey.set(key, { choice, probability: seen ? add(seen.probability, probability) : probability });
  }
  const result = [...byKey.values()];
  const total = sum(result.map((entry) => entry.probability));
  if (!eq(total, ONE)) throw new Error(`the support sums to ${total.num}/${total.den}, not 1`);
  return result;
}

/**
 * The moves TrainerAI_Main's picks end as, with `fight` the probability of the Fight command (playedSlots, see the top
 * of this file). Each maps to the request's index of its slot's Showdown move.
 */
function playedPicks(v: AiView, d: AiDeps, md: AiMemoryData, battle: Battle, moves: readonly RequestMove[], fight: Rational): ActionSupport[] {
  // TrainerAI_MainSingles records the player's last move first (trainer_ai.c:2705). moveDistribution records it too
  // (moves.ts setup); recording twice is a no-op (memory.ts recordMove), so this keeps the record where the C has it.
  const knowledge = recordLastMove(md.knowledge, v, PLAYER_BATTLER);
  const slots = battle.p2.active[0]!.moveSlots;
  return playedSlots(v, d, knowledge).map((pick) => {
    const id = slots[pick.slot]?.id;
    if (id === undefined) throw new AiError('BAD_VIEW', `the AI picked slot ${pick.slot}, which holds no move`);
    return { choice: requestChoice(moves, id, `the AI's pick of slot ${pick.slot}`), probability: mul(fight, pick.probability) };
  });
}

/**
 * The slots the battle plays from TrainerAI_Main's picks, given Fight, each with its exact probability: the usable picks
 * (BattleSystem_CanUseMove takes them), renormalised over the re-runs a refused pick causes (bcp:524–534). The re-runs
 * redraw everything but this turn's Quick Claw draws (see the top of this file), so when a pick is refused and a
 * battler holding a HOLD_EFFECT_SOMETIMES_PRIORITY item has an unknown draw (quickClawThisTurn null), each joint value q
 * of those draws is a branch: a view with the draws set to q, its own move distribution, renormalised on its own, mixed
 * by the prior P(q) (readQuickClaw's `speedRand % (100 / param) == 0`, battle_lib.c:1279, 1345). In singles that is at
 * most battlers 0 and 1: four branches. AiError('UNDEFINED') when a branch of prior > 0 has no usable pick: the cartridge
 * re-runs TrainerAI_Main forever there. With no refused pick, or no unknown draw, it is the one distribution as it is.
 */
export function playedSlots(v: AiView, d: AiDeps, knowledge: AiKnowledge): SlotDist[] {
  const picks = moveDistribution(v, d, knowledge);
  const refused = invalidMoves(v, d, AI_BATTLER, CAN_USE_MOVE_CHECKS);
  const isUsable = (pick: SlotDist): boolean => (refused & (1 << pick.slot)) === 0;
  if (picks.every(isUsable)) return picks;
  requireSameRestart(v, d);
  const out = new Map<number, Rational>();
  for (const branch of quickClawBranches(v, d)) {
    const dist = branch.view === v ? picks : moveDistribution(branch.view, d, knowledge);
    const usable = dist.filter(isUsable);
    const pUsable = sum(usable.map((pick) => pick.probability));
    if (pUsable.num === 0n) {
      throw new AiError('UNDEFINED', `every slot the AI picks${branch.label} is refused: the cartridge re-runs TrainerAI_Main forever`);
    }
    for (const pick of usable) {
      const p = mul(branch.prior, rat(pick.probability.num * pUsable.den, pick.probability.den * pUsable.num));
      out.set(pick.slot, add(out.get(pick.slot) ?? ZERO, p));
    }
  }
  return [...out].sort(([a], [b]) => a - b).map(([slot, probability]) => ({ slot, probability }));
}

/** One joint value of the unknown Quick Claw draws: the view with them set, its prior, and a label for errors. */
interface QuickClawBranch { view: AiView; prior: Rational; label: string }

/**
 * The views conditioned on each joint value of the Quick Claw draws the view leaves unknown, for the battlers in play
 * whose held item has HOLD_EFFECT_SOMETIMES_PRIORITY (Battler_HeldItemEffect, as BattleSystem_CompareBattlerSpeed reads
 * it, battle_lib.c:1216), with their priors from readQuickClaw's weights (the item's u8 param, :1218). `v` alone, at
 * ONE, when there are none. A branch of prior 0 is dropped.
 */
function quickClawBranches(v: AiView, d: AiDeps): QuickClawBranch[] {
  let branches: QuickClawBranch[] = [{ view: v, prior: ONE, label: '' }];
  for (const battler of [PLAYER_BATTLER, AI_BATTLER]) {
    if (v.quickClawThisTurn[battler] !== null || heldItemEffect(v, d, battler) !== HOLD_EFFECT_SOMETIMES_PRIORITY) continue;
    const param = u8(heldItemPower(v, d, battler, ITEM_POWER_CHECK_ALL));
    const latents = () => ({ rolls: [null, null, null, null], quickClaw: [null, null, null, null] });
    const prior = enumerate((pick) => readQuickClaw(v, latents(), battler, param, pick), String);
    branches = branches.flatMap((branch) => prior.filter((leaf) => leaf.probability.num !== 0n).map((leaf) => {
      const quickClawThisTurn = [...branch.view.quickClawThisTurn];
      quickClawThisTurn[battler] = leaf.value;
      return {
        view: { ...branch.view, quickClawThisTurn }, prior: mul(branch.prior, leaf.probability),
        label: `${branch.label} with battler ${battler}'s Quick Claw ${leaf.value ? 'firing' : 'not firing'}`,
      };
    }));
  }
  return branches;
}

/**
 * A re-run after a refused pick starts from the speeds the first run's compares wrote, W (every compare of
 * the decision writes the same values). It is a copy of the first run only when W equals the view's monSpeedValues;
 * otherwise AiError('UNDEFINED'). W is the AI's compare of battlers 0 and 1 on the view (lib/speed.ts), whose speeds
 * depend on no draw.
 */
function requireSameRestart(v: AiView, d: AiDeps): void {
  const latents = { rolls: [null, null, null, null], quickClaw: [null, null, null, null] };
  const { speeds } = compareSpeed(v, d, latents, PLAYER_BATTLER, AI_BATTLER, () => 0);
  if (speeds !== null && (speeds[0] !== v.monSpeedValues[PLAYER_BATTLER] || speeds[1] !== v.monSpeedValues[AI_BATTLER])) {
    throw new AiError('UNDEFINED', `a refused pick re-runs TrainerAI_Main from speeds [${speeds.join(', ')}], not the decision's`);
  }
}

/** AiMemory from its data: `key` is memoryKey, canonical. */
function toMemory(data: AiMemoryData): AiMemory {
  return { key: memoryKey(data), data };
}

/** The AiMemoryData an AiMemory carries; AiError('BAD_VIEW') for a memory this model didn't make. */
function dataOf(memory: AiMemory): AiMemoryData {
  const data = memory.data as Partial<AiMemoryData> | null;
  if (data === null || typeof data !== 'object' || data.knowledge === undefined || data.recycleOverride === undefined
    || data.switchAction === undefined || data.aiKept === undefined || data.turnFight === undefined
    || data.playerMovesUnknown === undefined || data.imprisonedMark === undefined || data.permWeather === undefined
    || data.fog === undefined) {
    throw new AiError('BAD_VIEW', 'the memory is not the trainer AI\'s');
  }
  return data as AiMemoryData;
}

/**
 * The trainer AI as an EnemyModel over `data` (the LoadedData the engine's mod was installed from) and `ai` (the AI's ROM
 * data). The trainer's AI mask comes from the state (aiMaskFromState).
 */
export function createTrainerAi(data: LoadedData, ai: AiRomData): EnemyModel {
  const script = aiScriptOf(ai);
  /** AiDeps with `aiFlags`; only TrainerAI_Main reads them. */
  const deps = (aiFlags: number): AiDeps => ({
    script, moves: data.rom.moves, species: data.rom.species, items: ai.items, typeChart: ai.typeChart, aiFlags: aiFlags >>> 0,
  });

  /**
   * `md` with the fact of turn-choice state `state` for its turn's first step (memory.ts turnFight): whether Fight runs
   * TrainerAI_Main there (fightKind 'menu') or the battle forces the move. 'unknown' where the state's view can't be built
   * (an AiError, which `support` would throw there too): the memory then doesn't guess the record.
   */
  const withTurnFact = (state: EngineState, md: AiMemoryData): AiMemoryData => {
    if (state.phase.kind !== 'turnChoice') return md;
    let turnFight: TurnFight;
    try {
      turnFight = fightKind(viewFromState(state, data, ai, md), deps(0)) === 'menu' ? 'menu' : 'forced';
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      turnFight = 'unknown';
    }
    return { ...md, turnFight };
  };

  return {
    id: `pokeplatinum-ai@${ai.scriptSha256.slice(0, 12)}`,

    /**
     * battleStartMemory: the switch-in announcements, folded from the battle start's log, run before the first command
     * selection (bcp:254–267). Only a battle start takes it: createBattle's state, turn 1's turn choice. Any later state
     * has steps the start's memory lacks (the moves the AI has seen), which only `remember` folds, so it is
     * AiError('BAD_VIEW'), never the start's memory.
     */
    initialMemory(state: EngineState): AiMemory {
      if (state.turn !== 1 || state.phase.kind !== 'turnChoice') {
        throw new AiError('BAD_VIEW', `initialMemory needs a battle start (turn 1's turn choice), not turn ${state.turn}'s ${state.phase.kind}`);
      }
      return toMemory(withTurnFact(state, battleStartMemory(state)));
    },

    support(state: EngineState, memory: AiMemory): ActionSupport[] {
      if (state.phase.kind !== 'turnChoice') throw new AiError('BAD_VIEW', `support needs a turn choice, not ${state.phase.kind}`);
      const md = dataOf(memory);
      const v = viewFromState(state, data, ai, md);
      // Refuse the whole decision when the view lists a path no reader guards (the field-note
      // paths, which every damage estimate and speed compare reads), before even a forced move.
      assertGuarded(v);
      // The request and the move slots, from the battle the view was read from (adapter.ts peekBattle, the engine's
      // peek: no restore).
      const battle = peekBattle(state);
      const moves = requestMoves(battle);
      const mon = v.mons[AI_BATTLER];
      const fight = fightKind(v, deps(0));

      // 1. No command selection: the locked move, at ONE (bcp:334–338).
      if (fight === 'locked') {
        if (moves.length !== 1) throw new AiError('BAD_VIEW', `a locked battler, but the request offers ${moves.length} moves`);
        return [{ choice: requestChoice(moves, moves[0]!.id, 'the locked move'), probability: ONE }];
      }

      // 2. TrainerAI_PickCommand: switches and the bag item read no AI flag.
      const command = pickCommand(v, deps(0));
      const entries: ActionSupport[] = command.actions.map(({ action, probability }) => ({ choice: choiceOf(action), probability }));
      if (command.fight.num !== 0n) {
        if (fight === 'struggle') {
          // 3a. Struggle, with no move menu (bcp:432–440): Showdown's request offers Struggle alone.
          entries.push({ choice: requestChoice(moves, 'struggle', 'Struggle'), probability: command.fight });
        } else if (fight === 'encore') {
          // 3b. Encore: encoredMoveSlot, with no move menu (bcp:442–451); the slot holding the encored move
          // (Battler_SlotForMove, bl:2376).
          const slot = mon.moves.indexOf(mon.effects.encoredMove);
          const id = battle.p2.active[0]!.moveSlots[slot]?.id;
          if (id === undefined) throw new AiError('BAD_VIEW', `the encored move ${mon.effects.encoredMove} is in no slot`);
          entries.push({ choice: requestChoice(moves, id, 'the encored move'), probability: command.fight });
        } else {
          // 3c. TrainerAI_Main, re-run while its pick is refused (4.).
          entries.push(...playedPicks(v, deps(aiMaskFromState(data, state)), md, battle, moves, command.fight));
        }
      }

      const support = merged(entries);
      checkLegal(state, support);
      return support;
    },

    /**
     * The send-in after an enemy KO or the AI's own U-turn or Baton Pass: aiSwitchedPartySlot is 6, so
     * BattleAI_PostKOSwitchIn, else the first living bench Pokémon (bd:4543–4559; choose/postKo.ts). No draw, no AI
     * flag: one switch at ONE. The view lists what the state can't give the pick (adapter.ts replacementState: a mid-turn
     * switch's own battleStatusMask bits and powerMul, a fainted battler's kept fields), which assertGuarded refuses.
     * Nothing the pick runs compares speeds: neither stage reads speedRand or a Quick Claw roll.
     */
    replacementSupport(state: EngineState, memory: AiMemory): ActionSupport[] {
      const { kind } = state.phase;
      if (kind !== 'enemyReplacement' && kind !== 'enemyMidTurnSwitch') {
        throw new AiError('BAD_VIEW', `replacementSupport needs an enemy replacement or mid-turn switch, not ${kind}`);
      }
      const v = viewFromState(state, data, ai, dataOf(memory));
      assertGuarded(v); // the replacement path checks it too
      const support = [{ choice: { kind: 'switch', index: replacement(v, deps(0)) } as Choice, probability: ONE }];
      checkLegal(state, support);
      return support;
    },

    /**
     * rememberStep over the step's omniscient log, with the installed dex's ID maps (protocolIds) and the phase the step
     * ends at (a mid-turn switch keeps the switching action's moves, memory.ts switchAction); at a turn choice, that
     * turn's fact for whether TrainerAI_Main runs (withTurnFact). Pure.
     */
    remember(memory: AiMemory, outcome: Outcome): AiMemory {
      const md = rememberStep(dataOf(memory), outcome.log, protocolIds(), { phase: outcome.state.phase.kind });
      return toMemory(withTurnFact(outcome.state, md));
    },
  };
}

/**
 * The AI's memory at the battle start in `state`: initialMemoryData (AIContext cleared, battle_controller_player.c:4799)
 * with the field note's _PERM weather (fieldNoteOf, which the adapter reads; memory.ts permWeather), then the battle
 * start's log folded in. The engine keeps those lines, omniscient, in every state of the battle (battleStartLog). What
 * they reveal follows the switch-in messages' tags (memory.ts): an ability's announcement, BattleAI_SetAbility
 * (battle_script.c:12106), where the message tags the holder; never Frisk's find, which tags BTLSCR_MSG_TEMP
 * (subscript_frisk.s:7); never a weather ability into its own _PERM weather, which runs no subscript
 * (battle_lib.c:3746–3782). Where a start chance decides the switch-in order, they are the first outcome's; such a
 * start carries the engine's BATTLE_START_CHANCE_NOTE (unmodelledIn), so a proof through it is unproven anyway. Both
 * the EnemyModel's initialMemory and initialView (switchIn.ts) take it, so the two paths know the same.
 */
export function battleStartMemory(state: EngineState): AiMemoryData {
  const note = fieldNoteOf(state).weather ?? null;
  return rememberStep(initialMemoryData(note), startLogOf(state), protocolIds(), { phase: state.phase.kind });
}

/**
 * Every choice in `support` is legal for p2 in `state` (an item by its id: legalChoices lists each modelled bag item
 * once); AiError('BAD_VIEW') otherwise, where the cartridge plays what the engine refuses. The engine answers
 * legalChoices without a restore for a state it built (facts.ts: `expandTurn`'s outcomes and `createBattle`'s
 * state); any other state object pays one restore on its first read, then is answered from the engine's record of it.
 */
function checkLegal(state: EngineState, support: readonly ActionSupport[]): void {
  const legal = legalChoices(state, 'p2').map((choice) => JSON.stringify(choice));
  for (const { choice } of support) {
    const asLegal = choice.kind === 'item' ? { kind: 'item', item: choice.item } : choice;
    if (!legal.includes(JSON.stringify(asLegal))) {
      throw new AiError('BAD_VIEW', `the AI's ${JSON.stringify(choice)} is not among the engine's choices [${legal.join(', ')}]`);
    }
  }
}

let loaded: EnemyModel | null = null;

/** The model over this directory's extracted data, made on first use. */
function localModel(): EnemyModel {
  loaded ??= createTrainerAi(loadLocalData(), loadAiData());
  return loaded;
}

/**
 * The trainer AI over the local data (`loadLocalData()` and `loadAiData()`, read on first use, not at import). The
 * engine's mod must be installed from the same data (installKaizoDex) before a state is given to it.
 */
export const trainerAi: EnemyModel = {
  get id() {
    return localModel().id;
  },
  initialMemory: (state) => localModel().initialMemory(state),
  support: (state, memory) => localModel().support(state, memory),
  replacementSupport: (state, memory) => localModel().replacementSupport(state, memory),
  remember: (memory, outcome) => localModel().remember(memory, outcome),
};
