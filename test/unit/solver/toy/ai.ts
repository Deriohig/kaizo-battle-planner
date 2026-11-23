// The toy AI: the EnemyModel contract (src/contracts/ai.ts) over the toy engine's state.
//
// RULES
//
// support, for p2's active mon over its moves with PP (none left → Struggle, { move, slot 0 }):
//   1. hp <= ai.desperationAtOrBelow → only the 'desperation' moves with PP, if any.
//   2. a potion in the bag and hp × 2 <= maxHp → only { item: 'potion' }.
//   3. a revealed p1 move tagged 'scary' in memory and ai.preferAgainstScary names a move with PP → only that move.
//   4. else score: aiScore when set; doze 100 while p1's active mon has no status; else max damage × hits. A doze
//      against a statused target is never chosen unless it is the only move with PP. Moves tied at the best share it.
// replacementSupport: every living p2 mon other than the active one, uniformly.
// While the active p2 mon has ai.undefinedBehaviour, both throw an Error with code 'UNDEFINED' (for true) or the given
// string (e.g. 'DIV_ZERO'). memory: { key: JSON of the sorted revealed p1 move names, data: { revealed } }, read from the
// outcome's '|move|p1a: …' lines. Every support lists distinct choices with probability > 0, summing to ONE.

import type { ActionSupport, AiMemory, EnemyModel } from '../../../../src/contracts/ai.js';
import type { Choice, EngineState, Outcome } from '../../../../src/contracts/engine.js';
import { ONE, rat } from '../../../../src/solver/rational.js';
import { readToyState, toyMonOf, type ToyMonState, type ToyState } from './engine.js';
import type { ToyMove, ToyRegistry } from './game.js';

export interface ToyAiMemoryData { revealed: string[] }

function memoryOf(revealed: Iterable<string>): AiMemory {
  const sorted = [...new Set(revealed)].sort();
  return { key: JSON.stringify(sorted), data: { revealed: sorted } satisfies ToyAiMemoryData };
}

function revealedOf(memory: AiMemory): string[] {
  return (memory.data as ToyAiMemoryData | null)?.revealed ?? [];
}

function uniform(choices: Choice[]): ActionSupport[] {
  return choices.map((choice) => ({ choice, probability: rat(1, choices.length) }));
}

const moveChoice = (slot: number): Choice => ({ kind: 'move', slot });

/** Rule 4's score of a move; `null` = never chosen. */
function scoreOf(move: ToyMove, target: ToyMonState): number | null {
  if (move.effect === 'doze' && target.status !== 'none') return null;
  if (move.aiScore !== undefined) return move.aiScore;
  if (move.effect === 'doze') return 100;
  return Math.max(0, ...move.damage) * (move.hits ?? 1);
}

function refuseIfUndefined(registry: ToyRegistry, s: ToyState): void {
  const undefinedBehaviour = toyMonOf(registry, s, 'p2', s.active.p2).ai?.undefinedBehaviour;
  if (undefinedBehaviour === undefined || undefinedBehaviour === false) return;
  const code = undefinedBehaviour === true ? 'UNDEFINED' : undefinedBehaviour;
  throw Object.assign(new Error('toy: undefined behaviour'), { code });
}

function scaryRevealed(registry: ToyRegistry, s: ToyState, memory: AiMemory): boolean {
  const revealed = new Set(revealedOf(memory));
  return s.p1Keys.some((_, i) => toyMonOf(registry, s, 'p1', i).moves.some((m) => revealed.has(m.name) && (m.tags ?? []).includes('scary')));
}

export function createToyAi(registry: ToyRegistry): EnemyModel {
  return {
    id: 'toy-ai@1',

    initialMemory(): AiMemory {
      return memoryOf([]);
    },

    support(state: EngineState, memory: AiMemory): ActionSupport[] {
      const s = readToyState(state);
      refuseIfUndefined(registry, s);
      const index = s.active.p2;
      const me = s.p2[index]!;
      const data = toyMonOf(registry, s, 'p2', index);
      const usable = data.moves.flatMap((move, slot) => {
        const pp = me.pp[slot];
        return pp === null || (pp !== undefined && pp > 0) ? [{ move, slot }] : [];
      });
      if (usable.length === 0) return [{ choice: moveChoice(0), probability: ONE }];   // Struggle
      const ai = data.ai ?? {};

      if (ai.desperationAtOrBelow !== undefined && me.hp <= ai.desperationAtOrBelow) {
        const desperate = usable.filter((u) => (u.move.tags ?? []).includes('desperation'));
        if (desperate.length > 0) return uniform(desperate.map((u) => moveChoice(u.slot)));
      }
      if (s.bag.includes('potion') && me.hp * 2 <= me.maxHp) return [{ choice: { kind: 'item', item: 'potion' }, probability: ONE }];
      if (ai.preferAgainstScary !== undefined && scaryRevealed(registry, s, memory)) {
        const preferred = usable.find((u) => u.move.name === ai.preferAgainstScary);
        if (preferred !== undefined) return [{ choice: moveChoice(preferred.slot), probability: ONE }];
      }

      const target = s.p1[s.active.p1]!;
      const scored = usable.flatMap((u) => {
        const score = scoreOf(u.move, target);
        return score === null ? [] : [{ slot: u.slot, score }];
      });
      if (scored.length === 0) return uniform(usable.map((u) => moveChoice(u.slot)));   // only dozes against a statused target
      const best = Math.max(...scored.map((x) => x.score));
      return uniform(scored.filter((x) => x.score === best).map((x) => moveChoice(x.slot)));
    },

    replacementSupport(state: EngineState): ActionSupport[] {
      const s = readToyState(state);
      refuseIfUndefined(registry, s);
      return uniform(s.p2.flatMap((m, index) => (m.fainted || index === s.active.p2 ? [] : [{ kind: 'switch', index } as const])));
    },

    remember(memory: AiMemory, outcome: Outcome): AiMemory {
      const seen = outcome.log.flatMap((line) => {
        const parts = line.split('|');
        return parts[1] === 'move' && parts[2]?.startsWith('p1a: ') && parts[3] !== undefined ? [parts[3]] : [];
      });
      return seen.length === 0 ? memory : memoryOf([...revealedOf(memory), ...seen]);
    },
  };
}
