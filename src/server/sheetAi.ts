// The trainer AI's odds on the matchup sheet (`POST /api/sheet/ai/stream`, `SheetAiEvent` and `SheetAiJson` in
// src/contracts/api.ts): for each pair of a sheet, the AI's exact odds for its next move (`next`), and
// whom it sends in if its Pokémon faints while the player's is in (`ifFaints`). Each is the AI's odds in the pair's situation
// below, not a proof.
//
// The situation for a pair (the player's Pokémon P against the trainer's Pokémon at party index k):
// - the player's side: P leads, then the next five of the sheet's team in team order (a side is 1 to 6 Pokémon, as the AI's
//   party is), each as drafted: as its `PlayerMon` is, with the HP, status, item, level and moves the draft gives it, else
//   the save's.
// - The trainer: the sheet's copy with its party's slots 0 and k swapped, as a switch-in leaves the cartridge's party;
//   everyone at full HP, as `createBattle` starts them; its field note null, as the field is set by hand.
// - The field: the pair's own sheet field (`SheetPair.field`: the trainer's note and the weather the two Pokémon's
//   abilities bring in), set on the created battle. A weather is permanent, with no duration, which the AI reads as the
//   _PERM bit (src/ai/adapter.ts `fieldMaskOf`); Trick Room and Gravity are pseudo-weathers. A pair whose weather
//   is not settled (`field` null) is `unsupported`, as is every pair of a double battle.
// - The battle's own field spec (`BattleInput.field`, which the engine applies at the battle start: the
//   _PERM weather, Trick Room and Gravity): the trainer's note as `fieldSpec` gives it (src/integration/resolver.ts, as a line's battle gets it), its weather only where it is the pair's. The AI
//   reads it as the field note: a weather there is the _PERM weather a lead's own weather ability can't announce
//   itself into (src/ai/memory.ts `permWeather`), and Trick Room and Gravity there are the ones the engine started, which `setField` below leaves as they are.
//   Deep fog has no Showdown condition, so the AI takes the note's as the deep fog bit, which stands until a weather or a
//   Defog (src/ai/memory.ts `fog`; adapter.ts `fieldMaskOf`), never as no fog.
// - The memory: `initialMemory` of the battle as created (src/ai/model.ts:295, which takes only turn 1's turn choice),
//   before the field is set.
// - The trainer's disputed natures and abilities: the pair is worked out in every
//   candidate world, the resolver's own (`fightWorlds`, src/integration/resolver.ts:165: each disputed value's candidates,
//   the listed one first, natures that fight alike collapsed, multiplied over the party), each given to `createBattle`
//   by the swapped party's slots. Every world is worked out, then each part is answered (`partAnswer`):
//   - an `unproven` in any world (an AiError's, say) is the part's, the first in world order;
//   - else, when every world gives the same odds, those, `ok`;
//   - else `depends` (`dependsOn`) on the first disputed value, in party order, that alone decides them (within each of
//     its candidates every world agrees), with a case per group of its candidates that give the same odds;
//   - else, when no single value decides them, unproven, `DISPUTED`, naming the values whose change alone changes them.
//   A sheet with more than 16 worlds is `DISPUTED` for every pair, unchecked.
//
// The engine runs over the installed dex (`installKaizoDex`, process-wide). The server's deps are main.ts's, injected
// (`ServerDeps.sheetAi`): `baseDeps` (src/integration/baseDeps.ts), which the line builder's deps (lineDeps.ts) call on
// this thread too, over the same data: one dex, and one trainer AI per data load. Neither this file nor app.ts loads deps.ts.
//
// Cost: a 12 × 6 sheet is 72 pairs of AI calls, times its candidate worlds (at most 16). `createSheetAi` works each
// query out once per drafted team and save, yields to the event loop before its first pair (the deps load after it),
// after each pair and between a pair's worlds, so the server answers other requests meanwhile, and keeps the last 16
// answers. Streaming: the batch keeps each pair as it is finished and tells its streams (`SheetAi.stream`,
// behind `POST /api/sheet/ai/stream`), so a pair's odds go out as soon as they are worked out, and a stream that joins a
// running or kept batch is told the pairs done so far at once, then the rest. No route sends the whole answer
// (`SheetAi.odds`); the stream is that batch plus a listener.

