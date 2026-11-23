// The trainer AI's hand-made battles: the rare reads the sweep's corpus (aiCorpus.ts) never
// reaches, each driven on the real engine to the situation it names, then recorded as the corpus records a battle: the
// AI's `support` (or `replacementSupport`) at every state and `remember`'s memory key at every outcome. The engine-run
// cases of test/unit/ai/adapter.test.ts and model.test.ts are the models; these run on the real ROM data and the real AI
// script, so a read that the script makes shows in a decision, and one it doesn't shows in the memory key.
//
// Records, one per key (kind `f`, which the golden file's other kinds leave alone):
// - `f/<name>/0`: the battle's root: `initialMemory`, then `support`.
// - `f/<name>/<t>.<j>`: outcome j of step t (t from 1): the memory is `remember` of the step's start memory and the
//   outcome; then `support` at a turn choice, `replacementSupport` at an enemy replacement or mid-turn switch, `-` at a
//   phase the AI doesn't decide (the player's). A step with more than OUTCOMES_PER_STEP outcomes is followed at that many
//   spread evenly (outcomeSample) plus the outcome the fixture goes on from. Values are the corpus's (`k<digest>;<decision>`).
//
// A fixture is a script of steps. Each step names the choices the two sides make (a move by name, a switch, the trainer's
// bag item) and the outcome the battle goes on from (the likeliest, or the likeliest whose log matches `want`). The step
// throws (a harness error, never a record) when its choice is refused or no outcome matches, so a fixture that stops
// reaching its situation fails the generator rather than quietly recording another one. The engine's own refusals
// (an EngineError, or a non-empty `unmodelledIn`) are a finding: the fixture is left out, and docs/ai-fixtures.md lists it.

import PS from 'pokemon-showdown';
import type { ActionSupport, AiMemory } from '../../src/contracts/ai.js';
import type { BattleInput, Choice, EngineState, FieldSpec, Outcome, Side } from '../../src/contracts/engine.js';
import type { PlayerMon } from '../../src/battle/playerMon.js';
import type { StartStatus } from '../../src/save/status.js';
import type { ResolvedMon, ResolvedTrainer } from '../../src/battle/types.js';
import { createBattle, EngineError, expandTurn, legalChoices, restore, unmodelledIn } from '../../src/engine/index.js';
import { personalRowFor } from '../../src/rom/forms.js';
import { computeStats } from '../../src/rom/stats.js';
import type { Stats } from '../../src/rom/types.js';
import { type Corpus, memoryDigest, outcomeSample, refusal, REPLACING, supportDigest } from './aiCorpus.js';

const { toID } = PS;

/** A Pokémon of a fixture, by names. */
export interface MonSpec {
  species: string; ability: string; moves: string[];
  /** Absent means no item. */
  item?: string; level?: number; gender?: 'M' | 'F' | null; nature?: number; evs?: Partial<Stats>;
}

/** What one side does in a step: a move by name (or its slot), the first legal choice, a switch, or the bag item. */
export type Act = string | number | 'first' | { switch: number } | { item: true };

/** One step: both sides' acts (a side with nothing to choose is left out) and the outcome the fixture goes on from. */
export interface Step {
  p1?: Act; p2?: Act;
  /** The step's outcome is the likeliest one whose log (lines joined by newlines) matches; absent means the likeliest. */
  want?: RegExp;
  /** The leaf limit of the step's `expandTurn`; absent means 400, the corpus's. */
  maxLeaves?: number;
}

/**
 * One hand-made battle. `rom` is the ROM trainer whose AI flags and bag the battle takes (the engine reads both by the
 * trainer's ROM index): NO_BAG's or BAG's by default. `startStatus` is the player's pre-status by party index.
 */
export interface Fixture {
  name: string; player: MonSpec[]; enemy: MonSpec[]; steps: Step[]; rom?: number; field?: FieldSpec;
  startStatus?: Record<number, StartStatus>;
  /** What the battle is for, for the report; never read. */
  why: string;
}

/** ROM trainer 1: single, AI flags Basic, EvalAttack and Expert (mask 7), no bag. */
export const NO_BAG = 1;
/** ROM trainer 261: single, the same flags, a bag of two of item 23. */
export const BAG = 261;

const MAX_LEAVES = 400;
const OUTCOMES_PER_STEP = 8;

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`fixtures: ${what}`);
  return value;
}

/** A Pokémon's item ROM IDs by the @pkmn/dex name (`names.item`), built once per corpus. */
const itemIds = new WeakMap<Corpus, Map<string, number>>();
function itemIdOf(corpus: Corpus, name: string): number {
  let map = itemIds.get(corpus);
  if (map === undefined) {
    map = new Map();
    for (let id = 1; id < 600; id++) {
      const itemName = corpus.data.names.item(id);
      if (!itemName.startsWith('(item')) map.set(toID(itemName), id);
    }
    itemIds.set(corpus, map);
  }
  return need(map.get(toID(name)), `no item named ${name}`);
}

