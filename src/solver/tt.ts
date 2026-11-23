// The transposition table: the prover's partial fixed point. Keyed by the belief key, so an entry holds for every path into that belief.
// One table per Prover: entries depend on the game parameters (level, crit budget, thresholds) and the observation mode.
//
// What may be stored is the prover's business (the caching rule lives in prove.ts): a win within `depth` turns of its
// fight, proven with later fights held to the per-fight horizon H; or a failure that depends on no belief still on the
// stack, as failAbs (no horizon cut-off below it) or failHorizon(h, H) (reusable only with at most h turns left and a
// per-fight horizon of at most H). Budget and time cut-offs are never stored. A failure keeps whether it was refuted
// (prove.ts), so a reuse answers the same. This file only keeps the strongest entry per key: a win beats any failure; of
// two wins, the one valid in more situations stays (smaller depth, ties to the smaller H); failAbs beats failHorizon; a
// failHorizon entry is replaced unless the old one covers the new one.

import type { Choice } from '../contracts/engine.js';
import type { FailReasons } from './types.js';

export type TTEntry =
  | { kind: 'win'; depth: number; H: number; action: Choice }   // H: the per-fight horizon later fights were proven within
  | { kind: 'failAbs'; reasons: FailReasons; refutation: string[]; refuted: boolean }
  | { kind: 'failHorizon'; h: number; H: number; reasons: FailReasons; refutation: string[]; refuted: boolean }; // h: turns left here; H: the iteration's per-fight horizon

/** Whether `old` should stay rather than be replaced by `e`. */
function keeps(old: TTEntry, e: TTEntry): boolean {
  switch (old.kind) {
    case 'win': return e.kind !== 'win' || e.depth > old.depth || (e.depth === old.depth && e.H >= old.H);
    case 'failAbs': return e.kind !== 'win';
    case 'failHorizon': return e.kind === 'failHorizon' && e.h <= old.h && e.H <= old.H;
  }
}

export class TranspositionTable {
  /** Entries reused by the prover (it counts them; the table does not). */
  hits = 0;
  private readonly entries = new Map<string, TTEntry>();

  get size(): number {
    return this.entries.size;
  }

  get(key: string): TTEntry | undefined {
    return this.entries.get(key);
  }

  /** A win is never replaced by a fail; a win keeps the smaller depth, then the smaller H. */
  put(key: string, e: TTEntry): void {
    const old = this.entries.get(key);
    if (old !== undefined && keeps(old, e)) return;
    this.entries.set(key, e);
  }

  /** Drops every entry and resets `hits`. */
  clear(): void {
    this.entries.clear();
    this.hits = 0;
  }
}
