import { beforeAll, expect, it } from 'vitest';
import type { Choice } from '../../../src/contracts/engine.js';
import { createBattle, installKaizoDex } from '../../../src/engine/index.js';
import { createOrderHint, createTeamScore } from '../../../src/integration/hints.js';
import type { FightInfo } from '../../../src/solver/types.js';
import { BAG, fixtureDex, ID, playerMon, resolvedMon, resolvedTrainer } from '../engine/fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const TACKLE: Choice = { kind: 'move', slot: 1 };
const EMBER: Choice = { kind: 'move', slot: 0 };
const TO_BENCH: Choice = { kind: 'switch', index: 1 };
const trainer = resolvedTrainer(BAG.none, [resolvedMon(ID.zigzagoon, 20, [ID.tackle])]);

it('the order hint puts the strongest move first, then the weaker, then switches; a list it cannot score keeps its order', () => {
  const player = [playerMon(ID.monferno, 30, [ID.ember, ID.tackle]), playerMon(ID.zigzagoon, 20, [ID.tackle])];
  const hint = createOrderHint({ data: fixture.data, moves: fixture.moves, player, trainer: () => trainer });
  const state = createBattle({ player, trainer, field: {} });
  expect(hint(state, [TO_BENCH, TACKLE, EMBER])).toEqual([EMBER, TACKLE, TO_BENCH]);
  const odd: Choice[] = [{ kind: 'move', slot: 7 }, { kind: 'move', slot: 6 }];
  expect(hint(state, odd)).toEqual(odd);
});

it('the team score puts a team that out-hits the trainer above one that does not, and never fails on an unknown ref', () => {
  const mons = new Map([['party:1', playerMon(ID.monferno, 40, [ID.ember])], ['party:2', playerMon(ID.zigzagoon, 5, [ID.tackle])]]);
  const fight: FightInfo = { spec: { trainerId: trainer.id }, trainer, field: {}, worlds: [{ enemy: [] }], label: trainer.name, benchMonotone: false };
  const score = createTeamScore(mons, fixture.moves);
  expect(score(['party:1'], [fight])).toBeGreaterThan(score(['party:2'], [fight]));
  expect(score(['party:1', 'party:2'], [fight])).toBe(score(['party:1'], [fight]));
  expect(Number.isFinite(score(['box:1:1'], [fight]))).toBe(true);
});
