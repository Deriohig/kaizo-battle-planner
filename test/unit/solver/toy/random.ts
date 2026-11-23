// Seeded random toy fights, small enough for the naive referee in milliseconds; the same seed gives the same fight.
// A fight: observeAll; 1–2 mons a side with HP 3–12, speed 1–6 and 1–2 moves (damage 1..6 with 1–2 distinct values,
// accuracy 1, 3/4 or 1/2, crit 0 or 1/4); horizon 3–5. Odd seeds also set keyOmitsTurn, unlimited PP and maybe a heal3
// 'Mend' (on p1, or on a 'desperation' p2 mon), so positions repeat. A draw is kept only when the whole game tree the
// referee walks fits MAX_STEPS expandTurn calls and MAX_OUTCOMES outcomes. Seeds 1–60: 24 tier 1, 7 tier 2, 29 tier 3.

import type { AiMemory } from '../../../../src/contracts/ai.js';
import type { Choice, EngineState } from '../../../../src/contracts/engine.js';
import { rat } from '../../../../src/solver/rational.js';
import { createToyAi } from './ai.js';
import { createToyEngine } from './engine.js';
import type { ToyMon, ToyMove, ToyRegistry } from './game.js';
import { toyInput } from './helpers.js';

/** The mulberry32 PRNG: floats in [0, 1), deterministic per seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomToyFight { registry: ToyRegistry; p1: string[]; trainerId: string; horizon: number }

const MAX_STEPS = 40;
const MAX_OUTCOMES = 160;
const MAX_DRAWS = 500;
const MOVE_NAMES = ['Jab', 'Kick', 'Bite', 'Claw', 'Slam', 'Zap', 'Peck', 'Bash'];

/** Per-side draws: p1 a little stronger and p2 crits commoner so every tier turns up; few chance points per move. */
const SIDES = {
  p1: { hp: [6, 12], damage: [4, 6], rollChance: 0.2, missChance: 0.15, critChance: 0.15 },
  p2: { hp: [3, 8], damage: [2, 6], rollChance: 0.2, missChance: 0.2, critChance: 0.5 },
} as const;

function draw(rng: () => number, seed: number): RandomToyFight {
  const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
  const odd = Math.abs(seed) % 2 === 1;
  let names = 0;
  const move = (side: keyof typeof SIDES): ToyMove => {
    const p = SIDES[side];
    const d1 = int(p.damage[0], p.damage[1]);
    let damage = [d1];
    if (rng() < p.rollChance) {
      const d2 = int(1, 5);
      damage = [d1, d2 >= d1 ? d2 + 1 : d2].sort((x, y) => x - y);
    }
    const m: ToyMove = { name: MOVE_NAMES[names++]!, damage };
    if (rng() < p.missChance) m.accuracy = rng() < 0.5 ? rat(3, 4) : rat(1, 2);
    if (rng() < p.critChance) m.critChance = rat(1, 4);
    if (odd) m.pp = null;
    return m;
  };
  const mon = (side: keyof typeof SIDES, name: string): ToyMon => {
    const maxHp = int(SIDES[side].hp[0], SIDES[side].hp[1]);
    const speed = int(1, 6);
    const count = rng() < 0.25 ? 2 : 1;
    return { name, maxHp, speed, moves: Array.from({ length: count }, () => move(side)) };
  };
  const p1 = Array.from({ length: int(1, 2) }, (_, i) => mon('p1', `Ally${i}`));
  const party = Array.from({ length: int(1, 2) }, (_, i) => mon('p2', `Foe${i}`));
  if (odd && rng() < 0.6) {
    const mend: ToyMove = { name: 'Mend', damage: [], effect: 'heal3', pp: null };
    if (rng() < 0.5) {
      p1[int(0, p1.length - 1)]!.moves.push(mend);
    } else {
      const healer = party[int(0, party.length - 1)]!;
      healer.moves.push({ ...mend, tags: ['desperation'] });
      healer.ai = { desperationAtOrBelow: int(2, 4) };
    }
  }
  const trainerId = `random${seed}`;
  const registry: ToyRegistry = {
    mons: Object.fromEntries(p1.map((m) => [m.name, m])),
    trainers: { [trainerId]: { id: trainerId, party } },
    observeAll: true,
    ...(odd ? { keyOmitsTurn: true } : {}),
  };
  return { registry, p1: p1.map((m) => m.name), trainerId, horizon: int(3, 5) };
}

/** Whether the whole game tree fits the size guard. */
function small(fight: RandomToyFight): boolean {
  const engine = createToyEngine(fight.registry);
  const ai = createToyAi(fight.registry);
  let steps = 0;
  let outcomes = 0;
  const walk = (state: EngineState, memory: AiMemory, left: number): boolean => {
    const kind = state.phase.kind;
    if (kind === 'terminal' || kind === 'playerReplacement' || (kind === 'turnChoice' && left === 0)) return true;
    const p1s: (Choice | undefined)[] = kind === 'turnChoice' || kind === 'playerMidTurnSwitch' ? engine.legalChoices(state, 'p1') : [undefined];
    const p2s: (Choice | undefined)[] = kind === 'turnChoice'
      ? ai.support(state, memory).map((a) => a.choice)
      : kind === 'enemyReplacement' || kind === 'enemyMidTurnSwitch' ? ai.replacementSupport(state, memory).map((a) => a.choice) : [undefined];
    const next = kind === 'turnChoice' ? left - 1 : left;
    for (const p1 of p1s) {
      for (const p2 of p2s) {
        const result = engine.expandTurn(state, { p1, p2 });
        steps += 1;
        outcomes += result.length;
        if (steps > MAX_STEPS || outcomes > MAX_OUTCOMES) return false;
        for (const o of result) {
          if (o.fainted.p1.length > 0 || o.unlabelled) continue;
          if (!walk(o.state, ai.remember(memory, o), next)) return false;
        }
      }
    }
    return true;
  };
  return fight.p1.every((lead, i) => {
    const input = toyInput(fight.registry, [lead, ...fight.p1.filter((_, k) => k !== i)], fight.trainerId);
    const state = engine.createBattle(input);
    return walk(state, ai.initialMemory(state), fight.horizon);
  });
}

export function randomToyFight(seed: number): RandomToyFight {
  const rng = mulberry32(seed);
  for (let i = 0; i < MAX_DRAWS; i++) {
    const fight = draw(rng, seed);
    if (small(fight)) return fight;
  }
  throw new Error(`randomToyFight(${seed}): no fight passed the size guard in ${MAX_DRAWS} draws`);
}