/** The battle-ready Pokémon a spec names: the ROM's base stats, 31 IVs, no PP Ups, full HP; the trainer's have no EVs. */
function monOf(corpus: Corpus, spec: MonSpec): ResolvedMon {
  const { data } = corpus;
  const form = need(data.names.speciesId(spec.species), `no species named ${spec.species}`);
  const record = need(data.rom.species[personalRowFor(form.id, form.form)], `the ROM has no species ${form.id}`);
  const ability = need(data.names.abilityId(spec.ability), `no ability named ${spec.ability}`);
  return {
    species: form.id, form: form.form, name: data.names.species(form.id, form.form), level: spec.level ?? 50, gender: spec.gender ?? null,
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...spec.evs },
    nature: { value: spec.nature ?? 0, source: 'rom', disputed: false, alternatives: [] },
    ability: { value: ability, source: 'rom', disputed: false, alternatives: [] },
    item: spec.item === undefined ? 0 : itemIdOf(corpus, spec.item),
    moves: spec.moves.map((move) => need(data.names.moveId(move), `no move named ${move}`)),
    baseStats: { ...record.baseStats }, types: [record.types[0], record.types[1]], friendship: record.baseFriendship,
  };
}

function playerMonOf(corpus: Corpus, spec: MonSpec, slot: number): PlayerMon {
  const mon = monOf(corpus, spec);
  const stats = computeStats(mon.baseStats, mon.ivs, mon.evs, mon.level, mon.nature.value ?? 0);
  return {
    ...mon, nickname: mon.name, status: { kind: 'none' }, currentHp: stats.hp, location: { kind: 'party', slot },
    pp: mon.moves.map((move) => need(corpus.data.rom.moves[move], `the ROM has no move ${move}`).pp), ppUps: mon.moves.map(() => 0), notes: [],
  };
}

/** The battle a fixture starts from: a made-up trainer on the ROM trainer `rom`'s AI flags and bag. */
export function fixtureInput(corpus: Corpus, fixture: Fixture): BattleInput {
  const rom = fixture.rom ?? NO_BAG;
  const trainer: ResolvedTrainer = {
    id: `fixture/${fixture.name}`, name: `Fixture ${fixture.name}`, split: 'fixture', location: 'fixture', order: 0, romIndex: rom, trainerClass: 0,
    battleType: 'single', aiFlags: [], field: null, tags: {} as ResolvedTrainer['tags'], levelMismatch: false,
    party: fixture.enemy.map((spec) => monOf(corpus, spec)), variants: [],
  };
  return {
    player: fixture.player.map((spec, slot) => playerMonOf(corpus, spec, slot)), trainer, field: fixture.field ?? {},
    world: { enemy: trainer.party.map(() => ({})) }, ...(fixture.startStatus === undefined ? {} : { startStatus: fixture.startStatus }),
  };
}

/** The Choice `act` means for `side` in `state`. */
function choiceOf(state: EngineState, side: Side, act: Act): Choice {
  const legal = legalChoices(state, side);
  if (act === 'first') return need(legal[0], `${side} has no legal choice`);
  if (typeof act === 'object') {
    if ('switch' in act) return need(legal.find((c) => c.kind === 'switch' && c.index === act.switch), `${side} can't switch to ${act.switch}`);
    return need(legal.find((c) => c.kind === 'item'), `${side} has no bag item to use (legal: ${JSON.stringify(legal)})`);
  }
  const slot = typeof act === 'number' ? act : restore(state)[side].active[0]!.moveSlots.findIndex((entry) => entry.id === toID(act));
  if (slot < 0) throw new Error(`fixtures: ${side}'s active Pokémon has no move ${String(act)}`);
  return need(legal.find((c) => c.kind === 'move' && c.slot === slot), `${side} can't use ${String(act)} now (legal: ${JSON.stringify(legal)})`);
}

/** A fixture the engine refuses (an EngineError of the limit or the item kinds, or a non-empty `unmodelledIn`): a finding, not a record. */
export class FixtureRefused extends Error {}

/** `state`'s unmodelled list, as a FixtureRefused when it isn't empty. */
function requireModelled(state: EngineState, where: string): void {
  const unmodelled = unmodelledIn(state);
  if (unmodelled.length > 0) throw new FixtureRefused(`fixtures: ${where}: the engine does not model ${unmodelled.join('; ')}`);
}

/** Called with each state a fixture reaches, its record's key and the memory the AI has there, before its decision. */
export type FixtureVisitor = (key: string, state: EngineState, memory: AiMemory, outcome?: Outcome, goesOn?: boolean) => void;

