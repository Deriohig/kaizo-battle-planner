// No silent defaults: a field listed in AiView.unknown throws UNDEFINED in its reader, or at the decision's entry if unguarded.

import { describe, expect, it } from 'vitest';
import { decide, pickCommand } from '../../../src/ai/choose/decide.js';
import { moveDistribution, slotScores } from '../../../src/ai/choose/moves.js';
import { replacement } from '../../../src/ai/choose/postKo.js';
import {
  ABILITY_SLOW_START, AI_BATTLER_ATTACKER as ATK, AI_BATTLER_DEFENDER as DEF, BATTLE_EFFECT_INCREASE_POWER_WITH_WEIGHT,
  BATTLE_EFFECT_POWER_BASED_ON_FRIENDSHIP, BATTLE_EFFECT_POWER_BASED_ON_LOW_FRIENDSHIP, BATTLE_EFFECT_POWER_BASED_ON_LOW_SPEED,
  BATTLE_EFFECT_SKIP_CHARGE_TURN_IN_SUN, COMPARE_SPEED_FASTER, FIELD_CONDITION_DEEP_FOG, FIELD_CONDITION_RAINING_TEMP,
  FIELD_CONDITION_TRICK_ROOM_0, MAX_BATTLERS, MOVE_EFFECT_IMPRISON, MOVE_EFFECT_IMPRISONED, MOVE_EFFECT_LEECH_SEED,
  MOVE_FRUSTRATION, MOVE_GYRO_BALL, MOVE_LOW_KICK, MOVE_PROTECT, MOVE_RETURN, MOVE_SOLAR_BEAM, TYPE_FIGHTING, TYPE_GRASS,
  TYPE_NORMAL, TYPE_STEEL, USE_MAX_DAMAGE as MAX,
} from '../../../src/ai/constants.js';
import { AiError } from '../../../src/ai/errors.js';
import { aiMoveType, partyMoveType, weatherIs } from '../../../src/ai/lib/battler.js';
import { aiCalcDamage, calcMoveDamage } from '../../../src/ai/lib/damage.js';
import { invalidMoves } from '../../../src/ai/lib/invalidMoves.js';
import { assertGuarded, isGuardedPath, PATHS, REPLACEMENT_PATHS, requireKnown } from '../../../src/ai/lib/known.js';
import { compareSpeed, type Latents } from '../../../src/ai/lib/speed.js';
import { eq, ONE, sum } from '../../../src/ai/odds.js';
import { type RunResult, runScript } from '../../../src/ai/script/run.js';
import { AI_BATTLER as AI, type AiDeps, type AiView, PLAYER_BATTLER as PLAYER } from '../../../src/ai/view.js';
import { assemble } from './asm.js';
import { emptyKnowledge, FX, fixtureDeps, fixtureView } from './fixtures.js';

/** PATHS' fixed paths, its per-battler ones, and the battler slots these take. */
const FIXED = Object.values(PATHS).filter((path): path is Extract<typeof path, string> => typeof path === 'string');
const PER_BATTLER = Object.values(PATHS).filter((path): path is Extract<typeof path, (battler: number) => string> => typeof path === 'function');
const BATTLERS = Array.from({ length: MAX_BATTLERS }, (_, battler) => battler);
const UNDEFINED = expect.objectContaining({ code: 'UNDEFINED' });
const M = FX.move;
const noPick = (): never => { throw new Error('unexpected pick'); };
const latents = (): Latents => ({ rolls: [null, null, null, null], quickClaw: [null, null, null, null] });

/** `v` with `paths` listed as unknown (a copy). */
const unknownIn = (v: AiView, ...paths: string[]): AiView => ({ ...v, unknown: [...v.unknown, ...paths] });

