// viewFromState: the engine's Showdown state as the AI's cartridge-shaped AiView (view fields, not odds).

import { beforeAll, describe, expect, it } from 'vitest';
import { accessorState, CUT_CAPACITY, fieldNoteOf, peekBattle, protocolIds, startLogOf, trainerOf, viewFromState } from '../../../src/ai/adapter.js';
import { decide } from '../../../src/ai/choose/decide.js';
import { replacement } from '../../../src/ai/choose/postKo.js';
import {
  ABILITY_NONE, ABILITY_SLOW_START, BATTLE_STAT, BATTLE_TYPE_TRAINER, BATTLER_NONE, FIELD_CONDITION_DEEP_FOG, FIELD_CONDITION_HAILING_PERM,
  FIELD_CONDITION_HAILING_TEMP, FIELD_CONDITION_RAINING_PERM, FIELD_CONDITION_RAINING_TEMP, FIELD_CONDITION_SANDSTORM_PERM,
  FIELD_CONDITION_SANDSTORM_TEMP, FIELD_CONDITION_SUNNY_PERM, FIELD_CONDITION_SUNNY_TEMP, GENDER_MALE, ITEM_NONE, MON_CONDITION_PARALYSIS,
  MON_CONDITION_TOXIC, MOVE_EFFECT_ABILITY_SUPPRESSED, MOVE_EFFECT_EMBARGO, MOVE_EFFECT_IMPRISON, MOVE_EFFECT_IMPRISONED, MOVE_EFFECT_INGRAIN,
  MOVE_EFFECT_LEECH_SEED, MOVE_EFFECT_LEECH_SEED_RECIPIENT, MOVE_EFFECT_MAGNET_RISE, MOVE_EFFECT_PERISH_SONG, MOVE_NONE,
  SIDE_CONDITION_REFLECT, SIDE_CONDITION_SPIKES, SIDE_CONDITION_TAILWIND, USE_MAX_DAMAGE, VOLATILE_CONDITION_CONFUSION,
  VOLATILE_CONDITION_MEAN_LOOK, VOLATILE_CONDITION_TORMENT, VOLATILE_CONDITION_TRANSFORM, VOLATILE_CONDITION_UPROAR,
} from '../../../src/ai/constants.js';
import { AiError } from '../../../src/ai/errors.js';
import { battlerAbility, heldItem } from '../../../src/ai/lib/battler.js';
import { invalidMoves } from '../../../src/ai/lib/invalidMoves.js';
import { PATHS } from '../../../src/ai/lib/known.js';
import { type AiMemoryData, initialMemoryData, rememberStep } from '../../../src/ai/memory.js';
import { fightKind } from '../../../src/ai/model.js';
import { add, ZERO } from '../../../src/ai/odds.js';
import type { AiRomData } from '../../../src/ai/rom/aiData.js';
import { type AiView, EMPTY_MON } from '../../../src/ai/view.js';
import { buildMoves } from '../../../src/battle/moves.js';
import type { ResolvedMon } from '../../../src/battle/types.js';
import type { BattleInput, Choice, EngineState, Outcome } from '../../../src/contracts/engine.js';
import {
  bagItemId, battleField, battleStartLog, battleTrainer, createBattle, installKaizoDex, lastSpeedValues, legalChoices, ONE, quickClawRolls, restore,
} from '../../../src/engine/index.js';
import { computeStats } from '../../../src/rom/stats.js';
import type { Stats } from '../../../src/rom/types.js';
import { BAG, ID, playerMon } from '../engine/fixtures.js';
import { emptyKnowledge, fixtureDeps, FX } from './fixtures.js';
import { ability, aiErrorCode, battle, editState, firstOf, flagScript, modelData, MOVE, move, outcomes, romWith, weightTable } from './modelHarness.js';

const data = modelData();
beforeAll(() => installKaizoDex(data, buildMoves(data)));
const ai = romWith();
const deps = fixtureDeps();

const view = (state: EngineState, memory: AiMemoryData = initialMemoryData(null), rom: AiRomData = ai): AiView =>
  viewFromState(state, data, rom, memory);
const memoryWith = (fields: Partial<AiMemoryData>): AiMemoryData => ({ ...initialMemoryData(null), ...fields });
/** Monferno knows Swords Dance, Spikes, Disable and Ember; the bag is Potion, X Attack, Potion, Super Potion. */
const baseInput = () => battle([MOVE.swordsDance, MOVE.spikes, MOVE.disable, ID.ember]);
const start = (): EngineState => createBattle(baseInput());
/** Monferno knows `moves`, Zigzagoon has `lead`'s fields, and Bidoof knows only Mean Look. */
const inputWith = (moves: number[], lead: Partial<ResolvedMon> = {}) => battle(moves, lead, BAG.potions, [ID.meanLook]);
const states = (state: EngineState, p1?: Choice, p2?: Choice, phase?: EngineState['phase']['kind']): EngineState[] =>
  outcomes(state, p1, p2, phase).map((outcome) => outcome.state);
/** Monferno's Guillotine (a hit or a miss, no other draw) knocks out Zigzagoon before it moves. */
const knockedOut = () => states(createBattle(inputWith([ID.guillotine])), move(0), move(1), 'enemyReplacement');
const bitsOf = (v: AiView, flag: number): number[] => [v.mons[0].moveEffectsMask & flag, v.mons[1].moveEffectsMask & flag];

