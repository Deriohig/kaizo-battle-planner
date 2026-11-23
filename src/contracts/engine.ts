// Contract between the battle engine (`src/engine`) and its consumers: the trainer AI (`src/ai`) and
// the solver (`src/solver`). Types only, no runtime code.
//
// Change it here first, then in the engine, the trainer AI and the solver together.

import type { PlayerMon } from '../battle/playerMon.js';
import type { ResolvedTrainer } from '../battle/types.js';
import type { StartStatus } from '../save/status.js';

/** An exact probability: bigint numerator and denominator, always reduced, `den > 0n`. */
export interface Rational { readonly num: bigint; readonly den: bigint }

/** `p1` is the player, `p2` is the trainer. */
export type Side = 'p1' | 'p2';

/** Field conditions at battle start, from the trainer's docs field note (`FieldNote`). */
export interface FieldSpec { weather?: 'rain' | 'sun' | 'sand' | 'hail'; fog?: boolean; trickRoom?: boolean; gravity?: boolean }

/**
 * A decision for one side. `slot` indexes the request's move list (Struggle when forced); `index` is a 0-based party
 * position. `item` is p2 only: `item` is the item whose effect applies, as the lowercase `toID` of its name
 * (`fullrestore`, `hyperpotion`, `xattack`…; the engine exports `bagItemId(romItem)`). `consumeSlots` lists the bag
 * positions emptied by this use, indexing the trainer's battle-start bag (`RomTrainer.items` order, empty ROM slots
 * dropped). A used item stays in place as an empty position, so indices never shift during a battle. Absent means
 * "one copy of `item`". The cartridge's `TrainerAI_ShouldUseItem` has no `break`, so one use can empty several positions
 *.
 *
 * `effect` is the routine that runs (`usedItemType`) and its condition (`usedItemCondition`), which can differ from
 * `item`'s own: the routine comes from the last slot whose check passed, while `item` (`usedItem`, its numbers and its
 * message) is the last emptied slot's. Example: a Potion fires and an Antidote sits after it, so "used one Antidote" runs
 * the HP routine with Antidote's numbers and heals nothing. Absent `effect` means `item`'s own effect (the single-slot
 * case). `'undefined'` is `ITEM_AI_CATEGORY_MAX`, which the cartridge doesn't handle; the engine reports it through
 * `unmodelledIn`, so the line is unproven. Source: trainer_ai.c:4091-4196 and battle_controller_player.c:1905-1945
 *.
 */
export type ItemEffect = {
  category: 'fullRestore' | 'recoverHp' | 'recoverStatus' | 'statBooster' | 'guardSpec' | 'undefined';
  statusMask?: number;                                               // usedItemCondition for recoverStatus: OR of every passing status slot.
                                                                     // It decides what is cured, not `item` (subscript_use_status_recovery.s:17,48-54).
  stat?: 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy';         // statBooster: names the message only; the stat and stages come from
                                                                     // `item`'s own parameters (subscript_use_stat_booster.s:13)
};
export type Choice =
  | { kind: 'move'; slot: number }
  | { kind: 'switch'; index: number }
  | { kind: 'item'; item: string; consumeSlots?: number[]; effect?: ItemEffect };

/** Who must decide next. */
export type Phase =
  | { kind: 'turnChoice' }            // p1 picks (OR), then the AI picks (AND)
  | { kind: 'playerMidTurnSwitch' }   // U-turn, Baton Pass by p1: p1 picks (OR)
  | { kind: 'enemyMidTurnSwitch' }    // U-turn, Baton Pass by p2: the AI picks (AND)
  | { kind: 'enemyReplacement' }      // after an enemy KO: the AI picks (AND)
  | { kind: 'playerReplacement' }     // after a p1 faint: the solver treats reaching this as a death
  | { kind: 'terminal'; winner: Side };

