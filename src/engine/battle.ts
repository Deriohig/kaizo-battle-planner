// Battles in the `platkaizo` format: building one from the app's data, the choices each side has, snapshots and
// restores, the step that runs one decision, and what a gauntlet carries to the next fight.
//
// Party indices. `Choice.switch.index`, `CarryState` and the solver all use the original 0-based party position.
// Showdown reorders `side.pokemon` as Pokémon switch, so the engine maps through `side.team`, the sets in party order:
// a Pokémon's party index is the index of its set there, which is how Showdown's own `toJSON` records the order.
//
// Phases. After a step, the battle waits on a side, or is over:
// - a `move` request: `turnChoice` (both sides choose);
// - a `switch` request: `playerReplacement` when the player's active Pokémon fainted, which also covers both sides
//   replacing at once (the solver treats it as a death anyway); `playerMidTurnSwitch` for the player's U-turn
//   or Baton Pass; `enemyReplacement` when only the trainer's fainted; `enemyMidTurnSwitch` for the trainer's U-turn or
//   Baton Pass. Every side Showdown asks must choose in the step that follows;
// - the end: `terminal`, won by p1 only when the trainer has no Pokémon left and the player has (a tie is p2's).
// The player never gets a free switch after an enemy KO: Showdown asks only the side that lost its Pokémon.
//
// Chance. Every battle draws through a chance driver (chance.ts): `createBattle` makes its battle with one, and
// `restore` attaches one, so no draw ever reaches Showdown's stock generator. Without a script, each chance takes its
// first possible outcome, which is what `runFirstOutcome` (tests only) and the battle start get; `expandTurn`
// (expand.ts) enumerates them.
//
// Logs. A snapshot's JSON keeps only the log of the step that made it: `restore` starts the battle a new log and input
// log, so restores don't slow down as a battle goes on. Nothing in the simulation reads old log lines. Its wall-clock
// `|t:|<seconds>` lines are blanked to `|t:|` (`untimedLog`), so the JSON holds no time.

import PS from 'pokemon-showdown';
import type { BattleInput, CarryState, Choice, EngineState, Phase, Side } from '../contracts/engine.js';
import type { PlayerMon } from '../battle/playerMon.js';
import type { RomTrainer } from '../rom/trainers.js';
import { attachDriver, ChanceDriver, type ChancePoint, drivenPrng, isChance, nextScript } from './chance.js';
import { installedData, installedMoves, itemId, KAIZO_FORMAT, moveId } from './dex.js';
import { EXP_KEY } from './exp.js';
import { rememberRestored } from './facts.js';
import { FIELD_KEY } from './mod/field.js';
import { KNOCKED_OFF_KEY } from './mod/moves.js';
import { restoresStatus } from './mod/scripts.js';
import { putQuickClawRolls, takeQuickClawRolls } from './mod/speedOrder.js';
import { serializedState } from './key.js';
import { omniscientLog, recordReveals } from './observe.js';
import { lap, mark } from './profile.js';
import { applyPlayerStart, enemySets, playerSets, setMovePp, startStatusOf } from './sets.js';
import { checkTrainerItem, queueTrainerItem, setTrainerBag, type TrainerItemUse, usableBagItems } from './trainerItems.js';
import { EngineError } from './types.js';
import { addUnmodelledNote } from './unmodelled.js';

const { Battle } = PS;

// The readers of a state live in facts.ts, which answers them from what the engine kept when it built the state.
export { carryOut, legalChoices } from './facts.js';

type ShowdownSide = Battle['p1'];
type MoveSlot = Pokemon['moveSlots'][number];

/**
 * The note for a battle whose start can end in different states (equal-Speed leads whose switch-in effects' order
 * matters, say), which `createBattle`, one state, can't hold.
 */
export const BATTLE_START_CHANCE_NOTE = 'engine: a chance at battle start took its first outcome';

/** The most battle starts `createBattle` runs to see whether a start's chances matter; a start with more is noted. */
const MAX_START_LEAVES = 64;

const PLAYER_NAME = 'Player';

const SIDES = ['p1', 'p2'] as const;

/** `formatData` key: the trainer's identity (ROM index and raw AI mask), for the trainer-AI adapter (accessors.ts). */
export const TRAINER_KEY = 'kaizoTrainer';