/** The likeliest of `outcomes` (the first of equals), among those whose log matches `want` when it is given. */
function chosen(outcomes: readonly Outcome[], want: RegExp | undefined, where: string): number {
  let best = -1;
  outcomes.forEach((outcome, j) => {
    if (want !== undefined && !want.test(outcome.log.join('\n'))) return;
    if (best < 0 || outcome.probability.num * outcomes[best]!.probability.den > outcomes[best]!.probability.num * outcome.probability.den) best = j;
  });
  if (best < 0) throw new Error(`fixtures: ${where}: none of ${outcomes.length} outcomes' log matches ${String(want)}`);
  return best;
}

/** Runs `fixture`, adding its records to `out` (their keys under `f/<name>/`), and shows `visit` each state it reaches. */
export function runFixture(corpus: Corpus, fixture: Fixture, out: Map<string, string>, visit?: FixtureVisitor): void {
  const { model } = corpus;
  const put = (key: string, value: string): void => {
    if (out.has(key)) throw new Error(`fixtures: ${key} recorded twice`);
    out.set(key, value);
  };
  const decide = (state: EngineState, memory: AiMemory): string => {
    const kind = state.phase.kind;
    if (kind !== 'turnChoice' && !REPLACING.has(kind)) return '-';
    try {
      const support: ActionSupport[] = kind === 'turnChoice' ? model.support(state, memory) : model.replacementSupport(state, memory);
      return supportDigest(support);
    } catch (error) {
      return refusal(error);
    }
  };

  let state = createBattle(fixtureInput(corpus, fixture));
  requireModelled(state, `${fixture.name} root`);
  let memory = model.initialMemory(state);
  const base = `f/${fixture.name}`;
  visit?.(`${base}/0`, state, memory);
  put(`${base}/0`, `${memoryDigest(memory)};${decide(state, memory)}`);
  fixture.steps.forEach((step, index) => {
    const t = index + 1;
    const where = `${fixture.name} step ${t}`;
    const choices: { p1?: Choice; p2?: Choice } = {};
    if (step.p1 !== undefined) choices.p1 = choiceOf(state, 'p1', step.p1);
    if (step.p2 !== undefined) choices.p2 = choiceOf(state, 'p2', step.p2);
    let outcomes: Outcome[];
    try {
      outcomes = expandTurn(state, choices, { maxLeaves: step.maxLeaves ?? MAX_LEAVES });
    } catch (error) {
      if (error instanceof EngineError && (error.code === 'LIMIT' || error.code === 'UNMODELLED_ITEM')) throw new FixtureRefused(`fixtures: ${where}: ${error.message} (a fixture the engine refuses belongs in REFUSED, not FIXTURES)`);
      throw error;
    }
    const next = chosen(outcomes, step.want, where);
    requireModelled(outcomes[next]!.state, where);
    const followed = new Set([...outcomeSample(outcomes.length), next]);
    for (const j of [...followed].sort((a, b) => a - b)) {
      const outcome = outcomes[j]!;
      const after = model.remember(memory, outcome);
      visit?.(`${base}/${t}.${j}`, outcome.state, after, outcome, j === next);
      put(`${base}/${t}.${j}`, `${memoryDigest(after)};${decide(outcome.state, after)}`);
      if (j === next) { state = outcome.state; memory = after; }
    }
  });
}

