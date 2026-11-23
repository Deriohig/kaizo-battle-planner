// The plan step (`PlanStepJson` in src/contracts/api.ts): one battle state of a plan
// the player writes, answered with the line node's own pieces. It works out nothing beyond that state, keeps nothing
// between calls, and never changes an HP: his Pokémon are on the draft's HP, theirs full.
//
// The state. Built with the engine's own start (`createBattle` over `battleInput`, as a line start builds its root in
// lines.ts `open`), then the step's inputs are set on it through the state's own fields (`PlanStates`):
// - His side: `team` in order, the active first, each as `mons` has it (the draft's edits applied by the caller).
// - Their side: the copy's party with slots 0 and `state.enemy.active` swapped, as src/server/sheetAi.ts `pairSituation`
//   builds a pair's battle, so their active's entry ability and the start's weather are its own; the candidate world is
//   swapped the same way. Once built, the battle's p2 team (the party order the engine, the trainer AI and the damage
//   reader index by: engine/battle.ts `partyIndexOf`) is put back in the copy's own order, while Showdown's `side.pokemon`
//   keeps their active first: the state a line reaches when the trainer switches to that Pokémon. So a party index here,
//   in `fainted`, the view, every switch and `sendOut`, is the copy's own, and the damage reader (integration/battleView.ts
//   `enemyMon`, which looks a Pokémon up in the catalog's copy by that index) reads the right one: on the swapped team it
//   reads no Pokémon on either side ("can't calculate here"). Their party order is kept real (the copy's own), not
//   sheetAi.ts's swapped order, so 2 of 36 send-out tie-breaks can differ from Matchups' "if it faints" odds.
// - The trainer's field (`FightInfo.field`, its docs note) goes to the battle as `fieldSpec` gives it, as sheetAi.ts
//   `noteField` does: its weather when the step leaves its weather out or names the same one, its Trick Room when the step
//   leaves Trick Room out or has it on (Gravity and fog as the note says). The battle is built once. The step's weather
//   left out is the one that start gives (with the whole note's weather, as a line start's, so the AI's permanent-weather
//   memory is the line's); `field.weather` answers it. Trick Room left out is the start's in the same way (a permanent
//   Trick Room: Veilstone Warehouse, Galactic HQ); `field.trickRoom` answers it.
// - Then (`SHOWDOWN_PLAN_STATES.set`): the weather (left as the start gave it when it is the step's, else set with no
//   duration, never ending, as sheetAi.ts `setField` sets a pair's, or cleared for 'none'); Trick Room (left as the start
//   gave it when it is up there, else added with its move's duration, or removed); Stealth Rock and Reflect and Light Screen on each side (added as their moves add them, or
//   removed); both actives' stat stages (exactly the step's, a stage left out 0: a start's Intimidate is replaced, and
//   `startStages` reports the start's so the page can seed turn 1 with them); their
//   active's status (engine/sets.ts `setStartStatus`, the engine's own way to give a status without its handlers); each
//   bench Pokémon marked fainted fainted the way Showdown faints one (`faint`, then `faintMessages` without the win check,
//   its status 'fnt' as `checkFainted` marks one). The battle's log is cleared: nothing was played.
// - An active marked fainted is not fainted in the state: the mark is after a move, so the damage and the AI's reply are
//   the pair's. His marked fainted makes the phase 'playerReplacement', and his choices are then a switch to each of his
//   bench not marked fainted, built from the team, not read from the state's turn choices (a trapping ability takes the
//   switches out of those, and a faint replacement is never trapped), each labelled as the line labels a switch.
// - The AI's memory is its `initialMemory` of the battle as built, before the inputs are set, as sheetAi.ts does.
//
// Sleep and toxic counters. The page gives none, and the trainer AI reads both exactly (src/ai/read/showdown.ts
// `statusOf`: sleep 1–7, toxic 0–15). So their status is set with every counter, and the step's figures (the AI's reply,
// the send-out and the damage) are compared: when every counter gives the same, those are the answer (the state keeps the
// first counter); otherwise the status is left out of the state, and `unmodelled` says so. The loop yields between
// counters, and stops there once the query's `signal` is aborted (the request closed).
//
// The answer. `view` (`LineDeps.view`), `damage` (`LineDeps.damage` over the battle's party), the AI's turn odds
// (`aiAnswer`), his legal choices labelled, the start's stat stages (`PlanStates.startStages` of the battle as built),
// and, when their active is marked fainted, the send-out: the state with their
// active fainted as sheetAi.ts `replacementOdds` faints one, then the AI's replacement odds by party index (two of one
// name stay two choices).
// None of theirs left standing: no send-out. EXP for a fainted enemy is not given (the engine pays it only
// inside a step, read from the step's log by lineExp.ts).
//
// The AI odds level (`aiOdds`, `PKP_AI_ODDS`; aiOdds.ts): the answer is built as the full level has it, then cut to the
// level (`planStepAt`) before it leaves the service, so its cache holds only what the level sends. A `likeliest` send-out
// lists every one of theirs still standing, each named by the labeler as a switch to it is. Below full, a status left out
// for its counter is said without the AI's odds.
//
// Errors (`HttpError`): 404 for an unknown trainer and 400 for another refusal of the fight, 422 for a double (lines.ts
// `fightOf`); 400 for a bad team, active, index, stage, status or weather; 422 as a line start for a battle the engine will
// not build and for an AI whose first memory is undefined; 499 once the query's `signal` is aborted.

