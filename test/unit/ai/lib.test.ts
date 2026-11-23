// The battle_lib.c helpers the trainer AI calls, on the fixture's turn-1 view: Luxray (battler 0, Electric, Rivalry,
// Sitrus Berry) against Garchomp (battler 1, Dragon/Ground, Sand Veil, Leftovers).

import { describe, expect, it } from 'vitest';
import {
  ABILITY_AIR_LOCK, ABILITY_CLOUD_NINE, ABILITY_FILTER, ABILITY_KLUTZ, ABILITY_LEVITATE, ABILITY_MOLD_BREAKER,
  ABILITY_MULTITYPE, ABILITY_NONE, ABILITY_RIVALRY, ABILITY_SCRAPPY, ABILITY_SOLID_ROCK, ABILITY_TINTED_LENS,
  ABILITY_WONDER_GUARD, BATTLE_TYPE_TRAINER_DOUBLES, COUNT_ALIVE_BATTLERS_THEIR_SIDE_FLAG, COUNT_ALL_BATTLERS,
  COUNT_ALL_BATTLERS_EXCEPT_ME_RETURN_BATTLER, COUNT_ALL_BATTLERS_OUR_SIDE, COUNT_ALL_BATTLERS_THEIR_SIDE,
  FIELD_CONDITION_DEEP_FOG, FIELD_CONDITION_GRAVITY_INIT, FIELD_CONDITION_RAINING_TEMP, FIELD_CONDITION_SANDSTORM_PERM,
  FIELD_CONDITION_SUNNY_TEMP, HOLD_EFFECT_ARCEUS_FIRE, HOLD_EFFECT_CHOICE_ATK, HOLD_EFFECT_SPEED_DOWN_GROUNDED,
  ITEM_POWER_CHECK_ALL, ITEM_POWER_CHECK_EMBARGO, ITEM_POWER_CHECK_NONE, MOVE_EFFECT_ABILITY_SUPPRESSED,
  MOVE_EFFECT_IMPRISON, MOVE_EFFECT_INGRAIN, MOVE_EFFECT_MIRACLE_EYE, MOVE_FLY, MOVE_JUDGMENT, MOVE_NATURAL_GIFT,
  MOVE_ROOST, MOVE_STATUS_INEFFECTIVE, MOVE_STATUS_LEVITATED, MOVE_STATUS_MAGNET_RISE, MOVE_STATUS_NOT_VERY_EFFECTIVE,
  MOVE_STATUS_SUPER_EFFECTIVE, MOVE_STATUS_WONDER_GUARD, SPECIES_ARCEUS, SYSCTL_IGNORE_TYPE_CHECKS,
  SYSCTL_LAST_OF_MULTI_TURN, TYPE_DARK, TYPE_DRAGON, TYPE_ELECTRIC, TYPE_FIRE, TYPE_FLYING, TYPE_GHOST, TYPE_GRASS,
  TYPE_GROUND, TYPE_ICE, TYPE_MULTI_BASE_DAMAGE, TYPE_MULTI_DOUBLE_DAMAGE, TYPE_MULTI_HALF_DAMAGE, TYPE_MULTI_IMMUNE,
  TYPE_MULTI_QUADRUPLE_DAMAGE, TYPE_MULTI_STAB_DAMAGE, TYPE_NORMAL, TYPE_PSYCHIC, TYPE_ROCK, TYPE_WATER,
  VOLATILE_CONDITION_FORESIGHT, VOLATILE_CONDITION_TORMENT,
} from '../../../src/ai/constants.js';
import {
  aiMoveType, battlerAbility, countAbility, countMoves, heldItemEffect, heldItemPower, itemFlingPower, naturalGiftType,
  noCloudNine, partner, partyMoveType, weatherIs,
} from '../../../src/ai/lib/battler.js';
import { invalidMoves } from '../../../src/ai/lib/invalidMoves.js';
import { applyTypeChart, calcEffectiveness, monHasType, typeMatchupMultiplier } from '../../../src/ai/lib/typeChart.js';
import { AI_BATTLER as A, type AiBattleMon, type AiDeps, type AiView, PLAYER_BATTLER as P } from '../../../src/ai/view.js';
import { FX, fixtureDeps, fixtureView } from './fixtures.js';
import { code, frozen } from './miscHarness.js';

