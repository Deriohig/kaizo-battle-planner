// createTrainerAi, the EnemyModel over the engine: shapes, choices and exact probabilities of the AI's own draws.

import { beforeAll, describe, expect, it } from 'vitest';
import { peekBattle, viewFromState } from '../../../src/ai/adapter.js';
import {
  AI_BATTLER_ATTACKER, AI_BATTLER_DEFENDER, BATTLE_STAT, COMPARE_SPEED_FASTER, ITEM_AI_CATEGORY_FULL_RESTORE,
  ITEM_AI_CATEGORY_GUARD_SPEC, ITEM_AI_CATEGORY_MAX, ITEM_AI_CATEGORY_RECOVER_HP, ITEM_AI_CATEGORY_RECOVER_STATUS,
  ITEM_AI_CATEGORY_STAT_BOOSTER, MOVE_EFFECT_IMPRISON, MOVE_EFFECT_IMPRISONED,
} from '../../../src/ai/constants.js';
import { AiError } from '../../../src/ai/errors.js';
import { createTrainerAi, itemChoice, trainerAi } from '../../../src/ai/index.js';
import { type AiMemoryData, initialMemoryData } from '../../../src/ai/memory.js';
import { add, mul, rat, ZERO } from '../../../src/ai/odds.js';
import { buildMoves } from '../../../src/battle/moves.js';
import type { LoadedData } from '../../../src/battle/types.js';
import type { ActionSupport, AiMemory, EnemyModel } from '../../../src/contracts/ai.js';
import type { BattleInput, Choice, EngineState, Outcome, Rational } from '../../../src/contracts/engine.js';
import { PEEK_LIMIT } from '../../../src/engine/facts.js';
import {
  bagItemId, battleStartLog, createBattle, expandTurn, installKaizoDex, legalChoices, ONE, peek, quickClawRolls, restore,
} from '../../../src/engine/index.js';
import { AI_TRAINER, BAG, ID, playerMon } from '../engine/fixtures.js';
import { FX } from './fixtures.js';
import {
  ability, aiErrorCode, battle, editState, firstOf, flagsOf, modelData, MOVE, move, NOTHING, outcomes, romWith,
} from './modelHarness.js';

const data = modelData();
beforeAll(() => installKaizoDex(data, buildMoves(data)));

const COINS = 'IfRandomLessThan 128, Bonus\nPopOrEnd\nBonus: AddToMoveScore 1\nPopOrEnd'; // each slot's score is its own coin
const modelWith = (src: string): EnemyModel => createTrainerAi(data, romWith(src));
/** A model whose script is an unknown opcode: a support it gives shows TrainerAI_Main never ran. */
const modelThatNeverThinks = (): EnemyModel =>
  createTrainerAi(data, { ...romWith(), scriptWords: [0x7fff], flagEntries: Array<number>(32).fill(0), scriptSha256: 'never' });
const md = (memory: AiMemory): AiMemoryData => memory.data as AiMemoryData;
const viewOf = (state: EngineState, memory: AiMemory) => viewFromState(state, data, romWith(), md(memory));

const withEnemyHp = (state: EngineState, hp: number): EngineState => editState(state, (b) => { b.p2.active[0]!.hp = hp; });

const total = (support: readonly ActionSupport[]): Rational => support.reduce((sum, entry) => add(sum, entry.probability), ZERO);
const movesOf = (support: readonly ActionSupport[]) => support.filter((entry) => entry.choice.kind === 'move');
const moveChoices = (support: readonly ActionSupport[]) => movesOf(support).map((entry) => entry.choice);

/** `support`, checked as the contract asks: probabilities above 0 summing to ONE, no repeats, each legal (an item by id). */
function checked(state: EngineState, support: readonly ActionSupport[]): readonly ActionSupport[] {
  expect(total(support)).toEqual(ONE);
  expect(support.every((entry) => entry.probability.num > 0n)).toBe(true);
  const keys = support.map((entry) => JSON.stringify(entry.choice));
  expect(new Set(keys).size).toBe(keys.length);
  const legal = legalChoices(state, 'p2');
  for (const { choice } of support) expect(legal).toContainEqual(choice.kind === 'item' ? { kind: 'item', item: choice.item } : choice);
  return support;
}

