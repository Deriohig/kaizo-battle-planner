// One in-process solve (1 thread) with timers around every engine, AI and oracle call: where a solve spends its time.
// Read-only: it changes nothing. Usage: npm run profile:solve -- <trainerId> <party|ref,ref,…> <budgetSeconds> [badge]
// The save is $SAVE (default data/saves/pk-run-2026-11-09-0123.dsv, a frozen copy; git-ignored).
import { readFileSync } from 'node:fs';
import { loadBaseDeps, solverDeps } from '../src/integration/deps.js';
import { buildBox } from '../src/server/box.js';
import { DEFAULT_SETTINGS } from '../src/server/settings.js';
import { DEFAULT_RANKING } from '../src/solver/config.js';
import { createSolver } from '../src/solver/index.js';
import { resultStoreStats } from '../src/solver/store.js';

const [trainerId = 'roark-split/youngster-tristan/1', teamArg = 'party', budgetArg = '60', badgeArg = ''] = process.argv.slice(2);
const base = loadBaseDeps('data');
const savePath = process.env.SAVE ?? 'data/saves/pk-run-2026-11-09-0123.dsv';
const box = buildBox({ file: new Uint8Array(readFileSync(savePath)), savePath, savedAt: new Date(), data: base.data, settings: DEFAULT_SETTINGS });
const refs = teamArg === 'party' ? [...box.byRef.keys()].filter((r) => r.startsWith('party:')) : teamArg.split(',');
console.log('team:', refs.map((r) => `${r}=${box.byRef.get(r)?.name} L${box.byRef.get(r)?.level}`).join(', '));

const deps = solverDeps(base, box.byRef);
const T: Record<string, { n: number; ms: number }> = {};
const hist: Record<string, number> = {};
const kinds: Record<string, number> = {};
let outcomes = 0;
let merged = 0;
function timed<A extends unknown[], R>(name: string, f: (...a: A) => R, after?: (r: R) => void): (...a: A) => R {
  return (...a: A): R => {
    const t = performance.now();
    try {
      const r = f(...a);
      after?.(r);
      return r;
    } finally {
      const e = (T[name] ??= { n: 0, ms: 0 });
      e.n += 1;
      e.ms += performance.now() - t;
    }
  };
}
const e = deps.engine;
const m = deps.enemyModel;
const engine = {
  id: e.id,
  createBattle: timed('engine.createBattle', (...a: Parameters<typeof e.createBattle>) => e.createBattle(...a)),
  legalChoices: timed('engine.legalChoices', (...a: Parameters<typeof e.legalChoices>) => e.legalChoices(...a)),
  expandTurn: timed('engine.expandTurn', (...a: Parameters<typeof e.expandTurn>) => e.expandTurn(...a), (r) => {
    outcomes += r.length;
    const bucket = r.length <= 1 ? '1' : r.length <= 2 ? '2' : r.length <= 4 ? '3-4' : r.length <= 8 ? '5-8' : r.length <= 16 ? '9-16' : r.length <= 32 ? '17-32' : r.length <= 64 ? '33-64' : '65+';
    hist[bucket] = (hist[bucket] ?? 0) + 1;
    for (const o of r) {
      merged += o.merged;
      for (const k of new Set(o.labels.map((l) => l.kind))) kinds[k] = (kinds[k] ?? 0) + 1;
    }
  }),
  observe: timed('engine.observe', (...a: Parameters<typeof e.observe>) => e.observe(...a)),
  carryOut: timed('engine.carryOut', (...a: Parameters<typeof e.carryOut>) => e.carryOut(...a)),
  unmodelledIn: timed('engine.unmodelledIn', (...a: Parameters<typeof e.unmodelledIn>) => e.unmodelledIn(...a)),
};
const enemyModel = {
  id: m.id,
  initialMemory: timed('ai.initialMemory', (...a: Parameters<typeof m.initialMemory>) => m.initialMemory(...a)),
  support: timed('ai.support', (...a: Parameters<typeof m.support>) => m.support(...a)),
  replacementSupport: timed('ai.replacementSupport', (...a: Parameters<typeof m.replacementSupport>) => m.replacementSupport(...a)),
  remember: timed('ai.remember', (...a: Parameters<typeof m.remember>) => m.remember(...a)),
};
const o = deps.oracles;
const oracles = {
  ...o,
  damage: { id: o.damage.id, check: timed('oracle.damage', (...a: Parameters<typeof o.damage.check>) => o.damage.check(...a)) },
  speed: { id: o.speed.id, check: timed('oracle.speed', (...a: Parameters<typeof o.speed.check>) => o.speed.check(...a)) },
};
const hint = deps.orderHint;
const orderHint = hint === undefined ? undefined : timed('orderHint', (...a: Parameters<typeof hint>) => hint(...a));

