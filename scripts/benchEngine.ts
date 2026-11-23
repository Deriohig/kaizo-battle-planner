// `npm run bench:engine -- [options]`: the battle engine's throughput, and the proof times it projects.
// It prints a table and writes docs/engine-throughput.md. `--help` lists the options; `--quick` is a short run.
//
// Fights. With the player's data (`data/` from `npm run extract`, and his save at PK_SAVE): an early 3v3 trainer, Leader
// Roark (the early 6v6 gym) and Leader Volkner (a late 6v6 gym) against the player's eligible team, plus Volkner against that
// team raised to Volkner's top level (synthetic: the only level-matched late 6v6 his save allows). Without the data:
// the fixture fights (test/unit/engine/fixtures.ts).
//
// Phases, all on this thread unless said:
// 1. Corpus: every legal (p1, p2) pair at each fight's root, in a seeded random order within a leaf budget; then
//    chains of successor states (the most probable outcomes of move-against-move pairs), a few turns deep, each with a
//    sample of its pairs. Each expansion is timed; a LIMIT is counted and the run goes on.
// 2. LIMIT probes: a few LIMIT expansions again with a higher `maxLeaves`, to size the worst cases.
// 3. Timing: a fixed sample of the corpus's expansions, `--runs` times; the best and the median leaves per second.
// 4. Leaf profile: the sample once more with the engine's opt-in leaf timing (src/engine/profile.ts).
// 5. Scaling: the sample on N worker threads at once, for each N in `--threads`; total leaves per second.
// 6. Projection: (w × s × o)^d tree nodes at 3, 5 and 8 turns, as time on 12 threads, with and without a 50%
//    transposition hit rate, and the decision rule.
// The load average (`os.loadavg()`, what `uptime` prints) and nproc are recorded beside every measurement.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg } from 'node:os';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { buildCatalog } from '../src/battle/catalog.js';
import { buildMoves } from '../src/battle/moves.js';
import { eligibleTeam, type PlayerMon } from '../src/battle/playerMon.js';
import type { ResolvedTrainer } from '../src/battle/types.js';
import type { BattleInput, Choice, EngineState, Outcome, Phase, Side } from '../src/contracts/engine.js';
import { loadLocalData } from '../src/data/load.js';
import {
  applyChoices, ChanceDriver, type ChancePoint, engineId, EngineError, installKaizoDex, restore, showdownEngine, toNumber,
} from '../src/engine/index.js';
import { serializedKey } from '../src/engine/key.js';
import { LEAF_PHASES, type LeafPhase, startLeafProfile, stopLeafProfile } from '../src/engine/profile.js';
import { calcHp } from '../src/rom/stats.js';
import { DEFAULT_GRAVEYARD_BOXES, readSave } from '../src/save/readSave.js';
import { BAG, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from '../test/unit/engine/fixtures.js';

const engine = showdownEngine;
type Choices = { p1?: Choice; p2?: Choice };
type Mode = 'real' | 'fixture';
type Load = [number, number, number];
type ShowdownBattle = ReturnType<typeof restore>;

const DEFAULT_SAVE = 'data/saves/pk-run.dsv';

// ---------------------------------------------------------------------------------------------------------------------
// Options.

const DEFAULTS = {
  data: 'auto', fights: '', 'trainer-3v3': 'roark-split/lass-sarah/1', 'trainer-6v6': 'roark-split/leader-roark/1',
  'trainer-late': 'volkner-split/leader-volkner/1', seed: '1', 'fight-leaves': '60000', chains: '3', depth: '4', pairs: '12',
  'max-leaves': '20000', probes: '1', 'probe-leaves': '60000', 'sample-leaves': '16000', runs: '3', threads: '12,6,4,2,1',
  'scale-leaves': '8000', cooldown: '15', 'typical-3v3': '5', 'typical-6v6': '8', budget: '300', doc: 'docs/engine-throughput.md',
} as const;

/** What `--quick` changes, for the options not given. About five minutes. */
const QUICK: Partial<Record<keyof typeof DEFAULTS, string>> = {
  'fight-leaves': '10000', chains: '1', depth: '2', pairs: '8', probes: '0', 'sample-leaves': '6000', threads: '12,1',
  'scale-leaves': '3000', cooldown: '5',
};

const HELP = `npm run bench:engine -- [options]
  --data auto|real|fixture   the player's data (data/ and the save) or the fixture fights; auto: real when both exist
  --save <path>              the player's save (default: $PK_SAVE, else ${DEFAULT_SAVE})
  --fights a,b               fights to run: 3v3, 6v6, late, late-matched (real); fixture-3v3, fixture-6v6 (fixture)
  --trainer-3v3 <id>         trainer IDs (catalog IDs, as npm run sheet prints them); defaults: ${DEFAULTS['trainer-3v3']},
  --trainer-6v6 <id>           ${DEFAULTS['trainer-6v6']}, ${DEFAULTS['trainer-late']}
  --trainer-late <id>
  --seed N                   the pair order's seed (${DEFAULTS.seed})
  --fight-leaves N           corpus leaf budget per fight (${DEFAULTS['fight-leaves']}); the root takes up to 60% of it
  --chains N                 successor chains per fight (${DEFAULTS.chains})
  --depth N                  turn levels per chain, the root included (${DEFAULTS.depth})
  --pairs N                  choice pairs expanded per successor state (${DEFAULTS.pairs})
  --max-leaves N             expandTurn's maxLeaves in the corpus (${DEFAULTS['max-leaves']}, the engine's default)
  --probes N                 LIMIT expansions re-run with --probe-leaves (${DEFAULTS.probes}; 0 skips)
  --probe-leaves N           (${DEFAULTS['probe-leaves']})
  --sample-leaves N          leaves in the timing sample, split evenly over the fights (${DEFAULTS['sample-leaves']})
  --runs N                   single-thread timing runs of the sample (${DEFAULTS.runs})
  --threads a,b              worker thread counts for the scaling runs (${DEFAULTS.threads}); 1 is always added
  --scale-leaves N           leaves each worker runs (${DEFAULTS['scale-leaves']}), taken from the sample
  --cooldown S               idle seconds before each scaling run, so this run's own load decays (${DEFAULTS.cooldown})
  --typical-3v3 N            turns of a typical 3v3 for the decision (${DEFAULTS['typical-3v3']})
  --typical-6v6 N            turns of a typical 6v6 for the decision (${DEFAULTS['typical-6v6']})
  --budget S                 the proof budget in seconds (${DEFAULTS.budget}: the default 5 minutes)
  --doc <path>               where the report goes (${DEFAULTS.doc}); --no-doc writes none
  --no-normalise             skip the effectOrder estimate (it re-keys every outcome)
  --no-machine-cpu           skip the whole-machine CPU samples (Windows typeperf through WSL interop, ~1.5 s each)
  --quick                    a short run: ${Object.entries(QUICK).map(([key, value]) => `--${key} ${value}`).join(' ')}`;

interface Args {
  data: 'auto' | Mode; save: string; fights: string[]; trainers: { t3: string; t6: string; late: string }; seed: number;
  fightLeaves: number; chains: number; depth: number; pairs: number; maxLeaves: number; probes: number; probeLeaves: number;
  sampleLeaves: number; runs: number; threads: number[]; scaleLeaves: number; cooldown: number; typical3: number;
  typical6: number; budget: number; doc: string | null; normalise: boolean; machineCpu: boolean; quick: boolean; argv: string[];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function cliArgs(): Args {
  const options = Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, { type: 'string' as const }]));
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      options: {
        ...options, save: { type: 'string' }, // in --help, but not a DEFAULTS key (its default is $PK_SAVE)
        'no-doc': { type: 'boolean' }, 'no-normalise': { type: 'boolean' }, 'no-machine-cpu': { type: 'boolean' },
        quick: { type: 'boolean' }, help: { type: 'boolean' },
      },
    }).values;
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n${HELP}`);
  }
  if (values['help'] === true) {
    console.log(HELP);
    process.exit(0);
  }
  const quick = values['quick'] === true;
  const text = (key: keyof typeof DEFAULTS): string => (values[key] as string | undefined) ?? (quick ? QUICK[key] : undefined) ?? DEFAULTS[key];
  const whole = (key: keyof typeof DEFAULTS, min: number): number => {
    const value = Number(text(key));
    if (!Number.isInteger(value) || value < min) fail(`--${key} must be a whole number from ${min}\n${HELP}`);
    return value;
  };
  const data = text('data');
  if (data !== 'auto' && data !== 'real' && data !== 'fixture') fail(`--data must be auto, real or fixture\n${HELP}`);
  const threads = text('threads').split(',').map(Number);
  if (threads.some((n) => !Number.isInteger(n) || n < 1)) fail(`--threads must list whole numbers from 1\n${HELP}`);
  return {
    data, save: (values['save'] as string | undefined) || process.env['PK_SAVE'] || DEFAULT_SAVE,
    fights: text('fights').split(',').map((id) => id.trim()).filter(Boolean),
    trainers: { t3: text('trainer-3v3'), t6: text('trainer-6v6'), late: text('trainer-late') }, seed: whole('seed', 0),
    fightLeaves: whole('fight-leaves', 1), chains: whole('chains', 0), depth: whole('depth', 1), pairs: whole('pairs', 1),
    maxLeaves: whole('max-leaves', 1), probes: whole('probes', 0), probeLeaves: whole('probe-leaves', 1),
    sampleLeaves: whole('sample-leaves', 1), runs: whole('runs', 1),
    threads: [...new Set([...threads, 1])].sort((a, b) => b - a), scaleLeaves: whole('scale-leaves', 1),
    cooldown: whole('cooldown', 0), typical3: whole('typical-3v3', 1), typical6: whole('typical-6v6', 1), budget: whole('budget', 1),
    doc: values['no-doc'] === true ? null : text('doc'), normalise: values['no-normalise'] !== true, machineCpu: values['no-machine-cpu'] !== true,
    quick, argv: process.argv.slice(2),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Small helpers: load, statistics, formatting, a seeded order.

const nproc = availableParallelism();
const loadNow = (): Load => loadavg() as Load;
const fmtLoad = (load: Load): string => load.map((value) => value.toFixed(2)).join(' ');

/**
 * This run's own share of the 1-minute load average, estimated: Linux updates it as an exponential average of the
 * runnable threads with a 60 s time constant (kernel/sched/loadavg.c), so the bench tracks how many threads it keeps
 * busy and averages that the same way. The 1-minute load minus this is roughly what other processes in the WSL VM add.
 */
const own = { value: 0, threads: 0, at: performance.now() };

function ownAdvance(): void {
  const now = performance.now();
  const decay = Math.exp(-(now - own.at) / 60_000);
  own.value = own.value * decay + own.threads * (1 - decay);
  own.at = now;
}

function ownBusy(threads: number): void {
  ownAdvance();
  own.threads = threads;
}

function ownLoad(): number {
  ownAdvance();
  return own.value;
}

/**
 * The whole machine's CPU use in percent over one second, from Windows (`typeperf`, through WSL interop), or null
 * where it can't be read. The load average sees only the WSL VM's processes; this sees Windows-side work too (the VM's
 * own CPU included). The bench is idle while it samples (`execSync` blocks), so it measures everything else.
 */
let machineCpuOff = false;
function machineCpu(): number | null {
  if (machineCpuOff) return null;
  for (const command of ['typeperf.exe', '/mnt/c/Windows/System32/typeperf.exe']) {
    try {
      const text = execSync(`${command} "\\Processor(_Total)\\% Processor Time" -sc 1`, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
      const match = /^"[^"]*","([\d.]+)"/m.exec(text);
      if (match !== null) return Number(match[1]);
    } catch {
      // try the next path
    }
  }
  machineCpuOff = true; // not on this machine: don't try again
  return null;
}

/** The conditions a measurement started and ended in. */
interface Conditions { loadBefore: Load; loadAfter: Load; ownBefore: number; ownAfter: number; cpuBefore: number | null }

function conditionsStart(sampleCpu = true): Omit<Conditions, 'loadAfter' | 'ownAfter'> {
  const cpuBefore = sampleCpu ? machineCpu() : null;
  return { loadBefore: loadNow(), ownBefore: ownLoad(), cpuBefore };
}

function conditionsEnd(start: Omit<Conditions, 'loadAfter' | 'ownAfter'>): Conditions {
  return { ...start, loadAfter: loadNow(), ownAfter: ownLoad() };
}

const fmtCpu = (cpu: number | null): string => (cpu === null ? 'n/a' : `${cpu.toFixed(0)}% (≈${((cpu * nproc) / 100).toFixed(1)} threads)`);
const fmtOwn = (c: Conditions): string => `${c.ownBefore.toFixed(1)} → ${c.ownAfter.toFixed(1)}`;

function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The nearest-rank quantile. */
function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

const mean = (values: readonly number[]): number => (values.length === 0 ? NaN : values.reduce((a, b) => a + b, 0) / values.length);
const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

function int(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function num(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 'n/a' : '∞';
  if (Math.abs(value) >= 1e6) return value.toExponential(2).replace('e+', 'e');
  if (Math.abs(value) >= 1000) return int(value);
  return value.toFixed(digits);
}

/**
 * A number for an arithmetic line: whole numbers in full, others to 2 decimals (trailing zeros dropped), so the
 * printed factors multiply out to the printed result. Past 1e15, 4 significant digits.
 */
function exact(value: number): string {
  if (!Number.isFinite(value)) return num(value);
  if (Math.abs(value) >= 1e15) return value.toExponential(3).replace('e+', 'e');
  const [whole, fraction] = (Math.round(value * 100) / 100).toFixed(2).split('.');
  const digits = fraction!.replace(/0+$/, '');
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${digits ? `.${digits}` : ''}`;
}

