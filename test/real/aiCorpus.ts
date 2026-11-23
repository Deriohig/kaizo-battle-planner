// The trainer AI's differential corpus: every EnemyModel call the solver makes, run over
// the AI sweep's cases (test/real/aiSweep.test.ts: every single-battle catalog trainer and ROM copy, each party member
// as its lead, against the sweep's three fixed player leads), each reduced to a short digest. aiDifferentialSuite.ts
// compares a run with the golden file test/real/golden/aiDifferential.json, which aiDifferentialGolden.ts writes. A
// speed change to src/ai must leave every record as it is: every support (actions and exact probabilities, in order),
// every memory key, every replacement support and every refusal (code and message).
//
// Records, one per key; the key's first letter is its kind, so a later stream can add kinds without touching these:
// - `r/<case>`: the root. createBattle, then initialMemory and support on the root state, as the solver's entry member
//   does (src/solver/arena.ts expandEntry, then expandBattle).
// - `o/<case>/<a>.<j>`: on the deep cases only (below), outcome j of the turn the player's first legal choice and
//   the AI's root action a make (expandTurn, as arena.ts step does). Its memory is `remember` of the root memory and the
//   outcome; then, by the outcome's phase, `support` at a turn choice or `replacementSupport` at an enemy replacement or
//   mid-turn switch (arena.ts settle). A step with more than OUTCOMES_PER_STEP outcomes is followed at that many, spread
//   evenly (outcomeSample).
//   The deep cases are every CORPUS_K-th case, every case whose trainer has a bag item, and every FIELD_STRIDE-th case of
//   each field note (weather, fog, Trick Room, Gravity), so the reads those notes make are followed a turn too.
// - `o/<case>/<a>.<j>/<b>.<m>`: after a replacement support, outcome m of the step its action b makes ({ p2 }), again
//   remembered and settled, as settle does, down to REPLACEMENT_DEPTH replacements.
// A step whose expandTurn throws (LIMIT) records the error under the step's own key (`o/<case>/<a>`).
// - `f/<name>/…`: the hand-made battles of aiFixtures.ts, which have their own shard test; see that file.
//
// A case is `<ROM index>.<lead>.<player>`. Values: `k<memory key digest>;<decision>`, the decision being the actions
// in order (`m<slot>`, `s<index>`, an item's `i<id>` plus its consume slots and effect, else the choice's JSON, each
// `@<digest of num/den>`), `!<code>#<digest of message>` for a refusal, or `-` for a phase with no AI decision.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AiError } from '../../src/ai/errors.js';
import { worldsFor } from '../../src/ai/initialView.js';
import { createTrainerAi } from '../../src/ai/model.js';
import { type AiRomData, loadAiData } from '../../src/ai/rom/aiData.js';
import { buildCatalog } from '../../src/battle/catalog.js';
import { buildMoves, type KaizoMove } from '../../src/battle/moves.js';
import type { PlayerMon } from '../../src/battle/playerMon.js';
import type { LoadedData, ResolvedTrainer } from '../../src/battle/types.js';
import type { ActionSupport, AiMemory, EnemyModel } from '../../src/contracts/ai.js';
import type { BattleInput, Choice, EngineState, WorldAssignment } from '../../src/contracts/engine.js';
import { loadLocalData } from '../../src/data/load.js';
import { createBattle, expandTurn, installKaizoDex, legalChoices } from '../../src/engine/index.js';
import { fieldSpec } from '../../src/integration/resolver.js';
import { computeStats } from '../../src/rom/stats.js';
import type { Stats } from '../../src/rom/types.js';

/** The golden file's format. */
export const GOLDEN_FORMAT = 1;
/** Every CORPUS_K-th case (in case order) also runs one step deeper. */
export const CORPUS_K = 40;
/**
 * Of the cases whose trainer's field note is one note (the weather, fog, Trick Room or Gravity, as fieldSpec gives it),
 * every FIELD_STRIDE-th (in case order, from the first) also runs one step deeper. Every such case took about 17
 * times the differential's time (2469 of the 5361 cases have a note), so the corpus follows an eighth of each note.
 */
