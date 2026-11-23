// Real-data sweep: the trainer AI's whole first decision, `decide`, for every single-battle trainer in
// the catalog (and each single-battle ROM copy it has), with each of its party Pokémon in turn as the AI's active
// Pokémon, against three fixed player Pokémon. It runs the hack's own script and data from the player's ROM (data/rom, which
// `npm run extract` wrote from PK_ROM, checked against the ROM's script here).
//
// - A decision may throw AiError('UNDEFINED'): it read a field the view lists as unknown, or Weather Ball
//   has no usable weather. Those are counted by reason, not failed.
// - DIV_ZERO is listed and fails its own test, as does any other AiError or a plain Error.
// - Every decision that returns must sum to exactly ONE, with every action's probability above 0.
// - Party member i leads by moving it to the front of the party, the others keeping their order. The view and the AI's
//   knowledge are then initialDecision's turn 1 with that Pokémon in, against the player lead with the other two player
//   Pokémon behind it: the leads' switch-in effects run through the engine.
// - initialDecision refuses with AiError('UNDEFINED') where the engine can't give a switch-in effect exactly
//   (switchIn.ts SWITCH_IN_REFUSALS); those are counted by reason with the rest.
// - The equivalence guard: a view with no switch-in step fired (initialDecision's `steps` empty) must equal
//   initialLoad's, the load alone, field for field. The summary counts them and fails on any that doesn't.
// - Only the paths in lib/known.ts's PATHS have a reader that calls requireKnown, so a view listing any other path stops
//   `decide` at its entry with UNDEFINED (assertGuarded). The summary counts those views by path (none at present) and checks that every decision on one stopped there.
//
// The sweep is split into one test per player lead, each well under the 120 s timeout, and a summary test that prints
// the numbers and checks the whole run; DIV_ZERO fails a test of its own. Time is measured around `decide` alone, and
// separately around initialDecision.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { type ActionDist, decide } from '../../src/ai/choose/decide.js';
import { fastMoveDistribution } from '../../src/ai/choose/moves.js';
import { HOLD_EFFECT_SOMETIMES_PRIORITY, USE_MAX_DAMAGE } from '../../src/ai/constants.js';
import { AiError } from '../../src/ai/errors.js';
import { depsFor, initialDecision, initialLoad, worldsFor } from '../../src/ai/initialView.js';
import { isGuardedPath, PATHS } from '../../src/ai/lib/known.js';
import { initialMemoryData } from '../../src/ai/memory.js';
import { eq, ONE, sum } from '../../src/ai/odds.js';
import { type AiRomData, aiScriptOf, loadAiData } from '../../src/ai/rom/aiData.js';
import { extractAiScript } from '../../src/ai/rom/script.js';
import { type Instr, reachable } from '../../src/ai/script/disasm.js';
import { HANDLERS } from '../../src/ai/script/run.js';
import { SWITCH_IN_MESSAGE } from '../../src/ai/switchIn.js';
import type { AiDeps, AiKnowledge, AiView } from '../../src/ai/view.js';
import { buildCatalog } from '../../src/battle/catalog.js';
import type { PlayerMon } from '../../src/battle/playerMon.js';
import type { LoadedData, ResolvedTrainer } from '../../src/battle/types.js';
import type { WorldAssignment } from '../../src/contracts/engine.js';
import { loadLocalData } from '../../src/data/load.js';
import { readNarc } from '../../src/nds/narc.js';
import { readNdsFiles } from '../../src/nds/ndsFs.js';
import { computeStats } from '../../src/rom/stats.js';
import type { Stats } from '../../src/rom/types.js';
import { type CacheStatus, DATA_DIR, needFiles, PK_ROM } from './env.js';

const caches = inject('realCaches');
const ROM_DIR = join(DATA_DIR, 'rom');
/** data/rom, which `npm run extract` writes: the planner's ROM data and the AI's (trainer-ai.json). */
const romExtract: CacheStatus = {
  name: 'ROM extract', dir: ROM_DIR,
  skip: ['romdata.json', 'trainer-ai.json'].every((file) => existsSync(join(ROM_DIR, file)))
    ? null : `${ROM_DIR} lacks romdata.json or trainer-ai.json; run npm run extract -- --rom <path>`,
};
const suite = needFiles("the trainer AI's first decision for every single-battle trainer", { PK_ROM }, [caches.docs, caches.pkcalc, romExtract]);

