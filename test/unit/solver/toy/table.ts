// A game given as a table of named states, for exact tests of search logic (quantifiers, repetition, caching), behind
// the Engine and EnemyModel contracts.
//
// RULES
//
// State: canonical JSON of { name, turn, dead }; `key` = keyOf(name) ?? name (no turn, so positions repeat); `turn`
// goes up by 1 after each turnChoice step; a faintP1 outcome sets `dead`. 'win' / 'lose' are terminal for p1 / p2.
// Choices are { move, slot: index } into `p1` (turnChoice, playerMidTurnSwitch) or `ai` (turnChoice, enemyReplacement);
// a node without `ai` gives the AI one dummy choice. expandTurn returns next[`${p1}|${ai}`] (a side that does not choose
// gives '') in order, with critBy.p2 = critP2, fainted.p1 = [0] after faintP1, log [], and observation = the target's
// `obs` (default its name); several entries carry pick labels (source the state, outcome 'to=<target>', '#<i>' when a
// target repeats). Illegal choices and terminal steps throw BAD_CHOICE. Specs are checked when built: known states,
// p1/ai only at their phases, unique names, exactly the phase's keys, probabilities > 0 summing to ONE, no repeats.
// carryOut: one mon at hp 1 (0 once dead). The AI's memory is { key: '', data: null } and never changes.

import type { ActionSupport, AiMemory, EnemyModel } from '../../../../src/contracts/ai.js';
import type { BattleInput, CarryState, ChanceLabel, Choice, Engine, EngineState, Outcome, Phase, Rational, Side } from '../../../../src/contracts/engine.js';
import { cmp, eq, ONE, sum, ZERO } from '../../../../src/solver/rational.js';
import { canonical } from './engine.js';
import { toyPlayerMon, toyTrainer } from './helpers.js';

export interface TableNode {
  phase: 'turnChoice' | 'playerMidTurnSwitch' | 'enemyReplacement' | 'win' | 'lose';
  obs?: string;                                                   // observation; default the state name (full information)
  p1?: string[];                                                  // the player's choice names (Choice { kind: 'move', slot: index })
  ai?: { name: string; p: Rational }[];                           // AI support at turnChoice / enemyReplacement (the p2 choice is { kind: 'move', slot: index })
  next: Record<string, { to: string; p: Rational; critP2?: boolean; faintP1?: boolean; unlabelled?: boolean }[]>; // key `${p1}|${ai}`, `${p1}|` or `|${ai}`
}
export interface TableSpec { start: string; nodes: Record<string, TableNode>; keyOf?: (state: string) => string }

interface TableState { name: string; turn: number; dead: boolean }

const DUMMY_AI = [{ name: '', p: ONE }];
const P1_PHASES: readonly TableNode['phase'][] = ['turnChoice', 'playerMidTurnSwitch'];
const AI_PHASES: readonly TableNode['phase'][] = ['turnChoice', 'enemyReplacement'];

function badChoice(message: string): Error {
  return Object.assign(new Error(`table engine: ${message}`), { code: 'BAD_CHOICE' as const });
}

function phaseOf(node: TableNode): Phase {
  if (node.phase === 'win') return { kind: 'terminal', winner: 'p1' };
  if (node.phase === 'lose') return { kind: 'terminal', winner: 'p2' };
  return { kind: node.phase };
}

/** The player's names at this node ([] when he does not choose) and the AI's names ([] when it does not choose). */
function namesOf(node: TableNode): { p1: string[]; ai: string[] } {
  return {
    p1: P1_PHASES.includes(node.phase) ? node.p1 ?? [] : [],
    ai: AI_PHASES.includes(node.phase) ? (node.ai ?? DUMMY_AI).map((a) => a.name) : [],
  };
}

function expectedKeys(node: TableNode): string[] {
  const { p1, ai } = namesOf(node);
  if (node.phase === 'win' || node.phase === 'lose') return [];
  const p1s = p1.length > 0 ? p1 : [''];
  const ais = ai.length > 0 ? ai : [''];
  return p1s.flatMap((a) => ais.map((b) => `${a}|${b}`));
}

const fmt = (r: Rational): string => `${r.num}/${r.den}`;