import type { PlayerMon } from '../battle/playerMon.js';
import type {
  AiOddsLevel, LineChoiceJson, LineDamageJson, PlanSendOutChoiceJson, PlanStages, PlanStat, PlanStepFieldJson, PlanStepJson, PlanStepStateJson, PlanWeather,
} from '../contracts/api.js';
import type { AiMemory } from '../contracts/ai.js';
import type { Choice, EngineState, FieldSpec, Rational, WorldAssignment } from '../contracts/engine.js';
import { restore, snapshot } from '../engine/index.js';
import { plainUnmodelled } from '../engine/notes.js';
import { add } from '../engine/rational.js';
import { setStartStatus } from '../engine/sets.js';
import { battleInput, type MonInfo } from '../integration/fight.js';
import type { StartStatus } from '../save/status.js';
import { planStepAt } from './aiOdds.js';
import type { MonRef } from './apiTypes.js';
import { HttpError } from './http.js';
import {
  aiAnswer, type AiAnswer, aiUndefined, codeOf, damageFns, describeWorlds, DOUBLE_TEXT, engineFailure, fightOf, type LineDeps, messageOf,
  oddsJson, percentOf, ratJson,
} from './lines.js';
import type { ServerData } from './state.js';

/**
 * One step to answer. `mons` are the box's pool by ref with the draft's edits applied to the team's; `team` his party in
 * battle order, the active first (1 to 6, any of `mons`); `state` the step's state (`PlanStepStateJson`). `signal`, when
 * given, is the request's closing: once it is aborted the step stops at its next yield (before the next status counter)
 * with a 499 that no one reads.
 */
export interface PlanStepQuery {
  data: ServerData; mons: ReadonlyMap<MonRef, PlayerMon>;
  team: MonRef[];
  trainerId: string; variant: number; world: number;
  state: PlanStepStateJson;
  signal?: AbortSignal;
}

export interface PlanService {
  /** The step's one state, answered (see the top of the file). Throws `HttpError` (see Errors). */
  step(query: PlanStepQuery): Promise<PlanStepJson>;
}

/** A stat stage's stat as Showdown names it. */
export type PlanBoostId = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy' | 'evasion';

/** Their active's status for the state: a draft status, with sleep's counter (`turns`, 1–7) and toxic's (`stage`, 0–15). */
export type PlanEnemyStatus = Exclude<StartStatus, { kind: 'toxic' }> | { kind: 'toxic'; stage: number };

type Screens = { reflect: boolean; lightScreen: boolean };

/**
 * What a step sets on its built state, by engine side (`p1` his, `p2` theirs). `enemyActive` is their active's index in
 * the copy's party; the battle was built with slots 0 and it swapped. `fainted` are party indices to faint, never an
 * active's: his in the battle's party order, theirs in the copy's. `stages` are each active's, all of them (a stat left
 * out is 0).
 */
export interface PlanEdits {
  enemyActive: number;
  fainted: { p1: number[]; p2: number[] };
  weather: PlanWeather; trickRoom: boolean;
  rocks: { p1: boolean; p2: boolean };
  screens: { p1: Screens; p2: Screens };
  stages: { p1: Partial<Record<PlanBoostId, number>>; p2: Partial<Record<PlanBoostId, number>> };
  enemyStatus: PlanEnemyStatus;
}