import { AiError } from '../ai/index.js';
import type { KaizoMove } from '../battle/moves.js';
import type { PlayerMon } from '../battle/playerMon.js';
import type { ResolvedMon, ResolvedTrainer } from '../battle/types.js';
import type { CalcField } from '../calc/field.js';
import type { ActionSupport, AiMemory, EnemyModel } from '../contracts/ai.js';
import type { Choice, EngineState, FieldSpec, Rational, WorldAssignment } from '../contracts/engine.js';
import { oneLineMessage as oneLine } from '../docs/fetchDocs.js';
import type { FieldNote } from '../docs/teams.js';
import { add, BAG_ITEM_NAMES, bagItemId, cmp, createBattle, EngineError, eq, ONE, restore, snapshot, ZERO } from '../engine/index.js';
import { buildLookups, requestMoveId } from '../integration/battleView.js';
import { fieldSpec, fightWorlds } from '../integration/resolver.js';
import type { NameIndex } from '../names/nameIndex.js';
import { NATURES } from '../rom/natures.js';
import type { AiChoiceJson, AiOddsJson, SheetAiJson, SheetAiPairJson } from './apiTypes.js';
import { monRef } from './box.js';
import { rationalJson } from './json.js';
import { enemyKey, orderedPairs, type SheetBuilder } from './sheet.js';
import type { ServerData } from './state.js';

/** The engine calls the AI odds make: `createBattle` (src/engine/battle.ts:75), `restore` (:156) and `snapshot` (:142). */
export interface SheetEngine { createBattle: typeof createBattle; restore: typeof restore; snapshot: typeof snapshot }

/** The engine's own calls, over the installed dex. */
export const SHOWDOWN_SHEET_ENGINE: SheetEngine = { createBattle, restore, snapshot };

/**
 * What the AI odds run on (`ServerDeps.sheetAi`): the trainer AI (`EnemyModel`, src/contracts/ai.ts; `createTrainerAi`,
 * src/ai/model.ts:262) and the engine calls, over a dex installed from the same data.
 */
export interface SheetAiDeps { model: EnemyModel; engine: SheetEngine }

const DOUBLE_REASON = 'The AI odds are for single battles only';
const UNSETTLED_REASON = 'The weather is not settled for this pair';
const NOTHING_LEFT_REASON = 'Nothing left to send in';

/**
 * One pair of a sheet: the player's `player`, a member of `team` (the sheet's team, in its order, each as drafted), against
 * the Pokémon at party index `enemy` of `trainer` (the copy the sheet shows), on the pair's sheet `field`
 * (`SheetPair.field`, null when its weather is not settled).
 */
export interface PairInput { team: PlayerMon[]; player: PlayerMon; trainer: ResolvedTrainer; enemy: number; field: CalcField | null }

/** A pair's battle, ready for the AI (see the top of the file). */
export interface PairSituation {
  /** Turn 1's turn choice, with the pair's field set. */
  state: EngineState;
  /** The AI's memory of the battle as created, before the field was set. */
  memory: AiMemory;
  /** The trainer's party as the battle has it (slots 0 and `enemy` swapped): a switch's `index` names a Pokémon here. */
  party: ResolvedMon[];
  /** The copy's party index of the pair's Pokémon, which leads. */
  enemy: number;
}

/** The most Pokémon a side brings: the AI's party size (MAX_PARTY_SIZE, src/ai/initialView.ts:44). */
const MAX_SIDE = 6;

/** `party` with slots 0 and `k` swapped, as a switch-in leaves the cartridge's party. */
function swapped<T>(party: readonly T[], k: number): T[] {
  const out = [...party];
  [out[0], out[k]] = [out[k]!, out[0]!];
  return out;
}

/** The party index of the Pokémon in slot `slot` once slots 0 and `k` are swapped (the swap is its own inverse). */
const swappedIndex = (slot: number, k: number) => (slot === 0 ? k : slot === k ? 0 : slot);

/**
 * The battle `pair` is worked out in (see the top of the file), in candidate `world` (by the swapped party's slots;
 * left out, each Pokémon's listed values). Throws what `createBattle` throws (`EngineError`, and a RangeError for a
 * Pokémon at 0 HP), what `initialMemory` throws (an `AiError`), and an Error when Showdown refuses a part of the field.
 */
