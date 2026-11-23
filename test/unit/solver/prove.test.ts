import { describe, expect, it } from 'vitest';
import type { EnemyModel } from '../../../src/contracts/ai.js';
import type { Choice, Engine, EngineState } from '../../../src/contracts/engine.js';
import type { Arena, Member } from '../../../src/solver/arena.js';
import { expandBelief, rootBelief, type Belief, type BeliefOpts } from '../../../src/solver/belief.js';
import {
  certificateFromPolicy, certificateStats, extractProof, parseCertificate, serializeCertificate, type Certificate,
} from '../../../src/solver/certificate.js';
import { defaultLabeler } from '../../../src/solver/labeler.js';
import { orderChoices } from '../../../src/solver/order.js';
import { Prover, type ProofResult, type ProverOptions } from '../../../src/solver/prove.js';
import { ONE, rat } from '../../../src/solver/rational.js';
import type { GameParams, ObservationMode } from '../../../src/solver/types.js';
import { makeArena, scenarioArena, tableFights } from './toy/fixtures.js';
import {
  critOnlyBudget0, critOnlyBudget1, deadlyRolls, hiddenCounterSafe, loopEscape, safe1v1, stall, TABLES, twoSafeLines, unlabelledOnly, uturnLine,
  worldsSplit, type Scenario,
} from './toy/scenarios.js';
import { tableGame, type TableNode, type TableSpec } from './toy/table.js';

const PARAMS: GameParams = { level: 1, critBudget: null, thresholds: null };
const G0 = { params: { ...PARAMS, critBudget: 0 } };
const OPTS: BeliefOpts = { level: 1, critCap: null, mode: 'display' };
const HALF = rat(1, 2);
const WIN = { phase: 'win', next: {} } as const;
const DEAD = { phase: 'lose', next: {} } as const;
const move = (slot: number): Choice => ({ kind: 'move', slot });
const pick = (index: number): Choice => ({ kind: 'switch', index });
const thresholds = (t: GameParams['thresholds']): Partial<ProverOptions> => ({ params: { ...PARAMS, thresholds: t } });
const riskOpts = (horizon: number, mode: ObservationMode = 'display') => ({ level: 1 as const, mode, horizon, critBudget: null });
/** A turn whose one choice 'go' leads to `to`. */
const go = (to: string, extra: { critP2?: boolean; faintP1?: boolean } = {}): TableNode => ({ phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to, p: ONE, ...extra }] } });
/** A turn whose one choice 't' leads to `a` or `b`, 1/2 each. */
const fork = (a: string, b: string): TableNode => ({ phase: 'turnChoice', p1: ['t'], next: { 't|': [{ to: a, p: HALF }, { to: b, p: HALF }] } });

function proverFor(arena: Arena, over: Partial<ProverOptions> = {}): Prover {
  return new Prover(arena, { params: PARAMS, mode: 'display', deadline: Number.POSITIVE_INFINITY, now: () => 0, labeler: defaultLabeler, history: new Map(), ...over });
}

/** A fresh prover over `arena`, deepened from the root up to `maxH`. */
function deepen(arena: Arena, maxH: number, over: Partial<ProverOptions> = {}) {
  const prover = proverFor(arena, over);
  return { prover, ...prover.deepen(rootBelief(arena), maxH) };
}

/** `deepen`, which must win, and the certificate at the winning horizon. */
function proven(arena: Arena, maxH: number, over: Partial<ProverOptions> = {}) {
  const { prover, result, horizon } = deepen(arena, maxH, over);
  expect(result.kind).toBe('win');
  const root = rootBelief(arena);
  return { arena, prover, root, horizon, cert: extractProof(prover, root, horizon) };
}

const provenScenario = (s: Scenario, over: Partial<ProverOptions> = {}) => proven(scenarioArena(s), s.horizon, over);

function tableArena(spec: TableSpec, ai?: EnemyModel): Arena {
  const t = tableGame(spec);
  return makeArena(tableFights(t), t.engine, ai ?? t.ai);
}

function failOf(r: ProofResult): Extract<ProofResult, { kind: 'fail' }> {
  if (r.kind !== 'fail') throw new Error(`expected a fail, got ${JSON.stringify(r)}`);
  return r;
}

/** The only child of (belief, choice), which must have no leaves. */
function onlyChild(arena: Arena, b: Belief, c: Choice): Belief {
  const x = expandBelief(arena, b, c, OPTS);
  expect([x.leaves, x.children.length]).toEqual([[], 1]);
  return x.children[0]!.belief;
}