/** How a step's inputs reach a built state, and what the service reads back that no `LineDeps` call gives. */
export interface PlanStates {
  /** `state` (a battle start built as the top of the file says) with `edits` set. */
  set(state: EngineState, edits: PlanEdits): EngineState;
  /** `state` with their active fainted, waiting on whatever the battle waits on next; null when none of theirs is left standing. */
  faintEnemyActive(state: EngineState): EngineState | null;
  /** The weather in `state`. */
  weather(state: EngineState): PlanWeather;
  /** Whether Trick Room is up in `state`. */
  trickRoom(state: EngineState): boolean;
  /** Both actives' stat stages in `state` (his `player`, theirs `enemy`), the nonzero ones only, by `PlanStat` name. */
  startStages(state: EngineState): { player: PlanStages; enemy: PlanStages };
}

const MAX_TEAM = 6;
const STAGE_IDS: Readonly<Record<string, PlanBoostId>> = { atk: 'atk', def: 'def', spa: 'spa', spd: 'spd', spe: 'spe', acc: 'accuracy', eva: 'evasion' };
const WEATHERS: readonly PlanWeather[] = ['none', 'sun', 'rain', 'sand', 'hail'];
const STATUSES: Readonly<Record<string, PlanEnemyStatus['kind']>> = {
  none: 'none', brn: 'burn', par: 'paralysis', psn: 'poison', tox: 'toxic', slp: 'sleep', frz: 'freeze',
};
/** Every sleep counter the cartridge holds (MON_CONDITION_SLEEP, bits 0–2) and every toxic counter (0–15). */
const SLEEP_COUNTERS = [1, 2, 3, 4, 5, 6, 7];
const TOXIC_COUNTERS = Array.from({ length: 16 }, (_, stage) => stage);
/** What `unmodelled` says of a status left out because its counter changes the step's figures. */
const COUNTER_TEXT: Readonly<Partial<Record<PlanEnemyStatus['kind'], string>>> = {
  sleep: "Their sleep is not modelled in this turn: the AI's odds depend on its sleep counter, which the plan does not set",
  toxic: "Their bad poison is not modelled in this turn: the AI's odds depend on its toxic counter, which the plan does not set",
};
/** The same below the full AI odds level, which says nothing of the AI. */
const PLAIN_COUNTER_TEXT: Readonly<Partial<Record<PlanEnemyStatus['kind'], string>>> = {
  sleep: 'Their sleep is not modelled in this turn: it depends on its sleep counter, which the plan does not set',
  toxic: 'Their bad poison is not modelled in this turn: it depends on its toxic counter, which the plan does not set',
};

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));
const bad = (text: string) => new HttpError(400, text);

/** `party` with slots 0 and `k` swapped (sheetAi.ts `swapped`). */
function swapped<T>(party: readonly T[], k: number): T[] {
  const out = [...party];
  [out[0], out[k]] = [out[k]!, out[0]!];
  return out;
}

/** The candidate world for the swapped party: its entries swapped as the party is (an entry left out is the listed values). */
function swappedWorld(world: WorldAssignment, size: number, k: number): WorldAssignment {
  const enemy = Array.from({ length: Math.max(size, world.enemy.length) }, (_, i) => world.enemy[i] ?? {});
  return { enemy: swapped(enemy, k) };
}

/**
 * The trainer's field for the step's battle (see the top of the file): the note's weather when the step leaves its weather
 * out (`weather` undefined) or names the same one, and its Trick Room when the step leaves Trick Room out (`trickRoom`
 * undefined) or has it on.
 */
function stepField(note: FieldSpec, weather: PlanWeather | undefined, trickRoom: boolean | undefined): FieldSpec {
  const { weather: noteWeather, trickRoom: noteRoom, ...rest } = note;
  return {
    ...(noteWeather !== undefined && (weather === undefined || noteWeather === weather) ? { weather: noteWeather } : {}),
    ...(noteRoom !== undefined && (noteRoom === false || trickRoom !== false) ? { trickRoom: noteRoom } : {}),
    ...rest,
  };
}

