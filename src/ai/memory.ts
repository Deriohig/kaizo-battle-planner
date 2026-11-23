// What the trainer AI remembers between turns, folded from the engine's Showdown-protocol log (Outcome.log). The
// cartridge keeps it in AIContext's battlerMoves, battlerAbilities and battlerHeldItems (ai_context.h) and in
// BattleContext's movePrevByBattler, moveHit and moveHitBattler. Each rule below cites the C that writes the value, and
// docs/ai-reads.md lists the log lines that can't show a cartridge event exactly.
//
// Only the player's battler (slot 0) gets ability and item reveals: in singles, no AI read consults the knowledge of
// its own battler, which every opcode reads as real data (trainer_ai.c:1179, 1638, 1908, 1925). Slots 1–3 stay empty,
// so they never split the key.
//
// Quick Claw is not remembered. The AI reads the draw that orders this turn, which this turn's log shows only
// after the AI has decided; docs/ai-reads.md has the timing.

import { ABILITY_NONE, ITEM_NONE, MOVE_DEFOG, MOVE_HAIL, MOVE_IMPRISON, MOVE_NATURAL_GIFT, MOVE_NONE, MOVE_RECYCLE } from './constants.js';
import { AiError } from './errors.js';
import { REPLACEMENT_PATHS } from './lib/known.js';
import { AI_BATTLER, type AiKnowledge, type AiView, PLAYER_BATTLER } from './view.js';

/**
 * BattleContext.recycleItem for one battler where Showdown's `lastItem` doesn't give it: a ROM item ID, null
 * when `lastItem` gives it, or 'unknown' when the log can't settle it.
 */
export type RecycleOverride = number | null | 'unknown';

export interface AiMemoryData {
  /** battlerMoves, battlerAbilities and battlerHeldItems as the cartridge keeps them (ai_context.h). */
  knowledge: AiKnowledge;
  /** movePrevByBattler for battlers 0 and 1, as of the end of the last step. */
  lastMoveBy: [number, number];
  /** moveHit and moveHitBattler for the AI's battler; null when moveHit is MOVE_NONE. */
  lastHitBy: { move: number; battler: number } | null;
  /**
   * recycleItem for battlers 0 and 1 where Showdown's lastItem differs (rememberStep's recycleAfter): a berry Bug Bite
   * or Pluck ate, which the cartridge keeps in its victim's slot. Per battler slot, as recycleItem is.
   */
  recycleOverride: [RecycleOverride, RecycleOverride];
  /**
   * The moves of the AI's action that switches it out mid-turn (U-turn, Baton Pass): the ROM IDs of its `|move|` lines
   * in order, a caller's (Metronome, Sleep Talk…) and any move called or reflected in that action included, when the step
   * ended at that switch (StepEnd.phase 'enemyMidTurnSwitch'); null when such a step shows no AI move; [] after any other
   * step. The switch runs inside that action, before its MoveEnd resets battleStatusMask and powerMul (battleScripts.ts).
   */
  switchAction: number[] | null;
  /**
   * The AI battler's BattleMon fields that the log shows changed since its switch-in and that a faint keeps on the
   * cartridge (BattleSystem_CleanupFaintedMon, battle_lib.c:2156–2210, leaves species, types, ability and stats) while
   * Showdown's faint resets them (clearVolatile): view paths (REPLACEMENT_PATHS.field), sorted. The adapter lists them
   * while the battler is fainted, at its replacement. An ability a Trace set is not one of them: it is aiTraced.
   */
  aiKept: string[];
  /**
   * The ability a Trace gave the AI's battler since its switch-in, as a ROM ID, while no other change of its ability has
   * come since; absent otherwise (absent, not null, so that a memory without one keys as it did before the field).
   * subscript_trace.s:6–7 copies the traced battler's ability into the tracer's BattleMon, and Showdown's Gen 4 Trace
   * takes the same foe's, which its `-ability` line names (setAbility). A faint keeps it (BattleSystem_CleanupFaintedMon,
   * battle_lib.c:2156–2210, leaves `ability`) where Showdown's faint resets the ability to the base one (clearVolatile),
   * and the post-KO pick reads it as the fainted attacker's (stage 2, battle_lib.c:8054–8063). So the adapter gives it
   * at the replacement, instead of listing `ability` (aiKept). Any other change of the battler's ability (Skill Swap,
   * Role Play, Worry Seed, Transform, a form change) drops it, and aiKept lists `ability` again.
   */
  aiTraced?: number;
  /**
   * The coming turn's fact for "TrainerAI_Main ran" (final fix wave, item 3): whether Fight at its command selection
   * runs the move menu ('menu', so TrainerAI_Main) or the battle plays a move it forces ('forced': Battler_CanPickCommand
   * FALSE, Struggle or an Encore lock; battle_controller_player.c:334, 433, 443). Set by model.ts from the turn-choice
   * state a step ends at (fightKind, the classification `support` uses); 'unknown' when that state's view can't be built
   * (AiError). The turn's first step uses it up (null), so a turn that spans several steps records once.
   */
  turnFight: TurnFight | null;
  /**
   * The player's known moves (battlerMoves[0]) are unsettled: a turn whose fact was 'unknown' saw the AI choose Fight,
   * and the record would have changed them. The adapter lists PATHS.knownMoves(0), which their readers guard, until the
   * player's battler is replaced and the record is cleared.
   */
  playerMovesUnknown: boolean;
  /**
   * MOVE_EFFECT_IMPRISONED (moves.h:38) in battleMons[b].moveEffectsMask for battlers 0 and 1, which Showdown doesn't
   * keep (it keeps only the user's 'imprison' volatile). BtlCmd_TryImprison, the first command of Imprison's effect
   * script (effect_script_0192.s), sets it on the user's foe before it checks that Imprison works
   * (battle_script.c:6686–6690; in singles both slots it marks are attacker ^ 1, battle_system.c:419–421), so a failed
   * Imprison marks the foe too. Only a new BattleMon clears it: a switch-in (battle_lib.c:2071; Baton Pass keeps
   * MOVE_EFFECT_BATON_PASSED, moves.h:46–48, which lacks it, battle_lib.c:2076) or a faint (battle_lib.c:2166). The
   * imprisoner leaving doesn't. rememberStep's `move` case says which lines set it. Spot check 15.
   */
  imprisonedMark: [boolean, boolean];
  /**
   * The weather whose _PERM bit the cartridge's fieldConditionsMask holds, null for none. A weather ability's
   * switch-in runs its subscript, whose message reveals it (subscript_drizzle.s:8, TAG_NICKNAME_ABILITY of
   * BTLSCR_MSG_BATTLER_TEMP), only while its own _PERM bit is clear (battle_lib.c:3746–3782); the subscript then clears
   * every weather bit and sets that one (subscript_drizzle.s:11–12 and its kin). The battle start sets the field note's
   * (subscript_overworld_rain.s:11 and its kin), so it starts as the note's (initialMemoryData). Nothing ends a _PERM
   * weather: the turn end counts down only a _TEMP one (battle_controller_player.c:1113–1128 and its kin), and a
   * weather's end clears its _TEMP bit alone (subscript_raining_end.s:5 and its kin). Only another weather replaces it:
   * a weather ability's, or a weather move's, which fails into its own weather (effect_script_0136.s:5 and its kin)
   * except Hail, which tests only HAILING_TEMP (effect_script_0164.s:5). rememberStep's `-weather` and `move` cases keep
   * it. The engine starts the note's weather itself, as the plain `-weather` line of battle start, so it
   * announces such an ability only when the note's isn't its own, as the cartridge does; the fold keeps the note's _PERM weather.
   */
  permWeather: PermWeather | null;
  /**
   * What has happened to the trainer's field note's deep fog (FIELD_CONDITION_DEEP_FOG), which the note sets at battle start
   * (subscript_overworld_fog.s:11) and which lives in the same mask as the weather: 'standing' while nothing has touched it,
   * 'cleared' once a weather replaced it, 'unknown' after a Defog the log can't settle. The bit is part of
   * FIELD_CONDITION_WEATHER (condition.h:132–137), so every subscript that sets a weather clears it first
   * (`UpdateVar FLAG_OFF FIELD_CONDITION_WEATHER`: subscript_drizzle.s:11 and its kin for the abilities,
   * effect_script_0115.s:8, _0136, _0137 and _0164.s:8 for Rain Dance, Sunny Day, Sandstorm and Hail), and Defog clears it
   * (subscript_defog.s:64–65), after a branch that depends on its target's evasion and side. Nothing else ends it; a
   * weather's end clears only its own _TEMP bit (subscript_raining_end.s:5 and its kin). It matters only for a note of fog
   * (the view's fog is the note's fog while 'standing'); rememberStep's `-weather` and `move` cases keep it. Spot check 20.
   */
  fog: FogFate;
}

