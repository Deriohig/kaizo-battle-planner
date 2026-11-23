import { describe, expect, it } from 'vitest';
import type { Choice, Engine } from '../../../src/contracts/engine.js';
import type { PlanLeaf, PlanNode } from '../../../src/contracts/solver.js';
import type { Arena } from '../../../src/solver/arena.js';
import { rootBelief } from '../../../src/solver/belief.js';
import { certificateFromPolicy, extractProof, type Certificate } from '../../../src/solver/certificate.js';
import { DEFAULT_RANKING } from '../../../src/solver/config.js';
import type { ArenaFight } from '../../../src/solver/inputs.js';
import { defaultLabeler } from '../../../src/solver/labeler.js';
import { enemyBranchLabel, renderPlan, type RenderedPlan } from '../../../src/solver/plan.js';
import { Prover } from '../../../src/solver/prove.js';
import { cmp, ONE, rat, sum } from '../../../src/solver/rational.js';
import { solveRisk } from '../../../src/solver/risk.js';
import type { PlanLabeler } from '../../../src/solver/types.js';
import { createToyAi } from './toy/ai.js';
import { createToyEngine } from './toy/engine.js';
import { makeArena, scenarioFights, tableFights } from './toy/fixtures.js';
import { aiUndefined, critOnlyBudget0, critOnlyBudget1, deadlyRolls, replacementTie, safe1v1, stall, TABLES, uturnLine, type Scenario } from './toy/scenarios.js';
import { tableGame, type TableSpec } from './toy/table.js';

type Tree = PlanNode | PlanLeaf;
interface Line { arena: Arena; cert: Certificate }

const HALF = rat(1, 2);
const NONE = { kind: 'none' } as const;
const BASH = 'If the AI uses move 1';
const lead = (index: number): Choice => ({ kind: 'switch', index });
const move = (slot: number): Choice => ({ kind: 'move', slot });
const isLeaf = (x: Tree): x is PlanLeaf => 'result' in x;
const win = (...endHp: number[]): PlanLeaf => ({ result: 'win', endHp, endStatus: endHp.map(() => NONE) });

function arenaOf(s: Scenario, opts: { fights?: ArenaFight[]; engine?: Engine; maxLeaves?: number } = {}): Arena {
  return makeArena(opts.fights ?? scenarioFights(s), opts.engine ?? createToyEngine(s.registry), createToyAi(s.registry), { maxLeaves: opts.maxLeaves });
}

/** solveRisk's line on `arena` at the scenario's horizon (tiers 2 and 3). */
function riskLine(s: Scenario, arena = arenaOf(s)): Line {
  const r = solveRisk(arena, rootBelief(arena), {
    horizon: s.horizon, ranking: DEFAULT_RANKING, mode: 'display', deadline: Number.POSITIVE_INFINITY, now: () => 0, labeler: defaultLabeler, history: new Map(),
  });
  if (r.kind !== 'line') throw new Error(`${s.name}: expected a line, got ${r.kind}`);
  return { arena, cert: r.certificate };
}

/** The tier-1 proof of `s` (it must win). */
function proofLine(s: Scenario, arena = arenaOf(s)): Line {
  const prover = new Prover(arena, {
    params: { level: 1, critBudget: null, thresholds: null }, mode: 'display', deadline: Number.POSITIVE_INFINITY, now: () => 0, labeler: defaultLabeler, history: new Map(),
  });
  const root = rootBelief(arena);
  const { result, horizon } = prover.deepen(root, s.horizon);
  expect(result.kind).toBe('win');
  return { arena, cert: extractProof(prover, root, horizon) };
}

/** A table game played with each decision's first choice as a risk line. */
function tableLine(spec: TableSpec, horizon: number): Line {
  const t = tableGame(spec);
  const arena = makeArena(tableFights(t), t.engine, t.ai);
  return { arena, cert: certificateFromPolicy(arena, rootBelief(arena), (b) => (b.phase === 'entry' ? lead(0) : move(0)), { level: 1, mode: 'display', horizon, critBudget: null }) };
}