function checkSpec(spec: TableSpec): void {
  const fail = (message: string): never => {
    throw new Error(`table game: ${message}`);
  };
  if (spec.nodes[spec.start] === undefined) fail(`unknown start state ${spec.start}`);
  for (const [name, node] of Object.entries(spec.nodes)) {
    const at = `state ${name}`;
    const p1Phase = P1_PHASES.includes(node.phase);
    const aiPhase = AI_PHASES.includes(node.phase);
    if (p1Phase && (node.p1 === undefined || node.p1.length === 0)) fail(`${at}: ${node.phase} needs p1 choices`);
    if (!p1Phase && node.p1 !== undefined) fail(`${at}: p1 choices at ${node.phase}`);
    if (!aiPhase && node.ai !== undefined) fail(`${at}: AI support at ${node.phase}`);
    if (node.p1 !== undefined && new Set(node.p1).size !== node.p1.length) fail(`${at}: repeated p1 names`);
    if (node.ai !== undefined) {
      if (node.ai.length === 0) fail(`${at}: empty AI support`);
      if (new Set(node.ai.map((a) => a.name)).size !== node.ai.length) fail(`${at}: repeated AI names`);
      for (const a of node.ai) if (cmp(a.p, ZERO) <= 0) fail(`${at}: AI choice ${a.name} has probability ${fmt(a.p)}`);
      const total = sum(node.ai.map((a) => a.p));
      if (!eq(total, ONE)) fail(`${at}: AI support sums to ${fmt(total)}`);
    }
    const expected = expectedKeys(node);
    for (const key of expected) if (node.next[key] === undefined) fail(`${at}: no outcomes for key '${key}'`);
    for (const [key, outcomes] of Object.entries(node.next)) {
      if (!expected.includes(key)) fail(`${at}: key '${key}' matches no choice`);
      if (outcomes.length === 0) fail(`${at}: key '${key}' has no outcomes`);
      for (const o of outcomes) {
        if (spec.nodes[o.to] === undefined) fail(`${at}: key '${key}' leads to unknown state ${o.to}`);
        if (cmp(o.p, ZERO) <= 0) fail(`${at}: key '${key}' outcome ${o.to} has probability ${fmt(o.p)}`);
      }
      const total = sum(outcomes.map((o) => o.p));
      if (!eq(total, ONE)) fail(`${at}: key '${key}' outcomes sum to ${fmt(total)}`);
      const ids = outcomes.map((o) => `${o.to}|${Boolean(o.critP2)}|${Boolean(o.faintP1)}|${Boolean(o.unlabelled)}`);
      if (new Set(ids).size !== ids.length) fail(`${at}: key '${key}' repeats an outcome`);
    }
  }
}

export function tableGame(spec: TableSpec): { engine: Engine; ai: EnemyModel; input: BattleInput } {
  checkSpec(spec);
  const nodeOf = (name: string): TableNode => spec.nodes[name]!;
  const read = (state: EngineState): TableState => JSON.parse(state.json) as TableState;
  const stateOf = (t: TableState): EngineState => ({ json: canonical(t), turn: t.turn, phase: phaseOf(nodeOf(t.name)), key: spec.keyOf?.(t.name) ?? t.name });
  const obsOf = (name: string): string => nodeOf(name).obs ?? name;
  const legal = (state: EngineState, side: Side): Choice[] => {
    const names = namesOf(nodeOf(read(state).name));
    return (side === 'p1' ? names.p1 : names.ai).map((_, slot) => ({ kind: 'move', slot }));
  };
  const supportAt = (state: EngineState): ActionSupport[] => {
    const node = nodeOf(read(state).name);
    if (!AI_PHASES.includes(node.phase)) return [];
    return (node.ai ?? DUMMY_AI).map((a, slot) => ({ choice: { kind: 'move', slot }, probability: a.p }));
  };

  const engine: Engine = {
    id: 'table-engine@1',

    createBattle(): EngineState {
      return stateOf({ name: spec.start, turn: 1, dead: false });
    },

    legalChoices: legal,

    expandTurn(state: EngineState, choices: { p1?: Choice; p2?: Choice }): Outcome[] {
      const t = read(state);
      const node = nodeOf(t.name);
      if (node.phase === 'win' || node.phase === 'lose') throw badChoice(`state ${t.name} is terminal`);
      const names = namesOf(node);
      const part = (side: Side, list: string[]): string => {
        const c = choices[side];
        if (list.length === 0) {
          if (c !== undefined) throw badChoice(`${side} has no choice at ${t.name}`);
          return '';
        }
        if (c?.kind !== 'move' || list[c.slot] === undefined) throw badChoice(`${side} choice ${JSON.stringify(c)} is not legal at ${t.name}`);
        return list[c.slot]!;
      };
      const key = `${part('p1', names.p1)}|${part('p2', names.ai)}`;
      const entries = node.next[key]!;
      const turn = t.turn + (node.phase === 'turnChoice' ? 1 : 0);
      return entries.map((e, i): Outcome => {
        const repeated = entries.filter((x) => x.to === e.to).length > 1;
        const labels: ChanceLabel[] = entries.length > 1
          ? [{ kind: 'pick', side: null, source: t.name, outcome: `to=${e.to}${repeated ? `#${i}` : ''}` }]
          : [];
        return {
          probability: e.p, labels, critBy: { p1: false, p2: Boolean(e.critP2) }, unlabelled: Boolean(e.unlabelled),
          state: stateOf({ name: e.to, turn, dead: t.dead || Boolean(e.faintP1) }), observation: obsOf(e.to), log: [],
          fainted: { p1: e.faintP1 ? [0] : [], p2: [] }, merged: 1,
        };
      });
    },

    observe(state: EngineState): string {
      return obsOf(read(state).name);
    },

    carryOut(state: EngineState): CarryState {
      return { mons: [{ hp: read(state).dead ? 0 : 1, pp: [], status: { kind: 'none' } }] };
    },

    unmodelledIn(): string[] {
      return [];
    },
  };

  const memory: AiMemory = { key: '', data: null };
  const ai: EnemyModel = {
    id: 'table-ai@1',
    initialMemory: () => memory,
    support: supportAt,
    replacementSupport: supportAt,
    remember: (m) => m,
  };

  const input: BattleInput = { player: [toyPlayerMon('table')], trainer: toyTrainer('table'), field: {} };
  return { engine, ai, input };
}