export function pairSituation(deps: SheetAiDeps, pair: PairInput & { field: CalcField }, world?: WorldAssignment): PairSituation {
  const { engine, model } = deps;
  const player = [pair.player, ...pair.team.filter((mon) => mon !== pair.player)].slice(0, MAX_SIDE);
  const party = swapped(pair.trainer.party, pair.enemy);
  const field = noteField(pair.trainer.field, pair.field);
  const start = engine.createBattle({ player, trainer: { ...pair.trainer, field: null, party }, field, ...(world !== undefined && { world }) });
  const memory = model.initialMemory(start);
  const battle = engine.restore(start);
  setField(battle, pair.field);
  return { state: engine.snapshot(battle), memory, party, enemy: pair.enemy };
}

/**
 * The battle's own field spec for a pair on `pairField` (see the top of the file): the trainer's `note` as `fieldSpec`
 * gives it to `createBattle`, with its weather only where it is the pair's.
 */
function noteField(note: FieldNote | null, pairField: CalcField): FieldSpec {
  const { weather, ...rest } = fieldSpec(note);
  return weather !== undefined && weather === pairField.weather ? { weather, ...rest } : rest;
}

const SHOWDOWN_WEATHERS = { rain: 'raindance', sun: 'sunnyday', sand: 'sandstorm', hail: 'hail' } as const;

/**
 * Sets `field` on `battle` from the trainer's side: the weather with no duration, so it never ends (a lead's weather
 * ability has brought it in already when it is the pair's), and Trick Room and Gravity as Showdown's pseudo-weathers,
 * with their moves' duration. Throws when Showdown refuses one. A docs field note never sets screens, so a sheet pair's
 * field has none; fog is `pairSituation`'s.
 */
function setField(battle: Battle, field: CalcField): void {
  const source = battle.p2.active[0]!;
  if (field.weather !== undefined) {
    const weather = SHOWDOWN_WEATHERS[field.weather];
    if (battle.field.weather !== weather && !battle.field.setWeather(weather, source)) {
      throw new Error(`Showdown refused the field's ${weather}`);
    }
    battle.field.weatherState.duration = 0;
  }
  for (const [on, id] of [[field.trickRoom, 'trickroom'], [field.gravity, 'gravity']] as const) {
    // The engine starts the note's own Trick Room and Gravity; only one the note lacks is added here.
    if (on === true && !battle.field.pseudoWeather[id] && !battle.field.addPseudoWeather(id, source)) throw new Error(`Showdown refused the field's ${id}`);
  }
}

/** A pair's two answers. */
interface PairOdds { next: AiOddsJson; ifFaints: AiOddsJson }

const both = (odds: AiOddsJson): PairOdds => ({ next: odds, ifFaints: odds });

/** The most candidate worlds a sheet is worked out in. */
const MAX_WORLDS = 16;
const COMBINED_REASON = "Depends on the trainer's disputed natures and abilities";

/**
 * The trainer copy's disputed values, the same for every pair of a sheet: how many candidate worlds there are, and each
 * disputed value (`values`) by its key ("<party index>:nature" or ":ability"), the keys in party order (`order`). Each
 * Pokémon's candidates are `fightWorlds`' for it alone; their product is the worlds.
 */
interface SheetDisputes { worlds: number; order: string[]; values: ReadonlyMap<string, DisputedValue> }

/**
 * One disputed value: whose and which (`on`), "Forretress's nature", or "Zigzagoon (slot 3)'s ability" for two of one
 * species; and its candidates in `fightWorlds`' order, the listed one first, each with its name ("Hardy").
 */
interface DisputedValue { on: string; candidates: { value: number; name: string }[] }

function sheetDisputes(party: readonly ResolvedMon[], names: NameIndex): SheetDisputes {
  const order: string[] = [];
  const values = new Map<string, DisputedValue>();
  let worlds = 1;
  party.forEach((mon, index) => {
    const own = fightWorlds([mon]);
    worlds *= own.length;
    const entries = own.flatMap((world) => world.enemy.slice(0, 1));
    const same = party.filter((other) => other.name === mon.name).length > 1;
    const who = same ? `${mon.name} (slot ${index + 1})` : mon.name;
    for (const [field, nameOf] of [['nature', natureName], ['ability', (id: number) => names.ability(id)]] as const) {
      const candidates = [...new Set(entries.flatMap((entry) => (entry[field] === undefined ? [] : [entry[field]])))];
      if (candidates.length < 2) continue;
      const key = `${index}:${field}`;
      order.push(key);
      values.set(key, { on: `${who}'s ${field}`, candidates: candidates.map((value) => ({ value, name: nameOf(value) })) });
    }
  });
  return { worlds, order, values };
}