describe('createTrainerAi', () => {
  it("id is 'pokeplatinum-ai@' and the script's first 12 hex digits", () => {
    const ai = romWith(COINS);
    const model = createTrainerAi(data, ai);
    expect(model.id).toBe(`pokeplatinum-ai@${ai.scriptSha256.slice(0, 12)}`);
    expect(createTrainerAi(data, romWith(COINS)).id).toBe(model.id);
    expect(createTrainerAi(data, romWith()).id).not.toBe(model.id);
    expect(typeof trainerAi.support).toBe('function'); // the local model loads its data only on first use
  });

  it('support sums to one and only offers legal choices, over two turns of outcomes', () => {
    // No bag: BAG.potions' X Attack passes its turn-1 check, so the AI would use an item with probability 1.
    const model = modelWith(COINS);
    const start = createBattle(battle([ID.ember, ID.tackle, MOVE.swordsDance], {}, BAG.none));
    const startMemory = model.initialMemory(start);
    expect(checked(start, model.support(start, startMemory)).length).toBeGreaterThan(1);
    // Turn 1 (Tackle against Reflect), then turn 2 (Swords Dance against Tackle) from two of its outcomes.
    const turnOne = expandTurn(start, { p1: move(1), p2: move(1) }).map((o) => ({ state: o.state, memory: model.remember(startMemory, o) }));
    const turnTwo = turnOne.filter((o) => o.state.phase.kind === 'turnChoice').slice(0, 2).flatMap(({ state, memory }) =>
      expandTurn(state, { p1: move(2), p2: move(2) }).map((o) => ({ state: o.state, memory: model.remember(memory, o) })));
    for (const { state, memory } of [...turnOne, ...turnTwo]) {
      if (state.phase.kind === 'turnChoice') checked(state, model.support(state, memory));
      if (state.phase.kind === 'enemyReplacement') checked(state, model.replacementSupport(state, memory));
    }
    expect(turnOne.length + turnTwo.length).toBeGreaterThan(4);
  }, 30_000);

  it.each([
    { name: 'mask 7 (AI_TRAINER.first)', trainer: AI_TRAINER.first, field: {}, minMoves: 2 },
    { name: 'a mask with its top bit set, a u32 (AI_TRAINER.second)', trainer: AI_TRAINER.second, field: {}, minMoves: 2 },
    { name: 'a rain field note and BAG.potions (its X Attack at ONE)', trainer: BAG.potions, field: { weather: 'rain' as const }, minMoves: 0 },
  ])('support on an engine trainer fight with $name is legal and sums to ONE', ({ trainer, field, minMoves }) => {
    const model = modelWith(COINS);
    const state = createBattle({ ...battle([MOVE.swordsDance], {}, trainer), field });
    expect(movesOf(checked(state, model.support(state, model.initialMemory(state)))).length).toBeGreaterThanOrEqual(minMoves);
  });

  it.each([
    // Uproar locks Zigzagoon in: no command selection at all (battle_controller_player.c:334–338).
    { name: 'Uproar', moves: [MOVE.swordsDance], lead: { moves: [MOVE.uproar, ID.tackle] }, steps: [[0, 0]], slot: 0 },
    // Mean Look's 5 PP spent: the command is still picked (battle_display.c:3411), then Fight skips the menu (:432–440).
    { name: 'Struggle', moves: [MOVE.swordsDance], lead: { moves: [ID.meanLook] }, steps: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], slot: 0 },
    // Monferno's Encore on Zigzagoon's Reflect: Fight takes encoredMoveSlot (battle_controller_player.c:442–455).
    { name: 'Encore', moves: [MOVE.swordsDance, MOVE.encore], lead: {}, steps: [[0, 1], [1, 0]], slot: 1 },
  ])('$name: the forced move, without TrainerAI_Main', ({ moves, lead, steps, slot }) => {
    const model = modelThatNeverThinks();
    const start = createBattle(battle(moves, lead));
    const state = steps.reduce((s, [p1, p2]) => firstOf(s, move(p1!), move(p2!)), start);
    expect(moveChoices(checked(state, model.support(state, model.initialMemory(start))))).toEqual([move(slot)]);
    expect(legalChoices(state, 'p2').filter((choice) => choice.kind === 'move')).toEqual([move(slot)]);
  });

  it("aiMask mismatch throws BAD_VIEW: the engine's mask must be the loaded ROM trainer's", () => {
    const state = createBattle(battle([MOVE.swordsDance], {}, AI_TRAINER.first));
    const withTrainer = (change: Partial<LoadedData['rom']['trainers'][number]> | null): LoadedData => ({
      ...data,
      rom: { ...data.rom, trainers: data.rom.trainers.flatMap((t) => (t.index !== AI_TRAINER.first ? [t] : change ? [{ ...t, ...change }] : [])) },
    });
    // Other flags, another mask, and no such ROM trainer at all.
    for (const changed of [withTrainer({ aiFlags: [] }), withTrainer({ aiMask: 3, aiFlags: flagsOf(3) }), withTrainer(null)]) {
      const model = createTrainerAi(changed, romWith(COINS));
      expect(aiErrorCode(() => model.support(state, model.initialMemory(state)))).toBe('BAD_VIEW');
    }
  });

  // TrainerAI_ShouldUseItem (trainer_ai.c:4091–4196) empties every slot whose check passes; the last is usedItem.
  it.each([
    { bag: BAG.fullRestore, hp: 5, use: { kind: 'item', item: 'fullrestore' } },
    // Guard Spec. (slot 1) passes; X Special (2) sets the stat booster; Full Heal (3) is emptied too and is usedItem.
    { bag: BAG.battleItems, hp: null, use: { kind: 'item', item: 'fullheal', consumeSlots: [1, 2, 3], effect: { category: 'statBooster', stat: 'spa' } } },
    { bag: BAG.mixedHp, hp: 5, use: { kind: 'item', item: 'hyperpotion', consumeSlots: [0, 1, 2, 3], effect: { category: 'recoverHp' } } },
  ])('bag $bag: the AI uses $use.item, and the engine takes the choice', ({ bag, hp, use }) => {
    const model = modelWith(NOTHING);
    const start = createBattle(battle([MOVE.swordsDance], {}, bag));
    const state = hp === null ? start : withEnemyHp(start, hp);
    const support = checked(state, model.support(state, model.initialMemory(start)));
    expect(support.filter((entry) => entry.choice.kind === 'item').map((entry) => entry.choice)).toEqual([use]);
    expect(expandTurn(state, { p1: move(0), p2: use as Choice }).length).toBeGreaterThan(0);
  });

  it('itemChoice maps every ITEM_AI_CATEGORY', () => {
    const many = (type: number, condition = 0) => itemChoice({ item: 27, type, condition, consumed: [0, 2] });
    expect(many(ITEM_AI_CATEGORY_FULL_RESTORE)).toEqual({ kind: 'item', item: 'fullheal', consumeSlots: [0, 2], effect: { category: 'fullRestore' } });
    const stats = ['ATTACK', 'DEFENSE', 'SPEED', 'SP_ATTACK', 'SP_DEFENSE', 'ACCURACY'] as const;
    expect([
      many(ITEM_AI_CATEGORY_RECOVER_HP), many(ITEM_AI_CATEGORY_RECOVER_STATUS, 0x30), many(ITEM_AI_CATEGORY_GUARD_SPEC), many(ITEM_AI_CATEGORY_MAX),
      ...stats.map((stat) => many(ITEM_AI_CATEGORY_STAT_BOOSTER, BATTLE_STAT[stat])),
    ].map((choice) => choice.effect)).toEqual([
      { category: 'recoverHp' }, { category: 'recoverStatus', statusMask: 0x30 }, { category: 'guardSpec' }, { category: 'undefined' },
      ...['atk', 'def', 'spe', 'spa', 'spd', 'accuracy'].map((stat) => ({ category: 'statBooster', stat })),
    ]);
    expect(itemChoice({ item: 23, type: ITEM_AI_CATEGORY_FULL_RESTORE, condition: 0, consumed: [0] })).toEqual({ kind: 'item', item: bagItemId(23) });
  });
});