/** The fixture deps with Low Kick, Return, Frustration, Solar Beam and Gyro Ball (vanilla records) added. */
function deps(): AiDeps {
  const d = fixtureDeps();
  for (const [id, category, type, power, effect] of [
    [MOVE_LOW_KICK, 'physical', TYPE_FIGHTING, 1, BATTLE_EFFECT_INCREASE_POWER_WITH_WEIGHT],
    [MOVE_RETURN, 'physical', TYPE_NORMAL, 1, BATTLE_EFFECT_POWER_BASED_ON_FRIENDSHIP],
    [MOVE_FRUSTRATION, 'physical', TYPE_NORMAL, 1, BATTLE_EFFECT_POWER_BASED_ON_LOW_FRIENDSHIP],
    [MOVE_SOLAR_BEAM, 'special', TYPE_GRASS, 120, BATTLE_EFFECT_SKIP_CHARGE_TURN_IN_SUN],
    [MOVE_GYRO_BALL, 'physical', TYPE_STEEL, 1, BATTLE_EFFECT_POWER_BASED_ON_LOW_SPEED],
  ] as const) d.moves[id] = { id, effect, category, power, type, accuracy: 100, pp: 20, effectChance: 0, target: 0, priority: 0, flags: 0 };
  return d;
}

/** `src` run from word 0 for the AI's slot 0, score 100; `startSpeeds` (default true) says the speeds are the decision start's. */
function run(src: string, v: AiView, opts: { monSpeedValues?: number[]; startSpeeds?: boolean } = {}): RunResult {
  return runScript(0, {
    v, d: { ...deps(), script: { words: assemble(src).words, flagEntries: Array<number>(32).fill(0), sha256: '' } }, k: emptyKnowledge(),
    lat: latents(), attacker: AI, defender: PLAYER, slot: 0, move: v.mons[AI].moves[0]!, score: 100, calcTemp: 0, pick: noPick,
    monSpeedValues: opts.monSpeedValues ?? [...v.monSpeedValues], startSpeeds: opts.startSpeeds ?? true,
  });
}
/** The score after `instr`, whose jump label is `Taken`: 101 if it jumps, else 100. */
const branch = (instr: string) => (v: AiView) => run(`${instr}\nPopOrEnd\nTaken: AddToMoveScore 1\nPopOrEnd`, v).score;
/** The value `instr` leaves in calcTemp. */
const load = (instr: string) => (v: AiView) => run(`${instr}\nPopOrEnd`, v).calcTemp;
/** TrainerAI_CalcDamage of `move` from the AI's Garchomp into Luxray at 100%, with its IVs as battler `ivsOf`'s. */
const estimate = (move: number, ivsOf: number | null = AI) => (v: AiView) =>
  aiCalcDamage(v, deps(), move, v.mons[AI].heldItem, v.mons[AI].ivs, ivsOf, AI, PLAYER, v.mons[AI].ability, v.mons[AI].effects.embargoTurns, 100, noPick);
const damage = (move: number) => (v: AiView) => calcMoveDamage(v, deps(), move, 0, v.fieldConditionsMask, 0, TYPE_NORMAL, AI, PLAYER, 1);
const speeds = (v: AiView) => compareSpeed(v, fixtureDeps(), latents(), AI, PLAYER, noPick).speeds;

/** The fixture view (the AI's Garchomp, battler 1, against the player's Luxray, battler 0) with `patch`, then `edit`. */
function edited(edit: (v: AiView) => void, patch: Parameters<typeof fixtureView>[0] = {}): AiView {
  const v = fixtureView(patch);
  edit(v);
  return v;
}
const gyro = edited((v) => { // Gyro Ball from [244, 122]: power 51, an estimate of 18 that kills
  v.mons[AI].moves = [MOVE_GYRO_BALL, 0, 0, 0];
  v.mons[PLAYER].curHP = 18;
});
const V = {
  plain: fixtureView(), gyro, carried: { ...gyro, monSpeedValues: [244, 122, 0, 0] },
  recycled: fixtureView({ recycleItem: [0, FX.item.SITRUS_BERRY, 0, 0] }),
  imprisoned: edited((v) => { v.mons[PLAYER].moveEffectsMask = MOVE_EFFECT_IMPRISONED; }),
  imprisoner: edited((v) => { v.mons[PLAYER].moveEffectsMask = MOVE_EFFECT_IMPRISON; }),
  chain: edited((v) => { v.mons[AI].effects.protectSuccessTurns = 2; }, { moveProtect: [0, MOVE_PROTECT, 0, 0] }),
  slowStart: edited((v) => { v.mons[AI].ability = ABILITY_SLOW_START; }),
  // Hidden Power: Dark at all 29, Fighting at the fixture's 30 (trainer_ai.c:3208–3220).
  ivs29: edited((v) => { v.mons[AI].ivs = { hp: 29, atk: 29, def: 29, spa: 29, spd: 29, spe: 29 }; }),
  heavy: edited((v) => { v.mons[PLAYER].weight = 2001; }),
  fond: edited((v) => { v.mons[AI].friendship = 255; }),
  foggy: fixtureView({ fieldConditionsMask: FIELD_CONDITION_DEEP_FOG }),
  rain: fixtureView({ fieldConditionsMask: FIELD_CONDITION_RAINING_TEMP }),
  trickRoom: fixtureView({ fieldConditionsMask: FIELD_CONDITION_TRICK_ROOM_0 }),
};
const KILL = `IfCurrentMoveKills ${MAX}, Taken\nPopOrEnd\nTaken: AddToMoveScore 1\nPopOrEnd`;

