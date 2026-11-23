// The toy game's data: a small Pokémon-like game with known answers. Its rules are at the top of engine.ts.

import type { Rational } from '../../../../src/contracts/engine.js';

export interface ToyMove {
  name: string;
  damage: number[];             // equally likely base damages; [] = no damage
  accuracy?: Rational;          // default ONE (never misses); < 1 → a 'hit' chance point
  critChance?: Rational;        // default ZERO; > 0 → a 'crit' chance point; a crit doubles the damage
  priority?: number;            // default 0
  pp?: number | null;           // default 10; null = unlimited and not part of the state
  hits?: number;                // default 1; each hit draws its own crit and roll
  aiScore?: number;             // the toy AI's score for this move instead of its max damage
  effect?: 'uturn' | 'doze' | 'raw3' | 'heal3';
  // uturn: after hitting, the user's side switches mid-turn if it has a living bench mon
  // doze: target with no status falls asleep with a hidden counter drawn uniformly from {2, 3} (chance kind 'pick', source 'doze')
  // raw3: an unlabelled draw of three equally likely options adding 0, 1 or 2 damage (kind 'raw'; outcome unlabelled)
  // heal3: the user heals 3 HP (capped at max), no damage
  tags?: string[];              // read by the toy AI: 'desperation', 'scary'
}

export interface ToyMon {
  name: string; maxHp: number; speed: number; moves: ToyMove[];
  guts?: boolean;               // +2 damage while statused
  item?: 'mystery';             // unmodelled: Engine.unmodelledIn reports it
  worlds?: Partial<Pick<ToyMon, 'maxHp' | 'speed'>>[];  // enemy only: WorldAssignment.enemy[i].nature = n applies worlds[n]
  ai?: { desperationAtOrBelow?: number; preferAgainstScary?: string; undefinedBehaviour?: boolean | string }; // read by the toy AI (ai.ts)
}

export interface ToyTrainer { id: string; party: ToyMon[]; bag?: 'potion'[]; double?: boolean; hpBarSegments?: number } // default segments 4

export interface ToyRegistry {
  mons: Record<string, ToyMon>; trainers: Record<string, ToyTrainer>;
  observeAll?: boolean;         // the observation is the full state: display mode becomes full information (referee comparisons)
  keyOmitsTurn?: boolean;       // the state key leaves out the turn number, so positions can repeat (repetition and caching tests)
  bugDamagePlusOne?: boolean;   // a planted engine bug: every hit deals 1 more than the rules say (checker tests)
  undrawnSleepCarry?: boolean;  // carryOut writes a sleeping p1 mon as an undrawn sleep (engine.ts RULES, carryOut)
}