/** `formatData` key: the battle-start protocol lines (omniscient), kept because `restore` trims the log. */
export const START_LOG_KEY = 'kaizoStartLog';

/** `formatData` key: the trainer's field spec (`BattleInput.field`), kept as given (the trainer-AI adapter reads it) and applied at the start (mod/field.ts). */
export { FIELD_KEY };

/**
 * Starts a battle: the player's party (lead first) against the trainer's (ROM order), each lead at party index 0. The
 * player's Pokémon get the save's HP, PP and status, then `carry`, then `startStatus`; a carry's EXP also sets the level
 * (with that level's stats), its moves the move list, and its item the held item (sets.ts `playerSets`,
 * `applyPlayerStart`). The trainer's are fresh, with no PP Ups. The trainer's bag comes from its ROM trainer (`RomTrainer.items`). `field` is kept in the state as given and
 * applied at the start, as the cartridge's map weather (mod/field.ts). Throws `UNSUPPORTED_DOUBLE` for a double
 * battle.
 *
 * A real chance before turn 1 (a speed tie between the leads' switch-ins, say) takes its first outcome. When every
 * outcome of the start's chances reaches that same state, nothing is lost; otherwise the battle records
 * `BATTLE_START_CHANCE_NOTE` as unmodelled, so a proof through it is unproven.
 *
 * The state's readers are kept beside it from one restore of it (facts.ts `rememberRestored`): the start's live battle
 * is not read, as its trainer's PP changed after its requests were made (`startBattle`).
 */
export function createBattle(input: BattleInput): EngineState {
  const { trainer } = input;
  if (trainer.battleType === 'double') {
    throw new EngineError('UNSUPPORTED_DOUBLE', `${trainer.name} (ROM trainer ${trainer.romIndex}) is a double battle; the engine runs singles only`);
  }
  if (input.player.length === 0 || trainer.party.length === 0) throw new RangeError('Both sides need at least one Pokémon');
  const first = startBattle(input, []);
  if (!first.points.some(isChance)) return rememberRestored(snapshot(withStartLog(first.battle)));
  // Run the start's other outcomes, depth first as `expandTurn` does, until one reaches another state. The states are
  // compared without the Quick Claw rolls the start drew (mod/speedOrder.ts; the cartridge's bl:2024): when every outcome
  // reaches one state whatever they were, that state says nothing about them, so they are dropped and turn 1's order
  // picks them afresh. The root is one state, so it can't hold a drawn roll otherwise.
  const rolls = takeQuickClawRolls(first.battle);
  const key = snapshot(first.battle).key;
  let same = true;
  let script = nextScript(first.points);
  for (let leaves = 1; script !== null && same; leaves++) {
    const leaf = startBattle(input, script);
    takeQuickClawRolls(leaf.battle);
    same = leaves < MAX_START_LEAVES && snapshot(leaf.battle).key === key;
    script = nextScript(leaf.points);
  }
  if (!same) {
    putQuickClawRolls(first.battle, rolls);
    addUnmodelledNote(first.battle, BATTLE_START_CHANCE_NOTE);
  }
  return rememberRestored(snapshot(withStartLog(first.battle)));
}

/**
 * Keeps `battle`'s log so far, the battle start's, in its state (`START_LOG_KEY`): a snapshot's log is trimmed on restore.
 * Done after `createBattle`'s check of the start's other outcomes, so the lines never decide whether they agree.
 */
function withStartLog(battle: Battle): Battle {
  battle.formatData[START_LOG_KEY] = omniscientLog(battle.log);
  return battle;
}

