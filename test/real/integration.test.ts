// The integration on real data: the solver through `createSolver` with the real deps (the engine,
// the trainer AI, the resolver over a fixture save, the oracles, the labeler and the hints) on 2 worker threads. Needs
// the extracted data in DATA_DIR (`npm run extract`).
//
// While the engine is unfinished, a real battle may be unmodelled: the engine names what it does not model per move,
// for a trainer field note and for the pinch items (`unmodelledIn`), and then the verdict reads `unproven: unmodelled`
// and the line it found is its `best` (docs/solver-integration.md section 3). The tier-1 test therefore checks the
// line the solver found and verified, as the verdict or as its `best`, and that such a verdict's detail holds only
// the engine's own notes (`expectEngineOnlyDetail`): none of the integration's and no trainer-AI error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlayerMon } from '../../src/battle/playerMon.js';
import type { BattleInput, Choice, EngineState, Outcome } from '../../src/contracts/engine.js';
import type { MonRef, PlanLeaf, PlanNode, SolveRequest, Verdict } from '../../src/contracts/solver.js';
import { loadLocalData } from '../../src/data/load.js';
import type { WorkerDepsContext } from '../../src/integration/contextDeps.js';
import { loadBaseDeps, solverDeps } from '../../src/integration/deps.js';
import { fingerprintData } from '../../src/integration/fingerprint.js';
import { computeStats } from '../../src/rom/stats.js';
import { buildBox } from '../../src/server/box.js';
import { DEFAULT_SETTINGS } from '../../src/server/settings.js';
import { createSolver, DEFAULT_RANKING, type SolverDeps } from '../../src/solver/index.js';
import type { TestMon } from '../fixtures/buildSave.js';
import { saveFile } from '../unit/server/fixtures.js';
import { DATA_DIR, needFiles } from './env.js';
import { expectEngineOnlyDetail } from './unmodelledDetail.js';

const DATA = path.resolve(DATA_DIR);
const suite = needFiles('the real planner (integration preview)', {
  ROMDATA: path.join(DATA, 'rom', 'romdata.json'), TRAINER_AI: path.join(DATA, 'rom', 'trainer-ai.json'),
});

/** School Kid Harrison (Roark split): one Vulpix, level 1, no item, whose only move is Will-O-Wisp; the trainer's bag is empty. */
const HARRISON = 'roark-split/school-kid-harrison/1';
/**
 * Leader Fantina (Fantina split, the gym fight): six Ghosts, levels 36 to 38, and no field note (Roark's permanent sand,
 * which the engine does not apply yet, would make every AI decision unmodelled before any search).
 */
const FANTINA = 'fantina-split/leader-fantina/2';
const STEELIX = 208;
const STARLY = 396;
const SWIFT = 129;
const TACKLE = 33;