/** A side's stages as Showdown names them; 400 for a stat or stage outside the contract. */
function stagesOf(stages: PlanStages | undefined, side: string): Partial<Record<PlanBoostId, number>> {
  if (stages === null || typeof stages !== 'object') throw bad(`state.field.stages.${side} must be an object of stat stages`);
  const out: Partial<Record<PlanBoostId, number>> = {};
  for (const [stat, stage] of Object.entries(stages)) {
    const id = Object.hasOwn(STAGE_IDS, stat) ? STAGE_IDS[stat] : undefined;   // own names only: not "constructor", "__proto__"
    if (id === undefined) throw bad(`state.field.stages.${side}: ${stat} is not a stat with a stage (atk, def, spa, spd, spe, acc, eva)`);
    // The route clamps a whole number outside -6..6 first (app.ts `planStepState`); this refuses what is left or a direct caller's.
    if (!Number.isInteger(stage) || (stage as number) < -6 || (stage as number) > 6) throw bad(`state.field.stages.${side}.${stat} must be a whole number from -6 to 6`);
    out[id] = stage as number;
  }
  return out;
}

/**
 * The step's field as edits, the weather, Trick Room and the counters aside; 400 for a weather, Trick Room or status
 * outside the contract.
 */
function fieldEdits(field: PlanStepFieldJson): Omit<PlanEdits, 'enemyActive' | 'fainted' | 'enemyStatus' | 'weather' | 'trickRoom'> & { status: PlanEnemyStatus['kind'] } {
  if (field.weather !== undefined && !WEATHERS.includes(field.weather)) throw bad(`state.field.weather must be one of ${WEATHERS.join(', ')}, or left out`);
  if (field.trickRoom !== undefined && typeof field.trickRoom !== 'boolean') throw bad('state.field.trickRoom must be true or false, or left out');
  // A string only: a key lookup would read `['slp']` as "slp".
  const status = typeof field.enemyStatus === 'string' && Object.hasOwn(STATUSES, field.enemyStatus) ? STATUSES[field.enemyStatus] : undefined;
  if (status === undefined) throw bad(`state.field.enemyStatus must be one of ${Object.keys(STATUSES).join(', ')}`);
  return {
    rocks: { p1: field.rocks.player === true, p2: field.rocks.enemy === true },
    screens: {
      p1: { reflect: field.screens.player.reflect === true, lightScreen: field.screens.player.lightScreen === true },
      p2: { reflect: field.screens.enemy.reflect === true, lightScreen: field.screens.enemy.lightScreen === true },
    },
    stages: { p1: stagesOf(field.stages.player, 'player'), p2: stagesOf(field.stages.enemy, 'enemy') },
    status,
  };
}

/** The status `kind` with each counter to try: one entry for a status without a counter. */
function statusTries(kind: PlanEnemyStatus['kind']): PlanEnemyStatus[] {
  if (kind === 'sleep') return SLEEP_COUNTERS.map((turns) => ({ kind: 'sleep', turns }));
  if (kind === 'toxic') return TOXIC_COUNTERS.map((stage) => ({ kind: 'toxic', stage }));
  return [{ kind } as PlanEnemyStatus];
}

/** A state's figures: the AI's turn answer, the send-out's (null when there is none to give) and the damage. */
interface Figures { ai: AiAnswer | null; sendOut: AiAnswer | null; damage: LineDamageJson | null }

/** The figures as a string, to compare two states' (bigints as text). */
const figuresKey = (f: Figures): string => JSON.stringify(f, (_, value: unknown) => (typeof value === 'bigint' ? `${value}n` : value));

/**
 * The send-out's odds by party index, not by label, so two Pokémon of one name stay two choices: in `oddsJson`'s order
 * (the most likely first, then by label), then by index.
 */
function sendOutJson(ai: Extract<AiAnswer, { kind: string }>): PlanSendOutChoiceJson[] {
  const byIndex = new Map<number, { label: string; probability: Rational }>();
  for (const a of ai.actions) {
    if (a.choice.kind !== 'switch') throw new Error(`plan: the send-out holds a ${a.choice.kind}, not a switch`);
    const had = byIndex.get(a.choice.index);
    byIndex.set(a.choice.index, { label: a.label, probability: had === undefined ? a.probability : add(had.probability, a.probability) });
  }
  const larger = (a: Rational, b: Rational): number => { const d = b.num * a.den - a.num * b.den; return d < 0n ? -1 : d > 0n ? 1 : 0; };
  return [...byIndex]
    .sort(([i, a], [j, b]) => larger(a.probability, b.probability) || a.label.localeCompare(b.label) || i - j)
    .map(([index, { label, probability }]) => ({ label, probability: ratJson(probability), percent: percentOf(probability), index }));
}