/** Zigzagoon after five Mean Looks (0 PP), a Tackle and Monferno's Disable on it; then a Quick Claw, its roll dropped. */
function disabledTackle(model: EnemyModel, quickClaw = false): { state: EngineState; memory: AiMemory } {
  const start = createBattle(battle([MOVE.swordsDance, MOVE.disable]));
  let state = start;
  for (let i = 0; i < 5; i++) state = firstOf(state, move(0), move(3));
  state = firstOf(firstOf(state, move(0), move(2)), move(1), move(1));
  if (quickClaw) state = editState(state, (b) => { b.p2.active[0]!.item = 'quickclaw' as ID; delete b.formatData['kaizoSpeedRand']; });
  return { state, memory: model.initialMemory(start) };
}

describe('a refused pick re-runs TrainerAI_Main: the move played is a usable pick, renormalised per Quick Claw draw', () => {
  // The battle refuses a Disabled or 0-PP slot (battle_lib.c:2321–2373), and its move menu runs TrainerAI_Main again.
  it('every slot at 0 ties four ways (trainer_ai.c:317–338): the two usable picks get half the fight each', () => {
    const model = modelWith('AddToMoveScore -100\nPopOrEnd');
    const { state, memory } = disabledTackle(model);
    const moves = movesOf(checked(state, model.support(state, memory)));
    expect(moves.map((entry) => entry.choice)).toEqual([move(0), move(1)]);
    expect(moves[0]!.probability).toEqual(moves[1]!.probability);
  });

  it('a pick that can never be played is UNDEFINED: the cartridge re-runs TrainerAI_Main forever', () => {
    const model = modelWith(`IfMoveEqualTo ${ID.tackle}, Up\nAddToMoveScore -100\nPopOrEnd\nUp: AddToMoveScore 5\nPopOrEnd`);
    const { state, memory } = disabledTackle(model);
    expect(aiErrorCode(() => model.support(state, memory))).toBe('UNDEFINED');
  });

  // speedRand is drawn once a turn (battle_lib.c:2024), so each re-run reads the same draw q: Σ_q P(q) · P(s | q) / P(usable | q).
  // Zigzagoon's Quick Claw fires on 13108 of 65536 draws, making it FASTER; an unknown draw is marginalised.
  const FIRES = rat(13108, 65536);
  const MISSES = rat(65536 - 13108, 65536);
  /** When the AI is faster (its Quick Claw fired), `fast`; else Reflect +10. */
  const scriptWith = (fast: string) => [
    `IfSpeedCompareEqualTo ${COMPARE_SPEED_FASTER}, Fast`, `IfMoveEqualTo ${MOVE.reflect}, Up10`, 'PopOrEnd', 'Up10: AddToMoveScore 10',
    'PopOrEnd', `Fast: ${fast}`, 'Up100: AddToMoveScore 100', 'PopOrEnd', 'Down10: AddToMoveScore -10', 'PopOrEnd',
  ].join('\n');

  it('a slot refused for one draw only: Thunder Wave at P(fire), Reflect at P(miss)', () => {
    // Fired: Tackle (refused) +100 ties Thunder Wave, so the re-runs play Thunder Wave. Not fired: Reflect 110 alone.
    const model = modelWith(scriptWith(`IfMoveEqualTo ${ID.tackle}, Up100\nIfMoveEqualTo ${MOVE.reflect}, Down10\nPopOrEnd`));
    const { state, memory } = disabledTackle(model, true);
    expect(viewOf(state, memory).quickClawThisTurn[1]).toBeNull();
    const moves = movesOf(checked(state, model.support(state, memory)));
    expect(moves.map((entry) => entry.choice)).toEqual([move(0), move(1)]);
    expect(moves.map((entry) => entry.probability)).toEqual([mul(total(moves), FIRES), mul(total(moves), MISSES)]);
  });

  it('a draw for which every pick is refused is UNDEFINED, though the marginal has a usable pick; known, nothing branches', () => {
    const model = modelWith(scriptWith(`IfMoveEqualTo ${ID.tackle}, Up100\nAddToMoveScore -10\nPopOrEnd`));
    const { state, memory } = disabledTackle(model, true);
    expect(aiErrorCode(() => model.support(state, memory))).toBe('UNDEFINED');
    const notFired = editState(state, (b) => { b.formatData['kaizoSpeedRand'] = { p2: false }; }); // the engine's stored roll
    expect(moveChoices(model.support(notFired, memory))).toEqual([move(1)]);
  });

  it('at the root of a Quick Claw battle (no roll drawn yet) the move flips with the draw: both, at the prior', () => {
    // Fired: Tackle +10. Not fired: Reflect +10.
    const model = modelWith(scriptWith(`IfMoveEqualTo ${ID.tackle}, Up10\nPopOrEnd`));
    const start = createBattle(battle([MOVE.swordsDance], { item: FX.item.QUICK_CLAW }, BAG.none));
    expect(quickClawRolls(start)).toEqual({});
    expect(viewOf(start, model.initialMemory(start)).quickClawThisTurn).toEqual([null, null, null, null]);
    const moves = movesOf(checked(start, model.support(start, model.initialMemory(start))));
    expect(moves.map((entry) => entry.choice)).toEqual([move(1), move(2)]);
    expect(moves.map((entry) => entry.probability)).toEqual([mul(total(moves), MISSES), mul(total(moves), FIRES)]);
  });
});