const natureName = (id: number) => NATURES[id] ?? `(nature ${id})`;

/** A disputed value as a reason names it, with its candidates: "Forretress's nature (Hardy or Sassy)". */
const disputedName = (disputed: DisputedValue) => `${disputed.on} (${orList(disputed.candidates.map((c) => c.name))})`;

/** "A", "A or B", "A, B or C". */
const orList = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)!}`);

/**
 * A pair's candidate world (by the swapped party's slots), the disputed values it changes from the listed ones, and its
 * candidate for each disputed value (`values`), both by `SheetDisputes`' keys, which use the copy's own party indexes.
 */
interface PairWorld { world: WorldAssignment; changes: string[]; values: ReadonlyMap<string, number> }

const DISPUTABLE = ['nature', 'ability'] as const;

/**
 * The candidate worlds of the pair against party index `k`: `fightWorlds` of the swapped party, so `world.enemy[i]` is
 * for the Pokémon now in slot i. The listed values' world comes first, then those that change one value, then the rest.
 */
function pairWorlds(party: readonly ResolvedMon[], k: number): PairWorld[] {
  const worlds = fightWorlds(swapped(party, k));
  const listed = worlds[0]!;
  const changesOf = (world: WorldAssignment) => world.enemy.flatMap((entry, slot) => DISPUTABLE
    .filter((field) => entry[field] !== listed.enemy[slot]?.[field])
    .map((field) => `${swappedIndex(slot, k)}:${field}`));
  const valuesOf = (world: WorldAssignment) => new Map(world.enemy.flatMap((entry, slot) => DISPUTABLE.flatMap((field) => {
    const value = entry[field];
    return value === undefined ? [] : [[`${swappedIndex(slot, k)}:${field}`, value] as const];
  })));
  return worlds
    .map((world) => ({ world, changes: changesOf(world), values: valuesOf(world) }))
    .sort((a, b) => a.changes.length - b.changes.length);
}

/** A part's odds in one of a pair's candidate worlds. */
interface WorldOdds { world: PairWorld; odds: AiOddsJson }

/**
 * One part's answer from its odds in every one of a pair's worlds (`pairWorlds`' order, the listed values' first): the
 * first `unproven` (an AiError's and the like); else the odds every world gives, when they all agree; else `dependsOn`'s
 * answer, when one disputed value decides them; else `DISPUTED`, naming the values whose change alone changes them.
 */
function partAnswer(answers: readonly WorldOdds[], disputes: SheetDisputes): AiOddsJson {
  const failed = answers.find(({ odds }) => odds.status === 'unproven');
  if (failed !== undefined) return failed.odds;
  const keys = answers.map(({ odds }) => JSON.stringify(odds));
  if (keys.every((key) => key === keys[0])) return answers[0]!.odds;
  const depends = dependsOn(answers, disputes);
  if (depends !== null) return depends;
  const changed = new Set(answers.flatMap(({ world }, i) => (world.changes.length === 1 && keys[i] !== keys[0] ? world.changes : [])));
  const names = disputes.order.filter((key) => changed.has(key)).map((key) => disputedName(disputes.values.get(key)!));
  return { status: 'unproven', code: 'DISPUTED', reason: names.length === 0 ? COMBINED_REASON : `Depends on ${names.join('; ')}` };
}

/**
 * The `depends` answer for a part whose worlds' odds disagree, or null when no single disputed value
 * decides them. A value decides them when, within each of its candidates, every world gives the same odds; the first
 * that does, in party order (`SheetDisputes.order`), is the answer's `on`. It has one case per group of its candidates
 * that give the same odds, in candidate order, so the group holding the listed value comes first; a case's `when` lists
 * its values ("Hardy or Bold") and its `choices` are their odds'. Null too unless every world's odds are `ok`, since a
 * case holds choices.
 */
function dependsOn(answers: readonly WorldOdds[], disputes: SheetDisputes): AiOddsJson | null {
  type Ok = { world: PairWorld; choices: AiChoiceJson[]; key: string };
  const oks = answers.flatMap(({ world, odds }): Ok[] => (odds.status === 'ok' ? [{ world, choices: odds.choices, key: JSON.stringify(odds.choices) }] : []));
  if (oks.length < answers.length) return null;
  for (const id of disputes.order) {
    const disputed = disputes.values.get(id)!;
    const byCandidate = new Map<number, Ok>();
    const decides = oks.every((ok) => {
      const value = ok.world.values.get(id);
      if (value === undefined) return false;
      const first = byCandidate.get(value) ?? ok;
      byCandidate.set(value, first);
      return first.key === ok.key;
    });
    if (!decides || disputed.candidates.some(({ value }) => !byCandidate.has(value))) continue;
    const cases: { when: string[]; choices: AiChoiceJson[]; key: string }[] = [];
    for (const { value, name } of disputed.candidates) {
      const { choices, key } = byCandidate.get(value)!;
      const same = cases.find((c) => c.key === key);
      if (same === undefined) cases.push({ when: [name], choices, key });
      else same.when.push(name);
    }
    return { status: 'depends', on: disputed.on, cases: cases.map(({ when, choices }) => ({ when: orList(when), choices })) };
  }
  return null;
}

/** What every pair of a sheet shares: the hack's moves, the trainer's disputes, and the batch's pause between worlds. */
interface PairContext { moves: ReadonlyMap<number, KaizoMove>; disputes: SheetDisputes; pause(): Promise<void> }

/**
 * The AI's odds for `pair`: `next` (`nextOdds`) and `ifFaints` (`replacementOdds`) on its situation in every candidate
 * world (see the top of the file), pausing between worlds, then each part's `partAnswer`. Both are `unsupported` for a
 * double battle (which `createBattle` refuses, src/engine/battle.ts:77) or an unsettled weather. A part that throws in a
 * world is that part's `unproven` there, and a situation that can't be built makes both so: one pair never fails the
 * batch.
 */
async function pairOdds(deps: SheetAiDeps, pair: PairInput, ctx: PairContext): Promise<PairOdds> {
  if (pair.trainer.battleType === 'double') return both({ status: 'unsupported', reason: DOUBLE_REASON });
  if (pair.field === null) return both({ status: 'unsupported', reason: UNSETTLED_REASON });
  const { worlds } = ctx.disputes;
  if (worlds > MAX_WORLDS) {
    return both({ status: 'unproven', code: 'DISPUTED', reason: `Too many disputed natures and abilities to check (${worlds} combinations)` });
  }
  const field = pair.field;
  const next: WorldOdds[] = [];
  const ifFaints: WorldOdds[] = [];
  for (const [i, world] of pairWorlds(pair.trainer.party, pair.enemy).entries()) {
    if (i > 0) await ctx.pause();
    let situation: PairSituation;
    try {
      situation = pairSituation(deps, { ...pair, field }, world.world);
    } catch (error) {
      next.push({ world, odds: unproven(error) });
      ifFaints.push({ world, odds: unproven(error) });
      continue;
    }
    next.push({ world, odds: nextOdds(deps, situation, ctx.moves) });
    ifFaints.push({ world, odds: replacementOdds(deps, situation, ctx.moves) });
  }
  return { next: partAnswer(next, ctx.disputes), ifFaints: partAnswer(ifFaints, ctx.disputes) };
}

/** `next`: the AI's `support` on the situation (src/ai/model.ts:302), each choice named as the battle has it. */
function nextOdds(deps: SheetAiDeps, situation: PairSituation, moves: ReadonlyMap<number, KaizoMove>): AiOddsJson {
  try {
    const support = deps.model.support(situation.state, situation.memory);
    const battle = deps.engine.restore(situation.state);
    return okOdds(support, (choice) => choiceLabel(choice, battle, situation, moves, (name) => `Switches to ${name}`));
  } catch (error) {
    return unproven(error);
  }
}

/**
 * `ifFaints`: the trainer's Pokémon fainted on the situation's battle as Showdown faints one (pokemon-showdown
 * dist/sim/pokemon.js:1147 `faint`; dist/sim/battle.js:2073 `faintMessages`, :2063 `checkFainted`, :1139
 * `makeRequest`), which the engine reads as `enemyReplacement` (src/engine/battle.ts:206 `phaseOf`); then the AI's
 * `replacementSupport` (src/ai/model.ts:352), a switch named by the species alone. `none` with no other Pokémon alive.
 */
function replacementOdds(deps: SheetAiDeps, situation: PairSituation, moves: ReadonlyMap<number, KaizoMove>): AiOddsJson {
  try {
    const battle = deps.engine.restore(situation.state);
    const foe = battle.p2.active[0]!;
    if (!battle.p2.pokemon.some((pokemon) => pokemon !== foe && !pokemon.fainted && pokemon.hp > 0)) {
      return { status: 'none', reason: NOTHING_LEFT_REASON };
    }
    foe.faint();
    battle.faintMessages();
    battle.checkFainted();
    battle.makeRequest('switch');
    const fainted = deps.engine.snapshot(battle);
    if (fainted.phase.kind !== 'enemyReplacement') {
      return { status: 'unproven', code: 'NO_REPLACEMENT', reason: `The battle did not reach the trainer's send-in: it waits on ${fainted.phase.kind}` };
    }
    const support = deps.model.replacementSupport(fainted, situation.memory);
    return okOdds(support, (choice) => choiceLabel(choice, battle, situation, moves, (name) => name));
  } catch (error) {
    return unproven(error);
  }
}