const M = FX.move;
const BASE = TYPE_MULTI_BASE_DAMAGE;
const STAB = TYPE_MULTI_STAB_DAMAGE;
const QUAD = TYPE_MULTI_QUADRUPLE_DAMAGE;
const SE = MOVE_STATUS_SUPER_EFFECTIVE;
const NVE = MOVE_STATUS_NOT_VERY_EFFECTIVE;
const INEFF = MOVE_STATUS_INEFFECTIVE;

/** Items the fixture has no record for (IDs are line − 1 of generated/items.txt). */
const ITEM_CHOICE_BAND = 220;
const ITEM_IRON_BALL = 278;
const ITEM_FLAME_PLATE = 298;

/** The fixture's deps plus Choice Band, Iron Ball and Flame Plate: only their hold effects are read. */
function deps(): AiDeps {
  const d = fixtureDeps();
  const base = d.items[FX.item.LEFTOVERS]!;
  d.items[ITEM_CHOICE_BAND] = { ...base, id: ITEM_CHOICE_BAND, holdEffect: HOLD_EFFECT_CHOICE_ATK };
  d.items[ITEM_IRON_BALL] = { ...base, id: ITEM_IRON_BALL, holdEffect: HOLD_EFFECT_SPEED_DOWN_GROUNDED };
  d.items[ITEM_FLAME_PLATE] = { ...base, id: ITEM_FLAME_PLATE, holdEffect: HOLD_EFFECT_ARCEUS_FIRE };
  return d;
}

type Setup = (v: AiView) => void;
const on = (battler: number, patch: Partial<AiBattleMon>): Setup => (v) => void Object.assign(v.mons[battler]!, patch);
const effects = (battler: number, patch: Partial<AiBattleMon['effects']>): Setup => (v) => void Object.assign(v.mons[battler]!.effects, patch);
const set = (patch: Partial<AiView>): Setup => (v) => void Object.assign(v, patch);
const and = (...setups: Setup[]): Setup => (v) => setups.forEach((setup) => setup(v));
/** The fixture view after `setups`. */
const view = (...setups: Setup[]) => {
  const v = fixtureView();
  and(...setups)(v);
  return v;
};

const ROCK_GROUND = on(A, { types: [TYPE_ROCK, TYPE_GROUND] });
const WATER_USER = on(P, { types: [TYPE_WATER, TYPE_WATER] });
const GHOST = on(A, { types: [TYPE_GHOST, TYPE_GHOST] });
const DARK = on(A, { types: [TYPE_DARK, TYPE_DARK] });
const FLYING = on(P, { types: [TYPE_FLYING, TYPE_FLYING] });
const LEVITATE = on(P, { ability: ABILITY_LEVITATE });
const WONDER_GUARD = on(A, { ability: ABILITY_WONDER_GUARD });
const MAGNET_RISE = effects(P, { magnetRiseTurns: 3 });
const ARCEUS = on(A, { species: SPECIES_ARCEUS, ability: ABILITY_MULTITYPE, heldItem: ITEM_FLAME_PLATE, types: [TYPE_NORMAL, TYPE_NORMAL] });