/** `aiOdds` is the AI odds level the answers are cut to (see the top of the file), `full` when left out. */
export function createPlanService(opts: { deps: (data: ServerData) => LineDeps; states?: PlanStates; aiOdds?: AiOddsLevel }): PlanService {
  const states = opts.states ?? SHOWDOWN_PLAN_STATES;
  const level = opts.aiOdds ?? 'full';
  const counterText = level === 'full' ? COUNTER_TEXT : PLAIN_COUNTER_TEXT;
  let depsFor: { data: ServerData; deps: LineDeps } | null = null;
  const depsOf = (data: ServerData): LineDeps => {
    if (depsFor?.data !== data) depsFor = { data, deps: opts.deps(data) };
    return depsFor.deps;
  };

  return {
    async step(q) {
      const pause = async () => {
        await yieldNow();
        if (q.signal?.aborted === true) throw new HttpError(499, 'The request was closed before the step was answered', 'CLOSED');
      };
      await pause();
      const deps = depsOf(q.data);
      const resolver = deps.resolver(q.mons);
      const fight = fightOf(resolver, q.trainerId, q.variant);
      const { player, enemy, field: asked } = q.state;

      const party = q.team;
      if (!Array.isArray(party) || party.length < 1 || party.length > MAX_TEAM) throw bad(`team must hold 1 to ${MAX_TEAM} Pokémon, the active first`);
      if (new Set(party).size !== party.length) throw bad('team lists a Pokémon twice');
      if (player.active !== party[0]) throw bad(`state.player.active must be team[0] (${party[0]})`);
      const infos: MonInfo[] = party.map((ref) => {
        try {
          return resolver.mon(ref);
        } catch (error) {
          throw bad(messageOf(error));
        }
      });

      const size = fight.trainer.party.length;
      const index = (value: unknown, what: string): number => {
        if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= size) throw bad(`${what} must be a party index of the trainer's, 0 to ${size - 1}`);
        return value as number;
      };
      const k = index(enemy.active, 'state.enemy.active');
      const enemyFainted = new Set(enemy.fainted.map((i) => index(i, 'state.enemy.fainted')));
      const playerFainted = new Set(player.fainted.map((ref) => {
        const at = party.indexOf(ref);
        if (at < 0) throw bad(`state.player.fainted: ${ref} is not in the team`);
        return at;
      }));
      const field = fieldEdits(asked);
      const world = Number.isInteger(q.world) ? fight.worlds[q.world] : undefined;
      if (world === undefined) throw bad(`world must be a whole number from 0 to ${fight.worlds.length - 1}`);

      // The battle start (see the top of the file), built once.
      const trainer = { ...fight.trainer, party: swapped(fight.trainer.party, k) };
      const build = (note: FieldSpec): EngineState => {
        try {
          return deps.engine.createBattle(battleInput(
            { info: { ...fight, trainer, field: note }, team: infos, startStatus: {}, healBefore: false }, 0, null, swappedWorld(world, size, k),
          ));
        } catch (error) {
          if (codeOf(error) === 'UNSUPPORTED_DOUBLE') throw new HttpError(422, DOUBLE_TEXT);
          if (error instanceof RangeError) throw new HttpError(422, error.message, 'BAD_START');
          engineFailure(error);
        }
      };
      const built = build(stepField(fight.field, asked.weather, asked.trickRoom));
      const weather = asked.weather ?? states.weather(built);
      const trickRoom = asked.trickRoom ?? states.trickRoom(built);
      let memory: AiMemory;
      try {
        memory = deps.model.initialMemory(built);
      } catch (error) {
        if (codeOf(error) === undefined) throw error;
        throw aiUndefined(`The AI's behaviour is undefined here (${codeOf(error)}: ${messageOf(error)})`);
      }

      const labeler = deps.labeler(q.mons, party);
      const damageFn = damageFns(deps)(infos.map((info) => info.mon));
      const sendsOut = enemyFainted.has(k);
      const { status, ...set } = field;
      const editsWith = (enemyStatus: PlanEnemyStatus): PlanEdits => ({
        enemyActive: k,
        fainted: { p1: [...playerFainted].filter((i) => i !== 0).sort((a, b) => a - b), p2: [...enemyFainted].filter((i) => i !== k).sort((a, b) => a - b) },
        weather, trickRoom, ...set, enemyStatus,
      });
      const figuresOf = (state: EngineState): Figures => {
        const fallen = sendsOut ? states.faintEnemyActive(state) : null;
        const sendOut: AiAnswer | null = fallen === null ? null : fallen.phase.kind === 'enemyReplacement'
          ? aiAnswer(deps, labeler, fallen, memory)
          : { error: `The battle did not reach the trainer's send-out: it waits on ${fallen.phase.kind}` };
        return { ai: aiAnswer(deps, labeler, state, memory), sendOut, damage: damageFn === null ? null : damageFn(state) };
      };

      // Every counter of their status (see the top of the file); one try for a status without one.
      let state: EngineState | null = null;
      let figures: Figures | null = null;
      let key: string | null = null;
      let leftOut: string | null = null;
      for (const enemyStatus of statusTries(status)) {
        await pause();
        const tried = states.set(built, editsWith(enemyStatus));
        const got = figuresOf(tried);
        const gotKey = figuresKey(got);
        if (key !== null && gotKey !== key) {
          leftOut = counterText[status] ?? `Their status is not modelled in this turn`;
          break;
        }
        state ??= tried;
        figures ??= got;
        key = gotKey;
      }
      if (leftOut !== null) {
        await pause();
        state = states.set(built, editsWith({ kind: 'none' }));
        figures = figuresOf(state);
      }

      const view = deps.view(state!, infos.map((info) => info.label));
      const { ai, sendOut, damage } = figures!;
      // His replacements are built here, not read from the state's turn choices: a trapping ability (Shadow Tag, Arena
      // Trap) takes the switches out of those, and a faint replacement is never trapped.
      const replacing = playerFainted.has(0);
      const legal: Choice[] = replacing
        ? party.flatMap((_, i) => (i > 0 && !playerFainted.has(i) ? [{ kind: 'switch' as const, index: i }] : []))
        : deps.engine.legalChoices(state!, 'p1');
      const choices: LineChoiceJson[] = legal.map((choice) => ({ choice, label: labeler.choice(state!, 'p1', choice) }));
      const answer: PlanStepJson = {
        phase: replacing ? 'playerReplacement' : 'turnChoice',
        view,
        choices,
        ...(damage === null ? {} : { damage: { ...damage, against: view.player.active?.name ?? damage.against } }),
        ...(ai === null ? {} : 'error' in ai ? { aiError: ai.error } : { aiOdds: oddsJson(ai) }),
        field: { ...asked, weather, trickRoom },
        startStages: states.startStages(built),
        ...(sendOut === null ? {} : 'error' in sendOut ? { sendOutError: sendOut.error } : { sendOut: { kind: 'replacement' as const, choices: sendOutJson(sendOut) } }),
        unmodelled: [...plainUnmodelled(deps.engine.unmodelledIn(state!)), ...(leftOut === null ? [] : [leftOut])],
        world: q.world,
        ...(fight.worlds.length > 1 ? { worlds: describeWorlds(fight, deps) } : {}),
      };
      if (level !== 'likeliest' || answer.sendOut === undefined) return planStepAt(level, answer, []);
      // Every one of theirs still standing, in party order, named as a switch to it is.
      const standing = Array.from({ length: size }, (_, i) => i).filter((i) => i !== k && !enemyFainted.has(i))
        .map((index) => ({ index, label: labeler.choice(state!, 'p2', { kind: 'switch', index }).replace(/^Switch to /, '') }));
      return planStepAt(level, answer, standing);
    },
  };
}