/** The child of (belief, choice) at the table state `name`. */
function childAt(arena: Arena, b: Belief, c: Choice, name: string): Belief {
  const child = expandBelief(arena, b, c, OPTS).children.find((x) => x.edge.startsWith(`${name}\u001f`));
  if (child === undefined) throw new Error(`no child at ${name}`);
  return child.belief;
}

/** The first battle belief: the root's only child after leading with team index 0. */
const started = (arena: Arena): Belief => onlyChild(arena, rootBelief(arena), pick(0));
const nodesAt = (cert: Certificate, name: string): Certificate['nodes'] => cert.nodes.filter((n) => n.observation.startsWith(`${name}\u001f`));

/** Fight 0: S → long → Y → X or S → short → X, then X wins; fight 1 is the chain G1 → G2 → G3 → win. */
function gauntletArena(): Arena {
  const spec: TableSpec = {
    start: 'S',
    nodes: {
      S: { phase: 'turnChoice', p1: ['long', 'short'], next: { 'long|': [{ to: 'Y', p: ONE }], 'short|': [{ to: 'X', p: ONE }] } },
      Y: go('X'), X: go('win'), G1: go('G2'), G2: go('G3'), G3: go('win'), win: WIN,
    },
  };
  const first = tableGame(spec);
  const second = tableGame({ ...spec, start: 'G1' });
  const engine: Engine = { ...first.engine, createBattle: (input) => (input.trainer.id === 'second' ? second : first).engine.createBattle(input) };
  const [f0] = tableFights(first);
  return makeArena([f0!, { ...f0!, info: { ...f0!.info, trainer: { ...f0!.info.trainer, id: 'second' } } }], engine, first.ai);
}

// A → X 1/4, Y 3/4; B → X 3/4, Y 1/4. X and Y look alike: the same two members behind one screen, with other weights.
const MERGE: TableSpec = {
  start: 'T',
  nodes: {
    T: fork('A', 'B'),
    A: { phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to: 'X', p: rat(1, 4) }, { to: 'Y', p: rat(3, 4) }] } },
    B: { phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to: 'X', p: rat(3, 4) }, { to: 'Y', p: rat(1, 4) }] } },
    X: { ...go('win'), obs: 'XY' }, Y: { ...go('win'), obs: 'XY' }, win: WIN,
  },
};

// C wins slow (through D) or fast. T → A → C leaves C 2 turns at horizon 4; T → B → B2 → C leaves 1, where only fast wins.
const SLOW_FAST: TableSpec = {
  start: 'T',
  nodes: {
    T: fork('A', 'B'), A: go('C'), B: go('B2'), B2: go('C'), D: go('win'), win: WIN,
    C: { phase: 'turnChoice', p1: ['slow', 'fast'], next: { 'slow|': [{ to: 'D', p: ONE }], 'fast|': [{ to: 'win', p: ONE }] } },
  },
};

/** A certificate for the policy `act` on `arena`. */
function policyOn(arena: Arena, act: Parameters<typeof certificateFromPolicy>[2], horizon = 3, mode: ObservationMode = 'display') {
  return { arena, cert: certificateFromPolicy(arena, rootBelief(arena), act, riskOpts(horizon, mode)) };
}

/** A risk line: deadlyRolls played as Gamble every turn within 2 turns. */
const deadlyRollsRisk = () => policyOn(scenarioArena(deadlyRolls), (b) => (b.phase === 'entry' ? pick(0) : move(1)), 2);

interface FailCase { name: string; arena: () => Arena; maxH: number; over?: Partial<ProverOptions>; fail: object; horizon?: number; entry?: object; last?: RegExp }