/** Seconds for an arithmetic line, with the readable duration beside it once it is past two minutes. */
const secs = (seconds: number): string => `${exact(seconds)} s${seconds >= 120 ? ` (${duration(seconds)})` : ''}`;

function duration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'n/a';
  const year = 365.25 * 86400;
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`;
  if (seconds < 120) return `${seconds.toFixed(1)} s`;
  if (seconds < 7200) return `${(seconds / 60).toFixed(1)} min`;
  if (seconds < 2 * 86400) return `${(seconds / 3600).toFixed(1)} h`;
  if (seconds < year) return `${(seconds / 86400).toFixed(1)} days`;
  return `${num(seconds / year, 1)} years`;
}

/** mulberry32: a small seeded generator, so pair orders repeat run to run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

const textSeed = (text: string): number => [...text].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------------------
// Data and fights.

interface Fight {
  id: string; cls: '3v3' | '6v6'; title: string; trainer: string; player: string; synthetic: string | null; state: EngineState;
}

/** Installs the mod for `mode` (as each worker does too). Real data comes from data/; the fixture's is built in memory. */
function installData(mode: Mode): ReturnType<typeof loadLocalData> | null {
  if (mode === 'fixture') {
    const { data, moves } = fixtureDex();
    installKaizoDex(data, moves);
    return null;
  }
  const data = loadLocalData();
  installKaizoDex(data, buildMoves(data));
  return data;
}

function realDataPresent(save: string): boolean {
  return existsSync('data/rom/romdata.json') && existsSync('data/docs') && existsSync(save);
}

const teamText = (team: PlayerMon[]) => team.map((mon) => `${mon.nickname} (${mon.name}) L${mon.level}`).join(', ');
const partyText = (trainer: ResolvedTrainer) => trainer.party.map((mon) => `${mon.name} L${mon.level}`).join(', ');

/** `team` raised to `level`: the same species, moves, IVs, EVs and nature, at full HP and healthy. Synthetic. */
function raised(team: PlayerMon[], level: number): PlayerMon[] {
  return team.map((mon) => ({ ...mon, level, currentHp: calcHp(mon.baseStats.hp, mon.ivs.hp, mon.evs.hp, level), status: { kind: 'none' } }));
}

function realFights(args: Args): Fight[] {
  const data = installData('real')!;
  const save = readSave(readFileSync(args.save), data.rom);
  const team = eligibleTeam(save, data, { graveyardBoxes: DEFAULT_GRAVEYARD_BOXES, levelCap: 100 });
  const party = team.filter((mon) => mon.location.kind === 'party');
  const six = (party.length >= 6 ? party : team).slice(0, 6);
  const catalog = buildCatalog(data);
  const trainer = (id: string) => catalog.byId(id) ?? fail(`No trainer ${id} in the catalog (npm run sheet -- --trainer <text> finds IDs)`);
  const t3 = trainer(args.trainers.t3);
  const t6 = trainer(args.trainers.t6);
  const late = trainer(args.trainers.late);
  const top = Math.max(...late.party.map((mon) => mon.level));
  const fight = (id: string, cls: Fight['cls'], foe: ResolvedTrainer, player: PlayerMon[], synthetic: string | null): Fight => {
    const input: BattleInput = { player, trainer: foe, field: {} };
    return {
      id, cls, title: `${foe.name} (${foe.location})`, trainer: `${foe.name}, ${foe.id} (ROM ${foe.romIndex}): ${partyText(foe)}`,
      player: teamText(player), synthetic, state: engine.createBattle(input),
    };
  };
  const all: (() => Fight)[] = [
    () => fight('3v3', '3v3', t3, (party.length >= 3 ? party : team).slice(0, 3), null),
    () => fight('6v6', '6v6', t6, six, null),
    () => fight('late', '6v6', late, six, null),
    () => fight('late-matched', '6v6', late, raised(six, top), `The player's six raised to L${top} (Volkner's top level), full HP: not his real team`),
  ];
  const ids = ['3v3', '6v6', 'late', 'late-matched'];
  const wanted = args.fights.length === 0 ? ids : args.fights;
  for (const id of wanted) if (!ids.includes(id)) fail(`No real fight "${id}" (real fights: ${ids.join(', ')})`);
  return ids.flatMap((id, k) => (wanted.includes(id) ? [all[k]!()] : []));
}

function fixtureFights(args: Args): Fight[] {
  installData('fixture');
  const t3 = resolvedTrainer(BAG.none, [
    resolvedMon(ID.zigzagoon, 30, [ID.tackle, ID.furyAttack, ID.slash, ID.return]),
    resolvedMon(ID.castform, 30, [ID.waterBall, ID.hurricane, ID.tackle]),
    resolvedMon(ID.monferno, 30, [ID.ember, ID.megaKick, ID.slash]),
  ]);
  const p3 = [
    playerMon(ID.monferno, 30, [ID.ember, ID.slash, ID.megaKick, ID.tackle]),
    playerMon(ID.bidoof, 30, [ID.waterBall, ID.furyAttack, ID.thunder, ID.tackle]),
    playerMon(ID.castform, 30, [ID.fireBall, ID.blizzard, ID.hurricane, ID.tackle]),
  ];
  const t6 = resolvedTrainer(BAG.fullRestore, [
    ...t3.party, resolvedMon(ID.bidoof, 31, [ID.waterBall, ID.thunder, ID.slash]), resolvedMon(ID.zigzagoon, 31, [ID.megaKick, ID.slash]),
    resolvedMon(ID.castform, 31, [ID.fireBall, ID.blizzard, ID.tackle]),
  ]);
  const p6 = [
    ...p3, playerMon(ID.zigzagoon, 30, [ID.tackle, ID.slash, ID.return]), playerMon(ID.bidoof, 30, [ID.waterBall, ID.megaKick]),
    playerMon(ID.monferno, 30, [ID.fireBall, ID.plainHit]),
  ];
  const fight = (id: string, cls: Fight['cls'], trainer: ResolvedTrainer, player: PlayerMon[]): Fight => ({
    id, cls, title: `fixture ${cls}`, trainer: `fixture trainer (ROM bag ${trainer.romIndex}): ${partyText(trainer)}`, player: teamText(player),
    synthetic: 'fixture data (invented teams over the hack\'s fixture species and moves)', state: engine.createBattle({ player, trainer, field: {} }),
  });
  const ids = ['fixture-3v3', 'fixture-6v6'];
  const wanted = args.fights.length === 0 ? ids : args.fights;
  for (const id of wanted) if (!ids.includes(id)) fail(`No fixture fight "${id}" (fixture fights: ${ids.join(', ')})`);
  return [
    ...(wanted.includes('fixture-3v3') ? [fight('fixture-3v3', '3v3', t3, p3)] : []),
    ...(wanted.includes('fixture-6v6') ? [fight('fixture-6v6', '6v6', t6, p6)] : []),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Running one expansion.

/** Leaves of one `expandTurn`: the sum of its outcomes' `merged`; a LIMIT ran `maxLeaves` leaves before it threw. */
function expandCounted(state: EngineState, choices: Choices, maxLeaves: number): { leaves: number; outcomes: Outcome[] | null; limit: boolean } {
  try {
    const outcomes = engine.expandTurn(state, choices, { maxLeaves });
    return { leaves: sum(outcomes.map((outcome) => outcome.merged)), outcomes, limit: false };
  } catch (error) {
    if (error instanceof EngineError && error.code === 'LIMIT') return { leaves: maxLeaves, outcomes: null, limit: true };
    throw error;
  }
}

/** The chance points of the step's first path (every chance taking its first option). */
function firstPath(state: EngineState, choices: Choices): ChancePoint[] {
  const driver = new ChanceDriver([]);
  const battle = restore(state, driver);
  applyChoices(battle, choices);
  return driver.points;
}

/** "multiHit:furyswipes(4) crit:furyswipes×2(2)": each kind and source on the path, its count and most options. */
function pathText(points: readonly ChancePoint[]): string {
  const groups = new Map<string, { count: number; options: number }>();
  for (const point of points) {
    const options = point.options.filter((option) => option.weight > 0n).length;
    const name = `${point.kind}:${point.source}`;
    const group = groups.get(name) ?? { count: 0, options: 0 };
    group.count += 1;
    group.options = Math.max(group.options, options);
    groups.set(name, group);
  }
  return [...groups].map(([name, group]) => `${name}${group.count > 1 ? `×${group.count}` : ''}(${group.options})`).join(' ') || 'none';
}

/**
 * Every chance on any outcome's path (each outcome carries its most probable leaf's labels): "kind:source×n", n the
 * most times it occurs on one outcome, in order of first appearance.
 */
function labelsText(outcomes: readonly Outcome[]): string {
  const most = new Map<string, number>();
  for (const outcome of outcomes) {
    const counts = new Map<string, number>();
    for (const label of outcome.labels) {
      const name = `${label.kind}:${label.source}`;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const [name, count] of counts) most.set(name, Math.max(most.get(name) ?? 0, count));
  }
  return [...most].map(([name, count]) => `${name}${count > 1 ? `×${count}` : ''}`).join(' ') || 'none';
}

/** A choice's text, and the move's Showdown multi-hit (an array for 2–5 hits, a number for fixed hits) if it has one. */
function choiceName(battle: ShowdownBattle, side: Side, choice: Choice | undefined): { text: string; multiHit: string | null } {
  if (choice === undefined) return { text: '', multiHit: null };
  if (choice.kind === 'item') return { text: `item ${choice.item}`, multiHit: null };
  const own = battle[side];
  if (choice.kind === 'switch') {
    const set = own.team[choice.index];
    return { text: `switch to ${own.pokemon.find((pokemon) => pokemon.set === set)?.name ?? choice.index}`, multiHit: null };
  }
  const request = own.activeRequest as { active?: { moves: { move: string; id: string }[] }[] } | null;
  const entry = request?.active?.[0]?.moves[choice.slot];
  if (entry === undefined) return { text: `move ${choice.slot}`, multiHit: null };
  const hits = battle.dex.moves.get(entry.id).multihit;
  return { text: entry.move, multiHit: hits === undefined ? null : `${entry.move} (${Array.isArray(hits) ? hits.join('–') : hits} hits)` };
}

/** "NUTZZZZZZZ Scratch / Shinx Fury Swipes", and the multi-hit moves chosen. */
function describePair(state: EngineState, choices: Choices): { text: string; multiHit: string[] } {
  const battle = restore(state);
  const names = { p1: choiceName(battle, 'p1', choices.p1), p2: choiceName(battle, 'p2', choices.p2) };
  const side = (id: Side) => `${battle[id].active[0]?.name ?? id} ${choices[id] === undefined ? 'waits' : names[id].text}`;
  return { text: `${side('p1')} / ${side('p2')}`, multiHit: [names.p1.multiHit, names.p2.multiHit].filter((hit): hit is string => hit !== null) };
}

function withoutEffectOrder(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) withoutEffectOrder(entry);
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    delete record['effectOrder'];
    for (const entry of Object.values(record)) withoutEffectOrder(entry);
  }
}

/** The state key with every `effectOrder` dropped: what an effectOrder normalisation could at most merge. */
function keyWithoutEffectOrder(state: EngineState): string {
  const parsed = JSON.parse(state.json) as Record<string, unknown>;
  withoutEffectOrder(parsed);
  return serializedKey(parsed);
}

// ---------------------------------------------------------------------------------------------------------------------
// The corpus.

interface Run {
  fight: string; depth: number; phase: Phase['kind']; state: EngineState; choices: Choices; pair: string; moveVsMove: boolean;
  leaves: number; outcomes: number | null; ms: number; limit: boolean; error: string | null; path: string; chances: string;
  multiHit: string[]; outcomesWithoutEffectOrder: number | null; best: EngineState | null; bestProbability: number;
}

/** A state the corpus expanded: its legal choice counts, its pairs (or one side's choices) and how many were expanded. */
interface Visit { fight: string; depth: number; phase: Phase['kind']; w: number; p2: number; pairs: number; expanded: number }

interface Corpus {
  fight: Fight; runs: Run[]; visits: Visit[]; leaves: number; ms: number; conditions: Conditions;
  keys: Set<string>; keysWithoutEffectOrder: Set<string>; keyChecks: number; keyMismatches: number;
}

const CONTINUES: ReadonlySet<Phase['kind']> = new Set(['turnChoice', 'enemyReplacement', 'enemyMidTurnSwitch', 'playerMidTurnSwitch']);

function expandRun(corpus: Corpus, args: Args, state: EngineState, depth: number, choices: Choices): Run {
  const { text: pair, multiHit } = describePair(state, choices);
  let points: ChancePoint[] = [];
  let pathError: string | null = null;
  try {
    points = firstPath(state, choices);
  } catch (error) {
    pathError = error instanceof Error ? error.message : String(error);
  }
  const run: Run = {
    fight: corpus.fight.id, depth, phase: state.phase.kind, state, choices, pair,
    moveVsMove: choices.p1?.kind === 'move' && choices.p2?.kind === 'move', leaves: 0, outcomes: null, ms: 0, limit: false, error: pathError,
    path: pathText(points), chances: '', multiHit, outcomesWithoutEffectOrder: null, best: null, bestProbability: 0,
  };
  if (pathError !== null) {
    corpus.runs.push(run);
    return run;
  }
  const start = performance.now();
  let result: ReturnType<typeof expandCounted> | null = null;
  try {
    result = expandCounted(state, choices, args.maxLeaves);
  } catch (error) {
    run.error = error instanceof Error ? error.message.split('\n')[0]! : String(error);
  }
  run.ms = performance.now() - start;
  if (result !== null) {
    run.leaves = result.leaves;
    run.limit = result.limit;
    corpus.leaves += result.leaves;
    corpus.ms += run.ms;
  }
  const outcomes = result?.outcomes ?? null;
  if (outcomes !== null) {
    run.outcomes = outcomes.length;
    run.chances = labelsText(outcomes);
    for (const outcome of outcomes) {
      const p = toNumber(outcome.probability);
      if (CONTINUES.has(outcome.state.phase.kind) && outcome.fainted.p1.length === 0 && p > run.bestProbability) {
        run.best = outcome.state;
        run.bestProbability = p;
      }
    }
    if (args.normalise) {
      const merged = new Set<string>();
      for (const outcome of outcomes) {
        const key = keyWithoutEffectOrder(outcome.state);
        if (corpus.keyChecks < 50) {
          corpus.keyChecks += 1;
          if (serializedKey(JSON.parse(outcome.state.json) as Record<string, unknown>) !== outcome.state.key) corpus.keyMismatches += 1;
        }
        corpus.keys.add(outcome.state.key);
        corpus.keysWithoutEffectOrder.add(key);
        merged.add(`${key}|${outcome.critBy.p1}|${outcome.critBy.p2}|${outcome.observation}`);
      }
      run.outcomesWithoutEffectOrder = merged.size;
    }
  }
  corpus.runs.push(run);
  return run;
}

/**
 * Settles a successor that waits on one side's switch (an enemy replacement, a U-turn): each of that side's choices is
 * expanded, and the walk goes on from the most probable outcome of the first. Null for a finished battle or a death.
 */
function settle(corpus: Corpus, args: Args, start: EngineState, depth: number): EngineState | null {
  let state: EngineState | null = start;
  for (let step = 0; step < 4 && state !== null; step++) {
    const kind: Phase['kind'] = state.phase.kind;
    if (kind === 'turnChoice') return state;
    if (kind === 'terminal' || kind === 'playerReplacement') return null;
    const side: Side = kind === 'playerMidTurnSwitch' ? 'p1' : 'p2';
    const choices = engine.legalChoices(state, side);
    corpus.visits.push({
      fight: corpus.fight.id, depth, phase: kind, w: side === 'p1' ? choices.length : 0, p2: side === 'p2' ? choices.length : 0,
      pairs: choices.length, expanded: choices.length,
    });
    let next: EngineState | null = null;
    for (const choice of choices) {
      const run = expandRun(corpus, args, state, depth, { [side]: choice });
      next ??= run.best;
    }
    state = next;
  }
  return state?.phase.kind === 'turnChoice' ? state : null;
}

/**
 * Expands pairs of `state` (after `settle`): all of them in a seeded order at the root, else up to `maxPairs`, half of
 * them move against move. Stops at `budget` leaves for the fight. Returns up to `successors` distinct successor states:
 * the most probable continuing outcome of each move-against-move pair, most probable first.
 */
function visit(corpus: Corpus, args: Args, start: EngineState, depth: number, maxPairs: number, successors: number, budget: number): EngineState[] {
  const state = settle(corpus, args, start, depth);
  if (state === null) return [];
  const p1 = engine.legalChoices(state, 'p1');
  const p2 = engine.legalChoices(state, 'p2');
  const random = seeded(args.seed + textSeed(`${corpus.fight.id}|${state.key}`));
  const pairs = p1.flatMap((a) => p2.map((b): Choices => ({ p1: a, p2: b })));
  const entry: Visit = { fight: corpus.fight.id, depth, phase: 'turnChoice', w: p1.length, p2: p2.length, pairs: pairs.length, expanded: 0 };
  corpus.visits.push(entry);
  const isMoveVsMove = (pair: Choices) => pair.p1?.kind === 'move' && pair.p2?.kind === 'move';
  let order: Choices[];
  if (maxPairs >= pairs.length) {
    order = shuffled(pairs, random);
  } else {
    const attacks = shuffled(pairs.filter(isMoveVsMove), random);
    const others = shuffled(pairs.filter((pair) => !isMoveVsMove(pair)), random);
    const fromAttacks = Math.min(attacks.length, Math.ceil(maxPairs / 2));
    order = [...attacks.slice(0, fromAttacks), ...others.slice(0, maxPairs - fromAttacks)];
    if (order.length < maxPairs) order.push(...attacks.slice(fromAttacks, fromAttacks + maxPairs - order.length));
  }
  const candidates: { state: EngineState; probability: number }[] = [];
  for (const pair of order) {
    if (corpus.leaves >= budget) break;
    const run = expandRun(corpus, args, state, depth, pair);
    entry.expanded += 1;
    if (run.moveVsMove && run.best !== null) candidates.push({ state: run.best, probability: run.bestProbability });
  }
  candidates.sort((a, b) => b.probability - a.probability);
  const seen = new Set<string>();
  return candidates.filter((candidate) => !seen.has(candidate.state.key) && seen.add(candidate.state.key)).slice(0, successors).map((candidate) => candidate.state);
}

function buildCorpus(fight: Fight, args: Args): Corpus {
  const start = conditionsStart();
  const corpus: Corpus = {
    fight, runs: [], visits: [], leaves: 0, ms: 0, conditions: conditionsEnd(start), keys: new Set(),
    keysWithoutEffectOrder: new Set(), keyChecks: 0, keyMismatches: 0,
  };
  const heads = visit(corpus, args, fight.state, 0, Infinity, args.chains, Math.ceil(args.fightLeaves * 0.6));
  for (const head of heads) {
    let state: EngineState | null = head;
    for (let depth = 1; depth < args.depth && state !== null && corpus.leaves < args.fightLeaves; depth++) {
      state = visit(corpus, args, state, depth, args.pairs, 1, args.fightLeaves)[0] ?? null;
    }
  }
  corpus.conditions = conditionsEnd(start);
  return corpus;
}

// ---------------------------------------------------------------------------------------------------------------------
// Timing.

interface Task { fight: string; state: EngineState; choices: Choices; leaves: number }

interface Timing { label: string; threads: number; leaves: number; seconds: number; conditions: Conditions; byFight: Record<string, { leaves: number; seconds: number }> }

/** Up to `leaves` / fights leaves per fight from completed corpus expansions, in a seeded order, skipping any larger than that share. */
function pickSample(corpora: Corpus[], leaves: number, seed: number): Task[] {
  const share = leaves / corpora.length;
  return corpora.flatMap((corpus) => {
    const random = seeded(seed + textSeed(`sample|${corpus.fight.id}`));
    const done = shuffled(corpus.runs.filter((run) => !run.limit && run.error === null && run.outcomes !== null), random);
    const picked: Task[] = [];
    let total = 0;
    for (const run of done) {
      if (total >= share) break;
      if (run.leaves > share && picked.length > 0) continue;
      picked.push({ fight: corpus.fight.id, state: run.state, choices: run.choices, leaves: run.leaves });
      total += run.leaves;
    }
    return picked;
  });
}

function timeTasks(label: string, tasks: readonly Task[], maxLeaves: number): Timing {
  const conditions = conditionsStart();
  const byFight: Timing['byFight'] = {};
  let leaves = 0;
  let seconds = 0;
  for (const task of tasks) {
    const start = performance.now();
    const ran = expandCounted(task.state, task.choices, maxLeaves).leaves;
    const elapsed = (performance.now() - start) / 1000;
    const entry = (byFight[task.fight] ??= { leaves: 0, seconds: 0 });
    entry.leaves += ran;
    entry.seconds += elapsed;
    leaves += ran;
    seconds += elapsed;
  }
  return { label, threads: 1, leaves, seconds, conditions: conditionsEnd(conditions), byFight };
}

interface Profile { leaves: number; seconds: number; phases: Record<LeafPhase, number>; outside: number; conditions: Conditions }

function profileTasks(tasks: readonly Task[], maxLeaves: number): Profile {
  const conditions = conditionsStart();
  startLeafProfile();
  const start = performance.now();
  for (const task of tasks) expandCounted(task.state, task.choices, maxLeaves);
  const seconds = (performance.now() - start) / 1000;
  const profile = stopLeafProfile();
  const phases = Object.fromEntries(LEAF_PHASES.map((phase) => [phase, profile.ms[phase] / 1000])) as Record<LeafPhase, number>;
  return { leaves: profile.leaves, seconds, phases, outside: seconds - sum(Object.values(phases)), conditions: conditionsEnd(conditions) };
}

// Worker threads: each installs the data itself, warms up, waits for "go", runs its tasks, and reports.

interface WorkerInput { mode: Mode; tasks: Task[]; maxLeaves: number }
type WorkerMessage = { type: 'ready' } | { type: 'done'; leaves: number; ms: number };

function runWorker(): void {
  const input = workerData as WorkerInput;
  installData(input.mode);
  for (const task of input.tasks.slice(0, 2)) expandCounted(task.state, task.choices, input.maxLeaves); // warm-up
  parentPort!.postMessage({ type: 'ready' } satisfies WorkerMessage);
  parentPort!.once('message', () => {
    const start = performance.now();
    let leaves = 0;
    for (const task of input.tasks) leaves += expandCounted(task.state, task.choices, input.maxLeaves).leaves;
    parentPort!.postMessage({ type: 'done', leaves, ms: performance.now() - start } satisfies WorkerMessage);
  });
}

/**
 * One scaling run. `idle` is the conditions after the cool-down, before any worker exists (the machine CPU sample is
 * taken then, while the bench is idle); the run's own conditions start when every worker is ready.
 */
async function scalingRun(threads: number, mode: Mode, tasks: Task[], maxLeaves: number): Promise<Timing & { perWorker: number[]; idle: Conditions }> {
  ownBusy(0);
  const idleStart = conditionsStart();
  const idle = conditionsEnd(idleStart);
  ownBusy(threads); // the workers load the data and warm up at once
  const workers = Array.from({ length: threads }, () => new Worker(new URL(import.meta.url), { workerData: { mode, tasks, maxLeaves } satisfies WorkerInput }));
  const next = (worker: Worker) => new Promise<WorkerMessage>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  try {
    await Promise.all(workers.map(next)); // ready
    const start = conditionsStart(false);
    const startTime = performance.now();
    const done = workers.map(next);
    for (const worker of workers) worker.postMessage('go');
    const results = await Promise.all(done);
    const seconds = (performance.now() - startTime) / 1000;
    const leaves = sum(results.map((result) => (result.type === 'done' ? result.leaves : 0)));
    const perWorker = results.map((result) => (result.type === 'done' ? result.leaves / (result.ms / 1000) : 0));
    const conditions = conditionsEnd(start);
    return { label: `${threads} thread${threads === 1 ? '' : 's'}`, threads, leaves, seconds, conditions, byFight: {}, perWorker, idle };
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    ownBusy(0);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Statistics, projection and the decision.

interface Dist { n: number; median: number; p90: number; max: number; mean: number }
const dist = (values: readonly number[]): Dist => ({ n: values.length, median: median(values), p90: quantile(values, 0.9), max: Math.max(...values), mean: mean(values) });
const distText = (d: Dist, digits = 0) => (d.n === 0 ? 'n/a' : `${num(d.median, digits)} / ${num(d.p90, digits)} / ${num(d.max, digits)} (mean ${num(d.mean, 1)}, n ${d.n})`);

interface FightStats {
  corpus: Corpus; turnRuns: Run[]; completed: Run[]; limits: Run[]; errors: Run[]; leaves: Dist; outcomes: Dist; w: Dist; p2: Dist;
  forced: Run[]; leafMeanWithLimits: number; theta1: number; theta1Best: number; theta12: number; root: string;
}

function fightStats(corpus: Corpus, timings: Timing[], factor: number): FightStats {
  const turnRuns = corpus.runs.filter((run) => run.phase === 'turnChoice');
  const completed = turnRuns.filter((run) => run.outcomes !== null);
  const limits = corpus.runs.filter((run) => run.limit);
  const errors = corpus.runs.filter((run) => run.error !== null);
  const turnVisits = corpus.visits.filter((entry) => entry.phase === 'turnChoice');
  const rates = timings.map((timing) => timing.byFight[corpus.fight.id]).filter((entry) => entry !== undefined && entry.seconds > 0)
    .map((entry) => entry!.leaves / entry!.seconds);
  const theta1 = rates.length > 0 ? median(rates) : corpus.leaves / (corpus.ms / 1000);
  const root = turnVisits.find((entry) => entry.depth === 0);
  return {
    root: root === undefined ? 'none' : `${root.expanded} of ${root.pairs}`,
    corpus, turnRuns, completed, limits, errors, leaves: dist(completed.map((run) => run.leaves)), outcomes: dist(completed.map((run) => run.outcomes!)),
    w: dist(turnVisits.map((entry) => entry.w)), p2: dist(turnVisits.map((entry) => entry.p2)),
    forced: corpus.runs.filter((run) => run.phase !== 'turnChoice'),
    leafMeanWithLimits: mean(turnRuns.filter((run) => run.error === null).map((run) => run.leaves)),
    theta1, theta1Best: rates.length > 0 ? Math.max(...rates) : theta1, theta12: theta1 * factor,
  };
}

/** Design-time estimates: AI support s, and the typical N and w tried. */
const RESEARCH = { '3v3': { s: 1.5, n: 1e3, wTried: 2 }, '6v6': { s: 2, n: 1e5, wTried: 3 } } as const;

interface Projection { b: number; nodes: number; calls: number; leaves: number; seconds: number }

/**
 * The depth-limited AND-OR tree: b = w·s·o children per state; with a transposition hit rate h, each level keeps
 * (1 − h) of its new states, so states(k) = (b·(1 − h))^k. Each expanded state costs w·s expandTurn calls of L leaves.
 * nodes = (b·(1 − h))^d, calls = w·s·Σ_{k<d} (b·(1 − h))^k, leaves = calls·L, seconds = leaves / θ.
 */
function project(w: number, s: number, o: number, l: number, d: number, hit: number, theta: number): Projection {
  const b = w * s * o;
  const kept = b * (1 - hit);
  let calls = 0;
  for (let k = 0; k < d; k++) calls += w * s * kept ** k;
  return { b, nodes: kept ** d, calls, leaves: calls * l, seconds: (calls * l) / theta };
}

// ---------------------------------------------------------------------------------------------------------------------
// Main.

async function main(): Promise<void> {
  ownBusy(1);
  const args = cliArgs();
  machineCpuOff = !args.machineCpu;
  const mode: Mode = args.data === 'auto' ? (realDataPresent(args.save) ? 'real' : 'fixture') : args.data;
  if (mode === 'real' && !realDataPresent(args.save)) fail(`Real data missing: need data/rom/romdata.json, data/docs (npm run extract) and the save ${args.save}`);
  const started = new Date();
  const git = (() => {
    try {
      return execSync('git describe --always --dirty', { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  })();
  const log = (line: string) => console.log(line);
  log(`bench:engine ${mode} data · nproc ${nproc} · load ${fmtLoad(loadNow())} · ${cpus()[0]?.model ?? 'cpu'} · node ${process.version} · git ${git}`);
  const setupStart = performance.now();
  const fights = mode === 'real' ? realFights(args) : fixtureFights(args);
  log(`engine ${engineId()} · ${fights.length} fights set up in ${((performance.now() - setupStart) / 1000).toFixed(1)} s`);
  for (const fight of fights) log(`  ${fight.id}: ${fight.title}; the player ${fight.player}${fight.synthetic ? ` [${fight.synthetic}]` : ''}`);

  // Warm-up: the JIT's first leaves run several times slower (seen at ~9 ms against ~3 ms).
  {
    const first = fights[0]!;
    const p1 = engine.legalChoices(first.state, 'p1');
    const p2 = engine.legalChoices(first.state, 'p2');
    const warmStart = performance.now();
    for (let k = 0; k < Math.min(6, p1.length * p2.length) && performance.now() - warmStart < 5000; k++) {
      expandCounted(first.state, { p1: p1[k % p1.length]!, p2: p2[Math.floor(k / p1.length) % p2.length]! }, args.maxLeaves);
    }
  }

  // 1. Corpus.
  const corpora: Corpus[] = [];
  const conditionText = (c: Conditions) => `load ${fmtLoad(c.loadBefore)} → ${fmtLoad(c.loadAfter)} (own ≈ ${fmtOwn(c)}); machine CPU before ${fmtCpu(c.cpuBefore)}`;
  for (const fight of fights) {
    log(`corpus ${fight.id}: load ${fmtLoad(loadNow())}`);
    const corpus = buildCorpus(fight, args);
    corpora.push(corpus);
    const limits = corpus.runs.filter((run) => run.limit).length;
    log(`  ${corpus.runs.length} expansions, ${int(corpus.leaves)} leaves in ${(corpus.ms / 1000).toFixed(1)} s = ${num(corpus.leaves / (corpus.ms / 1000))} leaves/s, ${limits} LIMIT; ${conditionText(corpus.conditions)}`);
  }

  // 2. LIMIT probes.
  const probes: Probe[] = [];
  const limitRuns = corpora.flatMap((corpus) => corpus.runs.filter((run) => run.limit));
  for (const run of limitRuns.slice(0, args.probes)) {
    log(`probe ${run.fight} ${run.pair} with maxLeaves ${int(args.probeLeaves)}`);
    const startConditions = conditionsStart();
    const start = performance.now();
    const result = expandCounted(run.state, run.choices, args.probeLeaves);
    const seconds = (performance.now() - start) / 1000;
    const conditions = conditionsEnd(startConditions);
    probes.push({ run, leaves: result.limit ? null : result.leaves, outcomes: result.outcomes?.length ?? null, seconds, conditions });
    log(`  ${result.limit ? `still LIMIT (> ${int(args.probeLeaves)})` : `${int(result.leaves)} leaves, ${int(result.outcomes!.length)} outcomes`} in ${seconds.toFixed(1)} s; ${conditionText(conditions)}`);
  }

  // 3. Timing runs, 4. the leaf profile.
  const sample = pickSample(corpora, args.sampleLeaves, args.seed);
  log(`timing sample: ${sample.length} expansions, ${int(sum(sample.map((task) => task.leaves)))} leaves`);
  const timings: Timing[] = [];
  for (let run = 1; run <= args.runs; run++) {
    const timing = timeTasks(`run ${run}`, sample, args.maxLeaves);
    timings.push(timing);
    log(`  run ${run}: ${int(timing.leaves)} leaves in ${timing.seconds.toFixed(1)} s = ${num(timing.leaves / timing.seconds)} leaves/s; ${conditionText(timing.conditions)}`);
  }
  const profile = profileTasks(sample, args.maxLeaves);
  log(`  profile: ${int(profile.leaves)} leaves in ${profile.seconds.toFixed(1)} s = ${num(profile.leaves / profile.seconds)} leaves/s; ${conditionText(profile.conditions)}`);

  // 5. Scaling: each worker runs up to `scaleLeaves` leaves of the sample, the fights interleaved.
  const interleaved: Task[] = [];
  {
    const byFight = fights.map((fight) => sample.filter((task) => task.fight === fight.id));
    let total = 0;
    for (let k = 0; total < args.scaleLeaves && byFight.some((tasks) => k < tasks.length); k++) {
      for (const tasks of byFight) {
        const task = tasks[k];
        if (task !== undefined && total < args.scaleLeaves) {
          interleaved.push(task);
          total += task.leaves;
        }
      }
    }
  }
  const scaling: Scaling[] = [];
  for (const threads of args.threads) {
    ownBusy(0);
    await sleep(args.cooldown * 1000);
    log(`scaling ${threads} thread(s): ${interleaved.length} expansions (${int(sum(interleaved.map((task) => task.leaves)))} leaves) each`);
    const result = await scalingRun(threads, mode, interleaved, args.maxLeaves);
    scaling.push(result);
    log(`  idle before: load ${fmtLoad(result.idle.loadBefore)} (own ≈ ${result.idle.ownBefore.toFixed(1)}), machine CPU ${fmtCpu(result.idle.cpuBefore)}`);
    log(`  ${int(result.leaves)} leaves in ${result.seconds.toFixed(1)} s = ${num(result.leaves / result.seconds)} leaves/s total; load ${fmtLoad(result.conditions.loadBefore)} → ${fmtLoad(result.conditions.loadAfter)} (own ≈ ${fmtOwn(result.conditions)})`);
  }
  ownBusy(1);
  const one = scaling.find((entry) => entry.threads === 1)!;
  const top = scaling[0]!;
  const rate = (entry: Timing) => entry.leaves / entry.seconds;
  const factor = rate(top) / rate(one);
  const contamination = judgeContamination(top);

  const stats = corpora.map((corpus) => fightStats(corpus, timings, factor));
  const report = buildReport({ args, mode, started, git, fights, stats, probes, timings, profile, sample, interleaved, scaling, factor, contamination });
  log('');
  log(report.table);
  if (args.doc !== null) {
    writeFileSync(args.doc, report.doc);
    log(`\nWrote ${args.doc}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The report: the printed table and docs/engine-throughput.md.