/** A battle of `input` from its start up to turn 1, its chances picked by `script`, and the chance points it met. */
function startBattle(input: BattleInput, script: number[]): { battle: Battle; points: readonly ChancePoint[] } {
  const driver = new ChanceDriver(script);
  const battle = new Battle({ formatid: KAIZO_FORMAT as ID, prng: drivenPrng(driver) });
  battle.setPlayer('p1', { name: PLAYER_NAME, team: playerSets(input.player, input.carry) });
  applyPlayerStart(battle.p1, input.player, input.carry, input.startStatus);
  if (input.carry !== undefined) notePickup(battle, input.player, input.carry);
  const rom = romTrainer(input.trainer.romIndex);
  setTrainerBag(battle, rom.items);
  battle.formatData[TRAINER_KEY] = { romIndex: input.trainer.romIndex, aiMask: rom.aiMask };
  battle.formatData[FIELD_KEY] = { ...input.field };
  battle.setPlayer('p2', { name: input.trainer.name, team: enemySets(input.trainer.party, input.world) }); // starts the battle
  // The trainer's PP is set after the start. Turn 1's requests came first, but no request is in the state: `restore`
  // makes them again.
  for (const pokemon of battle.p2.pokemon) setMovePp(pokemon, null, []);
  return { battle, points: driver.points };
}

/** `ABILITY_PICKUP` and `ABILITY_HONEY_GATHER` (generated/abilities.txt, line − 1). */
const PICKUP_ABILITIES: ReadonlySet<number> = new Set([53, 118]);

/** The note for a gauntlet fight whose carry gives a Pickup or Honey Gather Pokémon item 0, none, from the last fight. */
export const PICKUP_NOTE = 'engine: a carried Pokémon with Pickup or Honey Gather and no item could have found one after the last fight (battle_script.c:7781-7848)';

/**
 * After a won battle the cartridge may give each party Pokémon with Pickup or Honey Gather that holds no item a random
 * item (`BtlCmd_GenerateEndOfBattleItem`, bs:7781-7848: Pickup 1 in 10, from a table that includes King's Rock, White
 * Herb and Leftovers, :7797-7823; Honey Gather by level, :7825-7846). That happens between two fights of a gauntlet,
 * after the carry was read, so a fight whose carry says such a Pokémon ended the last fight holding nothing (`item` 0,
 * which `carryOut` always writes) records `PICKUP_NOTE`: a proof through it is unproven. A carry with no `item` for it
 * gives the save's item and no fight before (the solver's first fight): no note. The ability is
 * the save's (`PlayerMon.ability`), as the cartridge reads the party's (bs:7795).
 */
function notePickup(battle: Battle, player: PlayerMon[], carry: CarryState): void {
  const found = player.some((mon, index) => carry.mons[index]?.item === 0 && PICKUP_ABILITIES.has(mon.ability.value));
  if (found) addUnmodelledNote(battle, PICKUP_NOTE);
}

/** The installed data's ROM trainer with this index. */
function romTrainer(index: number): RomTrainer {
  const { trainers } = installedData().rom;
  const trainer = trainers[index]?.index === index ? trainers[index] : trainers.find((candidate) => candidate.index === index);
  if (trainer === undefined) throw new Error(`The ROM has no trainer ${index}`);
  return trainer;
}

/**
 * An immutable snapshot of `battle`, keyed by `stateKey` (key.ts). It first folds the battle's log, the lines since its
 * `restore` (or its start), into the enemy's reveals record (observe.ts), which is part of the state. Then it blanks
 * the log's wall-clock lines (`untimedLog`), so `json` is a pure function of the position and the step that made it.
 */
export function snapshot(battle: Battle): EngineState {
  const start = mark(); // opt-in leaf timing (profile.ts); 0 and no clock reads when off
  recordReveals(battle, battle.log);
  untimedLog(battle.log);
  const { json, key: keyOf } = serializedState(battle.toJSON()); // one serialisation (key.ts)
  const keyStart = lap('snapshot', start);
  const key = keyOf();
  lap('key', keyStart);
  return { json, turn: battle.turn, phase: phaseOf(battle), key };
}

/**
 * Blanks every `|t:|<seconds>` line of `log` to `|t:|`, in place, as Showdown's `State.normalizeLog` does. Showdown's
 * `turnLoop` writes the wall clock (`Date.now`) into the log on every step, and a snapshot's JSON keeps the step's log,
 * so without this the same position taken in two different seconds had different bytes (the checker memoises by them:
 * docs/solver-integration.md). Nothing reads those lines (observe.ts and `omniscientLog` drop them), the line count is
 * kept (`lastMoveLine` indexes the log), and the key leaves the log out (key.ts), so no key changes.
 */
function untimedLog(log: string[]): void {
  for (let i = 0; i < log.length; i++) {
    if (log[i]!.startsWith('|t:|') && log[i] !== '|t:|') log[i] = '|t:|';
  }
}

