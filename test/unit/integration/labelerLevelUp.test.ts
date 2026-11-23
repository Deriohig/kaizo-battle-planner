import { beforeAll, expect, it } from 'vitest';
import { buildMoves } from '../../../src/battle/moves.js';
import type { PlayerMon } from '../../../src/battle/playerMon.js';
import type { MonRef } from '../../../src/contracts/solver.js';
import { createBattle, expandTurn, installKaizoDex } from '../../../src/engine/index.js';
import { createLabeler } from '../../../src/integration/labeler.js';
import { buildNameIndex } from '../../../src/names/nameIndex.js';
import { BAG, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from '../engine/fixtures.js';

const fixture = fixtureDex();
fixture.data.rom.species[ID.magikarp]!.baseExp = 152;   // Ponyta's: floor(152 × 21 / 7) = 456 at level 21
fixture.data.names = buildNameIndex(fixture.data.docs);
const moves = buildMoves(fixture.data);
beforeAll(() => installKaizoDex(fixture.data, moves));

it('after a level-up in the fight, two of one species keep their own page names by party position (`order`)', () => {
  const lead = playerMon(ID.monferno, 30, [ID.plainHit], { location: { kind: 'party', slot: 1 } });
  const z1 = playerMon(ID.zigzagoon, 20, [ID.growl], { exp: 9000, item: 216, location: { kind: 'party', slot: 2 } });   // Exp. Share
  const z2 = playerMon(ID.zigzagoon, 21, [ID.growl], { location: { kind: 'party', slot: 3 } });
  const mons = new Map<MonRef, PlayerMon>([['party:1', lead], ['party:2', z1], ['party:3', z2]]);
  const labeler = createLabeler({ moves, mons, order: ['party:1', 'party:2', 'party:3'] });
  const trainer = resolvedTrainer(BAG.none, [resolvedMon(ID.magikarp, 21, [ID.growl]), resolvedMon(ID.zigzagoon, 21, [ID.growl])]);
  const start = createBattle({ player: [lead, z1, z2], trainer, field: {} });
  const ko = expandTurn(start, { p1: { kind: 'move', slot: 0 }, p2: { kind: 'move', slot: 0 } }).find((o) => o.state.phase.kind === 'enemyReplacement')!;
  expect(ko.log).toContain('|-kaizolevel|p1: Zigzagoon|21');   // the one on the bench levelled
  const next = expandTurn(ko.state, { p2: { kind: 'switch', index: 1 } })[0]!.state;
  expect([1, 2].map((index) => labeler.choice(next, 'p1', { kind: 'switch', index }))).toEqual(['Switch to Zigzagoon (Lv 20)', 'Switch to Zigzagoon (Lv 21)']);
});