describe('each unknown field throws in its reader', () => {
  it('requireKnown throws UNDEFINED for a listed path only; the fixture view lists nothing', () => {
    const v = unknownIn(fixtureView(), 'mons.1.ivs');
    expect(() => requireKnown(v, 'mons.1.ivs')).toThrow(new AiError('UNDEFINED', 'mons.1.ivs is unknown'));
    expect(() => requireKnown(v, 'mons.0.ivs')).not.toThrow();
    expect(fixtureView().unknown).toEqual([]);
  });

  // [reader, path, read, a view with the field set, one without]: the read differs, so it reads the field; listed, it throws.
  it.each<[string, string, (v: AiView) => unknown, AiView, AiView]>([
    ['LoadRecycleItem', PATHS.recycleItem(AI), load(`LoadRecycleItem ${ATK}`), V.recycled, V.plain],
    ['IfMoveEffect IMPRISONED', PATHS.imprisoned(PLAYER), branch(`IfMoveEffect ${DEF}, ${MOVE_EFFECT_IMPRISONED}, Taken`), V.imprisoned, V.plain],
    ['IfNotMoveEffect IMPRISONED', PATHS.imprisoned(PLAYER), branch(`IfNotMoveEffect ${DEF}, ${MOVE_EFFECT_IMPRISONED}, Taken`), V.imprisoned, V.plain],
    ['LoadProtectChain (moveProtect)', PATHS.moveProtect(AI), load(`LoadProtectChain ${ATK}`), V.chain, V.plain],
    ['LoadProtectChain (protectSuccessTurns)', PATHS.protectSuccessTurns(AI), load(`LoadProtectChain ${ATK}`), V.chain, V.plain],
    // Slow Start halves Speed (battle_lib.c:1263–1266) and Attack (:6709–6714) while it lasts.
    ['compareSpeed with Slow Start', PATHS.slowStartTurnNumber(AI), speeds, V.slowStart, V.plain],
    ['calcMoveDamage with Slow Start', PATHS.slowStartTurnNumber(AI), damage(M.DRAGON_CLAW), V.slowStart, { ...V.slowStart, totalTurns: 6 }],
    ['aiMoveType of Hidden Power', PATHS.ivs(AI), (v) => aiMoveType(v, fixtureDeps(), AI, M.HIDDEN_POWER), V.ivs29, V.plain],
    ['aiCalcDamage of Hidden Power', PATHS.ivs(AI), estimate(M.HIDDEN_POWER), V.ivs29, V.plain],
    ["Low Kick's defender weight", PATHS.weight(PLAYER), estimate(MOVE_LOW_KICK), V.heavy, V.plain],
    ["Return's attacker friendship", PATHS.friendship(AI), estimate(MOVE_RETURN), V.fond, V.plain],
    ["Frustration's attacker friendship", PATHS.friendship(AI), estimate(MOVE_FRUSTRATION), V.fond, V.plain],
    ['LoadCurrentWeather', PATHS.fog, load('LoadCurrentWeather'), V.foggy, V.plain],
    ['weatherIs fog', PATHS.fog, (v) => weatherIs(v, 'fog'), V.foggy, V.plain],
    ['IfFieldConditionsMask DEEP_FOG', PATHS.fog, branch(`IfFieldConditionsMask ${FIELD_CONDITION_DEEP_FOG}, Taken`), V.foggy, V.plain],
    ['Solar Beam, halved in fog (battle_lib.c:7058–7060)', PATHS.fog, damage(MOVE_SOLAR_BEAM), V.foggy, V.plain],
    ["Gyro Ball's incoming speeds, the decision start's", PATHS.monSpeedValues, (v) => run(KILL, v).score, V.carried, V.gyro],
  ])('%s reads %s', (_, path, read, set, other) => {
    expect(read(set)).not.toEqual(read(other));
    expect(() => read(unknownIn(set, path))).toThrow(UNDEFINED);
  });

  // [reader, paths listed, read, view]: the read never reaches the listed paths, so listing them changes nothing.
  it.each<[string, string[], (v: AiView) => unknown, AiView]>([
    ["LoadRecycleItem, another battler's entry", [PATHS.recycleItem(PLAYER)], load(`LoadRecycleItem ${ATK}`), V.recycled],
    ['IfMoveEffect of another bit', [PATHS.imprisoned(PLAYER)], branch(`IfMoveEffect ${DEF}, ${MOVE_EFFECT_LEECH_SEED}, Taken`), V.imprisoned],
    // Move_Imprisoned (battle_lib.c:3316) reads the other side's MOVE_EFFECT_IMPRISON and moves, which the adapter derives.
    ['invalidMoves', [PATHS.imprisoned(PLAYER), PATHS.imprisoned(AI)], (v) => invalidMoves(v, fixtureDeps(), AI), V.imprisoner],
    ["LoadProtectChain, the player's paths", [PATHS.moveProtect(PLAYER), PATHS.protectSuccessTurns(PLAYER)], load(`LoadProtectChain ${ATK}`), V.chain],
    ['compareSpeed without Slow Start', [PATHS.slowStartTurnNumber(AI), PATHS.slowStartTurnNumber(PLAYER)], speeds, V.plain],
    ['calcMoveDamage without Slow Start', [PATHS.slowStartTurnNumber(AI), PATHS.slowStartTurnNumber(PLAYER)], damage(M.DRAGON_CLAW), V.plain],
    ['aiMoveType of a typed move', [PATHS.ivs(AI)], (v) => aiMoveType(v, fixtureDeps(), AI, M.DRAGON_CLAW), V.ivs29],
    // Move_CalcVariableType reads the party data, which Transform never changes.
    ['partyMoveType of Hidden Power', [PATHS.ivs(AI)], (v) => partyMoveType(v, fixtureDeps(), v.parties[1][0]!, M.HIDDEN_POWER), V.ivs29],
    ["aiCalcDamage of Hidden Power with a party Pokémon's IVs", [PATHS.ivs(AI)], estimate(M.HIDDEN_POWER, null), V.ivs29],
    ['aiCalcDamage of a fixed-power move', [PATHS.ivs(AI)], estimate(M.DRAGON_CLAW), V.ivs29],
    ["Low Kick, the attacker's weight", [PATHS.weight(AI)], estimate(MOVE_LOW_KICK), V.plain],
    ["Return, the defender's friendship", [PATHS.friendship(PLAYER)], estimate(MOVE_RETURN), V.plain],
    ['weatherIs rain', [PATHS.fog], (v) => weatherIs(v, 'rain'), V.plain],
    ['IfFieldConditionsMask of another bit', [PATHS.fog], branch(`IfFieldConditionsMask ${FIELD_CONDITION_TRICK_ROOM_0}, Taken`), V.plain],
    // Trick Room alone decides a mask that also holds fog.
    ['IfFieldConditionsMask TRICK_ROOM | DEEP_FOG under Trick Room', [PATHS.fog],
      branch(`IfFieldConditionsMask ${FIELD_CONDITION_TRICK_ROOM_0 | FIELD_CONDITION_DEEP_FOG}, Taken`), V.trickRoom],
    ['Solar Beam in rain, which halves it too', [PATHS.fog], damage(MOVE_SOLAR_BEAM), V.rain],
    ['calcMoveDamage of another move', [PATHS.fog], damage(M.DRAGON_CLAW), V.plain],
  ])('%s: listing %s changes nothing', (_, paths, read, v) => {
    expect(read(unknownIn(v, ...paths))).toEqual(read(v));
  });

  it('with monSpeedValues listed, Gyro Ball reads the incoming speeds only when an earlier run or a compare wrote them', () => {
    const listed = unknownIn(V.carried, PATHS.monSpeedValues);
    // An earlier run's comparison wrote the incoming copy (startSpeeds false): exact, so it is read.
    expect(run(KILL, listed, { startSpeeds: false })).toMatchObject({ score: 101, readIncomingSpeeds: true });
    // A speed comparison in the run writes both entries first (battle_lib.c:1372–1373), so nothing incoming is read.
    expect(run(`IfSpeedCompareEqualTo ${COMPARE_SPEED_FASTER}, Next\nNext: ${KILL}`, listed)).toMatchObject({ score: 100, readIncomingSpeeds: false });
    expect(run(`FlagMoveDamageScore ${MAX}\nPopOrEnd`, unknownIn(V.plain, PATHS.monSpeedValues)).readIncomingSpeeds).toBe(false);
  });
});