/**
 * The battle a snapshot holds, ready to take choices: `fromJSON`, a no-op `send`, `driver` drawing every chance
 * (default: one without a script, so each chance takes its first possible outcome), and an empty log and input log.
 */
export function restore(state: EngineState, driver: ChanceDriver = new ChanceDriver([])): Battle {
  return restoreParsed(JSON.parse(state.json) as SerializedBattle, driver);
}

/** A state's parsed JSON, deep-frozen, for `restoreShared`. */
export interface SharedState { readonly parsed: SerializedBattle }

type SerializedBattle = Record<string, unknown> & { sides: (Record<string, unknown> & { pokemon: Record<string, unknown>[] })[] };

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
}

/** `state`'s JSON parsed once and frozen, for every leaf of an expansion to restore from (`restoreShared`). */
export function sharedState(state: EngineState): SharedState {
  const parsed = JSON.parse(state.json) as SerializedBattle;
  deepFreeze(parsed);
  return { parsed };
}

/**
 * `restore` from a state parsed once (`sharedState`), without parsing its JSON again. Showdown's
 * `Battle.fromJSON` reads its input and copies what it keeps (sim/state.ts `deserializeBattle` and `deserialize`,
 * through `deserializeWithRefs`), except the log and each Pokémon's set, which it takes by reference
 * (`battle.log = state.log`; the sides' teams and `deserializePokemon`'s `pokemon.set = state.set`): those are fresh
 * copies here. The rest stays frozen, so anything that wrote to it would throw, never change another leaf's battle.
 */
export function restoreShared(shared: SharedState, driver: ChanceDriver): Battle {
  const { parsed } = shared;
  const input: SerializedBattle = {
    ...parsed, log: [],
    sides: parsed.sides.map((side) => ({ ...side, pokemon: side.pokemon.map((pokemon) => ({ ...pokemon, set: structuredClone(pokemon['set']) })) })),
  };
  return restoreParsed(input, driver);
}

function restoreParsed(parsed: SerializedBattle, driver: ChanceDriver): Battle {
  const battle = Battle.fromJSON(parsed);
  battle.restart(() => {});
  attachDriver(battle, driver);
  battle.log.length = 0; // both arrays are this battle's own (the log `parsed`'s, never a shared one; the input log a copy)
  battle.inputLog.length = 0;
  battle.sentLogPos = 0;
  battle.lastMoveLine = -1; // its old line is gone; `attrLastMove` then edits nothing until this step's next move line
  return battle;
}

/** Who must decide next in `battle` (see the top of this file). */
function phaseOf(battle: Battle): Phase {
  if (battle.ended) return { kind: 'terminal', winner: battle.p2.pokemonLeft === 0 && battle.p1.pokemonLeft > 0 ? 'p1' : 'p2' };
  if (battle.requestState === 'move') return { kind: 'turnChoice' };
  if (battle.requestState === 'switch') {
    const [mine, theirs] = [battle.p1.active[0], battle.p2.active[0]];
    if (mine?.switchFlag) return { kind: mine.fainted ? 'playerReplacement' : 'playerMidTurnSwitch' };
    if (theirs?.switchFlag) return { kind: theirs.fainted ? 'enemyReplacement' : 'enemyMidTurnSwitch' };
  }
  throw new Error(`The battle waits on no known decision (request state "${battle.requestState}")`);
}

/**
 * The party index of `pokemon`: the index of its set in `side.team`. Also the bit of the player's Pokémon in the EXP
 * participation mask (mod/exp.ts; the cartridge's `selectedPartySlot`, bs:2513).
 */
export function partyIndexOf(pokemon: Pokemon): number {
  const index = pokemon.side.team.indexOf(pokemon.set);
  if (index < 0) throw new Error(`${pokemon.fullname} has no set in its side's team`);
  return index;
}

/** Whether Showdown waits on `side` for a decision. */
function mustChoose(side: ShowdownSide): boolean {
  const request = side.activeRequest;
  return request !== null && !('wait' in request && request.wait);
}