const neutral = [6, 6, 6, 6, 6, 6, 6, 6];
const ivs31: Stats = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
const stats = (base: Stats, level: number): Stats => computeStats(base, ivs31, { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, level, 0);
// The fixture's base stats (test/unit/engine/fixtures.ts).
const MONFERNO = stats({ hp: 64, atk: 78, def: 52, spa: 78, spd: 52, spe: 81 }, 30);
const ZIGZAGOON = stats({ hp: 38, atk: 30, def: 41, spa: 30, spd: 41, spe: 60 }, 20);
const BIDOOF = stats({ hp: 101, atk: 102, def: 103, spa: 104, spd: 105, spe: 106 }, 25);

describe('viewFromState', () => {
  it('view mirrors the battle, and is pure', () => {
    const state = start();
    const json = state.json;
    const v = view(state);
    const battler = (s: Stats) => ({ curHP: s.hp, maxHP: s.hp, attack: s.atk, defense: s.def, spAttack: s.spa, spDefense: s.spd, speed: s.spe });
    // Leads were never switched in by BattleSystem_UpdateAfterSwitch, so their turn numbers are the cleared 0.
    const mon = { form: 0, gender: GENDER_MALE, friendship: 70, ivs: ivs31, statBoosts: neutral, status: 0, statusVolatile: 0, moveEffectsMask: 0, effects: EMPTY_MON.effects };
    expect(v).toMatchObject({
      mons: [
        { ...mon, ...battler(MONFERNO), species: ID.monferno, level: 30, types: [10, 1], ability: 66, heldItem: FX.item.LEFTOVERS, weight: 220,
          moves: [MOVE.swordsDance, MOVE.spikes, MOVE.disable, ID.ember], ppCur: [30, 20, 20, 25], ppMax: [30, 20, 20, 25] },
        { ...mon, ...battler(ZIGZAGOON), species: ID.zigzagoon, level: 20, types: [0, 0], ability: 82, heldItem: FX.item.SITRUS_BERRY, weight: 175,
          moves: [MOVE.thunderWave, MOVE.reflect, ID.tackle, ID.meanLook], ppCur: [20, 20, 35, 5], ppMax: [20, 20, 35, 5] },
        EMPTY_MON, EMPTY_MON,
      ],
      parties: [
        [{ species: ID.monferno, form: 0, level: 30, hp: MONFERNO.hp, maxHp: MONFERNO.hp, status: 0, moves: [MOVE.swordsDance, MOVE.spikes, MOVE.disable, ID.ember],
          pp: [30, 20, 20, 25], ppMax: [30, 20, 20, 25], heldItem: FX.item.LEFTOVERS, ability: 66, types: [10, 1], ivs: ivs31 }],
        [expect.anything(), { species: ID.bidoof, form: 0, level: 25, hp: BIDOOF.hp, maxHp: BIDOOF.hp, status: 0, moves: [ID.waterBall, 0, 0, 0],
          pp: [15, 0, 0, 0], ppMax: [15, 0, 0, 0], heldItem: 0, ability: 33, types: [11, 16], ivs: ivs31 }],
      ],
      battleType: BATTLE_TYPE_TRAINER, selectedPartySlot: [0, 0, 0, 0], aiSwitchedPartySlot: [6, 6, 6, 6], totalTurns: 0,
      fieldConditionsMask: 0, battleStatusMask: 0, powerMul: 10, sideConditionsMask: [0, 0],
      sideConditions: [{ spikesLayers: 0, toxicSpikesLayers: 0 }, { spikesLayers: 0, toxicSpikesLayers: 0 }],
      movePrevByBattler: [0, 0, 0, 0], moveHit: [0, 0, 0, 0], moveHitBattler: [BATTLER_NONE, BATTLER_NONE, BATTLER_NONE, BATTLER_NONE],
      moveProtect: [0, 0, 0, 0], recycleItem: [0, 0, 0, 0], battlersSwitchingMask: (1 << 2) | (1 << 3),
      monSpeedValues: [MONFERNO.spe, ZIGZAGOON.spe, 0, 0], quickClawThisTurn: [null, null, null, null],
      trainerItems: [17, 57, 17, 26], trainerItemCount: 4, unknown: [],
      turnFlags: Array.from({ length: 4 }, () => ({ roosting: false, helpingHand: false })),
    });
    expect(view(state)).toEqual(v);
    expect(state.json).toBe(json);
  });

  it('status, stages, PP and the speed compare map', () => {
    // Swords Dance, then Thunder Wave on Monferno: the next turn start's sort writes its quartered Speed (battle_lib.c:1259).
    for (const state of states(start(), move(0), move(0))) {
      expect(view(state)).toMatchObject({
        totalTurns: 1, monSpeedValues: [Math.floor(MONFERNO.spe / 4), ZIGZAGOON.spe, 0, 0],
        mons: { 0: { status: MON_CONDITION_PARALYSIS, statBoosts: { [BATTLE_STAT.ATTACK]: 8 } }, 1: { status: 0, statBoosts: neutral, ppCur: { 0: 19 } } },
        parties: { 0: { 0: { status: MON_CONDITION_PARALYSIS } } },
      });
    }
  });

  it('side conditions and Mean Look map', () => {
    // Turn 1: Spikes, and Zigzagoon's Reflect. Turn 2: Spikes again, and Mean Look on Monferno.
    for (const state of states(firstOf(start(), move(1), move(1)), move(1), move(3))) {
      const v = view(state);
      expect(v).toMatchObject({
        sideConditionsMask: [0, SIDE_CONDITION_SPIKES | SIDE_CONDITION_REFLECT],
        sideConditions: [{ spikesLayers: 0, toxicSpikesLayers: 0 }, { spikesLayers: 2, toxicSpikesLayers: 0 }],
      });
      expect(v.mons[0].statusVolatile & VOLATILE_CONDITION_MEAN_LOOK).not.toBe(0);
    }
  });

  it('hidden counters map: toxic exactly, confusion non-zero', () => {
    // Turn 1: Toxic on Zigzagoon (its counter 1 at the turn's end). Turn 2: Confuse Ray (and the counter 2).
    const afterOne = states(createBattle(inputWith([MOVE.toxic, MOVE.confuseRay])), move(0), move(1));
    for (const state of afterOne) expect(view(state).mons[1].status).toBe(MON_CONDITION_TOXIC | (1 << 8));
    for (const state of states(afterOne[0]!, move(1), move(1))) {
      const v = view(state);
      const confusion = v.mons[1].statusVolatile & VOLATILE_CONDITION_CONFUSION;
      expect([v.mons[1].status, v.parties[1][0]!.status, v.mons[1].statusVolatile - confusion]).toEqual([MON_CONDITION_TOXIC | (2 << 8), MON_CONDITION_TOXIC | (2 << 8), 0]);
      expect(confusion).not.toBe(0);
    }
  });

  it('the turn a battler came in maps exactly; a fainted battler maps as the cartridge cleans it up, keeping its status', () => {
    // Bidoof comes in during turn 1 (totalTurns 0): its turn number is 1, so LoadIsFirstTurnInBattle holds on turn 2 only.
    const state = firstOf(createBattle(inputWith([MOVE.swordsDance])), move(0), { kind: 'switch', index: 1 });
    expect(view(state)).toMatchObject({
      totalTurns: 1, selectedPartySlot: [0, 1, 0, 0],
      mons: { 0: { effects: { fakeOutTurnNumber: 0 } }, 1: { species: ID.bidoof, effects: { fakeOutTurnNumber: 1, slowStartTurnNumber: 1 } } },
    });
    expect(view(firstOf(state, move(0), move(0)))).toMatchObject({ totalTurns: 2, mons: { 1: { effects: { fakeOutTurnNumber: 1 } } } });
    for (const state of knockedOut()) {
      // BattleSystem_CleanupFaintedMon: totalTurns + 1 (battle_lib.c:2195).
      expect(view(state)).toMatchObject({
        totalTurns: 0, selectedPartySlot: [0, 0, 0, 0], battlersSwitchingMask: (1 << 2) | (1 << 3), monSpeedValues: { 0: MONFERNO.spe },
        mons: { 1: { species: ID.zigzagoon, curHP: 0, status: 0, statusVolatile: 0, moveEffectsMask: 0, statBoosts: neutral, effects: { fakeOutTurnNumber: 1 } } },
        parties: { 1: { 0: { hp: 0, status: 0 } } },
      });
    }
    // Toxic first: the faint keeps BattleMon.status (battle_lib.c:2156–2210); only the party copy is sent as 0.
    const poisoned = firstOf(createBattle(inputWith([MOVE.toxic, ID.guillotine])), move(0), move(1));
    for (const state of states(poisoned, move(1), move(1), 'enemyReplacement')) {
      expect(restore(state).p2.active[0]!.status).toBe('fnt');
      expect(view(state)).toMatchObject({ mons: { 1: { status: MON_CONDITION_TOXIC | (1 << 8) } }, parties: { 1: { 0: { hp: 0, status: 0 } } } });
    }
  });

  it('keeps a slot the cartridge can pick but not use (0 PP, Disabled) where the request has it', () => {
    // Zigzagoon's Mean Look five times, then Tackle; then Monferno Disables the Tackle while Zigzagoon uses Reflect.
    let state = start();
    for (let i = 0; i < 5; i++) state = firstOf(state, move(0), move(3));
    state = firstOf(firstOf(state, move(0), move(2)), move(2), move(1));
    const zigzagoon = view(state).mons[1];
    expect(zigzagoon).toMatchObject({
      moves: [MOVE.thunderWave, MOVE.reflect, ID.tackle, ID.meanLook], ppCur: [20, 19, 34, 0], ppMax: [20, 20, 35, 5], effects: { disabledMove: ID.tackle },
    });
    expect(zigzagoon.effects.disabledTurns).toBeGreaterThan(0);
    expect(legalChoices(state, 'p2').filter((choice) => choice.kind === 'move')).toEqual([move(0), move(1)]); // usable slots only
  });
});

describe('viewFromState: the field', () => {
  // Showdown's weather duration picks the bit: a move's lasts 5 turns (_TEMP), a Gen 4 ability's never ends (0, _PERM).
  it.each([
    { name: 'rain', weatherMove: MOVE.rainDance, weatherAbility: 2, temp: FIELD_CONDITION_RAINING_TEMP, perm: FIELD_CONDITION_RAINING_PERM },
    { name: 'sun', weatherMove: MOVE.sunnyDay, weatherAbility: 70, temp: FIELD_CONDITION_SUNNY_TEMP, perm: FIELD_CONDITION_SUNNY_PERM },
    { name: 'sand', weatherMove: MOVE.sandstorm, weatherAbility: 45, temp: FIELD_CONDITION_SANDSTORM_TEMP, perm: FIELD_CONDITION_SANDSTORM_PERM },
    { name: 'hail', weatherMove: MOVE.hail, weatherAbility: 117, temp: FIELD_CONDITION_HAILING_TEMP, perm: FIELD_CONDITION_HAILING_PERM },
  ])("$name: a move's is the _TEMP bit, ability $weatherAbility's the _PERM bit", ({ weatherMove, weatherAbility, temp, perm }) => {
    const weather = (state: EngineState) => [restore(state).field.weatherState.duration, view(state).fieldConditionsMask];
    expect(weather(firstOf(createBattle(inputWith([weatherMove])), move(0), move(1)))).toEqual([4, temp]);
    const fromAbility = createBattle(inputWith([MOVE.swordsDance], ability(weatherAbility)));
    for (const state of [fromAbility, firstOf(fromAbility, move(0), move(1))]) expect(weather(state)).toEqual([0, perm]);
  });

  it("the trainer's field note is the _PERM weather, Trick Room and Gravity; one the battle already shows isn't listed", () => {
    // The cartridge's overworld weather is _PERM (subscript_overworld_rain.s:11); Trick Room and Gravity never end: 1.
    const noted = createBattle({ ...inputWith([MOVE.swordsDance]), field: { weather: 'rain', trickRoom: true, gravity: true } });
    expect(restore(noted).field.weather).toBe('raindance');
    expect(view(noted)).toMatchObject({ fieldConditionsMask: FIELD_CONDITION_RAINING_PERM | (1 << 12) | (1 << 16), unknown: [] });
    // A Drizzle lead's rain, and a Rain Dance into the note's rain, which fails on the cartridge and in the engine.
    const drizzle = createBattle({ ...inputWith([MOVE.swordsDance], ability(2)), field: { weather: 'rain' } });
    const rainDance = firstOf(createBattle({ ...inputWith([MOVE.rainDance]), field: { weather: 'rain' } }), move(0), move(1));
    for (const state of [drizzle, rainDance]) expect(view(state)).toMatchObject({ fieldConditionsMask: FIELD_CONDITION_RAINING_PERM, unknown: [] });
  });

  it("Trick Room and Gravity map to their counters, with a note or not, and Uproar sets its battler's field bit", () => {
    // Monferno's Gravity, then Zigzagoon's Trick Room (−7): the hack re-arms both, so the counter is 1.
    const used = (field: BattleInput['field']) => view(firstOf(createBattle({ ...inputWith([MOVE.gravity], { moves: [MOVE.trickRoom] }), field }), move(0), move(0)));
    expect(used({})).toMatchObject({ fieldConditionsMask: (1 << 12) | (1 << 16), unknown: [] });
    expect(used({ trickRoom: true, gravity: true }).unknown).toEqual([]); // the note's, which the battle shows: not listed
    const uproar = view(firstOf(createBattle(inputWith([MOVE.uproar])), move(0), move(1)));
    expect(uproar.fieldConditionsMask).toBe(1 << 8); // FlagIndex(0) << FIELD_CONDITION_UPROAR_SHIFT
    expect(uproar.mons.slice(0, 2).map((mon) => (mon.statusVolatile & VOLATILE_CONDITION_UPROAR) !== 0)).toEqual([true, false]);
  });

  it('a field note of fog gives the deep fog bit; a weather since clears it, a Defog since lists it unknown', () => {
    // Showdown has no fog: the note and the memory give it, as the battle start sets it (subscript_overworld_fog.s:11).
    const fog = (state: EngineState, memory = initialMemoryData(null)) => [view(state, memory).fieldConditionsMask, view(state, memory).unknown];
    const foggy = createBattle({ ...baseInput(), field: { fog: true } });
    expect(fog(foggy)).toEqual([FIELD_CONDITION_DEEP_FOG, []]);
    expect(fog(createBattle({ ...baseInput(), field: { fog: false } }))).toEqual([0, []]);
    expect(fog(foggy, memoryWith({ fog: 'cleared' }))).toEqual([0, []]);
    expect(fog(foggy, memoryWith({ fog: 'unknown' }))).toEqual([0, [PATHS.fog]]);
    expect(fog(start(), memoryWith({ fog: 'unknown' }))).toEqual([0, []]); // no note: the memory says nothing
  });

  it('a weather with no Gen 4 bit, or a state without the field-note record, is a BAD_VIEW', () => {
    const desolate = editState(start(), (b) => { b.field.weather = 'desolateland' as ID; }); // a later generation's weather
    expect(aiErrorCode(() => view(desolate))).toBe('BAD_VIEW');
    // createBattle always records the note: without it, nothing says whether the cartridge has a field weather.
    const noNote = editState(createBattle({ ...baseInput(), field: { weather: 'rain' } }), (b) => { delete b.formatData['kaizoField']; });
    expect(aiErrorCode(() => view(noNote))).toBe('BAD_VIEW');
    expect(() => view(noNote)).toThrow(/no field-note record/);
  });
});

describe('viewFromState: move effects, volatiles, exact counters, and the memory over one base view', () => {
  it('pins the move-effect, volatile and side bits; Gastro Acid and Embargo hide the ability and item from the AI', () => {
    // Turns 1–4: Monferno's Embargo, Gastro Acid, Torment, Magnet Rise; Zigzagoon's Leech Seed, Ingrain, Tailwind, Mean Look.
    let state = createBattle(inputWith([MOVE.embargo, MOVE.gastroAcid, MOVE.torment, MOVE.magnetRise],
      { moves: [ID.leechSeed, MOVE.ingrain, MOVE.tailwind, ID.meanLook] }));
    for (let slot = 0; slot < 4; slot++) state = firstOf(state, move(slot), move(slot));
    const v = view(state);
    const [monferno, zigzagoon] = [v.mons[0], v.mons[1]];
    const has = (mask: number, ...flags: number[]) => flags.map((flag) => (mask & flag) !== 0);
    expect([
      has(monferno.moveEffectsMask, MOVE_EFFECT_LEECH_SEED, MOVE_EFFECT_MAGNET_RISE),
      has(zigzagoon.moveEffectsMask, MOVE_EFFECT_LEECH_SEED, MOVE_EFFECT_EMBARGO, MOVE_EFFECT_ABILITY_SUPPRESSED, MOVE_EFFECT_INGRAIN),
      has(monferno.statusVolatile, VOLATILE_CONDITION_TORMENT), has(zigzagoon.statusVolatile, VOLATILE_CONDITION_TORMENT),
      has(v.sideConditionsMask[0], SIDE_CONDITION_TAILWIND), has(v.sideConditionsMask[1], SIDE_CONDITION_TAILWIND),
    ]).toEqual([[true, true], [false, true, true, true], [false], [true], [false], [true]]);
    // The seed's recipient in bits 0–1 is the AI's battler (battle_controller_player.c:1380–1383).
    expect(monferno.moveEffectsMask & MOVE_EFFECT_LEECH_SEED_RECIPIENT).toBe(1);
    expect(monferno.effects.magnetRiseTurns > 0 && zigzagoon.effects.embargoTurns > 0).toBe(true);
    // The AI's helpers hide both (battle_lib.c:3090, 5358) while the battler keeps them.
    expect([zigzagoon.ability, battlerAbility(v, 1), zigzagoon.heldItem, heldItem(v, 1)]).toEqual([82, ABILITY_NONE, FX.item.SITRUS_BERRY, ITEM_NONE]);
  });

  it('Perish Song maps as duration − 1', () => {
    // The cartridge sets 3 on a hit (battle_script.c:5478), Showdown 4. Zigzagoon U-turns, so turn 1 hasn't ended at its switch.
    const perish = (state: EngineState) => view(state).mons.slice(0, 2).map((mon) => [mon.effects.perishSongTurns, (mon.moveEffectsMask & MOVE_EFFECT_PERISH_SONG) !== 0]);
    let state = firstOf(createBattle(inputWith([MOVE.perishSong, MOVE.swordsDance], { moves: [ID.uTurn] })), move(0), move(0));
    expect(state.phase.kind).toBe('enemyMidTurnSwitch');
    expect(perish(state)).toEqual([[3, true], [3, true]]);
    state = firstOf(state, undefined, { kind: 'switch', index: 1 }); // Bidoof comes in unaffected, and turn 1 ends
    expect(perish(state)).toEqual([[2, true], [0, false]]);
    state = firstOf(state, move(1), move(0));
    expect(perish(state)[0]).toEqual([1, true]);
    expect(perish(firstOf(state, move(1), move(0)))[0]).toEqual([0, true]); // where AI_PerishSongKO would switch (trainer_ai.c:3266)
  });

  it("the Protect chain maps as log2 of the stall counter, read from a lastMove the view doesn't write", () => {
    // protectSuccessTurns rises by 1 per success up to 3 (battle_script.c:5167–5187); Showdown's 'stall' starts at 2 and doubles.
    const protects = (outcome: Outcome) => outcome.log.some((line) => /^\|-singleturn\|p1a: [^|]*\|Protect/.test(line));
    const chain = (state: EngineState) => [view(state).mons[0].effects.protectSuccessTurns, view(state).moveProtect[0]];
    const opening = firstOf(createBattle(inputWith([MOVE.protect], { moves: [MOVE.reflect] })), move(0), move(0));
    // lastMove is an active-move copy the engine's freeze skips (`hit` is its own field): frozen here, a write would throw.
    const lastMove = peekBattle(opening).p1.active[0]!.lastMove!;
    expect(Object.hasOwn(lastMove, 'hit') && !Object.isFrozen(lastMove)).toBe(true);
    Object.freeze(lastMove);
    expect(view(opening).moveProtect).toEqual([MOVE.protect, MOVE_NONE, MOVE_NONE, MOVE_NONE]);
    expect(chain(opening)).toEqual([1, MOVE.protect]);
    // A second Protect in a row succeeds (2) or fails (0, which LoadProtectChain reads, trainer_ai.c:2545); a third, the cap.
    const second = outcomes(opening, move(0), move(0));
    const wins = second.filter(protects);
    expect(wins.length > 0 && wins.length < second.length).toBe(true);
    expect(second.map((o) => chain(o.state))).toEqual(second.map((o) => (protects(o) ? [2, MOVE.protect] : [0, MOVE_NONE])));
    const third = outcomes(wins[0]!.state, move(0), move(0)).filter(protects);
    expect(third.length).toBeGreaterThan(0);
    for (const outcome of third) expect(chain(outcome.state)[0]).toBe(3);
  });

  it("the turn fact reads the folded memory over one base view: a tormented one-move battler is 'struggle' after it, 'menu' before", () => {
    // Torment refuses the last move (battle_lib.c:2275): with Tackle last, every slot is invalid. Neither memory leaks into the other.
    const state = firstOf(createBattle(inputWith([MOVE.torment], { moves: [ID.tackle] })), move(0), move(0));
    for (let round = 0; round < 2; round++) {
      for (const [last, kind] of [[MOVE_NONE, 'menu'], [ID.tackle, 'struggle']] as const) {
        const v = view(state, memoryWith({ lastMoveBy: [MOVE.torment, last] }));
        expect([v.movePrevByBattler[1], (v.mons[1].statusVolatile & VOLATILE_CONDITION_TORMENT) !== 0, fightKind(v, deps)]).toEqual([last, true, kind]);
      }
    }
    // The views of one state share its memory-free parts; each has its own memory fields.
    const plain = view(state);
    const marked = view(state, memoryWith({ imprisonedMark: [true, false], lastMoveBy: [MOVE.disable, 0] }));
    expect(marked.parties).toBe(plain.parties);
    expect(marked.mons[1]).toBe(plain.mons[1]);
    expect(marked.mons[0].moveEffectsMask).toBe(plain.mons[0].moveEffectsMask | MOVE_EFFECT_IMPRISONED);
    expect([marked.movePrevByBattler[0], plain.movePrevByBattler[0]]).toEqual([MOVE.disable, MOVE_NONE]);
  });

  it("reads the engine's JSON accessors through a kept cut of each state's JSON to its formatData, answering as on the state", () => {
    const begin = start();
    for (const state of [begin, ...states(begin, move(0), move(0))]) {
      expect([trainerOf(state), startLogOf(state), fieldNoteOf(state)]).toEqual([battleTrainer(state), battleStartLog(state), battleField(state)]);
      expect(view(state).monSpeedValues.slice(0, 2)).toEqual([lastSpeedValues(state).p1, lastSpeedValues(state).p2]);
    }
    const parsed = JSON.parse(begin.json) as Record<string, unknown>;
    expect(JSON.parse(accessorState(begin).json)).toEqual({ formatData: parsed['formatData'] });
    // Every other top-level key garbled, and keys the JSON never has: the same cut, and every accessor answers as before.
    const garbled = Object.fromEntries(Object.keys(parsed).map((key) => [key, key === 'formatData' ? parsed[key] : { garbage: [key, 0, null] }]));
    const garbage: EngineState = { ...begin, json: JSON.stringify({ zzz: 'garbage', ...garbled, sides: 7, aaa: [null] }) };
    expect(accessorState(garbage).json).toBe(accessorState(begin).json);
    for (const read of [battleTrainer, battleField, battleStartLog, quickClawRolls, lastSpeedValues] as ((s: EngineState) => unknown)[]) {
      expect([read(accessorState(garbage)), read(garbage)], read.name).toEqual([read(begin), read(begin)]);
    }
    expect([trainerOf(garbage), startLogOf(garbage), fieldNoteOf(garbage)]).toEqual([battleTrainer(begin), battleStartLog(begin), battleField(begin)]);
    // A state with no formatData (one createBattle didn't make) throws, or reads nothing, as the accessors do.
    const bare: EngineState = { ...begin, json: JSON.stringify({ ...parsed, formatData: undefined }) };
    expect(() => trainerOf(bare)).toThrow('The state holds no trainer identity (not made by createBattle)');
    expect(startLogOf(bare)).toEqual([]);
    expect(() => fieldNoteOf(bare)).toThrow(new AiError('BAD_VIEW',
      'the state has no field-note record: The state holds no field record (not made by createBattle)'));
    // The cuts of the CUT_CAPACITY states read last are kept; an older one is cut again.
    const first = accessorState(begin);
    for (let i = 0; i < CUT_CAPACITY - 1; i++) accessorState({ ...begin });
    expect(accessorState(begin)).toBe(first); // the oldest kept, read again: now the latest
    for (let i = 0; i < CUT_CAPACITY; i++) accessorState({ ...begin });
    const again = accessorState(begin);
    expect([again === first, again]).toEqual([false, first]);
  });
});

describe('viewFromState: the fields it lists as unknown', () => {
  it("Pokédex weight comes from the ROM's table by the battler's form, and is unknown where the tables differ for a species FORMS lacks", () => {
    // Pokedex_SetupGiratina's two NARCs (pokedex_data_index.c:14–25): form 0 reads `weights`, any other form `formWeights`.
    const rom = { ...ai, weights: weightTable({ [ID.monferno]: 999 }), formWeights: weightTable({ [ID.monferno]: 999, [ID.deoxys]: 1234 }) };
    const deoxys = (form: number) => view(createBattle({ ...baseInput(), player: [playerMon(ID.deoxys, 30, [ID.tackle], { form })] }), undefined, rom);
    expect([view(start(), undefined, rom).mons[0].weight, deoxys(0).mons[0].weight]).toEqual([999, 608]);
    expect(deoxys(1)).toMatchObject({ mons: { 0: { species: ID.deoxys, form: 1, weight: 1234 } }, unknown: [] });
    expect(view(start(), undefined, { ...ai, formWeights: weightTable({ [ID.monferno]: 1 }) }).unknown).toEqual([PATHS.weight(0)]);
  });

  it("Imprison: the imprisoner's bit and moves give invalidMoves; the foe's IMPRISONED bit comes from the memory", () => {
    // Monferno's Imprison shares Tackle (Zigzagoon's slot 2); the foe is marked before the check (battle_script.c:6686–6692).
    const begin = createBattle(inputWith([MOVE.imprison, ID.tackle]));
    expect(invalidMoves(view(begin), deps, 1)).toBe(0);
    for (const outcome of outcomes(begin, move(0), move(1))) {
      const memory = rememberStep(initialMemoryData(null), outcome.log, protocolIds());
      expect(memory.imprisonedMark).toEqual([false, true]);
      const [plain, marked] = [view(outcome.state), view(outcome.state, memory)];
      expect(invalidMoves(plain, deps, 1)).toBe(1 << 2);
      expect([bitsOf(plain, MOVE_EFFECT_IMPRISON), bitsOf(plain, MOVE_EFFECT_IMPRISONED), bitsOf(marked, MOVE_EFFECT_IMPRISONED), marked.unknown])
        .toEqual([[MOVE_EFFECT_IMPRISON, 0], [0, 0], [0, MOVE_EFFECT_IMPRISONED], []]);
    }
    // Zigzagoon's failed Imprison still marks Monferno, and the mark outlasts the imprisoner's switch-out (battle_lib.c:2071).
    const failing = createBattle(inputWith([MOVE.swordsDance], { moves: [MOVE.imprison, ID.tackle] }));
    for (const outcome of outcomes(failing, move(0), move(0))) {
      expect(outcome.log).toContain('|-fail|p2a: Zigzagoon');
      const memory = rememberStep(initialMemoryData(null), outcome.log, protocolIds());
      const v = view(outcome.state, memory);
      expect([bitsOf(v, MOVE_EFFECT_IMPRISONED), bitsOf(v, MOVE_EFFECT_IMPRISON)]).toEqual([[MOVE_EFFECT_IMPRISONED, 0], [0, 0]]);
      for (const later of outcomes(outcome.state, move(0), { kind: 'switch', index: 1 })) {
        const after = rememberStep(memory, later.log, protocolIds());
        expect([after.imprisonedMark, bitsOf(view(later.state, after), MOVE_EFFECT_IMPRISONED)[0]]).toEqual([[true, false], MOVE_EFFECT_IMPRISONED]);
      }
    }
  });

  it('the Protect chain is unknown once the AI used a bag item while its last move protects, until its next move', () => {
    // Turn 2's X Attack runs no move, so the cartridge keeps moveProtect and the chain (battle_controller_player.c:3936–3942).
    const protectedOnce = firstOf(createBattle(inputWith([MOVE.swordsDance], { moves: [MOVE.protect, ID.tackle] })), move(0), move(0));
    expect(view(protectedOnce)).toMatchObject({ moveProtect: { 1: MOVE.protect }, mons: { 1: { effects: { protectSuccessTurns: 1 } } }, unknown: [] });
    const afterItem = firstOf(protectedOnce, move(0), { kind: 'item', item: bagItemId(57) });
    expect(view(afterItem).unknown).toEqual([PATHS.moveProtect(1), PATHS.protectSuccessTurns(1)]);
    expect(view(firstOf(afterItem, move(0), move(1)))).toMatchObject({ moveProtect: { 1: MOVE_NONE }, unknown: [] });
  });

  it("a transformed battler lists its Slow Start turn, IVs and speeds, keeps its friendship, and weighs its target's weight", () => {
    // Transform copies up to `ability` (battle_script.c:5346) and resets slowStartTurnNumber (:5360), which the engine doesn't.
    const input = inputWith([MOVE.transform], { ...ability(ABILITY_SLOW_START), friendship: 0 });
    input.player = [{ ...input.player[0]!, friendship: 143 }];
    const before = view(createBattle(input));
    expect([before.mons[0].friendship, before.mons[1].friendship, before.unknown]).toEqual([143, 0, []]);
    const v = view(firstOf(createBattle(input), move(0), move(1)));
    expect(v.mons[0].statusVolatile & VOLATILE_CONDITION_TRANSFORM).not.toBe(0);
    expect(v.mons[0]).toMatchObject({ species: ID.zigzagoon, weight: 175, ability: ABILITY_SLOW_START, friendship: 143 });
    expect([...v.unknown].sort()).toEqual([PATHS.ivs(0), PATHS.monSpeedValues, PATHS.slowStartTurnNumber(0)].sort());
  });
});

describe("viewFromState: the bag, the speeds, the Quick Claw, recycleItem and the log's names", () => {
  it('a used bag slot reads 0 and the count stays; a bag of fewer than four fills the rest with empty slots', () => {
    // X Attack, then one use that empties both Potion slots (trainer_ai.c:4191–4194): positions never shift.
    const xAttack = firstOf(start(), move(0), { kind: 'item', item: bagItemId(57) });
    expect(view(xAttack)).toMatchObject({ trainerItems: [17, 0, 17, 26], trainerItemCount: 4, mons: { 1: { statBoosts: { [BATTLE_STAT.ATTACK]: 7 } } } });
    const potions = firstOf(xAttack, move(0), { kind: 'item', item: bagItemId(17), consumeSlots: [0, 2] });
    expect(view(potions)).toMatchObject({ trainerItems: [0, 0, 0, 26], trainerItemCount: 4 });
    // The battle start copies the non-empty slots to the front and counts them (battle_controller_player.c:4801–4813).
    const bag = (romIndex: number) => view(createBattle(battle([MOVE.swordsDance], {}, romIndex)));
    expect(bag(BAG.fullRestore)).toMatchObject({ trainerItems: [23, 0, 0, 0], trainerItemCount: 1 });
    expect(bag(BAG.none)).toMatchObject({ trainerItems: [0, 0, 0, 0], trainerItemCount: 0 });
  });

  it("a Gyro Ball user's decision reads the speeds without UNDEFINED", () => {
    // Bit 0 asks whether Gyro Ball kills (USE_MAX_DAMAGE): its estimate reads monSpeedValues before any compare writes them.
    const state = createBattle(battle([MOVE.swordsDance], { moves: [MOVE.gyroBall, ID.tackle] }, BAG.none, [ID.meanLook]));
    const script = flagScript(`IfCurrentMoveKills ${USE_MAX_DAMAGE}, Bonus\nPopOrEnd\nBonus: AddToMoveScore 5\nPopOrEnd`);
    const d = { script, moves: data.rom.moves, species: data.rom.species, items: ai.items, typeChart: ai.typeChart, aiFlags: 1 };
    const actions = decide(view(state), d, emptyKnowledge());
    expect(actions.reduce((sum, entry) => add(sum, entry.probability), ZERO)).toEqual(ONE);
    expect(actions.every((entry) => entry.action.kind === 'move')).toBe(true);
  });

  it("this turn's Quick Claw is the engine's stored roll, and null where none is stored", () => {
    // Quick Claw's param 20 is the engine's `speedRand % 5 == 0`; Monferno's Leftovers (10) is not the engine's draw.
    const state = createBattle(inputWith([MOVE.swordsDance], { item: FX.item.QUICK_CLAW }));
    const withRolls = (rolls: Record<string, boolean>) => editState(state, (b) => { b.formatData['kaizoSpeedRand'] = rolls; });
    expect([quickClawRolls(state), quickClawRolls(withRolls({ p2: true }))]).toEqual([{}, { p2: true }]);
    expect([state, withRolls({ p2: true }), withRolls({ p2: false }), withRolls({ p1: true, p2: true })].map((s) => view(s).quickClawThisTurn))
      .toEqual([[null, null, null, null], [null, true, null, null], [null, false, null, null], [null, true, null, null]]);
    for (const next of states(state, move(0), move(2))) expect(view(next).quickClawThisTurn).toEqual([null, quickClawRolls(next).p2 ?? null, null, null]);
  });

  it("recycleItem is Showdown's lastItem, which follows the battler slot as recycleItem does", () => {
    // Tackle takes Zigzagoon to half HP and it eats its Sitrus Berry: BtlCmd_RemoveItem keeps it (battle_script.c:8978).
    let state = createBattle(inputWith([ID.tackle]));
    for (let i = 0; i < 3 && restore(state).p2.active[0]!.lastItem === ''; i++) state = firstOf(state, move(0), move(1));
    expect(view(state)).toMatchObject({ recycleItem: [ITEM_NONE, FX.item.SITRUS_BERRY, ITEM_NONE, ITEM_NONE], unknown: [] });
    // Bidoof comes in: the cartridge never clears recycleItem on a switch, and Gen 1–4 Showdown hands lastItem on.
    expect(view(firstOf(state, move(0), { kind: 'switch', index: 1 }))).toMatchObject({ mons: { 1: { species: ID.bidoof } }, recycleItem: { 1: FX.item.SITRUS_BERRY } });
  });

  it("a berry the player's Bug Bite eats is in the AI's slot from the memory, as Showdown's takeItem leaves no lastItem", () => {
    // subscript_pluck.s:10, RemoveItem BTLSCR_DEFENDER.
    const eaten = outcomes(createBattle(inputWith([MOVE.bugBite])), move(0), move(1)).filter((o) => o.log.some((line) => line.includes('[from] stealeat')));
    expect(eaten.length).toBeGreaterThan(0);
    for (const outcome of eaten) {
      const pokemon = restore(outcome.state).p2.active[0]!;
      expect([pokemon.item, pokemon.lastItem]).toEqual(['', '']);
      const memory = rememberStep(initialMemoryData(null), outcome.log, protocolIds());
      expect(memory.recycleOverride).toEqual([null, FX.item.SITRUS_BERRY]);
      expect(view(outcome.state, memory)).toMatchObject({ recycleItem: { 1: FX.item.SITRUS_BERRY }, unknown: [] });
      expect(view(outcome.state).recycleItem[1]).toBe(ITEM_NONE);
      // A slot the memory can't settle (a Recycle or Natural Gift since) is listed.
      expect(view(outcome.state, { ...memory, recycleOverride: [null, 'unknown'] }).unknown).toEqual([PATHS.recycleItem(1)]);
    }
  });

  it("protocolIds maps the log's names to ROM IDs through the installed dex, one map per dex, and throws on a name it doesn't know", () => {
    const dex = restore(start()).dex;
    const ids = protocolIds();
    expect(protocolIds()).toBe(ids);
    for (const name of ['Swords Dance', 'Disable', 'Protect', 'Imprison']) expect(ids.move(name)).toBe(dex.moves.get(name).num);
    expect([ids.move('Swords Dance'), ids.move('Struggle'), ids.ability('Blaze'), ids.item('Sitrus Berry'), ids.item('Leftovers')])
      .toEqual([MOVE.swordsDance, 165, 66, FX.item.SITRUS_BERRY, FX.item.LEFTOVERS]);
    for (const kind of ['move', 'ability', 'item', 'move'] as const) { // a name not found isn't remembered: it throws again
      expect(() => ids[kind]('Not A Name')).toThrow(new AiError('BAD_VIEW', `the battle knows no ${kind} "Not A Name"`));
    }
  });
});

describe("viewFromState: what a replacement reads of the turn's state", () => {
  // The AI's mid-turn switch runs before its action's MoveEnd resets battleStatusMask and powerMul: switchAction says what ran.
  it("lists the mask and powerMul for the switching action's moves, at a mid-turn switch only", () => {
    const midTurn = firstOf(createBattle(inputWith([MOVE.swordsDance], { moves: [ID.uTurn] })), move(0), move(0));
    expect(midTurn.phase.kind).toBe('enemyMidTurnSwitch');
    const listed = (switchAction: number[] | null) => view(midTurn, memoryWith({ switchAction })).unknown;
    expect([[ID.uTurn], [MOVE.seismicToss, ID.uTurn], [MOVE.revenge, ID.uTurn], null].map(listed)).toEqual([
      [], ['battleStatusMask.turn'], ['powerMul'], ['battleStatusMask.turn', 'powerMul'], // no AI action in the step: both
    ]);
    // No reader guards these paths, so assertGuarded refuses the pick; the values stay those of every other decision.
    const v = view(midTurn, memoryWith({ switchAction: [MOVE.seismicToss, ID.uTurn] }));
    expect(aiErrorCode(() => replacement(v, deps))).toBe('UNDEFINED');
    expect([v.battleStatusMask, v.powerMul]).toEqual([0, 10]);
    // A turn choice and a replacement after a KO list neither: each action's MoveEnd reset them.
    for (const state of [start(), ...knockedOut()]) expect(view(state, memoryWith({ switchAction: [MOVE.seismicToss] })).unknown).toEqual([]);
  });

  it("gives a fainted AI battler its kept fields and traced ability from the memory, at its replacement only", () => {
    // The tracer's BattleMon keeps the traced ability through the faint (battle_lib.c:2156–2210); Showdown's resets it.
    const kept = memoryWith({ aiKept: ['mons.1.ability', 'mons.1.types'] });
    const traced = memoryWith({ aiTraced: 66 });
    for (const state of knockedOut()) {
      expect(view(state, kept).unknown).toEqual(['mons.1.ability', 'mons.1.types']);
      const [v, plain] = [view(state, traced), view(state)];
      expect([v.mons[1]!.ability, v.unknown]).toEqual([66, []]);
      expect({ ...v, mons: [v.mons[0], { ...v.mons[1], ability: plain.mons[1]!.ability }, v.mons[2], v.mons[3]] }).toEqual(plain);
      expect(view(state, { ...traced, aiKept: ['mons.1.types'] }).unknown).toEqual(['mons.1.types']);
    }
    // Alive, the battle's own fields are the BattleMon's: Showdown keeps a living tracer's.
    const alive = start();
    expect(view(alive, kept).unknown).toEqual([]);
    expect(view(alive, traced)).toEqual(view(alive));
  });
});
