// The trainer-AI adapter's read-only accessors.

import { beforeAll, describe, expect, it } from 'vitest';
import type { Choice, EngineState } from '../../../src/contracts/engine.js';
import { createBattle, restore, snapshot } from '../../../src/engine/battle.js';
import { installKaizoDex } from '../../../src/engine/dex.js';
import * as engine from '../../../src/engine/index.js';
import { battleStartLog, battleTrainer, expandTurn, omniscientLog, quickClawRolls } from '../../../src/engine/index.js';
import { omniscientLog as observeOmniscientLog } from '../../../src/engine/observe.js';
import { AI_FLAG_NAMES } from '../../../src/rom/trainers.js';
import { AI_MASK, AI_TRAINER, BAG, fixtureDex, ID, ITEM, knownAbility, playerMon, resolvedMon, resolvedTrainer } from './fixtures.js';

const fixture = fixtureDex();
beforeAll(() => installKaizoDex(fixture.data, fixture.moves));

const move = (slot: number): Choice => ({ kind: 'move', slot });
const BOTH = { p1: move(0), p2: move(0) };
const against = (romIndex: number, enemy = resolvedMon(ID.zigzagoon, 20, [ID.meanLook])) =>
  createBattle({ player: [playerMon(ID.monferno, 30, [ID.ember, ID.tackle])], trainer: resolvedTrainer(romIndex, [enemy]), field: {} });
/** `state` with `edit` made to a restore's formatData. */
const withFormatData = (state: EngineState, edit: (formatData: Record<string, unknown>) => void) => {
  const battle = restore(state);
  edit(battle.formatData);
  return snapshot(battle);
};

describe('battleTrainer', () => {
  it('gives the trainer\'s ROM index and its raw AI mask from the installed ROM data, in the key, and after expandTurn', () => {
    expect([AI_TRAINER.first, AI_TRAINER.second, BAG.none].map((index) => battleTrainer(against(index)))).toEqual([
      { romIndex: AI_TRAINER.first, aiMask: AI_MASK.first }, { romIndex: AI_TRAINER.second, aiMask: AI_MASK.second }, { romIndex: BAG.none, aiMask: 0 },
    ]);
    expect(against(AI_TRAINER.first).key).not.toBe(against(AI_TRAINER.second).key);
    const outcomes = expandTurn(against(AI_TRAINER.second), BOTH);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) expect(battleTrainer(outcome.state)).toEqual({ romIndex: AI_TRAINER.second, aiMask: AI_MASK.second });
  });

  it('the fixture trainers\' aiFlags name their aiMask\'s bits, as the ROM reader derives them (a bit past the named flags has none)', () => {
    for (const rom of fixture.data.rom.trainers) expect(rom.aiFlags, `trainer ${rom.index}`).toEqual(AI_FLAG_NAMES.filter((_, bit) => (rom.aiMask >>> bit) & 1));
  });
});

describe('battleStartLog', () => {
  const INTIMIDATE = 22;
  it('has the leads\' switch lines and a start-of-battle ability line, and no split or timestamp lines', () => {
    const log = battleStartLog(against(AI_TRAINER.first, resolvedMon(ID.zigzagoon, 20, [ID.meanLook], { ability: knownAbility(INTIMIDATE) })));
    expect(log.filter((line) => line.startsWith('|switch|')).map((line) => line.slice(8, 11))).toEqual(['p1a', 'p2a']);
    expect(log.some((line) => line.startsWith('|-ability|p2a') && line.includes('Intimidate'))).toBe(true);
    expect(log.some((line) => line.startsWith('|split|') || line.startsWith('|t:|'))).toBe(false);
  });

  it('is still available several turns later, and [] for a state without a stored start log', () => {
    let state: EngineState = against(AI_TRAINER.first, resolvedMon(ID.castform, 60, [ID.meanLook], { ability: knownAbility(INTIMIDATE) }));
    const start = battleStartLog(state);
    expect(start.length).toBeGreaterThan(0);
    for (let turn = 0; turn < 3; turn++) state = expandTurn(state, { p1: move(1), p2: move(0) })[0]!.state;
    expect([state.turn > 1, battleStartLog(state)]).toEqual([true, start]);
    expect(battleStartLog(withFormatData(against(BAG.none), (formatData) => { delete formatData['kaizoStartLog']; }))).toEqual([]);
  });
});

describe('omniscientLog and quickClawRolls', () => {
  it('omniscientLog is exported from the index, as observe.ts has it', () => {
    expect([omniscientLog, engine.omniscientLog]).toEqual([observeOmniscientLog, observeOmniscientLog]);
  });

  it('quickClawRolls gives each side\'s stored roll as a boolean, absent when not drawn, {} when nothing was', () => {
    const stored = (rolls: Record<string, boolean>) => quickClawRolls(withFormatData(against(BAG.none), (formatData) => { formatData['kaizoSpeedRand'] = rolls; }));
    expect([quickClawRolls(against(BAG.none)), stored({ p1: true, p2: false }), stored({ p2: true })]).toEqual([{}, { p1: true, p2: false }, { p2: true }]);
  });

  it('quickClawRolls matches the roll a step drew: a poisoned Quick Claw holder\'s end-of-turn order leaves its roll in the state', () => {
    // Equal Speed, both poisoned (Mean Look draws nothing): the end-of-turn `monSpeedOrder` compare picks the holder's roll.
    const start = withFormatData(createBattle({
      player: [playerMon(ID.monferno, 30, [ID.meanLook], { status: { kind: 'poison' } })],
      trainer: resolvedTrainer(BAG.none, [resolvedMon(ID.monferno, 30, [ID.meanLook], { item: ITEM.quickClaw })]), field: {},
    }), () => {});
    const poisoned = (() => { const battle = restore(start); expect(battle.p2.active[0]!.setStatus('psn')).toBe(true); return snapshot(battle); })();
    const drawn = new Set<boolean>();
    for (const outcome of expandTurn(poisoned, BOTH)) {
      const rolls = quickClawRolls(outcome.state);
      const raw = (JSON.parse(outcome.state.json) as { formatData: Record<string, unknown> }).formatData['kaizoSpeedRand'] as Record<string, boolean> | undefined;
      expect([rolls, Object.keys(rolls)]).toEqual([raw ?? {}, ['p2']]);
      drawn.add(rolls.p2!);
    }
    expect([...drawn].sort()).toEqual([false, true]);
  });
});
