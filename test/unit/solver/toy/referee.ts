// The referee: a deliberately naive solver the solver tests are checked against. No table, memo or beliefs: it walks
// exact states (full information, like RAM mode), ORs over leads, plays level 1 (the AI's support) in one world and
// recomputes everything. Slow by design; keep its fights tiny.
//
// RULES
//
// A step fails on an outcome with a p1 faint or unlabelled; a state fails at playerReplacement, a p2 win, or a
// turnChoice with no turns left. `horizon` counts turnChoice steps only. Quantifiers: turnChoice → the player picks
// (OR / min), then the AI's support and every outcome (AND / expectation); playerMidTurnSwitch → the player picks, then
// every outcome; enemy replacements → replacementSupport, then every outcome. Memory is folded after every step.
// refCritBudget: G_j drops critBy.p2 outcomes once j crit steps happened on the path. unmodelledIn() is not consulted.

import type { AiMemory, EnemyModel } from '../../../../src/contracts/ai.js';
import type { BattleInput, Choice, Engine, EngineState, Outcome, Rational } from '../../../../src/contracts/engine.js';
import { add, minR, mul, ONE, ZERO } from '../../../../src/solver/rational.js';
import { createToyAi } from './ai.js';
import { createToyEngine } from './engine.js';
import { toyInput } from './helpers.js';
import type { Scenario } from './scenarios.js';
import { tableGame, type TableSpec } from './table.js';

export interface RefFight { engine: Engine; ai: EnemyModel; leads: BattleInput[]; horizon: number }   // one BattleInput per lead

/** One BattleInput per lead (the lead first, the others in their original order), in `s.worlds[0]` when given. */
export function refFightOf(s: Pick<Scenario, 'registry' | 'p1' | 'trainerId' | 'horizon' | 'worlds'>): RefFight {
  const world = s.worlds?.[0];
  return {
    engine: createToyEngine(s.registry),
    ai: createToyAi(s.registry),
    leads: s.p1.map((lead, i) => toyInput(s.registry, [lead, ...s.p1.filter((_, k) => k !== i)], s.trainerId, world === undefined ? undefined : { world })),
    horizon: s.horizon,
  };
}

/** A table game as a referee fight (one lead). */
export function refFightOfTable(spec: TableSpec, horizon: number): RefFight {
  const { engine, ai, input } = tableGame(spec);
  return { engine, ai, leads: [input], horizon };
}

/** One engine step the player's choice leads to, weighted by the AI's probability for its part. */
interface Step { choices: { p1?: Choice; p2?: Choice }; weight: Rational }

type Node =
  | { kind: 'end'; win: boolean }
  | { kind: 'decide'; turn: boolean; options: Step[][] }   // one option per legal p1 choice
  | { kind: 'enemy'; steps: Step[] };

function nodeOf(f: RefFight, state: EngineState, memory: AiMemory): Node {
  const phase = state.phase;
  switch (phase.kind) {
    case 'terminal':
      return { kind: 'end', win: phase.winner === 'p1' };
    case 'playerReplacement':
      return { kind: 'end', win: false };
    case 'turnChoice': {
      const support = f.ai.support(state, memory);
      const options = f.engine.legalChoices(state, 'p1').map((p1) => support.map((a) => ({ choices: { p1, p2: a.choice }, weight: a.probability })));
      return { kind: 'decide', turn: true, options };
    }
    case 'playerMidTurnSwitch':
      return { kind: 'decide', turn: false, options: f.engine.legalChoices(state, 'p1').map((p1) => [{ choices: { p1 }, weight: ONE }]) };
    case 'enemyReplacement':
    case 'enemyMidTurnSwitch':
      return { kind: 'enemy', steps: f.ai.replacementSupport(state, memory).map((a) => ({ choices: { p2: a.choice }, weight: a.probability })) };
  }
}

const fails = (o: Outcome): boolean => o.fainted.p1.length > 0 || o.unlabelled;

const roots = (f: RefFight) => f.leads.map((input) => {
  const state = f.engine.createBattle(input);
  return { state, memory: f.ai.initialMemory(state) };
});

/** Every path wins within `left` turns; with `cap` set, outcomes with an enemy crit are dropped once `crits` reaches it. */
function safe(f: RefFight, state: EngineState, memory: AiMemory, left: number, cap: number | null, crits: number): boolean {
  const node = nodeOf(f, state, memory);
  const stepSafe = (step: Step, next: number): boolean => {
    for (const o of f.engine.expandTurn(state, step.choices)) {
      const crit = o.critBy.p2;
      if (cap !== null && crit && crits >= cap) continue;
      if (fails(o)) return false;
      if (!safe(f, o.state, f.ai.remember(memory, o), next, cap, crits + (crit ? 1 : 0))) return false;
    }
    return true;
  };
  switch (node.kind) {
    case 'end':
      return node.win;
    case 'decide':
      if (node.turn && left === 0) return false;
      return node.options.some((steps) => steps.every((step) => stepSafe(step, node.turn ? left - 1 : left)));
    case 'enemy':
      return node.steps.every((step) => stepSafe(step, left));
  }
}

/** The least probability of failure from here over the player's full-information strategies. */
function failure(f: RefFight, state: EngineState, memory: AiMemory, left: number): Rational {
  const node = nodeOf(f, state, memory);
  const expected = (steps: Step[], next: number): Rational => {
    let total = ZERO;
    for (const step of steps) {
      for (const o of f.engine.expandTurn(state, step.choices)) {
        const p = fails(o) ? ONE : failure(f, o.state, f.ai.remember(memory, o), next);
        total = add(total, mul(mul(step.weight, o.probability), p));
      }
    }
    return total;
  };
  switch (node.kind) {
    case 'end':
      return node.win ? ZERO : ONE;
    case 'decide': {
      if (node.turn && left === 0) return ONE;
      let best = ONE;
      for (const steps of node.options) best = minR(best, expected(steps, node.turn ? left - 1 : left));
      return best;
    }
    case 'enemy':
      return expected(node.steps, left);
  }
}

/** ∃ lead, then ∃a ∀b ∀ω per turn, within the horizon. */
export function refTier1(f: RefFight): boolean {
  return roots(f).some((r) => safe(f, r.state, r.memory, f.horizon, null, 0));
}

/** min over leads and full-information strategies of P(death ∪ cut-off ∪ unlabelled) under the AI distribution. */
export function refMinFailure(f: RefFight): Rational {
  let best = ONE;
  for (const r of roots(f)) best = minR(best, failure(f, r.state, r.memory, f.horizon));
  return best;
}

const MAX_CRIT_BUDGET = 1000;

/** null when tier 1; −1 when not even G_0; else the largest j with a G_j-safe strategy. */
export function refCritBudget(f: RefFight): number | null {
  if (refTier1(f)) return null;
  // Not tier 1, so some path fails; once j covers every crit step on it, G_j is the full game and fails too.
  for (let j = 0; j <= MAX_CRIT_BUDGET; j++) {
    if (!roots(f).some((r) => safe(f, r.state, r.memory, f.horizon, j, 0))) return j - 1;
  }
  throw new Error(`referee: G_${MAX_CRIT_BUDGET} is still safe without tier 1`);
}