/** What has happened to the note's deep fog (AiMemoryData.fog). */
export type FogFate = 'standing' | 'cleared' | 'unknown';

/** A weather the cartridge can hold as a _PERM bit: rain, sun, sand or hail (constants/battle/condition.h). */
export type PermWeather = 'rain' | 'sun' | 'sand' | 'hail';

/** Showdown's weather IDs in `-weather` lines, as PermWeather; 'none' is the weather's end. */
const SHOWDOWN_WEATHERS: Readonly<Record<string, PermWeather | null>> = {
  RainDance: 'rain', SunnyDay: 'sun', Sandstorm: 'sand', Hail: 'hail', none: null,
};

/** turnFight: whether Fight runs TrainerAI_Main this turn. */
export type TurnFight = 'menu' | 'forced' | 'unknown';

/** How a step ended, for the memory: the phase its state waits on (EngineState.phase.kind). */
export interface StepEnd { phase?: string }

/**
 * View fields Transform copies into the BattleMon (battle_script.c:5346–5348: the BattleMon up to `ability`) that the
 * adapter lists unguarded, so the replacement is refused. Transform copies the weight too, but its path is the guarded
 * PATHS.weight, whose readers (Low Kick and Grass Knot) read the defender's, never the fainted attacker's: listing it
 * would refuse nothing, and the fields above refuse the replacement already.
 */
const TRANSFORM_FIELDS = [
  'species', 'form', 'types', 'ability', 'attack', 'defense', 'speed', 'spAttack', 'spDefense', 'moves',
];
/** View fields a form change sets (BattleSystem's form change recalculates the BattleMon's stats and types). */
const FORM_FIELDS = ['form', 'types', 'ability', 'attack', 'defense', 'speed', 'spAttack', 'spDefense'];

/**
 * Showdown names → ROM IDs (the engine adapter supplies them). Each lookup must throw on a name it doesn't know, never guess an ID;
 * rememberStep doesn't catch it, so an unknown move, ability or item in the log fails the whole step.
 */
export interface ProtocolIds { move(name: string): number; ability(name: string): number; item(name: string): number }

/**
 * Battle start: AIContext is cleared (battle_controller_player.c:4799), and moveHitBattler is BATTLER_NONE (battle_lib.c:2022).
 * `noteWeather` is the trainer's field note's weather, whose _PERM bit the battle start sets (permWeather).
 */