describe('applyTypeChart', () => {
  // Each matching chart row does Divide(damage * row, 10) (battle_lib.c:7547); STAB is * 15 / 10 first (:2596).
  it.each<[string, Setup, number, number, number, number, number?]>([
    ['super effective twice: 40 → 80 → 160 (:7567–7573)', ROCK_GROUND, M.WATER_GUN, P, QUAD, SE],
    ['STAB, then super effective twice: 60 → 240', and(ROCK_GROUND, WATER_USER), M.WATER_GUN, P, STAB * 4, SE],
    ['super effective and not very effective cancel (:7569)', on(A, { types: [TYPE_WATER, TYPE_GROUND] }), M.WATER_GUN, P, BASE, 0],
    ['immune (:3601)', GHOST, M.TACKLE, P, 0, INEFF],
    ['Foresight stops at the 0xFE separator (:2613–2617)', and(GHOST, on(A, { statusVolatile: VOLATILE_CONDITION_FORESIGHT })), M.TACKLE, P, BASE, 0],
    ['so does a Scrappy attacker', and(GHOST, on(P, { ability: ABILITY_SCRAPPY })), M.TACKLE, P, BASE, 0],
    ['Levitate skips the chart after STAB (:2600–2603)', LEVITATE, M.EARTHQUAKE, A, STAB, MOVE_STATUS_LEVITATED],
    ['Mold Breaker ignores Levitate (:3112–3120)', and(LEVITATE, on(A, { ability: ABILITY_MOLD_BREAKER })), M.EARTHQUAKE, A, 120, SE],
    ['Gravity grounds Levitate (:3095–3098)', and(LEVITATE, set({ fieldConditionsMask: FIELD_CONDITION_GRAVITY_INIT })), M.EARTHQUAKE, A, 120, SE],
    ['Wonder Guard blocks a neutral hit (:2649–2654)', WONDER_GUARD, M.TACKLE, P, BASE, MOVE_STATUS_WONDER_GUARD],
    ['Wonder Guard lets a super-effective hit through', WONDER_GUARD, M.ICE_FANG, P, QUAD, SE],
    // FLINCH_BURN_HIT is on MoveIsOnDamagingTurn's charge-move list, which reads LAST_OF_MULTI_TURN (:7600, a C bug).
    ['Fire Fang passes Wonder Guard', WONDER_GUARD, M.FIRE_FANG, P, 20, NVE],
    ['unless LAST_OF_MULTI_TURN is set', WONDER_GUARD, M.FIRE_FANG, P, 20, NVE | MOVE_STATUS_WONDER_GUARD, SYSCTL_LAST_OF_MULTI_TURN],
    ['IGNORE_TYPE_CHECKS: no STAB, no scaling, flags cleared (:2592, 7544, 2674)', and(ROCK_GROUND, WATER_USER), M.WATER_GUN, P, BASE, 0, SYSCTL_IGNORE_TYPE_CHECKS],
    ["IGNORE_TYPE_CHECKS from the view's mask", and(ROCK_GROUND, set({ battleStatusMask: SYSCTL_IGNORE_TYPE_CHECKS })), M.WATER_GUN, P, BASE, 0],
    ['IGNORE_TYPE_CHECKS still sets INEFFECTIVE (:7551–7555)', GHOST, M.TACKLE, P, BASE, INEFF, SYSCTL_IGNORE_TYPE_CHECKS],
    ['Flying is immune to Ground', FLYING, M.EARTHQUAKE, A, 0, INEFF],
    ['Roost drops the Flying row (:2540–2543)', and(FLYING, (v) => void (v.turnFlags[P] = { roosting: true, helpingHand: false })), M.EARTHQUAKE, A, STAB, 0],
    ['so does an Iron Ball (:2534–2538)', and(FLYING, on(P, { heldItem: ITEM_IRON_BALL })), M.EARTHQUAKE, A, STAB, 0],
    ['Magnet Rise skips the chart (:2604–2608)', MAGNET_RISE, M.EARTHQUAKE, A, STAB, MOVE_STATUS_MAGNET_RISE],
    ['Ingrain cancels Magnet Rise (:2605)', and(MAGNET_RISE, on(P, { moveEffectsMask: MOVE_EFFECT_INGRAIN })), M.EARTHQUAKE, A, 120, SE],
    ['Dark is immune to Psychic', DARK, M.PSYWAVE, P, 0, INEFF],
    ['Miracle Eye drops the Dark immunity (:2551–2555)', and(DARK, on(A, { moveEffectsMask: MOVE_EFFECT_MIRACLE_EYE })), M.PSYWAVE, P, BASE, 0],
    ['Filter cuts super effective: Divide(160 * 3, 4) (:2658–2661)', on(A, { ability: ABILITY_FILTER }), M.ICE_FANG, P, 120, SE],
    ['so does Solid Rock', on(A, { ability: ABILITY_SOLID_ROCK }), M.ICE_FANG, P, 120, SE],
    ['Tinted Lens doubles a resisted hit (:2668–2671)', on(P, { ability: ABILITY_TINTED_LENS }), M.FIRE_FANG, P, BASE, NVE],
    ['Multitype Arceus reads both types as its plate type (:7629–7634)', ARCEUS, M.WATER_GUN, P, TYPE_MULTI_DOUBLE_DAMAGE, SE],
  ])('%s', (_, setup, move, attacker, damage, flags, mask) => {
    const v = frozen(view(setup));
    expect(applyTypeChart(v, deps(), move, 0, attacker, attacker === P ? A : P, BASE, mask)).toEqual({ damage, flags });
  });

  it('monHasType reads a Multitype Arceus as its plate type, and anything else as its own', () => {
    const types = (v: AiView) => [TYPE_FIRE, TYPE_NORMAL].map((type) => monHasType(v, deps(), A, type));
    expect(types(view(ARCEUS))).toEqual([true, false]);
    expect(types(view(ARCEUS, on(A, { ability: ABILITY_RIVALRY })))).toEqual([false, true]);
  });
});