export const FIELD_STRIDE = 8;
/** The engine's leaf limit for the corpus's steps: a step over it records LIMIT. */
const MAX_LEAVES = 400;
/** How many replacement steps deep settle follows an outcome. */
const REPLACEMENT_DEPTH = 1;
/**
 * The most outcomes of one step the corpus follows, spread evenly over the step's outcomes (outcomeSample). One turn can
 * have hundreds (case 315.5.0's first step: 420, with a 118 ms support each), which alone would take a minute.
 */
const OUTCOMES_PER_STEP = 8;

/** The indices of the outcomes of an `n`-outcome step that the corpus follows: all, or OUTCOMES_PER_STEP spread evenly. */
export function outcomeSample(n: number): number[] {
  if (n <= OUTCOMES_PER_STEP) return Array.from({ length: n }, (_, j) => j);
  return Array.from({ length: OUTCOMES_PER_STEP }, (_, i) => Math.floor((i * n) / OUTCOMES_PER_STEP));
}

/** A player Pokémon as the save would give it: 31 IVs, full HP and PP, no PP Ups, no status (aiSweep.test.ts). */
interface PlayerSpec {
  species: number; name: string; ability: string; item: number; itemName: string; nature: number; gender: 'M' | 'F' | null;
  evs: Partial<Stats>; moves: string[];
}

/** The sweep's three Lv 50 player Pokémon (aiSweep.test.ts PLAYERS), copied so the corpus doesn't import a test file. */
const PLAYERS: PlayerSpec[] = [
  {
    species: 445, name: 'Garchomp', ability: 'Rough Skin', item: 287, itemName: 'Choice Scarf', nature: 13, gender: 'M',
    evs: { hp: 4, atk: 252, spe: 252 }, moves: ['Earthquake', 'Dragon Claw', 'Stone Edge', 'Swords Dance'],
  },
  {
    species: 94, name: 'Gengar', ability: 'Shadow Tag', item: 275, itemName: 'Focus Sash', nature: 10, gender: 'M',
    evs: { hp: 4, spa: 252, spe: 252 }, moves: ['Shadow Ball', 'Sludge Bomb', 'Thunderbolt', 'Focus Blast'],
  },
  {
    species: 205, name: 'Forretress', ability: 'Heatproof', item: 234, itemName: 'Leftovers', nature: 7, gender: 'F',
    evs: { hp: 252, def: 252, spd: 4 }, moves: ['Gyro Ball', 'Spikes', 'Toxic', 'Explosion'],
  },
];

function playerMon(spec: PlayerSpec, slot: number, data: LoadedData): PlayerMon {
  const record = data.rom.species[spec.species];
  if (record === undefined) throw new Error(`the ROM has no species ${spec.species}`);
  const name = data.names.species(spec.species);
  if (name !== spec.name) throw new Error(`species ${spec.species} is ${name}, not ${spec.name}`);
  const ability = data.names.abilityId(spec.ability);
  if (ability === null || !record.abilities.includes(ability)) throw new Error(`${spec.name} can't have ${spec.ability} in the hack`);
  const moves = spec.moves.map((move) => {
    const id = data.names.moveId(move);
    if (id === null) throw new Error(`the hack has no move ${move}`);
    return id;
  });
  const ivs: Stats = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  const evs: Stats = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...spec.evs };
  const stats = computeStats(record.baseStats, ivs, evs, 50, spec.nature);
  return {
    species: spec.species, form: 0, name, nickname: name, level: 50, gender: spec.gender, ivs, evs,
    nature: { value: spec.nature, source: 'rom', disputed: false, alternatives: [] },
    ability: { value: ability, source: 'rom', disputed: false, alternatives: [] },
    item: spec.item, moves, pp: moves.map((move) => data.rom.moves[move]!.pp), ppUps: moves.map(() => 0),
    baseStats: { ...record.baseStats }, types: [record.types[0], record.types[1]], friendship: 255,
    status: { kind: 'none' }, currentHp: stats.hp, location: { kind: 'party', slot }, notes: [],
  };
}