export function initialMemoryData(noteWeather: PermWeather | null): AiMemoryData {
  return {
    knowledge: {
      battlerMoves: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
      battlerAbilities: [0, 0, 0, 0],
      battlerHeldItems: [0, 0, 0, 0],
    },
    lastMoveBy: [MOVE_NONE, MOVE_NONE],
    lastHitBy: null,
    // recycleItem is cleared with the context (battle_controller_player.c:182), as Showdown's lastItem starts empty.
    recycleOverride: [null, null],
    switchAction: [],
    aiKept: [],
    turnFight: null,
    playerMovesUnknown: false,
    // The battle start clears the context, the BattleMons with it (BattleContext_New, battle_controller_player.c:182),
    // and nobody has moved yet.
    imprisonedMark: [false, false],
    permWeather: noteWeather,
    // The note's fog, if it has one, stands at the battle start (subscript_overworld_fog.s:11).
    fog: 'standing',
  };
}

/**
 * Canonical JSON: object keys sorted at every level, arrays in order. Each battler's known moves are keyed as a set:
 * the non-zero ones ascending, zeros last. Every reader scans all four slots (trainer_ai.c:1668, 1724, 1765, 1807), and
 * recordLastMove adds the same move whatever the order (trainer_ai.c:2705), so the order never changes what the AI does.
 * The data itself keeps the order the moves were seen in.
 */
export function memoryKey(m: AiMemoryData): string {
  const knowledge = { ...m.knowledge, battlerMoves: m.knowledge.battlerMoves.map(movesAsSet) };
  return canonicalJson({ ...m, knowledge })!;
}

function movesAsSet(moves: number[]): number[] {
  const known = moves.filter((move) => move !== MOVE_NONE).sort((a, b) => a - b);
  return [...known, ...Array<number>(moves.length - known.length).fill(MOVE_NONE)];
}

/**
 * JSON.stringify of `value` with every object's keys sorted, written in one pass (the key was JSON.stringify of a
 * key-sorted copy, which cost a copy of every object). The same text: arrays write undefined (and functions) as null, objects
 * leave such keys out, keys come in the copy's order (keyOrder), and anything else is JSON.stringify's. The memory has no
 * toJSON.
 */