/** A choice as named, and for a switch the Pokémon's party slot as the sheet numbers it (from 1, the copy's own order). */
type Labelled = { label: string; kind: Choice['kind']; slot?: number };

/** Each bag item's name by the id a Choice gives it (`bagItemId`): "fullrestore" is "Full Restore". */
const BAG_NAMES: ReadonlyMap<string, string> = new Map(Object.entries(BAG_ITEM_NAMES).map(([id, name]) => [bagItemId(Number(id)), name]));

/** The hack's move names by Showdown move ID (`buildLookups`, src/integration/battleView.ts:43), made once per move table. */
const moveNamesByTable = new WeakMap<ReadonlyMap<number, KaizoMove>, Map<string, string>>();

function moveNames(moves: ReadonlyMap<number, KaizoMove>): Map<string, string> {
  let names = moveNamesByTable.get(moves);
  if (names === undefined) {
    names = new Map([...buildLookups(moves).byId].map(([id, move]) => [id, move.name]));
    moveNamesByTable.set(moves, names);
  }
  return names;
}

/**
 * A choice of the trainer's as the sheet names it: a move by its hack name (the request's move at its slot,
 * battleView.ts:199 `requestMoveId`), a switch by `switchText` of the species at its index in the battle's party
 * (`situation.party`), with its slot in the copy's own party, a bag item by its bag name.
 */