interface Probe { run: Run; leaves: number | null; outcomes: number | null; seconds: number; conditions: Conditions }
type Scaling = Timing & { perWorker: number[]; idle: Conditions };

/**
 * Whether other work on the machine skewed the top scaling run. The rule: a 1-minute load above about 4
 * when the run starts. The bench also estimates other work two more ways, since the load average sees only the WSL VM:
 * the load minus the bench's own share (before and after the run), and Windows' whole-machine CPU use while the bench
 * is idle just before it. Contaminated: the raw load before, or either estimate, above 4. Borderline: an estimate above
 * 2 (with N of our threads on nproc hardware threads, every other busy thread takes a share).
 */
interface Contamination { level: 'clean' | 'borderline' | 'contaminated'; raw: number; othersBefore: number; othersAfter: number; machine: number | null; text: string }

function judgeContamination(top: Scaling): Contamination {
  const raw = top.idle.loadBefore[0];
  const othersBefore = raw - top.idle.ownBefore;
  const othersAfter = top.conditions.loadAfter[0] - top.conditions.ownAfter;
  const machine = top.idle.cpuBefore === null ? null : (top.idle.cpuBefore * nproc) / 100;
  const estimates = [othersBefore, othersAfter, ...(machine === null ? [] : [machine])];
  const level = raw > 4 || estimates.some((value) => value > 4) ? 'contaminated' : estimates.some((value) => value > 2) ? 'borderline' : 'clean';
  const text = `1-minute load ${raw.toFixed(2)} before the ${top.threads}-thread run (the bench's own share ≈ ${top.idle.ownBefore.toFixed(1)}, so other WSL work ≈ ${othersBefore.toFixed(1)}); `
    + `after it ${top.conditions.loadAfter[0].toFixed(2)} with the bench's own ≈ ${top.conditions.ownAfter.toFixed(1)}, so other WSL work ≈ ${othersAfter.toFixed(1)}; `
    + `whole-machine CPU just before it ${fmtCpu(top.idle.cpuBefore)}`;
  return { level, raw, othersBefore, othersAfter, machine, text };
}