/** The trainer header file: a 20-byte record per ROM trainer, its four bag slots at byte 4 (src/rom/trainers.ts). */
const TRDATA = 'poketool/trainer/trdata.narc';
const BAG_OFFSET = 4;
const BAG_SLOTS = 4;
/** The opcodes that run BattleSystem_CompareBattlerSpeed, which reads a Quick Claw holder's draw. */
const SPEED_OPS = new Set(['IfSpeedCompareEqualTo', 'IfSpeedCompareNotEqualTo', 'LoadBattlerSpeedRank']);
/**
 * The damage opcodes and the index of the argument word that picks USE_MAX_DAMAGE or ROLL_FOR_DAMAGE (ops/calc.ts). A
 * run reads a slot's damage roll (readRoll, AI_CONTEXT.moveDamageRolls) only through one of these with a non-zero word.
 */
const ROLL_WORD: ReadonlyMap<string, number> = new Map([
  ['FlagMoveDamageScore', 0], ['IfCurrentMoveKills', 0], ['IfCurrentMoveDoesNotKill', 0], ['IfPartyMemberDealsMoreDamage', 0],
  ['IfBattlerDealsMoreDamage', 1], ['CheckIfHighestDamageWithPartner', 0],
]);
/**
 * The UNDEFINED reasons the sweep finds today (undefinedReason). A new cause fails the summary test until it is added
 * here on purpose, and so does one that stops happening. Since F1 no view lists an unguarded path: the switch-in
 * effects are applied, or refused by name. Since A3 the note's deep fog is a bit, not a gap.
 */
const EXPECTED_UNDEFINED_REASONS = [
  'Weather Ball without usable weather',
];

/** How assertGuarded's UNDEFINED message starts (lib/known.ts). */
const UNGUARDED = 'unguarded unknown path ';

/** AIContext's knowledge as battle start clears it (battle_controller_player.c:4799): nothing known. */
const EMPTY_KNOWLEDGE: AiKnowledge = initialMemoryData(null).knowledge;

/**
 * What one decision did. `ms` times `decide` alone, `viewMs` initialDecision; `slow` is set when the move choice ran;
 * `knows` when the AI's turn-1 knowledge isn't empty; `unstepped` when no switch-in step fired, and then `asLoaded`
 * whether the view equals initialLoad's.
 */
interface Outcome {
  trainer: ResolvedTrainer; lead: number; player: string; ms: number; viewMs: number; knows?: boolean; unstepped?: boolean; asLoaded?: boolean;
  kind: 'ok' | 'undefined' | 'failure'; code?: string; message?: string; slow?: boolean;
  actions?: ActionDist[];
  /** The view's unknown paths that no reader guards. */
  unguarded: string[];
}

/** A player Pokémon as the save would give it: 31 IVs, full HP and PP, no PP Ups, no status. */
interface PlayerSpec {
  species: number; name: string; ability: string; item: number; itemName: string; nature: number; gender: 'M' | 'F' | null;
  evs: Partial<Stats>; moves: string[];
}

// generated/species.txt, items.txt (line = ID + 1); natures by ID (pokemon.c's nature order).
const JOLLY = 13;
const TIMID = 10;
const RELAXED = 7;
/**
 * The three fixed player Pokémon, all Lv 50. Garchomp has two abilities in the hack (Sand Veil, Rough Skin), so with
 * nothing known LoadBattlerAbility flips a coin per call (trainer_ai.c:1194–1199). The hack's Gengar has one, Shadow Tag,
 * which the AI reads without a coin (:1185–1188). Forretress stands in for a Ferrothorn-like Steel type: Gen 4 has no
 * Ferrothorn, and the hack no Grass/Steel species.
 */