const SHOWDOWN_WEATHERS: Readonly<Record<PlanWeather, string>> = { none: '', rain: 'raindance', sun: 'sunnyday', sand: 'sandstorm', hail: 'hail' };
const PLAN_WEATHERS: Readonly<Record<string, PlanWeather>> = { '': 'none', raindance: 'rain', sunnyday: 'sun', sandstorm: 'sand', hail: 'hail' };
const SIDES = ['p1', 'p2'] as const;

/** `side`'s Pokémon at party index `index` (its set's index in `side.team`, engine/battle.ts `partyIndexOf`). */
function memberAt(side: Battle['p1'], index: number): Pokemon {
  const set = side.team[index];
  const pokemon = set === undefined ? undefined : side.pokemon.find((p) => p.set === set);
  if (pokemon === undefined) throw new Error(`plan: ${side.id} has no Pokémon at party index ${index}`);
  return pokemon;
}

/** Adds (`on`) or removes side condition `id` on `side`, from `source`; throws when Showdown refuses to add it. */
function sideCondition(side: Battle['p1'], id: string, on: boolean, source: Pokemon): void {
  const has = side.sideConditions[id] !== undefined;
  if (on && !has && !side.addSideCondition(id, source)) throw new Error(`plan: Showdown refused ${id} on ${side.id}'s side`);
  if (!on && has) side.removeSideCondition(id);
}