/**
 * The choices side `id` has in `battle` (`legalChoices`, facts.ts, of the state `battle` holds); none when it has nothing
 * to decide.
 * - At a turn choice: each move in Showdown's request (its index there) with PP left and not disabled, so Struggle
 *   alone when nothing else is left and the locked move alone under Outrage, recharge, a Choice item or Encore; a
 *   switch to each living bench Pokémon unless the active one is trapped; for p2, one `item` choice per distinct
 *   modelled item left in the bag (`usableBagItems`).
 * - At a switch decision: a switch to each living bench Pokémon.
 * Moves come first, then switches by party index, then items in bag order.
 */
export function choicesIn(battle: Battle, id: Side): Choice[] {
  const side = battle[id];
  const request = side.activeRequest;
  if (battle.ended || request === null || !mustChoose(side)) return [];
  const bench: Choice[] = side.pokemon.filter((pokemon) => !pokemon.isActive && !pokemon.fainted && pokemon.hp > 0)
    .map(partyIndexOf).sort((a, b) => a - b).map((index) => ({ kind: 'switch', index }));
  if ('forceSwitch' in request) return bench;
  const active = side.active[0]!;
  const offered = 'active' in request ? request.active[0]?.moves ?? [] : [];
  const moves: Choice[] = offered.flatMap((entry, slot) => (entry.disabled || entry.pp === 0 ? [] : [{ kind: 'move', slot } as const]));
  const items: Choice[] = id === 'p2' ? usableBagItems(battle, active).map((item) => ({ kind: 'item', item })) : [];
  return [...moves, ...(active.trapped ? [] : bench), ...items];
}

const sameChoice = (a: Choice, b: Choice): boolean =>
  a.kind === b.kind && (a.kind === 'move' ? a.slot === (b as typeof a).slot : a.kind === 'switch' ? a.index === (b as typeof a).index : false);

/**
 * Applies `choices` to `battle`: one for each side Showdown waits on, and none for a side it doesn't. The decision runs
 * until a side must choose again or the battle ends. Throws `BAD_CHOICE` for a missing, extra or illegal choice and
 * `UNMODELLED_ITEM` for an item the engine does not model. It is atomic: every choice is checked, Showdown's included,
 * before anything changes, and a throw leaves `battle` as it was.
 */
export function applyChoices(battle: Battle, choices: { p1?: Choice; p2?: Choice }): void {
  if (battle.ended) throw new EngineError('BAD_CHOICE', 'The battle is over');
  let itemUse: TrainerItemUse | null = null;
  const texts: [Side, string][] = [];
  for (const id of SIDES) {
    const choice = choices[id];
    const needed = mustChoose(battle[id]);
    if (needed && choice === undefined) throw new EngineError('BAD_CHOICE', `${id} must choose`);
    if (!needed && choice !== undefined) throw new EngineError('BAD_CHOICE', `${id} has nothing to choose now`);
    if (choice === undefined) continue;
    if (choice.kind === 'item') {
      if (id !== 'p2') throw new EngineError('BAD_CHOICE', 'Only the trainer uses bag items');
      itemUse = checkTrainerItem(battle, choice);
    } else if (!choicesIn(battle, id).some((legal) => sameChoice(legal, choice))) {
      throw new EngineError('BAD_CHOICE', `${id} cannot choose ${JSON.stringify(choice)} now`);
    } else {
      texts.push([id, showdownChoice(battle[id], choice)]);
    }
  }
  // `Side.choose` checks a choice and records it without running anything; a refusal clears what was recorded.
  for (const [id, text] of texts) {
    const side = battle[id];
    if (!side.choose(text) || !side.isChoiceDone()) {
      const error = side.choice.error;
      for (const [recorded] of texts) battle[recorded].clearChoice();
      throw new EngineError('BAD_CHOICE', `Showdown refused ${id}'s "${text}": ${error}`);
    }
  }
  if (itemUse !== null) queueTrainerItem(battle, itemUse);
  battle.commitChoices();
}

/** Showdown's choice text: a move by its 1-based request index, a switch by the Pokémon's current 1-based position. */
function showdownChoice(side: ShowdownSide, choice: Exclude<Choice, { kind: 'item' }>): string {
  if (choice.kind === 'move') return `move ${choice.slot + 1}`;
  const position = side.pokemon.findIndex((pokemon) => partyIndexOf(pokemon) === choice.index);
  return `switch ${position + 1}`;
}