// Not refuted: a cut-off, an unlabelled outcome, an engine LIMIT, no legal choice, a choice never refuted (deadOrRaw's B).
const refuted = (reasons: object) => ({ horizon: false, refuted: true, reasons });
const unrefuted = (reasons: object) => ({ horizon: false, refuted: false, reasons });
const FAILS: FailCase[] = [
  { name: 'crit deaths (tier 1)', arena: () => scenarioArena(critOnlyBudget0), maxH: 3, horizon: 2, fail: refuted({ death: true, horizon: false, unmodelled: false }) },
  { name: 'an AI coin flip needing different answers', arena: () => tableArena(TABLES.coinFlip), maxH: 3, fail: refuted({ death: true }) },
  { name: 'worlds needing different first moves in display mode', arena: () => scenarioArena(worldsSplit), maxH: 3, fail: { horizon: false, reasons: { death: true } } },
  { name: 'stall, on the horizon only', arena: () => scenarioArena(stall), maxH: 3, horizon: 3, entry: { kind: 'failHorizon', refuted: false },
    fail: { horizon: true, refuted: false, reasons: { death: false, horizon: true, unmodelled: false, repetition: false } } },
  { name: 'an unlabelled line', arena: () => scenarioArena(unlabelledOnly), maxH: 2, last: /^unmodelled: /, fail: unrefuted({ unmodelled: true, death: false }) },
  { name: 'a belief with no legal choice', arena: () => scenarioArena(safe1v1), maxH: 3, over: { restrictRoot: [move(0)] },
    fail: { ...unrefuted({ unmodelled: true }), refutation: ['no legal choice'] } },
  { name: 'an engine LIMIT (stored as failAbs)', arena: () => scenarioArena(critOnlyBudget0, { maxLeaves: 1 }), maxH: 3, horizon: 1,
    entry: { kind: 'failAbs', reasons: { engineLimit: true, death: false } }, fail: unrefuted({ engineLimit: true, death: false }) },
  { name: 'death or unlabelled', arena: () => tableArena(TABLES.deadOrRaw), maxH: 3, entry: { kind: 'failAbs', refuted: false }, fail: unrefuted({ death: true, unmodelled: true }) },
  { name: 'every choice dies', arena: () => tableArena(TABLES.bothDie), maxH: 3, entry: { kind: 'failAbs', refuted: true }, fail: refuted({ death: true, unmodelled: false }) },
  // Once a miss can return to a position still on the stack, the loop is an absolute failure and deepening stops.
  { name: 'a loop under sure termination', arena: () => scenarioArena(loopEscape), maxH: 10, horizon: 5, fail: refuted({ repetition: true, death: false }) },
  // safe1v1 ends with Hero 10/10 and Strike at 9 PP.
  ...[{ minHpFrac: { value: ONE, strict: true } }, { totalHp: { value: 10, strict: true } }, { pp: { value: 9, strict: true } }, { pp: { value: 10, strict: false } }]
    .map((t, i): FailCase => ({
      name: `missed threshold ${i}`, arena: () => scenarioArena(safe1v1), maxH: 3, over: thresholds(t), last: /^threshold: /, fail: refuted({ threshold: true, death: false }),
    })),
];