function choiceLabel(
  choice: Choice, battle: Battle, situation: PairSituation, moves: ReadonlyMap<number, KaizoMove>, switchText: (name: string) => string,
): Labelled {
  switch (choice.kind) {
    case 'move': {
      const id = requestMoveId(battle, 'p2', choice.slot);
      const label = id === undefined ? `move ${choice.slot + 1}` : moveNames(moves).get(id) ?? battle.dex.moves.get(id).name;
      return { kind: 'move', label };
    }
    case 'switch': {
      const mon = situation.party[choice.index];
      if (mon === undefined) return { kind: 'switch', label: switchText(`party member ${choice.index + 1}`) };
      return { kind: 'switch', label: switchText(mon.name), slot: swappedIndex(choice.index, situation.enemy) + 1 };
    }
    case 'item':
      return { kind: 'item', label: BAG_NAMES.get(choice.item) ?? choice.item };
  }
}

/**
 * An `ok` answer from `support`: the choices named by `label`, two Pokémon of one species with their party slots
 * ("Zigzagoon (slot 3)"), those with the same name and kind summed (two uses of an item that empty different bag slots,
 * say), sorted by probability, highest first, then by name. `unproven` unless the probabilities sum to exactly 1.
 */
function okOdds(support: readonly ActionSupport[], label: (choice: Choice) => Labelled): AiOddsJson {
  const named = support.map(({ choice, probability }) => ({ ...label(choice), probability }));
  const slots = new Map<string, Set<number>>();
  for (const { label: name, slot } of named) if (slot !== undefined) slots.set(name, (slots.get(name) ?? new Set()).add(slot));
  const merged = new Map<string, Labelled & { probability: Rational }>();
  let sum = ZERO;
  for (const choice of named) {
    const { slot, probability } = choice;
    const text = slot !== undefined && slots.get(choice.label)!.size > 1 ? `${choice.label} (slot ${slot})` : choice.label;
    const key = `${choice.kind}|${text}`;
    const same = merged.get(key);
    merged.set(key, { kind: choice.kind, label: text, probability: same === undefined ? probability : add(same.probability, probability) });
    sum = add(sum, probability);
  }
  if (!eq(sum, ONE)) return { status: 'unproven', code: 'BAD_SUPPORT', reason: `The AI's odds sum to ${rationalJson(sum)}, not 1` };
  const choices = [...merged.values()].sort((a, b) => cmp(b.probability, a.probability) || a.label.localeCompare(b.label));
  return { status: 'ok', choices: choices.map((c) => ({ label: c.label, kind: c.kind, probability: rationalJson(c.probability) })) };
}

