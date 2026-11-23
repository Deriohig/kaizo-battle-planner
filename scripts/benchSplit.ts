// Every single battle of a split through the real solver (the worker-thread path the server ran until 7c), one row
// each; the measuring stick for speed work. The team is the save's party (the
// Pokémon with HP left).
// Usage: npm run bench:split -- <split> [--save <file>] [--budget route|gym] [--threads <n>] [--refine first|best]
//          [--jobs <n>] [--checker-compare]
// --jobs n: n trainers at once on the same pool (n at most the thread count); each solve then gets floor(threads / n) workers,
// at least 2 (one would run it on this thread). --checker-compare: every shown line is checked with the store and with the
// bare engine and AI; a difference is that trainer's verdict (unproven, verificationMismatch) and is counted separately.
// Exits 1 when any solve crashed.
import { readFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import {
  BenchRunError, formatTable, oversubscription, parseBenchArgs, partyRefs, rowLine, runAll, runOne, splitTrainers, summarize, summaryLine, warmUp,
  type BenchContext, type BenchRow,
} from '../src/integration/benchSplit.js';
import { defaultThreads, loadBaseDeps } from '../src/integration/deps.js';
import { createRealSolver } from '../src/integration/realSolver.js';
import { buildBox } from '../src/server/box.js';
import { DEFAULT_HORIZON_TURNS, DEFAULT_PLAN_SETTINGS } from '../src/integration/planRequest.js';
import { DEFAULT_SETTINGS } from '../src/server/settings.js';
import type { ServerData } from '../src/server/state.js';

const USAGE = 'Usage: npm run bench:split -- <split> [--save <file>] [--budget route|gym] [--threads <n>] [--refine first|best] [--jobs <n>] [--checker-compare]';
function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const parsed = parseBenchArgs(process.argv.slice(2));
if (!parsed.ok) fail(`${parsed.error}\n${USAGE}`);
const { args } = parsed;
const threads = args.threads ?? defaultThreads();
if (args.jobs > threads) fail(`--jobs ${args.jobs} is more than the ${threads} worker threads: use --jobs ${threads} or fewer, or more --threads`);
const solveThreads = args.jobs === 1 ? threads : Math.max(2, Math.floor(threads / args.jobs));
const oversubscribed = oversubscription(args.jobs, solveThreads, availableParallelism());
if (oversubscribed !== null) console.warn(oversubscribed);

const base = loadBaseDeps('data');
const data: ServerData = { local: base.data, catalog: base.catalog, moves: base.moves };
const box = buildBox({ file: new Uint8Array(readFileSync(args.save)), savePath: args.save, savedAt: new Date(), data: base.data, settings: DEFAULT_SETTINGS });
const party = partyRefs(box.json.mons, (ref) => box.byRef.has(ref));
if (party.length === 0) fail(`The save ${args.save} has no party Pokémon with HP left that the planner can use, so there is no team to bench with`);
const trainers = splitTrainers(base.catalog, args.split);
if (trainers.length === 0) fail(`No single battles in a split called ${JSON.stringify(args.split)}`);

console.log(`load ${loadavg()[0]!.toFixed(2)}, ${threads} threads, ${args.jobs} at once (${solveThreads} per solve), budget ${args.budget} (${DEFAULT_PLAN_SETTINGS.budgetsMs[args.budget] / 1000} s), refine ${args.refine}${args.checkerCompare ? ', checker-compare' : ''}`);
console.log(`save ${args.save}`);
console.log(`team ${party.map((r) => `${r}=${box.byRef.get(r)?.name} L${box.byRef.get(r)?.level}`).join(', ')}`);
console.log(`${trainers.length} battles of ${trainers[0]!.split}`);

const solver = createRealSolver({
  state: () => ({ data: () => data, box: () => box, dataVersion: () => 1 }), dataDir: 'data', threads, solveThreads,
  ...(args.checkerCompare ? { config: { checkerCompare: true } } : {}),
});
const ctx: BenchContext = { party, plan: { catalog: base.catalog, eligible: new Set(box.byRef.keys()), settings: DEFAULT_PLAN_SETTINGS, horizonTurns: DEFAULT_HORIZON_TURNS } };
let failed = false;
function report(rows: BenchRow[]): void {
  console.log('');
  console.log(formatTable(rows));
  console.log('');
  const summary = summarize(rows);
  console.log(summaryLine(summary));
  if (summary.crashed > 0) failed = true;
}
try {
  const warmStart = performance.now();
  await warmUp(solver, trainers[0]!, args, ctx);
  console.log(`warmed up in ${((performance.now() - warmStart) / 1000).toFixed(1)} s (not counted in any row)`);
  let finished = 0;
  report(await runAll(trainers, args.jobs, (trainer) => runOne(solver, trainer, args, ctx), (row) => {
    finished += 1;
    console.log(rowLine(row, finished, trainers.length));
  }));
} catch (e) {
  failed = true;
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  if (e instanceof BenchRunError) {
    console.error(`${e.rows.length} of ${trainers.length} rows finished before the failure:`);
    report(e.rows);
  }
} finally {
  await solver.close();
}
process.exit(failed ? 1 : 0);