/** The step's inputs set on the engine's own Showdown battle (see the top of the file). */
export const SHOWDOWN_PLAN_STATES: PlanStates = {
  set(state, edits) {
    const battle = restore(state);
    const { p1, p2 } = battle;
    // Their party back in the copy's order; `side.pokemon` keeps their active first.
    const k = edits.enemyActive;
    if (k !== 0) [p2.team[0], p2.team[k]] = [p2.team[k]!, p2.team[0]!];
    const mine = p1.active[0]!;
    const theirs = p2.active[0]!;

    const weather = SHOWDOWN_WEATHERS[edits.weather];
    if (battle.field.weather !== weather) {
      if (weather === '') battle.field.clearWeather();
      else {
        if (!battle.field.setWeather(weather, theirs)) throw new Error(`plan: Showdown refused ${weather}`);
        battle.field.weatherState.duration = 0;
      }
    }
    const room = battle.field.pseudoWeather['trickroom'] !== undefined;
    if (edits.trickRoom && !room && !battle.field.addPseudoWeather('trickroom', theirs)) throw new Error('plan: Showdown refused Trick Room');
    if (!edits.trickRoom && room) battle.field.removePseudoWeather('trickroom');
    for (const id of SIDES) {
      const side = battle[id];
      const own = id === 'p1' ? mine : theirs;
      sideCondition(side, 'stealthrock', edits.rocks[id], id === 'p1' ? theirs : mine);
      sideCondition(side, 'reflect', edits.screens[id].reflect, own);
      sideCondition(side, 'lightscreen', edits.screens[id].lightScreen, own);
      for (const stat of ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const) own.boosts[stat] = edits.stages[id][stat] ?? 0;
    }
    const status = edits.enemyStatus;
    setStartStatus(theirs, status.kind === 'toxic' ? { kind: 'toxic' } : status);
    if (status.kind === 'toxic') theirs.statusState['stage'] = status.stage;

    for (const id of SIDES) {
      const side = battle[id];
      for (const index of edits.fainted[id]) {
        const pokemon = memberAt(side, index);
        if (pokemon.isActive) throw new Error(`plan: party index ${index} of ${id} is active, and an active is never fainted here`);
        pokemon.faint();
        battle.faintMessages(false, false, false);
        pokemon.status = 'fnt' as ID;
      }
      side.faintedThisTurn = null;
    }
    battle.log.length = 0;
    return snapshot(battle);
  },

  faintEnemyActive(state) {
    const battle = restore(state);
    const foe = battle.p2.active[0]!;
    if (!battle.p2.pokemon.some((pokemon) => pokemon !== foe && !pokemon.fainted && pokemon.hp > 0)) return null;
    foe.faint();
    battle.faintMessages();
    battle.checkFainted();
    battle.makeRequest('switch');
    return snapshot(battle);
  },

  startStages(state) {
    const battle = restore(state);
    const stagesOf = (pokemon: Pokemon | undefined): PlanStages => {
      const out: PlanStages = {};
      if (pokemon === undefined) return out;
      for (const [stat, id] of Object.entries(STAGE_IDS) as [PlanStat, PlanBoostId][]) {
        const stage = pokemon.boosts[id];
        if (stage !== 0) out[stat] = stage;
      }
      return out;
    };
    return { player: stagesOf(battle.p1.active[0]), enemy: stagesOf(battle.p2.active[0]) };
  },

  trickRoom(state) {
    return restore(state).field.pseudoWeather['trickroom'] !== undefined;
  },

  weather(state) {
    const weather = restore(state).field.weather as string;
    const plan = PLAN_WEATHERS[weather];
    if (plan === undefined) throw new Error(`plan: the battle's weather "${weather}" is not one a plan step names`);
    return plan;
  },
};