/** A failure as a part's `unproven`: an `AiError`'s or `EngineError`'s code, else the error's name, and its message. */
function unproven(error: unknown): AiOddsJson {
  const code = error instanceof AiError || error instanceof EngineError ? error.code : error instanceof Error ? error.name : 'Error';
  return { status: 'unproven', code, reason: oneLine(error) };
}

/** A sheet request (`POST /api/sheet/ai/stream`'s body, resolved: `draftedFight` in app.ts) and the save its team was read from. */
export interface SheetAiQuery {
  data: ServerData;
  /** The trainer copy the sheet shows, and its index among the trainer's copies. */
  trainer: ResolvedTrainer; variant: number;
  /** The team in order, each Pokémon as drafted. */
  team: PlayerMon[];
  /** The box's `savedAt` and `savePath` (`BoxJson`). */
  save: { savedAt: string; savePath: string };
}

/** What a stream of a batch is told (`SheetAi.stream`), in this order. */
export interface SheetAiListener {
  /** Once, first: the sheet's number of pairs, as soon as the batch has built the sheet. */
  start(total: number): void;
  /** Each pair's answer, in the sheet's pair order, as it is worked out. */
  pair(pair: SheetAiPairJson): void;
}

export interface SheetAi {
  /**
   * The AI's odds for every pair of the query's sheet, in the sheet's pair order (`orderedPairs`), with the save's
   * `savedAt` and `savePath`. One computation per trainer copy, drafted team and save, shared by every request for it
   * (`stream`'s too); the last 16 are kept. No route answers with it: the stream route is `stream`. `signal` is the
   * request's, aborted when it closes: a batch runs while one of the requests waiting on it is open (or gave no signal),
   * and once every one has closed it stops at its next yield and rejects (`AbandonedError`). Rejects too when the deps or
   * the sheet can't be built. A batch that rejects is not kept.
   */
  odds(query: SheetAiQuery, signal?: AbortSignal): Promise<SheetAiJson>;
  /**
   * `odds`' batch, followed as it goes: `listener.start`, then `listener.pair` for each pair, those already worked out
   * at once (within this call; for a kept batch, every one), the rest as each is finished. Answers and rejects as `odds`
   * does, after the last pair is told. The stream is one of the batch's waiters by `signal`: once that is aborted, its
   * listener is told nothing more.
   */
  stream(query: SheetAiQuery, listener: SheetAiListener, signal?: AbortSignal): Promise<SheetAiJson>;
}

/** Why a batch stopped: every request waiting on it closed. */
export class AbandonedError extends Error {
  constructor() {
    super('Every request for these AI odds has closed');
    this.name = 'AbandonedError';
  }
}

const MAX_ANSWERS = 16;

/** A turn of the event loop, so the server answers other requests meanwhile. */
const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * What a batch has worked out so far: the sheet's number of pairs once it is built (`total`), the pairs finished, in the
 * sheet's order, and its streams' catch-ups (`streams`), each run once `total` is set and after each pair.
 */
interface Progress { total: number | null; pairs: SheetAiPairJson[]; streams: Set<() => void> }

/**
 * One query's batch: its answer, whether it has come, the signals of the requests waiting on it (null: never closes),
 * and its progress.
 */
interface Batch { answer: Promise<SheetAiJson>; done: boolean; waiters: (AbortSignal | null)[]; progress: Progress }

/** Runs each of `progress`' stream catch-ups. One that throws is dropped and logged; the batch and the others go on. */
function tell(progress: Progress): void {
  for (const catchUp of progress.streams) {
    try {
      catchUp();
    } catch (error) {
      progress.streams.delete(catchUp);
      console.error('A stream of the sheet\'s AI odds failed:', error);
    }
  }
}