/**
 * For tests and tools only, not in the engine's public index: runs one decision from `state` (whichever the phase
 * requires; see `applyChoices`) down a single path, every chance taking its first possible outcome (a crit, the highest
 * damage roll, every secondary effect, a hit, the player first on a speed tie: mod/scripts.ts), with no note that
 * anything was left out. It is not a typical step and proves nothing: `expandTurn` runs every outcome with its
 * probability.
 */
export function runFirstOutcome(state: EngineState, choices: { p1?: Choice; p2?: Choice }): EngineState {
  const battle = restore(state);
  applyChoices(battle, choices);
  return snapshot(battle);
}

/** One Pokémon's carry as `carryIn` makes it: `item`, `exp` and `moves` are always given (the contract's `carryOut`). */
export type CarriedMon = Required<CarryState['mons'][number]>;

/**
 * What the player's party carries out of `battle` (`carryOut`, facts.ts, of the state `battle` holds), in party order:
 * - `hp`: its HP;
 * - `pp` and `moves`: the PP and the ROM move IDs (`romMoveId`) of its own moves in slot order, not Transform's or
 *   Mimic's copies, so a move a level-up taught into a free slot is there, `pp` lined up with `moves`;
 * - `status`: none once fainted, or for the Pokémon out when the player wins with Natural Cure or a party ability that
 *   forbids its status (`curedAtWin`); sleep with its counter, as `createBattle` reads it, or for a move's sleep, whose
 *   counter was never drawn, `UndrawnSleep` with the attempts spent asleep (`startStatusOf`);
 * - `item`: its held item (`carriedItem`);
 * - `exp`: its total EXP (`m.exp`, exp.ts), whose level is the one it ends the fight at (the payout keeps
 *   `growth[level] <= exp < growth[level + 1]`, mod/exp.ts), so the next fight starts it there (sets.ts `playerSets`).
 * `slotsOf` gives a Pokémon's own move slots: its `baseMoveSlots` (a restored battle's), or for a live battle facts.ts's
 * `restoredBaseSlots`, which may give null (no carry: this throws). Throws too for a Pokémon with no EXP, which only a
 * battle `createBattle` did not make can have.
 */
export function carryIn(battle: Battle, slotsOf: (pokemon: Pokemon) => readonly MoveSlot[] | null = (pokemon) => pokemon.baseMoveSlots): { mons: CarriedMon[] } {
  const party = [...battle.p1.pokemon].sort((a, b) => partyIndexOf(a) - partyIndexOf(b));
  const won = battle.ended && battle.p2.pokemonLeft === 0 && battle.p1.pokemonLeft > 0; // as `phaseOf`'s winner
  return {
    mons: party.map((pokemon) => {
      const slots = slotsOf(pokemon);
      if (slots === null) throw new Error(`${pokemon.name}'s move slots are not a restore's`);
      const status = won && curedAtWin(battle, pokemon) ? { kind: 'none' as const } : startStatusOf(pokemon);
      return {
        hp: pokemon.hp, pp: slots.map((slot) => slot.pp), status, item: carriedItem(pokemon), exp: carriedExp(pokemon),
        moves: slots.map((slot) => romMoveId(slot.id)),
      };
    }),
  };
}

/** `pokemon`'s total EXP (`m.exp`, set at `createBattle` and raised by each payout: exp.ts, mod/exp.ts). Throws when it has none. */
function carriedExp(pokemon: Pokemon): number {
  const exp = (pokemon.m as Record<string, unknown>)[EXP_KEY];
  if (typeof exp !== 'number') throw new Error(`${pokemon.name} has no EXP (m.${EXP_KEY}): only createBattle's player Pokémon carry one`);
  return exp;
}

/** Each installed dex's ROM move IDs by Showdown move ID. */
const romMoveIds = new WeakMap<object, Map<string, number>>();

/**
 * The ROM move ID of Showdown move `id` in the installed dex (`moveId`'s inverse: every hack move has a Showdown ID of
 * its own, ids.ts `showdownMoveNames`). Throws for an ID no installed move has.
 */