const PLAYERS: PlayerSpec[] = [
  {
    species: 445, name: 'Garchomp', ability: 'Rough Skin', item: 287, itemName: 'Choice Scarf', nature: JOLLY, gender: 'M',
    evs: { hp: 4, atk: 252, spe: 252 }, moves: ['Earthquake', 'Dragon Claw', 'Stone Edge', 'Swords Dance'],
  },
  {
    species: 94, name: 'Gengar', ability: 'Shadow Tag', item: 275, itemName: 'Focus Sash', nature: TIMID, gender: 'M',
    evs: { hp: 4, spa: 252, spe: 252 }, moves: ['Shadow Ball', 'Sludge Bomb', 'Thunderbolt', 'Focus Blast'],
  },
  {
    species: 205, name: 'Forretress', ability: 'Heatproof', item: 234, itemName: 'Leftovers', nature: RELAXED, gender: 'F',
    evs: { hp: 252, def: 252, spd: 4 }, moves: ['Gyro Ball', 'Spikes', 'Toxic', 'Explosion'],
  },
];

function playerMon(spec: PlayerSpec, slot: number, data: LoadedData): PlayerMon {
  const record = data.rom.species[spec.species];
  if (record === undefined) throw new Error(`the ROM has no species ${spec.species}`);
  const name = data.names.species(spec.species);
  if (name !== spec.name) throw new Error(`species ${spec.species} is ${name}, not ${spec.name}`);
  if (data.names.item(spec.item) !== spec.itemName) throw new Error(`item ${spec.item} is ${data.names.item(spec.item)}, not ${spec.itemName}`);
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

/** `trainer` with party member `lead` moved to the front, and `world` reindexed to match. */
function withLead(trainer: ResolvedTrainer, world: WorldAssignment, lead: number): { trainer: ResolvedTrainer; world: WorldAssignment } {
  const order = [lead, ...trainer.party.keys()].filter((index, at, all) => all.indexOf(index) === at);
  return {
    trainer: { ...trainer, party: order.map((index) => trainer.party[index]!) },
    world: { enemy: order.map((index) => world.enemy[index] ?? {}) },
  };
}

/** The set bits of a u32 AI mask, ascending. */
function maskBits(mask: number): number[] {
  return Array.from({ length: 32 }, (_, bit) => bit).filter((bit) => ((mask >>> bit) & 1) === 1);
}

/** A short name for a trainer in the summary: its docs ID and ROM index. */
function label(trainer: ResolvedTrainer): string {
  return `${trainer.id} [ROM ${trainer.romIndex}]`;
}

/**
 * UNDEFINED's reason, from its message: a switch-in refusal (by its SWITCH_IN_REFUSALS reason), an unguarded path
 * (assertGuarded), a guarded unknown path, Weather Ball, or the message itself.
 */
function undefinedReason(message: string): string {
  if (message.startsWith(SWITCH_IN_MESSAGE)) return `switch-in: ${message.slice(SWITCH_IN_MESSAGE.length).replace(/:.*$/s, '')}`;
  if (message.startsWith(UNGUARDED)) return 'unguarded unknown path';
  const path = /^(\S+) is unknown$/.exec(message);
  if (path) return `unknown path ${path[1]}`;
  if (message.includes('Weather Ball')) return 'Weather Ball without usable weather';
  return message;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function countBy<T>(items: T[], key: (item: T) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

describe.skipIf(suite.skip)(suite.title, () => {
  let data: LoadedData;
  let ai: AiRomData;
  let trainers: ResolvedTrainer[];
  /** How many of `trainers` are other ROM copies of a catalog trainer (ResolvedTrainer.variants). */
  let copies: number;
  let deps: Map<ResolvedTrainer, AiDeps>;
  let players: PlayerMon[][];
  /** Each ROM trainer's raw bag slots, gaps kept. */
  let rawBags: number[][];
  const outcomes: Outcome[] = [];
  const reachableByMask = new Map<number, Map<number, Instr>>();

  beforeAll(() => {
    const rom = readFileSync(PK_ROM);
    data = loadLocalData(DATA_DIR);
    ai = loadAiData(ROM_DIR);
    // The cached script must be the ROM's: data/rom could be stale.
    expect(ai.scriptSha256).toBe(extractAiScript(rom).sha256);
    rawBags = readNarc(readNdsFiles(rom).get(TRDATA)!).map((header) => {
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      return Array.from({ length: BAG_SLOTS }, (_, i) => view.getUint16(BAG_OFFSET + i * 2, true));
    });
    const singles = buildCatalog(data).trainers.filter((trainer) => trainer.battleType === 'single');
    const variants = singles.flatMap((trainer) => trainer.variants.filter((variant) => variant.battleType === 'single'));
    trainers = [...singles, ...variants];
    copies = variants.length;
    deps = new Map(trainers.map((trainer) => [trainer, depsFor(trainer, data, ai)]));
    const mons = PLAYERS.map((spec, slot) => playerMon(spec, slot, data));
    // Each player Pokémon leads in turn, the other two behind it in their order.
    players = mons.map((lead) => [lead, ...mons.filter((mon) => mon !== lead)]
      .map((mon, slot): PlayerMon => ({ ...mon, location: { kind: 'party', slot } })));
  });

  it('every instruction reachable from each swept trainer\'s AI flags decodes and has a handler', () => {
    const script = aiScriptOf(ai);
    for (const trainer of trainers) {
      const mask = deps.get(trainer)!.aiFlags;
      if (reachableByMask.has(mask)) continue;
      const instrs = reachable(script, maskBits(mask)); // throws AiError('UNKNOWN_OPCODE') on an unknown opcode
      expect([...instrs.values()].filter((instr) => HANDLERS[instr.op.code] === undefined).map((instr) => `${instr.op.name} at ${instr.at}`)).toEqual([]);
      reachableByMask.set(mask, instrs);
    }
    expect(reachableByMask.size).toBeGreaterThan(0);
  });

  for (const [p, spec] of PLAYERS.entries()) {
    it(`decides for every trainer and every lead against a Lv 50 ${spec.name}`, () => {
      const player = players[p]!;
      for (const trainer of trainers) {
        const d = deps.get(trainer)!;
        const world = worldsFor(trainer)[0]!;
        for (let lead = 0; lead < trainer.party.length; lead++) {
          const input = withLead(trainer, world, lead);
          let v: AiView;
          let knowledge: AiKnowledge;
          let steps: string[];
          const viewStart = performance.now();
          const viewInput = { player, trainer: input.trainer, world: input.world };
          try {
            ({ view: v, knowledge, steps } = initialDecision(viewInput, data, ai));
          } catch (error) {
            const viewMs = performance.now() - viewStart;
            const at = { trainer, lead, player: spec.name, ms: 0, viewMs, unguarded: [] };
            // A switch-in effect the engine can't give exactly (switchIn.ts): UNDEFINED, counted by reason.
            if (error instanceof AiError && error.code === 'UNDEFINED') {
              outcomes.push({ ...at, kind: 'undefined', code: error.code, message: error.message });
            } else {
              const code = error instanceof AiError ? `initialView ${error.code}` : 'initialView Error';
              outcomes.push({ ...at, kind: 'failure', code, message: String(error) });
            }
            continue;
          }
          const viewMs = performance.now() - viewStart;
          const knows = JSON.stringify(knowledge) !== JSON.stringify(EMPTY_KNOWLEDGE);
          // The equivalence guard (F1): a view no switch-in step changed is the load, the C's InitBattleMon alone.
          const unstepped = steps.length === 0;
          const asLoaded = unstepped ? JSON.stringify(v) === JSON.stringify(initialLoad(viewInput, data, ai)) : undefined;
          const base = {
            trainer, lead, player: spec.name, viewMs, knows, unstepped, ...(unstepped && { asLoaded }),
            unguarded: v.unknown.filter((path) => !isGuardedPath(path)),
          };
          const start = performance.now();
          let actions: ActionDist[];
          try {
            actions = decide(v, d, knowledge);
          } catch (error) {
            const ms = performance.now() - start;
            if (error instanceof AiError) {
              outcomes.push({ ...base, ms, kind: error.code === 'UNDEFINED' ? 'undefined' : 'failure', code: error.code, message: error.message });
            } else {
              outcomes.push({ ...base, ms, kind: 'failure', code: 'Error', message: String(error) });
            }
            continue;
          }
          const ms = performance.now() - start;
          const total = sum(actions.map((action) => action.probability));
          expect(eq(total, ONE), `${label(trainer)} lead ${lead} vs ${spec.name}: sums to ${total.num}/${total.den}`).toBe(true);
          expect(actions.every((action) => action.probability.num > 0n)).toBe(true);
          const fought = actions.some((action) => action.action.kind === 'move');
          outcomes.push({ ...base, ms, kind: 'ok', actions, ...(fought && { slow: fastMoveDistribution(v, d, knowledge) === null }) });
        }
      }
    });
  }

  it('prints the summary; no decision fails but on DIV_ZERO, which the next test fails on', () => {
    const decisions = outcomes.length;
    const expected = trainers.reduce((n, trainer) => n + trainer.party.length, 0) * PLAYERS.length;
    const ok = outcomes.filter((outcome) => outcome.kind === 'ok');
    const undefinedOnes = outcomes.filter((outcome) => outcome.kind === 'undefined');
    const failures = outcomes.filter((outcome) => outcome.kind === 'failure');
    const divZero = failures.filter((outcome) => outcome.code === 'DIV_ZERO');
    const others = failures.filter((outcome) => outcome.code !== 'DIV_ZERO');
    const times = outcomes.map((outcome) => outcome.ms).sort((a, b) => a - b);
    const viewTimes = outcomes.map((outcome) => outcome.viewMs).sort((a, b) => a - b);
    const unstepped = outcomes.filter((outcome) => outcome.unstepped === true);
    const slowest = outcomes.reduce((a, b) => (b.ms > a.ms ? b : a));
    const fought = ok.filter((outcome) => outcome.slow !== undefined);
    const trainerSet = (list: Outcome[]) => new Set(list.map((outcome) => outcome.trainer));
    const worlds = trainers.map((trainer) => worldsFor(trainer).length);

    // Damage rolls: a run reads one only through a damage opcode whose roll word isn't USE_MAX_DAMAGE.
    const damageSites = new Set<number>();
    const rollSites = new Set<number>();
    for (const instrs of reachableByMask.values()) {
      for (const instr of instrs.values()) {
        const word = ROLL_WORD.get(instr.op.name);
        if (word === undefined) continue;
        damageSites.add(instr.at);
        if (instr.args[word] !== USE_MAX_DAMAGE) rollSites.add(instr.at);
      }
    }
    const rollTrainers = trainers.filter((trainer) => [...reachableByMask.get(deps.get(trainer)!.aiFlags)!.values()]
      .some((instr) => rollSites.has(instr.at)));
    const rollDecisions = outcomes.filter((outcome) => rollTrainers.includes(outcome.trainer)).length;

    // Bags: the compacted RomTrainer.items, and the raw ROM slots for gaps (a zero slot before a non-empty one).
    const rom = data.rom.trainers;
    const bagOf = (trainer: ResolvedTrainer) => rom[trainer.romIndex]!.items;
    const multiBag = trainers.filter((trainer) => bagOf(trainer).length >= 2);
    const gapped = (slots: number[]) => slots.some((item, i) => item === 0 && slots.slice(i + 1).some((later) => later !== 0));
    const gappedSwept = trainers.filter((trainer) => gapped(rawBags[trainer.romIndex]!));
    const gappedRom = rawBags.flatMap((slots, index) => (gapped(slots) ? [index] : []));

    // Weather Ball users, and Quick Claw holders whose flags reach a speed comparison.
    const weatherBall = data.names.moveId('Weather Ball');
    const weatherBallTrainers = trainers.filter((trainer) => trainer.party.some((mon) => weatherBall !== null && mon.moves.includes(weatherBall)));
    const quickClaw = (item: number) => ai.items[item]?.holdEffect === HOLD_EFFECT_SOMETIMES_PRIORITY;
    const speedReach = (trainer: ResolvedTrainer) => [...reachableByMask.get(deps.get(trainer)!.aiFlags)!.values()].some((instr) => SPEED_OPS.has(instr.op.name));
    const quickClawTrainers = trainers.filter((trainer) => trainer.party.some((mon) => quickClaw(mon.item)) && speedReach(trainer));
    const quickClawHolders = trainers.filter((trainer) => trainer.party.some((mon) => quickClaw(mon.item)));

    // Unguarded unknown paths: listed in the view, but no reader calls requireKnown for them. assertGuarded stops each
    // such decision at entry, naming the first.
    const unguardedViews = outcomes.filter((outcome) => outcome.unguarded.length > 0);
    const notStopped = unguardedViews.filter((outcome) => outcome.kind !== 'undefined' || !outcome.message!.startsWith(UNGUARDED));
    const byPath = (list: Outcome[], paths: (outcome: Outcome) => string[]) =>
      countBy(list.flatMap((o) => paths(o).map((path) => ({ path }))), (x) => x.path).map(([path, n]) => `${path} ×${n}`).join('; ') || 'none';

    // DIV_ZERO by trainer, and the TagStrategy flag (its partner reads find the empty battler slots in singles).
    const tagStrategy = trainers.filter((trainer) => trainer.aiFlags.includes('TagStrategy'));
    const divZeroTrainers = [...trainerSet(divZero)];
    const roms = (list: ResolvedTrainer[]) => list.map((trainer) => trainer.romIndex).join(', ') || 'none';

    const ms = (value: number) => `${value.toFixed(1)} ms`;
    const lines = [
      'AI sweep summary (the hack\'s script and data; first world of each trainer; the AI\'s turn-1 knowledge):',
      `- Trainers: ${trainers.length} single-battle (${trainers.length - copies} catalog trainers and ${copies} other ROM copies of them); party members as leads: ${expected / PLAYERS.length}; player leads: ${PLAYERS.map((s) => s.name).join(', ')}.`,
      `- Worlds per trainer (worldsFor): 1 for ${worlds.filter((w) => w === 1).length}, more for ${worlds.filter((w) => w > 1).length}, at most ${Math.max(...worlds)}; ${worlds.reduce((a, b) => a + b, 0)} in all. The sweep runs the first.`,
      `- Decisions: ${decisions}. Returned: ${ok.length} (each sums to ONE). UNDEFINED: ${undefinedOnes.length}. DIV_ZERO: ${divZero.length}. Other failures: ${others.length}.`,
      `- Action kinds among the returned: a switch possible in ${ok.filter((o) => o.actions!.some((a) => a.action.kind === 'switch')).length}, an item in ${ok.filter((o) => o.actions!.some((a) => a.action.kind === 'item')).length}, a move in ${fought.length}.`,
      `- UNDEFINED by reason: ${countBy(undefinedOnes, (o) => undefinedReason(o.message!)).map(([reason, n]) => `${reason} ×${n}`).join('; ') || 'none'}.`,
      `- Slow path: ${fought.filter((o) => o.slow).length} of the ${fought.length} decisions whose move choice ran (the fast path returned null).`,
      `- Damage rolls fixed: ${rollDecisions} decisions. ${damageSites.size} damage-opcode sites are reachable from the swept flags; ${rollSites.size} pass ROLL_FOR_DAMAGE, so ${rollDecisions === 0 ? 'no run reads a damage roll' : `${rollTrainers.length} trainers can`}.`,
      `- Time per decide: p50 ${ms(percentile(times, 0.5))}, p99 ${ms(percentile(times, 0.99))}, max ${ms(slowest.ms)} (${label(slowest.trainer)}, lead ${slowest.lead}, vs ${slowest.player}, ${slowest.kind}${slowest.code ? ` ${slowest.code}` : ''}); total ${(times.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} s.`,
      `- Time per initialDecision (the engine's battle start included): p50 ${ms(percentile(viewTimes, 0.5))}, p99 ${ms(percentile(viewTimes, 0.99))}, max ${ms(viewTimes[viewTimes.length - 1] ?? 0)}; total ${(viewTimes.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} s.`,
      `- The AI's turn-1 knowledge isn't empty in ${outcomes.filter((outcome) => outcome.knows).length} decisions (a switch-in message named the player's ability or item).`,
      `- Views with no switch-in step fired: ${unstepped.length}, ${unstepped.every((outcome) => outcome.asLoaded) ? 'all equal to their load (initialLoad)' : `${unstepped.filter((outcome) => !outcome.asLoaded).length} NOT equal to their load`}; views with a step: ${outcomes.filter((outcome) => outcome.unstepped === false).length}.`,
      `- Trainers with two or more bag items: ${multiBag.length} (${multiBag.map((t) => `${t.romIndex}: ${bagOf(t).join('/')}`).join(', ')}).`,
      `- ROM bags with a gap between non-empty slots: ${gappedSwept.length} swept trainers${gappedSwept.length ? ` (${gappedSwept.map((t) => `${t.romIndex}: ${rawBags[t.romIndex]!.join('/')}`).join(', ')})` : ''}; ${gappedRom.length} of the ROM's ${rawBags.length} trainers${gappedRom.length ? ` (${gappedRom.map((i) => `${i}: ${rawBags[i]!.join('/')}`).join(', ')})` : ''}.`,
      `- Trainers with a Weather Ball user: ${weatherBallTrainers.length} (${weatherBallTrainers.map(label).join(', ') || 'none'}).`,
      `- Trainers with a Quick Claw holder: ${quickClawHolders.length}; of them, flags reaching IfSpeedCompare* or LoadBattlerSpeedRank: ${quickClawTrainers.length} (ROM ${roms(quickClawTrainers)}).`,
      `- Views listing an unknown path no reader guards: ${unguardedViews.length} decisions over ${trainerSet(unguardedViews).size} trainers, by path: ${byPath(unguardedViews, (o) => o.unguarded)}.`,
      `  Stopped at entry by assertGuarded: ${unguardedViews.length - notStopped.length} of them; by the path it named: ${byPath(unguardedViews.filter((o) => !notStopped.includes(o)), (o) => [o.message!.slice(UNGUARDED.length)])}.`,
      `- DIV_ZERO: ${divZero.length} decisions over ${divZeroTrainers.length} trainers, by message: ${countBy(divZero, (o) => o.message!).map(([m, n]) => `"${m}" ×${n}`).join('; ') || 'none'}.`,
      `  TagStrategy: ${divZeroTrainers.filter((t) => t.aiFlags.includes('TagStrategy')).length} of those trainers have it, of the ${tagStrategy.length} swept trainers that do. By ROM index (decisions): ${divZeroTrainers.map((t) => `${t.romIndex} (${divZero.filter((o) => o.trainer === t).length})`).join(', ') || 'none'}.`,
      `- Other failures: ${others.length}${others.length ? `: ${countBy(others, (o) => `${o.code}: ${o.message}`).map(([m, n]) => `${m} ×${n}`).join('; ')}` : ''}.`,
    ];
    console.log(lines.join('\n'));

    expect(decisions).toBe(expected);
    expect(others.map((o) => `${label(o.trainer)} lead ${o.lead} vs ${o.player}: ${o.code}: ${o.message}`)).toEqual([]);
    // The equivalence guard: every view with no switch-in step fired is its load, field for field.
    expect(unstepped.filter((outcome) => !outcome.asLoaded).map((o) => `${label(o.trainer)} lead ${o.lead} vs ${o.player}`)).toEqual([]);
    expect(unstepped.length).toBeGreaterThan(0);
    // No decision runs on a placeholder: every view with an unguarded path stopped at entry.
    expect(notStopped.map((o) => `${label(o.trainer)} lead ${o.lead} vs ${o.player}: ${o.kind} ${o.code ?? ''} ${o.message ?? ''}`)).toEqual([]);
    // Every UNDEFINED has a known reason.
    expect([...new Set(undefinedOnes.map((o) => undefinedReason(o.message!)))].sort()).toEqual([...EXPECTED_UNDEFINED_REASONS].sort());
  });

  it('no decision divides by zero (each DIV_ZERO is listed in the summary)', () => {
    const divZero = outcomes.filter((outcome) => outcome.code === 'DIV_ZERO');
    expect(divZero.map((o) => `${label(o.trainer)} lead ${o.lead} vs ${o.player}: ${o.message}`).slice(0, 20)).toEqual([]);
    expect(divZero.length).toBe(0);
  });
});