/** `trainer` with party member `lead` moved to the front, and `world` reindexed to match (aiSweep.test.ts withLead). */
function withLead(trainer: ResolvedTrainer, world: WorldAssignment, lead: number): { trainer: ResolvedTrainer; world: WorldAssignment } {
  const order = [lead, ...trainer.party.keys()].filter((index, at, all) => all.indexOf(index) === at);
  return {
    trainer: { ...trainer, party: order.map((index) => trainer.party[index]!) },
    world: { enemy: order.map((index) => world.enemy[index] ?? {}) },
  };
}

/** One case: its id, whether it runs the deeper step, and its battle start. */
export interface CorpusCase { id: string; deep: boolean; input: BattleInput }

/** Whether the ROM trainer `romIndex` has a bag item (`RomTrainer.items`, the engine's source of the trainer's bag). */
function hasBagItem(data: LoadedData, romIndex: number): boolean {
  const { trainers } = data.rom;
  const rom = trainers[romIndex]?.index === romIndex ? trainers[romIndex] : trainers.find((candidate) => candidate.index === romIndex);
  return rom !== undefined && rom.items.some((item) => item !== 0);
}

/** What a corpus run needs: the data the engine's dex is installed from, the AI over it, and the cases in order. */
export interface Corpus { data: LoadedData; ai: AiRomData; model: EnemyModel; cases: CorpusCase[] }

/**
 * The corpus over the data in `dataDir` (`<dataDir>/rom` for the AI): installs the engine's dex from it, makes the AI,
 * and lists the cases in the sweep's order (player lead, then trainer, then lead), every `k`-th one deep, and also the
 * ones with a bag item or a FIELD_STRIDE-th case of a field note.
 */
export function loadCorpus(dataDir: string, k: number = CORPUS_K): Corpus {
  const data = loadLocalData(dataDir);
  const ai = loadAiData(join(dataDir, 'rom'));
  installKaizoDex(data, buildMoves(data) as Map<number, KaizoMove>);
  const model = createTrainerAi(data, ai);
  const singles = buildCatalog(data).trainers.filter((trainer) => trainer.battleType === 'single');
  const variants = singles.flatMap((trainer) => trainer.variants.filter((variant) => variant.battleType === 'single'));
  const trainers = [...singles, ...variants];
  const mons = PLAYERS.map((spec, slot) => playerMon(spec, slot, data));
  const players = mons.map((lead) => [lead, ...mons.filter((mon) => mon !== lead)]
    .map((mon, slot): PlayerMon => ({ ...mon, location: { kind: 'party', slot } })));
  const cases: CorpusCase[] = [];
  const ids = new Set<string>();
  const notes = new Map<string, number>();
  players.forEach((player, p) => {
    for (const trainer of trainers) {
      const world = worldsFor(trainer)[0]!;
      for (let lead = 0; lead < trainer.party.length; lead++) {
        const input = withLead(trainer, world, lead);
        const id = `${trainer.romIndex}.${lead}.${p}`;
        if (ids.has(id)) throw new Error(`two corpus cases share the id ${id}`);
        ids.add(id);
        const field = fieldSpec(trainer.field);
        const note = JSON.stringify(field);
        const seen = notes.get(note) ?? 0;
        if (note !== '{}') notes.set(note, seen + 1);
        cases.push({
          id, deep: cases.length % k === 0 || hasBagItem(data, trainer.romIndex) || (note !== '{}' && seen % FIELD_STRIDE === 0),
          input: { player, trainer: input.trainer, field, world: input.world },
        });
      }
    }
  });
  return { data, ai, model, cases };
}