/** An immutable battle snapshot. `key` is the exact state key (equal keys mean identical futures); `json` is engine-private. */
export interface EngineState { readonly json: string; readonly turn: number; readonly phase: Phase; readonly key: string }

/**
 * A carried sleep whose counter was never drawn (asleep from a move; counters are kept in hazard form):
 * `attempts` move attempts already spent asleep. `createBattle(…, carry)` restores the same hazard state, so wake chances
 * continue from attempt `attempts + 1` with the Pokémon's own Early Bird rule. A save or pre-sleep counter stays
 * `{ kind: 'sleep', turns }` (exact). Only sleep needs this: other counters end with the battle.
 */
export interface UndrawnSleep { kind: 'sleepUndrawn'; attempts: number }

/**
 * What a gauntlet carries from one fight to the next, in p1 party order.
 * - `hp`: current HP. A value above the Pokémon's max HP means full HP (so a heal between fights needs no stats).
 * - `pp`: current PP, one entry per move, in the order of `moves` when given, else of the save's moves. An entry above
 *   the move's max PP means full PP.
 * - `item`: the ROM item ID the Pokémon holds at the end of the fight, 0 for none (a
 *   Sitrus Berry eaten or a Focus Sash used up is gone in the next fight, as on the cartridge). Absent: the Pokémon's
 *   own held item from the save.
 * - `exp`: the Pokémon's total experience at the end of the fight. The next fight starts it at
 *   the level the growth table gives for `exp`, with that level's stats, so a level gained in one fight carries into
 *   the next. Absent: the save's experience and level (`PlayerMon.exp`, `PlayerMon.level`).
 * - `moves`: its ROM move IDs in slot order at the end of the fight. It differs from the save's
 *   only when a level-up taught a move into a free slot. Absent: the save's moves.
 * `carryOut` always gives `item`, `exp` and `moves`. Whoever changes a carry between fights (a heal) keeps all three.
 */
export interface CarryState {
  mons: { hp: number; pp: number[]; status: StartStatus | UndrawnSleep; item?: number; exp?: number; moves?: number[] }[];
}

/** One candidate world for disputed enemy data, per p2 party index. The solver proves over every world. */
export interface WorldAssignment { enemy: { nature?: number; ability?: number }[] }

export interface BattleInput {
  player: PlayerMon[];                          // lead first
  trainer: ResolvedTrainer;
  field: FieldSpec;
  carry?: CarryState;                           // gauntlets
  startStatus?: Record<number, StartStatus>;    // p1 party index → manual pre-status; pre-sleep is { kind: 'sleep', turns: 1 }
  world?: WorldAssignment;
  badges?: number;                              // the save's badge count, 0 to 8. Not read by the engine:
                                                // the hack removes the cartridge's obedience check (overlay 16
                                                // 0x0224E1D0, `cmp r0, #8` patched to `cmp r0, #0` in
                                                // BattleControllerPlayer_CheckObedience), so every Pokémon obeys.
}

export type ChanceKind =
  | 'roll' | 'crit' | 'hit' | 'effect' | 'speedTie' | 'quickClaw' | 'multiHit' | 'sleepWake' | 'confusionSnap'
  | 'selfHit' | 'fullPara' | 'thaw' | 'infatuation' | 'durationEnd' | 'protect' | 'pick' | 'abilityProc' | 'itemProc'
  | 'switchTarget' | 'raw';

/**
 * One resolved chance event on an outcome's path, e.g. { kind: 'crit', side: 'p2', source: 'rockslide', outcome: 'crit' }.
 */
export interface ChanceLabel {
  kind: ChanceKind;
  side: Side | null;
  source: string;
  outcome: string;
  /**
   * Only on a damage roll (kind 'roll'): what `outcome`'s number is.
   * 'final': the hit's damage after every modifier, for a collapsed pick (every roll it stands for does this damage)
   *   and for the '≥hp' option.
   * 'base': the roll's value before STAB, type effectiveness, items and abilities, for a pick left uncollapsed because
   *   the hit's damage handler is not pure (a resist berry).
   * Absent: not stated (engines from before this field). Never set on other kinds.
   */
  rollValue?: 'final' | 'base';
}