describe('prove', () => {
  it.each<[string, () => Arena, Partial<ProverOptions>, number]>([
    ['safe 1v1', () => scenarioArena(safe1v1), {}, 1],
    ['safe 1v1 at its threshold bounds', () => scenarioArena(safe1v1),
      thresholds({ minHpFrac: { value: ONE, strict: false }, totalHp: { value: 10, strict: false }, pp: { value: 9, strict: false } }), 1],
    ['G_0 (enemy crits dropped)', () => scenarioArena(critOnlyBudget0), G0, 2],
    ['the hidden counter', () => scenarioArena(hiddenCounterSafe), {}, 3],
    ['the u-turn line', () => scenarioArena(uturnLine), {}, 2],
    ['worlds split in RAM mode', () => scenarioArena(worldsSplit), { mode: 'ram' }, 1],
  ])('%s is proven', (_name, arena, over, depth) => {
    expect(deepen(arena(), 3, over)).toMatchObject({ result: { kind: 'win', depth }, horizon: depth });
  });

  it.each(FAILS)('$name fails', ({ arena: make, maxH, over, fail, horizon, entry, last }) => {
    const arena = make();
    const run = deepen(arena, maxH, over);
    const r = failOf(run.result);
    expect(r).toMatchObject(fail);
    if (horizon !== undefined) expect(run.horizon).toBe(horizon);
    if (entry !== undefined) expect(run.prover.tt.get(started(arena).key)).toMatchObject(entry);
    if (last !== undefined) expect(r.refutation.at(-1)).toMatch(last);
  });

  it('a refutation names the settled path and the kill', () => {
    expect(failOf(deepen(scenarioArena(critOnlyBudget0), 3).result).refutation.slice(0, 5))
      .toEqual(['Lead with Hero', 'Use move 1', 'If bash crit', 'Use move 1', expect.stringMatching(/^(enemy crit )?bash on turn 2 kills party 0$/)]);
  });

  it('G_0: reaching a crit-only state with no turn left is still a cut-off', () => {
    // V's only outcome is an enemy crit, so G_0 drops all of it; T → W → V at horizon 2 still cuts off.
    const vacuous: TableSpec = { start: 'T', nodes: { T: fork('V', 'W'), W: go('V'), V: go('Z', { critP2: true }), Z: go('dead', { faintP1: true }), dead: DEAD } };
    expect(failOf(deepen(tableArena(vacuous), 2, G0).result).horizon).toBe(true);
    expect(deepen(tableArena(vacuous), 3, G0)).toMatchObject({ result: { kind: 'win' }, horizon: 3 });
  });

  it('each AI answer and each hidden counter gets its own proven action', () => {
    const t = tableGame(TABLES.coinFlip);
    for (const [slot, answer] of [[0, 0], [1, 1]] as const) {   // against X, A wins; against Y, B wins
      const arena = makeArena(tableFights(t), t.engine, { ...t.ai, support: () => [{ choice: move(slot), probability: ONE }] });
      const { prover, result } = deepen(arena, 3);
      expect([result, prover.tt.get(started(arena).key)]).toEqual([{ kind: 'win', depth: 1 }, { kind: 'win', depth: 1, H: 1, action: move(answer) }]);
    }
    const arena = scenarioArena(hiddenCounterSafe);
    const { prover } = deepen(arena, 3);
    const asleep = onlyChild(arena, started(arena), move(0));   // counters 1 and 2 behind one screen
    expect([asleep.members.length, prover.tt.get(asleep.key)]).toEqual([2, { kind: 'win', depth: 2, H: 3, action: move(0) }]);
  });

  it('u-turn: the mid-turn switch, and restrictRoot limits the root only', () => {
    const arena = scenarioArena(uturnLine);
    const history = new Map<string, Choice>();
    deepen(arena, 3, { history });
    const root = rootBelief(arena);
    const midTurn = onlyChild(arena, started(arena), move(0));
    expect([history.get(root.key), midTurn.phase, history.get(midTurn.key)]).toEqual([pick(0), 'playerMidTurnSwitch', pick(1)]);

    const scout = proverFor(arena, { restrictRoot: [pick(0)] });
    expect(scout.deepen(root, 3).result.kind).toBe('win');
    expect(failOf(deepen(arena, 3, { restrictRoot: [pick(1)] }).result).reasons.death).toBe(true);
    scout.tt.clear();
    expect(scout.prove(midTurn, 2)).toEqual({ kind: 'win', depth: 1 });   // a later call on another belief is not restricted
    expect(() => scout.deepen(midTurn, 3)).toThrow(/new Prover/);
    // Direct prove calls: without setRoot nothing is restricted; with it, the Tank lead dies.
    const [loose, tank] = [proverFor(arena, { restrictRoot: [pick(1)] }), proverFor(arena, { restrictRoot: [pick(1)] })];
    tank.setRoot(root);
    loose.H = tank.H = 3;
    expect([loose.prove(root, 3), failOf(tank.prove(root, 3)).reasons.death]).toEqual([{ kind: 'win', depth: 2 }, true]);
    expect(() => tank.setRoot(midTurn)).toThrow(/new Prover/);
    expect(() => loose.setRoot(root)).toThrow(/new Prover/);   // its table already holds the unrestricted game
  });

  it('a repetition failure is not cached as absolute', () => {
    const arena = tableArena(TABLES.ghi);
    const b1 = onlyChild(arena, childAt(arena, started(arena), move(0), 'S'), move(0));   // T → S → B1
    const { prover, result, horizon } = deepen(arena, 6);
    expect([result, horizon]).toEqual([{ kind: 'win', depth: 4 }, 4]);
    expect(prover.tt.get(b1.key)?.kind).not.toBe('failAbs');
    // Without deepening, R is searched first: R → a → B1 meets R on the stack or dies. A failAbs for B1 would then fail S → B1.
    const direct = proverFor(arena);
    direct.H = 4;
    expect(direct.prove(rootBelief(arena), 4)).toEqual({ kind: 'win', depth: 4 });
    expect(direct.tt.get(b1.key)).toEqual({ kind: 'win', depth: 2, H: 4, action: move(0) });
  });

  it('horizon failures and wins are reused only where their turns suffice', () => {
    const arena = tableArena(TABLES.chain3);
    const c2 = onlyChild(arena, started(arena), move(0));
    const prover = proverFor(arena);
    expect(prover.deepen(rootBelief(arena), 2)).toMatchObject({ result: { kind: 'fail', horizon: true }, horizon: 2 });
    expect(prover.tt.get(c2.key)).toMatchObject({ kind: 'failHorizon', h: 1, H: 2 });
    const hits = prover.tt.hits;
    expect(prover.deepen(rootBelief(arena), 3)).toEqual({ result: { kind: 'win', depth: 3 }, horizon: 3 });
    expect([prover.tt.hits > hits, prover.tt.get(c2.key)]).toEqual([true, { kind: 'win', depth: 2, H: 3, action: move(0) }]);
    // S tries the detour first and meets C1 with 1 turn left (cut off); the direct move reaches C1 with 2 left.
    const detour = tableArena({
      start: 'S',
      nodes: {
        S: { phase: 'turnChoice', p1: ['detour', 'direct'], next: { 'detour|': [{ to: 'D', p: ONE }], 'direct|': [{ to: 'C1', p: ONE }] } },
        D: go('C1'), C1: go('C2'), C2: go('win'), win: WIN,
      },
    });
    const history = new Map<string, Choice>();
    expect(deepen(detour, 4, { history })).toMatchObject({ result: { kind: 'win', depth: 3 }, horizon: 3 });
    expect(history.get(started(detour).key)).toEqual(move(1));
    // C1 wins in 2, reached in 1 turn through A and in 2 through B: A's win must not serve B's visit, so H = 5.
    const twoPaths = tableArena({ start: 'T', nodes: { T: fork('A', 'B'), A: go('C1'), B: go('B2'), B2: go('C1'), C1: go('C2'), C2: go('win'), win: WIN } });
    expect(deepen(twoPaths, 6)).toMatchObject({ result: { kind: 'win', depth: 5 }, horizon: 5 });
  });

  it('a gauntlet: entries record the per-fight horizon H', () => {
    // At H = 3, long reaches X with 1 turn left, as X's failHorizon from H = 2 did: reuse by h alone would prove short.
    const gauntlet = gauntletArena();
    const history = new Map<string, Choice>();
    const g = deepen(gauntlet, 4, { history });
    const s = started(gauntlet);
    expect([g.result, g.horizon, history.get(s.key)]).toEqual([{ kind: 'win', depth: 3 }, 3, move(0)]);
    // S's win needed fight 1 within 3 turns: not reused at H = 2. The last fight's wins do not depend on H.
    expect(g.prover.tt.get(s.key)).toEqual({ kind: 'win', depth: 3, H: 3, action: move(0) });
    g.prover.H = 2;
    expect(failOf(g.prover.prove(s, 3)).horizon).toBe(true);
    expect(g.prover.tt.get(s.key)?.kind).toBe('win');   // a win is never replaced by a fail
    const x = onlyChild(gauntlet, onlyChild(gauntlet, s, move(0)), move(0));
    const g1 = onlyChild(gauntlet, onlyChild(gauntlet, x, move(0)), pick(0));
    const [nodes, hits] = [gauntlet.stats.nodes, g.prover.tt.hits];
    expect([g1.fight, g.prover.prove(g1, 3)]).toEqual([1, { kind: 'win', depth: 3 }]);
    expect([gauntlet.stats.nodes - nodes, g.prover.tt.hits - hits]).toEqual([0, 1]);   // reused, not searched again
  });

  it('timeouts and aborts are never cached', () => {
    const arena = scenarioArena(safe1v1);
    let clock = 10;
    const prover = proverFor(arena, { deadline: 5, now: () => clock });
    expect([prover.deepen(rootBelief(arena), 3), prover.tt.size]).toEqual([{ result: { kind: 'unknown', cause: 'timeout' }, horizon: 1 }, 0]);
    clock = 0;
    expect(prover.deepen(rootBelief(arena), 3)).toEqual({ result: { kind: 'win', depth: 1 }, horizon: 1 });
    expect(prover.tt.size).toBeGreaterThan(0);
    const aborted = proverFor(arena, { signal: AbortSignal.abort() });
    expect([aborted.deepen(rootBelief(arena), 3), aborted.tt.size]).toEqual([{ result: { kind: 'unknown', cause: 'aborted' }, horizon: 1 }, 0]);
    // A timeout deep in the tree: the beliefs above pass the unknown up and store nothing.
    const deep = scenarioArena(hiddenCounterSafe);
    let ticks = 0;
    const late = proverFor(deep, { deadline: 1, now: () => ticks++ });
    late.H = 3;
    expect([late.prove(rootBelief(deep), 3), ticks, late.tt.size]).toEqual([{ kind: 'unknown', cause: 'timeout' }, 3, 0]);
  });

  it('an order hint follows the history choice, skips the entry, and must return a permutation', () => {
    const state = { json: '', turn: 1, phase: { kind: 'turnChoice' }, key: 'k' } as EngineState;
    const battle: Belief = { key: 'B', members: [{ member: { state } as Member, weight: ONE }], fight: 0, phase: 'turnChoice', observation: '' };
    const entry: Belief = { ...battle, members: [{ member: { state: null } as Member, weight: ONE }], phase: 'entry' };
    const reverse = (_s: EngineState, cs: Choice[]): Choice[] => [...cs].reverse();
    const choices = [pick(1), move(1), { kind: 'item', item: 'potion' } as Choice, move(0)];
    expect(orderChoices(battle, choices, new Map([['B', pick(1)]]), reverse)).toEqual([pick(1), choices[2], move(1), move(0)]);
    expect(orderChoices(entry, [pick(2), pick(0)], new Map(), reverse)).toEqual([pick(0), pick(2)]);
    expect(() => orderChoices(battle, choices, new Map(), (_s, cs) => cs.slice(1))).toThrow(/permutation/);
    expect(() => orderChoices(battle, choices, new Map(), (_s, cs) => cs.splice(1) && cs)).toThrow(/permutation/);   // edits its argument
  });
});