describe('calcEffectiveness', () => {
  const SAND_VEIL = FX.ability.SAND_VEIL;
  const EL = TYPE_ELECTRIC;
  it.each<[string, number, number, number, number, number, number, number, number?]>([
    ['super effective', M.WATER_GUN, ABILITY_RIVALRY, SAND_VEIL, 0, TYPE_ROCK, TYPE_GROUND, SE],
    ['immune', M.TACKLE, ABILITY_RIVALRY, ABILITY_NONE, 0, TYPE_GHOST, TYPE_GHOST, INEFF],
    ['Scrappy, with no Foresight check here (battle_lib.c:2708–2714)', M.TACKLE, ABILITY_SCRAPPY, ABILITY_NONE, 0, TYPE_GHOST, TYPE_GHOST, 0],
    ['Levitate (:2698–2703)', M.EARTHQUAKE, SAND_VEIL, ABILITY_LEVITATE, 0, EL, EL, INEFF],
    ['Levitate against Mold Breaker', M.EARTHQUAKE, ABILITY_MOLD_BREAKER, ABILITY_LEVITATE, 0, EL, EL, SE],
    ['Levitate with an Iron Ball', M.EARTHQUAKE, SAND_VEIL, ABILITY_LEVITATE, HOLD_EFFECT_SPEED_DOWN_GROUNDED, EL, EL, SE],
    ['Levitate under Gravity', M.EARTHQUAKE, SAND_VEIL, ABILITY_LEVITATE, 0, EL, EL, SE, FIELD_CONDITION_GRAVITY_INIT],
    ['Wonder Guard blocks neutral (:2734–2740)', M.TACKLE, ABILITY_RIVALRY, ABILITY_WONDER_GUARD, 0, TYPE_DRAGON, TYPE_GROUND, INEFF],
    ['Wonder Guard lets super effective through', M.ICE_FANG, ABILITY_RIVALRY, ABILITY_WONDER_GUARD, 0, TYPE_DRAGON, TYPE_GROUND, SE],
  ])('%s', (_, move, attackerAbility, defenderAbility, itemEffect, type1, type2, expected, field = 0) => {
    const v = fixtureView({ fieldConditionsMask: field });
    expect(calcEffectiveness(v, deps(), move, 0, attackerAbility, defenderAbility, itemEffect, type1, type2)).toBe(expected);
  });
});