/** The first `n` hex digits of the SHA-256 of `text`. */
function digest(text: string, n: number): string {
  return createHash('sha256').update(text).digest('hex').slice(0, n);
}

/** JSON with every object's keys sorted. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A choice's short code: exact (the choice's whole content), readable for the common kinds. */
function choiceCode(choice: Choice): string {
  const keys = Object.keys(choice).sort().join();
  if (choice.kind === 'move' && keys === 'kind,slot') return `m${choice.slot}`;
  if (choice.kind === 'switch' && keys === 'index,kind') return `s${choice.index}`;
  if (choice.kind === 'item' && /^[a-z0-9]+$/.test(choice.item)) {
    const rest = { ...choice } as Record<string, unknown>;
    delete rest['kind'];
    delete rest['item'];
    const slots = choice.consumeSlots;
    delete rest['consumeSlots'];
    return `i${choice.item}${slots === undefined ? '' : `[${slots.join(' ')}]`}${Object.keys(rest).length === 0 ? '' : canonical(rest)}`;
  }
  return `j${canonical(choice)}`;
}

/** A support's digest: each action's code and the digest of its exact probability, in order. */
export function supportDigest(support: readonly ActionSupport[]): string {
  return support.map(({ choice, probability }) => `${choiceCode(choice)}@${digest(`${probability.num}/${probability.den}`, 10)}`).join(',');
}

/** A refusal's digest: the AiError's or engine error's code (else the class name) and the digest of its message. */
export function errorDigest(error: unknown): string {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code
    : error instanceof Error ? error.constructor.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return `!${code}#${digest(message, 10)}`;
}

/** A memory's digest: its canonical key's. */
export function memoryDigest(memory: AiMemory): string {
  return `k${digest(memory.key, 12)}`;
}

/** The phases at which the AI decides a replacement. */
export const REPLACING = new Set(['enemyReplacement', 'enemyMidTurnSwitch']);

/** Called with each state the corpus reaches, its record's key and the memory the AI has there, before its decision. */
export type CorpusVisitor = (key: string, state: EngineState, memory: AiMemory) => void;

/**
 * Runs `c` through `corpus.model` as the solver would, adding its records to `out`, and shows `visit` each state it
 * reaches. Only AiErrors and engine errors are recorded as refusals; anything else (a TypeError, a broken harness)
 * propagates.
 */
export function runCase(corpus: Corpus, c: CorpusCase, out: Map<string, string>, visit?: CorpusVisitor): void {
  const { model } = corpus;
  const put = (key: string, value: string): void => {
    if (out.has(key)) throw new Error(`the corpus records ${key} twice`);
    out.set(key, value);
  };
  const decide = (state: EngineState, memory: AiMemory): { text: string; support: ActionSupport[] | null } => {
    const kind = state.phase.kind;
    if (kind !== 'turnChoice' && !REPLACING.has(kind)) return { text: '-', support: null };
    try {
      const support = kind === 'turnChoice' ? model.support(state, memory) : model.replacementSupport(state, memory);
      return { text: supportDigest(support), support };
    } catch (error) {
      return { text: refusal(error), support: null };
    }
  };

  let root: EngineState;
  let memory: AiMemory;
  try {
    root = createBattle(c.input);
    memory = model.initialMemory(root);
  } catch (error) {
    put(`r/${c.id}`, refusal(error));
    return;
  }
  visit?.(`r/${c.id}`, root, memory);
  const first = decide(root, memory);
  put(`r/${c.id}`, `${memoryDigest(memory)};${first.text}`);
  if (!c.deep || first.support === null) return;
  const p1 = legalChoices(root, 'p1')[0];
  if (p1 === undefined) return;

  const step = (state: EngineState, choices: { p1?: Choice; p2?: Choice }, before: AiMemory, key: string, depth: number): void => {
    let outcomes;
    try {
      outcomes = expandTurn(state, choices, { maxLeaves: MAX_LEAVES });
    } catch (error) {
      put(key, refusal(error));
      return;
    }
    for (const j of outcomeSample(outcomes.length)) {
      const outcome = outcomes[j]!;
      const at = `${key}.${j}`;
      let after: AiMemory;
      try {
        after = model.remember(before, outcome);
      } catch (error) {
        put(at, refusal(error));
        continue;
      }
      visit?.(at, outcome.state, after);
      const next = decide(outcome.state, after);
      put(at, `${memoryDigest(after)};${next.text}`);
      if (next.support === null || !REPLACING.has(outcome.state.phase.kind) || depth >= REPLACEMENT_DEPTH) continue;
      next.support.forEach((action, b) => step(outcome.state, { p2: action.choice }, after, `${at}/${b}`, depth + 1));
    }
  };
  first.support.forEach((action, a) => step(root, { p1, p2: action.choice }, memory, `o/${c.id}/${a}`, 0));
}