export function romMoveId(id: string): number {
  const moves = installedMoves();
  let byId = romMoveIds.get(moves);
  if (byId === undefined) {
    byId = new Map([...moves].map(([rom, move]) => [moveId(move), rom]));
    romMoveIds.set(moves, byId);
  }
  const rom = byId.get(id);
  if (rom === undefined) throw new Error(`No move of the installed Kaizo dex is the Showdown move "${id}"`);
  return rom;
}

/**
 * Whether the cartridge cures `pokemon` as the player wins. `subscript_battle_won.s:6-11` runs
 * `TryRestoreStatusOnSwitch` for each player battler, then sets its status to none, which `BtlCmd_UpdateMonData` copies
 * to the party (bs:3077-3078). The command passes for a battler with HP left whose battle ability is Natural Cure or
 * whose party ability forbids its status (mod/scripts.ts `restoresStatus`). Only the battler out: the script names
 * `BTLSCR_PLAYER_SLOT_1` and `_2`, never the bench. A lost or drawn fight runs subscript_battle_lost.s instead
 * (bcp:4015-4019, against bcp:4020-4023 for a win), which cures no one, and an unfinished one neither.
 */
function curedAtWin(battle: Battle, pokemon: Pokemon): boolean {
  return battle.p1.active[0] === pokemon && restoresStatus(pokemon);
}

/**
 * The ROM item ID `pokemon`'s party Pokémon holds once the fight is over, 0 for none (`CarryState.mons[].item`). The cartridge writes the battler's held item back to the party at every `BattleMon_CopyToParty`
 * (bl:1819-1826; `BattleController_EmitUpdatePartyMon`, battle_controller.c:1471-1472; `BtlIOCmd_UpdatePartyMon`,
 * battle_io_command.c:590-592), which every HP change and every item change runs (`BtlCmd_UpdateMonData`, bs:1720,
 * :3078, :3407; `BtlCmd_RemoveItem`, bs:8976-8981, for a berry eaten, a Focus Sash used up, a berry Bug Bite or Pluck
 * took). So the party keeps the item the battler holds at the end, except after Knock Off: `BtlCmd_TryKnockOff` empties
 * the battler's item and sets the slot's `knockedOffItemsMask` bit with no copy (bs:6624-6628), and from then on the
 * copy skips the item (battle_io_command.c:590), so the party keeps the item knocked off, which mod/moves.ts records
 * (`KNOCKED_OFF_KEY`). No hack move steals or swaps an item: the hack's Thief has Splash's effect, and the Covet, Trick
 * and Switcheroo slots (343, 271, 415) hold Hidden Power moves; the trainer's side could not anyway (bs:5101, :6346).
 */
function carriedItem(pokemon: Pokemon): number {
  const knockedOff = pokemon.m[KNOCKED_OFF_KEY] as string | undefined;
  const id = knockedOff ?? pokemon.item;
  return id === '' ? 0 : romItemId(id);
}

/** Each installed ROM's item IDs by Showdown ID, the lowest ID for a Showdown ID that several items share. */
const romItemIds = new WeakMap<object, Map<string, number>>();

/** The ROM item ID of Showdown item `id` in the installed data (`itemId`'s inverse). Throws for an item no ROM item names. */
export function romItemId(id: string): number {
  const { items } = installedData().rom;
  let byId = romItemIds.get(items);
  if (byId === undefined) {
    byId = new Map();
    for (let item = items.length - 1; item >= 1; item--) byId.set(itemId(item), item);
    romItemIds.set(items, byId);
  }
  const item = byId.get(id);
  if (item === undefined) throw new Error(`No ROM item is the Showdown item "${id}"`);
  return item;
}

/**
 * Each side's current HP in `battle` by party index, in the side's original party order (`side.team`): `hpOf`
 * (facts.ts) of the state `battle` holds. A fainted Pokémon has 0 (Showdown's `faint` sets it).
 */
export function hpIn(battle: Battle): { p1: number[]; p2: number[] } {
  const of = (side: ShowdownSide) => side.team.map((set) => {
    const pokemon = side.pokemon.find((candidate) => candidate.set === set);
    if (pokemon === undefined) throw new Error(`${side.id} has no Pokémon for a set of its team`);
    return pokemon.hp;
  });
  return { p1: of(battle.p1), p2: of(battle.p2) };
}