describe('replacements read the cartridge state of the turn', () => {
  // The post-KO pick reads battleStatusMask and powerMul, reset after every action (battle_controller_player.c:3998): after
  // a KO they are 0 and 10 whatever ran. The AI's own mid-turn switch runs inside its switching action, before that reset.
  const model = modelWith(NOTHING);
  const EXACT = [{ choice: { kind: 'switch', index: 1 }, probability: ONE }];

  it.each([
    { name: 'Guillotine KO at full HP', moves: [ID.guillotine], lead: {}, hp: null, p2: 1 },
    { name: 'Seismic Toss KO (its IGNORE_TYPE_CHECKS reset at its MoveEnd)', moves: [MOVE.seismicToss], lead: { item: 0 }, hp: 1, p2: 1 },
    { name: 'Revenge KO (its powerMul of 20 reset at its MoveEnd)', moves: [MOVE.revenge], lead: {}, hp: 1, p2: 2 },
  ])('a $name: the replacement is the one switch at ONE', ({ moves, lead, hp, p2 }) => {
    const start = createBattle(battle(moves, lead));
    const memory = model.initialMemory(start);
    for (const outcome of outcomes(hp === null ? start : withEnemyHp(start, hp), move(0), move(p2), 'enemyReplacement')) {
      expect(model.replacementSupport(outcome.state, model.remember(memory, outcome))).toEqual(EXACT);
      expect(legalChoices(outcome.state, 'p2')).toEqual([EXACT[0]!.choice]);
    }
    expect(aiErrorCode(() => model.replacementSupport(start, memory))).toBe('BAD_VIEW'); // not a replacement
  });

  it('a Traced AI battler faints: exact, as the memory keeps the traced ability its BattleMon keeps', () => {
    // Trace copies Blaze (66); the cartridge's faint keeps it (battle_lib.c:2156–2210), Showdown's resets it.
    const start = createBattle(battle([ID.guillotine], ability(36)));
    const memory = model.initialMemory(start);
    expect([md(memory).aiTraced, md(memory).aiKept]).toEqual([66, []]);
    for (const outcome of outcomes(start, move(0), move(1), 'enemyReplacement')) {
      expect(model.replacementSupport(outcome.state, model.remember(memory, outcome))).toEqual(EXACT);
    }
  });

  it('a Transformed AI battler faints: UNDEFINED', () => {
    // Turn 1: Zigzagoon transforms into Monferno. Turn 2: Monferno's Guillotine knocks it out.
    const start = createBattle(battle([MOVE.swordsDance, ID.guillotine], { moves: [MOVE.transform, ID.tackle] }));
    const [turnOne] = expandTurn(start, { p1: move(0), p2: move(0) });
    const memory = model.remember(model.initialMemory(start), turnOne!);
    expect(md(memory).aiKept).toContain('mons.1.attack');
    for (const outcome of outcomes(turnOne!.state, move(1), move(0), 'enemyReplacement')) {
      expect(aiErrorCode(() => model.replacementSupport(outcome.state, model.remember(memory, outcome)))).toBe('UNDEFINED');
    }
  });

  it("the AI's U-turn: the mid-turn switch is exact, after a Pursuit at it too, and with a Pursuit TryPursuit doesn't run", () => {
    // Before the pick, TryPursuit sets powerMul 20 and hits the switcher if a foe yet to move chose Pursuit (battle_script.c:6898).
    const midTurn = (input: BattleInput): { outcome: Outcome; memory: AiMemory }[] => {
      const start = createBattle(input);
      return outcomes(start, move(0), move(0), 'enemyMidTurnSwitch').map((outcome) => ({ outcome, memory: model.remember(model.initialMemory(start), outcome) }));
    };
    for (const { outcome, memory } of midTurn(battle([MOVE.swordsDance], { moves: [ID.uTurn] }))) {
      expect(md(memory).switchAction).toEqual([ID.uTurn]);
      expect(model.replacementSupport(outcome.state, memory)).toEqual(EXACT);
    }
    // Zigzagoon at L60 outspeeds Monferno, whose Pursuit runs inside the AI's action and becomes the player's last move.
    const pursued = battle([MOVE.pursuit], { level: 60, moves: [ID.uTurn], item: 0 });
    for (const { outcome, memory } of midTurn(pursued)) {
      expect(md(memory)).toMatchObject({ switchAction: [ID.uTurn, MOVE.pursuit], lastMoveBy: [MOVE.pursuit, ID.uTurn] });
      const v = viewOf(outcome.state, memory);
      expect([v.powerMul, v.unknown]).toEqual([20, []]);
      expect(model.replacementSupport(outcome.state, memory)).toEqual(EXACT);
    }
    // Asleep or frozen, Monferno's Pursuit doesn't run and stays queued: the view applies TryPursuit's tests, so powerMul 10.
    for (const status of [{ kind: 'sleep', turns: 3 }, { kind: 'freeze' }] as const) {
      const still = createBattle({ ...pursued, startStatus: { 0: status } });
      for (const outcome of outcomes(still, move(0), move(0), 'enemyMidTurnSwitch')) {
        const queue = peekBattle(outcome.state).queue.list;
        expect(queue.some((action) => action.choice === 'move' && action.move.num === MOVE.pursuit), status.kind).toBe(true);
        // The queued Pursuit is an active-move copy the engine's freeze skips: frozen here, so a write to it would throw.
        for (const action of queue) if ('move' in action) Object.freeze(action.move);
        const memory = model.remember(model.initialMemory(still), outcome);
        expect(model.replacementSupport(outcome.state, memory), status.kind).toEqual(EXACT);
        const v = viewOf(outcome.state, memory);
        expect([v.powerMul, v.unknown], status.kind).toEqual([10, []]);
      }
    }
  }, 30_000);
});