/** One distinct result of a step, merged over identical (state key, critBy, observation). Probabilities over a step sum to exactly 1. */
export interface Outcome {
  probability: Rational;
  labels: ChanceLabel[];                        // chance events with more than one option, in order
  critBy: { p1: boolean; p2: boolean };
  unlabelled: boolean;                          // a raw (unlabelled) random draw happened: the solver treats the line as unproven
  state: EngineState;                           // state.phase is what comes next
  observation: string;                          // canonical, possibly COARSER than the screen: the visible end-of-step state (the player's exact side,
                                                // the enemy's HP-bar pixels, statuses, stages, field, reveals, fainted counts) plus the step's
                                                // message kinds (moves used with crit/miss/effectiveness flags, status and stat events, faints,
                                                // switches, on-screen item/ability activations). Per-hit damage amounts and the order of identical
                                                // events are dropped. A plan may ignore information, so coarsening never makes a proof unsound; it
                                                // can only miss a line that needed finer detail. Never: enemy exact HP, stats or PP, hidden
                                                // counters or rolls, unrevealed moves/abilities/items.
  log: string[];                                // omniscient Showdown protocol lines for this step, standard format — for the AI memory and the checker.
                                                // Must keep at least: |move|, |switch|/|drag|, |-damage|/|-heal|, |-crit|, |-miss|, |-ability|, |-item|,
                                                // |-enditem|, |-activate| (incl. Quick Claw), |-status|/|-curestatus|, |-boost|/|-unboost|, |faint|
  fainted: { p1: number[]; p2: number[] };      // party indices fainted in this step
  merged: number;                               // leaves merged into this outcome
}

export type EngineErrorCode = 'UNSUPPORTED_DOUBLE' | 'UNMODELLED_ITEM' | 'BAD_CHOICE' | 'LIMIT' | 'STOPPED';

export interface Engine {
  readonly id: string;                          // e.g. 'showdown@0.11.11+platkaizo@<git sha>'
  createBattle(input: BattleInput): EngineState;
  legalChoices(state: EngineState, side: Side): Choice[];
  /**
   * Every outcome of running the step from `state` with the given choices (whichever the phase requires). Throws an
   * `EngineErrorCode` error on failure. `maxLeaves`: past that many leaves it throws `LIMIT` (deterministic).
   * `shouldStop`: polled on entry, before every leaf, and between chunks of any long work after the last
   * leaf; when it returns true, throws `STOPPED` (not deterministic; never mixed with `LIMIT`) with no partial result
   * and nothing cached. Never part of any cache key. A call it doesn't stop returns exactly what it returns without it.
   */
  expandTurn(state: EngineState, choices: { p1?: Choice; p2?: Choice }, opts?: { maxLeaves?: number; shouldStop?: () => boolean }): Outcome[];
  /** What the player sees in `state` (used for the root; outcomes carry their own). */
  observe(state: EngineState): string;
  carryOut(state: EngineState): CarryState;
  /** Unmodelled moves, abilities or items present in this battle (either side). Non-empty ⇒ proofs through it are unproven. */
  unmodelledIn(state: EngineState): string[];
  /**
   * Optional and cheap: each side's current HP by party index in the battle's own
   * party order (0 for a fainted Pokémon). For search ordering only: nothing proven may depend on it. An engine that
   * has it answers without restoring a state it made itself.
   */
  hpOf?(state: EngineState): { p1: number[]; p2: number[] };
  /**
   * Optional: `state` in the reference engine's format, for display paths that `restore` a state
   * (battleView, labeler, lineView): they call `engine.referenceState?.(s) ?? s` first. The reference engine omits it;
   * the native engine returns its toReference(state). Not for hot paths: it may cost a full conversion.
   */
  referenceState?(state: EngineState): EngineState;
}
