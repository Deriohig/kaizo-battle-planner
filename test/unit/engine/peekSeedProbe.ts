// Spawned by peekSeed.test.ts outside vitest: `peek`'s switches as this process reads them, and how many restores the
// first peeks of one step's outcomes cost.
import PS from 'pokemon-showdown';
import { peekConfig } from '../../../src/engine/facts.js';
import { createBattle, expandTurn, installKaizoDex, peek } from '../../../src/engine/index.js';
import { emberTurn, fixtureDex } from './fixtures.js';

const fixture = fixtureDex();
installKaizoDex(fixture.data, fixture.moves);
const outcomes = expandTurn(createBattle(emberTurn()), { p1: { kind: 'move', slot: 0 }, p2: { kind: 'move', slot: 0 } });
const battleClass = PS.Battle as unknown as { fromJSON: (...args: unknown[]) => unknown };
const fromJSON = battleClass.fromJSON;
let restores = 0;
battleClass.fromJSON = function counted(this: unknown, ...args: unknown[]) {
  restores += 1;
  return fromJSON.apply(this, args);
};
const frozen = outcomes.map((outcome) => Object.isFrozen(peek(outcome.state)));
const { seed, verify, freeze } = peekConfig;
console.log(`seed=${seed} verify=${verify} freeze=${freeze} outcomes=${outcomes.length} restores=${restores} frozen=${frozen.every(Boolean)}`);