describe('the memory', () => {
  // TrainerAI_Main records the player's last move (trainer_ai.c:2705) when the AI chose Fight and its move wasn't forced.
  const model = modelWith(NOTHING);
  type At = { state: EngineState; memory: AiMemory };
  const known = (memory: AiMemory): number[] => md(memory).knowledge.battlerMoves[0]!;
  const begin = (input: BattleInput): At => {
    const state = createBattle(input);
    return { state, memory: model.initialMemory(state) };
  };
  /** One step from `at` down its first outcome, folded into its memory. */
  function step(at: At, p1?: Choice, p2?: Choice): At {
    const [outcome] = expandTurn(at.state, { ...(p1 ? { p1 } : {}), ...(p2 ? { p2 } : {}) });
    return { state: outcome!.state, memory: model.remember(at.memory, outcome!) };
  }

  it('records the move p1 used while the AI fought, at the next decision (trainer_ai.c:2705); remember is pure, and checks names', () => {
    // +1 to Tackle while the player's Swords Dance is known.
    const model = modelWith(`IfMoveNotEqualTo ${ID.tackle}, Done\nIfMoveKnown 0, ${MOVE.swordsDance}, Bonus\nDone: PopOrEnd\nBonus: AddToMoveScore 1\nPopOrEnd`);
    const start = createBattle(battle([MOVE.swordsDance]));
    const memory = model.initialMemory(start);
    for (const outcome of expandTurn(start, { p1: move(0), p2: move(1) })) {
      const after = model.remember(memory, outcome);
      expect([md(after).lastMoveBy[0], after.key === memory.key]).toEqual([MOVE.swordsDance, false]);
      expect(model.remember(memory, outcome)).toEqual(after);
      // Remembered, Tackle scores 101 and is picked alone (the rest of the mass is the switch check's); fresh, four tie.
      expect(moveChoices(checked(outcome.state, model.support(outcome.state, after)))).toEqual([move(2)]);
      expect(moveChoices(model.support(outcome.state, memory))).toEqual([0, 1, 2, 3].map(move));
    }
    expect(memory.data).toEqual({ ...initialMemoryData(null), turnFight: 'menu' });
    // A name the battle does not know.
    const [outcome] = expandTurn(start, { p1: move(0), p2: move(1) });
    expect(aiErrorCode(() => model.remember(memory, { ...outcome!, log: ['|move|p1a: Monferno|Not A Move|p2a: Zigzagoon'] }))).toBe('BAD_VIEW');
  });

  it('initialMemory folds a battle start, restored too, and refuses any later state', () => {
    // Pressure's message tags its holder's ability (subscript_pressure.s:6); Intimidate's is a stat drop's, which records nothing.
    const withAbility = (value: number): EngineState => {
      const input = battle([MOVE.swordsDance]);
      return createBattle({ ...input, player: [{ ...input.player[0]!, ...ability(value) }] });
    };
    const [pressure, intimidate] = [withAbility(46), withAbility(22)];
    expect(battleStartLog(pressure)).toContain('|-ability|p1a: Monferno|Pressure');
    expect(battleStartLog(intimidate)).toContain('|-ability|p1a: Monferno|Intimidate|boost');
    expect([pressure, intimidate].map((s) => md(model.initialMemory(s)).knowledge.battlerAbilities)).toEqual([[46, 0, 0, 0], [0, 0, 0, 0]]);
    const restored = withEnemyHp(pressure, 40);
    expect([restored.turn, restored.phase.kind]).toEqual([1, 'turnChoice']);
    expect(model.initialMemory(restored)).toEqual(model.initialMemory(pressure));
    const later = [
      firstOf(pressure, move(0), move(1)),
      outcomes(createBattle(battle([ID.guillotine])), move(0), move(1), 'enemyReplacement')[0]!.state,
      firstOf(createBattle(battle([MOVE.swordsDance], { moves: [ID.uTurn] })), move(0), move(0)),
    ];
    expect(later.map((s) => [s.turn, s.phase.kind])).toEqual([[2, 'turnChoice'], [1, 'enemyReplacement'], [1, 'enemyMidTurnSwitch']]);
    for (const s of later) expect(aiErrorCode(() => model.initialMemory(s))).toBe('BAD_VIEW');
  });

  it("an AI that faints before acting records the player's move: TrainerAI_Main ran at the command selection", () => {
    const one = step(begin(battle([MOVE.swordsDance, ID.guillotine])), move(0), move(1));
    expect(md(one.memory).turnFight).toBe('menu');
    for (const outcome of outcomes(one.state, move(1), move(2), 'enemyReplacement')) {
      expect(outcome.log.some((line) => line.startsWith('|move|p2a'))).toBe(false);
      expect(known(model.remember(one.memory, outcome))).toEqual([MOVE.swordsDance, 0, 0, 0]);
    }
  });

  it("a player's Pursuit at the AI's switch is the player's last move, and the next TrainerAI_Main records it", () => {
    // Monferno at L60, so Bidoof's Water Ball can't knock it out (a faint would clear the record, battle_lib.c:2223).
    const moves = [MOVE.pursuit, MOVE.swordsDance];
    const input = battle(moves, { item: 0 });
    input.player = [playerMon(ID.monferno, 60, [ID.ember], { moves, pp: [20, 30], ppUps: [0, 0], item: FX.item.LEFTOVERS })];
    const start = begin(input);
    const one = outcomes(start.state, move(0), { kind: 'switch', index: 1 }, 'turnChoice')
      .find((o) => o.log.some((line) => line.includes('|Pursuit|') && line.includes('[from] Pursuit')));
    expect(one).toBeDefined();
    const memory = model.remember(start.memory, one!);
    expect(md(memory).lastMoveBy[0]).toBe(MOVE.pursuit);
    const [two] = outcomes(one!.state, move(1), move(0), 'turnChoice');
    expect(known(model.remember(memory, two!))).toEqual([MOVE.pursuit, 0, 0, 0]);
  });

  it('an Encore-locked AI records nothing: Fight takes the encored move with no move menu', () => {
    // Turn 2: Monferno's Encore locks Zigzagoon into Reflect; TrainerAI_Main ran at its command selection. Turn 3: no menu.
    const two = step(step(begin(battle([MOVE.swordsDance, MOVE.encore])), move(0), move(1)), move(1), move(0));
    expect([known(two.memory), md(two.memory).turnFight]).toEqual([[MOVE.swordsDance, 0, 0, 0], 'forced']);
    expect(known(step(two, move(0), move(1)).memory)).toEqual([MOVE.swordsDance, 0, 0, 0]);
  });

  it('a recharging AI records nothing: Battler_CanPickCommand is FALSE, so no command selection', () => {
    // The engine's Hyper Beam doesn't lock yet, so Zigzagoon gets Showdown's recharge volatile by hand after turn 1.
    const start = begin(battle([MOVE.swordsDance, MOVE.disable]));
    const [turnOne] = expandTurn(start.state, { p1: move(0), p2: move(1) });
    const recharging = model.remember(start.memory, { ...turnOne!, state: editState(turnOne!.state, (b) => b.p2.active[0]!.addVolatile('mustrecharge')) });
    expect(md(recharging).turnFight).toBe('forced');
    const turnTwo = { ...turnOne!, log: ['|cant|p2a: Zigzagoon|recharge', '|move|p1a: Monferno|Disable|p2a: Zigzagoon'] };
    expect(known(model.remember(recharging, turnTwo))).toEqual([0, 0, 0, 0]);
    expect(known(model.remember(model.remember(start.memory, turnOne!), turnTwo))).toEqual([MOVE.swordsDance, 0, 0, 0]); // free
  });

  it('a turn of several steps records once, at the first, the move the player had used before the turn', () => {
    // Turn 2: the player's U-turn (Monferno is faster) ends a step at its mid-turn switch; the turn goes on after it.
    const input = battle([MOVE.swordsDance, ID.uTurn]);
    input.player = [...input.player, playerMon(ID.bidoof, 25, [ID.waterBall])];
    const first = step(step(begin(input), move(0), move(1)), move(1), move(1));
    expect(first.state.phase.kind).toBe('playerMidTurnSwitch');
    expect([known(first.memory), md(first.memory).turnFight]).toEqual([[MOVE.swordsDance, 0, 0, 0], null]);
    // Bidoof's switch-in cleared the record (battle_lib.c:2151); the AI's Reflect in this step recorded nothing again.
    expect(known(step(first, { kind: 'switch', index: 1 }).memory)).toEqual([0, 0, 0, 0]);
  });

  it("the AI's bag item clears what last hit it: ShouldSwitch's moveHit reads none after it", () => {
    // Zigzagoon at L60 moves first; Tackle hits it. Turn 2: its Full Restore's MoveEnd clears its moveHit (battle_controller_player.c:4389).
    const hit = ({ state, memory }: At) => [md(memory).lastHitBy, viewOf(state, memory).moveHit[1], viewOf(state, memory).moveHitBattler[1]];
    const one = step(begin(battle([ID.tackle, MOVE.swordsDance], { level: 60 }, BAG.fullRestore)), move(0), move(1));
    expect(hit(one)).toEqual([{ move: ID.tackle, battler: 0 }, ID.tackle, 0]);
    expect(hit(step(one, move(1), { kind: 'item', item: 'fullrestore' }))).toEqual([null, 0, 0xff]);
  });

  it("an Imprison holder's decision reads the foe's mark: exact at the start, after its own failed Imprison, BAD_VIEW without it", () => {
    // Basic_CheckCanImprison (script.s:917–921): −10 under its own Imprison or when the foe has the mark, set even by a failed one.
    const model = modelWith([
      'IfCurrentMoveEffectEqualTo 192, CheckCanImprison', 'PopOrEnd',
      `CheckCanImprison: IfMoveEffect ${AI_BATTLER_ATTACKER}, ${MOVE_EFFECT_IMPRISON}, ScoreMinus10`,
      `IfMoveEffect ${AI_BATTLER_DEFENDER}, ${MOVE_EFFECT_IMPRISONED}, ScoreMinus10`, 'PopOrEnd', 'ScoreMinus10: AddToMoveScore -10', 'PopOrEnd',
    ].join('\n'));
    // Monferno knows only Swords Dance, so Zigzagoon's Imprison fails (Showdown: no shared move, no volatile).
    const start = createBattle(battle([MOVE.swordsDance], { moves: [MOVE.imprison, MOVE.reflect, ID.tackle, ID.meanLook] }, BAG.none));
    const memory = model.initialMemory(start);
    expect(md(memory).imprisonedMark).toEqual([false, false]);
    const tie = movesOf(checked(start, model.support(start, memory)));
    expect(tie.map((entry) => entry.choice)).toEqual([0, 1, 2, 3].map(move));
    expect(tie.map((entry) => entry.probability)).toEqual(tie.map(() => tie[0]!.probability));
    for (const outcome of outcomes(start, move(0), move(0))) {
      expect(outcome.log).toContain('|-fail|p2a: Zigzagoon');
      const after = model.remember(memory, outcome);
      expect([md(after).imprisonedMark, viewOf(outcome.state, after).unknown]).toEqual([[true, false], []]);
      // Turn 2: Imprison 90, the other three tie at 100, drawn by RandNext() % 3: residue 0 has 21846 of the 65536 values.
      const picks = movesOf(checked(outcome.state, model.support(outcome.state, after)));
      expect(picks.map((entry) => entry.choice)).toEqual([1, 2, 3].map(move));
      expect(picks.map((entry) => entry.probability)).toEqual([21846, 21845, 21845].map((n) => mul(total(picks), rat(n, 65536))));
    }
    const old: Partial<AiMemoryData> = { ...md(memory) };
    delete old.imprisonedMark; // a memory without the mark is not the trainer AI's
    expect(aiErrorCode(() => model.support(start, { key: 'old', data: old }))).toBe('BAD_VIEW');
  });
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe("the peeked battle: the engine's peek, one frozen battle per state object, never written", () => {
  it("peekBattle is the engine's (frozen) peek: one battle per state object, and another for another object", () => {
    const state = createBattle(battle([ID.ember]));
    const peeked = peekBattle(state);
    expect(peek(state)).toBe(peeked);
    expect(peekBattle(state)).toBe(peeked);
    const twin = peekBattle({ ...state });
    expect(twin).not.toBe(peeked);
    expect(twin.p2.active[0]!.moveSlots).toEqual(peeked.p2.active[0]!.moveSlots);
  });

  it('keeps one base view per read and (data, ai): another state object, ai or dex install has its own; a peek eviction keeps it', () => {
    const state = createBattle(battle([ID.ember]));
    const ai = romWith();
    const memory = initialMemoryData(null);
    const first = viewFromState(state, data, ai, memory);
    const json = JSON.stringify(first);
    expect(viewFromState(state, data, ai, memory).parties).toBe(first.parties);
    // Another ai has its own base; the first ai's is then built anew. Another object of the state has its own, equal.
    const heavier = { ...ai, weights: ai.weights.map((w) => w + 1), formWeights: ai.formWeights.map((w) => w + 1) };
    expect(viewFromState(state, data, heavier, memory).mons[1].weight).toBe(first.mons[1].weight + 1);
    const back = viewFromState(state, data, ai, memory);
    expect([back.parties === first.parties, JSON.stringify(back)]).toEqual([false, json]);
    const twin = viewFromState({ ...state }, data, ai, memory);
    expect([twin.parties === back.parties, JSON.stringify(twin)]).toEqual([false, json]);
    // The engine evicts the state's peek once PEEK_LIMIT other states were peeked since: the same read, so the same base.
    const peeked = peekBattle(state);
    for (let i = 0; i < PEEK_LIMIT; i++) peekBattle({ ...state });
    expect(peekBattle(state)).not.toBe(peeked);
    const evicted = viewFromState(state, data, ai, memory);
    expect(evicted.parties).toBe(back.parties);
    // A dex reinstall: the source reads the state again, so a new base.
    const kept = peekBattle(state);
    installKaizoDex(data, buildMoves(data));
    expect(peekBattle(state)).not.toBe(kept);
    const reinstalled = viewFromState(state, data, ai, memory);
    expect([reinstalled.parties === evicted.parties, JSON.stringify(reinstalled)]).toEqual([false, json]);
  });

  it('every EnemyModel call reads its peeked battle and base view without writing: a solver-shaped walk', () => {
    // The root, one turn and a replacement step, walked `fresh` (each call gets a new object of its state) and twice shared (the
    // state itself, its base view and the active-move copies the engine's freeze skips frozen). The dex freezes its Species.
    const start = withEnemyHp(createBattle(battle([ID.ember, ID.tackle, MOVE.swordsDance], {}, BAG.none)), 1);
    const sample = peekBattle(start);
    expect([...sample.p1.pokemon, ...sample.p2.pokemon].every((p) => Object.isFrozen(p.species) && Object.isFrozen(p.baseSpecies))).toBe(true);
    const ai = romWith(COINS);
    let copies = 0;
    const walk = (fresh: boolean): string[] => {
      const model = createTrainerAi(data, ai);
      const seen: string[] = [];
      const text = (value: unknown): string => JSON.stringify(value, (_key, x: unknown) => (typeof x === 'bigint' ? String(x) : x));
      const handed = (state: EngineState, memory: AiMemory | null): EngineState => {
        if (fresh) return { ...state };
        const peeked = peekBattle(state);
        expect(Object.isFrozen(peeked) && Object.isFrozen(peeked.p2.active[0]!)).toBe(true);
        const freezeCopy = (copy: object | null | undefined): void => {
          if (!copy || !Object.hasOwn(copy, 'hit')) return; // a plain move is the dex's; an active-move copy has its own `hit`
          deepFreeze(copy);
          copies += 1;
        };
        for (const pokemon of [...peeked.p1.pokemon, ...peeked.p2.pokemon]) freezeCopy(pokemon.lastMove);
        for (const action of peeked.queue.list) if ('move' in action) freezeCopy(action.move);
        if (memory !== null) {
          try {
            deepFreeze(viewFromState(state, data, ai, md(memory)));
          } catch (error) {
            if (!(error instanceof AiError)) throw error;
          }
        }
        return state;
      };
      const decide = (state: EngineState, memory: AiMemory): ActionSupport[] => {
        const kind = state.phase.kind;
        if (kind === 'turnChoice') return model.support(handed(state, memory), memory);
        if (kind !== 'enemyReplacement' && kind !== 'enemyMidTurnSwitch') return [];
        seen.push('replacement');
        return model.replacementSupport(handed(state, memory), memory);
      };
      const remember = (memory: AiMemory, outcome: Outcome): AiMemory => model.remember(memory, { ...outcome, state: handed(outcome.state, memory) });
      const startMemory = model.initialMemory(handed(start, null));
      const first = decide(start, startMemory);
      seen.push(startMemory.key, text(first));
      for (const action of first) {
        for (const outcome of expandTurn(start, { p1: move(0), p2: action.choice })) {
          const memory = remember(startMemory, outcome);
          const support = decide(outcome.state, memory);
          seen.push(memory.key, text(support));
          if (outcome.state.phase.kind !== 'enemyReplacement') continue;
          for (const send of support) {
            for (const later of expandTurn(outcome.state, { p2: send.choice })) {
              const after = remember(memory, later);
              seen.push(after.key, text(decide(later.state, after)));
            }
          }
        }
      }
      return seen;
    };
    const fresh = walk(true);
    expect(walk(false)).toEqual(fresh);
    expect(walk(false)).toEqual(fresh); // everything cached by then
    expect(fresh.length).toBeGreaterThan(6);
    expect(fresh).toContain('replacement');
    expect(copies).toBeGreaterThan(0); // some battler's lastMove copy was frozen before the AI read it
  }, 60_000);
});