/** An AiError's or engine error's digest; anything else is a harness failure and propagates. */
export function refusal(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (error instanceof AiError || typeof code === 'string') return errorDigest(error);
  throw error;
}

/** Every record of `cases` (all of `corpus`'s by default), in case order. */
export function runCorpus(corpus: Corpus, cases: readonly CorpusCase[] = corpus.cases): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of cases) runCase(corpus, c, out);
  return out;
}

/** The player lead a case id or record key names (its case id's last part): the shard its test file runs. NaN for a fixture's key (`f/…`), which belongs to the fixtures shard. */
export function playerOf(key: string): number {
  if (key.startsWith('f/')) return NaN;
  const id = key.includes('/') ? key.split('/')[1]! : key;
  return Number(id.slice(id.lastIndexOf('.') + 1));
}

/** The golden file: its format, its k, and the records by key. */
export interface Golden { format: number; k: number; records: Record<string, string> }

export const GOLDEN_PATH = join('test', 'real', 'golden', 'aiDifferential.json');

/** `golden` as the file holds it: one record per line, keys in the corpus's order. */
export function goldenText(golden: Golden): string {
  const lines = Object.entries(golden.records).map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{\n  "format": ${golden.format},\n  "k": ${golden.k},\n  "records": {\n${lines.join(',\n')}\n  }\n}\n`;
}

/** One differing record: its key and an action-by-action account of the difference. */
export interface RecordDiff { key: string; lines: string[] }

/** The decision part of a value split into its actions (or its refusal), for the diff. */
function parts(value: string | undefined): { memory: string; actions: string[] } {
  if (value === undefined) return { memory: '(absent)', actions: [] };
  if (value.startsWith('!')) return { memory: '', actions: [value] };
  const at = value.indexOf(';');
  const decision = value.slice(at + 1);
  return { memory: value.slice(0, at), actions: decision === '-' ? ['-'] : decision.split(',') };
}

/** The records of `actual` that differ from `golden`'s (missing, extra or changed), each with its diff, in key order. */
export function diffRecords(golden: Record<string, string>, actual: ReadonlyMap<string, string>): RecordDiff[] {
  const keys = [...new Set([...Object.keys(golden), ...actual.keys()])];
  const diffs: RecordDiff[] = [];
  for (const key of keys) {
    const want = golden[key];
    const got = actual.get(key);
    if (want === got) continue;
    const lines: string[] = [];
    if (want === undefined) lines.push(`new record ${got}`);
    else if (got === undefined) lines.push(`missing record (golden ${want})`);
    else {
      const [w, g] = [parts(want), parts(got)];
      if (w.memory !== g.memory) lines.push(`memory ${w.memory} -> ${g.memory}`);
      const n = Math.max(w.actions.length, g.actions.length);
      for (let i = 0; i < n; i++) {
        const [a, b] = [w.actions[i], g.actions[i]];
        if (a !== b) lines.push(`action ${i}: ${a ?? '(none)'} -> ${b ?? '(none)'}`);
      }
    }
    diffs.push({ key, lines });
  }
  return diffs;
}