describe('certificate', () => {
  it('one node per belief, edges by observation, breadth first', () => {
    const { arena, cert } = provenScenario(hiddenCounterSafe);
    expect(cert).toMatchObject({ kind: 'proof', level: 1, mode: 'display', horizon: 3, critBudget: null, thresholds: null, engineId: 'toy-engine@1', aiId: 'toy-ai@1', fights: 1 });
    expect(cert.nodes.map((n) => [n.id, n.phase, n.fight, n.action])).toEqual([[0, 'entry', 0, pick(0)], [1, 'turnChoice', 0, move(0)], [2, 'turnChoice', 0, move(0)], [3, 'turnChoice', 0, move(0)]]);
    expect(cert.nodes[0]).toMatchObject({ observation: '', edges: { [cert.nodes[1]!.observation]: 1 } });
    // After Doze, counters 1 and 2 share one node. On turn 2 counter 1 wins (a leaf, no edge); counter 2 is the one edge.
    const asleep = onlyChild(arena, started(arena), move(0));
    const at = cert.nodes.filter((n) => n.observation === asleep.observation);
    expect(at).toHaveLength(1);
    const x = expandBelief(arena, asleep, move(0), OPTS);
    expect([x.leaves.map((l) => l.result), Object.keys(at[0]!.edges)]).toEqual([['win'], x.children.map((c) => c.edge)]);
    expect(cert.nodes[at[0]!.edges[x.children[0]!.edge]!]).toMatchObject({ observation: x.children[0]!.edge, edges: {} });
    const merged = proven(tableArena(MERGE), 4).cert;
    const xy = nodesAt(merged, 'XY');
    expect(xy).toHaveLength(1);
    expect([nodesAt(merged, 'A')[0]!.edges, nodesAt(merged, 'B')[0]!.edges].map(Object.values)).toEqual([[xy[0]!.id], [xy[0]!.id]]);
    // U-turn's mid-turn choice is a node: Tank is engine position 1 behind the Scout lead.
    expect(provenScenario(uturnLine).cert.nodes.map((n) => [n.phase, n.action, Object.values(n.edges)])).toEqual([
      ['entry', pick(0), [1]], ['turnChoice', move(0), [2]], ['playerMidTurnSwitch', pick(1), [3]], ['turnChoice', move(0), []],
    ]);
  });

  const stats = (minHpFrac: ReturnType<typeof rat>, totalHp: number, pp: number, turns: number, chanceDependencies: number, participants = [0]) =>
    ({ minHpFrac, totalHp, pp, turns, chanceDependencies, participants });
  it.each<[string, () => { arena: Arena; cert: Certificate }, object]>([
    ['twoSafeLines (deepening stops at Strike, Strike)', () => provenScenario(twoSafeLines), stats(rat(3, 5), 6, 18, 2, 0)],
    ['uturnLine (the mid-turn switch is a dependency)', () => provenScenario(uturnLine), stats(rat(3, 10), 12, 18, 2, 1, [0, 1])],
    // Tank leads and switches to the Scout, which dies: no win leaf, so the figures stay at the identity of min.
    ['a u-turn line with no win', () => policyOn(scenarioArena(uturnLine), () => pick(1)), stats(ONE, Infinity, Infinity, 1, 1, [0, 1])],
    ['G_1 (crit and normal turn 1: one branch point)', () => provenScenario(critOnlyBudget1, { params: { ...PARAMS, critBudget: 1 } }), stats(rat(1, 10), 1, 8, 2, 1)],
    ['G_0 (the walk never meets the dropped crit)', () => provenScenario(critOnlyBudget0, G0), stats(rat(1, 7), 1, 8, 2, 0)],
    // After X a chance point splits A from C (one branch point); after Y there is only B (none).
    ['branch points per enemy action', () => proven(tableArena({
      start: 'R',
      nodes: {
        R: { phase: 'turnChoice', p1: ['go'], ai: [{ name: 'X', p: HALF }, { name: 'Y', p: HALF }], next: { 'go|X': [{ to: 'A', p: HALF }, { to: 'C', p: HALF }], 'go|Y': [{ to: 'B', p: ONE }] } },
        A: go('win'), B: go('win'), C: go('win'), win: WIN,
      },
    }), 3), stats(ONE, 1, 0, 2, 1)],
    ['a gauntlet (the most turns in one fight, not the total)', () => proven(gauntletArena(), 4), stats(ONE, 1, 0, 3, 0)],
    // Bash's two rolls after a turn-1 miss are one branch point; after Bash 3 on turn 2 a miss is cut off.
    ['a risk line stops at its cut-offs', deadlyRollsRisk, stats(rat(1, 7), 1, 18, 2, 1)],
  ])('stats: %s', (_name, make, want) => {
    const { arena, cert } = make();
    expect(certificateStats(arena, cert)).toEqual(want);
  });

  it('round trip, and malformed text is refused', () => {
    const limits = { minHpFrac: { value: rat(1, 2), strict: true }, totalHp: { value: 6, strict: false } };
    const withThresholds = provenScenario(twoSafeLines, thresholds(limits)).cert;
    expect(withThresholds.thresholds).toEqual(limits);
    expect(JSON.parse(serializeCertificate(withThresholds)).thresholds).toEqual({ minHpFrac: { value: '1/2', strict: true }, totalHp: { value: 6, strict: false } });
    const certs = [
      provenScenario(hiddenCounterSafe).cert, provenScenario(uturnLine).cert, withThresholds,
      provenScenario(critOnlyBudget1, { params: { ...PARAMS, critBudget: 1 } }).cert, proven(gauntletArena(), 4).cert, deadlyRollsRisk().cert,
    ];
    for (const [i, c] of certs.entries()) {
      const text = serializeCertificate(c);
      expect(parseCertificate(text), `certificate ${i}`).toEqual(c);
      expect(serializeCertificate(parseCertificate(text)), `certificate ${i}`).toBe(text);
    }
    const good = JSON.parse(serializeCertificate(certs[0]!)) as { nodes: { id: number; edges: Record<string, number> }[] };
    const node1 = (change: object) => ({ ...good, nodes: good.nodes.map((n, i) => (i === 1 ? { ...n, ...change } : n)) });
    const broken: unknown[] = [
      { ...good, kind: 'maybe' }, { ...good, nodes: [] }, { ...good, horizon: 0 }, { ...good, critBudget: -1 },
      { ...good, nodes: good.nodes.map((n) => ({ ...n, id: 0 })) }, node1({ edges: { x: 99 } }), node1({ action: { kind: 'move' } }),
      { ...good, thresholds: { minHpFrac: { value: 'half', strict: true } } },
    ];
    for (const [i, b] of broken.entries()) expect(() => parseCertificate(JSON.stringify(b)), `broken ${i}`).toThrow(SyntaxError);
  });

  it('missing or unusable table entries are re-proved', () => {
    for (const make of [() => provenScenario(hiddenCounterSafe), () => provenScenario(uturnLine), () => provenScenario(twoSafeLines), () => proven(gauntletArena(), 4)]) {
      const { prover, root, horizon, cert } = make();
      prover.tt.clear();
      expect(extractProof(prover, root, horizon)).toEqual(cert);
      expect(prover.tt.size).toBeGreaterThan(0);
    }
    // Too deep: C's slow entry serves T → A → C, but T → B → B2 → C has 1 turn left: C is re-proved (fast), D unreachable.
    const sf = proven(tableArena(SLOW_FAST), 4);
    expect([sf.horizon, nodesAt(sf.cert, 'C').map((n) => n.action), nodesAt(sf.cert, 'D')]).toEqual([4, [move(1)], []]);
    const t = onlyChild(sf.arena, sf.root, pick(0));
    const [a, b] = [childAt(sf.arena, t, move(0), 'A'), childAt(sf.arena, t, move(0), 'B')];
    const c = onlyChild(sf.arena, a, move(0));
    const hand = proverFor(sf.arena);
    const entries: [Belief, number][] = [[sf.root, 4], [t, 4], [a, 3], [b, 3], [onlyChild(sf.arena, b, move(0)), 2], [c, 2], [onlyChild(sf.arena, c, move(0)), 1]];
    for (const [belief, depth] of entries) hand.tt.put(belief.key, { kind: 'win', depth, H: 4, action: belief === sf.root ? pick(0) : move(0) });
    expect(extractProof(hand, sf.root, 4)).toEqual(sf.cert);
    expect(hand.tt.get(c.key)).toEqual({ kind: 'win', depth: 1, H: 4, action: move(1) });
    // Too late: an entry proven with a larger per-fight horizon (short, H 9) stays in the table but is not valid at 3.
    const g = proven(gauntletArena(), 4);
    const s = onlyChild(g.arena, g.root, pick(0));
    const late = proverFor(g.arena);
    late.tt.put(s.key, { kind: 'win', depth: 2, H: 9, action: move(1) });
    expect(extractProof(late, g.root, 3)).toEqual(g.cert);
    expect([late.tt.get(s.key), late.H]).toEqual([{ kind: 'win', depth: 2, H: 9, action: move(1) }, 0]);   // H restored
    const short = tableArena(SLOW_FAST);
    expect(() => extractProof(proverFor(short), rootBelief(short), 3)).toThrow(/not won/);
  });

  it('risk certificates key nodes by belief, weights and turns left', () => {
    // S repeats (table keys omit the turn): wait while more than one turn is left, then go. A turn with none left is never asked.
    const loop = (): Arena => tableArena({
      start: 'S', nodes: { S: { phase: 'turnChoice', p1: ['wait', 'go'], next: { 'wait|': [{ to: 'S', p: ONE }], 'go|': [{ to: 'win', p: ONE }] } }, win: WIN },
    });
    const arena = loop();
    const root = rootBelief(arena);
    const asked: number[] = [];
    const cert = certificateFromPolicy(arena, root, (bel, h) => {
      asked.push(h);
      return bel.phase === 'entry' ? pick(0) : h > 1 ? move(0) : move(1);
    }, riskOpts(3));
    expect(cert).toMatchObject({ kind: 'risk', level: 1, mode: 'display', horizon: 3, critBudget: null, thresholds: null, engineId: 'table-engine@1', aiId: 'table-ai@1', fights: 1 });
    expect(cert.nodes.map((n) => [n.phase, n.action, Object.values(n.edges)])).toEqual([
      ['entry', pick(0), [1]], ['turnChoice', move(0), [2]], ['turnChoice', move(0), [3]], ['turnChoice', move(1), []],
    ]);
    expect(asked).toEqual([3, 3, 2, 1]);
    expect(proven(loop(), 3).cert.nodes.map((n) => n.action)).toEqual([pick(0), move(1)]);   // the proof has one node for S
    // A null answer is a cut-off: no node, no edge. At the root it leaves nothing to certify.
    const stops = certificateFromPolicy(arena, root, (bel, h) => (bel.phase === 'entry' ? pick(0) : h === 3 ? move(0) : null), riskOpts(3));
    expect(stops.nodes.map((n) => n.edges)).toEqual([{ [stops.nodes[1]!.observation]: 1 }, {}]);
    expect(() => certificateFromPolicy(arena, root, () => null, riskOpts(3))).toThrow(/root/);
    // The same two members with other weights are two risk nodes (one proof node).
    const always = (bel: Belief): Choice => (bel.phase === 'entry' ? pick(0) : move(0));
    expect([nodesAt(policyOn(tableArena(MERGE), always).cert, 'XY').length, nodesAt(proven(tableArena(MERGE), 3).cert, 'XY').length]).toEqual([2, 1]);
    // RAM mode keys edges by the member too: each sleep counter gets its own node after Doze.
    const ram = policyOn(scenarioArena(hiddenCounterSafe), always, 3, 'ram').cert;
    expect([ram.mode, ram.nodes.length, Object.keys(ram.nodes[1]!.edges).length]).toEqual(['ram', 5, 2]);
  });
});