/**
 * The batch and its cache. `deps` gives the AI deps for a data load (the server's, which main.ts injects, or a test's);
 * `buildSheet` is the sheet route's. A new data load clears the cache. Past 16 answers the oldest finished one goes;
 * a batch still running is never evicted, so a request for it always joins it.
 */
export function createSheetAi(opts: { deps: (data: ServerData) => SheetAiDeps; buildSheet: SheetBuilder }): SheetAi {
  const answers = new Map<string, Batch>();
  let answersFor: ServerData | null = null;

  /** Drops the oldest finished batches while more than `MAX_ANSWERS` are kept. */
  function evict(): void {
    for (const [key, batch] of answers) {
      if (answers.size <= MAX_ANSWERS) return;
      if (batch.done) answers.delete(key);
    }
  }

  /**
   * `query`'s odds, `pause` at every yield: a turn of the event loop, then a stop if no one waits any more. The first
   * comes before anything else, the deps' first-use load included, so none of it runs in the request's own turn. Each
   * finished pair goes into `progress`, and the streams are told, before the next yield.
   */
  async function work(query: SheetAiQuery, progress: Progress, pause: () => Promise<void>): Promise<SheetAiJson> {
    await pause();
    const deps = opts.deps(query.data);
    // The sheet `POST /api/sheet` gives for the same body: each Pokémon on the HP it carries.
    const sheet = opts.buildSheet(query.team, query.trainer, { moves: query.data.moves, hp: 'save' });
    const ctx: PairContext = { moves: query.data.moves, disputes: sheetDisputes(query.trainer.party, query.data.local.names), pause };
    const { placed } = orderedPairs(sheet);
    progress.total = placed.length;
    tell(progress);
    for (const { pair, enemy } of placed) {
      const odds = await pairOdds(deps, { team: query.team, player: pair.player, trainer: query.trainer, enemy, field: pair.field }, ctx);
      progress.pairs.push({ player: monRef(pair.player.location), enemy: enemyKey(enemy), ...odds });
      tell(progress);
      await pause();
    }
    return { savedAt: query.save.savedAt, savePath: query.save.savePath, pairs: progress.pairs };
  }

  /**
   * The batch for `query`, with `signal`'s request among its waiters while it runs: the one kept for the query and save,
   * else a new one, started and kept.
   */
  function join(query: SheetAiQuery, signal: AbortSignal | undefined): Batch {
    if (query.data !== answersFor) {
      answers.clear();
      answersFor = query.data;
    }
    // Each team member is in the key whole: a draft that changes anything of one (its HP, status, item, level) is another
    // answer, never reused; two drafts that give equal Pokémon share one.
    const key = JSON.stringify([query.trainer.id, query.variant, query.team, query.save.savedAt, query.save.savePath]);
    const kept = answers.get(key);
    if (kept !== undefined) {
      if (!kept.done) kept.waiters.push(signal ?? null);
      return kept;
    }
    const waiters = [signal ?? null];
    const progress: Progress = { total: null, pairs: [], streams: new Set() };
    const answer = work(query, progress, async () => {
      await yieldNow();
      if (!waiters.some((waiter) => waiter === null || !waiter.aborted)) throw new AbandonedError();
    });
    const batch: Batch = { answer, done: false, waiters, progress };
    answers.set(key, batch);
    evict();
    answer.then(
      () => {
        batch.done = true;
        waiters.length = 0;
        progress.streams.clear();
        evict();
      },
      () => {
        progress.streams.clear();
        if (answers.get(key) === batch) answers.delete(key);
      },
    );
    return batch;
  }

  return {
    odds: (query, signal) => join(query, signal).answer,
    stream(query, listener, signal) {
      const batch = join(query, signal);
      const { progress } = batch;
      let started = false;
      let told = 0;
      /** Tells `listener` what it has not been told yet; nothing, and no more, once `signal` is aborted. */
      const catchUp = () => {
        if (signal?.aborted === true) {
          progress.streams.delete(catchUp);
          return;
        }
        if (!started && progress.total !== null) {
          started = true;
          listener.start(progress.total);
        }
        while (told < progress.pairs.length) listener.pair(progress.pairs[told++]!);
      };
      catchUp();
      if (!batch.done) progress.streams.add(catchUp);
      return batch.answer;
    },
  };
}