interface ReportInput {
  args: Args; mode: Mode; started: Date; git: string; fights: Fight[]; stats: FightStats[]; probes: Probe[];
  timings: Timing[]; profile: Profile; sample: Task[]; interleaved: Task[]; scaling: Scaling[]; factor: number; contamination: Contamination;
}

const PHASE_TEXT: Record<LeafPhase, string> = {
  restore: '`restore` (Showdown `Battle.fromJSON` + driver)', step: 'the step (`applyChoices`: Showdown runs the turn)',
  snapshot: 'snapshot (`toJSON` + `JSON.stringify` + reveals)', key: '`stateKey` (canonical JSON + SHA-256)',
  leaf: 'the leaf (replay check, probability, log, observation)', merge: 'merge + next script',
  facts: 'the kept leaf\'s readers (carry, HP, legal choices)',
};

function buildReport(input: ReportInput): { table: string; doc: string } {
  const { args, stats, timings, profile, scaling, factor, contamination } = input;
  const rate = (entry: { leaves: number; seconds: number }) => entry.leaves / entry.seconds;
  const totals = timings.map(rate);
  const best = Math.max(...totals);
  const med = median(totals);
  const one = scaling.find((entry) => entry.threads === 1)!;
  const top = scaling[0]!;
  const dirty = contamination.level !== 'clean';
  const flagWord = contamination.level === 'contaminated' ? 'CONTAMINATED' : 'BORDERLINE';
  const lines: string[] = [];
  const out = (line = '') => lines.push(line);
  const shares = LEAF_PHASES.map((phase) => [phase, profile.phases[phase] / profile.seconds] as const);
  const cond = (c: Conditions) => `${fmtLoad(c.loadBefore)} → ${fmtLoad(c.loadAfter)}`;

  // Projections: per fight, typical (medians) and mean, estimated s and legal p2 s, no TT and 50%.
  const projections = stats.map((entry) => {
    const research = RESEARCH[entry.corpus.fight.cls];
    const w = entry.w.median;
    const o = entry.outcomes.median;
    const l = entry.leaves.median;
    const oMean = entry.outcomes.mean;
    const lMean = entry.leafMeanWithLimits;
    const theta = entry.theta12;
    const rows = [3, 5, 8].flatMap((d) => [research.s, entry.p2.median].flatMap((s) => [0, 0.5].map((hit) => ({ d, s, hit, p: project(w, s, o, l, d, hit, theta) }))));
    const at = (d: number, means = false) => (means ? project(w, research.s, oMean, lMean, d, 0.5, theta) : project(w, research.s, o, l, d, 0.5, theta));
    let longest = 0;
    let longestMeans = 0;
    for (let d = 1; d <= 12; d++) {
      if (at(d).seconds <= args.budget) longest = d;
      if (at(d, true).seconds <= args.budget) longestMeans = d;
    }
    const researchModel = [l, lMean].map((leaves) => {
      const t = research.n * research.wTried * research.s * leaves;
      return { l: leaves, t, seconds: t / theta };
    });
    return { entry, research, w, o, l, oMean, lMean, rows, at, longest, longestMeans, researchModel };
  });
  type Projected = (typeof projections)[number];
  const typical = (entry: Projected, d: number) => entry.rows.find((row) => row.d === d && row.s === entry.research.s && row.hit === 0.5)!;
  const p3 = projections.filter((entry) => entry.entry.corpus.fight.cls === '3v3');
  const p6 = projections.filter((entry) => entry.entry.corpus.fight.cls === '6v6');
  const under3 = p3.length > 0 && p3.every((entry) => entry.at(args.typical3).seconds <= args.budget);
  const over6 = p6.some((entry) => entry.at(args.typical6).seconds > args.budget);
  const name = (entry: Projected) => `${entry.entry.corpus.fight.id} (${entry.entry.corpus.fight.title})`;
  const turns = (n: number) => (n === 0 ? 'not even 1 turn' : `${n} turn${n === 1 ? '' : 's'}`);

  const decision: string[] = [];
  for (const entry of p3) {
    decision.push(`- **3v3**, ${name(entry)}, at ${args.typical3} turns: **${duration(entry.at(args.typical3).seconds)}** on the medians (typical), ${duration(entry.at(args.typical3, true).seconds)} on the means (a tail indicator), against the ${duration(args.budget)} budget: **${entry.at(args.typical3).seconds <= args.budget ? 'under' : 'over'}**. The longest 3v3 that projects under it: ${turns(entry.longest)} (medians), ${turns(entry.longestMeans)} (means).`);
  }
  for (const entry of p6) {
    decision.push(`- **6v6**, ${name(entry)}${entry.entry.corpus.fight.synthetic ? ' (synthetic)' : ''}, at ${args.typical6} turns: **${duration(entry.at(args.typical6).seconds)}** on the medians, ${duration(entry.at(args.typical6, true).seconds)} on the means: **${entry.at(args.typical6).seconds > args.budget ? 'over' : 'under'}**. Longest under the budget: ${turns(entry.longest)} (medians), ${turns(entry.longestMeans)} (means).`);
  }
  for (const entry of p3) {
    const [onMedian, onMean] = entry.researchModel;
    const tree = entry.at(args.typical3).seconds;
    const agree = (onMedian!.seconds <= args.budget) === (tree <= args.budget);
    decision.push(`- **The estimated N-based model ${agree ? 'agrees' : 'disagrees'}** for ${name(entry)}: T = N·w·s·L puts it at about ${duration(onMedian!.seconds)} on the median L (${onMedian!.seconds <= args.budget ? 'under' : 'over'} the budget) and ${duration(onMean!.seconds)} on the mean L, against the tree model's ${duration(tree)} at ${args.typical3} turns${agree ? '' : ', so the two models disagree on the 3v3 condition'}. The rule is applied on the tree model; the solver's measured N will show which is nearer.`);
  }
  const shortest3 = p3.length === 0 ? 0 : Math.min(...p3.map((entry) => entry.longest));
  let verdict: string;
  if (p3.length === 0 || p6.length === 0) {
    verdict = 'Not decided: the run lacks a 3v3 or a 6v6 fight.';
  } else if (under3 && over6) {
    verdict = 'The rule\'s case "3v3 under, 6v6 over" applies: **the AI and the solver go ahead on Showdown**; 6v6 fights over the budget report "not proven within the time limit"; **a native-core plan (Rust hot path, tested turn by turn against this engine) is queued after the solver.**';
  } else if (under3) {
    verdict = '**The AI and the solver go ahead on Showdown**; on these numbers no native-core plan is needed.';
  } else {
    verdict = `**The rule's first condition fails**: a typical 3v3 (${args.typical3} turns) does not project under the budget. The rule as written does not cover this case. `
      + 'Its second clause\'s reason still holds (the solver reaches the engine only through `expandTurn`, `legalChoices` and `key`, so an engine swap does not touch the solver), so the bench\'s reading is: '
      + `**the solver goes ahead on Showdown; fights over the budget (6v6s, and 3v3s longer than about ${turns(shortest3)} on the medians) report "not proven within the time limit"; the native-core plan is queued after the solver**, and it is needed for 3v3s too, not only 6v6. This reading should be confirmed.`;
  }
  if (dirty) verdict += ` **Provisional:** the ${top.threads}-thread figure every projected time divides by is ${contamination.level} (${contamination.text}).`;

  // ---- The printed table.
  out('== Engine throughput (scripts/benchEngine.ts) ==');
  out(`nproc ${nproc}; ${input.mode} data; engine ${engineId()}; git ${input.git}`);
  out('');
  out('measurement                        thr   leaves  seconds  leaves/s   load before → after (1/5/15)          own load    machine CPU before   nproc');
  const row = (label: string, threads: number, leaves: number, seconds: number, c: Conditions) =>
    out(`${label.padEnd(34)}${String(threads).padStart(5)}${int(leaves).padStart(9)}${seconds.toFixed(1).padStart(9)}${num(leaves / seconds).padStart(10)}   ${cond(c).padEnd(38)}${fmtOwn(c).padEnd(12)}${fmtCpu(c.cpuBefore).padEnd(21)}${nproc}`);
  for (const entry of stats) row(`corpus ${entry.corpus.fight.id}`, 1, entry.corpus.leaves, entry.corpus.ms / 1000, entry.corpus.conditions);
  for (const probe of input.probes) row(`LIMIT probe ${probe.run.fight}`, 1, probe.leaves ?? args.probeLeaves, probe.seconds, probe.conditions);
  for (const timing of timings) row(`sample ${timing.label}`, 1, timing.leaves, timing.seconds, timing.conditions);
  row('sample, leaf profile on', 1, profile.leaves, profile.seconds, profile.conditions);
  for (const entry of scaling) row(`scaling ${entry.label}${entry === top && dirty ? ` (${flagWord})` : ''}`, entry.threads, entry.leaves, entry.seconds, { ...entry.conditions, cpuBefore: entry.idle.cpuBefore });
  out('');
  out(`single thread (sample, ${timings.length} runs): best ${num(best)} leaves/s, median ${num(med)} leaves/s`);
  out(`per fight (median of runs): ${stats.map((entry) => `${entry.corpus.fight.id} ${num(entry.theta1)}`).join(', ')}`);
  out(`${top.threads} threads: ${num(rate(top))} leaves/s total = ${factor.toFixed(2)} × the 1-thread worker run (${num(rate(one))})${dirty ? `  ** ${flagWord} **` : ''}`);
  out(`  ${contamination.text}`);
  out(`leaf shares: ${shares.map(([phase, share]) => `${phase} ${(share * 100).toFixed(1)}%`).join(', ')}, outside ${((profile.outside / profile.seconds) * 100).toFixed(1)}%`);
  for (const entry of stats) {
    out(`${entry.corpus.fight.id}: root pairs ${entry.root}; w ${num(entry.w.median, 0)}, legal p2 ${num(entry.p2.median, 0)}; leaves/expandTurn ${distText(entry.leaves)}; outcomes ${distText(entry.outcomes)}; LIMIT ${entry.limits.length}${entry.errors.length > 0 ? `; errors ${entry.errors.length}` : ''}`);
  }
  out('');
  for (const entry of projections) {
    out(`projection ${entry.entry.corpus.fight.id} (s ${entry.research.s}, 50% TT, 12 threads, medians): 3 turns ${duration(typical(entry, 3).p.seconds)}, 5 turns ${duration(typical(entry, 5).p.seconds)}, 8 turns ${duration(typical(entry, 8).p.seconds)}; longest under ${duration(args.budget)}: ${turns(entry.longest)} (means: ${turns(entry.longestMeans)})`);
  }
  out('');
  out(`decision: ${verdict.replace(/\*\*/g, '')}`);
  const table = lines.join('\n');

  // ---- The doc.
  const doc: string[] = [];
  const d = (line = '') => doc.push(line);
  const docRow = (label: string, threads: number, leaves: number, seconds: number, c: Conditions) =>
    d(`| ${label} | ${threads} | ${int(leaves)} | ${seconds.toFixed(1)} | ${num(leaves / seconds)} | ${fmtLoad(c.loadBefore)} | ${fmtLoad(c.loadAfter)} | ${fmtOwn(c)} | ${fmtCpu(c.cpuBefore)} | ${nproc} |`);
  const tableHead = () => {
    d('| Measurement | Threads | Leaves | Seconds | Leaves/s | Load before (1/5/15 min) | Load after | Bench\'s own 1-min load (before → after) | Machine CPU before | nproc |');
    d('|---|---|---|---|---|---|---|---|---|---|');
  };
  d('# Engine throughput and the native-core decision');
  d();
  d(`Generated by \`npm run bench:engine${args.argv.length > 0 ? ` -- ${args.argv.join(' ')}` : ''}\` (scripts/benchEngine.ts), started ${input.started.toISOString()}. Rerun it to refresh every number here.`);
  d();
  d('## Conditions');
  d();
  d(`- Machine: ${cpus()[0]?.model ?? 'unknown CPU'}, **nproc ${nproc}**, ${process.platform}; Node ${process.version}.`);
  d(`- Engine: \`${engineId()}\`; git \`${input.git}\` (\`-dirty\` means this task's own changes were not yet committed when it ran).`);
  d(`- Data: ${input.mode === 'real' ? `The player's (data/ extracted from the ROM; save ${args.save})` : 'the fixture fights (no real data found)'}. Field conditions are not applied yet, so every fight starts on a plain field.`);
  // Other work before each measurement: the single-thread ones and the top scaling run's idle sample (the lower
  // thread counts' idle samples still carry the bench's own previous run, V8's helper threads included).
  const before = [...stats.map((entry) => entry.corpus.conditions), ...input.probes.map((probe) => probe.conditions), ...timings.map((timing) => timing.conditions), profile.conditions, top.idle];
  const otherWsl = Math.max(...before.map((c) => c.loadBefore[0] - c.ownBefore));
  const machineSamples = before.map((c) => c.cpuBefore).filter((cpu): cpu is number => cpu !== null);
  const machineMax = machineSamples.length > 0 ? Math.max(...machineSamples) : null;
  const busy = dirty || otherWsl > 2 || (machineMax !== null && (machineMax * nproc) / 100 > 2);
  const machineText = machineMax === null ? 'the whole machine\'s CPU was not sampled' : `the whole machine's CPU ${busy ? 'reached' : 'stayed at or under'} ${fmtCpu(machineMax)}`;
  d(busy
    ? `- **Other work was running on this PC during the run**: before the measurements, other WSL work reached about ${otherWsl.toFixed(1)} (the 1-minute load minus the bench's own) and ${machineText}. Beside every measurement:`
    : `- **The machine looked quiet during the run**: before the measurements, other WSL work stayed at or under ${otherWsl.toFixed(1)} (the 1-minute load minus the bench's own) and ${machineText}. Beside every measurement:`);
  d('  - the load average (1, 5 and 15 minutes; `os.loadavg()`, what `uptime` prints) before and after;');
  d('  - the bench\'s own share of the 1-minute load, estimated by averaging its own busy threads the way Linux does (60 s time constant), so load minus own ≈ other WSL work;');
  d('  - the whole machine\'s CPU use from Windows (`typeperf`, a 1 s sample taken while the bench waits), because the load average sees only the WSL VM: Windows-side work by other sessions never shows in it;');
  d('  - nproc.');
  d(`- Options: fight-leaves ${int(args.fightLeaves)}, chains ${args.chains}, depth ${args.depth}, pairs ${args.pairs}, max-leaves ${int(args.maxLeaves)}, probes ${args.probes} at ${int(args.probeLeaves)}, sample-leaves ${int(args.sampleLeaves)}, runs ${args.runs}, threads ${args.threads.join(',')}, scale-leaves ${int(args.scaleLeaves)}, cooldown ${args.cooldown} s, seed ${args.seed}.`);
  d();
  d('## Summary');
  d();
  d(`- **Single thread:** best **${num(best)}**, median **${num(med)} leaves/s** over ${timings.length} runs of one sample (1-minute load at their starts: ${timings.map((timing) => timing.conditions.loadBefore[0].toFixed(2)).join(', ')}; nproc ${nproc}). Per fight (median of the runs): ${stats.map((entry) => `${entry.corpus.fight.id} ${num(entry.theta1)}`).join(', ')}.`);
  d(`- **${top.threads} threads:** **${num(rate(top))} leaves/s** total, ${factor.toFixed(2)}× the 1-thread worker run.${dirty ? ` **${flagWord}:**` : ' Not flagged:'} ${contamination.text}.`);
  d(`- **Against the earlier estimates:** Showdown enumerated was put at 300–2,200 leaves/s per thread and 1,800–19,800 in aggregate. Measured: ${num(best)} best per thread, at the bottom of that range, and ${num(rate(top))} on ${top.threads} threads${rate(top) < 1800 ? ', below the aggregate range' : ''}. The range's top was the naive loop's ~2,200 turns/s (0.45 ms a turn); here the turn itself takes ${((profile.phases.step * 1000) / profile.leaves).toFixed(2)} ms with the mod's overrides, and restore, snapshot and key add ${((profile.phases.restore + profile.phases.snapshot + profile.phases.key) / profile.phases.step).toFixed(1)} turns' worth (the range's bottom assumed about 6).`);
  d(`- **Per leaf:** ${shares.map(([phase, share]) => `${phase} ${(share * 100).toFixed(0)}%`).join(', ')}${profile.phases.step / profile.seconds < 1 / 3 ? ': Showdown\'s own turn is under a third of a leaf' : ''}.`);
  d(`- **Decision:** ${verdict}`);
  d();
  d('## Fights');
  d();
  d('| Fight | Class | Trainer and party | the player\'s side | Note |');
  d('|---|---|---|---|---|');
  for (const fight of input.fights) d(`| ${fight.id} | ${fight.cls} | ${fight.trainer} | ${fight.player} | ${fight.synthetic ?? (fight.id === 'late' ? 'lopsided: the player\'s team is about 70 levels under, so most enemy hits KO whatever the roll' : 'real')} |`);
  d();
  if (input.mode === 'real') {
    d('No gym leader in this hack has 3 Pokémon (Roark already has 6), so the 3v3 is an early 3-Pokémon route trainer from Roark\'s split, the "early 3v3 route trainer" class. The player\'s 3v3 side is his first three party Pokémon; his 6v6 side is his party. `late` is the late 6v6, but against the player\'s current team it is lopsided, so `late-matched` reruns it with his six raised to Volkner\'s level: synthetic, labelled everywhere, and the only level-matched late 6v6 his save allows.');
    d();
  }
  d('The corpus: every legal (p1, p2) choice pair at each root (in a seeded random order, until 60% of the fight\'s leaf budget), then chains of successor states. A chain starts at one of the most probable outcomes (no player faint) of the root\'s move-against-move pairs and follows the most probable such outcome turn by turn, up to `depth` turn levels, expanding up to `pairs` pairs at each state, half of them move against move. A successor waiting on a replacement or a U-turn switch has each of its choices expanded too.');
  d();
  d('## Single-thread throughput');
  d();
  d('`expandTurn` leaves per second. "Corpus" is the first pass over all of a fight\'s expansions (after a JIT warm-up); the "sample" runs repeat one fixed sample of corpus expansions.');
  d();
  tableHead();
  for (const entry of stats) docRow(`corpus ${entry.corpus.fight.id}`, 1, entry.corpus.leaves, entry.corpus.ms / 1000, entry.corpus.conditions);
  for (const probe of input.probes) docRow(`LIMIT probe ${probe.run.fight} (maxLeaves ${int(args.probeLeaves)})`, 1, probe.leaves ?? args.probeLeaves, probe.seconds, probe.conditions);
  for (const timing of timings) docRow(`sample ${timing.label}`, 1, timing.leaves, timing.seconds, timing.conditions);
  docRow('sample, leaf profile on', 1, profile.leaves, profile.seconds, profile.conditions);
  d();
  d(`**Best ${num(best)}, median ${num(med)} leaves/s** (the sample: ${input.sample.length} expansions, ${int(sum(input.sample.map((task) => task.leaves)))} leaves, about ${int(args.sampleLeaves / input.fights.length)} per fight, none larger than that share). Per fight:`);
  d();
  d('| Fight | ' + timings.map((timing) => timing.label).join(' | ') + ' | Median | Best |');
  d('|---|' + timings.map(() => '---|').join('') + '---|---|');
  for (const entry of stats) {
    const rates = timings.map((timing) => timing.byFight[entry.corpus.fight.id]).map((value) => (value === undefined ? NaN : rate(value)));
    d(`| ${entry.corpus.fight.id} | ${rates.map((value) => num(value)).join(' | ')} | ${num(entry.theta1)} | ${num(entry.theta1Best)} |`);
  }
  d();
  d('## Cost of a leaf');
  d();
  d(`From the profile run (the engine's opt-in timing in src/engine/profile.ts, off by default; it reads the clock about seven times per leaf, and this run went at ${num(profile.leaves / profile.seconds)} leaves/s against the median ${num(med)} without it, within the load's noise):`);
  d();
  d('| Phase | Seconds | Share of the run | ms per leaf |');
  d('|---|---|---|---|');
  for (const [phase, share] of shares) d(`| ${PHASE_TEXT[phase]} | ${profile.phases[phase].toFixed(2)} | ${(share * 100).toFixed(1)}% | ${((profile.phases[phase] * 1000) / profile.leaves).toFixed(3)} |`);
  d(`| outside the leaves (outcome list, sum check) | ${profile.outside.toFixed(2)} | ${((profile.outside / profile.seconds) * 100).toFixed(1)}% | ${((profile.outside * 1000) / profile.leaves).toFixed(3)} |`);
  d(`| **total** | ${profile.seconds.toFixed(2)} | 100% | ${((profile.seconds * 1000) / profile.leaves).toFixed(3)} |`);
  d();
  d('## Outcomes and leaves per turn');
  d();
  d('Turn-choice expansions that finished (median / p90 / max). w is the player\'s legal choices at each expanded turn-choice state, p2 the trainer\'s (moves, switches and bag items).');
  d();
  d('| Fight | Root pairs expanded | Expansions | Leaves per expandTurn | Outcomes per expandTurn (after merging) | w (player) | Legal p2 | LIMIT | Errors |');
  d('|---|---|---|---|---|---|---|---|---|');
  for (const entry of stats) {
    d(`| ${entry.corpus.fight.id} | ${entry.root} | ${entry.turnRuns.length} (+${entry.forced.length} switch steps) | ${distText(entry.leaves)} | ${distText(entry.outcomes)} | ${distText(entry.w)} | ${distText(entry.p2)} | ${entry.limits.length} | ${entry.errors.length} |`);
  }
  d();
  d('By depth (the chain\'s turn level; 0 is the root):');
  d();
  d('| Fight | Depth | Expansions | Leaves median / max | Outcomes median / max |');
  d('|---|---|---|---|---|');
  for (const entry of stats) {
    for (const depth of [...new Set(entry.completed.map((run) => run.depth))].sort((a, b) => a - b)) {
      const runs = entry.completed.filter((run) => run.depth === depth);
      d(`| ${entry.corpus.fight.id} | ${depth} | ${runs.length} | ${num(median(runs.map((run) => run.leaves)), 0)} / ${int(Math.max(...runs.map((run) => run.leaves)))} | ${num(median(runs.map((run) => run.outcomes!)), 0)} / ${int(Math.max(...runs.map((run) => run.outcomes!)))} |`);
    }
  }
  d();
  d('The largest finished expansions, and the chances on their outcomes\' paths (kind:source, ×n the most times on one outcome):');
  d();
  d('| Fight | Pair | Leaves | Outcomes | ms | Chances |');
  d('|---|---|---|---|---|---|');
  const largest = stats.flatMap((entry) => entry.completed).sort((a, b) => b.leaves - a.leaves).slice(0, 12);
  for (const run of largest) d(`| ${run.fight} | ${run.pair} | ${int(run.leaves)} | ${int(run.outcomes!)} | ${int(run.ms)} | ${run.chances} |`);
  d();
  d('## LIMITs');
  d();
  const limits = stats.flatMap((entry) => entry.limits);
  if (limits.length === 0) {
    d(`No expansion hit LIMIT (maxLeaves ${int(args.maxLeaves)}) in this corpus. The largest ones above show what comes closest.`);
  } else {
    d(`${limits.length} expansion(s) hit LIMIT (more than ${int(args.maxLeaves)} leaves); each still ran ${int(args.maxLeaves)} leaves, which the throughput counts. The pairs, and the chances on their first path (every chance taking its first option):`);
    d();
    d('| Fight | Depth | Pair | Multi-hit moves | Seconds to LIMIT | First path |');
    d('|---|---|---|---|---|---|');
    for (const run of limits) d(`| ${run.fight} | ${run.depth} | ${run.pair} | ${run.multiHit.join(', ') || 'none'} | ${(run.ms / 1000).toFixed(1)} | ${run.path} |`);
  }
  d();
  if (input.probes.length > 0) {
    d(`Re-run with maxLeaves ${int(args.probeLeaves)}:`);
    d();
    for (const probe of input.probes) d(`- ${probe.run.fight}, ${probe.run.pair}: ${probe.leaves === null ? `still over ${int(args.probeLeaves)} leaves` : `${int(probe.leaves)} leaves, ${int(probe.outcomes!)} outcomes`} (${probe.seconds.toFixed(1)} s; load ${cond(probe.conditions)}).`);
    d();
  }
  const errors = stats.flatMap((entry) => entry.errors);
  if (errors.length > 0) {
    d('Expansions that threw something other than LIMIT (skipped, not timed):');
    d();
    for (const run of errors.slice(0, 20)) d(`- ${run.fight}, ${run.pair}: ${run.error}`);
    d();
  }
  d('## Scaling with worker threads');
  d();
  d(`Each worker installs the data itself and warms up; then all start together on the same ${input.interleaved.length} expansions (${int(sum(input.interleaved.map((task) => task.leaves)))} leaves, the fights interleaved). Total leaves/s = all workers' leaves / wall time. Thread counts run from the most down, each after a ${args.cooldown} s idle cool-down; the "idle" columns are taken then, before any worker starts, and the load columns once every worker is ready and when the last one is done.`);
  d();
  d('| Threads | Leaves | Seconds | Total leaves/s | × 1 thread | Per worker (min–max) | Idle: 1-min load (own) | Idle: machine CPU | Load at start → end (1/5/15) | Bench\'s own load (start → end) | nproc |');
  d('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const entry of scaling) {
    d(`| ${entry.threads}${entry === top && dirty ? ` **(${contamination.level})**` : ''} | ${int(entry.leaves)} | ${entry.seconds.toFixed(1)} | ${num(rate(entry))} | ${(rate(entry) / rate(one)).toFixed(2)} | ${num(Math.min(...entry.perWorker))}–${num(Math.max(...entry.perWorker))} | ${entry.idle.loadBefore[0].toFixed(2)} (${entry.idle.ownBefore.toFixed(1)}) | ${fmtCpu(entry.idle.cpuBefore)} | ${cond(entry.conditions)} | ${fmtOwn(entry.conditions)} | ${nproc} |`);
  }
  d();
  d(`The ${top.threads}-thread run is **${contamination.level}**: ${contamination.text}. The rule: the raw 1-minute load before it, or other work estimated either way, above 4 is contaminated; an estimate above 2 is borderline, because with ${top.threads} of the bench's threads on ${nproc} hardware threads every other busy thread takes a share. ${dirty ? 'The projections below divide by this figure, so they are **provisional** until the bench is rerun on a quiet machine.' : 'The projections below divide by this figure.'} The lower thread counts' idle loads include the decaying load of the bench's own previous run (the "own" figure). The own estimate counts one thread per busy worker, not V8's own GC and compiler threads, so "other WSL work" after a run can read high.`);
  d();
  d(`θ₁₂ per fight = its single-thread median × ${factor.toFixed(4)} (the ${top.threads}-thread total over the 1-thread worker run): ${stats.map((entry) => `${entry.corpus.fight.id} ${exact(entry.theta1)} × ${factor.toFixed(4)} = ${exact(entry.theta12)}`).join('; ')} leaves/s. For scale, 6 × the best single-thread run (a guess at a quiet 6-core machine) is ${num(best * 6)} leaves/s.`);
  d();
  d('## Projection');
  d();
  d('The depth-limited AND-OR tree: each turn-choice state has b = w × s × o children (player choices × AI choices × outcomes). With a transposition hit rate h, each level keeps (1 − h) of its new states. Then:');
  d();
  d('- nodes at depth d = (b·(1 − h))^d;');
  d('- `expandTurn` calls = w·s·Σ_{k=0}^{d−1} (b·(1 − h))^k (each expanded state costs w·s calls);');
  d('- leaves = calls × L, with L the leaves per `expandTurn`;');
  d('- time on 12 threads = leaves / θ₁₂.');
  d();
  const tail = [...stats].sort((a, b) => b.outcomes.mean / b.outcomes.median - a.outcomes.mean / a.outcomes.median)[0];
  d(`w, o and L are this run's medians per fight: a typical-turn indicator. The outcome and leaf counts are heavy-tailed (multi-hit turns${tail === undefined ? '' : `; ${tail.corpus.fight.id}'s median o is ${exact(tail.outcomes.median)}, its mean ${exact(tail.outcomes.mean)}`}), so a median-based figure is **not** a bound on expected work; the mean-based line under each table shows how far the tail can move it. s is the estimated AI support (1.5 for 3v3, 2 for 6v6), or the median legal p2 choices as the upper bound for the "any legal" badge. 50% means h = 0.5 at every level, an overall hit rate of 50%.`);
  d();
  d('The tree is full width, with no pruning: a prover stops an OR node at its first proven action and an AND node at its first refuted outcome, and it does not expand terminal or player-faint outcomes. That is the only sense in which these figures overstate a proof\'s work: they are an upper bound with respect to pruning, not with respect to the outcome and leaf distributions. The research\'s N-based estimate is given beside them.');
  d();
  for (const entry of projections) {
    const fight = entry.entry.corpus.fight;
    d(`### ${fight.id}: ${fight.title}${fight.synthetic ? ' (synthetic)' : ''}`);
    d();
    d(`w = ${exact(entry.w)}, o = ${exact(entry.o)}, L = ${exact(entry.l)} (medians); o = ${exact(entry.oMean)}, L = ${exact(entry.lMean)} (means); legal p2 = ${exact(entry.entry.p2.median)}; θ₁₂ = ${exact(entry.entry.theta12)} leaves/s${dirty ? ` (${contamination.level})` : ''}.`);
    d();
    d('| Turns | s | Transpositions | b = w·s·o | Nodes | expandTurn calls | Leaves | Time on 12 threads |');
    d('|---|---|---|---|---|---|---|---|');
    for (const r of entry.rows) d(`| ${r.d} | ${num(r.s, 1)}${r.s === entry.research.s ? ' (estimate)' : ' (legal p2)'} | ${r.hit === 0 ? 'none' : '50%'} | ${num(r.p.b)} | ${num(r.p.nodes)} | ${num(r.p.calls)} | ${num(r.p.leaves)} | ${duration(r.p.seconds)} |`);
    d();
    const ex = typical(entry, 3);
    const kept = ex.p.b * 0.5;
    const s = entry.research.s;
    d(`Arithmetic, 3 turns, estimated s, 50%: b = ${exact(entry.w)} × ${exact(s)} × ${exact(entry.o)} = ${exact(ex.p.b)}; kept per level = ${exact(ex.p.b)} × 0.5 = ${exact(kept)}; calls = ${exact(entry.w)} × ${exact(s)} × (1 + ${exact(kept)} + ${exact(kept)}²) = ${exact(entry.w * s)} × ${exact(1 + kept + kept ** 2)} = ${exact(ex.p.calls)}; leaves = ${exact(ex.p.calls)} × ${exact(entry.l)} = ${exact(ex.p.leaves)}; time = ${exact(ex.p.leaves)} / ${exact(entry.entry.theta12)} = ${secs(ex.p.seconds)}.`);
    d();
    d(`A tail-sensitive indicator, mean o × mean L (o = ${exact(entry.oMean)}, L = ${exact(entry.lMean)}, LIMITs counted at ${int(args.maxLeaves)}; estimated s, 50%): ${[3, 5, 8].map((depth) => `${depth} turns ${duration(entry.at(depth, true).seconds)}`).join(', ')}. It multiplies two means and ignores their correlation (the turns with many outcomes are the ones with many leaves), so it is neither an expectation nor a bound: it shows how far the tail can move the figure. The longest fight under ${duration(args.budget)}: ${turns(entry.longest)} (medians), ${turns(entry.longestMeans)} (means).`);
    d();
    d(`The estimated cost model T = N·w·s·L, with its typical N = ${exact(entry.research.n)} states, w tried = ${entry.research.wTried}, s = ${exact(s)} and this run's L: ${entry.researchModel.map((r, k) => `L ${k === 0 ? 'median' : 'mean'} ${exact(r.l)} → T = ${exact(entry.research.n)} × ${entry.research.wTried} × ${exact(s)} × ${exact(r.l)} = ${exact(r.t)} leaves → ${exact(r.t)} / ${exact(entry.entry.theta12)} = ${secs(r.seconds)}`).join('; ')}.`);
    d();
  }
  d('## Decision');
  d();
  d('The rule:');
  d();
  d('- If a typical 3v3 projects under the default 5-minute budget, the AI and the solver go ahead on Showdown.');
  d('- If 6v6 projects over budget, the AI and the solver still go ahead on Showdown, because the solver reaches the engine only through `expandTurn`, `legalChoices` and `key`. Those fights report "not proven within the time limit".');
  d('- In that case, a native-core plan (Rust hot path, tested turn by turn against this engine) is queued after the solver.');
  d();
  d(`Applied with a typical 3v3 of ${args.typical3} turns and a typical 6v6 of ${args.typical6} turns (at least one turn per KO, plus switches and misses; \`--typical-3v3\` and \`--typical-6v6\` change them), research s, a 50% transposition hit rate, on 12 threads:`);
  d();
  for (const line of decision) d(line);
  d();
  d(verdict);
  d();
  d('## Optimisation candidates (not done in this task)');
  d();
  d('Measured over this corpus (turn-choice expansions that finished):');
  d();
  d('| Fight | Leaves | Outcomes | Leaves merged into another\'s outcome | Pick-time collapse bound | Multi-hit expansions (leaves, outcomes) | Outcomes without effectOrder | Corpus keys without effectOrder |');
  d('|---|---|---|---|---|---|---|---|');
  const allTurn = stats.flatMap((entry) => entry.completed);
  for (const entry of stats) {
    const leaves = sum(entry.completed.map((run) => run.leaves));
    const outcomes = sum(entry.completed.map((run) => run.outcomes!));
    const multi = entry.completed.filter((run) => run.multiHit.length > 0);
    const eo = entry.completed.filter((run) => run.outcomesWithoutEffectOrder !== null);
    const eoOutcomes = outcomes - sum(eo.map((run) => run.outcomes! - run.outcomesWithoutEffectOrder!));
    const corpus = entry.corpus;
    const mismatch = corpus.keyMismatches > 0 ? ` (WARNING: ${corpus.keyMismatches} of ${corpus.keyChecks} re-keyed states did not match their key)` : '';
    d(`| ${corpus.fight.id} | ${int(leaves)} | ${int(outcomes)} | ${int(leaves - outcomes)} (${((1 - outcomes / leaves) * 100).toFixed(0)}%) | ${(leaves / outcomes).toFixed(2)}× | ${multi.length} (${int(sum(multi.map((run) => run.leaves)))}, ${int(sum(multi.map((run) => run.outcomes!)))}) | ${args.normalise ? `${int(outcomes)} → ${int(eoOutcomes)}` : 'not measured'} | ${args.normalise ? `${int(corpus.keys.size)} → ${int(corpus.keysWithoutEffectOrder.size)}${mismatch}` : 'not measured'} |`);
  }
  d();
  const multiMoves = [...new Set(allTurn.flatMap((run) => run.multiHit))];
  const mergedShare = 1 - sum(allTurn.map((run) => run.outcomes!)) / sum(allTurn.map((run) => run.leaves));
  const restoreShare = profile.phases.restore / profile.seconds;
  const stepShare = profile.phases.step / profile.seconds;
  const snapShare = profile.phases.snapshot / profile.seconds;
  const keyShare = profile.phases.key / profile.seconds;
  d('Estimates (each a speed-up of leaves/s or a cut in the leaves needed; they multiply only where they touch different costs):');
  d();
  d(`1. **KO-roll collapsing at pick time**, and any other pick-time grouping of rolls that reach one state: it can skip at most the leaves that merged into another leaf's outcome, ${(mergedShare * 100).toFixed(0)}% over this corpus (the "pick-time collapse bound" column per fight). Fights where one side's hits KO whatever the roll gain most.`);
  d(`2. **Multi-hit grouping** (moves seen: ${multiMoves.join(', ') || 'none'}): their expansions barely merge (compare their leaves and outcomes above), because the player's screen shows each hit's damage, so the observation tells the paths apart. Grouping their rolls at pick time saves only the leaves that merge. Cutting their cost needs a coarser observation or a solver-side bound, not an engine change.`);
  const eoChange = Math.max(...stats.map((entry) => {
    const outcomes = sum(entry.completed.map((run) => run.outcomes!));
    const saved = sum(entry.completed.filter((run) => run.outcomesWithoutEffectOrder !== null).map((run) => run.outcomes! - run.outcomesWithoutEffectOrder!));
    const keys = entry.corpus.keys.size;
    return Math.max(outcomes > 0 ? saved / outcomes : 0, keys > 0 ? (keys - entry.corpus.keysWithoutEffectOrder.size) / keys : 0);
  }));
  d(`3. **effectOrder normalisation** (keeping relative order): dropping it entirely, the upper bound in the table, ${args.normalise ? `changes outcome and key counts by at most ${(eoChange * 100).toFixed(1)}% here` : 'was not measured in this run (--no-normalise)'}. It acts on merging and transpositions, not on a leaf's cost.`);
  d(`4. **Cheaper restore**: \`restore\` is ${(restoreShare * 100).toFixed(0)}% of a leaf. Restoring once per expansion and replaying only from the first chance point (or a clone that skips \`fromJSON\`) would take at most ${(1 / (1 - restoreShare)).toFixed(2)}× off.`);
  d(`5. **Cheaper snapshot and key**: the snapshot is ${(snapShare * 100).toFixed(0)}% and \`stateKey\` ${(keyShare * 100).toFixed(0)}% of a leaf (canonical JSON of the whole battle, then SHA-256). Merging leaves by their JSON text before keying, or keying a compact encoding, could remove most of the key's share: at most ${(1 / (1 - keyShare)).toFixed(2)}× for the key alone, ${(1 / (1 - keyShare - snapShare)).toFixed(2)}× for both.`);
  d(`6. **The ceiling inside Showdown**: its turn is ${(stepShare * 100).toFixed(0)}% of a leaf, so even free restores, snapshots and keys give at most ${(1 / stepShare).toFixed(1)}× (about ${num(best / stepShare)} leaves/s on one thread here).`);
  d(`7. **A native core**: the earlier estimate assumes 10⁵–5 × 10⁵ leaves/s per thread, ${num(1e5 / best, 0)}–${num(5e5 / best, 0)}× this run's best single-thread figure. Only this moves the projections by orders of magnitude; 1–6 together are worth a small factor (at most ${(1 / (1 - mergedShare) / stepShare).toFixed(0)}× if 1 and 6 both reached their bounds).`);
  d();
  d('## Rerunning');
  d();
  d('`npm run bench:engine` takes about 15–25 minutes with the defaults; `--quick` about 5. `--help` lists the options: the fights and trainers, the corpus budget and shape, the timing runs, the thread counts and the cool-down. On a quiet machine, rerun with the defaults and check the scaling section\'s contamination line.');
  d();
  return { table, doc: doc.join('\n') };
}

if (isMainThread) {
  await main();
} else {
  runWorker();
}