/** The real solver's worker deps module: createDeps(context) over the data folder and the box's Pokémon. */
const WORKER_DEPS = new URL('../../src/integration/workerDeps.ts', import.meta.url).href;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-real-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe.skipIf(suite.skip)(suite.title, () => {
  let local: ReturnType<typeof loadLocalData>;
  beforeAll(() => {
    local = loadLocalData(DATA);
  });

  /** A party Pokémon of `species` at `level` knowing `move`: Hardy, 31 IVs, no EVs, at full HP, nicknamed as the game does. */
  function partyMon(species: number, level: number, move: number): TestMon {
    const row = local.rom.species[species]!;
    const ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
    const hp = computeStats(row.baseStats, ivs, { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, level, 0).hp;
    return {
      pid: 0, species, nickname: local.names.species(species, 0).toUpperCase(), exp: level ** 3, level, ability: row.abilities[0],
      moves: [move], pp: [local.rom.moves[move]!.pp], ppUps: [0], ivs, currentHp: hp,
    };
  }

  /** The box of a fixture save holding `party`, with no level cap (the fights here are not about the cap). */
  function boxOf(party: TestMon[]) {
    return buildBox({
      file: saveFile({ trainerName: 'Lucas', badgeMask: 0, party }), savePath: path.join(scratch, 'game.dsv'), savedAt: new Date(),
      data: local, settings: { ...DEFAULT_SETTINGS, levelCapOverride: 100 },
    });
  }

  function request(trainerId: string, budgetMs: number): SolveRequest {
    return {
      fights: [{ trainerId }], team: { kind: 'fixed', party: ['party:1'] }, preStatus: 'given', budgetMs, horizonTurns: 50,
      attemptAnyLegalBadge: false, ranking: [...DEFAULT_RANKING],
    };
  }

  /**
   * createSolver over the real deps for `mons`, on 2 worker threads of a pool of its own whose workers build theirs from
   * the solve's worker context; the verdict, its wall time and leaves per second.
   */
  async function solve(mons: ReadonlyMap<MonRef, PlayerMon>, req: SolveRequest): Promise<{ verdict: Verdict; deps: SolverDeps; ms: number }> {
    const deps = solverDeps(loadBaseDeps(DATA), mons);
    const value: WorkerDepsContext = { dataDir: DATA, dataVersion: 1, fingerprint: fingerprintData(DATA), mons: [...mons] };
    const solver = createSolver({ ...deps, workerContext: { key: 'solve', value }, config: { threads: 2, depsModule: WORKER_DEPS } });
    const start = performance.now();
    const verdict = await solver.solve(req);
    const ms = performance.now() - start;
    const r = verdict.report;
    console.log(`${req.fights[0]!.trainerId}: ${verdict.tier}${verdict.tier === 'unproven' ? ` (${verdict.reason}; best ${verdict.best?.tier ?? 'none'})` : ''}`
      + ` in ${(ms / 1000).toFixed(1)} s; ${r.nodes} nodes, ${r.turnExecutions} leaves (${((r.turnExecutions * 1000) / r.elapsedMs).toFixed(0)} leaves/s over the`
      + ` solver's ${(r.elapsedMs / 1000).toFixed(1)} s); ${r.verification.damageChecks} damage and ${r.verification.orderChecks} order checks`);
    return { verdict, deps, ms };
  }

  /** The labeler's chance label without the plan's " (2)" for a repeat, and without a trailing enemy send-in. */
  const bare = (label: string) => label.replace(/ \(\d+\)$/, '').replace(/,? ?then the AI sends in .*$/, '').replace(/^The AI sends in .*$/, '');

  /**
   * Plays the plan's main line (branches[0] all the way down) in the engine: the player's actions from the player nodes, the
   * AI's likeliest action, and at each chance node the likeliest engine outcome the branch's label names (then the AI's
   * send-in, if the step ends at one). Gives the leaf's result and whether the engine's battle ended won by the player.
   */
  function replayMainLine(deps: SolverDeps, input: BattleInput, tree: PlanNode): { result: PlanLeaf['result']; won: boolean; steps: number } {
    const { engine, enemyModel: ai, labeler } = deps;
    let state: EngineState = engine.createBattle(input);
    let memory = ai.initialMemory(state);
    let pending: { p1?: Choice; p2?: Choice } = {};
    let at: PlanNode | PlanLeaf = tree;
    let steps = 0;
    const top = (support: { choice: Choice; probability: { num: bigint; den: bigint } }[]) =>
      support.reduce((a, b) => (a.probability.num * b.probability.den >= b.probability.num * a.probability.den ? a : b)).choice;
    const step = (choices: { p1?: Choice; p2?: Choice }, label: string | null): Outcome => {
      const outcomes = engine.expandTurn(state, choices);
      const named = label === null ? outcomes : outcomes.filter((o) => labeler!.outcome(o) === label);
      expect(named.length, `an engine outcome labelled "${label}"`).toBeGreaterThan(0);
      const pick = named.reduce((a, b) => (a.probability.num * b.probability.den >= b.probability.num * a.probability.den ? a : b));
      memory = ai.remember(memory, pick);
      state = pick.state;
      steps += 1;
      return pick;
    };
    while (!('result' in at)) {
      const node: PlanNode = at;
      const branch = node.branches[0]!;
      if (node.kind === 'player') {
        if (!node.actionLabel?.startsWith('Lead with')) pending = { p1: node.action! };
      } else if (node.kind === 'enemy') {
        const choice = top(state.phase.kind === 'turnChoice' ? ai.support(state, memory) : ai.replacementSupport(state, memory));
        expect(branch.label).toContain(labeler!.choice(state, 'p2', choice).replace(/^(Use |Switch to )/, ''));
        pending = { ...pending, p2: choice };
      } else if (pending.p1 !== undefined || pending.p2 !== undefined) {
        step(pending, bare(branch.label));
        pending = {};
        if (state.phase.kind === 'enemyReplacement') step({ p2: top(ai.replacementSupport(state, memory)) }, null);
      }
      at = branch.next;
    }
    return { result: at.result, won: state.phase.kind === 'terminal' && state.phase.winner === 'p1', steps };
  }

  it("proves Steelix (level 50, Swift) safe against School Kid Harrison's level-1 Vulpix, and its main line wins in the engine", async () => {
    // Why this must be tier 1: Vulpix's only move, Will-O-Wisp, deals no damage, it holds nothing and its trainer's bag is
    // empty. Steelix (Speed 50 against Vulpix's 6) always moves first, Swift never misses, and its lowest roll is several
    // times a level-1 Vulpix's HP, so the battle ends on turn 1 before Vulpix acts, crit or not, in either world of
    // Vulpix's disputed data. No outcome can hurt Steelix at all.
    const box = boxOf([partyMon(STEELIX, 50, SWIFT)]);
    const { verdict, deps } = await solve(box.byRef, request(HARRISON, 20_000));
    expect(verdict.tier === 1 || (verdict.tier === 'unproven' && verdict.reason === 'unmodelled')).toBe(true);
    if (verdict.tier === 'unproven') expectEngineOnlyDetail(verdict.detail);
    const line = verdict.tier === 'unproven' ? verdict.best : verdict;
    expect(line?.tier).toBe(1);
    if (line === undefined || line.tier !== 1) return;
    expect(line.report.verification.mismatches).toEqual([]);
    expect(line.report.verification.damageChecks).toBeGreaterThan(0);
    expect(line.tree.actionLabel).toBe('Lead with Steelix');
    const fight = deps.resolver.fight({ trainerId: HARRISON });
    for (const world of fight.worlds) {
      const input: BattleInput = { player: [box.byRef.get('party:1')!], trainer: fight.trainer, field: fight.field, world };
      const replay = replayMainLine(deps, input, line.tree);
      expect(replay).toEqual({ result: 'win', won: true, steps: 1 });
    }
  }, 60_000);

  it('never calls a lone level-5 Starly safe against Leader Fantina: tier 3 or unproven', async () => {
    // Starly's Tackle cannot touch a Ghost, and each of Fantina's level-36+ Pokémon knocks it out: no line survives.
    const box = boxOf([partyMon(STARLY, 5, TACKLE)]);
    const { verdict } = await solve(box.byRef, request(FANTINA, 5_000));
    expect(verdict.tier === 3 || verdict.tier === 'unproven').toBe(true);
    if (verdict.tier === 'unproven') expect(verdict.best?.tier).not.toBe(1);
    if (verdict.tier === 'unproven' && verdict.reason === 'unmodelled') expectEngineOnlyDetail(verdict.detail);   // the engine's notes, no one else's
    expect(verdict.report.turnExecutions).toBeGreaterThan(0);   // the engine ran: the battle was searched, not refused
  }, 60_000);
});
