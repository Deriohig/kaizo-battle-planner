// The default plan labeler: the name-free approximation of the contract's label conventions (the comment above
// `PlanNode` in src/contracts/solver.ts). It knows no move or Pokémon names, so it names slots, party indices and the
// engine's chance-label sources; the integration's labeler supplies real names. The prover uses it for refutation text
// and the plan tree uses it for branch labels.

import type { ChanceLabel, Choice, EngineState, Outcome, Side } from '../contracts/engine.js';
import type { PlanLabeler } from './types.js';

export const defaultLabeler: PlanLabeler = {
  /** 'Use move <slot+1>' | 'Switch to party <index+1>' | 'Use <item>'. */
  choice(_state: EngineState, _side: Side, choice: Choice): string {
    switch (choice.kind) {
      case 'move': return `Use move ${choice.slot + 1}`;
      case 'switch': return `Switch to party ${choice.index + 1}`;
      case 'item': return `Use ${choice.item}`;
    }
  },

  /** '' without labels; else 'If ' + '<source> <outcome>' per label, joined by ', ' (e.g. 'If bash crit'). */
  outcome(outcome: Outcome): string {
    if (outcome.labels.length === 0) return '';
    return `If ${outcome.labels.map((l) => `${l.source} ${l.outcome}`).join(', ')}`;
  },

  /**
   * '[enemy crit ]<source of the last p2 label, or "damage"> on turn <turn> kills party <fainted.p1 joined by ', '>', or
   * '… kills the active Pokémon' when fainted.p1 is empty (a death read from the phase alone).
   */
  killCause(outcome: Outcome, turn: number): string {
    const last = outcome.labels.reduce<ChanceLabel | null>((found, l) => (l.side === 'p2' ? l : found), null);
    const victim = outcome.fainted.p1.length === 0 ? 'the active Pokémon' : `party ${outcome.fainted.p1.join(', ')}`;
    return `${outcome.critBy.p2 ? 'enemy crit ' : ''}${last?.source ?? 'damage'} on turn ${turn} kills ${victim}`;
  },
};