const kills = new Map<string, number>();
const raws = new Map<string, number>();
const lab = deps.labeler!;
const labeler = {
  choice: (...a: Parameters<typeof lab.choice>) => lab.choice(...a),
  outcome: (...a: Parameters<typeof lab.outcome>) => lab.outcome(...a),
  killCause: (...a: Parameters<typeof lab.killCause>) => { const t = lab.killCause(...a); kills.set(t, (kills.get(t) ?? 0) + 1); return t; },
};
const rawEngine = { ...engine, expandTurn: (...a: Parameters<typeof e.expandTurn>) => { const r = engine.expandTurn(...a); for (const x of r) if (x.unlabelled) { const k = x.log.filter((l) => !l.startsWith('|t:')).slice(-3).join(' ~ ').slice(0, 200); raws.set(k, (raws.get(k) ?? 0) + 1); } return r; } };
const solver = createSolver({ ...deps, engine: rawEngine, enemyModel, oracles, labeler, ...(orderHint === undefined ? {} : { orderHint }), config: { threads: 1 } });
const budgetMs = Number(budgetArg) * 1000;
const stages: string[] = [];
let lastStage = '';
const t0 = performance.now();
const verdict = await solver.solve({
  fights: [{ trainerId, variant: 0, healBefore: false }], team: { kind: 'fixed', party: refs }, preStatus: 'given', budgetMs, horizonTurns: 50,
  attemptAnyLegalBadge: badgeArg === 'badge', ranking: [...DEFAULT_RANKING],
} as never, (p) => {
  const stage = p.message.replace(/[\d,]+ nodes?/g, 'N nodes').replace(/\d+/g, '#').slice(0, 70);
  if (stage !== lastStage) {
    lastStage = stage;
    stages.push(`${(p.elapsedMs / 1000).toFixed(1)}s ${p.message.slice(0, 90)}`);
  }
});
const wall = performance.now() - t0;
const v = verdict as unknown as { tier: unknown; reason?: string; detail?: string; best?: { tier: unknown }; report: Record<string, unknown> };
console.log(`verdict: tier ${v.tier}${v.reason ? ` (${v.reason}: ${String(v.detail).slice(0, 160)})` : ''}${v.best ? `; best tier ${v.best.tier}` : ''}; wall ${(wall / 1000).toFixed(1)} s`);
const { assumptions: _a, rejectedTeams: _r, ...rest } = v.report;
console.log('detail:', String(v.detail ?? '').slice(0, 400));
console.log('assumptions:'); for (const a of ((v.report.assumptions as string[]) ?? []).slice(0, 14)) console.log('   -', a.slice(0, 260));
const b = (v.best ?? v) as Record<string, unknown>;
console.log('line:', JSON.stringify({ tier: b.tier, rank: b.rank, critBudget: b.critBudget, deathProbability: b.deathProbability, killers: (b.killers as unknown[] | undefined)?.slice(0, 3), anyLegalBadge: b.anyLegalBadge }, (_k, x) => (typeof x === 'bigint' ? String(x) : x)).slice(0, 900));
console.log('report:', JSON.stringify(rest, (_k, x) => (typeof x === 'bigint' ? String(x) : x)).slice(0, 700));
console.log('kill causes seen (first 12):'); for (const [k, n] of [...kills].slice(0, 12)) console.log('   ', n, k.slice(0, 200));
console.log('unlabelled outcomes (first 6):'); for (const [k, n] of [...raws].slice(0, 6)) console.log('   ', n, k);
console.log('stages:'); for (const s of stages.slice(0, 40)) console.log('  ', s);
let inside = 0;
console.log('timers (calls, total ms, ms each, % of wall):');
for (const [name, t] of Object.entries(T).sort((a, b) => b[1].ms - a[1].ms)) {
  inside += t.ms;
  console.log(`  ${name.padEnd(24)} ${String(t.n).padStart(8)} ${t.ms.toFixed(0).padStart(9)} ${(t.ms / t.n).toFixed(2).padStart(8)} ${((100 * t.ms) / wall).toFixed(1).padStart(6)}%`);
}
console.log(`  everything else           ${' '.repeat(8)} ${(wall - inside).toFixed(0).padStart(9)} ${' '.repeat(8)} ${((100 * (wall - inside)) / wall).toFixed(1).padStart(6)}%`);
const calls = T['engine.expandTurn']?.n ?? 0;
console.log(`expandTurn: ${calls} calls, ${outcomes} outcomes (${(outcomes / Math.max(1, calls)).toFixed(1)} each), ${merged} leaves (${(merged / Math.max(1, calls)).toFixed(1)} each)`);
console.log('outcomes per expandTurn:', JSON.stringify(hist));
console.log('outcomes carrying each chance kind:', JSON.stringify(kinds));
console.log('result store (the timers above count its hits too):', JSON.stringify(resultStoreStats(deps.engine)));
process.exit(0);