function canonicalJson(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item) ?? 'null').join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of keyOrder(record)) {
      const text = canonicalJson(record[key]);
      if (text !== undefined) parts.push(`${JSON.stringify(key)}:${text}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The largest array index (ECMAScript: a canonical integer below 2^32 − 1). */
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

/** Whether `key` is an array index, which an object's own keys list first, in ascending numeric order. */
function isArrayIndex(key: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(key) && Number(key) <= MAX_ARRAY_INDEX;
}

/**
 * `record`'s keys in the order the key-sorted copy (`Object.fromEntries` of the sorted keys) listed them: its array-index
 * keys first, in ascending numeric order, as every object's own keys list them, then the rest sorted (a plain sort would put "10" before "2"). Object.keys gives the array indexes first already, in that order.
 */
function keyOrder(record: Record<string, unknown>): string[] {
  const keys = Object.keys(record);
  let indexes = 0;
  while (indexes < keys.length && isArrayIndex(keys[indexes]!)) indexes++;
  if (indexes === 0) return keys.sort();
  return [...keys.slice(0, indexes), ...keys.slice(indexes).sort()];
}

/** TrainerAI_RecordLastMove (trainer_ai.c:2705), on a copy: the defender's last move goes into its first empty slot. */
export function recordLastMove(k: AiKnowledge, v: AiView, defender: number): AiKnowledge {
  return recordMove(k, defender, v.movePrevByBattler[defender] ?? MOVE_NONE);
}

function recordMove(k: AiKnowledge, defender: number, movePrev: number): AiKnowledge {
  const out = copyKnowledge(k);
  const known = out.battlerMoves[defender];
  if (known === undefined) throw new AiError('BAD_VIEW', `no battler slot ${defender}`);
  for (let i = 0; i < 4; i++) {
    if (known[i] === movePrev) break; // trainer_ai.c:2708
    if (known[i] === MOVE_NONE) { // trainer_ai.c:2712
      known[i] = movePrev;
      break;
    }
  }
  return out;
}

function copyKnowledge(k: AiKnowledge): AiKnowledge {
  return {
    battlerMoves: k.battlerMoves.map((moves) => [...moves]),
    battlerAbilities: [...k.battlerAbilities],
    battlerHeldItems: [...k.battlerHeldItems],
  };
}

/** One protocol line, `|cmd|arg|arg|[tag] value|…`: the arguments in order, and the `[tag]`s by name. */
interface Line { cmd: string; args: string[]; tags: Map<string, string> }

function parseLine(text: string): Line | null {
  if (!text.startsWith('|')) return null;
  const [cmd = '', ...parts] = text.slice(1).split('|');
  const args: string[] = [];
  const tags = new Map<string, string>();
  for (const part of parts) {
    const tag = /^\[(\w+)\]\s*(.*)$/.exec(part);
    if (tag) tags.set(tag[1] ?? '', tag[2] ?? '');
    else args.push(part);
  }
  return { cmd, args, tags };
}

/** Argument `i`: 0 is the line's own Pokémon, 1 its move, ability, item or reason, 2 a move's target. */
function arg(line: Line, i: number): string {
  return line.args[i] ?? '';
}

/** `p1a: Luxray` → 0, `p2a: Garchomp` → 1; anything else (a weather name, an empty target) → null. */
function battlerOf(ident: string | undefined): number | null {
  const match = /^p([12])a(?::|$)/.exec(ident ?? '');
  if (!match) return null;
  return match[1] === '1' ? PLAYER_BATTLER : AI_BATTLER;
}

/** `ability: Levitate` → { kind: 'ability', name: 'Levitate' }; `lockedmove` → { kind: 'lockedmove', name: '' }. */
function effectOf(text = ''): { kind: string; name: string } {
  const at = text.indexOf(': ');
  return at < 0 ? { kind: text, name: '' } : { kind: text.slice(0, at), name: text.slice(at + 2) };
}

/**
 * A `|move|` line's `[from]` other than `lockedmove`: a move another effect called (Metronome, Sleep Talk, Magic
 * Coat…), or a Pursuit at a switching Pokémon (isSwitchPursuit), which runs inside the switcher's action too.
 */
function isCalled(line: Line): boolean {
  const from = line.tags.get('from');
  return from !== undefined && from !== 'lockedmove';
}

/**
 * A Pursuit at a switching Pokémon: Showdown's Gen 4 onFoeBeforeSwitchOut runs it through useMove as `[from] Pursuit`.
 * On the cartridge TryPursuit runs the pursuer's chosen move inside the switcher's action (subscript_pursuit.s, called
 * from subscript_switch_pokemon.s:11 and subscript_attack_then_switch_out.s:54) and sets movePrevByBattler[pursuer] to it
 * (battle_script.c:6930): it is the pursuer's own move, not a called one. The script path never reaches
 * UpdateFlagsWhenHit (battle_controller_player.c:4477, from UpdateMoveBuffers, :3956), so its hit sets no moveHit, and
 * the action whose ClearFlags runs (:4389) is the switcher's: the subscript restores its attacker (push and pop), and
 * the pursuer's own action, marked done (battle_script.c:6931), runs MoveEnd with that same attacker
 * (BattleControllerPlayer_BranchActions, battle_controller_player.c:893). So the pursuer's moveHit isn't cleared.
 */
function isSwitchPursuit(line: Line): boolean {
  return line.tags.get('from') === 'Pursuit';
}

/** An `-ability` line of Trace taking an ability: `|-ability|<tracer>|<ability>|Trace|[from] ability: Trace|[of] <traced>`. */
function isTrace(line: Line): boolean {
  const from = effectOf(line.tags.get('from'));
  return from.kind === 'ability' && from.name === 'Trace';
}

/**
 * Showdown's line for an ability's stat change, `|-ability|<holder>|<ability>|boost` (sim/battle.ts boost): Intimidate
 * and Download at a switch-in, Speed Boost and Steadfast mid-battle. On the cartridge each runs
 * subscript_update_stat_stage as an ability's change (subscript_intimidate.s:15–17, battle_lib.c:3846–3852, :3555–3563,
 * subscript_flinched.s:10–14), whose message BtlCmd_ChangeStatStage buffers (battle_script.c:2853–2854, 2955–2961), so
 * PrintBufferedMessage sends it without BattleMessage_AbilityTag (:1505–1510): nothing is recorded. Motor Drive is the
 * exception: its subscript prints its own message, tagging the holder's ability (BTLSCR_DEFENDER,
 * subscript_absorb_and_speed_up_1_stage.s:14), so its line reveals.
 */
function isStatAbilityMessage(line: Line): boolean {
  return arg(line, 2) === 'boost' && arg(line, 1) !== 'Motor Drive';
}

/** `|-fail|<target>|unboost|…|[from] ability: X`: an ability blocking a stat drop (Clear Body, Hyper Cutter…). */
function isBlockedStatDrop(line: Line): boolean {
  return line.cmd === '-fail' && arg(line, 1) === 'unboost';
}

/** A line of Frisk's find: Showdown's Gen 4 `|-item|<target or empty>|<item>|[from] ability: Frisk|[of] <frisker>`. */
function isFrisk(line: Line): boolean {
  const from = effectOf(line.tags.get('from'));
  return line.cmd === '-item' && from.kind === 'ability' && from.name === 'Frisk';
}

/** The abilities BattleSystem_RecoverStatusByAbility cures with (battle_lib.c:4382–4431), by Showdown name. */
const STATUS_CURE_ABILITIES: ReadonlySet<string> = new Set([
  'Immunity', 'Own Tempo', 'Limber', 'Insomnia', 'Vital Spirit', 'Water Veil', 'Magma Armor', 'Oblivious',
]);

/** Whether `|cant|` is Focus Punch losing its focus (Showdown names the move as the reason). */
function isLostFocus(line: Line): boolean {
  return arg(line, 1) === 'Focus Punch' || effectOf(arg(line, 1)).name === 'Focus Punch';
}

/**
 * Whether the AI chose Fight at this turn's command selection, from the turn's first step. A switch or a bag item is an
 * action of its own, which the battle runs before every move (battle_controller_player.c:698–780, the turn order): the
 * AI's `|switch|` line, or its item line (`|-activate|p2a…|item: X|[trainer]`, engine/trainerItems.ts). One thing can
 * come before the AI's switch line: a Pursuit at it, which Showdown runs at the switch as `|move|p1a…|Pursuit|p2a…|[from]
 * Pursuit` (a plain Pursuit has no `[from]`), and which may knock it out before the switch line. Any AI move line, `|cant|`
 * or confusion self-hit first is a Fight. A step with none of these is a Fight too: the AI's battler fainted before it
 * acted, or the battle ended, after TrainerAI_Main had already run.
 */
function aiChoseFight(lines: Line[]): boolean {
  for (const line of lines) {
    const battler = battlerOf(arg(line, 0));
    if (battler === PLAYER_BATTLER && line.cmd === 'move' && line.tags.get('from') === 'Pursuit'
      && battlerOf(arg(line, 2)) === AI_BATTLER) return false;
    if (battler !== AI_BATTLER) continue;
    if (line.cmd === 'switch' || (line.cmd === '-activate' && line.tags.has('trainer'))) return false;
    if (line.cmd === 'move' || (line.cmd === 'cant' && !line.tags.has('of'))) return true;
    if (line.cmd === '-damage' && line.tags.get('from') === 'confusion') return true;
  }
  return true;
}

/** Whether recording `move` for `defender` changes `k` (recordMove: not 0, not known yet, a free slot). */
function recordChanges(k: AiKnowledge, defender: number, move: number): boolean {
  return JSON.stringify(recordMove(k, defender, move)) !== JSON.stringify(k);
}

/**
 * Folds one engine step into the memory. Pure: `m` and `log` are not changed.
 * - TrainerAI_MainSingles records the player's last move first (trainer_ai.c:295), at command selection, so the record
 *   uses `lastMoveBy[0]` from before the step and comes before the step's own events. It runs when the AI chose Fight
 *   and the battle didn't force its move (`m.turnFight`, a fact of the turn-choice state, model.ts fightKind): so only
 *   in a turn's first step, the one that starts at the turn choice. A later step of the same turn (after a mid-turn
 *   switch or a replacement) finds the fact used up. With the fact 'unknown', a Fight whose record would change the
 *   known moves leaves them unsettled (playerMovesUnknown) instead of guessing.
 * - The lines then update the last moves, the last hit and the reveals in order.
 */
export function rememberStep(m: AiMemoryData, log: string[], ids: ProtocolIds, end: StepEnd = {}): AiMemoryData {
  const lines = log.map(parseLine).filter((line): line is Line => line !== null);
  let knowledge = copyKnowledge(m.knowledge);
  const lastMoveBy: [number, number] = [m.lastMoveBy[0], m.lastMoveBy[1]];
  let lastHitBy = m.lastHitBy === null ? null : { ...m.lastHitBy };
  const recycle: [RecycleOverride, RecycleOverride] = [m.recycleOverride[0], m.recycleOverride[1]];
  /** The `|move|` lines of the AI's latest action in this step, while no other battler's action has followed it. */
  let aiAction: number[] | null = null;
  const kept = new Set(m.aiKept);
  let aiTraced = m.aiTraced;
  const keep = (fields: readonly string[]): void => {
    for (const field of fields) kept.add(REPLACEMENT_PATHS.field(AI_BATTLER, field));
    if (fields.includes('ability')) aiTraced = undefined; // another change of the ability replaced the traced one
  };

  const imprisoned: [boolean, boolean] = [m.imprisonedMark[0], m.imprisonedMark[1]];
  let permWeather = m.permWeather;
  let fog = m.fog;
  let playerMovesUnknown = m.playerMovesUnknown;
  if (m.turnFight !== null && m.turnFight !== 'forced' && aiChoseFight(lines)) {
    const movePrev = m.lastMoveBy[PLAYER_BATTLER];
    if (m.turnFight === 'menu') knowledge = recordMove(knowledge, PLAYER_BATTLER, movePrev);
    else if (recordChanges(knowledge, PLAYER_BATTLER, movePrev)) playerMovesUnknown = true;
  }

  /** lastHitBy before the player's latest move line, to undo a move the AI's Magic Coat bounces. */
  let hitBeforePlayerMove = lastHitBy;
  /** The player's item was used up in this step: a later line that names it doesn't bring it back. */
  let playerItemGone = false;

  const clearBattler = (battler: number): void => {
    // battle_lib.c:2151–2153 (switch-in) and 2223–2225 (faint).
    knowledge.battlerMoves[battler] = [0, 0, 0, 0];
    knowledge.battlerAbilities[battler] = ABILITY_NONE;
    knowledge.battlerHeldItems[battler] = ITEM_NONE;
    lastMoveBy[battler] = MOVE_NONE; // battle_lib.c:2124, 2202
    // The new BattleMon's moveEffectsMask: 0 at a switch-in (battle_lib.c:2071), or MOVE_EFFECT_BATON_PASSED's bits
    // after a Baton Pass (:2076; moves.h:46–48 has no MOVE_EFFECT_IMPRISONED); 0 at a faint (:2166). Only the battler's
    // own: the imprisoner leaving keeps its foe's mark.
    imprisoned[battler] = false;
    // moveHit and moveHitBattler of the battler itself: battle_lib.c:2121–2122, 2199–2200.
    if (battler === AI_BATTLER) lastHitBy = null;
    else {
      playerItemGone = false;
      playerMovesUnknown = false; // the cleared record is known again
    }
  };

  for (const line of lines) {
    const battler = battlerOf(arg(line, 0));
    /** A line whose `[from]` reveal the cartridge never prints (a weather ability into its own _PERM weather). */
    let silent = false;
    switch (line.cmd) {
      case 'move': {
        if (battler === null) break;
        const move = ids.move(arg(line, 1));
        const called = isCalled(line);
        const noTarget = line.tags.has('notarget');
        // An uncalled move starts its user's action; a called or reflected one runs inside the current action.
        if (!called) aiAction = battler === AI_BATTLER ? [move] : null;
        else aiAction?.push(move);
        // movePrevByBattler is the move chosen (moveTemp), so a called move leaves its caller. A move that ran sets it,
        // hit or miss: SYSCTL_MOVE_SUCCEEDED means it got past the pre-move checks (battle_controller_player.c:3212,
        // 3945). With no target it never got there (battle_controller_player.c:2311–2313, then 3948). A Pursuit at a
        // switcher sets it outright, before its hit (TryPursuit, battle_script.c:6930).
        const pursuit = isSwitchPursuit(line);
        if (pursuit) lastMoveBy[battler] = move;
        else if (!called) lastMoveBy[battler] = noTarget ? MOVE_NONE : move;
        // The AI's action ends in BattleControllerPlayer_ClearFlags, which clears its own moveHit
        // (battle_controller_player.c:4389). Not a Pursuit at a switcher: that runs in the switcher's action
        // (isSwitchPursuit).
        if (battler === AI_BATTLER && !called) lastHitBy = null;
        // A bounced move doesn't set moveHit: Magic Coat sets SYSCTL_REUSE_LAST_MOVE (battle_controller_player.c:3073–3077),
        // and UpdateFlagsWhenHit skips moveHit under it (battle_controller_player.c:4498).
        if (battler === AI_BATTLER && line.tags.get('from') === 'move: Magic Coat') lastHitBy = hitBeforePlayerMove;
        // A player move aimed at the AI whose "used" message showed sets moveHit to the move that ran (moveCur, so the
        // called move), whether it hit or not (battle_controller_player.c:4498–4502). A Pursuit at the switching AI
        // doesn't: it never reaches UpdateFlagsWhenHit (isSwitchPursuit).
        if (battler === PLAYER_BATTLER && !noTarget && !pursuit && battlerOf(arg(line, 2)) === AI_BATTLER
          && line.tags.get('from') !== 'move: Magic Coat') {
          hitBeforePlayerMove = lastHitBy;
          lastHitBy = { move, battler: PLAYER_BATTLER };
        }
        // Called or not, Recycle and Natural Gift change the slot's recycleItem in ways the log can't settle while it
        // differs from lastItem (recycleAfterEndItem).
        if (recycle[battler] !== null && (move === MOVE_RECYCLE || move === MOVE_NATURAL_GIFT)) recycle[battler] = 'unknown';
        // Imprison marks its user's foe (imprisonedMark), hit or fail, wherever its script runs. A `|move|` line is a
        // move past the before-move checks (status, obedience, PP, target, Snatch; battle_controller_player.c:3137–3210),
        // after which the battle runs its move script (:3214), whose GoToEffectScript (battle_script.c:2080–2087) reaches
        // effect_script_0192.s, and TryImprison is its first command (battle_script.c:6686–6690). A move those checks
        // stop shows `|cant|` (no PP: `|cant|…|nopp`) or a confusion self-hit, and runs no script. A called Imprison
        // (Metronome, Sleep Talk, Assist, Copycat) runs the same script from its caller's GoToMoveScript
        // (battle_script.c:2111–2130), with its caller as the attacker. With no target the script never runs
        // (:2126–2128, battle_controller_player.c:2311–2313), though a RANGE_USER move always targets its user
        // (battle_lib.c:1665–1669), so Imprison never shows `[notarget]`. Neither side lets Snatch or Magic Coat take it,
        // and move 286 is the one move whose effect runs TryImprison in either ROM (test/real/aiImprison.test.ts). In
        // singles, the foe is the other battler.
        if (move === MOVE_IMPRISON && !noTarget) imprisoned[battler === PLAYER_BATTLER ? AI_BATTLER : PLAYER_BATTLER] = true;
        // Hail tests only HAILING_TEMP (effect_script_0164.s:5), so it runs into a _PERM weather, its own too, and clears
        // every weather bit for HAILING_TEMP (:8–9). A _TEMP hail fails it, with no _PERM bit to clear. The engine's
        // Hail fails into its own hail, with no `-weather` line, so the move's line counts; a called Hail runs the same
        // script (GoToMoveScript, battle_script.c:2111–2130). Move 258 is the one move with that effect in either ROM, and
        // the hack's script is vanilla's (test/real/aiWeather.test.ts).
        if (move === MOVE_HAIL && !noTarget) {
          permWeather = null;
          fog = 'cleared'; // the same script clears the fog with the weather bits (effect_script_0164.s:8)
        }
        // Defog's script clears the fog (subscript_defog.s:64–65) when its earlier checks reach it, which depend on the
        // target's evasion and side conditions: not settled here, so a standing fog is unknown until a weather clears it.
        if (move === MOVE_DEFOG && !noTarget && fog === 'standing') fog = 'unknown';
        break;
      }
      case 'cant': {
        // Damp names its holder with the user in [of]; the user's move already ran and its |move| line counted.
        if (battler === null || line.tags.has('of')) break;
        aiAction = battler === AI_BATTLER ? [] : null; // an action that ran no move
        if (isLostFocus(line)) {
          // Focus Punch ran (battle_controller_player.c:3212) and failed in its script after printing the "used"
          // message (subscript_missed.s), so it counts as the last move, and as a hit on its target.
          const focusPunch = ids.move('Focus Punch');
          lastMoveBy[battler] = focusPunch;
          lastHitBy = battler === AI_BATTLER ? null : { move: focusPunch, battler: PLAYER_BATTLER };
          break;
        }
        // A Pokémon that can't move takes the status-disruption path to UPDATE_MOVE_BUFFERS without
        // SYSCTL_MOVE_SUCCEEDED (battle_controller_player.c:2430–2711, 3317–3319), which resets movePrevByBattler to 0
        // (battle_controller_player.c:3948).
        lastMoveBy[battler] = MOVE_NONE;
        // The AI's turn ends in ClearFlags (battle_controller_player.c:4389). The player's failed attempt clears the
        // moveHit of its target (battle_controller_player.c:4504–4506), taken to be the AI. For a self-targeting move the
        // target is the player (battle_lib.c:1665–1669), but the AI's own action that turn leaves moveHit[1] clear anyway.
        lastHitBy = null;
        break;
      }
      case '-damage':
        if (battler !== null && line.tags.get('from') === 'confusion') {
          // A confusion self-hit reaches UPDATE_MOVE_BUFFERS without SYSCTL_MOVE_SUCCEEDED too
          // (battle_controller_player.c:2627–2638, 3820–3900, 3948). Its defender is the attacker itself
          // (battle_controller_player.c:2628), so only the AI's own action clears the AI's moveHit (4389).
          lastMoveBy[battler] = MOVE_NONE;
          if (battler === AI_BATTLER) lastHitBy = null;
        }
        break;
      case 'switch':
      case 'drag':
      case 'faint': // BtlCmd_PlayFaintAnimation → BattleSystem_CleanupFaintedMon (battle_script.c:1803)
        if (battler === null) break;
        if (line.cmd !== 'faint') {
          aiAction = null; // a switch action, or a send-in after the actions
          // A new BattleMon (BattleSystem_UpdateAfterSwitch): nothing is kept from the last one. A faint keeps it.
          if (battler === AI_BATTLER) {
            kept.clear();
            aiTraced = undefined;
          }
        }
        clearBattler(battler);
        break;
      case '-transform':
        if (battler === AI_BATTLER) keep(TRANSFORM_FIELDS);
        break;
      case '-formechange':
      case 'detailschange':
        if (battler === AI_BATTLER) keep(FORM_FIELDS);
        break;
      case '-weather': {
        // A turn end's "rain continues" leaves the bits as they are (BtlCmd_EndOfTurnWeatherEffect).
        if (line.tags.has('upkeep')) break;
        const weather = SHOWDOWN_WEATHERS[arg(line, 0)];
        if (weather === undefined) throw new AiError('BAD_VIEW', `Showdown weather "${arg(line, 0)}" has no Gen 4 encoding`);
        if (effectOf(line.tags.get('from')).kind === 'ability') {
          // A weather ability: no subscript, so no message, when its own _PERM bit is set already; otherwise its
          // subscript clears the weather bits and sets that one (battle_lib.c:3746–3782; subscript_drizzle.s:11–12).
          if (weather === permWeather) silent = true;
          else {
            permWeather = weather;
            if (weather !== null) fog = 'cleared'; // the subscript clears every weather bit, the fog's too (subscript_drizzle.s:11)
          }
        } else if (weather !== null && weather !== permWeather) {
          // A move's other weather clears every weather bit and sets a _TEMP one (effect_script_0136.s:8–9 and its kin).
          // Into its own weather it fails on the cartridge (:5, both bits), and in the engine, so no such line comes;
          // a plain line of the note's own weather at battle start is the _PERM weather itself; Hail's is the `move` case. A weather's
          // end clears its _TEMP bit alone (subscript_raining_end.s:5 and its kin), and the turn end never ends a _PERM
          // weather (battle_controller_player.c:1113–1128 and its kin): either leaves the _PERM weather.
          permWeather = null;
          if (weather !== null) fog = 'cleared'; // the weather bits are the fog's too (effect_script_0136.s:8 and its kin)
        }
        break;
      }
      case '-ability':
        // BattleMessage_AbilityTag (battle_script.c:11800–11807) and the ability-changing script commands
        // (battle_script.c:3074, 3403) call BattleAI_SetAbility (battle_script.c:12106).
        if (isTrace(line)) {
          // Either Trace records the player's ability: the player's own through the command that sets it
          // (subscript_trace.s:7, battle_script.c:3402–3404), the AI's through its message, which tags the traced
          // battler's ability (subscript_trace.s:9, BTLSCR_MSG_DEFENDER; battle_script.c:11480–11483). Both are the
          // line's ability: the tracer's new one is the traced battler's.
          if (battler === PLAYER_BATTLER || battlerOf(line.tags.get('of')) === PLAYER_BATTLER) {
            knowledge.battlerAbilities[PLAYER_BATTLER] = ids.ability(arg(line, 1));
          }
        } else if (battler === PLAYER_BATTLER && !isStatAbilityMessage(line)) {
          knowledge.battlerAbilities[PLAYER_BATTLER] = ids.ability(arg(line, 1));
        }
        // With a [from] tag the ability changed (Trace, Role Play, Worry Seed); without one it is an announcement. A
        // Trace's is the line's ability (subscript_trace.s:6–7), which the BattleMon keeps through a faint: aiTraced.
        if (battler === AI_BATTLER && line.tags.has('from')) {
          if (isTrace(line)) {
            kept.delete(REPLACEMENT_PATHS.field(AI_BATTLER, 'ability'));
            aiTraced = ids.ability(arg(line, 1));
          } else {
            keep(['ability']);
          }
        }
        break;
      case '-item':
        // Frisk's message tags the item it found as BTLSCR_MSG_TEMP (subscript_frisk.s:7), which records no battler
        // (battle_script.c:11745–11747), and names the frisker without its ability: nothing is revealed.
        if (isFrisk(line)) break;
        // BattleMessage_ItemTag (battle_script.c:11728–11745) calls BattleAI_SetHeldItem (battle_script.c:12119).
        if (battler === PLAYER_BATTLER) {
          knowledge.battlerHeldItems[PLAYER_BATTLER] = ids.item(arg(line, 1));
          playerItemGone = false;
        }
        break;
      case '-enditem':
        // BattleMon_CopyToParty forgets the known item once heldItem is ITEM_NONE (battle_lib.c:1822).
        if (battler === PLAYER_BATTLER) {
          knowledge.battlerHeldItems[PLAYER_BATTLER] = ITEM_NONE;
          playerItemGone = true;
        }
        if (battler !== null) recycle[battler] = recycleAfterEndItem(line, recycle[battler] ?? null);
        break;
      case '-activate':
      case '-start': {
        // An effect argument that names the line's Pokémon's ability or item is a message tagging it
        // (battle_script.c:11800–11807, 11728–11745). Quick Claw is not: the cartridge plays only an animation
        // (subscript_check_quick_claw.s), so the AI never learns the item from it.
        const effect = effectOf(arg(line, 1));
        // What the AI's BattleMon keeps after a faint: Skill Swap swaps both battlers' abilities (Showdown's Gen 4 line
        // names the user, the target in [of]); Conversion, Conversion 2, Color Change and Camouflage start a
        // `typechange`; Power Trick swaps the stored Attack and Defense, which the faint doesn't swap back (the
        // switch-out does, battle_lib.c:2134–2138).
        if (line.cmd === '-activate' && arg(line, 1) === 'move: Skill Swap'
          && (battler === AI_BATTLER || battlerOf(line.tags.get('of')) === AI_BATTLER)) keep(['ability']);
        if (line.cmd === '-start' && battler === AI_BATTLER) {
          if (arg(line, 1) === 'typechange') keep(['types']);
          if (arg(line, 1) === 'Power Trick' || effect.name === 'Power Trick') keep(['attack', 'defense']);
        }
        if (line.cmd === '-activate' && line.tags.has('trainer')) {
          // The AI's bag item, an action of its own: its MoveEnd runs BattleControllerPlayer_ClearFlags, which clears the
          // AI's own moveHit (battle_controller_player.c:4389), as every AI action's does.
          aiAction = null;
          if (battler === AI_BATTLER) lastHitBy = null;
        }
        if (battler !== PLAYER_BATTLER) break;
        // An ability's status cure tags msgAbilityTemp, which records nothing (BattleSystem_RecoverStatusByAbility,
        // battle_lib.c:4442–4445; subscript_ability_forbids_status.s:6; battle_script.c:11801–11802). Showdown's
        // `-activate` line for one is the cure; a status it prevents is an `-immune` line, which the cartridge tags.
        if (effect.kind === 'ability' && line.cmd === '-activate' && STATUS_CURE_ABILITIES.has(effect.name)) break;
        if (effect.kind === 'ability') knowledge.battlerAbilities[PLAYER_BATTLER] = ids.ability(effect.name);
        if (effect.kind === 'item' && effect.name !== 'Quick Claw' && !playerItemGone) {
          knowledge.battlerHeldItems[PLAYER_BATTLER] = ids.item(effect.name);
        }
        break;
      }
    }
    // On an -ability line, a [from] ability is the line's own Pokémon's old one (Trace), not a reveal. Three lines
    // whose `[from]` names an ability or item reveal nothing on the cartridge:
    // - a stat drop an ability blocks: BtlCmd_ChangeStatStage buffers its message (battle_script.c:2883–2903), and
    //   PrintBufferedMessage sends it without BattleMessage_AbilityTag (:1505–1510);
    // - a form change (Forecast's): subscript_form_change.s:22 prints the nickname alone;
    // - Frisk's find (see `-item` above).
    // And a weather ability that runs no subscript (`-weather` above).
    if (!silent && line.cmd !== '-ability' && !isBlockedStatDrop(line) && line.cmd !== '-formechange' && !isFrisk(line)) revealFrom(line);
  }

  /**
   * A `[from] ability:` or `[from] item:` tag is a message naming that ability or item (battle_script.c:11800–11807,
   * 11728–11745). The owner is the `[of]` Pokémon when there is one (Rough Skin, Static, Jaboca Berry), else the line's
   * own Pokémon. On `-heal` lines it is always the line's own Pokémon (Water Absorb, Leftovers), where `[of]` is the attacker.
   */
  function revealFrom(line: Line): void {
    const effect = effectOf(line.tags.get('from'));
    if (effect.kind !== 'ability' && effect.kind !== 'item') return;
    const owner = battlerOf(line.cmd === '-heal' ? arg(line, 0) : line.tags.get('of') ?? arg(line, 0));
    if (owner !== PLAYER_BATTLER) return;
    if (effect.kind === 'ability') knowledge.battlerAbilities[PLAYER_BATTLER] = ids.ability(effect.name);
    else if (!playerItemGone) knowledge.battlerHeldItems[PLAYER_BATTLER] = ids.item(effect.name);
  }

  /**
   * The line's battler's recycleItem override after an `|-enditem|` line. Only BtlCmd_RemoveItem writes
   * recycleItem (battle_script.c:8978, and Recycle clears it, :9005–9007), and Showdown's Gen 4 `lastItem` follows the
   * same battler slot (sim/battle-actions.ts switchIn), set by eatItem, useItem, Fling and Natural Gift. They differ in
   * one RemoveItem: Bug Bite and Pluck's on the defender, the berry's holder (subscript_pluck.s:10), where Showdown's
   * takeItem sets no lastItem and logs `[from] stealeat`. The other BTLSCR_DEFENDER removals take the defender's own
   * item, as Showdown's eatItem or useItem record it: a Jaboca or Rowap Berry (subscript_held_item_recoil_when_hit.s:17)
   * and a Focus Sash (HOLD_EFFECT_ENDURE, subscript_move_followup_message.s:18). So:
   * - `[from] stealeat`: the victim's slot holds the berry;
   * - the slot's own item used up (`[eat]`, eatItem; no `[from]`, useItem; `[from] move: Fling`): both hold that item
   *   again, so lastItem gives it;
   * - an item taken by another move (Knock Off, Thief, Covet): neither records it, so the override stays.
   */
  function recycleAfterEndItem(line: Line, before: RecycleOverride): RecycleOverride {
    const from = line.tags.get('from');
    if (from === 'stealeat') return ids.item(arg(line, 1));
    if (before === null) return null;
    return line.tags.has('eat') || from === undefined || from === 'move: Fling' ? null : before;
  }

  return {
    knowledge, lastMoveBy, lastHitBy, recycleOverride: recycle,
    switchAction: end.phase === 'enemyMidTurnSwitch' ? aiAction : [],
    aiKept: [...kept].sort(),
    ...(aiTraced === undefined ? {} : { aiTraced }),
    // Used up by this step; model.ts sets the next turn's from the state when the step ends at a turn choice.
    turnFight: null,
    playerMovesUnknown,
    imprisonedMark: imprisoned,
    permWeather,
    fog,
  };
}