it('typeMatchupMultiplier returns the C values, counting the rows after the 0xFE separator (battle_lib.c:3009–3029)', () => {
  const d = deps();
  const matchups = [[TYPE_WATER, TYPE_FIRE, TYPE_FIRE], [TYPE_NORMAL, TYPE_WATER, TYPE_WATER], [TYPE_WATER, TYPE_GRASS, TYPE_GRASS],
    [TYPE_NORMAL, TYPE_GHOST, TYPE_GHOST], [TYPE_WATER, TYPE_ROCK, TYPE_GROUND]] as const;
  expect(matchups.map(([move, t1, t2]) => typeMatchupMultiplier(d, move, t1, t2))).toEqual([
    TYPE_MULTI_DOUBLE_DAMAGE, BASE, TYPE_MULTI_HALF_DAMAGE, TYPE_MULTI_IMMUNE, QUAD,
  ]);
});

describe('ability and held item', () => {
  it('Gastro Acid suppresses every ability but Multitype', () => {
    const suppressed = on(P, { moveEffectsMask: MOVE_EFFECT_ABILITY_SUPPRESSED });
    expect([view(), view(suppressed), view(suppressed, on(P, { ability: ABILITY_MULTITYPE }))].map((v) => battlerAbility(v, P)))
      .toEqual([ABILITY_RIVALRY, ABILITY_NONE, ABILITY_MULTITYPE]);
  });

  it('Klutz and Embargo hide the item from different readers (battle_lib.c:5354, 5358, 5457–5458, 5491–5497)', () => {
    const d = deps();
    const { holdEffect, holdParam, flingPower } = d.items[FX.item.SITRUS_BERRY]!;
    const noGift = d.items[0]!.naturalGiftType;
    // [holdEffect, power ALL, power EMBARGO, power NONE, fling power, Natural Gift type]
    const reads = (v: AiView) => [
      heldItemEffect(v, d, P), ...[ITEM_POWER_CHECK_ALL, ITEM_POWER_CHECK_EMBARGO, ITEM_POWER_CHECK_NONE].map((mode) => heldItemPower(v, d, P, mode)),
      itemFlingPower(v, d, P), naturalGiftType(v, d, P),
    ];
    expect(reads(view())).toEqual([holdEffect, holdParam, holdParam, holdParam, flingPower, TYPE_PSYCHIC]);
    expect(reads(view(on(P, { ability: ABILITY_KLUTZ })))).toEqual([0, 0, holdParam, holdParam, flingPower, noGift]);
    expect(reads(view(effects(P, { embargoTurns: 3 })))).toEqual([0, 0, 0, holdParam, 0, noGift]);
  });

  it('an item without a record is a bad view', () => {
    expect(() => heldItemEffect(view(on(A, { heldItem: ITEM_CHOICE_BAND })), fixtureDeps(), A)).toThrow(code('BAD_VIEW'));
  });
});

