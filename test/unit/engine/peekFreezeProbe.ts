// Spawned by facts.test.ts outside vitest: does `peek` freeze here, and does a draw through it still throw the peeked
// battle's own refusal (`NoChanceDriver`, src/engine/facts.ts)? Any other error is printed, not counted as a refusal.
import { FREEZE_PEEKED } from '../../../src/engine/facts.js';
import { createBattle, installKaizoDex, peek } from '../../../src/engine/index.js';
import { BAG, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
installKaizoDex(fixture.data, fixture.moves);
const battle = peek(createBattle({
  player: [playerMon(ID.monferno, 40, [ID.ember])],
  trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 36, [ID.tackle])]), field: {},
}));
let draws = 'allowed';
try {
  battle.randomChance(1, 2);
} catch (error) {
  draws = error instanceof Error && /a read of a peeked battle drew a chance/.test(error.message) ? 'throws' : `other error (${String(error)})`;
}
console.log(`flag=${FREEZE_PEEKED} frozen=${Object.isFrozen(battle)} draws=${draws}`);
