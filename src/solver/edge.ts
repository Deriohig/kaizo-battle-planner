// The certificate's edge format, shared by the search and the checker: which states are the player's decisions, and the label
// of the edge into one (the observations since his last decision plus the next decision's phase kind, plus in RAM mode
// the exact member's key).

import { createHash } from 'node:crypto';
import type { EngineState } from '../contracts/engine.js';
import type { DecisionPhase } from './types.js';

const SEPARATOR = '\u001f';

/** 'turnChoice' or 'playerMidTurnSwitch' at those phases; null at every other phase. */
export function decisionPhase(state: EngineState): DecisionPhase | null {
  const kind = state.phase.kind;
  return kind === 'turnChoice' || kind === 'playerMidTurnSwitch' ? kind : null;
}

/** The observations joined by '\n', then '\u001f' + phase, then '\u001f' + ramKey when given. */
export function edgeLabel(observations: string[], phase: DecisionPhase, ramKey?: string): string {
  const label = `${observations.join('\n')}${SEPARATOR}${phase}`;
  return ramKey === undefined ? label : `${label}${SEPARATOR}${ramKey}`;
}

/**
 * A member's key, the RAM-mode `ramKey` of edgeLabel: sha256 of `${fight}|${kind}|${stateOrCarryKey}|${memoryKey}|${crits}`,
 * base64url, first 22 characters (128 bits). `stateOrCarryKey` is the engine state's `key` in battle, and at a fight's
 * entry the canonical JSON of the carry it starts from ('fresh' for none); `memoryKey` is '' at an entry and at level 2;
 * `crits` is the member's capped enemy-crit steps (0 without a crit cap). The arena's Member.key is this value.
 */
export function ramEdgeKey(fight: number, kind: 'entry' | 'battle', stateOrCarryKey: string, memoryKey: string, crits: number): string {
  return createHash('sha256').update(`${fight}|${kind}|${stateOrCarryKey}|${memoryKey}|${crits}`, 'utf8').digest('base64url').slice(0, 22);
}

/** '#fight <n>': appended to the observations when a gauntlet moves on to fight n. */
export function fightMarker(fight: number): string {
  return `#fight ${fight}`;
}