describe('variable-type moves', () => {
  // Bits HP 0, Atk 1, Def 2, Spe 3, SpA 4, SpD 5; type = bits * 15 / 63 + 1, skipping Mystery (trainer_ai.c:3208–3220).
  it.each([
    ['even Attack: 61 → 15 → Dragon', { atk: 30 }, TYPE_DRAGON],
    ['even Speed: 55 → 14 → Ice', { spe: 30 }, TYPE_ICE],
    ['even Sp. Atk: 47 → 12 → Electric', { spa: 30 }, TYPE_ELECTRIC],
  ])('Hidden Power, %s', (_, odd, type) => {
    const ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31, ...odd };
    const v = view(on(A, { ivs }));
    expect([aiMoveType(v, deps(), A, M.HIDDEN_POWER), partyMoveType(v, deps(), { ...v.parties[1][0]!, ivs }, M.HIDDEN_POWER)])
      .toEqual([type, type]);
  });

  it('Natural Gift, Judgment and other moves', () => {
    const d = deps();
    const v = fixtureView();
    expect(aiMoveType(v, d, P, MOVE_NATURAL_GIFT)).toBe(TYPE_PSYCHIC);
    v.mons[P].heldItem = ITEM_FLAME_PLATE;
    expect(aiMoveType(v, d, P, MOVE_JUDGMENT)).toBe(TYPE_FIRE);
    // Under Embargo the battler's plate reads as none; a party Pokémon's item is read as it is (battle_lib.c:8107).
    v.mons[P].effects.embargoTurns = 2;
    expect(aiMoveType(v, d, P, MOVE_JUDGMENT)).toBe(TYPE_NORMAL);
    expect(partyMoveType(v, d, { ...v.parties[0][0]!, heldItem: ITEM_FLAME_PLATE }, MOVE_JUDGMENT)).toBe(TYPE_FIRE);
    // Every other move is Normal (trainer_ai.c:3242–3244, battle_lib.c:8198–8200).
    expect([aiMoveType(v, d, P, M.WATER_GUN), partyMoveType(v, d, v.parties[0][0]!, M.WATER_GUN)]).toEqual([TYPE_NORMAL, TYPE_NORMAL]);
  });

  // With no usable weather the type is never assigned (trainer_ai.c:3222–3240): the cartridge returns the caller's r5.
  const weather = (mask: number, ...setups: Setup[]) => view(set({ fieldConditionsMask: mask }), ...setups);
  it.each<[string, AiView, number | null]>([
    ['rain', weather(FIELD_CONDITION_RAINING_TEMP), TYPE_WATER],
    ['sun', weather(FIELD_CONDITION_SUNNY_TEMP), TYPE_FIRE],
    ['rain with a fainted Cloud Nine holder (common.h:63)', weather(FIELD_CONDITION_RAINING_TEMP, on(P, { ability: ABILITY_CLOUD_NINE, curHP: 0 })), TYPE_WATER],
    ['no weather', weather(0), null],
    ['rain under Cloud Nine', weather(FIELD_CONDITION_RAINING_TEMP, on(P, { ability: ABILITY_CLOUD_NINE })), null],
    ['sun under Air Lock', weather(FIELD_CONDITION_SUNNY_TEMP, on(A, { ability: ABILITY_AIR_LOCK })), null],
    ['deep fog', weather(FIELD_CONDITION_DEEP_FOG), null],
  ])('Weather Ball in %s', (_, v, type) => {
    const mon = v.parties[1][0]!;
    if (type === null) {
      const undefinedType = expect.objectContaining({ code: 'UNDEFINED', message: expect.stringContaining('Weather Ball') });
      expect(() => aiMoveType(v, deps(), A, M.WEATHER_BALL)).toThrow(undefinedType);
      expect(() => partyMoveType(v, deps(), mon, M.WEATHER_BALL)).toThrow(undefinedType);
    } else {
      expect([aiMoveType(v, deps(), A, M.WEATHER_BALL), partyMoveType(v, deps(), mon, M.WEATHER_BALL)]).toEqual([type, type]);
    }
  });
});

describe('counts, partner and weather', () => {
  it('countAbility loops over the two singles battlers (battle_main.c:1326–1333)', () => {
    const v = fixtureView();
    const counts = () => [
      countAbility(v, COUNT_ALL_BATTLERS, 0, ABILITY_RIVALRY), countAbility(v, COUNT_ALL_BATTLERS_OUR_SIDE, A, ABILITY_RIVALRY),
      countAbility(v, COUNT_ALL_BATTLERS_THEIR_SIDE, A, ABILITY_RIVALRY),
      countAbility(v, COUNT_ALL_BATTLERS_EXCEPT_ME_RETURN_BATTLER, A, ABILITY_RIVALRY),
      countAbility(v, COUNT_ALIVE_BATTLERS_THEIR_SIDE_FLAG, A, ABILITY_RIVALRY), countAbility(v, COUNT_ALL_BATTLERS, 0, ABILITY_NONE),
    ];
    // The empty slots 2 and 3 are never counted, so no battler has ABILITY_NONE.
    expect(counts()).toEqual([1, 0, 1, P + 1, 1 << P, 0]);
    v.mons[P].curHP = 0;
    expect(counts()).toEqual([1, 0, 1, P + 1, 0, 0]);
  });

  it('countMoves stops at the first empty slot', () => {
    expect([view(), view(on(A, { moves: [M.DRAGON_CLAW, 0, M.CRUNCH, M.FIRE_FANG] }))].map((v) => countMoves(v, A))).toEqual([4, 1]);
  });

  it('partner is the battler itself in singles', () => {
    expect([partner(fixtureView(), P), partner(fixtureView(), A)]).toEqual([P, A]);
    expect(() => partner(fixtureView({ battleType: BATTLE_TYPE_TRAINER_DOUBLES }), A)).toThrow(code('UNSUPPORTED'));
  });

  it('weatherIs tests the mask with no Cloud Nine check (common.h:68–72); noCloudNine counts the living', () => {
    const v = fixtureView({ fieldConditionsMask: FIELD_CONDITION_RAINING_TEMP | FIELD_CONDITION_SANDSTORM_PERM });
    expect((['rain', 'sun', 'sand', 'hail', 'fog'] as const).map((k) => weatherIs(v, k))).toEqual([true, false, true, false, false]);
    expect(noCloudNine(v)).toBe(true);
    v.mons[P].ability = ABILITY_CLOUD_NINE;
    expect([weatherIs(v, 'rain'), noCloudNine(v)]).toEqual([true, false]);
  });
});