const render = (line: Line, nodeLimit = 20_000, labeler: PlanLabeler = defaultLabeler): RenderedPlan => renderPlan(line.arena, line.cert, { labeler, nodeLimit });
const nodesOf = (x: Tree): PlanNode[] => (isLeaf(x) ? [] : [x, ...x.branches.flatMap((b) => nodesOf(b.next))]);
const ofKind = (x: Tree, kind: PlanNode['kind']): PlanNode[] => nodesOf(x).filter((n) => n.kind === kind);
const labelled = (n: PlanNode): [string, unknown][] => n.branches.map((b) => [b.label, b.probability]);

/** Every leaf with the branch labels from the root, depth first in branch order. */
function leavesOf(x: Tree, path: string[] = []): { leaf: PlanLeaf; path: string[] }[] {
  return isLeaf(x) ? [{ leaf: x, path }] : x.branches.flatMap((b) => leavesOf(b.next, [...path, b.label]));
}

/** branches[0] from the root to a leaf: the labels, node kinds and the leaf. */
function mainPath(tree: PlanNode): { labels: string[]; kinds: string[]; leaf: PlanLeaf } {
  const labels: string[] = [];
  const kinds: string[] = [];
  let at: Tree = tree;
  for (; !isLeaf(at); at = at.branches[0]!.next) {
    kinds.push(at.kind);
    labels.push(at.branches[0]!.label);
  }
  return { labels, kinds, leaf: at };
}

/** Follows `labels` from the root, as the page does: at each depth the first branch with that label. */
function follow(tree: PlanNode, labels: string[]): Tree {
  let at: Tree = tree;
  for (const label of labels) {
    const next: Tree | undefined = isLeaf(at) ? undefined : at.branches.find((b) => b.label === label)?.next;
    if (next === undefined) throw new Error(`no branch ${JSON.stringify(label)} on ${JSON.stringify(labels)}`);
    at = next;
  }
  return at;
}

/** The death paths are `expected`, and each leads to a death leaf. */
function expectDeathPaths(plan: RenderedPlan, expected: Record<string, string[]>): void {
  expect(plan.deathPaths).toEqual(expected);
  for (const path of Object.values(plan.deathPaths)) expect(follow(plan.tree, path)).toEqual({ result: 'death' });
}

// The default labeler with no words for any outcome: every chance branch starts out labelled ''.
const silent: PlanLabeler = { ...defaultLabeler, outcome: () => '' };
// Names the AI's move slots 0 and 1 'Zap' and 'Bite' (the reverse of their alphabetical order).
const naming: PlanLabeler = {
  ...defaultLabeler, choice: (state, side, c) => (side === 'p2' && c.kind === 'move' ? `Use ${['Zap', 'Bite'][c.slot]}` : defaultLabeler.choice(state, side, c)),
};

// replacementTie's trainer against a 7 HP Hero: Hero KOs Imp, then Mouse or Tiger comes in. Tiger's crit Maul kills,
// on turn 2 when Tiger came in first, on turn 3 after Mouse.
const sendInKills: Scenario = {
  name: 'sendInKills', p1: ['Hero'], trainerId: 'sendInKills', horizon: 3, expect: {},
  registry: {
    mons: { Hero: { name: 'Hero', maxHp: 7, speed: 15, moves: [{ name: 'Strike', damage: [5] }] } },
    trainers: { sendInKills: { id: 'sendInKills', party: replacementTie.registry.trainers.replacementTie!.party } },
    observeAll: true,
  },
};

// S → M, a mid-turn switch: half the time the enemy then picks a replacement (A 1/4, B 3/4); otherwise play goes on to T.
const REPLACE: TableSpec = {
  start: 'S',
  nodes: {
    S: { phase: 'turnChoice', p1: ['u'], next: { 'u|': [{ to: 'M', p: ONE }] } },
    M: { phase: 'playerMidTurnSwitch', p1: ['sw'], next: { 'sw|': [{ to: 'E', p: HALF }, { to: 'T', p: HALF }] } },
    E: { phase: 'enemyReplacement', ai: [{ name: 'A', p: rat(1, 4) }, { name: 'B', p: rat(3, 4) }], next: { '|A': [{ to: 'win', p: ONE }], '|B': [{ to: 'win', p: ONE }] } },
    T: { phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to: 'win', p: ONE }] } },
    win: { phase: 'win', next: {} },
  },
};