describe('assertGuarded: no decision on a view with an unknown path no reader guards', () => {
  /** Every path PATHS names, for every battler slot: the paths a reader guards with requireKnown. */
  const everyGuarded = [...FIXED, ...PER_BATTLER.flatMap((path) => BATTLERS.map(path))];
  const unguarded = new AiError('UNDEFINED', 'unguarded unknown path mons.0.statBoosts');

  it('passes every path PATHS names (derived, so a new path counts), and throws UNDEFINED naming the first other path', () => {
    expect(new Set(everyGuarded).size).toBe(FIXED.length + PER_BATTLER.length * MAX_BATTLERS);
    expect(() => assertGuarded(unknownIn(fixtureView(), ...everyGuarded))).not.toThrow();
    // Field paths no reader guards, after a guarded path.
    expect(() => assertGuarded(unknownIn(fixtureView(), PATHS.recycleItem(0), 'mons.0.statBoosts', 'mons.1.heldItem'))).toThrow(unguarded);
  });

  it('decide, pickCommand, moveDistribution, slotScores and replacement refuse such a view at entry', () => {
    const v = unknownIn(fixtureView(), 'mons.0.statBoosts');
    for (const entry of [
      () => decide(v, deps(), emptyKnowledge()), () => pickCommand(v, deps()), () => moveDistribution(v, deps(), emptyKnowledge()),
      () => slotScores(v, deps(), emptyKnowledge(), 0), () => replacement(v, deps()),
    ]) expect(entry).toThrow(expect.objectContaining({ code: unguarded.code, message: unguarded.message }));
  });

  it('a view whose unknown paths are all guarded, and that no reader on its path reaches, decides to the end', () => {
    const v = unknownIn(fixtureView(), PATHS.recycleItem(0), PATHS.weight(0), PATHS.friendship(1));
    expect(eq(sum(decide(v, deps(), emptyKnowledge()).map((action) => action.probability)), ONE)).toBe(true);
    expect(moveDistribution(v, deps(), emptyKnowledge()).length).toBeGreaterThan(0);
  });

  it('isGuardedPath is every PATHS path, for each battler, and nothing else', () => {
    expect(everyGuarded.every(isGuardedPath)).toBe(true);
    // The replacement paths, any other field path, and a battler past the slots have no guard.
    for (const path of [REPLACEMENT_PATHS.statusMask, REPLACEMENT_PATHS.powerMul, REPLACEMENT_PATHS.field(1, 'ability'), 'mons.1.statBoosts', PER_BATTLER[0]!(MAX_BATTLERS)]) {
      expect(isGuardedPath(path), path).toBe(false);
    }
  });
});