// Garchomp's slots: 0 Dragon Claw, 1 Earthquake, 2 Crunch, 3 Fire Fang.
const FLY_ROOST = on(A, { moves: [MOVE_FLY, M.EARTHQUAKE, MOVE_ROOST, M.FIRE_FANG] });
const TAUNTED = effects(A, { tauntedTurns: 2 });
const CHOICE_BAND = on(A, { heldItem: ITEM_CHOICE_BAND });
it.each<[string, Setup, number]>([
  ['a plain slot is valid', () => {}, 0],
  ['no PP', on(A, { ppCur: [15, 0, 15, 15] }), 0b0010],
  ['Disabled', effects(A, { disabledMove: M.CRUNCH, disabledTurns: 3 }), 0b0100],
  ['Taunt flags the status moves', and(on(A, { moves: [M.DRAGON_CLAW, M.DRAGON_DANCE, M.CRUNCH, M.PROTECT] }), TAUNTED), 0b1010],
  ['Taunt with empty slots looks up no move 0', and(on(A, { moves: [M.DRAGON_DANCE, 0, 0, 0], ppCur: [20, 0, 0, 0] }), TAUNTED), 0b1111],
  ['Choice lock flags every other slot', and(CHOICE_BAND, effects(A, { choiceLockedMove: M.EARTHQUAKE })), 0b1101],
  // battle_lib.c:2309–2310 clears the lock; the port clears a local copy, never the (frozen) view.
  ['Choice lock on a move the battler lacks flags nothing', and(CHOICE_BAND, effects(A, { choiceLockedMove: M.WATER_GUN })), 0],
  ['Encore flags every other slot', effects(A, { encoredMove: M.CRUNCH, encoredTurns: 3 }), 0b1011],
  ['Torment flags the last move',
    and(on(A, { statusVolatile: VOLATILE_CONDITION_TORMENT }), set({ movePrevByBattler: [0, M.DRAGON_CLAW, 0, 0] })), 0b0001],
  ['Imprison flags the moves the other side knows (Luxray knows Crunch)', on(P, { moveEffectsMask: MOVE_EFFECT_IMPRISON }), 0b0100],
  ['Gravity flags Fly', and(FLY_ROOST, set({ fieldConditionsMask: FIELD_CONDITION_GRAVITY_INIT })), 0b0001],
  ['Heal Block flags Roost', and(FLY_ROOST, effects(A, { healBlockTurns: 5 })), 0b0100],
  ['empty slots are invalid', on(A, { moves: [M.DRAGON_CLAW, M.EARTHQUAKE, 0, 0], ppCur: [15, 10, 0, 0] }), 0b1100],
])('invalidMoves: %s', (_, setup, mask) => {
  expect(invalidMoves(frozen(view(setup)), deps(), A)).toBe(mask);
});