// S → X (1/4) or Y (3/4), which look alike: one edge; the table labels each target 'S to=<target>'.
const LOOK_ALIKE: TableSpec = {
  start: 'S',
  nodes: {
    S: { phase: 'turnChoice', p1: ['go'], next: { 'go|': [{ to: 'X', p: rat(1, 4) }, { to: 'Y', p: rat(3, 4) }] } },
    X: { phase: 'turnChoice', obs: 'XY', p1: ['go'], next: { 'go|': [{ to: 'win', p: ONE }] } },
    Y: { phase: 'turnChoice', obs: 'XY', p1: ['go'], next: { 'go|': [{ to: 'win', p: ONE }] } },
    win: { phase: 'win', next: {} },
  },
};

describe('plan', () => {
  it('orders branches by probability, then by label, with the main path first', () => {
    // critOnlyBudget1: Bash crits 1/4 each turn; Hero (10) dies only after two crits.
    const { tree } = render(riskLine(critOnlyBudget1));
    const nodes = nodesOf(tree);
    expect(nodes).toHaveLength(11);
    for (const n of nodes) {
      expect(sum(n.branches.map((b) => b.probability))).toEqual(ONE);
      for (let i = 1; i < n.branches.length; i++) expect(cmp(n.branches[i - 1]!.probability, n.branches[i]!.probability)).toBeGreaterThanOrEqual(0);
    }
    expect(labelled(ofKind(tree, 'chance')[1]!)).toEqual([['If bash normal', rat(3, 4)], ['If bash crit', rat(1, 4)]]);
    expect(mainPath(tree)).toEqual({
      labels: ['', '', '', BASH, 'If bash normal', '', BASH, 'If bash normal'],
      kinds: ['player', 'chance', 'player', 'enemy', 'chance', 'player', 'enemy', 'chance'], leaf: win(4),
    });
    // coinFlip's AI picks X (Zap) or Y (Bite) at 1/2 each: Bite sorts first.
    const enemy = ofKind(render(tableLine(TABLES.coinFlip, 2), 20_000, naming).tree, 'enemy')[0]!;
    expect(labelled(enemy)).toEqual([['If the AI uses Bite', HALF], ['If the AI uses Zap', HALF]]);
    expect(enemy.branches.map((b) => leavesOf(b.next).map((l) => l.leaf.result))).toEqual([['death'], ['win']]);
  });

  it('leaves carry end HP and status in canonical team order; a win keeps its end state apart with no outcome words', () => {
    expect(leavesOf(render(proofLine(safe1v1)).tree)).toEqual([{ leaf: win(10), path: ['', '', '', BASH, ''] }]);
    for (const labeler of [defaultLabeler, silent]) {
      const leaves = leavesOf(render(riskLine(critOnlyBudget1), 20_000, labeler).tree).map((l) => l.leaf);
      expect(leaves).toEqual([win(4), win(1), win(1), { result: 'death' }]);
    }
    expect(labelled(ofKind(render(riskLine(critOnlyBudget1), 20_000, silent).tree, 'chance')[2]!)).toEqual([['', rat(3, 4)], [' (2)', rat(1, 4)]]);
    expect(leavesOf(render(proofLine(uturnLine)).tree).map((l) => l.leaf)).toEqual([win(6, 6)]);   // Scout 6/6, Tank 6/20
  });

  it('deaths and cut-offs show; an undefined AI support is an unlabelled death with no death path', () => {
    expect(Object.keys(render(riskLine(deadlyRolls)).deathPaths).sort()).toEqual(['bash on turn 2 kills party 0', 'bash on turn 3 kills party 0']);
    const still = render(riskLine(stall));   // a speed tie every turn: 2 × 2 × 2 lines cut off after 3 turns
    expect([leavesOf(still.tree).map((l) => l.leaf), still.deathPaths]).toEqual([Array.from({ length: 8 }, () => ({ result: 'cutoff' })), {}]);
    const undef = render(riskLine(aiUndefined));
    expect(mainPath(undef.tree)).toEqual({ labels: ['', '', '', 'unmodelled'], kinds: ['player', 'chance', 'player', 'chance'], leaf: { result: 'death' } });
    expect(undef.deathPaths).toEqual({});
  });

  it('truncates past the node limit, and an engine LIMIT renders as a truncated branch', () => {
    const line = riskLine(critOnlyBudget1);
    const cut = render(line, 3);
    expect([nodesOf(cut.tree).map((n) => n.kind), leavesOf(cut.tree), cut.deathPaths]).toEqual([['player', 'chance', 'player'], [{ leaf: { result: 'truncated' }, path: ['', '', ''] }], {}]);
    // Eight nodes down the main path, then its two win leaves and turn 1's crit branch are cut.
    const eight = render(line, 8);
    expect(nodesOf(eight.tree)).toHaveLength(8);
    expect(leavesOf(eight.tree).map((l) => [l.leaf.result, l.path.length, l.path.at(-1)])).toEqual([
      ['truncated', 8, 'If bash normal'], ['truncated', 8, 'If bash crit'], ['truncated', 5, 'If bash crit'],
    ]);
    expect(leavesOf(render(line).tree).some((l) => l.leaf.result === 'truncated')).toBe(false);
    expect(() => render(line, 0)).toThrow(RangeError);
    const limit = { label: 'engine limit', probability: ONE, next: { result: 'truncated' } };
    // maxLeaves 1: every turn-1 choice hits LIMIT; the risk line keeps a node without edges.
    const turn1 = ofKind(render(riskLine(deadlyRolls, arenaOf(deadlyRolls, { maxLeaves: 1 }))).tree, 'player')[1]!;
    expect([turn1.actionLabel, turn1.branches]).toEqual(['Use move 1', [limit]]);
    // Every lead limited at battle start: the root itself.
    const noStart: Engine = { ...createToyEngine(deadlyRolls.registry), createBattle: () => { throw Object.assign(new Error('toy: limit at battle start'), { code: 'LIMIT' }); } };
    expect(render(riskLine(deadlyRolls, arenaOf(deadlyRolls, { engine: noStart }))).tree).toEqual({ observation: '', kind: 'player', action: lead(0), actionLabel: 'Lead with Hero', branches: [limit] });
  });

  it.each<{ choice: Choice; text: string; replacement: boolean; label: string }>([
    { choice: move(0), text: 'Use Rock Slide', replacement: false, label: 'If the AI uses Rock Slide' },
    { choice: lead(2), text: 'Switch to Golem', replacement: false, label: 'If the AI switches to Golem' },
    { choice: { kind: 'item', item: 'full-restore' }, text: 'Use Full Restore', replacement: false, label: 'If the AI uses a Full Restore' },
    { choice: lead(2), text: 'Switch to Golem', replacement: true, label: 'If the AI sends in Golem' },
  ])('enemy branch label: $label', ({ choice, text, replacement, label }) => {
    expect(enemyBranchLabel(choice, text, replacement)).toBe(label);
  });

  it('labels read as conditions and siblings never share one', () => {
    const trees = [render(riskLine(critOnlyBudget1)).tree, render(riskLine(deadlyRolls)).tree, render(proofLine(uturnLine)).tree];
    for (const tree of trees) for (const p of ofKind(tree, 'player')) expect(labelled(p)).toEqual([['', ONE]]);
    // Scout leads, Volts and U-turns into Tank; after the mid-turn switch no successor has an AI choice, so no enemy node.
    expect(ofKind(trees[2]!, 'player').map((n) => [n.actionLabel, n.action, (n.branches[0]!.next as PlanNode).kind])).toEqual([
      ['Lead with Scout', lead(0), 'chance'], ['Use move 1', move(0), 'enemy'], ['Switch to party 2', lead(1), 'chance'], ['Use move 1', move(0), 'enemy'],
    ]);
    // After a mid-turn step the AI's first choice may be a replacement; successors without an AI choice get ''.
    const mid = ofKind(render(tableLine(REPLACE, 3)).tree, 'player')[2]!;
    expect(labelled(mid.branches[0]!.next as PlanNode)).toEqual([['', HALF], ['If the AI sends in move 2', rat(3, 8)], ['If the AI sends in move 1', rat(1, 8)]]);
    // A chance branch is named by its most probable successor: X and Y look alike, one edge labelled by Y.
    expect(labelled(ofKind(render(tableLine(LOOK_ALIKE, 3)).tree, 'chance')[1]!)).toEqual([['If S to=Y', ONE]]);
    // replacementTie: chance labels name the whole turn and the send-in.
    const tie = render(proofLine(replacementTie)).tree;
    expect(ofKind(tie, 'chance').map((n) => n.branches.map((b) => b.label))).toEqual([
      [''], ['The AI sends in party 2', 'The AI sends in party 3'], ['The AI sends in party 3'], ['If maul normal', 'If maul crit'],
      ['If maul normal, then the AI sends in party 2', 'If maul crit, then the AI sends in party 2'], [''], [''],
    ]);
    const still = render(riskLine(stall)).tree;   // either order of the speed tie reads 'If glare first'
    expect(ofKind(still, 'chance')[1]!.branches.map((b) => b.label)).toEqual(['If glare first', 'If glare first (2)']);
    for (const tree of [...trees, tie, still, render(riskLine(sendInKills)).tree, render(riskLine(critOnlyBudget0), 20_000, silent).tree]) {
      for (const n of nodesOf(tree)) expect(new Set(n.branches.map((b) => b.label)).size).toBe(n.branches.length);
    }
  });

  it('death paths follow the tree to the most probable death of each cause', () => {
    const crit = render(riskLine(critOnlyBudget1));
    expectDeathPaths(crit, { 'enemy crit bash on turn 2 kills party 0': ['', '', '', BASH, 'If bash crit', '', BASH, 'If bash crit'] });
    expect(leavesOf(crit.tree).filter((l) => l.leaf.result === 'death').map((l) => l.path)).toEqual(Object.values(crit.deathPaths));
    // deadlyRolls: the turn-2 death after Bash 4 and a miss (1/4) beats the one met first, after Bash 3 and a miss.
    expectDeathPaths(render(riskLine(deadlyRolls)), {
      'bash on turn 2 kills party 0': ['', '', '', BASH, 'If bash dmg=4, gamble miss', '', BASH, 'If bash dmg=3'],
      'bash on turn 3 kills party 0': ['', '', '', BASH, 'If bash dmg=3, gamble miss', '', BASH, 'If bash dmg=3, gamble miss', '', BASH, 'If bash dmg=3'],
    });
    // A kill after a send-in names the mon that came in, at its own depth.
    expectDeathPaths(render(riskLine(sendInKills)), {
      'enemy crit maul on turn 2 kills party 0': ['', '', '', BASH, 'The AI sends in party 3', '', BASH, 'If maul crit'],
      'enemy crit maul on turn 3 kills party 0': ['', '', '', BASH, 'The AI sends in party 2', '', BASH, 'The AI sends in party 3', '', BASH, 'If maul crit'],
    });
    // A death's key holds its cause: with no outcome words, after a turn-1 crit both turn-2 Bashes kill, two branches.
    const quiet = render(riskLine(critOnlyBudget0), 20_000, silent);
    expect((follow(quiet.tree, ['', '', '', BASH, ' (2)', '', BASH]) as PlanNode).branches.map((b) => [b.label, b.probability, b.next])).toEqual([
      ['', rat(3, 4), { result: 'death' }], [' (2)', rat(1, 4), { result: 'death' }],
    ]);
    expectDeathPaths(quiet, {
      'bash on turn 2 kills party 0': ['', '', '', BASH, ' (2)', '', BASH, ''],
      'enemy crit bash on turn 2 kills party 0': ['', '', '', BASH, '', '', BASH, ' (2)'],
    });
  });
});