/** Every fixture of `fixtures` run through `corpus.model`: their records, in order. */
export function runFixtures(corpus: Corpus, fixtures: readonly Fixture[] = FIXTURES): Map<string, string> {
  const out = new Map<string, string>();
  for (const fixture of fixtures) runFixture(corpus, fixture, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The fixtures. The hack's moves have very low PP (Swords Dance 2, Rain Dance 1), so the filler is Growl (40), and the
// Pokémon are the real ROM's with abilities set freely (a fixture names its ability; the species' own aren't checked).
// ---------------------------------------------------------------------------------------------------------------------

const G = 'Growl';

/** A move or ability name as a fixture-name part: lower case, hyphens for spaces. */
const slug = (name: string): string => name.toLowerCase().replace(/ /g, '-');

/** The player's Garchomp (Rough Skin, Leftovers) with `moves`, unless `o` changes a field. */
const player = (moves: string[], o: Partial<MonSpec> = {}): MonSpec => ({ species: 'Garchomp', ability: 'Rough Skin', item: 'Leftovers', moves, ...o });
const enemy = (species: string, ability: string, moves: string[], o: Partial<MonSpec> = {}): MonSpec => ({ species, ability, moves, ...o });
const shuckle = (moves: string[], o: Partial<MonSpec> = {}): MonSpec => enemy('Shuckle', 'Sturdy', moves, o);
const weavile = (moves: string[], o: Partial<MonSpec> = {}): MonSpec => enemy('Weavile', 'Pressure', moves, o);
const bench = enemy('Zigzagoon', 'Pickup', ['Tackle', G]);
/** `n` steps of the player's Growl against `p2`'s act. */
const growls = (n: number, p2: Act): Step[] => Array.from({ length: n }, () => ({ p1: G, p2 }));
/** An AI move that sets something up, then `n` quiet turns. */
const setup = (name: string, why: string, move: string, n = 2, o: Partial<Fixture> = {}): Fixture => ({
  name, why, player: [player([G, 'Tackle'])], enemy: [shuckle([move, G]), bench], steps: [{ p1: G, p2: move }, ...growls(n, G)], ...o,
});
/** The same by the player against a quiet AI. */
const setupBy = (name: string, why: string, move: string, n = 2, o: Partial<Fixture> = {}): Fixture => ({
  name, why, player: [player([move, G])], enemy: [shuckle([G, 'Bite']), bench], steps: [{ p1: move, p2: G }, ...growls(n, G)], ...o,
});

const twoTurn = (move: string): Fixture[] => {
  const part = slug(move);
  return [
    {
      name: `twoturn-ai-${part}`, why: `the AI's ${move}: the charge turn, the locked turn, the next`, player: [player([G, 'Tackle'])], enemy: [weavile([move, 'Bite']), bench],
      steps: [{ p1: G, p2: move }, { p1: G, p2: 'first' }, { p1: G, p2: 'Bite' }],
    },
    {
      name: `twoturn-player-${part}`, why: `the player's ${move}, the AI looking on`, player: [player([move, G])], enemy: [weavile(['Bite', 'Tackle']), bench],
      steps: [{ p1: move, p2: 'Bite' }, { p1: 'first', p2: 'Tackle' }, { p1: G, p2: 'Bite' }],
    },
  ];
};

/** The fixtures, in the order their records are written. */
export const FIXTURES: Fixture[] = [
  // Item and Protect reads.
  {
    name: 'protect-chain-bag', why: 'the AI Protects twice, then uses its bag item', rom: BAG, player: [player([G, 'Protect', 'Tackle', 'Earthquake'])],
    enemy: [shuckle(['Protect', 'Tackle', 'Bite']), bench],
    steps: [{ p1: 'Earthquake', p2: 'Protect' }, { p1: 'Earthquake', p2: 'Protect', want: /Protect/ }, { p1: 'Earthquake', p2: { item: true } }],
  },
  {
    name: 'protect-chain-player', why: 'the player Protects twice (the AI reads the chain)', player: [player(['Protect', G])], enemy: [shuckle(['Bite', G]), bench],
    steps: [{ p1: 'Protect', p2: 'Bite' }, { p1: 'Protect', p2: 'Bite', want: /Protect/ }, { p1: G, p2: 'Bite' }],
  },
  {
    name: 'sleeptalk-protect', why: 'Sleep Talk calls Protect', player: [player(['Spore', G])], enemy: [shuckle(['Sleep Talk', 'Protect']), bench],
    steps: [{ p1: 'Spore', p2: 'Sleep Talk' }, { p1: G, p2: 'Sleep Talk', want: /Protect/ }],
  },
  {
    name: 'bugbite-berry', why: "Bug Bite eats the AI's Sitrus Berry", player: [player(['Bug Bite', G], { species: 'Heracross', ability: 'Guts' })],
    enemy: [enemy('Blissey', 'Serene Grace', ['Tackle', G], { item: 'Sitrus Berry' }), bench], steps: [{ p1: 'Bug Bite', p2: 'Tackle' }, { p1: G, p2: 'Tackle' }],
  },
  // Imprison.
  {
    name: 'imprison-works-player', why: 'the player Imprisons and shares Tackle with the AI', player: [player(['Imprison', 'Tackle', G])],
    enemy: [shuckle(['Tackle', 'Bite', 'Protect']), bench], steps: [{ p1: 'Imprison', p2: 'Bite' }, { p1: G, p2: 'Bite' }],
  },
  {
    name: 'imprison-fails-player', why: 'the player Imprisons and shares nothing', player: [player(['Imprison', G])], enemy: [shuckle(['Tackle', 'Bite', 'Protect']), bench],
    steps: [{ p1: 'Imprison', p2: 'Bite' }, { p1: G, p2: 'Bite' }],
  },
  {
    name: 'imprison-works-ai', why: 'the AI Imprisons and shares Tackle with the player', player: [player(['Tackle', 'Earthquake', G])],
    enemy: [shuckle(['Imprison', 'Tackle', 'Bite']), bench], steps: [{ p1: G, p2: 'Imprison' }, { p1: 'Earthquake', p2: 'Bite' }],
  },
  {
    name: 'imprison-fails-ai', why: 'the AI Imprisons and shares nothing', player: [player(['Earthquake', G])], enemy: [shuckle(['Imprison', 'Tackle', 'Bite']), bench],
    steps: [{ p1: G, p2: 'Imprison' }, { p1: 'Earthquake', p2: 'Bite' }],
  },
  {
    name: 'imprison-struggle', why: 'the AI has only the imprisoned move: Struggle is forced', player: [player(['Imprison', 'Tackle', G])], enemy: [shuckle(['Tackle']), bench],
    steps: [{ p1: 'Imprison', p2: 'Tackle' }, { p1: G, p2: 'first' }],
  },
  // Pursuit. The engine fires an awake player's Pursuit before the U-turn user leaves, so no queued Pursuit reaches the AI's
  // pick here; test/unit/ai/model.test.ts ("the AI's U-turn: the mid-turn switch is exact, …") keeps it queued with the
  // player asleep, which `pursuit-queued-asleep` repeats on the real data: TryPursuit's sleep test rules it out
  // (compose.ts pursuitMayRun), so the AI decides its switch.
  {
    name: 'pursuit-queued-asleep', why: "the player's Pursuit stays queued (the player is asleep) at the AI's U-turn switch",
    startStatus: { 0: { kind: 'sleep', turns: 3 } }, player: [player(['Pursuit', G], { species: 'Tyranitar', ability: 'Solid Rock' })],
    enemy: [weavile(['U-turn', 'Tackle']), bench], steps: [{ p1: 'Pursuit', p2: 'U-turn' }, { p2: { switch: 1 } }],
  },
  {
    name: 'pursuit-hits-uturn-user', why: "the player's Pursuit at the AI's U-turn, then the mid-turn switch", player: [player(['Pursuit', G], { species: 'Tyranitar', ability: 'Solid Rock' })],
    enemy: [weavile(['U-turn', 'Tackle']), bench], steps: [{ p1: 'Pursuit', p2: 'U-turn' }, { p2: { switch: 1 } }],
  },
  // The field note.
  ...(['fog', 'trickRoom', 'gravity'] as const).map((note): Fixture => ({
    name: `field-${note.toLowerCase()}`, why: `the field note ${note}`, field: { [note]: true }, player: [player(['Earthquake', G])], enemy: [weavile(['Bite', 'Tackle']), bench],
    steps: [{ p1: G, p2: 'Bite' }, { p1: 'Earthquake', p2: 'Tackle' }],
  })),
  // Quick Claw, sleep, toxic, Perish Song, Stockpile.
  {
    name: 'quickclaw', why: 'a Quick Claw holder at the root and on turn 2', player: [player([G, 'Tackle'])], enemy: [shuckle(['Bite', 'Tackle'], { item: 'Quick Claw' }), bench],
    steps: [{ p1: G, p2: 'Bite' }, { p1: G, p2: 'Tackle' }],
  },
  {
    name: 'sleep-known', why: 'the player asleep from the save (an exact counter)', startStatus: { 0: { kind: 'sleep', turns: 2 } }, player: [player([G, 'Tackle']), player(['Tackle'])],
    enemy: [weavile(['Bite', 'Tackle']), bench], steps: [{ p1: 'first', p2: 'Bite' }, { p1: 'first', p2: 'Bite' }],
  },
  {
    name: 'sleep-hazard', why: 'the player asleep from a move (the counter undrawn)', player: [player([G, 'Tackle'])], enemy: [weavile(['Spore', 'Bite']), bench],
    steps: [{ p1: G, p2: 'Spore' }, { p1: G, p2: 'Bite' }, { p1: G, p2: 'Bite' }],
  },
  {
    name: 'toxic-on-player', why: 'toxic on the player up to counter 3', player: [player([G, 'Tackle'], { item: undefined })], enemy: [weavile(['Toxic', G]), bench],
    steps: [{ p1: G, p2: 'Toxic' }, ...growls(3, G)],
  },
  {
    name: 'toxic-on-ai', why: 'toxic on the AI up to counter 3', player: [player(['Toxic', G])], enemy: [shuckle(['Bite', 'Tackle']), bench],
    steps: [{ p1: 'Toxic', p2: 'Bite' }, { p1: G, p2: 'Bite' }, { p1: G, p2: 'Bite' }, { p1: G, p2: 'Bite' }],
  },
  {
    name: 'perish-song', why: "the AI's Perish Song, to the double faint", player: [player([G, 'Tackle']), player(['Tackle'])], enemy: [weavile(['Perish Song', G]), bench],
    steps: [{ p1: G, p2: 'Perish Song' }, ...growls(3, G)],
  },
  setup('stockpile-2', 'the AI Stockpiles twice', 'Stockpile', 2, { steps: [{ p1: G, p2: 'Stockpile' }, { p1: G, p2: 'Stockpile' }, { p1: G, p2: G }] }),
  // Move restrictions (the hack has no Taunt).
  {
    name: 'restrictions', why: 'Torment, Disable and Encore on the AI, to a forced Struggle', player: [player(['Torment', 'Disable', 'Encore', G])],
    enemy: [shuckle(['Bite', 'Tackle', 'Quick Attack', 'Swift']), bench],
    steps: [{ p1: 'Torment', p2: 'Bite' }, { p1: 'Disable', p2: 'Tackle' }, { p1: 'Encore', p2: 'Quick Attack' }, { p1: G, p2: 'first' }],
  },
  {
    name: 'encore-lock', why: 'Encore alone locks the AI into its last move', player: [player(['Encore', G])], enemy: [shuckle(['Bite', 'Tackle']), bench],
    steps: [{ p1: G, p2: 'Bite' }, { p1: 'Encore', p2: 'Tackle' }, { p1: G, p2: 'first' }, { p1: G, p2: 'first' }],
  },
  {
    name: 'choice-lock', why: 'a Choice Band holder locked into its first move', player: [player([G, 'Tackle'])],
    enemy: [weavile(['Bite', 'Quick Attack', G], { item: 'Choice Band', level: 30 }), bench], steps: [{ p1: G, p2: 'Bite' }, { p1: G, p2: 'first' }, { p1: G, p2: 'first' }],
  },
  {
    name: 'choice-disable', why: 'a Choice-locked AI whose one move is Disabled: Struggle', player: [player(['Disable', G])],
    enemy: [shuckle(['Bite', 'Quick Attack', G], { item: 'Choice Band' }), bench], steps: [{ p1: G, p2: 'Bite' }, { p1: 'Disable', p2: 'first' }, { p1: G, p2: 'first' }],
  },
  // Two-turn moves: Razor Wind and SolarBeam. Fly and Shadow Force are refused (REFUSED); Dig, Dive, Bounce and Sky Attack
  // are one-turn moves in the hack, which also has no Skull Bash.
  ...twoTurn('SolarBeam'),
  ...twoTurn('Razor Wind'),
  // Volatiles and the sides.
  setup('leechseed-ai', 'the AI seeds the player', 'Leech Seed'),
  setupBy('leechseed-player', 'the player seeds the AI', 'Leech Seed'),
  {
    name: 'attract-ai', why: 'the AI infatuates the player', player: [player([G, 'Tackle'], { gender: 'M' })],
    enemy: [enemy('Blissey', 'Serene Grace', ['Attract', G], { gender: 'F' }), bench], steps: [{ p1: G, p2: 'Attract' }, ...growls(2, G)],
  },
  {
    name: 'attract-player', why: 'the player infatuates the AI', player: [player(['Attract', G], { gender: 'M' })],
    enemy: [enemy('Blissey', 'Serene Grace', [G, 'Tackle'], { gender: 'F' }), bench], steps: [{ p1: 'Attract', p2: G }, ...growls(2, G)],
  },
  {
    name: 'substitute-ai', why: 'the AI behind a Substitute', player: [player([G, 'Tackle'])], enemy: [shuckle(['Substitute', G]), bench],
    steps: [{ p1: G, p2: 'Substitute' }, { p1: 'Tackle', p2: G }, { p1: 'Tackle', p2: G }],
  },
  {
    name: 'substitute-player', why: 'the player behind a Substitute', player: [player(['Substitute', G])], enemy: [shuckle(['Bite', G]), bench],
    steps: [{ p1: 'Substitute', p2: 'Bite' }, ...growls(2, 'Bite')],
  },
  {
    name: 'wish-ai', why: "the AI's Wish", player: [player([G, 'Tackle'])], enemy: [enemy('Blissey', 'Serene Grace', ['Wish', G]), bench],
    steps: [{ p1: 'Tackle', p2: 'Wish' }, ...growls(2, G)],
  },
  setupBy('wish-player', "the player's Wish", 'Wish'),
  {
    name: 'hazards-on-ai', why: 'the player lays Spikes twice, Toxic Spikes and Stealth Rock; the AI switches in', player: [player(['Spikes', 'Toxic Spikes', 'Stealth Rock', G])],
    enemy: [shuckle([G, 'Bite']), bench],
    steps: [{ p1: 'Spikes', p2: G }, { p1: 'Spikes', p2: G }, { p1: 'Toxic Spikes', p2: G }, { p1: 'Stealth Rock', p2: G }, { p1: G, p2: { switch: 1 } }],
  },
  {
    name: 'hazards-on-player', why: 'the AI lays all three hazards; the player switches in', player: [player([G, 'Tackle']), player(['Tackle', G])],
    enemy: [weavile(['Spikes', 'Toxic Spikes', 'Stealth Rock', G]), bench],
    steps: [{ p1: G, p2: 'Spikes' }, { p1: G, p2: 'Spikes' }, { p1: G, p2: 'Toxic Spikes' }, { p1: G, p2: 'Stealth Rock' }, { p1: { switch: 1 }, p2: G }],
  },
  {
    name: 'tailwind-ai', why: "the AI's Tailwind, to its end", player: [player([G, 'Tackle'])], enemy: [shuckle(['Tailwind', 'Bite']), bench],
    steps: [{ p1: G, p2: 'Tailwind' }, { p1: G, p2: 'Bite' }, { p1: G, p2: 'Bite' }],
  },
  setupBy('tailwind-player', "the player's Tailwind, to its end", 'Tailwind', 2),
  // Further volatiles, conditions and switches the sweep's corpus reaches only by luck.
  ...(['Thunder Wave', 'Will-O-Wisp', 'Confuse Ray'] as const).flatMap((move): Fixture[] => [
    setup(`status-${slug(move)}-on-player`, `the AI's ${move}`, move, 2, move === 'Thunder Wave' ? { player: [player([G, 'Tackle'], { species: 'Tyranitar', ability: 'Solid Rock' })] } : {}), // Garchomp is Ground: immune
    setupBy(`status-${slug(move)}-on-ai`, `the player's ${move}`, move),
  ]),
  {
    name: 'screens-ai', why: 'the AI raises Reflect, Light Screen, Safeguard and Mist', player: [player([G, 'Tackle'])], enemy: [shuckle(['Reflect', 'Light Screen', 'Safeguard', 'Mist']), bench],
    steps: [{ p1: G, p2: 'Reflect' }, { p1: G, p2: 'Light Screen' }, { p1: G, p2: 'Safeguard' }, { p1: G, p2: 'Mist' }],
  },
  {
    name: 'screens-player', why: 'the player raises Reflect, Light Screen, Safeguard and Mist', player: [player(['Reflect', 'Light Screen', 'Safeguard', 'Mist'])], enemy: [shuckle(['Bite', G]), bench],
    steps: [{ p1: 'Reflect', p2: 'Bite' }, { p1: 'Light Screen', p2: 'Bite' }, { p1: 'Safeguard', p2: 'Bite' }, { p1: 'Mist', p2: 'Bite' }],
  },
  setup('ingrain-ai', 'the AI Ingrains', 'Ingrain'),
  setup('magnetrise-ai', 'the AI Magnet Rises', 'Magnet Rise'),
  setup('aquaring-ai', 'the AI Aqua Rings', 'Aqua Ring'),
  setupBy('embargo-player', 'the player Embargoes the AI', 'Embargo', 2, { enemy: [shuckle([G, 'Bite'], { item: 'Leftovers' }), bench] }),
  setupBy('meanlook-player', 'the player traps the AI (Mean Look)', 'Mean Look'),
  setup('whirlpool-ai', 'the AI traps the player (Whirlpool)', 'Whirlpool', 2),
  setup('destinybond-ai', 'the AI sets Destiny Bond', 'Destiny Bond', 2),
  {
    name: 'outrage-no-lock', why: "the AI's Outrage, which the hack does not lock", player: [player([G, 'Tackle'], { level: 100 })], enemy: [shuckle(['Outrage', 'Bite']), bench],
    steps: [{ p1: G, p2: 'Outrage' }, { p1: G, p2: 'first' }, { p1: G, p2: 'first' }, { p1: G, p2: 'first' }],
  },
  {
    name: 'rest-ai', why: 'the AI Rests after a hit', player: [player(['Tackle', G])], enemy: [enemy('Blissey', 'Serene Grace', ['Rest', G]), bench],
    steps: [{ p1: 'Tackle', p2: G }, { p1: G, p2: 'Rest' }, { p1: G, p2: 'first' }],
  },
  {
    name: 'batonpass-ai', why: "the AI's Baton Pass, then the mid-turn switch", player: [player([G, 'Tackle'])], enemy: [weavile(['Baton Pass', 'Bite']), bench],
    steps: [{ p1: G, p2: 'Baton Pass' }, { p2: { switch: 1 } }],
  },
  // Weather: by move, and by ability.
  ...(['Rain Dance', 'Sunny Day', 'Sandstorm', 'Hail'] as const).map((move): Fixture => ({
    name: `weather-move-${slug(move)}`, why: `the AI's ${move}`, player: [player([G, 'Earthquake'])], enemy: [weavile([move, 'Bite']), bench],
    steps: [{ p1: G, p2: move }, { p1: G, p2: 'Bite' }, { p1: G, p2: 'Bite' }],
  })),
  ...([['Politoed', 'Drizzle'], ['Groudon', 'Drought'], ['Hippowdon', 'Sand Stream'], ['Abomasnow', 'Snow Warning']] as const).map(([species, ability]): Fixture => ({
    name: `weather-ability-${slug(ability)}`, why: `the AI's ${ability}`, player: [player([G, 'Earthquake'])],
    enemy: [enemy(species, ability, ['Bite', G]), bench], steps: [{ p1: G, p2: 'Bite' }, { p1: G, p2: 'Bite' }],
  })),
  {
    name: 'uproar-ai', why: "the AI's Uproar", player: [player([G, 'Tackle'])], enemy: [shuckle(['Uproar', 'Bite']), bench],
    steps: [{ p1: G, p2: 'Uproar' }, { p1: G, p2: 'first' }, { p1: G, p2: 'first' }],
  },
  // The AI's faints, and what a fainted battler's memory keeps.
  {
    name: 'faint-burned', why: 'the AI faints burned (Flame Orb)', player: [player([G, 'Earthquake'])], enemy: [weavile([G, 'Bite'], { item: 'Flame Orb', level: 30 }), bench],
    steps: [{ p1: G, p2: G }, { p1: 'Earthquake', p2: G, want: /faint/ }, { p2: { switch: 1 } }],
  },
  {
    name: 'faint-asleep', why: 'the AI faints asleep (Spore)', player: [player(['Spore', 'Earthquake'])], enemy: [weavile([G, 'Bite'], { level: 30 }), bench],
    steps: [{ p1: 'Spore', p2: G }, { p1: 'Earthquake', p2: G, want: /faint/ }, { p2: { switch: 1 } }],
  },
  {
    name: 'trace-gastro', why: "a Trace holder is Gastro Acid'd, then faints (the Trace fix's aiTraced clearing)", player: [player(['Gastro Acid', 'Earthquake'])],
    enemy: [enemy('Smeargle', 'Trace', [G, 'Tackle'], { level: 30 }), bench],
    steps: [{ p1: 'Gastro Acid', p2: G }, { p1: 'Earthquake', p2: G, want: /faint/ }, { p2: { switch: 1 } }],
  },
];

/**
 * Fixtures for situations the engine refuses today (`unmodelledIn` is non-empty): the findings of docs/ai-fixtures.md.
 * aiDifferentialShards.test.ts checks that each is still refused, with `why` in the message; when the engine models one,
 * that check fails and the fixture moves to FIXTURES (its records are then new, added with `--add`).
 */
export const REFUSED: { fixture: Fixture; why: RegExp }[] = [
  {
    why: /does not model Transform/,
    fixture: {
      name: 'transform', why: "Ditto transforms into the player's Garchomp", player: [player(['Tackle', G])],
      enemy: [enemy('Ditto', 'Limber', ['Transform', 'Tackle']), bench], steps: [{ p1: G, p2: 'Transform' }, { p1: G, p2: 'first' }],
    },
  },
  {
    why: /does not model Recycle/,
    fixture: {
      name: 'bugbite-recycle', why: 'Bug Bite eats the berry; the AI Recycles it', player: [player(['Bug Bite', G], { species: 'Heracross', ability: 'Guts' })],
      enemy: [enemy('Blissey', 'Serene Grace', ['Recycle', 'Tackle'], { item: 'Sitrus Berry' }), bench], steps: [{ p1: 'Bug Bite', p2: 'Tackle' }, { p1: G, p2: 'Recycle' }],
    },
  },
  {
    why: /does not model Fly/,
    fixture: {
      name: 'twoturn-ai-fly', why: "the AI's Fly", player: [player([G, 'Tackle'])], enemy: [weavile(['Fly', 'Bite']), bench], steps: [{ p1: G, p2: 'Fly' }, { p1: G, p2: 'first' }],
    },
  },
  {
    why: /does not model Shadow Force/,
    fixture: {
      name: 'twoturn-ai-shadow-force', why: "the AI's Shadow Force", player: [player([G, 'Tackle'])], enemy: [weavile(['Shadow Force', 'Bite']), bench],
      steps: [{ p1: G, p2: 'Shadow Force' }, { p1: G, p2: 'first' }],
    },
  },
  {
    why: /does not model Future Sight/,
    fixture: {
      name: 'futuresight-ai', why: "the AI's Future Sight", player: [player([G, 'Tackle'])], enemy: [enemy('Blissey', 'Serene Grace', ['Future Sight', G]), bench],
      steps: [{ p1: G, p2: 'Future Sight' }, ...growls(3, G)],
    },
  },
  {
    why: /does not model Worry Seed/,
    fixture: {
      name: 'trace-worryseed', why: 'a Trace holder is given Insomnia, then faints', player: [player(['Worry Seed', 'Earthquake'])],
      enemy: [enemy('Smeargle', 'Trace', [G, 'Tackle'], { level: 30 }), bench], steps: [{ p1: 'Worry Seed', p2: G }, { p1: 'Earthquake', p2: G, want: /faint/ }],
    },
  },
  {
    why: /does not model Role Play/,
    fixture: {
      name: 'trace-roleplay', why: 'a Trace holder Role Plays, then faints',
      player: [player([G, 'Earthquake']), player(['Tackle', 'Earthquake'], { species: 'Gengar', ability: 'Shadow Tag' })],
      enemy: [enemy('Smeargle', 'Trace', ['Role Play', G], { level: 30 }), bench], steps: [{ p1: { switch: 1 }, p2: G }, { p1: G, p2: 'Role Play' }],
    },
  },
];
